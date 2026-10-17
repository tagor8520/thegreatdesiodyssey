import { featureNamespace } from './FeatureVersions.js';
import {
  GDO_PLANT_FAMILY_RECIPES,
  GDO_PLANT_GRAMMAR_NAMESPACE,
  GDO_PLANT_ORGANS,
  GDO_PLANT_PROFILES,
  acquirePlantArchetypeLibrary,
  plantSkeletonFingerprint,
} from './PlantGrammar.js';
import {
  GDO_PLANT_GEOMETRY_PROFILES,
  compilePlantGeometry,
  plantGeometryFingerprint,
} from './PlantGeometryCompiler.js';

const EPSILON = 1e-8;
const MEBIBYTE = 1024 * 1024;
const LOD_NAMES = Object.freeze(['near', 'mid', 'far']);
const SELECTABLE_LODS = Object.freeze(['near', 'mid', 'far', 'beyond']);
const LOD_INDEX = Object.freeze({ near: 0, mid: 1, far: 2, beyond: 3 });
const MAX_STABLE_ID_LENGTH = 160;

export const GDO_PLANT_LOD_NAMESPACE = featureNamespace('vegetationLod');
export const GDO_MAX_ACTIVE_PLANT_LOD_LIBRARIES = 8;

export const GDO_PLANT_LOD_PROFILES = Object.freeze({
  low: Object.freeze({
    projectedPixels: Object.freeze({ near: 96, mid: 32, far: 6 }),
    hysteresis: .18,
    maxReevaluationsHz: 4,
    movementThreshold: .5,
    distanceThreshold: .5,
    focusCellSize: 4,
    scheduleSlots: 8,
    minimumFeaturePixels: .75,
    maxEntries: 5_360,
    maxCachedSets: 16,
    maxCachedGeometries: 48,
    maxCachedBytes: 1.5 * MEBIBYTE,
  }),
  balanced: Object.freeze({
    projectedPixels: Object.freeze({ near: 80, mid: 24, far: 4 }),
    hysteresis: .17,
    maxReevaluationsHz: 6,
    movementThreshold: .35,
    distanceThreshold: .35,
    focusCellSize: 4,
    scheduleSlots: 8,
    minimumFeaturePixels: .65,
    maxEntries: 5_360,
    maxCachedSets: 26,
    maxCachedGeometries: 80,
    maxCachedBytes: 3 * MEBIBYTE,
  }),
  high: Object.freeze({
    projectedPixels: Object.freeze({ near: 64, mid: 18, far: 3 }),
    hysteresis: .15,
    maxReevaluationsHz: 10,
    movementThreshold: .25,
    distanceThreshold: .25,
    focusCellSize: 4,
    scheduleSlots: 8,
    minimumFeaturePixels: .5,
    maxEntries: 6_700,
    maxCachedSets: 42,
    maxCachedGeometries: 126,
    maxCachedBytes: 6 * MEBIBYTE,
  }),
});

const BASE_FAMILY_CAPS = Object.freeze({
  broadleaf: Object.freeze({ near: 28, mid: 12, far: 3, nearClusters: 5, midClusters: 4, farMasses: 2, farSegments: 1 }),
  palm: Object.freeze({ near: 24, mid: 10, far: 3, nearClusters: 4, midClusters: 4, farMasses: 2, farSegments: 1 }),
  shrub: Object.freeze({ near: 12, mid: 6, far: 2, nearClusters: 4, midClusters: 3, farMasses: 1, farSegments: 1 }),
  herb: Object.freeze({ near: 8, mid: 4, far: 1, nearClusters: 2, midClusters: 2, farMasses: 1, farSegments: 0 }),
  grass: Object.freeze({ near: 5, mid: 2, far: 1, nearClusters: 0, midClusters: 0, farMasses: 1, farSegments: 0 }),
  bamboo: Object.freeze({ near: 20, mid: 8, far: 3, nearClusters: 3, midClusters: 3, farMasses: 1, farSegments: 2 }),
});

const LOW_NEAR_CAPS = Object.freeze({ broadleaf: 18, palm: 16, shrub: 8, herb: 5, grass: 3, bamboo: 12 });

export const GDO_PLANT_LOD_FAMILY_CAPS = Object.freeze(Object.fromEntries(
  Object.entries(BASE_FAMILY_CAPS).map(([family, values]) => [family, Object.freeze({
    low: Object.freeze({ near: LOW_NEAR_CAPS[family], mid: values.mid, far: values.far }),
    balanced: Object.freeze({ near: values.near, mid: values.mid, far: values.far }),
    high: Object.freeze({ near: values.near, mid: values.mid, far: values.far }),
    nearClusters: values.nearClusters,
    midClusters: values.midClusters,
    farMasses: values.farMasses,
    farSegments: values.farSegments,
  })]),
));

const STRUCTURAL_PRIORITY = Object.freeze({
  [GDO_PLANT_ORGANS.TRUNK]: 3,
  [GDO_PLANT_ORGANS.CULM]: 3,
  [GDO_PLANT_ORGANS.STEM]: 3,
  [GDO_PLANT_ORGANS.BRANCH]: 2,
  [GDO_PLANT_ORGANS.FROND]: 2,
  [GDO_PLANT_ORGANS.BLADE]: 2,
  [GDO_PLANT_ORGANS.ROOT]: 1.9,
  [GDO_PLANT_ORGANS.LEAF]: 1,
  [GDO_PLANT_ORGANS.FLOWER]: 1,
});

const PALETTE_BY_ORGAN = Object.freeze({
  [GDO_PLANT_ORGANS.TRUNK]: 0,
  [GDO_PLANT_ORGANS.BRANCH]: 0,
  [GDO_PLANT_ORGANS.ROOT]: 1,
  [GDO_PLANT_ORGANS.STEM]: 2,
  [GDO_PLANT_ORGANS.CULM]: 3,
  [GDO_PLANT_ORGANS.FROND]: 4,
  [GDO_PLANT_ORGANS.BLADE]: 5,
  [GDO_PLANT_ORGANS.LEAF]: 6,
  [GDO_PLANT_ORGANS.FLOWER]: 7,
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteVector(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function squaredDistance(first, second) {
  const x = first[0] - second[0], y = first[1] - second[1], z = first[2] - second[2];
  return x * x + y * y + z * z;
}

function freezeVector(values) {
  return Object.freeze([...values]);
}

function validateSourceSkeleton(skeleton) {
  if (!skeleton || skeleton.namespace !== GDO_PLANT_GRAMMAR_NAMESPACE ||
      !GDO_PLANT_FAMILY_RECIPES[skeleton.family] || !GDO_PLANT_LOD_PROFILES[skeleton.profile] ||
      !Array.isArray(skeleton.nodes) || !skeleton.nodes.length || !Array.isArray(skeleton.clusters) ||
      !finiteVector(skeleton.pivot) || !skeleton.bounds || !finiteVector(skeleton.bounds.min) ||
      !finiteVector(skeleton.bounds.max) || !finiteVector(skeleton.bounds.size)) {
    throw new TypeError('LOD compilation requires a version-compatible PlantSkeleton');
  }
  return GDO_PLANT_LOD_PROFILES[skeleton.profile];
}

function structuralScore(node, skeleton) {
  const height = clamp((node.position[1] - skeleton.bounds.min[1]) /
    Math.max(EPSILON, skeleton.bounds.size[1]), 0, 1);
  return (STRUCTURAL_PRIORITY[node.organ] ?? 0) * 100 + node.lodImportance * 10 + height;
}

function selectStructuralNodes(skeleton, budget) {
  if (budget <= 0) return new Set();
  const candidates = skeleton.nodes.slice(1).sort((first, second) =>
    structuralScore(second, skeleton) - structuralScore(first, skeleton) || first.id - second.id);
  const selected = new Set();
  for (const candidate of candidates) {
    if (selected.has(candidate.id)) continue;
    const chain = [];
    let current = candidate;
    while (current && current.id !== 0 && !selected.has(current.id)) {
      chain.push(current.id);
      current = skeleton.nodes[current.parent];
    }
    if (selected.size + chain.length > budget) continue;
    for (let index = chain.length - 1; index >= 0; index--) selected.add(chain[index]);
    if (selected.size === budget) break;
  }
  return selected;
}

function clusterBaseScore(cluster, skeleton) {
  const volume = cluster.extent[0] * cluster.extent[1] * cluster.extent[2] * 8;
  const height = clamp((cluster.center[1] - skeleton.bounds.min[1]) /
    Math.max(EPSILON, skeleton.bounds.size[1]), 0, 1);
  return cluster.lodImportance * 10 + volume + height;
}

function selectDistributedClusters(skeleton, count) {
  if (count <= 0 || !skeleton.clusters.length) return [];
  const remaining = new Set(skeleton.clusters.map(cluster => cluster.id));
  const selected = [];
  while (selected.length < count && remaining.size) {
    let best = null, bestScore = -Infinity;
    for (const id of remaining) {
      const cluster = skeleton.clusters[id];
      const coverage = selected.length
        ? Math.min(...selected.map(chosen => squaredDistance(cluster.center, chosen.center))) /
          Math.max(EPSILON, skeleton.bounds.size[0] ** 2 + skeleton.bounds.size[1] ** 2 + skeleton.bounds.size[2] ** 2)
        : 0;
      const score = clusterBaseScore(cluster, skeleton) + coverage * 24;
      if (score > bestScore + EPSILON || (Math.abs(score - bestScore) <= EPSILON && cluster.id < best.id)) {
        best = cluster;
        bestScore = score;
      }
    }
    selected.push(best);
    remaining.delete(best.id);
  }
  return selected.sort((first, second) => first.id - second.id);
}

function nearestSelectedAncestor(skeleton, sourceNodeId, selected, idMap) {
  let node = skeleton.nodes[sourceNodeId];
  while (node && node.id !== 0 && !selected.has(node.id)) node = skeleton.nodes[node.parent];
  return node?.id === 0 ? 0 : (idMap.get(node.id) ?? 0);
}

function deriveSubsetSkeleton(skeleton, lod, boxCap, clusterTarget) {
  const selectedClusters = selectDistributedClusters(skeleton, Math.min(clusterTarget, boxCap));
  const segmentBudget = Math.max(0, boxCap - selectedClusters.length);
  const selectedNodes = selectStructuralNodes(skeleton, segmentBudget);
  const sourceIds = [...selectedNodes].sort((a, b) => a - b);
  const idMap = new Map([[0, 0]]);
  const nodes = [Object.freeze({ ...skeleton.nodes[0], id: 0, parent: -1 })];
  for (const sourceId of sourceIds) {
    const source = skeleton.nodes[sourceId];
    const id = nodes.length;
    idMap.set(sourceId, id);
    nodes.push(Object.freeze({ ...source, id, parent: idMap.get(source.parent) ?? 0 }));
  }
  const clusters = selectedClusters.map((source, id) => Object.freeze({
    ...source,
    id,
    node: nearestSelectedAncestor(skeleton, source.node, selectedNodes, idMap),
  }));
  const roots = skeleton.roots
    .filter(sourceId => selectedNodes.has(sourceId))
    .map(sourceId => idMap.get(sourceId));
  return freezeDerivedSkeleton(skeleton, lod, nodes, clusters, roots, {
    selectedNodePaths: sourceIds.map(id => skeleton.nodes[id].path),
    selectedClusterPaths: selectedClusters.map(item => item.path),
    aggregatedMasses: 0,
  });
}

function farSegmentCandidates(skeleton) {
  const structural = skeleton.nodes.slice(1).filter(node =>
    node.organ === GDO_PLANT_ORGANS.TRUNK || node.organ === GDO_PLANT_ORGANS.CULM ||
    node.organ === GDO_PLANT_ORGANS.STEM || node.organ === GDO_PLANT_ORGANS.BLADE);
  return structural.sort((first, second) =>
    second.position[1] - first.position[1] || structuralScore(second, skeleton) - structuralScore(first, skeleton) ||
    first.id - second.id);
}

function chooseFarEndpoints(skeleton, count) {
  const candidates = farSegmentCandidates(skeleton);
  if (!count || !candidates.length) return [];
  const selected = [];
  for (const candidate of candidates) {
    const firstAncestor = (() => {
      let node = candidate;
      while (node.parent > 0) node = skeleton.nodes[node.parent];
      return node.id;
    })();
    if (selected.some(item => item.firstAncestor === firstAncestor)) continue;
    selected.push({ node: candidate, firstAncestor });
    if (selected.length === count) break;
  }
  for (const candidate of candidates) {
    if (selected.length === count) break;
    if (!selected.some(item => item.node.id === candidate.id)) selected.push({ node: candidate, firstAncestor: candidate.id });
  }
  return selected.map(item => item.node);
}

function clusterMassItems(skeleton) {
  if (skeleton.clusters.length) return skeleton.clusters.map(cluster => ({
    id: cluster.id,
    path: cluster.path,
    center: cluster.center,
    min: cluster.center.map((value, axis) => value - cluster.extent[axis]),
    max: cluster.center.map((value, axis) => value + cluster.extent[axis]),
    paletteSlot: cluster.paletteSlot,
    organ: cluster.organ,
    lodImportance: cluster.lodImportance,
  }));
  return skeleton.nodes.slice(1).map(node => {
    const parent = skeleton.nodes[node.parent];
    const radius = Math.max(node.radius, parent?.radius ?? node.radius);
    const minimum = node.position.map((value, axis) => Math.min(value, parent?.position[axis] ?? value) - radius);
    const maximum = node.position.map((value, axis) => Math.max(value, parent?.position[axis] ?? value) + radius);
    return {
      id: node.id,
      path: node.path,
      center: minimum.map((value, axis) => (value + maximum[axis]) * .5),
      min: minimum,
      max: maximum,
      paletteSlot: PALETTE_BY_ORGAN[node.organ] ?? 0,
      organ: node.organ,
      lodImportance: node.lodImportance,
    };
  });
}

function distributedSeeds(items, count, bounds) {
  const selected = [];
  const remaining = new Set(items.map((_, index) => index));
  const diagonalSquared = Math.max(EPSILON, bounds.size[0] ** 2 + bounds.size[1] ** 2 + bounds.size[2] ** 2);
  while (selected.length < count && remaining.size) {
    let bestIndex = -1, bestScore = -Infinity;
    for (const index of remaining) {
      const item = items[index];
      const coverage = selected.length
        ? Math.min(...selected.map(chosen => squaredDistance(item.center, items[chosen].center))) / diagonalSquared
        : clamp((item.center[1] - bounds.min[1]) / Math.max(EPSILON, bounds.size[1]), 0, 1);
      const score = item.lodImportance * 10 + coverage * 24;
      if (score > bestScore + EPSILON || (Math.abs(score - bestScore) <= EPSILON && item.id < items[bestIndex]?.id)) {
        bestIndex = index;
        bestScore = score;
      }
    }
    selected.push(bestIndex);
    remaining.delete(bestIndex);
  }
  return selected;
}

function aggregateFarMasses(skeleton, count, nodes, minimumHalfExtent) {
  const items = clusterMassItems(skeleton);
  if (!count || !items.length) return [];
  const seeds = distributedSeeds(items, Math.min(count, items.length), skeleton.bounds);
  const groups = seeds.map(seed => ({ seed, items: [] }));
  for (let index = 0; index < items.length; index++) {
    let nearest = 0, nearestDistance = Infinity;
    for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
      const distance = squaredDistance(items[index].center, items[seeds[seedIndex]].center);
      if (distance < nearestDistance - EPSILON) { nearest = seedIndex; nearestDistance = distance; }
    }
    groups[nearest].items.push(items[index]);
  }
  return groups.map((group, id) => {
    const seed = items[group.seed];
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
    for (const item of group.items) for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], item.min[axis]);
      maximum[axis] = Math.max(maximum[axis], item.max[axis]);
    }
    const center = minimum.map((value, axis) => (value + maximum[axis]) * .5);
    const extent = minimum.map((value, axis) => Math.max(minimumHalfExtent, (maximum[axis] - value) * .5));
    let attachment = 0, nearest = Infinity;
    for (const node of nodes.slice(1)) {
      const distance = squaredDistance(center, node.position);
      if (distance < nearest) { attachment = node.id; nearest = distance; }
    }
    return Object.freeze({
      id,
      node: attachment,
      path: `lod/far/mass/${seed.path}`,
      center: freezeVector(center),
      extent: freezeVector(extent),
      paletteSlot: seed.paletteSlot,
      depth: 0,
      lodImportance: Math.max(...group.items.map(item => item.lodImportance)),
      organ: seed.organ,
      overlapRole: 'crown-union',
    });
  });
}

function deriveFarSkeleton(skeleton, profile, familyCaps) {
  const maxDimension = Math.max(...skeleton.bounds.size);
  const requiredFullWidth = maxDimension * profile.minimumFeaturePixels / profile.projectedPixels.far;
  const minimumRadius = requiredFullWidth / 1.4;
  const endpoints = chooseFarEndpoints(skeleton, familyCaps.farSegments);
  const base = Object.freeze({ ...skeleton.nodes[0], id: 0, parent: -1,
    radius: Math.max(skeleton.nodes[0].radius, minimumRadius) });
  const nodes = [base];
  for (const source of endpoints) {
    const delta = source.position.map((value, axis) => value - base.position[axis]);
    const length = Math.hypot(...delta);
    if (length <= EPSILON) continue;
    nodes.push(Object.freeze({
      ...source,
      id: nodes.length,
      parent: 0,
      depth: 0,
      path: `lod/far/segment/${source.path}`,
      direction: freezeVector(delta.map(value => value / length)),
      length,
      radius: Math.max(source.radius, minimumRadius),
      lodImportance: 1,
    }));
  }
  const masses = aggregateFarMasses(skeleton, familyCaps.farMasses, nodes, requiredFullWidth * .5);
  const cap = GDO_PLANT_LOD_FAMILY_CAPS[skeleton.family][skeleton.profile].far;
  const clusters = masses.slice(0, Math.max(0, cap - (nodes.length - 1))).map((mass, id) =>
    Object.freeze({ ...mass, id }));
  return freezeDerivedSkeleton(skeleton, 'far', nodes, clusters, [], {
    selectedNodePaths: endpoints.map(item => item.path),
    selectedClusterPaths: [],
    aggregatedMasses: clusters.length,
    minimumFeaturePixels: profile.minimumFeaturePixels,
    requiredFullWidth,
  });
}

function freezeDerivedSkeleton(source, lod, nodes, clusters, roots, selection) {
  const modules = nodes.length - 1 + clusters.length;
  return Object.freeze({
    namespace: source.namespace,
    recipeVersion: source.recipeVersion,
    family: source.family,
    label: source.label,
    profile: source.profile,
    archetypeIndex: source.archetypeIndex,
    environmentKey: source.environmentKey,
    seed: source.seed,
    unit: source.unit,
    pivot: source.pivot,
    envelope: source.envelope,
    nodes: Object.freeze(nodes),
    clusters: Object.freeze(clusters),
    roots: Object.freeze(roots),
    bounds: source.bounds,
    lod,
    diagnostics: Object.freeze({
      modules,
      nodes: nodes.length,
      clusters: clusters.length,
      sourceModules: source.nodes.length - 1 + source.clusters.length,
      selection: Object.freeze({
        ...selection,
        selectedNodePaths: Object.freeze(selection.selectedNodePaths ?? []),
        selectedClusterPaths: Object.freeze(selection.selectedClusterPaths ?? []),
      }),
    }),
  });
}

function silhouetteRetention(sourceBounds, geometryBounds) {
  const sourceWidth = Math.max(sourceBounds.size[0], sourceBounds.size[2]);
  const geometryWidth = Math.max(geometryBounds.size[0], geometryBounds.size[2]);
  return Object.freeze({
    width: sourceWidth > EPSILON ? clamp(geometryWidth / sourceWidth, 0, 2) : 1,
    height: sourceBounds.size[1] > EPSILON ? clamp(geometryBounds.size[1] / sourceBounds.size[1], 0, 2) : 1,
  });
}

/** Compile stable near/mid/far geometry from one immutable keyed skeleton. */
export function compilePlantLodSet(skeleton) {
  const profile = validateSourceSkeleton(skeleton);
  const familyCaps = GDO_PLANT_LOD_FAMILY_CAPS[skeleton.family];
  const caps = familyCaps[skeleton.profile];
  const derived = Object.freeze({
    near: deriveSubsetSkeleton(skeleton, 'near', caps.near, familyCaps.nearClusters),
    mid: deriveSubsetSkeleton(skeleton, 'mid', caps.mid, familyCaps.midClusters),
    far: deriveFarSkeleton(skeleton, profile, familyCaps),
  });
  const geometries = Object.freeze(Object.fromEntries(LOD_NAMES.map(lod =>
    [lod, compilePlantGeometry(derived[lod])])));
  const levels = Object.freeze(Object.fromEntries(LOD_NAMES.map(lod => {
    const geometry = geometries[lod], lodSkeleton = derived[lod];
    if (geometry.diagnostics.boxesEmitted > caps[lod]) {
      throw new RangeError(`${skeleton.family} ${lod} LOD exceeded its ${caps[lod]}-box cap`);
    }
    return [lod, Object.freeze({
      boxCap: caps[lod],
      boxes: geometry.diagnostics.boxesEmitted,
      triangles: geometry.diagnostics.trianglesAfter,
      exposedFaces: geometry.diagnostics.exposedFaces,
      estimatedBytes: geometry.diagnostics.estimatedBytes,
      selectedNodePaths: lodSkeleton.diagnostics.selection.selectedNodePaths,
      selectedClusterPaths: lodSkeleton.diagnostics.selection.selectedClusterPaths,
      aggregatedMasses: lodSkeleton.diagnostics.selection.aggregatedMasses,
      minimumFeaturePixels: lodSkeleton.diagnostics.selection.minimumFeaturePixels ?? null,
      minimumFeatureWidth: lodSkeleton.diagnostics.selection.requiredFullWidth ?? null,
      silhouetteRetention: silhouetteRetention(skeleton.bounds, geometry.geometryBounds),
      fingerprint: plantGeometryFingerprint(geometry),
    })];
  })));
  if (!(levels.near.boxes >= levels.mid.boxes && levels.mid.boxes >= levels.far.boxes) ||
      !(levels.near.triangles >= levels.mid.triangles && levels.mid.triangles >= levels.far.triangles)) {
    throw new Error('Plant LOD complexity must decrease monotonically');
  }
  const estimatedBytes = LOD_NAMES.reduce((sum, lod) => sum + levels[lod].estimatedBytes, 0);
  return Object.freeze({
    namespace: GDO_PLANT_LOD_NAMESPACE,
    version: 1,
    sourceNamespace: skeleton.namespace,
    sourceFingerprint: plantSkeletonFingerprint(skeleton),
    family: skeleton.family,
    profile: skeleton.profile,
    archetypeIndex: skeleton.archetypeIndex,
    environmentKey: skeleton.environmentKey,
    pivot: skeleton.pivot,
    bounds: skeleton.bounds,
    envelope: skeleton.envelope,
    thresholds: profile.projectedPixels,
    hysteresis: profile.hysteresis,
    geometries,
    diagnostics: Object.freeze({
      levels,
      geometries: LOD_NAMES.length,
      estimatedBytes,
      maxReevaluationsHz: profile.maxReevaluationsHz,
      collisionProxies: 0,
      dualDrawLods: 0,
    }),
  });
}

function hashText(value, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function plantLodSetFingerprint(lodSet) {
  if (!lodSet || lodSet.namespace !== GDO_PLANT_LOD_NAMESPACE || !lodSet.geometries) {
    throw new TypeError('Invalid plant LOD set');
  }
  return hashText(JSON.stringify({
    namespace: lodSet.namespace,
    sourceFingerprint: lodSet.sourceFingerprint,
    family: lodSet.family,
    profile: lodSet.profile,
    archetypeIndex: lodSet.archetypeIndex,
    thresholds: lodSet.thresholds,
    hysteresis: lodSet.hysteresis,
    levels: LOD_NAMES.map(lod => plantGeometryFingerprint(lodSet.geometries[lod])),
  })).toString(16).padStart(8, '0');
}

function validateProjectionInput(boundsOrSet, placement, cameraPosition, verticalFovRadians, viewportHeight) {
  const bounds = boundsOrSet?.bounds ?? boundsOrSet;
  if (!bounds || !finiteVector(bounds.min) || !finiteVector(bounds.max) || !finiteVector(bounds.size)) {
    throw new TypeError('Projected plant LOD requires finite bounds');
  }
  if (!placement || !finiteVector(placement.position) || !finiteVector(placement.scale) || !Number.isFinite(placement.yaw)) {
    throw new TypeError('Projected plant LOD requires a finite placement transform');
  }
  if (!finiteVector(cameraPosition) || !Number.isFinite(verticalFovRadians) || verticalFovRadians <= 0 ||
      verticalFovRadians >= Math.PI || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    throw new TypeError('Projected plant LOD requires a finite perspective camera/viewport');
  }
  return bounds;
}

/** Allocation-free when the caller supplies `out`; accounts for both projected height and yawed width. */
export function projectPlantBounds(boundsOrSet, placement, cameraPosition, {
  verticalFovRadians,
  viewportHeight,
} = {}, out = {}) {
  const bounds = validateProjectionInput(boundsOrSet, placement, cameraPosition, verticalFovRadians, viewportHeight);
  const pivot = bounds.pivot ?? boundsOrSet.pivot ?? [0, 0, 0];
  const localCenterX = (bounds.min[0] + bounds.max[0]) * .5 - pivot[0];
  const localCenterY = (bounds.min[1] + bounds.max[1]) * .5 - pivot[1];
  const localCenterZ = (bounds.min[2] + bounds.max[2]) * .5 - pivot[2];
  const cosine = Math.cos(placement.yaw), sine = Math.sin(placement.yaw);
  const scaledCenterX = localCenterX * placement.scale[0];
  const scaledCenterZ = localCenterZ * placement.scale[2];
  const centerX = placement.position[0] + scaledCenterX * cosine - scaledCenterZ * sine;
  const centerY = placement.position[1] + localCenterY * placement.scale[1];
  const centerZ = placement.position[2] + scaledCenterX * sine + scaledCenterZ * cosine;
  const sizeX = Math.abs(bounds.size[0] * placement.scale[0]);
  const sizeY = Math.abs(bounds.size[1] * placement.scale[1]);
  const sizeZ = Math.abs(bounds.size[2] * placement.scale[2]);
  const widthX = Math.abs(cosine) * sizeX + Math.abs(sine) * sizeZ;
  const widthZ = Math.abs(sine) * sizeX + Math.abs(cosine) * sizeZ;
  const worldWidth = Math.max(widthX, widthZ);
  const distance = Math.max(EPSILON, Math.hypot(cameraPosition[0] - centerX,
    cameraPosition[1] - centerY, cameraPosition[2] - centerZ));
  const pixelsPerWorldUnit = viewportHeight / (2 * distance * Math.tan(verticalFovRadians * .5));
  out.centerX = centerX;
  out.centerY = centerY;
  out.centerZ = centerZ;
  out.distance = distance;
  out.heightPixels = sizeY * pixelsPerWorldUnit;
  out.widthPixels = worldWidth * pixelsPerWorldUnit;
  out.projectedPixels = Math.max(out.heightPixels, out.widthPixels);
  out.pixelsPerWorldUnit = pixelsPerWorldUnit;
  return out;
}

function rawLodForPixels(projectedPixels, thresholds) {
  if (projectedPixels >= thresholds.near) return 'near';
  if (projectedPixels >= thresholds.mid) return 'mid';
  if (projectedPixels >= thresholds.far) return 'far';
  return 'beyond';
}

/** Select exactly one LOD. The 15–20% dead band prevents boundary chatter. */
export function selectPlantLod(projectedPixels, {
  profile = 'low',
  currentLod = null,
} = {}, out = {}) {
  const policy = GDO_PLANT_LOD_PROFILES[profile];
  if (!policy) throw new RangeError(`Unknown plant profile: ${profile}`);
  if (!Number.isFinite(projectedPixels) || projectedPixels < 0) throw new TypeError('Projected plant size must be finite and non-negative');
  if (currentLod != null && !SELECTABLE_LODS.includes(currentLod)) throw new RangeError(`Unknown plant LOD: ${currentLod}`);
  const rawLod = rawLodForPixels(projectedPixels, policy.projectedPixels);
  let lod = currentLod ?? rawLod;
  if (currentLod != null) {
    let index = LOD_INDEX[currentLod];
    const rawIndex = LOD_INDEX[rawLod];
    if (rawIndex < index) {
      while (index > rawIndex) {
        const candidate = SELECTABLE_LODS[index - 1];
        const boundary = policy.projectedPixels[candidate];
        if (projectedPixels < boundary * (1 + policy.hysteresis)) break;
        index--;
      }
    } else if (rawIndex > index) {
      while (index < rawIndex) {
        const boundaryName = SELECTABLE_LODS[index];
        const boundary = policy.projectedPixels[boundaryName];
        if (projectedPixels >= boundary * (1 - policy.hysteresis)) break;
        index++;
      }
    }
    lod = SELECTABLE_LODS[index];
  }
  out.lod = lod;
  out.rawLod = rawLod;
  out.projectedPixels = projectedPixels;
  out.hysteresisHeld = lod !== rawLod;
  out.crossfade = false;
  return out;
}

export function plantLodScheduleSlot(stableId, slots = 8) {
  if (typeof stableId !== 'string' || !stableId || stableId.length > MAX_STABLE_ID_LENGTH) {
    throw new RangeError('Plant LOD stable ID must be a bounded string');
  }
  if (!Number.isInteger(slots) || slots < 1 || slots > 64) throw new RangeError('Plant LOD schedule slots must be 1–64');
  return hashText(stableId) % slots;
}

/** Capped, owner-aware selection state. Supplying an output object avoids steady-state allocation. */
export class PlantLodSelector {
  constructor({ profile = 'low', maxEntries } = {}) {
    const policy = GDO_PLANT_LOD_PROFILES[profile];
    if (!policy) throw new RangeError(`Unknown plant profile: ${profile}`);
    const requestedEntries = maxEntries ?? policy.maxEntries;
    if (!Number.isInteger(requestedEntries) || requestedEntries < 1 || requestedEntries > policy.maxEntries) {
      throw new RangeError(`Plant LOD entries must be 1–${policy.maxEntries}`);
    }
    this.profile = profile;
    this.policy = policy;
    this.maxEntries = requestedEntries;
    this.states = new Map();
    this.disposed = false;
    this.evaluations = 0;
    this.switches = 0;
    this.hysteresisHolds = 0;
    this.intervalSkips = 0;
    this.motionSkips = 0;
    this.byLod = { near: 0, mid: 0, far: 0, beyond: 0 };
    this.projectionScratch = {};
    this.projectionOptions = { verticalFovRadians: 0, viewportHeight: 0 };
    this.selectionScratch = {};
    this.selectionOptions = { profile, currentLod: null };
    const selector = this;
    this.diagnostics = Object.freeze({
      namespace: GDO_PLANT_LOD_NAMESPACE,
      profile,
      get entries() { return selector.states.size; },
      get evaluations() { return selector.evaluations; },
      get switches() { return selector.switches; },
      get hysteresisHolds() { return selector.hysteresisHolds; },
      get intervalSkips() { return selector.intervalSkips; },
      get motionSkips() { return selector.motionSkips; },
      get byLod() { return Object.freeze({ ...selector.byLod }); },
      get disposed() { return selector.disposed; },
      limits: Object.freeze({ maxEntries: requestedEntries, maxReevaluationsHz: policy.maxReevaluationsHz }),
    });
  }

  evaluate({
    id,
    placement,
    lodSet,
    cameraPosition,
    verticalFovRadians,
    viewportHeight,
    nowMilliseconds,
    focusCellKey = null,
    force = false,
  } = {}, out = {}) {
    if (this.disposed) throw new Error('Plant LOD selector is disposed');
    if (!lodSet || lodSet.namespace !== GDO_PLANT_LOD_NAMESPACE || lodSet.profile !== this.profile) {
      throw new TypeError('Plant LOD selector requires a compatible LOD set');
    }
    if (!placement || typeof placement.owner !== 'string' || !placement.owner) throw new TypeError('Plant LOD placement requires an owner');
    if (!finiteVector(cameraPosition)) throw new TypeError('Plant LOD selector requires a finite camera position');
    if (!Number.isFinite(nowMilliseconds) || nowMilliseconds < 0) throw new TypeError('Plant LOD time must be finite and non-negative');
    const slot = plantLodScheduleSlot(id, this.policy.scheduleSlots);
    let state = this.states.get(id);
    if (!state) {
      if (this.states.size >= this.maxEntries) throw new Error(`Plant LOD entry cap reached: ${this.maxEntries}`);
      state = {
        id,
        owner: placement.owner,
        sourceFingerprint: lodSet.sourceFingerprint,
        slot,
        lod: null,
        source: '',
        projectedPixels: 0,
        distance: Infinity,
        centerX: 0,
        centerY: 0,
        centerZ: 0,
        lastCameraX: Infinity,
        lastCameraY: Infinity,
        lastCameraZ: Infinity,
        focusCellKey: null,
        nextEvaluationAt: 0,
        scheduled: false,
      };
      this.states.set(id, state);
    } else if (state.owner !== placement.owner || state.sourceFingerprint !== lodSet.sourceFingerprint) {
      throw new Error('Plant LOD stable ID cannot change owner or archetype source');
    }
    const resolvedFocusCell = focusCellKey ?? ((Math.floor(cameraPosition[0] / this.policy.focusCellSize) * 73856093) ^
      (Math.floor(cameraPosition[2] / this.policy.focusCellSize) * 19349663));
    if (!force && state.lod && nowMilliseconds < state.nextEvaluationAt && state.focusCellKey === resolvedFocusCell) {
      this.intervalSkips++;
      return this.#writeResult(state, lodSet, false, out);
    }
    this.projectionOptions.verticalFovRadians = verticalFovRadians;
    this.projectionOptions.viewportHeight = viewportHeight;
    const projection = projectPlantBounds(lodSet, placement, cameraPosition,
      this.projectionOptions, this.projectionScratch);
    const cameraMovementSquared = (cameraPosition[0] - state.lastCameraX) ** 2 +
      (cameraPosition[1] - state.lastCameraY) ** 2 + (cameraPosition[2] - state.lastCameraZ) ** 2;
    const meaningful = force || !state.lod || state.focusCellKey !== resolvedFocusCell ||
      cameraMovementSquared >= this.policy.movementThreshold ** 2 ||
      Math.abs(projection.distance - state.distance) >= this.policy.distanceThreshold;
    const interval = 1000 / this.policy.maxReevaluationsHz;
    if (!meaningful) {
      this.motionSkips++;
      state.nextEvaluationAt = nowMilliseconds + interval;
      return this.#writeResult(state, lodSet, false, out);
    }
    const previous = state.lod;
    this.selectionOptions.currentLod = previous;
    const selection = selectPlantLod(projection.projectedPixels,
      this.selectionOptions, this.selectionScratch);
    if (previous) this.byLod[previous]--;
    state.lod = selection.lod;
    if (previous !== state.lod) state.source = `${lodSet.family}:${lodSet.archetypeIndex}:${state.lod}`;
    this.byLod[state.lod]++;
    if (previous && previous !== state.lod) this.switches++;
    if (selection.hysteresisHeld) this.hysteresisHolds++;
    this.evaluations++;
    state.projectedPixels = projection.projectedPixels;
    state.distance = projection.distance;
    state.centerX = projection.centerX;
    state.centerY = projection.centerY;
    state.centerZ = projection.centerZ;
    state.lastCameraX = cameraPosition[0];
    state.lastCameraY = cameraPosition[1];
    state.lastCameraZ = cameraPosition[2];
    state.focusCellKey = resolvedFocusCell;
    state.nextEvaluationAt = nowMilliseconds + interval + (state.scheduled ? 0 : slot / this.policy.scheduleSlots * interval);
    state.scheduled = true;
    return this.#writeResult(state, lodSet, true, out);
  }

  #writeResult(state, lodSet, evaluated, out) {
    out.id = state.id;
    out.owner = state.owner;
    out.lod = state.lod;
    out.geometry = state.lod === 'beyond' ? null : lodSet.geometries[state.lod];
    out.source = state.source;
    out.projectedPixels = state.projectedPixels;
    out.distance = state.distance;
    out.nextEvaluationAt = state.nextEvaluationAt;
    out.scheduleSlot = state.slot;
    out.evaluated = evaluated;
    out.crossfade = false;
    return out;
  }

  remove(id) {
    if (this.disposed) return false;
    const state = this.states.get(id);
    if (!state) return false;
    if (state.lod) this.byLod[state.lod]--;
    this.states.delete(id);
    return true;
  }

  clear() {
    if (this.disposed) return;
    this.states.clear();
    for (const lod of SELECTABLE_LODS) this.byLod[lod] = 0;
  }

  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.projectionScratch = null;
    this.projectionOptions = null;
    this.selectionScratch = null;
    this.selectionOptions = null;
  }
}

const lodLibraryRecords = new Map();

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function profileCacheStats(profileName) {
  const records = [...lodLibraryRecords.values()].filter(record => record.library.profile === profileName);
  return {
    sets: records.reduce((sum, record) => sum + record.library.diagnostics.cachedSets, 0),
    geometries: records.reduce((sum, record) => sum + record.library.diagnostics.cachedGeometries, 0),
    bytes: records.reduce((sum, record) => sum + record.library.diagnostics.estimatedBytes, 0),
  };
}

function createPlantLodLibrary(profileName, environmentKey, seedSalt) {
  const profile = GDO_PLANT_LOD_PROFILES[profileName];
  const skeletonHandle = acquirePlantArchetypeLibrary({ profile: profileName, environmentKey, seedSalt });
  const sets = new Map();
  let disposed = false, hits = 0, misses = 0, totalCompileMilliseconds = 0, maximumCompileMilliseconds = 0;
  const getLodSet = (family, archetypeIndex = 0) => {
    if (disposed) throw new Error('Plant LOD library is disposed');
    if (!GDO_PLANT_FAMILY_RECIPES[family]) throw new RangeError(`Unknown plant family: ${family}`);
    if (!Number.isInteger(archetypeIndex) || archetypeIndex < 0 || archetypeIndex >= GDO_PLANT_PROFILES[profileName].variantsPerFamily) {
      throw new RangeError(`${profileName} supports archetype indices 0–${GDO_PLANT_PROFILES[profileName].variantsPerFamily - 1}`);
    }
    const key = `${family}:${archetypeIndex}`;
    const cached = sets.get(key);
    if (cached) { hits++; return cached; }
    const stats = profileCacheStats(profileName);
    if (stats.sets >= profile.maxCachedSets || stats.geometries + 3 > profile.maxCachedGeometries) {
      throw new Error(`Plant LOD cache cap reached for ${profileName}`);
    }
    const skeleton = skeletonHandle.library.getArchetype(family, archetypeIndex);
    const started = now();
    const lodSet = compilePlantLodSet(skeleton);
    const elapsed = now() - started;
    if (stats.bytes + lodSet.diagnostics.estimatedBytes > profile.maxCachedBytes) {
      throw new Error(`Plant LOD byte cap reached: ${profile.maxCachedBytes}`);
    }
    sets.set(key, lodSet);
    misses++;
    totalCompileMilliseconds += elapsed;
    maximumCompileMilliseconds = Math.max(maximumCompileMilliseconds, elapsed);
    return lodSet;
  };
  const diagnostics = Object.freeze({
    namespace: GDO_PLANT_LOD_NAMESPACE,
    profile: profileName,
    environmentKey,
    get cachedSets() { return sets.size; },
    get cachedGeometries() { return sets.size * 3; },
    get hits() { return hits; },
    get misses() { return misses; },
    get estimatedBytes() { return [...sets.values()].reduce((sum, item) => sum + item.diagnostics.estimatedBytes, 0); },
    get totalCompileMilliseconds() { return totalCompileMilliseconds; },
    get maximumCompileMilliseconds() { return maximumCompileMilliseconds; },
    get nearTriangles() { return [...sets.values()].reduce((sum, item) => sum + item.diagnostics.levels.near.triangles, 0); },
    get midTriangles() { return [...sets.values()].reduce((sum, item) => sum + item.diagnostics.levels.mid.triangles, 0); },
    get farTriangles() { return [...sets.values()].reduce((sum, item) => sum + item.diagnostics.levels.far.triangles, 0); },
    get maximumNearBoxes() { return Math.max(0, ...[...sets.values()].map(item => item.diagnostics.levels.near.boxes)); },
    get maximumMidBoxes() { return Math.max(0, ...[...sets.values()].map(item => item.diagnostics.levels.mid.boxes)); },
    get maximumFarBoxes() { return Math.max(0, ...[...sets.values()].map(item => item.diagnostics.levels.far.boxes)); },
    get disposed() { return disposed; },
    limits: profile,
  });
  return Object.freeze({
    profile: profileName,
    environmentKey,
    variantsPerFamily: GDO_PLANT_PROFILES[profileName].variantsPerFamily,
    families: Object.freeze(Object.keys(GDO_PLANT_FAMILY_RECIPES)),
    diagnostics,
    getLodSet,
    getForPlacement(record) {
      if (!record || !GDO_PLANT_FAMILY_RECIPES[record.family]) throw new TypeError('Invalid plant placement record');
      return getLodSet(record.family, record.archetypeIndex % GDO_PLANT_PROFILES[profileName].variantsPerFamily);
    },
    clear() {
      if (disposed) return;
      sets.clear();
      skeletonHandle.release();
      disposed = true;
    },
  });
}

export function acquirePlantLodLibrary({
  profile = 'low',
  environmentKey = 'default',
  seedSalt = 0,
} = {}) {
  if (!GDO_PLANT_LOD_PROFILES[profile]) throw new RangeError(`Unknown plant profile: ${profile}`);
  if (typeof environmentKey !== 'string' || !environmentKey || environmentKey.length > 64) throw new RangeError('Invalid environment key');
  if (!Number.isInteger(seedSalt)) throw new RangeError('Plant seed salt must be an integer');
  const key = `${GDO_PLANT_LOD_NAMESPACE}:${profile}:${environmentKey}:${seedSalt}`;
  let record = lodLibraryRecords.get(key);
  if (!record) {
    if (lodLibraryRecords.size >= GDO_MAX_ACTIVE_PLANT_LOD_LIBRARIES) {
      throw new Error(`Active plant-LOD-library cap reached: ${GDO_MAX_ACTIVE_PLANT_LOD_LIBRARIES}`);
    }
    record = { library: createPlantLodLibrary(profile, environmentKey, seedSalt), references: 0 };
    lodLibraryRecords.set(key, record);
  }
  record.references++;
  let released = false;
  return Object.freeze({
    library: record.library,
    release() {
      if (released) return;
      released = true;
      record.references = Math.max(0, record.references - 1);
      if (record.references === 0) {
        record.library.clear();
        lodLibraryRecords.delete(key);
      }
    },
  });
}

export function plantLodLibraryStats() {
  return Object.freeze({
    libraries: lodLibraryRecords.size,
    references: [...lodLibraryRecords.values()].reduce((sum, record) => sum + record.references, 0),
    cachedSets: [...lodLibraryRecords.values()].reduce((sum, record) => sum + record.library.diagnostics.cachedSets, 0),
    cachedGeometries: [...lodLibraryRecords.values()].reduce((sum, record) => sum + record.library.diagnostics.cachedGeometries, 0),
    estimatedBytes: [...lodLibraryRecords.values()].reduce((sum, record) => sum + record.library.diagnostics.estimatedBytes, 0),
  });
}
