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
  waterDomainBytesPerTile: 512 * KIBIBYTE,
  collisionBytesPerTile: 512 * KIBIBYTE,
  workerContextMilliseconds: 150,
  mainThreadMountMilliseconds: 8,
  maxCollisionCandidates: 256,
  maxSupportCandidates: 256,
  dynamicProxies: 64,
  // `LIF-02` / biome research §14: "Small ambient fauna visible | 30 | 60 | 100"
  // and "Total added steady draw calls in ordinary view | ≤ 8". The low profile
  // takes the research's low column, and the added draw calls are the two batched
  // ambience pools (birds, bees) the world already mounts.
  ambientFaunaVisible: 30,
  ambientAddedDrawCalls: 2,
});

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
  Object.freeze({ metric: 'waterDomainBytesPerTile', budget: 'waterDomainBytesPerTile', label: 'water class/flow domain bytes/tile' }),
  Object.freeze({ metric: 'collisionBytesPerTile', budget: 'collisionBytesPerTile', label: 'collision bytes/tile' }),
  Object.freeze({ metric: 'workerContextMilliseconds', budget: 'workerContextMilliseconds', label: 'worker context ms' }),
  Object.freeze({ metric: 'mainThreadMountMilliseconds', budget: 'mainThreadMountMilliseconds', label: 'main-thread mount ms' }),
  Object.freeze({ metric: 'maxCollisionCandidates', budget: 'maxCollisionCandidates', label: 'collision candidates' }),
  Object.freeze({ metric: 'maxSupportCandidates', budget: 'maxSupportCandidates', label: 'support candidates' }),
  Object.freeze({ metric: 'dynamicProxies', budget: 'dynamicProxies', label: 'active dynamic proxies' }),
  Object.freeze({ metric: 'ambientVisible', budget: 'ambientFaunaVisible', label: 'visible ambient fauna' }),
  Object.freeze({ metric: 'ambientAddedDrawCalls', budget: 'ambientAddedDrawCalls', label: 'ambient draw calls' }),
]);

function finiteNonNegative(value) { return Number.isFinite(value) && value >= 0; }

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
} = {}) {
  if (!metrics || typeof metrics !== 'object') throw new TypeError('Budget metrics must be an object');
  if (view !== 'street' && view !== 'corner') throw new RangeError(`Unknown budget view: ${view}`);
  const breaches = [], checked = [];
  const drawBudget = view === 'corner' ? budgets.cornerDrawCalls : budgets.streetDrawCalls;
  if (finiteNonNegative(metrics.drawCalls)) {
    const item = Object.freeze({ metric: 'drawCalls', label: `${view} draw calls`, actual: metrics.drawCalls, ceiling: drawBudget });
    checked.push(item);
    if (item.actual > item.ceiling) breaches.push(item);
  }
  for (const check of CHECKS) {
    const actual = metrics[check.metric], ceiling = budgets[check.budget];
    if (!finiteNonNegative(actual) || !finiteNonNegative(ceiling)) continue;
    const item = Object.freeze({ metric: check.metric, label: check.label, actual, ceiling });
    checked.push(item);
    if (actual > ceiling) breaches.push(item);
  }
  return Object.freeze({
    profile: 'low',
    view,
    ok: breaches.length === 0,
    checked: Object.freeze(checked),
    breaches: Object.freeze(breaches),
  });
}

export function assertLowProfileBudget(metrics, options) {
  const report = evaluateLowProfileBudget(metrics, options);
  if (!report.ok) throw new PerformanceBudgetError(report);
  return report;
}
