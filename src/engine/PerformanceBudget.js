const MEBIBYTE = 1024 * 1024;
const KIBIBYTE = 1024;

/** Canonical low-profile ceilings consolidated from the project research. */
export const GDO_LOW_PROFILE_BUDGETS = Object.freeze({
  residentTiles: 4,
  activeRequests: 2,
  streetDrawCalls: 35,
  cornerDrawCalls: 80,
  visibleTriangles: 180_000,
  estimatedGpuBytes: 128 * MEBIBYTE,
  materialTextureBytes: 256 * KIBIBYTE,
  plantArchetypes: 48,
  plantSkeletonNodes: 18,
  plantSkeletonModules: 18,
  plantGeometryArchetypes: 48,
  plantGeometryBoxes: 18,
  plantGeometryTriangles: 216,
  plantGeometryBytes: 1.5 * MEBIBYTE,
  plantLodSets: 16,
  plantLodGeometries: 48,
  plantLodBytes: 1.5 * MEBIBYTE,
  plantLodEntries: 5_360,
  plantLodReevaluationsHz: 4,
  plantCompileMilliseconds: 3,
  plantRenderEntries: 5_360,
  plantRenderPools: 18,
  plantRenderSourceGeometries: 48,
  plantRenderGpuBytes: 1.5 * MEBIBYTE,
  plantRenderVisibleTriangles: 75_000,
  // `VEG-02`: research §17.2 low-profile silhouette ceilings — box modules after
  // LOD and the minimum far-tier silhouette retention (§19.2.5).
  plantBoxModulesAfterLod: 6_000,
  // `COL-09`: research §5.1 dynamic-proxy cap for the low profile.
  dynamicProxies: 64,
  // `LIF-02`: research §6.7/low-profile ambience — the explicit screen-space
  // scheduler budgets how many ambient sprites are actually drawn per frame.
  ambientActiveSources: 8,
  ambientMinProjectedPixels: .6,
  ambientSchedulerSteadyFrameAllocations: 0,
  // `COL-08`: research §5.7/§9.5 — one body-centre water sample per step and a
  // bounded four-sample footprint when a lookup needs an edge test.
  waterSamplesPerStep: 1,
  waterSamplesPerLookup: 4,
  waterSteadyFrameAllocations: 0,
  // `ENV-02`: research §9.1 low-profile sky model — one static seeded star set
  // and a bounded uniform writer so a day cycle cannot storm the renderer.
  skyStars: 120,
  skyUniformWritesPerUpdate: 14,
  skyUniformWritesPerFrame: 14,
  skySteadyFrameAllocations: 0,
  plantFarSilhouetteRetention: .9,
  plantRenderAddedDrawCalls: 8,
  plantWindUniformWritesPerFrame: 1,
  plantWindCpuMatrixUpdatesPerFrame: 0,
  plantWindSteadyFrameAllocations: 0,
  buildingDetailBuildings: 8,
  buildingDetailBoxes: 96,
  buildingDetailTriangles: 20_000,
  buildingDetailBytesPerTile: 256 * KIBIBYTE,
  buildingDetailAddedDrawCalls: 1,
  buildingDetailRoadTestsPerTile: 32_768,
  streetFurnitureEntries: 256,
  streetFurnitureFamilies: 7,
  streetFurnitureVisibleTriangles: 25_000,
  streetFurnitureGpuBytes: 256 * KIBIBYTE,
  streetFurnitureAddedDrawCalls: 7,
  streetFurnitureBytesPerTile: 1_536,
  streetFurniturePlacementTests: 32_768,
  streetFurnitureSteadyFrameMatrixUpdates: 0,
  bridgeSpansPerTile: 1_024,
  bridgePlacementsPerTile: 384,
  bridgeBytesPerTile: 384 * 11 * 4,
  bridgeVisibleTriangles: 32_000,
  bridgeAddedDrawCalls: 7,
  bridgeGpuBytes: 256 * KIBIBYTE,
  bridgeSteadyFrameMatrixUpdates: 0,
  landmarkBoxesPerTile: 180,
  landmarkBytesPerTile: 192 * KIBIBYTE,
  landmarkVisibleTriangles: 3_000,
  landmarkAddedDrawCalls: 1,
  landmarkGpuBytes: 4 * 192 * KIBIBYTE,
  landmarkStructuralCompounds: 32,
  landmarkEnclosingCompounds: 0,
  landmarkSteadyFrameMatrixUpdates: 0,
  tileCacheBytes: 6 * MEBIBYTE,
  tileCacheEntries: 24,
  ambientLifeInstancesPerFamily: 30,
  ambientLifeVisibleTriangles: 1_000,
  ambientLifeAddedDrawCalls: 2,
  ambientLifeInstanceBytes: 8 * KIBIBYTE,
  ambientLifeUniformWritesPerFrame: 1,
  ambientLifeCpuMatrixUpdatesPerFrame: 0,
  ambientLifeSteadyFrameAllocations: 0,
  waterDomainBytesPerTile: 512 * KIBIBYTE,
  collisionBytesPerTile: 512 * KIBIBYTE,
  workerContextMilliseconds: 150,
  mainThreadMountMilliseconds: 8,
  maxCollisionCandidates: 256,
  maxSupportCandidates: 256,
  // `COL-06`: the curated island's structural sweep answers the declared
  // `dynamicSweep` member with the same bounded candidate work the coordinate
  // sweep declares.
  curatedSweepCandidates: 256,
  curatedSweepSteadyFrameAllocations: 0,
  // `GME-06`: the discovery journal is bounded local state — a capped record set
  // of deterministic place ids with no per-frame allocation.
  discoveryRecords: 48,
  discoverySteadyFrameAllocations: 0,
  // `GME-04` label LOS ceilings from CLIPPING_AND_LAYERING_RESEARCH.md §13.
  labelLosTestsPerSecond: 20,
  labelLosCandidates: 5,
  labelLosSteadyFrameAllocations: 0,
  lifecycleOwnedResources: 384,
});

/**
 * `FND-07` per-profile live-resource ceilings. A mount that keeps more than
 * these live across a remount is a lifecycle defect, not a budget preference.
 */
export const GDO_LIFECYCLE_CEILINGS = Object.freeze({
  low: Object.freeze({
    total: 384,
    worker: 1, listener: 24, observer: 2, timer: 2, frame: 1,
    geometry: 170, material: 24, texture: 16, mesh: 96, node: 32, pool: 8, handle: 8,
  }),
  balanced: Object.freeze({
    total: 633,
    worker: 2, listener: 32, observer: 3, timer: 3, frame: 1,
    geometry: 320, material: 32, texture: 20, mesh: 160, node: 40, pool: 10, handle: 10,
  }),
  high: Object.freeze({
    total: 1180,
    worker: 3, listener: 48, observer: 4, timer: 4, frame: 1,
    geometry: 640, material: 48, texture: 24, mesh: 320, node: 64, pool: 12, handle: 12,
  }),
});

/** Unknown or hostile profile names resolve to the low ceilings. */
export function lifecycleCeilingsForProfile(profile) {
  return GDO_LIFECYCLE_CEILINGS[profile] ?? GDO_LIFECYCLE_CEILINGS.low;
}

const CHECKS = Object.freeze([
  Object.freeze({ metric: 'residentTiles', budget: 'residentTiles', label: 'resident tiles' }),
  Object.freeze({ metric: 'activeRequests', budget: 'activeRequests', label: 'active requests' }),
  Object.freeze({ metric: 'triangles', budget: 'visibleTriangles', label: 'visible triangles' }),
  Object.freeze({ metric: 'estimatedGpuBytes', budget: 'estimatedGpuBytes', label: 'estimated GPU bytes' }),
  Object.freeze({ metric: 'materialTextureBytes', budget: 'materialTextureBytes', label: 'shared material texture bytes' }),
  Object.freeze({ metric: 'plantArchetypes', budget: 'plantArchetypes', label: 'cached plant skeleton archetypes' }),
  Object.freeze({ metric: 'plantSkeletonNodes', budget: 'plantSkeletonNodes', label: 'plant skeleton nodes' }),
  Object.freeze({ metric: 'plantSkeletonModules', budget: 'plantSkeletonModules', label: 'plant skeleton modules' }),
  Object.freeze({ metric: 'plantGeometryArchetypes', budget: 'plantGeometryArchetypes', label: 'cached plant geometry archetypes' }),
  Object.freeze({ metric: 'plantGeometryBoxes', budget: 'plantGeometryBoxes', label: 'plant geometry boxes/archetype' }),
  Object.freeze({ metric: 'plantGeometryTriangles', budget: 'plantGeometryTriangles', label: 'plant geometry triangles/archetype' }),
  Object.freeze({ metric: 'plantGeometryBytes', budget: 'plantGeometryBytes', label: 'cached plant geometry bytes' }),
  Object.freeze({ metric: 'plantLodSets', budget: 'plantLodSets', label: 'cached plant LOD sets' }),
  Object.freeze({ metric: 'plantLodGeometries', budget: 'plantLodGeometries', label: 'cached plant LOD geometries' }),
  Object.freeze({ metric: 'plantLodBytes', budget: 'plantLodBytes', label: 'cached plant LOD bytes' }),
  Object.freeze({ metric: 'plantLodEntries', budget: 'plantLodEntries', label: 'resident plant LOD entries' }),
  Object.freeze({ metric: 'plantLodReevaluationsHz', budget: 'plantLodReevaluationsHz', label: 'plant LOD reevaluations Hz' }),
  Object.freeze({ metric: 'plantCompileMilliseconds', budget: 'plantCompileMilliseconds', label: 'plant compile ms' }),
  Object.freeze({ metric: 'plantRenderEntries', budget: 'plantRenderEntries', label: 'resident plant render records' }),
  Object.freeze({ metric: 'plantRenderPools', budget: 'plantRenderPools', label: 'global plant render pools' }),
  Object.freeze({ metric: 'plantRenderSourceGeometries', budget: 'plantRenderSourceGeometries', label: 'plant render source geometries' }),
  Object.freeze({ metric: 'plantRenderGpuBytes', budget: 'plantRenderGpuBytes', label: 'plant render GPU geometry bytes' }),
  Object.freeze({ metric: 'plantRenderVisibleTriangles', budget: 'plantRenderVisibleTriangles', label: 'visible plant triangles' }),
  Object.freeze({ metric: 'plantBoxModules', budget: 'plantBoxModulesAfterLod', label: 'plant box modules after LOD' }),
  Object.freeze({ metric: 'dynamicProxies', budget: 'dynamicProxies', label: 'active dynamic proxies' }),
  Object.freeze({ metric: 'plantFarSilhouetteRetention', budget: 'plantFarSilhouetteRetention', label: 'plant far silhouette retention' }),
  Object.freeze({ metric: 'plantRenderAddedDrawCalls', budget: 'plantRenderAddedDrawCalls', label: 'added plant draw calls' }),
  Object.freeze({ metric: 'plantWindUniformWritesPerFrame', budget: 'plantWindUniformWritesPerFrame', label: 'plant wind uniform writes/frame' }),
  Object.freeze({ metric: 'plantWindCpuMatrixUpdatesPerFrame', budget: 'plantWindCpuMatrixUpdatesPerFrame', label: 'plant wind CPU matrix updates/frame' }),
  Object.freeze({ metric: 'plantWindSteadyFrameAllocations', budget: 'plantWindSteadyFrameAllocations', label: 'plant wind steady-frame allocations' }),
  Object.freeze({ metric: 'buildingDetailBuildings', budget: 'buildingDetailBuildings', label: 'near detailed buildings' }),
  Object.freeze({ metric: 'buildingDetailBoxes', budget: 'buildingDetailBoxes', label: 'building detail boxes' }),
  Object.freeze({ metric: 'buildingDetailTriangles', budget: 'buildingDetailTriangles', label: 'building detail triangles' }),
  Object.freeze({ metric: 'buildingDetailBytesPerTile', budget: 'buildingDetailBytesPerTile', label: 'building detail bytes/tile' }),
  Object.freeze({ metric: 'buildingDetailAddedDrawCalls', budget: 'buildingDetailAddedDrawCalls', label: 'building detail added draw calls' }),
  Object.freeze({ metric: 'buildingDetailRoadTestsPerTile', budget: 'buildingDetailRoadTestsPerTile', label: 'building road-facing tests/tile' }),
  Object.freeze({ metric: 'streetFurnitureEntries', budget: 'streetFurnitureEntries', label: 'resident street-furniture entries' }),
  Object.freeze({ metric: 'streetFurnitureFamilies', budget: 'streetFurnitureFamilies', label: 'street-furniture source families' }),
  Object.freeze({ metric: 'streetFurnitureVisibleTriangles', budget: 'streetFurnitureVisibleTriangles', label: 'street-furniture visible triangles' }),
  Object.freeze({ metric: 'streetFurnitureGpuBytes', budget: 'streetFurnitureGpuBytes', label: 'street-furniture GPU bytes' }),
  Object.freeze({ metric: 'streetFurnitureAddedDrawCalls', budget: 'streetFurnitureAddedDrawCalls', label: 'street-furniture added draws' }),
  Object.freeze({ metric: 'streetFurnitureBytesPerTile', budget: 'streetFurnitureBytesPerTile', label: 'street-furniture bytes/tile' }),
  Object.freeze({ metric: 'streetFurniturePlacementTests', budget: 'streetFurniturePlacementTests', label: 'street-furniture placement tests/tile' }),
  Object.freeze({ metric: 'streetFurnitureSteadyFrameMatrixUpdates', budget: 'streetFurnitureSteadyFrameMatrixUpdates', label: 'street-furniture steady-frame matrix updates' }),
  Object.freeze({ metric: 'bridgeSpansPerTile', budget: 'bridgeSpansPerTile', label: 'bridge spans/tile' }),
  Object.freeze({ metric: 'bridgePlacementsPerTile', budget: 'bridgePlacementsPerTile', label: 'bridge modules/tile' }),
  Object.freeze({ metric: 'bridgeBytesPerTile', budget: 'bridgeBytesPerTile', label: 'bridge bytes/tile' }),
  Object.freeze({ metric: 'bridgeVisibleTriangles', budget: 'bridgeVisibleTriangles', label: 'visible bridge triangles' }),
  Object.freeze({ metric: 'bridgeAddedDrawCalls', budget: 'bridgeAddedDrawCalls', label: 'bridge added draws' }),
  Object.freeze({ metric: 'bridgeGpuBytes', budget: 'bridgeGpuBytes', label: 'bridge GPU bytes' }),
  Object.freeze({ metric: 'bridgeSteadyFrameMatrixUpdates', budget: 'bridgeSteadyFrameMatrixUpdates', label: 'bridge steady-frame matrix updates' }),
  Object.freeze({ metric: 'landmarkBoxesPerTile', budget: 'landmarkBoxesPerTile', label: 'landmark boxes/tile' }),
  Object.freeze({ metric: 'landmarkBytesPerTile', budget: 'landmarkBytesPerTile', label: 'landmark bytes/tile' }),
  Object.freeze({ metric: 'landmarkVisibleTriangles', budget: 'landmarkVisibleTriangles', label: 'visible landmark triangles' }),
  Object.freeze({ metric: 'landmarkAddedDrawCalls', budget: 'landmarkAddedDrawCalls', label: 'landmark added draws' }),
  Object.freeze({ metric: 'landmarkGpuBytes', budget: 'landmarkGpuBytes', label: 'landmark GPU bytes' }),
  Object.freeze({ metric: 'landmarkStructuralCompounds', budget: 'landmarkStructuralCompounds', label: 'landmark structural compounds' }),
  Object.freeze({ metric: 'landmarkEnclosingCompounds', budget: 'landmarkEnclosingCompounds', label: 'landmark enclosing compounds' }),
  Object.freeze({ metric: 'landmarkSteadyFrameMatrixUpdates', budget: 'landmarkSteadyFrameMatrixUpdates', label: 'landmark steady-frame matrix updates' }),
  Object.freeze({ metric: 'tileCacheBytes', budget: 'tileCacheBytes', label: 'persistent tile cache bytes' }),
  Object.freeze({ metric: 'tileCacheEntries', budget: 'tileCacheEntries', label: 'persistent tile cache entries' }),
  Object.freeze({ metric: 'ambientLifeInstancesPerFamily', budget: 'ambientLifeInstancesPerFamily', label: 'ambient-life sprites per family' }),
  Object.freeze({ metric: 'ambientLifeVisibleTriangles', budget: 'ambientLifeVisibleTriangles', label: 'visible ambient-life triangles' }),
  Object.freeze({ metric: 'ambientLifeAddedDrawCalls', budget: 'ambientLifeAddedDrawCalls', label: 'ambient-life added draws' }),
  Object.freeze({ metric: 'ambientLifeInstanceBytes', budget: 'ambientLifeInstanceBytes', label: 'ambient-life instance bytes' }),
  Object.freeze({ metric: 'ambientLifeUniformWritesPerFrame', budget: 'ambientLifeUniformWritesPerFrame', label: 'ambient-life uniform writes/frame' }),
  Object.freeze({ metric: 'ambientLifeCpuMatrixUpdatesPerFrame', budget: 'ambientLifeCpuMatrixUpdatesPerFrame', label: 'ambient-life CPU matrix updates/frame' }),
  Object.freeze({ metric: 'ambientLifeSteadyFrameAllocations', budget: 'ambientLifeSteadyFrameAllocations', label: 'ambient-life steady-frame allocations' }),
  Object.freeze({ metric: 'waterDomainBytesPerTile', budget: 'waterDomainBytesPerTile', label: 'water class/flow domain bytes/tile' }),
  Object.freeze({ metric: 'collisionBytesPerTile', budget: 'collisionBytesPerTile', label: 'collision bytes/tile' }),
  Object.freeze({ metric: 'workerContextMilliseconds', budget: 'workerContextMilliseconds', label: 'worker context ms' }),
  Object.freeze({ metric: 'mainThreadMountMilliseconds', budget: 'mainThreadMountMilliseconds', label: 'main-thread mount ms' }),
  Object.freeze({ metric: 'maxCollisionCandidates', budget: 'maxCollisionCandidates', label: 'collision candidates' }),
  Object.freeze({ metric: 'maxSupportCandidates', budget: 'maxSupportCandidates', label: 'support candidates' }),
  Object.freeze({ metric: 'curatedSweepCandidates', budget: 'curatedSweepCandidates', label: 'curated structural sweep candidates' }),
  Object.freeze({ metric: 'curatedSweepSteadyFrameAllocations', budget: 'curatedSweepSteadyFrameAllocations', label: 'curated sweep steady-frame allocations' }),
  Object.freeze({ metric: 'discoveryRecords', budget: 'discoveryRecords', label: 'discovery journal records' }),
  Object.freeze({ metric: 'discoverySteadyFrameAllocations', budget: 'discoverySteadyFrameAllocations', label: 'discovery steady-frame allocations' }),
  Object.freeze({ metric: 'labelLosTestsPerSecond', budget: 'labelLosTestsPerSecond', label: 'label LOS tests/second' }),
  Object.freeze({ metric: 'labelLosCandidates', budget: 'labelLosCandidates', label: 'labels LOS-tested per frame' }),
  Object.freeze({ metric: 'labelLosSteadyFrameAllocations', budget: 'labelLosSteadyFrameAllocations', label: 'label LOS steady-frame allocations' }),
  Object.freeze({ metric: 'lifecycleOwnedResources', budget: 'lifecycleOwnedResources', label: 'live owned resources' }),
]);

function finiteNonNegative(value) { return Number.isFinite(value) && value >= 0; }

/**
 * Wall-clock ceilings. They still have to be reported, but a shared/loaded host
 * can breach them without any code regression, so they are advisory by default
 * and only enforced when a caller explicitly asks for strict timing (the
 * synthetic "every ceiling fails" test does). Every work-unit ceiling — bytes,
 * entries, boxes, draws, scans — remains a hard failure, so an unbounded-work
 * regression can never hide behind this.
 */
export const GDO_ADVISORY_TIMING_METRICS = Object.freeze([
  'plantCompileMilliseconds',
  'workerContextMilliseconds',
  'mainThreadMountMilliseconds',
]);

const ADVISORY_TIMING = new Set(GDO_ADVISORY_TIMING_METRICS);

export class PerformanceBudgetError extends Error {
  constructor(report) {
    super(`Low-profile budget exceeded: ${report.breaches.map(item =>
      `${item.metric}=${item.actual} > ${item.ceiling}`).join('; ')}`);
    this.name = 'PerformanceBudgetError';
    this.report = report;
  }
}

/**
 * Evaluate only metrics supplied by the caller. This lets deterministic tests
 * audit worker output while the live debug panel can add renderer measurements.
 */
export function evaluateLowProfileBudget(metrics = {}, {
  view = 'street',
  budgets = GDO_LOW_PROFILE_BUDGETS,
  strictTiming = false,
} = {}) {
  if (!metrics || typeof metrics !== 'object') throw new TypeError('Budget metrics must be an object');
  if (view !== 'street' && view !== 'corner') throw new RangeError(`Unknown budget view: ${view}`);
  const breaches = [], checked = [], advisories = [];
  const record = item => {
    checked.push(item);
    if (item.actual <= item.ceiling) return;
    if (!strictTiming && ADVISORY_TIMING.has(item.metric)) advisories.push(item);
    else breaches.push(item);
  };
  const drawBudget = view === 'corner' ? budgets.cornerDrawCalls : budgets.streetDrawCalls;
  if (finiteNonNegative(metrics.drawCalls)) {
    record(Object.freeze({ metric: 'drawCalls', label: `${view} draw calls`, actual: metrics.drawCalls, ceiling: drawBudget }));
  }
  for (const check of CHECKS) {
    const actual = metrics[check.metric], ceiling = budgets[check.budget];
    if (!finiteNonNegative(actual) || !finiteNonNegative(ceiling)) continue;
    record(Object.freeze({ metric: check.metric, label: check.label, actual, ceiling }));
  }
  return Object.freeze({
    profile: 'low',
    view,
    strictTiming,
    ok: breaches.length === 0,
    checked: Object.freeze(checked),
    breaches: Object.freeze(breaches),
    advisories: Object.freeze(advisories),
  });
}

export function assertLowProfileBudget(metrics, options) {
  const report = evaluateLowProfileBudget(metrics, options);
  if (!report.ok) throw new PerformanceBudgetError(report);
  return report;
}
