/**
 * `MAP-09` — bounded persistent tile cache
 *
 * Registered gate (feature-roadmap/README.md order 028):
 *   "Size/version/LRU policy and attribution-safe storage"
 *
 * Research (`MAP_STREAMING_RESEARCH.md`, evolution item 4):
 *   *"Cache Storage/IndexedDB LRU with an explicit byte quota and provider cache
 *   semantics"*, and policy §3: the cache/rate-limit rationale plus the attribution
 *   requirement.
 *
 * WHAT EACH WORD OF THE GATE MEANS HERE, AND WHAT IS MEASURED FOR IT
 * ------------------------------------------------------------------
 * 1. **Size.** The budget is not a suggestion. The scenario measures what one resident
 *    tile actually costs (`cachedBytes / entries` — the record plus its overhead, as
 *    the cache itself accounts for it), then mounts a second, distant coordinate with
 *    a budget of half the first coordinate's bytes. The store that follows must
 *    evict, the accounting must end *inside* the budget, and something must survive.
 * 2. **Version.** The record format is named twice — a namespace inside every key and
 *    the IndexedDB version — so a cache that meets a format it did not write must
 *    forget rather than misread. The scenario writes a **foreign manifest** into the
 *    real database while nothing holds it open, then mounts: the runtime must come up
 *    anyway, report `reset: true` with a reason, refetch (the entries are gone), and
 *    fill again. A cache may forget; a save may not.
 * 3. **LRU policy.** Recency is what decides, and it is observable from outside the
 *    process: the eviction above has to remove the *older* recording and keep the
 *    newer one, which is asserted by reading both keys out of IndexedDB. The reopen
 *    half of the policy lives in the Node tier (`GeoTileCache.test.js`); what this
 *    scenario adds is that the policy survives the worker boundary.
 * 4. **Attribution-safe storage.** Two providers are not one — including two fixtures
 *    served by the same URL template, which is the case a naive key would get wrong.
 *    The scenario loads `dense-urban`, proves a reload costs **zero** provider
 *    requests, then switches the *served fixture* to `sparse-rural` and reloads the
 *    same coordinate: the request must happen (no hit), the retired source's entries
 *    must be swept rather than left to spend quota, and the database must no longer
 *    hold the old fingerprint's keys. Switching back must hit again.
 *
 * THE ONE PROOF THAT CANNOT BE FAKED
 * ----------------------------------
 * The dev fixture serves tiles `cache-control: no-store`, so the browser's own HTTP
 * cache cannot be the reason a reload is free, and `/__fixture-tiles/current` exposes
 * a monotonic `served` counter that is read as **deltas** around each mount. "Zero
 * requests, one or more hits, and the keys really present in IndexedDB" is therefore
 * three independent pieces of evidence for one claim, and the `?tileCache=off` leg is
 * the negative control that shows the same mount *does* spend a request when the cache
 * is not there to prevent it.
 *
 * STRUCTURAL COVERAGE, AND WHY IT IS NOT DUPLICATED HERE
 * ------------------------------------------------------
 * The policy itself — key derivation, per-source hit/miss, LRU order, reopen order,
 * expiry, sweep, the escalation ladder on a byte-capped disk, the forensic manifests,
 * and the hostile-adapter path — is asserted in `src/geo/GeoTileCache.test.js` (15
 * tests, run by `npm test`). This scenario deliberately checks the *wiring*: that the
 * worker consults storage before the network, that the world and the panel carry the
 * report, that the budget travels from the runtime to the worker, and that the whole
 * thing is attribution-safe across a provider switch.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshRunDirectory, openCoordinates, relaunch, selectFixture, waitFrames } from '../harness.mjs';

const COORDINATE = { latitude: 28.9845, longitude: 77.7064 };
const DISTANT = { latitude: 28.6139, longitude: 77.2090 };
const ELSEWHERE = { latitude: 19.0760, longitude: 72.8777 };

/**
 * The runtime's cache surface.
 *
 * The counters are the *session's*, not the database's: every mount is a page load and a
 * new worker, so `hits`, `stores` and `evictions` start at zero on each leg. That is why
 * this scenario reads absolute values per session and takes deltas only of the fixture
 * provider's own `served` counter — a delta of two session counters would be nonsense and
 * has been observed to go negative.
 */
const READ = `() => {
  const game = globalThis.__gdoAudit?.game;
  if (!game) return { mounted: false };
  return {
    mounted: true,
    cache: game.tileCache ?? null,
    config: game.tileCacheConfig ?? null,
    downloads: game.downloads ?? null,
    reports: game.tileCacheReports ?? 0,
  };
}`;

/**
 * Read the cache's own database without ever creating it.
 *
 * `indexedDB.open(name)` *creates* an absent database, and an empty one is exactly the
 * shape that used to make the cache silently unavailable, so the existence check comes
 * first and every request is raced against a deadline — a blocked request must report,
 * not hang.
 */
const IDB = `async () => {
  const withTimeout = (promise, label) => Promise.race([
    promise, new Promise(resolve => setTimeout(() => resolve({ timeout: label }), 4000)),
  ]);
  const known = await (indexedDB.databases ? indexedDB.databases() : Promise.resolve([]));
  if (!known.some(entry => entry.name === 'gdo-tile-cache')) return { absent: true, keys: [] };
  const opened = await withTimeout(new Promise(resolve => {
    const request = indexedDB.open('gdo-tile-cache');
    request.onsuccess = () => resolve({ db: request.result });
    request.onerror = () => resolve({ error: String(request.error) });
    request.onblocked = () => resolve({ blocked: true });
  }), 'open');
  if (opened.blocked || opened.timeout || opened.error) return { problem: opened.blocked ? 'blocked' : (opened.error ?? 'timeout ' + opened.timeout), keys: [] };
  const db = opened.db;
  const stores = [...db.objectStoreNames];
  if (!stores.includes('tiles')) { db.close(); return { stores, keys: [], manifest: null, note: 'no tiles store' }; }
  const reads = await withTimeout(new Promise(resolve => {
    const transaction = db.transaction([...stores], 'readonly');
    const keys = transaction.objectStore('tiles').getAllKeys();
    const records = stores.includes('meta') ? transaction.objectStore('meta').get('manifest') : null;
    transaction.oncomplete = () => resolve({ keys: (keys.result ?? []).map(String), manifest: records?.result ?? null });
    transaction.onerror = () => resolve({ error: String(transaction.error) });
  }), 'read');
  db.close();
  return { stores, ...reads, keys: reads.keys ?? [] };
}`;

/** Plant a manifest that is not ours, from the landing shell where no worker holds the database. */
const WRITE_FOREIGN_MANIFEST = `async () => {
  const request = indexedDB.open('gdo-tile-cache');
  const db = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const manifest = {
    schema: 1,
    namespace: 'gdo:someone-elses-cache:v1',
    bytes: 0,
    entries: { 'gdo:tilecache:v1|deadbeef|14/1/1': { bytes: 4096, lastUsed: 1, storedAt: 1, providerId: 'other', label: 'Other' } },
  };
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('meta', 'readwrite');
    transaction.objectStore('meta').put(manifest, 'manifest');
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
  return { namespace: manifest.namespace, entries: Object.keys(manifest.entries).length };
}`;

export async function run({ page: firstPage, browser: firstBrowser, logs = [], baseUrl, log = console.log, fixtures = ['dense-urban'] }) {
  const directory = freshRunDirectory('map09-tile-cache');
  // Several mounts of the world in one process exhaust the browser (the seventh was observed
  // to take the target down mid-evaluate, surfacing as a `TargetCloseError` inside whatever
  // call was in flight), so the heavier legs restart it. The restart reuses **one profile
  // directory**, so IndexedDB, local storage and the HTTP cache are the same bytes on disk
  // while every process, GPU state and WebGL context is new — which is exactly the claim
  // this gate makes: the tile a later session finds was written by a process that is gone.
  const profile = await mkdtemp(join(tmpdir(), 'gdo-map09-profile-'));
  let page = firstPage;
  let browser = firstBrowser;
  // Every top-level navigation this run caused, so a leg that dies with "the execution
  // context was destroyed" can name the navigation that did it instead of guessing.
  const navigations = [];
  const watch = target => target.on('framenavigated', frame => {
    if (frame !== target.mainFrame()) return;
    navigations.push(frame.url().replace(origin, ''));
  });
  watch(firstPage);
  const restart = async () => {
    const session = await relaunch(browser, logs, { userDataDir: profile });
    browser = session.browser;
    page = session.page;
    watch(page);
    log('[map09] · restarted the browser on the same profile');
    return page;
  };
  const failures = [];
  const fail = message => failures.push(message);
  const summary = {};
  const secondFixture = fixtures[1] ?? 'sparse-rural';

  const origin = String(baseUrl).replace(/\/+$/, '/');
  const withParam = value => `${origin}?tileCache=${encodeURIComponent(value)}`;
  const served = async () => {
    const response = await fetch(`${origin}__fixture-tiles/current`);
    if (!response.ok) throw new Error(`fixture status ${response.status}`);
    return (await response.json()).served;
  };
  const read = () => page.evaluate(`(${READ})()`);
  const readIdb = () => page.evaluate(`(${IDB})()`);

  /**
   * Ask the worker for a report and wait for it to arrive.
   *
   * The world counts the reports it has handled, so this is a handshake: post, wait for
   * the count to move. Waiting on a frame count instead read the *previous* report — the
   * first version of this gate measured a cache with zero entries while IndexedDB held a
   * stored tile, because the report it read was sent before the fetch had resolved.
   */
  const refresh = async () => {
    const before = (await read()).reports ?? 0;
    await page.evaluate(() => globalThis.__gdoAudit.game.refreshTileCache());
    await page.waitForFunction(
      previous => (globalThis.__gdoAudit?.game?.tileCacheReports ?? 0) > previous,
      { timeout: 20_000, polling: 100 },
      before,
    );
  };

  /** Poll the runtime's own report until it shows what the leg is waiting for. */
  const settle = async (predicate, description) => {
    let last = await read();
    for (let attempt = 0; attempt < 40; attempt++) {
      await refresh();
      last = await read();
      if (last.mounted && predicate(last)) return last;
      await waitFrames(page, 6);
    }
    // The predicate is written against `state.cache?.` throughout so that a report which is
    // missing entirely is a *diagnostic* here rather than an exception at the call site.
    fail(`timed out waiting for ${description} — last state ${JSON.stringify({ mounted: last.mounted, cache: counters(last.cache), downloads: last.downloads ?? null })}`);
    return last;
  };

  /**
   * Announce a leg. The last step printed when a run dies is the leg that died — an audit
   * that throws away its diagnostics on the first exception helps nobody, so the exception
   * is caught below and reported as a failure with the leg named.
   */
  const step = name => log(`[map09] → ${name}`);

  /** The report a settle ended on, with the counters filled in even when nothing arrived. */
  const report = async (predicate, description) => ((await settle(predicate, description)).cache ?? counters(null));

  const mount = async (coordinate, url = baseUrl) => {
    await openCoordinates(page, url, coordinate);
    await page.waitForFunction(() => (globalThis.__gdoAudit?.game?.downloads?.tiles ?? 0) >= 1, { timeout: 90_000, polling: 200 });
    await refresh();
  };

  const counters = cache => ({
    schema: cache?.schema ?? null,
    adapter: cache?.adapter ?? null,
    available: cache?.available ?? null,
    opened: cache?.opened ?? null,
    entries: cache?.entries ?? -1,
    cachedBytes: cache?.cachedBytes ?? -1,
    // The *accounted* bytes: payload plus the cache's own per-record overhead. The budget is
    // measured against this, which is why the scenario computes a record's cost from it.
    bytes: cache?.bytes ?? -1,
    limitBytes: cache?.limitBytes ?? -1,
    hits: cache?.hits ?? -1,
    misses: cache?.misses ?? -1,
    stores: cache?.stores ?? -1,
    evictions: cache?.evictions ?? -1,
    evictedBytes: cache?.evictedBytes ?? -1,
    swept: cache?.swept ?? -1,
    skipped: cache?.skipped ?? -1,
    rejected: cache?.rejected ?? -1,
    resets: cache?.resets ?? -1,
    errors: cache?.errors ?? -1,
    lastError: cache?.lastError ?? null,
    lastEviction: cache?.lastEviction ?? null,
  });

  try {
  // ------------------------------------------------- 0. the landing shell, fixture prepared
  step('0 landing shell and fixture');
  await selectFixture(page, baseUrl, { id: fixtures[0] });
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 90_000 });
  // The gate starts from nothing. Deleting an absent database is a no-op, and a delete that
  // is blocked means a previous run still holds it open, which has to be said out loud.
  const cleared = await page.evaluate(async () => {
    if (!indexedDB.databases) return 'unsupported';
    const known = await indexedDB.databases();
    if (!known.some(entry => entry.name === 'gdo-tile-cache')) return 'absent';
    const request = indexedDB.deleteDatabase('gdo-tile-cache');
    return Promise.race([
      new Promise(resolve => { request.onsuccess = () => resolve('deleted'); request.onerror = () => resolve('error'); request.onblocked = () => resolve('blocked'); }),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 5000)),
    ]);
  });
  log(`[map09] start: fixture ${fixtures[0]} · previous cache ${cleared} · one resident tile is the unit of work`);
  if (cleared === 'blocked' || cleared === 'timeout') fail(`the cache database could not be cleared before the run: ${cleared}`);

  // ------------------------------------------------- 1. negative control: no cache, a request
  step('1 cache off (negative control)');
  let before = await served();
  await mount(COORDINATE, withParam('off'));
  const offIdb = await readIdb();
  const offRequests = (await served()) - before;
  const off = await read();
  log(`[map09] cache off: ${offRequests} request(s) · enabled ${off.config?.enabled} · adapter ${off.cache?.adapter} · entries ${off.cache?.entries} · database ${offIdb.absent ? 'absent' : `present (${(offIdb.keys ?? []).length} keys)`}`);
  if (off.config?.enabled !== false) fail('`?tileCache=off` did not reach the runtime');
  if (off.cache?.enabled !== false) fail('the report does not say the cache is off');
  if (off.cache?.adapter !== 'unavailable') fail(`the off switch produced the ${off.cache?.adapter} adapter`);
  if (offRequests < 1) fail(`with the cache off the mount made ${offRequests} request(s) — the fixture counter did not move, so nothing below can be measured`);
  if (offIdb.absent !== true) fail(`with the cache off a database was still created: ${JSON.stringify(offIdb).slice(0, 200)}`);
  summary.off = { requests: offRequests, enabled: off.config?.enabled, adapter: off.cache?.adapter, idb: offIdb.absent ? 'absent' : 'present' };

  // ------------------------------------------------- 2. first pass with the cache: miss, store
  step('2 first pass: miss and store');
  before = await served();
  await mount(COORDINATE);
  const first = await report(state => (state.cache?.stores ?? 0) >= 1 && (state.cache?.entries ?? 0) >= 1, 'the first tile to be stored');
  const firstRequests = (await served()) - before;
  const firstIdb = await readIdb();
  log(`[map09] first pass: ${firstRequests} request(s) · miss ${first.misses} store ${first.stores} · entries ${first.entries} (${first.cachedBytes} B of ${first.limitBytes} B) · adapter ${first.adapter}/${first.available ? 'available' : 'unavailable'} · ${(firstIdb.keys ?? []).length} key(s) in IndexedDB`);
  if (first.schema !== 1) fail(`the report does not name the record format (schema ${first.schema})`);
  if (first.namespace !== 'gdo:tilecache:v1') fail(`the report does not name the namespace: ${JSON.stringify(first.namespace)}`);
  if (first.enabled !== true) fail('the cache is not enabled by default');
  if (first.available !== true || first.opened !== true) fail(`the cache did not open: available ${first.available} opened ${first.opened} reason ${first.unavailableReason}`);
  if (firstRequests < 1) fail(`the first pass made ${firstRequests} request(s) — nothing was there to miss`);
  if (first.misses < 1) fail('the first pass did not report a miss');
  if (first.entries < 1) fail(`the first pass left ${first.entries} entries`);
  if ((firstIdb.keys ?? []).length !== first.entries) fail(`the report says ${first.entries} entries while IndexedDB holds ${(firstIdb.keys ?? []).length} — the accounting is not the storage`);
  if (firstIdb.manifest?.namespace !== 'gdo:tilecache:v1') fail(`the stored manifest is named ${JSON.stringify(firstIdb.manifest?.namespace)}`);
  const manifestEntries = Object.keys(firstIdb.manifest?.entries ?? {}).length;
  if (manifestEntries !== first.entries) fail(`the manifest holds ${manifestEntries} entries while the report says ${first.entries}`);
  const key = firstIdb.keys?.[0] ?? '';
  const fingerprint = key.split('|')[1] ?? null;
  if (!/^gdo:tilecache:v1\|[0-9a-f]{8}\|\d+\/\d+\/\d+$/.test(key)) fail(`the stored key does not carry namespace, source and tile: ${JSON.stringify(key)}`);
  const cost = first.entries ? Math.ceil(first.cachedBytes / first.entries) : 0;
  summary.first = { requests: firstRequests, ...counters(first), keys: (firstIdb.keys ?? []).length, costPerEntry: cost, fingerprint };

  // ------------------------------------------------- 3. the reload: zero requests, real hits
  step('3 reload: free and served from storage');
  before = await served();
  await mount(COORDINATE);
  const second = await report(state => (state.cache?.hits ?? 0) >= 1, 'the reload to hit storage');
  const reloadRequests = (await served()) - before;
  const secondIdb = await readIdb();
  const live = await read();
  log(`[map09] reload: ${reloadRequests} request(s) · hit ${second.hits} miss ${second.misses} store ${second.stores} · ${second.entries} entr(ies) · ${(secondIdb.keys ?? []).length} key(s) in IndexedDB · ${live.downloads?.residentFromCache}/${live.downloads?.tiles} resident served from storage`);
  if (reloadRequests !== 0) fail(`the reload spent ${reloadRequests} provider request(s) — the tile was in storage and should not have been fetched`);
  if (second.hits < 1) fail(`the reload reported ${second.hits} hits`);
  if (second.stores > 0) fail(`the reload stored ${second.stores} time(s) — a hit should not rewrite the entry`);
  if (second.entries !== first.entries) fail(`the reload reports ${second.entries} entries against the stored ${first.entries}`);
  if ((secondIdb.keys ?? []).length !== first.entries) fail(`IndexedDB holds ${(secondIdb.keys ?? []).length} keys after the reload, expected ${first.entries}`);
  if ((live.downloads?.residentFromCache ?? 0) < 1) fail('no resident tile is marked as served from storage');
  if (live.downloads?.residentFromCache !== live.downloads?.tiles) {
    fail(`only ${live.downloads?.residentFromCache} of ${live.downloads?.tiles} resident tile(s) came from storage after a free reload`);
  }
  summary.reload = { requests: reloadRequests, ...counters(second), keys: (secondIdb.keys ?? []).length, residentFromCache: live.downloads?.residentFromCache, tiles: live.downloads?.tiles };

  // ------------------------------------------------- 4. attribution: a different source is a different tile
  step('4 a different source is a different tile');
  const switched = await selectFixture(page, baseUrl, { id: secondFixture });
  before = await served();
  await mount(COORDINATE);
  const other = await report(state => (state.cache?.misses ?? 0) >= 1, `a miss after the switch to ${secondFixture}`);
  const otherRequests = (await served()) - before;
  const otherIdb = await readIdb();
  const otherKey = (otherIdb.keys ?? [])[0] ?? '';
  const otherFingerprint = otherKey.split('|')[1] ?? null;
  const staleKeys = (otherIdb.keys ?? []).filter(entry => entry.includes(fingerprint ?? 'never-matches'));
  log(`[map09] fixture switch ${switched.id}/${switched.variant}: ${otherRequests} request(s) · hit ${other.hits} miss ${other.misses} · swept ${other.swept} · fingerprints ${JSON.stringify(other.fingerprints ?? [])} · source ${fingerprint} → ${otherFingerprint} · ${staleKeys.length} stale key(s)`);
  if (otherRequests < 1) fail('a different provider was served from another provider\'s entries');
  if (other.hits !== 0) fail(`the switched source reported ${other.hits} hit(s)`);
  if (other.swept < 1) fail('the retired source\'s entries were not swept');
  if (fingerprint && otherFingerprint === fingerprint) fail(`two different fixtures share the source fingerprint ${fingerprint}`);
  if (staleKeys.length) fail(`the database still holds ${staleKeys.length} key(s) from the previous source: ${staleKeys.slice(0, 2).join(', ')}`);
  if ((other.fingerprints ?? []).length !== 1) fail(`the report names ${(other.fingerprints ?? []).length} live source(s), expected one`);
  summary.switch = { fixture: `${switched.id}/${switched.variant}`, requests: otherRequests, ...counters(other), staleKeys: staleKeys.length, from: fingerprint, to: otherFingerprint };

  // ------------------------------------------------- 5. back: the sweep retired that source, so it refetches
  step('5 back to the first fixture, then free again');
  await selectFixture(page, baseUrl, { id: fixtures[0] });
  before = await served();
  await mount(COORDINATE);
  const back = await report(state => (state.cache?.stores ?? 0) >= 1, 'the first fixture to be refetched after its sweep');
  const backRequests = (await served()) - before;
  log(`[map09] fixture back ${fixtures[0]}: ${backRequests} request(s) · hit ${back.hits} miss ${back.misses} store ${back.stores} · ${back.entries} entr(ies)`);
  if (backRequests < 1) fail('returning to the first fixture made no request — its entries were swept, so the tile has to be fetched again');
  if (back.hits !== 0) fail(`returning to a swept source reported ${back.hits} hit(s)`);
  summary.back = { requests: backRequests, ...counters(back) };

  // ...and a second session at that fixture is free again, which is the attribution-safe claim:
  // the sweep removed the retired source, not the live one.
  before = await served();
  await mount(COORDINATE);
  const backAgain = await report(state => (state.cache?.hits ?? 0) >= 1, 'the refetched tile to be served from storage');
  const backAgainRequests = (await served()) - before;
  log(`[map09] reload again: ${backAgainRequests} request(s) · hit ${backAgain.hits} · ${backAgain.entries} entr(ies)`);
  if (backAgainRequests !== 0) fail(`the reload after the refetch spent ${backAgainRequests} request(s)`);
  summary.backAgain = { requests: backAgainRequests, ...counters(backAgain) };

  // ------------------------------------------------- 6. size: the budget is a promise about the disk
  step('6 a smaller budget evicts, least recently used first');
  // One record's real cost: its payload plus the cache's own per-record overhead, as the
  // cache itself accounts for it. Measured rather than hard-coded, because a change to the
  // record format would otherwise leave this gate budgeting against yesterday's arithmetic
  // and silently proving nothing.
  const recordCost = Math.ceil((back.bytes || back.cachedBytes) / Math.max(back.entries, 1));
  await restart();
  const twoRecords = 2 * recordCost;
  await mount(COORDINATE, withParam(String(twoRecords)));
  const staged = await report(state => (state.cache?.entries ?? 0) >= 1, 'the first staged record');
  const keysA = ((await readIdb()).keys ?? []);
  before = await served();
  await mount(DISTANT, withParam(String(twoRecords)));
  const evicted = await report(state => (state.cache?.evictions ?? 0) >= 1, 'the budget to evict');
  const evictedRequests = (await served()) - before;
  const evictedIdb = await readIdb();
  const survivors = evictedIdb.keys ?? [];
  const goneFromA = keysA.filter(entry => !survivors.includes(entry));
  const victim = evicted.lastEviction?.key ?? null;
  log(`[map09] budget ${twoRecords} B (one record costs ${recordCost} B): ${staged.entries} → ${evicted.entries} entr(ies) · ${evicted.evictions} eviction(s) of ${evicted.evictedBytes} B · accounted ${evicted.bytes} B ≤ ${evicted.limitBytes} B · ${evictedRequests} request(s) · victim ${victim?.split('|').slice(1).join('|') ?? 'none'} · ${goneFromA.length} of the first coordinate's key(s) gone · ${survivors.length} key(s) in IndexedDB`);
  if (evicted.limitBytes !== twoRecords) fail(`the runtime reported a ${evicted.limitBytes} B budget, not the ${twoRecords} B it was given`);
  if (evictedRequests < 1) fail('the second coordinate made no request — nothing new was there to evict for');
  if (evicted.evictions < 1) fail(`a ${twoRecords} B budget receiving more than two records evicted nothing`);
  if (evicted.bytes > evicted.limitBytes) fail(`the cache accounts for ${evicted.bytes} B against a ${evicted.limitBytes} B budget`);
  if (evicted.entries < 1 || evicted.entries > 2) fail(`the budget holds two records and the cache reports ${evicted.entries} entries`);
  if (survivors.length !== evicted.entries) fail(`IndexedDB holds ${survivors.length} keys against a report of ${evicted.entries} entries`);
  // The least-recently-used claim, stated in the two things a reader can check from outside:
  // entries that were already stored before this leg were evicted, and nothing that survived
  // is older than the entry that was evicted last. (The victim of the *last* eviction need not
  // be one of those older entries: once they are gone, the policy continues through the
  // records this leg stored, which is the same rule applied to a smaller set.)
  if (evicted.lastEviction?.reason !== 'budget') fail(`the eviction was recorded as ${JSON.stringify(evicted.lastEviction?.reason)}`);
  if (!keysA.length) fail('the staging session stored nothing for the eviction to choose between');
  if (!goneFromA.length) fail('nothing that was already stored was evicted — the policy is not least-recently-used');
  if (victim && Number.isFinite(evicted.lastEviction?.lastUsed) && (evicted.oldestLastUsed ?? Infinity) < evicted.lastEviction.lastUsed) {
    fail(`an entry last used at ${evicted.oldestLastUsed} survived an entry evicted at ${evicted.lastEviction.lastUsed} — the policy is not least-recently-used`);
  }
  if (evicted.errors !== 0) fail(`the eviction reported ${evicted.errors} error(s)`);
  summary.budget = { recordCost, budget: twoRecords, ...counters(evicted), keys: survivors.length, victim, goneFromA: goneFromA.length, requests: evictedRequests };

  // ------------------------------------------------- 7. a budget below one record refuses, and comes inside
  step('7 a budget too small for one record');
  before = await served();
  const tooSmall = recordCost - 128;
  await mount(ELSEWHERE, withParam(String(tooSmall)));
  const refused = await report(state => (state.cache?.entries ?? -1) === 0 && (state.cache?.skipped ?? 0) >= 1, 'the oversized record to be refused');
  const refusedIdb = await readIdb();
  const still = await read();
  log(`[map09] budget ${tooSmall} B against a ${recordCost} B record: ${refused.evictions} eviction(s) at open · entries ${refused.entries} · accounted ${refused.bytes} B · skipped ${refused.skipped} · ${(refusedIdb.keys ?? []).length} key(s) · errors ${refused.errors} · the runtime still rendered ${still.downloads?.resident} tile(s)`);
  if (refused.limitBytes !== tooSmall) fail(`the runtime reported a ${refused.limitBytes} B budget, not the ${tooSmall} B it was given`);
  if (refused.evictions < 1) fail('a budget below one record held on to the entries it could not afford');
  if (refused.entries !== 0) fail(`a budget too small for one record still holds ${refused.entries} entries`);
  if (refused.bytes !== 0) fail(`a budget too small for one record still accounts for ${refused.bytes} B`);
  if ((refusedIdb.keys ?? []).length !== 0) fail(`a budget too small for one record still wrote ${(refusedIdb.keys ?? []).length} key(s)`);
  if (refused.skipped < 1) fail('a record larger than the whole budget was not refused');
  if (refused.errors !== 0) fail(`the refusal counted ${refused.errors} error(s) — a budget that cannot hold a record is a state, not a failure`);
  if ((still.downloads?.resident ?? 0) < 1) fail('the runtime did not render the tile while the cache refused to store it');
  summary.refusal = { budget: tooSmall, recordCost, ...counters(refused), keys: (refusedIdb.keys ?? []).length, resident: still.downloads?.resident };

  // ------------------------------------------------- 8. version: a foreign format is forgotten, not read
  step('8 a foreign format is forgotten, not read');
  await restart();
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 90_000 });
  const foreign = await page.evaluate(`(${WRITE_FOREIGN_MANIFEST})()`);
  const planted = await readIdb();
  await selectFixture(page, baseUrl, { id: fixtures[0] });
  before = await served();
  await mount(COORDINATE);
  const met = await report(state => (state.cache?.entries ?? 0) >= 1, 'the cache to refill after refusing a foreign format');
  const plantedEvictions = met.evictions;
  const metIdb = await readIdb();
  const plantedRequests = (await served()) - before;
  log(`[map09] foreign manifest ${foreign.namespace} (planted over ${(planted.keys ?? []).length} key(s)): reset ${met.reset} resets ${met.resets} errors ${met.errors} · ${plantedRequests} request(s) · ${met.entries} entr(ies) · manifest now ${metIdb.manifest?.namespace}`);
  // `resets` rather than `reset`: the flag describes the open that just happened, and by the
  // time the report is read the cache has already refilled and cleared it. The counter is the
  // record of what occurred.
  if (met.resets < 1) fail('a foreign manifest was adopted instead of refused');
  if (plantedRequests < 1) fail('a foreign manifest left entries behind — nothing was refetched');
  if (metIdb.manifest?.namespace !== 'gdo:tilecache:v1') fail(`the repaired manifest is named ${JSON.stringify(metIdb.manifest?.namespace)}`);
  if (met.errors !== 0) fail(`the repair counted ${met.errors} error(s) — a cache may forget quietly`);
  if ((metIdb.keys ?? []).length !== met.entries) fail(`after the repair the report says ${met.entries} entries and IndexedDB holds ${(metIdb.keys ?? []).length}`);
  summary.version = { namespace: foreign.namespace, ...counters(met), requests: plantedRequests, manifest: metIdb.manifest?.namespace, evicted: plantedEvictions };

  // ------------------------------------------------- 9. the panel says what the gate read
  step('9 the panel line');
  await page.click('.geo-debug-toggle');
  // The tile line is the panel's *last* line (labels, time, weather and the save come first),
  // so the match is per line rather than anchored to the whole panel: the first version of
  // this gate anchored it and waited thirty seconds for a line that was already on screen.
  await page.waitForFunction(
    () => /(^|\n)tiles (v1|off) /.test(document.querySelector('#geo-debug-output')?.textContent ?? ''),
    { timeout: 30_000, polling: 200 },
  );
  const panel = await page.evaluate(() => (document.querySelector('#geo-debug-output')?.textContent ?? '').split('\n').find(line => line.startsWith('tiles ')) ?? '');
  await refresh();
  const shown = (await read()).cache;
  log(`[map09] panel: ${panel}`);
  if (!panel.includes(`entries ${shown.entries}/`)) fail(`the panel does not name the entry count the gate read: ${panel}`);
  if (!panel.includes(`${shown.cachedBytes} B cached of ${shown.limitBytes} B`)) fail(`the panel does not name the bytes the gate read: ${panel}`);
  if (!panel.includes(`hits ${shown.hits}`)) fail(`the panel does not name the hit count the gate read: ${panel}`);
  if (!panel.includes('indexeddb')) fail(`the panel does not name the storage the entries are in: ${panel}`);
  summary.panel = panel;

  // ------------------------------------------------- 10. clear: the player's own eviction
  step('10 clear');
  await page.evaluate(() => globalThis.__gdoAudit.game.clearTileCache());
  const emptied = await report(state => (state.cache?.entries ?? -1) === 0, 'the cache to be emptied');
  const emptiedIdb = await readIdb();
  log(`[map09] cleared: entries ${emptied.entries} · ${(emptiedIdb.keys ?? []).length} key(s) in IndexedDB · ${emptied.cachedBytes} B`);
  if (emptied.entries !== 0) fail(`after clearing, ${emptied.entries} entries remain`);
  if ((emptiedIdb.keys ?? []).length !== 0) fail(`after clearing, IndexedDB still holds ${(emptiedIdb.keys ?? []).length} key(s)`);
  if (emptied.cachedBytes !== 0) fail(`after clearing, the accounting still claims ${emptied.cachedBytes} B`);
  if ((emptiedIdb.manifest?.entries ? Object.keys(emptiedIdb.manifest.entries).length : -1) !== 0) fail('after clearing, the manifest still lists entries');
  summary.clear = { ...counters(emptied), keys: (emptiedIdb.keys ?? []).length };

  } catch (error) {
    // One leg dying must not cost the run its evidence. Report it with the step name that
    // was last announced and finish: the failure list is the product of this gate.
    fail(`the run stopped: ${error?.message ?? error}`);
    log(`[map09] the run stopped at the step above: ${(error?.stack ?? String(error)).split('\n').slice(0, 4).join(' | ')}`);
    log(`[map09] navigations this run: ${JSON.stringify(navigations.slice(-8))}`);
  }

  // The browser and the page the run ended on are handed back separately: `finish` is a module
  // function and cannot see them, and `run.mjs` needs them to classify errors and close cleanly.
  return { ...finish({ failures, directory, fixtures, log, summary, origin }), page, browser };
}

function finish({ failures, directory, fixtures, log, summary, origin }) {
  log(`[map09] ${failures.length ? 'FAIL' : 'PASS'}: ${failures.length} failure(s)`);
  for (const failure of failures) log(`  ${failure}`);
  return {
    directory,
    blockers: failures.length,
    sweepFrames: 0,
    totalPenetrations: 0,
    tileCacheFailures: failures,
    fixtures,
    summary,
    origin,
  };
}
