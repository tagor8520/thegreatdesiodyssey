import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from '../geo/GeoWorld.js';
import {
  GDO_RAGDOLL_ENGINES,
  GDO_RAGDOLL_NAMESPACE,
  GDO_RAGDOLL_PHYSICS_SCALE,
  GDO_RAGDOLL_PROFILES,
  GDO_RAGDOLL_REFUSAL,
  GDO_RAGDOLL_RIG,
  GDO_RAGDOLL_STATE,
  benchmarkRagdoll,
  createRagdollIsland,
} from './RagdollIsland.js';

const TUMBLE = Object.freeze({ requires: Object.freeze({ terrainTumble: true }) });

/** A stand-in solver with the island's adapter contract, not a physics engine. */
function fakeAdapter({ engine = 'cannon-es', bodies = GDO_RAGDOLL_RIG.bodies, speed = 1, decay = 1 } = {}) {
  const state = { steps: 0, disposed: 0, currentSpeed: speed };
  return {
    engine,
    state,
    bodies: Array.from({ length: bodies }, (_, index) => ({
      id: `body:${index}`, kind: 'capsule', x: index * .01, y: .1, z: 0,
      get speed() { return state.currentSpeed; },
    })),
    step() { state.steps++; state.currentSpeed *= decay; },
    dispose() { state.disposed++; },
  };
}

test('PHY-05 declares the research rig, the engine candidates, and per-profile budgets', () => {
  assert.equal(GDO_RAGDOLL_NAMESPACE, 'gdo:ragdollIsland:v1');
  // Research §7: ten bodies, nine joints, and nothing else simulated.
  assert.equal(GDO_RAGDOLL_RIG.bodies, 10);
  assert.equal(GDO_RAGDOLL_RIG.joints, 9);
  assert.equal(GDO_RAGDOLL_RIG.segments.length, GDO_RAGDOLL_RIG.bodies);
  assert.equal(GDO_RAGDOLL_PHYSICS_SCALE, 10, 'the research scale adapter is ×10');

  // Engine sizes are the research §8 observations and are labelled as modelled.
  assert.equal(GDO_RAGDOLL_ENGINES['cannon-es'].transferBytes, 346 * 1024);
  assert.equal(GDO_RAGDOLL_ENGINES['rapier3d-compat'].wasm, true);
  assert.ok(GDO_RAGDOLL_ENGINES['rapier3d-compat'].transferBytes > GDO_RAGDOLL_ENGINES['cannon-es'].transferBytes);
  for (const record of Object.values(GDO_RAGDOLL_ENGINES)) {
    assert.equal(record.measured, false, 'no engine is bundled, so none is called measured');
    assert.equal(record.source, 'research-§8');
    assert.equal(record.capabilities.angularLimits, true);
  }
  assert.equal(GDO_RAGDOLL_ENGINES['cannon-es'].capabilities.replayDeterminism, false);
  assert.equal(GDO_RAGDOLL_ENGINES['rapier3d-compat'].capabilities.replayDeterminism, true);

  // The low profile spends no transfer budget on a solver at all.
  assert.equal(GDO_RAGDOLL_PROFILES.low.maxTransferBytes, 0);
  assert.deepEqual([...GDO_RAGDOLL_PROFILES.low.allowedEngines], []);
  assert.ok(GDO_RAGDOLL_PROFILES.balanced.maxTransferBytes >= GDO_RAGDOLL_ENGINES['cannon-es'].transferBytes);
  assert.ok(GDO_RAGDOLL_PROFILES.high.maxTransferBytes >= GDO_RAGDOLL_ENGINES['rapier3d-compat'].transferBytes);
  assert.ok(GDO_RAGDOLL_PROFILES.low.stepHz < GDO_RAGDOLL_PROFILES.balanced.stepHz, 'low steps at half rate');
  assert.equal(GDO_RAGDOLL_PROFILES.balanced.secondActorDistance, 4, 'research §7 LOD: 4 game units');
  assert.equal(GDO_RAGDOLL_PROFILES.balanced.freezeDistance, 6, 'research §7 LOD: 6 game units');
});

test('the comparison measures the shipped baselines and models only the engines', () => {
  const report = benchmarkRagdoll({ profile: 'balanced', workload: TUMBLE, steps: 40 });
  assert.equal(report.namespace, GDO_RAGDOLL_NAMESPACE);
  assert.equal(report.deterministic, true);
  assert.equal(report.timing, null, 'no clock decides this row');
  assert.equal(report.staticMapBodies, 0);

  // Both baselines were run, and their numbers come from the modules themselves.
  const { poseFall, pbdPuppet } = report.baselines;
  assert.equal(poseFall.measured, true);
  assert.equal(poseFall.rigidBodies, 0);
  assert.equal(poseFall.constraintIterations, 0);
  assert.ok(poseFall.poseWrites > 0, 'the pose fall actually wrote poses');
  assert.equal(pbdPuppet.measured, true);
  assert.ok(pbdPuppet.constraintSolves > 0, 'the puppet actually solved constraints');
  assert.ok(pbdPuppet.collisionQueries > 0);
  assert.equal(pbdPuppet.rigidBodies, 0);

  // The engine rows are arithmetic over the research's declared sizes.
  for (const engine of report.engines) {
    assert.equal(engine.measured, false);
    assert.equal(engine.bodies, GDO_RAGDOLL_RIG.bodies);
    assert.equal(engine.joints, GDO_RAGDOLL_RIG.joints);
    assert.equal(engine.contacts, GDO_RAGDOLL_RIG.bodies * GDO_RAGDOLL_ENGINES[engine.engine].contactBudgetPerBody);
    assert.equal(engine.solverSamples, engine.constraintsPerStep * engine.solverIterations * 40);
  }
  // The headline the row is arguing about: a true solver costs a multiple of the puppet.
  assert.equal(report.comparison.poseFallSolverSamples, 0);
  assert.ok(report.comparison.engineOverPuppet > 1);
  assert.equal(report.comparison.cheapestEngineSolverSamples,
    Math.min(...report.engines.map(engine => engine.solverSamples)));
});

test('the decision follows the measured comparison, profile by profile', () => {
  // Nothing the pose fall cannot do: the zero-cost deterministic answer wins.
  const settle = benchmarkRagdoll({ profile: 'high', workload: { requires: {} } });
  assert.equal(settle.decision.reason, 'baseline-sufficient');
  assert.equal(settle.decision.engine, null);
  assert.equal(settle.decision.shipped, 'gdo:poseFall:v1');
  assert.equal(settle.decision.expectedSolverSamples, 0);

  // Terrain tumbling is the pose fall's stated limitation: balanced buys the island.
  const tumble = benchmarkRagdoll({ profile: 'balanced', workload: TUMBLE });
  assert.equal(tumble.decision.reason, 'engine-recommended');
  assert.equal(tumble.decision.engine, 'cannon-es', 'the smallest engine that can do it');
  assert.equal(tumble.decision.loadOn, 'first-request', 'and it is loaded lazily');
  assert.equal(tumble.decision.fallback, 'gdo:poseFall:v1');

  // Low has no transfer budget: the capability is real and explicitly unmet.
  const low = benchmarkRagdoll({ profile: 'low', workload: TUMBLE });
  assert.equal(low.decision.reason, 'capability-unavailable');
  assert.deepEqual([...low.decision.unmet], ['terrainTumble']);
  assert.equal(low.decision.shipped, 'gdo:poseFall:v1');

  // Replay determinism alone is not a reason to load a solver: the pose fall has it.
  const replay = benchmarkRagdoll({ profile: 'high', workload: { requires: { replayDeterminism: true } } });
  assert.equal(replay.refusesReplay, true);
  assert.equal(replay.decision.reason, 'baseline-sufficient');

  // Asking for replay determinism *and* tumbling promotes rapier on high.
  const both = benchmarkRagdoll({ profile: 'high', workload: { requires: { terrainTumble: true, replayDeterminism: true } } });
  assert.equal(both.decision.engine, 'rapier3d-compat');
  // …and that same workload is unaffordable on balanced, where only cannon is allowed.
  const balancedBoth = benchmarkRagdoll({ profile: 'balanced', workload: { requires: { terrainTumble: true, replayDeterminism: true } } });
  assert.equal(balancedBoth.decision.reason, 'capability-unavailable');
});

test('a knocked actor is never unsimulated, even before any engine arrives', () => {
  const island = createRagdollIsland({ profile: 'balanced', seed: 4 });
  const requested = island.request({ actorId: 'a', x: 2, z: 1, impulse: [1.5, 0, .5], requires: { terrainTumble: true } });
  // The fallback is engaged on the same call that requests the engine.
  assert.equal(island.poseFalls.falling, 1, 'the pose fall owns the actor immediately');
  assert.equal(requested.state, GDO_RAGDOLL_STATE.ANIMATED);
  assert.equal(requested.fallback, 'gdo:poseFall:v1');
  assert.equal(requested.refusal, GDO_RAGDOLL_REFUSAL.ENGINE_UNAVAILABLE);
  assert.equal(island.diagnostics.loadFailures, 1, 'and the failed load is counted');

  // It keeps falling on the board's own fixed step.
  for (let frame = 0; frame < 40; frame++) island.step(16.7);
  assert.equal(island.read('a').state, GDO_RAGDOLL_STATE.ANIMATED);
  assert.ok(island.poseFalls.diagnostics.totalSteps > 0);
  assert.equal(island.read('a').speed, 0, 'an unloaded actor has no solver velocity');
  assert.equal(island.diagnostics.rigidBodies, 0);
  assert.equal(island.diagnostics.staticMapBodies, 0);
  assert.equal(island.diagnostics.authoritativeQueryIntact, true);

  // A second request on low is over the cap and falls back by name.
  const low = createRagdollIsland({ profile: 'low' });
  assert.equal(low.request({ actorId: 'b', x: 0, z: 0 }).reason, 'baseline-sufficient');
  low.dispose();
  assert.equal(low.request({ actorId: 'c', x: 0, z: 0 }).refusal, GDO_RAGDOLL_REFUSAL.DISPOSED);
});

test('a loaded adapter takes over with a handoff, then settles, sleeps and freezes', () => {
  const island = createRagdollIsland({ profile: 'balanced', seed: 2 });
  const adapter = fakeAdapter({ speed: .5, decay: .5 });
  const requested = island.request({
    actorId: 'a', x: 1, z: 1, impulse: [1.2, 0, 0], requires: { terrainTumble: true },
    load: () => adapter,
  });
  assert.equal(requested.state, GDO_RAGDOLL_STATE.ACTIVE);
  assert.equal(requested.engine, 'cannon-es');
  // The handoff copies the pose already on screen: seven segments, three borrowed.
  assert.equal(requested.handoffFrames, 7);
  assert.equal(island.read('a').handoffMissing, 3);

  // The adapter steps at the profile's fixed rate, not once per render frame.
  let frames = 0;
  while (island.read('a').state === GDO_RAGDOLL_STATE.ACTIVE && frames < 400) { island.step(16.7); frames++; }
  assert.ok(adapter.state.steps > 0);
  assert.equal(island.diagnostics.adapterSteps, adapter.state.steps);
  assert.ok(frames < 400, 'it reaches a settled state');
  assert.ok([GDO_RAGDOLL_STATE.SETTLING, GDO_RAGDOLL_STATE.SLEEPING, GDO_RAGDOLL_STATE.FROZEN]
    .includes(island.read('a').state));

  // Force-freeze is a hard ceiling on active time, whatever the solver reports.
  const stubborn = createRagdollIsland({ profile: 'balanced' });
  stubborn.request({
    actorId: 'b', x: 0, z: 0, impulse: [1, 0, 0], requires: { terrainTumble: true },
    load: () => fakeAdapter({ speed: 9, decay: 1 }),
  });
  const policy = GDO_RAGDOLL_PROFILES.balanced;
  for (let frame = 0; frame < Math.ceil(policy.forceFreezeSeconds * 120); frame++) stubborn.step(16.7);
  assert.equal(stubborn.read('b').state, GDO_RAGDOLL_STATE.FROZEN);
  assert.equal(stubborn.read('b').frozen, true);
  const frozenSteps = stubborn.diagnostics.adapterSteps;
  stubborn.step(16.7);
  assert.equal(stubborn.diagnostics.adapterSteps, frozenSteps, 'a frozen ragdoll stops costing');

  // A bad adapter is refused by name and leaves the actor falling.
  const picky = createRagdollIsland({ profile: 'balanced' });
  const bad = picky.request({
    actorId: 'c', x: 0, z: 0, requires: { terrainTumble: true }, load: () => ({ step: 'nope' }),
  });
  assert.equal(bad.state, GDO_RAGDOLL_STATE.ANIMATED);
  assert.equal(picky.poseFalls.falling, 1, 'the deterministic answer kept the actor');
  assert.equal(picky.activate('c', fakeAdapter()).ok, false, 'and no second activation sneaks in');
  assert.equal(picky.remove('c').ok, true);
  assert.equal(picky.remove('c').ok, false);

  // Disposal reaches every adapter exactly once.
  island.dispose();
  assert.equal(adapter.state.disposed, 1);
  assert.equal(island.diagnostics.actors, 0);
  island.dispose();
  assert.equal(adapter.state.disposed, 1, 'dispose is idempotent');
});

test('the boundary proxies come from the authoritative query, capped and stable', () => {
  const queries = [];
  const island = createRagdollIsland({
    profile: 'balanced',
    heightAt: (x, z) => x * .01,
    querySolids: (x, z, radius) => {
      queries.push({ x, z, radius });
      return [
        { id: 'tile:1:7', kind: 'wall', x: x + .2, z, radius: .4, yMin: 0, yMax: 1.2 },
        { id: 'tile:1:9', kind: 'wall', x, z: z + .3, radius: .5 },
        { id: 'broken' },
        ...Array.from({ length: 40 }, (_, index) => ({ id: `tile:1:${100 + index}`, x, z, radius: .3 })),
      ];
    },
  });
  const first = island.buildProxySet(0, 0);
  assert.equal(first.ok, true);
  assert.equal(first.rebuilt, true);
  assert.equal(queries.length, 1, 'one query per rebuild');
  // Two caps apply and the tighter one wins: the pool's size and the number of
  // proxies one rebuild is allowed to admit.
  const policy = GDO_RAGDOLL_PROFILES.balanced;
  assert.equal(first.proxies.length, Math.min(policy.maxBoundaryProxies, policy.maxProxyQueriesPerRebuild));
  // Stable ids tied to the source feature, so tile unload removes the right body.
  assert.equal(first.proxies[0].id, 'proxy:tile:1:7');
  assert.equal(first.proxies[0].sourceId, 'tile:1:7');
  assert.equal(first.proxies[0].yMax, 1.2, 'the exact vertical interval survives');
  assert.ok(Math.abs(first.proxies[1].yMin - island.toGame(0, 0, 0).y) >= 0, 'an unsupplied interval is sampled');
  assert.equal(island.diagnostics.proxyWrites, first.proxies.length);
  assert.equal(island.diagnostics.proxies, first.proxies.length);

  // Same cell: no rebuild, no query. New cell: one rebuild.
  const repeat = island.buildProxySet(.5, .5);
  assert.equal(repeat.rebuilt, false);
  assert.equal(queries.length, 1);
  island.buildProxySet(12, 0);
  assert.equal(queries.length, 2);
  assert.equal(island.diagnostics.proxyRebuilds, 2);

  // The static map is queried, never mirrored.
  assert.equal(island.diagnostics.staticMapBodies, 0);
  assert.equal(island.diagnostics.authoritativeQueryIntact, true);
  assert.equal(island.diagnostics.pinnedSources, policy.maxProxyQueriesPerRebuild);

  // Degenerate input cannot fabricate proxies.
  const blind = createRagdollIsland({ profile: 'balanced' });
  assert.deepEqual(blind.buildProxySet(1, 1).proxies, []);
  assert.equal(blind.diagnostics.proxyQueries, 0);
});

test('the scale adapter round-trips and two identical islands agree exactly', () => {
  const island = createRagdollIsland({ profile: 'balanced' });
  assert.equal(island.toPhysics(1, .2, 0).y, 2, 'a 0.2-unit avatar is 2 physics units tall');
  assert.equal(island.toPhysics(.5, 0, .25).x, 5);
  const round = island.toGame(island.toPhysics(3, .4, -2).x, island.toPhysics(3, .4, -2).y, island.toPhysics(3, .4, -2).z);
  assert.deepEqual(round, { x: 3, y: .4, z: -2 });

  const run = () => {
    const twin = createRagdollIsland({ profile: 'balanced', seed: 9 });
    twin.request({ actorId: 'a', x: 1, z: 1, impulse: [1.1, 0, .2] });
    for (let frame = 0; frame < 30; frame++) twin.step(16.7);
    return JSON.stringify(twin.diagnostics);
  };
  assert.equal(run(), run());
});

test('the world mounts the island: a request falls back to the real pose board', () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  try {
    const world = new GeoWorld(new THREE.Scene(), { latitude: 28.99, longitude: 77.71 });
    // One clock and one pose record per actor: the island shares the world's board.
    assert.equal(world.ragdollIsland.poseFalls, world.poseFalls);
    assert.equal(world.updateRagdolls(17).namespace, GDO_RAGDOLL_NAMESPACE);

    const requested = world.requestRagdoll(41, 41, { impulse: [1.4, 0, .4], requires: { terrainTumble: true } });
    assert.equal(requested.state, GDO_RAGDOLL_STATE.ANIMATED);
    assert.equal(requested.reason, 'capability-unavailable', 'low ships the deterministic answer');
    assert.equal(requested.fallback, 'gdo:poseFall:v1');
    assert.equal(requested.staticMapBodies, 0);
    assert.equal(world.ragdollSummary.namespace, GDO_RAGDOLL_NAMESPACE);

    // The actor really falls, on the world's own board and clock.
    for (let time = 17; time < 400; time += 17) {
      world.updatePoseFalls(17);
      world.updateRagdolls(17);
    }
    assert.equal(world.poseFalls.falling, 1);
    assert.ok(world.poseFalls.diagnostics.totalSteps > 0);

    // The boundary query answers from the tile collision data, and never mirrors it.
    const boundary = world.ragdollBoundaryQuery(41, 41, 4);
    assert.ok(Array.isArray(boundary));
    assert.equal(world.ragdollProxyQueries > 0, true);
    const island = world.ragdollIsland.buildProxySet(41, 41);
    assert.equal(island.ok, true);
    assert.equal(world.ragdollIsland.diagnostics.staticMapBodies, 0);
    assert.equal(world.ragdollIsland.diagnostics.authoritativeQueryIntact, true);

    // The profile's measured comparison is quotable from the world.
    const decision = world.ragdollDecision({ requires: { terrainTumble: true } });
    assert.equal(decision.profile, 'low');
    assert.equal(decision.decision.reason, 'capability-unavailable');
    assert.equal(decision.baselines.poseFall.measured, true);

    world.dispose();
    const afterDispose = world.requestRagdoll(0, 0);
    assert.equal(afterDispose.refusal, 'disposed');
    assert.deepEqual(world.requestRagdoll(0, 0), afterDispose, 'a disposed world refuses deterministically');
    assert.equal(world.updateRagdolls(17), null);
  } finally {
    globalThis.Worker = originalWorker;
  }
});
