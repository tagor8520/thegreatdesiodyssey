import { acquireTileCache, tileCacheKey } from './GeoTileCache.js';

/**
 * The provider contract. `attribution` is not decoration: `MAP-09` only persists
 * a payload when the provider that served it can still be credited.
 */
export const DEFAULT_MAP_PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'openfreemap',
    label: 'OpenFreeMap / OpenMapTiles',
    url: 'https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf',
    attribution: '© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap',
  }),
  Object.freeze({
    id: 'openstreetmap',
    label: 'OpenStreetMap Shortbread',
    url: 'https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt',
    attribution: '© OpenStreetMap contributors · Shortbread',
  }),
]);

export function mapTileUrl(template, request) {
  return String(template)
    .replace('{z}', String(request.zoom))
    .replace('{x}', String(request.urlX))
    .replace('{y}', String(request.urlY));
}

/**
 * `MAP-09` cache-first provider loop, independent of `fetch` and of the tile
 * decoder so it can be exercised deterministically. Behaviour:
 *
 * 1. try providers in the configured order;
 * 2. for each, read the persistent cache first and only call `fetchBytes` on a
 *    miss;
 * 3. validate the payload through the injected decoder, so an HTML error body
 *    with HTTP 200 falls through to the next provider instead of being stored;
 * 4. record whether the payload came from the cache and whether it was stored.
 *
 * Every failure is caught per provider; the caller sees one error only when no
 * source responded. A refusing cache degrades to plain network loads.
 */
export class TileCacheFetcher {
  constructor({
    providers = DEFAULT_MAP_PROVIDERS,
    profile = 'low',
    cache = null,
    decode = null,
    resolveCache = acquireTileCache,
  } = {}) {
    if (decode !== null && typeof decode !== 'function') throw new TypeError('Tile fetcher decode must be a function');
    this.providers = providers?.length ? Object.freeze([...providers]) : DEFAULT_MAP_PROVIDERS;
    this.profile = profile;
    this.cache = cache;
    this.decode = decode;
    this.resolveCache = resolveCache;
    this.failures = [];
    this.requests = 0;
    this.downloads = 0;
    this.cacheHits = 0;
    this.decodeRejections = 0;
    this.invalidCachedPayloads = 0;
  }

  get cacheable() {
    return this.providers.some(provider => Boolean(provider?.attribution));
  }

  /** The shared cache for this fetcher's profile/provider identity, or null. */
  _cache() {
    if (this.cache) return this.cache;
    try {
      this.cache = this.resolveCache({ profile: this.profile, providers: this.providers });
      return this.cache;
    } catch {
      return null;
    }
  }

  /**
   * Load one tile. `fetchBytes(provider, request, signal)` returns
   * `{ data, cacheControl?, url? }` and must perform the actual network request.
   */
  async load(request, signal, fetchBytes) {
    if (typeof fetchBytes !== 'function') throw new TypeError('Tile fetcher requires a byte loader');
    this.requests++;
    const failures = [];
    for (const provider of this.providers) {
      if (!provider?.id || !provider.url) continue;
      if (signal?.aborted) throw signal.reason ?? new Error('Tile request aborted');
      const url = mapTileUrl(provider.url, request);
      try {
        let data = null, cacheControl = '', servedFromCache = false;
        const cache = request?.tileCache === false || !provider.attribution ? null : this._cache();
        if (cache) {
          // Cache first, but never trust a stored payload the decoder rejects:
          // the entry is invalidated so a bad byte stream cannot be served twice.
          const cached = await this._readValidated(cache, provider, request);
          if (cached) {
            data = cached;
            servedFromCache = true;
          }
        }
        if (!data) {
          const loaded = await fetchBytes(provider, request, signal);
          data = loaded?.data;
          cacheControl = loaded?.cacheControl ?? '';
          if (!data?.byteLength) throw new Error('empty tile');
          // Decode before storing: nothing invalid may ever reach persistent storage.
          if (this.decode) this.decode(data);
          if (cache) {
            await cache.write(provider.id, request, {
              data, cacheControl, url: loaded?.url ?? url,
            });
          }
        }
        if (servedFromCache) this.cacheHits++;
        else this.downloads++;
        const vectorTile = this.decode ? this.decode(data) : null;
        return Object.freeze({
          data, vectorTile, url,
          provider: provider.label ?? provider.id,
          providerId: provider.id,
          attribution: provider.attribution ?? '',
          servedFromCache,
          cacheControl,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (this.decode && typeof error?.message === 'string' && /decode/i.test(error.message)) {
          this.decodeRejections++;
        }
        failures.push(`${provider.label ?? provider.id}: ${error.message || error}`);
        this.failures.push(failures.at(-1));
      }
    }
    throw new Error(`No public map source responded (${failures.join('; ')})`);
  }

  /** Read one tile from storage and reject it if the decoder refuses it. */
  async _readValidated(cache, provider, request) {
    let cached = null;
    try {
      cached = await cache.read(provider.id, request);
    } catch {
      return null;
    }
    if (!cached?.data?.byteLength) return null;
    if (!this.decode) return cached.data;
    try {
      this.decode(cached.data);
      return cached.data;
    } catch {
      // Self-healing: a stored payload that no longer decodes is dropped.
      this.decodeRejections++;
      this.invalidCachedPayloads++;
      try { await cache.invalidate(provider.id, request); } catch { /* best effort */ }
      return null;
    }
  }

  get diagnostics() {
    return Object.freeze({
      providers: this.providers.length,
      cacheableProviders: this.providers.filter(provider => Boolean(provider?.attribution)).length,
      requests: this.requests,
      downloads: this.downloads,
      cacheHits: this.cacheHits,
      failures: this.failures.length,
      decodeRejections: this.decodeRejections,
      invalidCachedPayloads: this.invalidCachedPayloads,
      cache: this.cache?.diagnostics ?? null,
    });
  }
}

/**
 * Pin the resident tiles in every provider key space. Pinning is what stops a
 * cache trim from evicting the tiles the player is standing in; the set is
 * bounded by the world's four-tile resident cap, and the worker keeps this state
 * across requests so repeated retain messages are idempotent.
 */
export function createTileRetainer({ resolveCache = acquireTileCache } = {}) {
  const retained = new Map();
  return Object.freeze({
    /** Pin `descriptors` and unpin every previously retained tile. */
    retain(descriptors, providers = DEFAULT_MAP_PROVIDERS, profile = 'low') {
      if (!Array.isArray(descriptors)) return retained.size;
      const wanted = new Map();
      for (const descriptor of descriptors) {
        if (!Number.isFinite(descriptor?.zoom) || !Number.isFinite(descriptor?.urlX) ||
            !Number.isFinite(descriptor?.urlY)) continue;
        const tile = { zoom: descriptor.zoom, urlX: descriptor.urlX, urlY: descriptor.urlY };
        for (const provider of providers) {
          if (!provider?.id) continue;
          wanted.set(tileCacheKey(provider.id, tile), { providerId: provider.id, tile });
        }
      }
      if (!wanted.size) return retained.size;
      const cache = resolveCache({ profile, providers });
      for (const [key, entry] of [...retained.entries()].sort(([first], [second]) => first.localeCompare(second))) {
        if (wanted.has(key)) continue;
        cache.unpin(entry.providerId, entry.tile);
        retained.delete(key);
      }
      for (const [key, entry] of [...wanted.entries()].sort(([first], [second]) => first.localeCompare(second))) {
        if (cache.pin(entry.providerId, entry.tile)) retained.set(key, entry);
      }
      return retained.size;
    },
    get pinned() { return retained.size; },
    keys: () => Object.freeze([...retained.keys()].sort()),
    clear() {
      for (const [key, entry] of retained) {
        resolveCache()?.unpin(entry.providerId, entry.tile);
        retained.delete(key);
      }
    },
  });
}
