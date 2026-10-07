/**
 * `GME-06` — discovery journal (visited places).
 *
 * Registered gate (feature-roadmap/README.md order 135):
 *   "Deterministic place IDs and bounded local state"
 *
 * Research (`PROCEDURAL_WORLD_FEATURE_RESEARCH.md` §4.7):
 *   *"Discovery journal | Enter a POI/site/water/place radius to unlock its map-derived
 *   name and type | Immediate purpose for exploration | Very low | P0"*, and the batch
 *   that follows it: *"Add a discovery journal and one reachable local walking route."*
 *
 * WHAT THE TWO CLAUSES OF THE GATE MEAN HERE
 * ------------------------------------------
 * 1. **Deterministic place IDs.** A place's identity is derived from its own name, kind and
 *    a quantised position — never from insertion order, tile iteration order or the order
 *    the player happened to walk past it. Two players, two sessions, a remount or a
 *    streamed-out-and-back tile all produce the same id for the same place, which is what
 *    lets the journal, a save file (`NET-01`) and a route (`GME-08`) refer to a place
 *    without referring to a session. The quantisation is deliberate and documented: the
 *    anchor is reduced to a coarse cell (`GEO_DISCOVERY_CELL_SIZE`, 100 units — larger
 *    than a streaming tile), so a label whose anchor shifts by a centimetre when a tile is
 *    rebuilt does not become a second discovery. A *small* quantum does not achieve that,
 *    which is why the first version of this module — 0.5 units — was wrong: rounding flips
 *    at every bucket edge, and a 0.2-unit shift crossed one in the smoke test. **The id is
 *    a string**, branded with a short hash, because an id that has to survive a save file
 *    must not depend on this module's hash implementation.
 * 2. **Bounded local state.** The journal holds at most `capacity` entries (default 128) in
 *    preallocated storage, evicting deterministically: the place discovered longest ago
 *    leaves first, a place discovered at the same clock reading is ordered by id, and — the
 *    rule that actually makes the retained set canonical — a candidate that is worse than
 *    everything held is **declined** rather than displacing a better place. Nothing here
 *    grows with the size of the world: a player who walks a hundred tiles holds the same
 *    bytes as one who walks two, which is the property that makes a journal safe to keep
 *    resident. `update()` returns only what *entered*, so a resident label set re-offered
 *    every frame cannot announce the same discovery twice.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ----------------------------------------
 * It does not save. Persisting the journal is `NET-01` (versioned local save, deps
 * `FND-06`, `GME-06`, `CNT-01`), and inventing a second storage format here would be the
 * exact duplication the roadmap keeps splitting apart. It also does not present anything:
 * the runtime renders the journal, and `Discoveries` reports what to render.
 */

/**
 * Coarse cell edge, in game units, that a place's id is quantised to.
 *
 * The id must survive a tile being rebuilt: the same street label can come back with its
 * anchor moved by centimetres, and a journal that counted that as a second discovery would
 * be wrong in a way a player notices. A *small* quantum does not achieve that — rounding
 * flips at every bucket edge, so a 0.2-unit shift still changes the id whenever the anchor
 * sits near an edge, which is what a 0.5-unit quantum did when this module was first run.
 * A coarse cell makes the flip probability proportional to displacement/cell, and 100 units
 * is comfortably larger than the whole streaming tile, so a rebuilt anchor in practice
 * cannot cross one. Two same-named places of the same kind in one cell are treated as one
 * place, which is the intended reading: that is the same street, not two streets.
 */
export const GEO_DISCOVERY_CELL_SIZE = 100;

/** Default capacity, and the profile-independent ceiling the gate checks against. */
export const GEO_DISCOVERY_CAPACITY = 128;

/** Kinds the journal recognises, with the radius each unlocks at. */
export const GEO_DISCOVERY_KINDS = Object.freeze({
  street: Object.freeze({ radius: 24, label: 'Street' }),
  water: Object.freeze({ radius: 30, label: 'Water' }),
  neighbourhood: Object.freeze({ radius: 40, label: 'Area' }),
  landmark: Object.freeze({ radius: 34, label: 'Landmark' }),
  settlement: Object.freeze({ radius: 46, label: 'Settlement' }),
  // The coordinate runtime's own label groups (`GeoTileContext.LABEL_LAYERS`): a POI is a
  // nearer, smaller thing than a settlement, so it unlocks closer.
  poi: Object.freeze({ radius: 26, label: 'Point of interest' }),
  place: Object.freeze({ radius: 40, label: 'Place' }),
  default: Object.freeze({ radius: 32, label: 'Place' }),
});

/**
 * The largest unlock radius any kind declares.
 *
 * The runtime uses this to gather *resident* labels near the player rather than the labels
 * the HUD happens to be showing. That distinction is the whole reason this constant is
 * exported: the label layer displays at most 14 names chosen by static map priority, so a
 * journal fed from the displayed set would leave a place undiscoverable whenever fourteen
 * higher-priority names were on screen — which is exactly what the browser gate caught as a
 * flake in its second session. Discovery is a radius test, not a HUD test.
 *
 * Declared **after** `GEO_DISCOVERY_KINDS`: this is a module-level computation over that
 * object, and placing it before it threw a TDZ `ReferenceError` at import time, which took
 * the whole coordinate runtime down rather than just the journal.
 */
export const GEO_DISCOVERY_MAX_RADIUS = Math.max(
  ...Object.values(GEO_DISCOVERY_KINDS).map(kind => kind.radius),
);

function fnv1a(text, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The deterministic id for a place.
 *
 * Built from the kind, the case-folded name and the quantised anchor, in that order, so the
 * same place yields the same string wherever and whenever it is seen. Names are folded
 * because map providers disagree about case between tiles for the same street, and a
 * journal that holds "Sardar Patel Marg" and "sardar patel marg" as two places is wrong in
 * a way a player would notice.
 */
export function discoveryPlaceId(name, kind, x, z) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('A discovery place needs a non-empty name');
  if (typeof kind !== 'string' || !kind.trim()) throw new TypeError('A discovery place needs a non-empty kind');
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new TypeError('A discovery place needs finite coordinates');
  const folded = name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const cellX = Math.floor(x / GEO_DISCOVERY_CELL_SIZE);
  const cellZ = Math.floor(z / GEO_DISCOVERY_CELL_SIZE);
  const hash = fnv1a(`${folded}|${kind.toLocaleLowerCase()}|${cellX}|${cellZ}`);
  return `${kind.toLocaleLowerCase()}:${folded.replace(/[^a-z0-9]+/g, '-').slice(0, 32)}:${hash.toString(16).padStart(8, '0')}`;
}

/** The radius a kind unlocks at, and its display label. */
export function discoveryKind(kind) {
  return GEO_DISCOVERY_KINDS[kind] ?? GEO_DISCOVERY_KINDS.default;
}

/**
 * One journal entry as the runtime reads it. Reused between calls — copy what you keep.
 */
export function createDiscoveryEntry() {
  return { id: '', name: '', kind: '', kindLabel: '', x: 0, z: 0, radius: 0, discoveredAt: 0, distance: 0 };
}

export class DiscoveryJournal {
  /**
   * @param {object} [options]
   * @param {number} [options.capacity] maximum entries held; bounded local state
   * @param {number} [options.clock] discovery clock; entries carry the reading they were
   *   discovered at, and equal readings are ordered by id so the journal is deterministic
   */
  constructor({ capacity = GEO_DISCOVERY_CAPACITY, clock = 0 } = {}) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`Discovery journal capacity must be a positive integer, received ${capacity}`);
    }
    if (!Number.isFinite(clock) || clock < 0) {
      throw new RangeError(`Discovery journal clock must be finite and non-negative, received ${clock}`);
    }
    this.capacity = capacity;
    /** id → ordinal of its slot, so a lookup never scans. */
    this.index = new Map();
    // Preallocated storage: a player who crosses the whole map holds the same arrays.
    this.ids = new Array(capacity).fill(null);
    this.names = new Array(capacity).fill(null);
    this.kinds = new Array(capacity).fill(null);
    this.positions = new Float64Array(capacity * 2);
    this.radii = new Float32Array(capacity);
    this.discovered = new Float64Array(capacity);
    this.free = [];
    for (let slot = capacity - 1; slot >= 0; slot--) this.free.push(slot);
    this.clock = clock;
    this.entry = createDiscoveryEntry();
    this.counters = { considered: 0, discovered: 0, restored: 0, rediscovered: 0, evicted: 0, declined: 0, rejected: 0, updates: 0 };
    this.lastDiscovery = null;
    this.lastRejection = null;
  }

  get size() { return this.index.size; }

  /**
   * Offer a place to the journal.
   *
   * Returns `true` the first time a place is recorded. A place already held is *not* a
   * discovery again: §4.7's journal is about what has been seen, and counting a street the
   * player walked up and down as five discoveries would make the count meaningless.
   */
  consider(place) {
    this.counters.considered++;
    let id;
    try {
      id = discoveryPlaceId(place?.name, place?.kind, place?.x, place?.z);
    } catch (error) {
      this.counters.rejected++;
      this.lastRejection = { reason: error.message, name: place?.name ?? null, kind: place?.kind ?? null };
      return false;
    }
    const existing = this.index.get(id);
    if (existing !== undefined) {
      this.counters.rediscovered++;
      return false;
    }
    let slot;
    if (this.free.length) slot = this.free.pop();
    else {
      // Full. Find the worst entry held: the earliest discovery, and when two entries were
      // discovered at the same reading, the *larger* id. The candidate joins only if it
      // beats that worst entry; otherwise it is discovered and evicted in the same pass,
      // which is counted rather than hidden.
      //
      // The first version of this module displaced the worst entry *unconditionally*, and
      // with equal clock readings that made the survivors the places that arrived last — a
      // function of walk order, which the Node gate caught (`tie-3` surviving one direction
      // and `tie-0` the other). What fixes it is the comparison below: a candidate that is
      // worse than everything held is declined rather than stored, so the retained set is
      // the best `capacity` places *seen so far* and converges on the same set however they
      // arrived. The id tie-break direction then only decides which way "best" runs; the
      // canonical-set property holds either way, and the browser gate re-checks it over the
      // real corpus in both orders.
      let worst = -1, worstAt = -Infinity, worstId = '';
      for (let held = 0; held < this.capacity; held++) {
        if (this.ids[held] === null) continue;
        const at = this.discovered[held];
        if (at > worstAt || (at === worstAt && this.ids[held] > worstId)) {
          worst = held; worstAt = at; worstId = this.ids[held];
        }
      }
      if (worst < 0) throw new Error('Discovery journal is full but holds nothing');
      // Clocks only move forwards, so `this.clock >= worstAt`; the general form is kept so
      // that a caller who relaxes monotonicity still gets the same rule.
      if (this.clock < worstAt || (this.clock === worstAt && id > worstId)) {
        // The journal is full of better places and this one is worse than all of them. It is
        // *declined*, not discovered: a place that cannot be held was never journalled, and
        // counting it as a discovery would make the journal announce the same unreachable
        // place on every pass — the runtime feeds the same resident candidates every frame.
        // This keeps the retained set equal to the best `capacity` places seen so far, which
        // is the property that makes a re-offered crowd quiet on the second pass.
        this.counters.declined++;
        return false;
      }
      // `_release` returns the slot to the free list; eviction must take it straight back
      // out again, or the next discovery claims a slot that is still in use — the second
      // defect the first run of this module found (a journal of size 5 at capacity 4).
      this._release(worst);
      this.free.pop();
      this.counters.evicted++;
      slot = worst;
    }
    const kind = discoveryKind(place.kind);
    this.ids[slot] = id;
    this.names[slot] = String(place.name).trim().replace(/\s+/g, ' ');
    this.kinds[slot] = String(place.kind).toLocaleLowerCase();
    this.positions[slot * 2] = place.x;
    this.positions[slot * 2 + 1] = place.z;
    this.radii[slot] = Number.isFinite(place.radius) ? place.radius : kind.radius;
    this.discovered[slot] = this.clock;
    this.index.set(id, slot);
    this.counters.discovered++;
    this.lastDiscovery = { id, name: this.names[slot], kind: this.kinds[slot], x: place.x, z: place.z, at: this.discovered[slot] };
    return true;
  }

  /**
   * Put an entry back, from a save file (`NET-01`).
   *
   * Not `consider()`: a restored entry was discovered in an *earlier session*, so it arrives
   * with its reading already taken and without a radius test — the player is not standing
   * there any more. The id is checked against the place it names, because this is the one path
   * by which an entry can enter the journal without the runtime having derived it, and a
   * journal that holds a place the world could not produce is worse than one that holds
   * nothing. Returns whether the entry was restored.
   */
  restore(entry) {
    let id;
    try {
      id = discoveryPlaceId(entry?.name, entry?.kind, entry?.x, entry?.z);
    } catch (error) {
      this.counters.rejected++;
      this.lastRejection = { reason: error.message, name: entry?.name ?? null, kind: entry?.kind ?? null };
      return false;
    }
    if (entry?.id !== undefined && entry.id !== null && entry.id !== id) {
      this.counters.rejected++;
      this.lastRejection = { reason: `${JSON.stringify(entry.id)} is not the id of its own place`, name: entry.name, kind: entry.kind };
      return false;
    }
    if (this.index.has(id)) {
      // Already held: a save that names a place twice, or a restore that runs twice, is one
      // entry. Counted as a rediscovery so the caller can see it happened.
      this.counters.rediscovered++;
      return false;
    }
    let slot;
    if (this.free.length) slot = this.free.pop();
    else {
      // The journal is full. A restore does not displace: the retained set is chosen by the
      // clock (the worst entry is the earliest discovery), and a restored entry may carry an
      // *older* reading than everything held, so displacing on restore could evict a place the
      // player found this session in favour of one they found last week.
      this.counters.declined++;
      return false;
    }
    const kind = discoveryKind(entry.kind);
    this.ids[slot] = id;
    this.names[slot] = String(entry.name).trim().replace(/\s+/g, ' ');
    this.kinds[slot] = String(entry.kind).toLocaleLowerCase();
    this.positions[slot * 2] = entry.x;
    this.positions[slot * 2 + 1] = entry.z;
    this.radii[slot] = Number.isFinite(entry.radius) ? entry.radius : kind.radius;
    this.discovered[slot] = Number.isFinite(entry.discoveredAt) ? entry.discoveredAt : this.clock;
    this.index.set(id, slot);
    this.counters.restored++;
    // The journal's own clock is **not** moved by a restore. It is the live session's reading and
    // `update()` compares against it, so a stored reading from an earlier page load (which
    // restarted its own clock at zero) must not push it forward — that would make the next frame
    // look like a backwards clock, which `update()` refuses by design. A caller restoring stored
    // readings is responsible for placing them in the live clock's frame; `NET-01`'s
    // `restoreDiscovery` rebases the whole section just above `this.clock`, preserving the order
    // the save recorded.
    return true;
  }

  _release(slot) {
    const id = this.ids[slot];
    if (id !== null) this.index.delete(id);
    this.ids[slot] = null;
    this.names[slot] = null;
    this.kinds[slot] = null;
    this.free.push(slot);
  }

  /**
   * Advance the clock and discover any *candidate* place the player is standing inside.
   *
   * The candidate list is supplied by the caller — the runtime passes the places whose
   * tiles are resident — so the per-frame work is bounded by what is on screen rather than
   * by the size of the world. Returns the number of places that *entered* the journal this
   * pass, which is what a HUD should announce; a candidate the full journal declines is not
   * a discovery and is not returned, so an unreachable place cannot be announced twice.
   *
   * Invariant, checked by the Node gate: `discovered + restored - evicted === size`. The
   * `restored` term arrived with `NET-01`: before a save file existed, every entry in a
   * journal had been discovered by this session, and now some of them were read back from
   * storage. The gate's own run has no save to read, so its form of the identity is unchanged;
   * this comment states the general one so the next reader is not surprised by it.
   */
  update(position, candidates, { now = null } = {}) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) {
      throw new TypeError('Discovery journal update needs a finite position');
    }
    if (now !== null) {
      if (!Number.isFinite(now) || now < this.clock) {
        throw new RangeError(`Discovery journal clock must advance monotonically, received ${now} after ${this.clock}`);
      }
      this.clock = now;
    }
    this.counters.updates++;
    if (!Array.isArray(candidates) || !candidates.length) return 0;
    let found = 0;
    for (const place of candidates) {
      if (!place) continue;
      const radius = Number.isFinite(place.radius) ? place.radius : discoveryKind(place.kind).radius;
      const dx = place.x - position.x, dz = place.z - position.z;
      // Inclusive: standing exactly on the boundary counts as arriving, which is the
      // behaviour a player expects from "within the radius".
      if (dx * dx + dz * dz > radius * radius) continue;
      if (this.consider(place)) found++;
    }
    return found;
  }

  /**
   * Look up an entry by id, or by name and kind. Returns the reused entry or `null`.
   *
   * The name+kind form scans, because a name and a kind alone cannot rebuild the id without
   * the anchor the id is quantised from. It exists for the HUD, which holds a rendered name
   * rather than an id; the id form is a map lookup and is what `NET-01` should persist.
   */
  find({ id = null, name = null, kind = null } = {}) {
    let slot;
    if (id !== null) slot = this.index.get(id);
    else if (name !== null && kind !== null) {
      const wanted = String(name).trim().toLocaleLowerCase();
      const wantedKind = String(kind).toLocaleLowerCase();
      slot = undefined;
      for (let candidate = 0; candidate < this.capacity; candidate++) {
        if (this.names[candidate] !== null && this.names[candidate].toLocaleLowerCase() === wanted &&
          this.kinds[candidate] === wantedKind) { slot = candidate; break; }
      }
    } else return null;
    if (slot === undefined) return null;
    const entry = this.entry;
    entry.id = this.ids[slot];
    entry.name = this.names[slot];
    entry.kind = this.kinds[slot];
    entry.kindLabel = discoveryKind(this.kinds[slot]).label;
    entry.x = this.positions[slot * 2];
    entry.z = this.positions[slot * 2 + 1];
    entry.radius = this.radii[slot];
    entry.discoveredAt = this.discovered[slot];
    entry.distance = 0;
    return entry;
  }

  has(id) { return this.index.has(id); }

  /**
   * Every entry, oldest discovery first, into a caller-supplied array.
   *
   * The array is the caller's, so a HUD that rebuilds its list each second allocates one
   * array a second rather than one entry per place per frame.
   */
  list(out = []) {
    out.length = 0;
    const order = [];
    for (let slot = 0; slot < this.capacity; slot++) if (this.ids[slot] !== null) order.push(slot);
    order.sort((first, second) => this.discovered[first] - this.discovered[second] || (this.ids[first] < this.ids[second] ? -1 : 1));
    for (const slot of order) {
      out.push({
        id: this.ids[slot], name: this.names[slot], kind: this.kinds[slot],
        kindLabel: discoveryKind(this.kinds[slot]).label,
        x: this.positions[slot * 2], z: this.positions[slot * 2 + 1],
        discoveredAt: this.discovered[slot],
      });
    }
    return out;
  }

  diagnostics() {
    return {
      capacity: this.capacity,
      size: this.size,
      clock: this.clock,
      discoveries: this.counters.discovered,
      restored: this.counters.restored,
      rediscovered: this.counters.rediscovered,
      evicted: this.counters.evicted,
      declined: this.counters.declined,
      rejected: this.counters.rejected,
      considered: this.counters.considered,
      updates: this.counters.updates,
      lastDiscovery: this.lastDiscovery ? { ...this.lastDiscovery } : null,
      lastRejection: this.lastRejection ? { ...this.lastRejection } : null,
      bytes: this.ids.length * 8 + this.names.length * 8 + this.kinds.length * 8 +
        this.positions.byteLength + this.radii.byteLength + this.discovered.byteLength,
    };
  }

  /** Clear the journal and its counters together — one without the other lies. */
  reset() {
    for (let slot = 0; slot < this.capacity; slot++) if (this.ids[slot] !== null) this._release(slot);
    this.index.clear();
    this.free.length = 0;
    for (let slot = this.capacity - 1; slot >= 0; slot--) this.free.push(slot);
    this.clock = 0;
    this.counters = { considered: 0, discovered: 0, restored: 0, rediscovered: 0, evicted: 0, declined: 0, rejected: 0, updates: 0 };
    this.lastDiscovery = null;
    this.lastRejection = null;
    return this.diagnostics();
  }
}
