const EPSILON = 1e-9;
const CONTACT_EPSILON = 1e-5;

/**
 * Coordinate-player navigation profile. The contact skin participates in
 * queries, so the complete authoritative radius remains below 0.06 units.
 */
export const GEO_PLAYER_COLLISION_PROFILE = Object.freeze({
  radius: 0.055,
  skin: 0.003,
  maxContacts: 2,
  maxDepenetration: 0.12,
});

/** Semantic query roles. Rendering Layers are deliberately not collision authority. */
export const GEO_QUERY_MASK = Object.freeze({
  SOLID_PLAYER: 1 << 0,
  SUPPORT: 1 << 1,
  CAMERA_BLOCKER: 1 << 2,
  FADE_ELIGIBLE: 1 << 3,
  LOS_BLOCKER: 1 << 4,
  INTERACTION: 1 << 5,
  PLACEMENT: 1 << 6,
});

export const GEO_BUILDING_QUERY_MASK =
  GEO_QUERY_MASK.SOLID_PLAYER |
  GEO_QUERY_MASK.CAMERA_BLOCKER |
  GEO_QUERY_MASK.LOS_BLOCKER |
  GEO_QUERY_MASK.PLACEMENT;

function pointInPackedRing(x, z, vertices, start, end) {
  let inside = false;
  for (let index = start, previous = end - 1; index < end; previous = index++) {
    const xi = vertices[index * 2], zi = vertices[index * 2 + 1];
    const xj = vertices[previous * 2], zj = vertices[previous * 2 + 1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / ((zj - zi) || EPSILON) + xi) inside = !inside;
  }
  return inside;
}

function distanceToPackedRingSquared(x, z, vertices, start, end) {
  let best = Infinity;
  for (let index = start, previous = end - 1; index < end; previous = index++) {
    const x1 = vertices[previous * 2], z1 = vertices[previous * 2 + 1];
    const x2 = vertices[index * 2], z2 = vertices[index * 2 + 1];
    const dx = x2 - x1, dz = z2 - z1;
    const lengthSquared = dx * dx + dz * dz;
    const amount = lengthSquared
      ? Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / lengthSquared))
      : 0;
    const offsetX = x - (x1 + dx * amount), offsetZ = z - (z1 + dz * amount);
    best = Math.min(best, offsetX * offsetX + offsetZ * offsetZ);
  }
  return best;
}

function validPackedPolygon(polygonIndex, vertices, ringOffsets, polygonOffsets) {
  return Boolean(
    vertices?.length && ringOffsets?.length > 1 && polygonOffsets?.length > polygonIndex + 1 &&
    polygonIndex >= 0 && polygonOffsets[polygonIndex] < polygonOffsets[polygonIndex + 1],
  );
}

function pointInPackedFootprint(x, z, polygonIndex, vertices, ringOffsets, polygonOffsets) {
  const firstRing = polygonOffsets[polygonIndex], lastRing = polygonOffsets[polygonIndex + 1];
  if (!pointInPackedRing(x, z, vertices, ringOffsets[firstRing], ringOffsets[firstRing + 1])) return false;
  for (let ring = firstRing + 1; ring < lastRing; ring++) {
    if (pointInPackedRing(x, z, vertices, ringOffsets[ring], ringOffsets[ring + 1])) return false;
  }
  return true;
}

/** Exact circle/footprint narrow phase over packed MVT polygon rings. */
export function circleIntersectsFootprint(x, z, radius, polygonIndex, vertices, ringOffsets, polygonOffsets) {
  if (!validPackedPolygon(polygonIndex, vertices, ringOffsets, polygonOffsets)) return true;
  if (pointInPackedFootprint(x, z, polygonIndex, vertices, ringOffsets, polygonOffsets)) return true;
  const firstRing = polygonOffsets[polygonIndex], lastRing = polygonOffsets[polygonIndex + 1];
  const radiusSquared = radius * radius;
  for (let ring = firstRing; ring < lastRing; ring++) {
    if (distanceToPackedRingSquared(x, z, vertices, ringOffsets[ring], ringOffsets[ring + 1]) <= radiusSquared) return true;
  }
  return false;
}

/**
 * Return the shortest bounded translation that takes a circle out of a packed
 * solid footprint. This is used only to recover from spawn/streaming/numeric
 * overlap; ordinary motion should be handled by the continuous sweep.
 */
export function circleFootprintPenetration(
  x, z, radius, polygonIndex, vertices, ringOffsets, polygonOffsets, out = {},
) {
  out.overlap = false;
  out.depth = 0;
  out.normalX = 0;
  out.normalZ = 0;
  if (!validPackedPolygon(polygonIndex, vertices, ringOffsets, polygonOffsets)) {
    out.overlap = true;
    out.depth = radius;
    out.normalX = 1;
    return out;
  }

  const insideSolid = pointInPackedFootprint(x, z, polygonIndex, vertices, ringOffsets, polygonOffsets);
  const firstRing = polygonOffsets[polygonIndex], lastRing = polygonOffsets[polygonIndex + 1];
  let bestSquared = Infinity, closestX = x, closestZ = z;
  let closestEdgeX = 1, closestEdgeZ = 0;
  for (let ring = firstRing; ring < lastRing; ring++) {
    const start = ringOffsets[ring], end = ringOffsets[ring + 1];
    for (let index = start, previous = end - 1; index < end; previous = index++) {
      const x1 = vertices[previous * 2], z1 = vertices[previous * 2 + 1];
      const x2 = vertices[index * 2], z2 = vertices[index * 2 + 1];
      const edgeX = x2 - x1, edgeZ = z2 - z1;
      const lengthSquared = edgeX * edgeX + edgeZ * edgeZ;
      const amount = lengthSquared
        ? Math.max(0, Math.min(1, ((x - x1) * edgeX + (z - z1) * edgeZ) / lengthSquared))
        : 0;
      const candidateX = x1 + edgeX * amount, candidateZ = z1 + edgeZ * amount;
      const offsetX = x - candidateX, offsetZ = z - candidateZ;
      const squared = offsetX * offsetX + offsetZ * offsetZ;
      if (squared < bestSquared) {
        bestSquared = squared;
        closestX = candidateX;
        closestZ = candidateZ;
        closestEdgeX = edgeX;
        closestEdgeZ = edgeZ;
      }
    }
  }

  if (!insideSolid && bestSquared >= radius * radius) return out;
  const distance = Math.sqrt(Math.max(0, bestSquared));
  let normalX, normalZ;
  if (distance > EPSILON) {
    const direction = insideSolid ? -1 : 1;
    normalX = (x - closestX) / distance * direction;
    normalZ = (z - closestZ) / distance * direction;
  } else {
    const edgeLength = Math.hypot(closestEdgeX, closestEdgeZ) || 1;
    normalX = -closestEdgeZ / edgeLength;
    normalZ = closestEdgeX / edgeLength;
    // Select the side that points toward empty space, independent of winding.
    if (pointInPackedFootprint(
      x + normalX * 1e-4, z + normalZ * 1e-4,
      polygonIndex, vertices, ringOffsets, polygonOffsets,
    )) {
      normalX *= -1;
      normalZ *= -1;
    }
  }
  out.overlap = true;
  out.depth = insideSolid ? distance + radius : radius - distance;
  out.normalX = normalX;
  out.normalZ = normalZ;
  return out;
}

function resetHit(out) {
  out.hit = false;
  out.time = 1;
  out.normalX = 0;
  out.normalZ = 0;
  out.startedOverlapping = false;
  return out;
}

function updateHit(out, time, normalX, normalZ, dx, dz) {
  if (!Number.isFinite(time) || time < -CONTACT_EPSILON || time > 1 + CONTACT_EPSILON || time >= out.time) return;
  const normalLength = Math.hypot(normalX, normalZ);
  if (normalLength < EPSILON) return;
  normalX /= normalLength;
  normalZ /= normalLength;
  // Ignore roots on the departing/tangent side of a capsule.
  if (dx * normalX + dz * normalZ >= -CONTACT_EPSILON) return;
  out.hit = true;
  out.time = Math.max(0, Math.min(1, time));
  out.normalX = normalX;
  out.normalZ = normalZ;
}

function sweepPointAgainstEndpoint(x, z, dx, dz, centerX, centerZ, radius, out) {
  const offsetX = x - centerX, offsetZ = z - centerZ;
  const a = dx * dx + dz * dz;
  if (a < EPSILON) return;
  const b = 2 * (offsetX * dx + offsetZ * dz);
  const c = offsetX * offsetX + offsetZ * offsetZ - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return;
  const time = (-b - Math.sqrt(discriminant)) / (2 * a);
  if (time < -CONTACT_EPSILON || time > 1 + CONTACT_EPSILON) return;
  updateHit(out, time, x + dx * time - centerX, z + dz * time - centerZ, dx, dz);
}

function sweepPointAgainstSegmentSide(
  x, z, dx, dz, x1, z1, radius, tangentX, tangentZ,
  axisNormalX, axisNormalZ, edgeLength, startDistance, normalVelocity, side, out,
) {
  const time = (side * radius - startDistance) / normalVelocity;
  if (time < -CONTACT_EPSILON || time > 1 + CONTACT_EPSILON) return;
  const contactX = x + dx * time, contactZ = z + dz * time;
  const along = (contactX - x1) * tangentX + (contactZ - z1) * tangentZ;
  if (along >= -CONTACT_EPSILON && along <= edgeLength + CONTACT_EPSILON) {
    updateHit(out, time, axisNormalX * side, axisNormalZ * side, dx, dz);
  }
}

/**
 * Sweep a point against a segment capsule. Shared by the static footprint path and
 * the dynamic proxy hash: folding a moving radius into `radius` makes the same
 * routine an exact moving-circle test for circle and capsule targets.
 */
export function sweepPointAgainstSegmentCapsule(x, z, dx, dz, x1, z1, x2, z2, radius, out) {
  const edgeX = x2 - x1, edgeZ = z2 - z1;
  const edgeLength = Math.hypot(edgeX, edgeZ);
  if (edgeLength < EPSILON) {
    sweepPointAgainstEndpoint(x, z, dx, dz, x1, z1, radius, out);
    return;
  }

  const tangentX = edgeX / edgeLength, tangentZ = edgeZ / edgeLength;
  const axisNormalX = -tangentZ, axisNormalZ = tangentX;
  const startDistance = (x - x1) * axisNormalX + (z - z1) * axisNormalZ;
  const normalVelocity = dx * axisNormalX + dz * axisNormalZ;
  if (Math.abs(normalVelocity) > EPSILON) {
    sweepPointAgainstSegmentSide(
      x, z, dx, dz, x1, z1, radius, tangentX, tangentZ,
      axisNormalX, axisNormalZ, edgeLength, startDistance, normalVelocity, -1, out,
    );
    sweepPointAgainstSegmentSide(
      x, z, dx, dz, x1, z1, radius, tangentX, tangentZ,
      axisNormalX, axisNormalZ, edgeLength, startDistance, normalVelocity, 1, out,
    );
  }

  sweepPointAgainstEndpoint(x, z, dx, dz, x1, z1, radius, out);
  sweepPointAgainstEndpoint(x, z, dx, dz, x2, z2, radius, out);
}

/**
 * Sweep a circle continuously against one exact polygon footprint. `out` is
 * caller-owned so movement and camera queries can avoid steady-state garbage.
 */
export function sweepCircleAgainstFootprint(
  x, z, dx, dz, radius, polygonIndex, vertices, ringOffsets, polygonOffsets, out = {},
) {
  resetHit(out);
  if (!validPackedPolygon(polygonIndex, vertices, ringOffsets, polygonOffsets)) {
    out.hit = true;
    out.time = 0;
    out.startedOverlapping = true;
    const length = Math.hypot(dx, dz) || 1;
    out.normalX = -dx / length;
    out.normalZ = -dz / length;
    return out;
  }

  if (circleIntersectsFootprint(x, z, radius, polygonIndex, vertices, ringOffsets, polygonOffsets)) {
    out.hit = true;
    out.time = 0;
    out.startedOverlapping = true;
    const length = Math.hypot(dx, dz) || 1;
    out.normalX = -dx / length;
    out.normalZ = -dz / length;
    return out;
  }

  if (dx * dx + dz * dz < EPSILON) return out;
  const firstRing = polygonOffsets[polygonIndex], lastRing = polygonOffsets[polygonIndex + 1];
  for (let ring = firstRing; ring < lastRing; ring++) {
    const start = ringOffsets[ring], end = ringOffsets[ring + 1];
    for (let index = start, previous = end - 1; index < end; previous = index++) {
      sweepPointAgainstSegmentCapsule(
        x, z, dx, dz,
        vertices[previous * 2], vertices[previous * 2 + 1],
        vertices[index * 2], vertices[index * 2 + 1],
        radius, out,
      );
    }
  }
  return out;
}

/** Tight circle/AABB penetration for fallback proxy recovery. */
export function circleAabbPenetration(x, z, radius, minX, minZ, maxX, maxZ, out = {}) {
  out.overlap = false;
  out.depth = 0;
  out.normalX = 0;
  out.normalZ = 0;
  if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) {
    const left = x - minX, right = maxX - x, front = z - minZ, back = maxZ - z;
    const nearest = Math.min(left, right, front, back);
    out.overlap = true;
    out.depth = radius + nearest;
    if (nearest === left) out.normalX = -1;
    else if (nearest === right) out.normalX = 1;
    else if (nearest === front) out.normalZ = -1;
    else out.normalZ = 1;
    return out;
  }
  const closestX = Math.max(minX, Math.min(maxX, x));
  const closestZ = Math.max(minZ, Math.min(maxZ, z));
  const offsetX = x - closestX, offsetZ = z - closestZ;
  const distance = Math.hypot(offsetX, offsetZ);
  if (distance >= radius || distance < EPSILON) return out;
  out.overlap = true;
  out.depth = radius - distance;
  out.normalX = offsetX / distance;
  out.normalZ = offsetZ / distance;
  return out;
}

/** Sweep a point against an AABB (expand it first for a circle query). */
export function sweepPointAgainstAabb(x, z, dx, dz, minX, minZ, maxX, maxZ, out = {}) {
  resetHit(out);
  if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) {
    out.hit = true;
    out.time = 0;
    out.startedOverlapping = true;
    const length = Math.hypot(dx, dz) || 1;
    out.normalX = -dx / length;
    out.normalZ = -dz / length;
    return out;
  }

  let enter = 0, exit = 1, normalX = 0, normalZ = 0;
  if (Math.abs(dx) < EPSILON) {
    if (x < minX || x > maxX) return out;
  } else {
    let first = (minX - x) / dx;
    let second = (maxX - x) / dx;
    let axisNormal = -1;
    if (first > second) {
      const swap = first; first = second; second = swap;
      axisNormal = 1;
    }
    if (first > enter) {
      enter = first;
      normalX = axisNormal;
      normalZ = 0;
    }
    exit = Math.min(exit, second);
    if (enter > exit) return out;
  }
  if (Math.abs(dz) < EPSILON) {
    if (z < minZ || z > maxZ) return out;
  } else {
    let first = (minZ - z) / dz;
    let second = (maxZ - z) / dz;
    let axisNormal = -1;
    if (first > second) {
      const swap = first; first = second; second = swap;
      axisNormal = 1;
    }
    if (first > enter) {
      enter = first;
      normalX = 0;
      normalZ = axisNormal;
    }
    exit = Math.min(exit, second);
    if (enter > exit) return out;
  }
  if (enter < -CONTACT_EPSILON || enter > 1 + CONTACT_EPSILON) return out;
  updateHit(out, enter, normalX, normalZ, dx, dz);
  return out;
}

/** Sweep a point against a 3D AABB; expand each side first for a sphere. */
export function sweepPointAgainstAabb3(
  x, y, z, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ, out = {},
) {
  out.hit = false;
  out.time = 1;
  out.normalX = 0;
  out.normalY = 0;
  out.normalZ = 0;
  out.startedOverlapping = false;
  if (x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ) {
    const length = Math.hypot(dx, dy, dz) || 1;
    out.hit = true;
    out.time = 0;
    out.normalX = -dx / length;
    out.normalY = -dy / length;
    out.normalZ = -dz / length;
    out.startedOverlapping = true;
    return out;
  }

  let enter = 0, exit = 1, normalX = 0, normalY = 0, normalZ = 0;
  if (Math.abs(dx) < EPSILON) {
    if (x < minX || x > maxX) return out;
  } else {
    let first = (minX - x) / dx, second = (maxX - x) / dx, normal = -1;
    if (first > second) { const swap = first; first = second; second = swap; normal = 1; }
    if (first > enter) { enter = first; normalX = normal; normalY = 0; normalZ = 0; }
    exit = Math.min(exit, second);
    if (enter > exit) return out;
  }
  if (Math.abs(dy) < EPSILON) {
    if (y < minY || y > maxY) return out;
  } else {
    let first = (minY - y) / dy, second = (maxY - y) / dy, normal = -1;
    if (first > second) { const swap = first; first = second; second = swap; normal = 1; }
    if (first > enter) { enter = first; normalX = 0; normalY = normal; normalZ = 0; }
    exit = Math.min(exit, second);
    if (enter > exit) return out;
  }
  if (Math.abs(dz) < EPSILON) {
    if (z < minZ || z > maxZ) return out;
  } else {
    let first = (minZ - z) / dz, second = (maxZ - z) / dz, normal = -1;
    if (first > second) { const swap = first; first = second; second = swap; normal = 1; }
    if (first > enter) { enter = first; normalX = 0; normalY = 0; normalZ = normal; }
    exit = Math.min(exit, second);
    if (enter > exit) return out;
  }
  if (enter < -CONTACT_EPSILON || enter > 1 + CONTACT_EPSILON) return out;
  const normalLength = Math.hypot(normalX, normalY, normalZ);
  if (normalLength < EPSILON || dx * normalX + dy * normalY + dz * normalZ >= -CONTACT_EPSILON) return out;
  out.hit = true;
  out.time = Math.max(0, Math.min(1, enter));
  out.normalX = normalX;
  out.normalY = normalY;
  out.normalZ = normalZ;
  return out;
}
