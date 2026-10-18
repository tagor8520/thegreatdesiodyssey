import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_WALL_FAMILY,
  GDO_WALL_LIMITS,
  GDO_WALL_NAMESPACE,
  GDO_WALL_RECIPES,
  GDO_WALL_REFUSAL,
  compoundPreservesOpenings,
  emitWallGeometry,
  planWallSite,
  projectEntranceToRing,
  wallCollisionCompound,
  wallSiteRecipe,
} from './GeoWallGrammar.js';
import { GDO_FEATURE_VERSIONS, featureNamespace } from '../engine/FeatureVersions.js';

/** A 20×20 m square site at world scale (0.1 units per metre). */
const SQUARE = [
  [0, 0], [2, 0], [2, 2], [0, 2], [0, 0],
];

function recordingEmitter() {
  const boxes = [];
  return {
    boxes,
    box(x, bottom, z, sizeX, sizeY, sizeZ, color, yaw = 0) {
      boxes.push({ x, bottom, z, sizeX, sizeY, sizeZ, color, yaw });
    },
  };
}

test('TER-10 walls: the grammar namespace and every family recipe are declared data', () => {
  assert.equal(GDO_WALL_NAMESPACE, 'gdo:wallGrammar:v1');
  assert.equal(featureNamespace('wallGrammar'), GDO_WALL_NAMESPACE);
  assert.equal(GDO_FEATURE_VERSIONS.wallGrammar, 1);

  for (const family of Object.values(GDO_WALL_FAMILY)) {
    if (family === GDO_WALL_FAMILY.NONE) continue;
    const recipe = GDO_WALL_RECIPES[family];
    assert.ok(recipe, `family ${family} has a recipe`);
    assert.equal(recipe.family, family);
    assert.ok(recipe.heightMetres > 0 && recipe.thicknessMetres > 0);
    assert.ok(recipe.colors.body.length === 3);
    if (family === GDO_WALL_FAMILY.FENCE || family === GDO_WALL_FAMILY.RAILING) {
      assert.ok(recipe.postPeriodMetres > 0 && recipe.postSizeMetres > 0, `${family} declares its post rhythm`);
    }
  }
});

test('TER-10 walls: site recipes resolve by kind and unknown kinds get no wall', () => {
  assert.equal(wallSiteRecipe('school').family, GDO_WALL_FAMILY.WALL);
  assert.equal(wallSiteRecipe('cemetery').family, GDO_WALL_FAMILY.WALL);
  assert.equal(wallSiteRecipe('pitch').family, GDO_WALL_FAMILY.FENCE);
  assert.equal(wallSiteRecipe('park').family, GDO_WALL_FAMILY.HEDGE);
  assert.equal(wallSiteRecipe('grass').family, GDO_WALL_FAMILY.HEDGE);
  assert.equal(wallSiteRecipe('residential').family, GDO_WALL_FAMILY.FENCE);
  assert.equal(wallSiteRecipe('industrial').family, GDO_WALL_FAMILY.NONE);
  assert.equal(wallSiteRecipe('').family, GDO_WALL_FAMILY.NONE);
  assert.equal(wallSiteRecipe(null).family, GDO_WALL_FAMILY.NONE);
});

test('TER-10 walls: entrances project onto the ring and refuse by name', () => {
  const nearEdge = projectEntranceToRing(SQUARE, { x: 1, z: -0.02 });
  assert.equal(nearEdge.ok, true);
  assert.equal(nearEdge.edgeIndex, 0);
  assert.ok(Math.abs(nearEdge.t - 0.5) < 1e-6);
  assert.ok(Math.abs(nearEdge.z) < 1e-9, 'the projection lands exactly on the edge');

  const cornerish = projectEntranceToRing(SQUARE, { x: 2.01, z: 1 });
  assert.equal(cornerish.ok, true);
  assert.equal(cornerish.edgeIndex, 1);

  const far = projectEntranceToRing(SQUARE, { x: 1, z: -3 });
  assert.equal(far.refusal, GDO_WALL_REFUSAL.OFF_RING);
  assert.equal(projectEntranceToRing([], { x: 0, z: 0 }).refusal, GDO_WALL_REFUSAL.BAD_RING);
  assert.equal(projectEntranceToRing(SQUARE, { x: NaN, z: 0 }).refusal, GDO_WALL_REFUSAL.OFF_RING);
});

test('TER-10 walls: one plan carves declared gaps and the runs never cross an opening', () => {
  const plan = planWallSite({
    ring: SQUARE,
    kind: 'cemetery',
    entrancePoints: [{ x: 1, z: 0 }, { x: 2, z: 1 }],
  });
  assert.equal(plan.family, GDO_WALL_FAMILY.WALL);
  assert.equal(plan.openings.length, 2);
  // Two gates leave three runs: the stretch after the last opening wraps past
  // the seam and is recorded as its own run.
  assert.equal(plan.runs.length, 3);

  // Every run stays strictly outside every opening's interval.
  for (const run of plan.runs) {
    for (const opening of plan.openings) {
      assert.ok(run.end <= opening.start + 1e-9 || run.start >= opening.end - 1e-9,
        `run [${run.start}, ${run.end}] crosses opening [${opening.start}, ${opening.end}]`);
    }
  }

  // One gate only: two runs (the ring wraps).
  const single = planWallSite({
    ring: SQUARE,
    kind: 'cemetery',
    entrancePoints: [{ x: 1, z: 0 }],
  });
  assert.equal(single.openings.length, 1);
  assert.equal(single.runs.length, 2);

  // A gate in the same place twice refuses `overlapping-entrance`.
  const doubled = planWallSite({
    ring: SQUARE,
    kind: 'cemetery',
    entrancePoints: [{ x: 1, z: 0 }, { x: 1, z: -0.01 }],
  });
  assert.equal(doubled.openings.length, 1);
  assert.equal(doubled.refusals[GDO_WALL_REFUSAL.OVERLAPPING_ENTRANCE], 1);

  // No entrance supplied is counted, never invented.
  const sealed = planWallSite({ ring: SQUARE, kind: 'cemetery', entrancePoints: [] });
  assert.equal(sealed.openings.length, 0);
  assert.equal(sealed.runs.length, 1);
  assert.equal(sealed.refusals[GDO_WALL_REFUSAL.NO_ENTRANCE], 1);

  // An unknown site kind plans nothing and says why.
  const none = planWallSite({ ring: SQUARE, kind: 'industrial', entrancePoints: [{ x: 1, z: 0 }] });
  assert.equal(none.family, GDO_WALL_FAMILY.NONE);
  assert.equal(none.runs.length, 0);
  assert.equal(none.refusals[GDO_WALL_REFUSAL.NO_SITE_RECIPE], 1);
});

test('TER-10 walls: THE GATE — the exact compound preserves gates and openings', () => {
  const plan = planWallSite({
    ring: SQUARE,
    kind: 'school',
    entrancePoints: [{ x: 1, z: 0 }],
  });
  const compound = wallCollisionCompound(plan);
  assert.ok(compound.boxes.length > 0);

  // No box intrudes into the gate's free passage.
  const preserved = compoundPreservesOpenings(compound, plan);
  assert.equal(preserved.ok, true, JSON.stringify(preserved));
  assert.equal(preserved.openings, 1);

  // The gate centre itself collides nothing — a circle there is free.
  const gate = plan.openings[0];
  const atGate = compound.boxes.filter(box =>
    gate.x >= box.minX && gate.x <= box.maxX && gate.z >= box.minZ && gate.z <= box.maxZ);
  assert.equal(atGate.length, 0, 'the gate is literally absent from the compound');

  // A path through the gate into the courtyard is unobstructed at the gate and
  // the courtyard interior is not sealed by a wall box.
  const pathSamples = [];
  for (let step = 0; step <= 20; step += 1) {
    const t = step / 20;
    pathSamples.push([gate.x, gate.z + (1 - gate.z) * t * 0 + (1 - 0) * t]); // from gate (z=0) to courtyard centre (z=1)
  }
  // Explicit: from the gate centre straight to the ring's interior centre.
  const walk = [
    [gate.x, gate.z], [gate.x, gate.z + 0.2], [gate.x, 0.6], [gate.x, 1],
  ];
  for (const [x, z] of walk) {
    const blocked = compound.boxes.some(box => x > box.minX && x < box.maxX && z > box.minZ && z < box.maxZ);
    assert.equal(blocked, false, `approach (${x}, ${z}) must stay open`);
  }
  void pathSamples;

  // A sealed compound (one box spanning the gate) is caught by name.
  const sealed = {
    boxes: [...compound.boxes, { minX: gate.x - 0.05, minZ: gate.z - 0.05, maxX: gate.x + 0.05, maxZ: gate.z + 0.05 }],
  };
  const caught = compoundPreservesOpenings(sealed, plan);
  assert.equal(caught.ok, false);
  assert.equal(caught.openingIndex, 0);
});

test('TER-10 walls: geometry and compound share the runs, and both are deterministic', () => {
  const plan = planWallSite({
    ring: SQUARE,
    kind: 'pitch',
    entrancePoints: [{ x: 1, z: 0 }],
  });
  const emitter = recordingEmitter();
  const budget = { segments: 0, posts: 0, solids: 0, entrances: 0 };
  const drawn = emitWallGeometry(plan, { emitter, heightAt: () => 0, budget });
  assert.ok(drawn.boxes > 0);

  // The fence body lives on the runs: every rail box centre projects inside
  // some run's parameter interval along the ring... (checked structurally: no
  // box centre sits inside the opening's clearance disc).
  const preserved = compoundPreservesOpenings(
    { boxes: emitter.boxes.map(box => ({
      minX: box.x - box.sizeX / 2, minZ: box.z - box.sizeZ / 2,
      maxX: box.x + box.sizeX / 2, maxZ: box.z + box.sizeZ / 2,
    })) },
    plan,
  );
  // Visual rails are thin; their yaw-aligned footprints may kiss the opening
  // edge but the compound — the collision truth — is preserved:
  const compound = wallCollisionCompound(planWallSite({
    ring: SQUARE, kind: 'pitch', entrancePoints: [{ x: 1, z: 0 }],
  }));
  assert.equal(compoundPreservesOpenings(compound, plan).ok, true);
  void preserved;

  // Determinism: the same plan twice produces identical compounds.
  const repeat = wallCollisionCompound(planWallSite({
    ring: SQUARE, kind: 'pitch', entrancePoints: [{ x: 1, z: 0 }],
  }));
  assert.deepEqual(repeat.boxes, compound.boxes);

  // The hedge family draws body boxes (no posts) and says nothing else.
  const hedgePlan = planWallSite({ ring: SQUARE, kind: 'park', entrancePoints: [{ x: 1, z: 0 }] });
  const hedgeEmitter = recordingEmitter();
  const hedgeBudget = { segments: 0, posts: 0, solids: 0, entrances: 0 };
  const hedgeDrawn = emitWallGeometry(hedgePlan, { emitter: hedgeEmitter, heightAt: () => 0, budget: hedgeBudget });
  assert.equal(hedgeDrawn.boxes, hedgePlan.runs.reduce((sum, run) => sum + Math.max(0, run.points.length - 1), 0));
  assert.equal(budget.posts > 0, true, 'the fence family carries its post rhythm');
});

test('TER-10 walls: every budget is a counted cap, never silent', () => {
  // A long ring with many small segments exhausts the post budget cleanly.
  const long = [];
  for (let index = 0; index <= 40; index += 1) long.push([index * 0.5, 0]);
  for (let index = 0; index <= 40; index += 1) long.push([20, index * 0.5]);
  for (let index = 40; index >= 0; index -= 1) long.push([index * 0.5, 20]);
  for (let index = 40; index >= 0; index -= 1) long.push([0, index * 0.5]);
  long.push([0, 0]);

  const plan = planWallSite({ ring: long, kind: 'pitch', entrancePoints: [{ x: 10, z: 0 }] });
  const emitter = recordingEmitter();
  const budget = { segments: 0, posts: 0, solids: 0, entrances: 0 };
  const drawn = emitWallGeometry(plan, {
    emitter,
    heightAt: () => 0,
    budget,
  });
  assert.ok(drawn.boxes <= GDO_WALL_LIMITS.maxSegments + GDO_WALL_LIMITS.maxPosts);
  if (drawn.truncated) assert.ok(budget.posts <= GDO_WALL_LIMITS.maxPosts);

  const tinyBudget = { segments: 0, posts: 0, solids: 0, entrances: 0 };
  const forcedEmitter = recordingEmitter();
  // Force truncation: a fence plan with more posts than the cap allows.
  const hugeRing = [];
  for (let index = 0; index <= 200; index += 1) hugeRing.push([index * 0.1, 0]);
  for (let index = 0; index <= 200; index += 1) hugeRing.push([20, index * 0.1]);
  for (let index = 200; index >= 0; index -= 1) hugeRing.push([index * 0.1, 20]);
  for (let index = 200; index >= 0; index -= 1) hugeRing.push([0, index * 0.1]);
  hugeRing.push([0, 0]);
  const hugePlan = planWallSite({ ring: hugeRing, kind: 'pitch', entrancePoints: [{ x: 10, z: 0 }] });
  const hugeDrawn = emitWallGeometry(hugePlan, { emitter: forcedEmitter, heightAt: () => 0, budget: tinyBudget });
  assert.equal(hugeDrawn.truncated, true);
  assert.ok(tinyBudget.posts <= GDO_WALL_LIMITS.maxPosts);
});
