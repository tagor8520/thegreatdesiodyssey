import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from './GeoWorld.js';
import { buildContextData } from './GeoTileContext.js';
import { GDO_PROP_FAMILIES, compileProp, propFamilyFor, queryPropTriggerStream } from '../engine/PropGrammar.js';
import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';

/**
 * `DET-10` gate, world side: props are placed deterministically inside their
 * declared contexts and caps, they draw through the existing decoration pool,
 * their triggers answer queries from the live world, and only an **authored**
 * solid proxy can reach the collision stream.
 */

globalThis.Worker ??= class { addEventListener() {} postMessage() {} terminate() {} };

const point = (x, y) => ({ x, y });
const layer = feature => ({ length: 1, feature: () => feature });
const PROP_NAMES = new Set(GDO_PROP_FAMILIES.map(family => family.id));

/** A residential block crossed by a street: the documented prop context. */
function residentialTile({ roads = 1, water = null, building = null } = {}) {
  const features = [];
  for (let index = 0; index < roads; index++) {
    const offset = 1024 + index * 512;
    features.push({
      type: 2, extent: 4096, properties: { class: 'residential' },
      loadGeometry: () => [[point(0, offset), point(4096, offset)]],
    });
  }
  const layers = {
    transportation: { length: features.length, feature: index => features[index] },
    landuse: layer({
      type: 3, extent: 4096, properties: { class: 'residential' },
      loadGeometry: () => [[point(0, 0), point(4096, 0), point(4096, 4096), point(0, 4096), point(0, 0)]],
    }),
  };
  if (water) {
    layers.water = layer({
      type: 3, extent: 4096, properties: { class: 'river' },
      loadGeometry: () => [[point(0, water[0]), point(4096, water[0]), point(4096, water[1]), point(0, water[1]), point(0, water[0])]],
    });
  }
  return buildContextData({ layers }, { tileX: 0, tileY: 0, originX: 0, originY: 0, tileSize: 100, terrainSeed: 1 });
}

test('the tile places props deterministically, inside its contexts and its caps', () => {
  const context = residentialTile();
  assert.ok(context.props.length > 0, 'a residential street places props');
  assert.equal(context.propStride, 6);
  assert.equal(context.props.length / 6, context.propTriggers.length / 6);
  assert.equal(context.propDiagnostics.namespace, 'gdo:propGrammar:v1');
  assert.equal(context.propDiagnostics.placed, context.props.length / 6);
  assert.equal(context.propDiagnostics.families, GDO_PROP_FAMILIES.length);
  assert.ok(context.propDiagnostics.familiesUsed >= 1);
  assert.equal(context.propDiagnostics.triggerCeiling, GDO_LOW_PROFILE_BUDGETS.propTriggersPerTile);
  // Only families whose declared contexts include this land kind may appear.
  for (let index = 0; index < context.props.length; index += 6) {
    const family = GDO_PROP_FAMILIES[Math.round(context.props[index + 3])];
    assert.ok(family, 'the family index is real');
    assert.ok(family.placementKinds.includes('residential'), family.id);
    // The trigger record is the compiled trigger, not a Box3 of the visual body.
    const radius = context.propTriggers[index + 3];
    assert.ok(radius >= compileProp(family, { seed: 1 }).visualRadius * .9, family.id);
  }
  // Two compilations of the same tile are byte-identical.
  const again = residentialTile();
  assert.equal(Buffer.compare(Buffer.from(context.props.buffer), Buffer.from(again.props.buffer)), 0);
  assert.equal(Buffer.compare(Buffer.from(context.propTriggers.buffer), Buffer.from(again.propTriggers.buffer)), 0);
  assert.equal(Buffer.compare(Buffer.from(context.decorations.buffer), Buffer.from(again.decorations.buffer)), 0);

  // The trigger ceiling holds even when the tile is dense with streets.
  const dense = residentialTile({ roads: 8 });
  assert.ok(dense.props.length / 6 <= GDO_LOW_PROFILE_BUDGETS.propTriggersPerTile, 'triggers stay inside the ceiling');
  assert.ok(dense.propDiagnostics.placementTests <= GDO_LOW_PROFILE_BUDGETS.propPlacementTestsPerTile, 'placement tests stay inside the ceiling');
  assert.equal(dense.propDiagnostics.truncated, true, 'a capped tile says so');
  assert.equal(dense.propDiagnostics.solidProxies, 0, 'the residential street places no blocking family here');
});

test('a prop never lands in water, and a blocking family is the only source of prop colliders', () => {
  // Water covering the first street: props are refused there.
  const flooded = residentialTile({ roads: 2, water: [900, 1150] });
  for (let index = 0; index < flooded.props.length; index += 6) {
    const z = flooded.props[index + 1];
    assert.ok(z < 90 || z > 115, `no prop inside the mapped river (z=${z.toFixed(1)})`);
  }
  const clean = residentialTile({ roads: 2 });
  assert.equal(flooded.props.length / 6 < clean.props.length / 6, true, 'the water refused at least one site');

  // World mount: props draw through the decoration pool under their family name.
  const world = new GeoWorld(new THREE.Scene(), { latitude: 28.9845, longitude: 77.7064, viewportHeight: 720 });
  try {
    const tile = [...world.tiles.values()][0];
    const context = residentialTile();
    assert.ok(context.propSolids.length >= 0);
    world._handleWorkerMessage({
      type: 'tile-phase', requestId: tile.requestId, key: tile.key, bytes: 4096,
      provider: 'Fixture/openmaptiles', providerId: 'openmaptiles', phase: 'context', context, timings: {},
    });
    assert.equal(world.stats.propPlacements, context.props.length / 6);
    assert.equal(world.stats.propTriggers, context.props.length / 6);
    assert.equal(world.stats.propFamilies, GDO_PROP_FAMILIES.length);
    assert.equal(world.stats.propTriggerCeiling, GDO_LOW_PROFILE_BUDGETS.propTriggersPerTile);
    const propMeshes = tile.decorations.filter(mesh => PROP_NAMES.has(mesh.name.split(':')[0]));
    assert.ok(propMeshes.length >= 1, 'at least one prop family drew a pool');
    for (const mesh of propMeshes) {
      const family = propFamilyFor(mesh.name.split(':')[0]);
      assert.ok(mesh.count >= 1);
      // The drawn geometry is the compiled body: one box per declared module.
      const boxes = mesh.geometry.attributes.position.count / 24;
      assert.equal(boxes, family.modules.length, `${family.id} draws its declared modules`);
    }

    // The trigger query answers from the live world, in range and out of it.
    const first = { x: tile.propTriggers[0], y: tile.propTriggers[1], z: tile.propTriggers[2] };
    const hit = world.queryPropTrigger(first.x, first.y, first.z);
    assert.ok(hit, 'a prop is reachable where it stands');
    assert.equal(hit.action, 'interact');
    assert.ok(PROP_NAMES.has(hit.family));
    assert.ok(hit.distance <= hit.range);
    // A bob or a spin changes nothing: the range is the same sphere every frame.
    assert.deepEqual(world.queryPropTrigger(first.x, first.y, first.z), hit);
    assert.equal(world.queryPropTrigger(first.x + 500, first.y, first.z), null, 'a distant point finds nothing');
    assert.equal(world.queryPropTrigger(first.x + .2, first.y, first.z, { range: 1 }).distance < 1, true);
    assert.equal(world.queryPropTrigger(first.x + 1, first.y, first.z, { range: .25 }), null, 'the caller may tighten the range');

    // Non-blocking props add no colliders at all; only an authored proxy does.
    const solids = context.props.length / 6 ? tile.propSolids.length / 4 : 0;
    assert.equal(world.stats.propSolidBoxes, solids);
    if (solids === 0) {
      assert.equal(tile.props.length % 6, 0);
      assert.equal(tile.propSolids.length, 0, 'a street of non-blocking props has no solids');
    }
    // Eviction takes the records with the tile.
    world._evictTile(tile);
    assert.equal(tile.propTriggers, null);
    assert.equal(tile.propSolids, null);
    assert.equal(world.propTriggerCount(), 0);
  } finally {
    world.dispose();
  }
});

test('an authored proxy is the only prop geometry that reaches the collision grid', () => {
  const world = new GeoWorld(new THREE.Scene(), { latitude: 28.9845, longitude: 77.7064, viewportHeight: 720 });
  try {
    const tile = [...world.tiles.values()][0];
    const blocking = GDO_PROP_FAMILIES.filter(family => family.solid);
    assert.ok(blocking.length >= 1, 'a blocking family exists to prove the separation');
    // Force every family to be a candidate, so the mounted tile really contains a
    // blocking prop and a non-blocking one.
    const context = residentialTile({ roads: 6 });
    const blockingFamily = blocking[0];
    const inventory = [compileProp(blockingFamily, { seed: 3 }), compileProp('steel-kettle', { seed: 3 })];
    const decorated = new Float32Array(context.decorations);
    const propRecords = new Float32Array([
      10, 10, .4, GDO_PROP_FAMILIES.indexOf(blockingFamily), 0, 0,
      14, 10, .2, GDO_PROP_FAMILIES.indexOf(propFamilyFor('steel-kettle')), 1, 0,
    ]);
    const solids = [];
    for (const box of inventory[0].solidProxy) {
      solids.push(10 + box.offset[0] - box.size[0] / 2, 10 + box.offset[2] - box.size[2] / 2,
        10 + box.offset[0] + box.size[0] / 2, 10 + box.offset[2] + box.size[2] / 2);
    }
    world._handleWorkerMessage({
      type: 'tile-phase', requestId: tile.requestId, key: tile.key, bytes: 1024,
      provider: 'Fixture/openmaptiles', providerId: 'openmaptiles', phase: 'context',
      context: {
        ...context, props: propRecords,
        propTriggers: new Float32Array([10, .5, 10, inventory[0].trigger.radius, 0, 0]),
        propSolids: new Float32Array(solids), propStride: 6,
        propDiagnostics: { namespace: 'gdo:propGrammar:v1', placed: 2, families: GDO_PROP_FAMILIES.length, solidProxies: solids.length / 4, triggers: 1, truncated: false },
        decorations: decorated,
      },
      timings: {},
    });
    assert.equal(world.stats.propSolidBoxes, solids.length / 4, 'the authored proxies are counted');
    assert.equal(tile.propSolids.length, solids.length);
    // The collision grid is built from the tile's own colliders plus the prop
    // solids, so a prop blocks at exactly its declared proxy and nowhere else.
    world._handleWorkerMessage({
      type: 'tile-phase', requestId: tile.requestId, key: tile.key, bytes: 1024,
      provider: 'Fixture/openmaptiles', providerId: 'openmaptiles', phase: 'buildings',
      geometry: {
        positions: new Float32Array(), normals: new Float32Array(), colors: new Float32Array(), indices: new Uint32Array(),
        colliders: new Float32Array([0, 0, 1, 1]), collisionVertices: new Float32Array(), collisionRingOffsets: new Uint32Array(),
        collisionPolygonOffsets: new Uint32Array(), collisionSpans: new Float32Array(), collisionMasks: new Uint8Array(),
        supportSlots: new Float32Array(), supportSlotStates: new Uint8Array(), meta: {},
      },
      timings: {},
    });
    assert.ok(tile.collisionGrid, 'the grid was rebuilt');
    // `buildCollisionGrid` indexes boxes by `index / 4`, so the prop solid's own
    // index is proof that the declared proxy — and nothing else — entered the grid.
    const inGrid = new Set(tile.collisionGrid.large);
    for (const cell of tile.collisionGrid.grid.values()) for (const index of cell) inGrid.add(index);
    // `buildCollisionGrid` stores each box's *number* offset, so the prop solid's
    // offset is where the tile's own colliders end.
    const propSolidOffset = tile.colliders.length;
    assert.equal(inGrid.has(propSolidOffset), true, 'the declared proxy is in the grid');
    assert.equal(inGrid.has(0), true, 'the tile collider is still there');
    assert.equal(inGrid.size, 1 + solids.length / 4, 'exactly the tile collider and the authored proxies');
    // The body is bigger than its proxy — more boxes, and taller dressing above
    // the counter — and only the proxy is present: the visual modules never
    // became colliders.
    const proxyHeight = Math.max(...inventory[0].solidProxy.map(box => box.offset[1] + box.size[1] / 2));
    const bodyHeight = Math.max(...inventory[0].boxes.map(box => box.offset[1] + box.size[1] / 2));
    assert.ok(inventory[0].solidProxy.length < inventory[0].boxes.length, 'the proxy is a subset of the body');
    assert.ok(bodyHeight > proxyHeight, 'the body stands taller than its proxy');
    const colliderCount = (tile.colliders.length / 4) + (tile.propSolids.length / 4);
    assert.equal(tile.propSolids.length / 4, solids.length / 4);
    assert.equal(colliderCount, 1 + solids.length / 4);
    assert.equal(queryPropTriggerStream(tile.propTriggers, 6, 10, .5, 10).prop, 0);
  } finally {
    world.dispose();
  }
});
