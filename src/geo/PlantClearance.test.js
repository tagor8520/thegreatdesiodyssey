import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_VEGETATION_CLEARANCE_NAMESPACE,
  GEO_DEFAULT_CROWN_ADAPTATION,
  GEO_PLANT_CLEARANCE_SAMPLES,
  createPlantClearanceDiagnostics,
  evaluatePlantClearance,
  finalizePlantClearanceDiagnostics,
  plantClearanceProfile,
} from './PlantClearance.js';
import { createWaterDomain } from './GeoWaterDomains.js';
import { compileGeoFixture } from './GeoFixtures.js';

const square = (minimumX, minimumZ, maximumX, maximumZ) => [[
  [minimumX, minimumZ], [maximumX, minimumZ], [maximumX, maximumZ], [minimumX, maximumZ],
]];

function building(rings) {
  const points = rings[0];
  return {
    rings,
    minX: Math.min(...points.map(point => point[0])),
    minZ: Math.min(...points.map(point => point[1])),
    maxX: Math.max(...points.map(point => point[0])),
    maxZ: Math.max(...points.map(point => point[1])),
  };
}

const EMPTY_WATER = createWaterDomain();
const emptyObstacles = () => ({ buildings: [], roads: [] });

function evaluate(type, x, z, options = {}) {
  return evaluatePlantClearance({
    type,
    sourceScale: options.sourceScale ?? 1,
    x,
    z,
    yaw: options.yaw ?? 0,
    obstacles: options.obstacles ?? emptyObstacles(),
    waterDomain: options.waterDomain ?? EMPTY_WATER,
    mappedLandKind: options.mappedLandKind ?? '',
    terrainSeed: options.terrainSeed ?? 0,
    diagnostics: options.diagnostics ?? null,
  });
}

test('VEG-07 profiles declare actual base, root and crown extents by ecological role', () => {
  const tree = plantClearanceProfile(0, 1);
  const shrub = plantClearanceProfile(2, 1);
  const herb = plantClearanceProfile(5, 1);
  const grass = plantClearanceProfile(9, 1);
  assert.equal(tree.namespace, GDO_VEGETATION_CLEARANCE_NAMESPACE);
  assert.equal(tree.role, 'canopy-tree');
  assert.equal(shrub.role, 'shrub');
  assert.equal(herb.role, 'herb');
  assert.equal(grass.role, 'grass');
  assert.ok(tree.baseRadius > shrub.baseRadius);
  assert.ok(shrub.baseRadius > herb.baseRadius);
  assert.ok(tree.rootRadius > tree.baseRadius);
  assert.ok(tree.crownRadius > tree.rootRadius);
  assert.equal(grass.solid, false);
  assert.ok(tree.adaptedOrgans.includes('branch'));
  assert.ok(grass.adaptedOrgans.includes('blade'));
  assert.equal(tree.crownMayOverhangRouteVerge, true);
});

test('exact building rings preserve courtyard holes and replace the universal halo', () => {
  const courtyard = building([
    [[0, 0], [10, 0], [10, 10], [0, 10]],
    [[3, 3], [3, 7], [7, 7], [7, 3]],
  ]);
  const obstacles = { buildings: [courtyard], roads: [] };
  assert.equal(evaluate(0, 5, 5, { obstacles }).reason, 'accepted');
  assert.equal(evaluate(0, -.1, 5, { obstacles }).reason, 'base-building-ring');
  assert.equal(evaluate(0, -.25, 5, { obstacles }).reason, 'root-building-ring');
  assert.equal(evaluate(5, -.25, 5, { obstacles }).reason, 'accepted',
    'a small herb base must not inherit a tree-sized constant halo');
});

test('roots require ground support and route clearance while crowns may overhang a verge', () => {
  const road = [0.55, -5, 0.55, 5, .1, 0];
  const verge = evaluate(0, 0, 0, { obstacles: { buildings: [], roads: [road] } });
  assert.equal(verge.accepted, true);
  assert.ok(plantClearanceProfile(0, 1).crownRadius > .55,
    'the accepted crown overlaps the reserved route verge by design');

  const closerRoad = [.35, -5, .35, 5, .1, 0];
  assert.equal(evaluate(0, 0, 0, { obstacles: { buildings: [], roads: [closerRoad] } }).reason,
    'root-route-reservation');

  const waterDomain = createWaterDomain({ waterPolygons: [square(0, -2, 3, 2)] });
  assert.equal(evaluate(0, -.2, 0, { waterDomain }).reason, 'root-water-support');
  assert.equal(evaluate(5, -.2, 0, { waterDomain }).accepted, true,
    'rootless herbs may stand near a shoreline when their actual base stays dry');
  assert.equal(evaluate(5, .2, 0, { waterDomain }).reason, 'water-support');
});

test('bounded crown and branch adaptation avoids building mass without moving the anchor', () => {
  const mass = building(square(0, 0, 10, 10));
  const diagnostics = createPlantClearanceDiagnostics();
  const result = evaluate(0, -.4, 5, { obstacles: { buildings: [mass], roads: [] }, diagnostics });
  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'accepted-crown-adapted');
  assert.equal(result.samples.tested, GEO_PLANT_CLEARANCE_SAMPLES);
  assert.ok(result.adaptation[0] < 1);
  assert.ok(result.adaptation[2] < 0);
  assert.deepEqual(result.support.x, -.4);
  assert.deepEqual(result.support.z, 5);
  const finalized = finalizePlantClearanceDiagnostics(diagnostics);
  assert.equal(finalized.adapted, 1);
  assert.equal(finalized.obstacleSamples.maximumPerCandidate, 16);
  assert.equal(finalized.reasons['accepted-crown-adapted'], 1);
});

test('grass and ground cover use mapped land kind plus their small route base', () => {
  assert.equal(evaluate(9, 0, 0, { mappedLandKind: 'residential' }).reason, 'mapped-land-kind');
  assert.equal(evaluate(9, 0, 0, { mappedLandKind: 'farmland' }).accepted, true);
  assert.equal(evaluate(8, 0, 0, { mappedLandKind: 'wetland' }).accepted, true);
  assert.equal(evaluate(0, 0, 0, { mappedLandKind: 'residential' }).accepted, true,
    'mapped land filtering is specific to crop/grass-style ground cover');
  const road = [.13, -1, .13, 1, .1, 0];
  assert.equal(evaluate(9, 0, 0, { obstacles: { buildings: [], roads: [road] } }).reason,
    'base-route-reservation');
});

test('fixture output carries deterministic adaptations and half-open source-tile anchors under caps', () => {
  const first = compileGeoFixture('provider-equivalence', 'openmaptiles').context;
  const repeated = compileGeoFixture('provider-equivalence', 'openmaptiles').context;
  assert.deepEqual(first.decorationClearances, repeated.decorationClearances);
  assert.equal(first.decorationClearances.length / 4, first.decorations.length / first.decorationStride);
  assert.equal(first.clearanceDiagnostics.namespace, GDO_VEGETATION_CLEARANCE_NAMESPACE);
  assert.equal(first.clearanceDiagnostics.obstacleSamples.maximumPerCandidate <= 16, true);
  assert.equal(typeof first.clearanceDiagnostics.capEvents.groundCover, 'boolean');
  assert.equal(first.decorationMorphologies.length / first.decorationMorphologyStride,
    first.decorations.length / first.decorationStride);
  assert.ok(compileGeoFixture('dense-urban').context.clearanceDiagnostics.adapted > 0,
    'morphology-adjusted crowns still exercise bounded VEG-07 adaptation');
  for (let offset = 0; offset < first.decorations.length; offset += first.decorationStride) {
    const type = Math.round(first.decorations[offset + 3]);
    if (!plantClearanceProfile(type, first.decorations[offset + 2])) continue;
    assert.ok(first.decorations[offset] >= 0 && first.decorations[offset] < 100);
    assert.ok(first.decorations[offset + 1] >= 0 && first.decorations[offset + 1] < 100);
  }
  assert.deepEqual([...GEO_DEFAULT_CROWN_ADAPTATION], [1, 1, 0, 0]);
});
