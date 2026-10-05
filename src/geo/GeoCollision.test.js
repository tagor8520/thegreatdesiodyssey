import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GEO_BUILDING_QUERY_MASK,
  GEO_PLAYER_COLLISION_PROFILE,
  GEO_QUERY_MASK,
  circleFootprintPenetration,
  circleIntersectsFootprint,
  sweepCircleAgainstFootprint,
  sweepPointAgainstAabb,
} from './GeoCollision.js';
import { cameraNearPlaneSweepRadius } from './GeoPlayer.js';
import { GeoWorld, buildCollisionGrid } from './GeoWorld.js';

function packedPolygon(rings) {
  const vertices = [];
  const ringOffsets = [0];
  for (const ring of rings) {
    for (const [x, z] of ring) vertices.push(x, z);
    ringOffsets.push(vertices.length / 2);
  }
  return {
    vertices: new Float32Array(vertices),
    ringOffsets: new Uint32Array(ringOffsets),
    polygonOffsets: new Uint32Array([0, rings.length]),
  };
}

test('coordinate player shape plus contact skin stays inside the approved profile', () => {
  assert.ok(GEO_PLAYER_COLLISION_PROFILE.radius >= .05);
  assert.ok(GEO_PLAYER_COLLISION_PROFILE.radius <= .055);
  assert.ok(GEO_PLAYER_COLLISION_PROFILE.radius + GEO_PLAYER_COLLISION_PROFILE.skin <= .06);
  assert.equal(GEO_PLAYER_COLLISION_PROFILE.maxContacts, 2);
  assert.equal(GEO_PLAYER_COLLISION_PROFILE.maxDepenetration, .12);
});

test('continuous footprint sweep catches a thin wall without endpoint sampling', () => {
  const square = packedPolygon([[[1, -1], [2, -1], [2, 1], [1, 1]]]);
  const hit = sweepCircleAgainstFootprint(
    0, 0, 3, 0, .1, 0,
    square.vertices, square.ringOffsets, square.polygonOffsets,
  );
  assert.equal(hit.hit, true);
  assert.ok(Math.abs(hit.time - .3) < 1e-8);
  assert.ok(hit.normalX < -.999);
  assert.ok(Math.abs(hit.normalZ) < 1e-8);
});

test('exact sweep preserves empty corners and courtyard holes', () => {
  const triangle = packedPolygon([[[0, 0], [4, 0], [0, 4]]]);
  assert.equal(circleIntersectsFootprint(3.5, 3.5, .1, 0, triangle.vertices, triangle.ringOffsets, triangle.polygonOffsets), false);
  const emptyCorner = sweepCircleAgainstFootprint(
    3.35, 3.35, .2, .2, .1, 0,
    triangle.vertices, triangle.ringOffsets, triangle.polygonOffsets,
  );
  assert.equal(emptyCorner.hit, false, 'a conservative AABB corner must not become a swept solid');

  const courtyard = packedPolygon([
    [[0, 0], [10, 0], [10, 10], [0, 10]],
    [[3, 3], [3, 7], [7, 7], [7, 3]],
  ]);
  const fromHole = sweepCircleAgainstFootprint(
    5, 5, 4, 0, .2, 0,
    courtyard.vertices, courtyard.ringOffsets, courtyard.polygonOffsets,
  );
  assert.equal(fromHole.hit, true);
  assert.ok(Math.abs(fromHole.time - .45) < 1e-8);
  assert.ok(fromHole.normalX < -.999, 'the hole boundary normal must face the empty courtyard');
});

test('penetration recovery points toward the nearest empty region', () => {
  const square = packedPolygon([[[1, 0], [2, 0], [2, 2], [1, 2]]]);
  const fromInside = circleFootprintPenetration(
    1.01, 1, .1, 0, square.vertices, square.ringOffsets, square.polygonOffsets,
  );
  assert.equal(fromInside.overlap, true);
  assert.ok(Math.abs(fromInside.depth - .11) < 1e-8);
  assert.ok(fromInside.normalX < -.999);

  const fromOutside = circleFootprintPenetration(
    .95, 1, .1, 0, square.vertices, square.ringOffsets, square.polygonOffsets,
  );
  assert.equal(fromOutside.overlap, true);
  assert.ok(Math.abs(fromOutside.depth - .05) < 1e-8);
  assert.ok(fromOutside.normalX < -.999);
});

test('expanded AABB sweep provides a conservative fallback', () => {
  const hit = sweepPointAgainstAabb(0, 0, 4, 0, .9, -1.1, 2.1, 1.1);
  assert.equal(hit.hit, true);
  assert.ok(Math.abs(hit.time - .225) < 1e-8);
  assert.equal(hit.normalX, -1);
  assert.equal(hit.normalZ, 0);
});

test('third-person camera sweep radius is derived from its near-plane footprint', () => {
  const camera = new THREE.PerspectiveCamera(68, 16 / 9, .02, 210);
  const radius = cameraNearPlaneSweepRadius(camera);
  assert.ok(radius >= .03 && radius <= .04);
  camera.aspect = 9 / 16;
  camera.updateProjectionMatrix();
  assert.ok(cameraNearPlaneSweepRadius(camera) <= radius);
});

test('world motion sweeps at speed and slides without axis-order bias', () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} removeEventListener() {} postMessage() {} terminate() {} };
  const world = new GeoWorld(new THREE.Scene(), { latitude: 0, longitude: 0 });
  try {
    const tile = [...world.tiles.values()][0];
    const square = packedPolygon([[[1, 0], [2, 0], [2, 2], [1, 2]]]);
    tile.colliders = new Float32Array([1, 0, 2, 2]);
    tile.collisionVertices = square.vertices;
    tile.collisionRingOffsets = square.ringOffsets;
    tile.collisionPolygonOffsets = square.polygonOffsets;
    tile.collisionSpans = new Float32Array([0, 2]);
    tile.collisionMasks = new Uint16Array([GEO_BUILDING_QUERY_MASK]);
    tile.collisionGrid = buildCollisionGrid(tile.colliders);

    const motion = world.moveCircle(0, .5, 2, 1, .1, 0, 2, {});
    assert.equal(motion.hit, true);
    assert.equal(motion.contacts, 1);
    assert.ok(motion.x > .899 && motion.x < .9, 'circle should stop just before the visible wall');
    assert.ok(Math.abs(motion.z - 1.5) < 2e-4, 'tangential displacement should be preserved apart from contact skin');
    assert.ok(Math.abs(motion.projectedX) < 1e-8);
    assert.equal(motion.projectedZ, 1);

    const fast = world.moveCircle(0, .5, 20, 0, .1, 0, 2, {});
    assert.equal(fast.hit, true);
    assert.ok(fast.x < .9, 'a complete high-speed delta must not tunnel through the footprint');

    const recovered = world.moveCircle(.95, 1, -.2, 0, .1, 0, 2, {}, .12);
    assert.equal(recovered.depenetrated, true);
    assert.ok(recovered.x < .7, 'a shallow overlap should recover and continue toward empty space');
    const bounded = world.depenetrateCircle(1.5, 1, .1, .12, 2, {});
    assert.ok(bounded.moved <= .120001, 'deep recovery must never exceed its hard distance cap');

    const side = world.sweepSphere(0, .5, .5, 3, 0, 0, .1, {});
    assert.equal(side.hit, true);
    assert.ok(Math.abs(side.time - .3) < 1e-8);
    const above = world.sweepSphere(0, 3, .5, 3, 0, 0, .1, {});
    assert.equal(above.hit, false, 'camera motion above the packed vertical span must remain clear');
    const roof = world.sweepSphere(1.5, 3, 1, 0, -3, 0, .1, {});
    assert.equal(roof.hit, true);
    assert.ok(Math.abs(roof.time - .3) < 1e-8);
    assert.equal(roof.normalY, 1);

    tile.collisionMasks[0] = GEO_QUERY_MASK.PLACEMENT;
    assert.equal(world.sweepSphere(0, .5, .5, 3, 0, 0, .1, {}).hit, false,
      'placement-only proxies must not obstruct the camera');
  } finally {
    world.dispose();
    globalThis.Worker = originalWorker;
  }
});
