import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_DEBUG_HOOK_KEY,
  GDO_DEBUG_LOG_CAPACITY,
  GDO_DEBUG_VERSION,
  createDebugLogger,
  describeDebugProbe,
  installDebugHooks,
} from './DebugHooks.js';
import { LifecycleLedger } from './LifecycleContract.js';

test('debug logger keeps a bounded, filterable, plain-record log', () => {
  let clock = 1000;
  const logger = createDebugLogger({ capacity: 4, clock: () => (clock += 5), level: 'debug', tag: 'gdo-test' });
  logger.info('lifecycle', 'mounted world', { tiles: 1 });
  logger.debug('lifecycle', 'tile phase', { phase: 'roads' });
  logger.warn('matrix', 'long frame', { milliseconds: 120 });
  assert.equal(logger.count, 3);
  assert.deepEqual(logger.records.map(record => record.level), ['info', 'debug', 'warn']);
  assert.equal(logger.byScope('lifecycle').length, 2);
  assert.match(logger.text(), /\[lifecycle\] mounted world \{"tiles":1\}/);
  assert.match(logger.text(), /\[matrix\] long frame/);

  for (let index = 0; index < 5; index++) logger.info('spam', `line ${index}`);
  assert.equal(logger.records.length, 4, 'capacity is enforced');
  assert.equal(logger.count, 4, 'count reports retained records');
  assert.equal(logger.written, 8, 'written keeps the lifetime total');
  assert.equal(logger.dropped, 4);
  assert.deepEqual(logger.records.map(record => record.message), ['line 1', 'line 2', 'line 3', 'line 4'],
    'oldest records drop first');

  logger.setLevel('warn');
  assert.equal(logger.info('spam', 'filtered'), null);
  assert.equal(logger.error('spam', 'kept').level, 'error');
  logger.clear();
  assert.deepEqual(logger.records, []);
  assert.equal(logger.text(), '');
});

test('debug logger mirrors to a sink and console only when asked', () => {
  const seen = [];
  const logger = createDebugLogger({ sink: record => seen.push(record.message), mirrorToConsole: false });
  logger.info('scope', 'one');
  logger.error('scope', 'two');
  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(GDO_DEBUG_LOG_CAPACITY, 128, 'default capacity stays bounded');
});

test('installed debug hook exposes ledger, probe, step, audits, and a removable key', () => {
  const target = {};
  const ledger = new LifecycleLedger({ label: 'game' });
  ledger.own('geometry', 'ground');
  const stepped = [];
  const logger = createDebugLogger({ level: 'debug' });
  const installed = installDebugHooks(target, {
    ledger,
    logger,
    describe: () => ({ camera: { mode: 'third-person', zoom: 4.5 }, tiles: 1 }),
    step: (dt, index) => stepped.push([dt, index]),
    audits: { movement: () => ({ ok: true, samples: 216 }) },
    extras: { profile: 'low' },
  });

  assert.equal(installed.enabled, true);
  const hook = target[GDO_DEBUG_HOOK_KEY];
  assert.equal(hook.version, GDO_DEBUG_VERSION);
  assert.equal(hook.installed, true);
  assert.equal(hook.profile, 'low');
  assert.equal(hook.counts().geometry, 1);
  assert.equal(hook.ledger().label, 'game');
  assert.equal(hook.live().length, 1);
  assert.equal(hook.probe().described.camera.mode, 'third-person');
  assert.equal(hook.probe().ledger.total, 1);
  assert.match(describeDebugProbe(hook.probe()), /third-person/);

  assert.deepEqual(hook.step(1 / 30, 3), { ok: true, steps: 3, dt: 1 / 30 });
  assert.equal(stepped.length, 3);
  assert.deepEqual(hook.step(10, 5000), { ok: true, steps: 600, dt: .25 }, 'step count and dt stay bounded');

  assert.deepEqual(hook.audits.list(), ['movement']);
  assert.equal(hook.audits.run('movement').ok, true);
  assert.match(hook.audits.run('missing').detail, /unknown audit "missing"/);

  hook.log.write('scope', 'hello');
  assert.equal(hook.log.count, 1);
  assert.match(hook.log.text(), /hello/);
  hook.log.clear();
  assert.equal(hook.log.count, 0);
  assert.equal(hook.log.text(), '');

  hook.dispose();
  assert.equal(target[GDO_DEBUG_HOOK_KEY], undefined);
  assert.equal(hook.installed, false);
});

test('debug hook contains probe and audit failures instead of breaking the caller', () => {
  const target = {};
  const installed = installDebugHooks(target, {
    describe: () => { throw new Error('camera missing'); },
    step: null,
    audits: { broken: () => { throw new Error('audit exploded'); } },
  });
  const hook = target[GDO_DEBUG_HOOK_KEY];
  assert.deepEqual(hook.probe().described, { error: 'camera missing' });
  assert.equal(hook.probe().ledger, null);
  assert.deepEqual(hook.counts(), null);
  assert.equal(hook.step().ok, false);
  assert.match(hook.audits.run('broken').detail, /audit exploded/);
  installed.dispose();
  assert.equal(GDO_DEBUG_HOOK_KEY in target, false);
});

test('debug hooks can be disabled, and installing twice replaces only our own key', () => {
  const target = { [GDO_DEBUG_HOOK_KEY]: { foreign: true } };
  const disabled = installDebugHooks(target, { enabled: false });
  assert.equal(disabled.enabled, false);
  assert.deepEqual(target[GDO_DEBUG_HOOK_KEY], { foreign: true }, 'disabled install leaves the key alone');

  const first = installDebugHooks(target, {});
  const second = installDebugHooks(target, {});
  first.dispose();
  assert.equal(target[GDO_DEBUG_HOOK_KEY].version, GDO_DEBUG_VERSION, 'the newer hook survives an older dispose');
  second.dispose();
  assert.equal(target[GDO_DEBUG_HOOK_KEY], undefined);
  assert.throws(() => installDebugHooks(null, {}), /needs a target object/);
});
