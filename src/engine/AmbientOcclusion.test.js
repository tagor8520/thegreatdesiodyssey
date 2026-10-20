import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from '../geo/GeoWorld.js';
import {
  GDO_AO_CATEGORY_WEIGHTS,
  GDO_AO_NAMESPACE,
  GDO_AO_PROFILES,
  GDO_AO_REFUSAL,
  GDO_AO_STRATEGY,
  bakeContactOcclusion,
  benchmarkAmbientOcclusion,
  createContactAnchors,
  estimateContactAnchorCost,
  estimateScreenSpaceCost,
  estimateVertexBakeCost,
} from './AmbientOcclusion.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

const SCENE = Object.freeze({ props: 60, facades: 40, terrain: 20, vertices: 900 });

test('ENV-07 prices every strategy in machine-independent units', () => {
  assert.equal(GDO_AO_NAMESPACE, 'gdo:ambientOcclusion:v1');
  assert.deepEqual(Object.values(GDO_AO_STRATEGY).sort(),
    ['contact-anchors', 'none', 'screen-space', 'vertex-bake']);
  // Coverage weights are a design input, exported so a later row can re-run the
  // decision instead of arguing with a hidden number.
  assert.deepEqual(GDO_AO_CATEGORY_WEIGHTS, { prop: 3, facade: 2, terrain: 1 });

  const ssao = estimateScreenSpaceCost({ profile: 'low' });
  assert.equal(ssao.fullScreenPasses, 4);
  assert.equal(ssao.samplesPerPixel, GDO_AO_PROFILES.low.ssaoSamplesPerPixel);
  assert.equal(ssao.costUnits, ssao.textureSamples, 'the gather is the comparable unit');
  assert.equal(ssao.textureSamples, ssao.pixels * ssao.samplesPerPixel);
  assert.ok(ssao.renderTargetBytes > 0 && ssao.sampleBytes > 0);
  // Doubling the pixel ratio quadruples the price; the price is arithmetic.
  const doubled = estimateScreenSpaceCost({ profile: 'low', viewport: { pixelRatio: 1.7 } });
  assert.equal(doubled.textureSamples, ssao.textureSamples * 4);

  const anchors = estimateContactAnchorCost({ profile: 'low', props: 60 });
  assert.equal(anchors.addedDrawCalls, 1, 'one instanced draw for the whole scene');
  assert.equal(anchors.fullScreenPasses, 0);
  assert.equal(anchors.renderTargetBytes, 0, 'no composer target is allocated');
  assert.ok(anchors.overdrawSamples > 0);
  assert.equal(estimateContactAnchorCost({ profile: 'low', props: 10_000 }).instances,
    GDO_AO_PROFILES.low.maxAnchorInstances, 'the pool caps the draw');

  const bake = estimateVertexBakeCost({ profile: 'low', vertices: 900 });
  assert.equal(bake.costUnits, 0, 'a bake costs nothing at runtime');
  assert.equal(bake.addedDrawCalls, 0);
  assert.equal(bake.bytes, 900, 'one byte per vertex');
});

test('the benchmark refuses screen-space on low and balanced by budget alone', () => {
  for (const profile of ['low', 'balanced']) {
    const report = benchmarkAmbientOcclusion({ profile, scene: { ...SCENE, stackedProps: 30 } });
    assert.equal(report.namespace, GDO_AO_NAMESPACE);
    assert.equal(report.deterministic, true);
    assert.equal(report.timing, null, 'no stopwatch decides this row');
    assert.equal(report.budget.maxFullScreenPasses, 0);
    const screen = report.candidates.find(candidate => candidate.needsScreenSpace);
    assert.equal(screen.fitsBudget, false, `${profile} never allocates a composer target`);
    assert.equal(screen.refusal, 'profile-forbids-full-screen-pass');
    assert.equal(report.decision.screenSpaceAllowed, false);
    assert.equal(report.decision.screenSpaceEarned, false);
    // Grounded as much as the cheap pair can, and the residual is named honestly.
    assert.deepEqual([...report.decision.package], ['contact-anchors', 'vertex-bake']);
    assert.ok(report.decision.coverage > 0 && report.decision.coverage < 1);
    assert.equal(report.decision.reason, 'cheapest-available');
  }
});

test('screen-space is declined at high when the cheap pair already covers the scene', () => {
  const report = benchmarkAmbientOcclusion({ profile: 'high', scene: SCENE });
  assert.equal(report.budget.maxFullScreenPasses > 0, true, 'high may buy a pass');
  assert.equal(report.refusedPackages.length, 0, 'nothing is refused on budget');
  assert.deepEqual([...report.decision.package], ['contact-anchors', 'vertex-bake']);
  assert.equal(report.decision.reason, 'cheapest-at-full-coverage');
  assert.equal(report.decision.screenSpaceEarned, false);
  assert.equal(report.decision.coverage, 1);
  // The cheap pair wins on the comparable unit, not on an opinion.
  const cheap = report.candidates.find(candidate => !candidate.needsScreenSpace && candidate.coverage === 1);
  const screen = report.candidates.find(candidate => candidate.needsScreenSpace);
  assert.ok(cheap.cost.costUnits < screen.cost.costUnits);
  assert.equal(screen.cost.renderTargetBytes > 0, true);
});

test('screen-space earns its pass only when nothing cheaper can ground the scene', () => {
  // Props resting on other props have no ground under them to anchor to.
  const stacked = { ...SCENE, stackedProps: 40 };
  const high = benchmarkAmbientOcclusion({ profile: 'high', scene: stacked });
  assert.equal(high.decision.screenSpaceEarned, true);
  assert.equal(high.decision.reason, 'earned-a-pass');
  assert.deepEqual([...high.decision.package], ['screen-space']);
  assert.equal(high.decision.coverage, 1);
  const cheap = high.candidates.find(candidate => !candidate.needsScreenSpace);
  assert.ok(high.decision.coverage - cheap.coverage >= GDO_AO_PROFILES.high.screenSpaceValueMargin,
    'the margin is the declared one, not a nudge');

  // The same scene still cannot buy it on the profiles that forbid the pass: the
  // gate is the budget, and it holds before value is even considered.
  const low = benchmarkAmbientOcclusion({ profile: 'low', scene: stacked });
  assert.equal(low.decision.screenSpaceEarned, false);
  assert.deepEqual([...low.decision.package], ['contact-anchors', 'vertex-bake']);

  // A scene with nothing in it grounds nothing, at any profile.
  const empty = benchmarkAmbientOcclusion({ profile: 'high', scene: {} });
  assert.equal(empty.decision.coverage, 0);
  assert.equal(empty.decision.reason, 'nothing-to-ground');
  assert.deepEqual([...empty.decision.package], []);

  // A caller may re-weight the categories and get a different, still-explained answer.
  const reweighted = benchmarkAmbientOcclusion({ profile: 'high', scene: SCENE, weights: { prop: 0, facade: 1, terrain: 1 } });
  assert.equal(reweighted.decision.coverage, 1);
  assert.deepEqual(reweighted.weights, { prop: 0, facade: 1, terrain: 1 });
});

test('the benchmark is deterministic and reconciles with the low-profile budget', () => {
  const first = benchmarkAmbientOcclusion({ profile: 'low', scene: SCENE, viewport: { width: 1280, height: 720 } });
  const second = benchmarkAmbientOcclusion({ profile: 'low', scene: SCENE, viewport: { width: 1280, height: 720 } });
  assert.deepEqual(first, second);

  // What the row ships sits inside the ceilings that already gate the low profile.
  const chosen = first.candidates.find(candidate =>
    candidate.package.join('+') === first.decision.package.join('+'));
  assert.ok(chosen.cost.addedDrawCalls <= GDO_LOW_PROFILE_BUDGETS.streetDrawCalls);
  assert.ok(chosen.cost.renderTargetBytes <= first.budget.maxRenderTargetBytes);
  assert.ok(chosen.cost.bytes <= GDO_LOW_PROFILE_BUDGETS.visibleTriangles * 4);

  // Malformed input cannot be coerced into a favourable answer.
  const malformed = benchmarkAmbientOcclusion({ profile: 'nonsense', scene: { props: -5, facades: Number.NaN, vertices: 'x' } });
  assert.equal(malformed.profile, 'nonsense');
  assert.equal(malformed.scene.props, 0);
  assert.equal(malformed.decision.reason, 'nothing-to-ground');
});

test('contact anchors are pooled, faded, capped, and allocation-free per frame', () => {
  const anchors = createContactAnchors({ profile: 'low' });
  const policy = GDO_AO_PROFILES.low;
  assert.equal(anchors.namespace, GDO_AO_NAMESPACE);

  anchors.begin(0, 0);
  assert.deepEqual({ ...anchors.add({ x: 1, z: 1, groundY: .2 }) }, { ok: true, index: 0 });
  const record = anchors.write();
  assert.equal(record.length, anchors.stride);
  assert.ok(Math.abs(record[1] - (.2 + policy.anchorLiftMetres)) < 1e-6, 'the anchor sits just off the ground');
  assert.ok(Math.abs(record[3] - policy.anchorFootprintMetres * policy.anchorScaleX) < 1e-6);
  assert.ok(record[6] > 0 && record[6] <= .5501, 'the ellipse is translucent');

  // Distance fade, then a hard cull: an anchor belongs to the near field.
  anchors.begin(policy.anchorFadeStartMetres, 0);
  anchors.add({ x: 0, z: 0 });
  const near = anchors.write()[6];
  anchors.begin(policy.anchorFadeStartMetres + (policy.anchorFadeEndMetres - policy.anchorFadeStartMetres) * .5, 0);
  anchors.add({ x: 0, z: 0 });
  assert.ok(anchors.write()[6] < near, 'it fades with distance');
  anchors.begin(policy.anchorFadeEndMetres, 0);
  assert.equal(anchors.add({ x: 0, z: 0 }).refusal, GDO_AO_REFUSAL.OUT_OF_RANGE);
  assert.equal(anchors.instances, 0);

  // The pool is a cap, and a capped anchor is refused by name, not silently drawn.
  anchors.begin(0, 0);
  for (let index = 0; index < policy.maxAnchorInstances; index++) {
    assert.equal(anchors.add({ x: index * .01, z: 0 }).ok, true);
  }
  assert.equal(anchors.add({ x: 0, z: 0 }).refusal, GDO_AO_REFUSAL.POOL_FULL);
  assert.equal(anchors.add({ x: Number.NaN, z: 0 }).refusal, GDO_AO_REFUSAL.BAD_INPUT);
  const diagnostics = anchors.diagnostics;
  assert.equal(diagnostics.instances, policy.maxAnchorInstances);
  assert.equal(diagnostics.addedDrawCalls, 1, 'the whole scene is one instanced draw');
  assert.equal(diagnostics.fullScreenPasses, 0);
  assert.equal(diagnostics.renderTargetBytes, 0);
  assert.equal(diagnostics.steadyFrameAllocations, 0);
  assert.equal(diagnostics.refusals[GDO_AO_REFUSAL.POOL_FULL], 1);

  // A frame only writes; it never grows anything.
  const before = anchors.write().length;
  anchors.begin(0, 0);
  anchors.add({ x: .5, z: .5 });
  assert.equal(anchors.write().length, anchors.stride, 'the buffer is reused');

  anchors.dispose();
  assert.equal(anchors.add({ x: 0, z: 0 }).refusal, GDO_AO_REFUSAL.DISPOSED);
  assert.equal(before > 0, true);
});

test('baked contact occlusion darkens bases and corners in one byte per vertex', () => {
  // A wall: two vertices at the base, two one metre up, two at the top.
  const positions = new Float32Array([
    0, 0, 0, 0, 0, 1,
    0, 1, 0, 0, 1, 1,
    0, 3, 0, 0, 3, 1,
  ]);
  const normals = new Float32Array([
    1, 0, 0, 1, 0, 0,
    1, 0, 0, 1, 0, 0,
    1, 0, 0, 1, 0, 0,
  ]);
  const baked = bakeContactOcclusion({ positions, normals, groundY: 0, profile: 'low' });
  assert.equal(baked.ok, true);
  assert.equal(baked.namespace, GDO_AO_NAMESPACE);
  assert.equal(baked.vertices, 6);
  assert.equal(baked.bytes, 6, 'one byte per vertex');
  assert.equal(baked.fullScreenPasses, 0, 'and nothing per frame');
  const [baseA, baseB, midA, midB, topA, topB] = baked.values;
  assert.ok(baseA < midA && midA < topA, 'the wall darkens toward its base');
  assert.equal(baseA, baseB, 'and along a flat run it is uniform');
  assert.equal(topA, 255, 'a vertex clear of the ground is untouched');
  assert.equal(baked.minimum, baseA);
  assert.equal(baked.maximum, 255);

  // A vertical face gets more than a horizontal one at the same height: corners
  // and wall faces read as contact, floors do not.
  const floor = bakeContactOcclusion({
    positions: new Float32Array([0, .05, 0, 1, .05, 0]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0]),
    groundY: 0,
  });
  const wall = bakeContactOcclusion({
    positions: new Float32Array([0, .05, 0, 1, .05, 0]),
    normals: new Float32Array([1, 0, 0, 1, 0, 0]),
    groundY: 0,
  });
  assert.ok(wall.values[0] < floor.values[0], 'a wall base is darker than a floor at the same height');

  // Deterministic, bounded, and honest about bad input.
  assert.deepEqual(bakeContactOcclusion({ positions, normals, groundY: 0 }).values,
    bakeContactOcclusion({ positions, normals, groundY: 0 }).values);
  assert.equal(bakeContactOcclusion({ positions: new Float32Array([0, 1]) }).refusal, GDO_AO_REFUSAL.BAD_INPUT);
  assert.equal(bakeContactOcclusion({}).ok, false);
  assert.equal(bakeContactOcclusion({ positions: new Float32Array(0) }).bytes, 0);
});

test('the world mounts anchors over its own props and can quote the decision', () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  try {
    const world = new GeoWorld(new THREE.Scene(), { latitude: 28.99, longitude: 77.71 });
    assert.equal(world.contactAnchors.namespace, GDO_AO_NAMESPACE);
    // An empty world grounds nothing, and says so instead of drawing a stain.
    const idle = world.updateContactAnchors(0, 0);
    assert.equal(idle.instances, 0);
    assert.equal(idle.addedDrawCalls, 0);

    const crate = world.spawnPushable({ x: 40, z: 40, kind: 'crate', radius: .3 });
    assert.equal(crate.ok, true);
    const grounded = world.updateContactAnchors(40, 40);
    assert.equal(grounded.instances, 1, 'the crate gets one anchor');
    assert.equal(grounded.addedDrawCalls, 1);
    const record = world.contactAnchors.write();
    assert.ok(record[3] >= GDO_AO_PROFILES.low.anchorFootprintMin, 'the anchor matches the prop');
    assert.equal(world.contactAnchors.write().length, world.contactAnchors.stride);

    // The decision the world quotes counts what the world actually holds.
    const decision = world.ambientOcclusionDecision({ profile: 'low' });
    assert.equal(decision.decision.screenSpaceEarned, false);
    assert.ok(['cheapest-available', 'cheapest-at-full-coverage'].includes(decision.decision.reason));
    assert.equal(decision.scene.props, 1, 'the live prop is counted');

    world.dispose();
    assert.equal(world.updateContactAnchors(0, 0), null, 'a disposed world anchors nothing');
    assert.equal(world.contactAnchors.add({ x: 0, z: 0 }).refusal, GDO_AO_REFUSAL.DISPOSED);
  } finally {
    globalThis.Worker = originalWorker;
  }
});
