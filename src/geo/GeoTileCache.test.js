/**
 * `MAP-09` — the bounded persistent tile cache (Node tier).
 *
 * The registered gate is *"Size/version/LRU policy and attribution-safe storage"*,
 * and this file gives each clause its own teeth:
 *
 * - **size** — the byte ceiling and the entry ceiling are both enforced, the
 *   accounting is the sum of what the store holds (not a counter that can drift),
 *   a payload larger than the single-entry ceiling is refused rather than stored,
 *   and a full disk costs the cache an entry rather than the runtime a tile.
 * - **version** — the record format lives in the namespace and in the IndexedDB
 *   database version, a manifest from another format or another namespace empties
 *   the store instead of being interpreted, and entries outside the namespace are
 *   not adopted.
 * - **LRU** — eviction order is *least recently used*, not least recently stored:
 *   reading an entry moves it to the front of the queue, the order survives a
 *   reopen, and ties break by key so the victim does not depend on insertion order.
 * - **attribution-safe storage** — an entry is keyed and recorded by the source
 *   that produced it (id, URL template and declared label), a provider that
 *   forbids caching is never stored, and a sweep removes what the application no
 *   longer declares.
 *
 * The browser tier (`tools/visual-audit/scenarios/tile-cache.mjs`) proves the
 * integration: that the *provider* receives no request on a revisit, that the
 * entries are really in IndexedDB, and that the world still builds when storage is
 * denied. This file proves the policy, which is why it can drive an injected clock
 * and a hostile adapter that a browser cannot be asked to produce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GEO_TILE_CACHE_LIMITS,
  GEO_TILE_CACHE_MANIFEST_KEY,
  GEO_TILE_CACHE_NAMESPACE,
  GEO_TILE_CACHE_RECORD_OVERHEAD,
  GEO_TILE_CACHE_SCHEMA,
  GEO_TILE_CACHE_BYTES_BY_PROFILE,
  GeoTileCache,
  createMemoryTileStorage,
  createNullTileStorage,
  providerCachePolicy,
  providerFingerprint,
  tileCacheBytesForProfile,
  tileCacheKey,
} from './GeoTileCache.js';

const PROVIDER = Object.freeze({ id: 'openfreemap', label: 'OpenFreeMap / OpenMapTiles', url: 'https://tiles.example/{z}/{x}/{y}.pbf' });
const OTHER_PROVIDER = Object.freeze({ id: 'openstreetmap', label: 'OpenStreetMap Shortbread', url: 'https://vector.example/shortbread_v1/{z}/{x}/{y}.mvt' });

/** Four bytes of payload per tile, so the arithmetic in an assertion is readable. */
function payload(size = 4, fill = 0) {
  return new Uint8Array(size).fill(fill).buffer;
}

const TILE = { zoom: 14, x: 12034, y: 7611 };
const TILE_B = { zoom: 14, x: 12035, y: 7611 };
const TILE_C = { zoom: 14, x: 12035, y: 7612 };
const TILE_D = { zoom: 14, x: 12036, y: 7612 };

function keyFor(provider, tile) {
  return tileCacheKey(providerFingerprint(provider), tile.zoom, tile.x, tile.y);
}

/** A cache over the memory adapter with an injected clock, which is how LRU is made decidable. */
async function makeCache({ bytes = 8 * (GEO_TILE_CACHE_RECORD_OVERHEAD + 64), entries = 8, entryBytes = 64, adapter = null, namespace = GEO_TILE_CACHE_NAMESPACE } = {}) {
  const storage = adapter ?? createMemoryTileStorage();
  const cache = new GeoTileCache({
    storage,
    namespace,
    limits: { ...GEO_TILE_CACHE_LIMITS, bytes, entries, entryBytes },
    clock: () => cache.now,
  });
  cache.now = 1_000;
  await cache.open();
  return cache;
}

test('a provider fingerprint is its declared identity: id, URL template and label', () => {
  const fingerprint = providerFingerprint(PROVIDER);
  assert.match(fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(fingerprint, providerFingerprint({ ...PROVIDER }), 'the same declaration is the same source');
  assert.notEqual(fingerprint, providerFingerprint({ ...PROVIDER, url: 'https://tiles.example/v2/{z}/{x}/{y}.pbf' }),
    'a different URL template is a different source');
  assert.notEqual(fingerprint, providerFingerprint({ ...PROVIDER, label: 'Offline fixture (dev) — dense-urban/openmaptiles' }),
    'a changed label is a changed declaration, which is what keeps the dev fixture provider out of its own old entries');
  assert.notEqual(fingerprint, providerFingerprint(OTHER_PROVIDER), 'two providers are two identities');
  assert.throws(() => providerFingerprint({ id: 'x' }), /string id and a string url/);

  const key = tileCacheKey(fingerprint, 14, 12034, 7611);
  assert.equal(key, `${GEO_TILE_CACHE_NAMESPACE}|${fingerprint}|14/12034/7611`);
  assert.notEqual(key, tileCacheKey(fingerprint, 15, 12034, 7611), 'zoom is part of the identity');
  assert.throws(() => tileCacheKey(fingerprint, 14, NaN, 1), /finite zoom/);
});

test('a provider that forbids caching is never cached, and a declared lifetime is respected', () => {
  assert.deepEqual(providerCachePolicy(PROVIDER), { cacheable: true, maxAgeSeconds: GEO_TILE_CACHE_LIMITS.maxAgeSeconds, reason: '' });
  const forbidden = providerCachePolicy({ ...PROVIDER, cache: false });
  assert.equal(forbidden.cacheable, false);
  assert.match(forbidden.reason, /must not be cached/);
  assert.equal(providerCachePolicy({ ...PROVIDER, cache: { maxAgeSeconds: 0 } }).cacheable, false);
  assert.equal(providerCachePolicy({ ...PROVIDER, cache: { maxAgeSeconds: 60 } }).maxAgeSeconds, 60);
  assert.equal(providerCachePolicy(null).cacheable, false);

  assert.equal(tileCacheBytesForProfile('low'), GEO_TILE_CACHE_BYTES_BY_PROFILE.low);
  assert.equal(tileCacheBytesForProfile('high'), GEO_TILE_CACHE_BYTES_BY_PROFILE.high);
  assert.equal(tileCacheBytesForProfile('unknown'), GEO_TILE_CACHE_LIMITS.bytes, 'an unknown profile gets the default budget, not NaN');
});

test('a stored tile comes back, and only for the source that stored it', async () => {
  const cache = await makeCache();
  const empty = await cache.get(PROVIDER, TILE);
  assert.equal(empty.state, 'miss');
  assert.equal(cache.diagnostics().misses, 1);

  const stored = await cache.store(PROVIDER, TILE, payload(4, 7), { contentType: 'application/x-protobuf' });
  assert.equal(stored.stored, true);

  const hit = await cache.get(PROVIDER, TILE);
  assert.equal(hit.state, 'hit');
  assert.equal(hit.data.byteLength, 4);
  assert.equal(new Uint8Array(hit.data)[0], 7, 'the stored bytes are the fetched bytes');
  assert.equal(hit.providerId, PROVIDER.id);
  assert.equal(hit.label, PROVIDER.label, 'the entry carries the source it belongs to, which is what attribution needs');

  // The same tile under another source is a different entry, not a hit.
  const other = await cache.get(OTHER_PROVIDER, TILE);
  assert.equal(other.state, 'miss');
  const diagnostics = cache.diagnostics();
  assert.equal(diagnostics.hits, 1);
  assert.equal(diagnostics.misses, 2);
  assert.equal(diagnostics.available, true);
  assert.equal(diagnostics.adapter, 'memory');
  assert.equal(diagnostics.entries, 1);
});

test('the accounting is the sum of what the store holds, and re-storing does not double-count it', async () => {
  const cache = await makeCache({ bytes: 1024 });
  await cache.store(PROVIDER, TILE, payload(10));
  await cache.store(PROVIDER, TILE_B, payload(20));
  let diagnostics = cache.diagnostics();
  assert.equal(diagnostics.entries, 2);
  assert.equal(diagnostics.cachedBytes, 30);
  assert.equal(diagnostics.bytes, 30 + 2 * GEO_TILE_CACHE_RECORD_OVERHEAD);

  await cache.store(PROVIDER, TILE, payload(40));
  diagnostics = cache.diagnostics();
  assert.equal(diagnostics.entries, 2, 'the same key is one entry');
  assert.equal(diagnostics.cachedBytes, 60);
  assert.equal(diagnostics.bytes, 60 + 2 * GEO_TILE_CACHE_RECORD_OVERHEAD);
  const hit = await cache.get(PROVIDER, TILE);
  assert.equal(hit.data.byteLength, 40, 'the newer payload replaced the older one');
});

test('eviction is least-recently-used: a read moves an entry to the front of the queue', async () => {
  const cache = await makeCache({ bytes: 3 * (GEO_TILE_CACHE_RECORD_OVERHEAD + 4), entries: 3, entryBytes: 4 });
  cache.now = 1_000; await cache.store(PROVIDER, TILE, payload(4));
  cache.now = 2_000; await cache.store(PROVIDER, TILE_B, payload(4));
  cache.now = 3_000; await cache.store(PROVIDER, TILE_C, payload(4));
  assert.equal(cache.diagnostics().entries, 3);
  assert.equal(cache.diagnostics().evictions, 0);

  // Touching the oldest entry must make the *middle* one the victim.
  cache.now = 4_000;
  assert.equal((await cache.get(PROVIDER, TILE)).state, 'hit');
  cache.now = 5_000;
  await cache.store(PROVIDER, TILE_D, payload(4));

  const diagnostics = cache.diagnostics();
  assert.equal(diagnostics.entries, 3, 'the entry ceiling holds');
  assert.equal(diagnostics.evictions, 1);
  assert.equal(diagnostics.lastEviction.key, keyFor(PROVIDER, TILE_B), 'the least recently used entry was evicted, not the least recently stored');
  assert.equal(diagnostics.evictedBytes, GEO_TILE_CACHE_RECORD_OVERHEAD + 4);
  assert.equal((await cache.get(PROVIDER, TILE)).state, 'hit', 'the touched entry survived');
  assert.equal((await cache.get(PROVIDER, TILE_B)).state, 'miss');
  assert.equal((await cache.get(PROVIDER, TILE_C)).state, 'hit');
  assert.ok(diagnostics.bytes <= diagnostics.limitBytes, `the budget is met: ${diagnostics.bytes} <= ${diagnostics.limitBytes}`);
});

test('the LRU order survives a reopen, because it is written down', async () => {
  const storage = createMemoryTileStorage();
  const first = await makeCache({ bytes: 3 * (GEO_TILE_CACHE_RECORD_OVERHEAD + 4), entries: 3, entryBytes: 4, adapter: storage });
  first.now = 1_000; await first.store(PROVIDER, TILE, payload(4));
  first.now = 2_000; await first.store(PROVIDER, TILE_B, payload(4));
  first.now = 3_000; await first.store(PROVIDER, TILE_C, payload(4));
  first.now = 4_000; await first.get(PROVIDER, TILE);
  await first.close();

  const second = new GeoTileCache({
    storage,
    limits: { ...GEO_TILE_CACHE_LIMITS, bytes: 3 * (GEO_TILE_CACHE_RECORD_OVERHEAD + 4), entries: 3, entryBytes: 4 },
    clock: () => second.now,
  });
  second.now = 5_000;
  const opened = await second.open();
  assert.deepEqual({ opened: opened.opened, entries: opened.entries, reset: opened.reset }, { opened: true, entries: 3, reset: false });
  assert.equal(second.diagnostics().bytes, 3 * (GEO_TILE_CACHE_RECORD_OVERHEAD + 4));
  await second.store(PROVIDER, TILE_D, payload(4));
  assert.equal(second.diagnostics().lastEviction.key, keyFor(PROVIDER, TILE_B),
    'the entry touched before the reopen is still the most recently used after it');
  assert.equal(second.diagnostics().hits, 0, 'the entry was read by the same store, so no hit is invented');
});

test('a payload too large to bound is skipped, and an empty one is not stored, without touching what is held', async () => {
  const cache = await makeCache({ bytes: 1024, entryBytes: 16 });
  await cache.store(PROVIDER, TILE, payload(4));
  const before = cache.diagnostics().bytes;

  const oversized = await cache.store(PROVIDER, TILE_B, payload(64));
  assert.equal(oversized.stored, false);
  assert.equal(oversized.skipped, true);
  assert.match(oversized.reason, /larger than the 16 B single-entry ceiling/);
  const empty = await cache.store(PROVIDER, TILE_C, payload(0));
  assert.equal(empty.stored, false);
  assert.match(empty.reason, /payload is empty/);
  assert.equal(cache.diagnostics().bytes, before, 'a refused entry does not change the accounting');
  assert.equal(cache.diagnostics().entries, 1);
  assert.equal(cache.diagnostics().skipped, 2);
});

test('an entry past the provider lifetime is a miss, deleted, and counted as an expiry', async () => {
  const cache = await makeCache({ bytes: 1024 });
  await cache.store(PROVIDER, TILE, payload(4));
  cache.now += (GEO_TILE_CACHE_LIMITS.maxAgeSeconds + 1) * 1000;
  const expired = await cache.get(PROVIDER, TILE);
  assert.equal(expired.state, 'miss');
  assert.match(expired.reason, /the provider's lifetime/);
  assert.equal(cache.diagnostics().expiries, 1);
  assert.equal(cache.diagnostics().entries, 0, 'an expired entry releases its budget');
  assert.equal(cache.diagnostics().bytes, 0);

  // A provider's own declared lifetime is what the entry is held to.
  const shortLived = { ...PROVIDER, cache: { maxAgeSeconds: 10 } };
  await cache.store(shortLived, TILE_B, payload(4));
  cache.now += 11_000;
  assert.equal((await cache.get(shortLived, TILE_B)).state, 'miss');
  assert.equal(cache.diagnostics().expiries, 2);
});

test('a provider that forbids caching stores nothing, and the lookup is not even attempted', async () => {
  const cache = await makeCache({ bytes: 1024 });
  const forbidden = { ...PROVIDER, cache: false };
  const stored = await cache.store(forbidden, TILE, payload(4));
  assert.equal(stored.stored, false);
  assert.equal(stored.skipped, true);
  const lookup = await cache.get(forbidden, TILE);
  assert.equal(lookup.state, 'skip');
  assert.match(lookup.reason, /must not be cached/);
  assert.equal(lookup.key, null, 'no key is derived for a source that may not be read either');
  assert.equal(cache.diagnostics().entries, 0);
  assert.equal(cache.diagnostics().hits, 0);
  assert.equal(cache.diagnostics().misses, 0, 'a prohibited source is not counted as a miss against the cache');
});

test('a sweep removes what the application no longer declares and keeps what it does', async () => {
  const cache = await makeCache({ bytes: 4096 });
  await cache.store(PROVIDER, TILE, payload(4));
  await cache.store(OTHER_PROVIDER, TILE, payload(4));
  const kept = providerFingerprint(PROVIDER);
  const result = await cache.sweep({ fingerprints: [kept] });
  assert.equal(result.swept, 1);
  assert.equal(cache.diagnostics().entries, 1);
  assert.deepEqual(cache.diagnostics().providers, [PROVIDER.id]);
  assert.equal((await cache.get(OTHER_PROVIDER, TILE)).state, 'miss', 'the retired source cannot be served from an old entry');
  assert.equal((await cache.get(PROVIDER, TILE)).state, 'hit');
});

test('a cache may forget: a corrupt or foreign manifest empties the store instead of being interpreted', async () => {
  for (const [label, manifest] of [
    ['a manifest of another format', { schema: GEO_TILE_CACHE_SCHEMA + 1, namespace: GEO_TILE_CACHE_NAMESPACE, bytes: 0, entries: {} }],
    ['a manifest of another namespace', { schema: GEO_TILE_CACHE_SCHEMA, namespace: 'gdo:tilecache:v0', bytes: 0, entries: {} }],
    ['a manifest with no entry table', { schema: GEO_TILE_CACHE_SCHEMA, namespace: GEO_TILE_CACHE_NAMESPACE, bytes: 12, entries: null }],
    ['a manifest that is not an object', 'nonsense'],
  ]) {
    const storage = createMemoryTileStorage();
    await storage.put(keyFor(PROVIDER, TILE), { bytes: payload(4) });
    await storage.putMeta(GEO_TILE_CACHE_MANIFEST_KEY, manifest);
    const cache = await makeCache({ bytes: 4096, adapter: storage });
    const diagnostics = cache.diagnostics();
    assert.equal(diagnostics.entries, 0, label);
    assert.equal(diagnostics.bytes, 0, label);
    assert.equal(diagnostics.reset, true, label);
    assert.equal(diagnostics.errors, 0, `${label} is a reset, not an error`);
    assert.equal((await storage.keys()).length, 0, `${label} was swept from the store, not left behind`);
  }

  // A manifest that lists an entry outside this namespace is not adopted.
  const storage = createMemoryTileStorage();
  await storage.putMeta(GEO_TILE_CACHE_MANIFEST_KEY, {
    schema: GEO_TILE_CACHE_SCHEMA, namespace: GEO_TILE_CACHE_NAMESPACE, bytes: 999,
    entries: { 'gdo:tilecache:v0|deadbeef|14/1/1': { bytes: 900, storedAt: 1, lastUsed: 1 } },
  });
  const cache = await makeCache({ bytes: 4096, adapter: storage });
  assert.equal(cache.diagnostics().entries, 0);
  assert.equal(cache.diagnostics().reset, false, 'the manifest was usable; only its foreign entry was ignored');
});

test('an adapter that can be opened is opened: the two flags are not one', async () => {
  // The browser gate found this: `available` is false *before* `open()` for any
  // adapter whose usable form is a handle — which is every remote one — so a cache
  // that treats `available: false` as "no storage" never calls the open that would
  // have made it true. It fails silently, with no error and no entries, in exactly
  // the way that looks like a working cache.
  const deferred = createMemoryTileStorage();
  let opened = 0;
  const adapter = {
    name: 'deferred', openable: true,
    get available() { return opened > 0; },
    reason: null,
    async open() { opened++; return true; },
    async get(key) { return deferred.get(key); },
    async meta(key) { return deferred.meta(key); },
    async put(key, record) { return deferred.put(key, record); },
    async putMeta(key, record) { return deferred.putMeta(key, record); },
    async delete(key) { return deferred.delete(key); },
    async keys() { return deferred.keys(); },
    async clear() { return deferred.clear(); },
    async close() { return true; },
  };
  const cache = new GeoTileCache({ storage: adapter, limits: { ...GEO_TILE_CACHE_LIMITS, bytes: 4096 } , clock: () => 1_000 });
  assert.equal(cache.available, false, 'before open, an adapter with a handle is not available');
  assert.equal(cache.storageUsable, true, 'but it is openable, and that is the question open() asks');
  const report = await cache.open();
  assert.equal(report.opened, true);
  assert.equal(opened, 1, 'the open actually ran');
  assert.equal(cache.available, true, 'and now the cache is available');
  assert.equal((await cache.store(PROVIDER, TILE, payload(4))).stored, true);
  assert.equal(cache.diagnostics().entries, 1);

  // A null adapter is the other direction: it must never be opened, because opening
  // it is not a thing that can succeed.
  let nullOpens = 0;
  const nullAdapter = { ...createNullTileStorage('nothing here'), open: async () => { nullOpens++; return false; } };
  const nullCache = new GeoTileCache({ storage: nullAdapter });
  const nullReport = await nullCache.open();
  assert.equal(nullReport.opened, false);
  assert.equal(nullReport.reason, 'nothing here');
  assert.equal(nullOpens, 0, 'a cache with no storage never asks it to open');
});

test('a budget smaller than what is stored is enforced at open', async () => {
  // The browser gate found the other half of the budget promise: a cache reopened under a
  // *smaller* budget reported the small budget while still holding the old entries and
  // refusing every new store, so its own report contradicted its own accounting. The budget
  // is a claim about the player's disk, and the open is where it has to become true again.
  const storage = createMemoryTileStorage();
  const big = new GeoTileCache({ storage, limits: { ...GEO_TILE_CACHE_LIMITS, bytes: 16 * 1024 }, clock: () => 1_000 });
  await big.open();
  await big.store(PROVIDER, TILE, payload(1_000));
  await big.store(PROVIDER, TILE_B, payload(1_000));
  await big.store(PROVIDER, TILE_C, payload(1_000));
  assert.equal(big.diagnostics().entries, 3);
  assert.equal(big.diagnostics().evictions, 0);
  await big.close();

  // ...and the same bytes read back under a budget that holds two of the three records.
  const cost = Math.ceil(big.diagnostics().bytes / 3);
  const small = new GeoTileCache({ storage, limits: { ...GEO_TILE_CACHE_LIMITS, bytes: 2 * cost }, clock: () => 2_000 });
  const report = await small.open();
  assert.equal(report.opened, true);
  assert.equal(report.evicted, 1, 'the open evicted exactly the entry that did not fit');
  const diagnostics = small.diagnostics();
  assert.equal(diagnostics.entries, 2);
  assert.ok(diagnostics.bytes <= 2 * cost, `the accounting is ${diagnostics.bytes} B against a ${2 * cost} B budget`);
  assert.equal(diagnostics.evictions, 1);
  assert.equal(diagnostics.errors, 0, 'coming back inside the budget is not an error');
  assert.equal(diagnostics.lastEviction.reason, 'open');
  // The survivor is the *newest* entry: the LRU order is what decides, not insertion order.
  assert.equal((await small.get(PROVIDER, TILE)).state, 'miss', 'the oldest entry is the one that went');
  assert.equal((await small.get(PROVIDER, TILE_C)).state, 'hit', 'the newest entry survived');

  // And a budget below one record empties it rather than holding bytes it promised not to.
  const tiny = new GeoTileCache({ storage, limits: { ...GEO_TILE_CACHE_LIMITS, bytes: cost - 64 }, clock: () => 3_000 });
  await tiny.open();
  const tinyReport = tiny.diagnostics();
  assert.equal(tinyReport.entries, 0);
  assert.equal(tinyReport.bytes, 0);
  assert.ok(tinyReport.evictions >= 2, 'an over-budget manifest is emptied, not merely trimmed');
  assert.equal(tinyReport.errors, 0);
});

test('a budget too small for one tile is stated, not thrashed', async () => {
  // The browser gate found this shape: with a budget below a single record, the store
  // wrote the entry, noticed it did not fit and evicted it — a write and an eviction per
  // tile, with the entry the player just used being the one thrown away. Two things were
  // wrong. The refusal has to come *before* the write, and it must not cost the entries
  // that do fit.
  const storage = createMemoryTileStorage();
  const cache = new GeoTileCache({ storage, limits: { ...GEO_TILE_CACHE_LIMITS, bytes: 16 * 1024 }, clock: () => 1_000 });
  await cache.open();
  assert.equal((await cache.store(PROVIDER, TILE, payload(100))).stored, true, 'a record that fits is stored');

  const tiny = new GeoTileCache({
    storage: createMemoryTileStorage(),
    limits: { ...GEO_TILE_CACHE_LIMITS, bytes: 512 },
    clock: () => 1_000,
  });
  await tiny.open();
  const small = await tiny.store(PROVIDER, TILE, payload(100));
  assert.equal(small.stored, true, 'the first record fits a 512 B budget');
  const refused = await tiny.store(PROVIDER, TILE_B, payload(900));
  assert.equal(refused.stored, false);
  assert.match(refused.reason, /cannot fit the 512 B budget/);
  const report = tiny.diagnostics();
  assert.equal(report.entries, 1, 'the entry that fits survived the refusal');
  assert.equal(report.evictions, 0, 'nothing was evicted for an entry that was never written');
  assert.equal(report.errors, 0, 'a refusal is a state, not a failure');
  assert.equal(report.skipped, 1);
  assert.equal((await tiny.get(PROVIDER, TILE)).state, 'hit', 'the surviving entry is still usable');

  // And the accounting never exceeds the budget it was given.
  const fits = new GeoTileCache({ storage: createMemoryTileStorage(), limits: { ...GEO_TILE_CACHE_LIMITS, bytes: 3 * (100 + GEO_TILE_CACHE_RECORD_OVERHEAD) }, clock: () => 1_000 });
  await fits.open();
  await fits.store(PROVIDER, TILE, payload(100));
  await fits.store(PROVIDER, TILE_B, payload(100));
  await fits.store(PROVIDER, TILE_C, payload(100));
  const three = fits.diagnostics();
  assert.equal(three.entries, 3, 'three records fit a budget of three records');
  assert.equal(three.evictions, 0, 'and none of them needed evicting');
  assert.ok(three.cachedBytes <= three.limitBytes);
});

test('an absent or hostile store makes the cache unavailable, never the runtime', async () => {
  const nullCache = new GeoTileCache({ storage: createNullTileStorage('this browser exposes no IndexedDB') });
  const opened = await nullCache.open();
  assert.equal(opened.opened, false);
  assert.match(opened.reason, /no IndexedDB/);
  assert.equal(nullCache.available, false);
  assert.deepEqual(await nullCache.store(PROVIDER, TILE, payload(4)), { stored: false, reason: 'the cache is not open', skipped: true });
  assert.equal((await nullCache.get(PROVIDER, TILE)).state, 'miss');
  const nullDiagnostics = nullCache.diagnostics();
  assert.equal(nullDiagnostics.available, false);
  assert.equal(nullDiagnostics.entries, 0);
  assert.equal(nullDiagnostics.errors, 0, 'an unavailable cache is not an error either');

  // A store that throws on every call: the counters report it and no call propagates.
  const hostile = {
    name: 'hostile', available: true,
    async open() { throw new Error('open refused'); },
    async get() { throw new Error('read refused'); },
    async meta() { throw new Error('meta refused'); },
    async put() { throw new Error('write refused'); },
    async putMeta() { throw new Error('manifest refused'); },
    async delete() { throw new Error('delete refused'); },
    async keys() { throw new Error('keys refused'); },
    async clear() { throw new Error('clear refused'); },
    async close() { throw new Error('close refused'); },
  };
  const hostileCache = new GeoTileCache({ storage: hostile });
  assert.equal((await hostileCache.open()).opened, false);
  assert.equal((await hostileCache.store(PROVIDER, TILE, payload(4))).stored, false);
  assert.equal(hostileCache.diagnostics().errors >= 1, true, 'the failures are counted');
  assert.ok(hostileCache.diagnostics().lastError, 'and the last one is reported');
});

test('a full disk costs the cache entries, not the tile', async () => {
  /**
   * A store with a hard room limit of its own, counted in payload bytes: writing
   * past it throws the error a browser throws, and deleting an entry frees its
   * room again — which is what lets the cache's eviction ladder recover. A
   * write-count fake cannot express that, and modelling it as one is how the first
   * version of this test came to assert the wrong thing.
   */
  const createFullDiskStorage = hardCapBytes => {
    const records = new Map();
    const meta = new Map();
    const payloadBytes = () => [...records.values()].reduce((sum, record) => sum + (record.bytes?.byteLength ?? 0), 0);
    return {
      name: 'full-disk', available: true,
      async open() { return true; },
      async get(key) { return records.get(String(key)) ?? null; },
      async meta(key) { return meta.get(String(key)) ?? null; },
      async put(key, record) {
        const replacing = records.has(String(key));
        const cost = replacing ? 0 : (record.bytes?.byteLength ?? 0);
        if (payloadBytes() + cost > hardCapBytes) {
          const error = new Error('the origin is out of room');
          error.name = 'QuotaExceededError';
          throw error;
        }
        records.set(String(key), record);
        return true;
      },
      async putMeta(key, record) { meta.set(String(key), record); return true; },
      async delete(key) { return records.delete(String(key)); },
      async keys() { return [...records.keys()]; },
      async clear() { records.clear(); return true; },
      async close() { return true; },
      held: () => [...records.keys()],
    };
  };

  // Room for two 4-byte payloads against a cache budget of 4 KiB: only the adapter's
  // own limit can force an eviction, which is what a full disk looks like.
  const storage = createFullDiskStorage(8);
  const cache = new GeoTileCache({
    storage,
    limits: { ...GEO_TILE_CACHE_LIMITS, bytes: 4096, entries: 8, entryBytes: 64 },
    clock: () => 1_000,
  });
  await cache.open();
  assert.equal((await cache.store(PROVIDER, TILE, payload(4))).stored, true);
  assert.equal((await cache.store(PROVIDER, TILE_B, payload(4))).stored, true);
  const third = await cache.store(PROVIDER, TILE_C, payload(4));
  assert.equal(third.stored, true, 'the entry was stored after the quota error forced an eviction');
  assert.equal(cache.diagnostics().errors, 0, 'a handled quota error is not an error');
  assert.ok(cache.diagnostics().evictions >= 1, 'the cache freed its own space to make room');
  assert.equal(storage.held().length, 2, 'the adapter is at its limit, so exactly one eviction was enough');
  assert.equal((await cache.get(PROVIDER, TILE_C)).state, 'hit');

  // A disk that cannot fit the payload at all: the cache empties itself, gives up on
  // *this entry*, reports the failure once and leaves the tile to the network.
  const hopeless = createFullDiskStorage(3);
  const hopelessCache = new GeoTileCache({
    storage: hopeless,
    limits: { ...GEO_TILE_CACHE_LIMITS, bytes: 4096, entries: 8, entryBytes: 64 },
    clock: () => 2_000,
  });
  await hopelessCache.open();
  assert.equal((await hopelessCache.store(PROVIDER, TILE, payload(4))).stored, false);
  const refused = await hopelessCache.store(PROVIDER, TILE_B, payload(4));
  assert.equal(refused.stored, false);
  assert.match(refused.reason, /out of room/);
  assert.equal(hopelessCache.diagnostics().entries, 0, 'the cache emptied itself trying');
  assert.equal(hopelessCache.diagnostics().errors >= 1, true, 'a store that could not happen is reported');
});

test('the diagnostics are complete enough for a review panel, and the namespace is the format', async () => {
  const cache = await makeCache({ bytes: 512 });
  await cache.store(PROVIDER, TILE, payload(8));
  cache.now += 1_000;
  await cache.get(PROVIDER, TILE);
  const diagnostics = cache.diagnostics();
  for (const field of [
    'schema', 'namespace', 'adapter', 'available', 'opened', 'entries', 'cachedBytes', 'bytes',
    'limitBytes', 'limitEntries', 'entryLimitBytes', 'maxAgeSeconds', 'hits', 'misses', 'stores',
    'evictions', 'evictedBytes', 'expiries', 'swept', 'skipped', 'rejected', 'errors', 'manifestWrites', 'resets',
  ]) {
    assert.ok(field in diagnostics, `the diagnostics carry ${field}`);
  }
  assert.equal(diagnostics.schema, GEO_TILE_CACHE_SCHEMA);
  assert.equal(diagnostics.namespace, `${GEO_TILE_CACHE_NAMESPACE}`);
  assert.match(diagnostics.namespace, new RegExp(`v${GEO_TILE_CACHE_SCHEMA}$`), 'the format version is the namespace suffix');
  assert.equal(diagnostics.newestLastUsed, 2_000, 'reading an entry writes down when it was last used');

  // A cache in another namespace cannot see these entries, which is what a format bump means.
  const foreign = new GeoTileCache({
    storage: cache.storage,
    namespace: 'gdo:tilecache:v2',
    limits: { ...GEO_TILE_CACHE_LIMITS, bytes: 512 },
  });
  foreign.now = cache.now;
  await foreign.open();
  assert.equal(foreign.diagnostics().entries, 0);
  assert.equal((await foreign.get(PROVIDER, TILE)).state, 'miss');
});
