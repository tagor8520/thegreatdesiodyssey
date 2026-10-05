/**
 * `CNT-01` — the versioned state-content schema.
 *
 * The project advertises a low-code contribution path: a state or landmark is
 * authored as JSON and the runtime builds it. Until now that path had **no
 * contract at all** — `public/content/states/*.json` were experimental files with
 * no version stamp, no validation and no migration, so a typo produced a silently
 * broken vignette rather than a message, and a change to the shape of the format
 * would have made every existing file quietly wrong.
 *
 * This module is that contract, in three separable parts:
 *
 * 1. **Schema.** `STATE_CONTENT_FIELDS` is a declarative table of every field the
 *    format admits — its type, whether it is required, and why it exists. The
 *    validator walks the table, so the table *is* the schema rather than a comment
 *    next to hand-written checks, and `describeStateContentSchema()` can print it
 *    for a tool or a contributor.
 * 2. **Validation.** `validateStateContent()` reports two different things and
 *    keeps them apart: **errors**, which mean the content cannot be rendered or
 *    looked up correctly, and **warnings**, which are advisory and must never
 *    block a build. `validateStateContent` in strict mode refuses un-migrated
 *    legacy content, which is what makes migration load-bearing instead of
 *    optional.
 * 3. **Migration.** `migrateStateContent()` walks a strictly increasing ladder of
 *    step functions from whatever version a file declares — version `0` is the
 *    legacy shape that predates this module — up to the current version, and
 *    reports what it changed. Migration repairs what is unambiguously broken in
 *    old files (coincident voxels z-fight and are pure waste; a colour's letter
 *    case splits the material cache) and refuses to invent what it cannot know.
 *
 * The consumers are: the Node gate (`ContentSchema.test.js`), which validates the
 * **shipped** files read from disk, and `StateManager`, the loader that is the only
 * code in the project that reads this content. `NET-01` reuses the ladder for
 * save-file migration, which is why the ladder is generic and the schema is not.
 *
 * Deliberately **not** here: compiling content into runtime geometry (`CNT-02`),
 * the authoring/preview tool (`CNT-03`), and the packs themselves (`CNT-04`).
 */

import { GDO_FEATURE_VERSIONS, featureNamespace, featureAvailable } from './FeatureVersions.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

/** The version this module validates and produces. Mirrors the feature registry. */
export const STATE_CONTENT_SCHEMA_VERSION = 1;

/** Version `0` is the experimental shape: the same fields, with no version stamp. */
export const STATE_CONTENT_LEGACY_VERSION = 0;

/**
 * Authoring caps.
 *
 * These are **per-file authoring limits**, not runtime render budgets: the runtime
 * ceilings live in `GDO_LOW_PROFILE_BUDGETS`, and the two are deliberately not
 * independent — `voxelsPerState` is *derived* from the shared visible-triangle
 * ceiling so a contributed pack cannot claim a second allowance on top of it
 * (roadmap §4 invariant 10). Every limit here exists to stop a contributed file
 * from doing unbounded work, and each is far above what the shipped packs use
 * (66 voxels across both files, 18 in the largest single collectible).
 */
export const STATE_CONTENT_LIMITS = Object.freeze({
  /** Collectibles in one state pack. */
  collectiblesPerState: 64,
  /** Voxels in one collectible — generous headroom over the largest shipped item (18). */
  voxelsPerCollectible: 512,
  /**
   * Voxels in one state pack. Each voxel is an un-instanced box, so it costs
   * exactly 12 triangles; the derivation below reserves half of the low-profile
   * visible-triangle ceiling for authored content and leaves the other half to the
   * world. Changing the box cost or the ceiling must change this number, and
   * `ContentSchema.test.js` asserts the arithmetic rather than the literal.
   */
  voxelsPerState: Math.floor((GDO_LOW_PROFILE_BUDGETS.visibleTriangles * 0.5) / 12),
  /** A buff that outlasts a minute is a gameplay decision, not a pickup effect. */
  buffDurationMs: 60_000,
  /** A multiplier is a nudge; ×10 is the cap before the label reads as a bug. */
  buffMultiplier: 10,
  /** An icon is one glyph (plus variation selectors); a sentence is a mistake. */
  iconCodePoints: 8,
  /** Names and descriptions are HUD strings, not paragraphs. */
  labelLength: 64,
  descriptionLength: 240,
  /**
   * Two collectibles closer than the runtime's pickup radius (1.8 units in
   * `StateManager`) cannot be collected separately, so the pack cannot mean what
   * it says. Warned, not rejected: the author may intend a cluster.
   */
  spawnSeparation: 1.8,
});

/** The buff types the runtime knows how to label (`StateManager._buffLabel`). */
export const STATE_CONTENT_BUFF_TYPES = Object.freeze(['speed', 'jump', 'shield', 'stamina', 'focus']);

/** `banana_chips`, `vada_pav` — lowercase, digits and underscores; usable as a key. */
const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
/** Six-digit hex only. Three-digit hex would put `#fff` and `#ffffff` in the material cache twice. */
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export class StateContentError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'StateContentError';
    this.problems = [...problems];
  }
}

/**
 * Field type handlers.
 *
 * Each returns a list of problems; an empty list means the value satisfies the
 * field. Handlers never throw, so one malformed field cannot hide the rest of the
 * file's problems from the author.
 */
const FIELD_TYPES = Object.freeze({
  integer: (value, label) => (Number.isInteger(value) ? [] : [`${label} must be an integer, got ${JSON.stringify(value)}`]),
  string: (value, label) => (typeof value === 'string' && value.trim().length > 0
    ? [] : [`${label} must be a non-empty string, got ${JSON.stringify(value)}`]),
  id: (value, label) => {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
      return [`${label} must match ${ID_PATTERN} (lowercase letters, digits, underscores), got ${JSON.stringify(value)}`];
    }
    return [];
  },
  color: (value, label) => (typeof value === 'string' && COLOR_PATTERN.test(value)
    ? [] : [`${label} must be a six-digit hex colour like "#d4a017", got ${JSON.stringify(value)}`]),
  vec3: (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${label} must be an object with x, y and z`];
    const problems = [];
    for (const axis of ['x', 'y', 'z']) {
      if (!Number.isFinite(value[axis])) problems.push(`${label}.${axis} must be a finite number, got ${JSON.stringify(value[axis])}`);
    }
    return problems;
  },
  positiveNumber: (value, label) => (!Number.isFinite(value) || value <= 0
    ? [`${label} must be a positive finite number, got ${JSON.stringify(value)}`] : []),
  stringList: (value, label) => (Array.isArray(value) ? [] : [`${label} must be an array of strings`]),
});

/**
 * The schema itself, grouped by the level it applies to.
 *
 * `description` is written for a contributor reading the schema in a tool
 * (`CNT-03`) as much as for a maintainer reading this file.
 */
export const STATE_CONTENT_FIELDS = Object.freeze({
  root: Object.freeze([
    { name: 'schemaVersion', type: 'integer', required: true, description: 'Version of this format the file is written against.' },
    { name: 'stateId', type: 'id', required: true, description: 'Stable key, and it must match the file name so a rename cannot go half-done.' },
    { name: 'stateName', type: 'string', required: true, description: 'Display name shown in the HUD state label.' },
    { name: 'bgColor', type: 'color', required: false, description: 'Scene background. Declared and validated; the loader does not apply it yet.' },
    { name: 'fogColor', type: 'color', required: false, description: 'Fog colour. Declared and validated; the loader does not apply it yet.' },
    { name: 'ambientColor', type: 'color', required: false, description: 'Ambient light colour. Declared and validated; the loader does not apply it yet.' },
    { name: 'bounds', type: 'vec3list', required: false, description: 'Playable extent the spawns must sit inside, as { min: {x,y,z}, max: {x,y,z} }.' },
    { name: 'provenance', type: 'provenance', required: false, description: 'Contributor credit, review state and content warnings for the contribution flow.' },
    { name: 'collectibles', type: 'collectible[]', required: true, description: 'The pickup set this pack spawns.' },
  ]),
  collectible: Object.freeze([
    { name: 'id', type: 'id', required: true, description: 'Stable key, unique within the pack; the inventory stores it.' },
    { name: 'name', type: 'string', required: true, description: 'Pickup label.' },
    { name: 'description', type: 'string', required: true, description: 'One-line flavour text. Numbers here are checked against the buff below.' },
    { name: 'icon', type: 'string', required: true, description: 'Single glyph shown in the hotbar and the pickup banner.' },
    { name: 'buff', type: 'buff', required: true, description: 'Effect applied on pickup.' },
    { name: 'spawnPosition', type: 'vec3', required: true, description: 'World position the vignette is anchored to.' },
    { name: 'voxels', type: 'voxel[]', required: true, description: 'Voxel list: [x, y, z, hexColor] tuples, integers, no repeated coordinates.' },
  ]),
  buff: Object.freeze([
    { name: 'type', type: 'enum', required: true, description: `One of ${STATE_CONTENT_BUFF_TYPES.join(', ')}.` },
    { name: 'multiplier', type: 'positiveNumber', required: true, description: 'Scale applied by the effect; 1 means "no scaling".' },
    { name: 'duration', type: 'integer', required: true, description: 'Effect lifetime in milliseconds.' },
  ]),
});

/** A printable summary of the schema, for a tool or a contributor. */
export function describeStateContentSchema() {
  return {
    version: STATE_CONTENT_SCHEMA_VERSION,
    namespace: featureNamespace('contentSchema'),
    legacyVersion: STATE_CONTENT_LEGACY_VERSION,
    buffTypes: [...STATE_CONTENT_BUFF_TYPES],
    limits: { ...STATE_CONTENT_LIMITS },
    fields: Object.fromEntries(Object.entries(STATE_CONTENT_FIELDS).map(([level, fields]) => [
      level,
      fields.map(field => ({ ...field })),
    ])),
    /** The derivation a reader should not have to reverse-engineer. */
    voxelsPerStateDerivation: `floor(GDO_LOW_PROFILE_BUDGETS.visibleTriangles * 0.5 / 12) = floor(${GDO_LOW_PROFILE_BUDGETS.visibleTriangles} * 0.5 / 12) = ${STATE_CONTENT_LIMITS.voxelsPerState}`,
  };
}

function checkFields(owner, fields, level, problems, label) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    problems.push(`${label} must be an object`);
    return;
  }
  for (const field of fields) {
    // `schemaVersion` is reported by the version check, which can say *why* it is
    // wrong (legacy, malformed, or from the future) rather than only that it is
    // absent. Repeating it here would put the same problem in the list twice.
    if (field.name === 'schemaVersion') continue;
    const value = owner[field.name];
    const fieldLabel = `${label}.${field.name}`;
    if (value === undefined || value === null) {
      if (field.required) problems.push(`${fieldLabel} is required (${field.description})`);
      continue;
    }
    // Two schema-declared shapes are richer than a scalar handler and are checked
    // by their own functions below, so the table can stay declarative.
    if (field.type === 'buff' || field.type === 'collectible[]' || field.type === 'voxel[]') continue;
    if (field.type === 'vec3list') continue;
    if (field.type === 'provenance') continue;
    if (field.type === 'enum') {
      if (!STATE_CONTENT_BUFF_TYPES.includes(value)) {
        problems.push(`${fieldLabel} must be one of ${STATE_CONTENT_BUFF_TYPES.join(', ')}, got ${JSON.stringify(value)}`);
      }
      continue;
    }
    const handler = FIELD_TYPES[field.type];
    if (!handler) continue;
    problems.push(...handler(value, fieldLabel));
  }
  for (const key of Object.keys(owner)) {
    if (!fields.some(field => field.name === key)) {
      problems.push(`${label}.${key} is not part of schema v${STATE_CONTENT_SCHEMA_VERSION}; declare it in STATE_CONTENT_FIELDS or remove it`);
    }
  }
}

function checkBounds(bounds, label, problems) {
  if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)) {
    problems.push(`${label} must be an object with min and max`);
    return;
  }
  for (const corner of ['min', 'max']) {
    problems.push(...FIELD_TYPES.vec3(bounds[corner], `${label}.${corner}`));
  }
  if (problems.some(problem => problem.startsWith(label))) return;
  for (const axis of ['x', 'y', 'z']) {
    if (bounds.min[axis] >= bounds.max[axis]) problems.push(`${label}.max.${axis} must be greater than ${label}.min.${axis}`);
  }
}

function checkProvenance(provenance, label, problems) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    problems.push(`${label} must be an object`);
    return;
  }
  const permitted = ['author', 'reviewStatus', 'reviewedBy', 'sources', 'contentWarnings', 'notes'];
  if (provenance.reviewStatus !== undefined && !['unreviewed', 'in-review', 'reviewed'].includes(provenance.reviewStatus)) {
    problems.push(`${label}.reviewStatus must be unreviewed, in-review or reviewed, got ${JSON.stringify(provenance.reviewStatus)}`);
  }
  if (provenance.sources !== undefined && !Array.isArray(provenance.sources)) problems.push(`${label}.sources must be an array`);
  if (provenance.contentWarnings !== undefined && !Array.isArray(provenance.contentWarnings)) {
    problems.push(`${label}.contentWarnings must be an array of strings`);
  }
  for (const key of Object.keys(provenance)) {
    if (!permitted.includes(key)) problems.push(`${label}.${key} is not part of schema v${STATE_CONTENT_SCHEMA_VERSION}`);
  }
}

function insideBounds(position, bounds) {
  for (const axis of ['x', 'y', 'z']) {
    if (position[axis] < bounds.min[axis] || position[axis] > bounds.max[axis]) return false;
  }
  return true;
}

/**
 * Report the version a file declares.
 *
 * An absent `schemaVersion` is version `0` by definition — that is what "the
 * experimental files predate the schema" means — rather than a malformed value,
 * so a legacy file is a known state the ladder can start from.
 */
export function detectStateContentVersion(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.schemaVersion === undefined || data.schemaVersion === null) return STATE_CONTENT_LEGACY_VERSION;
  return Number.isInteger(data.schemaVersion) ? data.schemaVersion : null;
}

/**
 * Remove voxel coordinates that repeat inside one collectible.
 *
 * Coincident boxes are invisible duplicates that z-fight and cost geometry; the
 * first entry wins because later entries were never reachable at runtime. Only an
 * exact coordinate match is removed — two voxels differing in colour are a
 * genuine authoring conflict and are reported by validation instead.
 */
function dedupeVoxels(voxels) {
  if (!Array.isArray(voxels)) return { voxels, removed: 0, conflicts: 0 };
  const seen = new Map();
  const kept = [];
  let removed = 0;
  let conflicts = 0;
  for (const voxel of voxels) {
    if (!Array.isArray(voxel) || voxel.length !== 4) { kept.push(voxel); continue; }
    const key = `${voxel[0]},${voxel[1]},${voxel[2]}`;
    if (seen.has(key)) {
      removed += 1;
      if (seen.get(key) !== voxel[3]) conflicts += 1;
      continue;
    }
    seen.set(key, voxel[3]);
    kept.push(voxel);
  }
  return { voxels: kept, removed, conflicts };
}

/**
 * Version ladder: `MIGRATIONS[n]` turns version `n` into version `n + 1`.
 *
 * Each step is pure and returns `{ data, notes }`. Keeping them separate rather
 * than writing one "upgrade anything to v1" function is what makes the next
 * format change a one-entry addition instead of a rewrite, and `NET-01` reuses
 * the same shape for save files.
 */
const MIGRATIONS = Object.freeze({
  [STATE_CONTENT_LEGACY_VERSION]: {
    to: 1,
    description: 'Stamp the schema version, drop coincident voxels and normalise hex case.',
    migrate(data) {
      const notes = [];
      const collectibles = Array.isArray(data?.collectibles) ? data.collectibles.map(item => {
        if (!item || typeof item !== 'object') return item;
        const migrated = { ...item };
        const { voxels, removed, conflicts } = dedupeVoxels(item.voxels);
        if (removed > 0) {
          migrated.voxels = voxels;
          notes.push(`${JSON.stringify(item.id ?? 'collectible')}: removed ${removed} coincident voxel(s)`);
          if (conflicts > 0) {
            notes.push(`${JSON.stringify(item.id ?? 'collectible')}: ${conflicts} of those repeated a coordinate with a different colour — the first colour was kept`);
          }
        }
        if (Array.isArray(migrated.voxels)) {
          migrated.voxels = migrated.voxels.map(voxel => (
            Array.isArray(voxel) && voxel.length === 4 && typeof voxel[3] === 'string'
              ? [voxel[0], voxel[1], voxel[2], voxel[3].toLowerCase()]
              : voxel
          ));
        }
        return migrated;
      }) : data?.collectibles;
      const migrated = { ...data, schemaVersion: 1 };
      if (collectibles !== undefined) migrated.collectibles = collectibles;
      // Rebuild in schema order so a migrated file reads like a written one.
      const ordered = {};
      for (const field of STATE_CONTENT_FIELDS.root) if (field.name in migrated) ordered[field.name] = migrated[field.name];
      for (const key of Object.keys(migrated)) if (!(key in ordered)) ordered[key] = migrated[key];
      return { data: ordered, notes };
    },
  },
});

export const STATE_CONTENT_MIGRATION_STEPS = Object.freeze(Object.entries(MIGRATIONS)
  .map(([from, step]) => Object.freeze({ from: Number(from), to: step.to, description: step.description }))
  .sort((left, right) => left.from - right.from));

/**
 * Bring a file up to the current schema version.
 *
 * Returns `{ data, from, to, migrated, notes, problems }`. A file already at the
 * current version is returned unchanged with `migrated: false` (and the same object
 * reference, so callers can cheaply detect the no-op). A file from the *future* is
 * refused rather than passed through: validating it against an older schema would
 * reject fields the author legitimately used, and silently accepting it would let
 * an unknown shape reach the renderer.
 *
 * `problems` is for a caller that wants to report and continue; `migrateStateContent`
 * itself does not throw. `parseStateContent` is the throwing entry point.
 */
export function migrateStateContent(data) {
  const from = detectStateContentVersion(data);
  if (from === null) {
    return { data, from, to: null, migrated: false, notes: [], problems: ['schemaVersion must be an integer when present'] };
  }
  if (from > STATE_CONTENT_SCHEMA_VERSION) {
    return {
      data, from, to: from, migrated: false, notes: [],
      problems: [`schemaVersion ${from} was authored for a newer schema (this build reads up to ${STATE_CONTENT_SCHEMA_VERSION})`],
    };
  }
  if (from === STATE_CONTENT_SCHEMA_VERSION) return { data, from, to: from, migrated: false, notes: [], problems: [] };

  let current = data;
  let version = from;
  const notes = [];
  // Bounded on purpose (roadmap §4 invariant 12): a ladder that cannot converge
  // must fail loudly instead of upgrading in a loop.
  const stepCap = STATE_CONTENT_MIGRATION_STEPS.length + 1;
  let steps = 0;
  while (version < STATE_CONTENT_SCHEMA_VERSION) {
    if (steps++ > stepCap) {
      return { data: current, from, to: version, migrated: true, notes, problems: [`migration did not converge after ${stepCap} steps from version ${from}`] };
    }
    const step = MIGRATIONS[version];
    if (!step) {
      return { data: current, from, to: version, migrated: true, notes, problems: [`no migration step from schemaVersion ${version} to ${version + 1}`] };
    }
    const result = step.migrate(current);
    current = result.data;
    notes.push(...result.notes);
    version = step.to;
  }
  return { data: current, from, to: version, migrated: true, notes, problems: [] };
}

/**
 * Validate content against the current schema.
 *
 * `errors` mean the content cannot be rendered or looked up correctly and must not
 * ship. `warnings` are advisory and never block a build — the shipped packs carry
 * warnings today (no declared `bounds`, no provenance record), and a gate that
 * failed on those would be reporting a product decision as a defect.
 *
 * Strict by default: un-migrated legacy content is an **error**, because a file
 * with no version stamp is a file whose shape nobody has checked, and the fix is
 * one call to `migrateStateContent`. Pass `{ allowLegacy: true }` only to inspect
 * a legacy file's remaining problems.
 */
export function validateStateContent(data, { allowLegacy = false } = {}) {
  const errors = [];
  const warnings = [];
  const version = detectStateContentVersion(data);
  if (version === null) {
    errors.push('schemaVersion must be an integer when present');
  } else if (version === STATE_CONTENT_LEGACY_VERSION && !allowLegacy) {
    errors.push('schemaVersion is missing: this is legacy v0 content, migrate it with migrateStateContent() first');
  } else if (version > STATE_CONTENT_SCHEMA_VERSION) {
    errors.push(`schemaVersion ${version} was authored for a newer schema (this build reads up to ${STATE_CONTENT_SCHEMA_VERSION})`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, version, errors: [...errors, 'a state file must be a JSON object'], warnings, limits: { ...STATE_CONTENT_LIMITS } };
  }

  checkFields(data, STATE_CONTENT_FIELDS.root, 'root', errors, 'state');
  // `collectibles` is declared in the root table so it appears in the printed
  // schema, but its shape needs its own check — a rich type is not covered by the
  // scalar handlers the loop walks.
  if (data.collectibles !== undefined && !Array.isArray(data.collectibles)) {
    errors.push('state.collectibles must be an array of collectible[]');
  }
  if (data.bounds !== undefined) checkBounds(data.bounds, 'state.bounds', errors);
  if (data.provenance !== undefined) checkProvenance(data.provenance, 'state.provenance', errors);
  if (data.stateName !== undefined && typeof data.stateName === 'string' && data.stateName.length > STATE_CONTENT_LIMITS.labelLength) {
    errors.push(`state.stateName is ${data.stateName.length} characters, over the ${STATE_CONTENT_LIMITS.labelLength}-character limit`);
  }

  const collectibles = Array.isArray(data.collectibles) ? data.collectibles : [];
  if (Array.isArray(data.collectibles) && collectibles.length === 0) errors.push('state.collectibles is empty: a pack with nothing to collect renders as scenery only');
  if (collectibles.length > STATE_CONTENT_LIMITS.collectiblesPerState) {
    errors.push(`state.collectibles has ${collectibles.length} entries, over the cap of ${STATE_CONTENT_LIMITS.collectiblesPerState}`);
  }

  const seenIds = new Map();
  const seenSpawns = new Map();
  let voxelTotal = 0;
  collectibles.forEach((item, index) => {
    const label = `state.collectibles[${index}]`;
    checkFields(item, STATE_CONTENT_FIELDS.collectible, 'collectible', errors, label);
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const name = item.id ?? `#${index}`;
    const at = `${label} (${JSON.stringify(name)})`;

    if (typeof item.id === 'string') {
      if (seenIds.has(item.id)) errors.push(`${at}.id duplicates collectible[${seenIds.get(item.id)}]: the inventory keys on it`);
      else seenIds.set(item.id, index);
    }
    if (typeof item.name === 'string' && item.name.length > STATE_CONTENT_LIMITS.labelLength) {
      errors.push(`${at}.name is ${item.name.length} characters, over the ${STATE_CONTENT_LIMITS.labelLength}-character limit`);
    }
    if (typeof item.description === 'string' && item.description.length > STATE_CONTENT_LIMITS.descriptionLength) {
      errors.push(`${at}.description is ${item.description.length} characters, over the ${STATE_CONTENT_LIMITS.descriptionLength}-character limit`);
    }
    if (typeof item.icon === 'string' && [...item.icon].length > STATE_CONTENT_LIMITS.iconCodePoints) {
      errors.push(`${at}.icon is ${[...item.icon].length} code points; an icon is one glyph`);
    }

    if (item.buff !== undefined) {
      checkFields(item.buff, STATE_CONTENT_FIELDS.buff, 'buff', errors, `${at}.buff`);
      if (item.buff && typeof item.buff === 'object') {
        if (Number.isFinite(item.buff.duration) && item.buff.duration > STATE_CONTENT_LIMITS.buffDurationMs) {
          errors.push(`${at}.buff.duration is ${item.buff.duration}ms, over the ${STATE_CONTENT_LIMITS.buffDurationMs}ms limit`);
        }
        if (Number.isFinite(item.buff.multiplier) && item.buff.multiplier > STATE_CONTENT_LIMITS.buffMultiplier) {
          errors.push(`${at}.buff.multiplier is ${item.buff.multiplier}, over the ${STATE_CONTENT_LIMITS.buffMultiplier} limit`);
        }
        // The description restates these numbers for the player, and nothing else
        // checks that they still agree: edit a duration and the text lies silently.
        if (typeof item.description === 'string' && Number.isFinite(item.buff.multiplier)) {
          const stated = item.description.match(/(\d+(?:\.\d+)?)\s*x/i);
          if (stated && Number(stated[1]) !== item.buff.multiplier) {
            warnings.push(`${at}.description says "${stated[0].trim()}" but buff.multiplier is ${item.buff.multiplier}`);
          }
        }
        if (typeof item.description === 'string' && Number.isFinite(item.buff.duration)) {
          const stated = item.description.match(/(\d+(?:\.\d+)?)\s*s\b/);
          if (stated && Number(stated[1]) !== item.buff.duration / 1000) {
            warnings.push(`${at}.description says ${stated[0].trim()} but buff.duration is ${item.buff.duration}ms`);
          }
        }
      }
    }

    if (item.spawnPosition !== undefined) {
      // The field walk above already reported a malformed position, so this call
      // only decides whether the derived checks below have anything to work with.
      // Reporting it here as well put the same problem in the list twice.
      const positionProblems = FIELD_TYPES.vec3(item.spawnPosition, `${at}.spawnPosition`);
      if (positionProblems.length === 0) {
        const key = `${item.spawnPosition.x},${item.spawnPosition.y},${item.spawnPosition.z}`;
        if (seenSpawns.has(key)) errors.push(`${at}.spawnPosition is the same point as collectible[${seenSpawns.get(key)}]: neither can be collected first`);
        else seenSpawns.set(key, index);
        if (data.bounds && !insideBounds(item.spawnPosition, data.bounds)) {
          errors.push(`${at}.spawnPosition ${JSON.stringify(item.spawnPosition)} is outside state.bounds`);
        }
      }
    }

    if (item.voxels !== undefined) {
      if (!Array.isArray(item.voxels)) {
        errors.push(`${at}.voxels must be an array of [x, y, z, colour] tuples`);
      } else if (item.voxels.length === 0) {
        errors.push(`${at}.voxels is empty: a collectible with no voxels renders nothing`);
      } else {
        voxelTotal += item.voxels.length;
        if (item.voxels.length > STATE_CONTENT_LIMITS.voxelsPerCollectible) {
          errors.push(`${at}.voxels has ${item.voxels.length} entries, over the cap of ${STATE_CONTENT_LIMITS.voxelsPerCollectible}`);
        }
        const coordinates = new Map();
        let min = [Infinity, Infinity, Infinity];
        item.voxels.forEach((voxel, voxelIndex) => {
          const voxelLabel = `${at}.voxels[${voxelIndex}]`;
          if (!Array.isArray(voxel) || voxel.length !== 4) {
            errors.push(`${voxelLabel} must be a [x, y, z, colour] tuple, got ${JSON.stringify(voxel)}`);
            return;
          }
          for (const axis of [0, 1, 2]) {
            if (!Number.isInteger(voxel[axis])) errors.push(`${voxelLabel}[${axis}] must be an integer, got ${JSON.stringify(voxel[axis])}`);
          }
          if (typeof voxel[3] !== 'string' || !COLOR_PATTERN.test(voxel[3])) {
            errors.push(`${voxelLabel}[3] must be a six-digit hex colour like "#d4a017", got ${JSON.stringify(voxel[3])}`);
            return;
          }
          const key = `${voxel[0]},${voxel[1]},${voxel[2]}`;
          const previous = coordinates.get(key);
          if (previous !== undefined) {
            errors.push(previous === voxel[3]
              ? `${voxelLabel} repeats coordinate ${key}: coincident boxes z-fight and cost geometry`
              : `${voxelLabel} repeats coordinate ${key} with a different colour (${previous} vs ${voxel[3]}): one of the two is unreachable`);
          } else {
            coordinates.set(key, voxel[3]);
          }
          for (const axis of [0, 1, 2]) if (Number.isInteger(voxel[axis]) && voxel[axis] < min[axis]) min[axis] = voxel[axis];
        });
        if (min.every(Number.isFinite) && min.some(value => value !== 0)) {
          warnings.push(`${at}.voxels starts at (${min.join(', ')}) rather than the origin; the runtime re-centres on the bounding box, so the author's origin does not anchor the vignette`);
        }
      }
    }
  });

  if (voxelTotal > STATE_CONTENT_LIMITS.voxelsPerState) {
    errors.push(`state declares ${voxelTotal} voxels, over the ${STATE_CONTENT_LIMITS.voxelsPerState}-voxel pack cap (derived from the shared ${GDO_LOW_PROFILE_BUDGETS.visibleTriangles}-triangle low-profile ceiling)`);
  }

  // Advisory: a spawn cluster under the pickup radius cannot be collected apart.
  const spawns = collectibles
    .map((item, index) => ({ index, id: item?.id ?? `#${index}`, position: item?.spawnPosition }))
    .filter(entry => entry.position && ['x', 'y', 'z'].every(axis => Number.isFinite(entry.position[axis])));
  for (let a = 0; a < spawns.length; a += 1) {
    for (let b = a + 1; b < spawns.length; b += 1) {
      const dx = spawns[a].position.x - spawns[b].position.x;
      const dz = spawns[a].position.z - spawns[b].position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > 0 && distance < STATE_CONTENT_LIMITS.spawnSeparation) {
        warnings.push(`collectibles ${JSON.stringify(spawns[a].id)} and ${JSON.stringify(spawns[b].id)} spawn ${distance.toFixed(2)} units apart, inside the ${STATE_CONTENT_LIMITS.spawnSeparation}-unit pickup radius: one pickup will cover both`);
      }
    }
  }

  if (data.bounds === undefined && spawns.length > 0) {
    warnings.push('state.bounds is not declared, so nothing checks the spawns stay inside the playable area');
  }
  if (data.provenance === undefined) {
    warnings.push('state.provenance is not declared: contributor credit, review state and content warnings are unrecorded');
  }
  if (version === STATE_CONTENT_LEGACY_VERSION && allowLegacy) {
    warnings.push('this file predates schema v1; it validates only after migrateStateContent()');
  }

  return { ok: errors.length === 0, version, errors, warnings, limits: { ...STATE_CONTENT_LIMITS }, voxels: voxelTotal };
}

/** Throwing form for a caller that cannot continue with invalid content. */
export function assertStateContent(data, options) {
  const report = validateStateContent(data, options);
  if (!report.ok) {
    throw new StateContentError(`State content is invalid against schema v${STATE_CONTENT_SCHEMA_VERSION}: ${report.errors.join('; ')}`, report.errors);
  }
  return report;
}

/**
 * Migrate and validate in one step, from a JSON string or an already-parsed object.
 *
 * `sourceName` is used for two things: the message a parse error carries, and the
 * `stateId`/file-name agreement check. That check is worth the trouble — the id is
 * the lookup key, and a pack renamed to `kerala-2.json` while its `stateId` still
 * says `kerala` would be fetched under one name and reported under another.
 */
export function parseStateContent(source, { sourceName = null } = {}) {
  let data = source;
  if (typeof source === 'string') {
    try {
      data = JSON.parse(source);
    } catch (error) {
      throw new StateContentError(`State content${sourceName ? ` (${sourceName})` : ''} is not valid JSON: ${error.message}`, [error.message]);
    }
  }
  const migration = migrateStateContent(data);
  if (migration.problems.length) throw new StateContentError(`State content${sourceName ? ` (${sourceName})` : ''} cannot be migrated: ${migration.problems.join('; ')}`, migration.problems);
  const report = assertStateContent(migration.data);
  if (sourceName) {
    const expected = String(sourceName).replace(/\.json$/i, '').split('/').pop();
    if (report.version > STATE_CONTENT_LEGACY_VERSION && migration.data.stateId !== expected) {
      throw new StateContentError(`State content (${sourceName}) declares stateId ${JSON.stringify(migration.data.stateId)} but lives at ${JSON.stringify(expected)}; the id is the lookup key`, [
        `stateId ${JSON.stringify(migration.data.stateId)} does not match ${JSON.stringify(expected)}`,
      ]);
    }
  }
  return {
    content: migration.data,
    report: {
      ...report,
      schemaVersion: report.version,
      namespace: featureNamespace('contentSchema'),
      migratedFrom: migration.migrated ? migration.from : null,
      migrationNotes: migration.notes,
    },
  };
}

/**
 * The loader the runtime path uses: fetch, migrate, validate, return.
 *
 * It always ends with valid content or a thrown `StateContentError` naming every
 * problem, so a bad contribution fails with a message an author can act on instead
 * of rendering a half-built vignette.
 */
export async function loadStateContent(url, { fetchImpl = globalThis.fetch, sourceName = null, signal } = {}) {
  if (typeof fetchImpl !== 'function') throw new StateContentError('loadStateContent needs a fetch implementation', ['fetch is unavailable in this environment']);
  const response = await fetchImpl(url, signal ? { signal } : undefined);
  if (!response?.ok) {
    throw new StateContentError(`Failed to load state content from ${url}: ${response?.status ?? 'no response'} ${response?.statusText ?? ''}`.trim(), [
      `HTTP ${response?.status ?? 'unknown'} for ${url}`,
    ]);
  }
  const text = await response.text();
  return parseStateContent(text, { sourceName: sourceName ?? new URL(url, 'http://localhost').pathname.split('/').pop() });
}

/**
 * The gate's self-check: the schema module must be the version the feature registry
 * advertises, or the namespace a cache or a migration keys on is a lie.
 */
export function assertContentSchemaAvailable() {
  const declared = GDO_FEATURE_VERSIONS.contentSchema;
  if (declared !== STATE_CONTENT_SCHEMA_VERSION) {
    throw new StateContentError(`contentSchema is registered as v${declared} but this module implements v${STATE_CONTENT_SCHEMA_VERSION}`, [
      'GDO_FEATURE_VERSIONS.contentSchema and STATE_CONTENT_SCHEMA_VERSION must agree',
    ]);
  }
  if (!featureAvailable('contentSchema')) {
    throw new StateContentError('contentSchema is still marked unavailable in GDO_FEATURE_VERSIONS', ['contentSchema must be non-zero now that the schema exists']);
  }
  return declared;
}
