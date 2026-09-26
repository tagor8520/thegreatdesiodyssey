import { GDO_FEATURE_VERSIONS, featureNamespace } from '../engine/FeatureVersions.js';
import { buildBuildingGeometry, buildRoadGeometry } from './GeoTileBuilder.js';
import { buildContextData } from './GeoTileContext.js';
import { streetFurnitureRecipes } from './GeoStreetFurnitureGrammar.js';
import { bridgeRecipes, GEO_BRIDGE_FAMILY_NAMES, GEO_BRIDGE_STRIDE } from './GeoBridgeGrammar.js';
import { GEO_BRIDGE_POOL_LIMITS } from './GeoBridgePools.js';
import { GEO_LANDMARK_POOL_LIMITS } from './GeoLandmarkPools.js';
import {
  GDO_AMBIENT_LIFE_SOURCE_TYPES,
  GDO_AMBIENT_LIFE_LIMITS,
  GDO_AMBIENT_LIFE_FAMILIES,
} from '../engine/AmbientLifeMotion.js';
import { buildTerrainGrid, terrainSeedForCoordinate } from './GeoTerrain.js';

export const GEO_FIXTURE_EXTENT = 4096;
export const GEO_FIXTURE_SCHEMA = featureNamespace('qualityFixture');

export const GEO_FIXTURE_MATRIX = Object.freeze([
  Object.freeze({ id: 'dense-urban', category: 'dense', variants: Object.freeze(['openmaptiles']) }),
  Object.freeze({ id: 'sparse-rural', category: 'sparse', variants: Object.freeze(['openmaptiles']) }),
  Object.freeze({ id: 'concave-building', category: 'concave', variants: Object.freeze(['openmaptiles']) }),
  Object.freeze({ id: 'courtyard-hole', category: 'hole', variants: Object.freeze(['openmaptiles']) }),
  Object.freeze({ id: 'stacked-bridge', category: 'bridge', variants: Object.freeze(['openmaptiles']) }),
  Object.freeze({ id: 'mapped-coast', category: 'coast', variants: Object.freeze(['openmaptiles']) }),
  Object.freeze({ id: 'provider-equivalence', category: 'provider-schema', variants: Object.freeze(['openmaptiles', 'shortbread']) }),
]);

const FIXTURE_BY_ID = new Map(GEO_FIXTURE_MATRIX.map(entry => [entry.id, entry]));

function closeRing(points) {
  const ring = points.map(([x, y]) => [x, y]);
  const first = ring[0], last = ring.at(-1);
  if (first && (first[0] !== last?.[0] || first[1] !== last?.[1])) ring.push([...first]);
  return ring;
}

function line(id, points, properties = {}) {
  return { id, type: 2, properties, geometry: [points] };
}

function polygon(id, rings, properties = {}) {
  return { id, type: 3, properties, geometry: rings.map(closeRing) };
}

function marker(id, coordinate, properties = {}) {
  return { id, type: 1, properties, geometry: [[coordinate]] };
}

function denseUrbanLayers() {
  const roads = [];
  for (let index = 0; index < 5; index++) {
    const coordinate = 512 + index * 768;
    roads.push(line(100 + index, [[0, coordinate], [4096, coordinate]], {
      class: index === 2 ? 'primary' : 'secondary', name: `Grid Avenue ${index + 1}`,
    }));
    roads.push(line(200 + index, [[coordinate, 0], [coordinate, 4096]], {
      class: index === 2 ? 'primary' : 'tertiary', name: `Grid Road ${index + 1}`,
    }));
  }
  const buildings = [];
  let id = 1000;
  for (let row = 0; row < 9; row++) for (let column = 0; column < 10; column++) {
    const x = 82 + column * 400, y = 84 + row * 445;
    buildings.push(polygon(id++, [[
      [x, y], [x + 220, y], [x + 220, y + 245], [x, y + 245],
    ]], { class: 'building', render_height: 12 + (row * 7 + column * 5) % 34 }));
  }
  return {
    transportation: roads,
    building: buildings,
    landuse: [polygon(10, [[[0, 0], [4096, 0], [4096, 4096], [0, 4096]]], { class: 'residential' })],
    place: [marker(11, [2048, 2048], { class: 'city', name: 'Fixture Nagar' })],
  };
}

function sparseRuralLayers() {
  return {
    transportation: [line(20, [[0, 3300], [1500, 2600], [4096, 2450]], { class: 'minor', name: 'Village Road' })],
    building: [polygon(21, [[[2920, 720], [3330, 720], [3330, 1120], [2920, 1120]]], { class: 'building' })],
    landuse: [
      polygon(22, [[[0, 0], [2048, 0], [2048, 4096], [0, 4096]]], { class: 'farmland', name: 'Fixture Fields' }),
      polygon(23, [[[2048, 0], [4096, 0], [4096, 4096], [2048, 4096]]], { class: 'meadow' }),
    ],
    place: [marker(24, [3100, 1250], { class: 'village', name: 'Fixture Gaon' })],
  };
}

function concaveLayers() {
  return {
    transportation: [line(30, [[0, 3450], [4096, 3450]], { class: 'residential', name: 'Notch Lane' })],
    building: [polygon(31, [[
      [700, 620], [3260, 620], [3260, 1500], [1800, 1500], [1800, 3100], [700, 3100],
    ]], { class: 'building', render_height: 28 })],
    landuse: [polygon(32, [[[0, 0], [4096, 0], [4096, 4096], [0, 4096]]], { class: 'commercial' })],
  };
}

function courtyardLayers() {
  return {
    transportation: [line(40, [[0, 3500], [4096, 3500]], { class: 'tertiary', name: 'Courtyard Street' })],
    building: [polygon(41, [
      [[500, 450], [3590, 450], [3590, 3200], [500, 3200]],
      [[1450, 1250], [1450, 2450], [2650, 2450], [2650, 1250]],
    ], { class: 'building', render_height: 24 })],
    landuse: [polygon(42, [[[0, 0], [4096, 0], [4096, 4096], [0, 4096]]], { class: 'residential' })],
  };
}

function bridgeLayers() {
  return {
    transportation: [
      line(50, [[0, 2048], [4096, 2048]], { class: 'primary', name: 'Ground Highway' }),
      line(51, [[2048, 0], [2048, 4096]], { class: 'secondary', bridge: true, layer: 1, name: 'Flyover' }),
      line(52, [[0, 0], [4096, 4096]], { class: 'rail', tunnel: true, layer: -1, name: 'Tunnel Rail' }),
    ],
    building: [polygon(53, [[[450, 450], [1050, 450], [1050, 1050], [450, 1050]]], { class: 'building' })],
    landuse: [polygon(54, [[[0, 0], [4096, 0], [4096, 4096], [0, 4096]]], { class: 'grass' })],
  };
}

function coastLayers() {
  return {
    transportation: [line(60, [[0, 2750], [2100, 2450], [4096, 2380]], { class: 'secondary', name: 'Coast Road' })],
    building: [polygon(61, [[[500, 2850], [980, 2850], [980, 3300], [500, 3300]]], { class: 'building' })],
    landuse: [polygon(62, [[[0, 2250], [4096, 2250], [4096, 4096], [0, 4096]]], { class: 'beach', name: 'Fixture Beach' })],
    water: [polygon(63, [[[0, 0], [4096, 0], [4096, 2250], [0, 2250]]], { class: 'ocean', name: 'Fixture Sea' })],
    place: [marker(64, [1120, 3030], { class: 'town', name: 'Fixture Port' })],
  };
}

function providerLayers(variant) {
  const roadLayer = variant === 'shortbread' ? 'streets' : 'transportation';
  const buildingLayer = variant === 'shortbread' ? 'buildings' : 'building';
  const waterLayer = variant === 'shortbread' ? 'water_polygons' : 'water';
  const placeLayer = variant === 'shortbread' ? 'place_labels' : 'place';
  return {
    [roadLayer]: [
      line(70, [[0, 2048], [4096, 2048]], { kind: 'primary', name: 'Schema Road' }),
      line(71, [[3072, 0], [3072, 4096]], { kind: 'secondary', bridge: true, layer: 1, name: 'Schema Bridge' }),
    ],
    [buildingLayer]: [polygon(72, [[[600, 500], [1600, 500], [1600, 1400], [600, 1400]]], {
      class: 'building', render_height: 18,
    })],
    landuse: [polygon(73, [[[0, 0], [4096, 0], [4096, 4096], [0, 4096]]], { class: 'park' })],
    [waterLayer]: [polygon(74, [[[0, 3300], [4096, 3300], [4096, 4096], [0, 4096]]], {
      class: 'lake', name: 'Schema Lake',
    })],
    [placeLayer]: [marker(75, [2200, 1200], { class: 'town', name: 'Schema Town' })],
  };
}

function fixtureLayers(id, variant) {
  if (id === 'dense-urban') return denseUrbanLayers();
  if (id === 'sparse-rural') return sparseRuralLayers();
  if (id === 'concave-building') return concaveLayers();
  if (id === 'courtyard-hole') return courtyardLayers();
  if (id === 'stacked-bridge') return bridgeLayers();
  if (id === 'mapped-coast') return coastLayers();
  if (id === 'provider-equivalence') return providerLayers(variant);
  throw new RangeError(`Unknown geographic fixture: ${id}`);
}

function materializeFeature(specification) {
  const geometry = specification.geometry.map(part => part.map(([x, y]) => Object.freeze({ x, y })));
  return Object.freeze({
    id: specification.id,
    type: specification.type,
    extent: GEO_FIXTURE_EXTENT,
    properties: Object.freeze({ ...specification.properties }),
    loadGeometry: () => geometry,
  });
}

function materializeLayer(specifications) {
  const features = specifications.map(materializeFeature);
  return Object.freeze({ length: features.length, feature: index => features[index] });
}

export function createGeoFixture(id, variant = 'openmaptiles') {
  const descriptor = FIXTURE_BY_ID.get(id);
  if (!descriptor) throw new RangeError(`Unknown geographic fixture: ${id}`);
  if (!descriptor.variants.includes(variant)) throw new RangeError(`Fixture ${id} does not support provider variant ${variant}`);
  const layers = {};
  for (const [name, features] of Object.entries(fixtureLayers(id, variant))) layers[name] = materializeLayer(features);
  return Object.freeze({
    id,
    category: descriptor.category,
    variant,
    schema: GEO_FIXTURE_SCHEMA,
    featureVersions: GDO_FEATURE_VERSIONS,
    vectorTile: Object.freeze({ layers: Object.freeze(layers) }),
  });
}

export function geoFixtureRequest(id, variant = 'openmaptiles') {
  const descriptor = FIXTURE_BY_ID.get(id);
  if (!descriptor || !descriptor.variants.includes(variant)) throw new RangeError(`Invalid fixture request: ${id}/${variant}`);
  const coordinate = id === 'mapped-coast'
    ? { latitude: 15.2993, longitude: 74.1240 }
    : { latitude: 28.9845, longitude: 77.7064 };
  return Object.freeze({
    requestId: 1,
    key: `fixture:${id}:${variant}`,
    tileX: 0,
    tileY: 0,
    originX: 0,
    originY: 0,
    tileSize: 100,
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
    terrainSeed: terrainSeedForCoordinate(coordinate.latitude, coordinate.longitude),
    featureVersions: GDO_FEATURE_VERSIONS,
  });
}

/** Compile the same pure worker phases used by live vector tiles, without network access. */
export function compileGeoFixture(id, variant = 'openmaptiles') {
  const fixture = createGeoFixture(id, variant);
  const request = geoFixtureRequest(id, variant);
  const bounds = { minX: 0, minZ: 0, maxX: request.tileSize, maxZ: request.tileSize };
  return Object.freeze({
    fixture: Object.freeze({ id, category: fixture.category, variant, schema: fixture.schema }),
    request,
    terrain: buildTerrainGrid(bounds, request.terrainSeed),
    roads: buildRoadGeometry(fixture.vectorTile, request),
    context: buildContextData(fixture.vectorTile, request),
    buildings: buildBuildingGeometry(fixture.vectorTile, request),
  });
}

export function geoFixtureTypedViews(compilation) {
  if (!compilation?.fixture || compilation.fixture.schema !== GEO_FIXTURE_SCHEMA) {
    throw new TypeError('A compiled canonical geographic fixture is required');
  }
  const groups = [
    ['terrain', compilation.terrain, ['positions', 'normals', 'indices']],
    ['roads', compilation.roads, ['positions', 'normals', 'colors', 'indices', 'supportSegments']],
    ['land', compilation.context.land, ['positions', 'normals', 'colors', 'indices']],
    ['water', compilation.context.water, ['positions', 'normals', 'colors', 'indices']],
    ['waterDomain', compilation.context.waterDomain, [
      'waterVertices', 'waterRingOffsets', 'waterPolygonOffsets', 'waterBounds', 'waterClasses', 'waterFlowDirections',
      'wetlandVertices', 'wetlandRingOffsets', 'wetlandPolygonOffsets', 'wetlandBounds', 'waterways',
    ]],
    ['streetFurniture', compilation.context.streetFurniture, ['placements']],
    ['bridges', compilation.context.bridges, ['placements']],
    ['context', compilation.context, ['decorations', 'decorationClearances', 'decorationMorphologies']],
    ['environment', compilation.context.environment, ['fields', 'topBiomeIds', 'topBiomeWeights', 'ground']],
    ['buildings', compilation.buildings, [
      'positions', 'normals', 'colors', 'indices', 'detailPositions', 'detailNormals', 'detailColors', 'detailIndices',
      'colliders', 'collisionVertices', 'collisionRingOffsets', 'collisionPolygonOffsets',
      'collisionSpans', 'collisionMasks', 'supportSlots', 'supportSlotStates',
      // DET-09 hero geometry travels in the same buildings phase.
      'landmarkPositions', 'landmarkNormals', 'landmarkColors', 'landmarkIndices',
    ]],
  ];
  const views = [];
  for (const [group, value, fields] of groups) for (const field of fields) {
    const view = value?.[field];
    if (!ArrayBuffer.isView(view) || view instanceof DataView) throw new TypeError(`Fixture output ${group}.${field} is not typed data`);
    views.push(Object.freeze({ name: `${group}.${field}`, view }));
  }
  return Object.freeze(views);
}

function bytesEqual(first, second) {
  if (first.constructor !== second.constructor || first.byteLength !== second.byteLength) return false;
  const a = new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  const b = new Uint8Array(second.buffer, second.byteOffset, second.byteLength);
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function semanticSnapshot(compilation) {
  return JSON.stringify({
    roads: compilation.roads.meta,
    land: compilation.context.land.meta,
    water: compilation.context.water.meta,
    waterDomain: {
      namespace: compilation.context.waterDomain.namespace,
      ...compilation.context.waterDomain.meta,
    },
    clearance: compilation.context.clearanceDiagnostics,
    decorationStride: compilation.context.decorationStride,
    decorationClearanceStride: compilation.context.decorationClearanceStride,
    streetFurniture: compilation.context.streetFurniture.meta,
    labels: compilation.context.labels,
    biome: compilation.context.biome,
    buildings: compilation.buildings.meta,
  });
}

export function geoFixturesByteEquivalent(first, second) {
  const firstViews = geoFixtureTypedViews(first), secondViews = geoFixtureTypedViews(second);
  if (firstViews.length !== secondViews.length) return false;
  for (let index = 0; index < firstViews.length; index++) {
    if (firstViews[index].name !== secondViews[index].name || !bytesEqual(firstViews[index].view, secondViews[index].view)) return false;
  }
  return semanticSnapshot(first) === semanticSnapshot(second);
}

export function geoFixtureFingerprint(compilation) {
  let hash = 2166136261;
  const update = byte => { hash ^= byte; hash = Math.imul(hash, 16777619); };
  for (const { name, view } of geoFixtureTypedViews(compilation)) {
    for (let index = 0; index < name.length; index++) update(name.charCodeAt(index) & 255);
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (const byte of bytes) update(byte);
  }
  const semantic = semanticSnapshot(compilation);
  for (let index = 0; index < semantic.length; index++) update(semantic.charCodeAt(index) & 255);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const DECORATION_TRIANGLES = Object.freeze([36, 72, 24, 36, 36, 48, 48, 84, 144, 72, 144, 144]);
const STREET_FURNITURE_TRIANGLES = Object.freeze(streetFurnitureRecipes().map(record =>
  record.compiled.visualBoxes.length * 12));
const BRIDGE_TRIANGLES = Object.freeze(bridgeRecipes().map(record => record.compiled.visualBoxes.length * 12));
// Fixed pool capacity: merged family geometry plus the resident instance matrices.
const BRIDGE_FIXED_GPU_BYTES = BRIDGE_TRIANGLES.reduce((total, triangles) => total + triangles * 9 * (3 + 3) +
  triangles * 3 * 4, 0) +
  GEO_BRIDGE_FAMILY_NAMES.length * GEO_BRIDGE_POOL_LIMITS.maxEntries * 16 * Float32Array.BYTES_PER_ELEMENT;
function rawTriangles(geometry) { return geometry?.indices?.length ? geometry.indices.length / 3 : 0; }
function typedBytes(value) { return ArrayBuffer.isView(value) && !(value instanceof DataView) ? value.byteLength : 0; }

/** Estimate complete fixture output against the shared low-profile ceilings. */
export function collectGeoFixtureBudgetMetrics(compilation) {
  if (!compilation?.fixture) throw new TypeError('Compiled geographic fixture required');
  const presentDraws = [compilation.terrain, compilation.roads, compilation.context.land,
    compilation.context.water, compilation.buildings]
    .reduce((count, geometry) => count + Number(Boolean(geometry?.indices?.length)), 0) +
    Number(Boolean(compilation.buildings?.detailIndices?.length)) +
    // A hero is one merged, hidden-face-reduced draw for the focused tile.
    Number(Boolean(compilation.buildings?.landmarkIndices?.length));
  const decorationCounts = Array(DECORATION_TRIANGLES.length).fill(0);
  const ambientCounts = [0, 0];
  const decorations = compilation.context.decorations;
  for (let offset = 0; offset + 5 < decorations.length; offset += compilation.context.decorationStride || 6) {
    const type = Math.max(0, Math.min(decorationCounts.length - 1, Math.round(decorations[offset + 3])));
    const family = GDO_AMBIENT_LIFE_SOURCE_TYPES[type];
    if (family) { ambientCounts[GDO_AMBIENT_LIFE_FAMILIES[family].index]++; continue; }
    decorationCounts[type]++;
  }
  const decorationDraws = decorationCounts.reduce((count, value) => count + Number(value > 0), 0);
  const decorationTriangles = decorationCounts.reduce((total, count, type) => total + count * DECORATION_TRIANGLES[type], 0);
  // Ambient sprites are one global 2D draw per family, pruned to the profile cap.
  const ambientKept = ambientCounts.map(count => Math.min(count, GDO_AMBIENT_LIFE_LIMITS.maxInstancesPerFamily));
  const ambientLifeAddedDrawCalls = ambientKept.reduce((count, value) => count + Number(value > 0), 0);
  const ambientLifeVisibleTriangles = ambientKept.reduce((total, count, familyIndex) =>
    total + count * GDO_AMBIENT_LIFE_FAMILIES[familyIndex === 0 ? 'bird' : 'bee'].triangles, 0);
  const ambientLifeInstanceBytes = ambientLifeAddedDrawCalls > 0
    ? GDO_AMBIENT_LIFE_LIMITS.maxInstanceBytes : 0;
  const furnitureCounts = Array(STREET_FURNITURE_TRIANGLES.length).fill(0);
  const furnitureValues = compilation.context.streetFurniture.placements;
  for (let offset = 0; offset + 5 < furnitureValues.length; offset += compilation.context.streetFurniture.stride) {
    const family = Math.max(0, Math.min(furnitureCounts.length - 1, Math.round(furnitureValues[offset + 3])));
    furnitureCounts[family]++;
  }
  const streetFurnitureAddedDrawCalls = furnitureCounts.reduce((count, value) => count + Number(value > 0), 0);
  const bridgeCounts = Array(BRIDGE_TRIANGLES.length).fill(0);
  const bridgeValues = compilation.context.bridges.placements;
  for (let offset = 0; offset + GEO_BRIDGE_STRIDE - 1 < bridgeValues.length; offset += GEO_BRIDGE_STRIDE) {
    const family = Math.max(0, Math.min(bridgeCounts.length - 1, Math.round(bridgeValues[offset + 8])));
    bridgeCounts[family]++;
  }
  const bridgeAddedDrawCalls = bridgeCounts.reduce((count, value) => count + Number(value > 0), 0);
  const bridgeVisibleTriangles = bridgeCounts.reduce((total, count, family) =>
    total + count * BRIDGE_TRIANGLES[family], 0);
  const streetFurnitureVisibleTriangles = furnitureCounts.reduce((total, count, family) =>
    total + count * STREET_FURNITURE_TRIANGLES[family], 0);
  const typedOutputBytes = geoFixtureTypedViews(compilation).reduce((total, item) => total + item.view.byteLength, 0);
  const collisionBytesPerTile = ['colliders', 'collisionVertices', 'collisionRingOffsets', 'collisionPolygonOffsets',
    'collisionSpans', 'collisionMasks', 'supportSlots', 'supportSlotStates']
    .reduce((total, field) => total + typedBytes(compilation.buildings?.[field]), 0);
  const waterDomainBytesPerTile = ['waterVertices', 'waterRingOffsets', 'waterPolygonOffsets', 'waterBounds',
    'waterClasses', 'waterFlowDirections', 'wetlandVertices', 'wetlandRingOffsets', 'wetlandPolygonOffsets',
    'wetlandBounds', 'waterways']
    .reduce((total, field) => total + typedBytes(compilation.context.waterDomain?.[field]), 0);
  return Object.freeze({
    residentTiles: 1,
    activeRequests: 0,
    drawCalls: presentDraws + decorationDraws + streetFurnitureAddedDrawCalls + ambientLifeAddedDrawCalls +
      bridgeAddedDrawCalls,
    triangles: rawTriangles(compilation.terrain) + rawTriangles(compilation.roads) +
      rawTriangles(compilation.context.land) + rawTriangles(compilation.context.water) +
      rawTriangles(compilation.buildings) + compilation.buildings.detailIndices.length / 3 +
      compilation.buildings.landmarkIndices.length / 3 +
      decorationTriangles + streetFurnitureVisibleTriangles + ambientLifeVisibleTriangles +
      bridgeVisibleTriangles,
    buildingDetailBuildings: compilation.buildings.meta.buildingGrammar?.selectedBuildings ?? 0,
    buildingDetailBoxes: compilation.buildings.meta.buildingGrammar?.boxes ?? 0,
    buildingDetailTriangles: compilation.buildings.meta.buildingGrammar?.triangles ?? 0,
    buildingDetailBytesPerTile: compilation.buildings.meta.buildingGrammar?.bytes ?? 0,
    buildingDetailAddedDrawCalls: Number(Boolean(compilation.buildings.detailIndices.length)),
    buildingDetailRoadTestsPerTile: compilation.buildings.meta.buildingGrammar?.roadTests ?? 0,
    streetFurnitureEntries: compilation.context.streetFurniture.meta.placements,
    streetFurnitureFamilies: STREET_FURNITURE_TRIANGLES.length,
    streetFurnitureVisibleTriangles,
    streetFurnitureAddedDrawCalls,
    streetFurnitureBytesPerTile: compilation.context.streetFurniture.meta.bytes,
    streetFurniturePlacementTests: compilation.context.streetFurniture.meta.roadTests +
      compilation.context.streetFurniture.meta.buildingTests + compilation.context.streetFurniture.meta.decorationTests +
      compilation.context.streetFurniture.meta.conflictTests,
    streetFurnitureSteadyFrameMatrixUpdates: 0,
    landmarkCandidatesPerTile: compilation.buildings.meta.landmarkGrammar?.candidates ?? 0,
    landmarkHeroesPerTile: compilation.buildings.meta.landmarkGrammar?.selected ?? 0,
    landmarkBoxesPerTile: compilation.buildings.meta.landmarkGrammar?.boxes ?? 0,
    landmarkTrianglesPerTile: compilation.buildings.meta.landmarkGrammar?.triangles ?? 0,
    landmarkBytesPerTile: compilation.buildings.meta.landmarkGrammar?.bytes ?? 0,
    landmarkVisibleTriangles: compilation.buildings.meta.landmarkGrammar?.triangles ?? 0,
    landmarkAddedDrawCalls: Number(Boolean(compilation.buildings.landmarkIndices.length)),
    landmarkGpuBytes: GEO_LANDMARK_POOL_LIMITS.maxGpuBytes,
    landmarkOpeningsPerTile: compilation.buildings.meta.landmarkGrammar?.openings ?? 0,
    landmarkPassableOpeningsPerTile: compilation.buildings.meta.landmarkGrammar?.passableOpenings ?? 0,
    landmarkStructuralCompounds: compilation.buildings.meta.landmarkGrammar?.structuralCompounds ?? 0,
    landmarkEnclosingCompounds: compilation.buildings.meta.landmarkGrammar?.enclosingCompounds ?? 0,
    landmarkHiddenFaces: compilation.buildings.meta.landmarkGrammar?.hiddenFaces ?? 0,
    landmarkSuppressedVertices: compilation.buildings.meta.landmarkGrammar?.suppressedVertices ?? 0,
    landmarkSteadyFrameMatrixUpdates: 0,
    bridgeSpansPerTile: compilation.context.bridges.meta.spans,
    bridgeSegmentsPerTile: compilation.context.bridges.meta.segments,
    bridgePlacementsPerTile: compilation.context.bridges.meta.placements,
    bridgeRailedSpansPerTile: compilation.context.bridges.meta.railedSpans,
    bridgePiersPerTile: compilation.context.bridges.meta.piers,
    bridgeAddedDrawCalls,
    bridgeVisibleTriangles,
    bridgeBytesPerTile: compilation.context.bridges.meta.bytes,
    bridgeGpuBytes: BRIDGE_FIXED_GPU_BYTES,
    bridgeSteadyFrameMatrixUpdates: 0,
    ambientLifeInstancesPerFamily: ambientKept.reduce((largest, value) => Math.max(largest, value), 0),
    ambientLifeAddedDrawCalls,
    ambientLifeVisibleTriangles,
    ambientLifeInstanceBytes,
    ambientLifeUniformWritesPerFrame: 0,
    ambientLifeCpuMatrixUpdatesPerFrame: 0,
    ambientLifeSteadyFrameAllocations: 0,
    // Includes all generated typed output plus the uploaded instance matrices.
    estimatedGpuBytes: typedOutputBytes +
      ((decorations.length / (compilation.context.decorationStride || 6) -
        ambientKept.reduce((total, value) => total + value, 0)) +
        compilation.context.streetFurniture.meta.placements) * 64 + ambientLifeInstanceBytes,
    collisionBytesPerTile,
    waterDomainBytesPerTile,
  });
}
