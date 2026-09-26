import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_TILE_CACHE_NAMESPACE,
  GEO_TILE_CACHE_LIMITS,
  TileCache,
  acquireTileCache,
  createCacheStorageTileStorage,
  createMemoryTileStorage,
  releaseTileCache,
  resolveTileStorage,
  tileCacheKey,
  tileCachePolicy,
  tileCacheProviderConfig,
  tileCacheTtlMilliseconds,
} from './GeoTileCache.js';

const OPENFREEMAP = Object.freeze({
  id: 'openfreemap',
  label: 'OpenFreeMap / OpenMapTiles',
  url: 'https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf',
  attribution: '© OpenStreetMap contributors · OpenFreeMap',
});
const SHORTBREAD = Object.freeze({
  id: 'openstreetmap',
  label: 'OpenStreetMap Shortbread',
  url: 'https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt',
  attribution: '© OpenStreetMap contributors · Shortbread',
});
const TILE = Object.freeze({ zoom: 14, urlX: 9_000, urlY: 6_000 });

function clock(start = 1_000_000) {
  return { now: () => clock.value, set: value => { clock.value = value; }, value: start };
}

function bytes(size, fill = 7) {
  const data = new Uint8Array(size);
  data.fill(fill);
  return data;
}

function makeCache({ profile = 'low', providers = [OPENFREEMAP], storage, time = clock() } = {}) {
  const cache = new TileCache({
    storage: storage ?? createMemoryTileStorage({ maxBytes: 4 * 1024 * 1024 }),
    profile,
    providers,
    now: time.now,
  });
  return { cache, time };
}

/** A minimal Cache Storage double that records exactly what the adapter did. */
function fakeCacheStorage() {
  const stores = new Map();
  const calls = { open: 0, match: 0, put: 0, delete: 0, keys: 0 };
  const store = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const responseFor = data => ({
    ok: true,
    async arrayBuffer() { return data.slice().buffer; },
  });
  return {
    calls,
    stores,
    async open(name) {
      calls.open++;
      const entries = store(name);
      return {
        async match(key) {
          calls.match++;
          const data = entries.get(key);
          return data ? responseFor(data) : undefined;
        },
        async put(key, response) {
          calls.put++;
          entries.set(key, new Uint8Array(await response.arrayBuffer()));
        },
        async delete(key) {
          calls.delete++;
          return entries.delete(key);
        },
        async keys() {
          calls.keys++;
          return [...entries.keys()].map(url => ({ url }));
        },
      };
    },
  };
}

test('MAP-09 cache policy is per-profile, versioned, and never unbounded', () => {
  assert.equal(GDO_TILE_CACHE_NAMESPACE, `gdo:tileCache:v${GEO_TILE_CACHE_LIMITS.schemaVersion}`);
  const low = tileCachePolicy('low'), balanced = tileCachePolicy('balanced'), high = tileCachePolicy('high');
  assert.deepEqual([low.maxBytes, balanced.maxBytes, high.maxBytes],
    [GEO_TILE_CACHE_LIMITS.maxBytes.low, GEO_TILE_CACHE_LIMITS.maxBytes.balanced,
      GEO_TILE_CACHE_LIMITS.maxBytes.high]);
  assert.ok(low.maxBytes < balanced.maxBytes && balanced.maxBytes < high.maxBytes);
  assert.ok(low.maxEntries < balanced.maxEntries && balanced.maxEntries < high.maxEntries);
  // An unknown or hostile profile falls back to the low ceilings, never wider.
  assert.equal(tileCachePolicy('ultra').maxBytes, low.maxBytes);
  assert.equal(tileCachePolicy('ultra').profile, 'low');
  assert.equal(tileCachePolicy(undefined).profile, 'low');
  assert.equal(tileCachePolicy(null).maxEntries, low.maxEntries);
  assert.ok(GEO_TILE_CACHE_LIMITS.maxEntryBytes < low.maxBytes);
  assert.equal(tileCacheKey('openfreemap', TILE),
    `${GDO_TILE_CACHE_NAMESPACE}:openfreemap:14/9000/6000`);
  assert.throws(() => tileCacheProviderConfig({ attribution: 'x' }), TypeError);
  assert.throws(() => tileCacheProviderConfig({ id: 'a', attribution: 'x'.repeat(200) }), RangeError);
  assert.deepEqual(tileCacheProviderConfig({ id: ' a ', attribution: ' credit ' }),
    { id: 'a', attribution: 'credit', cacheable: true });
  assert.equal(tileCacheProviderConfig({ id: 'a' }).cacheable, false);
  assert.throws(() => new TileCache({}), TypeError);
  assert.throws(() => new TileCache({ storage: createMemoryTileStorage(), profile: 'ultra' }), RangeError);
  assert.throws(() => createMemoryTileStorage({ maxBytes: 0 }), RangeError);
  assert.throws(() => createCacheStorageTileStorage(null), TypeError);
});

test('MAP-09 provider cache semantics honour bounded Cache-Control and Expires hints', () => {
  const now = 1_700_000_000_000;
  assert.equal(tileCacheTtlMilliseconds('', { now }), GEO_TILE_CACHE_LIMITS.defaultTtlMilliseconds);
  assert.equal(tileCacheTtlMilliseconds('max-age=3600', { now }), 3_600_000);
  // A private browser cache honours max-age; s-maxage only applies to shared caches.
  assert.equal(tileCacheTtlMilliseconds('public, max-age=60, s-maxage=7200', { now }), 60_000);
  assert.equal(tileCacheTtlMilliseconds('public, s-maxage=7200', { now }), 7_200_000);
  // Bounded at both ends: a tiny or enormous hint becomes the nearest legal value.
  assert.equal(tileCacheTtlMilliseconds('max-age=1', { now }), GEO_TILE_CACHE_LIMITS.minimumTtlMilliseconds);
  assert.equal(tileCacheTtlMilliseconds('max-age=999999999', { now }), GEO_TILE_CACHE_LIMITS.maximumTtlMilliseconds);
  assert.equal(tileCacheTtlMilliseconds('no-store', { now }), 0);
  assert.equal(tileCacheTtlMilliseconds('private, max-age=600', { now }), 0);
  const expires = new Date(now + 90 * 60_000).toUTCString();
  assert.equal(tileCacheTtlMilliseconds(expires, { now }), 90 * 60_000);
  // An unparsable hint falls back to the fixed lifetime instead of never expiring.
  assert.equal(tileCacheTtlMilliseconds('stale-while-revalidate', { now }),
    GEO_TILE_CACHE_LIMITS.defaultTtlMilliseconds);
});

test('MAP-09 cache-first load writes once and serves later reads from storage', async () => {
  const time = clock();
  const { cache } = makeCache({ time });
  const opened = await cache.open();
  assert.equal(opened.entries, 0);
  assert.equal(opened.profile, 'low');
  assert.equal(cache.opened, true);
  let loads = 0;
  const loader = async () => { loads++; return { data: bytes(1_024), url: 'https://example.invalid/tile' }; };
  const first = await cache.load('openfreemap', TILE, loader, { cacheControl: 'max-age=600' });
  assert.equal(first.cached, false);
  assert.equal(first.stored, true);
  assert.equal(loads, 1);
  assert.equal(first.attribution, OPENFREEMAP.attribution);
  assert.equal(cache.diagnostics.entries, 1);
  assert.equal(cache.diagnostics.bytes, 1_024);
  assert.equal(cache.diagnostics.writes, 1);
  assert.equal(cache.diagnostics.steadyFrameOperations, 0, 'cache work happens per tile, never per frame');
  const second = await cache.load('openfreemap', TILE, loader, { cacheControl: 'max-age=600' });
  assert.equal(second.cached, true, 'the second load is served from storage');
  assert.equal(loads, 1, 'a hit must not call the network loader');
  assert.equal(second.data.byteLength, 1_024);
  assert.equal(cache.diagnostics.hits, 1);
  assert.equal(cache.diagnostics.misses, 1);
  // A different tile is a miss, and the tile key never collides across providers.
  assert.equal(await cache.read('openstreetmap', TILE), null);
  assert.equal(await cache.read('openfreemap', { ...TILE, urlY: TILE.urlY + 1 }), null);
  // A failed load propagates and stores nothing.
  await assert.rejects(cache.load('openfreemap', { ...TILE, urlX: 1 }, async () => ({})));
  assert.equal(cache.diagnostics.entries, 1);
  cache.dispose();
});

test('MAP-09 unpinned LRU trims to the byte and entry ceilings and never evicts a pinned tile', async () => {
  const time = clock();
  const storage = createMemoryTileStorage({ maxBytes: 4 * 1024 * 1024 });
  const { cache } = makeCache({ time, storage });
  await cache.open();
  const ceilingQuadrant = Math.floor(GEO_TILE_CACHE_LIMITS.maxBytes.low / 4);
  const tile = index => ({ zoom: 14, urlX: index, urlY: 0 });
  for (let index = 0; index < 6; index++) {
    time.set(time.value + 1_000);
    assert.equal(await cache.write('openfreemap', tile(index), { data: bytes(ceilingQuadrant), cacheControl: 'max-age=600' }), true);
  }
  const diagnostics = cache.diagnostics;
  assert.ok(diagnostics.bytes <= GEO_TILE_CACHE_LIMITS.maxBytes.low, 'byte ceiling holds after writes');
  assert.ok(diagnostics.entries < 6, 'older tiles were evicted to stay inside the byte ceiling');
  assert.ok(diagnostics.evictions > 0);
  assert.equal(diagnostics.capEvents.bytes, true);
  // The most recent write survives; the oldest was the victim.
  assert.ok(await cache.read('openfreemap', tile(5)));
  assert.equal(await cache.read('openfreemap', tile(0)), null);
  // A pinned tile is skipped by eviction while an unpinned victim exists.
  const pinned = tile(99);
  time.set(time.value + 1_000);
  assert.equal(await cache.write('openfreemap', pinned, { data: bytes(16), cacheControl: 'max-age=600' }), true);
  assert.equal(cache.pin('openfreemap', pinned), true);
  assert.equal(cache.pin('openfreemap', pinned), false, 'pinning twice is a no-op');
  assert.equal(cache.diagnostics.pinned, 1);
  time.set(time.value + 1_000);
  await cache.write('openfreemap', tile(100), { data: bytes(ceilingQuadrant), cacheControl: 'max-age=600' });
  assert.ok(await cache.read('openfreemap', pinned), 'the pinned tile survived the trim');
  assert.equal(cache.unpin('openfreemap', pinned), true);
  assert.equal(cache.unpin('openfreemap', pinned), false);
  // Entry ceiling: many tiny payloads still stop at the profile limit.
  const entryCache = makeCache({ time }).cache;
  await entryCache.open();
  for (let index = 0; index < GEO_TILE_CACHE_LIMITS.maxEntries.low * 2; index++) {
    time.set(time.value + 1);
    await entryCache.write('openfreemap', { zoom: 14, urlX: index, urlY: 7 }, { data: bytes(8), cacheControl: 'max-age=600' });
  }
  assert.equal(entryCache.diagnostics.entries, GEO_TILE_CACHE_LIMITS.maxEntries.low);
  assert.equal(entryCache.diagnostics.capEvents.entries, true);
  entryCache.dispose();
  cache.dispose();
});

test('MAP-09 attribution-safe storage refuses uncredited payloads and invalidates on credit change', async () => {
  const time = clock();
  const storage = createMemoryTileStorage();
  const { cache } = makeCache({ time, storage, providers: [OPENFREEMAP, { id: 'anon', url: 'https://x.invalid' }] });
  await cache.open();
  assert.equal(cache.diagnostics.providers, 2);
  assert.equal(cache.diagnostics.cacheableProviders, 1);
  // A provider that cannot be credited is never persisted, even though the tile
  // itself was usable for rendering.
  assert.equal(await cache.write('anon', TILE, { data: bytes(64) }), false);
  assert.equal(cache.diagnostics.attributionRejections, 1);
  assert.equal(cache.diagnostics.capEvents.attribution, true);
  assert.equal(cache.diagnostics.entries, 0);
  // no-store and oversized payloads are refused rather than allowed to thrash the cache.
  assert.equal(await cache.write('openfreemap', TILE, { data: bytes(64), cacheControl: 'no-store' }), false);
  assert.equal(await cache.write('openfreemap', TILE,
    { data: bytes(GEO_TILE_CACHE_LIMITS.maxEntryBytes + 1), cacheControl: 'max-age=600' }), false);
  assert.equal(cache.diagnostics.oversizedRejections, 1);
  assert.equal(cache.diagnostics.capEvents.oversized, true);
  assert.equal(await cache.write('openfreemap', TILE, { data: new Float32Array(4) }), false);
  assert.equal(await cache.write('openfreemap', TILE, { data: bytes(0) }), false);
  assert.equal(cache.diagnostics.entries, 0, 'nothing unusable was stored');
  // A stored tile whose credit later changes is dropped instead of served.
  assert.equal(await cache.write('openfreemap', TILE, { data: bytes(128), cacheControl: 'max-age=600' }), true);
  assert.equal(cache.diagnostics.entries, 1);
  const reused = createMemoryTileStorage();
  assert.equal(await reused.put(tileCacheKey('openfreemap', TILE), bytes(128)), true);
  const recredited = makeCache({
    time, storage: reused,
    providers: [{ ...OPENFREEMAP, attribution: '© OpenStreetMap contributors · somewhere else' }],
  }).cache;
  await recredited.open();
  assert.equal(recredited.diagnostics.entries, 0, 'a credit change purges the payload');
  assert.equal(recredited.diagnostics.invalidated, 1, 'the payload is dropped, not served under a new credit');
  assert.deepEqual(await reused.list(), []);
  recredited.dispose();
  cache.dispose();
});

test('MAP-09 open reconciles schema version, orphans, expiry, and corrupt manifests', async () => {
  const time = clock();
  const storage = createMemoryTileStorage();
  const { cache } = makeCache({ time, storage });
  await cache.open();
  assert.equal(await cache.write('openfreemap', TILE, { data: bytes(200), cacheControl: 'max-age=600' }), true);
  cache.dispose();

  // Reopening the same storage with the same policy keeps the payload.
  const reopened = makeCache({ time, storage }).cache;
  await reopened.open();
  assert.equal(reopened.diagnostics.entries, 1);
  assert.equal(reopened.diagnostics.invalidated, 0);
  assert.ok(await reopened.read('openfreemap', TILE));
  // Expiry is honoured on read and reported.
  time.set(time.value + GEO_TILE_CACHE_LIMITS.maximumTtlMilliseconds);
  assert.equal(await reopened.read('openfreemap', TILE), null);
  assert.equal(reopened.diagnostics.expirations, 1);
  assert.equal(reopened.diagnostics.misses, 1);
  reopened.dispose();

  // An orphaned payload with no manifest record is unaccountable, so it is deleted.
  const orphanStorage = createMemoryTileStorage();
  await orphanStorage.put(tileCacheKey('openfreemap', TILE), bytes(32));
  const orphan = makeCache({ time, storage: orphanStorage }).cache;
  await orphan.open();
  assert.equal(orphan.diagnostics.entries, 0);
  assert.equal(orphan.diagnostics.invalidated, 1);
  assert.deepEqual([...await orphanStorage.list()], []);
  orphan.dispose();

  // A manifest whose version no longer matches invalidates its payloads.
  const staleStorage = createMemoryTileStorage();
  await staleStorage.put(GEO_TILE_CACHE_LIMITS.manifestKey, new TextEncoder().encode(JSON.stringify({
    version: GEO_TILE_CACHE_LIMITS.schemaVersion + 9,
    records: { [tileCacheKey('openfreemap', TILE)]: { version: 0, bytes: 8 } },
  })));
  await staleStorage.put(tileCacheKey('openfreemap', TILE), bytes(8));
  const stale = makeCache({ time, storage: staleStorage }).cache;
  await stale.open();
  assert.equal(stale.diagnostics.entries, 0);
  assert.equal(stale.diagnostics.invalidated, 1);
  stale.dispose();

  // A corrupt manifest is discarded instead of throwing into a frame.
  const corruptStorage = createMemoryTileStorage();
  await corruptStorage.put(GEO_TILE_CACHE_LIMITS.manifestKey, new TextEncoder().encode('{not json'));
  const corrupt = makeCache({ time, storage: corruptStorage }).cache;
  await corrupt.open();
  assert.equal(corrupt.diagnostics.entries, 0);
  assert.equal(corrupt.diagnostics.opened, true);
  const cleared = await corrupt.clear();
  assert.equal(cleared, 0);
  assert.deepEqual([...await corruptStorage.list()], []);
  corrupt.dispose();
});

test('MAP-09 cache storage adapter maps keys to stable synthetic URLs', async () => {
  const cacheStorage = fakeCacheStorage();
  const adapter = createCacheStorageTileStorage(cacheStorage, { name: 'gdo-test' });
  assert.equal(adapter.kind, 'cache-storage');
  assert.equal(adapter.persistent, true);
  assert.equal(await adapter.get('missing'), null);
  assert.equal(await adapter.put('alpha', bytes(16)), true);
  assert.equal(await adapter.put('beta', bytes(8)), true);
  assert.deepEqual(await adapter.list(), ['alpha', 'beta']);
  const fetched = await adapter.get('alpha');
  assert.equal(fetched.byteLength, 16);
  assert.equal(fetched[0], 7);
  assert.equal(await adapter.delete('alpha'), true);
  assert.equal(await adapter.delete('alpha'), false);
  assert.deepEqual(await adapter.list(), ['beta']);
  assert.equal(await adapter.clear(), 1);
  assert.deepEqual([...cacheStorage.stores.get('gdo-test').keys()], []);
  assert.ok(cacheStorage.calls.put >= 2 && cacheStorage.calls.match >= 2);
  // Malformed archive payloads are refused by the adapter itself.
  await assert.rejects(async () => adapter.put('bad', 'not bytes'), TypeError);
  // The same adapter drives a real TileCache end to end.
  const time = clock();
  const cache = new TileCache({ storage: adapter, profile: 'balanced', providers: [OPENFREEMAP, SHORTBREAD], now: time.now });
  await cache.open();
  assert.equal(cache.diagnostics.persistent, true);
  assert.equal(cache.diagnostics.profile, 'balanced');
  assert.equal(cache.diagnostics.maxBytes, GEO_TILE_CACHE_LIMITS.maxBytes.balanced);
  assert.equal(await cache.write('openstreetmap', TILE, { data: bytes(512), cacheControl: 'max-age=120' }), true);
  assert.equal((await cache.read('openstreetmap', TILE)).data.byteLength, 512);
  // A fresh instance over the same storage sees the same entry (persistence).
  const second = new TileCache({ storage: adapter, profile: 'balanced', providers: [OPENFREEMAP, SHORTBREAD], now: time.now });
  await second.open();
  assert.equal(second.diagnostics.entries, 1);
  assert.ok(await second.read('openstreetmap', TILE));
  assert.equal(second.diagnostics.maxEntries, GEO_TILE_CACHE_LIMITS.maxEntries.balanced);
  second.dispose();
  cache.dispose();
});

test('MAP-09 adapter resolution falls back to bounded memory when storage is unavailable', async () => {
  const memory = resolveTileStorage({ cacheStorage: null });
  assert.equal(memory.kind, 'memory');
  assert.equal(memory.persistent, false);
  const broken = resolveTileStorage({ cacheStorage: { open: () => { throw new Error('denied'); } } });
  assert.equal(broken.kind, 'memory', 'a refusing Cache Storage falls back instead of throwing');
  const unsupported = resolveTileStorage({ cacheStorage: {} });
  assert.equal(unsupported.kind, 'memory');
  // The memory adapter stays inside its own budget even when driven past it.
  const bounded = createMemoryTileStorage({ maxBytes: 64 });
  assert.equal(await bounded.put('a', bytes(48)), true);
  assert.equal(await bounded.put('b', bytes(48)), true);
  assert.equal(bounded.diagnostics().bytes, 48);
  assert.equal(bounded.diagnostics().trimmed, 1);
  assert.deepEqual(await bounded.list(), ['b']);
  assert.equal(await bounded.delete('b'), true);
  assert.equal(await bounded.delete('b'), false);
  await bounded.put('c', bytes(8));
  assert.equal(await bounded.clear(), undefined);
  assert.equal(bounded.diagnostics().entries, 0);
  await assert.rejects(async () => bounded.put('bad', 'nope'), TypeError);
  assert.equal(await resolveTileStorage({ cacheStorage: null }).get('missing'), null);
  // The shared worker cache is reused for one identity and released deterministically.
  releaseTileCache();
  const shared = acquireTileCache({ storage: createMemoryTileStorage(), profile: 'low', providers: [OPENFREEMAP] });
  assert.equal(acquireTileCache({ storage: createMemoryTileStorage(), profile: 'low', providers: [OPENFREEMAP] }), shared);
  const other = acquireTileCache({ storage: createMemoryTileStorage(), profile: 'high', providers: [OPENFREEMAP] });
  assert.notEqual(other, shared);
  assert.equal(shared.disposed, true, 'a profile change disposes the previous cache');
  releaseTileCache();
  assert.equal(other.disposed, true);
  assert.equal((await acquireTileCache({
    storage: createMemoryTileStorage(), profile: 'low', providers: [OPENFREEMAP],
  }).open()).profile, 'low');
  releaseTileCache();
  // A disposed cache refuses new writes instead of mutating released state.
  const disposed = makeCache().cache;
  disposed.dispose();
  assert.equal(await disposed.write('openfreemap', TILE, { data: bytes(8) }), false);
  assert.equal(disposed.diagnostics.disposed, true);
  assert.equal(disposed.dispose(), undefined);
});
