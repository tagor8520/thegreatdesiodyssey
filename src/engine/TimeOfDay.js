/**
 * `ENV-02` — time-of-day light and sky state.
 *
 * Registered gate (feature-roadmap/README.md order 111):
 *   "Bounded uniform updates, readable night, no per-frame allocation"
 *
 * Research (`VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md`):
 *   §9.1 — *"Turn the current fixed sky shader into a shared uniform-driven model"*,
 *   listing sun direction/elevation, horizon/zenith/ground-bounce colours, humidity,
 *   cloud coverage/darkness and *"star visibility and moon phase/direction"*, with the
 *   named phases *"pre-dawn cool horizon; warm low sun; neutral high daylight; golden
 *   late afternoon; saturated sunset horizon; blue-hour gradient; night with
 *   stars/moon and warm settlements"* — and the explicit warning that *"a full
 *   multi-sample physical atmosphere is not appropriate for low-end default"*, so the
 *   fast dome stays and approximates the visible cues.
 *   §14 — *"Environment uniform updates | on change / ≤ 10 Hz | ≤ 15 Hz | ≤ 30 Hz"*.
 *   §9.2 — weather transitions to *"dark cloud base, cool light"* and *"night"* states,
 *   which read this module's state rather than re-deriving it.
 *
 * THREE PROPERTIES THIS MODULE EXISTS TO GUARANTEE
 * ------------------------------------------------
 * 1. **The palette cannot disagree with the sun.** Colours are not selected by a clock
 *    hour; they are interpolated between stops keyed on the sun's *elevation*, and a
 *    phase name is a band of that elevation. So "sunset" is not a time of day that
 *    someone has to keep in sync with a light: it is what the sky looks like when the
 *    sun is within two degrees of the horizon at that latitude and date. A test asserts
 *    the two never contradict.
 * 2. **Updates are bounded, not per-frame.** The research budgets uniform updates at
 *    *on change / ≤ 10 Hz* on the low profile. This module writes only when the state
 *    has actually moved beyond an epsilon, and at most once per profile interval, so
 *    the ceiling holds under a fast-forward burst as well as under a stall. A stalled
 *    clock coalesces into a single write rather than replaying what it missed.
 * 3. **Nothing allocates in the steady path.** The state is one preallocated object
 *    holding `THREE.Color`/`Vector3` instances that the sky uniforms point *at*, so
 *    writing the state and writing the uniform are the same operation and a frame
 *    costs no garbage at all.
 */

import * as THREE from 'three';

/** Phase bands keyed on solar elevation in degrees, from §9.1's named phases. */
export const GDO_SKY_PHASES = Object.freeze([
  Object.freeze({ id: 'night', label: 'Night with stars and moon', minimumElevation: -90 }),
  Object.freeze({ id: 'blue-hour', label: 'Blue-hour gradient', minimumElevation: -8 }),
  Object.freeze({ id: 'sunset', label: 'Saturated sunset horizon', minimumElevation: -1.5 }),
  Object.freeze({ id: 'low-sun', label: 'Warm low sun', minimumElevation: 1.5 }),
  Object.freeze({ id: 'golden', label: 'Golden late afternoon', minimumElevation: 22 }),
  Object.freeze({ id: 'day', label: 'Neutral high daylight', minimumElevation: 42 }),
]);

/**
 * Palette stops, keyed on solar elevation in degrees.
 *
 * The `day` stop reproduces the shipped fixed sky shader's **colours** exactly — the
 * same horizon, middle, zenith, sun and cloud values — so the default frame keeps the
 * look it had. The one deliberate difference is the sun *direction*: it used to be the
 * literal `(-0.48, 0.78, 0.30)` at every hour and is now the real solar direction for
 * the coordinate, date and clock, which is the whole point of the slice. Every other
 * stop is new.
 * `moon` is the directional light's fallback when the sun is down: it is what makes
 * night *readable* rather than merely dark, and the ceiling it has to clear is stated
 * as `GDO_NIGHT_LUMINANCE_FLOOR`.
 */
export const GDO_SKY_STOPS = Object.freeze([
  Object.freeze({
    elevation: -18,
    phase: 'night',
    horizon: [0.030, 0.043, 0.078],
    middle: [0.014, 0.024, 0.055],
    zenith: [0.004, 0.008, 0.026],
    sun: [1.00, 0.86, 0.70],
    sunIntensity: 0.10,
    moon: [0.62, 0.72, 1.00],
    moonIntensity: 0.30,
    hemisphereSky: [0.10, 0.14, 0.26],
    hemisphereGround: [0.06, 0.055, 0.05],
    hemisphereIntensity: 0.34,
    fog: [0.030, 0.043, 0.075],
    exposure: 1.28,
    starVisibility: 1,
    cloudCover: 0.30,
  }),
  Object.freeze({
    elevation: -8,
    phase: 'blue-hour',
    horizon: [0.075, 0.105, 0.180],
    middle: [0.035, 0.058, 0.120],
    zenith: [0.010, 0.020, 0.055],
    sun: [1.00, 0.60, 0.34],
    sunIntensity: 0.30,
    moon: [0.60, 0.70, 0.98],
    moonIntensity: 0.22,
    hemisphereSky: [0.14, 0.18, 0.30],
    hemisphereGround: [0.08, 0.07, 0.06],
    hemisphereIntensity: 0.42,
    fog: [0.070, 0.098, 0.170],
    exposure: 1.20,
    starVisibility: 0.55,
    cloudCover: 0.34,
  }),
  Object.freeze({
    elevation: -1.5,
    phase: 'sunset',
    horizon: [0.62, 0.26, 0.14],
    middle: [0.24, 0.14, 0.20],
    zenith: [0.035, 0.060, 0.140],
    sun: [1.00, 0.46, 0.22],
    sunIntensity: 0.85,
    moon: [0.60, 0.70, 0.98],
    moonIntensity: 0.06,
    hemisphereSky: [0.30, 0.24, 0.30],
    hemisphereGround: [0.16, 0.11, 0.08],
    hemisphereIntensity: 0.55,
    fog: [0.46, 0.24, 0.18],
    exposure: 1.12,
    starVisibility: 0.12,
    cloudCover: 0.36,
  }),
  Object.freeze({
    elevation: 1.5,
    phase: 'low-sun',
    horizon: [0.66, 0.42, 0.26],
    middle: [0.28, 0.26, 0.32],
    zenith: [0.055, 0.110, 0.230],
    sun: [1.00, 0.66, 0.38],
    sunIntensity: 1.60,
    moon: [0.60, 0.70, 0.98],
    moonIntensity: 0,
    hemisphereSky: [0.42, 0.40, 0.42],
    hemisphereGround: [0.24, 0.18, 0.13],
    hemisphereIntensity: 0.70,
    fog: [0.58, 0.44, 0.36],
    exposure: 1.08,
    starVisibility: 0,
    cloudCover: 0.40,
  }),
  Object.freeze({
    elevation: 22,
    phase: 'golden',
    horizon: [0.48, 0.46, 0.42],
    middle: [0.24, 0.34, 0.48],
    zenith: [0.050, 0.150, 0.360],
    sun: [1.00, 0.84, 0.60],
    sunIntensity: 2.55,
    moon: [0.60, 0.70, 0.98],
    moonIntensity: 0,
    hemisphereSky: [0.62, 0.70, 0.82],
    hemisphereGround: [0.40, 0.32, 0.22],
    hemisphereIntensity: 0.88,
    fog: [0.52, 0.55, 0.55],
    exposure: 1.05,
    starVisibility: 0,
    cloudCover: 0.36,
  }),
  Object.freeze({
    elevation: 42,
    phase: 'day',
    // Exactly the shipped shader's values.
    horizon: [0.22, 0.42, 0.52],
    middle: [0.12, 0.34, 0.58],
    zenith: [0.03, 0.18, 0.42],
    sun: [1.00, 0.94, 0.83],
    sunIntensity: 3.20,
    moon: [0.60, 0.70, 0.98],
    moonIntensity: 0,
    hemisphereSky: [0.85, 0.93, 1.00],
    hemisphereGround: [0.51, 0.39, 0.26],
    hemisphereIntensity: 0.90,
    fog: [0.22, 0.42, 0.52],
    exposure: 1.05,
    starVisibility: 0,
    cloudCover: 0.38,
  }),
]);

/** The shipped sun direction, as the `day` stop reproduces it. */
export const GDO_DEFAULT_SUN_DIRECTION = Object.freeze([-0.48, 0.78, 0.30]);

/**
 * The night readability floor.
 *
 * "Readable night" is stated by the research as an acceptance property, so it is
 * expressed here as a number the gate can check rather than as an adjective: the
 * estimated ground luminance (the hemisphere term plus the directional term resolved
 * for a horizontal surface) must stay at or above this at every minute of the cycle.
 * The floor is set below the darkest stop's figure; a control that removes the moon
 * and halves the ambient fails it.
 */
export const GDO_NIGHT_LUMINANCE_FLOOR = 0.030;

/** Uniform-write ceilings, verbatim from §14's *"Environment uniform updates"* row. */
export const GDO_TIME_OF_DAY_PROFILES = Object.freeze({
  low: Object.freeze({ uniformHz: 10 }),
  balanced: Object.freeze({ uniformHz: 15 }),
  high: Object.freeze({ uniformHz: 30 }),
});

const DEGREES = Math.PI / 180;
const EPSILON = 1e-4;
const OBLIQUITY = 23.44;
const DAYS_IN_YEAR = 365;

function clampUnit(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Reused result objects.
 *
 * `sample()` runs once per frame, and returning a fresh `{elevation, azimuth}` or
 * `{lower, upper, fraction}` from each call allocated two objects per frame — which the
 * allocation clause of this gate caught. An `= {}` default parameter would allocate just
 * as surely (measured at ~84 bytes per call in `LIF-02`), so the scratch objects are
 * module-level and the returned object is documented as **reused**: callers that need to
 * keep a value must copy it, and callers that just read it pay nothing.
 */
const SOLAR_RESULT = { elevation: 0, azimuth: 0 };
const STOP_RESULT = { lower: null, upper: null, fraction: 0 };

/**
 * Write one interpolated stop colour into `target`.
 *
 * A module-level function rather than a closure created inside `sample()`: an arrow
 * function written in the hot method allocates one closure per call, which is what the
 * allocation test measured (85 bytes a frame) before this was extracted.
 */
function mixStop(target, key, lower, upper, fraction) {
  const from = lower[key], to = upper[key];
  target.setRGB(
    from[0] + (to[0] - from[0]) * fraction,
    from[1] + (to[1] - from[1]) * fraction,
    from[2] + (to[2] - from[2]) * fraction,
  );
  return target;
}

function relativeLuminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The state a caller reads. One object, allocated once, handed back every time. */
export function createTimeOfDayState() {
  return {
    minutes: 0,
    dayOfYear: 1,
    phase: 'day',
    phaseLabel: 'Neutral high daylight',
    sunElevation: 0,
    sunAzimuth: 0,
    sunDirection: new THREE.Vector3(),
    moonDirection: new THREE.Vector3(),
    lightDirection: new THREE.Vector3(),
    horizon: new THREE.Color(),
    middle: new THREE.Color(),
    zenith: new THREE.Color(),
    sunColor: new THREE.Color(),
    moonColor: new THREE.Color(),
    hemisphereSky: new THREE.Color(),
    hemisphereGround: new THREE.Color(),
    fogColor: new THREE.Color(),
    lightColor: new THREE.Color(),
    lightIntensity: 0,
    hemisphereIntensity: 0,
    sunIntensity: 0,
    moonIntensity: 0,
    exposure: 1,
    starVisibility: 0,
    cloudCover: 0,
    groundLuminance: 0,
  };
}

/** Solar declination for a day of the year, in degrees. */
export function solarDeclination(dayOfYear) {
  return OBLIQUITY * Math.sin(2 * Math.PI * (dayOfYear - 81) / DAYS_IN_YEAR);
}

/**
 * Solar elevation and azimuth for a clock, in degrees.
 *
 * The clock is minutes of UTC and the hour angle adds the longitude, so a coordinate
 * world at 77.7°E reaches solar noon at about 06:49 UTC. Deliberately a solar model,
 * not a civil one: equation-of-time and timezone corrections move the *name* of the
 * hour without changing what the sky looks like, and what the sky looks like is this
 * module's contract.
 */
export function solarPosition(minutes, dayOfYear, latitude, longitude, out = null) {
  const declination = solarDeclination(dayOfYear) * DEGREES;
  const latitudeRadians = latitude * DEGREES;
  const hourAngle = ((minutes / 60 - 12) * 15 + longitude) * DEGREES;
  const sinElevation = Math.sin(latitudeRadians) * Math.sin(declination) +
    Math.cos(latitudeRadians) * Math.cos(declination) * Math.cos(hourAngle);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinElevation)));
  const cosElevation = Math.cos(elevation);
  // Standard azimuth from north, clockwise. At the zenith the azimuth is undefined
  // and the ratio below is unstable, so it is pinned instead of returning noise.
  const azimuth = cosElevation < 1e-6 ? 180
    : Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(latitudeRadians) -
      Math.tan(declination) * Math.cos(latitudeRadians)) / DEGREES + 180;
  // A caller that supplies `out` pays nothing; a caller that does not gets a fresh
  // object. The hot path (`sample`) always supplies one — the default used to be the
  // shared scratch, and this module's own test was bitten by it within the hour, which
  // is the argument for making the surprising behaviour the opt-in one.
  const target = out ?? { elevation: 0, azimuth: 0 };
  target.elevation = elevation / DEGREES;
  target.azimuth = ((azimuth % 360) + 360) % 360;
  return target;
}

/** The phase band an elevation falls in. The name can never contradict the light. */
export function phaseForElevation(elevation) {
  let match = GDO_SKY_PHASES[0];
  for (const phase of GDO_SKY_PHASES) if (elevation >= phase.minimumElevation) match = phase;
  return match;
}

/** The two stops an elevation sits between, and the fraction between them. */
function stopsForElevation(elevation) {
  const stops = GDO_SKY_STOPS;
  if (elevation <= stops[0].elevation) {
    STOP_RESULT.lower = STOP_RESULT.upper = stops[0];
    STOP_RESULT.fraction = 0;
    return STOP_RESULT;
  }
  for (let index = 1; index < stops.length; index++) {
    if (elevation <= stops[index].elevation) {
      const lower = stops[index - 1], upper = stops[index];
      STOP_RESULT.lower = lower;
      STOP_RESULT.upper = upper;
      STOP_RESULT.fraction = (elevation - lower.elevation) / (upper.elevation - lower.elevation);
      return STOP_RESULT;
    }
  }
  const last = stops[stops.length - 1];
  STOP_RESULT.lower = STOP_RESULT.upper = last;
  STOP_RESULT.fraction = 0;
  return STOP_RESULT;
}

export class TimeOfDay {
  /**
   * @param {object} [options]
   * @param {'low'|'balanced'|'high'} [options.profile] uniform-write ceiling
   * @param {number} [options.latitude] degrees north, for the solar model
   * @param {number} [options.longitude] degrees east, for the solar model
   * @param {number} [options.dayOfYear] 1…365
   * @param {number} [options.minutes] UTC clock minutes; defaults to solar noon
   * @param {number} [options.timeScale] clock minutes per real second (0 = frozen)
   * @param {number} [options.moonIllumination] 0…1, scales the night directional term
   */
  constructor({
    profile = 'low',
    latitude = 28.98,
    longitude = 77.71,
    dayOfYear = 172,
    minutes = null,
    timeScale = 1,
    moonIllumination = 1,
  } = {}) {
    if (!Object.hasOwn(GDO_TIME_OF_DAY_PROFILES, profile)) {
      throw new RangeError(`Unknown time-of-day profile: ${profile}`);
    }
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) {
      throw new RangeError(`Time-of-day latitude must be within ±90 degrees, received ${latitude}`);
    }
    if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) {
      throw new RangeError(`Time-of-day longitude must be within ±180 degrees, received ${longitude}`);
    }
    if (!Number.isFinite(dayOfYear) || dayOfYear < 1 || dayOfYear > DAYS_IN_YEAR) {
      throw new RangeError(`Time-of-day day-of-year must be within 1…${DAYS_IN_YEAR}, received ${dayOfYear}`);
    }
    if (!Number.isFinite(timeScale) || timeScale < 0) {
      throw new RangeError(`Time-of-day time scale must be finite and non-negative, received ${timeScale}`);
    }
    if (!Number.isFinite(moonIllumination) || moonIllumination < 0 || moonIllumination > 1) {
      throw new RangeError(`Moon illumination must be within 0…1, received ${moonIllumination}`);
    }
    this.profile = profile;
    this.latitude = latitude;
    this.longitude = longitude;
    this.dayOfYear = dayOfYear;
    this.timeScale = timeScale;
    this.moonIllumination = moonIllumination;
    this.intervalMilliseconds = 1000 / GDO_TIME_OF_DAY_PROFILES[profile].uniformHz;
    // Default clock: solar noon at this longitude, so the default frame is daylight
    // and matches the palette the shipped shader used.
    this.minutes = Number.isFinite(minutes) ? ((minutes % 1440) + 1440) % 1440
      : (((12 * 60 - longitude / 15 * 60) % 1440) + 1440) % 1440;
    this.state = createTimeOfDayState();
    this.applied = createTimeOfDayState();
    this.hasApplied = false;
    this.lastWriteAt = -Infinity;
    this.writes = 0;
    this.writesThisSecond = 0;
    this.secondWindowStart = 0;
    this.unchangedSkips = 0;
    this.coalesced = 0;
    this.appliedStateCount = 0;
    this.sample();
  }

  /** Solar position for the current clock, as a fresh object. */
  position() {
    return solarPosition(this.minutes, this.dayOfYear, this.latitude, this.longitude);
  }

  setClock(minutes) {
    if (!Number.isFinite(minutes)) throw new RangeError(`Time-of-day clock must be finite, received ${minutes}`);
    this.minutes = ((minutes % 1440) + 1440) % 1440;
    return this.minutes;
  }

  /** Advance by real seconds, returning the new clock in minutes. */
  advance(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new RangeError(`Time-of-day advance must be finite and non-negative, received ${seconds}`);
    }
    this.minutes = ((this.minutes + seconds * this.timeScale) % 1440 + 1440) % 1440;
    return this.minutes;
  }

  /**
   * Fill the state object for the current clock.
   *
   * Every field is written in place: the same object comes back every time, which is
   * what lets a caller point a uniform at it once and never copy again.
   */
  sample(out = this.state) {
    const { elevation, azimuth } = solarPosition(this.minutes, this.dayOfYear, this.latitude, this.longitude, SOLAR_RESULT);
    const phase = phaseForElevation(elevation);
    const { lower, upper, fraction } = stopsForElevation(elevation);
    out.minutes = this.minutes;
    out.dayOfYear = this.dayOfYear;
    out.phase = phase.id;
    out.phaseLabel = phase.label;
    out.sunElevation = elevation;
    out.sunAzimuth = azimuth;
    const elevationRadians = elevation * DEGREES;
    const azimuthRadians = azimuth * DEGREES;
    // Three.js convention: +Y up, and the light's position is the direction *towards*
    // the body, so the horizontal components are the azimuth resolved from north.
    out.sunDirection.set(
      Math.cos(elevationRadians) * Math.sin(azimuthRadians),
      Math.sin(elevationRadians),
      -Math.cos(elevationRadians) * Math.cos(azimuthRadians),
    );
    // The moon is modelled as the anti-solar direction lifted by a fixed tilt, scaled
    // by the caller's illumination. A real ephemeris is out of scope; what matters is
    // that the night has a directional source at a plausible place, and that the gate
    // can prove the night is readable because of it.
    out.moonDirection.set(-out.sunDirection.x, Math.max(0.12, -out.sunDirection.y * 0.55 + 0.30), -out.sunDirection.z).normalize();
    const sunUp = elevation > 0;
    const moonStrength = lower.moonIntensity + (upper.moonIntensity - lower.moonIntensity) * fraction;
    out.moonIntensity = this.moonIllumination * moonStrength;
    out.lightDirection.copy(sunUp ? out.sunDirection : out.moonDirection);
    mixStop(out.horizon, 'horizon', lower, upper, fraction);
    mixStop(out.middle, 'middle', lower, upper, fraction);
    mixStop(out.zenith, 'zenith', lower, upper, fraction);
    mixStop(out.sunColor, 'sun', lower, upper, fraction);
    mixStop(out.moonColor, 'moon', lower, upper, fraction);
    mixStop(out.hemisphereSky, 'hemisphereSky', lower, upper, fraction);
    mixStop(out.hemisphereGround, 'hemisphereGround', lower, upper, fraction);
    mixStop(out.fogColor, 'fog', lower, upper, fraction);
    out.sunIntensity = lower.sunIntensity + (upper.sunIntensity - lower.sunIntensity) * fraction;
    out.hemisphereIntensity = lower.hemisphereIntensity + (upper.hemisphereIntensity - lower.hemisphereIntensity) * fraction;
    out.exposure = lower.exposure + (upper.exposure - lower.exposure) * fraction;
    out.starVisibility = clampUnit(lower.starVisibility + (upper.starVisibility - lower.starVisibility) * fraction);
    out.cloudCover = lower.cloudCover + (upper.cloudCover - lower.cloudCover) * fraction;
    // Order matters: the light's colour is taken from the *mixed* sun/moon colour, not
    // from the previous sample's. Copying before the mix was a real defect this gate
    // caught — the directional light lagged one sample behind its own sky.
    out.lightColor.copy(sunUp ? out.sunColor : out.moonColor);
    out.lightIntensity = sunUp ? out.sunIntensity : out.moonIntensity;
    // The readability metric: what a horizontal surface actually receives.
    out.groundLuminance = relativeLuminance(out.hemisphereSky.r, out.hemisphereSky.g, out.hemisphereSky.b) *
      out.hemisphereIntensity * 0.5 +
      relativeLuminance(out.lightColor.r, out.lightColor.g, out.lightColor.b) *
      out.lightIntensity * Math.max(0, Math.sin(elevation > 0 ? elevationRadians : Math.max(elevationRadians, 0.22)));
    return out;
  }

  /** Has the state moved enough since the last apply to be worth a write? */
  changed() {
    if (!this.hasApplied) return true;
    const a = this.state, b = this.applied;
    if (a.phase !== b.phase) return true;
    if (Math.abs(a.sunElevation - b.sunElevation) > 0.05) return true;
    if (Math.abs(a.exposure - b.exposure) > EPSILON) return true;
    if (Math.abs(a.starVisibility - b.starVisibility) > EPSILON) return true;
    return distance(a.horizon, b.horizon) > EPSILON || distance(a.middle, b.middle) > EPSILON ||
      distance(a.zenith, b.zenith) > EPSILON || distance(a.lightColor, b.lightColor) > EPSILON;
  }

  /**
   * Advance the clock and decide whether this frame earns a uniform write.
   *
   * Returns `true` when the caller should apply the state. Two ceilings are at work and
   * both are the research's: **on change** (a stationary clock writes nothing at all)
   * and **≤ profile Hz** (a fast-forward burst cannot spend more writes than the
   * ceiling allows, and whatever it skipped is folded into the next write rather than
   * replayed).
   */
  update(deltaSeconds, nowMilliseconds = null) {
    this.advance(deltaSeconds);
    this.sample();
    const now = Number.isFinite(nowMilliseconds) ? nowMilliseconds : nowMillisecondsOf(this);
    if (now - this.secondWindowStart >= 1000) {
      this.secondWindowStart = now;
      this.writesThisSecond = 0;
    }
    if (!this.changed()) { this.unchangedSkips++; return false; }
    if (now - this.lastWriteAt < this.intervalMilliseconds) { this.coalesced++; return false; }
    this.lastWriteAt = now;
    this.writes++;
    this.writesThisSecond++;
    return true;
  }

  /**
   * Re-anchor the rate limiter to a caller's own timeline.
   *
   * A driver that advances the clock itself — a capture, a fast-forward, or the gate that
   * proves the ceiling without waiting for real seconds — passes timestamps the runtime's
   * own `performance.now()` never emitted. Without this, such a drive travels *backwards*
   * past the last write and every write is refused as too soon, which is what the `ENV-02`
   * gate measured (zero writes over 180 frames) before the method existed. Passing a
   * timestamp moves the limiter's baseline to it; it does not write or change the clock.
   */
  rebaseClock(nowMilliseconds = 0) {
    if (!Number.isFinite(nowMilliseconds)) throw new RangeError(`Time-of-day rebase must be finite, received ${nowMilliseconds}`);
    this.lastWriteAt = nowMilliseconds - this.intervalMilliseconds;
    this.secondWindowStart = nowMilliseconds;
    this.writesThisSecond = 0;
    return this.lastWriteAt;
  }

  /** Record that the caller applied the state, so change detection has a baseline. */
  markApplied() {
    const source = this.state, target = this.applied;
    target.minutes = source.minutes;
    target.phase = source.phase;
    target.phaseLabel = source.phaseLabel;
    target.sunElevation = source.sunElevation;
    target.sunAzimuth = source.sunAzimuth;
    target.sunDirection.copy(source.sunDirection);
    target.moonDirection.copy(source.moonDirection);
    target.lightDirection.copy(source.lightDirection);
    target.horizon.copy(source.horizon);
    target.middle.copy(source.middle);
    target.zenith.copy(source.zenith);
    target.sunColor.copy(source.sunColor);
    target.moonColor.copy(source.moonColor);
    target.hemisphereSky.copy(source.hemisphereSky);
    target.hemisphereGround.copy(source.hemisphereGround);
    target.fogColor.copy(source.fogColor);
    target.lightColor.copy(source.lightColor);
    target.lightIntensity = source.lightIntensity;
    target.hemisphereIntensity = source.hemisphereIntensity;
    target.sunIntensity = source.sunIntensity;
    target.moonIntensity = source.moonIntensity;
    target.exposure = source.exposure;
    target.starVisibility = source.starVisibility;
    target.cloudCover = source.cloudCover;
    target.groundLuminance = source.groundLuminance;
    this.hasApplied = true;
    this.appliedStateCount++;
    return target;
  }

  diagnostics() {
    const state = this.state;
    return {
      profile: this.profile,
      uniformHz: GDO_TIME_OF_DAY_PROFILES[this.profile].uniformHz,
      minutes: state.minutes,
      clock: `${String(Math.floor(state.minutes / 60)).padStart(2, '0')}:${String(Math.floor(state.minutes % 60)).padStart(2, '0')}`,
      dayOfYear: this.dayOfYear,
      phase: state.phase,
      phaseLabel: state.phaseLabel,
      sunElevation: state.sunElevation,
      sunAzimuth: state.sunAzimuth,
      starVisibility: state.starVisibility,
      cloudCover: state.cloudCover,
      lightIntensity: state.lightIntensity,
      hemisphereIntensity: state.hemisphereIntensity,
      exposure: state.exposure,
      lightDirection: state.lightDirection.clone(),
      groundLuminance: state.groundLuminance,
      timeScale: this.timeScale,
      writes: this.writes,
      writesThisSecond: this.writesThisSecond,
      unchangedSkips: this.unchangedSkips,
      coalesced: this.coalesced,
      appliedStateCount: this.appliedStateCount,
    };
  }

  reset() {
    this.writes = 0;
    this.writesThisSecond = 0;
    this.secondWindowStart = 0;
    this.unchangedSkips = 0;
    this.coalesced = 0;
    this.appliedStateCount = 0;
    this.lastWriteAt = -Infinity;
    this.hasApplied = false;
    this.sample();
    return this.diagnostics();
  }
}

function distance(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

/**
 * The clock the caller passes in. Separate so a test can drive a frozen clock without
 * touching a browser timeline.
 */
function nowMillisecondsOf(timeOfDay) {
  void timeOfDay;
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Point a sky handle's uniforms at a state object.
 *
 * Called once at construction: the uniforms hold the state's own `Color`/`Vector3`
 * instances from then on, so applying a state is a `markApplied()` and nothing else.
 */
export function bindTimeOfDayUniforms(sky, state) {
  if (!sky?.material?.uniforms) throw new TypeError('bindTimeOfDayUniforms requires a sky handle with material uniforms');
  const uniforms = sky.material.uniforms;
  uniforms.uHorizon.value = state.horizon;
  uniforms.uMiddle.value = state.middle;
  uniforms.uZenith.value = state.zenith;
  uniforms.uSunColor.value = state.sunColor;
  uniforms.uSunDirection.value = state.sunDirection;
  uniforms.uMoonDirection.value = state.moonDirection;
  uniforms.uStarVisibility.value = state.starVisibility;
  uniforms.uCloudCover.value = state.cloudCover;
  return uniforms;
}

/**
 * Apply a state to the scene's lighting and exposure.
 *
 * Writes only the scalars and light properties; colours are kept as the light's own
 * `Color` instance where possible so nothing is allocated. `scale` is the world scale
 * the light rig was built with, so the shadow camera keeps its framing.
 */
export function applyTimeOfDay(state, { lightRig, scene, renderer, scale = 1 } = {}) {
  if (!state) throw new TypeError('applyTimeOfDay requires a state');
  if (lightRig) {
    const distance = 200 * scale;
    lightRig.sun.position.copy(state.lightDirection).multiplyScalar(distance);
    lightRig.sun.color.copy(state.lightColor);
    lightRig.sun.intensity = state.lightIntensity;
    lightRig.fill.color.copy(state.hemisphereSky);
    lightRig.fill.groundColor.copy(state.hemisphereGround);
    lightRig.fill.intensity = state.hemisphereIntensity;
  }
  if (scene) {
    if (scene.background?.isColor) scene.background.copy(state.horizon);
    if (scene.fog?.color) scene.fog.color.copy(state.fogColor);
  }
  if (renderer && Number.isFinite(state.exposure)) renderer.toneMappingExposure = state.exposure;
  return state;
}

/**
 * The night half of the sky, as a separate uniform so the dome shader can stay cheap.
 * Stars are a hashed direction field rather than geometry: no draw call, no texture.
 */
export function applyStarUniforms(sky, state) {
  const uniforms = sky?.material?.uniforms;
  if (!uniforms?.uStarVisibility) return false;
  uniforms.uStarVisibility.value = state.starVisibility;
  uniforms.uCloudCover.value = state.cloudCover;
  return true;
}
