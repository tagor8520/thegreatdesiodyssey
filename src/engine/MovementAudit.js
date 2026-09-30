/**
 * Programmatic replacement for the retired browser-capture audit matrix.
 *
 * The project no longer depends on Chromium/screenshot tooling. Instead a
 * scripted, fixed-step camera/player sweep drives the real runtime and records
 * the numeric state that a screenshot used to be inspected for: near-plane
 * clearance against real colliders, opaque/transparent render bands, LOD and
 * resident-set churn, subpixel detail against the mip/fade policy, and
 * per-step stability. Every verdict is a deterministic pass/fail with the
 * offending samples attached.
 *
 * No `three` and no DOM import: the runtime supplies `step(input)` and
 * `probe()`, so the same audit runs in a page, in the debug hook, and under
 * `node --test`.
 */

import { GDO_WATER_STATE_ORDER } from './WaterContact.js';

export const MOVEMENT_AUDIT_NAMESPACE = 'gdo:movementAudit:v1';

/**
 * Fixed script. Paths are ordered so an audit run walks the same sequence with
 * the same step count every time; `phase` drives deterministic sweep angles.
 */
export const MOVEMENT_AUDIT_PATHS = Object.freeze([
  { id: 'fpp-focus-forward', cameraMode: 'first-person', steps: 24, forward: 1, yawTurns: 0 },
  { id: 'fpp-focus-strafe', cameraMode: 'first-person', steps: 24, forward: 0, strafe: 1, yawTurns: 0 },
  { id: 'fpp-focus-turn', cameraMode: 'first-person', steps: 36, forward: .35, yawTurns: 1 },
  { id: 'tpp-focus-pullout', cameraMode: 'third-person', steps: 36, forward: 0, zoomTurns: 1, yawTurns: .5 },
  { id: 'tpp-focus-orbit', cameraMode: 'third-person', steps: 48, forward: .5, yawTurns: 2 },
  { id: 'tpp-boundary-cross', cameraMode: 'third-person', steps: 48, forward: 1, yawTurns: .25 },
]);

/**
 * `QLT-06` water/wetland extension: the same fixed-step script walked into, along,
 * and out of mapped water. The sequence matters — a run enters shallow water,
 * pushes into the deep, returns to the bank, then strafes the shoreline — so the
 * `water` verdict can prove the state machine moves one step at a time instead of
 * teleporting between dry ground and submersion.
 */
export const MOVEMENT_AUDIT_WATER_PATHS = Object.freeze([
  // Each water path is its own walk from a declared start, so the shoreline
  // sequence does not depend on how far the previous path happened to travel.
  { id: 'water-wade-in', cameraMode: 'first-person', steps: 96, forward: 1, facing: 'water', start: 'bank' },
  { id: 'water-swim-out', cameraMode: 'first-person', steps: 120, forward: 1, facing: 'water', start: 'bank' },
  { id: 'water-shore-return', cameraMode: 'first-person', steps: 120, forward: 1, turn: .5, facing: 'water', start: 'water' },
  { id: 'water-shoreline-strafe', cameraMode: 'third-person', steps: 96, forward: .2, strafe: 1, turn: .25, facing: 'water', start: 'bank' },
]);

/**
 * Water-path requirements: no illegal sample, at least one shoreline crossing per
 * water fixture, and — across the water fixtures — every state the row names,
 * because one shore may drop straight into deep water while another wades first.
 */
export const MOVEMENT_AUDIT_WATER_THRESHOLDS = Object.freeze({
  illegalTransitions: 0,
  shorelineCrossingsPerFixture: 1,
  requiredStates: Object.freeze([
    GDO_WATER_STATE_ORDER[0], GDO_WATER_STATE_ORDER[1], GDO_WATER_STATE_ORDER[2],
  ]),
});

export const MOVEMENT_AUDIT_THRESHOLDS = Object.freeze({
  /** A camera that ends up inside a blocker reports negative clearance. */
  minimumClearance: 0,
  /** Share of steps allowed to change one family's LOD/visibility state. */
  maximumToggleRatio: .25,
  /** Subpixel geometry must be mip-mapped or faded; zero violations allowed. */
  maximumSubpixelViolations: 0,
  maximumNonFiniteSamples: 0,
  /** Per-step camera/player travel ceiling in world units. */
  maximumStepDistance: 2.5,
  /** Resident-set churn allowed across one path (tiles entering or leaving). */
  maximumResidentChanges: 6,
});

function pathStepCount(path) {
  return Math.max(1, Math.floor(path.steps));
}

function input(path, index) {
  const total = pathStepCount(path);
  const phase = total > 1 ? index / (total - 1) : 1;
  return {
    pathId: path.id,
    index,
    phase,
    cameraMode: path.cameraMode,
    forward: (path.forward ?? 0) * (path.id.endsWith('turn') ? 1 : 1),
    strafe: path.strafe ?? 0,
    yawTurns: (path.yawTurns ?? 0) * phase,
    zoomTurns: (path.zoomTurns ?? 0) * phase,
    // `QLT-06` water paths: `facing: 'water'` asks the runtime to aim the yaw at
    // the mapped water it found for this fixture (offset by `turn`, a constant
    // bearing change rather than the swept `yawTurns`), and `start` says which
    // side of the shoreline that walk begins on. The audit itself never looks for
    // or places water; it only runs the walks.
    facing: path.facing ?? null,
    turn: path.turn ?? 0,
    start: path.start ?? null,
    run: false,
  };
}

function distance(first, second) {
  if (!first || !second) return 0;
  const dx = (second.x ?? 0) - (first.x ?? 0);
  const dy = (second.y ?? 0) - (first.y ?? 0);
  const dz = (second.z ?? 0) - (first.z ?? 0);
  return Math.hypot(dx, dy, dz);
}

function numericView(sample) {
  const position = sample?.camera?.position ?? {};
  const lod = sample?.lod ?? {};
  const subpixel = sample?.subpixel ?? [];
  return {
    mode: sample?.camera?.mode ?? null,
    x: Number(position.x ?? 0).toFixed(3),
    y: Number(position.y ?? 0).toFixed(3),
    z: Number(position.z ?? 0).toFixed(3),
    clearance: Number(sample?.camera?.clearance ?? 0).toFixed(3),
    lod: Object.keys(lod).sort().map(key => `${key}=${lod[key]}`).join(','),
    bands: (sample?.bands ?? []).map(band => `${band.name}:${band.order}:${band.transparent ? 't' : 'o'}`).join(','),
    subpixel: subpixel.map(entry => `${entry.key}=${Number(entry.pixels ?? 0).toFixed(2)}${entry.mip ? 'm' : ''}${entry.faded ? 'f' : ''}`).join(','),
    residents: (sample?.residentTiles ?? []).slice().sort().join(','),
    calls: Number(sample?.renderCalls ?? 0),
    triangles: Number(sample?.triangles ?? 0),
  };
}

function fingerprint(samples) {
  const text = samples.map(sample => JSON.stringify(numericView(sample))).join('|');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function runScript({ step, probe, paths, dt, repeat, reset }) {
  reset?.({ repeat, paths });
  const samples = [];
  for (const path of paths) {
    const total = pathStepCount(path);
    for (let index = 0; index < total; index++) {
      step(input(path, index), { dt, repeat });
      samples.push(probe({ pathId: path.id, index, phase: input(path, index).phase }) ?? {});
    }
  }
  return samples;
}

function evaluateClipping(samples, thresholds) {
  const worst = { clearance: Infinity, pathId: null, index: -1 };
  for (const sample of samples) {
    const clearance = Number(sample?.camera?.clearance);
    if (!Number.isFinite(clearance)) continue;
    if (clearance < worst.clearance) {
      worst.clearance = clearance;
      worst.pathId = sample.pathId;
      worst.index = sample.index;
    }
  }
  const violations = samples
    .filter(sample => Number.isFinite(Number(sample?.camera?.clearance)) && Number(sample.camera.clearance) < thresholds.minimumClearance)
    .map(sample => ({ pathId: sample.pathId, index: sample.index, clearance: Number(sample.camera.clearance) }));
  return {
    id: 'clipping',
    ok: violations.length === 0,
    detail: violations.length
      ? `${violations.length} sample(s) inside a blocker, worst ${worst.clearance.toFixed(3)} on ${worst.pathId}#${worst.index}`
      : `camera stayed ${Number.isFinite(worst.clearance) ? worst.clearance.toFixed(3) : 'n/a'} clear of blockers`,
    worst,
    violations: violations.slice(0, 8),
  };
}

function evaluateOrdering(samples) {
  const violations = [];
  let previousTransparent = -Infinity;
  for (const sample of samples) {
    const bands = sample?.bands ?? [];
    for (const band of bands) {
      if (band.transparent && band.order <= band.opaqueOrder) {
        violations.push({ pathId: sample.pathId, index: sample.index, band: band.name, order: band.order, opaqueOrder: band.opaqueOrder, reason: 'transparent band sorts at or below opaque' });
      }
    }
    const waterOrder = bands.find(band => band.name === 'water')?.order;
    if (waterOrder != null) {
      if (waterOrder < previousTransparent) {
        violations.push({ pathId: sample.pathId, index: sample.index, band: 'water', order: waterOrder, reason: 'water order regressed between samples' });
      }
      previousTransparent = Math.max(previousTransparent === -Infinity ? waterOrder : previousTransparent, waterOrder);
    }
  }
  return {
    id: 'ordering',
    ok: violations.length === 0,
    detail: violations.length ? `${violations.length} render-band ordering violation(s)` : 'transparent bands stayed above opaque bands with stable water order',
    violations: violations.slice(0, 8),
  };
}

function evaluatePopping(samples, thresholds) {
  const families = new Set();
  for (const sample of samples) for (const key of Object.keys(sample?.lod ?? {})) families.add(key);
  const perFamily = {};
  const violations = [];
  for (const family of families) {
    let toggles = 0, previous = null;
    for (const sample of samples) {
      const value = sample?.lod?.[family];
      if (value == null) { previous = null; continue; }
      if (previous != null && value !== previous) toggles++;
      previous = value;
    }
    const ratio = samples.length ? toggles / samples.length : 0;
    perFamily[family] = { toggles, ratio: Number(ratio.toFixed(4)) };
    if (ratio > thresholds.maximumToggleRatio) {
      violations.push({ family, toggles, ratio, limit: thresholds.maximumToggleRatio });
    }
  }
  return {
    id: 'popping',
    ok: violations.length === 0,
    detail: violations.length
      ? `LOD churn above threshold: ${violations.map(item => `${item.family} ${(item.ratio * 100).toFixed(1)}%`).join(', ')}`
      : `${families.size} family/families stayed under ${(thresholds.maximumToggleRatio * 100).toFixed(0)}% churn`,
    families: perFamily,
    violations: violations.slice(0, 8),
  };
}

function evaluateShimmer(samples, thresholds) {
  const violations = [];
  let tracked = 0;
  for (const sample of samples) {
    for (const entry of sample?.subpixel ?? []) {
      tracked++;
      const pixels = Number(entry.pixels);
      if (!Number.isFinite(pixels) || pixels >= 1) continue;
      if (!entry.mip && !entry.faded) {
        violations.push({ pathId: sample.pathId, index: sample.index, key: entry.key, pixels, reason: 'subpixel surface without mip or fade' });
      }
    }
  }
  return {
    id: 'shimmer',
    ok: violations.length <= thresholds.maximumSubpixelViolations,
    detail: violations.length
      ? `${violations.length} subpixel sample(s) lack mip/fade`
      : `${tracked} tracked surface sample(s) kept subpixel detail mip-mapped or faded`,
    violations: violations.slice(0, 8),
  };
}

function evaluateStability(samples, thresholds) {
  // Continuity is only meaningful inside one scripted path: switching the
  // audited camera (FPP ↔ TPP) legitimately repositions it once.
  let previous = null, worstStep = 0, nonFinite = 0, worstPath = null;
  for (const sample of samples) {
    const position = sample?.camera?.position;
    for (const value of [position?.x, position?.y, position?.z, sample?.camera?.clearance]) {
      if (value != null && !Number.isFinite(Number(value))) nonFinite++;
    }
    if (previous && previous.pathId === sample.pathId) {
      const travelled = distance(previous, position);
      if (travelled > worstStep) { worstStep = travelled; worstPath = `${previous.pathId}#${previous.index}`; }
    }
    previous = position ? { x: position.x, y: position.y, z: position.z, pathId: sample.pathId, index: sample.index } : null;
  }
  const ok = nonFinite <= thresholds.maximumNonFiniteSamples && worstStep <= thresholds.maximumStepDistance;
  return {
    id: 'stability',
    ok,
    detail: ok
      ? `max step ${worstStep.toFixed(3)} world units, no non-finite samples`
      : `${nonFinite} non-finite sample(s), max step ${worstStep.toFixed(3)} (limit ${thresholds.maximumStepDistance}) at ${worstPath}`,
    worstStep,
    nonFinite,
  };
}

function evaluateResidency(samples, thresholds) {
  const changes = [];
  let previous = null;
  for (const sample of samples) {
    const residents = [...(sample?.residentTiles ?? [])].sort();
    if (previous) {
      const entered = residents.filter(key => !previous.includes(key));
      const left = previous.filter(key => !residents.includes(key));
      if (entered.length || left.length) changes.push({ pathId: sample.pathId, index: sample.index, entered, left });
    }
    previous = residents;
  }
  return {
    id: 'residency',
    ok: changes.length <= thresholds.maximumResidentChanges,
    detail: changes.length <= thresholds.maximumResidentChanges
      ? `${changes.length} resident-set change(s) across the script`
      : `${changes.length} resident-set changes exceed the ${thresholds.maximumResidentChanges} allowance`,
    changes: changes.slice(0, 8),
    changeCount: changes.length,
  };
}

/**
 * The `water` verdict. It is deliberately tolerant of a fixture with no water —
 * the six canonical biomes keep their seven verdicts — but the moment a sample
 * reports a water state the run is held to the state machine: a legal one-step
 * transition each sample, submersion only while swimming, and every required
 * state actually reached.
 */
function evaluateWater(samples, thresholds, waterPaths) {
  const wet = samples.filter(sample => sample?.water && typeof sample.water.state === 'string');
  if (!wet.length) {
    return {
      id: 'water', ok: true, skipped: true, waterPaths: Boolean(waterPaths),
      states: Object.freeze([]), coverage: Object.freeze({}), overWater: 0, crossings: 0,
      detail: 'no water samples on this fixture',
    };
  }
  const violations = [];
  const coverage = Object.fromEntries(GDO_WATER_STATE_ORDER.map(state => [state, 0]));
  const transitions = Object.create(null);
  let overWater = 0;
  let crossings = 0;
  let enters = 0;
  let leaves = 0;
  let previous = null;
  for (const sample of wet) {
    const water = sample.water;
    const state = water.state;
    if (water.source && water.source !== 'none') overWater++;
    if (!coverage[state]) coverage[state] = 0;
    if (!(state in coverage)) {
      violations.push({ pathId: sample.pathId, index: sample.index, reason: `unknown water state ${state}` });
      continue;
    }
    coverage[state]++;
    const submersion = Number(water.submersion ?? 0);
    // The state machine's own semantics, checked against the submersion it
    // reports: dry ground is never under water, and anything wet is.
    if (state === 'dry' && !(submersion === 0)) {
      violations.push({ pathId: sample.pathId, index: sample.index, reason: `dry with submersion ${submersion}` });
    }
    if (state !== 'dry' && !(submersion > 0)) {
      violations.push({ pathId: sample.pathId, index: sample.index, reason: `${state} without submersion` });
    }
    if (!(submersion >= 0 && submersion <= 1)) {
      violations.push({ pathId: sample.pathId, index: sample.index, reason: `submersion ${submersion} out of range` });
    }
    // Submersion is the deepest state; it can never be reported for dry feet.
    if (water.submerged === true && state === 'dry') {
      violations.push({ pathId: sample.pathId, index: sample.index, reason: 'dry and submerged' });
    }
    if (previous && previous.pathId === sample.pathId) {
      if (previous.state !== state) {
        const key = `${previous.state}->${state}`;
        transitions[key] = (transitions[key] ?? 0) + 1;
        if (previous.wet !== (state !== 'dry')) {
          crossings++;
          if (state !== 'dry') enters++; else leaves++;
        }
      }
    }
    previous = { pathId: sample.pathId, state, wet: state !== 'dry' };
  }
  // A declared water run must really meet water and really cross a shoreline;
  // the state coverage is required across the water fixtures, not per fixture,
  // because a mapped ocean shore may drop straight into deep water while a
  // wetland basin wades first.
  if (waterPaths) {
    if (overWater === 0) violations.push({ reason: 'no sample stood over mapped water' });
    if (coverage.dry === 0) violations.push({ reason: 'the water paths never touched dry ground' });
    if (coverage.wading + coverage.swimming + coverage.submerged === 0) {
      violations.push({ reason: 'the water paths never got wet' });
    }
    if (crossings === 0) violations.push({ reason: 'the water paths never crossed a shoreline' });
  }
  const reached = GDO_WATER_STATE_ORDER.filter(state => coverage[state] > 0);
  return {
    id: 'water',
    ok: violations.length === 0,
    skipped: false,
    waterPaths: Boolean(waterPaths),
    samples: wet.length,
    overWater,
    crossings,
    enters,
    leaves,
    transitions: Object.freeze({ ...transitions }),
    states: Object.freeze(reached),
    coverage: Object.freeze(coverage),
    declared: Boolean(waterPaths),
    detail: violations.length
      ? `${violations.length} water violation(s): ${violations.slice(0, 3).map(item => item.reason).join('; ')}`
      : `${overWater} of ${wet.length} samples stood over mapped water, ${crossings} shoreline crossing(s), states ${reached.join(' → ')}`,
    violations: violations.slice(0, 8),
    illegalTransitions: violations.length,
  };
}

/**
 * Runs the fixed script twice and proves the runtime is deterministic, then
 * evaluates every movement verdict against the first pass.
 */
export function runMovementAudit({
  step,
  probe,
  paths = MOVEMENT_AUDIT_PATHS,
  thresholds = MOVEMENT_AUDIT_THRESHOLDS,
  dt = 1 / 30,
  repeat = 2,
  reset = null,
  label = 'coordinate-movement',
  waterPaths = false,
} = {}) {
  if (typeof step !== 'function' || typeof probe !== 'function') {
    throw new Error('runMovementAudit needs step(input) and probe() functions');
  }
  const runs = [];
  for (let pass = 0; pass < Math.max(1, repeat); pass++) {
    runs.push(runScript({ step, probe, paths, dt, repeat: pass, reset }));
  }
  const samples = runs[0];
  const determinism = {
    id: 'determinism',
    ok: runs.length < 2 || runs.every(run => fingerprint(run) === fingerprint(runs[0])),
    detail: runs.length < 2
      ? 'single pass requested'
      : `passes 1..${runs.length} share the same movement fingerprint`,
  };
  const verdicts = [
    determinism,
    evaluateClipping(samples, thresholds),
    evaluateOrdering(samples),
    evaluatePopping(samples, thresholds),
    evaluateShimmer(samples, thresholds),
    evaluateStability(samples, thresholds),
    evaluateResidency(samples, thresholds),
    evaluateWater(samples, MOVEMENT_AUDIT_WATER_THRESHOLDS, waterPaths),
  ];
  const report = {
    namespace: MOVEMENT_AUDIT_NAMESPACE,
    label,
    dt,
    paths: paths.map(path => path.id),
    waterPaths: Boolean(waterPaths),
    samples: samples.length,
    fingerprint: fingerprint(samples),
    ok: verdicts.every(verdict => verdict.ok),
    verdicts,
  };
  report.detail = report.ok
    ? `${samples.length} fixed-step samples over ${paths.length} paths passed ${verdicts.length} movement verdicts`
    : `failed: ${verdicts.filter(verdict => !verdict.ok).map(verdict => verdict.id).join(', ')}`;
  return report;
}

/** Creates a reusable runner so the debug hook can re-audit on demand. */
export function createMovementAuditRunner(options = {}) {
  let last = null;
  return {
    namespace: MOVEMENT_AUDIT_NAMESPACE,
    run(overrides = {}) {
      last = runMovementAudit({ ...options, ...overrides });
      return last;
    },
    get last() { return last; },
    get ok() { return last?.ok ?? null; },
    summary() {
      if (!last) return 'movement audit has not run';
      return `${last.namespace} ${last.ok ? 'pass' : 'fail'} (${last.fingerprint}) · ${last.detail}`;
    },
  };
}
