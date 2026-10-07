/**
 * `ENV-02` — time-of-day light/sky state (Node tier).
 *
 * Registered gate (feature-roadmap/README.md order 111):
 *   "Bounded uniform updates, readable night, no per-frame allocation"
 *
 * Each of those three clauses is a claim that can be false in a way a screenshot would
 * not reveal, so each gets its own measurement here, and the browser tier re-measures
 * the first and the second against the live runtime rather than trusting this file.
 *
 * The invariant this gate leans on hardest is that **the palette cannot disagree with
 * the sun**: a phase name is a band of solar elevation and the colours are interpolated
 * between elevation stops, so "night" with a high sun is not a state the system can
 * reach. That is checked across every minute of a full day, not at four sample points.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_DEFAULT_SUN_DIRECTION, GDO_NIGHT_LUMINANCE_FLOOR, GDO_SKY_PHASES, GDO_SKY_STOPS,
  GDO_TIME_OF_DAY_PROFILES, TimeOfDay, applyStarUniforms, applyTimeOfDay, bindTimeOfDayUniforms,
  phaseForElevation, solarDeclination, solarPosition,
} from './TimeOfDay.js';

/** Every minute of a day, as UTC clock minutes. */
const DAY = Array.from({ length: 1440 }, (_, index) => index);

test('the solar model is geographically correct', () => {
  // Solar noon at a longitude is when the hour angle is zero: 12:00 local solar time.
  // At 77.71°E that is 06:49 UTC, and the elevation there is the day's maximum.
  const longitude = 77.71, latitude = 28.98, day = 172;
  const noonMinutes = (12 - longitude / 15) * 60;
  const noon = solarPosition(noonMinutes, day, latitude, longitude);
  const extreme = DAY.reduce((best, minutes) => {
    const elevation = solarPosition(minutes, day, latitude, longitude).elevation;
    return elevation > best.elevation ? { minutes, elevation } : best;
  }, { minutes: 0, elevation: -Infinity });
  assert.ok(Math.abs(extreme.minutes - noonMinutes) <= 4,
    `the day's peak should be at solar noon (${noonMinutes.toFixed(1)} min), found ${extreme.minutes}`);
  assert.ok(Math.abs(noon.elevation - extreme.elevation) < 0.2, 'the elevation at solar noon should be the day maximum');
  // 90 - |latitude - declination| for the solstice: a check on the model, not on a table.
  const expected = 90 - Math.abs(latitude - solarDeclination(day));
  assert.ok(Math.abs(noon.elevation - expected) < 0.6,
    `solstice elevation ${noon.elevation.toFixed(2)} should be close to ${expected.toFixed(2)}`);
  // The same instant is day at one longitude and night at another: at 06:00 UTC the sun
  // is high over 77.7°E and below the horizon at the opposite longitude.
  assert.ok(solarPosition(360, day, latitude, longitude).elevation > 50, 'late morning at 06:00 UTC at 77.7°E');
  assert.ok(solarPosition(360, day, latitude, -77.71).elevation < 0, 'night at 06:00 UTC at 77.7°W');
  assert.ok(solarPosition(0, day, 51.5, -0.12).elevation < 0, 'local midnight at 00:00 UTC in London');
  // The equator on an equinox: the noon sun is overhead, i.e. very close to 90°.
  assert.ok(solarPosition(720, 80, 0, 0).elevation > 89,
    `equinoctial noon at the equator is overhead, got ${solarPosition(720, 80, 0, 0).elevation.toFixed(2)}°`);
  // The poles: the sun never rises on the winter solstice, and never sets on the summer one.
  assert.ok(DAY.every(minutes => solarPosition(minutes, 355, 80, 0).elevation < 0), 'polar night');
  assert.ok(DAY.every(minutes => solarPosition(minutes, 172, 80, 0).elevation > 0), 'polar day');
  // Azimuth stays in range and sweeps the full circle over a day.
  const azimuths = DAY.map(minutes => solarPosition(minutes, 172, latitude, longitude).azimuth);
  assert.ok(azimuths.every(value => value >= 0 && value < 360), 'azimuth is reported in 0…360°');
  const quadrants = new Set(azimuths.map(value => Math.floor(value / 90)));
  assert.equal(quadrants.size, 4, 'the sun visits all four quadrants over a day');
  // Declination is bounded by the obliquity and flips sign between the solstices.
  assert.ok(Math.abs(solarDeclination(172) - 23.44) < 0.3, 'June solstice declination');
  assert.ok(solarDeclination(355) < -23, 'December solstice declination');
  assert.ok(Math.abs(solarDeclination(81)) < 0.4, 'equinox declination is near zero');
});

test('the phase can never contradict the sun, at any minute of the day', () => {
  const timeOfDay = new TimeOfDay({ profile: 'low', latitude: 28.98, longitude: 77.71, dayOfYear: 172 });
  const seen = new Set();
  for (const minutes of DAY) {
    timeOfDay.setClock(minutes);
    const state = timeOfDay.sample();
    const expected = phaseForElevation(state.sunElevation);
    const diag = timeOfDay.diagnostics();
    seen.add(state.phase);
    assert.equal(state.phase, expected.id,
      `${diag.clock}: elevation ${state.sunElevation.toFixed(2)}° must be phase ${expected.id}, not ${state.phase}`);
    assert.equal(state.phaseLabel, expected.label, 'the label travels with the id');
    // The light source follows the sun by day and the moon by night — never a stale one.
    if (state.sunElevation > 0) {
      assert.ok(state.lightDirection.distanceTo(state.sunDirection) < 1e-9,
        `${diag.clock}: daylight must come from the sun`);
      assert.ok(state.lightColor.equals(state.sunColor), `${diag.clock}: daylight must be the sun colour`);
    } else {
      assert.ok(state.lightDirection.distanceTo(state.moonDirection) < 1e-9,
        `${diag.clock}: night must come from the moon`);
      assert.ok(state.lightColor.equals(state.moonColor), `${diag.clock}: night must be the moon colour`);
    }
    // The elevation sign and the light direction's height agree.
    assert.equal(state.lightDirection.y > 0, state.sunElevation > 0 || state.moonDirection.y > 0,
      `${diag.clock}: the light must be above the horizon`);
  }
  for (const phase of GDO_SKY_PHASES) {
    assert.ok(seen.has(phase.id), `phase ${phase.id} (${phase.label}) is unreachable at this latitude and date`);
  }
  // The bands tile the elevations without a gap or an overlap.
  for (let index = 1; index < GDO_SKY_PHASES.length; index++) {
    assert.ok(GDO_SKY_PHASES[index].minimumElevation > GDO_SKY_PHASES[index - 1].minimumElevation,
      'phase bands are ordered');
  }
  // Phase names must be time-neutral: a low sun in the afternoon is not a "sunrise".
  assert.ok(!GDO_SKY_PHASES.some(phase => /sunrise|sunset-time|morning|afternoon|evening/.test(phase.id)),
    'phase ids describe the sky, not the hour, because the same elevation occurs twice a day');
});

test('night stays readable, measured rather than asserted', () => {
  const timeOfDay = new TimeOfDay({ profile: 'low', latitude: 28.98, longitude: 77.71, dayOfYear: 172 });
  let darkest = { luminance: Infinity, minutes: 0 };
  for (const minutes of DAY) {
    timeOfDay.setClock(minutes);
    const state = timeOfDay.sample();
    if (state.groundLuminance < darkest.luminance) darkest = { luminance: state.groundLuminance, minutes };
  }
  assert.ok(darkest.luminance >= GDO_NIGHT_LUMINANCE_FLOOR,
    `the darkest minute (${darkest.minutes}) has ground luminance ${darkest.luminance.toFixed(4)}, below the ${GDO_NIGHT_LUMINANCE_FLOOR} floor`);
  // A night that is only dark is not readable: the night stops must carry a directional
  // source, and the moon must be a real term rather than a label.
  const midnight = new TimeOfDay({ profile: 'low', latitude: 28.98, longitude: 77.71, dayOfYear: 172 });
  midnight.setClock(1080);
  const state = midnight.sample();
  assert.equal(state.phase, 'night', '01:00 UTC at this longitude is night');
  assert.ok(state.moonIntensity > 0, 'the moon is a real term at night');
  assert.ok(state.starVisibility > 0.5, `stars should be visible at night, got ${state.starVisibility}`);
  assert.ok(state.sunIntensity > 0 || state.moonIntensity > 0, 'some directional source exists');
  assert.ok(state.lightIntensity >= GDO_NIGHT_LUMINANCE_FLOOR, 'the directional term is not negligible');
  // The star fade is monotonic through dusk: it must not flicker on and off.
  const dusk = DAY.filter(minutes => minutes >= 900 && minutes <= 1080)
    .map(minutes => { midnight.setClock(minutes); return midnight.sample().starVisibility; });
  for (let index = 1; index < dusk.length; index++) {
    assert.ok(dusk[index] >= dusk[index - 1] - 1e-9, 'star visibility decreases monotonically into the night');
  }
  // And the day has no stars at all, so the night term costs nothing at noon.
  midnight.setClock(409);
  assert.equal(midnight.sample().starVisibility, 0, 'no stars at solar noon');
});

test('uniform writes are bounded by the profile, and a still clock writes nothing', () => {
  assert.deepEqual(Object.keys(GDO_TIME_OF_DAY_PROFILES), ['low', 'balanced', 'high']);
  assert.equal(GDO_TIME_OF_DAY_PROFILES.low.uniformHz, 10);
  assert.equal(GDO_TIME_OF_DAY_PROFILES.balanced.uniformHz, 15);
  assert.equal(GDO_TIME_OF_DAY_PROFILES.high.uniformHz, 30);

  // A frozen clock: a thousand frames, not one write.
  const frozen = new TimeOfDay({ profile: 'low', timeScale: 0 });
  let writes = 0;
  // A real caller applies what it is told to apply; the first frame is applied once and
  // every frame after that must be skipped.
  for (let frame = 0; frame < 1000; frame++) if (frozen.update(1 / 60, frame * 1000 / 60)) { writes++; frozen.markApplied(); }
  assert.equal(writes, 1, `a frozen clock wrote ${writes} uniforms; the first apply and then nothing`);
  assert.equal(frozen.diagnostics().writes, 1);
  assert.equal(frozen.diagnostics().unchangedSkips, 999, 'every later frame was skipped as unchanged, not silently dropped');

  // A moving clock at 60 fps: the ceiling holds. 10 hours a second means a full day in
  // 2.4 s, so every frame moves the sun well past the change epsilon.
  const moving = new TimeOfDay({ profile: 'low', latitude: 28.98, longitude: 77.71, timeScale: 600 });
  const perSecond = [];
  for (let second = 0; second < 6; second++) {
    const before = moving.diagnostics().writes;
    for (let frame = 0; frame < 60; frame++) {
      const now = (second * 60 + frame) * 1000 / 60;
      if (moving.update(1 / 60, now)) moving.markApplied();
    }
    perSecond.push(moving.diagnostics().writes - before);
  }
  assert.ok(perSecond.every(count => count <= GDO_TIME_OF_DAY_PROFILES.low.uniformHz + 1),
    `a second spent ${perSecond.join('/')} uniform writes against a ceiling of ${GDO_TIME_OF_DAY_PROFILES.low.uniformHz}`);
  assert.ok(perSecond.some(count => count > 0), 'the moving clock must actually write, or the ceiling is untested');
  const total = perSecond.reduce((sum, count) => sum + count, 0);
  assert.ok(total <= (GDO_TIME_OF_DAY_PROFILES.low.uniformHz + 1) * perSecond.length,
    `${total} writes over ${perSecond.length} seconds exceeds the ceiling per second`);
  assert.ok(total < 180,
    `the ceiling must be far below the ${perSecond.length * 60} frames that were simulated, or the bounded claim means nothing`);

  // A stall cannot be repaid: one call after a 60-second gap is one write, not thousands.
  const stalled = new TimeOfDay({ profile: 'low', timeScale: 600 });
  for (let frame = 0; frame < 60; frame++) if (stalled.update(1 / 60, frame * 1000 / 60)) stalled.markApplied();
  const beforeStall = stalled.diagnostics().writes;
  const writeAfterStall = stalled.update(60, 200_000);
  assert.equal(stalled.diagnostics().writes - beforeStall, writeAfterStall ? 1 : 0,
    'a stalled clock coalesces into at most one write');
  assert.ok(stalled.diagnostics().coalesced > 0, 'the skipped writes are reported rather than hidden');

  // The higher profiles are ceilings too, and an unknown profile is refused by name.
  const high = new TimeOfDay({ profile: 'high', timeScale: 600 });
  let highWrites = 0;
  for (let frame = 0; frame < 60; frame++) if (high.update(1 / 60, frame * 1000 / 60)) highWrites++;
  assert.ok(highWrites <= GDO_TIME_OF_DAY_PROFILES.high.uniformHz + 1, `${highWrites} writes at the high profile`);
  assert.throws(() => new TimeOfDay({ profile: 'ultra' }), /Unknown time-of-day profile: ultra/);
  for (const [label, options] of [
    ['latitude', { latitude: 120 }], ['longitude', { longitude: 200 }],
    ['day', { dayOfYear: 0 }], ['time scale', { timeScale: -1 }], ['moon', { moonIllumination: 2 }],
  ]) {
    assert.throws(() => new TimeOfDay(options), RangeError, `${label} must be refused`);
  }
  assert.throws(() => frozen.setClock(NaN), /clock must be finite/);
  // A driver that owns the timeline can re-anchor the limiter; without it a drive whose
  // timestamps start behind the runtime's own clock is refused every write, which is
  // exactly what the browser gate measured before this existed.
  const rebased = new TimeOfDay({ profile: 'low', timeScale: 600 });
  rebased.update(1 / 60, 900_000);
  rebased.markApplied();
  rebased.rebaseClock(0);
  let rebasedWrites = 0;
  for (let frame = 0; frame < 180; frame++) {
    if (rebased.update(1 / 60, frame * 1000 / 60)) { rebasedWrites++; rebased.markApplied(); }
  }
  assert.ok(rebasedWrites >= 25 && rebasedWrites <= 30,
    `a re-anchored 60 fps drive should spend the ceiling over three seconds, got ${rebasedWrites}`);
  assert.throws(() => rebased.rebaseClock(NaN), /rebase must be finite/);
  assert.throws(() => frozen.advance(-1), /advance must be finite and non-negative/);
});

test('a steady applied frame allocates nothing at all', () => {
  // **What is measurable here and what is not.** A transient allocation — one object per
  // frame, dropped immediately — cannot be measured by sampling `heapUsed`: V8 reclaims it
  // before the read, and the figure then depends on when a scavenge happened to land. (The
  // control below makes the point: constructing a fresh `TimeOfDay` per frame measured
  // *negative* bytes per frame, because the garbage was collected inside the window.) So
  // this test splits the claim:
  //
  //  * the **deterministic** half is structural identity — the state object graph must be
  //    the same instances frame after frame, which is what "no per-frame allocation" means
  //    at the level a reader can audit;
  //  * the **measured** half uses retained allocation as its positive control, so the
  //    instrument is shown to be able to see a per-frame object graph when one exists, and
  //    the steady figure is compared against a noise band rather than against zero.
  const timeOfDay = new TimeOfDay({ profile: 'low', latitude: 28.98, longitude: 77.71, timeScale: 600 });
  const lightRig = { sun: new THREE.DirectionalLight(), fill: new THREE.HemisphereLight() };
  const scene = new THREE.Scene();
  scene.background = new THREE.Color();
  scene.fog = new THREE.Fog(0xffffff, 1, 100);
  const renderer = { toneMappingExposure: 1 };
  const apply = now => {
    if (timeOfDay.update(1 / 60, now)) {
      applyTimeOfDay(timeOfDay.state, { lightRig, scene, renderer });
      timeOfDay.markApplied();
    }
  };

  const state = timeOfDay.state;
  const identity = ['sunDirection', 'moonDirection', 'lightDirection', 'horizon', 'middle', 'zenith',
    'sunColor', 'moonColor', 'hemisphereSky', 'hemisphereGround', 'fogColor', 'lightColor'];
  const before = identity.map(key => state[key]);
  for (let frame = 0; frame < 2000; frame++) apply(frame * 1000 / 60);
  assert.equal(timeOfDay.state, state, 'the state object is the same instance after 2000 frames');
  assert.deepEqual(identity.map(key => state[key]), before,
    'every colour and vector in the state is the same instance, so no frame rebuilt the state');
  // `position()` is the convenience read and returns a fresh object — the documented
  // asymmetry with the hot path, which fills a module-level scratch.
  assert.notEqual(timeOfDay.position(), timeOfDay.position(), 'position() hands out a fresh object');

  // The measured half: seven windows, large enough that a real per-frame object would be
  // megabytes of retained growth rather than noise.
  const windowBytes = scale => {
    const subject = new TimeOfDay({ profile: 'low', timeScale: scale });
    const localApply = now => {
      if (subject.update(1 / 60, now)) {
        applyTimeOfDay(subject.state, { lightRig, scene, renderer });
        subject.markApplied();
      }
    };
    for (let frame = 0; frame < 500; frame++) localApply(0);
    const start = process.memoryUsage().heapUsed;
    for (let frame = 0; frame < 20_000; frame++) localApply(frame * 1000 / 60);
    return (process.memoryUsage().heapUsed - start) / 20_000;
  };
  const median = values => [...values].sort((a, b) => a - b)[(values.length - 1) / 2];
  const windows = Array.from({ length: 5 }, () => windowBytes(600));
  const steady = median(windows);
  // The positive control: one retained object per frame, which no collector can hide.
  const retained = [];
  const controlStart = process.memoryUsage().heapUsed;
  for (let frame = 0; frame < 20_000; frame++) retained.push(new TimeOfDay({ timeScale: 0 }).state);
  const control = (process.memoryUsage().heapUsed - controlStart) / 20_000;
  assert.equal(retained.length, 20_000, 'the control must actually retain its objects');
  assert.ok(control > 20,
    `the instrument must be able to see a per-frame object graph; the retained control measured ${control.toFixed(1)} bytes/frame`);
  assert.ok(steady < control / 4,
    `a steady frame measured ${steady.toFixed(1)} bytes against a retained-object control of ${control.toFixed(1)} — not meaningfully below it`);
  assert.ok(steady < 64,
    `a steady frame measured ${steady.toFixed(1)} bytes (windows: ${windows.map(v => v.toFixed(1)).join(', ')})`);
  void retained;
});

test('uniform binding is by reference, so applying a state copies nothing', () => {
  const scene = new THREE.Scene();
  const sky = {
    material: {
      uniforms: {
        uHorizon: { value: new THREE.Color() }, uMiddle: { value: new THREE.Color() },
        uZenith: { value: new THREE.Color() }, uSunColor: { value: new THREE.Color() },
        uSunDirection: { value: new THREE.Vector3() }, uMoonDirection: { value: new THREE.Vector3() },
        uStarVisibility: { value: 0 }, uCloudCover: { value: 0 },
      },
    },
  };
  const timeOfDay = new TimeOfDay({ profile: 'low', latitude: 28.98, longitude: 77.71 });
  timeOfDay.setClock(1020);
  const state = timeOfDay.sample();
  bindTimeOfDayUniforms(sky, state);
  // Identity, not equality: the uniform holds the state's own object, so writing the
  // state *is* writing the uniform and no per-frame copy exists to forget.
  assert.equal(sky.material.uniforms.uHorizon.value, state.horizon);
  assert.equal(sky.material.uniforms.uMiddle.value, state.middle);
  assert.equal(sky.material.uniforms.uZenith.value, state.zenith);
  assert.equal(sky.material.uniforms.uSunColor.value, state.sunColor);
  assert.equal(sky.material.uniforms.uSunDirection.value, state.sunDirection);
  assert.equal(sky.material.uniforms.uMoonDirection.value, state.moonDirection);

  const lightRig = { sun: new THREE.DirectionalLight('#fff0d3', 3.2), fill: new THREE.HemisphereLight() };
  const renderer = { toneMappingExposure: 1.05 };
  scene.background = new THREE.Color(); scene.fog = new THREE.Fog(0xffffff, 1, 100);
  timeOfDay.setClock(409);
  const daylightHorizon = timeOfDay.sample().horizon.getHex();
  // Move to night and re-sample: the binding is by reference, so the uniforms the test
  // is holding are the ones the new state will write through.
  timeOfDay.setClock(1020);
  timeOfDay.sample();
  applyTimeOfDay(timeOfDay.state, { lightRig, scene, renderer, scale: .32 });
  const night = timeOfDay.state;
  assert.ok(lightRig.sun.position.length() > 1, 'the light is placed along the state direction');
  assert.ok(lightRig.sun.position.clone().normalize().distanceTo(night.lightDirection) < 1e-6,
    'the light sits on the state direction');
  assert.equal(lightRig.sun.intensity, night.lightIntensity);
  assert.ok(lightRig.sun.color.equals(night.lightColor));
  assert.ok(lightRig.fill.color.equals(night.hemisphereSky));
  assert.ok(lightRig.fill.groundColor.equals(night.hemisphereGround));
  assert.ok(scene.background.equals(night.horizon), 'the background follows the horizon colour');
  assert.ok(scene.fog.color.equals(night.fogColor));
  assert.equal(renderer.toneMappingExposure, night.exposure);
  assert.notEqual(timeOfDay.state.horizon.getHex(), daylightHorizon, 'a night state is a different colour from daylight');
  assert.equal(applyStarUniforms(sky, night), true, 'the star uniforms are written');
  assert.equal(sky.material.uniforms.uStarVisibility.value, night.starVisibility);
  assert.equal(sky.material.uniforms.uCloudCover.value, night.cloudCover);
  assert.throws(() => bindTimeOfDayUniforms({}, state), /requires a sky handle/);
  assert.equal(applyStarUniforms({ material: {} }, state), false, 'a sky without the uniforms is reported, not thrown');
  assert.throws(() => applyTimeOfDay(null), /requires a state/);
});

test('the shipped daylight look is preserved', () => {
  // The default clock is solar noon for the coordinate, and the `day` stop carries the
  // colours the fixed shader hard-coded. A default frame must therefore look unchanged
  // apart from the sun's real direction.
  const timeOfDay = new TimeOfDay({ profile: 'low', latitude: 28.98, longitude: 77.71, dayOfYear: 172 });
  const state = timeOfDay.sample();
  assert.equal(state.phase, 'day', 'the default is daylight');
  const day = GDO_SKY_STOPS[GDO_SKY_STOPS.length - 1];
  assert.equal(day.phase, 'day');
  for (const key of ['horizon', 'middle', 'zenith']) {
    assert.ok(Math.abs(state[key].r - day[key][0]) < 1e-6, `${key}.r`);
    assert.ok(Math.abs(state[key].g - day[key][1]) < 1e-6, `${key}.g`);
    assert.ok(Math.abs(state[key].b - day[key][2]) < 1e-6, `${key}.b`);
  }
  assert.ok(Math.abs(state.cloudCover - day.cloudCover) < 1e-6, 'cloud cover matches the shipped band');
  // The one deliberate change: the direction is real now, and the module says so.
  const shipped = new THREE.Vector3(...GDO_DEFAULT_SUN_DIRECTION).normalize();
  assert.ok(state.sunDirection.distanceTo(shipped) > 0.05,
    'the sun direction is derived from the solar model, not the shipped literal');
  assert.ok(Math.abs(state.sunDirection.length() - 1) < 1e-9, 'and it is a unit vector');
  // Elevation sanity at this latitude and date: high summer sun near local noon.
  assert.ok(state.sunElevation > 70, `summer noon at 29°N should be high, got ${state.sunElevation.toFixed(1)}°`);
});

test('lifecycle: reset clears the counters and the state together', () => {
  const timeOfDay = new TimeOfDay({ profile: 'low', timeScale: 600 });
  for (let frame = 0; frame < 200; frame++) if (timeOfDay.update(1 / 60, frame * 1000 / 60)) timeOfDay.markApplied();
  const before = timeOfDay.diagnostics();
  assert.ok(before.writes > 0 && before.appliedStateCount > 0, 'the run must have written, or there is nothing to reset');
  timeOfDay.reset();
  const after = timeOfDay.diagnostics();
  assert.equal(after.writes, 0);
  assert.equal(after.writesThisSecond, 0);
  assert.equal(after.unchangedSkips, 0);
  assert.equal(after.coalesced, 0);
  assert.equal(after.appliedStateCount, 0);
  assert.equal(timeOfDay.hasApplied, false, 'the applied baseline is cleared with the counters');
  // And the state itself is re-sampled, so a reset cannot leave a stale sky behind.
  assert.equal(after.phase, timeOfDay.state.phase);
  assert.ok(after.minutes >= 0 && after.minutes < 1440);
  // The clock survives a day boundary in both directions.
  timeOfDay.setClock(1439); timeOfDay.advance(120);
  assert.ok(timeOfDay.diagnostics().minutes < 1440, 'the clock wraps forward');
  timeOfDay.setClock(-30);
  assert.ok(timeOfDay.diagnostics().minutes >= 0, 'the clock wraps backward through zero');
  assert.ok(timeOfDay.diagnostics().minutes >= 0, 'a negative clock is normalised');
});
