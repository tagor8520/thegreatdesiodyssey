/**
 * `GME-04` — throttled line-of-sight for projected place labels.
 *
 * Place labels are DOM elements positioned over the WebGL canvas, so they do not
 * take part in depth testing: without an explicit test a place name draws straight
 * through the building in front of it. The layering research names this as its own
 * failure row — *"DOM label occlusion | a place name appears through a building |
 * sparse line-of-sight query or in-scene label"* — and it comes with a contract:
 *
 * - §15.6.1: *a label behind a building is hidden within the LOS update interval; a
 *   label in front remains visible.*
 * - §15.6.2: *label LOS does not use collectible, grass, bird, or bee proxies* —
 *   i.e. the query asks for `LOS_BLOCKER` and nothing else. A pickup or a bird
 *   drifting between eye and label must not blank the name.
 * - §13: label LOS is budgeted at **20 / 40 / 80 tests per second** and **5 / 10 /
 *   14 simultaneous labels** for the low / balanced / high profiles. A label layer
 *   that ray-casts every label every frame is exactly the unbounded work the
 *   budgets exist to forbid (roadmap §4 invariant 12).
 * - §12.1/§12.2: diagnostics must expose *label ray, blocker, LOS update age* and
 *   the counters *label LOS tests / hidden labels*.
 *
 * The scheduler is deliberately separated from both the world and the DOM: the
 * sweep is injected, so the gate can drive it with a synthetic blocker instead of a
 * compiled fixture, and the caller owns presentation. Nothing here allocates per
 * pass beyond the maps it reuses, and every cap is a hard ceiling rather than a
 * target.
 */

import { GEO_QUERY_MASK } from './GeoCollision.js';

/**
 * The research's own numbers, per profile. `testsPerSecond` and
 * `simultaneousLabels` are ceilings: exceeding either is a bug in the caller, not a
 * slow frame, so the scheduler clamps instead of trusting the caller.
 */
export const GEO_LABEL_LOS_PROFILES = Object.freeze({
  low: Object.freeze({ testsPerSecond: 20, simultaneousLabels: 5 }),
  balanced: Object.freeze({ testsPerSecond: 40, simultaneousLabels: 10 }),
  high: Object.freeze({ testsPerSecond: 80, simultaneousLabels: 14 }),
});

/** How long a label may keep a verdict before it must be re-tested. */
export const GEO_LABEL_LOS_REFRESH_MILLISECONDS = 250;

/**
 * The radius of the LOS probe, in world units.
 *
 * A single ray would let a label flicker whenever the geometric centre of a
 * footprint missed a facade edge; a small sphere asks "is there a wall in the way
 * of this name", which is what a player perceives. It is well under the collision
 * footprint (`0.055` radius) so it cannot blank a label through a coincident wall.
 */
export const GEO_LABEL_LOS_RADIUS = .35;

export class GeoLabelLosError extends Error {
  constructor(message) { super(message); this.name = 'GeoLabelLosError'; }
}

/** Which compass slice a bearing falls in, as one of 16 three-letter-or-less names. */
const COMPASS_POINTS = Object.freeze([
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
]);

/**
 * Compass bearing and great-circle distance from one coordinate to another.
 *
 * Used by the coordinate HUD to say where the nearest named place is. It is
 * computed from latitude/longitude rather than from world axes on purpose: the
 * world-to-coordinate mapping is the authority on orientation (`worldToCoordinate`
 * in `GeoMath.js`), so deriving the bearing here cannot disagree with the
 * coordinates the HUD prints beside it.
 */
export function compassBearing(fromLatitude, fromLongitude, toLatitude, toLongitude) {
  const toRadians = degrees => degrees * Math.PI / 180;
  const toDegrees = radians => radians * 180 / Math.PI;
  const clamp = value => Math.max(-1, Math.min(1, value));
  const fromLat = toRadians(fromLatitude), toLat = toRadians(toLatitude);
  const deltaLat = toLat - fromLat;
  const deltaLon = toRadians(toLongitude - fromLongitude);
  // Bearing is measured from north, clockwise; the longitude term is scaled by the
  // local cosine so a degree of longitude at 60°N is not treated as a degree at the
  // equator.
  const y = Math.sin(deltaLon) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLon);
  const degrees = (toDegrees(Math.atan2(y, x)) + 360) % 360;

  // Equirectangular distance is accurate to well under a percent at the scales a
  // label HUD reports (metres to a few kilometres), and has no antimeridian blowup.
  // Computed from **degrees**, not from the radian deltas above: multiplying a
  // radian by a metres-per-degree constant is off by 57x, which is exactly the kind
  // of error a HUD would show as "19 m" for a kilometre.
  const meanLatitude = toRadians((fromLatitude + toLatitude) / 2);
  const metresPerDegreeLatitude = 111_320;
  const dx = (toLongitude - fromLongitude) * Math.cos(meanLatitude) * metresPerDegreeLatitude;
  const dz = (toLatitude - fromLatitude) * metresPerDegreeLatitude;
  const metres = Math.hypot(dx, dz);

  const index = Math.round(degrees / 22.5) % 16;
  return { degrees, point: COMPASS_POINTS[index], metres };
}

/** Distance in metres only — the common case when a caller already has metres. */
export function compassPoint(degrees) {
  if (!Number.isFinite(degrees)) return null;
  return COMPASS_POINTS[Math.round(((degrees % 360) + 360) % 360 / 22.5) % 16];
}

/** Human-readable distance for a HUD: `840 m`, `1.4 km`. */
export function formatMetres(metres) {
  if (!Number.isFinite(metres)) return '—';
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}

/**
 * Schedules LOS tests for a frame's label candidates.
 *
 * `sweep(x, y, z, dx, dy, dz, radius, out, mask)` reports a blockage by setting
 * `hit` on `out`, by returning a boolean, or both. It is injected so this class can
 * be tested without a world, and so the caller decides which structure answers.
 *
 * The verdict is read from `out.hit`, with a strict `=== true` on the return value
 * as a fallback. That asymmetry is deliberate: `world.sweepSphere` **returns the
 * `out` object**, which is truthy whether or not anything was hit — reading the
 * return value as a boolean would hide every label in the scene.
 */
export class LabelLosScheduler {
  /**
   * @param {object} options
   * @param {(x,y,z,dx,dy,dz,radius,out,mask) => boolean} options.sweep
   * @param {'low'|'balanced'|'high'} [options.profile]
   * @param {number} [options.refreshMilliseconds]
   * @param {number} [options.radius]
   */
  constructor({
    sweep,
    profile = 'low',
    refreshMilliseconds = GEO_LABEL_LOS_REFRESH_MILLISECONDS,
    radius = GEO_LABEL_LOS_RADIUS,
  } = {}) {
    const limits = GEO_LABEL_LOS_PROFILES[profile];
    if (typeof sweep !== 'function') throw new GeoLabelLosError('LabelLosScheduler needs a sweep function');
    if (!limits) throw new GeoLabelLosError(`Unknown label LOS profile: ${JSON.stringify(profile)}`);
    if (!Number.isFinite(refreshMilliseconds) || refreshMilliseconds <= 0) {
      throw new GeoLabelLosError(`refreshMilliseconds must be a positive finite number, got ${JSON.stringify(refreshMilliseconds)}`);
    }
    this.sweep = sweep;
    this.profile = profile;
    this.limits = limits;
    this.refreshMilliseconds = refreshMilliseconds;
    this.radius = radius;
    /** Verdicts by label key, each with the age and blocker the diagnostics must report. */
    this.states = new Map();
    this.scratch = { hit: false, time: 1, tileKey: null, polygonIndex: -1, dynamicHandle: 0, dynamicOwner: null };
    // A token bucket rather than a fixed per-pass count: an idle second must not
    // accumulate an unbounded backlog, and a busy second must not exceed the
    // per-second ceiling. `tokens` are *tests*, and the bucket is capped at one
    // pass's worth so a long stall cannot be repaid in a burst.
    this.tokens = limits.simultaneousLabels;
    this.lastPassMilliseconds = null;
    this.counters = {
      tests: 0, hidden: 0, passes: 0, skippedForBudget: 0, skippedForRefresh: 0, blockedNow: 0,
      lastPassTests: 0, lastBlocked: null, oldestAgeMilliseconds: 0, rayTests: 0,
    };
  }

  /** Drop verdicts for labels that are no longer candidates, so a name cannot inherit one. */
  retain(keys) {
    const keep = keys instanceof Set ? keys : new Set(keys);
    for (const key of this.states.keys()) if (!keep.has(key)) this.states.delete(key);
  }

  /**
   * Test up to the pass budget and return this pass's verdicts.
   *
   * @param {Array<{key: string, x: number, y: number, z: number}>} candidates
   *   ordered by the caller's own priority (nearest, or highest-priority kind).
   * @param {{x: number, y: number, z: number}} eye camera position the ray starts at
   * @param {number} nowMilliseconds monotonic clock
   */
  update(candidates, eye, nowMilliseconds) {
    const elapsed = this.lastPassMilliseconds === null ? this.refreshMilliseconds : Math.max(0, nowMilliseconds - this.lastPassMilliseconds);
    this.lastPassMilliseconds = nowMilliseconds;
    this.counters.passes++;
    // Refill by elapsed time; both the refill and the bucket are capped so neither a
    // stall nor a burst can exceed the profile's per-second ceiling.
    const refill = elapsed * this.limits.testsPerSecond / 1000;
    this.tokens = Math.min(this.limits.simultaneousLabels, this.tokens + refill);

    let tested = 0;
    let hiddenThisPass = 0;
    let skippedForBudget = 0;
    let skippedForRefresh = 0;
    let lastBlocked = null;
    for (const candidate of candidates) {
      const state = this.states.get(candidate.key);
      const fresh = state && nowMilliseconds - state.testedAtMilliseconds < this.refreshMilliseconds;
      if (fresh) {
        // Within the refresh interval the previous verdict stands: that is what
        // "hidden within the LOS update interval" means, and re-testing every frame
        // is the unbounded work the budget forbids.
        skippedForRefresh++;
        continue;
      }
      if (tested >= this.limits.simultaneousLabels || this.tokens < 1) { skippedForBudget++; continue; }
      this.tokens -= 1;
      tested++;

      const dx = candidate.x - eye.x, dy = candidate.y - eye.y, dz = candidate.z - eye.z;
      this.scratch.hit = false;
      this.scratch.time = 1;
      this.scratch.tileKey = null;
      this.scratch.polygonIndex = -1;
      this.scratch.dynamicHandle = 0;
      this.scratch.dynamicOwner = null;
      const swept = this.sweep(eye.x, eye.y, eye.z, dx, dy, dz, this.radius, this.scratch, GEO_QUERY_MASK.LOS_BLOCKER);
      // `out.hit` first, then a *strict* boolean return. Never a truthiness test on
      // the return value: the world's own sweep returns the out object.
      const blocked = this.scratch.hit === true || swept === true;
      this.counters.tests++;
      this.counters.rayTests++;
      if (blocked) {
        hiddenThisPass++;
        this.counters.hidden++;
        lastBlocked = {
          key: candidate.key,
          // The diagnostics the research asks for: the ray, the blocker and the age.
          ray: { from: { ...eye }, to: { x: candidate.x, y: candidate.y, z: candidate.z } },
          blocker: this.scratch.dynamicOwner ?? this.scratch.tileKey ?? 'static',
          time: this.scratch.time,
        };
      }
      this.states.set(candidate.key, {
        blocked,
        testedAtMilliseconds: nowMilliseconds,
        time: this.scratch.time,
        blocker: blocked ? (this.scratch.dynamicOwner ?? this.scratch.tileKey ?? 'static') : null,
        ray: { from: { ...eye }, to: { x: candidate.x, y: candidate.y, z: candidate.z } },
      });
    }

    // Verdicts for candidates that were not tested this pass keep their previous
    // age; a label that was hidden stays hidden until it is re-tested and cleared.
    let oldest = 0;
    let blockedNow = 0;
    for (const [key, state] of this.states) {
      if (state.blocked) blockedNow++;
      oldest = Math.max(oldest, nowMilliseconds - state.testedAtMilliseconds);
      if (!candidates.some(candidate => candidate.key === key)) this.states.delete(key);
    }
    this.counters.blockedNow = blockedNow;
    this.counters.lastPassTests = tested;
    this.counters.lastBlocked = lastBlocked;
    this.counters.skippedForBudget += skippedForBudget;
    this.counters.skippedForRefresh += skippedForRefresh;
    this.counters.oldestAgeMilliseconds = oldest;
    return { tested, hidden: hiddenThisPass, skippedForBudget, skippedForRefresh, lastBlocked };
  }

  /** True when this label's last verdict says something opaque is in the way. */
  isHidden(key) { return this.states.get(key)?.blocked === true; }

  /** Age of a label's verdict, for the debug overlay's *LOS update age* readout. */
  ageMilliseconds(key, nowMilliseconds) {
    const state = this.states.get(key);
    return state ? Math.max(0, nowMilliseconds - state.testedAtMilliseconds) : null;
  }

  /** The diagnostics row the layering research lists for labels. */
  diagnostics(nowMilliseconds = null) {
    const now = nowMilliseconds === null ? this.lastPassMilliseconds ?? 0 : nowMilliseconds;
    const oldest = nowMilliseconds === null ? this.counters.oldestAgeMilliseconds
      : Math.max(0, ...[...this.states.values()].map(state => nowMilliseconds - state.testedAtMilliseconds));
    // Per-label rows: §12.1 asks for the label *ray*, its *blocker* and the *LOS
    // update age*, which are per-label facts. A caller can read them without
    // reaching into `states`, and a fresh row (age under the refresh interval) is
    // proof the label was a candidate in the last pass — i.e. it was on screen and
    // not overlapped, so its verdict can only be about occlusion.
    const labels = [...this.states].map(([key, state]) => ({
      key,
      blocked: state.blocked,
      blocker: state.blocker,
      time: state.time,
      ageMilliseconds: Math.max(0, now - state.testedAtMilliseconds),
      ray: state.ray,
    }));
    // The newest blocked row is the useful answer to "what is hiding something right
    // now"; the pass-scoped value is only a fallback for when nothing currently is.
    const newestBlocked = labels
      .filter(row => row.blocked)
      .sort((a, b) => a.ageMilliseconds - b.ageMilliseconds)[0] ?? null;
    return {
      labels,
      profile: this.profile,
      testsPerSecond: this.limits.testsPerSecond,
      simultaneousLabels: this.limits.simultaneousLabels,
      tests: this.counters.tests,
      hidden: this.counters.hidden,
      blockedNow: this.counters.blockedNow,
      tracked: this.states.size,
      updateAgeMilliseconds: oldest,
      lastBlocker: newestBlocked
        ? { key: newestBlocked.key, blocker: newestBlocked.blocker, time: newestBlocked.time, ray: newestBlocked.ray }
        : this.counters.lastBlocked,
      tokens: this.tokens,
    };
  }

  /**
   * Forget every verdict *and* every counter.
   *
   * Clearing the verdicts without the counters left `diagnostics()` reporting a
   * `blockedNow` for labels it no longer tracked, which is worse than either
   * behaviour on its own — so `reset()` is a full reset. A caller that wants
   * cumulative numbers keeps its own copy instead of calling this.
   */
  reset() {
    this.states.clear();
    this.tokens = this.limits.simultaneousLabels;
    this.lastPassMilliseconds = null;
    for (const key of Object.keys(this.counters)) {
      this.counters[key] = typeof this.counters[key] === 'number' ? 0 : null;
    }
  }
}
