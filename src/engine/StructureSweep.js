import { featureNamespace } from './FeatureVersions.js';
import { GEO_QUERY_MASK, sweepPointAgainstAabb3 } from '../geo/GeoCollision.js';

/**
 * `COL-06` curated structural sweep.
 *
 * The curated island keeps its structural masses (bridge decks, rails, piers,
 * landmark compounds, sign boards, skyline and railway proxies) as tight axis
 * boxes. `FND-08` asked every world to answer one declared sweep query, so this
 * module owns those boxes and answers the shared sweep contract for them instead
 * of letting the camera iterate its own private list.
 *
 * The boxes are the caller's own live array: roles and masks live in
 * `box.userData`, an entry pushed by a bridge builder or a hoarding manager is
 * visible to the very next query, and a caller that truncates the array is
 * honoured immediately. Work stays bounded — a sweep culls by its own expanded
 * bounds and, if a pathological frame still offers more candidates than the
 * profile allows, prunes deterministically nearest-first and reports it.
 *
 * No `three` import: a box is anything with `min`/`max` vectors.
 */

export const GDO_STRUCTURE_SWEEP_NAMESPACE = featureNamespace('structureSweep');

export const GDO_STRUCTURE_SWEEP_PROFILES = Object.freeze({
  low: Object.freeze({ maxCandidates: 256, maxBlockers: 512 }),
  balanced: Object.freeze({ maxCandidates: 384, maxBlockers: 768 }),
  high: Object.freeze({ maxCandidates: 512, maxBlockers: 1_024 }),
});

export function structureSweepBudgetForProfile(profile) {
  const budget = GDO_STRUCTURE_SWEEP_PROFILES[profile];
  if (!budget) throw new RangeError(`Unknown structure-sweep profile: ${profile}`);
  return budget;
}

/** Default role/mask for a structural box that declares neither. */
export const GDO_STRUCTURE_DEFAULT_MASK = GEO_QUERY_MASK.CAMERA_BLOCKER;

function maskFor(box) {
  const declared = box?.userData?.mask;
  return Number.isFinite(declared) && declared > 0 ? declared : GDO_STRUCTURE_DEFAULT_MASK;
}

function idFor(box, index) {
  return box?.userData?.id ?? `structure:${index}`;
}

/**
 * Owns one live array of structural boxes and answers sweeps against it.
 * `out` is always the caller's record (zero steady-frame allocations).
 */
export function createStructureSweep({ profile = 'low', boxes = [] } = {}) {
  const budget = structureSweepBudgetForProfile(profile);
  if (!Array.isArray(boxes)) throw new TypeError('Structure sweep needs an array of boxes');
  const queryDiagnostics = {
    sweeps: 0, candidates: 0, maxCandidates: 0, culled: 0, pruned: 0,
    rejected: 0, hits: 0, missingBounds: 0,
  };
  const candidates = [];
  const sweepCandidate = {};

  /** Declare a box's id/role/mask without disturbing an existing declaration. */
  function describe(box, { id = null, role = 'camera-blocker', mask = null } = {}) {
    if (!box?.min || !box?.max) throw new TypeError('Structure sweep needs a box with min/max bounds');
    box.userData ??= {};
    if (id && !box.userData.id) box.userData.id = id;
    if (!box.userData.role) box.userData.role = role;
    if (mask != null && !box.userData.mask) box.userData.mask = mask;
    return box;
  }

  function add(box, options) {
    describe(box, options);
    boxes.push(box);
    return box;
  }

  function addAll(collection, options) {
    let added = 0;
    for (const item of collection ?? []) {
      // A `Map`/`Set` yields `[key, box]` pairs, an array yields boxes; both are
      // accepted so a caller can keep its own bookkeeping without a copy.
      const entry = Array.isArray(item) && item.length === 2 && item[1]?.min ? item[1] : item;
      if (!entry?.min || !entry?.max) continue;
      add(entry, options);
      added++;
    }
    return added;
  }

  function remove(box) {
    const index = boxes.indexOf(box);
    if (index < 0) return false;
    boxes.splice(index, 1);
    return true;
  }

  function diagnostics() {
    return Object.freeze({
      namespace: GDO_STRUCTURE_SWEEP_NAMESPACE,
      profile,
      blockers: boxes.length,
      maxBlockers: budget.maxBlockers,
      ...queryDiagnostics,
      steadyFrameAllocations: 0,
    });
  }

  /**
   * Move a sphere from `(x, y, z)` along `(dx, dy, dz)`. Returns the nearest
   * structural contact inside the time range, with the coordinates the caller
   * needs to slide, and never touches a box whose mask is not queried.
   */
  function querySweep(x, y, z, dx, dy, dz, radius, out = {}, queryMask = GDO_STRUCTURE_DEFAULT_MASK) {
    if (![x, y, z, dx, dy, dz, radius].every(Number.isFinite)) {
      throw new TypeError('Structure sweep needs finite coordinates and radius');
    }
    const mask = Number.isFinite(queryMask) ? queryMask : GDO_STRUCTURE_DEFAULT_MASK;
    queryDiagnostics.sweeps++;
    out.hit = false;
    out.time = 1;
    out.blockerDistance = 0;
    out.normalX = 0;
    out.normalY = 0;
    out.normalZ = 0;
    out.startedOverlapping = false;
    out.blockerId = null;
    out.blockerRole = null;
    out.blockerMask = 0;
    out.blockerIndex = -1;

    const minX = Math.min(x, x + dx) - radius, maxX = Math.max(x, x + dx) + radius;
    const minY = Math.min(y, y + dy) - radius, maxY = Math.max(y, y + dy) + radius;
    const minZ = Math.min(z, z + dz) - radius, maxZ = Math.max(z, z + dz) + radius;
    candidates.length = 0;
    for (let index = 0; index < boxes.length; index++) {
      const box = boxes[index];
      if (!box?.min || !box?.max) { queryDiagnostics.missingBounds++; continue; }
      if ((maskFor(box) & mask) === 0) continue;
      if (box.min.x - radius > maxX || box.max.x + radius < minX ||
          box.min.y - radius > maxY || box.max.y + radius < minY ||
          box.min.z - radius > maxZ || box.max.z + radius < minZ) {
        queryDiagnostics.culled++;
        continue;
      }
      candidates.push(index);
    }
    // A pathological frame is pruned deterministically nearest-first, so the
    // sweep can never walk an unbounded list and two runs agree on the verdict.
    if (candidates.length > budget.maxCandidates) {
      const spanX = dx, spanY = dy, spanZ = dz;
      const score = index => {
        const box = boxes[index];
        const cx = (box.min.x + box.max.x) / 2 - x;
        const cy = (box.min.y + box.max.y) / 2 - y;
        const cz = (box.min.z + box.max.z) / 2 - z;
        const lengthSquared = spanX * spanX + spanY * spanY + spanZ * spanZ;
        const amount = lengthSquared
          ? Math.max(0, Math.min(1, (cx * spanX + cy * spanY + cz * spanZ) / lengthSquared))
          : 0;
        const ox = cx - spanX * amount, oy = cy - spanY * amount, oz = cz - spanZ * amount;
        return ox * ox + oy * oy + oz * oz;
      };
      candidates.sort((first, second) => score(first) - score(second) || first - second);
      queryDiagnostics.pruned += candidates.length - budget.maxCandidates;
      candidates.length = budget.maxCandidates;
    }
    queryDiagnostics.candidates += candidates.length;
    queryDiagnostics.maxCandidates = Math.max(queryDiagnostics.maxCandidates, candidates.length);

    for (const index of candidates) {
      const box = boxes[index];
      const hit = sweepPointAgainstAabb3(
        x, y, z, dx, dy, dz,
        box.min.x - radius, box.min.y - radius, box.min.z - radius,
        box.max.x + radius, box.max.y + radius, box.max.z + radius,
        sweepCandidate,
      );
      if (!hit.hit) { queryDiagnostics.rejected++; continue; }
      if (out.hit && hit.time >= out.time) continue;
      out.hit = true;
      out.time = hit.time;
      out.startedOverlapping = hit.startedOverlapping;
      out.normalX = hit.normalX;
      out.normalY = hit.normalY;
      out.normalZ = hit.normalZ;
      out.blockerId = idFor(box, index);
      out.blockerRole = box.userData?.role ?? 'camera-blocker';
      out.blockerMask = maskFor(box);
      out.blockerIndex = index;
    }
    if (out.hit) {
      out.blockerDistance = Math.hypot(dx, dy, dz) * out.time;
      queryDiagnostics.hits++;
    }
    return out;
  }

  return Object.freeze({
    namespace: GDO_STRUCTURE_SWEEP_NAMESPACE,
    profile,
    limits: Object.freeze({ ...budget }),
    /** The live structural set: push, splice, or truncate it directly. */
    boxes,
    get size() { return boxes.length; },
    add,
    addAll,
    remove,
    clear() { boxes.length = 0; },
    querySweep,
    queryDiagnostics,
    diagnostics,
    steadyFrameAllocations: 0,
  });
}
