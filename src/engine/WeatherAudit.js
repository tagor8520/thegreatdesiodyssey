/**
 * `ENV-04` audit — the row's gate is "deterministic transitions, environment
 * response, low-profile fallback", and the research adds two hard rules: weather
 * "should transition over time rather than roll independently each frame", and at
 * most one precipitation family may be active at once.
 *
 * This is the scripted half of that proof. The runtime supplies a `step` that
 * advances the weather clock and a `sample` that records the live numbers; every
 * verdict here is computed from those records, so the same audit runs against the
 * live coordinate world and against synthetic samples in the unit tests.
 */

import {
  GDO_WEATHER_PRECIPITATION, GDO_WEATHER_REFUSAL, GDO_WEATHER_STATES, weatherAdmits,
} from './WeatherState.js';
import { GDO_NIGHT_READABILITY_FLOORS } from './TimeOfDaySky.js';

export const GDO_WEATHER_AUDIT_NAMESPACE = 'gdo:weatherAudit:v1';

/**
 * Every field a sample record must carry. `base` is the `ENV-02` day-cycle
 * numbers the response was derived from and `applied` is what the targets
 * received: both are *snapshots*, never live views — the runtime mutates its own
 * records in place, and a recorded reference would rewrite history.
 */
const AUDIT_FIELDS = Object.freeze([
  'run', 'id', 'from', 'to', 'blend', 'precipitation', 'activePrecipitation',
  'sunScale', 'fillScale', 'exposureScale', 'fogNearScale', 'fogFarScale',
  'cloudiness', 'windStrength', 'gustiness', 'wetness', 'dust', 'snow', 'damp',
  'habitatFlyers', 'habitatInsects', 'base', 'applied', 'writes', 'writesThisUpdate',
  'overBudgetUpdates', 'deferredWrites', 'steadyFrameAllocations', 'climate',
  'refusalReasons', 'fallback', 'writable',
]);

function fingerprint(samples) {
  let hash = 2166136261;
  for (const sample of samples) {
    const text = [
      sample.run, sample.id, sample.from, sample.to, sample.blend?.toFixed(4),
      sample.activePrecipitation, sample.sunScale?.toFixed(4), sample.fillScale?.toFixed(4),
      sample.exposureScale?.toFixed(4), sample.windStrength?.toFixed(4),
      sample.applied?.sunIntensity?.toFixed(4), sample.applied?.exposure?.toFixed(4),
    ].join('|');
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

function close(first, second, tolerance = 1e-3) {
  return Number.isFinite(first) && Number.isFinite(second) && Math.abs(first - second) <= tolerance;
}

/**
 * Scripted weather audit. `step({ index, dt })` advances one frame of the script;
 * `sample(index, pass)` returns the live record described by `AUDIT_FIELDS`.
 */
export function runWeatherAudit({
  step,
  sample,
  reset = null,
  steps = 96,
  repeat = 2,
  dt = 1 / 30,
  expect = null,
  label = 'coordinate-weather',
} = {}) {
  if (typeof step !== 'function' || typeof sample !== 'function') {
    throw new TypeError('runWeatherAudit needs step(input) and sample(index, pass) functions');
  }
  if (!Number.isFinite(steps) || steps < 8) throw new RangeError('Weather audit needs at least eight steps');
  const runs = [];
  for (let pass = 0; pass < Math.max(1, repeat); pass++) {
    reset?.(pass);
    const records = [];
    for (let index = 0; index < steps; index++) {
      step({ index, dt, pass });
      const record = sample(index, pass) ?? {};
      const missing = AUDIT_FIELDS.filter(field => record[field] === undefined);
      if (missing.length) throw new TypeError(`Weather sample ${index} is missing ${missing.join(', ')}`);
      records.push(Object.freeze({ index, ...record }));
    }
    runs.push(records);
  }
  const samples = runs[0];
  const verdict = (id, ok, detail) => Object.freeze({ id, ok: Boolean(ok), detail });
  const verdicts = [];
  const last = samples.at(-1);

  // --- the machine moves, and it moves in runs ------------------------------
  const visited = [];
  for (const entry of samples) if (visited.at(-1) !== entry.to) visited.push(entry.to);
  const distinct = new Set(visited);
  verdicts.push(verdict('states-visited', distinct.size >= (expect?.minStates ?? 3),
    `${distinct.size} state(s) over ${samples.length} samples: ${[...distinct].join(', ')}`));

  // A state may only change at a run boundary: inside a run the incoming state
  // `to` is constant, which is exactly "it does not roll independently each frame".
  let midRunChanges = 0;
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1], current = samples[index];
    if (current.run === previous.run && current.to !== previous.to) midRunChanges++;
    if (current.run < previous.run) midRunChanges++;
  }
  verdicts.push(verdict('runs-hold', midRunChanges === 0,
    midRunChanges === 0
      ? `the incoming state changed only at run boundaries (${samples.at(-1).run - samples[0].run} run(s) crossed)`
      : `${midRunChanges} sample(s) changed state inside a run`));

  // --- transitions are ramps, not snaps -------------------------------------
  const transitionIndices = [];
  for (let index = 1; index < samples.length; index++) {
    if (samples[index].run !== samples[index - 1].run) transitionIndices.push(index);
  }
  const ramped = transitionIndices.filter(index => {
    const before = samples[index - 1];
    return before.run === samples[index].run - 1 && before.blend > .5 && samples[index].blend < .5;
  });
  const partials = samples.filter(entry => entry.blend > 0 && entry.blend < 1);
  const transitionsRamped = transitionIndices.length === 0
    ? partials.length > 0
    : ramped.length === transitionIndices.length;
  verdicts.push(verdict('transitions-blended', transitionsRamped && partials.length > 0,
    `${partials.length} blended sample(s) over ${transitionIndices.length} run transition(s)`));

  // --- the environment actually responded -----------------------------------
  const floors = GDO_NIGHT_READABILITY_FLOORS;
  const responseMismatches = [];
  for (const entry of samples) {
    const from = GDO_WEATHER_STATES.find(candidate => candidate.id === entry.from);
    const to = GDO_WEATHER_STATES.find(candidate => candidate.id === entry.to);
    if (!from || !to) { responseMismatches.push(`${entry.id}: unknown state`); continue; }
    // The declared response is what the blend says it should be: the target's
    // scale once the ramp has finished, a value between the two while it runs.
    if (entry.blend === 1) {
      if (!close(entry.sunScale, to.sunScale) || !close(entry.fillScale, to.fillScale) ||
          !close(entry.exposureScale, to.exposureScale)) {
        responseMismatches.push(`${entry.to}: declared scales ${entry.sunScale}/${entry.fillScale}/${entry.exposureScale}`);
      }
    } else if (entry.blend > 0) {
      const low = Math.min(from.sunScale, to.sunScale), high = Math.max(from.sunScale, to.sunScale);
      if (entry.sunScale < low - 1e-6 || entry.sunScale > high + 1e-6) {
        responseMismatches.push(`${entry.id}: blended sunScale ${entry.sunScale} outside ${low}..${high}`);
      }
    }
    if (!entry.writable) continue;
    if (!entry.applied) { responseMismatches.push(`${entry.id}: no applied response`); continue; }
    // And the applied numbers must be the day-cycle base times those scales, with
    // the readability floor applied where it applies — never a second palette.
    const expectedSun = entry.base.sunIntensity >= floors.sunIntensity
      ? Math.max(entry.base.sunIntensity * entry.sunScale, floors.sunIntensity)
      : entry.base.sunIntensity * entry.sunScale;
    const expectedFill = entry.base.hemisphereIntensity >= floors.hemisphereIntensity
      ? Math.max(entry.base.hemisphereIntensity * entry.fillScale, floors.hemisphereIntensity)
      : entry.base.hemisphereIntensity * entry.fillScale;
    const expectedExposure = entry.base.exposure >= floors.exposure
      ? Math.max(entry.base.exposure * entry.exposureScale, floors.exposure)
      : entry.base.exposure * entry.exposureScale;
    if (!close(entry.applied.sunIntensity, expectedSun, .02)) {
      responseMismatches.push(`${entry.id}: sun ${entry.applied.sunIntensity} != ${expectedSun.toFixed(3)}`);
    }
    if (!close(entry.applied.hemisphereIntensity, expectedFill, .02)) {
      responseMismatches.push(`${entry.id}: fill ${entry.applied.hemisphereIntensity} != ${expectedFill.toFixed(3)}`);
    }
    if (!close(entry.applied.exposure, expectedExposure, 1e-3)) {
      responseMismatches.push(`${entry.id}: exposure ${entry.applied.exposure} != ${expectedExposure.toFixed(4)}`);
    }
    const expectedFar = Math.max(.5, (expect?.fogFar ?? 175) * entry.fogFarScale);
    if (Number.isFinite(entry.applied.fogFar) && !close(entry.applied.fogFar, expectedFar, .05)) {
      responseMismatches.push(`${entry.id}: fog far ${entry.applied.fogFar} != ${expectedFar.toFixed(2)}`);
    }
  }
  verdicts.push(verdict('environment-response', responseMismatches.length === 0,
    responseMismatches.length === 0
      ? `${samples.length} sample(s) applied their declared scale of the day-cycle base`
      : `${responseMismatches.length} mismatch(es): ${responseMismatches.slice(0, 3).join('; ')}`));

  // --- one precipitation family at a time -----------------------------------
  const activeFamilies = new Set(samples.map(entry => entry.activePrecipitation).filter(Boolean));
  const perSample = samples.filter(entry => Array.isArray(entry.activePrecipitation));
  const declaredOnly = new Set(Object.values(GDO_WEATHER_PRECIPITATION));
  const unknownFamilies = [...activeFamilies].filter(family => !declaredOnly.has(family));
  verdicts.push(verdict('precipitation-capped', perSample.length === 0 && unknownFamilies.length === 0 &&
    activeFamilies.size <= 1,
    activeFamilies.size
      ? `one active family (${[...activeFamilies].join(', ')}), never two`
      : 'no precipitation family was active in this run'));

  // --- the night readability floors still hold ------------------------------
  const floorBreaches = samples.filter(entry => entry.writable && entry.applied && (
    entry.applied.exposure < GDO_NIGHT_READABILITY_FLOORS.exposure - 1e-6 ||
    entry.applied.hemisphereIntensity < GDO_NIGHT_READABILITY_FLOORS.hemisphereIntensity - 1e-4));
  verdicts.push(verdict('readability-floor', floorBreaches.length === 0,
    floorBreaches.length === 0
      ? `no sample fell under the declared night floors`
      : `${floorBreaches.length} sample(s) under the night readability floor`));

  // --- the low profile falls back by name -----------------------------------
  const fallback = last?.fallback ?? [];
  const responseNames = GDO_WEATHER_STATES.flatMap(state => [
    'cloudCoverage', 'cloudTint', 'wind', 'habitat',
    ...(state.precipitation ? [`particles:${state.precipitation}`] : []),
  ]);
  const fallbackComplete = fallback.every(entry => typeof entry.reason === 'string' && entry.reason.length > 0) &&
    fallback.every(entry => responseNames.includes(entry.response));
  const expectedFallback = expect?.requiredFallbacks ?? ['cloudCoverage'];
  const fallbackNames = new Set(fallback.map(entry => entry.response));
  verdicts.push(verdict('low-profile-fallback',
    fallbackComplete && expectedFallback.every(name => fallbackNames.has(name)),
    fallbackComplete
      ? `refused by name: ${fallback.map(entry => entry.response).join(', ') || 'nothing'}`
      : 'a refused response had no reason'));

  // --- inside the declared budget -------------------------------------------
  const worstWrites = Math.max(...samples.map(entry => entry.writesThisUpdate));
  const overBudget = samples.reduce((total, entry) => total + (entry.overBudgetUpdates ?? 0), 0);
  const allocations = samples.reduce((total, entry) => total + (entry.steadyFrameAllocations ?? 0), 0);
  const budgetOk = worstWrites <= (expect?.maxWritesPerUpdate ?? 12) && overBudget === 0 && allocations === 0;
  verdicts.push(verdict('budget', budgetOk,
    `worst ${worstWrites} write(s)/update of ${expect?.maxWritesPerUpdate ?? 12}, ` +
    `${overBudget} over-budget update(s), ${allocations} steady-frame allocation(s)`));

  // --- it repeats -----------------------------------------------------------
  const second = runs[1] ?? runs[0];
  const reproducible = fingerprint(runs[0]) === fingerprint(second) &&
    JSON.stringify(samples.map(entry => entry.to)) === JSON.stringify(second.map(entry => entry.to));
  verdicts.push(verdict('deterministic', reproducible,
    reproducible
      ? `two passes share the fingerprint ${fingerprint(samples)}`
      : 'two passes diverged'));

  // --- climate banding ------------------------------------------------------
  const climateRefusals = last?.refusalReasons ?? {};
  const bandBreaches = samples.filter(entry => {
    const state = GDO_WEATHER_STATES.find(candidate => candidate.id === entry.to);
    return state && entry.climate && !weatherAdmits(state, entry.climate);
  });
  const declaredRefusal = Object.values(climateRefusals).every(reason => reason >= 0) &&
    Object.keys(climateRefusals).every(reason => reason === GDO_WEATHER_REFUSAL.CLIMATE);
  verdicts.push(verdict('climate-band', bandBreaches.length === 0 && declaredRefusal,
    bandBreaches.length === 0
      ? `every sampled state is admissible in the sampled climate` +
        (Object.keys(climateRefusals).length ? ` (${climateRefusals[GDO_WEATHER_REFUSAL.CLIMATE] ?? 0} band refusals)` : '')
      : `${bandBreaches.length} sample(s) outside their climate band`));

  const failed = verdicts.filter(entry => !entry.ok);
  const report = {
    namespace: GDO_WEATHER_AUDIT_NAMESPACE,
    label,
    steps,
    dt,
    seed: last?.seed ?? null,
    season: last?.season ?? null,
    profile: last?.profile ?? null,
    states: [...distinct],
    runs: samples.at(-1).run - samples[0].run,
    transitions: transitionIndices.length,
    blendedSamples: partials.length,
    fingerprint: fingerprint(samples),
    samples: Object.freeze(samples.map(entry => Object.freeze({
      index: entry.index, run: entry.run, id: entry.id, from: entry.from, to: entry.to, blend: entry.blend,
      activePrecipitation: entry.activePrecipitation, climate: entry.climate,
    }))),
    verdicts: Object.freeze(verdicts),
    ok: failed.length === 0,
  };
  report.detail = report.ok
    ? `${samples.length} scripted samples across ${report.states.length} state(s) passed ${verdicts.length} weather verdicts (${report.fingerprint})`
    : `failed: ${failed.map(entry => entry.id).join(', ')}`;
  return Object.freeze(report);
}

export function createWeatherAuditRunner(options = {}) {
  let last = null;
  return {
    namespace: GDO_WEATHER_AUDIT_NAMESPACE,
    run(overrides = {}) {
      last = runWeatherAudit({ ...options, ...overrides });
      return last;
    },
    get last() { return last; },
    get ok() { return last?.ok ?? null; },
    summary() {
      if (!last) return 'weather audit has not run';
      return `${last.namespace} ${last.ok ? 'pass' : 'fail'} (${last.fingerprint}) · ${last.detail}`;
    },
  };
}

/** Two runs at the same inputs must produce the same fingerprint. */
export function weatherAuditDeterministic(first, second) {
  return Boolean(first && second) && first.fingerprint === second.fingerprint &&
    first.states.length === second.states.length && first.ok === second.ok;
}

