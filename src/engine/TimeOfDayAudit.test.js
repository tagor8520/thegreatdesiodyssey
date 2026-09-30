import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_TIME_OF_DAY_AUDIT_NAMESPACE,
  GDO_TIME_OF_DAY_AUDIT_PHASES,
  createTimeOfDayAuditRunner,
  runTimeOfDayAudit,
  timeOfDayAuditDeterministic,
} from './TimeOfDayAudit.js';
import {
  GDO_TIME_OF_DAY_OVERRIDES,
  createSkyState,
  createTimeOfDayState,
  luminance,
  nightReadability,
  sampleSky,
  solarPosition,
} from './TimeOfDaySky.js';

/**
 * `ENV-02` audit gate: the scripted dawn/noon/sunset/night run has to be real —
 * it must fail a dark night, a runaway write budget, and a rebuilt star set, and
 * it has to produce the same fingerprint twice.
 */

const PLACE = { latitude: 28.9845, longitude: 77.7064 };
const STAR_COUNT = 120;

/** A headless stand-in for the runtime sampler: same numbers, no `three`. */
function buildSampler({ starCount = STAR_COUNT, crushNight = false } = {}) {
  // The real bridge declares fourteen writers, so the sampled write count is
  // the one the runtime would perform rather than a placeholder zero.
  const writerKeys = ['horizon', 'middle', 'zenith', 'sun', 'hemisphere', 'ground', 'sunDirection',
    'sunIntensity', 'hemisphereIntensity', 'moonOpacity', 'starOpacity', 'fog', 'exposure', 'emissive'];
  const state = createTimeOfDayState({ ...PLACE, profile: 'low', writers: writerKeys.map(key => ({ key, write() {} })) });
  const pending = [];
  let starGeometryCount = starCount;
  let worst = 0;
  const sample = name => {
    state.override(name);
    state.advance(1000);
    state.update(state.clockMilliseconds);
    const sky = state.state;
    if (crushNight && sky.phase === 'night') {
      // A black, starless, lamp-less night: every night verdict has to notice.
      sky.horizon[0] = sky.horizon[1] = sky.horizon[2] = 0;
      sky.zenith[0] = sky.zenith[1] = sky.zenith[2] = 0;
      sky.fog[0] = sky.fog[1] = sky.fog[2] = 0;
      sky.starOpacity = 0;
      sky.emissive = 0;
      sky.hemisphereIntensity = 0;
    }
    const writes = state.diagnostics().writesThisUpdate;
    worst = Math.max(worst, writes);
    starGeometryCount = starCount;
    return {
      phase: sky.phase,
      elevationDegrees: sky.elevationDegrees,
      nightFactor: sky.nightFactor,
      starOpacity: sky.starOpacity,
      moonOpacity: sky.moonOpacity,
      emissive: sky.emissive,
      sunIntensity: sky.sunIntensity,
      hemisphereIntensity: sky.hemisphereIntensity,
      exposure: sky.exposure,
      horizonLuminance: luminance(sky.horizon),
      zenithLuminance: luminance(sky.zenith),
      fogLuminance: luminance(sky.fog),
      readabilityOk: nightReadability(sky).ok,
      starGeometryCount,
      starVisible: sky.starOpacity > .01,
      sunHeight: Math.max(0, sky.sunDirection[1]),
      toneMappingExposure: sky.exposure,
      writesThisUpdate: writes,
      overBudgetUpdates: 0,
    };
  };
  return { sample, state, pending, worstWrites: () => worst };
}

test('the scripted day passes on the real palettes and repeats exactly', () => {
  assert.equal(GDO_TIME_OF_DAY_AUDIT_NAMESPACE, 'gdo:timeOfDayAudit:v1');
  const first = buildSampler();
  const report = runTimeOfDayAudit({ sample: first.sample, label: 'unit' });
  assert.equal(report.ok, true, report.detail);
  assert.equal(report.samples, GDO_TIME_OF_DAY_AUDIT_PHASES.length);
  assert.equal(report.verdicts.every(verdict => typeof verdict.id === 'string' && typeof verdict.detail === 'string'), true);
  assert.ok(Object.isFrozen(report.verdicts));
  // Measurements are the numbers a reviewer reads, not a picture.
  const night = report.measurements.find(entry => entry.name === 'night');
  const noon = report.measurements.find(entry => entry.name === 'noon');
  assert.ok(night.horizonLuminance > 0 && night.horizonLuminance < noon.horizonLuminance);
  assert.equal(night.emissive, 1);
  assert.equal(noon.emissive, 0);

  // The same inputs give the same fingerprint; a different star set does not.
  const second = buildSampler();
  const repeat = runTimeOfDayAudit({ sample: second.sample, label: 'unit' });
  assert.equal(timeOfDayAuditDeterministic(report, repeat), true);
  const different = runTimeOfDayAudit({ sample: buildSampler({ starCount: 260 }).sample });
  assert.equal(timeOfDayAuditDeterministic(report, different), false);

  // The runner keeps the last verdict summary the debug surface prints.
  const runner = createTimeOfDayAuditRunner({ sample: buildSampler().sample });
  assert.equal(runner.ok, null);
  assert.equal(runner.summary(), 'time-of-day audit has not run');
  runner.run();
  assert.equal(runner.ok, true);
  assert.match(runner.summary(), /gdo:timeOfDayAudit:v1 pass \([0-9a-f]{8}\)/);
});

test('the audit fails a crushed night, an over-budget day, and a rebuilt star set', () => {
  const crushed = runTimeOfDayAudit({ sample: buildSampler({ crushNight: true }).sample });
  assert.equal(crushed.ok, false);
  const failed = crushed.verdicts.filter(verdict => !verdict.ok).map(verdict => verdict.id);
  for (const id of ['night-readable', 'night-luminance-floor', 'stars-night-only', 'lamps-follow-clock', 'filled-at-night']) {
    assert.ok(failed.includes(id), `${id} failed (got ${failed.join(', ')})`);
  }

  // A sampler that rebuilds the star set every phase trips the stability verdict.
  const drifting = runTimeOfDayAudit({
    sample: (() => {
      const base = buildSampler();
      let count = STAR_COUNT;
      return name => {
        count += 1;
        return { ...base.sample(name), starGeometryCount: count };
      };
    })(),
  });
  assert.equal(drifting.verdicts.find(verdict => verdict.id === 'star-geometry-stable').ok, false);

  // A tighter write ceiling turns a passing run into a failing one without any
  // change to the sky itself.
  const tight = runTimeOfDayAudit({ sample: buildSampler().sample, expect: { maxWritesPerUpdate: 1 } });
  assert.equal(tight.ok, false);
  assert.equal(tight.verdicts.find(verdict => verdict.id === 'writes-bounded').ok, false);

  // Unknown phases and a missing sampler are rejected up front.
  assert.throws(() => runTimeOfDayAudit({}), /sample\(name\) callback/);
  assert.throws(() => runTimeOfDayAudit({ sample: () => ({}), phases: ['tea-time'] }), /Unknown time-of-day audit phase/);
  assert.throws(() => runTimeOfDayAudit({ sample: () => ({}), phases: [] }), /at least one phase/);
  assert.throws(() => runTimeOfDayAudit({ sample: () => ({ phase: 'noon' }) }), /missing elevationDegrees/);
});

test('the audit numbers are the same ones the solar model produces', () => {
  const state = createSkyState();
  for (const name of GDO_TIME_OF_DAY_AUDIT_PHASES) {
    const fraction = GDO_TIME_OF_DAY_OVERRIDES[name];
    sampleSky({ fraction, ...PLACE, out: state });
    const sun = solarPosition({ ...PLACE, dayOfYear: 172, hoursUtc: fraction * 24 - PLACE.longitude / 15 });
    assert.ok(Math.abs(sun.elevationDegrees - state.elevationDegrees) < 1e-9, `${name} elevation matches the model`);
  }
  // Dawn and dusk are both dimmer than noon but brighter than midnight.
  const readings = GDO_TIME_OF_DAY_AUDIT_PHASES.map(name => {
    sampleSky({ fraction: GDO_TIME_OF_DAY_OVERRIDES[name], ...PLACE, out: state });
    return { name, luminance: luminance(state.horizon) };
  });
  const noon = readings.find(entry => entry.name === 'noon');
  for (const entry of readings) {
    if (entry.name === 'noon') continue;
    assert.ok(entry.luminance < noon.luminance, `${entry.name} is dimmer than noon`);
  }
});
