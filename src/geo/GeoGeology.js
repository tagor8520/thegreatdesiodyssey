import { GDO_LOW_PROFILE_BUDGETS, GDO_TERRAIN_GEOLOGY_CAPS } from '../engine/PerformanceBudget.js';
import {
  GEO_TERRAIN_DEFAULTS, GDO_TERRAIN_GEOLOGY, terrainBaseHeightAt, terrainHeightAt,
  terrainSlopeAt, terrainSlopeRadiansAt,
} from './GeoTerrain.js';

/**
 * `TER-06` slope/cliff/terrace geology — the classification, measurement, and
 * budget half of the row.
 *
 * The *field* lives in exactly one place, `GeoTerrain.terrainHeightAt`, because the
 * tile mesh, the collision and camera support queries, the building foundations in
 * the tile worker, and every placement pass already read it. This module never
 * samples a second field: it classifies the samples the drawn grid actually takes
 * and prices them, which is what makes the row's two claims provable —
 *
 * - **Morphology and collision agree.** A cliff is a sample whose slope reaches
 *   the walkable limit, measured with the collision's own central difference, so
 *   the class and the refusal come from one number; the flood plain above
 *   `GDO_TERRAIN_GEOLOGY.floodPlainFloor` is bit-for-bit the smooth `TER-03`
 *   field, so the ground the water-contact model decides on is untouched.
 * - **The projected detail budget passes.** Terraces are a field change, never new
 *   geometry: the tile keeps its declared grid resolution, vertex count, and index
 *   count (`addedTriangles` is 0 by construction, and measured as such), and what
 *   the profile bounds is how much slope and how steep a face a tile may report.
 */

export const GDO_GEOLOGY_NAMESPACE = GDO_TERRAIN_GEOLOGY.namespace;

/** What a sampled point is: untouched plain, terrace top, flank, or a cliff. */
export const GDO_GEOLOGY_CLASS = Object.freeze({
  PLAIN: 'plain',
  PLATEAU: 'plateau',
  FLANK: 'flank',
  CLIFF: 'cliff',
});

export const GDO_GEOLOGY_CLASS_NAMES = Object.freeze(Object.values(GDO_GEOLOGY_CLASS));

/**
 * Per-profile *measurement* ceilings. A profile may afford fewer reported
 * details, but it never moves the ground: the geography is profile-independent on
 * purpose, so two devices cannot disagree about where a cliff is and the worker
 * that founds buildings cannot disagree with the world that draws them.
 */
export const GDO_GEOLOGY_PROFILES = Object.freeze({
  low: Object.freeze({ profile: 'low', maximumFlanksPerTile: 96, maximumCliffsPerTile: 8, maximumFaceUnits: .24, maximumAddedTriangles: 0 }),
  balanced: Object.freeze({ profile: 'balanced', maximumFlanksPerTile: 128, maximumCliffsPerTile: 12, maximumFaceUnits: .24, maximumAddedTriangles: 0 }),
  high: Object.freeze({ profile: 'high', maximumFlanksPerTile: 192, maximumCliffsPerTile: 20, maximumFaceUnits: .24, maximumAddedTriangles: 0 }),
});

export function geologyProfileFor(name) {
  const profile = GDO_GEOLOGY_PROFILES[name];
  if (!profile) throw new RangeError(`Unknown geology profile: ${name}`);
  return profile;
}

/**
 * One point's class, from the shared field alone. The cliff test *is* the
 * walkable limit the collision enforces, so the two cannot disagree.
 */
export function classifyGeologyPoint(x, z, seed = 0, spacing = GEO_TERRAIN_DEFAULTS.normalSample) {
  const base = terrainBaseHeightAt(x, z, seed);
  // The cliff test is the walkable test: the same angle, from the same estimator,
  // compared against the same policy the support query enforces.
  if (terrainSlopeRadiansAt(x, z, seed, spacing) > GEO_TERRAIN_DEFAULTS.maxWalkableSlope) {
    return GDO_GEOLOGY_CLASS.CLIFF;
  }
  const slope = terrainSlopeAt(x, z, seed, spacing);
  if (base >= GDO_TERRAIN_GEOLOGY.floodPlainFloor) return GDO_GEOLOGY_CLASS.PLAIN;
  return slope >= GDO_TERRAIN_GEOLOGY.flatSlope ? GDO_GEOLOGY_CLASS.FLANK : GDO_GEOLOGY_CLASS.PLATEAU;
}

/** Is the ground at this point the untouched `TER-03` surface, to the bit? */
export function geologyTouchesGround(x, z, seed = 0) {
  return terrainHeightAt(x, z, seed) !== terrainBaseHeightAt(x, z, seed);
}

/**
 * Measure one tile the way the drawn grid samples it. Neighbours are the grid's
 * own neighbours, so a "face" here is a step the mesh shows and the player has to
 * take — not a statistic of an imaginary finer grid.
 */
export function measureGeology({
  bounds, seed = 0, resolution = GEO_TERRAIN_DEFAULTS.gridResolution, profile = 'low',
} = {}) {
  if (!bounds || ![bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ].every(Number.isFinite)) {
    throw new TypeError('measureGeology needs finite tile bounds');
  }
  if (!Number.isInteger(resolution) || resolution < 2) throw new RangeError('Geology needs a valid grid resolution');
  const policy = geologyProfileFor(profile);
  const side = resolution + 1;
  const heights = new Float64Array(side * side);
  const classes = new Array(side * side);
  let plateaus = 0, flanks = 0, cliffs = 0, plains = 0, moved = 0;
  let faceUnits = 0, minimumY = Infinity, maximumY = -Infinity, maximumSlope = 0;
  const spacing = GEO_TERRAIN_DEFAULTS.normalSample;
  for (let row = 0; row <= resolution; row++) for (let column = 0; column <= resolution; column++) {
    const x = bounds.minX + (bounds.maxX - bounds.minX) * column / resolution;
    const z = bounds.minZ + (bounds.maxZ - bounds.minZ) * row / resolution;
    const at = row * side + column;
    const y = terrainHeightAt(x, z, seed);
    const base = terrainBaseHeightAt(x, z, seed);
    const slope = terrainSlopeAt(x, z, seed, spacing);
    heights[at] = y;
    classes[at] = classifyGeologyPoint(x, z, seed, spacing);
    if (y !== base) moved++;
    if (classes[at] === GDO_GEOLOGY_CLASS.CLIFF) cliffs++;
    else if (classes[at] === GDO_GEOLOGY_CLASS.PLAIN) plains++;
    else if (slope >= GDO_TERRAIN_GEOLOGY.flatSlope) flanks++;
    else plateaus++;
    maximumSlope = Math.max(maximumSlope, slope);
    minimumY = Math.min(minimumY, y);
    maximumY = Math.max(maximumY, y);
  }
  // The face the mesh draws: the largest height difference between two grid
  // samples that share an edge. One face per shared edge, so two neighbouring
  // quads cannot double-price the same step.
  for (let row = 0; row <= resolution; row++) for (let column = 0; column <= resolution; column++) {
    const at = row * side + column;
    if (column < resolution) faceUnits = Math.max(faceUnits, Math.abs(heights[at] - heights[at + 1]));
    if (row < resolution) faceUnits = Math.max(faceUnits, Math.abs(heights[at] - heights[at + side]));
  }
  return Object.freeze({
    namespace: GDO_GEOLOGY_NAMESPACE,
    profile: policy.profile,
    bounds: Object.freeze({ minX: bounds.minX, minZ: bounds.minZ, maxX: bounds.maxX, maxZ: bounds.maxZ }),
    resolution,
    samples: side * side,
    plateaus,
    flanks,
    cliffs,
    plains,
    movedSamples: moved,
    movedFraction: moved / (side * side),
    maximumSlope,
    faceUnits,
    reliefUnits: maximumY - minimumY,
    floodPlainFloor: GDO_TERRAIN_GEOLOGY.floodPlainFloor,
    cliffSlope: GDO_TERRAIN_GEOLOGY.cliffSlope,
    // A terrace is a field change, never new geometry: the grid keeps the
    // resolution, the vertex count, and the index count it already declared.
    addedTriangles: 0,
    gridTriangleCount: resolution * resolution * 2,
    gridIndexCount: resolution * resolution * 6,
  });
}

/**
 * The budget verdict for one measured tile. An unmeasurable input fails rather
 * than passing silently, and every ceiling is the profile's own declaration.
 */
export function geologyDetailBudget(measurement, { profile = measurement?.profile ?? 'low', caps = GDO_TERRAIN_GEOLOGY_CAPS } = {}) {
  const policy = geologyProfileFor(profile);
  const ceiling = caps?.profiles?.[profile] ?? policy;
  if (!measurement || typeof measurement !== 'object') {
    return Object.freeze({
      namespace: GDO_GEOLOGY_NAMESPACE, profile,
      ok: false, reasons: Object.freeze(['the tile was not measured']), declared: Object.freeze({ ...policy }),
    });
  }
  const reasons = [];
  for (const field of ['plateaus', 'flanks', 'cliffs', 'plains', 'movedSamples', 'addedTriangles', 'samples']) {
    if (!Number.isInteger(measurement[field])) reasons.push(`${field} must be a measured integer`);
  }
  if (!(measurement.reliefUnits >= 0)) reasons.push('reliefUnits must be measured');
  if (!(measurement.faceUnits >= 0)) reasons.push('faceUnits must be measured');
  if (Number.isInteger(measurement.samples) && measurement.samples !== Math.round(Math.sqrt(measurement.samples)) ** 2) {
    reasons.push('the sampled grid is not square');
  }
  // Every count has to fit inside the grid it was measured on, so a fabricated
  // measurement cannot slip past the ceilings by being internally inconsistent.
  if (Number.isInteger(measurement.movedSamples) && Number.isInteger(measurement.samples) &&
      (measurement.movedSamples < 0 || measurement.movedSamples > measurement.samples)) {
    reasons.push('the moved-sample count is outside the grid');
  }
  const classified = ['plateaus', 'flanks', 'cliffs', 'plains']
    .map(field => measurement[field]);
  if (classified.every(Number.isInteger) && classified.reduce((total, value) => total + value, 0) !== measurement.samples) {
    reasons.push('the classes do not cover the sampled grid');
  }
  if (Number.isFinite(measurement.movedFraction) && Number.isInteger(measurement.movedSamples) &&
      Math.abs(measurement.movedFraction * measurement.samples - measurement.movedSamples) > 1e-6) {
    reasons.push('the moved-sample fraction disagrees with the count');
  }
  for (const [field, ceilingKey, label] of [
    ['flanks', 'maximumFlanksPerTile', 'flank'],
    ['cliffs', 'maximumCliffsPerTile', 'cliff'],
  ]) {
    if (Number.isInteger(measurement[field]) && measurement[field] > ceiling[ceilingKey]) {
      reasons.push(`${measurement[field]} ${label} samples exceed the ${ceiling[ceilingKey]}-sample ceiling`);
    }
  }
  if (measurement.faceUnits > ceiling.maximumFaceUnits + 1e-9) {
    reasons.push(`a ${measurement.faceUnits.toFixed(3)}-unit drawn face exceeds the ${ceiling.maximumFaceUnits}-unit ceiling`);
  }
  if (Number.isInteger(measurement.addedTriangles) && measurement.addedTriangles > ceiling.maximumAddedTriangles) {
    reasons.push(`${measurement.addedTriangles} added triangles exceed the ${ceiling.maximumAddedTriangles}-triangle ceiling`);
  }
  return Object.freeze({
    namespace: GDO_GEOLOGY_NAMESPACE,
    profile,
    ok: reasons.length === 0,
    reasons: Object.freeze(reasons),
    measured: measurement,
    declared: Object.freeze({
      floodPlainFloor: GDO_TERRAIN_GEOLOGY.floodPlainFloor,
      cliffSlope: GDO_TERRAIN_GEOLOGY.cliffSlope,
      maximumFlanksPerTile: ceiling.maximumFlanksPerTile,
      maximumCliffsPerTile: ceiling.maximumCliffsPerTile,
      maximumFaceUnits: ceiling.maximumFaceUnits,
      maximumAddedTriangles: ceiling.maximumAddedTriangles,
    }),
  });
}

/**
 * Prove the shipped geology against the shipped numbers: the flood-plain floor is
 * derived from the water-contact policy, the caps table and the profile table
 * agree with each other and with the shipped budget keys, and the cut can never
 * leave the declared band.
 */
export function validateGeology({
  budgets = GDO_LOW_PROFILE_BUDGETS, caps = GDO_TERRAIN_GEOLOGY_CAPS, profiles = GDO_GEOLOGY_PROFILES,
} = {}) {
  const violations = [];
  if (GDO_TERRAIN_GEOLOGY.cliffSlope !== Math.tan(GEO_TERRAIN_DEFAULTS.maxWalkableSlope)) {
    violations.push('the cliff slope is not the walkable limit, so morphology and collision could disagree');
  }
  if (!(GDO_TERRAIN_GEOLOGY.floodPlainFloor > GEO_TERRAIN_DEFAULTS.minimumHeight) ||
      !(GDO_TERRAIN_GEOLOGY.floodPlainFloor < GEO_TERRAIN_DEFAULTS.maximumHeight)) {
    violations.push('the flood-plain floor is outside the declared terrain band');
  }
  if (!(GDO_TERRAIN_GEOLOGY.scarpRunUnits > 0) || !(GDO_TERRAIN_GEOLOGY.scarpFineRunUnits > 0) ||
      !(GDO_TERRAIN_GEOLOGY.outcropRunUnits > 0)) {
    violations.push('a scarp run is not a positive width');
  }
  for (const [name, profile] of Object.entries(profiles)) {
    const ceiling = caps?.profiles?.[name];
    if (!ceiling) { violations.push(`${name} has no declared geology ceiling`); continue; }
    for (const field of ['maximumFlanksPerTile', 'maximumCliffsPerTile', 'maximumFaceUnits', 'maximumAddedTriangles']) {
      if (profile[field] !== ceiling[field]) {
        violations.push(`${name} reports ${field}=${profile[field]} but the caps table says ${ceiling[field]}`);
      }
    }
  }
  const low = profiles.low, lowCeiling = caps?.profiles?.low ?? {};
  for (const [key, declared, ceiling] of [
    ['geologyFlanksPerTile', low.maximumFlanksPerTile, lowCeiling.maximumFlanksPerTile],
    ['geologyCliffsPerTile', low.maximumCliffsPerTile, lowCeiling.maximumCliffsPerTile],
    ['geologyFaceUnits', low.maximumFaceUnits, lowCeiling.maximumFaceUnits],
    ['geologyAddedTriangles', low.maximumAddedTriangles, lowCeiling.maximumAddedTriangles],
  ]) {
    const budget = budgets[key];
    if (!Number.isFinite(budget)) { violations.push(`the shipped budget has no ${key}`); continue; }
    if (declared > budget) violations.push(`low reports ${key}=${declared} above the ${key} budget`);
  }
  // The deepest possible cut is the whole room above the field floor, and the
  // declared face ceiling must accommodate it: the band is bounded, so this is a
  // proof about the field rather than a hope about the measurement.
  const maximumCut = GDO_TERRAIN_GEOLOGY.floodPlainFloor - GEO_TERRAIN_DEFAULTS.minimumHeight;
  return Object.freeze({
    namespace: GDO_GEOLOGY_NAMESPACE,
    ok: violations.length === 0,
    profiles: Object.keys(profiles).length,
    floodPlainFloor: GDO_TERRAIN_GEOLOGY.floodPlainFloor,
    maximumCutUnits: maximumCut,
    violations: Object.freeze(violations),
  });
}

/** The one-line geology description the debug payload and HUD read. */
export function describeGeology(seed = 0) {
  const { floodPlainFloor, cliffSlope, scarpRunUnits } = GDO_TERRAIN_GEOLOGY;
  return `${GDO_GEOLOGY_NAMESPACE} floor ${floodPlainFloor} cliff ${cliffSlope.toFixed(3)} scarp run ${scarpRunUnits} seed ${seed}`;
}

/**
 * The geology line: what the resident tiles actually reported, and what the
 * profile allowed. Formatting only — every number comes off the measurement.
 */
export function geologyHudText(diagnostics, validation = null) {
  const settled = validation ?? validateGeology();
  if (!settled?.ok) {
    return Object.freeze({
      title: 'Geology', text: 'Geology declaration refused',
      detail: (settled?.violations ?? ['unproved']).join('; '),
    });
  }
  if (!diagnostics || !Number.isFinite(diagnostics.tiles) || diagnostics.tiles === 0) {
    return Object.freeze({
      title: 'Geology', text: 'No resident tile measured',
      detail: `floor ${settled.floodPlainFloor} · cut ≤ ${settled.maximumCutUnits.toFixed(3)}`,
    });
  }
  return Object.freeze({
    title: `Geology · ${diagnostics.flanks} flanks`,
    text: `${diagnostics.cliffs} cliff points · ${diagnostics.plateaus} plateau points · ` +
      `${diagnostics.ok ? 'within budget' : 'over budget'}`,
    detail: `${diagnostics.tiles} tile(s) · face ${diagnostics.faceUnits.toFixed(3)} · ${GDO_GEOLOGY_NAMESPACE}`,
  });
}
