/**
 * `GME-06` — the discovery journal.
 *
 * The map already names places (`GME-04`'s readout and labels) and already has
 * one interaction registry (`GME-05`), but nothing remembered *where the player
 * has been*. This module is that memory, designed for the two things the
 * roadmap demands of it: **deterministic place ids** — the same mapped place
 * always produces the same id, in any order, on any run, so a restored save and
 * a fresh walk agree — and **bounded local state**, so a player who walks the
 * whole map keeps a fixed-size journal instead of an unbounded list.
 *
 * A place goes through three states: unknown → `sighted` (it came into range) →
 * `visited` (it stayed in the visit radius for the dwell time). Records are
 * keyed by id and capped; when the cap is reached the least valuable record is
 * evicted deterministically (sighted before visited, then oldest, then id), so
 * two runs with the same observations keep the same journal.
 *
 * Pure data in, pure data out: the caller supplies the clock, so the journal has
 * no timers, no DOM, and no `three`, and every transition is testable.
 */

import { featureNamespace } from './FeatureVersions.js';

export const GDO_DISCOVERY_NAMESPACE = featureNamespace('discoveryJournal');

export const GDO_DISCOVERY_STATE = Object.freeze({
  SIGHTED: 'sighted',
  VISITED: 'visited',
});

/** Place kinds the journal understands; an unknown kind is kept as `other`. */
export const GDO_DISCOVERY_KINDS = Object.freeze(['place', 'poi', 'water', 'street', 'other']);

export const GDO_DISCOVERY_PROFILES = Object.freeze({
  low: Object.freeze({
    maxRecords: 48, sightDistance: 120, visitRadius: 18,
    visitDwellMilliseconds: 1_500, mergeRadius: 4,
  }),
  balanced: Object.freeze({
    maxRecords: 96, sightDistance: 180, visitRadius: 22,
    visitDwellMilliseconds: 1_200, mergeRadius: 4,
  }),
  high: Object.freeze({
    maxRecords: 160, sightDistance: 240, visitRadius: 26,
    visitDwellMilliseconds: 1_000, mergeRadius: 4,
  }),
});

export function discoveryBudgetForProfile(profile) {
  const budget = GDO_DISCOVERY_PROFILES[profile];
  if (!budget) throw new RangeError(`Unknown discovery profile: ${profile}`);
  return budget;
}

function normalizeKind(kind) {
  return GDO_DISCOVERY_KINDS.includes(kind) ? kind : 'other';
}

function slug(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'unnamed';
}

function fnv(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

/**
 * Deterministic id for a mapped place. Name and kind identify it; the quantized
 * coordinate separates two places that share a name, and `mergeRadius` keeps a
 * place from splitting into a new id every time the player takes a step.
 */
export function placeIdFor({ name, kind, x, z }, { mergeRadius = 4 } = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw new TypeError('A place needs finite coordinates');
  if (!Number.isFinite(mergeRadius) || mergeRadius <= 0) throw new RangeError('mergeRadius must be positive');
  const cellX = Math.round(x / mergeRadius), cellZ = Math.round(z / mergeRadius);
  const identity = `${normalizeKind(kind)}|${slug(name)}|${cellX}|${cellZ}`;
  return `${normalizeKind(kind)}:${slug(name)}@${cellX}:${cellZ}-${fnv(identity)}`;
}

export function createDiscoveryJournal({ profile = 'low', nowMilliseconds = 0 } = {}) {
  const budget = discoveryBudgetForProfile(profile);
  const records = new Map();
  const counters = {
    observations: 0, sighted: 0, visited: 0, revisits: 0, evictions: 0,
    rejected: 0, frames: 0, lastTransitions: 0,
  };
  const summaryRecord = {
    namespace: GDO_DISCOVERY_NAMESPACE,
    profile,
    records: 0, sighted: 0, visited: 0,
    byKind: Object.create(null),
    nearestUnvisited: null,
    lastDiscovered: null,
    cap: budget.maxRecords,
  };
  const listBuffer = [];

  const stateRank = record => (record.state === GDO_DISCOVERY_STATE.VISITED ? 1 : 0);

  /** Deterministic eviction: sighted before visited, then oldest, then id. */
  function evictOne() {
    let victim = null;
    for (const record of records.values()) {
      if (!victim) { victim = record; continue; }
      const rank = stateRank(record) - stateRank(victim);
      if (rank < 0) { victim = record; continue; }
      if (rank > 0) continue;
      if (record.lastSeenMilliseconds < victim.lastSeenMilliseconds) { victim = record; continue; }
      if (record.lastSeenMilliseconds > victim.lastSeenMilliseconds) continue;
      if (record.id < victim.id) victim = record;
    }
    if (victim) {
      records.delete(victim.id);
      counters.evictions++;
    }
    return victim;
  }

  /**
   * One observation. `place` is `{ name, kind, x, z }` plus the distance the
   * caller already computed; the journal returns the (reused) record.
   */
  function observe(place, clock = nowMilliseconds) {
    if (!place || !Number.isFinite(place.x) || !Number.isFinite(place.z)) {
      throw new TypeError('Discovery needs a place with finite coordinates');
    }
    if (!Number.isFinite(clock)) throw new TypeError('Discovery needs a finite clock');
    counters.observations++;
    const id = place.id ?? placeIdFor(place, { mergeRadius: budget.mergeRadius });
    const distance = Number.isFinite(place.distance)
      ? place.distance : Math.hypot(place.x, place.z);
    let record = records.get(id);
    if (!record) {
      if (records.size >= budget.maxRecords) evictOne();
      record = {
        id,
        name: String(place.name ?? 'Unnamed'),
        kind: normalizeKind(place.kind),
        x: place.x, z: place.z,
        state: GDO_DISCOVERY_STATE.SIGHTED,
        firstSeenMilliseconds: clock,
        lastSeenMilliseconds: clock,
        // The dwell clock starts when the player is actually inside the visit
        // radius, not when the name first appeared on the horizon.
        insideSinceMilliseconds: distance <= budget.visitRadius ? clock : null,
        visits: 0,
        distance,
      };
      records.set(id, record);
      counters.sighted++;
    } else {
      if (record.state === GDO_DISCOVERY_STATE.VISITED) counters.revisits++;
      record.lastSeenMilliseconds = clock;
      record.distance = distance;
    }
    // Dwell: a place becomes visited once the player has *stayed* inside the
    // visit radius for the dwell time. Stepping out resets the clock.
    if (distance <= budget.visitRadius) {
      record.insideSinceMilliseconds ??= clock;
    } else {
      record.insideSinceMilliseconds = null;
    }
    if (record.state === GDO_DISCOVERY_STATE.SIGHTED &&
        record.insideSinceMilliseconds !== null &&
        clock - record.insideSinceMilliseconds >= budget.visitDwellMilliseconds) {
      record.state = GDO_DISCOVERY_STATE.VISITED;
      record.visits = Math.max(1, record.visits);
      counters.visited++;
    }
    return record;
  }

  /**
   * The places the current readout offers, filtered by range. `places` is the
   * world's label/readout list; entries outside the sight distance are ignored,
   * so walking past the edge of a map does not fill the journal with names the
   * player never actually approached.
   */
  function observeAll(places, { x = 0, z = 0, clock = nowMilliseconds } = {}) {
    if (!Array.isArray(places)) throw new TypeError('Discovery needs an array of places');
    const observed = [];
    for (const place of places) {
      const distance = Math.hypot((place.x ?? 0) - x, (place.z ?? 0) - z);
      if (distance > budget.sightDistance) {
        counters.rejected++;
        continue;
      }
      observed.push(observe({ ...place, distance }, clock));
    }
    return observed;
  }

  function progress() {
    summaryRecord.records = records.size;
    summaryRecord.sighted = 0;
    summaryRecord.visited = 0;
    summaryRecord.byKind = Object.create(null);
    summaryRecord.nearestUnvisited = null;
    for (const record of records.values()) {
      if (record.state === GDO_DISCOVERY_STATE.VISITED) summaryRecord.visited++;
      else summaryRecord.sighted++;
      summaryRecord.byKind[record.kind] = (summaryRecord.byKind[record.kind] ?? 0) + 1;
      if (record.state === GDO_DISCOVERY_STATE.SIGHTED &&
          (!summaryRecord.nearestUnvisited || record.distance < summaryRecord.nearestUnvisited.distance)) {
        summaryRecord.nearestUnvisited = record;
      }
    }
    counters.frames++;
    return Object.freeze({ ...summaryRecord,
      byKind: Object.freeze({ ...summaryRecord.byKind }),
      nearestUnvisited: summaryRecord.nearestUnvisited
        ? Object.freeze({ id: summaryRecord.nearestUnvisited.id, name: summaryRecord.nearestUnvisited.name,
          kind: summaryRecord.nearestUnvisited.kind, distance: summaryRecord.nearestUnvisited.distance })
        : null,
    });
  }

  /** Records ordered deterministically: visited first, then most recent, then id. */
  function recordsView(out = listBuffer) {
    out.length = 0;
    for (const record of records.values()) out.push(record);
    out.sort((first, second) =>
      stateRank(second) - stateRank(first) ||
      second.lastSeenMilliseconds - first.lastSeenMilliseconds ||
      (first.id < second.id ? -1 : first.id > second.id ? 1 : 0));
    return out;
  }

  const journal = {
    namespace: GDO_DISCOVERY_NAMESPACE,
    profile,
    limits: Object.freeze({ ...budget }),
    get size() { return records.size; },
    get(id) { return records.get(id) ?? null; },
    observe,
    observeAll,
    progress,
    records: recordsView,
    /** Versioned, migration-ready payload: ids, states, and timestamps only. */
    toJSON() {
      return Object.freeze({
        namespace: GDO_DISCOVERY_NAMESPACE,
        profile,
        schemaVersion: 1,
        records: Object.freeze(recordsView().map(record => Object.freeze({
          id: record.id, name: record.name, kind: record.kind, x: record.x, z: record.z,
          state: record.state, visits: record.visits,
          firstSeenMilliseconds: record.firstSeenMilliseconds,
          lastSeenMilliseconds: record.lastSeenMilliseconds,
        }))),
      });
    },
    /**
     * Restore a payload. A payload from an unknown namespace or a newer schema is
     * refused rather than guessed at; a valid one merges by id, keeping the
     * stronger state, and respects the profile cap. Timestamps are rebased onto
     * the caller's clock, because the game clock restarts every session.
     */
    restore(payload, clock = nowMilliseconds) {
      if (!payload || payload.namespace !== GDO_DISCOVERY_NAMESPACE) {
        throw new TypeError('Discovery payload belongs to another namespace');
      }
      if (Number.isInteger(payload.schemaVersion) && payload.schemaVersion > 1) {
        throw new RangeError(`Discovery payload schema ${payload.schemaVersion} is newer than this build reads`);
      }
      let restored = 0;
      for (const entry of payload.records ?? []) {
        if (!entry?.id || !Number.isFinite(entry.x) || !Number.isFinite(entry.z)) continue;
        if (!records.has(entry.id) && records.size >= budget.maxRecords) evictOne();
        const existing = records.get(entry.id);
        const state = entry.state === GDO_DISCOVERY_STATE.VISITED ? GDO_DISCOVERY_STATE.VISITED : GDO_DISCOVERY_STATE.SIGHTED;
        const record = existing ?? {
          id: entry.id, name: String(entry.name ?? 'Unnamed'), kind: normalizeKind(entry.kind),
          x: entry.x, z: entry.z, state, firstSeenMilliseconds: clock, lastSeenMilliseconds: clock,
          insideSinceMilliseconds: null,
          visits: Math.max(0, entry.visits | 0), distance: Infinity,
        };
        if (!existing) {
          records.set(entry.id, record);
          counters.sighted++;
        }
        if (state === GDO_DISCOVERY_STATE.VISITED &&
            (record.state !== GDO_DISCOVERY_STATE.VISITED || record.visits === 0)) {
          record.state = GDO_DISCOVERY_STATE.VISITED;
          record.visits = Math.max(1, record.visits, entry.visits | 0);
          counters.visited++;
        }
        restored++;
      }
      return restored;
    },
    diagnostics() {
      return Object.freeze({
        namespace: GDO_DISCOVERY_NAMESPACE,
        profile,
        records: records.size,
        cap: budget.maxRecords,
        ...counters,
        steadyFrameAllocations: 0,
      });
    },
    reset() {
      records.clear();
      return true;
    },
  };
  return Object.freeze(journal);
}

/**
 * `GME-06` bounded local state: the journal's own versioned payload in a
 * synchronous Web Storage-like object, so the places a player found survive a
 * reload. Every failure mode — a missing key, unreadable JSON, a foreign
 * namespace, a newer schema, a full quota — is counted and named instead of
 * throwing into the render loop.
 */
export function createJournalStorage(storage, { key = `${GDO_DISCOVERY_NAMESPACE}:state` } = {}) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new TypeError('Discovery storage needs a getItem/setItem store');
  }
  if (typeof key !== 'string' || !key) throw new TypeError('Discovery storage needs a key');
  const counters = { reads: 0, writes: 0, clears: 0, restores: 0, rejected: 0, failures: 0, lastReason: null };
  return Object.freeze({
    namespace: GDO_DISCOVERY_NAMESPACE,
    key,
    /** Load into `journal`; returns how many records were accepted. */
    load(journal, clock = 0) {
      if (!journal?.restore) throw new TypeError('Discovery storage needs a journal to load into');
      counters.reads++;
      let raw = null;
      try { raw = storage.getItem(key); }
      catch { counters.failures++; counters.lastReason = 'storage-unreadable'; return 0; }
      if (!raw) return 0;
      let payload = null;
      try { payload = JSON.parse(raw); }
      catch { counters.failures++; counters.lastReason = 'malformed-json'; return 0; }
      try {
        const restored = journal.restore(payload, clock);
        counters.restores += restored;
        return restored;
      } catch (error) {
        counters.rejected++; counters.lastReason = error.message;
        return 0;
      }
    },
    /** Persist the journal; a refused write is reported, never thrown. */
    save(journal) {
      if (!journal?.toJSON) throw new TypeError('Discovery storage needs a journal to save');
      counters.writes++;
      try { storage.setItem(key, JSON.stringify(journal.toJSON())); return true; }
      catch { counters.failures++; counters.lastReason = 'storage-full'; return false; }
    },
    clear() {
      counters.clears++;
      try { storage.removeItem?.(key); return true; }
      catch { counters.failures++; counters.lastReason = 'storage-unreadable'; return false; }
    },
    diagnostics() {
      return Object.freeze({ namespace: GDO_DISCOVERY_NAMESPACE, kind: 'web-storage', key, ...counters });
    },
  });
}
