import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_AMBIENT_SCHEDULER_NAMESPACE,
  GDO_AMBIENT_SCHEDULER_PROFILES,
  GDO_AMBIENT_SCHEDULER_STATE,
  ambientSchedulerBudgetForProfile,
  createAmbientLifeScheduler,
  focalPixelsFor,
  projectedPixelRadius,
} from './AmbientLifeScheduler.js';
import { AmbientLifePools, ambientLifeCycleWindow } from './AmbientLifeMotion.js';
import { LifecycleLedger } from './LifecycleContract.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

/**
 * `LIF-02` gate: ambient sources are scheduled by projected screen size and their
 * per-cycle activity window under a bounded budget, identically on every run, and
 * a parked source costs no draw call and no matrix work.
 */

const VIEW = {
  x: 0, y: 0, z: 0,
  forwardX: 0, forwardZ: -1, rightX: -1, rightZ: 0,
  fovRadians: Math.PI / 3, viewportHeight: 720, aspect: 1,
  cycleIndex: 0, nowMilliseconds: 0,
};

test('projected size decides, and the frustum margin is measured in pixels', () => {
  assert.equal(GDO_AMBIENT_SCHEDULER_NAMESPACE, 'gdo:ambientLifeScheduler:v1');
  assert.ok(Math.abs(focalPixelsFor(Math.PI / 3, 720) - 720 / (2 * Math.tan(Math.PI / 6))) < 1e-9);
  assert.equal(projectedPixelRadius(1, 10, 720), 72);
  assert.throws(() => projectedPixelRadius(1, 0, Number.NaN), /finite numbers/);
  assert.throws(() => focalPixelsFor(0, 720), /Field of view/);
  assert.throws(() => focalPixelsFor(Math.PI / 3, 0), /Viewport height/);

  const scheduler = createAmbientLifeScheduler({ profile: 'low' });
  try {
    scheduler.begin(VIEW);
    // Straight ahead and large: active.
    const near = scheduler.evaluate({ id: 'near', x: 0, y: 1, z: -6, radius: .3 });
    assert.equal(near.state, GDO_AMBIENT_SCHEDULER_STATE.ACTIVE);
    assert.ok(near.projectedPixels > 30);
    assert.ok(near.onScreen);
    // Behind the camera: parked, and never even offered to the budget.
    const behind = scheduler.evaluate({ id: 'behind', x: 0, y: 1, z: 6, radius: .3 });
    assert.equal(behind.state, GDO_AMBIENT_SCHEDULER_STATE.OFFSCREEN);
    // Far to the side, outside the frustum plus a small margin.
    const side = scheduler.evaluate({ id: 'side', x: 30, y: 1, z: -4, radius: .3 });
    assert.equal(side.state, GDO_AMBIENT_SCHEDULER_STATE.OFFSCREEN);
    // On screen but a fraction of a pixel: parked as tiny.
    const tiny = scheduler.evaluate({ id: 'tiny', x: 0, y: 1, z: -40, radius: .002 });
    assert.equal(tiny.state, GDO_AMBIENT_SCHEDULER_STATE.TINY);
    assert.ok(tiny.projectedPixels < GDO_AMBIENT_SCHEDULER_PROFILES.low.minProjectedPixels);
    // Past the family view distance: parked regardless of framing.
    const far = scheduler.evaluate({ id: 'far', x: 0, y: 1, z: -400, radius: 5, viewDistance: 168 });
    assert.equal(far.state, GDO_AMBIENT_SCHEDULER_STATE.OUT_OF_RANGE);
    // Outside its appearance window: parked even when perfectly framed.
    const closed = scheduler.evaluate({ id: 'closed', x: 0, y: 1, z: -5, radius: .3, windowLive: false });
    assert.equal(closed.state, GDO_AMBIENT_SCHEDULER_STATE.WINDOW_CLOSED);
    const summary = scheduler.finish();
    assert.equal(summary.namespace, GDO_AMBIENT_SCHEDULER_NAMESPACE);
    assert.equal(summary.active, 1);
    assert.equal(summary.evaluated, 6);
    assert.equal(summary.parked, 5);
    assert.equal(scheduler.visibilityAt(0), 1);
    assert.equal(scheduler.visibilityAt(1), 0);
    const diagnostics = scheduler.diagnostics();
    assert.equal(diagnostics.steadyFrameAllocations, 0);
    assert.equal(diagnostics.offscreen, 2);
    assert.equal(diagnostics.tiny, 1);
    assert.equal(diagnostics.outOfRange, 1);
    assert.equal(diagnostics.windowClosed, 1);
  } finally {
    scheduler.dispose();
  }
});

test('the budget prunes deterministically and hysteresis stops flicker', () => {
  const scheduler = createAmbientLifeScheduler({ profile: 'low' });
  try {
    const limit = GDO_AMBIENT_SCHEDULER_PROFILES.low.maxActiveSources;
    assert.equal(limit, GDO_LOW_PROFILE_BUDGETS.ambientActiveSources);
    assert.equal(ambientSchedulerBudgetForProfile('low').maxActiveSources, limit);
    const sources = [];
    for (let index = 0; index < limit + 4; index++) {
      sources.push({ id: `bird-${String(index).padStart(2, '0')}`, x: (index - 6) * .4, y: 1, z: -8, radius: .3 });
    }
    const runOnce = () => {
      scheduler.begin(VIEW);
      for (const source of sources) scheduler.evaluate(source);
      return scheduler.finish();
    };
    const first = runOnce();
    assert.equal(first.candidates, sources.length);
    assert.equal(first.active, limit);
    assert.equal(first.pruned, sources.length - limit);
    const activeIds = () => scheduler.decisions.slice(0, scheduler.decisionCount)
      .filter(decision => decision.state === GDO_AMBIENT_SCHEDULER_STATE.ACTIVE)
      .map(decision => decision.id);
    // The nearest sources — the ones that project largest — win the budget.
    const nearest = sources.slice()
      .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z) || a.id.localeCompare(b.id))
      .slice(0, limit).map(source => source.id).sort();
    const firstActive = [...activeIds()].sort();
    assert.deepEqual(firstActive, nearest);
    assert.ok(firstActive.includes('bird-06'), 'the closest bird is active');
    assert.equal(firstActive.includes('bird-00'), false, 'the farthest bird is pruned');
    // The same inputs prune in the same order: determinism, not luck.
    const firstOrder = activeIds();
    const second = runOnce();
    assert.deepEqual(activeIds(), firstOrder, 'the active order repeats exactly');
    assert.equal(second.pruned, first.pruned);

    // Hysteresis: a source already active survives a dip below the entry
    // threshold, while a parked one would still be tiny at that size.
    const dip = GDO_AMBIENT_SCHEDULER_PROFILES.low.minProjectedPixels * .9;
    const radius = dip * 8 / focalPixelsFor(VIEW.fovRadians, VIEW.viewportHeight);
    scheduler.begin(VIEW);
    scheduler.evaluate({ id: 'bird-04', x: 0, y: 0, z: -8, radius });
    scheduler.finish();
    assert.equal(scheduler.decisions[0].state, GDO_AMBIENT_SCHEDULER_STATE.ACTIVE, 'a lit source may dim');
    assert.ok(scheduler.decisions[0].wasActive);
    scheduler.begin(VIEW);
    scheduler.evaluate({ id: 'stranger', x: 0, y: 0, z: -8, radius });
    scheduler.finish();
    assert.equal(scheduler.decisions[0].state, GDO_AMBIENT_SCHEDULER_STATE.TINY, 'a parked source needs the full threshold');

    // The overflow guard keeps one frame bounded even if a caller misbehaves.
    const perFrameCap = Math.min(GDO_AMBIENT_SCHEDULER_PROFILES.low.maxSourcesPerUpdate,
      GDO_AMBIENT_SCHEDULER_PROFILES.low.maxResidentSources);
    scheduler.begin(VIEW);
    for (let index = 0; index < perFrameCap + 5; index++) {
      scheduler.evaluate({ id: `extra-${index}`, x: 0, y: 1, z: -8, radius: .3 });
    }
    const overflowed = scheduler.finish();
    assert.equal(overflowed.overflow, 5);
    assert.equal(scheduler.diagnostics().skippedOverflow, 5);
    assert.throws(() => createAmbientLifeScheduler({ profile: 'ultra' }), /Unknown ambient-life scheduler profile/);
    assert.throws(() => scheduler.begin({ ...VIEW, forwardX: 0, forwardZ: 0 }), /look direction/);
    assert.throws(() => scheduler.evaluate({ x: 0 }), /stable id/);
    assert.throws(() => scheduler.evaluate({ id: 'x', radius: Number.NaN }), /finite numbers/);
  } finally {
    scheduler.dispose();
  }
});

test('the pool parks real sprites in its own instance stream', () => {
  const ledger = new LifecycleLedger({ label: 'ambient-scheduler-test' });
  const scene = new THREE.Scene();
  const pools = new AmbientLifePools(scene, {
    terrainSeed: 7, ledger, resolveGroundHeight: () => 0,
  });
  const scheduler = createAmbientLifeScheduler({ profile: 'low', ledger });
  try {
    // Decoration stride: x, z, scale, source type, yaw, tag.
    const near = new Float32Array(6 * 4);
    for (let index = 0; index < 4; index++) {
      near.set([index * .6 - 1, -4, 1, 10, index * .1, 0], index * 6);
    }
    const behind = new Float32Array(6 * 4);
    for (let index = 0; index < 4; index++) {
      behind.set([index * .6 - 1, 60, 1, 10, index * .1, 0], index * 6);
    }
    assert.equal(pools.addOwner('ahead', near, 6), 4);
    assert.equal(pools.addOwner('behind', behind, 6), 4);
    assert.equal(pools.entries, 8);
    assert.equal(pools.packedRecords[0].length, 8);

    // The camera sits at sprite height so both flocks are inside the frustum
    // when they are in front of it. The oracle below re-derives the same
    // screen-space test from the packed records, independently of the module.
    const height = 2.6;
    const liveAt = (record, nowMilliseconds) => {
      const window = ambientLifeCycleWindow(record,
        Math.floor(nowMilliseconds / (record.cycleSeconds * 1_000)));
      return nowMilliseconds >= window.start && nowMilliseconds <= window.liveEnd;
    };
    const withinFrustum = (record, view) => {
      const focal = focalPixelsFor(view.fovRadians, view.viewportHeight);
      const dx = record.x - view.x, dy = record.groundY + record.hover - view.y, dz = record.z - view.z;
      const forward = dx * view.forwardX + dz * view.forwardZ;
      const margin = GDO_AMBIENT_SCHEDULER_PROFILES.low.screenMargin * view.viewportHeight * Math.max(0, forward) / focal;
      if (forward <= 0) return false;
      return Math.abs(dx * view.rightX + dz * view.rightZ) <=
          forward * Math.tan(view.fovRadians * .5) * view.aspect + margin &&
        Math.abs(dy) <= forward * Math.tan(view.fovRadians * .5) + margin;
    };
    const view = { ...VIEW, y: height };
    const expected = (owner, nowMilliseconds) => pools.packedRecords[0]
      .filter(record => record.owner === owner)
      .filter(record => liveAt(record, nowMilliseconds) && withinFrustum(record, view))
      .map(record => record.id).sort();
    const drawn = () => pools.packedRecords[0]
      .map((record, index) => ({
        id: record.id, owner: record.owner, scale: record.scale,
        sprite: pools.geometries[0].getAttribute('gdoAmbientSprite').array[index * 4],
      }))
      .filter(entry => entry.sprite > 0);
    const drawnIds = () => drawn().map(entry => entry.id).sort();

    const summary = pools.scheduleVisibility(scheduler, { ...view, nowMilliseconds: 0 });
    assert.ok(summary);
    assert.equal(summary.evaluated, 8);
    assert.equal(pools.familyCounts[0], 8, 'every resident sprite stays in the pool');
    assert.equal(pools.entries, 8);
    const expectedAhead = expected('ahead', 0);
    assert.ok(expectedAhead.length > 0, 'the oracle sees live sprites in front');
    assert.deepEqual(drawnIds(), expectedAhead, 'exactly the live, on-screen sprites are drawn');
    assert.equal(summary.active, expectedAhead.length);
    assert.equal(pools.visibleEntries, summary.active);
    assert.equal(pools.parkedEntries, 8 - summary.active);
    for (const entry of drawn()) {
      assert.equal(entry.owner, 'ahead', `${entry.id} is never from the flock behind the camera`);
      assert.equal(entry.sprite, Math.fround(entry.scale), 'a drawn sprite keeps its authored scale');
    }
    const sprite = pools.geometries[0].getAttribute('gdoAmbientSprite');
    const versionOf = () => sprite.version;
    assert.ok(versionOf() > 0, 'the parked scales were uploaded');
    const resident = pools.familyCounts[0];
    const zeroScaled = [...sprite.array.slice(0, resident * 4)]
      .filter((_, index) => index % 4 === 0 && sprite.array[index] === 0).length;
    assert.equal(zeroScaled, resident - summary.active, 'every parked sprite carries a zero scale');
    assert.ok(pools.diagnostics.visibilityUploads >= summary.active);
    assert.equal(pools.diagnostics.lastSchedule.active, summary.active);

    // A still frame uploads nothing new: the visibility stream only changes when
    // a verdict changes.
    const uploads = pools.diagnostics.visibilityUploads;
    const settledVersion = versionOf();
    pools.scheduleVisibility(scheduler, { ...view, nowMilliseconds: 40 });
    assert.equal(pools.diagnostics.visibilityUploads, uploads, 'no churn on a settled frame');
    assert.equal(versionOf(), settledVersion, 'a settled frame re-uploads nothing');
    assert.deepEqual(drawnIds(), expectedAhead, 'a settled frame draws the same sprites');

    // Turning the camera around swaps which flock is drawn.
    const behindView = {
      ...view, forwardX: 0, forwardZ: 1, rightX: 1, rightZ: 0, nowMilliseconds: 80,
    };
    const expectedBehind = pools.packedRecords[0]
      .filter(record => record.owner === 'behind')
      .filter(record => liveAt(record, 80) && withinFrustum(record, behindView))
      .map(record => record.id).sort();
    assert.ok(expectedBehind.length > 0, 'the second flock is live too');
    pools.scheduleVisibility(scheduler, behindView);
    assert.deepEqual(drawnIds(), expectedBehind, 'the flock now in front is the drawn one');
    for (const entry of drawn()) assert.equal(entry.owner, 'behind');
    assert.ok(pools.diagnostics.visibilityUploads > uploads, 'the swap re-uploaded the changed scales');
    assert.ok(versionOf() > settledVersion, 'the swap bumped the instance stream version');
    assert.equal(pools.diagnostics.steadyFrameAllocations, 0);
    assert.equal(pools.diagnostics.cpuMatrixUpdates, 0, 'no CPU matrices anywhere in the path');

    // Deterministic: replaying the same frame draws the same sprites again.
    pools.scheduleVisibility(scheduler, { ...view, nowMilliseconds: 0 });
    assert.deepEqual(drawnIds(), expectedAhead, 'replaying a frame reproduces the verdicts');
    assert.equal(pools.diagnostics.lastSchedule.namespace, GDO_AMBIENT_SCHEDULER_NAMESPACE);
  } finally {
    scheduler.dispose();
    pools.dispose();
    ledger.disposeAll();
    assert.deepEqual(ledger.leaks(), []);
  }
});
