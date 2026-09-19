import { featureNamespace } from '../engine/FeatureVersions.js';
import { GEO_QUERY_MASK } from './GeoCollision.js';
import { GEO_SUPPORT_ROLE } from './GeoSupportSlots.js';
import { resolveTransportLevel, transportSurfaceY } from './GeoLayers.js';
import { terrainHeightAt } from './GeoTerrain.js';
import { compileObjectRecipe, createObjectRecipe, GEO_OBJECT_LOD } from './GeoObjectRecipe.js';

export const GDO_BRIDGE_GRAMMAR_NAMESPACE = featureNamespace('bridgeGrammar');
// Broad-phase compound bounds use [minX, minZ, maxX, maxZ], matching the
// world collision grid; exact yawed rings remain the narrow phase authority.
export const GEO_BRIDGE_COMPOUND_STRIDE = 4;

/**
 * Bridge detail is deliberately a small structural grammar rather than a
 * collection of map-feature meshes. One source segment becomes one merged
 * deck/rail/pier batch and a handful of independently authored query rings.
 */
export const GEO_BRIDGE_LIMITS = Object.freeze({
  maxSourceFeatures: 4_096,
  maxSegments: 1_024,
  maxCompounds: 768,
  maxPiers: 256,
  maxRailPosts: 2_048,
  maxVisualBoxes: 3_072,
  maxVisualTriangles: 18_432,
  maxVisualBytes: 256 * 1024,
  pierSpacing: 14,
  minimumPierSpan: 5,
  deckThickness: .12,
  railHeight: .56,
  railBeamSize: .07,
  railOffset: .055,
  pierWidth: .42,
  railPostSpacing: 5.5,
});

const ROAD_WIDTHS = Object.freeze({
  motorway: 1.4, trunk: 1.2, primary: 1, secondary: .8, tertiary: .7,
  minor: .55, unclassified: .55, residential: .55, living_street: .45,
  service: .4, busway: .5, track: .3, path: .18, footway: .18,
  cycleway: .2, pedestrian: .3, steps: .18, rail: .3, transit: .3,
  tram: .25, light_rail: .3, runway: 2.4, taxiway: 1.2,
});

const DECK_COLOR = Object.freeze([.20, .23, .24]);
const RAIL_COLOR = Object.freeze([.30, .33, .32]);
const PIER_COLOR = Object.freeze([.25, .27, .26]);

function emptyResult(meta = {}) {
  return Object.freeze({
    namespace: GDO_BRIDGE_GRAMMAR_NAMESPACE,
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
    compoundStride: GEO_BRIDGE_COMPOUND_STRIDE,
    meta: Object.freeze({
      namespace: GDO_BRIDGE_GRAMMAR_NAMESPACE,
      sourceFeatures: 0,
      segments: 0,
      decks: 0,
      railRuns: 0,
      railPosts: 0,
      piers: 0,
      compounds: 0,
      openings: 0,
      physicalLevels: Object.freeze([]),
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

function roadKind(properties = {}) {
  return String(properties.class ?? properties.kind ?? properties.subclass ?? 'minor').toLowerCase();
}

function roadWidth(properties = {}) {
  return (ROAD_WIDTHS[roadKind(properties)] ?? ROAD_WIDTHS.minor) * .1;
}

function quantized(value) { return Math.round(value * 4096); }

function segmentKey(segment) {
  return `${segment.level}:${quantized(segment.x1)}:${quantized(segment.z1)}:${quantized(segment.x2)}:${quantized(segment.z2)}:${quantized(segment.width)}`;
}

function normalizedSegment(first, second) {
  if (first[0] < second[0] || (first[0] === second[0] && first[1] <= second[1])) {
    return [first, second];
  }
  return [second, first];
}

function addColor(colors, color, count) {
  for (let index = 0; index < count; index++) colors.push(color[0], color[1], color[2]);
}

function rotatePoint(localX, localZ, cosine, sine, centerX, centerZ) {
  return [centerX + localX * cosine - localZ * sine, centerZ + localX * sine + localZ * cosine];
}

function appendBox(target, {
  centerX, centerY, centerZ, sizeX, sizeY, sizeZ, yaw = 0, color,
}) {
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
    for (let vertex = 0; vertex < 4; vertex++) target.normals.push(worldNormalX, normalY, worldNormalZ);
    addColor(target.colors, color, 4);
    const offset = target.positions.length / 3;
    // Faces use a separate four-vertex copy so flat normals remain correct.
    const source = [a, b, c, d];
    for (const index of source) {
      const [x, y, z] = corners[index];
      const [worldX, worldZ] = rotatePoint(x, z, cosine, sine, centerX, centerZ);
      target.positions.push(worldX, centerY + y, worldZ);
    }
    target.indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  }
}

function appendRectangleCompound(target, centerX, centerZ, halfWidth, halfDepth, yaw, bottom, top, mask) {
  const cosine = Math.cos(yaw), sine = Math.sin(yaw);
  const ring = [
    rotatePoint(-halfWidth, -halfDepth, cosine, sine, centerX, centerZ),
    rotatePoint(halfWidth, -halfDepth, cosine, sine, centerX, centerZ),
    rotatePoint(halfWidth, halfDepth, cosine, sine, centerX, centerZ),
    rotatePoint(-halfWidth, halfDepth, cosine, sine, centerX, centerZ),
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

function appendBridgeRecipeBoxes(target, segment, deckY1, deckY2, maxPosts = Infinity) {
  const dx = segment.x2 - segment.x1, dz = segment.z2 - segment.z1;
  const length = Math.hypot(dx, dz);
  const yaw = Math.atan2(dz, dx);
  const centerX = (segment.x1 + segment.x2) / 2;
  const centerZ = (segment.z1 + segment.z2) / 2;
  const deckY = (deckY1 + deckY2) / 2;
  // The source road already supplies the traversable top. This thin fascia is
  // below it, avoiding a second z-fighting deck surface while preserving the
  // physical grade from LAY-02.
  appendBox(target, {
    centerX, centerY: deckY - GEO_BRIDGE_LIMITS.deckThickness / 2,
    centerZ, sizeX: length + .08, sizeY: GEO_BRIDGE_LIMITS.deckThickness,
    sizeZ: segment.width + .12, yaw, color: DECK_COLOR,
  });

  const sideOffset = segment.width / 2 + GEO_BRIDGE_LIMITS.railOffset;
  let postBoxes = 0;
  for (const side of [-1, 1]) {
    const railCenterX = centerX - Math.sin(yaw) * side * sideOffset;
    const railCenterZ = centerZ + Math.cos(yaw) * side * sideOffset;
    appendBox(target, {
      centerX: railCenterX, centerY: deckY + GEO_BRIDGE_LIMITS.railHeight,
      centerZ: railCenterZ, sizeX: length, sizeY: GEO_BRIDGE_LIMITS.railBeamSize,
      sizeZ: GEO_BRIDGE_LIMITS.railBeamSize, yaw, color: RAIL_COLOR,
    });
    for (let distance = GEO_BRIDGE_LIMITS.railPostSpacing; distance < length - .1 && postBoxes < maxPosts; distance += GEO_BRIDGE_LIMITS.railPostSpacing) {
      const amount = distance / length;
      const postX = segment.x1 + (segment.x2 - segment.x1) * amount - Math.sin(yaw) * side * sideOffset;
      const postZ = segment.z1 + (segment.z2 - segment.z1) * amount + Math.cos(yaw) * side * sideOffset;
      const postY = deckY1 + (deckY2 - deckY1) * amount;
      appendBox(target, {
        centerX: postX, centerY: postY + GEO_BRIDGE_LIMITS.railHeight / 2,
        centerZ: postZ, sizeX: .055, sizeY: GEO_BRIDGE_LIMITS.railHeight,
        sizeZ: .055, yaw, color: RAIL_COLOR,
      });
      postBoxes++;
    }
  }
  return { boxes: 3 + postBoxes, posts: postBoxes };
}

function appendPierBox(target, segment, deckY1, deckY2, pier) {
  const pierX = segment.x1 + (segment.x2 - segment.x1) * pier.amount;
  const pierZ = segment.z1 + (segment.z2 - segment.z1) * pier.amount;
  const groundY = terrainHeightAt(pierX, pierZ, segment.terrainSeed);
  const top = (deckY1 + deckY2) / 2 - GEO_BRIDGE_LIMITS.deckThickness;
  const height = top - groundY;
  if (height < .25) return null;
  appendBox(target, {
    centerX: pierX, centerY: groundY + height / 2, centerZ: pierZ,
    sizeX: GEO_BRIDGE_LIMITS.pierWidth, sizeY: height, sizeZ: GEO_BRIDGE_LIMITS.pierWidth,
    yaw: Math.atan2(segment.z2 - segment.z1, segment.x2 - segment.x1), color: PIER_COLOR,
  });
  return { pierX, pierZ, groundY, top, halfWidth: GEO_BRIDGE_LIMITS.pierWidth / 2 };
}

function compileBridgeRecipe(owner, segment, support) {
  // This recipe is the contract boundary: visible boxes and collision proxies
  // are separate, even though the worker later compiles both into typed batches.
  return createObjectRecipe({
    id: `${GDO_BRIDGE_GRAMMAR_NAMESPACE}:${owner}`,
    owner,
    support,
    authoritativeFootprint: 'mapped-bridge-centerline',
    height: segment.deckY + GEO_BRIDGE_LIMITS.railHeight,
    silhouette: [{
      id: 'deck-side', minimumLod: GEO_OBJECT_LOD.FAR,
      boxes: [{ centerX: 0, bottom: 0, centerZ: 0, sizeX: 1, sizeY: .1, sizeZ: 1, color: DECK_COLOR }],
    }, {
      id: 'rail-span', minimumLod: GEO_OBJECT_LOD.FAR,
      boxes: [{ centerX: 0, bottom: .1, centerZ: 0, sizeX: 1, sizeY: .56, sizeZ: .07, color: RAIL_COLOR }],
    }],
    surface: [], accents: [], visualBounds: null,
    solidProxies: [], interactionProxies: [], cameraRoles: [],
  });
}

function compileEmptyOnCap(capEvents) {
  return emptyResult({ capEvents: Object.freeze({ ...capEvents }) });
}

/**
 * Compile map bridge segments into one visual batch plus exact rectangular rail
 * and pier rings. The center deck is intentionally not a solid: road support
 * owns traversal, while only rails and reachable piers block movement/camera.
 */
export function compileBridgeGrammar(vectorTile, request, {
  limits = GEO_BRIDGE_LIMITS,
} = {}) {
  const layer = vectorTile?.layers?.transportation ?? vectorTile?.layers?.streets;
  if (!layer) return emptyResult();
  if (!Number.isInteger(layer.length) || layer.length < 0 || layer.length > limits.maxSourceFeatures) {
    return compileEmptyOnCap({ sourceFeatures: true });
  }
  const segments = [];
  let malformed = false;
  for (let featureIndex = 0; featureIndex < layer.length; featureIndex++) {
    let feature;
    try { feature = layer.feature(featureIndex); } catch { malformed = true; break; }
    if (!feature || feature.type !== 2 || !Number.isFinite(feature.extent) || feature.extent <= 0) continue;
    const transport = resolveTransportLevel(feature.properties ?? {});
    if (transport.kind !== 'bridge') continue;
    let geometry;
    try { geometry = feature.loadGeometry(); } catch { malformed = true; break; }
    if (!Array.isArray(geometry)) { malformed = true; break; }
    for (const line of geometry) {
      if (!Array.isArray(line)) { malformed = true; break; }
      for (let pointIndex = 1; pointIndex < line.length; pointIndex++) {
        if (!finitePoint(line[pointIndex - 1]) || !finitePoint(line[pointIndex])) { malformed = true; break; }
        const first = pointToWorld(line[pointIndex - 1], feature.extent, request);
        const second = pointToWorld(line[pointIndex], feature.extent, request);
        const [start, end] = normalizedSegment(first, second);
        const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
        if (!Number.isFinite(length) || length < .05) continue;
        const segment = {
          x1: start[0], z1: start[1], x2: end[0], z2: end[1],
          width: roadWidth(feature.properties ?? {}),
          level: transport.physicalLevel,
          surfaceY: transport.surfaceY,
          terrainSeed: Number.isFinite(request?.terrainSeed) ? request.terrainSeed : 0,
          length,
          featureIndex,
        };
        segments.push(segment);
        if (segments.length > limits.maxSegments) return compileEmptyOnCap({ segments: true });
      }
      if (malformed) break;
    }
    if (malformed) break;
  }
  if (malformed) return compileEmptyOnCap({ malformed: true });
  segments.sort((first, second) => segmentKey(first).localeCompare(segmentKey(second)));
  const unique = [];
  const seen = new Set();
  for (const segment of segments) {
    const key = segmentKey(segment);
    if (!seen.has(key)) { seen.add(key); unique.push(segment); }
  }

  const visual = { positions: [], normals: [], colors: [], indices: [] };
  const collision = {
    colliders: [], collisionVertices: [], collisionRingOffsets: [0], collisionPolygonOffsets: [0],
    collisionSpans: [], collisionMasks: [],
  };
  let decks = 0, railRuns = 0, railPosts = 0, piers = 0, boxes = 0, openings = 0;
  let visualBoxCapReached = false, railPostCapReached = false;
  const physicalLevels = new Map();
  const railMask = GEO_QUERY_MASK.SOLID_PLAYER | GEO_QUERY_MASK.CAMERA_BLOCKER | GEO_QUERY_MASK.LOS_BLOCKER;
  const pierMask = railMask;
  const accepted = [];
  const ownerCounts = new Map();

  for (const segment of unique) {
    const deckY1 = terrainHeightAt(segment.x1, segment.z1, segment.terrainSeed) + segment.surfaceY;
    const deckY2 = terrainHeightAt(segment.x2, segment.z2, segment.terrainSeed) + segment.surfaceY;
    const support = {
      id: accepted.length + 1,
      roleMask: GEO_SUPPORT_ROLE.BRIDGE_DECK | GEO_SUPPORT_ROLE.BRIDGE_RAIL,
      x: (segment.x1 + segment.x2) / 2,
      y: (deckY1 + deckY2) / 2,
      z: (segment.z1 + segment.z2) / 2,
      halfWidth: segment.width / 2,
      halfDepth: segment.length / 2,
      yaw: Math.atan2(segment.z2 - segment.z1, segment.x2 - segment.x1),
    };
    const owner = `segment:${segmentKey(segment)}`;
    const recipe = compileBridgeRecipe(owner, { ...segment, deckY: support.y }, support);
    const compiled = compileObjectRecipe(recipe, { lod: GEO_OBJECT_LOD.FAR, maxModules: 2, maxBoxes: 2 });
    // Keep the recipe compile in the deterministic path, but emit the segment
    // frame below so sloped endpoints and exact query spans remain available.
    if (!compiled.visualBoxes.length) continue;
    const pierCount = segment.length >= limits.minimumPierSpan
      ? Math.min(8, Math.max(1, Math.floor(segment.length / limits.pierSpacing))) : 0;
    const pierAmounts = [];
    for (let index = 0; index < pierCount; index++) pierAmounts.push((index + 1) / (pierCount + 1));
    const pierCandidates = pierAmounts.map(amount => ({ amount, segment, terrainSeed: segment.terrainSeed }));
    const pierResults = [];
    // Compile one merged deck/rail frame per mapped segment. Piers are separate
    // structural modules so openings remain explicit and never become a deck AABB.
    if (boxes + 3 > limits.maxVisualBoxes) { visualBoxCapReached = true; break; }
    const availablePosts = Math.max(0, Math.min(
      limits.maxRailPosts - railPosts, limits.maxVisualBoxes - boxes - 3,
    ));
    const expectedPosts = Math.max(0, Math.ceil(segment.length / limits.railPostSpacing) - 1) * 2;
    if (availablePosts < expectedPosts) railPostCapReached = true;
    const frame = appendBridgeRecipeBoxes(visual, segment, deckY1, deckY2, availablePosts);
    boxes += frame.boxes;
    railPosts += frame.posts;
    // Budget pruning is deterministic and keeps rail/opening geometry intact.
    for (const pier of pierCandidates) {
      if (piers + pierResults.length >= limits.maxPiers) break;
      const result = appendPierBox(visual, segment, deckY1, deckY2, pier);
      boxes += Number(Boolean(result));
      if (result) pierResults.push(result);
    }
    // Rail spans are two long structural compounds. They enclose the walking
    // edges only; the deck center and every gap between piers stays traversable.
    const yaw = Math.atan2(segment.z2 - segment.z1, segment.x2 - segment.x1);
    const centerX = (segment.x1 + segment.x2) / 2, centerZ = (segment.z1 + segment.z2) / 2;
    const railOffset = segment.width / 2 + limits.railOffset;
    const deckY = (deckY1 + deckY2) / 2;
    for (const side of [-1, 1]) {
      const railCenterX = centerX - Math.sin(yaw) * side * railOffset;
      const railCenterZ = centerZ + Math.cos(yaw) * side * railOffset;
      appendRectangleCompound(
        collision, railCenterX, railCenterZ, segment.length / 2, limits.railBeamSize / 2,
        yaw, Math.min(deckY1, deckY2), deckY + limits.railHeight + limits.railBeamSize / 2, railMask,
      );
    }
    for (const pier of pierResults) {
      if (piers >= limits.maxPiers || collision.collisionSpans.length / 2 >= limits.maxCompounds || boxes >= limits.maxVisualBoxes) break;
      appendRectangleCompound(
        collision, pier.pierX, pier.pierZ, pier.halfWidth, pier.halfWidth, yaw,
        pier.groundY, pier.top, pierMask,
      );
      piers++;
    }
    decks++;
    railRuns += 2;
    openings += Number(pierResults.length > 0 || segment.length >= limits.minimumPierSpan);
    const level = physicalLevels.get(segment.level) ?? { physicalLevel: segment.level, surfaceY: transportSurfaceY(segment.level), segments: 0 };
    level.segments++;
    physicalLevels.set(segment.level, level);
    accepted.push(segment);
  }

  const visualTriangles = visual.indices.length / 3;
  const visualBytes = (visual.positions.length + visual.normals.length + visual.colors.length + visual.indices.length) * 4;
  const collisionBytes = (collision.colliders.length * 4) + (collision.collisionVertices.length * 4) +
    (collision.collisionRingOffsets.length * 4) + (collision.collisionPolygonOffsets.length * 4) +
    (collision.collisionSpans.length * 4) + collision.collisionMasks.length * 2;
  if (visualTriangles > limits.maxVisualTriangles || visualBytes > limits.maxVisualBytes ||
      collision.collisionSpans.length / 2 > limits.maxCompounds) {
    return compileEmptyOnCap({ geometry: true });
  }
  const allBytes = visualBytes + collisionBytes;
  if (allBytes > limits.maxVisualBytes + 128 * 1024) return compileEmptyOnCap({ bytes: true });
  for (const segment of accepted) ownerCounts.set(segment.featureIndex, (ownerCounts.get(segment.featureIndex) ?? 0) + 1);
  return Object.freeze({
    namespace: GDO_BRIDGE_GRAMMAR_NAMESPACE,
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
    compoundStride: GEO_BRIDGE_COMPOUND_STRIDE,
    meta: Object.freeze({
      namespace: GDO_BRIDGE_GRAMMAR_NAMESPACE,
      sourceFeatures: ownerCounts.size,
      segments: accepted.length,
      decks, railRuns, railPosts, piers,
      compounds: collision.collisionSpans.length / 2,
      openings,
      physicalLevels: Object.freeze([...physicalLevels.values()].sort((a, b) => a.physicalLevel - b.physicalLevel)),
      boxes, triangles: visualTriangles, bytes: allBytes,
      capEvents: Object.freeze({
        visualBoxes: visualBoxCapReached,
        railPosts: railPostCapReached,
      }),
    }),
  });
}

export function bridgeGrammarRecipes() {
  const support = {
    id: 1,
    roleMask: GEO_SUPPORT_ROLE.BRIDGE_DECK | GEO_SUPPORT_ROLE.BRIDGE_RAIL,
    x: 0, y: 0, z: 0, halfWidth: .5, halfDepth: .5, yaw: 0,
  };
  return Object.freeze(['deck', 'rail', 'pier'].map(name => Object.freeze({
    id: `${GDO_BRIDGE_GRAMMAR_NAMESPACE}:${name}`,
    role: name === 'pier' ? 'silhouette' : name,
    recipe: createObjectRecipe({
      id: `${GDO_BRIDGE_GRAMMAR_NAMESPACE}:${name}`,
      owner: GDO_BRIDGE_GRAMMAR_NAMESPACE,
      support,
      height: name === 'rail' ? GEO_BRIDGE_LIMITS.railHeight : .5,
      silhouette: [{
        id: name,
        minimumLod: GEO_OBJECT_LOD.FAR,
        boxes: [{ centerX: 0, bottom: 0, centerZ: 0, sizeX: .5, sizeY: .1, sizeZ: .5, color: name === 'pier' ? PIER_COLOR : name === 'rail' ? RAIL_COLOR : DECK_COLOR }],
      }],
    }),
  })));
}
