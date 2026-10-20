/**
 * `PHY-03` — pose-fall knockdown (`gdo:poseFall:v1`).
 *
 * Research §7 Option A, followed literally: **no rigid-body engine**. A body is
 * a small set of independently posed segments driven by a short deterministic
 * animation —
 *
 *   - an initial directional lean derived from the impact impulse;
 *   - a pelvis following a ballistic arc;
 *   - damped limb rotations with a seeded phase;
 *   - per-segment ground clamping from the one height function;
 *   - a final pose selected from a few stable lying variants;
 *   - a blend (or removal) after settling.
 *
 * The row's gate is the *baseline*: a state machine that a rigid-body island can
 * later replace, with a fixed step, a bounded actor pool, zero steady-frame
 * allocations, and a deterministic result for the same seed and script.
 */

import { featureNamespace } from '../engine/FeatureVersions.js';

export const GDO_POSEFALL_NAMESPACE = featureNamespace('poseFall');

export const GDO_POSEFALL_STATE = Object.freeze({
  STANDING: 'standing',
  FALLING: 'falling',
  SETTLING: 'settling',
  DOWN: 'down',
  RISING: 'rising',
});

export const GDO_POSEFALL_REFUSAL = Object.freeze({
  UNKNOWN_ACTOR: 'unknown-actor',
  POOL_FULL: 'pool-full',
  ALREADY_FALLING: 'already-falling',
  NO_IMPULSE: 'no-impulse',
});

/** Stable lying variants: a face-down, a left side, a right side, and a back. */
export const GDO_POSEFALL_VARIANTS = Object.freeze([
  Object.freeze({ id: 'face-down', yawOffset: 0, lean: 1.42, armSwing: .9, legSplay: .34 }),
  Object.freeze({ id: 'left-side', yawOffset: Math.PI / 2, lean: 1.38, armSwing: .55, legSplay: .52 }),
  Object.freeze({ id: 'right-side', yawOffset: -Math.PI / 2, lean: 1.38, armSwing: .48, legSplay: .58 }),
  Object.freeze({ id: 'back', yawOffset: Math.PI, lean: 1.46, armSwing: .72, legSplay: .28 }),
]);

/** World-unit rig (the project's avatar is ~0.28 units, metres × 0.1). */
export const GDO_POSEFALL_RIG = Object.freeze({
  pelvis: Object.freeze({ y: .14, clearance: .05 }),
  chest: Object.freeze({ y: .21, clearance: .045 }),
  head: Object.freeze({ y: .28, clearance: .04 }),
  armLeft: Object.freeze({ y: .21, clearance: .03 }),
  armRight: Object.freeze({ y: .21, clearance: .03 }),
  legLeft: Object.freeze({ y: .07, clearance: .03 }),
  legRight: Object.freeze({ y: .07, clearance: .03 }),
});

export const GDO_POSEFALL_PROFILES = Object.freeze({
  low: Object.freeze({
    maxActors: 8,
    fixedStepSeconds: 1 / 60,
    maxSubstepsPerFrame: 4,
    fallSeconds: .62,
    settleSeconds: .34,
    downSeconds: 2.4,
    riseSeconds: .5,
    severitySeconds: .22,
    maxLeanRadians: 1.46,
    maxImpulse: 6,
    maximumFallSeconds: 1.05,
    segments: 7,
    poseWritesPerFrame: 8,
  }),
  balanced: Object.freeze({ maxActors: 12, fixedStepSeconds: 1 / 60, maxSubstepsPerFrame: 5, fallSeconds: .6, settleSeconds: .32, downSeconds: 2.6, riseSeconds: .5, severitySeconds: .22, maxLeanRadians: 1.46, maxImpulse: 6.5, maximumFallSeconds: 1.05, segments: 7, poseWritesPerFrame: 12 }),
  high: Object.freeze({ maxActors: 16, fixedStepSeconds: 1 / 60, maxSubstepsPerFrame: 6, fallSeconds: .58, settleSeconds: .32, downSeconds: 2.8, riseSeconds: .55, severitySeconds: .22, maxLeanRadians: 1.46, maxImpulse: 7, maximumFallSeconds: 1.05, segments: 7, poseWritesPerFrame: 16 }),
});

const SEGMENT_ORDER = Object.freeze(['pelvis', 'chest', 'head', 'armLeft', 'armRight', 'legLeft', 'legRight']);
const HORIZONTAL_OFFSET = Object.freeze({
  pelvis: 0, chest: 0, head: 0,
  armLeft: -.055, armRight: .055,
  legLeft: -.035, legRight: .035,
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function easeInQuad(value) { return value * value; }
function easeOutCubic(value) { return 1 - (1 - value) ** 3; }
function easeInOut(value) { return value < .5 ? 2 * value * value : 1 - (-2 * value + 2) ** 2 / 2; }

function mix32(value) {
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function stableUnit(seed, actorId, channel) {
  let hash = mix32(seed ^ 0x9e3779b9);
  hash = mix32(hash ^ Math.imul(actorId, 0x85ebca6b));
  for (let index = 0; index < channel.length; index++) hash = mix32(hash ^ channel.charCodeAt(index));
  return hash / 4294967296;
}

/**
 * Build one board. `heightAt(x, z)` is the single terrain function (defaults to
 * flat), `despawn` chooses removal over rising after the down hold, and every
 * actor record is allocated once on spawn and mutated in place.
 */
export function createPoseFallBoard({
  profile = 'low',
  seed = 0,
  heightAt = null,
  despawn = true,
  limits = {},
} = {}) {
  const policy = { ...(GDO_POSEFALL_PROFILES[profile] ?? GDO_POSEFALL_PROFILES.low), ...(limits ?? {}) };
  const actors = new Map();
  const refusals = { [GDO_POSEFALL_REFUSAL.UNKNOWN_ACTOR]: 0, [GDO_POSEFALL_REFUSAL.POOL_FULL]: 0,
    [GDO_POSEFALL_REFUSAL.ALREADY_FALLING]: 0, [GDO_POSEFALL_REFUSAL.NO_IMPULSE]: 0 };
  let nextId = 1;
  let accumulator = 0;
  let lastSteps = 0, lastPoseWrites = 0;
  let totalSteps = 0, totalPoseWrites = 0;
  let knockdowns = 0, recoveries = 0, removals = 0, settles = 0;
  let malformedInputs = 0;

  const groundAt = (x, z) => {
    const value = typeof heightAt === 'function' ? Number(heightAt(x, z)) : 0;
    return Number.isFinite(value) ? value : 0;
  };

  function spawn({ x = 0, z = 0, yaw = 0, actorId = null } = {}) {
    if (actors.size >= policy.maxActors) { refusals[GDO_POSEFALL_REFUSAL.POOL_FULL]++; return { ok: false, refusal: GDO_POSEFALL_REFUSAL.POOL_FULL }; }
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) {
      return { ok: false, refusal: GDO_POSEFALL_REFUSAL.UNKNOWN_ACTOR };
    }
    const id = actorId ?? `actor:${nextId++}`;
    if (actors.has(id)) { refusals[GDO_POSEFALL_REFUSAL.POOL_FULL]++; return { ok: false, refusal: GDO_POSEFALL_REFUSAL.POOL_FULL }; }
    const variant = GDO_POSEFALL_VARIANTS[Math.floor(stableUnit(seed, actors.size + 1, `variant:${id}`) * GDO_POSEFALL_VARIANTS.length)];
    const actor = {
      id,
      state: GDO_POSEFALL_STATE.STANDING,
      x, z, yaw,
      groundY: groundAt(x, z),
      elapsed: 0,
      duration: 0,
      lean: 0,
      leanDirection: { x: 0, z: 1 },
      severity: 0,
      variant,
      variantLean: 0,
      // One pose record per actor, mutated in place: a steady frame allocates
      // nothing and a renderer can hold the reference.
      pose: {
        actorId: id,
        state: GDO_POSEFALL_STATE.STANDING,
        progress: 0,
        segments: SEGMENT_ORDER.map(role => ({ role, x, y: 0, z, pitch: 0, roll: 0 })),
      },
    };
    actors.set(id, actor);
    writeStandingPose(actor);
    return { ok: true, id, actor };
  }

  function segmentTargets(actor) {
    const rig = GDO_POSEFALL_RIG;
    const lean = actor.lean;
    const cosine = Math.cos(actor.yaw), sine = Math.sin(actor.yaw);
    const lateral = (offset, swing) => {
      const x = offset * cosine - swing * sine;
      const z = offset * sine + swing * cosine;
      return { x, z };
    };
    const impulse = actor.leanDirection;
    const droop = Math.sin(lean); // how far the body has gone over
    const forEachLimb = (role, swing) => {
      const axis = HORIZONTAL_OFFSET[role] ?? 0;
      const local = lateral(axis, swing);
      return { x: local.x, z: local.z };
    };
    return { rig, lean, droop, forEachLimb, impulse };
  }

  function writeStandingPose(actor) {
    const pose = actor.pose;
    pose.state = GDO_POSEFALL_STATE.STANDING;
    pose.progress = 0;
    for (const segment of pose.segments) {
      segment.x = actor.x + (HORIZONTAL_OFFSET[segment.role] ?? 0) * Math.cos(actor.yaw);
      segment.z = actor.z + (HORIZONTAL_OFFSET[segment.role] ?? 0) * Math.sin(actor.yaw);
      segment.y = actor.groundY + GDO_POSEFALL_RIG[segment.role].y;
      segment.pitch = 0;
      segment.roll = 0;
    }
  }

  /**
   * Write the current animation pose for one actor. Height is derived purely
   * from the timeline, then every segment is clamped to the ground it is over —
   * the "approximate ground clamp" the research asks for.
   */
  function writePose(actor, progress) {
    const pose = actor.pose;
    const rig = GDO_POSEFALL_RIG;
    const lean = actor.lean;
    const horizontal = Math.sin(lean);
    const drop = 1 - Math.cos(lean);
    const direction = actor.leanDirection;
    const cosine = Math.cos(actor.yaw), sine = Math.sin(actor.yaw);
    // A small ballistic hop at the start of the fall, gone by the settle.
    const hop = actor.state === GDO_POSEFALL_STATE.FALLING
      ? Math.sin(Math.PI * clamp(progress, 0, 1)) * .035 * actor.severity
      : 0;
    pose.state = actor.state;
    pose.progress = clamp(progress, 0, 1);
    for (const segment of pose.segments) {
      const base = rig[segment.role];
      const axis = HORIZONTAL_OFFSET[segment.role] ?? 0;
      const swing = segment.role === 'armLeft' ? actor.armSwing : segment.role === 'armRight' ? -actor.armSwing
        : segment.role === 'legLeft' ? actor.legSplay : segment.role === 'legRight' ? -actor.legSplay : 0;
      // The body tips along the impulse: every segment drops by its height above
      // the pelvis and slides along the fall direction.
      const heightAbovePelvis = Math.max(0, base.y - rig.pelvis.y);
      const tip = drop * (base.y / rig.head.y);
      const x = actor.x + (axis * cosine - swing * sine) + direction.x * horizontal * (.08 + heightAbovePelvis);
      const z = actor.z + (axis * sine + swing * cosine) + direction.z * horizontal * (.08 + heightAbovePelvis);
      const y = actor.groundY + base.y - tip * (base.y / rig.head.y) * 1.02 + hop;
      segment.x = x;
      segment.z = z;
      segment.y = Math.max(y, groundAt(x, z) + base.clearance);
      segment.pitch = lean * (segment.role === 'pelvis' ? .55 : 1);
      segment.roll = swing * lean * .6;
    }
  }

  /** Deterministic arc into the fall: severity comes from the impulse magnitude. */
  function knockDown(id, impulse) {
    const actor = actors.get(id);
    if (!actor) { refusals[GDO_POSEFALL_REFUSAL.UNKNOWN_ACTOR]++; return { ok: false, refusal: GDO_POSEFALL_REFUSAL.UNKNOWN_ACTOR }; }
    if (actor.state !== GDO_POSEFALL_STATE.STANDING) {
      refusals[GDO_POSEFALL_REFUSAL.ALREADY_FALLING]++;
      return { ok: false, refusal: GDO_POSEFALL_REFUSAL.ALREADY_FALLING };
    }
    const values = Array.isArray(impulse) ? impulse : [impulse?.x, impulse?.y, impulse?.z];
    if (!Array.isArray(values) || values.length !== 3 || !values.every(Number.isFinite)) {
      refusals[GDO_POSEFALL_REFUSAL.NO_IMPULSE]++;
      return { ok: false, refusal: GDO_POSEFALL_REFUSAL.NO_IMPULSE };
    }
    const horizontal = Math.hypot(values[0], values[2]);
    if (!(horizontal > 1e-4)) {
      refusals[GDO_POSEFALL_REFUSAL.NO_IMPULSE]++;
      return { ok: false, refusal: GDO_POSEFALL_REFUSAL.NO_IMPULSE };
    }
    const magnitude = Math.min(horizontal, policy.maxImpulse);
    actor.severity = clamp(magnitude / policy.maxImpulse, .18, 1);
    actor.leanDirection = { x: values[0] / horizontal, z: values[2] / horizontal };
    actor.state = GDO_POSEFALL_STATE.FALLING;
    actor.elapsed = 0;
    actor.duration = clamp(
      policy.fallSeconds + (1 - actor.severity) * policy.severitySeconds,
      policy.fallSeconds,
      policy.maximumFallSeconds,
    );
    actor.maxLean = policy.maxLeanRadians * actor.severity;
    actor.armSwing = .55 + stableUnit(seed, nextId, `arm:${id}`) * .35;
    actor.legSplay = .22 + stableUnit(seed, nextId, `leg:${id}`) * .3;
    knockdowns++;
    writePose(actor, 0);
    return { ok: true, severity: actor.severity, duration: actor.duration, variant: actor.variant.id };
  }

  function stepActor(actor, dtSeconds) {
    actor.elapsed += dtSeconds;
    switch (actor.state) {
      case GDO_POSEFALL_STATE.FALLING: {
        const progress = clamp(actor.elapsed / actor.duration, 0, 1);
        actor.lean = actor.maxLean * easeOutCubic(clamp(progress * 1.15, 0, 1));
        writePose(actor, progress);
        if (progress >= 1) {
          actor.state = GDO_POSEFALL_STATE.SETTLING;
          actor.elapsed = 0;
          actor.variantLean = GDO_POSEFALL_VARIANTS.find(variant => variant === actor.variant).lean;
          actor.settleFrom = actor.lean;
          settles++;
        }
        return;
      }
      case GDO_POSEFALL_STATE.SETTLING: {
        const progress = clamp(actor.elapsed / policy.settleSeconds, 0, 1);
        // The stable variant wins smoothly: the final pose is authored, not
        // whatever the spring happened to leave behind.
        actor.lean = actor.settleFrom + (actor.variant.lean - actor.settleFrom) * easeInOut(progress);
        actor.armSwing = actor.armSwing + (actor.variant.armSwing - actor.armSwing) * easeInOut(progress);
        actor.legSplay = actor.legSplay + (actor.variant.legSplay - actor.legSplay) * easeInOut(progress);
        writePose(actor, progress);
        if (progress >= 1) { actor.state = GDO_POSEFALL_STATE.DOWN; actor.elapsed = 0; }
        return;
      }
      case GDO_POSEFALL_STATE.DOWN: {
        // The lying pose is already authored: holding it costs one clamp pass,
        // no re-simulation. Removal happens here when the board despawns.
        writePose(actor, 1);
        if (actor.elapsed >= policy.downSeconds) {
          if (despawn) {
            actors.delete(actor.id);
            removals++;
            return 'removed';
          }
          actor.state = GDO_POSEFALL_STATE.RISING;
          actor.elapsed = 0;
          actor.riseFrom = actor.lean;
        }
        return;
      }
      case GDO_POSEFALL_STATE.RISING: {
        const progress = clamp(actor.elapsed / policy.riseSeconds, 0, 1);
        actor.lean = actor.riseFrom * (1 - easeInOut(progress));
        writePose(actor, 1 - progress);
        if (progress >= 1) {
          actor.state = GDO_POSEFALL_STATE.STANDING;
          actor.lean = 0;
          actor.elapsed = 0;
          writeStandingPose(actor);
          recoveries++;
        }
        return;
      }
      default:
        return;
    }
  }

  /** Fixed step, clamped like the pushable pool: same elapsed time, same pose. */
  function update(deltaMilliseconds) {
    lastSteps = 0;
    lastPoseWrites = 0;
    if (!Number.isFinite(deltaMilliseconds) || deltaMilliseconds < 0) { malformedInputs++; return 0; }
    accumulator += Math.min(deltaMilliseconds * .001, .25);
    while (accumulator >= policy.fixedStepSeconds && lastSteps < policy.maxSubstepsPerFrame) {
      accumulator -= policy.fixedStepSeconds;
      lastSteps++;
      totalSteps++;
      for (const actor of [...actors.values()]) {
        if (actor.state === GDO_POSEFALL_STATE.STANDING) continue;
        if (lastPoseWrites >= policy.poseWritesPerFrame) break;
        const outcome = stepActor(actor, policy.fixedStepSeconds);
        if (outcome !== 'removed') { lastPoseWrites++; totalPoseWrites++; }
      }
    }
    if (accumulator >= policy.fixedStepSeconds) accumulator %= policy.fixedStepSeconds;
    return lastSteps;
  }

  return Object.freeze({
    namespace: GDO_POSEFALL_NAMESPACE,
    profile,
    policy,
    spawn,
    knockDown,
    update,
    remove(id) {
      if (!actors.delete(id)) { refusals[GDO_POSEFALL_REFUSAL.UNKNOWN_ACTOR]++; return false; }
      removals++;
      return true;
    },
    actor: id => actors.get(id) ?? null,
    /** The live pose record (mutated in place) — a renderer holds this. */
    pose: id => actors.get(id)?.pose ?? null,
    poses: () => [...actors.values()].map(actor => actor.pose),
    stateOf: id => actors.get(id)?.state ?? null,
    get count() { return actors.size; },
    get falling() { return [...actors.values()].filter(actor => actor.state !== GDO_POSEFALL_STATE.STANDING).length; },
    get diagnostics() {
      return Object.freeze({
        namespace: GDO_POSEFALL_NAMESPACE,
        profile,
        actors: actors.size,
        falling: [...actors.values()].filter(actor => actor.state !== GDO_POSEFALL_STATE.STANDING).length,
        maxActors: policy.maxActors,
        segmentsPerActor: policy.segments,
        fixedStepSeconds: policy.fixedStepSeconds,
        lastSteps,
        lastPoseWrites,
        totalSteps,
        totalPoseWrites,
        knockdowns,
        settles,
        recoveries,
        removals,
        malformedInputs,
        refusals: Object.freeze({ ...refusals }),
        // No rigid bodies, no constraint solver, no per-frame allocation.
        rigidBodies: 0,
        constraintIterations: 0,
        steadyFrameAllocations: 0,
        cpuMatrixUpdates: 0,
        poses: actors.size,
      });
    },
  });
}
