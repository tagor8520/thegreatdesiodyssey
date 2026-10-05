import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeVectorTile, buildRoadGeometry, buildBuildingGeometry } from './GeoTileBuilder.js';
import { buildContextData } from './GeoTileContext.js';
import {
  encodeFixtureVectorTile,
  encodeFixtureVectorTileReport,
  GEO_FIXTURE_TILE_SCHEMA,
} from './GeoFixtureTileEncoder.js';
import { createGeoFixture, GEO_FIXTURE_EXTENT, GEO_FIXTURE_MATRIX } from './GeoFixtures.js';

const CASES = GEO_FIXTURE_MATRIX.flatMap(entry =>
  entry.variants.map(variant => ({ id: entry.id, variant })));

function fixtureFeatureList(fixture) {
  const layers = [];
  for (const [name, source] of Object.entries(fixture.vectorTile.layers)) {
    const features = [];
    for (let index = 0; index < source.length; index++) {
      const feature = source.feature(index);
      features.push({
        id: feature.id,
        type: feature.type,
        extent: feature.extent,
        properties: { ...feature.properties },
        // Compare in extent space, which is what the encoder preserves.
        geometry: feature.loadGeometry().map(part => part.map(point => [point.x, point.y])),
      });
    }
    layers.push({ name, features });
  }
  return layers;
}

function decodedFeatureList(vectorTile) {
  const layers = [];
  for (const name of Object.keys(vectorTile.layers)) {
    const layer = vectorTile.layers[name];
    const features = [];
    for (let index = 0; index < layer.length; index++) {
      const feature = layer.feature(index);
      features.push({
        id: feature.id,
        type: feature.type,
        extent: feature.extent,
        properties: { ...feature.properties },
        geometry: feature.loadGeometry().map(part => part.map(point => [point.x, point.y])),
      });
    }
    layers.push({ name, features });
  }
  return layers;
}

/**
 * Normalise a polygon ring for comparison. The encoder drops the authored
 * duplicate closing vertex because MVT expresses closure with a command, and the
 * decoder re-adds a closing vertex. Both sides therefore describe the same ring;
 * this removes the redundant final point so the comparison is about geometry.
 */
function normaliseRing(ring) {
  if (ring.length > 1) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  }
  return ring;
}

function normaliseGeometry(type, geometry) {
  if (type !== 3) return geometry;
  return geometry.map(normaliseRing);
}

test('every canonical fixture encodes to a decodable vector tile', () => {
  for (const { id, variant } of CASES) {
    const bytes = encodeFixtureVectorTile(id, variant);
    assert.ok(bytes instanceof Uint8Array, `${id}/${variant} encodes to bytes`);
    assert.ok(bytes.byteLength > 0, `${id}/${variant} is non-empty`);
    const decoded = decodeVectorTile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.ok(Object.keys(decoded.layers).length > 0, `${id}/${variant} decodes to layers`);
  }
});

test('encode then decode reproduces fixture geometry, properties and layer names exactly', () => {
  for (const { id, variant } of CASES) {
    const fixture = createGeoFixture(id, variant);
    const authored = fixtureFeatureList(fixture);
    const bytes = encodeFixtureVectorTile(id, variant);
    const decoded = decodedFeatureList(decodeVectorTile(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ));

    assert.deepEqual(decoded.map(layer => layer.name), authored.map(layer => layer.name),
      `${id}/${variant} preserves layer names and order`);

    for (let layerIndex = 0; layerIndex < authored.length; layerIndex++) {
      const expected = authored[layerIndex];
      const actual = decoded[layerIndex];
      assert.equal(actual.features.length, expected.features.length,
        `${id}/${variant}/${expected.name} preserves feature count`);
      for (let featureIndex = 0; featureIndex < expected.features.length; featureIndex++) {
        const expectedFeature = expected.features[featureIndex];
        const actualFeature = actual.features[featureIndex];
        const label = `${id}/${variant}/${expected.name}#${expectedFeature.id}`;
        assert.equal(actualFeature.id, expectedFeature.id, `${label} id`);
        assert.equal(actualFeature.type, expectedFeature.type, `${label} geometry type`);
        assert.equal(actualFeature.extent, GEO_FIXTURE_EXTENT, `${label} extent`);
        assert.deepEqual(actualFeature.properties, expectedFeature.properties, `${label} properties`);
        assert.deepEqual(
          normaliseGeometry(actualFeature.type, actualFeature.geometry),
          normaliseGeometry(expectedFeature.type, expectedFeature.geometry),
          `${label} geometry`,
        );
      }
    }
  }
});

test('encoding is byte-stable across runs', () => {
  for (const { id, variant } of CASES.slice(0, 3)) {
    const first = encodeFixtureVectorTile(id, variant);
    const second = encodeFixtureVectorTile(id, variant);
    assert.deepEqual([...first], [...second], `${id}/${variant} is deterministic`);
  }
});

test('the report describes the encoded tile without re-encoding divergently', () => {
  const report = encodeFixtureVectorTileReport('dense-urban');
  assert.equal(report.schema, GEO_FIXTURE_TILE_SCHEMA);
  assert.equal(report.bytes, report.data.byteLength);
  assert.ok(report.layers.some(layer => layer.name === 'building'));
  assert.ok(report.layers.every(layer => layer.features > 0));
});

/**
 * The property that actually matters for the blocked visual gates: a decoded
 * fixture tile must drive the production builders to the same non-empty output
 * as the direct fixture compile. That is what makes mapped buildings and water
 * available offline for `COL-05` and `LAY-03`.
 */
test('decoded fixture tiles drive the production builders to equivalent output', () => {
  for (const { id, variant } of CASES) {
    const request = {
      requestId: 1, key: `fixture:${id}:${variant}`,
      tileX: 0, tileY: 0, originX: 0, originY: 0, tileSize: 100,
      latitude: 28.9845, longitude: 77.7064,
    };
    const bytes = encodeFixtureVectorTile(id, variant);
    const decoded = decodeVectorTile(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    const direct = createGeoFixture(id, variant);

    // Roads
    const wiredRoads = buildRoadGeometry(decoded, request);
    const directRoads = buildRoadGeometry(direct.vectorTile, request);
    assert.deepEqual([...wiredRoads.positions], [...directRoads.positions],
      `${id}/${variant} road positions match through the wire path`);
    assert.deepEqual([...wiredRoads.indices], [...directRoads.indices],
      `${id}/${variant} road indices match through the wire path`);

    // Context (land, water, water domain, decorations, environment)
    const wiredContext = buildContextData(decoded, request);
    const directContext = buildContextData(direct.vectorTile, request);
    assert.deepEqual([...wiredContext.land.positions], [...directContext.land.positions],
      `${id}/${variant} land positions match through the wire path`);
    assert.deepEqual([...wiredContext.water.positions], [...directContext.water.positions],
      `${id}/${variant} water positions match through the wire path`);
    assert.deepEqual([...wiredContext.waterDomain.waterVertices],
      [...directContext.waterDomain.waterVertices],
      `${id}/${variant} water domain matches through the wire path`);

    // Buildings (the COL-05 orbit targets and collision rings)
    const wiredBuildings = buildBuildingGeometry(decoded, request);
    const directBuildings = buildBuildingGeometry(direct.vectorTile, request);
    assert.deepEqual([...wiredBuildings.positions], [...directBuildings.positions],
      `${id}/${variant} building positions match through the wire path`);
    assert.deepEqual([...wiredBuildings.colliders], [...directBuildings.colliders],
      `${id}/${variant} building colliders match through the wire path`);
  }
});

test('dense-urban and mapped-coast carry the geometry the blocked gates need', () => {
  const dense = buildBuildingGeometry(createGeoFixture('dense-urban').vectorTile, {
    tileX: 0, tileY: 0, originX: 0, originY: 0, tileSize: 100,
  });
  assert.ok(dense.colliders.length >= 90, 'dense-urban supplies buildings to orbit');

  const coast = buildContextData(createGeoFixture('mapped-coast').vectorTile, {
    tileX: 0, tileY: 0, originX: 0, originY: 0, tileSize: 100,
  });
  assert.ok(coast.water.indices.length > 0, 'mapped-coast supplies transparent water');
  assert.ok(coast.waterDomain.waterClasses.length > 0, 'mapped-coast supplies water classes');
});
