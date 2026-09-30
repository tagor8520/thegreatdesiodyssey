import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  GDO_CONTENT_BUFF_TYPES,
  GDO_CONTENT_LIMITS,
  GDO_CONTENT_SCHEMA_NAMESPACE,
  GDO_CONTENT_SCHEMA_VERSION,
  contentSchemaAvailable,
  loadContentState,
  migrateContentState,
  validateContentState,
} from './ContentSchema.js';
import { StateManager } from './StateManager.js';
import { GDO_FEATURE_VERSIONS, featureNamespace } from './FeatureVersions.js';

// The pick-up animation is a DOM concern; the manager only needs it to exist.
globalThis.requestAnimationFrame ??= () => 0;

/**
 * `CNT-01` gate: the shipped state packs validate against a declared versioned
 * schema, every malformed shape is refused with a named reason, and a legacy v0
 * pack migrates forward deterministically before it is read.
 */

const readPack = name => JSON.parse(
  readFileSync(new URL(`../../public/content/states/${name}.json`, import.meta.url), 'utf8'));

function minimalPack(overrides = {}) {
  return {
    schemaVersion: GDO_CONTENT_SCHEMA_VERSION,
    stateId: 'teststate',
    stateName: 'Test State',
    bgColor: '#112233',
    collectibles: [{
      id: 'test_item',
      name: 'Test Item',
      description: 'A test pick-up',
      icon: '🍌',
      buff: { type: 'speed', multiplier: 1.5, duration: 12_000 },
      spawnPosition: { x: 1, y: 1, z: -1 },
      voxels: [[0, 0, 0, '#D4A017'], [1, 0, 0, '#C8941A']],
    }],
    ...overrides,
  };
}

test('the schema is declared, versioned, and available', () => {
  assert.equal(GDO_CONTENT_SCHEMA_VERSION, 1);
  assert.equal(GDO_CONTENT_SCHEMA_NAMESPACE, 'gdo:contentSchema:v1');
  assert.equal(featureNamespace('contentSchema'), GDO_CONTENT_SCHEMA_NAMESPACE);
  assert.equal(GDO_FEATURE_VERSIONS.contentSchema, 1);
  assert.equal(contentSchemaAvailable(), true);
  assert.deepEqual(GDO_CONTENT_BUFF_TYPES, ['speed', 'jump', 'shield', 'stamina', 'focus']);
  assert.equal(GDO_CONTENT_LIMITS.maxCollectibles, 16);
  assert.ok(GDO_CONTENT_LIMITS.maxVoxelsPerCollectible >= 64);
});

test('the shipped state packs load, and legacy v0 packs migrate forward', () => {
  for (const name of ['kerala', 'maharashtra']) {
    const pack = readPack(name);
    assert.equal(pack.schemaVersion, 1, `${name} carries the schema marker`);
    const report = loadContentState(pack);
    assert.deepEqual(report.errors, [], `${name} validates`);
    assert.equal(report.ok, true);
    assert.equal(report.version, 1);
    assert.equal(report.migration.migrated, false, `${name} is already current`);
    assert.equal(report.data.stateId, name);
    assert.ok(report.data.collectibles.length > 0);
  }

  // The legacy shape: no schemaVersion at all. The migration stamps it, detaches
  // the buff objects it owns, and the migrated pack then validates.
  const legacy = { ...minimalPack() };
  delete legacy.schemaVersion;
  const migration = migrateContentState(legacy);
  assert.equal(migration.migrated, true);
  assert.equal(migration.from, 0);
  assert.equal(migration.to, 1);
  assert.deepEqual(migration.steps, ['v0->v1:stamp-schema-version', 'v0->v1:detach-buff-objects']);
  assert.equal(migration.data.schemaVersion, 1);
  assert.equal(legacy.schemaVersion, undefined, 'migration never mutates its input');
  const report = loadContentState(legacy);
  assert.equal(report.ok, true);
  assert.deepEqual(report.migration.steps, migration.steps);
  // Idempotent: re-migrating a migrated pack changes nothing.
  const again = migrateContentState(report.data);
  assert.equal(again.migrated, false);
  assert.deepEqual(again.steps, []);
  assert.equal(again.data.schemaVersion, 1);
  // A pack from the future is refused rather than guessed at.
  assert.throws(() => migrateContentState(minimalPack({ schemaVersion: 9 })),
    /Cannot migrate a v9 pack down to v1/);
  assert.throws(() => migrateContentState(minimalPack({ schemaVersion: -1 })), /positive integer/);
  assert.throws(() => migrateContentState(null), /must be a JSON object/);
});

test('every malformed shape is refused with a named, stable reason', () => {
  const codes = pack => validateContentState(pack).errors.map(error => `${error.path}:${error.code}`);

  assert.deepEqual(codes(minimalPack()), []);
  assert.deepEqual(validateContentState({}).errors.map(error => `${error.path}:${error.code}`),
    ['stateId:missing-field', 'stateName:missing-field', 'collectibles:missing-field']);
  assert.deepEqual(codes(minimalPack({ stateId: 'Kerala State' })), ['stateId:invalid-id']);
  assert.deepEqual(codes(minimalPack({ stateName: '' })), ['stateName:out-of-range']);
  assert.deepEqual(codes(minimalPack({ bgColor: 'green' })), ['bgColor:invalid-color']);
  assert.deepEqual(codes(minimalPack({ collectibles: [] })), ['collectibles:empty-list']);
  assert.deepEqual(codes(minimalPack({
    collectibles: Array.from({ length: GDO_CONTENT_LIMITS.maxCollectibles + 1 }, (_, index) =>
      ({ ...minimalPack().collectibles[0], id: `item_${index}` })),
  })), [`collectibles:out-of-range`]);
  assert.deepEqual(codes(minimalPack({
    collectibles: [minimalPack().collectibles[0], minimalPack().collectibles[0]],
  })), ['collectibles[1].id:duplicate-id']);
  assert.deepEqual(codes(minimalPack({
    collectibles: [{
      ...minimalPack().collectibles[0],
      buff: { type: 'flight', multiplier: 1.5, duration: 12_000 },
    }],
  })), ['collectibles[0].buff.type:unknown-buff']);
  assert.deepEqual(codes(minimalPack({
    collectibles: [{ ...minimalPack().collectibles[0], buff: { type: 'speed', multiplier: 99, duration: 10 } }],
  })), ['collectibles[0].buff.multiplier:out-of-range', 'collectibles[0].buff.duration:out-of-range']);
  assert.deepEqual(codes(minimalPack({
    collectibles: [{ ...minimalPack().collectibles[0], spawnPosition: { x: 1, y: -3 } }],
  })), ['collectibles[0].spawnPosition.y:out-of-range', 'collectibles[0].spawnPosition.z:missing-field']);
  assert.deepEqual(codes(minimalPack({
    collectibles: [{ ...minimalPack().collectibles[0], voxels: [[0, 0, 0], [0, 0, 99, '#ffffff'], [1, 1, 1, 'red']] }],
  })), ['collectibles[0].voxels[0]:malformed-voxel', 'collectibles[0].voxels[1][2]:out-of-range',
    'collectibles[0].voxels[2][3]:invalid-color']);
  assert.deepEqual(codes(minimalPack({ schemaVersion: 4 })), ['schemaVersion:unsupported-version']);

  // A newer pack may carry fields this build does not know: preserved, warned,
  // never fatal.
  const future = validateContentState(minimalPack({ weather: { rain: 1 } }));
  assert.equal(future.ok, true);
  assert.deepEqual(future.warnings.map(warning => `${warning.path}:${warning.code}`), ['weather:unknown-field']);
  assert.deepEqual(validateContentState(null).errors.map(error => error.code), ['wrong-type']);
  assert.equal(validateContentState(minimalPack()).namespace, GDO_CONTENT_SCHEMA_NAMESPACE);
  // Deterministic: the same pack reports the same problems in the same order.
  const first = codes(minimalPack({ stateId: '!' }));
  const second = codes(minimalPack({ stateId: '!' }));
  assert.deepEqual(first, ['stateId:invalid-id']);
  assert.deepEqual(second, first);
});

test('the manager refuses a bad pack and spawns a good one', async () => {
  const scene = new THREE.Scene();
  const banner = { textContent: '', classList: { add() {}, remove() {} } };
  const hud = { stateLabel: { textContent: '' }, hotbar: null, banner };
  const manager = new StateManager(scene, hud);
  const buffs = [];
  const player = { applyBuff: buff => buffs.push(buff) };

  // The good path: the real shipped pack, spawned and reported.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => readPack('kerala') });
  try {
    await manager.loadState('kerala');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(manager.currentState.stateId, 'kerala');
  assert.equal(hud.stateLabel.textContent, "Kerala - God's Own Country");
  assert.equal(manager.activeItems.length, 2);
  assert.equal(manager.stateDiagnostics().loaded, true);
  assert.equal(manager.stateDiagnostics().schemaVersion, 1);
  assert.deepEqual(manager.stateDiagnostics().errors, []);

  // Spend one pick-up through the real update loop to prove the loaded data is
  // usable, not merely stored.
  const item = manager.activeItems[0];
  manager.update(new THREE.Vector3(item.mesh.position.x, 1, item.mesh.position.z), player, 0);
  assert.equal(item.collected, true);
  assert.equal(buffs.length, 1);
  assert.ok(['speed', 'jump', 'shield', 'stamina', 'focus'].includes(buffs[0].type));

  // The bad path: a legacy pack with a duplicate id spawns nothing and keeps the
  // named reasons, so the failure is visible instead of half-built.
  const broken = { ...readPack('maharashtra') };
  broken.collectibles = [broken.collectibles[0], { ...broken.collectibles[0] }];
  const itemsBefore = manager.activeItems.length;
  globalThis.fetch = async () => ({ ok: true, json: async () => broken });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await manager.loadState('maharashtra');
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
  assert.equal(manager.activeItems.length, itemsBefore, 'a refused pack spawns nothing');
  const report = manager.stateDiagnostics();
  assert.equal(report.rejections, 1);
  assert.deepEqual(report.errors.map(error => error.code), ['duplicate-id']);
  assert.equal(report.stateId, 'kerala', 'the last good pack stays loaded');
  assert.equal(errors.length, 1);
});
