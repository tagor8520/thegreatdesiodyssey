import { decodeVectorTile, buildRoadGeometry, buildBuildingGeometry } from './GeoTileBuilder.js';
import { buildContextData } from './GeoTileContext.js';
import { waterDomainTransferables } from './GeoWaterDomains.js';

const controllers = new Map();
const cancelled = new Set();

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

async function fetchTile(request, signal) {
  const providers = request.providers?.length ? request.providers : DEFAULT_PROVIDERS;
  const failures = [];
  for (const provider of providers) {
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
      return { data, vectorTile, provider: provider.label ?? provider.id, providerId: provider.id, url };
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
  if (message?.type === 'cancel') {
    cancelled.add(message.requestId);
    controllers.get(message.requestId)?.abort();
  }
});
