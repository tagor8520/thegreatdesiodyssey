import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  SOURCE_ZOOM,
  MAP_SCALE,
  EARTH_CIRCUMFERENCE_METRES,
  coordinateToTileFraction,
  tileFractionToCoordinate,
  tileSizeInGameUnits,
  createGeoReference,
  worldToCoordinate,
  validateCoordinate,
} from './GeoMath.js';
import { roadStyle, buildRoadGeometry, buildBuildingGeometry } from './GeoTileBuilder.js';
import { buildContextData } from './GeoTileContext.js';
import { GDO_VEGETATION_MORPHOLOGY_NAMESPACE } from './PlantMorphology.js';
import { GEO_BUILDING_DETAIL_LIMITS } from './GeoBuildingGrammar.js';
import { createGeoFixture } from './GeoFixtures.js';
import {
  GeoWorld,
  GEO_STREAMING_LIMITS,
  buildCollisionGrid,
  buildRoadSupportGrid,
  circleIntersectsFootprint,
} from './GeoWorld.js';
import { createProceduralLightRig, createWaterNormalTexture } from '../engine/ProceduralEngine.js';
import { GEO_BUILDING_QUERY_MASK, GEO_QUERY_MASK } from './GeoCollision.js';
import {
  GEO_SUPPORT_ROLE,
  GEO_SUPPORT_SLOT_STRIDE,
  appendPackedSupportSlots,
  claimPackedSupportSlot,
  findPackedSupportSlot,
  generateRoofSupportSlots,
  rectangleFitsSupport,
  releasePackedSupportSlot,
} from './GeoSupportSlots.js';
import {
  compileObjectRecipe,
  createObjectRecipe,
  createRoofTankRecipe,
} from './GeoObjectRecipe.js';
import {
  GEO_TERRAIN_DEFAULTS,
  buildTerrainGrid,
  queryTerrainSupport,
  resolveGroundTransition,
  terrainHeightAt,
  terrainSeedForCoordinate,
} from './GeoTerrain.js';
import {
  GDO_FEATURE_VERSIONS,
  GDO_GENERATOR_VERSION,
  featureAvailable,
  featureNamespace,
} from '../engine/FeatureVersions.js';
import {
  GEO_GENERATION_STAGE,
  GEO_LAYER,
  GEO_RENDER_BAND,
  GEO_SURFACE_Y,
  GEO_TRANSPORT_LEVEL,
  landSurfaceY,
  resolveTransportLevel,
  transportSurfaceY,
} from './GeoLayers.js';

const point = (x, y) => ({ x, y });
const layer = (...features) => ({ length: features.length, feature: index => features[index] });
const request = Object.freeze({ tileX: 0, tileY: 0, originX: 0, originY: 0, tileSize: 100 });

function lineFeature(properties = {}) {
  return {
    type: 2, extent: 4096, properties,
    loadGeometry: () => [[point(0, 0), point(4096, 0)]],
  };
}

function lineBetween(first, second, properties = {}) {
  return {
    type: 2, extent: 4096, properties,
    loadGeometry: () => [[point(...first), point(...second)]],
  };
}

function buildingFeature(properties = {}) {
  return {
    type: 3, extent: 4096, properties,
    loadGeometry: () => [[point(0, 0), point(4096, 0), point(4096, 4096), point(0, 4096), point(0, 0)]],
  };
}

function pointFeature(properties = {}) {
  return {
    type: 1, extent: 4096, properties,
    loadGeometry: () => [[point(2048, 2048)]],
  };
}

test('shared procedural visual primitives are deterministic and disposable', () => {
  const first = createWaterNormalTexture(8, 3);
  const second = createWaterNormalTexture(8, 3);
  assert.deepEqual([...first.image.data], [...second.image.data]);
  assert.equal(first.repeat.x, 3);
  const scene = new THREE.Scene();
  const rig = createProceduralLightRig(scene, { shadows: false, scale: .1 });
  assert.ok(scene.children.includes(rig.sun));
  rig.dispose(); first.dispose(); second.dispose();
  assert.ok(!scene.children.includes(rig.sun));
});

test('feature versions provide stable namespaces and explicit unavailable schemas', () => {
  assert.equal(featureNamespace('collision'), `gdo:collision:v${GDO_FEATURE_VERSIONS.collision}`);
  assert.equal(featureAvailable('mapTile'), true);
  assert.equal(featureAvailable('terrain'), true);
  assert.equal(featureAvailable('qualityFixture'), true);
  assert.equal(featureAvailable('diagnostics'), true);
  assert.equal(featureAvailable('objectGrammar'), true);
  assert.equal(featureAvailable('saveSchema'), false);
  assert.equal(featureAvailable('vegetationGrammar'), true);
  assert.equal(featureAvailable('vegetationGeometry'), true);
  assert.equal(featureAvailable('vegetationLod'), true);
  assert.equal(featureAvailable('vegetationRender'), true);
  assert.equal(featureAvailable('waterDomain'), true);
  assert.equal(featureAvailable('vegetationClearance'), true);
  assert.ok(GDO_GENERATOR_VERSION.includes('vegetationGrammar@1'));
  assert.ok(GDO_GENERATOR_VERSION.includes('vegetationGeometry@1'));
  assert.ok(GDO_GENERATOR_VERSION.includes('vegetationLod@1'));
  assert.ok(GDO_GENERATOR_VERSION.includes('vegetationRender@1'));
  assert.ok(GDO_GENERATOR_VERSION.includes('waterDomain@2'));
  assert.ok(GDO_GENERATOR_VERSION.includes('objectGrammar@2'));
  assert.ok(GDO_GENERATOR_VERSION.includes('streetFurniture@1'));
  assert.ok(GDO_GENERATOR_VERSION.includes('vegetationClearance@1'));
  assert.ok(GDO_GENERATOR_VERSION.includes('vegetationWind@1'));
  assert.throws(() => featureNamespace('not-a-feature'), RangeError);
});

test('semantic geo layers keep generation, surface, render and query roles separate', () => {
  assert.ok(GEO_GENERATION_STAGE.ROADS < GEO_GENERATION_STAGE.BUILDINGS);
  assert.equal(GEO_LAYER.water.surfaceY, GEO_SURFACE_Y.WATER);
  assert.equal(GEO_LAYER.water.renderBand, GEO_RENDER_BAND.TRANSPARENT_WATER);
  assert.equal(GEO_LAYER.water.queryMask, 0, 'visual water must not become a solid proxy implicitly');
  assert.ok((GEO_LAYER.building.queryMask & GEO_QUERY_MASK.SOLID_PLAYER) !== 0);
  assert.ok((GEO_LAYER.building.queryMask & GEO_QUERY_MASK.CAMERA_BLOCKER) !== 0);
  assert.equal(landSurfaceY(0), GEO_SURFACE_Y.LAND_BASE);
  assert.equal(landSurfaceY(3), GEO_SURFACE_Y.LAND_BASE + GEO_SURFACE_Y.LAND_STEP * 3);
});

test('Web Mercator projection round-trips coordinates and preserves local origin', () => {
  const places = [[0, 0], [28.9845, 77.7064], [-33.8688, 151.2093], [84.9, -179.9]];
  for (const [latitude, longitude] of places) {
    const tile = coordinateToTileFraction(latitude, longitude);
    const result = tileFractionToCoordinate(tile.x, tile.y);
    assert.ok(Math.abs(result.latitude - latitude) < 1e-8);
    assert.ok(Math.abs(result.longitude - longitude) < 1e-8);
    const reference = createGeoReference(latitude, longitude);
    const origin = worldToCoordinate(reference, 0, 0);
    assert.ok(Math.abs(origin.latitude - latitude) < 1e-8);
    assert.ok(Math.abs(origin.longitude - longitude) < 1e-8);
  }
});

test('terrain fallback is deterministic, seam-free, bounded, and exposes support normals', () => {
  const seed = terrainSeedForCoordinate(28.9845, 77.7064);
  assert.equal(seed, terrainSeedForCoordinate(28.9845, 77.7064));
  const samples = [[0,0], [12.5,-7.25], [100,100], [-48,32]].map(([x, z]) => terrainHeightAt(x, z, seed));
  assert.ok(new Set(samples.map(value => value.toFixed(8))).size > 1);
  assert.ok(samples.every(value => value >= GEO_TERRAIN_DEFAULTS.minimumHeight && value <= GEO_TERRAIN_DEFAULTS.maximumHeight));
  assert.ok(GEO_TERRAIN_DEFAULTS.maximumHeight < GEO_SURFACE_Y.WATER, 'fallback terrain keeps mapped water above land');

  const first = buildTerrainGrid({ minX: 0, minZ: 0, maxX: 100, maxZ: 100 }, seed, 16);
  const east = buildTerrainGrid({ minX: 100, minZ: 0, maxX: 200, maxZ: 100 }, seed, 16);
  for (let row = 0; row <= 16; row++) {
    const firstOffset = (row * 17 + 16) * 3;
    const eastOffset = row * 17 * 3;
    assert.deepEqual(
      [...first.positions.slice(firstOffset, firstOffset + 3)],
      [...east.positions.slice(eastOffset, eastOffset + 3)],
    );
    assert.deepEqual(
      [...first.normals.slice(firstOffset, firstOffset + 3)],
      [...east.normals.slice(eastOffset, eastOffset + 3)],
    );
  }
  const support = queryTerrainSupport(4, 9, seed, {});
  assert.ok(Math.abs(Math.hypot(support.normalX, support.normalY, support.normalZ) - 1) < 1e-9);
  assert.equal(support.kind, 'terrain');

  const a = { x: 0, z: 0, y: terrainHeightAt(0, 0, seed) };
  const b = { x: 40, z: 40, y: terrainHeightAt(40, 40, seed) };
  const lower = a.y <= b.y ? a : b, upper = lower === a ? b : a;
  assert.equal(resolveGroundTransition(lower.x, lower.z, upper.x, upper.z, seed, {
    maxStepUp: 0, maxStepDown: 1, maxSlope: Math.PI,
  }, {}).reason, 'step-up');
  assert.equal(resolveGroundTransition(upper.x, upper.z, lower.x, lower.z, seed, {
    maxStepUp: 1, maxStepDown: 0, maxSlope: Math.PI,
  }, {}).reason, 'drop');
});

test('GeoWorld resolves terrain, ground roads, and bridge decks without collapsing support levels', () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} removeEventListener() {} postMessage() {} terminate() {} };
  const world = new GeoWorld(new THREE.Scene(), { latitude: 28.9845, longitude: 77.7064 });
  try {
    const tile = [...world.tiles.values()][0];
    const sharedNoise = world.materialLibrary.textures.surfaceNoise;
    for (const material of [world.groundMaterial, world.roadMaterial, world.landMaterial,
      world.buildingMaterial, world.decorationMaterial]) {
      assert.equal(material.userData.gdoSemanticMaterial.uniforms.gdoSurfaceNoise.value, sharedNoise);
    }
    assert.equal(world.waterMaterial.uniforms.uSurfaceNoise.value, sharedNoise);
    assert.equal(world.waterMaterial.uniforms.uWaterNormal.value, world.materialLibrary.textures.waterNormal);
    const terrainY = terrainHeightAt(0, 0, world.terrainSeed);
    tile.roadSupportSegments = new Float32Array([
      -1, 0, terrainY + GEO_SURFACE_Y.ROAD, 1, 0, terrainY + GEO_SURFACE_Y.ROAD, .5, 0,
      -1, 0, terrainY + GEO_SURFACE_Y.BRIDGE_DECK, 1, 0, terrainY + GEO_SURFACE_Y.BRIDGE_DECK, .5, 1,
    ]);
    tile.roadSupportStride = 8;
    tile.roadSupportGrid = buildRoadSupportGrid(tile.roadSupportSegments);
    assert.equal(world.supportAt(0, 0, {}).kind, 'bridge');
    const groundLevel = world.supportAt(0, 0, {}, { referenceY: terrainY });
    assert.equal(groundLevel.kind, 'road');
    assert.ok(Math.abs(groundLevel.y - (terrainY + GEO_SURFACE_Y.ROAD)) < 1e-6);
    const bridgeLevel = world.supportAt(0, 0, {}, { referenceY: terrainY + GEO_SURFACE_Y.BRIDGE_DECK });
    assert.equal(bridgeLevel.kind, 'bridge');
    const transition = world.resolveGroundStep(0, .6, 0, 0, { referenceY: terrainHeightAt(0, .6, world.terrainSeed) }, {});
    assert.equal(transition.accepted, true);
    assert.equal(transition.to.kind, 'road');
    assert.ok(world.queryDiagnostics.supportQueries >= 5);
    const camera = new THREE.Vector3(0, -1, 1);
    const clip = world.clipCamera(new THREE.Vector3(0, .5, 1), camera, .03, {});
    assert.equal(clip.blocked, true);
    assert.ok(camera.y > terrainHeightAt(0, 1, world.terrainSeed));
    assert.ok(world.queryDiagnostics.terrainCameraHits > 0);
  } finally {
    world.dispose(); globalThis.Worker = originalWorker;
  }
});

test('tile size uses latitude-adjusted one-to-ten scale and validation rejects unsafe values', () => {
  assert.equal(tileSizeInGameUnits(0), EARTH_CIRCUMFERENCE_METRES / 2 ** SOURCE_ZOOM * MAP_SCALE);
  assert.ok(tileSizeInGameUnits(60) < tileSizeInGameUnits(0));
  assert.throws(() => validateCoordinate(90, 0), RangeError);
  assert.throws(() => validateCoordinate(0, 181), RangeError);
  assert.throws(() => validateCoordinate('not-a-number', 0), TypeError);
});

/**
 * `MAP-08` — one semantic adapter covers OpenMapTiles and Shortbread classes and
 * levels.
 *
 * The `provider-equivalence` fixture carries the same real-world content tagged
 * in each provider's **native vocabulary**: roads use OpenMapTiles `class` versus
 * Shortbread `kind`, and the Shortbread building carries no height field at all.
 * A single adapter must therefore collapse both vocabularies to one semantic
 * model. Comparing output is the only way to show that, and reusing one set of
 * tags under two layer names would prove nothing — which is why the fixture is
 * written per-variant.
 */
test('provider vocabularies normalize to identical semantic geometry', () => {
  const compile = variant => {
    const fixture = createGeoFixture('provider-equivalence', variant);
    const roads = buildRoadGeometry(fixture.vectorTile, request);
    const buildings = buildBuildingGeometry(fixture.vectorTile, request);
    const context = buildContextData(fixture.vectorTile, request);
    const buildingHeights = [];
    const buildingFootprintXZ = [];
    for (let index = 0; index < buildings.positions.length; index += 3) {
      buildingFootprintXZ.push(buildings.positions[index], buildings.positions[index + 2]);
      buildingHeights.push(buildings.positions[index + 1]);
    }
    return {
      roadFeatures: roads.meta.features,
      roadKinds: roads.positions.length,
      roadPositions: [...roads.positions],
      roadIndices: [...roads.indices],
      buildingFeatures: buildings.meta.features,
      buildingFootprintXZ,
      buildingHeights,
      buildingColliders: [...buildings.colliders],
      water: [...context.water.positions],
      land: [...context.land.positions],
      waterClasses: [...(context.waterDomain?.waterClasses ?? [])],
      waterVertices: [...(context.waterDomain?.waterVertices ?? [])],
    };
  };

  const openMapTiles = compile('openmaptiles');
  const shortbread = compile('shortbread');

  // Guard the guard: the fixture must actually produce geometry, or every
  // comparison below would pass vacuously on empty arrays.
  assert.ok(openMapTiles.roadFeatures > 0, 'fixture supplies mapped roads');
  assert.ok(openMapTiles.buildingFeatures > 0, 'fixture supplies mapped buildings');
  assert.ok(openMapTiles.water.length > 0, 'fixture supplies mapped water');
  assert.ok(openMapTiles.buildingColliders.length > 0, 'fixture supplies exact colliders');

  // `class` and `kind` are different tags for the same road class, so the whole
  // ribbon — width, colour, curbs, markings — must match exactly.
  assert.deepEqual(shortbread.roadPositions, openMapTiles.roadPositions, 'road positions');
  assert.deepEqual(shortbread.roadIndices, openMapTiles.roadIndices, 'road indices');

  // Horizontal geometry is map-derived and must agree exactly.
  assert.deepEqual(shortbread.buildingFootprintXZ, openMapTiles.buildingFootprintXZ, 'building footprints');
  assert.deepEqual(shortbread.buildingColliders, openMapTiles.buildingColliders, 'exact colliders');
  assert.deepEqual(shortbread.water, openMapTiles.water, 'water polygons');
  assert.deepEqual(shortbread.land, openMapTiles.land, 'land cover');
  assert.deepEqual(shortbread.waterClasses, openMapTiles.waterClasses, 'semantic water classes');
  assert.deepEqual(shortbread.waterVertices, openMapTiles.waterVertices, 'water domain vertices');

  // Levels are the one deliberate divergence: Shortbread carries no height field,
  // so `buildingHeight()` falls back to a stable tile-addressed hash. Asserted
  // explicitly so a future change that silently equalizes or randomizes them fails.
  assert.notDeepEqual(shortbread.buildingHeights, openMapTiles.buildingHeights,
    'untagged Shortbread heights use the documented hash fallback, not the OpenMapTiles tag');
  // Base vertices sit on the ground plane, so only the roof heights are positive.
  assert.ok(Math.max(...openMapTiles.buildingHeights) > 0, 'tagged building has height');
  assert.ok(Math.max(...shortbread.buildingHeights) > 0, 'hash-derived building has height');
  assert.ok(openMapTiles.buildingHeights.every(Number.isFinite), 'tagged heights are finite');
  assert.ok(shortbread.buildingHeights.every(Number.isFinite), 'hash heights are finite');
});

test('road builder supports OpenMapTiles and Shortbread schemas with metre-scaled ribbons', () => {
  const openMapTiles = buildRoadGeometry({ layers: { transportation: layer(lineFeature({ class: 'primary' })) } }, request);
  const shortbread = buildRoadGeometry({ layers: { streets: layer(lineFeature({ kind: 'path' })) } }, request);
  assert.equal(openMapTiles.meta.features, 1);
  assert.equal(openMapTiles.meta.segments, 1);
  assert.equal(openMapTiles.supportSegmentStride, 8);
  assert.equal(openMapTiles.supportSegments.length, 8);
  assert.ok(openMapTiles.positions.length > 12, 'major roads include batched curbs and markings');
  assert.ok(openMapTiles.indices.length > 6);
  assert.equal(shortbread.meta.features, 1);
  assert.equal(roadStyle({ class: 'primary' }).width, 1);
  assert.ok(Math.abs(roadStyle({ kind: 'path' }).width - .18) < 1e-12);
  const ribbonWidth = Math.abs(openMapTiles.positions[2] - openMapTiles.positions[5]);
  assert.ok(Math.abs(ribbonWidth - 1) < 1e-6);
});

test('transport levels normalize provider flags and keep physical grades separated', () => {
  const ground = resolveTransportLevel({ layer: 0 });
  const implicitGround = resolveTransportLevel({});
  const bridge = resolveTransportLevel({ bridge: 'yes', layer: '2' });
  const tunnel = resolveTransportLevel({ tunnel: true, level: 3 });
  const brunnelWins = resolveTransportLevel({ bridge: true, brunnel: 'tunnel', layer: 2 });
  const numericTunnel = resolveTransportLevel({ layer: '-2' });

  assert.deepEqual(ground, implicitGround, 'same-grade sources must resolve identically');
  assert.equal(bridge.kind, 'bridge');
  assert.equal(bridge.physicalLevel, 2);
  assert.equal(tunnel.kind, 'tunnel');
  assert.equal(tunnel.physicalLevel, -3);
  assert.equal(brunnelWins.physicalLevel, -2);
  assert.equal(numericTunnel.kind, 'tunnel');
  assert.equal(numericTunnel.physicalLevel, -2);
  assert.equal(transportSurfaceY(0), GEO_SURFACE_Y.ROAD);
  assert.ok(transportSurfaceY(GEO_TRANSPORT_LEVEL.BRIDGE) > GEO_SURFACE_Y.ROAD);
  assert.ok(transportSurfaceY(GEO_TRANSPORT_LEVEL.TUNNEL) < GEO_SURFACE_Y.GROUND);
  assert.equal(GEO_LAYER.tunnelRoad.surfaceY, GEO_SURFACE_Y.TUNNEL_ROAD);
  const groundGeometry = buildRoadGeometry({ layers: { transportation: layer(lineFeature({ class: 'minor' })) } }, request);
  const bridgeGeometry = buildRoadGeometry({ layers: { transportation: layer(lineFeature({ class: 'minor', bridge: true })) } }, request);
  const tunnelGeometry = buildRoadGeometry({ layers: { transportation: layer(lineFeature({ class: 'minor', tunnel: true })) } }, request);
  const terrainY = terrainHeightAt(0, 0, 0);
  assert.equal(groundGeometry.positions[1], Math.fround(terrainY + GEO_SURFACE_Y.ROAD));
  assert.equal(bridgeGeometry.positions[1], Math.fround(terrainY + GEO_SURFACE_Y.BRIDGE_DECK));
  assert.equal(tunnelGeometry.positions[1], Math.fround(terrainY + GEO_SURFACE_Y.TUNNEL_ROAD));

  const geometry = buildRoadGeometry({ layers: { transportation: layer(
    lineFeature({ class: 'primary' }),
    lineFeature({ class: 'primary', bridge: true }),
    lineFeature({ class: 'primary', brunnel: 'tunnel' }),
  ) } }, request);
  assert.deepEqual(
    geometry.meta.transportLevels.levels.map(entry => [entry.kind, entry.physicalLevel, entry.features]),
    [['tunnel', -1, 1], ['ground', 0, 1], ['bridge', 1, 1]],
  );
  assert.equal(geometry.meta.transportLevels.bridgeFeatures, 1);
  assert.equal(geometry.meta.transportLevels.groundFeatures, 1);
  assert.equal(geometry.meta.transportLevels.tunnelFeatures, 1);
});

test('same-grade roads receive one bounded deterministic junction patch while separated grades do not merge', () => {
  const horizontal = lineBetween([0, 2048], [4096, 2048], { class: 'primary' });
  const vertical = lineBetween([2048, 0], [2048, 4096], { class: 'secondary' });
  const merged = buildRoadGeometry({ layers: { transportation: layer(horizontal, vertical) } }, request);
  const repeated = buildRoadGeometry({ layers: { transportation: layer(horizontal, vertical) } }, request);
  assert.equal(merged.meta.junctions, 1);
  assert.equal(merged.meta.junctionsTruncated, false);
  assert.deepEqual([...merged.positions], [...repeated.positions]);
  assert.deepEqual([...merged.indices], [...repeated.indices]);

  const elevated = lineBetween([2048, 0], [2048, 4096], { class: 'secondary', bridge: true });
  const separated = buildRoadGeometry({ layers: { transportation: layer(horizontal, elevated) } }, request);
  assert.equal(separated.meta.junctions, 0);
  assert.equal(merged.positions.length, separated.positions.length + 27, 'one octagonal patch adds nine vertices');

  const dense = [];
  for (let index = 0; index < 36; index++) {
    const coordinate = 48 + index * 112;
    dense.push(lineBetween([0, coordinate], [4096, coordinate], { class: 'minor' }));
    dense.push(lineBetween([coordinate, 0], [coordinate, 4096], { class: 'minor' }));
  }
  const capped = buildRoadGeometry({ layers: { transportation: layer(...dense) } }, request);
  assert.equal(capped.meta.junctions, 1200);
  assert.equal(capped.meta.junctionsTruncated, true);
  assert.equal(capped.supportSegments.length, 72 * capped.supportSegmentStride,
    'junction truncation must not lose the authoritative road-support payload');
});

test('building builder preserves mapped X/Z footprint, emits upward roofs, and creates colliders', () => {
  const openMapTiles = buildBuildingGeometry({ layers: { building: layer(buildingFeature({ render_height: 30 })) } }, request);
  const repeated = buildBuildingGeometry({ layers: { building: layer(buildingFeature({ render_height: 30 })) } }, request);
  const shortbread = buildBuildingGeometry({ layers: { buildings: layer(buildingFeature()) } }, request);
  assert.equal(openMapTiles.meta.features, 1);
  assert.equal(shortbread.meta.features, 1);
  assert.deepEqual([...openMapTiles.colliders], [0, 0, 100, 100]);
  assert.deepEqual([...openMapTiles.collisionRingOffsets], [0, 4]);
  assert.deepEqual([...openMapTiles.collisionPolygonOffsets], [0, 1]);
  assert.deepEqual([...openMapTiles.collisionVertices], [0, 0, 100, 0, 100, 100, 0, 100]);
  assert.equal(openMapTiles.collisionSpans.length, 2);
  const expectedFoundation = (
    terrainHeightAt(0, 0, 0) + terrainHeightAt(100, 0, 0) +
    terrainHeightAt(100, 100, 0) + terrainHeightAt(0, 100, 0)
  ) / 4;
  assert.ok(Math.abs(openMapTiles.collisionSpans[0] - expectedFoundation) < 1e-6);
  assert.ok(openMapTiles.collisionSpans[1] - openMapTiles.collisionSpans[0] >= 3);
  assert.ok(openMapTiles.collisionSpans[1] - openMapTiles.collisionSpans[0] <= 3.14);
  assert.deepEqual([...openMapTiles.collisionMasks], [GEO_BUILDING_QUERY_MASK]);
  assert.equal(openMapTiles.supportSlots.length % GEO_SUPPORT_SLOT_STRIDE, 0);
  assert.equal(openMapTiles.supportSlotStates.length, openMapTiles.supportSlots.length / GEO_SUPPORT_SLOT_STRIDE);
  assert.equal(openMapTiles.meta.supportSlots, openMapTiles.supportSlotStates.length);
  assert.ok(openMapTiles.meta.supportSlots > 0);
  assert.deepEqual([...openMapTiles.supportSlots], [...repeated.supportSlots]);
  assert.deepEqual([...openMapTiles.supportSlotStates], [...repeated.supportSlotStates]);
  assert.ok([...openMapTiles.positions].some((value, index) => index % 3 === 1 &&
    Math.abs(value - (expectedFoundation + 3)) < 1e-5));
  assert.ok((openMapTiles.positions.length + openMapTiles.detailPositions.length) / 3 > 20,
    'mapped footprint should gain batched ordinary or selected roof detail');
  const allBuildingY = [
    ...openMapTiles.positions.filter((_, index) => index % 3 === 1),
    ...openMapTiles.detailPositions.filter((_, index) => index % 3 === 1),
  ];
  assert.ok(Math.max(...allBuildingY) > expectedFoundation + 3);

  const [ia, ib, ic] = openMapTiles.indices;
  const position = openMapTiles.positions;
  const ax = position[ib * 3] - position[ia * 3], az = position[ib * 3 + 2] - position[ia * 3 + 2];
  const bx = position[ic * 3] - position[ia * 3], bz = position[ic * 3 + 2] - position[ia * 3 + 2];
  const crossY = az * bx - ax * bz;
  assert.ok(crossY > 0, 'roof triangle should face upward in Three.js X/Z coordinates');
});

test('DET-04 building integration emits one bounded detail batch without changing authoritative collision', () => {
  const tile = {
    layers: {
      transportation: layer(lineFeature({ class: 'residential' })),
      building: layer(buildingFeature({ render_height: 20 })),
    },
  };
  const detailed = buildBuildingGeometry(tile, request);
  const repeated = buildBuildingGeometry(tile, request);
  const plain = buildBuildingGeometry(tile, { ...request, buildingDetails: false });
  assert.equal(detailed.meta.buildingGrammar.namespace, 'gdo:objectGrammar:v2');
  assert.equal(detailed.meta.buildingGrammar.selectedBuildings, 1);
  assert.equal(detailed.meta.buildingGrammar.roadFacingBuildings, 1);
  assert.ok(detailed.meta.buildingGrammar.boxes > 0);
  assert.ok(detailed.meta.buildingGrammar.boxes <= GEO_BUILDING_DETAIL_LIMITS.boxesPerTile);
  assert.ok(detailed.meta.buildingGrammar.triangles <= GEO_BUILDING_DETAIL_LIMITS.trianglesPerTile);
  assert.ok(detailed.meta.buildingGrammar.bytes <= GEO_BUILDING_DETAIL_LIMITS.bytesPerTile);
  assert.equal(detailed.detailPositions.length, detailed.detailNormals.length);
  assert.equal(detailed.detailPositions.length, detailed.detailColors.length);
  assert.ok(detailed.detailIndices.length > 0 && Math.max(...detailed.detailIndices) < detailed.detailPositions.length / 3);
  assert.deepEqual(detailed.detailPositions, repeated.detailPositions);
  assert.deepEqual(detailed.detailIndices, repeated.detailIndices);
  assert.equal(plain.detailPositions.length, 0);
  for (const field of ['colliders', 'collisionVertices', 'collisionRingOffsets', 'collisionPolygonOffsets',
    'collisionSpans', 'collisionMasks']) {
    assert.deepEqual(detailed[field], plain[field], `${field} must be byte-identical with visual detail disabled`);
  }

  const mappedBuilding = (minimumX, maximumX) => ({
    type: 3,
    extent: 4096,
    properties: {},
    loadGeometry: () => [[
      point(minimumX, 400), point(maximumX, 400), point(maximumX, 1_200), point(minimumX, 1_200), point(minimumX, 400),
    ]],
  });
  const firstBuilding = mappedBuilding(300, 1_000), secondBuilding = mappedBuilding(1_500, 2_400);
  const ordered = buildBuildingGeometry({ layers: {
    transportation: layer(lineFeature({ class: 'residential' })),
    building: layer(firstBuilding, secondBuilding),
  } }, request);
  const reordered = buildBuildingGeometry({ layers: {
    transportation: layer(lineFeature({ class: 'residential' })),
    building: layer(secondBuilding, firstBuilding),
  } }, request);
  assert.deepEqual(ordered.detailPositions, reordered.detailPositions,
    'unrelated provider feature order must not move or restyle footprint-hashed detail');
  assert.deepEqual(ordered.detailColors, reordered.detailColors);
  assert.deepEqual(ordered.detailIndices, reordered.detailIndices);
});

test('building collision uses exact mapped polygons instead of oversized bounding boxes', () => {
  const vertices = new Float32Array([0, 0, 4, 0, 0, 4]);
  const ringOffsets = new Uint32Array([0, 3]);
  const polygonOffsets = new Uint32Array([0, 1]);
  assert.equal(circleIntersectsFootprint(.5, .5, .1, 0, vertices, ringOffsets, polygonOffsets), true);
  assert.equal(circleIntersectsFootprint(3.5, 3.5, .1, 0, vertices, ringOffsets, polygonOffsets), false,
    'empty AABB corner outside a triangular footprint must remain walkable');
  assert.equal(circleIntersectsFootprint(2.04, 2.04, .08, 0, vertices, ringOffsets, polygonOffsets), true,
    'player radius should still touch a real polygon edge');

  const courtyardVertices = new Float32Array([0,0, 10,0, 10,10, 0,10, 2,2, 2,8, 8,8, 8,2]);
  assert.equal(circleIntersectsFootprint(5, 5, .1, 0, courtyardVertices, new Uint32Array([0,4,8]), new Uint32Array([0,2])), false,
    'mapped courtyard holes should remain walkable');
});

test('object recipes keep silhouette, surface, accents, and query proxies independent under budgets', () => {
  const support = {
    id: 7,
    roleMask: GEO_SUPPORT_ROLE.ROOF_DETAIL,
    x: 2,
    y: 3,
    z: 4,
    halfWidth: .4,
    halfDepth: .4,
    yaw: 0,
  };
  const box = (centerX, color) => ({
    centerX, bottom: 3, centerZ: 4, sizeX: .2, sizeY: .2, sizeZ: .2, color,
  });
  const recipe = createObjectRecipe({
    id: 'building:7',
    owner: 'tile:0:0',
    support,
    authoritativeFootprint: 'mapped-building-rings',
    silhouette: [{ id: 'mass', boxes: [box(2, [.4,.3,.2])] }],
    surface: [{ id: 'screen', material: 'jali-mask' }],
    accents: [{ id: 'finial', boxes: [box(2.1, [.8,.5,.1])] }],
    solidProxies: [{ id: 'authored-mass', shape: 'box' }],
    interactionProxies: [{ id: 'inspect', shape: 'sphere' }],
    cameraRoles: [],
  });
  const far = compileObjectRecipe(recipe, { lod: 'far' });
  const near = compileObjectRecipe(recipe, { lod: 'near', maxModules: 3, maxBoxes: 2 });
  assert.equal(far.visualBoxes.length, 1);
  assert.equal(far.materials.length, 0);
  assert.deepEqual(near.visualBoxes.map(item => item.role), ['silhouette', 'accent']);
  assert.deepEqual(near.materials.map(item => item.role), ['surface']);
  assert.equal(near.solidProxies.length, 1, 'visual boxes must never create implicit collision');
  assert.equal(near.interactionProxies.length, 1);
  assert.equal(near.cameraRoles.length, 0);
  assert.ok(Object.isFrozen(recipe) && Object.isFrozen(near.visualBoxes));

  const tank = createRoofTankRecipe({ owner: 'tile:building', support, height: .25, color: [.2,.3,.4] });
  assert.equal(compileObjectRecipe(tank, { lod: 'far' }).visualBoxes.length, 1);
  assert.equal(tank.solidProxies.length, 0);
  assert.throws(() => createRoofTankRecipe({
    owner: 'bad', support: { ...support, roleMask: GEO_SUPPORT_ROLE.ROAD_EDGE }, height: .2, color: [.2,.3,.4],
  }), RangeError);
  assert.throws(() => compileObjectRecipe(recipe, { maxBoxes: -1 }), RangeError);
});

test('support slots are deterministic, concave-safe, and reject occupied capacity', () => {
  const courtyard = [
    [[0,0], [10,0], [10,10], [0,10]],
    [[4,4], [4,6], [6,6], [6,4]],
  ];
  assert.equal(rectangleFitsSupport(courtyard, 2, 2, .4, .4, .1), true);
  assert.equal(rectangleFitsSupport(courtyard, 5, 5, .4, .4, .1), false, 'a courtyard hole cannot support detail');
  assert.equal(rectangleFitsSupport(courtyard, 3.8, 5, .4, .4, .1), false, 'insets cannot straddle a hole edge');

  const first = generateRoofSupportSlots(courtyard, { surfaceY: 3, seed: 42, maxSlots: 4 });
  const repeated = generateRoofSupportSlots(courtyard, { surfaceY: 3, seed: 42, maxSlots: 4 });
  assert.deepEqual(first, repeated);
  assert.ok(first.length > 1);
  assert.ok(first.every(slot => rectangleFitsSupport(
    courtyard, slot.x, slot.z, slot.halfWidth, slot.halfDepth, .05,
  )));

  const packed = new Float32Array(appendPackedSupportSlots([], first));
  const states = new Uint8Array(first.length);
  const selected = findPackedSupportSlot(packed, states, {
    nearX: first[0].x,
    nearZ: first[0].z,
    halfWidth: .08,
    halfDepth: .08,
    roleMask: GEO_SUPPORT_ROLE.ROOF_DETAIL,
  });
  assert.ok(selected);
  states[selected.index] = 1;
  const replacement = claimPackedSupportSlot(packed, states, {
    nearX: first[0].x,
    nearZ: first[0].z,
    halfWidth: .08,
    halfDepth: .08,
    roleMask: GEO_SUPPORT_ROLE.ROOF_DETAIL,
  });
  assert.ok(replacement && replacement.index !== selected.index, 'occupied support must be rejected');
  assert.equal(states[replacement.index], 2);
  assert.equal(releasePackedSupportSlot(states, replacement.index), true);
  assert.equal(states[replacement.index], 0);
  assert.equal(releasePackedSupportSlot(states, selected.index), false, 'authored occupancy cannot be released as a runtime claim');
  assert.equal(findPackedSupportSlot(packed, states, { halfWidth: 100, halfDepth: 100 }), null);
  assert.throws(() => findPackedSupportSlot(packed, states, { maxDistance: Number.NaN }), RangeError);
});

test('GeoWorld claims and releases tile-owned support slots without arbitrary fallback', () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} removeEventListener() {} postMessage() {} terminate() {} };
  const world = new GeoWorld(new THREE.Scene(), { latitude: 28.99, longitude: 77.71 });
  try {
    const tile = [...world.tiles.values()][0];
    tile.supportSlots = new Float32Array([
      2, 3, 4, .3, .3, 0, GEO_SUPPORT_ROLE.ROOF_DETAIL, 123,
    ]);
    tile.supportSlotStates = new Uint8Array([0]);
    tile.supportSlotStride = GEO_SUPPORT_SLOT_STRIDE;
    const claimed = world.claimSupportSlot(2, 4, { halfWidth: .2, halfDepth: .2, maxDistance: 1 });
    assert.ok(claimed);
    assert.equal(claimed.tileKey, tile.key);
    assert.equal(world.claimSupportSlot(2, 4, { halfWidth: .2, halfDepth: .2, maxDistance: 1 }), null);
    assert.equal(world.releaseSupportSlot(claimed), true);
    assert.ok(world.findSupportSlot(2, 4, { halfWidth: .2, halfDepth: .2, maxDistance: 1 }));
    assert.equal(world.findSupportSlot(2, 4, { halfWidth: .4, halfDepth: .4, maxDistance: 1 }), null);
    assert.equal(world.queryDiagnostics.placementClaims, 1);
    assert.equal(world.queryDiagnostics.placementRejects, 1);
    assert.equal(world.queryDiagnostics.placementReleases, 1);
    assert.equal(world.stats.supportSlots, 1);
  } finally {
    world.dispose(); globalThis.Worker = originalWorker;
  }
});

test('map context deterministically builds land, water, vegetation, biome and map names', () => {
  const tile = {
    layers: {
      land: layer(buildingFeature({ kind: 'forest' })),
      water_polygons: layer({
        ...buildingFeature({ kind: 'lake', name: 'Suraj Kund' }),
        loadGeometry: () => [[point(1024, 1024), point(3072, 1024), point(3072, 3072), point(1024, 3072), point(1024, 1024)]],
      }),
      place_labels: layer(pointFeature({ kind: 'city', name: 'Meerut' })),
      water_polygons_labels: layer(pointFeature({ kind: 'lake', name: 'Suraj Kund' })),
      transportation: layer(lineFeature({ class: 'primary', name: 'Delhi Road' })),
      building: layer({
        ...buildingFeature(),
        loadGeometry: () => [[point(1900, 1900), point(2200, 1900), point(2200, 2200), point(1900, 2200), point(1900, 1900)]],
      }),
    },
  };
  const contextRequest = { ...request, latitude: 28.98, longitude: 77.7 };
  const first = buildContextData(tile, contextRequest);
  const second = buildContextData(tile, contextRequest);
  assert.equal(first.land.meta.features, 1);
  assert.equal(first.water.meta.features, 1);
  assert.ok(first.water.positions.length > 0);
  assert.ok(first.decorations.length > 0);
  for (let index = 0; index < first.decorations.length; index += 6) {
    const x = first.decorations[index], z = first.decorations[index + 1], type = first.decorations[index + 3];
    if ([0, 1, 2, 4, 5, 8, 9].includes(type)) {
      assert.ok(!(x > 46.16 && x < 53.94 && z > 46.16 && z < 53.94), 'plants must stay outside mapped building walls');
    }
  }
  assert.deepEqual([...first.decorations], [...second.decorations]);
  assert.equal(first.biome.id, 'riparian');
  assert.equal(first.environment.namespace, GDO_VEGETATION_MORPHOLOGY_NAMESPACE);
  assert.deepEqual(first.biome, first.environment);
  assert.equal(first.environment.topBiomeWeights.reduce((total, value) => total + value, 0), 255);
  assert.ok(first.labels.some(label => label.name === 'Meerut' && label.kind === 'place'));
  assert.ok(first.labels.some(label => label.name === 'Suraj Kund' && label.kind === 'water'));
});

test('sparse rural tiles receive reproducible open-ground details and source-road names', () => {
  const tile = {
    layers: {
      transportation: layer(lineFeature({ class: 'tertiary', name: 'Baghpat Road' })),
      building: layer({
        ...buildingFeature({ render_height: 12 }),
        loadGeometry: () => [[point(1900, 1900), point(2200, 1900), point(2200, 2200), point(1900, 2200), point(1900, 1900)]],
      }),
    },
  };
  const contextRequest = { ...request, latitude: 28.99, longitude: 77.71 };
  const result = buildContextData(tile, contextRequest);
  const repeated = buildContextData(tile, contextRequest);
  assert.equal(result.biome.id, 'urban', 'the tile-centre building is a local modifier, not a hard family enum');
  assert.ok([...result.environment.topBiomeIds].includes(1), 'subtropical fallback remains in the dominant blend');
  assert.ok(result.decorations.length >= 6 * 200, 'unmapped open ground should receive dense ground cover');
  assert.deepEqual([...result.decorations], [...repeated.decorations]);
  assert.equal(result.streetFurniture.namespace, 'gdo:streetFurniture:v1');
  assert.ok(result.streetFurniture.meta.placements > 0);
  assert.deepEqual(result.streetFurniture.placements, repeated.streetFurniture.placements);
  assert.ok(result.streetFurniture.meta.bytes <= 1_536);
  assert.ok(result.labels.some(label => label.name === 'Baghpat Road'));
  const types = [...result.decorations].filter((_, index) => index % 6 === 3);
  assert.ok(types.some(type => [0, 2, 4, 5].includes(type)));
  assert.ok(types.some(type => type === 8 || type === 9), 'herbs or tall grass should fill open patches');
  assert.ok(types.includes(10), 'birds should be generated');
  assert.ok(types.includes(11), 'bees should spawn around plant anchors');
});

test('OpenMapTiles context layers select mapped arid biome without random drift', () => {
  const tile = {
    layers: {
      landcover: layer(buildingFeature({ class: 'sand' }), buildingFeature({ class: 'bare_rock' })),
      place: layer(pointFeature({ class: 'village', name: 'Jaisalmer Fringe' })),
    },
  };
  const result = buildContextData(tile, { ...request, latitude: 26.9, longitude: 70.9 });
  assert.equal(result.biome.id, 'arid');
  assert.equal(result.biome.ground.constructor, Float32Array);
  assert.ok(result.biome.ground[0] > result.biome.ground[2] * 2,
    'the continuous arid blend remains visibly warm without snapping to one prototype');
  assert.equal(result.labels[0].name, 'Jaisalmer Fringe');
});

test('context phase mounts fallback ambience even when map surfaces are empty', () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} removeEventListener() {} postMessage() {} terminate() {} };
  const world = new GeoWorld(new THREE.Scene(), { latitude: 28.99, longitude: 77.71 });
  try {
    const tile = [...world.tiles.values()][0];
    const empty = {
      positions: new Float32Array(), normals: new Float32Array(), colors: new Float32Array(), indices: new Uint32Array(), meta: { features: 0 },
    };
    world._handleWorkerMessage({
      type: 'tile-phase', phase: 'context', key: tile.key, requestId: tile.requestId,
      context: {
        land: empty, water: empty,
        decorations: new Float32Array([
          5, 5, 1, 6, 0, 0,
          6, 6, 1, 10, .3, 2,
          7, 7, 1, 11, .5, 1,
        ]), decorationStride: 6,
        labels: [{ name: 'Baghpat Road', x: 5, z: 5, kind: 'street', priority: 32 }],
        biome: { id: 'subtropical', label: 'Indo-Gangetic', ground: [.18, .31, .10] },
      },
    });
    assert.equal(tile.decorationCount, 3);
    assert.ok(tile.decorations.some(mesh => mesh.name === `benches:${tile.key}`));
    const bird = tile.decorations.find(mesh => mesh.name === `birds:${tile.key}`);
    assert.ok(bird && tile.decorations.some(mesh => mesh.name === `bees:${tile.key}`));
    const before = new THREE.Matrix4(), after = new THREE.Matrix4();
    bird.getMatrixAt(0, before);
    world._animateAmbientLife(3);
    bird.getMatrixAt(0, after);
    assert.notDeepEqual(before.elements, after.elements, 'ambient fauna should animate as bounded instances');
    assert.equal(world.stats.biome, 'Indo-Gangetic');
    assert.equal(world.visibleLabels[0].name, 'Baghpat Road');
  } finally {
    world.dispose(); globalThis.Worker = originalWorker;
  }
});

test('coordinate plant records mount in global owner pools and release exactly on tile eviction', () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} removeEventListener() {} postMessage() {} terminate() {} };
  const scene = new THREE.Scene();
  const world = new GeoWorld(scene, { latitude: 28.99, longitude: 77.71 });
  try {
    const tile = [...world.tiles.values()][0];
    const empty = {
      positions: new Float32Array(), normals: new Float32Array(), colors: new Float32Array(), indices: new Uint32Array(), meta: { features: 0 },
    };
    const contextMessage = {
      type: 'tile-phase', phase: 'context', key: tile.key, requestId: tile.requestId,
      context: {
        land: empty, water: empty,
        decorations: new Float32Array([
          5, 5, 1, 0, .25, 0,
          6, 6, .8, 8, .5, 1,
          7, 7, 1, 6, 0, 0,
        ]),
        decorationStride: 6,
        labels: [],
        biome: { id: 'subtropical', label: 'Indo-Gangetic', ground: [.18, .31, .10] },
      },
    };
    world._handleWorkerMessage(contextMessage);
    assert.equal(world.plantRenderPools.diagnostics.entries, 0, 'optional upload yields beyond the worker message');
    assert.equal(world.plantMountTimer, null, 'plant compilation is not scheduled before the usable buildings phase');
    assert.equal(world._flushPlantMounts(0, true), 2);
    assert.equal(world.plantRenderPools.diagnostics.owners, 1);
    assert.equal(world.plantRenderPools.diagnostics.entries, 2);
    assert.equal(tile.plantPoolCount, 2);
    assert.equal(world.setReducedMotion(true), true, 'the motion preference is recorded even when wind is off');
    assert.equal(world.stats.plantWindReducedMotion, true);
    assert.equal(world.stats.plantWindCpuMatrixUpdates, 0);
    // Wind is opt-in and coordinate mode does not enable it, so its per-vertex
    // cost is absent and configuration is inert rather than half-applied.
    assert.equal(world.plantRenderPools.diagnostics.windEnabled, false);
    assert.equal(world.stats.plantWindUniformWrites, 0);
    assert.equal(world.configurePlantWind({ direction: [1, 0], strength: .4, gustiness: .2 }), false);
    assert.ok(tile.decorations.some(mesh => mesh.name === `benches:${tile.key}`));
    assert.ok(!tile.decorations.some(mesh => /^(trees|herbs):/.test(mesh.name)));
    assert.equal(world.plantRenderPools.group.parent, world.root);
    for (const record of world.plantRenderPools.snapshot().records) assert.equal(record.owner, tile.key);
    const fingerprint = world.plantRenderPools.fingerprint();

    world._handleWorkerMessage(contextMessage);
    world._flushPlantMounts(0, true);
    assert.equal(world.plantRenderPools.fingerprint(), fingerprint, 'same source tile reproduces global pool records');
    world._evictTile(tile);
    assert.equal(world.plantRenderPools.diagnostics.entries, 0);
    assert.equal(world.plantRenderPools.diagnostics.owners, 0);
  } finally {
    world.dispose(); globalThis.Worker = originalWorker;
  }
});

test('collision grid checks cells touched by the player radius', () => {
  const colliders = new Float32Array([3.90, 1, 3.95, 2]);
  const grid = buildCollisionGrid(colliders);
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class {
    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
    terminate() {}
  };
  const world = new GeoWorld(new THREE.Scene(), { latitude: 0, longitude: 0 });
  try {
    const tile = [...world.tiles.values()][0];
    tile.colliders = colliders; tile.collisionGrid = grid;
    assert.equal(world.collidesCircle(4.05, 1.5, .16), true);
    assert.equal(world.collidesCircle(4.2, 1.5, .16), false);
    tile.colliders = new Float32Array([0, 0, 4, 4]);
    tile.collisionVertices = new Float32Array([0, 0, 4, 0, 0, 4]);
    tile.collisionRingOffsets = new Uint32Array([0, 3]);
    tile.collisionPolygonOffsets = new Uint32Array([0, 1]);
    tile.collisionGrid = buildCollisionGrid(tile.colliders);
    assert.equal(world.collidesCircle(.5, .5, .1), true);
    assert.equal(world.collidesCircle(3.5, 3.5, .1), false);
    tile.collisionMasks = new Uint16Array([GEO_QUERY_MASK.PLACEMENT]);
    assert.equal(world.collidesCircle(.5, .5, .1), false, 'query masks must keep placement proxies out of player movement');
    assert.equal(world.collidesCircle(.5, .5, .1, GEO_QUERY_MASK.PLACEMENT), true);
    tile.collisionMasks = new Uint16Array([GEO_BUILDING_QUERY_MASK]);
    tile.collisionSpans = new Float32Array([0, .5]);
    assert.equal(world.collidesCircle(.5, .5, .1, GEO_QUERY_MASK.CAMERA_BLOCKER, .8, 1.2), false,
      'camera queries above a building span must remain clear');
    assert.equal(world.collidesCircle(.5, .5, .1, GEO_QUERY_MASK.CAMERA_BLOCKER, .1, .3), true);
    tile.colliders = new Float32Array([1, -1, 2, 1]);
    tile.collisionVertices = null; tile.collisionRingOffsets = null; tile.collisionPolygonOffsets = null;
    tile.collisionSpans = null; tile.collisionMasks = null;
    tile.collisionGrid = buildCollisionGrid(tile.colliders);
    const camera = new THREE.Vector3(3, .9, 0);
    world.clipCamera(new THREE.Vector3(0, .1, 0), camera);
    assert.ok(camera.x < 1, 'third-person camera should stop before a mapped facade');
  } finally {
    world.dispose(); globalThis.Worker = originalWorker;
  }
});

test('boundary prefetch is capped at four resident tiles and two active requests', () => {
  const originalWorker = globalThis.Worker;
  const posted = [];
  globalThis.Worker = class {
    addEventListener() {}
    removeEventListener() {}
    postMessage(message) { posted.push(message); }
    terminate() {}
  };
  const world = new GeoWorld(new THREE.Scene(), { latitude: 0, longitude: 0 });
  try {
    const size = world.reference.tileSize;
    world.update({ x: size * .95, z: size * .95 });
    assert.equal(world.tiles.size, GEO_STREAMING_LIMITS.maxResidentTiles);
    assert.equal(world.activeRequests, GEO_STREAMING_LIMITS.maxActiveRequests);
    assert.equal(posted.filter(message => message.type === 'load').length, GEO_STREAMING_LIMITS.maxActiveRequests);

    world.update({ x: size * 3.5, z: size * .5 });
    assert.ok(world.tiles.size <= GEO_STREAMING_LIMITS.maxResidentTiles);
    assert.ok(posted.some(message => message.type === 'cancel'));
  } finally {
    world.dispose(); globalThis.Worker = originalWorker;
  }
});
