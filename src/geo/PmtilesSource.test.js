import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mapTileUrl } from './GeoTileCacheFetch.js';
import {
  GDO_PMTILES_COMPRESSION,
  GDO_PMTILES_HEADER_BYTES,
  GDO_PMTILES_NAMESPACE,
  GDO_PMTILES_REFUSAL,
  GDO_PMTILES_TILE_TYPE,
  GDO_PMTILES_VERSION,
  GDO_PROVIDER_KIND,
  createPmtilesRangeFetcher,
  createPmtilesSource,
  defaultPmtilesDecompress,
  deserializeDirectory,
  findDirectoryEntry,
  loadPmtilesTile,
  parsePmtilesHeader,
  providerKind,
  resolveMapProvider,
  serializeDirectory,
  tileIdToZxy,
  zxyToTileId,
} from './PmtilesSource.js';

/* ── a synthetic PMTiles v3 archive, built here rather than downloaded ───── */

function writeHeader({
  rootOffset, rootLength, metadataOffset, metadataLength,
  leafOffset, leafLength, tileDataOffset, tileDataLength,
  addressedTiles, tileEntries, tileContents,
  internalCompression = GDO_PMTILES_COMPRESSION.NONE,
  tileCompression = GDO_PMTILES_COMPRESSION.NONE,
  minZoom, maxZoom,
}) {
  const bytes = new Uint8Array(GDO_PMTILES_HEADER_BYTES);
  for (let index = 0; index < 7; index++) bytes[index] = 'PMTiles'.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  view.setUint8(7, GDO_PMTILES_VERSION);
  const u64 = (offset, value) => view.setBigUint64(offset, BigInt(value), true);
  u64(8, rootOffset); u64(16, rootLength);
  u64(24, metadataOffset); u64(32, metadataLength);
  u64(40, leafOffset); u64(48, leafLength);
  u64(56, tileDataOffset); u64(64, tileDataLength);
  u64(72, addressedTiles); u64(80, tileEntries); u64(88, tileContents);
  view.setUint8(96, 1);                          // clustered
  view.setUint8(97, internalCompression);
  view.setUint8(98, tileCompression);
  view.setUint8(99, GDO_PMTILES_TILE_TYPE.MVT);
  view.setUint8(100, minZoom);
  view.setUint8(101, maxZoom);
  view.setInt32(102, Math.round(77.7e7), true);  // min lon
  view.setInt32(106, Math.round(28.6e7), true);  // min lat
  view.setInt32(110, Math.round(77.8e7), true);  // max lon
  view.setInt32(114, Math.round(28.7e7), true);  // max lat
  view.setUint8(118, minZoom);
  view.setInt32(119, Math.round(77.75e7), true);
  view.setInt32(123, Math.round(28.65e7), true);
  return bytes;
}

const concat = (...chunks) => {
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) { output.set(chunk, cursor); cursor += chunk.length; }
  return output;
};

/**
 * Build a valid archive: `tiles` are `{ z, x, y, data }`. With `leaf: true` the
 * root points at leaf directories instead of holding the entries itself, which is
 * how a large archival tileset is laid out.
 */
function buildArchive({ tiles, leaf = false, internalCompression = GDO_PMTILES_COMPRESSION.NONE, tileCompression = GDO_PMTILES_COMPRESSION.NONE }) {
  const addresses = tiles.map(tile => ({ ...tile, tileId: zxyToTileId(tile.z, tile.x, tile.y) }))
    .sort((a, b) => a.tileId - b.tileId);
  const payloads = addresses.map(tile => (tileCompression === GDO_PMTILES_COMPRESSION.GZIP ? gzipSync(tile.data) : tile.data));
  const tileData = concat(...payloads);

  // Entry offsets are relative to the tile-data section.
  const entries = [];
  let cursor = 0;
  for (let index = 0; index < addresses.length; index++) {
    entries.push({ tileId: addresses[index].tileId, runLength: 1, length: payloads[index].length, offset: cursor });
    cursor += payloads[index].length;
  }

  let rootEntries = entries;
  let leafBytes = new Uint8Array(0);
  if (leaf) {
    // One leaf per entry keeps the test archive small while still exercising the
    // root-to-leaf hop and the leaf cache.
    const leaves = entries.map(entry => serializeDirectory([entry]));
    rootEntries = entries.map((entry, index) => ({
      tileId: entry.tileId,
      runLength: 0,
      length: leaves[index].length,
      offset: index === 0 ? 0 : leaves.slice(0, index).reduce((size, bytes) => size + bytes.length, 0),
    }));
    leafBytes = concat(...leaves);
  }

  const rootRaw = serializeDirectory(rootEntries);
  const rootBytes = internalCompression === GDO_PMTILES_COMPRESSION.GZIP ? gzipSync(rootRaw) : rootRaw;
  const minZoom = Math.min(...addresses.map(tile => tile.z));
  const maxZoom = Math.max(...addresses.map(tile => tile.z));
  const rootOffset = GDO_PMTILES_HEADER_BYTES;
  const metadataOffset = rootOffset + rootBytes.length;
  const leafOffset = metadataOffset;
  const tileDataOffset = leafOffset + leafBytes.length;
  const header = writeHeader({
    rootOffset, rootLength: rootBytes.length,
    metadataOffset, metadataLength: 0,
    leafOffset, leafLength: leafBytes.length,
    tileDataOffset, tileDataLength: tileData.length,
    addressedTiles: addresses.length, tileEntries: entries.length, tileContents: entries.length,
    internalCompression, tileCompression, minZoom, maxZoom,
  });
  const bytes = concat(header, rootBytes, leafBytes, tileData);
  return { bytes, addresses, entries, tileDataOffset, minZoom, maxZoom };
}

/** A range fetcher over an in-memory archive that records what it was asked for. */
function memoryRange(bytes, calls = []) {
  const fetchRange = async (offset, length) => {
    calls.push({ offset, length });
    if (offset < 0 || length <= 0 || offset + length > bytes.length) {
      throw Object.assign(new Error('range out of bounds'), { refusal: GDO_PMTILES_REFUSAL.RANGE_FAILED });
    }
    return bytes.subarray(offset, offset + length);
  };
  fetchRange.calls = calls;
  return fetchRange;
}

const pmtilesOnly = (options) => {
  const archive = buildArchive(options);
  const source = createPmtilesSource({ url: 'https://tiles.example/city.pmtiles', fetchRange: memoryRange(archive.bytes) });
  return { archive, source };
};

/* ── tests ──────────────────────────────────────────────────────────────── */

test('MAP-10a parses the v3 header and refuses anything else by name', async () => {
  assert.equal(GDO_PMTILES_NAMESPACE, 'gdo:pmtiles:v1');
  const { archive, source } = pmtilesOnly({ tiles: [{ z: 2, x: 1, y: 1, data: Uint8Array.from([1, 2, 3]) }] });
  const parsed = parsePmtilesHeader(archive.bytes.subarray(0, GDO_PMTILES_HEADER_BYTES));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.header.version, 3);
  assert.equal(parsed.header.rootOffset, GDO_PMTILES_HEADER_BYTES);
  assert.equal(parsed.header.tileType, GDO_PMTILES_TILE_TYPE.MVT);
  assert.equal(parsed.header.minZoom, 2);
  assert.equal(parsed.header.maxZoom, 2);
  assert.equal(parsed.header.internalCompression, GDO_PMTILES_COMPRESSION.NONE);
  assert.ok(Math.abs(parsed.header.minLon - 77.7) < 1e-6, 'the geographic bounds survive the fixed point');
  assert.equal(source.namespace, GDO_PMTILES_NAMESPACE);

  // Magic, version, length, and unsupported compression each have their own name.
  const wrongMagic = Uint8Array.from(archive.bytes.subarray(0, GDO_PMTILES_HEADER_BYTES));
  wrongMagic[0] = 'X'.charCodeAt(0);
  assert.equal(parsePmtilesHeader(wrongMagic).refusal, GDO_PMTILES_REFUSAL.BAD_HEADER);
  const wrongVersion = Uint8Array.from(archive.bytes.subarray(0, GDO_PMTILES_HEADER_BYTES));
  wrongVersion[7] = 2;
  assert.equal(parsePmtilesHeader(wrongVersion).refusal, GDO_PMTILES_REFUSAL.UNSUPPORTED_VERSION);
  assert.equal(parsePmtilesHeader(archive.bytes.subarray(0, 40)).refusal, GDO_PMTILES_REFUSAL.BAD_HEADER);
  const brotli = Uint8Array.from(archive.bytes.subarray(0, GDO_PMTILES_HEADER_BYTES));
  brotli[98] = GDO_PMTILES_COMPRESSION.BROTLI;
  const refused = parsePmtilesHeader(brotli);
  assert.equal(refused.refusal, GDO_PMTILES_REFUSAL.UNSUPPORTED_COMPRESSION);
  assert.equal(refused.channel, 'tile');
});

test('tile ids are the reversible Hilbert mapping the format requires', async () => {
  // Zoom 0 is a single tile with id 0.
  assert.equal(zxyToTileId(0, 0, 0), 0);
  assert.deepEqual(tileIdToZxy(0), { z: 0, x: 0, y: 0 });
  // Zoom 1 starts at 1 and follows the curve, not row order.
  assert.deepEqual(
    [[0, 0], [0, 1], [1, 1], [1, 0]].map(([x, y]) => zxyToTileId(1, x, y)),
    [1, 2, 3, 4],
  );
  // Every address in a small pyramid round-trips, and ids are contiguous per zoom.
  for (let z = 0; z <= 6; z++) {
    const size = 2 ** z;
    const ids = new Set();
    for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) {
      const id = zxyToTileId(z, x, y);
      ids.add(id);
      assert.deepEqual(tileIdToZxy(id), { z, x, y }, `round trip ${z}/${x}/${y}`);
    }
    assert.equal(ids.size, size * size, 'ids are unique within a zoom');
  }
  assert.throws(() => zxyToTileId(27, 0, 0), RangeError);
  assert.throws(() => zxyToTileId(2, 4, 0), RangeError);
  assert.throws(() => tileIdToZxy(-1), RangeError);
});

test('the directory codec round-trips runs and compacted offsets', async () => {
  const entries = [
    { tileId: 3, runLength: 1, length: 10, offset: 0 },
    // Offset 0 means "immediately after the previous entry".
    { tileId: 9, runLength: 4, length: 6, offset: 10 },
    { tileId: 20, runLength: 1, length: 12, offset: 40 },
  ];
  const bytes = serializeDirectory(entries);
  const parsed = deserializeDirectory(bytes);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.entries, entries);
  assert.equal(parsed.bytes, bytes.length);

  // Search covers runs, misses, and the leaf form.
  assert.equal(findDirectoryEntry(entries, 9).runLength, 4);
  assert.equal(findDirectoryEntry(entries, 12).tileId, 9, 'inside the run');
  assert.equal(findDirectoryEntry(entries, 13), null, 'past the run');
  assert.equal(findDirectoryEntry(entries, 0), null, 'before the first entry');
  assert.equal(findDirectoryEntry(entries, 20).offset, 40);

  const leaves = [
    { tileId: 0, runLength: 0, length: 5, offset: 0 },
    { tileId: 100, runLength: 0, length: 5, offset: 5 },
  ];
  assert.equal(findDirectoryEntry(leaves, 50).tileId, 0, 'a leaf covers up to the next entry');
  assert.equal(findDirectoryEntry(leaves, 150).tileId, 100);

  assert.equal(deserializeDirectory(new Uint8Array([0x80])).ok, false);
  assert.equal(deserializeDirectory(null).refusal, GDO_PMTILES_REFUSAL.BAD_INPUT);
});

test('a tile is one range request after the header and directory are pinned', async () => {
  const calls = [];
  const tiles = [
    { z: 3, x: 2, y: 2, data: Uint8Array.from([10, 11, 12, 13]) },
    { z: 3, x: 3, y: 2, data: Uint8Array.from([20, 21]) },
  ];
  const archive = buildArchive({ tiles });
  const source = createPmtilesSource({
    url: 'https://tiles.example/city.pmtiles',
    fetchRange: memoryRange(archive.bytes, calls),
  });

  const opened = await source.open();
  assert.equal(opened.ok, true);
  assert.equal(opened.cached, false);
  assert.equal(calls.length, 2, 'one range for the header, one for the root directory');
  assert.equal(calls[0].length, GDO_PMTILES_HEADER_BYTES);

  const tile = await source.getTile(3, 2, 2);
  assert.equal(tile.ok, true);
  assert.deepEqual([...tile.data], [10, 11, 12, 13]);
  assert.equal(tile.ranges, 1, 'a tile costs exactly one range');
  assert.equal(calls.length, 3);

  // A second read of the same tile is another range, and nothing else is re-read.
  await source.getTile(3, 2, 2);
  assert.equal(calls.length, 4);
  assert.equal(source.diagnostics.headerRequests, 1, 'the header is read once');
  assert.equal(source.diagnostics.directoryRequests, 1, 'the root directory is read once');
  assert.equal(source.diagnostics.tileRequests, 2);

  // A different tile in the same archive reuses the pinned directory.
  const other = await source.getTile(3, 3, 2);
  assert.deepEqual([...other.data], [20, 21]);
  assert.equal(calls.length, 5);
  assert.equal(source.diagnostics.directoryRequests, 1);

  // Missing and out-of-zoom addresses are refusals, and cost no tile range.
  const rangesBefore = calls.length;
  const missing = await source.getTile(3, 0, 0);
  assert.equal(missing.refusal, GDO_PMTILES_REFUSAL.TILE_NOT_FOUND);
  assert.equal(calls.length, rangesBefore, 'a missing tile issues no request');
  const outOfZoom = await source.getTile(9, 0, 0);
  assert.equal(outOfZoom.refusal, GDO_PMTILES_REFUSAL.OUT_OF_ZOOM);
  assert.equal(outOfZoom.minZoom, 3);
  assert.equal(outOfZoom.maxZoom, 3);
  assert.equal((await source.getTile(3, 99, 0)).refusal, GDO_PMTILES_REFUSAL.BAD_INPUT);
  assert.equal(source.diagnostics.refusals[GDO_PMTILES_REFUSAL.TILE_NOT_FOUND], 1);
  assert.equal(source.diagnostics.refusals[GDO_PMTILES_REFUSAL.OUT_OF_ZOOM], 1);
});

test('a leaf directory is followed once and then cached', async () => {
  const calls = [];
  const tiles = [
    { z: 4, x: 5, y: 5, data: Uint8Array.from([1]) },
    { z: 4, x: 6, y: 5, data: Uint8Array.from([2]) },
    { z: 4, x: 7, y: 5, data: Uint8Array.from([3]) },
  ];
  const archive = buildArchive({ tiles, leaf: true });
  assert.ok(archive.bytes.length > GDO_PMTILES_HEADER_BYTES);

  const source = createPmtilesSource({
    url: 'https://tiles.example/dense.pmtiles',
    fetchRange: memoryRange(archive.bytes, calls),
  });
  const first = await source.getTile(4, 5, 5);
  assert.equal(first.ok, true);
  assert.deepEqual([...first.data], [1]);
  assert.equal(source.diagnostics.headerRequests, 1);
  assert.equal(source.diagnostics.directoryRequests, 1);
  assert.equal(source.diagnostics.leafRequests, 1);
  assert.equal(first.ranges, 4, 'the first read pays for the header, the root, the leaf, and the tile');

  const second = await source.getTile(4, 6, 5);
  assert.deepEqual([...second.data], [2]);
  assert.equal(second.ranges, 2, 'a new leaf and its tile');
  assert.equal(source.diagnostics.leafRequests, 2);

  // Re-reading the first tile hits both caches: header, root, and leaf are pinned.
  const again = await source.getTile(4, 5, 5);
  assert.deepEqual([...again.data], [1]);
  assert.equal(again.ranges, 1, 'only the tile itself');
  assert.equal(source.diagnostics.leafCacheHits, 1);
  assert.ok(source.diagnostics.cachedLeaves >= 2);
});

test('gzip tiles are decompressed before any decoder sees them', async () => {
  const payload = Uint8Array.from(Array.from({ length: 64 }, (_, index) => index));
  const archive = buildArchive({
    tiles: [{ z: 5, x: 10, y: 10, data: payload }],
    tileCompression: GDO_PMTILES_COMPRESSION.GZIP,
    internalCompression: GDO_PMTILES_COMPRESSION.NONE,
  });
  // An injected decompressor, which is how a worker or a Node audit supplies one.
  const source = createPmtilesSource({
    url: 'https://tiles.example/gz.pmtiles',
    fetchRange: memoryRange(archive.bytes),
    decompress: async (bytes, compression) => {
      assert.equal(compression, GDO_PMTILES_COMPRESSION.GZIP);
      return new Uint8Array(gunzipSync(bytes));
    },
  });
  const tile = await source.getTile(5, 10, 10);
  assert.equal(tile.ok, true);
  assert.deepEqual([...tile.data], [...payload], 'the caller receives plain MVT bytes');
  assert.equal(source.diagnostics.tileCompression, 'GZIP');

  // The default decompressor handles gzip too, where the runtime provides one.
  const plain = await defaultPmtilesDecompress(gzipSync(Buffer.from(payload)), GDO_PMTILES_COMPRESSION.GZIP);
  assert.deepEqual([...plain], [...payload]);
  await assert.rejects(() => defaultPmtilesDecompress(payload, GDO_PMTILES_COMPRESSION.BROTLI));

  // A gzip *directory* is handled by the same injected decompressor.
  const gzDir = buildArchive({
    tiles: [{ z: 5, x: 1, y: 1, data: Uint8Array.from([7]) }],
    internalCompression: GDO_PMTILES_COMPRESSION.GZIP,
  });
  const gzSource = createPmtilesSource({
    url: 'https://tiles.example/gzdir.pmtiles',
    fetchRange: memoryRange(gzDir.bytes),
    decompress: async bytes => new Uint8Array(gunzipSync(bytes)),
  });
  assert.equal((await gzSource.getTile(5, 1, 1)).ok, true);
});

test('the provider contract accepts an archive without disturbing the XYZ path', async () => {
  // Detection: explicit kind, archive suffix, or a template.
  assert.equal(providerKind({ kind: 'pmtiles', url: 'https://x/y' }), GDO_PROVIDER_KIND.PMTILES);
  assert.equal(providerKind({ url: 'https://x/city.pmtiles' }), GDO_PROVIDER_KIND.PMTILES);
  assert.equal(providerKind({ url: 'https://x/{z}/{x}/{y}.pbf' }), GDO_PROVIDER_KIND.XYZ);
  assert.equal(providerKind({ kind: 'nonsense', url: 'https://x/y' }), null);
  assert.equal(providerKind(null), null);

  // A project-controlled archive is a legal provider and keeps its credit, which
  // is what MAP-09 requires before it will persist a payload.
  const archiveProvider = resolveMapProvider({
    id: 'gdo-pmtiles', label: 'Project tiles', kind: 'pmtiles',
    url: 'https://tiles.gdo.example/india-2026.pmtiles',
    attribution: '© OpenStreetMap contributors · Overture Maps',
    schema: 'openmaptiles',
  });
  assert.equal(archiveProvider.ok, true);
  assert.equal(archiveProvider.kind, GDO_PROVIDER_KIND.PMTILES);
  assert.equal(archiveProvider.provider.attribution.includes('OpenStreetMap'), true);
  assert.equal(archiveProvider.provider.schema, 'openmaptiles');
  // An archive URL is not a template: `mapTileUrl` leaves it alone.
  assert.equal(mapTileUrl(archiveProvider.provider.url, { zoom: 4, urlX: 1, urlY: 2 }),
    'https://tiles.gdo.example/india-2026.pmtiles');

  // The two existing providers still resolve as templates.
  const template = resolveMapProvider({ id: 'openfreemap', url: 'https://t/{z}/{x}/{y}.pbf', attribution: 'x' });
  assert.equal(template.ok, true);
  assert.equal(template.kind, GDO_PROVIDER_KIND.XYZ);

  // Malformed or contradictory entries are refused rather than guessed at.
  assert.equal(resolveMapProvider(null).refusal, GDO_PMTILES_REFUSAL.BAD_PROVIDER);
  assert.equal(resolveMapProvider({ url: 'https://x' }).refusal, GDO_PMTILES_REFUSAL.BAD_PROVIDER);
  assert.equal(resolveMapProvider({ id: 'a' }).refusal, GDO_PMTILES_REFUSAL.BAD_PROVIDER);
  assert.equal(resolveMapProvider({ id: 'a', kind: 'weird', url: 'https://x' }).refusal,
    GDO_PMTILES_REFUSAL.UNSUPPORTED_KIND);
  assert.equal(resolveMapProvider({ id: 'a', kind: 'pmtiles', url: 'https://x/{z}/{y}.pbf' }).refusal,
    GDO_PMTILES_REFUSAL.BAD_PROVIDER, 'a PMTiles provider must name an archive, not a template');
  assert.equal(resolveMapProvider({ id: 'a', url: 'https://tiles.example/archive.bin' }).refusal,
    GDO_PMTILES_REFUSAL.BAD_PROVIDER, 'an XYZ provider must name a template');
});

test('one loader call serves a tile and shares its source between calls', async () => {
  const calls = [];
  const archive = buildArchive({
    tiles: [
      { z: 6, x: 20, y: 20, data: Uint8Array.from([9, 9]) },
      { z: 6, x: 21, y: 20, data: Uint8Array.from([8]) },
    ],
  });
  const provider = { id: 'gdo', url: 'https://tiles.example/six.pmtiles', attribution: 'x' };
  const sources = new Map();
  const fetchRange = memoryRange(archive.bytes, calls);

  const first = await loadPmtilesTile(provider, { zoom: 6, urlX: 20, urlY: 20 }, { sources, fetchRange });
  assert.equal(first.ok, true);
  assert.deepEqual([...first.data], [9, 9]);
  assert.equal(sources.size, 1, 'one source per archive URL');
  assert.equal(calls.length, 3, 'header, root, tile');

  const second = await loadPmtilesTile(provider, { zoom: 6, urlX: 21, urlY: 20 }, { sources, fetchRange });
  assert.deepEqual([...second.data], [8]);
  assert.equal(calls.length, 4, 'the second tile reuses the pinned header and directory');
  assert.equal(sources.size, 1);

  // A non-PMTiles provider is a named refusal, not a silent fallback.
  const wrong = await loadPmtilesTile({ id: 'x', url: 'https://t/{z}/{x}/{y}.pbf' }, { zoom: 1, urlX: 0, urlY: 0 }, { sources, fetchRange });
  assert.equal(wrong.refusal, GDO_PMTILES_REFUSAL.UNSUPPORTED_KIND);
  const malformed = await loadPmtilesTile(provider, { zoom: 6 }, { sources, fetchRange });
  assert.equal(malformed.refusal, GDO_PMTILES_REFUSAL.BAD_INPUT);
});

test('the range fetcher sends one bounded request and validates the answer', async () => {
  const body = Uint8Array.from(Array.from({ length: 300 }, (_, index) => index & 0xFF));
  const seen = [];
  const fetcher = createPmtilesRangeFetcher({
    url: 'https://tiles.example/city.pmtiles',
    fetchImpl: async (url, init) => {
      seen.push({ url, range: init.headers.Range, method: init.method });
      const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
      const start = Number(match[1]), end = Number(match[2]);
      return {
        ok: true,
        status: 206,
        arrayBuffer: async () => body.slice(start, end + 1).buffer,
      };
    },
  });
  const bytes = await fetcher(10, 20);
  assert.equal(bytes.length, 20);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].range, 'bytes=10-29', 'the range is inclusive and bounded');

  // A CDN that ignores Range answers 200 with the whole object; slice the window.
  const ignoring = createPmtilesRangeFetcher({
    url: 'https://tiles.example/city.pmtiles',
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(0) }),
  });
  assert.deepEqual([...(await ignoring(5, 4))], [...body.subarray(5, 9)]);

  // A short body means the server lied: refuse rather than hand bytes to the decoder.
  const short = createPmtilesRangeFetcher({
    url: 'https://tiles.example/city.pmtiles',
    fetchImpl: async () => ({ ok: true, status: 206, arrayBuffer: async () => body.slice(0, 3).buffer }),
  });
  await assert.rejects(() => short(10, 20), /Short PMTiles range body/);
  // An HTTP failure is a range failure with a name.
  const broken = createPmtilesRangeFetcher({
    url: 'https://tiles.example/city.pmtiles',
    fetchImpl: async () => ({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  await assert.rejects(() => broken(0, 127), error => error.refusal === GDO_PMTILES_REFUSAL.RANGE_FAILED);
  // And the obvious preconditions are checked before any request is made.
  await assert.rejects(() => broken(0, 0), error => error.refusal === GDO_PMTILES_REFUSAL.BAD_INPUT);
  assert.throws(() => createPmtilesRangeFetcher({ url: '', fetchImpl: async () => ({}) }), TypeError);
});
