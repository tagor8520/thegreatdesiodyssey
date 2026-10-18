import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_SAVE_MIGRATIONS, GDO_SAVE_NAMESPACE, GDO_SAVE_REFUSAL, GDO_SAVE_SCHEMA, GDO_SAVE_SETTINGS,
  createLocalSave,
} from './LocalSave.js';
import { GDO_FEATURE_VERSIONS, featureAvailable } from './FeatureVersions.js';
import { createDiscoveryJournal, createJournalStorage } from './DiscoveryJournal.js';

/**
 * `NET-01` gate: one versioned envelope carries settings, discovery, and
 * progress across a reload — migration-safe, with every refusal named.
 */

function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    get size() { return map.size; },
  };
}

function sampleDiscovery() {
  const journal = createDiscoveryJournal({ profile: 'low' });
  journal.observeAll([
    { name: 'Kagzi Chaat Corner', kind: 'place', x: 5, z: .4 },
    { name: 'Mandi Market', kind: 'place', x: 20, z: 19 },
  ], { x: 5, z: 0, clock: 0 });
  return journal;
}

const ACTIVITIES = Object.freeze([
  { id: 'act:a', progress: 1, state: 'complete' },
  { id: 'act:b', progress: 2, state: 'active' },
]);

test('NET-01 one envelope round-trips settings, discovery, and progress', () => {
  const store = memoryStore();
  const save = createLocalSave({ storage: store, nowMilliseconds: 1_000 });
  const journal = sampleDiscovery();
  const envelope = save.capture({
    settings: { profile: 'balanced', touchControls: true, reducedMotion: false, cameraFade: true },
    discovery: journal.toJSON(),
    activities: ACTIVITIES,
    worldVersion: 7,
  });
  assert.equal(envelope.namespace, GDO_SAVE_NAMESPACE);
  assert.equal(envelope.schema, GDO_SAVE_SCHEMA);
  assert.equal(save.persist(envelope), true);

  const second = createLocalSave({ storage: store });
  const loaded = second.load();
  assert.ok(loaded, 'the payload reads back');
  assert.equal(loaded.worldVersion, 7);
  const restoredJournal = createDiscoveryJournal({ profile: 'low' });
  const settingsTarget = {};
  const activitiesTarget = [{ id: 'act:a', progress: 0, state: 'active' }, { id: 'act:c', progress: 0, state: 'active' }];
  const result = second.restore(loaded, {
    journal: restoredJournal, activities: activitiesTarget, settingsTarget,
  });
  assert.equal(result.discoveryRestored, 2, 'discovery comes back through the GME-06 restore');
  assert.equal(result.activitiesRestored, 1, 'progress lands on its deterministic ids');
  assert.equal(activitiesTarget[0].state, 'complete');
  assert.equal(activitiesTarget[0].progress, 1);
  assert.equal(activitiesTarget[1].state, 'active', 'an id the save does not know is left alone');
  assert.equal(settingsTarget.profile, 'balanced');
  assert.equal(settingsTarget.touchControls, true);
  assert.equal(second.diagnostics.restores, 1);
});

test('NET-01 the v0 journal payload migrates into the envelope', () => {
  // A world that only ever ran `GME-06` wrote the bare journal payload.
  const journal = sampleDiscovery();
  const store = memoryStore({ 'gdo:discoveryJournal:v1:state': JSON.stringify(journal.toJSON()) });
  const save = createLocalSave({ storage: store, key: 'gdo:discoveryJournal:v1:state' });
  const loaded = save.load();
  assert.ok(loaded, 'the legacy payload is recognized');
  assert.equal(loaded.schema, GDO_SAVE_SCHEMA, 'the migration chain lands on the current schema');
  assert.equal(save.counters.migrations, 1);
  assert.ok(loaded.discovery, 'the discovery data is carried into the envelope, not abandoned');
  const restored = createDiscoveryJournal({ profile: 'low' });
  const result = save.restore(loaded, { journal: restored });
  assert.equal(result.discoveryRestored, 2);
  // The chain is declarative: the shipped step walks 0 → 1 exactly.
  assert.equal(GDO_SAVE_MIGRATIONS[0].from, 0);
  assert.equal(GDO_SAVE_MIGRATIONS[0].to, 1);
});

test('NET-01 a future schema and a foreign namespace refuse by name', () => {
  const future = memoryStore({ 'gdo:saveSchema:v1:state': JSON.stringify({
    namespace: GDO_SAVE_NAMESPACE, schema: 99,
  }) });
  const futureSave = createLocalSave({ storage: future });
  assert.equal(futureSave.load(), null);
  assert.equal(futureSave.counters.lastReason, GDO_SAVE_REFUSAL.FUTURE);

  const foreign = memoryStore({ 'gdo:saveSchema:v1:state': JSON.stringify({
    namespace: 'gdo:someoneElse:v9', schema: 3,
  }) });
  const foreignSave = createLocalSave({ storage: foreign });
  assert.equal(foreignSave.load(), null);
  assert.equal(foreignSave.counters.lastReason, GDO_SAVE_REFUSAL.FOREIGN);

  const malformed = memoryStore({ 'gdo:saveSchema:v1:state': '{oops' });
  const malformedSave = createLocalSave({ storage: malformed });
  assert.equal(malformedSave.load(), null);
  assert.equal(malformedSave.counters.lastReason, GDO_SAVE_REFUSAL.MALFORMED);

  const emptySave = createLocalSave({ storage: memoryStore() });
  assert.equal(emptySave.load(), null);
  assert.equal(emptySave.counters.lastReason, GDO_SAVE_REFUSAL.NO_PAYLOAD);
  assert.equal(emptySave.counters.rejected, 0, 'a missing save is not a rejection');
});

test('NET-01 settings are validated against the declared vocabulary', () => {
  const save = createLocalSave({ storage: memoryStore() });
  const envelope = save.capture({
    settings: {
      profile: 'ultra',          // invalid enum
      touchControls: 'yes',      // invalid type
      reducedMotion: true,       // valid
      difficulty: 'hard',        // unknown key
    },
  });
  assert.deepEqual(Object.keys(envelope.settings), ['reducedMotion']);
  assert.equal(save.refusals[GDO_SAVE_REFUSAL.UNKNOWN_SETTING], 1);
  assert.equal(save.refusals[GDO_SAVE_REFUSAL.INVALID_SETTING], 2);
  for (const key of Object.keys(GDO_SAVE_SETTINGS)) {
    assert.ok(Array.isArray(GDO_SAVE_SETTINGS[key]), 'every setting declares its vocabulary');
    assert.ok(GDO_SAVE_SETTINGS[key].length > 0);
  }
});

test('NET-01 progress is pruned deterministically, never invented', () => {
  const save = createLocalSave({ storage: memoryStore() });
  const envelope = save.capture({
    activities: [
      { id: 'act:a', progress: 1, state: 'complete' },
      { id: 'act:a', progress: 3, state: 'complete' },   // duplicate id
      { id: '', progress: 0, state: 'active' },           // empty id
      { id: 'act:b', progress: -1, state: 'active' },     // negative progress
      { id: 'act:c', progress: 0, state: 'done' },        // unknown state
      null,
      { id: 'act:d', progress: 2.5, state: 'active' },
    ],
  });
  assert.deepEqual(envelope.progress.activities.map(entry => entry.id), ['act:a', 'act:d']);
  assert.equal(save.refusals[GDO_SAVE_REFUSAL.INVALID_PROGRESS], 5);
  assert.equal(envelope.progress.activities[1].progress, 2.5);
});

test('NET-01 storage failures are counted, never thrown', () => {
  const full = memoryStore();
  full.setItem = () => { throw new Error('QuotaExceededError'); };
  const save = createLocalSave({ storage: full });
  assert.equal(save.persist(save.capture({ settings: { profile: 'low' } })), false);
  assert.equal(save.counters.lastReason, GDO_SAVE_REFUSAL.STORAGE_FULL);

  const unreadable = memoryStore();
  unreadable.getItem = () => { throw new Error('SecurityError'); };
  const reader = createLocalSave({ storage: unreadable });
  assert.equal(reader.load(), null);
  assert.equal(reader.counters.lastReason, GDO_SAVE_REFUSAL.STORAGE_UNREADABLE);

  // A host without storage still runs: it just cannot persist.
  const headless = createLocalSave({ storage: null });
  assert.equal(headless.persist(headless.capture({})), false);
  assert.equal(headless.load(), null);
});

test('NET-01 the save schema is the FND-06 placeholder, now produced', () => {
  assert.equal(GDO_FEATURE_VERSIONS.saveSchema, 1);
  assert.equal(GDO_SAVE_NAMESPACE, 'gdo:saveSchema:v1');
  assert.equal(featureAvailable('saveSchema'), true);
  assert.equal(GDO_SAVE_SCHEMA, 1);
  assert.throws(() => createLocalSave({ storage: {}, key: '' }), TypeError);
  assert.throws(() => createLocalSave({ storage: { getItem: 1, setItem: 2 } }), TypeError);
});

test('NET-01 a save/load cycle is deterministic byte-for-byte', () => {
  const store = memoryStore();
  const journal = sampleDiscovery();
  const run = () => {
    const save = createLocalSave({ storage: store, key: 'cycle', nowMilliseconds: 42 });
    const envelope = save.capture({
      settings: { profile: 'low', cameraFade: true },
      discovery: journal.toJSON(),
      activities: ACTIVITIES,
      worldVersion: 1,
    });
    save.persist(envelope);
    return store.getItem('cycle');
  };
  assert.equal(run(), run(), 'the same state saves the same bytes');
});
