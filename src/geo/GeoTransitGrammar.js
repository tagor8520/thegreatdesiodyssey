/**
 * `TER-09` — rail/transit/airport geometry families (`gdo:transitGrammar:v1`).
 *
 * The `MAP-08` adapter already collapses every provider spelling into one
 * transport record (`rail` flag, canonical `roadClass`, `subclass`, the `LAY-02`
 * physical level). This module is the **semantic style layer** the roadmap row
 * names on top of it: one family per transport line, one declared geometry
 * recipe per family, and one declared crossing rule where a ground road meets a
 * ground railway.
 *
 * - **Families** — heavy/light rail, tram, monorail, subway, funicular, runway,
 *   and taxiway each get their own ballast/beam/pavement width, palette, gauge,
 *   sleeper rhythm, and marking pattern. An unknown spelling falls back to
 *   heavy rail only through the adapter's own `rail` flag; nothing fabricates
 *   an airport or a station.
 * - **Crossings** — a level crossing exists only where one ordinary road line
 *   crosses one rail family at the **same** `LAY-02` ground level. The patch is
 *   declared parts (a road slab through the rails, one barrier post and boom
 *   per approach), and every other pairing refuses by name: grade-separated
 *   pairs (`different-level`), airside roads (`airside-separation`), rail-to-rail
 *   (`transit-junction`), and pairs with no transit side at all (`no-transit`).
 * - **Under cap** — every plan is bounded by `GDO_TRANSIT_LIMITS` and counts
 *   what it emitted; a saturated budget truncates deterministically and says so.
 *
 * The grammar plans **parts**, not buffers: an emitter receives `quad`/`box`
 * calls in world coordinates, so the tile builder writes its own typed arrays
 * and node tests record the exact plan without WebGL.
 */

import { featureNamespace } from '../engine/FeatureVersions.js';

export const GDO_TRANSIT_NAMESPACE = featureNamespace('transitGrammar');

export const GDO_TRANSIT_FAMILY = Object.freeze({
  NONE: 'none',
  HEAVY_RAIL: 'heavy-rail',
  LIGHT_RAIL: 'light-rail',
  TRAM: 'tram',
  MONORAIL: 'monorail',
  SUBWAY: 'subway',
  FUNICULAR: 'funicular',
  RUNWAY: 'runway',
  TAXIWAY: 'taxiway',
});

export const GDO_TRANSIT_REFUSAL = Object.freeze({
  NO_TRANSIT: 'no-transit',
  DIFFERENT_LEVEL: 'different-level',
  AIRSIDE_SEPARATION: 'airside-separation',
  TRANSIT_JUNCTION: 'transit-junction',
});

export const GDO_TRANSIT_LIMITS = Object.freeze({
  maxDetailQuads: 2400,
  maxBoxes: 96,
  maxCrossings: 24,
  maxCrossingParts: 48,
});

/** The one style/geometry table. All lengths are metres; the caller scales. */
export const GDO_TRANSIT_RECIPES = Object.freeze({
  [GDO_TRANSIT_FAMILY.HEAVY_RAIL]: Object.freeze({
    family: GDO_TRANSIT_FAMILY.HEAVY_RAIL,
    widthMetres: 4.6,
    surfaceColor: Object.freeze([0.030, 0.028, 0.026]),
    rail: Object.freeze({ gaugeMetres: 1.435, widthMetres: 0.08, color: Object.freeze([0.38, 0.40, 0.42]) }),
    sleeper: Object.freeze({ lengthMetres: 2.6, widthMetres: 0.26, periodMetres: 0.62, color: Object.freeze([0.14, 0.105, 0.08]) }),
  }),
  [GDO_TRANSIT_FAMILY.LIGHT_RAIL]: Object.freeze({
    family: GDO_TRANSIT_FAMILY.LIGHT_RAIL,
    widthMetres: 4.0,
    surfaceColor: Object.freeze([0.038, 0.034, 0.030]),
    rail: Object.freeze({ gaugeMetres: 1.435, widthMetres: 0.08, color: Object.freeze([0.38, 0.40, 0.42]) }),
    sleeper: Object.freeze({ lengthMetres: 2.4, widthMetres: 0.24, periodMetres: 0.62, color: Object.freeze([0.14, 0.105, 0.08]) }),
  }),
  [GDO_TRANSIT_FAMILY.TRAM]: Object.freeze({
    family: GDO_TRANSIT_FAMILY.TRAM,
    widthMetres: 3.4,
    surfaceColor: Object.freeze([0.075, 0.085, 0.088]),
    rail: Object.freeze({ gaugeMetres: 1.435, widthMetres: 0.08, color: Object.freeze([0.38, 0.40, 0.42]) }),
    sleeper: null,  // street-running tram: inlaid rails, no sleeper rhythm
  }),
  [GDO_TRANSIT_FAMILY.MONORAIL]: Object.freeze({
    family: GDO_TRANSIT_FAMILY.MONORAIL,
    widthMetres: 1.4,
    surfaceColor: Object.freeze([0.14, 0.15, 0.155]),
    beam: Object.freeze({ stripMetres: 0.22, color: Object.freeze([0.40, 0.42, 0.44]) }),
    strut: Object.freeze({ periodMetres: 6, sizeMetres: 0.5, heightMetres: 0.35, color: Object.freeze([0.12, 0.125, 0.13]) }),
  }),
  [GDO_TRANSIT_FAMILY.SUBWAY]: Object.freeze({
    family: GDO_TRANSIT_FAMILY.SUBWAY,
    widthMetres: 4.2,
    surfaceColor: Object.freeze([0.11, 0.115, 0.12]),
    rail: Object.freeze({ gaugeMetres: 1.435, widthMetres: 0.08, color: Object.freeze([0.38, 0.40, 0.42]) }),
    sleeper: Object.freeze({ lengthMetres: 2.4, widthMetres: 0.24, periodMetres: 0.62, color: Object.freeze([0.08, 0.085, 0.09]) }),
  }),
  [GDO_TRANSIT_FAMILY.FUNICULAR]: Object.freeze({
    family: GDO_TRANSIT_FAMILY.FUNICULAR,
    widthMetres: 3.0,
    surfaceColor: Object.freeze([0.034, 0.030, 0.026]),
    rail: Object.freeze({ gaugeMetres: 1.0, widthMetres: 0.08, color: Object.freeze([0.38, 0.40, 0.42]) }),
    sleeper: Object.freeze({ lengthMetres: 2.0, widthMetres: 0.22, periodMetres: 0.55, color: Object.freeze([0.14, 0.105, 0.08]) }),
  }),
  [GDO_TRANSIT_FAMILY.RUNWAY]: Object.freeze({
    family: GDO_TRANSIT_FAMILY.RUNWAY,
    widthMetres: 24,
    surfaceColor: Object.freeze([0.055, 0.060, 0.068]),
    centerline: Object.freeze({ widthMetres: 0.9, dashMetres: 20, gapMetres: 12, color: Object.freeze([0.88, 0.88, 0.84]) }),
    edge: Object.freeze({ widthMetres: 0.8, insetMetres: 0.7, color: Object.freeze([0.82, 0.82, 0.78]) }),
    threshold: Object.freeze({ bars: 6, barWidthMetres: 1.2, barLengthMetres: 5, spacingMetres: 1.8, color: Object.freeze([0.88, 0.88, 0.84]) }),
  }),
  [GDO_TRANSIT_FAMILY.TAXIWAY]: Object.freeze({
    family: GDO_TRANSIT_FAMILY.TAXIWAY,
    widthMetres: 12,
    surfaceColor: Object.freeze([0.060, 0.068, 0.070]),
    centerline: Object.freeze({ widthMetres: 0.5, dashMetres: 0, gapMetres: 0, color: Object.freeze([0.82, 0.72, 0.18]) }),
    edge: Object.freeze({ widthMetres: 0.35, insetMetres: 0.5, color: Object.freeze([0.62, 0.55, 0.16]) }),
    threshold: null,
  }),
});

const RAIL_FAMILY_BY_SUBCLASS = Object.freeze({
  rail: GDO_TRANSIT_FAMILY.HEAVY_RAIL,
  narrow_gauge: GDO_TRANSIT_FAMILY.HEAVY_RAIL,
  preserved: GDO_TRANSIT_FAMILY.HEAVY_RAIL,
  light_rail: GDO_TRANSIT_FAMILY.LIGHT_RAIL,
  tram: GDO_TRANSIT_FAMILY.TRAM,
  subway: GDO_TRANSIT_FAMILY.SUBWAY,
  monorail: GDO_TRANSIT_FAMILY.MONORAIL,
  funicular: GDO_TRANSIT_FAMILY.FUNICULAR,
});

/**
 * The family of one canonical `MAP-08` transport record. The adapter's `rail`
 * flag is the source of truth for rail; the subclass only chooses the family.
 * Anything that is neither rail nor airside is `NONE` and keeps its road class.
 */
export function transitFamily(transport) {
  if (!transport || typeof transport !== 'object') return GDO_TRANSIT_FAMILY.NONE;
  if (transport.rail || transport.roadClass === GDO_TRANSIT_FAMILY.HEAVY_RAIL || transport.roadClass === 'rail') {
    const subclass = typeof transport.subclass === 'string' ? transport.subclass.toLowerCase() : '';
    const subtype = typeof transport.subtype === 'string' ? transport.subtype.toLowerCase() : '';
    return RAIL_FAMILY_BY_SUBCLASS[subclass] ?? RAIL_FAMILY_BY_SUBCLASS[subtype] ?? GDO_TRANSIT_FAMILY.HEAVY_RAIL;
  }
  if (transport.roadClass === 'runway') return GDO_TRANSIT_FAMILY.RUNWAY;
  if (transport.roadClass === 'taxiway') return GDO_TRANSIT_FAMILY.TAXIWAY;
  return GDO_TRANSIT_FAMILY.NONE;
}

const RAIL_FAMILIES = new Set([
  GDO_TRANSIT_FAMILY.HEAVY_RAIL,
  GDO_TRANSIT_FAMILY.LIGHT_RAIL,
  GDO_TRANSIT_FAMILY.TRAM,
  GDO_TRANSIT_FAMILY.MONORAIL,
  GDO_TRANSIT_FAMILY.SUBWAY,
  GDO_TRANSIT_FAMILY.FUNICULAR,
]);

const AIRSIDE_FAMILIES = new Set([GDO_TRANSIT_FAMILY.RUNWAY, GDO_TRANSIT_FAMILY.TAXIWAY]);

export function isRailFamily(family) {
  return RAIL_FAMILIES.has(family);
}

export function isAirsideFamily(family) {
  return AIRSIDE_FAMILIES.has(family);
}

/**
 * The one crossing rule. A level crossing is exactly one ordinary road family
 * against one rail family at the same **ground** `LAY-02` level; every other
 * pairing refuses by name instead of guessing.
 */
export function classifyTransitCrossing(first, second) {
  const a = first && typeof first === 'object' ? first : {};
  const b = second && typeof second === 'object' ? second : {};
  const familyA = a.family ?? GDO_TRANSIT_FAMILY.NONE;
  const familyB = b.family ?? GDO_TRANSIT_FAMILY.NONE;
  const transitA = isRailFamily(familyA) || isAirsideFamily(familyA);
  const transitB = isRailFamily(familyB) || isAirsideFamily(familyB);
  if (!transitA && !transitB) return { crossing: false, refusal: GDO_TRANSIT_REFUSAL.NO_TRANSIT };
  if (transitA && transitB) {
    if (isAirsideFamily(familyA) || isAirsideFamily(familyB)) {
      return { crossing: false, refusal: GDO_TRANSIT_REFUSAL.AIRSIDE_SEPARATION };
    }
    return { crossing: false, refusal: GDO_TRANSIT_REFUSAL.TRANSIT_JUNCTION };
  }
  const transit = transitA ? a : b;
  const road = transitA ? b : a;
  const transitFamilyName = transitA ? familyA : familyB;
  if (isAirsideFamily(transitFamilyName)) {
    // A road never crosses a runway or taxiway at grade — airside is gated.
    return { crossing: false, refusal: GDO_TRANSIT_REFUSAL.AIRSIDE_SEPARATION };
  }
  if (isAirsideFamily(road.family)) {
    return { crossing: false, refusal: GDO_TRANSIT_REFUSAL.AIRSIDE_SEPARATION };
  }
  const roadLevel = Number.isFinite(road.physicalLevel) ? road.physicalLevel : 0;
  const transitLevel = Number.isFinite(transit.physicalLevel) ? transit.physicalLevel : 0;
  if (roadLevel !== transitLevel || transitLevel !== 0) {
    return { crossing: false, refusal: GDO_TRANSIT_REFUSAL.DIFFERENT_LEVEL };
  }
  return {
    crossing: true,
    kind: 'level-crossing',
    railFamily: transitFamilyName,
    roadFamily: road.family ?? GDO_TRANSIT_FAMILY.NONE,
  };
}

function budgetFor(budget) {
  const counts = budget && typeof budget === 'object'
    ? budget
    : { quads: 0, boxes: 0, crossings: 0, crossingParts: 0 };
  counts.quads ??= 0;
  counts.boxes ??= 0;
  counts.crossings ??= 0;
  counts.crossingParts ??= 0;
  return counts;
}

/**
 * Plan the declared detail for one transport segment: rail heads and the
 * sleeper rhythm for rail families, edge lines and centre markings (and the
 * line-end threshold bars) for airside families. `emitter.quad` receives
 * `(x1, z1, x2, z2, halfWidth, y1, y2, color, offset)` and `emitter.box`
 * receives `(x, y, z, sizeX, sizeY, sizeZ, color)`; heights arrive through the
 * caller-supplied `heightAt` so the grammar never owns a terrain.
 */
export function planSegmentTransitDetail({
  family,
  x1, z1, x2, z2,
  heightAt,
  emitter,
  budget,
  firstOfLine = false,
  lastOfLine = false,
}) {
  const recipe = GDO_TRANSIT_RECIPES[family];
  const counts = budgetFor(budget);
  const result = { family, quads: 0, boxes: 0, truncated: false };
  if (!recipe || !emitter || typeof emitter.quad !== 'function') return result;
  const dx = x2 - x1, dz = z2 - z1;
  const length = Math.hypot(dx, dz);
  if (length < 1e-5) return result;
  const ux = dx / length, uz = dz / length;
  const nx = -uz, nz = ux;
  const height = typeof heightAt === 'function' ? heightAt : () => 0;
  const y1 = height(x1, z1);
  const y2 = height(x2, z2);
  const yAt = t => y1 + (y2 - y1) * t;
  const pointAt = (t, across) => [
    x1 + ux * length * t + nx * across,
    z1 + uz * length * t + nz * across,
  ];
  const canQuad = () => counts.quads < GDO_TRANSIT_LIMITS.maxDetailQuads;
  const canBox = () => counts.boxes < GDO_TRANSIT_LIMITS.maxBoxes;
  const pushQuad = (t0, t1, across, halfWidth, color, yLift = 0.002) => {
    if (!canQuad()) {
      result.truncated = true;
      return;
    }
    const [ax, az] = pointAt(t0, across);
    const [bx, bz] = pointAt(t1, across);
    emitter.quad(ax, az, bx, bz, halfWidth, yAt(t0) + yLift, yAt(t1) + yLift, color);
    counts.quads += 1;
    result.quads += 1;
  };

  if (recipe.rail) {
    const { gaugeMetres, widthMetres, color } = recipe.rail;
    const halfGauge = gaugeMetres * 0.05;   // metres → world (0.1) then half
    const halfRail = widthMetres * 0.05;
    pushQuad(0, 1, halfGauge, halfRail, color);
    pushQuad(0, 1, -halfGauge, halfRail, color);
    if (recipe.sleeper) {
      const { lengthMetres, widthMetres: sleeperWidth, periodMetres, color: sleeperColor } = recipe.sleeper;
      const halfSleeper = sleeperWidth * 0.05;
      const halfLength = lengthMetres * 0.05;
      const period = periodMetres * 0.1;
      for (let distance = period * 0.5; distance < length; distance += period) {
        if (!canQuad()) {
          result.truncated = true;
          break;
        }
        const t = distance / length;
        // Sleeper: a quad across the track, centred at this distance.
        const [cx, cz] = pointAt(t, 0);
        emitter.quad(
          cx + ux * halfSleeper, cz + uz * halfSleeper,
          cx - ux * halfSleeper, cz - uz * halfSleeper,
          halfLength, yAt(t) + 0.001, yAt(t) + 0.001, sleeperColor,
        );
        counts.quads += 1;
        result.quads += 1;
      }
    }
  }

  if (recipe.beam) {
    const { stripMetres, color } = recipe.beam;
    const halfStrip = stripMetres * 0.05;
    const halfBeam = recipe.widthMetres * 0.05;
    pushQuad(0, 1, halfBeam - halfStrip, halfStrip, color);
    pushQuad(0, 1, -(halfBeam - halfStrip), halfStrip, color);
  }
  if (recipe.strut) {
    const { periodMetres, sizeMetres, heightMetres, color } = recipe.strut;
    const period = periodMetres * 0.1;
    for (let distance = period * 0.5; distance < length; distance += period) {
      if (!canBox()) {
        result.truncated = true;
        break;
      }
      const t = distance / length;
      const [cx, cz] = pointAt(t, 0);
      emitter.box(cx, yAt(t) - heightMetres * 0.1, cz, sizeMetres * 0.1, heightMetres * 0.1, sizeMetres * 0.1, color);
      counts.boxes += 1;
      result.boxes += 1;
    }
  }

  if (recipe.edge) {
    const { widthMetres, insetMetres, color } = recipe.edge;
    const halfEdge = widthMetres * 0.05;
    const halfRoad = recipe.widthMetres * 0.05;
    const across = halfRoad - insetMetres * 0.1 - halfEdge;
    pushQuad(0, 1, across, halfEdge, color);
    pushQuad(0, 1, -across, halfEdge, color);
  }
  if (recipe.centerline) {
    const { widthMetres, dashMetres, gapMetres, color } = recipe.centerline;
    const halfLine = widthMetres * 0.05;
    if (dashMetres > 0) {
      const dash = dashMetres * 0.1;
      const gap = gapMetres * 0.1;
      for (let distance = 0; distance < length; distance += dash + gap) {
        const end = Math.min(distance + dash, length);
        pushQuad(distance / length, end / length, 0, halfLine, color);
      }
    } else {
      pushQuad(0, 1, 0, halfLine, color);
    }
  }
  if (recipe.threshold && (firstOfLine || lastOfLine)) {
    const { bars, barWidthMetres, barLengthMetres, spacingMetres, color } = recipe.threshold;
    const halfBar = barWidthMetres * 0.05;
    const barLength = barLengthMetres * 0.1;
    const spacing = spacingMetres * 0.1;
    const total = (bars - 1) * spacing;
    // "Piano keys" just inside the line end: bars run along the runway and
    // spread across it at the declared spacing.
    const startT = firstOfLine
      ? Math.max(0, (barLength * 0.25) / length)
      : Math.max(0, 1 - (barLength * 1.25) / length);
    for (let bar = 0; bar < bars; bar += 1) {
      const across = -total / 2 + bar * spacing;
      pushQuad(startT, Math.min(1, startT + barLength / length), across, halfBar, color);
      if (result.truncated) break;
    }
  }

  return result;
}

/**
 * Plan one level-crossing patch at a ground road×rail intersection: a road slab
 * through the rails so the road reads continuous, plus one barrier post and one
 * boom per road approach. `roadDirection`/`railDirection` are unit world
 * vectors; parts land on the caller's emitter like any other detail.
 */
export function planLevelCrossing({
  x, z,
  heightAt,
  roadDirectionX, roadDirectionZ,
  railDirectionX, railDirectionZ,
  roadColor,
  emitter,
  budget,
}) {
  const counts = budgetFor(budget);
  const result = { parts: 0, truncated: false };
  if (!emitter || typeof emitter.quad !== 'function' || typeof emitter.box !== 'function') return result;
  if (counts.crossings >= GDO_TRANSIT_LIMITS.maxCrossings) {
    result.truncated = true;
    return result;
  }
  const height = typeof heightAt === 'function' ? heightAt : () => 0;
  const y = height(x, z);
  const rx = roadDirectionX, rz = roadDirectionZ;
  const ax = railDirectionX, az = railDirectionZ;

  const slabHalfLength = 0.27;   // covers a 4.6 m ballast bed + margin
  const slabHalfWidth = 0.24;    // the road corridor through the rails
  const partsAllowed = () => counts.crossingParts < GDO_TRANSIT_LIMITS.maxCrossingParts;

  if (partsAllowed()) {
    emitter.quad(
      x + ax * slabHalfLength, z + az * slabHalfLength,
      x - ax * slabHalfLength, z - az * slabHalfLength,
      slabHalfWidth, y + 0.003, y + 0.003, roadColor ?? [0.075, 0.085, 0.088],
    );
    counts.crossingParts += 1;
    counts.quads += 1;
    result.parts += 1;
  }

  // One post + boom per road approach, set at the rail's outer edge.
  for (const side of [1, -1]) {
    if (!partsAllowed()) {
      result.truncated = true;
      break;
    }
    const postX = x + rx * side * 0.32 + ax * side * 0.30;
    const postZ = z + rz * side * 0.32 + az * side * 0.30;
    emitter.box(postX, y, postZ, 0.05, 0.16, 0.05, [0.62, 0.62, 0.64]);
    counts.crossingParts += 1;
    counts.boxes += 1;
    result.parts += 1;

    if (!partsAllowed()) {
      result.truncated = true;
      break;
    }
    // The boom leans across the road approach at a fixed 45°, by data.
    const boomX = postX - ax * side * 0.16;
    const boomZ = postZ - az * side * 0.16;
    emitter.box(boomX, y + 0.11, boomZ, 0.30, 0.025, 0.035, [0.72, 0.16, 0.12]);
    counts.crossingParts += 1;
    counts.boxes += 1;
    result.parts += 1;
  }

  counts.crossings += 1;
  return result;
}
