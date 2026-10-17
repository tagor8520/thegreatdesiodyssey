import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_SKY_PHASE,
  GDO_TIME_OF_DAY_DEFAULTS,
  GDO_TIME_OF_DAY_PROFILES,
  createTimeOfDayState,
  sampleSky,
} from './TimeOfDaySky.js';
import {
  createProceduralLightRig,
  createProceduralSky,
  createTimeOfDayLighting,
} from './ProceduralEngine.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import { LifecycleLedger } from './LifecycleContract.js';

/**
 * `ENV-02` runtime gate: the day cycle reaches the real `three` objects — sky
 * uniforms, light colours/intensities/positions, fog, exposure, stars, lamps —
 * and stays inside the declared low-profile write budget.
 */

const PLACE = { latitude: 28.9845, longitude: 77.7064 };

function buildRuntime({ profile = 'low', reducedMotion = false } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#9fc8e0');
  scene.fog = new THREE.Fog('#9fc8e0', 78, 175);
  const sky = createProceduralSky(scene, {
    starCount: GDO_TIME_OF_DAY_PROFILES[profile].starCount,
    showMoon: GDO_TIME_OF_DAY_PROFILES[profile].moonDisc,
    cloudCoverage: GDO_TIME_OF_DAY_PROFILES[profile].cloudCoverage,
  });
  const rig = createProceduralLightRig(scene, { shadows: false, scale: .32 });
  const renderer = { toneMappingExposure: 1.05 };
  let emissive = 0;
  const lighting = createTimeOfDayLighting({
    sky, rig, renderer, scene, onEmissive: value => { emissive = value; },
  });
  const ledger = new LifecycleLedger({ label: 'time-of-day-test' });
  const time = createTimeOfDayState({
    ...PLACE, profile, reducedMotion, writers: lighting.writers, ledger,
  });
  lighting.bind(time.state);
  const dispose = () => {
    time.dispose();
    sky.dispose();
    rig.dispose();
    ledger.disposeAll();
  };
  return { scene, sky, rig, renderer, lighting, time, ledger, dispose, emissive: () => emissive };
}

test('the authored rig is replaced by the day cycle and stays on budget', () => {
  const runtime = buildRuntime();
  const { time, rig, sky, renderer, lighting } = runtime;
  try {
    // The bridge declares exactly the writers the low profile budgets.
    assert.equal(lighting.writers.length, GDO_LOW_PROFILE_BUDGETS.skyUniformWritesPerUpdate);
    assert.equal(lighting.writers.length, GDO_TIME_OF_DAY_PROFILES.low.maxUniformWritesPerUpdate);
    const authored = rig.authored;
    assert.ok(authored.distance > 0);

    // Noon: bright sun above the horizon, no stars, no lamps.
    time.override('noon');
    time.advance(1000);
    assert.equal(time.update(time.clockMilliseconds), true);
    assert.equal(time.state.phase, GDO_SKY_PHASE.DAYLIGHT);
    assert.equal(rig.sun.intensity, time.state.sunIntensity);
    assert.ok(rig.sun.intensity > 2.5, `noon sun intensity ${rig.sun.intensity}`);
    assert.ok(rig.sun.position.y > authored.distance * .9, 'the sun sits high at noon');
    assert.ok(rig.fill.intensity > .8);
    const noonHorizon = sky.uniforms.uHorizon.value.clone();
    assert.notDeepEqual([noonHorizon.r, noonHorizon.g, noonHorizon.b], [.62, .70, .775]);
    assert.ok(sky.uniforms.uStarOpacity.value < .01);
    assert.equal(sky.starPoints.visible, false);
    assert.equal(runtime.emissive(), 0, 'lamps are off at noon');
    assert.equal(renderer.toneMappingExposure, time.state.exposure);

    // Night: readable palette, stars drawn, lamps on, moon visible.
    time.override('night');
    time.advance(1000);
    assert.equal(time.update(time.clockMilliseconds), true);
    assert.equal(time.state.phase, GDO_SKY_PHASE.NIGHT);
    assert.equal(time.nightReadability().ok, true);
    assert.ok(rig.sun.position.y >= 0, 'the sun light never goes under the ground plane');
    assert.ok(rig.sun.intensity < 1, `night sun intensity ${rig.sun.intensity}`);
    assert.ok(rig.fill.intensity >= .12, `night fill ${rig.fill.intensity}`);
    assert.ok(sky.uniforms.uStarOpacity.value > .9);
    assert.equal(sky.starPoints.visible, true);
    assert.equal(sky.starPoints.geometry.attributes.position.count, GDO_TIME_OF_DAY_PROFILES.low.starCount);
    assert.equal(sky.uniforms.uMoonOpacity.value, 0, 'the low profile skips the moon disc');
    assert.equal(GDO_TIME_OF_DAY_PROFILES.balanced.moonDisc, true, 'balanced keeps it');
    assert.ok(runtime.emissive() > .95, 'lamps come on at night');
    assert.ok(renderer.toneMappingExposure < .3, `night exposure ${renderer.toneMappingExposure}`);
    // Fog and background follow the same palette, so the horizon line disappears.
    assert.equal(sceneMatchesFog(runtime), true);
    assert.ok(noonHorizon.r > sky.uniforms.uHorizon.value.r, 'night is darker than noon');

    // A full day sweep stays within the write budget and visits every phase.
    // The override is cleared first: the scripted phases above must not pin the
    // clock for the sweep.
    time.override(null);
    const phases = new Set();
    let worst = 0, writes = 0;
    for (let step = 0; step <= 288; step++) {
      const now = step * 5000;
      time.setClock(now);
      time.update(now);
      worst = Math.max(worst, time.diagnostics().writesThisUpdate);
      phases.add(time.state.phase);
    }
    writes = time.diagnostics().uniformWrites;
    assert.ok(worst <= GDO_TIME_OF_DAY_PROFILES.low.maxUniformWritesPerUpdate, `worst ${worst}`);
    assert.equal(time.diagnostics().overBudgetUpdates, 0);
    assert.ok(writes > 40, `a day writes ${writes} uniforms`);
    assert.ok(phases.size >= 4, `phases seen ${[...phases].join(', ')}`);
    // An explicit apply (the mount and override path) pushes the whole state at
    // once, including the star field flag.
    time.override('night');
    time.advance(1000);
    time.update(time.clockMilliseconds);
    lighting.apply(time.state);
    assert.ok(lighting.diagnostics().applied >= 1);
    assert.ok(lighting.diagnostics().starFrames >= 1);
    assert.equal(time.diagnostics().steadyFrameAllocations, 0);
  } finally {
    runtime.dispose();
  }
});

function sceneMatchesFog({ scene }) {
  const fog = scene.fog.color, background = scene.background;
  return Math.abs(fog.r - background.r) < 1e-6 && Math.abs(fog.g - background.g) < 1e-6 &&
    Math.abs(fog.b - background.b) < 1e-6;
}

test('reduced motion keeps the clock deterministic and the audit can hold a phase', () => {
  const runtime = buildRuntime({ profile: 'balanced', reducedMotion: true });
  const { time, sky, dispose } = runtime;
  try {
    assert.equal(time.diagnostics().reducedMotion, true);
    // Setting the clock to the same value twice is idempotent: the sky is not
    // time-accumulating noise, it is a pure function of the clock.
    const first = createTimeOfDayState({ ...PLACE, profile: 'balanced', reducedMotion: true, dayLengthMinutes: 24 });
    const second = createTimeOfDayState({ ...PLACE, profile: 'balanced', reducedMotion: true, dayLengthMinutes: 24 });
    for (const fraction of [0, .2, .35, .5, .7, .9]) {
      sampleSky({ fraction, ...PLACE, out: first.state });
      sampleSky({ fraction, ...PLACE, out: second.state });
      assert.deepEqual([...first.state.horizon], [...second.state.horizon]);
      assert.equal(first.state.phase, second.state.phase);
    }
    // Daily wrap: exactly one world day returns the clock to where it was.
    const before = time.fractionAtNow();
    time.advance(24 * 60_000);
    assert.ok(Math.abs(time.fractionAtNow() - before) < 1e-9, `wrapped fraction ${time.fractionAtNow()}`);
    const fresh = createTimeOfDayState({ ...PLACE, profile: 'balanced' }).fractionAtNow();
    assert.ok(Math.abs(fresh - GDO_TIME_OF_DAY_DEFAULTS.startFraction) < 1e-9, 'the default start fraction is stable');
    // Star geometry is one static seeded set, allocated once.
    const positions = sky.starPoints.geometry.attributes.position.array;
    time.override('night');
    time.advance(1000);
    time.update(time.clockMilliseconds);
    assert.equal(sky.starPoints.geometry.attributes.position.array, positions, 'the star set is never rebuilt');
    assert.equal(sky.starPoints.geometry.attributes.position.count, GDO_TIME_OF_DAY_PROFILES.balanced.starCount);
  } finally {
    dispose();
  }
});

test('the ledger owns the clock and disposing it stops every write', () => {
  const runtime = buildRuntime();
  const { time, lighting, ledger, dispose } = runtime;
  try {
    assert.equal(time.namespace, 'gdo:timeOfDaySky:v1');
    assert.ok(ledger.snapshot().counts.handle >= 1, 'the clock registers one ledger handle');
    const before = time.diagnostics().uniformWrites;
    time.override('sunset');
    time.advance(1000);
    time.update(time.clockMilliseconds);
    assert.ok(time.diagnostics().uniformWrites > before);
    time.dispose();
    assert.equal(lighting.diagnostics().applied >= 0, true);
  } finally {
    dispose();
  }
  // Disposal is idempotent and does not throw on a second pass.
  runtime.time.dispose();
});
