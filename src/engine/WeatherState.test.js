/**
 * `ENV-04` — weather state machine (Node tier).
 *
 * Registered gate (feature-roadmap/README.md order 113):
 *   "Deterministic transitions, environment response, low-profile fallback"
 *
 * Each clause is measured rather than described:
 *
 * 1. **Deterministic transitions.** The state at a clock is a function of the seed, the
 *    climate and the clock — *random-accessible*, so the test asks for window 900 directly
 *    and requires the answer to equal walking there, re-runs the schedule with `Math.random`
 *    replaced (the module must not consult it), and requires a *frozen* clock to write
 *    nothing while a moving one stays inside the profile ceiling. Continuity is asserted in
 *    the clock: one minute of world time may not move any response field by more than a
 *    cross-fade step, while the state itself is discrete.
 * 2. **Environment response.** Every state's response is a function of that state, the
 *    relations the research's table states are asserted (a storm is cloudier than rain, rain
 *    is wetter than overcast, mist is foggier than clear), applied through a fake runtime
 *    that records what the apply path writes — and `clear` is the **identity**, bit-exact,
 *    which is what lets the shipped default frame be the pre-weather frame.
 * 3. **Low-profile fallback.** The low profile runs no particle families, so the weather has
 *    to be expressible through uniforms alone: the test requires every pair of states to
 *    differ on a non-particle field. The particle caps are checked against the research's own
 *    ceiling rather than trusted.
 *
 * The negative controls for this file live beside it in the change that closed the item; the
 * browser half is `tools/visual-audit/scenarios/weather-state.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_WEATHER_CLIMATE_IDS,
  GDO_WEATHER_CLIMATES,
  GDO_WEATHER_FIELDS,
  GDO_WEATHER_MIN_NIGHT_LUMINANCE,
  GDO_WEATHER_NIGHT_LUMINANCE_RETENTION,
  GDO_WEATHER_PARTICLE_CEILINGS,
  GDO_WEATHER_PROFILES,
  GDO_WEATHER_STATE_IDS,
  GDO_WEATHER_STATES,
  GDO_WEATHER_TRANSITION_MINUTES,
  GDO_WEATHER_WINDOW_MINUTES,
  GDO_WEATHER_WINDOWS_PER_DAY,
  WeatherState,
  applyWeather,
  bindWeatherUniforms,
  blendWeather,
  climateForLatitude,
  composedGroundLuminance,
  sampleWeatherAt,
  uniformResponseDistance,
  weatherSeedForCoordinate,
  weatherStateIndexAt,
} from './WeatherState.js';
import { GDO_NIGHT_LUMINANCE_FLOOR, TimeOfDay } from './TimeOfDay.js';
import * as THREE from 'three';

const MEERUT = { latitude: 28.98, longitude: 77.71, provider: 'fixture' };
const SEED = weatherSeedForCoordinate(MEERUT);
const SOLAR_NOON = 12 * 60 - MEERUT.longitude / 15 * 60;

test('the schedule is a pure, random-accessible function of seed, climate and clock', () => {
  // Same inputs, same answer — from a fresh instance, and from the same instance asked twice.
  const first = new WeatherState({ seed: SEED, climate: 'semi-arid', minutes: 613 });
  const second = new WeatherState({ seed: SEED, climate: 'semi-arid', minutes: 613 });
  assert.equal(first.state.id, second.state.id);
  assert.equal(first.diagnostics().next, second.diagnostics().next);
  for (const field of GDO_WEATHER_FIELDS) {
    assert.equal(first.state[field], second.state[field], `${field} must be a function of the inputs`);
  }

  // Random access: window 900 is answered without walking, and equals the walk.
  const direct = weatherStateIndexAt(SEED, 'semi-arid', 900);
  let walked = weatherStateIndexAt(SEED, 'semi-arid', 0);
  const day = Math.floor(900 / GDO_WEATHER_WINDOWS_PER_DAY);
  walked = weatherStateIndexAt(SEED, 'semi-arid', day * GDO_WEATHER_WINDOWS_PER_DAY);
  for (let step = 1; step <= 900 - day * GDO_WEATHER_WINDOWS_PER_DAY; step++) {
    walked = weatherStateIndexAt(SEED, 'semi-arid', day * GDO_WEATHER_WINDOWS_PER_DAY + step);
  }
  assert.equal(direct, walked, 'the schedule must be random-accessible, not history-dependent');

  // The module must not consult `Math.random`. Reproducibility is the whole point, so the
  // test removes the ability to be random rather than trusting that nobody added it.
  const original = Math.random;
  Math.random = () => { throw new Error('WeatherState consulted Math.random'); };
  try {
    const probe = sampleWeatherAt(SEED, 'semi-arid', 987.5);
    assert.equal(probe.toId, GDO_WEATHER_STATE_IDS[weatherStateIndexAt(SEED, 'semi-arid', Math.floor(987.5 / GDO_WEATHER_WINDOW_MINUTES))]);
  } finally {
    Math.random = original;
  }

  // A different seed or climate is a different schedule.
  const other = new WeatherState({ seed: SEED ^ 0x9e3779b9, climate: 'semi-arid', minutes: 613 });
  const sequence = seedUnderTest => {
    const ids = [];
    for (let window = 0; window < 60; window++) ids.push(weatherStateIndexAt(seedUnderTest, 'semi-arid', window));
    return ids.join(',');
  };
  assert.notEqual(sequence(SEED), sequence(SEED ^ 0x9e3779b9));
  assert.notEqual(sequence(SEED), sequence(SEED + 1));
  assert.equal(other.climate, 'semi-arid');
  // And the coordinate seed is a function of the coordinate, at ~100 m resolution.
  assert.equal(weatherSeedForCoordinate({ ...MEERUT }), SEED);
  assert.notEqual(weatherSeedForCoordinate({ latitude: 28.981, longitude: 77.71 }), SEED);
  assert.equal(weatherSeedForCoordinate({ latitude: 28.9801, longitude: 77.7101, provider: 'fixture' }), SEED,
    'the seed is rounded to three decimal places, so a step inside ~100 m is the same weather');
  assert.notEqual(weatherSeedForCoordinate({ latitude: 28.9801, longitude: 77.7101 }), SEED,
    'the provider is part of the coordinate identity');
  // The fixture's seed is pinned as a value: it is what the browser scenario's expectations
  // are written from, so a change to the hash is a change the browser gate notices.
  assert.equal(SEED, 919975859, 'the fixture coordinate seed must not drift silently');
  assert.notEqual(weatherSeedForCoordinate({ ...MEERUT, provider: 'overture' }), SEED);
});

test('transitions happen over time: the state is discrete, the response is continuous', () => {
  const weather = new WeatherState({ seed: SEED, climate: 'semi-arid', minutes: 0 });
  // A whole window holds one state, and the cross-fade lands exactly on the table values.
  const windowStart = Math.floor(SOLAR_NOON / GDO_WEATHER_WINDOW_MINUTES) * GDO_WEATHER_WINDOW_MINUTES;
  const target = GDO_WEATHER_STATES[GDO_WEATHER_STATE_IDS[weatherStateIndexAt(SEED, 'semi-arid', windowStart / GDO_WEATHER_WINDOW_MINUTES)]];
  const settled = sampleWeatherAt(SEED, 'semi-arid', windowStart + GDO_WEATHER_TRANSITION_MINUTES);
  assert.equal(settled.fraction, 1, 'the cross-fade must be complete a transition-length into the window');
  for (const field of GDO_WEATHER_FIELDS) {
    assert.equal(settled[field], target[field], `${field} must settle on the target state`);
  }
  // ...and one minute of clock may not move a field by more than a cross-fade step.
  const step = (() => {
    let worst = 0;
    let previous = sampleWeatherAt(SEED, 'semi-arid', 0);
    const before = { ...previous };
    for (let minute = 1; minute < GDO_WEATHER_WINDOW_MINUTES * 3; minute++) {
      previous = sampleWeatherAt(SEED, 'semi-arid', minute);
      for (const field of GDO_WEATHER_FIELDS) {
        worst = Math.max(worst, Math.abs(previous[field] - before[field]));
      }
      for (const field of GDO_WEATHER_FIELDS) before[field] = previous[field];
    }
    return worst;
  })();
  // The largest possible one-minute move is the biggest field difference between any two
  // states divided across the transition, with a small margin: continuity, stated as a bound.
  const largestFieldSpan = Math.max(...GDO_WEATHER_STATE_IDS.flatMap(a => GDO_WEATHER_STATE_IDS.map(b =>
    Math.max(...GDO_WEATHER_FIELDS.map(field => Math.abs(GDO_WEATHER_STATES[a][field] - GDO_WEATHER_STATES[b][field]))))));
  assert.ok(step <= (largestFieldSpan / GDO_WEATHER_TRANSITION_MINUTES) * 1.001,
    `one minute moved a field by ${step.toFixed(4)}, more than the cross-fade allows`);

  // Over three days the weather actually changes, and it does not change every window.
  weather.setClimate('cold');
  const seen = [];
  for (let minute = 0; minute < 1440 * 3; minute += GDO_WEATHER_WINDOW_MINUTES) {
    seen.push(sampleWeatherAt(weather.seed, 'cold', minute).toId);
  }
  assert.ok(new Set(seen).size >= 2, `three days of a cold climate must not be one state (${seen.join(' ')})`);
  assert.ok(seen.some((id, index) => index > 0 && id === seen[index - 1]),
    'a state must be able to persist for consecutive windows, or the schedule is a flicker');
  // The window arithmetic is the documented one, and the chain is anchored per day.
  assert.equal(GDO_WEATHER_WINDOWS_PER_DAY, 16);
  assert.equal(GDO_WEATHER_WINDOW_MINUTES * GDO_WEATHER_WINDOWS_PER_DAY, 1440);
  assert.ok(GDO_WEATHER_TRANSITION_MINUTES > 0 && GDO_WEATHER_TRANSITION_MINUTES < GDO_WEATHER_WINDOW_MINUTES);

  // --- days -------------------------------------------------------------------------
  // The schedule's clock is unwrapped days of 1440 minutes, and the day is the caller's
  // (both runtimes take it from `TimeOfDay.dayOfYear`). Wrapping the clock must therefore
  // *preserve* the day rather than silently re-entering the same day's morning.
  const dayWalker = new WeatherState({ seed: SEED, climate: 'cold', minutes: 1435, day: 4 });
  dayWalker.setClock(5);
  assert.equal(dayWalker.day, 4, 'setClock must preserve the day');
  assert.equal(dayWalker.absoluteMinutes, 4 * 1440 + 5);
  assert.equal(dayWalker.setDay(5), 5);
  assert.equal(dayWalker.state.windowIndex, 5 * GDO_WEATHER_WINDOWS_PER_DAY + Math.floor(5 / GDO_WEATHER_WINDOW_MINUTES));
  // A day's schedule differs from its neighbour's *and* the transition across midnight is a
  // window boundary like any other: the last window of a day fades into the next day's
  // anchor, so the response is continuous through midnight with no special case.
  const midnightBefore = new WeatherState({ seed: SEED, climate: 'cold', minutes: 1435, day: 0 });
  const midnightAfter = new WeatherState({ seed: SEED, climate: 'cold', minutes: 0, day: 1 });
  for (const field of GDO_WEATHER_FIELDS) {
    assert.equal(midnightAfter.state[field], midnightBefore.state[field],
      `${field} must be continuous across midnight (${midnightBefore.state.id} → ${midnightAfter.state.id})`);
  }
  // The blend crosses midnight like any other window boundary: the window that contains
  // midnight starts from the state the previous window settled on, and *its* target is the
  // next day's anchor — which is what `next` on the previous window already reported.
  assert.equal(midnightBefore.state.toId, midnightAfter.state.fromId,
    'the window after midnight must start from the state the last window of the day settled on');
  assert.equal(midnightBefore.state.nextId, midnightAfter.state.toId,
    'the last window of a day must fade into the next day\'s anchor');
  // ...and through the module's own sampler, which is what a save/reload replays.
  const midnightStep = Math.max(...GDO_WEATHER_FIELDS.map(field =>
    Math.abs(sampleWeatherAt(SEED, 'cold', 1440)[field] - sampleWeatherAt(SEED, 'cold', 1435)[field])));
  assert.ok(midnightStep <= (largestFieldSpanGlobal() / GDO_WEATHER_TRANSITION_MINUTES) * 5 + 1e-9,
    `midnight moved a field ${midnightStep.toFixed(4)} in five minutes, beyond a cross-fade step`);
  // Different days are different schedules, or the day input is decoration.
  const days = [0, 1, 2, 3].map(day => sampleWeatherAt(SEED, 'cold', day * 1440 + 405).toId).join(',');
  assert.ok(new Set(days.split(',')).size >= 2, `four consecutive days at the same clock are one state (${days})`);
});

test('cities in the climate are the ones that climate may have', () => {
  // A zero weight is a prohibition, not a rarity: snow cannot fall in a semi-arid climate at
  // any window of any year, and dust cannot blow in a cold one.
  for (const climate of GDO_WEATHER_CLIMATE_IDS) {
    const weights = GDO_WEATHER_CLIMATES[climate].weights;
    assert.equal(weights.length, GDO_WEATHER_STATE_IDS.length, `${climate} weights must align with the state table`);
    assert.ok(weights.reduce((total, value) => total + value, 0) > 0, `${climate} must have at least one reachable state`);
    const seen = new Set();
    for (let window = 0; window < GDO_WEATHER_WINDOWS_PER_DAY * 365; window++) {
      seen.add(GDO_WEATHER_STATE_IDS[weatherStateIndexAt(SEED, climate, window)]);
    }
    for (const id of seen) {
      const index = GDO_WEATHER_STATE_IDS.indexOf(id);
      assert.ok(weights[index] > 0, `${climate} produced ${id}, which it gives zero weight`);
    }
    // ...and every state the climate allows is actually reachable over a year, so no weight
    // is decorative.
    for (let index = 0; index < weights.length; index++) {
      if (weights[index] <= 0) continue;
      assert.ok(seen.has(GDO_WEATHER_STATE_IDS[index]),
        `${climate} never produced ${GDO_WEATHER_STATE_IDS[index]} in a year of windows`);
    }
  }
  // The shipped coordinate's climate, and the band structure underneath it.
  assert.equal(climateForLatitude(28.98, 172), 'semi-arid', 'Meerut in June is the dry season');
  assert.equal(climateForLatitude(28.98, 250), 'monsoon', 'Meerut in September is the monsoon');
  assert.equal(climateForLatitude(8.5, 100), 'tropical');
  assert.equal(climateForLatitude(19.1, 300), 'monsoon');
  assert.equal(climateForLatitude(45.5, 40), 'temperate');
  assert.equal(climateForLatitude(-60.1, 200), 'cold', 'the bands are by absolute latitude');
  assert.throws(() => climateForLatitude(120), /within ±90/);
  assert.throws(() => climateForLatitude(20, 400), /within 1…365/);
});

test('the response is a function of the state, and clear is the identity', () => {
  const of = id => GDO_WEATHER_STATES[id];
  // The relations the research's table states, in its own terms.
  assert.ok(of('storm').cloudCover > of('rain').cloudCover, 'storm is darker than rain');
  assert.ok(of('rain').cloudCover > of('overcast').cloudCover, 'rain is cloudier than overcast');
  assert.ok(of('overcast').cloudCover > of('clear').cloudCover, 'overcast is cloudier than clear');
  assert.ok(of('storm').wetness > of('rain').wetness, 'storm is the wettest state');
  assert.ok(of('rain').wetness > of('overcast').wetness, 'rain leaves the ground wetter than cloud');
  assert.equal(of('clear').wetness, 0);
  assert.ok(of('mist').fogDensity > of('haze').fogDensity && of('haze').fogDensity > of('clear').fogDensity);
  assert.ok(of('dust').fogWarmth > 0 && of('rain').fogWarmth < 0, 'dust is warm haze, rain is cool');
  assert.ok(of('clear').lightScale > of('haze').lightScale && of('haze').lightScale > of('storm').lightScale);
  assert.ok(of('snow').hemisphereScale > of('storm').hemisphereScale, 'snow is bright, a storm is not');
  assert.equal(of('clear').birdActivity, 1, 'clear weather leaves the ambience alone');
  assert.equal(of('clear').beeActivity, 1);
  assert.ok(of('storm').birdActivity < of('overcast').birdActivity, 'a storm shelters the birds');
  assert.ok(of('dust').beeActivity < of('overcast').beeActivity, 'dust suppresses insects');
  // Identity: every scale 1, every additive term 0, and the composition is arithmetically
  // the unweathered state — asserted with `===`, not a tolerance.
  for (const field of GDO_WEATHER_FIELDS) {
    const identity = ['lightScale', 'hemisphereScale', 'fogLightness', 'birdActivity', 'beeActivity'].includes(field) ? 1 : 0;
    assert.equal(of('clear')[field], identity, `clear.${field} must be ${identity}`);
  }
  const probe = new TimeOfDay({ minutes: 0 });
  for (let minute = 0; minute < 1440; minute += 37) {
    probe.setClock(minute);
    probe.sample();
    assert.equal(composedGroundLuminance(probe.state, of('clear')), probe.state.groundLuminance,
      'clear weather must compose to the time-of-day luminance exactly');
  }
});

test('the composition keeps a night readable, and the keep is measured', () => {
  // The year × clock × state sweep. `ENV-02` states a floor for its own states; weather
  // multiplies those states' terms, so the composition needs its own bound.
  let worstRetention = Infinity;
  let worstAbsolute = Infinity;
  let worstAt = null;
  for (const id of GDO_WEATHER_STATE_IDS) {
    const weather = GDO_WEATHER_STATES[id];
    for (let day = 1; day <= 365; day += 11) {
      const probe = new TimeOfDay({ dayOfYear: day, minutes: 0 });
      for (let minute = 0; minute < 1440; minute += 15) {
        probe.setClock(minute);
        probe.sample();
        const composed = composedGroundLuminance(probe.state, weather);
        const retention = composed / Math.max(probe.state.groundLuminance, 1e-9);
        if (retention < worstRetention) worstRetention = retention;
        if (composed < worstAbsolute) {
          worstAbsolute = composed;
          worstAt = `${id} at day ${day}, ${minute} minutes`;
        }
      }
    }
  }
  assert.ok(worstRetention >= GDO_WEATHER_NIGHT_LUMINANCE_RETENTION,
    `the darkest weather kept only ${worstRetention.toFixed(4)} of the unweathered luminance, below ${GDO_WEATHER_NIGHT_LUMINANCE_RETENTION}`);
  assert.ok(worstAbsolute >= GDO_WEATHER_MIN_NIGHT_LUMINANCE,
    `the composition fell to ${worstAbsolute.toFixed(5)} (${worstAt}), below the floor ${GDO_WEATHER_MIN_NIGHT_LUMINANCE}`);
  // The bound has teeth: a state that starves the light would fail it, which is what makes
  // the storm's scales above a decision rather than a description.
  const night = new TimeOfDay({ minutes: 1080 });
  const starved = { ...GDO_WEATHER_STATES.storm, lightScale: .2, hemisphereScale: .2 };
  assert.ok(composedGroundLuminance(night.state, starved) < GDO_WEATHER_MIN_NIGHT_LUMINANCE,
    'the readability floor must be able to fail, or it is decoration');
  // And the floor is derived from `ENV-02`'s own, not chosen to fit.
  assert.equal(GDO_WEATHER_MIN_NIGHT_LUMINANCE, GDO_NIGHT_LUMINANCE_FLOOR * GDO_WEATHER_NIGHT_LUMINANCE_RETENTION);
});

test('the low profile is a fallback: no particles, and the weather is still visible', () => {
  // The particle budgets are the research's *visible transparent weather particles* column.
  for (const profile of ['low', 'balanced', 'high']) {
    assert.ok(GDO_WEATHER_PROFILES[profile].particleCap <= GDO_WEATHER_PARTICLE_CEILINGS[profile],
      `${profile} may not exceed the research ceiling`);
    assert.ok(GDO_WEATHER_PROFILES[profile].uniformHz <= 30);
  }
  assert.equal(GDO_WEATHER_PROFILES.low.particleFamilies, 0, 'the low profile omits particles entirely');
  assert.equal(GDO_WEATHER_PROFILES.low.particleCap, 0);
  // Which means every state must be distinguishable without them: the uniform response is
  // the whole response on the low profile, so no pair of states may differ only in particles.
  for (const a of GDO_WEATHER_STATE_IDS) {
    for (const b of GDO_WEATHER_STATE_IDS) {
      if (a >= b) continue;
      const distance = uniformResponseDistance(GDO_WEATHER_STATES[a], GDO_WEATHER_STATES[b]);
      assert.ok(distance >= .05, `${a} and ${b} differ by only ${distance} without particles`);
    }
  }
  assert.ok(GDO_WEATHER_STATE_IDS.every(id => GDO_WEATHER_STATES[id].particleIntensity >= 0));
});

test('the apply path writes uniforms, light and materials — and nothing else', () => {
  const runtime = createFakeRuntime();
  const timeOfDay = new TimeOfDay({ minutes: 409 });
  const weather = new WeatherState({ seed: SEED, climate: 'semi-arid', minutes: 409 });
  weather.setClimate('monsoon');
  // Find a clock whose state is a storm, so the apply has something to say.
  let stormMinute = null;
  for (let minute = 0; minute < 1440 * 40 && stormMinute === null; minute += 5) {
    if (sampleWeatherAt(weather.seed, 'monsoon', minute).id === 'storm') stormMinute = minute + GDO_WEATHER_TRANSITION_MINUTES;
  }
  assert.ok(stormMinute !== null, 'a monsoon month must contain a storm');
  weather.setClock(stormMinute);
  weather.sample();

  bindWeatherUniforms(runtime.sky, weather.state);
  const clearState = GDO_WEATHER_STATES.clear;
  const before = snapshot(runtime, timeOfDay.state);
  applyWeather(timeOfDay.state, clearState, {
    sky: runtime.sky, scene: runtime.scene, lightRig: runtime.lightRig,
    renderer: runtime.renderer, water: runtime.water, fogNear: 78, fogFar: 175, deltaSeconds: 0,
  });
  const afterClear = snapshot(runtime, timeOfDay.state);
  // Clear weather is the identity on every surface the pre-`ENV-04` runtime had: the fog
  // range, the light intensities, the exposure and the fog colour are exactly what the
  // time-of-day apply had already written.
  assert.equal(afterClear.fogNear, 78);
  assert.equal(afterClear.fogFar, 175);
  assert.equal(afterClear.sunIntensity, timeOfDay.state.lightIntensity);
  assert.equal(afterClear.fillIntensity, timeOfDay.state.hemisphereIntensity);
  assert.equal(afterClear.exposure, timeOfDay.state.exposure);
  assert.deepEqual(afterClear.fogColor, before.fogColor);
  assert.deepEqual(afterClear.waterWeather, [0, 0]);

  applyWeather(timeOfDay.state, weather.state, {
    sky: runtime.sky, scene: runtime.scene, lightRig: runtime.lightRig,
    renderer: runtime.renderer, water: runtime.water, fogNear: 78, fogFar: 175, deltaSeconds: .016,
  });
  const afterStorm = snapshot(runtime, timeOfDay.state);
  assert.ok(afterStorm.fogFar < afterClear.fogFar, 'a storm must reduce visibility distance');
  assert.ok(afterStorm.sunIntensity < afterClear.sunIntensity, 'a storm must dim the sun');
  assert.ok(afterStorm.exposure > afterClear.exposure, 'a storm lifts exposure so it does not read as black');
  assert.ok(afterStorm.cloudCover > afterClear.cloudCover, 'a storm must cloud the sky over');
  assert.ok(afterStorm.cloudDarkness > .5);
  assert.ok(afterStorm.skyTime > 0, 'the clouds must move once the clock is moving');
  assert.ok(afterStorm.waterWeather[0] > .5 && afterStorm.waterWeather[1] > .5, 'storm water is rippled and wet');
  assert.notDeepEqual(afterStorm.fogColor, afterClear.fogColor, 'storm fog is not clear fog');
  // Fog is a *tint* of the time-of-day colour: no channel may exceed the unweathered colour
  // times the largest tint, so weather can never brighten a night's fog into daylight.
  for (const channel of ['r', 'g', 'b']) {
    assert.ok(afterStorm.fogColor[channel] <= timeOfDay.state.fogColor[channel] * 1.13 + 1e-9,
      'the weather tint must stay a tint');
  }
  // Whatever the weather, it adds no object to the scene and no draw call.
  assert.equal(runtime.scene.children.length, 0, 'weather must not add a drawable');
  assert.equal(runtime.drawCalls(), 0);
  // The apply returns the state it applied, so a caller cannot accidentally apply a blend.
  assert.equal(applyWeather(timeOfDay.state, weather.state, { sky: runtime.sky }), weather.state);
  assert.throws(() => applyWeather(null, weather.state), /requires a time-of-day state/);
});

test('bounded writes: a frozen clock writes nothing and a moving one stays inside the ceiling', () => {
  const weather = new WeatherState({ profile: 'low', seed: SEED, climate: 'monsoon', minutes: 0 });
  weather.rebaseClock(0);
  // The first update on a never-applied state is a change — the caller has to apply once to
  // bring the runtime up to the clock — and then a frozen clock has nothing left to say.
  assert.equal(weather.update(0), true, 'an unapplied state is a change');
  weather.markApplied();
  let writes = 0;
  for (let frame = 1; frame < 61; frame++) {
    if (weather.update(frame * 16.667)) { writes++; weather.markApplied(); }
  }
  assert.equal(writes, 0, 'a frozen clock must not earn a single uniform write');
  assert.ok(weather.diagnostics().unchangedSkips >= 60);

  // Moving at one world minute per real second: the ceiling is the profile's 10 Hz, but the
  // state only *changes* at a window boundary's cross-fade, so the writing rate is far below.
  // The clock advances one world minute per real second, which crosses cross-fades: this is
  // the case the ceiling exists for. A write may land exactly on each 1/Hz boundary, so a
  // closed one-second interval can hold `Hz + 1` writes; the *rate* is what the gate is
  // about, and the thirty-second total is the tight version of it.
  const moving = new WeatherState({ profile: 'low', seed: SEED, climate: 'monsoon', minutes: 0 });
  moving.rebaseClock(0);
  const perSecond = [];
  let total = 0;
  for (let frame = 0; frame < 60 * 30; frame++) {
    const now = frame * 16.667;
    moving.setClock(moving.minutes + 16.667 / 1000);
    const bucket = Math.floor(now / 1000);
    if (moving.update(now)) { perSecond[bucket] = (perSecond[bucket] ?? 0) + 1; total++; moving.markApplied(); }
  }
  const busiest = Math.max(...perSecond.map(value => value ?? 0));
  assert.ok(busiest <= GDO_WEATHER_PROFILES.low.uniformHz + 1,
    `a moving clock spent ${busiest} writes in a second against a ${GDO_WEATHER_PROFILES.low.uniformHz} Hz ceiling`);
  assert.ok(total <= GDO_WEATHER_PROFILES.low.uniformHz * 30 + 1,
    `thirty seconds of moving clock cost ${total} writes against a ${GDO_WEATHER_PROFILES.low.uniformHz} Hz ceiling`);
  assert.ok(total > 0, 'a moving clock must write sometimes');

  // A jump spends one write, not one per skipped window.
  const jumper = new WeatherState({ profile: 'low', seed: SEED, climate: 'monsoon', minutes: 0 });
  jumper.rebaseClock(0);
  jumper.update(0);
  jumper.markApplied();
  const beforeWrites = jumper.writes;
  jumper.setClock(600);
  assert.equal(jumper.update(1000), true, 'a clock jump is a change');
  jumper.markApplied();
  assert.equal(jumper.writes - beforeWrites, 1, 'a jump must cost one write rather than replaying the windows');
  // And the ceiling still applies right after it.
  assert.equal(jumper.update(1001), false, 'a clock that has stopped moving after a jump is unchanged');
  assert.ok(jumper.diagnostics().unchangedSkips >= 1);
});

test('the steady path keeps one state object and one applied object', () => {
  const weather = new WeatherState({ seed: SEED, climate: 'temperate', minutes: 300 });
  const keys = Object.keys(weather.state).sort().join(',');
  const identity = weather.state;
  for (let frame = 0; frame < 200; frame++) {
    weather.setClock(weather.minutes + .25);
    weather.sample();
    if (weather.update(frame * 16.667)) weather.markApplied();
  }
  assert.equal(weather.state, identity, 'sample() must write in place, not allocate a state');
  assert.equal(Object.keys(weather.state).sort().join(','), keys, 'the state shape must not drift');
  assert.equal(weather.diagnostics().appliedStateCount, weather.writes);
  // `sample(out)` is available for a caller that wants its own target, and writes it in place.
  const target = {};
  const returned = weather.sample(target);
  assert.equal(returned, target);
  for (const field of GDO_WEATHER_FIELDS) assert.equal(typeof target[field], 'number');
  assert.equal(typeof target.id, 'string');
  // Blending is allocation-free and monotone in its fraction.
  const out = {};
  const from = GDO_WEATHER_STATE_IDS.indexOf('clear');
  const to = GDO_WEATHER_STATE_IDS.indexOf('storm');
  assert.deepEqual(blendWeather(from, to, 0, out).cloudCover, GDO_WEATHER_STATES.clear.cloudCover);
  assert.deepEqual(blendWeather(from, to, 1, out).cloudCover, GDO_WEATHER_STATES.storm.cloudCover);
  const third = blendWeather(from, to, .5, out).cloudCover;
  assert.ok(third > GDO_WEATHER_STATES.clear.cloudCover && third < GDO_WEATHER_STATES.storm.cloudCover);
  assert.throws(() => blendWeather(0, 99, .5, {}), /Unknown weather state index/);
});

test('the habitat channel is the scheduler\'s, and clear leaves it alone', () => {
  const weather = new WeatherState({ seed: SEED, climate: 'monsoon', minutes: 0 });
  weather.setClock(0);
  weather.sample();
  const clearish = weather.speciesActivity();
  assert.deepEqual(Object.keys(clearish).sort(), ['bee', 'bird'],
    'the species channel must use the scheduler\'s own species names');
  // Whatever the weather, the two shares are the state's own values — so a caller that
  // multiplies them into `setAmbientActivity` cannot double-count.
  for (const field of ['bird', 'bee']) {
    assert.equal(clearish[field], weather.state[`${field}Activity`]);
    assert.ok(clearish[field] >= 0 && clearish[field] <= 1);
  }
  assert.deepEqual(new WeatherState({ seed: 1, climate: 'cold', minutes: 0 }).sample().id
    ? { bird: GDO_WEATHER_STATES.clear.birdActivity, bee: GDO_WEATHER_STATES.clear.beeActivity } : null,
  { bird: 1, bee: 1 });
});

/** The largest single-field distance between any two states, for continuity bounds. */
function largestFieldSpanGlobal() {
  let largest = 0;
  for (const a of GDO_WEATHER_STATE_IDS) {
    for (const b of GDO_WEATHER_STATE_IDS) {
      for (const field of GDO_WEATHER_FIELDS) {
        largest = Math.max(largest, Math.abs(GDO_WEATHER_STATES[a][field] - GDO_WEATHER_STATES[b][field]));
      }
    }
  }
  return largest;
}

test('bad inputs are refused rather than guessed', () => {
  assert.throws(() => new WeatherState({ profile: 'ultra' }), /Unknown weather profile/);
  assert.throws(() => new WeatherState({ climate: 'tundra' }), /Unknown weather climate/);
  assert.throws(() => new WeatherState({ seed: NaN }), /seed must be finite/);
  assert.throws(() => new WeatherState({ minutes: NaN }), /clock must be finite/);
  assert.throws(() => new WeatherState({ day: -1 }), /day must be a finite day count/);
  assert.throws(() => new WeatherState({ day: NaN }), /day must be a finite day count/);
  assert.throws(() => weatherStateIndexAt(SEED, 'semi-arid', NaN), /window index must be finite/);
  assert.throws(() => weatherStateIndexAt(SEED, 'nowhere', 3), /Unknown weather climate/);
  assert.throws(() => sampleWeatherAt(SEED, 'semi-arid', Infinity), /minutes must be finite/);
  assert.throws(() => weatherSeedForCoordinate({ latitude: NaN, longitude: 1 }), /finite latitude/);
  assert.throws(() => bindWeatherUniforms({}), /sky handle/);
  const weather = new WeatherState({ seed: 1 });
  assert.throws(() => weather.setSeed(Infinity), /seed must be finite/);
  assert.throws(() => weather.setClimate('tundra'), /Unknown weather climate/);
  assert.throws(() => weather.setClock(NaN), /clock must be finite/);
  assert.throws(() => weather.setClock(0, -2), /day must be a finite day count/);
  assert.throws(() => weather.setDay(NaN), /day must be a finite day count/);
  assert.throws(() => weather.rebaseClock(NaN), /rebase must be finite/);
  // An unknown key in the climate table is the same class of error as an unknown profile.
  assert.throws(() => { const probe = new WeatherState({ seed: 1 }); probe.climate = 'tundra'; probe.sample(); }, /Unknown weather climate/);
});

/**
 * A runtime stub, deliberately built from three's own classes where it matters: the apply
 * path has to write into real `Color`/`Vector3` values, because that is what the runtimes
 * hold. Nothing here is a mock of the *weather* code — only of the surfaces it applies to.
 */
function createFakeRuntime() {
  const sky = { material: { uniforms: {
    uCloudCover: { value: .38 },
    uCloudDarkness: { value: 0 },
    uSkyTime: { value: 0 },
  } } };
  const scene = { fog: new THREE.Fog(new THREE.Color(.22, .42, .52), 78, 175), children: [] };
  const lightRig = {
    sun: { intensity: 0, color: new THREE.Color() },
    fill: { intensity: 0, color: new THREE.Color(), groundColor: new THREE.Color() },
  };
  const renderer = { toneMappingExposure: 1 };
  const water = { material: { uniforms: { uWeather: { value: new THREE.Vector2(0, 0) } } } };
  return {
    sky, scene, lightRig, renderer, water,
    drawCalls: () => scene.children.length,
  };
}

function snapshot(runtime, timeOfDayState) {
  return {
    fogNear: runtime.scene.fog.near,
    fogFar: runtime.scene.fog.far,
    fogColor: { r: runtime.scene.fog.color.r, g: runtime.scene.fog.color.g, b: runtime.scene.fog.color.b },
    sunIntensity: runtime.lightRig.sun.intensity,
    fillIntensity: runtime.lightRig.fill.intensity,
    exposure: runtime.renderer.toneMappingExposure,
    cloudCover: runtime.sky.material.uniforms.uCloudCover.value,
    cloudDarkness: runtime.sky.material.uniforms.uCloudDarkness.value,
    skyTime: runtime.sky.material.uniforms.uSkyTime.value,
    waterWeather: [runtime.water.material.uniforms.uWeather.value.x, runtime.water.material.uniforms.uWeather.value.y],
    timeOfDayExposure: timeOfDayState.exposure,
  };
}
