/**
 * `NET-01` — versioned local save (Node tier).
 *
 * The registered gate is *"Migration-safe settings/discovery/progress"*, and this file is where
 * each word is given its own teeth:
 *
 * - **settings** — the declared table *is* the schema: every declared field round-trips, an
 *   undeclared key is refused by validation rather than silently carried, and the pre-schema
 *   `0`/`1` encoding is repaired by the ladder rather than at read time.
 * - **discovery** — the section round-trips through the **real** journal and the **real** id
 *   function, and an entry whose stored id is not the id of its own place is refused on the way
 *   back in. That is the check that makes `GME-06`'s determinism claim survive contact with a
 *   file a player can edit.
 * - **progress** — instance ids keyed by the content-pack vocabulary, bounded by the content
 *   schema's own authoring cap, deduped, and restored into the **real** `ItemManager`, so a
 *   reload removes exactly the collectibles a previous session took and returns exactly their
 *   points.
 * - **migration-safe** — a v0 document is repaired by the ladder and validates afterwards; a
 *   future version is refused; an unreadable document is left exactly where it is and copied
 *   aside; and the writer refuses to persist anything the reader would reject.
 *
 * Everything runs without a browser: the store is exercised against `createMemoryStorage`, and
 * the runtime-facing halves are the real classes. The browser tier
 * (`tools/visual-audit/scenarios/local-save.mjs`) is what proves both runtimes call this and
 * that `localStorage` across a reload carries the session.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';

import {
  GDO_SAVE_BACKUP_KEY, GDO_SAVE_LIMITS, GDO_SAVE_STORAGE_KEY, GDO_SAVE_VERSION,
  SAVE_INSTANCE_ID_PATTERN, SAVE_SETTING_FIELDS, SAVE_STATE_ID_PATTERN,
  SaveStore, canonicalSave, captureDiscovery, captureProgress, captureProgressState,
  collectedInstances, createEmptySave, createMemoryStorage,
  decodeSave, defaultSettings, detectSaveVersion, encodeSave, fitSaveToLimits, migrateSave,
  restoreDiscovery, saveByteLength, validateSave,
} from './SaveState.js';
import { DiscoveryJournal, discoveryPlaceId } from './DiscoveryJournal.js';
import { GDO_GENERATOR_VERSION } from './FeatureVersions.js';
import { STATE_CONTENT_LIMITS } from './ContentSchema.js';
import { FOOD_ITEMS, ItemManager } from '../reference/ItemManager.js';

const PLACES = [
  { name: 'Sardar Patel Marg', kind: 'street', x: 120.5, z: -40.25 },
  { name: 'Nangal Sagar', kind: 'water', x: -300.125, z: 88 },
  { name: 'Sadar Bazaar', kind: 'settlement', x: 18, z: 402.75 },
];

/** A v0 document: the pre-schema shape, with every repair the ladder makes already in it. */
function legacySave() {
  const stale = { name: 'Sadar Bazaar', kind: 'settlement', x: 18, z: 402.75, id: 'settlement:sadar-bazaar:deadbeef' };
  return {
    options: { sound: 0, showDebug: 1, nonsenseSetting: 'carried from an older build' },
    discovered: [
      { name: 'Sardar Patel Marg', kind: 'street', x: 120.5, z: -40.25 },
      stale,
    ],
    progress: { states: { maharashtra: { collected: ['vada-pav:0', 'vada-pav:0', 'not-an-id', 'cutting-chai:2'], score: 25 } } },
  };
}

test('the settings table is the schema, and every declared field round-trips', () => {
  const save = createEmptySave({ writtenAt: 1 });
  assert.deepEqual(save.settings, defaultSettings(), 'an empty save starts at the declared fallbacks');
  for (const [name, field] of Object.entries(SAVE_SETTING_FIELDS)) {
    assert.equal(field.type, 'boolean', `${name} declares a type the validator knows`);
    assert.ok(field.description.length > 20, `${name} says why it exists`);
    save.settings[name] = !field.fallback;
  }
  assert.deepEqual(validateSave(save).problems, [], 'a save with every declared field set validates');

  const decoded = decodeSave(encodeSave(save));
  assert.deepEqual(decoded.problems, []);
  assert.deepEqual(decoded.save.settings, save.settings, 'settings survive the round trip');

  // An undeclared key is a *problem* in a v1 document rather than a warning: no v1 writer can
  // produce one, so it means the file was edited, and carrying it forward would make the table
  // advisory instead of binding.
  const edited = { ...save, settings: { ...save.settings, cheatMode: true } };
  assert.match(validateSave(edited).problems.join(' | '), /setting "cheatMode" is not declared/);
  const missing = { ...save, settings: { ...save.settings } };
  delete missing.settings.soundEnabled;
  assert.match(validateSave(missing).problems.join(' | '), /setting "soundEnabled" is missing/);
  const wrongType = { ...save, settings: { ...save.settings, soundEnabled: 'yes please' } };
  assert.match(validateSave(wrongType).problems.join(' | '), /must be a boolean/);
});

test('the v0 ladder repairs what is unambiguous and refuses to invent the rest', () => {
  const legacy = legacySave();
  assert.equal(detectSaveVersion(legacy), 0, 'an unstamped document is version 0');
  assert.match(validateSave(legacy).problems.join(' | '), /legacy save and must be migrated/);

  const migration = migrateSave(legacy);
  assert.deepEqual(migration.problems, []);
  assert.equal(migration.migrated, true);
  assert.equal(migration.to, 1);
  const notes = migration.notes.join('\n');
  assert.match(notes, /called its settings section "options"/);
  assert.match(notes, /"sound" is not declared by this build and was dropped/);
  assert.match(notes, /setting "showDebug" was stored as 1 and now reads true/);
  assert.match(notes, /"nonsenseSetting" is not declared by this build and was dropped/);
  assert.match(notes, /is not the id of its own place — re-derived as/);
  assert.match(notes, /"vada-pav:0" was listed twice and now counts once/);
  assert.match(notes, /"not-an-id" in maharashtra is not a collectible instance id and was dropped/);

  const migrated = migration.data;
  assert.equal(migrated.settings.soundEnabled, true, 'an undeclared key falls back to the declared default');
  assert.equal(migrated.settings.showDebug, true, '0/1 is repaired rather than dropped');
  assert.equal(migrated.discovery.entries.length, 2);
  assert.equal(migrated.discovery.entries[1].id, discoveryPlaceId('Sadar Bazaar', 'settlement', 18, 402.75),
    'a stale id is re-derived from the place, which is the only reading that is not invention');
  assert.deepEqual(migrated.progress.states.maharashtra.collected, ['vada-pav:0', 'cutting-chai:2']);
  assert.deepEqual(validateSave(migrated).problems, [], 'the migrated document validates');
  assert.equal(migrated.discovery.entries[0].discoveredAt, 0, 'a missing reading defaults rather than being invented');

  // A bare collected list has no state to key by; the ladder reads it as the state the shipped
  // collectibles use, and says so, rather than dropping the player's progress.
  const bare = migrateSave({ collected: ['banana-chips:1'], score: 10 });
  assert.match(bare.notes.join('\n'), /unattributed collected list was read as/);
  assert.deepEqual(bare.data.progress.states.curated.collected, ['banana-chips:1']);

  // Migrating twice is a no-op rather than a second repair pass, and it is the *same object*.
  const again = migrateSave(migrated);
  assert.equal(again.migrated, false);
  assert.equal(again.data, migrated);
});

test('a document from the future is refused, and a corrupt one is reported rather than thrown', () => {
  const future = { ...createEmptySave({ writtenAt: 0 }), schemaVersion: GDO_SAVE_VERSION + 1 };
  const migration = migrateSave(future);
  assert.equal(migration.migrated, false);
  assert.match(migration.problems.join(' | '), /authored for a newer save schema/);
  assert.equal(decodeSave(JSON.stringify(future)).save, null);
  assert.match(decodeSave(JSON.stringify(future)).problems.join(' | '), /newer save schema/);

  assert.equal(decodeSave('{"schemaVersion":1,').save, null);
  assert.match(decodeSave('{"schemaVersion":1,').problems.join(' | '), /not valid JSON/);
  assert.equal(decodeSave('').save, null);
  assert.equal(decodeSave(null).save, null);
  assert.match(decodeSave({}).problems.join(' | '), /not text/);
  assert.match(decodeSave('[]').problems.join(' | '), /a save must be an object/);
  assert.equal(decodeSave(JSON.stringify(createEmptySave())).save.schemaVersion, 1);
  const otherBuild = { ...createEmptySave(), worldVersion: 'gdo:registry@1|mapTile@9' };
  assert.match(validateSave(otherBuild).warnings.join(' | '), /written by a different generator version/,
    'a save from another generator build is a warning, not a refusal');
  assert.match(decodeSave(JSON.stringify(otherBuild)).warnings.join(' | '), /different generator version/);
  assert.deepEqual(decodeSave(JSON.stringify(otherBuild)).problems, []);
});

test('the id is checked against the place, so a hand-edited save cannot invent a discovery', () => {
  const journal = new DiscoveryJournal();
  PLACES.forEach((place, index) => journal.update(place, [place], { now: 100 + index }));
  assert.equal(journal.size, 3);
  const section = captureDiscovery(journal);
  assert.equal(section.entries.length, 3);
  assert.equal(section.dropped, 0);
  assert.deepEqual(section.entries.map(entry => entry.kind), ['street', 'water', 'settlement'],
    'oldest first, and equal readings are ordered by id so the section is stable either way');

  const reloaded = new DiscoveryJournal();
  const first = restoreDiscovery(reloaded, section);
  assert.deepEqual(first.problems, []);
  assert.equal(first.restored, 3);
  assert.deepEqual(reloaded.list().map(entry => entry.id), journal.list().map(entry => entry.id));
  assert.equal(reloaded.diagnostics().restored, 3, 'the journal counts restored entries separately');
  assert.equal(
    reloaded.diagnostics().discoveries + reloaded.diagnostics().restored - reloaded.diagnostics().evicted,
    reloaded.size,
    'the accounting identity gained its restored term when saves arrived',
  );
  // Restoring twice changes nothing: a place is one entry however it arrived.
  assert.equal(restoreDiscovery(reloaded, section).restored, 0);
  assert.equal(reloaded.size, 3);

  // An edited id, and an edited anchor that no longer matches its id.
  const invented = { entries: [{ ...section.entries[0], id: 'street:invented:00000000' }] };
  const refusal = restoreDiscovery(new DiscoveryJournal(), invented);
  assert.equal(refusal.restored, 0);
  assert.equal(refusal.dropped, 1);
  assert.match(refusal.problems.join(' | '), /is not the id of its own place/);
  const moved = { entries: [{ ...section.entries[1], x: section.entries[1].x + 500 }] };
  assert.match(restoreDiscovery(new DiscoveryJournal(), moved).problems.join(' | '), /is not the id of its own place/);

  // The save-level reader refuses the same document, so a hand-edited file never reaches the
  // journal at all.
  const editedSave = createEmptySave({ writtenAt: 5 });
  editedSave.discovery.entries = invented.entries;
  assert.match(validateSave(editedSave).problems.join(' | '), /\.id is not the id of its own place/);

  // Restoring into a journal that is already full declines rather than displacing: the retained
  // set is chosen by the clock, and a restored entry can carry an older reading than everything
  // held — displacing on restore would evict a place found *this* session for one found last week.
  const small = new DiscoveryJournal({ capacity: 1 });
  small.update({ ...PLACES[0] }, [PLACES[0]], { now: 50 });
  const declined = restoreDiscovery(small, { entries: [section.entries[2]] });
  assert.equal(declined.restored, 0);
  assert.equal(declined.dropped, 1);
  assert.equal(small.find({ id: section.entries[0].id }).id, section.entries[0].id, 'the held place is still held');
});

test('a restored reading is rebased into the live clock, so a save cannot look like a backwards clock', () => {
  // A place found in an earlier session: its reading is an order from that session's clock.
  const earlier = new DiscoveryJournal();
  earlier.update(PLACES[0], [PLACES[0]], { now: 100 });
  const section = captureDiscovery(earlier);
  assert.deepEqual(section.entries.map(entry => entry.discoveredAt), [100]);

  // The next session is already on its own clock when the save is read — the clock a page load
  // restarts at zero, but which the frame loop has moved by the time a restore can run.
  const session = new DiscoveryJournal();
  session.update(PLACES[1], [PLACES[1]], { now: 5_000 });
  const report = restoreDiscovery(session, section);
  assert.equal(report.restored, 1);
  assert.equal(report.rebased, true, 'the section was rebased, and says so');

  const rows = session.list();
  assert.equal(rows.length, 2);
  const restored = rows.find(row => row.id === section.entries[0].id);
  assert.ok(restored, 'the stored place is held');
  assert.ok(restored.discoveredAt > 5_000 && restored.discoveredAt < 5_001,
    `the stored reading was rebased into the live clock's frame, received ${restored.discoveredAt}`);
  assert.equal(session.diagnostics().clock, 5_000, 'a stored reading does not move the session clock');
  assert.equal(rows[1].id, restored.id, 'the restored place sorts after the place this session found');

  // The identity that matters: the frame loop keeps advancing from its own clock, and the places
  // it finds afterwards read later than the restored ones rather than throwing or interleaving.
  assert.equal(session.update(PLACES[2], [PLACES[2]], { now: 5_500 }), 1);
  assert.equal(session.list()[2].id, discoveryPlaceId(PLACES[2].name, PLACES[2].kind, PLACES[2].x, PLACES[2].z));
  assert.equal(session.diagnostics().clock, 5_500);

  // Rebasing does not change the answer to a full journal: the container is consulted first, so a
  // restore into a journal that is already full still declines without displacing what is held.
  const full = new DiscoveryJournal({ capacity: 1 });
  full.update(PLACES[1], [PLACES[1]], { now: 5_000 });
  const declined = restoreDiscovery(full, captureDiscovery(new DiscoveryJournal()));
  assert.equal(declined.restored, 0);
  assert.equal(full.size, 1);
  assert.equal(full.list()[0].id, discoveryPlaceId(PLACES[1].name, PLACES[1].kind, PLACES[1].x, PLACES[1].z));
});

test('progress is keyed by the content vocabulary and restored into the real item manager', () => {
  const scene = new THREE.Scene();
  const items = new ItemManager(scene, { seed: 2026, perType: 2 });
  assert.equal(items.total, FOOD_ITEMS.length * 2);
  for (const id of ['vada-pav:0', 'vada-pav:1', 'banana-chips:0']) {
    // The instance-id format the save validates is the format the manager produces.
    assert.ok(SAVE_INSTANCE_ID_PATTERN.test(id), `${id} matches the instance-id pattern`);
    assert.ok(items.items.has(id), `${id} is a real instance in the seeded layout`);
  }
  assert.ok(!SAVE_INSTANCE_ID_PATTERN.test('vada-pav'), 'a bare definition id is not an instance id');
  assert.ok(SAVE_STATE_ID_PATTERN.test('maharashtra') && !SAVE_STATE_ID_PATTERN.test('Maharashtra Pradesh'));
  // The key a save uses is the *biome*, which is the one naming scheme the item definitions and
  // the content packs already share; the instance ids are the collector's own. The two id
  // vocabularies disagree about hyphens (`vada-pav` vs `vada_pav` in the shipped packs), which
  // is recorded here because the save is the first feature that had to live with both.
  const pack = JSON.parse(readFileSync(new URL('../../public/content/states/maharashtra.json', import.meta.url), 'utf8'));
  assert.ok(pack.collectibles.every(item => /^[a-z][a-z0-9_]*$/.test(item.id)), 'pack ids are underscore-shaped');
  assert.ok(FOOD_ITEMS.every(item => !SAVE_STATE_ID_PATTERN.test(item.id)), 'item ids are hyphen-shaped');
  assert.ok(FOOD_ITEMS.some(item => item.biome === 'maharashtra'), 'and the biome is what both agree on');

  // Collect two items the way the frame loop does, then read the section off the manager.
  const collected = [];
  for (const id of ['vada-pav:1', 'banana-chips:0']) {
    const item = items.items.get(id);
    item.mesh.visible = true;
    const centre = item.mesh.position;
    items.update(0, new THREE.Box3(
      new THREE.Vector3(centre.x - 1, centre.y - 1, centre.z - 1),
      new THREE.Vector3(centre.x + 1, centre.y + 1, centre.z + 1),
    ));
    collected.push(id);
  }
  assert.equal(items.collected, 2);
  assert.deepEqual(items.collectedIds, collected);
  const progress = captureProgress({
    lastMode: 'curated',
    lastCoordinate: { latitude: 28.98451, longitude: 77.70644 },
    states: items.progressByState(),
  });
  assert.deepEqual(Object.keys(progress.states).sort(), ['kerala', 'maharashtra'],
    'the keys are the content-pack vocabulary the collectibles already use');
  assert.equal(progress.states.maharashtra.score, 10);
  assert.equal(progress.states.kerala.score, 10);
  assert.deepEqual(progress.lastCoordinate, { latitude: 28.985, longitude: 77.706 }, 'coordinates are rounded for stable bytes');

  // A second session, same seed: the same ids are the same items in the same places, so
  // restoring removes exactly what was taken and returns exactly the points.
  const reloaded = new ItemManager(new THREE.Scene(), { seed: 2026, perType: 2 });
  const restored = reloaded.restore(collectedInstances(progress));
  assert.deepEqual(restored, { restored: 2, missing: [] });
  assert.equal(reloaded.collected, 2);
  assert.equal(reloaded.score, 20);
  assert.ok(!reloaded.items.has('vada-pav:1') && !reloaded.items.has('banana-chips:0'), 'the collected items are gone');
  assert.equal(reloaded.items.size, items.items.size, 'and nothing else moved');
  assert.deepEqual(reloaded.progressByState(), items.progressByState(), 'the state round-trips exactly');

  // An id the layout cannot place is reported, not ignored: the save names something this
  // build cannot put on the ground.
  const missing = new ItemManager(new THREE.Scene(), { seed: 2026, perType: 2 }).restore(['vada-pav:99']);
  assert.deepEqual(missing, { restored: 0, missing: ['vada-pav:99'] });

  // Bounds come from the content schema, not from a second number that could drift from it.
  assert.equal(GDO_SAVE_LIMITS.collectedPerState, STATE_CONTENT_LIMITS.collectiblesPerState);
  assert.equal(GDO_SAVE_LIMITS.discoveries, 128);
  const over = captureProgressState(Array.from({ length: GDO_SAVE_LIMITS.collectedPerState + 25 }, (_, index) => `vada-pav:${index}`));
  assert.equal(over.collected.length, GDO_SAVE_LIMITS.collectedPerState);
  assert.equal(new Set(over.collected).size, over.collected.length);

  // ...and the validator enforces the same bound when the file arrives from outside.
  const bloated = createEmptySave({ writtenAt: 1 });
  bloated.progress.states.maharashtra = { collected: Array.from({ length: GDO_SAVE_LIMITS.collectedPerState + 1 }, (_, index) => `vada-pav:${index}`), score: 0 };
  assert.match(validateSave(bloated).problems.join(' | '), /against a ceiling of 64/);
});

test('the document is written once per change, coalesced by an interval, and flushed on the way out', () => {
  const storage = createMemoryStorage();
  let now = 5_000;
  const store = new SaveStore({ storage, clock: () => now, intervalMs: 1000 });
  assert.equal(store.read().loaded, false, 'no session has been saved yet, which is not a problem');

  // Sixty frame ticks with nothing changed write nothing at all.
  for (let frame = 0; frame < 60; frame++) store.tick(now + frame * 16.67);
  assert.equal(store.counters.writes, 0);
  assert.equal(store.counters.unchangedSkips, 60, 'a still world is not a change');
  assert.equal(storage.getItem(GDO_SAVE_STORAGE_KEY), null);

  // A change is written on the next tick.
  const document = store.save;
  store.update(save => { save.settings.showDebug = true; });
  store.tick(now);
  assert.equal(store.counters.writes, 1, 'one write for one change');
  assert.equal(store.save, document, 'the document is the same object across a write');
  assert.equal(JSON.parse(storage.getItem(GDO_SAVE_STORAGE_KEY)).settings.showDebug, true);

  // A second change *inside* the interval is coalesced rather than written immediately: the
  // frame loop ticks sixty times a second and the document is not written sixty times.
  now += 200;
  store.update(save => { save.progress.lastMode = 'coordinate'; });
  for (let frame = 0; frame < 30; frame++) store.tick(now + frame * 16.67);
  assert.equal(store.counters.writes, 1, 'still one write: the change is inside the interval');
  assert.equal(store.counters.coalesced, 30, 'every tick inside the interval was coalesced');
  assert.equal(store.dirty, true, 'the change is held, not dropped');

  // Past the interval it is written, and the same change again is not a second write: the
  // canonical bytes are compared with the timestamp removed, so a moving clock is not mistaken
  // for a moving save.
  now += 2_000;
  assert.equal(store.tick(now), true);
  assert.equal(store.counters.writes, 2);
  const skipsBefore = store.counters.unchangedSkips;
  now += 2_000;
  store.update(save => { save.progress.lastMode = 'coordinate'; });
  store.tick(now);
  assert.equal(store.counters.writes, 2, 'a write that would not change the bytes does not happen');
  assert.ok(store.counters.unchangedSkips > skipsBefore);

  // A real change after the interval is written, and `now` lands in the document.
  const writesBefore = store.counters.writes;
  now += 2_000;
  store.update(save => { save.progress.lastCoordinate = { latitude: 28.9845, longitude: 77.7064 }; });
  assert.equal(store.tick(now), true);
  assert.equal(store.counters.writes, writesBefore + 1);
  const stored = JSON.parse(storage.getItem(GDO_SAVE_STORAGE_KEY));
  // Rounded to three decimals on the way out, which is the canonical form's rule: finer than
  // the id quantisation can see, and what makes two saves of one state encode identically.
  assert.deepEqual(stored.progress.lastCoordinate, { latitude: 28.985, longitude: 77.706 });
  assert.deepEqual(store.save.progress.lastCoordinate, { latitude: 28.985, longitude: 77.706 });
  assert.equal(stored.writtenAt, now, 'the document carries the reading it was written at');

  // Flush ignores the interval, which is what a disposing runtime needs.
  now += 10;
  store.update(save => { save.settings.soundEnabled = false; });
  assert.equal(store.flush(now), true);
  assert.equal(store.counters.writesViaFlush, 1);
  assert.equal(store.counters.writes, writesBefore + 2);
  assert.equal(store.save, document, 'and the document is still the same object after a flush');
  assert.equal(store.diagnostics().dirty, false);
  assert.ok(store.diagnostics().bytes > 100 && store.diagnostics().bytes === saveByteLength(storage.getItem(GDO_SAVE_STORAGE_KEY)));

  // Clearing removes both keys and resets the document.
  assert.equal(store.clear(), true);
  assert.equal(storage.getItem(GDO_SAVE_STORAGE_KEY), null);
  assert.deepEqual(store.save, createEmptySave({ writtenAt: 0 }));
});

test('the writer refuses everything the reader would refuse', () => {
  const storage = createMemoryStorage();
  const store = new SaveStore({ storage, clock: () => 0, intervalMs: 0 });
  store.update(save => { save.schemaVersion = 99; });
  assert.equal(store.flush(0), false);
  assert.equal(store.counters.rejected, 1);
  assert.match(store.lastProblem, /newer save schema/);
  assert.equal(storage.getItem(GDO_SAVE_STORAGE_KEY), null, 'an unreadable document is never persisted');
  assert.equal(store.dirty, true, '...and the change stays dirty so the next tick retries');

  // A save over the discovery capacity is refused the same way, so a writer cannot produce a
  // file its own reader rejects on load.
  const store2 = new SaveStore({ storage: createMemoryStorage(), clock: () => 0, intervalMs: 0 });
  store2.update(save => {
    save.discovery.entries = Array.from({ length: GDO_SAVE_LIMITS.discoveries + 1 }, (_, index) => ({
      id: discoveryPlaceId(`Place ${index}`, 'place', index, index), name: `Place ${index}`, kind: 'place',
      x: index, z: index, radius: 32, discoveredAt: index,
    }));
  });
  assert.equal(store2.flush(0), false);
  assert.match(store2.lastProblem, /exceed the journal capacity/);
});

test('an unreadable stored document is kept, copied aside, and never overwritten', () => {
  const text = '{"schemaVersion":7,"settings":{}}';
  const storage = createMemoryStorage({ [GDO_SAVE_STORAGE_KEY]: text });
  const store = new SaveStore({ storage, clock: () => 0, intervalMs: 0 });
  const report = store.read();
  assert.equal(report.loaded, false);
  assert.equal(report.kept, true);
  assert.match(report.problems.join(' | '), /newer save schema/);
  assert.equal(storage.getItem(GDO_SAVE_STORAGE_KEY), text, 'the file the player has is left exactly as it was');
  assert.equal(storage.getItem(GDO_SAVE_BACKUP_KEY), text, 'and copied aside so a support path can recover it');
  assert.deepEqual(store.save, createEmptySave({ writtenAt: 0 }), 'the runtime carries on from empty');

  // Nothing the runtime does afterwards can destroy it by accident: the store is not dirty, so
  // the frame loop's ticks do not rewrite the key.
  for (let frame = 0; frame < 30; frame++) store.tick(frame * 16.67);
  assert.equal(storage.getItem(GDO_SAVE_STORAGE_KEY), text);
  assert.equal(store.diagnostics().available, true);
  assert.equal(store.diagnostics().rejected, 1);
});

test('a legacy document is upgraded in place, and the upgrade is what the next session reads', () => {
  const storage = createMemoryStorage({ [GDO_SAVE_STORAGE_KEY]: JSON.stringify(legacySave()) });
  const store = new SaveStore({ storage, clock: () => 0, intervalMs: 0 });
  const report = store.read();
  assert.equal(report.loaded, true);
  assert.equal(report.migrated, true);
  assert.equal(report.from, 0);
  assert.equal(report.to, 1);
  assert.equal(store.dirty, true, 'a migrated document is marked for writing, which is what makes the ladder load-bearing');
  assert.deepEqual(store.save.progress.states.maharashtra.collected, ['vada-pav:0', 'cutting-chai:2']);
  assert.equal(store.flush(0), true);
  const rewritten = JSON.parse(storage.getItem(GDO_SAVE_STORAGE_KEY));
  assert.equal(rewritten.schemaVersion, 1, 'the file on disk is now the current schema');

  // The second session reads a v1 document: no migration, no notes, same entries.
  const second = new SaveStore({ storage, clock: () => 0, intervalMs: 0 });
  const secondReport = second.read();
  assert.equal(secondReport.migrated, false);
  assert.deepEqual(secondReport.notes, []);
  assert.deepEqual(second.save.discovery.entries, store.save.discovery.entries);

  // And the journal the second session gets is the first session's journal, entry for entry.
  const journal = new DiscoveryJournal();
  const restore = restoreDiscovery(journal, second.save.discovery.entries ? { entries: second.save.discovery.entries } : null);
  assert.equal(restore.restored, 2);
});

test('the byte ceiling drops the oldest records and says so, and a full save still fits', () => {
  const save = createEmptySave({ writtenAt: 0 });
  for (let index = 0; index < GDO_SAVE_LIMITS.discoveries; index++) {
    const name = `Place number ${index} with a deliberately long map name`;
    save.discovery.entries.push({
      id: discoveryPlaceId(name, 'place', index * 137, index * 91), name, kind: 'place',
      x: index * 137, z: index * 91, radius: 32, discoveredAt: index,
    });
  }
  const full = encodeSave(save);
  assert.ok(saveByteLength(full) < GDO_SAVE_LIMITS.bytes,
    `a full journal is ${saveByteLength(full)} bytes, inside the ${GDO_SAVE_LIMITS.bytes} byte ceiling`);
  assert.equal(fitSaveToLimits(save).droppedDiscoveries, 0, 'the shipped cap already fits the ceiling');

  // Force the ceiling down and require the *oldest* records to go first, with a note each.
  const fitted = fitSaveToLimits(save, { limits: { ...GDO_SAVE_LIMITS, bytes: 2_000 } });
  assert.ok(fitted.bytes <= 2_000);
  assert.ok(fitted.droppedDiscoveries > 0);
  assert.match(fitted.notes[0], /dropped the oldest discovery/);
  const survivors = fitted.save.discovery.entries;
  assert.deepEqual(survivors.map(entry => entry.discoveredAt), survivors.map(entry => entry.discoveredAt).slice().sort((a, b) => a - b),
    'what is kept is still oldest-first');
  assert.equal(survivors[survivors.length - 1].discoveredAt, GDO_SAVE_LIMITS.discoveries - 1,
    'the newest discovery survived: dropping is a tail trim, not a reset');

  // Then collectibles, and then it gives up rather than looping for ever.
  const progressOnly = createEmptySave({ writtenAt: 0 });
  progressOnly.progress.states.maharashtra = { collected: Array.from({ length: 64 }, (_, index) => `vada-pav:${index}`), score: 640 };
  const shrunk = fitSaveToLimits(progressOnly, { limits: { ...GDO_SAVE_LIMITS, bytes: 200 } });
  assert.ok(shrunk.droppedCollected > 0);
  assert.match(shrunk.notes.join('\n'), /dropped collected/);

  // The store applies the same ceiling, so a runtime cannot write an unbounded document.
  const store = new SaveStore({ storage: createMemoryStorage(), clock: () => 0, intervalMs: 0, limits: { ...GDO_SAVE_LIMITS, bytes: 2_000 } });
  store.update(document => { document.discovery.entries = save.discovery.entries; });
  assert.equal(store.flush(0), true);
  assert.ok(store.diagnostics().bytes <= 2_000);
  assert.ok(store.diagnostics().migrations.some(note => /dropped the oldest discovery/.test(note)),
    'the panel can say what was dropped');
});

test('a browser that refuses storage is a value, not an exception', () => {
  const hostile = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  const store = new SaveStore({ storage: hostile, clock: () => 0, intervalMs: 0 });
  const report = store.read();
  assert.equal(report.loaded, false);
  assert.match(report.problems.join(' | '), /storage read failed: denied/);
  assert.equal(store.counters.storageErrors, 1);
  assert.equal(store.write({ now: 0 }), false);
  assert.equal(store.counters.storageErrors, 2);
  assert.match(store.lastProblem, /storage write failed: denied/);
  assert.equal(store.clear(), false);
  assert.equal(store.diagnostics().available, true, 'the adapter exists, it just refuses');

  const none = new SaveStore({ storage: null, clock: () => 0, intervalMs: 0 });
  assert.equal(none.available, false);
  assert.match(none.read().problems.join(' | '), /storage is unavailable/);
  assert.equal(none.write({ now: 0 }), false);
  assert.match(none.diagnostics().storage, /unavailable/);
  assert.equal(none.tick(0), false, 'a runtime on a browser without storage still runs its frame loop');
  assert.equal(none.clear(), false);
});

test('the bytes are stable: two saves of one state encode identically', () => {
  const save = createEmptySave({ writtenAt: 1_700_000_000_000 });
  save.settings.showDebug = true;
  save.discovery.entries.push({
    id: discoveryPlaceId('Nangal Sagar', 'water', -300.125, 88), name: 'Nangal Sagar', kind: 'water',
    x: -300.125, z: 88, radius: 30, discoveredAt: 12,
  });
  save.progress.lastMode = 'coordinate';
  save.progress.lastCoordinate = { latitude: 28.98451, longitude: 77.70644 };
  save.progress.states.maharashtra = { collected: ['vada-pav:1', 'cutting-chai:2'], score: 25 };

  const first = encodeSave(save);
  // A float that drifted in the last bits is the same save: the canonical form rounds to three
  // decimals, which is finer than the id quantisation can see.
  const drifted = JSON.parse(JSON.stringify(save));
  drifted.discovery.entries[0].x = -300.12500000000003;
  drifted.progress.lastCoordinate.longitude = 77.70644000000001;
  assert.equal(encodeSave(drifted), first);

  // Key order in the input cannot change the bytes either: the canonical form writes the
  // declared order, which is what makes a diff of two saves mean something.
  const reordered = { progress: save.progress, discovery: save.discovery, writtenAt: save.writtenAt, settings: save.settings, worldVersion: GDO_GENERATOR_VERSION, schemaVersion: 1 };
  assert.equal(encodeSave(reordered), first);
  assert.equal(canonicalSave(save).writtenAt, save.writtenAt);

  // And the document is small enough to be read by a human when something goes wrong.
  assert.ok(saveByteLength(first) < 800, `${saveByteLength(first)} bytes for a session with one place`);
});
