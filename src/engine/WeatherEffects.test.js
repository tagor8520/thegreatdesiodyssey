import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_WEATHER_EFFECTS, GDO_WEATHER_EFFECT_FAMILIES, GDO_WEATHER_EFFECT_PROFILES,
  GDO_WEATHER_EFFECTS_NAMESPACE, applyWeatherSurface, createWeatherEffects,
  validateWeatherEffects, weatherEffectCoverage, weatherEffectFor, weatherEffectHudText,
  weatherSurfaceResponse,
} from './WeatherEffects.js';
import { GDO_WEATHER_PRECIPITATION } from './WeatherState.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import { createWaterVisualMaterial, createWaterVisualPolicy } from './WaterVisualClasses.js';
import { acquireProceduralMaterialLibrary } from './ProceduralMaterials.js';
import { LifecycleLedger } from './LifecycleContract.js';

const WEATHER_VIEW = (family, surface) => ({
  activePrecipitation: family,
  precipitation: family,
  blend: 1,
  surface: { wetness: 0, dust: 0, snow: 0, damp: .4, ...surface },
});

function sceneWithDither() {
  const handle = acquireProceduralMaterialLibrary();
  const scene = new THREE.Scene();
  return { scene, library: handle.library, handle, ditherUniform: { value: handle.library.textures.dither } };
}

test('ENV-05 every precipitation family has one alpha-tested effect and the low path equals the budget', () => {
  const report = validateWeatherEffects();
  assert.deepEqual(report.violations, []);
  assert.equal(report.ok, true);
  assert.equal(report.families, 3);
  // One effect per family, and every family the weather machine can activate.
  assert.deepEqual([...GDO_WEATHER_EFFECT_FAMILIES].sort(), Object.values(GDO_WEATHER_PRECIPITATION).sort());
  for (const family of GDO_WEATHER_EFFECT_FAMILIES) {
    const effect = weatherEffectFor(family);
    assert.equal(effect.family, family);
    assert.ok(['dither', 'alpha-test'].includes(effect.alphaMode), `${family} is alpha-tested`);
    assert.equal(Object.isFrozen(effect), true);
  }
  assert.equal(weatherEffectFor('fog'), null, 'an unknown family has no effect to draw');
  // The low profile's own numbers are the shipped keys, not a parallel table.
  const low = GDO_WEATHER_EFFECT_PROFILES.low;
  assert.equal(low.particles, GDO_LOW_PROFILE_BUDGETS.weatherParticles);
  assert.equal(low.draws, GDO_LOW_PROFILE_BUDGETS.weatherParticleDrawsPerFamily);
  assert.equal(low.overdrawLayers, GDO_LOW_PROFILE_BUDGETS.weatherEffectOverdrawLayers);
  assert.equal(low.coveragePercent, GDO_LOW_PROFILE_BUDGETS.weatherEffectCoveragePercent);
  assert.equal(low.steadyFrameAllocations, GDO_LOW_PROFILE_BUDGETS.weatherEffectSteadyFrameAllocations);
  for (const profile of Object.values(GDO_WEATHER_EFFECT_PROFILES)) {
    assert.equal(profile.blended, false, `${profile.profile} never blends`);
    assert.equal(profile.depthWrite, true);
    assert.equal(profile.castsLight, false);
    assert.equal(profile.collides, false);
  }
});

test('ENV-05 the validator refuses a blended family, a doubled family, and a raised ceiling', () => {
  const blended = validateWeatherEffects({
    effects: { ...GDO_WEATHER_EFFECTS, rain: { ...GDO_WEATHER_EFFECTS.rain, alphaMode: 'blend' } },
  });
  assert.equal(blended.ok, false);
  assert.match(blended.violations.join('; '), /rain uses blend/);

  const doubled = validateWeatherEffects({
    effects: { ...GDO_WEATHER_EFFECTS, snow: { ...GDO_WEATHER_EFFECTS.snow, family: 'rain' } },
  });
  assert.equal(doubled.ok, false);
  assert.match(doubled.violations.join('; '), /declared twice|wrong family/);

  const raised = validateWeatherEffects({
    profiles: { ...GDO_WEATHER_EFFECT_PROFILES, low: { ...GDO_WEATHER_EFFECT_PROFILES.low, particles: 400 } },
  });
  assert.equal(raised.ok, false);
  assert.match(raised.violations.join('; '), /weatherParticles=400/);

  const cheaper = validateWeatherEffects({
    profiles: { ...GDO_WEATHER_EFFECT_PROFILES, balanced: { ...GDO_WEATHER_EFFECT_PROFILES.balanced, blended: true } },
  });
  assert.equal(cheaper.ok, false);
  assert.match(cheaper.violations.join('; '), /balanced blends its weather particles/);
});

test('ENV-05 the screen/overdraw report refuses what it cannot measure', () => {
  const unmeasured = weatherEffectCoverage({ profile: 'low', family: 'rain', particlePixels: 100, viewportPixels: 0 });
  assert.equal(unmeasured.ok, false);
  assert.deepEqual(unmeasured.reasons, ['viewportPixels must be measured']);

  const passing = weatherEffectCoverage({
    profile: 'low', family: 'rain', particlePixels: 60_000, viewportPixels: 900_000, draws: 1, overdrawLayers: 1,
  });
  assert.equal(passing.ok, true);
  assert.ok(Math.abs(passing.coverage - 60_000 / 900_000) < 1e-9);

  const tooMuch = weatherEffectCoverage({
    profile: 'low', family: 'rain', particlePixels: 300_000, viewportPixels: 900_000, draws: 1, overdrawLayers: 1,
  });
  assert.equal(tooMuch.ok, false);
  assert.match(tooMuch.reasons.join('; '), /screen coverage exceeds 14%/);

  // An inactive family that still paints pixels, a second draw, and a second
  // layer are all refusals rather than silent passes.
  assert.equal(weatherEffectCoverage({ profile: 'low', family: null, particlePixels: 10, viewportPixels: 900_000 }).ok, false);
  assert.equal(weatherEffectCoverage({ profile: 'low', family: 'rain', particlePixels: 10, viewportPixels: 900_000, draws: 2 }).ok, false);
  assert.equal(weatherEffectCoverage({ profile: 'low', family: 'rain', particlePixels: 10, viewportPixels: 900_000, overdrawLayers: 2 }).ok, false);
  assert.equal(weatherEffectCoverage({ profile: 'low', family: 'fog', particlePixels: 10, viewportPixels: 900_000 }).ok, false);
});

test('ENV-05 the pool is one opaque, dithered, zero-matrix draw that follows the live weather view', () => {
  const { scene, ditherUniform, handle } = sceneWithDither();
  const ledger = new LifecycleLedger({ label: 'weather-effects' });
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, .1, 400);
  camera.position.set(12, 1.4, -8);
  const effects = createWeatherEffects({ scene, ditherUniform, profile: 'low', ledger, seed: 7 });
  try {
    assert.equal(scene.children.filter(child => child.name === 'weather-particles').length, 1);
    assert.equal(effects.material.transparent, false, 'particles never blend');
    assert.equal(effects.material.depthWrite, true);
    assert.equal(effects.material.userData.gdoWeatherEffects.collides, false);
    assert.equal(effects.material.userData.gdoWeatherEffects.castsLight, false);
    // The screen-door discard is in the shader, not in a blend state.
    let discard = '';
    effects.material.onBeforeCompile({
      uniforms: {},
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <color_fragment>',
    });
    const compiled = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>' };
    effects.material.onBeforeCompile(compiled);
    discard = compiled.fragmentShader;
    assert.match(discard, /discard/, 'a dithered fragment is dropped, not blended');

    // Dry: nothing drawn.
    effects.sync({ view: WEATHER_VIEW(null, {}), camera, nowMilliseconds: 0 });
    assert.equal(effects.diagnostics.family, null);
    assert.equal(effects.geometry.instanceCount, 0);

    // Rain: the family comes from ENV-04's view, the count from the profile, and
    // the intensity from the live wetness channel.
    const rain = WEATHER_VIEW(GDO_WEATHER_PRECIPITATION.RAIN, { wetness: .85 });
    effects.sync({ view: rain, camera, nowMilliseconds: 1_000 });
    const first = effects.diagnostics;
    assert.equal(first.family, 'rain');
    assert.equal(first.particles, Math.round(80 * .85));
    assert.ok(first.particles <= GDO_LOW_PROFILE_BUDGETS.weatherParticles);
    assert.equal(effects.geometry.instanceCount, first.particles);
    assert.equal(first.draws, 1);
    assert.equal(first.alphaMode, 'dither');
    assert.equal(first.steadyFrameAllocations, 0);
    assert.ok(first.steadyFrameWrites <= GDO_WEATHER_EFFECT_PROFILES.low.maximumUniformWritesPerFrame,
      `the family-change frame wrote ${first.steadyFrameWrites} uniforms`);
    assert.deepEqual(effects.material.userData.gdoWeatherEffects.uniforms.centre.value.toArray(), [12, 1.4, -8]);
    // The instance stream is seeded once per family: a steady frame repacks none.
    const packs = first.packs;
    for (let frame = 0; frame < 30; frame++) {
      effects.sync({ view: rain, camera, nowMilliseconds: 1_000 + frame * 16 });
    }
    assert.equal(effects.diagnostics.packs, packs, 'a steady frame rewrites no instance data');
    assert.equal(effects.diagnostics.steadyFrameAllocations, 0);
    assert.equal(effects.diagnostics.steadyFrameWrites, GDO_WEATHER_EFFECT_PROFILES.low.steadyFrameUniformWrites,
      'a steady frame is the clock plus the camera centre');

    // A family change reseeds once; the coverage report then measures the frame.
    effects.sync({ view: WEATHER_VIEW(GDO_WEATHER_PRECIPITATION.SNOW, { snow: .9 }), camera, nowMilliseconds: 2_000 });
    assert.equal(effects.diagnostics.family, 'snow');
    assert.equal(effects.diagnostics.packs, packs + 1);
    const coverage = effects.measureCoverage({ viewportPixels: 1280 * 720 });
    assert.equal(coverage.ok, true, coverage.reasons.join('; '));
    assert.ok(coverage.particlePixels > 0);

    // Reduced motion parks the whole field and says why.
    effects.setReducedMotion(true);
    effects.sync({ view: rain, camera, nowMilliseconds: 3_000 });
    assert.equal(effects.diagnostics.particles, 0);
    assert.equal(effects.diagnostics.amount, 0);
    assert.deepEqual(effects.fallbacks().map(entry => entry.reason), ['reduced-motion', 'profile-cap']);
    effects.setReducedMotion(false);
  } finally {
    effects.dispose();
    handle.release();
  }
  assert.equal(scene.children.filter(child => child.name === 'weather-particles').length, 0);
  // `FND-07`: the pool registers geometry, material, and mesh; releasing the
  // ledger is what disposes them, so a hostile teardown is covered too.
  ledger.disposeAll();
  assert.equal(ledger.snapshot().total, 0, 'the pool left nothing live behind');
  assert.equal(ledger.snapshot().failures, 0);
});

test('ENV-05 the surface and shore response is derived from the live view and lands uniform-only', () => {
  const handle = acquireProceduralMaterialLibrary();
  const library = handle.library;
  const material = createWaterVisualMaterial({ library, profile: 'low' });
  const policy = createWaterVisualPolicy({ material, library, profile: 'low' });
  try {
    const dry = weatherSurfaceResponse(WEATHER_VIEW(null, {}));
    assert.equal(dry.active, false);
    assert.equal(dry.rippleGain, 1);
    assert.equal(dry.shoreWetMetres, 0);
    applyWeatherSurface(policy, dry);
    assert.equal(material.uniforms.uWeatherWetness.value, 0);
    assert.equal(material.uniforms.uShoreWet.value, 0);
    assert.equal(material.uniforms.uWeatherRipple.value, 1);

    const rain = weatherSurfaceResponse(WEATHER_VIEW(GDO_WEATHER_PRECIPITATION.RAIN, { wetness: .85, damp: .6 }));
    assert.equal(rain.active, true);
    assert.equal(rain.family, 'rain');
    assert.ok(rain.rippleGain > 1, 'rain raises the ripple amplitude');
    assert.ok(rain.darkening > .05, 'a wet surface darkens');
    assert.ok(rain.foamGain > 0);
    assert.ok(rain.shoreWetMetres > 0.5, 'the shore band widens with the rain');
    assert.equal(rain.ripples, true);

    const applied = applyWeatherSurface(policy, rain);
    assert.equal(applied.family, 'rain');
    assert.equal(applied.writes, 3);
    assert.ok(material.uniforms.uWeatherWetness.value > .8);
    assert.ok(material.uniforms.uWeatherRipple.value > 1);
    assert.ok(material.uniforms.uShoreWet.value > 0);
    // Uniform-only: the program key never moves and the palette is untouched.
    const key = material.customProgramCacheKey?.() ?? material.name;
    applyWeatherSurface(policy, weatherSurfaceResponse(WEATHER_VIEW(GDO_WEATHER_PRECIPITATION.SNOW, { snow: .9 })));
    assert.equal(material.customProgramCacheKey?.() ?? material.name, key);
    assert.equal(policy.diagnostics.programRecompiles ?? 0, 0);
    assert.equal(policy.diagnostics.weatherFrames, 3);
    assert.equal(policy.diagnostics.weatherWrites, 9);
    assert.equal(material.transparent, false, 'the low water path stays opaque under weather');
    assert.deepEqual(policy.weatherFallbacks().map(entry => entry.reason), ['profile-dither-only']);
  } finally {
    material.dispose();
    handle.release();
  }
});

test('ENV-05 the HUD names the family, the draw, and the parked slots', () => {
  const { scene, ditherUniform, handle } = sceneWithDither();
  const effects = createWeatherEffects({ scene, ditherUniform, profile: 'low' });
  try {
    const parked = weatherEffectHudText(effects.diagnostics);
    assert.equal(parked.title, 'No weather particles');
    assert.match(parked.text, /Clear air/);
    effects.sync({ view: WEATHER_VIEW(GDO_WEATHER_PRECIPITATION.RAIN, { wetness: 1 }), nowMilliseconds: 10 });
    const text = weatherEffectHudText(effects.diagnostics, weatherSurfaceResponse(WEATHER_VIEW(GDO_WEATHER_PRECIPITATION.RAIN, { wetness: 1 })));
    assert.match(text.title, /^Rain · \d+ particles$/);
    assert.match(text.text, /rippling water/);
    assert.match(text.detail, /1 draw · dither · 1 layer/);
  } finally {
    effects.dispose();
    handle.release();
  }
  assert.equal(GDO_WEATHER_EFFECTS_NAMESPACE, 'gdo:weatherEffects:v1');
});
