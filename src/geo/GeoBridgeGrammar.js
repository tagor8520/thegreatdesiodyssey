import { featureNamespace } from '../engine/FeatureVersions.js';
import { roadStyle } from './GeoTileBuilder.js';
import { GEO_PLAYER_COLLISION_PROFILE } from './GeoCollision.js';
import { transportSurfaceY } from './GeoLayers.js';
import {
  GEO_OBJECT_LOD,
  compileObjectRecipe,
  createObjectRecipe,
} from './GeoObjectRecipe.js';
import { GEO_SUPPORT_ROLE } from './GeoSupportSlots.js';
import { terrainHeightAt } from './GeoTerrain.js';

export const GDO_BRIDGE_NAMESPACE = featureNamespace('bridgeGrammar');
export const GEO_BRIDGE_STRIDE = 11;

/**
 * One record places exactly one instanced module from the deck frame, so the
 * renderer never re-derives authority and never needs terrain access.
 *
 * x, y, z      module origin in world units; y is the authoritative deck-relative height
 * length       scale along local X (0 = rigid unit)
 * width        scale along local Z (0 = rigid unit)
 * height       scale along local Y (0 = rigid unit)
 * yaw          rotation about world Y; the deck-span axis for linear modules
 * pitch        rotation about the local X axis; deck slope for linear modules
 * family       GEO_BRIDGE_FAMILY
 * level        physical transport level, always >= 1 for a bridge
 * stableId     24-bit geometry-derived identity, unique per source owner
 */
export const GEO_BRIDGE_FIELD = Object.freeze({
  X: 0, Y: 1, Z: 2,
  LENGTH: 3, WIDTH: 4, HEIGHT: 5,
  YAW: 6, PITCH: 7,
  FAMILY: 8, LEVEL: 9, STABLE_ID: 10,
});

export const GEO_BRIDGE_FAMILY = Object.freeze({
  RAIL_SPAN: 0,
  RAIL_POST: 1,
  DECK_SIDE: 2,
  DECK_BAND: 3,
  PIER: 4,
  LAMP: 5,
  SIGN: 6,
});

export const GEO_BRIDGE_FAMILY_NAMES = Object.freeze([
  'rail-span', 'rail-post', 'deck-side', 'deck-band', 'pier', 'lamp', 'sign',
]);

export const GEO_BRIDGE_LIMITS = Object.freeze({
  maxSourceFeatures: 4_096,
  maxSegments: 1_024,
  // Matches the resident pool ceiling so one full tile payload always fits.
  maxPlacementsPerTile: 384,
  maxAccentsPerTile: 24,
  maxBoxesPerFamily: 8,
  maxModulesPerFamily: 4,
  // Repeated rail posts. A .8-unit spacing at 1:10 is a 8 m post rhythm.
  postSpacing: .8,
  maxPostsPerSpan: 10,
  // Piers repeat along a span, bounded per span.
  pierSpacing: 1.6,
  maxPiersPerSpan: 4,
  // Accents are deliberately sparse: one span in every N carries a lamp/sign.
  accentSpanInterval: 3,
  // Girder/fascia depth below the authoritative deck top.
  deckDepth: .075,
  railHalfThickness: .015,
  railEdgeInset: .014,
  railHeight: .085,
  // The rail line may never imply a walkway narrower than the player needs.
  corridorMargin: .02,
  // An underside opening shorter than this gets no pier at all.
  minPierClearance: .10,
  // Below this opening a pier exists but is unreachable, so it stays visual-only.
  minStructuralClearance: .22,
  minSpanLength: .06,
  // A single mapped span longer than this is treated as malformed rather than
  // scaled into an implausible module.
  maxSpanLength: 256,
  bytesPerTile: 384 * GEO_BRIDGE_STRIDE * Float32Array.BYTES_PER_ELEMENT,
});

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

function spanKey(x1, z1, x2, z2, halfWidth, level) {
  return `${quantized(x1)}:${quantized(z1)}:${quantized(x2)}:${quantized(z2)}:${quantized(halfWidth)}:${level}`;
}

function box(centerX, bottom, centerZ, sizeX, sizeY, sizeZ, color, yaw = 0) {
  return { centerX, bottom, centerZ, sizeX, sizeY, sizeZ, color, yaw };
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

const DECK_COLOR = [.215, .215, .205];
const GIRDER_COLOR = [.165, .168, .162];
const STEEL_COLOR = [.095, .105, .115];
const PIER_COLOR = [.245, .238, .225];
const SIGN_COLOR = [.10, .29, .42];
const SIGN_BORDER_COLOR = [.73, .74, .66];
const LAMP_COLOR = [.035, .045, .035];
const LAMP_HEAD_COLOR = [1, .48, .06];

/**
 * Local-space module geometry per family. Every family is authored around its
 * own origin: `rail-span`/`deck-side` span exactly one world unit along local X,
 * `deck-side`/`deck-end` span exactly one world unit along local Z, and `pier`
 * spans exactly one world unit along local Y so the deck gap drives its scale.
 */
function familyModules(family) {
  if (family === GEO_BRIDGE_FAMILY.RAIL_SPAN) return {
    silhouette: [{ id: 'rail-beam', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [
      box(0, .012, 0, 1, .052, .026, STEEL_COLOR),
      box(0, .062, 0, 1, .023, .032, [.13, .145, .155]),
    ] }],
    surface: [{ id: 'rail-brackets', minimumLod: GEO_OBJECT_LOD.MID, boxes: [
      box(-.25, .012, 0, .022, .05, .038, GIRDER_COLOR),
      box(.25, .012, 0, .022, .05, .038, GIRDER_COLOR),
    ] }],
  };
  if (family === GEO_BRIDGE_FAMILY.RAIL_POST) return {
    silhouette: [{ id: 'rail-post', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [
      box(0, 0, 0, .026, .085, .026, STEEL_COLOR),
    ] }],
    accents: [{ id: 'rail-post-cap', minimumLod: GEO_OBJECT_LOD.NEAR, boxes: [
      box(0, .083, 0, .034, .016, .034, [.17, .185, .195]),
    ] }],
  };
  if (family === GEO_BRIDGE_FAMILY.DECK_SIDE) return {
    silhouette: [{ id: 'deck-girder', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [
      box(0, -.07, .489, 1, .076, .022, GIRDER_COLOR),
      box(0, -.07, -.489, 1, .076, .022, GIRDER_COLOR),
      box(0, -.07, 0, 1, .022, .956, [.185, .183, .175]),
    ] }],
    surface: [{ id: 'deck-drip-lip', minimumLod: GEO_OBJECT_LOD.MID, boxes: [
      box(0, -.049, .5, 1, .014, .03, DECK_COLOR),
      box(0, -.049, -.5, 1, .014, .03, DECK_COLOR),
    ] }],
  };
  if (family === GEO_BRIDGE_FAMILY.DECK_BAND) return {
    // One band per source segment: it closes a span end where the bridge meets
    // ground, and reads as a deck expansion joint where two spans meet.
    silhouette: [{ id: 'deck-abutment', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [
      box(0, -.075, 0, .09, .081, 1, DECK_COLOR),
    ] }],
    surface: [{ id: 'deck-end-band', minimumLod: GEO_OBJECT_LOD.MID, boxes: [
      box(0, .002, 0, .026, .012, 1, [.28, .275, .262]),
    ] }],
  };
  if (family === GEO_BRIDGE_FAMILY.PIER) return {
    // Authored hanging below its origin: the record origin is the deck
    // underside, and the measured clearance stretches the column down to the
    // exact terrain support beneath it.
    silhouette: [{ id: 'pier-column', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [
      box(0, -1, 0, .05, .95, .05, PIER_COLOR),
    ] }],
    surface: [{ id: 'pier-footing', minimumLod: GEO_OBJECT_LOD.MID, boxes: [
      box(0, -.05, 0, .112, .05, .112, [.20, .196, .186]),
    ] }],
  };
  if (family === GEO_BRIDGE_FAMILY.LAMP) return {
    silhouette: [{ id: 'lamp-mast', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [
      box(0, 0, 0, .022, .34, .022, LAMP_COLOR),
      box(0, .328, -.075, .022, .022, .16, LAMP_COLOR),
    ] }],
    accents: [{ id: 'lamp-head', minimumLod: GEO_OBJECT_LOD.NEAR, boxes: [
      box(0, .30, -.155, .095, .085, .095, LAMP_HEAD_COLOR),
    ] }],
  };
  if (family === GEO_BRIDGE_FAMILY.SIGN) return {
    silhouette: [{ id: 'sign-post', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [
      box(0, 0, 0, .02, .20, .02, LAMP_COLOR),
    ] }],
    accents: [{ id: 'sign-plate', minimumLod: GEO_OBJECT_LOD.NEAR, boxes: [
      box(0, .175, 0, .21, .085, .014, SIGN_COLOR),
      box(0, .175, -.011, .17, .05, .01, SIGN_BORDER_COLOR),
    ] }],
  };
  throw new RangeError(`Unknown bridge family: ${family}`);
}

/**
 * Compile one shared, local-space bridge archetype through `DET-02`.
 * Visual modules carry no proxy of any kind: the authoritative deck, rail
 * compound list, and traversal truth stay owned by `COL-07`/`LAY-02`.
 */
export function createBridgeRecipe(family) {
  if (!Number.isInteger(family) || family < 0 || family >= GEO_BRIDGE_FAMILY_NAMES.length) {
    throw new RangeError(`Unknown bridge family: ${family}`);
  }
  const modules = familyModules(family);
  const allModules = [...(modules.silhouette ?? []), ...(modules.surface ?? []), ...(modules.accents ?? [])];
  const bounds = visualBounds(allModules);
  const recipe = createObjectRecipe({
    id: `${GDO_BRIDGE_NAMESPACE}:${GEO_BRIDGE_FAMILY_NAMES[family]}`,
    owner: GDO_BRIDGE_NAMESPACE,
    support: {
      id: family + 1,
      roleMask: GEO_SUPPORT_ROLE.BRIDGE_DECK,
      x: 0, y: 0, z: 0,
      halfWidth: Math.max(.02, (bounds.maxX - bounds.minX) / 2),
      halfDepth: Math.max(.02, (bounds.maxZ - bounds.minZ) / 2),
      yaw: 0,
    },
    authoritativeFootprint: 'physical-transport-level-deck',
    height: Math.max(0, bounds.maxY),
    silhouette: modules.silhouette,
    surface: modules.surface,
    accents: modules.accents,
    visualBounds: bounds,
    solidProxies: [],
    interactionProxies: [],
    cameraRoles: [],
  });
  return Object.freeze({
    family,
    name: GEO_BRIDGE_FAMILY_NAMES[family],
    recipe,
    compiled: compileObjectRecipe(recipe, {
      lod: GEO_OBJECT_LOD.NEAR,
      maxModules: GEO_BRIDGE_LIMITS.maxModulesPerFamily,
      maxBoxes: GEO_BRIDGE_LIMITS.maxBoxesPerFamily,
    }),
  });
}

const SHARED_RECIPES = Object.freeze(GEO_BRIDGE_FAMILY_NAMES.map((_, family) => createBridgeRecipe(family)));

export function bridgeRecipes() { return SHARED_RECIPES; }

/**
 * Free half-width of the walkable corridor once both rail lines are in place.
 * Rails are only emitted when this still fits the authoritative player profile.
 */
export function bridgeCorridorHalfWidth(halfWidth) {
  const railHalfThickness = GEO_BRIDGE_LIMITS.railHalfThickness;
  const edgeMargin = Math.min(GEO_BRIDGE_LIMITS.railEdgeInset, Math.max(0, halfWidth * .25));
  return halfWidth - edgeMargin - railHalfThickness * 2;
}

export function bridgeRequiredCorridorHalfWidth() {
  return GEO_PLAYER_COLLISION_PROFILE.radius + GEO_PLAYER_COLLISION_PROFILE.skin +
    GEO_BRIDGE_LIMITS.corridorMargin;
}

function emptyResult(meta = {}) {
  return Object.freeze({
    namespace: GDO_BRIDGE_NAMESPACE,
    placements: new Float32Array(),
    stride: GEO_BRIDGE_STRIDE,
    meta: Object.freeze({
      namespace: GDO_BRIDGE_NAMESPACE,
      transportFeatures: 0,
      segments: 0,
      malformedSegments: 0,
      placements: 0,
      spans: 0,
      railedSpans: 0,
      narrowSpans: 0,
      piers: 0,
      structuralPiers: 0,
      accents: 0,
      minimumCorridorHalfWidth: 0,
      requiredCorridorHalfWidth: bridgeRequiredCorridorHalfWidth(),
      minimumUndersideClearance: 0,
      minimumSpanLength: 0,
      maximumLevel: 0,
      levelCounts: Object.freeze({}),
      familyCounts: Object.freeze(Array(GEO_BRIDGE_FAMILY_NAMES.length).fill(0)),
      bytes: 0,
      rejected: Object.freeze({}),
      capEvents: Object.freeze({}),
      ...meta,
    }),
  });
}

function collectSpans(vectorTile, request) {
  const layer = vectorTile?.layers?.transportation ?? vectorTile?.layers?.streets;
  if (!layer) return { spans: [], malformed: 0, transportFeatures: 0, truncated: false };
  if (!Number.isInteger(layer.length) || layer.length < 0 ||
      layer.length > GEO_BRIDGE_LIMITS.maxSourceFeatures) {
    return { spans: [], malformed: 0, transportFeatures: 0, truncated: true };
  }
  const terrainSeed = Number.isFinite(request.terrainSeed) ? request.terrainSeed : 0;
  const byKey = new Map();
  let malformed = 0, transportFeatures = 0, truncated = false;
  features: for (let featureIndex = 0; featureIndex < layer.length; featureIndex++) {
    let feature;
    try { feature = layer.feature(featureIndex); } catch { malformed++; continue; }
    if (!feature || feature.type !== 2 || !Number.isFinite(feature.extent) || feature.extent <= 0) continue;
    const style = roadStyle(feature.properties ?? {});
    // DET-05 owns ground furniture; DET-08 owns every elevated transport grade.
    if (!(style.transport.physicalLevel > 0)) continue;
    transportFeatures++;
    let geometry;
    try { geometry = feature.loadGeometry(); } catch { malformed++; continue; }
    if (!Array.isArray(geometry)) { malformed++; continue; }
    for (const line of geometry) {
      if (!Array.isArray(line)) { malformed++; continue; }
      for (let index = 1; index < line.length; index++) {
        if (byKey.size >= GEO_BRIDGE_LIMITS.maxSegments) { truncated = true; break features; }
        const firstPoint = line[index - 1], secondPoint = line[index];
        if (!finitePoint(firstPoint) || !finitePoint(secondPoint)) { malformed++; continue; }
        let first = pointToWorld(firstPoint, feature.extent, request);
        let second = pointToWorld(secondPoint, feature.extent, request);
        // Half-open, winding-independent ownership keeps remounts and provider
        // reorders byte-identical.
        if (first[0] > second[0] || (first[0] === second[0] && first[1] > second[1])) [first, second] = [second, first];
        const length = Math.hypot(second[0] - first[0], second[1] - first[1]);
        if (!Number.isFinite(length) || length < GEO_BRIDGE_LIMITS.minSpanLength ||
            length > GEO_BRIDGE_LIMITS.maxSpanLength) { malformed++; continue; }
        const halfWidth = style.width / 2;
        if (!(halfWidth > 0)) { malformed++; continue; }
        const level = style.transport.physicalLevel;
        const key = spanKey(first[0], first[1], second[0], second[1], halfWidth, level);
        if (byKey.has(key)) continue;
        const deckOffset = transportSurfaceY(level);
        const y1 = terrainHeightAt(first[0], first[1], terrainSeed) + deckOffset;
        const y2 = terrainHeightAt(second[0], second[1], terrainSeed) + deckOffset;
        if (!Number.isFinite(y1) || !Number.isFinite(y2)) { malformed++; continue; }
        byKey.set(key, {
          key,
          x1: first[0], z1: first[1], x2: second[0], z2: second[1],
          y1, y2, halfWidth, level, length,
          kind: style.kind,
          tangentX: (second[0] - first[0]) / length,
          tangentZ: (second[1] - first[1]) / length,
          hash: hashText(`${GDO_BRIDGE_NAMESPACE}:${key}`),
        });
      }
    }
  }
  if (truncated) return { spans: [], malformed, transportFeatures, truncated };
  const spans = [...byKey.values()].sort((first, second) => first.key.localeCompare(second.key));
  return { spans, malformed, transportFeatures, truncated: false };
}

/**
 * Compile one source tile's elevated transport spans into a bounded,
 * transferable module stream. Spans are admitted whole: a span whose complete
 * module set would breach the per-tile ceiling is skipped rather than partially
 * built, so no bridge is ever rendered with a missing rail or floating pier.
 */
export function compileBridges(vectorTile, request) {
  if (!request || ![request.tileX, request.tileY, request.originX, request.originY, request.tileSize]
    .every(Number.isFinite) || request.tileSize <= 0) {
    throw new TypeError('Bridge grammar requires a finite source-tile request');
  }
  const collected = collectSpans(vectorTile, request);
  if (collected.truncated || !collected.spans.length) return emptyResult({
    transportFeatures: collected.transportFeatures,
    segments: collected.spans.length,
    malformedSegments: collected.malformed,
    capEvents: Object.freeze({ segments: collected.truncated, malformedSegments: false }),
  });

  const requiredCorridor = bridgeRequiredCorridorHalfWidth();
  const records = [], levelCounts = {};
  const rejected = { low: 0, terrain: 0, placementCap: 0 };
  let spans = 0, railedSpans = 0, narrowSpans = 0, piers = 0, structuralPiers = 0, accents = 0;
  let minimumCorridorHalfWidth = Infinity, minimumUndersideClearance = Infinity;
  let minimumSpanLength = Infinity, maximumLevel = 0;
  let placementCapReached = false, accentCapReached = false;

  const push = record => records.push(record);

  for (const span of collected.spans) {
    const corridorHalfWidth = bridgeCorridorHalfWidth(span.halfWidth);
    const railsAllowed = corridorHalfWidth >= requiredCorridor;
    const piersWanted = Math.max(1, Math.min(GEO_BRIDGE_LIMITS.maxPiersPerSpan,
      Math.round(span.length / GEO_BRIDGE_LIMITS.pierSpacing) || 1));
    const postCount = railsAllowed
      ? Math.max(1, Math.min(GEO_BRIDGE_LIMITS.maxPostsPerSpan,
        Math.floor(span.length / GEO_BRIDGE_LIMITS.postSpacing)))
      : 0;
    const accentKind = railsAllowed && !span.kind.includes('rail') &&
      span.hash % GEO_BRIDGE_LIMITS.accentSpanInterval === 0;
    const perSpan = 1 + 2 + (railsAllowed ? 2 : 0) + postCount * (railsAllowed ? 2 : 0) + piersWanted +
      (accentKind ? 1 : 0);
    // Whole-span admission: never emit a partially built bridge.
    if (records.length + perSpan > GEO_BRIDGE_LIMITS.maxPlacementsPerTile) {
      placementCapReached = true;
      rejected.placementCap++;
      continue;
    }
    if (accentKind && accents >= GEO_BRIDGE_LIMITS.maxAccentsPerTile) {
      accentCapReached = true;
      continue;
    }

    const midX = (span.x1 + span.x2) / 2, midZ = (span.z1 + span.z2) / 2;
    const midY = (span.y1 + span.y2) / 2;
    const yaw = Math.atan2(span.tangentZ, span.tangentX);
    const rise = (span.y2 - span.y1) / span.length;
    const pitch = Math.atan(rise);
    const spacing = span.hash;
    let stableId = mix32(span.hash ^ 0x9e3779b9);

    spans++;
    levelCounts[span.level] = (levelCounts[span.level] ?? 0) + 1;
    maximumLevel = Math.max(maximumLevel, span.level);
    minimumSpanLength = Math.min(minimumSpanLength, span.length);
    if (railsAllowed) {
      railedSpans++;
      minimumCorridorHalfWidth = Math.min(minimumCorridorHalfWidth, corridorHalfWidth);
    } else narrowSpans++;

    // Deck fascia/girder: one module spanning the authoritative deck quad.
    push({
      x: midX, y: midY, z: midZ, length: span.length, width: span.halfWidth * 2, height: 0,
      yaw, pitch, family: GEO_BRIDGE_FAMILY.DECK_SIDE, level: span.level,
      stableId: stableId = (stableId + 0x85ebca6b) >>> 0,
    });

    // Abutments close both span ends at the deck's own grade.
    for (const end of [-1, 1]) {
      const t = end < 0 ? 0 : 1;
      push({
        x: span.x1 + span.tangentX * span.length * t,
        y: span.y1 + (span.y2 - span.y1) * t,
        z: span.z1 + span.tangentZ * span.length * t,
        length: 0, width: span.halfWidth * 2, height: 0,
        yaw, pitch: 0, family: GEO_BRIDGE_FAMILY.DECK_BAND, level: span.level,
        stableId: stableId = (stableId + 0x9e3779b1) >>> 0,
      });
    }

    if (railsAllowed) {
      const edgeMargin = Math.min(GEO_BRIDGE_LIMITS.railEdgeInset, span.halfWidth * .25);
      const railOffset = span.halfWidth - edgeMargin - GEO_BRIDGE_LIMITS.railHalfThickness;
      for (const side of [-1, 1]) {
        const offsetX = -span.tangentZ * railOffset * side;
        const offsetZ = span.tangentX * railOffset * side;
        push({
          x: midX + offsetX, y: midY, z: midZ + offsetZ,
          length: span.length, width: 0, height: 0,
          yaw, pitch, family: GEO_BRIDGE_FAMILY.RAIL_SPAN, level: span.level,
          stableId: stableId = (stableId + 0xc2b2ae35) >>> 0,
        });
        for (let post = 0; post < postCount; post++) {
          const t = (post + 1) / (postCount + 1);
          push({
            x: span.x1 + span.tangentX * span.length * t + offsetX,
            y: span.y1 + (span.y2 - span.y1) * t,
            z: span.z1 + span.tangentZ * span.length * t + offsetZ,
            length: 0, width: 0, height: 0,
            yaw, pitch: 0, family: GEO_BRIDGE_FAMILY.RAIL_POST, level: span.level,
            stableId: stableId = (stableId + 0x27d4eb2f) >>> 0,
          });
        }
      }
    }

    // Piers descend from the deck underside to the exact terrain support.
    const terrainSeed = Number.isFinite(request.terrainSeed) ? request.terrainSeed : 0;
    const deckUnderside = GEO_BRIDGE_LIMITS.deckDepth;
    for (let pier = 0; pier < piersWanted; pier++) {
      const t = (pier + .5) / piersWanted;
      const x = span.x1 + span.tangentX * span.length * t;
      const z = span.z1 + span.tangentZ * span.length * t;
      const deckY = span.y1 + (span.y2 - span.y1) * t;
      const groundY = terrainHeightAt(x, z, terrainSeed);
      if (!Number.isFinite(groundY)) { rejected.terrain++; continue; }
      const clearance = deckY - deckUnderside - groundY;
      if (!(clearance > GEO_BRIDGE_LIMITS.minPierClearance)) {
        // No real opening under the deck: span the gap from the deck side rather
        // than drawing a pier that could not exist.
        rejected.low++;
        continue;
      }
      piers++;
      if (clearance >= GEO_BRIDGE_LIMITS.minStructuralClearance) structuralPiers++;
      minimumUndersideClearance = Math.min(minimumUndersideClearance, clearance);
      push({
        x, y: deckY - deckUnderside, z,
        length: 0, width: 0, height: clearance,
        yaw, pitch: 0, family: GEO_BRIDGE_FAMILY.PIER, level: span.level,
        stableId: (stableId = (stableId + 0x165667b1) >>> 0),
      });
    }

    if (accentKind) {
      const side = spacing % 2 ? 1 : -1;
      const edgeMargin = Math.min(GEO_BRIDGE_LIMITS.railEdgeInset, span.halfWidth * .25);
      const railOffset = span.halfWidth - edgeMargin - GEO_BRIDGE_LIMITS.railHalfThickness;
      accents++;
      push({
        x: midX + -span.tangentZ * railOffset * side,
        y: midY, z: midZ + span.tangentX * railOffset * side,
        length: 0, width: 0, height: 0,
        yaw, pitch: 0,
        family: spacing % 2 ? GEO_BRIDGE_FAMILY.LAMP : GEO_BRIDGE_FAMILY.SIGN,
        level: span.level,
        stableId: stableId = (stableId + 0x7feb352d) >>> 0,
      });
    }
  }

  records.sort((first, second) => first.family - second.family || first.stableId - second.stableId ||
    first.x - second.x || first.z - second.z);
  // Float32 preserves integers only through 24 bits; resolve the rare masked
  // collision in deterministic family/ID order so every owner record is unique.
  const occupied = new Set();
  let stableIdCollisionProbes = 0;
  for (const record of records) {
    let id = record.stableId & 0x00ffffff;
    while (occupied.has(id)) { id = (id + 1) & 0x00ffffff; stableIdCollisionProbes++; }
    occupied.add(id);
    record.stableId = id;
  }

  const values = [], familyCounts = Array(GEO_BRIDGE_FAMILY_NAMES.length).fill(0);
  for (const record of records) {
    values.push(
      record.x, record.y, record.z,
      record.length, record.width, record.height,
      record.yaw, record.pitch,
      record.family, record.level, record.stableId,
    );
    familyCounts[record.family]++;
  }
  const placements = new Float32Array(values);
  const overBudget = placements.byteLength > GEO_BRIDGE_LIMITS.bytesPerTile ||
    placements.length / GEO_BRIDGE_STRIDE > GEO_BRIDGE_LIMITS.maxPlacementsPerTile;
  if (overBudget) return emptyResult({
    transportFeatures: collected.transportFeatures,
    segments: collected.spans.length,
    bytes: placements.byteLength,
    capEvents: Object.freeze({ placements: true }),
  });
  return Object.freeze({
    namespace: GDO_BRIDGE_NAMESPACE,
    placements,
    stride: GEO_BRIDGE_STRIDE,
    meta: Object.freeze({
      namespace: GDO_BRIDGE_NAMESPACE,
      transportFeatures: collected.transportFeatures,
      segments: collected.spans.length,
      malformedSegments: collected.malformed,
      placements: placements.length / GEO_BRIDGE_STRIDE,
      spans,
      railedSpans,
      narrowSpans,
      piers,
      structuralPiers,
      accents,
      stableIdCollisionProbes,
      minimumCorridorHalfWidth: Number.isFinite(minimumCorridorHalfWidth) ? minimumCorridorHalfWidth : 0,
      requiredCorridorHalfWidth: requiredCorridor,
      minimumUndersideClearance: Number.isFinite(minimumUndersideClearance) ? minimumUndersideClearance : 0,
      minimumSpanLength: Number.isFinite(minimumSpanLength) ? minimumSpanLength : 0,
      maximumLevel,
      levelCounts: Object.freeze(levelCounts),
      familyCounts: Object.freeze(familyCounts),
      bytes: placements.byteLength,
      rejected: Object.freeze(rejected),
      capEvents: Object.freeze({
        segments: false,
        malformedSegments: collected.malformed > 0,
        placements: placementCapReached,
        accents: accentCapReached,
      }),
    }),
  });
}
