import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from './GeoWorld.js';
import { compileGeoFixture } from './GeoFixtures.js';
import { collectGeoRuntimeBudgetMetrics } from './GeoDiagnostics.js';
import {
  GDO_DISCOVERY_NAMESPACE,
  GDO_DISCOVERY_PROFILES,
  createJournalStorage,
  placeIdFor,
} from '../engine/DiscoveryJournal.js';
import { GDO_LOW_PROFILE_BUDGETS, assertLowProfileBudget } from '../engine/PerformanceBudget.js';
import { featureNamespace } from '../engine/FeatureVersions.js';

globalThis.Worker ??= class { addEventListener() {} postMessage() {} terminate() {} };

/**
 * `GME-06` gate, world level: the live world feeds the journal from the same
 * mapped names the readout already shows. The pass is throttled, ids are
 * reproducible, a dwell turns a sighting into a visit, and the bounded state
 * survives a reload through the versioned local payload.
 */

function createWorld() {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, .1, 2_000);
  const world = new GeoWorld(new THREE.Scene(), {
    latitude: 28.9845, longitude: 77.7064, camera, viewportHeight: 720,
  });
  return { world, camera };
}

/** Drive the resident tile through the same phases the worker posts. */
function loadSemantics(world) {
  const tile = [...world.tiles.values()][0];
  const compiled = compileGeoFixture('provider-semantics', 'openmaptiles');
  const common = {
    type: 'tile-phase', requestId: tile.requestId, key: tile.key, bytes: 2048,
    provider: 'Fixture/openmaptiles', providerId: 'openmaptiles',
  };
  world._handleWorkerMessage({ ...common, phase: 'roads', geometry: compiled.roads, timings: {} });
  world._handleWorkerMessage({ ...common, phase: 'context', context: compiled.context, timings: {} });
  world._handleWorkerMessage({ ...common, phase: 'buildings', geometry: compiled.buildings, timings: {} });
  return tile;
}

/** A synchronous Web Storage stand-in: the only API the journal adapter needs. */
function memoryStore() {
  const entries = new Map();
  return {
    entries,
    getItem: key => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => { entries.set(key, String(value)); },
    removeItem: key => { entries.delete(key); },
  };
}

test('the world journals the mapped names it is already showing', () => {
  const { world, camera } = createWorld();
  try {
    assert.equal(world.discoverySummary, null, 'nothing is journalled before the first pass');
    assert.ok(world.discoveryJournal, 'the world owns a journal');
    assert.equal(world.discoveryJournal.namespace, GDO_DISCOVERY_NAMESPACE);
    assert.equal(GDO_DISCOVERY_NAMESPACE, featureNamespace('discoveryJournal'));
    assert.equal(world.discoveryJournal.profile, world.profile);
    assert.equal(world.discoveryJournal.limits.maxRecords, GDO_LOW_PROFILE_BUDGETS.discoveryRecords);
    loadSemantics(world);
    const names = world.visibleLabels.map(label => label.name).sort();
    assert.deepEqual(names, ['Semantics Bridge', 'Semantics Lane', 'Semantics Pond', 'Semantics Town', 'Semantics Tram']);

    world.update({ x: 0, y: 0, z: 0 }, camera, 720, 0);
    const summary = world.discoverySummary;
    assert.ok(summary, 'a frame produces a discovery summary');
    assert.equal(summary.records, 4);
    assert.equal(summary.visited, 0, 'a first sighting is not a visit');
    assert.deepEqual(summary.byKind, { place: 1, water: 1, street: 2 });
    // The far name on the tile is outside the low-profile sight distance.
    assert.equal(world.discoveryJournal.diagnostics().rejected, 1);
    assert.equal(summary.nearestUnvisited.name, 'Semantics Pond');
    assert.ok(summary.nearestUnvisited.distance > 50 && summary.nearestUnvisited.distance < 60);

    // The ids are the same ids a caller can compute from the mapped name.
    const town = world.visibleLabels.find(label => label.name === 'Semantics Town');
    assert.ok(world.discoveryJournal.get(placeIdFor(town)), 'the mapped name hashes to its own id');
    assert.match(world.discoveryJournal.get(placeIdFor(town)).id, /^place:semantics-town@\d+:\d+-[0-9a-f]{8}$/);

    // The pass is throttled to the label cadence: a frame 100 ms later reuses
    // the previous verdict instead of rebuilding the name list.
    const observations = world.discoveryJournal.diagnostics().observations;
    world.update({ x: 0, y: 0, z: 0 }, camera, 720, 100);
    assert.equal(world.discoveryJournal.diagnostics().observations, observations);
    assert.equal(world.observeDiscovery(0, 0, 100), world.discoverySummary);
    world.observeDiscovery(0, 0, 250);
    assert.equal(world.discoveryJournal.diagnostics().frames, 2, 'the next cadence slot observes again');

    // Budget surface: the journal reports through the same low-profile metrics.
    const metrics = collectGeoRuntimeBudgetMetrics(null, world);
    assert.equal(metrics.discoveryRecords, 4);
    assert.equal(metrics.discoveryVisited, 0);
    assert.equal(metrics.discoverySighted, 4);
    assert.equal(metrics.discoveryObservations, world.discoveryJournal.diagnostics().observations);
    assert.equal(metrics.discoveryRejected, world.discoveryJournal.diagnostics().rejected);
    assert.equal(metrics.discoveryRejected, 2, 'each pass refuses the name beyond the sight distance');
    assert.equal(metrics.discoverySteadyFrameAllocations, 0);
    assert.equal(assertLowProfileBudget({
      discoveryRecords: metrics.discoveryRecords,
      discoverySteadyFrameAllocations: metrics.discoverySteadyFrameAllocations,
    }).ok, true);
  } finally {
    world.dispose();
  }
});

test('a dwell inside the visit radius turns a sighting into a visit', () => {
  const { world, camera } = createWorld();
  try {
    loadSemantics(world);
    const pond = world.visibleLabels.find(label => label.name === 'Semantics Pond');
    const pondId = placeIdFor(pond);
    world.update({ x: 0, y: 0, z: 0 }, camera, 720, 0);
    assert.equal(world.discoveryJournal.get(pondId).state, 'sighted');
    // Stand on the pond: the journal keeps the name merely sighted until the
    // dwell time has passed.
    world.update({ x: pond.x, y: 0, z: pond.z }, camera, 720, 1_000);
    assert.equal(world.discoveryJournal.get(pondId).state, 'sighted', 'one pass is not a visit');
    world.update({ x: pond.x, y: 0, z: pond.z }, camera, 720, 1_000 + GDO_DISCOVERY_PROFILES.low.visitDwellMilliseconds);
    const record = world.discoveryJournal.get(pondId);
    assert.equal(record.state, 'visited');
    assert.equal(record.visits, 1);
    assert.equal(world.discoverySummary.visited, 1);
    assert.equal(world.discoverySummary.nearestUnvisited.name, 'Semantics Town', 'the pond is no longer unvisited');
    assert.equal(collectGeoRuntimeBudgetMetrics(null, world).discoveryVisited, 1);
    // Leaving resets the dwell clock, so a later brief stop is not a visit.
    world.update({ x: 0, y: 0, z: 0 }, camera, 720, 40_000);
    assert.equal(world.discoveryJournal.get(pondId).insideSinceMilliseconds ?? null, null);
  } finally {
    world.dispose();
  }
});

test('the same walk keeps the same journal, whatever the world instance', () => {
  const first = createWorld(), second = createWorld();
  try {
    loadSemantics(first.world); loadSemantics(second.world);
    // The walk crosses the pond and stops on the mapped town long enough for a
    // visit, so the journal holds both states.
    const walk = [
      { x: 0, z: 0, t: 0 },
      { x: 24, z: 49, t: 5_000 },
      { x: 24, z: 49, t: 6_800 },
      { x: 34, z: 83, t: 9_000 },
      { x: 34, z: 83, t: 10_800 },
    ];
    for (const step of walk) first.world.update({ x: step.x, y: 0, z: step.z }, first.camera, 720, step.t);
    for (const step of walk) second.world.update({ x: step.x, y: 0, z: step.z }, second.camera, 720, step.t);
    assert.deepEqual(second.world.discoveryJournal.records().map(record => record.id),
      first.world.discoveryJournal.records().map(record => record.id));
    assert.deepEqual(second.world.discoveryJournal.toJSON(), first.world.discoveryJournal.toJSON());
    assert.equal(first.world.discoveryJournal.toJSON().schemaVersion, 1);
    const progress = first.world.discoveryJournal.progress();
    assert.deepEqual(Object.keys(progress.byKind).sort(), ['place', 'street', 'water']);
    assert.equal(progress.visited, 2, 'the pond and the town both had a dwell');
    assert.equal(progress.sighted, 3, 'the names walked past stay sightings');
    assert.equal(progress.records, 5, 'the walk brought the far lane into sight as well');
  } finally {
    first.world.dispose(); second.world.dispose();
  }
});

test('the versioned local payload lets the journal survive a reload', () => {
  const store = memoryStore();
  const previous = globalThis.localStorage;
  globalThis.localStorage = store;
  const opened = createWorld();
  let reloaded = null;
  try {
    loadSemantics(opened.world);
    const pond = opened.world.visibleLabels.find(label => label.name === 'Semantics Pond');
    opened.world.update({ x: pond.x, y: 0, z: pond.z }, opened.camera, 720, 0);
    opened.world.update({ x: pond.x, y: 0, z: pond.z }, opened.camera, 720,
      GDO_DISCOVERY_PROFILES.low.visitDwellMilliseconds);
    const storage = opened.world.discoveryStorage;
    assert.ok(storage, 'the world found the browser store');
    assert.equal(storage.diagnostics().writes, 1, 'a visit is worth one write');
    const key = storage.key;
    assert.ok(key.startsWith(GDO_DISCOVERY_NAMESPACE), 'the key is namespaced');
    const payload = JSON.parse(store.getItem(key));
    assert.equal(payload.namespace, GDO_DISCOVERY_NAMESPACE);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.records.filter(record => record.state === 'visited').length, 1);

    // A fresh mount reads the same store before the first frame is drawn.
    reloaded = createWorld();
    const journal = reloaded.world.discoveryJournal;
    assert.equal(journal.size, payload.records.length);
    assert.equal(journal.get(placeIdFor(pond)).state, 'visited');
    assert.equal(reloaded.world.discoveryStorage.diagnostics().restores, payload.records.length);
    assert.equal(reloaded.world.loadDiscovery(), payload.records.length);

    // A payload this build refuses leaves the journal empty instead of guessing.
    store.setItem(key, JSON.stringify({ namespace: 'somebody:else:v9', records: [{ id: 'x', x: 0, z: 0 }] }));
    const refused = createWorld();
    try {
      assert.equal(refused.world.discoveryJournal.size, 0);
      assert.equal(refused.world.discoveryStorage.diagnostics().rejected, 1);
      assert.match(refused.world.discoveryStorage.diagnostics().lastReason, /namespace/);
      assert.equal(refused.world.loadDiscovery(), 0);
    } finally { refused.world.dispose(); }

    // Unreadable JSON is counted as a failure, not thrown at the caller.
    store.setItem(key, '{not json');
    const broken = createWorld();
    try {
      assert.equal(broken.world.discoveryStorage.diagnostics().failures, 1);
      assert.equal(broken.world.discoveryStorage.diagnostics().lastReason, 'malformed-json');
    } finally { broken.world.dispose(); }

    // A store that refuses writes (full quota, private mode) reports it.
    const quota = memoryStore();
    quota.setItem = () => { throw new Error('QuotaExceededError'); };
    const adapter = createJournalStorage(quota);
    assert.equal(adapter.save(journal), false);
    assert.equal(adapter.diagnostics().failures, 1);
    assert.equal(adapter.diagnostics().lastReason, 'storage-full');
    assert.throws(() => createJournalStorage(null), /getItem\/setItem store/);
  } finally {
    reloaded?.world.dispose();
    opened.world.dispose();
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});
