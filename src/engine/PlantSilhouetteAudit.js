/**
 * `VEG-02` — the silhouette and LOD cost audit.
 *
 * The row's open claim was "silhouette/LOD costs remain open". This module turns
 * that claim into deterministic, measured verdicts over the real resident pools
 * and the real compiled family geometries during a scripted walk:
 *
 * - what the vegetation currently costs after LOD (`boxModules`, triangles,
 *   draw pools, source geometries) against the research's low-profile ceilings;
 * - that near/mid/far keep the family silhouette (width/height retention and
 *   monotonic box/triangle cost), that the far tier keeps each family's
 *   characteristic masses and segments, and that no module below the low-profile
 *   screen threshold survives into far geometry;
 * - that a walk crosses at least three distinct large-plant silhouettes and that
 *   every resident family matches the family its morphology type declares;
 * - that exactly one LOD is active per instance, that switching stays inside the
 *   declared reevaluation rate, and that hysteresis holds at a threshold instead
 *   of flickering.
 *
 * Like the movement audit it imports no `three` and no DOM: the runtime supplies
 * `step(input)` and `probe()`, so the same audit runs in the page, in the `__gdo`
 * debug hook, and under `node --test`.
 */

import { featureNamespace } from './FeatureVersions.js';
import { GDO_PLANT_LOD_FAMILY_CAPS, GDO_PLANT_LOD_PROFILES } from './PlantLodCompiler.js';
import { GDO_PLANT_RENDER_PROFILES } from './PlantRenderPools.js';

export const GDO_PLANT_SILHOUETTE_NAMESPACE = featureNamespace('plantSilhouetteAudit');

/** Walk script, in world units: 36 steps of 1 m each is a 36 m game-space walk. */
export const PLANT_SILHOUETTE_PATHS = Object.freeze([
  { id: 'walk-forward', steps: 24, forward: 1, yawTurns: 0, cameraMode: 'first-person' },
  { id: 'walk-street-turn', steps: 24, forward: 1, yawTurns: .25, cameraMode: 'first-person' },
  { id: 'walk-canopy-pan', steps: 16, forward: .5, yawTurns: 1, cameraMode: 'first-person' },
]);

export const PLANT_SILHOUETTE_THRESHOLDS = Object.freeze({
  /** Research §17.2: vegetation/detail box modules after LOD, low profile. */
  maximumBoxModules: 6_000,
  maximumVisibleTriangles: 75_000,
  maximumDrawPools: GDO_PLANT_RENDER_PROFILES.low.maxDrawPools,
  maximumSourceGeometries: GDO_PLANT_RENDER_PROFILES.low.maxSourceGeometries,
  /** Research §19.2.5: near/mid/far must keep the family silhouette. */
  minimumFarRetention: .9,
  /**
   * Near and mid may shed crown clusters to reach their box caps (a shrub keeps
   * 86% of its envelope), but no tier may discard a fifth of the silhouette.
   */
  minimumLodRetention: .8,
  /** Research §19.2.4: distinct large-plant silhouettes in one 30 m walk. */
  minimumLargePlantFamilies: 3,
  /** Share of samples allowed to switch one instance's LOD. */
  maximumSwitchRatio: .3,
});

const LODS = Object.freeze(['near', 'mid', 'far']);
/** Families a walk must show more than one of (§19.2.4 "large-plant silhouettes"). */
const LARGE_PLANT_FAMILIES = Object.freeze(['broadleaf', 'palm', 'bamboo']);

function pathSteps(path) {
  return Math.max(1, Math.floor(path.steps));
}

function walkInput(path, index, elapsedMilliseconds, dt) {
  const total = pathSteps(path);
  const phase = total > 1 ? index / (total - 1) : 1;
  return {
    pathId: path.id,
    index,
    phase,
    cameraMode: path.cameraMode,
    forward: path.forward ?? 0,
    strafe: path.strafe ?? 0,
    yawTurns: (path.yawTurns ?? 0) * phase,
    zoomTurns: (path.zoomTurns ?? 0) * phase,
    dt,
    elapsedMilliseconds,
  };
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

/** One sample reduced to the numbers the verdicts compare, so runs are comparable. */
function sampleView(sample, input) {
  const levels = sample?.levels ?? {};
  return {
    path: input.pathId,
    index: input.index,
    x: finite(sample?.camera?.x).toFixed(2),
    z: finite(sample?.camera?.z).toFixed(2),
    entries: finite(sample?.entries),
    boxModules: finite(sample?.boxModules),
    triangles: finite(sample?.triangles),
    drawPools: finite(sample?.drawPools),
    sourceGeometries: finite(sample?.sourceGeometries),
    instances: finite(sample?.instances),
    drawnInstances: finite(sample?.drawnInstances),
    families: [...(sample?.families ?? [])].sort().join('+'),
    // Cumulative counters (switches, holds, evaluations) are deliberately not
    // part of the fingerprint: two passes over the same world must reproduce the
    // geometry and residency, while the counters legitimately accumulate.
    byLod: ['near', 'mid', 'far', 'beyond'].map(lod => `${lod}:${finite(sample?.byLod?.[lod])}`).join('|'),
    levels: LODS.map(lod => `${lod}:${finite(levels[lod]?.boxes)}/${finite(levels[lod]?.triangles)}/` +
      `${finite(levels[lod]?.silhouetteRetention?.width, 1).toFixed(3)}/${finite(levels[lod]?.silhouetteRetention?.height, 1).toFixed(3)}`).join('|'),
  };
}

function runScript({ step, probe, paths, reset, dt, warmup = false }) {
  if (reset) reset();
  const samples = [];
  let elapsed = 0;
  // A cold pool evaluates every plant on its first frame; the warmup pass gives
  // the run a steady state so a repeat compares like with like.
  if (warmup) {
    for (const path of paths) {
      for (let index = 0; index < pathSteps(path); index++) {
        step(walkInput(path, index, elapsed, dt));
        elapsed += dt * 1000;
      }
    }
  }
  for (const path of paths) {
    for (let index = 0; index < pathSteps(path); index++) {
      const input = walkInput(path, index, elapsed, dt);
      step(input);
      elapsed += dt * 1000;
      samples.push({ input, sample: probe(input) });
    }
  }
  return samples;
}

function fingerprint(samples) {
  let hash = 2166136261 >>> 0;
  for (const { input, sample } of samples) {
    const text = JSON.stringify(sampleView(sample, input));
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash.toString(16).padStart(8, '0');
}

function retentionView(levels) {
  return {
    width: finite(levels?.silhouetteRetention?.width, 0),
    height: finite(levels?.silhouetteRetention?.height, 0),
  };
}

function verdict(id, ok, detail, measured, limit) {
  return { id, ok, detail, ...(measured === undefined ? {} : { measured }), ...(limit === undefined ? {} : { limit }) };
}

/** `VEG-02`: what the resident vegetation costs after LOD. */
export function evaluatePlantSilhouetteCost(samples, thresholds = PLANT_SILHOUETTE_THRESHOLDS) {
  const peaks = { boxModules: 0, triangles: 0, drawPools: 0, sourceGeometries: 0 };
  for (const { sample } of samples) {
    peaks.boxModules = Math.max(peaks.boxModules, finite(sample?.boxModules));
    peaks.triangles = Math.max(peaks.triangles, finite(sample?.triangles));
    peaks.drawPools = Math.max(peaks.drawPools, finite(sample?.drawPools));
    peaks.sourceGeometries = Math.max(peaks.sourceGeometries, finite(sample?.sourceGeometries));
  }
  return verdict('cost.boxModules',
    peaks.boxModules <= thresholds.maximumBoxModules && peaks.triangles <= thresholds.maximumVisibleTriangles &&
    peaks.drawPools <= thresholds.maximumDrawPools && peaks.sourceGeometries <= thresholds.maximumSourceGeometries,
    `peaks: ${peaks.boxModules} boxes, ${peaks.triangles} triangles, ${peaks.drawPools} pools, ` +
    `${peaks.sourceGeometries} sources`,
    peaks, {
      maximumBoxModules: thresholds.maximumBoxModules,
      maximumVisibleTriangles: thresholds.maximumVisibleTriangles,
      maximumDrawPools: thresholds.maximumDrawPools,
      maximumSourceGeometries: thresholds.maximumSourceGeometries,
    });
}

/**
 * `VEG-02`: the silhouette itself. Levels come from the compiled family LOD sets
 * (`levels.<lod>`), so this measures shipped geometry, not intentions.
 */
export function evaluatePlantSilhouetteRetention(sample, thresholds = PLANT_SILHOUETTE_THRESHOLDS) {
  const levels = sample?.levels ?? {};
  const missing = LODS.filter(lod => !Number.isFinite(levels[lod]?.boxes));
  if (missing.length) {
    return verdict('silhouette.retention', false, `missing compiled levels: ${missing.join(', ')}`, null, null);
  }
  const monotonic = levels.near.boxes >= levels.mid.boxes && levels.mid.boxes >= levels.far.boxes &&
    levels.near.triangles >= levels.mid.triangles && levels.mid.triangles >= levels.far.triangles;
  const near = retentionView(levels.near), mid = retentionView(levels.mid), far = retentionView(levels.far);
  // Every tier keeps the family envelope within its floor; the far tier — the one
  // that has no other detail left — is held to the tighter research floor.
  const retained = [near, mid, far].every(view =>
    view.width >= (view === far ? thresholds.minimumFarRetention : thresholds.minimumLodRetention) &&
    view.height >= (view === far ? thresholds.minimumFarRetention : thresholds.minimumLodRetention)) &&
    far.width >= thresholds.minimumLodRetention && far.height >= thresholds.minimumLodRetention;
  // The far tier may only keep the masses/segments its family declares.
  const caps = GDO_PLANT_LOD_FAMILY_CAPS[sample?.family];
  const masses = finite(levels.far.aggregatedMasses, 0);
  const segments = levels.far.selectedNodePaths?.length ?? 0;
  const withinFamilyGrammar = !caps || (masses <= caps.farMasses && segments <= Math.max(1, caps.farSegments));
  return verdict('silhouette.retention', monotonic && retained && withinFamilyGrammar,
    `${sample?.family}: near ${near.width.toFixed(2)}×${near.height.toFixed(2)}, mid ${mid.width.toFixed(2)}×${mid.height.toFixed(2)}, ` +
    `far ${far.width.toFixed(2)}×${far.height.toFixed(2)}, boxes ${levels.near.boxes}/${levels.mid.boxes}/${levels.far.boxes}, ` +
    `masses ${masses}/${caps?.farMasses ?? '-'}`,
    { near, mid, far, monotonic, withinFamilyGrammar }, {
      minimumFarRetention: thresholds.minimumFarRetention,
      minimumLodRetention: thresholds.minimumLodRetention,
    });
}

/** Research §19.2.6: no required detail narrower than the low-profile screen threshold stays in far geometry. */
export function evaluatePlantFarDetailFloor(sample, thresholds = PLANT_SILHOUETTE_THRESHOLDS) {
  const profile = GDO_PLANT_LOD_PROFILES[sample?.profile];
  const far = sample?.levels?.far;
  if (!profile || !far) return verdict('silhouette.farDetailFloor', false, 'no far level or unknown profile', null, null);
  const maxDimension = Math.max(...(sample.boundsSize ?? []));
  const requiredWidth = Number.isFinite(maxDimension) && maxDimension > 0
    ? maxDimension * profile.minimumFeaturePixels / profile.projectedPixels.far
    : null;
  const declared = far.minimumFeatureWidth;
  const declaredPixels = Number.isFinite(far.minimumFeaturePixels) ? far.minimumFeaturePixels : null;
  const ok = Number.isFinite(declared) && requiredWidth !== null &&
    declared >= requiredWidth - 1e-6 && declaredPixels === profile.minimumFeaturePixels;
  return verdict('silhouette.farDetailFloor', ok,
    `${sample?.family}: far modules ≥ ${Number(declared).toFixed(3)} units for a ${requiredWidth?.toFixed(3)} threshold ` +
    `(${declaredPixels} px of ${profile.minimumFeaturePixels} px)`,
    { declared, requiredWidth }, { minimumFeaturePixels: profile.minimumFeaturePixels });
}

/** Research §19.2.4/§19.2.5: three distinct large-plant silhouettes across one walk. */
export function evaluatePlantFamilyVariety(samples, thresholds = PLANT_SILHOUETTE_THRESHOLDS) {
  const seen = new Set();
  const walkFamilies = new Set();
  for (const { sample } of samples) {
    for (const family of sample?.families ?? []) walkFamilies.add(family);
    for (const family of Object.keys(sample?.familySets ?? {})) seen.add(family);
  }
  // A large-plant silhouette counts when the walk drives instances of that
  // family: a compiled set nobody places proves nothing about the world.
  const large = LARGE_PLANT_FAMILIES.filter(family => walkFamilies.has(family));
  return verdict('silhouette.familyVariety', large.length >= thresholds.minimumLargePlantFamilies,
    `walk silhouettes: ${[...walkFamilies].sort().join(', ') || 'none'} · large: ${large.join(', ') || 'none'} · ` +
    `compiled: ${[...seen].sort().join(', ') || 'none'}`,
    { large: large.length, families: walkFamilies.size, compiled: seen.size },
    { minimumLargePlantFamilies: thresholds.minimumLargePlantFamilies });
}

/** Research §19.2.5 with the placement contract: family comes from the morphology type. */
export function evaluatePlantFamilyMatch(samples) {
  const mismatched = [];
  const families = new Set();
  for (const { sample } of samples) {
    for (const placement of sample?.placements ?? []) {
      families.add(placement.family);
      if (placement.expectedFamily && placement.family !== placement.expectedFamily) {
        mismatched.push(`${placement.family}≠${placement.expectedFamily}`);
      }
    }
  }
  return verdict('silhouette.familyMatch', mismatched.length === 0,
    mismatched.length ? `type/family mismatches: ${[...new Set(mismatched)].join(', ')}` : `${families.size} resident families match their morphology type`,
    { families: families.size, mismatched: mismatched.length }, { mismatched: 0 });
}

/** LOD switching: one active tier per instance, bounded rate, real hysteresis holds. */
export function evaluatePlantLodSwitching(samples, thresholds = PLANT_SILHOUETTE_THRESHOLDS) {
  let switches = 0, holds = 0, mismatched = 0, rateViolations = 0;
  const first = samples[0], last = samples.at(-1);
  const windowSeconds = Math.max(1e-3,
    (finite(last?.input?.elapsedMilliseconds) - finite(first?.input?.elapsedMilliseconds)) / 1000);
  const instances = Math.max(1, finite(last?.sample?.instances, 1));
  // Steady-state rate: how often each resident plant was reevaluated across the
  // walk, excluding the first frame where every plant necessarily evaluates once.
  const policy = GDO_PLANT_LOD_PROFILES[last?.sample?.profile];
  const perInstanceHz = (finite(last?.sample?.evaluations) - finite(first?.sample?.evaluations)) / instances / windowSeconds;
  if (policy && perInstanceHz > policy.maxReevaluationsHz * 1.05) rateViolations++;
  for (const { sample } of samples) {
    switches = Math.max(switches, finite(sample?.switches));
    holds = Math.max(holds, finite(sample?.hysteresisHolds));
    // Exactly one LOD draws each non-'beyond' instance: no hidden instance, no
    // instance resident in two tiers at once.
    const drawn = finite(sample?.drawnInstances);
    const beyond = finite(sample?.byLod?.beyond);
    if (drawn !== finite(sample?.instances) - beyond) mismatched++;
  }
  const ratio = switches / Math.max(1, samples.length * instances);
  return verdict('lod.switching',
    mismatched === 0 && rateViolations === 0 && ratio <= thresholds.maximumSwitchRatio,
    `${switches} switches, ${holds} hysteresis holds, ${mismatched} single-LOD mismatches, ` +
    `${rateViolations} rate violations (${perInstanceHz.toFixed(2)}/s per instance)`,
    { switches, holds, mismatched, rateViolations, perInstanceHz, ratio }, {
      mismatched: 0, rateViolations: 0,
      maximumSwitchRatio: thresholds.maximumSwitchRatio,
      maximumReevaluationsHz: policy?.maxReevaluationsHz ?? null,
    });
}

export function runPlantSilhouetteAudit({
  step,
  probe,
  paths = PLANT_SILHOUETTE_PATHS,
  thresholds = PLANT_SILHOUETTE_THRESHOLDS,
  repeat = 2,
  dt = 1 / 30,
  warmup = false,
  reset = null,
  label = 'coordinate-silhouette',
} = {}) {
  if (typeof step !== 'function' || typeof probe !== 'function') {
    throw new Error('runPlantSilhouetteAudit needs step(input) and probe() functions');
  }
  if (!Number.isFinite(dt) || dt <= 0) throw new RangeError('Plant silhouette audit requires a positive step');
  const runs = [];
  for (let pass = 0; pass < Math.max(1, repeat); pass++) runs.push(runScript({ step, probe, paths, reset, dt, warmup }));
  const samples = runs[0];
  // Every compiled family in the run is checked, not just the first resident one.
  const familyVerdicts = [];
  const checked = new Set();
  for (const { sample } of samples) {
    for (const [family, entry] of Object.entries(sample?.familySets ?? {})) {
      if (checked.has(family)) continue;
      checked.add(family);
      const levels = entry?.levels ?? entry;
      const scoped = { ...sample, family, levels, boundsSize: entry?.boundsSize ?? sample?.boundsSize };
      familyVerdicts.push({ ...evaluatePlantSilhouetteRetention(scoped, thresholds), id: `silhouette.retention.${family}` });
      familyVerdicts.push({ ...evaluatePlantFarDetailFloor(scoped, thresholds), id: `silhouette.farDetailFloor.${family}` });
    }
  }
  if (!checked.size) {
    familyVerdicts.push(evaluatePlantSilhouetteRetention(samples[0]?.sample ?? {}, thresholds));
    familyVerdicts.push(evaluatePlantFarDetailFloor(samples[0]?.sample ?? {}, thresholds));
  }
  const determinism = {
    id: 'determinism',
    ok: runs.length < 2 || runs.every(run => fingerprint(run) === fingerprint(runs[0])),
    detail: runs.length < 2 ? 'single pass requested' : `passes 1..${runs.length} share the same silhouette fingerprint`,
  };
  const verdicts = [
    determinism,
    evaluatePlantSilhouetteCost(samples, thresholds),
    ...familyVerdicts,
    evaluatePlantFamilyVariety(samples, thresholds),
    evaluatePlantFamilyMatch(samples),
    evaluatePlantLodSwitching(samples, thresholds),
  ];
  const report = {
    namespace: GDO_PLANT_SILHOUETTE_NAMESPACE,
    label,
    dt,
    warmup,
    paths: paths.map(path => path.id),
    samples: samples.length,
    families: [...checked].sort(),
    fingerprint: fingerprint(samples),
    ok: verdicts.every(item => item.ok),
    verdicts,
  };
  report.detail = report.ok
    ? `${samples.length} walk samples over ${paths.length} paths passed ${verdicts.length} silhouette/cost verdicts`
    : `failed: ${verdicts.filter(item => !item.ok).map(item => item.id).join(', ')}`;
  return report;
}

/** Reusable runner for the debug hook and diagnostics. */
export function createPlantSilhouetteAuditRunner(options = {}) {
  let last = null;
  return {
    namespace: GDO_PLANT_SILHOUETTE_NAMESPACE,
    run(overrides = {}) {
      last = runPlantSilhouetteAudit({ ...options, ...overrides });
      return last;
    },
    get last() { return last; },
    get ok() { return last?.ok ?? null; },
    summary() {
      if (!last) return 'plant silhouette audit has not run';
      return `${last.namespace} ${last.ok ? 'pass' : 'fail'} (${last.fingerprint}) · ${last.detail}`;
    },
  };
}
