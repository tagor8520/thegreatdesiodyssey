import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_POSEFALL_NAMESPACE,
  GDO_POSEFALL_PROFILES,
  GDO_POSEFALL_REFUSAL,
  GDO_POSEFALL_RIG,
  GDO_POSEFALL_STATE,
  GDO_POSEFALL_VARIANTS,
  createPoseFallBoard,
} from './PoseFall.js';

const snapshot = board => JSON.stringify(board.poses());
const advance = (board, milliseconds, step = 16.7) => {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += step) board.update(step);
};

test('PHY-03 declares a bounded pose-fall state machine with no rigid bodies', () => {
  assert.equal(GDO_POSEFALL_NAMESPACE, 'gdo:poseFall:v1');
  assert.deepEqual(Object.values(GDO_POSEFALL_STATE), ['standing', 'falling', 'settling', 'down', 'rising']);
  assert.deepEqual(Object.values(GDO_POSEFALL_REFUSAL).sort(),
    ['already-falling', 'no-impulse', 'pool-full', 'unknown-actor']);
  // Stable lying variants are authored data, not simulated outcomes.
  assert.equal(GDO_POSEFALL_VARIANTS.length, 4);
  assert.equal(new Set(GDO_POSEFALL_VARIANTS.map(variant => variant.id)).size, 4);
  for (const variant of GDO_POSEFALL_VARIANTS) {
    assert.ok(variant.lean > 1.2 && variant.lean < 1.6);
    assert.ok(Number.isFinite(variant.yawOffset));
  }
  // The rig is seven segments and every one has a ground clearance.
  assert.deepEqual(Object.keys(GDO_POSEFALL_RIG).sort(),
    ['armLeft', 'armRight', 'chest', 'head', 'legLeft', 'legRight', 'pelvis']);
  for (const part of Object.values(GDO_POSEFALL_RIG)) assert.ok(part.clearance > 0);
  let previous = 0;
  for (const profile of ['low', 'balanced', 'high']) {
    const policy = GDO_POSEFALL_PROFILES[profile];
    assert.ok(policy.maxActors > previous, `${profile} grows the pool`);
    assert.equal(policy.segments, 7);
    assert.equal(policy.fixedStepSeconds, 1 / 60);
    assert.ok(policy.maximumFallSeconds >= policy.fallSeconds);
    assert.ok(policy.maxSubstepsPerFrame >= 1);
    previous = policy.maxActors;
  }
});

test('a knockdown walks standing → falling → settling → down, then rises or is removed', () => {
  const board = createPoseFallBoard({ profile: 'low', seed: 5, despawn: false });
  const actor = board.spawn({ x: 0, z: 0 }).actor;
  assert.equal(board.stateOf(actor.id), GDO_POSEFALL_STATE.STANDING);
  const standing = JSON.parse(snapshot(board));

  const result = board.knockDown(actor.id, [3, 0, .5]);
  assert.equal(result.ok, true);
  assert.ok(result.severity > 0 && result.severity <= 1);
  assert.ok(result.duration >= GDO_POSEFALL_PROFILES.low.fallSeconds);
  assert.ok(GDO_POSEFALL_VARIANTS.some(variant => variant.id === result.variant));
  assert.equal(board.stateOf(actor.id), GDO_POSEFALL_STATE.FALLING);

  const seen = new Set();
  for (let frame = 0; frame < 120; frame++) {
    board.update(16.7);
    seen.add(board.stateOf(actor.id));
  }
  assert.ok(seen.has(GDO_POSEFALL_STATE.FALLING));
  assert.ok(seen.has(GDO_POSEFALL_STATE.SETTLING));
  assert.ok(seen.has(GDO_POSEFALL_STATE.DOWN));
  const lying = board.pose(actor.id);
  // Lying down means the head is no longer near standing height.
  const head = lying.segments.find(segment => segment.role === 'head');
  assert.ok(head.y < GDO_POSEFALL_RIG.head.y * .45, `head came down (${head.y})`);
  assert.ok(head.x !== 0, 'and the body travelled along the impulse');
  assert.notDeepEqual(JSON.parse(JSON.stringify(lying)), standing[0]);

  advance(board, 4_000);
  assert.equal(board.stateOf(actor.id), GDO_POSEFALL_STATE.STANDING, 'the baseline returns to standing');
  const diagnostics = board.diagnostics;
  assert.equal(diagnostics.recoveries, 1);
  assert.equal(diagnostics.knockdowns, 1);
  assert.equal(diagnostics.settles, 1);
  assert.equal(diagnostics.rigidBodies, 0);
  assert.equal(diagnostics.constraintIterations, 0);
  assert.equal(diagnostics.steadyFrameAllocations, 0);

  // The despawn variant removes the actor after the hold instead of rising.
  const despawning = createPoseFallBoard({ profile: 'low', seed: 5 });
  const doomed = despawning.spawn({ x: 0, z: 0 }).actor;
  despawning.knockDown(doomed.id, [3, 0, 0]);
  advance(despawning, 3_600);
  assert.equal(despawning.count, 0);
  assert.equal(despawning.diagnostics.removals, 1);
});

test('the impulse decides direction and severity, and the result is deterministic', () => {
  const run = impulse => {
    const board = createPoseFallBoard({ profile: 'low', seed: 11, despawn: false });
    const actor = board.spawn({ x: 2, z: -1 }).actor;
    board.knockDown(actor.id, impulse);
    advance(board, 900);
    return { board, actor };
  };
  const weak = run([.6, 0, 0]);
  const strong = run([5.8, 0, 0]);
  assert.ok(strong.actor.severity > weak.actor.severity, 'a harder hit falls harder');
  assert.ok(strong.actor.duration <= weak.actor.duration, 'and faster');
  assert.ok(strong.actor.leanDirection.x > .99 && Math.abs(strong.actor.leanDirection.z) < 1e-9);
  const backwards = run([-4, 0, 0]);
  assert.ok(backwards.actor.leanDirection.x < -.99, 'the body falls away from the hit');

  // Two identical scripts are byte-identical.
  const first = run([2.4, 0, 1.1]);
  const second = run([2.4, 0, 1.1]);
  assert.equal(snapshot(first.board), snapshot(second.board));

  // The prototype is mutated in place, not replaced.
  const pose = first.board.pose(first.actor.id);
  advance(first.board, 200);
  assert.equal(first.board.pose(first.actor.id), pose, 'a renderer can hold the pose reference');
  assert.equal(first.board.diagnostics.steadyFrameAllocations, 0);
});

test('every segment is clamped to the ground it is over, and the pool is capped', () => {
  // A sloped height field: the clamp must follow the segment's own X.
  const slope = (x) => x * .02;
  const board = createPoseFallBoard({ profile: 'low', seed: 3, heightAt: slope, despawn: false });
  const actor = board.spawn({ x: 3, z: 0 }).actor;
  board.knockDown(actor.id, [4, 0, 0]);
  for (let frame = 0; frame < 90; frame++) {
    board.update(16.7);
    for (const segment of board.pose(actor.id).segments) {
      assert.ok(segment.y >= slope(segment.x) + GDO_POSEFALL_RIG[segment.role].clearance - 1e-6,
        `${segment.role} stays above its own ground`);
    }
  }

  const capped = createPoseFallBoard({ profile: 'low' });
  for (let index = 0; index < GDO_POSEFALL_PROFILES.low.maxActors; index++) {
    assert.equal(capped.spawn({ x: index, z: 0 }).ok, true);
  }
  const refused = capped.spawn({ x: 0, z: 0 });
  assert.equal(refused.refusal, GDO_POSEFALL_REFUSAL.POOL_FULL);

  // Named refusals instead of silent no-ops.
  const first = capped.poses()[0];
  const id = first.actorId;
  assert.equal(capped.knockDown(id, [1, 0, 0]).ok, true);
  assert.equal(capped.knockDown(id, [1, 0, 0]).refusal, GDO_POSEFALL_REFUSAL.ALREADY_FALLING);
  assert.equal(capped.knockDown('nobody', [1, 0, 0]).refusal, GDO_POSEFALL_REFUSAL.UNKNOWN_ACTOR);
  // A standing actor is the only one that can be told its impulse is useless.
  const fresh = createPoseFallBoard({ profile: 'low' });
  const standing = fresh.spawn({ x: 0, z: 0 }).actor;
  assert.equal(fresh.knockDown(standing.id, [0, 0, 0]).refusal, GDO_POSEFALL_REFUSAL.NO_IMPULSE);
  assert.equal(fresh.knockDown(standing.id, [Number.NaN, 0, 0]).refusal, GDO_POSEFALL_REFUSAL.NO_IMPULSE);
  assert.equal(fresh.knockDown(standing.id, undefined).refusal, GDO_POSEFALL_REFUSAL.NO_IMPULSE);
  assert.equal(capped.update(Number.NaN), 0);
  assert.ok(capped.diagnostics.malformedInputs > 0);
  assert.equal(capped.diagnostics.refusals[GDO_POSEFALL_REFUSAL.POOL_FULL], 1);
});

test('the fixed step bounds per-frame work and a long stall cannot catch up', () => {
  const board = createPoseFallBoard({ profile: 'low', seed: 9, despawn: false });
  const ids = [];
  for (let index = 0; index < GDO_POSEFALL_PROFILES.low.maxActors; index++) {
    const actor = board.spawn({ x: index * .5, z: 0 }).actor;
    ids.push(actor.id);
    board.knockDown(actor.id, [2, 0, 0]);
  }
  const policy = GDO_POSEFALL_PROFILES.low;
  // A five-second stall is clamped to the substep cap.
  const steps = board.update(5_000);
  assert.ok(steps <= policy.maxSubstepsPerFrame);
  assert.ok(board.diagnostics.lastPoseWrites <= policy.poseWritesPerFrame);
  let total = steps;
  for (let frame = 0; frame < 30; frame++) total += board.update(1_000);
  assert.ok(total <= 31 * policy.maxSubstepsPerFrame, 'no catch-up spiral');

  // Two frame packings over the same elapsed time agree exactly.
  const packed = (frames, milliseconds) => {
    const twin = createPoseFallBoard({ profile: 'low', seed: 9, despawn: false });
    const actor = twin.spawn({ x: 0, z: 0 }).actor;
    twin.knockDown(actor.id, [2.2, 0, .8]);
    for (let frame = 0; frame < frames; frame++) twin.update(milliseconds);
    return snapshot(twin);
  };
  assert.equal(packed(20, 16.7), packed(10, 33.4));
});

test('the world mounts the board: a knocked-down actor lies on the real terrain', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  const THREE = await import('three');
  const { GeoWorld } = await import('../geo/GeoWorld.js');
  const world = new GeoWorld(new THREE.Scene(), { latitude: 28.99, longitude: 77.71 });
  try {
    const spawned = world.poseFalls.spawn({ x: 30, z: 30, yaw: .4 });
    assert.equal(spawned.ok, true);
    assert.equal(world.updatePoseFalls(0)?.actors, 1);

    const knocked = world.knockDownNearest(30, 30, 2, [3, 0, 1]);
    assert.equal(knocked.ok, true, 'the nearest standing actor is hit');
    assert.equal(world.knockDownNearest(500, 500, 2, [3, 0, 1]).ok, false, 'out of reach is refused by name');

    for (let frame = 0; frame < 120; frame++) world.updatePoseFalls(16.7);
    const pose = world.poseFalls.pose(spawned.id);
    const head = pose.segments.find(segment => segment.role === 'head');
    assert.ok(head.y < GDO_POSEFALL_RIG.head.y * .45, 'the head came down onto the ground');
    const { terrainHeightAt } = await import('../geo/GeoTerrain.js');
    for (const segment of pose.segments) {
      const ground = terrainHeightAt(segment.x, segment.z, world.terrainSeed);
      assert.ok(segment.y >= ground + GDO_POSEFALL_RIG[segment.role].clearance - 1e-6,
        `${segment.role} sits above the real terrain it is over`);
    }
    assert.equal(world.poseFallSummary.namespace, 'gdo:poseFall:v1');
    assert.equal(world.poseFalls.diagnostics.rigidBodies, 0);
  } finally {
    world.dispose();
    globalThis.Worker = originalWorker;
  }
});
