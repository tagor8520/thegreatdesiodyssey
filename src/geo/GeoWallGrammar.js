/**
 * `TER-10` — walls, barriers and entrances (`gdo:wallGrammar:v1`).
 *
 * The research row: *"Walls, fences, gates — polygon-edge ribbons with entrance
 * gaps; site/landuse-specific recipes. Defines space and collision."* This
 * module is the one plan that makes the roadmap gate honest — **exact compounds
 * preserve gates/openings**:
 *
 * - **Site recipes** — a mapped site kind (school, cemetery, park, pitch, …)
 *   resolves to one wall family (wall, fence, hedge, railing) with declared
 *   height, thickness, post rhythm, and palette. An unknown kind gets **no**
 *   wall: nothing is fabricated.
 * - **Entrance gaps** — an entrance is a projected point on the ring: the plan
 *   carves exactly one declared-width opening at the projection, refuses an
 *   `off-ring` point or an `overlapping-entrance` by name, and reports
 *   `no-entrance` when a site ring receives none (the caller may source them
 *   from mapped gates or geometry — the grammar never invents one).
 * - **One plan, two consumers** — every wall run between consecutive openings
 *   is one record. The visual ribbons/posts are emitted from the runs, and the
 *   collision compound is built from the **same** runs split into capped
 *   segments — so an opening is empty in the drawing and empty in the collision,
 *   provably: `compoundPreservesOpenings` checks the compound against every
 *   opening's clearance disc.
 */

import { featureNamespace } from '../engine/FeatureVersions.js';

export const GDO_WALL_NAMESPACE = featureNamespace('wallGrammar');

export const GDO_WALL_FAMILY = Object.freeze({
  NONE: 'none',
  WALL: 'wall',
  FENCE: 'fence',
  HEDGE: 'hedge',
  RAILING: 'railing',
});

export const GDO_WALL_REFUSAL = Object.freeze({
  NO_SITE_RECIPE: 'no-site-recipe',
  RING_TOO_SHORT: 'ring-too-short',
  OFF_RING: 'off-ring',
  OVERLAPPING_ENTRANCE: 'overlapping-entrance',
  NO_ENTRANCE: 'no-entrance',
  BAD_RING: 'bad-ring',
});

export const GDO_WALL_LIMITS = Object.freeze({
  maxSites: 24,
  maxRingPoints: 512,
  maxEntrances: 24,
  maxSegments: 1024,
  maxPosts: 1024,
  maxSolids: 512,
  maxCompoundSegmentLength: 0.4,   // 4 m wall runs at 1:10
  entranceProjectionMetres: 12,    // a gate this far off the ring refuses
});

/** One declared recipe per family. All lengths are metres. */
export const GDO_WALL_RECIPES = Object.freeze({
  [GDO_WALL_FAMILY.WALL]: Object.freeze({
    family: GDO_WALL_FAMILY.WALL,
    heightMetres: 2.2,
    thicknessMetres: 0.36,
    postPeriodMetres: 0,
    postSizeMetres: 0,
    colors: Object.freeze({ body: Object.freeze([0.42, 0.40, 0.37]), post: Object.freeze([0.38, 0.36, 0.33]) }),
  }),
  [GDO_WALL_FAMILY.FENCE]: Object.freeze({
    family: GDO_WALL_FAMILY.FENCE,
    heightMetres: 1.2,
    thicknessMetres: 0.08,
    postPeriodMetres: 2.4,
    postSizeMetres: 0.12,
    colors: Object.freeze({ body: Object.freeze([0.30, 0.24, 0.18]), post: Object.freeze([0.24, 0.19, 0.14]) }),
  }),
  [GDO_WALL_FAMILY.HEDGE]: Object.freeze({
    family: GDO_WALL_FAMILY.HEDGE,
    heightMetres: 1.4,
    thicknessMetres: 0.7,
    postPeriodMetres: 0,
    postSizeMetres: 0,
    colors: Object.freeze({ body: Object.freeze([0.12, 0.24, 0.10]), post: Object.freeze([0.10, 0.20, 0.09]) }),
  }),
  [GDO_WALL_FAMILY.RAILING]: Object.freeze({
    family: GDO_WALL_FAMILY.RAILING,
    heightMetres: 1.1,
    thicknessMetres: 0.06,
    postPeriodMetres: 1.8,
    postSizeMetres: 0.08,
    colors: Object.freeze({ body: Object.freeze([0.36, 0.38, 0.40]), post: Object.freeze([0.30, 0.32, 0.34]) }),
  }),
});

/**
 * Site recipes: mapped land kind → wall family and entrance width. First match
 * wins; anything unmatched yields `NONE` and no wall.
 */
export const GDO_SITE_WALL_RECIPES = Object.freeze([
  Object.freeze({ match: Object.freeze(['prison', 'military', 'barracks', 'quarry']), family: GDO_WALL_FAMILY.WALL, entranceWidthMetres: 5 }),
  Object.freeze({ match: Object.freeze(['cemetery', 'graveyard']), family: GDO_WALL_FAMILY.WALL, entranceWidthMetres: 3.2 }),
  Object.freeze({ match: Object.freeze(['school', 'college', 'university', 'hospital', 'clinic', 'university_grounds']), family: GDO_WALL_FAMILY.WALL, entranceWidthMetres: 4 }),
  Object.freeze({ match: Object.freeze(['church', 'monastery', 'temple', 'chapel']), family: GDO_WALL_FAMILY.WALL, entranceWidthMetres: 3 }),
  Object.freeze({ match: Object.freeze(['stadium', 'sports', 'pitch', 'playground', 'tennis', 'basketball', 'recreation']), family: GDO_WALL_FAMILY.FENCE, entranceWidthMetres: 2.4 }),
  Object.freeze({ match: Object.freeze(['park', 'garden', 'nature', 'forest', 'wood', 'grass', 'village_green']), family: GDO_WALL_FAMILY.HEDGE, entranceWidthMetres: 2.8 }),
  Object.freeze({ match: Object.freeze(['residential', 'farm', 'allotment', 'orchard', 'vineyard', 'cemetery_perimeter']), family: GDO_WALL_FAMILY.FENCE, entranceWidthMetres: 2.6 }),
]);

/**
 * The site recipe for one mapped land kind. Unknown kinds get `NONE` — a
 * missing recipe is silence, never a fabricated wall.
 */
export function wallSiteRecipe(kind) {
  const text = typeof kind === 'string' ? kind.toLowerCase() : '';
  if (!text) return { family: GDO_WALL_FAMILY.NONE, entranceWidthMetres: 0 };
  for (const recipe of GDO_SITE_WALL_RECIPES) {
    if (recipe.match.some(entry => text.includes(entry))) {
      return { family: recipe.family, entranceWidthMetres: recipe.entranceWidthMetres };
    }
  }
  return { family: GDO_WALL_FAMILY.NONE, entranceWidthMetres: 0 };
}

/**
 * Geometry-derived entrance candidates: the ground-road segments nearest the
 * ring (the `DET-04` pattern — the wall's gate faces real mapped access, and
 * nothing is fabricated when no road is in reach). Returns up to
 * `maxEntrances` original road points, deterministically ordered by distance
 * then coordinates, separated along the ring so two gates never overlap.
 */
export function deriveEntrancesFromRoads({ ring, roadSegments = [], maxEntrances = 2 } = {}) {
  const points = normaliseRing(ring);
  if (!points || !Array.isArray(roadSegments)) return [];
  const candidates = [];
  for (let index = 0; index < roadSegments.length; index += 1) {
    const segment = roadSegments[index];
    if (!Array.isArray(segment) || segment.length < 4) continue;
    for (const [x, z] of [[segment[0], segment[1]], [segment[2], segment[3]],
      [(segment[0] + segment[2]) / 2, (segment[1] + segment[3]) / 2]]) {
      const projection = projectEntranceToRing(points, { x, z });
      if (!projection.ok) continue;
      candidates.push({ x, z, distance: projection.distance, arc: projection.edgeIndex + projection.t, index });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.x - b.x || a.z - b.z || a.index - b.index);
  const accepted = [];
  for (const candidate of candidates) {
    if (accepted.length >= maxEntrances) break;
    const separated = accepted.every(other => Math.abs(other.arc - candidate.arc) > 0.08);
    if (separated) accepted.push(candidate);
  }
  return accepted.map(candidate => ({ x: candidate.x, z: candidate.z }));
}

/**
 * Project an entrance point onto a ring. Returns the exact edge projection
 * (`edgeIndex`, `t` along the edge, the projected `x`/`z`, the off-ring
 * distance) or a named refusal. The projection never moves past
 * `entranceProjectionMetres` — a gate far from its wall is not a gate.
 */
export function projectEntranceToRing(ring, point) {
  if (!Array.isArray(ring) || ring.length < 2 || !point) {
    return { refusal: GDO_WALL_REFUSAL.BAD_RING };
  }
  const px = Number.isFinite(point.x) ? point.x : null;
  const pz = Number.isFinite(point.z) ? point.z : null;
  if (px === null || pz === null) return { refusal: GDO_WALL_REFUSAL.OFF_RING };
  let best = null;
  for (let edgeIndex = 0; edgeIndex < ring.length - 1; edgeIndex += 1) {
    const [x1, z1] = ring[edgeIndex];
    const [x2, z2] = ring[edgeIndex + 1];
    const dx = x2 - x1, dz = z2 - z1;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared < 1e-12) continue;
    let t = ((px - x1) * dx + (pz - z1) * dz) / lengthSquared;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const x = x1 + dx * t, z = z1 + dz * t;
    const distance = Math.hypot(px - x, pz - z);
    if (!best || distance < best.distance) best = { edgeIndex, t, x, z, distance };
  }
  if (!best) return { refusal: GDO_WALL_REFUSAL.BAD_RING };
  if (best.distance > GDO_WALL_LIMITS.entranceProjectionMetres * 0.1) {
    return { refusal: GDO_WALL_REFUSAL.OFF_RING, distance: best.distance };
  }
  return { ok: true, ...best };
}

function ringArcParameters(ring) {
  // Arc-length parameters per vertex, normalized to [0, 1].
  const lengths = [0];
  let total = 0;
  for (let index = 1; index < ring.length; index += 1) {
    total += Math.hypot(ring[index][0] - ring[index - 1][0], ring[index][1] - ring[index - 1][1]);
    lengths.push(total);
  }
  return { lengths, total: total || 1 };
}

function normaliseRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const points = [];
  for (const point of ring) {
    const x = Array.isArray(point) ? point[0] : point?.x;
    const z = Array.isArray(point) ? point[1] : point?.z;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    points.push([x, z]);
  }
  const first = points[0], last = points[points.length - 1];
  if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) points.pop();
  return points.length >= 3 ? points : null;
}

/**
 * The one plan for one site ring. `entrancePoints` may be mapped gates or
 * geometry-derived candidates; each projects (or refuses) in order, and the
 * carved openings split the ring into `runs`. Every consumer (geometry,
 * compound) reads the same `runs`.
 */
export function planWallSite({ ring, kind, entrancePoints = [], budget = null } = {}) {
  const counts = budget && typeof budget === 'object' ? budget : {
    segments: 0, posts: 0, solids: 0, entrances: 0,
  };
  counts.segments ??= 0;
  counts.posts ??= 0;
  counts.solids ??= 0;
  counts.entrances ??= 0;

  const recipe = wallSiteRecipe(kind);
  const plan = {
    kind: typeof kind === 'string' ? kind : '',
    family: recipe.family,
    recipe: GDO_WALL_RECIPES[recipe.family] ?? null,
    runs: [],
    openings: [],
    refusals: Object.create(null),
    truncated: false,
  };
  const refuse = name => {
    plan.refusals[name] = (plan.refusals[name] || 0) + 1;
  };

  if (!plan.recipe) {
    refuse(GDO_WALL_REFUSAL.NO_SITE_RECIPE);
    return plan;
  }
  const points = normaliseRing(ring);
  if (!points) {
    refuse(GDO_WALL_REFUSAL.BAD_RING);
    return plan;
  }
  // Close the ring for the walk.
  const closed = [...points, points[0]];
  const { lengths, total } = ringArcParameters(closed);

  const openings = [];
  for (const entrancePoint of entrancePoints) {
    if (openings.length >= GDO_WALL_LIMITS.maxEntrances || counts.entrances >= GDO_WALL_LIMITS.maxEntrances * GDO_WALL_LIMITS.maxSites) {
      plan.truncated = true;
      break;
    }
    const projection = projectEntranceToRing(points, entrancePoint);
    if (!projection.ok) {
      refuse(projection.refusal ?? GDO_WALL_REFUSAL.OFF_RING);
      continue;
    }
    const width = (recipe.entranceWidthMetres * 0.1) / total;   // world width → arc fraction
    const edgeStart = lengths[projection.edgeIndex] / total;
    const edgeEnd = lengths[projection.edgeIndex + 1] / total;
    const centre = edgeStart + (edgeEnd - edgeStart) * projection.t;
    let start = centre - width / 2;
    let end = centre + width / 2;
    if (start < 0) {
      end -= start;
      start = 0;
    }
    if (end > 1) {
      start -= end - 1;
      end = 1;
    }
    const overlap = openings.some(existing => start < existing.end && end > existing.start);
    if (overlap) {
      refuse(GDO_WALL_REFUSAL.OVERLAPPING_ENTRANCE);
      continue;
    }
    openings.push({
      start, end, centre,
      x: projection.x, z: projection.z,
      widthMetres: recipe.entranceWidthMetres,
    });
    counts.entrances += 1;
  }
  openings.sort((a, b) => a.start - b.start);
  plan.openings = openings.map(opening => Object.freeze({ ...opening }));
  if (openings.length === 0) refuse(GDO_WALL_REFUSAL.NO_ENTRANCE);

  // Runs: the ring intervals between consecutive openings. The ring wraps at
  // the seam, so the stretch after the last opening and the stretch before the
  // first are both runs (they simply meet at t=0/1).
  const intervals = [];
  if (openings.length === 0) {
    intervals.push([0, 1]);
  } else {
    for (let index = 0; index < openings.length - 1; index += 1) {
      if (openings[index + 1].start > openings[index].end) {
        intervals.push([openings[index].end, openings[index + 1].start]);
      }
    }
    const last = openings[openings.length - 1];
    const first = openings[0];
    if (last.end < 1) intervals.push([last.end, 1]);
    if (first.start > 0) intervals.push([0, first.start]);
  }

  for (const [start, end] of intervals) {
    if (end - start <= 1e-6) continue;
    if (counts.segments >= GDO_WALL_LIMITS.maxSegments) {
      plan.truncated = true;
      break;
    }
    const run = {
      start, end,
      points: sampleRingInterval(closed, lengths, total, start, end),
    };
    plan.runs.push(run);
    counts.segments += 1;
  }
  return plan;
}

function sampleRingInterval(closed, lengths, total, start, end) {
  const startPoint = pointAt(closed, lengths, total, start);
  const endPoint = pointAt(closed, lengths, total, end);
  const samples = [startPoint];
  const startLength = start * total;
  const endLength = end * total;
  for (let index = 0; index < closed.length - 1; index += 1) {
    const edgeStart = lengths[index];
    const edgeEnd = lengths[index + 1];
    if (edgeStart > startLength + 1e-9 && edgeStart < endLength - 1e-9) {
      samples.push([closed[index][0], closed[index][1]]);
    }
  }
  samples.push(endPoint);
  return samples;
}

function pointAt(closed, lengths, total, t) {
  const target = t * total;
  for (let index = 0; index < closed.length - 1; index += 1) {
    if (target <= lengths[index + 1] + 1e-9) {
      const span = lengths[index + 1] - lengths[index] || 1;
      const local = (target - lengths[index]) / span;
      return [
        closed[index][0] + (closed[index + 1][0] - closed[index][0]) * local,
        closed[index][1] + (closed[index + 1][1] - closed[index][1]) * local,
      ];
    }
  }
  return [closed[closed.length - 1][0], closed[closed.length - 1][1]];
}

/**
 * Emit the plan's visual parts: one yaw-aligned box per wall-run segment (the
 * wall/hedge body) or the fence/railing post rhythm plus its two thin rails —
 * always from the same runs the compound reads. `emitter.box(x, bottom, z,
 * sizeX, sizeY, sizeZ, color, yaw)` receives world coordinates; `heightAt`
 * supplies the ground.
 */
export function emitWallGeometry(plan, { emitter, heightAt, budget = null } = {}) {
  const counts = budget && typeof budget === 'object' ? budget : { segments: 0, posts: 0, solids: 0, entrances: 0 };
  const result = { quads: 0, boxes: 0, truncated: false };
  if (!plan?.recipe || !emitter || typeof emitter.box !== 'function') return result;
  const recipe = plan.recipe;
  const heightWorld = recipe.heightMetres * 0.1;
  const thicknessWorld = recipe.thicknessMetres * 0.1;
  const height = typeof heightAt === 'function' ? heightAt : () => 0;
  const isPosted = recipe.postPeriodMetres > 0;

  for (const run of plan.runs) {
    const points = run.points;
    for (let index = 1; index < points.length; index += 1) {
      const [x1, z1] = points[index - 1];
      const [x2, z2] = points[index];
      const length = Math.hypot(x2 - x1, z2 - z1);
      if (length < 1e-6) continue;
      const yaw = Math.atan2(z2 - z1, x2 - x1);
      const cx = (x1 + x2) / 2, cz = (z1 + z2) / 2;
      const y = height(cx, cz);

      if (!isPosted) {
        // Wall/hedge: one solid yaw-aligned body box per run segment.
        if (counts.segments >= GDO_WALL_LIMITS.maxSegments) {
          result.truncated = true;
          break;
        }
        emitter.box(cx, y, cz, length, heightWorld, thicknessWorld, recipe.colors.body, yaw);
        counts.segments += 1;
        result.boxes += 1;
      } else {
        // Fence/railing: two thin rails along the run plus the post rhythm.
        if (counts.segments + 2 > GDO_WALL_LIMITS.maxSegments) {
          result.truncated = true;
          break;
        }
        emitter.box(cx, y + heightWorld * 0.82, cz, length, heightWorld * 0.08, thicknessWorld, recipe.colors.body, yaw);
        emitter.box(cx, y + heightWorld * 0.45, cz, length, heightWorld * 0.06, thicknessWorld, recipe.colors.body, yaw);
        counts.segments += 2;
        result.boxes += 2;

        const period = recipe.postPeriodMetres * 0.1;
        for (let distance = 0; distance <= length + 1e-9; distance += period) {
          if (counts.posts >= GDO_WALL_LIMITS.maxPosts) {
            result.truncated = true;
            break;
          }
          const t = Math.min(1, distance / length);
          const x = x1 + (x2 - x1) * t;
          const z = z1 + (z2 - z1) * t;
          emitter.box(x, height(x, z), z, recipe.postSizeMetres * 0.1, heightWorld, recipe.postSizeMetres * 0.1, recipe.colors.post);
          counts.posts += 1;
          result.boxes += 1;
        }
      }
      if (result.truncated) break;
    }
    if (result.truncated) break;
  }
  return result;
}

/**
 * The collision compound: one capped thin box per wall-run segment, built from
 * the **same** runs the geometry draws, with the family's real vertical span.
 * Openings contribute nothing — that is the roadmap gate.
 */
export function wallCollisionCompound(plan, { budget = null, heightAt = null } = {}) {
  const counts = budget && typeof budget === 'object' ? budget : { segments: 0, posts: 0, solids: 0, entrances: 0 };
  const boxes = [];
  let truncated = false;
  if (!plan?.recipe) return { boxes, truncated };
  const height = typeof heightAt === 'function' ? heightAt : () => 0;
  const heightWorld = plan.recipe.heightMetres * 0.1;

  for (const run of plan.runs) {
    const points = run.points;
    for (let index = 1; index < points.length; index += 1) {
      const [x1, z1] = points[index - 1];
      const [x2, z2] = points[index];
      const length = Math.hypot(x2 - x1, z2 - z1);
      if (length < 1e-6) continue;
      const steps = Math.max(1, Math.ceil(length / GDO_WALL_LIMITS.maxCompoundSegmentLength));
      for (let step = 0; step < steps; step += 1) {
        if (counts.solids >= GDO_WALL_LIMITS.maxSolids) {
          truncated = true;
          break;
        }
        const t0 = step / steps;
        const t1 = (step + 1) / steps;
        const ax = x1 + (x2 - x1) * t0, az = z1 + (z2 - z1) * t0;
        const bx = x1 + (x2 - x1) * t1, bz = z1 + (z2 - z1) * t1;
        const half = plan.recipe.thicknessMetres * 0.1;
        const bottom = Math.min(height(ax, az), height(bx, bz));
        const top = Math.max(height(ax, az), height(bx, bz)) + heightWorld;
        boxes.push({
          minX: Math.min(ax, bx) - half,
          minZ: Math.min(az, bz) - half,
          maxX: Math.max(ax, bx) + half,
          maxZ: Math.max(az, bz) + half,
          bottom,
          top,
        });
        counts.solids += 1;
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { boxes, truncated };
}

/**
 * The gate's proof helper: no compound box may intrude into any opening's
 * free passage. The passage radius is the gate half-width minus the wall's own
 * thickness (the box ends legitimately touch the opening edge), so a sealed
 * gate is caught while a proper wall end is not. Returns `ok` plus the
 * offending box/`opening-index` pair when the compound forgot a gate.
 */
export function compoundPreservesOpenings(compound, plan) {
  const boxes = compound && Array.isArray(compound.boxes) ? compound.boxes : [];
  const openings = plan && Array.isArray(plan.openings) ? plan.openings : [];
  const halfThickness = plan?.recipe ? plan.recipe.thicknessMetres * 0.1 : 0;
  for (let index = 0; index < openings.length; index += 1) {
    const opening = openings[index];
    const passageRadius = Math.max(0, opening.widthMetres * 0.05 - halfThickness - 1e-6);
    for (const box of boxes) {
      const closestX = Math.max(box.minX, Math.min(opening.x, box.maxX));
      const closestZ = Math.max(box.minZ, Math.min(opening.z, box.maxZ));
      const distance = Math.hypot(opening.x - closestX, opening.z - closestZ);
      if (distance < passageRadius - 1e-9) {
        return { ok: false, openingIndex: index, box, distance };
      }
    }
  }
  return { ok: true, openings: openings.length, boxes: boxes.length };
}
