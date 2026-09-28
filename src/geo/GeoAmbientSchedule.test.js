import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from './GeoWorld.js';
import { createAmbientLifeScheduler } from '../engine/AmbientLifeScheduler.js';
import { GDO_AMBIENT_LIFE_SOURCE_TYPES } from '../engine/AmbientLifeMotion.js';
import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';

globalThis.Worker ??= class { addEventListener() {} postMessage() {} terminate() {} };

// The decoration stream carries the provider's source type; 10 is a bird and 11
// is a bee, which is also what the pool keys its families by.
const BIRD_SOURCE_TYPE = 10;
const BEE_SOURCE_TYPE = 11;

/**
 * `LIF-02` gate, world level: the live world drives the scheduler from its own
 * render camera every frame, so the sprites that are drawn are the sprites the
 * player can actually see — and the verdict shows up in the budget surface.
 */

function createWorld() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, .1, 2_000);
  const world = new GeoWorld(scene, { latitude: 28.9845, longitude: 77.7064, camera, viewportHeight: 720 });
  return { scene, world, camera };
}

/** Decoration stream for the pool: x, z, scale, source type, yaw, tag. */
function decorationStream(entries) {
  const values = new Float32Array(entries.length * 6);
  entries.forEach((entry, index) => {
    values.set([entry.x, entry.z, entry.scale ?? 1, entry.type, index * .31 % 1, index % 4], index * 6);
  });
  return values;
}

test('the world schedules ambient life from its own camera basis', () => {
  const { world, camera } = createWorld();
  try {
    assert.equal(GDO_AMBIENT_LIFE_SOURCE_TYPES[BIRD_SOURCE_TYPE], 'bird');
    assert.equal(GDO_AMBIENT_LIFE_SOURCE_TYPES[BEE_SOURCE_TYPE], 'bee');
    const pools = world.ambientLifePools;
    assert.ok(world.ambientScheduler, 'the world owns a scheduler');
    assert.equal(world.ambientScheduler.namespace, 'gdo:ambientLifeScheduler:v1');
    assert.equal(world.ambientScheduler.limits.maxActiveSources, GDO_LOW_PROFILE_BUDGETS.ambientActiveSources);

    // A stand of birds straight ahead and a second stand far behind the camera.
    const ahead = pools.addOwner('tile:ambient:ahead', decorationStream([
      { x: -.6, z: -6, type: BIRD_SOURCE_TYPE },
      { x: 0, z: -6, type: BIRD_SOURCE_TYPE },
      { x: .6, z: -6, type: BIRD_SOURCE_TYPE },
    ]), 6);
    const behind = pools.addOwner('tile:ambient:behind', decorationStream([
      { x: -.6, z: 90, type: BIRD_SOURCE_TYPE },
      { x: .6, z: 90, type: BIRD_SOURCE_TYPE },
    ]), 6);
    assert.equal(ahead, 3);
    assert.equal(behind, 2);
    assert.equal(pools.entries, 5);

    const sprite = pools.geometries[0].getAttribute('gdoAmbientSprite');
    const drawnIds = () => pools.packedRecords[0]
      .map((record, index) => ({ id: record.id, scale: sprite.array[index * 4] }))
      .filter(entry => entry.scale > 0).map(entry => entry.id);

    camera.position.set(0, 2.6, 0);
    camera.lookAt(0, 2.6, -6);
    camera.updateMatrixWorld(true);
    // The frame clock drives both the shader clock and the appearance windows.
    world.update({ x: 0, y: 2.6, z: 0 }, camera, 720, 0);
    const schedule = world.ambientSchedule;
    assert.ok(schedule, 'a frame produces a scheduling verdict');
    assert.equal(schedule.namespace, 'gdo:ambientLifeScheduler:v1');
    assert.equal(schedule.evaluated, 5);
    assert.ok(schedule.active > 0, 'something is on screen');
    assert.equal(schedule.active + schedule.parked, 5, 'every resident sprite is accounted for');
    const front = drawnIds();
    assert.ok(front.length > 0);
    for (const id of front) assert.ok(id.startsWith('tile:ambient:ahead'), `${id} is in front of the camera`);

    // The verdict is part of the debug surface, not a private counter.
    assert.equal(world.ambientScheduler.diagnostics().active, schedule.active);
    assert.equal(world.ambientScheduler.diagnostics().steadyFrameAllocations, 0);
    assert.equal(world.ambientScheduler.diagnostics().limits.maxActiveSources,
      GDO_LOW_PROFILE_BUDGETS.ambientActiveSources);

    // Turn the camera around with the player: the drawn set follows the view.
    camera.lookAt(0, 2.6, 90);
    camera.updateMatrixWorld(true);
    world.update({ x: 0, y: 2.6, z: 0 }, camera, 720, 40);
    const turned = drawnIds();
    for (const id of turned) assert.ok(id.startsWith('tile:ambient:behind'), `${id} is behind the player now`);
    assert.ok(turned.length > 0, 'the far stand is scheduled once it is in view');

    // The activity gate the roadmap names, driven through the pool's own cycle
    // envelope: over a long clock, appearances open and close, so the number of
    // parked sources is not a constant of the framing.
    const closedBefore = world.ambientScheduler.diagnostics().windowClosed;
    for (let step = 1; step <= 120; step++) {
      world.update({ x: 0, y: 2.6, z: 0 }, camera, 720, step * 137);
    }
    const windowClosed = world.ambientScheduler.diagnostics().windowClosed - closedBefore;
    assert.ok(windowClosed > 0, 'long clocks close appearance windows and park sources');
    assert.equal(world.ambientSchedule.namespace, 'gdo:ambientLifeScheduler:v1');
  } finally {
    world.dispose();
  }
});

test('the scheduler refuses malformed frames instead of guessing', () => {
  const { world, camera } = createWorld();
  try {
    camera.position.set(0, 2, 0);
    camera.lookAt(0, 2, -1);
    camera.updateMatrixWorld(true);
    // No ambient sources at all: the frame short-circuits to null, not a throw.
    assert.equal(world.scheduleAmbientLife(0), null);
    const scheduler = createAmbientLifeScheduler({ profile: 'balanced' });
    assert.throws(() => scheduler.begin({
      fovRadians: Math.PI / 3, viewportHeight: 720, cycleIndex: 0, forwardX: 0, forwardZ: 0,
    }), /look direction/);
    assert.throws(() => createAmbientLifeScheduler({ profile: 'nope' }), /Unknown ambient-life scheduler profile/);
    scheduler.dispose();
    assert.equal(world.ambientSchedule, null);
  } finally {
    world.dispose();
  }
});
