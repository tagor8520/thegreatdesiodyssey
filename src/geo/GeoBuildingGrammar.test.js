import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_BUILDING_GRAMMAR_NAMESPACE,
  GEO_BUILDING_DETAIL_LIMITS,
  createBuildingDetailRecipe,
  createBuildingRoadIndex,
  findRoadFacingEdge,
  selectBuildingDetailCandidates,
} from './GeoBuildingGrammar.js';
import { GEO_OBJECT_ROLE } from './GeoObjectRecipe.js';
import { GEO_SUPPORT_ROLE, rectangleFitsSupport } from './GeoSupportSlots.js';

const square = [[0, 0], [4, 0], [4, 4], [0, 4]];
const roofSlot = Object.freeze({
  id: 7,
  roleMask: GEO_SUPPORT_ROLE.ROOF_DETAIL,
  x: 1,
  y: 2,
  z: 1,
  halfWidth: .3,
  halfDepth: .3,
  yaw: 0,
});

function detailInput(overrides = {}) {
  const roads = createBuildingRoadIndex([[-2, -1, 6, -1], [8, -2, 8, 6]]);
  return {
    id: 'tile:building:detail',
    owner: 'tile:building',
    rings: [square],
    foundationY: 0,
    roofY: 2,
    height: 2,
    hash: 4,
    wallColor: [.5, .25, .1],
    roofColor: [.6, .32, .16],
    roadFacing: findRoadFacingEdge(square, roads),
    roofSlots: [roofSlot],
    ...overrides,
  };
}

test('DET-04 selects the nearest mapped-road-facing wall independent of road order', () => {
  const firstIndex = createBuildingRoadIndex([[-2, -1, 6, -1], [8, -2, 8, 6]]);
  const reorderedIndex = createBuildingRoadIndex([[8, -2, 8, 6], [-2, -1, 6, -1]]);
  const first = findRoadFacingEdge(square, firstIndex);
  const reordered = findRoadFacingEdge(square, reorderedIndex);
  assert.equal(first.found, true);
  assert.equal(first.source, 'mapped-road');
  assert.equal(first.edgeIndex, 0);
  assert.equal(reordered.edgeIndex, first.edgeIndex);
  assert.ok(Math.abs(first.distance - 1) < 1e-9);
  assert.ok(Math.abs(first.tangentX - 1) < 1e-9 && Math.abs(first.tangentZ) < 1e-9);
  assert.ok(Math.abs(first.normalX) < 1e-9 && Math.abs(first.normalZ + 1) < 1e-9,
    'the facade normal must point out of the mapped footprint toward the road');
  const rotatedRing = findRoadFacingEdge([...square.slice(2), ...square.slice(0, 2)], firstIndex);
  const reversedRing = findRoadFacingEdge([...square].reverse(), firstIndex);
  for (const facing of [rotatedRing, reversedRing]) assert.deepEqual(
    [facing.centerX, facing.centerZ, facing.tangentX, facing.tangentZ,
      facing.normalX, facing.normalZ, facing.yaw, facing.distance],
    [first.centerX, first.centerZ, first.tangentX, first.tangentZ,
      first.normalX, first.normalZ, first.yaw, first.distance],
    'ring start/winding order must not orient a facade tie',
  );
});

test('DET-04 compiles deterministic role-labelled facade and roof modules without implicit proxies', () => {
  const first = createBuildingDetailRecipe(detailInput());
  const repeated = createBuildingDetailRecipe(detailInput());
  assert.equal(first.namespace, GDO_BUILDING_GRAMMAR_NAMESPACE);
  assert.equal(first.namespace, 'gdo:objectGrammar:v2');
  assert.deepEqual(first, repeated);
  assert.equal(first.roadFacingSource, 'mapped-road');
  assert.ok(first.compiled.visualBoxes.length >= 5);
  assert.ok(first.compiled.visualBoxes.length <= GEO_BUILDING_DETAIL_LIMITS.boxesPerBuilding);
  assert.ok(first.compiled.visualBoxes.some(box => box.moduleId === 'road-entrance'));
  assert.ok(first.compiled.visualBoxes.some(box => box.moduleId === 'entrance-canopy'));
  assert.ok(first.compiled.visualBoxes.some(box => box.moduleId === 'roof-solar-pair'));
  assert.deepEqual(new Set(first.compiled.visualBoxes.map(box => box.role)),
    new Set([GEO_OBJECT_ROLE.SURFACE]));
  assert.equal(first.compiled.solidProxies.length, 0);
  assert.equal(first.compiled.interactionProxies.length, 0);
  assert.equal(first.compiled.cameraRoles.length, 0);
  assert.ok((first.recipe.support.roleMask & GEO_SUPPORT_ROLE.BUILDING_DETAIL) !== 0);
  assert.ok((first.recipe.support.roleMask & GEO_SUPPORT_ROLE.FACADE_DETAIL) !== 0);
  assert.ok((first.recipe.support.roleMask & GEO_SUPPORT_ROLE.ROOF_DETAIL) !== 0);
  assert.ok(first.recipe.visualBounds && first.recipe.visualBounds.maxY > first.recipe.visualBounds.minY);
  assert.deepEqual(first.roofSlotIds, [roofSlot.id]);

  const entrance = first.compiled.visualBoxes.find(box => box.moduleId === 'road-entrance');
  assert.ok(entrance.centerZ < 0, 'the entrance panel must project outward toward the mapped road');
  assert.ok(first.entranceBounds.top < 1,
    'the reserved entrance zone must stay below any optional upper-facade rhythm');
  const fullyAccented = createBuildingDetailRecipe(detailInput({ hash: 6 }));
  for (const box of fullyAccented.compiled.visualBoxes.filter(box =>
    ['balcony-rhythm', 'facade-cornice', 'facade-utility'].includes(box.moduleId))) {
    assert.ok(box.bottom >= fullyAccented.entranceBounds.top,
      `${box.moduleId} must not occupy the reserved entrance/opening interval`);
  }
  for (const box of first.compiled.visualBoxes.filter(box => box.moduleId.startsWith('roof-'))) {
    assert.equal(rectangleFitsSupport([square], box.centerX, box.centerZ, box.sizeX / 2, box.sizeZ / 2), true,
      `${box.moduleId} must remain on exact mapped roof support`);
  }
});

test('DET-04 keeps missing-road fallback roof-only and never fabricates an entrance direction', () => {
  const noRoads = createBuildingRoadIndex([]);
  const facing = findRoadFacingEdge(square, noRoads);
  const detail = createBuildingDetailRecipe(detailInput({ roadFacing: facing, hash: 3 }));
  assert.equal(facing.found, false);
  assert.equal(detail.roadFacingSource, 'none');
  assert.equal(detail.entranceBounds, null);
  assert.ok(detail.compiled.visualBoxes.every(box => box.moduleId.startsWith('roof-')));
  assert.ok(detail.compiled.visualBoxes.length >= 4);
  assert.equal(detail.compiled.solidProxies.length, 0);
});

test('DET-04 road scans and candidate selection prune deterministically at explicit caps', () => {
  const index = createBuildingRoadIndex([
    null,
    [0, 0, 0, 0],
    [-2, -1, 6, -1],
    [8, -2, 8, 6],
    [0, 7, 4, 7],
  ], { maxSegments: 2 });
  assert.equal(index.meta.segments, 2);
  assert.equal(index.meta.malformed, 2);
  assert.equal(index.meta.truncated, true);
  const cappedIndexFacing = findRoadFacingEdge(square, index, { maxTests: 1 });
  assert.equal(cappedIndexFacing.tests, 0);
  assert.equal(cappedIndexFacing.found, false);
  assert.equal(cappedIndexFacing.truncated, true);
  const cappedQueryFacing = findRoadFacingEdge(square, createBuildingRoadIndex([
    [-2, -1, 6, -1], [8, -2, 8, 6],
  ]), { maxTests: 1 });
  assert.equal(cappedQueryFacing.tests, 1);
  assert.equal(cappedQueryFacing.found, false);
  assert.equal(cappedQueryFacing.truncated, true);

  const detail = createBuildingDetailRecipe(detailInput());
  const candidates = Array.from({ length: 12 }, (_, indexValue) => ({
    id: `candidate:${String(indexValue).padStart(2, '0')}`,
    priority: indexValue % 4,
    detail,
  }));
  const selected = selectBuildingDetailCandidates([...candidates].reverse());
  assert.equal(selected.length, GEO_BUILDING_DETAIL_LIMITS.selectedBuildingsPerTile);
  assert.deepEqual(selected.map(candidate => candidate.id), [
    'candidate:03', 'candidate:07', 'candidate:11',
    'candidate:02', 'candidate:06', 'candidate:10',
    'candidate:01', 'candidate:05',
  ]);
  assert.throws(() => selectBuildingDetailCandidates(candidates, 9), RangeError);
  assert.throws(() => createBuildingRoadIndex([], { maxSegments: -1 }), RangeError);
});
