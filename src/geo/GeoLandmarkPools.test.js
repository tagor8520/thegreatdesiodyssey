import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LandmarkPools, GEO_LANDMARK_POOL_LIMITS } from './GeoLandmarkPools.js';
import { GDO_LANDMARK_NAMESPACE, GEO_LANDMARK_FORM } from './GeoLandmarkGrammar.js';

const HERO_TRIANGLES = 480;
const OWNER_BYTES = 4_096;

function heroDescriptor(overrides = {}) {
  return Object.freeze({
    namespace: GDO_LANDMARK_NAMESPACE,
    id: 'tile:0:building:1:landmark',
    form: GEO_LANDMARK_FORM.GATE,
    formSource: 'mapped-signal',
    boxes: 40,
    triangles: HERO_TRIANGLES,
    bytes: 40_320,
    hiddenFaces: 12,
    containedBoxes: 0,
    openings: 2,
    passableOpenings: 1,
    structuralCompounds: 8,
    enclosingCompounds: 0,
    ...overrides,
  });
}

function compound(minimumX, minimumY, minimumZ, size = .4) {
  return Object.freeze([
    minimumX, minimumY, minimumZ,
    minimumX + size, minimumY + size, minimumZ + size,
  ]);
}

function tileGeometry({ triangles = HERO_TRIANGLES } = {}) {
  const vertices = triangles * 3;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 3);
  const indices = new Uint32Array(vertices);
  for (let index = 0; index < vertices; index++) {
    positions[index * 3] = index % 7;
    normals[index * 3 + 1] = 1;
    colors[index * 3] = .5;
    indices[index] = index;
  }
  return { positions, normals, colors, indices };
}

function ownerPayload(overrides = {}) {
  return {
    geometry: { ...tileGeometry(), bytes: OWNER_BYTES },
    heroes: [heroDescriptor()],
    compounds: [compound(0, 0, 0), compound(1, 0, 0)],
    ...overrides,
  };
}

test('DET-09 landmark pool mounts one merged mesh per owner and reports its budgets', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  const pools = new LandmarkPools(scene, { material, renderOrder: 3 });
  try {
    assert.equal(pools.diagnostics.namespace, GDO_LANDMARK_NAMESPACE);
    assert.equal(pools.diagnostics.owners, 0);
    assert.equal(pools.addOwner('tile:0', ownerPayload()), 40);
    const entry = pools.owners.get('tile:0');
    assert.equal(entry.mesh.userData.visualOnly, true, 'a hero never carries collision of its own');
    assert.equal(entry.mesh.userData.geoLayer, 'landmark');
    assert.equal(entry.mesh.renderOrder, 3);
    assert.equal(entry.mesh.material, material);
    assert.ok(entry.mesh.geometry.index instanceof THREE.BufferAttribute);
    assert.equal(pools.group.children.length, 1, 'one hero is one merged mesh');
    assert.equal(pools.diagnostics.heroes, 1);
    assert.equal(pools.diagnostics.boxes, 40);
    assert.equal(pools.diagnostics.residentTriangles, HERO_TRIANGLES);
    assert.equal(pools.diagnostics.openings, 2);
    assert.equal(pools.diagnostics.passableOpenings, 1);
    assert.equal(pools.diagnostics.structuralCompounds, 2);
    assert.equal(pools.diagnostics.enclosingCompounds, 0);
    assert.equal(pools.diagnostics.steadyFrameMatrixUpdates, 0);
    assert.throws(() => new LandmarkPools(scene, {}), TypeError);
    assert.throws(() => new LandmarkPools({}, { material }), TypeError);
    assert.throws(() => new LandmarkPools(scene, { material, limits: { maxOwners: 0 } }), RangeError);
    assert.throws(() => pools.addOwner('', ownerPayload()), TypeError);
  } finally {
    pools.dispose(); material.dispose();
  }
});

test('DET-09 a malformed hero is rejected before any geometry is mounted', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial();
  const pools = new LandmarkPools(scene, { material });
  try {
    const misaligned = tileGeometry();
    misaligned.normals = new Float32Array(misaligned.positions.length - 1);
    assert.throws(() => pools.addOwner('tile:0', ownerPayload({ geometry: misaligned })), RangeError);
    const outOfRange = tileGeometry();
    outOfRange.indices = new Uint32Array([0, 1, 9_999]);
    assert.throws(() => pools.addOwner('tile:0', ownerPayload({ geometry: outOfRange })), RangeError);
    assert.throws(() => pools.addOwner('tile:0', ownerPayload({ geometry: { positions: new Float32Array(3) } })),
      TypeError);
    assert.throws(() => pools.addOwner('tile:0', ownerPayload({
      heroes: [{ ...heroDescriptor(), namespace: 'gdo:other:v1' }],
    })), TypeError);
    assert.throws(() => pools.addOwner('tile:0', ownerPayload({
      heroes: [{ ...heroDescriptor(), boxes: 0 }],
    })), TypeError);
    assert.throws(() => pools.addOwner('tile:0', ownerPayload({
      heroes: [{ ...heroDescriptor(), structuralCompounds: -1 }],
    })), TypeError);
    assert.throws(() => pools.addOwner('tile:0', ownerPayload({
      heroes: [heroDescriptor(), heroDescriptor({ id: 'second' })],
    })), RangeError);
    assert.throws(() => pools.addOwner('tile:0', ownerPayload({ compounds: [[0, 0, 0, 0, 1, 1]] })), TypeError);
    assert.throws(() => pools.addOwner('tile:0', ownerPayload({ compounds: [[0, 0, 0]] })), TypeError);
    assert.equal(pools.owners.size, 0, 'nothing may be mounted after a rejection');
    assert.equal(scene.children.length, 1, 'only the empty pool group was ever added');
  } finally {
    pools.dispose(); material.dispose();
  }
});

test('DET-09 resident caps fire before mutation and replacing an owner never stacks meshes', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial();
  const pools = new LandmarkPools(scene, { material });
  try {
    for (let index = 0; index < GEO_LANDMARK_POOL_LIMITS.maxOwners; index++) {
      pools.addOwner(`tile:${index}`, ownerPayload());
    }
    assert.equal(pools.owners.size, GEO_LANDMARK_POOL_LIMITS.maxOwners);
    assert.throws(() => pools.addOwner('tile:overflow', ownerPayload()), RangeError);
    assert.equal(pools.diagnostics.capEvents.owners, true);
    assert.equal(pools.owners.size, GEO_LANDMARK_POOL_LIMITS.maxOwners);
    // A hero too large to ever be visible is rejected whole, never clipped.
    const oversized = ownerPayload({ geometry: { ...tileGeometry({
      triangles: GEO_LANDMARK_POOL_LIMITS.maxVisibleTriangles + 1,
    }), bytes: OWNER_BYTES } });
    assert.equal(pools.removeOwner('tile:0'), true);
    assert.throws(() => pools.addOwner('tile:big', oversized), RangeError);
    assert.equal(pools.diagnostics.capEvents.triangles, true);
    assert.equal(pools.owners.size, GEO_LANDMARK_POOL_LIMITS.maxOwners - 1);
    // Re-adding a resident owner swaps geometry instead of stacking a second mesh.
    const resident = pools.owners.size;
    pools.addOwner('tile:1', ownerPayload({ heroes: [heroDescriptor({ boxes: 12, triangles: 144 })] }));
    assert.equal(pools.owners.size, resident);
    assert.equal(pools.group.children.length, pools.owners.size);
    assert.equal(pools.diagnostics.boxes, 12 + 40 * (GEO_LANDMARK_POOL_LIMITS.maxOwners - 2));
    assert.equal(pools.diagnostics.gpuBytes, OWNER_BYTES * pools.owners.size);
  } finally {
    pools.dispose(); material.dispose();
  }
});

test('DET-09 only the focused owner draws, and eviction releases its geometry', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial();
  const pools = new LandmarkPools(scene, { material });
  try {
    pools.addOwner('tile:0', ownerPayload());
    pools.addOwner('tile:1', ownerPayload({ heroes: [heroDescriptor({ id: 'second' })] }));
    assert.equal(pools.diagnostics.addedDrawCalls, 0, 'nothing draws before a focus exists');
    assert.equal(pools.setFocus('tile:1'), true);
    assert.equal(pools.diagnostics.addedDrawCalls, 1);
    assert.equal(pools.diagnostics.visibleTriangles, HERO_TRIANGLES);
    assert.equal(pools.owners.get('tile:1').mesh.visible, true);
    assert.equal(pools.owners.get('tile:0').mesh.visible, false);
    assert.equal(pools.setFocus('tile:1'), false, 'an unchanged focus writes nothing');
    pools.setFocus('tile:0');
    assert.equal(pools.diagnostics.addedDrawCalls, 1, 'the hero still costs exactly one draw call');
    assert.ok(pools.diagnostics.visibilityWrites >= 3);
    let disposals = 0;
    pools.owners.get('tile:1').mesh.geometry.addEventListener('dispose', () => disposals++);
    assert.equal(pools.removeOwner('tile:1'), true);
    assert.equal(disposals, 1, 'eviction releases the merged geometry');
    assert.equal(pools.owners.size, 1);
    assert.equal(pools.diagnostics.addedDrawCalls, 1);
    assert.equal(pools.removeOwner('tile:missing'), false);
    assert.equal(pools.handleContextRestored(), true);
    assert.equal(pools.diagnostics.contextRestorations, 1);
    pools.dispose();
    assert.equal(pools.owners.size, 0);
    assert.equal(pools.group.children.length, 0);
    assert.equal(pools.diagnostics.disposed, true);
    assert.throws(() => pools.addOwner('tile:2', ownerPayload()), Error);
    assert.equal(pools.removeOwner('tile:0'), false);
    assert.equal(pools.dispose(), undefined, 'dispose is idempotent');
  } finally {
    material.dispose();
  }
});

test('DET-09 pool snapshot, fingerprint, and compounds stay per-module tight', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial();
  const pools = new LandmarkPools(scene, { material });
  try {
    pools.addOwner('tile:1', ownerPayload());
    const snapshot = pools.snapshot();
    assert.equal(snapshot.namespace, GDO_LANDMARK_NAMESPACE);
    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.records[0].form, GEO_LANDMARK_FORM.GATE);
    assert.equal(snapshot.records[0].enclosingCompounds, 0);
    const fingerprint = pools.fingerprint();
    assert.match(fingerprint, /^[0-9a-f]{8}$/);
    assert.equal(pools.fingerprint(), fingerprint, 'the fingerprint is stable while residents are');
    const compounds = pools.compounds();
    assert.equal(compounds.length, 2);
    assert.ok(compounds.every(item => item.owner === 'tile:1' && item.structural === true));
    const extent = item => Math.hypot(item.maximumX - item.minimumX,
      item.maximumY - item.minimumY, item.maximumZ - item.minimumZ);
    // No compound may be one enclosing AABB: the resident spread is strictly
    // larger than the largest single module.
    const union = compounds.reduce((total, item) => ({
      minimumX: Math.min(total.minimumX, item.minimumX), maximumX: Math.max(total.maximumX, item.maximumX),
      minimumY: Math.min(total.minimumY, item.minimumY), maximumY: Math.max(total.maximumY, item.maximumY),
      minimumZ: Math.min(total.minimumZ, item.minimumZ), maximumZ: Math.max(total.maximumZ, item.maximumZ),
    }), compounds[0]);
    assert.ok(extent(union) > pools.diagnostics.maximumCompoundExtent * 1.5);
    assert.ok(pools.diagnostics.maximumCompoundExtent < extent(union));
    assert.ok(pools.diagnostics.narrowestCompoundExtent > 0);
    pools.addOwner('tile:0', ownerPayload({ heroes: [heroDescriptor({ id: 'other' })] }));
    assert.notEqual(pools.fingerprint(), fingerprint);
    assert.equal(pools.diagnostics.compounds, 4);
    assert.equal(pools.diagnostics.enclosingCompounds, 0);
  } finally {
    pools.dispose(); material.dispose();
  }
});
