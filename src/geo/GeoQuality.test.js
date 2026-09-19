import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_LOW_PROFILE_BUDGETS,
  PerformanceBudgetError,
  assertLowProfileBudget,
  evaluateLowProfileBudget,
} from '../engine/PerformanceBudget.js';
import { GEO_QUERY_MASK } from './GeoCollision.js';
import { GeoDebugOverlay } from './GeoDebugOverlay.js';
import {
  buildGeoDebugSnapshot,
  describeGeoQueryMask,
} from './GeoDiagnostics.js';
import {
  GEO_FIXTURE_MATRIX,
  collectGeoFixtureBudgetMetrics,
  compileGeoFixture,
  geoFixtureFingerprint,
  geoFixtureTypedViews,
  geoFixturesByteEquivalent,
} from './GeoFixtures.js';
import { circleIntersectsFootprint, GeoWorld } from './GeoWorld.js';
import { GEO_WATER_CLASS, queryWaterDomain } from './GeoWaterDomains.js';

function viewsEqual(first, second) {
  if (first.constructor !== second.constructor || first.byteLength !== second.byteLength) return false;
  const a = new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  const b = new Uint8Array(second.buffer, second.byteOffset, second.byteLength);
  return a.every((value, index) => value === b[index]);
}

function fixtureGeometryEquivalent(first, second) {
  const a = geoFixtureTypedViews(first), b = geoFixtureTypedViews(second);
  return a.length === b.length && a.every((entry, index) =>
    entry.name === b[index].name && viewsEqual(entry.view, b[index].view));
}

function applyCompilation(world, tile, compilation) {
  const common = {
    type: 'tile-phase', requestId: tile.requestId, key: tile.key,
    bytes: 2048, provider: `Fixture/${compilation.fixture.variant}`,
  };
  world._handleWorkerMessage({
    ...common, phase: 'roads', geometry: compilation.roads,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2 },
  });
  world._handleWorkerMessage({
    ...common, phase: 'context', context: compilation.context,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3 },
  });
  world._handleWorkerMessage({
    ...common, phase: 'buildings', geometry: compilation.buildings,
    timings: {
      fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3,
      buildingsMilliseconds: 4, totalMilliseconds: 10,
    },
  });
}

function mountedTileSnapshot(tile) {
  const output = [];
  const append = (name, view) => {
    if (!ArrayBuffer.isView(view)) return;
    output.push([name, view.constructor.name, new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice()]);
  };
  for (const name of ['ground', 'roads', 'land', 'water', 'buildings', 'buildingDetails']) {
    const geometry = tile[name]?.geometry;
    append(`${name}.position`, geometry?.attributes?.position?.array);
    append(`${name}.normal`, geometry?.attributes?.normal?.array);
    append(`${name}.color`, geometry?.attributes?.color?.array);
    append(`${name}.index`, geometry?.index?.array);
  }
  for (const field of ['colliders', 'collisionVertices', 'collisionRingOffsets', 'collisionPolygonOffsets',
    'collisionSpans', 'collisionMasks', 'supportSlots', 'supportSlotStates', 'roadSupportSegments']) {
    append(field, tile[field]);
  }
  for (const mesh of [...tile.decorations].sort((a, b) => a.name.localeCompare(b.name))) {
    append(`${mesh.name}.instances`, mesh.instanceMatrix.array);
  }
  return { output, labels: JSON.stringify(tile.labels), roadMeta: JSON.stringify(tile.roadMeta), buildingMeta: JSON.stringify(tile.buildingMeta) };
}

function assertMountedSnapshotsEqual(first, second) {
  assert.equal(first.labels, second.labels);
  assert.equal(first.roadMeta, second.roadMeta);
  assert.equal(first.buildingMeta, second.buildingMeta);
  assert.equal(first.output.length, second.output.length);
  for (let index = 0; index < first.output.length; index++) {
    assert.equal(first.output[index][0], second.output[index][0]);
    assert.equal(first.output[index][1], second.output[index][1]);
    assert.deepEqual(first.output[index][2], second.output[index][2], first.output[index][0]);
  }
}

test('canonical geographic fixture matrix covers every required topology and provider schema', () => {
  assert.deepEqual(GEO_FIXTURE_MATRIX.map(item => item.category),
    ['dense', 'sparse', 'concave', 'hole', 'bridge', 'coast', 'provider-schema']);
  assert.equal(new Set(GEO_FIXTURE_MATRIX.map(item => item.id)).size, GEO_FIXTURE_MATRIX.length);

  const dense = compileGeoFixture('dense-urban');
  const sparse = compileGeoFixture('sparse-rural');
  const concave = compileGeoFixture('concave-building');
  const courtyard = compileGeoFixture('courtyard-hole');
  const bridge = compileGeoFixture('stacked-bridge');
  const coast = compileGeoFixture('mapped-coast');
  assert.ok(dense.buildings.meta.features > 80);
  assert.equal(dense.buildings.meta.buildingGrammar.namespace, 'gdo:objectGrammar:v2');
  assert.equal(dense.buildings.meta.buildingGrammar.selectedBuildings, 8);
  assert.equal(dense.buildings.meta.buildingGrammar.capEvents.selectedBuildings, true);
  assert.ok(dense.buildings.meta.buildingGrammar.boxes <= GDO_LOW_PROFILE_BUDGETS.buildingDetailBoxes);
  assert.ok(dense.buildings.meta.buildingGrammar.roadTests <= GDO_LOW_PROFILE_BUDGETS.buildingDetailRoadTestsPerTile);
  assert.equal(dense.buildings.detailPositions.length, dense.buildings.detailNormals.length);
  assert.equal(dense.context.streetFurniture.namespace, 'gdo:streetFurniture:v1');
  assert.ok(dense.context.streetFurniture.meta.placements > 0);
  assert.ok(dense.context.streetFurniture.meta.placements <= GDO_LOW_PROFILE_BUDGETS.streetFurnitureEntries);
  assert.ok(dense.context.streetFurniture.meta.bytes <= GDO_LOW_PROFILE_BUDGETS.streetFurnitureBytesPerTile);
  assert.equal(sparse.buildings.meta.features, 1);
  assert.equal(sparse.roads.meta.features, 1);
  assert.equal(circleIntersectsFootprint(65, 60, .1, 0, concave.buildings.collisionVertices,
    concave.buildings.collisionRingOffsets, concave.buildings.collisionPolygonOffsets), false,
  'the concave fixture must retain its empty broad-phase corner');
  assert.equal(circleIntersectsFootprint(50, 45, .1, 0, courtyard.buildings.collisionVertices,
    courtyard.buildings.collisionRingOffsets, courtyard.buildings.collisionPolygonOffsets), false,
  'the hole fixture must retain a traversable courtyard');
  assert.equal(bridge.roads.meta.junctions, 0, 'stacked grades must not create a visual junction merge');
  assert.deepEqual(bridge.roads.meta.transportLevels.levels.map(level => level.physicalLevel), [-1, 0, 1]);
  assert.equal(coast.context.water.meta.features, 1);
  assert.equal(coast.context.waterDomain.meta.classCounts.ocean, 1);
  const coastWater = queryWaterDomain(coast.context.waterDomain, 50, 20);
  assert.equal(coastWater.waterClass, GEO_WATER_CLASS.OCEAN);
  assert.equal(coastWater.flowKnown, false);
  assert.ok(coast.context.labels.some(label => label.name === 'Fixture Sea'));

  const openMapTiles = compileGeoFixture('provider-equivalence', 'openmaptiles');
  const shortbread = compileGeoFixture('provider-equivalence', 'shortbread');
  assert.equal(fixtureGeometryEquivalent(openMapTiles, shortbread), true,
    'equivalent provider schemas must compile byte-identical geometry and proxies');
  const canonicalLabels = compilation => compilation.context.labels.map(({ sourceLayer, ...label }) => label);
  assert.deepEqual(canonicalLabels(openMapTiles), canonicalLabels(shortbread));
  assert.deepEqual(openMapTiles.context.decorationClearances, shortbread.context.decorationClearances);
  assert.deepEqual(openMapTiles.context.streetFurniture.placements, shortbread.context.streetFurniture.placements);
  assert.deepEqual(openMapTiles.context.streetFurniture.meta, shortbread.context.streetFurniture.meta);
  assert.deepEqual(openMapTiles.context.waterDomain.meta, shortbread.context.waterDomain.meta);
  assert.deepEqual(openMapTiles.context.clearanceDiagnostics, shortbread.context.clearanceDiagnostics);
  assert.notDeepEqual(openMapTiles.context.labels.map(label => label.sourceLayer),
    shortbread.context.labels.map(label => label.sourceLayer), 'provider provenance remains available for debugging');
});

test('every canonical fixture is byte-equivalent after deterministic recompilation', () => {
  const fingerprints = new Set();
  for (const descriptor of GEO_FIXTURE_MATRIX) for (const variant of descriptor.variants) {
    const first = compileGeoFixture(descriptor.id, variant);
    const remounted = compileGeoFixture(descriptor.id, variant);
    assert.equal(geoFixturesByteEquivalent(first, remounted), true, `${descriptor.id}/${variant}`);
    const fingerprint = geoFixtureFingerprint(first);
    assert.match(fingerprint, /^[0-9a-f]{8}$/);
    fingerprints.add(fingerprint);
  }
  assert.equal(fingerprints.size, 8, 'each fixture/provider payload should retain a distinct fingerprint');
});

test('fixture tile eviction and remount reproduce bytes and release owned resources', () => {
  const previousWorker = globalThis.Worker;
  class FixtureWorker {
    static active = 0;
    constructor() { FixtureWorker.active++; this.messages = []; }
    addEventListener() {}
    postMessage(message) { this.messages.push(message); }
    terminate() { if (!this.terminated) { this.terminated = true; FixtureWorker.active--; } }
  }
  globalThis.Worker = FixtureWorker;
  const scene = new THREE.Scene();
  const world = new GeoWorld(scene, { latitude: 28.9845, longitude: 77.7064 });
  try {
    const firstTile = [...world.tiles.values()][0];
    applyCompilation(world, firstTile, compileGeoFixture('provider-equivalence', 'openmaptiles'));
    world._flushPlantMounts(0);
    const first = mountedTileSnapshot(firstTile);
    const firstPlantFingerprint = world.plantRenderPools.fingerprint();
    const firstFurnitureFingerprint = world.streetFurniturePools.fingerprint();
    assert.equal(world.plantRenderPools.diagnostics.entries, firstTile.plantPoolCount);
    assert.equal(world.streetFurniturePools.diagnostics.entries, firstTile.streetFurnitureCount);
    let disposals = 0;
    for (const name of ['ground', 'roads', 'land', 'water', 'buildings', 'buildingDetails']) {
      firstTile[name]?.geometry.addEventListener('dispose', () => disposals++);
    }
    const tileX = firstTile.x, tileY = firstTile.y;
    world._evictTile(firstTile);
    assert.equal(disposals, 6);
    assert.equal(firstTile.root.children.length, 0);
    assert.equal(firstTile.waterDomain, null);
    assert.equal(firstTile.clearanceDiagnostics, null);
    assert.equal(world.plantRenderPools.diagnostics.entries, 0);
    assert.equal(world.streetFurniturePools.diagnostics.entries, 0);
    assert.equal(world.totalBytes, 0);

    world._requestTile(tileX, tileY, 0);
    const secondTile = world.tiles.get(firstTile.key);
    applyCompilation(world, secondTile, compileGeoFixture('provider-equivalence', 'openmaptiles'));
    world._flushPlantMounts(0);
    assertMountedSnapshotsEqual(first, mountedTileSnapshot(secondTile));
    assert.equal(world.plantRenderPools.fingerprint(), firstPlantFingerprint);
    assert.equal(world.streetFurniturePools.fingerprint(), firstFurnitureFingerprint);
  } finally {
    world.dispose();
    globalThis.Worker = previousWorker;
  }
  assert.equal(FixtureWorker.active, 0);
  assert.equal(scene.children.length, 0);
});

test('only the focused source tile exposes its bounded near building-detail batch', () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  const world = new GeoWorld(new THREE.Scene(), { latitude: 28.9845, longitude: 77.7064 });
  try {
    const first = [...world.tiles.values()][0];
    applyCompilation(world, first, compileGeoFixture('provider-equivalence', 'openmaptiles'));
    world._requestTile(first.x + 1, first.y, 1);
    const second = world.tiles.get(`${first.x + 1}:${first.y}`);
    applyCompilation(world, second, compileGeoFixture('provider-equivalence', 'openmaptiles'));
    assert.equal(first.buildingDetails.visible, true);
    assert.equal(second.buildingDetails.visible, false);
    world.update({ x: world.reference.tileSize + .1, z: 0 }, null, 720, 1_000);
    assert.equal(first.buildingDetails.visible, false);
    assert.equal(second.buildingDetails.visible, true);
    assert.equal(world.stats.buildingDetailBuildings, second.buildingMeta.buildingGrammar.selectedBuildings);
  } finally {
    world.dispose();
    globalThis.Worker = previousWorker;
  }
});

test('dense canonical vegetation and furniture uploads preserve collision isolation and low-profile caps', () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  const world = new GeoWorld(new THREE.Scene(), { latitude: 28.9845, longitude: 77.7064 });
  try {
    const tile = [...world.tiles.values()][0];
    const compilation = compileGeoFixture('provider-equivalence', 'openmaptiles');
    applyCompilation(world, tile, compilation);
    world._flushPlantMounts(0);
    const render = world.plantRenderPools.diagnostics;
    const furniture = world.streetFurniturePools.diagnostics;
    assert.equal(render.entries, 1_044);
    assert.equal(render.activeDrawPools, 11);
    assert.equal(render.sourceGeometries, 36);
    assert.equal(render.gpuGeometryBytes, 208_452);
    assert.equal(render.visibleTriangles, 11_190);
    assert.equal(render.addedDrawCalls, 4);
    assert.deepEqual(render.byLod, { near: 0, mid: 35, far: 461, beyond: 548 });
    assert.equal(furniture.entries, compilation.context.streetFurniture.meta.placements);
    assert.equal(furniture.sourceGeometries, 7);
    assert.equal(furniture.activeDrawPools, 3);
    assert.equal(furniture.addedDrawCalls, 3);
    assert.equal(furniture.steadyFrameMatrixUpdates, 0);

    // Pool replacement is visual-only: no generated box or aggregate visual
    // bound may become solid, camera, interaction, or clearance authority.
    const collisionFields = ['colliders', 'collisionVertices', 'collisionRingOffsets',
      'collisionPolygonOffsets', 'collisionSpans', 'collisionMasks', 'collisionGrid'];
    const collisionAuthority = collisionFields.map(field => tile[field]);
    const furnitureFingerprint = world.streetFurniturePools.fingerprint();
    assert.equal(world.streetFurniturePools.removeOwner(tile.key), true);
    assert.equal(world.streetFurniturePools.addOwner(
      tile.key, compilation.context.streetFurniture.placements, compilation.context.streetFurniture.stride,
    ), compilation.context.streetFurniture.meta.placements);
    assert.equal(world.streetFurniturePools.fingerprint(), furnitureFingerprint);
    collisionFields.forEach((field, index) => assert.equal(tile[field], collisionAuthority[index], field));

    assert.equal(assertLowProfileBudget({
      plantRenderEntries: render.entries,
      plantRenderPools: render.activeDrawPools,
      plantRenderSourceGeometries: render.sourceGeometries,
      plantRenderGpuBytes: render.gpuGeometryBytes,
      plantRenderVisibleTriangles: render.visibleTriangles,
      plantRenderAddedDrawCalls: render.addedDrawCalls,
      plantWindUniformWritesPerFrame: render.windUniformWrites,
      plantWindCpuMatrixUpdatesPerFrame: render.windCpuMatrixUpdates,
      plantWindSteadyFrameAllocations: render.windSteadyFrameAllocations,
      streetFurnitureEntries: furniture.entries,
      streetFurnitureFamilies: furniture.sourceGeometries,
      streetFurnitureVisibleTriangles: furniture.visibleTriangles,
      streetFurnitureGpuBytes: furniture.gpuBytes,
      streetFurnitureAddedDrawCalls: furniture.addedDrawCalls,
      streetFurnitureBytesPerTile: compilation.context.streetFurniture.meta.bytes,
      streetFurniturePlacementTests: compilation.context.streetFurniture.meta.roadTests +
        compilation.context.streetFurniture.meta.buildingTests + compilation.context.streetFurniture.meta.decorationTests +
        compilation.context.streetFurniture.meta.conflictTests,
      streetFurnitureSteadyFrameMatrixUpdates: furniture.steadyFrameMatrixUpdates,
    }).ok, true);
  } finally { world.dispose(); globalThis.Worker = previousWorker; }
});

test('debug snapshot exposes bounded query roles, owners, supports, LOD, and timings', () => {
  const fixture = compileGeoFixture('dense-urban');
  const tile = {
    key: 'fixture:dense',
    colliders: fixture.buildings.colliders,
    collisionVertices: fixture.buildings.collisionVertices,
    collisionRingOffsets: fixture.buildings.collisionRingOffsets,
    collisionPolygonOffsets: fixture.buildings.collisionPolygonOffsets,
    collisionSpans: fixture.buildings.collisionSpans,
    collisionMasks: fixture.buildings.collisionMasks,
    roadSupportSegments: fixture.roads.supportSegments,
    roadSupportStride: fixture.roads.supportSegmentStride,
    supportSlots: fixture.buildings.supportSlots,
    supportSlotStates: fixture.buildings.supportSlotStates,
    supportSlotStride: fixture.buildings.supportSlotStride,
    buildingMeta: fixture.buildings.meta,
    environment: fixture.context.environment,
    morphologyDiagnostics: fixture.context.morphologyDiagnostics,
    waterDomain: fixture.context.waterDomain,
    streetFurnitureMeta: fixture.context.streetFurniture.meta,
  };
  const world = {
    tiles: new Map([[tile.key, tile]]),
    timings: { roadsMilliseconds: 2, contextMilliseconds: 4, buildingsMilliseconds: 3 },
    supportAt(x, z, out = {}) {
      return Object.assign(out, { x, y: 0, z, normalX: 0, normalY: 1, normalZ: 0, slopeRadians: 0, kind: 'road', physicalLevel: 0 });
    },
  };
  const snapshot = buildGeoDebugSnapshot(world, { x: 50, z: 50 }, { maxLineSegments: 2000 });
  assert.equal(snapshot.positions.length, snapshot.colors.length);
  assert.equal(snapshot.positions.length, snapshot.lineSegments * 6);
  assert.ok(snapshot.lineSegments <= 2000);
  assert.deepEqual(snapshot.summary.owners, ['fixture:dense']);
  assert.deepEqual(snapshot.summary.layers, [['building', 1], ['ground', 1], ['road', 1]]);
  assert.equal(snapshot.summary.collisionPolygons, 90);
  assert.ok(snapshot.summary.roadSupports > 0);
  assert.equal(snapshot.summary.supportSlots, fixture.buildings.supportSlotStates.length);
  assert.equal(snapshot.summary.occupiedSlots, fixture.buildings.meta.occupiedSupportSlots);
  assert.equal(snapshot.summary.lod, 'far:20 near:8 recipes');
  assert.equal(snapshot.summary.environmentProfiles.length, 1);
  assert.equal(snapshot.summary.environmentProfiles[0].quantizedWeights.reduce((total, value) => total + value, 0), 255);
  assert.equal(snapshot.summary.morphologyProfiles[0].namespace, fixture.context.morphologyDiagnostics.namespace);
  assert.equal(snapshot.summary.morphologyProfiles[0].packing.strideBytes, 13);
  assert.equal(snapshot.summary.waterDomainProfiles[0].namespace, 'gdo:waterDomain:v2');
  assert.equal(snapshot.summary.waterDomainProfiles[0].bytes, fixture.context.waterDomain.meta.bytes);
  assert.deepEqual(snapshot.summary.waterDomainProfiles[0].classCounts, fixture.context.waterDomain.meta.classCounts);
  assert.equal(snapshot.summary.buildingGrammarProfiles[0].namespace, 'gdo:objectGrammar:v2');
  assert.equal(snapshot.summary.buildingGrammarProfiles[0].selectedBuildings, 8);
  assert.equal(snapshot.summary.buildingGrammarProfiles[0].boxes, fixture.buildings.meta.buildingGrammar.boxes);
  assert.equal(snapshot.summary.streetFurnitureProfiles[0].namespace, 'gdo:streetFurniture:v1');
  assert.equal(snapshot.summary.streetFurnitureProfiles[0].placements, fixture.context.streetFurniture.meta.placements);
  assert.equal(snapshot.summary.focusSupport.kind, 'road');
  assert.match(snapshot.summary.masks[0][0], /player|camera/);
  assert.match(describeGeoQueryMask(GEO_QUERY_MASK.SOLID_PLAYER | GEO_QUERY_MASK.CAMERA_BLOCKER), /player\+camera/);
  const limited = buildGeoDebugSnapshot(world, { x: 50, z: 50 }, { maxLineSegments: 100 });
  assert.equal(limited.truncated, true);
  assert.equal(limited.lineSegments, 100);
  assert.equal(limited.positions.length, 600);
  assert.throws(() => buildGeoDebugSnapshot(world, {}, { maxLineSegments: 0 }), RangeError);
});

test('debug overlay adds one disposable draw only while enabled', () => {
  const scene = new THREE.Scene();
  const panel = { hidden: false, textContent: '', dataset: {} };
  const overlay = new GeoDebugOverlay(scene, panel);
  const world = {
    tiles: new Map(), root: new THREE.Group(), decorationGeometries: [],
    stats: { resident: 0, loading: 0 }, timings: null,
    plantGeometryArchetypes: { diagnostics: {
      profile: 'low', cachedArchetypes: 2, maximumBoxes: 18, maximumTriangles: 178,
      estimatedBytes: 20_000, maximumCompileMilliseconds: .8,
    } },
    plantLods: { diagnostics: {
      profile: 'low', cachedSets: 2, cachedGeometries: 6, estimatedBytes: 28_000,
      maximumCompileMilliseconds: 1.2,
    } },
    plantLodSelector: { diagnostics: {
      entries: 12, switches: 3, hysteresisHolds: 4, limits: { maxReevaluationsHz: 4 },
    } },
    plantRenderPools: { diagnostics: {
      profile: 'low', owners: 2, entries: 12, activeDrawPools: 4, drawPools: 9,
      sourceGeometries: 18, gpuGeometryBytes: 48_000, visibleTriangles: 4_200,
      addedDrawCalls: 1, repacks: 3, lastMatrixUploads: 0,
    } },
    streetFurniturePools: { diagnostics: {
      owners: 0, entries: 0, sourceGeometries: 7, activeDrawPools: 0,
      visibleTriangles: 0, gpuBytes: 120_000, addedDrawCalls: 0, steadyFrameMatrixUpdates: 0,
    } },
    mountDiagnostics: { maximumMilliseconds: 0 },
    queryDiagnostics: { maxCandidates: 0, maxSupportCandidates: 0 },
    supportAt(x, z, out = {}) { return Object.assign(out, { x, y: 0, z, normalX: 0, normalY: 1, normalZ: 0, slopeRadians: 0, kind: 'terrain', physicalLevel: 0 }); },
  };
  const renderer = { info: { render: { calls: 0, triangles: 0 } } };
  try {
    assert.equal(overlay.lines.visible, false);
    assert.equal(panel.hidden, true);
    overlay.setEnabled(true);
    overlay.update(world, { x: 0, z: 0 }, renderer, 0, true);
    assert.equal(overlay.lines.visible, true);
    assert.equal(panel.hidden, false);
    assert.match(panel.textContent, /DEBUG PASS/);
    assert.match(panel.textContent, /plant geometry low cache:2 boxes:18 tris:178 20 KiB/);
    assert.match(panel.textContent, /plant LOD low sets:2 geometries:6 27 KiB entries:12 @4Hz switches:3 holds:4/);
    assert.match(panel.textContent, /plant pools low owners:2 records:12 active:4\/9 tiers:18 GPU:47 KiB tris:4200 draw-delta:1/);
    assert.match(panel.textContent, /plant wind none strength:0.00 gust:0.00 reduced:false uniform\/frame:0 CPU-matrices:0 alloc:0/);
    assert.match(panel.textContent, /water fields 0 B\/tile · none/);
    assert.match(panel.textContent, /building grammar visible:0 boxes:0 tris:0 draw:0 0 B\/tile · none/);
    assert.match(panel.textContent, /street furniture entries:0 families:7 active:0 tris:0 draw:0 GPU:117 KiB tile:0 B · none/);
    assert.equal(overlay.metrics.plantGeometryBytes, 20_000);
    assert.equal(overlay.metrics.plantLodBytes, 28_000);
    assert.equal(overlay.metrics.plantRenderGpuBytes, 48_000);
    assert.equal(overlay.lines.geometry.attributes.position.count, 2);
    let replacedGeometryDisposed = false;
    overlay.lines.geometry.addEventListener('dispose', () => { replacedGeometryDisposed = true; });
    overlay.update(world, { x: 0, z: 0 }, renderer, 1, true);
    assert.equal(replacedGeometryDisposed, true);
    overlay.setEnabled(false);
    assert.equal(overlay.lines.visible, false);
  } finally {
    overlay.dispose();
  }
  assert.equal(scene.children.length, 0);
  assert.equal(panel.textContent, '');
});

test('canonical fixtures fit low-profile budgets and every ceiling fails clearly', () => {
  for (const descriptor of GEO_FIXTURE_MATRIX) for (const variant of descriptor.variants) {
    const compilation = compileGeoFixture(descriptor.id, variant);
    const metrics = collectGeoFixtureBudgetMetrics(compilation);
    const report = assertLowProfileBudget(metrics);
    assert.equal(report.ok, true, `${descriptor.id}/${variant}`);
  }

  const over = {
    residentTiles: GDO_LOW_PROFILE_BUDGETS.residentTiles + 1,
    activeRequests: GDO_LOW_PROFILE_BUDGETS.activeRequests + 1,
    drawCalls: GDO_LOW_PROFILE_BUDGETS.streetDrawCalls + 1,
    triangles: GDO_LOW_PROFILE_BUDGETS.visibleTriangles + 1,
    estimatedGpuBytes: GDO_LOW_PROFILE_BUDGETS.estimatedGpuBytes + 1,
    materialTextureBytes: GDO_LOW_PROFILE_BUDGETS.materialTextureBytes + 1,
    plantArchetypes: GDO_LOW_PROFILE_BUDGETS.plantArchetypes + 1,
    plantSkeletonNodes: GDO_LOW_PROFILE_BUDGETS.plantSkeletonNodes + 1,
    plantSkeletonModules: GDO_LOW_PROFILE_BUDGETS.plantSkeletonModules + 1,
    plantGeometryArchetypes: GDO_LOW_PROFILE_BUDGETS.plantGeometryArchetypes + 1,
    plantGeometryBoxes: GDO_LOW_PROFILE_BUDGETS.plantGeometryBoxes + 1,
    plantGeometryTriangles: GDO_LOW_PROFILE_BUDGETS.plantGeometryTriangles + 1,
    plantGeometryBytes: GDO_LOW_PROFILE_BUDGETS.plantGeometryBytes + 1,
    plantLodSets: GDO_LOW_PROFILE_BUDGETS.plantLodSets + 1,
    plantLodGeometries: GDO_LOW_PROFILE_BUDGETS.plantLodGeometries + 1,
    plantLodBytes: GDO_LOW_PROFILE_BUDGETS.plantLodBytes + 1,
    plantLodEntries: GDO_LOW_PROFILE_BUDGETS.plantLodEntries + 1,
    plantLodReevaluationsHz: GDO_LOW_PROFILE_BUDGETS.plantLodReevaluationsHz + 1,
    plantCompileMilliseconds: GDO_LOW_PROFILE_BUDGETS.plantCompileMilliseconds + 1,
    plantRenderEntries: GDO_LOW_PROFILE_BUDGETS.plantRenderEntries + 1,
    plantRenderPools: GDO_LOW_PROFILE_BUDGETS.plantRenderPools + 1,
    plantRenderSourceGeometries: GDO_LOW_PROFILE_BUDGETS.plantRenderSourceGeometries + 1,
    plantRenderGpuBytes: GDO_LOW_PROFILE_BUDGETS.plantRenderGpuBytes + 1,
    plantRenderVisibleTriangles: GDO_LOW_PROFILE_BUDGETS.plantRenderVisibleTriangles + 1,
    plantRenderAddedDrawCalls: GDO_LOW_PROFILE_BUDGETS.plantRenderAddedDrawCalls + 1,
    plantWindUniformWritesPerFrame: GDO_LOW_PROFILE_BUDGETS.plantWindUniformWritesPerFrame + 1,
    plantWindCpuMatrixUpdatesPerFrame: GDO_LOW_PROFILE_BUDGETS.plantWindCpuMatrixUpdatesPerFrame + 1,
    plantWindSteadyFrameAllocations: GDO_LOW_PROFILE_BUDGETS.plantWindSteadyFrameAllocations + 1,
    buildingDetailBuildings: GDO_LOW_PROFILE_BUDGETS.buildingDetailBuildings + 1,
    buildingDetailBoxes: GDO_LOW_PROFILE_BUDGETS.buildingDetailBoxes + 1,
    buildingDetailTriangles: GDO_LOW_PROFILE_BUDGETS.buildingDetailTriangles + 1,
    buildingDetailBytesPerTile: GDO_LOW_PROFILE_BUDGETS.buildingDetailBytesPerTile + 1,
    buildingDetailAddedDrawCalls: GDO_LOW_PROFILE_BUDGETS.buildingDetailAddedDrawCalls + 1,
    buildingDetailRoadTestsPerTile: GDO_LOW_PROFILE_BUDGETS.buildingDetailRoadTestsPerTile + 1,
    bridgeSegmentsPerTile: GDO_LOW_PROFILE_BUDGETS.bridgeSegmentsPerTile + 1,
    bridgeCompoundsPerTile: GDO_LOW_PROFILE_BUDGETS.bridgeCompoundsPerTile + 1,
    bridgeVisibleTriangles: GDO_LOW_PROFILE_BUDGETS.bridgeVisibleTriangles + 1,
    bridgeBytesPerTile: GDO_LOW_PROFILE_BUDGETS.bridgeBytesPerTile + 1,
    bridgeAddedDrawCalls: GDO_LOW_PROFILE_BUDGETS.bridgeAddedDrawCalls + 1,
    bridgeRailPostsPerTile: GDO_LOW_PROFILE_BUDGETS.bridgeRailPostsPerTile + 1,
    streetFurnitureEntries: GDO_LOW_PROFILE_BUDGETS.streetFurnitureEntries + 1,
    streetFurnitureFamilies: GDO_LOW_PROFILE_BUDGETS.streetFurnitureFamilies + 1,
    streetFurnitureVisibleTriangles: GDO_LOW_PROFILE_BUDGETS.streetFurnitureVisibleTriangles + 1,
    streetFurnitureGpuBytes: GDO_LOW_PROFILE_BUDGETS.streetFurnitureGpuBytes + 1,
    streetFurnitureAddedDrawCalls: GDO_LOW_PROFILE_BUDGETS.streetFurnitureAddedDrawCalls + 1,
    streetFurnitureBytesPerTile: GDO_LOW_PROFILE_BUDGETS.streetFurnitureBytesPerTile + 1,
    streetFurniturePlacementTests: GDO_LOW_PROFILE_BUDGETS.streetFurniturePlacementTests + 1,
    streetFurnitureSteadyFrameMatrixUpdates: GDO_LOW_PROFILE_BUDGETS.streetFurnitureSteadyFrameMatrixUpdates + 1,
    waterDomainBytesPerTile: GDO_LOW_PROFILE_BUDGETS.waterDomainBytesPerTile + 1,
    collisionBytesPerTile: GDO_LOW_PROFILE_BUDGETS.collisionBytesPerTile + 1,
    workerContextMilliseconds: GDO_LOW_PROFILE_BUDGETS.workerContextMilliseconds + 1,
    mainThreadMountMilliseconds: GDO_LOW_PROFILE_BUDGETS.mainThreadMountMilliseconds + 1,
    maxCollisionCandidates: GDO_LOW_PROFILE_BUDGETS.maxCollisionCandidates + 1,
    maxSupportCandidates: GDO_LOW_PROFILE_BUDGETS.maxSupportCandidates + 1,
  };
  const report = evaluateLowProfileBudget(over);
  assert.equal(report.ok, false);
  assert.deepEqual(report.breaches.map(item => item.metric), [
    'drawCalls', 'residentTiles', 'activeRequests', 'triangles', 'estimatedGpuBytes', 'materialTextureBytes',
    'plantArchetypes', 'plantSkeletonNodes', 'plantSkeletonModules', 'plantGeometryArchetypes',
    'plantGeometryBoxes', 'plantGeometryTriangles', 'plantGeometryBytes', 'plantLodSets',
    'plantLodGeometries', 'plantLodBytes', 'plantLodEntries', 'plantLodReevaluationsHz',
    'plantCompileMilliseconds', 'plantRenderEntries', 'plantRenderPools', 'plantRenderSourceGeometries', 'plantRenderGpuBytes',
    'plantRenderVisibleTriangles', 'plantRenderAddedDrawCalls', 'plantWindUniformWritesPerFrame',
    'plantWindCpuMatrixUpdatesPerFrame', 'plantWindSteadyFrameAllocations',
    'buildingDetailBuildings', 'buildingDetailBoxes', 'buildingDetailTriangles', 'buildingDetailBytesPerTile',
    'buildingDetailAddedDrawCalls', 'buildingDetailRoadTestsPerTile',
    'bridgeSegmentsPerTile', 'bridgeCompoundsPerTile', 'bridgeVisibleTriangles', 'bridgeBytesPerTile',
    'bridgeAddedDrawCalls', 'bridgeRailPostsPerTile',
    'streetFurnitureEntries', 'streetFurnitureFamilies', 'streetFurnitureVisibleTriangles', 'streetFurnitureGpuBytes',
    'streetFurnitureAddedDrawCalls', 'streetFurnitureBytesPerTile', 'streetFurniturePlacementTests',
    'streetFurnitureSteadyFrameMatrixUpdates', 'waterDomainBytesPerTile', 'collisionBytesPerTile',
    'workerContextMilliseconds', 'mainThreadMountMilliseconds',
    'maxCollisionCandidates', 'maxSupportCandidates',
  ]);
  assert.throws(() => assertLowProfileBudget(over), error =>
    error instanceof PerformanceBudgetError && /drawCalls=36 > 35/.test(error.message) &&
    /workerContextMilliseconds=151 > 150/.test(error.message));
  assert.equal(evaluateLowProfileBudget({ drawCalls: 60 }, { view: 'corner' }).ok, true);
});
