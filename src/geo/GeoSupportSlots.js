export const GEO_SUPPORT_ROLE = Object.freeze({
  GROUND_DETAIL: 1 << 0,
  ROAD_EDGE: 1 << 1,
  ROOF_DETAIL: 1 << 2,
  FACADE_DETAIL: 1 << 3,
  BUILDING_DETAIL: 1 << 4,
  STREET_FURNITURE: 1 << 5,
});

export const GEO_SUPPORT_SLOT_STRIDE = 8;
export const GEO_SUPPORT_SLOT_FIELD = Object.freeze({
  X: 0,
  Y: 1,
  Z: 2,
  HALF_WIDTH: 3,
  HALF_DEPTH: 4,
  YAW: 5,
  ROLE_MASK: 6,
  ID: 7,
});

function pointInRing(x, z, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, zi] = ring[index], [xj, zj] = ring[previous];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(x, z, rings) {
  return Boolean(rings.length) && pointInRing(x, z, rings[0]) && !rings.slice(1).some(ring => pointInRing(x, z, ring));
}

function orientation(ax, az, bx, bz, cx, cz) {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

function between(value, first, second) {
  return value >= Math.min(first, second) - 1e-9 && value <= Math.max(first, second) + 1e-9;
}

function segmentsIntersect(a, b, c, d) {
  const first = orientation(...a, ...b, ...c);
  const second = orientation(...a, ...b, ...d);
  const third = orientation(...c, ...d, ...a);
  const fourth = orientation(...c, ...d, ...b);
  if (((first > 0 && second < 0) || (first < 0 && second > 0)) &&
      ((third > 0 && fourth < 0) || (third < 0 && fourth > 0))) return true;
  if (Math.abs(first) <= 1e-9 && between(c[0], a[0], b[0]) && between(c[1], a[1], b[1])) return true;
  if (Math.abs(second) <= 1e-9 && between(d[0], a[0], b[0]) && between(d[1], a[1], b[1])) return true;
  if (Math.abs(third) <= 1e-9 && between(a[0], c[0], d[0]) && between(a[1], c[1], d[1])) return true;
  return Math.abs(fourth) <= 1e-9 && between(b[0], c[0], d[0]) && between(b[1], c[1], d[1]);
}

/** Exact axis-aligned footprint support, including concavities and courtyard holes. */
export function rectangleFitsSupport(rings, x, z, halfWidth, halfDepth, inset = 0) {
  if (![x, z, halfWidth, halfDepth, inset].every(Number.isFinite) || halfWidth <= 0 || halfDepth <= 0 || inset < 0) return false;
  if (!Array.isArray(rings) || !rings.length || rings.some(ring => !Array.isArray(ring) || ring.length < 3)) return false;
  const hx = halfWidth + inset, hz = halfDepth + inset;
  const corners = [
    [x - hx, z - hz],
    [x + hx, z - hz],
    [x + hx, z + hz],
    [x - hx, z + hz],
  ];
  if (!corners.every(([cornerX, cornerZ]) => pointInPolygon(cornerX, cornerZ, rings))) return false;
  const edges = corners.map((corner, index) => [corner, corners[(index + 1) % corners.length]]);
  for (const ring of rings) {
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const first = ring[previous], second = ring[index];
      if (edges.some(edge => segmentsIntersect(first, second, edge[0], edge[1]))) return false;
    }
    // A hole or concave notch wholly enclosed by the rectangle has no edge
    // crossing, so reject any support-boundary vertex inside the candidate too.
    for (const [pointX, pointZ] of ring) {
      if (pointX >= x - hx && pointX <= x + hx && pointZ >= z - hz && pointZ <= z + hz) return false;
    }
  }
  return true;
}

function mix32(value) {
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function slotId(seed, candidateIndex) {
  // Exactly representable in Float32; this identity is local to one parent recipe.
  return (mix32((seed >>> 0) ^ Math.imul(candidateIndex + 1, 0x9e3779b1)) & 0x00ffffff) || 1;
}

/** Generate a tiny, deterministic set of non-overlapping authored roof slots. */
export function generateRoofSupportSlots(rings, {
  surfaceY = 0,
  seed = 0,
  maxSlots = 2,
  inset = 0.05,
  minSize = 0.18,
  maxSize = 0.48,
} = {}) {
  const slotLimit = Number.isFinite(maxSlots) ? Math.max(0, Math.min(8, Math.floor(maxSlots))) : 0;
  if (!Array.isArray(rings) || !rings.length || slotLimit === 0) return [];
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of rings[0]) {
    minX = Math.min(minX, x); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
  }
  const minimumDimension = Math.min(maxX - minX, maxZ - minZ);
  const size = Math.min(maxSize, minimumDimension * 0.34);
  if (![minX, minZ, maxX, maxZ, surfaceY, size].every(Number.isFinite) || size < minSize) return [];

  const candidates = [];
  for (let row = 1; row <= 3; row++) for (let column = 1; column <= 3; column++) {
    const index = (row - 1) * 3 + column - 1;
    candidates.push({
      x: minX + (maxX - minX) * column / 4,
      z: minZ + (maxZ - minZ) * row / 4,
      index,
      selector: mix32((seed >>> 0) ^ Math.imul(index + 1, 0x85ebca6b)),
    });
  }
  // Stable keyed ordering avoids a permanent lower-left bias while remaining
  // independent of frame rate, worker scheduling, and tile eviction.
  candidates.sort((first, second) => first.selector - second.selector || first.index - second.index);

  const slots = [], half = size / 2;
  for (const candidate of candidates) {
    if (!rectangleFitsSupport(rings, candidate.x, candidate.z, half, half, inset)) continue;
    if (slots.some(slot => Math.abs(slot.x - candidate.x) < slot.halfWidth + half + inset &&
      Math.abs(slot.z - candidate.z) < slot.halfDepth + half + inset)) continue;
    slots.push(Object.freeze({
      x: candidate.x,
      y: surfaceY,
      z: candidate.z,
      halfWidth: half,
      halfDepth: half,
      yaw: 0,
      roleMask: GEO_SUPPORT_ROLE.ROOF_DETAIL,
      // Recipe-local identity; packing assigns a collision-free tile-local ID.
      id: slotId(seed, candidate.index),
    }));
    if (slots.length >= slotLimit) break;
  }
  return slots;
}

export function appendPackedSupportSlots(target, slots, limit = Infinity) {
  if (!Array.isArray(target) || !Array.isArray(slots)) throw new TypeError('Support slots require array targets');
  for (const slot of slots) {
    if (target.length / GEO_SUPPORT_SLOT_STRIDE >= limit) break;
    const tileLocalId = target.length / GEO_SUPPORT_SLOT_STRIDE + 1;
    target.push(slot.x, slot.y, slot.z, slot.halfWidth, slot.halfDepth, slot.yaw, slot.roleMask, tileLocalId);
  }
  return target;
}

function validatePackedSlots(values, states) {
  if (!(values instanceof Float32Array) || values.length % GEO_SUPPORT_SLOT_STRIDE !== 0) {
    throw new TypeError('Packed support slots require a stride-aligned Float32Array');
  }
  if (!(states instanceof Uint8Array) || states.length !== values.length / GEO_SUPPORT_SLOT_STRIDE) {
    throw new TypeError('Support slot states must align one-to-one with packed slots');
  }
}

/** Nearest-then-ID selection is reproducible even when tiles finish out of order. */
export function findPackedSupportSlot(values, states, {
  nearX = 0,
  nearZ = 0,
  halfWidth = 0,
  halfDepth = 0,
  roleMask = GEO_SUPPORT_ROLE.ROOF_DETAIL,
  maxDistance = Infinity,
} = {}) {
  validatePackedSlots(values, states);
  if (![nearX, nearZ, halfWidth, halfDepth].every(Number.isFinite) || halfWidth < 0 || halfDepth < 0 ||
      (!(Number.isFinite(maxDistance) || maxDistance === Infinity)) || maxDistance < 0 ||
      !Number.isInteger(roleMask) || roleMask <= 0) {
    throw new RangeError('Invalid support-slot query');
  }
  let best = null;
  const maxDistanceSquared = maxDistance * maxDistance;
  for (let offset = 0, index = 0; offset < values.length; offset += GEO_SUPPORT_SLOT_STRIDE, index++) {
    if (states[index]) continue;
    const x = values[offset], z = values[offset + 2];
    const slotHalfWidth = values[offset + 3], slotHalfDepth = values[offset + 4];
    const slotRole = Math.round(values[offset + 6]), id = Math.round(values[offset + 7]);
    if (![x, z, slotHalfWidth, slotHalfDepth, id].every(Number.isFinite) || slotHalfWidth <= 0 || slotHalfDepth <= 0 || id <= 0) continue;
    if ((slotRole & roleMask) === 0 || halfWidth > slotHalfWidth + 1e-6 || halfDepth > slotHalfDepth + 1e-6) continue;
    const distanceSquared = (x - nearX) ** 2 + (z - nearZ) ** 2;
    if (distanceSquared > maxDistanceSquared) continue;
    if (best && (distanceSquared > best.distanceSquared + 1e-12 ||
      (Math.abs(distanceSquared - best.distanceSquared) <= 1e-12 && id >= best.id))) continue;
    best = {
      index,
      id,
      x,
      y: values[offset + 1],
      z,
      halfWidth: slotHalfWidth,
      halfDepth: slotHalfDepth,
      yaw: values[offset + 5],
      roleMask: slotRole,
      distanceSquared,
    };
  }
  return best;
}

export function claimPackedSupportSlot(values, states, query) {
  const slot = findPackedSupportSlot(values, states, query);
  if (!slot) return null;
  states[slot.index] = 2;
  return slot;
}

export function releasePackedSupportSlot(states, index) {
  if (!(states instanceof Uint8Array) || !Number.isInteger(index) || index < 0 || index >= states.length) return false;
  if (states[index] !== 2) return false;
  states[index] = 0;
  return true;
}
