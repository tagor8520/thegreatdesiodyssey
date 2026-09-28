import { GEO_QUERY_MASK } from './GeoCollision.js';
import { GEO_SUPPORT_SLOT_FIELD, GEO_SUPPORT_SLOT_STRIDE } from './GeoSupportSlots.js';
import { describeDomain, describeDomainCompliance } from '../engine/DomainInterface.js';
import { GEO_MAP_ROLE, GEO_ROAD_CLASS, mapLayersForRole } from './GeoMapSemantics.js';

export const GEO_DEBUG_LIMITS = Object.freeze({
  maxLineSegments: 6_000,
  refreshMilliseconds: 250,
});

const MASK_ROLES = Object.freeze([
  ['player', GEO_QUERY_MASK.SOLID_PLAYER],
  ['support', GEO_QUERY_MASK.SUPPORT],
  ['camera', GEO_QUERY_MASK.CAMERA_BLOCKER],
  ['fade', GEO_QUERY_MASK.FADE_ELIGIBLE],
  ['los', GEO_QUERY_MASK.LOS_BLOCKER],
  ['interaction', GEO_QUERY_MASK.INTERACTION],
  ['placement', GEO_QUERY_MASK.PLACEMENT],
]);

const COLORS = Object.freeze({
  player: Object.freeze([1, .18, .12]),
  support: Object.freeze([.20, 1, .36]),
  camera: Object.freeze([1, .20, .92]),
  los: Object.freeze([1, .68, .12]),
  placement: Object.freeze([1, .92, .16]),
  other: Object.freeze([.75, .75, .78]),
  groundRoad: Object.freeze([.72, .78, .84]),
  bridge: Object.freeze([.12, .88, 1]),
  tunnel: Object.freeze([.18, .38, 1]),
  occupied: Object.freeze([1, .16, .12]),
  normal: Object.freeze([.42, 1, .16]),
});

function typedBytes(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView) ? value.byteLength : 0;
}

function geometryBytes(geometry, seenBuffers) {
  if (!geometry) return 0;
  let bytes = 0;
  const include = array => {
    const buffer = array?.buffer;
    if (!buffer || seenBuffers.has(buffer)) return;
    seenBuffers.add(buffer);
    bytes += array.byteLength;
  };
  for (const attribute of Object.values(geometry.attributes ?? {})) include(attribute?.array);
  include(geometry.index?.array);
  return bytes;
}

export function collectGeoRuntimeBudgetMetrics(renderer, world, { view = 'street' } = {}) {
  const seenBuffers = new Set();
  let estimatedGpuBytes = 0, collisionBytesPerTile = 0, waterDomainBytesPerTile = 0;
  let buildingDetailBuildings = 0, buildingDetailBoxes = 0, buildingDetailTriangles = 0;
  let buildingDetailBytesPerTile = 0, buildingDetailAddedDrawCalls = 0, buildingDetailRoadTestsPerTile = 0;
  let streetFurnitureBytesPerTile = 0, streetFurniturePlacementTests = 0;
  let bridgeBytesPerTile = 0, bridgeSpansPerTile = 0, bridgePiersPerTile = 0;
  let landmarkBytesPerTile = 0, landmarkBoxesPerTile = 0, landmarkOpeningTiles = 0;
  world?.root?.traverse?.(object => {
    estimatedGpuBytes += geometryBytes(object.geometry, seenBuffers);
    if (object.instanceMatrix?.array) {
      const buffer = object.instanceMatrix.array.buffer;
      if (!seenBuffers.has(buffer)) { seenBuffers.add(buffer); estimatedGpuBytes += object.instanceMatrix.array.byteLength; }
    }
  });
  for (const geometry of world?.decorationGeometries ?? []) estimatedGpuBytes += geometryBytes(geometry, seenBuffers);
  for (const tile of world?.tiles?.values?.() ?? []) {
    const bytes = ['colliders', 'collisionVertices', 'collisionRingOffsets', 'collisionPolygonOffsets',
      'collisionSpans', 'collisionMasks', 'supportSlots', 'supportSlotStates', 'roadSupportSegments']
      .reduce((total, field) => total + typedBytes(tile[field]), 0);
    collisionBytesPerTile = Math.max(collisionBytesPerTile, bytes);
    waterDomainBytesPerTile = Math.max(waterDomainBytesPerTile, tile.waterDomain?.meta?.bytes ?? 0);
    const furniture = tile.streetFurnitureMeta;
    streetFurnitureBytesPerTile = Math.max(streetFurnitureBytesPerTile, furniture?.bytes ?? 0);
    streetFurniturePlacementTests = Math.max(streetFurniturePlacementTests,
      (furniture?.roadTests ?? 0) + (furniture?.buildingTests ?? 0) +
      (furniture?.decorationTests ?? 0) + (furniture?.conflictTests ?? 0));
    const landmark = tile.landmarkGrammar;
    landmarkBytesPerTile = Math.max(landmarkBytesPerTile, landmark?.bytes ?? 0);
    landmarkBoxesPerTile = Math.max(landmarkBoxesPerTile, landmark?.boxes ?? 0);
    landmarkOpeningTiles += Number((landmark?.passableOpenings ?? 0) > 0);
    const bridge = tile.bridgeMeta;
    bridgeBytesPerTile = Math.max(bridgeBytesPerTile, bridge?.bytes ?? 0);
    bridgeSpansPerTile = Math.max(bridgeSpansPerTile, bridge?.spans ?? 0);
    bridgePiersPerTile = Math.max(bridgePiersPerTile, bridge?.piers ?? 0);
    const grammar = tile.buildingMeta?.buildingGrammar;
    buildingDetailBytesPerTile = Math.max(buildingDetailBytesPerTile, grammar?.bytes ?? 0);
    buildingDetailRoadTestsPerTile = Math.max(buildingDetailRoadTestsPerTile, grammar?.roadTests ?? 0);
    if (tile.buildingDetails?.visible) {
      buildingDetailBuildings += grammar?.selectedBuildings ?? 0;
      buildingDetailBoxes += grammar?.boxes ?? 0;
      buildingDetailTriangles += grammar?.triangles ?? 0;
      buildingDetailAddedDrawCalls += Number((grammar?.triangles ?? 0) > 0);
    }
  }
  const stats = world?.stats ?? {};
  const materialTextureBytes = world?.materialLibrary?.diagnostics?.estimatedBytes ?? 0;
  const plantDiagnostics = world?.plantArchetypes?.diagnostics;
  const plantGeometryDiagnostics = world?.plantGeometryArchetypes?.diagnostics;
  const plantLodDiagnostics = world?.plantLods?.diagnostics;
  const plantLodSelectorDiagnostics = world?.plantLodSelector?.diagnostics;
  const plantRenderDiagnostics = world?.plantRenderPools?.diagnostics;
  const streetFurnitureDiagnostics = world?.streetFurniturePools?.diagnostics;
  const ambientLifeDiagnostics = world?.ambientLifePools?.diagnostics;
  const bridgeDiagnostics = world?.bridgePools?.diagnostics;
  const landmarkDiagnostics = world?.landmarkPools?.diagnostics;
  const tileCache = world?.tileCacheDiagnostics ?? null;
  const dynamicProxyDiagnostics = world?.dynamicProxies?.diagnostics?.() ?? null;
  estimatedGpuBytes += materialTextureBytes;
  return Object.freeze({
    view,
    residentTiles: stats.resident ?? world?.tiles?.size ?? 0,
    activeRequests: stats.loading ?? world?.activeRequests ?? 0,
    drawCalls: renderer?.info?.render?.calls ?? 0,
    triangles: renderer?.info?.render?.triangles ?? 0,
    estimatedGpuBytes,
    materialTextureBytes,
    plantArchetypes: plantDiagnostics?.cachedArchetypes ?? 0,
    plantSkeletonNodes: plantDiagnostics?.maximumSkeletonNodes ?? 0,
    plantSkeletonModules: plantDiagnostics?.maximumSkeletonModules ?? 0,
    plantGeometryArchetypes: plantGeometryDiagnostics?.cachedArchetypes ?? 0,
    plantGeometryBoxes: plantGeometryDiagnostics?.maximumBoxes ?? 0,
    plantGeometryTriangles: plantGeometryDiagnostics?.maximumTriangles ?? 0,
    plantGeometryBytes: plantGeometryDiagnostics?.estimatedBytes ?? 0,
    plantLodSets: plantLodDiagnostics?.cachedSets ?? 0,
    plantLodGeometries: plantLodDiagnostics?.cachedGeometries ?? 0,
    plantLodBytes: plantLodDiagnostics?.estimatedBytes ?? 0,
    plantLodEntries: plantLodSelectorDiagnostics?.entries ?? 0,
    plantLodReevaluationsHz: plantLodSelectorDiagnostics?.limits?.maxReevaluationsHz ?? 0,
    plantCompileMilliseconds: Math.max(
      plantDiagnostics?.maximumCompileMilliseconds ?? 0,
      plantGeometryDiagnostics?.maximumCompileMilliseconds ?? 0,
      plantLodDiagnostics?.maximumCompileMilliseconds ?? 0,
    ),
    plantRenderEntries: plantRenderDiagnostics?.entries ?? 0,
    plantRenderPools: plantRenderDiagnostics?.activeDrawPools ?? 0,
    // `VEG-02`: silhouette cost after LOD and the LOD switching behaviour.
    plantBoxModules: plantRenderDiagnostics?.boxModules ?? 0,
    plantLodSwitches: world?.plantLodSelector?.diagnostics?.switches ?? 0,
    plantLodHysteresisHolds: world?.plantLodSelector?.diagnostics?.hysteresisHolds ?? 0,
    plantRenderSourceGeometries: plantRenderDiagnostics?.sourceGeometries ?? 0,
    plantRenderGpuBytes: plantRenderDiagnostics?.gpuGeometryBytes ?? 0,
    plantRenderVisibleTriangles: plantRenderDiagnostics?.visibleTriangles ?? 0,
    // `COL-09`: the capped moving-solid hash the collision queries merge.
    dynamicProxies: dynamicProxyDiagnostics?.activeProxies ?? 0,
    dynamicProxyCells: dynamicProxyDiagnostics?.cells ?? 0,
    dynamicProxyCapSkips: dynamicProxyDiagnostics?.capSkips ?? 0,
    dynamicProxyReinserts: dynamicProxyDiagnostics?.reinserts ?? 0,
    dynamicProxySteadyFrameAllocations: dynamicProxyDiagnostics?.steadyFrameAllocations ?? 0,
    plantRenderAddedDrawCalls: plantRenderDiagnostics?.addedDrawCalls ?? 0,
    plantWindUniformWritesPerFrame: plantRenderDiagnostics?.windUniformWrites ?? 0,
    plantWindCpuMatrixUpdatesPerFrame: plantRenderDiagnostics?.windCpuMatrixUpdates ?? 0,
    plantWindSteadyFrameAllocations: plantRenderDiagnostics?.windSteadyFrameAllocations ?? 0,
    buildingDetailBuildings,
    buildingDetailBoxes,
    buildingDetailTriangles,
    buildingDetailBytesPerTile,
    buildingDetailAddedDrawCalls,
    buildingDetailRoadTestsPerTile,
    streetFurnitureEntries: streetFurnitureDiagnostics?.entries ?? 0,
    streetFurnitureFamilies: streetFurnitureDiagnostics?.sourceGeometries ?? 0,
    streetFurnitureVisibleTriangles: streetFurnitureDiagnostics?.visibleTriangles ?? 0,
    streetFurnitureGpuBytes: streetFurnitureDiagnostics?.gpuBytes ?? 0,
    streetFurnitureAddedDrawCalls: streetFurnitureDiagnostics?.addedDrawCalls ?? 0,
    streetFurnitureBytesPerTile,
    streetFurniturePlacementTests,
    bridgeBytesPerTile,
    bridgeSpansPerTile,
    bridgePiersPerTile,
    bridgeEntries: bridgeDiagnostics?.entries ?? 0,
    bridgeFamilies: bridgeDiagnostics?.activeDrawPools ?? 0,
    bridgeVisibleTriangles: bridgeDiagnostics?.visibleTriangles ?? 0,
    bridgeAddedDrawCalls: bridgeDiagnostics?.addedDrawCalls ?? 0,
    bridgeCompounds: bridgeDiagnostics?.compounds ?? 0,
    bridgeStructuralCompounds: bridgeDiagnostics?.structuralCompounds ?? 0,
    bridgeGpuBytes: bridgeDiagnostics?.gpuBytes ?? 0,
    bridgeSteadyFrameMatrixUpdates: bridgeDiagnostics?.steadyFrameMatrixUpdates ?? 0,
    landmarkBoxesPerTile,
    landmarkBytesPerTile,
    landmarkOpeningTiles,
    landmarkHeroes: landmarkDiagnostics?.heroes ?? 0,
    landmarkBoxes: landmarkDiagnostics?.boxes ?? 0,
    landmarkVisibleTriangles: landmarkDiagnostics?.visibleTriangles ?? 0,
    landmarkAddedDrawCalls: landmarkDiagnostics?.addedDrawCalls ?? 0,
    landmarkOpenings: landmarkDiagnostics?.openings ?? 0,
    landmarkPassableOpenings: landmarkDiagnostics?.passableOpenings ?? 0,
    landmarkCompounds: landmarkDiagnostics?.compounds ?? 0,
    landmarkStructuralCompounds: landmarkDiagnostics?.structuralCompounds ?? 0,
    landmarkEnclosingCompounds: landmarkDiagnostics?.enclosingCompounds ?? 0,
    landmarkGpuBytes: landmarkDiagnostics?.gpuBytes ?? 0,
    landmarkSteadyFrameMatrixUpdates: landmarkDiagnostics?.steadyFrameMatrixUpdates ?? 0,
    // MAP-09 persistent tile cache: only the ceilings the active profile owns.
    tileCacheBytes: tileCache?.bytes ?? 0,
    tileCacheEntries: tileCache?.entries ?? 0,
    tileCacheHits: tileCache?.hits ?? 0,
    tileCacheMisses: tileCache?.misses ?? 0,
    tileCacheWrites: tileCache?.writes ?? 0,
    tileCacheEvictions: tileCache?.evictions ?? 0,
    tileCacheExpirations: tileCache?.expirations ?? 0,
    tileCacheAttributionRejections: tileCache?.attributionRejections ?? 0,
    tileCacheStorageErrors: tileCache?.storageErrors ?? 0,
    streetFurnitureSteadyFrameMatrixUpdates: streetFurnitureDiagnostics?.steadyFrameMatrixUpdates ?? 0,
    ambientLifeEntries: ambientLifeDiagnostics?.entries ?? 0,
    ambientLifeFamilies: ambientLifeDiagnostics?.activeDrawPools ?? 0,
    ambientLifeSpriteTriangles: ambientLifeDiagnostics?.spriteTriangles ?? 0,
    ambientLifeVisibleTriangles: ambientLifeDiagnostics?.visibleTriangles ?? 0,
    ambientLifeAddedDrawCalls: ambientLifeDiagnostics?.addedDrawCalls ?? 0,
    ambientLifeInstanceBytes: ambientLifeDiagnostics?.instanceBytes ?? 0,
    ambientLifeUniformWritesPerFrame: ambientLifeDiagnostics?.uniformWrites ?? 0,
    ambientLifeCpuMatrixUpdatesPerFrame: ambientLifeDiagnostics?.cpuMatrixUpdates ?? 0,
    ambientLifeSteadyFrameAllocations: ambientLifeDiagnostics?.steadyFrameAllocations ?? 0,
    waterDomainBytesPerTile,
    // `FND-07`: live owned resources at this moment, so a mount that keeps
    // accumulating listeners/geometries/workers fails the same budget surface.
    lifecycleOwnedResources: world.lifecycle?.snapshot?.().total ?? 0,
    collisionBytesPerTile,
    workerContextMilliseconds: world?.timings?.contextMilliseconds,
    mainThreadMountMilliseconds: world?.mountDiagnostics?.maximumMilliseconds,
    maxCollisionCandidates: world?.queryDiagnostics?.maxCandidates ?? 0,
    maxSupportCandidates: world?.queryDiagnostics?.maxSupportCandidates ?? 0,
    // `GME-04`: the measured label LOS rate and its steady-frame allocation claim.
    labelLosTestsPerSecond: world?.labelLosRate ?? world?.labelLosDiagnostics?.testsPerSecond ?? 0,
    labelLosCandidates: world?.labelLosDiagnostics?.lastBatch ?? 0,
    labelLosSteadyFrameAllocations: world?.labelLosSteadyFrameAllocations ?? 0,
  });
}

/** `MAP-08`: the adapter's declared vocabulary, frozen once for every snapshot. */
const GEO_MAP_SEMANTICS_VOCABULARY = Object.freeze({
  roles: Object.freeze(Object.values(GEO_MAP_ROLE).filter(role => mapLayersForRole(role).length)),
  roadClasses: Object.freeze(Object.values(GEO_ROAD_CLASS)),
});

export function describeGeoQueryMask(mask) {
  const value = Number.isFinite(mask) ? Math.round(mask) : 0;
  const roles = MASK_ROLES.filter(([, bit]) => (value & bit) !== 0).map(([name]) => name);
  return roles.length ? roles.join('+') : 'none';
}

function maskColor(mask) {
  if (mask & GEO_QUERY_MASK.SOLID_PLAYER) return COLORS.player;
  if (mask & GEO_QUERY_MASK.CAMERA_BLOCKER) return COLORS.camera;
  if (mask & GEO_QUERY_MASK.SUPPORT) return COLORS.support;
  if (mask & GEO_QUERY_MASK.LOS_BLOCKER) return COLORS.los;
  if (mask & GEO_QUERY_MASK.PLACEMENT) return COLORS.placement;
  return COLORS.other;
}

function rotatedRectangle(x, z, halfWidth, halfDepth, yaw) {
  const cosine = Math.cos(yaw), sine = Math.sin(yaw);
  return [[-halfWidth,-halfDepth], [halfWidth,-halfDepth], [halfWidth,halfDepth], [-halfWidth,halfDepth]]
    .map(([localX, localZ]) => [x + localX * cosine - localZ * sine, z + localX * sine + localZ * cosine]);
}

/** Build one capped line buffer for debug rendering. No objects are created per proxy. */
export function buildGeoDebugSnapshot(world, focus = { x: 0, z: 0 }, {
  maxLineSegments = GEO_DEBUG_LIMITS.maxLineSegments,
} = {}) {
  if (!Number.isInteger(maxLineSegments) || maxLineSegments <= 0 || maxLineSegments > 20_000) {
    throw new RangeError('Invalid geographic debug line budget');
  }
  const positions = [], colors = [], owners = [], environmentProfiles = [], morphologyProfiles = [];
  const waterDomainProfiles = [], buildingGrammarProfiles = [], streetFurnitureProfiles = [], bridgeProfiles = [];
  const landmarkProfiles = [];
  const maskCounts = new Map(), layerCounts = new Map();
  let lineSegments = 0, collisionPolygons = 0, roadSupports = 0, supportSlots = 0, occupiedSlots = 0, truncated = false;
  const pushLine = (first, second, color) => {
    if (lineSegments >= maxLineSegments) { truncated = true; return false; }
    positions.push(...first, ...second);
    colors.push(...color, ...color);
    lineSegments++;
    return true;
  };

  for (const tile of world?.tiles?.values?.() ?? []) {
    owners.push(tile.key);
    if (tile.environment) environmentProfiles.push(Object.freeze({
      owner: tile.key,
      namespace: tile.environment.namespace,
      profileIds: Object.freeze([...(tile.environment.topBiomeIds ?? [])]),
      quantizedWeights: Object.freeze([...(tile.environment.topBiomeWeights ?? [])]),
      fallback: tile.environment.fallback,
    }));
    if (tile.morphologyDiagnostics) morphologyProfiles.push(Object.freeze({
      owner: tile.key,
      namespace: tile.morphologyDiagnostics.namespace,
      samples: tile.morphologyDiagnostics.samples,
      plants: tile.morphologyDiagnostics.plants,
      scale: tile.morphologyDiagnostics.scale,
      variants: tile.morphologyDiagnostics.variants,
      packing: tile.morphologyDiagnostics.packing,
      capEvents: tile.morphologyDiagnostics.capEvents,
    }));
    if (tile.waterDomain?.meta) waterDomainProfiles.push(Object.freeze({
      owner: tile.key,
      namespace: tile.waterDomain.namespace,
      waterPolygons: tile.waterDomain.meta.waterPolygons,
      waterwaySegments: tile.waterDomain.meta.waterwaySegments,
      flowingPolygons: tile.waterDomain.meta.flowingPolygons,
      mappedFlowSegments: tile.waterDomain.meta.mappedFlowSegments,
      flowAssociationTests: tile.waterDomain.meta.flowAssociationTests,
      classCounts: tile.waterDomain.meta.classCounts,
      bytes: tile.waterDomain.meta.bytes,
      malformedRecords: tile.waterDomain.meta.malformedRecords,
      capEvents: tile.waterDomain.meta.capEvents,
    }));
    if (tile.buildingMeta?.buildingGrammar) buildingGrammarProfiles.push(Object.freeze({
      owner: tile.key,
      ...tile.buildingMeta.buildingGrammar,
      visible: Boolean(tile.buildingDetails?.visible),
    }));
    if (tile.streetFurnitureMeta) streetFurnitureProfiles.push(Object.freeze({
      owner: tile.key,
      ...tile.streetFurnitureMeta,
    }));
    if (tile.landmarkGrammar?.selected) landmarkProfiles.push(Object.freeze({
      owner: tile.key,
      ...tile.landmarkGrammar,
    }));
    if (tile.bridgeMeta) bridgeProfiles.push(Object.freeze({
      owner: tile.key,
      ...tile.bridgeMeta,
    }));
    layerCounts.set('ground', (layerCounts.get('ground') ?? 0) + 1);
    if (tile.roads || tile.roadSupportSegments?.length) layerCounts.set('road', (layerCounts.get('road') ?? 0) + 1);
    if (tile.land) layerCounts.set('land', (layerCounts.get('land') ?? 0) + 1);
    if (tile.water) layerCounts.set('water', (layerCounts.get('water') ?? 0) + 1);
    if (tile.buildings || tile.colliders?.length) layerCounts.set('building', (layerCounts.get('building') ?? 0) + 1);
    for (const decoration of tile.decorations ?? []) {
      layerCounts.set('decoration', (layerCounts.get('decoration') ?? 0) + 1);
    }
    if (tile.ambientLifeCount) layerCounts.set('ambience', (layerCounts.get('ambience') ?? 0) + 1);
    const vertices = tile.collisionVertices, ringOffsets = tile.collisionRingOffsets;
    const polygonOffsets = tile.collisionPolygonOffsets, spans = tile.collisionSpans;
    const masks = tile.collisionMasks;
    const polygonCount = Math.floor((tile.colliders?.length ?? 0) / 4);
    if (vertices instanceof Float32Array && ringOffsets instanceof Uint32Array && polygonOffsets instanceof Uint32Array) {
      for (let polygon = 0; polygon < polygonCount && !truncated; polygon++) {
        const mask = masks?.[polygon] ?? 0;
        const role = describeGeoQueryMask(mask);
        maskCounts.set(role, (maskCounts.get(role) ?? 0) + 1);
        const color = maskColor(mask);
        const baseY = spans?.[polygon * 2] ?? 0, topY = spans?.[polygon * 2 + 1] ?? baseY;
        const firstRing = polygonOffsets[polygon] ?? 0, endRing = polygonOffsets[polygon + 1] ?? firstRing;
        for (let ring = firstRing; ring < endRing && !truncated; ring++) {
          const firstVertex = ringOffsets[ring] ?? 0, endVertex = ringOffsets[ring + 1] ?? firstVertex;
          for (let vertex = firstVertex; vertex < endVertex && !truncated; vertex++) {
            const next = vertex + 1 < endVertex ? vertex + 1 : firstVertex;
            const x1 = vertices[vertex * 2], z1 = vertices[vertex * 2 + 1];
            const x2 = vertices[next * 2], z2 = vertices[next * 2 + 1];
            pushLine([x1, baseY, z1], [x2, baseY, z2], color);
            pushLine([x1, topY, z1], [x2, topY, z2], color);
            if (vertex === firstVertex) pushLine([x1, baseY, z1], [x1, topY, z1], color);
          }
        }
        collisionPolygons++;
      }
    }

    const roads = tile.roadSupportSegments;
    if (roads instanceof Float32Array && tile.roadSupportStride === 8) {
      for (let offset = 0; offset + 7 < roads.length && !truncated; offset += 8) {
        const level = Math.round(roads[offset + 7]);
        pushLine([roads[offset], roads[offset + 2] + .018, roads[offset + 1]],
          [roads[offset + 3], roads[offset + 5] + .018, roads[offset + 4]],
          level > 0 ? COLORS.bridge : level < 0 ? COLORS.tunnel : COLORS.groundRoad);
        roadSupports++;
      }
    }

    const slots = tile.supportSlots, states = tile.supportSlotStates;
    if (slots instanceof Float32Array && tile.supportSlotStride === GEO_SUPPORT_SLOT_STRIDE) {
      for (let offset = 0, slot = 0; offset + GEO_SUPPORT_SLOT_STRIDE - 1 < slots.length && !truncated;
        offset += GEO_SUPPORT_SLOT_STRIDE, slot++) {
        const x = slots[offset + GEO_SUPPORT_SLOT_FIELD.X], y = slots[offset + GEO_SUPPORT_SLOT_FIELD.Y] + .035;
        const z = slots[offset + GEO_SUPPORT_SLOT_FIELD.Z];
        const corners = rotatedRectangle(x, z, slots[offset + GEO_SUPPORT_SLOT_FIELD.HALF_WIDTH],
          slots[offset + GEO_SUPPORT_SLOT_FIELD.HALF_DEPTH], slots[offset + GEO_SUPPORT_SLOT_FIELD.YAW]);
        const occupied = Boolean(states?.[slot]), color = occupied ? COLORS.occupied : COLORS.support;
        for (let corner = 0; corner < 4; corner++) pushLine(
          [corners[corner][0], y, corners[corner][1]],
          [corners[(corner + 1) % 4][0], y, corners[(corner + 1) % 4][1]], color,
        );
        supportSlots++;
        occupiedSlots += Number(occupied);
      }
    }
  }

  let focusSupport = null;
  if (!truncated && typeof world?.supportAt === 'function' && Number.isFinite(focus?.x) && Number.isFinite(focus?.z)) {
    focusSupport = world.supportAt(focus.x, focus.z, {});
    if (focusSupport && [focusSupport.y, focusSupport.normalX, focusSupport.normalY, focusSupport.normalZ].every(Number.isFinite)) {
      pushLine([focus.x, focusSupport.y + .025, focus.z], [
        focus.x + focusSupport.normalX * .55,
        focusSupport.y + .025 + focusSupport.normalY * .55,
        focus.z + focusSupport.normalZ * .55,
      ], COLORS.normal);
    }
  }

  const objectRecipeLods = [...(world?.tiles?.values?.() ?? [])]
    .reduce((total, tile) => {
      const all = tile.buildingMeta?.objectRecipes ?? 0;
      const near = tile.buildingMeta?.buildingGrammar?.selectedBuildings ?? 0;
      total.far += Math.max(0, all - near);
      total.near += near;
      return total;
    }, { far: 0, near: 0 });
  const objectRecipeCount = objectRecipeLods.far + objectRecipeLods.near;
  return Object.freeze({
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    lineSegments,
    truncated,
    summary: Object.freeze({
      owners: Object.freeze(owners.sort()),
      layers: Object.freeze([...layerCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      collisionPolygons,
      masks: Object.freeze([...maskCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      roadSupports,
      supportSlots,
      occupiedSlots,
      lod: objectRecipeCount
        ? `far:${objectRecipeLods.far} near:${objectRecipeLods.near} recipe${objectRecipeCount === 1 ? '' : 's'}` : 'none',
      timings: world?.timings ? Object.freeze({ ...world.timings }) : null,
      materials: world?.materialLibrary?.diagnostics ?? null,
      plantGrammar: world?.plantArchetypes?.diagnostics ?? null,
      plantGeometry: world?.plantGeometryArchetypes?.diagnostics ?? null,
      plantLods: world?.plantLods?.diagnostics ?? null,
      plantLodSelector: world?.plantLodSelector?.diagnostics ?? null,
      plantRender: world?.plantRenderPools?.diagnostics ?? null,
      // `COL-09`: the capped moving-solid hash behind every merged query. The
      // numeric counters also travel with the runtime budget metrics.
      dynamicProxyState: world?.dynamicProxies?.diagnostics?.() ?? null,
      dynamicProxies: world?.dynamicProxies?.diagnostics?.().activeProxies ?? 0,
      dynamicProxyCells: world?.dynamicProxies?.diagnostics?.().cells ?? 0,
      dynamicProxyCapSkips: world?.dynamicProxies?.diagnostics?.().capSkips ?? 0,
      dynamicProxyReinserts: world?.dynamicProxies?.diagnostics?.().reinserts ?? 0,
      dynamicProxySteadyFrameAllocations: world?.dynamicProxies?.diagnostics?.().steadyFrameAllocations ?? 0,
      // `VEG-02`: the last silhouette/cost audit verdict for this world.
      plantSilhouette: world?.plantSilhouetteSummary ?? null,
      streetFurniture: world?.streetFurniturePools?.diagnostics ?? null,
      ambientLife: world?.ambientLifePools?.diagnostics ?? null,
      bridges: world?.bridgePools?.diagnostics ?? null,
      landmarks: world?.landmarkPools?.diagnostics ?? null,
      tileCache: world?.tileCacheDiagnostics ?? null,
      // `GME-04`: label LOS verdict counts and the richer map readout at focus.
      labelLos: world?.labelLosDiagnostics ? Object.freeze({ ...world.labelLosDiagnostics }) : null,
      mapReadout: world?.mapReadout
        ? Object.freeze({ ...world.mapReadout(focus.x, focus.z) })
        : null,
      // `MAP-08`: the vocabulary the resident tiles were normalized from, plus
      // the canonical classes and roles the adapter recognizes.
      mapSemantics: Object.freeze({
        providerSchema: world?.providerSchema ?? null,
        roles: GEO_MAP_SEMANTICS_VOCABULARY.roles,
        roadClasses: GEO_MAP_SEMANTICS_VOCABULARY.roadClasses,
      }),
      // `FND-08`: the shared world domain, its scale and live compliance verdict,
      // so one consumer can prove it is talking to the interface it expects.
      domain: world?.domain ? Object.freeze({
        id: world.domain.id,
        summary: describeDomain(world.domain),
        unitsPerMetre: world.domain.unitsPerMetre,
        capabilities: world.domain.capabilities,
        compliant: describeDomainCompliance(world, world.domain).ok,
      }) : null,
      // `FND-07`: the live ownership ledger and the last movement-audit verdict
      // are part of the debug surface, not a separate tool.
      lifecycle: world?.lifecycle?.snapshot?.() ?? null,
      movementAudit: world?.movementAuditSummary ?? null,
      environmentProfiles: Object.freeze(environmentProfiles.sort((a, b) => a.owner.localeCompare(b.owner))),
      morphologyProfiles: Object.freeze(morphologyProfiles.sort((a, b) => a.owner.localeCompare(b.owner))),
      waterDomainProfiles: Object.freeze(waterDomainProfiles.sort((a, b) => a.owner.localeCompare(b.owner))),
      buildingGrammarProfiles: Object.freeze(buildingGrammarProfiles.sort((a, b) => a.owner.localeCompare(b.owner))),
      streetFurnitureProfiles: Object.freeze(streetFurnitureProfiles.sort((a, b) => a.owner.localeCompare(b.owner))),
      bridgeProfiles: Object.freeze(bridgeProfiles.sort((a, b) => a.owner.localeCompare(b.owner))),
      landmarkProfiles: Object.freeze(landmarkProfiles.sort((a, b) => a.owner.localeCompare(b.owner))),
      focusSupport: focusSupport ? Object.freeze({
        kind: focusSupport.kind,
        physicalLevel: focusSupport.physicalLevel,
        y: focusSupport.y,
        slopeRadians: focusSupport.slopeRadians,
      }) : null,
    }),
  });
}
