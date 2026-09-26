import { featureNamespace } from '../engine/FeatureVersions.js';
import { GEO_PLAYER_COLLISION_PROFILE } from './GeoCollision.js';
import { GEO_OBJECT_LOD, compileObjectRecipe, createObjectRecipe } from './GeoObjectRecipe.js';
import { GEO_SUPPORT_ROLE, rectangleFitsSupport } from './GeoSupportSlots.js';

export const GDO_LANDMARK_NAMESPACE = featureNamespace('landmarkGrammar');

export const GEO_LANDMARK_FORM = Object.freeze({
  GATE: 'gate',
  TOWER: 'tower',
  DOME: 'dome',
});

export const GEO_LANDMARK_FORM_NAMES = Object.freeze([
  GEO_LANDMARK_FORM.GATE, GEO_LANDMARK_FORM.TOWER, GEO_LANDMARK_FORM.DOME,
]);

/** Load-bearing masses earn collision; ornament never does. */
export const GEO_LANDMARK_MASS = Object.freeze({
  PLINTH: 'plinth',
  PIER: 'pier',
  LINTEL: 'lintel',
  VOUSSOIR: 'voussoir',
  TIER: 'tier',
  BAND: 'band',
  COLUMN: 'column',
  MERLON: 'merlon',
  RIB: 'rib',
  FINIAL: 'finial',
});

/**
 * Reachable structural masses. Colonnade pilasters are deliberately excluded:
 * the plinth below them and the tiers behind them already block the same
 * volume, so a collider per pilaster would only inflate the collision set.
 */
const LOAD_BEARING = Object.freeze([
  GEO_LANDMARK_MASS.PLINTH, GEO_LANDMARK_MASS.PIER, GEO_LANDMARK_MASS.LINTEL,
  GEO_LANDMARK_MASS.TIER,
]);

export const GEO_LANDMARK_LIMITS = Object.freeze({
  // One visible hero per source tile, exactly like the curated landmarks.
  heroesPerTile: 1,
  maxSourceBuildings: 512,
  maxOpenings: 8,
  // 180 full boxes cost 181,440 B, which fits inside the 192 KiB typed budget.
  maxBoxesPerHero: 180,
  minBoxesPerHero: 12,
  maxModulesPerHero: 12,
  maxTrianglesPerHero: 3_000,
  bytesPerTile: 192 * 1024,
  addedDrawCalls: 1,
  maxCompounds: 64,
  maxStructuralCompounds: 32,
  maxHiddenFaceTests: 65_536,
  // A hero must be large enough to read as a distinguishable silhouette.
  minFootprintHalfExtent: .40,
  minFoundationArea: .16,
  minHeroHeight: .55,
  // True openings: player profile + skin + margin decides what is passable.
  minPassageWidth: GEO_PLAYER_COLLISION_PROFILE.radius * 2 + GEO_PLAYER_COLLISION_PROFILE.skin * 2 + .03,
  minPassageHeight: .34,
  headroom: .46,
  viewCorridorDepth: 1.4,
  viewCorridorWidth: .5,
  doorWidth: .30,
  // Minimum mapped depth a door tunnel needs before it is worth carving.
  doorDepth: .20,
  doorHeight: .36,
  gateWidth: [.38, .70],
  gateHeight: [.40, .64],
  gateMinimumAcross: .62,
  // Repeated-module loops.
  voussoirSteps: 3,
  voussoirRise: .035,
  voussoirInset: .035,
  tierCount: [3, 5],
  tierInset: .075,
  minTierSpan: .12,
  bandHeight: .026,
  // Repeated modules keep their authored spacing but never grow past a bounded
  // per-side count, so a huge footprint still compiles a bounded hero.
  columnSpacing: .34,
  maxColumnsPerSide: 10,
  columnSize: .05,
  columnInset: .045,
  columnHeightFraction: .28,
  merlonSpacing: .22,
  maxMerlonsPerSide: 12,
  merlonSize: .075,
  merlonHeight: .05,
  ribCount: [6, 10],
  ribWidth: .045,
  ribHeightFraction: .16,
  finialHeight: .12,
  maxCompoundToHeroExtent: .90,
});

/**
 * Mapped class/kind/subclass signals used only to choose which repeated-module
 * recipe dresses an above-threshold footprint. No identity, name, or POI claim
 * is derived here.
 */
const FORM_SIGNALS = Object.freeze({
  monument: GEO_LANDMARK_FORM.GATE, memorial: GEO_LANDMARK_FORM.GATE,
  arch: GEO_LANDMARK_FORM.GATE, gate: GEO_LANDMARK_FORM.GATE,
  city_gate: GEO_LANDMARK_FORM.GATE, torii: GEO_LANDMARK_FORM.GATE,
  ruins: GEO_LANDMARK_FORM.GATE, archaeological_site: GEO_LANDMARK_FORM.GATE,
  tower: GEO_LANDMARK_FORM.TOWER, minaret: GEO_LANDMARK_FORM.TOWER,
  clock_tower: GEO_LANDMARK_FORM.TOWER, observation_tower: GEO_LANDMARK_FORM.TOWER,
  water_tower: GEO_LANDMARK_FORM.TOWER, lighthouse: GEO_LANDMARK_FORM.TOWER,
  castle: GEO_LANDMARK_FORM.TOWER, fort: GEO_LANDMARK_FORM.TOWER, keep: GEO_LANDMARK_FORM.TOWER,
  cathedral: GEO_LANDMARK_FORM.DOME, church: GEO_LANDMARK_FORM.DOME,
  chapel: GEO_LANDMARK_FORM.DOME, temple: GEO_LANDMARK_FORM.DOME,
  mosque: GEO_LANDMARK_FORM.DOME, shrine: GEO_LANDMARK_FORM.DOME,
  stupa: GEO_LANDMARK_FORM.DOME, pagoda: GEO_LANDMARK_FORM.DOME,
  palace: GEO_LANDMARK_FORM.DOME, attraction: GEO_LANDMARK_FORM.DOME,
  museum: GEO_LANDMARK_FORM.DOME, stadium: GEO_LANDMARK_FORM.DOME,
});

/** Explicit mapped signals only; never inferred from a name or a POI claim. */
export function landmarkSignalFromProperties(properties) {
  if (!properties || typeof properties !== 'object') return null;
  for (const key of ['class', 'kind', 'subclass', 'type']) {
    const value = properties[key];
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (Object.hasOwn(FORM_SIGNALS, normalized)) return FORM_SIGNALS[normalized];
  }
  return null;
}

/**
 * The four sides of a rectangular ring, in deterministic order, each with the
 * module count its authored spacing produces. The count is clamped so a huge
 * footprint still compiles a bounded, evenly spaced colonnade or crenellation.
 */
function loopSides(area, minimumSpacing, maximumPerSide) {
  const sides = [
    { fixedX: false, value: area.minimumZ, from: area.minimumX, to: area.maximumX },
    { fixedX: false, value: area.maximumZ, from: area.minimumX, to: area.maximumX },
    { fixedX: true, value: area.minimumX, from: area.minimumZ, to: area.maximumZ },
    { fixedX: true, value: area.maximumX, from: area.minimumZ, to: area.maximumZ },
  ];
  return sides.map(side => {
    const span = side.to - side.from;
    return { ...side, span, count: Math.max(0, Math.min(maximumPerSide, Math.floor(span / minimumSpacing))) };
  }).filter(side => side.count > 0);
}

/**
 * Projected whole-loop size, computed before anything is emitted so a loop is
 * either admitted whole or pruned whole.
 */
function projectedLoopCount(area, spacing, maximumPerSide) {
  let total = 0;
  for (const side of loopSides(area, spacing, maximumPerSide)) total += side.count;
  return total;
}

function mix32(value) {
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function channel(state, salt) {
  state.value = mix32(state.value + salt);
  return state.value / 4294967296;
}

function lerp([minimum, maximum], amount) {
  return minimum + (maximum - minimum) * amount;
}

function finitePoint(point) {
  return Array.isArray(point) && point.length >= 2 &&
    Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function validRings(rings) {
  return Array.isArray(rings) && rings.length > 0 && rings.every(ring =>
    Array.isArray(ring) && ring.length >= 3 && ring.every(finitePoint));
}

function ringBounds(ring) {
  let minimumX = Infinity, minimumZ = Infinity, maximumX = -Infinity, maximumZ = -Infinity;
  for (const [x, z] of ring) {
    minimumX = Math.min(minimumX, x); minimumZ = Math.min(minimumZ, z);
    maximumX = Math.max(maximumX, x); maximumZ = Math.max(maximumZ, z);
  }
  return { minimumX, minimumZ, maximumX, maximumZ };
}

function ringArea(ring) {
  let area = 0;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    area += ring[previous][0] * ring[index][1] - ring[index][0] * ring[previous][1];
  }
  return Math.abs(area) / 2;
}

function scaledColor(color, factor) {
  return Object.freeze(color.map(value => Math.max(0, Math.min(1, value * factor))));
}

function boxAabb(box) {
  const yaw = box.yaw ?? 0, cosine = Math.cos(yaw), sine = Math.sin(yaw);
  const halfX = Math.abs(cosine) * box.sizeX / 2 + Math.abs(sine) * box.sizeZ / 2;
  const halfZ = Math.abs(sine) * box.sizeX / 2 + Math.abs(cosine) * box.sizeZ / 2;
  return {
    minimumX: box.centerX - halfX, maximumX: box.centerX + halfX,
    minimumY: box.bottom, maximumY: box.bottom + box.sizeY,
    minimumZ: box.centerZ - halfZ, maximumZ: box.centerZ + halfZ,
  };
}

function overlaps3d(first, second, epsilon = 0) {
  return first.minimumX < second.maximumX - epsilon && first.maximumX > second.minimumX + epsilon &&
    first.minimumY < second.maximumY - epsilon && first.maximumY > second.minimumY + epsilon &&
    first.minimumZ < second.maximumZ - epsilon && first.maximumZ > second.minimumZ + epsilon;
}

/**
 * Split one plate around one reserved rectangle so the rectangle stays truly
 * empty. This is what stops an arch or a door from being filled by a larger
 * enclosing slab.
 */
export function carveRectangle(plate, reserved, minimumPart = .015) {
  const minimumX = Math.max(plate.minimumX, reserved.minimumX);
  const maximumX = Math.min(plate.maximumX, reserved.maximumX);
  const minimumZ = Math.max(plate.minimumZ, reserved.minimumZ);
  const maximumZ = Math.min(plate.maximumZ, reserved.maximumZ);
  if (minimumX >= maximumX - 1e-9 || minimumZ >= maximumZ - 1e-9) return [plate];
  const parts = [];
  const emit = (partMinimumX, partMaximumX, partMinimumZ, partMaximumZ) => {
    if (partMaximumX - partMinimumX < minimumPart || partMaximumZ - partMinimumZ < minimumPart) return;
    parts.push({ minimumX: partMinimumX, maximumX: partMaximumX,
      minimumZ: partMinimumZ, maximumZ: partMaximumZ });
  };
  // Split across whichever axis leaves both remaining strips usable.
  const northDepth = minimumZ - plate.minimumZ, southDepth = plate.maximumZ - maximumZ;
  const westWidth = minimumX - plate.minimumX, eastWidth = plate.maximumX - maximumX;
  if (Math.min(northDepth, southDepth) >= Math.min(westWidth, eastWidth)) {
    emit(plate.minimumX, plate.maximumX, plate.minimumZ, minimumZ);
    emit(plate.minimumX, plate.maximumX, maximumZ, plate.maximumZ);
    emit(plate.minimumX, minimumX, minimumZ, maximumZ);
    emit(maximumX, plate.maximumX, minimumZ, maximumZ);
  } else {
    emit(plate.minimumX, minimumX, plate.minimumZ, plate.maximumZ);
    emit(maximumX, plate.maximumX, plate.minimumZ, plate.maximumZ);
    emit(minimumX, maximumX, plate.minimumZ, minimumZ);
    emit(minimumX, maximumX, maximumZ, plate.maximumZ);
  }
  if (!parts.length) parts.push(plate);
  return parts;
}

function slabBox(area, bottom, height, color) {
  return {
    centerX: (area.minimumX + area.maximumX) / 2,
    centerZ: (area.minimumZ + area.maximumZ) / 2,
    bottom,
    sizeX: area.maximumX - area.minimumX,
    sizeY: height,
    sizeZ: area.maximumZ - area.minimumZ,
    color,
    yaw: 0,
  };
}

/** Snap an approach direction onto the dominant world axis. */
export function landmarkAxis(normalX, normalZ, fallbackHash = 0) {
  if (Number.isFinite(normalX) && Number.isFinite(normalZ) && Math.hypot(normalX, normalZ) > 1e-6) {
    return Math.abs(normalX) >= Math.abs(normalZ)
      ? Object.freeze([Math.sign(normalX) || 1, 0])
      : Object.freeze([0, Math.sign(normalZ) || 1]);
  }
  const directions = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]]);
  return directions[(fallbackHash >>> 0) % 4];
}

/**
 * The hero's own approach frame: `along` points out of the mapped-road wall,
 * `across` is the flanking axis. Every opening and every repeated module is
 * authored in this frame, so repeated modules align with the approach.
 */
export function landmarkFrame(rings, axis) {
  if (!validRings(rings) || !Array.isArray(axis) || axis.length !== 2 ||
      !axis.every(Number.isFinite) || Math.abs(Math.abs(axis[0]) + Math.abs(axis[1]) - 1) > 1e-9) {
    throw new TypeError('Landmark frames require mapped rings and a unit axis');
  }
  const bounds = ringBounds(rings[0]);
  const alongX = axis[0], alongZ = axis[1];
  const acrossX = -alongZ, acrossZ = alongX;
  const centreX = (bounds.minimumX + bounds.maximumX) / 2;
  const centreZ = (bounds.minimumZ + bounds.maximumZ) / 2;
  const width = bounds.maximumX - bounds.minimumX;
  const depth = bounds.maximumZ - bounds.minimumZ;
  const toWorldX = (along, across) => centreX + alongX * along + acrossX * across;
  const toWorldZ = (along, across) => centreZ + alongZ * along + acrossZ * across;
  const localRect = (minimumAlong, maximumAlong, minimumAcross, maximumAcross) => {
    const corners = [
      [minimumAlong, minimumAcross], [maximumAlong, minimumAcross],
      [minimumAlong, maximumAcross], [maximumAlong, maximumAcross],
    ].map(([along, across]) => [toWorldX(along, across), toWorldZ(along, across)]);
    return {
      minimumX: Math.min(...corners.map(corner => corner[0])),
      maximumX: Math.max(...corners.map(corner => corner[0])),
      minimumZ: Math.min(...corners.map(corner => corner[1])),
      maximumZ: Math.max(...corners.map(corner => corner[1])),
    };
  };
  return Object.freeze({
    axis: Object.freeze([alongX, alongZ]),
    alongX, alongZ, acrossX, acrossZ, centreX, centreZ,
    alongHalf: (Math.abs(alongX) * width + Math.abs(alongZ) * depth) / 2,
    acrossHalf: (Math.abs(acrossX) * width + Math.abs(acrossZ) * depth) / 2,
    width, depth, bounds: Object.freeze({ ...bounds }),
    toWorldX, toWorldZ, localRect,
  });
}

/**
 * Discover the true openings before a single module is placed: mapped
 * courtyard/passage holes, the gate arch void, the mapped-road door void, and
 * the outward viewing corridor.
 */
export function discoverLandmarkOpenings({
  rings, form, foundationY, height, hash = 0, roadFacing = null, frame,
}) {
  if (!validRings(rings) || !frame || ![foundationY, height].every(Number.isFinite) || height <= 0) {
    throw new TypeError('Landmark openings require finite mapped rings, a frame, and a height');
  }
  const openings = [];
  const state = { value: mix32((hash >>> 0) ^ 0x9e3779b9) };
  const headroomTop = foundationY + GEO_LANDMARK_LIMITS.headroom;

  // 1. Mapped holes are genuine mapped voids; reserve their full headroom band.
  for (let index = 1; index < rings.length && openings.length < GEO_LANDMARK_LIMITS.maxOpenings; index++) {
    const hole = ringBounds(rings[index]);
    const width = Math.min(hole.maximumX - hole.minimumX, hole.maximumZ - hole.minimumZ);
    if (width < GEO_LANDMARK_LIMITS.minPassageWidth * .5) continue;
    openings.push(Object.freeze({
      id: `passage:${index}`,
      kind: 'passage',
      source: 'mapped-hole',
      minimumX: hole.minimumX, maximumX: hole.maximumX,
      minimumZ: hole.minimumZ, maximumZ: hole.maximumZ,
      minimumY: foundationY - .01, maximumY: headroomTop,
      width,
      passable: width >= GEO_LANDMARK_LIMITS.minPassageWidth,
    }));
  }

  // 2. The gate arch void: a real masonry opening through the whole hero, wide
  //    enough to walk, flanked by piers and headed by voussoirs. It is reserved
  //    before any pier exists, so no module can ever fill it.
  // The walkable arch is the gate archetype's opening. Other forms keep their
  // own mapped-hole, door, and viewing openings instead of inventing an arch.
  const gateWanted = form === GEO_LANDMARK_FORM.GATE;
  let gate = null;
  if (gateWanted && frame.acrossHalf * 2 >= GEO_LANDMARK_LIMITS.minPassageWidth + .24) {
    const gateWidth = Math.min(frame.acrossHalf * 2 - .20,
      lerp(GEO_LANDMARK_LIMITS.gateWidth, channel(state, 0x85ebca6b)));
    const gateHeight = Math.min(height * .62, lerp(GEO_LANDMARK_LIMITS.gateHeight, channel(state, 0xc2b2ae35)));
    const area = frame.localRect(-frame.alongHalf, frame.alongHalf, -gateWidth / 2, gateWidth / 2);
    gate = Object.freeze({
      id: 'arch:gate',
      kind: 'arch',
      source: 'landmark-form',
      ...area,
      minimumY: foundationY - .01, maximumY: foundationY + gateHeight,
      acrossWidth: gateWidth, height: gateHeight, depth: frame.alongHalf * 2,
      passable: gateWidth >= GEO_LANDMARK_LIMITS.minPassageWidth &&
        gateHeight >= GEO_LANDMARK_LIMITS.minPassageHeight,
    });
    openings.push(gate);
  }

  // 3. The mapped-road door void: a genuine opening through the approach axis.
  //    It runs the full mapped depth on purpose — a shallow recess would let a
  //    player walk in and then meet the mass behind it.
  let door = null;
  if (!gate && roadFacing?.found && roadFacing.edgeLength >= .3 &&
      frame.alongHalf * 2 >= GEO_LANDMARK_LIMITS.doorDepth) {
    const doorWidth = Math.min(GEO_LANDMARK_LIMITS.doorWidth, roadFacing.edgeLength * .8);
    const doorHeight = Math.min(height * .5, GEO_LANDMARK_LIMITS.doorHeight);
    const area = frame.localRect(-frame.alongHalf, frame.alongHalf, -doorWidth / 2, doorWidth / 2);
    door = Object.freeze({
      id: 'arch:door',
      kind: 'arch',
      source: 'mapped-road',
      ...area,
      minimumY: foundationY - .01, maximumY: foundationY + doorHeight,
      acrossWidth: doorWidth, height: doorHeight, depth: frame.alongHalf * 2,
      passable: doorWidth >= GEO_LANDMARK_LIMITS.minPassageWidth &&
        doorHeight >= GEO_LANDMARK_LIMITS.minPassageHeight,
    });
    openings.push(door);
  }

  return Object.freeze({
    openings: Object.freeze(openings),
    gate,
    door,
    headroomTop,
  });
}

/** A bounded viewing corridor must stay clear so the hero reads on approach. */
export function landmarkViewCorridor({ rings, axis, foundationY }) {
  const bounds = ringBounds(rings[0]);
  const alongX = axis[0], alongZ = axis[1];
  const edgeX = alongX > 0 ? bounds.maximumX : alongX < 0 ? bounds.minimumX
    : (bounds.minimumX + bounds.maximumX) / 2;
  const edgeZ = alongZ > 0 ? bounds.maximumZ : alongZ < 0 ? bounds.minimumZ
    : (bounds.minimumZ + bounds.maximumZ) / 2;
  const half = GEO_LANDMARK_LIMITS.viewCorridorWidth / 2;
  const depth = GEO_LANDMARK_LIMITS.viewCorridorDepth;
  return Object.freeze({
    id: 'corridor:view',
    kind: 'corridor',
    source: 'landmark-form',
    minimumX: alongX === 0 ? edgeX - half : Math.min(edgeX, edgeX + alongX * depth),
    maximumX: alongX === 0 ? edgeX + half : Math.max(edgeX, edgeX + alongX * depth),
    minimumZ: alongZ === 0 ? edgeZ - half : Math.min(edgeZ, edgeZ + alongZ * depth),
    maximumZ: alongZ === 0 ? edgeZ + half : Math.max(edgeZ, edgeZ + alongZ * depth),
    minimumY: foundationY, maximumY: foundationY + GEO_LANDMARK_LIMITS.headroom,
    width: GEO_LANDMARK_LIMITS.viewCorridorWidth,
    passable: true,
  });
}

/** Choose the silhouette form from explicit mapped signals, then from size. */
export function landmarkFormFor({ properties = null, hash = 0, footprintArea = 0, height = 0 } = {}) {
  const signal = landmarkSignalFromProperties(properties);
  if (signal) return Object.freeze({ form: signal, source: 'mapped-signal' });
  const aspect = height / Math.max(footprintArea, 1e-6);
  const scored = [
    { form: GEO_LANDMARK_FORM.GATE, score: (1 / Math.max(aspect, 1e-6)) * (height > .5 ? 1 : .6) },
    { form: GEO_LANDMARK_FORM.TOWER, score: aspect },
    { form: GEO_LANDMARK_FORM.DOME, score: footprintArea },
  ].sort((first, second) => second.score - first.score || first.form.localeCompare(second.form));
  // Deterministic variety: the runner-up silhouette is chosen 1 time in 3.
  const variety = (mix32((hash >>> 0) ^ 0x27d4eb2f) >>> 3) % 3;
  return Object.freeze({ form: variety === 0 ? scored[1].form : scored[0].form, source: 'form-fallback' });
}

/**
 * The one shared eligibility gate. The tile builder uses it to decide which
 * mapped footprints may record a replaceable shell; selection reuses it so a
 * footprint that is too small, too short, or malformed is never a hero.
 */
export function landmarkEligibility(rings, height) {
  if (!validRings(rings)) return Object.freeze({ eligible: false, reason: 'rings' });
  if (!Number.isFinite(height) || height < GEO_LANDMARK_LIMITS.minHeroHeight) {
    return Object.freeze({ eligible: false, reason: 'height' });
  }
  const bounds = ringBounds(rings[0]);
  const halfExtent = Math.min(bounds.maximumX - bounds.minimumX, bounds.maximumZ - bounds.minimumZ) / 2;
  if (!Number.isFinite(halfExtent) || halfExtent < GEO_LANDMARK_LIMITS.minFootprintHalfExtent) {
    return Object.freeze({ eligible: false, reason: 'footprint' });
  }
  if (ringArea(rings[0]) < GEO_LANDMARK_LIMITS.minFoundationArea) {
    return Object.freeze({ eligible: false, reason: 'area' });
  }
  return Object.freeze({ eligible: true, reason: null });
}

function candidatePriority({ formSource, footprintArea, height, roadFacing }) {
  return (formSource === 'mapped-signal' ? 1_000_000_000 : 0) +
    Math.min(1_000_000, footprintArea * 10_000) + Math.min(10_000, height * 100) +
    (roadFacing?.found ? 1 : 0);
}

/**
 * Select at most one hero per tile. Explicit mapped signals win, then larger and
 * more approachable footprints, with a stable ID tie-break.
 */
export function selectLandmarkHero(candidates, limit = GEO_LANDMARK_LIMITS.heroesPerTile) {
  if (!Array.isArray(candidates)) throw new TypeError('Landmark candidates must be an array');
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('Invalid landmark hero limit');
  const truncated = candidates.length > GEO_LANDMARK_LIMITS.maxSourceBuildings;
  const considered = truncated ? candidates.slice(0, GEO_LANDMARK_LIMITS.maxSourceBuildings) : candidates;
  const ranked = [];
  for (const input of considered) {
    if (!input) continue;
    if (![input.foundationY, input.roofY].every(Number.isFinite) || input.roofY <= input.foundationY) continue;
    if (!landmarkEligibility(input.rings, input.height).eligible) continue;
    const footprintArea = ringArea(input.rings[0]);
    const resolved = input.formSignal && GEO_LANDMARK_FORM_NAMES.includes(input.formSignal)
      ? Object.freeze({ form: input.formSignal, source: 'mapped-signal' })
      : landmarkFormFor({
        properties: input.properties, hash: input.hash ?? 0, footprintArea, height: input.height,
      });
    const id = String(input.id ?? input.owner ?? '');
    if (!id) continue;
    ranked.push(Object.freeze({
      input, id, form: resolved.form, formSource: resolved.source,
      priority: candidatePriority({
        formSource: resolved.source, footprintArea, height: input.height, roadFacing: input.roadFacing,
      }),
    }));
  }
  ranked.sort((first, second) => second.priority - first.priority || first.id.localeCompare(second.id));
  const selected = ranked.slice(0, Math.max(0, limit));
  return Object.freeze({
    selected: Object.freeze(selected),
    truncated: truncated || ranked.length > selected.length,
    considered: candidates.length,
    eligible: ranked.length,
  });
}

/**
 * The six faces in exactly the mapped-building `appendBox` order, so winding and
 * normals stay consistent with every other generated detail batch.
 */
const FACES = Object.freeze([
  Object.freeze({ axis: 2, sign: 1, corners: Object.freeze([[-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1]]) }),
  Object.freeze({ axis: 2, sign: -1, corners: Object.freeze([[1, -1, -1], [-1, -1, -1], [1, 1, -1], [-1, 1, -1]]) }),
  Object.freeze({ axis: 0, sign: 1, corners: Object.freeze([[1, -1, 1], [1, -1, -1], [1, 1, 1], [1, 1, -1]]) }),
  Object.freeze({ axis: 0, sign: -1, corners: Object.freeze([[-1, -1, -1], [-1, -1, 1], [-1, 1, -1], [-1, 1, 1]]) }),
  Object.freeze({ axis: 1, sign: 1, corners: Object.freeze([[-1, 1, 1], [1, 1, 1], [-1, 1, -1], [1, 1, -1]]) }),
  Object.freeze({ axis: 1, sign: -1, corners: Object.freeze([[-1, -1, -1], [1, -1, -1], [-1, -1, 1], [1, -1, 1]]) }),
]);

function planeKey(value) { return Math.round(value * 4_096); }

function containsBox(outer, inner) {
  return inner.minimumX >= outer.minimumX - 1e-7 && inner.maximumX <= outer.maximumX + 1e-7 &&
    inner.minimumY >= outer.minimumY - 1e-7 && inner.maximumY <= outer.maximumY + 1e-7 &&
    inner.minimumZ >= outer.minimumZ - 1e-7 && inner.maximumZ <= outer.maximumZ + 1e-7;
}

function strictlyWithin(outer, inner) {
  return containsBox(outer, inner) &&
    (inner.minimumX > outer.minimumX + 1e-9 || inner.maximumX < outer.maximumX - 1e-9 ||
      inner.minimumY > outer.minimumY + 1e-9 || inner.maximumY < outer.maximumY - 1e-9 ||
      inner.minimumZ > outer.minimumZ + 1e-9 || inner.maximumZ < outer.maximumZ - 1e-9);
}

/**
 * Hidden-face compilation: contained boxes are dropped and any face fully
 * covered by an opposing coincident face of another box is removed. The exposed
 * shell is what makes an 80–220 box hero affordable, and it stays deterministic.
 */
export function compileLandmarkGeometry(hero, {
  maxHiddenFaceTests = GEO_LANDMARK_LIMITS.maxHiddenFaceTests,
} = {}) {
  const boxes = hero.boxes;
  if (!Array.isArray(boxes) || !boxes.length) throw new TypeError('A landmark hero needs boxes');
  if (!Number.isInteger(maxHiddenFaceTests) || maxHiddenFaceTests < 0) {
    throw new RangeError('Invalid hidden-face test budget');
  }
  const areas = boxes.map(boxAabb);
  const contained = new Array(boxes.length).fill(false);
  for (let inner = 0; inner < boxes.length; inner++) {
    for (let outer = 0; outer < boxes.length; outer++) {
      if (inner === outer || !containsBox(areas[outer], areas[inner])) continue;
      // Duplicate boxes drop only the later one, so no shell is ever erased.
      if (strictlyWithin(areas[outer], areas[inner]) || outer < inner) { contained[inner] = true; break; }
    }
  }
  const faces = [];
  for (let index = 0; index < boxes.length; index++) {
    if (contained[index]) continue;
    const box = boxes[index], area = areas[index];
    for (const face of FACES) {
      const plane = face.axis === 0
        ? (face.sign > 0 ? area.maximumX : area.minimumX)
        : face.axis === 1 ? (face.sign > 0 ? area.maximumY : area.minimumY)
          : (face.sign > 0 ? area.maximumZ : area.minimumZ);
      const tangent = face.axis === 0 ? [1, 2] : face.axis === 1 ? [0, 2] : [0, 1];
      const minimum = axis => axis === 0 ? area.minimumX : axis === 1 ? area.minimumY : area.minimumZ;
      const maximum = axis => axis === 0 ? area.maximumX : axis === 1 ? area.maximumY : area.maximumZ;
      faces.push({
        box: index, face, plane, testable: (box.yaw ?? 0) === 0, hidden: false,
        uMinimum: minimum(tangent[0]), uMaximum: maximum(tangent[0]),
        vMinimum: minimum(tangent[1]), vMaximum: maximum(tangent[1]),
      });
    }
  }
  let tests = 0, hiddenFaces = 0;
  hidden: for (const candidate of faces) {
    if (!candidate.testable) continue;
    for (const other of faces) {
      if (candidate === other || !other.testable || candidate.face.axis !== other.face.axis ||
          candidate.face.sign === other.face.sign) continue;
      if (planeKey(candidate.plane) !== planeKey(other.plane)) continue;
      if (++tests > maxHiddenFaceTests) break hidden;
      if (other.uMinimum <= candidate.uMinimum + 1e-6 && other.uMaximum >= candidate.uMaximum - 1e-6 &&
          other.vMinimum <= candidate.vMinimum + 1e-6 && other.vMaximum >= candidate.vMaximum - 1e-6) {
        candidate.hidden = true;
        hiddenFaces++;
        break;
      }
    }
  }

  const positions = [], normals = [], colors = [], indices = [];
  for (const candidate of faces) {
    if (candidate.hidden) continue;
    const box = boxes[candidate.box];
    const yaw = box.yaw ?? 0, cosine = Math.cos(yaw), sine = Math.sin(yaw);
    const base = positions.length / 3;
    for (const [x, y, z] of candidate.face.corners) {
      const localX = x * box.sizeX / 2, localZ = z * box.sizeZ / 2;
      positions.push(
        box.centerX + localX * cosine - localZ * sine,
        box.bottom + (y + 1) / 2 * box.sizeY,
        box.centerZ + localX * sine + localZ * cosine,
      );
    }
    const normal = [0, 0, 0];
    normal[candidate.face.axis] = candidate.face.sign;
    const worldNormalX = normal[0] * cosine - normal[2] * sine;
    const worldNormalZ = normal[0] * sine + normal[2] * cosine;
    for (let vertex = 0; vertex < 4; vertex++) normals.push(worldNormalX, normal[1], worldNormalZ);
    for (let vertex = 0; vertex < 4; vertex++) colors.push(...box.color);
    indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  const bytes = (positions.length + normals.length + colors.length) * 4 + indices.length * 4;
  if (indices.length / 3 > GEO_LANDMARK_LIMITS.maxTrianglesPerHero) {
    throw new Error('Landmark hero exceeded its exposed-face triangle budget');
  }
  if (bytes > GEO_LANDMARK_LIMITS.bytesPerTile) {
    throw new Error('Landmark hero exceeded its typed geometry budget');
  }
  return Object.freeze({
    namespace: GDO_LANDMARK_NAMESPACE,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    triangles: indices.length / 3,
    hiddenFaces,
    containedBoxes: contained.filter(Boolean).length,
    faces: faces.length - hiddenFaces,
    bytes,
    runtimeCsgOperations: 0,
    collisionProxies: 0,
  });
}

/** Re-bind the landmark mass label that the DET-02 box IR does not carry. */
function rebindMasses(compiled, emitted) {
  if (compiled.visualBoxes.length !== emitted.length) {
    throw new Error('Landmark hero module admission mismatch');
  }
  return Object.freeze(emitted.map((entry, index) =>
    Object.freeze({ ...compiled.visualBoxes[index], mass: entry.mass })));
}

/**
 * One hero through `DET-02`: true openings first, then load-bearing masses, then
 * repeated tiers, columns, voussoirs, crenellations, ribs, and finials from
 * bounded loops, then hidden-face compilation and tight compounds.
 */
export function createLandmarkHeroRecipe({
  id,
  owner,
  rings,
  foundationY,
  roofY,
  height,
  hash = 0,
  wallColor,
  roofColor,
  properties = null,
  roadFacing = null,
  formSignal = null,
  boxBudget = GEO_LANDMARK_LIMITS.maxBoxesPerHero,
}) {
  if (typeof id !== 'string' || !id || typeof owner !== 'string' || !owner ||
      !validRings(rings) || ![foundationY, roofY, height].every(Number.isFinite) ||
      height <= 0 || roofY <= foundationY ||
      !Array.isArray(wallColor) || wallColor.length !== 3 || !wallColor.every(Number.isFinite) ||
      !Array.isArray(roofColor) || roofColor.length !== 3 || !roofColor.every(Number.isFinite)) {
    throw new TypeError('Landmark recipes require finite mapped geometry, height, and colors');
  }
  if (!Number.isInteger(boxBudget) || boxBudget < GEO_LANDMARK_LIMITS.minBoxesPerHero ||
      boxBudget > GEO_LANDMARK_LIMITS.maxBoxesPerHero) {
    throw new RangeError('Invalid landmark box budget');
  }
  const stableHash = hash >>> 0;
  const state = { value: mix32(stableHash ^ 0x5bf03635) };
  const resolved = formSignal && GEO_LANDMARK_FORM_NAMES.includes(formSignal)
    ? Object.freeze({ form: formSignal, source: 'mapped-signal' })
    : landmarkFormFor({ properties, hash: stableHash, footprintArea: ringArea(rings[0]), height });
  const axis = landmarkAxis(roadFacing?.normalX, roadFacing?.normalZ, stableHash);
  const frame = landmarkFrame(rings, axis);
  const discovered = discoverLandmarkOpenings({
    rings, form: resolved.form, foundationY, height, hash: stableHash, roadFacing, frame,
  });
  const corridor = landmarkViewCorridor({ rings, axis, foundationY });
  const reserved = Object.freeze([...discovered.openings, corridor]);
  const diagnostics = {
    openingRejections: 0, loopRejections: 0, budgetSkips: 0, tierSpanSkipped: false,
    prunedModules: [],
  };
  const silhouette = [], surface = [], accents = [];
  // The `DET-02` box IR whitelists geometry fields, so the landmark mass label
  // is recorded here and re-bound after compilation. Records are grouped by role
  // because module compilation emits silhouette, then surface, then accents.
  const emitted = { [GEO_OBJECT_LOD.FAR]: [], [GEO_OBJECT_LOD.MID]: [], [GEO_OBJECT_LOD.NEAR]: [] };

  const wall = Object.freeze([...wallColor]);
  const stone = scaledColor(wall, .82);
  const trim = scaledColor(roofColor, .92);
  const ornament = scaledColor(roofColor, 1.05);
  const boxCount = () => silhouette.length + surface.length + accents.length;
  const emitBox = (role, mass, box) => {
    if (boxCount() >= boxBudget) { diagnostics.budgetSkips++; return false; }
    const area = boxAabb(box);
    for (const volume of reserved) {
      if (overlaps3d(area, volume, 1e-6)) { diagnostics.openingRejections++; return false; }
    }
    const target = role === GEO_OBJECT_LOD.FAR ? silhouette
      : role === GEO_OBJECT_LOD.MID ? surface : accents;
    const record = Object.freeze({ ...box, mass });
    target.push(record);
    emitted[role].push(Object.freeze({ mass, role, box: record }));
    return true;
  };
  // Every mass layer is carved around each reserved volume it overlaps
  // vertically, so an opening stays empty at every height it spans.
  const emitLayer = (mass, role, area, bottom, sizeY, color) => {
    let parts = [area];
    for (const volume of reserved) {
      if (bottom >= volume.maximumY - 1e-6 || bottom + sizeY <= volume.minimumY + 1e-6) continue;
      parts = parts.flatMap(part => carveRectangle(part, volume));
    }
    let emitted = 0;
    for (const part of parts) if (emitBox(role, mass, slabBox(part, bottom, sizeY, color))) emitted++;
    return emitted;
  };

  const gate = discovered.gate;
  const plinthInset = Math.min(.05, frame.acrossHalf * .06);
  const plinth = frame.localRect(-frame.alongHalf + plinthInset, frame.alongHalf - plinthInset,
    -frame.acrossHalf + plinthInset, frame.acrossHalf - plinthInset);
  const plinthHeight = Math.max(.05, Math.min(.12, height * .14));
  const plinthTop = foundationY + plinthHeight;

  // --- Phase 1: the gate opening, its flanking piers, and its voussoirs ------
  if (gate) {
    emitLayer(GEO_LANDMARK_MASS.PLINTH, GEO_OBJECT_LOD.FAR, plinth, foundationY, plinthHeight, stone);
    const pierWidth = Math.max(.08, Math.min(.34,
      frame.acrossHalf - gate.acrossWidth / 2 - plinthInset - .01));
    for (const direction of [-1, 1]) {
      const inner = direction * gate.acrossWidth / 2;
      const outer = inner + direction * pierWidth;
      emitLayer(GEO_LANDMARK_MASS.PIER, GEO_OBJECT_LOD.FAR,
        frame.localRect(-frame.alongHalf * .94, frame.alongHalf * .94,
          Math.min(inner, outer), Math.max(inner, outer)),
        foundationY, gate.maximumY - foundationY, wall);
    }
    const lintelHeight = Math.max(.05, height * .08);
    emitBox(GEO_OBJECT_LOD.FAR, GEO_LANDMARK_MASS.LINTEL, slabBox(
      frame.localRect(-frame.alongHalf * .96, frame.alongHalf * .96,
        -gate.acrossWidth / 2, gate.acrossWidth / 2),
      gate.maximumY, lintelHeight, trim,
    ));
    // Stepped voussoir courses above the arch, from a bounded loop.
    let courseBottom = gate.maximumY + lintelHeight;
    for (let step = 0; step < GEO_LANDMARK_LIMITS.voussoirSteps; step++) {
      const shrink = (step + 1) * GEO_LANDMARK_LIMITS.voussoirInset;
      const span = Math.max(.05, gate.acrossWidth - shrink * 2);
      emitBox(GEO_OBJECT_LOD.MID, GEO_LANDMARK_MASS.VOUSSOIR, slabBox(
        frame.localRect(-frame.alongHalf * .92, frame.alongHalf * .92, -span / 2, span / 2),
        courseBottom, GEO_LANDMARK_LIMITS.voussoirRise, step % 2 === 0 ? stone : trim,
      ));
      courseBottom += GEO_LANDMARK_LIMITS.voussoirRise;
    }
  } else {
    // A door void is honoured here: the plinth is carved around it rather than
    // sealed by it, so the mapped-road approach stays walkable.
    emitLayer(GEO_LANDMARK_MASS.PLINTH, GEO_OBJECT_LOD.FAR, plinth, foundationY, plinthHeight, stone);
  }

  // --- Phase 2: repeated tiers and cornice bands ----------------------------
  const shaftBottom = gate
    ? gate.maximumY + Math.max(.05, height * .08) +
      GEO_LANDMARK_LIMITS.voussoirSteps * GEO_LANDMARK_LIMITS.voussoirRise
    : plinthTop;
  const totalSpan = Math.max(0, roofY - shaftBottom);
  let tiersPlaced = 0;
  const tierCount = Math.max(1, Math.round(lerp(GEO_LANDMARK_LIMITS.tierCount, channel(state, 0x7feb352d))));
  const slice = totalSpan / tierCount;
  if (totalSpan < GEO_LANDMARK_LIMITS.minTierSpan) diagnostics.tierSpanSkipped = true;
  for (let tier = 0; tier < tierCount && !diagnostics.tierSpanSkipped; tier++) {
    const bottom = shaftBottom + tier * slice;
    const inset = plinthInset + GEO_LANDMARK_LIMITS.tierInset * (tier + 1);
    const area = frame.localRect(-frame.alongHalf + inset, frame.alongHalf - inset,
      -frame.acrossHalf + inset, frame.acrossHalf - inset);
    if (area.maximumX - area.minimumX < .04 || area.maximumZ - area.minimumZ < .04) {
      diagnostics.loopRejections++;
      continue;
    }
    if (!emitLayer(GEO_LANDMARK_MASS.TIER, GEO_OBJECT_LOD.FAR, area, bottom, slice, wall)) {
      diagnostics.loopRejections++;
      continue;
    }
    tiersPlaced++;
    if (tier > 0) emitLayer(GEO_LANDMARK_MASS.BAND, GEO_OBJECT_LOD.MID, {
      minimumX: area.minimumX - .012, maximumX: area.maximumX + .012,
      minimumZ: area.minimumZ - .012, maximumZ: area.maximumZ + .012,
    }, bottom - GEO_LANDMARK_LIMITS.bandHeight * .5, GEO_LANDMARK_LIMITS.bandHeight, trim);
  }

  // --- Phase 3: whole-module admission for the repeated loops ---------------
  const columnBottom = plinthTop;
  const columnTop = Math.min(shaftBottom + totalSpan * .5,
    columnBottom + Math.max(.06, height * GEO_LANDMARK_LIMITS.columnHeightFraction));
  const columnRing = frame.localRect(-frame.alongHalf + GEO_LANDMARK_LIMITS.columnInset,
    frame.alongHalf - GEO_LANDMARK_LIMITS.columnInset,
    -frame.acrossHalf + GEO_LANDMARK_LIMITS.columnInset,
    frame.acrossHalf - GEO_LANDMARK_LIMITS.columnInset);
  const crownInset = Math.min(plinthInset + GEO_LANDMARK_LIMITS.tierInset * (tiersPlaced + 1),
    Math.min(frame.alongHalf, frame.acrossHalf) * .35);
  const crown = frame.localRect(-frame.alongHalf + crownInset, frame.alongHalf - crownInset,
    -frame.acrossHalf + crownInset, frame.acrossHalf - crownInset);
  const crownTop = shaftBottom + tiersPlaced * slice;
  const ribCount = resolved.form === GEO_LANDMARK_FORM.DOME
    ? Math.round(lerp(GEO_LANDMARK_LIMITS.ribCount, channel(state, 0x165667b1))) : 0;
  // A loop is admitted whole or skipped whole: a hero never carries half a
  // crenellation or two thirds of a colonnade.
  const projectedColumns = projectedLoopCount(columnRing,
    GEO_LANDMARK_LIMITS.columnSpacing, GEO_LANDMARK_LIMITS.maxColumnsPerSide);
  const projectedMerlons = projectedLoopCount(crown,
    GEO_LANDMARK_LIMITS.merlonSpacing, GEO_LANDMARK_LIMITS.maxMerlonsPerSide);
  const admitted = new Set();
  let optionalRoom = boxBudget - boxCount();
  for (const module of [
    { id: 'columns', projected: columnTop > columnBottom ? projectedColumns : 0 },
    { id: 'merlons', projected: projectedMerlons },
    { id: 'ribs', projected: ribCount },
    { id: 'finial', projected: 2 },
  ]) {
    if (module.projected > 0 && module.projected <= optionalRoom) {
      admitted.add(module.id);
      optionalRoom -= module.projected;
    } else if (module.projected > 0) {
      diagnostics.prunedModules.push(module.id);
    }
  }

  const columnHalf = GEO_LANDMARK_LIMITS.columnSize / 2;
  let columnsPlaced = 0;
  if (admitted.has('columns')) {
    for (const side of loopSides(columnRing,
      GEO_LANDMARK_LIMITS.columnSpacing, GEO_LANDMARK_LIMITS.maxColumnsPerSide)) {
      const spacing = side.span / side.count;
      for (let index = 0; index < side.count; index++) {
        const centre = side.from + spacing * (index + .5);
        const x = side.fixedX ? side.value : centre;
        const z = side.fixedX ? centre : side.value;
        if (!rectangleFitsSupport(rings, x, z, columnHalf, columnHalf, 0)) {
          diagnostics.loopRejections++;
          continue;
        }
        if (emitBox(GEO_OBJECT_LOD.NEAR, GEO_LANDMARK_MASS.COLUMN, {
          centerX: x, centerZ: z, bottom: columnBottom, sizeX: GEO_LANDMARK_LIMITS.columnSize,
          sizeY: columnTop - columnBottom, sizeZ: GEO_LANDMARK_LIMITS.columnSize,
          color: stone, yaw: 0,
        })) columnsPlaced++;
      }
    }
  }

  // --- Phase 4: crown crenellations, ribs, and skyline-only finials ---------
  const merlonHalf = GEO_LANDMARK_LIMITS.merlonSize / 2;
  let merlonsPlaced = 0;
  if (admitted.has('merlons')) {
    for (const side of loopSides(crown,
      GEO_LANDMARK_LIMITS.merlonSpacing, GEO_LANDMARK_LIMITS.maxMerlonsPerSide)) {
      const spacing = side.span / side.count;
      for (let index = 0; index < side.count; index++) {
        const centre = side.from + spacing * (index + .5);
        const x = side.fixedX ? side.value : centre;
        const z = side.fixedX ? centre : side.value;
        if (!rectangleFitsSupport(rings, x, z, merlonHalf, merlonHalf, 0)) {
          diagnostics.loopRejections++;
          continue;
        }
        if (emitBox(GEO_OBJECT_LOD.MID, GEO_LANDMARK_MASS.MERLON, {
          centerX: x, centerZ: z, bottom: crownTop, sizeX: GEO_LANDMARK_LIMITS.merlonSize,
          sizeY: GEO_LANDMARK_LIMITS.merlonHeight, sizeZ: GEO_LANDMARK_LIMITS.merlonSize,
          color: trim, yaw: 0,
        })) merlonsPlaced++;
      }
    }
  }
  if (admitted.has('ribs')) {
    const radius = Math.max(.06, Math.min(frame.acrossHalf, frame.alongHalf) - crownInset -
      GEO_LANDMARK_LIMITS.ribWidth);
    for (let rib = 0; rib < ribCount; rib++) {
      const angle = (rib / ribCount) * Math.PI * 2;
      emitBox(GEO_OBJECT_LOD.NEAR, GEO_LANDMARK_MASS.RIB, {
        centerX: frame.centreX + Math.cos(angle) * radius,
        centerZ: frame.centreZ + Math.sin(angle) * radius,
        bottom: crownTop, sizeX: GEO_LANDMARK_LIMITS.ribWidth,
        sizeY: Math.max(.05, height * GEO_LANDMARK_LIMITS.ribHeightFraction),
        sizeZ: GEO_LANDMARK_LIMITS.ribWidth, color: ornament, yaw: angle,
      });
    }
  }
  // Skyline-only finials: visual ornament that never earns collision.
  const finialHeight = Math.max(.05, Math.min(GEO_LANDMARK_LIMITS.finialHeight, height * .18));
  for (let step = 0; admitted.has('finial') && step < 2; step++) {
    emitBox(GEO_OBJECT_LOD.NEAR, GEO_LANDMARK_MASS.FINIAL, {
      centerX: frame.centreX, centerZ: frame.centreZ,
      bottom: crownTop + GEO_LANDMARK_LIMITS.merlonHeight * .5 + step * finialHeight * .5,
      sizeX: .09 - step * .03, sizeY: finialHeight * .5, sizeZ: .09 - step * .03,
      color: ornament, yaw: 0,
    });
  }

  // Whole-module completion: a hero that cannot be finished is never emitted.
  if (boxCount() < GEO_LANDMARK_LIMITS.minBoxesPerHero) {
    throw new Error('Landmark hero could not be completed within its module budget');
  }

  const compiled = compileObjectRecipe(createObjectRecipe({
    id,
    owner,
    support: {
      id: (mix32(stableHash ^ 0x51ed2701) & 0x00ffffff) || 1,
      roleMask: GEO_SUPPORT_ROLE.BUILDING_DETAIL,
      x: frame.centreX, y: foundationY, z: frame.centreZ,
      halfWidth: Math.max(.01, frame.width / 2), halfDepth: Math.max(.01, frame.depth / 2), yaw: 0,
    },
    authoritativeFootprint: 'mapped-building-rings',
    height,
    silhouette: silhouette.length
      ? [{ id: 'landmark-mass', minimumLod: GEO_OBJECT_LOD.FAR, order: 0, boxes: silhouette }] : [],
    surface: surface.length
      ? [{ id: 'landmark-detail', minimumLod: GEO_OBJECT_LOD.MID, order: 1, boxes: surface }] : [],
    accents: accents.length
      ? [{ id: 'landmark-ornament', minimumLod: GEO_OBJECT_LOD.NEAR, order: 2, boxes: accents }] : [],
    visualBounds: null,
    solidProxies: [],
    interactionProxies: [],
    cameraRoles: [],
  }), {
    lod: GEO_OBJECT_LOD.NEAR,
    maxModules: GEO_LANDMARK_LIMITS.maxModulesPerHero,
    maxBoxes: GEO_LANDMARK_LIMITS.maxBoxesPerHero,
  });

  const hero = {
    id, owner, form: resolved.form, rings, axis, frame,
    foundationY, roofY, height, openings: reserved,
    boxes: rebindMasses(compiled, [
      ...emitted[GEO_OBJECT_LOD.FAR], ...emitted[GEO_OBJECT_LOD.MID], ...emitted[GEO_OBJECT_LOD.NEAR],
    ]),
  };
  const compounds = landmarkCompounds(hero);
  // Attached before the proof helpers run so `landmarkOpeningClear` and
  // `landmarkPathClear` accept a compiled hero directly.
  hero.compounds = compounds;
  const geometry = compileLandmarkGeometry(hero);
  hero.geometry = geometry;
  const structural = compounds.filter(compound => compound.structural);
  const bounds = frame.bounds;
  // Gate proof 1: no compound may seal a reserved void. A load-bearing mass may
  // be as wide as the hero (a tier band is one solid slab above the arch), but
  // nothing may overlap an opening the player walks through.
  const sealed = reserved.filter(opening => !landmarkOpeningClear(hero, opening));
  // Gate proof 2: the only compounds allowed to cover the hero plan are the ones
  // that cannot seal a passage — neither hero-tall nor overlapping any void.
  const enclosing = compounds.filter(compound =>
    compound.minimumX <= bounds.minimumX + 1e-6 && compound.maximumX >= bounds.maximumX - 1e-6 &&
    compound.minimumZ <= bounds.minimumZ + 1e-6 && compound.maximumZ >= bounds.maximumZ - 1e-6 &&
    ((compound.maximumY - compound.minimumY) >= height * GEO_LANDMARK_LIMITS.maxCompoundToHeroExtent ||
      reserved.some(opening => overlaps3d(compound, opening, 1e-6))));
  let maximumCompoundExtent = 0, narrowestCompoundExtent = Infinity;
  for (const compound of compounds) {
    const extent = Math.hypot(compound.maximumX - compound.minimumX,
      compound.maximumY - compound.minimumY, compound.maximumZ - compound.minimumZ);
    maximumCompoundExtent = Math.max(maximumCompoundExtent, extent);
    narrowestCompoundExtent = Math.min(narrowestCompoundExtent, extent);
  }

  return Object.freeze({
    namespace: GDO_LANDMARK_NAMESPACE,
    id,
    owner,
    form: resolved.form,
    formSource: resolved.source,
    axis,
    frame,
    foundationY,
    roofY,
    height,
    bounds: Object.freeze({ ...bounds, minimumY: foundationY, maximumY: roofY }),
    rings,
    recipe: compiled,
    compiled,
    boxes: hero.boxes,
    openings: reserved,
    compounds,
    geometry,
    diagnostics: Object.freeze({
      namespace: GDO_LANDMARK_NAMESPACE,
      form: resolved.form,
      formSource: resolved.source,
      tiers: tiersPlaced,
      columns: columnsPlaced,
      merlons: merlonsPlaced,
      boxes: hero.boxes.length,
      modules: compiled.diagnostics.emittedModules,
      skippedModules: compiled.diagnostics.skippedModules,
      openingRejections: diagnostics.openingRejections,
      loopRejections: diagnostics.loopRejections,
      budgetSkips: diagnostics.budgetSkips,
      tierSpanSkipped: diagnostics.tierSpanSkipped,
      prunedModules: Object.freeze([...diagnostics.prunedModules]),
      openings: reserved.length,
      passableOpenings: reserved.filter(opening => opening.passable && opening.kind !== 'corridor').length,
      corridors: reserved.filter(opening => opening.kind === 'corridor').length,
      compounds: compounds.length,
      structuralCompounds: structural.length,
      walkerBlockingCompounds: structural.filter(compound =>
        compound.minimumY < foundationY + GEO_LANDMARK_LIMITS.headroom).length,
      enclosingCompounds: enclosing.length,
      sealedOpenings: sealed.length,
      sealedOpeningIds: Object.freeze(sealed.map(opening => opening.id)),
      heroExtent: Math.hypot(frame.width, frame.depth, height),
      maximumCompoundExtent,
      narrowestCompoundExtent: Number.isFinite(narrowestCompoundExtent) ? narrowestCompoundExtent : 0,
      triangles: geometry.triangles,
      fullBoxTriangles: hero.boxes.length * 12,
      hiddenFaces: geometry.hiddenFaces,
      containedBoxes: geometry.containedBoxes,
      bytes: geometry.bytes,
      batches: 1,
      drawCalls: 1,
      capEvents: Object.freeze({
        boxes: hero.boxes.length >= GEO_LANDMARK_LIMITS.maxBoxesPerHero,
        openings: reserved.length >= GEO_LANDMARK_LIMITS.maxOpenings,
        compounds: compounds.length > GEO_LANDMARK_LIMITS.maxCompounds,
        structuralCompounds: structural.length > GEO_LANDMARK_LIMITS.maxStructuralCompounds,
        sealedOpenings: sealed.length > 0,
      }),
    }),
  });
}

/**
 * Tight compounds: one AABB per emitted mass. Load-bearing masonry is
 * structural; voussoirs, bands, merlons, ribs, and finials are ornament, so a
 * skyline box can never enlarge collision.
 */
export function landmarkCompounds(hero) {
  const compounds = [];
  for (const box of hero.boxes) {
    const area = boxAabb(box);
    compounds.push(Object.freeze({
      mass: box.mass,
      structural: LOAD_BEARING.includes(box.mass),
      surfaceDetail: box.mass === GEO_LANDMARK_MASS.COLUMN,
      minimumX: area.minimumX, maximumX: area.maximumX,
      minimumY: area.minimumY, maximumY: area.maximumY,
      minimumZ: area.minimumZ, maximumZ: area.maximumZ,
    }));
  }
  compounds.sort((first, second) => first.mass.localeCompare(second.mass) ||
    first.minimumY - second.minimumY || first.minimumX - second.minimumX ||
    first.minimumZ - second.minimumZ);
  return Object.freeze(compounds);
}

/** Exact 3D segment versus AABB slab test, used to prove openings stay clear. */
export function landmarkSegmentHit(from, to, area, radius = 0) {
  if (![from?.x, from?.y, from?.z, to?.x, to?.y, to?.z].every(Number.isFinite)) {
    throw new TypeError('Landmark segment test requires finite endpoints');
  }
  if (![area?.minimumX, area?.minimumY, area?.minimumZ,
    area?.maximumX, area?.maximumY, area?.maximumZ].every(Number.isFinite)) {
    throw new TypeError('Landmark segment test requires a finite AABB');
  }
  const delta = [to.x - from.x, to.y - from.y, to.z - from.z];
  const origin = [from.x, from.y, from.z];
  const minimum = [area.minimumX - radius, area.minimumY - radius, area.minimumZ - radius];
  const maximum = [area.maximumX + radius, area.maximumY + radius, area.maximumZ + radius];
  let enter = 0, exit = 1;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(delta[axis]) < 1e-9) {
      if (origin[axis] < minimum[axis] || origin[axis] > maximum[axis]) return false;
      continue;
    }
    const first = (minimum[axis] - origin[axis]) / delta[axis];
    const second = (maximum[axis] - origin[axis]) / delta[axis];
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (enter > exit) return false;
  }
  return true;
}

/** True when the whole opening volume is free of every structural compound. */
export function landmarkOpeningClear(hero, opening, { includeOrnament = false } = {}) {
  for (const compound of hero.compounds) {
    if (!includeOrnament && !compound.structural) continue;
    if (overlaps3d(compound, opening, 1e-6)) return false;
  }
  return true;
}

/**
 * True when a straight path crosses the hero without meeting a compound. A gate
 * arch is walkable; an enclosing AABB never is.
 */
export function landmarkPathClear(hero, from, to, { radius = 0, includeOrnament = false } = {}) {
  for (const compound of hero.compounds) {
    if (!includeOrnament && !compound.structural) continue;
    if (landmarkSegmentHit(from, to, compound, radius)) return false;
  }
  return true;
}

/**
 * Tile entry point: rank candidates, admit exactly one hero, and honour the
 * whole-module rule — a hero that cannot be completed is rejected, never
 * half-built.
 */
export function compileLandmarks(candidates, {
  limit = GEO_LANDMARK_LIMITS.heroesPerTile,
  boxesPerTile = GEO_LANDMARK_LIMITS.maxBoxesPerHero,
  bytesPerTile = GEO_LANDMARK_LIMITS.bytesPerTile,
} = {}) {
  const selection = selectLandmarkHero(candidates, limit);
  const rejected = { boxes: 0, bytes: 0, malformed: 0 };
  const heroes = [];
  let boxes = 0, bytes = 0;
  for (const entry of selection.selected) {
    let hero = null;
    try {
      hero = createLandmarkHeroRecipe(entry.input);
    } catch {
      rejected.malformed++;
      continue;
    }
    if (boxes + hero.boxes.length > boxesPerTile) { rejected.boxes++; continue; }
    if (bytes + hero.geometry.bytes > bytesPerTile) { rejected.bytes++; continue; }
    boxes += hero.boxes.length;
    bytes += hero.geometry.bytes;
    heroes.push(hero);
  }
  return Object.freeze({
    namespace: GDO_LANDMARK_NAMESPACE,
    heroes: Object.freeze(heroes),
    considered: selection.considered,
    eligible: selection.eligible,
    selected: selection.selected.length,
    boxes,
    bytes,
    rejected: Object.freeze(rejected),
    truncated: selection.truncated,
    capEvents: Object.freeze({
      heroes: selection.truncated,
      boxes: rejected.boxes > 0,
      bytes: rejected.bytes > 0,
      malformed: rejected.malformed > 0,
    }),
  });
}
