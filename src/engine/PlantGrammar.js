import { GDO_FEATURE_VERSIONS, featureNamespace } from './FeatureVersions.js';

export const GDO_PLANT_GRAMMAR_NAMESPACE = featureNamespace('vegetationGrammar');
export const GDO_PLANT_UNIT = 1;
export const GDO_PLANT_PHASE_GROUPS = 4;
export const GDO_MAX_ACTIVE_PLANT_LIBRARIES = 8;

export const GDO_PLANT_PROFILES = Object.freeze({
  low: Object.freeze({
    variantsPerFamily: 2,
    maxArchetypes: 48,
    maxDepth: 2,
    maxNodes: 18,
    maxClusters: 7,
    maxRoots: 4,
    maxOccupancyRetries: 12,
    maxModules: 18,
    compileSliceMilliseconds: 3,
  }),
  balanced: Object.freeze({
    variantsPerFamily: 3,
    maxArchetypes: 80,
    maxDepth: 3,
    maxNodes: 32,
    maxClusters: 12,
    maxRoots: 6,
    maxOccupancyRetries: 20,
    maxModules: 36,
    compileSliceMilliseconds: 4,
  }),
  high: Object.freeze({
    variantsPerFamily: 4,
    maxArchetypes: 128,
    maxDepth: 3,
    maxNodes: 48,
    maxClusters: 18,
    maxRoots: 8,
    maxOccupancyRetries: 28,
    maxModules: 56,
    compileSliceMilliseconds: 6,
  }),
});

export const GDO_PLANT_ORGANS = Object.freeze({
  TRUNK: 'trunk',
  BRANCH: 'branch',
  ROOT: 'root',
  STEM: 'stem',
  CULM: 'culm',
  FROND: 'frond',
  BLADE: 'blade',
  LEAF: 'leaf',
  FLOWER: 'flower',
});

const recipe = values => Object.freeze({
  unit: GDO_PLANT_UNIT,
  minimumLength: .055,
  minimumRadius: .012,
  occupancyCells: 9,
  ...values,
  envelope: Object.freeze({ ...values.envelope }),
  branchCount: Object.freeze([...(values.branchCount ?? [0, 0])]),
  childCount: Object.freeze([...(values.childCount ?? [0, 0])]),
  branchElevation: Object.freeze([...(values.branchElevation ?? [0, 0])]),
});

/** Normalized archetypes; placement scale turns one unit into mode-appropriate size. */
export const GDO_PLANT_FAMILY_RECIPES = Object.freeze({
  broadleaf: recipe({
    label: 'rounded broadleaf', maxDepth: 3, maxNodes: 30, maxClusters: 12, maxRoots: 4,
    envelope: { radius: 1.38, height: 3.35, rootDepth: .34, shape: 'rounded' },
    trunkSegments: 3, trunkRadius: .20, branchCount: [3, 5], childCount: [1, 3],
    branchLength: .92, lengthRatio: .61, taper: .62, branchElevation: [.42, .94],
  }),
  palm: recipe({
    label: 'palm', maxDepth: 1, maxNodes: 20, maxClusters: 9, maxRoots: 3,
    envelope: { radius: 1.62, height: 4.45, rootDepth: .22, shape: 'column-crown' },
    trunkSegments: 5, trunkRadius: .16, frondCount: [6, 9], branchLength: 1.35,
    lengthRatio: .72, taper: .70, branchElevation: [.08, .32],
  }),
  shrub: recipe({
    label: 'shrub', maxDepth: 2, maxNodes: 22, maxClusters: 9, maxRoots: 2,
    envelope: { radius: 1.12, height: 1.52, rootDepth: .18, shape: 'mound' },
    trunkSegments: 1, trunkRadius: .10, branchCount: [3, 6], childCount: [1, 2],
    branchLength: .72, lengthRatio: .58, taper: .60, branchElevation: [.48, 1.06],
  }),
  herb: recipe({
    label: 'herb or flower', maxDepth: 1, maxNodes: 9, maxClusters: 4, maxRoots: 0,
    envelope: { radius: .42, height: 1.05, rootDepth: .04, shape: 'upright' },
    trunkSegments: 1, trunkRadius: .045, branchCount: [2, 4], childCount: [0, 0],
    branchLength: .34, lengthRatio: .5, taper: .52, branchElevation: [.16, .44],
  }),
  grass: recipe({
    label: 'grass or sedge', maxDepth: 0, maxNodes: 8, maxClusters: 2, maxRoots: 0,
    envelope: { radius: .46, height: .88, rootDepth: .03, shape: 'tuft' },
    trunkSegments: 0, trunkRadius: .026, branchCount: [3, 6], childCount: [0, 0],
    branchLength: .72, lengthRatio: .5, taper: .48, branchElevation: [1.10, 1.43],
  }),
  bamboo: recipe({
    label: 'bamboo clump', maxDepth: 1, maxNodes: 24, maxClusters: 10, maxRoots: 0,
    envelope: { radius: 1.18, height: 4.10, rootDepth: .08, shape: 'clump' },
    trunkSegments: 1, trunkRadius: .075, branchCount: [5, 10], childCount: [1, 2],
    branchLength: 3.25, lengthRatio: .18, taper: .78, branchElevation: [1.34, 1.52],
  }),
});

const FAMILY_NAMES = Object.freeze(Object.keys(GDO_PLANT_FAMILY_RECIPES));
const CHANNELS = Object.freeze([
  'branch-count', 'child-count', 'length', 'azimuth', 'elevation', 'bend',
  'radius', 'phase', 'palette', 'cluster', 'lean', 'placement',
]);

function mix32(value) {
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function hashText(value, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return mix32(hash);
}

function hashParts(parts) {
  let hash = 2166136261;
  for (const part of parts) hash = hashText(`${part}\u001f`, hash);
  return hash >>> 0;
}

/** Stable independent random channel. Call order never changes its result. */
export function plantKeyedValue(family, archetypeIndex, nodePath, channel, {
  environmentKey = 'default',
  seedSalt = 0,
} = {}) {
  if (!GDO_PLANT_FAMILY_RECIPES[family]) throw new RangeError(`Unknown plant family: ${family}`);
  if (!Number.isInteger(archetypeIndex) || archetypeIndex < 0 || archetypeIndex > 255) {
    throw new RangeError('Plant archetype index must be an integer from 0 to 255');
  }
  if (typeof nodePath !== 'string' || !nodePath || nodePath.length > 128) throw new RangeError('Invalid plant node path');
  if (typeof channel !== 'string' || !channel || channel.length > 64) throw new RangeError('Invalid plant random channel');
  if (typeof environmentKey !== 'string' || !environmentKey || environmentKey.length > 64) throw new RangeError('Invalid environment key');
  if (!Number.isInteger(seedSalt)) throw new RangeError('Plant seed salt must be an integer');
  return hashParts([
    GDO_PLANT_GRAMMAR_NAMESPACE,
    environmentKey,
    seedSalt,
    family,
    archetypeIndex,
    nodePath,
    channel,
  ]) / 4294967296;
}

function countFromRange(range, value) {
  const minimum = range[0], maximum = range[1];
  return minimum + Math.min(maximum - minimum, Math.floor(value * (maximum - minimum + 1)));
}

function freezeVector(x, y, z) { return Object.freeze([x, y, z]); }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function mix(a, b, amount) { return a + (b - a) * amount; }

function normalize(x, y, z) {
  const inverse = 1 / (Math.hypot(x, y, z) || 1);
  return [x * inverse, y * inverse, z * inverse];
}

function radialDirection(azimuth, elevation, bendX = 0, bendZ = 0) {
  const horizontal = Math.cos(elevation);
  return normalize(
    Math.cos(azimuth) * horizontal + bendX,
    Math.sin(elevation),
    Math.sin(azimuth) * horizontal + bendZ,
  );
}

function boundedLimit(requested, maximum, minimum = 0) {
  if (requested == null) return maximum;
  if (!Number.isInteger(requested) || requested < minimum) throw new RangeError('Plant limits must be non-negative integers');
  return Math.min(requested, maximum);
}

function effectiveLimits(profile, familyRecipe, overrides = {}) {
  return Object.freeze({
    maxDepth: boundedLimit(overrides.maxDepth, Math.min(profile.maxDepth, familyRecipe.maxDepth)),
    maxNodes: boundedLimit(overrides.maxNodes, Math.min(profile.maxNodes, familyRecipe.maxNodes), 1),
    maxClusters: boundedLimit(overrides.maxClusters, Math.min(profile.maxClusters, familyRecipe.maxClusters)),
    maxRoots: boundedLimit(overrides.maxRoots, Math.min(profile.maxRoots, familyRecipe.maxRoots)),
    maxOccupancyRetries: boundedLimit(overrides.maxOccupancyRetries,
      profile.maxOccupancyRetries),
    maxModules: boundedLimit(overrides.maxModules, profile.maxModules, 1),
  });
}

function createBuilder(context, familyRecipe, limits) {
  const nodes = [], clusters = [], roots = [];
  const occupied = new Map();
  const diagnostics = {
    attemptedNodes: 0,
    rejectedEnvelope: 0,
    rejectedOccupancy: 0,
    rejectedBudget: 0,
    occupancyRetries: 0,
    terminatedDepth: 0,
    terminatedSize: 0,
    clustersOmitted: 0,
    maximumDepth: 0,
  };
  const envelope = familyRecipe.envelope;
  const cellSize = Math.max(.08, envelope.radius * 2 / familyRecipe.occupancyCells);
  const random = (path, channel, attempt = 0) => plantKeyedValue(
    context.family, context.archetypeIndex, path, attempt ? `${channel}:${attempt}` : channel, context,
  );
  const moduleCount = () => Math.max(0, nodes.length - 1) + clusters.length;
  const cellKey = position => `${Math.round(position[0] / cellSize)}:${Math.round(position[1] / cellSize)}:${Math.round(position[2] / cellSize)}`;
  const insideEnvelope = (position, organ) => {
    const radial = Math.hypot(position[0], position[2]);
    const minimumY = organ === GDO_PLANT_ORGANS.ROOT ? -envelope.rootDepth : 0;
    if (position[1] < minimumY - 1e-8 || position[1] > envelope.height + 1e-8 || radial > envelope.radius + 1e-8) return false;
    // Rounded/mound crowns narrow toward their top without affecting trunks.
    if ((envelope.shape === 'rounded' || envelope.shape === 'mound') &&
        organ !== GDO_PLANT_ORGANS.TRUNK && organ !== GDO_PLANT_ORGANS.STEM && organ !== GDO_PLANT_ORGANS.ROOT) {
      const normalizedY = clamp(position[1] / envelope.height, 0, 1);
      const crownFactor = envelope.shape === 'mound'
        ? .42 + Math.sin(normalizedY * Math.PI) * .68
        : .34 + Math.sin(normalizedY * Math.PI) * .82;
      return radial <= envelope.radius * crownFactor + 1e-8;
    }
    return true;
  };

  const addBase = (organ, radius) => {
    const node = Object.freeze({
      id: 0,
      parent: -1,
      depth: 0,
      path: 'base',
      position: freezeVector(0, 0, 0),
      direction: freezeVector(0, 1, 0),
      length: 0,
      radius,
      stiffness: 1,
      phaseGroup: 0,
      organ,
      lodImportance: 1,
    });
    nodes.push(node);
    occupied.set(cellKey(node.position), node.id);
    return node.id;
  };

  const addNode = ({ parent, direction, length, radius, depth, path, organ, lodImportance = .5 }) => {
    diagnostics.attemptedNodes++;
    if (nodes.length >= limits.maxNodes || moduleCount() >= limits.maxModules) {
      diagnostics.rejectedBudget++;
      return -1;
    }
    if (depth > limits.maxDepth) {
      diagnostics.terminatedDepth++;
      return -1;
    }
    if (length < familyRecipe.minimumLength || radius < familyRecipe.minimumRadius) {
      diagnostics.terminatedSize++;
      return -1;
    }
    const parentNode = nodes[parent];
    if (!parentNode) throw new RangeError(`Invalid parent node ${parent}`);
    const unit = normalize(...direction);
    const position = [
      parentNode.position[0] + unit[0] * length,
      parentNode.position[1] + unit[1] * length,
      parentNode.position[2] + unit[2] * length,
    ];
    if (!insideEnvelope(position, organ)) {
      diagnostics.rejectedEnvelope++;
      return -1;
    }
    const key = cellKey(position);
    const occupant = occupied.get(key);
    if (occupant != null && occupant !== parent) {
      diagnostics.rejectedOccupancy++;
      return -1;
    }
    const id = nodes.length;
    const node = Object.freeze({
      id,
      parent,
      depth,
      path,
      position: freezeVector(...position),
      direction: freezeVector(...unit),
      length,
      radius,
      stiffness: clamp(1 - depth * .23 - random(path, 'bend') * .11, .16, 1),
      phaseGroup: Math.min(GDO_PLANT_PHASE_GROUPS - 1, Math.floor(random(path, 'phase') * GDO_PLANT_PHASE_GROUPS)),
      organ,
      lodImportance: clamp(lodImportance, 0, 1),
    });
    nodes.push(node);
    occupied.set(key, id);
    diagnostics.maximumDepth = Math.max(diagnostics.maximumDepth, depth);
    return id;
  };

  const addRadialNode = options => {
    const remaining = limits.maxOccupancyRetries - diagnostics.occupancyRetries;
    const attempts = Math.min(3, Math.max(1, remaining + 1));
    for (let attempt = 0; attempt < attempts; attempt++) {
      const adjustment = attempt ? (random(options.path, 'azimuth-retry', attempt) - .5) * .74 : 0;
      const bend = (random(options.path, 'bend-direction', attempt) - .5) * .10;
      const direction = radialDirection(options.azimuth + adjustment, options.elevation, bend, -bend * .7);
      const id = addNode({ ...options, direction });
      if (id >= 0) return id;
      if (attempt + 1 < attempts) diagnostics.occupancyRetries++;
      if (diagnostics.occupancyRetries >= limits.maxOccupancyRetries) break;
    }
    return -1;
  };

  const addCluster = (nodeId, path, {
    organ = GDO_PLANT_ORGANS.LEAF,
    scale = 1,
    lodImportance = .45,
    paletteOffset = 0,
  } = {}) => {
    if (clusters.length >= limits.maxClusters || moduleCount() >= limits.maxModules) {
      diagnostics.clustersOmitted++;
      return -1;
    }
    const node = nodes[nodeId];
    if (!node) return -1;
    const jitterX = (random(path, 'cluster-x') - .5) * .16 * scale;
    const jitterY = random(path, 'cluster-y') * .10 * scale;
    const jitterZ = (random(path, 'cluster-z') - .5) * .16 * scale;
    let center = [node.position[0] + jitterX, node.position[1] + jitterY, node.position[2] + jitterZ];
    let extent = [
      (.20 + random(path, 'cluster-width') * .16) * scale,
      (.14 + random(path, 'cluster-height') * .16) * scale,
      (.20 + random(path, 'cluster-depth') * .16) * scale,
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
    const cluster = Object.freeze({
      id: clusters.length,
      node: nodeId,
      path,
      center: freezeVector(...center),
      extent: freezeVector(...extent),
      paletteSlot: (paletteOffset + Math.floor(random(path, 'palette') * 4)) & 7,
      depth: node.depth,
      lodImportance: clamp(lodImportance, 0, 1),
      organ,
      overlapRole: 'crown-union',
    });
    clusters.push(cluster);
    return cluster.id;
  };

  const addRoot = (path, azimuth, length, radius) => {
    if (roots.length >= limits.maxRoots) return -1;
    const id = addRadialNode({
      parent: 0,
      azimuth,
      elevation: -.20 - random(path, 'root-drop') * .20,
      length,
      radius,
      depth: 0,
      path,
      organ: GDO_PLANT_ORGANS.ROOT,
      lodImportance: .68,
    });
    if (id >= 0) roots.push(id);
    return id;
  };

  return { nodes, clusters, roots, diagnostics, random, addBase, addNode, addRadialNode, addCluster, addRoot, moduleCount };
}

function compileBroadleaf(builder, familyRecipe) {
  let parent = builder.addBase(GDO_PLANT_ORGANS.TRUNK, familyRecipe.trunkRadius);
  for (let segment = 0; segment < familyRecipe.trunkSegments; segment++) {
    const path = `trunk/${segment}`;
    const leanX = (builder.random(path, 'lean') - .5) * .10;
    const leanZ = (builder.random(path, 'bend') - .5) * .10;
    const id = builder.addNode({
      parent,
      direction: [leanX, 1, leanZ],
      length: familyRecipe.envelope.height * (.15 + builder.random(path, 'length') * .025),
      radius: familyRecipe.trunkRadius * (1 - segment * .17),
      depth: 0,
      path,
      organ: GDO_PLANT_ORGANS.TRUNK,
      lodImportance: 1,
    });
    if (id < 0) break;
    parent = id;
  }
  const rootCount = 2 + Math.floor(builder.random('roots', 'branch-count') * 3);
  for (let root = 0; root < rootCount; root++) {
    const path = `root/${root}`;
    builder.addRoot(path, root / rootCount * Math.PI * 2 + builder.random(path, 'azimuth') * .45,
      .35 + builder.random(path, 'length') * .24, familyRecipe.trunkRadius * .48);
  }

  const grow = (parentId, path, depth, length, radius, baseAzimuth) => {
    const childCount = depth === 1
      ? countFromRange(familyRecipe.branchCount, builder.random(path, 'branch-count'))
      : countFromRange(familyRecipe.childCount, builder.random(path, 'child-count'));
    if (depth > familyRecipe.maxDepth || childCount === 0 || length < familyRecipe.minimumLength) {
      builder.diagnostics.terminatedDepth++;
      builder.addCluster(parentId, `${path}/terminal`, { scale: .92 / Math.max(1, depth * .68), lodImportance: .35 });
      return;
    }
    let emitted = 0;
    for (let child = 0; child < childCount; child++) {
      const childPath = `${path}/${child}`;
      const azimuth = baseAzimuth + child / childCount * Math.PI * 2 +
        (builder.random(childPath, 'azimuth') - .5) * 1.05;
      const elevation = mix(familyRecipe.branchElevation[0], familyRecipe.branchElevation[1],
        builder.random(childPath, 'elevation'));
      const childLength = length * mix(.88, 1.08, builder.random(childPath, 'length'));
      const node = builder.addRadialNode({
        parent: parentId,
        azimuth,
        elevation,
        length: childLength,
        radius,
        depth,
        path: childPath,
        organ: GDO_PLANT_ORGANS.BRANCH,
        lodImportance: depth === 1 ? .86 : .52,
      });
      if (node < 0) continue;
      emitted++;
      if (depth >= familyRecipe.maxDepth || childLength * familyRecipe.lengthRatio < familyRecipe.minimumLength * 1.6) {
        builder.addCluster(node, `${childPath}/crown`, { scale: depth === 1 ? 1.12 : .82, lodImportance: .42 });
      } else {
        grow(node, childPath, depth + 1, childLength * familyRecipe.lengthRatio,
          radius * familyRecipe.taper, azimuth + Math.PI * .61);
      }
    }
    if (!emitted) builder.addCluster(parentId, `${path}/fallback-crown`, { scale: 1, lodImportance: .55 });
  };
  grow(parent, 'branch', 1, familyRecipe.branchLength, familyRecipe.trunkRadius * .58,
    builder.random('branch', 'azimuth') * Math.PI * 2);
}

function compilePalm(builder, familyRecipe) {
  let parent = builder.addBase(GDO_PLANT_ORGANS.TRUNK, familyRecipe.trunkRadius);
  const leanAngle = builder.random('trunk', 'azimuth') * Math.PI * 2;
  const leanAmount = .018 + builder.random('trunk', 'lean') * .035;
  for (let segment = 0; segment < familyRecipe.trunkSegments; segment++) {
    const path = `trunk/${segment}`;
    const curve = (segment + 1) / familyRecipe.trunkSegments;
    const id = builder.addNode({
      parent,
      direction: [Math.cos(leanAngle) * leanAmount * curve, 1, Math.sin(leanAngle) * leanAmount * curve],
      length: familyRecipe.envelope.height * .16,
      radius: familyRecipe.trunkRadius * (1 - segment * .055),
      depth: 0,
      path,
      organ: GDO_PLANT_ORGANS.TRUNK,
      lodImportance: 1,
    });
    if (id < 0) break;
    parent = id;
  }
  const fronds = countFromRange(familyRecipe.frondCount, builder.random('fronds', 'branch-count'));
  const rotation = builder.random('fronds', 'azimuth') * Math.PI * 2;
  for (let index = 0; index < fronds; index++) {
    const path = `frond/${index}`;
    const node = builder.addRadialNode({
      parent,
      azimuth: rotation + index / fronds * Math.PI * 2,
      elevation: mix(familyRecipe.branchElevation[0], familyRecipe.branchElevation[1], builder.random(path, 'elevation')),
      length: familyRecipe.branchLength * mix(.78, 1, builder.random(path, 'length')),
      radius: familyRecipe.trunkRadius * .32,
      depth: 1,
      path,
      organ: GDO_PLANT_ORGANS.FROND,
      lodImportance: .72,
    });
    if (node >= 0) builder.addCluster(node, `${path}/leaves`, { scale: .72, lodImportance: .62 });
  }
  builder.addCluster(parent, 'fruit-crown', { organ: GDO_PLANT_ORGANS.FLOWER, scale: .46, lodImportance: .34, paletteOffset: 2 });
}

function compileShrub(builder, familyRecipe) {
  builder.addBase(GDO_PLANT_ORGANS.STEM, familyRecipe.trunkRadius);
  const stems = countFromRange(familyRecipe.branchCount, builder.random('stems', 'branch-count'));
  const rotation = builder.random('stems', 'azimuth') * Math.PI * 2;
  for (let stem = 0; stem < stems; stem++) {
    const path = `stem/${stem}`;
    const azimuth = rotation + stem / stems * Math.PI * 2 + (builder.random(path, 'azimuth') - .5) * .62;
    const node = builder.addRadialNode({
      parent: 0,
      azimuth,
      elevation: mix(familyRecipe.branchElevation[0], familyRecipe.branchElevation[1], builder.random(path, 'elevation')),
      length: familyRecipe.branchLength * mix(.76, 1.05, builder.random(path, 'length')),
      radius: familyRecipe.trunkRadius * .72,
      depth: 1,
      path,
      organ: GDO_PLANT_ORGANS.STEM,
      lodImportance: .82,
    });
    if (node < 0) continue;
    const splits = countFromRange(familyRecipe.childCount, builder.random(path, 'child-count'));
    let emitted = 0;
    for (let child = 0; child < splits; child++) {
      const childPath = `${path}/branch/${child}`;
      const branch = builder.addRadialNode({
        parent: node,
        azimuth: azimuth + (child ? .76 : -.76) + (builder.random(childPath, 'azimuth') - .5) * .4,
        elevation: .50 + builder.random(childPath, 'elevation') * .48,
        length: familyRecipe.branchLength * familyRecipe.lengthRatio * mix(.72, 1, builder.random(childPath, 'length')),
        radius: familyRecipe.trunkRadius * familyRecipe.taper,
        depth: 2,
        path: childPath,
        organ: GDO_PLANT_ORGANS.BRANCH,
        lodImportance: .54,
      });
      if (branch >= 0) {
        builder.addCluster(branch, `${childPath}/crown`, { scale: .72, lodImportance: .46 });
        emitted++;
      }
    }
    if (!emitted) builder.addCluster(node, `${path}/crown`, { scale: .82, lodImportance: .52 });
  }
}

function compileHerb(builder, familyRecipe) {
  const base = builder.addBase(GDO_PLANT_ORGANS.STEM, familyRecipe.trunkRadius);
  const stem = builder.addNode({
    parent: base,
    direction: [0, 1, 0],
    length: familyRecipe.envelope.height * (.62 + builder.random('stem', 'length') * .20),
    radius: familyRecipe.trunkRadius,
    depth: 0,
    path: 'stem/0',
    organ: GDO_PLANT_ORGANS.STEM,
    lodImportance: 1,
  });
  const leaves = countFromRange(familyRecipe.branchCount, builder.random('leaves', 'branch-count'));
  for (let leaf = 0; leaf < leaves; leaf++) {
    const path = `leaf/${leaf}`;
    const parent = leaf < 2 ? base : stem;
    const node = builder.addRadialNode({
      parent: parent < 0 ? base : parent,
      azimuth: leaf / leaves * Math.PI * 2 + builder.random(path, 'azimuth') * .55,
      elevation: mix(familyRecipe.branchElevation[0], familyRecipe.branchElevation[1], builder.random(path, 'elevation')),
      length: familyRecipe.branchLength * mix(.65, 1, builder.random(path, 'length')),
      radius: familyRecipe.trunkRadius * .54,
      depth: 1,
      path,
      organ: GDO_PLANT_ORGANS.LEAF,
      lodImportance: .48,
    });
    if (node >= 0) builder.addCluster(node, `${path}/blade`, { scale: .38, lodImportance: .34 });
  }
  if (stem >= 0) builder.addCluster(stem, 'flower-head', {
    organ: GDO_PLANT_ORGANS.FLOWER,
    scale: .46,
    lodImportance: .74,
    paletteOffset: 3,
  });
}

function compileGrass(builder, familyRecipe) {
  const base = builder.addBase(GDO_PLANT_ORGANS.STEM, familyRecipe.trunkRadius);
  const blades = countFromRange(familyRecipe.branchCount, builder.random('blades', 'branch-count'));
  const rotation = builder.random('blades', 'azimuth') * Math.PI * 2;
  for (let blade = 0; blade < blades; blade++) {
    const path = `blade/${blade}`;
    builder.addRadialNode({
      parent: base,
      azimuth: rotation + blade / blades * Math.PI * 2,
      elevation: mix(familyRecipe.branchElevation[0], familyRecipe.branchElevation[1], builder.random(path, 'elevation')),
      length: familyRecipe.branchLength * mix(.55, 1, builder.random(path, 'length')),
      radius: familyRecipe.trunkRadius * mix(.62, .90, builder.random(path, 'radius')),
      depth: 0,
      path,
      organ: GDO_PLANT_ORGANS.BLADE,
      lodImportance: .42 + blade / blades * .18,
    });
  }
}

function compileBamboo(builder, familyRecipe) {
  const base = builder.addBase(GDO_PLANT_ORGANS.CULM, familyRecipe.trunkRadius);
  const culms = countFromRange(familyRecipe.branchCount, builder.random('culms', 'branch-count'));
  const rotation = builder.random('culms', 'azimuth') * Math.PI * 2;
  for (let culm = 0; culm < culms; culm++) {
    const path = `culm/${culm}`;
    const azimuth = rotation + culm / culms * Math.PI * 2;
    const radial = .10 + builder.random(path, 'placement') * .36;
    const lower = builder.addRadialNode({
      parent: base,
      azimuth,
      elevation: .16,
      length: radial,
      radius: familyRecipe.trunkRadius,
      depth: 0,
      path: `${path}/base`,
      organ: GDO_PLANT_ORGANS.CULM,
      lodImportance: .84,
    });
    if (lower < 0) continue;
    const upper = builder.addNode({
      parent: lower,
      direction: [(builder.random(path, 'lean') - .5) * .10, 1, (builder.random(path, 'bend') - .5) * .10],
      length: familyRecipe.branchLength * mix(.76, 1, builder.random(path, 'length')),
      radius: familyRecipe.trunkRadius * mix(.72, .95, builder.random(path, 'radius')),
      depth: 0,
      path: `${path}/upper`,
      organ: GDO_PLANT_ORGANS.CULM,
      lodImportance: .92,
    });
    if (upper < 0) continue;
    const leaves = countFromRange(familyRecipe.childCount, builder.random(path, 'child-count'));
    for (let leaf = 0; leaf < leaves; leaf++) {
      const leafPath = `${path}/leaf/${leaf}`;
      const node = builder.addRadialNode({
        parent: upper,
        azimuth: azimuth + (leaf ? 1 : -1) * (.55 + builder.random(leafPath, 'azimuth') * .4),
        elevation: .10 + builder.random(leafPath, 'elevation') * .30,
        length: familyRecipe.branchLength * familyRecipe.lengthRatio * mix(.72, 1, builder.random(leafPath, 'length')),
        radius: familyRecipe.trunkRadius * .42,
        depth: 1,
        path: leafPath,
        organ: GDO_PLANT_ORGANS.LEAF,
        lodImportance: .38,
      });
      if (node >= 0) builder.addCluster(node, `${leafPath}/cluster`, { scale: .42, lodImportance: .31 });
    }
  }
}

const COMPILERS = Object.freeze({
  broadleaf: compileBroadleaf,
  palm: compilePalm,
  shrub: compileShrub,
  herb: compileHerb,
  grass: compileGrass,
  bamboo: compileBamboo,
});

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
  const size = maximum.map((value, axis) => value - minimum[axis]);
  return Object.freeze({
    min: freezeVector(...minimum),
    max: freezeVector(...maximum),
    size: freezeVector(...size),
    pivot: freezeVector(0, 0, 0),
  });
}

function summarizeSkeleton(nodes, clusters, roots, limits, diagnostics) {
  const byDepth = {}, byPhaseGroup = {}, byOrgan = {};
  for (const node of nodes) {
    byDepth[node.depth] = (byDepth[node.depth] ?? 0) + 1;
    byPhaseGroup[node.phaseGroup] = (byPhaseGroup[node.phaseGroup] ?? 0) + 1;
    byOrgan[node.organ] = (byOrgan[node.organ] ?? 0) + 1;
  }
  return Object.freeze({
    nodes: nodes.length,
    clusters: clusters.length,
    roots: roots.length,
    modules: Math.max(0, nodes.length - 1) + clusters.length,
    byDepth: Object.freeze(byDepth),
    byPhaseGroup: Object.freeze(byPhaseGroup),
    byOrgan: Object.freeze(byOrgan),
    keyedChannels: CHANNELS,
    limits,
    ...diagnostics,
  });
}

export function compilePlantSkeleton({
  family,
  archetypeIndex = 0,
  profile = 'low',
  environmentKey = 'default',
  seedSalt = 0,
  limits: requestedLimits = {},
} = {}) {
  const familyRecipe = GDO_PLANT_FAMILY_RECIPES[family];
  const profileRecipe = GDO_PLANT_PROFILES[profile];
  if (!familyRecipe) throw new RangeError(`Unknown plant family: ${family}`);
  if (!profileRecipe) throw new RangeError(`Unknown plant profile: ${profile}`);
  if (!Number.isInteger(archetypeIndex) || archetypeIndex < 0 || archetypeIndex >= profileRecipe.variantsPerFamily) {
    throw new RangeError(`${profile} supports archetype indices 0–${profileRecipe.variantsPerFamily - 1}`);
  }
  if (typeof environmentKey !== 'string' || !environmentKey || environmentKey.length > 64) throw new RangeError('Invalid environment key');
  if (!Number.isInteger(seedSalt)) throw new RangeError('Plant seed salt must be an integer');
  const limits = effectiveLimits(profileRecipe, familyRecipe, requestedLimits);
  const context = Object.freeze({ family, archetypeIndex, profile, environmentKey, seedSalt });
  const builder = createBuilder(context, familyRecipe, limits);
  COMPILERS[family](builder, familyRecipe);
  const bounds = skeletonBounds(builder.nodes, builder.clusters);
  const diagnostics = summarizeSkeleton(
    builder.nodes,
    builder.clusters,
    builder.roots,
    limits,
    builder.diagnostics,
  );
  const seed = hashParts([GDO_PLANT_GRAMMAR_NAMESPACE, environmentKey, seedSalt, family, archetypeIndex]);
  return Object.freeze({
    namespace: GDO_PLANT_GRAMMAR_NAMESPACE,
    recipeVersion: GDO_FEATURE_VERSIONS.vegetationGrammar,
    family,
    label: familyRecipe.label,
    profile,
    archetypeIndex,
    environmentKey,
    seed,
    unit: familyRecipe.unit,
    pivot: freezeVector(0, 0, 0),
    envelope: familyRecipe.envelope,
    nodes: Object.freeze(builder.nodes),
    clusters: Object.freeze(builder.clusters),
    roots: Object.freeze(builder.roots),
    bounds,
    diagnostics,
  });
}

/** Palette remapping shares every topology object and cannot move a branch. */
export function recolorPlantSkeleton(skeleton, paletteOffset = 0) {
  if (!skeleton?.nodes || !Number.isInteger(paletteOffset)) throw new TypeError('Invalid plant skeleton/palette offset');
  const clusters = skeleton.clusters.map(cluster => Object.freeze({
    ...cluster,
    paletteSlot: (cluster.paletteSlot + paletteOffset) & 7,
  }));
  return Object.freeze({ ...skeleton, paletteOffset, clusters: Object.freeze(clusters) });
}

/** Placement owns transforms/palette only; it refers to a shared archetype key. */
export function createPlantPlacementRecord({
  family,
  archetypeIndex = 0,
  owner,
  position,
  placementSeed = 0,
  paletteOffset = 0,
} = {}) {
  if (!GDO_PLANT_FAMILY_RECIPES[family]) throw new RangeError(`Unknown plant family: ${family}`);
  if (!Number.isInteger(archetypeIndex) || archetypeIndex < 0 || archetypeIndex > 255) throw new RangeError('Invalid archetype index');
  if (typeof owner !== 'string' || !owner || owner.length > 128) throw new RangeError('Plant placement requires a bounded owner');
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) throw new TypeError('Plant position must be three finite values');
  if (!Number.isInteger(placementSeed) || !Number.isInteger(paletteOffset)) throw new TypeError('Plant placement seeds must be integers');
  const path = `${owner}:${placementSeed}`;
  const value = channel => plantKeyedValue(family, archetypeIndex, path, channel, { seedSalt: placementSeed });
  return Object.freeze({
    namespace: GDO_PLANT_GRAMMAR_NAMESPACE,
    archetypeKey: `${family}:${archetypeIndex}`,
    family,
    archetypeIndex,
    owner,
    position: freezeVector(...position),
    yaw: value('azimuth') * Math.PI * 2,
    scale: freezeVector(
      .86 + value('scale-x') * .28,
      .82 + value('scale-y') * .36,
      .86 + value('scale-z') * .28,
    ),
    paletteSlot: (paletteOffset + Math.floor(value('palette') * 8)) & 7,
    age: .62 + value('age') * .38,
    windStiffness: .35 + value('stiffness') * .58,
  });
}

export function plantSkeletonFingerprint(skeleton) {
  if (!skeleton?.namespace || !Array.isArray(skeleton.nodes) || !Array.isArray(skeleton.clusters)) {
    throw new TypeError('Invalid plant skeleton');
  }
  const payload = JSON.stringify({
    namespace: skeleton.namespace,
    family: skeleton.family,
    profile: skeleton.profile,
    archetypeIndex: skeleton.archetypeIndex,
    environmentKey: skeleton.environmentKey,
    seed: skeleton.seed,
    envelope: skeleton.envelope,
    nodes: skeleton.nodes,
    clusters: skeleton.clusters,
    roots: skeleton.roots,
    bounds: skeleton.bounds,
  });
  return hashText(payload).toString(16).padStart(8, '0');
}

const libraryRecords = new Map();

function createPlantArchetypeLibrary(profileName, environmentKey, seedSalt) {
  const profile = GDO_PLANT_PROFILES[profileName];
  const archetypes = new Map();
  let disposed = false, hits = 0, misses = 0, totalCompileMilliseconds = 0, maximumCompileMilliseconds = 0;
  const getArchetype = (family, archetypeIndex = 0) => {
    if (disposed) throw new Error('Plant archetype library is disposed');
    if (!GDO_PLANT_FAMILY_RECIPES[family]) throw new RangeError(`Unknown plant family: ${family}`);
    if (!Number.isInteger(archetypeIndex) || archetypeIndex < 0 || archetypeIndex >= profile.variantsPerFamily) {
      throw new RangeError(`${profileName} supports archetype indices 0–${profile.variantsPerFamily - 1}`);
    }
    const key = `${family}:${archetypeIndex}`;
    const cached = archetypes.get(key);
    if (cached) { hits++; return cached; }
    const profileCached = [...libraryRecords.values()]
      .filter(record => record.library.profile === profileName)
      .reduce((sum, record) => sum + record.library.diagnostics.cachedArchetypes, 0);
    if (archetypes.size >= profile.maxArchetypes || profileCached >= profile.maxArchetypes) {
      throw new Error(`Plant archetype cap reached: ${profile.maxArchetypes}`);
    }
    const started = performance.now();
    const skeleton = compilePlantSkeleton({ family, archetypeIndex, profile: profileName, environmentKey, seedSalt });
    const elapsed = performance.now() - started;
    totalCompileMilliseconds += elapsed;
    maximumCompileMilliseconds = Math.max(maximumCompileMilliseconds, elapsed);
    misses++;
    archetypes.set(key, skeleton);
    return skeleton;
  };
  const diagnostics = Object.freeze({
    namespace: GDO_PLANT_GRAMMAR_NAMESPACE,
    profile: profileName,
    environmentKey,
    get cachedArchetypes() { return archetypes.size; },
    get hits() { return hits; },
    get misses() { return misses; },
    get totalCompileMilliseconds() { return totalCompileMilliseconds; },
    get maximumCompileMilliseconds() { return maximumCompileMilliseconds; },
    get nodes() { return [...archetypes.values()].reduce((sum, item) => sum + item.nodes.length, 0); },
    get modules() { return [...archetypes.values()].reduce((sum, item) => sum + item.diagnostics.modules, 0); },
    get maximumSkeletonNodes() { return Math.max(0, ...[...archetypes.values()].map(item => item.nodes.length)); },
    get maximumSkeletonModules() { return Math.max(0, ...[...archetypes.values()].map(item => item.diagnostics.modules)); },
    get disposed() { return disposed; },
    limits: profile,
  });
  return Object.freeze({
    profile: profileName,
    environmentKey,
    variantsPerFamily: profile.variantsPerFamily,
    families: FAMILY_NAMES,
    diagnostics,
    getArchetype,
    getForPlacement(record) {
      if (!record || !GDO_PLANT_FAMILY_RECIPES[record.family]) throw new TypeError('Invalid plant placement record');
      return getArchetype(record.family, record.archetypeIndex % profile.variantsPerFamily);
    },
    clear() {
      if (disposed) return;
      archetypes.clear();
      disposed = true;
    },
  });
}

export function acquirePlantArchetypeLibrary({
  profile = 'low',
  environmentKey = 'default',
  seedSalt = 0,
} = {}) {
  if (!GDO_PLANT_PROFILES[profile]) throw new RangeError(`Unknown plant profile: ${profile}`);
  if (typeof environmentKey !== 'string' || !environmentKey || environmentKey.length > 64) throw new RangeError('Invalid environment key');
  if (!Number.isInteger(seedSalt)) throw new RangeError('Plant seed salt must be an integer');
  const key = `${GDO_PLANT_GRAMMAR_NAMESPACE}:${profile}:${environmentKey}:${seedSalt}`;
  let record = libraryRecords.get(key);
  if (!record) {
    if (libraryRecords.size >= GDO_MAX_ACTIVE_PLANT_LIBRARIES) {
      throw new Error(`Active plant-library cap reached: ${GDO_MAX_ACTIVE_PLANT_LIBRARIES}`);
    }
    record = { library: createPlantArchetypeLibrary(profile, environmentKey, seedSalt), references: 0 };
    libraryRecords.set(key, record);
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
        libraryRecords.delete(key);
      }
    },
  });
}

export function plantArchetypeLibraryStats() {
  return Object.freeze({
    libraries: libraryRecords.size,
    references: [...libraryRecords.values()].reduce((sum, record) => sum + record.references, 0),
    cachedArchetypes: [...libraryRecords.values()].reduce((sum, record) =>
      sum + record.library.diagnostics.cachedArchetypes, 0),
  });
}
