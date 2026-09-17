import { featureNamespace } from '../engine/FeatureVersions.js';
import { GEO_TERRAIN_DEFAULTS, queryTerrainSupport } from './GeoTerrain.js';
import { queryWaterDomain } from './GeoWaterDomains.js';

export const GDO_VEGETATION_MORPHOLOGY_NAMESPACE = featureNamespace('vegetationMorphology');
export const GEO_MORPHOLOGY_STRIDE = 13;
export const GEO_ENVIRONMENT_TOP_INFLUENCES = 3;
export const GEO_MORPHOLOGY_SCALE_MIN = .72;
export const GEO_MORPHOLOGY_SCALE_MAX = 1.28;

export const GEO_MORPHOLOGY_INFLUENCE = Object.freeze({
  TROPICAL: 0,
  SUBTROPICAL: 1,
  ARID: 2,
  UPLAND: 3,
  RIPARIAN: 4,
  URBAN: 5,
});

export const GEO_MORPHOLOGY_INFLUENCES = Object.freeze([
  Object.freeze({ id: 0, key: 'tropical', label: 'Tropical', ground: Object.freeze([.12, .29, .08]) }),
  Object.freeze({ id: 1, key: 'subtropical', label: 'Subtropical', ground: Object.freeze([.18, .31, .10]) }),
  Object.freeze({ id: 2, key: 'arid', label: 'Arid', ground: Object.freeze([.40, .28, .12]) }),
  Object.freeze({ id: 3, key: 'upland', label: 'Upland', ground: Object.freeze([.13, .24, .15]) }),
  Object.freeze({ id: 4, key: 'riparian', label: 'Riparian', ground: Object.freeze([.11, .26, .14]) }),
  Object.freeze({ id: 5, key: 'urban', label: 'Urban', ground: Object.freeze([.20, .22, .16]) }),
]);

export const GEO_MORPHOLOGY_FIELD_NAMES = Object.freeze([
  'temperature', 'moisture', 'seasonality', 'elevation', 'ruggedness',
  'riparian', 'canopy', 'fertility', 'human', 'urban',
]);

const PLANT_TYPES = new Set([0, 1, 2, 5, 8, 9, 12]);

const DEFAULT_MORPHOLOGY = Object.freeze({
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
  archetypeIndex: 0,
  paletteSlot: 0,
  age: .8,
  windStiffness: .65,
  profileId0: GEO_MORPHOLOGY_INFLUENCE.SUBTROPICAL,
  profileId1: GEO_MORPHOLOGY_INFLUENCE.TROPICAL,
  profileId2: GEO_MORPHOLOGY_INFLUENCE.ARID,
  profileWeight0: 1,
  profileWeight1: 0,
  profileWeight2: 0,
});

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function smooth(value) { return value * value * (3 - 2 * value); }

function mix32(value) {
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function coordinateRandom(x, z, seed) {
  return mix32(Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(z | 0, 0x5f356495) ^ seed) / 4294967296;
}

function valueNoise(x, z, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const tx = smooth(x - x0), tz = smooth(z - z0);
  const first = coordinateRandom(x0, z0, seed) * (1 - tx) + coordinateRandom(x0 + 1, z0, seed) * tx;
  const second = coordinateRandom(x0, z0 + 1, seed) * (1 - tx) + coordinateRandom(x0 + 1, z0 + 1, seed) * tx;
  return first * (1 - tz) + second * tz;
}

function hashParts(...parts) {
  let hash = 2166136261;
  for (const part of parts) for (const character of `${part}\u001f`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return mix32(hash);
}

function mappedFlag(kind, names) {
  const normalized = String(kind || '').toLowerCase();
  return names.some(name => normalized.includes(name));
}

function validEnvironment(environment) {
  if (environment?.namespace !== GDO_VEGETATION_MORPHOLOGY_NAMESPACE ||
      environment.weights?.length !== GEO_MORPHOLOGY_INFLUENCES.length ||
      environment.topIds?.length !== GEO_ENVIRONMENT_TOP_INFLUENCES ||
      environment.topWeights?.length !== GEO_ENVIRONMENT_TOP_INFLUENCES) return false;
  const weights = [...environment.weights], topIds = [...environment.topIds], topWeights = [...environment.topWeights];
  return weights.every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
    Math.abs(weights.reduce((total, value) => total + value, 0) - 1) < 1e-4 &&
    topIds.every(value => Number.isInteger(value) && value >= 0 && value < GEO_MORPHOLOGY_INFLUENCES.length) &&
    new Set(topIds).size === GEO_ENVIRONMENT_TOP_INFLUENCES &&
    topWeights.every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
    Math.abs(topWeights.reduce((total, value) => total + value, 0) - 1) < 1e-4 &&
    environment.geographic && Number.isFinite(environment.geographic.absoluteX) &&
    Number.isFinite(environment.geographic.absoluteZ) &&
    GEO_MORPHOLOGY_FIELD_NAMES.every(name => Number.isFinite(environment[name]) &&
      environment[name] >= 0 && environment[name] <= 1);
}

function distanceToSegment(x, z, segment) {
  const dx = segment[2] - segment[0], dz = segment[3] - segment[1];
  const lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared ? clamp(((x - segment[0]) * dx + (z - segment[1]) * dz) / lengthSquared) : 0;
  return Math.hypot(x - (segment[0] + dx * amount), z - (segment[1] + dz * amount));
}

function mapProximity(x, z, obstacles) {
  let buildingDistance = Infinity, routeDistance = Infinity;
  for (const building of obstacles?.buildings ?? []) {
    const dx = x < building.minX ? building.minX - x : x > building.maxX ? x - building.maxX : 0;
    const dz = z < building.minZ ? building.minZ - z : z > building.maxZ ? z - building.maxZ : 0;
    buildingDistance = Math.min(buildingDistance, Math.hypot(dx, dz));
  }
  for (const route of obstacles?.roads ?? []) {
    if (route[5] !== 0) continue;
    routeDistance = Math.min(routeDistance, Math.max(0, distanceToSegment(x, z, route) - route[4]));
  }
  const building = clamp(1 - buildingDistance / 5.5);
  const route = clamp(1 - routeDistance / 2.4);
  return { building, route, human: clamp(building * .78 + route * .34) };
}

/** Absolute projected coordinates remain stable when the same tile is mounted under another origin. */
export function environmentWorldCoordinates(request, x, z, out = {}) {
  if (!request || ![request.originX, request.originY, request.tileSize, x, z].every(Number.isFinite) || request.tileSize <= 0) {
    throw new TypeError('Environment sampling requires a finite projected tile request and point');
  }
  out.absoluteX = x + request.originX * request.tileSize;
  out.absoluteZ = z + request.originY * request.tileSize;
  if (Number.isInteger(request.zoom) && request.zoom >= 0 && request.zoom <= 24) {
    const tileCount = 2 ** request.zoom;
    const tileX = out.absoluteX / request.tileSize;
    const tileY = out.absoluteZ / request.tileSize;
    out.longitude = ((tileX % tileCount + tileCount) % tileCount) / tileCount * 360 - 180;
    const mercator = Math.PI - 2 * Math.PI * clamp(tileY / tileCount);
    out.latitude = Math.atan(Math.sinh(mercator)) * 180 / Math.PI;
  } else {
    const latitude = request.latitude == null ? 0 : Number(request.latitude);
    const longitude = request.longitude == null ? 0 : Number(request.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new TypeError('Environment request latitude/longitude must be finite when supplied');
    }
    out.latitude = latitude;
    out.longitude = longitude;
  }
  return out;
}

function normalizeInfluences(scores, out) {
  let total = 0;
  for (let index = 0; index < scores.length; index++) total += scores[index];
  for (let index = 0; index < scores.length; index++) out[index] = scores[index] / (total || 1);
  return out;
}

function topInfluences(weights, ids, values) {
  const order = [...weights.keys()].sort((a, b) => weights[b] - weights[a] || a - b)
    .slice(0, GEO_ENVIRONMENT_TOP_INFLUENCES);
  let total = 0;
  for (const id of order) total += weights[id];
  for (let index = 0; index < GEO_ENVIRONMENT_TOP_INFLUENCES; index++) {
    ids[index] = order[index];
    values[index] = weights[order[index]] / (total || 1);
  }
}

/**
 * Browser-local artistic fallback environment. Macro noise uses absolute world
 * coordinates, while map land/water/obstacle inputs are only local modifiers.
 */
export function sampleVegetationEnvironment({
  request,
  x,
  z,
  terrainSeed = 0,
  waterDomain,
  obstacles,
  mappedLandKind = '',
  out = {},
} = {}) {
  if (!waterDomain || !Number.isFinite(terrainSeed) ||
      !obstacles || !Array.isArray(obstacles.buildings) || !Array.isArray(obstacles.roads) ||
      typeof mappedLandKind !== 'string') {
    throw new TypeError('Vegetation environment requires finite terrain, map obstacles and a water domain');
  }
  const geographic = environmentWorldCoordinates(request, x, z, out.geographic ?? {});
  const macroX = geographic.absoluteX / 6_400;
  const macroZ = geographic.absoluteZ / 6_400;
  const thermalNoise = valueNoise(macroX, macroZ, 0x18f4a2d3);
  const moistureNoise = valueNoise(macroX + 37.2, macroZ - 19.7, 0x71c9e53b);
  const terrain = queryTerrainSupport(x, z, terrainSeed, out.terrain ?? {});
  const water = queryWaterDomain(waterDomain, x, z, out.water ?? {});
  const proximity = mapProximity(x, z, obstacles);
  const absoluteLatitude = Math.abs(geographic.latitude);
  const temperature = clamp(1 - absoluteLatitude / 76 + (thermalNoise - .5) * .12);
  const ruggedness = clamp(terrain.slopeRadians / .22);
  const elevation = clamp((GEO_TERRAIN_DEFAULTS.maximumHeight - terrain.y) /
    (GEO_TERRAIN_DEFAULTS.maximumHeight - GEO_TERRAIN_DEFAULTS.minimumHeight));
  const riparian = water.inWater ? 1 : clamp(1 - water.waterDistance / 2.4);
  const wetland = water.wetland || mappedFlag(mappedLandKind, ['wetland', 'marsh', 'swamp']);
  const sand = mappedFlag(mappedLandKind, ['sand', 'beach', 'desert', 'bare_rock']);
  const forest = mappedFlag(mappedLandKind, ['forest', 'wood']);
  const park = mappedFlag(mappedLandKind, ['park', 'garden']);
  const cropland = mappedFlag(mappedLandKind, ['farmland', 'farmyard', 'orchard', 'crop', 'meadow']);
  const built = mappedFlag(mappedLandKind, ['residential', 'commercial', 'industrial', 'retail', 'construction']);
  const aridity = clamp((1 - moistureNoise) * .56 + Number(sand) * .62 + Math.max(0, temperature - .58) * .35);
  const moisture = clamp(.30 + moistureNoise * .34 + temperature * .10 + riparian * .50 + Number(wetland) * .24 - aridity * .32);
  const canopy = clamp(Number(forest) * .78 + Number(park) * .42 + moisture * .20 - aridity * .14);
  const fertility = clamp(moisture * .52 + Number(cropland) * .52 + riparian * .18 - Number(sand) * .35);
  const human = clamp(Math.max(proximity.human, Number(built) * .86, Number(cropland) * .22));
  const urban = clamp(Math.max(Number(built), proximity.building * .9) * (.65 + proximity.route * .35));
  const seasonality = clamp(.28 + absoluteLatitude / 90 * .48 + aridity * .24);

  const scores = out.scores ?? new Float32Array(GEO_MORPHOLOGY_INFLUENCES.length);
  scores[GEO_MORPHOLOGY_INFLUENCE.TROPICAL] = .025 + clamp((temperature - .55) / .45) *
    (.38 + moisture * .62) * (1 - aridity * .58);
  scores[GEO_MORPHOLOGY_INFLUENCE.SUBTROPICAL] = .035 + clamp(1 - Math.abs(temperature - .62) / .48) *
    (.44 + fertility * .38) * (1 - aridity * .25);
  scores[GEO_MORPHOLOGY_INFLUENCE.ARID] = .025 + aridity * (.48 + temperature * .52);
  scores[GEO_MORPHOLOGY_INFLUENCE.UPLAND] = .02 + clamp(ruggedness * .72 + elevation * .20 +
    clamp((absoluteLatitude - 43) / 34) * .50);
  scores[GEO_MORPHOLOGY_INFLUENCE.RIPARIAN] = .02 + Math.max(riparian, Number(wetland) * .95) *
    (.52 + moisture * .48);
  scores[GEO_MORPHOLOGY_INFLUENCE.URBAN] = .02 + Math.max(urban, human * .55) *
    (.58 + (1 - canopy) * .42);
  const weights = normalizeInfluences(scores, out.weights ?? new Float32Array(scores.length));
  const topIds = out.topIds ?? new Uint8Array(GEO_ENVIRONMENT_TOP_INFLUENCES);
  const topWeights = out.topWeights ?? new Float32Array(GEO_ENVIRONMENT_TOP_INFLUENCES);
  topInfluences(weights, topIds, topWeights);

  out.namespace = GDO_VEGETATION_MORPHOLOGY_NAMESPACE;
  out.geographic = geographic;
  out.terrain = terrain;
  out.water = water;
  out.scores = scores;
  out.weights = weights;
  out.topIds = topIds;
  out.topWeights = topWeights;
  out.temperature = temperature;
  out.moisture = moisture;
  out.seasonality = seasonality;
  out.elevation = elevation;
  out.ruggedness = ruggedness;
  out.riparian = riparian;
  out.canopy = canopy;
  out.fertility = fertility;
  out.human = human;
  out.urban = urban;
  out.landKind = mappedLandKind || 'unmapped-ground';
  return out;
}

function weightedChoice(entries, selector) {
  let total = 0;
  for (const entry of entries) total += Math.max(0, entry[1]);
  let target = selector * (total || 1);
  for (const [value, weight] of entries) {
    target -= Math.max(0, weight);
    if (target <= 0) return value;
  }
  return entries.at(-1)[0];
}

/** Select a discrete family with stochastic weights from continuous influences. */
export function selectMorphologyPlantType(role, environment, seed = 0) {
  if (!validEnvironment(environment) || !Number.isSafeInteger(seed)) {
    throw new TypeError('Versioned finite environment and safe integer seed required for morphology selection');
  }
  const weight = id => environment.weights[id];
  const selector = hashParts(seed, role, Math.round(environment.geographic.absoluteX * 16),
    Math.round(environment.geographic.absoluteZ * 16), 'family') / 4294967296;
  if (role === 'ground-cover') return weightedChoice([
    [8, .12 + environment.moisture * .48 + weight(GEO_MORPHOLOGY_INFLUENCE.RIPARIAN) * .62],
    [9, .30 + environment.fertility * .42 + weight(GEO_MORPHOLOGY_INFLUENCE.UPLAND) * .16],
    [5, .08 + environment.fertility * .22 + (1 - environment.urban) * .08],
    [2, .03 + weight(GEO_MORPHOLOGY_INFLUENCE.ARID) * .24],
  ], selector);
  if (role !== 'canopy') throw new RangeError(`Unknown morphology placement role: ${role}`);
  return weightedChoice([
    [0, .24 + weight(GEO_MORPHOLOGY_INFLUENCE.SUBTROPICAL) * .58 +
      weight(GEO_MORPHOLOGY_INFLUENCE.TROPICAL) * .36 + weight(GEO_MORPHOLOGY_INFLUENCE.UPLAND) * .22 +
      weight(GEO_MORPHOLOGY_INFLUENCE.RIPARIAN) * .22 + weight(GEO_MORPHOLOGY_INFLUENCE.URBAN) * .18],
    [1, .015 + weight(GEO_MORPHOLOGY_INFLUENCE.TROPICAL) * .42 +
      weight(GEO_MORPHOLOGY_INFLUENCE.RIPARIAN) * .18 + weight(GEO_MORPHOLOGY_INFLUENCE.ARID) * .04],
    [2, .07 + weight(GEO_MORPHOLOGY_INFLUENCE.ARID) * .48 +
      weight(GEO_MORPHOLOGY_INFLUENCE.UPLAND) * .28 + weight(GEO_MORPHOLOGY_INFLUENCE.URBAN) * .16],
    [5, .015 + weight(GEO_MORPHOLOGY_INFLUENCE.ARID) * .05],
    [12, (.006 + weight(GEO_MORPHOLOGY_INFLUENCE.TROPICAL) * .13 +
      weight(GEO_MORPHOLOGY_INFLUENCE.RIPARIAN) * .30) * environment.moisture * (1 - environment.urban * .72)],
  ], selector);
}

/** Continuous environment weights become bounded matrix/palette/variant traits. */
export function resolvePlantMorphology(type, environment, seed = 0, out = {}) {
  if (!validEnvironment(environment) || !PLANT_TYPES.has(type) || !Number.isSafeInteger(seed)) {
    throw new TypeError('Plant morphology requires a supported type, versioned finite environment and safe integer seed');
  }
  const weights = environment.weights;
  const tropical = weights[0], subtropical = weights[1], arid = weights[2];
  const upland = weights[3], riparian = weights[4], urban = weights[5];
  const familyRoll = hashParts(seed, type, 'variant') / 4294967296;
  const aspectRoll = hashParts(seed, type, 'aspect') / 4294967296;
  const ageRoll = hashParts(seed, type, 'age') / 4294967296;
  const paletteRoll = hashParts(seed, type, 'palette') / 4294967296;
  const isCanopy = type === 0 || type === 1 || type === 12;
  const isSmall = type === 5 || type === 8 || type === 9;
  let width = 1 + tropical * .07 + riparian * .10 + arid * (isCanopy ? .10 : .05) -
    upland * .07 - urban * (isCanopy ? .14 : .06);
  let height = 1 + tropical * .08 + subtropical * .03 + upland * .13 - arid * .12 - urban * .04;
  if (type === 1) { width += tropical * .05; height += tropical * .08 + riparian * .04; }
  if (type === 2) { width += arid * .10; height -= arid * .08 + urban * .04; }
  if (type === 12) { width -= urban * .10; height += riparian * .08; }
  if (isSmall) height += environment.moisture * .08 - arid * .07;
  const micro = (aspectRoll - .5) * .10;
  const asymmetry = (hashParts(seed, type, 'asymmetry') / 4294967296 - .5) * (isSmall ? .08 : .14);
  out.scaleX = clamp(width + micro + asymmetry, GEO_MORPHOLOGY_SCALE_MIN, GEO_MORPHOLOGY_SCALE_MAX);
  out.scaleY = clamp(height - micro * .35, GEO_MORPHOLOGY_SCALE_MIN, GEO_MORPHOLOGY_SCALE_MAX);
  out.scaleZ = clamp(width + micro - asymmetry, GEO_MORPHOLOGY_SCALE_MIN, GEO_MORPHOLOGY_SCALE_MAX);
  out.archetypeIndex = familyRoll < clamp(.24 + arid * .34 + upland * .22 + urban * .08, .12, .88) ? 1 : 0;
  out.paletteSlot = Math.max(0, Math.min(7, Math.round(
    environment.temperature * 1.8 + environment.moisture * 2.1 + riparian * 1.2 +
    subtropical * .8 - arid * .7 + paletteRoll * 2,
  )));
  out.age = clamp(.58 + ageRoll * .34 + environment.canopy * .08 - urban * .05, .45, 1);
  out.windStiffness = clamp(.42 + upland * .25 + arid * .18 + urban * .08 -
    environment.moisture * .10 + familyRoll * .12, .28, .94);
  out.profileId0 = environment.topIds[0];
  out.profileId1 = environment.topIds[1];
  out.profileId2 = environment.topIds[2];
  out.profileWeight0 = environment.topWeights[0];
  out.profileWeight1 = environment.topWeights[1];
  out.profileWeight2 = environment.topWeights[2];
  return out;
}

export function encodePlantMorphology(morphology = DEFAULT_MORPHOLOGY, target = [], offset = target.length) {
  if (!morphology || !['scaleX', 'scaleY', 'scaleZ', 'archetypeIndex', 'paletteSlot', 'age',
    'windStiffness', 'profileId0', 'profileId1', 'profileId2',
    'profileWeight0', 'profileWeight1', 'profileWeight2'].every(name => Number.isFinite(morphology[name])) ||
      !Number.isInteger(offset) || offset < 0 || !target || typeof target.length !== 'number') {
    throw new TypeError('Finite morphology, target and offset required for quantization');
  }
  const profileIds = [morphology.profileId0, morphology.profileId1, morphology.profileId2];
  const profileWeights = [morphology.profileWeight0, morphology.profileWeight1, morphology.profileWeight2];
  if (![morphology.scaleX, morphology.scaleY, morphology.scaleZ]
      .every(value => value >= GEO_MORPHOLOGY_SCALE_MIN && value <= GEO_MORPHOLOGY_SCALE_MAX) ||
      !Number.isInteger(morphology.archetypeIndex) || morphology.archetypeIndex < 0 || morphology.archetypeIndex > 255 ||
      !Number.isInteger(morphology.paletteSlot) || morphology.paletteSlot < 0 || morphology.paletteSlot > 7 ||
      morphology.age < 0 || morphology.age > 1 || morphology.windStiffness < 0 || morphology.windStiffness > 1 ||
      !profileIds.every(value => Number.isInteger(value) && value >= 0 && value < GEO_MORPHOLOGY_INFLUENCES.length) ||
      new Set(profileIds).size !== GEO_ENVIRONMENT_TOP_INFLUENCES ||
      !profileWeights.every(value => value >= 0 && value <= 1) ||
      Math.abs(profileWeights.reduce((total, value) => total + value, 0) - 1) >= 1e-4) {
    throw new RangeError('Morphology values exceed the versioned compact contract');
  }
  // Floor keeps the rendered quantized envelope inside the clearance envelope
  // evaluated from the unquantized resolver output.
  const encodeScale = value => Math.floor(clamp((value - GEO_MORPHOLOGY_SCALE_MIN) /
    (GEO_MORPHOLOGY_SCALE_MAX - GEO_MORPHOLOGY_SCALE_MIN)) * 255);
  target[offset] = encodeScale(morphology.scaleX);
  target[offset + 1] = encodeScale(morphology.scaleY);
  target[offset + 2] = encodeScale(morphology.scaleZ);
  target[offset + 3] = Math.max(0, Math.min(255, morphology.archetypeIndex | 0));
  target[offset + 4] = Math.max(0, Math.min(7, morphology.paletteSlot | 0));
  target[offset + 5] = Math.round(clamp(morphology.age) * 255);
  target[offset + 6] = Math.round(clamp(morphology.windStiffness) * 255);
  target[offset + 7] = Math.max(0, Math.min(GEO_MORPHOLOGY_INFLUENCES.length - 1, morphology.profileId0 | 0));
  target[offset + 8] = Math.max(0, Math.min(GEO_MORPHOLOGY_INFLUENCES.length - 1, morphology.profileId1 | 0));
  target[offset + 9] = Math.max(0, Math.min(GEO_MORPHOLOGY_INFLUENCES.length - 1, morphology.profileId2 | 0));
  target[offset + 10] = Math.round(clamp(morphology.profileWeight0) * 255);
  target[offset + 11] = Math.round(clamp(morphology.profileWeight1) * 255);
  target[offset + 12] = Math.max(0, 255 - target[offset + 10] - target[offset + 11]);
  return target;
}

export function decodeMorphologyScale(value) {
  return GEO_MORPHOLOGY_SCALE_MIN + clamp(Number(value) / 255) *
    (GEO_MORPHOLOGY_SCALE_MAX - GEO_MORPHOLOGY_SCALE_MIN);
}

export function createEnvironmentSummary(environment, buildingCount = 0) {
  if (!validEnvironment(environment) || !Number.isInteger(buildingCount) || buildingCount < 0) {
    throw new TypeError('Versioned finite environment sample and building count required');
  }
  const fields = new Uint8Array(GEO_MORPHOLOGY_FIELD_NAMES.length);
  for (let index = 0; index < fields.length; index++) fields[index] = Math.round(clamp(environment[GEO_MORPHOLOGY_FIELD_NAMES[index]]) * 255);
  const topBiomeIds = new Uint8Array(environment.topIds);
  const topBiomeWeights = new Uint8Array(GEO_ENVIRONMENT_TOP_INFLUENCES);
  let used = 0;
  for (let index = 0; index < topBiomeWeights.length - 1; index++) {
    topBiomeWeights[index] = Math.round(environment.topWeights[index] * 255);
    used += topBiomeWeights[index];
  }
  topBiomeWeights[topBiomeWeights.length - 1] = Math.max(0, 255 - used);
  const ground = [0, 0, 0];
  for (let influence = 0; influence < environment.weights.length; influence++) {
    for (let channel = 0; channel < 3; channel++) {
      ground[channel] += environment.weights[influence] * GEO_MORPHOLOGY_INFLUENCES[influence].ground[channel];
    }
  }
  const dominant = GEO_MORPHOLOGY_INFLUENCES[topBiomeIds[0]];
  const secondary = GEO_MORPHOLOGY_INFLUENCES[topBiomeIds[1]];
  return Object.freeze({
    namespace: GDO_VEGETATION_MORPHOLOGY_NAMESPACE,
    fields,
    topBiomeIds,
    topBiomeWeights,
    ground: new Float32Array(ground),
    id: dominant.key,
    label: `${dominant.label}–${secondary.label}${buildingCount > 80 ? ' city' : ''}`,
    buildings: buildingCount,
    fallback: 'latitude-map-water-terrain-v1',
  });
}

export function createMorphologyDiagnostics() {
  return {
    namespace: GDO_VEGETATION_MORPHOLOGY_NAMESPACE,
    samples: 0,
    plants: 0,
    types: {},
    variants: [0, 0],
    influences: GEO_MORPHOLOGY_INFLUENCES.map(influence => ({ key: influence.key, minimum: 1, maximum: 0, total: 0 })),
    scale: { minimum: Infinity, maximum: 0, asymmetric: 0 },
    packing: {
      strideBytes: GEO_MORPHOLOGY_STRIDE,
      profileCount: GEO_ENVIRONMENT_TOP_INFLUENCES,
      weightLevels: 256,
      scaleMinimum: GEO_MORPHOLOGY_SCALE_MIN,
      scaleMaximum: GEO_MORPHOLOGY_SCALE_MAX,
    },
    capEvents: {},
  };
}

export function recordMorphologyDiagnostics(diagnostics, environment, type = null, morphology = null) {
  if (!diagnostics || diagnostics.namespace !== GDO_VEGETATION_MORPHOLOGY_NAMESPACE ||
      !environment || environment.namespace !== GDO_VEGETATION_MORPHOLOGY_NAMESPACE) return;
  diagnostics.samples++;
  for (let index = 0; index < environment.weights.length; index++) {
    const record = diagnostics.influences[index], value = environment.weights[index];
    record.minimum = Math.min(record.minimum, value);
    record.maximum = Math.max(record.maximum, value);
    record.total += value;
  }
  if (type == null || !morphology) return;
  diagnostics.plants++;
  diagnostics.types[type] = (diagnostics.types[type] || 0) + 1;
  diagnostics.variants[morphology.archetypeIndex & 1]++;
  diagnostics.scale.minimum = Math.min(diagnostics.scale.minimum,
    morphology.scaleX, morphology.scaleY, morphology.scaleZ);
  diagnostics.scale.maximum = Math.max(diagnostics.scale.maximum,
    morphology.scaleX, morphology.scaleY, morphology.scaleZ);
  diagnostics.scale.asymmetric += Number(Math.abs(morphology.scaleX - morphology.scaleZ) > .005);
}

export function finalizeMorphologyDiagnostics(diagnostics, capEvents = {}) {
  if (!diagnostics || diagnostics.namespace !== GDO_VEGETATION_MORPHOLOGY_NAMESPACE) {
    throw new TypeError('Versioned morphology diagnostics required');
  }
  diagnostics.types = Object.freeze({ ...diagnostics.types });
  diagnostics.variants = Object.freeze([...diagnostics.variants]);
  diagnostics.influences = Object.freeze(diagnostics.influences.map(record => Object.freeze({
    key: record.key,
    minimum: record.minimum,
    maximum: record.maximum,
    mean: diagnostics.samples ? record.total / diagnostics.samples : 0,
  })));
  diagnostics.scale = Object.freeze({
    minimum: Number.isFinite(diagnostics.scale.minimum) ? diagnostics.scale.minimum : 1,
    maximum: diagnostics.scale.maximum || 1,
    asymmetric: diagnostics.scale.asymmetric,
  });
  diagnostics.packing = Object.freeze({ ...diagnostics.packing });
  diagnostics.capEvents = Object.freeze({ ...capEvents });
  return Object.freeze(diagnostics);
}
