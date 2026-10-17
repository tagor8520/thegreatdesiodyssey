import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_MAX_ACTIVE_PLANT_GEOMETRY_LIBRARIES,
  GDO_PLANT_DETAIL_ROLES,
  GDO_PLANT_GEOMETRY_LAYOUT,
  GDO_PLANT_GEOMETRY_NAMESPACE,
  GDO_PLANT_GEOMETRY_PROFILES,
  acquirePlantGeometryLibrary,
  compilePlantGeometry,
  plantGeometryFingerprint,
  plantGeometryLibraryStats,
} from './PlantGeometryCompiler.js';
import {
  GDO_PLANT_GRAMMAR_NAMESPACE,
  GDO_PLANT_ORGANS,
  compilePlantSkeleton,
  recolorPlantSkeleton,
} from './PlantGrammar.js';
import { assertLowProfileBudget } from './PerformanceBudget.js';

const FAMILIES = ['broadleaf', 'palm', 'shrub', 'herb', 'grass', 'bamboo'];

function node(id, parent, position, {
  organ = GDO_PLANT_ORGANS.TRUNK,
  radius = .1,
  stiffness = id ? .7 : 1,
  phaseGroup = id & 3,
  lodImportance = id ? .7 : 1,
} = {}) {
  return Object.freeze({
    id,
    parent,
    depth: Math.max(0, id - 1),
    path: id ? `node/${id}` : 'base',
    position: Object.freeze(position),
    direction: Object.freeze([0, 1, 0]),
    length: id ? 1 : 0,
    radius,
    stiffness,
    phaseGroup,
    organ,
    lodImportance,
  });
}

function cluster(id, nodeId, center, extent, paletteSlot = 2) {
  return Object.freeze({
    id,
    node: nodeId,
    path: `cluster/${id}`,
    center: Object.freeze(center),
    extent: Object.freeze(extent),
    paletteSlot,
    depth: 0,
    lodImportance: .6,
    organ: GDO_PLANT_ORGANS.LEAF,
    overlapRole: 'crown-union',
  });
}

function syntheticSkeleton(nodes, clusters = []) {
  return Object.freeze({
    namespace: GDO_PLANT_GRAMMAR_NAMESPACE,
    recipeVersion: 1,
    family: 'broadleaf',
    label: 'test broadleaf',
    profile: 'low',
    archetypeIndex: 0,
    environmentKey: 'test',
    seed: 1,
    unit: 1,
    pivot: Object.freeze([0, 0, 0]),
    envelope: Object.freeze({ radius: 4, height: 4, rootDepth: .2, shape: 'test' }),
    nodes: Object.freeze(nodes),
    clusters: Object.freeze(clusters),
    roots: Object.freeze([]),
    bounds: Object.freeze({
      min: Object.freeze([-4, -.2, -4]),
      max: Object.freeze([4, 4, 4]),
      size: Object.freeze([8, 4.2, 8]),
      pivot: Object.freeze([0, 0, 0]),
    }),
    diagnostics: Object.freeze({ modules: nodes.length - 1 + clusters.length }),
  });
}

function assertGeometryContract(geometry) {
  assert.equal(geometry.namespace, GDO_PLANT_GEOMETRY_NAMESPACE);
  assert.equal(geometry.sourceNamespace, GDO_PLANT_GRAMMAR_NAMESPACE);
  assert.ok(geometry.positions instanceof Float32Array);
  assert.ok(geometry.normals instanceof Float32Array);
  assert.ok(geometry.paletteSlots instanceof Uint8Array);
  assert.ok(geometry.bendWeights instanceof Uint8Array);
  assert.ok(geometry.phaseGroups instanceof Uint8Array);
  assert.ok(geometry.detailRoles instanceof Uint8Array);
  assert.ok(geometry.lodWeights instanceof Uint8Array);
  assert.ok(geometry.indices instanceof Uint16Array);
  const vertices = geometry.positions.length / 3;
  assert.equal(geometry.normals.length, geometry.positions.length);
  for (const attribute of ['paletteSlots', 'bendWeights', 'phaseGroups', 'detailRoles', 'lodWeights']) {
    assert.equal(geometry[attribute].length, vertices, attribute);
  }
  assert.equal(geometry.indices.length % 3, 0);
  assert.equal(geometry.indices.length / 3, geometry.diagnostics.trianglesAfter);
  assert.equal(vertices, geometry.diagnostics.vertices);
  assert.equal(geometry.indices.length, geometry.diagnostics.indices);
  assert.ok(geometry.indices.every(index => index < vertices));
  assert.ok(geometry.positions.every(Number.isFinite));
  assert.ok(geometry.normals.every(Number.isFinite));
  assert.ok(geometry.phaseGroups.every(value => value < 4));
  assert.ok(geometry.detailRoles.every(value => Object.values(GDO_PLANT_DETAIL_ROLES).includes(value)));
  assert.equal(geometry.diagnostics.runtimeCsgOperations, 0);
  assert.equal(geometry.diagnostics.collisionProxies, 0);
  assert.equal(Object.hasOwn(geometry, 'colliders'), false);
  assert.ok(Object.isFrozen(geometry));
}

function triangleNormalDot(geometry, triangleOffset) {
  const indices = geometry.indices;
  const points = [0, 1, 2].map(corner => {
    const index = indices[triangleOffset + corner] * 3;
    return [geometry.positions[index], geometry.positions[index + 1], geometry.positions[index + 2]];
  });
  const first = points[1].map((value, axis) => value - points[0][axis]);
  const second = points[2].map((value, axis) => value - points[0][axis]);
  const normal = [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
  const length = Math.hypot(...normal);
  const vertex = indices[triangleOffset] * 3;
  return (normal[0] * geometry.normals[vertex] + normal[1] * geometry.normals[vertex + 1] +
    normal[2] * geometry.normals[vertex + 2]) / length;
}

test('VEG-04 defines one versioned, tightly packed exposed-face upload contract', () => {
  assert.equal(GDO_PLANT_GEOMETRY_NAMESPACE, 'gdo:vegetationGeometry:v1');
  assert.deepEqual(Object.keys(GDO_PLANT_GEOMETRY_PROFILES), ['low', 'balanced', 'high']);
  assert.equal(GDO_PLANT_GEOMETRY_PROFILES.low.maxBoxes, 18);
  assert.equal(GDO_PLANT_GEOMETRY_PROFILES.low.maxTriangles, 216);
  assert.equal(GDO_PLANT_GEOMETRY_PROFILES.low.maxCachedBytes, 1.5 * 1024 * 1024);
  assert.equal(GDO_PLANT_GEOMETRY_LAYOUT.bendWeight.normalized, true);
  assert.deepEqual(Object.keys(GDO_PLANT_DETAIL_ROLES),
    ['trunk', 'branch', 'root', 'stem', 'culm', 'frond', 'blade', 'leaf', 'flower']);
});

test('all six low families compile deterministically below complete-box ceilings', () => {
  for (const family of FAMILIES) {
    const skeleton = compilePlantSkeleton({ family, profile: 'low', archetypeIndex: 0 });
    const first = compilePlantGeometry(skeleton);
    const repeated = compilePlantGeometry(skeleton);
    assertGeometryContract(first);
    assert.deepEqual(first, repeated, family);
    assert.equal(plantGeometryFingerprint(first), plantGeometryFingerprint(repeated));
    assert.ok(first.diagnostics.boxesEmitted <= GDO_PLANT_GEOMETRY_PROFILES.low.maxBoxes);
    assert.ok(first.diagnostics.trianglesAfter < first.diagnostics.trianglesBefore, family);
    assert.equal(first.diagnostics.exposedFaces,
      first.diagnostics.facesBefore - first.diagnostics.endCapsRemoved -
      first.diagnostics.hiddenFacesRemoved - first.diagnostics.facesMerged);
    assert.deepEqual(first.pivot, skeleton.pivot);
    assert.equal(first.bounds, skeleton.bounds);
    assert.equal(first.envelope, skeleton.envelope);
  }
  const broadleaf = compilePlantGeometry(compilePlantSkeleton({ family: 'broadleaf', profile: 'low' }));
  assert.equal(plantGeometryFingerprint(broadleaf), 'abc8b5e6');
});

test('oriented segment transforms are baked into finite vertices with outward unit normals', () => {
  const skeleton = syntheticSkeleton([
    node(0, -1, [0, 0, 0]),
    node(1, 0, [.7, .8, -.45], { organ: GDO_PLANT_ORGANS.BRANCH }),
  ]);
  const geometry = compilePlantGeometry(skeleton);
  assertGeometryContract(geometry);
  assert.equal(geometry.diagnostics.segmentBoxes, 1);
  assert.equal(geometry.diagnostics.endCapsRemoved, 1);
  assert.equal(geometry.diagnostics.exposedFaces, 5);
  for (let offset = 0; offset < geometry.indices.length; offset += 3) {
    assert.ok(triangleNormalDot(geometry, offset) > .999999, `triangle ${offset / 3} winding`);
  }
  for (let offset = 0; offset < geometry.normals.length; offset += 3) {
    assert.ok(Math.abs(Math.hypot(geometry.normals[offset], geometry.normals[offset + 1], geometry.normals[offset + 2]) - 1) < 1e-6);
  }
});

test('connected segment starts and internal ends omit caps while terminal ends remain', () => {
  const skeleton = syntheticSkeleton([
    node(0, -1, [0, 0, 0]),
    node(1, 0, [0, 1, 0]),
    node(2, 1, [0, 2, 0], { radius: .08 }),
  ]);
  const geometry = compilePlantGeometry(skeleton);
  assert.equal(geometry.diagnostics.boxesEmitted, 2);
  assert.equal(geometry.diagnostics.facesBefore, 12);
  assert.equal(geometry.diagnostics.endCapsRemoved, 3);
  assert.equal(geometry.diagnostics.exposedFaces, 9);
  assert.equal(geometry.diagnostics.trianglesBefore, 24);
  assert.equal(geometry.diagnostics.trianglesAfter, 18);
});

test('touching crown boxes remove contained faces then merge compatible coplanar faces', () => {
  const base = node(0, -1, [0, 0, 0]);
  const skeleton = syntheticSkeleton([base], [
    cluster(0, 0, [-.5, 1, 0], [.5, .5, .5]),
    cluster(1, 0, [.5, 1, 0], [.5, .5, .5]),
  ]);
  const geometry = compilePlantGeometry(skeleton);
  assertGeometryContract(geometry);
  assert.equal(geometry.diagnostics.crownBoxes, 2);
  assert.equal(geometry.diagnostics.hiddenFacesRemoved, 2);
  assert.equal(geometry.diagnostics.facesMerged, 4);
  assert.equal(geometry.diagnostics.exposedFaces, 6);
  assert.equal(geometry.diagnostics.trianglesBefore, 24);
  assert.equal(geometry.diagnostics.trianglesAfter, 12);
});

test('palette remapping changes only packed palette bytes, never geometry or wind topology', () => {
  const skeleton = compilePlantSkeleton({ family: 'broadleaf', profile: 'low', archetypeIndex: 1 });
  const base = compilePlantGeometry(skeleton);
  const recolored = compilePlantGeometry(recolorPlantSkeleton(skeleton, 3));
  for (const field of ['positions', 'normals', 'indices', 'bendWeights', 'phaseGroups', 'detailRoles', 'lodWeights']) {
    assert.deepEqual(recolored[field], base[field], field);
  }
  assert.notDeepEqual(recolored.paletteSlots, base.paletteSlots);
  assert.notEqual(plantGeometryFingerprint(recolored), plantGeometryFingerprint(base));
});

test('minimum feature, overlap, malformed input, and module ceilings fail closed or omit safely', () => {
  const tiny = syntheticSkeleton([node(0, -1, [0, 0, 0])], [
    cluster(0, 0, [0, .2, 0], [.001, .1, .1]),
  ]);
  const omitted = compilePlantGeometry(tiny);
  assert.equal(omitted.diagnostics.inputModules, 1);
  assert.equal(omitted.diagnostics.boxesEmitted, 0);
  assert.equal(omitted.diagnostics.boxesOmitted, 1);
  assert.equal(omitted.positions.length, 0);
  assert.equal(omitted.diagnostics.compileOptions.minimumFeatureSize,
    GDO_PLANT_GEOMETRY_PROFILES.low.minimumFeatureSize);
  assert.equal(compilePlantGeometry(tiny, { minimumFeatureSize: .001 }).diagnostics.compileOptions.minimumFeatureSize,
    GDO_PLANT_GEOMETRY_PROFILES.low.minimumFeatureSize, 'callers cannot lower the profile minimum');
  assert.throws(() => compilePlantGeometry(tiny, { jointOverlap: .02 }), /3% and 8%/);
  assert.throws(() => compilePlantGeometry(tiny, { jointOverlap: .09 }), /3% and 8%/);
  assert.throws(() => compilePlantGeometry({ ...tiny, namespace: 'old' }), /version-compatible/);
  assert.throws(() => compilePlantGeometry({ ...tiny, nodes: Object.freeze([
    node(0, -1, [0, 0, 0]),
    ...Array.from({ length: 19 }, (_, index) => node(index + 1, index, [0, index + 1, 0])),
  ]) }), /geometry cap/);
});

test('shared geometry libraries compile each variant once and release skeleton/typed-array ownership', () => {
  const first = acquirePlantGeometryLibrary({ profile: 'low', environmentKey: 'subtropical' });
  const second = acquirePlantGeometryLibrary({ profile: 'low', environmentKey: 'subtropical' });
  assert.equal(first.library, second.library);
  assert.deepEqual(plantGeometryLibraryStats(), { libraries: 1, references: 2, cachedArchetypes: 0, estimatedBytes: 0 });
  for (const family of FAMILIES) for (let variant = 0; variant < first.library.variantsPerFamily; variant++) {
    const geometry = first.library.getGeometry(family, variant);
    assert.equal(first.library.getGeometry(family, variant), geometry);
  }
  const diagnostics = first.library.diagnostics;
  assert.equal(diagnostics.cachedArchetypes, FAMILIES.length * 2);
  assert.equal(diagnostics.misses, FAMILIES.length * 2);
  assert.equal(diagnostics.hits, FAMILIES.length * 2);
  assert.ok(diagnostics.endCapsRemoved > 0);
  assert.ok(diagnostics.trianglesAfter < diagnostics.trianglesBefore);
  assertLowProfileBudget({
    plantGeometryArchetypes: diagnostics.cachedArchetypes,
    plantGeometryBoxes: diagnostics.maximumBoxes,
    plantGeometryTriangles: diagnostics.maximumTriangles,
    plantGeometryBytes: diagnostics.estimatedBytes,
  });
  first.release();
  first.release();
  assert.equal(diagnostics.disposed, false);
  second.release();
  second.release();
  assert.equal(diagnostics.disposed, true);
  assert.deepEqual(plantGeometryLibraryStats(), { libraries: 0, references: 0, cachedArchetypes: 0, estimatedBytes: 0 });
  assert.throws(() => first.library.getGeometry('grass', 0), /disposed/);
});

test('active geometry libraries are strictly bounded across environment keys', () => {
  const handles = Array.from({ length: GDO_MAX_ACTIVE_PLANT_GEOMETRY_LIBRARIES }, (_, index) =>
    acquirePlantGeometryLibrary({ profile: 'low', environmentKey: `geometry-environment-${index}` }));
  assert.throws(() => acquirePlantGeometryLibrary({ profile: 'low', environmentKey: 'one-too-many' }),
    /Active plant-geometry-library cap/);
  handles.forEach(handle => handle.release());
  assert.deepEqual(plantGeometryLibraryStats(), { libraries: 0, references: 0, cachedArchetypes: 0, estimatedBytes: 0 });
});
