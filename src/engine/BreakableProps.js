/**
 * `PHY-06` — breakable props, ropes, and flags (`gdo:breakables:v1`).
 *
 * Research §9.6 and §9.8, followed literally:
 *
 *   - **Props break into pooled, pre-authored chunks** — 3–8 reusable pieces per
 *     archetype, spawned from a small pool with one outward impulse recipe, not
 *     a mesh fracture;
 *   - chunks **collide with the ground only on the low profile**, fade and
 *     freeze rapidly, and are **never** allowed to fracture mapped building
 *     geometry;
 *   - a rope is an **optional 5–10 point PBD chain** near the player, with no
 *     self-collision and no tearing;
 *   - a flag is **vertex-shader wind** — a declared wave function with a CPU
 *     mirror so the behaviour is testable and the reduced-motion answer is the
 *     same in both.
 *
 * The row's gate is "strict island/pool budgets and deterministic reset", so
 * both halves are hard-capped and `reset()` restores the pool to a state that is
 * byte-identical to a freshly constructed one.
 */

import { featureNamespace } from './FeatureVersions.js';

export const GDO_BREAKABLE_NAMESPACE = featureNamespace('breakables');

export const GDO_BREAKABLE_REFUSAL = Object.freeze({
  UNKNOWN_ARCHETYPE: 'unknown-archetype',
  MAPPED_GEOMETRY: 'mapped-geometry',
  POOL_EXHAUSTED: 'pool-exhausted',
  BAD_INPUT: 'bad-input',
  ROPE_TOO_LONG: 'rope-too-long',
  ROPE_BUDGET: 'rope-budget',
});

/** Chunk recipes: three to eight reusable pieces per archetype (research §9.8). */
export const GDO_BREAKABLE_ARCHETYPES = Object.freeze({
  crate: Object.freeze({ chunks: 6, spread: .9, lifeSeconds: 1.4, fadeSeconds: .45, palette: 'wood' }),
  barrel: Object.freeze({ chunks: 5, spread: 1.1, lifeSeconds: 1.5, fadeSeconds: .5, palette: 'metal' }),
  planter: Object.freeze({ chunks: 7, spread: .8, lifeSeconds: 1.6, fadeSeconds: .5, palette: 'clay' }),
  sign: Object.freeze({ chunks: 4, spread: 1.3, lifeSeconds: 1.2, fadeSeconds: .4, palette: 'metal' }),
  bench: Object.freeze({ chunks: 8, spread: 1.0, lifeSeconds: 1.7, fadeSeconds: .55, palette: 'wood' }),
});

export const GDO_BREAKABLE_PROFILES = Object.freeze({
  low: Object.freeze({
    maxChunks: 32,
    maxActiveBreaks: 3,
    maxChunksPerBreak: 8,
    maxRopes: 1,
    maxRopePoints: 10,
    minRopePoints: 5,
    ropeIterations: 3,
    maxImpulse: 2.4,
    gravity: .981,
    damping: .988,
    groundFriction: .7,
    fixedStepSeconds: 1 / 60,
    maxSubstepsPerFrame: 3,
    maxCollisionQueriesPerStep: 40,
    // Research §9.8: the low profile collides with the ground only.
    chunkContacts: 'ground-only',
    flagSegments: 6,
    flagAmplitude: .05,
    flagCyclesPerSecond: .9,
    maxFlagPoints: 7,
  }),
  balanced: Object.freeze({
    maxChunks: 48,
    maxActiveBreaks: 4,
    maxChunksPerBreak: 8,
    maxRopes: 2,
    maxRopePoints: 10,
    minRopePoints: 5,
    ropeIterations: 4,
    maxImpulse: 2.8,
    gravity: .981,
    damping: .99,
    groundFriction: .72,
    fixedStepSeconds: 1 / 60,
    maxSubstepsPerFrame: 4,
    maxCollisionQueriesPerStep: 56,
    chunkContacts: 'ground-and-walls',
    flagSegments: 7,
    flagAmplitude: .06,
    flagCyclesPerSecond: 1,
    maxFlagPoints: 8,
  }),
  high: Object.freeze({
    maxChunks: 64,
    maxActiveBreaks: 5,
    maxChunksPerBreak: 8,
    maxRopes: 2,
    maxRopePoints: 10,
    minRopePoints: 5,
    ropeIterations: 5,
    maxImpulse: 3.2,
    gravity: .981,
    damping: .992,
    groundFriction: .74,
    fixedStepSeconds: 1 / 60,
    maxSubstepsPerFrame: 5,
    maxCollisionQueriesPerStep: 72,
    chunkContacts: 'ground-and-walls',
    flagSegments: 8,
    flagAmplitude: .07,
    flagCyclesPerSecond: 1.1,
    maxFlagPoints: 9,
  }),
});

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function mix32(value) {
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function hashUnit(seed, channel) {
  let hash = mix32(seed ^ 0x9e3779b9);
  for (let index = 0; index < channel.length; index++) hash = mix32(hash ^ channel.charCodeAt(index));
  return hash / 4294967296;
}

function smoothTriangle(cycles) {
  const phase = cycles - Math.floor(cycles);
  const linear = Math.abs(phase * 2 - 1);
  const smoothed = linear * linear * (3 - 2 * linear);
  return smoothed * 2 - 1;
}

/**
 * Flag wind, exactly as the vertex shader evaluates it: one travelling wave up
 * the banner with the free edge carrying the most motion. Reduced motion parks
 * the flag (zero amplitude) rather than slowing it — the same rule as `VEG-09`.
 */
export function sampleFlagWave({
  u = 0,
  v = 0,
  timeMilliseconds = 0,
  strength = 1,
  profile = 'low',
  reducedMotion = false,
} = {}, out = {}) {
  const policy = GDO_BREAKABLE_PROFILES[profile] ?? GDO_BREAKABLE_PROFILES.low;
  const clampedU = clamp(u, 0, 1);
  const clampedV = clamp(v, 0, 1);
  const resolvedTime = Number.isFinite(timeMilliseconds) && timeMilliseconds >= 0 ? timeMilliseconds : 0;
  const resolvedStrength = Number.isFinite(strength) ? clamp(strength, 0, 1) : 1;
  if (reducedMotion) { out.x = 0; out.y = 0; out.z = 0; out.sag = 0; return out; }
  const clock = resolvedTime * .001 * policy.flagCyclesPerSecond;
  // The hoist edge (u = 0) is pinned; the fly edge moves most.
  const reach = clampedU * clampedU;
  const wave = smoothTriangle(clock + clampedV * .55 + clampedU * .3);
  const ripple = smoothTriangle(clock * 2.3 + clampedU * 1.7);
  const amplitude = policy.flagAmplitude * resolvedStrength;
  out.x = 0;
  out.y = wave * amplitude * reach * .35;
  out.z = (wave + ripple * .35) * amplitude * reach;
  // A still banner sags; the sag is a declared fraction of its length.
  out.sag = -(amplitude * .5 * (1 - resolvedStrength) * reach) || 0;
  return out;
}

/**
 * The breakables island: a chunk pool, an optional rope, and the flagged
 * archetypes. One object owns all three because they share the row's budget and
 * its deterministic reset.
 */
export function createBreakables({
  profile = 'low',
  seed = 0,
  heightAt = null,
  solidAt = null,
} = {}) {
  const policy = { ...(GDO_BREAKABLE_PROFILES[profile] ?? GDO_BREAKABLE_PROFILES.low) };
  const groundAt = (x, z) => {
    const value = typeof heightAt === 'function' ? Number(heightAt(x, z)) : 0;
    return Number.isFinite(value) ? value : 0;
  };

  /** The pool is allocated once at construction and never resized. */
  const chunks = Array.from({ length: policy.maxChunks }, (_, index) => ({
    id: index,
    active: false,
    archetype: null,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    size: 0,
    age: 0,
    life: 0,
    fade: 0,
    alpha: 0,
  }));
  const ropes = Array.from({ length: policy.maxRopes }, (_, index) => ({
    id: index,
    active: false,
    points: new Float32Array(policy.maxRopePoints * 3),
    previous: new Float32Array(policy.maxRopePoints * 3),
    count: 0,
    length: 0,
  }));

  let nextChunk = 0;
  let activeChunks = 0;
  let breaks = 0, recycled = 0, expired = 0;
  let ropeQueries = 0;
  let steps = 0, lastSteps = 0, accumulator = 0;
  let malformedInputs = 0;
  const refusals = Object.fromEntries(Object.values(GDO_BREAKABLE_REFUSAL).map(key => [key, 0]));

  /**
   * Break one prop into its archetype's declared chunks with **one** outward
   * impulse recipe: horizontal spread around a ring, a little lift, and a
   * per-chunk size/seed jitter. No geometry is fractured and mapped buildings
   * are refused by name.
   */
  function breakProp({ archetype, x = 0, z = 0, y = null, impulse = null, source = 'prop' } = {}) {
    const recipe = GDO_BREAKABLE_ARCHETYPES[archetype];
    if (!recipe) { refusals[GDO_BREAKABLE_REFUSAL.UNKNOWN_ARCHETYPE]++; return { ok: false, refusal: GDO_BREAKABLE_REFUSAL.UNKNOWN_ARCHETYPE }; }
    if (source !== 'prop' && source !== 'feature') {
      // Research §9.8: never fracture mapped building geometry dynamically.
      refusals[GDO_BREAKABLE_REFUSAL.MAPPED_GEOMETRY]++;
      return { ok: false, refusal: GDO_BREAKABLE_REFUSAL.MAPPED_GEOMETRY };
    }
    if (![x, z].every(Number.isFinite)) { refusals[GDO_BREAKABLE_REFUSAL.BAD_INPUT]++; return { ok: false, refusal: GDO_BREAKABLE_REFUSAL.BAD_INPUT }; }
    const count = Math.min(recipe.chunks, policy.maxChunksPerBreak);
    const spawnY = Number.isFinite(y) ? y : groundAt(x, z) + .12;
    const push = Array.isArray(impulse) && impulse.length === 3 && impulse.every(Number.isFinite) ? impulse : [0, 0, 0];
    const spawned = [];
    for (let piece = 0; piece < count; piece++) {
      // Round-robin through the pool; the oldest chunk is the one recycled.
      const chunk = chunks[nextChunk];
      if (chunk.active) recycled++;
      nextChunk = (nextChunk + 1) % policy.maxChunks;
      const angle = (piece / count) * Math.PI * 2 + hashUnit(seed + breaks, `${archetype}:${piece}`) * .4;
      const speed = recipe.spread * (.6 + hashUnit(seed + breaks, `speed:${piece}`) * .8);
      chunk.active = true;
      chunk.archetype = archetype;
      chunk.x = x + Math.cos(angle) * .05;
      chunk.y = spawnY + hashUnit(seed + breaks, `lift:${piece}`) * .06;
      chunk.z = z + Math.sin(angle) * .05;
      chunk.vx = Math.cos(angle) * speed + clamp(push[0], -policy.maxImpulse, policy.maxImpulse) * .5;
      chunk.vy = .5 + hashUnit(seed + breaks, `up:${piece}`) * .7 + clamp(push[1], -policy.maxImpulse, policy.maxImpulse) * .3;
      chunk.vz = Math.sin(angle) * speed + clamp(push[2], -policy.maxImpulse, policy.maxImpulse) * .5;
      chunk.size = .014 + hashUnit(seed + breaks, `size:${piece}`) * .02;
      chunk.age = 0;
      chunk.life = recipe.lifeSeconds;
      chunk.fade = recipe.fadeSeconds;
      chunk.alpha = 1;
      spawned.push(chunk.id);
    }
    activeChunks = chunks.reduce((total, chunk) => total + Number(chunk.active), 0);
    breaks++;
    return { ok: true, chunks: spawned, count: spawned.length, contacts: policy.chunkContacts };
  }

  /** Optional 5–10 point rope: pinned at `from`, hanging to `to`. */
  function createRope({ from, to, points = 7 } = {}) {
    if (!Array.isArray(from) || !Array.isArray(to) || from.length !== 3 || to.length !== 3 ||
        !from.every(Number.isFinite) || !to.every(Number.isFinite)) {
      refusals[GDO_BREAKABLE_REFUSAL.BAD_INPUT]++;
      return { ok: false, refusal: GDO_BREAKABLE_REFUSAL.BAD_INPUT };
    }
    if (!Number.isInteger(points) || points < policy.minRopePoints || points > policy.maxRopePoints) {
      refusals[GDO_BREAKABLE_REFUSAL.ROPE_TOO_LONG]++;
      return { ok: false, refusal: GDO_BREAKABLE_REFUSAL.ROPE_TOO_LONG };
    }
    const rope = ropes.find(item => !item.active);
    if (!rope) { refusals[GDO_BREAKABLE_REFUSAL.ROPE_BUDGET]++; return { ok: false, refusal: GDO_BREAKABLE_REFUSAL.ROPE_BUDGET }; }
    rope.active = true;
    rope.count = points;
    rope.length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    for (let index = 0; index < points; index++) {
      const t = index / (points - 1);
      const offset = index * 3;
      // A declared static sag seeds the shape; the solver then droops it.
      const sag = Math.sin(t * Math.PI) * rope.length * .18;
      rope.points[offset] = from[0] + (to[0] - from[0]) * t;
      rope.points[offset + 1] = from[1] + (to[1] - from[1]) * t - sag;
      rope.points[offset + 2] = from[2] + (to[2] - from[2]) * t;
      rope.previous.set(rope.points.subarray(offset, offset + 3), offset);
    }
    return { ok: true, id: rope.id, points, length: rope.length };
  }

  const segmentLength = rope => (rope.count > 1 ? rope.length / (rope.count - 1) : 0);

  function stepRope(rope, dt) {
    const rest = segmentLength(rope);
    for (let index = 1; index < rope.count; index++) {
      const offset = index * 3;
      const vx = (rope.points[offset] - rope.previous[offset]) * policy.damping;
      const vy = (rope.points[offset + 1] - rope.previous[offset + 1]) * policy.damping;
      const vz = (rope.points[offset + 2] - rope.previous[offset + 2]) * policy.damping;
      rope.previous[offset] = rope.points[offset];
      rope.previous[offset + 1] = rope.points[offset + 1];
      rope.previous[offset + 2] = rope.points[offset + 2];
      rope.points[offset] += vx;
      rope.points[offset + 1] += vy - policy.gravity * dt * dt;
      rope.points[offset + 2] += vz;
    }
    // Distance constraints only: no self-collision, no tearing (research §9.6).
    for (let iteration = 0; iteration < policy.ropeIterations; iteration++) {
      for (let index = 1; index < rope.count; index++) {
        const a = (index - 1) * 3, b = index * 3;
        const dx = rope.points[b] - rope.points[a];
        const dy = rope.points[b + 1] - rope.points[a + 1];
        const dz = rope.points[b + 2] - rope.points[a + 2];
        const length = Math.hypot(dx, dy, dz);
        if (!(length > 1e-9)) continue;
        const correction = (length - rest) / length;
        const weightA = index - 1 === 0 ? 0 : 1; // the first point is pinned
        const total = weightA + 1;
        if (weightA) {
          rope.points[a] += dx * correction / total;
          rope.points[a + 1] += dy * correction / total;
          rope.points[a + 2] += dz * correction / total;
        }
        rope.points[b] -= dx * correction / total;
        rope.points[b + 1] -= dy * correction / total;
        rope.points[b + 2] -= dz * correction / total;
      }
      // Ground contact is positional and only for the free points.
      for (let index = 1; index < rope.count; index++) {
        const offset = index * 3;
        if (ropeQueries >= policy.maxCollisionQueriesPerStep) break;
        ropeQueries++;
        const floor = groundAt(rope.points[offset], rope.points[offset + 2]) + .01;
        if (rope.points[offset + 1] < floor) rope.points[offset + 1] = floor;
      }
    }
  }

  function stepChunks(dt) {
    for (const chunk of chunks) {
      if (!chunk.active) continue;
      chunk.age += dt;
      if (chunk.age >= chunk.life) { chunk.active = false; expired++; continue; }
      chunk.alpha = chunk.age > chunk.life - chunk.fade
        ? clamp((chunk.life - chunk.age) / chunk.fade, 0, 1) : 1;
      chunk.vy -= policy.gravity * dt;
      chunk.x += chunk.vx * dt;
      chunk.y += chunk.vy * dt;
      chunk.z += chunk.vz * dt;
      const floor = groundAt(chunk.x, chunk.z) + chunk.size;
      if (chunk.y <= floor) {
        // Ground only: the floor never hands energy back.
        chunk.y = floor;
        chunk.vy = 0;
        chunk.vx *= policy.groundFriction;
        chunk.vz *= policy.groundFriction;
      }
      // Wall contact only above the low profile, where the research allows it.
      if (policy.chunkContacts === 'ground-and-walls' && typeof solidAt === 'function') {
        if (solidAt(chunk.x, chunk.z, chunk.size)) {
          chunk.vx *= -.25; chunk.vz *= -.25;
          chunk.x -= chunk.vx * dt; chunk.z -= chunk.vz * dt;
        }
      }
    }
    activeChunks = chunks.reduce((total, chunk) => total + Number(chunk.active), 0);
  }

  function update(deltaMilliseconds) {
    lastSteps = 0;
    if (!Number.isFinite(deltaMilliseconds) || deltaMilliseconds < 0) { malformedInputs++; return 0; }
    accumulator += Math.min(deltaMilliseconds * .001, .25);
    while (accumulator >= policy.fixedStepSeconds && lastSteps < policy.maxSubstepsPerFrame) {
      accumulator -= policy.fixedStepSeconds;
      lastSteps++;
      steps++;
      ropeQueries = 0;
      stepChunks(policy.fixedStepSeconds);
      for (const rope of ropes) if (rope.active) stepRope(rope, policy.fixedStepSeconds);
    }
    if (accumulator >= policy.fixedStepSeconds) accumulator %= policy.fixedStepSeconds;
    return lastSteps;
  }

  /** Deterministic reset: every buffer returns to its construction state. */
  function reset() {
    for (const chunk of chunks) {
      chunk.active = false;
      chunk.archetype = null;
      chunk.x = 0; chunk.y = 0; chunk.z = 0;
      chunk.vx = 0; chunk.vy = 0; chunk.vz = 0;
      chunk.size = 0; chunk.age = 0; chunk.life = 0; chunk.fade = 0; chunk.alpha = 0;
    }
    for (const rope of ropes) {
      rope.active = false;
      rope.points.fill(0);
      rope.previous.fill(0);
      rope.count = 0;
      rope.length = 0;
    }
    nextChunk = 0;
    activeChunks = 0;
    breaks = 0;
    recycled = 0;
    expired = 0;
    steps = 0;
    lastSteps = 0;
    accumulator = 0;
    malformedInputs = 0;
    for (const key of Object.keys(refusals)) refusals[key] = 0;
  }

  function flagRibbon({ archetype = 'flag', width = .24, height = .16, segments = policy.flagSegments, timeMilliseconds = 0, strength = 1, reducedMotion = false } = {}) {
    const points = Math.min(policy.maxFlagPoints, Math.max(2, segments | 0));
    const positions = new Float32Array(points * points * 3);
    const wave = {};
    let cursor = 0;
    for (let row = 0; row < points; row++) {
      for (let column = 0; column < points; column++) {
        const u = column / (points - 1), v = row / (points - 1);
        sampleFlagWave({ u, v, timeMilliseconds, strength, profile, reducedMotion }, wave);
        positions[cursor] = (u - 1) * width;
        positions[cursor + 1] = wave.y + wave.sag;
        positions[cursor + 2] = (v - .5) * height + wave.z;
        cursor += 3;
      }
    }
    return Object.freeze({ archetype, points, positions, width, height, reducedMotion: Boolean(reducedMotion) });
  }

  /**
   * A state fingerprint over the live pool. `reset()` must restore this to the
   * freshly constructed value — that is the row's deterministic-reset gate.
   */
  function fingerprint() {
    let hash = 2166136261;
    const update = byte => { hash ^= byte; hash = Math.imul(hash, 16777619); };
    const bytes = new Uint8Array(chunks.length * 7 * 4);
    let cursor = 0;
    const write = value => {
      const buffer = new DataView(bytes.buffer);
      buffer.setFloat32(cursor, Number.isFinite(value) ? value : 0);
      cursor += 4;
    };
    for (const chunk of chunks) {
      write(Number(chunk.active));
      write(chunk.x); write(chunk.y); write(chunk.z);
      write(chunk.age); write(chunk.alpha); write(chunk.size);
    }
    for (let index = 0; index < bytes.length; index++) update(bytes[index]);
    for (const rope of ropes) {
      update(Number(rope.active));
      for (let index = 0; index < rope.points.length; index++) update(Math.round(rope.points[index] * 4096) & 255);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  return Object.freeze({
    namespace: GDO_BREAKABLE_NAMESPACE,
    profile,
    policy,
    breakProp,
    createRope,
    flagRibbon,
    update,
    reset,
    fingerprint,
    chunk: id => chunks[id] ?? null,
    chunks: () => chunks,
    ropes: () => ropes,
    get activeChunks() { return activeChunks; },
    get diagnostics() {
      return Object.freeze({
        namespace: GDO_BREAKABLE_NAMESPACE,
        profile,
        chunks: chunks.length,
        activeChunks,
        maxChunks: policy.maxChunks,
        breaks,
        recycled,
        expired,
        ropes: ropes.reduce((total, rope) => total + Number(rope.active), 0),
        maxRopes: policy.maxRopes,
        maxRopePoints: policy.maxRopePoints,
        ropeIterations: policy.ropeIterations,
        chunkContacts: policy.chunkContacts,
        steps,
        lastSteps,
        malformedInputs,
        refusals: Object.freeze({ ...refusals }),
        // No mesh fracture, no cloth solver, no self-collision, no allocation
        // per step: the pool is fixed at construction.
        fracturedMeshes: 0,
        selfCollisions: 0,
        steadyFrameAllocations: 0,
      });
    },
  });
}
