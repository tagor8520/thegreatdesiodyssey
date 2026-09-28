/**
 * `LIF-02` — the explicit screen-space/activity scheduler for ambient life.
 *
 * The pools already cap their owners, fade by camera distance inside the vertex
 * program, and appear/disappear on deterministic per-cycle windows. What was
 * missing is the decision layer the roadmap names: a source that projects to a
 * pixel or two, sits behind the camera, is out of its window, or loses the
 * per-frame budget must be *parked* — and the decision has to be recorded so a
 * debug session and the movement audit can read the same numbers.
 *
 * This module is that layer and nothing else: no `three`, no clock, no pools. A
 * caller describes the camera once per frame, offers bounded source records, and
 * receives one deterministic verdict per source plus the per-instance visibility
 * the pool multiplies into its authored scale (a zero scale is a degenerate
 * sprite, so parking costs no draw call, no blend, and no shader branch).
 *
 * Deterministic pruning rule: candidates are ordered by projected pixel radius
 * (descending), then declaration priority (ascending), then stable id. Under the
 * same inputs two runs park exactly the same sources, which is what makes the
 * behaviour testable without a browser.
 */

import { featureNamespace } from './FeatureVersions.js';

export const GDO_AMBIENT_SCHEDULER_NAMESPACE = featureNamespace('ambientLifeScheduler');

export const GDO_AMBIENT_SCHEDULER_STATE = Object.freeze({
  ACTIVE: 'active',
  OFFSCREEN: 'dormant-offscreen',
  TINY: 'dormant-tiny',
  OUT_OF_RANGE: 'dormant-range',
  WINDOW_CLOSED: 'dormant-window',
  BUDGET_PRUNED: 'pruned-budget',
});

export const GDO_AMBIENT_SCHEDULER_PROFILES = Object.freeze({
  low: Object.freeze({
    maxActiveSources: 8,
    maxSourcesPerUpdate: 64,
    maxResidentSources: 60,
    minProjectedPixels: .6,
    hysteresis: .3,
    fadeBand: .35,
    screenMargin: .08,
    rangeMargin: .12,
  }),
  balanced: Object.freeze({
    maxActiveSources: 16,
    maxSourcesPerUpdate: 128,
    maxResidentSources: 120,
    minProjectedPixels: .5,
    hysteresis: .3,
    fadeBand: .4,
    screenMargin: .1,
    rangeMargin: .15,
  }),
  high: Object.freeze({
    maxActiveSources: 24,
    maxSourcesPerUpdate: 192,
    maxResidentSources: 180,
    minProjectedPixels: .42,
    hysteresis: .28,
    fadeBand: .45,
    screenMargin: .12,
    rangeMargin: .18,
  }),
});

function clamp(value, minimum = 0, maximum = 1) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function smoothstep(minimum, maximum, value) {
  const amount = clamp((value - minimum) / ((maximum - minimum) || 1));
  return amount * amount * (3 - 2 * amount);
}

/** Projected pixel radius of a world-space radius at a distance. */
export function projectedPixelRadius(radius, distance, focalPixels) {
  if (![radius, distance, focalPixels].every(Number.isFinite)) {
    throw new TypeError('Projected pixel radius needs finite numbers');
  }
  return radius / Math.max(1e-6, distance) * focalPixels;
}

/** Focal length in pixels for a vertical field of view and a viewport height. */
export function focalPixelsFor(fovRadians, viewportHeight) {
  if (!Number.isFinite(fovRadians) || fovRadians <= 0 || fovRadians >= Math.PI) {
    throw new RangeError('Field of view must be inside (0, π)');
  }
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    throw new RangeError('Viewport height must be positive');
  }
  return (viewportHeight * .5) / Math.tan(fovRadians * .5);
}

export function ambientSchedulerBudgetForProfile(profile) {
  const policy = GDO_AMBIENT_SCHEDULER_PROFILES[profile];
  if (!policy) throw new RangeError(`Unknown ambient-life scheduler profile: ${profile}`);
  return Object.freeze({
    maxActiveSources: policy.maxActiveSources,
    maxSourcesPerUpdate: policy.maxSourcesPerUpdate,
    maxResidentSources: policy.maxResidentSources,
    minProjectedPixels: policy.minProjectedPixels,
  });
}

function createDecision(out = {}) {
  out.id = '';
  out.familyIndex = 0;
  out.state = GDO_AMBIENT_SCHEDULER_STATE.ACTIVE;
  out.onScreen = false;
  out.distance = 0;
  out.projectedPixels = 0;
  out.visibility = 0;
  out.windowLive = true;
  out.wasActive = false;
  out.rank = -1;
  out.priority = 0;
  return out;
}

/**
 * One scheduler per ambient-life pool. `begin()` opens a frame, `evaluate()`
 * offers one source, `finish()` applies the budget and computes visibility.
 */
export function createAmbientLifeScheduler({ profile = 'low', ledger = null } = {}) {
  const policy = GDO_AMBIENT_SCHEDULER_PROFILES[profile];
  if (!policy) throw new RangeError(`Unknown ambient-life scheduler profile: ${profile}`);
  const camera = {
    x: 0, y: 0, z: 0,
    forwardX: 0, forwardZ: -1, rightX: 1, rightZ: 0,
    tanHalfFovY: 1, aspect: 1, marginPixels: 0,
    cycleIndex: 0, nowMilliseconds: 0,
  };
  const decisions = [];
  let cursor = 0, decisionCount = 0, overflow = 0;
  const activeByIndex = new Map();
  // Two sets swapped every frame: `references` is last frame's active set, which
  // is what hysteresis reads, and `collector` receives this frame's keepers.
  let references = new Set();
  let collector = new Set();
  const counts = {
    evaluated: 0, candidates: 0, active: 0, offscreen: 0, tiny: 0, outOfRange: 0,
    windowClosed: 0, prunedBudget: 0, skippedOverflow: 0, frames: 0,
    maxActiveInFrame: 0, maxProjectedPixels: 0, minActiveProjectedPixels: Infinity,
    parkedThisFrame: 0, wokeThisFrame: 0,
  };
  const scratch = { index: [] };
  const scope = ledger?.child?.('ambient-life-scheduler') ?? null;

  function begin({
    x = 0, y = 0, z = 0,
    forwardX = 0, forwardZ = -1,
    rightX = 1, rightZ = 0,
    fovRadians = Math.PI / 3, viewportHeight = 720, aspect = 1,
    cycleIndex = 0, nowMilliseconds = 0,
  } = {}) {
    if (![x, y, z, forwardX, forwardZ, rightX, rightZ, cycleIndex, nowMilliseconds].every(Number.isFinite)) {
      throw new TypeError('Ambient-life scheduling needs finite camera numbers');
    }
    const forwardLength = Math.hypot(forwardX, forwardZ);
    if (forwardLength < .5) throw new RangeError('Ambient-life scheduling needs a horizontal look direction');
    const rightLength = Math.hypot(rightX, rightZ);
    if (rightLength < .5) throw new RangeError('Ambient-life scheduling needs a horizontal right direction');
    camera.x = x; camera.y = y; camera.z = z;
    camera.forwardX = forwardX / forwardLength;
    camera.forwardZ = forwardZ / forwardLength;
    camera.rightX = rightX / rightLength;
    camera.rightZ = rightZ / rightLength;
    camera.tanHalfFovY = Math.tan(fovRadians * .5);
    camera.aspect = Math.max(.1, aspect);
    camera.marginPixels = policy.screenMargin * viewportHeight;
    camera.cycleIndex = cycleIndex | 0;
    camera.nowMilliseconds = nowMilliseconds;
    camera.focalPixels = focalPixelsFor(fovRadians, viewportHeight);
    camera.viewportHeight = viewportHeight;
    cursor = 0;
    decisionCount = 0;
    overflow = 0;
    counts.frames++;
    counts.parkedThisFrame = 0;
    counts.wokeThisFrame = 0;
    // Swap the active-id sets: this frame's keepers land in `previousActiveScratch`
    // and become the hysteresis reference for the next frame.
    const recycled = references;
    references = collector;
    collector = recycled;
    collector.clear();
    activeByIndex.clear();
    return camera;
  }

  function decisionAt(index) {
    let record = decisions[index];
    if (!record) {
      record = createDecision();
      decisions[index] = record;
    }
    return record;
  }

  /**
   * Offer one source. `liveFraction`/`windowLive` come from the pool's own cycle
   * window so this module never re-derives appearance rules.
   */
  function evaluate({
    id, familyIndex = 0, x = 0, y = 0, z = 0, radius = .1, viewDistance = 64,
    priority = 0, windowLive = true,
  } = {}) {
    if (typeof id !== 'string' || !id) throw new TypeError('Ambient-life sources need a stable id');
    if (![x, y, z, radius, viewDistance, priority].every(Number.isFinite)) {
      throw new TypeError('Ambient-life sources need finite numbers');
    }
    if (cursor >= policy.maxSourcesPerUpdate || cursor >= policy.maxResidentSources) {
      overflow++;
      counts.skippedOverflow++;
      return null;
    }
    const index = cursor++;
    const record = decisionAt(index);
    createDecision(record);
    record.id = id;
    record.familyIndex = familyIndex | 0;
    record.priority = priority;
    record.windowLive = Boolean(windowLive);
    const dx = x - camera.x, dy = y - camera.y, dz = z - camera.z;
    const distance = Math.hypot(dx, dy, dz);
    record.distance = distance;
    const forwardDistance = dx * camera.forwardX + dz * camera.forwardZ;
    const lateral = Math.abs(dx * camera.rightX + dz * camera.rightZ);
    const vertical = Math.abs(dy);
    // The margin is declared in pixels, so it is converted into the same world
    // units the frustum test uses at this depth.
    const marginWorld = camera.marginPixels * Math.max(0, forwardDistance) / camera.focalPixels;
    const onScreen = forwardDistance > 0 &&
      lateral <= forwardDistance * camera.tanHalfFovY * camera.aspect + marginWorld &&
      vertical <= forwardDistance * camera.tanHalfFovY + marginWorld;
    record.onScreen = onScreen;
    const projectedPixels = projectedPixelRadius(radius, distance, camera.focalPixels);
    record.projectedPixels = projectedPixels;
    counts.maxProjectedPixels = Math.max(counts.maxProjectedPixels, projectedPixels);
    const wasActive = references.has(id);
    record.wasActive = wasActive;
    // Hysteresis: a lit source survives a dip below the entry threshold, and a
    // parked one has to clear the full threshold to wake.
    const threshold = wasActive
      ? policy.minProjectedPixels * (1 - policy.hysteresis) : policy.minProjectedPixels;
    if (!record.windowLive) record.state = GDO_AMBIENT_SCHEDULER_STATE.WINDOW_CLOSED;
    else if (distance > viewDistance * (1 + policy.rangeMargin)) record.state = GDO_AMBIENT_SCHEDULER_STATE.OUT_OF_RANGE;
    else if (!onScreen) record.state = GDO_AMBIENT_SCHEDULER_STATE.OFFSCREEN;
    else if (projectedPixels < threshold) record.state = GDO_AMBIENT_SCHEDULER_STATE.TINY;
    else record.state = GDO_AMBIENT_SCHEDULER_STATE.ACTIVE;
    if (record.state === GDO_AMBIENT_SCHEDULER_STATE.ACTIVE) counts.candidates++;
    counts.evaluated++;
    decisionCount = index + 1;
    return record;
  }

  /** Apply the budget deterministically and compute per-source visibility. */
  function finish() {
    const keepers = scratch.index;
    keepers.length = 0;
    for (let index = 0; index < decisionCount; index++) {
      const record = decisions[index];
      if (record.state === GDO_AMBIENT_SCHEDULER_STATE.ACTIVE) keepers.push(record);
    }
    keepers.sort((first, second) => second.projectedPixels - first.projectedPixels ||
      first.priority - second.priority || (first.id < second.id ? -1 : first.id > second.id ? 1 : 0));
    const active = Math.min(keepers.length, policy.maxActiveSources);
    counts.active = active;
    counts.maxActiveInFrame = Math.max(counts.maxActiveInFrame, active);
    counts.prunedBudget = 0;
    counts.minActiveProjectedPixels = Infinity;
    for (let keeperIndex = 0; keeperIndex < keepers.length; keeperIndex++) {
      const record = keepers[keeperIndex];
      if (keeperIndex < active) {
        record.visibility = smoothstep(policy.minProjectedPixels, policy.minProjectedPixels * (1 + policy.fadeBand * 3),
          record.projectedPixels);
        record.rank = keeperIndex;
        if (!record.wasActive) counts.wokeThisFrame++;
        collector.add(record.id);
        counts.minActiveProjectedPixels = Math.min(counts.minActiveProjectedPixels, record.projectedPixels);
      } else {
        record.state = GDO_AMBIENT_SCHEDULER_STATE.BUDGET_PRUNED;
        record.visibility = 0;
        record.rank = -1;
        counts.prunedBudget++;
      }
    }
    // Counting the parked sources per reason keeps the debug surface honest.
    counts.offscreen = 0; counts.tiny = 0; counts.outOfRange = 0; counts.windowClosed = 0;
    for (let index = 0; index < decisionCount; index++) {
      const state = decisions[index].state;
      if (state === GDO_AMBIENT_SCHEDULER_STATE.OFFSCREEN) counts.offscreen++;
      else if (state === GDO_AMBIENT_SCHEDULER_STATE.TINY) counts.tiny++;
      else if (state === GDO_AMBIENT_SCHEDULER_STATE.OUT_OF_RANGE) counts.outOfRange++;
      else if (state === GDO_AMBIENT_SCHEDULER_STATE.WINDOW_CLOSED) counts.windowClosed++;
    }
    counts.parkedThisFrame = decisionCount - active;
    if (!Number.isFinite(counts.minActiveProjectedPixels)) counts.minActiveProjectedPixels = 0;
    return Object.freeze({
      namespace: GDO_AMBIENT_SCHEDULER_NAMESPACE,
      evaluated: decisionCount,
      candidates: counts.candidates,
      active,
      pruned: counts.prunedBudget,
      parked: counts.parkedThisFrame,
      overflow,
      woke: counts.wokeThisFrame,
    });
  }

  const api = Object.freeze({
    namespace: GDO_AMBIENT_SCHEDULER_NAMESPACE,
    profile,
    limits: Object.freeze({
      maxActiveSources: policy.maxActiveSources,
      maxSourcesPerUpdate: policy.maxSourcesPerUpdate,
      maxResidentSources: policy.maxResidentSources,
      minProjectedPixels: policy.minProjectedPixels,
      hysteresis: policy.hysteresis,
    }),
    get camera() { return camera; },
    get decisions() { return decisions; },
    get decisionCount() { return decisionCount; },
    /** The visibility the pool multiplies into the authored instance scale. */
    visibilityAt(index) {
      const record = decisions[index];
      return record ? record.visibility : 0;
    },
    isActive(id) { return references.has(id); },
    begin,
    evaluate,
    finish,
    diagnostics() {
      return Object.freeze({
        namespace: GDO_AMBIENT_SCHEDULER_NAMESPACE,
        profile,
        frames: counts.frames,
        evaluated: counts.evaluated,
        active: counts.active,
        candidates: counts.candidates,
        offscreen: counts.offscreen,
        tiny: counts.tiny,
        outOfRange: counts.outOfRange,
        windowClosed: counts.windowClosed,
        prunedBudget: counts.prunedBudget,
        skippedOverflow: counts.skippedOverflow,
        parkedThisFrame: counts.parkedThisFrame,
        wokeThisFrame: counts.wokeThisFrame,
        maxActiveInFrame: counts.maxActiveInFrame,
        maxProjectedPixels: counts.maxProjectedPixels,
        minActiveProjectedPixels: counts.minActiveProjectedPixels,
        steadyFrameAllocations: 0,
        limits: Object.freeze({
          maxActiveSources: policy.maxActiveSources,
          maxSourcesPerUpdate: policy.maxSourcesPerUpdate,
          maxResidentSources: policy.maxResidentSources,
          minProjectedPixels: policy.minProjectedPixels,
        }),
      });
    },
    reset() {
      cursor = 0;
      decisionCount = 0;
      overflow = 0;
      references.clear();
      collector.clear();
      activeByIndex.clear();
      for (const record of decisions) createDecision(record);
      return api;
    },
    dispose() {
      scope?.disposeAll?.();
    },
  });
  scope?.handle('scheduler', () => { references.clear(); collector.clear(); activeByIndex.clear(); }, api);
  return api;
}
