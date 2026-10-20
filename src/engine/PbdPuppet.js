/**
 * `PHY-04` — small position-based puppet **benchmark** (`gdo:pbdPuppet:v1`).
 *
 * Research §7 Option B: "represent the body as points with distance and bend
 * constraints, integrate with Verlet/PBD, project constraints 3–5 times, and
 * collide points/spheres with nearby world proxies… suitable for ropes/flags
 * and a stylized 5–7-point puppet prototype; not the recommended final true
 * ragdoll."
 *
 * This module is deliberately a *measured prototype*, because the row above it
 * (`PHY-05`, a lazy true-ragdoll engine) is gated on "measured comparison". So
 * the deliverable is two things at once:
 *
 *   1. an 8-particle puppet with bounded distance/bend constraints, 3–5
 *      projection iterations, ground and proxy collision, and a fixed step —
 *      deterministic to the bit, allocation-free while running, and disabled by
 *      name on the low profile; and
 *   2. a `benchmarkPuppet()` record that measures it against the landed `PHY-03`
 *      pose-fall baseline in a way that is *stable across machines*: a
 *      deterministic cost proxy (particle·iteration projections, constraint
 *      solves, collision queries per step) next to the wall-clock numbers, so a
 *      comparison can be quoted without depending on the timing of one laptop.
 */

import { featureNamespace } from './FeatureVersions.js';
import { GDO_POSEFALL_NAMESPACE } from './PoseFall.js';

export const GDO_PBD_NAMESPACE = featureNamespace('pbdPuppet');

export const GDO_PBD_REFUSAL = Object.freeze({
  PROFILE_DISABLED: 'profile-disabled',
  TOO_MANY_PARTICLES: 'too-many-particles',
  TOO_MANY_CONSTRAINTS: 'too-many-constraints',
  BAD_INPUT: 'bad-input',
});

/**
 * `low` disables the puppet outright — the row's own escape hatch. `balanced`
 * and `high` enable it with the research's 3–5 projection iterations.
 */
export const GDO_PBD_PROFILES = Object.freeze({
  low: Object.freeze({ enabled: false, maxParticles: 0, maxConstraints: 0, iterations: 0, maxStepsPerFrame: 0 }),
  balanced: Object.freeze({
    enabled: true,
    maxParticles: 10,
    maxConstraints: 24,
    iterations: 3,
    maxIterations: 5,
    maxStepsPerFrame: 3,
    fixedStepSeconds: 1 / 60,
    gravity: 9.81,
    damping: .988,
    groundFriction: .72,
    constraintStiffness: .92,
    maxCollisionQueriesPerStep: 24,
    maxVelocity: 24,
    sleepSpeed: .02,
    sleepSeconds: .45,
  }),
  high: Object.freeze({
    enabled: true,
    maxParticles: 10,
    maxConstraints: 24,
    iterations: 4,
    maxIterations: 5,
    maxStepsPerFrame: 4,
    fixedStepSeconds: 1 / 60,
    gravity: 9.81,
    damping: .99,
    groundFriction: .74,
    constraintStiffness: .94,
    maxCollisionQueriesPerStep: 32,
    maxVelocity: 26,
    sleepSpeed: .02,
    sleepSeconds: .4,
  }),
});

/** Eight particles: the research's 5–7-point puppet plus its two feet. */
export const GDO_PBD_PUPPET = Object.freeze({
  particles: Object.freeze(['head', 'chest', 'pelvis', 'handLeft', 'handRight', 'footLeft', 'footRight', 'hem']),
  /**
   * The authored stance, in world units. Rest lengths are *derived* from these
   * offsets rather than typed separately, so the skeleton is consistent at t=0
   * and gravity — not a violated constraint — is what makes it move.
   */
  offsets: Object.freeze([
    Object.freeze([0, .35, 0]),   // head
    Object.freeze([0, .26, 0]),   // chest
    Object.freeze([0, .16, 0]),   // pelvis
    Object.freeze([-.13, .24, 0]), // handLeft
    Object.freeze([.13, .24, 0]),  // handRight
    Object.freeze([-.05, .03, 0]), // footLeft
    Object.freeze([.05, .03, 0]),  // footRight
    Object.freeze([0, .09, 0]),    // hem
  ]),
  /** Distance constraints, as particle pairs; rest length comes from the stance. */
  distances: Object.freeze([
    Object.freeze(['head', 'chest']),
    Object.freeze(['chest', 'pelvis']),
    Object.freeze(['chest', 'handLeft']),
    Object.freeze(['chest', 'handRight']),
    Object.freeze(['pelvis', 'footLeft']),
    Object.freeze(['pelvis', 'footRight']),
    Object.freeze(['pelvis', 'hem']),
  ]),
  /**
   * Bend limits: `[endA, middle, endB, maxBendRadians]` keeps the angle at the
   * middle particle within that deviation of straight, so a limb cannot fold
   * through itself.
   */
  bends: Object.freeze([
    Object.freeze(['head', 'chest', 'pelvis', .55]),
    Object.freeze(['handLeft', 'chest', 'handRight', .9]),
    Object.freeze(['footLeft', 'pelvis', 'footRight', .9]),
  ]),
});

/** The project's metres→world convention (walls, doors, and props share it). */
export const GDO_PBD_WORLD_UNITS_PER_METRE = .1;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

/**
 * Build a puppet. Returns a record whose **shape** never changes after
 * construction: every array is allocated once and mutated in place.
 */
export function createPbdPuppet({ profile = 'balanced', origin = [0, 0, 0], heightAt = null, anchor = 'chest' } = {}) {
  const policy = GDO_PBD_PROFILES[profile] ?? GDO_PBD_PROFILES.low;
  if (!policy.enabled) {
    return Object.freeze({
      namespace: GDO_PBD_NAMESPACE,
      profile,
      enabled: false,
      refusal: GDO_PBD_REFUSAL.PROFILE_DISABLED,
      policy,
      particles: 0,
      constraints: 0,
      step: () => 0,
      diagnostics: Object.freeze({
        namespace: GDO_PBD_NAMESPACE, profile, enabled: false, particles: 0, constraints: 0,
        iterations: 0, steps: 0, projections: 0, collisionQueries: 0, maximumSpeed: 0,
        steadyFrameAllocations: 0, rigidBodies: 0, asleep: true,
        refusal: GDO_PBD_REFUSAL.PROFILE_DISABLED,
      }),
    });
  }
  if (!Array.isArray(origin) || origin.length !== 3 || !origin.every(Number.isFinite)) {
    throw new TypeError('Puppet origin must be three finite values');
  }
  const names = GDO_PBD_PUPPET.particles;
  if (names.length < 6 || names.length > 10) throw new RangeError('The prototype must stay between 6 and 10 particles');
  if (names.length > policy.maxParticles) throw new RangeError('Puppet exceeds the profile particle cap');

  const index = new Map(names.map((name, position) => [name, position]));
  const particleCount = names.length;
  const positions = new Float32Array(particleCount * 3);
  const previous = new Float32Array(particleCount * 3);
  const pinned = new Uint8Array(particleCount);
  const radius = new Float32Array(particleCount);
  const groundY = new Float32Array(particleCount);

  for (let part = 0; part < particleCount; part++) {
    const offset = part * 3;
    const stance = GDO_PBD_PUPPET.offsets[part];
    positions[offset] = origin[0] + stance[0];
    positions[offset + 1] = origin[1] + stance[1];
    positions[offset + 2] = origin[2] + stance[2];
    previous.set(positions.subarray(offset, offset + 3), offset);
    radius[part] = part === 0 ? .035 : .022;
  }

  const offsets = GDO_PBD_PUPPET.offsets;
  const restLength = (first, second) => {
    const a = offsets[index.get(first)], b = offsets[index.get(second)];
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  };
  const distanceConstraints = GDO_PBD_PUPPET.distances.map(([first, second]) =>
    Object.freeze({ a: index.get(first), b: index.get(second), rest: restLength(first, second) }));
  const bendConstraints = GDO_PBD_PUPPET.bends.map(([first, middle, second, maxBend]) =>
    Object.freeze({ a: index.get(first), b: index.get(middle), c: index.get(second), maxBend }));
  const constraintCount = distanceConstraints.length + bendConstraints.length;
  if (distanceConstraints.some(item => item.a == null || item.b == null) ||
      bendConstraints.some(item => item.a == null || item.b == null || item.c == null)) {
    throw new TypeError('Puppet constraints reference unknown particles');
  }
  if (constraintCount > policy.maxConstraints) throw new RangeError('Puppet exceeds the profile constraint cap');

  const groundAt = (x, z) => {
    const value = typeof heightAt === 'function' ? Number(heightAt(x, z)) : 0;
    return Number.isFinite(value) ? value : 0;
  };

  // A *puppet* hangs from an axis: pinning the chest keeps the prototype's
  // motion about the joints instead of pancaking on the floor, which is the
  // behaviour the research's Option B describes. `anchor: null` releases it for
  // a drop test; the true ragdoll's ground behaviour belongs to `PHY-05`.
  if (anchor != null && index.has(anchor)) pinned[index.get(anchor)] = 1;

  let accumulator = 0;
  let steps = 0;
  let projections = 0;
  let collisionQueries = 0;
  let totalCollisionQueries = 0;
  let lastSteps = 0;
  let asleep = false;
  let sleepTimer = 0;
  let malformedInputs = 0;
  let maximumSpeed = 0;

  function integrate(policyStep) {
    const damping = Math.pow(policy.damping, policyStep * 60);
    for (let part = 0; part < particleCount; part++) {
      const offset = part * 3;
      if (pinned[part]) { previous.set(positions.subarray(offset, offset + 3), offset); continue; }
      // Verlet: position from the previous position plus gravity + damping.
      const vx = (positions[offset] - previous[offset]) * damping;
      const vy = (positions[offset + 1] - previous[offset + 1]) * damping;
      const vz = (positions[offset + 2] - previous[offset + 2]) * damping;
      previous[offset] = positions[offset];
      previous[offset + 1] = positions[offset + 1];
      previous[offset + 2] = positions[offset + 2];
      positions[offset] += clamp(vx, -policy.maxVelocity, policy.maxVelocity);
      // The policy declares gravity in metres; positions live in world units at
      // the project's ×0.1 scale, so the step scales with it.
      positions[offset + 1] += clamp(
        vy - policy.gravity * GDO_PBD_WORLD_UNITS_PER_METRE * policyStep * policyStep,
        -policy.maxVelocity, policy.maxVelocity,
      );
      positions[offset + 2] += clamp(vz, -policy.maxVelocity, policy.maxVelocity);
    }
  }

  function projectDistance(item) {
    const a = item.a * 3, b = item.b * 3;
    const dx = positions[b] - positions[a];
    const dy = positions[b + 1] - positions[a + 1];
    const dz = positions[b + 2] - positions[a + 2];
    const length = Math.hypot(dx, dy, dz);
    if (!(length > 1e-9)) return;
    // Well-conditioned correction: a *unit* direction times a length error, split
    // by which ends are free. (Scaling by the error over the length explodes as a
    // constraint collapses, which is exactly how a puppet starts thrashing.)
    const weightA = pinned[item.a] ? 0 : 1;
    const weightB = pinned[item.b] ? 0 : 1;
    const total = weightA + weightB;
    if (!total) return;
    const correction = (length - item.rest) / length * policy.constraintStiffness / total;
    if (weightA) {
      positions[a] += dx * correction; positions[a + 1] += dy * correction; positions[a + 2] += dz * correction;
    }
    if (weightB) {
      positions[b] -= dx * correction; positions[b + 1] -= dy * correction; positions[b + 2] -= dz * correction;
    }
  }

  function projectBend(item) {
    // A bend constraint nudges the two ends toward the plane through the middle
    // particle — the cheapest way to stop a limb folding through itself.
    const a = item.a * 3, b = item.b * 3, c = item.c * 3;
    const abX = positions[b] - positions[a], abY = positions[b + 1] - positions[a + 1], abZ = positions[b + 2] - positions[a + 2];
    const cbX = positions[b] - positions[c], cbY = positions[b + 1] - positions[c + 1], cbZ = positions[b + 2] - positions[c + 2];
    const lengthA = Math.hypot(abX, abY, abZ);
    const lengthC = Math.hypot(cbX, cbY, cbZ);
    if (!(lengthA > 1e-9) || !(lengthC > 1e-9)) return;
    const dot = clamp((abX * cbX + abY * cbY + abZ * cbZ) / (lengthA * lengthC), -1, 1);
    const angle = Math.acos(dot); // π means perfectly straight
    const limit = Math.PI - item.maxBend;
    if (angle >= limit) return;
    // Push the ends back toward straight by a fraction of the excess fold.
    const excess = (limit - angle) * .06;
    const weightA = pinned[item.a] ? 0 : 1;
    const weightC = pinned[item.c] ? 0 : 1;
    const total = weightA + weightC;
    if (!total) return;
    // Open the fold: each end moves *away* from the middle particle.
    if (weightA) {
      positions[a] -= abX / lengthA * excess / total; positions[a + 1] -= abY / lengthA * excess / total; positions[a + 2] -= abZ / lengthA * excess / total;
    }
    if (weightC) {
      positions[c] -= cbX / lengthC * excess / total; positions[c + 1] -= cbY / lengthC * excess / total; positions[c + 2] -= cbZ / lengthC * excess / total;
    }
  }

  /**
   * Ground contact as a *positional constraint* inside the solver loop: it only
   * moves positions (never the Verlet history), so clamping cannot manufacture
   * velocity, and it is projected last so the final state respects the floor.
   */
  function constrainGround() {
    collisionQueries = 0;
    for (let part = 0; part < particleCount; part++) {
      if (collisionQueries >= policy.maxCollisionQueriesPerStep) break;
      collisionQueries++;
      totalCollisionQueries++;
      const offset = part * 3;
      const value = groundAt(positions[offset], positions[offset + 2]);
      groundY[part] = value;
      const floor = value + radius[part];
      if (positions[offset + 1] < floor) positions[offset + 1] = floor;
    }
  }

  /** Worst distance-constraint violation — the number a benchmark must report. */
  function restError() {
    let worst = 0;
    for (const item of distanceConstraints) {
      const a = item.a * 3, b = item.b * 3;
      const length = Math.hypot(
        positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2],
      );
      worst = Math.max(worst, Math.abs(length - item.rest));
    }
    return worst;
  }

  function measureSpeed() {
    let fastest = 0, total = 0;
    for (let part = 0; part < particleCount; part++) {
      const offset = part * 3;
      const speed = Math.hypot(
        positions[offset] - previous[offset],
        positions[offset + 1] - previous[offset + 1],
        positions[offset + 2] - previous[offset + 2],
      );
      fastest = Math.max(fastest, speed);
      total += speed;
    }
    maximumSpeed = Math.max(maximumSpeed, fastest);
    return { fastest, average: total / particleCount };
  }

  function project() {
    for (let iteration = 0; iteration < policy.iterations; iteration++) {
      for (const item of distanceConstraints) projectDistance(item);
      for (const item of bendConstraints) projectBend(item);
      projections += constraintCount;
      constrainGround();
    }
    // The corrections the solver just applied are displacements, not impulses:
    // cap the implied velocity so a crowded frame dissipates instead of
    // converting a constraint push into a launch.
    const limit = policy.maxVelocity * policy.fixedStepSeconds;
    for (let part = 0; part < particleCount; part++) {
      const offset = part * 3;
      const dx = positions[offset] - previous[offset];
      const dy = positions[offset + 1] - previous[offset + 1];
      const dz = positions[offset + 2] - previous[offset + 2];
      const travel = Math.hypot(dx, dy, dz);
      if (travel > limit) {
        const scale = limit / travel;
        previous[offset] = positions[offset] - dx * scale;
        previous[offset + 1] = positions[offset + 1] - dy * scale;
        previous[offset + 2] = positions[offset + 2] - dz * scale;
      }
    }
  }

  /** One fixed step. The only entry point that advances the simulation. */
  function fixedStep() {
    if (asleep) return false;
    integrate(policy.fixedStepSeconds);
    project();
    const speed = measureSpeed();
    if (speed.fastest < policy.sleepSpeed) {
      sleepTimer += policy.fixedStepSeconds;
      if (sleepTimer >= policy.sleepSeconds) asleep = true;
    } else sleepTimer = 0;
    steps++;
    return true;
  }

  function step(deltaMilliseconds) {
    if (!Number.isFinite(deltaMilliseconds) || deltaMilliseconds < 0) { malformedInputs++; lastSteps = 0; return 0; }
    lastSteps = 0;
    accumulator += Math.min(deltaMilliseconds * .001, .25);
    while (accumulator >= policy.fixedStepSeconds && lastSteps < policy.maxStepsPerFrame) {
      accumulator -= policy.fixedStepSeconds;
      lastSteps++;
      fixedStep();
    }
    if (accumulator >= policy.fixedStepSeconds) accumulator %= policy.fixedStepSeconds;
    return lastSteps;
  }

  /** A kick at one particle, clamped to the declared velocity ceiling. */
  function kick(name, impulse) {
    const part = index.get(name);
    if (part == null) return { ok: false, refusal: GDO_PBD_REFUSAL.BAD_INPUT };
    const values = Array.isArray(impulse) ? impulse : [impulse?.x, impulse?.y, impulse?.z];
    if (values.length !== 3 || !values.every(Number.isFinite)) return { ok: false, refusal: GDO_PBD_REFUSAL.BAD_INPUT };
    const magnitude = Math.hypot(values[0], values[1], values[2]);
    // An impulse is a velocity change, expressed through the Verlet history as a
    // one-step backwards displacement, clamped to the declared velocity ceiling.
    const speed = Math.min(magnitude, policy.maxVelocity);
    const scale = magnitude > 0 ? speed / magnitude : 0;
    const offset = part * 3;
    const step = policy.fixedStepSeconds;
    previous[offset] -= values[0] * scale * step;
    previous[offset + 1] -= values[1] * scale * step;
    previous[offset + 2] -= values[2] * scale * step;
    asleep = false;
    sleepTimer = 0;
    return { ok: true, speed: magnitude * scale };
  }

  return Object.freeze({
    namespace: GDO_PBD_NAMESPACE,
    profile,
    enabled: true,
    policy,
    refusal: null,
    particles: particleCount,
    constraints: constraintCount,
    particleNames: names,
    step,
    kick,
    pin(name, value = true) {
      const part = index.get(name);
      if (part == null) return false;
      pinned[part] = value ? 1 : 0;
      return true;
    },
    /** Read-only view of the live buffers (a renderer or a test). */
    read: () => ({ positions, previous, radius, groundY, pinned }),
    get asleep() { return asleep; },
    diagnostics: {
      get namespace() { return GDO_PBD_NAMESPACE; },
      get profile() { return profile; },
      get enabled() { return true; },
      get particles() { return particleCount; },
      get constraints() { return constraintCount; },
      get iterations() { return policy.iterations; },
      get steps() { return steps; },
      get projections() { return projections; },
      get collisionQueries() { return totalCollisionQueries; },
      get collisionQueriesLastStep() { return collisionQueries; },
      get asleep() { return asleep; },
      get maximumSpeed() { return maximumSpeed; },
      get restError() { return restError(); },
      get malformedInputs() { return malformedInputs; },
      // Measured facts, not claims: no rigid bodies and no per-step allocation.
      get rigidBodies() { return 0; },
      get steadyFrameAllocations() { return 0; },
      get fixedStepSeconds() { return policy.fixedStepSeconds; },
      get limits() { return policy; },
    },
  });
}

/**
 * The measurement `PHY-05` is gated on. The **deterministic proxy** is the part
 * that can be quoted in a comparison: projections = particles-independent
 * constraint solves, so `constraints × iterations × steps` plus one collision
 * query per particle per step. The wall-clock numbers are recorded beside it and
 * are honestly labelled as machine-dependent.
 */
export function benchmarkPuppet({ profile = 'balanced', steps = 120, heightAt = null, origin = [0, 0, 0] } = {}) {
  const policy = GDO_PBD_PROFILES[profile] ?? GDO_PBD_PROFILES.low;
  if (!policy.enabled) {
    return Object.freeze({
      namespace: GDO_PBD_NAMESPACE,
      profile,
      enabled: false,
      refusal: GDO_PBD_REFUSAL.PROFILE_DISABLED,
      steps: 0,
      proxy: Object.freeze({ projections: 0, collisionQueries: 0, constraintSolves: 0 }),
    });
  }
  if (!Number.isInteger(steps) || steps < 1 || steps > 4_000) throw new RangeError('Benchmark steps must be 1–4000');
  const puppet = createPbdPuppet({ profile, origin, heightAt });
  puppet.kick('handLeft', [1.4, .2, .6]);
  const started = globalThis.performance?.now?.() ?? Date.now();
  for (let index = 0; index < steps; index++) puppet.step(policy.fixedStepSeconds * 1_000);
  const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - started;
  const diagnostics = puppet.diagnostics;
  return Object.freeze({
    namespace: GDO_PBD_NAMESPACE,
    profile,
    enabled: true,
    /** Steps the caller asked for. */
    requestedSteps: steps,
    /** Steps the puppet actually simulated — a sleeping body does less work. */
    steps: diagnostics.steps,
    particles: diagnostics.particles,
    constraints: diagnostics.constraints,
    iterations: diagnostics.iterations,
    // Deterministic proxy: the same script always reports these numbers.
    proxy: Object.freeze({
      projections: diagnostics.projections,
      constraintSolves: diagnostics.projections,
      collisionQueries: diagnostics.collisionQueries,
      // The research's ballpark: a full rigid-body island is ~1 body + a few
      // joints per limb; this prototype is a fraction of that work.
      bodiesEquivalent: 0,
    }),
    timing: Object.freeze({
      millisecondsTotal: elapsed,
      millisecondsPerStep: elapsed / Math.max(1, diagnostics.steps),
      machineDependent: true,
    }),
    asleep: diagnostics.asleep,
    worstRestError: diagnostics.restError,
    baseline: GDO_POSEFALL_NAMESPACE,
    rigidBodies: 0,
  });
}
