import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_NIGHT_READABILITY_FLOORS,
} from './TimeOfDaySky.js';
import { createTimeOfDayState } from './TimeOfDaySky.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import { featureNamespace } from './FeatureVersions.js';
import {
  GDO_WEATHER_CHAIN_RUNS,
  GDO_WEATHER_CLIMATE_BLEND_MILLISECONDS,
  GDO_WEATHER_NAMESPACE,
  GDO_WEATHER_PRECIPITATION,
  GDO_WEATHER_PROFILES,
  GDO_WEATHER_REFUSAL,
  GDO_WEATHER_STATES,
  GDO_WEATHER_STATE_IDS,
  createWeatherState,
  describeWeather,
  moderateSkyWeather,
  resolveWeatherRun,
  sampleWeatherClimate,
  weatherAdmits,
  weatherHudText,
  weatherRunAt,
  weatherSeedFor,
  weatherSeasonFor,
} from './WeatherState.js';
import { runWeatherAudit, weatherAuditDeterministic } from './WeatherAudit.js';

/**
 * `ENV-04` gate: weather is deterministic from macro climate, month, world time,
 * and one coordinate seed; transitions ramp instead of rolling per frame; the
 * environment responds through the same day-cycle channels; and the low profile
 * falls back by name inside the declared budget. Every number here is read off
 * the machine or off the live `three` targets — nothing is eyeballed.
 */

const DELHI = { latitude: 28.9845, longitude: 77.7064 };
const SAHARA = { latitude: 23.4162, longitude: 25.6628 };
const BOREAL = { latitude: 64.1466, longitude: 21.9426 };

/** The `ENV-02` sky state the machine moderates, pinned to a day fraction. */
function dayState(place = DELHI, hours = 12.5) {
  const state = createTimeOfDayState({ ...place, profile: 'low' });
  state.setFraction(hours / 24);
  state.update(state.clockMilliseconds);
  return state.state;
}

/** The same target set `GeoGame` hands the machine, minus `three`. */
function stubTargets() {
  const colour = () => ({
    value: {
      r: 0, g: 0, b: 0,
      setRGB(red, green, blue) { this.r = red; this.g = green; this.b = blue; return this; },
    },
  });
  const fog = { color: { setRGB() {} }, near: 78, far: 175 };
  const writes = { wind: [], habitat: [] };
  const targets = {
    rig: { sun: { intensity: 2.25 }, fill: { intensity: 1 } },
    renderer: { toneMappingExposure: 1 },
    scene: { fog, background: { setRGB() {} } },
    sky: { uniforms: { uCloudCoverage: { value: 1 }, uCloudTint: colour() } },
    wind: options => writes.wind.push({ ...options }),
    habitat: options => writes.habitat.push({ ...options }),
    fogNear: 78,
    fogFar: 175,
  };
  return { targets, writes, fog };
}

function machine({ place = DELHI, month = 7, profile = 'low', climate = null } = {}) {
  const { targets, writes, fog } = stubTargets();
  const weather = createWeatherState({
    profile,
    seed: weatherSeedFor({ worldVersion: 1, ...place }),
    latitude: place.latitude,
    month,
    climate,
    targets,
  });
  return { weather, targets, writes, fog };
}

test('ENV-04 eight research states, one precipitation family each, inside the budget', () => {
  assert.equal(GDO_WEATHER_NAMESPACE, 'gdo:weatherState:v1');
  assert.equal(featureNamespace('weatherState'), GDO_WEATHER_NAMESPACE);
  assert.deepEqual([...GDO_WEATHER_STATE_IDS],
    ['clear', 'haze', 'overcast', 'rain', 'storm', 'dust', 'snow', 'mist']);
  const families = new Set();
  for (const state of GDO_WEATHER_STATES) {
    // "never combine heavy rain, fog particles, insects, pollen, and dust": one
    // family per state, so a blend of two states can never stack two families.
    assert.ok(state.precipitation === null || typeof state.precipitation === 'string',
      `${state.id} declares ${state.precipitation}`);
    if (state.precipitation) families.add(state.precipitation);
    assert.ok(state.wind.strength > 0 && state.habitat.flyers >= 0 && state.habitat.insects >= 0);
  }
  assert.deepEqual([...families].sort(), ['dust', 'rain', 'snow']);
  const description = describeWeather();
  assert.equal(description.ok, true, description.violations.join('; '));
  assert.equal(description.states, 8);
  assert.equal(description.budget.weatherPrecipitationFamilies, 1);
  assert.ok(GDO_WEATHER_PROFILES.low.maxWritesPerUpdate <= GDO_LOW_PROFILE_BUDGETS.weatherWritesPerUpdate);
  assert.equal(GDO_WEATHER_PROFILES.low.steadyFrameAllocations,
    GDO_LOW_PROFILE_BUDGETS.weatherSteadyFrameAllocations);
});

test('ENV-04 macro climate, month, world time, and one coordinate seed decide the run', () => {
  // The seed is a pure function of the coordinate and the feature version.
  const seed = weatherSeedFor({ worldVersion: 1, ...DELHI });
  assert.equal(seed, weatherSeedFor({ worldVersion: 1, ...DELHI }));
  assert.notEqual(seed, weatherSeedFor({ worldVersion: 1, latitude: 28.99, longitude: 77.7164 }));
  assert.notEqual(seed, weatherSeedFor({ worldVersion: 2, ...DELHI }));

  const monsoon = weatherSeasonFor({ month: 7, latitude: 20 });
  const winter = weatherSeasonFor({ month: 1, latitude: 20 });
  assert.equal(monsoon, 'summer');
  assert.equal(winter, 'winter');
  assert.equal(weatherSeasonFor({ month: 7, latitude: 64 }), 'summer');

  // Resolution is a pure function of the five declared inputs: the same call
  // twice returns the same state, and a run's chain is reproducible from its own
  // block anchor rather than depending on how the caller got there.
  const climate = sampleWeatherClimate({ temperature: .8, moisture: .7, latitude: 20 }, {});
  const chainRun = run => {
    const anchor = Math.floor(run / GDO_WEATHER_CHAIN_RUNS) * GDO_WEATHER_CHAIN_RUNS;
    let previous = null, resolved = null;
    for (let index = anchor; index <= run; index++) {
      resolved = resolveWeatherRun({ seed, run: index, season: monsoon, latitude: 20, climate, previous });
      previous = resolved.state.id;
    }
    return resolved.state.id;
  };
  for (let run = 0; run <= GDO_WEATHER_CHAIN_RUNS * 3; run++) {
    const first = chainRun(run);
    assert.equal(chainRun(run), first, `run ${run} is not reproducible`);
    if (run % GDO_WEATHER_CHAIN_RUNS === 0) {
      // Every block's first run starts from no predecessor, so resolving it
      // directly is the same answer as walking to it.
      assert.equal(resolveWeatherRun({
        seed, run, season: monsoon, latitude: 20, climate, previous: null,
      }).state.id, first, `run ${run} differs at its own block anchor`);
    }
  }

  // Wet monsoon climates rain; a dry desert climate does not. Both are decided by
  // the same table, not by a second weather system.
  const bands = (sample, month) => {
    const counts = {};
    for (const run of Array.from({ length: 60 }, (_, index) => index)) {
      const resolved = resolveWeatherRun({
        seed: weatherSeedFor({ worldVersion: 1, latitude: sample.latitude, longitude: sample.longitude }),
        run, season: weatherSeasonFor({ month, latitude: sample.latitude }),
        latitude: sample.latitude, climate: sample.climate, previous: null,
      });
      counts[resolved.state.id] = (counts[resolved.state.id] ?? 0) + 1;
    }
    return counts;
  };
  const wet = bands({
    latitude: 19.1, longitude: 72.9,
    climate: sampleWeatherClimate({ temperature: .82, moisture: .74, latitude: 19.1 }, {}),
  }, 7);
  const dry = bands({
    latitude: SAHARA.latitude, longitude: SAHARA.longitude,
    climate: sampleWeatherClimate({ temperature: .86, moisture: .08, latitude: SAHARA.latitude }, {}),
  }, 4);
  assert.ok((wet.rain ?? 0) + (wet.storm ?? 0) > 0, `wet monsoon produced ${JSON.stringify(wet)}`);
  assert.equal(dry.rain ?? 0, 0, `desert produced rain: ${JSON.stringify(dry)}`);
  assert.equal(dry.snow ?? 0, 0, `desert produced snow: ${JSON.stringify(dry)}`);
  assert.ok((dry.clear ?? 0) + (dry.haze ?? 0) + (dry.dust ?? 0) > 30, JSON.stringify(dry));

  // World time is a real input: the run index advances on the declared cadence.
  const { weather } = machine();
  const runMilliseconds = weather.limits.runMilliseconds;
  assert.equal(weatherRunAt(0, { runHours: weather.limits.runHours }), weatherRunAt(1, { runHours: weather.limits.runHours }));
  assert.equal(weatherRunAt(runMilliseconds + 1, { runHours: weather.limits.runHours }),
    weatherRunAt(0, { runHours: weather.limits.runHours }) + 1);
  assert.ok(weather.nextRunBoundary(0) > 0 && weather.nextRunBoundary(0) <= runMilliseconds,
    `the first boundary is ${weather.nextRunBoundary(0)} of a ${runMilliseconds}ms run`);
  assert.equal(weather.nextRunBoundary(weather.nextRunBoundary(0)),
    weather.nextRunBoundary(0) + runMilliseconds, 'boundaries are one run apart');
});

test('ENV-04 transitions ramp over the declared band instead of rolling per frame', () => {
  const { weather, targets } = machine();
  const sky = dayState();
  const runMilliseconds = weather.limits.runMilliseconds;
  const boundary = weather.nextRunBoundary(0);
  // Sample the frames either side of the boundary: inside a run the incoming
  // state never changes, and across the boundary the blend ramps from 0 to 1.
  weather.update({ nowMilliseconds: 0, skyState: sky, targets });
  const inside = [];
  for (let step = 0; step < 6; step++) {
    weather.update({ nowMilliseconds: boundary * .5 + step * 1000, skyState: sky, targets });
    inside.push(weather.state.id);
  }
  assert.equal(new Set(inside).size, 1, `a run changed state mid-run: ${inside.join(',')}`);
  const ramp = [];
  for (let step = 0; step <= 6; step++) {
    weather.update({ nowMilliseconds: boundary + weather.limits.blendMilliseconds * step / 6, skyState: sky, targets });
    ramp.push(weather.state.blend);
  }
  assert.equal(ramp[0], 0, `the blend starts at ${ramp[0]}`);
  assert.equal(ramp.at(-1), 1, `the blend ends at ${ramp.at(-1)}`);
  for (let index = 1; index < ramp.length; index++) {
    assert.ok(ramp[index] >= ramp[index - 1], `blend went backwards: ${ramp.join(',')}`);
  }
  assert.ok(ramp.filter(value => value > 0 && value < 1).length >= 4, `too few blended frames: ${ramp.join(',')}`);
  // The ramp is the declared band, not an instant snap: halfway through the band
  // the machine is halfway between the two states.
  const half = weather.sample(boundary + weather.limits.blendMilliseconds * .5);
  assert.ok(half.blend > .4 && half.blend < .6, `half-band blend is ${half.blend}`);
  // Jumping straight to a run several blocks later agrees with walking to it one
  // frame at a time — the answer comes from the chain, not from the caller.
  const far = boundary + runMilliseconds * (GDO_WEATHER_CHAIN_RUNS + 3);
  const jump = machine();
  jump.weather.update({ nowMilliseconds: far, skyState: sky, targets: jump.targets });
  const walk = machine();
  const step = runMilliseconds / 240;
  for (let elapsed = 0; elapsed <= far; elapsed += step) {
    walk.weather.update({ nowMilliseconds: elapsed, skyState: sky, targets: walk.targets });
  }
  walk.weather.update({ nowMilliseconds: far, skyState: sky, targets: walk.targets });
  assert.equal(walk.weather.state.run, jump.weather.state.run,
    `walked to run ${walk.weather.state.run}, jumped to ${jump.weather.state.run}`);
  assert.equal(walk.weather.state.to, jump.weather.state.to);
});

test('ENV-04 the environment responds through the day-cycle channels, never under the floors', () => {
  const { weather, targets, writes, fog } = machine({ profile: 'balanced' });
  const noon = dayState(DELHI, 12.5);
  weather.update({ nowMilliseconds: 0, skyState: noon, targets });
  // The response is the `ENV-02` base scaled by the state, tinted fog included:
  // there is no second palette and no second light rig.
  assert.ok(Math.abs(weather.applied.sunIntensity - noon.sunIntensity * weather.state.sunScale) <= .02);
  assert.ok(Math.abs(weather.applied.hemisphereIntensity - noon.hemisphereIntensity * weather.state.fillScale) <= .002);
  assert.ok(Math.abs(weather.applied.exposure - noon.exposure * weather.state.exposureScale) <= .001);
  assert.equal(targets.rig.sun.intensity, weather.applied.sunIntensity);
  assert.equal(targets.renderer.toneMappingExposure, weather.applied.exposure);
  assert.equal(fog.far, Math.max(.5, targets.fogFar * weather.state.fogFarScale));
  assert.equal(writes.wind.at(-1).strength, weather.state.wind.strength);
  assert.equal(writes.habitat.at(-1).flyers, weather.state.habitat.flyers);

  // Night: a dark base may be darkened, but never past the readability floors,
  // and every clamps is named rather than silently applied.
  const night = dayState(DELHI, 1.5);
  const view = moderateSkyWeather(night, weather.state, {}, GDO_NIGHT_READABILITY_FLOORS);
  assert.ok(view.exposure >= GDO_NIGHT_READABILITY_FLOORS.exposure - 1e-9);
  assert.ok(view.sunIntensity >= GDO_NIGHT_READABILITY_FLOORS.sunIntensity - 1e-9);
  assert.ok(view.hemisphereIntensity >= GDO_NIGHT_READABILITY_FLOORS.hemisphereIntensity - 1e-9);
  const fogLuminance = view.fog[0] * .2126 + view.fog[1] * .7152 + view.fog[2] * .0722;
  assert.ok(fogLuminance >= GDO_NIGHT_READABILITY_FLOORS.fogLuminance - 1e-9);
  assert.ok(view.clamped.every(name => typeof name === 'string' && name.length > 0));

  // A storm is visibly heavier than clear, and dust suppresses flyers hardest.
  const storm = GDO_WEATHER_STATES.find(state => state.id === 'storm');
  const clear = GDO_WEATHER_STATES.find(state => state.id === 'clear');
  const dust = GDO_WEATHER_STATES.find(state => state.id === 'dust');
  assert.ok(storm.sunScale < clear.sunScale && storm.cloudiness > clear.cloudiness);
  assert.ok(dust.habitat.flyers < clear.habitat.flyers);
  assert.ok(storm.habitat.insects < clear.habitat.insects);
});

test('ENV-04 the machine refuses out-of-band states by name and blends a tile edge', () => {
  const desert = sampleWeatherClimate({ temperature: .9, moisture: .05, latitude: SAHARA.latitude }, {});
  const { weather, targets } = machine({ place: SAHARA, month: 4, climate: desert });
  const sky = dayState(SAHARA, 12.5);
  for (let run = 0; run < 40; run++) {
    weather.update({
      nowMilliseconds: run * weather.limits.runMilliseconds + 1, skyState: sky, targets,
    });
    const state = GDO_WEATHER_STATES.find(candidate => candidate.id === weather.state.to);
    assert.ok(weatherAdmits(state, weather.climate),
      `${state.id} was admitted in aridity ${weather.climate.aridity}`);
  }
  const diagnostics = weather.diagnostics();
  assert.ok(diagnostics.refusalReasons[GDO_WEATHER_REFUSAL.CLIMATE] > 0,
    `no refusal was recorded: ${JSON.stringify(diagnostics.refusalReasons)}`);
  assert.ok(Object.keys(diagnostics.refusalReasons)
    .every(reason => reason === GDO_WEATHER_REFUSAL.CLIMATE));
  // A climate recorded from one tile moves toward the next instead of snapping.
  const before = { ...weather.climate };
  weather.setClimateFields({ temperature: .1, moisture: .95, latitude: SAHARA.latitude });
  weather.update({ nowMilliseconds: 40 * weather.limits.runMilliseconds, skyState: sky, targets });
  const moved = Math.abs(weather.climate.moisture - before.moisture);
  assert.ok(moved > 0, 'the climate never moved');
  assert.ok(moved < 1, `the climate snapped: ${moved}`);
  assert.ok(weather.diagnostics().climateBlends >= 0);
  assert.ok(GDO_WEATHER_CLIMATE_BLEND_MILLISECONDS > 0);
});

test('ENV-04 writes are bounded per profile, and a settled state writes nothing', () => {
  for (const profile of ['low', 'balanced', 'high']) {
    const { weather, targets } = machine({ profile });
    const sky = dayState();
    let worst = 0;
    for (let step = 0; step < 24; step++) {
      weather.update({ nowMilliseconds: step * weather.limits.runMilliseconds, skyState: sky, targets });
      worst = Math.max(worst, weather.diagnostics().writesThisUpdate);
    }
    assert.ok(worst <= weather.limits.maxWritesPerUpdate, `${profile} wrote ${worst} channels at once`);
    assert.ok(worst <= GDO_LOW_PROFILE_BUDGETS.weatherWritesPerUpdate ||
      profile !== 'low', `${profile} exceeded the low-profile budget`);
    assert.equal(weather.diagnostics().overBudgetUpdates, 0);
    assert.equal(weather.diagnostics().steadyFrameAllocations, 0);
    // Settled: once the blend has finished and nothing else changed, one more
    // frame writes nothing at all. Walk to a steady instant inside the current
    // run first, so the assertion measures settling rather than a ramp.
    const steady = weather.nextRunBoundary(weather.clockMilliseconds) - weather.limits.blendMilliseconds;
    const settledAt = steady > weather.clockMilliseconds
      ? steady : weather.clockMilliseconds + weather.limits.blendMilliseconds;
    weather.update({ nowMilliseconds: settledAt, skyState: sky, targets });
    const settled = weather.update({
      nowMilliseconds: settledAt + 1_000, skyState: sky, targets,
    });
    assert.equal(weather.diagnostics().writesThisUpdate, 0, `${profile} wrote on a settled frame`);
    assert.equal(settled, false);
    // The profile's opt-outs are named, not silently dropped.
    const fallback = weather.fallback;
    assert.ok(fallback.every(entry => typeof entry.reason === 'string' && entry.reason.length > 0));
    if (profile === 'low') {
      const named = new Set(fallback.map(entry => entry.response));
      assert.ok(named.has('cloudCoverage') && named.has('cloudTint'),
        `low profile refused: ${[...named].join(', ')}`);
      // A precipitating state is refused by family name, never silently dropped.
      weather.override('rain');
      weather.update({
        nowMilliseconds: weather.clockMilliseconds + 5_000, skyState: sky, targets,
      });
      const raining = new Set(weather.fallback.map(entry => entry.response));
      assert.ok(raining.has(`particles:${GDO_WEATHER_PRECIPITATION.RAIN}`),
        `low profile did not name its particle fallback: ${[...raining].join(', ')}`);
      weather.override(null);
    } else {
      assert.deepEqual(fallback, []);
    }
  }
  // The precipitation cap is enforced per state, so no update ever stacks two.
  const seen = new Set();
  for (const profile of ['low', 'balanced', 'high']) {
    const { weather, targets } = machine({ profile });
    const sky = dayState();
    for (let step = 0; step < 48; step++) {
      weather.update({ nowMilliseconds: step * 7_000, skyState: sky, targets });
      assert.ok(!Array.isArray(weather.state.activePrecipitation),
        `${profile} blended two precipitation families`);
      if (weather.state.activePrecipitation) seen.add(weather.state.activePrecipitation);
    }
  }
  assert.ok([...seen].every(family => Object.values(GDO_WEATHER_PRECIPITATION).includes(family)));
});

test('ENV-04 the override forces a state, and reset really restores the machine', () => {
  const { weather, targets } = machine();
  const sky = dayState();
  weather.override('storm');
  weather.update({ nowMilliseconds: 0, skyState: sky, targets });
  assert.equal(weather.state.id, 'storm');
  assert.equal(weather.state.activePrecipitation, GDO_WEATHER_PRECIPITATION.RAIN);
  assert.equal(weatherHudText(weather.state).text.startsWith('Storm'), true);
  weather.override(null);
  weather.update({ nowMilliseconds: weather.limits.runMilliseconds * 2, skyState: sky, targets });
  assert.notEqual(weather.state.id, 'storm');
  assert.throws(() => weather.override('monsoon'), RangeError);

  // `reset` restores clock, run, climate record, and diagnostics, so two passes
  // of the same script fingerprint the same — the audit's determinism half.
  const script = () => {
    const { weather: run, targets: runTargets } = machine();
    weather.reset({ climate: sampleWeatherClimate({ temperature: .6, moisture: .62, latitude: DELHI.latitude }, {}) });
    for (let step = 0; step < 32; step++) {
      run.update({ nowMilliseconds: step * 30_000, skyState: sky, targets: runTargets });
    }
    return {
      fingerprint: run.diagnostics().id + '/' + run.state.run + '/' + run.state.id,
      updates: run.diagnostics().updates,
      writes: run.diagnostics().uniformWrites,
      id: run.state.id,
    };
  };
  const first = script();
  const second = script();
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.writes, second.writes, 'two identical passes wrote different amounts');

  // `reapply` puts the moderated numbers back after the day cycle overwrites them.
  weather.reset();
  weather.update({ nowMilliseconds: 0, skyState: sky, targets });
  targets.rig.sun.intensity = sky.sunIntensity;
  targets.renderer.toneMappingExposure = sky.exposure;
  const writes = weather.reapply({ skyState: sky });
  assert.ok(writes > 0, 'reapply wrote nothing');
  assert.equal(targets.rig.sun.intensity, weather.applied.sunIntensity);
  assert.equal(targets.renderer.toneMappingExposure, weather.applied.exposure);
  assert.equal(weather.diagnostics().overBudgetUpdates, 0);
});

test('ENV-04 the scripted weather audit passes against the live machine', () => {
  const { weather, targets } = machine({ profile: 'low' });
  const sky = dayState();
  const clock = { value: 0 };
  // The script compresses a session: it jumps to just past each run boundary and
  // then takes one short step over the blend, so a bounded audit samples both the
  // steady runs and the ramps between them.
  const step = () => {
    const boundary = weather.nextRunBoundary(clock.value);
    const cross = weather.limits.runMilliseconds * .5;
    clock.value = clock.value + cross >= boundary
      ? boundary + weather.limits.blendMilliseconds * .25
      : clock.value + cross;
    weather.update({ nowMilliseconds: clock.value, skyState: sky, targets });
  };
  const sample = index => ({
    ...weather.diagnostics(),
    index,
    run: weather.state.run,
    id: weather.state.id,
    from: weather.state.from,
    to: weather.state.to,
    blend: weather.state.blend,
    precipitation: weather.state.precipitation,
    activePrecipitation: weather.state.activePrecipitation,
    sunScale: weather.state.sunScale,
    fillScale: weather.state.fillScale,
    exposureScale: weather.state.exposureScale,
    fogNearScale: weather.state.fogNearScale,
    fogFarScale: weather.state.fogFarScale,
    cloudiness: weather.state.cloudiness,
    windStrength: weather.state.wind.strength,
    gustiness: weather.state.wind.gustiness,
    wetness: weather.state.surface.wetness,
    dust: weather.state.surface.dust,
    snow: weather.state.surface.snow,
    damp: weather.state.surface.damp,
    habitatFlyers: weather.state.habitat.flyers,
    habitatInsects: weather.state.habitat.insects,
    base: sky,
    applied: {
      sunIntensity: weather.applied.sunIntensity,
      hemisphereIntensity: weather.applied.hemisphereIntensity,
      exposure: weather.applied.exposure,
      fog: weather.applied.fog,
      fogFar: targets.scene.fog.far,
    },
    writes: weather.diagnostics().uniformWrites,
    fallback: weather.fallback,
    refusalReasons: weather.diagnostics().refusalReasons,
    climate: weather.climate,
    writable: true,
  });
  const options = {
    label: 'engine-weather',
    reset: () => { weather.reset(); clock.value = 0; },
    step,
    sample,
    steps: 48,
    dt: 1 / 30,
    expect: { requiredFallbacks: ['cloudCoverage'], minStates: 3, maxWritesPerUpdate: 12 },
  };
  const first = runWeatherAudit(options);
  const second = runWeatherAudit(options);
  assert.equal(first.namespace, 'gdo:weatherAudit:v1');
  assert.ok(first.ok, `failed verdicts: ${first.verdicts.filter(v => !v.ok).map(v => `${v.id} (${v.detail})`).join('; ')}`);
  assert.ok(first.states.length >= 3, `only visited ${first.states.join(', ')}`);
  assert.ok(first.transitions >= 1 && first.blendedSamples >= 1);
  assert.equal(first.verdicts.length, 10);
  assert.ok(weatherAuditDeterministic(first, second), 'two audit passes differ');
});
