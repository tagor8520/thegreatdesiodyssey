import { featureNamespace } from '../engine/FeatureVersions.js';

export const GDO_WATER_DOMAIN_NAMESPACE = featureNamespace('waterDomain');
// x1, z1, x2, z2, half-width, class, normalized flow-x, normalized flow-z
export const GEO_WATERWAY_STRIDE = 8;
export const GEO_WATER_FLOW_QUANTIZATION = 32_767;
export const GEO_WATER_DOMAIN_LIMITS = Object.freeze({
  maxWaterVertices: 16_384,
  maxWetlandVertices: 8_192,
  maxWaterwaySegments: 1_200,
  maxFlowAssociationTests: 32_768,
  maxWaterwayHalfWidth: 2.5,
  maxDomainBytes: 512 * 1024,
  shorelineWidth: .18,
  bankWidth: .58,
});

export const GEO_ECOLOGICAL_DOMAIN = Object.freeze({
  GROUND: 0,
  BANK: 1,
  SHORELINE: 2,
  WETLAND: 3,
  WATER: 4,
});

export const GEO_WATER_CLASS = Object.freeze({
  UNKNOWN: 0,
  STREAM: 1,
  CANAL: 2,
  RIVER: 3,
  LAKE: 4,
  OCEAN: 5,
});

export const GEO_WATER_CLASS_NAMES = Object.freeze([
  'unknown', 'stream', 'canal', 'river', 'lake', 'ocean',
]);

export const GEO_WATER_FLOW_SOURCE = Object.freeze({
  NONE: 0,
  WATERWAY: 1,
  POLYGON_WATERWAY: 2,
});

const FLOWING_CLASSES = new Set([
  GEO_WATER_CLASS.STREAM,
  GEO_WATER_CLASS.CANAL,
  GEO_WATER_CLASS.RIVER,
]);

function pointInRing(x, z, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, zi] = ring[index], [xj, zj] = ring[previous];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(x, z, rings) {
  if (!rings.length || !pointInRing(x, z, rings[0])) return false;
  for (let index = 1; index < rings.length; index++) if (pointInRing(x, z, rings[index])) return false;
  return true;
}

function orientation(ax, az, bx, bz, cx, cz) {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

function segmentsIntersect(first, second) {
  const [ax, az, bx, bz] = first, [cx, cz, dx, dz] = second;
  const o1 = orientation(ax, az, bx, bz, cx, cz);
  const o2 = orientation(ax, az, bx, bz, dx, dz);
  const o3 = orientation(cx, cz, dx, dz, ax, az);
  const o4 = orientation(cx, cz, dx, dz, bx, bz);
  return ((o1 > 1e-9 && o2 < -1e-9) || (o1 < -1e-9 && o2 > 1e-9)) &&
    ((o3 > 1e-9 && o4 < -1e-9) || (o3 < -1e-9 && o4 > 1e-9));
}

function pointInConvexQuad(x, z, quad) {
  let sign = 0;
  for (let index = 0; index < 4; index++) {
    const first = quad[index], second = quad[(index + 1) % 4];
    const side = orientation(first[0], first[1], second[0], second[1], x, z);
    if (Math.abs(side) <= 1e-9) continue;
    if (!sign) sign = Math.sign(side);
    else if (Math.sign(side) !== sign) return false;
  }
  return true;
}

/**
 * Conservative LAY-04 overlap test. A source waterway segment is omitted when
 * its complete ribbon would touch mapped polygon water; this avoids duplicate
 * transparent surfaces without runtime polygon booleans or unbounded clipping.
 */
export function waterwayRibbonIntersectsPolygons(segment, width, polygons) {
  const [x1, z1, x2, z2] = segment;
  const length = Math.hypot(x2 - x1, z2 - z1);
  if (!Number.isFinite(width) || width <= 0 || length < 1e-8 || !Array.isArray(polygons)) return false;
  const px = -(z2 - z1) / length * width / 2;
  const pz = (x2 - x1) / length * width / 2;
  const quad = [[x1 + px, z1 + pz], [x2 + px, z2 + pz], [x2 - px, z2 - pz], [x1 - px, z1 - pz]];
  const quadEdges = quad.map((point, index) => [...point, ...quad[(index + 1) % 4]]);
  for (const item of polygons) {
    const rings = Array.isArray(item) ? item : item?.rings;
    if (!Array.isArray(rings) || !rings.length) continue;
    if (quad.some(([x, z]) => pointInPolygon(x, z, rings))) return true;
    if (rings[0]?.some(([x, z]) => pointInConvexQuad(x, z, quad))) return true;
    for (const ring of rings) for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const edge = [...ring[previous], ...ring[index]];
      if (quadEdges.some(quadEdge => segmentsIntersect(edge, quadEdge))) return true;
    }
  }
  return false;
}

/** Provider-neutral map-truth classifier. Unknown input stays unknown. */
export function classifyWaterClass(value = '', fallback = '') {
  const values = value && typeof value === 'object' && !Array.isArray(value)
    ? [value.waterway, value.water, value.subclass, value.class, value.kind, value.type, value.natural, fallback]
    : [value, fallback];
  for (const item of values) {
    const text = String(item ?? '').toLowerCase();
    if (text.includes('ocean') || text.includes('sea') || text.includes('coast')) return GEO_WATER_CLASS.OCEAN;
    if (text.includes('lake') || text.includes('pond') || text.includes('reservoir') || text.includes('basin')) {
      return GEO_WATER_CLASS.LAKE;
    }
    if (text.includes('river')) return GEO_WATER_CLASS.RIVER;
    if (text.includes('canal') || text.includes('ditch')) return GEO_WATER_CLASS.CANAL;
    if (text.includes('stream') || text.includes('drain') || text.includes('brook')) return GEO_WATER_CLASS.STREAM;
  }
  return GEO_WATER_CLASS.UNKNOWN;
}

export function waterClassName(value) {
  return GEO_WATER_CLASS_NAMES[value] ?? GEO_WATER_CLASS_NAMES[GEO_WATER_CLASS.UNKNOWN];
}

function flowSign(item) {
  const raw = item?.flowDirection ?? item?.properties?.flow_direction ?? item?.properties?.direction ?? '';
  const value = String(raw).toLowerCase();
  return item?.reverseFlow === true || value === '-1' || value.includes('reverse') || value.includes('backward') ? -1 : 1;
}

function packWaterways(waterways, sourceWaterwaysTruncated) {
  const values = [], records = [];
  let truncated = Boolean(sourceWaterwaysTruncated), malformed = 0, mappedFlowSegments = 0;
  const input = Array.isArray(waterways) ? waterways : [];
  malformed += Number(waterways != null && !Array.isArray(waterways));
  for (const item of input) {
    if (records.length >= GEO_WATER_DOMAIN_LIMITS.maxWaterwaySegments) { truncated = true; break; }
    const segment = item?.segment ?? item;
    if (!Array.isArray(segment) || segment.length < 4 || !segment.slice(0, 4).every(Number.isFinite)) {
      malformed++;
      continue;
    }
    const dx = segment[2] - segment[0], dz = segment[3] - segment[1];
    const length = Math.hypot(dx, dz);
    if (length < 1e-8) { malformed++; continue; }
    const declaredHalfWidth = Number.isFinite(item?.halfWidth) ? item.halfWidth
      : Number.isFinite(item?.width) ? item.width / 2
        : Number.isFinite(segment[4]) ? segment[4] : .12;
    const halfWidth = Math.max(.01, Math.min(GEO_WATER_DOMAIN_LIMITS.maxWaterwayHalfWidth, declaredHalfWidth));
    if (!Number.isFinite(declaredHalfWidth) || declaredHalfWidth <= 0 ||
        declaredHalfWidth > GEO_WATER_DOMAIN_LIMITS.maxWaterwayHalfWidth) malformed++;
    const classCode = classifyWaterClass(item?.kind ?? item?.properties ?? '');
    const directional = FLOWING_CLASSES.has(classCode);
    const sign = directional ? flowSign(item) : 0;
    const flowX = dx / length * sign, flowZ = dz / length * sign;
    mappedFlowSegments += Number(directional);
    values.push(segment[0], segment[1], segment[2], segment[3], halfWidth, classCode, flowX, flowZ);
    records.push({
      segment,
      classCode,
      flowX,
      flowZ,
      length,
      minX: Math.min(segment[0], segment[2]),
      minZ: Math.min(segment[1], segment[3]),
      maxX: Math.max(segment[0], segment[2]),
      maxZ: Math.max(segment[1], segment[3]),
    });
  }
  return { values: new Float32Array(values), records, mappedFlowSegments, truncated, malformed };
}

function normalizeRings(item) {
  const source = Array.isArray(item) ? item : item?.rings;
  if (!Array.isArray(source)) return null;
  const rings = [];
  for (const ring of source) {
    if (!Array.isArray(ring) || ring.length < 3 ||
        !ring.every(point => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]))) {
      return null;
    }
    rings.push(ring);
  }
  return rings.length ? rings : null;
}

function segmentTouchesPolygon(record, rings, bounds) {
  if (record.maxX < bounds[0] || record.minX > bounds[2] || record.maxZ < bounds[1] || record.minZ > bounds[3]) {
    return false;
  }
  const [x1, z1, x2, z2] = record.segment;
  if (pointInPolygon(x1, z1, rings) || pointInPolygon(x2, z2, rings) ||
      pointInPolygon((x1 + x2) * .5, (z1 + z2) * .5, rings)) return true;
  for (const ring of rings) for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    if (segmentsIntersect(record.segment, [...ring[previous], ...ring[index]])) return true;
  }
  return false;
}

function explicitFlow(item) {
  const value = !Array.isArray(item) ? item?.flowDirection : null;
  if (!value || value.length < 2 || !Number.isFinite(value[0]) || !Number.isFinite(value[1])) return null;
  const length = Math.hypot(value[0], value[1]);
  return length > 1e-8 ? [value[0] / length, value[1] / length] : null;
}

function packPolygons(polygons, maxVertices, waterwayRecords = []) {
  const vertices = [], ringOffsets = [0], polygonOffsets = [0], bounds = [];
  const classes = [], flowDirections = [];
  let truncated = false, malformed = 0, flowingPolygons = 0, flowAssociationTests = 0;
  let flowAssociationsTruncated = false;
  const input = Array.isArray(polygons) ? polygons : [];
  malformed += Number(polygons != null && !Array.isArray(polygons));
  for (const item of input) {
    const rings = normalizeRings(item);
    if (!rings) { malformed++; continue; }
    let needed = 0;
    for (const ring of rings) needed += ring.length;
    if (vertices.length / 2 + needed > maxVertices) { truncated = true; break; }
    for (const ring of rings) {
      for (const point of ring) vertices.push(point[0], point[1]);
      ringOffsets.push(vertices.length / 2);
    }
    polygonOffsets.push(polygonOffsets.at(-1) + rings.length);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of rings[0]) {
      minX = Math.min(minX, x); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
    }
    const polygonBounds = [minX, minZ, maxX, maxZ];
    bounds.push(...polygonBounds);
    const classCode = classifyWaterClass(Array.isArray(item) ? '' : item?.kind ?? item?.properties ?? '', item?.layerName);
    classes.push(classCode);
    let flow = FLOWING_CLASSES.has(classCode) ? explicitFlow(item) : null;
    let bestLength = -1;
    if (!flow && FLOWING_CLASSES.has(classCode)) {
      for (const record of waterwayRecords) {
        if (flowAssociationTests >= GEO_WATER_DOMAIN_LIMITS.maxFlowAssociationTests) {
          flowAssociationsTruncated = true;
          break;
        }
        flowAssociationTests++;
        if (record.classCode !== classCode || record.length <= bestLength ||
            !segmentTouchesPolygon(record, rings, polygonBounds)) continue;
        flow = [record.flowX, record.flowZ];
        bestLength = record.length;
      }
    }
    if (flow) flowingPolygons++;
    flowDirections.push(
      Math.round((flow?.[0] ?? 0) * GEO_WATER_FLOW_QUANTIZATION),
      Math.round((flow?.[1] ?? 0) * GEO_WATER_FLOW_QUANTIZATION),
    );
  }
  return {
    vertices: new Float32Array(vertices),
    ringOffsets: new Uint32Array(ringOffsets),
    polygonOffsets: new Uint32Array(polygonOffsets),
    bounds: new Float32Array(bounds),
    classes: new Uint8Array(classes),
    flowDirections: new Int16Array(flowDirections),
    flowingPolygons,
    flowAssociationTests,
    flowAssociationsTruncated,
    truncated,
    malformed,
  };
}

function classCounts(classes, waterways) {
  const counts = Object.fromEntries(GEO_WATER_CLASS_NAMES.map(name => [name, 0]));
  for (const value of classes) counts[waterClassName(value)]++;
  for (let offset = 0; offset + GEO_WATERWAY_STRIDE - 1 < waterways.length; offset += GEO_WATERWAY_STRIDE) {
    counts[waterClassName(Math.round(waterways[offset + 5]))]++;
  }
  return Object.freeze(counts);
}

function domainByteLengthUnchecked(domain) {
  return ['waterVertices', 'waterRingOffsets', 'waterPolygonOffsets', 'waterBounds', 'waterClasses', 'waterFlowDirections',
    'wetlandVertices', 'wetlandRingOffsets', 'wetlandPolygonOffsets', 'wetlandBounds', 'waterways']
    .reduce((total, field) => total + (domain[field]?.byteLength ?? 0), 0);
}

/** Build a compact transferable shoreline/class/flow/support domain. */
export function createWaterDomain({
  waterPolygons = [], waterways = [], wetlandPolygons = [], sourceWaterwaysTruncated = false,
} = {}) {
  const packedWaterways = packWaterways(waterways, sourceWaterwaysTruncated);
  const water = packPolygons(waterPolygons, GEO_WATER_DOMAIN_LIMITS.maxWaterVertices, packedWaterways.records);
  const wetland = packPolygons(wetlandPolygons, GEO_WATER_DOMAIN_LIMITS.maxWetlandVertices);
  const capEvents = Object.freeze({
    waterVertices: water.truncated,
    wetlandVertices: wetland.truncated,
    waterwaySegments: packedWaterways.truncated,
    flowAssociations: water.flowAssociationsTruncated,
    domainBytes: false,
  });
  const domain = {
    namespace: GDO_WATER_DOMAIN_NAMESPACE,
    waterVertices: water.vertices,
    waterRingOffsets: water.ringOffsets,
    waterPolygonOffsets: water.polygonOffsets,
    waterBounds: water.bounds,
    waterClasses: water.classes,
    waterFlowDirections: water.flowDirections,
    wetlandVertices: wetland.vertices,
    wetlandRingOffsets: wetland.ringOffsets,
    wetlandPolygonOffsets: wetland.polygonOffsets,
    wetlandBounds: wetland.bounds,
    waterways: packedWaterways.values,
    waterwayStride: GEO_WATERWAY_STRIDE,
    shorelineWidth: GEO_WATER_DOMAIN_LIMITS.shorelineWidth,
    bankWidth: GEO_WATER_DOMAIN_LIMITS.bankWidth,
  };
  const bytes = domainByteLengthUnchecked(domain);
  if (bytes > GEO_WATER_DOMAIN_LIMITS.maxDomainBytes) {
    throw new Error(`Water-domain byte cap exceeded: ${bytes}/${GEO_WATER_DOMAIN_LIMITS.maxDomainBytes}`);
  }
  domain.meta = Object.freeze({
    waterPolygons: Math.max(0, water.polygonOffsets.length - 1),
    wetlandPolygons: Math.max(0, wetland.polygonOffsets.length - 1),
    waterwaySegments: packedWaterways.records.length,
    flowingPolygons: water.flowingPolygons,
    mappedFlowSegments: packedWaterways.mappedFlowSegments,
    flowAssociationTests: water.flowAssociationTests,
    classCounts: classCounts(water.classes, packedWaterways.values),
    malformedRecords: water.malformed + wetland.malformed + packedWaterways.malformed,
    bytes,
    capEvents,
  });
  return Object.freeze(domain);
}

function distanceToSegment(x, z, x1, z1, x2, z2, out) {
  const dx = x2 - x1, dz = z2 - z1;
  const lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared ? Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / lengthSquared)) : 0;
  const nearestX = x1 + dx * amount, nearestZ = z1 + dz * amount;
  const distance = Math.hypot(x - nearestX, z - nearestZ);
  if (distance < out.distance) {
    out.distance = distance;
    out.nearestX = nearestX;
    out.nearestZ = nearestZ;
  }
  return distance;
}

function pointInPackedPolygon(x, z, vertices, ringOffsets, polygonOffsets, polygonIndex) {
  const firstRing = polygonOffsets[polygonIndex], lastRing = polygonOffsets[polygonIndex + 1];
  let outer = false;
  for (let ringIndex = firstRing; ringIndex < lastRing; ringIndex++) {
    const start = ringOffsets[ringIndex], end = ringOffsets[ringIndex + 1];
    let inside = false;
    for (let index = start, previous = end - 1; index < end; previous = index++) {
      const xi = vertices[index * 2], zi = vertices[index * 2 + 1];
      const xj = vertices[previous * 2], zj = vertices[previous * 2 + 1];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi) inside = !inside;
    }
    if (ringIndex === firstRing) outer = inside;
    else if (inside) return false;
  }
  return outer;
}

function packedContainsIndex(x, z, vertices, ringOffsets, polygonOffsets, bounds) {
  for (let polygon = 0; polygon + 1 < polygonOffsets.length; polygon++) {
    const bound = polygon * 4;
    if (x < bounds[bound] || x > bounds[bound + 2] || z < bounds[bound + 1] || z > bounds[bound + 3]) continue;
    if (pointInPackedPolygon(x, z, vertices, ringOffsets, polygonOffsets, polygon)) return polygon;
  }
  return -1;
}

function nearestPackedBoundary(x, z, vertices, ringOffsets, polygonOffsets, bounds, out) {
  out.polygonIndex = -1;
  for (let polygon = 0; polygon + 1 < polygonOffsets.length; polygon++) {
    const bound = polygon * 4;
    const dx = x < bounds[bound] ? bounds[bound] - x : x > bounds[bound + 2] ? x - bounds[bound + 2] : 0;
    const dz = z < bounds[bound + 1] ? bounds[bound + 1] - z : z > bounds[bound + 3] ? z - bounds[bound + 3] : 0;
    if (dx * dx + dz * dz > out.distance * out.distance) continue;
    const firstRing = polygonOffsets[polygon], lastRing = polygonOffsets[polygon + 1];
    for (let ring = firstRing; ring < lastRing; ring++) {
      const start = ringOffsets[ring], end = ringOffsets[ring + 1];
      for (let index = start, previous = end - 1; index < end; previous = index++) {
        const before = out.distance;
        distanceToSegment(x, z,
          vertices[previous * 2], vertices[previous * 2 + 1],
          vertices[index * 2], vertices[index * 2 + 1], out);
        if (out.distance < before) out.polygonIndex = polygon;
      }
    }
  }
}

function validDomain(domain) {
  return domain?.namespace === GDO_WATER_DOMAIN_NAMESPACE &&
    domain.waterVertices instanceof Float32Array && domain.waterRingOffsets instanceof Uint32Array &&
    domain.waterPolygonOffsets instanceof Uint32Array && domain.waterBounds instanceof Float32Array &&
    domain.waterClasses instanceof Uint8Array && domain.waterFlowDirections instanceof Int16Array &&
    domain.wetlandVertices instanceof Float32Array && domain.wetlandRingOffsets instanceof Uint32Array &&
    domain.wetlandPolygonOffsets instanceof Uint32Array && domain.wetlandBounds instanceof Float32Array &&
    domain.waterways instanceof Float32Array && domain.waterwayStride === GEO_WATERWAY_STRIDE;
}

/** Bounded scan with reusable output. Distance is signed and flow is normalized or zero. */
export function queryWaterDomain(domain, x, z, out = {}) {
  if (!validDomain(domain) || !Number.isFinite(x) || !Number.isFinite(z)) {
    throw new TypeError('A versioned water-domain query and finite point are required');
  }
  const nearest = { distance: Infinity, nearestX: x, nearestZ: z, polygonIndex: -1 };
  const insidePolygonIndex = packedContainsIndex(x, z,
    domain.waterVertices, domain.waterRingOffsets, domain.waterPolygonOffsets, domain.waterBounds);
  nearestPackedBoundary(x, z,
    domain.waterVertices, domain.waterRingOffsets, domain.waterPolygonOffsets, domain.waterBounds, nearest);
  let signedDistance = insidePolygonIndex >= 0 ? -nearest.distance : nearest.distance;
  const polygonIndex = insidePolygonIndex >= 0 ? insidePolygonIndex : nearest.polygonIndex;
  let waterClassCode = polygonIndex >= 0 ? domain.waterClasses[polygonIndex] : GEO_WATER_CLASS.UNKNOWN;
  let flowX = polygonIndex >= 0
    ? domain.waterFlowDirections[polygonIndex * 2] / GEO_WATER_FLOW_QUANTIZATION : 0;
  let flowZ = polygonIndex >= 0
    ? domain.waterFlowDirections[polygonIndex * 2 + 1] / GEO_WATER_FLOW_QUANTIZATION : 0;
  let flowSource = Math.hypot(flowX, flowZ) > 1e-6
    ? GEO_WATER_FLOW_SOURCE.POLYGON_WATERWAY : GEO_WATER_FLOW_SOURCE.NONE;
  const lineNearest = { distance: Infinity, nearestX: x, nearestZ: z };
  for (let offset = 0; offset + GEO_WATERWAY_STRIDE - 1 < domain.waterways.length; offset += GEO_WATERWAY_STRIDE) {
    lineNearest.distance = Infinity;
    lineNearest.nearestX = x;
    lineNearest.nearestZ = z;
    const centreDistance = distanceToSegment(x, z,
      domain.waterways[offset], domain.waterways[offset + 1], domain.waterways[offset + 2], domain.waterways[offset + 3], lineNearest);
    const lineDistance = centreDistance - domain.waterways[offset + 4];
    if (lineDistance < signedDistance) {
      signedDistance = lineDistance;
      waterClassCode = Math.round(domain.waterways[offset + 5]);
      flowX = domain.waterways[offset + 6];
      flowZ = domain.waterways[offset + 7];
      flowSource = Math.hypot(flowX, flowZ) > 1e-6
        ? GEO_WATER_FLOW_SOURCE.WATERWAY : GEO_WATER_FLOW_SOURCE.NONE;
      nearest.nearestX = lineNearest.nearestX;
      nearest.nearestZ = lineNearest.nearestZ;
    }
  }
  const wetland = packedContainsIndex(x, z,
    domain.wetlandVertices, domain.wetlandRingOffsets, domain.wetlandPolygonOffsets, domain.wetlandBounds) >= 0;
  const inWater = signedDistance <= 0;
  const kind = inWater ? GEO_ECOLOGICAL_DOMAIN.WATER
    : wetland ? GEO_ECOLOGICAL_DOMAIN.WETLAND
      : signedDistance <= domain.shorelineWidth ? GEO_ECOLOGICAL_DOMAIN.SHORELINE
        : signedDistance <= domain.bankWidth ? GEO_ECOLOGICAL_DOMAIN.BANK
          : GEO_ECOLOGICAL_DOMAIN.GROUND;
  out.kind = kind;
  out.waterDistance = signedDistance;
  out.nearestX = nearest.nearestX;
  out.nearestZ = nearest.nearestZ;
  out.waterClass = waterClassCode;
  out.waterClassName = waterClassName(waterClassCode);
  out.flowX = flowX;
  out.flowZ = flowZ;
  out.flowKnown = flowSource !== GEO_WATER_FLOW_SOURCE.NONE;
  out.flowSource = flowSource;
  out.inWater = inWater;
  out.wetland = wetland;
  out.groundSupport = !inWater;
  return out;
}

export function waterDomainByteLength(domain) {
  if (!validDomain(domain)) throw new TypeError('Versioned water domain required');
  return domainByteLengthUnchecked(domain);
}

export function waterDomainTransferables(domain) {
  if (!validDomain(domain)) throw new TypeError('Versioned water domain required');
  return [
    domain.waterVertices.buffer,
    domain.waterRingOffsets.buffer,
    domain.waterPolygonOffsets.buffer,
    domain.waterBounds.buffer,
    domain.waterClasses.buffer,
    domain.waterFlowDirections.buffer,
    domain.wetlandVertices.buffer,
    domain.wetlandRingOffsets.buffer,
    domain.wetlandPolygonOffsets.buffer,
    domain.wetlandBounds.buffer,
    domain.waterways.buffer,
  ];
}
