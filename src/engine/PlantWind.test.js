import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_PLANT_WIND_NAMESPACE,
  GDO_PLANT_WIND_PROFILES,
  PlantWindState,
  samplePlantWindOffset,
  plantPhaseGroupOffset,
  GDO_PLANT_WIND_PHASE_GROUPS,
  GDO_PLANT_WIND_PHASE_OFFSETS,
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
    phaseGroups: 4,
    phaseGroupOffsets: [0, .25, .5, .75],
    reducedMotionPhaseGroups: 1,
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

test('VEG-10 groups are four declared clock offsets on the one shared wave', () => {
  assert.equal(GDO_PLANT_WIND_PHASE_GROUPS, 4);
  assert.deepEqual([...GDO_PLANT_WIND_PHASE_OFFSETS], [0, .25, .5, .75]);
  assert.equal(GDO_PLANT_WIND_PROFILES.low.phaseGroups, 4);
  assert.deepEqual([...GDO_PLANT_WIND_PROFILES.low.phaseGroupOffsets], [0, .25, .5, .75]);
  assert.equal(plantPhaseGroupOffset(0), 0);
  assert.equal(plantPhaseGroupOffset(2), .5);
  // Out-of-range and malformed bytes clamp into the coherent set — never wrap
  // into invented motion and never produce a non-finite phase.
  assert.equal(plantPhaseGroupOffset(9), .75);
  assert.equal(plantPhaseGroupOffset(-3), 0);
  assert.equal(plantPhaseGroupOffset(Number.NaN), 0);
  assert.equal(plantPhaseGroupOffset(2.9), .5);
  assert.equal(plantPhaseGroupOffset(2, { reducedMotion: true }), 0);
});

test('each phase group is the same wave sampled later, so groups stay coherent', () => {
  const sample = (phaseGroup, timeMilliseconds) =>
    samplePlantWindOffset({ ...MOVING_SAMPLE, phaseGroup, timeMilliseconds });
  // One group period is CLOCK_DIVISOR_SECONDS * 1000 ms per unit of clock.
  const periodMilliseconds = 64_000;
  for (const group of [1, 2, 3]) {
    const offsetMilliseconds = (GDO_PLANT_WIND_PHASE_OFFSETS[group]) * periodMilliseconds;
    const grouped = sample(group, 40_000);
    const lagged = sample(0, 40_000 + offsetMilliseconds);
    assert.ok(Math.abs(grouped.x - lagged.x) < 1e-9, `group ${group} x travels as a delay`);
    assert.ok(Math.abs(grouped.z - lagged.z) < 1e-9, `group ${group} z travels as a delay`);
    const flat = sample(group, 40_000);
    const flatLagged = sample(0, 40_000 + offsetMilliseconds);
    assert.equal(flat.x, flatLagged.x, 'the same input is pure and repeatable');
  }
  // Distinct groups are actually distinct at a given instant (the offsets are
  // not decorative), while the whole set stays inside the displacement cap.
  const offsets = [0, 1, 2, 3].map(group => sample(group, 12_345));
  const distinct = new Set(offsets.map(offset => offset.x.toFixed(6))).size;
  assert.ok(distinct >= 3, 'four declared groups produce genuinely different phases');
  for (const offset of offsets) {
    assert.ok(magnitude(offset) <= GDO_PLANT_WIND_PROFILES.low.maximumDisplacement);
  }
});

test('reduced motion collapses group divergence into one calm field', () => {
  const moving = [0, 1, 2, 3].map(phaseGroup =>
    samplePlantWindOffset({ ...MOVING_SAMPLE, phaseGroup, reducedMotion: true }));
  for (const offset of moving) {
    assert.ok(magnitude(offset) <= GDO_PLANT_WIND_PROFILES.low.maximumDisplacement);
    assert.ok(magnitude(offset) <= magnitude(samplePlantWindOffset({ ...MOVING_SAMPLE, phaseGroup: 0 })));
  }
  // With the group scale collapsed, group bytes cannot separate the motion:
  // the residual spread is only the plants' own stable phase and position.
  const spread = Math.max(...moving.map(o => o.x)) - Math.min(...moving.map(o => o.x));
  const normalSpread = (() => {
    const normal = [0, 1, 2, 3].map(phaseGroup =>
      samplePlantWindOffset({ ...MOVING_SAMPLE, phaseGroup }));
    return Math.max(...normal.map(o => o.x)) - Math.min(...normal.map(o => o.x));
  })();
  assert.ok(spread < normalSpread, 'reduced motion removes group travel, not just amplitude');

  const wind = new PlantWindState();
  try {
    const phaseUniform = wind.uniforms.phaseGroups.value;
    assert.deepEqual([...phaseUniform.toArray()], [0, .25, .5, .75]);
    const writes = wind.diagnostics.totalPhaseGroupWrites;
    wind.update(1_000);
    wind.update(2_000);
    assert.equal(wind.diagnostics.totalPhaseGroupWrites, writes, 'steady frames never rewrite group offsets');
    assert.equal(wind.diagnostics.lastUniformWrites, 1);
    assert.equal(wind.diagnostics.phaseGroups, 4);
    assert.deepEqual(wind.diagnostics.phaseGroupOffsets, [0, .25, .5, .75]);
    assert.equal(wind.setReducedMotion(true), true);
    assert.equal(wind.uniforms.phaseGroups.value, phaseUniform, 'the uniform object is shared, not replaced');
    assert.deepEqual([...phaseUniform.toArray()], [0, 0, 0, 0]);
    assert.deepEqual(wind.diagnostics.phaseGroupOffsets, [0, 0, 0, 0]);
    assert.equal(wind.setReducedMotion(false), true);
    assert.deepEqual([...phaseUniform.toArray()], [0, .25, .5, .75]);
    wind.handleContextRestored();
    assert.equal(wind.uniforms.phaseGroups.value, phaseUniform);
  } finally { wind.dispose(); }
});
