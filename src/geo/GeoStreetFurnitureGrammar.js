import { featureNamespace } from '../engine/FeatureVersions.js';
import { roadStyle } from './GeoTileBuilder.js';
import {
  GEO_OBJECT_LOD,
  compileObjectRecipe,
  createObjectRecipe,
} from './GeoObjectRecipe.js';
import { GEO_SUPPORT_ROLE } from './GeoSupportSlots.js';
import { queryWaterDomain } from './GeoWaterDomains.js';

export const GDO_STREET_FURNITURE_NAMESPACE = featureNamespace('streetFurniture');
export const GEO_STREET_FURNITURE_STRIDE = 6;

export const GEO_STREET_FURNITURE_FAMILY = Object.freeze({
  LAMP: 0,
  BENCH: 1,
  BOLLARD: 2,
  BIN: 3,
  SIGN: 4,
  SHELTER: 5,
  UTILITY: 6,
});

export const GEO_STREET_FURNITURE_FAMILY_NAMES = Object.freeze([
  'lamp', 'bench', 'bollard', 'bin', 'sign', 'shelter', 'utility-box',
]);

export const GEO_STREET_FURNITURE_LIMITS = Object.freeze({
  maxSourceFeatures: 4_096,
  maxRoadSegments: 2_048,
  maxRoadCellReferences: 32_768,
  maxBuildingCellReferences: 32_768,
  maxDecorationReferences: 1_340,
  maxCandidates: 512,
  maxPlacementsPerTile: 64,
  maxRoadTestsPerCandidate: 128,
  maxRoadTestsPerTile: 8_192,
  maxBuildingTestsPerTile: 8_192,
  maxDecorationTestsPerTile: 8_192,
  maxConflictTestsPerTile: 8_192,
  maxBoxesPerFamily: 8,
  maxModulesPerFamily: 4,
  cellSize: 8,
  decorationCellSize: 4,
  spacing: 6.4,
  entranceClearance: .72,
  endpointClearance: 1,
  bytesPerTile: 64 * GEO_STREET_FURNITURE_STRIDE * 4,
});

const SUITABLE_ROADS = new Set([
  'primary', 'secondary', 'tertiary', 'major', 'medium', 'minor',
  'unclassified', 'residential', 'street', 'living_street', 'service', 'busway',
]);

const FAMILY_FOOTPRINTS = Object.freeze([
  Object.freeze({ halfWidth: .15, halfDepth: .28 }),
  Object.freeze({ halfWidth: .36, halfDepth: .15 }),
  Object.freeze({ halfWidth: .07, halfDepth: .07 }),
  Object.freeze({ halfWidth: .14, halfDepth: .12 }),
  Object.freeze({ halfWidth: .28, halfDepth: .07 }),
  Object.freeze({ halfWidth: .52, halfDepth: .28 }),
  Object.freeze({ halfWidth: .20, halfDepth: .13 }),
]);

function mix32(value) {
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function hashText(value, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return mix32(hash);
}

function finitePoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function pointToWorld(point, extent, request) {
  return [
    (request.tileX + point.x / extent - request.originX) * request.tileSize,
    (request.tileY + point.y / extent - request.originY) * request.tileSize,
  ];
}

function quantized(value) { return Math.round(value * 4_096); }

function segmentKey(x1, z1, x2, z2, halfWidth, kind) {
  return `${quantized(x1)}:${quantized(z1)}:${quantized(x2)}:${quantized(z2)}:${quantized(halfWidth)}:${kind}`;
}

function cellKey(x, z) { return `${x}:${z}`; }

function pointSegmentDistanceSquared(x, z, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const denominator = dx * dx + dz * dz;
  const amount = denominator > 1e-12
    ? Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / denominator)) : 0;
  const offsetX = x - (x1 + dx * amount), offsetZ = z - (z1 + dz * amount);
  return offsetX * offsetX + offsetZ * offsetZ;
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
  return Array.isArray(rings) && rings.length > 0 && pointInRing(x, z, rings[0]) &&
    !rings.slice(1).some(ring => pointInRing(x, z, ring));
}

function polygonBoundaryDistanceSquared(x, z, rings) {
  if (pointInPolygon(x, z, rings)) return 0;
  let distance = Infinity;
  for (const ring of rings ?? []) for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    distance = Math.min(distance, pointSegmentDistanceSquared(
      x, z, ring[previous][0], ring[previous][1], ring[index][0], ring[index][1],
    ));
  }
  return distance;
}

function visualBounds(modules) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const module of modules) for (const box of module.boxes ?? []) {
    const yaw = box.yaw ?? 0, cosine = Math.cos(yaw), sine = Math.sin(yaw);
    const halfX = Math.abs(cosine) * box.sizeX / 2 + Math.abs(sine) * box.sizeZ / 2;
    const halfZ = Math.abs(sine) * box.sizeX / 2 + Math.abs(cosine) * box.sizeZ / 2;
    minX = Math.min(minX, box.centerX - halfX); maxX = Math.max(maxX, box.centerX + halfX);
    minY = Math.min(minY, box.bottom); maxY = Math.max(maxY, box.bottom + box.sizeY);
    minZ = Math.min(minZ, box.centerZ - halfZ); maxZ = Math.max(maxZ, box.centerZ + halfZ);
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function box(centerX, bottom, centerZ, sizeX, sizeY, sizeZ, color, yaw = 0) {
  return { centerX, bottom, centerZ, sizeX, sizeY, sizeZ, color, yaw };
}

function familyModules(family) {
  if (family === GEO_STREET_FURNITURE_FAMILY.LAMP) return {
    silhouette: [{ id: 'lamp-frame', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [
      box(0, 0, 0, .045, .72, .045, [.035, .045, .035]),
      box(0, .68, -.095, .045, .045, .22, [.035, .045, .035]),
    ] }],
    accents: [{ id: 'lamp-head', minimumLod: GEO_OBJECT_LOD.NEAR, boxes: [
      box(0, .625, -.205, .14, .13, .14, [1, .48, .06]),
    ] }],
  };
  if (family === GEO_STREET_FURNITURE_FAMILY.BENCH) return {
    silhouette: [{ id: 'bench-frame', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [
      box(0, .28, 0, .62, .09, .20, [.30, .12, .035]),
      box(0, .47, .08, .62, .08, .12, [.42, .18, .05]),
      box(-.24, 0, 0, .07, .32, .07, [.08, .05, .025]),
      box(.24, 0, 0, .07, .32, .07, [.08, .05, .025]),
    ] }],
  };
  if (family === GEO_STREET_FURNITURE_FAMILY.BOLLARD) return {
    silhouette: [{ id: 'bollard-post', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [
      box(0, 0, 0, .09, .34, .09, [.10, .11, .105]),
    ] }],
    surface: [{ id: 'bollard-cap', minimumLod: GEO_OBJECT_LOD.MID, boxes: [
      box(0, .33, 0, .12, .04, .12, [.76, .56, .10]),
    ] }],
  };
  if (family === GEO_STREET_FURNITURE_FAMILY.BIN) return {
    silhouette: [{ id: 'bin-body', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [
      box(0, 0, 0, .24, .36, .20, [.06, .20, .11]),
    ] }],
    surface: [{ id: 'bin-lid', minimumLod: GEO_OBJECT_LOD.MID, boxes: [
      box(0, .35, -.012, .27, .055, .23, [.035, .105, .065]),
    ] }],
  };
  if (family === GEO_STREET_FURNITURE_FAMILY.SIGN) return {
    silhouette: [{ id: 'sign-frame', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [
      box(0, 0, 0, .035, .62, .035, [.08, .09, .08]),
      box(0, .42, 0, .50, .19, .035, [.10, .29, .42]),
    ] }],
    accents: [{ id: 'sign-border', minimumLod: GEO_OBJECT_LOD.NEAR, boxes: [
      box(0, .445, -.021, .44, .035, .012, [.73, .74, .66]),
    ] }],
  };
  if (family === GEO_STREET_FURNITURE_FAMILY.SHELTER) return {
    silhouette: [{ id: 'shelter-frame', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [
      box(-.40, 0, .10, .045, .68, .045, [.09, .10, .09]),
      box(.40, 0, .10, .045, .68, .045, [.09, .10, .09]),
      box(0, .66, .06, .94, .055, .40, [.16, .24, .25]),
      box(0, .12, .19, .86, .48, .035, [.15, .24, .24]),
    ] }],
    surface: [{ id: 'shelter-bench', minimumLod: GEO_OBJECT_LOD.MID, boxes: [
      box(0, .20, .05, .58, .08, .18, [.34, .15, .045]),
    ] }],
  };
  if (family === GEO_STREET_FURNITURE_FAMILY.UTILITY) return {
    silhouette: [{ id: 'utility-body', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [
      box(0, 0, 0, .34, .42, .22, [.20, .24, .19]),
    ] }],
    surface: [{ id: 'utility-door', minimumLod: GEO_OBJECT_LOD.MID, boxes: [
      box(0, .055, -.116, .27, .30, .018, [.13, .17, .13]),
    ] }],
  };
  throw new RangeError(`Unknown street-furniture family: ${family}`);
}

/** Compile one shared, local-space street-furniture archetype through DET-02. */
export function createStreetFurnitureRecipe(family) {
  if (!Number.isInteger(family) || family < 0 || family >= GEO_STREET_FURNITURE_FAMILY_NAMES.length) {
    throw new RangeError(`Unknown street-furniture family: ${family}`);
  }
  const modules = familyModules(family);
  const allModules = [...(modules.silhouette ?? []), ...(modules.surface ?? []), ...(modules.accents ?? [])];
  const footprint = FAMILY_FOOTPRINTS[family];
  const recipe = createObjectRecipe({
    id: `${GDO_STREET_FURNITURE_NAMESPACE}:${GEO_STREET_FURNITURE_FAMILY_NAMES[family]}`,
    owner: GDO_STREET_FURNITURE_NAMESPACE,
    support: {
      id: family + 1,
      roleMask: GEO_SUPPORT_ROLE.ROAD_EDGE | GEO_SUPPORT_ROLE.STREET_FURNITURE,
      x: 0, y: 0, z: 0,
      halfWidth: footprint.halfWidth,
      halfDepth: footprint.halfDepth,
      yaw: 0,
    },
    authoritativeFootprint: 'road-frame-anchor',
    height: visualBounds(allModules).maxY,
    silhouette: modules.silhouette,
    surface: modules.surface,
    accents: modules.accents,
    visualBounds: visualBounds(allModules),
    solidProxies: [],
    interactionProxies: [],
    cameraRoles: [],
  });
  return Object.freeze({
    family,
    name: GEO_STREET_FURNITURE_FAMILY_NAMES[family],
    footprint,
    recipe,
    compiled: compileObjectRecipe(recipe, {
      lod: GEO_OBJECT_LOD.NEAR,
      maxModules: GEO_STREET_FURNITURE_LIMITS.maxModulesPerFamily,
      maxBoxes: GEO_STREET_FURNITURE_LIMITS.maxBoxesPerFamily,
    }),
  });
}

const SHARED_RECIPES = Object.freeze(GEO_STREET_FURNITURE_FAMILY_NAMES.map((_, family) =>
  createStreetFurnitureRecipe(family)));

export function streetFurnitureRecipes() { return SHARED_RECIPES; }

function validWaterDomain(domain) {
  return domain && typeof domain.namespace === 'string' &&
    domain.waterVertices instanceof Float32Array && domain.waterRingOffsets instanceof Uint32Array &&
    domain.waterPolygonOffsets instanceof Uint32Array && domain.waterBounds instanceof Float32Array &&
    domain.waterClasses instanceof Uint8Array && domain.waterFlowDirections instanceof Int16Array &&
    domain.wetlandVertices instanceof Float32Array && domain.wetlandRingOffsets instanceof Uint32Array &&
    domain.wetlandPolygonOffsets instanceof Uint32Array && domain.wetlandBounds instanceof Float32Array &&
    domain.waterways instanceof Float32Array && domain.meta?.malformedRecords === 0 &&
    domain.meta?.capEvents && !Object.values(domain.meta.capEvents).some(Boolean);
}

function emptyResult(meta = {}) {
  const placements = new Float32Array();
  return Object.freeze({
    namespace: GDO_STREET_FURNITURE_NAMESPACE,
    placements,
    stride: GEO_STREET_FURNITURE_STRIDE,
    meta: Object.freeze({
      namespace: GDO_STREET_FURNITURE_NAMESPACE,
      roadSegments: 0,
      roadCellReferences: 0,
      buildingCellReferences: 0,
      malformedRoads: 0,
      candidates: 0,
      retainedCandidates: 0,
      stableIdCollisionProbes: 0,
      placements: 0,
      familyCounts: Object.freeze(Array(GEO_STREET_FURNITURE_FAMILY_NAMES.length).fill(0)),
      roadTests: 0,
      buildingTests: 0,
      decorationTests: 0,
      conflictTests: 0,
      bytes: 0,
      rejected: Object.freeze({}),
      capEvents: Object.freeze({}),
      ...meta,
    }),
  });
}

function collectRoadFrames(vectorTile, request) {
  const layer = vectorTile?.layers?.transportation ?? vectorTile?.layers?.streets;
  if (!layer) return { records: [], malformed: 0, truncated: false };
  if (!Number.isInteger(layer.length) || layer.length < 0 ||
      layer.length > GEO_STREET_FURNITURE_LIMITS.maxSourceFeatures) {
    return { records: [], malformed: 0, truncated: true };
  }
  const byKey = new Map();
  let malformed = 0, sourceSegments = 0, truncated = false;
  features: for (let featureIndex = 0; featureIndex < layer.length; featureIndex++) {
    let feature;
    try { feature = layer.feature(featureIndex); } catch { malformed++; continue; }
    if (!feature || feature.type !== 2 || !Number.isFinite(feature.extent) || feature.extent <= 0) continue;
    const style = roadStyle(feature.properties ?? {});
    if (style.transport.physicalLevel !== 0 || !SUITABLE_ROADS.has(style.kind)) continue;
    let geometry;
    try { geometry = feature.loadGeometry(); } catch { malformed++; continue; }
    if (!Array.isArray(geometry)) { malformed++; continue; }
    for (const line of geometry) {
      if (!Array.isArray(line)) { malformed++; continue; }
      for (let index = 1; index < line.length; index++) {
        sourceSegments++;
        if (sourceSegments > GEO_STREET_FURNITURE_LIMITS.maxRoadSegments) { truncated = true; break features; }
        const firstPoint = line[index - 1], secondPoint = line[index];
        if (!finitePoint(firstPoint) || !finitePoint(secondPoint)) { malformed++; continue; }
        let first = pointToWorld(firstPoint, feature.extent, request);
        let second = pointToWorld(secondPoint, feature.extent, request);
        const length = Math.hypot(second[0] - first[0], second[1] - first[1]);
        if (!Number.isFinite(length) || length < 1e-5) { malformed++; continue; }
        if (first[0] > second[0] || first[0] === second[0] && first[1] > second[1]) [first, second] = [second, first];
        const halfWidth = style.width / 2;
        const key = segmentKey(first[0], first[1], second[0], second[1], halfWidth, style.kind);
        if (byKey.has(key)) continue;
        const dx = second[0] - first[0], dz = second[1] - first[1];
        const stableLength = Math.hypot(dx, dz);
        const hash = hashText(`${GDO_STREET_FURNITURE_NAMESPACE}:${key}`);
        const route = String(feature.properties?.route ?? feature.properties?.class ?? feature.properties?.kind ?? '').toLowerCase();
        byKey.set(key, {
          key, x1: first[0], z1: first[1], x2: second[0], z2: second[1],
          length: stableLength, tangentX: dx / stableLength, tangentZ: dz / stableLength,
          halfWidth, kind: style.kind, hash,
          transit: style.kind === 'busway' || route.includes('bus') || route.includes('transit'),
        });
      }
    }
  }
  if (truncated) return { records: [], malformed, truncated };
  const records = [...byKey.values()].sort((first, second) => first.key.localeCompare(second.key));
  records.forEach((record, id) => { record.id = id; });
  return { records, malformed, truncated: false };
}

function createSegmentIndex(records) {
  const cells = new Map();
  let references = 0, truncated = false;
  for (const record of records) {
    const extent = record.halfWidth + .8;
    const minX = Math.floor((Math.min(record.x1, record.x2) - extent) / GEO_STREET_FURNITURE_LIMITS.cellSize);
    const maxX = Math.floor((Math.max(record.x1, record.x2) + extent) / GEO_STREET_FURNITURE_LIMITS.cellSize);
    const minZ = Math.floor((Math.min(record.z1, record.z2) - extent) / GEO_STREET_FURNITURE_LIMITS.cellSize);
    const maxZ = Math.floor((Math.max(record.z1, record.z2) + extent) / GEO_STREET_FURNITURE_LIMITS.cellSize);
    const added = (maxX - minX + 1) * (maxZ - minZ + 1);
    if (references + added > GEO_STREET_FURNITURE_LIMITS.maxRoadCellReferences) { truncated = true; break; }
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
      const key = cellKey(x, z);
      let values = cells.get(key);
      if (!values) cells.set(key, values = []);
      values.push(record.id);
      references++;
    }
  }
  return { cells, references, truncated };
}

function createBuildingIndex(buildings) {
  const cells = new Map();
  let references = 0, truncated = false, malformed = false;
  for (let id = 0; id < buildings.length; id++) {
    const building = buildings[id];
    if (!building || !Array.isArray(building.rings) || !building.rings.length ||
        !building.rings.every(ring => Array.isArray(ring) && ring.length >= 3 &&
          ring.every(point => Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(Number.isFinite))) ||
        ![building.minX, building.minZ, building.maxX, building.maxZ].every(Number.isFinite)) {
      malformed = true;
      continue;
    }
    const extent = GEO_STREET_FURNITURE_LIMITS.entranceClearance + .75;
    const minX = Math.floor((building.minX - extent) / GEO_STREET_FURNITURE_LIMITS.cellSize);
    const maxX = Math.floor((building.maxX + extent) / GEO_STREET_FURNITURE_LIMITS.cellSize);
    const minZ = Math.floor((building.minZ - extent) / GEO_STREET_FURNITURE_LIMITS.cellSize);
    const maxZ = Math.floor((building.maxZ + extent) / GEO_STREET_FURNITURE_LIMITS.cellSize);
    const added = (maxX - minX + 1) * (maxZ - minZ + 1);
    if (references + added > GEO_STREET_FURNITURE_LIMITS.maxBuildingCellReferences) { truncated = true; break; }
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
      const key = cellKey(x, z);
      let values = cells.get(key);
      if (!values) cells.set(key, values = []);
      values.push(id);
      references++;
    }
  }
  return { cells, references, truncated, malformed };
}

function createDecorationIndex(decorations) {
  const cells = new Map();
  if (!(decorations instanceof Float32Array) || decorations.length % 6 !== 0) return { cells, malformed: true };
  const count = Math.min(decorations.length / 6, GEO_STREET_FURNITURE_LIMITS.maxDecorationReferences);
  let malformed = decorations.length / 6 > GEO_STREET_FURNITURE_LIMITS.maxDecorationReferences;
  for (let index = 0; index < count; index++) {
    const offset = index * 6, x = decorations[offset], z = decorations[offset + 1];
    if (![x, z, decorations[offset + 2], decorations[offset + 3], decorations[offset + 4], decorations[offset + 5]].every(Number.isFinite) ||
        decorations[offset + 2] <= 0) {
      malformed = true;
      continue;
    }
    const key = cellKey(
      Math.floor(x / GEO_STREET_FURNITURE_LIMITS.decorationCellSize),
      Math.floor(z / GEO_STREET_FURNITURE_LIMITS.decorationCellSize),
    );
    let values = cells.get(key);
    if (!values) cells.set(key, values = []);
    values.push(index);
  }
  return { cells, malformed };
}

function queryIds(index, x, z, radius, cellSize) {
  const ids = new Set();
  const minX = Math.floor((x - radius) / cellSize), maxX = Math.floor((x + radius) / cellSize);
  const minZ = Math.floor((z - radius) / cellSize), maxZ = Math.floor((z + radius) / cellSize);
  for (let cellX = minX; cellX <= maxX; cellX++) for (let cellZ = minZ; cellZ <= maxZ; cellZ++) {
    for (const id of index.cells.get(cellKey(cellX, cellZ)) ?? []) ids.add(id);
  }
  return [...ids].sort((first, second) => first - second);
}

function familyFor(record, hash) {
  const selector = (hash >>> 8) & 15;
  if (record.transit && selector >= 13) return GEO_STREET_FURNITURE_FAMILY.SHELTER;
  if (selector < 7) return GEO_STREET_FURNITURE_FAMILY.LAMP;
  if (selector < 9) return GEO_STREET_FURNITURE_FAMILY.BENCH;
  if (selector < 11) return GEO_STREET_FURNITURE_FAMILY.BOLLARD;
  if (selector === 11) return GEO_STREET_FURNITURE_FAMILY.BIN;
  if (selector <= 13) return GEO_STREET_FURNITURE_FAMILY.SIGN;
  if (['service', 'residential', 'street', 'living_street'].includes(record.kind)) {
    return GEO_STREET_FURNITURE_FAMILY.UTILITY;
  }
  return GEO_STREET_FURNITURE_FAMILY.LAMP;
}

function placementCandidate(record, slot, count, request) {
  const amount = slot / (count + 1);
  const along = record.length * amount;
  const crossingClearance = Math.max(.70, record.halfWidth + .35);
  if (along < GEO_STREET_FURNITURE_LIMITS.endpointClearance ||
      record.length - along < GEO_STREET_FURNITURE_LIMITS.endpointClearance ||
      Math.abs(along - record.length / 2) < crossingClearance) return null;
  const hash = mix32(record.hash ^ Math.imul(slot, 0x9e3779b1));
  const family = familyFor(record, hash);
  const footprint = FAMILY_FOOTPRINTS[family];
  const side = hash & 1 ? 1 : -1;
  const normalX = -record.tangentZ, normalZ = record.tangentX;
  const offset = record.halfWidth + .16 + footprint.halfDepth;
  const x = record.x1 + record.tangentX * along + normalX * offset * side;
  const z = record.z1 + record.tangentZ * along + normalZ * offset * side;
  const minX = (request.tileX - request.originX) * request.tileSize;
  const minZ = (request.tileY - request.originY) * request.tileSize;
  if (x < minX || x >= minX + request.tileSize || z < minZ || z >= minZ + request.tileSize) return null;
  return {
    x, z, family, footprint, source: record,
    scale: .92 + ((hash >>> 24) & 15) / 100,
    yaw: -Math.atan2(record.tangentZ, record.tangentX) + (side < 0 ? Math.PI : 0),
    stableId: hash & 0x00ffffff,
    priority: hash / 0x1_0000_0000,
  };
}

/**
 * Compile source-owned road-frame placements. Carriageways, every segment
 * midpoint/end, other road ribbons, all building perimeters, water, and prior
 * decoration anchors are conservative reserved domains.
 */
export function compileStreetFurniture(vectorTile, request, {
  buildings = [],
  buildingsTruncated = false,
  waterDomain,
  decorations = new Float32Array(),
} = {}) {
  if (!request || ![request.tileX, request.tileY, request.originX, request.originY, request.tileSize].every(Number.isFinite) ||
      request.tileSize <= 0) throw new TypeError('Street furniture requires a finite source-tile request');
  const collected = collectRoadFrames(vectorTile, request);
  const roadIndex = createSegmentIndex(collected.records);
  const buildingDomainValid = Array.isArray(buildings);
  const buildingIndex = createBuildingIndex(buildingDomainValid ? buildings : []);
  const decorationIndex = createDecorationIndex(decorations);
  const waterDomainValid = validWaterDomain(waterDomain);
  const failedSourceDomain = collected.truncated || collected.malformed > 0 || roadIndex.truncated ||
    !buildingDomainValid || buildingsTruncated || buildingIndex.truncated || buildingIndex.malformed ||
    decorationIndex.malformed || !waterDomainValid;
  if (failedSourceDomain || !collected.records.length) return emptyResult({
    roadSegments: collected.records.length,
    malformedRoads: collected.malformed,
    capEvents: Object.freeze({
      roadSegments: collected.truncated || roadIndex.truncated,
      malformedRoads: collected.malformed > 0,
      buildings: Boolean(!buildingDomainValid || buildingsTruncated || buildingIndex.truncated || buildingIndex.malformed),
      decorations: decorationIndex.malformed,
      waterDomain: !waterDomainValid,
    }),
  });

  const candidates = [];
  let candidateCount = 0;
  for (const record of collected.records) {
    const count = Math.min(10, Math.floor(record.length / GEO_STREET_FURNITURE_LIMITS.spacing));
    for (let slot = 1; slot <= count; slot++) {
      const candidate = placementCandidate(record, slot, count, request);
      if (!candidate) continue;
      candidateCount++;
      candidates.push(candidate);
      candidates.sort((first, second) => first.priority - second.priority || first.stableId - second.stableId ||
        first.source.key.localeCompare(second.source.key));
      if (candidates.length > GEO_STREET_FURNITURE_LIMITS.maxCandidates) candidates.pop();
    }
  }

  // Float32 preserves integers only through 24 bits. Resolve the boundedly rare
  // masked-hash collision in canonical priority/key order before reservations,
  // so every owner record remains unique without provider feature indices.
  const occupiedStableIds = new Set();
  let stableIdCollisionProbes = 0;
  for (const candidate of candidates) {
    while (occupiedStableIds.has(candidate.stableId)) {
      candidate.stableId = (candidate.stableId + 1) & 0x00ffffff;
      stableIdCollisionProbes++;
    }
    occupiedStableIds.add(candidate.stableId);
  }

  const accepted = [], rejected = {
    spawn: 0, road: 0, building: 0, water: 0, decoration: 0, conflict: 0,
  };
  let roadTests = 0, buildingTests = 0, decorationTests = 0, conflictTests = 0;
  let roadTestsCapped = false, buildingTestsCapped = false;
  let decorationTestsCapped = false, conflictTestsCapped = false;
  candidate: for (const candidate of candidates) {
    const radius = Math.hypot(candidate.footprint.halfWidth, candidate.footprint.halfDepth) * candidate.scale;
    if (Math.hypot(candidate.x, candidate.z) < 2.8 + radius) { rejected.spawn++; continue; }

    const nearbyRoads = queryIds(roadIndex, candidate.x, candidate.z, radius + 1,
      GEO_STREET_FURNITURE_LIMITS.cellSize);
    let candidateRoadTests = 0;
    for (const id of nearbyRoads) {
      if (id === candidate.source.id) continue;
      if (roadTests >= GEO_STREET_FURNITURE_LIMITS.maxRoadTestsPerTile ||
          candidateRoadTests >= GEO_STREET_FURNITURE_LIMITS.maxRoadTestsPerCandidate) {
        roadTestsCapped = true; rejected.road++; continue candidate;
      }
      roadTests++; candidateRoadTests++;
      const road = collected.records[id];
      const clearance = road.halfWidth + radius + .10;
      if (pointSegmentDistanceSquared(candidate.x, candidate.z, road.x1, road.z1, road.x2, road.z2) < clearance ** 2) {
        rejected.road++; continue candidate;
      }
    }

    const nearbyBuildings = queryIds(buildingIndex, candidate.x, candidate.z,
      radius + GEO_STREET_FURNITURE_LIMITS.entranceClearance, GEO_STREET_FURNITURE_LIMITS.cellSize);
    for (const id of nearbyBuildings) {
      if (buildingTests >= GEO_STREET_FURNITURE_LIMITS.maxBuildingTestsPerTile) {
        buildingTestsCapped = true; rejected.building++; continue candidate;
      }
      buildingTests++;
      const clearance = radius + GEO_STREET_FURNITURE_LIMITS.entranceClearance;
      if (polygonBoundaryDistanceSquared(candidate.x, candidate.z, buildings[id].rings) < clearance ** 2) {
        rejected.building++; continue candidate;
      }
    }

    if (queryWaterDomain(waterDomain, candidate.x, candidate.z, {}).waterDistance <= radius + .06) {
      rejected.water++; continue;
    }

    const nearbyDecorations = queryIds(decorationIndex, candidate.x, candidate.z, radius + .5,
      GEO_STREET_FURNITURE_LIMITS.decorationCellSize);
    for (const id of nearbyDecorations) {
      if (decorationTests >= GEO_STREET_FURNITURE_LIMITS.maxDecorationTestsPerTile) {
        decorationTestsCapped = true; rejected.decoration++; continue candidate;
      }
      decorationTests++;
      const offset = id * 6;
      const otherScale = Math.max(0, decorations[offset + 2]);
      const clearance = radius + Math.min(.5, .16 + otherScale * .18);
      if ((candidate.x - decorations[offset]) ** 2 + (candidate.z - decorations[offset + 1]) ** 2 < clearance ** 2) {
        rejected.decoration++; continue candidate;
      }
    }

    for (const other of accepted) {
      if (conflictTests >= GEO_STREET_FURNITURE_LIMITS.maxConflictTestsPerTile) {
        conflictTestsCapped = true; rejected.conflict++; continue candidate;
      }
      conflictTests++;
      const otherRadius = Math.hypot(other.footprint.halfWidth, other.footprint.halfDepth) * other.scale;
      if ((candidate.x - other.x) ** 2 + (candidate.z - other.z) ** 2 < (radius + otherRadius + .10) ** 2) {
        rejected.conflict++; continue candidate;
      }
    }
    accepted.push(candidate);
    if (accepted.length >= GEO_STREET_FURNITURE_LIMITS.maxPlacementsPerTile) break;
  }

  accepted.sort((first, second) => first.family - second.family || first.stableId - second.stableId ||
    first.x - second.x || first.z - second.z);
  const values = [];
  const familyCounts = Array(GEO_STREET_FURNITURE_FAMILY_NAMES.length).fill(0);
  for (const item of accepted) {
    values.push(item.x, item.z, item.scale, item.family, item.yaw, item.stableId);
    familyCounts[item.family]++;
  }
  const placements = new Float32Array(values);
  return Object.freeze({
    namespace: GDO_STREET_FURNITURE_NAMESPACE,
    placements,
    stride: GEO_STREET_FURNITURE_STRIDE,
    meta: Object.freeze({
      namespace: GDO_STREET_FURNITURE_NAMESPACE,
      roadSegments: collected.records.length,
      roadCellReferences: roadIndex.references,
      buildingCellReferences: buildingIndex.references,
      malformedRoads: collected.malformed,
      candidates: candidateCount,
      retainedCandidates: candidates.length,
      stableIdCollisionProbes,
      placements: accepted.length,
      familyCounts: Object.freeze(familyCounts),
      roadTests,
      buildingTests,
      decorationTests,
      conflictTests,
      bytes: placements.byteLength,
      rejected: Object.freeze(rejected),
      capEvents: Object.freeze({
        roadSegments: false,
        buildings: false,
        decorations: false,
        candidates: candidateCount > GEO_STREET_FURNITURE_LIMITS.maxCandidates,
        placements: accepted.length >= GEO_STREET_FURNITURE_LIMITS.maxPlacementsPerTile &&
          candidates.length > accepted.length,
        roadTests: roadTestsCapped,
        buildingTests: buildingTestsCapped,
        decorationTests: decorationTestsCapped,
        conflictTests: conflictTestsCapped,
      }),
    }),
  });
}
