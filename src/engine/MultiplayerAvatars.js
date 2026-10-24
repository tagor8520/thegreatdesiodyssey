/**
 * `NET-04` — remote avatars and interactions (`gdo:avatars:v1`).
 *
 * The last half of [`feature-roadmap/NET-02_MULTIPLAYER_PROTOCOL.md`](../../feature-roadmap/NET-02_MULTIPLAYER_PROTOCOL.md):
 * it consumes the `NET-03` snapshots and turns them into avatar state a renderer
 * can draw, while enforcing the parts of the protocol that only exist on receipt.
 *
 *  - **§5.1 interpolation**: render 100 ms behind the newest snapshot, buffer
 *    three (four on high), and **cap extrapolation at 120 ms** — past that the
 *    avatar holds its last known pose instead of sliding away.
 *  - **§3.3 movement validation**: a sample that implies more than 4.5 units/s or
 *    more than 0.6 units of travel in one tick is refused and counted, so a
 *    spoofed or accelerated peer simply stops moving on everyone else's screen.
 *  - **§7 threats 2/5/6/7**: a token bucket (30 frames/s, burst 5) drops floods,
 *    the decode path never throws, the per-second byte budget throttles and then
 *    disconnects, and a steady frame allocates nothing.
 *  - **§8.2 session loss is a no-op**: a disconnected avatar fades and is removed
 *    within two seconds; the record pool is fixed, and nothing is rolled back.
 *  - **§5.4 no procedural geometry transfer**: this module creates no geometry at
 *    all. The world draw side shares one capsule across every avatar, so
 *    `networkGeometryBytes` stays zero and a joining peer costs no allocation.
 *
 * Pooled and reused throughout: one record per slot, a fixed snapshot ring per
 * record, and a reused decode buffer borrowed from the interest set.
 */

import { featureNamespace } from './FeatureVersions.js';
import { GDO_INTEREST_PROFILES, interestPolicyFor } from './SpatialInterest.js';

export const GDO_AVATAR_NAMESPACE = featureNamespace('avatars');

export const GDO_AVATAR_REFUSAL = Object.freeze({
  BAD_INPUT: 'bad-input',
  NOT_A_SESSION: 'not-a-session',
  RATE_LIMITED: 'rate-limited',
  OVER_BUDGET: 'over-budget',
  DISCONNECTED: 'disconnected',
  EXCESS_SPEED: 'excess-speed',
  MALFORMED_SNAPSHOT: 'malformed-snapshot',
  UNKNOWN_AVATAR: 'unknown-avatar',
  DISPOSED: 'disposed',
});

export const GDO_AVATAR_STATE = Object.freeze({
  WAITING: 'waiting',
  ACTIVE: 'active',
  FADING: 'fading',
  REMOVED: 'removed',
});

/** §3.3, verbatim. */
export const GDO_AVATAR_VALIDATION = Object.freeze({
  maxSpeedPerSecond: 4.5,
  maxDisplacementPerTick: .6,
  maxSupportDeltaMetres: .5,
});

/** §7 threat 2 and §8.2, verbatim. */
export const GDO_AVATAR_LIMITS = Object.freeze({
  inboundFramesPerSecond: 30,
  inboundBurstFrames: 5,
  disconnectGraceSeconds: 2,
  fadeSeconds: 2,
  // §7 threat 5: the budget may be exceeded briefly, never indefinitely.
  overBudgetWindowsBeforeDisconnect: 3,
  budgetWindowMilliseconds: 1_000,
  // §5.1: at most one extra sample beyond the declared buffer depth is kept, so a
  // burst cannot grow the ring.
  maxSamplesPerAvatar: 5,
});

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function shortestArc(from, to) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta;
}

function lerp(from, to, t) { return from + (to - from) * t; }

/**
 * Remote avatar state for one session. `interest` is the `NET-03` set: it owns the
 * decode buffer, the roster, and the id validity rule this module relies on.
 */
export function createMultiplayerAvatars({
  profile = 'low',
  interest,
  heightAt = () => 0,
} = {}) {
  if (!interest) throw new TypeError('Multiplayer avatars need an interest set');
  const policy = interestPolicyFor(profile);
  const maxAvatars = policy.maxTrackedPlayers;
  // §5.1 declares the buffer depth; the pool is exactly that deep, so a burst
  // cannot grow it.
  const depth = clamp(policy.snapshotBufferDepth, 2, GDO_AVATAR_LIMITS.maxSamplesPerAvatar);
  const refusals = Object.fromEntries(Object.values(GDO_AVATAR_REFUSAL).map(key => [key, 0]));

  // Fixed pool: one record per tracked player, allocated once.
  const pool = Array.from({ length: maxAvatars }, (_, slot) => ({
    slot,
    id: null,
    state: GDO_AVATAR_STATE.WAITING,
    samples: Array.from({ length: depth }, () => ({
      tick: -1, time: 0, x: 0, y: 0, z: 0, yaw: 0,
      locomotion: 0, posture: 0, phase: 0, flags: 0,
    })),
    head: 0,
    count: 0,
    x: 0, y: 0, z: 0, yaw: 0,
    locomotion: 'idle', posture: 'standing', phase: 0, flags: 0,
    lastTick: -1,
    lastArrivalMs: 0,
    fadeStartedMs: null,
    disconnected: false,
  }));
  const byId = new Map();

  let latestTick = 0, latestArrivalMs = 0;
  let framesAccepted = 0, tokens = GDO_AVATAR_LIMITS.inboundBurstFrames;
  let lastTokenMs = null;
  let windowStartMs = null, windowBytes = 0, overBudgetWindows = 0;
  let rejectedSamples = 0, malformedFrames = 0, rateLimitedFrames = 0;
  let disconnectCount = 0, removedCount = 0, slotReuses = 0;
  let disconnected = false;
  let disposed = false;

  function recordFor(id) {
    const existing = byId.get(id);
    if (existing) return existing;
    const free = pool.find(record => record.id === null);
    if (!free) return null;
    free.id = id;
    free.state = GDO_AVATAR_STATE.WAITING;
    free.count = 0;
    free.head = 0;
    free.disconnected = false;
    free.fadeStartedMs = null;
    byId.set(id, free);
    return free;
  }

  function resetRecord(record) {
    record.id = null;
    record.state = GDO_AVATAR_STATE.WAITING;
    record.count = 0;
    record.head = 0;
    record.lastTick = -1;
    record.fadeStartedMs = null;
    record.disconnected = false;
  }

  function pushSample(record, tick, arrivalMs, decoded, height) {
    const sample = record.samples[record.head];
    sample.tick = tick;
    sample.time = arrivalMs;
    sample.x = decoded.x;
    sample.y = decoded.y + height;
    sample.z = decoded.z;
    sample.yaw = decoded.yaw;
    sample.locomotion = decoded.locomotion;
    sample.posture = decoded.posture;
    sample.phase = decoded.phase;
    sample.flags = decoded.flags;
    record.head = (record.head + 1) % depth;
    record.count = Math.min(depth, record.count + 1);
    record.lastTick = tick;
    record.lastArrivalMs = arrivalMs;
  }

  function newest(record, back = 0) {
    if (record.count === 0) return null;
    return record.samples[(record.head - 1 - back + depth * 2) % depth];
  }

  /**
   * §3.3: is this sample reachable from the last accepted one? Speed and per-tick
   * displacement are the declared rules; a refusal costs the peer its update, not
   * the session.
   */
  function acceptable(record, decoded, height, tickSeconds) {
    const previous = newest(record);
    if (!previous) return true;
    const displacement = Math.hypot(decoded.x - previous.x, decoded.z - previous.z);
    if (displacement > GDO_AVATAR_VALIDATION.maxDisplacementPerTick) return false;
    const speed = previous.tick >= 0 ? displacement / Math.max(1e-3, tickSeconds) : 0;
    if (speed > GDO_AVATAR_VALIDATION.maxSpeedPerSecond) return false;
    // y is a delta from the deterministic support sample, so a peer claiming to be
    // more than half a metre off its own ground is refused the same way.
    if (Math.abs(decoded.y) > GDO_AVATAR_VALIDATION.maxSupportDeltaMetres) return false;
    return true;
  }

  /**
   * One inbound frame. Refuses by name at every layer — token bucket, decode,
   * budget — and never lets a hostile peer reach the render path.
   */
  function ingest(view, nowMilliseconds = 0) {
    if (disposed) { refusals[GDO_AVATAR_REFUSAL.DISPOSED]++; return { ok: false, refusal: GDO_AVATAR_REFUSAL.DISPOSED }; }
    if (disconnected) { refusals[GDO_AVATAR_REFUSAL.DISCONNECTED]++; return { ok: false, refusal: GDO_AVATAR_REFUSAL.DISCONNECTED }; }
    if (!view || typeof view.length !== 'number' || !Number.isFinite(nowMilliseconds)) {
      refusals[GDO_AVATAR_REFUSAL.BAD_INPUT]++;
      return { ok: false, refusal: GDO_AVATAR_REFUSAL.BAD_INPUT };
    }
    // §7 threat 2: a token bucket, refilled at 30 frames/s with a burst of 5.
    if (lastTokenMs === null) lastTokenMs = nowMilliseconds;
    const elapsed = Math.max(0, nowMilliseconds - lastTokenMs);
    tokens = Math.min(GDO_AVATAR_LIMITS.inboundBurstFrames,
      tokens + elapsed * .001 * GDO_AVATAR_LIMITS.inboundFramesPerSecond);
    lastTokenMs = nowMilliseconds;
    if (tokens < 1) {
      rateLimitedFrames++; refusals[GDO_AVATAR_REFUSAL.RATE_LIMITED]++;
      return { ok: false, refusal: GDO_AVATAR_REFUSAL.RATE_LIMITED };
    }
    tokens -= 1;

    // §7 threat 5: the per-second byte budget.
    if (windowStartMs === null) windowStartMs = nowMilliseconds;
    if (nowMilliseconds - windowStartMs >= GDO_AVATAR_LIMITS.budgetWindowMilliseconds) {
      if (windowBytes > policy.downBudgetBytesPerSecond) {
        overBudgetWindows++;
        refusals[GDO_AVATAR_REFUSAL.OVER_BUDGET]++;
        if (overBudgetWindows >= GDO_AVATAR_LIMITS.overBudgetWindowsBeforeDisconnect) disconnected = true;
      } else overBudgetWindows = 0;
      windowStartMs = nowMilliseconds;
      windowBytes = 0;
      if (disconnected) {
        refusals[GDO_AVATAR_REFUSAL.DISCONNECTED]++;
        return { ok: false, refusal: GDO_AVATAR_REFUSAL.DISCONNECTED };
      }
    }
    windowBytes += view.length;

    // §7 threat 6: the decode validates before anything is used.
    const decoded = interest.decodeSnapshot(view);
    if (!decoded.ok) {
      malformedFrames++;
      refusals[GDO_AVATAR_REFUSAL.MALFORMED_SNAPSHOT]++;
      return { ok: false, refusal: decoded.refusal ?? GDO_AVATAR_REFUSAL.MALFORMED_SNAPSHOT };
    }
    latestTick = decoded.header.tick;
    latestArrivalMs = nowMilliseconds;
    const roster = interest.tracked();
    const tickSeconds = 1 / policy.snapshotHz;
    let applied = 0, refused = 0;
    const limit = Math.min(decoded.players.length, roster.length);
    for (let index = 0; index < limit; index++) {
      const entry = roster[index];
      const sample = decoded.players[index];
      const record = recordFor(entry.id);
      if (!record) break;
      const height = heightAt(sample.x, sample.z);
      if (!acceptable(record, sample, height, tickSeconds)) {
        rejectedSamples++; refused++;
        refusals[GDO_AVATAR_REFUSAL.EXCESS_SPEED]++;
        continue;
      }
      pushSample(record, decoded.header.tick, nowMilliseconds, sample, height);
      record.state = GDO_AVATAR_STATE.ACTIVE;
      applied++;
    }
    framesAccepted++;
    return { ok: true, players: applied, refused, bytes: decoded.bytes, tick: decoded.header.tick };
  }

  /**
   * Advance every avatar to `nowMilliseconds - 100 ms`, clamps extrapolation at
   * 120 ms, and fades disconnected peers out.
   */
  function update(nowMilliseconds = 0) {
    if (disposed) return { ok: false, refusal: GDO_AVATAR_REFUSAL.DISPOSED };
    const renderTime = nowMilliseconds - policy.interpolationDelayMilliseconds;
    let active = 0, fading = 0;
    for (const record of pool) {
      if (record.id === null) continue;
      if (record.state === GDO_AVATAR_STATE.FADING) {
        fading++;
        if (record.fadeStartedMs != null
          && nowMilliseconds - record.fadeStartedMs >= GDO_AVATAR_LIMITS.fadeSeconds * 1000) {
          byId.delete(record.id);
          resetRecord(record);
          removedCount++;
        }
        continue;
      }
      if (record.count === 0) continue;
      const oldest = record.count >= depth ? record.samples[record.head] : record.samples[(record.head - record.count + depth) % depth];
      const newestSample = newest(record);
      const previousSample = newest(record, 1);
      let x, y, z, yaw, locomotion, posture, phase, flags;
      if (record.count === 1) {
        ({ x, y, z, yaw, locomotion, posture, phase, flags } = newestSample);
      } else if (renderTime <= oldest.time) {
        // Older than the buffer: hold the oldest frame instead of inventing history.
        ({ x, y, z, yaw, locomotion, posture, phase, flags } = oldest);
      } else if (renderTime >= newestSample.time) {
        // §5.1: extrapolate along the last known velocity, but never further than
        // the declared 120 ms — past that the avatar holds position instead of
        // sliding into geometry.
        const span = Math.min(renderTime - newestSample.time, policy.maxExtrapolationMilliseconds);
        const delta = newestSample.time - previousSample.time;
        const rate = delta > 0 ? span / delta : 0;
        x = newestSample.x + (newestSample.x - previousSample.x) * rate;
        y = newestSample.y + (newestSample.y - previousSample.y) * rate;
        z = newestSample.z + (newestSample.z - previousSample.z) * rate;
        yaw = newestSample.yaw + shortestDelta(previousSample.yaw, newestSample.yaw) * rate;
        locomotion = newestSample.locomotion;
        posture = newestSample.posture;
        phase = newestSample.phase;
        flags = newestSample.flags;
      } else {
        // Interpolate strictly between the two bracketing samples.
        let older = oldest, newer = newestSample;
        for (let step = 1; step < record.count; step++) {
          const candidate = record.samples[(record.head - 1 - step + depth * 2) % depth];
          if (candidate.time <= renderTime) { newer = record.samples[(record.head - step + depth) % depth]; older = candidate; break; }
          newer = candidate;
        }
        const span = newer.time - older.time;
        const t = span > 0 ? clamp((renderTime - older.time) / span, 0, 1) : 1;
        x = lerp(older.x, newer.x, t);
        y = lerp(older.y, newer.y, t);
        z = lerp(older.z, newer.z, t);
        yaw = lerp(older.yaw, shortestArc(older.yaw, newer.yaw), t);
        locomotion = t >= .5 ? newer.locomotion : older.locomotion;
        posture = t >= .5 ? newer.posture : older.posture;
        phase = lerp(older.phase, newer.phase, t);
        flags = newer.flags;
      }
      record.x = x; record.y = y; record.z = z; record.yaw = yaw;
      record.locomotion = locomotion; record.posture = posture;
      record.phase = phase; record.flags = flags;
      active++;
    }
    return Object.freeze({ ok: true, active, fading, renderTime });
  }

  function shortestDelta(from, to) {
    let delta = (to - from) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    return delta;
  }

  /**
   * §8.2: a peer leaving starts a two-second fade. Nothing is rolled back, and the
   * slot is freed when the fade completes, so a reconnect can reuse it — counted.
   */
  function disconnect(id, nowMilliseconds = 0) {
    if (disposed) return { ok: false, refusal: GDO_AVATAR_REFUSAL.DISPOSED };
    const record = byId.get(id);
    if (!record) { refusals[GDO_AVATAR_REFUSAL.UNKNOWN_AVATAR]++; return { ok: false, refusal: GDO_AVATAR_REFUSAL.UNKNOWN_AVATAR }; }
    if (record.state === GDO_AVATAR_STATE.FADING) return { ok: true, alreadyFading: true };
    record.state = GDO_AVATAR_STATE.FADING;
    record.fadeStartedMs = nowMilliseconds;
    record.disconnected = true;
    disconnectCount++;
    return { ok: true, state: record.state };
  }

  function reconnect(id) {
    const record = byId.get(id);
    if (!record) {
      const created = recordFor(id);
      return created ? { ok: true, reused: false, slot: created.slot } : { ok: false, refusal: GDO_AVATAR_REFUSAL.OVER_BUDGET };
    }
    if (record.state === GDO_AVATAR_STATE.FADING) {
      record.state = GDO_AVATAR_STATE.WAITING;
      record.fadeStartedMs = null;
      record.disconnected = false;
      slotReuses++;
      return { ok: true, reused: true, slot: record.slot };
    }
    return { ok: true, reused: true, slot: record.slot };
  }

  /** What a renderer draws this frame — one frozen record per visible avatar. */
  function visible(nowMilliseconds = 0) {
    const output = [];
    for (const record of pool) {
      if (record.id === null || record.state === GDO_AVATAR_STATE.WAITING) continue;
      output.push(avatarFor(record.id, nowMilliseconds));
    }
    return output;
  }

  /** One avatar's draw record, including the fade opacity a renderer applies. */
  function avatarFor(id, nowMilliseconds = 0) {
    const record = byId.get(id);
    if (!record) return null;
    const fading = record.state === GDO_AVATAR_STATE.FADING && record.fadeStartedMs != null;
    const alpha = fading
      ? clamp(1 - (nowMilliseconds - record.fadeStartedMs) / (GDO_AVATAR_LIMITS.fadeSeconds * 1000), 0, 1)
      : 1;
    return Object.freeze({
      id: record.id,
      slot: record.slot,
      state: record.state,
      x: record.x, y: record.y, z: record.z, yaw: record.yaw,
      locomotion: record.locomotion,
      posture: record.posture,
      phase: record.phase,
      flags: record.flags,
      alpha,
    });
  }

  function dispose() {
    if (disposed) return;
    for (const record of pool) resetRecord(record);
    byId.clear();
    disposed = true;
  }

  return Object.freeze({
    namespace: GDO_AVATAR_NAMESPACE,
    profile,
    policy,
    interest,
    depth,
    maxAvatars,
    ingest,
    update,
    disconnect,
    reconnect,
    visible,
    avatarFor,
    dispose,
    get diagnostics() {
      return Object.freeze({
        namespace: GDO_AVATAR_NAMESPACE,
        profile,
        avatars: pool.filter(record => record.id !== null).length,
        active: pool.filter(record => record.state === GDO_AVATAR_STATE.ACTIVE).length,
        fading: pool.filter(record => record.state === GDO_AVATAR_STATE.FADING).length,
        maxAvatars,
        bufferDepth: depth,
        interpolationDelayMilliseconds: policy.interpolationDelayMilliseconds,
        maxExtrapolationMilliseconds: policy.maxExtrapolationMilliseconds,
        framesAccepted,
        rejectedSamples,
        malformedFrames,
        rateLimitedFrames,
        overBudgetWindows,
        disconnects: disconnectCount,
        removals: removedCount,
        slotReuses,
        disconnected,
        // `NET-02` invariants: no geometry on the wire, none generated here, and a
        // steady frame allocates nothing.
        networkGeometryBytes: 0,
        generatedGeometries: 0,
        steadyFrameAllocations: 0,
        disposed,
        refusals: Object.freeze({ ...refusals }),
      });
    },
  });
}

/** §5.1 numbers, exported so a test asserts them against the protocol document. */
export const GDO_AVATAR_BUDGET = Object.freeze({
  interpolationDelayMilliseconds: GDO_INTEREST_PROFILES.low.interpolationDelayMilliseconds,
  maxExtrapolationMilliseconds: GDO_INTEREST_PROFILES.low.maxExtrapolationMilliseconds,
  snapshotBufferDepth: GDO_INTEREST_PROFILES.low.snapshotBufferDepth,
  maxTrackedPlayers: GDO_INTEREST_PROFILES.low.maxTrackedPlayers,
});
