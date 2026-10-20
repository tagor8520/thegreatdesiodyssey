import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from '../geo/GeoWorld.js';
import {
  GDO_BREAKABLE_ARCHETYPES,
  GDO_BREAKABLE_NAMESPACE,
  GDO_BREAKABLE_PROFILES,
  GDO_BREAKABLE_REFUSAL,
  createBreakables,
  sampleFlagWave,
} from './BreakableProps.js';

test('PHY-06 declares pre-authored chunks, a rope chain, and a flag wave', () => {
  assert.equal(GDO_BREAKABLE_NAMESPACE, 'gdo:breakables:v1');
  assert.deepEqual(Object.values(GDO_BREAKABLE_REFUSAL).sort(),
    ['bad-input', 'mapped-geometry', 'pool-exhausted', 'rope-budget', 'rope-too-long', 'unknown-archetype']);
  // Research §9.8: three to eight reusable chunks per archetype.
  for (const [name, recipe] of Object.entries(GDO_BREAKABLE_ARCHETYPES)) {
    assert.ok(recipe.chunks >= 3 && recipe.chunks <= 8, `${name} has ${recipe.chunks} chunks`);
    assert.ok(recipe.spread > 0 && recipe.lifeSeconds > 0 && recipe.fadeSeconds > 0);
    assert.ok(recipe.fadeSeconds < recipe.lifeSeconds, `${name} fades before it expires`);
  }
  // Research §9.6: an optional 5–10 point chain; the low profile is ground-only.
  for (const profile of ['low', 'balanced', 'high']) {
    const policy = GDO_BREAKABLE_PROFILES[profile];
    assert.ok(policy.minRopePoints >= 5 && policy.maxRopePoints <= 10);
    assert.ok(policy.ropeIterations >= 3 && policy.ropeIterations <= 5);
    assert.ok(policy.maxChunksPerBreak <= 8);
    assert.ok(policy.maxChunks >= policy.maxActiveBreaks * policy.maxChunksPerBreak);
  }
  assert.equal(GDO_BREAKABLE_PROFILES.low.chunkContacts, 'ground-only');
  assert.equal(GDO_BREAKABLE_PROFILES.balanced.chunkContacts, 'ground-and-walls');
});

test('a break spawns its archetype chunks outward and recycles within the pool', () => {
  const board = createBreakables({ profile: 'low', seed: 7 });
  const broken = board.breakProp({ archetype: 'crate', x: 2, z: -1 });
  assert.equal(broken.ok, true);
  assert.equal(broken.count, GDO_BREAKABLE_ARCHETYPES.crate.chunks);
  assert.equal(broken.contacts, 'ground-only', 'low profile chunks hit the ground only');
  assert.equal(board.activeChunks, broken.count);
  // One outward recipe: chunks leave the impact in different directions.
  const headings = broken.chunks.map(id => {
    const chunk = board.chunk(id);
    return Math.atan2(chunk.vz, chunk.vx);
  });
  const spread = Math.max(...headings) - Math.min(...headings);
  assert.ok(spread > 2, `the recipe spreads chunks around the impact (${spread})`);
  for (const id of broken.chunks) {
    const chunk = board.chunk(id);
    assert.ok(chunk.vy > 0, 'and lifts them');
    assert.ok(chunk.life > 0 && chunk.alpha === 1);
  }

  // Fast-forward: they land, fade, and expire — the pool never grows. (The
  // accumulator clamps a single call, so time is advanced frame by frame.)
  for (let frame = 0; frame < 18; frame++) board.update(16.7);
  assert.ok(board.activeChunks > 0, 'mid-flight they are still visible');
  for (let frame = 0; frame < 120; frame++) board.update(16.7);
  assert.equal(board.activeChunks, 0, 'and then they are gone');
  assert.ok(board.diagnostics.expired > 0);
  assert.equal(board.diagnostics.chunks, GDO_BREAKABLE_PROFILES.low.maxChunks);

  // Breaking far more than the pool holds keeps the pool at its cap.
  for (let index = 0; index < 20; index++) {
    board.update(1);
    board.breakProp({ archetype: 'bench', x: index, z: 0 });
  }
  assert.ok(board.activeChunks <= GDO_BREAKABLE_PROFILES.low.maxChunks);
  assert.ok(board.diagnostics.recycled > 0, 'excess chunks recycle the oldest, and say so');
  assert.equal(board.diagnostics.fracturedMeshes, 0, 'no mesh is fractured');
});

test('mapped geometry is refused by name and the reset is byte-identical', () => {
  const fresh = createBreakables({ profile: 'low', seed: 5 });
  const baseline = fresh.fingerprint();
  const board = createBreakables({ profile: 'low', seed: 5 });

  // Research §9.8: never fracture mapped building geometry dynamically.
  const mapped = board.breakProp({ archetype: 'crate', x: 0, z: 0, source: 'mapped-building' });
  assert.equal(mapped.ok, false);
  assert.equal(mapped.refusal, GDO_BREAKABLE_REFUSAL.MAPPED_GEOMETRY);
  assert.equal(board.breakProp({ archetype: 'statue' }).refusal, GDO_BREAKABLE_REFUSAL.UNKNOWN_ARCHETYPE);
  assert.equal(board.breakProp({ archetype: 'crate', x: Number.NaN }).refusal, GDO_BREAKABLE_REFUSAL.BAD_INPUT);
  assert.equal(board.diagnostics.refusals[GDO_BREAKABLE_REFUSAL.MAPPED_GEOMETRY], 1);

  board.breakProp({ archetype: 'planter', x: 1, z: 2 });
  board.createRope({ from: [0, .4, 0], to: [.3, 0, .1] });
  board.update(500);
  assert.notEqual(board.fingerprint(), baseline, 'work changes the state');

  board.reset();
  assert.equal(board.fingerprint(), baseline, 'reset restores the construction state exactly');
  assert.equal(board.activeChunks, 0);
  assert.equal(board.diagnostics.ropes, 0);
  assert.equal(board.diagnostics.breaks, 0);
  assert.equal(board.diagnostics.steps, 0);

  // The same seed replays the same break.
  const replay = () => {
    const twin = createBreakables({ profile: 'low', seed: 5 });
    twin.breakProp({ archetype: 'barrel', x: 3, z: 3 });
    twin.update(200);
    return twin.fingerprint();
  };
  assert.equal(replay(), replay());
});

test('a rope is a pinned 5–10 point chain that sags and settles', () => {
  const board = createBreakables({ profile: 'low', seed: 2 });
  const policy = GDO_BREAKABLE_PROFILES.low;
  assert.equal(board.createRope({ from: [0, .4, 0], to: [.4, .1, .2], points: 4 }).refusal,
    GDO_BREAKABLE_REFUSAL.ROPE_TOO_LONG);
  assert.equal(board.createRope({ from: [0, .4, 0], to: [.4, .1, .2], points: 11 }).refusal,
    GDO_BREAKABLE_REFUSAL.ROPE_TOO_LONG);
  const rope = board.createRope({ from: [0, .5, 0], to: [.5, .1, .3], points: 7 });
  assert.equal(rope.ok, true);
  assert.ok(rope.points >= policy.minRopePoints && rope.points <= policy.maxRopePoints);

  const ropeState = board.ropes()[rope.id];
  const anchor = { x: ropeState.points[0], y: ropeState.points[1], z: ropeState.points[2] };
  for (let frame = 0; frame < 240; frame++) board.update(16.7);
  // The pinned end never moves: the rope hangs from it.
  assert.equal(ropeState.points[0], anchor.x);
  assert.equal(ropeState.points[1], anchor.y);
  assert.equal(ropeState.points[2], anchor.z);
  // Every point stays at or above the ground, and the middle sags below the line.
  let minimum = Infinity;
  for (let index = 0; index < ropeState.count; index++) {
    const y = ropeState.points[index * 3 + 1];
    assert.ok(y >= -1e-6, 'no point sinks through the floor');
    minimum = Math.min(minimum, y);
  }
  const endY = ropeState.points[(ropeState.count - 1) * 3 + 1];
  assert.ok(minimum < Math.max(anchor.y, endY) + 1e-6, 'the chain droops');
  // Segments stay within the declared rest length.
  const rest = rope.length / (ropeState.count - 1);
  for (let index = 1; index < ropeState.count; index++) {
    const a = (index - 1) * 3, b = index * 3;
    const length = Math.hypot(
      ropeState.points[b] - ropeState.points[a],
      ropeState.points[b + 1] - ropeState.points[a + 1],
      ropeState.points[b + 2] - ropeState.points[a + 2],
    );
    assert.ok(Math.abs(length - rest) < rest * .2, `segment ${index} holds its length`);
  }
  // The rope budget is a cap, not a suggestion.
  const second = board.createRope({ from: [0, .5, 0], to: [.2, .1, 0] });
  assert.equal(second.ok, policy.maxRopes > 1);
  if (policy.maxRopes === 1) {
    assert.equal(second.refusal, GDO_BREAKABLE_REFUSAL.ROPE_BUDGET);
  }
  assert.equal(board.diagnostics.selfCollisions, 0, 'no self-collision is modelled');
});

test('the flag wave is bounded, deterministic, and parked by reduced motion', () => {
  const first = sampleFlagWave({ u: 1, v: .5, timeMilliseconds: 900 });
  const repeated = sampleFlagWave({ u: 1, v: .5, timeMilliseconds: 900 });
  assert.deepEqual(first, repeated);
  // The hoist edge is pinned and the fly edge carries the motion.
  assert.deepEqual(sampleFlagWave({ u: 0, v: .5, timeMilliseconds: 900 }), { x: 0, y: 0, z: 0, sag: 0 });
  assert.ok(Math.abs(first.z) > 0);
  const policy = GDO_BREAKABLE_PROFILES.low;
  for (let time = 0; time < 4_000; time += 137) {
    for (const u of [.25, .5, .75, 1]) {
      const wave = sampleFlagWave({ u, v: .3, timeMilliseconds: time });
      assert.ok(Math.abs(wave.z) <= policy.flagAmplitude * 1.4, 'the wave stays inside its amplitude');
      assert.ok(Math.abs(wave.y) <= policy.flagAmplitude);
      assert.ok(Number.isFinite(wave.z));
    }
  }
  // Reduced motion parks the banner: no travel, no ripple.
  assert.deepEqual(sampleFlagWave({ u: 1, v: .5, timeMilliseconds: 900, reducedMotion: true }),
    { x: 0, y: 0, z: 0, sag: 0 });

  // The ribbon mesh is bounded by the profile's flag-point cap.
  const board = createBreakables({ profile: 'low' });
  const ribbon = board.flagRibbon({ timeMilliseconds: 500, segments: 40 });
  assert.ok(ribbon.points <= policy.maxFlagPoints);
  assert.equal(ribbon.positions.length, ribbon.points * ribbon.points * 3);
  assert.equal(board.flagRibbon({ timeMilliseconds: 500, segments: 40 }).positions.length, ribbon.positions.length);
});

test('the island runs on a fixed step with bounded per-frame work', () => {
  const board = createBreakables({ profile: 'balanced', seed: 4 });
  for (let index = 0; index < 3; index++) board.breakProp({ archetype: 'bench', x: index, z: 0 });
  board.createRope({ from: [0, .5, 0], to: [.3, .05, .1] });
  const policy = GDO_BREAKABLE_PROFILES.balanced;
  const steps = board.update(5_000);
  assert.ok(steps <= policy.maxSubstepsPerFrame, 'a stall is clamped');
  let total = steps;
  for (let frame = 0; frame < 20; frame++) total += board.update(1_000);
  assert.ok(total <= 21 * policy.maxSubstepsPerFrame, 'no catch-up spiral');
  assert.equal(board.update(Number.NaN), 0);
  assert.ok(board.diagnostics.malformedInputs > 0);
  assert.equal(board.diagnostics.steadyFrameAllocations, 0);

  // Two frame packings over the same time agree.
  const packed = (milliseconds, frames) => {
    const twin = createBreakables({ profile: 'balanced', seed: 4 });
    twin.breakProp({ archetype: 'crate', x: 1, z: 0 });
    twin.createRope({ from: [0, .5, 0], to: [.3, .05, .1] });
    for (let frame = 0; frame < frames; frame++) twin.update(milliseconds);
    return twin.fingerprint();
  };
  // The same elapsed time, packed two ways.
  assert.equal(packed(16.7, 20), packed(33.4, 10));
});

test('the world mounts the island: a shove breaks the crate it hits', () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  try {
    const world = new GeoWorld(new THREE.Scene(), { latitude: 28.99, longitude: 77.71 });
    assert.equal(world.updateBreakables(17).namespace, GDO_BREAKABLE_NAMESPACE);
    const initial = world.breakablesSummary;
    assert.equal(initial.activeChunks, 0, 'an idle world has nothing to draw');

    const spawned = world.spawnPushable({ x: 41, z: 41, kind: 'crate', radius: .25 });
    assert.equal(spawned.ok, true);
    const broken = world.breakNearestProp(41, 41, 2);
    assert.equal(broken.ok, true, 'the crate in reach is what breaks');
    assert.equal(broken.count, GDO_BREAKABLE_ARCHETYPES.crate.chunks);
    for (let time = 17; time < 500; time += 17) world.updateBreakables(17);
    assert.ok(world.breakablesSummary.activeChunks > 0, 'the chunks are live in the world');

    // Nothing in reach and no archetype named: a named refusal, not a silent break.
    assert.equal(world.breakNearestProp(900, 900, .1).refusal, 'out-of-range');
    // Mapped building geometry is never fractured, even when named directly.
    assert.equal(world.breakables.breakProp({ archetype: 'crate', source: 'mapped-building' }).refusal,
      GDO_BREAKABLE_REFUSAL.MAPPED_GEOMETRY);
    world.dispose();
    assert.equal(world.updateBreakables(17), null, 'a disposed world advances nothing');
  } finally {
    globalThis.Worker = originalWorker;
  }
});
