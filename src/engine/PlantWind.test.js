import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_PLANT_WIND_NAMESPACE,
  GDO_PLANT_WIND_PROFILES,
  PlantWindState,
  samplePlantWindOffset,
} from './PlantWind.js';

function magnitude(offset) { return Math.hypot(offset.x, offset.z); }

function worldOffset(offset, yaw) {
  const cosine = Math.cos(yaw), sine = Math.sin(yaw);
  return {
    x: cosine * offset.x + sine * offset.z,
    z: -sine * offset.x + cosine * offset.z,
  };
}

const MOVING_SAMPLE = Object.freeze({
  positionY: .9,
  bendWeight: .86,
  detailRole: 7,
  phase: .19,
  stiffness: .24,
  worldX: 13,
  worldZ: -7,
  timeMilliseconds: 12_345,
  direction: Object.freeze([.8, .6]),
  strength: .75,
  gustiness: .3,
});

test('VEG-09 defines one versioned bounded low-profile wind field', () => {
  assert.equal(GDO_PLANT_WIND_NAMESPACE, 'gdo:vegetationWind:v1');
  assert.deepEqual(GDO_PLANT_WIND_PROFILES.low, {
    amplitude: .055,
    maximumDisplacement: .06,
    defaultDirection: [.8192319346130006, .5734623242290992],
    defaultStrength: .52,
    defaultGustiness: .24,
    reducedMotionStrength: .10,
    clockPeriodSeconds: 65_536,
    maxUniformWritesPerFrame: 1,
    cpuMatrixUpdatesPerFrame: 0,
    steadyFrameAllocations: 0,
  });
});

test('whole-plant displacement is deterministic, bounded, rooted, and stiffness-aware', () => {
  const first = samplePlantWindOffset(MOVING_SAMPLE);
  const repeated = samplePlantWindOffset(MOVING_SAMPLE);
  assert.deepEqual(first, repeated);
  assert.ok(magnitude(first) > 0);
  assert.ok(magnitude(first) <= GDO_PLANT_WIND_PROFILES.low.maximumDisplacement);
  assert.deepEqual(samplePlantWindOffset({ ...MOVING_SAMPLE, positionY: 0 }), { x: 0, z: 0 });
  assert.deepEqual(samplePlantWindOffset({ ...MOVING_SAMPLE, detailRole: 2 }), { x: 0, z: 0 });
  const stiff = samplePlantWindOffset({ ...MOVING_SAMPLE, stiffness: 1 });
  assert.ok(magnitude(stiff) < magnitude(first));
  const lowBend = samplePlantWindOffset({ ...MOVING_SAMPLE, bendWeight: 0 });
  assert.ok(magnitude(lowBend) < magnitude(first));
});

test('instance yaw preserves world-aligned wind and stable phase prevents obvious synchronization', () => {
  const yaw = 1.17;
  const local = samplePlantWindOffset({ ...MOVING_SAMPLE, yaw });
  const world = worldOffset(local, yaw);
  const cross = world.x * MOVING_SAMPLE.direction[1] - world.z * MOVING_SAMPLE.direction[0];
  assert.ok(Math.abs(cross) < 1e-12, 'object-space offset resolves to the global world direction');
  const neighboringPhase = samplePlantWindOffset({ ...MOVING_SAMPLE, phase: .67, worldX: 13.8 });
  assert.notDeepEqual(neighboringPhase, samplePlantWindOffset(MOVING_SAMPLE));
});

test('reduced motion removes gust and caps the remaining calm whole-plant sway', () => {
  const reducedWithGust = samplePlantWindOffset({ ...MOVING_SAMPLE, reducedMotion: true, gustiness: 1 });
  const reducedWithoutGust = samplePlantWindOffset({ ...MOVING_SAMPLE, reducedMotion: true, gustiness: 0 });
  const full = samplePlantWindOffset(MOVING_SAMPLE);
  assert.deepEqual(reducedWithGust, reducedWithoutGust, 'gust input is ignored under reduced motion');
  assert.ok(magnitude(reducedWithGust) < magnitude(full) * .25);
});

test('clock wrapping is continuous and malformed state input falls back safely', () => {
  const nullFallback = new PlantWindState(null);
  assert.equal(nullFallback.diagnostics.malformedInputs, 1);
  nullFallback.dispose();
  const start = samplePlantWindOffset({ ...MOVING_SAMPLE, timeMilliseconds: 0 });
  const wrapped = samplePlantWindOffset({ ...MOVING_SAMPLE, timeMilliseconds: 65_536_000 });
  assert.ok(Math.abs(start.x - wrapped.x) < 1e-12);
  assert.ok(Math.abs(start.z - wrapped.z) < 1e-12);

  const wind = new PlantWindState({ profile: 'unsupported', direction: [0, 0], strength: 2, gustiness: NaN });
  try {
    assert.equal(wind.profile, 'low');
    assert.ok(wind.diagnostics.malformedInputs >= 2);
    assert.deepEqual(wind.diagnostics.direction, GDO_PLANT_WIND_PROFILES.low.defaultDirection);
    assert.equal(wind.diagnostics.strength, GDO_PLANT_WIND_PROFILES.low.defaultStrength);
    assert.equal(wind.diagnostics.gustiness, GDO_PLANT_WIND_PROFILES.low.defaultGustiness);
    assert.equal(wind.configure(null), false);
    assert.equal(wind.update(-1), 0);
    assert.equal(wind.update(16), 1);
    assert.equal(wind.update(16), 0);
    assert.ok(wind.diagnostics.lastUniformWrites <= wind.diagnostics.limits.maxUniformWritesPerFrame);
    assert.equal(wind.diagnostics.cpuMatrixUpdates, 0);
    assert.equal(wind.diagnostics.steadyFrameAllocations, 0);
  } finally { wind.dispose(); }
  assert.equal(wind.diagnostics.disposed, true);
  assert.equal(wind.update(32), 0);
});

test('reduced-motion and context lifecycle preserve shared uniform objects', () => {
  const wind = new PlantWindState();
  const field = wind.uniforms.field.value;
  const clockUniform = wind.uniforms.clock;
  try {
    assert.equal(wind.setReducedMotion(true), true);
    assert.equal(wind.uniforms.field.value, field);
    assert.equal(field.w, 0);
    assert.equal(field.z, GDO_PLANT_WIND_PROFILES.low.reducedMotionStrength);
    assert.equal(wind.setReducedMotion(true), false);
    wind.update(2_000);
    wind.handleContextRestored();
    assert.equal(wind.uniforms.clock, clockUniform);
    assert.equal(wind.diagnostics.contextRestores, 1);
    assert.equal(wind.setReducedMotion(false), true);
    assert.equal(field.z, GDO_PLANT_WIND_PROFILES.low.defaultStrength);
  } finally { wind.dispose(); }
});
