/**
 * `NET-01` — versioned local save.
 *
 * Registered gate (feature-roadmap/README.md order 170):
 *   *"Migration-safe settings/discovery/progress"*
 *
 * Research (`PROCEDURAL_WORLD_FEATURE_RESEARCH.md` §4.7):
 *   *"Local persistence | IndexedDB record keyed by world-version + coordinate tile +
 *   discovery ID | Revisits retain progress | Low | P1"*.
 *
 * Until now nothing in the project persisted anything: `localStorage` appears nowhere in
 * `src/`, so a reload threw away every place the discovery journal had recorded, every
 * collectible the curated runtime had picked up, and every preference the player had set —
 * the weather, the profile and the journal were all rebuilt from scratch as if the player
 * had never been there. The features that were *built* for a save file said so in their own
 * comments (`GME-06`: "a save file `NET-01` will write"; `CNT-01`: "`NET-01` reuses the
 * ladder for save-file migration") and this is the module that honours both.
 *
 * Three sections, exactly the three the gate names
 * -----------------------------------------------
 * - **settings** — declared player preferences, one table (`SAVE_SETTING_FIELDS`) with a
 *   type, a fallback and a reason per field. Both shipped settings are two-way: the curated
 *   runtime writes `soundEnabled` when the player mutes, and the coordinate runtime writes
 *   `showDebug` when the review panel is toggled. A key the table does not declare is
 *   dropped rather than stored, so a save cannot smuggle arbitrary data back into a runtime.
 * - **discovery** — the journal's entries. An entry stores the **id** `GME-06` derives from
 *   the place, plus the anchor, name and radius needed to show it again. The id is stored
 *   *and checked*: `restoreDiscovery` re-derives it and refuses an entry whose id is not the
 *   id of its own place, so a hand-edited save cannot invent a discovery the world would
 *   never have produced, and the journal's determinism claim survives contact with storage.
 * - **progress** — where the player got to and what they collected: `lastMode`,
 *   `lastCoordinate`, and `states` keyed by the **content-pack vocabulary** the collectibles
 *   already use (`vada-pav` is a `maharashtra` item), each holding the instance ids in
 *   collection order and the score they were worth.
 *
 * The four rules the module is built to keep
 * -----------------------------------------
 * 1. **Never persist what you would refuse.** `SaveStore.write()` validates the candidate
 *    through the same `validateSave` the reader uses and refuses to write a save it would
 *    reject on load. A writer and a reader that can disagree is a writer that eventually
 *    writes a profile the reader has to skip.
 * 2. **Never destroy what you do not understand.** A save from a *newer* schema, or text
 *    that does not parse, is left exactly as it is: the store reports the problem, copies the
 *    unreadable text to a backup key for support, and keeps running on an empty save. It does
 *    not overwrite the file and it does not silently pretend the player had never played.
 * 3. **Migration is a ladder, not a flag** (`CNT-01`'s contract, reused): `SAVE_MIGRATIONS[n]`
 *    turns version `n` into `n + 1`, each step pure and returning its own notes. Version `0`
 *    is the pre-schema shape — the same three sections, unstamped — and the step repairs only
 *    what is unambiguous: it re-derives an id that does not match its own place, coerces a
 *    setting that a pre-schema writer stored as `0`/`1`, drops undeclared settings, and
 *    dedupes collected ids (a doubly-collected item is pure waste, the same reasoning
 *    `CNT-01` uses for coincident voxels). It never invents an entry.
 * 4. **A write is a change, not a frame.** The store is dirty-tracked and interval-coalesced,
 *    so the frame loop can call `tick(now)` sixty times a second and the document is written
 *    at most once per second *and only when something in it actually moved*. The unchanged
 *    check compares the canonical bytes with the timestamp field removed, so a clock tick is
 *    not mistaken for a change to the save.
 *
 * Storage, and the one thing this does *not* do yet
 * ------------------------------------------------
 * The store talks to a three-method adapter (`getItem`/`setItem`/`removeItem`) and ships a
 * localStorage adapter, a memory adapter for tests, and a null adapter for a browser that
 * refuses storage (private mode, a sandboxed frame). That is a deliberate divergence from the
 * research's IndexedDB: the runtime applies a restored setting **at mount** (`showDebug`
 * decides whether the review panel opens) and the landing shell resumes the player's last
 * session before the first frame, and only a synchronous adapter can answer in time for both.
 * The document is versioned *inside* the key rather than by the key (a versioned key would
 * make the migration ladder unreachable), `worldVersion` stamps the generator that wrote it,
 * and the 64 KiB ceiling is ours rather than the browser's — a save is a small document, and a
 * bound the reader can state is what makes "bounded local state" checkable. Moving the same
 * document to IndexedDB is a second adapter, not a second schema, and is recorded as the open
 * step in `feature-roadmap/VISUAL_GATES.md` §4 A4m rather than implied.
 *
 * Deliberately **not** here: the multiplayer protocol (`NET-02`), interest management
 * (`NET-03`) and avatars (`NET-04`) — all `DEFERRED` — and the accessibility surface
 * (`GME-10`), which is what turns this module's two settings into a screen of them.
 */

import { GDO_FEATURE_VERSIONS, GDO_GENERATOR_VERSION } from './FeatureVersions.js';
import { GEO_DISCOVERY_CAPACITY, discoveryKind, discoveryPlaceId } from './DiscoveryJournal.js';
import { STATE_CONTENT_LIMITS } from './ContentSchema.js';

/** The version this module writes and reads. Mirrors the feature registry. */
export const GDO_SAVE_VERSION = GDO_FEATURE_VERSIONS.saveSchema;

/** Version `0` is the pre-schema shape: the same sections, with no version stamp. */
export const GDO_SAVE_LEGACY_VERSION = 0;

/**
 * The storage key.
 *
 * Stable across schema versions on purpose: the version lives inside the document, and the
 * migration ladder is what upgrades a file in place. A key that carried the version would
 * make every migration unreachable — the reader would simply look in a different place and
 * start from nothing, which is exactly the failure mode a versioned save exists to avoid.
 */
export const GDO_SAVE_STORAGE_KEY = 'gdo:save';

/** Where a save this build cannot read is copied before it is reported. */
export const GDO_SAVE_BACKUP_KEY = 'gdo:save:unreadable';

/** The three sections, in the order the document is written. */
export const SAVE_SECTIONS = Object.freeze(['settings', 'discovery', 'progress']);

/** Every root field, in write order. Used by `encodeSave` so bytes are stable. */
export const SAVE_ROOT_FIELDS = Object.freeze(['schemaVersion', 'worldVersion', 'writtenAt', ...SAVE_SECTIONS]);

/** Modes `progress.lastMode` may name — the two runtimes a session can be in. */
export const SAVE_MODES = Object.freeze(['curated', 'coordinate']);

/**
 * The settings table.
 *
 * This table *is* the settings schema: `validateSave` walks it, `defaultSettings` builds from
 * it, and the migration ladder repairs against it. Adding a preference is one entry, and the
 * entry has to say why it exists — the same rule `CNT-01`'s field table follows for content.
 */
export const SAVE_SETTING_FIELDS = Object.freeze({
  soundEnabled: Object.freeze({
    type: 'boolean',
    fallback: true,
    description: 'Whether the curated runtime starts with its audio graph unmuted.',
  }),
  showDebug: Object.freeze({
    type: 'boolean',
    fallback: false,
    description: 'Whether the coordinate runtime opens its review panel on mount (F3).',
  }),
});

/**
 * Bounds.
 *
 * `bytes` is the whole encoded document; `discoveries` mirrors the journal's own capacity so
 * a save can never be asked to hold more than the journal that produced it; `states` and
 * `collectedPerState` mirror the content schema's authoring caps so progress can never name
 * more collectibles than a state pack is allowed to ship.
 */
export const GDO_SAVE_LIMITS = Object.freeze({
  bytes: 64 * 1024,
  discoveries: GEO_DISCOVERY_CAPACITY,
  states: 64,
  collectedPerState: STATE_CONTENT_LIMITS.collectiblesPerState,
  labelLength: 64,
});

/** Content-pack ids, and the state keys progress may use (`kerala`, `maharashtra`). */
export const SAVE_STATE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Collectible instance ids.
 *
 * The shape is `ItemManager`'s own — `${definition.id}:${index}` — and the collector's ids
 * contain hyphens (`vada-pav`), which the *content packs* do not (`vada_pav`). The two
 * vocabularies disagree today and the save stores the runtime's own: unifying them is
 * `CNT-02`/`CNT-04`'s job, where a recipe compiler has to reconcile pack ids with runtime
 * items anyway. It is validated here rather than trusted, because a save is the one input to
 * the runtime that a player can edit by hand.
 */
export const SAVE_INSTANCE_ID_PATTERN = /^[a-z][a-z0-9_-]*:[0-9]+$/;

/** Three decimal places: finer than any anchor the id quantisation can see (100 units). */
function round(value) {
  return Math.round(value * 1000) / 1000;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Encoded byte length of a string or a save, without a `TextEncoder` dependency. */
export function saveByteLength(value) {
  const text = typeof value === 'string' ? value : encodeSave(value);
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; index++; } else bytes += 3;
  }
  return bytes;
}

/** The declared settings at their fallbacks. */
export function defaultSettings(out = {}) {
  for (const [name, field] of Object.entries(SAVE_SETTING_FIELDS)) out[name] = field.fallback;
  return out;
}

/** An empty save at the current version. */
export function createEmptySave({ worldVersion = GDO_GENERATOR_VERSION, writtenAt = 0 } = {}) {
  return {
    schemaVersion: GDO_SAVE_VERSION,
    worldVersion,
    writtenAt,
    settings: defaultSettings(),
    discovery: { entries: [] },
    progress: { lastMode: null, lastCoordinate: null, states: {} },
  };
}

/** The version a document declares, `0` when it declares none, `null` when it is not an integer. */
export function detectSaveVersion(data) {
  if (!isPlainObject(data)) return null;
  if (!('schemaVersion' in data)) return GDO_SAVE_LEGACY_VERSION;
  return Number.isInteger(data.schemaVersion) ? data.schemaVersion : null;
}

/** Coerce one setting to its declared type where the pre-schema encoding is unambiguous. */
function coerceSetting(field, value) {
  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return { value, repaired: false };
    if (value === 0 || value === 1) return { value: value === 1, repaired: true };
    if (value === '0' || value === '1') return { value: value === '1', repaired: true };
    if (value === 'true' || value === 'false') return { value: value === 'true', repaired: true };
    return { value: undefined, repaired: false };
  }
  return { value: undefined, repaired: false };
}

/**
 * Version ladder: `SAVE_MIGRATIONS[n]` turns version `n` into version `n + 1`.
 *
 * Each step is pure and returns `{ data, notes }`, so the next format change is one entry
 * rather than a rewrite of the upgrade path — and so a step can be tested by calling it.
 */
const SAVE_MIGRATIONS = Object.freeze({
  [GDO_SAVE_LEGACY_VERSION]: {
    to: 1,
    description: 'Stamp the schema version, re-derive each discovery id from its own place, '
      + 'coerce and prune settings against the declared table, and dedupe collected ids.',
    migrate(data) {
      const notes = [];
      // Settings. A pre-schema writer may have called the section `options`; an undeclared key
      // is dropped rather than carried forward, because the table is the contract.
      const rawSettings = data.options !== undefined && data.settings === undefined ? data.options : data.settings;
      if (data.options !== undefined && data.settings === undefined) {
        notes.push('the pre-schema save called its settings section "options" — read as "settings"');
      }
      const settings = defaultSettings();
      if (isPlainObject(rawSettings)) {
        for (const [key, value] of Object.entries(rawSettings)) {
          const field = SAVE_SETTING_FIELDS[key];
          if (!field) {
            notes.push(`setting ${JSON.stringify(key)} is not declared by this build and was dropped`);
            continue;
          }
          const coerced = coerceSetting(field, value);
          if (coerced.value === undefined) {
            notes.push(`setting ${JSON.stringify(key)} was ${JSON.stringify(value)}, which is not a ${field.type} — the declared fallback ${JSON.stringify(field.fallback)} was used`);
            continue;
          }
          if (coerced.repaired) notes.push(`setting ${JSON.stringify(key)} was stored as ${JSON.stringify(value)} and now reads ${JSON.stringify(coerced.value)}`);
          settings[key] = coerced.value;
        }
      } else if (rawSettings !== undefined) {
        notes.push('the settings section was not an object and was replaced by the declared fallbacks');
      }

      // Discovery. The id is a pure function of the place (`GME-06`), so an id that disagrees
      // with its own anchor is stale rather than meaningful, and re-deriving it is repair
      // rather than invention. A pre-schema save may have stored the entries as a bare array.
      const rawEntries = Array.isArray(data.discovery) ? data.discovery
        : Array.isArray(data.discovered) ? data.discovered
          : isPlainObject(data.discovery) && Array.isArray(data.discovery.entries) ? data.discovery.entries
            : [];
      if (Array.isArray(data.discovered) && data.discovery === undefined) {
        notes.push('the pre-schema save called its discovery section "discovered" — read as "discovery"');
      }
      if (rawEntries.length > GDO_SAVE_LIMITS.discoveries) {
        notes.push(`${rawEntries.length} discovery entries exceed the journal's capacity of ${GDO_SAVE_LIMITS.discoveries} — the newest were kept`);
      }
      const entries = [];
      for (const entry of rawEntries.slice(-GDO_SAVE_LIMITS.discoveries)) {
        if (!isPlainObject(entry)) {
          notes.push('a discovery entry was not an object and was dropped');
          continue;
        }
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        const kind = typeof entry.kind === 'string' ? entry.kind.toLocaleLowerCase() : '';
        const x = Number(entry.x), z = Number(entry.z);
        let id;
        try {
          id = discoveryPlaceId(name, kind, x, z);
        } catch (error) {
          notes.push(`a discovery entry was dropped: ${error.message}`);
          continue;
        }
        if (typeof entry.id === 'string' && entry.id !== id) {
          notes.push(`${JSON.stringify(name)}: the stored id ${JSON.stringify(entry.id)} is not the id of its own place — re-derived as ${JSON.stringify(id)}`);
        }
        entries.push({
          id,
          name,
          kind,
          x: round(x),
          z: round(z),
          radius: Number.isFinite(entry.radius) ? entry.radius : discoveryKind(kind).radius,
          discoveredAt: Number.isFinite(entry.discoveredAt) ? entry.discoveredAt
            : Number.isFinite(entry.at) ? entry.at : 0,
        });
      }

      // Progress. A doubly-collected item is pure waste, so the list is deduped in place;
      // an id that is not an instance id cannot name a collectible and is dropped.
      const rawStates = isPlainObject(data.progress?.states) ? data.progress.states : {};
      const states = {};
      for (const [key, value] of Object.entries(rawStates)) {
        const stateId = String(key).toLocaleLowerCase();
        if (!SAVE_STATE_ID_PATTERN.test(stateId)) {
          notes.push(`progress for ${JSON.stringify(key)} is not keyed by a state pack id and was dropped`);
          continue;
        }
        const collected = [];
        for (const id of Array.isArray(value?.collected) ? value.collected : []) {
          if (typeof id !== 'string' || !SAVE_INSTANCE_ID_PATTERN.test(id)) {
            notes.push(`${JSON.stringify(id)} in ${stateId} is not a collectible instance id and was dropped`);
            continue;
          }
          if (collected.includes(id)) {
            notes.push(`${stateId}: ${JSON.stringify(id)} was listed twice and now counts once`);
            continue;
          }
          collected.push(id);
        }
        states[stateId] = {
          collected,
          score: Number.isFinite(value?.score) ? Math.max(0, value.score) : 0,
        };
      }
      // A pre-schema save with a bare collected list has no state to key by — the list may sit
      // under `progress` or at the root — and the honest reading is the one the shipped
      // collectibles use rather than dropping the player's progress on the floor.
      const bareCollected = Array.isArray(data.progress?.collected) ? data.progress.collected
        : Array.isArray(data.collected) ? data.collected : null;
      if (bareCollected && !Object.keys(states).length) {
        const collected = [];
        for (const id of bareCollected) {
          if (typeof id === 'string' && SAVE_INSTANCE_ID_PATTERN.test(id) && !collected.includes(id)) collected.push(id);
        }
        notes.push(`an unattributed collected list was read as ${JSON.stringify('curated')} progress`);
        states.curated = { collected, score: Number.isFinite(data.progress?.score) ? Math.max(0, data.progress.score) : 0 };
      }

      const lastCoordinate = isPlainObject(data.progress?.lastCoordinate)
        && Number.isFinite(data.progress.lastCoordinate.latitude)
        && Number.isFinite(data.progress.lastCoordinate.longitude)
        ? { latitude: round(data.progress.lastCoordinate.latitude), longitude: round(data.progress.lastCoordinate.longitude) }
        : null;
      const lastMode = SAVE_MODES.includes(data.progress?.lastMode) ? data.progress.lastMode : null;

      return {
        data: {
          schemaVersion: 1,
          worldVersion: typeof data.worldVersion === 'string' && data.worldVersion ? data.worldVersion : GDO_GENERATOR_VERSION,
          writtenAt: Number.isFinite(data.writtenAt) ? data.writtenAt : 0,
          settings,
          discovery: { entries },
          progress: { lastMode, lastCoordinate, states },
        },
        notes,
      };
    },
  },
});

/** The ladder, as data, for a tool or a contributor to print. */
export const SAVE_MIGRATION_STEPS = Object.freeze(Object.entries(SAVE_MIGRATIONS)
  .map(([from, step]) => Object.freeze({ from: Number(from), to: step.to, description: step.description }))
  .sort((left, right) => left.from - right.from));

/**
 * Bring a document up to the current schema version.
 *
 * Returns `{ data, from, to, migrated, notes, problems }`. A document already at the current
 * version is returned as the *same object reference* with `migrated: false`, so a caller can
 * detect the no-op cheaply — the same contract `migrateStateContent` uses. A document from
 * the future is refused rather than passed through: validating it against an older schema
 * would reject fields the writer legitimately used, and accepting it would let an unknown
 * shape reach a runtime.
 */
export function migrateSave(data) {
  const from = detectSaveVersion(data);
  if (from === null) {
    return {
      data, from, to: null, migrated: false, notes: [],
      problems: [isPlainObject(data) ? 'schemaVersion must be an integer when present' : 'a save must be an object'],
    };
  }
  if (from > GDO_SAVE_VERSION) {
    return {
      data, from, to: from, migrated: false, notes: [],
      problems: [`schemaVersion ${from} was authored for a newer save schema (this build reads up to ${GDO_SAVE_VERSION})`],
    };
  }
  if (from === GDO_SAVE_VERSION) return { data, from, to: from, migrated: false, notes: [], problems: [] };

  let current = data, version = from;
  const notes = [];
  while (version < GDO_SAVE_VERSION) {
    const step = SAVE_MIGRATIONS[version];
    if (!step) {
      return { data: current, from, to: version, migrated: notes.length > 0, notes, problems: [`no migration step from save schema v${version}`] };
    }
    const result = step.migrate(current);
    current = result.data;
    notes.push(...result.notes);
    version = step.to;
  }
  return { data: current, from, to: version, migrated: true, notes, problems: [] };
}

/**
 * Validate a save against the current schema.
 *
 * Two different things, kept apart the way `CNT-01` keeps them apart for content: **problems**
 * mean the document cannot be used as it stands (a wrong type, an id that is not the id of its
 * place, a section that is not an object, a bound exceeded), and **warnings** are advisory and
 * must never stop a load (a root key this build does not know, a save written by a different
 * generator version). A v1 document is held to the strict reading on purpose: no v1 writer can
 * produce these, so a v1 document that has them was edited or corrupted, and the repair path
 * for old documents is the ladder rather than a guess made at read time.
 */
export function validateSave(data, { allowLegacy = false } = {}) {
  const problems = [], warnings = [];
  if (!isPlainObject(data)) return { problems: ['a save must be an object'], warnings };
  const version = detectSaveVersion(data);
  if (version === null) problems.push('schemaVersion must be an integer when present');
  else if (version > GDO_SAVE_VERSION) problems.push(`schemaVersion ${version} was authored for a newer save schema (this build reads up to ${GDO_SAVE_VERSION})`);
  else if (version < GDO_SAVE_VERSION && !allowLegacy) {
    problems.push(`schemaVersion ${version} is a legacy save and must be migrated before it is used`);
  }
  for (const key of Object.keys(data)) {
    if (!SAVE_ROOT_FIELDS.includes(key)) warnings.push(`root key ${JSON.stringify(key)} is not part of the save schema and will not be written back`);
  }
  if (typeof data.worldVersion !== 'string' || !data.worldVersion) {
    problems.push('worldVersion must be a non-empty string');
  } else if (data.worldVersion !== GDO_GENERATOR_VERSION) {
    warnings.push(`this save was written by a different generator version (${data.worldVersion})`);
  }
  if (!Number.isFinite(data.writtenAt)) problems.push('writtenAt must be a finite timestamp');

  // Settings: every declared field, present and of its declared type, and nothing else.
  if (!isPlainObject(data.settings)) problems.push('settings must be an object');
  else {
    for (const [name, field] of Object.entries(SAVE_SETTING_FIELDS)) {
      const value = data.settings[name];
      if (value === undefined) problems.push(`setting ${JSON.stringify(name)} is missing`);
      else if (field.type === 'boolean' && typeof value !== 'boolean') {
        problems.push(`setting ${JSON.stringify(name)} must be a boolean, got ${JSON.stringify(value)}`);
      }
    }
    for (const key of Object.keys(data.settings)) {
      if (!Object.hasOwn(SAVE_SETTING_FIELDS, key)) problems.push(`setting ${JSON.stringify(key)} is not declared by this build`);
    }
  }

  // Discovery: bounded, and every id the id of its own place.
  const entries = data.discovery?.entries;
  if (!isPlainObject(data.discovery) || !Array.isArray(entries)) problems.push('discovery.entries must be an array');
  else {
    if (entries.length > GDO_SAVE_LIMITS.discoveries) {
      problems.push(`${entries.length} discovery entries exceed the journal capacity of ${GDO_SAVE_LIMITS.discoveries}`);
    }
    const seen = new Set();
    entries.forEach((entry, index) => {
      const where = `discovery.entries[${index}]`;
      if (!isPlainObject(entry)) { problems.push(`${where} must be an object`); return; }
      if (typeof entry.name !== 'string' || !entry.name.trim()) problems.push(`${where}.name must be a non-empty string`);
      else if (entry.name.length > GDO_SAVE_LIMITS.labelLength) problems.push(`${where}.name is longer than ${GDO_SAVE_LIMITS.labelLength} characters`);
      if (typeof entry.kind !== 'string' || !entry.kind.trim()) problems.push(`${where}.kind must be a non-empty string`);
      if (!Number.isFinite(entry.x) || !Number.isFinite(entry.z)) problems.push(`${where} must carry finite coordinates`);
      if (!Number.isFinite(entry.radius) || entry.radius <= 0) problems.push(`${where}.radius must be a positive number`);
      if (!Number.isFinite(entry.discoveredAt)) problems.push(`${where}.discoveredAt must be a finite reading`);
      if (typeof entry.name === 'string' && typeof entry.kind === 'string' && Number.isFinite(entry.x) && Number.isFinite(entry.z)) {
        let derived = null;
        try {
          derived = discoveryPlaceId(entry.name, entry.kind, entry.x, entry.z);
        } catch { /* reported by the field checks above */ }
        if (derived !== null && entry.id !== derived) {
          problems.push(`${where}.id is not the id of its own place (expected ${derived})`);
        }
        if (derived !== null && seen.has(derived)) problems.push(`${where} repeats a place already in the save`);
        if (derived !== null) seen.add(derived);
      }
    });
  }

  // Progress: bounded, keyed by content-pack ids, naming instance ids only.
  const progress = data.progress;
  if (!isPlainObject(progress)) problems.push('progress must be an object');
  else {
    if (!(progress.lastMode === null || SAVE_MODES.includes(progress.lastMode))) {
      problems.push(`progress.lastMode must be null or one of ${SAVE_MODES.join(', ')}`);
    }
    const where = progress.lastCoordinate;
    if (!(where === null || (isPlainObject(where) && Number.isFinite(where.latitude) && Number.isFinite(where.longitude)))) {
      problems.push('progress.lastCoordinate must be null or a finite latitude/longitude pair');
    }
    if (!isPlainObject(progress.states)) problems.push('progress.states must be an object');
    else {
      const keys = Object.keys(progress.states);
      if (keys.length > GDO_SAVE_LIMITS.states) problems.push(`${keys.length} state progress records exceed the ceiling of ${GDO_SAVE_LIMITS.states}`);
      for (const key of keys) {
        const record = progress.states[key];
        if (!SAVE_STATE_ID_PATTERN.test(key)) { problems.push(`progress.states key ${JSON.stringify(key)} is not a state pack id`); continue; }
        if (!isPlainObject(record)) { problems.push(`progress.states.${key} must be an object`); continue; }
        if (!Array.isArray(record.collected)) { problems.push(`progress.states.${key}.collected must be an array`); continue; }
        if (record.collected.length > GDO_SAVE_LIMITS.collectedPerState) {
          problems.push(`progress.states.${key} holds ${record.collected.length} collectibles against a ceiling of ${GDO_SAVE_LIMITS.collectedPerState}`);
        }
        const unique = new Set();
        for (const id of record.collected) {
          if (typeof id !== 'string' || !SAVE_INSTANCE_ID_PATTERN.test(id)) problems.push(`progress.states.${key}: ${JSON.stringify(id)} is not a collectible instance id`);
          else if (unique.has(id)) problems.push(`progress.states.${key}: ${JSON.stringify(id)} is listed twice`);
          else unique.add(id);
        }
        if (!Number.isFinite(record.score) || record.score < 0) problems.push(`progress.states.${key}.score must be a non-negative number`);
      }
    }
  }
  return { problems, warnings };
}

/**
 * Rebuild a save in schema order with every number rounded.
 *
 * Ordering and rounding are both load-bearing for the byte-stability claim: two saves that
 * describe the same state have to encode to the same string, or "written once, only when it
 * changed" cannot be checked and a diff of two saves means nothing.
 */
export function canonicalSave(save) {
  const settings = {};
  for (const name of Object.keys(SAVE_SETTING_FIELDS)) settings[name] = save?.settings?.[name] ?? SAVE_SETTING_FIELDS[name].fallback;
  const entries = (Array.isArray(save?.discovery?.entries) ? save.discovery.entries : []).map(entry => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    x: round(entry.x),
    z: round(entry.z),
    radius: round(entry.radius),
    discoveredAt: round(entry.discoveredAt),
  }));
  const states = {};
  for (const key of Object.keys(save?.progress?.states ?? {}).sort()) {
    const record = save.progress.states[key] ?? {};
    states[key] = { collected: [...(record.collected ?? [])], score: round(record.score ?? 0) };
  }
  const lastCoordinate = save?.progress?.lastCoordinate
    ? { latitude: round(save.progress.lastCoordinate.latitude), longitude: round(save.progress.lastCoordinate.longitude) }
    : null;
  return {
    schemaVersion: GDO_SAVE_VERSION,
    worldVersion: save?.worldVersion ?? GDO_GENERATOR_VERSION,
    writtenAt: round(save?.writtenAt ?? 0),
    settings,
    discovery: { entries },
    progress: { lastMode: save?.progress?.lastMode ?? null, lastCoordinate, states },
  };
}

/** The canonical bytes of a save — the document exactly as it is written to storage. */
export function encodeSave(save) {
  return JSON.stringify(canonicalSave(save));
}

/**
 * Parse stored text into a save.
 *
 * Never throws: a caller that has to handle a corrupt profile should not need a `try`, and
 * every failure mode here is something the player has to be told about rather than an
 * exception the runtime drops on the floor. `save` is `null` whenever `problems` is not empty.
 */
export function decodeSave(text) {
  const report = { save: null, from: null, to: null, migrated: false, notes: [], warnings: [], problems: [], bytes: 0 };
  if (typeof text !== 'string' || !text.trim()) {
    report.problems.push('the stored save is not text');
    return report;
  }
  report.bytes = saveByteLength(text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    report.problems.push(`the stored save is not valid JSON: ${error.message}`);
    return report;
  }
  const migration = migrateSave(parsed);
  report.from = migration.from;
  report.to = migration.to;
  report.migrated = migration.migrated;
  report.notes = migration.notes;
  if (migration.problems.length) {
    report.problems = migration.problems;
    return report;
  }
  const validation = validateSave(migration.data);
  report.warnings = validation.warnings;
  report.problems = validation.problems;
  if (validation.problems.length) return report;
  report.save = migration.data;
  return report;
}

/**
 * Bring a save under the byte ceiling by dropping the *oldest* records first.
 *
 * Dropping rather than refusing is the only answer that keeps a player playing: a runtime that
 * refused to save because the document got large would lose everything instead of the least
 * valuable part of it, and the oldest discovery is by construction the one the journal itself
 * would evict first. Every drop is reported so the caller can say what happened instead of
 * silently shrinking.
 */
export function fitSaveToLimits(save, { limits = GDO_SAVE_LIMITS } = {}) {
  const candidate = canonicalSave(save);
  const notes = [];
  let droppedDiscoveries = 0, droppedCollected = 0;
  const size = () => saveByteLength(encodeSave(candidate));
  while (size() > limits.bytes) {
    if (candidate.discovery.entries.length > 1) {
      // Oldest first, and the id breaks a tie so the choice does not depend on array order.
      let worst = 0;
      for (let index = 1; index < candidate.discovery.entries.length; index++) {
        const entry = candidate.discovery.entries[index], held = candidate.discovery.entries[worst];
        if (entry.discoveredAt < held.discoveredAt || (entry.discoveredAt === held.discoveredAt && entry.id < held.id)) worst = index;
      }
      const [removed] = candidate.discovery.entries.splice(worst, 1);
      droppedDiscoveries++;
      notes.push(`dropped the oldest discovery ${JSON.stringify(removed.name)} to stay inside the ${limits.bytes} byte ceiling`);
      continue;
    }
    // Then the oldest collectible, from the state that holds the most.
    let heaviest = null;
    for (const [key, record] of Object.entries(candidate.progress.states)) {
      if (!record.collected.length) continue;
      if (!heaviest || record.collected.length > candidate.progress.states[heaviest].collected.length) heaviest = key;
    }
    if (heaviest === null) {
      notes.push(`the save cannot be brought under the ${limits.bytes} byte ceiling and was left as it is`);
      break;
    }
    const removed = candidate.progress.states[heaviest].collected.shift();
    droppedCollected++;
    notes.push(`dropped collected ${JSON.stringify(removed)} from ${heaviest} to stay inside the ${limits.bytes} byte ceiling`);
  }
  return { save: candidate, notes, droppedDiscoveries, droppedCollected, bytes: saveByteLength(encodeSave(candidate)) };
}

/**
 * The discovery section of a save, read off a live journal.
 *
 * `journal.list()` is oldest-first, and the journal is already capped at the same capacity the
 * save is, so the normal path copies everything and the `dropped` count exists for a journal
 * built with a larger capacity than the save allows.
 */
export function captureDiscovery(journal, { limits = GDO_SAVE_LIMITS } = {}) {
  const rows = journal.list([]);
  const kept = rows.length > limits.discoveries ? rows.slice(-limits.discoveries) : rows;
  return {
    entries: kept.map(row => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      x: round(row.x),
      z: round(row.z),
      radius: Number.isFinite(row.radius) ? row.radius : discoveryKind(row.kind).radius,
      discoveredAt: row.discoveredAt,
    })),
    dropped: rows.length - kept.length,
  };
}

/**
 * Put a stored discovery section back into a journal.
 *
 * This is where "deterministic place IDs" stops being a property of the id function and
 * becomes a property of the product: an entry whose stored id is not the id of its own place
 * is **refused**, not trusted and not repaired. A save is editable by hand, and the one thing a
 * journal must never do is hold a place the world could not have produced.
 */
export function restoreDiscovery(journal, section, { limits = GDO_SAVE_LIMITS } = {}) {
  const report = { restored: 0, dropped: 0, problems: [], rebased: false };
  const entries = Array.isArray(section?.entries) ? section.entries : [];
  // A saved `discoveredAt` is an *order* from another session's clock, not a time: every page
  // load restarts the clock the journal reads. The section is therefore rebased into the live
  // clock's frame, ascending in the order the save recorded and inside a millisecond just above
  // the reading the journal is on now. That keeps the three properties a restore needs: the
  // journal's own clock does not move (so the next frame is not a backwards clock and `update()`
  // does not refuse it), the restored order is the saved order, and anything the player finds
  // after the restore reads later still — while a restore can never displace a place the session
  // is already holding (the container is checked before the reading is ever looked at).
  const base = Number.isFinite(journal?.clock) ? journal.clock : 0;
  const restoredReadings = new Map();
  entries.forEach((entry, index) => {
    if (entry && typeof entry === 'object') restoredReadings.set(entry, base + (index + 1) * 1e-3);
  });
  if (entries.length && entries.some((entry, index) => entry?.discoveredAt !== base + (index + 1) * 1e-3)) {
    report.rebased = true;
  }
  for (const entry of entries) {
    if (report.restored >= limits.discoveries) {
      report.dropped++;
      report.problems.push(`the save holds more than ${limits.discoveries} discoveries; the surplus was dropped`);
      continue;
    }
    let derived = null;
    try {
      derived = discoveryPlaceId(entry?.name, entry?.kind, entry?.x, entry?.z);
    } catch (error) {
      report.dropped++;
      report.problems.push(`a stored discovery was dropped: ${error.message}`);
      continue;
    }
    if (entry?.id !== derived) {
      report.dropped++;
      report.problems.push(`a stored discovery ${JSON.stringify(entry?.name ?? null)} carries ${JSON.stringify(entry?.id ?? null)}, which is not the id of its own place (${derived}) — it was not restored`);
      continue;
    }
    const reading = restoredReadings.get(entry);
    if (journal.restore(reading === undefined ? entry : { ...entry, discoveredAt: reading })) report.restored++;
    else report.dropped++;
  }
  return report;
}

/** The progress record for one state pack, built from collected instance ids. */
export function captureProgressState(collectedIds, { score = 0, limits = GDO_SAVE_LIMITS } = {}) {
  const collected = [];
  for (const id of Array.isArray(collectedIds) ? collectedIds : []) {
    if (typeof id !== 'string' || !SAVE_INSTANCE_ID_PATTERN.test(id) || collected.includes(id)) continue;
    if (collected.length >= limits.collectedPerState) break;
    collected.push(id);
  }
  return { collected, score: Number.isFinite(score) ? Math.max(0, score) : 0 };
}

/** The whole progress section, from the pieces a runtime holds. */
export function captureProgress({ lastMode = null, lastCoordinate = null, states = {} } = {}, { limits = GDO_SAVE_LIMITS } = {}) {
  const out = {};
  for (const [key, record] of Object.entries(states)) {
    if (!SAVE_STATE_ID_PATTERN.test(key) || Object.keys(out).length >= limits.states) continue;
    out[key] = captureProgressState(record?.collected, { score: record?.score, limits });
  }
  return {
    lastMode: SAVE_MODES.includes(lastMode) ? lastMode : null,
    lastCoordinate: isPlainObject(lastCoordinate) && Number.isFinite(lastCoordinate.latitude) && Number.isFinite(lastCoordinate.longitude)
      ? { latitude: round(lastCoordinate.latitude), longitude: round(lastCoordinate.longitude) }
      : null,
    states: out,
  };
}

/** Every collected instance id in a progress section, across states, in state-key order. */
export function collectedInstances(progress) {
  const out = [];
  for (const key of Object.keys(progress?.states ?? {}).sort()) {
    for (const id of progress.states[key]?.collected ?? []) out.push(id);
  }
  return out;
}

/* ---------------------------------------------------------------------------------------
 * Storage adapters
 *
 * Three methods, all synchronous, all total: `getItem`, `setItem`, `removeItem`. A store that
 * cannot reach storage at all is represented by `null` rather than by a throwing object, so the
 * unavailable case is a value the runtime can branch on instead of an exception it has to catch
 * around every call.
 * ------------------------------------------------------------------------------------- */

/** `localStorage` if this browser will actually let us write to it, otherwise `null`. */
export function createBrowserStorage(scope = globalThis) {
  try {
    const storage = scope?.localStorage;
    if (!storage) return null;
    const probe = `${GDO_SAVE_STORAGE_KEY}:probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    // Private mode, a sandboxed frame, a storage quota of zero: all the same answer here.
    return null;
  }
}

/** An in-memory adapter with the same shape, for Node and for a gate that wants its own. */
export function createMemoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    get keys() { return [...map.keys()]; },
  };
}

/**
 * The save store.
 *
 * `read()` loads once, `update()` mutates and marks dirty, `tick()` writes at most once per
 * interval and only when the canonical bytes moved, and `flush()` writes on the way out
 * (a page being closed, a runtime being disposed). Nothing here throws at a caller: every
 * failure becomes a counter, a `lastProblem` string, and — for a document this build cannot
 * read — a copy under the backup key.
 */
export class SaveStore {
  /**
   * @param {object} [options]
   * @param {object|null} [options.storage] adapter; `null` means storage is unavailable
   * @param {string} [options.key] storage key
   * @param {number} [options.intervalMs] minimum wall-clock spacing between writes
   * @param {() => number} [options.clock] wall clock, injectable so a gate can drive it
   * @param {object} [options.save] the document to start from
   */
  constructor({
    storage = createBrowserStorage(),
    key = GDO_SAVE_STORAGE_KEY,
    backupKey = GDO_SAVE_BACKUP_KEY,
    intervalMs = 1000,
    limits = GDO_SAVE_LIMITS,
    clock = () => Date.now(),
    save = createEmptySave(),
    onProblem = null,
  } = {}) {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new RangeError(`Save interval must be finite and non-negative, received ${intervalMs}`);
    }
    this.storage = storage ?? null;
    this.key = key;
    this.backupKey = backupKey;
    this.intervalMs = intervalMs;
    this.limits = limits;
    this.clock = clock;
    this.onProblem = onProblem;
    this.save = save;
    this.dirty = false;
    this.lastWriteAt = -Infinity;
    this.lastPayloadKey = null;
    this.lastReport = null;
    this.counters = {
      reads: 0, writes: 0, unchangedSkips: 0, coalesced: 0, rejected: 0, storageErrors: 0, writesViaFlush: 0,
    };
    this.lastProblem = null;
    /** Bytes of the document currently in storage, or of the last successful write. */
    this.bytes = 0;
  }

  get available() { return this.storage !== null; }

  /**
   * Load the stored document.
   *
   * Returns a report rather than the save, because every caller so far wants to say *something*
   * about what it found: the runtime reports a migration, the landing reports a problem, and the
   * gate asserts on both.
   */
  read() {
    this.counters.reads++;
    const report = { loaded: false, from: null, to: null, migrated: false, notes: [], warnings: [], problems: [], bytes: 0, kept: false };
    if (!this.storage) {
      report.problems.push('storage is unavailable, so there is nothing to read');
      return report;
    }
    let text = null;
    try {
      text = this.storage.getItem(this.key);
    } catch (error) {
      this.counters.storageErrors++;
      this.lastProblem = `storage read failed: ${error.message}`;
      report.problems.push(this.lastProblem);
      return report;
    }
    if (text === null) return report;             // no session has been saved yet: not a problem
    const decoded = decodeSave(text);
    Object.assign(report, {
      from: decoded.from, to: decoded.to, migrated: decoded.migrated,
      notes: decoded.notes, warnings: decoded.warnings, bytes: decoded.bytes,
    });
    if (decoded.problems.length) {
      // Rule 2: never destroy what you do not understand. The text stays where it is, a copy
      // goes to the backup key so a support path can recover it, and the runtime carries on
      // with an empty document rather than with a half-read one.
      this.counters.rejected++;
      this.lastProblem = decoded.problems[0];
      report.problems = decoded.problems;
      report.kept = this._backup(text);
      this.onProblem?.(this.lastProblem, report);
      return report;
    }
    // Assigned *into* the document rather than replacing it, so `store.save` is the same
    // object for the store's whole lifetime and a runtime that captured it still sees the load.
    Object.assign(this.save, decoded.save);
    this.bytes = decoded.bytes;
    // `lastPayloadKey` means "the bytes that are in storage", so it may only be seeded when
    // storage already holds *this* document. After a migration it holds the pre-migration text,
    // and seeding the key anyway would make the byte-level dedupe cancel the write-back below —
    // the file would never be upgraded and the ladder would be dead code in the product. Found
    // by the Node tier, which asserts that the second session reads a v1 document.
    this.lastPayloadKey = decoded.migrated ? null : encodeSave({ ...decoded.save, writtenAt: 0 });
    if (decoded.migrated) {
      // A legacy document is upgraded *in place*: mark dirty so the next tick rewrites it at
      // the current version, which is what keeps the ladder load-bearing rather than optional.
      this.dirty = true;
    }
    report.loaded = true;
    return report;
  }

  /** Copy unreadable text aside. Returns whether the copy succeeded. */
  _backup(text) {
    try {
      this.storage.setItem(this.backupKey, text);
      return true;
    } catch (error) {
      this.counters.storageErrors++;
      this.lastProblem = `storage backup failed: ${error.message}`;
      return false;
    }
  }

  /** Mutate the document through a function, and mark it for writing. */
  update(mutator) {
    const result = mutator(this.save);
    this.markDirty();
    return result;
  }

  markDirty() { this.dirty = true; }

  /**
   * Write the document if it is dirty and the interval has elapsed.
   *
   * This is what the frame loop calls. It is deliberately cheap when nothing changed: the
   * canonical payload check means a still world costs a stringify-free comparison of the
   * previous payload key, and a runtime that calls this sixty times a second writes nothing.
   */
  tick(now = this.clock()) {
    if (!this.dirty) { this.counters.unchangedSkips++; return false; }
    if (now - this.lastWriteAt < this.intervalMs) { this.counters.coalesced++; return false; }
    return this.write({ now });
  }

  /** Write the document now, whatever the interval says. */
  flush(now = this.clock()) {
    if (!this.dirty) { this.counters.unchangedSkips++; return false; }
    this.counters.writesViaFlush++;
    return this.write({ now });
  }

  /**
   * Serialise, validate and persist.
   *
   * Returns whether the storage call was made. A refusal (the candidate does not validate, or
   * storage threw) leaves `dirty` set, so the next tick tries again rather than dropping the
   * change on the floor.
   */
  write({ now = this.clock(), force = false } = {}) {
    if (!this.storage) {
      this.dirty = false;
      this.lastProblem = 'storage is unavailable, so nothing was written';
      return false;
    }
    const candidate = { ...this.save, worldVersion: this.save.worldVersion ?? GDO_GENERATOR_VERSION, writtenAt: now };
    const validation = validateSave(candidate);
    if (validation.problems.length) {
      this.counters.rejected++;
      this.lastProblem = validation.problems[0];
      this.onProblem?.(this.lastProblem, validation);
      return false;
    }
    const fitted = fitSaveToLimits(candidate, { limits: this.limits });
    const text = encodeSave(fitted.save);
    const payloadKey = encodeSave({ ...fitted.save, writtenAt: 0 });
    if (!force && payloadKey === this.lastPayloadKey && !fitted.droppedDiscoveries && !fitted.droppedCollected) {
      // Assign into the document, never replace it: a runtime holds `store.save` and a gate
      // compares the same reference across a write, exactly as `ENV-02` requires of its state
      // graph. The skipped write is the *storage* call, not the document's own identity.
      this.counters.unchangedSkips++;
      Object.assign(this.save, fitted.save);
      this.save.writtenAt = now;
      this.dirty = false;
      return false;
    }
    try {
      this.storage.setItem(this.key, text);
    } catch (error) {
      // A quota error keeps the change dirty: the next tick retries, and the runtime keeps
      // playing rather than losing the session to a full disk.
      this.counters.storageErrors++;
      this.lastProblem = `storage write failed: ${error.message}`;
      this.onProblem?.(this.lastProblem, null);
      return false;
    }
    Object.assign(this.save, fitted.save);
    this.save.writtenAt = now;
    this.lastPayloadKey = payloadKey;
    this.bytes = saveByteLength(text);
    this.lastWriteAt = now;
    this.dirty = false;
    this.counters.writes++;
    this.lastReport = { notes: fitted.notes, warnings: validation.warnings, bytes: this.bytes };
    return true;
  }

  /** Remove the stored document, including any backup, and start from an empty save. */
  clear() {
    if (!this.storage) return false;
    this.counters.storageErrors += 0;
    try {
      this.storage.removeItem(this.key);
      this.storage.removeItem(this.backupKey);
    } catch (error) {
      this.counters.storageErrors++;
      this.lastProblem = `storage clear failed: ${error.message}`;
      return false;
    }
    this.save = createEmptySave();
    this.dirty = false;
    this.lastPayloadKey = null;
    this.bytes = 0;
    return true;
  }

  /** The report the review panel and the gate read. */
  diagnostics() {
    const progress = this.save.progress ?? { states: {} };
    let collected = 0;
    for (const record of Object.values(progress.states ?? {})) collected += record?.collected?.length ?? 0;
    return {
      version: this.save.schemaVersion ?? null,
      worldVersion: this.save.worldVersion ?? null,
      available: this.available,
      key: this.key,
      storage: this.available ? 'local' : 'unavailable',
      intervalMs: this.intervalMs,
      discoveries: this.save.discovery?.entries?.length ?? 0,
      capacity: this.limits.discoveries,
      states: Object.keys(progress.states ?? {}).length,
      collected,
      modes: progress.lastMode,
      bytes: this.bytes,
      dirty: this.dirty,
      lastWriteAt: Number.isFinite(this.lastWriteAt) && this.lastWriteAt > -Infinity ? this.lastWriteAt : null,
      lastProblem: this.lastProblem,
      migrations: this.lastReport?.notes ?? [],
      warnings: this.lastReport?.warnings ?? [],
      ...this.counters,
    };
  }
}
