import { featureNamespace } from '../engine/FeatureVersions.js';

export const GDO_TILE_CACHE_NAMESPACE = featureNamespace('tileCache');

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;
const HTTP_DATE_PATTERN = /^\s*(?:[A-Za-z]{3},\s|\d{1,2}\s+[A-Za-z]{3}\s+\d{4}|\d{4}-\d{2}-\d{2}T)/;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * `MAP-09` bounded persistent vector-tile cache. Every ceiling is explicit and
 * shared across profiles: low never exceeds the consolidated low-profile row,
 * and higher profiles scale the same policy rather than inventing a new one.
 */
export const GEO_TILE_CACHE_LIMITS = Object.freeze({
  schemaVersion: 1,
  profiles: Object.freeze(['low', 'balanced', 'high']),
  maxBytes: Object.freeze({ low: 6 * MEBIBYTE, balanced: 16 * MEBIBYTE, high: 32 * MEBIBYTE }),
  maxEntries: Object.freeze({ low: 24, balanced: 64, high: 128 }),
  // One source tile is a few hundred KB; a payload past this is refused rather
  // than allowed to evict the whole cache.
  maxEntryBytes: 3 * MEBIBYTE,
  // Provider cache semantics: honour a bounded Cache-Control/Expires hint, then
  // fall back to a fixed lifetime so a stale tile cannot live forever.
  defaultTtlMilliseconds: 6 * HOUR,
  minimumTtlMilliseconds: MINUTE,
  maximumTtlMilliseconds: 14 * 24 * HOUR,
  // Attribution is not optional: a payload whose provider cannot be credited is
  // never persisted, and stored payloads carry the credit they were fetched under.
  maxAttributionLength: 160,
  manifestKey: '__gdo_manifest__',
  maximumPruneChecks: 4_096,
});

/** The one key format. Provider identity and schema version are part of it. */
export function tileCacheKey(providerId, { zoom, urlX, urlY }) {
  return `${GDO_TILE_CACHE_NAMESPACE}:${providerId}:${zoom}/${urlX}/${urlY}`;
}

/** Cache-Control/Expires parsing, bounded and provider-neutral. */
export function tileCacheTtlMilliseconds(cacheControl, { now = Date.now() } = {}) {
  const fallback = GEO_TILE_CACHE_LIMITS.defaultTtlMilliseconds;
  if (typeof cacheControl !== 'string' || !cacheControl) return fallback;
  // A bare HTTP date is the other half of provider cache semantics. It is only
  // attempted when the value actually looks like one: `Date.parse` is lenient
  // enough to read `max-age=3600` as a year, which must never define a lifetime.
  if (!cacheControl.includes('=') && HTTP_DATE_PATTERN.test(cacheControl)) {
    const asDate = Date.parse(cacheControl);
    if (Number.isFinite(asDate)) {
      return Math.max(GEO_TILE_CACHE_LIMITS.minimumTtlMilliseconds,
        Math.min(GEO_TILE_CACHE_LIMITS.maximumTtlMilliseconds, asDate - now));
    }
  }
  const directives = new Map(cacheControl.split(',')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean)
    .map(part => {
      const separator = part.indexOf('=');
      return separator === -1 ? [part, ''] : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
    }));
  if (directives.has('no-store') || directives.has('private')) return 0;
  const seconds = Number(directives.get('max-age') ?? directives.get('s-maxage'));
  if (Number.isFinite(seconds)) {
    return Math.max(GEO_TILE_CACHE_LIMITS.minimumTtlMilliseconds,
      Math.min(GEO_TILE_CACHE_LIMITS.maximumTtlMilliseconds, seconds * 1_000));
  }
  return fallback;
}

/**
 * Per-profile policy. An unknown profile selects the low ceilings rather than
 * an unbounded one, so a bad argument can never widen storage.
 */
export function tileCachePolicy(profile) {
  const name = GEO_TILE_CACHE_LIMITS.profiles.includes(profile) ? profile : 'low';
  return Object.freeze({
    profile: name,
    schemaVersion: GEO_TILE_CACHE_LIMITS.schemaVersion,
    maxBytes: GEO_TILE_CACHE_LIMITS.maxBytes[name],
    maxEntries: GEO_TILE_CACHE_LIMITS.maxEntries[name],
    maxEntryBytes: GEO_TILE_CACHE_LIMITS.maxEntryBytes,
  });
}

/** Attribution identity: what a stored payload must be able to say about itself. */
export function tileCacheProviderConfig(provider) {
  const id = typeof provider?.id === 'string' ? provider.id.trim() : '';
  const attribution = typeof provider?.attribution === 'string' ? provider.attribution.trim() : '';
  if (!id) throw new TypeError('Tile cache providers require a stable id');
  if (attribution.length > GEO_TILE_CACHE_LIMITS.maxAttributionLength) {
    throw new RangeError('Tile cache attribution text is too long');
  }
  return Object.freeze({ id, attribution, cacheable: attribution.length > 0 });
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return -1;
}

function toUint8(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

/**
 * Default adapter: an in-memory LRU used in Node tests and as the fallback when
 * a browser refuses persistent storage (private mode, disabled quota).
 */
export function createMemoryTileStorage({ maxBytes = 8 * MEBIBYTE } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new RangeError('Invalid memory tile storage budget');
  const entries = new Map();
  let bytes = 0, trimmed = 0;
  return Object.freeze({
    kind: 'memory',
    persistent: false,
    async get(key) { return entries.get(key) ?? null; },
    async put(key, value) {
      const bytesValue = bytesOf(value);
      const data = toUint8(value);
      if (!data || bytesValue < 0) throw new TypeError('Tile storage accepts byte payloads only');
      const previous = entries.get(key);
      if (previous) bytes -= previous.byteLength;
      entries.delete(key);
      entries.set(key, data);
      bytes += data.byteLength;
      // The adapter stays bounded even if the policy layer ever misbehaves.
      while (bytes > maxBytes && entries.size > 1) {
        const oldest = entries.keys().next().value;
        bytes -= entries.get(oldest).byteLength;
        entries.delete(oldest);
        trimmed++;
      }
      return true;
    },
    async delete(key) {
      const previous = entries.get(key);
      if (!previous) return false;
      bytes -= previous.byteLength;
      entries.delete(key);
      return true;
    },
    async list() { return [...entries.keys()].sort(); },
    async clear() { entries.clear(); bytes = 0; },
    diagnostics: () => Object.freeze({ kind: 'memory', entries: entries.size, bytes, trimmed }),
  });
}

/**
 * Browser/worker adapter over the Cache Storage API. Only two synthetic URLs are
 * ever used per record, so byte accounting stays explicit instead of relying on
 * an opaque quota estimate.
 */
export function createCacheStorageTileStorage(cacheStorage, { name = `${GDO_TILE_CACHE_NAMESPACE}:data` } = {}) {
  if (!cacheStorage || typeof cacheStorage.open !== 'function') {
    throw new TypeError('Cache Storage adapter requires a caches-like object');
  }
  if (typeof name !== 'string' || !name) throw new TypeError('Tile cache storage requires a name');
  const url = key => `https://gdo-tile-cache.invalid/${encodeURIComponent(key)}`;
  const keyOf = requestUrl => decodeURIComponent(String(requestUrl).split('/').pop() ?? '');
  const resolve = () => cacheStorage.open(name);
  return Object.freeze({
    kind: 'cache-storage',
    persistent: true,
    name,
    async get(key) {
      const cache = await resolve();
      const response = await cache.match(url(key));
      if (!response) return null;
      const buffer = await response.arrayBuffer();
      return buffer.byteLength ? new Uint8Array(buffer) : null;
    },
    async put(key, value) {
      const data = toUint8(value);
      if (!data) throw new TypeError('Cache Storage adapter accepts byte payloads only');
      const cache = await resolve();
      await cache.put(url(key), new Response(data, {
        headers: { 'content-type': 'application/octet-stream' },
      }));
      return true;
    },
    async delete(key) {
      const cache = await resolve();
      return cache.delete(url(key));
    },
    async list() {
      const cache = await resolve();
      const requests = await cache.keys();
      return requests.map(request => keyOf(request.url ?? request)).sort();
    },
    async clear() {
      const cache = await resolve();
      const requests = await cache.keys();
      for (const request of requests) await cache.delete(request?.url ?? request);
      return requests.length;
    },
    diagnostics: () => Object.freeze({ kind: 'cache-storage', name }),
  });
}

/** Pick the best available adapter without ever throwing at a call site. */
export function resolveTileStorage({ cacheStorage = globalThis.caches ?? null, memoryBytes } = {}) {
  if (cacheStorage && typeof cacheStorage.open === 'function') {
    try {
      const probe = cacheStorage.open(`${GDO_TILE_CACHE_NAMESPACE}:data`);
      // A store that rejects asynchronously must not surface an unhandled
      // rejection; the adapter surfaces the same refusal on its own operations.
      if (probe && typeof probe.catch === 'function') probe.catch(() => {});
      return createCacheStorageTileStorage(cacheStorage);
    } catch { /* fall through to memory */ }
  }
  return createMemoryTileStorage(memoryBytes ? { maxBytes: memoryBytes } : undefined);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * `MAP-09` cache. Owns the version, byte/entry ceilings, LRU order, TTL, and
 * attribution identity; the adapter only stores bytes. Every operation is
 * deterministic: keys are read in sorted order, ties break on the key, and the
 * clock is injected.
 */
export class TileCache {
  constructor({
    storage,
    profile = 'low',
    providers = [],
    now = () => Date.now(),
    limits = GEO_TILE_CACHE_LIMITS,
  } = {}) {
    if (!storage || typeof storage.get !== 'function' || typeof storage.put !== 'function' ||
        typeof storage.delete !== 'function' || typeof storage.list !== 'function') {
      throw new TypeError('TileCache requires a keyed byte storage adapter');
    }
    if (typeof now !== 'function') throw new TypeError('TileCache requires a clock');
    if (profile !== undefined && profile !== null && !limits.profiles.includes(profile)) {
      throw new RangeError(`Unknown tile cache profile: ${profile}`);
    }
    this.storage = storage;
    this.policy = tileCachePolicy(profile);
    this.providers = new Map();
    for (const provider of providers) {
      const config = tileCacheProviderConfig(provider);
      this.providers.set(config.id, config);
    }
    this.now = now;
    this.limits = limits;
    this.identity = JSON.stringify(this.limits.schemaVersion) + '|' +
      [...this.providers.entries()].map(([id, config]) => `${id}|${config.attribution}`).join(';');
    this.records = new Map();
    this.pinned = new Set();
    this.opened = false;
    this.disposed = false;
    this.hits = 0;
    this.misses = 0;
    this.writes = 0;
    this.evictions = 0;
    this.expirations = 0;
    this.rejections = 0;
    this.attributionRejections = 0;
    this.oversizedRejections = 0;
    this.invalidated = 0;
    this.prunes = 0;
    this.pruneChecks = 0;
    this.steadyFrameOperations = 0;
    this.storageErrors = 0;
    this.capEvents = { entries: false, bytes: false, oversized: false, attribution: false };
  }

  get bytes() {
    let total = 0;
    for (const record of this.records.values()) total += record.bytes;
    return total;
  }

  get entries() { return this.records.size; }

  providerConfig(providerId) {
    return this.providers.get(providerId) ?? null;
  }

  /**
   * Load the manifest and reconcile it with the current schema, provider set, and
   * attribution text. A mismatch deletes the payload instead of serving it under
   * a credit it was not fetched with.
   */
  async open() {
    if (this.disposed) throw new Error('TileCache is disposed');
    const manifest = await this._readManifest();
    const keys = await this.storage.list();
    const known = new Set(), handled = new Set();
    for (const key of keys) {
      if (key === this.limits.manifestKey) continue;
      const record = manifest?.records?.[key] ?? null;
      const config = record ? this.providerConfig(record.providerId) : null;
      const usable = Boolean(record && record.version === this.policy.schemaVersion &&
        Number.isInteger(record.bytes) && record.bytes >= 0 &&
        Number.isFinite(record.expiresAt) && Number.isFinite(record.storedAt) &&
        config && config.cacheable && config.attribution === record.attribution);
      handled.add(key);
      if (!usable) {
        await this.storage.delete(key);
        this.invalidated++;
        continue;
      }
      known.add(key);
      this.records.set(key, {
        key,
        bytes: record.bytes,
        storedAt: record.storedAt,
        expiresAt: record.expiresAt,
        lastUsed: Number.isFinite(record.lastUsed) ? record.lastUsed : record.storedAt,
        providerId: record.providerId,
        attribution: record.attribution,
        url: typeof record.url === 'string' ? record.url : '',
      });
    }
    // A payload with no manifest record is unaccountable, so it cannot be trusted.
    for (const key of keys) {
      if (key === this.limits.manifestKey || known.has(key) || handled.has(key)) continue;
      await this.storage.delete(key);
      this.invalidated++;
    }
    this.opened = true;
    await this.prune();
    return this.diagnostics;
  }

  async _readManifest() {
    try {
      const bytes = await this.storage.get(this.limits.manifestKey);
      if (!bytes?.byteLength) return null;
      const parsed = JSON.parse(decoder.decode(bytes));
      if (!parsed || parsed.version !== this.policy.schemaVersion) return null;
      if (!parsed.records || typeof parsed.records !== 'object') return null;
      return parsed;
    } catch {
      // A corrupt manifest invalidates the cache instead of throwing into a frame.
      await this.storage.delete(this.limits.manifestKey);
      return null;
    }
  }

  async _writeManifest() {
    const records = {};
    for (const key of [...this.records.keys()].sort()) {
      const record = this.records.get(key);
      records[key] = {
        version: this.policy.schemaVersion,
        bytes: record.bytes,
        storedAt: record.storedAt,
        expiresAt: record.expiresAt,
        lastUsed: record.lastUsed,
        providerId: record.providerId,
        attribution: record.attribution,
        url: record.url,
      };
    }
    await this.storage.put(this.limits.manifestKey, encoder.encode(JSON.stringify({
      namespace: GDO_TILE_CACHE_NAMESPACE,
      version: this.policy.schemaVersion,
      profile: this.policy.profile,
      records,
    })));
  }

  /** Cache-first read. A stale, expired, or unpinned-overflow record is a miss. */
  async read(providerId, tile) {
    if (this.disposed) return null;
    const key = tileCacheKey(providerId, tile);
    const config = this.providerConfig(providerId);
    const record = this.records.get(key);
    if (!record || !config?.cacheable || record.attribution !== config.attribution) {
      if (record) { await this._drop(key); this.invalidated++; }
      this.misses++;
      return null;
    }
    if (record.expiresAt <= this.now()) {
      await this._drop(key);
      this.expirations++;
      this.misses++;
      return null;
    }
    const bytes = await this.storage.get(key);
    if (!bytes?.byteLength || bytes.byteLength !== record.bytes) {
      await this._drop(key);
      this.invalidated++;
      this.misses++;
      return null;
    }
    record.lastUsed = this.now();
    this.hits++;
    return Object.freeze({
      data: bytes,
      providerId,
      attribution: record.attribution,
      url: record.url,
      bytes: record.bytes,
      storedAt: record.storedAt,
      expiresAt: record.expiresAt,
      cached: true,
    });
  }

  /**
   * Store one payload. Attributed providers only, and the LRU order is trimmed
   * before the write so the ceiling is never exceeded even momentarily.
   */
  async write(providerId, tile, { data, cacheControl = '', url = '' } = {}) {
    if (this.disposed) return false;
    const bytes = bytesOf(data) === -1 ? null : toUint8(data);
    if (!bytes || !bytes.byteLength) {
      this.rejections++;
      return false;
    }
    const config = this.providerConfig(providerId);
    if (!config?.cacheable) {
      this.attributionRejections++;
      this.capEvents = { ...this.capEvents, attribution: true };
      return false;
    }
    if (bytes.byteLength > this.policy.maxEntryBytes) {
      this.oversizedRejections++;
      this.capEvents = { ...this.capEvents, oversized: true };
      return false;
    }
    const ttl = tileCacheTtlMilliseconds(cacheControl, { now: this.now() });
    if (ttl <= 0) {
      this.rejections++;
      return false;
    }
    const key = tileCacheKey(providerId, tile);
    const storedAt = this.now();
    const record = {
      key, bytes: bytes.byteLength, storedAt, expiresAt: storedAt + ttl, lastUsed: storedAt,
      providerId, attribution: config.attribution, url: typeof url === 'string' ? url : '',
    };
    this.records.set(key, record);
    await this.prune();
    if (this.records.get(key) !== record) {
      // The incoming payload was the LRU victim of its own write; refuse it.
      this.rejections++;
      return false;
    }
    await this.storage.put(key, bytes);
    await this._writeManifest();
    this.writes++;
    return true;
  }

  /**
   * Drop expired records, then trim least-recently-used records until both the
   * byte and entry ceilings hold. Pinned records (the player's own tiles) are
   * never chosen while an unpinned candidate exists.
   */
  async prune() {
    this.prunes++;
    const now = this.now();
    for (const key of [...this.records.keys()].sort()) {
      if (this.pruneChecks >= this.limits.maximumPruneChecks) break;
      this.pruneChecks++;
      const record = this.records.get(key);
      if (record.expiresAt <= now) {
        await this._drop(key);
        this.expirations++;
      }
    }
    const order = () => [...this.records.keys()].sort((first, second) => {
      const a = this.records.get(first), b = this.records.get(second);
      const pinned = Number(this.pinned.has(first)) - Number(this.pinned.has(second));
      return pinned || a.lastUsed - b.lastUsed || first.localeCompare(second);
    });
    while (this.records.size > this.policy.maxEntries) {
      const victim = order().find(key => !this.pinned.has(key));
      if (!victim) { this.capEvents = { ...this.capEvents, entries: true }; break; }
      await this._drop(victim);
      this.evictions++;
      this.capEvents = { ...this.capEvents, entries: true };
    }
    while (this.bytes > this.policy.maxBytes) {
      const victim = order().find(key => !this.pinned.has(key));
      if (!victim) { this.capEvents = { ...this.capEvents, bytes: true }; break; }
      await this._drop(victim);
      this.evictions++;
      this.capEvents = { ...this.capEvents, bytes: true };
    }
    if (this.records.size) await this._writeManifest();
    else await this.storage.delete(this.limits.manifestKey);
    return this.diagnostics;
  }

  async _drop(key) {
    this.records.delete(key);
    await this.storage.delete(key);
  }

  /** Drop one tile. Used to self-heal a payload the decoder now refuses. */
  async invalidate(providerId, tile) {
    const key = tileCacheKey(providerId, tile);
    if (!this.records.has(key)) return false;
    await this._drop(key);
    this.invalidated++;
    await this._writeManifest();
    return true;
  }

  /** Pin a key so per-tile eviction can never remove the player's own tiles. */
  pin(providerId, tile) {
    const key = tileCacheKey(providerId, tile);
    const added = !this.pinned.has(key);
    this.pinned.add(key);
    return added;
  }

  unpin(providerId, tile) {
    return this.pinned.delete(tileCacheKey(providerId, tile));
  }

  async clear() {
    const removed = this.records.size;
    this.records.clear();
    this.pinned.clear();
    for (const key of await this.storage.list()) await this.storage.delete(key);
    await this.storage.delete(this.limits.manifestKey);
    return removed;
  }

  /**
   * Cache-first tile load. The loader is only called on a miss, and a failed
   * load is reported without writing a partial payload.
   */
  async load(providerId, tile, loader, { cacheControl = '', url = '' } = {}) {
    // A storage that refuses to cooperate (private mode, revoked quota) degrades
    // to a plain network load: map streaming never depends on the cache.
    let cached = null;
    try {
      cached = await this.read(providerId, tile);
    } catch { this.storageErrors++; }
    if (cached) return { data: cached.data, cached: true, stored: false, providerId, attribution: cached.attribution };
    const loaded = await loader();
    if (!loaded?.data) throw new Error('Tile loader returned no payload');
    let stored = false;
    try {
      stored = await this.write(providerId, tile, {
        data: loaded.data,
        cacheControl: loaded.cacheControl ?? cacheControl,
        url: 'url' in loaded ? loaded.url : url,
      });
    } catch { this.storageErrors++; }
    return {
      data: toUint8(loaded.data), cached: false, stored, providerId,
      attribution: this.providerConfig(providerId)?.attribution ?? '',
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.records.clear();
    this.pinned.clear();
  }

  get diagnostics() {
    const storageDiagnostics = typeof this.storage.diagnostics === 'function'
      ? this.storage.diagnostics() : null;
    return Object.freeze({
      namespace: GDO_TILE_CACHE_NAMESPACE,
      profile: this.policy.profile,
      schemaVersion: this.policy.schemaVersion,
      persistent: Boolean(this.storage.persistent),
      storageKind: this.storage.kind ?? 'unknown',
      storage: storageDiagnostics,
      opened: this.opened,
      entries: this.entries,
      bytes: this.bytes,
      maxBytes: this.policy.maxBytes,
      maxEntries: this.policy.maxEntries,
      pinned: this.pinned.size,
      providers: this.providers.size,
      cacheableProviders: [...this.providers.values()].filter(config => config.cacheable).length,
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      evictions: this.evictions,
      expirations: this.expirations,
      rejections: this.rejections,
      attributionRejections: this.attributionRejections,
      oversizedRejections: this.oversizedRejections,
      invalidated: this.invalidated,
      prunes: this.prunes,
      pruneChecks: this.pruneChecks,
      steadyFrameOperations: this.steadyFrameOperations,
      storageErrors: this.storageErrors,
      capEvents: Object.freeze({ ...this.capEvents }),
      disposed: this.disposed,
    });
  }
}

let sharedCache = null;

/**
 * One resident cache per worker/profile. Repeated calls with the same identity
 * reuse the instance so a tile stream never opens the same storage twice.
 */
export function acquireTileCache({ storage, profile, providers, now } = {}) {
  const resolvedProfile = GEO_TILE_CACHE_LIMITS.profiles.includes(profile) ? profile : 'low';
  const identity = JSON.stringify(GEO_TILE_CACHE_LIMITS.schemaVersion) + '|' +
    (providers?.length ? providers : []).map(provider =>
      `${provider?.id ?? ''}|${provider?.attribution ?? ''}`).join(';');
  if (sharedCache && !sharedCache.disposed && sharedCache.policy.profile === resolvedProfile &&
      sharedCache.identity === identity) return sharedCache;
  sharedCache?.dispose();
  sharedCache = new TileCache({
    storage: storage ?? resolveTileStorage(),
    profile,
    providers,
    now,
  });
  return sharedCache;
}

export function releaseTileCache() {
  sharedCache?.dispose();
  sharedCache = null;
}
