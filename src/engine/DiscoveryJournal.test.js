import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_DISCOVERY_KINDS,
  GDO_DISCOVERY_NAMESPACE,
  GDO_DISCOVERY_PROFILES,
  GDO_DISCOVERY_STATE,
  createDiscoveryJournal,
  discoveryBudgetForProfile,
  placeIdFor,
} from './DiscoveryJournal.js';
import { featureNamespace } from './FeatureVersions.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

/**
 * `GME-06` gate: place ids are deterministic, the sighted → visited transition
 * needs dwell inside the visit radius, the journal stays inside its profile cap
 * with a deterministic eviction order, and a payload round-trips.
 */

const TOWN = { name: 'Semantics Town', kind: 'place', x: 140, z: 340 };

test('the journal is declared, versioned, and bounded per profile', () => {
  assert.equal(GDO_DISCOVERY_NAMESPACE, featureNamespace('discoveryJournal'));
  assert.equal(GDO_DISCOVERY_NAMESPACE, 'gdo:discoveryJournal:v1');
  assert.deepEqual(Object.keys(GDO_DISCOVERY_PROFILES), ['low', 'balanced', 'high']);
  assert.equal(discoveryBudgetForProfile('low').maxRecords, 48);
  assert.throws(() => discoveryBudgetForProfile('enormous'), /Unknown discovery profile/);
  assert.ok(GDO_DISCOVERY_PROFILES.low.maxRecords < GDO_DISCOVERY_PROFILES.high.maxRecords);
  // The low-profile record cap is the project budget, not a private number.
  assert.equal(GDO_DISCOVERY_PROFILES.low.maxRecords, GDO_LOW_PROFILE_BUDGETS.discoveryRecords);
  assert.deepEqual(GDO_DISCOVERY_STATE, { SIGHTED: 'sighted', VISITED: 'visited' });
  assert.ok(GDO_DISCOVERY_KINDS.includes('water'));
  const journal = createDiscoveryJournal({ profile: 'low' });
  assert.equal(journal.namespace, GDO_DISCOVERY_NAMESPACE);
  assert.equal(journal.size, 0);
  assert.equal(journal.limits.maxRecords, 48);
  assert.throws(() => createDiscoveryJournal({ profile: 'huge' }), /Unknown discovery profile/);
});

test('place ids are deterministic, order-independent, and coordinate-stable', () => {
  const first = placeIdFor(TOWN);
  assert.equal(placeIdFor(TOWN), first, 'the same place always hashes the same');
  assert.equal(placeIdFor({ ...TOWN, name: 'Semantics Town' }), first);
  assert.match(first, /^place:semantics-town@35:85-[0-9a-f]{8}$/);
  // A step inside the merge radius does not invent a second place.
  assert.equal(placeIdFor({ ...TOWN, x: 141.5, z: 341 }), first);
  // A different place, name, or kind does.
  assert.notEqual(placeIdFor({ ...TOWN, x: 400, z: 900 }), first);
  assert.notEqual(placeIdFor({ ...TOWN, name: 'Other Town' }), first);
  assert.notEqual(placeIdFor({ ...TOWN, kind: 'water' }), first);
  // An unknown kind is normalized instead of producing a new namespace.
  assert.equal(placeIdFor({ ...TOWN, kind: 'spaceport' }),
    placeIdFor({ ...TOWN, kind: 'other' }));
  assert.throws(() => placeIdFor({ name: 'x', kind: 'place', x: Number.NaN, z: 0 }), /finite coordinates/);
  assert.throws(() => placeIdFor(TOWN, { mergeRadius: 0 }), /mergeRadius/);
});

test('a place is sighted when seen and visited only after dwell inside the radius', () => {
  const journal = createDiscoveryJournal({ profile: 'low' });
  const id = placeIdFor(TOWN);
  journal.observe({ ...TOWN, distance: 90 }, 0);
  assert.equal(journal.get(id).state, GDO_DISCOVERY_STATE.SIGHTED);
  // Still far: the dwell clock runs, but the radius gate is not satisfied.
  journal.observe({ ...TOWN, distance: 60 }, 5_000);
  assert.equal(journal.get(id).state, GDO_DISCOVERY_STATE.SIGHTED, 'far observations never visit');
  // Inside the radius, but not yet for the dwell time.
  journal.observe({ ...TOWN, distance: 8 }, 6_000);
  assert.equal(journal.get(id).state, GDO_DISCOVERY_STATE.SIGHTED, 'a short stop is not a visit');
  // Inside the radius, dwell satisfied.
  journal.observe({ ...TOWN, distance: 8 }, 6_000 + GDO_DISCOVERY_PROFILES.low.visitDwellMilliseconds);
  const record = journal.get(id);
  assert.equal(record.state, GDO_DISCOVERY_STATE.VISITED);
  assert.equal(record.visits, 1);
  assert.equal(record.firstSeenMilliseconds, 0);
  // Visiting again keeps the visited state and counts the revisits.
  journal.observe({ ...TOWN, distance: 4 }, 60_000);
  assert.equal(journal.get(id).state, GDO_DISCOVERY_STATE.VISITED);
  assert.equal(journal.diagnostics().revisits, 1);
  const progress = journal.progress();
  assert.equal(progress.visited, 1);
  assert.equal(progress.sighted, 0);
  assert.equal(progress.records, 1);
  assert.equal(progress.byKind.place, 1);
  assert.equal(progress.nearestUnvisited, null);
  assert.equal(progress.namespace, GDO_DISCOVERY_NAMESPACE);
});

test('observeAll keeps the journal to what the player actually approached', () => {
  const journal = createDiscoveryJournal({ profile: 'low' });
  const places = [
    { name: 'Near', kind: 'poi', x: 10, z: 10 },
    { name: 'Mid', kind: 'poi', x: 60, z: 0 },
    { name: 'Far Beyond', kind: 'poi', x: 900, z: 0 },
  ];
  const observed = journal.observeAll(places, { x: 0, z: 0, clock: 0 });
  assert.deepEqual(observed.map(record => record.name), ['Near', 'Mid']);
  assert.equal(journal.size, 2);
  assert.equal(journal.diagnostics().rejected, 1, 'the name beyond the sight distance was refused');
  const progress = journal.progress();
  assert.equal(progress.sighted, 2);
  assert.equal(progress.nearestUnvisited.name, 'Near');
  assert.ok(progress.nearestUnvisited.distance < 20);
  assert.ok(Object.isFrozen(progress.nearestUnvisited));
  assert.throws(() => journal.observeAll(null), /array of places/);
  assert.throws(() => journal.observe({ name: 'bad', x: 'x', z: 0 }), /finite coordinates/);
});

test('the journal stays inside its cap with a deterministic eviction order', () => {
  const journal = createDiscoveryJournal({ profile: 'low' });
  const cap = GDO_DISCOVERY_PROFILES.low.maxRecords;
  const dwell = GDO_DISCOVERY_PROFILES.low.visitDwellMilliseconds;
  const observations = [];
  for (let index = 0; index < cap * 3; index++) {
    const place = { name: `Place ${index}`, kind: 'poi', x: index * 40, z: 0, distance: 5 };
    observations.push({ place, clock: index * 1_000, visit: index % 5 === 0 });
  }
  const feed = (target, list) => {
    for (const entry of list) {
      target.observe(entry.place, entry.clock);
      if (entry.visit) target.observe(entry.place, entry.clock + dwell);
    }
  };
  feed(journal, observations);
  assert.equal(journal.size, cap, 'the cap is a ceiling, not a suggestion');
  // A visit outranks a sighting: as long as any sighting is a candidate, no
  // visited record is ever evicted.
  const visitedIds = observations.filter(entry => entry.visit)
    .map(entry => placeIdFor(entry.place));
  const keptIds = new Set(journal.records().map(record => record.id));
  for (const id of visitedIds) assert.ok(keptIds.has(id), 'every visited place is still remembered');
  assert.equal(visitedIds.length, 29);
  const keptVisited = journal.records().filter(record => record.state === GDO_DISCOVERY_STATE.VISITED);
  assert.equal(keptVisited.length, visitedIds.length);
  assert.equal(journal.records().length, cap);
  assert.ok(journal.diagnostics().evictions > 0);

  // Among sighted records the oldest observation leaves first.
  const simple = createDiscoveryJournal({ profile: 'low' });
  for (let index = 0; index < cap; index++) {
    simple.observe({ name: `Old ${index}`, kind: 'poi', x: index, z: 0, distance: 5 }, index * 100);
  }
  assert.equal(simple.size, cap);
  const oldestId = placeIdFor({ name: 'Old 0', kind: 'poi', x: 0, z: 0 });
  assert.ok(simple.get(oldestId));
  simple.observe({ name: 'Newest', kind: 'poi', x: 9_999, z: 0, distance: 5 }, 10_000);
  assert.equal(simple.size, cap);
  assert.equal(simple.get(oldestId), null, 'the oldest sighting left first');
  assert.ok(simple.get(placeIdFor({ name: 'Newest', kind: 'poi', x: 9_999, z: 0 })));

  // The cap is absolute: a journal full of visits still has to shed a record
  // rather than grow, and it sheds the oldest one deterministically.
  const full = createDiscoveryJournal({ profile: 'low' });
  for (let index = 0; index < cap; index++) {
    const place = { name: `Visited ${index}`, kind: 'place', x: index * 10, z: 0, distance: 5 };
    full.observe(place, 0);
    full.observe(place, dwell);
  }
  assert.equal(full.progress().visited, cap);
  full.observe({ name: 'Late', kind: 'place', x: 5_000, z: 0, distance: 5 }, 60_000);
  assert.equal(full.size, cap);
  assert.equal(full.get(placeIdFor({ name: 'Visited 0', kind: 'place', x: 0, z: 0 })), null);
  assert.ok(full.get(placeIdFor({ name: 'Late', kind: 'place', x: 5_000, z: 0 })));

  // Deterministic: replaying the same observations keeps the same journal,
  // byte for byte, including which records survived the cap.
  const replay = createDiscoveryJournal({ profile: 'low' });
  feed(replay, observations);
  assert.deepEqual(replay.records().map(record => record.id), journal.records().map(record => record.id));
  assert.deepEqual(replay.toJSON(), journal.toJSON());
  assert.equal(journal.diagnostics().steadyFrameAllocations, 0);
  assert.equal(journal.diagnostics().cap, cap);
  // A `records()` view reuses the caller's array, so the HUD can read it per frame.
  const out = [];
  assert.equal(journal.records(out), out);
});

test('the payload round-trips, refuses a future schema, and merges by id', () => {
  const journal = createDiscoveryJournal({ profile: 'low' });
  journal.observe({ ...TOWN, distance: 4 }, 0);
  journal.observe({ ...TOWN, distance: 4 }, 2_000);
  const far = { name: 'Far Port', kind: 'place', x: 900, z: 900 };
  journal.observe({ ...far, distance: 80 }, 2_100);
  const payload = journal.toJSON();
  assert.equal(payload.namespace, GDO_DISCOVERY_NAMESPACE);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.records.length, 2);
  assert.equal(payload.records[0].state, GDO_DISCOVERY_STATE.VISITED, 'visited records sort first');

  const restored = createDiscoveryJournal({ profile: 'low' });
  assert.equal(restored.restore(payload, 10_000), 2);
  assert.equal(restored.get(placeIdFor(TOWN)).state, GDO_DISCOVERY_STATE.VISITED);
  assert.equal(restored.get(placeIdFor(TOWN)).visits, 1);
  assert.equal(restored.get(placeIdFor(far)).state, GDO_DISCOVERY_STATE.SIGHTED);
  assert.deepEqual(restored.toJSON().records.map(record => record.id),
    payload.records.map(record => record.id));
  // Restoring into a journal that already has the place keeps the stronger state.
  const merged = createDiscoveryJournal({ profile: 'low' });
  merged.observe({ ...TOWN, distance: 4 }, 0);
  assert.equal(merged.get(placeIdFor(TOWN)).state, GDO_DISCOVERY_STATE.SIGHTED);
  merged.restore(payload, 10_000);
  assert.equal(merged.get(placeIdFor(TOWN)).state, GDO_DISCOVERY_STATE.VISITED);
  // Bad payloads are refused instead of silently producing an empty journal.
  assert.throws(() => restored.restore({ namespace: 'other', records: [] }), /another namespace/);
  assert.throws(() => restored.restore({ ...payload, schemaVersion: 7 }), /newer than this build/);
  assert.equal(restored.restore({ namespace: GDO_DISCOVERY_NAMESPACE, records: [null, {}] }), 0,
    'malformed entries are skipped');
  assert.equal(restored.reset(), true);
  assert.equal(restored.size, 0);
});
