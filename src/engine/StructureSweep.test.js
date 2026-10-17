import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_STRUCTURE_DEFAULT_MASK,
  GDO_STRUCTURE_SWEEP_NAMESPACE,
  GDO_STRUCTURE_SWEEP_PROFILES,
  createStructureSweep,
  structureSweepBudgetForProfile,
} from './StructureSweep.js';
import { GEO_QUERY_MASK } from '../geo/GeoCollision.js';
import { featureNamespace } from './FeatureVersions.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

/**
 * `COL-06` module gate: the curated structural sweep answers the declared
 * `dynamicSweep` member — one bounded candidate set, masks honoured, a
 * deterministic prune order, and a live box array the callers keep pushing to.
 */

function box(minX, minY, minZ, maxX, maxY, maxZ, userData = {}) {
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ }, userData };
}

test('the curated sweep is declared, versioned, and bounded per profile', () => {
  assert.equal(GDO_STRUCTURE_SWEEP_NAMESPACE, featureNamespace('structureSweep'));
  assert.equal(GDO_STRUCTURE_SWEEP_NAMESPACE, 'gdo:structureSweep:v1');
  assert.deepEqual(Object.keys(GDO_STRUCTURE_SWEEP_PROFILES), ['low', 'balanced', 'high']);
  assert.equal(structureSweepBudgetForProfile('low').maxCandidates, GDO_LOW_PROFILE_BUDGETS.curatedSweepCandidates);
  assert.throws(() => structureSweepBudgetForProfile('enormous'), /Unknown structure-sweep profile/);
  assert.equal(GDO_STRUCTURE_DEFAULT_MASK, GEO_QUERY_MASK.CAMERA_BLOCKER);
  const sweep = createStructureSweep({ profile: 'low' });
  assert.equal(sweep.namespace, GDO_STRUCTURE_SWEEP_NAMESPACE);
  assert.equal(sweep.profile, 'low');
  assert.equal(sweep.size, 0);
  assert.equal(sweep.steadyFrameAllocations, GDO_LOW_PROFILE_BUDGETS.curatedSweepSteadyFrameAllocations);
  assert.throws(() => createStructureSweep({ profile: 'huge' }), /Unknown structure-sweep profile/);
  assert.throws(() => createStructureSweep({ boxes: null }), /array of boxes/);
});

test('a sweep finds the nearest structural contact and never moves on its own', () => {
  const sweep = createStructureSweep({ profile: 'low' });
  sweep.add(box(4, 0, -1, 5, 4, 1, { id: 'far-wall' }));
  sweep.add(box(2, 0, -1, 3, 4, 1, { id: 'near-wall' }));
  const out = {};
  // Radius .2: the near wall's near face is at x = 2, so the sweep stops early.
  sweep.querySweep(0, 2, 0, 8, 0, 0, .2, out);
  assert.equal(out.hit, true);
  assert.equal(out.blockerId, 'near-wall');
  assert.equal(out.blockerRole, 'camera-blocker');
  assert.equal(out.blockerMask, GEO_QUERY_MASK.CAMERA_BLOCKER);
  assert.ok(Math.abs(out.time - (2 - .2) / 8) < 1e-9, `${out.time} is the contact time`);
  assert.ok(Math.abs(out.blockerDistance - (2 - .2)) < 1e-9);
  assert.equal(out.normalX, -1, 'the normal points back along the travel');
  assert.equal(out.startedOverlapping, false);
  assert.equal(Object.hasOwn(out, 'blockerIndex'), true);
  // A clear lane reports nothing, and the record is reused rather than replaced.
  const clear = sweep.querySweep(0, 2, 20, 0, 0, 8, .2, out);
  assert.equal(clear, out);
  assert.equal(clear.hit, false);
  assert.equal(clear.blockerId, null);
  assert.equal(clear.blockerMask, 0);
  assert.equal(clear.blockerDistance, 0);
  assert.equal(clear.time, 1);
  // Starting inside a blocker is reported as overlapping at t = 0.
  sweep.querySweep(2.5, 2, 0, 4, 0, 0, .2, out);
  assert.equal(out.hit, true);
  assert.equal(out.time, 0);
  assert.equal(out.startedOverlapping, true);
  assert.throws(() => sweep.querySweep(0, 0, 0, Number.NaN, 0, 0, .2, {}), /finite coordinates/);
});

test('query masks decide which structures a consumer may hit', () => {
  const sweep = createStructureSweep({ profile: 'low' });
  sweep.add(box(1, 0, -1, 2, 2, 1, { id: 'fade-only', mask: GEO_QUERY_MASK.FADE_ELIGIBLE }));
  sweep.add(box(3, 0, -1, 4, 2, 1, { id: 'solid', mask: GEO_QUERY_MASK.SOLID_PLAYER }));
  const out = {};
  sweep.querySweep(0, 1, 0, 8, 0, 0, .2, out, GEO_QUERY_MASK.CAMERA_BLOCKER);
  assert.equal(out.hit, false, 'neither structure is a camera blocker');
  sweep.querySweep(0, 1, 0, 8, 0, 0, .2, out, GEO_QUERY_MASK.FADE_ELIGIBLE);
  assert.equal(out.blockerId, 'fade-only');
  sweep.querySweep(0, 1, 0, 8, 0, 0, .2, out, GEO_QUERY_MASK.SOLID_PLAYER);
  assert.equal(out.blockerId, 'solid');
  // Both bits asked for: the nearest one wins.
  sweep.querySweep(0, 1, 0, 8, 0, 0, .2, out,
    GEO_QUERY_MASK.SOLID_PLAYER | GEO_QUERY_MASK.FADE_ELIGIBLE);
  assert.equal(out.blockerId, 'fade-only');
  // An undeclared box defaults to a camera blocker, so no caller can forget one.
  const plain = box(0, 0, 0, 1, 1, 1);
  sweep.add(plain);
  assert.equal(plain.userData.mask, undefined);
  sweep.querySweep(-2, .5, .5, 6, 0, 0, .05, out, GEO_QUERY_MASK.CAMERA_BLOCKER);
  assert.equal(out.hit, true);
  assert.equal(out.blockerRole, 'camera-blocker');
});

test('the live array is the caller’s: pushes and truncation are seen immediately', () => {
  const boxes = [];
  const sweep = createStructureSweep({ profile: 'low', boxes });
  assert.equal(sweep.boxes, boxes, 'the sweep shows the caller its own array');
  const out = {};
  sweep.querySweep(0, 1, 0, 8, 0, 0, .2, out);
  assert.equal(out.hit, false);
  // A bridge builder pushes straight into the array, without asking the sweep.
  boxes.push(box(2, 0, -1, 3, 2, 1, { id: 'late-deck' }));
  sweep.querySweep(0, 1, 0, 8, 0, 0, .2, out);
  assert.equal(out.hit, true);
  assert.equal(out.blockerId, 'late-deck');
  // And a caller that clears the array clears the authority with it.
  boxes.length = 0;
  sweep.querySweep(0, 1, 0, 8, 0, 0, .2, out);
  assert.equal(out.hit, false);
  // `addAll` accepts boxes or [key, box] pairs and keeps ids/roles.
  const added = sweep.addAll([
    box(1, 0, -1, 2, 2, 1, { id: 'from-array' }),
    ['key', box(4, 0, -1, 5, 2, 1, { id: 'from-pair' })],
    null,
  ]);
  assert.equal(added, 2);
  assert.equal(sweep.size, 2);
  const removed = boxes[0];
  assert.equal(sweep.remove(removed), true);
  assert.equal(sweep.size, 1);
  assert.equal(sweep.remove(removed), false, 'removing a box twice is a no-op');
  sweep.clear();
  assert.equal(sweep.size, 0);
  assert.throws(() => sweep.add({ userData: {} }), /min\/max bounds/);
});

test('a pathological candidate set is pruned deterministically and reported', () => {
  const sweep = createStructureSweep({ profile: 'low' });
  const cap = GDO_LOW_PROFILE_BUDGETS.curatedSweepCandidates;
  // One row of boxes the sweep's own bounds cannot cull, so the candidate cap is
  // the only thing keeping the work bounded.
  for (let index = 0; index < cap + 40; index++) {
    sweep.add(box(index * .5, 0, 0, index * .5 + .25, 1, .25, { id: `stack:${index}` }));
  }
  const out = {};
  sweep.querySweep(-1, .5, .1, 4_000, 0, 0, .05, out, GEO_QUERY_MASK.CAMERA_BLOCKER);
  const diagnostics = sweep.diagnostics();
  assert.equal(diagnostics.maxCandidates, cap, 'the candidate set is capped');
  assert.equal(diagnostics.pruned, 40);
  assert.ok(diagnostics.hits >= 1);
  assert.equal(out.hit, true);
  assert.equal(out.blockerId, 'stack:0', 'the nearest structure is kept, not an arbitrary one');
  // Two runs of the same sweep agree on both the verdict and the counters.
  const replay = createStructureSweep({ profile: 'low' });
  for (let index = 0; index < cap + 40; index++) {
    replay.add(box(index * .5, 0, 0, index * .5 + .25, 1, .25, { id: `stack:${index}` }));
  }
  const second = {};
  replay.querySweep(-1, .5, .1, 4_000, 0, 0, .05, second, GEO_QUERY_MASK.CAMERA_BLOCKER);
  assert.equal(second.blockerId, out.blockerId);
  assert.equal(replay.diagnostics().maxCandidates, diagnostics.maxCandidates);
  assert.equal(replay.diagnostics().pruned, diagnostics.pruned);
  // A malformed entry is counted instead of throwing mid-sweep.
  sweep.boxes.push({ userData: { id: 'broken' } });
  const third = {};
  sweep.querySweep(-1, .5, .1, 4, 0, 0, .05, third, GEO_QUERY_MASK.CAMERA_BLOCKER);
  assert.equal(sweep.diagnostics().missingBounds, 1);
  assert.equal(typeof third.hit, 'boolean');
  assert.equal(sweep.diagnostics().steadyFrameAllocations, 0);
});
