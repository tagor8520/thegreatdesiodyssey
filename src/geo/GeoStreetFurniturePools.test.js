import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GEO_STREET_FURNITURE_POOL_LIMITS,
  StreetFurniturePools,
} from './GeoStreetFurniturePools.js';

function placements(...records) {
  return new Float32Array(records.flat());
}

function createPool() {
  const scene = new THREE.Scene();
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  const pool = new StreetFurniturePools(scene, { material, terrainSeed: 17 });
  return { scene, material, pool };
}

test('DET-05 global family pools repack stable source owners without per-tile draws', () => {
  const { scene, material, pool } = createPool();
  try {
    const first = placements(
      [10, 10, 1, 0, 0, 30],
      [12, 10, .95, 1, 0, 10],
    );
    const second = placements(
      [20, 20, 1, 0, Math.PI, 20],
      [24, 20, 1, 3, 0, 40],
    );
    assert.equal(pool.addOwner('tile:b', second), 2);
    assert.equal(pool.addOwner('tile:a', first), 2);
    const fingerprint = pool.fingerprint();
    assert.equal(pool.diagnostics.owners, 2);
    assert.equal(pool.diagnostics.entries, 4);
    assert.equal(pool.diagnostics.activeDrawPools, 3);
    assert.ok(pool.diagnostics.activeDrawPools <= GEO_STREET_FURNITURE_POOL_LIMITS.maxAddedDrawCalls);
    assert.ok(pool.diagnostics.visibleTriangles > 0);
    assert.ok(pool.diagnostics.gpuBytes <= GEO_STREET_FURNITURE_POOL_LIMITS.maxGpuBytes);
    assert.equal(pool.diagnostics.steadyFrameMatrixUpdates, 0);
    assert.equal(pool.group.parent, scene);
    assert.ok(pool.meshes.every(mesh => mesh.userData.visualOnly));

    assert.equal(pool.removeOwner('tile:a'), true);
    assert.equal(pool.diagnostics.entries, 2);
    pool.addOwner('tile:a', first);
    assert.equal(pool.fingerprint(), fingerprint, 'remount must reproduce global pool membership');
    assert.ok(pool.snapshot().records.every(record => record.owner === 'tile:a' || record.owner === 'tile:b'));
  } finally {
    pool.dispose();
    material.dispose();
  }
});

test('DET-05 pool entry, draw, triangle, GPU, and malformed caps reject atomically', () => {
  const { material, pool } = createPool();
  try {
    assert.throws(() => pool.addOwner('bad', placements([1, 2, 1, 99, 0, 1])), TypeError);
    assert.equal(pool.diagnostics.entries, 0);
    const records = [];
    for (let index = 0; index <= GEO_STREET_FURNITURE_POOL_LIMITS.maxEntries; index++) {
      records.push([index, 3, 1, 0, 0, index]);
    }
    assert.throws(() => pool.addOwner('over-cap', placements(...records)), RangeError);
    assert.equal(pool.diagnostics.owners, 0);
    assert.equal(pool.diagnostics.entries, 0);

    const scene = new THREE.Scene();
    const drawLimited = new StreetFurniturePools(scene, {
      material,
      limits: { ...GEO_STREET_FURNITURE_POOL_LIMITS, maxAddedDrawCalls: 1 },
    });
    assert.throws(() => drawLimited.addOwner('draws', placements(
      [1, 1, 1, 0, 0, 1], [2, 2, 1, 1, 0, 2],
    )), RangeError);
    assert.equal(drawLimited.diagnostics.entries, 0);
    drawLimited.dispose();

    const triangleLimited = new StreetFurniturePools(scene, {
      material,
      limits: { ...GEO_STREET_FURNITURE_POOL_LIMITS, maxVisibleTriangles: 1 },
    });
    assert.throws(() => triangleLimited.addOwner('triangles', placements([1, 1, 1, 0, 0, 1])), RangeError);
    assert.equal(triangleLimited.diagnostics.entries, 0);
    triangleLimited.dispose();

    assert.throws(() => new StreetFurniturePools(scene, {
      material,
      limits: { ...GEO_STREET_FURNITURE_POOL_LIMITS, maxGpuBytes: 1 },
    }), /GPU cap/);
  } finally {
    pool.dispose();
    material.dispose();
  }
});

test('DET-05 context restoration reuploads matrices and disposal releases every shared geometry', () => {
  const { scene, material, pool } = createPool();
  let geometryDisposals = 0;
  for (const geometry of pool.geometries) geometry.addEventListener('dispose', () => geometryDisposals++);
  pool.addOwner('tile', placements([8, 9, 1, 4, .25, 1]));
  const uploads = pool.diagnostics.matrixUploads;
  assert.equal(pool.handleContextRestored(), true);
  assert.equal(pool.diagnostics.contextRestorations, 1);
  assert.equal(pool.diagnostics.matrixUploads, uploads + pool.meshes.length);
  pool.dispose();
  assert.equal(geometryDisposals, pool.geometries.length);
  assert.equal(pool.group.parent, null);
  assert.equal(scene.children.includes(pool.group), false);
  assert.equal(pool.diagnostics.disposed, true);
  assert.equal(pool.handleContextRestored(), false);
  material.dispose();
});
