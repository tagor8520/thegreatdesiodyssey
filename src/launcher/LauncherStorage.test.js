import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_LAUNCHER_KEY,
  GDO_LAUNCHER_LIMITS,
  GDO_LAUNCHER_NAMESPACE,
  GDO_LAUNCHER_REFUSAL,
  clearPlayerSave,
  createLauncherStorage,
  readPlayerSettings,
  writePlayerSettings,
} from './LauncherStorage.js';
import { createLocalSave, GDO_SAVE_NAMESPACE } from '../engine/LocalSave.js';

/** The smallest store that behaves like localStorage, including throwing on read. */
function fakeStorage(initial = {}, { throwOnRead = false, throwOnWrite = false } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) { if (throwOnRead) throw new Error('blocked'); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { if (throwOnWrite) throw new Error('full'); map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

/**
 * The launcher remembers where you were, and everything else it writes goes
 * through the `NET-01` envelope. The tests below are mostly about what it must
 * *not* erase: a settings screen that drops the discovery journal would be a
 * silent save wipe.
 */

test('the launcher record is versioned, bounded, and de-duplicated', () => {
  const storage = fakeStorage();
  const store = createLauncherStorage({ storage });
  assert.equal(store.namespace, GDO_LAUNCHER_NAMESPACE);
  assert.equal(GDO_LAUNCHER_KEY, 'gdo:launcher:v1:state');
  assert.deepEqual(store.load(), { last: null, recents: [], launches: 0 }, 'a fresh browser has no last place');

  store.recordLaunch({ kind: 'location', id: 'delhi-india-gate' });
  store.recordLaunch({ kind: 'location', id: 'mumbai-gateway' });
  assert.equal(store.state.last.id, 'mumbai-gateway');
  assert.equal(store.state.launches, 2);

  // Re-launching a place moves it to the front instead of duplicating it.
  store.recordLaunch({ kind: 'location', id: 'delhi-india-gate' });
  assert.deepEqual(store.state.recents.map(place => place.id), ['delhi-india-gate', 'mumbai-gateway']);

  // Typed coordinates are remembered as a pin, not as a catalogue id.
  store.recordLaunch({ kind: 'coordinate', latitude: 26.9124, longitude: 75.7873 });
  assert.equal(store.state.recents[0].kind, 'coordinate');
  assert.equal(store.state.recents[0].id, null);
  assert.equal(store.state.recents[0].name, 'Dropped pin');

  // The list is capped, oldest first out.
  for (let index = 0; index < GDO_LAUNCHER_LIMITS.recents + 4; index++) {
    store.recordLaunch({ kind: 'coordinate', latitude: 10 + index, longitude: 70 + index });
  }
  assert.equal(store.state.recents.length, GDO_LAUNCHER_LIMITS.recents);

  // And it survives a reload through the same envelope.
  const reloaded = createLauncherStorage({ storage });
  reloaded.load();
  assert.equal(reloaded.state.recents.length, GDO_LAUNCHER_LIMITS.recents);
  assert.equal(reloaded.state.last.kind, 'coordinate');
  // Four explicit launches plus the capped-list loop; a re-launch counts too.
  assert.equal(reloaded.state.launches, 4 + GDO_LAUNCHER_LIMITS.recents + 4);
});

test('a payload it cannot trust is refused by name and replaced by an empty state', () => {
  const future = fakeStorage({ [GDO_LAUNCHER_KEY]: JSON.stringify({ namespace: GDO_LAUNCHER_NAMESPACE, schema: 9, last: null, recents: [] }) });
  const futureStore = createLauncherStorage({ storage: future });
  assert.deepEqual(futureStore.load(), { last: null, recents: [], launches: 0 });
  assert.equal(futureStore.diagnostics.refusals[GDO_LAUNCHER_REFUSAL.FUTURE], 1);

  const foreign = fakeStorage({ [GDO_LAUNCHER_KEY]: JSON.stringify({ namespace: 'someone-else', schema: 1 }) });
  const foreignStore = createLauncherStorage({ storage: foreign });
  assert.deepEqual(foreignStore.load(), { last: null, recents: [], launches: 0 });
  assert.equal(foreignStore.diagnostics.refusals[GDO_LAUNCHER_REFUSAL.FOREIGN], 1);

  const broken = fakeStorage({ [GDO_LAUNCHER_KEY]: '{not json' });
  const brokenStore = createLauncherStorage({ storage: broken });
  brokenStore.load();
  assert.equal(brokenStore.diagnostics.refusals[GDO_LAUNCHER_REFUSAL.MALFORMED], 1);

  const blocked = fakeStorage({}, { throwOnRead: true });
  const blockedStore = createLauncherStorage({ storage: blocked });
  blockedStore.load();
  assert.equal(blockedStore.diagnostics.refusals[GDO_LAUNCHER_REFUSAL.UNREADABLE], 1);

  const none = createLauncherStorage({ storage: null });
  none.load();
  assert.equal(none.diagnostics.refusals[GDO_LAUNCHER_REFUSAL.NO_STORAGE], 1);

  const full = fakeStorage({}, { throwOnWrite: true });
  const fullStore = createLauncherStorage({ storage: full });
  const recorded = fullStore.recordLaunch({ kind: 'location', id: 'leh-bazaar' });
  assert.equal(recorded.id, 'leh-bazaar', 'an unwritable store keeps the in-memory record');
  assert.equal(fullStore.diagnostics.refusals[GDO_LAUNCHER_REFUSAL.FULL], 1);

  // A record whose place has left the catalogue is dropped, not shown broken.
  const stale = fakeStorage({ [GDO_LAUNCHER_KEY]: JSON.stringify({
    namespace: GDO_LAUNCHER_NAMESPACE, schema: 1,
    last: { kind: 'location', id: 'atlantis' },
    recents: [{ kind: 'location', id: 'atlantis' }, { kind: 'location', id: 'delhi-india-gate' }],
  }) });
  const staleStore = createLauncherStorage({ storage: stale });
  staleStore.load();
  assert.equal(staleStore.state.last, null);
  assert.deepEqual(staleStore.state.recents.map(place => place.id), ['delhi-india-gate']);
});

test('clear forgets the launcher record without touching the save', () => {
  const storage = fakeStorage();
  const store = createLauncherStorage({ storage });
  store.recordLaunch({ kind: 'location', id: 'kochi-fort' });
  assert.ok(storage.map.has(GDO_LAUNCHER_KEY));
  store.clear();
  assert.equal(storage.map.has(GDO_LAUNCHER_KEY), false);
  assert.deepEqual(store.state, { last: null, recents: [], launches: 0 });
});

test('settings reads fall back to declared defaults, and own only the declared keys', () => {
  const storage = fakeStorage();
  const empty = readPlayerSettings(storage, { fallbackProfile: 'balanced' });
  assert.equal(empty.ok, false);
  assert.equal(empty.settings.profile, 'balanced', 'the device suggestion is the first-run default');
  assert.equal(empty.settings.weatherEffects, true);
  assert.deepEqual(empty.settings.keyBindings, {});

  assert.equal(writePlayerSettings(storage, { profile: 'high', reducedMotion: true }).ok, true);
  const read = readPlayerSettings(storage);
  assert.equal(read.ok, true);
  assert.equal(read.settings.profile, 'high');
  assert.equal(read.settings.reducedMotion, true);

  // A key the envelope does not declare is not written; a bad value is skipped.
  writePlayerSettings(storage, { profile: 'ultra', madeUpSetting: 'yes', cameraFade: false });
  const filtered = readPlayerSettings(storage);
  assert.equal(filtered.settings.profile, 'high', 'the invalid value was refused, not stored');
  assert.equal(filtered.settings.cameraFade, false);
  assert.equal('madeUpSetting' in filtered.settings, false);

  assert.equal(writePlayerSettings(null, { profile: 'low' }).refusal, GDO_LAUNCHER_REFUSAL.NO_STORAGE);
});

test('a settings write carries the journal and progress forward untouched', () => {
  const storage = fakeStorage();
  const save = createLocalSave({ storage });
  const discovery = { namespace: 'gdo:discovery:v1', places: ['p:1'], visited: [], sightings: [] };
  const envelope = save.capture({
    settings: { profile: 'low', reducedMotion: false },
    discovery,
    activities: [{ id: 'walk-1', progress: 0.5, state: 'active' }],
    worldVersion: 7,
  });
  assert.equal(save.persist(envelope), true);

  // The options screen changes one toggle.
  const written = writePlayerSettings(storage, { reducedMotion: true });
  assert.equal(written.ok, true);
  assert.equal(written.settings.reducedMotion, true);

  const reloaded = createLocalSave({ storage }).load();
  assert.equal(reloaded.namespace, GDO_SAVE_NAMESPACE);
  assert.equal(reloaded.settings.reducedMotion, true);
  assert.equal(reloaded.settings.profile, 'low', 'the untouched settings survive');
  assert.deepEqual(reloaded.discovery.places, ['p:1'], 'the visited-places journal is not erased');
  assert.deepEqual(reloaded.progress.activities, [{ id: 'walk-1', progress: 0.5, state: 'active' }]);
  assert.equal(reloaded.worldVersion, 7);
});

test('erasing the save is one explicit call and leaves the launcher record alone', () => {
  const storage = fakeStorage();
  const store = createLauncherStorage({ storage });
  store.recordLaunch({ kind: 'location', id: 'varanasi-ghat' });
  writePlayerSettings(storage, { profile: 'high' });
  assert.ok(storage.map.has(`${GDO_SAVE_NAMESPACE}:state`));

  assert.deepEqual(clearPlayerSave(storage), { ok: true });
  assert.equal(storage.map.has(`${GDO_SAVE_NAMESPACE}:state`), false);
  assert.equal(readPlayerSettings(storage).ok, false);
  assert.equal(store.state.last.id, 'varanasi-ghat', 'the launcher still knows where you were');
  assert.equal(clearPlayerSave(null).refusal, GDO_LAUNCHER_REFUSAL.NO_STORAGE);
});
