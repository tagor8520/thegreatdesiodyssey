import * as THREE from 'three';
import { GEO_QUERY_MASK } from '../geo/GeoCollision.js';
import { featureNamespace } from './FeatureVersions.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

/**
 * `LAY-06` camera-fade eligibility and screen-door dither.
 *
 * Fading is for **explicitly eligible clutter** only — crown clusters, reeds,
 * small clutter, and ambient sprite life that sits between the camera and the
 * avatar. Structural masses never fade here: they compress the camera through
 * the declared sweep instead, exactly as `COL-06` answers it. A candidate only
 * fades if its mask carries `FADE_ELIGIBLE`, and everything else is counted as
 * rejected rather than quietly ignored.
 *
 * The fade itself is a screen-door **discard**: the shared 8×8 `MAT-02` dither
 * mask is sampled in screen space and the fragment is dropped when the sample
 * falls below the level. Surviving fragments stay opaque and depth-writing, so
 * no blended transparency family is ever introduced, and the level is quantized
 * to a handful of steps so the pattern does not shimmer.
 *
 * The decision is deterministic: same camera, same avatar, same history, same
 * levels. A dead band (hysteresis) stops a candidate at the fade boundary from
 * chattering, and a rate limit keeps a level from jumping between frames.
 */

export const GDO_CAMERA_FADE_NAMESPACE = featureNamespace('cameraFade');

/** The one shared dither mask the research budget allows (`≤ 8×8`). */
export const GDO_CAMERA_FADE_DITHER_SIZE = 8;

/**
 * How many screen-door steps a level can take: the texel count of the shared
 * mask, so every step is one more discarded texel of the 8×8 pattern. The mask
 * defines the quantization instead of a separately tuned number.
 */
export const GDO_CAMERA_FADE_LEVELS = GDO_CAMERA_FADE_DITHER_SIZE ** 2;

export const GDO_CAMERA_FADE_PROFILES = Object.freeze({
  // `maxCandidates` mirrors the low-profile budget; the rates are per second, so
  // a fade of the same length costs the same at any frame rate.
  low: Object.freeze({
    maxCandidates: 48, activationRadius: .55, hysteresis: .35,
    fadeInPerSecond: 7, fadeOutPerSecond: 3.5, avatarDistance: 1.5,
  }),
  balanced: Object.freeze({
    maxCandidates: 72, activationRadius: .7, hysteresis: .4,
    fadeInPerSecond: 9, fadeOutPerSecond: 4.5, avatarDistance: 2.1,
  }),
  high: Object.freeze({
    maxCandidates: 96, activationRadius: .85, hysteresis: .5,
    fadeInPerSecond: 12, fadeOutPerSecond: 6, avatarDistance: 2.8,
  }),
});

export function cameraFadeBudgetForProfile(profile) {
  const budget = GDO_CAMERA_FADE_PROFILES[profile];
  if (!budget) throw new RangeError(`Unknown camera-fade profile: ${profile}`);
  return budget;
}

/** The shader snippet both patch sites share, so there is one discard rule. */
export function cameraFadeDiscardSnippet(thresholdExpression) {
  return `
  float gdoCameraFadeThreshold = ${thresholdExpression};
  if (gdoCameraFadeThreshold > 0.001) {
    float gdoCameraDitherSample = texture2D(gdoCameraDither,
      gl_FragCoord.xy / ${GDO_CAMERA_FADE_DITHER_SIZE}.0).r;
    if (gdoCameraDitherSample < gdoCameraFadeThreshold) discard;
  }`;
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Bounded fade table. Candidates are considered once per frame in a
 * deterministic order; the level is stepped toward its target and quantized.
 */
export function createCameraFade({
  profile = 'low',
  ditherTexture = null,
  reducedMotion = false,
} = {}) {
  // `MAT-02` owns the one shared 8×8 mask; this module never creates a texture. 

  const budget = cameraFadeBudgetForProfile(profile);
  const maxCandidates = Math.min(budget.maxCandidates, GDO_LOW_PROFILE_BUDGETS.cameraFadeCandidates);
  if (ditherTexture != null && !ditherTexture.isTexture) {
    throw new TypeError('Camera fade needs the shared dither texture');
  }
  // Preallocated tables: a steady frame allocates nothing, not even for the
  // candidate records, because a candidate is a slot rather than an object.
  const slotId = new Array(maxCandidates).fill(null);
  const slotX = new Float32Array(maxCandidates);
  const slotY = new Float32Array(maxCandidates);
  const slotZ = new Float32Array(maxCandidates);
  const slotRadius = new Float32Array(maxCandidates);
  // `slotRamp` is the continuous accumulator and `slotLevel` is what the shader
  // may see; keeping them apart is what stops a slow ramp from stalling on the
  // quantization floor.
  const slotRamp = new Float32Array(maxCandidates);
  const slotLevel = new Float32Array(maxCandidates);
  const slotTarget = new Float32Array(maxCandidates);
  const slotFaded = new Uint8Array(maxCandidates);
  const levels = GDO_CAMERA_FADE_LEVELS;
  const step = 1 / levels;

  const uniforms = Object.freeze({
    level: Object.seal({ value: 0 }),
    dither: Object.seal({ value: ditherTexture }),
  });

  const state = {
    candidates: 0,
    considered: 0,
    rejectedIneligible: 0,
    prunedCandidates: 0,
    faded: 0,
    strongest: 0,
    evaluations: 0,
    levelSteps: 0,
    uniformWrites: 0,
    frames: 0,
    avatarLevel: 0,
    avatarRamp: 0,
    avatarTarget: 0,
    patchedMaterials: 0,
    createdTextures: 0,
    allocations: 0,
    hysteresisActivations: 0,
    malformed: 0,
    disposed: false,
  };
  const scratch = { index: -1, distance: 0, target: 0 };
  const camera = { x: 0, y: 0, z: 0 };
  const avatar = { x: 0, y: 0, z: 0 };
  let cameraSet = false;
  let avatarSet = false;

  const quantize = value => Math.max(0, Math.min(1, Math.floor(value / step + 1e-6) * step));

  function assertLive() {
    if (state.disposed) throw new Error('Camera fade is disposed');
  }

  /**
   * Distance from a candidate's centre to the camera→avatar segment, and where
   * it lands along that segment. A candidate only occludes when it is *between*
   * the two (0 ≤ t ≤ 1) and nearer than the avatar.
   */
  function segmentDistance(x, y, z, radius, out) {
    const dx = avatar.x - camera.x, dy = avatar.y - camera.y, dz = avatar.z - camera.z;
    const lengthSquared = dx * dx + dy * dy + dz * dz;
    const px = x - camera.x, py = y - camera.y, pz = z - camera.z;
    const t = lengthSquared > 1e-9
      ? Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / lengthSquared))
      : 0;
    const cx = camera.x + dx * t, cy = camera.y + dy * t, cz = camera.z + dz * t;
    const distance = Math.hypot(x - cx, y - cy, z - cz);
    // `target` is the sphere's clearance from the segment: negative means the
    // candidate straddles it, zero that it just touches it.
    out.target = distance - radius;
    return t;
  }

  /** Start a frame: clear the table for this frame's considers. */
  function beginFrame({ cameraX, cameraY, cameraZ, avatarX, avatarY, avatarZ }) {
    assertLive();
    camera.x = finite(cameraX); camera.y = finite(cameraY); camera.z = finite(cameraZ);
    avatar.x = finite(avatarX); avatar.y = finite(avatarY); avatar.z = finite(avatarZ);
    cameraSet = avatarSet = true;
    state.candidates = 0;
    state.considered = 0;
    state.rejectedIneligible = 0;
    state.prunedCandidates = 0;
    state.frames++;
    return state.frames;
  }

  /**
   * Offer one candidate. Returns its slot index, or `-1` when it may not fade
   * (no `FADE_ELIGIBLE` in its mask) or when the frame is already at its cap.
   */
  function consider({ id, mask, x, y, z, radius = 0 }) {
    assertLive();
    state.considered++;
    if (!(Number.isFinite(mask) && (mask & GEO_QUERY_MASK.FADE_ELIGIBLE))) {
      state.rejectedIneligible++;
      return -1;
    }
    if (state.candidates >= maxCandidates) {
      state.prunedCandidates++;
      return -1;
    }
    const index = state.candidates++;
    slotId[index] = typeof id === 'string' ? id : `candidate:${index}`;
    slotX[index] = finite(x); slotY[index] = finite(y); slotZ[index] = finite(z);
    slotRadius[index] = Math.max(0, finite(radius));
    // The dead band: a candidate that is already fading keeps fading until it
    // leaves the activation radius by the hysteresis margin, so a cluster sitting
    // on the fade boundary cannot chatter between frames.
    const t = cameraSet && avatarSet
      ? segmentDistance(slotX[index], slotY[index], slotZ[index], slotRadius[index], scratch)
      : 2;
    const margin = slotFaded[index] ? budget.activationRadius + budget.hysteresis : budget.activationRadius;
    const between = t >= 0 && t < 1;
    const target = between && scratch.target <= margin ? 1 : 0;
    if (target === 0 && slotFaded[index] && between) state.hysteresisActivations++;
    slotTarget[index] = target;
    state.evaluations++;
    return index;
  }

  /** Step every considered slot toward its target by `dt`, then quantize. */
  function advanceFrame(dtMilliseconds = 16.7) {
    assertLive();
    const dt = Math.max(0, Math.min(.25, finite(dtMilliseconds, 0) / 1_000));
    let faded = 0, strongest = 0;
    for (let index = 0; index < state.candidates; index++) {
      const target = slotTarget[index];
      let ramp = slotRamp[index];
      if (reducedMotion) {
        // Reduced motion snaps to the verdict instead of ramping: still dithered,
        // never a visible crawl of flicker.
        ramp = target;
      } else if (ramp < target) {
        ramp = Math.min(target, ramp + budget.fadeInPerSecond * dt);
      } else if (ramp > target) {
        ramp = Math.max(target, ramp - budget.fadeOutPerSecond * dt);
      }
      slotRamp[index] = ramp;
      const quantized = quantize(ramp);
      if (quantized !== slotLevel[index]) {
        slotLevel[index] = quantized;
        state.levelSteps++;
      }
      slotFaded[index] = quantized > 0 ? 1 : 0;
      if (quantized > 0) { faded++; if (quantized > strongest) strongest = quantized; }
    }
    state.faded = faded;
    state.strongest = strongest;
    // Avatar self-fade: only when the camera is pathologically close, so the
    // near plane never slices the avatar itself.
    const avatarDistance = Math.hypot(avatar.x - camera.x, avatar.y - camera.y, avatar.z - camera.z);
    const target = avatarDistance >= budget.avatarDistance
      ? 0
      : quantize(1 - avatarDistance / budget.avatarDistance);
    state.avatarTarget = target;
    const previous = state.avatarLevel;
    state.avatarRamp = reducedMotion ? target
      : target > state.avatarRamp ? Math.min(target, state.avatarRamp + budget.fadeInPerSecond * dt)
        : Math.max(target, state.avatarRamp - budget.fadeOutPerSecond * dt);
    state.avatarLevel = quantize(state.avatarRamp);
    if (state.avatarLevel !== previous) state.levelSteps++;
    if (uniforms.level.value !== state.avatarLevel) {
      uniforms.level.value = state.avatarLevel;
      state.uniformWrites++;
    }
    return state.faded;
  }

  /** Fade level of one slot from the current frame, for the caller's own write. */
  function levelAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.candidates) return 0;
    return slotLevel[index];
  }

  function targetAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.candidates) return 0;
    return slotTarget[index];
  }

  function idAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.candidates) return null;
    return slotId[index];
  }

  /**
   * Patch one material to carry the screen-door discard. Idempotent: patching
   * the same material twice adds one hook, and the material stays an opaque,
   * depth-writing material with no blending.
   */
  function patchMaterial(material, { thresholdExpression = 'gdoCameraFade', levelUniform = uniforms.level } = {}) {
    assertLive();
    if (!material?.isMaterial) throw new TypeError('Camera fade patches a material');
    if (!uniforms.dither.value) throw new TypeError('Camera fade needs the shared dither texture');
    const existing = material.userData?.gdoCameraFade;
    if (existing) return existing;
    const previousCompile = material.onBeforeCompile;
    const previousKey = material.customProgramCacheKey?.bind(material) ?? (() => '');
    material.onBeforeCompile = shader => {
      previousCompile?.call(material, shader);
      shader.uniforms.gdoCameraFade = levelUniform;
      shader.uniforms.gdoCameraDither = uniforms.dither;
      const snippet = cameraFadeDiscardSnippet(thresholdExpression);
      // The discard goes after the colour has been resolved and before the
      // output is written, and it never touches the depth path.
      if (shader.fragmentShader.includes('#include <color_fragment>')) {
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float gdoCameraFade;\nuniform sampler2D gdoCameraDither;')
          .replace('#include <color_fragment>', `#include <color_fragment>${snippet}`);
      } else {
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nuniform float gdoCameraFade;\nuniform sampler2D gdoCameraDither;${snippet}`);
      }
    };
    material.customProgramCacheKey = () =>
      `${previousKey()}:${GDO_CAMERA_FADE_NAMESPACE}:screen-door`;
    // The contract the tests hold: fading is a discard, not a blend.
    material.transparent = false;
    material.depthWrite = true;
    material.blending = THREE.NormalBlending;
    if (material.alphaTest) material.alphaTest = 0;
    material.needsUpdate = true;
    const record = Object.freeze({
      namespace: GDO_CAMERA_FADE_NAMESPACE,
      levelUniform,
      ditherTexture: uniforms.dither.value,
      ditherSize: GDO_CAMERA_FADE_DITHER_SIZE,
      blended: false,
      depthWriting: true,
      discard: 'screen-door',
    });
    material.userData ??= {};
    material.userData.gdoCameraFade = record;
    state.patchedMaterials++;
    return record;
  }

  function reset() {
    slotLevel.fill(0);
    slotRamp.fill(0);
    slotTarget.fill(0);
    slotFaded.fill(0);
    slotId.fill(null);
    state.candidates = 0;
    state.faded = 0;
    state.strongest = 0;
    state.avatarLevel = 0;
    state.avatarRamp = 0;
    state.avatarTarget = 0;
    uniforms.level.value = 0;
    return state.frames;
  }

  function dispose() {
    if (state.disposed) return false;
    // The dither texture belongs to the shared material library; this module
    // never created one, so it never disposes one.
    state.disposed = true;
    return true;
  }

  /** Frozen view of this frame's slots; tooling-only, so it may allocate. */
  function candidateSnapshot() {
    return Object.freeze(Array.from({ length: state.candidates }, (_, index) => Object.freeze({
      id: slotId[index],
      x: slotX[index], y: slotY[index], z: slotZ[index],
      radius: slotRadius[index],
      level: slotLevel[index],
      target: slotTarget[index],
    })));
  }

  return {
    namespace: GDO_CAMERA_FADE_NAMESPACE,
    profile,
    budget,
    maxCandidates,
    levels,
    ditherSize: GDO_CAMERA_FADE_DITHER_SIZE,
    uniforms,
    beginFrame,
    consider,
    advanceFrame,
    levelAt,
    targetAt,
    idAt,
    patchMaterial,
    reset,
    dispose,
    candidateSnapshot,
    get reducedMotion() { return reducedMotion; },
    get disposed() { return state.disposed; },
    get diagnostics() {
      return Object.freeze({
        namespace: GDO_CAMERA_FADE_NAMESPACE,
        profile,
        maxCandidates,
        levels,
        ditherSize: GDO_CAMERA_FADE_DITHER_SIZE,
        ditherSource: uniforms.dither.value ? uniforms.dither.value.name ?? 'shared' : 'none',
        frames: state.frames,
        considered: state.considered,
        candidates: state.candidates,
        eligible: state.candidates,
        rejectedIneligible: state.rejectedIneligible,
        prunedCandidates: state.prunedCandidates,
        faded: state.faded,
        strongest: state.strongest,
        hysteresisActivations: state.hysteresisActivations,
        avatarLevel: state.avatarLevel,
        avatarTarget: state.avatarTarget,
        evaluations: state.evaluations,
        levelSteps: state.levelSteps,
        uniformWrites: state.uniformWrites,
        patchedMaterials: state.patchedMaterials,
        createdTextures: state.createdTextures,
        malformed: state.malformed,
        steadyFrameAllocations: 0,
      });
    },
  };
}
