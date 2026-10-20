/**
 * `ENV-07` — the optional AO / contact-depth **benchmark** (`gdo:ambientOcclusion:v1`).
 *
 * The row is a decision, not a feature: its gate is "only if the low/balanced GPU
 * budget proves value". So this module does two things and keeps them apart.
 *
 * 1. **It prices the candidates deterministically.** Screen-space AO is priced by
 *    arithmetic every driver agrees on — pixels, full-screen passes, samples per
 *    pixel, sampled bytes, render-target bytes — not by one machine's wall clock.
 *    The two cheap substitutes are priced the same way: instanced contact anchors
 *    (overdraw and one draw call) and baked per-vertex occlusion (one byte per
 *    vertex, zero runtime work). The research is unambiguous that SSAO is "not
 *    default; likely omit" (§8.1) and that contact anchoring is the P0 answer, so
 *    the benchmark has to be able to *disagree* with that recommendation — and say
 *    why when it does not.
 *
 * 2. **It measures value as grounding coverage**, not as taste. A strategy is worth
 *    its cost only if it grounds scene weight that nothing cheaper already grounds:
 *    props (weighted highest — an unanchored crate floats), facades, and the
 *    terrain band around large buildings. Coverage is a declared weighting of what
 *    is grounded, so the comparison is reproducible; the *weights* are a design
 *    input, and they are exported so a future row can re-run the decision with
 *    different ones instead of arguing with a number hidden in the code.
 *
 * `createContactAnchors()` is the mechanism the benchmark most often picks: one
 * pooled instanced draw of flattened dark ellipses under grounded props. It is
 * real, not a stub — the world mounts it and the anchors are what a renderer
 * draws. `bakeContactOcclusion()` is the other cheap half, a pure function over
 * generated geometry that darkens wall bottoms into a per-vertex byte.
 */

import { featureNamespace } from './FeatureVersions.js';

export const GDO_AO_NAMESPACE = featureNamespace('ambientOcclusion');

export const GDO_AO_STRATEGY = Object.freeze({
  NONE: 'none',
  CONTACT_ANCHORS: 'contact-anchors',
  VERTEX_BAKE: 'vertex-bake',
  SCREEN_SPACE: 'screen-space',
});

export const GDO_AO_REFUSAL = Object.freeze({
  BAD_INPUT: 'bad-input',
  UNKNOWN_STRATEGY: 'unknown-strategy',
  POOL_FULL: 'pool-full',
  OUT_OF_RANGE: 'out-of-range',
  DISPOSED: 'disposed',
});

/** Why the benchmark landed where it did. Every decision carries one. */
export const GDO_AO_REASON = Object.freeze({
  NOTHING_TO_GROUND: 'nothing-to-ground',
  PROFILE_FORBIDS_PASS: 'profile-forbids-full-screen-pass',
  DID_NOT_EARN_A_PASS: 'did-not-earn-a-pass',
  EARNED_A_PASS: 'earned-a-pass',
  RENDER_TARGET_BUDGET: 'render-target-budget',
  DRAW_CALL_BUDGET: 'draw-call-budget',
  CHEAPEST_AT_FULL_COVERAGE: 'cheapest-at-full-coverage',
  CHEAPEST_AVAILABLE: 'cheapest-available',
});

/**
 * Per-profile hard ceilings and declared constants. The two constants that make
 * the low/balanced answer non-negotiable are `maxFullScreenPasses: 0` and
 * `maxRenderTargetBytes: 0`: those profiles never allocate a composer target, so
 * screen-space AO is refused by the budget before any value comparison happens.
 */
export const GDO_AO_PROFILES = Object.freeze({
  low: Object.freeze({
    maxFullScreenPasses: 0,
    maxRenderTargetBytes: 0,
    maxAddedDrawCalls: 1,
    maxBakedBytesPerTile: 8 * 1024,
    maxAnchorInstances: 128,
    anchorBytesPerInstance: 32,
    anchorFootprintMetres: .45,
    anchorFootprintMin: .12,
    anchorFootprintMax: 1.6,
    anchorScaleX: 1.35,
    anchorScaleZ: .82,
    anchorLiftMetres: .012,
    anchorFadeStartMetres: 26,
    anchorFadeEndMetres: 44,
    vertexOcclusionHeightMetres: 1.4,
    vertexOcclusionStrength: .45,
    vertexOcclusionCornerBoost: .3,
    // Screen-space constants are still declared — a profile that refuses the
    // technique must still be able to price it, or the refusal is unfalsifiable.
    ssaoPasses: 4,
    ssaoSamplesPerPixel: 16,
    ssaoSampleBytes: 12,
    ssaoRenderTargetBytesPerPixel: 24,
    // A screen-space pass must beat the best cheap package by this much coverage
    // before it is recommended at all (research §8.1: "not default; likely omit").
    screenSpaceValueMargin: .15,
    defaultPixelRatio: .85,
    pixelsPerMetre: 21,
  }),
  balanced: Object.freeze({
    maxFullScreenPasses: 0,
    maxRenderTargetBytes: 0,
    maxAddedDrawCalls: 2,
    maxBakedBytesPerTile: 16 * 1024,
    maxAnchorInstances: 192,
    anchorBytesPerInstance: 32,
    anchorFootprintMetres: .5,
    anchorFootprintMin: .12,
    anchorFootprintMax: 1.8,
    anchorScaleX: 1.35,
    anchorScaleZ: .82,
    anchorLiftMetres: .012,
    anchorFadeStartMetres: 34,
    anchorFadeEndMetres: 58,
    vertexOcclusionHeightMetres: 1.5,
    vertexOcclusionStrength: .45,
    vertexOcclusionCornerBoost: .3,
    ssaoPasses: 4,
    ssaoSamplesPerPixel: 16,
    ssaoSampleBytes: 12,
    ssaoRenderTargetBytesPerPixel: 24,
    screenSpaceValueMargin: .15,
    defaultPixelRatio: 1.1,
    pixelsPerMetre: 28,
  }),
  high: Object.freeze({
    // High may genuinely buy a pass: the ceiling is the real cost of a
    // normal/depth prepass plus an AO target at 1.5x pixel ratio, not a token.
    maxFullScreenPasses: 4,
    maxRenderTargetBytes: 192 * 1024 * 1024,
    maxAddedDrawCalls: 2,
    maxBakedBytesPerTile: 16 * 1024,
    maxAnchorInstances: 320,
    anchorBytesPerInstance: 32,
    anchorFootprintMetres: .55,
    anchorFootprintMin: .12,
    anchorFootprintMax: 2,
    anchorScaleX: 1.35,
    anchorScaleZ: .82,
    anchorLiftMetres: .012,
    anchorFadeStartMetres: 60,
    anchorFadeEndMetres: 110,
    vertexOcclusionHeightMetres: 1.6,
    vertexOcclusionStrength: .45,
    vertexOcclusionCornerBoost: .3,
    ssaoPasses: 4,
    ssaoSamplesPerPixel: 16,
    ssaoSampleBytes: 12,
    ssaoRenderTargetBytesPerPixel: 24,
    screenSpaceValueMargin: .15,
    defaultPixelRatio: 1.5,
    pixelsPerMetre: 36,
  }),
});

/** Scene-category weights: what grounding is worth, per art direction. */
export const GDO_AO_CATEGORY_WEIGHTS = Object.freeze({ prop: 3, facade: 2, terrain: 1 });

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function policyFor(profile) {
  return GDO_AO_PROFILES[profile] ?? GDO_AO_PROFILES.low;
}

function resolvedViewport(profile, viewport = {}) {
  const policy = policyFor(profile);
  const width = Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : 1280;
  const height = Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : 720;
  const pixelRatio = Number.isFinite(viewport.pixelRatio) && viewport.pixelRatio > 0
    ? viewport.pixelRatio : policy.defaultPixelRatio;
  const pixels = Math.round(width * pixelRatio) * Math.round(height * pixelRatio);
  return { width, height, pixelRatio, pixels };
}

function resolvedScene(scene = {}) {
  const count = value => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  const props = count(scene.props);
  // Props that rest on another prop (or against a wall) have no ground under them
  // to anchor to: depth-aware contact is the only thing that can ground them.
  const stackedProps = Math.min(props, count(scene.stackedProps));
  return { props, stackedProps, facades: count(scene.facades), terrain: count(scene.terrain), vertices: count(scene.vertices) };
}

function sceneWeights(scene, weights = GDO_AO_CATEGORY_WEIGHTS) {
  const prop = scene.props * weights.prop;
  const facade = scene.facades * weights.facade;
  const terrain = scene.terrain * weights.terrain;
  return { prop, facade, terrain, total: prop + facade + terrain };
}

/**
 * Screen-space AO, priced: the normal/depth prepass, the AO gather, the blur, and
 * the composite. Only the gather samples, and only it reads depth + normals —
 * the two facts that dominate the cost and that a "passes are cheap" argument
 * always skips.
 */
export function estimateScreenSpaceCost({ profile = 'low', viewport = {} } = {}) {
  const policy = policyFor(profile);
  const resolved = resolvedViewport(profile, viewport);
  const fullScreenPasses = policy.ssaoPasses;
  const textureSamples = resolved.pixels * policy.ssaoSamplesPerPixel;
  const sampleBytes = textureSamples * policy.ssaoSampleBytes;
  const renderTargetBytes = resolved.pixels * policy.ssaoRenderTargetBytesPerPixel;
  return Object.freeze({
    strategy: GDO_AO_STRATEGY.SCREEN_SPACE,
    pixels: resolved.pixels,
    fullScreenPasses,
    samplesPerPixel: policy.ssaoSamplesPerPixel,
    textureSamples,
    sampleBytes,
    renderTargetBytes,
    addedDrawCalls: fullScreenPasses,
    // The gather is the term that scales with resolution and sample count; it is
    // the unit every strategy below is compared in.
    costUnits: textureSamples,
  });
}

/** Contact anchors, priced: one instanced draw and the overdraw of its ellipses. */
export function estimateContactAnchorCost({ profile = 'low', props = 0, viewport = {} } = {}) {
  const policy = policyFor(profile);
  const resolved = resolvedViewport(profile, viewport);
  const instances = Math.min(policy.maxAnchorInstances, Math.max(0, Math.floor(props)));
  const radiusX = policy.anchorFootprintMetres * policy.anchorScaleX * policy.pixelsPerMetre;
  const radiusZ = policy.anchorFootprintMetres * policy.anchorScaleZ * policy.pixelsPerMetre;
  // Ellipse area in pixels; a grounding ellipse is partly hidden under its prop,
  // so the declared visible share is a third of it.
  const visibleShare = .34;
  const overdrawSamples = Math.round(instances * Math.PI * radiusX * radiusZ * visibleShare);
  return Object.freeze({
    strategy: GDO_AO_STRATEGY.CONTACT_ANCHORS,
    instances,
    triangles: instances * 2,
    fullScreenPasses: 0,
    renderTargetBytes: 0,
    addedDrawCalls: 1,
    sampleBytes: 0,
    bytes: policy.maxAnchorInstances * policy.anchorBytesPerInstance,
    overdrawSamples,
    costUnits: overdrawSamples,
  });
}

/** Baked per-vertex occlusion, priced: one byte per vertex, nothing per frame. */
export function estimateVertexBakeCost({ profile = 'low', vertices = 0 } = {}) {
  const policy = policyFor(profile);
  const baked = Math.min(policy.maxBakedBytesPerTile, Math.max(0, Math.floor(vertices)));
  return Object.freeze({
    strategy: GDO_AO_STRATEGY.VERTEX_BAKE,
    vertices: baked,
    fullScreenPasses: 0,
    renderTargetBytes: 0,
    addedDrawCalls: 0,
    sampleBytes: 0,
    // One byte per vertex, written once at generation time.
    bytes: baked,
    overdrawSamples: 0,
    costUnits: 0,
  });
}

function costFor(strategy, { profile, scene, viewport }) {
  if (strategy === GDO_AO_STRATEGY.CONTACT_ANCHORS) return estimateContactAnchorCost({ profile, props: scene.props, viewport });
  if (strategy === GDO_AO_STRATEGY.VERTEX_BAKE) return estimateVertexBakeCost({ profile, vertices: scene.vertices });
  if (strategy === GDO_AO_STRATEGY.SCREEN_SPACE) return estimateScreenSpaceCost({ profile, viewport });
  return Object.freeze({
    strategy: GDO_AO_STRATEGY.NONE,
    fullScreenPasses: 0, renderTargetBytes: 0, addedDrawCalls: 0,
    sampleBytes: 0, bytes: 0, overdrawSamples: 0, costUnits: 0,
  });
}

/**
 * Grounding coverage: how much of the scene's declared weight a strategy actually
 * grounds. Anchors ground *props*, and only as many as their pool holds. The bake
 * grounds facades and the terrain band beside large buildings. Screen-space AO
 * grounds everything, including prop-on-prop contact, which is the only thing it
 * can do that the cheap pair cannot.
 */
function coverageFor(strategies, { profile, scene, weights }) {
  const policy = policyFor(profile);
  const resolvedWeights = sceneWeights(scene, weights);
  if (!resolvedWeights.total) {
    return { coverage: 0, grounded: 0, total: 0, categories: Object.freeze({ prop: 0, facade: 0, terrain: 0 }) };
  }
  const grounded = { prop: 0, facade: 0, terrain: 0 };
  if (strategies.includes(GDO_AO_STRATEGY.SCREEN_SPACE)) {
    grounded.prop = resolvedWeights.prop;
    grounded.facade = resolvedWeights.facade;
    grounded.terrain = resolvedWeights.terrain;
  } else {
    if (strategies.includes(GDO_AO_STRATEGY.CONTACT_ANCHORS) && scene.props) {
      // An anchor needs ground under the prop, and the pool has to hold it.
      const anchored = Math.min(policy.maxAnchorInstances, scene.props - scene.stackedProps);
      grounded.prop = resolvedWeights.prop * (anchored / scene.props);
    }
    if (strategies.includes(GDO_AO_STRATEGY.VERTEX_BAKE)) {
      grounded.facade = resolvedWeights.facade;
      grounded.terrain = resolvedWeights.terrain;
    }
  }
  const total = grounded.prop + grounded.facade + grounded.terrain;
  return {
    coverage: total / resolvedWeights.total,
    grounded: total,
    total: resolvedWeights.total,
    categories: Object.freeze({ prop: grounded.prop, facade: grounded.facade, terrain: grounded.terrain }),
  };
}

function budgetFor(profile) {
  const policy = policyFor(profile);
  return Object.freeze({
    maxFullScreenPasses: policy.maxFullScreenPasses,
    maxRenderTargetBytes: policy.maxRenderTargetBytes,
    maxAddedDrawCalls: policy.maxAddedDrawCalls,
    maxAnchorInstances: policy.maxAnchorInstances,
    screenSpaceValueMargin: policy.screenSpaceValueMargin,
  });
}

const PACKAGES = Object.freeze([
  Object.freeze([GDO_AO_STRATEGY.NONE]),
  Object.freeze([GDO_AO_STRATEGY.CONTACT_ANCHORS]),
  Object.freeze([GDO_AO_STRATEGY.VERTEX_BAKE]),
  Object.freeze([GDO_AO_STRATEGY.CONTACT_ANCHORS, GDO_AO_STRATEGY.VERTEX_BAKE]),
  Object.freeze([GDO_AO_STRATEGY.SCREEN_SPACE]),
]);

/**
 * The benchmark. Deterministic: the same profile, viewport, and scene produce the
 * same record on every machine, because every number is arithmetic over declared
 * inputs rather than a stopwatch. `timing` is deliberately absent — this row's
 * question is "does it fit the budget and earn its coverage", and both answers are
 * exact.
 */
export function benchmarkAmbientOcclusion({
  profile = 'low',
  viewport = {},
  scene = {},
  weights = GDO_AO_CATEGORY_WEIGHTS,
} = {}) {
  const policy = policyFor(profile);
  const resolved = resolvedViewport(profile, viewport);
  const counts = resolvedScene(scene);
  const budget = budgetFor(profile);

  const candidates = PACKAGES.map(strategies => {
    const costs = strategies.map(strategy => costFor(strategy, { profile, scene: counts, viewport }));
    const cost = {
      fullScreenPasses: costs.reduce((total, item) => total + item.fullScreenPasses, 0),
      renderTargetBytes: costs.reduce((total, item) => total + item.renderTargetBytes, 0),
      addedDrawCalls: costs.reduce((total, item) => total + item.addedDrawCalls, 0),
      sampleBytes: costs.reduce((total, item) => total + item.sampleBytes, 0),
      bytes: costs.reduce((total, item) => total + item.bytes, 0),
      overdrawSamples: costs.reduce((total, item) => total + item.overdrawSamples, 0),
      costUnits: costs.reduce((total, item) => total + item.costUnits, 0),
    };
    const coverage = coverageFor(strategies, { profile, scene: counts, weights });
    const needsScreenSpace = strategies.includes(GDO_AO_STRATEGY.SCREEN_SPACE);
    // A screen-space package is judged by its passes and its render targets; its
    // draw calls *are* those passes, so charging it twice would refuse it for the
    // wrong reason. The cheap packages are judged by draw calls.
    const passBudgetExceeded = cost.fullScreenPasses > budget.maxFullScreenPasses;
    const targetBudgetExceeded = cost.renderTargetBytes > budget.maxRenderTargetBytes;
    const drawBudgetExceeded = !needsScreenSpace && cost.addedDrawCalls > budget.maxAddedDrawCalls;
    const fitsBudget = !passBudgetExceeded && !targetBudgetExceeded && !drawBudgetExceeded;
    return Object.freeze({
      package: Object.freeze([...strategies]),
      needsScreenSpace,
      fitsBudget,
      refusal: fitsBudget ? null
        : (passBudgetExceeded ? GDO_AO_REASON.PROFILE_FORBIDS_PASS
          : targetBudgetExceeded ? GDO_AO_REASON.RENDER_TARGET_BUDGET : GDO_AO_REASON.DRAW_CALL_BUDGET),
      cost: Object.freeze(cost),
      ...coverage,
    });
  });

  const eligible = candidates.filter(candidate => candidate.fitsBudget && candidate.coverage > 0);
  let decision;
  if (!eligible.length) {
    decision = Object.freeze({
      profile,
      package: Object.freeze([]),
      coverage: 0,
      costUnits: 0,
      reason: GDO_AO_REASON.NOTHING_TO_GROUND,
      screenSpaceEarned: false,
    });
  } else {
    const bestCoverage = eligible.reduce((best, candidate) => Math.max(best, candidate.coverage), 0);
    const atBest = eligible.filter(candidate => candidate.coverage === bestCoverage)
      .sort((a, b) => a.cost.costUnits - b.cost.costUnits || a.cost.bytes - b.cost.bytes);
    let chosen = atBest[0];
    let reason = bestCoverage >= 1 ? GDO_AO_REASON.CHEAPEST_AT_FULL_COVERAGE : GDO_AO_REASON.CHEAPEST_AVAILABLE;
    let screenSpaceEarned = false;
    if (chosen.needsScreenSpace) {
      const cheap = eligible.filter(candidate => !candidate.needsScreenSpace)
        .sort((a, b) => b.coverage - a.coverage || a.cost.costUnits - b.cost.costUnits)[0];
      const margin = cheap ? bestCoverage - cheap.coverage : 1;
      // The research's "likely omit" is a rule here, not a preference: the pass
      // must beat the cheap package by the declared margin, or it is declined.
      if (margin >= policy.screenSpaceValueMargin) {
        screenSpaceEarned = true;
        reason = GDO_AO_REASON.EARNED_A_PASS;
      } else if (cheap) {
        chosen = cheap;
        reason = GDO_AO_REASON.DID_NOT_EARN_A_PASS;
      }
    }
    decision = Object.freeze({
      profile,
      package: chosen.package,
      coverage: chosen.coverage,
      costUnits: chosen.cost.costUnits,
      reason,
      screenSpaceEarned,
      screenSpaceAllowed: budget.maxFullScreenPasses > 0,
    });
  }

  const refusedPackages = candidates.filter(candidate => !candidate.fitsBudget);
  return Object.freeze({
    namespace: GDO_AO_NAMESPACE,
    profile,
    viewport: Object.freeze(resolved),
    scene: Object.freeze(counts),
    weights: Object.freeze({ ...weights }),
    budget,
    candidates: Object.freeze(candidates),
    decision,
    // Named so a later row can cite what this was compared against rather than an
    // absolute claim about AO being "expensive".
    baseline: 'gdo:plantRender:v1',
    refusedPackages: Object.freeze(refusedPackages.map(candidate => Object.freeze({
      package: candidate.package,
      reason: candidate.refusal,
      fullScreenPasses: candidate.cost.fullScreenPasses,
      renderTargetBytes: candidate.cost.renderTargetBytes,
    }))),
    // No clock, no sampling, no calibration: the benchmark is arithmetic.
    timing: null,
    deterministic: true,
  });
}

/**
 * The shipped mechanism: one pooled instanced draw of flattened grounding ellipses.
 * Allocation happens once, at construction; a frame only writes into the pool.
 */
export function createContactAnchors({ profile = 'low' } = {}) {
  const policy = policyFor(profile);
  const stride = 8; // x, y, z, radiusX, radiusZ, strength, alpha, dither phase
  const buffer = new Float32Array(policy.maxAnchorInstances * stride);
  let count = 0;
  let cameraX = 0, cameraZ = 0;
  let disposed = false;
  let written = 0, culled = 0;
  const refusals = Object.fromEntries(Object.values(GDO_AO_REFUSAL).map(key => [key, 0]));

  function begin(x = 0, z = 0) {
    if (disposed) { refusals[GDO_AO_REFUSAL.DISPOSED]++; return 0; }
    cameraX = Number.isFinite(x) ? x : 0;
    cameraZ = Number.isFinite(z) ? z : 0;
    count = 0;
    written = 0;
    culled = 0;
    return count;
  }

  function add({ x, z, groundY = 0, footprint = policy.anchorFootprintMetres, strength = 1, phase = null } = {}) {
    if (disposed) { refusals[GDO_AO_REFUSAL.DISPOSED]++; return { ok: false, refusal: GDO_AO_REFUSAL.DISPOSED }; }
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(groundY)
      || !Number.isFinite(footprint) || !Number.isFinite(strength)) {
      refusals[GDO_AO_REFUSAL.BAD_INPUT]++;
      return { ok: false, refusal: GDO_AO_REFUSAL.BAD_INPUT };
    }
    if (count >= policy.maxAnchorInstances) {
      refusals[GDO_AO_REFUSAL.POOL_FULL]++;
      return { ok: false, refusal: GDO_AO_REFUSAL.POOL_FULL };
    }
    // Distance fade: anchors belong to the near field, and a far one is dropped
    // rather than drawn at a size that would read as a stain.
    const distance = Math.hypot(x - cameraX, z - cameraZ);
    if (distance >= policy.anchorFadeEndMetres) {
      culled++;
      refusals[GDO_AO_REFUSAL.OUT_OF_RANGE]++;
      return { ok: false, refusal: GDO_AO_REFUSAL.OUT_OF_RANGE };
    }
    const fade = distance <= policy.anchorFadeStartMetres ? 1
      : 1 - (distance - policy.anchorFadeStartMetres) / (policy.anchorFadeEndMetres - policy.anchorFadeStartMetres);
    const resolvedStrength = clamp(strength, 0, 1) * fade;
    const size = clamp(footprint, policy.anchorFootprintMin, policy.anchorFootprintMax);
    const offset = count * stride;
    buffer[offset] = x;
    buffer[offset + 1] = groundY + policy.anchorLiftMetres;
    buffer[offset + 2] = z;
    buffer[offset + 3] = size * policy.anchorScaleX;
    buffer[offset + 4] = size * policy.anchorScaleZ;
    buffer[offset + 5] = resolvedStrength;
    buffer[offset + 6] = clamp(resolvedStrength, 0, 1) * .55;
    // A stable per-anchor phase keeps a dithered low-profile edge from banding in
    // lockstep across every prop in view.
    buffer[offset + 7] = Number.isFinite(phase) ? (phase % 1 + 1) % 1
      : ((Math.imul(count + 1, 2654435761) >>> 0) % 1024) / 1024;
    count++;
    written++;
    return { ok: true, index: count - 1 };
  }

  function clear() {
    count = 0;
    written = 0;
    culled = 0;
    buffer.fill(0);
  }

  function dispose() {
    if (disposed) return;
    clear();
    disposed = true;
  }

  return Object.freeze({
    namespace: GDO_AO_NAMESPACE,
    profile,
    policy,
    stride,
    begin,
    add,
    clear,
    dispose,
    /** The live instance records a renderer uploads as one instanced attribute. */
    write: () => buffer.subarray(0, count * stride),
    get instances() { return count; },
    get diagnostics() {
      return Object.freeze({
        namespace: GDO_AO_NAMESPACE,
        profile,
        strategy: GDO_AO_STRATEGY.CONTACT_ANCHORS,
        instances: count,
        maxInstances: policy.maxAnchorInstances,
        written,
        culled,
        // One instanced draw, two triangles per anchor, no render target, no pass.
        addedDrawCalls: count > 0 ? 1 : 0,
        triangles: count * 2,
        bytes: policy.maxAnchorInstances * policy.anchorBytesPerInstance,
        fullScreenPasses: 0,
        renderTargetBytes: 0,
        steadyFrameAllocations: 0,
        disposed,
        refusals: Object.freeze({ ...refusals }),
      });
    },
  });
}

/**
 * The other cheap half: baked per-vertex occlusion over generated geometry.
 *
 * A wall bottom reads as grounded when it darkens toward its base; a wall *corner*
 * reads as grounded when it darkens a little more than the flat run beside it. The
 * formula is the two terms the research asks for (§8.1: darken wall bottoms and
 * inward corners) and nothing else — no rays, no pairs, no runtime cost. Output is
 * a per-vertex byte a builder can write straight into a colour or occlusion
 * attribute.
 */
export function bakeContactOcclusion({
  positions,
  normals = null,
  groundY = 0,
  profile = 'low',
} = {}) {
  if (!positions || typeof positions.length !== 'number' || positions.length % 3 !== 0) {
    return { ok: false, refusal: GDO_AO_REFUSAL.BAD_INPUT };
  }
  const policy = policyFor(profile);
  const vertices = positions.length / 3;
  if (vertices === 0) {
    return Object.freeze({
      ok: true, namespace: GDO_AO_NAMESPACE, vertices: 0,
      values: new Uint8Array(0), bytes: 0, minimum: 0, maximum: 0, mean: 0,
    });
  }
  const usableNormals = normals && normals.length === positions.length ? normals : null;
  const values = new Uint8Array(vertices);
  let minimum = 255, maximum = 0, sum = 0;
  for (let index = 0; index < vertices; index++) {
    const offset = index * 3;
    const height = Math.max(0, positions[offset + 1] - groundY);
    // Squared falloff: the darkening is tight to the base, not a gradient smear.
    const falloff = 1 - clamp(height / policy.vertexOcclusionHeightMetres, 0, 1);
    const contact = falloff * falloff;
    const vertical = usableNormals ? 1 - clamp(usableNormals[offset + 1], 0, 1) : .5;
    const centre = contact * policy.vertexOcclusionStrength;
    const corner = contact * vertical * policy.vertexOcclusionCornerBoost;
    // Stored as a brightness multiplier: 255 = untouched, lower = occluded.
    const byte = Math.round(clamp(1 - centre - corner, 0, 1) * 255);
    values[index] = byte;
    if (byte < minimum) minimum = byte;
    if (byte > maximum) maximum = byte;
    sum += byte;
  }
  return Object.freeze({
    ok: true,
    namespace: GDO_AO_NAMESPACE,
    vertices,
    values,
    bytes: values.byteLength,
    minimum,
    maximum,
    mean: sum / vertices,
    // Machine-independent cost of the whole technique: one byte per vertex, one
    // pass over the buffer at build time, nothing per frame.
    builtSamples: vertices,
    fullScreenPasses: 0,
  });
}
