/**
 * `CNT-01` — the loader path that content actually travels.
 *
 * `ContentSchema.test.js` proves the schema against the content files. This proves
 * the other half of the wiring: that the one loader in the project which reads
 * state packs (`StateManager.loadState`) *uses* the schema rather than going around
 * it, and that a rejected pack leaves the scene untouched instead of half-built.
 *
 * The loader is currently dormant — no entry point mounts `StateManager` — and that
 * is recorded rather than hidden (roadmap §10, `AGENTS.md`). The reason to test it
 * anyway is that the wiring is the part that rots: a future `CNT-02`/`CNT-04` mounts
 * this path, and by then nobody will remember whether validation was load-bearing or
 * decorative. A real `THREE.Scene` is used, not a stub, because the failure this
 * guards against is content reaching `buildVoxelMesh` unchecked; a stubbed scene
 * would not catch it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { StateManager } from '../engine/StateManager.js';
import { STATE_CONTENT_SCHEMA_VERSION } from '../engine/ContentSchema.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readPack(name) {
  return readFileSync(join(ROOT, 'public', 'content', 'states', `${name}.json`), 'utf8');
}

/** Serve the shipped packs from disk, and count what the loader asked for. */
function installFetch(overrides = {}) {
  const requested = [];
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const name = String(url).split('/').pop();
    requested.push(name);
    if (overrides[name]) return { ok: true, status: 200, text: async () => overrides[name] };
    if (name.endsWith('.json') && ['kerala.json', 'maharashtra.json'].includes(name)) {
      return { ok: true, status: 200, text: async () => readPack(name.replace(/\.json$/, '')) };
    }
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => '' };
  };
  return { requested, restore: () => { globalThis.fetch = original; } };
}

/** Minimal HUD: the loader only touches `stateLabel`, and skips the rest when absent. */
function makeHud() {
  return { stateLabel: { textContent: '' }, banner: null, hotbar: null };
}

test('a shipped pack loads through the schema and spawns its collectibles', async () => {
  const fetcher = installFetch();
  const scene = new THREE.Scene();
  const manager = new StateManager(scene, makeHud());
  try {
    const result = await manager.loadState('kerala');
    assert.equal(result.ok, true, `load must succeed: ${result.error?.message ?? ''}`);
    assert.equal(result.report.schemaVersion, STATE_CONTENT_SCHEMA_VERSION);
    assert.equal(result.report.namespace, `gdo:contentSchema:v${STATE_CONTENT_SCHEMA_VERSION}`);
    assert.deepEqual(fetcher.requested, ['kerala.json'], 'the loader must fetch the pack by the id it was given');
    assert.equal(manager.currentState.stateId, 'kerala');
    assert.equal(manager.currentState.collectibles.length, 2);
    // One mesh plus one glow ring per collectible, both parented to the scene.
    assert.equal(manager.activeItems.length, 2);
    assert.equal(scene.children.length, 4, 'two vignettes, each with a mesh and a ring');
    for (const item of manager.activeItems) {
      assert.ok(item.mesh?.isGroup, 'the vignette must be a built voxel group');
      assert.equal(item.collected, false);
      assert.equal(item.baseY, item.data.spawnPosition.y + 0.5);
      assert.ok(item.data.voxels.length > 0);
    }
    // The HUD label is the validator-approved display name, not a raw field.
    assert.equal(manager.hud.stateLabel.textContent, 'Kerala - God\'s Own Country');
  } finally { fetcher.restore(); }
});

test('legacy content is migrated by the loader, not rejected', async () => {
  // The realistic contributor case: a file written before the schema existed.
  const legacy = JSON.parse(readPack('maharashtra'));
  delete legacy.schemaVersion;
  const fetcher = installFetch({ 'maharashtra.json': JSON.stringify(legacy) });
  const scene = new THREE.Scene();
  const manager = new StateManager(scene, makeHud());
  try {
    const result = await manager.loadState('maharashtra');
    assert.equal(result.ok, true, `a legacy pack must migrate rather than fail: ${result.error?.message ?? ''}`);
    assert.equal(result.report.migratedFrom, 0);
    assert.equal(result.report.schemaVersion, STATE_CONTENT_SCHEMA_VERSION);
    assert.equal(manager.currentState.schemaVersion, STATE_CONTENT_SCHEMA_VERSION);
    assert.equal(manager.activeItems.length, 2);
  } finally { fetcher.restore(); }
});

test('invalid content is refused without touching the scene', async () => {
  const broken = JSON.parse(readPack('kerala'));
  broken.collectibles[0].buff.type = 'speeed';
  broken.collectibles[1].voxels.push([0, 0, 0]); // not a four-tuple
  const fetcher = installFetch({ 'kerala.json': JSON.stringify(broken) });
  const scene = new THREE.Scene();
  const manager = new StateManager(scene, makeHud());
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    const result = await manager.loadState('kerala');
    assert.equal(result.ok, false);
    assert.equal(result.error.name, 'StateContentError');
    // Every problem is reported, and the field is named so an author can act.
    assert.equal(result.error.problems.length, 2);
    assert.match(result.error.problems.join(' | '), /buff\.type must be one of speed, jump, shield, stamina, focus, got "speeed"/);
    assert.match(result.error.problems.join(' | '), /voxels\[16\] must be a \[x, y, z, colour\] tuple, got \[0,0,0\]/);
    // The scene is untouched and the previous state is not replaced by a partial one.
    assert.equal(scene.children.length, 0);
    assert.equal(manager.activeItems.length, 0);
    assert.equal(manager.currentState, null);
    assert.equal(errors.length, 1, 'the rejection must be reported once, in the log the operator reads');
  } finally { console.error = originalError; fetcher.restore(); }
});

test('a missing pack fails as a load error, not as a validation error', async () => {
  const fetcher = installFetch();
  const manager = new StateManager(new THREE.Scene(), makeHud());
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await manager.loadState('goa');
    assert.equal(result.ok, false);
    assert.match(result.error.message, /Failed to load state content from \/content\/states\/goa\.json: 404 Not Found/);
  } finally { console.error = originalError; fetcher.restore(); }
});
