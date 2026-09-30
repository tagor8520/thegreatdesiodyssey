/**
 * `COL-09` — capped dynamic spatial hash for moving solid proxies.
 *
 * The static world owns exact packed footprints. Moving solids (vehicles, train
 * cars, boats when solid, moving platforms, future local agents, pushed props)
 * own a small spatial hash described in `CLIPPING_AND_LAYERING_RESEARCH.md` §5.1:
 *
 * - primitive proxies only — circle/capsule in XZ plus a Y span, AABB/OBB, or a
 *   short compound list — never a dynamic body per decorative box;
 * - a proxy is reinserted only when it crosses a cell boundary, so a slow walk
 *   inside one cell costs nothing;
 * - a hard cap of 64 / 128 / 256 active proxies per profile; the cap is enforced
 *   by deterministic skip with a named reason, never by growing the hash;
 * - the movement/controller layer queries the static tiles and this grid and
 *   merges candidate contacts, which is far cheaper than a rigid-body world.
 *
 * No `three` import: the grid is plain math so the coordinate world, the curated
 * island, the debug hook, and `node --test` all share one implementation.
 */

import { featureNamespace } from './FeatureVersions.js';

export const GDO_DYNAMIC_PROXY_NAMESPACE = featureNamespace('dynamicProxy');

export const GDO_DYNAMIC_PROXY_KIND = Object.freeze({
  CIRCLE: 'circle',
  CAPSULE: 'capsule',
  BOX: 'box',
  OBB: 'obb',
  COMPOUND: 'compound',
});

/** Research §5.1: 64 low, 128 balanced, 256 desktop. */
export const GDO_DYNAMIC_PROXY_PROFILES = Object.freeze({
  low: Object.freeze({ maxProxies: 64, cellSize: 4, maxCompoundPrimitives: 4, maxCellsPerProxy: 64 }),
  balanced: Object.freeze({ maxProxies: 128, cellSize: 4, maxCompoundPrimitives: 6, maxCellsPerProxy: 96 }),
  high: Object.freeze({ maxProxies: 256, cellSize: 4, maxCompoundPrimitives: 8, maxCellsPerProxy: 128 }),
});

const KINDS = new Set(Object.values(GDO_DYNAMIC_PROXY_KIND));

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cellKey(cellX, cellZ) {
  return `${cellX}:${cellZ}`;
}

function validateYSpan(span) {
  if (!span || !Number.isFinite(span[0]) || !Number.isFinite(span[1]) || span[1] < span[0]) {
    throw new TypeError('Dynamic proxy needs a finite [minY, maxY] span');
  }
  return span;
}

function validatePrimitive(primitive, index) {
  const kind = primitive?.kind;
  if (!KINDS.has(kind) || kind === GDO_DYNAMIC_PROXY_KIND.COMPOUND) {
    throw new RangeError(`Dynamic proxy primitive ${index} has an unsupported kind: ${kind}`);
  }
  const span = validateYSpan(primitive.ySpan);
  if (kind === GDO_DYNAMIC_PROXY_KIND.CIRCLE) {
    if (!Number.isFinite(primitive.x) || !Number.isFinite(primitive.z) || !(primitive.radius > 0)) {
      throw new RangeError(`Dynamic proxy circle ${index} needs a finite centre and a positive radius`);
    }
    return primitive;
  }
  if (kind === GDO_DYNAMIC_PROXY_KIND.CAPSULE) {
    if (![primitive.ax, primitive.az, primitive.bx, primitive.bz].every(Number.isFinite) || !(primitive.radius > 0)) {
      throw new RangeError(`Dynamic proxy capsule ${index} needs two finite ends and a positive radius`);
    }
    return primitive;
  }
  if (kind === GDO_DYNAMIC_PROXY_KIND.BOX) {
    if (![primitive.minX, primitive.minZ, primitive.maxX, primitive.maxZ].every(Number.isFinite) ||
        primitive.maxX < primitive.minX || primitive.maxZ < primitive.minZ) {
      throw new RangeError(`Dynamic proxy box ${index} needs finite ordered bounds`);
    }
    return primitive;
  }
  if (![primitive.x, primitive.z, primitive.halfX, primitive.halfZ, primitive.rotation].every(Number.isFinite) ||
      !(primitive.halfX > 0) || !(primitive.halfZ > 0)) {
    throw new RangeError(`Dynamic proxy OBB ${index} needs a finite centre, half extents and rotation`);
  }
  return primitive;
}

function primitiveBounds(primitive) {
  if (primitive.kind === GDO_DYNAMIC_PROXY_KIND.CIRCLE) {
    return [primitive.x - primitive.radius, primitive.z - primitive.radius, primitive.x + primitive.radius, primitive.z + primitive.radius];
  }
  if (primitive.kind === GDO_DYNAMIC_PROXY_KIND.CAPSULE) {
    const radius = primitive.radius;
    return [
      Math.min(primitive.ax, primitive.bx) - radius, Math.min(primitive.az, primitive.bz) - radius,
      Math.max(primitive.ax, primitive.bx) + radius, Math.max(primitive.az, primitive.bz) + radius,
    ];
  }
  if (primitive.kind === GDO_DYNAMIC_PROXY_KIND.BOX) {
    return [primitive.minX, primitive.minZ, primitive.maxX, primitive.maxZ];
  }
  const cos = Math.abs(Math.cos(primitive.rotation)), sin = Math.abs(Math.sin(primitive.rotation));
  const halfX = primitive.halfX * cos + primitive.halfZ * sin;
  const halfZ = primitive.halfX * sin + primitive.halfZ * cos;
  return [primitive.x - halfX, primitive.z - halfZ, primitive.x + halfX, primitive.z + halfZ];
}

/** Flatten a declaration into validated primitives plus a reusable bounds box. */
function compileDeclaration(declaration, limits) {
  const kind = declaration?.kind;
  if (!KINDS.has(kind)) throw new RangeError(`Unknown dynamic proxy kind: ${kind}`);
  if (kind === GDO_DYNAMIC_PROXY_KIND.COMPOUND) {
    const primitives = declaration.primitives;
    if (!Array.isArray(primitives) || !primitives.length) throw new TypeError('Dynamic compound proxy needs primitives');
    if (primitives.length > limits.maxCompoundPrimitives) {
      throw new RangeError(`Dynamic compound proxy exceeds ${limits.maxCompoundPrimitives} primitives`);
    }
    const compiled = primitives.map((primitive, index) => validatePrimitive(primitive, index));
    const minY = Math.min(...compiled.map(primitive => primitive.ySpan[0]));
    const maxY = Math.max(...compiled.map(primitive => primitive.ySpan[1]));
    return { kind, primitives: compiled, ySpan: [minY, maxY], bounds: null };
  }
  const primitive = validatePrimitive(declaration, 0);
  return { kind, primitives: [primitive], ySpan: primitive.ySpan, bounds: null };
}

function refreshBounds(entry) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const primitive of entry.primitives) {
    const [a, b, c, d] = primitiveBounds(primitive);
    if (a < minX) minX = a;
    if (b < minZ) minZ = b;
    if (c > maxX) maxX = c;
    if (d > maxZ) maxZ = d;
  }
  entry.bounds[0] = minX; entry.bounds[1] = minZ; entry.bounds[2] = maxX; entry.bounds[3] = maxZ;
  return entry.bounds;
}

function translatePrimitive(primitive, dx, dz) {
  if (primitive.kind === GDO_DYNAMIC_PROXY_KIND.CIRCLE) { primitive.x += dx; primitive.z += dz; return; }
  if (primitive.kind === GDO_DYNAMIC_PROXY_KIND.CAPSULE) {
    primitive.ax += dx; primitive.az += dz; primitive.bx += dx; primitive.bz += dz; return;
  }
  if (primitive.kind === GDO_DYNAMIC_PROXY_KIND.BOX) {
    primitive.minX += dx; primitive.minZ += dz; primitive.maxX += dx; primitive.maxZ += dz; return;
  }
  primitive.x += dx; primitive.z += dz;
}

/** Earliest `t ∈ [0, 1]` of a moving circle against one static primitive, or -1. */
function sweepCirclePrimitive(x, z, dx, dz, radius, minY, maxY, primitive) {
  if (maxY < primitive.ySpan[0] || minY > primitive.ySpan[1]) return -1;
  const total = radius;
  if (primitive.kind === GDO_DYNAMIC_PROXY_KIND.CIRCLE) {
    const reach = total + primitive.radius;
    const ox = x - primitive.x, oz = z - primitive.z;
    const a = dx * dx + dz * dz;
    if (a < 1e-18) return ox * ox + oz * oz <= reach * reach ? 0 : -1;
    const b = 2 * (ox * dx + oz * dz);
    const c = ox * ox + oz * oz - reach * reach;
    if (c <= 0) return 0;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return -1;
    const t = (-b - Math.sqrt(discriminant)) / (2 * a);
    return t >= 0 && t <= 1 ? t : -1;
  }
  if (primitive.kind === GDO_DYNAMIC_PROXY_KIND.CAPSULE) {
    // Swept circle against a segment: the earliest of the two end caps and the
    // open span. `t` is clamped so a start already inside reports zero.
    let best = -1;
    const ends = [
      { x: primitive.ax, z: primitive.az },
      { x: primitive.bx, z: primitive.bz },
    ];
    for (const end of ends) {
      const reach = total + primitive.radius;
      const ox = x - end.x, oz = z - end.z;
      const a = dx * dx + dz * dz;
      if (a < 1e-18) { if (ox * ox + oz * oz <= reach * reach) return 0; continue; }
      const b = 2 * (ox * dx + oz * dz);
      const c = ox * ox + oz * oz - reach * reach;
      if (c <= 0) return 0;
      const discriminant = b * b - 4 * a * c;
      if (discriminant < 0) continue;
      const t = (-b - Math.sqrt(discriminant)) / (2 * a);
      if (t >= 0 && t <= 1 && (best < 0 || t < best)) best = t;
    }
    const sx = primitive.bx - primitive.ax, sz = primitive.bz - primitive.az;
    const length = Math.hypot(sx, sz);
    if (length > 1e-9) {
      // The open span is the line through the capsule with the normal form of the
      // distance: |(P(t) − A)·n| = radius. Whether the contact lands between the
      // two caps is checked afterwards, so the caps above keep the ends honest.
      const reach = total + primitive.radius;
      const nx = -sz / length, nz = sx / length;
      const d0 = (x - primitive.ax) * nx + (z - primitive.az) * nz;
      const dDelta = dx * nx + dz * nz;
      if (Math.abs(dDelta) > 1e-12) {
        for (const target of [reach, -reach]) {
          const t = (target - d0) / dDelta;
          if (t < 0 || t > 1) continue;
          const hitX = x + dx * t, hitZ = z + dz * t;
          const along = ((hitX - primitive.ax) * sx + (hitZ - primitive.az) * sz) / (length * length);
          if (along < 0 || along > 1) continue;
          if (best < 0 || t < best) best = t;
          break;
        }
      } else if (Math.abs(d0) <= reach) {
        // Travelling exactly along the span: the caps above already answered.
        best = best < 0 ? 0 : best;
      }
    }
    return best;
  }
  // Box and OBB share the slab test, with the OBB rotated into its local frame.
  let localX = x, localZ = z, localDx = dx, localDz = dz;
  let minX = primitive.minX, minZ = primitive.minZ, maxX = primitive.maxX, maxZ = primitive.maxZ;
  if (primitive.kind === GDO_DYNAMIC_PROXY_KIND.OBB) {
    const cos = Math.cos(-primitive.rotation), sin = Math.sin(-primitive.rotation);
    const ox = x - primitive.x, oz = z - primitive.z;
    localX = ox * cos - oz * sin; localZ = ox * sin + oz * cos;
    localDx = dx * cos - dz * sin; localDz = dx * sin + dz * cos;
    minX = -primitive.halfX; maxX = primitive.halfX;
    minZ = -primitive.halfZ; maxZ = primitive.halfZ;
  }
  minX -= total; maxX += total; minZ -= total; maxZ += total;
  if (localX >= minX && localX <= maxX && localZ >= minZ && localZ <= maxZ) return 0;
  let enter = 0, exit = 1;
  for (const axis of [0, 1]) {
    const start = axis === 0 ? localX : localZ;
    const delta = axis === 0 ? localDx : localDz;
    const low = axis === 0 ? minX : minZ;
    const high = axis === 0 ? maxX : maxZ;
    if (Math.abs(delta) < 1e-18) { if (start < low || start > high) return -1; continue; }
    let t1 = (low - start) / delta, t2 = (high - start) / delta;
    if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; }
    enter = Math.max(enter, t1);
    exit = Math.min(exit, t2);
    if (enter > exit) return -1;
  }
  return enter >= 0 && enter <= 1 ? enter : -1;
}

function circleOverlapsPrimitive(x, z, radius, minY, maxY, primitive) {
  if (maxY < primitive.ySpan[0] || minY > primitive.ySpan[1]) return false;
  if (primitive.kind === GDO_DYNAMIC_PROXY_KIND.CIRCLE) {
    const ox = x - primitive.x, oz = z - primitive.z, reach = radius + primitive.radius;
    return ox * ox + oz * oz <= reach * reach;
  }
  if (primitive.kind === GDO_DYNAMIC_PROXY_KIND.CAPSULE) {
    const sx = primitive.bx - primitive.ax, sz = primitive.bz - primitive.az;
    const lengthSquared = sx * sx + sz * sz;
    const t = lengthSquared < 1e-18 ? 0 : Math.max(0, Math.min(1, ((x - primitive.ax) * sx + (z - primitive.az) * sz) / lengthSquared));
    const closestX = primitive.ax + sx * t, closestZ = primitive.az + sz * t;
    const ox = x - closestX, oz = z - closestZ, reach = radius + primitive.radius;
    return ox * ox + oz * oz <= reach * reach;
  }
  let localX = x, localZ = z;
  let minX = primitive.minX, minZ = primitive.minZ, maxX = primitive.maxX, maxZ = primitive.maxZ;
  if (primitive.kind === GDO_DYNAMIC_PROXY_KIND.OBB) {
    const cos = Math.cos(-primitive.rotation), sin = Math.sin(-primitive.rotation);
    const ox = x - primitive.x, oz = z - primitive.z;
    localX = ox * cos - oz * sin; localZ = ox * sin + oz * cos;
    minX = -primitive.halfX; maxX = primitive.halfX;
    minZ = -primitive.halfZ; maxZ = primitive.halfZ;
  }
  const closestX = Math.max(minX, Math.min(localX, maxX));
  const closestZ = Math.max(minZ, Math.min(localZ, maxZ));
  const ox = localX - closestX, oz = localZ - closestZ;
  return ox * ox + oz * oz <= radius * radius;
}

/**
 * The capped hash itself. Every method is allocation-free in steady state: the
 * caller passes the output array, and records are reused across `move` calls.
 */
export class DynamicProxyGrid {
  constructor({ profile = 'low', cellSize, maxProxies, ledger = null, namespace = GDO_DYNAMIC_PROXY_NAMESPACE } = {}) {
    const limits = GDO_DYNAMIC_PROXY_PROFILES[profile];
    if (!limits) throw new RangeError(`Unknown dynamic proxy profile: ${profile}`);
    const requestedCells = cellSize ?? limits.cellSize;
    if (!Number.isFinite(requestedCells) || requestedCells <= 0) throw new RangeError('Dynamic proxy cell size must be positive');
    const requestedMax = maxProxies ?? limits.maxProxies;
    if (!Number.isInteger(requestedMax) || requestedMax < 1 || requestedMax > limits.maxProxies) {
      throw new RangeError(`Dynamic proxy cap must be 1–${limits.maxProxies}`);
    }
    this.namespace = namespace;
    this.profile = profile;
    this.limits = limits;
    this.cellSize = requestedCells;
    this.maxProxies = requestedMax;
    this.cells = new Map();
    this.records = new Map();
    // `FND-07`: the ledger owns the hash, so a world remount cannot leave a
    // populated grid behind.
    this.ledger = ledger;
    this.scope = ledger?.child?.('dynamic-proxies') ?? null;
    this.scope?.handle('grid', () => this.dispose());
    this.inserts = 0;
    this.reinserts = 0;
    this.reinsertsSkipped = 0;
    this.capSkips = 0;
    this.removals = 0;
    this.queries = 0;
    this.candidates = 0;
    this.maxCandidates = 0;
    this.sweeps = 0;
    this.steadyFrameAllocations = 0;
    this.disposed = false;
    this.hits = [];
  }

  #assertLive() {
    if (this.disposed) throw new Error('Dynamic proxy grid is disposed');
  }

  #cellRange(bounds) {
    return [
      Math.floor(bounds[0] / this.cellSize), Math.floor(bounds[1] / this.cellSize),
      Math.floor(bounds[2] / this.cellSize), Math.floor(bounds[3] / this.cellSize),
    ];
  }

  #insertCells(record) {
    const [minCellX, minCellZ, maxCellX, maxCellZ] = this.#cellRange(record.bounds);
    const span = (maxCellX - minCellX + 1) * (maxCellZ - minCellZ + 1);
    if (span > this.limits.maxCellsPerProxy) {
      this.reinsertsSkipped++;
      return false;
    }
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
      const key = cellKey(cellX, cellZ);
      let bucket = this.cells.get(key);
      if (!bucket) { bucket = []; this.cells.set(key, bucket); }
      bucket.push(record.id);
    }
    record.minCellX = minCellX; record.minCellZ = minCellZ;
    record.maxCellX = maxCellX; record.maxCellZ = maxCellZ;
    this.inserts++;
    return true;
  }

  #removeCells(record) {
    if (record.minCellX === null) return;
    for (let cellX = record.minCellX; cellX <= record.maxCellX; cellX++) for (let cellZ = record.minCellZ; cellZ <= record.maxCellZ; cellZ++) {
      const key = cellKey(cellX, cellZ);
      const bucket = this.cells.get(key);
      if (!bucket) continue;
      const index = bucket.indexOf(record.id);
      if (index >= 0) bucket.splice(index, 1);
      if (!bucket.length) this.cells.delete(key);
    }
    record.minCellX = null; record.minCellZ = null; record.maxCellX = null; record.maxCellZ = null;
  }

  /**
   * Add one moving proxy. Returns its id, or `null` when the cap or an invalid
   * span refused it — the reason is counted in `diagnostics().skipped`.
   */
  insert(id, declaration, { mask } = {}) {
    this.#assertLive();
    const key = text(id);
    if (!key) throw new TypeError('Dynamic proxy needs an id');
    if (this.records.has(key)) throw new RangeError(`Dynamic proxy id is already active: ${key}`);
    if (this.records.size >= this.maxProxies) { this.capSkips++; return null; }
    const compiled = compileDeclaration(declaration, this.limits);
    const queryMask = Number.isInteger(mask) ? mask : finite(declaration?.mask, 1);
    const record = {
      id: key,
      kind: compiled.kind,
      mask: queryMask,
      primitives: compiled.primitives,
      ySpan: compiled.ySpan,
      bounds: compiled.bounds ?? [0, 0, 0, 0],
      minCellX: null, minCellZ: null, maxCellX: null, maxCellZ: null,
      owner: text(declaration?.owner) || null,
      label: text(declaration?.label) || compiled.kind,
    };
    refreshBounds(record);
    if (record.bounds[0] === Infinity) { this.capSkips++; return null; }
    this.records.set(key, record);
    if (!this.#insertCells(record)) {
      this.records.delete(key);
      return null;
    }
    return key;
  }

  /**
   * Move an active proxy. The cell lists are touched only when the new bounds
   * cross a boundary the old bounds did not touch — the research's requirement
   * that a proxy inside one cell costs nothing.
   */
  move(id, dx, dz, { y = 0, dy = 0 } = {}) {
    this.#assertLive();
    const record = this.records.get(text(id));
    if (!record) return false;
    if (!Number.isFinite(dx) || !Number.isFinite(dz) || !Number.isFinite(y) || !Number.isFinite(dy)) {
      throw new TypeError('Dynamic proxy move needs finite deltas');
    }
    for (const primitive of record.primitives) {
      translatePrimitive(primitive, dx, dz);
      primitive.ySpan = [primitive.ySpan[0] + dy, primitive.ySpan[1] + dy];
    }
    record.ySpan = [record.ySpan[0] + dy, record.ySpan[1] + dy];
    refreshBounds(record);
    const [minCellX, minCellZ, maxCellX, maxCellZ] = this.#cellRange(record.bounds);
    const sameCells = minCellX === record.minCellX && minCellZ === record.minCellZ &&
      maxCellX === record.maxCellX && maxCellZ === record.maxCellZ;
    if (sameCells) { this.reinsertsSkipped++; return true; }
    this.#removeCells(record);
    this.reinserts++;
    if (!this.#insertCells(record)) {
      // A proxy that would span too many cells is dropped deterministically
      // instead of growing the hash; the caller learns from `remove()`.
      this.records.delete(record.id);
      return false;
    }
    return true;
  }

  remove(id) {
    const record = this.records.get(text(id));
    if (!record) return false;
    this.#removeCells(record);
    this.records.delete(record.id);
    this.removals++;
    return true;
  }

  has(id) { return this.records.has(text(id)); }
  get activeProxies() { return this.records.size; }
  record(id) { return this.records.get(text(id)) ?? null; }

  #collect(minX, minZ, maxX, maxZ, queryMask, out) {
    out.length = 0;
    const [minCellX, minCellZ, maxCellX, maxCellZ] = this.#cellRange([minX, minZ, maxX, maxZ]);
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
      const bucket = this.cells.get(cellKey(cellX, cellZ));
      if (!bucket) continue;
      for (const id of bucket) {
        if (out.includes(id)) continue;
        const record = this.records.get(id);
        if (!record) continue;
        if ((record.mask & queryMask) === 0) continue;
        out.push(id);
      }
    }
    this.queries++;
    this.candidates += out.length;
    if (out.length > this.maxCandidates) this.maxCandidates = out.length;
    return out;
  }

  /** Candidate ids near a circle; the caller applies its own exact test. */
  queryCircle(x, z, radius, queryMask, out = []) {
    this.#assertLive();
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(radius >= 0)) throw new TypeError('Dynamic proxy query needs a finite circle');
    return this.#collect(x - radius, z - radius, x + radius, z + radius, queryMask, out);
  }

  /** Exact overlap test against the live moving solids in one call. */
  overlapsCircle(x, z, radius, { queryMask = 1, minY = -Infinity, maxY = Infinity, out = [] } = {}) {
    const candidates = this.queryCircle(x, z, radius, queryMask, out);
    for (const id of candidates) {
      const record = this.records.get(id);
      for (const primitive of record.primitives) {
        if (circleOverlapsPrimitive(x, z, radius, minY, maxY, primitive)) {
          this.hits.push({ id, kind: record.kind, time: 0, primitive: record.primitives.indexOf(primitive) });
          return record;
        }
      }
    }
    return null;
  }

  /**
   * Continuous sweep of a moving circle against the live proxies. Returns
   * `{ id, kind, time }` for the earliest hit inside `[0, 1]`, else `null`.
   */
  sweepCircle(x, z, dx, dz, radius, { queryMask = 1, minY = -Infinity, maxY = Infinity, out = [] } = {}) {
    this.#assertLive();
    if (![x, z, dx, dz, radius].every(Number.isFinite) || !(radius >= 0)) {
      throw new TypeError('Dynamic proxy sweep needs a finite start, delta and radius');
    }
    this.sweeps++;
    const endX = x + dx, endZ = z + dz;
    const sweepBounds = [Math.min(x, endX), Math.min(z, endZ), Math.max(x, endX), Math.max(z, endZ)];
    // Candidates come from every cell the swept circle can touch, so a fast
    // proxy cannot slip through between two queries.
    const candidates = this.#collect(
      sweepBounds[0] - radius, sweepBounds[1] - radius,
      sweepBounds[2] + radius, sweepBounds[3] + radius, queryMask, out,
    );
    let best = null;
    for (const id of candidates) {
      const record = this.records.get(id);
      if (record.bounds[0] > sweepBounds[2] || record.bounds[2] < sweepBounds[0] ||
          record.bounds[1] > sweepBounds[3] || record.bounds[3] < sweepBounds[1]) continue;
      let bestTime = -1, bestPrimitive = -1;
      for (let index = 0; index < record.primitives.length; index++) {
        const time = sweepCirclePrimitive(x, z, dx, dz, radius, minY, maxY, record.primitives[index]);
        if (time >= 0 && (bestTime < 0 || time < bestTime)) { bestTime = time; bestPrimitive = index; }
      }
      if (bestTime < 0) continue;
      if (!best || bestTime < best.time) best = { id, kind: record.kind, time: bestTime, primitive: bestPrimitive };
    }
    return best;
  }

  clear() {
    this.cells.clear();
    this.records.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
  }

  diagnostics() {
    return Object.freeze({
      namespace: this.namespace,
      profile: this.profile,
      cellSize: this.cellSize,
      activeProxies: this.records.size,
      cells: this.cells.size,
      maxProxies: this.maxProxies,
      capSkips: this.capSkips,
      inserts: this.inserts,
      reinserts: this.reinserts,
      reinsertsSkipped: this.reinsertsSkipped,
      removals: this.removals,
      queries: this.queries,
      candidates: this.candidates,
      maxCandidates: this.maxCandidates,
      sweeps: this.sweeps,
      steadyFrameAllocations: this.steadyFrameAllocations,
      disposed: this.disposed,
      limits: this.limits,
    });
  }
}

/** One shared grid per profile, so two worlds cannot silently double the cap. */
export function dynamicProxyCapForProfile(profile) {
  const limits = GDO_DYNAMIC_PROXY_PROFILES[profile];
  if (!limits) throw new RangeError(`Unknown dynamic proxy profile: ${profile}`);
  return limits.maxProxies;
}
