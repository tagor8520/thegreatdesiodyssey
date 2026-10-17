import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GDO_CURATED_LANDMARKS, GDO_CURATED_LANDMARK_IDS, compileCuratedLandmarks } from './landmarkRecipes.js';
import { LANDMARK_ORIGINS, LANDMARKS, createLandmarkCameraBlockers, curatedLandmarkCompilations } from './BiomeManager.js';
import { compileCollectibleRecipe, compileLandmarkRecipe, compileStatePack } from '../engine/RecipeCompiler.js';
import { buildModuleGroup, buildVoxelMesh } from '../engine/VoxelBuilder.js';
import { StateManager } from '../engine/StateManager.js';
import { GEO_QUERY_MASK } from '../geo/GeoCollision.js';
import { createStructureSweep } from '../engine/StructureSweep.js';

/**
 * `CNT-02` live gate: the curated landmarks are **data**. Their compounds are
 * compiled module lists, the boxes the island's camera sweep uses are that
 * compile, and the voxel recipes every runtime path consumes (content packs,
 * coordinate collectibles, avatar limbs) all flow through one compiler — with
 * the legacy builder proved byte-equivalent.
 */

globalThis.Worker ??= class { addEventListener() {} postMessage() {} terminate() {} };
globalThis.requestAnimationFrame ??= () => 0;

const readPack = name => JSON.parse(
  readFileSync(new URL(`../../public/content/states/${name}.json`, import.meta.url), 'utf8'));

test('the curated landmark compounds are compiled from data and stay tight', () => {
  const compiled = compileCuratedLandmarks(compileLandmarkRecipe, LANDMARK_ORIGINS);
  assert.equal(compiled.modules.length, 34);
  assert.deepEqual([...GDO_CURATED_LANDMARK_IDS], ['gateway', 'chariot']);
  const [gateway, chariot] = compiled.landmarks;
  assert.equal(gateway.id, 'gateway');
  assert.equal(gateway.modules.length, 18);
  assert.equal(chariot.modules.length, 16);
  // The recipes are pure data: no functions, no objects with methods.
  for (const recipe of Object.values(GDO_CURATED_LANDMARKS)) {
    for (const op of recipe.modules) {
      assert.equal(typeof op, 'object');
      assert.ok(['box', 'grid', 'step', 'tier'].includes(op.op));
    }
  }
  // Every compound is a tight box around real masonry, and named for its part.
  const ids = compiled.modules.map(entry => entry.id);
  for (const id of ['gateway:plinth', 'gateway:pier:-1', 'gateway:pier:1', 'gateway:lintel',
    'gateway:arch:-1:0', 'gateway:arch:1:4', 'gateway:tower:-11:4',
    'chariot:plinth', 'chariot:body', 'chariot:wheel:-5:-5', 'chariot:column:5:5', 'chariot:roof:5']) {
    assert.ok(ids.includes(id), `${id} is a compiled module`);
  }
  assert.equal(new Set(ids).size, ids.length, 'every compound has its own id');
  for (const entry of compiled.modules) {
    assert.ok(entry.sizeX > 0 && entry.sizeY > 0 && entry.sizeZ > 0);
    assert.ok(entry.minX < entry.maxX && entry.minY < entry.maxY && entry.minZ < entry.maxZ);
  }
  // The arch opening is a reservation: nothing is inside it, and the stepped
  // voussoirs above it are named as its boundary instead of being an AABB.
  const [opening] = gateway.openings;
  assert.equal(opening.id, 'gateway:arch');
  assert.deepEqual([...opening.enclosedModules], []);
  // The first voussoir blocks border the passage; the piers merely *touch* its
  // faces, and touching is not overlapping — so no masonry is misreported.
  assert.deepEqual([...opening.boundaryModules].sort(), ['gateway:arch:-1:0', 'gateway:arch:1:0']);
  const pier = gateway.modules.find(entry => entry.id === 'gateway:pier:-1');
  assert.equal(pier.maxX, opening.minX, 'the pier face is the opening face');
  assert.equal(chariot.openings.length, 0);
  // Visual-only: a landmark declares no solid or interaction proxy of its own.
  assert.deepEqual(gateway.solidProxies, []);
  assert.deepEqual(gateway.interactionProxies, []);
  assert.equal(gateway.cameraProxies.length, gateway.modules.length);
  // Placement is not identity: moving the recipe keeps its fingerprint.
  const moved = compileLandmarkRecipe(GDO_CURATED_LANDMARKS.gateway, { origin: [400, 0, 400] });
  assert.equal(moved.fingerprint, gateway.fingerprint);
  assert.notEqual(moved.modules[0].x, gateway.modules[0].x);
});

test('the island’s landmark boxes are exactly that compile, and still block correctly', () => {
  const blockers = createLandmarkCameraBlockers();
  const compiled = curatedLandmarkCompilations();
  const modules = compiled.flatMap(entry => entry.modules);
  assert.equal(blockers.length, modules.length);
  const byId = new Map(blockers.map(box => [box.userData.id, box]));
  for (const entry of modules) {
    const box = byId.get(entry.id);
    assert.ok(box, `${entry.id} reached the island`);
    assert.equal(box.userData.role, 'camera-blocker');
    assert.deepEqual(
      [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].map(value => Math.round(value * 1e6) / 1e6),
      [entry.minX, entry.minY, entry.minZ, entry.maxX, entry.maxY, entry.maxZ].map(value => Math.round(value * 1e6) / 1e6));
  }
  assert.deepEqual([...byId.keys()], modules.map(entry => entry.id), 'declaration order is preserved');
  // The compiled compounds answer the `COL-06` sweep: masonry blocks, the arch
  // opening does not, and the under-arch passage is where the data says it is.
  const sweep = createStructureSweep({ profile: 'low', boxes: blockers });
  const [x, z] = LANDMARKS.gateway;
  const out = {};
  sweep.querySweep(x, 10, z - 16, 0, 0, 32, .6, out, GEO_QUERY_MASK.CAMERA_BLOCKER);
  assert.equal(out.hit, false, 'the arch passage stays clear');
  sweep.querySweep(x - 9, 10, z - 16, 0, 0, 32, .6, out, GEO_QUERY_MASK.CAMERA_BLOCKER);
  assert.equal(out.blockerId, 'gateway:pier:-1');
  sweep.querySweep(x + 1.7, 18.4, z - 16, 0, 0, 32, .2, out, GEO_QUERY_MASK.CAMERA_BLOCKER);
  assert.equal(out.blockerId.startsWith('gateway:arch:1:'), true,
    `stepped masonry blocks without filling the opening (${out.blockerId})`);
  const chariot = LANDMARKS.chariot;
  sweep.querySweep(chariot[0], 30, chariot[1], 0, -40, 0, .3, out, GEO_QUERY_MASK.CAMERA_BLOCKER);
  assert.equal(out.hit, true, 'the chariot roof stops a downward camera');
  assert.ok(out.blockerId.startsWith('chariot:roof:'));
  assert.equal(sweep.diagnostics().steadyFrameAllocations, 0);
});

test('the legacy voxel builder is exactly the compiled module path', () => {
  const pack = readPack('kerala');
  const item = pack.collectibles[0];
  const compiled = compileCollectibleRecipe(item, { scale: .22 });
  const legacy = buildVoxelMesh(item.voxels, .22);
  const modules = buildModuleGroup(compiled, { scale: .22 });
  assert.equal(legacy.children.length, item.voxels.length);
  assert.equal(modules.children.length, compiled.modules.length);
  assert.equal(legacy.children.length, modules.children.length);
  for (let index = 0; index < legacy.children.length; index++) {
    const before = legacy.children[index], after = modules.children[index];
    assert.deepEqual(after.position.toArray(), before.position.toArray());
    assert.deepEqual(after.scale.toArray(), before.scale.toArray());
    assert.equal(after.scale.x, .22);
    assert.equal(after.material.color.getHexString(), before.material.color.getHexString());
    assert.equal(after.castShadow, before.castShadow);
    assert.equal(after.receiveShadow, before.receiveShadow);
    assert.equal(after.name, compiled.modules[index].id);
    // The legacy path and the compiled path share one cached material per colour.
    assert.equal(after.material, before.material);
  }
  // A landmark module list builds through the same adapter at mixed sizes.
  const landmark = compileLandmarkRecipe({
    id: 'mixed', modules: [
      { op: 'box', id: 'mixed:slab', at: [0, 1, 0], size: [4, 2, 6] },
      { op: 'box', id: 'mixed:post', at: [3, 4, 0], size: [1, 6, 1] },
    ],
  });
  const group = buildModuleGroup(landmark, { scale: 1 });
  assert.deepEqual(group.children[0].scale.toArray(), [4, 2, 6]);
  assert.deepEqual(group.children[1].scale.toArray(), [1, 6, 1]);
  assert.throws(() => buildModuleGroup(null), /compiled recipe/);
});

test('a loaded state pack spawns through the compiled recipe and reports it', async () => {
  const scene = new THREE.Scene();
  const hud = {
    stateLabel: { textContent: '' }, hotbar: null, banner: null,
    score: { textContent: '' }, progress: { style: {} }, inventory: null,
  };
  const manager = new StateManager(scene, hud);
  const pack = readPack('kerala');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => pack });
  try {
    await manager.loadState('kerala');
  } finally {
    globalThis.fetch = originalFetch;
  }
  const diagnostics = manager.stateDiagnostics();
  assert.equal(diagnostics.loaded, true);
  assert.equal(diagnostics.recipeNamespace, 'gdo:recipeCompiler:v1');
  assert.equal(diagnostics.recipeModules, pack.collectibles.reduce((total, item) => total + item.voxels.length, 0));
  assert.equal(diagnostics.recipePrunedModules, 0);
  assert.ok(diagnostics.recipeFamilies > 0);
  const expected = compileStatePack(pack, { scale: .22 });
  assert.equal(diagnostics.recipeFingerprint, expected.fingerprint);
  // The spawned mesh is the compiled module list, not a second hand-built copy.
  assert.equal(manager.activeItems.length, pack.collectibles.length);
  for (let index = 0; index < manager.activeItems.length; index++) {
    const spawned = manager.activeItems[index];
    assert.equal(spawned.mesh.children.length, spawned.data.modules.length);
    assert.equal(spawned.data.icon, pack.collectibles[index].icon);
    assert.deepEqual({ ...spawned.data.spawn }, pack.collectibles[index].spawnPosition);
    assert.equal(spawned.mesh.children[0].name, spawned.data.modules[0].id);
  }
  manager.dispose?.();
});
