import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_NIGHT_READABILITY_FLOORS,
  GDO_SKY_KEYFRAMES,
  GDO_SKY_PHASE,
  GDO_SKY_PHASE_ORDER,
  GDO_TIME_OF_DAY_DEFAULTS,
  GDO_TIME_OF_DAY_NAMESPACE,
  GDO_TIME_OF_DAY_OVERRIDES,
  GDO_TIME_OF_DAY_PROFILES,
  createSkyState,
  createStarField,
  createTimeOfDayState,
  luminance,
  nightReadability,
  sampleSky,
  solarPosition,
  timeOfDayBudgetForProfile,
} from './TimeOfDaySky.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import { featureNamespace } from './FeatureVersions.js';

/**
 * `ENV-02` gate: a geographic, uniform-bounded day cycle with a readable night
 * and no per-frame allocation — measured, not eyeballed.
 */

const PLACE = { latitude: 28.9845, longitude: 77.7064 };

test('the solar model is geographic, deterministic, and honest at the poles', () => {
  assert.equal(GDO_TIME_OF_DAY_NAMESPACE, 'gdo:timeOfDaySky:v1');
  assert.equal(featureNamespace('timeOfDaySky'), GDO_TIME_OF_DAY_NAMESPACE);

  // Local solar noon is the highest sun of the day, and it is higher in June.
  const june = solarPosition({ ...PLACE, dayOfYear: 172, hoursUtc: 12 - PLACE.longitude / 15 });
  const december = solarPosition({ ...PLACE, dayOfYear: 355, hoursUtc: 12 - PLACE.longitude / 15 });
  assert.ok(june.elevationDegrees > 80, `June noon ${june.elevationDegrees}`);
  assert.ok(december.elevationDegrees < 40 && december.elevationDegrees > 30, `December noon ${december.elevationDegrees}`);
  assert.ok(june.dayLengthHours > 13 && june.dayLengthHours < 14.5, `June day length ${june.dayLengthHours}`);
  assert.ok(december.dayLengthHours > 9.5 && december.dayLengthHours < 11, `December day length ${december.dayLengthHours}`);
  assert.equal(june.rising, false, 'exactly at solar noon the sun has turned');
  const morning = solarPosition({ ...PLACE, dayOfYear: 172, hoursUtc: 9 - PLACE.longitude / 15 });
  assert.equal(morning.rising, true, 'before solar noon the sun is rising');
  assert.ok(morning.elevationDegrees < june.elevationDegrees);
  const evening = solarPosition({ ...PLACE, dayOfYear: 172, hoursUtc: 14 - PLACE.longitude / 15 });
  assert.equal(evening.rising, false);
  assert.ok(evening.elevationDegrees < june.elevationDegrees);

  // Midnight is below the horizon; the same call twice returns the same numbers.
  const localMidnight = 12 - PLACE.longitude / 15 - 12;
  const midnight = solarPosition({ ...PLACE, dayOfYear: 271, hoursUtc: localMidnight });
  assert.ok(midnight.elevationDegrees < -50, `midnight ${midnight.elevationDegrees}`);
  assert.ok(Math.abs(midnight.solarHours) < 1e-9, 'local midnight is hour angle 180°');
  assert.deepEqual({ ...solarPosition({ ...PLACE, dayOfYear: 271, hoursUtc: 5 }) },
    { ...solarPosition({ ...PLACE, dayOfYear: 271, hoursUtc: 5 }) });
  // Tropics see a longer day than the far north at the June solstice.
  const tropics = solarPosition({ latitude: 8, longitude: 77, dayOfYear: 172, hoursUtc: 6.5 });
  const arctic = solarPosition({ latitude: 78, longitude: 15, dayOfYear: 172, hoursUtc: 6.5 });
  assert.ok(arctic.dayLengthHours > tropics.dayLengthHours);
  assert.equal(solarPosition({ latitude: 78, longitude: 15, dayOfYear: 172, hoursUtc: 1 }).dayLengthHours, 24, 'polar day');
  assert.equal(solarPosition({ latitude: -78, longitude: 15, dayOfYear: 172, hoursUtc: 1 }).dayLengthHours, 0, 'polar night');
  assert.throws(() => solarPosition({ latitude: 91, longitude: 0 }), /latitude within/);
  assert.throws(() => solarPosition({ latitude: 0, longitude: 181 }), /longitude within/);
  assert.throws(() => solarPosition({ latitude: 0, longitude: 0, dayOfYear: 400 }), /day of year/);
});

test('every named phase appears with the palettes the research lists', () => {
  assert.deepEqual(GDO_SKY_PHASE_ORDER, [
    GDO_SKY_PHASE.NIGHT, GDO_SKY_PHASE.BLUE_HOUR, GDO_SKY_PHASE.PRE_DAWN, GDO_SKY_PHASE.SUNRISE,
    GDO_SKY_PHASE.DAYLIGHT, GDO_SKY_PHASE.GOLDEN, GDO_SKY_PHASE.SUNSET,
  ]);
  // Altitudes are ordered so the palette blend is monotonic in elevation.
  const elevations = GDO_SKY_KEYFRAMES.map(keyframe => keyframe.elevation);
  assert.deepEqual(elevations, [...elevations].sort((a, b) => a - b));
  assert.equal(elevations.at(-1) > 60, true);
  // Every keyframe carries every field, so no blend can produce NaN.
  const fields = ['horizon', 'middle', 'zenith', 'fog', 'sun', 'hemisphere', 'ground', 'sunIntensity',
    'hemisphereIntensity', 'ambient', 'starOpacity', 'moonOpacity', 'exposure', 'risingPhase', 'settingPhase'];
  for (const keyframe of GDO_SKY_KEYFRAMES) {
    for (const field of fields) {
      assert.notEqual(keyframe[field], undefined, `keyframe ${keyframe.elevation} has ${field}`);
      if (typeof keyframe[field] === 'number') assert.equal(Number.isFinite(keyframe[field]), true, `${field} is finite`);
    }
  }

  const seen = new Set();
  const state = createSkyState();
  for (let step = 0; step <= 96; step++) {
    sampleSky({ fraction: step / 96, ...PLACE, out: state });
    seen.add(state.phase);
    // Colours stay in range and the star field only shows without the sun.
    for (const key of ['horizon', 'middle', 'zenith', 'fog', 'sun', 'hemisphere', 'ground']) {
      for (const channel of state[key]) assert.ok(channel >= 0 && channel <= 1, `${key} channel ${channel}`);
    }
    if (state.elevationDegrees > 10) assert.ok(state.starOpacity < .05, `stars out at ${state.elevationDegrees}°`);
    if (state.elevationDegrees < -14) assert.ok(state.starOpacity > .9, `stars in at ${state.elevationDegrees}°`);
  }
  for (const phase of [GDO_SKY_PHASE.NIGHT, GDO_SKY_PHASE.BLUE_HOUR, GDO_SKY_PHASE.PRE_DAWN,
    GDO_SKY_PHASE.SUNRISE, GDO_SKY_PHASE.DAYLIGHT, GDO_SKY_PHASE.GOLDEN, GDO_SKY_PHASE.SUNSET]) {
    assert.equal(seen.has(phase), true, `phase ${phase} is reachable`);
  }
  // Dawn and dusk are different phases at the same elevation.
  sampleSky({ fraction: .27, ...PLACE, out: state });
  const dawn = state.phase;
  sampleSky({ fraction: .77, ...PLACE, out: state });
  assert.notEqual(dawn, state.phase, `dawn ${dawn} vs dusk ${state.phase}`);
  assert.equal(state.phase, GDO_SKY_PHASE.GOLDEN);
  // The sun direction is a unit vector pointing up while the sun is up.
  sampleSky({ fraction: .5, ...PLACE, out: state });
  assert.ok(Math.abs(Math.hypot(...state.sunDirection) - 1) < 1e-9);
  assert.ok(state.sunDirection[1] > .7);
  sampleSky({ fraction: 0, ...PLACE, out: state });
  assert.ok(state.sunDirection[1] < 0, 'midnight sun direction points below the horizon');
  assert.equal(Math.hypot(...state.moonDirection).toFixed(6), '1.000000');
  assert.ok(state.moonDirection[1] > 0, 'the moon is up while the sun is down');
});

test('night stays readable and the light floors are measured, not assumed', () => {
  const state = createSkyState();
  sampleSky({ fraction: 0, ...PLACE, out: state });
  const report = nightReadability(state);
  assert.equal(report.ok, true, report.failures.join(', '));
  for (const [key, floor] of Object.entries(GDO_NIGHT_READABILITY_FLOORS)) {
    assert.ok(report.checks[key] >= floor, `${key} ${report.checks[key]} ≥ ${floor}`);
  }
  // The floors are real: a pitch-black palette fails them.
  const black = { ...state, horizon: [0, 0, 0], zenith: [0, 0, 0], fog: [0, 0, 0], hemisphereIntensity: 0, sunIntensity: 0, exposure: 0 };
  const failed = nightReadability(black);
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.failures.sort(), ['exposure', 'fogLuminance', 'hemisphereIntensity', 'horizonLuminance', 'sunIntensity', 'zenithLuminance']);
  assert.ok(luminance([1, 1, 1]) > luminance([.5, .5, .5]));
  // Night is darker than day by a wide margin, but never black.
  sampleSky({ fraction: .5, ...PLACE, out: state });
  const dayLuminance = luminance(state.horizon);
  sampleSky({ fraction: 0, ...PLACE, out: state });
  const nightLuminance = luminance(state.horizon);
  assert.ok(dayLuminance > nightLuminance * 4, `day ${dayLuminance} vs night ${nightLuminance}`);
  assert.ok(nightLuminance > 0);
  // Emissive lamps and windows follow the same clock as the sky.
  sampleSky({ fraction: 0, ...PLACE, out: state });
  assert.ok(state.emissive > .95, 'lamps are on at night');
  sampleSky({ fraction: .5, ...PLACE, out: state });
  assert.equal(state.emissive, 0, 'lamps are off at noon');
  let fading = 0;
  for (let step = 34; step <= 60; step++) {
    sampleSky({ fraction: step / 200, ...PLACE, out: state });
    if (state.emissive > 0 && state.emissive < 1) fading++;
  }
  assert.ok(fading >= 3, `lamps fade through dawn (${fading} intermediate samples)`);
});

test('the star field is deterministic, seeded, and capped per profile', () => {
  const first = createStarField({ count: 64, seed: 12345 });
  const second = createStarField({ count: 64, seed: 12345 });
  assert.equal(first.count, 64);
  assert.deepEqual([...first.positions], [...second.positions]);
  assert.deepEqual([...first.magnitudes], [...second.magnitudes]);
  const other = createStarField({ count: 64, seed: 999 });
  assert.notDeepEqual([...first.positions], [...other.positions]);
  for (let index = 0; index < first.count; index++) {
    const length = Math.hypot(first.positions[index * 3], first.positions[index * 3 + 1], first.positions[index * 3 + 2]);
    assert.ok(Math.abs(length - 1) < 1e-6, `star ${index} stays on the unit sphere`);
  }
  assert.throws(() => createStarField({ count: 0 }), /count must be 1–4000/);
  assert.throws(() => createStarField({ count: 10_000 }), /count must be 1–4000/);
  // The low profile uses a static seeded set, well under its cap.
  assert.equal(GDO_TIME_OF_DAY_PROFILES.low.starGeometry, 'static-seeded');
  assert.equal(GDO_LOW_PROFILE_BUDGETS.skyStars, GDO_TIME_OF_DAY_PROFILES.low.starCount);
  assert.equal(timeOfDayBudgetForProfile('low').starCount, 120);
  assert.equal(timeOfDayBudgetForProfile('balanced').maxUpdatesHz, 15);
  assert.equal(timeOfDayBudgetForProfile('high').maxUpdatesHz, 30);
  assert.throws(() => timeOfDayBudgetForProfile('nope'), /Unknown time-of-day profile/);
});

test('uniform writes are bounded by rate and by count, and idle frames write nothing', () => {
  assert.equal(GDO_LOW_PROFILE_BUDGETS.skyUniformWritesPerUpdate, GDO_TIME_OF_DAY_PROFILES.low.maxUniformWritesPerUpdate);
  assert.equal(GDO_TIME_OF_DAY_DEFAULTS.dayLengthMinutes > 0, true);
  const writes = [];
  const state = createTimeOfDayState({
    ...PLACE, profile: 'low', dayLengthMinutes: 24,
    writers: [
      { key: 'horizon', write: value => writes.push(['horizon', value[0]]) },
      { key: 'zenith', write: () => writes.push(['zenith']) },
      { key: 'fog', write: () => writes.push(['fog']) },
      { key: 'sun', write: () => writes.push(['sun']) },
      { key: 'hemisphere', write: () => writes.push(['hemisphere']) },
      { key: 'ground', write: () => writes.push(['ground']) },
      { key: 'sunDirection', write: () => writes.push(['sunDirection']) },
      { key: 'sunIntensity', write: () => writes.push(['sunIntensity']) },
      { key: 'hemisphereIntensity', write: () => writes.push(['hemisphereIntensity']) },
      { key: 'exposure', write: () => writes.push(['exposure']) },
      { key: 'starOpacity', write: () => writes.push(['starOpacity']) },
      { key: 'emissive', write: () => writes.push(['emissive']) },
    ],
  });
  assert.equal(state.namespace, GDO_TIME_OF_DAY_NAMESPACE);
  assert.equal(state.state, state.state, 'the state record is one reused object');

  // A full day at 30 fps: the rate gate skips most frames and never overshoots.
  let worst = 0, written = 0;
  for (let frame = 0; frame < 900; frame++) {
    const now = frame * (1000 / 30);
    state.setClock(now);
    state.update(now);
    worst = Math.max(worst, state.diagnostics().writesThisUpdate);
  }
  written = state.diagnostics().uniformWrites;
  assert.ok(worst <= GDO_TIME_OF_DAY_PROFILES.low.maxUniformWritesPerUpdate, `worst ${worst}`);
  assert.equal(state.diagnostics().overBudgetUpdates, 0);
  assert.ok(state.diagnostics().skippedUpdates > 550, 'most 30 fps frames are inside the rate window');
  assert.ok(written > 20, `writes ${written} keep the sky live`);
  assert.ok(written <= state.diagnostics().updates * GDO_TIME_OF_DAY_PROFILES.low.maxUniformWritesPerUpdate,
    `writes ${written} stay inside the per-update cap`);
  assert.equal(state.diagnostics().steadyFrameAllocations, 0);

  // Standing still writes nothing at all.
  const before = writes.length;
  for (let frame = 0; frame < 30; frame++) state.update(state.clockMilliseconds);
  assert.equal(state.diagnostics().writesThisUpdate, 0);
  assert.equal(writes.length, before, 'a static sky performs no uniform writes');

  // The override drives a phase without touching the clock pace.
  state.override('night');
  state.advance(1000);
  assert.equal(state.update(state.clockMilliseconds), true);
  assert.equal(state.state.phase, GDO_SKY_PHASE.NIGHT);
  assert.equal(state.nightReadability().ok, true);
  assert.equal(state.overrideName, GDO_TIME_OF_DAY_OVERRIDES.night);
  state.override(null);
  assert.equal(state.overrideName, null);
  assert.throws(() => state.override('midnight-snack'), /Unknown time-of-day override/);
  assert.throws(() => createTimeOfDayState({ latitude: Number.NaN, longitude: 0 }), /finite latitude/);
  assert.throws(() => createTimeOfDayState({ ...PLACE, profile: 'ultra' }), /Unknown time-of-day profile/);
  assert.throws(() => createTimeOfDayState({ ...PLACE, dayLengthMinutes: 0 }), /Day length must be positive/);
  assert.throws(() => createTimeOfDayState({ ...PLACE, writers: [{ write() {} }] }), /key and a write/);
});
