#!/usr/bin/env node
/**
 * Write the canonical fixtures to disk as real MVT `.pbf` files.
 *
 * The dev server encodes tiles on demand (`vite.config.js` -> `fixtureProvider`),
 * which is what the visual audits use. This script produces the same bytes as
 * static artefacts under `public/fixture-tiles/` so the encoding is inspectable
 * with external tooling (tippecanoe, QGIS, mapbox/vector-tile) and reviewable in
 * a diff.
 *
 * The two can never drift: `tools/fixture-provider/fixture-tiles.test.js` asserts
 * every file on disk is byte-identical to a fresh encode.
 *
 *   npm run fixture:tiles
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFixtureVectorTileReport } from '../../src/geo/GeoFixtureTileEncoder.js';
import { GEO_FIXTURE_MATRIX } from '../../src/geo/GeoFixtures.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURE_TILE_ROOT = join(ROOT, 'public/fixture-tiles');

// The provider URL template substitutes {z}/{x}/{y}; the fixture is not
// geographically anchored, so any tile coordinate resolves to the same bytes.
// Record a small deterministic set so the artefacts are concrete and diffable.
export const FIXTURE_TILES = [
  { z: 14, x: 11728, y: 6812 },
  { z: 15, x: 23456, y: 13625 },
];

export function fixtureTilePath(id, variant, { z, x, y }) {
  return join(FIXTURE_TILE_ROOT, id, variant, String(z), String(x), `${y}.pbf`);
}

export async function writeFixtureTiles() {
  const written = [];
  for (const entry of GEO_FIXTURE_MATRIX) {
    for (const variant of entry.variants) {
      const report = encodeFixtureVectorTileReport(entry.id, variant);
      for (const tile of FIXTURE_TILES) {
        const path = fixtureTilePath(entry.id, variant, tile);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.from(report.data));
        written.push({ id: entry.id, variant, ...tile, path, bytes: report.bytes });
      }
    }
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const written = await writeFixtureTiles();
  const total = written.reduce((sum, item) => sum + item.bytes, 0);
  console.log(`Wrote ${written.length} fixture tiles (${total} bytes) to public/fixture-tiles/`);
  for (const item of written) {
    console.log(`  ${item.id}/${item.variant} z${item.z} ${item.x}/${item.y}.pbf  ${item.bytes} B`);
  }
}
