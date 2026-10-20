import { featureNamespace, GDO_FEATURE_VERSIONS } from './FeatureVersions.js';
import { GDO_PLANT_GEOMETRY_PROFILES } from './PlantGeometryCompiler.js';
import {
  GDO_PLANT_FAMILY_RECIPES,
  GDO_PLANT_GRAMMAR_NAMESPACE,
  GDO_PLANT_ORGANS,
  GDO_PLANT_PHASE_GROUPS,
  GDO_PLANT_PROFILES,
  plantKeyedValue,
} from './PlantGrammar.js';

export const GDO_COLONIZATION_NAMESPACE = featureNamespace('plantColonization');

export const GDO_COLONIZATION_REFUSAL = Object.freeze({
  UNKNOWN_FAMILY: 'unknown-family',
  UNKNOWN_PROFILE: 'unknown-profile',
  BAD_ARCHETYPE: 'bad-archetype',
  PER_TREE_SEARCH: 'per-tree-search',
  CACHE_FULL: 'cache-full',
});

/**
 * `VEG-11`: the search budget is declared, not implied. Every loop has a hard
 * ceiling and any cut is counted with a name, so an archetype either fits the
 * budget or reports exactly which ceiling it hit.
 */
export const GDO_COLONIZATION_LIMITS = Object.freeze({
  attractors: 72,
  iterations: 40,
  nodes: 28,
  nearestTests: 120_000,
  growthPerStep: 2,
  influenceRadius: .62,
  killRadius: .26,
  stepLength: .34,
  smoothing: .32,
  minimumRadius: .012,
  clusterScale: .9,
  archetypes: 12,
});

const BASE_ORGAN = Object.freeze({
  grass: GDO_PLANT_ORGANS.CULM,
  herb: GDO_PLANT_ORGANS.STEM,
});
const CLUSTER_ORGAN = Object.freeze({
  grass: GDO_PLANT_ORGANS.BLADE,
  herb: GDO_PLANT_ORGANS.LEAF,
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalize(x, y, z) {
  const length = Math.hypot(x, y, z);
  if (!(length > 1e-9)) return [0, 1, 0];
  return [x / length, y / length, z / length];
}

function freezeVector(x, y, z) {
  return Object.freeze([x, y, z]);
}

/** The envelope rule the grammar uses, shared here so attractors and nodes obey it. */
function insideEnvelope(envelope, position, organ) {
  const radial = Math.hypot(position[0], position[2]);
  const minimumY = organ === GDO_PLANT_ORGANS.ROOT ? -envelope.rootDepth : 0;
  if (position[1] < minimumY - 1e-8 || position[1] > envelope.height + 1e-8) return false;
  if (radial > envelope.radius + 1e-8) return false;
  if ((envelope.shape === 'rounded' || envelope.shape === 'mound') &&
      organ !== GDO_PLANT_ORGANS.TRUNK && organ !== GDO_PLANT_ORGANS.STEM && organ !== GDO_PLANT_ORGANS.ROOT) {
    const normalizedY = clamp(position[1] / envelope.height, 0, 1);
    const crownFactor = envelope.shape === 'mound'
      ? .42 + Math.sin(normalizedY * Math.PI) * .68
      : .34 + Math.sin(normalizedY * Math.PI) * .82;
    return radial <= envelope.radius * crownFactor + 1e-8;
  }
  return true;
}

function resolveLimits(family, profile, requested = {}) {
  const recipe = GDO_PLANT_FAMILY_RECIPES[family];
  const geometry = GDO_PLANT_GEOMETRY_PROFILES[profile];
  const merged = { ...GDO_COLONIZATION_LIMITS, ...(requested ?? {}) };
  // Never exceed what the family's own furniture, or the geometry profile's
  // module cap, can actually carry: `modules = nodes - 1 + clusters`.
  return Object.freeze({
    ...merged,
    // Clusters are only ever placed on terminal tips, so they are budgeted at
    // adaptation time from what the geometry profile has left; nodes alone are
    // capped here.
    clusters: Math.max(1, Math.min(recipe.maxClusters, merged.clusters | 0 || recipe.maxClusters)),
    // Leave room at the tips for crowns: a trunk-and-branches-only archetype
    // would spend the whole module budget on wood.
    nodes: Math.max(2, Math.min(
      merged.nodes | 0,
      recipe.maxNodes,
      Math.max(2, geometry.maxBoxes - Math.min(4, recipe.maxClusters)),
    )),
    attractors: Math.max(4, merged.attractors | 0),
    iterations: Math.max(1, merged.iterations | 0),
    nearestTests: Math.max(1_000, merged.nearestTests | 0),
    growthPerStep: Math.max(1, merged.growthPerStep | 0),
  });
}

function attractorPoint(family, archetypeIndex, index, envelope, context, attempt) {
  const channel = attempt ? `attractor-${attempt}` : 'attractor';
  const u = plantKeyedValue(family, archetypeIndex, `attractor:${index}`, `${channel}:u`, context);
  const v = plantKeyedValue(family, archetypeIndex, `attractor:${index}`, `${channel}:v`, context);
  const w = plantKeyedValue(family, archetypeIndex, `attractor:${index}`, `${channel}:w`, context);
  const azimuth = u * Math.PI * 2;
  const radial = Math.sqrt(v) * envelope.radius;
  // Attractors live in the crown, above the lower trunk, and are pushed inward
  // where the envelope narrows — so growth reaches leaves, not empty air.
  const y = envelope.height * (.34 + w * .60);
  const normalizedY = clamp(y / envelope.height, 0, 1);
  const crownFactor = envelope.shape === 'mound'
    ? .42 + Math.sin(normalizedY * Math.PI) * .68
    : envelope.shape === 'rounded'
      ? .34 + Math.sin(normalizedY * Math.PI) * .82
      : 1;
  const localRadial = radial * crownFactor;
  return [
    Math.cos(azimuth) * localRadial,
    y,
    Math.sin(azimuth) * localRadial,
  ];
}

/**
 * Deterministic space colonization. Attraction points inside the family
 * envelope pull a branching structure out of a single root; the structure is
 * *authored once per archetype*, never per placed plant.
 */
export function colonizePlantArchetype({
  family,
  archetypeIndex = 0,
  profile = 'low',
  environmentKey = 'default',
  seedSalt = 0,
  limits: requestedLimits = {},
} = {}) {
  const recipe = GDO_PLANT_FAMILY_RECIPES[family];
  const profileRecipe = GDO_PLANT_PROFILES[profile];
  if (!recipe) throw new RangeError(`Unknown plant family: ${family}`);
  if (!profileRecipe) throw new RangeError(`Unknown plant profile: ${profile}`);
  if (!Number.isInteger(archetypeIndex) || archetypeIndex < 0 || archetypeIndex >= profileRecipe.variantsPerFamily) {
    throw new RangeError(`${profile} supports archetype indices 0–${profileRecipe.variantsPerFamily - 1}`);
  }
  if (typeof environmentKey !== 'string' || !environmentKey || environmentKey.length > 64) throw new RangeError('Invalid environment key');
  if (!Number.isInteger(seedSalt)) throw new RangeError('Plant seed salt must be an integer');
  const limits = resolveLimits(family, profile, requestedLimits);
  const envelope = recipe.envelope;
  const context = Object.freeze({ environmentKey, seedSalt });
  const diagnostics = {
    attractors: 0,
    rejectedAttractors: 0,
    iterations: 0,
    nearestTests: 0,
    growthSteps: 0,
    attractorsConsumed: 0,
    attractorsKilled: 0,
    rejectedEnvelope: 0,
    rejectedGrowth: 0,
    truncated: 0,
    truncationReason: 'none',
  };

  const truncate = reason => {
    if (diagnostics.truncationReason !== 'none') return;
    diagnostics.truncationReason = reason;
    diagnostics.truncated = 1;
  };

  // 1. Attractors, inside the envelope, with bounded rejection attempts.
  const attractors = [];
  for (let index = 0; index < limits.attractors; index++) {
    let placed = null;
    for (let attempt = 0; attempt < 4 && !placed; attempt++) {
      const point = attractorPoint(family, archetypeIndex, index, envelope, context, attempt);
      if (insideEnvelope(envelope, point, GDO_PLANT_ORGANS.LEAF)) placed = point;
      else diagnostics.rejectedAttractors++;
    }
    if (!placed) continue;
    attractors.push({ id: attractors.length, position: placed, alive: true });
  }
  diagnostics.attractors = attractors.length;

  // 2. One root, a declared trunk, then growth toward the surviving
  // attraction points. Trees need the trunk first or the crown is out of the
  // influence radius and nothing would grow — the search must start in reach.
  const baseOrgan = BASE_ORGAN[family] ?? GDO_PLANT_ORGANS.TRUNK;
  const nodes = [Object.freeze({
    id: 0,
    parent: -1,
    depth: 0,
    path: 'base',
    position: freezeVector(0, 0, 0),
    direction: freezeVector(0, 1, 0),
    length: 0,
    radius: recipe.trunkRadius,
    stiffness: 1,
    phaseGroup: 0,
    organ: baseOrgan,
    lodImportance: 1,
  })];
  const trunkSegments = Math.max(0, Math.min(recipe.trunkSegments | 0, limits.nodes - 2));
  const trunkShare = family === 'palm' || family === 'bamboo' ? .72 : family === 'grass' ? 0 : .46;
  const trunkShareLength = trunkSegments > 0 ? envelope.height * trunkShare / trunkSegments : 0;
  for (let segment = 0; segment < trunkSegments; segment++) {
    const parentNode = nodes[segment];
    const lean = (plantKeyedValue(family, archetypeIndex, `trunk:${segment}`, 'lean', context) - .5) * .10;
    const direction = normalize(lean, 1, lean * .8);
    const position = [
      parentNode.position[0] + direction[0] * trunkShareLength,
      parentNode.position[1] + direction[1] * trunkShareLength,
      parentNode.position[2] + direction[2] * trunkShareLength,
    ];
    if (!insideEnvelope(envelope, position, baseOrgan)) break;
    nodes.push(Object.freeze({
      id: nodes.length,
      parent: parentNode.id,
      depth: 0,
      path: `trunk:${segment}`,
      position: freezeVector(...position),
      direction: freezeVector(...direction),
      length: trunkShareLength,
      radius: Math.max(limits.minimumRadius, parentNode.radius * .86),
      stiffness: clamp(.94 - segment * .05, .6, 1),
      phaseGroup: 0,
      organ: baseOrgan,
      lodImportance: 1,
    }));
    diagnostics.growthSteps++;
  }
  const stepLength = clamp(limits.stepLength * recipe.branchLength, envelope.height * .04, envelope.height * .22);
  // Influence never shorter than a couple of steps, or a sparse crown would be
  // unreachable; it stays a declared function of the family's own proportions.
  const influenceRadius = Math.max(limits.influenceRadius, stepLength * 1.7);
  let alive = attractors.length;

  for (let iteration = 0; iteration < limits.iterations && alive > 0 && nodes.length < limits.nodes; iteration++) {
    diagnostics.iterations++;
    // Nearest node per attractor; kill anything already reached.
    const pull = nodes.map(() => [0, 0, 0, 0]);
    for (const attractor of attractors) {
      if (!attractor.alive) continue;
      let best = -1, bestDistance = Infinity;
      for (let index = 0; index < nodes.length; index++) {
        if (diagnostics.nearestTests >= limits.nearestTests) { truncate('test-cap'); break; }
        diagnostics.nearestTests++;
        const node = nodes[index];
        const dx = attractor.position[0] - node.position[0];
        const dy = attractor.position[1] - node.position[1];
        const dz = attractor.position[2] - node.position[2];
        const distance = Math.hypot(dx, dy, dz);
        if (distance < bestDistance) { bestDistance = distance; best = index; }
      }
      if (diagnostics.truncationReason === 'test-cap') break;
      if (best < 0) continue;
      if (bestDistance < limits.killRadius) {
        attractor.alive = false;
        alive--;
        diagnostics.attractorsKilled++;
        diagnostics.attractorsConsumed++;
        continue;
      }
      if (bestDistance > influenceRadius) continue;
      const node = nodes[best];
      const weight = 1 / Math.max(1e-4, bestDistance);
      pull[best][0] += (attractor.position[0] - node.position[0]) * weight;
      pull[best][1] += (attractor.position[1] - node.position[1]) * weight;
      pull[best][2] += (attractor.position[2] - node.position[2]) * weight;
      pull[best][3] += 1;
    }
    if (diagnostics.truncationReason === 'test-cap') break;

    // Grow from the strongest attractors first; ties break on node id, so the
    // order never depends on Map/Set or floating-point luck.
    const candidates = pull
      .map((values, index) => ({ index, count: values[3], values }))
      .filter(candidate => candidate.count > 0)
      .sort((first, second) => second.count - first.count || first.index - second.index)
      .slice(0, limits.growthPerStep);
    if (!candidates.length) { truncate('no-attraction'); break; }

    for (const candidate of candidates) {
      if (nodes.length >= limits.nodes) { truncate('node-cap'); break; }
      const parent = nodes[candidate.index];
      const values = candidate.values;
      const desired = normalize(values[0], values[1], values[2]);
      // Blend toward the parent so growth follows the branch it grew from.
      const direction = normalize(
        desired[0] + parent.direction[0] * limits.smoothing,
        desired[1] + parent.direction[1] * limits.smoothing,
        desired[2] + parent.direction[2] * limits.smoothing,
      );
      const position = [
        parent.position[0] + direction[0] * stepLength,
        parent.position[1] + direction[1] * stepLength,
        parent.position[2] + direction[2] * stepLength,
      ];
      const depth = Math.min(parent.depth + 1, recipe.maxDepth);
      const organ = depth === 0 ? baseOrgan : GDO_PLANT_ORGANS.BRANCH;
      if (!insideEnvelope(envelope, position, organ) || depth > recipe.maxDepth) {
        diagnostics.rejectedEnvelope++;
        continue;
      }
      const path = `colonized:${nodes.length}`;
      const id = nodes.length;
      nodes.push(Object.freeze({
        id,
        parent: parent.id,
        depth,
        path,
        position: freezeVector(...position),
        direction: freezeVector(...direction),
        length: stepLength,
        radius: Math.max(limits.minimumRadius, parent.radius * .82),
        stiffness: clamp(1 - depth * .24 - plantKeyedValue(family, archetypeIndex, path, 'bend', context) * .1, .16, 1),
        phaseGroup: Math.min(
          GDO_PLANT_PHASE_GROUPS - 1,
          Math.floor(plantKeyedValue(family, archetypeIndex, path, 'phase', context) * GDO_PLANT_PHASE_GROUPS),
        ),
        organ,
        lodImportance: clamp(1 - depth * .16, .2, 1),
      }));
      diagnostics.growthSteps++;
    }
    if (nodes.length >= limits.nodes && alive > 0) { truncate('node-cap'); break; }
    if (diagnostics.iterations >= limits.iterations && alive > 0) truncate('iteration-cap');
  }
  if (alive === 0) truncate('attractors-consumed');

  const seed = plantKeyedValue(family, archetypeIndex, 'colony', 'seed', context);
  return Object.freeze({
    namespace: GDO_COLONIZATION_NAMESPACE,
    recipeVersion: GDO_FEATURE_VERSIONS.plantColonization,
    family,
    archetypeIndex,
    profile,
    environmentKey,
    seedSalt,
    seed: Math.floor(seed * 4294967296) >>> 0,
    envelope,
    stepLength,
    influenceRadius,
    attractors: Object.freeze(attractors.map(attractor => Object.freeze({
      id: attractor.id,
      position: freezeVector(...attractor.position),
      reached: !attractor.alive,
    }))),
    nodes: Object.freeze(nodes),
    limits,
    diagnostics: Object.freeze({ ...diagnostics }),
  });
}

function skeletonBounds(nodes, clusters) {
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  const include = (position, extent) => {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], position[axis] - extent[axis]);
      maximum[axis] = Math.max(maximum[axis], position[axis] + extent[axis]);
    }
  };
  for (const node of nodes) include(node.position, [node.radius, node.radius, node.radius]);
  for (const cluster of clusters) include(cluster.center, cluster.extent);
  return Object.freeze({
    min: freezeVector(...minimum),
    max: freezeVector(...maximum),
    size: freezeVector(...minimum.map((value, axis) => maximum[axis] - value)),
    pivot: freezeVector(0, 0, 0),
  });
}

/**
 * Adapt a colony into the exact `PlantSkeleton` contract the geometry/LOD
 * compilers already consume — the colonized archetype is real furniture, not a
 * parallel representation.
 */
export function colonizedPlantSkeleton(colony) {
  if (!colony || colony.namespace !== GDO_COLONIZATION_NAMESPACE) {
    throw new TypeError('Colonized plant skeleton requires a colonized archetype');
  }
  const recipe = GDO_PLANT_FAMILY_RECIPES[colony.family];
  const envelope = recipe.envelope;
  const children = new Map();
  for (const node of colony.nodes) {
    if (node.parent < 0) continue;
    children.set(node.parent, (children.get(node.parent) ?? 0) + 1);
  }
  const geometry = GDO_PLANT_GEOMETRY_PROFILES[colony.profile] ?? GDO_PLANT_GEOMETRY_PROFILES.low;
  const clusterBudget = Math.max(0, Math.min(
    colony.limits.clusters,
    recipe.maxClusters,
    geometry.maxBoxes - (colony.nodes.length - 1),
  ));
  const clusters = [];
  let omitted = 0;
  for (const node of colony.nodes) {
    if (children.has(node.id)) continue;
    if (clusters.length >= clusterBudget) { omitted++; continue; }
    const scale = GDO_COLONIZATION_LIMITS.clusterScale * clamp(1 - node.depth * .12, .5, 1);
    const jitter = channel => plantKeyedValue(colony.family, colony.archetypeIndex, node.path, channel,
      { environmentKey: colony.environmentKey, seedSalt: colony.seedSalt });
    let center = [
      node.position[0] + (jitter('cluster-x') - .5) * .10 * scale,
      node.position[1] + jitter('cluster-y') * .08 * scale,
      node.position[2] + (jitter('cluster-z') - .5) * .10 * scale,
    ];
    let extent = [
      (.20 + jitter('cluster-width') * .14) * scale,
      (.15 + jitter('cluster-height') * .14) * scale,
      (.20 + jitter('cluster-depth') * .14) * scale,
    ];
    const radial = Math.hypot(center[0], center[2]);
    const radialRoom = Math.max(.02, envelope.radius - radial);
    const verticalRoom = Math.max(.02, Math.min(center[1] + envelope.rootDepth, envelope.height - center[1]));
    const extentScale = Math.min(1, radialRoom / Math.max(extent[0], extent[2]), verticalRoom / extent[1]);
    extent = extent.map(value => Math.max(.018, value * extentScale));
    center = [
      clamp(center[0], -envelope.radius + extent[0], envelope.radius - extent[0]),
      clamp(center[1], -envelope.rootDepth + extent[1], envelope.height - extent[1]),
      clamp(center[2], -envelope.radius + extent[2], envelope.radius - extent[2]),
    ];
    clusters.push(Object.freeze({
      id: clusters.length,
      node: node.id,
      center: freezeVector(...center),
      extent: freezeVector(...extent),
      organ: CLUSTER_ORGAN[colony.family] ?? GDO_PLANT_ORGANS.LEAF,
      paletteSlot: Math.floor(jitter('palette') * 8) & 7,
      lodImportance: .45,
    }));
  }
  const nodes = colony.nodes;
  const byDepth = {}, byPhaseGroup = {}, byOrgan = {};
  for (const node of nodes) {
    byDepth[node.depth] = (byDepth[node.depth] ?? 0) + 1;
    byPhaseGroup[node.phaseGroup] = (byPhaseGroup[node.phaseGroup] ?? 0) + 1;
    byOrgan[node.organ] = (byOrgan[node.organ] ?? 0) + 1;
  }
  const diagnostics = colony.diagnostics;
  return Object.freeze({
    namespace: GDO_PLANT_GRAMMAR_NAMESPACE,
    recipeVersion: GDO_FEATURE_VERSIONS.vegetationGrammar,
    origin: GDO_COLONIZATION_NAMESPACE,
    family: colony.family,
    label: `${recipe.label} (colonized)`,
    profile: colony.profile,
    archetypeIndex: colony.archetypeIndex,
    environmentKey: colony.environmentKey,
    seed: colony.seed,
    unit: recipe.unit,
    pivot: freezeVector(0, 0, 0),
    envelope,
    nodes: Object.freeze([...nodes]),
    clusters: Object.freeze(clusters),
    roots: Object.freeze([]),
    bounds: skeletonBounds(nodes, clusters),
    diagnostics: Object.freeze({
      nodes: nodes.length,
      clusters: clusters.length,
      roots: 0,
      modules: Math.max(0, nodes.length - 1) + clusters.length,
      byDepth: Object.freeze(byDepth),
      byPhaseGroup: Object.freeze(byPhaseGroup),
      byOrgan: Object.freeze(byOrgan),
      keyedChannels: Object.freeze(['cluster-x', 'cluster-y', 'cluster-z', 'cluster-width', 'cluster-height', 'cluster-depth', 'palette', 'bend', 'phase']),
      limits: colony.limits,
      attemptedNodes: diagnostics.growthSteps,
      rejectedEnvelope: diagnostics.rejectedEnvelope,
      rejectedOccupancy: 0,
      rejectedBudget: diagnostics.truncated,
      occupancyRetries: 0,
      terminatedDepth: 0,
      terminatedSize: 0,
      clustersOmitted: omitted,
      maximumDepth: nodes.reduce((depth, node) => Math.max(depth, node.depth), 0),
      attractors: diagnostics.attractors,
      attractorsConsumed: diagnostics.attractorsConsumed,
      attractorsKilled: diagnostics.attractorsKilled,
      iterations: diagnostics.iterations,
      nearestTests: diagnostics.nearestTests,
      truncated: diagnostics.truncated,
      truncationReason: diagnostics.truncationReason,
    }),
  });
}

/** Shared key: a placed tree contributes no identity of its own. */
export function colonizedArchetypeKey({ family, archetypeIndex = 0, profile = 'low', environmentKey = 'default', seedSalt = 0 } = {}) {
  return `${profile}:${environmentKey}:${seedSalt}:${family}:${archetypeIndex}`;
}

/**
 * `VEG-11`'s other half: archetypes are authored once and shared. The cache
 * refuses per-tree identity by name, so a placement can never trigger a search.
 */
export function createColonizedArchetypeCache({
  limits = {},
  compile = colonizePlantArchetype,
  adapt = colonizedPlantSkeleton,
} = {}) {
  const merged = { ...GDO_COLONIZATION_LIMITS, ...(limits ?? {}) };
  const capacity = Math.max(1, merged.archetypes | 0);
  const entries = new Map();
  let hits = 0, misses = 0, compiles = 0, evictions = 0, refusals = 0;

  const touch = (key, value) => {
    // Insertion order is recency order: deleting then re-adding is the LRU.
    if (entries.has(key)) entries.delete(key);
    entries.set(key, value);
  };

  function request(options = {}) {
    if (!options || typeof options !== 'object') {
      refusals++;
      return Object.freeze({ ok: false, refusal: GDO_COLONIZATION_REFUSAL.UNKNOWN_FAMILY });
    }
    // A per-tree identity means someone is trying to search at runtime.
    if (options.owner !== undefined || options.placementSeed !== undefined ||
        options.position !== undefined || options.seed !== undefined) {
      refusals++;
      return Object.freeze({ ok: false, refusal: GDO_COLONIZATION_REFUSAL.PER_TREE_SEARCH });
    }
    if (!GDO_PLANT_FAMILY_RECIPES[options.family]) {
      refusals++;
      return Object.freeze({ ok: false, refusal: GDO_COLONIZATION_REFUSAL.UNKNOWN_FAMILY });
    }
    const key = colonizedArchetypeKey(options);
    const cached = entries.get(key);
    if (cached) {
      hits++;
      touch(key, cached);
      return Object.freeze({ ok: true, key, archetype: cached, shared: true, hit: true });
    }
    misses++;
    let archetype;
    try {
      // The cache holds the *skeleton* every consumer already understands, so
      // a hit hands out exactly what the geometry/LOD compilers take.
      archetype = adapt(compile(options));
    } catch (error) {
      // A cache is not allowed to leak a half-built archetype or to throw on
      // the hot path: the caller gets a named refusal instead.
      refusals++;
      const reason = error instanceof RangeError && String(error.message).includes('archetype')
        ? GDO_COLONIZATION_REFUSAL.BAD_ARCHETYPE
        : GDO_COLONIZATION_REFUSAL.UNKNOWN_PROFILE;
      return Object.freeze({ ok: false, refusal: reason });
    }
    compiles++;
    touch(key, archetype);
    while (entries.size > capacity) {
      entries.delete(entries.keys().next().value);
      evictions++;
    }
    return Object.freeze({ ok: true, key, archetype, shared: true, hit: false });
  }

  return Object.freeze({
    capacity,
    // Drop-in for the archetype-library interface the LOD compiler reads.
    getArchetype(family, archetypeIndex = 0, { profile = 'low', environmentKey = 'default', seedSalt = 0 } = {}) {
      const result = request({ family, archetypeIndex, profile, environmentKey, seedSalt });
      if (!result.ok) throw new RangeError(`Colonized archetype refused: ${result.refusal}`);
      return result.archetype;
    },
    request,
    has: key => entries.has(key),
    clear() { entries.clear(); },
    get diagnostics() {
      return Object.freeze({
        namespace: GDO_COLONIZATION_NAMESPACE,
        capacity,
        entries: entries.size,
        hits,
        misses,
        compiles,
        evictions,
        refusals,
        perTreeSearches: 0,
        keys: Object.freeze([...entries.keys()]),
      });
    },
  });
}
