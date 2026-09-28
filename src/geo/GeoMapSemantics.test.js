import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GEO_BUILDING_LEVEL,
  GEO_LAND_COVER,
  GEO_MAP_ROLE,
  GEO_MAP_SCHEMA,
  GEO_PLACE_CLASS,
  GEO_ROAD_CLASS,
  createSchemaDiagnostics,
  describeMapBuilding,
  describeMapFeature,
  describeMapPlace,
  describeMapTransport,
  mapLayerNameForRole,
  mapLayerRole,
  mapLayersForRole,
  pickMapLayer,
  resolveLandCoverClass,
  resolveMapSchema,
  resolveMapWaterClass,
  resolveMapWaterKind,
  resolveRoadClass,
} from './GeoMapSemantics.js';
import { GEO_TRANSPORT_LEVEL } from './GeoLayers.js';
import { classifyWaterClass, GEO_WATER_CLASS } from './GeoWaterDomains.js';
import { compileGeoFixture } from './GeoFixtures.js';
import { buildingHeight } from './GeoTileBuilder.js';
import { GeoWorld } from './GeoWorld.js';
import { buildGeoDebugSnapshot } from './GeoDiagnostics.js';
import * as THREE from 'three';

/**
 * `MAP-08` gate: one semantic adapter must cover OpenMapTiles and Shortbread
 * classes and levels, and the live fixture compiler must prove that the same
 * mapped reality lands on the same geometry through either schema.
 */

test('layer names from both schemas resolve to one semantic role', () => {
  assert.equal(mapLayerRole('transportation'), GEO_MAP_ROLE.TRANSPORT);
  assert.equal(mapLayerRole('streets'), GEO_MAP_ROLE.TRANSPORT);
  assert.equal(mapLayerRole('transportation_name'), GEO_MAP_ROLE.TRANSPORT_LABEL);
  assert.equal(mapLayerRole('street_labels'), GEO_MAP_ROLE.TRANSPORT_LABEL);
  assert.equal(mapLayerRole('building'), GEO_MAP_ROLE.BUILDING);
  assert.equal(mapLayerRole('buildings'), GEO_MAP_ROLE.BUILDING);
  assert.equal(mapLayerRole('water'), GEO_MAP_ROLE.WATER_POLYGON);
  assert.equal(mapLayerRole('water_polygons'), GEO_MAP_ROLE.WATER_POLYGON);
  assert.equal(mapLayerRole('ocean'), GEO_MAP_ROLE.WATER_POLYGON);
  assert.equal(mapLayerRole('waterway'), GEO_MAP_ROLE.WATER_LINE);
  assert.equal(mapLayerRole('water_lines'), GEO_MAP_ROLE.WATER_LINE);
  assert.equal(mapLayerRole('landuse'), GEO_MAP_ROLE.LAND);
  assert.equal(mapLayerRole('land'), GEO_MAP_ROLE.LAND);
  assert.equal(mapLayerRole('sites'), GEO_MAP_ROLE.LAND);
  assert.equal(mapLayerRole('place'), GEO_MAP_ROLE.PLACE);
  assert.equal(mapLayerRole('place_labels'), GEO_MAP_ROLE.PLACE);
  assert.equal(mapLayerRole('boundaries'), GEO_MAP_ROLE.BOUNDARY);
  assert.equal(mapLayerRole('not_a_layer'), GEO_MAP_ROLE.UNKNOWN);
  assert.equal(mapLayerRole(undefined), GEO_MAP_ROLE.UNKNOWN);

  // Declared preference order is the existing render lift order.
  assert.deepEqual([...mapLayersForRole(GEO_MAP_ROLE.LAND)], ['land', 'landcover', 'landuse', 'park', 'sites']);
  assert.deepEqual([...mapLayersForRole(GEO_MAP_ROLE.WATER_POLYGON)], ['water_polygons', 'water', 'ocean']);
  assert.deepEqual([...mapLayersForRole(GEO_MAP_ROLE.BUILDING)], ['building', 'buildings']);
  assert.equal(mapLayerNameForRole(GEO_MAP_ROLE.TRANSPORT), 'transportation');
  const tile = { layers: { streets: { length: 2 }, buildings: { length: 1 } } };
  assert.equal(pickMapLayer(tile.layers, GEO_MAP_ROLE.TRANSPORT).name, 'streets');
  assert.equal(pickMapLayer(tile.layers, GEO_MAP_ROLE.BUILDING).name, 'buildings');
  assert.equal(pickMapLayer(tile.layers, GEO_MAP_ROLE.WATER_LINE), null);
});

test('operator provider ids and labels resolve to one schema', () => {
  assert.equal(resolveMapSchema('openfreemap'), GEO_MAP_SCHEMA.OPENMAPTILES);
  assert.equal(resolveMapSchema('OpenFreeMap / OpenMapTiles'), GEO_MAP_SCHEMA.OPENMAPTILES);
  assert.equal(resolveMapSchema('openmaptiles'), GEO_MAP_SCHEMA.OPENMAPTILES);
  assert.equal(resolveMapSchema('openstreetmap'), GEO_MAP_SCHEMA.SHORTBREAD);
  assert.equal(resolveMapSchema('https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt'), GEO_MAP_SCHEMA.SHORTBREAD);
  assert.equal(resolveMapSchema('versatiles'), GEO_MAP_SCHEMA.SHORTBREAD);
  assert.equal(resolveMapSchema('some-other-vendor'), GEO_MAP_SCHEMA.UNKNOWN);
  assert.equal(resolveMapSchema('', GEO_MAP_SCHEMA.SHORTBREAD), GEO_MAP_SCHEMA.SHORTBREAD);
});

test('both schemas normalize to the same road class, level, and flags', () => {
  const pairs = [
    [{ class: 'motorway' }, { kind: 'motorway' }, GEO_ROAD_CLASS.MOTORWAY, 'ground', 0],
    [{ class: 'primary' }, { kind: 'primary' }, GEO_ROAD_CLASS.PRIMARY, 'ground', 0],
    [{ class: 'minor', subclass: 'residential' }, { kind: 'residential' }, GEO_ROAD_CLASS.MINOR, 'ground', 0],
    [{ class: 'path', subclass: 'cycleway' }, { kind: 'cycleway' }, GEO_ROAD_CLASS.PATH, 'ground', 0],
    [{ class: 'rail', subclass: 'tram' }, { kind: 'tram', rail: true }, GEO_ROAD_CLASS.RAIL, 'ground', 0],
    [{ class: 'ferry' }, { kind: 'ferry' }, GEO_ROAD_CLASS.FERRY, 'ground', 0],
  ];
  for (const [openMapTiles, shortbread, roadClass, kind, physicalLevel] of pairs) {
    const a = describeMapTransport(openMapTiles, GEO_MAP_SCHEMA.OPENMAPTILES);
    const b = describeMapTransport(shortbread, GEO_MAP_SCHEMA.SHORTBREAD);
    assert.equal(a.roadClass, roadClass, JSON.stringify(openMapTiles));
    assert.equal(b.roadClass, roadClass, JSON.stringify(shortbread));
    assert.equal(a.kind, kind, JSON.stringify(openMapTiles));
    assert.equal(b.kind, kind, JSON.stringify(shortbread));
    assert.equal(a.physicalLevel, physicalLevel);
    assert.equal(b.physicalLevel, physicalLevel);
    assert.equal(a.surfaceY, b.surfaceY);
  }

  // OpenMapTiles carries a surveyed layer; Shortbread only has boolean flags.
  const omtBridge = describeMapTransport({ class: 'secondary', brunnel: 'bridge', layer: 2 }, GEO_MAP_SCHEMA.OPENMAPTILES);
  assert.equal(omtBridge.kind, 'bridge');
  assert.equal(omtBridge.physicalLevel, 2);
  assert.equal(omtBridge.surfaceY, omtBridge.physicalLevel * GEO_TRANSPORT_LEVEL.STEP + .025);
  const sbBridge = describeMapTransport({ kind: 'secondary', bridge: true }, GEO_MAP_SCHEMA.SHORTBREAD);
  assert.equal(sbBridge.kind, 'bridge');
  assert.equal(sbBridge.physicalLevel, GEO_TRANSPORT_LEVEL.BRIDGE);
  assert.equal(describeMapTransport({ kind: 'primary', tunnel: true }, GEO_MAP_SCHEMA.SHORTBREAD).physicalLevel, GEO_TRANSPORT_LEVEL.TUNNEL);
  // A malformed bridge+tunnel pair uses the documented stable tie-break.
  assert.equal(describeMapTransport({ class: 'primary', bridge: true, tunnel: true }, GEO_MAP_SCHEMA.OPENMAPTILES).kind, 'bridge');
  // `brunnel: 'ford'` is a ground feature, never a deck or a tunnel.
  const ford = describeMapTransport({ class: 'path', brunnel: 'ford' }, GEO_MAP_SCHEMA.OPENMAPTILES);
  assert.equal(ford.kind, 'ground');
  assert.equal(ford.ford, true);
});

test('construction, link, and unknown classes have declared canonical outcomes', () => {
  assert.deepEqual(
    [describeMapTransport({ class: 'secondary_construction' }, GEO_MAP_SCHEMA.OPENMAPTILES).roadClass,
      describeMapTransport({ class: 'secondary_construction' }, GEO_MAP_SCHEMA.OPENMAPTILES).construction],
    [GEO_ROAD_CLASS.SECONDARY, true],
  );
  assert.equal(resolveRoadClass({ class: 'motorway_junction' }, GEO_MAP_SCHEMA.OPENMAPTILES).roadClass, GEO_ROAD_CLASS.JUNCTION);
  assert.equal(resolveRoadClass({ link: true, kind: 'motorway' }, GEO_MAP_SCHEMA.SHORTBREAD).link, true);
  assert.equal(resolveRoadClass({ class: 'not-a-class' }, GEO_MAP_SCHEMA.OPENMAPTILES).roadClass, GEO_ROAD_CLASS.UNKNOWN);
  assert.equal(resolveRoadClass({}, GEO_MAP_SCHEMA.UNKNOWN).roadClass, GEO_ROAD_CLASS.UNKNOWN);
  assert.equal(resolveRoadClass({ kind: 'plane' }, GEO_MAP_SCHEMA.SHORTBREAD).rail, false);
  // Shortbread `unclassified` and OpenMapTiles `minor` are the same family.
  assert.equal(resolveRoadClass({ kind: 'unclassified' }, GEO_MAP_SCHEMA.SHORTBREAD).roadClass,
    resolveRoadClass({ class: 'minor' }, GEO_MAP_SCHEMA.OPENMAPTILES).roadClass);
});

test('building heights are canonical, and stylization is provider-independent', () => {
  const tagged = describeMapBuilding({ render_height: 18, render_min_height: 3 }, GEO_MAP_SCHEMA.OPENMAPTILES);
  assert.equal(tagged.source, GEO_BUILDING_LEVEL.HAS_HEIGHT_FIELD);
  assert.equal(tagged.heightMetres, 18);
  assert.equal(tagged.minHeightMetres, 3);
  assert.equal(tagged.hasMinHeightField, true);

  const hidden = describeMapBuilding({ render_height: 9, hide_3d: 1 }, GEO_MAP_SCHEMA.OPENMAPTILES);
  assert.equal(hidden.hidden, true);

  // Shortbread 1.0's `buildings` layer is a marker: it can only be stylized, and
  // the same footprint hash yields the same number through either schema.
  const options = { footprintArea: 6400, hash: 11 };
  const shortbread = describeMapBuilding({ dummy: 1 }, GEO_MAP_SCHEMA.SHORTBREAD, options);
  const untagged = describeMapBuilding({ class: 'building' }, GEO_MAP_SCHEMA.OPENMAPTILES, options);
  assert.equal(shortbread.source, GEO_BUILDING_LEVEL.STYLIZED);
  assert.equal(shortbread.heightMetres, untagged.heightMetres);
  assert.equal(buildingHeight({ dummy: 1 }, 6400, 11, GEO_MAP_SCHEMA.SHORTBREAD),
    buildingHeight({ class: 'building' }, 6400, 11, GEO_MAP_SCHEMA.OPENMAPTILES));
  // An explicit render_height replaces the stylized guess and keeps its own
  // clamp; the two are allowed to differ in either direction.
  assert.equal(buildingHeight({ render_height: 18 }, 6400, 11, GEO_MAP_SCHEMA.OPENMAPTILES), 1.8);
  assert.equal(buildingHeight({ render_height: 400 }, 6400, 11, GEO_MAP_SCHEMA.OPENMAPTILES), 12);
  assert.equal(buildingHeight({ render_height: 1 }, 6400, 11, GEO_MAP_SCHEMA.OPENMAPTILES), .45);
  assert.ok(Math.abs(buildingHeight({ dummy: 1 }, 6400, 11, GEO_MAP_SCHEMA.SHORTBREAD) - 2.8) < 1e-9);
  assert.notEqual(buildingHeight({ render_height: 18 }, 6400, 11, GEO_MAP_SCHEMA.OPENMAPTILES),
    buildingHeight({ dummy: 1 }, 6400, 11, GEO_MAP_SCHEMA.SHORTBREAD));
});

test('land cover, water, and place classes share one canonical vocabulary', () => {
  // Provider spellings that already match a canonical class are passed through.
  for (const value of ['wood', 'grass', 'sand', 'beach', 'park', 'garden', 'scrub', 'heath', 'residential', 'commercial', 'industrial', 'cemetery', 'meadow', 'grassland', 'farmland', 'orchard']) {
    assert.equal(resolveLandCoverClass({ class: value }), value);
    assert.equal(resolveLandCoverClass({ kind: value }), value);
  }
  // Provider-specific spellings collapse onto the canonical class.
  assert.equal(resolveLandCoverClass({ class: 'ice' }), GEO_LAND_COVER.ICE);
  assert.equal(resolveLandCoverClass({ kind: 'glacier' }), GEO_LAND_COVER.ICE);
  assert.equal(resolveLandCoverClass({ class: 'bare_rock' }), GEO_LAND_COVER.ROCK);
  assert.equal(resolveLandCoverClass({ kind: 'scree' }), GEO_LAND_COVER.ROCK);
  assert.equal(resolveLandCoverClass({ kind: 'swamp' }), GEO_LAND_COVER.WETLAND);
  assert.equal(resolveLandCoverClass({ kind: 'bog' }), GEO_LAND_COVER.WETLAND);
  assert.equal(resolveLandCoverClass({ kind: 'marsh' }), GEO_LAND_COVER.WETLAND);
  assert.equal(resolveLandCoverClass({ kind: 'village_green' }), GEO_LAND_COVER.GRASS);
  assert.equal(resolveLandCoverClass({ kind: 'allotments' }), GEO_LAND_COVER.FARMLAND);
  assert.equal(resolveLandCoverClass({ kind: 'retail' }), GEO_LAND_COVER.COMMERCIAL);
  assert.equal(resolveLandCoverClass({ kind: 'quarry' }), GEO_LAND_COVER.ROCK);
  assert.equal(resolveLandCoverClass({ kind: 'shingle' }), GEO_LAND_COVER.BEACH);
  assert.equal(resolveLandCoverClass({}, GEO_LAND_COVER.GRASS), GEO_LAND_COVER.GRASS);
  assert.equal(resolveLandCoverClass('swamp'), GEO_LAND_COVER.WETLAND);

  // Water: the `TER-08` classifier refuses to guess from a bare `water`, so the
  // schema-aware alias lives at the provider boundary and covers both spellings.
  assert.equal(classifyWaterClass({ kind: 'water' }), GEO_WATER_CLASS.UNKNOWN);
  assert.equal(resolveMapWaterClass({ kind: 'water' }, GEO_MAP_SCHEMA.SHORTBREAD), GEO_WATER_CLASS.LAKE);
  assert.equal(resolveMapWaterKind({ kind: 'water' }, GEO_MAP_SCHEMA.SHORTBREAD), 'lake');
  assert.equal(resolveMapWaterClass({ class: 'lake' }, GEO_MAP_SCHEMA.OPENMAPTILES), GEO_WATER_CLASS.LAKE);
  assert.equal(resolveMapWaterClass({ kind: 'reservoir' }, GEO_MAP_SCHEMA.SHORTBREAD), GEO_WATER_CLASS.LAKE);
  assert.equal(resolveMapWaterClass({ kind: 'dock' }, GEO_MAP_SCHEMA.SHORTBREAD), GEO_WATER_CLASS.CANAL);
  assert.equal(resolveMapWaterClass({ kind: 'water', subclass: 'river' }, GEO_MAP_SCHEMA.SHORTBREAD), GEO_WATER_CLASS.RIVER);
  assert.equal(resolveMapWaterClass({ kind: 'glacier' }, GEO_MAP_SCHEMA.SHORTBREAD), GEO_WATER_CLASS.UNKNOWN);
  assert.equal(resolveMapWaterClass({ kind: 'river' }, GEO_MAP_SCHEMA.SHORTBREAD), GEO_WATER_CLASS.RIVER);

  // Place class and label rank come from either `rank` or `population`.
  assert.equal(describeMapPlace({ class: 'city' }, GEO_MAP_SCHEMA.OPENMAPTILES).placeClass, GEO_PLACE_CLASS.CITY);
  assert.equal(describeMapPlace({ kind: 'city' }, GEO_MAP_SCHEMA.SHORTBREAD).placeClass, GEO_PLACE_CLASS.CITY);
  assert.equal(describeMapPlace({ kind: 'state_capital' }, GEO_MAP_SCHEMA.SHORTBREAD).placeClass, GEO_PLACE_CLASS.CAPITAL);
  assert.equal(describeMapPlace({ kind: 'hamlet' }, GEO_MAP_SCHEMA.SHORTBREAD).placeClass, GEO_PLACE_CLASS.VILLAGE);
  assert.equal(describeMapPlace({ class: 'town', rank: 3 }, GEO_MAP_SCHEMA.OPENMAPTILES).rank, 3);
  assert.equal(describeMapPlace({ kind: 'town', population: 9000 }, GEO_MAP_SCHEMA.SHORTBREAD).rank, 4);
  assert.equal(describeMapPlace({ kind: 'town' }, GEO_MAP_SCHEMA.SHORTBREAD).rank, 0);
});

test('one feature entry point and bounded per-tile diagnostics', () => {
  const transport = describeMapFeature({ kind: 'residential' }, { layer: 'streets', schema: GEO_MAP_SCHEMA.SHORTBREAD });
  assert.equal(transport.role, GEO_MAP_ROLE.TRANSPORT);
  assert.equal(transport.transport.roadClass, GEO_ROAD_CLASS.MINOR);
  const building = describeMapFeature({ dummy: 1 }, { layer: 'buildings', schema: GEO_MAP_SCHEMA.SHORTBREAD, footprintArea: 100, hash: 2 });
  assert.equal(building.building.source, GEO_BUILDING_LEVEL.STYLIZED);
  assert.equal(describeMapFeature({ kind: 'park' }, { layer: 'land' }).landCover, GEO_LAND_COVER.PARK);
  assert.equal(describeMapFeature({ kind: 'town' }, { layer: 'place_labels', schema: GEO_MAP_SCHEMA.SHORTBREAD }).place.placeClass, GEO_PLACE_CLASS.TOWN);
  assert.equal(describeMapFeature({ class: 'building' }, { layer: 'unknown-layer' }), null);

  const diagnostics = createSchemaDiagnostics(GEO_MAP_SCHEMA.SHORTBREAD);
  diagnostics.record(transport);
  diagnostics.record(building);
  diagnostics.record(describeMapFeature({ kind: 'park' }, { layer: 'land' }));
  diagnostics.record(describeMapFeature({ kind: 'town' }, { layer: 'place_labels', schema: GEO_MAP_SCHEMA.SHORTBREAD }));
  diagnostics.record(null);
  const report = diagnostics.diagnostics();
  assert.equal(report.schema, GEO_MAP_SCHEMA.SHORTBREAD);
  assert.deepEqual(report.roadClasses, { minor: 1 });
  assert.deepEqual(report.levels, { ground: 1 });
  assert.deepEqual(report.buildingSources, { stylized: 1 });
  assert.deepEqual(report.landCovers, { park: 1 });
  assert.deepEqual(report.places, { town: 1 });
  assert.equal(report.providerNeutral, true);
  assert.equal(Object.isFrozen(report), true);
});

test('the live compiler turns two provider vocabularies into the same geometry', () => {
  const openMapTiles = compileGeoFixture('provider-semantics', 'openmaptiles');
  const shortbread = compileGeoFixture('provider-semantics', 'shortbread');
  assert.equal(openMapTiles.request.schema, GEO_MAP_SCHEMA.OPENMAPTILES);
  assert.equal(shortbread.request.schema, GEO_MAP_SCHEMA.SHORTBREAD);

  // Roads: raw OSM `kind` and the `class`/`subclass`/`brunnel` spelling compile to
  // identical geometry, including the bridge deck level and the tram rail width.
  assert.equal(bytesEqual(openMapTiles.roads.positions, shortbread.roads.positions), true);
  assert.equal(bytesEqual(openMapTiles.roads.colors, shortbread.roads.colors), true);
  assert.equal(bytesEqual(openMapTiles.roads.supportSegments, shortbread.roads.supportSegments), true);
  assert.deepEqual(openMapTiles.roads.meta.transportLevels.levels.map(level => level.physicalLevel),
    shortbread.roads.meta.transportLevels.levels.map(level => level.physicalLevel));

  // Buildings: neither tile declares a height, so the stylized fallback matches.
  assert.equal(bytesEqual(openMapTiles.buildings.positions, shortbread.buildings.positions), true);
  assert.equal(bytesEqual(openMapTiles.buildings.colliders, shortbread.buildings.colliders), true);

  // Water bodies and their class counts agree.
  assert.equal(bytesEqual(openMapTiles.context.water.positions, shortbread.context.water.positions), true);
  assert.deepEqual(openMapTiles.context.waterDomain.meta.classCounts, shortbread.context.waterDomain.meta.classCounts);
  assert.equal(openMapTiles.context.waterDomain.meta.classCounts.lake, 1);

  // Land cover agrees in colour and class count; the only difference is the
  // per-layer z-fight lift, because the two schemas name different source layers.
  assert.equal(bytesEqual(openMapTiles.context.land.colors, shortbread.context.land.colors), true);
  assert.equal(openMapTiles.context.land.positions.length, shortbread.context.land.positions.length);
  const lift = Math.abs(openMapTiles.context.land.positions[1] - shortbread.context.land.positions[1]);
  assert.ok(lift <= .01, `land lift stays inside the declared per-layer offset range, saw ${lift}`);

  // Labels agree in name, group, and order, which is what the place adapter feeds.
  const labels = compilation => compilation.context.labels.map(({ name, kind }) => [name, kind]);
  assert.deepEqual(labels(openMapTiles), labels(shortbread));
  assert.deepEqual(labels(shortbread).map(([name]) => name),
    ['Semantics Town', 'Semantics Pond', 'Semantics Lane', 'Semantics Bridge', 'Semantics Tram']);
  assert.equal(openMapTiles.context.streetFurniture.meta.placements, shortbread.context.streetFurniture.meta.placements);
});

function bytesEqual(first, second) {
  const a = first instanceof Float32Array || first instanceof Uint32Array || first instanceof Uint16Array || first instanceof Uint8Array
    ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength)
    : new Uint8Array(first);
  const b = second instanceof Float32Array || second instanceof Uint32Array || second instanceof Uint16Array || second instanceof Uint8Array
    ? new Uint8Array(second.buffer, second.byteOffset, second.byteLength)
    : new Uint8Array(second);
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index++) if (a[index] !== b[index]) return false;
  return true;
}

test('the debug surface names the serving provider schema and its vocabulary', () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  try {
    const world = new GeoWorld(new THREE.Scene(), {
      latitude: 28.9845, longitude: 77.7064,
      providers: [{ id: 'openstreetmap', schema: 'shortbread', label: 'OpenStreetMap Shortbread', url: '/{z}/{x}/{y}.mvt', attribution: '© OpenStreetMap contributors' }],
    });
    try {
      assert.equal(world.providerSchema, GEO_MAP_SCHEMA.SHORTBREAD);
      const tile = [...world.tiles.values()][0];
      const empty = { positions: new Float32Array(), normals: new Float32Array(), colors: new Float32Array(), indices: new Uint32Array(), meta: { features: 1 } };
      // A fallback request served by the other provider must re-declare the schema.
      world._handleWorkerMessage({
        type: 'tile-phase', phase: 'roads', key: tile.key, requestId: tile.requestId,
        provider: 'OpenFreeMap / OpenMapTiles', providerId: 'openfreemap',
        geometry: { ...empty, supportSegments: new Float32Array(), supportSegmentStride: 8 },
        bytes: 1024, timings: { fetchMilliseconds: 1, roadsMilliseconds: 1 },
      });
      assert.equal(world.providerSchema, GEO_MAP_SCHEMA.OPENMAPTILES);
      const snapshot = buildGeoDebugSnapshot(world).summary;
      assert.equal(snapshot.mapSemantics.providerSchema, GEO_MAP_SCHEMA.OPENMAPTILES);
      assert.ok(snapshot.mapSemantics.roles.includes(GEO_MAP_ROLE.TRANSPORT));
      assert.ok(snapshot.mapSemantics.roles.includes(GEO_MAP_ROLE.PLACE));
      assert.ok(snapshot.mapSemantics.roadClasses.includes(GEO_ROAD_CLASS.RAIL));
    } finally {
      world.dispose();
    }
  } finally {
    globalThis.Worker = previousWorker;
  }
});
