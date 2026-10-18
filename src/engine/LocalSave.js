/**
 * `NET-01` — the versioned local save (`gdo:localSave:v1`).
 *
 * One envelope carries **settings, discovery, and progress** across a reload —
 * migration-safe in the `CNT-01`/`GME-06` manner: every payload is namespaced
 * and versioned, a known older schema walks a declared migration chain one
 * version at a time, a newer schema is refused by name instead of guessed at,
 * a foreign namespace never merges, and a storage failure is counted rather
 * than thrown into the render loop.
 *
 * The envelope is the *aggregate* record. `GME-06`'s journal keeps its own
 * landed store as the live source; the v0 migration exists precisely for worlds
 * that only ever wrote that bare journal payload — its discovery data is lifted
 * into the envelope on first load rather than abandoned.
 */

import { GDO_FEATURE_VERSIONS, featureNamespace } from './FeatureVersions.js';

// The `FND-06` placeholder this row closes: `saveSchema` was version 0 — a
// researched contract with no compatible schema yet. It is 1 now.
export const GDO_SAVE_NAMESPACE = featureNamespace('saveSchema');
export const GDO_SAVE_SCHEMA = GDO_FEATURE_VERSIONS.saveSchema;

/** The declared settings vocabulary. Anything else is refused by name. */
export const GDO_SAVE_SETTINGS = Object.freeze({
  profile: Object.freeze(['low', 'balanced', 'high']),
  touchControls: Object.freeze([true, false]),
  reducedMotion: Object.freeze([true, false]),
  cameraFade: Object.freeze([true, false]),
});

export const GDO_SAVE_REFUSAL = Object.freeze({
  MALFORMED: 'malformed-json',
  FOREIGN: 'foreign-namespace',
  FUTURE: 'future-schema',
  UNKNOWN_SETTING: 'unknown-setting',
  INVALID_SETTING: 'invalid-setting',
  INVALID_PROGRESS: 'invalid-progress',
  STORAGE_FULL: 'storage-full',
  STORAGE_UNREADABLE: 'storage-unreadable',
  NO_PAYLOAD: 'no-payload',
});

const GDO_DISCOVERY_NAMESPACE = 'gdo:discoveryJournal:v1';

function validEnvelopeShape(payload) {
  return payload && typeof payload === 'object' &&
    typeof payload.namespace === 'string' &&
    Number.isInteger(payload.schema) && payload.schema >= 0;
}

function validateSettings(settings, refusals) {
  const clean = Object.create(null);
  if (!settings || typeof settings !== 'object') return clean;
  for (const [key, value] of Object.entries(settings)) {
    if (!(key in GDO_SAVE_SETTINGS)) {
      refusals[GDO_SAVE_REFUSAL.UNKNOWN_SETTING]++;
      continue;
    }
    const allowed = GDO_SAVE_SETTINGS[key];
    if (!allowed.includes(value)) {
      refusals[GDO_SAVE_REFUSAL.INVALID_SETTING]++;
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

function validateProgress(progress, refusals) {
  const clean = { activities: [] };
  if (!progress || typeof progress !== 'object') return clean;
  const list = Array.isArray(progress.activities) ? progress.activities : [];
  const seen = new Set();
  for (const entry of list) {
    if (!entry || typeof entry.id !== 'string' || !entry.id ||
        seen.has(entry.id) ||
        !Number.isFinite(entry.progress) || entry.progress < 0 ||
        !['active', 'complete'].includes(entry.state)) {
      refusals[GDO_SAVE_REFUSAL.INVALID_PROGRESS]++;
      continue;
    }
    seen.add(entry.id);
    clean.activities.push({
      id: entry.id,
      progress: Math.round(entry.progress * 1_000) / 1_000,
      state: entry.state,
    });
    if (clean.activities.length >= 64) break;
  }
  return clean;
}

/**
 * The migration chain. Each step takes one payload version to the next; the
 * loader walks them in order, so a two-version-old save is proved to arrive by
 * passing through both steps rather than by a bespoke reader.
 */
export const GDO_SAVE_MIGRATIONS = Object.freeze([
  // v0: the bare `GME-06` journal payload that predates the envelope.
  Object.freeze({
    from: 0,
    to: 1,
    migrate(payload) {
      if (payload?.namespace === GDO_DISCOVERY_NAMESPACE) {
        return {
          namespace: GDO_SAVE_NAMESPACE,
          schema: 1,
          settings: {},
          discovery: payload,
          progress: { activities: [] },
        };
      }
      // A v0 that is not the journal is unknown history: keep its body under
      // `progress` rather than drop it, and let validation prune what it cannot
      // carry.
      return {
        namespace: GDO_SAVE_NAMESPACE,
        schema: 1,
        settings: payload?.settings ?? {},
        discovery: payload?.discovery ?? null,
        progress: payload?.progress ?? { activities: [] },
      };
    },
  }),
]);

/**
 * The local save. One instance per world; capture builds a fresh envelope
 * (saves are rare), while load/restore mutate preallocated records.
 */
export function createLocalSave({
  storage = null,
  key = `${GDO_SAVE_NAMESPACE}:state`,
  nowMilliseconds = 0,
  ledger = null,
} = {}) {
  if (storage && (typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function')) {
    throw new TypeError('Local save storage needs a getItem/setItem store');
  }
  if (typeof key !== 'string' || !key) throw new TypeError('Local save storage needs a key');

  const refusals = Object.create(null);
  for (const name of Object.values(GDO_SAVE_REFUSAL)) refusals[name] = 0;
  const counters = {
    reads: 0, writes: 0, restores: 0, migrations: 0, rejected: 0, failures: 0,
    lastReason: null, schema: GDO_SAVE_SCHEMA,
  };
  let lastPayload = null;

  /** Build the envelope from the live state. Declared keys only. */
  function capture({ settings = null, discovery = null, activities = null, worldVersion = 0, nowMilliseconds: at = nowMilliseconds } = {}) {
    return {
      namespace: GDO_SAVE_NAMESPACE,
      schema: GDO_SAVE_SCHEMA,
      savedAt: at,
      worldVersion,
      settings: validateSettings(settings, refusals),
      discovery: discovery ?? null,
      // One validator for capture and restore alike: a state that cannot be
      // named is pruned and counted on the way in exactly as on the way out.
      progress: validateProgress({ activities: activities ?? [] }, refusals),
    };
  }

  /** Persist an envelope; a refused write is reported, never thrown. */
  function persist(envelope) {
    if (!storage) return false;
    if (!validEnvelopeShape(envelope) || envelope.namespace !== GDO_SAVE_NAMESPACE) {
      refusals[GDO_SAVE_REFUSAL.FOREIGN]++;
      counters.rejected++;
      return false;
    }
    counters.writes++;
    try {
      storage.setItem(key, JSON.stringify(envelope));
      lastPayload = envelope;
      return true;
    } catch {
      counters.failures++;
      counters.lastReason = GDO_SAVE_REFUSAL.STORAGE_FULL;
      return false;
    }
  }

  /**
   * Read and migrate. The raw JSON becomes the current schema by walking the
   * declared chain; anything the chain cannot name is refused with its reason.
   */
  function load() {
    if (!storage) return null;
    counters.reads++;
    let raw = null;
    try { raw = storage.getItem(key); }
    catch {
      counters.failures++;
      counters.lastReason = GDO_SAVE_REFUSAL.STORAGE_UNREADABLE;
      return null;
    }
    if (!raw) { counters.lastReason = GDO_SAVE_REFUSAL.NO_PAYLOAD; return null; }
    let payload = null;
    try { payload = JSON.parse(raw); }
    catch {
      counters.failures++;
      counters.rejected++;
      counters.lastReason = GDO_SAVE_REFUSAL.MALFORMED;
      return null;
    }
    if (!validEnvelopeShape(payload) && payload?.namespace !== GDO_DISCOVERY_NAMESPACE) {
      counters.rejected++;
      counters.lastReason = GDO_SAVE_REFUSAL.FOREIGN;
      return null;
    }
    if (payload.namespace !== GDO_SAVE_NAMESPACE && payload.namespace !== GDO_DISCOVERY_NAMESPACE) {
      counters.rejected++;
      counters.lastReason = GDO_SAVE_REFUSAL.FOREIGN;
      return null;
    }
    // The `GME-06` journal payload is pre-envelope history: its `schemaVersion`
    // counts as schema 0 of the save, and the chain lifts it from there.
    if (payload.namespace === GDO_DISCOVERY_NAMESPACE && !Number.isInteger(payload.schema)) {
      payload = { ...payload, schema: 0 };
    }
    if (payload.schema > GDO_SAVE_SCHEMA) {
      counters.rejected++;
      counters.lastReason = GDO_SAVE_REFUSAL.FUTURE;
      return null;
    }
    let migrated = payload;
    while (migrated.schema < GDO_SAVE_SCHEMA) {
      const step = GDO_SAVE_MIGRATIONS.find(candidate => candidate.from === migrated.schema);
      if (!step) {
        counters.rejected++;
        counters.lastReason = GDO_SAVE_REFUSAL.FUTURE;
        return null;
      }
      migrated = step.migrate(migrated);
      counters.migrations++;
    }
    lastPayload = {
      namespace: GDO_SAVE_NAMESPACE,
      schema: GDO_SAVE_SCHEMA,
      savedAt: Number.isFinite(migrated.savedAt) ? migrated.savedAt : 0,
      worldVersion: migrated.worldVersion ?? 0,
      settings: validateSettings(migrated.settings, refusals),
      discovery: migrated.discovery ?? null,
      progress: validateProgress(migrated.progress, refusals),
    };
    return lastPayload;
  }

  /**
   * Apply a loaded payload to the live state: the journal takes its discovery
   * back through the `GME-06` restore (its own refusals still apply), the
   * activities board takes progress by its deterministic ids, and the settings
   * target receives only the declared, validated keys.
   */
  function restore(payload, { journal = null, activities = null, settingsTarget = null } = {}) {
    if (!payload || payload.namespace !== GDO_SAVE_NAMESPACE) {
      refusals[GDO_SAVE_REFUSAL.FOREIGN]++;
      return null;
    }
    const settings = validateSettings(payload.settings, refusals);
    const progress = validateProgress(payload.progress, refusals);
    let discoveryRestored = 0;
    if (journal && payload.discovery) {
      try { discoveryRestored = journal.restore(payload.discovery, 0) ?? 0; }
      catch { refusals[GDO_SAVE_REFUSAL.FOREIGN]++; }
    }
    const progressById = new Map(progress.activities.map(entry => [entry.id, entry]));
    let activitiesRestored = 0;
    if (activities?.length) {
      for (const record of activities) {
        const saved = progressById.get(record.id);
        if (!saved) continue;
        record.progress = saved.progress;
        record.state = saved.state;
        activitiesRestored++;
      }
    }
    if (settingsTarget) {
      for (const [key, value] of Object.entries(settings)) settingsTarget[key] = value;
    }
    counters.restores++;
    return {
      settings,
      progress,
      discoveryRestored,
      activitiesRestored,
    };
  }

  const diagnostics = Object.create(null);
  function diagnosticsSnapshot() {
    diagnostics.namespace = GDO_SAVE_NAMESPACE;
    diagnostics.schema = GDO_SAVE_SCHEMA;
    diagnostics.key = key;
    diagnostics.reads = counters.reads;
    diagnostics.writes = counters.writes;
    diagnostics.restores = counters.restores;
    diagnostics.migrations = counters.migrations;
    diagnostics.rejected = counters.rejected;
    diagnostics.failures = counters.failures;
    diagnostics.lastReason = counters.lastReason;
    diagnostics.refusals = refusals;
    return diagnostics;
  }

  const handle = ledger?.own?.('handle', GDO_SAVE_NAMESPACE, { get lastPayload() { return lastPayload; } }, () => {
    lastPayload = null;
  }) ?? null;

  return {
    namespace: GDO_SAVE_NAMESPACE,
    schema: GDO_SAVE_SCHEMA,
    key,
    capture,
    persist,
    load,
    restore,
    get lastPayload() { return lastPayload; },
    get diagnostics() { return diagnosticsSnapshot(); },
    counters,
    refusals,
    dispose() {
      handle?.release?.();
      lastPayload = null;
    },
  };
}
