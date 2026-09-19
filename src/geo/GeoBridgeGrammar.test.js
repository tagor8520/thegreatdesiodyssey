import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from './GeoWorld.js';
import { compileGeoFixture } from './GeoFixtures.js';
import {
  GDO_BRIDGE_GRAMMAR_NAMESPACE,
  GEO_BRIDGE_LIMITS,
  bridgeGrammarRecipes,
  compileBridgeGrammar,
} from './GeoBridgeGrammar.js';
import { circleIntersectsFootprint } from './GeoCollision.js';

const request = Object.freeze({
  tileX: 0, tileY: 0, originX: 0, originY: 0, tileSize: 100, terrainSeed: 17,
});
const point = (x, y) => Object.freeze({ x, y });
function roadFeature(points, properties = { class: 'primary', bridge: true, layer: 1 }) {
  const geometry = [points.map(([x, y]) => point(x, y))];
  return Object.freeze({ type: 2, extent: 100, properties: Object.freeze({ ...properties }), loadGeometry: () => geometry });
}
function layer(...features) { return Object.freeze({ length: features.length, feature: index => features[index] }); }
function compile(features, variant = 'transportation') {
  return compileBridgeGrammar({ layers: { [variant]: layer(...features) } }, request);
}

test('DET-08 compiles versioned deck, rail, pier and support-slot recipes', () => {
  assert.equal(GDO_BRIDGE_GRAMMAR_NAMESPACE, 'gdo:bridgeGrammar:v1');
  const recipes = bridgeGrammarRecipes();
  assert.deepEqual(recipes.map(recipe => recipe.id), [
    'gdo:bridgeGrammar:v1:deck', 'gdo:bridgeGrammar:v1:rail', 'gdo:bridgeGrammar:v1:pier',
  ]);
  assert.ok(recipes.every(record => record.recipe.silhouette.length === 1));
  assert.ok(recipes.every(record => record.recipe.solidProxies.length === 0),
    'visual recipe boxes never become solids implicitly');

  const result = compile([roadFeature([[0, 50], [100, 50]])]);
  assert.equal(result.meta.segments, 1);
  assert.equal(result.meta.decks, 1);
  assert.equal(result.meta.railRuns, 2);
  assert.ok(result.meta.railPosts > 0);
  assert.ok(result.meta.piers > 0);
  assert.equal(result.meta.compounds, 2 + result.meta.piers);
  assert.ok(result.positions.length > 0);
  assert.equal(result.positions.length, result.normals.length);
  assert.equal(result.positions.length, result.colors.length);
  assert.equal(result.indices.length / 3, result.meta.triangles);
  assert.ok(result.meta.bytes < GEO_BRIDGE_LIMITS.maxVisualBytes + 128 * 1024);
  assert.deepEqual(result.meta.physicalLevels.map(level => level.physicalLevel), [1]);
});

test('DET-08 keeps deck traversal and under-bridge openings separate from rail and pier compounds', () => {
  const result = compile([roadFeature([[0, 50], [100, 50]])]);
  const railAndPierHits = [];
  for (let index = 0; index < result.meta.compounds; index++) {
    railAndPierHits.push(circleIntersectsFootprint(
      50, 50, .055, index, result.collisionVertices,
      result.collisionRingOffsets, result.collisionPolygonOffsets,
    ));
  }
  assert.equal(railAndPierHits.some(Boolean), false, 'walking the deck centre must not hit edge compounds');
  assert.equal(result.meta.openings, 1, 'a long bridge records its under-bridge opening policy');

  const diagonal = compile([roadFeature([[0, 0], [100, 100]])]);
  assert.equal(circleIntersectsFootprint(
    50, 50, .055, 0, diagonal.collisionVertices,
    diagonal.collisionRingOffsets, diagonal.collisionPolygonOffsets,
  ), false, 'rotated rail compounds keep the centerline opening exact');
});

test('DET-08 is byte-stable across provider aliases, feature order and line direction', () => {
  const first = compile([
    roadFeature([[0, 50], [100, 50]], { class: 'primary', bridge: true, layer: 1 }),
    roadFeature([[100, 20], [0, 20]], { class: 'secondary', bridge: true, layer: 2 }),
  ]);
  const second = compile([
    roadFeature([[0, 20], [100, 20]], { kind: 'secondary', brunnel: 'bridge', level: 2 }),
    roadFeature([[100, 50], [0, 50]], { kind: 'primary', brunnel: 'bridge', level: 1 }),
  ], 'streets');
  for (const field of ['positions', 'normals', 'colors', 'indices', 'colliders', 'collisionVertices',
    'collisionRingOffsets', 'collisionPolygonOffsets', 'collisionSpans', 'collisionMasks']) {
    assert.deepEqual(first[field], second[field], field);
  }
  assert.deepEqual(first.meta.physicalLevels, second.meta.physicalLevels);
});

test('DET-08 malformed and over-cap source roads fail closed without partial structures', () => {
  const capped = compileBridgeGrammar({ layers: {
    transportation: { length: GEO_BRIDGE_LIMITS.maxSourceFeatures + 1, feature: () => { throw new Error('scan'); } },
  } }, request);
  assert.equal(capped.meta.segments, 0);
  assert.equal(capped.meta.capEvents.sourceFeatures, true);
  assert.equal(capped.positions.length, 0);

  const malformed = compile([roadFeature([[0, 50], [Number.NaN, 50]])]);
  assert.equal(malformed.meta.segments, 0);
  assert.equal(malformed.meta.capEvents.malformed, true);
  assert.equal(malformed.collisionSpans.length, 0);

  const ground = compile([roadFeature([[0, 50], [100, 50]], { class: 'primary' })]);
  assert.equal(ground.meta.segments, 0, 'ordinary roads never fabricate bridge detail');
});

test('DET-08 context transfer, collision merge, eviction and remount release bridge resources', () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  const scene = new THREE.Scene();
  const world = new GeoWorld(scene, { latitude: 28.9845, longitude: 77.7064 });
  try {
    const tile = [...world.tiles.values()][0];
    const compilation = compileGeoFixture('stacked-bridge');
    const common = { type: 'tile-phase', key: tile.key, requestId: tile.requestId, timings: {} };
    world._handleWorkerMessage({ ...common, phase: 'roads', geometry: compilation.roads });
    world._handleWorkerMessage({ ...common, phase: 'context', context: compilation.context });
    world._handleWorkerMessage({ ...common, phase: 'buildings', geometry: compilation.buildings });
    assert.equal(tile.bridgeMeta.namespace, GDO_BRIDGE_GRAMMAR_NAMESPACE);
    assert.equal(tile.bridgeCount, 1);
    assert.ok(tile.bridgeDetails?.geometry);
    assert.equal(tile.collisionPolygonOffsets.length - 1,
      compilation.buildings.collisionPolygonOffsets.length - 1 + compilation.context.bridge.meta.compounds);
    assert.equal(world.stats.bridges, 1);
    let bridgeDisposed = false;
    tile.bridgeDetails.geometry.addEventListener('dispose', () => { bridgeDisposed = true; });
    world._evictTile(tile);
    assert.equal(bridgeDisposed, true);
    assert.equal(world.streetFurniturePools.diagnostics.entries, 0);
  } finally {
    world.dispose();
    globalThis.Worker = previousWorker;
  }
  assert.equal(scene.children.length, 0);
});
