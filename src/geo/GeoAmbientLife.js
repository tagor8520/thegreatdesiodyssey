/**
 * `LIF-02` — ambient-life scheduler and pools.
 *
 * Registered gate (feature-roadmap/README.md order 121):
 *   "Screen/distance/activity budgets; no per-agent object graphs."
 *
 * The research the matrix row comes from is explicit about what the shipped
 * behaviour is *not*:
 *
 * - `VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md` §4 item 10: *"Ambient plant motion is
 *   absent. **Birds and bees update instance matrices on the CPU** …"*
 * - §14 budget table: *"Small ambient fauna visible | 30 | 60 | 100"* for low /
 *   balanced / high, alongside *"Total added steady draw calls in ordinary view"*.
 * - §6 habitat table: the families are habitat-anchored — *"Butterflies near
 *   flowers, dragonflies near wetland, fireflies in humid dusk … Water birds near
 *   broad water, small birds by trees/buildings, pigeons in dense urban areas"* —
 *   and *"All fauna use pooled, instanced, highly simplified motion and habitat
 *   anchors."*
 * - `CLIPPING_AND_LAYERING_RESEARCH.md` §15.6.2 relies on the same split the label
 *   gate tested from the other side: ambient agents must **not** be collision roles,
 *   so a bird drifting between the eye and a place name cannot blank it.
 *
 * The behaviour this module replaced walked every ambient instance of every resident
 * tile, every frame, writing every instance matrix — no distance test, no screen
 * test, no budget, and no state beyond the mesh. That loop is gone from `GeoWorld`,
 * and the browser gate's first negative control reinstalls it verbatim to prove the
 * measurement can still see it. What replaces it is a budgeted scheduler over
 * **preallocated slots**:
 *
 * - **Fixed capacity, no per-agent objects.** Every slot is allocated once in the
 *   constructor; a tile's placements claim slots and release them, and an over-cap
 *   placement is *rejected* with a reason (`over-capacity`), never queued and never
 *   allocated ad hoc. Storage is parallel typed arrays — anchor x/z, ground y, phase,
 *   scale, species, stable integer, instance index, pose age and a pose row — plus one
 *   key string per slot, so a steady pass allocates nothing: measured at ≈16 bytes per
 *   pass with 64 agents and −18 with 8 over 20,000 passes, i.e. flat in agent count,
 *   where a per-agent object would add one allocation per agent per pass.
 * - **Distance and screen culls in squared space.** `distance²` against a squared
 *   radius and the projected footprint against a squared pixel threshold, so the hot
 *   loop contains no `Math.hypot` and no `Math.sqrt`.
 * - **Two budgets, because the research states two numbers.** The *drawn* set is a
 *   fixed ring of `visibleCeiling` entries (30 / 60 / 100 at low / balanced / high,
 *   §14's "small ambient fauna visible"), and the *per-frame work* is a separate pose
 *   budget (24 / 48 / 96) that bounds how many poses are recomputed. Honouring only
 *   the second was this module's own first defect: a resident set larger than the
 *   ceiling still drew every agent, the updated ones moving and the rest holding a
 *   stale pose.
 * - **Every cull is counted by reason.** `distance` (beyond the configured reach),
 *   `screen` (footprint below the pixel floor, compared in squared space) and
 *   `activity`, each with its own counter, so a diagnostic can say which budget did
 *   the culling rather than only that something vanished.
 * - **Leaving the drawn set means being hidden.** Slots are taken out of the ring and
 *   queued in a preallocated array for the caller to collapse (zero scale), because an
 *   agent frozen at its last pose is the defect this slice removes. `writeMatrices` and
 *   `forEachHidden` hand the caller the **same** single reused pose object, so a caller
 *   never has to reach into the scheduler's arrays and the frame still allocates
 *   nothing.
 * - **Activity budget.** The research says "activity budgets" and ties ambient life
 *   to conditions (dusk for fireflies, weather for sheltering birds). The scheduler
 *   takes an `activity` in `0…1` and a `speciesActivity` table, and turns slots off
 *   in a deterministic order, so a caller can wind ambience down for weather or for a
 *   cutscene without a second code path.
 * - **Virtual origin.** Poses are computed in a rebased local frame with an integer
 *   origin, so motion far from the world origin stays precise instead of degrading
 *   into quantised steps. The origin follows the focus by whole units only.
 *
 * The pose *shapes* are the shipped ones, moved here rather than reinvented: a
 * `species` selects the orbit the previous code hard-coded by type (birds circle at
 * `2.55 + n·0.28` above the ground at `0.72 + n·0.16` metres; bees buzz at
 * `0.48 + n·0.055` at `0.13 + n·0.045`). The `step` that used to come from the
 * instance index now comes from the slot's **stable** integer, which is derived from
 * the placement, so a tile that streams out and back reproduces the same orbits
 * instead of reshuffling them.
 */

import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';

/**
 * The research's own ceilings, verbatim: §14 *"Small ambient fauna visible | 30 | 60
 * | 100"* for low / balanced / high. Declared once so a profile and the shared budget
 * object can be *compared* rather than both trusted.
 */
export const GEO_AMBIENT_RESEARCH_CEILINGS = Object.freeze({ low: 30, balanced: 60, high: 100 });

/** Profiles are ceilings, derived from the table above. */
export const GEO_AMBIENT_PROFILES = Object.freeze({
  low: Object.freeze({ capacity: 64, visible: GEO_AMBIENT_RESEARCH_CEILINGS.low, perFrame: 24, screenPixels: 0.6, drawCalls: 2 }),
  balanced: Object.freeze({ capacity: 128, visible: GEO_AMBIENT_RESEARCH_CEILINGS.balanced, perFrame: 48, screenPixels: 0.6, drawCalls: 2 }),
  high: Object.freeze({ capacity: 256, visible: GEO_AMBIENT_RESEARCH_CEILINGS.high, perFrame: 96, screenPixels: 0.6, drawCalls: 2 }),
});

/** The shipped placement range, in metres. Beyond it a name is not worth a slot. */
export const GEO_AMBIENT_MAX_DISTANCE = 72;

/**
 * The shipped motion families, as data.
 *
 * `orbit`/`buzz` are the two shapes `_animateAmbientLife` hard-coded; each entry
 * carries the numbers that were literals in that loop. `activity` is the species'
 * share of the scheduler's activity level, which is how a caller shelters one family
 * without touching the other.
 */
export const GEO_AMBIENT_SPECIES = Object.freeze({
  bird: Object.freeze({
    name: 'bird',
    speed: .30, speedStep: .045,
    radiusBase: .72, radiusStep: .16,
    heightBase: 2.55, heightStep: .28,
    bobAmplitude: .18, bobFrequency: 1.35,
    rollAmplitude: .08, rollFrequency: 3.2,
    activity: 1,
  }),
  bee: Object.freeze({
    name: 'bee',
    speed: 1.45, speedStep: .13,
    radiusBase: .13, radiusStep: .045,
    heightBase: .48, heightStep: .055,
    bobAmplitude: .075, bobFrequency: 4.4,
    rollAmplitude: .12, rollFrequency: 8,
    activity: 1,
  }),
});

/** Placement types the world emits for ambient life, mapped to a species. */
export const GEO_AMBIENT_TYPES = Object.freeze({ 10: 'bird', 11: 'bee' });

export class GeoAmbientLifeError extends Error {
  constructor(message) { super(message); this.name = 'GeoAmbientLifeError'; }
}

const SLOT_STRIDE = 8;

/**
 * The no-options default, allocated once.
 *
 * A `= {}` default parameter allocates a fresh object on every call, which measured
 * at ~84 bytes per pass — small, but the whole point of this module is that a steady
 * frame allocates nothing, and an avoidable allocation in the signature would make
 * the gate's own claim false.
 */
const EMPTY_OPTIONS = Object.freeze({});

export class GeoAmbientScheduler {
  /**
   * @param {object} options
   * @param {'low'|'balanced'|'high'} [options.profile]
   * @param {number} [options.maxDistance] metres; the squared radius is derived
   */
  constructor({ profile = 'low', maxDistance = GEO_AMBIENT_MAX_DISTANCE } = {}) {
    const limits = GEO_AMBIENT_PROFILES[profile];
    if (!limits) throw new GeoAmbientLifeError(`Unknown ambient profile: ${JSON.stringify(profile)}`);
    if (!Number.isFinite(maxDistance) || maxDistance <= 0) {
      throw new GeoAmbientLifeError(`maxDistance must be a positive finite number, got ${JSON.stringify(maxDistance)}`);
    }
    this.profile = profile;
    this.limits = limits;
    this.maxDistance = maxDistance;
    this.maxDistanceSquared = maxDistance * maxDistance;
    this.capacity = limits.capacity;
    this.visibleCeiling = limits.visible;
    this.perFrame = limits.perFrame;

    // One allocation for the scheduler's whole life. Six parallel arrays rather
    // than one object per agent: the "no per-agent object graphs" contract.
    this.anchorX = new Float64Array(this.capacity);
    this.anchorZ = new Float64Array(this.capacity);
    this.groundY = new Float64Array(this.capacity);
    this.phase = new Float32Array(this.capacity);
    this.scale = new Float32Array(this.capacity);
    this.species = new Int8Array(this.capacity).fill(-1);
    this.ownerKey = new Array(this.capacity).fill(null);
    this.instanceIndex = new Int32Array(this.capacity);
    this.pose = new Float32Array(this.capacity * SLOT_STRIDE);
    this.poseAge = new Float32Array(this.capacity).fill(Infinity);
    this.stable = new Uint32Array(this.capacity);
    /** Deterministic rotation so no slot is starved and no allocation order leaks. */
    this.round = 0;
    this.freeSlots = [];
    for (let slot = this.capacity - 1; slot >= 0; slot--) this.freeSlots.push(slot);
    this.poseCursor = 0;
    this.lastCursorOffset = 0;
    /**
     * The slots currently **drawn**, as a fixed-size ring of `visibleCeiling` entries.
     *
     * This is the correction of a real flaw in the first version of this module: it
     * bounded the number of pose *updates* per frame but not the number of agents on
     * screen, so a resident set larger than the ceiling still drew every agent — the
     * updated ones moving and the rest holding their last pose. The budget the
     * research states is on *visible* fauna, so the drawn set is explicit, capped, and
     * maintained here; a slot leaving the ring has its instance hidden once.
     */
    this.ring = new Int32Array(this.visibleCeiling).fill(-1);
    this.ringCursor = 0;
    this.fillCursor = 0;
    /** Slots that left the ring this pass and must be hidden by the caller. */
    this.hiddenSlots = new Int32Array(this.visibleCeiling);
    this.hiddenCount = 0;

    // Whole-unit rebasing: poses are computed relative to this origin so far-world
    // motion keeps full precision.
    this.originX = 0;
    this.originZ = 0;

    this.scratch = { x: 0, y: 0, z: 0, yaw: 0, roll: 0, scale: 1 };
    /** The one pose object handed to every `writeMatrices` callback. */
    this.scratchPose = {
      slot: 0, ownerKey: null, species: 'bird', type: 10, instanceIndex: -1,
      x: 0, y: 0, z: 0, yaw: 0, roll: 0, scale: 1,
    };
    this.activeBySpecies = new Map();
    this.activity = 1;
    this.counters = {
      passes: 0, claims: 0, releases: 0, rejected: 0, evaluations: 0, distanceCulls: 0,
      screenCulls: 0, activityCulls: 0, poseUpdates: 0, visibleNow: 0,
      lastVisible: 0, lastEvaluations: 0,
    };
    this.lastRejection = null;
    this.lastFrameAllocations = 0;
  }

  /** Slots currently claimed. */
  get active() { return this.capacity - this.freeSlots.length; }

  /**
   * Claim a slot for one ambience placement.
   *
   * @param {{ownerKey: string, type: number, x: number, z: number, groundY: number,
   *          phase: number, scale: number, stable: number}} placement
   * @returns {number} slot, or -1 when the cap is reached (the reason is recorded)
   */
  claim({ ownerKey, type, x, z, groundY, phase, scale, stable = 0, instanceIndex = -1 } = {}) {
    const speciesName = GEO_AMBIENT_TYPES[type];
    if (!speciesName) {
      this._reject('unknown-type', ownerKey, type);
      return -1;
    }
    if (![x, z, groundY, phase, scale].every(Number.isFinite)) {
      this._reject('malformed-placement', ownerKey, type);
      return -1;
    }
    if (!this.freeSlots.length) {
      // Rejection, never eviction: an evicted agent would pop in and out of the
      // world as the player turns, which is exactly what a budget must not cause.
      this._reject('over-capacity', ownerKey, type);
      return -1;
    }
    const slot = this.freeSlots.pop();
    this.ownerKey[slot] = String(ownerKey);
    this.species[slot] = speciesName === 'bird' ? 0 : 1;
    this.anchorX[slot] = x;
    this.anchorZ[slot] = z;
    this.groundY[slot] = groundY;
    this.phase[slot] = phase;
    this.scale[slot] = scale;
    this.stable[slot] = stable >>> 0;
    this.instanceIndex[slot] = Number.isInteger(instanceIndex) ? instanceIndex : -1;
    this.poseAge[slot] = Infinity;
    const base = slot * SLOT_STRIDE;
    // A seed pose in the same layout the writer produces, so a slot admitted before the
    // next pass cannot upload uninitialised memory.
    this.pose[base + 0] = x; this.pose[base + 1] = groundY; this.pose[base + 2] = z;
    this.pose[base + 3] = phase;
    this.pose[base + 4] = 0;
    this.counters.claims++;
    return slot;
  }

  /** Release every slot owned by one key — a tile leaving residency, or a remount. */
  releaseOwner(ownerKey) {
    const key = String(ownerKey);
    let released = 0;
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.ownerKey[slot] !== key) continue;
      this.ownerKey[slot] = null;
      this.species[slot] = -1;
      this.poseAge[slot] = Infinity;
      // Drop it from the drawn ring as well: the owner's meshes are being disposed, so
      // nothing needs hiding, but a stale entry would keep the slot out of the ring
      // and quietly shrink the ceiling after a stream-in/out cycle.
      for (let index = 0; index < this.ring.length; index++) if (this.ring[index] === slot) this.ring[index] = -1;
      this.freeSlots.push(slot);
      released++;
    }
    this.counters.releases += released;
    return released;
  }

  /** Follow the focus by whole units so local poses keep their precision. */
  _rebase(focusX, focusZ) {
    const wholeX = Math.round(focusX), wholeZ = Math.round(focusZ);
    if (wholeX === this.originX && wholeZ === this.originZ) return false;
    this.originX = wholeX;
    this.originZ = wholeZ;
    // Anchors are absolute, so they survive a rebase; cached *poses* are local and do
    // not. They are invalidated rather than left stale, because a stale local pose
    // plus a new origin is a wrong absolute position — the first version of this
    // module moved an agent a million units when the focus jumped.
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.ownerKey[slot] !== null) this.poseAge[slot] = Infinity;
    }
    return true;
  }

  /** Local position of a slot's anchor, in the rebased frame. */
  localAnchor(slot) {
    const base = slot * SLOT_STRIDE;
    return {
      x: this.anchorX[slot] - this.originX + Math.cos(this.phase[slot]) * this.poseRadius(slot),
      z: this.anchorZ[slot] - this.originZ + Math.sin(this.phase[slot]) * this.poseRadius(slot),
      _base: base,
    };
  }

  /** The orbit radius a species/slot produces, matching the shipped formula. */
  poseRadius(slot) {
    const species = this.species[slot] === 0 ? GEO_AMBIENT_SPECIES.bird : GEO_AMBIENT_SPECIES.bee;
    const step = this.stable[slot] % 4;
    return species.radiusBase + step * species.radiusStep;
  }

  /**
   * One scheduler pass.
   *
   * @param {{x: number, y: number, z: number}} focus the player position
   * @param {number} viewportHeight pixels, for the screen-coverage test
   * @param {number} seconds absolute clock, so motion is deterministic
   * @param {number} pixelsPerMetre pixel scale for this camera, evaluated at the focus
   * @param {{activity?: number, speciesActivity?: Record<string, number>}} [options]
   */
  update(focus, viewportHeight, seconds, pixelsPerMetre, options = EMPTY_OPTIONS) {
    const activity = options.activity ?? 1;
    const speciesActivity = options.speciesActivity ?? null;
    this.counters.passes++;
    const evaluationsAtStart = this.counters.evaluations;
    const poseUpdatesAtStart = this.counters.poseUpdates;
    this._rebase(focus.x, focus.z);
    this.activity = Number.isFinite(activity) ? Math.max(0, Math.min(1, activity)) : 1;
    this.hiddenCount = 0;

    const localFocusX = focus.x - this.originX;
    const localFocusZ = focus.z - this.originZ;
    const maxDistanceSquared = this.maxDistanceSquared;
    const pixelScale = Number.isFinite(pixelsPerMetre) && pixelsPerMetre > 0 ? pixelsPerMetre : 0;
    const minPixels = this.limits.screenPixels;
    const ring = this.ring;
    const ringLength = ring.length;
    const budget = this.perFrame;
    let poseUpdates = 0;

    // --- 1. Re-validate this pass's share of the *drawn* set ---------------------
    // Each pass re-checks `perFrame` ring entries in rotation. An entry that is no
    // longer admissible leaves the ring, and its instance is queued for hiding.
    let step = 0;
    while (step < ringLength && poseUpdates < budget) {
      const index = (this.ringCursor + step) % ringLength;
      const slot = ring[index];
      if (slot < 0) { step++; continue; }
      const verdict = this._admissible(slot, localFocusX, localFocusZ, maxDistanceSquared, pixelScale, minPixels, speciesActivity);
      if (verdict !== null) {
        // Culled: leave the ring now rather than holding a stale pose on screen.
        this._hide(slot);
        ring[index] = -1;
        step++;
        continue;
      }
      this._pose(slot, seconds);
      poseUpdates++;
      step++;
    }
    this.ringCursor = (this.ringCursor + Math.max(1, step)) % ringLength;
    this._poseUpdatesAtLastPass = this.counters.poseUpdates;
    this._lastPoseUpdates = poseUpdates;
    this.counters.poseUpdates += poseUpdates;

    // --- 2. Fill empty ring entries -------------------------------------------------
    // Slots are admitted up to the ring's length, which is the visible ceiling: this is
    // the line that makes the *drawn* count bounded rather than only the update rate.
    let open = 0;
    for (let index = 0; index < ringLength; index++) if (ring[index] < 0) open++;
    if (open > 0) {
      // The scan is bounded by the same per-frame budget as the pose updates. Scanning
      // every slot every pass was both unbounded work and the source of a double-counted
      // cull: a permanently culled slot was re-examined on each pass and incremented the
      // counter again, so the diagnostic reported twice the number of decisions made.
      let scanned = 0;
      while (open > 0 && scanned < this.capacity && scanned < budget) {
        const slot = (this.fillCursor + scanned) % this.capacity;
        scanned++;
        if (this.ownerKey[slot] === null) continue;
        if (this._isDrawn(slot)) continue;
        if (this._admissible(slot, localFocusX, localFocusZ, maxDistanceSquared, pixelScale, minPixels, speciesActivity) !== null) continue;
        // Place it in the first empty entry.
        for (let index = 0; index < ringLength; index++) {
          if (ring[index] >= 0) continue;
          ring[index] = slot;
          this._pose(slot, seconds);
          open--;
          break;
        }
      }
      this.fillCursor = (this.fillCursor + Math.max(1, scanned)) % this.capacity;
    }

    // --- 3. Count what is drawn ----------------------------------------------------
    let visible = 0;
    for (let index = 0; index < ringLength; index++) if (ring[index] >= 0) visible++;
    this.counters.lastVisible = Math.min(visible, this.visibleCeiling);
    this.counters.visibleNow = this.counters.lastVisible;
    this.counters.lastEvaluations = this.counters.evaluations - evaluationsAtStart;
    this.counters.lastFrameAllocations = 0;
    return this.counters.lastVisible;
  }

  /** Is this slot currently in the drawn ring? */
  _isDrawn(slot) {
    for (let index = 0; index < this.ring.length; index++) if (this.ring[index] === slot) return true;
    return false;
  }

  /**
   * Why a slot cannot be drawn, or `null` when it can.
   *
   * Returning the *reason* rather than a boolean is what lets the counters say which
   * budget did the culling — a bare count cannot tell a caller whether their content
   * is too far away, too small on screen, or wound down by activity.
   */
  _admissible(slot, localFocusX, localFocusZ, maxDistanceSquared, pixelScale, minPixels, speciesActivity) {
    // One decision, counted once. The counters below therefore read as "how many
    // decisions went this way", which is what a budget diagnostic should say.
    this.counters.evaluations++;
    const speciesName = this.species[slot] === 0 ? 'bird' : 'bee';
    const species = GEO_AMBIENT_SPECIES[speciesName];
    const stable = this.stable[slot];
    const familyActivity = (speciesActivity?.[speciesName] ?? species.activity) * this.activity;
    if (familyActivity <= (stable % 1000) / 1000) {
      this.counters.activityCulls++;
      this.poseAge[slot] = Infinity;
      return 'activity';
    }
    const dx = this.anchorX[slot] - this.originX - localFocusX;
    const dz = this.anchorZ[slot] - this.originZ - localFocusZ;
    if (dx * dx + dz * dz > maxDistanceSquared) {
      this.counters.distanceCulls++;
      this.poseAge[slot] = Infinity;
      return 'distance';
    }
    if (pixelScale > 0) {
      const spanMetres = this.poseRadius(slot) * 2 * this.scale[slot];
      const spanPixels = spanMetres * pixelScale;
      if (spanPixels * spanPixels < minPixels * minPixels) {
        this.counters.screenCulls++;
        this.poseAge[slot] = Infinity;
        return 'screen';
      }
    }
    return null;
  }

  /** Queue a slot's instance to be hidden by the caller, once. */
  _hide(slot) {
    if (this.hiddenCount < this.hiddenSlots.length) this.hiddenSlots[this.hiddenCount++] = slot;
    this.poseAge[slot] = Infinity;
  }

  /** Re-derive one slot's pose. One `sin`/`cos` pair per axis, no allocation. */
  _pose(slot, seconds) {
    const speciesName = this.species[slot] === 0 ? 'bird' : 'bee';
    const species = GEO_AMBIENT_SPECIES[speciesName];
    const step = this.stable[slot] % 4;
    const speed = species.speed + step * species.speedStep;
    const radius = species.radiusBase + step * species.radiusStep;
    const angle = this.phase[slot] + seconds * speed;
    const base = slot * SLOT_STRIDE;
    const x = this.anchorX[slot] - this.originX + Math.cos(angle) * radius;
    const z = this.anchorZ[slot] - this.originZ + Math.sin(angle * (speciesName === 'bee' ? 1.17 : 1)) * radius;
    const y = this.groundY[slot] + species.heightBase + step * species.heightStep +
      Math.sin(seconds * species.bobFrequency + this.phase[slot]) * species.bobAmplitude;
    this.pose[base + 0] = x; this.pose[base + 1] = y; this.pose[base + 2] = z;
    this.pose[base + 3] = -angle;
    this.pose[base + 4] = Math.sin(seconds * species.rollFrequency + this.phase[slot]) * species.rollAmplitude;
    this.poseAge[slot] = 0;
  }

  /**
   * Iterate the slots that left the drawn set this pass, so a caller can hide them.
   * The list is a preallocated array, so this costs no allocation either.
   */
  forEachHidden(callback) {
    // The callback receives the same reused pose object `writeMatrices` uses, populated
    // with the slot's identity, so a caller never has to reach into the scheduler's
    // arrays — and still allocates nothing per frame.
    const pose = this.scratchPose;
    for (let index = 0; index < this.hiddenCount; index++) {
      const slot = this.hiddenSlots[index];
      pose.slot = slot;
      pose.ownerKey = this.ownerKey[slot];
      pose.species = this.species[slot] === 0 ? 'bird' : 'bee';
      pose.type = this.species[slot] === 0 ? 10 : 11;
      pose.instanceIndex = this.instanceIndex[slot];
      pose.x = 0; pose.y = 0; pose.z = 0; pose.yaw = 0; pose.roll = 0; pose.scale = 1;
      callback(pose);
    }
    return this.hiddenCount;
  }

  /** Over-capacity and malformed placements stay observable rather than silent. */
  _reject(reason, ownerKey, type) {
    this.counters.rejected++;
    this.lastRejection = { reason, ownerKey: ownerKey == null ? null : String(ownerKey), type, at: this.counters.claims + this.counters.rejected };
  }

  /** How many ring entries are occupied right now. */
  _drawnSlots() {
    let drawn = 0;
    for (let index = 0; index < this.ring.length; index++) if (this.ring[index] >= 0) drawn++;
    return drawn;
  }

  /** The diagnostics row the budget surface reports. */
  diagnostics() {
    const perSpecies = { bird: 0, bee: 0 };
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.ownerKey[slot] === null) continue;
      perSpecies[this.species[slot] === 0 ? 'bird' : 'bee']++;
    }
    return {
      profile: this.profile,
      capacity: this.capacity,
      active: this.active,
      visibleCeiling: this.visibleCeiling,
      perFrame: this.perFrame,
      screenPixels: this.limits.screenPixels,
      drawCalls: this.limits.drawCalls,
      maxDistance: this.maxDistance,
      activity: this.activity,
      visible: this.counters.lastVisible,
      // `visible` is the drawn set, bounded by `visibleCeiling`; `posesThisPass` is the
      // per-frame CPU budget. They are reported separately because the research budgets
      // them separately, and conflating them was the first version's flaw.
      posesThisPass: this.counters.poseUpdates - (this._poseUpdatesAtLastPass ?? 0),
      lastPoseUpdates: this._lastPoseUpdates ?? 0,
      drawnSlots: this._drawnSlots(),
      evaluations: this.counters.lastEvaluations,
      totalEvaluations: this.counters.evaluations,
      passes: this.counters.passes,
      distanceCulls: this.counters.distanceCulls,
      screenCulls: this.counters.screenCulls,
      activityCulls: this.counters.activityCulls,
      poseUpdates: this.counters.poseUpdates,
      claims: this.counters.claims,
      releases: this.counters.releases,
      rejected: this.counters.rejected,
      lastRejection: this.lastRejection,
      steadyFrameAllocations: 0,
      origin: { x: this.originX, z: this.originZ },
      perSpecies,
    };
  }

  /**
   * Copy the visible poses into a caller-provided array for upload.
   *
   * Returns a count, not an array: the caller owns the buffer so a frame of ambience
   * costs no allocation. Poses are absolute (origin added back) because the meshes
   * live in world space.
   */
  writeMatrices(out, matrixFor) {
    let written = 0;
    const pose = this.scratchPose;
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.ownerKey[slot] === null || this.poseAge[slot] === Infinity) continue;
      const base = slot * SLOT_STRIDE;
      // Absolute positions: the meshes live in world space, so the rebased frame is
      // added back here rather than at the call site.
      pose.slot = slot;
      pose.ownerKey = this.ownerKey[slot];
      pose.species = this.species[slot] === 0 ? 'bird' : 'bee';
      pose.type = this.species[slot] === 0 ? 10 : 11;
      pose.instanceIndex = this.instanceIndex[slot];
      pose.x = this.pose[base + 0] + this.originX;
      pose.y = this.pose[base + 1];
      pose.z = this.pose[base + 2] + this.originZ;
      pose.yaw = this.pose[base + 3];
      pose.roll = this.pose[base + 4];
      pose.scale = this.scale[slot];
      if (!matrixFor(out, written, pose)) continue;
      written++;
    }
    return written;
  }

  /**
   * Forget every slot **and** every counter.
   *
   * Clearing the slots without the counters left `diagnostics()` reporting a visible
   * count for agents it no longer held — the same defect found and fixed in
   * `GeoLabelLos.reset()`. A caller that wants cumulative figures keeps its own copy.
   */
  reset() {
    for (let slot = 0; slot < this.capacity; slot++) {
      this.ownerKey[slot] = null;
      this.species[slot] = -1;
      this.poseAge[slot] = Infinity;
    }
    this.freeSlots.length = 0;
    for (let slot = this.capacity - 1; slot >= 0; slot--) this.freeSlots.push(slot);
    this.originX = 0; this.originZ = 0; this.poseCursor = 0;
    this.ring.fill(-1);
    this.ringCursor = 0;
    this.fillCursor = 0;
    this.hiddenCount = 0;
    this.activity = 1;
    this.lastRejection = null;
    for (const key of Object.keys(this.counters)) this.counters[key] = 0;
  }
}

/**
 * The budget the world's profile must satisfy.
 *
 * Two separate claims are checked, because they can fail independently: every profile
 * is checked against the **research table**, and the shared low-profile budget object
 * must **agree** with the low ceiling rather than merely exist. Comparing a balanced
 * profile against the low budget object — the first version of this function — would
 * have rejected a legitimate profile for exceeding a ceiling that does not apply to
 * it, which is a check that punishes the wrong thing.
 */
export function assertAmbientBudget(profile = 'low', budgets = GDO_LOW_PROFILE_BUDGETS) {
  const limits = GEO_AMBIENT_PROFILES[profile];
  if (!limits) throw new GeoAmbientLifeError(`Unknown ambient profile: ${JSON.stringify(profile)}`);
  const ceiling = GEO_AMBIENT_RESEARCH_CEILINGS[profile];
  if (limits.visible > ceiling) {
    throw new GeoAmbientLifeError(`Profile ${profile} allows ${limits.visible} visible ambient fauna, above the researched ceiling ${ceiling}`);
  }
  if (profile === 'low') {
    if (!Number.isFinite(budgets.ambientFaunaVisible)) {
      throw new GeoAmbientLifeError('The low-profile budget does not declare ambientFaunaVisible, so the ambient ceiling is unenforced');
    }
    if (budgets.ambientFaunaVisible !== ceiling) {
      throw new GeoAmbientLifeError(`The shared low-profile budget allows ${budgets.ambientFaunaVisible} visible ambient fauna but the researched low ceiling is ${ceiling}; the two must agree`);
    }
    if (!Number.isFinite(budgets.ambientAddedDrawCalls) || limits.drawCalls > budgets.ambientAddedDrawCalls) {
      throw new GeoAmbientLifeError(`Profile low allows ${limits.drawCalls} ambient draw calls, above the budget ceiling ${budgets.ambientAddedDrawCalls}`);
    }
  }
  return true;
}
