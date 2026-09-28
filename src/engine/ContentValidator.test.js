import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GDO_CONTENT_CHECK_IDS,
  GDO_CONTENT_VALIDATOR_LIMITS,
  GDO_CONTENT_VALIDATOR_NAMESPACE,
  formatValidatorReport,
  renderModulePreview,
  validateContentPack,
  validateLandmarkRecipe,
} from './ContentValidator.js';
import { featureNamespace } from './FeatureVersions.js';
import { GDO_CONTENT_SCHEMA_VERSION } from './ContentSchema.js';
import { GDO_CURATED_LANDMARKS } from '../reference/landmarkRecipes.js';
import {
  createContentValidatorExtras,
  describeContentInput,
  runContentCheck,
  summariseContentReport,
} from './ContentValidatorTool.js';
import { installDebugHooks } from './DebugHooks.js';
import { GDO_RECIPE_LIMITS, compileLandmarkRecipe } from './RecipeCompiler.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

/**
 * `CNT-03` gate: a contributor's data is checked before it reaches the runtime —
 * bounds, budgets, attribution, openings, and determinism — and the report is
 * printable, with a bounded preview a reviewer can read.
 */

const readPack = name => JSON.parse(
  readFileSync(new URL(`../../public/content/states/${name}.json`, import.meta.url), 'utf8'));
const REAL_PROVIDERS = JSON.parse(
  readFileSync(new URL('../../public/map-providers.json', import.meta.url), 'utf8')).providers;

function minimalPack(overrides = {}) {
  return {
    schemaVersion: GDO_CONTENT_SCHEMA_VERSION,
    stateId: 'teststate',
    stateName: 'Test State',
    bgColor: '#112233',
    collectibles: [{
      id: 'test_item',
      name: 'Test Item',
      description: 'A test pick-up',
      icon: '🍌',
      buff: { type: 'speed', multiplier: 1.5, duration: 12_000 },
      spawnPosition: { x: 4, y: 1, z: -4 },
      voxels: [[0, 0, 0, '#D4A017'], [1, 0, 0, '#C8941A'], [0, 0, 1, '#D4A017']],
    }],
    ...overrides,
  };
}

const check = (report, id) => report.checks.find(entry => entry.id === id);

test('the validator is declared, versioned, and checks in a fixed order', () => {
  assert.equal(GDO_CONTENT_VALIDATOR_NAMESPACE, featureNamespace('contentValidator'));
  assert.equal(GDO_CONTENT_VALIDATOR_NAMESPACE, 'gdo:contentValidator:v1');
  assert.deepEqual([...GDO_CONTENT_CHECK_IDS],
    ['schema', 'bounds', 'budget', 'attribution', 'openings', 'determinism']);
  const report = validateContentPack(minimalPack());
  assert.equal(report.namespace, GDO_CONTENT_VALIDATOR_NAMESPACE);
  assert.equal(report.kind, 'state-pack');
  assert.equal(report.id, 'teststate');
  assert.deepEqual(report.checks.map(entry => entry.id), [...GDO_CONTENT_CHECK_IDS]);
  assert.equal(report.ok, true);
  assert.match(report.fingerprint, /^[0-9a-f]{8}$/);
  assert.throws(() => validateContentPack(minimalPack(), { bounds: { minX: 0, maxX: NaN, minZ: 0, maxZ: 1 } }),
    /four finite edges/);
});

test('a shipped pack passes every applicable check and prints a readable preview', () => {
  for (const name of ['kerala', 'maharashtra']) {
    const report = validateContentPack(readPack(name), { providers: REAL_PROVIDERS });
    assert.equal(report.ok, true, formatValidatorReport(report).join('\n'));
    assert.equal(check(report, 'schema').ok, true);
    assert.equal(check(report, 'bounds').ok, true);
    assert.equal(check(report, 'budget').ok, true);
    assert.equal(check(report, 'attribution').skipped, true, 'the pack lists no mapped sources');
    assert.equal(check(report, 'openings').skipped, true, 'the pack declares no landmarks');
    assert.equal(check(report, 'determinism').ok, true);
    assert.equal(report.compiled.collectibles.length, readPack(name).collectibles.length);
    // The preview is bounded, printable, and legend-complete.
    assert.ok(report.preview.columns <= GDO_CONTENT_VALIDATOR_LIMITS.maxPreviewWidth);
    assert.ok(report.preview.rows <= GDO_CONTENT_VALIDATOR_LIMITS.maxPreviewHeight);
    assert.equal(report.preview.lines.length, report.preview.rows);
    assert.equal(report.preview.lines.every(line => line.length === report.preview.columns), true);
    const glyphs = new Set(report.preview.lines.join('').replace(/ /g, '').split(''));
    for (const glyph of glyphs) {
      assert.ok(report.preview.legend.some(entry => entry.glyph === glyph), `${glyph} is in the legend`);
    }
    assert.equal(report.preview.legend.reduce((total, entry) => total + entry.modules, 0),
      report.compiled.collectibles[0].modules.length);
    const lines = formatValidatorReport(report).join('\n');
    assert.match(lines, /preview \d+×\d+:/);
    assert.match(lines, /fingerprint: [0-9a-f]{8}/);
  }
});

test('a refused pack skips the later checks instead of claiming they passed', () => {
  const pack = minimalPack();
  pack.collectibles[0].buff.multiplier = 99;
  const report = validateContentPack(pack);
  assert.equal(report.ok, false);
  assert.equal(check(report, 'schema').ok, false);
  assert.match(check(report, 'schema').detail, /collectibles\[0\]\.buff\.multiplier:out-of-range/);
  assert.equal(report.compiled, null);
  assert.equal(report.preview, null);
  assert.equal(report.fingerprint, null);
  for (const id of GDO_CONTENT_CHECK_IDS.slice(1)) {
    assert.equal(check(report, id).skipped, true, `${id} is skipped`);
    assert.match(check(report, id).detail, /did not pass the schema check/);
  }
  assert.equal(report.errors.length > 0, true);
  assert.equal(formatValidatorReport(report).join('\n').includes('FAIL'), true);
});

test('bounds catch an out-of-area spawn and an overlapping pair', () => {
  const wide = validateContentPack(minimalPack(), { bounds: { minX: 0, maxX: 2, minZ: 0, maxZ: 2 } });
  assert.equal(check(wide, 'bounds').ok, false);
  assert.match(check(wide, 'bounds').detail, /test_item: spawn \(4, -4\) is outside the declared bounds/);

  const crowded = minimalPack({
    collectibles: [
      { ...minimalPack().collectibles[0], id: 'first', spawnPosition: { x: 0, y: 1, z: 0 } },
      { ...minimalPack().collectibles[0], id: 'second', spawnPosition: { x: 0, y: 1, z: .5 } },
    ],
  });
  const report = validateContentPack(crowded);
  assert.equal(check(report, 'bounds').ok, false);
  assert.match(check(report, 'bounds').detail, /first and second are 0\.50 units apart/);
  assert.equal(check(report, 'bounds').measured.minimumSeparation, .5);
  assert.equal(report.ok, false);
  // The very same pair separated properly passes.
  const spread = minimalPack({
    collectibles: [
      { ...minimalPack().collectibles[0], id: 'first', spawnPosition: { x: 0, y: 1, z: 0 } },
      { ...minimalPack().collectibles[0], id: 'second', spawnPosition: { x: 6, y: 1, z: 0 } },
    ],
  });
  assert.equal(check(validateContentPack(spread), 'bounds').ok, true);
});

test('the budget check fails on real compiled counts, not on declared ones', () => {
  // A landmark recipe that overflows its per-recipe ceiling is trimmed by the
  // compiler, and the validator reports the pruning as a budget failure.
  const overfull = minimalPack({
    landmarks: [{
      id: 'overfull', modules: [
        { op: 'tier', id: 'overfull:a:{index}', count: 256, at: [0, 0, 0], step: [0, 1, 0], size: [4, 1, 4] },
        { op: 'tier', id: 'overfull:b:{index}', count: 256, at: [0, 0, 0], step: [0, 1, 0], size: [4, 1, 4] },
        { op: 'tier', id: 'overfull:c:{index}', count: 256, at: [0, 0, 0], step: [0, 1, 0], size: [4, 1, 4] },
      ],
    }],
  });
  const report = validateContentPack(overfull, { profile: 'low' });
  assert.equal(check(report, 'budget').ok, false);
  assert.match(check(report, 'budget').detail, /modules were pruned by the compiler/);
  assert.equal(check(report, 'budget').measured.largestRecipe, 512);
  assert.equal(check(report, 'budget').limit.contentRecipeModulesPerRecipe, 512);
  assert.equal(report.ok, false);
  // On a profile with room the same recipe is not trimmed, and the check says
  // so with the measured count rather than inventing a failure: the ceiling in
  // force is the profile's, and a low-profile device is never handed a pack it
  // cannot afford.
  const roomy = check(validateContentPack(overfull, { profile: 'high' }), 'budget');
  assert.equal(roomy.ok, true);
  assert.equal(roomy.measured.largestRecipe, 768);
  assert.equal(roomy.measured.modules, 768 + 3);
  assert.equal(roomy.limit.contentRecipeModulesPerRecipe, 2_048);
  assert.match(roomy.detail, /needs the high profile: low-profile devices would prune it/);
  assert.equal(roomy.advisory.includes('high profile'), true);
  // The two declarations of the low-profile ceiling agree, so the tool and the
  // shipped budget cannot say different things about the same device.
  assert.equal(GDO_LOW_PROFILE_BUDGETS.contentRecipeModulesPerRecipe,
    GDO_RECIPE_LIMITS.profiles.low.maxModulesPerRecipe);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.contentRecipeModules,
    GDO_RECIPE_LIMITS.profiles.low.maxModulesPerPack);
  // And a pack that fits the low profile carries no such advisory.
  const plain = check(validateContentPack(minimalPack()), 'budget');
  assert.equal(plain.ok, true);
  assert.equal(plain.advisory, null);
});

test('attribution is verified against the real provider table', () => {
  const sourced = minimalPack({ sources: ['openfreemap'], attribution: '© OpenStreetMap contributors' });
  const unverified = validateContentPack(sourced);
  assert.equal(check(unverified, 'attribution').ok, false);
  assert.match(check(unverified, 'attribution').detail, /no provider table was supplied/);

  const verified = validateContentPack(sourced, { providers: REAL_PROVIDERS });
  assert.equal(check(verified, 'attribution').ok, true);
  assert.deepEqual([...check(verified, 'attribution').credits],
    ['© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap']);

  const unknown = validateContentPack(minimalPack({ sources: ['somebody-else'], attribution: 'x' }),
    { providers: REAL_PROVIDERS });
  assert.equal(check(unknown, 'attribution').ok, false);
  assert.match(check(unknown, 'attribution').detail, /somebody-else: unknown provider/);

  const uncredited = validateContentPack(minimalPack({ sources: ['shortbread-nowhere'] }), { providers: REAL_PROVIDERS });
  assert.equal(check(uncredited, 'attribution').ok, false);
});

test('openings are probed, and intruding masonry fails the check', () => {
  // The shipped gateway recipe is clean: nothing intrudes into its arch.
  const gateway = validateLandmarkRecipe(GDO_CURATED_LANDMARKS.gateway);
  assert.equal(gateway.kind, 'landmark');
  assert.equal(gateway.ok, true, formatValidatorReport(gateway).join('\n'));
  assert.equal(check(gateway, 'openings').ok, true);
  assert.match(check(gateway, 'openings').detail, /1 openings probed clear along both axes/);
  assert.equal(check(gateway, 'openings').measured.probes, 2);
  assert.equal(gateway.compiled[0].openings[0].enclosedModules.length, 0);
  assert.equal(check(gateway, 'attribution').skipped, true);
  // A pinned fingerprint that no longer matches fails determinism by name.
  const pinned = validateLandmarkRecipe(GDO_CURATED_LANDMARKS.gateway, { expectedFingerprints: 'deadbeef' });
  assert.equal(check(pinned, 'determinism').ok, false);
  assert.match(check(pinned, 'determinism').detail, /does not match the pinned deadbeef/);
  assert.equal(check(validateLandmarkRecipe(GDO_CURATED_LANDMARKS.gateway,
    { expectedFingerprints: gateway.fingerprint }), 'determinism').ok, true);

  // A block that protrudes into the opening without being enclosed is caught.
  const intruding = {
    id: 'intruding',
    openings: [{ id: 'intruding:arch', at: [0, 3, 0], size: [6, 6, 6] }],
    modules: [
      { op: 'box', id: 'intruding:pier:-1', at: [-4, 3, 0], size: [2, 6, 6] },
      { op: 'box', id: 'intruding:pier:1', at: [4, 3, 0], size: [2, 6, 6] },
      // Partly inside the opening, partly above it: not enclosed, still in the
      // way — which is exactly what the sweep probe is for.
      { op: 'box', id: 'intruding:stub', at: [0, 4, 0], size: [6, 8, 2] },
    ],
  };
  const report = validateLandmarkRecipe(intruding, { bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 } });
  assert.equal(check(report, 'openings').ok, false);
  assert.match(check(report, 'openings').detail, /intruding:stub intrudes into the opening/);
  assert.equal(report.compiled[0].openings[0].enclosedModules.length, 0, 'the stub is not enclosed');
  assert.equal(check(report, 'openings').measured.probes, 2, 'both axes of the opening are swept');
  // A module the compiler had to drop as enclosed is reported as an authoring
  // error too: the data promised masonry the compile did not produce.
  const swallowed = {
    id: 'swallowed',
    openings: [{ id: 'swallowed:arch', at: [0, 3, 0], size: [6, 6, 6] }],
    modules: [
      { op: 'box', id: 'swallowed:pier:-1', at: [-4, 3, 0], size: [2, 6, 6] },
      { op: 'box', id: 'swallowed:pier:1', at: [4, 3, 0], size: [2, 6, 6] },
      { op: 'box', id: 'swallowed:lump', at: [0, 3, 0], size: [1, 1, 1] },
    ],
  };
  const swallowedReport = validateLandmarkRecipe(swallowed);
  assert.equal(swallowedReport.compiled[0].openings[0].enclosedModules.length, 1);
  assert.equal(swallowedReport.modules, undefined);
  assert.match(check(swallowedReport, 'openings').detail, /1 declared module\(s\) sit inside the opening and were dropped/);
  assert.equal(check(swallowedReport, 'openings').measured.enclosed, 1);
  assert.equal(check(report, 'bounds').ok, true);
  assert.equal(report.ok, false);
  // A compiled landmark that leaves its declared area fails bounds by name.
  const escaped = validateLandmarkRecipe(GDO_CURATED_LANDMARKS.gateway,
    { bounds: { minX: 0, maxX: 10, minZ: 0, maxZ: 10 } });
  assert.equal(check(escaped, 'bounds').ok, false);
  assert.match(check(escaped, 'bounds').detail, /leave the declared area/);
  // And a recipe that cannot compile never reaches the later checks.
  const broken = validateLandmarkRecipe({ id: 'broken', modules: [{ op: 'sphere' }] });
  assert.equal(check(broken, 'schema').ok, false);
  assert.match(check(broken, 'schema').detail, /Unknown recipe op: sphere/);
  assert.equal(check(broken, 'budget').skipped, true);
});

test('the preview is bounded, legend-true, and refuses an empty recipe', () => {
  const compiled = compileLandmarkRecipe(GDO_CURATED_LANDMARKS.chariot);
  const preview = renderModulePreview(compiled, { width: 999, height: 999 });
  assert.ok(preview.columns <= GDO_CONTENT_VALIDATOR_LIMITS.maxPreviewWidth);
  assert.ok(preview.rows <= GDO_CONTENT_VALIDATOR_LIMITS.maxPreviewHeight);
  assert.ok(preview.columns >= 4 && preview.rows >= 2);
  assert.equal(preview.lines.length, preview.rows);
  assert.equal(preview.lines.every(line => line.length === preview.columns), true);
  assert.equal(preview.legend.reduce((total, entry) => total + entry.modules, 0), compiled.modules.length);
  assert.equal(preview.legend.every(entry => entry.glyph.length === 1 && entry.modules > 0), true);
  // A large compound is capped, and the cap is a hard bound rather than a scale.
  const spread = {
    id: 'spread',
    modules: Array.from({ length: 4 }, (_, index) => ({
      id: `spread:${index}`, color: '#010203',
      x: index * 100, y: 0, z: index * 100,
      minX: index * 100 - .5, maxX: index * 100 + .5,
      minY: -.5, maxY: .5, minZ: index * 100 - .5, maxZ: index * 100 + .5,
      sizeX: 1, sizeY: 1, sizeZ: 1,
    })),
  };
  const capped = renderModulePreview(spread);
  assert.equal(capped.columns, GDO_CONTENT_VALIDATOR_LIMITS.maxPreviewWidth);
  assert.equal(capped.rows, GDO_CONTENT_VALIDATOR_LIMITS.maxPreviewHeight);
  assert.equal(capped.lines.length, GDO_CONTENT_VALIDATOR_LIMITS.maxPreviewHeight);
  assert.throws(() => renderModulePreview({ modules: [] }), /compiled recipe with modules/);
  assert.throws(() => renderModulePreview(null), /compiled recipe with modules/);
});

test('the tool surface decides what it was handed and reports it the same way', () => {
  assert.equal(describeContentInput(minimalPack()), 'state-pack');
  assert.equal(describeContentInput({ stateId: 'x', collectibles: [] }), 'state-pack');
  assert.equal(describeContentInput(GDO_CURATED_LANDMARKS.chariot), 'landmark');
  assert.equal(describeContentInput([GDO_CURATED_LANDMARKS.gateway, GDO_CURATED_LANDMARKS.chariot]), 'landmark');
  assert.throws(() => describeContentInput([]), /at least one landmark recipe/);
  assert.throws(() => describeContentInput(null), /needs a state pack or a landmark recipe/);
  assert.throws(() => describeContentInput({ nothing: true }), /with `collectibles`/);
  assert.throws(() => describeContentInput('kerala.json'), /needs a state pack or a landmark recipe/);

  const pack = runContentCheck(readPack('kerala'), { providers: REAL_PROVIDERS });
  assert.equal(pack.ok, true);
  assert.equal(pack.kind, 'state-pack');
  assert.equal(pack.id, 'kerala');
  assert.match(pack.text, /gdo:contentValidator:v1 · state-pack kerala/);
  assert.deepEqual([...pack.checkIds], [...GDO_CONTENT_CHECK_IDS]);
  assert.deepEqual([...pack.summary.failed], []);
  assert.deepEqual([...pack.summary.skipped], ['attribution', 'openings']);
  assert.equal(pack.report.preview.lines.length > 0, true);

  const landmark = runContentCheck(GDO_CURATED_LANDMARKS.gateway, { preview: false });
  assert.equal(landmark.ok, true);
  assert.equal(landmark.kind, 'landmark');
  assert.equal(landmark.report.preview, null);
  assert.equal(landmark.summary.checks.length, GDO_CONTENT_CHECK_IDS.length);
  assert.equal(landmark.summary.checks.every(entry => ['pass', 'skip', 'fail'].includes(entry.state)), true);

  const broken = runContentCheck({ collectibles: 'not-an-array', stateId: 'x' });
  assert.equal(broken.ok, false);
  assert.deepEqual([...broken.summary.failed], ['schema']);
  assert.match(broken.summary.checks[0].detail, /collectibles:/);

  const summary = summariseContentReport(pack.report);
  assert.equal(summary.fingerprint, pack.report.fingerprint);
  assert.equal(Object.isFrozen(summary.checks), true);
  assert.equal(Object.isFrozen(summary.checks[0]), true);
});

test('the page installs the content tool on the debug hook, reachable from a console', () => {
  const target = {};
  const providerTable = REAL_PROVIDERS;
  const installed = installDebugHooks(target, {
    extras: createContentValidatorExtras({ providers: providerTable }),
  });
  assert.equal(installed.enabled, true);
  const hook = target.__gdo;
  assert.deepEqual(hook.contentChecks(), [...GDO_CONTENT_CHECK_IDS]);
  const sourced = minimalPack({ sources: ['openfreemap'], attribution: '© OpenStreetMap contributors' });
  const verdict = hook.validateContent(sourced);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.kind, 'state-pack');
  assert.match(verdict.text, /\[pass\] attribution/);
  // A missing provider table is a real failure, and the hook reports it instead
  // of throwing out of the page.
  const unverified = createContentValidatorExtras().validateContent(sourced);
  assert.equal(unverified.ok, false);
  assert.deepEqual([...unverified.summary.failed], ['attribution']);
  // The preview is readable straight from the console.
  const preview = hook.previewContent(GDO_CURATED_LANDMARKS.chariot);
  assert.ok(preview.columns > 0 && preview.rows > 0);
  // Unusable input is answered, never thrown: a console typo cannot break the hook.
  const refused = hook.validateContent({ oops: true });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /input refused: .*needs a state pack \(with `collectibles`\) or a landmark recipe/);
  assert.equal(hook.previewContent({ oops: true }), null);
  assert.equal(hook.validateContent(null).error.includes('needs a state pack'), true);
  installed.hook.dispose();
  assert.equal('__gdo' in target, false);
});
