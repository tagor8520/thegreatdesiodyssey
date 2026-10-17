import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import { GDO_PLANT_LOD_FAMILY_CAPS } from './PlantLodCompiler.js';
import { GEO_PLANT_TYPE_FAMILIES } from '../geo/PlantClearance.js';
import { compileGeoFixture } from '../geo/GeoFixtures.js';
import { GeoWorld } from '../geo/GeoWorld.js';
import {
  GDO_PLANT_SILHOUETTE_NAMESPACE,
  PLANT_SILHOUETTE_PATHS,
  PLANT_SILHOUETTE_THRESHOLDS,
  createPlantSilhouetteAuditRunner,
  evaluatePlantFamilyMatch,
  evaluatePlantFamilyVariety,
  evaluatePlantFarDetailFloor,
  evaluatePlantLodSwitching,
  evaluatePlantSilhouetteCost,
  evaluatePlantSilhouetteRetention,
  runPlantSilhouetteAudit,
} from './PlantSilhouetteAudit.js';

/**
 * `VEG-02` gate: the silhouette and its LOD cost are measured on the real pooled
 * vegetation, deterministically, without a browser or a screenshot.
 */

const FAMILIES = Object.freeze(['broadleaf', 'palm', 'bamboo', 'shrub']);

function levels({ boxes = [18, 10, 3], triangles = [216, 120, 36], retention = [1, 1, .98, .96, .96, .93], masses = 1, segments = 1 } = {}) {
  const [nearWidth, nearHeight, midWidth, midHeight, farWidth, farHeight] = retention;
  return {
    near: { boxCap: 28, boxes: boxes[0], triangles: triangles[0], silhouetteRetention: { width: nearWidth, height: nearHeight }, selectedNodePaths: ['trunk/0'], aggregatedMasses: 3, minimumFeaturePixels: .75, minimumFeatureWidth: 1.25 },
    mid: { boxCap: 12, boxes: boxes[1], triangles: triangles[1], silhouetteRetention: { width: midWidth, height: midHeight }, selectedNodePaths: ['trunk/0'], aggregatedMasses: 2, minimumFeaturePixels: .75, minimumFeatureWidth: 1.25 },
    far: { boxCap: 3, boxes: boxes[2], triangles: triangles[2], silhouetteRetention: { width: farWidth, height: farHeight }, selectedNodePaths: Array.from({ length: segments }, (_, index) => `lod/far/segment/${index}`), aggregatedMasses: masses, minimumFeaturePixels: .75, minimumFeatureWidth: 1.25 },
  };
}

function stubSample(overrides = {}) {
  const familySets = {};
  for (const family of FAMILIES) familySets[family] = { levels: levels(), boundsSize: [4, 3.2, 4] };
  return {
    profile: 'low',
    entries: 120,
    instances: 120,
    drawnInstances: 96,
    boxModules: 1_240,
    triangles: 21_400,
    drawPools: 9,
    sourceGeometries: 18,
    byLod: { near: 8, mid: 32, far: 56, beyond: 24 },
    switches: 4,
    hysteresisHolds: 2,
    evaluations: 96,
    elapsedMilliseconds: 2_000,
    families: [...FAMILIES],
    familySets,
    placements: FAMILIES.flatMap(family => [{ family, expectedFamily: family }]),
    camera: { x: 0, y: 1.6, z: 0 },
    ...overrides,
  };
}

function stubRun(overrides = {}) {
  return runPlantSilhouetteAudit({
    step() {},
    probe: () => stubSample(overrides),
    repeat: 1,
  });
}

test('the cost verdict reads the live box, triangle, and pool ceilings', () => {
  assert.equal(GDO_PLANT_SILHOUETTE_NAMESPACE, 'gdo:plantSilhouetteAudit:v1');
  assert.equal(PLANT_SILHOUETTE_PATHS.reduce((sum, path) => sum + path.steps, 0) * 1, 64,
    'the scripted walk covers more than 30 game-space metres');
  assert.equal(PLANT_SILHOUETTE_THRESHOLDS.maximumBoxModules, GDO_LOW_PROFILE_BUDGETS.plantBoxModulesAfterLod);
  assert.equal(PLANT_SILHOUETTE_THRESHOLDS.maximumVisibleTriangles, GDO_LOW_PROFILE_BUDGETS.plantRenderVisibleTriangles);
  assert.equal(PLANT_SILHOUETTE_THRESHOLDS.minimumFarRetention, GDO_LOW_PROFILE_BUDGETS.plantFarSilhouetteRetention);
  assert.equal(PLANT_SILHOUETTE_THRESHOLDS.minimumLodRetention, .8);
  assert.equal(PLANT_SILHOUETTE_THRESHOLDS.minimumLargePlantFamilies, 3);

  const samples = [{ sample: stubSample() }];
  assert.equal(evaluatePlantSilhouetteCost(samples).ok, true);
  const over = [{ sample: stubSample({ boxModules: 6_001 }) }];
  const verdict = evaluatePlantSilhouetteCost(over);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.measured.boxModules, 6_001);
  assert.equal(evaluatePlantSilhouetteCost([{ sample: stubSample({ triangles: 75_001 }) }]).ok, false);
  assert.equal(evaluatePlantSilhouetteCost([{ sample: stubSample({ drawPools: 19 }) }]).ok, false);
  assert.equal(evaluatePlantSilhouetteCost([{ sample: stubSample({ sourceGeometries: 49 }) }]).ok, false);
});

test('near/mid/far retention, monotonic cost, and the family far-grammar caps are enforced', () => {
  const passing = evaluatePlantSilhouetteRetention({ family: 'broadleaf', ...stubSample().familySets.broadleaf, levels: levels() });
  assert.equal(passing.ok, true);
  // Far geometry that drops below the family silhouette fails.
  const thin = levels({ retention: [1, 1, .98, .96, .7, .95] });
  const thinVerdict = evaluatePlantSilhouetteRetention({ family: 'broadleaf', levels: thin, boundsSize: [4, 3.2, 4] });
  assert.equal(thinVerdict.ok, false);
  assert.equal(thinVerdict.measured.far.width, .7);
  // A tier that discards more than a fifth of the envelope fails, whichever tier
  // it is; the shipped shrub keeps 86%, which is inside the floor.
  assert.equal(evaluatePlantSilhouetteRetention({ family: 'broadleaf', levels: levels({ retention: [1, 1, .75, .96, .96, .93] }), boundsSize: [4, 3.2, 4] }).ok, false);
  assert.equal(evaluatePlantSilhouetteRetention({ family: 'broadleaf', levels: levels({ retention: [.7, 1, .98, .96, .96, .93] }), boundsSize: [4, 3.2, 4] }).ok, false);
  assert.equal(evaluatePlantSilhouetteRetention({ family: 'shrub', levels: levels({ boxes: [8, 6, 2], triangles: [88, 66, 22], retention: [.86, .97, .86, .97, 1, .99] }), boundsSize: [1.5, 1.2, 1.67] }).ok, true);
  // Retention may exceed the source envelope (a far mass rebuilt wider than the
  // source is legal): only the floor and the near reference are enforced.
  assert.equal(evaluatePlantSilhouetteRetention({ family: 'palm', levels: levels({ retention: [1, 1, 1, .97, 1.02, 1.03] }), boundsSize: [2.5, 4.2, 2.5] }).ok, true);
  // Non-monotonic cost fails even when retention is perfect.
  const expensiveFar = levels({ boxes: [18, 10, 12], triangles: [216, 120, 140] });
  assert.equal(evaluatePlantSilhouetteRetention({ family: 'palm', levels: expensiveFar, boundsSize: [4, 3.2, 4] }).ok, false);
  // A far tier that keeps more masses/segments than the family declares fails.
  const grassCaps = GDO_PLANT_LOD_FAMILY_CAPS.grass;
  assert.equal(grassCaps.farMasses, 1);
  const bloated = levels({ masses: 3, segments: 3 });
  assert.equal(evaluatePlantSilhouetteRetention({ family: 'grass', levels: bloated, boundsSize: [1, .6, 1] }).ok, false);
  // A family with no compiled levels cannot claim retention at all.
  assert.equal(evaluatePlantSilhouetteRetention({ family: 'broadleaf' }).ok, false);
});

test('the far-detail floor recomputes the threshold from the source bounds', () => {
  const profile = { minimumFeaturePixels: .75, far: 6 };
  const requiredWidth = 4 * profile.minimumFeaturePixels / profile.far;
  const passing = evaluatePlantFarDetailFloor({
    family: 'broadleaf', profile: 'low', boundsSize: [4, 3.2, 4],
    levels: { ...levels(), far: { ...levels().far, minimumFeatureWidth: requiredWidth, minimumFeaturePixels: .75 } },
  });
  assert.equal(passing.ok, true);
  assert.equal(passing.measured.requiredWidth, requiredWidth);
  const failing = evaluatePlantFarDetailFloor({
    family: 'broadleaf', profile: 'low', boundsSize: [4, 3.2, 4],
    levels: { ...levels(), far: { ...levels().far, minimumFeatureWidth: requiredWidth * .5, minimumFeaturePixels: .75 } },
  });
  assert.equal(failing.ok, false);
  // A far tier compiled against a different pixel threshold is not proof either.
  const wrongPixels = evaluatePlantFarDetailFloor({
    family: 'broadleaf', profile: 'low', boundsSize: [4, 3.2, 4],
    levels: { ...levels(), far: { ...levels().far, minimumFeatureWidth: requiredWidth, minimumFeaturePixels: .5 } },
  });
  assert.equal(wrongPixels.ok, false);
  assert.equal(evaluatePlantFarDetailFloor({ family: 'broadleaf', profile: 'low' }).ok, false);
});

test('family variety and type/family agreement are separate verdicts', () => {
  const samples = [{ sample: stubSample() }];
  assert.equal(evaluatePlantFamilyVariety(samples).ok, true);
  const shrubOnly = [{ sample: stubSample({ families: ['shrub'] }) }];
  const variety = evaluatePlantFamilyVariety(shrubOnly);
  assert.equal(variety.ok, false);
  assert.deepEqual(variety.measured.large, 0);
  assert.equal(evaluatePlantFamilyMatch(samples).ok, true);
  const mismatch = [{ sample: stubSample({ placements: [{ family: 'herb', expectedFamily: 'grass' }] }) }];
  const match = evaluatePlantFamilyMatch(mismatch);
  assert.equal(match.ok, false);
  assert.match(match.detail, /herb≠grass/);
  // The real mapping is what the probe reports as the expected family.
  assert.equal(GEO_PLANT_TYPE_FAMILIES[0], 'broadleaf');
  assert.equal(GEO_PLANT_TYPE_FAMILIES[12], 'bamboo');
});

test('LOD switching keeps one active tier per instance and a bounded rate', () => {
  const samples = [
    { input: { elapsedMilliseconds: 0 }, sample: stubSample({ evaluations: 120 }) },
    { input: { elapsedMilliseconds: 2_000 }, sample: stubSample({ evaluations: 1_000 }) },
  ];
  assert.equal(evaluatePlantLodSwitching(samples).ok, true);
  // Instances that draw in two buckets, or none at all, are the failure the
  // 'one active LOD' rule exists for.
  const doubleDrawn = [{ input: { elapsedMilliseconds: 0 }, sample: stubSample({ drawnInstances: 97 }) }];
  assert.equal(evaluatePlantLodSwitching(doubleDrawn).ok, false);
  const hidden = [{ input: { elapsedMilliseconds: 0 }, sample: stubSample({ drawnInstances: 95 }) }];
  assert.equal(evaluatePlantLodSwitching(hidden).ok, false);
  // A reevaluation rate above the declared profile ceiling is not allowed, even
  // when every instance still draws exactly once.
  // 120 instances at the 4 Hz low-profile ceiling allow ~4.3 s of walk × 4 Hz
  // reevaluations; the verdict measures the delta across the walk window.
  const slow = [
    { input: { elapsedMilliseconds: 0 }, sample: stubSample({ evaluations: 120 }) },
    { input: { elapsedMilliseconds: 2_000 }, sample: stubSample({ evaluations: 1_080 }) },
  ];
  assert.equal(evaluatePlantLodSwitching(slow).ok, true);
  const fast = [
    { input: { elapsedMilliseconds: 0 }, sample: stubSample({ evaluations: 120 }) },
    { input: { elapsedMilliseconds: 2_000 }, sample: stubSample({ evaluations: 4_800 }) },
  ];
  const rate = evaluatePlantLodSwitching(fast);
  assert.equal(rate.ok, false);
  assert.equal(rate.measured.rateViolations, 1);
  assert.equal(rate.measured.perInstanceHz > 4, true);
  // Unlimited switching across every instance is not a passing walk either.
  const thrash = [
    { input: { elapsedMilliseconds: 0 }, sample: stubSample() },
    { input: { elapsedMilliseconds: 2_000 }, sample: stubSample({ switches: 400 }) },
  ];
  assert.equal(evaluatePlantLodSwitching(thrash).ok, false);
});

test('the runner is deterministic and names the verdicts that failed', () => {
  let walked = 0;
  const runner = createPlantSilhouetteAuditRunner({
    step: () => { walked++; },
    probe: () => stubSample(),
    repeat: 2,
  });
  const report = runner.run();
  assert.equal(report.ok, true);
  assert.equal(report.namespace, GDO_PLANT_SILHOUETTE_NAMESPACE);
  assert.equal(report.samples, PLANT_SILHOUETTE_PATHS.reduce((sum, path) => sum + path.steps, 0));
  assert.equal(walked, report.samples * 2, 'both passes walk every path');
  assert.equal(report.families.length, FAMILIES.length);
  assert.equal(report.detail.includes('passed'), true);
  assert.match(runner.summary(), /plantSilhouetteAudit:v1 pass/);
  assert.equal(runner.run({ repeat: 1 }).samples, report.samples);
  assert.equal(runner.ok, true);

  const again = runner.run();
  assert.equal(again.fingerprint, report.fingerprint, 'identical input produces an identical fingerprint');
  assert.deepEqual(again.verdicts, report.verdicts);

  const failing = runPlantSilhouetteAudit({
    step() {},
    probe: () => stubSample({ boxModules: 9_999, families: ['herb'] }),
    repeat: 1,
  });
  assert.equal(failing.ok, false);
  assert.match(failing.detail, /failed: cost\.boxModules, silhouette\.familyVariety/);
  assert.throws(() => runPlantSilhouetteAudit({ step() {} }), /needs step\(input\) and probe\(\)/);
  assert.throws(() => runPlantSilhouetteAudit({ probe() {} }), /needs step\(input\) and probe\(\)/);
});

// --- Real world integration -------------------------------------------------

function createFixtureWorld(fixture = 'dense-urban') {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  const world = new GeoWorld(new THREE.Scene(), { latitude: 28.9845, longitude: 77.7064 });
  const tile = [...world.tiles.values()][0];
  const compilation = compileGeoFixture(fixture, 'openmaptiles');
  const common = {
    type: 'tile-phase', requestId: tile.requestId, key: tile.key, bytes: 2048,
    provider: `Fixture/${compilation.fixture.variant}`, providerId: compilation.fixture.variant,
  };
  world._handleWorkerMessage({ ...common, phase: 'roads', geometry: compilation.roads, timings: { fetchMilliseconds: 1 } });
  world._handleWorkerMessage({ ...common, phase: 'context', context: compilation.context, timings: { fetchMilliseconds: 1 } });
  world._handleWorkerMessage({ ...common, phase: 'buildings', geometry: compilation.buildings, timings: { fetchMilliseconds: 1 } });
  world._flushPlantMounts(0);
  return {
    world, tile,
    dispose() {
      world.dispose();
      globalThis.Worker = previousWorker;
    },
  };
}

test('the shipping coordinate vegetation passes every silhouette/cost verdict', () => {
  const fixture = createFixtureWorld('dense-urban');
  try {
    const { world } = fixture;
    const camera = new THREE.PerspectiveCamera(68, 1, .02, 210);
    const origin = { x: camera.position.x, z: camera.position.z };
    // A deterministic audit means the same scripted walk from the same start:
    // each pass restores the camera and clears the live LOD selection state.
    const reset = () => {
      camera.position.set(origin.x, 1.6, origin.z);
      camera.updateMatrixWorld();
      world.plantLodSelector.clear();
    };
    const step = input => {
      const yaw = (input.yawTurns ?? 0) * Math.PI * 2;
      const distance = (input.forward ?? 0) * 1;
      camera.position.x += Math.sin(yaw) * distance;
      camera.position.z += Math.cos(yaw) * distance;
      camera.position.y = 1.6;
      world.update({ x: 0, y: 0, z: 0 }, camera, 720, input.elapsedMilliseconds);
    };
    // The runtime probe is the world's own sampler: one reused record per call.
    const first = world.plantSilhouetteSample();
    assert.equal(world.plantSilhouetteSample(), first, 'the runtime sampler reuses one record');
    assert.equal(first.entries > 0, true);
    assert.equal(first.instances, first.entries);
    assert.equal(first.drawnInstances <= first.entries, true);
    assert.equal(first.boxModules > 0, true);
    assert.equal(first.families.length >= 3, true);
    const report = runPlantSilhouetteAudit({
      step, probe: () => world.plantSilhouetteSample(), reset, warmup: true, label: 'dense-urban',
    });
    assert.equal(report.ok, true, report.detail);
    assert.equal(report.families.length >= 3, true, `compiled families: ${report.families.join(', ')}`);
    const byId = Object.fromEntries(report.verdicts.map(verdict => [verdict.id, verdict]));
    for (const family of report.families) {
      assert.equal(byId[`silhouette.retention.${family}`].ok, true, `${family} retention`);
      assert.equal(byId[`silhouette.farDetailFloor.${family}`].ok, true, `${family} far-detail floor`);
    }
    assert.equal(byId['lod.switching'].ok, true);
    assert.equal(byId['cost.boxModules'].measured.boxModules <= GDO_LOW_PROFILE_BUDGETS.plantBoxModulesAfterLod, true);
    assert.equal(byId['cost.boxModules'].measured.triangles <= GDO_LOW_PROFILE_BUDGETS.plantRenderVisibleTriangles, true);
    assert.equal(byId['cost.boxModules'].measured.boxModules > 0, true, 'the fixture really mounts pooled vegetation');

    // Deleting the resident pools must fail the audit rather than pass vacuously.
    const empty = runPlantSilhouetteAudit({
      step,
      probe: () => ({ ...world.plantSilhouetteSample(), entries: 0, instances: 0, drawnInstances: 0, boxModules: 0, families: [], familySets: {}, placements: [] }),
      warmup: true,
      label: 'empty',
    });
    assert.equal(empty.ok, false);
    assert.match(empty.detail, /silhouette\.familyVariety/);
  } finally {
    fixture.dispose();
  }
});
