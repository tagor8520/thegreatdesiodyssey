import { featureNamespace } from './FeatureVersions.js';
import {
  GDO_PLANT_FAMILY_RECIPES,
  GDO_PLANT_GRAMMAR_NAMESPACE,
  GDO_PLANT_ORGANS,
  GDO_PLANT_PHASE_GROUPS,
  GDO_PLANT_PROFILES,
  acquirePlantArchetypeLibrary,
  plantSkeletonFingerprint,
} from './PlantGrammar.js';

const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * KIBIBYTE;
const EPSILON = 1e-7;
const CROSS_SECTION_SCALE = .70;

export const GDO_PLANT_GEOMETRY_NAMESPACE = featureNamespace('vegetationGeometry');
export const GDO_MAX_ACTIVE_PLANT_GEOMETRY_LIBRARIES = 8;

/** Hard upload and compile ceilings. VEG-05 may select subsets, but cannot exceed these. */
export const GDO_PLANT_GEOMETRY_PROFILES = Object.freeze({
  low: Object.freeze({
    maxBoxes: 18,
    maxFaces: 108,
    maxTriangles: 216,
    maxVertices: 432,
    maxBytesPerArchetype: 32 * KIBIBYTE,
    maxCachedArchetypes: 48,
    maxCachedBytes: 1.5 * MEBIBYTE,
    minimumFeatureSize: .012,
    jointOverlap: .05,
    compileSliceMilliseconds: 3,
  }),
  balanced: Object.freeze({
    maxBoxes: 36,
    maxFaces: 216,
    maxTriangles: 432,
    maxVertices: 864,
    maxBytesPerArchetype: 48 * KIBIBYTE,
    maxCachedArchetypes: 80,
    maxCachedBytes: 3 * MEBIBYTE,
    minimumFeatureSize: .009,
    jointOverlap: .05,
    compileSliceMilliseconds: 4,
  }),
  high: Object.freeze({
    maxBoxes: 56,
    maxFaces: 336,
    maxTriangles: 672,
    maxVertices: 1344,
    maxBytesPerArchetype: 64 * KIBIBYTE,
    maxCachedArchetypes: 128,
    maxCachedBytes: 6 * MEBIBYTE,
    minimumFeatureSize: .006,
    jointOverlap: .05,
    compileSliceMilliseconds: 6,
  }),
});

/** Stable byte values consumed by the future vegetation material and LOD compiler. */
export const GDO_PLANT_DETAIL_ROLES = Object.freeze({
  trunk: 0,
  branch: 1,
  root: 2,
  stem: 3,
  culm: 4,
  frond: 5,
  blade: 6,
  leaf: 7,
  flower: 8,
});

export const GDO_PLANT_GEOMETRY_LAYOUT = Object.freeze({
  position: Object.freeze({ components: 3, type: 'float32', normalized: false }),
  normal: Object.freeze({ components: 3, type: 'float32', normalized: false }),
  paletteSlot: Object.freeze({ components: 1, type: 'uint8', normalized: false }),
  bendWeight: Object.freeze({ components: 1, type: 'uint8', normalized: true }),
  phaseGroup: Object.freeze({ components: 1, type: 'uint8', normalized: false }),
  detailRole: Object.freeze({ components: 1, type: 'uint8', normalized: false }),
  lodWeight: Object.freeze({ components: 1, type: 'uint8', normalized: true }),
  index: Object.freeze({ components: 1, type: 'uint16', normalized: false }),
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

const DETAIL_ROLE_VALUES = new Set(Object.values(GDO_PLANT_DETAIL_ROLES));
const ORGAN_NAMES = new Set(Object.values(GDO_PLANT_ORGANS));

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteVector(value, length = 3) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!(length > EPSILON)) throw new RangeError('Plant segment endpoints must be distinct');
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function dot(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function addScaled(point, first, firstScale, second = null, secondScale = 0) {
  return [
    point[0] + first[0] * firstScale + (second ? second[0] * secondScale : 0),
    point[1] + first[1] * firstScale + (second ? second[1] * secondScale : 0),
    point[2] + first[2] * firstScale + (second ? second[2] * secondScale : 0),
  ];
}

function quantizeUnit(value) {
  return Math.round(clamp(value, 0, 1) * 255);
}

function faceMetadata(organ, node, paletteSlot = PALETTE_BY_ORGAN[organ] ?? 0, lodImportance = node.lodImportance) {
  const detailRole = GDO_PLANT_DETAIL_ROLES[organ];
  if (!DETAIL_ROLE_VALUES.has(detailRole)) throw new RangeError(`Unknown plant detail role: ${organ}`);
  return Object.freeze({
    paletteSlot: paletteSlot & 7,
    bendWeight: quantizeUnit(1 - node.stiffness),
    phaseGroup: node.phaseGroup,
    detailRole,
    lodWeight: quantizeUnit(lodImportance),
  });
}

function validatePlantSkeleton(skeleton) {
  if (!skeleton || typeof skeleton !== 'object' || skeleton.namespace !== GDO_PLANT_GRAMMAR_NAMESPACE) {
    throw new TypeError('Plant geometry requires a version-compatible PlantSkeleton');
  }
  const profile = GDO_PLANT_GEOMETRY_PROFILES[skeleton.profile];
  if (!profile || !GDO_PLANT_PROFILES[skeleton.profile]) throw new RangeError(`Unknown plant profile: ${skeleton.profile}`);
  if (!GDO_PLANT_FAMILY_RECIPES[skeleton.family]) throw new RangeError(`Unknown plant family: ${skeleton.family}`);
  if (!Array.isArray(skeleton.nodes) || !skeleton.nodes.length || !Array.isArray(skeleton.clusters)) {
    throw new TypeError('PlantSkeleton nodes and clusters must be arrays');
  }
  if (!finiteVector(skeleton.pivot) || !skeleton.envelope ||
      !Number.isFinite(skeleton.envelope.radius) || !Number.isFinite(skeleton.envelope.height) ||
      skeleton.envelope.radius <= 0 || skeleton.envelope.height <= 0) {
    throw new TypeError('PlantSkeleton pivot/envelope is invalid');
  }
  if (!skeleton.bounds || !finiteVector(skeleton.bounds.min) || !finiteVector(skeleton.bounds.max) ||
      !finiteVector(skeleton.bounds.size) || !finiteVector(skeleton.bounds.pivot) ||
      skeleton.bounds.size.some(value => value < 0)) {
    throw new TypeError('PlantSkeleton bounds are invalid');
  }
  const modules = skeleton.nodes.length - 1 + skeleton.clusters.length;
  if (modules > profile.maxBoxes) {
    throw new RangeError(`Plant skeleton has ${modules} modules; ${skeleton.profile} geometry cap is ${profile.maxBoxes}`);
  }
  for (let index = 0; index < skeleton.nodes.length; index++) {
    const node = skeleton.nodes[index];
    if (!node || node.id !== index || !Number.isInteger(node.parent) ||
        (index === 0 ? node.parent !== -1 : node.parent < 0 || node.parent >= index) ||
        !finiteVector(node.position) || !Number.isFinite(node.radius) || node.radius <= 0 ||
        !Number.isFinite(node.stiffness) || node.stiffness < 0 || node.stiffness > 1 ||
        !Number.isInteger(node.phaseGroup) || node.phaseGroup < 0 || node.phaseGroup >= GDO_PLANT_PHASE_GROUPS ||
        !Number.isFinite(node.lodImportance) || node.lodImportance < 0 || node.lodImportance > 1 ||
        !ORGAN_NAMES.has(node.organ)) {
      throw new TypeError(`Invalid PlantSkeleton node at index ${index}`);
    }
  }
  for (let index = 0; index < skeleton.clusters.length; index++) {
    const cluster = skeleton.clusters[index];
    if (!cluster || cluster.id !== index || !Number.isInteger(cluster.node) ||
        cluster.node < 0 || cluster.node >= skeleton.nodes.length || !finiteVector(cluster.center) ||
        !finiteVector(cluster.extent) || cluster.extent.some(value => value <= 0) ||
        !Number.isInteger(cluster.paletteSlot) || cluster.paletteSlot < 0 || cluster.paletteSlot > 7 ||
        !Number.isFinite(cluster.lodImportance) || cluster.lodImportance < 0 || cluster.lodImportance > 1 ||
        !ORGAN_NAMES.has(cluster.organ)) {
      throw new TypeError(`Invalid PlantSkeleton cluster at index ${index}`);
    }
  }
  return profile;
}

function resolveCompileOptions(profile, options) {
  const jointOverlap = options.jointOverlap ?? profile.jointOverlap;
  const requestedMinimum = options.minimumFeatureSize ?? profile.minimumFeatureSize;
  if (!Number.isFinite(jointOverlap) || jointOverlap < .03 || jointOverlap > .08) {
    throw new RangeError('Plant joint overlap must remain between 3% and 8%');
  }
  if (!Number.isFinite(requestedMinimum) || requestedMinimum <= 0 || requestedMinimum > .25) {
    throw new RangeError('Invalid plant minimum feature size');
  }
  return Object.freeze({
    jointOverlap,
    minimumFeatureSize: Math.max(profile.minimumFeatureSize, requestedMinimum),
  });
}

function createOutputBuilder() {
  return {
    positions: [],
    normals: [],
    paletteSlots: [],
    bendWeights: [],
    phaseGroups: [],
    detailRoles: [],
    lodWeights: [],
    indices: [],
  };
}

function appendQuad(builder, points, expectedNormal, metadata) {
  const normal = normalize(expectedNormal);
  let ordered = points;
  const geometricNormal = cross(subtract(points[1], points[0]), subtract(points[2], points[0]));
  if (dot(geometricNormal, normal) < 0) ordered = [points[0], points[3], points[2], points[1]];
  const base = builder.positions.length / 3;
  for (const point of ordered) {
    builder.positions.push(point[0], point[1], point[2]);
    builder.normals.push(normal[0], normal[1], normal[2]);
    builder.paletteSlots.push(metadata.paletteSlot);
    builder.bendWeights.push(metadata.bendWeight);
    builder.phaseGroups.push(metadata.phaseGroup);
    builder.detailRoles.push(metadata.detailRole);
    builder.lodWeights.push(metadata.lodWeight);
  }
  builder.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function segmentDescriptor(node, parent, minimumFeatureSize) {
  const delta = subtract(node.position, parent.position);
  const length = Math.hypot(delta[0], delta[1], delta[2]);
  const halfThickness = (node.radius + parent.radius) * .5 * CROSS_SECTION_SCALE;
  if (length < minimumFeatureSize || halfThickness * 2 < minimumFeatureSize) return null;
  return Object.freeze({ node, parent, direction: normalize(delta), length, halfThickness });
}

function segmentBasis(direction) {
  const helper = Math.abs(direction[1]) < .9 ? [0, 1, 0] : [1, 0, 0];
  const first = normalize(cross(helper, direction));
  const second = normalize(cross(direction, first));
  return [first, second];
}

function emitSegment(builder, segment, outgoing, skeleton, compileOptions) {
  const { node, parent, direction, length, halfThickness } = segment;
  const [first, second] = segmentBasis(direction);
  let startOverlap = length * compileOptions.jointOverlap;
  if (parent.id === 0 && direction[1] > 0) {
    startOverlap = Math.min(startOverlap, Math.max(0, skeleton.envelope.rootDepth ?? 0));
  }
  const endConnected = (outgoing.get(node.id) ?? 0) > 0;
  const endOverlap = endConnected ? length * compileOptions.jointOverlap : 0;
  const start = addScaled(parent.position, direction, -startOverlap);
  const end = addScaled(node.position, direction, endOverlap);
  const corners = point => [
    addScaled(point, first, -halfThickness, second, -halfThickness),
    addScaled(point, first, halfThickness, second, -halfThickness),
    addScaled(point, first, halfThickness, second, halfThickness),
    addScaled(point, first, -halfThickness, second, halfThickness),
  ];
  const startCorners = corners(start), endCorners = corners(end);
  const metadata = faceMetadata(node.organ, node);
  appendQuad(builder, [startCorners[0], startCorners[1], endCorners[1], endCorners[0]],
    second.map(value => -value), metadata);
  appendQuad(builder, [startCorners[1], startCorners[2], endCorners[2], endCorners[1]], first, metadata);
  appendQuad(builder, [startCorners[2], startCorners[3], endCorners[3], endCorners[2]], second, metadata);
  appendQuad(builder, [startCorners[3], startCorners[0], endCorners[0], endCorners[3]],
    first.map(value => -value), metadata);
  // Every segment starts in a buried ground/junction overlap, so its start cap is intentionally absent.
  let capsRemoved = 1;
  if (endConnected) capsRemoved++;
  else appendQuad(builder, [endCorners[0], endCorners[1], endCorners[2], endCorners[3]], direction, metadata);
  return capsRemoved;
}

function clusterDescriptor(cluster, node, minimumFeatureSize) {
  if (cluster.extent.some(value => value * 2 < minimumFeatureSize)) return null;
  return Object.freeze({
    id: cluster.id,
    min: cluster.center.map((value, axis) => value - cluster.extent[axis]),
    max: cluster.center.map((value, axis) => value + cluster.extent[axis]),
    center: cluster.center,
    metadata: faceMetadata(cluster.organ, node, cluster.paletteSlot, cluster.lodImportance),
  });
}

function otherAxes(axis) {
  return [(axis + 1) % 3, (axis + 2) % 3];
}

function faceIsContained(box, axis, sign, boxes) {
  const plane = sign > 0 ? box.max[axis] : box.min[axis];
  const [first, second] = otherAxes(axis);
  return boxes.some(neighbor => {
    if (neighbor === box) return false;
    const occupiesOutside = sign > 0
      ? neighbor.min[axis] <= plane + EPSILON && neighbor.max[axis] > plane + EPSILON
      : neighbor.max[axis] >= plane - EPSILON && neighbor.min[axis] < plane - EPSILON;
    return occupiesOutside &&
      neighbor.min[first] <= box.min[first] + EPSILON && neighbor.max[first] >= box.max[first] - EPSILON &&
      neighbor.min[second] <= box.min[second] + EPSILON && neighbor.max[second] >= box.max[second] - EPSILON;
  });
}

function crownFace(box, axis, sign) {
  const [uAxis, vAxis] = otherAxes(axis);
  return {
    axis,
    sign,
    plane: sign > 0 ? box.max[axis] : box.min[axis],
    uAxis,
    vAxis,
    u0: box.min[uAxis],
    u1: box.max[uAxis],
    v0: box.min[vAxis],
    v1: box.max[vAxis],
    metadata: box.metadata,
  };
}

function sameValue(first, second) {
  return Math.abs(first - second) <= EPSILON;
}

function faceGroupMatches(first, second) {
  const a = first.metadata, b = second.metadata;
  return first.axis === second.axis && first.sign === second.sign && sameValue(first.plane, second.plane) &&
    a.paletteSlot === b.paletteSlot && a.bendWeight === b.bendWeight && a.phaseGroup === b.phaseGroup &&
    a.detailRole === b.detailRole && a.lodWeight === b.lodWeight;
}

function mergeCrownFaces(input) {
  const faces = input.slice();
  let merged = 0;
  // Each successful pass removes one face, so this loop is intrinsically bounded by input size.
  for (let pass = 0; pass < input.length; pass++) {
    let changed = false;
    outer: for (let firstIndex = 0; firstIndex < faces.length; firstIndex++) {
      for (let secondIndex = firstIndex + 1; secondIndex < faces.length; secondIndex++) {
        const first = faces[firstIndex], second = faces[secondIndex];
        if (!faceGroupMatches(first, second)) continue;
        let combined = null;
        if (sameValue(first.v0, second.v0) && sameValue(first.v1, second.v1) &&
            (sameValue(first.u1, second.u0) || sameValue(second.u1, first.u0))) {
          combined = { ...first, u0: Math.min(first.u0, second.u0), u1: Math.max(first.u1, second.u1) };
        } else if (sameValue(first.u0, second.u0) && sameValue(first.u1, second.u1) &&
            (sameValue(first.v1, second.v0) || sameValue(second.v1, first.v0))) {
          combined = { ...first, v0: Math.min(first.v0, second.v0), v1: Math.max(first.v1, second.v1) };
        }
        if (!combined) continue;
        faces[firstIndex] = combined;
        faces.splice(secondIndex, 1);
        merged++;
        changed = true;
        break outer;
      }
    }
    if (!changed) break;
  }
  return { faces, merged };
}

function emitCrownFace(builder, face) {
  const points = [];
  for (const [u, v] of [[face.u0, face.v0], [face.u1, face.v0], [face.u1, face.v1], [face.u0, face.v1]]) {
    const point = [0, 0, 0];
    point[face.axis] = face.plane;
    point[face.uAxis] = u;
    point[face.vAxis] = v;
    points.push(point);
  }
  const normal = [0, 0, 0];
  normal[face.axis] = face.sign;
  appendQuad(builder, points, normal, face.metadata);
}

function typedByteLength(output) {
  return Object.values(output).reduce((total, value) => total +
    (ArrayBuffer.isView(value) && !(value instanceof DataView) ? value.byteLength : 0), 0);
}

function geometryBounds(positions, pivot) {
  if (!positions.length) {
    const point = Object.freeze([...pivot]);
    return Object.freeze({ min: point, max: point, size: Object.freeze([0, 0, 0]), pivot: point });
  }
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) for (let axis = 0; axis < 3; axis++) {
    minimum[axis] = Math.min(minimum[axis], positions[offset + axis]);
    maximum[axis] = Math.max(maximum[axis], positions[offset + axis]);
  }
  return Object.freeze({
    min: Object.freeze(minimum),
    max: Object.freeze(maximum),
    size: Object.freeze(maximum.map((value, axis) => value - minimum[axis])),
    pivot: Object.freeze([...pivot]),
  });
}

/**
 * Compile one shared PlantSkeleton to a worker-friendly indexed upload payload.
 * All transforms are baked into vertices. It performs bounded face tests/merges,
 * never runtime CSG, scene-graph box creation, or collision-proxy generation.
 */
export function compilePlantGeometry(skeleton, options = {}) {
  const profile = validatePlantSkeleton(skeleton);
  if (!options || typeof options !== 'object') throw new TypeError('Plant geometry options must be an object');
  const compileOptions = resolveCompileOptions(profile, options);
  const builder = createOutputBuilder();
  const segments = [];
  let boxesOmitted = 0;
  for (let index = 1; index < skeleton.nodes.length; index++) {
    const node = skeleton.nodes[index], parent = skeleton.nodes[node.parent];
    const segment = segmentDescriptor(node, parent, compileOptions.minimumFeatureSize);
    if (segment) segments.push(segment);
    else boxesOmitted++;
  }
  const outgoing = new Map();
  for (const segment of segments) outgoing.set(segment.parent.id, (outgoing.get(segment.parent.id) ?? 0) + 1);
  let endCapsRemoved = 0;
  for (const segment of segments) endCapsRemoved += emitSegment(builder, segment, outgoing, skeleton, compileOptions);

  const clusterBoxes = [];
  for (const cluster of skeleton.clusters) {
    const box = clusterDescriptor(cluster, skeleton.nodes[cluster.node], compileOptions.minimumFeatureSize);
    if (box) clusterBoxes.push(box);
    else boxesOmitted++;
  }
  const crownFaces = [];
  let hiddenFacesRemoved = 0;
  for (const box of clusterBoxes) for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    if (faceIsContained(box, axis, sign, clusterBoxes)) hiddenFacesRemoved++;
    else crownFaces.push(crownFace(box, axis, sign));
  }
  const merged = mergeCrownFaces(crownFaces);
  for (const face of merged.faces) emitCrownFace(builder, face);

  const positions = new Float32Array(builder.positions);
  const normals = new Float32Array(builder.normals);
  const paletteSlots = new Uint8Array(builder.paletteSlots);
  const bendWeights = new Uint8Array(builder.bendWeights);
  const phaseGroups = new Uint8Array(builder.phaseGroups);
  const detailRoles = new Uint8Array(builder.detailRoles);
  const lodWeights = new Uint8Array(builder.lodWeights);
  const indices = new Uint16Array(builder.indices);
  const typed = { positions, normals, paletteSlots, bendWeights, phaseGroups, detailRoles, lodWeights, indices };
  const boxesEmitted = segments.length + clusterBoxes.length;
  const exposedFaces = indices.length / 6;
  const trianglesAfter = indices.length / 3;
  const estimatedBytes = typedByteLength(typed);
  const inputModules = skeleton.nodes.length - 1 + skeleton.clusters.length;
  const facesBefore = boxesEmitted * 6;
  const trianglesBefore = boxesEmitted * 12;
  const removedFaces = endCapsRemoved + hiddenFacesRemoved + merged.merged;
  if (boxesEmitted > profile.maxBoxes || exposedFaces > profile.maxFaces || trianglesAfter > profile.maxTriangles ||
      positions.length / 3 > profile.maxVertices || estimatedBytes > profile.maxBytesPerArchetype) {
    throw new RangeError(`Compiled ${skeleton.profile} plant geometry exceeded a hard upload cap`);
  }
  if (Math.abs(facesBefore - removedFaces - exposedFaces) > EPSILON) {
    throw new Error('Plant exposed-face accounting invariant failed');
  }
  const diagnostics = Object.freeze({
    inputModules,
    boxesEmitted,
    boxesOmitted,
    segmentBoxes: segments.length,
    crownBoxes: clusterBoxes.length,
    facesBefore,
    exposedFaces,
    endCapsRemoved,
    hiddenFacesRemoved,
    facesMerged: merged.merged,
    trianglesBefore,
    trianglesAfter,
    trianglesRemoved: trianglesBefore - trianglesAfter,
    reductionRatio: trianglesBefore ? (trianglesBefore - trianglesAfter) / trianglesBefore : 0,
    vertices: positions.length / 3,
    indices: indices.length,
    estimatedBytes,
    junctionBlocks: 0,
    runtimeCsgOperations: 0,
    collisionProxies: 0,
    limits: profile,
    compileOptions,
  });
  return Object.freeze({
    namespace: GDO_PLANT_GEOMETRY_NAMESPACE,
    version: 1,
    sourceNamespace: skeleton.namespace,
    sourceFingerprint: plantSkeletonFingerprint(skeleton),
    family: skeleton.family,
    profile: skeleton.profile,
    archetypeIndex: skeleton.archetypeIndex,
    environmentKey: skeleton.environmentKey,
    pivot: skeleton.pivot,
    bounds: skeleton.bounds,
    geometryBounds: geometryBounds(positions, skeleton.pivot),
    envelope: skeleton.envelope,
    layout: GDO_PLANT_GEOMETRY_LAYOUT,
    ...typed,
    diagnostics,
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

function hashBytes(value, seed) {
  let hash = seed >>> 0;
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function plantGeometryFingerprint(geometry) {
  if (!geometry || geometry.namespace !== GDO_PLANT_GEOMETRY_NAMESPACE || !(geometry.positions instanceof Float32Array) ||
      !(geometry.normals instanceof Float32Array) || !(geometry.indices instanceof Uint16Array)) {
    throw new TypeError('Invalid compiled plant geometry');
  }
  let hash = hashText(JSON.stringify({
    namespace: geometry.namespace,
    sourceFingerprint: geometry.sourceFingerprint,
    family: geometry.family,
    profile: geometry.profile,
    archetypeIndex: geometry.archetypeIndex,
    pivot: geometry.pivot,
    bounds: geometry.bounds,
    diagnostics: geometry.diagnostics,
  }));
  for (const field of ['positions', 'normals', 'paletteSlots', 'bendWeights', 'phaseGroups',
    'detailRoles', 'lodWeights', 'indices']) hash = hashBytes(geometry[field], hash);
  return hash.toString(16).padStart(8, '0');
}

const geometryLibraryRecords = new Map();

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function profileGeometryStats(profileName) {
  const records = [...geometryLibraryRecords.values()].filter(record => record.library.profile === profileName);
  return {
    archetypes: records.reduce((sum, record) => sum + record.library.diagnostics.cachedArchetypes, 0),
    bytes: records.reduce((sum, record) => sum + record.library.diagnostics.estimatedBytes, 0),
  };
}

function createPlantGeometryLibrary(profileName, environmentKey, seedSalt) {
  const profile = GDO_PLANT_GEOMETRY_PROFILES[profileName];
  const skeletonHandle = acquirePlantArchetypeLibrary({ profile: profileName, environmentKey, seedSalt });
  const geometries = new Map();
  let disposed = false, hits = 0, misses = 0, totalCompileMilliseconds = 0, maximumCompileMilliseconds = 0;
  const getGeometry = (family, archetypeIndex = 0) => {
    if (disposed) throw new Error('Plant geometry library is disposed');
    if (!GDO_PLANT_FAMILY_RECIPES[family]) throw new RangeError(`Unknown plant family: ${family}`);
    if (!Number.isInteger(archetypeIndex) || archetypeIndex < 0 || archetypeIndex >= GDO_PLANT_PROFILES[profileName].variantsPerFamily) {
      throw new RangeError(`${profileName} supports archetype indices 0–${GDO_PLANT_PROFILES[profileName].variantsPerFamily - 1}`);
    }
    const key = `${family}:${archetypeIndex}`;
    const cached = geometries.get(key);
    if (cached) { hits++; return cached; }
    const profileStats = profileGeometryStats(profileName);
    if (profileStats.archetypes >= profile.maxCachedArchetypes) {
      throw new Error(`Plant geometry archetype cap reached: ${profile.maxCachedArchetypes}`);
    }
    const skeleton = skeletonHandle.library.getArchetype(family, archetypeIndex);
    const started = now();
    const geometry = compilePlantGeometry(skeleton);
    const elapsed = now() - started;
    if (profileStats.bytes + geometry.diagnostics.estimatedBytes > profile.maxCachedBytes) {
      throw new Error(`Plant geometry byte cap reached: ${profile.maxCachedBytes}`);
    }
    totalCompileMilliseconds += elapsed;
    maximumCompileMilliseconds = Math.max(maximumCompileMilliseconds, elapsed);
    misses++;
    geometries.set(key, geometry);
    return geometry;
  };
  const diagnostics = Object.freeze({
    namespace: GDO_PLANT_GEOMETRY_NAMESPACE,
    profile: profileName,
    environmentKey,
    get cachedArchetypes() { return geometries.size; },
    get hits() { return hits; },
    get misses() { return misses; },
    get totalCompileMilliseconds() { return totalCompileMilliseconds; },
    get maximumCompileMilliseconds() { return maximumCompileMilliseconds; },
    get estimatedBytes() { return [...geometries.values()].reduce((sum, item) => sum + item.diagnostics.estimatedBytes, 0); },
    get boxes() { return [...geometries.values()].reduce((sum, item) => sum + item.diagnostics.boxesEmitted, 0); },
    get exposedFaces() { return [...geometries.values()].reduce((sum, item) => sum + item.diagnostics.exposedFaces, 0); },
    get trianglesBefore() { return [...geometries.values()].reduce((sum, item) => sum + item.diagnostics.trianglesBefore, 0); },
    get trianglesAfter() { return [...geometries.values()].reduce((sum, item) => sum + item.diagnostics.trianglesAfter, 0); },
    get endCapsRemoved() { return [...geometries.values()].reduce((sum, item) => sum + item.diagnostics.endCapsRemoved, 0); },
    get hiddenFacesRemoved() { return [...geometries.values()].reduce((sum, item) => sum + item.diagnostics.hiddenFacesRemoved, 0); },
    get facesMerged() { return [...geometries.values()].reduce((sum, item) => sum + item.diagnostics.facesMerged, 0); },
    get maximumBoxes() { return Math.max(0, ...[...geometries.values()].map(item => item.diagnostics.boxesEmitted)); },
    get maximumTriangles() { return Math.max(0, ...[...geometries.values()].map(item => item.diagnostics.trianglesAfter)); },
    get disposed() { return disposed; },
    limits: profile,
  });
  return Object.freeze({
    profile: profileName,
    environmentKey,
    variantsPerFamily: GDO_PLANT_PROFILES[profileName].variantsPerFamily,
    families: Object.freeze(Object.keys(GDO_PLANT_FAMILY_RECIPES)),
    diagnostics,
    getGeometry,
    getForPlacement(record) {
      if (!record || !GDO_PLANT_FAMILY_RECIPES[record.family]) throw new TypeError('Invalid plant placement record');
      return getGeometry(record.family, record.archetypeIndex % GDO_PLANT_PROFILES[profileName].variantsPerFamily);
    },
    clear() {
      if (disposed) return;
      geometries.clear();
      skeletonHandle.release();
      disposed = true;
    },
  });
}

/** Reference-counted geometry cache; no per-placement compilation is permitted. */
export function acquirePlantGeometryLibrary({
  profile = 'low',
  environmentKey = 'default',
  seedSalt = 0,
} = {}) {
  if (!GDO_PLANT_GEOMETRY_PROFILES[profile]) throw new RangeError(`Unknown plant profile: ${profile}`);
  if (typeof environmentKey !== 'string' || !environmentKey || environmentKey.length > 64) throw new RangeError('Invalid environment key');
  if (!Number.isInteger(seedSalt)) throw new RangeError('Plant seed salt must be an integer');
  const key = `${GDO_PLANT_GEOMETRY_NAMESPACE}:${profile}:${environmentKey}:${seedSalt}`;
  let record = geometryLibraryRecords.get(key);
  if (!record) {
    if (geometryLibraryRecords.size >= GDO_MAX_ACTIVE_PLANT_GEOMETRY_LIBRARIES) {
      throw new Error(`Active plant-geometry-library cap reached: ${GDO_MAX_ACTIVE_PLANT_GEOMETRY_LIBRARIES}`);
    }
    record = { library: createPlantGeometryLibrary(profile, environmentKey, seedSalt), references: 0 };
    geometryLibraryRecords.set(key, record);
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
        geometryLibraryRecords.delete(key);
      }
    },
  });
}

export function plantGeometryLibraryStats() {
  return Object.freeze({
    libraries: geometryLibraryRecords.size,
    references: [...geometryLibraryRecords.values()].reduce((sum, record) => sum + record.references, 0),
    cachedArchetypes: [...geometryLibraryRecords.values()].reduce((sum, record) =>
      sum + record.library.diagnostics.cachedArchetypes, 0),
    estimatedBytes: [...geometryLibraryRecords.values()].reduce((sum, record) =>
      sum + record.library.diagnostics.estimatedBytes, 0),
  });
}
