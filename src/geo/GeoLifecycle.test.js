import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_ADVISORY_TIMING_METRICS,
  GDO_LIFECYCLE_CEILINGS,
  GDO_LOW_PROFILE_BUDGETS,
  evaluateLowProfileBudget,
} from '../engine/PerformanceBudget.js';
import {
  LIFECYCLE_KINDS,
  LifecycleLedger,
  lifecycleCountsWithinCeiling,
  runLifecycleAudit,
} from '../engine/LifecycleContract.js';
import { createDebugLogger, installDebugHooks } from '../engine/DebugHooks.js';
import { MOVEMENT_AUDIT_NAMESPACE, runMovementAudit } from '../engine/MovementAudit.js';
import { GeoWorld } from './GeoWorld.js';
import { compileGeoFixture } from './GeoFixtures.js';
import { collectGeoRuntimeBudgetMetrics } from './GeoDiagnostics.js';
import { cameraNearPlaneSweepRadius } from './GeoPlayer.js';

const COORDINATE = { latitude: 28.9845, longitude: 77.7064 };

function fixtureWorkerClass() {
  return class FixtureWorker {
    static active = 0;
    constructor() { FixtureWorker.active++; this.messages = []; }
    addEventListener() {}
    postMessage(message) { this.messages.push(message); }
    terminate() { if (!this.terminated) { this.terminated = true; FixtureWorker.active--; } }
  };
}

function applyCompilation(world, tile, compilation) {
  const common = {
    type: 'tile-phase', requestId: tile.requestId, key: tile.key,
    bytes: 2048, provider: `Fixture/${compilation.fixture.variant}`,
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
    timings: {
      fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3,
      buildingsMilliseconds: 4, totalMilliseconds: 10,
    },
  });
}

/** Mounts one fixture world, exactly like a game mount minus the DOM. */
function mountFixtureWorld(ledger, scene = new THREE.Scene()) {
  const world = new GeoWorld(scene, { ...COORDINATE, ledger });
  const tile = [...world.tiles.values()][0];
  applyCompilation(world, tile, compileGeoFixture('provider-equivalence', 'openmaptiles'));
  world._flushPlantMounts(0);
  return { world, scene, tile };
}

/** Live counters only: `released` is monotonic and must not read as growth. */
function ledgerSample(ledger) {
  const snapshot = ledger.snapshot();
  return { ...snapshot.counts, total: snapshot.total };
}

test('FND-07 a game-scoped ledger proves three world mount/unmount cycles leave nothing behind', () => {
  const previousWorker = globalThis.Worker;
  const WorkerStub = fixtureWorkerClass();
  globalThis.Worker = WorkerStub;
  const game = new LifecycleLedger({ label: 'coordinate-game' });
  const scene = new THREE.Scene();
  let live = null;
  try {
    const before = ledgerSample(game);
    for (let cycle = 0; cycle < 3; cycle++) {
      live = mountFixtureWorld(game, scene);
      // The mount owns real resources of every heavy kind.
      const during = game.snapshot();
      for (const kind of ['worker', 'geometry', 'material', 'node', 'handle']) {
        assert.ok(during.counts[kind] > 0, `cycle ${cycle} should own ${kind}s`);
      }
      assert.ok(during.total <= GDO_LIFECYCLE_CEILINGS.low.total,
        `cycle ${cycle} stayed inside the low-profile live-resource ceiling (${during.total})`);
      assert.equal(lifecycleCountsWithinCeiling(during.counts, GDO_LIFECYCLE_CEILINGS.low).ok, true);
      live.world.dispose();
      live = null;
      assert.deepEqual(ledgerSample(game), before, `cycle ${cycle} returned to the idle ledger`);
      assert.ok(game.snapshot().released >= (cycle + 1) * 20, 'each cycle really released its resources');
      assert.deepEqual(game.leaks(), []);
      assert.deepEqual(scene.children.length, 0, 'the scene is empty again');
      assert.equal(WorkerStub.active, 0, 'no worker survived the cycle');
    }
    assert.equal(game.snapshot().released > 0, true);
  } finally {
    live?.world.dispose();
    globalThis.Worker = previousWorker;
  }
});

test('FND-07 runLifecycleAudit names the growing counter when a world leaks', () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = fixtureWorkerClass();
  const game = new LifecycleLedger({ label: 'leaky-game' });
  const scene = new THREE.Scene();
  try {
    const report = runLifecycleAudit({
      cycles: 2,
      mount() { mountFixtureWorld(game, scene); },
      // The injected defect: the world is never disposed, so its ledger children
      // stay live and the audit must name the exact kinds that grew.
      unmount() {},
      sample: () => ledgerSample(game),
    });
    assert.equal(report.ok, false);
    const grown = new Set(report.growth.map(entry => entry.key));
    for (const kind of ['worker', 'geometry', 'material', 'total']) {
      assert.equal(grown.has(kind), true, `${kind} growth must be reported`);
    }
    assert.match(report.detail, /growth after 2 cycles/);
  } finally {
    game.disposeAll();
    globalThis.Worker = previousWorker;
  }
});

test('FND-07 pool eviction and remount release geometry through the ledger, not by hand', () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = fixtureWorkerClass();
  const ledger = new LifecycleLedger({ label: 'pool-ledger' });
  try {
    const { world, tile } = mountFixtureWorld(ledger);
    const tileGeometry = key => world.lifecycle.liveEntries({ kinds: ['geometry'] })
      .filter(entry => entry.name.startsWith(`${key}/`)).map(entry => entry.name).sort();
    const allGeometryNames = () => world.lifecycle.liveEntries({ kinds: ['geometry'] })
      .map(entry => entry.name).sort();
    const residentSlots = tileGeometry(tile.key);
    const residentGeometry = world.lifecycle.snapshot().counts.geometry;
    assert.ok(residentSlots.length >= 4, `tile geometry is registered while resident (${residentSlots.length})`);
    const beforeEvict = allGeometryNames();
    const firstKey = tile.key, x = tile.x, y = tile.y;
    world._evictTile(tile);
    assert.deepEqual(tileGeometry(firstKey), [], 'eviction released every tile-owned geometry');
    const removed = beforeEvict.filter(name => !allGeometryNames().includes(name));
    for (const slot of residentSlots) assert.equal(removed.includes(slot), true, `${slot} left the ledger`);
    for (const name of removed) {
      assert.equal(name.startsWith(`${firstKey}/`) || name.includes(`hero:${firstKey}`), true,
        `only the evicted tile's geometry left the ledger, not ${name}`);
    }
    assert.equal(world.lifecycle.snapshot().counts.geometry, residentGeometry - removed.length,
      'the ledger dropped exactly the released geometry');
    world._requestTile(x, y, 0);
    const remounted = world.tiles.get(firstKey);
    applyCompilation(world, remounted, compileGeoFixture('provider-equivalence', 'openmaptiles'));
    world._flushPlantMounts(0);
    assert.deepEqual(tileGeometry(firstKey), residentSlots,
      'a remount restores exactly the same tile geometry slots');
    assert.equal(world.lifecycle.snapshot().counts.geometry, residentGeometry,
      'and the ledger returns to the resident geometry count');
    world.dispose();
    assert.deepEqual(ledger.leaks(), []);
  } finally {
    globalThis.Worker = previousWorker;
  }
});

test('FND-07 the movement audit runs against the real world and reports measurable verdicts', () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = fixtureWorkerClass();
  const scene = new THREE.Scene();
  const ledger = new LifecycleLedger({ label: 'coordinate-game' });
  try {
    const { world } = mountFixtureWorld(ledger);
    const camera = new THREE.PerspectiveCamera(68, 16 / 9, .02, 210);
    camera.position.set(0, 2.4, 0);
    // Mirror of the page driver: keep the camera out of blockers, step the real
    // world, and read the live bands/LOD/detail state every step.
    const state = { x: 0, z: 0, yaw: 0 };
    const reset = () => {
      state.x = 0; state.z = 0; state.yaw = 0;
      camera.position.set(0, 2.4, 0);
      world.update({ x: 0, y: 0, z: 0 }, camera, 720, 0);
    };
    const step = (input, { dt = 1 / 30 } = {}) => {
      const yaw = (input.yawTurns ?? 0) * Math.PI * 2;
      const speed = 1.4;
      state.x += Math.sin(yaw) * speed * dt * (input.forward ?? 0);
      state.z += Math.cos(yaw) * speed * dt * (input.forward ?? 0);
      state.yaw = yaw;
      const ground = world.supportAt?.(state.x, state.z, {})?.y ?? 0;
      camera.position.set(state.x - Math.sin(yaw) * 2.6, ground + 2.4, state.z - Math.cos(yaw) * 2.6);
      world.update({ x: state.x, y: ground, z: state.z }, camera, 720, input.index * 33);
    };
    let probeCount = 0;
    const probe = info => {
      probeCount++;
      const target = { x: state.x, y: 2.4, z: state.z };
      const clearance = world.probeCameraClearance(target, camera.position, cameraNearPlaneSweepRadius(camera), {});
      return world.movementSnapshot({
        camera, renderer: null, cameraMode: info.cameraMode, clearance: clearance.clearance,
        pathId: info.pathId, index: info.index, phase: info.phase,
      });
    };
    const report = runMovementAudit({ step, probe, reset, repeat: 2 });
    assert.equal(report.namespace, MOVEMENT_AUDIT_NAMESPACE);
    assert.equal(report.ok, true, report.detail);
    assert.ok(probeCount >= report.samples * 2);
    const byId = Object.fromEntries(report.verdicts.map(verdict => [verdict.id, verdict]));
    assert.equal(byId.determinism.ok, true, 'two fixed-step passes fingerprint identically');
    assert.equal(byId.clipping.ok, true, byId.clipping.detail);
    assert.equal(byId.ordering.ok, true, byId.ordering.detail);
    assert.equal(byId.shimmer.ok, true, byId.shimmer.detail);
    assert.equal(byId.stability.ok, true, byId.stability.detail);
    // The bands are read from the live materials, so the water band must really
    // sort above opaque geometry and really be blended.
    const snapshot = world.movementSnapshot({ camera, cameraMode: 'third-person' });
    const water = snapshot.bands.find(band => band.name === 'water');
    assert.equal(water.transparent, true);
    assert.ok(water.order > water.opaqueOrder);
    // Subpixel detail: every tracked surface reports the shader's own policy and
    // engages mip/fade instead of aliasing.
    assert.ok(snapshot.subpixel.length >= 4);
    for (const sample of snapshot.subpixel) {
      if (sample.pixels < 1) assert.equal(sample.mip || sample.faded, true, sample.key);
    }
    world.dispose();
    assert.deepEqual(ledger.leaks(), []);
  } finally {
    globalThis.Worker = previousWorker;
  }
});

test('FND-07 the debug hook exposes the ledger, the probe, and a runnable movement audit', () => {
  const target = {};
  const ledger = new LifecycleLedger({ label: 'hook-ledger' });
  ledger.own('geometry', 'ground');
  const logger = createDebugLogger({ level: 'debug' });
  const installed = installDebugHooks(target, {
    ledger,
    logger,
    describe: () => ({ camera: { mode: 'third-person' } }),
    audits: { movement: () => ({ ok: true, namespace: MOVEMENT_AUDIT_NAMESPACE }) },
  });
  const hook = target.__gdo;
  assert.equal(hook.ledger().label, 'hook-ledger');
  assert.equal(hook.counts().geometry, 1);
  assert.equal(hook.probe().described.camera.mode, 'third-person');
  assert.equal(hook.audits.run('movement').namespace, MOVEMENT_AUDIT_NAMESPACE);
  hook.log.write('lifecycle', 'probe requested');
  assert.match(hook.log.text(), /probe requested/);
  installed.dispose();
  assert.equal('__gdo' in target, false);
  assert.equal(ledger.snapshot().total, 1, 'disposing the hook never disposes the runtime ledger');
});

test('FND-07 the runtime budget surface reports live ownership and advisory timing separately', () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = fixtureWorkerClass();
  try {
    const ledger = new LifecycleLedger({ label: 'coordinate-game' });
    const { world } = mountFixtureWorld(ledger);
    const metrics = collectGeoRuntimeBudgetMetrics(null, world, { view: 'street' });
    assert.equal(metrics.lifecycleOwnedResources, ledger.snapshot().total);
    assert.ok(metrics.lifecycleOwnedResources > 0);
    assert.ok(metrics.lifecycleOwnedResources <= GDO_LOW_PROFILE_BUDGETS.lifecycleOwnedResources);
    const report = evaluateLowProfileBudget(metrics);
    assert.equal(report.breaches.filter(breach => breach.metric === 'lifecycleOwnedResources').length, 0);
    // A machine-speed overrun is advisory; the ownership ceiling is not.
    const slowHost = evaluateLowProfileBudget({
      ...metrics, mainThreadMountMilliseconds: GDO_LOW_PROFILE_BUDGETS.mainThreadMountMilliseconds + 5,
    });
    assert.equal(slowHost.ok, true);
    assert.equal(slowHost.advisories.some(item => item.metric === 'mainThreadMountMilliseconds'), true);
    for (const advisory of slowHost.advisories) {
      assert.equal(GDO_ADVISORY_TIMING_METRICS.includes(advisory.metric), true,
        `${advisory.metric} must be a declared advisory timing metric`);
    }
    const overOwned = evaluateLowProfileBudget({
      ...metrics, lifecycleOwnedResources: GDO_LOW_PROFILE_BUDGETS.lifecycleOwnedResources + 1,
    });
    assert.equal(overOwned.ok, false);
    assert.deepEqual(overOwned.breaches.map(item => item.metric), ['lifecycleOwnedResources']);
    world.dispose();
    assert.deepEqual(ledger.leaks(), []);
  } finally {
    globalThis.Worker = previousWorker;
  }
});

test('FND-07 lifecycle kinds and ceilings stay explicit and bounded', () => {
  assert.deepEqual([...LIFECYCLE_KINDS], [
    'worker', 'listener', 'observer', 'timer', 'frame', 'geometry',
    'material', 'texture', 'mesh', 'node', 'pool', 'handle',
  ]);
  for (const profile of ['low', 'balanced', 'high']) {
    const ceilings = GDO_LIFECYCLE_CEILINGS[profile];
    assert.ok(ceilings.total > 0);
    const declared = LIFECYCLE_KINDS.reduce((sum, kind) => sum + (ceilings[kind] ?? 0), 0);
    assert.ok(declared >= ceilings.total, `${profile} per-kind ceilings must be able to reach the total`);
  }
  assert.ok(GDO_LIFECYCLE_CEILINGS.low.total < GDO_LIFECYCLE_CEILINGS.high.total);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.lifecycleOwnedResources, GDO_LIFECYCLE_CEILINGS.low.total);
});
