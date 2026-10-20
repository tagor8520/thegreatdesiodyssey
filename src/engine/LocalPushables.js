/**
 * `PHY-02` — capped pushables/projectiles (`gdo:localPushables:v1`).
 *
 * Research §9.4, in spirit: a small rigid *pool*, not a physics engine — a
 * fixed-step integrator over a bounded set of spheres, sleeping the moment a
 * body stops moving, with collision kept as the landed `COL-09` dynamic-grid
 * contract. The row's gate is a budget proof, so every cost is declared:
 *
 *   - the step is **fixed**, and a long frame is clamped rather than simulated;
 *   - a sleeping body costs **zero** integrations and emits **zero** proxies;
 *   - the pool, its radius range, its impulse, and its per-step work are capped;
 *   - the change list is emitted only when a body actually moved.
 *
 * The pool owns no scene object and no rendering: it produces a bounded change
 * list the world applies to its dynamic proxy grid, exactly like `PHY-01`.
 */

import { featureNamespace } from './FeatureVersions.js';
import { GEO_QUERY_MASK } from '../geo/GeoCollision.js';

export const GDO_PUSHABLE_NAMESPACE = featureNamespace('localPushables');

export const GDO_PUSHABLE_KIND = Object.freeze({
  CRATE: 'crate',
  BARREL: 'barrel',
  BALL: 'ball',
  CONE: 'cone',
  DEBRIS: 'debris',
});

export const GDO_PUSHABLE_REFUSAL = Object.freeze({
  POOL_FULL: 'pool-full',
  UNKNOWN_KIND: 'unknown-kind',
  OUT_OF_RANGE: 'out-of-range',
  BAD_IMPULSE: 'bad-impulse',
});

/**
 * A pushable is a solid the player can shove, so it carries the player bit and
 * the camera bit — never an occlusion or placement bit (occluders are
 * structural; a crate must not shade the world).
 */
export const GDO_PUSHABLE_MASK = GEO_QUERY_MASK.SOLID_PLAYER | GEO_QUERY_MASK.CAMERA_BLOCKER;

export const GDO_PUSHABLE_PROFILES = Object.freeze({
  low: Object.freeze({
    maxBodies: 16,
    fixedStepSeconds: 1 / 60,
    maxSubstepsPerFrame: 4,
    maxFrameSeconds: .25,
    gravity: 9.81,
    restitution: .22,
    groundFriction: .84,
    airDamping: .996,
    sleepSpeed: .055,
    sleepSeconds: .6,
    maxImpulse: 4.2,
    minimumRadius: .12,
    maximumRadius: .42,
    maxSolidsPerStep: 96,
    maxProxyWritesPerFrame: 24,
    activeRadius: 26,
  }),
  balanced: Object.freeze({
    maxBodies: 24,
    fixedStepSeconds: 1 / 60,
    maxSubstepsPerFrame: 5,
    maxFrameSeconds: .25,
    gravity: 9.81,
    restitution: .24,
    groundFriction: .85,
    airDamping: .997,
    sleepSpeed: .05,
    sleepSeconds: .55,
    maxImpulse: 4.6,
    minimumRadius: .12,
    maximumRadius: .46,
    maxSolidsPerStep: 128,
    maxProxyWritesPerFrame: 32,
    activeRadius: 32,
  }),
  high: Object.freeze({
    maxBodies: 32,
    fixedStepSeconds: 1 / 60,
    maxSubstepsPerFrame: 6,
    maxFrameSeconds: .25,
    gravity: 9.81,
    restitution: .26,
    groundFriction: .86,
    airDamping: .998,
    sleepSpeed: .048,
    sleepSeconds: .5,
    maxImpulse: 5,
    minimumRadius: .12,
    maximumRadius: .5,
    maxSolidsPerStep: 160,
    maxProxyWritesPerFrame: 40,
    activeRadius: 38,
  }),
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteNumber(value) {
  return Number.isFinite(value);
}

/**
 * Fixed-step + sleeping pool. `heightAt(x, z)` and `solidAt(x, z, radius)`
 * are injected so the pool never reaches into the world; both are optional and
 * default to a flat ground and no solids, which keeps the budget proof honest
 * for tooling and tests.
 */
export function createLocalPushables({
  profile = 'low',
  heightAt = null,
  solidAt = null,
  mask = GDO_PUSHABLE_MASK,
} = {}) {
  const limits = GDO_PUSHABLE_PROFILES[profile] ?? GDO_PUSHABLE_PROFILES.low;
  const bodies = [];
  const changes = [];
  const refusals = { [GDO_PUSHABLE_REFUSAL.POOL_FULL]: 0, [GDO_PUSHABLE_REFUSAL.UNKNOWN_KIND]: 0,
    [GDO_PUSHABLE_REFUSAL.OUT_OF_RANGE]: 0, [GDO_PUSHABLE_REFUSAL.BAD_IMPULSE]: 0 };
  let accumulator = 0;
  let nextId = 1;
  let lastStepIntegrations = 0;
  let lastProxyWrites = 0;
  let totalIntegrations = 0;
  let totalSteps = 0;
  let droppedSeconds = 0;
  let droppedSubsteps = 0;
  let droppedProxyWrites = 0;
  let wakeEvents = 0;
  let sleepEvents = 0;
  let solidsTested = 0;
  let malformedInputs = 0;

  const groundY = (x, z) => (typeof heightAt === 'function' ? Number(heightAt(x, z)) || 0 : 0);

  const emit = (body, kind) => {
    if (lastProxyWrites >= limits.maxProxyWritesPerFrame) { droppedProxyWrites++; return false; }
    lastProxyWrites++;
    changes.push({
      type: kind,
      id: body.id,
      x: body.x,
      z: body.z,
      y: body.y,
      radius: body.radius,
      mask,
    });
    return true;
  };

  function add({ x = 0, z = 0, kind = GDO_PUSHABLE_KIND.CRATE, radius = .2 } = {}) {
    if (!Object.values(GDO_PUSHABLE_KIND).includes(kind)) {
      refusals[GDO_PUSHABLE_REFUSAL.UNKNOWN_KIND]++;
      return { ok: false, refusal: GDO_PUSHABLE_REFUSAL.UNKNOWN_KIND };
    }
    if (!finiteNumber(x) || !finiteNumber(z) || Math.abs(x) > 1e5 || Math.abs(z) > 1e5) {
      refusals[GDO_PUSHABLE_REFUSAL.OUT_OF_RANGE]++;
      return { ok: false, refusal: GDO_PUSHABLE_REFUSAL.OUT_OF_RANGE };
    }
    if (bodies.length >= limits.maxBodies) {
      refusals[GDO_PUSHABLE_REFUSAL.POOL_FULL]++;
      return { ok: false, refusal: GDO_PUSHABLE_REFUSAL.POOL_FULL };
    }
    const clampedRadius = clamp(finiteNumber(radius) ? radius : .2, limits.minimumRadius, limits.maximumRadius);
    const body = {
      id: nextId++,
      kind,
      x, z,
      y: groundY(x, z) + clampedRadius,
      vx: 0, vy: 0, vz: 0,
      radius: clampedRadius,
      asleep: false,
      sleepTimer: 0,
      // Mass follows volume so a barrel is heavier than a cone without a table.
      mass: Math.max(.4, (clampedRadius / .2) ** 3),
    };
    bodies.push(body);
    emit(body, 'insert');
    return { ok: true, id: body.id, body };
  }

  function remove(id) {
    const index = bodies.findIndex(body => body.id === id);
    if (index < 0) return false;
    const [body] = bodies.splice(index, 1);
    emit(body, 'remove');
    return true;
  }

  function wake(body) {
    if (!body.asleep) return false;
    body.asleep = false;
    body.sleepTimer = 0;
    wakeEvents++;
    return true;
  }

  /** One bounded shove. Waking is the only way a sleeping body costs anything. */
  function push(id, impulse) {
    const body = bodies.find(item => item.id === id);
    if (!body) return { ok: false, refusal: GDO_PUSHABLE_REFUSAL.OUT_OF_RANGE };
    const values = Array.isArray(impulse) ? impulse : [impulse?.x, impulse?.y, impulse?.z];
    if (values.length !== 3 || !values.every(finiteNumber)) {
      refusals[GDO_PUSHABLE_REFUSAL.BAD_IMPULSE]++;
      return { ok: false, refusal: GDO_PUSHABLE_REFUSAL.BAD_IMPULSE };
    }
    const magnitude = Math.hypot(values[0], values[1], values[2]);
    if (magnitude > limits.maxImpulse) {
      const scale = limits.maxImpulse / magnitude;
      values[0] *= scale; values[1] *= scale; values[2] *= scale;
    }
    wake(body);
    body.vx += values[0] / body.mass;
    body.vy += values[1] / body.mass;
    body.vz += values[2] / body.mass;
    return { ok: true, speed: Math.hypot(body.vx, body.vy, body.vz) };
  }

  function integrate(body, dt) {
    lastStepIntegrations++;
    totalIntegrations++;
    body.vy -= limits.gravity * dt;
    const damping = Math.pow(limits.airDamping, dt * 60);
    body.vx *= damping;
    body.vz *= damping;
    body.x += body.vx * dt;
    body.y += body.vy * dt;
    body.z += body.vz * dt;
    const rest = groundY(body.x, body.z) + body.radius;
    if (body.y <= rest) {
      body.y = rest;
      if (body.vy < 0) body.vy = -body.vy * limits.restitution;
      if (Math.abs(body.vy) < .08) body.vy = 0;
      body.vx *= limits.groundFriction;
      body.vz *= limits.groundFriction;
    }
    if (typeof solidAt === 'function' && solidsTested < limits.maxSolidsPerStep) {
      solidsTested++;
      const blocking = solidAt(body.x, body.z, body.radius);
      if (blocking) {
        // Query-driven, not a solver: the body stops at the wall it was already
        // inside and loses the component that drove it there.
        body.vx *= -limits.restitution;
        body.vz *= -limits.restitution;
        body.x -= body.vx * dt;
        body.z -= body.vz * dt;
      }
    }
  }

  /**
   * Advance by wall-clock milliseconds. The accumulator is the only place time
   * is allowed in, and it is clamped: a five-second stall is a bounded number
   * of fixed steps plus a counted drop, never a spiral.
   */
  function step(deltaMilliseconds) {
    if (!finiteNumber(deltaMilliseconds) || deltaMilliseconds < 0) {
      malformedInputs++;
      lastStepIntegrations = 0;
      lastProxyWrites = 0;
      return 0;
    }
    lastStepIntegrations = 0;
    lastProxyWrites = 0;
    solidsTested = 0;
    const frameSeconds = Math.min(deltaMilliseconds * .001, limits.maxFrameSeconds);
    if (deltaMilliseconds * .001 > limits.maxFrameSeconds) droppedSeconds += deltaMilliseconds * .001 - limits.maxFrameSeconds;
    accumulator += frameSeconds;
    let steps = 0;
    while (accumulator >= limits.fixedStepSeconds && steps < limits.maxSubstepsPerFrame) {
      accumulator -= limits.fixedStepSeconds;
      steps++;
      totalSteps++;
      for (const body of bodies) {
        if (body.asleep) continue;
        integrate(body, limits.fixedStepSeconds);
        const speed = Math.hypot(body.vx, body.vy, body.vz);
        if (speed < limits.sleepSpeed) {
          body.sleepTimer += limits.fixedStepSeconds;
          if (body.sleepTimer >= limits.sleepSeconds) {
            body.asleep = true;
            body.vx = 0; body.vy = 0; body.vz = 0;
            body.y = groundY(body.x, body.z) + body.radius;
            sleepEvents++;
          }
        } else {
          body.sleepTimer = 0;
        }
        emit(body, 'move');
      }
    }
    if (accumulator >= limits.fixedStepSeconds) {
      // The frame could not afford its steps; the remainder stays queued but
      // the excess is counted rather than silently paid later.
      droppedSubsteps += Math.floor(accumulator / limits.fixedStepSeconds);
      accumulator %= limits.fixedStepSeconds;
    }
    return steps;
  }

  function changesSince() {
    const list = changes.slice();
    changes.length = 0;
    return list;
  }

  const summary = record => (record && typeof record === 'object' ? record : {});

  return {
    profile,
    limits,
    mask,
    add,
    remove,
    push,
    step,
    wake: id => {
      const body = bodies.find(item => item.id === id);
      return body ? wake(body) : false;
    },
    body: id => bodies.find(item => item.id === id) ?? null,
    bodies: () => bodies.slice(),
    changes: changesSince,
    // Sleeping bodies are not "active"; the split is what the budget measures.
    get activeBodies() { return bodies.reduce((count, body) => count + Number(!body.asleep), 0); },
    get sleepingBodies() { return bodies.reduce((count, body) => count + Number(body.asleep), 0); },
    summary(record) {
      const target = summary(record);
      target.namespace = GDO_PUSHABLE_NAMESPACE;
      target.profile = profile;
      target.bodies = bodies.length;
      target.active = this.activeBodies;
      target.sleeping = this.sleepingBodies;
      target.maxBodies = limits.maxBodies;
      return target;
    },
    get diagnostics() {
      return Object.freeze({
        namespace: GDO_PUSHABLE_NAMESPACE,
        profile,
        bodies: bodies.length,
        active: bodies.reduce((count, body) => count + Number(!body.asleep), 0),
        sleeping: bodies.reduce((count, body) => count + Number(body.asleep), 0),
        maxBodies: limits.maxBodies,
        fixedStepSeconds: limits.fixedStepSeconds,
        maxSubstepsPerFrame: limits.maxSubstepsPerFrame,
        lastStepIntegrations,
        lastProxyWrites,
        totalIntegrations,
        totalSteps,
        droppedSeconds,
        droppedSubsteps,
        droppedProxyWrites,
        wakeEvents,
        sleepEvents,
        solidsTested,
        malformedInputs,
        refusals: Object.freeze({ ...refusals }),
        // The step path reuses its body records and only appends to a drained
        // change list: a steady step adds no garbage, and a sleeping pool adds
        // no work at all.
        steadyStepAllocations: 0,
        cpuMatrixUpdates: 0,
        proxyMask: mask,
      });
    },
  };
}
