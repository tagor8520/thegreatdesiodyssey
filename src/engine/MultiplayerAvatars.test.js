import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { GeoWorld } from '../geo/GeoWorld.js';
import {
  GDO_AVATAR_BUDGET,
  GDO_AVATAR_LIMITS,
  GDO_AVATAR_NAMESPACE,
  GDO_AVATAR_REFUSAL,
  GDO_AVATAR_STATE,
  GDO_AVATAR_VALIDATION,
  createMultiplayerAvatars,
} from './MultiplayerAvatars.js';
import {
  GDO_INTEREST_JOIN_MAX_BYTES,
  GDO_INTEREST_PROFILES,
  createInterestSet,
} from './SpatialInterest.js';

/** A session pair: the interest set both sides share, and the avatars built on it. */
function session({ profile = 'low', heightAt = () => .1 } = {}) {
  const interest = createInterestSet({ profile, heightAt });
  const avatars = createMultiplayerAvatars({ profile, interest, heightAt });
  return { interest, avatars };
}

function player(id, x, z, extra = {}) {
  return { id, x, z, y: .1, yaw: 0, locomotion: 'idle', posture: 'standing', phase: 0, flags: 0, ...extra };
}

/** Encode one snapshot for the roster at `players`, at server tick `tick`. */
function frame(interest, players, tick) {
  interest.update(players[0]?.x ?? 0, players[0]?.z ?? 0, { players });
  return interest.encodeSnapshot({ x: players[0]?.x ?? 0, z: players[0]?.z ?? 0, tick, sequence: tick & 0xFF });
}

test('NET-04 implements the NET-02 interpolation and validation numbers', () => {
  assert.equal(GDO_AVATAR_NAMESPACE, 'gdo:avatars:v1');
  // §5.1.
  assert.equal(GDO_AVATAR_BUDGET.interpolationDelayMilliseconds, 100);
  assert.equal(GDO_AVATAR_BUDGET.maxExtrapolationMilliseconds, 120);
  assert.deepEqual(['low', 'balanced', 'high'].map(p => GDO_INTEREST_PROFILES[p].snapshotBufferDepth), [3, 3, 4]);
  // §3.3.
  assert.equal(GDO_AVATAR_VALIDATION.maxSpeedPerSecond, 4.5);
  assert.equal(GDO_AVATAR_VALIDATION.maxDisplacementPerTick, .6);
  assert.equal(GDO_AVATAR_VALIDATION.maxSupportDeltaMetres, .5);
  // §7 threat 2 and §8.2.
  assert.equal(GDO_AVATAR_LIMITS.inboundFramesPerSecond, 30);
  assert.equal(GDO_AVATAR_LIMITS.inboundBurstFrames, 5);
  assert.equal(GDO_AVATAR_LIMITS.fadeSeconds, 2);
  assert.equal(GDO_AVATAR_LIMITS.disconnectGraceSeconds, 2);

  const { avatars, interest } = session();
  assert.equal(avatars.depth, GDO_INTEREST_PROFILES.low.snapshotBufferDepth, 'the ring is the declared depth');
  assert.equal(avatars.maxAvatars, GDO_INTEREST_PROFILES.low.maxTrackedPlayers);
  assert.equal(avatars.interpolationDelayMilliseconds, undefined);
  const diagnostics = avatars.diagnostics;
  assert.equal(diagnostics.interpolationDelayMilliseconds, 100);
  assert.equal(diagnostics.maxExtrapolationMilliseconds, 120);
  assert.equal(diagnostics.networkGeometryBytes, 0);
  assert.equal(diagnostics.generatedGeometries, 0, 'the avatars create no geometry');
  assert.equal(diagnostics.steadyFrameAllocations, 0);
  assert.equal(interest.diagnostics.networkGeometryBytes, 0);
});

test('avatars render one interpolation delay behind the newest snapshot', () => {
  const { avatars, interest } = session();
  // Sprinting at 3.8 units/s, one tick apart: 0.19 units.
  avatars.ingest(frame(interest, [player('p:1', 0, 0, { locomotion: 'run' })], 1).view, 1_000);
  avatars.ingest(frame(interest, [player('p:1', .19, 0, { locomotion: 'run' })], 2).view, 1_050);

  // renderTime = now - 100, so at now = 1000 the avatar is exactly where it was.
  avatars.update(1_000);
  assert.ok(Math.abs(avatars.avatarFor('p:1').x) < .002);
  // Halfway between the two samples.
  avatars.update(1_125);
  assert.ok(Math.abs(avatars.avatarFor('p:1').x - .095) < .004);
  // At the newest sample.
  avatars.update(1_150);
  assert.ok(Math.abs(avatars.avatarFor('p:1').x - .19) < .004);
  const moved = avatars.avatarFor('p:1');
  assert.equal(moved.locomotion, 'run');
  assert.equal(moved.state, GDO_AVATAR_STATE.ACTIVE);

  // The delay is real: the newest sample is not shown immediately.
  avatars.update(1_055);
  assert.ok(avatars.avatarFor('p:1').x < .19, 'a fresh snapshot is not rendered at once');

  // Yaw takes the short way round rather than unwinding through 2π.
  const wrapped = session();
  wrapped.avatars.ingest(frame(wrapped.interest, [player('p:1', 0, 0, { yaw: 6.1 })], 1).view, 0);
  wrapped.avatars.ingest(frame(wrapped.interest, [player('p:1', 0, 0, { yaw: .1 })], 2).view, 50);
  wrapped.avatars.update(200);
  const yaw = wrapped.avatars.avatarFor('p:1').yaw;
  const shortArcDistance = Math.min(
    Math.abs(yaw - 6.1), Math.abs(yaw - .1), Math.abs(yaw - 6.1 - Math.PI * 2), Math.abs(yaw - .1 + Math.PI * 2),
  );
  assert.ok(shortArcDistance < .35, `the rotation takes the short arc (${yaw})`);
});

test('extrapolation is capped, so a stalled peer freezes instead of flying', () => {
  const { avatars, interest } = session();
  avatars.ingest(frame(interest, [player('p:1', 0, 0)], 1).view, 0);
  avatars.ingest(frame(interest, [player('p:1', .19, 0)], 2).view, 50);

  // Past the newest sample: it extrapolates along the last velocity, up to the cap.
  avatars.update(1_000);
  const extrapolated = avatars.avatarFor('p:1').x;
  assert.ok(extrapolated > .19);
  // The cap is 120 ms on a 50 ms sample spacing: at most 2.4 sample intervals.
  assert.ok(extrapolated <= .19 + .19 * (120 / 50) + .004, 'never beyond the declared cap');

  // Minutes later it has not moved a millimetre further.
  const frozen = avatars.update(60_000);
  assert.equal(frozen.ok, true);
  assert.ok(Math.abs(avatars.avatarFor('p:1').x - extrapolated) < 1e-9, 'a stalled peer freezes');

  // A single sample holds its own pose rather than extrapolating from nothing.
  const lonely = session();
  lonely.avatars.ingest(frame(lonely.interest, [player('p:1', 2, 3)], 1).view, 0);
  lonely.avatars.update(5_000);
  assert.ok(Math.abs(lonely.avatars.avatarFor('p:1').x - 2) < .004);
  assert.ok(Math.abs(lonely.avatars.avatarFor('p:1').z - 3) < .004);
});

test('teleports, overspeed samples and off-support claims are refused and counted', () => {
  const { avatars, interest } = session();
  avatars.ingest(frame(interest, [player('p:1', 0, 0)], 1).view, 0);
  // 1 unit in one tick is 20 units/s: a teleport, refused by §3.3.
  const teleport = avatars.ingest(frame(interest, [player('p:1', 1, 0)], 2).view, 50);
  assert.equal(teleport.refused, 1);
  assert.equal(teleport.players, 0);
  assert.ok(avatars.diagnostics.refusals[GDO_AVATAR_REFUSAL.EXCESS_SPEED] >= 1);
  avatars.update(200);
  assert.ok(avatars.avatarFor('p:1').x < .01, 'the avatar stays where it legitimately was');

  // 0.7 units in one tick is under the speed cap but over the displacement cap.
  const shoved = avatars.ingest(frame(interest, [player('p:1', .7, 0)], 3).view, 100);
  assert.equal(shoved.refused, 1, 'per-tick displacement is capped at 0.6');

  // Legal movement at sprint speed is accepted.
  const legal = avatars.ingest(frame(interest, [player('p:1', .19, 0)], 4).view, 150);
  assert.equal(legal.players, 1);
  assert.equal(avatars.diagnostics.rejectedSamples, 2);
});

test('floods, junk frames and budget overruns are dropped by name', () => {
  const { avatars, interest } = session();
  const good = frame(interest, [player('p:1', 0, 0)], 1).view;
  // §7 threat 2: burst of 5 then a token refill of 30/s.
  let accepted = 0, limited = 0;
  for (let index = 0; index < 12; index++) {
    const result = avatars.ingest(good, 0);
    if (result.ok) accepted++; else if (result.refusal === GDO_AVATAR_REFUSAL.RATE_LIMITED) limited++;
  }
  assert.equal(accepted, GDO_AVATAR_LIMITS.inboundBurstFrames);
  assert.equal(limited, 12 - GDO_AVATAR_LIMITS.inboundBurstFrames);
  assert.equal(avatars.diagnostics.rateLimitedFrames, limited);
  // Time passing refills the bucket.
  assert.equal(avatars.ingest(good, 1_000).ok, true);

  // §7 threat 6: a malformed frame never reaches the render path and never throws.
  const junk = avatars.ingest(new Uint8Array(5), 2_000);
  assert.equal(junk.ok, false);
  assert.equal(junk.refusal, GDO_AVATAR_REFUSAL.MALFORMED_SNAPSHOT);
  assert.equal(avatars.ingest(null, 2_100).refusal, GDO_AVATAR_REFUSAL.BAD_INPUT);
  assert.ok(avatars.diagnostics.malformedFrames >= 1);

  // §7 threat 5: sustained traffic beyond the profile's byte budget disconnects.
  const flood = session();
  let disconnected = false;
  for (let second = 0; second < 4 && !disconnected; second++) {
    for (let index = 0; index < 6; index++) {
      // 900 bytes a frame at 30 frames/s is far past 4 KiB/s.
      const result = flood.avatars.ingest(new Uint8Array(900), second * 1_000 + index * 40);
      if (result.refusal === GDO_AVATAR_REFUSAL.DISCONNECTED) disconnected = true;
    }
  }
  assert.equal(disconnected, true, 'a sustained flood is disconnected, not tolerated');
  assert.ok(flood.avatars.diagnostics.overBudgetWindows >= 3);
  assert.equal(flood.avatars.ingest(new Uint8Array(0), 9_000).refusal, GDO_AVATAR_REFUSAL.DISCONNECTED);
});

test('a disconnect fades out over two seconds and releases its slot', () => {
  const { avatars, interest } = session();
  avatars.ingest(frame(interest, [player('p:1', 0, 0), player('p:2', 1, 0)], 1).view, 0);
  avatars.update(100);
  assert.equal(avatars.diagnostics.active, 2);

  // §8.2: the peer leaving starts a fade, and the world is not rolled back.
  assert.equal(avatars.disconnect('p:2', 1_000).ok, true);
  assert.equal(avatars.diagnostics.fading, 1);
  avatars.update(1_500);
  const fading = avatars.avatarFor('p:2', 1_500);
  assert.ok(fading.alpha > 0 && fading.alpha < 1, 'it fades rather than vanishing');
  assert.equal(fading.state, GDO_AVATAR_STATE.FADING);
  // Still drawn, still in the pool.
  assert.equal(avatars.visible(1_500).length, 2);

  // After the two-second fade it is gone and its slot is free.
  avatars.update(3_000);
  assert.equal(avatars.avatarFor('p:2'), null);
  assert.equal(avatars.diagnostics.removals, 1);
  assert.equal(avatars.diagnostics.avatars, 1);
  // A reconnect reuses the freed slot, and says so.
  const reconnected = avatars.reconnect('p:2');
  assert.equal(reconnected.ok, true);
  assert.equal(reconnected.slot, 1, 'the slot is reusable');

  // Disconnecting someone who was never here is refused, not ignored.
  assert.equal(avatars.disconnect('p:ghost', 4_000).refusal, GDO_AVATAR_REFUSAL.UNKNOWN_AVATAR);
  // Reconnecting an already-fading avatar counts a slot reuse.
  avatars.disconnect('p:1', 5_000);
  assert.equal(avatars.reconnect('p:1').reused, true);
  assert.ok(avatars.diagnostics.slotReuses >= 1);
  assert.equal(avatars.diagnostics.steadyFrameAllocations, 0);
  assert.equal(avatars.diagnostics.generatedGeometries, 0);
});

test('the world mounts avatars on its session and still ships no geometry', () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  try {
    const world = new GeoWorld(new THREE.Scene(), { latitude: 28.99, longitude: 77.71 });
    // §8.1: no session, no avatars, no cost.
    assert.equal(world.session, null);
    assert.equal(world.ingestSessionSnapshot(new Uint8Array(12)).refusal, 'not-a-session');
    assert.equal(world.updateSessionAvatars(0).refusal, 'not-a-session');
    assert.equal(world.disconnectSessionAvatar('p:1').refusal, 'not-a-session');

    const opened = world.openSession({ sessionId: 's1' });
    assert.equal(opened.ok, true);
    assert.ok(opened.join.bytes <= GDO_INTEREST_JOIN_MAX_BYTES);
    assert.equal(opened.join.geometryBytes, 0, '§5.4: the join carries no geometry');
    assert.equal(world.session.avatars.namespace, GDO_AVATAR_NAMESPACE);

    const view = frame(world.session.interest, [player('p:1', 0, 0, { locomotion: 'walk' })], 1).view;
    assert.equal(world.ingestSessionSnapshot(view, 1_000).players, 1);
    const advanced = world.updateSessionAvatars(1_100);
    assert.equal(advanced.active, 1);
    assert.equal(world.sessionAvatars.namespace, GDO_AVATAR_NAMESPACE);
    assert.equal(world.sessionAvatars.networkGeometryBytes, 0, 'nothing was transferred to draw it');

    assert.equal(world.disconnectSessionAvatar('p:1', 2_000).ok, true);
    assert.equal(world.session.avatars.diagnostics.fading, 1);
    world.updateSessionAvatars(4_100);
    assert.equal(world.session.avatars.diagnostics.removals, 1);

    // Closing the session returns the world to its single-player state.
    world.closeSession();
    assert.equal(world.session, null);
    assert.equal(world.ingestSessionSnapshot(view, 5_000).refusal, 'not-a-session');

    // The quarantined prototype is gone, not merely deprecated (§2.1).
    assert.equal(existsSync(new URL('../network/MultiplayerClient.js', import.meta.url)), false);

    world.dispose();
    assert.equal(world.openSession().refusal, 'disposed');
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('avatars refuse a missing interest set instead of inventing one', () => {
  assert.throws(() => createMultiplayerAvatars({}), TypeError);
  const { avatars, interest } = session();
  // The interest set is the only source of roster and validity.
  assert.equal(avatars.interest, interest);
  avatars.dispose();
  assert.equal(avatars.ingest(frame(interest, [player('p:1', 0, 0)], 1).view, 0).refusal,
    GDO_AVATAR_REFUSAL.DISPOSED);
  avatars.dispose();
  assert.equal(avatars.diagnostics.disposed, true);
});
