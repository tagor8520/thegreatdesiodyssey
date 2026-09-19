import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from './GeoWorld.js';
import { circleIntersectsFootprint } from './GeoCollision.js';
import { compileGeoFixture } from './GeoFixtures.js';
import {
  GDO_LANDMARK_GRAMMAR_NAMESPACE,
  GEO_LANDMARK_LIMITS,
  landmarkGrammarRecipes,
  compileLandmarkGrammar,
} from './GeoLandmarkGrammar.js';

const request = Object.freeze({
  tileX: 0, tileY: 0, originX: 0, originY: 0, tileSize: 100, terrainSeed: 17,
});
const point = (x, y) => Object.freeze({ x, y });
function landmarkFeature(id, points, properties = { kind: 'gateway', render_height: 34, opening_width: 900 }) {
  return Object.freeze({
    id, type: 3, extent: 100, properties: Object.freeze({ ...properties }),
    loadGeometry: () => [points.map(([x, y]) => point(x, y))],
  });
}
function layer(...features) { return Object.freeze({ length: features.length, feature: index => features[index] }); }
function compile(features, layerName = 'landmark') {
  return compileLandmarkGrammar({ layers: { [layerName]: layer(...features) } }, request);
}

function compoundIntersectsCenter(result, index, x, z) {
  return circleIntersectsFootprint(
    x, z, .055, index, result.collisionVertices,
    result.collisionRingOffsets, result.collisionPolygonOffsets,
  );
}

test('DET-09 exposes a versioned repeated-module recipe set and one merged batch', () => {
  assert.equal(GDO_LANDMARK_GRAMMAR_NAMESPACE, 'gdo:landmarkGrammar:v1');
  assert.deepEqual(landmarkGrammarRecipes().map(recipe => recipe.role), [
    'opening-pillars', 'opening-arch-ring', 'repeated-tier-columns', 'repeated-finials',
  ]);
  const result = compile([landmarkFeature(1, [[20, 30], [80, 30], [80, 70], [20, 70], [20, 30]])]);
  assert.equal(result.meta.landmarks, 1);
  assert.ok(result.meta.repeatedModules >= 5);
  assert.equal(result.meta.openings, 1);
  assert.ok(result.meta.compounds > 2, 'opening structure must use several exact compounds');
  assert.ok(result.meta.boxes <= GEO_LANDMARK_LIMITS.maxVisualBoxes);
  assert.equal(result.indices.length / 3, result.meta.triangles);
  assert.equal(result.meta.bytes, result.positions.byteLength + result.normals.byteLength + result.colors.byteLength +
    result.indices.byteLength + result.colliders.byteLength + result.collisionVertices.byteLength +
    result.collisionRingOffsets.byteLength + result.collisionPolygonOffsets.byteLength +
    result.collisionSpans.byteLength + result.collisionMasks.byteLength);
});

test('DET-09 preserves a real arch opening instead of using one landmark-wide AABB', () => {
  const result = compile([landmarkFeature(1, [[20, 30], [80, 30], [80, 70], [20, 70], [20, 30]])]);
  const opening = result.meta.openingPolicies[0];
  const centerHits = [];
  for (let index = 0; index < result.meta.compounds; index++) {
    if (!compoundIntersectsCenter(result, index, opening.centerX, opening.centerZ)) continue;
    centerHits.push(index);
    assert.ok(result.collisionSpans[index * 2] >= opening.springY - .02,
      'a centerline compound must start at or above the arch spring');
  }
  assert.ok(centerHits.length > 0, 'the arch ring should retain a structural center compound');
  assert.ok(result.meta.compounds < result.meta.boxes,
    'structural query compounds must not be one broad bound for all visual modules');
});

test('DET-09 is invariant to provider layer aliases, feature order, and polygon winding', () => {
  const first = compile([
    landmarkFeature(2, [[20, 30], [80, 30], [80, 70], [20, 70], [20, 30]]),
    landmarkFeature(1, [[5, 10], [25, 10], [25, 25], [5, 25], [5, 10]], { kind: 'monument', render_height: 22 }),
  ]);
  const second = compile([
    landmarkFeature(1, [[5, 10], [5, 25], [25, 25], [25, 10], [5, 10]], { kind: 'monument', render_height: 22 }),
    landmarkFeature(2, [[20, 30], [20, 70], [80, 70], [80, 30], [20, 30]]),
  ], 'monuments');
  for (const field of ['positions', 'normals', 'colors', 'indices', 'colliders', 'collisionVertices',
    'collisionRingOffsets', 'collisionPolygonOffsets', 'collisionSpans', 'collisionMasks']) {
    assert.deepEqual(first[field], second[field], field);
  }
  assert.deepEqual(first.meta.openingPolicies, second.meta.openingPolicies);
});

test('DET-09 malformed and over-cap landmark input fails closed', () => {
  const capped = compileLandmarkGrammar({ layers: {
    landmark: { length: GEO_LANDMARK_LIMITS.maxSourceFeatures + 1, feature: () => { throw new Error('scan'); } },
  } }, request);
  assert.equal(capped.meta.landmarks, 0);
  assert.equal(capped.meta.capEvents.sourceFeatures, true);
  assert.equal(capped.positions.length, 0);

  const malformed = compileLandmarkGrammar({ layers: {
    landmark: layer({ type: 3, extent: 100, properties: { kind: 'gateway' }, loadGeometry: () => [[point(1, 1), point(Number.NaN, 2)]] }),
  } }, request);
  assert.equal(malformed.meta.capEvents.malformed, true);
  assert.equal(malformed.collisionSpans.length, 0);

  const ordinaryPoi = compileLandmarkGrammar({ layers: {
    poi: layer({ type: 1, extent: 100, properties: { class: 'town' }, loadGeometry: () => [[point(50, 50)]] }),
  } }, request);
  assert.equal(ordinaryPoi.meta.landmarks, 0, 'ordinary POIs must not fabricate landmarks');
});

test('DET-09 context transfer, opening collision merge, focus visibility and eviction dispose landmark resources', () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  const scene = new THREE.Scene();
  const world = new GeoWorld(scene, { latitude: 28.9845, longitude: 77.7064 });
  try {
    const tile = [...world.tiles.values()][0];
    const compilation = compileGeoFixture('landmark-opening');
    const common = { type: 'tile-phase', key: tile.key, requestId: tile.requestId, timings: {} };
    world._handleWorkerMessage({ ...common, phase: 'roads', geometry: compilation.roads });
    world._handleWorkerMessage({ ...common, phase: 'context', context: compilation.context });
    world._handleWorkerMessage({ ...common, phase: 'buildings', geometry: compilation.buildings });
    assert.equal(tile.landmarkMeta.namespace, GDO_LANDMARK_GRAMMAR_NAMESPACE);
    assert.equal(tile.landmarkCount, compilation.context.landmarks.meta.landmarks);
    assert.ok(tile.landmarkDetails?.geometry);
    assert.equal(tile.collisionPolygonOffsets.length - 1,
      compilation.buildings.collisionPolygonOffsets.length - 1 +
      compilation.context.landmarks.meta.compounds);
    assert.equal(world.stats.landmarks, compilation.context.landmarks.meta.landmarks);
    let disposed = false;
    tile.landmarkDetails.geometry.addEventListener('dispose', () => { disposed = true; });
    world._evictTile(tile);
    assert.equal(disposed, true);
  } finally {
    world.dispose();
    globalThis.Worker = previousWorker;
  }
});
