import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from '../geo/GeoWorld.js';
import {
  GDO_INTEREST_JOIN_BYTES,
  GDO_INTEREST_JOIN_MAX_BYTES,
  GDO_INTEREST_LOCOMOTION,
  GDO_INTEREST_NAMESPACE,
  GDO_INTEREST_POSTURE,
  GDO_INTEREST_PROFILES,
  GDO_INTEREST_QUANTISATION,
  GDO_INTEREST_REFUSAL,
  createInterestSet,
  decodeJoinPayload,
  encodeJoinPayload,
  estimateStreamBudget,
  sessionTag,
} from './SpatialInterest.js';
import { GDO_LOW_PROFILE_BUDGETS, assertLowProfileBudget, evaluateLowProfileBudget } from './PerformanceBudget.js';

function player(id, x, z, extra = {}) {
  return { id, x, z, y: 0, yaw: 0, locomotion: 'idle', posture: 'standing', phase: 0, flags: 0, ...extra };
}

test('NET-03 implements the NET-02 numbers, not new ones', () => {
  assert.equal(GDO_INTEREST_NAMESPACE, 'gdo:interest:v1');
  // §6 interest: 32-unit cells, 64 in, 80 out.
  for (const profile of ['low', 'balanced', 'high']) {
    const policy = GDO_INTEREST_PROFILES[profile];
    assert.equal(policy.cellSize, 32);
    assert.equal(policy.enterRadius, 64);
    assert.equal(policy.leaveRadius, 80);
    assert.equal(policy.leaveRadius / policy.enterRadius, 1.25, 'the declared 1.25x hysteresis');
    // §5.1 budget.
    assert.equal(policy.snapshotHz, 20);
    assert.equal(policy.interpolationDelayMilliseconds, 100);
    assert.equal(policy.maxExtrapolationMilliseconds, 120);
    // §5.2 record sizes.
    assert.equal(policy.snapshotHeaderBytes, 12);
    assert.equal(policy.playerRecordBytes, 9);
    assert.equal(policy.entityRecordBytes, 3);
    assert.equal(GDO_INTEREST_QUANTISATION.bitsPerPlayer, 66);
    assert.ok(policy.playerRecordBytes * 8 >= GDO_INTEREST_QUANTISATION.bitsPerPlayer);
  }
  // §5.1 caps and budgets, profile by profile.
  assert.deepEqual(['low', 'balanced', 'high'].map(p => GDO_INTEREST_PROFILES[p].maxTrackedPlayers), [4, 8, 12]);
  assert.deepEqual(['low', 'balanced', 'high'].map(p => GDO_INTEREST_PROFILES[p].downBudgetBytesPerSecond / 1024), [4, 8, 16]);
  // The low profile's own ceiling is the one QLT-05 already evaluates.
  assert.equal(GDO_LOW_PROFILE_BUDGETS.networkTrackedPlayers, GDO_INTEREST_PROFILES.low.maxTrackedPlayers);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.networkSnapshotBytesPerSecond,
    GDO_INTEREST_PROFILES.low.downBudgetBytesPerSecond);
  // The enums are declared, one byte can reach every one of them.
  assert.ok(GDO_INTEREST_LOCOMOTION.length <= 16);
  assert.ok(GDO_INTEREST_POSTURE.length <= 16);
  assert.equal(GDO_INTEREST_LOCOMOTION[0], 'idle');
  assert.equal(GDO_INTEREST_POSTURE[0], 'standing');
});

test('interest enters at 64, holds to 80, and drops past it', () => {
  const set = createInterestSet({ profile: 'low' });
  // Outside the enter radius: never tracked.
  set.update(0, 0, { players: [player('p:far', 65, 0)] });
  assert.equal(set.has('p:far'), false, '65 units is outside the 64-unit enter radius');

  // Inside it: tracked.
  set.update(0, 0, { players: [player('p:near', 60, 0)] });
  assert.equal(set.has('p:near'), true);

  // Between the two radii, a tracked player stays tracked (hysteresis, no churn)…
  const held = set.update(0, 0, { players: [player('p:near', 70, 0)] });
  assert.equal(set.has('p:near'), true, '70 units is inside the leave radius');
  assert.equal(held.left.length, 0);
  // …and an untracked one does not enter.
  set.update(0, 0, { players: [player('p:near', 70, 0), player('p:edge', 70, 0)] });
  assert.equal(set.has('p:edge'), false, 'and 70 units is outside the enter radius');

  // Past the leave radius: gone, and counted.
  const dropped = set.update(0, 0, { players: [player('p:near', 100, 0)] });
  assert.equal(set.has('p:near'), false);
  assert.deepEqual([...dropped.left], ['p:near']);

  // A peer the server stops sending is removed rather than left stale.
  set.update(0, 0, { players: [player('p:a', 10, 0), player('p:b', 12, 0)] });
  assert.equal(set.size, 2);
  const gone = set.update(0, 0, { players: [player('p:a', 10, 0)] });
  assert.deepEqual([...gone.left], ['p:b']);
  assert.equal(set.has('p:b'), false);

  // Bad input is a named refusal, never a silent no-op.
  assert.equal(set.update(Number.NaN, 0, { players: [] }).refusal, GDO_INTEREST_REFUSAL.BAD_INPUT);
  assert.equal(set.update(0, 0, { players: 'nope' }).refusal, GDO_INTEREST_REFUSAL.BAD_INPUT);
  assert.ok(set.diagnostics.malformedInputs >= 2);
});

test('the cap keeps the nearest players and reports the overflow', () => {
  const policy = GDO_INTEREST_PROFILES.low;
  const set = createInterestSet({ profile: 'low' });
  // Twelve candidates inside the enter radius, at increasing distance.
  const crowd = Array.from({ length: 12 }, (_, index) => player(`p:${index}`, 5 + index * 4, 0));
  const result = set.update(0, 0, { players: crowd.reverse() });
  assert.equal(result.tracked.length, policy.maxTrackedPlayers);
  assert.equal(result.overflow, 12 - policy.maxTrackedPlayers);
  // Nearest first: p:0 is closest and must be present; the far end is dropped.
  assert.equal(set.has('p:0'), true);
  assert.equal(set.has('p:11'), false);
  assert.equal(set.diagnostics.interestOverflow, 12 - policy.maxTrackedPlayers);

  // Balanced and high track more, because their ceilings say so.
  for (const [profile, expected] of [['balanced', 8], ['high', 12]]) {
    const board = createInterestSet({ profile });
    const many = Array.from({ length: 20 }, (_, index) => player(`q:${index}`, 4 + index * 2, 0));
    board.update(0, 0, { players: many });
    assert.equal(board.size, expected, `${profile} tracks ${expected}`);
  }
});

test('a full rebuild happens on a cell crossing, and only then', () => {
  let queries = 0;
  const set = createInterestSet({
    profile: 'low',
    queryEntities: () => { queries++; return [{ id: 'prop:1', index: 3, state: 1 }]; },
  });
  // First update establishes the cell: that is a rebuild.
  const first = set.update(0, 0, { players: [] });
  assert.equal(first.crossed, true);
  assert.equal(queries, 1);
  assert.equal(set.diagnostics.cellRebuilds, 1);

  // Walking inside the same 32-unit cell never re-queries.
  for (const x of [2, 7, 15, 31.9]) {
    const result = set.update(x, 0, { players: [] });
    assert.equal(result.crossed, false);
    assert.deepEqual(result.cell, { x: 0, z: 0 });
  }
  assert.equal(queries, 1, 'one query for one cell');
  assert.equal(set.diagnostics.entityQueries, 1);

  // Crossing into the next cell re-queries exactly once.
  const crossed = set.update(32, 0, { players: [] });
  assert.equal(crossed.crossed, true);
  assert.deepEqual(crossed.cell, { x: 1, z: 0 });
  assert.equal(queries, 2);

  // Between rebuilds membership still moves — the radius test is cheap, and an
  // avatar cannot become invisible just because it stayed in the same cell.
  set.update(40, 0, { players: [player('p:in', 50, 0)] });
  assert.equal(set.has('p:in'), true);
  assert.equal(queries, 2, 'and still no extra query');

  // Entities carry their deterministic index; the id never goes on the wire.
  assert.equal(set.hasEntity('prop:1'), true);
  assert.equal(set.entityIndexOf('prop:1'), 3);
  assert.equal(set.diagnostics.trackedEntities, 1);
});

test('an id outside the interest set is refused, and counted', () => {
  // The entity only exists near the origin, so leaving the cell really does forget it.
  const set = createInterestSet({
    profile: 'low',
    queryEntities: (x) => (Math.abs(x) < 100 ? [{ id: 'prop:7', index: 7, state: 0 }] : []),
  });
  set.update(0, 0, { players: [player('p:1', 5, 0)] });

  assert.deepEqual(set.validate('p:1'), { ok: true, id: 'p:1' });
  assert.deepEqual(set.validate('prop:7'), { ok: true, id: 'prop:7' });
  // Guessing an id, referencing an entity outside the cell, or sending junk all
  // land on the same rule (§4.2).
  for (const bad of ['p:2', 'prop:99', '', null, 42, {}]) {
    const verdict = set.validate(bad);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.refusal, GDO_INTEREST_REFUSAL.UNKNOWN_ENTITY);
  }
  assert.equal(set.diagnostics.rejectedReferences, 6);
  assert.equal(set.diagnostics.refusals[GDO_INTEREST_REFUSAL.UNKNOWN_ENTITY], 6);

  // Leaving the cell forgets the entity, so the same id stops validating.
  set.update(400, 400, { players: [] });
  assert.equal(set.validate('prop:7').refusal, GDO_INTEREST_REFUSAL.UNKNOWN_ENTITY);
});

test('snapshots are nine bytes a player and decode inside the declared error', () => {
  const set = createInterestSet({ profile: 'low', heightAt: (x) => x * .01 });
  const source = [
    player('p:1', 10, 5, { y: .5, yaw: 1.2, locomotion: 'run', posture: 'crouched', phase: .5, flags: 3 }),
    player('p:2', -12.5, 30.25, { y: -.4, yaw: -2.9, locomotion: 'wade', posture: 'wading', phase: 1, flags: 0 }),
  ];
  set.update(0, 0, { players: source });
  const encoded = set.encodeSnapshot({ x: 0, z: 0, tick: 9, sequence: 3 });
  assert.equal(encoded.ok, true);
  // 12-byte header + 2 x 9 bytes, exactly.
  assert.equal(encoded.bytes, 12 + 2 * 9);
  assert.equal(encoded.players, 2);
  assert.equal(encoded.bits, 2 * 66);
  assert.equal(encoded.bytesPerSecond, encoded.bytes * 20);
  assert.equal(encoded.view.length, encoded.bytes);

  const decoded = set.decodeSnapshot(encoded.view);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.header.tick, 9);
  assert.equal(decoded.header.sequence, 3);
  assert.equal(decoded.header.players, 2);
  const [first, second] = decoded.players;
  // Declared worst-case error, asserted rather than trusted.
  assert.ok(Math.abs(first.x - 10) <= GDO_INTEREST_QUANTISATION.positionMetres);
  assert.ok(Math.abs(first.z - 5) <= GDO_INTEREST_QUANTISATION.positionMetres);
  assert.ok(Math.abs(second.x - -12.5) <= GDO_INTEREST_QUANTISATION.positionMetres);
  assert.ok(Math.abs(second.z - 30.25) <= GDO_INTEREST_QUANTISATION.positionMetres);
  // y is a delta from the deterministic sample, so it round-trips as one.
  assert.ok(Math.abs(first.y - (.5 - .1)) <= GDO_INTEREST_QUANTISATION.yMetres);
  assert.ok(Math.abs(first.yaw - 1.2) <= GDO_INTEREST_QUANTISATION.yawRadians);
  assert.equal(first.locomotion, 'run');
  assert.equal(first.posture, 'crouched');
  assert.equal(first.flags, 3);
  assert.ok(Math.abs(first.phase - .5) <= 1 / 126);

  // Deterministic: the same interest set encodes the same bytes.
  const twin = createInterestSet({ profile: 'low', heightAt: (x) => x * .01 });
  twin.update(0, 0, { players: source });
  assert.deepEqual([...twin.encodeSnapshot({ x: 0, z: 0, tick: 9, sequence: 3 }).view],
    [...encoded.view]);

  // Malformed frames are refused by name and never throw (§7 threat 6).
  assert.equal(set.decodeSnapshot(null).refusal, GDO_INTEREST_REFUSAL.BAD_INPUT);
  assert.equal(set.decodeSnapshot(new Uint8Array(4)).refusal, GDO_INTEREST_REFUSAL.MALFORMED_SNAPSHOT);
  const truncated = encoded.view.slice(0, 12 + 9);
  assert.equal(set.decodeSnapshot(truncated).refusal, GDO_INTEREST_REFUSAL.MALFORMED_SNAPSHOT);
  const lying = new Uint8Array(encoded.view);
  lying[9] = 250; // claims 250 players in a four-player profile
  assert.equal(set.decodeSnapshot(lying).refusal, GDO_INTEREST_REFUSAL.MALFORMED_SNAPSHOT);
  // Decoding into the reused record set allocates nothing new.
  const firstDecode = set.decodeSnapshot(encoded.view);
  const secondDecode = set.decodeSnapshot(encoded.view);
  assert.equal(firstDecode.players, secondDecode.players, 'the same record objects are reused');
});

test('the stream stays inside every profile ceiling and QLT-05 can check it', () => {
  for (const profile of ['low', 'balanced', 'high']) {
    const budget = estimateStreamBudget({ profile });
    assert.equal(budget.withinBudget, true, `${profile} fits its own ceiling`);
    assert.ok(budget.bytesPerSecond <= GDO_INTEREST_PROFILES[profile].downBudgetBytesPerSecond);
    assert.equal(budget.joinBytes, GDO_INTEREST_JOIN_BYTES);
    assert.equal(budget.networkGeometryBytes, 0);
    assert.equal(budget.networkSteadyFrameAllocations, 0);
  }
  // A full low-profile snapshot is header + four players + sixteen entities.
  const low = estimateStreamBudget({ profile: 'low' });
  assert.equal(low.snapshotBytes, 12 + 4 * 9 + 16 * 3);
  assert.equal(low.bytesPerSecond, low.snapshotBytes * 20);
  assert.ok(low.bytesPerSecond <= GDO_LOW_PROFILE_BUDGETS.networkSnapshotBytesPerSecond);

  // An encode's own measurement agrees with the estimator.
  const set = createInterestSet({ profile: 'low', queryEntities: () => [] });
  set.update(0, 0, { players: Array.from({ length: 4 }, (_, index) => player(`p:${index}`, index, 0)) });
  const encoded = set.encodeSnapshot({ x: 0, z: 0 });
  assert.equal(encoded.bytesPerSecond, estimateStreamBudget({ profile: 'low', trackedEntities: 0 }).bytesPerSecond);

  // The QLT-05 evaluator now knows these keys, and a breach is a breach.
  const report = assertLowProfileBudget({
    networkSnapshotBytesPerSecond: low.bytesPerSecond,
    networkTrackedPlayers: 4,
    networkGeometryBytes: 0,
    networkSteadyFrameAllocations: 0,
    networkJoinPayloadBytes: GDO_INTEREST_JOIN_BYTES,
  });
  assert.equal(report.ok, true);
  const breach = evaluateLowProfileBudget({ networkSnapshotBytesPerSecond: 6 * 1024 });
  assert.equal(breach.ok, false);
  assert.equal(breach.breaches[0].metric, 'networkSnapshotBytesPerSecond');
  // Geometry on the wire is never acceptable, at any profile.
  assert.equal(evaluateLowProfileBudget({ networkGeometryBytes: 1 }).ok, false);
});

test('the join payload is sixteen bytes and carries no geometry', () => {
  const encoded = encodeJoinPayload({
    seed: 73868884, contentVersion: 3, weatherMonth: 7, timeBaseSeconds: 1_700_000_000, sessionId: 'abc',
  });
  assert.equal(encoded.ok, true);
  assert.equal(encoded.bytes, GDO_INTEREST_JOIN_BYTES);
  assert.ok(encoded.bytes <= GDO_INTEREST_JOIN_MAX_BYTES);
  assert.equal(encoded.geometryBytes, 0);

  const decoded = decodeJoinPayload(encoded.view);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.seed, 73868884);
  assert.equal(decoded.contentVersion, 3);
  assert.equal(decoded.weatherMonth, 7);
  assert.equal(decoded.timeBaseSeconds, 1_700_000_000);
  // The wire carries a *tag*, not the token: no credential travels (§7.1).
  assert.equal(decoded.sessionTag, sessionTag('abc'));
  assert.notEqual(decoded.sessionTag, 'abc');
  assert.equal(decoded.geometryBytes, 0);

  // Deterministic, and malformed input refused.
  assert.deepEqual([...encodeJoinPayload({ seed: 1, sessionId: 'x' }).view],
    [...encodeJoinPayload({ seed: 1, sessionId: 'x' }).view]);
  assert.equal(encodeJoinPayload({ seed: Number.NaN }).refusal, GDO_INTEREST_REFUSAL.BAD_INPUT);
  assert.equal(decodeJoinPayload(new Uint8Array(4)).refusal, GDO_INTEREST_REFUSAL.MALFORMED_SNAPSHOT);
  assert.equal(decodeJoinPayload(null).refusal, GDO_INTEREST_REFUSAL.MALFORMED_SNAPSHOT);
});

test('the world opens a session on demand and single-player stays untouched', () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  try {
    const world = new GeoWorld(new THREE.Scene(), { latitude: 28.99, longitude: 77.71 });
    // §8.1: no session exists until a host opens one, and no frame path creates it.
    assert.equal(world.session, null);
    assert.equal(world.updateSession(0, 0).refusal, 'not-a-session');
    assert.equal(world.sessionSnapshot().refusal, 'not-a-session');
    assert.equal(world.validateSessionReference('p:1').refusal, 'not-a-session');

    const opened = world.openSession({ sessionId: 's1', contentVersion: 2, weatherMonth: 6, timeBaseSeconds: 900 });
    assert.equal(opened.ok, true);
    assert.equal(opened.namespace, GDO_INTEREST_NAMESPACE);
    assert.equal(opened.join.bytes, GDO_INTEREST_JOIN_BYTES);
    assert.equal(opened.join.geometryBytes, 0);
    assert.equal(opened.join.seed, world.terrainSeed, 'the join carries the seed both sides regenerate from');
    assert.equal(world.openSession().refusal, 'already-open');

    // A shared prop becomes an interest-scoped entity with a stable index.
    const crate = world.spawnPushable({ x: 41, z: 41, kind: 'crate', radius: .25 });
    assert.equal(crate.ok, true);
    const summary = world.updateSession(41, 41, [player('p:1', 41.5, 41, { y: .3 })]);
    assert.equal(summary.tracked, 1);
    assert.equal(summary.entered, 1);
    assert.equal(summary.networkGeometryBytes, 0);
    assert.equal(world.session.interest.entities().length, 1);
    assert.equal(world.validateSessionReference(`prop:${crate.id}`).ok, true);

    const snapshot = world.sessionSnapshot({ tick: 5, sequence: 1, x: 41, z: 41 });
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.bytes, 12 + 9 + 3);
    assert.ok(snapshot.bytesPerSecond <= GDO_INTEREST_PROFILES.low.downBudgetBytesPerSecond);
    assert.equal(world.session.interest.decodeSnapshot(snapshot.view).players[0].posture, 'standing');

    // Closing returns the world to the single-player state exactly.
    assert.equal(world.closeSession().ok, true);
    assert.equal(world.session, null);
    assert.equal(world.sessionSummary, null);
    assert.equal(world.updateSession(0, 0).refusal, 'not-a-session');

    // A disposed world refuses rather than half-working.
    world.openSession({ sessionId: 's2' });
    const interest = world.session.interest;
    world.dispose();
    assert.equal(interest.diagnostics.disposed, true, 'the ledger released the session');
    assert.equal(world.openSession().refusal, 'disposed');
    assert.equal(world.updateSession(0, 0).refusal, 'disposed');
  } finally {
    globalThis.Worker = originalWorker;
  }
});
