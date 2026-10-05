import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GDO_FEATURE_VERSIONS } from '../engine/FeatureVersions.js';
import { compileGeoFixture } from './GeoFixtures.js';
import { GeoWorld } from './GeoWorld.js';
import { createWaterDomain } from './GeoWaterDomains.js';
import {
  GDO_VEGETATION_MORPHOLOGY_NAMESPACE,
  GEO_ENVIRONMENT_TOP_INFLUENCES,
  GEO_MORPHOLOGY_INFLUENCE,
  GEO_MORPHOLOGY_INFLUENCES,
  GEO_MORPHOLOGY_SCALE_MAX,
  GEO_MORPHOLOGY_SCALE_MIN,
  GEO_MORPHOLOGY_STRIDE,
  createEnvironmentSummary,
  decodeMorphologyScale,
  encodePlantMorphology,
  environmentWorldCoordinates,
  resolvePlantMorphology,
  sampleVegetationEnvironment,
  selectMorphologyPlantType,
} from './PlantMorphology.js';

const EMPTY_WATER = createWaterDomain();
const EMPTY_OBSTACLES = Object.freeze({ buildings: Object.freeze([]), roads: Object.freeze([]) });
const request = Object.freeze({
  tileX: 0,
  tileY: 0,
  originX: 0,
  originY: 0,
  tileSize: 100,
  latitude: 28.9845,
  longitude: 77.7064,
});

function sample(options = {}) {
  return sampleVegetationEnvironment({
    request: options.request ?? request,
    x: options.x ?? 50,
    z: options.z ?? 50,
    terrainSeed: options.terrainSeed ?? 123,
    waterDomain: options.waterDomain ?? EMPTY_WATER,
    obstacles: options.obstacles ?? EMPTY_OBSTACLES,
    mappedLandKind: options.mappedLandKind ?? '',
  });
}

function profile(weights, fields = {}) {
  const topIds = [...weights.keys()].sort((a, b) => weights[b] - weights[a] || a - b).slice(0, 3);
  return {
    namespace: GDO_VEGETATION_MORPHOLOGY_NAMESPACE,
    weights: new Float32Array(weights),
    topIds: new Uint8Array(topIds),
    topWeights: new Float32Array(topIds.map(id => weights[id] /
      topIds.reduce((total, candidate) => total + weights[candidate], 0))),
    geographic: { absoluteX: 1_000, absoluteZ: 2_000 },
    temperature: fields.temperature ?? .55,
    moisture: fields.moisture ?? .50,
    seasonality: fields.seasonality ?? .50,
    elevation: fields.elevation ?? .50,
    ruggedness: fields.ruggedness ?? .50,
    riparian: fields.riparian ?? .10,
    canopy: fields.canopy ?? .35,
    fertility: fields.fertility ?? .50,
    human: fields.human ?? .10,
    urban: fields.urban ?? .05,
  };
}

function applyCompilation(world, tile, compilation) {
  const common = { type: 'tile-phase', requestId: tile.requestId, key: tile.key, bytes: 1024, provider: 'fixture' };
  world._handleWorkerMessage({ ...common, phase: 'roads', geometry: compilation.roads });
  world._handleWorkerMessage({ ...common, phase: 'context', context: compilation.context });
  world._handleWorkerMessage({ ...common, phase: 'buildings', geometry: compilation.buildings });
}

test('VEG-08 defines six versioned artistic influences and compact dominant-three transfer', () => {
  assert.equal(GDO_FEATURE_VERSIONS.vegetationMorphology, 1);
  assert.equal(GEO_MORPHOLOGY_INFLUENCES.length, 6);
  assert.deepEqual(GEO_MORPHOLOGY_INFLUENCES.map(value => value.key),
    ['tropical', 'subtropical', 'arid', 'upland', 'riparian', 'urban']);
  assert.equal(GEO_ENVIRONMENT_TOP_INFLUENCES, 3);
  assert.equal(GEO_MORPHOLOGY_STRIDE, 13);

  const environment = sample();
  const summary = createEnvironmentSummary(environment, 3);
  assert.equal(summary.namespace, GDO_VEGETATION_MORPHOLOGY_NAMESPACE);
  assert.equal(summary.fields.constructor, Uint8Array);
  assert.equal(summary.topBiomeIds.length, 3);
  assert.equal(summary.topBiomeWeights.reduce((total, value) => total + value, 0), 255);
  assert.equal(summary.fallback, 'latitude-map-water-terrain-v1');
  assert.equal(summary.ground.constructor, Float32Array);
});

test('absolute macro fields interpolate across source-tile edges without tile identity seams', () => {
  const leftRequest = { ...request, tileX: 0 };
  const rightRequest = { ...request, tileX: 1 };
  const exactLeft = sample({ request: leftRequest, x: 100, z: 43 });
  const exactRight = sample({ request: rightRequest, x: 100, z: 43 });
  assert.deepEqual([...exactLeft.weights], [...exactRight.weights]);
  assert.deepEqual([...exactLeft.topIds], [...exactRight.topIds]);

  const before = sample({ request: leftRequest, x: 99.99, z: 43 });
  const after = sample({ request: rightRequest, x: 100.01, z: 43 });
  for (let index = 0; index < before.weights.length; index++) {
    assert.ok(Math.abs(before.weights[index] - after.weights[index]) < .002, `continuous influence ${index}`);
  }
  const geographic = environmentWorldCoordinates({ ...request, originX: 27 }, -2_650, 0);
  assert.equal(geographic.absoluteX, 50);
});

test('latitude, mapped land, water, terrain and human evidence produce bounded profile responses', () => {
  const tropical = sample({ request: { ...request, latitude: 7 }, mappedLandKind: 'forest' });
  const arid = sample({ request: { ...request, latitude: 27 }, mappedLandKind: 'sand' });
  const upland = sample({ request: { ...request, latitude: 68 }, mappedLandKind: 'forest' });
  const wet = sample({
    waterDomain: createWaterDomain({ waterPolygons: [[[
      [45, 45], [55, 45], [55, 55], [45, 55],
    ]]] }),
    mappedLandKind: 'wetland',
  });
  const urban = sample({
    obstacles: {
      buildings: [{ minX: 48, minZ: 48, maxX: 52, maxZ: 52, rings: [[
        [48, 48], [52, 48], [52, 52], [48, 52],
      ]] }],
      roads: [[45, 50, 55, 50, .4, 0]],
    },
    mappedLandKind: 'residential',
  });
  assert.ok(tropical.weights[GEO_MORPHOLOGY_INFLUENCE.TROPICAL] >
    arid.weights[GEO_MORPHOLOGY_INFLUENCE.TROPICAL]);
  assert.ok(arid.weights[GEO_MORPHOLOGY_INFLUENCE.ARID] >
    tropical.weights[GEO_MORPHOLOGY_INFLUENCE.ARID]);
  assert.ok(upland.weights[GEO_MORPHOLOGY_INFLUENCE.UPLAND] >
    tropical.weights[GEO_MORPHOLOGY_INFLUENCE.UPLAND]);
  assert.equal(wet.riparian, 1);
  assert.equal(wet.topIds[0], GEO_MORPHOLOGY_INFLUENCE.RIPARIAN);
  assert.equal(urban.topIds[0], GEO_MORPHOLOGY_INFLUENCE.URBAN);
  for (const environment of [tropical, arid, upland, wet, urban]) {
    assert.ok([...environment.weights].every(value => value >= 0 && value <= 1));
    assert.ok(Math.abs(environment.weights.reduce((total, value) => total + value, 0) - 1) < 1e-6);
  }
});

test('shared profile weights correlate family, variant, aspect, palette, age and stiffness', () => {
  const arid = profile([0, 0, 1, 0, 0, 0], { moisture: .1, temperature: .9 });
  const upland = profile([0, 0, 0, 1, 0, 0], { ruggedness: 1, elevation: 1 });
  const riparian = profile([0, 0, 0, 0, 1, 0], { moisture: 1, riparian: 1 });
  const aridPlant = resolvePlantMorphology(0, arid, 91);
  const uplandPlant = resolvePlantMorphology(0, upland, 91);
  assert.ok(aridPlant.scaleY < uplandPlant.scaleY);
  assert.ok(aridPlant.scaleX > uplandPlant.scaleX);
  assert.notEqual(aridPlant.scaleX, aridPlant.scaleZ);
  assert.ok(Number.isInteger(aridPlant.paletteSlot) && aridPlant.paletteSlot >= 0 && aridPlant.paletteSlot <= 7);
  assert.ok(aridPlant.age >= 0 && aridPlant.age <= 1);
  assert.ok(aridPlant.windStiffness >= 0 && aridPlant.windStiffness <= 1);

  const canopyTypes = new Set(Array.from({ length: 256 }, (_, seed) =>
    selectMorphologyPlantType('canopy', riparian, seed)));
  assert.ok(canopyTypes.has(12), 'riparian/tropical blends expose the cached bamboo family');
  assert.ok([...canopyTypes].every(type => [0, 1, 2, 5, 12].includes(type)));
});

test('morphology quantization stays bounded, deterministic and conservative for clearance', () => {
  const environment = sample({ mappedLandKind: 'forest' });
  const first = resolvePlantMorphology(0, environment, 4242);
  const repeated = resolvePlantMorphology(0, environment, 4242);
  assert.deepEqual(first, repeated);
  const packed = new Uint8Array(GEO_MORPHOLOGY_STRIDE);
  encodePlantMorphology(first, packed, 0);
  for (let axis = 0; axis < 3; axis++) {
    const decoded = decodeMorphologyScale(packed[axis]);
    assert.ok(decoded >= GEO_MORPHOLOGY_SCALE_MIN && decoded <= GEO_MORPHOLOGY_SCALE_MAX);
    assert.ok(decoded <= [first.scaleX, first.scaleY, first.scaleZ][axis] + 1e-12,
      'quantization cannot expand beyond the evaluated clearance envelope');
  }
  assert.ok(packed[3] <= 1);
  assert.ok(packed[4] <= 7);
  assert.ok(packed.slice(7, 10).every(value => value < GEO_MORPHOLOGY_INFLUENCES.length));
  assert.equal(packed.slice(10, 13).reduce((total, value) => total + value, 0), 255);
});

test('malformed, non-finite and unversioned morphology inputs fail closed', () => {
  assert.throws(() => environmentWorldCoordinates({}, 0, 0), TypeError);
  assert.throws(() => sampleVegetationEnvironment({
    request, x: Number.NaN, z: 0, terrainSeed: 0, waterDomain: EMPTY_WATER, obstacles: EMPTY_OBSTACLES,
  }), TypeError);
  assert.throws(() => sampleVegetationEnvironment({
    request, x: 0, z: 0, terrainSeed: Number.NaN, waterDomain: EMPTY_WATER, obstacles: EMPTY_OBSTACLES,
  }), TypeError);
  assert.throws(() => selectMorphologyPlantType('canopy', { namespace: 'old' }, 0), TypeError);
  assert.throws(() => selectMorphologyPlantType('unknown', sample(), 0), RangeError);
  assert.throws(() => resolvePlantMorphology(0, profile([Number.NaN, 0, 0, 0, 0, 0]), 0), TypeError);
  assert.throws(() => encodePlantMorphology({ scaleX: Number.NaN }, []), TypeError);
});

test('fixture integration transfers aligned morphology and remains provider-equivalent', () => {
  const openMapTiles = compileGeoFixture('provider-equivalence', 'openmaptiles');
  const shortbread = compileGeoFixture('provider-equivalence', 'shortbread');
  const context = openMapTiles.context;
  const count = context.decorations.length / context.decorationStride;
  assert.equal(context.decorationMorphologies.constructor, Uint8Array);
  assert.equal(context.decorationMorphologyStride, GEO_MORPHOLOGY_STRIDE);
  assert.equal(context.decorationMorphologies.length, count * GEO_MORPHOLOGY_STRIDE);
  assert.equal(context.morphologyDiagnostics.namespace, GDO_VEGETATION_MORPHOLOGY_NAMESPACE);
  for (let offset = 0; offset < context.decorationMorphologies.length; offset += GEO_MORPHOLOGY_STRIDE) {
    const ids = context.decorationMorphologies.slice(offset + 7, offset + 10);
    const weights = context.decorationMorphologies.slice(offset + 10, offset + 13);
    assert.ok(ids.every(value => value < GEO_MORPHOLOGY_INFLUENCES.length));
    assert.equal(weights.reduce((total, value) => total + value, 0), 255);
  }
  assert.ok(context.morphologyDiagnostics.samples >= context.morphologyDiagnostics.plants);
  assert.ok(context.morphologyDiagnostics.scale.minimum >= GEO_MORPHOLOGY_SCALE_MIN);
  assert.ok(context.morphologyDiagnostics.scale.maximum <= GEO_MORPHOLOGY_SCALE_MAX);
  assert.deepEqual(openMapTiles.context.decorationMorphologies,
    shortbread.context.decorationMorphologies);
  assert.deepEqual(openMapTiles.context.environment.fields, shortbread.context.environment.fields);
  assert.deepEqual(openMapTiles.context.environment.topBiomeIds, shortbread.context.environment.topBiomeIds);
  assert.deepEqual(openMapTiles.context.morphologyDiagnostics, shortbread.context.morphologyDiagnostics);
  const truncated = compileGeoFixture('sparse-rural').context.morphologyDiagnostics;
  assert.equal(truncated.capEvents.groundCover, true);
  assert.deepEqual(truncated.packing, {
    strideBytes: 13, profileCount: 3, weightLevels: 256, scaleMinimum: .72, scaleMaximum: 1.28,
  });
});

test('GeoWorld shares one fixed morphology recipe library and composes nonuniform placements', () => {
  const PreviousWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} removeEventListener() {} postMessage() {} terminate() {} };
  const first = new GeoWorld(new THREE.Scene(), { latitude: 28.98, longitude: 77.70 });
  const second = new GeoWorld(new THREE.Scene(), { latitude: -33.86, longitude: 151.20 });
  try {
    assert.equal(first.plantRenderPools.library, second.plantRenderPools.library);
    assert.equal(first.plantRenderPools.library.environmentKey, GDO_VEGETATION_MORPHOLOGY_NAMESPACE);
    const originalGround = first.groundMaterial.color.clone();
    first._applyBiome({ id: 'test', label: 'Test blend', ground: new Float32Array([.1, .2, .3]) });
    assert.equal(first.groundMaterial.color.equals(originalGround), true, 'focus changes only update the target');
    first._blendEnvironmentGround(100);
    assert.equal(first.groundMaterial.color.equals(originalGround), false);
    const firstBlend = first.groundMaterial.color.clone();
    first._blendEnvironmentGround(150);
    assert.equal(first.groundMaterial.color.equals(firstBlend), true, 'global updates are bounded to 10 Hz');
    const tile = [...first.tiles.values()][0];
    applyCompilation(first, tile, compileGeoFixture('provider-equivalence'));
    first._flushPlantMounts(0);
    const records = first.plantRenderPools.snapshot().records;
    assert.ok(records.length > 0);
    assert.ok(records.some(record => record.scale[0] !== record.scale[1] || record.scale[0] !== record.scale[2]));
    assert.ok(new Set(records.map(record => record.paletteSlot)).size > 1);
    assert.ok(new Set(records.map(record => record.archetypeIndex)).size > 1);
  } finally {
    first.dispose();
    second.dispose();
    globalThis.Worker = PreviousWorker;
  }
});
