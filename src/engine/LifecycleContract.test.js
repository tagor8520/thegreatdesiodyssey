import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIFECYCLE_KINDS,
  LIFECYCLE_NAMESPACE,
  LifecycleLedger,
  describeLifecycleSnapshot,
  lifecycleCountsWithinCeiling,
  lifecycleSnapshotDelta,
  lifecycleSnapshotEqual,
  runLifecycleAudit,
} from './LifecycleContract.js';

test('lifecycle ledger counts owned resources per kind and releases them once', () => {
  const ledger = new LifecycleLedger({ label: 'test-owner' });
  const released = [];
  const geometry = ledger.own('geometry', 'ground', { id: 'ground' }, () => released.push('ground'));
  ledger.own('material', 'water', null, () => released.push('water'));
  const handle = ledger.own('mesh', 'tile-root');

  assert.equal(ledger.snapshot().total, 3);
  assert.deepEqual(ledger.snapshot().counts.geometry, 1);
  assert.equal(geometry.release(), true);
  assert.equal(geometry.release(), false, 'double release is a no-op');
  assert.equal(ledger.snapshot().total, 2);

  const snapshot = ledger.snapshot({ entries: true });
  assert.deepEqual(snapshot.entries.map(entry => `${entry.kind}:${entry.name}`), ['material:water', 'mesh:tile-root']);
  assert.equal(handle.released, false);
  assert.equal(ledger.describe().includes('2 live'), true);

  ledger.disposeAll();
  assert.deepEqual(released, ['ground', 'water']);
  assert.equal(ledger.snapshot().total, 0);
  assert.deepEqual(ledger.leaks(), []);
  assert.equal(ledger.disposed, true);
});

test('lifecycle ledger nests owners and rolls child counts into the parent', () => {
  const game = new LifecycleLedger({ label: 'game' });
  const world = game.child('world');
  game.own('listener', 'keydown');
  world.own('worker', 'tile-generator');
  world.own('geometry', 'tile:1:2/roads');

  assert.equal(game.snapshot().total, 3);
  assert.equal(world.snapshot().total, 2);
  assert.equal(game.snapshot().counts.worker, 1);

  // Parent teardown owns descendants too, newest first.
  const order = [];
  world.own('material', 'water', null, () => order.push('water'));
  game.disposeAll();
  assert.deepEqual(order, ['water']);
  assert.equal(game.snapshot().total, 0);
  assert.equal(world.disposed, true);
  assert.deepEqual(game.leaks(), []);
});

test('lifecycle ledger owns listeners, observers, timers, workers, and handles symmetrically', () => {
  const ledger = new LifecycleLedger({ label: 'symmetric' });
  const target = new EventTarget();
  let handled = 0;
  const onEvent = () => { handled++; };
  ledger.listener(target, 'ping', onEvent);
  target.dispatchEvent(new Event('ping'));
  assert.equal(handled, 1);

  let disconnected = 0;
  ledger.observer({ disconnect: () => disconnected++ }, 'resize');
  let cancelled = null;
  ledger.timer('frame', 41, handle => { cancelled = handle; }, 'animation-frame');
  let terminated = 0;
  ledger.worker({ terminate: () => terminated++ }, 'tile-worker');
  let handleReleased = 0;
  ledger.handle('material-library', () => handleReleased++, {});
  assert.deepEqual(
    LIFECYCLE_KINDS.filter(kind => ledger.snapshot().counts[kind] > 0),
    ['worker', 'listener', 'observer', 'frame', 'handle'],
  );

  ledger.disposeAll();
  target.dispatchEvent(new Event('ping'));
  assert.equal(handled, 1, 'disposed listeners must be removed');
  assert.deepEqual({ disconnected, cancelled, terminated, handleReleased },
    { disconnected: 1, cancelled: 41, terminated: 1, handleReleased: 1 });
});

test('lifecycle ledger rejects unknown kinds and malformed owners instead of inventing budgets', () => {
  const ledger = new LifecycleLedger();
  assert.throws(() => ledger.own('spaceship', 'x'), /Unknown lifecycle resource kind/);
  const degraded = ledger.listener({}, 'click', () => {});
  assert.equal(degraded.degraded, true, 'a host with no event API degrades instead of throwing');
  const halfDegraded = ledger.listener({ addEventListener() {} }, 'click', () => {});
  assert.equal(halfDegraded.degraded, true, 'a listener that cannot be removed is never installed');
  assert.equal(ledger.degraded, 2);
  assert.throws(() => ledger.observer({}), /disconnect/);
  assert.throws(() => ledger.timer('timer', 1, null), /cancel function/);
  assert.throws(() => ledger.worker({}), /terminate/);

  assert.equal(ledger.rejections, 3, 'degraded listeners are accounted, not rejected');
  assert.equal(ledger.snapshot().degraded, 2);
  assert.equal(ledger.snapshot().total, 0);
});

test('a throwing disposer is contained and reported instead of aborting teardown', () => {
  const ledger = new LifecycleLedger({ label: 'faulty' });
  const released = [];
  ledger.own('geometry', 'bad', null, () => { throw new Error('dispose exploded'); });
  ledger.own('geometry', 'good', null, () => released.push('good'));
  ledger.disposeAll();
  assert.deepEqual(released, ['good'], 'later resources still release');
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.failures, 1);
  assert.equal(snapshot.total, 0);
  assert.equal(ledger.lastFailure, 'geometry:bad: dispose exploded');
});

test('snapshot deltas and equality describe remount growth exactly', () => {
  const first = new LifecycleLedger({ label: 'a' });
  first.own('geometry', 'ground');
  first.own('listener', 'keydown');
  const second = new LifecycleLedger({ label: 'b' });
  second.own('geometry', 'ground');
  second.own('listener', 'keydown');
  second.own('geometry', 'leaked');

  const baseline = first.snapshot(), grown = second.snapshot();
  assert.deepEqual(lifecycleSnapshotDelta(baseline, grown), { geometry: 1, total: 1 });
  assert.equal(lifecycleSnapshotEqual(baseline, grown), false);
  assert.equal(lifecycleSnapshotEqual(baseline, first.snapshot()), true);
  assert.equal(describeLifecycleSnapshot(baseline), 'a: 2 live (listener 1, geometry 1)');
});

test('runLifecycleAudit proves a clean owner returns to the same idle counters', () => {
  const outer = new LifecycleLedger({ label: 'suite' });
  let live = null;
  const sample = () => ({ ...outer.snapshot().counts, total: outer.snapshot().total, released: outer.released });
  const report = runLifecycleAudit({
    cycles: 3,
    mount() {
      live = outer.child(`mount-${Math.random()}`);
      live.own('geometry', 'ground');
      live.own('listener', 'keydown');
      live.own('worker', 'tile');
    },
    unmount() { live.disposeAll(); },
    sample,
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.growth, []);
  assert.equal(report.namespace, LIFECYCLE_NAMESPACE);
  assert.equal(report.cycles, 3);
  assert.match(report.detail, /returned to the same 14 idle counters/);
  assert.equal(report.peakGrowth.find(entry => entry.key === 'total').delta, 3);
});

test('runLifecycleAudit names the exact counter that grew', () => {
  const leaked = [];
  const sample = () => ({ geometries: leaked.length, leakedGeometryNames: leaked.length });
  const report = runLifecycleAudit({
    cycles: 2,
    mount() { leaked.push(`geometry-${leaked.length}`); },
    unmount() { /* the defect: nothing released */ },
    sample,
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.growth.map(entry => entry.key), ['geometries', 'leakedGeometryNames']);
  assert.match(report.detail, /geometries 0→2/);
});

test('runLifecycleAudit reports a failing mount instead of silently passing', () => {
  const report = runLifecycleAudit({
    cycles: 2,
    mount() { throw new Error('worker refused to start'); },
    unmount() {},
    sample: () => ({ total: 0 }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.cycles, 1);
  assert.match(report.detail, /worker refused to start/);
});

test('lifecycle ceiling check reports per-kind and total violations', () => {
  const counts = Object.create(null);
  for (const kind of LIFECYCLE_KINDS) counts[kind] = 0;
  counts.geometry = 5; counts.total = 5;
  const ok = lifecycleCountsWithinCeiling(counts, { geometry: 8, total: 16 });
  assert.equal(ok.ok, true);
  assert.equal(ok.total, 5);
  const violated = lifecycleCountsWithinCeiling(counts, { geometry: 4, total: 4 });
  assert.equal(violated.ok, false);
  assert.deepEqual(violated.violations.map(entry => entry.kind), ['geometry', 'total']);
  assert.equal(lifecycleCountsWithinCeiling({ geometry: 1 }, {}).ok, true);
});
