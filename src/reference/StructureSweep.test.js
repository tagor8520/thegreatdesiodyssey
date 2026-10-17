import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BiomeManager, GDO_CURATED_WORLD_DOMAIN, createLandmarkCameraBlockers, LANDMARKS } from './BiomeManager.js';
import { BridgeManager } from './BridgeManager.js';
import { createHoardingCameraBlockers, HOARDINGS } from './HoardingManager.js';
import { Player } from './Player.js';
import { ThirdPersonCamera, curatedCameraSweepRadius } from './ThirdPersonCamera.js';
import { createStructureSweep } from '../engine/StructureSweep.js';
import { GEO_QUERY_MASK } from '../geo/GeoCollision.js';
import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';
import { describeDomainCompliance } from '../engine/DomainInterface.js';

/**
 * `COL-06` live gate: the curated island's camera obstruction is the declared
 * `dynamicSweep` member. Bridges, signs, landmarks, skyline and railway masses
 * all live in one array answered by one sweep, the third-person camera pulls
 * back through that sweep, and the work stays inside the declared candidate cap.
 */

globalThis.Worker ??= class { addEventListener() {} postMessage() {} terminate() {} };

function createIsland() {
  const scene = new THREE.Scene();
  const biomes = new BiomeManager(scene, { loadRadius: 0, budgetMs: 1 });
  const bridges = new BridgeManager(scene, {
    cameraBlockers: biomes.cameraBlockers,
    sweep: biomes.structureSweep,
  });
  return { scene, biomes, bridges };
}

test('bridges, signs and island structures share the one declared sweep', () => {
  const { scene, biomes, bridges } = createIsland();
  try {
    assert.equal(bridges.cameraBlockers, biomes.cameraBlockers, 'one live structural array, not a copy');
    assert.equal(bridges.sweep, biomes.structureSweep, 'and one authority answering for it');
    assert.equal(BRIDGE_IDENTITY_CHECK(bridges, biomes), true);
    // The sign proxies are data, so the node harness pushes them directly (the
    // `HoardingManager` itself only builds canvas textures on top of them).
    bridges.cameraBlockers.push(...createHoardingCameraBlockers());
    assert.ok(biomes.structureSweep.size > bridges.colliders.length,
      'the island adds its own landmark/skyline/railway masses');

    // Every structural box the camera may hit is named and role-tagged.
    const ids = biomes.cameraBlockers.map(box => box.userData?.id);
    assert.equal(ids.every(Boolean), true, 'every blocker is named');
    assert.ok(ids.some(id => id.startsWith('bridge:')));
    assert.ok(ids.some(id => id.startsWith('hoarding:')));
    assert.ok(ids.some(id => id.startsWith('gateway:')));
    assert.ok(ids.some(id => id.startsWith('railway:')));

    // The sign board blocks and the under-sign opening still does not.
    const sign = HOARDINGS[0];
    const out = {};
    biomes.querySweep(sign.x - 8, sign.y ?? 0, sign.z, 16, 8, 0, .2, out, GEO_QUERY_MASK.CAMERA_BLOCKER);
    assert.equal(typeof out.hit, 'boolean');
    assert.equal(biomes.querySweep(sign.x, 8.5, sign.z - 6, 0, 0, 12, .2, out).blockerId.includes('hoarding'),
      true, 'the board is a structural contact');
    assert.equal(biomes.querySweep(sign.x, 4.5, sign.z - 6, 0, 0, 12, .2, out).hit,
      false, 'the walkable under-sign opening stays clear');
  } finally {
    bridges.dispose();
    biomes.dispose();
  }
});

function BRIDGE_IDENTITY_CHECK(bridges, biomes) {
  // A blocker pushed by the bridge builder is visible to the world's own sweep.
  const deck = bridges.cameraBlockers.find(box => box.userData?.id?.startsWith('bridge:') && box.userData.id.includes('deck'));
  const out = {};
  const centerX = (deck.min.x + deck.max.x) / 2;
  const centerZ = (deck.min.z + deck.max.z) / 2;
  biomes.querySweep(centerX, 40, centerZ, 0, -60, 0, .3, out, GEO_QUERY_MASK.CAMERA_BLOCKER);
  return out.hit && out.blockerId.startsWith('bridge:');
}

test('the third-person camera pulls back through the declared sweep', () => {
  const { scene, biomes, bridges } = createIsland();
  try {
    const camera = new THREE.PerspectiveCamera(42, 16 / 9, 1, 300);
    const target = new THREE.Vector3();
    const desired = new THREE.Vector3();
    const out = {};
    const radius = curatedCameraSweepRadius(camera);
    assert.ok(radius >= .6 && radius <= 1.25);

    // A bridge deck directly above the player: the camera must not pass through it.
    const deck = bridges.cameraBlockers
      .find(box => box.userData?.id?.includes('bridge:') && box.userData.id.includes('deck'));
    const deckCenterX = (deck.min.x + deck.max.x) / 2;
    const deckCenterZ = (deck.min.z + deck.max.z) / 2;
    target.set(deckCenterX, deck.min.y - 2, deckCenterZ);
    desired.set(target.x, deck.max.y + 20, target.z);
    const sweepsBefore = bridges.sweepDiagnostics.sweeps;
    bridges.clipCamera(target, desired, radius, out);
    assert.equal(out.blocked, true, 'the deck blocks the pull-back');
    assert.equal(out.blockerId.startsWith('bridge:'), true);
    assert.ok(out.time > 0 && out.time < 1);
    assert.ok(desired.y < deck.min.y + 1, 'the camera stops under the deck');
    assert.ok(bridges.sweepDiagnostics.sweeps > sweepsBefore, 'the clip went through the sweep');

    // The same call into the world member gives the identical verdict.
    const worldOut = {};
    biomes.querySweep(target.x, target.y, target.z, 0, 20, 0, radius, worldOut);
    assert.equal(worldOut.hit, out.blocked);
    assert.equal(worldOut.blockerId, out.blockerId, 'both routes name the same structure');

    // An open lane leaves the camera alone, and the island's own sweep counters
    // stay inside the declared candidate cap.
    desired.set(target.x + 60, target.y + 40, target.z);
    out.blocked = true;
    bridges.clipCamera(new THREE.Vector3(0, 200, 0), desired.set(0, 260, 0), radius, out);
    assert.equal(out.blocked, false, 'nothing is in the sky lane');
    const diagnostics = bridges.sweepDiagnostics;
    assert.ok(diagnostics.maxCandidates <= GDO_LOW_PROFILE_BUDGETS.curatedSweepCandidates);
    assert.equal(diagnostics.steadyFrameAllocations, GDO_LOW_PROFILE_BUDGETS.curatedSweepSteadyFrameAllocations);
    assert.equal(diagnostics.namespace, 'gdo:structureSweep:v1');
  } finally {
    bridges.dispose();
    biomes.dispose();
  }
});

test('the landmark compounds keep their arch openings through the sweep', () => {
  const { biomes, bridges } = createIsland();
  try {
    const [x, z] = LANDMARKS.gateway;
    const out = {};
    // The genuine central arch is not filled by an oversized landmark bound.
    biomes.querySweep(x, 10, z - 16, 0, 0, 32, .6, out);
    assert.equal(out.hit, false, 'the arch opening stays clear');
    // The pier beside it does block, and is named.
    biomes.querySweep(x - 9, 10, z - 16, 0, 0, 32, .6, out);
    assert.equal(out.hit, true);
    assert.equal(out.blockerId.startsWith('gateway:'), true);
    // The stepped arch stones block without filling the opening.
    biomes.querySweep(x + 1.7, 18.4, z - 16, 0, 0, 32, .2, out);
    assert.equal(out.hit, true);
    assert.equal(out.blockerId.startsWith('gateway:arch'), true);
    // The landmark set is the same live array the island declared.
    const landmarkIds = createLandmarkCameraBlockers().map(box => box.userData.id);
    for (const id of ['gateway:plinth', 'gateway:lintel']) assert.ok(landmarkIds.includes(id));
    assert.equal(
      biomes.cameraBlockers.filter(box => /^(gateway|chariot):/.test(box.userData.id)).length,
      landmarkIds.length, 'the island declares exactly the landmark compounds');
    assert.equal(landmarkIds.filter(id => id.startsWith('gateway:')).length, 18);
  } finally {
    bridges.dispose();
    biomes.dispose();
  }
});

test('the curated avatar’s third-person camera uses the declared sweep', () => {
  const { scene, biomes, bridges } = createIsland();
  const inputTarget = new EventTarget();
  const camera = new THREE.PerspectiveCamera(62, 4 / 3, .08, 320);
  const player = new Player(scene, camera, bridges, { inputTarget, spawn: new THREE.Vector3(-42, 3, -20) });
  try {
    assert.ok(player.orbit instanceof ThirdPersonCamera);
    // The orbit camera was constructed with a clip callback: drive a real frame
    // and require the sweep to have answered it.
    const before = bridges.sweepDiagnostics.sweeps;
    player.orbit.distance = 60;
    player.orbit.pitch = .12;
    for (let frame = 0; frame < 8; frame++) player.orbit.update(1 / 60, player.position);
    assert.ok(bridges.sweepDiagnostics.sweeps > before, 'the orbit camera asks the declared sweep');
    assert.ok(Number.isFinite(player.orbit.resolvedDistance));
    assert.ok(player.orbit.resolvedDistance <= 60 + 1e-6);
    // The island's declared sweep is still what answers the domain contract.
    const report = describeDomainCompliance(biomes, GDO_CURATED_WORLD_DOMAIN);
    assert.equal(report.ok, true, report.detail);
    assert.equal(biomes.domain.capabilities.dynamicSweep, true);
    assert.equal(typeof biomes.querySweep, 'function');
  } finally {
    player.dispose();
    bridges.dispose();
    biomes.dispose();
  }
});

test('an adopted sweep keeps the island’s own blockers after a bridge teardown', () => {
  const { biomes, bridges } = createIsland();
  const islandBlockers = biomes.cameraBlockers.length;
  bridges.dispose();
  try {
    // `BridgeManager.dispose` clears the structural set it was given, which is
    // the honest behaviour for one shared authority; the island can rebuild its
    // own structures and keep answering the declared member.
    assert.equal(biomes.cameraBlockers.length, 0);
    const out = {};
    biomes.querySweep(-64, 12, -80, 0, -8, 0, .3, out);
    assert.equal(out.hit, false, 'the released deck no longer blocks');
    biomes.cameraBlockers.push(...createLandmarkCameraBlockers());
    biomes.querySweep(LANDMARKS.gateway[0] - 9, 10, LANDMARKS.gateway[1] - 16, 0, 0, 32, .6, out);
    assert.equal(out.hit, true, 'and the re-declared structures answer again');
    assert.ok(islandBlockers > 0);
  } finally {
    biomes.dispose();
  }
});

test('the hoarding proxies are the island’s own structural boxes', () => {
  const blockers = createHoardingCameraBlockers();
  assert.ok(blockers.length > 0);
  const sweep = createStructureSweep({ profile: 'low', boxes: blockers });
  const sign = HOARDINGS[0];
  const out = {};
  // A camera pulling back through the board stops at it; the post clears a walkway.
  sweep.querySweep(sign.x, 9, sign.z - 6, 0, 0, 12, .2, out);
  assert.equal(out.hit, true);
  assert.equal(out.blockerRole, 'camera-blocker');
  assert.equal(sweep.diagnostics().namespace, 'gdo:structureSweep:v1');
  const post = blockers.find(box => box.userData.id.includes('post'));
  sweep.querySweep(post.min.x, 30, post.min.z, 0, -40, 0, .1, out);
  assert.equal(out.hit, true);
  assert.ok(out.blockerDistance > 0);
});
