/**
 * `MAP-09` — a bounded, versioned, persistent cache for provider tile payloads.
 *
 * WHY THIS EXISTS
 * ---------------
 * `MAP_STREAMING_RESEARCH.md` §3 records the policy constraint that shapes this
 * module: the vector-tile hosts this project reads are free public services and
 * their guidance is to *cache and rate-limit* requests, not to refetch for every
 * visitor. The runtime's own HTTP cache covers one session on one machine, but it
 * cannot know what this application knows: which tiles belong to the world the
 * player is standing in, when a payload is no longer for the source the app is
 * declaring, or how much of the origin's storage quota it is worth spending.
 * §4.7's recommended evolution says it exactly: *"Add Cache Storage/IndexedDB LRU
 * with an explicit byte quota and provider cache semantics."*
 *
 * WHAT IS CACHED, AND WHAT IS NOT
 * -------------------------------
 * Only the **provider's response bytes** for one tile URL are cached. Everything
 * the worker builds from those bytes — roads, context, land, water, buildings,
 * colliders, biome fields — is recomputed on every load. That is deliberate: the
 * payload is *provider* data and the build is *our* code, so a grammar, budget or
 * geometry change invalidates nothing here and cannot be served stale. Feature
 * versions therefore do **not** appear in the cache key, and this module's own
 * record format, the provider's identity and the tile coordinates do. The two
 * dimensions that can make a payload wrong are:
 *
 * 1. **The provider's identity**, including the URL template and the label the
 *    application declares. `providerFingerprint` hashes all three. This is what
 *    makes the cache *attribution-safe*: an entry is only ever served for the
 *    source that produced it, so a tile can never be credited to a host that did
 *    not serve it — and in development, where one origin stands in for several
 *    fixtures, switching the fixture changes the label and therefore the key. A
 *    cache that keyed on the provider id alone would serve the dense-urban
 *    fixture's buildings after the app had switched to the mapped coast, which is
 *    both a visual defect and a misattribution.
 * 2. **This module's record format**, carried in the namespace and in the
 *    IndexedDB version. A bump cannot read old records: the upgrade deletes the
 *    stores rather than interpreting bytes it did not write.
 *
 * AGGREGATE TILES ARE CONTENT, SO THEY ARE NOT CACHED HERE
 * --------------------------------------------------------
 * The cache stores one entry per requested tile URL. It deliberately does not
 * deduplicate identical payloads by content hash: the ceiling exists to bound
 * storage, and the tiles the runtime asks for are the ones the player is standing
 * in, so a content-addressed variant would buy a few kilobytes of dev-fixture
 * duplication at the cost of an index that has to be kept consistent with the
 * LRU order.
 *
 * A CACHE MAY FORGET; A SAVE MAY NOT
 * ----------------------------------
 * `NET-01`'s rule is that a document this build cannot read is never destroyed.
 * The opposite is required here. A cache is disposable by construction — the
 * worst case of dropping every entry is refetching a tile — so a corrupt
 * manifest, a schema mismatch or a storage error during open all end in the same
 * place: the store is emptied, the counters say so, and the world fetches what it
 * needs. Code that treats a cache like a save will eventually refuse to run
 * because an optimization broke, which is the failure this module exists to
 * avoid.
 */

const MEBIBYTE = 1024 * 1024;

/** The record format. Bumping it makes every existing entry unreadable, on purpose. */
export const GEO_TILE_CACHE_SCHEMA = 1;

/** IndexedDB database name; the version is the schema, so an upgrade resets the stores. */
export const GEO_TILE_CACHE_DATABASE = 'gdo-tile-cache';

export const GEO_TILE_CACHE_OBJECT_STORE = 'tiles';
export const GEO_TILE_CACHE_META_STORE = 'meta';
export const GEO_TILE_CACHE_MANIFEST_KEY = 'manifest';

/** The key namespace records are written under. A record from another namespace is not ours. */
export const GEO_TILE_CACHE_NAMESPACE = `gdo:tilecache:v${GEO_TILE_CACHE_SCHEMA}`;

/**
 * The ceilings.
 *
 * `bytes` is the default budget and the profiles scale it — a low-power device is
 * the one whose storage is most likely to be under pressure, and a tile cache is
 * the least valuable thing on it. `entries` is an independent cap so a pathological
 * provider answering with tiny payloads cannot turn the budget into a record count
 * the LRU scan has to walk. `entryBytes` refuses a single oversized record rather
 * than letting it evict the whole cache to hold one tile. `maxAgeSeconds` is the
 * default provider cache policy (30 days): tile data for a city block does not
 * change hourly, and a stale-by-a-month building outline is a smaller problem than
 * a cache that never revalidates.
 */
export const GEO_TILE_CACHE_LIMITS = Object.freeze({
  bytes: 8 * MEBIBYTE,
  entries: 512,
  entryBytes: 1 * MEBIBYTE,
  maxAgeSeconds: 30 * 24 * 60 * 60,
});

/** Per-profile byte budgets. Coordinate Explorer ships `low`, so 4 MiB is the default it runs. */
export const GEO_TILE_CACHE_BYTES_BY_PROFILE = Object.freeze({
  low: 4 * MEBIBYTE,
  balanced: 8 * MEBIBYTE,
  high: 16 * MEBIBYTE,
});

/**
 * What one record costs against the ceiling beyond its payload.
 *
 * The ceiling exists to bound the origin's storage, and a record is not its
 * payload: the key, the provider identity, the two timestamps and IndexedDB's own
 * bookkeeping all live in the same database. Counting them as a fixed overhead
 * keeps the number honest without pretending to be a byte-exact measure of the
 * file, which no browser exposes.
 */
export const GEO_TILE_CACHE_RECORD_OVERHEAD = 192;

/** The one message every consumer needs: an optimization must never become a dependency. */
export const GEO_TILE_CACHE_OFFLINE_REASON = 'tile cache storage is unavailable, so every tile will be fetched';

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

function utf8Length(text) {
  const value = String(text);
  if (encoder) return encoder.encode(value).length;
  return value.length;
}

/** FNV-1a, the same hash the journal and the weather seed use, so one hash reads the same everywhere. */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  const value = String(text);
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A provider's identity as the application can know it *before* a request is made.
 *
 * The URL template and the label are both part of it. The template is what makes
 * two OpenMapTiles-compatible sources different entries; the label is what makes
 * the development fixture provider different from itself after a fixture switch,
 * since that provider keeps one id and one template while changing what it serves.
 * The label is normally a human string, and hashing it is legitimate here for the
 * same reason it is legitimate in the save's id scheme: it is a *declared*
 * identity, and a declaration that changes must not silently reuse the old bytes.
 */
export function providerFingerprint(provider) {
  if (!provider || typeof provider.id !== 'string' || typeof provider.url !== 'string') {
    throw new TypeError('A tile provider needs a string id and a string url');
  }
  return fnv1a(`${provider.id}|${provider.url}|${provider.label ?? ''}`).toString(16).padStart(8, '0');
}

/** The cache key for one tile under one source. Deterministic, readable and stable. */
export function tileCacheKey(fingerprint, zoom, x, y) {
  if (typeof fingerprint !== 'string' || !fingerprint) throw new TypeError('A tile cache key needs a provider fingerprint');
  if (![zoom, x, y].every(Number.isFinite)) throw new TypeError('A tile cache key needs finite zoom/x/y');
  return `${GEO_TILE_CACHE_NAMESPACE}|${fingerprint}|${zoom}/${x}/${y}`;
}

/**
 * Whether a provider's own configuration permits caching, and for how long.
 *
 * `cache: false` is a *prohibition*, not a preference — the same reading the
 * weather table gives a zero climate weight. A provider that says it must not be
 * stored is never stored, and the worker does not even look one up, so the
 * presence of an old entry cannot resurrect a source that has been withdrawn.
 */
export function providerCachePolicy(provider, { limits = GEO_TILE_CACHE_LIMITS } = {}) {
  if (!provider) return { cacheable: false, maxAgeSeconds: 0, reason: 'no provider' };
  if (provider.cache === false) return { cacheable: false, maxAgeSeconds: 0, reason: 'the provider declares it must not be cached' };
  const declared = Number.isFinite(provider.cache?.maxAgeSeconds) ? provider.cache.maxAgeSeconds : null;
  if (declared === 0) return { cacheable: false, maxAgeSeconds: 0, reason: 'the provider sets a zero cache lifetime' };
  return { cacheable: true, maxAgeSeconds: declared ?? limits.maxAgeSeconds, reason: '' };
}

/** The byte budget for a quality profile, falling back to the default budget. */
export function tileCacheBytesForProfile(profile, limits = GEO_TILE_CACHE_LIMITS) {
  const declared = GEO_TILE_CACHE_BYTES_BY_PROFILE[profile];
  return Number.isFinite(declared) ? declared : limits.bytes;
}

/**
 * A storage adapter over an in-memory map.
 *
 * This is the contract every other adapter implements, and it is what the Node tier
 * tests the policy against: `open`, `get`, `put`, `delete`, `keys`, `clear`,
 * `close`, all asynchronous because IndexedDB is. A test or a probe can seed it with
 * records to model a previous session.
 *
 * Two flags, and the difference between them is load-bearing:
 *
 * - **`openable`** — this adapter stands for storage that *could* be opened. A null
 *   adapter exists precisely because it cannot be, and the cache must not call
 *   `open()` on it.
 * - **`available`** — it *has* been opened and can be used right now. IndexedDB is
 *   the reason these are two flags: before `open()` the database handle does not
 *   exist, so `available` is legitimately false, and treating that as "no storage"
 *   would make the cache skip the open that would have made it true. That is exactly
 *   the deadlock the browser gate found: every tile fetched, no error, no entries.
 */
export function createMemoryTileStorage(seed = []) {
  const records = new Map();
  const meta = new Map();
  let available = true;
  const put = (key, value) => { records.set(String(key), value); };
  for (const entry of Array.isArray(seed) ? seed : []) put(entry.key, entry.record);
  return {
    name: 'memory',
    openable: true,
    get available() { return available; },
    dispose() { records.clear(); meta.clear(); available = false; },
    async open() { return true; },
    async get(key) { return records.get(String(key)) ?? null; },
    async meta(key) { return meta.get(String(key)) ?? null; },
    async put(key, record) { put(key, record); return true; },
    async putMeta(key, record) { meta.set(String(key), record); return true; },
    async delete(key) { return records.delete(String(key)); },
    async keys() { return [...records.keys()]; },
    async clear() { records.clear(); meta.clear(); },
    async close() { return true; },
    /** Test-only: what the store currently holds, without going through the cache's own accounting. */
    snapshot() { return new Map(records); },
  };
}

/** An adapter for a browser that has no usable storage. Every call is a no-op and nothing throws. */
export function createNullTileStorage(reason = GEO_TILE_CACHE_OFFLINE_REASON) {
  return {
    name: 'unavailable',
    openable: false,
    available: false,
    reason,
    async open() { return false; },
    async get() { return null; },
    async meta() { return null; },
    async put() { return false; },
    async putMeta() { return false; },
    async delete() { return false; },
    async keys() { return []; },
    async clear() { return false; },
    async close() { return true; },
  };
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(true);
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

/**
 * The IndexedDB adapter. This is the one that makes the cache *persistent*, and it
 * is the one the browser gate reads back directly, so "it survived a reload" is
 * checked against the database rather than against the cache's own counters.
 *
 * The database version is the record schema: an upgrade deletes both stores
 * instead of migrating them, which is the cache-appropriate version policy.
 */
export function createIndexedDbTileStorage({
  scope = globalThis,
  name = GEO_TILE_CACHE_DATABASE,
  version = GEO_TILE_CACHE_SCHEMA,
} = {}) {
  const factory = scope?.indexedDB ?? null;
  if (!factory || typeof factory.open !== 'function') return createNullTileStorage('this browser exposes no IndexedDB');
  let database = null;
  let failure = null;
  return {
    name: 'indexeddb',
    openable: true,
    get available() { return Boolean(database); },
    get reason() { return failure; },
    /**
     * Open the database, and repair it if it exists without its stores.
     *
     * A same-version `open` fires no upgrade, so a database left behind by anything
     * that used this name without creating both stores would make the cache
     * *permanently* unavailable while looking healthy — no error, no entries, every
     * tile fetched forever. That is a defect that is invisible in a clean profile and
     * guaranteed in a dirty one, so the open verifies its own precondition and, when
     * it fails, deletes the database and creates it again.
     */
    async open() {
      const connect = () => new Promise((resolve, reject) => {
        const request = factory.open(name, version);
        request.onupgradeneeded = () => {
          const db = request.result;
          // A version bump is a format change: drop what the previous version wrote.
          if (db.objectStoreNames.contains(GEO_TILE_CACHE_OBJECT_STORE)) db.deleteObjectStore(GEO_TILE_CACHE_OBJECT_STORE);
          if (db.objectStoreNames.contains(GEO_TILE_CACHE_META_STORE)) db.deleteObjectStore(GEO_TILE_CACHE_META_STORE);
          db.createObjectStore(GEO_TILE_CACHE_OBJECT_STORE);
          db.createObjectStore(GEO_TILE_CACHE_META_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        request.onblocked = () => reject(new Error('IndexedDB open was blocked by another tab'));
      });
      const remove = () => new Promise((resolve, reject) => {
        const request = factory.deleteDatabase(name);
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB delete failed'));
        request.onblocked = () => reject(new Error('IndexedDB delete was blocked by another tab'));
      });
      try {
        let db = await connect();
        for (let repair = 0; repair < 2; repair++) {
          const missing = [GEO_TILE_CACHE_OBJECT_STORE, GEO_TILE_CACHE_META_STORE]
            .filter(store => !db.objectStoreNames.contains(store));
          if (!missing.length) { database = db; break; }
          db.close();
          await remove();
          db = await connect();
        }
        if (!database) throw new Error('the database exists without its object stores');
        database.onversionchange = () => { database?.close(); database = null; };
        failure = null;
        return true;
      } catch (error) {
        failure = error?.message ?? String(error);
        database = null;
        return false;
      }
    },
    async get(key) {
      if (!database) return null;
      const store = database.transaction(GEO_TILE_CACHE_OBJECT_STORE, 'readonly').objectStore(GEO_TILE_CACHE_OBJECT_STORE);
      return (await requestToPromise(store.get(String(key)))) ?? null;
    },
    async meta(key) {
      if (!database) return null;
      const store = database.transaction(GEO_TILE_CACHE_META_STORE, 'readonly').objectStore(GEO_TILE_CACHE_META_STORE);
      return (await requestToPromise(store.get(String(key)))) ?? null;
    },
    async put(key, record) {
      if (!database) return false;
      const transaction = database.transaction(GEO_TILE_CACHE_OBJECT_STORE, 'readwrite');
      transaction.objectStore(GEO_TILE_CACHE_OBJECT_STORE).put(record, String(key));
      await transactionDone(transaction);
      return true;
    },
    async putMeta(key, record) {
      if (!database) return false;
      const transaction = database.transaction(GEO_TILE_CACHE_META_STORE, 'readwrite');
      transaction.objectStore(GEO_TILE_CACHE_META_STORE).put(record, String(key));
      await transactionDone(transaction);
      return true;
    },
    async delete(key) {
      if (!database) return false;
      const transaction = database.transaction([GEO_TILE_CACHE_OBJECT_STORE, GEO_TILE_CACHE_META_STORE], 'readwrite');
      transaction.objectStore(GEO_TILE_CACHE_OBJECT_STORE).delete(String(key));
      transaction.objectStore(GEO_TILE_CACHE_META_STORE).delete(String(key));
      await transactionDone(transaction);
      return true;
    },
    async keys() {
      if (!database) return [];
      const store = database.transaction(GEO_TILE_CACHE_OBJECT_STORE, 'readonly').objectStore(GEO_TILE_CACHE_OBJECT_STORE);
      const keys = await requestToPromise(store.getAllKeys());
      return (keys ?? []).map(String);
    },
    async clear() {
      if (!database) return false;
      const transaction = database.transaction([GEO_TILE_CACHE_OBJECT_STORE, GEO_TILE_CACHE_META_STORE], 'readwrite');
      transaction.objectStore(GEO_TILE_CACHE_OBJECT_STORE).clear();
      transaction.objectStore(GEO_TILE_CACHE_META_STORE).clear();
      await transactionDone(transaction);
      return true;
    },
    async close() {
      database?.close();
      database = null;
      return true;
    },
  };
}

/** Pick the best adapter this environment can offer, without ever throwing. */
export function createDefaultTileStorage(options = {}) {
  try {
    const adapter = createIndexedDbTileStorage(options);
    if (adapter.name === 'unavailable') return adapter;
    return adapter;
  } catch (error) {
    return createNullTileStorage(`tile cache storage could not be created: ${error?.message ?? error}`);
  }
}

/**
 * The cache.
 *
 * One instance lives in the tile worker, because that is the only place this
 * application makes a provider request. Everything here is asynchronous, so the
 * same class runs in Node against the memory adapter, in the worker against
 * IndexedDB, and in the browser gate against both.
 */
export class GeoTileCache {
  /**
   * @param {object} [options]
   * @param {object} [options.storage] adapter; a missing or null one disables the cache
   * @param {object} [options.limits] byte/entry/entry-size/age ceilings
   * @param {number} [options.bytes] an explicit byte budget (the quality profile's, or a gate's)
   * @param {() => number} [options.clock] wall clock in milliseconds, injectable for tests
   * @param {string} [options.namespace] the key namespace; a different one cannot read these records
   */
  constructor({
    storage = createDefaultTileStorage(),
    limits = GEO_TILE_CACHE_LIMITS,
    bytes = null,
    clock = () => Date.now(),
    namespace = GEO_TILE_CACHE_NAMESPACE,
    onError = null,
  } = {}) {
    this.storage = storage ?? createNullTileStorage();
    this.limits = Object.freeze({ ...limits, bytes: Number.isFinite(bytes) ? bytes : limits.bytes });
    this.namespace = namespace;
    this.clock = clock;
    this.onError = onError;
    this.manifest = { schema: GEO_TILE_CACHE_SCHEMA, namespace, bytes: 0, entries: {} };
    this.opened = false;
    this.reset = false;
    this.lastError = null;
    this.counters = {
      hits: 0, misses: 0, stores: 0, evictions: 0, evictedBytes: 0,
      expiries: 0, swept: 0, skipped: 0, rejected: 0, errors: 0, manifestWrites: 0, resets: 0,
    };
  }

  /** Whether this cache's adapter stands for storage that can be opened at all. */
  get storageUsable() { return Boolean(this.storage && this.storage.openable !== false); }

  /** Whether the storage is open and usable *now*. Before `open()`, this is false by definition. */
  get available() { return this.storage?.available === true; }

  /** The adapter's own name, so a diagnostics line can say where the entries live. */
  get adapter() { return this.storage?.name ?? 'none'; }

  _fail(stage, error) {
    this.counters.errors++;
    this.lastError = `${stage}: ${error?.message ?? error}`;
    this.onError?.(this.lastError, error);
    return this.lastError;
  }

  /** Drop everything this cache owns. Used by a corrupt manifest and by an explicit clear. */
  async _reset(reason) {
    this.reset = true;
    this.counters.resets++;
    this.manifest = { schema: GEO_TILE_CACHE_SCHEMA, namespace: this.namespace, bytes: 0, entries: {}, resetReason: reason };
    try {
      await this.storage.clear();
      await this.storage.putMeta(GEO_TILE_CACHE_MANIFEST_KEY, this.manifest);
    } catch (error) {
      this._fail('reset', error);
    }
    return this.manifest;
  }

  /**
   * Read the manifest and reconcile it with the store.
   *
   * The manifest is the accounting: bytes, entries and the LRU readings. It is also
   * the one record that can make the cache unusable, so every failure here ends in
   * `_reset` — a cache that cannot describe itself is emptied rather than guessed at.
   */
  async open() {
    if (this.opened) return { opened: true, entries: Object.keys(this.manifest.entries).length, bytes: this.manifest.bytes, reset: this.reset };
    if (!this.storageUsable) {
      this.opened = false;
      return { opened: false, entries: 0, bytes: 0, reset: false, reason: this.storage?.reason ?? GEO_TILE_CACHE_OFFLINE_REASON };
    }
    let opened = false;
    try {
      opened = await this.storage.open();
    } catch (error) {
      this._fail('open', error);
      opened = false;
    }
    if (!opened) return { opened: false, entries: 0, bytes: 0, reset: false, reason: this.storage?.reason ?? 'storage did not open' };

    let manifest = null;
    try {
      manifest = await this.storage.meta(GEO_TILE_CACHE_MANIFEST_KEY);
    } catch (error) {
      this._fail('read manifest', error);
    }
    let reason = '';
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) reason = 'no manifest';
    else if (manifest.schema !== GEO_TILE_CACHE_SCHEMA) reason = `the manifest is format v${manifest.schema}`;
    else if (manifest.namespace !== this.namespace) reason = `the manifest belongs to namespace ${JSON.stringify(manifest.namespace)}`;
    else if (!manifest.entries || typeof manifest.entries !== 'object' || Array.isArray(manifest.entries)) reason = 'the manifest has no entry table';

    if (reason) {
      // A cache is allowed to forget. This is the whole difference between this module and a save.
      await this._reset(reason);
      this.opened = true;
      return { opened: true, entries: 0, bytes: 0, reset: true, reason };
    }

    this.manifest = {
      schema: GEO_TILE_CACHE_SCHEMA,
      namespace: this.namespace,
      bytes: 0,
      entries: {},
    };
    for (const [key, record] of Object.entries(manifest.entries)) {
      if (!record || typeof record !== 'object' || !Number.isFinite(record.bytes) || record.bytes < 0) continue;
      if (typeof key !== 'string' || !key.startsWith(`${this.namespace}|`)) continue;
      this.manifest.entries[key] = {
        bytes: record.bytes,
        storedAt: Number.isFinite(record.storedAt) ? record.storedAt : 0,
        lastUsed: Number.isFinite(record.lastUsed) ? record.lastUsed : (Number.isFinite(record.storedAt) ? record.storedAt : 0),
        fingerprint: typeof record.fingerprint === 'string' ? record.fingerprint : '',
        providerId: typeof record.providerId === 'string' ? record.providerId : '',
        label: typeof record.label === 'string' ? record.label : '',
        maxAgeSeconds: Number.isFinite(record.maxAgeSeconds) ? record.maxAgeSeconds : this.limits.maxAgeSeconds,
        zoom: Number.isFinite(record.zoom) ? record.zoom : null,
        x: Number.isFinite(record.x) ? record.x : null,
        y: Number.isFinite(record.y) ? record.y : null,
      };
      this.manifest.bytes += this._cost(this.manifest.entries[key].bytes);
    }
    this.opened = true;
    // A cache can be handed a budget smaller than the one it last ran with — the profile it
    // was mounted under changed, or the gate asked for a smaller one on purpose. The budget
    // is a promise about the player's disk, so a loaded manifest that is already over it is
    // brought back inside *now*, before anything is served or stored: the alternative is a
    // cache that reports a 3.6 KB budget while holding 7 KB and refuses to evict, which is
    // exactly the state the browser gate found. The entries that go are the least recently
    // used ones, the same order every other eviction uses.
    const shrunk = await this.enforce('open');
    return {
      opened: true, entries: Object.keys(this.manifest.entries).length, bytes: this.manifest.bytes,
      reset: false, evicted: shrunk,
    };
  }

  /** What one payload costs against the ceiling. */
  _cost(payloadBytes) { return Math.max(0, payloadBytes) + GEO_TILE_CACHE_RECORD_OVERHEAD; }

  async _writeManifest() {
    try {
      await this.storage.putMeta(GEO_TILE_CACHE_MANIFEST_KEY, this.manifest);
      this.counters.manifestWrites++;
      return true;
    } catch (error) {
      this._fail('write manifest', error);
      return false;
    }
  }

  /**
   * Look one tile up for one provider.
   *
   * Returns a decision rather than a payload so the caller's control flow is
   * readable: `skip` when the provider must not be cached, `miss` when there is
   * nothing usable (and why), `hit` when the bytes can be used as they are. An
   * expired entry is deleted and counted as an expiry, so the ceiling is not spent
   * on data nobody will use.
   */
  async get(provider, { zoom, x, y } = {}) {
    const policy = providerCachePolicy(provider, { limits: this.limits });
    const fingerprint = policy.cacheable ? providerFingerprint(provider) : null;
    const key = fingerprint === null ? null : tileCacheKey(fingerprint, zoom, x, y);
    if (!policy.cacheable) return { state: 'skip', reason: policy.reason, key: null, fingerprint: null };
    if (!this.available || !this.opened) return { state: 'miss', reason: 'the cache is not open', key, fingerprint };
    let record = null;
    try {
      record = await this.storage.get(key);
    } catch (error) {
      this._fail('read entry', error);
      return { state: 'miss', reason: 'the entry could not be read', key, fingerprint };
    }
    const held = this.manifest.entries[key] ?? null;
    if (!record || !held) {
      this.counters.misses++;
      return { state: 'miss', reason: record ? 'the entry is not in the manifest' : 'nothing stored for this tile', key, fingerprint };
    }
    const data = record.bytes;
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      this.counters.rejected++;
      await this._delete(key);
      return { state: 'miss', reason: 'the stored entry is not bytes', key, fingerprint };
    }
    const now = this.clock();
    const age = (now - held.storedAt) / 1000;
    if (held.maxAgeSeconds > 0 && age > held.maxAgeSeconds) {
      this.counters.expiries++;
      this.counters.misses++;
      await this._delete(key);
      return { state: 'miss', reason: `the entry is ${Math.round(age)}s old and the provider's lifetime is ${held.maxAgeSeconds}s`, key, fingerprint };
    }
    // Touching the entry is what makes the eviction order *least recently used*
    // rather than least recently stored, and it is persisted so the order survives
    // a reload. One small manifest write per served tile against a saved network
    // request is the trade this cache is for.
    held.lastUsed = now;
    held.hits = (held.hits ?? 0) + 1;
    this.counters.hits++;
    await this._writeManifest();
    return {
      state: 'hit', key, fingerprint,
      data: data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      providerId: held.providerId, label: held.label, storedAt: held.storedAt, ageSeconds: age,
    };
  }

  /**
   * Store one tile's payload.
   *
   * Refuses what it cannot bound: an empty payload, one larger than `entryBytes`,
   * and one belonging to a provider that may not be cached. A quota error evicts
   * harder and retries once; if the payload still cannot be stored the entry is
   * simply not cached, because the tile has already been fetched and rendered.
   */
  async store(provider, { zoom, x, y } = {}, data, { contentType = '', etag = '' } = {}) {
    const policy = providerCachePolicy(provider, { limits: this.limits });
    if (!policy.cacheable) return { stored: false, reason: policy.reason, skipped: true };
    if (!this.available || !this.opened) return { stored: false, reason: 'the cache is not open', skipped: true };
    const bytes = data instanceof ArrayBuffer ? data.byteLength : ArrayBuffer.isView(data) ? data.byteLength : 0;
    if (!bytes) { this.counters.skipped++; return { stored: false, reason: 'the payload is empty', skipped: true }; }
    if (bytes > this.limits.entryBytes) {
      this.counters.skipped++;
      return { stored: false, reason: `the payload is ${bytes} B, larger than the ${this.limits.entryBytes} B single-entry ceiling`, skipped: true };
    }
    // A record that cannot fit the whole budget is refused *before* it is written, and
    // nothing already stored is touched to make room for it. The alternative — write it,
    // notice the budget, evict — throws away the entries that fit in order to keep one
    // that does not, and the entry it churns is the one the player just used. A budget
    // too small for a tile means "this device cannot cache tiles", which is a state the
    // cache can hold honestly; a cache that spends a write and an eviction per tile is
    // not.
    const cost = this._cost(bytes);
    if (cost > this.limits.bytes) {
      this.counters.skipped++;
      return {
        stored: false, key: tileCacheKey(providerFingerprint(provider), zoom, x, y), fingerprint: providerFingerprint(provider),
        reason: `a ${cost} B record cannot fit the ${this.limits.bytes} B budget`, skipped: true,
      };
    }
    const fingerprint = providerFingerprint(provider);
    const key = tileCacheKey(fingerprint, zoom, x, y);
    const now = this.clock();
    const record = {
      schema: GEO_TILE_CACHE_SCHEMA,
      key,
      bytes: data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      contentType, etag,
      storedAt: now, lastUsed: now,
      providerId: provider.id, label: provider.label ?? provider.id, fingerprint,
      zoom, x, y, maxAgeSeconds: policy.maxAgeSeconds,
    };
    const attempt = async () => {
      await this.storage.put(key, record);
      // The old cost leaves the accounting before the new one enters, so re-storing
      // a tile under the same key cannot double-count it.
      const previous = this.manifest.entries[key];
      if (previous) this.manifest.bytes -= this._cost(previous.bytes);
      this.manifest.entries[key] = {
        bytes, storedAt: now, lastUsed: now, fingerprint,
        providerId: provider.id, label: provider.label ?? provider.id,
        maxAgeSeconds: policy.maxAgeSeconds, zoom, x, y, hits: 0,
      };
      this.manifest.bytes += this._cost(bytes);
      this.counters.stores++;
    };
    try {
      await attempt();
    } catch (error) {
      // A full disk is the expected error, not an exceptional one. The cache's own
      // entries are the only space it can free, so it frees them in two steps —
      // down to half the budget, then all of them — retrying after each. A quota
      // error that is handled this way is not an *error*: the counters separate
      // a store that needed room from a store that could not happen at all.
      const message = `${error?.name ?? ''} ${error?.message ?? error}`;
      if (!/quota|storage/i.test(message)) {
        this._fail('store', error);
        return { stored: false, reason: this.lastError, key, fingerprint };
      }
      let failure = error;
      let stored = false;
      for (const step of [{ target: Math.floor(this.limits.bytes / 2), minimum: 1 }, { target: 0, minimum: 0 }]) {
        await this.evictTo(step.target, 'quota', { minimumEvictions: step.minimum });
        try {
          await attempt();
          stored = true;
          break;
        } catch (retryError) {
          failure = retryError;
        }
      }
      if (!stored) {
        this._fail('store after eviction', failure);
        return { stored: false, reason: this.lastError, key, fingerprint };
      }
    }
    await this.enforce();
    await this._writeManifest();
    return { stored: true, key, fingerprint, bytes };
  }

  /**
   * Throw one entry away because it could not be used.
   *
   * The worker calls this when a stored payload fails to decode: the record is
   * deleted (so the next visit refetches rather than failing again) and the refusal
   * is counted, because a cache that keeps returning something unusable is a defect
   * worth seeing in the diagnostics.
   */
  async reject(key, reason) {
    this.counters.rejected++;
    this.lastError = reason;
    await this._delete(key);
    await this._writeManifest();
    return true;
  }

  async _delete(key) {
    try {
      await this.storage.delete(key);
    } catch (error) {
      this._fail('delete', error);
    }
    const held = this.manifest.entries[key];
    if (held) {
      this.manifest.bytes -= this._cost(held.bytes);
      delete this.manifest.entries[key];
    }
    return held ? true : false;
  }

  /** Evict the least recently used entries until the budget is met. */
  async enforce(reason = 'budget') {
    return this.evictTo(this.limits.bytes, reason);
  }

  /**
   * Evict least-recently-used entries until the accounting is within `targetBytes`
   * (and the entry count within its own ceiling). Ties break by key, so the choice
   * does not depend on object insertion order — the same determinism rule the
   * journal and the save use.
   *
   * `minimumEvictions` exists for the quota path: when the origin is full, evicting
   * to a budget the cache was already inside frees nothing, so the caller asks for
   * at least one entry and the loop honours it.
   */
  async evictTo(targetBytes, reason = 'budget', { minimumEvictions = 0 } = {}) {
    const order = () => Object.keys(this.manifest.entries)
      .sort((left, right) => this.manifest.entries[left].lastUsed - this.manifest.entries[right].lastUsed || (left < right ? -1 : 1));
    let evicted = 0;
    for (;;) {
      const overBytes = this.manifest.bytes > targetBytes;
      const overEntries = Object.keys(this.manifest.entries).length > this.limits.entries;
      if (!overBytes && !overEntries && evicted >= minimumEvictions) break;
      const [victim] = order();
      if (!victim) break;
      const held = this.manifest.entries[victim];
      const bytes = held ? this._cost(held.bytes) : 0;
      await this._delete(victim);
      evicted++;
      this.counters.evictions++;
      this.counters.evictedBytes += bytes;
      this.lastEviction = { key: victim, reason, bytes, lastUsed: held?.lastUsed ?? null };
    }
    if (evicted) await this._writeManifest();
    return evicted;
  }

  /**
   * Forget entries whose source the application no longer declares.
   *
   * This is the attribution half of the policy stated as an operation: when the
   * fixture or the provider list changes, the entries recorded under the old
   * fingerprint are not merely unreachable (the key already guarantees that), they
   * are removed, so a storage quota is not spent on a source that is gone and a
   * later switch back cannot resurrect a stale payload under a reused identity.
   */
  async sweep({ fingerprints = null } = {}) {
    if (!this.available || !this.opened) return { swept: 0 };
    const live = fingerprints ? new Set(fingerprints) : null;
    let swept = 0;
    for (const key of Object.keys(this.manifest.entries)) {
      const held = this.manifest.entries[key];
      if (live && !live.has(held.fingerprint)) { await this._delete(key); swept++; }
    }
    this.counters.swept += swept;
    if (swept) await this._writeManifest();
    return { swept };
  }

  async clear() {
    this.reset = true;
    this.counters.resets++;
    this.manifest = { schema: GEO_TILE_CACHE_SCHEMA, namespace: this.namespace, bytes: 0, entries: {} };
    try {
      await this.storage.clear();
      await this.storage.putMeta(GEO_TILE_CACHE_MANIFEST_KEY, this.manifest);
    } catch (error) {
      this._fail('clear', error);
    }
    return true;
  }

  async close() {
    try {
      await this.storage.close();
    } catch (error) {
      this._fail('close', error);
    }
    return true;
  }

  /**
   * The report the review panel, the audit handle and the gate read.
   *
   * `entries` and `bytes` are read back from the manifest rather than from the
   * counters, so a diagnostics line states what the cache currently holds; every
   * other field is cumulative for the life of this instance.
   */
  diagnostics() {
    const entries = Object.keys(this.manifest.entries).length;
    const live = Object.values(this.manifest.entries);
    return {
      schema: GEO_TILE_CACHE_SCHEMA,
      namespace: this.namespace,
      adapter: this.adapter,
      available: this.available,
      // The adapter's own reason for being unavailable, when it has one. Without it a
      // cache that never opened is indistinguishable from one that was never asked.
      unavailableReason: this.storage?.reason ?? null,
      opened: this.opened,
      entries,
      cachedBytes: live.reduce((sum, held) => sum + held.bytes, 0),
      bytes: this.manifest.bytes,
      limitBytes: this.limits.bytes,
      limitEntries: this.limits.entries,
      entryLimitBytes: this.limits.entryBytes,
      maxAgeSeconds: this.limits.maxAgeSeconds,
      oldestLastUsed: live.length ? Math.min(...live.map(held => held.lastUsed)) : null,
      newestLastUsed: live.length ? Math.max(...live.map(held => held.lastUsed)) : null,
      providers: [...new Set(live.map(held => held.providerId).filter(Boolean))],
      fingerprints: [...new Set(live.map(held => held.fingerprint).filter(Boolean))],
      reset: this.reset,
      lastError: this.lastError,
      lastEviction: this.lastEviction ?? null,
      ...this.counters,
    };
  }
}
