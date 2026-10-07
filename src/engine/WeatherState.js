/**
 * `ENV-04` — weather state machine.
 *
 * Registered gate (feature-roadmap/README.md order 113):
 *   "Deterministic transitions, environment response, low-profile fallback"
 *
 * Research:
 *   `VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md` §9.2 — the eight-state table (clear, haze,
 *   overcast, rain, storm, dust, snow, mist) with its four columns (*sky/light*, *surface
 *   response*, *particles/motion*, *habitat response*), and the rule this module exists to
 *   satisfy: *"Weather is deterministic from macro climate + month + world-time window +
 *   coordinate weather seed. It should transition over time rather than roll independently
 *   each frame."* §3.3 lists `weather state` as one axis of the layered environment
 *   composition; §4.2's environment sample carries `weatherState`.
 *   `PROCEDURAL_WORLD_FEATURE_RESEARCH.md` §4.6 — *"Seeded Markov/state schedule by biome
 *   and world time; no live API dependency"*, and *"Live weather would be location-authentic
 *   but not reproducible … The default should be deterministic climate weather."*
 *   §14 — *"Environment uniform updates | on change / ≤ 10 Hz | ≤ 15 Hz | ≤ 30 Hz"* and
 *   *"Transparent weather particles visible | 80 | 180 | 350"*.
 *   §9.4/§9.5 — particles are camera-local, pooled and capped, and the low profile *may omit*
 *   them; §8 — *"Shader quality changes update uniforms/defines only at setup, not recompile
 *   every weather transition."*
 *
 * THREE PROPERTIES THIS MODULE EXISTS TO GUARANTEE
 * ------------------------------------------------
 * 1. **The weather at a time is a function of that time.** Not of the session, not of how
 *    long the player has been walking, not of how many frames ran. A late joiner, a reloaded
 *    save and a capture that jumps the clock all see the same sky at the same coordinate
 *    clock, because the schedule is *random-accessible*: the state of any window is computed
 *    from the seed and the window index alone. There is no `Math.random()` and no live API.
 * 2. **Transitions are over time, not per frame.** A window is 90 world minutes and a change
 *    lands across an 18-minute cross-fade, so the response fields are continuous in the clock
 *    (a test asserts that one minute of clock never moves any field by more than a small
 *    epsilon) while the *state* is discrete. The twelve-hour re-derive of the whole schedule
 *    costs nothing because the chain is anchored at the day boundary.
 * 3. **The low profile is a fallback, not a degraded copy.** Every state's response is
 *    expressible through surfaces the runtime already has — sky coverage and cloud darkening,
 *    fog range and colour, light and ambient scale, exposure, water ripple and wetness — so
 *    the low profile ships **zero** particle families and **zero** added draws, and the gate
 *    proves the weather is still *visible* there. Particles are `ENV-05`'s slice; this module
 *    only declares the budget they may not exceed.
 */

/**
 * The eight states of §9.2, as data.
 *
 * Every field is a number so that two states can be blended field-by-field with no
 * special cases, and every field is documented with the research column it realises:
 *
 * - sky/light    `cloudCover` (added to the time-of-day cover), `cloudDarkness`,
 *                `lightScale`, `hemisphereScale`, `exposureBias`
 * - surface      `wetness`, `ripple`
 * - motion       `cloudSpeed` (sky drift — *not* the rejected vegetation wind)
 * - habitat      `birdActivity`, `beeActivity`
 * - particles    `particleIntensity` (declared for `ENV-05`; never drawn here)
 *
 * `clear` is the identity response: every scale is 1, every additive term 0. That is what
 * lets the runtime open on the frame it shipped before weather existed, and it is asserted
 * rather than assumed — `clear` composed onto a time-of-day state reproduces that state's
 * own ground luminance exactly.
 */
const state = (id, label, fields) => Object.freeze({ id, label, ...fields });

export const GDO_WEATHER_STATES = Object.freeze({
  clear: state('clear', 'Clear', {
    // high contrast, low cloud · dry · no drift · normal birds/bees. **Every field is the
    // identity** — zero, or one for the three scales — because `clear` must reproduce the
    // pre-weather frame exactly: the same fog colour and range, the same light intensities,
    // the same exposure, and the same *static* cloud cells the shader drew before this
    // change introduced a drift uniform. A test asserts it field by field and a luminance
    // probe asserts it arithmetically, so a drift here would be caught rather than felt.
    cloudCover: 0, cloudDarkness: 0,
    lightScale: 1, hemisphereScale: 1, exposureBias: 0,
    fogDensity: 0, fogTint: 0, fogWarmth: 0, fogLightness: 1,
    wetness: 0, ripple: 0, cloudSpeed: 0,
    birdActivity: 1, beeActivity: 1, particleIntensity: 0,
  }),
  haze: state('haze', 'Haze', {
    // bright horizon, reduced distance · dusty/desaturated distance · few dust motes
    // · fewer high birds
    cloudCover: .05, cloudDarkness: .08,
    lightScale: .95, hemisphereScale: .95, exposureBias: .02,
    fogDensity: .45, fogTint: .7, fogWarmth: .45, fogLightness: 1.05,
    wetness: 0, ripple: 0, cloudSpeed: .25,
    birdActivity: .6, beeActivity: .8, particleIntensity: .15,
  }),
  overcast: state('overcast', 'Overcast', {
    // soft low-contrast light · neutral · stronger cloud motion · calmer insects
    cloudCover: .35, cloudDarkness: .42,
    lightScale: .72, hemisphereScale: .9, exposureBias: .03,
    fogDensity: .15, fogTint: .45, fogWarmth: 0, fogLightness: .78,
    wetness: .06, ripple: .05, cloudSpeed: .6,
    birdActivity: .8, beeActivity: .6, particleIntensity: 0,
  }),
  rain: state('rain', 'Rain', {
    // dark cloud base, cool light · wet roads/soil, stronger ripples · camera-local rain
    // · birds sheltered
    cloudCover: .5, cloudDarkness: .62,
    lightScale: .6, hemisphereScale: .8, exposureBias: .05,
    fogDensity: .4, fogTint: .6, fogWarmth: -.35, fogLightness: .62,
    wetness: .85, ripple: .8, cloudSpeed: .75,
    birdActivity: .35, beeActivity: .3, particleIntensity: .8,
  }),
  storm: state('storm', 'Storm', {
    // dark sky · wet · stronger gusts · suppress ordinary flyers. The dark is carried by the
    // cloud base, the cloud tone and the fog; the *light* scale stays high enough that a
    // storm at night is still above the readability floor, which is what the retention
    // constant below and the composition test measure.
    cloudCover: .62, cloudDarkness: .82,
    lightScale: .52, hemisphereScale: .74, exposureBias: .06,
    fogDensity: .55, fogTint: .7, fogWarmth: -.45, fogLightness: .42,
    wetness: 1, ripple: 1, cloudSpeed: 1,
    birdActivity: .1, beeActivity: .05, particleIntensity: 1,
  }),
  dust: state('dust', 'Dust', {
    // warm low visibility · dust overlay · low opaque/dithered gust strips
    // · suppress insects
    cloudCover: .25, cloudDarkness: .3,
    lightScale: .62, hemisphereScale: .85, exposureBias: -.02,
    fogDensity: .6, fogTint: .85, fogWarmth: 1, fogLightness: .95,
    wetness: 0, ripple: .1, cloudSpeed: .9,
    birdActivity: .5, beeActivity: .1, particleIntensity: .7,
  }),
  snow: state('snow', 'Snow', {
    // cool low sun/overcast · snow overlay on upward faces · sparse camera-local flakes
    // · reduced small life
    cloudCover: .55, cloudDarkness: .34,
    lightScale: .7, hemisphereScale: .95, exposureBias: .1,
    fogDensity: .5, fogTint: .6, fogWarmth: -.15, fogLightness: 1.15,
    wetness: .15, ripple: .2, cloudSpeed: .5,
    birdActivity: .4, beeActivity: .15, particleIntensity: .6,
  }),
  mist: state('mist', 'Mist', {
    // low contrast near water/valley · damp · no dense full-screen particles
    // · water/wetland emphasis
    cloudCover: .15, cloudDarkness: .2,
    lightScale: .7, hemisphereScale: .85, exposureBias: .04,
    fogDensity: .85, fogTint: .9, fogWarmth: -.05, fogLightness: .9,
    wetness: .35, ripple: .3, cloudSpeed: .15,
    birdActivity: .7, beeActivity: .5, particleIntensity: 0,
  }),
});

/** State ids in table order. Climate weight arrays and transitions are aligned to this. */
export const GDO_WEATHER_STATE_IDS = Object.freeze(Object.keys(GDO_WEATHER_STATES));

/** The blended, numeric fields. Everything else on `state` is identity, not weather. */
export const GDO_WEATHER_FIELDS = Object.freeze([
  'cloudCover', 'cloudDarkness', 'lightScale', 'hemisphereScale', 'exposureBias',
  'fogDensity', 'fogTint', 'fogWarmth', 'fogLightness',
  'wetness', 'ripple', 'cloudSpeed',
  'birdActivity', 'beeActivity', 'particleIntensity',
]);

/**
 * A window is 90 world minutes and a change lands across the first 18 of them.
 *
 * Short enough that a player who watches the sky sees more than one weather state in a
 * session at the default clock rate, long enough that the state is a *state* rather than a
 * flicker. `GDO_WEATHER_WINDOWS_PER_DAY` is what bounds the random-access walk.
 */
export const GDO_WEATHER_WINDOW_MINUTES = 90;
export const GDO_WEATHER_TRANSITION_MINUTES = 18;
export const GDO_WEATHER_WINDOWS_PER_DAY = 1440 / GDO_WEATHER_WINDOW_MINUTES;

/**
 * Profiles: the research's uniform-update ceiling, and the particle budget `ENV-05` may use.
 *
 * The particle caps are §14's *"transparent weather particles visible"* column. The low
 * profile's `particleFamilies: 0` is §9.5's *"low may omit"* turned into the shipped default
 * rather than left to a later slice's discretion: on the low profile the weather is
 * uniform-driven only, and the gate measures that it is still visible.
 */
export const GDO_WEATHER_PROFILES = Object.freeze({
  low: Object.freeze({ uniformHz: 10, particleFamilies: 0, particleCap: 0 }),
  balanced: Object.freeze({ uniformHz: 15, particleFamilies: 1, particleCap: 80 }),
  high: Object.freeze({ uniformHz: 30, particleFamilies: 2, particleCap: 180 }),
});

/** §14's ceiling, kept beside the profiles so the test can check one against the other. */
export const GDO_WEATHER_PARTICLE_CEILINGS = Object.freeze({ low: 80, balanced: 180, high: 350 });

/**
 * Climate state weights — the *macro climate* half of the research's four inputs.
 *
 * A zero weight is a prohibition rather than a rarity: snow never falls in a tropical or
 * semi-arid climate, dust never blows in a temperate or cold one, and the test asserts over
 * a multi-year sweep that no climate ever produces a state it gives zero weight to.
 * The rows are aligned with `GDO_WEATHER_STATE_IDS`.
 */
export const GDO_WEATHER_CLIMATES = Object.freeze({
  tropical: Object.freeze({
    label: 'Tropical seasonal',
    weights: Object.freeze([.34, .14, .10, .22, .08, 0, 0, .12]),
  }),
  monsoon: Object.freeze({
    label: 'Subtropical monsoon',
    weights: Object.freeze([.22, .12, .14, .30, .10, 0, 0, .12]),
  }),
  'semi-arid': Object.freeze({
    label: 'Hot semi-arid',
    weights: Object.freeze([.40, .18, .10, .02, 0, .22, 0, .08]),
  }),
  temperate: Object.freeze({
    label: 'Temperate',
    weights: Object.freeze([.30, .12, .22, .16, .04, 0, .06, .10]),
  }),
  cold: Object.freeze({
    label: 'Cold',
    weights: Object.freeze([.22, .06, .26, .06, .02, 0, .28, .10]),
  }),
});

export const GDO_WEATHER_CLIMATE_IDS = Object.freeze(Object.keys(GDO_WEATHER_CLIMATES));

/**
 * The Markov table: how likely a state is to persist or move to each other state.
 *
 * It expresses *adjacency* only — a storm decays into rain before it clears, dust comes from
 * haze, mist pools from haze or overcast — while the climate decides which states are
 * available at all. The final score for a transition is `markov[from][to] × climate[to]`, so
 * a state the climate forbids cannot be reached even from a neighbour that would allow it.
 * Rows are aligned with `GDO_WEATHER_STATE_IDS` and need not sum to one (the pick normalises).
 */
export const GDO_WEATHER_TRANSITIONS = Object.freeze([
  //              clear  haze  over  rain  storm dust  snow  mist
  Object.freeze([.55, .20, .12, .03, .01, .04, .02, .03]), // from clear
  Object.freeze([.25, .35, .10, .03, .01, .14, .02, .10]), // from haze
  Object.freeze([.14, .06, .36, .22, .06, .03, .06, .07]), // from overcast
  Object.freeze([.05, .03, .26, .38, .16, .02, .04, .06]), // from rain
  Object.freeze([.03, .02, .24, .38, .28, .02, .02, .01]), // from storm
  Object.freeze([.18, .30, .10, .02, .02, .30, .01, .07]), // from dust
  Object.freeze([.08, .03, .28, .06, .02, .01, .42, .10]), // from snow
  Object.freeze([.16, .22, .18, .05, .01, .03, .02, .33]), // from mist
]);

/**
 * The luminance a night may *keep* under the darkest weather.
 *
 * `ENV-02` states a readability floor for its own states; weather multiplies that state's
 * light and ambient terms, so the composition needs a floor of its own rather than an
 * assumption that multiplying two reasonable things stays reasonable. This is the fraction
 * of the unweathered ground luminance the worst state must retain, and the Node gate sweeps
 * the year × the clock × every state to hold it. It is a *retention* rather than an absolute
 * floor because it must compose with whatever `ENV-02` decided the night is worth.
 */
export const GDO_WEATHER_NIGHT_LUMINANCE_RETENTION = 0.52;

/** The shipped default clock, matching `ENV-02`'s defaults, for the tests and the docs. */
export const GDO_WEATHER_DEFAULT_LATITUDE = 28.98;
export const GDO_WEATHER_DEFAULT_LONGITUDE = 77.71;
export const GDO_WEATHER_DEFAULT_DAY_OF_YEAR = 172;

const DEGREES = Math.PI / 180;
const EPSILON = 1e-4;
/** Mirrors `GDO_NIGHT_LUMINANCE_FLOOR`'s own derivation, without importing the module. */
const NIGHT_FLOOR = 0.030;

function clamp(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function clampUnit(value) {
  return clamp(value, 0, 1);
}

/**
 * A 32-bit mixing hash, deterministic across engines.
 *
 * `Math.imul` is exact 32-bit integer multiplication with wraparound, so the whole schedule
 * is reproducible on every platform — the property that a save file (`NET-01`), a shared
 * coordinate and a gate all depend on. Four inputs are enough for (seed, day, window, salt).
 */
function hash32(a, b, c, d) {
  let h = 0x811c9dc5 ^ Math.imul(a | 0, 0x9e3779b1);
  h = Math.imul(h ^ (b | 0), 0x85ebca6b);
  h = Math.imul(h ^ (c | 0), 0xc2b2ae35);
  h = Math.imul(h ^ (d | 0), 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
  return h >>> 0;
}

/** A deterministic roll in `[0, 1)`. */
function roll01(a, b, c, d) {
  return hash32(a, b, c, d) / 4294967296;
}

function monthOfDay(dayOfYear) {
  return Math.min(12, Math.max(1, Math.floor((dayOfYear - 1) / 30.4) + 1));
}

/**
 * The climate of a latitude in a month — the *no-request* artistic fallback.
 *
 * `PROCEDURAL_WORLD_FEATURE_RESEARCH.md` §4.6 puts the macro climate in the weather seed's
 * inputs, and the project already has an artistic latitude-driven macro model in
 * `PlantMorphology` (`latitude-map-water-terrain-v1`); this is the same idea at weather
 * scale, and it is deliberately coarse because a *weather schedule* needs a climate class,
 * not a climatology. The monsoon months are the Indian summer monsoon (July–September);
 * outside them the Indo-Gangetic plain is hot and semi-arid, which is why the shipped
 * coordinate opens on that class.
 */
export function climateForLatitude(latitude, dayOfYear = GDO_WEATHER_DEFAULT_DAY_OF_YEAR) {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) {
    throw new RangeError(`Weather latitude must be within ±90 degrees, received ${latitude}`);
  }
  if (!Number.isFinite(dayOfYear) || dayOfYear < 1 || dayOfYear > 365) {
    throw new RangeError(`Weather day-of-year must be within 1…365, received ${dayOfYear}`);
  }
  const absolute = Math.abs(latitude);
  const month = monthOfDay(dayOfYear);
  if (absolute < 12) return 'tropical';
  if (absolute < 22) return 'monsoon';
  if (absolute < 33) return month >= 7 && month <= 9 ? 'monsoon' : 'semi-arid';
  if (absolute < 50) return 'temperate';
  return 'cold';
}

/**
 * The coordinate weather seed.
 *
 * FNV-1a over the provider and a **3-decimal** latitude/longitude, so a coordinate's weather
 * is a function of the coordinate and not of the session — the same idea as `GME-06`'s place
 * ids, at the scale a season needs. Three decimals is about 100 m, which is finer than a
 * player can walk in a weather window and coarse enough that a float that survived a
 * provider round-trip still hashes the same.
 */
export function weatherSeedForCoordinate({ latitude, longitude, provider = '' } = {}) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new TypeError('weatherSeedForCoordinate requires finite latitude and longitude');
  }
  const key = `${provider}|${latitude.toFixed(3)}|${longitude.toFixed(3)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The state index of one window, computed from the seed and the window index alone.
 *
 * The Markov chain is **anchored at the day boundary** and stepped at most
 * `GDO_WEATHER_WINDOWS_PER_DAY - 1` times. Anchoring is what makes the schedule
 * random-accessible: a player who joins at 14:00, a save file reloaded at 14:00 and a
 * capture that jumps straight to 14:00 must agree, and none of them can afford to replay
 * every window since the world began. The cost of that choice is that the chain does not
 * carry across midnight as one continuous Markov walk; the *observable* weather is still
 * continuous, because the cross-fade at a window boundary reads the resolved state of the
 * previous window, whatever day it belonged to.
 */
export function weatherStateIndexAt(seed, climateId, windowIndex) {
  if (!Object.hasOwn(GDO_WEATHER_CLIMATES, climateId)) {
    throw new RangeError(`Unknown weather climate: ${JSON.stringify(climateId)}`);
  }
  if (!Number.isFinite(windowIndex)) throw new RangeError(`Weather window index must be finite, received ${windowIndex}`);
  const window = Math.floor(windowIndex);
  const dayIndex = Math.floor(window / GDO_WEATHER_WINDOWS_PER_DAY);
  const indexInDay = window - dayIndex * GDO_WEATHER_WINDOWS_PER_DAY;
  const weights = GDO_WEATHER_CLIMATES[climateId].weights;
  let current = weightedIndex(weights, roll01(seed, dayIndex, indexInDay, 0x51ed270b), null);
  for (let step = 1; step <= indexInDay; step++) {
    const roll = roll01(seed, dayIndex, step, 0x94d049bb);
    current = transitionIndex(current, weights, roll);
  }
  return current;
}

/** Scratch for the weighted picks, so the schedule allocates nothing. */
const PICK_SCRATCH = new Float64Array(GDO_WEATHER_STATE_IDS.length);

function weightedIndex(weights, roll, _unused) {
  let total = 0;
  for (let index = 0; index < weights.length; index++) total += weights[index];
  if (total <= 0) throw new RangeError('Weather climate weights must have a positive total');
  let threshold = roll * total;
  for (let index = 0; index < weights.length; index++) {
    threshold -= weights[index];
    if (threshold <= 0) return index;
  }
  return weights.length - 1;
}

function transitionIndex(fromIndex, climateWeights, roll) {
  const row = GDO_WEATHER_TRANSITIONS[fromIndex];
  let total = 0;
  for (let index = 0; index < row.length; index++) {
    const score = row[index] * climateWeights[index];
    PICK_SCRATCH[index] = score;
    total += score;
  }
  // A climate with a single reachable state cannot dead-end: fall back to the current state.
  if (total <= 0) return fromIndex;
  let threshold = roll * total;
  for (let index = 0; index < PICK_SCRATCH.length; index++) {
    threshold -= PICK_SCRATCH[index];
    if (threshold <= 0) return index;
  }
  return fromIndex;
}

/**
 * The state at a clock, cross-faded across a window boundary.
 *
 * `out` carries both the blended response fields and the identity of the transition, so a
 * panel or a gate can say *what* the weather is becoming rather than only what it is. The
 * blend is linear in the clock, which is what makes the response continuous even though the
 * state is discrete.
 */
export function sampleWeatherAt(seed, climateId, minutes, out = {}) {
  if (!Number.isFinite(minutes)) throw new RangeError(`Weather clock minutes must be finite, received ${minutes}`);
  const clock = ((minutes % 1440) + 1440) % 1440;
  const windowIndex = Math.floor(minutes / GDO_WEATHER_WINDOW_MINUTES);
  const fromIndex = weatherStateIndexAt(seed, climateId, windowIndex - 1);
  const toIndex = weatherStateIndexAt(seed, climateId, windowIndex);
  const intoWindow = minutes - windowIndex * GDO_WEATHER_WINDOW_MINUTES;
  const fraction = clampUnit(intoWindow / GDO_WEATHER_TRANSITION_MINUTES);
  blendWeather(fromIndex, toIndex, fraction, out);
  out.minutes = clock;
  out.windowIndex = windowIndex;
  out.fraction = fraction;
  out.fromId = GDO_WEATHER_STATE_IDS[fromIndex];
  out.toId = GDO_WEATHER_STATE_IDS[toIndex];
  // While the cross-fade is running the state is named after where it is going: a sky that
  // is 80% of the way to storm is a storm the player is watching arrive.
  out.id = fraction < .5 ? out.fromId : out.toId;
  out.label = GDO_WEATHER_STATES[out.id].label;
  out.minutesIntoWindow = intoWindow;
  out.minutesUntilChange = GDO_WEATHER_WINDOW_MINUTES - intoWindow;
  out.nextIndex = weatherStateIndexAt(seed, climateId, windowIndex + 1);
  out.nextId = GDO_WEATHER_STATE_IDS[out.nextIndex];
  return out;
}

/**
 * Blend two states' response fields into `out`.
 *
 * Field-by-field and allocation-free: the fields are declared once in
 * `GDO_WEATHER_FIELDS`, so two states can be mixed without a special case per field, and a
 * new response field is added in exactly one place.
 */
export function blendWeather(fromIndex, toIndex, fraction, out = {}) {
  const from = GDO_WEATHER_STATES[GDO_WEATHER_STATE_IDS[fromIndex]];
  const to = GDO_WEATHER_STATES[GDO_WEATHER_STATE_IDS[toIndex]];
  if (!from || !to) throw new RangeError(`Unknown weather state index: ${fromIndex} → ${toIndex}`);
  const amount = clampUnit(fraction);
  // The endpoints are copied rather than interpolated: `a + (b − a) × 1` is not `b` in binary
  // floating point, and the difference is visible in a gate that asserts a settled window
  // *is* its table state. A settled window is the state itself, not a blend that rounds to it.
  if (amount <= 0) {
    for (const field of GDO_WEATHER_FIELDS) out[field] = from[field];
  } else if (amount >= 1) {
    for (const field of GDO_WEATHER_FIELDS) out[field] = to[field];
  } else {
    for (const field of GDO_WEATHER_FIELDS) out[field] = from[field] + (to[field] - from[field]) * amount;
  }
  return out;
}

/**
 * The ground luminance a time-of-day state keeps under a weather state.
 *
 * Deliberately the same arithmetic `ENV-02` states its own floor in — the hemisphere term
 * weighted by the ambient scale plus the directional term resolved for a horizontal surface
 * — composed with the weather's two scales, so "readable night" cannot be lost by
 * multiplying two things that were each fine on their own. The Node gate asserts that a
 * `clear` weather reproduces the time-of-day state's own `groundLuminance` exactly.
 */
export function composedGroundLuminance(timeOfDayState, weatherState) {
  // Deliberately *bit-identical* to `TimeOfDay`'s own arithmetic at the `0.22`-radian angular
  // convention, including the same `max` on the elevation, so a `clear` weather composes to
  // the time-of-day state's own `groundLuminance` exactly rather than to within rounding —
  // which is what lets the test use `===` and call `clear` an identity.
  const elevationRadians = timeOfDayState.sunElevation * DEGREES;
  const angular = Math.sin(timeOfDayState.sunElevation > 0 ? elevationRadians : Math.max(elevationRadians, 0.22));
  const hemi = relativeLuminance(timeOfDayState.hemisphereSky) * timeOfDayState.hemisphereIntensity *
    weatherState.hemisphereScale * .5;
  const direct = relativeLuminance(timeOfDayState.lightColor) * timeOfDayState.lightIntensity *
    weatherState.lightScale * Math.max(0, angular);
  return hemi + direct;
}

function relativeLuminance(color) {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

/** The response a state produces, without the time-of-day half. */
const RESPONSE_FIELDS = Object.freeze(GDO_WEATHER_FIELDS.filter(field => field !== 'particleIntensity'));

/**
 * Weather for one world: a seed, a climate and a clock.
 *
 * The clock is the *world* clock — the same minutes `TimeOfDay` advances — so weather and
 * light cannot disagree about what time it is. Nothing here integrates: `setClock()` moves
 * the clock, `sample()` computes the state, and `update()` is only the rate limiter and the
 * change detector, mirroring `TimeOfDay`'s shape so one runtime can drive both.
 */
export class WeatherState {
  /**
   * @param {object} [options]
   * @param {'low'|'balanced'|'high'} [options.profile] uniform-write ceiling and effects
   * @param {number} [options.seed] the coordinate weather seed
   * @param {string} [options.climate] a `GDO_WEATHER_CLIMATES` id
   * @param {number} [options.minutes] world clock minutes
   */
  constructor({ profile = 'low', seed = 0, climate = null, minutes = 0, day = 0 } = {}) {
    if (!Object.hasOwn(GDO_WEATHER_PROFILES, profile)) {
      throw new RangeError(`Unknown weather profile: ${profile}`);
    }
    if (!Number.isFinite(seed)) throw new RangeError(`Weather seed must be finite, received ${seed}`);
    if (!Number.isFinite(minutes)) throw new RangeError(`Weather clock must be finite, received ${minutes}`);
    if (!Number.isFinite(day) || day < 0) throw new RangeError(`Weather day must be a finite day count, received ${day}`);
    const resolvedClimate = climate ?? 'semi-arid';
    if (!Object.hasOwn(GDO_WEATHER_CLIMATES, resolvedClimate)) {
      throw new RangeError(`Unknown weather climate: ${JSON.stringify(resolvedClimate)}`);
    }
    this.profile = profile;
    this.seed = seed >>> 0;
    this.climate = resolvedClimate;
    this.intervalMilliseconds = 1000 / GDO_WEATHER_PROFILES[profile].uniformHz;
    this.state = Object.create(null);
    this.applied = Object.create(null);
    this.hasApplied = false;
    this.day = Math.floor(day);
    this.minutes = ((minutes % 1440) + 1440) % 1440;
    // The schedule's own clock: days of 1440 minutes, unwrapped. Resolving the window from an
    // unwrapped clock is what keeps the *chain* continuous — the day boundary is a window
    // boundary like any other, and a state fades into the next day's anchor exactly as it fades
    // into the next window's.
    this.absoluteMinutes = this.day * GDO_WEATHER_WINDOW_MINUTES * GDO_WEATHER_WINDOWS_PER_DAY + this.minutes;
    this.lastWriteAt = -Infinity;
    this.writes = 0;
    this.writesThisSecond = 0;
    this.secondWindowStart = 0;
    this.unchangedSkips = 0;
    this.coalesced = 0;
    this.appliedStateCount = 0;
    this.transitions = 0;
    this.lastWindowIndex = null;
    this.sample();
  }

  /**
   * Set the clock, and optionally the day it sits in.
   *
   * The clock itself is a time of day: it wraps at midnight, and wrapping it *here* would
   * re-enter the same day's schedule, which is a jump rather than a progression. So the day is
   * an explicit input rather than something this method infers from a backwards clock — the
   * caller owns the calendar (in both runtimes it is `TimeOfDay.dayOfYear`), and a gate that
   * wants to walk into the next day's schedule calls `setDay()` or passes it here.
   */
  setClock(minutes, day = this.day) {
    if (!Number.isFinite(minutes)) throw new RangeError(`Weather clock must be finite, received ${minutes}`);
    if (!Number.isFinite(day) || day < 0) throw new RangeError(`Weather day must be a finite day count, received ${day}`);
    this.day = Math.floor(day);
    this.minutes = ((minutes % 1440) + 1440) % 1440;
    this.absoluteMinutes = this.day * GDO_WEATHER_WINDOW_MINUTES * GDO_WEATHER_WINDOWS_PER_DAY + this.minutes;
    return this.minutes;
  }

  /** Move the schedule to another day of the year, keeping the time of day. */
  setDay(day) {
    if (!Number.isFinite(day) || day < 0) throw new RangeError(`Weather day must be a finite day count, received ${day}`);
    this.setClock(this.minutes, day);
    this.hasApplied = false;
    this.sample();
    return this.day;
  }

  /**
   * Re-seed or re-climate this world.
   *
   * A world only changes climate by moving a long way, and the runtime never does it — but
   * `latitude` up to 90° is reachable by walking, and a gate has to be able to stand in a
   * cold climate to see snow without waiting for a season. Both setters re-sample at once so
   * the next `update()` cannot report the previous world's sky.
   */
  setSeed(seed) {
    if (!Number.isFinite(seed)) throw new RangeError(`Weather seed must be finite, received ${seed}`);
    this.seed = seed >>> 0;
    this.hasApplied = false;
    this.sample();
    return this.seed;
  }

  setClimate(climate) {
    if (!Object.hasOwn(GDO_WEATHER_CLIMATES, climate)) {
      throw new RangeError(`Unknown weather climate: ${JSON.stringify(climate)}`);
    }
    this.climate = climate;
    this.hasApplied = false;
    this.sample();
    return this.climate;
  }

  /** Compute the current state into `out` (default: the instance's own state). */
  sample(out = this.state) {
    const before = this.lastWindowIndex;
    sampleWeatherAt(this.seed, this.climate, this.absoluteMinutes, out);
    this.lastWindowIndex = out.windowIndex;
    if (before !== null && out.windowIndex !== before) this.transitions++;
    return out;
  }

  /** Has the state moved enough since the last apply to be worth a write? */
  changed() {
    if (!this.hasApplied) return true;
    const a = this.state, b = this.applied;
    if (a.id !== b.id || a.nextId !== b.nextId) return true;
    if (Math.abs(a.fraction - b.fraction) > EPSILON) return true;
    for (const field of GDO_WEATHER_FIELDS) {
      if (Math.abs(a[field] - b[field]) > EPSILON) return true;
    }
    return false;
  }

  /**
   * Decide whether this frame earns a uniform write.
   *
   * The same two ceilings `ENV-02` established, for the same reason: **on change** and
   * **≤ profile Hz**. A frozen clock writes nothing at all, and a clock that jumps an hour in
   * one frame spends one write rather than replaying the windows it skipped — which is also
   * why a capture can set the clock without corrupting the budget.
   */
  update(nowMilliseconds = null) {
    this.sample();
    const now = Number.isFinite(nowMilliseconds) ? nowMilliseconds
      : (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
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

  /** Re-anchor the rate limiter to a caller's own timeline (see `TimeOfDay.rebaseClock`). */
  rebaseClock(nowMilliseconds = 0) {
    if (!Number.isFinite(nowMilliseconds)) throw new RangeError(`Weather rebase must be finite, received ${nowMilliseconds}`);
    this.lastWriteAt = nowMilliseconds - this.intervalMilliseconds;
    this.secondWindowStart = nowMilliseconds;
    this.writesThisSecond = 0;
    return this.lastWriteAt;
  }

  /** Record that the caller applied the state, so change detection has a baseline. */
  markApplied() {
    const source = this.state, target = this.applied;
    for (const field of GDO_WEATHER_FIELDS) target[field] = source[field];
    target.id = source.id;
    target.label = source.label;
    target.fraction = source.fraction;
    target.nextId = source.nextId;
    target.minutes = source.minutes;
    target.windowIndex = source.windowIndex;
    this.hasApplied = true;
    this.appliedStateCount++;
    return target;
  }

  /** How many particle families and particles this profile may run (`ENV-05`'s budget). */
  get particleBudget() {
    return GDO_WEATHER_PROFILES[this.profile];
  }

  /**
   * How much of a species' ambience this weather leaves active.
   *
   * The scheduler's own `speciesActivity` channel, so a sheltered family stays sheltered
   * without the phase budget having to know about weather — `AGENTS.md` item 6's rule that a
   * state change is a change of budget rather than a second animation path.
   */
  speciesActivity() {
    return { bird: this.state.birdActivity, bee: this.state.beeActivity };
  }

  diagnostics() {
    const state = this.state;
    return {
      profile: this.profile,
      uniformHz: GDO_WEATHER_PROFILES[this.profile].uniformHz,
      particleFamilies: GDO_WEATHER_PROFILES[this.profile].particleFamilies,
      particleCap: GDO_WEATHER_PROFILES[this.profile].particleCap,
      seed: this.seed,
      climate: this.climate,
      climateLabel: GDO_WEATHER_CLIMATES[this.climate].label,
      weather: state.id,
      label: state.label,
      from: state.fromId,
      to: state.toId,
      blend: state.fraction,
      next: state.nextId,
      minutes: state.minutes,
      day: this.day,
      absoluteMinutes: this.absoluteMinutes,
      window: state.windowIndex,
      minutesIntoWindow: state.minutesIntoWindow,
      minutesUntilChange: state.minutesUntilChange,
      cloudCover: state.cloudCover,
      cloudDarkness: state.cloudDarkness,
      wetness: state.wetness,
      ripple: state.ripple,
      cloudSpeed: state.cloudSpeed,
      lightScale: state.lightScale,
      hemisphereScale: state.hemisphereScale,
      exposureBias: state.exposureBias,
      fogDensity: state.fogDensity,
      birdActivity: state.birdActivity,
      beeActivity: state.beeActivity,
      particleIntensity: state.particleIntensity,
      writes: this.writes,
      writesThisSecond: this.writesThisSecond,
      unchangedSkips: this.unchangedSkips,
      coalesced: this.coalesced,
      appliedStateCount: this.appliedStateCount,
      transitions: this.transitions,
    };
  }

  reset() {
    this.writes = 0;
    this.writesThisSecond = 0;
    this.secondWindowStart = 0;
    this.unchangedSkips = 0;
    this.coalesced = 0;
    this.appliedStateCount = 0;
    this.transitions = 0;
    this.lastWindowIndex = null;
    this.lastWriteAt = -Infinity;
    this.hasApplied = false;
    this.sample();
    return this.diagnostics();
  }
}

/**
 * Bind the sky's weather uniforms to a state, once.
 *
 * The same property `ENV-02` established for the time-of-day uniforms: the uniforms hold the
 * *state's* objects, so applying a state writes the state and nothing else. `uCloudDarkness`
 * and `uSkyTime` are additive to the dome shader and are exactly the identity at zero, so the
 * clear-weather frame is arithmetically the pre-`ENV-04` frame.
 */
export function bindWeatherUniforms(sky, state = null) {
  const uniforms = sky?.material?.uniforms;
  if (!uniforms) throw new TypeError('bindWeatherUniforms requires a sky handle with material uniforms');
  if (uniforms.uCloudDarkness) uniforms.uCloudDarkness.value = state?.cloudDarkness ?? 0;
  if (uniforms.uSkyTime) uniforms.uSkyTime.value = 0;
  return uniforms;
}

/**
 * Scratch colours for `applyWeather`, so the apply path allocates nothing.
 *
 * The weather's fog is a **tint**, not a colour: a warm dusty tone is `(1.12, 1.00, 0.86)`
 * and a cool wet one `(0.88, 0.95, 1.10)`, each scaled by `fogLightness`, multiplied into
 * whatever the time-of-day state's fog colour already is. The first version of this wrote an
 * absolute grey — and at night that would have made dust *brighter* than the sky it was
 * meant to be obscuring, which is exactly the kind of composition error this module's tests
 * exist to catch. Multiplying keeps a night dark and only changes its hue.
 */
const WEATHER_TINT = { r: 1, g: 1, b: 1 };
const WEATHER_SUN = { r: 0, g: 0, b: 0 };
const NEUTRAL_TINT = Object.freeze([1, 1, 1]);
const WARM_TINT = Object.freeze([1.12, 1.0, .86]);
const COOL_TINT = Object.freeze([.88, .95, 1.10]);

/**
 * Apply a weather state to a runtime's environment.
 *
 * Takes the *time-of-day state as well*, and writes absolute values rather than multiplying
 * whatever is there: a multiplicative apply that runs on every phase change would compound
 * its own previous result, so the composition is `time-of-day value × weather scale` computed
 * from the source each time. That also makes the clear case exactly the identity.
 *
 * `fogNear`/`fogFar` are the runtime's own bases — the two runtimes have different worlds at
 * different scales — and `water` is an optional handle with the two surface responses the
 * research names for wet weather: ripple amplitude and wetness.
 */
export function applyWeather(timeOfDayState, weatherState, {
  sky = null,
  scene = null,
  lightRig = null,
  renderer = null,
  water = null,
  fogNear = null,
  fogFar = null,
  deltaSeconds = 0,
} = {}) {
  if (!timeOfDayState || !weatherState) throw new TypeError('applyWeather requires a time-of-day state and a weather state');
  const uniforms = sky?.material?.uniforms;
  if (uniforms?.uCloudCover) {
    // Coverage is the time-of-day cover plus the weather's, because a clear day at 0.38 and
    // an overcast one at 0.73 should differ, and the time-of-day value is the baseline the
    // shipped shader rendered.
    uniforms.uCloudCover.value = clampUnit(timeOfDayState.cloudCover + weatherState.cloudCover);
  }
  if (uniforms?.uCloudDarkness) uniforms.uCloudDarkness.value = clampUnit(weatherState.cloudDarkness);
  if (uniforms?.uSkyTime && deltaSeconds > 0) {
    // Sky drift, bounded and slow, and *not* the vegetation wind the owner rejected: this
    // moves three hash cells in a fragment shader, it does not deform geometry.
    uniforms.uSkyTime.value = (uniforms.uSkyTime.value + deltaSeconds * weatherState.cloudSpeed * .01) % 4096;
  }
  if (scene?.fog) {
    if (Number.isFinite(fogNear) && Number.isFinite(fogFar)) {
      scene.fog.near = Math.max(1, fogNear * (1 - .55 * weatherState.fogDensity));
      scene.fog.far = Math.max(scene.fog.near + 8, fogFar * (1 - .62 * weatherState.fogDensity));
    }
    if (scene.fog.color?.copy) {
      // Fog is always the time-of-day fog colour, tinted by the weather: warm and lighter for
      // dust, cool and darker for rain and storm, barely touched by haze. Three blended
      // scalars rather than an eighth colour table, and a *tint* rather than a replacement so
      // the weather cannot light a night up.
      const warmth = weatherState.fogWarmth;
      const target = warmth >= 0 ? WARM_TINT : COOL_TINT;
      const amount = Math.abs(warmth);
      const lightness = weatherState.fogLightness;
      const tint = clampUnit(weatherState.fogTint);
      WEATHER_TINT.r = 1 + ((NEUTRAL_TINT[0] + (target[0] - NEUTRAL_TINT[0]) * amount) * lightness - 1) * tint;
      WEATHER_TINT.g = 1 + ((NEUTRAL_TINT[1] + (target[1] - NEUTRAL_TINT[1]) * amount) * lightness - 1) * tint;
      WEATHER_TINT.b = 1 + ((NEUTRAL_TINT[2] + (target[2] - NEUTRAL_TINT[2]) * amount) * lightness - 1) * tint;
      scene.fog.color.setRGB(
        timeOfDayState.fogColor.r * WEATHER_TINT.r,
        timeOfDayState.fogColor.g * WEATHER_TINT.g,
        timeOfDayState.fogColor.b * WEATHER_TINT.b,
      );
    }
  }
  if (lightRig) {
    if (lightRig.sun) {
      lightRig.sun.intensity = timeOfDayState.lightIntensity * weatherState.lightScale;
      // Overcast and storm cool the light as they dim it; a clear sky does not touch it.
      if (lightRig.sun.color?.copy && weatherState.cloudDarkness > 0) {
        WEATHER_SUN.r = .74; WEATHER_SUN.g = .78; WEATHER_SUN.b = .86;
        lightRig.sun.color.copy(timeOfDayState.lightColor).lerp(WEATHER_SUN, Math.min(.45, weatherState.cloudDarkness * .55));
      }
    }
    if (lightRig.fill) lightRig.fill.intensity = timeOfDayState.hemisphereIntensity * weatherState.hemisphereScale;
  }
  if (renderer && Number.isFinite(timeOfDayState.exposure)) {
    renderer.toneMappingExposure = clamp(timeOfDayState.exposure + weatherState.exposureBias, .2, 3);
  }
  if (water) applyWeatherToWater(water, weatherState);
  return weatherState;
}

/**
 * The surface response, on whatever the runtime's water is.
 *
 * Two shapes are supported because the two runtimes build water differently — the coordinate
 * world a `ShaderMaterial` with a `uWeather` uniform, the curated world a
 * `MeshStandardMaterial` with a normal scale — and both are *identity at clear*: the shader
 * multiplies by `1.0 + 0`, the material by its own base scale, so a clear frame is unchanged.
 */
export function applyWeatherToWater(water, weatherState) {
  const uniforms = water.material?.uniforms;
  if (uniforms?.uWeather) {
    uniforms.uWeather.value.x = weatherState.ripple;
    uniforms.uWeather.value.y = weatherState.wetness;
    return true;
  }
  if (water.material?.normalScale?.set) {
    const base = water.userData.geoWaterNormalBase ?? water.material.normalScale.x;
    water.userData.geoWaterNormalBase = base;
    const scale = base * (1 + .6 * weatherState.ripple);
    water.material.normalScale.set(scale, scale);
    if (Number.isFinite(water.material.roughness)) {
      // Captured on the first apply, not read from a field nobody set: a wet surface is
      // *glossier*, and the base is the material's own roughness, so the write is absolute and
      // a repeated apply cannot compound.
      const roughnessBase = water.userData.geoWaterRoughnessBase ?? water.material.roughness;
      water.userData.geoWaterRoughnessBase = roughnessBase;
      water.material.roughness = roughnessBase - .06 * weatherState.wetness;
    }
    return true;
  }
  return false;
}

/**
 * Is the state distinguishable with no particles at all?
 *
 * This is the low-profile fallback stated as a property of the table rather than as a promise
 * about the renderer: two states that differ *only* in `particleIntensity` would look
 * identical on the profile that omits particles, so every pair of states must differ in at
 * least one uniform-driven response field. The Node gate checks all 28 pairs.
 */
export function uniformResponseDistance(a, b) {
  let distance = 0;
  for (const field of RESPONSE_FIELDS) distance = Math.max(distance, Math.abs(a[field] - b[field]));
  return distance;
}

/** The night floor this module promises, exposed so a gate can check the composition. */
export const GDO_WEATHER_MIN_NIGHT_LUMINANCE = NIGHT_FLOOR * GDO_WEATHER_NIGHT_LUMINANCE_RETENTION;
