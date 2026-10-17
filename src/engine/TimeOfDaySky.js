/**
 * `ENV-02` — geographic time-of-day light and sky state.
 *
 * The research asks for a shared, uniform-driven sky model rather than a fixed
 * palette: sun direction and elevation, horizon/zenith/ground colours, star and
 * moon visibility, exposure, and lamp/window emissive state derived from one
 * world clock — approximated with fast gradients because a physical atmosphere
 * is not appropriate for the low-end default.
 *
 * This module is the pure state machine: no `three`, no DOM, no allocation in
 * steady state. It computes a deterministic solar position from latitude,
 * longitude, day-of-year and UTC time, blends a named phase palette by *sun
 * elevation* (so dawn, noon, sunset and night are correct at any latitude and
 * season), and pushes only changed values into runtime writers at a bounded
 * rate. The coordinate world and the curated island install it over the same
 * light rig and sky dome, and the movement audit can drive it with a phase
 * override so night readability is measured rather than eyeballed.
 */

import { featureNamespace } from './FeatureVersions.js';

export const GDO_TIME_OF_DAY_NAMESPACE = featureNamespace('timeOfDaySky');

export const GDO_SKY_PHASE = Object.freeze({
  NIGHT: 'night',
  BLUE_HOUR: 'blue-hour',
  SUNRISE: 'warm-low-sun',
  DAYLIGHT: 'high-daylight',
  GOLDEN: 'golden-afternoon',
  SUNSET: 'saturated-sunset',
  PRE_DAWN: 'pre-dawn',
});

const DEGREES = Math.PI / 180;

/**
 * Phase keyframes ordered by sun elevation (degrees). The palette is linear in
 * elevation, so a phase change is a blend and never a jump, and both hemispheres
 * and every season walk the same table in their own direction.
 */
export const GDO_SKY_KEYFRAMES = Object.freeze([
  Object.freeze({
    elevation: -18, risingPhase: GDO_SKY_PHASE.NIGHT, settingPhase: GDO_SKY_PHASE.NIGHT,
    horizon: Object.freeze([.020, .026, .052]), middle: Object.freeze([.010, .014, .034]), zenith: Object.freeze([.004, .006, .020]),
    fog: Object.freeze([.026, .034, .062]), sun: Object.freeze([.42, .50, .72]), sunIntensity: .14,
    hemisphere: Object.freeze([.16, .20, .34]), ground: Object.freeze([.05, .05, .07]), ambient: .30,
    starOpacity: 1, moonOpacity: 1, exposure: .16, hemisphereIntensity: .18,
  }),
  Object.freeze({
    elevation: -8, risingPhase: GDO_SKY_PHASE.BLUE_HOUR, settingPhase: GDO_SKY_PHASE.BLUE_HOUR,
    horizon: Object.freeze([.075, .095, .175]), middle: Object.freeze([.040, .062, .135]), zenith: Object.freeze([.016, .028, .085]),
    fog: Object.freeze([.085, .105, .170]), sun: Object.freeze([.62, .48, .52]), sunIntensity: .34,
    hemisphere: Object.freeze([.34, .40, .58]), ground: Object.freeze([.10, .09, .11]), ambient: .48,
    starOpacity: .72, moonOpacity: .6, exposure: .34, hemisphereIntensity: .34,
  }),
  Object.freeze({
    elevation: -2, risingPhase: GDO_SKY_PHASE.PRE_DAWN, settingPhase: GDO_SKY_PHASE.SUNSET,
    horizon: Object.freeze([.235, .170, .215]), middle: Object.freeze([.130, .140, .240]), zenith: Object.freeze([.055, .080, .175]),
    fog: Object.freeze([.205, .170, .205]), sun: Object.freeze([.95, .60, .42]), sunIntensity: .9,
    hemisphere: Object.freeze([.52, .54, .68]), ground: Object.freeze([.18, .15, .15]), ambient: .62,
    starOpacity: .28, moonOpacity: .2, exposure: .72, hemisphereIntensity: .50,
  }),
  Object.freeze({
    elevation: 6, risingPhase: GDO_SKY_PHASE.SUNRISE, settingPhase: GDO_SKY_PHASE.GOLDEN,
    horizon: Object.freeze([.560, .330, .205]), middle: Object.freeze([.310, .330, .420]), zenith: Object.freeze([.120, .200, .360]),
    fog: Object.freeze([.480, .350, .280]), sun: Object.freeze([1, .74, .48]), sunIntensity: 2.1,
    hemisphere: Object.freeze([.74, .76, .82]), ground: Object.freeze([.30, .24, .20]), ambient: .78,
    starOpacity: .04, moonOpacity: 0, exposure: 1.0, hemisphereIntensity: .62,
  }),
  Object.freeze({
    elevation: 22, risingPhase: GDO_SKY_PHASE.DAYLIGHT, settingPhase: GDO_SKY_PHASE.DAYLIGHT,
    horizon: Object.freeze([.620, .700, .775]), middle: Object.freeze([.430, .585, .780]), zenith: Object.freeze([.235, .415, .710]),
    fog: Object.freeze([.560, .680, .790]), sun: Object.freeze([1, .94, .82]), sunIntensity: 3.2,
    hemisphere: Object.freeze([.85, .93, 1.0]), ground: Object.freeze([.36, .30, .24]), ambient: .9,
    starOpacity: 0, moonOpacity: 0, exposure: 1.05, hemisphereIntensity: .86,
  }),
  Object.freeze({
    elevation: 45, risingPhase: GDO_SKY_PHASE.DAYLIGHT, settingPhase: GDO_SKY_PHASE.DAYLIGHT,
    horizon: Object.freeze([.640, .745, .840]), middle: Object.freeze([.380, .560, .820]), zenith: Object.freeze([.155, .350, .720]),
    fog: Object.freeze([.590, .720, .850]), sun: Object.freeze([1, .98, .94]), sunIntensity: 3.4,
    hemisphere: Object.freeze([.90, .96, 1.0]), ground: Object.freeze([.40, .33, .26]), ambient: .95,
    starOpacity: 0, moonOpacity: 0, exposure: 1.06, hemisphereIntensity: .94,
  }),
  Object.freeze({
    elevation: 70, risingPhase: GDO_SKY_PHASE.DAYLIGHT, settingPhase: GDO_SKY_PHASE.DAYLIGHT,
    horizon: Object.freeze([.660, .780, .870]), middle: Object.freeze([.330, .540, .840]), zenith: Object.freeze([.120, .310, .730]),
    fog: Object.freeze([.620, .760, .880]), sun: Object.freeze([1, 1, .98]), sunIntensity: 3.4,
    hemisphere: Object.freeze([.92, .97, 1.0]), ground: Object.freeze([.42, .35, .27]), ambient: .96,
    starOpacity: 0, moonOpacity: 0, exposure: 1.06, hemisphereIntensity: .96,
  }),
]);

/** Readable-night floors: below these the world stops being legible at night. */
export const GDO_NIGHT_READABILITY_FLOORS = Object.freeze({
  horizonLuminance: .012,
  zenithLuminance: .004,
  hemisphereIntensity: .12,
  sunIntensity: .08,
  fogLuminance: .018,
  exposure: .12,
});

export const GDO_TIME_OF_DAY_PROFILES = Object.freeze({
  low: Object.freeze({
    maxUpdatesHz: 10,
    maxUniformWritesPerUpdate: 14,
    starCount: 120,
    starGeometry: 'static-seeded',
    moonDisc: false,
    cloudCoverage: false,
  }),
  balanced: Object.freeze({
    maxUpdatesHz: 15,
    maxUniformWritesPerUpdate: 20,
    starCount: 260,
    starGeometry: 'static-seeded',
    moonDisc: true,
    cloudCoverage: true,
  }),
  high: Object.freeze({
    maxUpdatesHz: 30,
    maxUniformWritesPerUpdate: 28,
    starCount: 520,
    starGeometry: 'static-seeded',
    moonDisc: true,
    cloudCoverage: true,
  }),
});

export const GDO_TIME_OF_DAY_DEFAULTS = Object.freeze({
  /** Real minutes for one full world day; the clock is free-running. */
  dayLengthMinutes: 24,
  /** Phase the clock starts at, as a fraction of the day (0 = midnight). */
  startFraction: .32,
  /** Elevation change below this (degrees) is not worth a uniform write. */
  elevationEpsilon: .05,
});

/** The seven phases the research names, in day order. */
export const GDO_SKY_PHASE_ORDER = Object.freeze([
  GDO_SKY_PHASE.NIGHT, GDO_SKY_PHASE.BLUE_HOUR, GDO_SKY_PHASE.PRE_DAWN, GDO_SKY_PHASE.SUNRISE,
  GDO_SKY_PHASE.DAYLIGHT, GDO_SKY_PHASE.GOLDEN, GDO_SKY_PHASE.SUNSET,
]);

function clamp(value, minimum = 0, maximum = 1) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function mix(first, second, t) {
  return first + (second - first) * t;
}

function mixTriple(first, second, t, out) {
  out[0] = mix(first[0], second[0], t);
  out[1] = mix(first[1], second[1], t);
  out[2] = mix(first[2], second[2], t);
  return out;
}

/**
 * Deterministic low-precision solar position. Accuracy is a few arc-minutes —
 * far more than a stylized sky needs — and it depends only on its inputs.
 */
export function solarPosition({ latitude, longitude, dayOfYear = 172, hoursUtc = 12 } = {}, out = {}) {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) throw new RangeError('Solar position needs a latitude within ±90°');
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new RangeError('Solar position needs a longitude within ±180°');
  if (!Number.isFinite(dayOfYear) || dayOfYear < 1 || dayOfYear > 366) throw new RangeError('Solar position needs a day of year 1–366');
  if (!Number.isFinite(hoursUtc)) throw new RangeError('Solar position needs finite UTC hours');
  const declination = 23.44 * Math.sin(360 * DEGREES * (284 + dayOfYear) / 365);
  const solarHours = ((hoursUtc + longitude / 15) % 24 + 24) % 24;
  const hourAngle = 15 * (solarHours - 12);
  const latitudeRadians = latitude * DEGREES;
  const declinationRadians = declination * DEGREES;
  const hourRadians = hourAngle * DEGREES;
  const sinElevation = Math.sin(latitudeRadians) * Math.sin(declinationRadians) +
    Math.cos(latitudeRadians) * Math.cos(declinationRadians) * Math.cos(hourRadians);
  const elevation = Math.asin(clamp(sinElevation, -1, 1));
  const cosElevation = Math.cos(elevation);
  const azimuth = Math.atan2(
    Math.sin(hourRadians) * Math.cos(declinationRadians),
    Math.cos(latitudeRadians) * Math.sin(declinationRadians) - Math.sin(latitudeRadians) * Math.cos(declinationRadians) * Math.cos(hourRadians),
  );
  // Day length from the hour angle at the horizon; polar day/night are honest.
  const cosHourAngle = -Math.tan(latitudeRadians) * Math.tan(declinationRadians);
  const dayLengthHours = cosHourAngle <= -1 ? 24 : cosHourAngle >= 1 ? 0 : 2 * Math.acos(cosHourAngle) / DEGREES / 15;
  out.declinationDegrees = declination;
  out.solarHours = solarHours;
  out.elevationRadians = elevation;
  out.elevationDegrees = elevation / DEGREES;
  out.azimuthRadians = azimuth;
  out.dayLengthHours = dayLengthHours;
  out.rising = hourAngle < 0;
  out.daylight = elevation > 0;
  return out;
}

function bracketKeyframes(elevationDegrees) {
  const keyframes = GDO_SKY_KEYFRAMES;
  if (elevationDegrees <= keyframes[0].elevation) return { from: keyframes[0], to: keyframes[0], blend: 0 };
  for (let index = 1; index < keyframes.length; index++) {
    const previous = keyframes[index - 1], current = keyframes[index];
    if (elevationDegrees <= current.elevation) {
      const span = current.elevation - previous.elevation || 1;
      return { from: previous, to: current, blend: clamp((elevationDegrees - previous.elevation) / span) };
    }
  }
  const last = keyframes.at(-1);
  return { from: last, to: last, blend: 0 };
}

/** One reused state record: colours, intensities, phases, and star/moon state. */
export function createSkyState(out = {}) {
  out.namespace = GDO_TIME_OF_DAY_NAMESPACE;
  out.horizon = out.horizon ?? [0, 0, 0];
  out.middle = out.middle ?? [0, 0, 0];
  out.zenith = out.zenith ?? [0, 0, 0];
  out.fog = out.fog ?? [0, 0, 0];
  out.sun = out.sun ?? [0, 0, 0];
  out.hemisphere = out.hemisphere ?? [0, 0, 0];
  out.ground = out.ground ?? [0, 0, 0];
  out.sunDirection = out.sunDirection ?? [0, 1, 0];
  out.moonDirection = out.moonDirection ?? [0, -1, 0];
  out.phase = GDO_SKY_PHASE.DAYLIGHT;
  out.nextPhase = GDO_SKY_PHASE.DAYLIGHT;
  out.blend = 0;
  out.fraction = 0;
  out.elevationDegrees = 0;
  out.azimuthDegrees = 0;
  out.dayLengthHours = 12;
  out.daylight = true;
  out.rising = true;
  out.nightFactor = 0;
  out.starOpacity = 0;
  out.moonOpacity = 0;
  out.sunIntensity = 0;
  out.hemisphereIntensity = 0;
  out.ambient = 0;
  out.exposure = 1;
  out.emissive = 0;
  return out;
}

/**
 * Sample the sky at one fraction of the day (0 = midnight, .5 = solar noon),
 * blending the elevation keyframes. `out` is the caller's reused record.
 */
export function sampleSky({
  fraction, latitude, longitude, dayOfYear = 172, out = createSkyState(),
} = {}) {
  if (!out || typeof out !== 'object') throw new TypeError('Sky sampling needs a reusable output record');
  if (!Number.isFinite(fraction)) throw new RangeError('Sky sampling needs a day fraction');
  const normalized = ((fraction % 1) + 1) % 1;
  // The fraction is a fraction of the *local solar day*, so the longitude shift
  // is removed again here: noon means noon wherever the coordinate is.
  const hoursUtc = normalized * 24 - longitude / 15;
  const sun = solarPosition({ latitude, longitude, dayOfYear, hoursUtc }, out.solar ??= {});
  const elevationDegrees = sun.elevationDegrees;
  const { from, to, blend } = bracketKeyframes(elevationDegrees);
  mixTriple(from.horizon, to.horizon, blend, out.horizon);
  mixTriple(from.middle, to.middle, blend, out.middle);
  mixTriple(from.zenith, to.zenith, blend, out.zenith);
  mixTriple(from.fog, to.fog, blend, out.fog);
  mixTriple(from.sun, to.sun, blend, out.sun);
  mixTriple(from.hemisphere, to.hemisphere, blend, out.hemisphere);
  mixTriple(from.ground, to.ground, blend, out.ground);
  const azimuthRadians = sun.azimuthRadians;
  const cosElevation = Math.cos(sun.elevationRadians);
  out.sunDirection[0] = Math.cos(azimuthRadians) * cosElevation;
  out.sunDirection[1] = Math.sin(sun.elevationRadians);
  out.sunDirection[2] = Math.sin(azimuthRadians) * cosElevation;
  // The moon rises roughly opposite the sun; its phase is left to the sky shader.
  out.moonDirection[0] = -out.sunDirection[0];
  out.moonDirection[1] = -out.sunDirection[1];
  out.moonDirection[2] = -out.sunDirection[2];
  const nearer = blend < .5 ? from : to;
  out.phase = sun.rising ? nearer.risingPhase : nearer.settingPhase;
  out.nextPhase = sun.rising ? to.risingPhase : to.settingPhase;
  out.blend = blend;
  out.fraction = normalized;
  out.elevationDegrees = elevationDegrees;
  out.azimuthDegrees = azimuthDegrees(azimuthRadians);
  out.dayLengthHours = sun.dayLengthHours;
  out.daylight = sun.daylight;
  out.rising = sun.rising;
  out.nightFactor = clamp((2 - elevationDegrees) / 14);
  out.starOpacity = mix(from.starOpacity, to.starOpacity, blend);
  out.moonOpacity = mix(from.moonOpacity, to.moonOpacity, blend);
  out.sunIntensity = mix(from.sunIntensity, to.sunIntensity, blend);
  out.hemisphereIntensity = mix(from.hemisphereIntensity, to.hemisphereIntensity, blend);
  out.ambient = mix(from.ambient, to.ambient, blend);
  out.exposure = mix(from.exposure, to.exposure, blend);
  // Lamps and windows light up as the sun goes down: one shared material family.
  out.emissive = clamp(1 - (elevationDegrees + 4) / 8);
  return out;
}

function azimuthDegrees(radians) {
  return ((radians / DEGREES) + 360) % 360;
}

/** Named overrides the audit uses to visit dawn, noon, sunset, and night. */
export const GDO_TIME_OF_DAY_OVERRIDES = Object.freeze({
  night: 0,
  'pre-dawn': .21,
  dawn: .25,
  sunrise: .27,
  noon: .5,
  afternoon: .68,
  sunset: .78,
  dusk: .82,
  'blue-hour': .86,
});

/** Luminance of a linear triple, for the readability floors. */
export function luminance(triple) {
  return triple[0] * .2126 + triple[1] * .7152 + triple[2] * .0722;
}

/** Measured night readability: every floor the research implies, with its value. */
export function nightReadability(state) {
  const checks = {
    horizonLuminance: luminance(state.horizon),
    zenithLuminance: luminance(state.zenith),
    hemisphereIntensity: state.hemisphereIntensity,
    sunIntensity: state.sunIntensity,
    fogLuminance: luminance(state.fog),
    exposure: state.exposure,
  };
  const failures = Object.keys(GDO_NIGHT_READABILITY_FLOORS)
    .filter(key => !Number.isFinite(checks[key]) || checks[key] < GDO_NIGHT_READABILITY_FLOORS[key]);
  return { ok: failures.length === 0, failures, checks, floors: GDO_NIGHT_READABILITY_FLOORS };
}

/** Deterministic seeded star field on the unit sphere; low profile is static. */
export function createStarField({ count = 120, seed = 0x51d3f00d } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 4_000) throw new RangeError('Star field count must be 1–4000');
  const positions = new Float32Array(count * 3);
  const magnitudes = new Float32Array(count);
  let hash = seed >>> 0;
  const next = () => {
    hash ^= hash << 13; hash >>>= 0;
    hash ^= hash >> 17;
    hash ^= hash << 5; hash >>>= 0;
    return hash / 4294967296;
  };
  for (let index = 0; index < count; index++) {
    // Cosine-distributed elevation keeps the sky evenly covered.
    const y = next() * 2 - 1;
    const angle = next() * Math.PI * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    positions[index * 3] = Math.cos(angle) * radius;
    positions[index * 3 + 1] = y;
    positions[index * 3 + 2] = Math.sin(angle) * radius;
    magnitudes[index] = .35 + next() * .65;
  }
  return Object.freeze({ count, seed, positions, magnitudes });
}

export function timeOfDayBudgetForProfile(profile) {
  const policy = GDO_TIME_OF_DAY_PROFILES[profile];
  if (!policy) throw new RangeError(`Unknown time-of-day profile: ${profile}`);
  return Object.freeze({
    maxUpdatesHz: policy.maxUpdatesHz,
    maxUniformWritesPerUpdate: policy.maxUniformWritesPerUpdate,
    starCount: policy.starCount,
  });
}

/**
 * The world clock and its bounded uniform writer.
 *
 * `writers` is the runtime's bridge to `three`: each entry declares a `key` on
 * the state record and a `write(value, state)` callback. Only writers whose key
 * changed by more than `epsilon` are called, at most `maxUpdatesHz` times per
 * second and `maxUniformWritesPerUpdate` per update, so a static frame writes
 * nothing and a day cycle never storms the renderer.
 */
export function createTimeOfDayState({
  latitude,
  longitude,
  profile = 'low',
  dayOfYear = 172,
  dayLengthMinutes = GDO_TIME_OF_DAY_DEFAULTS.dayLengthMinutes,
  startFraction = GDO_TIME_OF_DAY_DEFAULTS.startFraction,
  clockMilliseconds = 0,
  reducedMotion = false,
  writers = [],
  ledger = null,
} = {}) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new RangeError('Time-of-day state needs finite latitude and longitude');
  }
  const policy = GDO_TIME_OF_DAY_PROFILES[profile];
  if (!policy) throw new RangeError(`Unknown time-of-day profile: ${profile}`);
  if (!Number.isFinite(dayLengthMinutes) || dayLengthMinutes <= 0) throw new RangeError('Day length must be positive');
  if (!Number.isFinite(startFraction)) throw new RangeError('Start fraction must be finite');

  const state = createSkyState();
  const previous = createSkyState();
  const clock = { milliseconds: clockMilliseconds, offsetFraction: 0, fraction: startFraction };
  const diagnostics = {
    updates: 0,
    uniformWrites: 0,
    skippedUpdates: 0,
    writesThisUpdate: 0,
    lastUpdateAt: -Infinity,
    steadyFrameAllocations: 0,
    overBudgetUpdates: 0,
  };
  const fieldEpsilons = Object.freeze({
    horizon: .002, middle: .002, zenith: .002, fog: .002, sun: .002,
    hemisphere: .002, ground: .002, sunDirection: .0015, moonDirection: .01,
    sunIntensity: .02, hemisphereIntensity: .02, ambient: .02, exposure: .01,
    starOpacity: .03, moonOpacity: .03, emissive: .03, nightFactor: .05,
  });
  const writersByKey = new Map();
  for (const writer of writers) {
    if (!writer || typeof writer.write !== 'function' || typeof writer.key !== 'string') {
      throw new TypeError('Time-of-day writers need a key and a write(value, state) callback');
    }
    const list = writersByKey.get(writer.key) ?? [];
    list.push(writer);
    writersByKey.set(writer.key, list);
  }

  const scope = ledger?.child?.('time-of-day') ?? null;

  function changed(key) {
    if (key === 'sunDirection' || key === 'moonDirection') {
      const current = state[key], before = previous[key];
      const epsilon = fieldEpsilons[key];
      return Math.abs(current[0] - before[0]) > epsilon || Math.abs(current[1] - before[1]) > epsilon ||
        Math.abs(current[2] - before[2]) > epsilon;
    }
    const value = state[key], before = previous[key];
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      const epsilon = fieldEpsilons[key] ?? .002;
      return Math.abs(value[0] - before[0]) > epsilon || Math.abs(value[1] - before[1]) > epsilon ||
        Math.abs(value[2] - before[2]) > epsilon;
    }
    const epsilon = fieldEpsilons[key] ?? .02;
    return Math.abs(value - before) > epsilon;
  }

  /**
   * Record one field as "what the runtime last saw". Only written fields are
   * recorded, so slow drift below the epsilon accumulates instead of being
   * erased every frame, and a static sky settles into zero writes.
   */
  function recordWritten(source, key) {
    const value = source[key];
    const target = previous[key];
    if (ArrayBuffer.isView(value) || Array.isArray(value)) {
      if (!target || target.length !== value.length) previous[key] = value.slice();
      else if (target.set) target.set(value);
      else for (let index = 0; index < value.length; index++) target[index] = value[index];
    } else previous[key] = value;
    return previous;
  }

  function advance(milliseconds) {
    if (!Number.isFinite(milliseconds)) throw new RangeError('Clock advance must be finite');
    clock.milliseconds += milliseconds;
    return clock.milliseconds;
  }

  function setClock(milliseconds) {
    if (!Number.isFinite(milliseconds)) throw new RangeError('Clock must be finite');
    clock.milliseconds = milliseconds;
    return clock.milliseconds;
  }

  function setFraction(fraction) {
    if (!Number.isFinite(fraction)) throw new RangeError('Day fraction must be finite');
    clock.offsetFraction = fraction;
    return clock.offsetFraction;
  }

  function override(name) {
    if (name == null) { clock.overrideFraction = null; return null; }
    const fraction = GDO_TIME_OF_DAY_OVERRIDES[name];
    if (!Number.isFinite(fraction)) throw new RangeError(`Unknown time-of-day override: ${name}`);
    clock.overrideFraction = fraction;
    return name;
  }

  function fractionAtNow() {
    if (Number.isFinite(clock.overrideFraction)) return clock.overrideFraction;
    const dayMilliseconds = dayLengthMinutes * 60_000;
    return ((clock.milliseconds / dayMilliseconds) + startFraction + clock.offsetFraction) % 1;
  }

  function update(nowMilliseconds = clock.milliseconds) {
    if (!Number.isFinite(nowMilliseconds)) throw new RangeError('Time-of-day update needs a finite time');
    const interval = 1000 / policy.maxUpdatesHz;
    if (nowMilliseconds - diagnostics.lastUpdateAt < interval - 1e-9) {
      diagnostics.skippedUpdates++;
      diagnostics.writesThisUpdate = 0;
      return false;
    }
    diagnostics.lastUpdateAt = nowMilliseconds;
    diagnostics.updates++;
    sampleSky({ fraction: fractionAtNow(), latitude, longitude, dayOfYear, out: state });
    let writes = 0;
    for (const [key, list] of writersByKey) {
      if (writes >= policy.maxUniformWritesPerUpdate) break;
      if (!changed(key)) continue;
      let wrote = 0;
      for (const writer of list) {
        if (writes >= policy.maxUniformWritesPerUpdate) break;
        writer.write(state[key], state);
        writes++;
        wrote++;
      }
      if (wrote > 0) recordWritten(state, key);
    }
    diagnostics.writesThisUpdate = writes;
    diagnostics.uniformWrites += writes;
    if (writes > policy.maxUniformWritesPerUpdate) diagnostics.overBudgetUpdates++;
    return writes > 0;
  }

  const api = Object.freeze({
    namespace: GDO_TIME_OF_DAY_NAMESPACE,
    profile,
    policy,
    limits: Object.freeze({
      maxUpdatesHz: policy.maxUpdatesHz,
      maxUniformWritesPerUpdate: policy.maxUniformWritesPerUpdate,
      starCount: policy.starCount,
    }),
    state,
    fractionAtNow,
    advance,
    setClock,
    setFraction,
    override,
    update,
    get clockMilliseconds() { return clock.milliseconds; },
    get overrideName() { return clock.overrideFraction == null ? null : clock.overrideFraction; },
    /** The audit consumes the same numbers the runtime writes. */
    sampleNow(out = {}) {
      return sampleSky({ fraction: fractionAtNow(), latitude, longitude, dayOfYear, out });
    },
    nightReadability() { return nightReadability(state); },
    diagnostics() {
      return Object.freeze({
        namespace: GDO_TIME_OF_DAY_NAMESPACE,
        profile,
        phase: state.phase,
        elevationDegrees: state.elevationDegrees,
        nightFactor: state.nightFactor,
        starOpacity: state.starOpacity,
        emissive: state.emissive,
        reducedMotion,
        updates: diagnostics.updates,
        skippedUpdates: diagnostics.skippedUpdates,
        uniformWrites: diagnostics.uniformWrites,
        writesThisUpdate: diagnostics.writesThisUpdate,
        overBudgetUpdates: diagnostics.overBudgetUpdates,
        steadyFrameAllocations: diagnostics.steadyFrameAllocations,
        limits: Object.freeze({
          maxUpdatesHz: policy.maxUpdatesHz,
          maxUniformWritesPerUpdate: policy.maxUniformWritesPerUpdate,
          maxStars: policy.starCount,
        }),
      });
    },
    dispose() {
      if (scope) scope.disposeAll?.();
    },
  });
  // `FND-07`: the ledger owns the clock, so a remount leaves no live writer.
  scope?.handle('clock', () => api.dispose(), api);
  return api;
}
