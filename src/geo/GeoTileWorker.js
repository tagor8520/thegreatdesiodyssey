import { buildBuildingGeometry, buildRoadGeometry, decodeVectorTile } from './GeoTileBuilder.js';
import { resolveMapSchema } from './GeoMapSemantics.js';
import { acquireTileCache } from './GeoTileCache.js';
import { buildContextData } from './GeoTileContext.js';
import { waterDomainTransferables } from './GeoWaterDomains.js';
import {
  DEFAULT_MAP_PROVIDERS,
  TileCacheFetcher,
  createTileRetainer,
  mapTileUrl,
} from './GeoTileCacheFetch.js';

const controllers = new Map();
const cancelled = new Set();
const retainer = createTileRetainer();

/**
 * Cache-first fetch. Providers are tried in order and the persistent cache is
 * consulted before the network, so a revisited tile costs no request; the
 * decode validation lives in the fetcher, so an HTML error body with HTTP 200
 * can never reach storage or the tile builder.
 */
async function fetchTile(request, signal) {
  const providers = request.providers?.length ? request.providers : DEFAULT_MAP_PROVIDERS;
  const fetcher = new TileCacheFetcher({
    providers,
    profile: request.profile ?? 'low',
    decode: decodeVectorTile,
  });
  return fetcher.load(request, signal, async (provider, loadRequest, abortSignal) => {
    const url = mapTileUrl(provider.url, loadRequest);
    const response = await fetch(url, {
      signal: abortSignal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'force-cache',
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.arrayBuffer();
    if (!data.byteLength) throw new Error('empty tile');
    // Provider cache semantics travel with the payload so MAP-09 can bound the
    // stored lifetime instead of keeping a stale tile forever.
    return { data, url, cacheControl: response.headers?.get?.('cache-control') ?? '' };
  });
}

function tileCacheDiagnostics(request) {
  if (request?.tileCache === false) return null;
  try {
    return acquireTileCache({
      profile: request?.profile ?? 'low',
      providers: request?.providers?.length ? request.providers : DEFAULT_MAP_PROVIDERS,
    }).diagnostics;
  } catch {
    return null;
  }
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
  if (geometry.landmarkPositions instanceof Float32Array) transfers.push(
    geometry.landmarkPositions.buffer,
    geometry.landmarkNormals.buffer,
    geometry.landmarkColors.buffer,
    geometry.landmarkIndices.buffer,
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
    const fetched = await fetchTile(request, controller.signal);
    const fetchMilliseconds = performance.now() - requestStarted;
    if (cancelled.has(request.requestId)) return;

    // `MAP-08`: the serving provider decides which class/level vocabulary the
    // payload uses, so every phase below reads one explicit schema instead of
    // guessing from whichever layer names happen to exist.
    const phaseRequest = Object.freeze({
      ...request,
      schema: resolveMapSchema(fetched.provider?.schema ?? fetched.providerId, request.schema),
      providerId: fetched.providerId,
    });

    // Roads are intentionally produced and transferred before any building work.
    const roadsStarted = performance.now();
    const roads = buildRoadGeometry(fetched.vectorTile, phaseRequest);
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
      servedFromCache: fetched.servedFromCache,
      tileCache: tileCacheDiagnostics(request),
      timings: { fetchMilliseconds, roadsMilliseconds },
    }, geometryTransfers(roads));

    // Let cancellation/new requests run before map-derived ambience and the
    // more expensive extrusion pass. The context phase deliberately sits after
    // roads so navigation becomes useful first on slow devices.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (cancelled.has(request.requestId)) return;

    const contextStarted = performance.now();
    const context = buildContextData(fetched.vectorTile, phaseRequest);
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
      context.bridges.placements.buffer,
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
    const buildings = buildBuildingGeometry(fetched.vectorTile, phaseRequest);
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

/**
 * Pin the resident tiles in every provider key space. Pinning is what keeps a
 * cache trim from evicting the tiles the player is currently standing in; the
 * set is bounded by the world's four-tile resident cap.
 */
function retainTileCacheEntries(descriptors, providers, profile = 'low') {
  return retainer.retain(descriptors, providers?.length ? providers : DEFAULT_MAP_PROVIDERS, profile);
}

self.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'load') void buildTile(message.request);
  if (message?.type === 'retain') {
    retainTileCacheEntries(message.descriptors, message.providers, message.profile);
  }
  if (message?.type === 'cancel') {
    cancelled.add(message.requestId);
    controllers.get(message.requestId)?.abort();
  }
});
