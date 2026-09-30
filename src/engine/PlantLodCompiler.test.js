import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_MAX_ACTIVE_PLANT_LOD_LIBRARIES,
  GDO_PLANT_LOD_FAMILY_CAPS,
  GDO_PLANT_LOD_NAMESPACE,
  GDO_PLANT_LOD_PROFILES,
  PlantLodSelector,
  acquirePlantLodLibrary,
  compilePlantLodSet,
  plantLodLibraryStats,
  plantLodScheduleSlot,
  plantLodSetFingerprint,
  projectPlantBounds,
  selectPlantLod,
} from './PlantLodCompiler.js';
import {
  compilePlantSkeleton,
  createPlantPlacementRecord,
  recolorPlantSkeleton,
} from './PlantGrammar.js';
import { assertLowProfileBudget } from './PerformanceBudget.js';

const FAMILIES = ['broadleaf', 'palm', 'shrub', 'herb', 'grass', 'bamboo'];
const LODS = ['near', 'mid', 'far'];

function placement(family = 'broadleaf', archetypeIndex = 0, owner = 'tile:14/11727/6820') {
  return createPlantPlacementRecord({
    family,
    archetypeIndex,
    owner,
    position: [4, .2, -7],
    placementSeed: 42,
  });
}

function assertLodSetContract(lodSet, skeleton) {
  assert.equal(lodSet.namespace, GDO_PLANT_LOD_NAMESPACE);
  assert.equal(lodSet.family, skeleton.family);
  assert.equal(lodSet.profile, skeleton.profile);
  assert.equal(lodSet.pivot, skeleton.pivot);
  assert.equal(lodSet.bounds, skeleton.bounds);
  assert.equal(lodSet.envelope, skeleton.envelope);
  assert.deepEqual(Object.keys(lodSet.geometries), LODS);
  assert.deepEqual(Object.keys(lodSet.diagnostics.levels), LODS);
  let bytes = 0;
  for (const lod of LODS) {
    const geometry = lodSet.geometries[lod];
    const level = lodSet.diagnostics.levels[lod];
    assert.equal(geometry.pivot, skeleton.pivot);
    assert.equal(geometry.bounds, skeleton.bounds);
    assert.equal(geometry.envelope, skeleton.envelope);
    assert.equal(geometry.diagnostics.boxesEmitted, level.boxes);
    assert.equal(geometry.diagnostics.trianglesAfter, level.triangles);
    assert.equal(geometry.diagnostics.collisionProxies, 0);
    assert.ok(level.boxes <= level.boxCap);
    assert.match(level.fingerprint, /^[0-9a-f]{8}$/);
    bytes += level.estimatedBytes;
  }
  assert.ok(lodSet.diagnostics.levels.near.boxes >= lodSet.diagnostics.levels.mid.boxes);
  assert.ok(lodSet.diagnostics.levels.mid.boxes >= lodSet.diagnostics.levels.far.boxes);
  assert.ok(lodSet.diagnostics.levels.near.triangles >= lodSet.diagnostics.levels.mid.triangles);
  assert.ok(lodSet.diagnostics.levels.mid.triangles >= lodSet.diagnostics.levels.far.triangles);
  assert.equal(lodSet.diagnostics.estimatedBytes, bytes);
  assert.equal(lodSet.diagnostics.dualDrawLods, 0);
  assert.equal(lodSet.diagnostics.collisionProxies, 0);
  assert.ok(Object.isFrozen(lodSet));
}

test('VEG-05 defines versioned family caps and projected-size policies', () => {
  assert.equal(GDO_PLANT_LOD_NAMESPACE, 'gdo:vegetationLod:v1');
  assert.deepEqual(Object.keys(GDO_PLANT_LOD_PROFILES), ['low', 'balanced', 'high']);
  assert.equal(GDO_PLANT_LOD_PROFILES.low.hysteresis, .18);
  assert.equal(GDO_PLANT_LOD_PROFILES.low.maxReevaluationsHz, 4);
  assert.deepEqual(GDO_PLANT_LOD_PROFILES.low.projectedPixels, { near: 96, mid: 32, far: 6 });
  assert.deepEqual(GDO_PLANT_LOD_FAMILY_CAPS.broadleaf.low, { near: 18, mid: 12, far: 3 });
  assert.deepEqual(GDO_PLANT_LOD_FAMILY_CAPS.grass.low, { near: 3, mid: 2, far: 1 });
  assert.ok(Object.values(GDO_PLANT_LOD_PROFILES).every(profile =>
    profile.hysteresis >= .15 && profile.hysteresis <= .20));
});

test('one skeleton deterministically compiles three monotonically cheaper geometries for every family', () => {
  for (const family of FAMILIES) {
    const skeleton = compilePlantSkeleton({ family, profile: 'low', archetypeIndex: 0 });
    const first = compilePlantLodSet(skeleton);
    const repeated = compilePlantLodSet(skeleton);
    assertLodSetContract(first, skeleton);
    assert.deepEqual(first, repeated, family);
    assert.equal(plantLodSetFingerprint(first), plantLodSetFingerprint(repeated));
    for (const lod of LODS) {
      const retention = first.diagnostics.levels[lod].silhouetteRetention;
      assert.ok(retention.width >= .39, `${family}/${lod} width identity`);
      assert.ok(retention.height >= .85, `${family}/${lod} height identity`);
    }
    assert.ok(first.diagnostics.levels.far.silhouetteRetention.width >= .9, `${family} far width`);
    assert.ok(first.diagnostics.levels.far.silhouetteRetention.height >= .9, `${family} far height`);
    assert.equal(first.diagnostics.levels.far.minimumFeaturePixels,
      GDO_PLANT_LOD_PROFILES.low.minimumFeaturePixels);
    assert.ok(first.diagnostics.levels.far.minimumFeatureWidth > 0);
  }
  const broadleaf = compilePlantLodSet(compilePlantSkeleton({ family: 'broadleaf', profile: 'low' }));
  assert.equal(plantLodSetFingerprint(broadleaf), '99f314b0');
});

test('near/mid/far recipes retain characteristic structures under exact family box caps', () => {
  const expected = {
    broadleaf: [[18, 12, 3], [5, 4, 2]],
    palm: [[16, 10, 3], [4, 4, 2]],
    shrub: [[8, 6, 2], [4, 3, 1]],
    herb: [[5, 4, 1], [2, 2, 1]],
    grass: [[3, 2, 1], [0, 0, 1]],
    bamboo: [[12, 8, 3], [3, 3, 1]],
  };
  for (const family of FAMILIES) {
    const set = compilePlantLodSet(compilePlantSkeleton({ family, profile: 'low' }));
    assert.deepEqual(LODS.map(lod => set.diagnostics.levels[lod].boxes), expected[family][0], `${family} boxes`);
    assert.equal(set.diagnostics.levels.near.selectedClusterPaths.length, expected[family][1][0]);
    assert.equal(set.diagnostics.levels.mid.selectedClusterPaths.length, expected[family][1][1]);
    assert.equal(set.diagnostics.levels.far.aggregatedMasses, expected[family][1][2]);
  }
  const broadleaf = compilePlantLodSet(compilePlantSkeleton({ family: 'broadleaf', profile: 'low' }));
  assert.ok(broadleaf.diagnostics.levels.mid.selectedNodePaths.every(path =>
    path.startsWith('trunk/') || path.startsWith('branch/') || path.startsWith('root/')));
  const palm = compilePlantLodSet(compilePlantSkeleton({ family: 'palm', profile: 'low' }));
  assert.ok(palm.diagnostics.levels.far.selectedNodePaths.some(path => path.startsWith('trunk/')));
});

test('palette changes alter only packed palette bytes across every LOD', () => {
  const skeleton = compilePlantSkeleton({ family: 'broadleaf', profile: 'low', archetypeIndex: 1 });
  const base = compilePlantLodSet(skeleton);
  const recolored = compilePlantLodSet(recolorPlantSkeleton(skeleton, 3));
  for (const lod of LODS) {
    for (const field of ['positions', 'normals', 'indices', 'bendWeights', 'phaseGroups', 'detailRoles', 'lodWeights']) {
      assert.deepEqual(recolored.geometries[lod][field], base.geometries[lod][field], `${lod}/${field}`);
    }
    assert.notDeepEqual(recolored.geometries[lod].paletteSlots, base.geometries[lod].paletteSlots, `${lod}/palette`);
  }
});

test('LOD and quality compilation preserve placement anchors, pivot, and envelope', () => {
  const record = placement('broadleaf', 0);
  const snapshot = structuredClone(record);
  const low = compilePlantLodSet(compilePlantSkeleton({ family: 'broadleaf', profile: 'low' }));
  const high = compilePlantLodSet(compilePlantSkeleton({ family: 'broadleaf', profile: 'high' }));
  assert.deepEqual(record, snapshot);
  assert.deepEqual(low.pivot, high.pivot);
  assert.deepEqual(low.envelope, high.envelope);
  assert.deepEqual(Object.keys(record),
    ['namespace', 'archetypeKey', 'family', 'archetypeIndex', 'owner', 'position', 'yaw', 'scale', 'paletteSlot', 'age', 'windStiffness']);
  for (const set of [low, high]) for (const lod of LODS) {
    assert.equal(set.geometries[lod].pivot, set.pivot);
    assert.equal(set.geometries[lod].bounds, set.bounds);
  }
});

test('projection uses individual yawed bounds, camera distance, scale, FOV, and viewport height', () => {
  const set = compilePlantLodSet(compilePlantSkeleton({ family: 'palm', profile: 'low' }));
  const record = placement('palm');
  const centreY = record.position[1] + (set.bounds.min[1] + set.bounds.max[1]) * .5 * record.scale[1];
  const near = projectPlantBounds(set, record, [record.position[0], centreY, record.position[2] + 20], {
    verticalFovRadians: Math.PI / 3,
    viewportHeight: 720,
  });
  const far = projectPlantBounds(set, record, [record.position[0], centreY, record.position[2] + 40], {
    verticalFovRadians: Math.PI / 3,
    viewportHeight: 720,
  });
  assert.ok(Math.abs(near.projectedPixels / far.projectedPixels - 2) < .08);
  assert.ok(near.heightPixels > 0 && near.widthPixels > 0);
  const tallViewport = projectPlantBounds(set, record, [record.position[0], centreY, record.position[2] + 20], {
    verticalFovRadians: Math.PI / 3,
    viewportHeight: 1440,
  });
  assert.ok(Math.abs(tallViewport.projectedPixels / near.projectedPixels - 2) < 1e-9);
  const narrowFov = projectPlantBounds(set, record, [record.position[0], centreY, record.position[2] + 20], {
    verticalFovRadians: Math.PI / 4,
    viewportHeight: 720,
  });
  assert.ok(narrowFov.projectedPixels > near.projectedPixels);
  assert.throws(() => projectPlantBounds(set, record, [0, 0, 0], { verticalFovRadians: 0, viewportHeight: 720 }), /perspective/);
});

test('15–20% hysteresis holds boundaries and always selects exactly one geometry', () => {
  const threshold = GDO_PLANT_LOD_PROFILES.low.projectedPixels.near;
  assert.deepEqual(selectPlantLod(threshold * 1.05, { profile: 'low', currentLod: 'mid' }), {
    lod: 'mid', rawLod: 'near', projectedPixels: threshold * 1.05, hysteresisHeld: true, crossfade: false,
  });
  assert.equal(selectPlantLod(threshold * 1.19, { profile: 'low', currentLod: 'mid' }).lod, 'near');
  assert.equal(selectPlantLod(threshold * .90, { profile: 'low', currentLod: 'near' }).lod, 'near');
  assert.equal(selectPlantLod(threshold * .80, { profile: 'low', currentLod: 'near' }).lod, 'mid');
  assert.equal(selectPlantLod(0, { profile: 'low', currentLod: 'near' }).lod, 'beyond');
  assert.equal(selectPlantLod(10_000, { profile: 'low', currentLod: 'beyond' }).lod, 'near');
  assert.throws(() => selectPlantLod(-1), /non-negative/);
  assert.throws(() => selectPlantLod(10, { currentLod: 'ultra' }), /Unknown plant LOD/);
});

test('owner-aware selector staggers capped reevaluation and reproduces remount decisions', () => {
  const set = compilePlantLodSet(compilePlantSkeleton({ family: 'broadleaf', profile: 'low' }));
  const record = placement();
  const selector = new PlantLodSelector({ profile: 'low', maxEntries: 2 });
  const request = {
    id: 'tile:plant:1',
    placement: record,
    lodSet: set,
    cameraPosition: [4, 2, -4],
    verticalFovRadians: Math.PI / 3,
    viewportHeight: 720,
    nowMilliseconds: 0,
  };
  const output = {};
  try {
    const first = selector.evaluate(request, output);
    assert.equal(first, output, 'caller-owned output avoids steady-state result allocation');
    assert.equal(first.evaluated, true);
    assert.equal(first.lod, 'near');
    assert.equal(first.geometry, set.geometries.near);
    assert.equal(first.crossfade, false);
    const firstNext = first.nextEvaluationAt;
    assert.ok(firstNext >= 250 && firstNext < 500);
    selector.evaluate({ ...request, nowMilliseconds: 1 }, output);
    assert.equal(output.evaluated, false);
    assert.equal(selector.diagnostics.intervalSkips, 1);
    selector.evaluate({ ...request, nowMilliseconds: 2, focusCellKey: 'adjacent-cell' }, output);
    assert.equal(output.evaluated, true, 'a focus-cell transition bypasses the periodic interval');
    const changedCellNext = output.nextEvaluationAt;
    selector.evaluate({ ...request, nowMilliseconds: changedCellNext + 1, focusCellKey: 'adjacent-cell' }, output);
    assert.equal(output.evaluated, false);
    assert.equal(selector.diagnostics.motionSkips, 1);

    const farRequest = { ...request, cameraPosition: [4, 2, 1000], nowMilliseconds: changedCellNext + 300 };
    selector.evaluate(farRequest, output);
    assert.equal(output.evaluated, true);
    assert.equal(output.lod, 'beyond');
    assert.equal(output.geometry, null);
    const remountLod = output.lod;
    assert.equal(selector.remove(request.id), true);
    selector.evaluate({ ...farRequest, nowMilliseconds: firstNext + 600 }, output);
    assert.equal(output.lod, remountLod);
    assert.equal(output.owner, record.owner);

    const otherRecord = placement('broadleaf', 0, 'tile:other');
    selector.evaluate({ ...request, id: 'tile:plant:2', placement: otherRecord, nowMilliseconds: 1000 }, {});
    assert.throws(() => selector.evaluate({ ...request, id: 'tile:plant:3', nowMilliseconds: 1000 }, {}), /entry cap/);
    assert.throws(() => selector.evaluate({ ...request, placement: otherRecord, nowMilliseconds: 1000 }, {}), /change owner/);
    assert.equal(selector.diagnostics.entries, 2);
    assert.equal(selector.diagnostics.limits.maxReevaluationsHz, 4);
  } finally {
    selector.dispose();
  }
  assert.equal(selector.diagnostics.entries, 0);
  assert.equal(selector.diagnostics.disposed, true);
  assert.throws(() => selector.evaluate(request, {}), /disposed/);

  const slots = new Set(Array.from({ length: 16 }, (_, index) => plantLodScheduleSlot(`plant:${index}`, 8)));
  assert.ok(slots.size >= 6, 'stable spatial IDs spread reevaluation across schedule slots');
  assert.equal(plantLodScheduleSlot('tile:plant:1', 8), plantLodScheduleSlot('tile:plant:1', 8));
});

test('shared LOD libraries compile once, fit low budgets, and release all three geometry tiers', () => {
  const first = acquirePlantLodLibrary({ profile: 'low', environmentKey: 'subtropical' });
  const second = acquirePlantLodLibrary({ profile: 'low', environmentKey: 'subtropical' });
  assert.equal(first.library, second.library);
  assert.deepEqual(plantLodLibraryStats(), {
    libraries: 1, references: 2, cachedSets: 0, cachedGeometries: 0, estimatedBytes: 0,
  });
  for (const family of FAMILIES) for (let variant = 0; variant < first.library.variantsPerFamily; variant++) {
    const set = first.library.getLodSet(family, variant);
    assert.equal(first.library.getLodSet(family, variant), set);
  }
  const diagnostics = first.library.diagnostics;
  assert.equal(diagnostics.cachedSets, 12);
  assert.equal(diagnostics.cachedGeometries, 36);
  assert.equal(diagnostics.misses, 12);
  assert.equal(diagnostics.hits, 12);
  assert.ok(diagnostics.nearTriangles > diagnostics.midTriangles);
  assert.ok(diagnostics.midTriangles > diagnostics.farTriangles);
  assertLowProfileBudget({
    plantLodSets: diagnostics.cachedSets,
    plantLodGeometries: diagnostics.cachedGeometries,
    plantLodBytes: diagnostics.estimatedBytes,
    plantLodEntries: 5_360,
    plantLodReevaluationsHz: diagnostics.limits.maxReevaluationsHz,
  });
  first.release();
  first.release();
  assert.equal(diagnostics.disposed, false);
  second.release();
  second.release();
  assert.equal(diagnostics.disposed, true);
  assert.deepEqual(plantLodLibraryStats(), {
    libraries: 0, references: 0, cachedSets: 0, cachedGeometries: 0, estimatedBytes: 0,
  });
  assert.throws(() => first.library.getLodSet('grass', 0), /disposed/);
});

test('LOD library and input caps fail closed', () => {
  const handles = Array.from({ length: GDO_MAX_ACTIVE_PLANT_LOD_LIBRARIES }, (_, index) =>
    acquirePlantLodLibrary({ profile: 'low', environmentKey: `lod-environment-${index}` }));
  try {
    assert.throws(() => acquirePlantLodLibrary({ profile: 'low', environmentKey: 'one-too-many' }),
      /Active plant-LOD-library cap/);
  } finally {
    handles.forEach(handle => handle.release());
  }
  assert.throws(() => compilePlantLodSet({}), /version-compatible/);
  assert.throws(() => acquirePlantLodLibrary({ profile: 'ultra' }), /Unknown plant profile/);
  assert.throws(() => new PlantLodSelector({ profile: 'low', maxEntries: 5_361 }), /1–5360/);
  assert.deepEqual(plantLodLibraryStats(), {
    libraries: 0, references: 0, cachedSets: 0, cachedGeometries: 0, estimatedBytes: 0,
  });
});
