import { featureNamespace } from '../engine/FeatureVersions.js';
import { GEO_QUERY_MASK } from './GeoCollision.js';
import { GEO_SUPPORT_ROLE } from './GeoSupportSlots.js';
import { terrainHeightAt } from './GeoTerrain.js';
import { compileObjectRecipe, createObjectRecipe, GEO_OBJECT_LOD } from './GeoObjectRecipe.js';

export const GDO_LANDMARK_GRAMMAR_NAMESPACE = featureNamespace('landmarkGrammar');
export const GEO_LANDMARK_COMPOUND_STRIDE = 4;

/**
 * Landmark limits are a shared one-tile allocation, not a per-feature excuse
 * to add more draw calls. The visible object is merged into one typed batch;
 * its structural opening compounds remain independently queryable.
 */
export const GEO_LANDMARK_LIMITS = Object.freeze({
  maxSourceFeatures: 512,
  maxLandmarks: 32,
  maxModulesPerLandmark: 32,
  maxBoxesPerLandmark: 120,
  maxVisualBoxes: 512,
  maxCompounds: 256,
  maxOpeningSegments: 16,
  maxVisualTriangles: 6_144,
  maxVisualBytes: 128 * 1024,
  archSegments: 7,
  upperTierColumns: 5,
  archThickness: .13,
  pillarMinimum: .18,
});

const LANDMARK_COLORS = Object.freeze({
  stone: Object.freeze([.42, .28, .17]),
  cap: Object.freeze([.58, .40, .21]),
  shadow: Object.freeze([.16, .12, .09]),
  accent: Object.freeze([.72, .48, .16]),
});

const STRUCTURAL_MASK = GEO_QUERY_MASK.SOLID_PLAYER |
  GEO_QUERY_MASK.CAMERA_BLOCKER |
  GEO_QUERY_MASK.LOS_BLOCKER |
  GEO_QUERY_MASK.PLACEMENT;

function emptyResult(meta = {}) {
  return Object.freeze({
    namespace: GDO_LANDMARK_GRAMMAR_NAMESPACE,
    positions: new Float32Array(),
    normals: new Float32Array(),
    colors: new Float32Array(),
    indices: new Uint32Array(),
    colliders: new Float32Array(),
    collisionVertices: new Float32Array(),
    collisionRingOffsets: new Uint32Array([0]),
    collisionPolygonOffsets: new Uint32Array([0]),
    collisionSpans: new Float32Array(),
    collisionMasks: new Uint16Array(),
    compoundStride: GEO_LANDMARK_COMPOUND_STRIDE,
    meta: Object.freeze({
      namespace: GDO_LANDMARK_GRAMMAR_NAMESPACE,
      sourceFeatures: 0,
      landmarks: 0,
      recipes: 0,
      modules: 0,
      repeatedModules: 0,
      openings: 0,
      openingPolicies: Object.freeze([]),
      compounds: 0,
      boxes: 0,
      triangles: 0,
      bytes: 0,
      capEvents: Object.freeze({}),
      ...meta,
    }),
  });
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

function quantized(value) { return Math.round(value * 4096); }

function canonicalYaw(value) {
  let yaw = Number.isFinite(value) ? value : 0;
  while (yaw < 0) yaw += Math.PI;
  while (yaw >= Math.PI) yaw -= Math.PI;
  return yaw;
}

function addColor(colors, color, count) {
  for (let index = 0; index < count; index++) colors.push(color[0], color[1], color[2]);
}

function rotatePoint(localX, localZ, cosine, sine, centerX, centerZ) {
  return [centerX + localX * cosine - localZ * sine, centerZ + localX * sine + localZ * cosine];
}

function appendBox(target, box) {
  const { centerX, centerZ, sizeX, sizeY, sizeZ, yaw = 0, color } = box;
  const centerY = box.centerY ?? box.bottom + sizeY / 2;
  const halfX = sizeX / 2, halfY = sizeY / 2, halfZ = sizeZ / 2;
  const cosine = Math.cos(yaw), sine = Math.sin(yaw);
  const corners = [
    [-halfX, -halfY, -halfZ], [halfX, -halfY, -halfZ], [halfX, halfY, -halfZ], [-halfX, halfY, -halfZ],
    [-halfX, -halfY, halfZ], [halfX, -halfY, halfZ], [halfX, halfY, halfZ], [-halfX, halfY, halfZ],
  ];
  const faces = [
    [0, 4, 7, 3, 0, 0, -1], [1, 2, 6, 5, 0, 0, 1],
    [0, 1, 5, 4, 0, -1, 0], [3, 7, 6, 2, 0, 1, 0],
    [0, 3, 2, 1, -1, 0, 0], [4, 5, 6, 7, 1, 0, 0],
  ];
  for (const [a, b, c, d, normalX, normalY, normalZ] of faces) {
    const worldNormalX = normalX * cosine - normalZ * sine;
    const worldNormalZ = normalX * sine + normalZ * cosine;
    const offset = target.positions.length / 3;
    for (let vertex = 0; vertex < 4; vertex++) target.normals.push(worldNormalX, normalY, worldNormalZ);
    addColor(target.colors, color, 4);
    for (const index of [a, b, c, d]) {
      const [x, y, z] = corners[index];
      const [worldX, worldZ] = rotatePoint(x, z, cosine, sine, centerX, centerZ);
      target.positions.push(worldX, centerY + y, worldZ);
    }
    target.indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  }
}

function appendCompound(target, box, bottom, top, mask = STRUCTURAL_MASK) {
  const cosine = Math.cos(box.yaw ?? 0), sine = Math.sin(box.yaw ?? 0);
  const ring = [
    rotatePoint(-box.sizeX / 2, -box.sizeZ / 2, cosine, sine, box.centerX, box.centerZ),
    rotatePoint(box.sizeX / 2, -box.sizeZ / 2, cosine, sine, box.centerX, box.centerZ),
    rotatePoint(box.sizeX / 2, box.sizeZ / 2, cosine, sine, box.centerX, box.centerZ),
    rotatePoint(-box.sizeX / 2, box.sizeZ / 2, cosine, sine, box.centerX, box.centerZ),
  ];
  for (const [x, z] of ring) target.collisionVertices.push(x, z);
  target.collisionRingOffsets.push(target.collisionVertices.length / 2);
  target.collisionPolygonOffsets.push(target.collisionRingOffsets.length - 1);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    minX = Math.min(minX, x); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
  }
  target.colliders.push(minX, minZ, maxX, maxZ);
  target.collisionSpans.push(bottom, top);
  target.collisionMasks.push(mask);
}

function featureLayers(vectorTile) {
  const result = [];
  for (const name of ['landmark', 'landmarks', 'monument', 'monuments']) {
    const layer = vectorTile?.layers?.[name];
    if (layer) result.push({ name, layer, explicit: true });
  }
  // OpenMapTiles/Shortbread adapters commonly expose POIs/sites under
  // different names. Only explicitly tagged landmark-like records qualify;
  // ordinary place labels never become geometry by inference.
  for (const name of ['poi', 'pois', 'sites']) {
    const layer = vectorTile?.layers?.[name];
    if (layer) result.push({ name, layer, explicit: false });
  }
  return result;
}

function pointsFromGeometry(geometry, type) {
  if (!Array.isArray(geometry) || !geometry.length) return null;
  const parts = geometry.filter(Array.isArray);
  if (type === 1) {
    const point = parts[0]?.[0];
    return finitePoint(point) ? [[point]] : null;
  }
  const paths = [];
  for (const part of parts) {
    if (!Array.isArray(part) || part.length < 2 || !part.every(finitePoint)) return null;
    const path = part.map(point => [point.x, point.y]);
    if (path.length > 1 && path[0][0] === path.at(-1)[0] && path[0][1] === path.at(-1)[1]) path.pop();
    if (path.length >= 2) paths.push(path);
  }
  if (type === 3 && (paths.length === 0 || paths[0].length < 3)) return null;
  return paths.length ? paths : null;
}

function featureKey(feature, points, index) {
  const id = feature?.id == null ? '' : String(feature.id);
  const geometryKey = points.flat().map(point => `${quantized(point[0])}:${quantized(point[1])}`).join(';');
  return `${id}|${feature.type}|${geometryKey}|${index}`;
}

function numericProperty(properties, names) {
  for (const name of names) {
    const value = Number(properties?.[name]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function landmarkKind(properties, explicitLayer) {
  const tagged = properties?.landmark === true || properties?.landmark === 1 ||
    String(properties?.landmark ?? '').trim().toLowerCase() === 'yes';
  const value = String(properties?.landmark ?? properties?.kind ?? properties?.class ?? '').trim().toLowerCase();
  if (explicitLayer || tagged || value.includes('landmark') || value.includes('monument') || value.includes('gateway') ||
      value.includes('arch') || value.includes('temple') || value.includes('gate')) return value || 'landmark';
  return null;
}

function recordFromFeature(feature, featureIndex, request, explicitLayer) {
  if (!feature || ![1, 2, 3].includes(feature.type) || !Number.isFinite(feature.extent) || feature.extent <= 0) return null;
  const properties = feature.properties ?? {};
  const kind = landmarkKind(properties, explicitLayer);
  if (!kind) return null;
  let geometry;
  try { geometry = feature.loadGeometry(); } catch { throw new TypeError('landmark geometry failed to load'); }
  const paths = pointsFromGeometry(geometry, feature.type);
  if (!paths) throw new TypeError('landmark geometry is malformed');
  const sourcePoints = paths[0];
  const worldPaths = paths.map(path => path.map(point => pointToWorld({ x: point[0], y: point[1] }, feature.extent, request)));
  let centerX = 0, centerZ = 0, yaw = Number(properties.rotation ?? properties.yaw ?? 0);
  if (!Number.isFinite(yaw)) yaw = 0;
  let width = numericProperty(properties, ['width', 'extent']) * .1;
  let depth = numericProperty(properties, ['depth', 'thickness']) * .1;
  if (feature.type === 1) {
    [centerX, centerZ] = worldPaths[0][0];
  } else {
    const points = worldPaths[0];
    let minimumX = Infinity, minimumZ = Infinity, maximumX = -Infinity, maximumZ = -Infinity;
    let longest = 0;
    for (let index = 0; index < points.length; index++) {
      const first = points[index], second = points[(index + 1) % points.length];
      minimumX = Math.min(minimumX, first[0]); maximumX = Math.max(maximumX, first[0]);
      minimumZ = Math.min(minimumZ, first[1]); maximumZ = Math.max(maximumZ, first[1]);
      const edgeLength = Math.hypot(second[0] - first[0], second[1] - first[1]);
      if (edgeLength > longest) { longest = edgeLength; yaw = Math.atan2(second[1] - first[1], second[0] - first[0]); }
    }
    centerX = (minimumX + maximumX) / 2;
    centerZ = (minimumZ + maximumZ) / 2;
    if (!width) width = Math.max(maximumX - minimumX, .8);
    if (!depth) depth = Math.max(Math.min(maximumZ - minimumZ, width), .3);
    if (feature.type === 2) {
      const first = points[0], last = points.at(-1);
      centerX = (first[0] + last[0]) / 2;
      centerZ = (first[1] + last[1]) / 2;
      yaw = Math.atan2(last[1] - first[1], last[0] - first[0]);
      width = Math.max(Math.hypot(last[0] - first[0], last[1] - first[1]), width, .8);
    }
  }
  width = Math.max(width, .8);
  depth = Math.max(.24, Math.min(depth || width * .42, 4));
  const taggedHeight = numericProperty(properties, ['render_height', 'height']);
  const height = Math.max(1.2, Math.min(12, taggedHeight ? taggedHeight * .1 : Math.max(1.8, width * .92)));
  const openingTagged = numericProperty(properties, ['opening_width', 'arch_width', 'door_width']) * .1;
  const openingWidth = Math.max(.24, Math.min(width - GEO_LANDMARK_LIMITS.pillarMinimum * 2,
    openingTagged || Math.min(width * .56, 1.8)));
  const groundY = terrainHeightAt(centerX, centerZ, Number.isFinite(request?.terrainSeed) ? request.terrainSeed : 0);
  yaw = canonicalYaw(yaw);
  const key = featureKey(feature, sourcePoints, featureIndex);
  return Object.freeze({
    key,
    featureIndex,
    kind,
    centerX,
    centerZ,
    yaw,
    width,
    depth,
    height,
    openingWidth,
    groundY,
  });
}

function worldBox(record, localX, bottom, localZ, sizeX, sizeY, sizeZ, color, yawOffset = 0) {
  const [centerX, centerZ] = rotatePoint(localX, localZ, Math.cos(record.yaw), Math.sin(record.yaw), record.centerX, record.centerZ);
  return { centerX, centerY: record.groundY + bottom + sizeY / 2, bottom: record.groundY + bottom, centerZ, sizeX, sizeY, sizeZ,
    yaw: record.yaw + yawOffset, color };
}

function createLandmarkDetailRecipe(record, index) {
  const stableSeed = (record.featureIndex + 1) * 0x9e3779b1;
  const support = {
    id: ((stableSeed ^ 0x85ebca6b) >>> 0 & 0x00ffffff) || index + 1,
    roleMask: GEO_SUPPORT_ROLE.GROUND_DETAIL,
    x: record.centerX,
    y: record.groundY,
    z: record.centerZ,
    halfWidth: record.width / 2,
    halfDepth: record.depth / 2,
    yaw: record.yaw,
  };
  const pillarWidth = Math.max(GEO_LANDMARK_LIMITS.pillarMinimum, (record.width - record.openingWidth) / 2);
  const springY = Math.min(record.height * .62, Math.max(.62, record.height - .36));
  const radius = record.openingWidth / 2;
  const archThickness = Math.min(GEO_LANDMARK_LIMITS.archThickness, Math.max(.09, record.depth * .22));
  const beamBottom = Math.min(record.height - .18, springY + radius * .72 + archThickness);
  const structuralBoxes = [];
  const silhouette = [];
  const leftPillar = worldBox(record, -(record.openingWidth + pillarWidth) / 2, 0, 0,
    pillarWidth, springY, record.depth, LANDMARK_COLORS.stone);
  const rightPillar = worldBox(record, (record.openingWidth + pillarWidth) / 2, 0, 0,
    pillarWidth, springY, record.depth, LANDMARK_COLORS.stone);
  structuralBoxes.push(leftPillar, rightPillar);
  silhouette.push({ id: 'opening-pillars', minimumLod: GEO_OBJECT_LOD.FAR, order: 0, boxes: [leftPillar, rightPillar] });

  const archBoxes = [];
  const segmentCount = Math.min(GEO_LANDMARK_LIMITS.archSegments, Math.max(3, Math.floor(record.openingWidth * 4)));
  for (let segment = 0; segment < segmentCount; segment++) {
    const angle = Math.PI * segment / (segmentCount - 1);
    const localX = Math.cos(angle) * radius;
    const bottom = springY + Math.sin(angle) * radius * .72;
    const box = worldBox(record, localX, bottom, 0,
      Math.max(.12, record.openingWidth * Math.PI / segmentCount * 1.1), archThickness,
      record.depth, LANDMARK_COLORS.cap);
    archBoxes.push(box);
    structuralBoxes.push(box);
  }
  silhouette.push({ id: 'opening-arch-ring', minimumLod: GEO_OBJECT_LOD.FAR, order: 1, boxes: archBoxes });

  const beam = worldBox(record, 0, beamBottom, 0, record.width, Math.max(.16, archThickness), record.depth, LANDMARK_COLORS.cap);
  structuralBoxes.push(beam);
  silhouette.push({ id: 'upper-beam', minimumLod: GEO_OBJECT_LOD.FAR, order: 2, boxes: [beam] });

  const tierColumns = [];
  const tierWidth = record.width * .78;
  const columnSize = Math.max(.1, Math.min(.24, record.width * .08));
  const tierHeight = Math.max(.18, record.height - beamBottom - .22);
  for (let column = 0; column < GEO_LANDMARK_LIMITS.upperTierColumns; column++) {
    const amount = GEO_LANDMARK_LIMITS.upperTierColumns === 1 ? .5 : column / (GEO_LANDMARK_LIMITS.upperTierColumns - 1);
    const localX = (amount - .5) * tierWidth;
    tierColumns.push(worldBox(record, localX, beamBottom + archThickness, 0,
      columnSize, tierHeight, record.depth * .72, LANDMARK_COLORS.stone));
  }
  silhouette.push({ id: 'repeated-tier-columns', minimumLod: GEO_OBJECT_LOD.FAR, order: 3, boxes: tierColumns });

  const tierCap = worldBox(record, 0, record.height - .16, 0, record.width * .92, .16, record.depth * .92, LANDMARK_COLORS.cap);
  silhouette.push({ id: 'tier-cap', minimumLod: GEO_OBJECT_LOD.FAR, order: 4, boxes: [tierCap] });

  const accents = [];
  const finials = [];
  for (const side of [-1, 1]) {
    finials.push(worldBox(record, side * record.width * .38, record.height, 0,
      columnSize * 1.25, .16, columnSize * 1.25, LANDMARK_COLORS.accent));
  }
  accents.push({ id: 'repeated-finials', minimumLod: GEO_OBJECT_LOD.NEAR, order: 0, boxes: finials });

  const recipe = createObjectRecipe({
    id: `${GDO_LANDMARK_GRAMMAR_NAMESPACE}:${record.key}`,
    owner: record.key,
    support,
    authoritativeFootprint: 'mapped-landmark-feature',
    height: record.groundY + record.height,
    silhouette,
    surface: [],
    accents,
    visualBounds: null,
    solidProxies: structuralBoxes.map((box, proxyIndex) => Object.freeze({
      id: `structural:${proxyIndex}`,
      bottom: box.centerY - box.sizeY / 2,
      top: box.centerY + box.sizeY / 2,
      centerX: box.centerX,
      centerZ: box.centerZ,
      sizeX: box.sizeX,
      sizeZ: box.sizeZ,
      yaw: box.yaw,
    })),
    interactionProxies: [],
    cameraRoles: [],
  });
  const compiled = compileObjectRecipe(recipe, {
    lod: GEO_OBJECT_LOD.NEAR,
    maxModules: GEO_LANDMARK_LIMITS.maxModulesPerLandmark,
    maxBoxes: GEO_LANDMARK_LIMITS.maxBoxesPerLandmark,
  });
  return Object.freeze({
    recipe,
    compiled,
    structuralBoxes: Object.freeze(structuralBoxes),
    opening: Object.freeze({
      width: record.openingWidth,
      springY: record.groundY + springY,
      topY: record.groundY + beamBottom,
      centerX: record.centerX,
      centerZ: record.centerZ,
      yaw: record.yaw,
    }),
  });
}

function bytesFor(visual, collision) {
  return (visual.positions.length + visual.normals.length + visual.colors.length + visual.indices.length) * 4 +
    (collision.colliders.length + collision.collisionVertices.length + collision.collisionRingOffsets.length +
      collision.collisionPolygonOffsets.length + collision.collisionSpans.length) * 4 + collision.collisionMasks.length * 2;
}

function compileEmptyOnCap(capEvents) {
  return emptyResult({ capEvents: Object.freeze({ ...capEvents }) });
}

/** Compile explicit mapped landmark features into one visual batch and exact opening compounds. */
export function compileLandmarkGrammar(vectorTile, request, { limits = GEO_LANDMARK_LIMITS } = {}) {
  const selectedLayers = featureLayers(vectorTile);
  if (!selectedLayers.length) return emptyResult();
  let sourceFeatures = 0;
  for (const selectedLayer of selectedLayers) {
    const layer = selectedLayer.layer;
    if (!Number.isInteger(layer.length) || layer.length < 0 ||
        sourceFeatures + layer.length > limits.maxSourceFeatures) {
      return compileEmptyOnCap({ sourceFeatures: true });
    }
    sourceFeatures += layer.length;
  }
  const records = [];
  try {
    let featureOffset = 0;
    for (const selectedLayer of selectedLayers) {
      const layer = selectedLayer.layer;
      for (let featureIndex = 0; featureIndex < layer.length; featureIndex++) {
        const feature = layer.feature(featureIndex);
        const record = recordFromFeature(feature, featureOffset + featureIndex, request, selectedLayer.explicit);
        if (record) records.push(record);
      }
      featureOffset += layer.length;
    }
  } catch {
    return compileEmptyOnCap({ malformed: true });
  }
  records.sort((first, second) => first.key.localeCompare(second.key));
  const accepted = records.slice(0, limits.maxLandmarks);
  const capEvents = { sourceFeatures: false, landmarks: records.length > limits.maxLandmarks, boxes: false, compounds: false, geometry: false, bytes: false };
  const visual = { positions: [], normals: [], colors: [], indices: [] };
  const collision = {
    colliders: [], collisionVertices: [], collisionRingOffsets: [0], collisionPolygonOffsets: [0],
    collisionSpans: [], collisionMasks: [],
  };
  let recipes = 0, modules = 0, repeatedModules = 0, openings = 0, boxes = 0;
  const openingPolicies = [];
  for (let index = 0; index < accepted.length; index++) {
    const detail = createLandmarkDetailRecipe(accepted[index], index);
    const nextBoxes = detail.compiled.visualBoxes.length;
    if (boxes + nextBoxes > limits.maxVisualBoxes ||
        collision.collisionSpans.length / 2 + detail.structuralBoxes.length > limits.maxCompounds) {
      capEvents.boxes ||= boxes + nextBoxes > limits.maxVisualBoxes;
      capEvents.compounds ||= collision.collisionSpans.length / 2 + detail.structuralBoxes.length > limits.maxCompounds;
      break;
    }
    for (const box of detail.compiled.visualBoxes) appendBox(visual, box);
    for (const box of detail.structuralBoxes) {
      appendCompound(collision, box, box.centerY - box.sizeY / 2, box.centerY + box.sizeY / 2);
    }
    boxes += nextBoxes;
    recipes++;
    modules += detail.compiled.diagnostics.emittedModules;
    repeatedModules += detail.compiled.visualBoxes.length;
    openings++;
    openingPolicies.push(detail.opening);
  }
  const triangles = visual.indices.length / 3;
  const bytes = bytesFor(visual, collision);
  if (triangles > limits.maxVisualTriangles || bytes > limits.maxVisualBytes) {
    capEvents.geometry = triangles > limits.maxVisualTriangles;
    capEvents.bytes = bytes > limits.maxVisualBytes;
    return compileEmptyOnCap(capEvents);
  }
  const meta = {
    namespace: GDO_LANDMARK_GRAMMAR_NAMESPACE,
    sourceFeatures: records.length,
    landmarks: recipes,
    recipes,
    modules,
    repeatedModules,
    openings,
    openingPolicies: Object.freeze(openingPolicies),
    compounds: collision.collisionSpans.length / 2,
    boxes,
    triangles,
    bytes,
    capEvents: Object.freeze(capEvents),
  };
  return Object.freeze({
    namespace: GDO_LANDMARK_GRAMMAR_NAMESPACE,
    positions: new Float32Array(visual.positions),
    normals: new Float32Array(visual.normals),
    colors: new Float32Array(visual.colors),
    indices: new Uint32Array(visual.indices),
    colliders: new Float32Array(collision.colliders),
    collisionVertices: new Float32Array(collision.collisionVertices),
    collisionRingOffsets: new Uint32Array(collision.collisionRingOffsets),
    collisionPolygonOffsets: new Uint32Array(collision.collisionPolygonOffsets),
    collisionSpans: new Float32Array(collision.collisionSpans),
    collisionMasks: new Uint16Array(collision.collisionMasks),
    compoundStride: GEO_LANDMARK_COMPOUND_STRIDE,
    meta: Object.freeze(meta),
  });
}

export function landmarkGrammarRecipes() {
  return Object.freeze(['opening-pillars', 'opening-arch-ring', 'repeated-tier-columns', 'repeated-finials']
    .map(role => Object.freeze({ namespace: GDO_LANDMARK_GRAMMAR_NAMESPACE, role })));
}
