/**
 * `CNT-01` — the state-content schema gate.
 *
 * Three claims have to hold at once for the versioned schema to mean anything:
 *
 * 1. **The shipped content conforms.** Both state packs are read from disk — the
 *    real files the loader will fetch, not fixtures that resemble them — and must
 *    validate with zero errors. A schema that the project's own content fails is a
 *    schema that describes something nobody has.
 * 2. **Validation actually detects.** A check that has never rejected anything is
 *    indistinguishable from a check that does nothing, so every error class has a
 *    fixture that must produce it, and each fixture asserts the *message*, because
 *    a validator that reports "invalid" without saying which field is unusable.
 * 3. **Migration is load-bearing and lossless.** The un-migrated file must fail
 *    strict validation (otherwise migration is optional decoration), and the
 *    migrated result must be structurally identical to the shipped v1 file
 *    (otherwise migration silently changes the content it claims to repair).
 *
 * The migrations must also *repair what is broken*: coincident voxels and mixed
 * hex case are the two defects the legacy format allowed, and both are asserted to
 * be fixed with a note rather than dropped silently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STATE_CONTENT_BUFF_TYPES, STATE_CONTENT_FIELDS, STATE_CONTENT_LEGACY_VERSION,
  STATE_CONTENT_LIMITS, STATE_CONTENT_MIGRATION_STEPS, STATE_CONTENT_SCHEMA_VERSION,
  StateContentError, assertContentSchemaAvailable, assertStateContent,
  describeStateContentSchema, detectStateContentVersion, loadStateContent,
  migrateStateContent, parseStateContent, validateStateContent,
} from '../engine/ContentSchema.js';
import { GDO_FEATURE_VERSIONS, featureNamespace } from '../engine/FeatureVersions.js';
import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIPPED = ['kerala', 'maharashtra'];

function shippedSource(name) {
  return readFileSync(join(ROOT, 'public', 'content', 'states', `${name}.json`), 'utf8');
}
function shipped(name) {
  return JSON.parse(shippedSource(name));
}

/** The legacy shape: a valid pack with `schemaVersion` removed (and optional edits). */
function asLegacy(name, mutator = null) {
  const data = shipped(name);
  delete data.schemaVersion;
  mutator?.(data);
  return data;
}

/** A complete, valid v1 pack that individual tests then break in one specific way. */
function validPack(overrides = {}) {
  const pack = {
    schemaVersion: STATE_CONTENT_SCHEMA_VERSION,
    stateId: 'testland',
    stateName: 'Testland',
    collectibles: [{
      id: 'test_snack',
      name: 'Test Snack',
      description: 'A snack used by the gate. +2x Speed for 5s',
      icon: '🍡',
      buff: { type: 'speed', multiplier: 2, duration: 5000 },
      spawnPosition: { x: 0, y: 1, z: 0 },
      voxels: [[0, 0, 0, '#112233'], [1, 0, 0, '#445566']],
    }],
  };
  return { ...pack, ...overrides };
}

/** The first collectible of a valid pack, with one field broken. */
function brokenCollectible(overrides) {
  const pack = validPack();
  pack.collectibles[0] = { ...pack.collectibles[0], ...overrides };
  return pack;
}

function errorsOf(data, options) {
  return validateStateContent(data, options).errors.join(' | ');
}

test('the schema is registered as available and describes itself', () => {
  assert.equal(assertContentSchemaAvailable(), STATE_CONTENT_SCHEMA_VERSION);
  assert.equal(GDO_FEATURE_VERSIONS.contentSchema, STATE_CONTENT_SCHEMA_VERSION);
  assert.equal(featureNamespace('contentSchema'), `gdo:contentSchema:v${STATE_CONTENT_SCHEMA_VERSION}`);

  const described = describeStateContentSchema();
  assert.equal(described.version, STATE_CONTENT_SCHEMA_VERSION);
  for (const level of ['root', 'collectible', 'buff']) {
    assert.ok(described.fields[level].length > 0, `${level} must be described`);
    for (const field of described.fields[level]) {
      assert.ok(field.name && field.type, `${level} fields need a name and a type`);
      assert.ok(field.description?.length > 0, `${level}.${field.name} needs a description a contributor can read`);
      assert.equal(typeof field.required, 'boolean');
    }
  }
  // Every field the shipped packs use must be declared, or the schema documents a
  // subset of reality. The reverse is checked by the validator's unknown-key rule.
  const declared = new Set(STATE_CONTENT_FIELDS.root.map(field => field.name));
  for (const name of SHIPPED) for (const key of Object.keys(shipped(name))) assert.ok(declared.has(key), `root.${key} is used but undeclared`);
  assert.deepEqual([...STATE_CONTENT_BUFF_TYPES].sort(), ['focus', 'jump', 'shield', 'speed', 'stamina']);
});

test('authoring caps are derived from the shared profile ceiling, not invented', () => {
  // Roadmap §4 invariant 10: ceilings are shared, not stacked per feature.
  assert.equal(
    STATE_CONTENT_LIMITS.voxelsPerState,
    Math.floor((GDO_LOW_PROFILE_BUDGETS.visibleTriangles * 0.5) / 12),
    'the pack cap must stay the documented half of the visible-triangle ceiling at 12 triangles per voxel',
  );
  assert.ok(STATE_CONTENT_LIMITS.voxelsPerState * 12 <= GDO_LOW_PROFILE_BUDGETS.visibleTriangles);
  assert.ok(STATE_CONTENT_LIMITS.collectiblesPerState >= 2);
  assert.ok(STATE_CONTENT_LIMITS.voxelsPerCollectible >= 18, 'the per-item cap must clear the largest shipped item (18 voxels)');
  for (const [name, limit] of Object.entries(STATE_CONTENT_LIMITS)) {
    assert.ok(Number.isFinite(limit) && limit > 0, `${name} must be a positive finite cap`);
  }
  // A schema that only describes what already conforms proves nothing: a valid
  // pack plus realistic authoring headroom must still fit under the caps.
  const pack = validPack();
  for (let slot = 0; slot < STATE_CONTENT_LIMITS.collectiblesPerState; slot += 1) {
    pack.collectibles[slot % 1] = pack.collectibles[0];
    pack.collectibles[slot] = { ...pack.collectibles[0], id: `snack_${slot}`, spawnPosition: { x: slot * 4, y: 1, z: 0 } };
  }
  assert.equal(pack.collectibles.length, STATE_CONTENT_LIMITS.collectiblesPerState);
  assert.equal(validateStateContent(pack).ok, true, errorsOf(pack));
});

test('every shipped state pack validates against the current schema', () => {
  for (const name of SHIPPED) {
    const data = shipped(name);
    const report = validateStateContent(data);
    assert.equal(report.ok, true, `${name}: ${report.errors.join('; ')}`);
    assert.equal(report.version, STATE_CONTENT_SCHEMA_VERSION);
    assert.equal(report.errors.length, 0);
    assert.equal(data.stateId, name, 'the shipped id must match its file name');
    // Warnings are expected on today's packs and must never be errors.
    for (const warning of report.warnings) assert.equal(typeof warning, 'string');
    assert.ok(report.voxels > 0 && report.voxels <= STATE_CONTENT_LIMITS.voxelsPerState);
  }
  // The warnings are the honest current state: no bounds and no provenance are
  // *product* gaps recorded by the schema, not defects in the packs. Asserted so a
  // later change that adds them is reminded to update this expectation.
  const kerala = validateStateContent(shipped('kerala'));
  assert.equal(kerala.warnings.length, 2);
  assert.match(kerala.warnings.join(' '), /bounds is not declared/);
  assert.match(kerala.warnings.join(' '), /provenance is not declared/);
});

test('legacy content fails strict validation and passes once migrated', () => {
  for (const name of SHIPPED) {
    const legacy = asLegacy(name);
    assert.equal(detectStateContentVersion(legacy), STATE_CONTENT_LEGACY_VERSION);
    const strict = validateStateContent(legacy);
    assert.equal(strict.ok, false, 'un-migrated content must not pass: if it does, migration is optional');
    assert.equal(strict.errors.length, 1, `one precise error, not a cascade: ${strict.errors.join('; ')}`);
    assert.match(strict.errors[0], /legacy v0 content, migrate it/);

    const migration = migrateStateContent(legacy);
    assert.equal(migration.from, STATE_CONTENT_LEGACY_VERSION);
    assert.equal(migration.to, STATE_CONTENT_SCHEMA_VERSION);
    assert.equal(migration.migrated, true);
    assert.deepEqual(migration.problems, []);
    assert.equal(migration.data.schemaVersion, STATE_CONTENT_SCHEMA_VERSION);
    assert.equal(migration.data.stateId, legacy.stateId, 'migration must not rename anything');
    assert.equal(migration.data.stateName, legacy.stateName, 'migration must not rewrite display names');
    assert.deepEqual(validateStateContent(migration.data).errors, []);
    // ...and the migrated file must be exactly what ships, or the two paths that
    // produce v1 content have already drifted.
    assert.deepEqual(migration.data, shipped(name));
  }
});

test('migration is a no-op on current content and never mutates its input', () => {
  const data = shipped('kerala');
  const before = JSON.stringify(data);
  const result = migrateStateContent(data);
  assert.equal(result.migrated, false);
  assert.equal(result.data, data, 'a current file is returned by reference, so a caller can detect the no-op cheaply');
  assert.deepEqual(result.notes, []);
  assert.equal(JSON.stringify(data), before, 'migration must not mutate the caller\'s object');
});

test('migration repairs coincident voxels and mixed hex case, and says so', () => {
  const legacy = asLegacy('kerala', data => {
    const item = data.collectibles[0];
    item.voxels.push([...item.voxels[0]]);                       // exact duplicate: z-fighting, pure waste
    item.voxels.push([item.voxels[1][0], item.voxels[1][1], item.voxels[1][2], '#000000']); // same cell, different colour
    item.voxels[2][3] = item.voxels[2][3].toUpperCase();
  });
  const migration = migrateStateContent(legacy);
  const migrated = migration.data.collectibles[0];
  assert.equal(migrated.voxels.length, legacy.collectibles[0].voxels.length - 2);
  assert.equal(migration.notes.length, 2);
  assert.match(migration.notes[0], /removed 2 coincident voxel\(s\)/);
  assert.match(migration.notes[1], /different colour — the first colour was kept/);
  assert.equal(migrated.voxels.some(voxel => voxel[3] === voxel[3].toUpperCase() && /[A-F]/.test(voxel[3])), false, 'hex case must be normalised');
  const report = validateStateContent(migration.data);
  assert.deepEqual(report.errors, [], 'a repaired file must validate');
});

test('migration refuses the future and converges deterministically', () => {
  const future = { ...validPack(), schemaVersion: STATE_CONTENT_SCHEMA_VERSION + 1 };
  const refused = migrateStateContent(future);
  assert.equal(refused.migrated, false);
  assert.equal(refused.problems.length, 1);
  assert.match(refused.problems[0], /newer schema/);
  assert.equal(validateStateContent(future).ok, false, 'a future file must not validate against an older schema either');

  assert.equal(detectStateContentVersion({ schemaVersion: '1' }), null);
  assert.equal(detectStateContentVersion(null), null);
  assert.equal(detectStateContentVersion({}), STATE_CONTENT_LEGACY_VERSION);

  // The ladder must be a strictly increasing chain ending at the current version,
  // so adding v2 is a new step rather than an edit to v1.
  const steps = STATE_CONTENT_MIGRATION_STEPS;
  assert.equal(steps[0].from, STATE_CONTENT_LEGACY_VERSION);
  assert.equal(steps.at(-1).to, STATE_CONTENT_SCHEMA_VERSION);
  for (let index = 1; index < steps.length; index += 1) {
    assert.equal(steps[index].from, steps[index - 1].to, 'the ladder must not have gaps');
  }
});

test('validation names the field for every error class it claims to catch', () => {
  // One case per rule. Each asserts the message, because "invalid content" with no
  // field name is a message an author cannot act on.
  const cases = [
    ['missing stateId', validPack({ stateId: undefined }), /state\.stateId is required/],
    ['bad stateId', validPack({ stateId: 'Kerala State' }), /state\.stateId must match/],
    ['blank stateName', validPack({ stateName: '   ' }), /state\.stateName must be a non-empty string/],
    ['no collectibles', validPack({ collectibles: [] }), /collectibles is empty/],
    ['collectibles not a list', validPack({ collectibles: {} }), /state\.collectibles must be an array of collectible\[\]/],
    ['unknown root field', validPack({ terrain: {} }), /state\.terrain is not part of schema v1/],
    ['unknown item field', brokenCollectible({ lootTable: [] }), /state\.collectibles\[0\]\.lootTable is not part of schema v1/],
    ['duplicate id', { ...validPack(), collectibles: [validPack().collectibles[0], { ...validPack().collectibles[0], name: 'Other' }] }, /duplicates collectible\[0\]/],
    ['bad buff type', brokenCollectible({ buff: { type: 'speeed', multiplier: 1, duration: 1000 } }), /buff\.type must be one of speed, jump, shield, stamina, focus/],
    ['zero multiplier', brokenCollectible({ buff: { type: 'speed', multiplier: 0, duration: 1000 } }), /buff\.multiplier must be a positive finite number/],
    ['fractional duration', brokenCollectible({ buff: { type: 'speed', multiplier: 1, duration: 1500.5 } }), /buff\.duration must be an integer/],
    ['duration over cap', brokenCollectible({ buff: { type: 'speed', multiplier: 1, duration: STATE_CONTENT_LIMITS.buffDurationMs + 1 } }), /over the 60000ms limit/],
    ['multiplier over cap', brokenCollectible({ buff: { type: 'speed', multiplier: 11, duration: 1000 } }), /over the 10 limit/],
    ['missing spawn', brokenCollectible({ spawnPosition: undefined }), /spawnPosition is required/],
    ['NaN spawn axis', brokenCollectible({ spawnPosition: { x: 0, y: Number.NaN, z: 0 } }), /spawnPosition\.y must be a finite number/],
    ['no voxels', brokenCollectible({ voxels: [] }), /voxels is empty/],
    ['voxel not a tuple', brokenCollectible({ voxels: [[0, 0, 0]] }), /voxels\[0\] must be a \[x, y, z, colour\] tuple/],
    ['fractional voxel', brokenCollectible({ voxels: [[0.5, 0, 0, '#112233']] }), /voxels\[0\]\[0\] must be an integer/],
    ['short hex', brokenCollectible({ voxels: [[0, 0, 0, '#fff']] }), /voxels\[0\]\[3\] must be a six-digit hex colour/],
    ['duplicate voxel', brokenCollectible({ voxels: [[0, 0, 0, '#112233'], [0, 0, 0, '#112233']] }), /repeats coordinate 0,0,0: coincident boxes z-fight/],
    ['conflicting voxel', brokenCollectible({ voxels: [[0, 0, 0, '#112233'], [0, 0, 0, '#445566']] }), /with a different colour \(#112233 vs #445566\)/],
    ['long icon', brokenCollectible({ icon: 'this is not an icon' }), /an icon is one glyph/],
    ['long description', brokenCollectible({ description: 'x'.repeat(STATE_CONTENT_LIMITS.descriptionLength + 1) }), /over the 240-character limit/],
    ['too many items', validPack({ collectibles: Array.from({ length: STATE_CONTENT_LIMITS.collectiblesPerState + 1 }, (_, index) => ({ ...validPack().collectibles[0], id: `item_${index}`, spawnPosition: { x: index * 4, y: 1, z: 0 } })) }), /over the cap of 64/],
    ['same spawn point', { ...validPack(), collectibles: [validPack().collectibles[0], { ...validPack().collectibles[0], id: 'second' }] }, /the same point as collectible\[0\]/],
    ['not an object', [], /a state file must be a JSON object/],
    ['bad version type', validPack({ schemaVersion: 'one' }), /schemaVersion must be an integer when present/],
  ];
  for (const [label, data, pattern] of cases) {
    const report = validateStateContent(data);
    assert.equal(report.ok, false, `${label}: expected a failure`);
    assert.match(report.errors.join(' | '), pattern, `${label}: ${report.errors.join(' | ')}`);
  }
  // The valid control: without it, a validator that rejected everything would pass
  // every case above.
  assert.equal(validateStateContent(validPack()).ok, true);
});

test('validation reports every problem at once rather than stopping at the first', () => {
  const broken = brokenCollectible({
    icon: 'way too many glyphs',
    buff: { type: 'nope', multiplier: 0, duration: -5 },
    voxels: [],
  });
  const report = validateStateContent(broken);
  assert.equal(report.ok, false);
  const joined = report.errors.join(' | ');
  for (const field of ['buff.type', 'buff.multiplier', 'icon', 'voxels']) {
    assert.match(joined, new RegExp(field.replace('.', '\\.')), `every problem must be reported, missing ${field}: ${joined}`);
  }
  // Duration -5 is an integer, so it is not among the errors — the validator does
  // not invent a rule for it. Asserted so the list above stays honest.
  assert.equal(/buff\.duration/.test(joined), false);
});

test('advisory warnings fire on drift without blocking a build', () => {
  const drifted = brokenCollectible({ description: 'Now +3x Speed for 9s' });
  const report = validateStateContent(drifted);
  assert.equal(report.ok, true, 'a stale description is a quality problem, not an invalid file');
  const drift = report.warnings.filter(warning => /description says/.test(warning));
  assert.equal(drift.length, 2, report.warnings.join(' | '));
  assert.match(drift.join(' '), /description says "3x" but buff\.multiplier is 2/);
  assert.match(drift.join(' '), /description says 9s but buff\.duration is 5000ms/);

  // Agreeing numbers stay silent — otherwise the warning is noise on real content.
  assert.deepEqual(validateStateContent(validPack()).warnings.filter(warning => /description says/.test(warning)), []);

  // A cluster inside the pickup radius cannot be collected apart.
  const clustered = validPack();
  clustered.collectibles.push({ ...clustered.collectibles[0], id: 'twin', spawnPosition: { x: 1, y: 1, z: 0 } });
  const clusterReport = validateStateContent(clustered);
  assert.equal(clusterReport.ok, true);
  assert.match(clusterReport.warnings.join(' '), /spawn 1\.00 units apart, inside the 1\.8-unit pickup radius/);

  // An authoring origin that is not the origin: the runtime re-centres, so the
  // numbers do not anchor what the author probably thinks they do.
  const offset = brokenCollectible({ voxels: [[5, 5, 5, '#112233'], [6, 5, 5, '#445566']] });
  assert.match(validateStateContent(offset).warnings.join(' '), /starts at \(5, 5, 5\) rather than the origin/);
});

test('declared-optional blocks are validated when present', () => {
  const withBounds = validPack({ bounds: { min: { x: -20, y: 0, z: -20 }, max: { x: 20, y: 10, z: 20 } } });
  assert.equal(validateStateContent(withBounds).ok, true, errorsOf(withBounds));
  assert.equal(validateStateContent(withBounds).warnings.some(warning => /bounds is not declared/.test(warning)), false);

  const outside = validPack({ bounds: { min: { x: 5, y: 0, z: -20 }, max: { x: 20, y: 10, z: 20 } } });
  assert.match(errorsOf(outside), /spawnPosition .* is outside state\.bounds/);
  assert.match(errorsOf(validPack({ bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 1, z: 1 } } })), /max\.x must be greater than state\.bounds\.min\.x/);
  assert.match(errorsOf(validPack({ bounds: { min: { x: 0, y: 0 }, max: { x: 1, y: 1, z: 1 } } })), /bounds\.min\.z must be a finite number/);

  const provenance = validPack({ provenance: { author: 'A contributor', reviewStatus: 'reviewed', sources: ['field notes'], contentWarnings: ['flashing colours'] } });
  assert.equal(validateStateContent(provenance).ok, true, errorsOf(provenance));
  assert.equal(validateStateContent(provenance).warnings.some(warning => /provenance is not declared/.test(warning)), false);
  assert.match(errorsOf(validPack({ provenance: { reviewStatus: 'probably fine' } })), /reviewStatus must be unreviewed, in-review or reviewed/);
  assert.match(errorsOf(validPack({ provenance: { sources: 'a book' } })), /provenance\.sources must be an array/);
  assert.match(errorsOf(validPack({ provenance: { reviewer: 'x' } })), /provenance\.reviewer is not part of schema v1/);

  // Presentation colours are declared and checked but not yet applied by the
  // loader; the shipped packs carry them, so a wrong one must be caught.
  assert.match(errorsOf(validPack({ bgColor: 'dark green' })), /state\.bgColor must be a six-digit hex colour/);
});

test('parseStateContent throws with every problem, and checks the file name', () => {
  const good = parseStateContent(shippedSource('kerala'), { sourceName: 'kerala.json' });
  assert.equal(good.content.stateId, 'kerala');
  assert.equal(good.report.migratedFrom, null, 'the shipped file is already current');
  assert.equal(good.report.namespace, featureNamespace('contentSchema'));
  assert.equal(good.report.warnings.length, 2);
  assert.equal(good.report.errors.length, 0);

  // Legacy input migrates on the way through, and the report says so.
  const migrated = parseStateContent(JSON.stringify(asLegacy('maharashtra')), { sourceName: 'maharashtra.json' });
  assert.equal(migrated.report.migratedFrom, STATE_CONTENT_LEGACY_VERSION);
  assert.equal(migrated.report.schemaVersion, STATE_CONTENT_SCHEMA_VERSION);

  // A renamed file whose id still says the old name is caught: the id is the key.
  assert.throws(
    () => parseStateContent(shippedSource('kerala'), { sourceName: 'kerala-2.json' }),
    error => error instanceof StateContentError && /declares stateId "kerala" but lives at "kerala-2"/.test(error.message),
  );
  assert.throws(() => parseStateContent('{ not json', { sourceName: 'broken.json' }),
    error => error instanceof StateContentError && /is not valid JSON/.test(error.message) && error.problems.length === 1);
  assert.throws(() => parseStateContent(JSON.stringify(brokenCollectible({ voxels: [] }))),
    error => error instanceof StateContentError && /voxels is empty/.test(error.message) && error.problems.length >= 1);
  assert.throws(() => parseStateContent(JSON.stringify({ ...validPack(), schemaVersion: 99 })),
    error => error instanceof StateContentError && /cannot be migrated/.test(error.message));
  assert.throws(() => assertStateContent(brokenCollectible({ icon: 'nope nope nope' })), StateContentError);
  assert.equal(assertStateContent(validPack()).ok, true);
});

test('loadStateContent validates what it fetches, and fails loudly', async () => {
  const fetched = [];
  const ok = await loadStateContent('/content/states/kerala.json', {
    fetchImpl: async url => { fetched.push(url); return { ok: true, status: 200, text: async () => shippedSource('kerala') }; },
  });
  assert.deepEqual(fetched, ['/content/states/kerala.json']);
  assert.equal(ok.content.collectibles.length, 2);
  assert.equal(ok.report.schemaVersion, STATE_CONTENT_SCHEMA_VERSION);

  await assert.rejects(
    () => loadStateContent('/content/states/missing.json', { fetchImpl: async () => ({ ok: false, status: 404, statusText: 'Not Found' }) }),
    error => error instanceof StateContentError && /Failed to load state content from \/content\/states\/missing\.json: 404 Not Found/.test(error.message),
  );
  await assert.rejects(
    () => loadStateContent('/content/states/kerala.json', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(brokenCollectible({ voxels: [] })) }) }),
    error => error instanceof StateContentError && /State content is invalid against schema v1/.test(error.message),
  );
  // A network failure inside fetch itself propagates rather than being swallowed
  // into a half-loaded state.
  await assert.rejects(() => loadStateContent('/content/states/kerala.json', { fetchImpl: async () => { throw new Error('offline'); } }), /offline/);
  await assert.rejects(() => loadStateContent('/x.json', { fetchImpl: null }), error =>
    error instanceof StateContentError && /needs a fetch implementation/.test(error.message));
  // An explicit non-function is refused rather than silently using the global one.
  assert.equal(typeof globalThis.fetch, 'function', 'the default in the call above relies on a global fetch');
});
