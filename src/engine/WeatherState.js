/**
 * `ENV-04` — the deterministic weather state machine.
 *
 * The research is specific about what weather may be: a *climate* schedule, not a
 * live service. "Weather is deterministic from macro climate + month + world-time
 * window + coordinate weather seed. It should transition over time rather than
 * roll independently each frame." It names eight states — clear, haze, overcast,
 * rain, storm, dust, snow, mist — and for each one a sky/light response, a surface
 * response, a particle/motion response, and a habitat response, with a hard cap of
 * *one* precipitation family at a time and a 1–3 s uniform transition band.
 *
 * This module is that machine, as pure data and maths: no `three`, no DOM, no
 * timers, no network. The world hands it the climate sample it already has (the
 * `VEG-08` environment summary plus the `TER-07` water query) and a world clock;
 * it hands back a response the world applies to the sky, the lights, the fog, the
 * exposure, the plant wind field, and the ambient-life habitat — and it reports
 * what the active profile could not afford instead of quietly dropping it.
 */

import { featureNamespace } from './FeatureVersions.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import { GDO_NIGHT_READABILITY_FLOORS, GDO_TIME_OF_DAY_DEFAULTS } from './TimeOfDaySky.js';

export const GDO_WEATHER_NAMESPACE = featureNamespace('weatherState');

/** The precipitation families a state may declare. At most one is ever active. */
export const GDO_WEATHER_PRECIPITATION = Object.freeze({
  RAIN: 'rain',
  SNOW: 'snow',
  DUST: 'dust',
});

const NONE = null;

/**
 * The eight research states. Each declares the complete response the row is
 * judged on: sky/light scales against the `ENV-02` palette, a fog tint and range
 * scales, the surface response `ENV-05` consumes (wetness/dust/snow/damp), the
 * wind the shared `VEG-06` field receives, at most one precipitation family, the
 * habitat response the `LIF-02` scheduler receives, and the climate band the state
 * is *admissible* in. A state outside its band is refused with a reason, which is
 * how a hot desert never snows and a humid coast never dusts.
 */
export const GDO_WEATHER_STATES = Object.freeze([
  Object.freeze({
    id: 'clear', label: 'Clear', precipitation: NONE,
    cloudiness: .12, cloudTint: Object.freeze([1, 1, 1]),
    sunScale: 1.06, fillScale: .94, exposureScale: 1,
    fogTint: Object.freeze([1, 1, 1]), fogNearScale: 1, fogFarScale: 1,
    wind: Object.freeze({ strength: .42, gustiness: .18 }),
    surface: Object.freeze({ wetness: 0, dust: .04, snow: 0, damp: 0 }),
    habitat: Object.freeze({ flyers: 1, insects: 1 }),
    requires: Object.freeze({}),
  }),
  Object.freeze({
    id: 'haze', label: 'Haze', precipitation: NONE,
    cloudiness: .30, cloudTint: Object.freeze([1, .99, .96]),
    sunScale: .82, fillScale: 1, exposureScale: .98,
    fogTint: Object.freeze([1.08, 1, .88]), fogNearScale: .55, fogFarScale: .62,
    wind: Object.freeze({ strength: .30, gustiness: .12 }),
    surface: Object.freeze({ wetness: 0, dust: .30, snow: 0, damp: 0 }),
    habitat: Object.freeze({ flyers: .55, insects: .8 }),
    requires: Object.freeze({ aridityMin: .26 }),
  }),
  Object.freeze({
    id: 'overcast', label: 'Overcast', precipitation: NONE,
    cloudiness: .80, cloudTint: Object.freeze([.94, .96, .99]),
    sunScale: .52, fillScale: 1.06, exposureScale: .96,
    fogTint: Object.freeze([.93, .95, .98]), fogNearScale: .80, fogFarScale: .86,
    wind: Object.freeze({ strength: .50, gustiness: .24 }),
    surface: Object.freeze({ wetness: .12, dust: 0, snow: 0, damp: .35 }),
    habitat: Object.freeze({ flyers: .72, insects: .5 }),
    requires: Object.freeze({ moistureMin: .28 }),
  }),
  Object.freeze({
    id: 'rain', label: 'Rain', precipitation: GDO_WEATHER_PRECIPITATION.RAIN,
    cloudiness: .92, cloudTint: Object.freeze([.84, .87, .92]),
    sunScale: .30, fillScale: 1.02, exposureScale: .90,
    fogTint: Object.freeze([.84, .88, .93]), fogNearScale: .60, fogFarScale: .70,
    wind: Object.freeze({ strength: .60, gustiness: .30 }),
    surface: Object.freeze({ wetness: .85, dust: 0, snow: 0, damp: .60 }),
    habitat: Object.freeze({ flyers: .25, insects: .35 }),
    requires: Object.freeze({ moistureMin: .44 }),
  }),
  Object.freeze({
    id: 'storm', label: 'Storm', precipitation: GDO_WEATHER_PRECIPITATION.RAIN,
    cloudiness: 1, cloudTint: Object.freeze([.72, .76, .84]),
    sunScale: .16, fillScale: .90, exposureScale: .84,
    fogTint: Object.freeze([.70, .74, .82]), fogNearScale: .45, fogFarScale: .58,
    wind: Object.freeze({ strength: .92, gustiness: .85 }),
    surface: Object.freeze({ wetness: 1, dust: 0, snow: 0, damp: .80 }),
    habitat: Object.freeze({ flyers: .05, insects: .02 }),
    requires: Object.freeze({ moistureMin: .60, temperatureMin: .32 }),
  }),
  Object.freeze({
    id: 'dust', label: 'Dust', precipitation: GDO_WEATHER_PRECIPITATION.DUST,
    cloudiness: .34, cloudTint: Object.freeze([1.06, .95, .78]),
    sunScale: .58, fillScale: 1, exposureScale: .92,
    fogTint: Object.freeze([1.14, .95, .72]), fogNearScale: .40, fogFarScale: .50,
    wind: Object.freeze({ strength: .78, gustiness: .70 }),
    surface: Object.freeze({ wetness: 0, dust: .95, snow: 0, damp: 0 }),
    habitat: Object.freeze({ flyers: .30, insects: .05 }),
    requires: Object.freeze({ aridityMin: .48 }),
  }),
  Object.freeze({
    id: 'snow', label: 'Snow', precipitation: GDO_WEATHER_PRECIPITATION.SNOW,
    cloudiness: .86, cloudTint: Object.freeze([.96, .98, 1]),
    sunScale: .34, fillScale: 1.08, exposureScale: .96,
    fogTint: Object.freeze([.95, .97, 1.02]), fogNearScale: .68, fogFarScale: .78,
    wind: Object.freeze({ strength: .48, gustiness: .20 }),
    surface: Object.freeze({ wetness: .20, dust: 0, snow: .90, damp: .30 }),
    habitat: Object.freeze({ flyers: .20, insects: .05 }),
    requires: Object.freeze({ temperatureMax: .46 }),
  }),
  Object.freeze({
    id: 'mist', label: 'Mist', precipitation: NONE,
    cloudiness: .56, cloudTint: Object.freeze([.92, .95, .96]),
    sunScale: .48, fillScale: 1.04, exposureScale: .95,
    fogTint: Object.freeze([.90, .95, .96]), fogNearScale: .22, fogFarScale: .38,
    wind: Object.freeze({ strength: .18, gustiness: .06 }),
    surface: Object.freeze({ wetness: .30, dust: 0, snow: 0, damp: .70 }),
    habitat: Object.freeze({ flyers: .50, insects: .55 }),
    requires: Object.freeze({ moistureMin: .50 }),
  }),
]);

export const GDO_WEATHER_STATE_IDS = Object.freeze(GDO_WEATHER_STATES.map(state => state.id));

/** Why a candidate state could not be used. A refusal is data, never a guess. */
export const GDO_WEATHER_REFUSAL = Object.freeze({
  CLIMATE: 'climate-out-of-band',
});

/**
 * Relative likelihood of each successor, keyed by the previous state. The table
 * is art direction, not meteorology: it exists so a wet spell stays wet for a
 * while and a clear run does not become a blizzard in one step.
 */
export const GDO_WEATHER_TRANSITIONS = Object.freeze({
  clear: Object.freeze({ clear: 1, haze: 1.1, overcast: 1.5, rain: .45, storm: .08, dust: .5, snow: .2, mist: .3 }),
  haze: Object.freeze({ clear: 1.5, haze: 1, overcast: 1.2, rain: .35, storm: .05, dust: 1, snow: .15, mist: .55 }),
  overcast: Object.freeze({ clear: 1, haze: .6, overcast: 1, rain: 1.4, storm: .4, dust: .12, snow: .55, mist: .8 }),
  rain: Object.freeze({ clear: .55, haze: .2, overcast: 1.4, rain: 1, storm: .9, dust: .02, snow: .3, mist: .6 }),
  storm: Object.freeze({ clear: .45, haze: .1, overcast: 1.2, rain: 1.3, storm: 1, dust: .02, snow: .15, mist: .35 }),
  dust: Object.freeze({ clear: 1, haze: 1.2, overcast: .3, rain: .05, storm: .02, dust: 1, snow: 0, mist: .1 }),
  snow: Object.freeze({ clear: .7, haze: .2, overcast: 1.2, rain: .25, storm: .06, dust: 0, snow: 1, mist: .5 }),
  mist: Object.freeze({ clear: 1.1, haze: .8, overcast: .9, rain: .4, storm: .05, dust: .05, snow: .25, mist: 1 }),
});

/**
 * Seasonal weighting by the *local* season (the machine flips it below the
 * equator), so the same seed at the same coordinate behaves differently in
 * January and July.
 */
export const GDO_WEATHER_SEASONS = Object.freeze({
  winter: Object.freeze({ clear: .80, haze: .70, overcast: 1.20, rain: .90, storm: .70, dust: .40, snow: 1.60, mist: 1.20 }),
  spring: Object.freeze({ clear: 1.05, haze: .90, overcast: 1.05, rain: 1.10, storm: .90, dust: .90, snow: .70, mist: 1.00 }),
  summer: Object.freeze({ clear: 1.25, haze: 1.30, overcast: .85, rain: .90, storm: 1.00, dust: 1.50, snow: .10, mist: .60 }),
  autumn: Object.freeze({ clear: 1.00, haze: 1.10, overcast: 1.15, rain: 1.20, storm: .90, dust: 1.00, snow: .50, mist: 1.30 }),
});

/** A low-latitude summer is a monsoon window, not a dry-season window. */
export const GDO_WEATHER_MONSOON = Object.freeze({
  latitudeBelow: 25,
  weights: Object.freeze({ rain: 1.70, storm: 1.60, overcast: 1.20, dust: .25, haze: .60, clear: .70 }),
});

/** Per-profile ceilings and per-profile response opt-outs. */
export const GDO_WEATHER_PROFILES = Object.freeze({
  low: Object.freeze({
    maxUpdatesHz: 10,
    maxWritesPerUpdate: 12,
    runHours: 3,
    blendSeconds: 3,
    cloudCoverage: false,
    cloudTint: false,
    habitatResponse: true,
    windResponse: true,
    precipitationParticles: false,
    steadyFrameAllocations: 0,
  }),
  balanced: Object.freeze({
    maxUpdatesHz: 15,
    maxWritesPerUpdate: 18,
    runHours: 2,
    blendSeconds: 3,
    cloudCoverage: true,
    cloudTint: true,
    habitatResponse: true,
    windResponse: true,
    precipitationParticles: true,
    steadyFrameAllocations: 0,
  }),
  high: Object.freeze({
    maxUpdatesHz: 20,
    maxWritesPerUpdate: 22,
    runHours: 2,
    blendSeconds: 2,
    cloudCoverage: true,
    cloudTint: true,
    habitatResponse: true,
    windResponse: true,
    precipitationParticles: true,
    steadyFrameAllocations: 0,
  }),
});

/** The neutral climate a world uses before its first environment summary lands. */
export const GDO_WEATHER_CLIMATE_FALLBACK = Object.freeze({
  source: 'latitude-fallback-v1',
  temperature: .55, moisture: .45, seasonality: .4, lowness: .5,
  riparian: 0, canopy: 0, human: 0, urban: 0, wetland: false, inWater: false,
  waterDistance: Infinity, aridity: .38,
});

/** How long the climate sample takes to walk to a new source tile's numbers. */
export const GDO_WEATHER_CLIMATE_BLEND_MILLISECONDS = 1_500;

/**
 * How many consecutive runs chain from one seed-derived anchor. The chain is
 * what makes weather persist — a wet spell stays wet — and the anchor is what
 * keeps it *pure*: run `r` always resolves from the same starting state and the
 * same bounded number of transitions, no matter what clock the caller asks for
 * first, so a jump to next week and a walk to next week agree exactly.
 */
export const GDO_WEATHER_CHAIN_RUNS = 4;

const NUMERIC_CLIMATE_FIELDS = Object.freeze([
  'temperature', 'moisture', 'seasonality', 'lowness', 'riparian', 'canopy', 'human', 'urban', 'aridity',
]);

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function mix(first, second, amount) {
  return first + (second - first) * amount;
}

function hash(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

function rounded(value, places = 4) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** The local season for a month and hemisphere: the flip is one sign test. */
export function weatherSeasonFor({ month = 7, latitude = 0 } = {}) {
  if (!Number.isFinite(month) || month < 1 || month > 12) throw new RangeError('Weather months run 1..12');
  if (!Number.isFinite(latitude)) throw new RangeError('Weather needs a finite latitude');
  const local = latitude >= 0 ? month : ((month + 5) % 12) + 1;
  if (local === 12 || local <= 2) return 'winter';
  if (local <= 5) return 'spring';
  if (local <= 8) return 'summer';
  return 'autumn';
}

/**
 * The coordinate weather seed: version plus the degree-celled coordinate, so the
 * same place always seeds the same weather and a neighbouring tile does not.
 * Month and world time are separate inputs, which is what lets the same seed be
 * winter one month and monsoon the next.
 */
export function weatherSeedFor({ worldVersion = 1, latitude = 0, longitude = 0 } = {}) {
  if (![latitude, longitude].every(Number.isFinite)) {
    throw new TypeError('A weather seed needs finite coordinates');
  }
  const cell = `${Math.round(latitude * 100)},${Math.round(longitude * 100)}`;
  return `${worldVersion}:${cell}:${hash(`${GDO_WEATHER_NAMESPACE}|${cell}`).toString(16)}`;
}

/** One reused climate record, so a steady frame samples without allocating. */
export function createWeatherClimate(out = {}) {
  out.namespace = GDO_WEATHER_NAMESPACE;
  out.source = GDO_WEATHER_CLIMATE_FALLBACK.source;
  out.temperature = GDO_WEATHER_CLIMATE_FALLBACK.temperature;
  out.moisture = GDO_WEATHER_CLIMATE_FALLBACK.moisture;
  out.seasonality = GDO_WEATHER_CLIMATE_FALLBACK.seasonality;
  out.lowness = GDO_WEATHER_CLIMATE_FALLBACK.lowness;
  out.riparian = 0;
  out.canopy = 0;
  out.human = 0;
  out.urban = 0;
  out.wetland = false;
  out.inWater = false;
  out.waterDistance = Infinity;
  out.aridity = GDO_WEATHER_CLIMATE_FALLBACK.aridity;
  out.quantized = '';
  return out;
}

/**
 * Fold the fields the world already has into one climate sample. Nothing is
 * invented: the `VEG-08` summary supplies temperature, moisture, seasonality,
 * riparian, canopy, urban and its normalized ground height, and the `TER-07`
 * query supplies water presence — so the only derived numbers are aridity (the
 * same art-direction shape `VEG-08` uses) and the altitude cooling below.
 */
export function sampleWeatherClimate({
  temperature, moisture, seasonality, lowness, riparian, canopy, human, urban,
  wetland = false, inWater = false, waterDistance = Infinity,
  latitude = 0, source = 'environment-summary-v1',
} = {}, out = {}) {
  const climate = out.namespace === GDO_WEATHER_NAMESPACE ? out : createWeatherClimate(out);
  const fallbackTemperature = clamp(1 - Math.abs(latitude) / 76);
  const thermal = Number.isFinite(temperature) ? clamp(temperature) : fallbackTemperature;
  let wet = Number.isFinite(moisture) ? clamp(moisture) : GDO_WEATHER_CLIMATE_FALLBACK.moisture;
  // Mapped water is a real modifier, not a new geography: standing water nearby,
  // a wetland, or a mapped bank raise the moisture the machine sees, exactly as
  // `VEG-08` already does for plants.
  if (wetland) wet = clamp(wet + .24);
  else if (inWater) wet = clamp(wet + .30);
  else if (Number.isFinite(waterDistance) && waterDistance <= 2.4) wet = clamp(wet + .16);
  const ground = Number.isFinite(lowness) ? clamp(lowness) : GDO_WEATHER_CLIMATE_FALLBACK.lowness;
  climate.source = source;
  // `VEG-08`'s normalized `elevation` is 0 at the terrain maximum, so high ground
  // is the *low* value: the weather sample cools with it, which is what makes
  // snow admissible in the hills at a latitude that cannot snow on the plain.
  climate.temperature = clamp(thermal - (1 - ground) * .16);
  climate.moisture = wet;
  climate.seasonality = Number.isFinite(seasonality) ? clamp(seasonality) : GDO_WEATHER_CLIMATE_FALLBACK.seasonality;
  climate.lowness = ground;
  climate.riparian = Number.isFinite(riparian) ? clamp(riparian) : 0;
  climate.canopy = Number.isFinite(canopy) ? clamp(canopy) : 0;
  climate.human = Number.isFinite(human) ? clamp(human) : 0;
  climate.urban = Number.isFinite(urban) ? clamp(urban) : 0;
  climate.wetland = Boolean(wetland);
  climate.inWater = Boolean(inWater);
  climate.waterDistance = Number.isFinite(waterDistance) ? waterDistance : Infinity;
  climate.aridity = clamp((1 - wet) * .62 + Math.max(0, climate.temperature - .58) * .38);
  climate.quantized = `${Math.round(climate.temperature * 8)}:${Math.round(wet * 8)}:${Math.round(climate.aridity * 8)}`;
  return climate;
}

/** Does a state's declared climate band admit this sample? */
export function weatherAdmits(state, climate) {
  const requires = state.requires ?? {};
  if (requires.temperatureMin != null && climate.temperature < requires.temperatureMin) return false;
  if (requires.temperatureMax != null && climate.temperature > requires.temperatureMax) return false;
  if (requires.moistureMin != null && climate.moisture < requires.moistureMin) return false;
  if (requires.moistureMax != null && climate.moisture > requires.moistureMax) return false;
  if (requires.aridityMin != null && climate.aridity < requires.aridityMin) return false;
  if (requires.aridityMax != null && climate.aridity > requires.aridityMax) return false;
  return true;
}

function seasonalWeight(stateId, season, latitude) {
  const table = GDO_WEATHER_SEASONS[season] ?? GDO_WEATHER_SEASONS.spring;
  let weight = table[stateId] ?? 1;
  if (season === 'summer' && Math.abs(latitude) < GDO_WEATHER_MONSOON.latitudeBelow) {
    weight *= GDO_WEATHER_MONSOON.weights[stateId] ?? 1;
  }
  return weight;
}

/**
 * Resolve one run. The previous state weights the transition table, each
 * candidate is weighted again by the season, and the pick is a deterministic
 * exponential race over a hash of `(seed, run, season, state, climate)` — so the
 * choice is a pure function of those five inputs, and a state outside its climate
 * band is refused and counted instead of guessed around.
 */
export function resolveWeatherRun({
  seed = '00000000', run = 0, season = 'spring', latitude = 0,
  climate, previous = null,
} = {}) {
  if (!climate) throw new TypeError('Weather resolution needs a climate sample');
  const base = previous && GDO_WEATHER_TRANSITIONS[previous]
    ? GDO_WEATHER_TRANSITIONS[previous] : GDO_WEATHER_TRANSITIONS.clear;
  const refusals = [];
  let best = null, bestKey = Infinity;
  for (const state of GDO_WEATHER_STATES) {
    const weight = (base[state.id] ?? 0) * seasonalWeight(state.id, season, latitude);
    if (weight <= 0) continue;
    if (!weatherAdmits(state, climate)) {
      refusals.push(Object.freeze({ state: state.id, reason: GDO_WEATHER_REFUSAL.CLIMATE }));
      continue;
    }
    // Uniform in (0, 1), then the exponential race: the smallest key wins with
    // probability proportional to its weight.
    const uniform = (hash(`${seed}|${run}|${season}|${state.id}|${climate.quantized}`) + .5) / 2 ** 32;
    const key = -Math.log(uniform) / weight;
    if (key < bestKey) { bestKey = key; best = state; }
  }
  if (!best) {
    // Every candidate was refused. `clear` is admissible everywhere by
    // declaration, so a starved climate is still deterministic.
    best = GDO_WEATHER_STATES[0];
    return Object.freeze({ state: best, refusals: Object.freeze(refusals), fallbackUsed: true });
  }
  return Object.freeze({ state: best, refusals: Object.freeze(refusals), fallbackUsed: false });
}

/** One reused blended view. Every response channel the world applies lives here. */
export function createWeatherView(out = {}) {
  out.namespace = GDO_WEATHER_NAMESPACE;
  out.id = 'clear';
  out.from = 'clear';
  out.to = 'clear';
  out.blend = 1;
  out.run = 0;
  out.cloudiness = 0;
  out.cloudTint = out.cloudTint ?? [1, 1, 1];
  out.sunScale = 1;
  out.fillScale = 1;
  out.exposureScale = 1;
  out.fogTint = out.fogTint ?? [1, 1, 1];
  out.fogNearScale = 1;
  out.fogFarScale = 1;
  out.wind = out.wind ?? { strength: .5, gustiness: .2 };
  out.surface = out.surface ?? { wetness: 0, dust: 0, snow: 0, damp: 0 };
  out.habitat = out.habitat ?? { flyers: 1, insects: 1 };
  out.precipitation = NONE;
  out.activePrecipitation = NONE;
  return out;
}

/** Blend two states into one view: the ramp that makes a transition continuous. */
export function blendWeatherStates(from, to, amount, out) {
  if (!out) throw new TypeError('Weather blending needs a reusable view');
  const t = clamp(Number.isFinite(amount) ? amount : 1);
  out.id = t >= 1 ? to.id : from.id;
  out.from = from.id;
  out.to = to.id;
  out.blend = rounded(t);
  out.cloudiness = rounded(mix(from.cloudiness, to.cloudiness, t));
  for (let channel = 0; channel < 3; channel++) {
    out.cloudTint[channel] = rounded(mix(from.cloudTint[channel], to.cloudTint[channel], t));
    out.fogTint[channel] = rounded(mix(from.fogTint[channel], to.fogTint[channel], t));
  }
  out.sunScale = rounded(mix(from.sunScale, to.sunScale, t));
  out.fillScale = rounded(mix(from.fillScale, to.fillScale, t));
  out.exposureScale = rounded(mix(from.exposureScale, to.exposureScale, t));
  out.fogNearScale = rounded(mix(from.fogNearScale, to.fogNearScale, t));
  out.fogFarScale = rounded(mix(from.fogFarScale, to.fogFarScale, t));
  out.wind.strength = rounded(mix(from.wind.strength, to.wind.strength, t));
  out.wind.gustiness = rounded(mix(from.wind.gustiness, to.wind.gustiness, t));
  for (const key of ['wetness', 'dust', 'snow', 'damp']) {
    out.surface[key] = rounded(mix(from.surface[key], to.surface[key], t));
  }
  out.habitat.flyers = rounded(mix(from.habitat.flyers, to.habitat.flyers, t));
  out.habitat.insects = rounded(mix(from.habitat.insects, to.habitat.insects, t));
  out.precipitation = to.precipitation;
  // The research caps precipitation at one family per frame, and a blend is
  // exactly where two families could otherwise overlap: the heavier state's
  // family wins the blend, so the cap holds by construction.
  out.activePrecipitation = t >= .5 ? to.precipitation : from.precipitation;
  return out;
}

/**
 * Apply the weather to a copy of the `ENV-02` sky state. The day cycle stays the
 * only authority for the palette; weather scales it, tints the fog, and never
 * pushes the result under the declared night readability floors — a state that
 * would is clamped and reported instead.
 */
export function moderateSkyWeather(skyState, view, out = {}, floors = GDO_NIGHT_READABILITY_FLOORS) {
  out.horizon = out.horizon ?? [0, 0, 0];
  out.middle = out.middle ?? [0, 0, 0];
  out.zenith = out.zenith ?? [0, 0, 0];
  out.fog = out.fog ?? [0, 0, 0];
  out.cloudTint = out.cloudTint ?? [1, 1, 1];
  out.clamped = out.clamped ?? [];
  out.clamped.length = 0;
  out.sunIntensity = rounded(Math.max(0, skyState.sunIntensity * view.sunScale));
  out.hemisphereIntensity = rounded(skyState.hemisphereIntensity * view.fillScale);
  out.exposure = skyState.exposure * view.exposureScale;
  for (let channel = 0; channel < 3; channel++) {
    out.cloudTint[channel] = view.cloudTint[channel];
    out.horizon[channel] = clamp(skyState.horizon[channel] * mix(1, .86, view.cloudiness * .5), 0, 1);
    out.middle[channel] = clamp(skyState.middle[channel] * mix(1, .88, view.cloudiness * .5), 0, 1);
    out.zenith[channel] = clamp(skyState.zenith[channel] * mix(1, .92, view.cloudiness * .5), 0, 1);
    out.fog[channel] = clamp(skyState.fog[channel] * view.fogTint[channel], 0, 1);
  }
  // The floors are the low-profile readability contract: weather may darken a
  // night, never below what the HUD read and the movement audit need.
  if (skyState.exposure >= floors.exposure && out.exposure < floors.exposure) {
    out.exposure = floors.exposure; out.clamped.push('exposure');
  }
  if (skyState.sunIntensity >= floors.sunIntensity && out.sunIntensity < floors.sunIntensity) {
    out.sunIntensity = floors.sunIntensity; out.clamped.push('sunIntensity');
  }
  if (skyState.hemisphereIntensity >= floors.hemisphereIntensity && out.hemisphereIntensity < floors.hemisphereIntensity) {
    out.hemisphereIntensity = floors.hemisphereIntensity; out.clamped.push('hemisphereIntensity');
  }
  const fogLuminance = out.fog[0] * .2126 + out.fog[1] * .7152 + out.fog[2] * .0722;
  if (fogLuminance > 0 && fogLuminance < floors.fogLuminance) {
    const lift = floors.fogLuminance / fogLuminance;
    for (let channel = 0; channel < 3; channel++) out.fog[channel] = clamp(out.fog[channel] * lift, 0, 1);
    out.clamped.push('fog');
  }
  out.exposure = rounded(out.exposure);
  out.id = view.id;
  out.cloudiness = view.cloudiness;
  out.fogNearScale = view.fogNearScale;
  out.fogFarScale = view.fogFarScale;
  out.wind = view.wind;
  out.habitat = view.habitat;
  out.surface = view.surface;
  out.precipitation = view.precipitation;
  out.activePrecipitation = view.activePrecipitation;
  return out;
}

/**
 * The weather machine. `update()` advances on a bounded cadence and writes only
 * the channels that actually changed; `override()` forces a state for a scripted
 * audit; diagnostics and `sample()` report the same numbers the world applied.
 */
export function createWeatherState({
  profile = 'low',
  seed = '00000000',
  latitude = 0,
  month = 7,
  dayLengthMinutes = GDO_TIME_OF_DAY_DEFAULTS.dayLengthMinutes,
  startFraction = GDO_TIME_OF_DAY_DEFAULTS.startFraction,
  clockMilliseconds = 0,
  climate = null,
  targets = null,
  ledger = null,
} = {}) {
  const policy = GDO_WEATHER_PROFILES[profile];
  if (!policy) throw new RangeError(`Unknown weather profile: ${profile}`);
  if (typeof seed !== 'string' || !seed) throw new TypeError('Weather needs a stable seed string');
  if (!Number.isFinite(latitude)) throw new TypeError('Weather needs a finite latitude');
  if (!Number.isFinite(dayLengthMinutes) || dayLengthMinutes <= 0) throw new RangeError('Weather day length must be positive');

  const dayMilliseconds = dayLengthMinutes * 60_000;
  const state = createWeatherView();
  const skyView = createWeatherView();
  const applied = {};
  const runStates = new Map();
  const refusalCounts = Object.create(null);
  const previousWritten = Object.create(null);
  const epsilons = Object.create(null);
  let clock = clockMilliseconds;
  let lastUpdateAt = -Infinity;
  let lastClimateBlendAt = clockMilliseconds;
  let overrideName = null;
  let runIndex = -1;
  let season = weatherSeasonFor({ month, latitude });
  let appliedTargets = targets;
  const climateRecord = climate && climate.namespace === GDO_WEATHER_NAMESPACE
    ? climate : sampleWeatherClimate(climate ?? { latitude }, createWeatherClimate());
  const climateTarget = createWeatherClimate();
  for (const field of NUMERIC_CLIMATE_FIELDS) climateTarget[field] = climateRecord[field];
  climateTarget.wetland = climateRecord.wetland;
  climateTarget.inWater = climateRecord.inWater;
  climateTarget.waterDistance = climateRecord.waterDistance;
  climateTarget.quantized = climateRecord.quantized;
  const diagnostics = {
    updates: 0, skippedUpdates: 0, transitions: 0, writes: 0, writesThisUpdate: 0,
    deferredWrites: 0, overBudgetUpdates: 0, climateRefusals: 0, fallbackUses: 0,
    climateBlends: 0, clampedChannels: 0, steadyFrameAllocations: 0, longestRun: 1,
    reapplies: 0, reappliedWrites: 0,
  };
  const scope = ledger?.child?.('weather') ?? null;

  const writers = [
    { key: 'sunIntensity', epsilon: .02, write: (view, target) => { if (target.rig?.sun) target.rig.sun.intensity = view.sunIntensity; } },
    { key: 'hemisphereIntensity', epsilon: .02, write: (view, target) => { if (target.rig?.fill) target.rig.fill.intensity = view.hemisphereIntensity; } },
    { key: 'exposure', epsilon: .005, write: (view, target) => { if (target.renderer) target.renderer.toneMappingExposure = view.exposure; } },
    { key: 'fog', epsilon: .004, write: (view, target) => {
      target.scene?.fog?.color?.setRGB(view.fog[0], view.fog[1], view.fog[2]);
      target.scene?.background?.setRGB?.(view.fog[0], view.fog[1], view.fog[2]);
    } },
    { key: 'fogRange', epsilon: .01, write: (view, target) => {
      const fog = target.scene?.fog;
      if (!fog || !Number.isFinite(target.fogNear) || !Number.isFinite(target.fogFar)) return;
      fog.near = Math.max(.5, target.fogNear * view.fogNearScale);
      fog.far = Math.max(fog.near + .5, target.fogFar * view.fogFarScale);
    } },
    { key: 'cloudCoverage', field: 'cloudiness', epsilon: .02, write: (view, target) => {
      const uniform = target.sky?.uniforms?.uCloudCoverage;
      if (uniform) uniform.value = policy.cloudCoverage ? view.cloudiness : 0;
    } },
    { key: 'cloudTint', epsilon: .01, write: (view, target) => {
      const uniform = target.sky?.uniforms?.uCloudTint;
      if (!uniform) return;
      const tint = policy.cloudTint ? view.cloudTint : [1, 1, 1];
      uniform.value.setRGB(tint[0], tint[1], tint[2]);
    } },
    { key: 'wind', epsilon: .01, write: (view, target) => {
      if (!policy.windResponse || typeof target.wind !== 'function') return;
      target.wind({ strength: view.wind.strength, gustiness: view.wind.gustiness });
    } },
    { key: 'habitat', epsilon: .01, write: (view, target) => {
      if (!policy.habitatResponse || typeof target.habitat !== 'function') return;
      target.habitat({ flyers: view.habitat.flyers, insects: view.habitat.insects });
    } },
  ];
  for (const writer of writers) epsilons[writer.key] = writer.epsilon;

  /**
   * Which writers the profile (and the live targets) actually carry. A response
   * the profile opted out of, or a target that cannot receive it, is refused by
   * name in `fallback` instead of being written into a no-op.
   */
  const WRITER_OPT_IN = Object.freeze({
    sunIntensity: () => true,
    hemisphereIntensity: () => true,
    exposure: () => true,
    fog: () => true,
    fogRange: (active) => Number.isFinite(active?.fogNear) && Number.isFinite(active?.fogFar),
    cloudCoverage: (active, activePolicy) =>
      activePolicy.cloudCoverage && Boolean(active?.sky?.uniforms?.uCloudCoverage),
    cloudTint: (active, activePolicy) =>
      activePolicy.cloudTint && Boolean(active?.sky?.uniforms?.uCloudTint),
    wind: (active, activePolicy) => activePolicy.windResponse && typeof active?.wind === 'function',
    habitat: (active, activePolicy) => activePolicy.habitatResponse && typeof active?.habitat === 'function',
  });

  function worldHoursAt(milliseconds) {
    return ((milliseconds / dayMilliseconds) + startFraction) * 24;
  }

  function runAt(milliseconds) {
    return Math.floor(worldHoursAt(milliseconds) / policy.runHours);
  }

  function resolveRun(index, previous) {
    const resolved = resolveWeatherRun({
      seed, run: index, season, latitude, climate: climateRecord,
      previous: previous?.id ?? null,
    });
    if (resolved.fallbackUsed) diagnostics.fallbackUses++;
    diagnostics.climateRefusals += resolved.refusals.length;
    for (const refusal of resolved.refusals) {
      refusalCounts[refusal.reason] = (refusalCounts[refusal.reason] ?? 0) + 1;
    }
    runStates.set(index, resolved.state);
    return resolved.state;
  }

  /**
   * The state of one run. It walks the chain from its block's anchor — at most
   * `GDO_WEATHER_CHAIN_RUNS + 1` transitions — and memoizes each step, so the
   * cost is bounded, the answer is a pure function of the seed, the season, and
   * the climate, and the buffer stays a fixed number of runs.
   */
  function stateForRun(run) {
    const cached = runStates.get(run);
    if (cached) return cached;
    const anchor = Math.floor(run / GDO_WEATHER_CHAIN_RUNS) * GDO_WEATHER_CHAIN_RUNS;
    let previous = null;
    for (let index = anchor; index <= run; index++) {
      previous = runStates.get(index) ?? resolveRun(index, previous);
    }
    if (runStates.size > GDO_WEATHER_CHAIN_RUNS * 3) {
      for (const key of runStates.keys()) {
        if (key < run - GDO_WEATHER_CHAIN_RUNS * 2) runStates.delete(key);
      }
    }
    return previous;
  }

  /** Slow the climate toward the newest sample so a tile edge never snaps. */
  function blendClimate(milliseconds) {
    if (milliseconds === lastClimateBlendAt) return false;
    const elapsed = Math.max(0, milliseconds - lastClimateBlendAt);
    lastClimateBlendAt = milliseconds;
    if (elapsed <= 0) return false;
    const amount = 1 - Math.exp(-elapsed / GDO_WEATHER_CLIMATE_BLEND_MILLISECONDS);
    let moved = 0;
    for (const field of NUMERIC_CLIMATE_FIELDS) {
      const next = mix(climateRecord[field], climateTarget[field], amount);
      if (Math.abs(next - climateRecord[field]) > 1e-4) moved++;
      climateRecord[field] = next;
    }
    // Flags and the mapped distance are facts, not gradients: they snap.
    climateRecord.wetland = climateTarget.wetland;
    climateRecord.inWater = climateTarget.inWater;
    climateRecord.waterDistance = climateTarget.waterDistance;
    climateRecord.source = climateTarget.source;
    climateRecord.quantized = `${Math.round(climateRecord.temperature * 8)}:${Math.round(climateRecord.moisture * 8)}:${Math.round(climateRecord.aridity * 8)}`;
    if (moved) diagnostics.climateBlends++;
    return moved > 0;
  }

  function sampleAt(milliseconds) {
    if (overrideName) {
      const forced = GDO_WEATHER_STATES.find(entry => entry.id === overrideName) ?? GDO_WEATHER_STATES[0];
      blendWeatherStates(forced, forced, 1, state);
      state.run = runAt(milliseconds);
      return state;
    }
    const run = runAt(milliseconds);
    const current = stateForRun(run);
    // The blend ramps from the run that came before this one, so a transition is
    // a ramp between two real states rather than a fade from the state itself.
    const previous = run > 0 ? stateForRun(run - 1) : current;
    const hoursIntoRun = worldHoursAt(milliseconds) - run * policy.runHours;
    // The research's 1–3 s uniform transition band, expressed in world time: at
    // the shipped 24-minute day one real second is one world minute, so a 3 s
    // blend is a 3-world-minute ramp.
    // One real second of animation time is `dayLengthMinutes` world-minutes long,
    // so the declared blend in *seconds* converts straight into world minutes.
    const blendWorldMinutes = policy.blendSeconds * (dayLengthMinutes * 60) / (dayMilliseconds / 1_000);
    const amount = blendWorldMinutes <= 0 ? 1 : clamp(hoursIntoRun * 60 / blendWorldMinutes);
    blendWeatherStates(previous, current, amount, state);
    state.run = run;
    if (run !== runIndex) {
      if (runIndex >= 0) {
        diagnostics.transitions++;
        diagnostics.longestRun = Math.max(diagnostics.longestRun, run - runIndex);
      }
      runIndex = run;
    }
    return state;
  }

  function channelChanged(writer, view) {
    const key = writer.field ?? writer.key;
    const before = previousWritten[key];
    if (!before) return true;
    const epsilon = epsilons[writer.key];
    if (key === 'fog' || key === 'cloudTint') {
      const value = view[key];
      return Math.abs(value[0] - before[0]) > epsilon || Math.abs(value[1] - before[1]) > epsilon ||
        Math.abs(value[2] - before[2]) > epsilon;
    }
    if (key === 'fogRange') {
      return Math.abs(view.fogNearScale - before.fogNearScale) > epsilon ||
        Math.abs(view.fogFarScale - before.fogFarScale) > epsilon;
    }
    if (key === 'wind') {
      return Math.abs(view.wind.strength - before.strength) > epsilon ||
        Math.abs(view.wind.gustiness - before.gustiness) > epsilon;
    }
    if (key === 'habitat') {
      return Math.abs(view.habitat.flyers - before.flyers) > epsilon ||
        Math.abs(view.habitat.insects - before.insects) > epsilon;
    }
    return Math.abs(view[key] - before) > epsilon;
  }

  function recordWritten(writer, view) {
    const key = writer.field ?? writer.key;
    if (key === 'fog' || key === 'cloudTint') { previousWritten[key] = view[key].slice(); return; }
    if (key === 'fogRange') {
      previousWritten[key] = { fogNearScale: view.fogNearScale, fogFarScale: view.fogFarScale };
      return;
    }
    if (key === 'wind') {
      previousWritten[key] = { strength: view.wind.strength, gustiness: view.wind.gustiness };
      return;
    }
    if (key === 'habitat') {
      previousWritten[key] = { flyers: view.habitat.flyers, insects: view.habitat.insects };
      return;
    }
    previousWritten[key] = view[key];
  }

  /**
   * What the active profile — or the active target — refuses to render, named
   * rather than dropped. `appliedTargets` is the target set of the last update, so
   * a machine whose game supplies targets reports the real capability.
   */
  function fallbackRecord(out = []) {
    out.length = 0;
    const active = appliedTargets;
    if (!policy.cloudCoverage) out.push(Object.freeze({ response: 'cloudCoverage', reason: 'profile-opts-out' }));
    if (!policy.cloudTint) out.push(Object.freeze({ response: 'cloudTint', reason: 'profile-opts-out' }));
    if (!policy.precipitationParticles && state.activePrecipitation) {
      out.push(Object.freeze({ response: `particles:${state.activePrecipitation}`, reason: 'profile-opts-out' }));
    }
    if (!policy.windResponse) out.push(Object.freeze({ response: 'wind', reason: 'profile-opts-out' }));
    if (!policy.habitatResponse) out.push(Object.freeze({ response: 'habitat', reason: 'profile-opts-out' }));
    if (policy.cloudCoverage && !active?.sky?.uniforms?.uCloudCoverage) {
      out.push(Object.freeze({ response: 'cloudCoverage', reason: 'target-unsupported' }));
    }
    if (policy.cloudTint && !active?.sky?.uniforms?.uCloudTint) {
      out.push(Object.freeze({ response: 'cloudTint', reason: 'target-unsupported' }));
    }
    if (policy.windResponse && typeof active?.wind !== 'function') {
      out.push(Object.freeze({ response: 'wind', reason: 'target-unsupported' }));
    }
    if (policy.habitatResponse && typeof active?.habitat !== 'function') {
      out.push(Object.freeze({ response: 'habitat', reason: 'target-unsupported' }));
    }
    return out;
  }

  const fallbackCache = [];

  const api = {
    namespace: GDO_WEATHER_NAMESPACE,
    profile,
    policy,
    seed,
    latitude,
    limits: Object.freeze({
      maxUpdatesHz: policy.maxUpdatesHz,
      maxWritesPerUpdate: policy.maxWritesPerUpdate,
      runHours: policy.runHours,
      blendSeconds: policy.blendSeconds,
      // The cadence in animation time, so a scripted audit can land just after a
      // run boundary instead of guessing where the ramps are.
      runMilliseconds: policy.runHours * dayMilliseconds / 24,
      blendMilliseconds: policy.blendSeconds * 1_000,
      writers: writers.length,
      cloudCoverage: policy.cloudCoverage,
      precipitationParticles: policy.precipitationParticles,
    }),
    state,
    get season() { return season; },
    get climate() { return climateRecord; },
    get runIndex() { return runIndex; },
    get targetClimate() { return climateTarget; },
    get fallback() { return fallbackRecord(fallbackCache).slice(); },
    setMonth(value) {
      season = weatherSeasonFor({ month: value, latitude });
      return season;
    },
    /** A new climate sample: it becomes the blend target, never an instant snap. */
    setClimate(next) {
      if (!next) return climateRecord;
      const sample = next.namespace === GDO_WEATHER_NAMESPACE ? next : sampleWeatherClimate(next, {});
      for (const field of NUMERIC_CLIMATE_FIELDS) {
        if (Number.isFinite(sample[field])) climateTarget[field] = sample[field];
      }
      climateTarget.wetland = Boolean(sample.wetland);
      climateTarget.inWater = Boolean(sample.inWater);
      climateTarget.waterDistance = sample.waterDistance;
      climateTarget.source = sample.source ?? climateTarget.source;
      return climateTarget;
    },
    /** Fold a raw field set straight into the target climate. */
    setClimateFields(fields = {}) {
      return api.setClimate(sampleWeatherClimate({ ...fields, latitude }, {}));
    },
    override(name) {
      if (name == null) { overrideName = null; return null; }
      if (!GDO_WEATHER_STATE_IDS.includes(name)) throw new RangeError(`Unknown weather override: ${name}`);
      overrideName = name;
      return name;
    },
    get overrideName() { return overrideName; },
    advance(milliseconds) {
      if (!Number.isFinite(milliseconds)) throw new RangeError('Weather clock advance must be finite');
      clock += milliseconds;
      return clock;
    },
    setClock(milliseconds) {
      if (!Number.isFinite(milliseconds)) throw new RangeError('Weather clock must be finite');
      clock = milliseconds;
      return clock;
    },
    get clockMilliseconds() { return clock; },
    /** The instant the next run starts, for tooling and scripted audits. */
    nextRunBoundary(milliseconds = clock) {
      if (!Number.isFinite(milliseconds)) throw new RangeError('Weather boundary needs a finite clock');
      const run = runAt(milliseconds);
      const elapsed = worldHoursAt(milliseconds) - run * policy.runHours;
      return milliseconds + Math.max(0, policy.runHours - elapsed) / 24 * dayMilliseconds;
    },
    /** The blended view for this instant, without writing anything. */
    sample(nowMilliseconds = clock) {
      if (!Number.isFinite(nowMilliseconds)) throw new RangeError('Weather sampling needs a finite time');
      blendClimate(nowMilliseconds);
      return sampleAt(nowMilliseconds);
    },
    /**
     * Re-apply the current response to the targets without advancing the machine.
     * `ENV-02` is an independent writer of the same sun/fog/exposure channels, so
     * when it lands a keyframe it overwrites the weather's scale; this one bounded
     * pass puts the moderated numbers back on exactly the channels the profile
     * owns. It is never called from the state machine itself.
     */
    reapply({ skyState = null, targets: nextTargets = null } = {}) {
      const active = nextTargets ?? targets;
      if (!active) return 0;
      appliedTargets = active;
      const moderated = moderateSkyWeather(
        skyState ?? GDO_WEATHER_IDENTITY_SKY, state, skyView, GDO_NIGHT_READABILITY_FLOORS,
      );
      let writes = 0, deferred = 0;
      for (const writer of writers) {
        if (!WRITER_OPT_IN[writer.key]?.(active, policy)) continue;
        if (writes >= policy.maxWritesPerUpdate) { deferred++; continue; }
        writer.write(moderated, active);
        recordWritten(writer, moderated);
        writes++;
      }
      diagnostics.reapplies++;
      diagnostics.reappliedWrites += writes;
      diagnostics.writes += writes;
      diagnostics.deferredWrites += deferred;
      if (deferred > 0) diagnostics.overBudgetUpdates++;
      return writes;
    },
    /**
     * Restore the machine to its first instant: the same clock, the same run, the
     * same climate record, no override, and a cleared diagnostic surface. A
     * scripted audit runs its script twice and compares fingerprints, so a reset
     * has to mean reset.
     */
    reset({ climate = null, nowMilliseconds = 0 } = {}) {
      clock = 0;
      lastUpdateAt = -Infinity;
      lastClimateBlendAt = 0;
      runIndex = -1;
      overrideName = null;
      runStates.clear();
      for (const key of Object.keys(refusalCounts)) delete refusalCounts[key];
      for (const key of Object.keys(previousWritten)) previousWritten[key] = null;
      // A skipped channel is absent from `previousWritten`; drop nothing else, so
      // the first update after a reset writes the whole response once.
      for (const key of Object.keys(diagnostics)) diagnostics[key] = key === 'longestRun' ? 1 : 0;
      const sample = climate
        ? (climate.namespace === GDO_WEATHER_NAMESPACE ? climate : sampleWeatherClimate(climate, {}))
        : sampleWeatherClimate({ latitude }, {});
      for (const field of NUMERIC_CLIMATE_FIELDS) {
        climateRecord[field] = sample[field];
        climateTarget[field] = sample[field];
      }
      for (const field of ['wetland', 'inWater', 'waterDistance', 'source', 'quantized']) {
        climateRecord[field] = sample[field];
        climateTarget[field] = sample[field];
      }
      api.sample(nowMilliseconds);
      appliedTargets = targets;
      return api.state;
    },
    /**
     * One bounded update: blend the climate, advance the state, apply the
     * response to the declared targets, and report how many channels actually
     * changed. A settled state writes nothing, so a steady frame is free.
     */
    update({ nowMilliseconds = clock, skyState = null, targets: nextTargets = null } = {}) {
      if (!Number.isFinite(nowMilliseconds)) throw new RangeError('Weather update needs a finite time');
      const active = nextTargets ?? targets;
      if (active) appliedTargets = active;
      const interval = 1000 / policy.maxUpdatesHz;
      if (nowMilliseconds - lastUpdateAt < interval - 1e-9) {
        diagnostics.skippedUpdates++;
        diagnostics.writesThisUpdate = 0;
        return false;
      }
      lastUpdateAt = nowMilliseconds;
      // The machine's own clock follows the last update, so `clockMilliseconds`
      // and a defaulted `sample()` mean "now" rather than "the initial instant".
      clock = nowMilliseconds;
      diagnostics.updates++;
      api.sample(nowMilliseconds);
      if (!active) { diagnostics.writesThisUpdate = 0; return false; }
      const moderated = moderateSkyWeather(skyState ?? GDO_WEATHER_IDENTITY_SKY, state, skyView, GDO_NIGHT_READABILITY_FLOORS);
      diagnostics.clampedChannels += moderated.clamped.length;
      applied.id = moderated.id;
      // The audit reads the numbers the renderer received, not a second sample.
      applied.sunIntensity = moderated.sunIntensity;
      applied.hemisphereIntensity = moderated.hemisphereIntensity;
      applied.exposure = moderated.exposure;
      applied.cloudiness = moderated.cloudiness;
      applied.fogNearScale = moderated.fogNearScale;
      applied.fogFarScale = moderated.fogFarScale;
      applied.clamped = moderated.clamped.length;
      applied.surface = moderated.surface;
      applied.habitat = moderated.habitat;
      applied.wind = moderated.wind;
      applied.precipitation = moderated.precipitation;
      applied.activePrecipitation = moderated.activePrecipitation;
      applied.fog = moderated.fog;
      let writes = 0, deferred = 0;
      for (const writer of writers) {
        if (!WRITER_OPT_IN[writer.key]?.(active, policy)) continue;
        if (!channelChanged(writer, moderated)) continue;
        if (writes >= policy.maxWritesPerUpdate) { deferred++; continue; }
        writer.write(moderated, active);
        recordWritten(writer, moderated);
        writes++;
      }
      diagnostics.writesThisUpdate = writes;
      diagnostics.writes += writes;
      diagnostics.deferredWrites += deferred;
      if (deferred > 0) diagnostics.overBudgetUpdates++;
      return writes > 0;
    },
    /** The moderated `ENV-02` view, for callers that apply the sky themselves. */
    moderatedSky(skyState) {
      return moderateSkyWeather(skyState, state, skyView, GDO_NIGHT_READABILITY_FLOORS);
    },
    /** What the last update actually applied, as one reused record. */
    get applied() { return applied; },
    diagnostics() {
      return Object.freeze({
        namespace: GDO_WEATHER_NAMESPACE,
        profile,
        seed,
        id: state.id,
        from: state.from,
        to: state.to,
        blend: state.blend,
        run: state.run,
        season,
        precipitation: state.precipitation,
        activePrecipitation: state.activePrecipitation,
        cloudiness: state.cloudiness,
        sunScale: state.sunScale,
        windStrength: state.wind.strength,
        gustiness: state.wind.gustiness,
        surface: Object.freeze({ ...state.surface }),
        habitat: Object.freeze({ ...state.habitat }),
        climate: Object.freeze({
          source: climateRecord.source, temperature: rounded(climateRecord.temperature),
          moisture: rounded(climateRecord.moisture), aridity: rounded(climateRecord.aridity),
        }),
        updates: diagnostics.updates,
        skippedUpdates: diagnostics.skippedUpdates,
        transitions: diagnostics.transitions,
        uniformWrites: diagnostics.writes,
        writesThisUpdate: diagnostics.writesThisUpdate,
        deferredWrites: diagnostics.deferredWrites,
        overBudgetUpdates: diagnostics.overBudgetUpdates,
        reapplies: diagnostics.reapplies,
        reappliedWrites: diagnostics.reappliedWrites,
        climateRefusals: diagnostics.climateRefusals,
        refusalReasons: Object.freeze({ ...refusalCounts }),
        fallbackUses: diagnostics.fallbackUses,
        climateBlends: diagnostics.climateBlends,
        clampedChannels: diagnostics.clampedChannels,
        longestRun: diagnostics.longestRun,
        fallback: fallbackRecord([]),
        limits: Object.freeze({
          maxUpdatesHz: policy.maxUpdatesHz,
          maxWritesPerUpdate: policy.maxWritesPerUpdate,
          runHours: policy.runHours,
          writers: writers.length,
        }),
        steadyFrameAllocations: 0,
      });
    },
    describe() {
      return Object.freeze({
        namespace: GDO_WEATHER_NAMESPACE,
        profile,
        seed,
        season,
        states: GDO_WEATHER_STATE_IDS,
        current: state.id,
        climate: Object.freeze({
          temperature: rounded(climateRecord.temperature), moisture: rounded(climateRecord.moisture),
          aridity: rounded(climateRecord.aridity), source: climateRecord.source,
        }),
        fallback: fallbackRecord([]),
      });
    },
    dispose() {
      scope?.disposeAll?.();
    },
  };

  return api;
}

/**
 * The neutral sky the machine weathers when a caller has no `ENV-02` state yet.
 * It is the daylight entry of `ENV-02`'s own keyframe table, exported so a caller
 * (and an audit) can read the same base the machine falls back to.
 */
export const GDO_WEATHER_IDENTITY_SKY = Object.freeze({
  horizon: Object.freeze([.62, .70, .775]), middle: Object.freeze([.43, .585, .78]),
  zenith: Object.freeze([.235, .415, .71]), fog: Object.freeze([.56, .68, .79]),
  sunIntensity: 3.2, hemisphereIntensity: .86, exposure: 1.05,
});

/** Declared ceilings and responses, checked against the shipped low budget. */
export function describeWeather(budget = GDO_LOW_PROFILE_BUDGETS, profiles = GDO_WEATHER_PROFILES) {
  const violations = [];
  const low = profiles.low;
  if (low.maxWritesPerUpdate > budget.weatherWritesPerUpdate) {
    violations.push(`writes/update ${low.maxWritesPerUpdate} > budget ${budget.weatherWritesPerUpdate}`);
  }
  if (low.steadyFrameAllocations > budget.weatherSteadyFrameAllocations) {
    violations.push(`steady-frame allocations ${low.steadyFrameAllocations} > budget ${budget.weatherSteadyFrameAllocations}`);
  }
  const families = new Set(GDO_WEATHER_STATES.map(state => state.precipitation).filter(Boolean));
  for (const state of GDO_WEATHER_STATES) {
    // A state declares one family or none, so the runtime cap of one active
    // family can never be exceeded by a blend of two states.
    if (Array.isArray(state.precipitation)) violations.push(`state ${state.id} declares more than one precipitation family`);
  }
  if (budget.weatherPrecipitationFamilies < 1) {
    violations.push(`budget allows ${budget.weatherPrecipitationFamilies} active precipitation families`);
  }
  const ids = new Set();
  for (const state of GDO_WEATHER_STATES) {
    if (ids.has(state.id)) violations.push(`state ${state.id} is declared twice`);
    ids.add(state.id);
    if (!GDO_WEATHER_TRANSITIONS[state.id]) violations.push(`state ${state.id} has no transition row`);
    for (const key of ['cloudiness', 'sunScale', 'fillScale', 'exposureScale', 'fogNearScale', 'fogFarScale']) {
      if (!Number.isFinite(state[key])) violations.push(`state ${state.id} is missing ${key}`);
    }
    if (!state.wind || !state.surface || !state.habitat ||
        !Array.isArray(state.cloudTint) || !Array.isArray(state.fogTint)) {
      violations.push(`state ${state.id} has an incomplete response`);
    }
    if (!['clear', 'haze', 'overcast', 'rain', 'storm', 'dust', 'snow', 'mist'].includes(state.id)) {
      violations.push(`state ${state.id} is not one of the eight research states`);
    }
  }
  return Object.freeze({
    namespace: GDO_WEATHER_NAMESPACE,
    ok: violations.length === 0,
    violations: Object.freeze(violations),
    states: GDO_WEATHER_STATES.length,
    precipitationFamilies: families.size,
    profiles: Object.keys(profiles).length,
    budget: Object.freeze({ ...budget }),
  });
}

/** The one-line HUD copy for a weather view. */
export function weatherHudText(view) {
  const surface = view?.surface ?? { wetness: 0, dust: 0, snow: 0, damp: 0 };
  const active = [];
  if (surface.snow >= .5) active.push('snow');
  else if (surface.wetness >= .5) active.push('wet');
  else if (surface.damp >= .4) active.push('damp');
  if (surface.dust >= .5) active.push('dusty');
  const label = GDO_WEATHER_STATES.find(state => state.id === view?.id)?.label ?? 'Clear';
  return Object.freeze({
    id: view?.id ?? 'clear',
    label,
    detail: active.length ? active.join(' · ') : 'dry',
    text: `${label} · ${active.length ? active.join(' · ') : 'dry'}`,
  });
}

/** The run index a clock falls in, for tests and tooling. */
export function weatherRunAt(milliseconds, {
  dayLengthMinutes = GDO_TIME_OF_DAY_DEFAULTS.dayLengthMinutes,
  startFraction = GDO_TIME_OF_DAY_DEFAULTS.startFraction,
  runHours = 3,
} = {}) {
  if (!Number.isFinite(milliseconds)) throw new RangeError('Weather needs a finite clock');
  return Math.floor((((milliseconds / (dayLengthMinutes * 60_000)) + startFraction) * 24) / runHours);
}
