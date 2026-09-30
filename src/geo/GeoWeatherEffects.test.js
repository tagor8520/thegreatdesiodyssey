import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from './GeoWorld.js';
import { compileGeoFixture } from './GeoFixtures.js';
import { LifecycleLedger } from '../engine/LifecycleContract.js';
import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';
import { GDO_FEATURE_VERSIONS } from '../engine/FeatureVersions.js';
import {
  GDO_WEATHER_EFFECT_FAMILIES, GDO_WEATHER_EFFECT_PROFILES, weatherEffectHudText,
} from '../engine/WeatherEffects.js';
import { GDO_WEATHER_PRECIPITATION } from '../engine/WeatherState.js';

/**
 * `ENV-05` gate, live: the mounted coordinate world draws exactly one
 * camera-local precipitation family, with the profile's own particle cap, one
 * draw call, an opaque dithered material, a measured screen/overdraw report, and
 * a uniform-only water response — and it disposes all of it.
 */

globalThis.Worker ??= class { addEventListener() {} postMessage() {} terminate() {} };

function mount(fixtureId = 'dense-urban', { profile = 'low' } = {}) {
  const scene = new THREE.Scene();
  const ledger = new LifecycleLedger({ label: `env-05-${fixtureId}` });
  const world = new GeoWorld(scene, { latitude: 28.9845, longitude: 77.7064, ledger, profile });
  const tile = [...world.tiles.values()][0];
  const compilation = compileGeoFixture(fixtureId, 'openmaptiles');
  const common = {
    type: 'tile-phase', requestId: tile.requestId, key: tile.key, bytes: 2048,
    provider: `Fixture/${compilation.fixture.variant}`, providerId: 'openmaptiles',
  };
  world._handleWorkerMessage({ ...common, phase: 'roads', geometry: compilation.roads, timings: { fetchMilliseconds: 1, roadsMilliseconds: 2 } });
  world._handleWorkerMessage({ ...common, phase: 'context', context: compilation.context, timings: { fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3 } });
  world._handleWorkerMessage({
    ...common, phase: 'buildings', geometry: compilation.buildings,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3, buildingsMilliseconds: 4, totalMilliseconds: 10 },
  });
  world._flushPlantMounts(0);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, .1, 400);
  camera.position.set(50, 1.6, 50);
  camera.lookAt(60, 1.4, 60);
  camera.updateMatrixWorld(true);
  return { world, scene, tile, ledger, camera };
}

function drive(world, { steps = 60, camera = null, clock = 0, dt = 1 / 30 } = {}) {
  let time = clock;
  for (let index = 0; index < steps; index++) {
    time += dt * 1_000;
    world.update({ x: 50, y: 0, z: 50 }, camera, 720, time);
  }
  return time;
}

test('ENV-05 the mounted world draws the family the live weather state reports', () => {
  const { world, scene, ledger, camera } = mount('dense-urban');
  try {
    const effects = world.weatherEffects;
    assert.ok(effects, 'the world owns the effects pool');
    assert.equal(effects.mesh.parent, world.root, 'particles live in the world root');
    assert.equal(effects.material.transparent, false, 'weather particles never blend');
    assert.equal(effects.material.depthWrite, true);
    assert.equal(effects.diagnostics.steadyFrameAllocations, 0);

    // Clear weather: the family is absent and the pool draws nothing.
    world.weather.override('clear');
    drive(world, { steps: 30, camera });
    assert.equal(world.weatherEffects.diagnostics.family, null);
    assert.equal(world.weatherEffects.diagnostics.particles, 0);
    assert.equal(world.weatherEffects.geometry.instanceCount, 0);
    assert.equal(world.stats.weatherParticles, 0);

    // Rain: the pool follows the live state, and the surface response reaches the
    // water material through its weather-owned uniforms alone.
    world.weather.override('rain');
    drive(world, { steps: 40, camera });
    const diagnostics = world.weatherEffects.diagnostics;
    assert.equal(diagnostics.family, GDO_WEATHER_PRECIPITATION.RAIN);
    assert.ok(diagnostics.particles > 0);
    assert.ok(diagnostics.particles <= GDO_LOW_PROFILE_BUDGETS.weatherParticles);
    assert.equal(diagnostics.draws, 1);
    assert.equal(diagnostics.alphaMode, 'dither');
    assert.equal(diagnostics.blended, false);
    assert.equal(diagnostics.collides, false);
    assert.equal(diagnostics.castsLight, false);
    assert.ok(world.weatherSurface.ripples, 'rain ripples the water');
    assert.ok(world.waterMaterial.uniforms.uWeatherRipple.value > 1);
    assert.ok(world.waterMaterial.uniforms.uWeatherWetness.value > .4);
    assert.ok(world.waterMaterial.uniforms.uShoreWet.value > 0);
    assert.equal(world.waterMaterial.transparent, false, 'the low water path stays opaque');

    // One draw family in the scene, whatever the weather does.
    const particleMeshes = scene.children.flatMap(child => child.children ?? []).filter(child => child.name === 'weather-particles');
    assert.equal(particleMeshes.length, 1);
  } finally {
    world.dispose();
    ledger.disposeAll();
  }
  assert.equal(ledger.snapshot().total, 0);
  assert.equal(ledger.snapshot().failures, 0);
});

test('ENV-05 the world measures its own screen/overdraw cost and honours reduced motion', () => {
  const { world, ledger, camera } = mount('dense-urban');
  try {
    world.weather.override('storm');
    drive(world, { steps: 40, camera });
    const viewportPixels = 1280 * 720;
    const coverage = world.weatherEffects.measureCoverage({ viewportPixels });
    assert.equal(coverage.ok, true, coverage.reasons.join('; '));
    assert.equal(coverage.profile, 'low');
    assert.ok(coverage.particlePixels > 0);
    assert.ok(coverage.coverage * 100 <= GDO_WEATHER_EFFECT_PROFILES.low.coveragePercent);
    assert.equal(coverage.draws, 1);
    assert.equal(coverage.overdrawLayers, 1);
    assert.equal(world.stats.weatherEffectCoverage?.ok, true);

    // Reduced motion drops the field and names the reason.
    world.setReducedMotion(true);
    drive(world, { steps: 20, camera });
    assert.equal(world.weatherEffects.diagnostics.particles, 0);
    assert.equal(world.weatherEffects.diagnostics.reducedMotion, true);
    const fallbacks = world.weatherEffects.fallbacks();
    assert.ok(fallbacks.some(entry => entry.reason === 'reduced-motion'));
    world.setReducedMotion(false);
  } finally {
    world.dispose();
    ledger.disposeAll();
  }
});

test('ENV-05 the world reports the effect line and refuses an inactive family cost', () => {
  const { world, ledger, camera } = mount('mapped-coast');
  try {
    world.weather.override('snow');
    drive(world, { steps: 40, camera });
    const diagnostics = world.weatherEffects.diagnostics;
    assert.ok(GDO_WEATHER_EFFECT_FAMILIES.includes(diagnostics.family));
    const text = weatherEffectHudText(diagnostics, world.weatherSurface);
    assert.match(text.title, /particles$/);
    assert.match(text.detail, /1 draw · dither/);
    // A viewport that cannot be measured is a refusal, not a pass.
    const refused = world.weatherEffects.measureCoverage({ viewportPixels: 0 });
    assert.equal(refused.ok, false);
    assert.match(refused.reasons.join('; '), /viewportPixels must be measured/);
    // `ENV-05` is versioned like every other response owner.
    assert.equal(GDO_FEATURE_VERSIONS.weatherEffects, 1);
  } finally {
    world.dispose();
    ledger.disposeAll();
  }
  assert.equal(ledger.snapshot().total, 0);
});
