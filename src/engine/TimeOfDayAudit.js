/**
 * `ENV-02` audit — the research requires dawn, noon, sunset, and night to be
 * measured "through the same audit with a time-of-day override" (movement audit
 * item 8). This is the scripted half of that: a fixed phase list, recorded
 * numbers, and named verdicts, with the runtime supplying the samples.
 *
 * The module holds no `three` and no clock of its own, so the verdicts can be
 * unit-tested against synthetic samples and then reused verbatim against the
 * live coordinate world and the curated island.
 */

import { GDO_TIME_OF_DAY_NAMESPACE, GDO_TIME_OF_DAY_OVERRIDES, luminance } from './TimeOfDaySky.js';

export const GDO_TIME_OF_DAY_AUDIT_NAMESPACE = 'gdo:timeOfDayAudit:v1';

/** The phases the research names, plus the two edges of the night. */
export const GDO_TIME_OF_DAY_AUDIT_PHASES = Object.freeze(['night', 'dawn', 'noon', 'sunset', 'dusk']);

const AUDIT_FIELDS = Object.freeze([
  'phase', 'elevationDegrees', 'nightFactor', 'starOpacity', 'moonOpacity', 'emissive',
  'sunIntensity', 'hemisphereIntensity', 'exposure', 'horizonLuminance', 'zenithLuminance',
  'fogLuminance', 'readabilityOk', 'starGeometryCount', 'starVisible', 'sunHeight',
  'toneMappingExposure', 'writesThisUpdate', 'overBudgetUpdates',
]);

const AUDIT_EPSILON = Object.freeze({
  phase: null, starVisible: null, readabilityOk: null,
  elevationDegrees: .05, nightFactor: .02, starOpacity: .03, moonOpacity: .03, emissive: .03,
  sunIntensity: .05, hemisphereIntensity: .03, exposure: .02, horizonLuminance: .002,
  zenithLuminance: .001, fogLuminance: .002, sunHeight: .05, toneMappingExposure: .02,
  starGeometryCount: 0, writesThisUpdate: 0, overBudgetUpdates: 0,
});

function fingerprint(samples) {
  let hash = 2166136261;
  for (const sample of samples) {
    for (const field of AUDIT_FIELDS) {
      const value = sample[field];
      const text = typeof value === 'number' ? value.toFixed(5) : String(value);
      for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
    }
    hash ^= sample.name.length;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Run the scripted day audit.
 *
 * `sample(name)` must return the recorded numbers for one override; `reset(name)`
 * is called first so a run is independent of the previous one. `expect` lets a
 * world tighten a verdict (for example, the curated island has no fog).
 */
export function runTimeOfDayAudit({
  sample,
  reset = null,
  phases = GDO_TIME_OF_DAY_AUDIT_PHASES,
  expect = null,
  label = 'time-of-day',
} = {}) {
  if (typeof sample !== 'function') throw new TypeError('Time-of-day audit needs a sample(name) callback');
  if (!Array.isArray(phases) || phases.length === 0) throw new RangeError('Time-of-day audit needs at least one phase');
  for (const name of phases) {
    if (!Number.isFinite(GDO_TIME_OF_DAY_OVERRIDES[name])) {
      throw new RangeError(`Unknown time-of-day audit phase: ${name}`);
    }
  }
  const samples = [];
  const verdicts = [];
  for (const name of phases) {
    reset?.(name);
    const record = sample(name) ?? {};
    const sample_ = { name, ...record };
    for (const field of AUDIT_FIELDS) {
      if (sample_[field] === undefined) throw new TypeError(`Time-of-day sample ${name} is missing ${field}`);
    }
    samples.push(Object.freeze({ ...sample_, horizonLuminance: sample_.horizonLuminance ?? luminance(sample_.horizon ?? [0, 0, 0]) }));
  }
  const byName = Object.fromEntries(samples.map(entry => [entry.name, entry]));
  const ceilings = Object.freeze({
    maxWritesPerUpdate: expect?.maxWritesPerUpdate ?? 32,
    maxExposure: expect?.maxExposure ?? 1.15,
    minEmissiveAtNight: expect?.minEmissiveAtNight ?? .9,
    maxEmissiveAtNoon: expect?.maxEmissiveAtNoon ?? .02,
    minStarAtNight: expect?.minStarAtNight ?? .9,
    maxStarAtNoon: expect?.maxStarAtNoon ?? .05,
    minDayNightContrast: expect?.minDayNightContrast ?? 4,
    minNightLuminance: expect?.minNightLuminance ?? .012,
    minFillAtNight: expect?.minFillAtNight ?? .12,
  });
  const record = (id, ok, detail) => verdicts.push(Object.freeze({ id, ok: Boolean(ok), detail }));

  record('phases-sampled', samples.length === phases.length,
    `${samples.length}/${phases.length} scripted phases sampled`);
  record('phases-distinct', new Set(samples.map(entry => entry.phase)).size >= 2,
    `phases ${[...new Set(samples.map(entry => entry.phase))].join(', ')}`);

  const night = byName.night ?? samples[0];
  const noon = byName.noon ?? samples.at(-1);
  record('night-readable', night.readabilityOk === true,
    `night readability ${night.readabilityOk ? 'holds' : 'fails'} at elevation ${night.elevationDegrees.toFixed(1)}°`);
  record('night-luminance-floor', night.horizonLuminance >= ceilings.minNightLuminance && night.zenithLuminance > 0,
    `night horizon luminance ${night.horizonLuminance.toFixed(4)}`);
  record('day-night-contrast', noon.horizonLuminance >= night.horizonLuminance * ceilings.minDayNightContrast,
    `noon ${noon.horizonLuminance.toFixed(4)} vs night ${night.horizonLuminance.toFixed(4)}`);
  record('stars-night-only', night.starOpacity >= ceilings.minStarAtNight && noon.starOpacity <= ceilings.maxStarAtNoon,
    `stars night ${night.starOpacity.toFixed(2)} / noon ${noon.starOpacity.toFixed(2)}`);
  record('star-geometry-stable', new Set(samples.map(entry => entry.starGeometryCount)).size === 1,
    `star geometry count ${samples[0].starGeometryCount} constant across the day`);
  record('lamps-follow-clock', night.emissive >= ceilings.minEmissiveAtNight && noon.emissive <= ceilings.maxEmissiveAtNoon,
    `emissive night ${night.emissive.toFixed(2)} / noon ${noon.emissive.toFixed(2)}`);
  record('exposure-bounded', samples.every(entry => entry.exposure > 0 && entry.exposure <= ceilings.maxExposure &&
      Math.abs(entry.exposure - entry.toneMappingExposure) < 1e-6),
    `exposure range ${Math.min(...samples.map(entry => entry.exposure)).toFixed(2)}–${Math.max(...samples.map(entry => entry.exposure)).toFixed(2)}`);
  record('sun-above-ground', samples.every(entry => entry.sunHeight >= 0),
    `lowest sun height ${Math.min(...samples.map(entry => entry.sunHeight)).toFixed(3)}`);
  record('filled-at-night', night.hemisphereIntensity >= ceilings.minFillAtNight,
    `night fill ${night.hemisphereIntensity.toFixed(2)}`);
  record('writes-bounded', samples.every(entry => entry.writesThisUpdate <= ceilings.maxWritesPerUpdate && entry.overBudgetUpdates === 0),
    `worst ${Math.max(...samples.map(entry => entry.writesThisUpdate))} writes per update`);
  const distinctElevations = new Set(samples.map(entry => entry.elevationDegrees.toFixed(1)));
  record('elevations-distinct', distinctElevations.size === samples.length,
    `${distinctElevations.size} distinct sun elevations`);

  const failed = verdicts.filter(verdict => !verdict.ok);
  return Object.freeze({
    namespace: GDO_TIME_OF_DAY_AUDIT_NAMESPACE,
    featureNamespace: GDO_TIME_OF_DAY_NAMESPACE,
    label,
    ok: failed.length === 0,
    samples: samples.length,
    phases: Object.freeze([...phases]),
    fingerprint: fingerprint(samples),
    ceilings,
    epsilon: AUDIT_EPSILON,
    verdicts: Object.freeze(verdicts),
    detail: failed.length === 0
      ? `${samples.length} phases, night readable, stars and lamps follow the clock`
      : `${failed.length} failed: ${failed.map(verdict => verdict.id).join(', ')}`,
    measurements: Object.freeze(samples.map(entry => Object.freeze({
      name: entry.name, phase: entry.phase, elevationDegrees: entry.elevationDegrees,
      starOpacity: entry.starOpacity, emissive: entry.emissive, exposure: entry.exposure,
      horizonLuminance: entry.horizonLuminance, writesThisUpdate: entry.writesThisUpdate,
    }))),
  });
}

export function createTimeOfDayAuditRunner(options = {}) {
  let last = null;
  return {
    namespace: GDO_TIME_OF_DAY_AUDIT_NAMESPACE,
    run(overrides = {}) {
      last = runTimeOfDayAudit({ ...options, ...overrides });
      return last;
    },
    get last() { return last; },
    get ok() { return last?.ok ?? null; },
    summary() {
      if (!last) return 'time-of-day audit has not run';
      return `${last.namespace} ${last.ok ? 'pass' : 'fail'} (${last.fingerprint}) · ${last.detail}`;
    },
  };
}

/** Two runs at the same inputs must produce the same fingerprint. */
export function timeOfDayAuditDeterministic(first, second) {
  return Boolean(first && second) && first.fingerprint === second.fingerprint &&
    first.samples === second.samples && first.ok === second.ok;
}
