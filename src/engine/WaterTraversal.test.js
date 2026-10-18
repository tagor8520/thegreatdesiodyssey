import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_TRAVERSAL_MODE, GDO_TRAVERSAL_NAMESPACE, GDO_TRAVERSAL_REFUSAL, GDO_TRAVERSAL_RULES,
  createTraversalController,
} from './WaterTraversal.js';
import { GDO_FEATURE_VERSIONS } from './FeatureVersions.js';
import { GDO_WATER_STATE } from './WaterContact.js';
import { LifecycleLedger } from './LifecycleContract.js';

/**
 * `GME-09` gate: the swimming/boat traversal rules are declared — enter, exit,
 * support, camera — and the boarding verb crosses between the `COL-08` water
 * states and the `LIF-05` boats by rule, with every refusal named.
 */

function boat(id, extra = {}) {
  return { id, x: 0, y: .02, z: 0, heading: 0, speed: 0, afloat: true, kind: 1, ...extra };
}

test('GME-09 the enter/exit water rules follow the COL-08 contact state', () => {
  const traversal = createTraversalController();
  assert.equal(traversal.mode, GDO_TRAVERSAL_MODE.DRY);
  traversal.update({ contact: { state: GDO_WATER_STATE.WADING } });
  assert.equal(traversal.mode, GDO_TRAVERSAL_MODE.WADING);
  traversal.update({ contact: { state: GDO_WATER_STATE.SWIMMING } });
  assert.equal(traversal.mode, GDO_TRAVERSAL_MODE.SWIMMING);
  assert.equal(traversal.counters.enteredWater, 1);
  traversal.update({ contact: { state: GDO_WATER_STATE.SUBMERGED } });
  assert.equal(traversal.mode, GDO_TRAVERSAL_MODE.SWIMMING,
    'a submerged body swims for traversal purposes');
  traversal.update({ contact: { state: GDO_WATER_STATE.DRY } });
  assert.equal(traversal.mode, GDO_TRAVERSAL_MODE.DRY);
  assert.equal(traversal.counters.exitedWater, 1);
});

test('GME-09 boarding needs a boat that is near, still, and afloat', () => {
  const traversal = createTraversalController();
  // Nothing near: named refusal, no boarding by proximity alone.
  assert.equal(traversal.tryBoard([boat('b1', { x: 9 })], { x: 0, y: 0, z: 0 }), null);
  assert.equal(traversal.refusals[GDO_TRAVERSAL_REFUSAL.NO_BOAT], 1);
  // Near but moving: the still-boat rule refuses by name.
  assert.equal(traversal.tryBoard([boat('b1', { speed: .5 })], { x: 0, y: 0, z: 0 }), null);
  assert.equal(traversal.refusals[GDO_TRAVERSAL_REFUSAL.NOT_STILL], 1);
  // Near but not afloat: the afloat rule refuses by name.
  assert.equal(traversal.tryBoard([boat('b1', { afloat: false })], { x: 0, y: 0, z: 0 }), null);
  assert.equal(traversal.refusals[GDO_TRAVERSAL_REFUSAL.NOT_AFLOAT], 1);
  // Near, still, afloat: aboard, standing on the deck height.
  const anchor = traversal.tryBoard([boat('b1', { y: .02 })], { x: 0, y: 0, z: 0 });
  assert.ok(anchor, 'the still boat boards');
  assert.equal(traversal.mode, GDO_TRAVERSAL_MODE.IN_BOAT);
  assert.equal(traversal.boatId, 'b1');
  assert.ok(Math.abs(anchor.y - (.02 + GDO_TRAVERSAL_RULES.deckHeight)) < 1e-9,
    'the passenger stands on the declared deck height');
  assert.equal(traversal.counters.boarded, 1);
  // Already aboard: the second press refuses by name.
  assert.equal(traversal.tryBoard([boat('b1')], { x: 0, y: 0, z: 0 }), null);
  assert.equal(traversal.refusals[GDO_TRAVERSAL_REFUSAL.ALREADY_ABOARD], 1);
});

test('GME-09 the ride follows the boat and a dropped passenger swims', () => {
  const traversal = createTraversalController();
  const records = [boat('b1', { x: 1, z: 2, heading: .5 })];
  traversal.tryBoard(records, { x: 1, y: 0, z: 2 });
  records[0].x = 3;
  records[0].z = 4;
  traversal.update({ contact: { state: GDO_WATER_STATE.DRY }, boatRecords: records });
  assert.equal(traversal.rideAnchor.x, 3, 'the passenger rides the boat transform');
  assert.equal(traversal.rideAnchor.z, 4);
  // The boat recycles away: the passenger enters the water exactly there.
  traversal.update({ contact: { state: GDO_WATER_STATE.DRY }, boatRecords: [] });
  assert.equal(traversal.mode, GDO_TRAVERSAL_MODE.SWIMMING);
  assert.equal(traversal.counters.exitedWater, 1);
});

test('GME-09 the disembark rule leaves to the boat side and names its miss', () => {
  const traversal = createTraversalController();
  assert.equal(traversal.tryExit(), null);
  assert.equal(traversal.refusals[GDO_TRAVERSAL_REFUSAL.NOT_IN_BOAT], 1);
  traversal.tryBoard([boat('b1', { x: 1, z: 1, heading: 0 })], { x: 1, y: 0, z: 1 });
  const exit = traversal.tryExit();
  assert.ok(exit, 'the passenger disembarks');
  assert.equal(traversal.mode, GDO_TRAVERSAL_MODE.SWIMMING, 'a water exit lands swimming');
  assert.ok(Math.abs(exit.x - 1) < GDO_TRAVERSAL_RULES.exitOffset + 1e-9);
  assert.equal(traversal.counters.disembarked, 1);
});

test('GME-09 the support rule is the deck aboard and the contact in water', () => {
  const traversal = createTraversalController();
  assert.equal(traversal.supportY(), null, 'a swimmer is supported by the contact, not the deck');
  traversal.tryBoard([boat('b1', { y: .05 })], { x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(traversal.supportY() - (.05 + GDO_TRAVERSAL_RULES.deckHeight)) < 1e-9);
});

test('GME-09 the camera rule is declared per mode and never re-derived', () => {
  const traversal = createTraversalController();
  const out = {};
  assert.deepEqual(traversal.cameraRule(out), GDO_TRAVERSAL_RULES.camera[GDO_TRAVERSAL_MODE.DRY]);
  traversal.update({ contact: { state: GDO_WATER_STATE.SWIMMING } });
  assert.equal(traversal.cameraRule(out).distanceScale,
    GDO_TRAVERSAL_RULES.camera[GDO_TRAVERSAL_MODE.SWIMMING].distanceScale);
  assert.ok(traversal.cameraRule(out).pitchBias > 0);
  traversal.tryBoard([boat('b1')], { x: 0, y: 0, z: 0 });
  assert.deepEqual(traversal.cameraRule(out), GDO_TRAVERSAL_RULES.camera[GDO_TRAVERSAL_MODE.IN_BOAT]);
  assert.ok(out.distanceScale > 1.1, 'the boat camera pulls back further than the swim camera');
  for (const mode of Object.values(GDO_TRAVERSAL_MODE)) {
    const rule = GDO_TRAVERSAL_RULES.camera[mode];
    assert.ok(rule.distanceScale >= 1 && rule.distanceScale < 2);
    assert.ok(rule.pitchBias >= 0 && rule.pitchBias < .5);
    assert.ok(rule.heightBias >= 0 && rule.heightBias < .5);
  }
});

test('GME-09 the traversal is one named contract and disposes cleanly', () => {
  assert.equal(GDO_TRAVERSAL_NAMESPACE, 'gdo:waterTraversal:v1');
  assert.equal(GDO_FEATURE_VERSIONS.waterTraversal, 1);
  assert.ok(GDO_TRAVERSAL_RULES.boardRadius > 0 && GDO_TRAVERSAL_RULES.boatSpeedLimit > 0);
  const ledger = new LifecycleLedger({ label: 'traversal-test' });
  const traversal = createTraversalController({ ledger });
  traversal.tryBoard([boat('b1')], { x: 0, y: 0, z: 0 });
  assert.equal(traversal.diagnostics.steadyFrameAllocations, 0);
  traversal.dispose();
  assert.equal(traversal.mode, GDO_TRAVERSAL_MODE.DRY, 'disposal drops the passenger');
  assert.equal(ledger.snapshot().counts.handle, 0, 'the ledger releases the controller');
  const summary = traversal.summary({});
  assert.equal(summary.aboard, false);
  assert.equal(summary.namespace, GDO_TRAVERSAL_NAMESPACE);
});
