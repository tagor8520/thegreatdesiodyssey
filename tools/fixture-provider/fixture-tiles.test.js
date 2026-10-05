import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encodeFixtureVectorTile, encodeFixtureVectorTileReport } from '../../src/geo/GeoFixtureTileEncoder.js';
import { decodeVectorTile } from '../../src/geo/GeoTileBuilder.js';
import { GEO_FIXTURE_MATRIX } from '../../src/geo/GeoFixtures.js';
import { FIXTURE_TILES, fixtureTilePath } from './build-fixture-tiles.mjs';

test('committed .pbf artefacts match the encoder byte for byte', async () => {
  for (const entry of GEO_FIXTURE_MATRIX) {
    for (const variant of entry.variants) {
      const expected = encodeFixtureVectorTile(entry.id, variant);
      for (const tile of FIXTURE_TILES) {
        const path = fixtureTilePath(entry.id, variant, tile);
        let onDisk;
        try {
          onDisk = await readFile(path);
        } catch {
          assert.fail(`missing ${path} — run \`npm run fixture:tiles\``);
        }
        assert.deepEqual(
          [...onDisk], [...expected],
          `${entry.id}/${variant} z${tile.z} ${tile.x}/${tile.y}.pbf is stale — run \`npm run fixture:tiles\``,
        );
      }
    }
  }
});

test('every artefact on disk decodes as a vector tile', async () => {
  for (const entry of GEO_FIXTURE_MATRIX) {
    for (const variant of entry.variants) {
      for (const tile of FIXTURE_TILES) {
        const onDisk = await readFile(fixtureTilePath(entry.id, variant, tile));
        const decoded = decodeVectorTile(
          onDisk.buffer.slice(onDisk.byteOffset, onDisk.byteOffset + onDisk.byteLength),
        );
        assert.ok(decoded?.layers, `${entry.id}/${variant} decodes to layers`);
      }
    }
  }
});

test('the report and the encoded bytes describe the same tile', async () => {
  const report = encodeFixtureVectorTileReport('dense-urban', 'openmaptiles');
  assert.equal(report.bytes, report.data.byteLength);
  assert.deepEqual([...report.data], [...encodeFixtureVectorTile('dense-urban', 'openmaptiles')]);
});

/**
 * The safety property that matters: the production provider config on disk must
 * never list the offline fixture. The dev server injects it into the *response*
 * only (`vite.config.js` -> `fixtureProvider`, `apply: 'serve'`), so that a
 * production build can never reach a fixture tile even if a fixture exists.
 */
test('the shipped provider config never lists the offline fixture', async () => {
  const path = new URL('../../public/map-providers.json', import.meta.url);
  const config = JSON.parse(await readFile(path, 'utf8'));
  const ids = (config.providers ?? []).map(provider => provider.id);
  assert.ok(!ids.includes('gdo-offline-fixture'),
    `public/map-providers.json lists the dev-only fixture provider (${ids.join(', ')})`);
  for (const provider of config.providers ?? []) {
    assert.ok(provider.url.startsWith('https://'),
      `production provider ${provider.id} must be an absolute https URL, got ${provider.url}`);
  }
});
