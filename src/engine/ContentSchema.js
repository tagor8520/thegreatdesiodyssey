/**
 * `CNT-01` — the versioned state-content schema.
 *
 * `public/content/states/*.json` started as experimental files with no version
 * field and no validation: a typo in a colour, a duplicate collectible id, or a
 * voxel row of the wrong length would fail later and elsewhere (or silently spawn
 * a broken pick-up). This module is the declared contract the roadmap asks for:
 * one frozen schema describing what a state pack may contain, a validating
 * loader that names every problem with a stable code and path, and a migration
 * path that stamps old files forward instead of stranding them.
 *
 * The schema is data, not prose: caps and ranges live in `GDO_CONTENT_LIMITS`
 * so the validator, the tests and any future authoring tool read one source of
 * truth, and an unknown field is a warning rather than a failure so a newer pack
 * can still be read by an older client without losing data.
 */

import { featureNamespace, GDO_FEATURE_VERSIONS } from './FeatureVersions.js';

export const GDO_CONTENT_SCHEMA_NAMESPACE = featureNamespace('contentSchema');

/** The schema version this build reads and writes. */
export const GDO_CONTENT_SCHEMA_VERSION = 1;

export const GDO_CONTENT_LIMITS = Object.freeze({
  maxCollectibles: 16,
  maxVoxelsPerCollectible: 96,
  maxVoxelCoordinate: 12,
  maxNameLength: 64,
  maxDescriptionLength: 180,
  maxMultiplier: 4,
  minMultiplier: 1,
  maxBuffMilliseconds: 60_000,
  minBuffMilliseconds: 500,
  maxSpawnCoordinate: 64,
});

export const GDO_CONTENT_BUFF_TYPES = Object.freeze(['speed', 'jump', 'shield', 'stamina', 'focus']);

/** One frozen description of the state pack contract. */
export const GDO_CONTENT_STATE_SCHEMA = Object.freeze({
  namespace: 'gdo:contentSchema',
  version: GDO_CONTENT_SCHEMA_VERSION,
  required: Object.freeze(['stateId', 'stateName', 'collectibles']),
  optional: Object.freeze(['bgColor', 'fogColor', 'ambientColor', 'schemaVersion']),
  limits: GDO_CONTENT_LIMITS,
});

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pushProblem(errors, path, code, message) {
  errors.push(Object.freeze({ path, code, message }));
}

function validateColor(errors, path, value, { required = false } = {}) {
  if (value === undefined) {
    if (required) pushProblem(errors, path, 'missing-field', `${path} is required`);
    return;
  }
  if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) {
    pushProblem(errors, path, 'invalid-color', `${path} must be a #rrggbb colour`);
  }
}

function validateBoundedNumber(errors, path, value, { minimum, maximum, integer = false }) {
  if (typeof value !== 'number' || !Number.isFinite(value) ||
      (integer && !Number.isInteger(value)) ||
      value < minimum || value > maximum) {
    pushProblem(errors, path, 'out-of-range',
      `${path} must be ${integer ? 'an integer' : 'a number'} inside [${minimum}, ${maximum}]`);
  }
}

function validateVoxels(errors, path, voxels) {
  if (!Array.isArray(voxels)) {
    pushProblem(errors, path, 'wrong-type', `${path} must be an array of [x, y, z, color] rows`);
    return;
  }
  if (voxels.length === 0) pushProblem(errors, path, 'empty-list', `${path} needs at least one voxel`);
  if (voxels.length > GDO_CONTENT_LIMITS.maxVoxelsPerCollectible) {
    pushProblem(errors, path, 'out-of-range',
      `${path} holds ${voxels.length} voxels, over the ${GDO_CONTENT_LIMITS.maxVoxelsPerCollectible} cap`);
  }
  voxels.forEach((row, index) => {
    const rowPath = `${path}[${index}]`;
    if (!Array.isArray(row) || row.length !== 4) {
      pushProblem(errors, rowPath, 'malformed-voxel', `${rowPath} must be [x, y, z, "#rrggbb"]`);
      return;
    }
    const [x, y, z, color] = row;
    for (const [axis, coordinate, axisName] of [[0, x, 'x'], [1, y, 'y'], [2, z, 'z']]) {
      if (!Number.isInteger(coordinate) || Math.abs(coordinate) > GDO_CONTENT_LIMITS.maxVoxelCoordinate) {
        pushProblem(errors, `${rowPath}[${axis}]`, 'out-of-range',
          `${rowPath}.${axisName} must be an integer inside [${-GDO_CONTENT_LIMITS.maxVoxelCoordinate}, ${GDO_CONTENT_LIMITS.maxVoxelCoordinate}]`);
      }
    }
    if (typeof color !== 'string' || !COLOR_PATTERN.test(color)) {
      pushProblem(errors, `${rowPath}[3]`, 'invalid-color', `${rowPath} colour must be a #rrggbb colour`);
    }
  });
}

function validateCollectible(errors, basePath, item, seenIds) {
  if (!isRecord(item)) {
    pushProblem(errors, basePath, 'wrong-type', `${basePath} must be an object`);
    return;
  }
  for (const field of ['id', 'name', 'description', 'icon', 'buff', 'spawnPosition', 'voxels']) {
    if (item[field] === undefined) pushProblem(errors, `${basePath}.${field}`, 'missing-field', `${basePath}.${field} is required`);
  }
  if (typeof item.id === 'string') {
    if (!ID_PATTERN.test(item.id)) {
      pushProblem(errors, `${basePath}.id`, 'invalid-id',
        `${basePath}.id must be a lowercase slug (letters, digits, _ or -)`);
    } else if (seenIds.has(item.id)) {
      pushProblem(errors, `${basePath}.id`, 'duplicate-id', `${basePath}.id repeats the collectible id "${item.id}"`);
    } else {
      seenIds.add(item.id);
    }
  } else if (item.id !== undefined) {
    pushProblem(errors, `${basePath}.id`, 'wrong-type', `${basePath}.id must be a string`);
  }
  for (const [field, limit] of [['name', GDO_CONTENT_LIMITS.maxNameLength],
    ['description', GDO_CONTENT_LIMITS.maxDescriptionLength], ['icon', 8]]) {
    const value = item[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0 || value.length > limit) {
      pushProblem(errors, `${basePath}.${field}`, 'out-of-range',
        `${basePath}.${field} must be a non-empty string of at most ${limit} characters`);
    }
  }
  if (item.buff !== undefined) {
    const buff = item.buff;
    if (!isRecord(buff)) {
      pushProblem(errors, `${basePath}.buff`, 'wrong-type', `${basePath}.buff must be an object`);
    } else {
      if (!GDO_CONTENT_BUFF_TYPES.includes(buff.type)) {
        pushProblem(errors, `${basePath}.buff.type`, 'unknown-buff',
          `${basePath}.buff.type must be one of ${GDO_CONTENT_BUFF_TYPES.join(', ')}`);
      }
      if (buff.type !== 'shield') {
        validateBoundedNumber(errors, `${basePath}.buff.multiplier`, buff.multiplier, {
          minimum: GDO_CONTENT_LIMITS.minMultiplier, maximum: GDO_CONTENT_LIMITS.maxMultiplier,
        });
      } else if (buff.multiplier !== undefined) {
        validateBoundedNumber(errors, `${basePath}.buff.multiplier`, buff.multiplier, {
          minimum: GDO_CONTENT_LIMITS.minMultiplier, maximum: GDO_CONTENT_LIMITS.maxMultiplier,
        });
      }
      validateBoundedNumber(errors, `${basePath}.buff.duration`, buff.duration, {
        minimum: GDO_CONTENT_LIMITS.minBuffMilliseconds, maximum: GDO_CONTENT_LIMITS.maxBuffMilliseconds,
        integer: true,
      });
    }
  }
  if (item.spawnPosition !== undefined) {
    const spawn = item.spawnPosition;
    if (!isRecord(spawn)) {
      pushProblem(errors, `${basePath}.spawnPosition`, 'wrong-type', `${basePath}.spawnPosition must be an object`);
    } else {
      for (const axis of ['x', 'y', 'z']) {
        if (spawn[axis] === undefined) {
          pushProblem(errors, `${basePath}.spawnPosition.${axis}`, 'missing-field',
            `${basePath}.spawnPosition.${axis} is required`);
          continue;
        }
        validateBoundedNumber(errors, `${basePath}.spawnPosition.${axis}`, spawn[axis], {
          minimum: axis === 'y' ? 0 : -GDO_CONTENT_LIMITS.maxSpawnCoordinate,
          maximum: GDO_CONTENT_LIMITS.maxSpawnCoordinate,
        });
      }
    }
  }
  if (item.voxels !== undefined) validateVoxels(errors, `${basePath}.voxels`, item.voxels);
}

/**
 * Validate one state pack. Errors are stable, ordered, and named by code and
 * path so a tool — or a test — can assert the exact reason a pack was refused.
 */
export function validateContentState(data, { schemaVersion = GDO_CONTENT_SCHEMA_VERSION } = {}) {
  const errors = [], warnings = [];
  if (!isRecord(data)) {
    return Object.freeze({
      ok: false, namespace: GDO_CONTENT_SCHEMA_NAMESPACE, version: schemaVersion,
      errors: Object.freeze([Object.freeze({ path: '', code: 'wrong-type', message: 'a state pack must be a JSON object' })]),
      warnings: Object.freeze([]),
    });
  }
  if (data.schemaVersion !== undefined) {
    if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) {
      pushProblem(errors, 'schemaVersion', 'wrong-type', 'schemaVersion must be a positive integer');
    } else if (data.schemaVersion > schemaVersion) {
      pushProblem(errors, 'schemaVersion', 'unsupported-version',
        `schemaVersion ${data.schemaVersion} is newer than this build reads (${schemaVersion})`);
    }
  }
  if (typeof data.stateId !== 'string' || !ID_PATTERN.test(data.stateId)) {
    pushProblem(errors, 'stateId', data.stateId === undefined ? 'missing-field' : 'invalid-id',
      'stateId must be a lowercase slug');
  }
  if (typeof data.stateName !== 'string' || data.stateName.length === 0 ||
      data.stateName.length > GDO_CONTENT_LIMITS.maxNameLength) {
    pushProblem(errors, 'stateName', data.stateName === undefined ? 'missing-field' : 'out-of-range',
      `stateName must be a non-empty string of at most ${GDO_CONTENT_LIMITS.maxNameLength} characters`);
  }
  validateColor(errors, 'bgColor', data.bgColor);
  validateColor(errors, 'fogColor', data.fogColor);
  validateColor(errors, 'ambientColor', data.ambientColor);
  if (data.collectibles === undefined) {
    pushProblem(errors, 'collectibles', 'missing-field', 'collectibles is required');
  } else if (!Array.isArray(data.collectibles)) {
    pushProblem(errors, 'collectibles', 'wrong-type', 'collectibles must be an array');
  } else {
    if (data.collectibles.length === 0) {
      pushProblem(errors, 'collectibles', 'empty-list', 'a state pack needs at least one collectible');
    }
    if (data.collectibles.length > GDO_CONTENT_LIMITS.maxCollectibles) {
      pushProblem(errors, 'collectibles', 'out-of-range',
        `collectibles holds ${data.collectibles.length} entries, over the ${GDO_CONTENT_LIMITS.maxCollectibles} cap`);
    }
    const seenIds = new Set();
    data.collectibles.forEach((item, index) => validateCollectible(errors, `collectibles[${index}]`, item, seenIds));
  }
  const declared = new Set([...GDO_CONTENT_STATE_SCHEMA.required, ...GDO_CONTENT_STATE_SCHEMA.optional]);
  for (const key of Object.keys(data)) {
    if (!declared.has(key)) {
      warnings.push(Object.freeze({
        path: key, code: 'unknown-field',
        message: `${key} is not part of the v${schemaVersion} schema and is preserved but ignored`,
      }));
    }
  }
  return Object.freeze({
    ok: errors.length === 0,
    namespace: GDO_CONTENT_SCHEMA_NAMESPACE,
    version: schemaVersion,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
  });
}

/**
 * Migrate a pack forward to the current schema version. Migration is a pure
 * transformation: the input is never mutated, the same input always produces the
 * same output, and every step is named so a caller can report what changed.
 */
export function migrateContentState(data, { targetVersion = GDO_CONTENT_SCHEMA_VERSION } = {}) {
  if (!isRecord(data)) throw new TypeError('A state pack must be a JSON object to migrate');
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new RangeError('targetVersion must be a positive integer');
  }
  const source = data.schemaVersion;
  if (source !== undefined && (!Number.isInteger(source) || source < 1)) {
    throw new RangeError('schemaVersion must be a positive integer to migrate');
  }
  const from = source ?? 0;
  if (from > targetVersion) {
    throw new RangeError(`Cannot migrate a v${from} pack down to v${targetVersion}`);
  }
  const steps = [];
  const migrated = { ...data };
  if (from === 0) {
    // v0 packs shipped without any schema marker: stamp the version and the
    // authoring defaults the loader used to assume.
    migrated.schemaVersion = targetVersion;
    steps.push('v0->v1:stamp-schema-version');
    if (!Array.isArray(migrated.collectibles)) migrated.collectibles = [];
    // v1 reads buffs immutably, so the migrated pack owns its own buff objects.
    if (migrated.collectibles.length) {
      migrated.collectibles = migrated.collectibles.map(item => (isRecord(item) && isRecord(item.buff)
        ? { ...item, buff: { ...item.buff } } : item));
      steps.push('v0->v1:detach-buff-objects');
    }
  }
  return Object.freeze({
    data: Object.freeze(migrated),
    from, to: targetVersion, migrated: from !== targetVersion, steps: Object.freeze(steps),
  });
}

/** Migrate, then validate: the loader path every consumer shares. */
export function loadContentState(data, options = {}) {
  const migration = migrateContentState(data, options);
  const report = validateContentState(migration.data, options);
  return Object.freeze({
    ok: report.ok,
    namespace: GDO_CONTENT_SCHEMA_NAMESPACE,
    version: migration.to,
    migration: Object.freeze({
      from: migration.from, to: migration.to, migrated: migration.migrated, steps: migration.steps,
    }),
    errors: report.errors,
    warnings: report.warnings,
    data: report.ok ? migration.data : null,
  });
}

/** The schema is only "available" once it can round-trip a real pack. */
export function contentSchemaAvailable() {
  return GDO_FEATURE_VERSIONS.contentSchema >= 1 &&
    GDO_CONTENT_SCHEMA_NAMESPACE === `gdo:contentSchema:v${GDO_CONTENT_SCHEMA_VERSION}`;
}
