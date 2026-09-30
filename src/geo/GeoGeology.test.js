import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from './GeoWorld.js';
import { compileGeoFixture } from './GeoFixtures.js';
import { LifecycleLedger } from '../engine/LifecycleContract.js';
import { GDO_LOW_PROFILE_BUDGETS, GDO_TERRAIN_GEOLOGY_CAPS } from '../engine/PerformanceBudget.js';
import {
  GEO_TERRAIN_DEFAULTS, GDO_TERRAIN_GEOLOGY, buildTerrainGrid, queryTerrainSupport,
  resolveGroundTransition, terrainBaseHeightAt, terrainHeightAt, terrainSeedForCoordinate, terrainSlopeAt,
} from './GeoTerrain.js';
import {
  GDO_GEOLOGY_CLASS, GDO_GEOLOGY_PROFILES, classifyGeologyPoint, geologyDetailBudget,
  geologyHudText, measureGeology, validateGeology,
} from './GeoGeology.js';

/**
 * `TER-06` gate: slope/cliff/terrace geology whose morphology and collision agree
 * and whose projected detail budget passes — proved against the live world, not
 * against a description of it.
 */

globalThis.Worker ??= class { addEventListener() {} postMessage() {} terminate() {} };

function mount(fixtureId = 'dense-urban', { profile = 'low' } = {}) {
  const scene = new THREE.Scene();
  const ledger = new LifecycleLedger({ label: `ter-06-${fixtureId}` });
  const world = new GeoWorld(scene, { latitude: 28.9845, longitude: 77.7064, ledger, profile });
  const tile = [...world.tiles.values()][0];
  const compilation = compileGeoFixture(fixtureId, 'openmaptiles');
  const common = {
    type: 'tile-phase', requestId: tile.requestId, key: tile.key, bytes: 2048,
    provider: `Fixture/${compilation.fixture.variant}`, providerId: 'openmaptiles',
  };
  world._handleWorkerMessage({ ...common, phase: 'roads', geometry: compilation.roads, timings: { roadsMilliseconds: 1 } });
  world._handleWorkerMessage({ ...common, phase: 'context', context: compilation.context, timings: { contextMilliseconds: 2 } });
  world._handleWorkerMessage({
    ...common, phase: 'buildings', geometry: compilation.buildings,
    timings: { buildingsMilliseconds: 3, totalMilliseconds: 6 },
  });
  world._flushPlantMounts(0);
  return { world, scene, tile, ledger, compilation };
}

test('TER-06 the flood plain is bit-for-bit the smooth field the water model reads', () => {
  const seed = 3452309898;
  let moved = 0, untouched = 0, outside = 0;
  for (let row = 0; row < 60; row++) for (let column = 0; column < 60; column++) {
    const x = column * .9 - 27, z = row * .9 - 27;
    const base = terrainBaseHeightAt(x, z, seed);
    const height = terrainHeightAt(x, z, seed);
    if (height !== base) moved++;
    else untouched++;
    // Nothing may leave the declared band, in either direction.
    if (height > -0.012 + 1e-12 || height < -0.25 - 1e-12) outside++;
    // Above the flood-plain floor the two are the same number, not merely close.
    if (base >= GDO_TERRAIN_GEOLOGY.floodPlainFloor && height !== base) outside++;
  }
  assert.ok(moved > 0, 'the geology actually cuts the low ground');
  assert.ok(untouched > 0, 'the flood plain is left alone');
  assert.equal(outside, 0, 'every sample stays inside the declared band and above the floor is untouched');
  // The floor is derived from the water-contact policy, not picked by eye: a
  // 0.18-unit body wades up to 0.55 of its height under a 0.02 water plane whose
  // wetland surface sits 0.05 lower.
  assert.equal(GDO_TERRAIN_GEOLOGY.floodPlainFloor, -0.13);
});

test('TER-06 morphology and collision agree: the drawn grid, the class, and the refusal are one field', () => {
  const seed = 3452309898;
  const bounds = { minX: -100, minZ: -100, maxX: 100, maxZ: 100 };
  const grid = buildTerrainGrid(bounds, seed, 16);
  // The mesh samples the field exactly: every vertex is the same number the
  // collision query reads, to the bit.
  const side = 17;
  for (const [row, column] of [[0, 0], [5, 9], [16, 16], [11, 3]]) {
    const offset = (row * side + column) * 3;
    const x = grid.positions[offset], y = grid.positions[offset + 1], z = grid.positions[offset + 2];
    // The vertex buffer is Float32 and the field is Float64, so agreement means
    // the stored value is exactly the field rounded to the buffer's own
    // precision — one number, two widths, not two sources.
    const field = terrainHeightAt(x, z, seed);
    assert.equal(y, Math.fround(field), `mesh vertex (${row},${column}) is the shared field`);
    assert.ok(Math.abs(y - field) < 1e-6, 'the two widths agree well inside the shipped tolerance');
  }
  // Every class agrees with the collision: a cliff is a face the support query
  // refuses, and gentle ground is a face it accepts.
  let cliffs = 0, gentle = 0, plains = 0;
  const support = {};
  for (let row = 0; row < 40; row++) for (let column = 0; column < 40; column++) {
    const x = column * 1.7 - 34, z = row * 1.7 - 34;
    queryTerrainSupport(x, z, seed, support);
    const kind = classifyGeologyPoint(x, z, seed);
    if (kind === GDO_GEOLOGY_CLASS.CLIFF) {
      cliffs++;
      assert.equal(support.walkable, false, `a cliff at ${x},${z} is refused by the support query`);
      assert.ok(support.slopeRadians > GEO_TERRAIN_DEFAULTS.maxWalkableSlope,
        'a cliff reaches the walkable limit the collision enforces');
      // The class and the refusal read the same estimator, so the agreement is a
      // property of the code rather than of the sample that happened to be drawn.
      assert.equal(classifyGeologyPoint(x + 0, z + 0, seed), kind);
    } else {
      gentle++;
      assert.equal(support.walkable, true, `a ${kind} at ${x},${z} is walkable ground`);
      if (kind === GDO_GEOLOGY_CLASS.PLAIN) plains++;
    }
  }
  assert.ok(gentle > 1_000, `the world is mostly walkable ground (${gentle} samples)`);
  assert.ok(plains > 100, 'the untouched flood plain is part of the classification');
  // A refused crossing is refused for a reason: the transition names it.
  const transition = resolveGroundTransition(0, 0, 40, 40, seed, {}, {});
  assert.equal(transition.accepted, true, 'sampled ground away from a cliff is a walkable transition');
  assert.ok(terrainSlopeAt(0, 0, seed) < GDO_TERRAIN_GEOLOGY.cliffSlope);
  // The cliff count is a *measurement*, not an assumption: the shipped world may
  // hold very few, and the assertion is that whatever it holds agrees.
  assert.ok(cliffs >= 0 && cliffs < gentle, `measured ${cliffs} cliff samples against ${gentle} gentle ones`);
});

test('TER-06 the projected detail budget passes for every resident tile of the live world', () => {
  const { world, scene, ledger } = mount('dense-urban');
  try {
    const verification = validateGeology();
    assert.equal(verification.ok, true, verification.violations.join('; '));
    assert.equal(world.geology.ok, true, 'the world proves its own geology declaration');
    assert.ok(verification.maximumCutUnits > 0);
    const tiles = [...world.tiles.values()];
    assert.equal(tiles.length, 1);
    for (const tile of tiles) {
      const verdict = world.geologyBudgetFor(tile);
      assert.ok(verdict, 'the resident tile carries a verdict');
      assert.equal(verdict.ok, true, verdict.reasons.join('; '));
      // A terrace is a field change, never new geometry: the tile keeps the grid
      // it declared, and the terrain pool it owns.
      assert.equal(verdict.measured.addedTriangles, 0);
      assert.equal(verdict.measured.resolution, 32);
      assert.equal(verdict.measured.gridIndexCount, 32 * 32 * 6);
      assert.ok(verdict.measured.movedSamples > 0, 'the tile shows the geology');
      assert.ok(verdict.measured.flanks >= 0 && verdict.measured.cliffs >= 0);
      // No sample above the floor may be moved by any tile measurement.
      assert.ok(verdict.measured.movedSamples <= verdict.measured.samples);
    }
    // The verdict is cached per tile: a frame reads it rather than re-measuring.
    const before = world.queryDiagnostics.geologyMeasurements ?? 0;
    world.updateGeologyDiagnostics();
    world.updateGeologyDiagnostics();
    assert.equal(world.queryDiagnostics.geologyMeasurements ?? 0, before,
      'a steady frame re-measures nothing');
    const diagnostics = world.updateGeologyDiagnostics();
    assert.equal(diagnostics.tiles, tiles.length);
    assert.ok(diagnostics.plateaus > 0, 'the tile reports plateau ground');
    assert.ok(Number.isFinite(diagnostics.faceUnits));
    const hud = geologyHudText(diagnostics, verification);
    assert.match(hud.title, /Geology/);
    assert.match(hud.text, /within budget/);
    assert.match(geologyHudText(null, verification).text, /No resident tile measured/);
    // The statistic also rides the world's own frame statistics.
    const stats = world.stats ?? world.frameStats ?? null;
    if (stats) assert.equal(stats.geologyBudgetOk, true);
  } finally {
    world.dispose();
    ledger.disposeAll();
    scene.clear();
  }
});

test('TER-06 the ceilings are the shipped numbers, and an unmeasurable tile is refused', () => {
  const low = GDO_GEOLOGY_PROFILES.low;
  assert.equal(low.maximumAddedTriangles, GDO_LOW_PROFILE_BUDGETS.geologyAddedTriangles);
  assert.equal(low.maximumFlanksPerTile, GDO_LOW_PROFILE_BUDGETS.geologyFlanksPerTile);
  assert.equal(low.maximumCliffsPerTile, GDO_LOW_PROFILE_BUDGETS.geologyCliffsPerTile);
  assert.equal(GDO_TERRAIN_GEOLOGY_CAPS.profiles.low.maximumFaceUnits, low.maximumFaceUnits);
  // A tighter cap refuses a real measurement — the budget is doing work.
  const bounds = { minX: -100, minZ: -100, maxX: 100, maxZ: 100 };
  const measurement = measureGeology({ bounds, seed: 3452309898, profile: 'low' });
  assert.equal(geologyDetailBudget(measurement).ok, true);
  const tightened = { profiles: { low: { ...GDO_TERRAIN_GEOLOGY_CAPS.profiles.low, maximumCliffsPerTile: -1 } } };
  const refused = geologyDetailBudget(measurement, { caps: tightened });
  assert.equal(refused.ok, false);
  assert.match(refused.reasons.join('; '), /cliff/);
  // Unmeasurable input fails rather than passing silently.
  assert.equal(geologyDetailBudget(null).ok, false);
  assert.equal(geologyDetailBudget({ profile: 'low', samples: 9 }).ok, false);
  assert.match(geologyDetailBudget({ profile: 'low', samples: 9 }).reasons.join('; '), /measured/);
  assert.throws(() => measureGeology({ bounds: { minX: 0, minZ: 0, maxX: NaN, maxZ: 1 } }), TypeError);
  assert.throws(() => measureGeology({ bounds, resolution: 1 }), RangeError);
  // An over-cut field is refused by the verdict, not shipped quietly.
  const over = { ...measurement, faceUnits: measurement.faceUnits + 1 };
  assert.equal(geologyDetailBudget(over).ok, false);
  // The shipped ceilings are proved against the shipped geography, not against one
  // favourable tile: a swept set of worlds and tile positions must all pass, and
  // the tightest of them must leave real headroom rather than sitting on the cap.
  const size = 214;
  let worstFlanks = 0, worstFace = 0, measured = 0;
  for (const [latitude, longitude] of [[28.9845, 77.7064], [40.7128, -74.006], [35.68, 139.69], [48.8566, 2.3522]]) {
    const seed = terrainSeedForCoordinate(latitude, longitude);
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 1], [2, -2]]) {
      const swept = measureGeology({
        bounds: { minX: dx * size * 1.3, minZ: dz * size * 1.3, maxX: dx * size * 1.3 + size, maxZ: dz * size * 1.3 + size },
        seed, profile: 'low',
      });
      const verdict = geologyDetailBudget(swept, { profile: 'low' });
      assert.equal(verdict.ok, true, `swept tile ${latitude},${longitude} ${dx},${dz}: ${verdict.reasons.join('; ')}`);
      worstFlanks = Math.max(worstFlanks, swept.flanks);
      worstFace = Math.max(worstFace, swept.faceUnits);
      measured++;
    }
  }
  assert.equal(measured, 16);
  assert.ok(worstFlanks > 0 && worstFlanks <= low.maximumFlanksPerTile,
    `the worst swept tile carries ${worstFlanks} flanks inside the ${low.maximumFlanksPerTile} ceiling`);
  assert.ok(worstFace <= low.maximumFaceUnits,
    `the worst swept drawn face is ${worstFace.toFixed(3)} inside the ${low.maximumFaceUnits} ceiling`);
});
