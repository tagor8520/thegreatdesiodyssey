import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_STREET_FURNITURE_NAMESPACE,
  GEO_STREET_FURNITURE_FAMILY_NAMES,
  GEO_STREET_FURNITURE_LIMITS,
  GEO_STREET_FURNITURE_STRIDE,
  compileStreetFurniture,
  streetFurnitureRecipes,
} from './GeoStreetFurnitureGrammar.js';
import { GEO_SUPPORT_ROLE } from './GeoSupportSlots.js';
import { createWaterDomain } from './GeoWaterDomains.js';

const request = Object.freeze({
  tileX: 0, tileY: 0, originX: 0, originY: 0, tileSize: 100,
});
const emptyWater = createWaterDomain();

function point(x, y) { return Object.freeze({ x, y }); }

function roadFeature(points, properties = { class: 'primary' }) {
  const geometry = [points.map(([x, y]) => point(x, y))];
  return Object.freeze({
    type: 2,
    extent: 100,
    properties: Object.freeze({ ...properties }),
    loadGeometry: () => geometry,
  });
}

function layer(...features) {
  return Object.freeze({ length: features.length, feature: index => features[index] });
}

function compile(roads, options = {}) {
  return compileStreetFurniture({ layers: { transportation: layer(...roads) } }, request, {
    buildings: [],
    waterDomain: emptyWater,
    decorations: new Float32Array(),
    ...options,
  });
}

test('DET-05 defines seven fixed DET-02 families with visual-only role-labelled recipes', () => {
  const recipes = streetFurnitureRecipes();
  assert.equal(GDO_STREET_FURNITURE_NAMESPACE, 'gdo:streetFurniture:v1');
  assert.equal(recipes.length, 7);
  assert.deepEqual(recipes.map(record => record.name), GEO_STREET_FURNITURE_FAMILY_NAMES);
  for (const record of recipes) {
    assert.ok(record.compiled.visualBoxes.length >= 2);
    assert.ok(record.compiled.visualBoxes.length <= GEO_STREET_FURNITURE_LIMITS.maxBoxesPerFamily);
    assert.ok(record.compiled.visualBoxes.every(box => ['silhouette', 'surface', 'accent'].includes(box.role)));
    assert.ok(record.recipe.visualBounds.maxY > record.recipe.visualBounds.minY);
    assert.ok((record.recipe.support.roleMask & GEO_SUPPORT_ROLE.ROAD_EDGE) !== 0);
    assert.ok((record.recipe.support.roleMask & GEO_SUPPORT_ROLE.STREET_FURNITURE) !== 0);
    assert.equal(record.compiled.solidProxies.length, 0);
    assert.equal(record.compiled.interactionProxies.length, 0);
    assert.equal(record.compiled.cameraRoles.length, 0);
  }
});

test('DET-05 road frames keep carriageways, segment crossings/endpoints, buildings, and spawn clear', () => {
  const building = {
    rings: [[[0, 5.25], [100, 5.25], [100, 7], [0, 7]]],
    minX: 0, minZ: 5.25, maxX: 100, maxZ: 7,
  };
  const result = compile([roadFeature([[0, 5], [100, 5]])], { buildings: [building] });
  assert.equal(result.namespace, GDO_STREET_FURNITURE_NAMESPACE);
  assert.equal(result.stride, GEO_STREET_FURNITURE_STRIDE);
  assert.ok(result.meta.placements > 0);
  assert.ok(result.meta.rejected.building > 0);
  assert.equal(result.placements.length, result.meta.placements * result.stride);
  for (let offset = 0; offset < result.placements.length; offset += result.stride) {
    const x = result.placements[offset], z = result.placements[offset + 1];
    assert.ok(z < 5, 'the building-side entrance belt must remain empty');
    assert.ok(Math.abs(z - 5) > .5, 'the road carriageway must remain empty');
    assert.ok(x >= GEO_STREET_FURNITURE_LIMITS.endpointClearance);
    assert.ok(100 - x >= GEO_STREET_FURNITURE_LIMITS.endpointClearance);
    assert.ok(Math.abs(x - 50) >= .85, 'the conservative crossing midpoint must remain clear');
    assert.ok(Math.hypot(x, z) >= 2.8);
  }
});

test('DET-05 output is byte-stable across provider aliases, feature order, and line direction', () => {
  const horizontal = roadFeature([[0, 20], [100, 20]], { class: 'primary' });
  const vertical = roadFeature([[70, 0], [70, 100]], { class: 'secondary' });
  const first = compile([horizontal, vertical]);
  const aliased = compileStreetFurniture({ layers: { streets: layer(
    roadFeature([[70, 100], [70, 0]], { kind: 'secondary' }),
    roadFeature([[100, 20], [0, 20]], { kind: 'primary' }),
  ) } }, request, {
    buildings: [], waterDomain: emptyWater, decorations: new Float32Array(),
  });
  assert.deepEqual(first.placements, aliased.placements);
  assert.deepEqual(first.meta.familyCounts, aliased.meta.familyCounts);
  assert.equal(first.meta.roadTests, aliased.meta.roadTests);
  assert.equal(first.meta.conflictTests, aliased.meta.conflictTests);
});

test('DET-05 malformed or capped source domains fail closed without partial furniture', () => {
  const overFeatureCap = {
    layers: {
      transportation: {
        length: GEO_STREET_FURNITURE_LIMITS.maxSourceFeatures + 1,
        feature: () => { throw new Error('must not scan over-cap source'); },
      },
    },
  };
  const capped = compileStreetFurniture(overFeatureCap, request, {
    buildings: [], waterDomain: emptyWater, decorations: new Float32Array(),
  });
  assert.equal(capped.meta.placements, 0);
  assert.equal(capped.meta.capEvents.roadSegments, true);

  const buildingCapped = compile([roadFeature([[0, 30], [100, 30]])], { buildingsTruncated: true });
  assert.equal(buildingCapped.meta.placements, 0);
  assert.equal(buildingCapped.meta.capEvents.buildings, true);

  const missingWater = compileStreetFurniture({ layers: {
    transportation: layer(roadFeature([[0, 30], [100, 30]])),
  } }, request, { buildings: [], decorations: new Float32Array() });
  assert.equal(missingWater.meta.placements, 0);
  assert.equal(missingWater.meta.capEvents.waterDomain, true);

  const malformedRoad = compile([
    roadFeature([[0, 30], [100, 30]]),
    roadFeature([[0, 40], [Number.NaN, 40]]),
  ]);
  assert.equal(malformedRoad.meta.placements, 0);
  assert.equal(malformedRoad.meta.capEvents.malformedRoads, true);

  const malformedDecorations = compile([roadFeature([[0, 30], [100, 30]])], {
    decorations: new Float32Array([12, 12, Number.NaN, 0, 0, 1]),
  });
  assert.equal(malformedDecorations.meta.placements, 0);
  assert.equal(malformedDecorations.meta.capEvents.decorations, true);

  const truncatedWater = {
    ...emptyWater,
    meta: { ...emptyWater.meta, capEvents: { ...emptyWater.meta.capEvents, waterVertices: true } },
  };
  const waterCapped = compile([roadFeature([[0, 30], [100, 30]])], { waterDomain: truncatedWater });
  assert.equal(waterCapped.meta.placements, 0);
  assert.equal(waterCapped.meta.capEvents.waterDomain, true);
});
