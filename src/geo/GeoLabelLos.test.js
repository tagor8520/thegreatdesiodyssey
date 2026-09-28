import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';
import { GEO_QUERY_MASK } from './GeoCollision.js';
import { buildGeoDebugSnapshot } from './GeoDiagnostics.js';
import { compileGeoFixture } from './GeoFixtures.js';
import { GeoWorld } from './GeoWorld.js';
import { GEO_WATER_CLASS } from './GeoWaterDomains.js';
import {
  GEO_LABEL_LOS_DEFAULTS,
  GEO_LABEL_LOS_NAMESPACE,
  GEO_LABEL_LOS_PROFILES,
  createLabelLosTester,
  labelLosBudgetForProfile,
} from './GeoLabelLos.js';

/**
 * `GME-04` gate: label occlusion and the richer map readout, proved on the real
 * world, real colliders, and real labels — no browser, no screenshots.
 */

function applyCompilation(world, tile, compilation) {
  const common = {
    type: 'tile-phase', requestId: tile.requestId, key: tile.key,
    bytes: 2048, provider: `Fixture/${compilation.fixture.variant}`,
    providerId: compilation.fixture.variant,
  };
  world._handleWorkerMessage({
    ...common, phase: 'roads', geometry: compilation.roads,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2 },
  });
  world._handleWorkerMessage({
    ...common, phase: 'context', context: compilation.context,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3 },
  });
  world._handleWorkerMessage({
    ...common, phase: 'buildings', geometry: compilation.buildings,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3, buildingMilliseconds: 4 },
  });
  return tile;
}

function createFixtureWorld(fixture = 'provider-semantics', variant = 'openmaptiles') {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  const world = new GeoWorld(new THREE.Scene(), { latitude: 28.9845, longitude: 77.7064 });
  const tile = [...world.tiles.values()][0];
  applyCompilation(world, tile, compileGeoFixture(fixture, variant));
  return {
    world, tile,
    dispose() {
      world.dispose();
      globalThis.Worker = previousWorker;
    },
  };
}

// The provider-semantics fixture places one building at tile x 2600–3500,
// z 1400–2300 (world 63.5–85.4 by 34.2–56.2) and its names across the tile.
const BEHIND_BUILDING = { x: 74, y: 1.6, z: 20 };
const IN_THE_CLEAR = { x: 12, y: 1.6, z: 12 };

test('label LOS budgets match the declared research ceilings per profile', () => {
  assert.equal(GEO_LABEL_LOS_NAMESPACE, 'gdo:labelLos:v1');
  assert.deepEqual(labelLosBudgetForProfile('low'), { testsPerSecond: 20, candidates: 5 });
  assert.deepEqual(labelLosBudgetForProfile('balanced'), { testsPerSecond: 40, candidates: 10 });
  assert.deepEqual(labelLosBudgetForProfile('high'), { testsPerSecond: 80, candidates: 14 });
  assert.equal(labelLosBudgetForProfile('unknown-profile'), GEO_LABEL_LOS_PROFILES.low);
  // The published low ceiling is the same number in one place and the other.
  assert.equal(GEO_LABEL_LOS_PROFILES.low.testsPerSecond, GDO_LOW_PROFILE_BUDGETS.labelLosTestsPerSecond);
  assert.equal(GEO_LABEL_LOS_PROFILES.low.candidates, GDO_LOW_PROFILE_BUDGETS.labelLosCandidates);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.labelLosSteadyFrameAllocations, 0);
  assert.ok(GEO_LABEL_LOS_DEFAULTS.radius > 0 && GEO_LABEL_LOS_DEFAULTS.staleMilliseconds > 0);

  assert.throws(() => createLabelLosTester({}), /shared sweep query/);
  assert.throws(() => createLabelLosTester({ world: { sweepSphere() {} }, radius: 0 }), /radius must be positive/);
  assert.throws(() => createLabelLosTester({ world: { sweepSphere() {} }, staleMilliseconds: -1 }), /stale window must be positive/);
});

test('a label occluded by a building is hidden, a clear one stays visible', () => {
  const fixture = createFixtureWorld();
  try {
    const { world } = fixture;
    const tester = createLabelLosTester({ world, profile: 'low' });
    const labels = world.visibleLabels;
    assert.ok(labels.length >= 4, 'the provider-semantics tile carries place, water and street names');
    // Collider masks prove the sweep is role-aware: structures carry LOS bits.
    const tile = [...world.tiles.values()][0];
    assert.ok(tile.collisionMasks?.length, 'mounted buildings carry explicit semantic masks');
    const losProxies = [...tile.collisionMasks].filter(mask => (mask & GEO_QUERY_MASK.LOS_BLOCKER) !== 0).length;
    assert.ok(losProxies > 0, 'at least one mounted structural proxy is an LOS blocker');

    // The mapped building spans world x 63.5–85.4, z 34.2–56.2 at ~2.2 units
    // tall, and the town label sits at x 34.2, z 83.
    assert.equal(tester.probe(BEHIND_BUILDING.x, BEHIND_BUILDING.y, BEHIND_BUILDING.z, 34.2, 1.25, 83), true,
      'the building sits between this eye and the town label');
    assert.equal(tester.probe(IN_THE_CLEAR.x, IN_THE_CLEAR.y, IN_THE_CLEAR.z, 34.2, 1.25, 83), false,
      'the same label is unobstructed from the open side');
    const pondLabel = labels.find(label => label.name === 'Semantics Pond');
    assert.equal(tester.probe(IN_THE_CLEAR.x, IN_THE_CLEAR.y, IN_THE_CLEAR.z, pondLabel.x, pondLabel.y + .28, pondLabel.z), false,
      'the ray to a visible water label is clear');
    // A ray that flies over the roof is clear: only structural proxies block LOS.
    assert.equal(tester.probe(BEHIND_BUILDING.x, 12, BEHIND_BUILDING.z, 34.2, 1.25, 83), false);

    // The full path: an occluded label leaves the visible set, a clear one stays.
    const camera = new THREE.PerspectiveCamera();
    const behind = { position: new THREE.Vector3(BEHIND_BUILDING.x, BEHIND_BUILDING.y, BEHIND_BUILDING.z) };
    const clear = { position: new THREE.Vector3(IN_THE_CLEAR.x, IN_THE_CLEAR.y, IN_THE_CLEAR.z) };
    const out = [];
    tester.reset();
    for (let frame = 0; frame < 40; frame++) tester.visibleLabels(labels, clear, frame * 50, out);
    assert.ok(out.some(label => label.name === 'Semantics Town'), 'the town label is visible from the open side');
    tester.reset();
    for (let frame = 0; frame < 40; frame++) tester.visibleLabels(labels, behind, frame * 50, out);
    assert.equal(out.some(label => label.name === 'Semantics Town'), false,
      'a label behind the mapped building is hidden after its LOS verdict');
    assert.ok(tester.diagnostics().hidden >= 1);
  } finally {
    fixture.dispose();
  }
});

test('label LOS ignores foliage, ambience, and placement-only proxies', () => {
  const fixture = createFixtureWorld('dense-urban');
  try {
    const { world, tile } = fixture;
    // The dense fixture carries live visual clutter families and mounted
    // structures; the invariant is that only solid structural proxies are LOS
    // blockers, so grass, birds, bees, and furniture can never hide a name.
    world._flushPlantMounts(0);
    assert.ok(world.plantRenderPools.diagnostics.entries > 0, 'the dense tile mounts pooled plants');
    assert.ok(tile.colliders.length / 4 > 50, 'the dense tile mounts many structural proxies');
    for (const mask of tile.collisionMasks) {
      if ((mask & GEO_QUERY_MASK.LOS_BLOCKER) === 0) continue;
      assert.equal((mask & GEO_QUERY_MASK.SOLID_PLAYER) !== 0, true, 'every LOS blocker is also solid');
      assert.equal((mask & GEO_QUERY_MASK.CAMERA_BLOCKER) !== 0, true, 'every LOS blocker is also a camera blocker');
    }
    // Foliage and ambience are never registered as colliders at all, so the
    // number of LOS blockers equals the number of structural polygons.
    assert.equal([...tile.collisionMasks].every(mask => (mask & GEO_QUERY_MASK.PLACEMENT) === 0 ||
      (mask & GEO_QUERY_MASK.SOLID_PLAYER) !== 0), true);
    const tester = createLabelLosTester({ world, profile: 'low' });
    // A ray far above the tallest allowed roof crosses the whole dense tile
    // without a hit, which is the behavioural half of the same invariant.
    assert.equal(tester.probe(-90, 40, -40, 90, 40, 40), false);
    assert.equal(tester.probe(-90, 40, -40, -80, 40, -30), false);
  } finally {
    fixture.dispose();
  }
});

test('the LOS test rate stays inside the budget and the verdicts are deterministic', () => {
  const run = () => {
    const fixture = createFixtureWorld();
    try {
      const { world } = fixture;
      const labels = world.visibleLabels;
      const tester = createLabelLosTester({ world, profile: 'low' });
      const camera = { position: new THREE.Vector3(BEHIND_BUILDING.x, BEHIND_BUILDING.y, BEHIND_BUILDING.z) };
      const out = [];
      const sequence = [];
      // One simulated second of 60 FPS frames.
      for (let frame = 0; frame <= 60; frame++) {
        tester.visibleLabels(labels, camera, frame * (1000 / 60), out);
        sequence.push(out.map(label => label.name).join('|'));
      }
      return { diagnostics: { ...tester.diagnostics() }, sequence, frames: 61 };
    } finally {
      fixture.dispose();
    }
  };
  const first = run(), second = run();
  assert.ok(first.diagnostics.tests <= GEO_LABEL_LOS_PROFILES.low.testsPerSecond,
    `one second must not exceed the low ceiling, saw ${first.diagnostics.tests}`);
  assert.ok(first.diagnostics.lastBatch <= GEO_LABEL_LOS_PROFILES.low.candidates);
  assert.ok(first.diagnostics.tests > 0);
  assert.deepEqual(first.sequence, second.sequence, 'identical inputs produce identical visibility sequences');
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.equal(first.diagnostics.steadyFrameAllocations, 0);
});

function stubWorld(blockedPredicate = () => false) {
  let calls = 0;
  return {
    sweepSphere(x, y, z, dx, dy, dz, radius, out, mask) {
      calls++;
      const blocked = blockedPredicate(x, y, z, dx, dy, dz);
      out.hit = blocked;
      out.time = blocked ? .5 : 1;
      out.tileKey = 'stub';
      out.polygonIndex = 0;
      out.normalX = 0; out.normalY = 0; out.normalZ = 0;
      return out;
    },
    get calls() { return calls; },
  };
}

test('verdicts rotate over labels, age, and reuse their memory', () => {
  // The stub blocks every probe that travels toward -x, i.e. the left half.
  const world = stubWorld((x, y, z, dx) => dx < 0);
  const labels = Array.from({ length: 40 }, (_, index) => ({ name: `Label ${index}`, kind: 'place', x: index - 20, y: 0, z: 0, priority: 40 - index }));
  const tester = createLabelLosTester({ world, profile: 'low' });
  const camera = { position: new THREE.Vector3(0, 1.6, 0) };
  const out = [];
  const diagnostics = tester.diagnostics();
  assert.equal(tester.diagnostics(), diagnostics, 'diagnostics is one reused view, not a new object per frame');
  assert.equal(tester.limits.testsPerSecond, 20);

  // One simulated second of 60 FPS frames stays inside the declared rate.
  for (let frame = 0; frame <= 60; frame++) tester.visibleLabels(labels, camera, frame * (1000 / 60), out);
  const after = { ...tester.diagnostics() };
  assert.ok(after.tests <= GEO_LABEL_LOS_PROFILES.low.testsPerSecond, `saw ${after.tests} tests`);
  assert.ok(after.tests >= 19, `a one-second budget should be nearly spent, saw ${after.tests}`);
  assert.ok(after.lastBatch <= GEO_LABEL_LOS_PROFILES.low.candidates);
  assert.equal(after.batches > 0, true);
  // 40 labels against a 20/s budget means only the first half has a verdict; the
  // rest report as stale-but-visible, which is what makes them re-testable.
  assert.equal(after.tracked, 40);
  assert.ok(after.stale >= 1, 'untested labels report as stale instead of hidden');
  assert.ok(after.hidden >= 1, 'labels on the blocked side are hidden');
  assert.equal(after.hidden + after.visible, labels.length);

  // A long gap refills the credit and re-tests the rotation from the cursor.
  tester.visibleLabels(labels, camera, 2000, out);
  assert.ok(tester.diagnostics().lastBatch <= GEO_LABEL_LOS_PROFILES.low.candidates);
  assert.equal(tester.diagnostics().tests > after.tests, true);

  // Pruning keeps the record set bounded when a tile is evicted.
  const evicted = labels.slice(0, 1);
  for (let frame = 0; frame < 60; frame++) tester.visibleLabels(evicted, camera, 3000 + frame * 50, out);
  assert.ok(tester.diagnostics().tracked <= evicted.length * 2 + 16,
    `stale label records are pruned, saw ${tester.diagnostics().tracked}`);

  // The output array is the caller's, and it is reused across frames.
  assert.equal(tester.visibleLabels([], camera, 7000, out), out);
  assert.equal(out.length, 0);
  assert.equal(tester.namespace, GEO_LABEL_LOS_NAMESPACE);
  tester.reset();
  assert.equal(tester.diagnostics().tests, 0);
  assert.equal(tester.diagnostics().tracked, 0);
});

test('the real world keeps the LOS rate inside the low-profile ceiling', () => {
  const fixture = createFixtureWorld();
  try {
    const { world } = fixture;
    const labels = world.visibleLabels;
    const tester = createLabelLosTester({ world, profile: 'low' });
    const camera = { position: new THREE.Vector3(BEHIND_BUILDING.x, BEHIND_BUILDING.y, BEHIND_BUILDING.z) };
    const out = [];
    const sequence = [];
    for (let frame = 0; frame <= 60; frame++) {
      tester.visibleLabels(labels, camera, frame * (1000 / 60), out);
      sequence.push(out.map(label => label.name).join('|'));
    }
    const diagnostics = { ...tester.diagnostics() };
    assert.ok(diagnostics.tests <= GEO_LABEL_LOS_PROFILES.low.testsPerSecond, `saw ${diagnostics.tests}`);
    assert.ok(diagnostics.tests >= labels.length, 'every resident label earns a verdict inside one second');
    const settled = sequence.at(-1).split('|').filter(Boolean);
    assert.equal(settled.includes('Semantics Town'), false,
      'the occluded town label is the one that disappears');
    assert.equal(settled.includes('Semantics Pond'), true, 'the unobstructed water label stays');
  } finally {
    fixture.dispose();
  }
});

test('the richer map readout names the mapped surface, water, and nearest place', () => {
  const fixture = createFixtureWorld();
  try {
    const { world } = fixture;
    const readout = world.mapReadout(25, 50);
    assert.match(readout.supportKind, /terrain|ground/);
    assert.equal(readout.waterClass, GEO_WATER_CLASS.LAKE);
    assert.equal(readout.waterClassName, 'lake');
    assert.equal(readout.inWater, true, 'the readout point sits inside the mapped pond');
    assert.equal(readout.placeName, 'Semantics Pond');
    assert.equal(readout.placeKind, 'water');
    assert.equal(readout.providerSchema, 'openmaptiles');
    assert.equal(readout.supportY, world.supportAt(25, 50, {}).y);
    assert.equal(readout.residentTiles, 1);
    assert.equal(typeof readout.tileKey, 'string');
    assert.ok(readout.tileKey.length > 0);
    assert.ok(readout.roadFeatures > 0 && readout.buildingFeatures > 0);
    assert.equal(readout.landmarks, undefined);

    const dry = world.mapReadout(6, 6);
    assert.equal(dry.inWater, false);
    assert.equal(dry.waterClass, GEO_WATER_CLASS.UNKNOWN);
    assert.equal(dry.waterClassName, 'unknown');
    assert.ok(dry.waterDistance > 0);
    assert.equal(typeof dry.tileDistance, 'number');

    // The readout is one reused record: the HUD reads it every second for free.
    assert.equal(world.mapReadout(6, 6), world.mapReadout(6, 6));

    // And it reaches the debug surface with the LOS verdict counts.
    const snapshot = buildGeoDebugSnapshot(world, { x: 25, z: 50 }).summary;
    assert.equal(snapshot.mapReadout.waterClassName, 'lake');
    assert.equal(snapshot.mapReadout.placeName, 'Semantics Pond');
    assert.equal(snapshot.labelLos, null, 'no frame has produced LOS verdicts yet');
    world.labelLosDiagnostics = createLabelLosTester({ world, profile: 'low' }).diagnostics();
    assert.equal(buildGeoDebugSnapshot(world).summary.labelLos.testsPerSecond,
      GDO_LOW_PROFILE_BUDGETS.labelLosTestsPerSecond);
  } finally {
    fixture.dispose();
  }
});
