import { featureNamespace } from '../engine/FeatureVersions.js';
import {
  GEO_OBJECT_LOD,
  compileObjectRecipe,
  createObjectRecipe,
} from './GeoObjectRecipe.js';
import { GEO_SUPPORT_ROLE, rectangleFitsSupport } from './GeoSupportSlots.js';

export const GDO_BUILDING_GRAMMAR_NAMESPACE = featureNamespace('objectGrammar');

export const GEO_BUILDING_DETAIL_LIMITS = Object.freeze({
  selectedBuildingsPerTile: 8,
  modulesPerBuilding: 8,
  boxesPerBuilding: 20,
  boxesPerTile: 96,
  trianglesPerTile: 20_000,
  bytesPerTile: 256 * 1024,
  addedDrawCalls: 1,
  maxRoadSegments: 4_096,
  maxRoadCellReferences: 32_768,
  maxRoadQueryCells: 256,
  maxRoadCandidatesPerBuilding: 512,
  maxRoadTestsPerBuilding: 256,
  maxRoadTestsPerTile: 32_768,
  roadCellSize: 8,
  maximumRoadDistance: 48,
});

function mix32(value) {
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function finitePoint(point) {
  return Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function segmentValue(item) {
  return Array.isArray(item) ? item : item?.segment;
}

function cellKey(x, z) { return `${x}:${z}`; }

/** Build one bounded road index for all building facade decisions in a source tile. */
export function createBuildingRoadIndex(segments, {
  maxSegments = GEO_BUILDING_DETAIL_LIMITS.maxRoadSegments,
  maxCellReferences = GEO_BUILDING_DETAIL_LIMITS.maxRoadCellReferences,
  cellSize = GEO_BUILDING_DETAIL_LIMITS.roadCellSize,
} = {}) {
  if (!Number.isInteger(maxSegments) || maxSegments < 0 ||
      !Number.isInteger(maxCellReferences) || maxCellReferences < 0 ||
      !Number.isFinite(cellSize) || cellSize <= 0) {
    throw new RangeError('Invalid building-road index limits');
  }
  const input = Array.isArray(segments) ? segments : [];
  const records = [], cells = new Map();
  let malformed = Number(segments != null && !Array.isArray(segments));
  let cellReferences = 0, truncated = false;
  let indexedMinimumCellX = Infinity, indexedMaximumCellX = -Infinity;
  let indexedMinimumCellZ = Infinity, indexedMaximumCellZ = -Infinity;
  for (let sourceIndex = 0; sourceIndex < input.length; sourceIndex++) {
    if (records.length >= maxSegments) { truncated = true; break; }
    const value = segmentValue(input[sourceIndex]);
    if (!Array.isArray(value) || value.length < 4 || !value.slice(0, 4).every(Number.isFinite)) {
      malformed++;
      continue;
    }
    const [x1, z1, x2, z2] = value;
    if (Math.hypot(x2 - x1, z2 - z1) < 1e-6) { malformed++; continue; }
    const minimumCellX = Math.floor(Math.min(x1, x2) / cellSize);
    const maximumCellX = Math.floor(Math.max(x1, x2) / cellSize);
    const minimumCellZ = Math.floor(Math.min(z1, z2) / cellSize);
    const maximumCellZ = Math.floor(Math.max(z1, z2) / cellSize);
    const references = (maximumCellX - minimumCellX + 1) * (maximumCellZ - minimumCellZ + 1);
    if (cellReferences + references > maxCellReferences) { truncated = true; break; }
    const index = records.length;
    records.push(Object.freeze({ x1, z1, x2, z2, sourceIndex }));
    indexedMinimumCellX = Math.min(indexedMinimumCellX, minimumCellX);
    indexedMaximumCellX = Math.max(indexedMaximumCellX, maximumCellX);
    indexedMinimumCellZ = Math.min(indexedMinimumCellZ, minimumCellZ);
    indexedMaximumCellZ = Math.max(indexedMaximumCellZ, maximumCellZ);
    for (let cellX = minimumCellX; cellX <= maximumCellX; cellX++) {
      for (let cellZ = minimumCellZ; cellZ <= maximumCellZ; cellZ++) {
        const key = cellKey(cellX, cellZ);
        let values = cells.get(key);
        if (!values) cells.set(key, values = []);
        values.push(index);
        cellReferences++;
      }
    }
  }
  return Object.freeze({
    namespace: GDO_BUILDING_GRAMMAR_NAMESPACE,
    records: Object.freeze(records),
    cells,
    cellSize,
    cellBounds: records.length ? Object.freeze({
      minimumCellX: indexedMinimumCellX,
      maximumCellX: indexedMaximumCellX,
      minimumCellZ: indexedMinimumCellZ,
      maximumCellZ: indexedMaximumCellZ,
    }) : null,
    meta: Object.freeze({ segments: records.length, cellReferences, malformed, truncated }),
  });
}

function orientation(ax, az, bx, bz, cx, cz) {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

function pointSegmentDistance(x, z, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const denominator = dx * dx + dz * dz;
  const amount = denominator > 1e-12
    ? Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / denominator)) : 0;
  return Math.hypot(x - (x1 + dx * amount), z - (z1 + dz * amount));
}

function between(value, first, second) {
  return value >= Math.min(first, second) - 1e-9 && value <= Math.max(first, second) + 1e-9;
}

function segmentDistance(ax, az, bx, bz, cx, cz, dx, dz) {
  const first = orientation(ax, az, bx, bz, cx, cz);
  const second = orientation(ax, az, bx, bz, dx, dz);
  const third = orientation(cx, cz, dx, dz, ax, az);
  const fourth = orientation(cx, cz, dx, dz, bx, bz);
  const strictCrossing = ((first > 1e-9 && second < -1e-9) || (first < -1e-9 && second > 1e-9)) &&
    ((third > 1e-9 && fourth < -1e-9) || (third < -1e-9 && fourth > 1e-9));
  const touches = Math.abs(first) <= 1e-9 && between(cx, ax, bx) && between(cz, az, bz) ||
    Math.abs(second) <= 1e-9 && between(dx, ax, bx) && between(dz, az, bz) ||
    Math.abs(third) <= 1e-9 && between(ax, cx, dx) && between(az, cz, dz) ||
    Math.abs(fourth) <= 1e-9 && between(bx, cx, dx) && between(bz, cz, dz);
  if (strictCrossing || touches) return 0;
  return Math.min(
    pointSegmentDistance(ax, az, cx, cz, dx, dz),
    pointSegmentDistance(bx, bz, cx, cz, dx, dz),
    pointSegmentDistance(cx, cz, ax, az, bx, bz),
    pointSegmentDistance(dx, dz, ax, az, bx, bz),
  );
}

function signedArea(ring) {
  let area = 0;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    area += ring[previous][0] * ring[index][1] - ring[index][0] * ring[previous][1];
  }
  return area / 2;
}

function canonicalEdgeKey(first, second) {
  const forward = first[0] < second[0] || first[0] === second[0] && first[1] <= second[1];
  return forward
    ? [first[0], first[1], second[0], second[1]]
    : [second[0], second[1], first[0], first[1]];
}

function compareNumericKeys(first, second) {
  for (let index = 0; index < first.length; index++) {
    const difference = first[index] - second[index];
    if (difference) return difference;
  }
  return 0;
}

/** Find the geometrically nearest mapped-road-facing outer wall under fixed query/test caps. */
export function findRoadFacingEdge(ring, roadIndex, {
  maximumDistance = GEO_BUILDING_DETAIL_LIMITS.maximumRoadDistance,
  maxQueryCells = GEO_BUILDING_DETAIL_LIMITS.maxRoadQueryCells,
  maxCandidates = GEO_BUILDING_DETAIL_LIMITS.maxRoadCandidatesPerBuilding,
  maxTests = GEO_BUILDING_DETAIL_LIMITS.maxRoadTestsPerBuilding,
} = {}) {
  if (!Array.isArray(ring) || ring.length < 3 || !ring.every(finitePoint) ||
      !roadIndex?.records || !(roadIndex.cells instanceof Map)) {
    return Object.freeze({ found: false, source: 'none', tests: 0, candidates: 0, truncated: false });
  }
  if (!Number.isFinite(maximumDistance) || maximumDistance < 0 ||
      !Number.isInteger(maxQueryCells) || maxQueryCells < 0 ||
      !Number.isInteger(maxCandidates) || maxCandidates < 0 ||
      !Number.isInteger(maxTests) || maxTests < 0) {
    throw new RangeError('Invalid road-facing query limits');
  }
  let minimumX = Infinity, minimumZ = Infinity, maximumX = -Infinity, maximumZ = -Infinity;
  for (const [x, z] of ring) {
    minimumX = Math.min(minimumX, x); minimumZ = Math.min(minimumZ, z);
    maximumX = Math.max(maximumX, x); maximumZ = Math.max(maximumZ, z);
  }
  if (!roadIndex.cellBounds || roadIndex.meta?.truncated) {
    return Object.freeze({
      found: false, source: 'none', tests: 0, candidates: 0, queryCells: 0,
      truncated: Boolean(roadIndex.meta?.truncated),
    });
  }
  const cellSize = roadIndex.cellSize;
  const minimumCellX = Math.max(roadIndex.cellBounds.minimumCellX, Math.floor((minimumX - maximumDistance) / cellSize));
  const maximumCellX = Math.min(roadIndex.cellBounds.maximumCellX, Math.floor((maximumX + maximumDistance) / cellSize));
  const minimumCellZ = Math.max(roadIndex.cellBounds.minimumCellZ, Math.floor((minimumZ - maximumDistance) / cellSize));
  const maximumCellZ = Math.min(roadIndex.cellBounds.maximumCellZ, Math.floor((maximumZ + maximumDistance) / cellSize));
  const candidateIds = new Set();
  let queryCells = 0, truncated = false;
  query: for (let cellX = minimumCellX; cellX <= maximumCellX; cellX++) {
    for (let cellZ = minimumCellZ; cellZ <= maximumCellZ; cellZ++) {
      if (queryCells >= maxQueryCells) { truncated = true; break query; }
      queryCells++;
      for (const id of roadIndex.cells.get(cellKey(cellX, cellZ)) ?? []) {
        if (candidateIds.size >= maxCandidates && !candidateIds.has(id)) { truncated = true; break query; }
        candidateIds.add(id);
      }
    }
  }
  const candidateValues = [...candidateIds].sort((first, second) => first - second);
  if (truncated) return Object.freeze({
    found: false, source: 'none', tests: 0, candidates: candidateValues.length, queryCells, truncated: true,
  });
  let best = null, tests = 0;
  test: for (let edgeIndex = 0; edgeIndex < ring.length; edgeIndex++) {
    const first = ring[edgeIndex], second = ring[(edgeIndex + 1) % ring.length];
    const edgeLength = Math.hypot(second[0] - first[0], second[1] - first[1]);
    if (edgeLength < .18) continue;
    const edgeKey = canonicalEdgeKey(first, second);
    for (const roadId of candidateValues) {
      if (tests >= maxTests) { truncated = true; break test; }
      tests++;
      const road = roadIndex.records[roadId];
      const roadDeltaX = road.x2 - road.x1, roadDeltaZ = road.z2 - road.z1;
      const alignment = Math.abs(((second[0] - first[0]) * roadDeltaX +
        (second[1] - first[1]) * roadDeltaZ) / (edgeLength * Math.hypot(roadDeltaX, roadDeltaZ)));
      if (alignment < .25) continue;
      const distance = segmentDistance(
        first[0], first[1], second[0], second[1], road.x1, road.z1, road.x2, road.z2,
      );
      const distanceTie = best && Math.abs(distance - best.distance) <= 1e-9;
      const alignmentTie = distanceTie && Math.abs(alignment - best.alignment) <= 1e-9;
      const edgeComparison = alignmentTie ? compareNumericKeys(edgeKey, best.edgeKey) : 0;
      if (distance > maximumDistance || best && (distance > best.distance + 1e-9 ||
          distanceTie && (alignment < best.alignment - 1e-9 || alignmentTie &&
            (edgeComparison > 0 || edgeComparison === 0 && roadId >= best.roadId)))) continue;
      best = { edgeIndex, edgeKey, roadId, distance, alignment, first, second, edgeLength };
    }
  }
  if (truncated || !best) return Object.freeze({
    found: false, source: 'none', tests, candidates: candidateValues.length, queryCells, truncated,
  });
  const dx = best.second[0] - best.first[0], dz = best.second[1] - best.first[1];
  const inverseLength = 1 / best.edgeLength;
  let tangentX = dx * inverseLength, tangentZ = dz * inverseLength;
  const counterClockwise = signedArea(ring) > 0;
  let normalX = counterClockwise ? tangentZ : -tangentZ;
  let normalZ = counterClockwise ? -tangentX : tangentX;
  if (tangentX < 0 || Math.abs(tangentX) <= 1e-12 && tangentZ < 0) {
    tangentX = -tangentX;
    tangentZ = -tangentZ;
  }
  if (Math.abs(tangentX) <= 1e-12) tangentX = 0;
  if (Math.abs(tangentZ) <= 1e-12) tangentZ = 0;
  if (Math.abs(normalX) <= 1e-12) normalX = 0;
  if (Math.abs(normalZ) <= 1e-12) normalZ = 0;
  return Object.freeze({
    found: true,
    source: 'mapped-road',
    edgeIndex: best.edgeIndex,
    roadId: best.roadId,
    distance: best.distance,
    centerX: (best.first[0] + best.second[0]) / 2,
    centerZ: (best.first[1] + best.second[1]) / 2,
    edgeLength: best.edgeLength,
    tangentX,
    tangentZ,
    normalX,
    normalZ,
    yaw: Math.atan2(tangentZ, tangentX),
    tests,
    candidates: candidateValues.length,
    queryCells,
    truncated,
  });
}

function scaledColor(color, scale, bias = 0) {
  return color.map(value => Math.max(0, Math.min(1, value * scale + bias)));
}

function facadeBox(facing, bottom, width, height, depth, outward, color, tangentOffset = 0) {
  return {
    centerX: facing.centerX + facing.tangentX * tangentOffset + facing.normalX * outward,
    bottom,
    centerZ: facing.centerZ + facing.tangentZ * tangentOffset + facing.normalZ * outward,
    sizeX: width,
    sizeY: height,
    sizeZ: depth,
    yaw: facing.yaw,
    color,
  };
}

function validRoofSlot(slot, rings) {
  return slot && Number.isInteger(slot.id) && slot.id > 0 &&
    (slot.roleMask & GEO_SUPPORT_ROLE.ROOF_DETAIL) !== 0 &&
    [slot.x, slot.y, slot.z, slot.halfWidth, slot.halfDepth].every(Number.isFinite) &&
    slot.halfWidth > 0 && slot.halfDepth > 0 &&
    rectangleFitsSupport(rings, slot.x, slot.z, slot.halfWidth, slot.halfDepth, 0);
}

function visualBoundsForModules(modules) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let count = 0;
  for (const module of modules) for (const box of module.boxes ?? []) {
    const yaw = box.yaw ?? 0, cosine = Math.cos(yaw), sine = Math.sin(yaw);
    const halfX = Math.abs(cosine) * box.sizeX / 2 + Math.abs(sine) * box.sizeZ / 2;
    const halfZ = Math.abs(sine) * box.sizeX / 2 + Math.abs(cosine) * box.sizeZ / 2;
    minX = Math.min(minX, box.centerX - halfX); maxX = Math.max(maxX, box.centerX + halfX);
    minY = Math.min(minY, box.bottom); maxY = Math.max(maxY, box.bottom + box.sizeY);
    minZ = Math.min(minZ, box.centerZ - halfZ); maxZ = Math.max(maxZ, box.centerZ + halfZ);
    count++;
  }
  return count ? { minX, minY, minZ, maxX, maxY, maxZ } : null;
}

/** Compile one selected building into bounded role-labelled, visual-only modules. */
export function createBuildingDetailRecipe({
  id,
  owner,
  rings,
  foundationY,
  roofY,
  height,
  hash = 0,
  wallColor,
  roofColor,
  roadFacing = null,
  roofSlots = [],
} = {}) {
  if (typeof id !== 'string' || !id || typeof owner !== 'string' || !owner ||
      !Array.isArray(rings) || !rings.length || rings.some(ring => !Array.isArray(ring) || ring.length < 3 || !ring.every(finitePoint)) ||
      ![foundationY, roofY, height].every(Number.isFinite) || height <= 0 || roofY <= foundationY ||
      !Array.isArray(wallColor) || wallColor.length !== 3 || !wallColor.every(Number.isFinite) ||
      !Array.isArray(roofColor) || roofColor.length !== 3 || !roofColor.every(Number.isFinite)) {
    throw new TypeError('Building detail recipes require finite mapped geometry, height, and colors');
  }
  const stableHash = hash >>> 0;
  const slots = (Array.isArray(roofSlots) ? roofSlots : []).filter(slot => validRoofSlot(slot, rings));
  let minimumX = Infinity, minimumZ = Infinity, maximumX = -Infinity, maximumZ = -Infinity;
  for (const [x, z] of rings[0]) {
    minimumX = Math.min(minimumX, x); minimumZ = Math.min(minimumZ, z);
    maximumX = Math.max(maximumX, x); maximumZ = Math.max(maximumZ, z);
  }
  const support = {
    id: (mix32(stableHash ^ 0xa3c59a) & 0x00ffffff) || 1,
    roleMask: GEO_SUPPORT_ROLE.BUILDING_DETAIL |
      (roadFacing?.found ? GEO_SUPPORT_ROLE.FACADE_DETAIL : 0) |
      (slots.length ? GEO_SUPPORT_ROLE.ROOF_DETAIL : 0),
    x: (minimumX + maximumX) / 2,
    y: foundationY,
    z: (minimumZ + maximumZ) / 2,
    halfWidth: Math.max(.01, (maximumX - minimumX) / 2),
    halfDepth: Math.max(.01, (maximumZ - minimumZ) / 2),
    yaw: 0,
  };
  const silhouette = [], surface = [], accents = [];
  const entrance = roadFacing?.found && roadFacing.edgeLength >= .38;
  let entranceBounds = null;
  if (entrance) {
    const doorWidth = Math.min(.42, Math.max(.22, roadFacing.edgeLength * .28));
    const doorHeight = Math.min(.36, Math.max(.24, height * .34));
    const panelDepth = .025;
    const doorColor = scaledColor(wallColor, .32, .015);
    const door = facadeBox(roadFacing, foundationY + .012, doorWidth, doorHeight, panelDepth, .016, doorColor);
    const trimWidth = Math.min(.025, doorWidth * .1);
    const trimOffset = (doorWidth + trimWidth) / 2;
    const entranceBoxes = [door];
    for (const side of [-1, 1]) entranceBoxes.push(facadeBox(
      roadFacing, foundationY + .012, trimWidth, doorHeight, panelDepth + .008, .021,
      scaledColor(roofColor, .82), side * trimOffset,
    ));
    surface.push({ id: 'road-entrance', minimumLod: GEO_OBJECT_LOD.MID, order: 0, boxes: entranceBoxes });
    const canopyWidth = Math.min(roadFacing.edgeLength * .48, doorWidth + .18);
    const canopy = facadeBox(
      roadFacing, foundationY + doorHeight * .9, canopyWidth, .026, .15, .072,
      scaledColor(roofColor, .88),
    );
    surface.push({ id: 'entrance-canopy', minimumLod: GEO_OBJECT_LOD.NEAR, order: 1, boxes: [canopy] });
    entranceBounds = Object.freeze({
      minimumAlong: -canopyWidth / 2,
      maximumAlong: canopyWidth / 2,
      bottom: foundationY,
      top: foundationY + doorHeight + .04,
    });

    if (roadFacing.edgeLength >= .7 && height >= .7) {
      const corniceWidth = Math.min(roadFacing.edgeLength * .82, 1.2);
      surface.push({
        id: 'facade-cornice', minimumLod: GEO_OBJECT_LOD.MID, order: 2,
        boxes: [facadeBox(roadFacing, roofY - .075, corniceWidth, .035, .045, .024, scaledColor(roofColor, .92))],
      });
    }
    if (roadFacing.edgeLength >= .85 && height >= 1.05 && (stableHash & 1) === 0) {
      const balconyWidth = Math.min(roadFacing.edgeLength * .54, .82);
      const balconyBottom = foundationY + height * .56;
      const slab = facadeBox(roadFacing, balconyBottom, balconyWidth, .035, .18, .09, scaledColor(roofColor, .86));
      const rail = facadeBox(roadFacing, balconyBottom + .04, balconyWidth, .13, .025, .18, scaledColor(wallColor, .62, .03));
      surface.push({ id: 'balcony-rhythm', minimumLod: GEO_OBJECT_LOD.NEAR, order: 3, boxes: [slab, rail] });
    }
    if (roadFacing.edgeLength >= .62 && height >= .75 && stableHash % 3 === 0) {
      const offset = Math.min(roadFacing.edgeLength * .28, .34) * (stableHash & 2 ? 1 : -1);
      accents.push({
        id: 'facade-utility', minimumLod: GEO_OBJECT_LOD.NEAR, order: 0,
        boxes: [facadeBox(
          roadFacing, foundationY + Math.min(height * .62, .58), .13, .12, .055, .035,
          scaledColor(wallColor, .48, .04), offset,
        )],
      });
    }
  }

  if (slots.length) {
    const slot = slots[0];
    const width = slot.halfWidth * 2, depth = slot.halfDepth * 2;
    if (stableHash % 3 === 0) {
      const stairHeight = Math.min(.32, Math.max(.18, height * .18));
      silhouette.push({
        id: 'roof-stair-head', minimumLod: GEO_OBJECT_LOD.FAR, order: 0,
        boxes: [{
          centerX: slot.x, bottom: slot.y + .012, centerZ: slot.z,
          sizeX: width * .78, sizeY: stairHeight, sizeZ: depth * .78,
          color: scaledColor(roofColor, .82),
        }],
      });
      accents.push({
        id: 'roof-stair-head-trim', minimumLod: GEO_OBJECT_LOD.NEAR, order: 1,
        boxes: [
          {
            centerX: slot.x, bottom: slot.y + .035, centerZ: slot.z + depth * .398,
            sizeX: width * .25, sizeY: stairHeight * .55, sizeZ: depth * .018,
            color: scaledColor(wallColor, .38, .02),
          },
          {
            centerX: slot.x, bottom: slot.y + stairHeight + .012, centerZ: slot.z,
            sizeX: width * .84, sizeY: .018, sizeZ: depth * .84,
            color: scaledColor(roofColor, .7, .03),
          },
          ...[-1, 1].map(side => ({
            centerX: slot.x + side * width * .25, bottom: slot.y + stairHeight + .03, centerZ: slot.z,
            sizeX: width * .1, sizeY: .1, sizeZ: depth * .1,
            color: scaledColor(roofColor, .54, .04),
          })),
        ],
      });
    } else if (stableHash % 3 === 1 && width >= .28) {
      const gap = Math.min(.025, width * .08);
      const panelWidth = (width * .82 - gap) / 2;
      const offset = (panelWidth + gap) / 2;
      const solarBoxes = [];
      for (const side of [-1, 1]) solarBoxes.push(
        {
          centerX: slot.x + side * offset, bottom: slot.y + .02, centerZ: slot.z,
          sizeX: panelWidth, sizeY: .025, sizeZ: depth * .72,
          color: [.025, .105, .16],
        },
        {
          centerX: slot.x + side * offset, bottom: slot.y + .012, centerZ: slot.z,
          sizeX: panelWidth * .18, sizeY: .02, sizeZ: depth * .18,
          color: scaledColor(roofColor, .5, .05),
        },
      );
      surface.push({ id: 'roof-solar-pair', minimumLod: GEO_OBJECT_LOD.NEAR, order: 4, boxes: solarBoxes });
    } else {
      const ventBoxes = [];
      for (const side of [-1, 1]) {
        const centerX = slot.x + side * width * .18;
        ventBoxes.push(
          {
            centerX, bottom: slot.y + .012, centerZ: slot.z,
            sizeX: width * .18, sizeY: .15, sizeZ: depth * .22,
            color: scaledColor(roofColor, .58, .04),
          },
          {
            centerX, bottom: slot.y + .162, centerZ: slot.z,
            sizeX: width * .23, sizeY: .025, sizeZ: depth * .27,
            color: scaledColor(roofColor, .5, .055),
          },
        );
      }
      accents.push({ id: 'roof-vent-pair', minimumLod: GEO_OBJECT_LOD.NEAR, order: 1, boxes: ventBoxes });
    }
  }

  const recipe = createObjectRecipe({
    id,
    owner,
    support,
    authoritativeFootprint: 'mapped-building-rings',
    height,
    silhouette,
    surface,
    accents,
    visualBounds: visualBoundsForModules([...silhouette, ...surface, ...accents]),
    solidProxies: [],
    interactionProxies: [],
    cameraRoles: [],
  });
  const compiled = compileObjectRecipe(recipe, {
    lod: GEO_OBJECT_LOD.NEAR,
    maxModules: GEO_BUILDING_DETAIL_LIMITS.modulesPerBuilding,
    maxBoxes: GEO_BUILDING_DETAIL_LIMITS.boxesPerBuilding,
  });
  return Object.freeze({
    namespace: GDO_BUILDING_GRAMMAR_NAMESPACE,
    recipe,
    compiled,
    entranceBounds,
    roadFacingSource: entrance ? 'mapped-road' : 'none',
    roofSlotIds: Object.freeze(slots.length ? [slots[0].id] : []),
  });
}

/** Stable priority selection prevents source iteration order from choosing the capped subset. */
export function selectBuildingDetailCandidates(candidates, limit = GEO_BUILDING_DETAIL_LIMITS.selectedBuildingsPerTile) {
  if (!Array.isArray(candidates) || !Number.isInteger(limit) || limit < 0 ||
      limit > GEO_BUILDING_DETAIL_LIMITS.selectedBuildingsPerTile) {
    throw new RangeError('Invalid building-detail candidate selection');
  }
  const valid = candidates.filter(candidate => candidate && typeof candidate.id === 'string' &&
    Number.isFinite(candidate.priority));
  valid.sort((first, second) => second.priority - first.priority || first.id.localeCompare(second.id));
  return Object.freeze(valid.slice(0, limit));
}
