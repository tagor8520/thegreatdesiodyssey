import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from './GeoWorld.js';
import { GeoPlayer, GEO_WATER_BODY_HEIGHT, GEO_WATER_GRAVITY } from './GeoPlayer.js';
import { compileGeoFixture } from './GeoFixtures.js';
import { GEO_SURFACE_Y } from './GeoLayers.js';
import {
  GDO_FALL_IMPACT,
  GDO_WATER_CONTACT_PROFILES,
  GDO_WATER_STATE,
  GDO_WATER_SURFACE_SOURCE,
} from '../engine/WaterContact.js';

/**
 * `COL-08` gate: the water sensor answers with the same state, the same §9.5
 * step, and the same fall bands whether it is reading a mapped pond polygon or
 * the ground under the body. The curated island's fixed water plane that used to
 * be the second half of this proof is gone with the old game; the mapped pond,
 * its shore, the raised road over it, and the exit rules are the live contract.
 */

globalThis.Worker ??= class { addEventListener() {} postMessage() {} terminate() {} };

/** The avatar listens on window/document/canvas; the node harness stubs them. */
function stubBrowserGlobals() {
  const element = () => ({
    addEventListener() {}, removeEventListener() {}, setAttribute() {},
    style: {}, clientWidth: 800, clientHeight: 600, hidden: false,
  });
  globalThis.window ??= {
    addEventListener() {}, removeEventListener() {},
    innerWidth: 800, innerHeight: 600, devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { search: '' },
  };
  globalThis.document ??= {
    addEventListener() {}, removeEventListener() {}, createElement: element,
    pointerLockElement: null, exitPointerLock() {}, hidden: false,
    body: { append() {}, style: {} },
  };
  return element();
}

const POND = { x: 25, z: 50 };

function createCoordinateFixture() {
  const world = new GeoWorld(new THREE.Scene(), { latitude: 28.9845, longitude: 77.7064 });
  const tile = [...world.tiles.values()][0];
  const context = compileGeoFixture('provider-semantics', 'openmaptiles');
  const common = {
    type: 'tile-phase', requestId: tile.requestId, key: tile.key, bytes: 2048,
    provider: 'Fixture/openmaptiles', providerId: 'openmaptiles',
  };
  world._handleWorkerMessage({ ...common, phase: 'roads', geometry: context.roads, timings: {} });
  world._handleWorkerMessage({ ...common, phase: 'context', context: context.context, timings: {} });
  world._handleWorkerMessage({ ...common, phase: 'buildings', geometry: context.buildings, timings: {} });
  return world;
}

function stepPlayer(player, seconds = .5, dt = 1 / 30) {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) player.update(dt);
}

test('the coordinate world swims a mapped pond, wades its shore, and stays dry on roads', () => {
  const world = createCoordinateFixture();
  try {
    const ground = world.supportAt(POND.x, POND.z, {}).y;
    assert.ok(ground < GEO_SURFACE_Y.WATER, 'the mapped pond bottom is below its surface');

    // Mapped water: swimming, slowed, wet, and the class comes from the map.
    const swimming = world.waterContact(POND.x, POND.z, { feetY: ground, bodyHeight: GEO_WATER_BODY_HEIGHT });
    assert.equal(swimming.state, GDO_WATER_STATE.SWIMMING);
    assert.equal(swimming.source, GDO_WATER_SURFACE_SOURCE.MAPPED_POLYGON);
    assert.equal(swimming.waterClassName, 'lake');
    assert.equal(swimming.wet, true);
    assert.ok(swimming.speedMultiplier < .5);
    assert.ok(swimming.cameraMinY > GEO_SURFACE_Y.WATER, 'the eye is held above the water plane');
    assert.ok(Math.abs(swimming.depth - (GEO_SURFACE_Y.WATER - ground)) < 1e-9);

    // The same query at the body's own height: ankle deep is wading, and a raised
    // road over the pond stays dry with its full walking speed.
    const wadeFeet = GEO_SURFACE_Y.WATER - .03;
    const wading = world.waterContact(POND.x, POND.z, {
      feetY: wadeFeet, groundY: wadeFeet, bodyHeight: GEO_WATER_BODY_HEIGHT,
    });
    assert.equal(wading.state, GDO_WATER_STATE.WADING);
    assert.equal(wading.canStand, true, 'a shallow bottom keeps the feet');
    const onRoad = world.waterContact(POND.x, POND.z, {
      feetY: GEO_SURFACE_Y.ROAD, groundY: GEO_SURFACE_Y.ROAD, bodyHeight: GEO_WATER_BODY_HEIGHT,
    });
    assert.equal(onRoad.state, GDO_WATER_STATE.DRY, 'a raised road over the pond is dry');
    assert.equal(onRoad.wet, true, 'but the mapped water underneath still reads as wet');
    assert.ok(onRoad.speedMultiplier > .98 && onRoad.speedMultiplier < 1);
    // A body hovering at road height over the water with nothing under it is
    // still in the water; only a support above the surface makes a place dry.
    const hovering = world.waterContact(POND.x, POND.z, { feetY: GEO_SURFACE_Y.ROAD, bodyHeight: GEO_WATER_BODY_HEIGHT });
    assert.equal(hovering.state, GDO_WATER_STATE.SWIMMING);

    // Exit rules: the deep middle refuses, a level bank within reach allows it.
    const deepExit = world.waterExitPlan(POND.x, POND.z, { feetY: ground, bodyHeight: GEO_WATER_BODY_HEIGHT });
    assert.equal(deepExit.allowed, false);
    const bank = world.waterContact(POND.x, POND.z, {
      feetY: GEO_SURFACE_Y.WATER - .02, groundY: GEO_SURFACE_Y.WATER - .02, bodyHeight: GEO_WATER_BODY_HEIGHT,
    });
    assert.equal(bank.state, GDO_WATER_STATE.WADING, 'the shore is wadeable');
    // A body whose feet hang above a deep bottom is floating, not standing.
    const floating = world.waterContact(POND.x, POND.z, { feetY: GEO_SURFACE_Y.WATER - .02, bodyHeight: GEO_WATER_BODY_HEIGHT });
    assert.equal(floating.canStand, false);
  } finally {
    world.dispose();
  }
});

test('the avatar applies the state: slower swimming, a lifted camera, capped falls', () => {
  const world = createCoordinateFixture();
  const camera = new THREE.PerspectiveCamera(68, 1, .02, 210);
  const canvas = stubBrowserGlobals();
  const player = new GeoPlayer(new THREE.Scene(), camera, canvas, world);
  try {
    player.enabled = true;
    // Walk into the pond: the state follows the mapped water, not a script.
    player.setPosition(POND.x, POND.z);
    player.analogMove.z = 1;
    stepPlayer(player, .5);
    const water = player.waterDiagnostics();
    assert.equal(water.namespace, 'gdo:waterContact:v1');
    assert.ok([GDO_WATER_STATE.SWIMMING, GDO_WATER_STATE.SUBMERGED].includes(water.state),
      `state ${water.state} at the pond`);
    assert.ok(water.speedMultiplier < .5);
    assert.equal(water.source, GDO_WATER_SURFACE_SOURCE.MAPPED_POLYGON);
    assert.equal(water.steadyFrameAllocations, 0);
    assert.ok(water.samples > 10, 'the sensor runs every step');
    // Swimming is slower than walking on dry land.
    const swimmerTravel = Math.hypot(player.position.x - POND.x, player.position.z - POND.z);
    player.setPosition(12, 12);
    stepPlayer(player, .5);
    const walkerTravel = Math.hypot(player.position.x - 12, player.position.z - 12);
    assert.ok(swimmerTravel < walkerTravel, `swim ${swimmerTravel} vs walk ${walkerTravel}`);
    assert.equal(player.waterDiagnostics().state, GDO_WATER_STATE.DRY);

    // The first-person eye never goes under: it is clamped to the water margin.
    player.analogMove.x = 0;
    player.analogMove.z = 0;
    player.setPosition(POND.x, POND.z);
    player.updateCamera(1 / 30, true);
    const contact = world.waterContact(player.position.x, player.position.z,
      { feetY: player.position.y, bodyHeight: GEO_WATER_BODY_HEIGHT });
    assert.ok(contact.cameraMinY > GEO_SURFACE_Y.WATER);
    assert.ok(camera.position.y >= contact.cameraMinY - 1e-9, `eye ${camera.position.y} vs ${contact.cameraMinY}`);

    // A long fall is capped, and landing in water is a soft landing. No input is
    // applied, so the body stays over the pond.
    player.position.y = GEO_SURFACE_Y.WATER + 6;
    player.grounded = false;
    player.velocity.set(0, -40, 0);
    player.update(1 / 60);
    assert.ok(player.velocity.y >= -GDO_WATER_CONTACT_PROFILES.low.maxFallSpeedRatio * GEO_WATER_GRAVITY - 1e-9,
      `fall speed ${player.velocity.y} is capped`);
    player.position.y = world.supportAt(POND.x, POND.z, {}).y + 22;
    player.velocity.set(0, -30, 0);
    player.grounded = false;
    stepPlayer(player, 6);
    // The water entry is capped and soft: the pond bottom catches the body and
    // the impact is a light landing rather than a knock-down.
    const landed = player.waterDiagnostics();
    assert.equal(player.grounded, true, 'the body reaches the pond bottom');
    assert.equal(landed.state, GDO_WATER_STATE.SWIMMING);
    assert.equal(landed.submersion > .2, true, `wet entry (${landed.submersion})`);
    assert.equal(player.lastFallImpact, GDO_FALL_IMPACT.LIGHT, 'a water landing is soft');
    assert.ok(player.position.y <= GEO_SURFACE_Y.WATER, 'the body came to rest under the surface');

    // A hard landing on dry ground is classified, and the impulse is bounded.
    player.setPosition(12, 12);
    player.position.y += 8;
    player.velocity.set(3, -30, 0);
    player.grounded = false;
    stepPlayer(player, 4);
    assert.equal(player.grounded, true);
    assert.ok([GDO_FALL_IMPACT.STUMBLE, GDO_FALL_IMPACT.KNOCKDOWN].includes(player.lastFallImpact),
      `hard landing read as ${player.lastFallImpact}`);
    assert.ok(Math.hypot(player.velocity.x, player.velocity.z) <= 3 + 1e-9, 'the landing impulse is capped');
  } finally {
    player.dispose?.();
    world.dispose();
  }
});
