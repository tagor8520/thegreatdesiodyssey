import { decodeVectorTile, buildRoadGeometry, buildBuildingGeometry } from './GeoTileBuilder.js';
import { buildContextData } from './GeoTileContext.js';
import { waterDomainTransferables } from './GeoWaterDomains.js';
import {
  GeoTileCache,
  createDefaultTileStorage,
  createNullTileStorage,
  providerCachePolicy,
  providerFingerprint,
} from './GeoTileCache.js';

const controllers = new Map();
const cancelled = new Set();

/**
 * `MAP-09`: the persistent cache lives here because this is the only place the
 * runtime makes a provider request.
 *
 * It is created once per worker and configured per session: with no explicit byte
 * budget it takes the profile's, and with `tileCacheBytes: 0` it is given a null
 * storage adapter, which is how the gate and a reader can ask for the pre-`MAP-09`
 * behaviour — every tile fetched — without a second code path.
 */
let cache = null;
let cacheSignature = null;

function ensureCache(request) {
  const configured = request?.tileCache ?? null;
  const bytes = Number.isFinite(configured?.bytes) ? configured.bytes : null;
  const wanted = configured?.enabled === false ? 'off' : `${bytes ?? 'default'}`;
  if (cache && cache.signature === wanted) return cache;
  cache = new GeoTileCache({
    storage: configured?.enabled === false ? createNullTileStorage('the tile cache was switched off for this session') : createDefaultTileStorage(),
    bytes,
  });
  cache.signature = wanted;
  cacheSignature = null;
  const opened = cache.open();
  cache.openedPromise = opened;
  return cache;
}

/** Forget entries from a source the application no longer declares (`MAP-09`, attribution-safe storage). */
async function sweepRetiredSources(request) {
  const providers = request.providers?.length ? request.providers : DEFAULT_PROVIDERS;
  let signature;
  try {
    signature = providers.map(provider => providerFingerprint(provider)).join(',');
  } catch {
    return;
  }
  if (signature === cacheSignature) return;
  cacheSignature = signature;
  const fingerprints = signature.split(',');
  const result = await cache.sweep({ fingerprints });
  if (result.swept) self.postMessage({ type: 'tile-cache', cache: cache.diagnostics(), swept: result.swept });
}

const DEFAULT_PROVIDERS = Object.freeze([
  {
    id: 'openfreemap',
    label: 'OpenFreeMap / OpenMapTiles',
    url: 'https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf',
  },
  {
    id: 'openstreetmap',
    label: 'OpenStreetMap Shortbread',
    url: 'https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt',
  },
]);

function tileUrl(template, request) {
  return template
    .replace('{z}', String(request.zoom))
    .replace('{x}', String(request.urlX))
    .replace('{y}', String(request.urlY));
}

/**
 * One tile, from the cache if it is there and from the network if it is not.
 *
 * The provider order is preserved exactly: the cache is consulted *per provider*,
 * before that provider's fetch, so a hit under the third source never preempts a
 * successful fetch under the first. What the cache changes is only whether a
 * request is made at all.
 *
 * A stored payload is decoded inside a guard: a record that no longer decodes —
 * truncated by a crash, edited by hand, written by a build that mis-encoded it —
 * is deleted and the tile is fetched instead. An optimization may never be the
 * reason a tile fails to load.
 */
async function fetchTile(request, signal) {
  const providers = request.providers?.length ? request.providers : DEFAULT_PROVIDERS;
  const failures = [];
  const tile = { zoom: request.zoom, x: request.urlX, y: request.urlY };
  for (const provider of providers) {
    const policy = providerCachePolicy(provider);
    if (policy.cacheable) {
      const lookup = await cache.get(provider, tile);
      if (lookup.state === 'hit') {
        try {
          const vectorTile = decodeVectorTile(lookup.data);
          return {
            data: lookup.data, vectorTile,
            provider: lookup.label || provider.label || provider.id,
            providerId: lookup.providerId || provider.id,
            url: tileUrl(provider.url, request),
            cached: true, fingerprint: lookup.fingerprint,
            ageSeconds: lookup.ageSeconds, storedAt: lookup.storedAt,
          };
        } catch (error) {
          // A record that does not decode is removed, not returned: the tile is
          // fetched from the network instead, and the refusal is counted.
          await cache.reject(lookup.key, `a cached tile did not decode (${error.message}) and was removed`);
        }
      }
    }
    const url = tileUrl(provider.url, request);
    try {
      const response = await fetch(url, {
        signal,
        mode: 'cors',
        credentials: 'omit',
        cache: 'force-cache',
        referrerPolicy: 'strict-origin-when-cross-origin',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      if (!data.byteLength) throw new Error('empty tile');
      // Validate the payload here so an HTML/error body with HTTP 200 can fall
      // through to the next provider. The selected MVT is decoded only once.
      const vectorTile = decodeVectorTile(data);
      const stored = policy.cacheable
        ? await cache.store(provider, tile, data, {
          contentType: response.headers?.get?.('content-type') ?? '',
          etag: response.headers?.get?.('etag') ?? '',
        })
        : { stored: false, reason: policy.reason, skipped: true };
      return {
        data, vectorTile,
        provider: provider.label ?? provider.id, providerId: provider.id, url,
        cached: false, cacheStored: Boolean(stored.stored), cacheReason: stored.reason ?? '',
      };
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${provider.label ?? provider.id}: ${error.message}`);
    }
  }
  throw new Error(`No public map source responded (${failures.join('; ')})`);
}

function geometryTransfers(geometry, includeColliders = false) {
  const transfers = [
    geometry.positions.buffer,
    geometry.normals.buffer,
    geometry.colors.buffer,
    geometry.indices.buffer,
  ];
  if (geometry.supportSegments instanceof Float32Array) transfers.push(geometry.supportSegments.buffer);
  if (geometry.detailPositions instanceof Float32Array) transfers.push(
    geometry.detailPositions.buffer,
    geometry.detailNormals.buffer,
    geometry.detailColors.buffer,
    geometry.detailIndices.buffer,
  );
  if (includeColliders) transfers.push(
    geometry.colliders.buffer,
    geometry.collisionVertices.buffer,
    geometry.collisionRingOffsets.buffer,
    geometry.collisionPolygonOffsets.buffer,
    geometry.collisionSpans.buffer,
    geometry.collisionMasks.buffer,
    geometry.supportSlots.buffer,
    geometry.supportSlotStates.buffer,
  );
  return transfers;
}

async function buildTile(request) {
  const controller = new AbortController();
  const requestStarted = performance.now();
  controllers.set(request.requestId, controller);
  try {
    ensureCache(request);
    await cache.openedPromise;
    await sweepRetiredSources(request);
    const fetched = await fetchTile(request, controller.signal);
    const fetchMilliseconds = performance.now() - requestStarted;
    if (cancelled.has(request.requestId)) return;

    // Roads are intentionally produced and transferred before any building work.
    const roadsStarted = performance.now();
    const roads = buildRoadGeometry(fetched.vectorTile, request);
    const roadsMilliseconds = performance.now() - roadsStarted;
    self.postMessage({
      type: 'tile-phase',
      requestId: request.requestId,
      key: request.key,
      phase: 'roads',
      geometry: roads,
      bytes: fetched.data.byteLength,
      provider: fetched.provider,
      providerId: fetched.providerId,
      cached: fetched.cached === true,
      cacheAgeSeconds: fetched.ageSeconds ?? null,
      timings: { fetchMilliseconds, roadsMilliseconds },
    }, geometryTransfers(roads));

    // Let cancellation/new requests run before map-derived ambience and the
    // more expensive extrusion pass. The context phase deliberately sits after
    // roads so navigation becomes useful first on slow devices.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (cancelled.has(request.requestId)) return;

    const contextStarted = performance.now();
    const context = buildContextData(fetched.vectorTile, request);
    const contextMilliseconds = performance.now() - contextStarted;
    self.postMessage({
      type: 'tile-phase',
      requestId: request.requestId,
      key: request.key,
      phase: 'context',
      context,
      bytes: fetched.data.byteLength,
      provider: fetched.provider,
      providerId: fetched.providerId,
      timings: { fetchMilliseconds, roadsMilliseconds, contextMilliseconds },
    }, [
      ...geometryTransfers(context.land),
      ...geometryTransfers(context.water),
      ...waterDomainTransferables(context.waterDomain),
      context.streetFurniture.placements.buffer,
      context.decorations.buffer,
      context.decorationClearances.buffer,
      context.decorationMorphologies.buffer,
      context.environment.fields.buffer,
      context.environment.topBiomeIds.buffer,
      context.environment.topBiomeWeights.buffer,
      context.environment.ground.buffer,
    ]);

    await new Promise(resolve => setTimeout(resolve, 0));
    if (cancelled.has(request.requestId)) return;

    const buildingsStarted = performance.now();
    const buildings = buildBuildingGeometry(fetched.vectorTile, request);
    const buildingsMilliseconds = performance.now() - buildingsStarted;
    self.postMessage({
      type: 'tile-phase',
      requestId: request.requestId,
      key: request.key,
      phase: 'buildings',
      geometry: buildings,
      bytes: fetched.data.byteLength,
      provider: fetched.provider,
      providerId: fetched.providerId,
      cached: fetched.cached === true,
      cacheAgeSeconds: fetched.ageSeconds ?? null,
      cacheStored: fetched.cacheStored === true,
      cacheReason: fetched.cacheReason ?? '',
      cache: cache.diagnostics(),
      timings: {
        fetchMilliseconds,
        roadsMilliseconds,
        contextMilliseconds,
        buildingsMilliseconds,
        totalMilliseconds: performance.now() - requestStarted,
      },
      complete: true,
    }, geometryTransfers(buildings, true));
  } catch (error) {
    if (!controller.signal.aborted && !cancelled.has(request.requestId)) {
      self.postMessage({
        type: 'tile-error',
        requestId: request.requestId,
        key: request.key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    controllers.delete(request.requestId);
    cancelled.delete(request.requestId);
  }
}

self.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'load') void buildTile(message.request);
  if (message?.type === 'stats') {
    void (async () => {
      ensureCache(message.request ?? null);
      await cache.openedPromise;
      self.postMessage({ type: 'tile-cache', cache: cache.diagnostics(), requestId: message.requestId ?? null });
    })();
  }
  if (message?.type === 'clear') {
    void (async () => {
      ensureCache(message.request ?? null);
      await cache.openedPromise;
      await cache.clear();
      cacheSignature = null;
      self.postMessage({ type: 'tile-cache', cache: cache.diagnostics(), cleared: true, requestId: message.requestId ?? null });
    })();
  }
  if (message?.type === 'cancel') {
    cancelled.add(message.requestId);
    controllers.get(message.requestId)?.abort();
  }
});
