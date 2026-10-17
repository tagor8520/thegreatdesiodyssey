import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextData } from './GeoTileContext.js';
import {
  GDO_WATER_DOMAIN_NAMESPACE,
  GEO_ECOLOGICAL_DOMAIN,
  GEO_WATER_CLASS,
  GEO_WATER_DOMAIN_LIMITS,
  GEO_WATER_FLOW_SOURCE,
  GEO_WATERWAY_STRIDE,
  classifyWaterClass,
  createWaterDomain,
  queryWaterDomain,
  waterClassName,
  waterDomainByteLength,
  waterDomainTransferables,
  waterwayRibbonIntersectsPolygons,
} from './GeoWaterDomains.js';

const square = (minimumX, minimumZ, maximumX, maximumZ) => [[
  [minimumX, minimumZ], [maximumX, minimumZ], [maximumX, maximumZ], [minimumX, maximumZ],
]];

test('TER-07/08 packs deterministic shoreline, class, flow and support fields', () => {
  const options = {
    waterPolygons: [{ rings: square(0, 0, 4, 4), kind: 'lake' }],
    wetlandPolygons: [square(5, 0, 8, 3)],
    waterways: [{ segment: [0, 8, 8, 8], halfWidth: .4, kind: 'river' }],
  };
  const first = createWaterDomain(options);
  const repeated = createWaterDomain(options);
  assert.equal(first.namespace, GDO_WATER_DOMAIN_NAMESPACE);
  assert.equal(first.namespace, 'gdo:waterDomain:v2');
  assert.deepEqual(first.waterVertices, repeated.waterVertices);
  assert.deepEqual(first.waterClasses, repeated.waterClasses);
  assert.deepEqual(first.waterFlowDirections, repeated.waterFlowDirections);
  assert.deepEqual(first.waterways, repeated.waterways);
  assert.deepEqual(first.meta, {
    waterPolygons: 1,
    wetlandPolygons: 1,
    waterwaySegments: 1,
    flowingPolygons: 0,
    mappedFlowSegments: 1,
    flowAssociationTests: 0,
    classCounts: { unknown: 0, stream: 0, canal: 0, river: 1, lake: 1, ocean: 0 },
    malformedRecords: 0,
    bytes: waterDomainByteLength(first),
    capEvents: {
      waterVertices: false, wetlandVertices: false, waterwaySegments: false, flowAssociations: false, domainBytes: false,
    },
  });
  const lake = queryWaterDomain(first, 2, 2);
  assert.equal(lake.kind, GEO_ECOLOGICAL_DOMAIN.WATER);
  assert.equal(lake.groundSupport, false);
  assert.equal(lake.waterClass, GEO_WATER_CLASS.LAKE);
  assert.equal(lake.waterClassName, 'lake');
  assert.equal(lake.flowKnown, false);
  assert.equal(queryWaterDomain(first, 4.1, 2).kind, GEO_ECOLOGICAL_DOMAIN.SHORELINE);
  assert.equal(queryWaterDomain(first, 4.1, 2).waterClass, GEO_WATER_CLASS.LAKE,
    'shore and bank retain the nearest mapped polygon class');
  assert.equal(queryWaterDomain(first, 4.4, 2).kind, GEO_ECOLOGICAL_DOMAIN.BANK);
  assert.equal(queryWaterDomain(first, 6, 1).kind, GEO_ECOLOGICAL_DOMAIN.WETLAND);
  const river = queryWaterDomain(first, 4, 8.2);
  assert.equal(river.kind, GEO_ECOLOGICAL_DOMAIN.WATER);
  assert.equal(river.waterClass, GEO_WATER_CLASS.RIVER);
  assert.equal(river.flowSource, GEO_WATER_FLOW_SOURCE.WATERWAY);
  assert.ok(Math.abs(river.flowX - 1) < 1e-6);
  assert.ok(Math.abs(river.flowZ) < 1e-6);
  assert.ok(river.waterDistance < 0);
  assert.equal(first.waterwayStride, GEO_WATERWAY_STRIDE);
  assert.equal(waterDomainTransferables(first).length, 11);
});

test('TER-08 classifies provider aliases without inventing unknown map semantics', () => {
  assert.equal(classifyWaterClass({ class: 'ocean' }), GEO_WATER_CLASS.OCEAN);
  assert.equal(classifyWaterClass({ water: 'reservoir' }), GEO_WATER_CLASS.LAKE);
  assert.equal(classifyWaterClass({ kind: 'water', subclass: 'river' }), GEO_WATER_CLASS.RIVER);
  assert.equal(classifyWaterClass({ waterway: 'canal' }), GEO_WATER_CLASS.CANAL);
  assert.equal(classifyWaterClass({ type: 'drain' }), GEO_WATER_CLASS.STREAM);
  assert.equal(classifyWaterClass({ kind: 'water' }), GEO_WATER_CLASS.UNKNOWN);
  assert.equal(classifyWaterClass('', 'ocean'), GEO_WATER_CLASS.OCEAN);
  assert.equal(waterClassName(255), 'unknown');
});

test('mapped line orientation supplies polygon and local waterway flow without still-water motion', () => {
  const domain = createWaterDomain({
    waterPolygons: [
      { rings: square(0, 0, 4, 4), kind: 'river' },
      { rings: square(8, 0, 12, 4), kind: 'lake' },
      { rings: square(14, 0, 18, 4), kind: 'ocean' },
    ],
    waterways: [
      { segment: [-1, 2, 5, 2], halfWidth: .2, kind: 'river' },
      { segment: [6, 0, 6, 4], halfWidth: .2, kind: 'canal' },
      { segment: [20, 0, 20, 4], halfWidth: .2, kind: 'stream', flowDirection: 'backward' },
    ],
  });
  const polygonRiver = queryWaterDomain(domain, 2, 1);
  assert.equal(polygonRiver.waterClass, GEO_WATER_CLASS.RIVER);
  assert.equal(polygonRiver.flowSource, GEO_WATER_FLOW_SOURCE.POLYGON_WATERWAY);
  assert.ok(Math.abs(polygonRiver.flowX - 1) < 1e-4);
  assert.ok(Math.abs(polygonRiver.flowZ) < 1e-4);
  const canal = queryWaterDomain(domain, 6.1, 2);
  assert.equal(canal.waterClass, GEO_WATER_CLASS.CANAL);
  assert.equal(canal.flowSource, GEO_WATER_FLOW_SOURCE.WATERWAY);
  assert.ok(Math.abs(canal.flowX) < 1e-6 && Math.abs(canal.flowZ - 1) < 1e-6);
  const reversed = queryWaterDomain(domain, 20.1, 2);
  assert.equal(reversed.waterClass, GEO_WATER_CLASS.STREAM);
  assert.ok(Math.abs(reversed.flowZ + 1) < 1e-6);
  for (const [x, expectedClass] of [[10, GEO_WATER_CLASS.LAKE], [16, GEO_WATER_CLASS.OCEAN]]) {
    const still = queryWaterDomain(domain, x, 2);
    assert.equal(still.waterClass, expectedClass);
    assert.equal(still.flowKnown, false);
    assert.equal(still.flowX, 0);
    assert.equal(still.flowZ, 0);
  }
  assert.equal(domain.meta.flowingPolygons, 1);
  const stillLine = createWaterDomain({
    waterways: [
      { segment: [0, 0, 4, 0], halfWidth: .2, kind: 'lake' },
      { segment: [0, 2, 4, 2], halfWidth: .2, kind: 'water' },
    ],
  });
  assert.equal(queryWaterDomain(stillLine, 2, .1).flowKnown, false);
  const unknown = queryWaterDomain(stillLine, 2, 2.1);
  assert.equal(unknown.waterClass, GEO_WATER_CLASS.UNKNOWN);
  assert.equal(unknown.flowKnown, false, 'ambiguous waterway classes must not fabricate directional flow');
  assert.equal(stillLine.meta.mappedFlowSegments, 0);
});

test('LAY-04 conservatively suppresses only waterway ribbons that overlap polygon water', () => {
  const polygons = [square(0, 0, 4, 4)];
  assert.equal(waterwayRibbonIntersectsPolygons([-2, 2, 2, 2], .5, polygons), true);
  assert.equal(waterwayRibbonIntersectsPolygons([5, 2, 8, 2], .5, polygons), false);
  assert.equal(waterwayRibbonIntersectsPolygons([-.3, 5, 4.3, 5], .5, polygons), false);
  assert.equal(waterwayRibbonIntersectsPolygons([1, 1, 3, 1], .2, polygons), true);
  assert.equal(waterwayRibbonIntersectsPolygons([1, 1, 3, 1], .2, [{ rings: polygons[0], kind: 'lake' }]), true);
});

test('water domain caps and malformed-record fallback remain explicit and bounded', () => {
  const waterways = Array.from({ length: 1_250 }, (_, index) => ({
    segment: [index, 0, index, 1], halfWidth: .1, kind: 'stream',
  }));
  const domain = createWaterDomain({
    waterways: [null, { segment: [0, 0, 0, 0], width: -1 }, ...waterways],
    waterPolygons: [null, { rings: [[[0, 0], [NaN, 1], [1, 0]]], kind: 'lake' }],
  });
  assert.equal(domain.meta.waterwaySegments, 1_200);
  assert.equal(domain.meta.capEvents.waterwaySegments, true);
  assert.ok(domain.meta.malformedRecords >= 4);
  assert.equal(domain.waterways.byteLength, 1_200 * GEO_WATERWAY_STRIDE * Float32Array.BYTES_PER_ELEMENT);
  assert.equal(domain.meta.bytes, waterDomainByteLength(domain));
  assert.ok(domain.meta.bytes <= GEO_WATER_DOMAIN_LIMITS.maxDomainBytes);
  assert.throws(() => queryWaterDomain({ namespace: GDO_WATER_DOMAIN_NAMESPACE }, 0, 0), TypeError);
  assert.throws(() => queryWaterDomain(domain, NaN, 0), TypeError);
});

test('maximum polygon, wetland and flow arrays prune deterministically below the byte ceiling', () => {
  const triangles = count => Array.from({ length: count }, (_, index) => {
    const x = index * .001;
    return [[[x, 0], [x + .0004, .001], [x + .0008, 0]]];
  });
  const domain = createWaterDomain({
    waterPolygons: triangles(5_500),
    wetlandPolygons: triangles(2_800),
    waterways: Array.from({ length: GEO_WATER_DOMAIN_LIMITS.maxWaterwaySegments }, (_, index) => ({
      segment: [index, 10, index + .5, 10], kind: 'stream', halfWidth: .1,
    })),
  });
  assert.equal(domain.meta.capEvents.waterVertices, true);
  assert.equal(domain.meta.capEvents.wetlandVertices, true);
  assert.equal(domain.meta.waterwaySegments, GEO_WATER_DOMAIN_LIMITS.maxWaterwaySegments);
  assert.equal(domain.meta.bytes, waterDomainByteLength(domain));
  assert.ok(domain.meta.bytes <= GEO_WATER_DOMAIN_LIMITS.maxDomainBytes);
  const repeated = createWaterDomain({
    waterPolygons: triangles(5_500),
    wetlandPolygons: triangles(2_800),
  });
  assert.deepEqual(repeated.waterClasses, domain.waterClasses);
  assert.deepEqual(repeated.waterFlowDirections, domain.waterFlowDirections);
  const associationCapped = createWaterDomain({
    waterPolygons: triangles(30).map(rings => ({ rings, kind: 'river' })),
    waterways: Array.from({ length: GEO_WATER_DOMAIN_LIMITS.maxWaterwaySegments }, (_, index) => ({
      segment: [index, 20, index + .5, 20], kind: 'river', halfWidth: .1,
    })),
  });
  assert.equal(associationCapped.meta.flowAssociationTests, GEO_WATER_DOMAIN_LIMITS.maxFlowAssociationTests);
  assert.equal(associationCapped.meta.capEvents.flowAssociations, true);
});

test('context integration retains polygon class and hidden-waterway flow while removing transparent overlap', () => {
  const point = (x, y) => ({ x, y });
  const polygon = {
    type: 3,
    extent: 4096,
    properties: { class: 'river' },
    loadGeometry: () => [[
      point(1024, 1024), point(3072, 1024), point(3072, 3072), point(1024, 3072), point(1024, 1024),
    ]],
  };
  const line = {
    type: 2,
    extent: 4096,
    properties: { class: 'river' },
    loadGeometry: () => [[point(0, 2048), point(4096, 2048)]],
  };
  const layer = feature => ({ length: 1, feature: () => feature });
  const context = buildContextData({ layers: { water: layer(polygon), waterway: layer(line) } }, {
    tileX: 0, tileY: 0, originX: 0, originY: 0, tileSize: 100, terrainSeed: 1,
  });
  assert.equal(context.water.meta.waterwaySegmentsSuppressed, 1);
  assert.equal(context.water.positions.length / 3, 4, 'only the mapped polygon remains in the transparent mesh');
  assert.equal(context.waterDomain.meta.waterwaySegments, 1, 'the hidden duplicate still informs distance/support');
  assert.equal(context.waterDomain.meta.classCounts.river, 2);
  assert.equal(context.water.meta.waterClasses.river, 2);
  const water = queryWaterDomain(context.waterDomain, 50, 40);
  assert.equal(water.kind, GEO_ECOLOGICAL_DOMAIN.WATER);
  assert.equal(water.waterClass, GEO_WATER_CLASS.RIVER);
  assert.equal(water.flowSource, GEO_WATER_FLOW_SOURCE.POLYGON_WATERWAY);
  assert.ok(Math.abs(water.flowX - 1) < 1e-4);
  assert.ok(Math.abs(water.flowZ) < 1e-4);
});
