export const GEO_TERRAIN_DEFAULTS = Object.freeze({
  gridResolution: 32,
  normalSample: 0.12,
  maxWalkableSlope: Math.PI * 35 / 180,
  maxStepUp: 0.055,
  maxStepDown: 0.14,
  minimumHeight: -0.25,
  maximumHeight: -0.012,
});

function mix32(value) {
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function latticeRandom(x, z, seed) {
  return mix32(Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(z | 0, 0x5f356495) ^ seed) / 4294967296;
}

function smooth(value) { return value * value * (3 - 2 * value); }

function valueNoise(x, z, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const tx = smooth(x - x0), tz = smooth(z - z0);
  const first = latticeRandom(x0, z0, seed) * (1 - tx) + latticeRandom(x0 + 1, z0, seed) * tx;
  const second = latticeRandom(x0, z0 + 1, seed) * (1 - tx) + latticeRandom(x0 + 1, z0 + 1, seed) * tx;
  return first * (1 - tz) + second * tz;
}

export function terrainSeedForCoordinate(latitude, longitude) {
  if (![latitude, longitude].every(Number.isFinite)) throw new TypeError('Finite terrain origin coordinates required');
  const lat = Math.round((latitude + 90) * 10000);
  const lon = Math.round((longitude + 180) * 10000);
  return mix32(Math.imul(lat, 0x9e3779b1) ^ Math.imul(lon, 0x85ebca6b) ^ 0x47444f54);
}

/** Seam-free browser-local fallback relief. It deliberately stays below water datum. */
export function terrainHeightAt(x, z, seed = 0) {
  if (![x, z, seed].every(Number.isFinite)) throw new TypeError('Finite terrain sample required');
  const broad = valueNoise(x / 42, z / 42, seed ^ 0x243f6a88);
  const medium = valueNoise(x / 19, z / 19, seed ^ 0x85a308d3);
  const fine = valueNoise(x / 8.5, z / 8.5, seed ^ 0x13198a2e);
  const ridge = 1 - Math.abs(medium * 2 - 1);
  const relief = Math.max(0, Math.min(1, broad * .52 + medium * .25 + fine * .08 + ridge * .15));
  return GEO_TERRAIN_DEFAULTS.maximumHeight +
    (GEO_TERRAIN_DEFAULTS.minimumHeight - GEO_TERRAIN_DEFAULTS.maximumHeight) * relief;
}

export function queryTerrainSupport(x, z, seed = 0, out = {}) {
  const y = terrainHeightAt(x, z, seed);
  const distance = GEO_TERRAIN_DEFAULTS.normalSample;
  const dx = (terrainHeightAt(x + distance, z, seed) - terrainHeightAt(x - distance, z, seed)) / (distance * 2);
  const dz = (terrainHeightAt(x, z + distance, seed) - terrainHeightAt(x, z - distance, seed)) / (distance * 2);
  const inverseLength = 1 / Math.hypot(dx, 1, dz);
  out.x = x;
  out.y = y;
  out.z = z;
  out.normalX = -dx * inverseLength;
  out.normalY = inverseLength;
  out.normalZ = -dz * inverseLength;
  out.slopeRadians = Math.acos(Math.max(-1, Math.min(1, out.normalY)));
  out.walkable = out.slopeRadians <= GEO_TERRAIN_DEFAULTS.maxWalkableSlope;
  out.kind = 'terrain';
  out.physicalLevel = 0;
  return out;
}

export function resolveGroundTransition(fromX, fromZ, toX, toZ, seed = 0, {
  maxStepUp = GEO_TERRAIN_DEFAULTS.maxStepUp,
  maxStepDown = GEO_TERRAIN_DEFAULTS.maxStepDown,
  maxSlope = GEO_TERRAIN_DEFAULTS.maxWalkableSlope,
} = {}, out = {}) {
  if (![maxStepUp, maxStepDown, maxSlope].every(Number.isFinite) || maxStepUp < 0 || maxStepDown < 0 || maxSlope < 0) {
    throw new RangeError('Invalid ground-transition policy');
  }
  const from = queryTerrainSupport(fromX, fromZ, seed, out.from ?? {});
  const to = queryTerrainSupport(toX, toZ, seed, out.to ?? {});
  out.from = from;
  out.to = to;
  out.heightDelta = to.y - from.y;
  out.accepted = true;
  out.reason = 'accepted';
  if (to.slopeRadians > maxSlope) { out.accepted = false; out.reason = 'slope'; }
  else if (out.heightDelta > maxStepUp) { out.accepted = false; out.reason = 'step-up'; }
  else if (out.heightDelta < -maxStepDown) { out.accepted = false; out.reason = 'drop'; }
  return out;
}

export function buildTerrainGrid(bounds, seed = 0, resolution = GEO_TERRAIN_DEFAULTS.gridResolution) {
  if (!bounds || ![bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ, seed].every(Number.isFinite) ||
      bounds.maxX <= bounds.minX || bounds.maxZ <= bounds.minZ || !Number.isInteger(resolution) || resolution < 2 || resolution > 64) {
    throw new RangeError('Invalid terrain-grid request');
  }
  const vertexSide = resolution + 1;
  const positions = new Float32Array(vertexSide * vertexSide * 3);
  const normals = new Float32Array(vertexSide * vertexSide * 3);
  const indices = new Uint32Array(resolution * resolution * 6);
  let vertexOffset = 0;
  const support = {};
  for (let row = 0; row <= resolution; row++) for (let column = 0; column <= resolution; column++) {
    const x = bounds.minX + (bounds.maxX - bounds.minX) * column / resolution;
    const z = bounds.minZ + (bounds.maxZ - bounds.minZ) * row / resolution;
    queryTerrainSupport(x, z, seed, support);
    positions.set([x, support.y, z], vertexOffset);
    normals.set([support.normalX, support.normalY, support.normalZ], vertexOffset);
    vertexOffset += 3;
  }
  let indexOffset = 0;
  for (let row = 0; row < resolution; row++) for (let column = 0; column < resolution; column++) {
    const topLeft = row * vertexSide + column;
    const topRight = topLeft + 1;
    const bottomLeft = topLeft + vertexSide;
    const bottomRight = bottomLeft + 1;
    indices.set([topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight], indexOffset);
    indexOffset += 6;
  }
  return Object.freeze({ positions, normals, indices, resolution, seed });
}
