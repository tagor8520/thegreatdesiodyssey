import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import earcut from 'earcut';
import { GEO_LAYER, GEO_SURFACE_Y, resolveTransportLevel } from './GeoLayers.js';
import {
  GEO_SUPPORT_SLOT_STRIDE,
  appendPackedSupportSlots,
  generateRoofSupportSlots,
} from './GeoSupportSlots.js';
import { compileObjectRecipe, createRoofTankRecipe } from './GeoObjectRecipe.js';
import {
  GDO_LANDMARK_NAMESPACE,
  GEO_LANDMARK_LIMITS,
  compileLandmarks,
  landmarkEligibility,
  landmarkSignalFromProperties,
} from './GeoLandmarkGrammar.js';
import {
  GDO_BUILDING_GRAMMAR_NAMESPACE,
  GEO_BUILDING_DETAIL_LIMITS,
  createBuildingDetailRecipe,
  createBuildingRoadIndex,
  findRoadFacingEdge,
  selectBuildingDetailCandidates,
} from './GeoBuildingGrammar.js';
import { terrainHeightAt } from './GeoTerrain.js';

const MAX_ROAD_SEGMENTS = 14000;
const MAX_ROAD_DETAIL_QUADS = 6000;
const MAX_ROAD_JUNCTIONS = 1200;
const ROAD_JUNCTION_CELL_SIZE = 8;
const MAX_BUILDINGS = 2600;
const MAX_BUILDING_VERTICES = 180000;
const MAX_SUPPORT_SLOTS = 2048;

const ROAD_WIDTH_METRES = Object.freeze({
  motorway: 14,
  trunk: 12,
  primary: 10,
  secondary: 8,
  tertiary: 7,
  minor: 5.5,
  unclassified: 5.5,
  residential: 5.5,
  living_street: 4.5,
  service: 4,
  busway: 5,
  track: 3,
  path: 1.8,
  footway: 1.8,
  cycleway: 2,
  pedestrian: 3,
  steps: 1.8,
  rail: 3,
  transit: 3,
  tram: 2.5,
  light_rail: 3,
  runway: 24,
  taxiway: 12,
});

const ROAD_COLORS = Object.freeze({
  motorway: [0.045, 0.052, 0.060],
  trunk: [0.050, 0.058, 0.066],
  primary: [0.055, 0.065, 0.075],
  secondary: [0.062, 0.074, 0.082],
  tertiary: [0.070, 0.082, 0.088],
  rail: [0.022, 0.027, 0.032],
  path: [0.24, 0.13, 0.045],
  track: [0.18, 0.10, 0.040],
  default: [0.075, 0.085, 0.088],
});

const ROAD_LINE_COLOR = Object.freeze([0.95, 0.82, 0.38]);
const CURB_COLOR = Object.freeze([0.28, 0.32, 0.31]);

// Buffer vertex colours are linear; these values correspond to a warm,
// sun-baked sRGB facade palette rather than washed-out numeric sRGB values.
const BUILDING_PALETTE = Object.freeze([
  [0.47, 0.11, 0.05],
  [0.63, 0.30, 0.09],
  [0.47, 0.36, 0.22],
  [0.64, 0.50, 0.32],
  [0.25, 0.33, 0.33],
  [0.39, 0.20, 0.14],
  [0.67, 0.07, 0.05],
  [0.02, 0.24, 0.14],
  [0.08, 0.30, 0.52],
  [0.75, 0.47, 0.05],
]);

export function decodeVectorTile(arrayBuffer) {
  return new VectorTile(new PbfReader(arrayBuffer));
}

function geometryResult(positions, normals, colors, indices, meta = {}) {
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    meta,
  };
}

function addColor(colors, color, count) {
  for (let i = 0; i < count; i++) colors.push(color[0], color[1], color[2]);
}

function pointToWorld(point, extent, request) {
  return [
    (request.tileX + point.x / extent - request.originX) * request.tileSize,
    (request.tileY + point.y / extent - request.originY) * request.tileSize,
  ];
}

function roadClass(properties) {
  if (properties.rail) return properties.kind || 'rail';
  return properties.class || properties.kind || properties.subclass || 'minor';
}

export function roadStyle(properties) {
  const kind = roadClass(properties);
  const family = kind.includes('rail') || kind === 'transit' || kind === 'tram' ? 'rail' : kind;
  const widthMetres = ROAD_WIDTH_METRES[family] ?? ROAD_WIDTH_METRES.minor;
  let color = ROAD_COLORS[family] ?? ROAD_COLORS.default;
  if (['path', 'footway', 'cycleway', 'pedestrian', 'steps'].includes(kind)) color = ROAD_COLORS.path;
  const transport = resolveTransportLevel(properties);
  if (transport.kind === 'tunnel') color = color.map(component => component * .62);
  return { kind, width: widthMetres * requestScale(properties), color, transport };
}

// Isolated for tests and future per-provider scaling. All source widths are metres.
function requestScale() { return 0.1; }

function appendFlatQuad(positions, normals, colors, indices, x1, z1, x2, z2, halfWidth, y, color, offset = 0, endY = y) {
  const dx = x2 - x1, dz = z2 - z1;
  const length = Math.hypot(dx, dz);
  if (length < 1e-5) return;
  const nx = -dz / length, nz = dx / length;
  const px = nx * halfWidth, pz = nz * halfWidth;
  const ox = nx * offset, oz = nz * offset;
  const base = positions.length / 3;
  positions.push(
    x1 + ox + px,y,z1 + oz + pz, x1 + ox - px,y,z1 + oz - pz,
    x2 + ox + px,endY,z2 + oz + pz, x2 + ox - px,endY,z2 + oz - pz,
  );
  const rise = (endY - y) / length;
  const inverseNormal = 1 / Math.hypot(rise, 1);
  const normalX = -dx / length * rise * inverseNormal;
  const normalY = inverseNormal;
  const normalZ = -dz / length * rise * inverseNormal;
  for (let index = 0; index < 4; index++) normals.push(normalX, normalY, normalZ);
  addColor(colors, color, 4);
  indices.push(base,base + 1,base + 2, base + 2,base + 1,base + 3);
}

function centerlineIntersection(first, second) {
  const adx = first.x2 - first.x1, adz = first.z2 - first.z1;
  const bdx = second.x2 - second.x1, bdz = second.z2 - second.z1;
  const denominator = adx * bdz - adz * bdx;
  if (Math.abs(denominator) < 1e-9) return null;
  const offsetX = second.x1 - first.x1, offsetZ = second.z1 - first.z1;
  const firstAmount = (offsetX * bdz - offsetZ * bdx) / denominator;
  const secondAmount = (offsetX * adz - offsetZ * adx) / denominator;
  const epsilon = 1e-6;
  if (firstAmount <= epsilon || firstAmount >= 1 - epsilon || secondAmount <= epsilon || secondAmount >= 1 - epsilon) return null;
  return [first.x1 + adx * firstAmount, first.z1 + adz * firstAmount];
}

function sharedCenterlineEndpoint(first, second) {
  if ((Math.abs(first.x1 - second.x1) <= 1e-6 && Math.abs(first.z1 - second.z1) <= 1e-6) ||
      (Math.abs(first.x1 - second.x2) <= 1e-6 && Math.abs(first.z1 - second.z2) <= 1e-6)) return [first.x1, first.z1];
  if ((Math.abs(first.x2 - second.x1) <= 1e-6 && Math.abs(first.z2 - second.z1) <= 1e-6) ||
      (Math.abs(first.x2 - second.x2) <= 1e-6 && Math.abs(first.z2 - second.z2) <= 1e-6)) return [first.x2, first.z2];
  return null;
}

function appendJunctionPatch(positions, normals, colors, indices, junction, terrainSeed) {
  const sides = 8, base = positions.length / 3;
  positions.push(junction.x, junction.y + GEO_SURFACE_Y.JUNCTION_OFFSET, junction.z);
  normals.push(0, 1, 0);
  addColor(colors, junction.color, 1);
  for (let side = 0; side < sides; side++) {
    const angle = side * Math.PI * 2 / sides;
    const x = junction.x + Math.cos(angle) * junction.radius;
    const z = junction.z + Math.sin(angle) * junction.radius;
    positions.push(
      x,
      terrainHeightAt(x, z, terrainSeed) + junction.surfaceOffset + GEO_SURFACE_Y.JUNCTION_OFFSET,
      z,
    );
    normals.push(0, 1, 0);
    addColor(colors, junction.color, 1);
  }
  for (let side = 0; side < sides; side++) {
    indices.push(base, base + 1 + (side + 1) % sides, base + 1 + side);
  }
}

function transportLevelSummary(levelStats) {
  const levels = [...levelStats.values()]
    .sort((first, second) => first.physicalLevel - second.physicalLevel)
    .map(entry => Object.freeze({ ...entry }));
  return Object.freeze({
    levels,
    minLevel: levels[0]?.physicalLevel ?? 0,
    maxLevel: levels.at(-1)?.physicalLevel ?? 0,
    tunnelFeatures: levels.filter(entry => entry.kind === 'tunnel').reduce((sum, entry) => sum + entry.features, 0),
    groundFeatures: levels.filter(entry => entry.kind === 'ground').reduce((sum, entry) => sum + entry.features, 0),
    bridgeFeatures: levels.filter(entry => entry.kind === 'bridge').reduce((sum, entry) => sum + entry.features, 0),
  });
}

export function buildRoadGeometry(vectorTile, request) {
  const layer = vectorTile.layers.transportation ?? vectorTile.layers.streets;
  const positions = [], normals = [], colors = [], indices = [], levelStats = new Map(), supportSegmentValues = [];
  const junctions = [], junctionByKey = new Map(), junctionGrid = new Map(), longJunctionSegments = [], junctionSegments = [];
  if (!layer) return {
    ...geometryResult(positions, normals, colors, indices, {
      features: 0,
      segments: 0,
      detailQuads: 0,
      junctions: 0,
      junctionsTruncated: false,
      truncated: false,
      transportLevels: transportLevelSummary(levelStats),
    }),
    supportSegments: new Float32Array(),
    supportSegmentStride: 8,
  };

  let segments = 0, detailQuads = 0, features = 0, truncated = false, junctionsTruncated = false;
  const terrainSeed = Number.isFinite(request.terrainSeed) ? request.terrainSeed : 0;
  const addJunction = (x, z, first, second = first) => {
    const physicalLevel = first.physicalLevel;
    const key = `${physicalLevel}:${Math.round(x * 1000)}:${Math.round(z * 1000)}`;
    const wider = second.halfWidth > first.halfWidth ? second : first;
    const existing = junctionByKey.get(key);
    if (existing) {
      existing.radius = Math.max(existing.radius, Math.hypot(first.halfWidth, second.halfWidth) * 1.02);
      return;
    }
    if (junctions.length >= MAX_ROAD_JUNCTIONS) { junctionsTruncated = true; return; }
    const junction = {
      key,
      x,
      z,
      y: terrainHeightAt(x, z, terrainSeed) + first.surfaceOffset,
      surfaceOffset: first.surfaceOffset,
      radius: Math.hypot(first.halfWidth, second.halfWidth) * 1.02,
      color: wider.color,
    };
    junctionByKey.set(key, junction);
    junctions.push(junction);
  };
  const registerJunctionSegment = segment => {
    if (junctionsTruncated) return;
    const minCellX = Math.floor(Math.min(segment.x1, segment.x2) / ROAD_JUNCTION_CELL_SIZE);
    const maxCellX = Math.floor(Math.max(segment.x1, segment.x2) / ROAD_JUNCTION_CELL_SIZE);
    const minCellZ = Math.floor(Math.min(segment.z1, segment.z2) / ROAD_JUNCTION_CELL_SIZE);
    const maxCellZ = Math.floor(Math.max(segment.z1, segment.z2) / ROAD_JUNCTION_CELL_SIZE);
    const cells = (maxCellX - minCellX + 1) * (maxCellZ - minCellZ + 1);
    const candidates = new Set(longJunctionSegments);
    if (cells <= 128) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
        for (const candidate of junctionGrid.get(`${cellX}:${cellZ}`) ?? []) candidates.add(candidate);
      }
    } else for (const candidate of junctionSegments) candidates.add(candidate);
    for (const candidate of candidates) {
      if (candidate.physicalLevel !== segment.physicalLevel || candidate.featureIndex === segment.featureIndex) continue;
      const intersection = centerlineIntersection(candidate, segment) ?? sharedCenterlineEndpoint(candidate, segment);
      if (intersection) addJunction(intersection[0], intersection[1], candidate, segment);
    }
    if (cells > 128) longJunctionSegments.push(segment);
    else for (let cellX = minCellX; cellX <= maxCellX; cellX++) for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
      const key = `${cellX}:${cellZ}`;
      if (!junctionGrid.has(key)) junctionGrid.set(key, []);
      junctionGrid.get(key).push(segment);
    }
    junctionSegments.push(segment);
  };
  for (let featureIndex = 0; featureIndex < layer.length; featureIndex++) {
    if (segments >= MAX_ROAD_SEGMENTS) { truncated = true; break; }
    const feature = layer.feature(featureIndex);
    if (feature.type !== 2) continue;
    const style = roadStyle(feature.properties);
    const { transport } = style;
    const surfaceOffset = transport.surfaceY;
    const halfWidth = style.width / 2;
    const stats = levelStats.get(transport.physicalLevel) ?? {
      physicalLevel: transport.physicalLevel,
      minSourceLevel: transport.sourceLevel,
      maxSourceLevel: transport.sourceLevel,
      surfaceY: transport.surfaceY,
      kind: transport.kind,
      features: 0,
      segments: 0,
    };
    levelStats.set(transport.physicalLevel, stats);
    let used = false;

    for (const line of feature.loadGeometry()) {
      let previousJunctionSegment = null;
      for (let pointIndex = 1; pointIndex < line.length; pointIndex++) {
        if (segments >= MAX_ROAD_SEGMENTS) { truncated = true; break; }
        const [x1, z1] = pointToWorld(line[pointIndex - 1], feature.extent, request);
        const [x2, z2] = pointToWorld(line[pointIndex], feature.extent, request);
        const dx = x2 - x1, dz = z2 - z1;
        const length = Math.hypot(dx, dz);
        if (length < 1e-5) continue;
        const y1 = terrainHeightAt(x1, z1, terrainSeed) + surfaceOffset;
        const y2 = terrainHeightAt(x2, z2, terrainSeed) + surfaceOffset;
        supportSegmentValues.push(x1, z1, y1, x2, z2, y2, halfWidth, transport.physicalLevel);
        const junctionSegment = {
          x1, z1, x2, z2, halfWidth, surfaceOffset,
          color: style.color,
          physicalLevel: transport.physicalLevel,
          featureIndex,
        };
        if (previousJunctionSegment) addJunction(x1, z1, previousJunctionSegment, junctionSegment);
        registerJunctionSegment(junctionSegment);
        previousJunctionSegment = junctionSegment;
        appendFlatQuad(positions, normals, colors, indices, x1, z1, x2, z2, halfWidth, y1, style.color, 0, y2);

        // Curbs and sparse centre markings are batched into the road mesh. They
        // add legibility at street level without another material or draw call.
        const hasCurbs = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'major', 'medium'].includes(style.kind) ||
          (['street', 'residential', 'living_street'].includes(style.kind) && featureIndex % 3 === 0);
        if (hasCurbs && style.width >= .42 && detailQuads + 2 <= MAX_ROAD_DETAIL_QUADS) {
          // Put the light boundary just outside the asphalt instead of hiding a
          // hairline inside it; this remains clear with antialiasing disabled.
          // Sit below asphalt so a crossing road naturally masks the curb at
          // junctions instead of drawing bright lines through intersections.
          appendFlatQuad(positions, normals, colors, indices, x1, z1, x2, z2, .045,
            y1 + GEO_SURFACE_Y.CURB_OFFSET, CURB_COLOR, halfWidth + .035, y2 + GEO_SURFACE_Y.CURB_OFFSET);
          appendFlatQuad(positions, normals, colors, indices, x1, z1, x2, z2, .045,
            y1 + GEO_SURFACE_Y.CURB_OFFSET, CURB_COLOR, -halfWidth - .035, y2 + GEO_SURFACE_Y.CURB_OFFSET);
          detailQuads += 2;
        }
        const markedRoad = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'major', 'medium'].includes(style.kind);
        if (markedRoad && length > .45) {
          const ux = dx / length, uz = dz / length;
          for (let distance = .12; distance < length && detailQuads < MAX_ROAD_DETAIL_QUADS; distance += .52) {
            const end = Math.min(distance + .27, length);
            const markStartY = y1 + (y2 - y1) * distance / length + GEO_SURFACE_Y.LANE_MARK_OFFSET;
            const markEndY = y1 + (y2 - y1) * end / length + GEO_SURFACE_Y.LANE_MARK_OFFSET;
            appendFlatQuad(positions, normals, colors, indices,
              x1 + ux * distance, z1 + uz * distance, x1 + ux * end, z1 + uz * end,
              .024, markStartY, ROAD_LINE_COLOR, 0, markEndY);
            detailQuads++;
          }
          if (length > 2.4 && (featureIndex * 31 + pointIndex * 17) % 11 === 0 && detailQuads + 5 < MAX_ROAD_DETAIL_QUADS) {
            const nx = -dz / length, nz = dx / length;
            for (let stripe = -2; stripe <= 2; stripe++) {
              const centreX = (x1 + x2) / 2 + ux * stripe * .13;
              const centreZ = (z1 + z2) / 2 + uz * stripe * .13;
              const crossingY = y1 + (y2 - y1) * (length / 2 + stripe * .13) / length + GEO_SURFACE_Y.CROSSING_OFFSET;
              appendFlatQuad(positions, normals, colors, indices,
                centreX + nx * Math.max(.08, halfWidth - .07), centreZ + nz * Math.max(.08, halfWidth - .07),
                centreX - nx * Math.max(.08, halfWidth - .07), centreZ - nz * Math.max(.08, halfWidth - .07),
                .035, crossingY, ROAD_LINE_COLOR);
              detailQuads++;
            }
          }
        }
        segments++; stats.segments++; used = true;
      }
      if (truncated) break;
    }
    if (used) {
      features++;
      stats.features++;
      stats.minSourceLevel = Math.min(stats.minSourceLevel, transport.sourceLevel);
      stats.maxSourceLevel = Math.max(stats.maxSourceLevel, transport.sourceLevel);
    } else if (stats.features === 0 && stats.segments === 0) levelStats.delete(transport.physicalLevel);
  }

  for (const junction of junctions) appendJunctionPatch(positions, normals, colors, indices, junction, terrainSeed);
  return {
    ...geometryResult(positions, normals, colors, indices, {
      features,
      segments,
      detailQuads,
      junctions: junctions.length,
      junctionsTruncated,
      truncated,
      transportLevels: transportLevelSummary(levelStats),
    }),
    supportSegments: new Float32Array(supportSegmentValues),
    supportSegmentStride: 8,
  };
}

function withoutClosingPoint(ring) {
  if (ring.length > 1 && ring[0].x === ring.at(-1).x && ring[0].y === ring.at(-1).y) return ring.slice(0, -1);
  return ring;
}

function buildingDetailHash(rings, tileX, tileY) {
  let value = (Math.imul(tileX, 73856093) ^ Math.imul(tileY, 19349663) ^ 2166136261) >>> 0;
  for (const ring of rings) for (const point of ring) for (const coordinate of point) {
    value ^= Math.round(coordinate * 4096);
    value = Math.imul(value, 16777619);
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function collectBuildingRoadSegments(vectorTile, request) {
  const layer = vectorTile.layers.transportation ?? vectorTile.layers.streets;
  const segments = [];
  let truncated = false;
  if (!layer) return { segments, truncated };
  if (layer.length > GEO_BUILDING_DETAIL_LIMITS.maxRoadSegments) return { segments, truncated: true };
  features: for (let featureIndex = 0; featureIndex < layer.length; featureIndex++) {
    const feature = layer.feature(featureIndex);
    if (feature.type !== 2) continue;
    const kind = String(roadClass(feature.properties));
    const transport = resolveTransportLevel(feature.properties);
    if (transport.physicalLevel !== 0 || ['rail', 'transit', 'tram', 'light_rail', 'runway', 'taxiway'].some(value => kind.includes(value))) {
      continue;
    }
    for (const line of feature.loadGeometry()) for (let index = 1; index < line.length; index++) {
      if (segments.length >= GEO_BUILDING_DETAIL_LIMITS.maxRoadSegments) { truncated = true; break features; }
      const first = pointToWorld(line[index - 1], feature.extent, request);
      const second = pointToWorld(line[index], feature.extent, request);
      const forward = first[0] < second[0] || first[0] === second[0] && first[1] <= second[1];
      segments.push(forward
        ? [first[0], first[1], second[0], second[1]]
        : [second[0], second[1], first[0], first[1]]);
    }
  }
  if (truncated) return { segments: [], truncated };
  segments.sort((first, second) =>
    first[0] - second[0] || first[1] - second[1] || first[2] - second[2] || first[3] - second[3]);
  return { segments, truncated };
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return Math.abs(area) / 2;
}

function appendBox(
  positions, normals, colors, indices,
  centerX, bottom, centerZ, sizeX, sizeY, sizeZ, color, yaw = 0,
) {
  const minX = -sizeX / 2, maxX = sizeX / 2;
  const minY = bottom, maxY = bottom + sizeY;
  const minZ = -sizeZ / 2, maxZ = sizeZ / 2;
  const faces = [
    [[minX,minY,maxZ],[maxX,minY,maxZ],[minX,maxY,maxZ],[maxX,maxY,maxZ],[0,0,1]],
    [[maxX,minY,minZ],[minX,minY,minZ],[maxX,maxY,minZ],[minX,maxY,minZ],[0,0,-1]],
    [[maxX,minY,maxZ],[maxX,minY,minZ],[maxX,maxY,maxZ],[maxX,maxY,minZ],[1,0,0]],
    [[minX,minY,minZ],[minX,minY,maxZ],[minX,maxY,minZ],[minX,maxY,maxZ],[-1,0,0]],
    [[minX,maxY,maxZ],[maxX,maxY,maxZ],[minX,maxY,minZ],[maxX,maxY,minZ],[0,1,0]],
    [[minX,minY,minZ],[maxX,minY,minZ],[minX,minY,maxZ],[maxX,minY,maxZ],[0,-1,0]],
  ];
  const cosine = Math.cos(yaw), sine = Math.sin(yaw);
  for (const face of faces) {
    const base = positions.length / 3;
    for (let vertex = 0; vertex < 4; vertex++) {
      const [x, y, z] = face[vertex];
      positions.push(centerX + x * cosine - z * sine, y, centerZ + x * sine + z * cosine);
    }
    const [normalX, normalY, normalZ] = face[4];
    const worldNormalX = normalX * cosine - normalZ * sine;
    const worldNormalZ = normalX * sine + normalZ * cosine;
    for (let vertex = 0; vertex < 4; vertex++) normals.push(worldNormalX, normalY, worldNormalZ);
    addColor(colors, color, 4);
    indices.push(base,base + 1,base + 2, base + 2,base + 1,base + 3);
  }
}

function buildingHeight(properties, footprintArea, hash) {
  const tagged = Number(properties.render_height);
  if (Number.isFinite(tagged) && tagged > 0) return Math.max(.45, Math.min(12, tagged * .1));
  // Shortbread deliberately has no height field. Generate a stable, stylized Z
  // from the tile-addressed footprint hash; horizontal geometry remains map-derived.
  const areaHint = Math.min(12, Math.sqrt(Math.max(footprintArea, .01)) * 2.2);
  const realMetres = 5 + areaHint + hash % 18;
  return Math.max(.55, Math.min(8, realMetres * .1));
}

/**
 * Remove one contiguous vertex/index range and re-point every later index at its
 * new base. A landmark hero replaces the plain extruded footprint it was chosen
 * from, so its mapped shell is dropped instead of being left to seal the hero's
 * arches and doors. Bounded: at most one hero range is removed per tile.
 */
export function suppressGeometryRange(positions, normals, colors, indices, range) {
  const vertexStart = range.vertexStart * 3;
  const vertexCount = (range.vertexEnd - range.vertexStart) * 3;
  const indexStart = range.indexStart;
  const indexCount = range.indexEnd - range.indexStart;
  if (![vertexStart, vertexCount, indexStart, indexCount].every(Number.isInteger) ||
      vertexStart < 0 || vertexCount < 0 || indexStart < 0 || indexCount < 0 ||
      vertexStart + vertexCount > positions.length ||
      vertexStart + vertexCount > normals.length ||
      vertexStart + vertexCount > colors.length ||
      indexStart + indexCount > indices.length) {
    throw new RangeError('Landmark suppression range is malformed');
  }
  positions.splice(vertexStart, vertexCount);
  normals.splice(vertexStart, vertexCount);
  colors.splice(vertexStart, vertexCount);
  indices.splice(indexStart, indexCount);
  const shift = range.vertexEnd - range.vertexStart;
  for (let index = 0; index < indices.length; index++) {
    if (indices[index] >= range.vertexEnd) indices[index] -= shift;
  }
  return Object.freeze({
    vertices: range.vertexEnd - range.vertexStart,
    indices: indexCount,
  });
}

/**
 * Append one tight compound as an AABB collider with its own exact rectangle
 * footprint, a true vertical span, and the mapped building query mask. This is
 * why a hero never needs one enclosing AABB: every load-bearing module carries
 * its own box, and reserved openings carry none.
 */
export function appendCompoundCollider(
  colliderValues, collisionVertices, collisionRingOffsets, collisionPolygonOffsets,
  collisionSpans, collisionMasks, compound, mask,
) {
  colliderValues.push(compound.minimumX, compound.minimumZ, compound.maximumX, compound.maximumZ);
  collisionVertices.push(
    compound.minimumX, compound.minimumZ,
    compound.maximumX, compound.minimumZ,
    compound.maximumX, compound.maximumZ,
    compound.minimumX, compound.maximumZ,
  );
  collisionRingOffsets.push(collisionVertices.length / 2);
  collisionPolygonOffsets.push(collisionRingOffsets.length - 1);
  collisionSpans.push(compound.minimumY, compound.maximumY);
  collisionMasks.push(mask);
}

export function buildBuildingGeometry(vectorTile, request) {
  const layer = vectorTile.layers.building ?? vectorTile.layers.buildings;
  const positions = [], normals = [], colors = [], indices = [], colliderValues = [];
  const detailPositions = [], detailNormals = [], detailColors = [], detailIndices = [];
  const supportSlotValues = [], supportSlotStates = [];
  const buildingDetailEnabled = request?.buildingDetails !== false;
  // Landmark heroes are always on (bounded to one hero per tile) and reuse the
  // same bounded road query that facade detail uses.
  const landmarkEnabled = request?.landmarks !== false;
  const sourceRoads = layer && (buildingDetailEnabled || landmarkEnabled)
    ? collectBuildingRoadSegments(vectorTile, request) : { segments: [], truncated: false };
  const buildingRoadIndex = createBuildingRoadIndex(sourceRoads.segments);
  // AABBs remain as the broad-phase index. Packed source-footprint rings provide
  // the narrow phase, so rotated and L-shaped buildings no longer block the
  // large empty corners of their bounding boxes. Spans and masks remain aligned
  // one-to-one with those polygon records.
  const collisionVertices = [], collisionRingOffsets = [0], collisionPolygonOffsets = [0];
  const collisionSpans = [], collisionMasks = [];
  const landmarkPositions = [], landmarkNormals = [], landmarkColors = [], landmarkIndices = [];
  const landmarkCandidates = [], landmarkRanges = new Map();
  if (!layer) {
    return {
      ...geometryResult(positions, normals, colors, indices, {
        features: 0,
        truncated: false,
        supportSlots: 0,
        occupiedSupportSlots: 0,
        supportDetailAttempts: 0,
        supportDetailSkips: 0,
        supportCapReached: false,
        objectRecipes: 0,
        objectModules: 0,
        objectBoxes: 0,
        objectBudgetSkips: 0,
        buildingGrammar: Object.freeze({
          namespace: GDO_BUILDING_GRAMMAR_NAMESPACE,
          candidates: 0,
          selectedBuildings: 0,
          roadFacingBuildings: 0,
          roadSegments: buildingRoadIndex.meta.segments,
          roadCellReferences: buildingRoadIndex.meta.cellReferences,
          roadTests: 0,
          boxes: 0,
          triangles: 0,
          bytes: 0,
          capEvents: Object.freeze({ roadSegments: sourceRoads.truncated || buildingRoadIndex.meta.truncated,
            roadTests: false, selectedBuildings: false, boxes: false, bytes: false }),
        }),
      }),
      detailPositions: new Float32Array(),
      detailNormals: new Float32Array(),
      detailColors: new Float32Array(),
      detailIndices: new Uint32Array(),
      colliders: new Float32Array(),
      collisionVertices: new Float32Array(),
      collisionRingOffsets: new Uint32Array([0]),
      collisionPolygonOffsets: new Uint32Array([0]),
      collisionSpans: new Float32Array(),
      collisionMasks: new Uint16Array(),
      supportSlots: new Float32Array(),
      supportSlotStates: new Uint8Array(),
      supportSlotStride: GEO_SUPPORT_SLOT_STRIDE,
    };
  }

  let features = 0, truncated = false;
  let supportDetailAttempts = 0, supportDetailSkips = 0, supportCapReached = false;
  let objectRecipes = 0, objectModules = 0, objectBoxes = 0, objectBudgetSkips = 0;
  const buildingDetailCandidates = [];
  let buildingDetailCandidateCount = 0;
  let buildingDetailRoadTests = 0, buildingDetailRoadFacing = 0, buildingDetailQueryCapReached = false;
  buildingFeatures: for (let featureIndex = 0; featureIndex < layer.length; featureIndex++) {
    if (features >= MAX_BUILDINGS || positions.length / 3 >= MAX_BUILDING_VERTICES) { truncated = true; break; }
    const feature = layer.feature(featureIndex);
    if (feature.type !== 3 || feature.properties.hide_3d === true || feature.properties.hide_3d === 1) continue;
    const polygons = classifyRings(feature.loadGeometry());
    let featureUsed = false;

    for (let polygonIndex = 0; polygonIndex < polygons.length; polygonIndex++) {
      const polygon = polygons[polygonIndex];
      const rings = polygon.map(withoutClosingPoint).filter(ring => ring.length >= 3);
      if (!rings.length) continue;
      const generatedVertexCount = rings.reduce((sum, ring) => sum + ring.length * 5, 0) + rings[0].length * 4 + 24;
      if (positions.length / 3 + generatedVertexCount > MAX_BUILDING_VERTICES) {
        truncated = true;
        break buildingFeatures;
      }
      const worldRings = rings.map(ring => ring.map(point => pointToWorld(point, feature.extent, request)));
      const outer = worldRings[0];
      const footprintArea = polygonArea(outer);
      const detailHash = buildingDetailHash(worldRings, request.tileX, request.tileY);
      const wallColor = BUILDING_PALETTE[detailHash % BUILDING_PALETTE.length];
      const roofColor = wallColor.map(value => Math.min(1, value * 1.13));
      const height = buildingHeight(feature.properties, footprintArea, detailHash);
      // A hero replaces its mapped shell, so the exact vertex/index range is
      // recorded here and removed only if this polygon actually wins selection.
      const landmarkEligible = landmarkEnabled && landmarkEligibility(worldRings, height).eligible;
      const landmarkRange = landmarkEligible
        ? { vertexStart: positions.length / 3, indexStart: indices.length } : null;
      let supportDetailSlotIndex = -1;
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      let terrainTotal = 0;
      for (const [x, z] of outer) {
        minX = Math.min(minX, x); minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
        terrainTotal += terrainHeightAt(x, z, Number.isFinite(request.terrainSeed) ? request.terrainSeed : 0);
      }
      const foundationY = terrainTotal / outer.length;
      const roofY = foundationY + height;
      const flat = [], holes = [];
      for (let ringIndex = 0; ringIndex < worldRings.length; ringIndex++) {
        if (ringIndex > 0) holes.push(flat.length / 2);
        for (const [x, z] of worldRings[ringIndex]) flat.push(x, z);
      }
      const roofTriangles = earcut(flat, holes, 2);
      const roofBase = positions.length / 3;
      for (let i = 0; i < flat.length; i += 2) positions.push(flat[i], roofY, flat[i + 1]);
      for (let i = 0; i < flat.length / 2; i++) normals.push(0, 1, 0);
      addColor(colors, roofColor, flat.length / 2);
      for (let i = 0; i < roofTriangles.length; i += 3) {
        // MVT screen-space winding may face downward in Three.js; reverse it.
        indices.push(roofBase + roofTriangles[i], roofBase + roofTriangles[i + 2], roofBase + roofTriangles[i + 1]);
      }

      for (const ring of worldRings) {
        for (let i = 0; i < ring.length; i++) {
          const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % ring.length];
          const dx = x2 - x1, dz = z2 - z1, length = Math.hypot(dx, dz) || 1;
          const nx = dz / length, nz = -dx / length;
          const base = positions.length / 3;
          positions.push(x1,foundationY,z1, x2,foundationY,z2, x1,roofY,z1, x2,roofY,z2);
          for (let vertex = 0; vertex < 4; vertex++) normals.push(nx, 0, nz);
          addColor(colors, wallColor, 4);
          indices.push(base,base + 2,base + 1, base + 1,base + 2,base + 3);
        }
      }

      // Minecraft/Roblox-inspired silhouette detail, still batched into the
      // building draw: most roofs get a low parapet and selected roofs a tank.
      // A parapet raises the whole-footprint camera span; a small central tank
      // does not, because doing so would create an oversized invisible blocker.
      let collisionTop = roofY;
      if (height > .72 && detailHash % 3 !== 1) {
        const parapetHeight = .08 + (detailHash % 3) * .025;
        collisionTop = roofY + parapetHeight;
        for (let index = 0; index < outer.length; index++) {
          const [x1, z1] = outer[index], [x2, z2] = outer[(index + 1) % outer.length];
          const dx = x2 - x1, dz = z2 - z1, length = Math.hypot(dx, dz) || 1;
          const base = positions.length / 3;
          positions.push(x1,roofY,z1, x2,roofY,z2, x1,roofY + parapetHeight,z1, x2,roofY + parapetHeight,z2);
          for (let vertex = 0; vertex < 4; vertex++) normals.push(dz / length, 0, -dx / length);
          addColor(colors, roofColor, 4);
          indices.push(base,base + 2,base + 1, base + 1,base + 2,base + 3);
        }
      }
      const slotSeed = detailHash;
      if (supportSlotStates.length >= MAX_SUPPORT_SLOTS) supportCapReached = true;
      const roofSlots = supportSlotStates.length < MAX_SUPPORT_SLOTS
        ? generateRoofSupportSlots(worldRings, {
          surfaceY: roofY,
          seed: slotSeed,
          maxSlots: 2,
        })
        : [];
      const remainingSlots = Math.max(0, MAX_SUPPORT_SLOTS - supportSlotStates.length);
      const acceptedSlots = roofSlots.slice(0, remainingSlots);
      const firstSupportSlot = supportSlotStates.length;
      appendPackedSupportSlots(supportSlotValues, acceptedSlots, MAX_SUPPORT_SLOTS);
      for (let index = 0; index < acceptedSlots.length; index++) supportSlotStates.push(0);
      const packedRoofSlots = acceptedSlots.map((slot, index) => Object.freeze({
        ...slot,
        id: firstSupportSlot + index + 1,
      }));
      const owner = `${request.tileX}:${request.tileY}:building:${detailHash.toString(36)}`;

      // Rooftop detail can only consume a declared, exact-fit support slot. If
      // the bounded slot budget is exhausted, the deterministic fallback skips
      // the detail rather than guessing at the AABB centre.
      if (detailHash % 4 === 0) {
        supportDetailAttempts++;
        if (acceptedSlots.length) {
          const localSlotIndex = detailHash % acceptedSlots.length;
          const slot = acceptedSlots[localSlotIndex];
          const tankColors = [[.72,.20,.025], [.025,.20,.38], [.09,.075,.055]];
          const recipe = createRoofTankRecipe({
            owner,
            support: { ...slot, id: firstSupportSlot + localSlotIndex + 1 },
            height: .18 + detailHash % 3 * .055,
            color: tankColors[detailHash % tankColors.length],
          });
          const compiled = compileObjectRecipe(recipe, { lod: 'far', maxModules: 2, maxBoxes: 3 });
          for (const box of compiled.visualBoxes) appendBox(
            positions, normals, colors, indices,
            box.centerX, box.bottom, box.centerZ,
            box.sizeX, box.sizeY, box.sizeZ, box.color,
          );
          objectRecipes++;
          objectModules += compiled.diagnostics.emittedModules;
          objectBoxes += compiled.diagnostics.emittedBoxes;
          objectBudgetSkips += compiled.diagnostics.skippedModules;
          supportSlotStates[firstSupportSlot + localSlotIndex] = 1;
          supportDetailSlotIndex = firstSupportSlot + localSlotIndex;
        } else supportDetailSkips++;
      }

      const wantsRoadFacing = buildingDetailEnabled || Boolean(landmarkRange);
      const remainingRoadTests = Math.max(0,
        GEO_BUILDING_DETAIL_LIMITS.maxRoadTestsPerTile - buildingDetailRoadTests);
      const roadFacing = wantsRoadFacing
        ? findRoadFacingEdge(outer, buildingRoadIndex, {
          maxTests: Math.min(GEO_BUILDING_DETAIL_LIMITS.maxRoadTestsPerBuilding, remainingRoadTests),
        })
        : Object.freeze({ found: false, source: 'none', tests: 0, candidates: 0, truncated: false });
      if (wantsRoadFacing) {
        buildingDetailRoadTests += roadFacing.tests;
        buildingDetailQueryCapReached ||= roadFacing.truncated || remainingRoadTests === 0;
      }
      if (buildingDetailEnabled) {
        buildingDetailRoadFacing += Number(roadFacing.found);
        const availableRoofSlots = packedRoofSlots.filter((slot, index) =>
          supportSlotStates[firstSupportSlot + index] === 0);
        const canCompileFacade = roadFacing.found && roadFacing.edgeLength >= .38;
        if (canCompileFacade || availableRoofSlots.length) {
          buildingDetailCandidateCount++;
          buildingDetailCandidates.push(Object.freeze({
            id: `${owner}:detail`,
            priority: (canCompileFacade ? 1_000_000_000 : 0) +
              Math.min(1_000_000, footprintArea * 1_000) + detailHash / 0x1_0000_0000,
            input: Object.freeze({
              id: `${owner}:detail`,
              owner,
              rings: worldRings,
              foundationY,
              roofY,
              height,
              hash: detailHash,
              wallColor,
              roofColor,
              roadFacing,
              roofSlots: availableRoofSlots,
            }),
          }));
          buildingDetailCandidates.sort((first, second) =>
            second.priority - first.priority || first.id.localeCompare(second.id));
          if (buildingDetailCandidates.length > GEO_BUILDING_DETAIL_LIMITS.selectedBuildingsPerTile) {
            buildingDetailCandidates.pop();
          }
        }
      }
      if (landmarkRange) {
        const formSignal = landmarkSignalFromProperties(feature.properties);
        landmarkRange.vertexEnd = positions.length / 3;
        landmarkRange.indexEnd = indices.length;
        landmarkRange.tankSlotIndex = supportDetailSlotIndex;
        // Keyed by the mapped building owner so facade detail can defer to the
        // hero that replaced that shell.
        landmarkRanges.set(owner, landmarkRange);
        landmarkCandidates.push(Object.freeze({
          id: `${owner}:landmark`,
          owner,
          formSignal,
          input: Object.freeze({
            id: `${owner}:landmark`,
            owner,
            rings: worldRings,
            foundationY,
            roofY,
            height,
            hash: detailHash,
            wallColor,
            roofColor,
            formSignal,
            roadFacing,
          }),
        }));
      }
      for (const ring of worldRings) {
        for (const [x, z] of ring) collisionVertices.push(x, z);
        collisionRingOffsets.push(collisionVertices.length / 2);
      }
      collisionPolygonOffsets.push(collisionRingOffsets.length - 1);
      if (landmarkRange) landmarkRange.colliderIndex = colliderValues.length / 4;
      colliderValues.push(minX, minZ, maxX, maxZ);
      collisionSpans.push(foundationY, collisionTop);
      collisionMasks.push(GEO_LAYER.building.queryMask);
      featureUsed = true;
    }
    if (featureUsed) features++;
  }

  // DET-09: at most one hero per tile. Ranking happens before the detail pass so
  // a hero can own its openings instead of inheriting the shell's facade detail.
  const landmarkSelection = landmarkCandidates.length
    ? compileLandmarks(landmarkCandidates.map(candidate => candidate.input))
    : Object.freeze({
      namespace: GDO_LANDMARK_NAMESPACE,
      heroes: Object.freeze([]), considered: 0, eligible: 0, selected: 0, boxes: 0, bytes: 0,
      rejected: Object.freeze({ boxes: 0, bytes: 0, malformed: 0 }),
      truncated: false,
      capEvents: Object.freeze({ heroes: false, boxes: false, bytes: false, malformed: false }),
    });
  const landmarkOwnerSet = new Set(landmarkSelection.heroes.map(hero => hero.owner));
  const selectedBuildingDetails = selectBuildingDetailCandidates(buildingDetailCandidates);
  let selectedDetailBuildings = 0, selectedDetailBoxes = 0, detailBoxCapReached = false;
  let detailLandmarkSkips = 0;
  for (const candidate of selectedBuildingDetails) {
    // A hero already owns its walls and openings, so the facade/roof detail of
    // the shell it replaced is skipped instead of floating inside its arch.
    if (landmarkOwnerSet.has(candidate.input.owner)) {
      detailLandmarkSkips++;
      continue;
    }
    const detail = createBuildingDetailRecipe(candidate.input);
    const boxes = detail.compiled.visualBoxes;
    if (selectedDetailBoxes + boxes.length > GEO_BUILDING_DETAIL_LIMITS.boxesPerTile) {
      detailBoxCapReached = true;
      continue;
    }
    for (const box of boxes) appendBox(
      detailPositions, detailNormals, detailColors, detailIndices,
      box.centerX, box.bottom, box.centerZ,
      box.sizeX, box.sizeY, box.sizeZ, box.color, box.yaw,
    );
    for (const id of detail.roofSlotIds) {
      const index = id - 1;
      if (index >= 0 && index < supportSlotStates.length && supportSlotStates[index] === 0) supportSlotStates[index] = 1;
    }
    selectedDetailBuildings++;
    selectedDetailBoxes += boxes.length;
    objectRecipes++;
    objectModules += detail.compiled.diagnostics.emittedModules;
    objectBoxes += detail.compiled.diagnostics.emittedBoxes;
    objectBudgetSkips += detail.compiled.diagnostics.skippedModules;
  }
  const detailTriangles = detailIndices.length / 3;
  const detailBytes = (detailPositions.length + detailNormals.length + detailColors.length + detailIndices.length) * 4;
  if (detailTriangles > GEO_BUILDING_DETAIL_LIMITS.trianglesPerTile ||
      detailBytes > GEO_BUILDING_DETAIL_LIMITS.bytesPerTile) {
    throw new Error('Building detail exceeded its fixed geometry budget');
  }

  // A hero replaces the plain extruded shell it was chosen from and swaps that
  // footprint's single enclosing collider for one tight box per load-bearing
  // module, so its reserved arches and doors stay genuinely open. Ornament never
  // becomes collision.
  let landmarkSuppressedVertices = 0, landmarkCompoundColliders = 0;
  let landmarkHiddenFaces = 0, landmarkContainedBoxes = 0;
  const landmarkForms = [];
  for (const hero of landmarkSelection.heroes) {
    const range = landmarkRanges.get(hero.owner);
    if (!range) continue;
    const removed = suppressGeometryRange(positions, normals, colors, indices, range);
    landmarkSuppressedVertices += removed.vertices;
    // The mapped polygon's collider is disabled in place and replaced by tight
    // module compounds, so no landmark keeps one enclosing AABB.
    collisionMasks[range.colliderIndex] = 0;
    if (range.tankSlotIndex >= 0 && supportSlotStates[range.tankSlotIndex] === 1) {
      supportSlotStates[range.tankSlotIndex] = 0;
      supportDetailSkips++;
    }
    for (const compound of hero.compounds) {
      if (!compound.structural) continue;
      appendCompoundCollider(colliderValues, collisionVertices, collisionRingOffsets,
        collisionPolygonOffsets, collisionSpans, collisionMasks, compound,
        GEO_LAYER.building.queryMask);
      landmarkCompoundColliders++;
    }
    // The hero's hidden-face-compiled shell is appended as-is: re-expanding its
    // boxes would throw the hidden-face reduction away.
    const base = landmarkPositions.length / 3;
    for (const value of hero.geometry.positions) landmarkPositions.push(value);
    for (const value of hero.geometry.normals) landmarkNormals.push(value);
    for (const value of hero.geometry.colors) landmarkColors.push(value);
    for (const index of hero.geometry.indices) landmarkIndices.push(base + index);
    landmarkForms.push(hero.form);
    landmarkHiddenFaces += hero.diagnostics.hiddenFaces;
    landmarkContainedBoxes += hero.diagnostics.containedBoxes;
  }
  const landmarkTriangles = landmarkIndices.length / 3;
  const landmarkBytes = (landmarkPositions.length + landmarkNormals.length +
    landmarkColors.length + landmarkIndices.length) * 4;
  if (landmarkTriangles > GEO_LANDMARK_LIMITS.maxTrianglesPerHero * GEO_LANDMARK_LIMITS.heroesPerTile ||
      landmarkBytes > GEO_LANDMARK_LIMITS.bytesPerTile * GEO_LANDMARK_LIMITS.heroesPerTile) {
    throw new Error('Landmark hero exceeded its fixed geometry budget');
  }
  const landmarkDiagnostics = Object.freeze({
    namespace: GDO_LANDMARK_NAMESPACE,
    candidates: landmarkCandidates.length,
    eligible: landmarkSelection.eligible,
    considered: landmarkSelection.considered,
    selected: landmarkSelection.heroes.length,
    forms: Object.freeze(landmarkForms),
    boxes: landmarkSelection.heroes.reduce((total, hero) => total + hero.boxes.length, 0),
    triangles: landmarkTriangles,
    bytes: landmarkBytes,
    suppressedVertices: landmarkSuppressedVertices,
    compoundColliders: landmarkCompoundColliders,
    detailDeferrals: detailLandmarkSkips,
    openings: landmarkSelection.heroes.reduce((total, hero) => total + hero.diagnostics.openings, 0),
    passableOpenings: landmarkSelection.heroes.reduce((total, hero) => total + hero.diagnostics.passableOpenings, 0),
    structuralCompounds: landmarkSelection.heroes.reduce((total, hero) => total + hero.diagnostics.structuralCompounds, 0),
    enclosingCompounds: landmarkSelection.heroes.reduce((total, hero) => total + hero.diagnostics.enclosingCompounds, 0),
    hiddenFaces: landmarkHiddenFaces,
    containedBoxes: landmarkContainedBoxes,
    // Bounded per-hero descriptors for the resident pool: counts plus the tight
    // structural compounds, never a hero-wide box.
    heroes: Object.freeze(landmarkSelection.heroes.map(hero => Object.freeze({
      namespace: GDO_LANDMARK_NAMESPACE,
      id: hero.id,
      form: hero.form,
      formSource: hero.formSource,
      boxes: hero.boxes.length,
      triangles: hero.geometry.triangles,
      bytes: hero.geometry.bytes,
      hiddenFaces: hero.diagnostics.hiddenFaces,
      containedBoxes: hero.diagnostics.containedBoxes,
      openings: hero.diagnostics.openings,
      passableOpenings: hero.diagnostics.passableOpenings,
      structuralCompounds: hero.diagnostics.structuralCompounds,
      enclosingCompounds: hero.diagnostics.enclosingCompounds,
      sealedOpenings: hero.diagnostics.sealedOpenings,
      // Approach axis plus the walkable voids, small enough to audit: a passage
      // must stay clear of every compound at every sampled height.
      axis: Object.freeze([hero.axis[0], hero.axis[1]]),
      bounds: Object.freeze([hero.bounds.minimumX, hero.bounds.minimumZ,
        hero.bounds.maximumX, hero.bounds.maximumZ]),
      passages: Object.freeze(hero.openings.filter(opening => opening.passable && opening.kind !== 'corridor')
        .map(opening => Object.freeze([
          opening.minimumX, opening.minimumY, opening.minimumZ,
          opening.maximumX, opening.maximumY, opening.maximumZ,
        ]))),
      compounds: Object.freeze(hero.compounds.filter(compound => compound.structural)
        .map(compound => Object.freeze([
          compound.minimumX, compound.minimumY, compound.minimumZ,
          compound.maximumX, compound.maximumY, compound.maximumZ,
        ]))),
    }))),
    capEvents: Object.freeze({
      ...landmarkSelection.capEvents,
      compounds: landmarkSelection.heroes.some(hero => hero.diagnostics.capEvents.compounds),
      structuralCompounds: landmarkSelection.heroes.some(hero => hero.diagnostics.capEvents.structuralCompounds),
    }),
  });

  return {
    ...geometryResult(positions, normals, colors, indices, {
      features,
      truncated,
      supportSlots: supportSlotStates.length,
      occupiedSupportSlots: supportSlotStates.filter(state => state !== 0).length,
      supportDetailAttempts,
      supportDetailSkips,
      supportCapReached,
      objectRecipes,
      objectModules,
      objectBoxes,
      objectBudgetSkips,
      landmarkGrammar: landmarkDiagnostics,
      buildingGrammar: Object.freeze({
        namespace: GDO_BUILDING_GRAMMAR_NAMESPACE,
        candidates: buildingDetailCandidateCount,
        selectedBuildings: selectedDetailBuildings,
        roadFacingBuildings: buildingDetailRoadFacing,
        roadSegments: buildingRoadIndex.meta.segments,
        roadCellReferences: buildingRoadIndex.meta.cellReferences,
        roadTests: buildingDetailRoadTests,
        boxes: selectedDetailBoxes,
        triangles: detailTriangles,
        bytes: detailBytes,
        capEvents: Object.freeze({
          roadSegments: sourceRoads.truncated || buildingRoadIndex.meta.truncated,
          roadTests: buildingDetailQueryCapReached,
          selectedBuildings: buildingDetailCandidateCount > GEO_BUILDING_DETAIL_LIMITS.selectedBuildingsPerTile,
          boxes: detailBoxCapReached,
          bytes: false,
        }),
      }),
    }),
    landmarkPositions: new Float32Array(landmarkPositions),
    landmarkNormals: new Float32Array(landmarkNormals),
    landmarkColors: new Float32Array(landmarkColors),
    landmarkIndices: new Uint32Array(landmarkIndices),
    detailPositions: new Float32Array(detailPositions),
    detailNormals: new Float32Array(detailNormals),
    detailColors: new Float32Array(detailColors),
    detailIndices: new Uint32Array(detailIndices),
    colliders: new Float32Array(colliderValues),
    collisionVertices: new Float32Array(collisionVertices),
    collisionRingOffsets: new Uint32Array(collisionRingOffsets),
    collisionPolygonOffsets: new Uint32Array(collisionPolygonOffsets),
    collisionSpans: new Float32Array(collisionSpans),
    collisionMasks: new Uint16Array(collisionMasks),
    supportSlots: new Float32Array(supportSlotValues),
    supportSlotStates: new Uint8Array(supportSlotStates),
    supportSlotStride: GEO_SUPPORT_SLOT_STRIDE,
  };
}
