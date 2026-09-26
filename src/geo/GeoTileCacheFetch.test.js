import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAP_PROVIDERS,
  TileCacheFetcher,
  createTileRetainer,
  mapTileUrl,
} from './GeoTileCacheFetch.js';
import {
  TileCache,
  acquireTileCache,
  createMemoryTileStorage,
  releaseTileCache,
  tileCacheKey,
} from './GeoTileCache.js';

const TILE = Object.freeze({
  zoom: 14, urlX: 9_000, urlY: 6_000, tileX: 0, tileY: 0, tileSize: 100,
});

function clock(start = 5_000_000) {
  return { value: start, now: () => clock.value, set: value => { clock.value = value; } };
}

function bytes(size, fill = 4) {
  const data = new Uint8Array(size);
  data.fill(fill);
  return data;
}

function fakeFetch(script) {
  const calls = [];
  const fetchBytes = async (provider, request, signal) => {
    calls.push({ providerId: provider.id, url: mapTileUrl(provider.url, request) });
    const outcome = script({ provider, request, call: calls.length });
    if (outcome instanceof Error) throw outcome;
    return { ...outcome, url: mapTileUrl(provider.url, request) };
  };
  return { calls, fetchBytes };
}

function makeCache(providers, time) {
  return new TileCache({
    storage: createMemoryTileStorage(),
    profile: 'low',
    providers,
    now: time.now,
  });
}

test('MAP-09 fetcher builds provider URLs and falls through to the next provider', async () => {
  const time = clock();
  const cache = makeCache(DEFAULT_MAP_PROVIDERS, time);
  await cache.open();
  const fetcher = new TileCacheFetcher({
    providers: DEFAULT_MAP_PROVIDERS,
    cache,
    decode: data => (data[0] === 255 ? null : { decoded: true }),
  });
  assert.equal(mapTileUrl('https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf', TILE),
    'https://tiles.openfreemap.org/planet/latest/14/9000/6000.pbf');
  assert.equal(fetcher.cacheable, true);
  // The first provider fails on the network, so the second one serves the tile.
  const failing = fakeFetch(({ call }) => (call === 1
    ? new Error('HTTP 503')
    : { data: bytes(64), cacheControl: 'max-age=300' }));
  const loaded = await fetcher.load(TILE, null, failing.fetchBytes);
  assert.equal(loaded.providerId, 'openstreetmap');
  assert.equal(loaded.servedFromCache, false);
  assert.equal(loaded.attribution, DEFAULT_MAP_PROVIDERS[1].attribution);
  assert.deepEqual(failing.calls.map(call => call.providerId), ['openfreemap', 'openstreetmap']);
  // A payload the decoder rejects never gets stored, and the next provider wins.
  const undecodable = fakeFetch(({ call }) => (call === 1
    ? { data: bytes(32, 255), cacheControl: 'max-age=300' }
    : { data: bytes(32, 7), cacheControl: 'max-age=300' }));
  assert.throws(() => new TileCacheFetcher({ decode: 'nope' }), TypeError);
  const strict = new TileCacheFetcher({
    providers: DEFAULT_MAP_PROVIDERS,
    cache,
    decode: data => {
      if (data[0] === 255) throw new Error('decode failed');
      return { decoded: true };
    },
  });
  const strictLoad = await strict.load(TILE, null, undecodable.fetchBytes);
  assert.equal(strictLoad.providerId, 'openstreetmap');
  assert.equal(strict.diagnostics.decodeRejections, 1);
  assert.equal(cache.diagnostics.entries, 1, 'the rejected payload was never cached');
  assert.deepEqual(strict.failures, ['OpenFreeMap / OpenMapTiles: decode failed']);
  // A stored payload the decoder now refuses is dropped instead of served twice.
  const healing = new TileCacheFetcher({ providers: DEFAULT_MAP_PROVIDERS, cache,
    decode: () => { throw new Error('decode failed'); } });
  const healed = await healing.load(TILE, null, fakeFetch(() => new Error('offline')).fetchBytes)
    .catch(error => error);
  assert.ok(healed instanceof Error, 'an undecodable stored payload is never returned');
  assert.equal(healing.invalidCachedPayloads >= 1, true, 'the invalid entry was invalidated');
  assert.equal(cache.diagnostics.entries, 0);
  // When every provider fails, the caller gets one descriptive error.
  const dead = fakeFetch(() => new Error('offline'));
  await assert.rejects(fetcher.load({ ...TILE, urlX: 1 }, null, dead.fetchBytes),
    /No public map source responded/);
  await assert.rejects(fetcher.load(TILE, null, null), TypeError);
  // Requests counted before the loader check: two real loads, one of which was
  // served by the second provider; three provider failures were recorded.
  assert.equal(fetcher.diagnostics.requests, 2);
  assert.equal(fetcher.diagnostics.downloads, 1);
  assert.equal(fetcher.diagnostics.failures, 3);
  assert.equal(fetcher.diagnostics.cacheableProviders, 2);
  assert.equal(fetcher.diagnostics.providers, 2);
  fetcher.providers = [];
  await assert.rejects(new TileCacheFetcher({ providers: [] }).load(TILE, null, dead.fetchBytes),
    /No public map source responded/);
  assert.equal(new TileCacheFetcher({ providers: [] }).providers.length, DEFAULT_MAP_PROVIDERS.length);
});

test('MAP-09 fetcher serves a resident tile from storage and never re-downloads it', async () => {
  const time = clock();
  const cache = makeCache(DEFAULT_MAP_PROVIDERS, time);
  await cache.open();
  const fetcher = new TileCacheFetcher({ providers: DEFAULT_MAP_PROVIDERS, cache });
  const first = fakeFetch(() => ({ data: bytes(512), cacheControl: 'max-age=600' }));
  const loaded = await fetcher.load(TILE, null, first.fetchBytes);
  assert.equal(loaded.servedFromCache, false);
  assert.equal(first.calls.length, 1);
  // A second request for the same tile is served straight from Cache Storage.
  const second = fakeFetch(() => { throw new Error('network must not be used'); });
  const cached = await fetcher.load(TILE, null, second.fetchBytes);
  assert.equal(cached.servedFromCache, true);
  assert.equal(second.calls.length, 0, 'the cache hit never touches the network');
  assert.equal(cached.data.byteLength, 512);
  assert.equal(fetcher.diagnostics.cacheHits, 1);
  assert.equal(fetcher.diagnostics.downloads, 1);
  assert.equal(cache.diagnostics.hits, 1);
  // A per-request opt-out bypasses the cache entirely (no read, no write).
  const bypassCache = makeCache(DEFAULT_MAP_PROVIDERS, time);
  await bypassCache.open();
  const bypass = new TileCacheFetcher({ providers: DEFAULT_MAP_PROVIDERS, cache: bypassCache });
  const direct = fakeFetch(() => ({ data: bytes(64), cacheControl: 'max-age=600' }));
  const fresh = await bypass.load({ ...TILE, tileCache: false }, null, direct.fetchBytes);
  assert.equal(fresh.servedFromCache, false);
  assert.equal(bypassCache.diagnostics.entries, 0, 'a bypassed request stores nothing');
  assert.equal(bypassCache.diagnostics.hits + bypassCache.diagnostics.misses, 0);
  // A provider that cannot be credited is fetched but never persisted.
  const anon = [{ id: 'anon', url: 'https://anon.invalid/{z}/{x}/{y}.pbf' }];
  const anonCache = makeCache(anon, time);
  await anonCache.open();
  const anonFetcher = new TileCacheFetcher({ providers: anon, cache: anonCache });
  const anonLoad = await anonFetcher.load(TILE, null, fakeFetch(() => ({ data: bytes(16) })).fetchBytes);
  assert.equal(anonLoad.attribution, '');
  assert.equal(anonCache.diagnostics.entries, 0, 'uncredited payloads are never persisted');
  const degraded = new TileCacheFetcher({
    providers: DEFAULT_MAP_PROVIDERS,
    resolveCache: () => { throw new Error('storage unavailable'); },
  });
  const degradedLoad = await degraded.load(TILE, null, fakeFetch(() => ({ data: bytes(8) })).fetchBytes);
  assert.equal(degradedLoad.servedFromCache, false, 'a refusing cache degrades to a plain load');
  assert.equal(degradedLoad.data.byteLength, 8);
});

test('MAP-09 retainer pins resident tiles and releases the ones that left', async () => {
  releaseTileCache();
  const retainer = createTileRetainer();
  const descriptors = [
    { zoom: 14, urlX: 9_001, urlY: 6_000 },
    { zoom: 14, urlX: 9_000, urlY: 6_000 },
  ];
  assert.equal(retainer.retain(descriptors, DEFAULT_MAP_PROVIDERS), 4, 'one pin per tile per provider');
  assert.deepEqual(retainer.keys(), [
    tileCacheKey('openstreetmap', descriptors[0]),
    tileCacheKey('openstreetmap', descriptors[1]),
    tileCacheKey('openfreemap', descriptors[0]),
    tileCacheKey('openfreemap', descriptors[1]),
  ].sort());
  // The retainer and the fetcher share one cache instance per identity.
  const cache = acquireTileCache({ profile: 'low', providers: DEFAULT_MAP_PROVIDERS });
  assert.equal(cache.diagnostics.pinned, 4);
  assert.equal(retainer.retain(descriptors, DEFAULT_MAP_PROVIDERS), 4, 'repeating a set is idempotent');
  assert.equal(cache.diagnostics.pinned, 4);
  // A tile leaving the resident set is unpinned; the rest stay pinned.
  assert.equal(retainer.retain([descriptors[1]], DEFAULT_MAP_PROVIDERS), 2);
  assert.equal(cache.diagnostics.pinned, 2);
  // Malformed descriptors and an empty set never change the pins.
  assert.equal(retainer.retain(null, DEFAULT_MAP_PROVIDERS), 2);
  assert.equal(retainer.retain([{ zoom: 14 }, { urlX: 'x' }], DEFAULT_MAP_PROVIDERS), 2);
  assert.equal(retainer.retain([], DEFAULT_MAP_PROVIDERS), 2);
  // A pinned tile survives a trim that would otherwise evict it.
  await cache.write('openfreemap', descriptors[1], { data: bytes(16), cacheControl: 'max-age=600' });
  await cache.write('openstreetmap', descriptors[1], { data: bytes(16), cacheControl: 'max-age=600' });
  for (let index = 0; index < 8; index++) {
    await cache.write('openfreemap', { zoom: 14, urlX: 500 + index, urlY: 1 },
      { data: bytes(1_024 * 1_024), cacheControl: 'max-age=600' });
  }
  assert.ok(cache.diagnostics.evictions > 0, 'unpinned tiles were trimmed');
  const pinnedKeys = [...cache.records.keys()].filter(key => retainer.keys().includes(key));
  assert.equal(pinnedKeys.length, 2, 'both pinned payloads are still resident');
  for (const key of pinnedKeys) assert.ok(cache.records.has(key), `${key} survived the trim`);
  retainer.clear();
  assert.equal(cache.diagnostics.pinned, 0);
  assert.equal(retainer.pinned, 0);
  releaseTileCache();
});
