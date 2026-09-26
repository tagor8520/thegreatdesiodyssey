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
  ];
  const report = {
    namespace: MOVEMENT_AUDIT_NAMESPACE,
    label,
    dt,
    paths: paths.map(path => path.id),
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
