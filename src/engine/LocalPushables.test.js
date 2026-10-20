import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_PUSHABLE_KIND,
  GDO_PUSHABLE_MASK,
  GDO_PUSHABLE_NAMESPACE,
  GDO_PUSHABLE_PROFILES,
  GDO_PUSHABLE_REFUSAL,
  createLocalPushables,
} from './LocalPushables.js';
import { GEO_QUERY_MASK } from '../geo/GeoCollision.js';
import * as THREE from 'three';
import { GeoWorld } from '../geo/GeoWorld.js';

const snapshot = pool => JSON.stringify(pool.bodies().map(body => ({
  id: body.id, kind: body.kind, x: body.x, y: body.y, z: body.z,
  vx: body.vx, vy: body.vy, vz: body.vz, asleep: body.asleep,
})));

test('PHY-02 declares one versioned, capped pushable pool', () => {
  assert.equal(GDO_PUSHABLE_NAMESPACE, 'gdo:localPushables:v1');
  assert.deepEqual(Object.values(GDO_PUSHABLE_KIND), ['crate', 'barrel', 'ball', 'cone', 'debris']);
  assert.deepEqual(Object.values(GDO_PUSHABLE_REFUSAL).sort(),
    ['bad-impulse', 'out-of-range', 'pool-full', 'unknown-kind']);
  // A pushable blocks the player and the camera, never line of sight or placement.
  assert.equal(GDO_PUSHABLE_MASK, GEO_QUERY_MASK.SOLID_PLAYER | GEO_QUERY_MASK.CAMERA_BLOCKER);
  assert.equal((GDO_PUSHABLE_MASK & GEO_QUERY_MASK.LOS_BLOCKER), 0);
  assert.equal((GDO_PUSHABLE_MASK & GEO_QUERY_MASK.PLACEMENT), 0);
  const previous = { maxBodies: 0 };
  for (const profile of ['low', 'balanced', 'high']) {
    const limits = GDO_PUSHABLE_PROFILES[profile];
    assert.ok(limits.maxBodies > previous.maxBodies, `${profile} grows the pool`);
    assert.ok(limits.maxSubstepsPerFrame >= 1);
    assert.equal(limits.fixedStepSeconds, 1 / 60, `${profile} integrates on the declared fixed step`);
    assert.ok(limits.maxFrameSeconds * 1000 <= 250);
    previous.maxBodies = limits.maxBodies;
  }
});

test('the integrator is fixed-step: the same elapsed time is the same simulation', () => {
  const build = () => {
    const pool = createLocalPushables({ profile: 'low' });
    const first = pool.add({ x: 0, z: 0, kind: GDO_PUSHABLE_KIND.BALL });
    const second = pool.add({ x: 2, z: -1, kind: GDO_PUSHABLE_KIND.CRATE, radius: .3 });
    pool.push(first.id, [1.4, 1.1, 0]);
    pool.push(second.id, [0, .4, -1.2]);
    return pool;
  };
  const fine = build(), coarse = build();
  for (let frame = 0; frame < 10; frame++) fine.step(16);
  for (let frame = 0; frame < 5; frame++) coarse.step(32);
  assert.equal(snapshot(fine), snapshot(coarse), 'frame packing cannot change the result');
  assert.equal(fine.diagnostics.totalSteps, coarse.diagnostics.totalSteps);

  // A long stall is clamped, counted, and never simulated in one leap.
  const stalled = build();
  const steps = stalled.step(5_000);
  const diagnostics = stalled.diagnostics;
  assert.ok(steps <= GDO_PUSHABLE_PROFILES.low.maxSubstepsPerFrame);
  assert.ok(diagnostics.droppedSeconds > 0);
  assert.ok(diagnostics.droppedSubsteps > 0);
  let total = 0;
  for (let frame = 0; frame < 30; frame++) total += stalled.step(1_000);
  assert.ok(total <= 30 * GDO_PUSHABLE_PROFILES.low.maxSubstepsPerFrame, 'no catch-up spiral');
});

test('sleeping bodies cost zero integration and emit zero proxies', () => {
  const pool = createLocalPushables({ profile: 'low' });
  const body = pool.add({ x: 0, z: 0, kind: GDO_PUSHABLE_KIND.BARREL });
  pool.push(body.id, [2.5, 0, 1.5]);
  pool.changes();
  let settledAt = -1;
  for (let frame = 0; frame < 240; frame++) {
    pool.step(16.6);
    if (settledAt < 0 && pool.diagnostics.sleeping === 1) settledAt = frame;
  }
  assert.ok(settledAt >= 0, 'the body comes to rest and sleeps');
  const settled = pool.diagnostics;
  assert.equal(settled.active, 0);
  assert.equal(settled.sleeping, 1);
  assert.ok(settled.sleepEvents >= 1);

  // The budget proof: an idle pool does no work at all.
  const integrations = settled.totalIntegrations;
  const writes = settled.droppedProxyWrites;
  const drained = pool.changes();
  for (let frame = 0; frame < 300; frame++) {
    assert.equal(pool.step(17) >= 1, true, 'the clock still advances');
    assert.equal(pool.diagnostics.totalIntegrations, integrations, 'a sleeping body is not integrated');
    assert.deepEqual(pool.changes(), [], 'a sleeping body writes no proxy');
  }
  assert.equal(pool.diagnostics.totalIntegrations, integrations);
  assert.equal(pool.diagnostics.droppedProxyWrites, writes);
  assert.deepEqual(drained.filter(change => change.type !== 'move'), []);
  assert.equal(pool.diagnostics.steadyStepAllocations, 0);
  assert.equal(pool.diagnostics.cpuMatrixUpdates, 0);

  // Waking is the only thing that costs anything, and it is counted.
  const wakes = pool.diagnostics.wakeEvents;
  const pushed = pool.push(body.id, [1.2, 0, 0]);
  assert.equal(pushed.ok, true);
  assert.equal(pool.diagnostics.wakeEvents, wakes + 1);
  pool.step(16.6);
  assert.ok(pool.diagnostics.totalIntegrations > integrations);
  assert.ok(pool.changes().some(change => change.type === 'move'));
});

test('the pool, its impulse, and its per-step work are hard caps', () => {
  const pool = createLocalPushables({ profile: 'low' });
  const cap = GDO_PUSHABLE_PROFILES.low.maxBodies;
  for (let index = 0; index < cap; index++) assert.equal(pool.add({ x: index * .1, z: 0 }).ok, true);
  const refused = pool.add({ x: 0, z: 0 });
  assert.equal(refused.ok, false);
  assert.equal(refused.refusal, GDO_PUSHABLE_REFUSAL.POOL_FULL);
  assert.equal(pool.diagnostics.bodies, cap);
  assert.equal(pool.diagnostics.refusals[GDO_PUSHABLE_REFUSAL.POOL_FULL], 1);

  const target = pool.bodies()[0];
  const clamped = pool.push(target.id, [1e6, 0, 0]);
  assert.equal(clamped.ok, true);
  assert.ok(clamped.speed <= GDO_PUSHABLE_PROFILES.low.maxImpulse / target.mass + 1e-9);

  assert.equal(pool.push(target.id, [Number.NaN, 0, 0]).refusal, GDO_PUSHABLE_REFUSAL.BAD_IMPULSE);
  assert.equal(pool.add({ x: 0, z: 0, kind: 'piano' }).refusal, GDO_PUSHABLE_REFUSAL.UNKNOWN_KIND);
  assert.equal(pool.add({ x: Number.POSITIVE_INFINITY, z: 0 }).refusal, GDO_PUSHABLE_REFUSAL.OUT_OF_RANGE);
  assert.equal(pool.step(Number.NaN), 0);
  assert.ok(pool.diagnostics.malformedInputs > 0);

  // Solids are queried through one declared callback, and the query count is
  // bounded per step no matter how many bodies are awake.
  let calls = 0;
  const bounded = createLocalPushables({
    profile: 'low',
    solidAt: () => { calls++; return false; },
  });
  for (let index = 0; index < GDO_PUSHABLE_PROFILES.low.maxBodies; index++) {
    const added = bounded.add({ x: index * .5, z: 0 });
    bounded.push(added.id, [.3, 0, 0]);
  }
  bounded.step(16.6);
  assert.ok(calls <= GDO_PUSHABLE_PROFILES.low.maxSolidsPerStep * GDO_PUSHABLE_PROFILES.low.maxSubstepsPerFrame);
});

test('the proxy change list is bounded, drained, and carries the right mask', () => {
  const pool = createLocalPushables({ profile: 'low' });
  const body = pool.add({ x: 1, z: 2, kind: GDO_PUSHABLE_KIND.CONE });
  const inserted = pool.changes();
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].type, 'insert');
  assert.equal(inserted[0].mask, GDO_PUSHABLE_MASK);
  assert.equal(inserted[0].id, body.id);
  assert.deepEqual(pool.changes(), [], 'the list is drained on read');

  pool.push(body.id, [1, 0, .6]);
  pool.step(34);
  const moved = pool.changes();
  assert.ok(moved.length > 0 && moved.every(change => change.type === 'move'));
  assert.ok(moved.every(change => change.mask === GDO_PUSHABLE_MASK));

  // Removal is one explicit change, not a silent array splice.
  assert.equal(pool.remove(body.id), true);
  const removed = pool.changes();
  assert.equal(removed.length, 1);
  assert.equal(removed[0].type, 'remove');
  assert.equal(pool.remove(body.id), false);

  // Per-frame write budget holds even with a full awake pool.
  const busy = createLocalPushables({ profile: 'low' });
  for (let index = 0; index < GDO_PUSHABLE_PROFILES.low.maxBodies; index++) {
    const added = busy.add({ x: index * .6, z: 0 });
    busy.push(added.id, [2, .2, 0]);
  }
  busy.changes();
  busy.step(34);
  assert.ok(busy.diagnostics.lastProxyWrites <= GDO_PUSHABLE_PROFILES.low.maxProxyWritesPerFrame);
  assert.ok(busy.diagnostics.droppedProxyWrites > 0, 'excess writes are counted, never queued forever');

  // Determinism: the same script on a fresh pool is byte-identical.
  const rerun = createLocalPushables({ profile: 'low' });
  rerun.add({ x: 1, z: 2, kind: GDO_PUSHABLE_KIND.CONE });
  assert.equal(JSON.stringify(rerun.bodies()), JSON.stringify([
    { id: 1, kind: 'cone', x: 1, z: 2, y: .2, vx: 0, vy: 0, vz: 0, radius: .2, asleep: false, sleepTimer: 0, mass: 1 },
  ]));
});

test('the world mounts the pool: a crate is solid, moves, then sleeps silent', () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  const world = new GeoWorld(new THREE.Scene(), { latitude: 28.99, longitude: 77.71 });
  try {
    const spawned = world.spawnPushable({ x: 40, z: 40, kind: GDO_PUSHABLE_KIND.CRATE, radius: .25 });
    assert.equal(spawned.ok, true);
    world.updatePushables(1_000);
    assert.equal(world.dynamicProxies.has(`pushable:${spawned.id}`), true, 'the crate joins the dynamic grid');
    assert.equal(world.collidesCircle(40, 40, .05, GEO_QUERY_MASK.SOLID_PLAYER, 0, 2), true,
      'the crate blocks the player');

    const before = world.pushables.body(spawned.id).x;
    assert.equal(world.pushNearestPushable(40, 40, 2, [2, 0, 0]).ok, true);
    for (let time = 1_017; time < 2_000; time += 17) world.updatePushables(time);
    const pushed = world.pushables.body(spawned.id);
    assert.ok(pushed.x > before, 'the shove moved it');
    assert.equal(world.pushablesSummary.namespace, 'gdo:localPushables:v1');

    // Let it come to rest, then prove the sleeping pool costs nothing.
    for (let time = 2_000; time < 9_000; time += 17) world.updatePushables(time);
    const settled = world.pushables.diagnostics;
    assert.equal(settled.sleeping, 1);
    const integrations = settled.totalIntegrations;
    for (let time = 9_000; time < 12_000; time += 17) world.updatePushables(time);
    const idle = world.pushables.diagnostics;
    assert.equal(idle.totalIntegrations, integrations, 'a sleeping body is not integrated');
    assert.equal(idle.lastProxyWrites, 0, 'a sleeping body writes no proxy');
    // The proxy is still there: solid when asleep, silent when it does not move.
    assert.equal(world.dynamicProxies.has(`pushable:${spawned.id}`), true);
  } finally {
    world.dispose();
    globalThis.Worker = originalWorker;
  }
});
