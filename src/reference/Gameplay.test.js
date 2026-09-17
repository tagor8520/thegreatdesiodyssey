import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Player, tileHeight } from './Player.js';
import { BridgeManager, BRIDGES } from './BridgeManager.js';
import { ItemManager, FOOD_ITEMS } from './ItemManager.js';
import { createHoardingCameraBlockers, HOARDINGS } from './HoardingManager.js';
import {
  biomeAt,
  createLandmarkCameraBlockers,
  createOrdinaryStructureCameraBlockers,
  LANDMARKS,
} from './BiomeManager.js';
import { curatedCameraSweepRadius } from './ThirdPersonCamera.js';

function setup(spawn) {
  const scene = new THREE.Scene(), bridges = new BridgeManager(scene);
  const player = new Player(scene, new THREE.PerspectiveCamera(), bridges, { inputTarget: new EventTarget(), spawn });
  return { scene, bridges, player, dispose() { player.dispose(); bridges.dispose(); } };
}

test('walk across every arched bridge in both directions without falling', () => {
  for (const bridge of BRIDGES) for (const direction of [-1, 1]) {
    const axis = bridge.axis;
    const spawn = new THREE.Vector3(bridge.x, 3, bridge.z);
    spawn[axis] -= direction * (bridge.length / 2 + 1);
    spawn.y = tileHeight(spawn.x, spawn.z);
    const game = setup(spawn), { player } = game;
    player.keys.add(axis === 'x' ? direction === 1 ? 'KeyD' : 'KeyA' : direction === 1 ? 'KeyS' : 'KeyW');
    for (let i = 0; i < 360; i++) {
      player.update(1 / 60);
      assert.ok(player.position.y >= 2.9, `${bridge.id} fell through at ${player.position.toArray()}`);
      const distance = direction * (player.position[axis] - bridge[axis]);
      if (distance > bridge.length / 2 + 1) break;
    }
    assert.ok(direction * (player.position[axis] - bridge[axis]) > bridge.length / 2, `${bridge.id} failed to cross`);
    game.dispose();
  }
});

test('jump rises and lands; blur clears input; river fall respawns', () => {
  const game = setup(new THREE.Vector3(-42, 3, -20)), { player } = game;
  player.jumpQueued = true; player.update(.1); assert.ok(player.position.y > 3);
  for (let i = 0; i < 120; i++) player.update(1 / 60);
  assert.ok(player.grounded); assert.equal(player.position.y, 3);
  player.keys.add('KeyD'); player.blur(); assert.equal(player.keys.size, 0);
  player.position.set(0, -6, 0); player.update(1 / 60); assert.deepEqual(player.position, player.spawn);
  game.dispose();
});

test('food definitions, valid biome placement and one-shot AABB scoring', () => {
  assert.deepEqual(FOOD_ITEMS.map(f => f.points), [10, 15, 15, 20, 10, 25, 30]);
  const scene = new THREE.Scene(), events = [], manager = new ItemManager(scene, { onCollect: item => events.push(item) });
  assert.equal(manager.items.size, 35);
  for (const item of manager.items.values()) {
    assert.equal(biomeAt(item.mesh.position.x,item.mesh.position.z), item.definition.biome);
    assert.ok(tileHeight(item.mesh.position.x,item.mesh.position.z) >= 0);
  }
  const item = manager.items.get('vada-pav:0'), p = item.mesh.position;
  const bounds = new THREE.Box3(new THREE.Vector3(p.x-1,3,p.z-1), new THREE.Vector3(p.x+1,8,p.z+1));
  manager.update(0, bounds); manager.update(0, bounds);
  assert.equal(manager.score, 10); assert.equal(events.length, 1); assert.equal(manager.items.size, 34);
  manager.dispose(); manager.dispose(); assert.equal(scene.children.length, 0);
});

test('normalized diagonal motion and consistent movement across frame rates', () => {
  const run = (keys, dt) => {
    const game = setup(new THREE.Vector3(-65,3,0)); keys.forEach(key => game.player.keys.add(key));
    for (let t = 0; t < 1 - 1e-6; t += dt) game.player.update(dt);
    const distance = game.player.position.distanceTo(game.player.spawn); game.dispose(); return distance;
  };
  assert.ok(Math.abs(run(['KeyD'],1/60) - run(['KeyD','KeyW'],1/60)) < .05);
  assert.ok(Math.abs(run(['KeyD'],1/30) - run(['KeyD'],1/120)) < .05);
});

test('curated camera uses near-plane sizing and bridge structure blockers', () => {
  const scene = new THREE.Scene();
  const bridges = new BridgeManager(scene);
  bridges.cameraBlockers.length = 0;
  bridges.cameraBlockers.push(new THREE.Box3(
    new THREE.Vector3(1, 0, -1),
    new THREE.Vector3(2, 2, 1),
  ));
  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 1, 300);
  const radius = curatedCameraSweepRadius(camera);
  assert.ok(radius >= .6 && radius <= 1.25);
  const target = new THREE.Vector3(0, 1, 0);
  const desired = new THREE.Vector3(4, 1, 0);
  const result = bridges.clipCamera(target, desired, .2, {});
  assert.equal(result.blocked, true);
  assert.ok(desired.x < .8, 'camera should stop before the expanded structural box');
  const high = new THREE.Vector3(4, 5, 0);
  assert.equal(bridges.clipCamera(new THREE.Vector3(0, 5, 0), high, .2, {}).blocked, false);
  bridges.dispose();
});

test('curated landmark compounds block masonry but preserve the Gateway arch', () => {
  const blockers = createLandmarkCameraBlockers();
  assert.equal(blockers.length, 34);
  assert.ok(blockers.every(box => box.userData.role === 'camera-blocker'));
  const bridges = new BridgeManager(new THREE.Scene(), { cameraBlockers: blockers });
  const [x, z] = LANDMARKS.gateway;

  const throughArch = new THREE.Vector3(x, 10, z + 16);
  assert.equal(
    bridges.clipCamera(new THREE.Vector3(x, 10, z - 16), throughArch, .6, {}).blocked,
    false,
    'the genuine central opening must not be filled by an oversized landmark bound',
  );

  const throughPier = new THREE.Vector3(x - 9, 10, z + 16);
  const result = bridges.clipCamera(new THREE.Vector3(x - 9, 10, z - 16), throughPier, .6, {});
  assert.equal(result.blocked, true);
  assert.ok(throughPier.z < z - 5, 'camera should stop before Gateway masonry');
  const throughArchStones = new THREE.Vector3(x + 1.7, 18.4, z + 16);
  assert.equal(
    bridges.clipCamera(new THREE.Vector3(x + 1.7, 18.4, z - 16), throughArchStones, .2, {}).blocked,
    true,
    'stepped arch masonry should block without filling the central opening',
  );

  bridges.cameraBlockers.push(...createHoardingCameraBlockers());
  const sign = HOARDINGS[0];
  const underSign = new THREE.Vector3(sign.x, 5, sign.z + 4);
  assert.equal(bridges.clipCamera(new THREE.Vector3(sign.x, 5, sign.z - 4), underSign, .2, {}).blocked, false);
  const throughBoard = new THREE.Vector3(sign.x, 8, sign.z + 4);
  assert.equal(bridges.clipCamera(new THREE.Vector3(sign.x, 8, sign.z - 4), throughBoard, .2, {}).blocked, true);
  bridges.dispose();
});

test('ordinary curated skyline and railway masses expose tight camera proxies', () => {
  const blockers = createOrdinaryStructureCameraBlockers(2026, 1);
  const building = blockers.find(box => box.userData.id.startsWith('tech-tower:'));
  assert.ok(building);
  assert.ok(blockers.some(box => box.userData.id.startsWith('skyline-tower:')));
  assert.equal(blockers.filter(box => box.userData.id.startsWith('railway:deck')).length, 1);
  assert.equal(blockers.filter(box => box.userData.id.startsWith('railway:pier')).length, 16);

  const bridges = new BridgeManager(new THREE.Scene(), { cameraBlockers: blockers });
  const center = building.getCenter(new THREE.Vector3());
  const desired = new THREE.Vector3(center.x, center.y, building.max.z + 5);
  assert.equal(bridges.clipCamera(
    new THREE.Vector3(center.x, center.y, building.min.z - 5), desired, .2, {},
  ).blocked, true);
  assert.ok(desired.z < building.min.z);
  bridges.dispose();
});

test('camera yaw rotates forward movement and pitch is bounded', () => {
  const game = setup(new THREE.Vector3(-42,3,-20)), { player } = game;
  player.orbit.yaw = Math.PI / 2; player.keys.add('KeyW');
  for (let i = 0; i < 30; i++) player.update(1/60);
  assert.ok(player.position.x < -46); assert.ok(Math.abs(player.position.z + 20) < .01);
  player.orbit.dragging = true;
  player.orbit.look({movementX:0,movementY:100000}); assert.equal(player.orbit.pitch,1.35);
  player.orbit.look({movementX:0,movementY:-100000}); assert.equal(player.orbit.pitch,.12);
  game.dispose();
});
