/**
 * Capped dynamic spatial hash — `COL-09`.
 *
 * The static world already has a 4-unit hashed grid of exact tile footprints
 * (`buildCollisionGrid`) whose AABBs are broad-phase proxies and whose packed
 * rings are authoritative. That grid is rebuilt with the tile and never moves.
 * Anything that moves needs a second, deliberately smaller structure beside it:
 *
 *   "Small spatial hash for moving vehicles, train cars, boats if solid, moving
 *    platforms, and future local agents. Primitive proxies only: circle/capsule
 *    in XZ plus Y span, AABB/OBB, or short compound list. Reinsert only after a
 *    proxy crosses a cell boundary. Hard cap: 64 low, 128 balanced, 256 desktop
 *    active dynamic proxies. No dynamic body per decorative box."
 *     — CLIPPING_AND_LAYERING_RESEARCH.md §5.1
 *
 * Four properties are enforced here rather than documented as intentions:
 *
 * **Primitive-only.** A proxy must be one of four shapes — circle, capsule,
 * AABB, OBB — each carrying an XZ footprint and an explicit finite Y span. There
 * is no path that accepts an arbitrary object, a mesh, or a per-decorative-box
 * body: `resolveShape()` rejects anything else by name, and every shape validates
 * its own numbers. A compound is a *short list of those same primitives*, capped
 * at `GEO_DYNAMIC_COMPOUND_MAX`; it is not a nested graph.
 *
 * **Hard profile caps.** `64 / 128 / 256` for `low / balanced / high` (the
 * research's "desktop" tier is this project's `high` preset in `Quality.js`).
 * Exceeding the cap throws `GeoDynamicProxyCapError` naming the cap, the profile
 * and the owner — it never evicts and never silently drops. Dropping a solid is
 * the one failure mode that cannot be tolerated here: the player would walk
 * through a moving vehicle and the bug would look like a physics mystery.
 *
 * **Reinsert only on a cell boundary crossing.** Each slot caches the integer
 * cell range it is bucketed into; `update()` re-buckets only when that range
 * changes, so a proxy sliding within its cell costs one bounds recomputation and
 * nothing else. `diagnostics.reinserts` counts the crossings, which is what makes
 * the rule testable rather than merely claimed.
 *
 * **Sweeps reuse the shared collision math.** Circle/capsule/box sweeps call the
 * same exported primitives the static path uses (`sweepPointAgainstSegmentCapsule`,
 * `sweepPointAgainstAabb`), with an expanded shape for the moving radius, so there
 * is exactly one implementation of the quadratic solve and the normal convention.
 * An OBB is the same AABB test performed in the box's rotated local frame.
 *
 * Runtime shape, not a rigid-body world: proxies are queried by the movement and
 * camera layers and merged with static candidates. They carry no mass, impulse,
 * friction, damping or solver state — see MINIMAL_PHYSICS_RESEARCH §4.1, where
 * only the optional later items need those.
 */
import {
  GEO_QUERY_MASK,
  circleAabbPenetration,
  sweepPointAgainstAabb,
  sweepPointAgainstSegmentCapsule,
} from './GeoCollision.js';

/**
 * Cell size, in world units. Deliberately equal to the static lattice
 * (`GEO_STREAMING_LIMITS.collisionCellSize`) so both worlds bucket on one grid
 * definition; a test asserts they stay equal so they cannot drift apart. It is
 * declared here rather than imported to keep the dependency one-directional
 * (GeoWorld imports this module, and a return import would create a cycle).
 */
export const GEO_DYNAMIC_CELL_SIZE = 4;

/** A proxy spanning more cells than this is rejected as unhashable. */
export const GEO_DYNAMIC_CELL_SPAN_MAX = 64;

/** Maximum primitives in one compound proxy. A compound is a short list, not a graph. */
export const GEO_DYNAMIC_COMPOUND_MAX = 4;

/** Hard caps: the research's 64 / 128 / 256 tiers. */
export const GEO_DYNAMIC_PROXY_CAPS = Object.freeze({ low: 64, balanced: 128, high: 256 });

/** Profile used when a caller does not name one. Both runtimes are low-power today. */
export const GEO_DYNAMIC_PROXY_DEFAULT_PROFILE = 'low';

export const GEO_DYNAMIC_PRIMITIVE = Object.freeze({
  CIRCLE: 1,
  CAPSULE: 2,
  BOX: 3,
  ORIENTED_BOX: 4,
});

const SHAPE_BY_NAME = new Map([
  ['circle', GEO_DYNAMIC_PRIMITIVE.CIRCLE],
  ['capsule', GEO_DYNAMIC_PRIMITIVE.CAPSULE],
  ['box', GEO_DYNAMIC_PRIMITIVE.BOX],
  ['aabb', GEO_DYNAMIC_PRIMITIVE.BOX],
  ['obb', GEO_DYNAMIC_PRIMITIVE.ORIENTED_BOX],
  ['oriented-box', GEO_DYNAMIC_PRIMITIVE.ORIENTED_BOX],
  ['orientedbox', GEO_DYNAMIC_PRIMITIVE.ORIENTED_BOX],
]);

const SHAPE_NAME = Object.freeze({
  [GEO_DYNAMIC_PRIMITIVE.CIRCLE]: 'circle',
  [GEO_DYNAMIC_PRIMITIVE.CAPSULE]: 'capsule',
  [GEO_DYNAMIC_PRIMITIVE.BOX]: 'box',
  [GEO_DYNAMIC_PRIMITIVE.ORIENTED_BOX]: 'oriented-box',
});

/**
 * Slot layout. One `Float64Array` holds every proxy's numbers so a hot update
 * never allocates: six payload floats whose meaning depends on the shape, the two
 * Y-span bounds, then the cached XZ bounds used for bucketing and the broad phase.
 *
 *   circle        payload = [x, z, radius, 0, 0, 0]
 *   capsule       payload = [x1, z1, x2, z2, radius, 0]
 *   box           payload = [minX, minZ, maxX, maxZ, 0, 0]
 *   oriented-box  payload = [x, z, halfX, halfZ, yaw, 0]
 */
const F0 = 0, F1 = 1, F2 = 2, F3 = 3, F4 = 4, F5 = 5;
const Y0 = 6, Y1 = 7, MIN_X = 8, MIN_Z = 9, MAX_X = 10, MAX_Z = 11;
const STRIDE = 12;

export class GeoDynamicProxyError extends Error {
  constructor(message) { super(message); this.name = 'GeoDynamicProxyError'; }
}

/** Thrown when a runtime profile's active-proxy cap is already saturated. */
export class GeoDynamicProxyCapError extends GeoDynamicProxyError {
  constructor({ profile, cap, active, ownerKey }) {
    super(`Dynamic proxy cap reached: profile "${profile}" allows ${cap} active primitives ` +
      `(${active} held). Refusing to add "${ownerKey}" — an evicted solid would let the ` +
      'player walk through a moving obstacle. Remove or rehome a proxy first.');
    this.name = 'GeoDynamicProxyCapError';
    this.profile = profile;
    this.cap = cap;
    this.active = active;
    this.ownerKey = ownerKey;
  }
}

/** Thrown when a proxy is not one of the four admitted primitives, or is malformed. */
export class GeoDynamicProxyShapeError extends GeoDynamicProxyError {
  constructor(message) { super(message); this.name = 'GeoDynamicProxyShapeError'; }
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new GeoDynamicProxyShapeError(`${label} must be a finite number, received ${String(value)}`);
  return value;
}

function positive(value, label) {
  finite(value, label);
  if (value <= 0) throw new GeoDynamicProxyShapeError(`${label} must be greater than zero, received ${String(value)}`);
  return value;
}

function resolveShape(value) {
  if (Number.isInteger(value) && SHAPE_NAME[value]) return value;
  if (typeof value === 'string') {
    const shape = SHAPE_BY_NAME.get(value.trim().toLowerCase());
    if (shape) return shape;
  }
  const printable = typeof value === 'object' && value !== null ? value.constructor?.name ?? 'object' : String(value);
  throw new GeoDynamicProxyShapeError(
    `Dynamic proxies admit primitives only (circle, capsule, box, obb) — received "${printable}". ` +
    'Meshes, rendered objects, and per-decorative-box bodies are not dynamic proxies.',
  );
}

function normalizeOwnerKey(value) {
  if (typeof value === 'string' && value.length) return value;
  if (Number.isFinite(value)) return String(value);
  return 'anonymous';
}

/**
 * Reads a primitive spec into the slot payload, validating and normalizing.
 * Returns the normalized fields plus the cached XZ bounds.
 */
function normalizePrimitive(spec, shape) {
  const y0 = finite(spec.y0, 'y0');
  const y1 = finite(spec.y1, 'y1');
  if (!(y1 > y0)) {
    throw new GeoDynamicProxyShapeError(
      `Dynamic proxies need a non-empty Y span: y1 (${y1}) must exceed y0 (${y0}). ` +
      'An unbounded dynamic solid would block the camera and line-of-sight at every height.',
    );
  }

  if (shape === GEO_DYNAMIC_PRIMITIVE.CIRCLE) {
    const x = finite(spec.x, 'x');
    const z = finite(spec.z, 'z');
    const radius = positive(spec.radius, 'radius');
    return {
      payload: [x, z, radius, 0, 0, 0], y0, y1,
      minX: x - radius, minZ: z - radius, maxX: x + radius, maxZ: z + radius,
    };
  }

  if (shape === GEO_DYNAMIC_PRIMITIVE.CAPSULE) {
    const x1 = finite(spec.x1, 'x1');
    const z1 = finite(spec.z1, 'z1');
    const x2 = finite(spec.x2, 'x2');
    const z2 = finite(spec.z2, 'z2');
    const radius = positive(spec.radius, 'radius');
    return {
      payload: [x1, z1, x2, z2, radius, 0], y0, y1,
      minX: Math.min(x1, x2) - radius, minZ: Math.min(z1, z2) - radius,
      maxX: Math.max(x1, x2) + radius, maxZ: Math.max(z1, z2) + radius,
    };
  }

  if (shape === GEO_DYNAMIC_PRIMITIVE.BOX) {
    const minX = finite(spec.minX, 'minX');
    const minZ = finite(spec.minZ, 'minZ');
    const maxX = finite(spec.maxX, 'maxX');
    const maxZ = finite(spec.maxZ, 'maxZ');
    if (!(maxX > minX) || !(maxZ > minZ)) {
      throw new GeoDynamicProxyShapeError(
        `Box proxies need a non-degenerate footprint: received X ${minX}..${maxX}, Z ${minZ}..${maxZ}`,
      );
    }
    return { payload: [minX, minZ, maxX, maxZ, 0, 0], y0, y1, minX, minZ, maxX, maxZ };
  }

  const x = finite(spec.x, 'x');
  const z = finite(spec.z, 'z');
  const halfX = positive(spec.halfX, 'halfX');
  const halfZ = positive(spec.halfZ, 'halfZ');
  const yaw = finite(spec.yaw ?? 0, 'yaw');
  const cos = Math.abs(Math.cos(yaw)), sin = Math.abs(Math.sin(yaw));
  const extentX = cos * halfX + sin * halfZ;
  const extentZ = sin * halfX + cos * halfZ;
  return {
    payload: [x, z, halfX, halfZ, yaw, 0], y0, y1,
    minX: x - extentX, minZ: z - extentZ, maxX: x + extentX, maxZ: z + extentZ,
  };
}

/**
 * Capped dynamic proxy hash.
 *
 * All storage is preallocated to the profile cap, so `update()`, `collect()` and
 * the exact tests allocate nothing; only `add()` and `remove()` touch the handle
 * map, and neither runs in a steady frame.
 */
export class GeoDynamicProxyHash {
  constructor({ profile = GEO_DYNAMIC_PROXY_DEFAULT_PROFILE, cap } = {}) {
    const resolvedProfile = profile in GEO_DYNAMIC_PROXY_CAPS ? profile : null;
    if (!resolvedProfile && !Number.isInteger(cap)) {
      throw new RangeError(`Unknown dynamic proxy profile: ${profile} (expected one of ${Object.keys(GEO_DYNAMIC_PROXY_CAPS).join(', ')}, or an explicit integer cap)`);
    }
    if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) {
      throw new RangeError(`Dynamic proxy cap must be a positive integer, received ${String(cap)}`);
    }
    this.profile = resolvedProfile ?? 'custom';
    this.cap = cap ?? GEO_DYNAMIC_PROXY_CAPS[resolvedProfile];

    this._values = new Float64Array(this.cap * STRIDE);
    this._shape = new Uint8Array(this.cap);
    this._mask = new Uint32Array(this.cap);
    this._handle = new Uint32Array(this.cap);
    this._alive = new Uint8Array(this.cap);
    this._cells = new Int32Array(this.cap * 4);
    this._owners = new Array(this.cap).fill(null);
    this._slotOf = new Map();
    this._free = [];
    this._buckets = new Map();
    this._ownerCounts = new Map();
    this._candidates = new Int32Array(this.cap);
    this._stamp = new Int32Array(this.cap);
    this._stampCounter = 0;
    this._candidateCount = 0;
    this._liveCount = 0;
    this._nextHandle = 1;
    this._nextSlot = 0;
    this._disposed = false;

    this._counters = {
      inserts: 0, reinserts: 0, updates: 0, removals: 0, capRejects: 0, shapeRejects: 0,
      queries: 0, candidates: 0, maxCandidates: 0, exactTests: 0, hits: 0,
    };
    this._sweepCandidate = {};
    this._exactHit = { overlap: false, depth: 0, normalX: 0, normalZ: 0 };
  }

  get activeCount() { return this._liveCount; }
  get ownerCount() { return this._ownerCounts.size; }
  get cellCount() { return this._buckets.size; }

  /** Bytes held by the structure itself — typed storage plus the player-facing arrays. */
  get bytes() {
    return this._values.byteLength + this._shape.byteLength + this._mask.byteLength +
      this._handle.byteLength + this._alive.byteLength + this._cells.byteLength +
      this._candidates.byteLength + this._stamp.byteLength;
  }

  get diagnostics() {
    const counters = this._counters;
    return Object.freeze({
      profile: this.profile,
      cap: this.cap,
      active: this._liveCount,
      owners: this._ownerCounts.size,
      cells: this._buckets.size,
      free: this._free.length,
      bytes: this.bytes,
      inserts: counters.inserts,
      reinserts: counters.reinserts,
      updates: counters.updates,
      removals: counters.removals,
      capRejects: counters.capRejects,
      shapeRejects: counters.shapeRejects,
      queries: counters.queries,
      candidates: counters.candidates,
      maxCandidates: counters.maxCandidates,
      exactTests: counters.exactTests,
      hits: counters.hits,
    });
  }

  /**
   * Adds one primitive. Throws `GeoDynamicProxyShapeError` for anything that is
   * not an admitted primitive and `GeoDynamicProxyCapError` at the profile cap.
   */
  add(spec = {}) {
    if (this._disposed) throw new GeoDynamicProxyError('Dynamic proxy hash is disposed');
    if (this._liveCount >= this.cap) {
      this._counters.capRejects++;
      throw new GeoDynamicProxyCapError({
        profile: this.profile, cap: this.cap, active: this._liveCount,
        ownerKey: normalizeOwnerKey(spec.ownerKey ?? spec.owner),
      });
    }
    let shape;
    try {
      shape = resolveShape(spec.shape);
    } catch (error) {
      this._counters.shapeRejects++;
      throw error;
    }
    let normalized;
    try {
      normalized = normalizePrimitive(spec, shape);
    } catch (error) {
      this._counters.shapeRejects++;
      throw error;
    }

    const cellRange = this._cellRange(normalized);
    const span = (cellRange[2] - cellRange[0] + 1) * (cellRange[3] - cellRange[1] + 1);
    if (span > GEO_DYNAMIC_CELL_SPAN_MAX) {
      this._counters.shapeRejects++;
      throw new GeoDynamicProxyShapeError(
        `Dynamic proxy spans ${span} cells, over the ${GEO_DYNAMIC_CELL_SPAN_MAX}-cell limit ` +
        `(bounds ${normalized.minX.toFixed(2)}..${normalized.maxX.toFixed(2)} x ` +
        `${normalized.minZ.toFixed(2)}..${normalized.maxZ.toFixed(2)}). Split it into a compound of ` +
        'smaller primitives so it stays hashable.',
      );
    }

    const ownerKey = normalizeOwnerKey(spec.ownerKey ?? spec.owner);
    const slot = this._free.length ? this._free.pop() : (this._nextSlot < this.cap ? this._nextSlot++ : -1);
    if (slot < 0) {
      // Defensive: `_liveCount` and the free list disagree, which means a bug here
      // rather than a caller error. Fail loudly instead of corrupting a slot.
      throw new GeoDynamicProxyError('Dynamic proxy storage is exhausted but the live count is below the cap');
    }
    const handle = this._nextHandle++;
    this._writeSlot(slot, handle, shape, spec.mask, normalized, ownerKey);
    this._bucketSlot(slot, normalized, cellRange);
    this._liveCount++;
    this._counters.inserts++;
    this._ownerCounts.set(ownerKey, (this._ownerCounts.get(ownerKey) ?? 0) + 1);
    return handle;
  }

  /**
   * Adds a short list of primitives as one owner. All-or-nothing: every primitive
   * is validated and checked against the cap before any is written, so a rejected
   * compound cannot leave a half-placed solid behind.
   */
  addCompound(spec = {}, primitives = []) {
    if (!Array.isArray(primitives) || primitives.length === 0) {
      throw new GeoDynamicProxyShapeError('A compound needs at least one primitive');
    }
    if (primitives.length > GEO_DYNAMIC_COMPOUND_MAX) {
      throw new GeoDynamicProxyShapeError(
        `A compound holds at most ${GEO_DYNAMIC_COMPOUND_MAX} primitives, received ${primitives.length}. ` +
        'A compound is a short list, not a nested graph.',
      );
    }
    if (this._liveCount + primitives.length > this.cap) {
      this._counters.capRejects++;
      throw new GeoDynamicProxyCapError({
        profile: this.profile, cap: this.cap, active: this._liveCount,
        ownerKey: normalizeOwnerKey(spec.ownerKey ?? spec.owner),
      });
    }
    const ownerKey = normalizeOwnerKey(spec.ownerKey ?? spec.owner);
    const mask = Number.isFinite(spec.mask) ? spec.mask | 0 : GEO_QUERY_MASK.SOLID_PLAYER;
    // Validate everything first: the cap and shape checks must both pass before
    // the first write, or a bad compound could leave part of itself placed.
    const prepared = primitives.map(primitive => {
      const shape = resolveShape(primitive?.shape);
      // Y span may be declared once on the compound or per primitive.
      const merged = { ...primitive, y0: primitive?.y0 ?? spec.y0, y1: primitive?.y1 ?? spec.y1 };
      normalizePrimitive(merged, shape);
      return { shape, spec: merged };
    });
    return prepared.map(item => this.add({ ownerKey, mask, ...item.spec, shape: item.shape }));
  }

  /**
   * Moves or re-tags an existing proxy. Re-buckets only when the proxy's cell
   * range changed; `diagnostics.reinserts` counts exactly those crossings.
   */
  update(handle, patch = {}) {
    const slot = this._slotOf.get(handle);
    if (slot === undefined) return false;
    const shape = this._shape[slot];
    const current = this._readPrimitive(slot, shape);
    const next = { ...current, y0: this._values[slot * STRIDE + Y0], y1: this._values[slot * STRIDE + Y1] };
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'ownerKey' || key === 'owner' || key === 'shape' || key === 'mask') continue;
      next[key] = value;
    }
    const normalized = normalizePrimitive(next, shape);
    if (patch.mask !== undefined) this._mask[slot] = patch.mask | 0;
    if (patch.ownerKey !== undefined || patch.owner !== undefined) {
      const previousOwner = this._owners[slot];
      const nextOwner = normalizeOwnerKey(patch.ownerKey ?? patch.owner);
      if (nextOwner !== previousOwner) {
        const remaining = (this._ownerCounts.get(previousOwner) ?? 1) - 1;
        if (remaining > 0) this._ownerCounts.set(previousOwner, remaining);
        else this._ownerCounts.delete(previousOwner);
        this._ownerCounts.set(nextOwner, (this._ownerCounts.get(nextOwner) ?? 0) + 1);
        this._owners[slot] = nextOwner;
      }
    }

    const cellRange = this._cellRange(normalized);
    const base = slot * 4;
    const changed = this._cells[base] !== cellRange[0] || this._cells[base + 1] !== cellRange[1] ||
      this._cells[base + 2] !== cellRange[2] || this._cells[base + 3] !== cellRange[3];
    this._values[slot * STRIDE + MIN_X] = normalized.minX;
    this._values[slot * STRIDE + MIN_Z] = normalized.minZ;
    this._values[slot * STRIDE + MAX_X] = normalized.maxX;
    this._values[slot * STRIDE + MAX_Z] = normalized.maxZ;
    for (let index = 0; index < 6; index++) this._values[slot * STRIDE + index] = normalized.payload[index];
    this._values[slot * STRIDE + Y0] = normalized.y0;
    this._values[slot * STRIDE + Y1] = normalized.y1;

    if (changed) {
      this._unbucketSlot(slot);
      this._bucketSlot(slot, normalized, cellRange);
      this._counters.reinserts++;
    }
    this._counters.updates++;
    return true;
  }

  remove(handle) {
    const slot = this._slotOf.get(handle);
    if (slot === undefined) return false;
    this._unbucketSlot(slot);
    const ownerKey = this._owners[slot];
    if (ownerKey !== null) {
      const remaining = (this._ownerCounts.get(ownerKey) ?? 1) - 1;
      if (remaining > 0) this._ownerCounts.set(ownerKey, remaining);
      else this._ownerCounts.delete(ownerKey);
      this._owners[slot] = null;
    }
    this._slotOf.delete(handle);
    this._alive[slot] = 0;
    this._free.push(slot);
    this._liveCount--;
    this._counters.removals++;
    return true;
  }

  /** Removes every primitive owned by one key. Returns how many were released. */
  removeOwner(ownerKey) {
    const key = normalizeOwnerKey(ownerKey);
    let removed = 0;
    for (const [handle, slot] of [...this._slotOf]) {
      if (this._owners[slot] === key) { this.remove(handle); removed++; }
    }
    return removed;
  }

  /** Releases everything. Storage stays allocated so the hash can be reused. */
  clear() {
    this._buckets.clear();
    this._slotOf.clear();
    this._ownerCounts.clear();
    this._owners.fill(null);
    this._alive.fill(0);
    this._free.length = 0;
    for (let slot = this.cap - 1; slot >= 0; slot--) this._free.push(slot);
    this._nextSlot = 0;
    this._liveCount = 0;
    this._candidateCount = 0;
    return this;
  }

  dispose() {
    this.clear();
    this._disposed = true;
    return this;
  }

  /**
   * Broad phase: writes the slots whose cached bounds overlap the query circle and
   * whose mask/Y span admit it. Returns the candidate count; slots are in
   * `candidates()`. Allocation-free — the buffers are preallocated and each slot is
   * visited at most once per query via a stamp array.
   */
  collect(x, z, radius, queryMask = GEO_QUERY_MASK.SOLID_PLAYER, minY = -Infinity, maxY = Infinity) {
    this._counters.queries++;
    this._candidateCount = 0;
    if (this._liveCount === 0 || (radius ?? 0) < 0) return 0;
    const minX = x - radius, maxX = x + radius, minZ = z - radius, maxZ = z + radius;
    const minCellX = Math.floor(minX / GEO_DYNAMIC_CELL_SIZE);
    const maxCellX = Math.floor(maxX / GEO_DYNAMIC_CELL_SIZE);
    const minCellZ = Math.floor(minZ / GEO_DYNAMIC_CELL_SIZE);
    const maxCellZ = Math.floor(maxZ / GEO_DYNAMIC_CELL_SIZE);
    const stamp = ++this._stampCounter;
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
        const bucket = this._buckets.get(`${cellX}:${cellZ}`);
        if (!bucket) continue;
        for (const slot of bucket) {
          if (this._stamp[slot] === stamp) continue;
          this._stamp[slot] = stamp;
          if (!this._admits(slot, queryMask, minY, maxY)) continue;
          const base = slot * STRIDE;
          if (maxX < this._values[base + MIN_X] || minX > this._values[base + MAX_X] ||
              maxZ < this._values[base + MIN_Z] || minZ > this._values[base + MAX_Z]) continue;
          this._candidates[this._candidateCount++] = slot;
        }
      }
    }
    this._counters.candidates += this._candidateCount;
    this._counters.maxCandidates = Math.max(this._counters.maxCandidates, this._candidateCount);
    return this._candidateCount;
  }

  /** Slots collected by the last `collect()` call, only the first `collect()` entries. */
  candidates() { return this._candidates.subarray(0, this._candidateCount); }

  /**
   * Exact overlap test for a circle against every admitted dynamic proxy.
   * `queryMask`/`minY`/`maxY` filter exactly as the static path does.
   */
  overlapsCircle(x, z, radius, queryMask = GEO_QUERY_MASK.SOLID_PLAYER, minY = -Infinity, maxY = Infinity) {
    const count = this.collect(x, z, radius, queryMask, minY, maxY);
    const candidates = this._candidates;
    for (let index = 0; index < count; index++) {
      this._counters.exactTests++;
      if (this._exactCircle(candidates[index], x, z, radius)) {
        this._counters.hits++;
        return true;
      }
    }
    return false;
  }

  /**
   * Earliest continuous XZ hit for a moving circle. Writes the same field contract
   * as the static sweep (`hit`, `time`, `normalX`, `normalZ`, `startedOverlapping`)
   * plus `dynamicHandle`/`dynamicOwner` so callers can tell a dynamic contact from
   * a tile footprint. `out` is caller-owned.
   */
  sweepCircle(
    x, z, dx, dz, radius, out = {},
    queryMask = GEO_QUERY_MASK.SOLID_PLAYER,
    minY = -Infinity, maxY = Infinity,
  ) {
    out.hit = false;
    out.time = 1;
    out.normalX = 0;
    out.normalZ = 0;
    out.startedOverlapping = false;
    out.dynamicHandle = 0;
    out.dynamicOwner = null;

    // The swept volume is a capsule, so the conservative broad phase is its
    // bounding circle: radius = half the displacement length + the moving radius.
    // An axis-aligned box bound would be smaller and could miss a corner hit.
    const centerX = x + dx / 2;
    const centerZ = z + dz / 2;
    const reach = Math.hypot(dx, dz) / 2 + radius;
    const count = this.collect(centerX, centerZ, reach, queryMask, minY, maxY);
    const candidates = this._candidates;
    for (let index = 0; index < count; index++) {
      const slot = candidates[index];
      this._counters.exactTests++;
      const candidate = this._sweepCandidate;
      this._sweepSlot(slot, x, z, dx, dz, radius, candidate);
      if (!candidate.hit || candidate.time >= out.time) continue;
      out.hit = true;
      out.time = candidate.time;
      out.normalX = candidate.normalX;
      out.normalZ = candidate.normalZ;
      out.startedOverlapping = candidate.startedOverlapping;
      out.dynamicHandle = this._handle[slot];
      out.dynamicOwner = this._owners[slot];
      this._counters.hits++;
    }
    return out;
  }

  /** Shape kind of a handle, or null. Exposed for diagnostics and tests. */
  shapeOf(handle) {
    const slot = this._slotOf.get(handle);
    return slot === undefined ? null : SHAPE_NAME[this._shape[slot]];
  }

  /** Y span of a handle, or null when it is not live. */
  spanAt(handle) {
    const slot = this._slotOf.get(handle);
    if (slot === undefined) return null;
    const base = slot * STRIDE;
    return { y0: this._values[base + Y0], y1: this._values[base + Y1] };
  }

  /**
   * Storage slot backing a handle, or -1. Handles are monotonic ids that are never
   * reused — a stale handle must never resolve to a different proxy — so slot reuse
   * is observable only through this accessor.
   */
  slotOf(handle) {
    const slot = this._slotOf.get(handle);
    return slot === undefined ? -1 : slot;
  }

  /** Owner key of a handle, or null. */
  ownerOf(handle) { return this._slotOf.has(handle) ? this._owners[this._slotOf.get(handle)] : null; }

  /** Mask of a handle, or 0. */
  maskOf(handle) {
    const slot = this._slotOf.get(handle);
    return slot === undefined ? 0 : this._mask[slot];
  }

  // --- internals -----------------------------------------------------------

  _cellRange(normalized) {
    return [
      Math.floor(normalized.minX / GEO_DYNAMIC_CELL_SIZE),
      Math.floor(normalized.minZ / GEO_DYNAMIC_CELL_SIZE),
      Math.floor(normalized.maxX / GEO_DYNAMIC_CELL_SIZE),
      Math.floor(normalized.maxZ / GEO_DYNAMIC_CELL_SIZE),
    ];
  }

  _writeSlot(slot, handle, shape, mask, normalized, ownerKey) {
    const base = slot * STRIDE;
    for (let index = 0; index < 6; index++) this._values[base + index] = normalized.payload[index];
    this._values[base + Y0] = normalized.y0;
    this._values[base + Y1] = normalized.y1;
    this._values[base + MIN_X] = normalized.minX;
    this._values[base + MIN_Z] = normalized.minZ;
    this._values[base + MAX_X] = normalized.maxX;
    this._values[base + MAX_Z] = normalized.maxZ;
    this._shape[slot] = shape;
    this._mask[slot] = Number.isFinite(mask) ? mask | 0 : GEO_QUERY_MASK.SOLID_PLAYER;
    this._handle[slot] = handle;
    this._alive[slot] = 1;
    this._owners[slot] = ownerKey;
    this._slotOf.set(handle, slot);
  }

  _readPrimitive(slot, shape) {
    const base = slot * STRIDE;
    const v = this._values;
    if (shape === GEO_DYNAMIC_PRIMITIVE.CIRCLE) {
      return { x: v[base + F0], z: v[base + F1], radius: v[base + F2] };
    }
    if (shape === GEO_DYNAMIC_PRIMITIVE.CAPSULE) {
      return { x1: v[base + F0], z1: v[base + F1], x2: v[base + F2], z2: v[base + F3], radius: v[base + F4] };
    }
    if (shape === GEO_DYNAMIC_PRIMITIVE.BOX) {
      return { minX: v[base + F0], minZ: v[base + F1], maxX: v[base + F2], maxZ: v[base + F3] };
    }
    return { x: v[base + F0], z: v[base + F1], halfX: v[base + F2], halfZ: v[base + F3], yaw: v[base + F4] };
  }

  _bucketSlot(slot, normalized, cellRange) {
    const base = slot * 4;
    for (let index = 0; index < 4; index++) this._cells[base + index] = cellRange[index];
    for (let cellX = cellRange[0]; cellX <= cellRange[2]; cellX++) {
      for (let cellZ = cellRange[1]; cellZ <= cellRange[3]; cellZ++) {
        const key = `${cellX}:${cellZ}`;
        let bucket = this._buckets.get(key);
        if (!bucket) { bucket = []; this._buckets.set(key, bucket); }
        bucket.push(slot);
      }
    }
  }

  _unbucketSlot(slot) {
    const base = slot * 4;
    for (let cellX = this._cells[base]; cellX <= this._cells[base + 2]; cellX++) {
      for (let cellZ = this._cells[base + 1]; cellZ <= this._cells[base + 3]; cellZ++) {
        const key = `${cellX}:${cellZ}`;
        const bucket = this._buckets.get(key);
        if (!bucket) continue;
        const at = bucket.indexOf(slot);
        if (at >= 0) bucket.splice(at, 1);
        if (bucket.length === 0) this._buckets.delete(key);
      }
    }
  }

  _admits(slot, queryMask, minY, maxY) {
    if ((this._mask[slot] & queryMask) === 0) return false;
    const base = slot * STRIDE;
    return maxY >= this._values[base + Y0] && minY <= this._values[base + Y1];
  }

  _exactCircle(slot, x, z, radius) {
    const shape = this._shape[slot];
    const base = slot * STRIDE;
    const v = this._values;
    if (shape === GEO_DYNAMIC_PRIMITIVE.CIRCLE) {
      const dx = x - v[base + F0], dz = z - v[base + F1];
      const reach = radius + v[base + F2];
      return dx * dx + dz * dz <= reach * reach;
    }
    if (shape === GEO_DYNAMIC_PRIMITIVE.CAPSULE) {
      const x1 = v[base + F0], z1 = v[base + F1], x2 = v[base + F2], z2 = v[base + F3];
      const edgeX = x2 - x1, edgeZ = z2 - z1;
      const lengthSquared = edgeX * edgeX + edgeZ * edgeZ;
      let t = 0;
      if (lengthSquared > 1e-12) t = Math.max(0, Math.min(1, ((x - x1) * edgeX + (z - z1) * edgeZ) / lengthSquared));
      const closestX = x1 + edgeX * t, closestZ = z1 + edgeZ * t;
      const dx = x - closestX, dz = z - closestZ;
      const reach = radius + v[base + F4];
      return dx * dx + dz * dz <= reach * reach;
    }
    if (shape === GEO_DYNAMIC_PRIMITIVE.BOX) {
      circleAabbPenetration(
        x, z, radius,
        v[base + F0], v[base + F1], v[base + F2], v[base + F3],
        this._exactHit,
      );
      return this._exactHit.overlap;
    }
    // Oriented box: the same AABB test in the box's local frame.
    const cos = Math.cos(v[base + F4]), sin = Math.sin(v[base + F4]);
    const offsetX = x - v[base + F0], offsetZ = z - v[base + F1];
    const localX = cos * offsetX + sin * offsetZ;
    const localZ = -sin * offsetX + cos * offsetZ;
    circleAabbPenetration(
      localX, localZ, radius,
      -v[base + F2], -v[base + F3], v[base + F2], v[base + F3],
      this._exactHit,
    );
    return this._exactHit.overlap;
  }

  /**
   * Earliest sweep hit against one slot, written into `out`.
   *
   * The moving circle is folded into the target shape's radius for circles and
   * capsules (analytically exact) and into the expanded half extents for boxes and
   * oriented boxes. For an oriented box that expansion is conservative at the
   * corners: the true Minkowski sum of a rectangle and a disc has rounded corners,
   * and this treats them as square. It can therefore stop the player marginally
   * early, and can never let them pass through.
   */
  _sweepSlot(slot, x, z, dx, dz, radius, out) {
    const shape = this._shape[slot];
    const base = slot * STRIDE;
    const v = this._values;
    if (shape === GEO_DYNAMIC_PRIMITIVE.CIRCLE) {
      const cx = v[base + F0], cz = v[base + F1], reach = radius + v[base + F2];
      sweepPointAgainstSegmentCapsule(x, z, dx, dz, cx, cz, cx, cz, reach, out);
      return out;
    }
    if (shape === GEO_DYNAMIC_PRIMITIVE.CAPSULE) {
      const reach = radius + v[base + F4];
      sweepPointAgainstSegmentCapsule(
        x, z, dx, dz,
        v[base + F0], v[base + F1], v[base + F2], v[base + F3],
        reach, out,
      );
      return out;
    }
    if (shape === GEO_DYNAMIC_PRIMITIVE.BOX) {
      sweepPointAgainstAabb(
        x, z, dx, dz,
        v[base + F0] - radius, v[base + F1] - radius,
        v[base + F2] + radius, v[base + F3] + radius,
        out,
      );
      return out;
    }
    const cos = Math.cos(v[base + F4]), sin = Math.sin(v[base + F4]);
    const halfX = v[base + F2] + radius, halfZ = v[base + F3] + radius;
    const offsetX = x - v[base + F0], offsetZ = z - v[base + F1];
    const localX = cos * offsetX + sin * offsetZ;
    const localZ = -sin * offsetX + cos * offsetZ;
    const localDx = cos * dx + sin * dz;
    const localDz = -sin * dx + cos * dz;
    sweepPointAgainstAabb(localX, localZ, localDx, localDz, -halfX, -halfZ, halfX, halfZ, out);
    if (!out.hit) return out;
    // Rotate the contact normal back into world space; `time` is rotation-invariant.
    const normalX = cos * out.normalX - sin * out.normalZ;
    const normalZ = sin * out.normalX + cos * out.normalZ;
    out.normalX = normalX;
    out.normalZ = normalZ;
    return out;
  }
}
