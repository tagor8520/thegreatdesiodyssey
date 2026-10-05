/**
 * Encodes a canonical geographic fixture into a real, spec-valid Mapbox Vector
 * Tile (MVT) protobuf.
 *
 * WHY THIS EXISTS
 * ---------------
 * The canonical fixtures in `GeoFixtures.js` already compile through the exact
 * production builders (`buildRoadGeometry`, `buildContextData`,
 * `buildBuildingGeometry`), but tests call those builders directly. Nothing
 * exercised the *wire* path: fetch → `decodeVectorTile` → builders.
 *
 * That gap meant every mapped-geometry feature (`COL-05` camera obstruction
 * around buildings, `LAY-03` transparent-water order) could only be audited
 * against live vector-tile servers, which are unreachable in restricted build
 * environments. This encoder closes the gap: it turns a fixture into the same
 * bytes a public tile server would return, so the real worker, decoder, and
 * builders run end to end with no network.
 *
 * COORDINATE FAITHFULNESS
 * -----------------------
 * Fixture geometry is authored in `0..GEO_FIXTURE_EXTENT` (4096) units, which is
 * exactly MVT's standard layer extent. `GeoTileBuilder.pointToWorld` consumes
 * `feature.extent` and maps `point.x / extent` into tile-local space, so an
 * encode → decode round trip with `extent = 4096` reproduces the authored
 * geometry exactly. `GeoFixtureTileEncoder.test.js` asserts that equivalence
 * rather than assuming it.
 *
 * This is development tooling. It is not imported by any runtime entry point.
 */
import { PbfWriter } from 'pbf';
import { createGeoFixture, GEO_FIXTURE_EXTENT } from './GeoFixtures.js';

// MVT GeometryType enum.
const GEOMETRY_POINT = 1;
const GEOMETRY_LINE = 2;
const GEOMETRY_POLYGON = 3;
// MVT command ids, packed as (id & 0x7) | (count << 3).
const COMMAND_MOVE_TO = 1;
const COMMAND_LINE_TO = 2;
const COMMAND_CLOSE_PATH = 7;

export const GEO_FIXTURE_TILE_SCHEMA = 'gdo:fixtureVectorTile:v1';

function command(id, count) {
  return (id & 0x7) | (count << 3);
}

/** MVT parameters are zigzag-encoded deltas. */
function zigzag(value) {
  return value < 0 ? ~value << 1 | 1 : value << 1;
}

function assertInteger(value, label) {
  if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer for MVT encoding, received ${value}`);
  if (value < 0 || value > GEO_FIXTURE_EXTENT) {
    throw new RangeError(`${label} ${value} falls outside the 0..${GEO_FIXTURE_EXTENT} fixture extent`);
  }
  return value;
}

function writeValue(value, pbf) {
  if (typeof value === 'string') pbf.writeStringField(1, value);
  else if (typeof value === 'boolean') pbf.writeBooleanField(7, value);
  else if (Number.isInteger(value)) pbf.writeSVarintField(6, value);
  else if (typeof value === 'number' && Number.isFinite(value)) pbf.writeDoubleField(3, value);
  else if (value == null) pbf.writeStringField(1, '');
  else throw new TypeError(`Unsupported MVT property value: ${String(value)}`);
}

function writeFeature(feature, pbf, keyIndex, valueIndex) {
  pbf.writeVarintField(1, feature.id);
  const tags = [];
  for (const [key, value] of Object.entries(feature.properties)) {
    tags.push(keyIndex.get(key), valueIndex.get(`${key}\u0000${String(value)}`));
  }
  if (tags.length) pbf.writePackedVarint(2, tags);
  pbf.writeVarintField(3, feature.type);

  const parts = feature.loadGeometry();
  const geometry = [];
  let cursorX = 0;
  let cursorY = 0;
  for (const part of parts) {
    if (!part.length) continue;
    if (feature.type === GEOMETRY_POINT) {
      geometry.push(command(COMMAND_MOVE_TO, 1));
      const x = assertInteger(part[0].x, 'point x');
      const y = assertInteger(part[0].y, 'point y');
      geometry.push(zigzag(x - cursorX), zigzag(y - cursorY));
      cursorX = x;
      cursorY = y;
      continue;
    }
    // MVT closes a ring implicitly via ClosePath, so an authored duplicate
    // closing vertex must not be emitted as a LineTo or the decoder would
    // return it as a real vertex.
    const points = [...part];
    if (feature.type === GEOMETRY_POLYGON && points.length > 1) {
      const first = points[0];
      const last = points[points.length - 1];
      if (first.x === last.x && first.y === last.y) points.pop();
    }
    if (points.length < 2) continue;

    geometry.push(command(COMMAND_MOVE_TO, 1));
    let x = assertInteger(points[0].x, 'ring x');
    let y = assertInteger(points[0].y, 'ring y');
    geometry.push(zigzag(x - cursorX), zigzag(y - cursorY));
    cursorX = x;
    cursorY = y;

    geometry.push(command(COMMAND_LINE_TO, points.length - 1));
    for (let index = 1; index < points.length; index++) {
      x = assertInteger(points[index].x, 'ring x');
      y = assertInteger(points[index].y, 'ring y');
      geometry.push(zigzag(x - cursorX), zigzag(y - cursorY));
      cursorX = x;
      cursorY = y;
    }
    if (feature.type === GEOMETRY_POLYGON) geometry.push(command(COMMAND_CLOSE_PATH, 1));
  }
  pbf.writePackedVarint(4, geometry);
}

function writeLayer(layer, pbf) {
  pbf.writeVarintField(15, 2); // MVT version
  pbf.writeStringField(1, layer.name);
  pbf.writeVarintField(5, GEO_FIXTURE_EXTENT);

  const features = [];
  for (let index = 0; index < layer.source.length; index++) features.push(layer.source.feature(index));

  // MVT requires de-duplicated key/value tables, so build them in first-seen order.
  const keys = [];
  const values = [];
  const keyIndex = new Map();
  const valueIndex = new Map();
  for (const feature of features) {
    for (const [key, value] of Object.entries(feature.properties)) {
      if (!keyIndex.has(key)) { keyIndex.set(key, keys.length); keys.push(key); }
      const valueKey = `${key}\u0000${String(value)}`;
      if (!valueIndex.has(valueKey)) { valueIndex.set(valueKey, values.length); values.push(value); }
    }
  }
  for (const key of keys) pbf.writeStringField(3, key);
  for (const value of values) pbf.writeMessage(4, writeValue, value);
  for (const feature of features) pbf.writeMessage(2, (item, writer) => writeFeature(item, writer, keyIndex, valueIndex), feature);
}

/**
 * Encode one fixture variant as MVT bytes.
 * @returns {Uint8Array} a decodable vector tile.
 */
export function encodeFixtureVectorTile(id, variant = 'openmaptiles') {
  const fixture = createGeoFixture(id, variant);
  const pbf = new PbfWriter();
  for (const [name, source] of Object.entries(fixture.vectorTile.layers)) {
    pbf.writeMessage(3, writeLayer, { name, source });
  }
  return pbf.finish();
}

/**
 * Encode a fixture and describe it, for diagnostics and the dev provider's
 * response logging.
 */
export function encodeFixtureVectorTileReport(id, variant = 'openmaptiles') {
  const fixture = createGeoFixture(id, variant);
  const bytes = encodeFixtureVectorTile(id, variant);
  const layers = Object.entries(fixture.vectorTile.layers).map(([name, source]) => ({
    name, features: source.length,
  }));
  return {
    schema: GEO_FIXTURE_TILE_SCHEMA,
    id, variant,
    category: fixture.category,
    bytes: bytes.byteLength,
    layers,
    data: bytes,
  };
}
