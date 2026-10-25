/**
 * `MAP-10a` — the PMTiles provider contract and reader (`gdo:pmtiles:v1`).
 *
 * [`feature-roadmap/MAP-10_TILE_HOSTING_DECISION.md`](../../feature-roadmap/MAP-10_TILE_HOSTING_DECISION.md)
 * decides *where* a project-controlled tileset is hosted (PMTiles v3 on object
 * storage behind a CDN) and *when* it is worth building. This module is the half
 * that needs no bucket, no account, and no pipeline: it makes a PMTiles archive a
 * legal map provider and reads tiles out of one over HTTP range requests.
 *
 * Three deliberate constraints, each of which the decision document explains:
 *
 *  1. **The archive is the provider.** A provider gains `kind: 'pmtiles'` (or a
 *     `.pmtiles` URL) and keeps its id, label, schema, and attribution, so
 *     `MAP-09`'s cache keys, credit check, and TTL policy work unchanged — it stores
 *     *decoded tile payloads*, never byte ranges of a multi-gigabyte file.
 *  2. **Two ranges are pinned, everything else is per tile.** The 127-byte header
 *     and the root directory are read once per source and kept; each tile is one
 *     range. Leaf directories are fetched only when the root points at one, and
 *     are cached by offset, so a dense archive does not re-read its tree per tile.
 *  3. **Compression is named, not guessed.** PMTiles archives compress their
 *     directories and tiles independently; this reader supports `none` and `gzip`
 *     (the writer default) and refuses `brotli`/`zstd` by name rather than handing
 *     undecodable bytes to the vector-tile decoder. The pipeline must therefore
 *     emit gzip — a build-time constraint, stated in the decision record.
 *
 * Nothing here imports a library: the header parser, the LEB128 directory codec,
 * and the Hilbert tile-id mapping are local, small, and deterministic.
 */

import { featureNamespace } from '../engine/FeatureVersions.js';

export const GDO_PMTILES_NAMESPACE = featureNamespace('pmtiles');

export const GDO_PMTILES_REFUSAL = Object.freeze({
  BAD_INPUT: 'bad-input',
  BAD_PROVIDER: 'bad-provider',
  UNSUPPORTED_KIND: 'unsupported-kind',
  RANGE_FAILED: 'range-failed',
  BAD_HEADER: 'bad-header',
  UNSUPPORTED_VERSION: 'unsupported-version',
  UNSUPPORTED_COMPRESSION: 'unsupported-compression',
  OUT_OF_ZOOM: 'out-of-zoom',
  TILE_NOT_FOUND: 'tile-not-found',
  TOO_MANY_LEAVES: 'too-many-leaves',
});

export const GDO_PMTILES_MAGIC = 'PMTiles';
export const GDO_PMTILES_VERSION = 3;
export const GDO_PMTILES_HEADER_BYTES = 127;

export const GDO_PMTILES_COMPRESSION = Object.freeze({
  UNKNOWN: 0, NONE: 1, GZIP: 2, BROTLI: 3, ZSTD: 4,
});

export const GDO_PMTILES_TILE_TYPE = Object.freeze({
  UNKNOWN: 0, MVT: 1, PNG: 2, JPEG: 3, WEBP: 4, AVIF: 5,
});

/** The two kinds of provider a host may declare. */
export const GDO_PROVIDER_KIND = Object.freeze({ XYZ: 'xyz', PMTILES: 'pmtiles' });

const supportedCompression = new Set([GDO_PMTILES_COMPRESSION.NONE, GDO_PMTILES_COMPRESSION.GZIP]);

function compressionName(code) {
  return Object.entries(GDO_PMTILES_COMPRESSION).find(([, value]) => value === code)?.[0] ?? 'UNKNOWN';
}

/**
 * A provider is a PMTiles source when it says so, or when its URL is an archive.
 * Detection is exported so the fetch path and the tests agree on one rule.
 */
export function providerKind(provider) {
  if (!provider || typeof provider !== 'object') return null;
  if (provider.kind === GDO_PROVIDER_KIND.PMTILES) return GDO_PROVIDER_KIND.PMTILES;
  if (provider.kind === GDO_PROVIDER_KIND.XYZ) return GDO_PROVIDER_KIND.XYZ;
  if (provider.kind != null) return null;
  const url = typeof provider.url === 'string' ? provider.url : '';
  return /\.pmtiles(\?|#|$)/i.test(url) ? GDO_PROVIDER_KIND.PMTILES : GDO_PROVIDER_KIND.XYZ;
}

/**
 * Normalise one provider entry. A PMTiles provider carries an archive URL — no
 * `{z}/{x}/{y}` template — because the tile address is resolved inside the file.
 */
export function resolveMapProvider(provider) {
  if (!provider || typeof provider !== 'object') return { ok: false, refusal: GDO_PMTILES_REFUSAL.BAD_PROVIDER };
  const { id, url } = provider;
  if (typeof id !== 'string' || !id || typeof url !== 'string' || !url) {
    return { ok: false, refusal: GDO_PMTILES_REFUSAL.BAD_PROVIDER };
  }
  const kind = providerKind(provider);
  if (kind === null) {
    return { ok: false, refusal: GDO_PMTILES_REFUSAL.UNSUPPORTED_KIND, kind: provider.kind };
  }
  if (kind === GDO_PROVIDER_KIND.PMTILES && /[{]z[}]/.test(url)) {
    // A template and an archive are different things; refuse rather than guess.
    return { ok: false, refusal: GDO_PMTILES_REFUSAL.BAD_PROVIDER, reason: 'pmtiles-url-must-be-an-archive' };
  }
  if (kind === GDO_PROVIDER_KIND.XYZ && !/\{z\}/.test(url)) {
    return { ok: false, refusal: GDO_PMTILES_REFUSAL.BAD_PROVIDER, reason: 'xyz-url-must-be-a-template' };
  }
  return {
    ok: true,
    kind,
    provider: Object.freeze({
      id,
      kind,
      label: provider.label ?? id,
      url,
      attribution: provider.attribution ?? '',
      schema: provider.schema ?? null,
    }),
  };
}

/* ── Hilbert tile ids (PMTiles v3 §tile-id) ──────────────────────────────── */

const ZOOM_ACCUMULATOR = Array.from({ length: 27 }, (_, zoom) => (4 ** zoom - 1) / 3);

/** The PMTiles tile id for a z/x/y address. Invertible, and order-stable. */
export function zxyToTileId(z, x, y) {
  if (!Number.isInteger(z) || z < 0 || z > 26) throw new RangeError(`Unsupported zoom: ${z}`);
  const size = 2 ** z;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= size || y >= size) {
    throw new RangeError(`Tile ${x}/${y} is outside zoom ${z}`);
  }
  let tx = x, ty = y, distance = 0;
  for (let step = size >> 1; step > 0; step >>= 1) {
    const rx = (tx & step) > 0 ? 1 : 0;
    const ry = (ty & step) > 0 ? 1 : 0;
    distance += step * step * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { tx = step - 1 - tx; ty = step - 1 - ty; }
      const swap = tx; tx = ty; ty = swap;
    }
  }
  return ZOOM_ACCUMULATOR[z] + distance;
}

/** The z/x/y address for a PMTiles tile id. */
export function tileIdToZxy(tileId) {
  if (!Number.isInteger(tileId) || tileId < 0) throw new RangeError(`Unsupported tile id: ${tileId}`);
  let z = 0;
  while (z < 27 && ZOOM_ACCUMULATOR[z + 1] <= tileId) z++;
  let distance = tileId - ZOOM_ACCUMULATOR[z];
  const size = 2 ** z;
  let x = 0, y = 0;
  for (let step = 1; step < size; step <<= 1) {
    const rx = 1 & (distance >> 1);
    const ry = 1 & (distance ^ rx);
    if (ry === 0) {
      if (rx === 1) { x = step - 1 - x; y = step - 1 - y; }
      const swap = x; x = y; y = swap;
    }
    x += step * rx;
    y += step * ry;
    distance >>= 2;
  }
  return { z, x, y };
}

/* ── LEB128 + directory codec ────────────────────────────────────────────── */

function readVarint(bytes, cursor) {
  let value = 0, shift = 0;
  for (;;) {
    if (cursor.index >= bytes.length) throw new RangeError('Truncated varint');
    const byte = bytes[cursor.index++];
    value += (byte & 0x7F) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
    if (shift > 56) throw new RangeError('Varint exceeds 64 bits');
  }
}

function writeVarint(value, output) {
  let remaining = value;
  while (remaining > 0x7F) {
    output.push((remaining & 0x7F) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  output.push(remaining);
}

/**
 * Decode a directory. Entries are `{ tileId, runLength, length, offset }` with the
 * spec's three compactions: cumulative tile ids, run lengths for identical
 * neighbouring tiles, and an offset of `0` meaning "immediately after the previous
 * entry". `runLength: 0` marks an entry that points at a leaf directory.
 */
export function deserializeDirectory(bytes) {
  if (!bytes || typeof bytes.length !== 'number') return { ok: false, refusal: GDO_PMTILES_REFUSAL.BAD_INPUT };
  const cursor = { index: 0 };
  try {
    const count = readVarint(bytes, cursor);
    const entries = new Array(count);
    let tileId = 0;
    for (let index = 0; index < count; index++) {
      tileId += readVarint(bytes, cursor);
      entries[index] = { tileId, runLength: 0, length: 0, offset: 0 };
    }
    for (let index = 0; index < count; index++) entries[index].runLength = readVarint(bytes, cursor);
    for (let index = 0; index < count; index++) entries[index].length = readVarint(bytes, cursor);
    for (let index = 0; index < count; index++) {
      const offset = readVarint(bytes, cursor);
      entries[index].offset = index > 0 && offset === 0
        ? entries[index - 1].offset + entries[index - 1].length
        : offset;
    }
    return { ok: true, entries, bytes: cursor.index };
  } catch (error) {
    return { ok: false, refusal: GDO_PMTILES_REFUSAL.BAD_HEADER, reason: String(error?.message ?? error) };
  }
}

/**
 * The inverse of `deserializeDirectory`. It exists so a test can round-trip the
 * codec and so tooling can inspect or synthesise archives; runtime never writes.
 */
export function serializeDirectory(entries = []) {
  const output = [];
  writeVarint(entries.length, output);
  let previousTileId = 0;
  for (const entry of entries) {
    writeVarint(entry.tileId - previousTileId, output);
    previousTileId = entry.tileId;
  }
  for (const entry of entries) writeVarint(entry.runLength, output);
  for (const entry of entries) writeVarint(entry.length, output);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const previous = entries[index - 1];
    const compact = previous && previous.offset + previous.length === entry.offset;
    writeVarint(compact ? 0 : entry.offset, output);
  }
  return Uint8Array.from(output);
}

/**
 * Binary search for the entry covering `tileId`. A normal entry covers
 * `[tileId, tileId + runLength)`; a leaf entry (`runLength: 0`) covers everything
 * up to the next entry because its leaf holds the narrower answer.
 */
export function findDirectoryEntry(entries, tileId) {
  let low = 0, high = entries.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const entry = entries[middle];
    if (tileId < entry.tileId) { high = middle - 1; continue; }
    const next = entries[middle + 1];
    const covered = entry.runLength > 0
      ? tileId < entry.tileId + entry.runLength
      : (next ? tileId < next.tileId : true);
    if (!covered) { low = middle + 1; continue; }
    return entry;
  }
  return null;
}

function readUint64(view, offset) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('PMTiles offset exceeds safe integer range');
  return Number(value);
}

/** Parse the fixed 127-byte header. */
export function parsePmtilesHeader(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < GDO_PMTILES_HEADER_BYTES) {
    return { ok: false, refusal: GDO_PMTILES_REFUSAL.BAD_HEADER, reason: 'truncated' };
  }
  let magic = '';
  for (let index = 0; index < 7; index++) magic += String.fromCharCode(bytes[index]);
  if (magic !== GDO_PMTILES_MAGIC) {
    return { ok: false, refusal: GDO_PMTILES_REFUSAL.BAD_HEADER, reason: 'magic', magic };
  }
  const view = new DataView(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
  const version = view.getUint8(7);
  if (version !== GDO_PMTILES_VERSION) {
    return { ok: false, refusal: GDO_PMTILES_REFUSAL.UNSUPPORTED_VERSION, version };
  }
  let header;
  try {
    header = {
      magic,
      version,
      rootOffset: readUint64(view, 8),
      rootLength: readUint64(view, 16),
      metadataOffset: readUint64(view, 24),
      metadataLength: readUint64(view, 32),
      leafOffset: readUint64(view, 40),
      leafLength: readUint64(view, 48),
      tileDataOffset: readUint64(view, 56),
      tileDataLength: readUint64(view, 64),
      addressedTiles: readUint64(view, 72),
      tileEntries: readUint64(view, 80),
      tileContents: readUint64(view, 88),
      clustered: view.getUint8(96) === 1,
      internalCompression: view.getUint8(97),
      tileCompression: view.getUint8(98),
      tileType: view.getUint8(99),
      minZoom: view.getUint8(100),
      maxZoom: view.getUint8(101),
      minLon: view.getInt32(102, true) / 1e7,
      minLat: view.getInt32(106, true) / 1e7,
      maxLon: view.getInt32(110, true) / 1e7,
      maxLat: view.getInt32(114, true) / 1e7,
      centerZoom: view.getUint8(118),
      centerLon: view.getInt32(119, true) / 1e7,
      centerLat: view.getInt32(123, true) / 1e7,
    };
  } catch (error) {
    return { ok: false, refusal: GDO_PMTILES_REFUSAL.BAD_HEADER, reason: String(error?.message ?? error) };
  }
  if (!supportedCompression.has(header.internalCompression)) {
    return { ok: false, refusal: GDO_PMTILES_REFUSAL.UNSUPPORTED_COMPRESSION, channel: 'directory', compression: compressionName(header.internalCompression) };
  }
  if (!supportedCompression.has(header.tileCompression)) {
    return { ok: false, refusal: GDO_PMTILES_REFUSAL.UNSUPPORTED_COMPRESSION, channel: 'tile', compression: compressionName(header.tileCompression) };
  }
  if (header.minZoom > header.maxZoom) {
    return { ok: false, refusal: GDO_PMTILES_REFUSAL.BAD_HEADER, reason: 'zoom-range' };
  }
  return { ok: true, header: Object.freeze(header) };
}

/**
 * The default decompressor, kept injectable so a worker, a test, and a Node audit
 * can each supply their own. Only `none` and `gzip` are supported by design.
 */
export async function defaultPmtilesDecompress(bytes, compression) {
  if (compression === GDO_PMTILES_COMPRESSION.NONE) return bytes;
  if (compression !== GDO_PMTILES_COMPRESSION.GZIP) {
    throw Object.assign(new Error(`Unsupported PMTiles compression: ${compressionName(compression)}`), {
      refusal: GDO_PMTILES_REFUSAL.UNSUPPORTED_COMPRESSION,
    });
  }
  if (typeof DecompressionStream !== 'function' || typeof Response !== 'function') {
    throw Object.assign(new Error('No gzip decompressor available in this runtime'), {
      refusal: GDO_PMTILES_REFUSAL.UNSUPPORTED_COMPRESSION,
    });
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A PMTiles source. `open()` reads the header and root directory once; `getTile()`
 * is then one range request (plus one leaf read the first time a leaf is touched).
 */
export function createPmtilesSource({
  url,
  fetchRange,
  decompress = defaultPmtilesDecompress,
  maxLeafDepth = 3,
  maxCachedLeaves = 16,
} = {}) {
  if (typeof url !== 'string' || !url) throw new TypeError('PMTiles source needs an archive URL');
  if (typeof fetchRange !== 'function') throw new TypeError('PMTiles source needs a range fetcher');

  let header = null;
  let rootEntries = null;
  const leaves = new Map();
  const counters = {
    headerRequests: 0, directoryRequests: 0, leafRequests: 0, tileRequests: 0,
    rangeRequests: 0, bytesFetched: 0, leafCacheHits: 0,
  };
  const refusals = Object.fromEntries(Object.values(GDO_PMTILES_REFUSAL).map(key => [key, 0]));

  async function readRange(offset, length, signal) {
    counters.rangeRequests++;
    const bytes = await fetchRange(offset, length, signal);
    if (!bytes || typeof bytes.length !== 'number') {
      refusals[GDO_PMTILES_REFUSAL.RANGE_FAILED]++;
      throw Object.assign(new Error('Range request returned no bytes'), { refusal: GDO_PMTILES_REFUSAL.RANGE_FAILED });
    }
    if (bytes.length < length) {
      refusals[GDO_PMTILES_REFUSAL.RANGE_FAILED]++;
      throw Object.assign(new Error(`Range request returned ${bytes.length}/${length} bytes`), {
        refusal: GDO_PMTILES_REFUSAL.RANGE_FAILED,
      });
    }
    counters.bytesFetched += bytes.length;
    return bytes.length === length ? bytes : bytes.subarray(0, length);
  }

  async function readDirectory(offset, length, signal) {
    const raw = await readRange(offset, length, signal);
    const bytes = header && header.internalCompression !== GDO_PMTILES_COMPRESSION.NONE
      ? await decompress(raw, header.internalCompression) : raw;
    const parsed = deserializeDirectory(bytes);
    if (!parsed.ok) {
      refusals[parsed.refusal]++;
      throw Object.assign(new Error('Malformed PMTiles directory'), { refusal: parsed.refusal });
    }
    return parsed.entries;
  }

  async function open(signal = null) {
    if (header && rootEntries) return { ok: true, header, entries: rootEntries.entries, cached: true };
    if (!header) {
      counters.headerRequests++;
      let raw;
      try {
        raw = await readRange(0, GDO_PMTILES_HEADER_BYTES, signal);
      } catch (error) {
        return { ok: false, refusal: error?.refusal ?? GDO_PMTILES_REFUSAL.RANGE_FAILED };
      }
      const parsed = parsePmtilesHeader(raw);
      if (!parsed.ok) {
        refusals[parsed.refusal]++;
        return parsed;
      }
      header = parsed.header;
    }
    try {
      counters.directoryRequests++;
      rootEntries = { entries: await readDirectory(header.rootOffset, header.rootLength, signal) };
    } catch (error) {
      header = null;
      const refusal = error?.refusal ?? GDO_PMTILES_REFUSAL.BAD_HEADER;
      refusals[refusal]++;
      return { ok: false, refusal };
    }
    return { ok: true, header, entries: rootEntries.entries, cached: false };
  }

  async function leafAt(offset, length, signal) {
    const key = `${offset}:${length}`;
    if (leaves.has(key)) {
      counters.leafCacheHits++;
      return leaves.get(key);
    }
    counters.leafRequests++;
    const entries = await readDirectory(header.leafOffset + offset, length, signal);
    if (leaves.size >= maxCachedLeaves) leaves.delete(leaves.keys().next().value);
    leaves.set(key, entries);
    return entries;
  }

  async function findEntry(tileId, signal) {
    let entries = rootEntries.entries;
    for (let depth = 0; depth < maxLeafDepth; depth++) {
      const entry = findDirectoryEntry(entries, tileId);
      if (!entry) return null;
      if (entry.runLength > 0) return entry;
      // `runLength: 0` marks a leaf directory, addressed inside the leaf section.
      entries = await leafAt(entry.offset, entry.length, signal);
    }
    refusals[GDO_PMTILES_REFUSAL.TOO_MANY_LEAVES]++;
    return null;
  }

  /**
   * Read one tile. The returned bytes have the archive's tile compression already
   * removed, so `MAP-09`'s decoder receives exactly what an `.pbf` URL would give it.
   */
  async function getTile(z, x, y, { signal = null } = {}) {
    const startedAt = counters.rangeRequests;
    const opened = await open(signal);
    if (!opened.ok) return opened;
    if (!Number.isInteger(z) || z < header.minZoom || z > header.maxZoom) {
      refusals[GDO_PMTILES_REFUSAL.OUT_OF_ZOOM]++;
      return { ok: false, refusal: GDO_PMTILES_REFUSAL.OUT_OF_ZOOM, minZoom: header.minZoom, maxZoom: header.maxZoom };
    }
    let tileId;
    try {
      tileId = zxyToTileId(z, x, y);
    } catch (error) {
      refusals[GDO_PMTILES_REFUSAL.BAD_INPUT]++;
      return { ok: false, refusal: GDO_PMTILES_REFUSAL.BAD_INPUT, reason: String(error?.message ?? error) };
    }
    let entry;
    try {
      entry = await findEntry(tileId, signal);
    } catch (error) {
      const refusal = error?.refusal ?? GDO_PMTILES_REFUSAL.RANGE_FAILED;
      refusals[refusal]++;
      return { ok: false, refusal };
    }
    if (!entry) {
      refusals[GDO_PMTILES_REFUSAL.TILE_NOT_FOUND]++;
      return { ok: false, refusal: GDO_PMTILES_REFUSAL.TILE_NOT_FOUND, tileId, z, x, y };
    }
    counters.tileRequests++;
    let raw;
    try {
      raw = await readRange(header.tileDataOffset + entry.offset, entry.length, signal);
    } catch (error) {
      return { ok: false, refusal: error?.refusal ?? GDO_PMTILES_REFUSAL.RANGE_FAILED };
    }
    let data = raw;
    if (header.tileCompression !== GDO_PMTILES_COMPRESSION.NONE) {
      try {
        data = await decompress(raw, header.tileCompression);
      } catch (error) {
        refusals[GDO_PMTILES_REFUSAL.UNSUPPORTED_COMPRESSION]++;
        return { ok: false, refusal: GDO_PMTILES_REFUSAL.UNSUPPORTED_COMPRESSION };
      }
    }
    return {
      ok: true,
      tileId, z, x, y,
      data,
      bytes: data.length,
      tileType: header.tileType,
      // Range work this lookup actually cost, so a caller can assert it.
      ranges: counters.rangeRequests - startedAt,
    };
  }

  return Object.freeze({
    namespace: GDO_PMTILES_NAMESPACE,
    url,
    open,
    getTile,
    get header() { return header; },
    /** The pinned directory record every later lookup searches. */
    get entries() { return rootEntries?.entries ?? null; },
    get diagnostics() {
      return Object.freeze({
        namespace: GDO_PMTILES_NAMESPACE,
        url,
        opened: Boolean(header && rootEntries),
        minZoom: header?.minZoom ?? null,
        maxZoom: header?.maxZoom ?? null,
        internalCompression: header ? compressionName(header.internalCompression) : null,
        tileCompression: header ? compressionName(header.tileCompression) : null,
        ...counters,
        cachedLeaves: leaves.size,
        refusals: Object.freeze({ ...refusals }),
      });
    },
  });
}

/**
 * The real range fetcher: one `Range: bytes=a-b` request per call, validated by
 * status and body length. `206` is the expected answer; a `200` that returns the
 * whole object is tolerated (some CDNs and dev servers ignore `Range`) by slicing,
 * but a short body is refused rather than silently handed to the decoder.
 */
export function createPmtilesRangeFetcher({ url, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
  if (typeof url !== 'string' || !url) throw new TypeError('A PMTiles archive URL is required');
  return async function fetchRange(offset, length, signal = null) {
    if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length <= 0) {
      throw Object.assign(new Error('Invalid PMTiles range'), { refusal: GDO_PMTILES_REFUSAL.BAD_INPUT });
    }
    const end = offset + length - 1;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Range: `bytes=${offset}-${end}` },
      signal: signal ?? undefined,
      mode: 'cors',
      credentials: 'omit',
      cache: 'force-cache',
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
    if (!response?.ok) {
      throw Object.assign(new Error(`PMTiles range HTTP ${response?.status}`), {
        refusal: GDO_PMTILES_REFUSAL.RANGE_FAILED,
      });
    }
    const body = new Uint8Array(await response.arrayBuffer());
    // A server that ignored Range sent the whole object: slice the window we asked for.
    if (response.status === 200 && body.length > length) return body.subarray(offset, offset + length);
    if (body.length < length) {
      throw Object.assign(new Error(`Short PMTiles range body ${body.length}/${length}`), {
        refusal: GDO_PMTILES_REFUSAL.RANGE_FAILED,
      });
    }
    return body.length === length ? body : body.subarray(0, length);
  };
}

/**
 * Load one tile through a provider entry, which is what the worker's loader branch
 * calls. Sources are cached per archive URL, so the header and directory are read
 * once per session rather than once per tile.
 */
export async function loadPmtilesTile(provider, request, {
  sources = new Map(),
  fetchRange = null,
  decompress = defaultPmtilesDecompress,
  signal = null,
} = {}) {
  const resolved = resolveMapProvider(provider);
  if (!resolved.ok) return resolved;
  if (resolved.kind !== GDO_PROVIDER_KIND.PMTILES) {
    return { ok: false, refusal: GDO_PMTILES_REFUSAL.UNSUPPORTED_KIND, kind: resolved.kind };
  }
  if (!Number.isFinite(request?.zoom) || !Number.isFinite(request?.urlX) || !Number.isFinite(request?.urlY)) {
    return { ok: false, refusal: GDO_PMTILES_REFUSAL.BAD_INPUT };
  }
  const archive = resolved.provider.url;
  let source = sources.get(archive);
  if (!source) {
    const rangeFetcher = fetchRange ?? createPmtilesRangeFetcher({ url: archive });
    source = createPmtilesSource({ url: archive, fetchRange: rangeFetcher, decompress });
    sources.set(archive, source);
  }
  // `{y}` in a provider template is `urlY` verbatim (see `mapTileUrl`), so the
  // archive is addressed with the same x/y the XYZ providers are; no flip.
  return source.getTile(request.zoom, request.urlX, request.urlY, { signal });
}
