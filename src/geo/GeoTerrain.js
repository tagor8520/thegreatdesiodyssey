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

/**
 * `TER-06` slope/cliff/terrace geology, as constants of the one shared field.
 *
 * This is deliberately *not* a profile setting. A device profile may draw less
 * detail, but it may not move the ground the player walks on: if the geology
 * varied per profile, two devices would disagree about where a cliff is, and the
 * tile worker that founds buildings would disagree with the world that draws and
 * collides them. Profiles bound *measurement*, never geography. Every number here
 * is a pure function of `(x, z, seed)`.
 *
 * Two rules shape the field:
 *
 * - **The flood plain is untouched.** `GEO_SURFACE_Y.WATER` is an absolute plane
 *   and the water-contact model decides dry/wading/swimming from the ground
 *   height under it, so the ground the model can still call *wet or wading* is
 *   the top of the shipped relief band. `floodPlainFloor` is derived from that
 *   policy (water plane − wetland depth − the wading depth the body tolerates),
 *   and no sample at or above it is ever moved. The geology therefore shapes the
 *   ground *below* the water model's own reading, and the wading band survives by
 *   construction rather than by luck.
 * - **Faces stay inside the walkable policy.** The cut is bounded by the room the
 *   field has down to its own floor, and its flanks are aimed at a declared
 *   fraction of the walkable limit, so the geology does not invent faces the
 *   collision would silently refuse. Where a face still reaches the walkable
 *   limit — `cliffSlope` *is* that limit — the module classifies it as a cliff,
 *   and the collision refuses it through the same test.
 */

/**
 * `TER-06` slope/cliff/terrace geology, as constants of the one shared field.
 *
 * This is deliberately *not* a profile setting. A device profile may draw less
 * detail, but it may not move the ground the player walks on: if the geology
 * varied per profile, two devices would disagree about where a cliff is, and the
 * tile worker that founds buildings would disagree with the world that draws and
 * collides them. Profiles bound *measurement*, never geography. Every number here
 * is a pure function of `(x, z, seed)`.
 *
 * Two rules shape the field:
 *
 * - **The flood plain is untouched.** `GEO_SURFACE_Y.WATER` is an absolute plane
 *   and the water-contact model decides dry/wading/swimming from the ground under
 *   it, so the ground the model can still call *wet or wading* is the top of the
 *   shipped relief band. `floodPlainFloor` is derived from that policy (water
 *   plane − wetland depth − the wading depth a body tolerates), and no sample at
 *   or above it is ever moved. The geology therefore shapes the ground *below*
 *   the water model's own reading, and the wading band survives by construction
 *   rather than by luck.
 * - **Faces stay inside the walkable policy.** The cut is bounded by the room the
 *   field has left above its own floor, and its flanks are aimed below the
 *   walkable limit, so the geology does not invent faces the collision would
 *   silently refuse. Where a face still reaches the limit — `cliffSlope` *is*
 *   that limit — `GeoGeology` classifies it as a cliff and the collision refuses
 *   it through the same test.
 */
export const GDO_TERRAIN_GEOLOGY = Object.freeze({
  namespace: 'gdo:terrainGeology:v1',
  // The highest ground the water-contact model can still call wet: water plane
  // (0.02) − wetland depth (0.05) − the wading depth a 0.18-unit body tolerates
  // (0.55 × 0.18). Above this floor the field is untouched.
  floodPlainFloor: -.13,
  cliffSlope: Math.tan(GEO_TERRAIN_DEFAULTS.maxWalkableSlope),
  flatSlope: .03,
  // The scarp system: seeded linear escarpments, `scarpRunUnits` wide, cutting up
  // to the room the ground has left above the field floor.
  scarpScale: 42,
  scarpRunUnits: .9,
  scarpWeight: .72,
  // A second, finer scarp family whose edges can stack on the first, which is
  // where a face can reach the walkable limit and become a cliff.
  scarpFineScale: 15,
  scarpFineRunUnits: .45,
  scarpFineWeight: .28,
  // Gentle outcrops that give the cut ground its broad steps.
  outcropScale: 27,
  outcropRunUnits: 3.2,
  outcropWeight: .22,
  // The flanks are aimed below the walkable limit, so the shipped geography does
  // not hide an unwalkable face behind a walkable-looking slope.
  flankTargetSlope: .55,
});

function ramp(value) {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/**
 * The scarp/outcrop system the low ground is cut by: seeded linear escarpments —
 * continuous, so the drawn ground, the collision, and every draped surface follow
 * the same field — whose edges can stack where the two scarp families cross. Pure
 * in `(x, z, seed)` and bounded to `[0, 1]`.
 */
export function terrainCutAt(x, z, seed = 0) {
  const geology = GDO_TERRAIN_GEOLOGY;
  const scarp = valueNoise(x / geology.scarpScale, z / geology.scarpScale, seed ^ 0x9e3779b9);
  const fine = valueNoise(x / geology.scarpFineScale, z / geology.scarpFineScale, seed ^ 0x0b1d3f7a);
  const outcrop = valueNoise(x / geology.outcropScale, z / geology.outcropScale, seed ^ 0x1f123bb5);
  const run = geology.scarpRunUnits / geology.scarpScale;
  const fineRun = geology.scarpFineRunUnits / geology.scarpFineScale;
  const outcropRun = geology.outcropRunUnits / geology.outcropScale;
  // Each term is a *terrace edge*: a step up over its own run, held, then a step
  // down, so the cut ground reads as plateaus with flanks rather than as a wave.
  const first = ramp((scarp - (.5 - run / 2)) / run) - ramp((scarp - (.72 - run / 2)) / run);
  const second = ramp((fine - (.5 - fineRun / 2)) / fineRun) - ramp((fine - (.74 - fineRun / 2)) / fineRun);
  const third = ramp((outcrop - (.54 - outcropRun / 2)) / outcropRun);
  return Math.max(0, Math.min(1,
    first * geology.scarpWeight + second * geology.scarpFineWeight + third * geology.outcropWeight));
}

/** The smooth (ungeological) `TER-03` surface, before `TER-06` touches it. */
export function terrainBaseHeightAt(x, z, seed = 0) {
  if (![x, z, seed].every(Number.isFinite)) throw new TypeError('Finite terrain sample required');
  const broad = valueNoise(x / 42, z / 42, seed ^ 0x243f6a88);
  const medium = valueNoise(x / 19, z / 19, seed ^ 0x85a308d3);
  const fine = valueNoise(x / 8.5, z / 8.5, seed ^ 0x13198a2e);
  const ridge = 1 - Math.abs(medium * 2 - 1);
  const relief = Math.max(0, Math.min(1, broad * .52 + medium * .25 + fine * .08 + ridge * .15));
  return GEO_TERRAIN_DEFAULTS.maximumHeight +
    (GEO_TERRAIN_DEFAULTS.minimumHeight - GEO_TERRAIN_DEFAULTS.maximumHeight) * relief;
}

/** The smooth field's own slope, the test that decides flank versus cliff. */
export function terrainBaseSlopeAt(x, z, seed = 0, spacing = GEO_TERRAIN_DEFAULTS.normalSample) {
  const dx = (terrainBaseHeightAt(x + spacing, z, seed) - terrainBaseHeightAt(x - spacing, z, seed)) / (spacing * 2);
  const dz = (terrainBaseHeightAt(x, z + spacing, seed) - terrainBaseHeightAt(x, z - spacing, seed)) / (spacing * 2);
  return Math.hypot(dx, dz);
}

/**
 * How far the geology cuts, in world units, at a point. The flood plain is
 * untouchable, so a sample at or above the floor cuts by exactly zero and stays
 * bit-for-bit the smooth field.
 */
export function terrainCutUnitsAt(x, z, seed = 0) {
  const base = terrainBaseHeightAt(x, z, seed);
  if (base >= GDO_TERRAIN_GEOLOGY.floodPlainFloor) return 0;
  return Math.max(0, base - GEO_TERRAIN_DEFAULTS.minimumHeight) * terrainCutAt(x, z, seed);
}

/**
 * The cut field's own gradient, measured with the same central difference the
 * collision uses, so a face this module calls a cliff is a face the collision
 * refuses.
 */
export function terrainCutSlopeAt(x, z, seed = 0, spacing = GEO_TERRAIN_DEFAULTS.normalSample) {
  const dx = (terrainCutUnitsAt(x + spacing, z, seed) - terrainCutUnitsAt(x - spacing, z, seed)) / (spacing * 2);
  const dz = (terrainCutUnitsAt(x, z + spacing, seed) - terrainCutUnitsAt(x, z - spacing, seed)) / (spacing * 2);
  return Math.hypot(dx, dz);
}

/**
 * The one slope estimator: the field's central difference at the declared normal
 * sample distance. The support query, the walkability test, and `TER-06`'s cliff
 * classification all read this, so "too steep to walk" and "a cliff" are the same
 * comparison on the same number instead of two similar ones.
 */
export function terrainGradientAt(x, z, seed = 0, spacing = GEO_TERRAIN_DEFAULTS.normalSample) {
  if (![x, z, spacing].every(Number.isFinite) || spacing <= 0) throw new TypeError('Finite slope query required');
  const dx = (terrainHeightAt(x + spacing, z, seed) - terrainHeightAt(x - spacing, z, seed)) / (spacing * 2);
  const dz = (terrainHeightAt(x, z + spacing, seed) - terrainHeightAt(x, z - spacing, seed)) / (spacing * 2);
  return { dx, dz, slope: Math.hypot(dx, dz) };
}

/** The field's slope as a gradient (rise over run), for reporting. */
export function terrainSlopeAt(x, z, seed = 0, spacing = GEO_TERRAIN_DEFAULTS.normalSample) {
  return terrainGradientAt(x, z, seed, spacing).slope;
}

/**
 * The field's slope as the angle the collision compares against the walkable
 * policy — the identical expression the support query uses, so a sample this
 * module refuses and the collision refuses cannot differ by a rounding step.
 */
export function terrainSlopeRadiansAt(x, z, seed = 0, spacing = GEO_TERRAIN_DEFAULTS.normalSample) {
  const { dx, dz } = terrainGradientAt(x, z, seed, spacing);
  return Math.acos(Math.max(-1, Math.min(1, 1 / Math.hypot(dx, 1, dz))));
}

/**
 * Seam-free browser-local fallback relief with `TER-06` geology: the flood plain
 * exactly as `TER-03` graded it, and the ground below it cut into terraces whose
 * flanks are bounded by the walkable policy. Every consumer in the project reads
 * this one function — the tile mesh, the collision and camera support queries, the
 * building foundations in the tile worker, and the prop/vegetation placement
 * passes — so morphology and collision cannot drift apart.
 */
export function terrainHeightAt(x, z, seed = 0) {
  const base = terrainBaseHeightAt(x, z, seed);
  if (base >= GDO_TERRAIN_GEOLOGY.floodPlainFloor) return base;
  return base - Math.max(0, base - GEO_TERRAIN_DEFAULTS.minimumHeight) * terrainCutAt(x, z, seed);
}

export function queryTerrainSupport(x, z, seed = 0, out = {}) {
  const y = terrainHeightAt(x, z, seed);
  const { dx, dz } = terrainGradientAt(x, z, seed);
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
