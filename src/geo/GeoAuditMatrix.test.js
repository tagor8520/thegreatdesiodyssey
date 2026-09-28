import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_AUDIT_MATRIX_FIXTURES,
  runMovementAuditMatrix,
} from '../engine/MovementAuditMatrix.js';
import { MOVEMENT_AUDIT_NAMESPACE } from '../engine/MovementAudit.js';
import { LifecycleLedger } from '../engine/LifecycleContract.js';
import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';
import { GeoWorld } from './GeoWorld.js';
import { GeoPlayer, cameraNearPlaneSweepRadius, probeAuditedCameraClearance } from './GeoPlayer.js';
import { compileGeoFixture } from './GeoFixtures.js';

/**
 * `QLT-06` gate, live: the scripted movement audit runs over the six canonical
 * biome fixtures with the real world, player, and camera, and the report records
 * each fixture's verdicts, fingerprint, and measured budgets. Fixture geometry is
 * deterministic, so the matrix must replay byte-identically.
 */

globalThis.Worker ??= class { addEventListener() {} postMessage() {} terminate() {} };

/** The avatar listens on window/document/canvas; the node harness stubs them. */
function stubBrowserGlobals() {
  const element = () => ({
    addEventListener() {}, removeEventListener() {}, setAttribute() {},
    style: {}, clientWidth: 1280, clientHeight: 720, hidden: false,
  });
  globalThis.window ??= {
    addEventListener() {}, removeEventListener() {},
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { search: '' },
  };
  globalThis.document ??= {
    addEventListener() {}, removeEventListener() {}, createElement: element,
    pointerLockElement: null, exitPointerLock() {}, hidden: false,
    body: { append() {}, style: {} },
  };
  return element();
}

/** Mounts one canonical fixture into a real world, exactly like a live tile. */
function mountFixture(fixtureId, ledger) {
  const scene = new THREE.Scene();
  const world = new GeoWorld(scene, {
    latitude: 28.9845, longitude: 77.7064, ledger, profile: 'low',
  });
  const tile = [...world.tiles.values()][0];
  const compilation = compileGeoFixture(fixtureId, 'openmaptiles');
  const common = {
    type: 'tile-phase', requestId: tile.requestId, key: tile.key, bytes: 2048,
    provider: `Fixture/${compilation.fixture.variant}`, providerId: 'openmaptiles',
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
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3, buildingsMilliseconds: 4, totalMilliseconds: 10 },
  });
  world._flushPlantMounts(0);
  return { scene, world, tile, compilation };
}

/** The page's scripted driver, without the DOM: real player, real camera, real world. */
function createFixtureRun(fixtureId, ledger) {
  const canvas = stubBrowserGlobals();
  const { scene, world, compilation } = mountFixture(fixtureId, ledger);
  const camera = new THREE.PerspectiveCamera(68, 16 / 9, .02, 210);
  const player = new GeoPlayer(scene, camera, canvas, world);
  // The walk starts where a player would stand: on the fixture's mapped
  // carriageway. The midpoint vertex of the compiled road mesh is deterministic
  // and inside the fixture's own road network.
  const roadPositions = compilation.roads.positions;
  const roadVertex = Math.floor(roadPositions.length / 6) * 3;
  const spawn = { x: roadPositions[roadVertex], z: roadPositions[roadVertex + 2] };
  let clock = 0;
  const clearInput = () => {
    player.analogMove.x = 0;
    player.analogMove.z = 0;
    player.jumpQueued = false;
    player.setMoveInput(0, 0);
  };
  const reset = () => {
    clock = 0;
    player.disposed = false;
    player.setCameraMode('first-person', true);
    player.setPosition(spawn.x, spawn.z);
    player.yaw = 0;
    player.thirdPersonPitch = .32;
    player.distance = 2.6;
    player.enabled = true;
    clearInput();
    player.update(1 / 30);
    world.update(player.position, camera, 720, clock);
  };
  const step = (input, { dt = 1 / 30 } = {}) => {
    if (player.cameraMode !== input.cameraMode) player.setCameraMode(input.cameraMode, true);
    player.yaw = (input.yawTurns ?? 0) * Math.PI * 2;
    if (input.zoomTurns != null) player.distance = 2.6 + input.zoomTurns * 3.4;
    clearInput();
    player.analogMove.x = input.strafe ?? 0;
    player.analogMove.z = input.forward ?? 0;
    player.enabled = true;
    clock += dt * 1000;
    player.update(dt);
    world.update(player.position, camera, 720, clock);
  };
  const probe = info => {
    const clearance = probeAuditedCameraClearance(
      world, player.cameraTarget, camera, player.cameraMode === 'first-person',
    );
    return world.movementSnapshot({
      camera, renderer: null, cameraMode: player.cameraMode,
      clearance: clearance.clearance,
      pathId: info?.pathId ?? null, index: info?.index ?? -1, phase: info?.phase ?? 0,
    });
  };
  // Draw calls are counted from the live scene graph: every mesh the world has
  // mounted is one draw call, and the fixtures differ by exactly that number.
  const countMeshes = node => {
    let total = 0;
    node.traverse?.(child => { if (child.isMesh || child.isPoints || child.isLine) total++; });
    return total;
  };
  const measure = () => ({
    residentTiles: world.tiles.size,
    drawCalls: countMeshes(world.root ?? scene),
    triangles: world.plantRenderPools?.diagnostics?.visibleTriangles ?? 0,
    queryMaxCandidates: world.queryDiagnostics?.maxCandidates ?? 0,
    lifecycleResources: world.lifecycle.snapshot().total,
  });
  return {
    step, probe, reset, measure,
    spawn, player, camera, world,
    dispose: () => { player.dispose?.(); world.dispose(); },
  };
}

test('QLT-06 the movement audit matrix covers every canonical biome', () => {
  const ledger = new LifecycleLedger({ label: 'audit-matrix' });
  const runs = new Map();
  try {
    const report = runMovementAuditMatrix({
      repeat: 1,
      createRun: (fixture, index) => {
        const run = createFixtureRun(fixture.fixtureId, ledger.child(`fixture:${fixture.id}:${index}`));
        runs.set(fixture.id, run);
        return run;
      },
    });
    assert.equal(report.ok, true, report.detail);
    assert.deepEqual(report.failed, []);
    assert.equal(report.fixtures.length, GDO_AUDIT_MATRIX_FIXTURES.length);
    assert.deepEqual(report.fixtures.map(entry => entry.id),
      ['urban', 'rural', 'coast', 'wetland', 'mountain', 'arid']);
    assert.deepEqual(report.fixtures.map(entry => entry.fixtureId),
      ['dense-urban', 'sparse-rural', 'mapped-coast', 'wetland-basin', 'mountain-terrace', 'arid-basin']);

    for (const entry of report.fixtures) {
      assert.equal(entry.ok, true, `${entry.id} failed ${entry.failed.join(',')}`);
      assert.ok(entry.samples > 100, `${entry.id} ran ${entry.samples} fixed-step samples`);
      const byId = Object.fromEntries(entry.verdicts.map(verdict => [verdict.id, verdict]));
      assert.equal(byId.determinism.ok, true, `${entry.id}: ${byId.determinism.detail}`);
      assert.equal(byId.clipping.ok, true, `${entry.id} clipping: ${byId.clipping.detail}`);
      assert.equal(byId.ordering.ok, true, `${entry.id} ordering: ${byId.ordering.detail}`);
      assert.equal(byId.popping.ok, true, `${entry.id} popping: ${byId.popping.detail}`);
      assert.equal(byId.shimmer.ok, true, `${entry.id} shimmer: ${byId.shimmer.detail}`);
      assert.equal(byId.stability.ok, true, `${entry.id} stability: ${byId.stability.detail}`);
      assert.equal(byId.residency.ok, true, `${entry.id} residency: ${byId.residency.detail}`);
      // Budgets: every fixture really measured the world it just walked.
      assert.ok(entry.budgets.residentTiles >= 1 && entry.budgets.residentTiles <= 4,
        `${entry.id} holds a bounded resident set`);
      assert.ok(entry.budgets.drawCalls > 0);
      assert.ok(entry.budgets.lifecycleResources > 0);
      assert.ok(entry.budgets.lifecycleResources <= 384, 'low profile live-resource ceiling');
      assert.ok(entry.budgets.queryMaxCandidates <= GDO_LOW_PROFILE_BUDGETS.maxCollisionCandidates,
        `${entry.id} stayed inside the collision-candidate budget (${entry.budgets.queryMaxCandidates})`);

    }
    // The report names the fixtures, not an undifferentiated sweep: the coast and
    // the wetland really carry water geometry, the urban grid really carries roads.
    const coast = report.fixtures.find(entry => entry.id === 'coast');
    const urban = report.fixtures.find(entry => entry.id === 'urban');
    assert.notEqual(coast.fingerprint, urban.fingerprint,
      'different biomes produce different movement fingerprints');
    assert.match(report.detail, /6 fixtures passed the movement audit/);
    assert.equal(report.fingerprint.length, 8);
  } finally {
    for (const run of runs.values()) run.dispose();
    ledger.disposeAll();
    assert.deepEqual(ledger.leaks(), []);
  }
});

test('QLT-06 the audited clearance still catches a camera inside a blocker', () => {
  const ledger = new LifecycleLedger({ label: 'audit-matrix-clearance' });
  let run = null;
  try {
    run = createFixtureRun('dense-urban', ledger.child('urban'));
    // The shared probe is a zero-length near-plane probe at the eye in
    // first-person, so a camera in the open reports exactly zero clearance...
    run.reset();
    const open = probeAuditedCameraClearance(run.world, run.player.cameraTarget, run.camera, true);
    assert.equal(open.blocked, false, 'an eye in the open is not blocked');
    assert.ok(open.clearance >= 0);
    // ...and an eye pushed into a mapped building reports a negative clearance,
    // which is exactly what the audit's clipping verdict fails on.
    const blockedCamera = {
      position: { x: 3, y: .9, z: 3 }, fov: 68, aspect: 16 / 9, near: .02,
    };
    const inside = probeAuditedCameraClearance(
      run.world, { x: 3, y: .9, z: 2 }, blockedCamera, true,
    );
    assert.equal(inside.blocked, true, 'the first dense-urban block is a real blocker');
    assert.ok(inside.clearance < 0);
    // Third-person keeps the segment sweep: a camera behind a facade is blocked.
    const behind = probeAuditedCameraClearance(
      run.world, { x: 3, y: .9, z: 3 }, { ...blockedCamera, position: { x: 60, y: .4, z: 60 } }, false,
    );
    assert.equal(behind.blocked, true, 'the sweep from the player to a camera far away crosses geometry');
    // A camera in the open, facing geometry metres away, is not a violation.
    const clearCamera = { position: { x: 60, y: .4, z: 60 }, fov: 68, aspect: 16 / 9, near: .02 };
    const clear = probeAuditedCameraClearance(run.world, { x: 60, y: .4, z: 40 }, clearCamera, true);
    assert.equal(clear.blocked, false);
    assert.equal(clear.clearance, 0);
  } finally {
    run?.dispose();
    ledger.disposeAll();
    assert.deepEqual(ledger.leaks(), []);
  }
});

test('QLT-06 the fixture matrix replays identically and localizes a broken biome', () => {
  const ledger = new LifecycleLedger({ label: 'audit-matrix-replay' });
  const runs = [];
  try {
    const create = () => {
      const run = createFixtureRun('arid-basin', ledger.child(`arid:${runs.length}`));
      runs.push(run);
      return run;
    };
    const first = runMovementAuditMatrix({
      repeat: 1,
      fixtures: [{ id: 'arid', fixtureId: 'arid-basin', label: 'Arid basin' }],
      createRun: create,
    });
    const second = runMovementAuditMatrix({
      repeat: 1,
      fixtures: [{ id: 'arid', fixtureId: 'arid-basin', label: 'Arid basin' }],
      createRun: create,
    });
    assert.equal(first.ok, true, first.detail);
    assert.equal(second.ok, true, second.detail);
    assert.equal(first.fingerprint, second.fingerprint, 'the same fixture replays identically');
    assert.equal(first.fixtures[0].fingerprint, second.fixtures[0].fingerprint);
    assert.equal(first.auditNamespace, MOVEMENT_AUDIT_NAMESPACE);

    // A budget that cannot be measured fails the matrix instead of passing silently.
    const unmeasured = runMovementAuditMatrix({
      repeat: 1,
      fixtures: [{ id: 'arid', fixtureId: 'arid-basin' }],
      createRun: () => {
        const run = create();
        return { step: run.step, probe: run.probe, reset: run.reset, measure: () => ({ residentTiles: 1 }) };
      },
    });
    assert.equal(unmeasured.ok, false);
    assert.deepEqual(unmeasured.failed, ['arid']);
    assert.match(unmeasured.detail, /arid\(budgets\)/);
  } finally {
    for (const run of runs) run.dispose();
    ledger.disposeAll();
    assert.deepEqual(ledger.leaks(), []);
  }
});
