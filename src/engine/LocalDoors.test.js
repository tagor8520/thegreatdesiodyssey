import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_DOOR_KIND, GDO_DOOR_NAMESPACE, GDO_DOOR_PROFILES, GDO_DOOR_REFUSAL, GDO_DOOR_STATE,
  createLocalDoors, doorBlocksClosing, doorLeafBox, easeDoorAmount,
} from './LocalDoors.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import { GDO_FEATURE_VERSIONS } from './FeatureVersions.js';
import { LifecycleLedger } from './LifecycleContract.js';

/**
 * `PHY-01` gate: one scalar open amount with authored easing, a thin oriented
 * box written **only while moving**, a close sensor that never sweeps a leaf
 * through the player — a bounded kinematic proxy, no full engine.
 */

const PLAYER = Object.freeze({ x: 0, y: 0, z: 0, radius: .09, height: .28 });

function boardWith(entries, { profile = 'low' } = {}) {
  const board = createLocalDoors({ profile });
  board.rebuild(entries);
  return board;
}

function entry(id, extra = {}) {
  return {
    id, x: 0, y: 0, z: 0, heading: 0,
    width: .3, height: .32, thickness: .03, hinge: 1, ...extra,
  };
}

test('PHY-01 one scalar eases to its target and never overshoots', () => {
  assert.ok(Math.abs(easeDoorAmount(0, 1, 1, .25) - .25) < 1e-9);
  assert.ok(Math.abs(easeDoorAmount(.2, 1, 1, .5) - .7) < 1e-9);
  assert.equal(easeDoorAmount(.2, 1, 1, 5), 1, 'the scalar stops at the target');
  assert.ok(Math.abs(easeDoorAmount(.8, 0, 1, .5) - .3) < 1e-9);
  assert.equal(easeDoorAmount(.5, .5, 1, 1), .5);
});

test('PHY-01 the thin leaf box swings about its hinge edge with the scalar', () => {
  const door = {
    x: 1, y: 0, z: 2, heading: 0, width: .3, height: .32, thickness: .03,
    hinge: 1, amount: 0, maxSwingRadians: 1.32,
  };
  const closed = doorLeafBox(door);
  assert.ok(Math.abs(closed.x - (1 - .15)) < 1e-6, 'closed: the centre sits half a leaf from the hinge');
  assert.ok(Math.abs(closed.z - 2) < 1e-6);
  assert.ok(Math.abs(closed.halfWidth - .15) < 1e-6, 'closed: the leaf spans the doorway');
  door.amount = 1;
  const open = doorLeafBox(door);
  assert.ok(Math.abs(open.rotation - 1.32) < 1e-6, 'open: the yaw is the hinge swing of the one scalar');
  assert.ok(open.halfWidth < .02, 'open: the leaf shrinks to nothing at the passable mark');
  assert.ok(Math.abs(open.x - 1) < 1e-6, 'open: the centre returns to the hinge');
  door.hinge = -1;
  const mirrored = doorLeafBox(door);
  assert.ok(Math.abs(mirrored.rotation + 1.32) < 1e-6, 'the hinge side mirrors the swing');
});

test('PHY-01 the gate: the proxy is written only while moving', () => {
  const board = boardWith([entry('a'), entry('b', { x: 3 })]);
  // The first pass registers the rebuilt leaves once (an insert each) — that is
  // registration, not a per-frame update.
  assert.equal(board.update({ nowMilliseconds: 0, dtMilliseconds: 16, player: PLAYER }), 2);
  assert.equal(board.counters.proxyInserts, 2);
  // A settled door then contributes nothing to any steady frame.
  assert.equal(board.update({ nowMilliseconds: 16, dtMilliseconds: 16, player: PLAYER }), 0);
  assert.equal(board.changes().count, 0);
  // Toggling makes it move: one insert, then moves while the scalar ramps.
  board.toggleNear(0, 0, 0, { nowMilliseconds: 0 });
  let inserts = 0, moves = 0, removals = 0, total = 0;
  for (let tick = 1; tick <= 80; tick++) {
    const count = board.update({ nowMilliseconds: tick * 16, dtMilliseconds: 16, player: PLAYER });
    total += count;
    const { changes, count: changeCount } = board.changes();
    for (let index = 0; index < changeCount; index++) {
      if (changes[index].kind === 'insert') inserts++;
      else if (changes[index].kind === 'move') moves++;
      else removals++;
    }
  }
  assert.ok(removals >= 1, 'a passable doorway drops its proxy');
  assert.ok(moves >= 1, 'the moving leaf updates its thin OBB');
  assert.equal(board.summary({}).open, 1, 'the scalar reached open');
  // Settled again: nothing is written.
  assert.equal(board.update({ nowMilliseconds: 2_000, dtMilliseconds: 16, player: PLAYER }), 0);
  assert.equal(board.counters.proxyInserts + board.counters.proxyMoves + board.counters.proxyRemovals,
    total + 2, 'every change is counted, and the two initial registrations are separate');
});

test('PHY-01 the close sensor never sweeps a leaf through the player', () => {
  const board = boardWith([entry('door')]);
  board.toggleNear(0, 0, 0, { nowMilliseconds: 0 });
  for (let tick = 1; tick <= 80; tick++) {
    board.update({ nowMilliseconds: tick * 16, dtMilliseconds: 16, player: PLAYER });
  }
  assert.equal(board.summary({}).open, 1);
  // Past the hold the auto-close begins — and the player stands in the doorway.
  let frozenSaw = 0;
  const clockAt = tick => 6_000 + tick * 16;
  for (let tick = 0; tick < 60; tick++) {
    board.update({ nowMilliseconds: clockAt(tick), dtMilliseconds: 16, player: PLAYER });
    const door = board.slots.find(slot => slot.id === 'door');
    if (door.amount > 0 && door.state === GDO_DOOR_STATE.CLOSING) frozenSaw = door.amount;
  }
  assert.ok(frozenSaw > 0, 'the held leaf kept its amount instead of closing');
  // Step aside: the leaf is free to finish closing.
  const aside = { x: 3, y: 0, z: 0, radius: .09, height: .28 };
  for (let tick = 60; tick < 140; tick++) {
    board.update({ nowMilliseconds: clockAt(tick), dtMilliseconds: 16, player: aside });
  }
  assert.ok(board.counters.blockedBySensor > 0, 'the held close is counted');
  assert.ok(frozenSaw > 0, 'the held leaf kept its amount instead of closing');
  assert.equal(board.summary({}).closed, 1, 'stepping aside lets the leaf finish');
});

test('PHY-01 the interact verb toggles the nearest leaf and names its misses', () => {
  const board = boardWith([entry('near', { x: 0 }), entry('far', { x: 5 })]);
  const toggled = board.toggleNear(.1, 0, .1, { nowMilliseconds: 0 });
  assert.equal(toggled.id, 'near');
  assert.equal(toggled.target, 1);
  const closed = board.toggleNear(.1, 0, .1, { nowMilliseconds: 10 });
  assert.equal(closed.id, 'near');
  assert.equal(closed.target, 0);
  const miss = board.toggleNear(50, 0, 50, { nowMilliseconds: 20 });
  assert.equal(miss, null);
  assert.ok(board.refusals[GDO_DOOR_REFUSAL.NOTHING_NEAR] > 0, 'a miss refuses by name');
  // A vertical miss too: the trigger has a height band.
  const above = board.toggleNear(.1, 9, .1, { nowMilliseconds: 30 });
  assert.equal(above, null);
});

test('PHY-01 the query-driven read agrees with the leaf box', () => {
  const board = boardWith([entry('door', { width: .4, hinge: -1 })]);
  const blockers = board.queryObstacles(0, 0, .05);
  assert.equal(blockers.length, 1, 'a closed leaf blocks the doorway');
  board.toggleNear(0, 0, 0, { nowMilliseconds: 0 });
  for (let tick = 1; tick <= 80; tick++) {
    board.update({ nowMilliseconds: tick * 16, dtMilliseconds: 16, player: { x: 5, z: 5, radius: .09, height: .28 } });
  }
  assert.equal(board.queryObstacles(0, 0, .05).length, 0, 'an open doorway is clear');
});

test('PHY-01 authored entrances and host doors share one bounded board', () => {
  const entries = [entry('e0'), entry('e1', { x: 1 }), entry('bad', { width: 0 }), entry('e2', { x: 2 })];
  const board = boardWith(entries);
  assert.equal(board.summary({}).doors, 3, 'the malformed entrance refuses');
  assert.equal(board.refusals[GDO_DOOR_REFUSAL.MALFORMED], 1);
  assert.ok(board.addDoor('host-1', { x: 4, y: 0, z: 0, width: .3, height: .32 }));
  assert.equal(board.addDoor('host-1', { x: 9, z: 9, width: .3, height: .32 }).x, 4,
    'an existing id keeps its leaf');
  const overflow = boardWith(Array.from({ length: 40 }, (_, index) => entry(`e${index}`)));
  assert.equal(overflow.summary({}).doors, GDO_DOOR_PROFILES.low.maxDoors);
  assert.ok(overflow.refusals[GDO_DOOR_REFUSAL.TOO_MANY] > 0, 'the overflow is counted');
  assert.equal(GDO_DOOR_NAMESPACE, 'gdo:localDoors:v1');
  assert.equal(GDO_FEATURE_VERSIONS.localDoors, 1);
  assert.equal(GDO_DOOR_KIND.DOOR, 0);
});

test('PHY-01 every ceiling is declared against the low-profile budget', () => {
  const policy = GDO_DOOR_PROFILES.low;
  assert.equal(GDO_LOW_PROFILE_BUDGETS.doors, policy.maxDoors);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.doorsPerTile, 24);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.doorProxyUpdatesPerFrame, policy.maxUpdatesPerTick);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.doorSteadyFrameAllocations, 0);
  assert.ok(policy.passableAmount > .5 && policy.passableAmount < 1);
  assert.ok(policy.maxSwingRadians > 1 && policy.maxSwingRadians < Math.PI / 2 + .2);
  for (const name of ['low', 'balanced', 'high']) {
    const profile = GDO_DOOR_PROFILES[name];
    assert.ok(profile.maxDoors > 0 && profile.openSpeed > 0 && profile.closeSpeed > 0);
    assert.ok(profile.triggerRadius > 0 && profile.activeRadius > profile.triggerRadius);
    assert.ok(profile.maxUpdatesPerTick <= profile.maxDoors);
    assert.equal(GDO_LOW_PROFILE_BUDGETS.doorSteadyFrameAllocations, 0);
  }
});

test('PHY-01 the close sensor rule is pure and the board disposes cleanly', () => {
  const policy = GDO_DOOR_PROFILES.low;
  const door = entry('d');
  assert.equal(doorBlocksClosing(door, PLAYER, policy), true, 'in the doorway, closing is refused');
  assert.equal(doorBlocksClosing(door, { x: 3, z: 3, radius: .09, height: .28 }, policy), false);
  assert.equal(doorBlocksClosing(door, { x: 0, y: 9, z: 0, radius: .09, height: .28 }, policy), false,
    'a body above the lintel is not in the leaf');

  const ledger = new LifecycleLedger({ label: 'doors-test' });
  const board = createLocalDoors({ profile: 'low', ledger });
  board.rebuild([entry('a')]);
  board.toggleNear(0, 0, 0, { nowMilliseconds: 0 });
  for (let tick = 1; tick <= 10; tick++) {
    board.update({ nowMilliseconds: tick * 16, dtMilliseconds: 16, player: PLAYER });
  }
  assert.equal(board.diagnostics.steadyFrameAllocations, 0);
  board.dispose();
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.counts.pool, 0, 'the ledger releases the board');
  assert.equal(board.summary({}).doors, 0);
  assert.equal(board.update({ nowMilliseconds: 99, dtMilliseconds: 16, player: PLAYER }), 0);
});

test('PHY-01 profiles validate their inputs', () => {
  assert.throws(() => createLocalDoors({ profile: 'ultra' }), RangeError);
  assert.throws(() => createLocalDoors({
    profile: 'low', limits: { ...GDO_DOOR_PROFILES.low, openSpeed: 0 },
  }), RangeError);
});
