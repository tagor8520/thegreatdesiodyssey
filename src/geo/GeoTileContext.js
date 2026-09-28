import earcut from 'earcut';
import { classifyRings } from '@mapbox/vector-tile';
import { roadStyle } from './GeoTileBuilder.js';
import {
  GEO_MAP_ROLE, GEO_PLACE_CLASS, describeMapPlace, mapLayersForRole, pickMapLayer,
  resolveLandCoverClass, resolveMapWaterClass, resolveMapWaterKind,
} from './GeoMapSemantics.js';
import { GEO_SURFACE_Y, landSurfaceY } from './GeoLayers.js';
import { terrainHeightAt } from './GeoTerrain.js';
import { compileStreetFurniture } from './GeoStreetFurnitureGrammar.js';
import { compileBridges } from './GeoBridgeGrammar.js';
import {
  GEO_WATER_CLASS,
  GEO_WATER_DOMAIN_LIMITS,
  createWaterDomain,
  queryWaterDomain,
  waterwayRibbonIntersectsPolygons,
} from './GeoWaterDomains.js';
import {
  GEO_DEFAULT_CROWN_ADAPTATION,
  GEO_PLANT_CLEARANCE_STRIDE,
  GEO_PLANT_TYPE_FAMILIES,
  createPlantClearanceDiagnostics,
  evaluatePlantClearance,
  finalizePlantClearanceDiagnostics,
} from './PlantClearance.js';
import {
  GEO_MORPHOLOGY_INFLUENCE,
  GEO_MORPHOLOGY_STRIDE,
  createEnvironmentSummary,
  createMorphologyDiagnostics,
  encodePlantMorphology,
  finalizeMorphologyDiagnostics,
  recordMorphologyDiagnostics,
  resolvePlantMorphology,
  sampleVegetationEnvironment,
  selectMorphologyPlantType,
} from './PlantMorphology.js';

// Vertex colours are authored in linear space for Three.js color management.
const LAND_COLORS = Object.freeze({
  forest: [0.07, 0.17, 0.05], wood: [0.07, 0.17, 0.05],
  park: [0.17, 0.34, 0.11], garden: [0.20, 0.38, 0.12],
  grass: [0.19, 0.34, 0.11], grassland: [0.19, 0.33, 0.10], meadow: [0.24, 0.38, 0.12],
  farmland: [0.33, 0.34, 0.10], farmyard: [0.34, 0.25, 0.10], orchard: [0.11, 0.27, 0.07],
  scrub: [0.20, 0.23, 0.08], heath: [0.22, 0.17, 0.08],
  beach: [0.58, 0.39, 0.13], sand: [0.58, 0.39, 0.13],
  wetland: [0.05, 0.18, 0.13], swamp: [0.04, 0.15, 0.11], marsh: [0.07, 0.21, 0.13],
  industrial: [0.18, 0.18, 0.15], commercial: [0.23, 0.18, 0.15],
  residential: [0.20, 0.22, 0.16], cemetery: [0.10, 0.25, 0.12],
  default: [0.15, 0.29, 0.10],
});
const WATER_COLOR = Object.freeze([0.008, 0.20, 0.41]);
// `MAP-08`: layer names come from the one semantic adapter, so adding a provider
// spelling is a single-table change instead of a new scattered probe.
const LAND_LAYER_NAMES = mapLayersForRole(GEO_MAP_ROLE.LAND);
const WATER_POLYGON_NAMES = mapLayersForRole(GEO_MAP_ROLE.WATER_POLYGON);
const WATER_LINE_NAMES = mapLayersForRole(GEO_MAP_ROLE.WATER_LINE);
const LABEL_LAYERS = Object.freeze([
  { names: mapLayersForRole(GEO_MAP_ROLE.PLACE), priority: 90, group: 'place' },
  { names: mapLayersForRole(GEO_MAP_ROLE.WATER_LABEL), priority: 55, group: 'water' },
  { names: ['water_polygons', 'water', 'waterway'], priority: 48, group: 'water' },
  { names: mapLayersForRole(GEO_MAP_ROLE.TRANSPORT_LABEL), priority: 38, group: 'street' },
  // Many z14 providers omit dedicated label layers but retain names on source
  // transportation/land features. They are still map data and make rural tiles useful.
  { names: mapLayersForRole(GEO_MAP_ROLE.TRANSPORT), priority: 32, group: 'street' },
  { names: ['pois', 'poi', 'sites'], priority: 24, group: 'poi' },
  { names: mapLayersForRole(GEO_MAP_ROLE.LAND), priority: 20, group: 'poi' },
]);
const MAX_SURFACE_VERTICES = 48_000;
const MAX_DECORATIONS = 1_340;
const MAX_NATURE_DECORATIONS = 170;
const MAX_GROUND_COVER = 1_100;
const MAX_AMBIENT_LIFE = 30;
const MAX_LABEL_CANDIDATES = 64;

function geometryResult(positions, normals, colors, indices, meta = {}) {
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    meta,
  };
}

function namedLayers(tile, names) {
  return names.map(name => [name, tile.layers[name]]).filter(([, value]) => value);
}

function kindOf(properties = {}) {
  return String(properties.kind || properties.class || properties.subclass || properties.type || properties.landuse || '').toLowerCase();
}

function featureName(properties = {}) {
  return String(properties['name:en'] || properties.name || properties.name_int || properties.ref || '').trim();
}

function pointToWorld(point, extent, request) {
  return [
    (request.tileX + point.x / extent - request.originX) * request.tileSize,
    (request.tileY + point.y / extent - request.originY) * request.tileSize,
  ];
}

function withoutClosingPoint(ring) {
  if (ring.length > 1 && ring[0].x === ring.at(-1).x && ring[0].y === ring.at(-1).y) return ring.slice(0, -1);
  return ring;
}

function addColor(colors, color, count) {
  for (let index = 0; index < count; index++) colors.push(...color);
}

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function random01(seed) {
  let value = seed >>> 0;
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  return (value >>> 0) / 4294967296;
}

function coordinateRandom(x, z, seed) {
  let value = Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(z | 0, 0x5f356495) ^ seed;
  value ^= value >>> 15;
  value = Math.imul(value, 0x2c1b3c6d);
  value ^= value >>> 12;
  return (value >>> 0) / 4294967296;
}

function valueNoise(x, z, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const tx = x - x0, tz = z - z0;
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const first = coordinateRandom(x0, z0, seed) * (1 - sx) + coordinateRandom(x0 + 1, z0, seed) * sx;
  const second = coordinateRandom(x0, z0 + 1, seed) * (1 - sx) + coordinateRandom(x0 + 1, z0 + 1, seed) * sx;
  return first * (1 - sz) + second * sz;
}

// Minecraft-like octave fields create contiguous vegetation patches while the
// jittered lattice keeps individual plants reproducible and evenly distributed.
function octaveNoise(x, z, seed) {
  return (valueNoise(x, z, seed) + valueNoise(x * 2, z * 2, seed ^ 0x85ebca6b) * .5 +
    valueNoise(x * 4, z * 4, seed ^ 0xc2b2ae35) * .25) / 1.75;
}

function colorForLand(kind) {
  if (LAND_COLORS[kind]) return LAND_COLORS[kind];
  for (const [key, color] of Object.entries(LAND_COLORS)) if (kind.includes(key)) return color;
  return LAND_COLORS.default;
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    area += points[previous][0] * points[index][1] - points[index][0] * points[previous][1];
  }
  return Math.abs(area) / 2;
}

function pointInRing(x, z, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, zi] = ring[index], [xj, zj] = ring[previous];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(x, z, rings) {
  return pointInRing(x, z, rings[0]) && !rings.slice(1).some(ring => pointInRing(x, z, ring));
}

function appendPolygon(target, rings, surface, color) {
  const flat = [], holes = [];
  for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
    if (ringIndex) holes.push(flat.length / 2);
    for (const [x, z] of rings[ringIndex]) flat.push(x, z);
  }
  const triangles = earcut(flat, holes, 2);
  const base = target.positions.length / 3;
  for (let index = 0; index < flat.length; index += 2) {
    const y = typeof surface === 'function' ? surface(flat[index], flat[index + 1]) : surface;
    target.positions.push(flat[index], y, flat[index + 1]);
  }
  for (let index = 0; index < flat.length / 2; index++) target.normals.push(0, 1, 0);
  addColor(target.colors, color, flat.length / 2);
  for (let index = 0; index < triangles.length; index += 3) {
    target.indices.push(base + triangles[index], base + triangles[index + 2], base + triangles[index + 1]);
  }
}

function appendWorldRibbonSegment(target, segment, width, y, color) {
  const [x1, z1, x2, z2] = segment;
  const dx = x2 - x1, dz = z2 - z1, length = Math.hypot(dx, dz);
  if (length < 1e-5) return false;
  const px = -dz / length * width / 2, pz = dx / length * width / 2;
  const base = target.positions.length / 3;
  target.positions.push(x1 + px,y,z1 + pz, x1 - px,y,z1 - pz, x2 + px,y,z2 + pz, x2 - px,y,z2 - pz);
  for (let vertex = 0; vertex < 4; vertex++) target.normals.push(0, 1, 0);
  addColor(target.colors, color, 4);
  target.indices.push(base,base + 1,base + 2, base + 2,base + 1,base + 3);
  return true;
}

function environmentAt(clearanceContext, x, z, mappedLandKind) {
  return sampleVegetationEnvironment({
    request: clearanceContext.request,
    x,
    z,
    terrainSeed: clearanceContext.terrainSeed,
    waterDomain: clearanceContext.waterDomain,
    obstacles: clearanceContext.obstacles,
    mappedLandKind,
  });
}

function decorationKind(landKind, environment, seed) {
  const random = random01(seed ^ 0x51f15e);
  if (['sand', 'beach', 'desert', 'bare_rock', 'rock', 'ice', 'shingle'].some(kind => landKind.includes(kind)) && random < .52) return 4;
  if (['scrub', 'heath', 'farmland', 'farmyard'].some(kind => landKind.includes(kind))) {
    return random > .72 ? 4 : random < .18 ? 5 : 2;
  }
  if (['grass', 'grassland', 'meadow'].some(kind => landKind.includes(kind)) && random < .54) {
    return selectMorphologyPlantType('ground-cover', environment, seed);
  }
  return selectMorphologyPlantType('canopy', environment, seed);
}

function addPolygonDecorations(decorations, rings, landKind, seed, clearanceContext) {
  if (decorations.length / 6 >= MAX_NATURE_DECORATIONS) return;
  // Canonical classes first, then spellings a provider may still hand through.
  const decorated = ['forest', 'wood', 'park', 'garden', 'grass', 'grassland', 'meadow', 'orchard', 'scrub', 'heath', 'wetland', 'farmland', 'sand', 'beach', 'ice', 'rock'];
  if (!decorated.some(kind => landKind.includes(kind))) return;
  const outer = rings[0];
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of outer) {
    minX = Math.min(minX, x); minZ = Math.min(minZ, z); maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
  }
  const density = landKind.includes('forest') || landKind.includes('wood') ? .42
    : ['sand', 'beach', 'rock', 'ice'].some(kind => landKind.includes(kind)) ? .025 : .16;
  const requested = Math.min(42, Math.max(1, Math.round(polygonArea(outer) * density)));
  let placed = 0;
  for (let attempt = 0; attempt < requested * 7 && placed < requested && decorations.length / 6 < MAX_NATURE_DECORATIONS; attempt++) {
    const localSeed = seed ^ Math.imul(attempt + 1, 0x9e3779b1);
    const x = minX + (maxX - minX) * random01(localSeed);
    const z = minZ + (maxZ - minZ) * random01(localSeed ^ 0x85ebca6b);
    if (!pointInPolygon(x, z, rings)) continue;
    const environment = environmentAt(clearanceContext, x, z, landKind);
    const type = decorationKind(landKind, environment, localSeed);
    const scale = .75 + random01(localSeed ^ 0xc2b2ae35) * .65;
    const rotation = random01(localSeed ^ 0x27d4eb2f) * Math.PI * 2;
    decorations.push(x, z, scale, type, rotation, localSeed & 0xffff);
    placed++;
  }
}

function labelPosition(feature, request) {
  const geometry = feature.loadGeometry().filter(part => part.length);
  if (!geometry.length) return null;
  if (feature.type === 1) return pointToWorld(geometry[0][0], feature.extent, request);
  if (feature.type === 2) {
    const line = geometry.reduce((longest, candidate) => candidate.length > longest.length ? candidate : longest, geometry[0]);
    return pointToWorld(line[Math.floor(line.length / 2)], feature.extent, request);
  }
  const points = geometry.flat();
  let x = 0, z = 0;
  for (const point of points) {
    const world = pointToWorld(point, feature.extent, request); x += world[0]; z += world[1];
  }
  return [x / points.length, z / points.length];
}

function labelPriority(base, properties) {
  // `MAP-08`: OpenMapTiles publishes `rank`/`labelrank` where Shortbread publishes
  // `population`; the adapter turns both into one canonical place class and rank.
  const place = describeMapPlace(properties);
  if (place.placeClass === GEO_PLACE_CLASS.CITY || place.placeClass === GEO_PLACE_CLASS.CAPITAL) return base + 20;
  if (place.placeClass === GEO_PLACE_CLASS.TOWN) return base + 12;
  if (place.placeClass === GEO_PLACE_CLASS.VILLAGE || place.placeClass === GEO_PLACE_CLASS.SUBURB) return base + 5;
  return base + Math.max(0, 8 - place.rank);
}

function collectLabels(vectorTile, request) {
  const candidates = [], seen = new Set();
  for (const descriptor of LABEL_LAYERS) {
    for (const [layerName, vectorLayer] of namedLayers(vectorTile, descriptor.names)) {
      for (let index = 0; index < vectorLayer.length && candidates.length < MAX_LABEL_CANDIDATES; index++) {
        const feature = vectorLayer.feature(index);
        const name = featureName(feature.properties);
        if (!name || name.length > 48) continue;
        const normalized = name.toLocaleLowerCase();
        if (seen.has(normalized)) continue;
        const position = labelPosition(feature, request);
        if (!position) continue;
        seen.add(normalized);
        candidates.push({
          name,
          x: position[0],
          y: descriptor.group === 'water' ? GEO_SURFACE_Y.WATER
            : terrainHeightAt(position[0], position[1], Number.isFinite(request.terrainSeed) ? request.terrainSeed : 0),
          z: position[1],
          kind: descriptor.group,
          featureKind: kindOf(feature.properties),
          priority: labelPriority(descriptor.priority, feature.properties),
          sourceLayer: layerName,
        });
      }
    }
  }
  return candidates.sort((a, b) => b.priority - a.priority).slice(0, 18);
}

function distanceToSegmentSquared(x, z, segment) {
  const [x1, z1, x2, z2] = segment;
  const dx = x2 - x1, dz = z2 - z1;
  const lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared ? Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / lengthSquared)) : 0;
  const offsetX = x - (x1 + dx * amount), offsetZ = z - (z1 + dz * amount);
  return offsetX * offsetX + offsetZ * offsetZ;
}

function collectObstacles(vectorTile, request) {
  const roads = [], buildings = [];
  let roadTruncated = false, buildingTruncated = false;
  const roadLayer = pickMapLayer(vectorTile.layers, GEO_MAP_ROLE.TRANSPORT)?.layer;
  if (roadLayer) for (let featureIndex = 0; featureIndex < roadLayer.length; featureIndex++) {
    if (roads.length >= 3500) { roadTruncated = true; break; }
    const feature = roadLayer.feature(featureIndex);
    if (feature.type !== 2) continue;
    const style = roadStyle(feature.properties, request.schema);
    const radius = style.width / 2;
    for (const line of feature.loadGeometry()) for (let index = 1; index < line.length; index++) {
      if (roads.length >= 3500) { roadTruncated = true; break; }
      const first = pointToWorld(line[index - 1], feature.extent, request);
      const second = pointToWorld(line[index], feature.extent, request);
      roads.push([first[0], first[1], second[0], second[1], radius, style.transport.physicalLevel]);
    }
  }
  const buildingLayer = pickMapLayer(vectorTile.layers, GEO_MAP_ROLE.BUILDING)?.layer;
  if (buildingLayer) for (let featureIndex = 0; featureIndex < buildingLayer.length; featureIndex++) {
    if (buildings.length >= 1600) { buildingTruncated = true; break; }
    const feature = buildingLayer.feature(featureIndex);
    if (feature.type !== 3) continue;
    for (const polygon of classifyRings(feature.loadGeometry())) {
      const rings = polygon.map(withoutClosingPoint).filter(ring => ring.length >= 3)
        .map(ring => ring.map(point => pointToWorld(point, feature.extent, request)));
      if (rings.length) {
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        for (const [x, z] of rings[0]) {
          minX = Math.min(minX, x); minZ = Math.min(minZ, z);
          maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
        }
        buildings.push({ rings, minX, minZ, maxX, maxZ });
      }
      if (buildings.length >= 1600) { buildingTruncated = true; break; }
    }
  }
  return { roads, buildings, capEvents: { roadSegments: roadTruncated, buildings: buildingTruncated } };
}

function mappedLandKindAt(x, z, polygonRecords) {
  // Later provider layers are generally more specific than broad land cover.
  for (let index = polygonRecords.length - 1; index >= 0; index--) {
    if (pointInPolygon(x, z, polygonRecords[index].rings)) return polygonRecords[index].kind;
  }
  return '';
}

function evaluateDecoration(values, clearanceContext, mappedLandKind, diagnostics) {
  const type = Math.round(values[3]);
  if (GEO_PLANT_TYPE_FAMILIES[type]) {
    const environment = environmentAt(clearanceContext, values[0], values[1], mappedLandKind);
    const morphology = resolvePlantMorphology(type, environment, Math.round(values[5]));
    const result = evaluatePlantClearance({
      type,
      // The largest horizontal morphology axis conservatively declares the
      // actual transformed base/root/crown envelope to VEG-07.
      sourceScale: values[2] * Math.max(morphology.scaleX, morphology.scaleZ),
      x: values[0],
      z: values[1],
      yaw: values[4],
      obstacles: clearanceContext.obstacles,
      waterDomain: clearanceContext.waterDomain,
      terrainSeed: clearanceContext.terrainSeed,
      mappedLandKind,
      diagnostics: diagnostics?.clearance ?? diagnostics,
    });
    recordMorphologyDiagnostics(diagnostics?.morphology, environment,
      result.accepted ? type : null, result.accepted ? morphology : null);
    result.environment = environment;
    result.morphology = morphology;
    return result;
  }
  // Rocks and other non-plant map details keep a small physical footprint. This
  // is intentionally separate from the role-specific vegetation contract.
  const radius = type === 4 ? .12 * values[2] : .06 * values[2];
  const buildingBlocked = clearanceContext.obstacles.buildings.some(building => {
    if (values[0] < building.minX - radius || values[0] > building.maxX + radius ||
        values[1] < building.minZ - radius || values[1] > building.maxZ + radius) return false;
    return pointInPolygon(values[0], values[1], building.rings);
  });
  const routeBlocked = clearanceContext.obstacles.roads.some(segment => segment[5] === 0 &&
    distanceToSegmentSquared(values[0], values[1], segment) < (segment[4] + radius) ** 2);
  const waterBlocked = queryWaterDomain(clearanceContext.waterDomain, values[0], values[1], {}).waterDistance <= radius;
  return { accepted: !buildingBlocked && !routeBlocked && !waterBlocked, adaptation: GEO_DEFAULT_CROWN_ADAPTATION };
}

function fallbackDecorationKind(environment, seed) {
  const random = random01(seed);
  const arid = environment.weights[GEO_MORPHOLOGY_INFLUENCE.ARID];
  const urban = environment.weights[GEO_MORPHOLOGY_INFLUENCE.URBAN];
  if (random < arid * .30 + urban * .08) return 4;
  if (random < .12 + arid * .25) return random < .06 ? 5 : 2;
  return selectMorphologyPlantType('canopy', environment, seed);
}

function addFallbackNature(vectorTile, request, decorations, clearanceContext, polygonRecords, diagnostics, seed) {
  const roadLayer = pickMapLayer(vectorTile.layers, GEO_MAP_ROLE.TRANSPORT)?.layer;
  const roadCandidates = [];
  // Roblox-like readable streets: use map geometry, then line suitable roads with
  // sparse deterministic voxel trees/flowers instead of scattering visual noise.
  if (roadLayer) for (let featureIndex = 0; featureIndex < roadLayer.length && roadCandidates.length < 600; featureIndex++) {
    const feature = roadLayer.feature(featureIndex);
    if (feature.type !== 2) continue;
    const style = roadStyle(feature.properties);
    if (style.transport.physicalLevel !== 0 || style.kind.includes('rail') ||
        ['motorway', 'trunk', 'path', 'footway', 'steps'].includes(style.kind)) continue;
    for (const line of feature.loadGeometry()) for (let index = 1; index < line.length; index++) {
      const [x1, z1] = pointToWorld(line[index - 1], feature.extent, request);
      const [x2, z2] = pointToWorld(line[index], feature.extent, request);
      const dx = x2 - x1, dz = z2 - z1, length = Math.hypot(dx, dz);
      if (length < 2.5) continue;
      const nx = -dz / length, nz = dx / length;
      const spacing = 6.2;
      const count = Math.min(10, Math.floor(length / spacing));
      for (let item = 1; item <= count && roadCandidates.length < 600; item++) {
        const localSeed = seed ^ Math.imul(featureIndex + 1, 0x9e3779b1) ^ Math.imul(item + index, 0x85ebca6b);
        const amount = item / (count + 1), side = (item + featureIndex) % 2 ? 1 : -1;
        const offset = side * (style.width / 2 + .62 + random01(localSeed) * .42);
        const x = x1 + dx * amount + nx * offset, z = z1 + dz * amount + nz * offset;
        if (Math.hypot(x, z) < 3.2) continue;
        const mappedLandKind = mappedLandKindAt(x, z, polygonRecords);
        const environment = environmentAt(clearanceContext, x, z, mappedLandKind);
        const type = fallbackDecorationKind(environment, localSeed);
        const candidate = [x, z, .72 + random01(localSeed ^ 0xc2b2ae35) * .62, type, random01(localSeed ^ 0x27d4eb2f) * Math.PI * 2, localSeed & 0xffff];
        if (!evaluateDecoration(candidate, clearanceContext, mappedLandKind, diagnostics).accepted) continue;
        roadCandidates.push(candidate);
      }
    }
  }
  roadCandidates.sort((first, second) => Math.hypot(first[0], first[1]) - Math.hypot(second[0], second[1]));
  for (const candidate of roadCandidates) {
    if (decorations.length / 6 >= MAX_NATURE_DECORATIONS) break;
    decorations.push(...candidate);
  }

  // Fill genuinely unmapped open ground with a low-density block grid. The grid
  // is stable for the tile and rejected against roads, water, and buildings.
  const tileMinX = (request.tileX - request.originX) * request.tileSize;
  const tileMinZ = (request.tileY - request.originY) * request.tileSize;
  const cells = 15;
  for (let row = 0; row < cells && decorations.length / 6 < MAX_NATURE_DECORATIONS; row++) for (let column = 0; column < cells && decorations.length / 6 < MAX_NATURE_DECORATIONS; column++) {
    const localSeed = seed ^ Math.imul(row + 17, 0x9e3779b1) ^ Math.imul(column + 31, 0x85ebca6b);
    const x = tileMinX + (column + .18 + random01(localSeed) * .64) / cells * request.tileSize;
    const z = tileMinZ + (row + .18 + random01(localSeed ^ 0x27d4eb2f) * .64) / cells * request.tileSize;
    if (Math.hypot(x, z) < 3.2) continue;
    const mappedLandKind = mappedLandKindAt(x, z, polygonRecords);
    const environment = environmentAt(clearanceContext, x, z, mappedLandKind);
    const localDensity = .80 - environment.human * .42 - environment.weights[GEO_MORPHOLOGY_INFLUENCE.ARID] * .18;
    if (random01(localSeed ^ 0x632be59b) > localDensity) continue;
    const type = fallbackDecorationKind(environment, localSeed);
    const baseScale = type === 5 ? .72 : .62;
    const candidate = [x, z, baseScale + random01(localSeed ^ 0xc2b2ae35) * .62, type,
      random01(localSeed ^ 0x165667b1) * Math.PI * 2, localSeed & 0xffff];
    if (!evaluateDecoration(candidate, clearanceContext, mappedLandKind, diagnostics).accepted) continue;
    decorations.push(...candidate);
  }
}

function addGroundCover(request, decorations, clearanceContext, polygonRecords, diagnostics, seed) {
  const tileMinX = (request.tileX - request.originX) * request.tileSize;
  const tileMinZ = (request.tileY - request.originY) * request.tileSize;
  const cells = 52;
  const fieldSeed = hashText('gdo:vegetation-morphology:v1:ground-cover');
  const candidates = [];

  for (let row = 0; row < cells; row++) for (let column = 0; column < cells; column++) {
    const globalX = request.tileX * cells + column;
    const globalZ = request.tileY * cells + row;
    const localSeed = seed ^ Math.imul(globalX, 0x9e3779b1) ^ Math.imul(globalZ, 0x85ebca6b);
    const vegetation = octaveNoise(globalX * .072, globalZ * .072, fieldSeed);
    const x = tileMinX + (column + .12 + random01(localSeed) * .76) / cells * request.tileSize;
    const z = tileMinZ + (row + .12 + random01(localSeed ^ 0x165667b1) * .76) / cells * request.tileSize;
    if (Math.hypot(x, z) < 3.0) continue;
    const mappedLandKind = mappedLandKindAt(x, z, polygonRecords);
    const environment = environmentAt(clearanceContext, x, z, mappedLandKind);
    const arid = environment.weights[GEO_MORPHOLOGY_INFLUENCE.ARID];
    const density = Math.max(.16, Math.min(.76, .28 + environment.moisture * .32 +
      environment.fertility * .25 - arid * .20 - environment.human * .28));
    const chance = Math.min(.92, density * (.48 + vegetation * .82));
    if (random01(localSeed ^ 0x27d4eb2f) > chance) continue;
    const type = selectMorphologyPlantType('ground-cover', environment, localSeed);
    const scale = .62 + random01(localSeed ^ 0xa24baed5) * .76;
    const values = [x, z, scale, type, random01(localSeed ^ 0xc2b2ae35) * Math.PI * 2, localSeed & 0xffff];
    if (!evaluateDecoration(values, clearanceContext, mappedLandKind, diagnostics).accepted) continue;
    candidates.push({ selector: random01(localSeed ^ 0x9fb21c65), values });
  }

  // Sampling the whole tile before applying the cap avoids a row-order bias and
  // guarantees repeatable coverage on both sides of source-tile boundaries.
  const capReached = candidates.length > MAX_GROUND_COVER;
  if (capReached) candidates.sort((first, second) => first.selector - second.selector);
  for (let index = 0; index < Math.min(MAX_GROUND_COVER, candidates.length); index++) decorations.push(...candidates[index].values);
  return capReached;
}

function addAmbientLife(request, decorations, centerEnvironment, seed) {
  const tileMinX = (request.tileX - request.originX) * request.tileSize;
  const tileMinZ = (request.tileY - request.originY) * request.tileSize;
  const anchors = [];
  for (let index = 0; index < decorations.length; index += 6) {
    if ([5, 8, 9].includes(Math.round(decorations[index + 3]))) anchors.push([decorations[index], decorations[index + 1]]);
  }
  anchors.sort((first, second) => Math.hypot(first[0], first[1]) - Math.hypot(second[0], second[1]));
  let added = 0;
  const birdCount = centerEnvironment.urban > .55 ? 5 : 8;
  for (let index = 0; index < birdCount && added < MAX_AMBIENT_LIFE; index++, added++) {
    const localSeed = seed ^ Math.imul(index + 41, 0x9e3779b1);
    const nearbyAnchor = index < Math.min(4, anchors.length) ? anchors[index] : null;
    const x = nearbyAnchor ? nearbyAnchor[0] + (random01(localSeed) - .5) * 2.4 : tileMinX + (.08 + random01(localSeed) * .84) * request.tileSize;
    const z = nearbyAnchor ? nearbyAnchor[1] + (random01(localSeed ^ 0x85ebca6b) - .5) * 2.4 : tileMinZ + (.08 + random01(localSeed ^ 0x85ebca6b) * .84) * request.tileSize;
    decorations.push(
      x,
      z,
      .82 + random01(localSeed ^ 0xc2b2ae35) * .62,
      10,
      random01(localSeed ^ 0x27d4eb2f) * Math.PI * 2,
      localSeed % 5,
    );
  }
  const beeTarget = Math.round(7 + centerEnvironment.moisture * 8);
  for (let index = 0; index < beeTarget && anchors.length && added < MAX_AMBIENT_LIFE; index++, added++) {
    const localSeed = seed ^ Math.imul(index + 97, 0x85ebca6b);
    const anchor = anchors[Math.floor(random01(localSeed) * anchors.length) % anchors.length];
    decorations.push(
      anchor[0] + (random01(localSeed ^ 0xc2b2ae35) - .5) * .48,
      anchor[1] + (random01(localSeed ^ 0x27d4eb2f) - .5) * .48,
      .82 + random01(localSeed ^ 0x165667b1) * .42,
      11,
      random01(localSeed ^ 0xd3a2646c) * Math.PI * 2,
      localSeed % 5,
    );
  }
}

function addLegacyParkedCars(vectorTile, request, decorations, seed) {
  const vectorLayer = pickMapLayer(vectorTile.layers, GEO_MAP_ROLE.TRANSPORT)?.layer;
  if (!vectorLayer || decorations.length / 6 >= MAX_DECORATIONS) return;
  for (let featureIndex = 0; featureIndex < vectorLayer.length && decorations.length / 6 < MAX_DECORATIONS; featureIndex++) {
    const feature = vectorLayer.feature(featureIndex);
    if (feature.type !== 2) continue;
    const style = roadStyle(feature.properties);
    if (style.transport.physicalLevel !== 0 ||
        !['primary', 'secondary', 'tertiary', 'major', 'medium'].includes(style.kind)) continue;
    for (const line of feature.loadGeometry()) {
      for (let index = 1; index < line.length && decorations.length / 6 < MAX_DECORATIONS; index++) {
        const [x1, z1] = pointToWorld(line[index - 1], feature.extent, request);
        const [x2, z2] = pointToWorld(line[index], feature.extent, request);
        const dx = x2 - x1, dz = z2 - z1, length = Math.hypot(dx, dz);
        if (length < 3.2) continue;
        const nx = -dz / length, nz = dx / length;
        const count = Math.min(5, Math.floor(length / 3.2));
        for (let item = 1; item <= count && decorations.length / 6 < MAX_DECORATIONS; item++) {
          if ((item + featureIndex) % 9 !== 0) continue;
          const amount = item / (count + 1), side = (item + featureIndex) % 2 ? 1 : -1;
          const offset = side * Math.max(.13, style.width * .31);
          const scale = .86 + random01(seed ^ featureIndex ^ item) * .22;
          decorations.push(
            x1 + dx * amount + nx * offset,
            z1 + dz * amount + nz * offset,
            scale, 7, Math.atan2(dx, dz), (seed + item) % 4,
          );
        }
      }
    }
  }
}

export function buildContextData(vectorTile, request) {
  const terrainSeed = Number.isFinite(request.terrainSeed) ? request.terrainSeed : 0;
  const land = { positions: [], normals: [], colors: [], indices: [] };
  const water = { positions: [], normals: [], colors: [], indices: [] };
  const polygonRecords = [], waterPolygons = [], waterways = [];
  let landFeatures = 0, waterFeatures = 0, waterwaySegmentsSuppressed = 0;
  let waterwaySegmentsTruncated = false, truncated = false;

  for (const [layerName, vectorLayer] of namedLayers(vectorTile, LAND_LAYER_NAMES)) {
    for (let featureIndex = 0; featureIndex < vectorLayer.length; featureIndex++) {
      const feature = vectorLayer.feature(featureIndex);
      if (feature.type !== 3) continue;
      const kind = resolveLandCoverClass(feature.properties, layerName === 'park' ? 'park' : 'default');
      const polygons = classifyRings(feature.loadGeometry());
      for (const polygon of polygons) {
        const rings = polygon.map(withoutClosingPoint).filter(ring => ring.length >= 3)
          .map(ring => ring.map(point => pointToWorld(point, feature.extent, request)));
        if (!rings.length) continue;
        if (land.positions.length / 3 + rings.reduce((sum, ring) => sum + ring.length, 0) > MAX_SURFACE_VERTICES) { truncated = true; break; }
        // Provider schemas may intentionally overlap broad landuse with a more
        // specific cover/park polygon; tiny deterministic lifts prevent z-fight.
        const surfaceOffset = landSurfaceY(LAND_LAYER_NAMES.indexOf(layerName));
        appendPolygon(land, rings, (x, z) => terrainHeightAt(x, z, terrainSeed) + surfaceOffset, colorForLand(kind));
        polygonRecords.push({ rings, kind, seed: hashText(`${request.tileX}:${request.tileY}:${layerName}:${feature.id ?? featureIndex}`) });
        landFeatures++;
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  const visitedWaterLayers = new Set();
  for (const [layerName, vectorLayer] of namedLayers(vectorTile, WATER_POLYGON_NAMES)) {
    if (visitedWaterLayers.has(vectorLayer)) continue;
    visitedWaterLayers.add(vectorLayer);
    for (let featureIndex = 0; featureIndex < vectorLayer.length; featureIndex++) {
      const feature = vectorLayer.feature(featureIndex);
      if (feature.type !== 3) continue;
      for (const polygon of classifyRings(feature.loadGeometry())) {
        const rings = polygon.map(withoutClosingPoint).filter(ring => ring.length >= 3)
          .map(ring => ring.map(point => pointToWorld(point, feature.extent, request)));
        if (!rings.length || water.positions.length / 3 > MAX_SURFACE_VERTICES) continue;
        appendPolygon(water, rings, GEO_SURFACE_Y.WATER, WATER_COLOR);
        // `MAP-08`: the water domain receives a canonical class name, so a
        // Shortbread `kind:'water'` is the same lake as an OpenMapTiles one.
        waterPolygons.push({
          rings, layerName, kind: resolveMapWaterKind(feature.properties, request.schema),
          properties: feature.properties,
        });
        waterFeatures++;
      }
    }
  }
  for (const [, vectorLayer] of namedLayers(vectorTile, WATER_LINE_NAMES)) {
    for (let featureIndex = 0; featureIndex < vectorLayer.length; featureIndex++) {
      const feature = vectorLayer.feature(featureIndex);
      if (feature.type !== 2) continue;
      const waterClassCode = resolveMapWaterClass(feature.properties, request.schema);
      const width = waterClassCode === GEO_WATER_CLASS.RIVER ? .8
        : waterClassCode === GEO_WATER_CLASS.CANAL ? .5 : .24;
      for (const line of feature.loadGeometry()) for (let index = 1; index < line.length; index++) {
        if (waterways.length >= GEO_WATER_DOMAIN_LIMITS.maxWaterwaySegments) {
          waterwaySegmentsTruncated = true;
          continue;
        }
        const first = pointToWorld(line[index - 1], feature.extent, request);
        const second = pointToWorld(line[index], feature.extent, request);
        const segment = [first[0], first[1], second[0], second[1]];
        waterways.push({
          segment, halfWidth: width / 2, properties: feature.properties,
          kind: resolveMapWaterKind(feature.properties, request.schema),
        });
        if (waterwayRibbonIntersectsPolygons(segment, width, waterPolygons)) {
          waterwaySegmentsSuppressed++;
        } else {
          appendWorldRibbonSegment(water, segment, width, GEO_SURFACE_Y.WATER, WATER_COLOR);
        }
      }
      waterFeatures++;
    }
  }

  const waterDomain = createWaterDomain({
    waterPolygons,
    waterways,
    sourceWaterwaysTruncated: waterwaySegmentsTruncated,
    wetlandPolygons: polygonRecords
      .filter(record => ['wetland', 'swamp', 'marsh'].some(kind => record.kind.includes(kind)))
      .map(record => record.rings),
  });
  const decorations = [];
  const tileSeed = hashText(`gdo:vegetation-morphology:v1:${request.tileX}:${request.tileY}`);
  const obstacles = collectObstacles(vectorTile, request);
  const clearanceContext = { request, obstacles, waterDomain, terrainSeed };
  const tileMinX = (request.tileX - request.originX) * request.tileSize;
  const tileMinZ = (request.tileY - request.originY) * request.tileSize;
  const centerX = tileMinX + request.tileSize * .5;
  const centerZ = tileMinZ + request.tileSize * .5;
  const centerEnvironment = environmentAt(
    clearanceContext, centerX, centerZ, mappedLandKindAt(centerX, centerZ, polygonRecords),
  );
  const buildingLayer = pickMapLayer(vectorTile.layers, GEO_MAP_ROLE.BUILDING)?.layer;
  const environment = createEnvironmentSummary(centerEnvironment, buildingLayer?.length || 0);
  // `biome` remains a backwards-compatible display alias. Plant decisions use
  // point samples and never this source-tile summary.
  const biome = environment;
  const clearanceDiagnostics = createPlantClearanceDiagnostics();
  const morphologyDiagnostics = createMorphologyDiagnostics();
  const generationDiagnostics = { clearance: clearanceDiagnostics, morphology: morphologyDiagnostics };

  const mappedNature = [];
  for (const record of polygonRecords) {
    addPolygonDecorations(mappedNature, record.rings, record.kind, record.seed, clearanceContext);
  }
  for (let index = 0; index < mappedNature.length; index += 6) {
    const candidate = mappedNature.slice(index, index + 6);
    if (evaluateDecoration(candidate, clearanceContext,
      mappedLandKindAt(candidate[0], candidate[1], polygonRecords), generationDiagnostics).accepted) {
      decorations.push(...candidate);
    }
  }
  addFallbackNature(vectorTile, request, decorations,
    clearanceContext, polygonRecords, generationDiagnostics, tileSeed);
  const natureCapReached = decorations.length / 6 >= MAX_NATURE_DECORATIONS;
  const groundCoverCapReached = addGroundCover(request, decorations,
    clearanceContext, polygonRecords, generationDiagnostics, tileSeed);
  addAmbientLife(request, decorations, centerEnvironment, tileSeed);
  // DET-07 will replace this retained baseline with a versioned vehicle grammar.
  addLegacyParkedCars(vectorTile, request, decorations, tileSeed);
  const streetFurniture = compileStreetFurniture(vectorTile, request, {
    buildings: obstacles.buildings,
    buildingsTruncated: obstacles.capEvents.buildings,
    waterDomain,
    decorations: new Float32Array(decorations),
  });
  // DET-08 owns the elevated transport grades that DET-05 deliberately skips.
  const bridges = compileBridges(vectorTile, request);

  const decorationClearances = [];
  const decorationMorphologies = [];
  for (let index = 0; index < decorations.length; index += 6) {
    const type = Math.round(decorations[index + 3]);
    if (!GEO_PLANT_TYPE_FAMILIES[type]) {
      decorationClearances.push(...GEO_DEFAULT_CROWN_ADAPTATION);
      encodePlantMorphology(undefined, decorationMorphologies);
      continue;
    }
    const result = evaluateDecoration(decorations.slice(index, index + 6), clearanceContext,
      mappedLandKindAt(decorations[index], decorations[index + 1], polygonRecords), null);
    const morphology = result.morphology;
    encodePlantMorphology(morphology, decorationMorphologies);
    if (!result.accepted) {
      decorationClearances.push(...GEO_DEFAULT_CROWN_ADAPTATION);
      continue;
    }
    const widest = Math.max(morphology.scaleX, morphology.scaleZ);
    decorationClearances.push(
      result.adaptation[0], result.adaptation[1],
      result.adaptation[2] * widest / morphology.scaleX,
      result.adaptation[3] * widest / morphology.scaleZ,
    );
  }
  const capEvents = {
    natureDecorations: natureCapReached,
    groundCover: groundCoverCapReached,
    totalDecorations: decorations.length / 6 >= MAX_DECORATIONS,
    roadSegments: obstacles.capEvents.roadSegments,
    buildings: obstacles.capEvents.buildings,
    waterDomain: Object.values(waterDomain.meta.capEvents).some(Boolean),
    bridges: Object.values(bridges.meta.capEvents).some(Boolean),
  };
  const diagnostics = finalizePlantClearanceDiagnostics(clearanceDiagnostics, capEvents);
  const finalizedMorphologyDiagnostics = finalizeMorphologyDiagnostics(morphologyDiagnostics, capEvents);

  return {
    land: geometryResult(land.positions, land.normals, land.colors, land.indices, { features: landFeatures, truncated }),
    water: geometryResult(water.positions, water.normals, water.colors, water.indices, {
      features: waterFeatures,
      waterwaySegmentsSuppressed,
      waterClasses: waterDomain.meta.classCounts,
      flowingPolygons: waterDomain.meta.flowingPolygons,
      mappedFlowSegments: waterDomain.meta.mappedFlowSegments,
      overlapPolicy: 'suppress-intersecting-ribbon-v1',
    }),
    waterDomain,
    streetFurniture,
    bridges,
    decorations: new Float32Array(decorations),
    decorationStride: 6,
    decorationClearances: new Float32Array(decorationClearances),
    decorationClearanceStride: GEO_PLANT_CLEARANCE_STRIDE,
    decorationMorphologies: new Uint8Array(decorationMorphologies),
    decorationMorphologyStride: GEO_MORPHOLOGY_STRIDE,
    clearanceDiagnostics: diagnostics,
    morphologyDiagnostics: finalizedMorphologyDiagnostics,
    labels: collectLabels(vectorTile, request),
    biome,
    environment,
  };
}
