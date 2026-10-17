import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  BridgePools,
  createBridgeGeometries,
  GEO_BRIDGE_POOL_LIMITS,
} from './GeoBridgePools.js';
import { bridgeCorridorHalfWidth } from './GeoBridgeGrammar.js';
import {
  GDO_BRIDGE_NAMESPACE,
  GEO_BRIDGE_FAMILY,
  GEO_BRIDGE_FAMILY_NAMES,
  GEO_BRIDGE_FIELD,
  GEO_BRIDGE_LIMITS,
  GEO_BRIDGE_STRIDE,
  compileBridges,
} from './GeoBridgeGrammar.js';
import { terrainHeightAt } from './GeoTerrain.js';
import { transportSurfaceY } from './GeoLayers.js';

const request = Object.freeze({
  tileX: 0, tileY: 0, originX: 0, originY: 0, tileSize: 100, terrainSeed: 7,
});

function feature(points, properties = {}) {
  return Object.freeze({
    type: 2,
    extent: 100,
    properties: Object.freeze({ class: 'primary', brunnel: 'bridge', ...properties }),
    loadGeometry: () => [points.map(([x, y]) => Object.freeze({ x, y }))],
  });
}

function layer(...features) {
  return Object.freeze({ length: features.length, feature: index => features[index] });
}

function compile(features) {
  return compileBridges({ layers: { transportation: layer(...features) } }, request);
}

function scene() { return new THREE.Scene(); }

function pools(extra = {}) {
  return new BridgePools(scene(), {
    material: new THREE.MeshBasicMaterial(),
    renderOrder: 30,
    ...extra,
  });
}

function record(x, y, z, family, {
  length = 0, width = 0, height = 0, yaw = 0, pitch = 0, level = 1, stableId = 1,
} = {}) {
  const values = new Float32Array(GEO_BRIDGE_STRIDE);
  values[GEO_BRIDGE_FIELD.X] = x;
  values[GEO_BRIDGE_FIELD.Y] = y;
  values[GEO_BRIDGE_FIELD.Z] = z;
  values[GEO_BRIDGE_FIELD.LENGTH] = length;
  values[GEO_BRIDGE_FIELD.WIDTH] = width;
  values[GEO_BRIDGE_FIELD.HEIGHT] = height;
  values[GEO_BRIDGE_FIELD.YAW] = yaw;
  values[GEO_BRIDGE_FIELD.PITCH] = pitch;
  values[GEO_BRIDGE_FIELD.FAMILY] = family;
  values[GEO_BRIDGE_FIELD.LEVEL] = level;
  values[GEO_BRIDGE_FIELD.STABLE_ID] = stableId;
  return values;
}

function recordsOf(values) {
  const records = [];
  for (let offset = 0; offset < values.length; offset += GEO_BRIDGE_STRIDE) {
    records.push(Object.fromEntries(Object.entries(GEO_BRIDGE_FIELD)
      .map(([name, index]) => [name.toLowerCase(), values[offset + index]])));
  }
  return records;
}

test('DET-08 pools mount one fixed family draw per module family with no per-module geometry', () => {
  const geometries = createBridgeGeometries();
  assert.equal(geometries.length, GEO_BRIDGE_FAMILY_NAMES.length);
  assert.deepEqual(geometries.map(geometry => geometry.userData.bridgeFamily),
    GEO_BRIDGE_FAMILY_NAMES.map((_, family) => family));
  const first = geometries.map(geometry => geometry.index.count);
  const second = createBridgeGeometries().map(geometry => geometry.index.count);
  assert.deepEqual(second, first, 'fixed archetypes are recompiled deterministically');
  for (const geometry of [...geometries, ...createBridgeGeometries()]) geometry.dispose();

  const bridge = pools();
  const result = compile([feature([[10, 50], [90, 50]])]);
  assert.equal(bridge.addOwner('tile:0:0', result.placements, result.stride), result.meta.placements);
  assert.equal(bridge.entries, result.meta.placements);
  assert.equal(bridge.meshes.length, 7);
  assert.ok(bridge.meshes.every(mesh => mesh.name.startsWith('bridge:')));
  assert.ok(bridge.meshes.every(mesh => mesh.userData.visualOnly === true));
  // Only the families present in the payload are drawn.
  assert.equal(bridge.diagnostics.activeDrawPools, result.meta.familyCounts.filter(Boolean).length);
  assert.equal(bridge.diagnostics.addedDrawCalls, bridge.diagnostics.activeDrawPools);
  assert.ok(bridge.diagnostics.visibleTriangles > 0);
  assert.ok(bridge.diagnostics.visibleTriangles <= GEO_BRIDGE_POOL_LIMITS.maxVisibleTriangles);
  assert.ok(bridge.diagnostics.gpuBytes <= GEO_BRIDGE_POOL_LIMITS.maxGpuBytes);
  assert.equal(bridge.diagnostics.steadyFrameMatrixUpdates, 0);

  // Instance transforms reproduce the self-describing record exactly.
  const railSpan = recordsOf(result.placements).find(record => record.family === GEO_BRIDGE_FAMILY.RAIL_SPAN);
  const mesh = bridge.meshes[GEO_BRIDGE_FAMILY.RAIL_SPAN];
  const matrix = new THREE.Matrix4();
  let matched = null;
  for (let index = 0; index < mesh.count; index++) {
    mesh.getMatrixAt(index, matrix);
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    if (Math.abs(position.x - railSpan.x) < 1e-4 && Math.abs(position.z - railSpan.z) < 1e-4) matched = matrix;
  }
  assert.ok(matched, 'rail span instance must exist at its recorded deck frame');
  const scale = new THREE.Vector3().setFromMatrixScale(matched);
  assert.ok(Math.abs(scale.x - railSpan.length) < 1e-4, 'long rail segments scale along the deck axis');
  assert.ok(Math.abs(scale.z - 1) < 1e-6, 'rail cross-section stays rigid');
  assert.ok(Math.abs(scale.y - 1) < 1e-6);
  assert.ok(Math.abs((railSpan.length === 0 ? 1 : railSpan.length) - 80) < 1e-4);
  bridge.dispose();
  assert.equal(bridge.disposed, true);
  assert.equal(bridge.group.parent, null);
});

test('DET-08 pool repacks stable source owners, remounts byte-identically, and refills exactly', () => {
  const bridge = pools();
  const first = compile([feature([[10, 20], [90, 20]])]);
  const second = compile([feature([[10, 76], [90, 76]])]);
  bridge.addOwner('tile:b', second.placements, second.stride);
  bridge.addOwner('tile:a', first.placements, first.stride);
  const fingerprint = bridge.fingerprint();
  assert.equal(bridge.diagnostics.owners, 2);
  const firstSnapshot = JSON.stringify(bridge.snapshot());

  // Replacement with an equivalent payload is byte-stable, and the pool never
  // keeps a stale owner after eviction.
  bridge.addOwner('tile:a', first.placements, first.stride);
  assert.equal(bridge.fingerprint(), fingerprint);
  assert.equal(bridge.removeOwner('tile:a'), true);
  assert.equal(bridge.removeOwner('tile:a'), false);
  assert.equal(bridge.diagnostics.owners, 1);
  bridge.addOwner('tile:a', first.placements, first.stride);
  assert.equal(JSON.stringify(bridge.snapshot()), firstSnapshot);
  assert.equal(bridge.fingerprint(), fingerprint);

  // A fresh pool rebuilt in a different owner order must reproduce the same bytes.
  const remount = pools();
  remount.addOwner('tile:a', first.placements, first.stride);
  remount.addOwner('tile:b', second.placements, second.stride);
  assert.equal(remount.fingerprint(), fingerprint);
  assert.deepEqual(remount.diagnostics.familyCounts, bridge.diagnostics.familyCounts);

  // Context restoration re-uploads every retained matrix without new geometry.
  const sourceGeometries = bridge.diagnostics.sourceGeometries;
  assert.equal(bridge.handleContextRestored(), true);
  assert.equal(bridge.diagnostics.contextRestorations, 1);
  assert.equal(bridge.diagnostics.sourceGeometries, sourceGeometries);
  bridge.handleContextRestored();
  bridge.dispose();
  assert.equal(bridge.handleContextRestored(), false);
  assert.equal(bridge.removeOwner('tile:b'), false);
  assert.equal(remount.handleContextRestored(), true);
  remount.dispose();
});

test('DET-08 compounds stay tight per module and never cover the walkable deck corridor', () => {
  const bridge = pools();
  const result = compile([feature([[10, 50], [90, 50]])]);
  bridge.addOwner('tile:0:0', result.placements, result.stride);
  const compounds = bridge.compounds();
  const deckOffset = transportSurfaceY(1);
  assert.ok(compounds.length > 0);
  assert.ok(compounds.length <= GEO_BRIDGE_POOL_LIMITS.maxCompounds);
  assert.ok(compounds.every(compound => compound.owner === 'tile:0:0'));
  assert.ok(compounds.every(compound => compound.structural === true));

  // Rails become long, thin compounds at the deck edge, not a bridge-wide box.
  const rails = compounds.filter(compound => compound.kind === 'rail');
  assert.equal(rails.length, 2);
  const deckByStableId = new Map(recordsOf(result.placements)
    .filter(record => record.family === GEO_BRIDGE_FAMILY.RAIL_SPAN)
    .map(record => [record.stable_id, record]));
  for (const rail of rails) {
    const width = Math.min(rail.maxX - rail.minX, rail.maxZ - rail.minZ);
    const length = Math.max(rail.maxX - rail.minX, rail.maxZ - rail.minZ);
    assert.ok(length > 70, 'a rail compound spans the full span');
    assert.ok(width < .2, 'a rail compound is a thin edge band');
    // The compound sits above its own authoritative deck top, so it can never
    // trap the player inside the deck it belongs to.
    const deck = deckByStableId.get(rail.stableId);
    assert.ok(deck, 'every rail compound traces back to one deck-frame record');
    assert.ok(rail.minY >= deck.y + .011, 'rail band starts above the walkable deck surface');
    assert.ok(Math.hypot(rail.minX - deck.x, rail.minZ - deck.z) <= deck.length / 2 + .05);
  }
  // Piers land on real terrain support below the deck.
  const piers = compounds.filter(compound => compound.kind === 'pier');
  const pierRecords = new Map(recordsOf(result.placements)
    .filter(entry => entry.family === GEO_BRIDGE_FAMILY.PIER)
    .map(entry => [entry.stable_id, entry]));
  assert.equal(piers.length, result.meta.piers);
  assert.equal(piers.length, pierRecords.size);
  for (const pier of piers) {
    const source = pierRecords.get(pier.stableId);
    assert.ok(source, 'every pier compound traces back to one deck-frame record');
    assert.ok(Math.abs(pier.maxY - source.y) < 1e-3, 'the pier head meets the deck underside');
    assert.ok(Math.abs(pier.minY - (source.y - source.height)) < 1e-3, 'the pier reaches its measured support');
    assert.ok(Math.abs(pier.minY - terrainHeightAt(source.x, source.z, request.terrainSeed)) < .02);
    assert.ok(pier.maxX - pier.minX < .2 && pier.maxZ - pier.minZ < .2, 'pier compounds are tight');
  }
  // The corridor between the two rail compounds stays open: the gate forbids
  // one enclosing AABB, so a walkable gap must survive across the deck width.
  const [left, right] = rails.slice().sort((first, second) => first.minZ - second.minZ);
  assert.ok(right.minZ - left.maxZ > 0, 'left and right rail compounds never merge');
  assert.ok(right.minZ - left.maxZ >= bridgeCorridorHalfWidth(.5) * 2 - .05, 'the deck corridor stays clear');
  assert.ok(compounds.length >= 3, 'a bridge is several tight compounds, never one box');
  assert.ok(bridge.diagnostics.narrowestCompoundExtent <= bridge.diagnostics.maximumCompoundExtent);
  assert.equal(bridge.diagnostics.compounds, compounds.length);
  assert.equal(bridge.diagnostics.structuralCompounds, compounds.length);
  bridge.dispose();
});

test('DET-08 pool caps reject atomically and malformed records never reach the scene', () => {
  const bridge = pools();
  const result = compile([feature([[10, 50], [90, 50]])]);
  assert.equal(bridge.addOwner('tile:a', result.placements, result.stride), result.meta.placements);

  // A non-aligned, non-finite, or unknown-family payload is rejected outright.
  assert.throws(() => bridge.addOwner('tile:bad', new Float32Array(3), GEO_BRIDGE_STRIDE), /aligned Float32 data/);
  assert.throws(() => bridge.addOwner('tile:bad', result.placements, 6), /aligned Float32 data/);
  const nan = record(1, 1, 1, GEO_BRIDGE_FAMILY.RAIL_SPAN);
  nan[GEO_BRIDGE_FIELD.Y] = Number.NaN;
  assert.throws(() => bridge.addOwner('tile:bad', nan, GEO_BRIDGE_STRIDE), /malformed/);
  const badFamily = record(1, 1, 1, 99);
  assert.throws(() => bridge.addOwner('tile:bad', badFamily, GEO_BRIDGE_STRIDE), /malformed/);
  const badLevel = record(1, 1, 1, GEO_BRIDGE_FAMILY.PIER);
  badLevel[GEO_BRIDGE_FIELD.LEVEL] = 0;
  assert.throws(() => bridge.addOwner('tile:bad', badLevel, GEO_BRIDGE_STRIDE), /malformed/);
  const badPitch = record(1, 1, 1, GEO_BRIDGE_FAMILY.RAIL_SPAN);
  badPitch[GEO_BRIDGE_FIELD.PITCH] = Math.PI;
  assert.throws(() => bridge.addOwner('tile:bad', badPitch, GEO_BRIDGE_STRIDE), /malformed/);
  const duplicate = new Float32Array([
    ...record(1, 1, 1, GEO_BRIDGE_FAMILY.RAIL_SPAN, { length: 1, stableId: 5 }),
    ...record(2, 1, 2, GEO_BRIDGE_FAMILY.RAIL_SPAN, { length: 1, stableId: 5 }),
  ]);
  assert.throws(() => bridge.addOwner('tile:bad', duplicate, GEO_BRIDGE_STRIDE), /unique per owner/);
  // Failed owners leave no state behind.
  assert.equal(bridge.diagnostics.owners, 1);
  assert.equal(bridge.entries, result.meta.placements);

  // Too many owners, and an over-ceiling entry payload, both fail closed.
  assert.equal(bridge.addOwner('tile:b', result.placements, result.stride), result.meta.placements);
  assert.equal(bridge.addOwner('tile:c', result.placements, result.stride), result.meta.placements);
  assert.equal(bridge.addOwner('tile:d', result.placements, result.stride), result.meta.placements);
  assert.throws(() => bridge.addOwner('tile:e', result.placements, result.stride), /cap exceeded/);
  const oversized = new Float32Array((GEO_BRIDGE_POOL_LIMITS.maxEntries + 1) * GEO_BRIDGE_STRIDE);
  for (let index = 0; index <= GEO_BRIDGE_POOL_LIMITS.maxEntries; index++) {
    oversized.set(record(index, 1, index, GEO_BRIDGE_FAMILY.RAIL_POST, { stableId: index }),
      index * GEO_BRIDGE_STRIDE);
  }
  bridge.removeOwner('tile:b');
  bridge.removeOwner('tile:c');
  bridge.removeOwner('tile:d');
  assert.throws(() => bridge.addOwner('tile:big', oversized, GEO_BRIDGE_STRIDE), /cap exceeded/);
  assert.equal(bridge.diagnostics.capEvents.entries, true);
  // An empty payload deletes its owner instead of retaining an empty entry.
  assert.equal(bridge.addOwner('tile:a', new Float32Array(), GEO_BRIDGE_STRIDE), 0);
  assert.equal(bridge.diagnostics.owners, 0);
  assert.equal(bridge.entries, 0);
  assert.ok(bridge.meshes.every(mesh => mesh.count === 0));
  bridge.dispose();
  assert.throws(() => bridge.addOwner('tile:a', result.placements, result.stride), /disposed/);
});

test('DET-08 rejects invalid configuration and a fixed GPU budget it cannot meet', () => {
  assert.throws(() => new BridgePools(null, {}), /requires a scene and a shared material/);
  assert.throws(() => new BridgePools(scene(), { material: {} }), /requires a scene and a shared material/);
  const material = new THREE.MeshBasicMaterial();
  assert.throws(() => new BridgePools(scene(), { material, limits: { maxOwners: 0 } }), /Invalid bridge pool limits/);
  assert.throws(() => new BridgePools(scene(), {
    material,
    limits: { ...GEO_BRIDGE_POOL_LIMITS, maxFamilies: GEO_BRIDGE_FAMILY_NAMES.length - 1 },
  }), /Invalid bridge pool limits/);
  assert.throws(() => new BridgePools(scene(), {
    material,
    limits: { ...GEO_BRIDGE_POOL_LIMITS, maxGpuBytes: 1_024 },
  }), /fixed GPU cap exceeded/);
  // A partial family set is still compiled from the same fixed recipes.
  assert.equal(GEO_BRIDGE_LIMITS.maxPlacementsPerTile, GEO_BRIDGE_POOL_LIMITS.maxEntries);
  assert.equal(GDO_BRIDGE_NAMESPACE, 'gdo:bridgeGrammar:v1');
  // Every module family is renderable from the self-describing stream.
  const bridge = pools();
  const everyFamily = new Float32Array(GEO_BRIDGE_FAMILY_NAMES.length * GEO_BRIDGE_STRIDE);
  for (let family = 0; family < GEO_BRIDGE_FAMILY_NAMES.length; family++) {
    everyFamily.set(record(family * 2, 1, 0, family, {
      length: family === GEO_BRIDGE_FAMILY.RAIL_SPAN ? 3 : 0,
      width: family === GEO_BRIDGE_FAMILY.DECK_SIDE ? 1 : 0,
      height: family === GEO_BRIDGE_FAMILY.PIER ? .3 : 0,
      stableId: family,
    }), family * GEO_BRIDGE_STRIDE);
  }
  assert.equal(bridge.addOwner('tile:0:0', everyFamily, GEO_BRIDGE_STRIDE), 7);
  assert.equal(bridge.diagnostics.activeDrawPools, GEO_BRIDGE_FAMILY_NAMES.length);
  assert.ok(bridge.meshes.every(mesh => mesh.count === 1));
  assert.deepEqual(bridge.diagnostics.familyCounts, Array(7).fill(1));
  assert.equal(bridge.diagnostics.railCompounds, 1);
  assert.equal(bridge.diagnostics.pierCompounds, 1);
  // The unreachable-pier rule keeps short openings visual-only.
  const shortPier = record(30, 1, 0, GEO_BRIDGE_FAMILY.PIER, {
    height: GEO_BRIDGE_LIMITS.minStructuralClearance - .01, stableId: 40,
  });
  bridge.removeOwner('tile:0:0');
  bridge.addOwner('tile:0:0', shortPier, GEO_BRIDGE_STRIDE);
  assert.equal(bridge.compounds().length, 0, 'a low, unreachable pier is not a structural compound');
  assert.equal(bridge.diagnostics.entries, 1);
  bridge.dispose();
});
