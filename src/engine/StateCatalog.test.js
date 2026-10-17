import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as THREE from 'three';
import {
  GDO_STATE_CATALOG_NAMESPACE,
  GDO_STATE_PACK_IDS,
  describeStateCatalog,
  statePackRuntimePath,
  statePackSourcePath,
  verifyStatePackFiles,
} from './StateCatalog.js';
import { StateManager } from './StateManager.js';
import { compileStatePack } from './RecipeCompiler.js';
import { loadContentState } from './ContentSchema.js';
import { runContentCheck } from './ContentValidatorTool.js';
import { featureNamespace } from './FeatureVersions.js';
import { GDO_CONTENT_VALIDATOR_LIMITS } from './ContentValidator.js';

/**
 * `CNT-04` gate: every shipped state pack is added **only through the validated
 * pipeline**. The catalogue and the content folder must agree, every listed pack
 * must pass `CNT-03`'s checks and spawn through `CNT-02`'s compiler, and a pack
 * that fails the schema must spawn nothing — so dropping an unvalidated JSON
 * file into the folder cannot add content.
 */

globalThis.requestAnimationFrame ??= () => 0;

const PACKS_DIR = new URL('../../public/content/states/', import.meta.url);
const readPack = name => JSON.parse(readFileSync(new URL(`${name}.json`, PACKS_DIR), 'utf8'));
const shippedIds = () => readdirSync(PACKS_DIR)
  .filter(name => name.endsWith('.json'))
  .map(name => name.replace(/\.json$/, ''))
  .sort();
const PROVIDERS = JSON.parse(
  readFileSync(new URL('../../public/map-providers.json', import.meta.url), 'utf8')).providers;

/** The probe needs the ground plane and a few wind gust paths at the very least. */
const PLANE_EXTENT = 64;

test('the catalogue and the shipped content folder agree in both directions', () => {
  const verdict = verifyStatePackFiles(shippedIds());
  assert.equal(verdict.ok, true,
    `unlisted: ${verdict.unlisted.join(', ')}; missing: ${verdict.missing.join(', ')}`);
  assert.deepEqual([...verdict.listed], [...GDO_STATE_PACK_IDS].sort());
  assert.equal(GDO_STATE_CATALOG_NAMESPACE, featureNamespace('stateCatalog'));
  const catalog = describeStateCatalog();
  assert.equal(catalog.count, GDO_STATE_PACK_IDS.length);
  assert.deepEqual([...catalog.ids], [...GDO_STATE_PACK_IDS]);
  assert.deepEqual([...catalog.runtimePaths],
    GDO_STATE_PACK_IDS.map(id => `/content/states/${id}.json`));
  // The two path helpers point at the same file, one for Node and one for the page.
  for (const id of GDO_STATE_PACK_IDS) {
    assert.equal(statePackSourcePath(id), `public/content/states/${id}.json`);
    assert.equal(statePackRuntimePath(id), `/content/states/${id}.json`);
  }
  assert.throws(() => statePackSourcePath('not_a_state'), /register it in GDO_STATE_PACK_IDS/);
  assert.throws(() => statePackRuntimePath('not_a_state'), /register it in GDO_STATE_PACK_IDS/);
  // A drift in either direction is reported by name, never silently accepted.
  const drift = verifyStatePackFiles([...GDO_STATE_PACK_IDS, 'goa']);
  assert.equal(drift.ok, false);
  assert.deepEqual([...drift.unlisted], ['goa']);
  const gap = verifyStatePackFiles(GDO_STATE_PACK_IDS.slice(1));
  assert.equal(gap.ok, false);
  assert.deepEqual([...gap.missing], [GDO_STATE_PACK_IDS[0]]);
});

test('every shipped pack passes every applicable check and stays inside budget', () => {
  const fingerprints = new Map();
  for (const id of GDO_STATE_PACK_IDS) {
    const pack = readPack(id);
    assert.equal(pack.stateId, id, `${id}.json declares its own id`);
    assert.equal(pack.schemaVersion, 1, `${id}.json is written at the current schema version`);
    const report = runContentCheck(pack, { providers: PROVIDERS, preview: false });
    assert.equal(report.ok, true, `${id}: ${report.text}`);
    assert.equal(report.kind, 'state-pack');
    // The checks that must apply to a shipped pack all ran and passed; the two
    // that only apply to mapped sources or landmarks are skipped *with a reason*.
    assert.deepEqual([...report.summary.failed], []);
    assert.deepEqual([...report.summary.skipped], ['attribution', 'openings']);
    assert.equal(report.report.checks.every(check => check.detail.length > 0), true);
    const budget = report.report.checks.find(check => check.id === 'budget');
    assert.ok(budget.measured.modules <= GDO_CONTENT_VALIDATOR_LIMITS.maxPreviewWidth * 128);
    assert.equal(budget.measured.largestRecipe <= 512, true);
    // Each pack compiles to its own fingerprint: no pack is a copy of another.
    assert.equal(fingerprints.has(report.fingerprint), false,
      `${id} reuses the fingerprint of ${fingerprints.get(report.fingerprint)}`);
    fingerprints.set(report.fingerprint, id);
    // Determinism is real, not merely asserted by the tool: compile it again here.
    assert.equal(compileStatePack(pack, { profile: 'low' }).fingerprint, report.fingerprint);
    // The schema is the pipeline's first gate, and it agrees with the tool.
    assert.equal(loadContentState(pack).ok, true);
  }
  assert.equal(fingerprints.size, GDO_STATE_PACK_IDS.length);
});

test('every shipped pack spawns through the manager, at its declared spawns', async () => {
  const scene = new THREE.Scene();
  const hud = { stateLabel: { textContent: '' }, hotbar: null, banner: null };
  const manager = new StateManager(scene, hud);
  const originalFetch = globalThis.fetch;
  try {
    for (const id of GDO_STATE_PACK_IDS) {
      const pack = readPack(id);
      scene.clear();
      manager.activeItems.length = 0;
      const requested = [];
      globalThis.fetch = async url => {
        requested.push(url);
        return { ok: true, json: async () => pack };
      };
      await manager.loadState(id);
      assert.deepEqual(requested, [statePackRuntimePath(id)],
        'the manager fetches the path the catalogue declares');
      const diagnostics = manager.stateDiagnostics();
      assert.equal(diagnostics.stateId, id);
      assert.equal(diagnostics.loaded, true);
      assert.equal(diagnostics.errors.length, 0, `${id} loaded without errors`);
      assert.equal(diagnostics.recipePrunedModules, 0, `${id} ships nothing over cap`);
      assert.equal(manager.activeItems.length, pack.collectibles.length);
      assert.equal(diagnostics.recipeModules,
        pack.collectibles.reduce((total, item) => total + item.voxels.length, 0));
      for (let index = 0; index < manager.activeItems.length; index++) {
        const spawned = manager.activeItems[index];
        const declared = pack.collectibles[index];
        assert.equal(spawned.data.id, declared.id);
        assert.equal(spawned.data.icon, declared.icon);
        assert.deepEqual({ ...spawned.data.spawn }, declared.spawnPosition);
        assert.equal(spawned.mesh.children.length, declared.voxels.length);
        assert.equal(spawned.collected, false);
        assert.equal(spawned.mesh.position.x, declared.spawnPosition.x);
        assert.equal(spawned.mesh.position.z, declared.spawnPosition.z);
        // Every module is a real, non-degenerate box: a pack cannot ship an
        // invisible or zero-sized module through the pipeline.
        for (const module of spawned.data.modules) {
          assert.ok(module.sizeX > 0 && module.sizeY > 0 && module.sizeZ > 0);
          assert.ok(module.maxX > module.minX && module.maxY > module.minY);
        }
      }
      // Reloading the same pack reproduces the same fingerprint and layout.
      const before = manager.stateDiagnostics().recipeFingerprint;
      scene.clear();
      manager.activeItems.length = 0;
      await manager.loadState(id);
      assert.equal(manager.stateDiagnostics().recipeFingerprint, before);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a corrupted pack is refused by the pipeline instead of shipping', async () => {
  const scene = new THREE.Scene();
  const hud = { stateLabel: { textContent: '' }, hotbar: null, banner: null };
  const manager = new StateManager(scene, hud);
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    let refusals = 0;
    for (const id of GDO_STATE_PACK_IDS) {
      refusals++;
      const pack = readPack(id);
      // The same file, mutated the way a careless edit would mutate it.
      const broken = { ...pack, collectibles: [pack.collectibles[0], { ...pack.collectibles[0] }] };
      const verdict = runContentCheck(broken, { providers: PROVIDERS, preview: false });
      assert.equal(verdict.ok, false, `${id}: a duplicate id must fail the tool`);
      assert.deepEqual([...verdict.summary.failed], ['schema']);
      assert.deepEqual([...verdict.summary.skipped],
        ['bounds', 'budget', 'attribution', 'openings', 'determinism'],
        'later checks are skipped by name, not claimed');
      assert.match(verdict.summary.checks[0].detail, /collectibles\[1\]\.id:duplicate-id/);

      scene.clear();
      manager.activeItems.length = 0;
      globalThis.fetch = async () => ({ ok: true, json: async () => broken });
      await manager.loadState(id);
      assert.equal(manager.activeItems.length, 0, `${id}: a refused pack spawns nothing`);
      assert.equal(scene.children.length, 0, `${id}: a refused pack adds no scene node`);
      assert.equal(manager.stateDiagnostics().loaded, false);
      assert.equal(manager.stateDiagnostics().rejections, refusals,
        'every refused pack is counted, so a bad file cannot fail silently');
    }
    assert.equal(errors.length, GDO_STATE_PACK_IDS.length, 'every refusal is logged loudly');
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test('the packs are plausible playable content, not filler', () => {
  const seenItems = new Map();
  for (const id of GDO_STATE_PACK_IDS) {
    const pack = readPack(id);
    assert.ok(pack.collectibles.length >= 2, `${id} ships at least two collectibles`);
    assert.ok(pack.stateName.length >= 4 && pack.stateName.length <= 64);
    assert.match(pack.stateName, /[A-Za-z]/, `${id} has a human-readable name`);
    // The state reads as a place, and its palette dresses the sky it loads under.
    assert.match(pack.bgColor, /^#[0-9a-fA-F]{6}$/);
    assert.match(pack.fogColor, /^#[0-9a-fA-F]{6}$/);
    assert.match(pack.ambientColor, /^#[0-9a-fA-F]{6}$/);
    for (const item of pack.collectibles) {
      assert.equal(seenItems.has(item.id), false, `${item.id} appears in two packs`);
      seenItems.set(item.id, id);
      assert.ok(item.description.length <= 180);
      assert.ok(item.icon.length > 0);
      // Distinct colours per collectible: a pick-up has to read as an object.
      const colors = new Set(item.voxels.map(row => row[3]));
      assert.ok(colors.size >= 2, `${id}/${item.id} is a single flat colour`);
      // Spawns are separated enough that pick-ups never overlap.
      for (const other of pack.collectibles) {
        if (other.id === item.id) continue;
        const separation = Math.hypot(
          item.spawnPosition.x - other.spawnPosition.x, item.spawnPosition.z - other.spawnPosition.z);
        assert.ok(separation >= 2, `${id}: ${item.id} sits on top of ${other.id}`);
      }
    }
  }
  assert.equal(seenItems.size >= GDO_STATE_PACK_IDS.length * 2, true);
  assert.equal(PLANE_EXTENT >= 64, true);
});
