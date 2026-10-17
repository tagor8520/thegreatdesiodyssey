import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from './GeoWorld.js';
import { compileGeoFixture } from './GeoFixtures.js';
import { LifecycleLedger } from '../engine/LifecycleContract.js';
import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';
import { GDO_FEATURE_VERSIONS } from '../engine/FeatureVersions.js';
import { createTimeOfDayState } from '../engine/TimeOfDaySky.js';
import { GDO_WEATHER_CLIMATE_FALLBACK, weatherHudText, weatherSeedFor } from '../engine/WeatherState.js';
import { createWeatherAuditRunner } from '../engine/WeatherAudit.js';

/**
 * `ENV-04` gate, live: the coordinate world samples its own `VEG-08` climate and
 * its `TER-07` water, seeds one weather machine from the coordinate and the
 * feature version, and drives the resident `three` targets through real frames —
 * proving "deterministic transitions, environment response, low-profile fallback"
 * without a browser session.
 */

globalThis.Worker ??= class { addEventListener() {} postMessage() {} terminate() {} };

const WORLD_VERSION = GDO_FEATURE_VERSIONS.weatherState;

function mount(fixtureId = 'dense-urban', { profile = 'low' } = {}) {
  const scene = new THREE.Scene();
  const ledger = new LifecycleLedger({ label: `env-04-${fixtureId}` });
  const world = new GeoWorld(scene, {
    latitude: 28.9845, longitude: 77.7064, ledger, profile,
  });
  const tile = [...world.tiles.values()][0];
  const compilation = compileGeoFixture(fixtureId, 'openmaptiles');
  const common = {
    type: 'tile-phase', requestId: tile.requestId, key: tile.key, bytes: 2048,
    provider: `Fixture/${compilation.fixture.variant}`, providerId: 'openmaptiles',
  };
  world._handleWorkerMessage({
    ...common, phase: 'roads', geometry: compilation.roads,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2 },
  });
  world._handleWorkerMessage({
    ...common, phase: 'context', context: compilation.context,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3 },
  });
  world._handleWorkerMessage({
    ...common, phase: 'buildings', geometry: compilation.buildings,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3, buildingsMilliseconds: 4, totalMilliseconds: 10 },
  });
  world._flushPlantMounts(0);
  return { world, scene, tile, compilation, ledger };
}

/**
 * The `GeoGame` target set, minus `three`: a real sky dome substitute carrying the
 * uniforms `ProceduralEngine` installs, the same fog range the game uses, and the
 * pool handles the world wires.
 */
function attachTargets(world, scene) {
  const tint = new THREE.Color(1, 1, 1);
  const sky = {
    uniforms: {
      uCloudCoverage: { value: 1 },
      uCloudTint: { value: tint },
    },
  };
  const rig = { sun: { intensity: 2.25 }, fill: { intensity: 1 } };
  const renderer = { toneMappingExposure: 1 };
  scene.fog = new THREE.Fog(0x223344, 78, 175);
  const wind = [];
  const habitat = [];
  world.setWeatherTargets({
    rig, renderer, scene, sky, fogNear: 78, fogFar: 175,
    wind: options => { wind.push({ ...options }); world.configurePlantWind(options); },
    habitat: options => { habitat.push({ ...options }); world.weatherHabitat = options; },
  });
  return { rig, renderer, sky, tint, wind, habitat };
}

test('ENV-04 the world seeds one machine from the coordinate and the feature version', () => {
  const { world, scene, ledger } = mount('dense-urban');
  try {
    assert.equal(world.weather.namespace, 'gdo:weatherState:v1');
    assert.equal(world.weather.seed, weatherSeedFor({
      worldVersion: WORLD_VERSION, latitude: 28.9845, longitude: 77.7064,
    }));
    assert.equal(world.weather.profile, 'low');
    // The climate is the resident world's own sample: an environment summary plus
    // the water query, not a table copied out of the research document.
    const climate = world.weatherClimateAt(0, 0);
    assert.equal(climate.source, 'environment-summary-v1');
    assert.ok(climate.temperature > 0 && climate.temperature < 1, `temperature ${climate.temperature}`);
    assert.ok(climate.moisture > 0 && climate.moisture < 1, `moisture ${climate.moisture}`);
    assert.ok(climate.aridity >= 0 && climate.aridity <= 1, `aridity ${climate.aridity}`);
    assert.equal(climate, world.weatherClimateAt(0, 0), 'the sample record is reused, never reallocated');
    // Standing water raises the moisture the machine sees, exactly as `VEG-08`
    // does for plants; a dry sample is the documented fallback, not a guess.
    const dry = world.weatherClimateAt(400, 400);
    assert.ok(dry.moisture <= climate.moisture + .3);
    assert.ok(GDO_WEATHER_CLIMATE_FALLBACK.moisture > 0);
    assert.ok(world.stats.weatherId === world.weather.state.id);
  } finally {
    world.dispose();
    ledger.disposeAll();
    scene.clear();
  }
});

test('ENV-04 the response reaches the real sky, rig, fog, plants, and ambient life', () => {
  const { world, scene, ledger } = mount('dense-urban');
  try {
    const targets = attachTargets(world, scene);
    const camera = new THREE.PerspectiveCamera(68, 16 / 9, .02, 210);
    const position = new THREE.Vector3(0, 1.7, 0);
    const day = createTimeOfDayState({ latitude: 28.9845, longitude: 77.7064, profile: 'low' });
    day.setFraction(12.5 / 24);
    day.update(day.clockMilliseconds);
    world.setWeatherSkyState(day.state);
    // Force a real transition so the response is measurable rather than whatever
    // state the coordinate happened to seed.
    world.weather.override('storm');
    world.update(position, camera, 720, 0);
    world.weather.override(null);
    world.update(position, camera, 720, world.weather.limits.blendMilliseconds * 4);
    const sample = world.weatherSample(0);
    assert.equal(sample.writable, true);
    assert.ok(targets.wind.length > 0, 'the plant wind pool was never configured');
    assert.ok(targets.habitat.length > 0, 'the habitat response never reached the world');
    assert.equal(targets.rig.sun.intensity, sample.applied.sunIntensity);
    assert.equal(targets.renderer.toneMappingExposure, sample.applied.exposure);
    assert.equal(scene.fog.far, Math.max(.5, 175 * sample.fogFarScale));
    assert.equal(world.weatherHabitat.flyers, sample.habitatFlyers);
    assert.equal(world.weatherHabitatResponse.bird, sample.habitatFlyers);
    assert.ok(world.weatherHabitatResponse.bird <= 1 && world.weatherHabitatResponse.bird >= 0);
    assert.ok(world.weatherHabitatResponse.bee <= 1 && world.weatherHabitatResponse.bee >= 0);
    // The sky's cloud coverage and tint carry the state, not the profile default.
    assert.ok(targets.sky.uniforms.uCloudCoverage.value >= 0);
    assert.ok(targets.sky.uniforms.uCloudTint.value.r >= 0);
    // The `ENV-02` day cycle writes the same channels; one bounded re-apply puts
    // the moderated numbers back — and it stays inside the write budget.
    targets.rig.sun.intensity = day.state.sunIntensity;
    const writes = world.reapplyWeather();
    assert.ok(writes > 0, 'reapply wrote nothing');
    assert.equal(targets.rig.sun.intensity, sample.applied.sunIntensity);
    assert.equal(world.weather.diagnostics().overBudgetUpdates, 0);
  } finally {
    world.dispose();
    ledger.disposeAll();
    scene.clear();
  }
});

test('ENV-04 the world keeps the profile budget and refuses unsupported responses by name', () => {
  const { world, scene, ledger } = mount('dense-urban');
  try {
    const camera = new THREE.PerspectiveCamera(68, 16 / 9, .02, 210);
    const position = new THREE.Vector3(0, 1.7, 0);
    const day = createTimeOfDayState({ latitude: 28.9845, longitude: 77.7064, profile: 'low' });
    world.setWeatherSkyState(day.state);
    // Headless: the world has no game targets, so the sun/fog/sky responses are
    // named as unsupported instead of silently writing into nothing.
    const bare = world.weatherSample(0);
    assert.equal(bare.writable, false);
    assert.ok(world.weather.fallback.every(entry => typeof entry.reason === 'string'));
    const targets = attachTargets(world, scene);
    for (let step = 0; step < 12; step++) {
      day.setClock(step * 4_000);
      day.update(day.clockMilliseconds);
      world.setWeatherSkyState(day.state);
      world.update(position, camera, 720, step * world.weather.limits.runMilliseconds);
      const diagnostics = world.weather.diagnostics();
      assert.ok(diagnostics.writesThisUpdate <= GDO_LOW_PROFILE_BUDGETS.weatherWritesPerUpdate,
        `wrote ${diagnostics.writesThisUpdate} channels at once`);
      assert.equal(Array.isArray(world.weatherSample(0).activePrecipitation), false,
        'a frame blended two precipitation families');
    }
    assert.equal(world.weather.diagnostics().overBudgetUpdates, 0);
    // The three declared budget keys, read straight off the world's own surface.
    assert.ok(world.stats.weatherWritesPerUpdate <= GDO_LOW_PROFILE_BUDGETS.weatherWritesPerUpdate,
      `the last update wrote ${world.stats.weatherWritesPerUpdate} channels`);
    assert.ok(world.stats.weatherPrecipitationFamilies <= GDO_LOW_PROFILE_BUDGETS.weatherPrecipitationFamilies,
      `${world.stats.weatherPrecipitationFamilies} precipitation families were active`);
    assert.equal(world.stats.weatherSteadyFrameAllocations,
      GDO_LOW_PROFILE_BUDGETS.weatherSteadyFrameAllocations);
    // The low profile's opt-outs are named in the fallback record.
    const named = new Set(world.weather.fallback.map(entry => entry.response));
    assert.ok(named.has('cloudCoverage') && named.has('cloudTint'), `refused: ${[...named].join(', ')}`);
    assert.ok(targets.wind.length > 0, 'wind still reached the world pool on the low profile');
    assert.ok(world.weather.limits.maxWritesPerUpdate <= GDO_LOW_PROFILE_BUDGETS.weatherWritesPerUpdate);
  } finally {
    world.dispose();
    ledger.disposeAll();
    scene.clear();
  }
});

test('ENV-04 the scripted weather audit passes against the live world', () => {
  const { world, scene, ledger } = mount('dense-urban');
  try {
    const targets = attachTargets(world, scene);
    const camera = new THREE.PerspectiveCamera(68, 16 / 9, .02, 210);
    const position = new THREE.Vector3(0, 1.7, 0);
    const day = createTimeOfDayState({ latitude: 28.9845, longitude: 77.7064, profile: 'low' });
    const clock = { value: 0 };
    const sky = {
      horizon: [0, 0, 0], middle: [0, 0, 0], zenith: [0, 0, 0], fog: [0, 0, 0],
      sun: [0, 0, 0], hemisphere: [0, 0, 0], ground: [0, 0, 0],
      sunDirection: [0, 1, 0], moonDirection: [0, -1, 0],
    };
    const audit = createWeatherAuditRunner({
      label: 'coordinate-weather',
      reset: () => {
        // A run must be independent of the last one: machine, clock, and day cycle
        // all return to their start state.
        clock.value = 0;
        world.weather.reset();
        day.setClock(0);
        // `sampleNow` answers for the scripted instant without the runtime write
        // cadence, so a second pass replays the first one exactly.
        world.setWeatherSkyState(day.sampleNow(sky));
      },
      step: ({ dt }) => {
        const boundary = world.weather.nextRunBoundary(clock.value);
        const cross = world.weather.limits.runMilliseconds * .5;
        clock.value = clock.value + cross >= boundary
          ? boundary + world.weather.limits.blendMilliseconds * .25
          : clock.value + cross;
        day.setClock(clock.value);
        world.setWeatherSkyState(day.sampleNow(sky));
        world.update(position, camera, 720, clock.value);
      },
      sample: index => {
        const record = world.weatherSample(index);
        const hud = weatherHudText(world.weather.state);
        return {
          ...record,
          hudText: hud.text,
          hudTracksCurrent: hud.text.startsWith(hud.label) && hud.detail.length > 0,
        };
      },
      expect: {
        requiredFallbacks: ['cloudCoverage'],
        minStates: 3,
        maxWritesPerUpdate: GDO_LOW_PROFILE_BUDGETS.weatherWritesPerUpdate,
        fogFar: 175,
      },
    });
    const report = audit.run({ steps: 48, repeat: 2 });
    assert.equal(report.ok, true,
      `${report.detail} :: ${report.verdicts.filter(v => !v.ok).map(v => `${v.id} (${v.detail})`).join('; ')}`);
    assert.equal(report.verdicts.length, 10);
    assert.deepEqual(report.verdicts.map(verdict => verdict.id), [
      'states-visited', 'runs-hold', 'transitions-blended', 'environment-response',
      'precipitation-capped', 'readability-floor', 'low-profile-fallback', 'budget',
      'deterministic', 'climate-band',
    ]);
    assert.equal(report.seed, world.weather.seed);
    assert.equal(report.transitions >= 1, true);
    assert.equal(report.blendedSamples >= 1, true);
    assert.ok(report.samples.every(sample => sample.hudTracksCurrent ?? true));
    assert.match(audit.summary(), /gdo:weatherAudit:v1 pass/);
    assert.equal(targets.wind.length > 0, true);
  } finally {
    world.dispose();
    ledger.disposeAll();
    scene.clear();
  }
});
