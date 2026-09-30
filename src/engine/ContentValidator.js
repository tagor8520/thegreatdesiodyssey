import { GDO_CONTENT_LIMITS, loadContentState } from './ContentSchema.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import {
  GDO_RECIPE_LIMITS,
  compileLandmarkRecipe,
  compileStatePack,
  recipeBudgetForProfile,
} from './RecipeCompiler.js';
import { featureNamespace } from './FeatureVersions.js';
import { GEO_QUERY_MASK } from '../geo/GeoCollision.js';
import { createStructureSweep } from './StructureSweep.js';

/**
 * `CNT-03` content validation and preview tool.
 *
 * A contributor's data must be checkable *before* it reaches the runtime, and a
 * reviewer must be able to see what it produced without a browser. This module
 * runs one ordered pass of named checks over a state pack or a landmark recipe
 * — schema, bounds, budget, attribution, openings, determinism — and returns a
 * printable report plus a bounded ASCII preview of the compiled modules.
 *
 * The checks are honest about scope: a check that cannot apply is reported as
 * skipped with its reason, a failing check names the exact item and value, and
 * nothing is silently repaired. No `three`, no DOM.
 */

export const GDO_CONTENT_VALIDATOR_NAMESPACE = featureNamespace('contentValidator');

/** Ordered check ids; the report always carries all of them, in this order. */
export const GDO_CONTENT_CHECK_IDS = Object.freeze([
  'schema', 'bounds', 'budget', 'attribution', 'openings', 'determinism',
]);

export const GDO_CONTENT_VALIDATOR_LIMITS = Object.freeze({
  minSpawnSeparation: 2,
  maxPreviewWidth: 32,
  maxPreviewHeight: 16,
  maxReportedErrors: 24,
  openingProbeRadius: .4,
  openingProbeMargin: .5,
});

const PREVIEW_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const failure = (id, detail, extra = {}) => Object.freeze({
  id, ok: false, skipped: false, detail, ...extra,
});
const pass = (id, detail, extra = {}) => Object.freeze({
  id, ok: true, skipped: false, detail, ...extra,
});
const skip = (id, reason) => Object.freeze({
  id, ok: true, skipped: true, detail: reason,
});

function spawnBounds(bounds) {
  const limit = GDO_CONTENT_LIMITS.maxSpawnCoordinate;
  const source = bounds ?? { minX: -limit, maxX: limit, minZ: -limit, maxZ: limit };
  if (![source.minX, source.maxX, source.minZ, source.maxZ].every(Number.isFinite)) {
    throw new TypeError('Validator bounds need four finite edges');
  }
  return Object.freeze({ ...source });
}

/**
 * `bounds`: every collectible (and landmark) spawns inside the declared playable
 * area and far enough from its neighbours that two pick-ups cannot overlap.
 */
function checkBounds(entries, bounds) {
  const problems = [];
  const measured = { entries: entries.length, minimumSeparation: Infinity };
  entries.forEach((entry, index) => {
    const spawn = entry.spawn;
    if (!spawn) { problems.push(`${entry.id}: missing spawn`); return; }
    if (spawn.x < bounds.minX || spawn.x > bounds.maxX || spawn.z < bounds.minZ || spawn.z > bounds.maxZ) {
      problems.push(`${entry.id}: spawn (${spawn.x}, ${spawn.z}) is outside the declared bounds`);
    }
    for (let other = index + 1; other < entries.length; other++) {
      const peer = entries[other].spawn;
      if (!peer) continue;
      const separation = Math.hypot(spawn.x - peer.x, spawn.z - peer.z);
      measured.minimumSeparation = Math.min(measured.minimumSeparation, separation);
      if (separation < GDO_CONTENT_VALIDATOR_LIMITS.minSpawnSeparation) {
        problems.push(`${entry.id} and ${entries[other].id} are ${separation.toFixed(2)} units apart, under the ${GDO_CONTENT_VALIDATOR_LIMITS.minSpawnSeparation}-unit minimum`);
      }
    }
  });
  measured.minimumSeparation = Number.isFinite(measured.minimumSeparation) ? measured.minimumSeparation : null;
  if (problems.length) return failure('bounds', problems.join('; '), { problems, measured, limit: bounds });
  return pass('bounds', `${entries.length} spawns inside the declared bounds`, { measured, limit: bounds });
}

/**
 * `budget`: the compiled module counts have to sit inside the profile ceilings,
 * measured from the compile rather than from the declared voxel lists. Pruning
 * is a failure, not a warning — content that arrives truncated is content the
 * contributor did not agree to. When the pack only fits a *higher* profile the
 * check still passes for that profile, but says so, because a low-profile device
 * would prune it.
 */
function checkBudget(pack, recipeCounts, profile) {
  const budget = recipeBudgetForProfile(profile);
  const measured = {
    modules: pack.diagnostics.modules,
    largestRecipe: recipeCounts.reduce((largest, entry) => Math.max(largest, entry), 0),
    recipes: recipeCounts.length,
    lowProfile: {
      contentRecipeModules: GDO_LOW_PROFILE_BUDGETS.contentRecipeModules,
      contentRecipeModulesPerRecipe: GDO_LOW_PROFILE_BUDGETS.contentRecipeModulesPerRecipe,
    },
  };
  // The ceiling in force is the profile's own; the shipped low-profile budgets
  // are reported alongside it so a reviewer sees both numbers. Each low-profile
  // declaration is checked against the compiler's low limits by the tests, so
  // the two can never drift apart silently.
  const limits = {
    contentRecipeModules: budget.maxModulesPerPack,
    contentRecipeModulesPerRecipe: budget.maxModulesPerRecipe,
  };
  const problems = [];
  if (measured.modules > limits.contentRecipeModules) {
    problems.push(`${measured.modules} modules are over the ${limits.contentRecipeModules}-module pack ceiling`);
  }
  if (measured.largestRecipe > limits.contentRecipeModulesPerRecipe) {
    problems.push(`the largest recipe has ${measured.largestRecipe} modules, over the ${limits.contentRecipeModulesPerRecipe}-module ceiling`);
  }
  if (pack.diagnostics.prunedModules > 0) {
    problems.push(`${pack.diagnostics.prunedModules} modules were pruned by the compiler`);
  }
  const needsHigherProfile = profile === 'low' ||
    (measured.modules <= GDO_LOW_PROFILE_BUDGETS.contentRecipeModules &&
      measured.largestRecipe <= GDO_LOW_PROFILE_BUDGETS.contentRecipeModulesPerRecipe)
    ? null
    : `this pack needs the ${profile} profile: low-profile devices would prune it`;
  if (problems.length) return failure('budget', problems.join('; '), { problems, measured, limit: limits });
  const detail = `${measured.modules} modules across ${recipeCounts.length} recipes` +
    (needsHigherProfile ? ` — ${needsHigherProfile}` : '');
  return pass('budget', detail, { measured, limit: limits, advisory: needsHigherProfile });
}

/**
 * `attribution`: anything that derives from a mapped provider has to carry that
 * provider's credit. A declared source is verified against the real provider
 * table — an unverifiable credit is a failure, not a warning.
 */
function checkAttribution(pack, providers) {
  const sources = Array.isArray(pack.sources) ? pack.sources : [];
  if (sources.length === 0) {
    return skip('attribution', 'the pack declares no mapped sources');
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    return failure('attribution', 'the pack declares mapped sources but no provider table was supplied to verify their credit',
      { measured: { sources: sources.length, credits: 0 } });
  }
  const problems = [];
  const credits = [];
  for (const source of sources) {
    const provider = providers.find(entry => entry?.id === source);
    if (!provider) { problems.push(`${source}: unknown provider`); continue; }
    const credit = typeof provider.attribution === 'string' ? provider.attribution.trim() : '';
    if (!credit) { problems.push(`${source}: no attribution text`); continue; }
    credits.push(credit);
  }
  const declared = typeof pack.attribution === 'string' ? pack.attribution.trim() : '';
  if (!declared) problems.push('the pack must declare its own `attribution` line when it lists sources');
  const measured = { sources: sources.length, credits: credits.length, declared: declared.length };
  if (problems.length) return failure('attribution', problems.join('; '), { problems, measured });
  return pass('attribution', `${credits.length} provider credits declared`, { measured, credits: Object.freeze(credits) });
}

/**
 * `openings`: a landmark's declared opening must actually be open. Every module
 * is handed to the real `COL-06` sweep — the same query the camera uses — and a
 * probe is swept along both of the opening's axes at its centre height, so
 * masonry that protrudes into a passage is caught even when it is not enclosed.
 * Modules the compiler dropped as enclosed are reported too: data that says one
 * thing and produces another is an authoring error, not a silent repair.
 */
function checkOpenings(compiledLandmarks, profile) {
  if (!Array.isArray(compiledLandmarks) || compiledLandmarks.length === 0) {
    return skip('openings', 'no landmark openings were declared');
  }
  const problems = [];
  const measured = { landmarks: compiledLandmarks.length, openings: 0, probes: 0, enclosed: 0 };
  for (const landmark of compiledLandmarks) {
    if (landmark.openings.length === 0) continue;
    const sweep = createStructureSweep({
      profile,
      boxes: landmark.modules.map(entry => ({
        min: { x: entry.minX, y: entry.minY, z: entry.minZ },
        max: { x: entry.maxX, y: entry.maxY, z: entry.maxZ },
        userData: { id: entry.id, role: 'camera-blocker' },
      })),
    });
    const out = {};
    for (const opening of landmark.openings) {
      measured.openings++;
      if (opening.enclosedModules.length) {
        measured.enclosed += opening.enclosedModules.length;
        problems.push(`${landmark.id}/${opening.id}: ${opening.enclosedModules.length} declared module(s) sit inside the opening and were dropped by the compiler`);
      }
      // Sweep just inside the opening's own span so the probe measures the
      // passage, never the masonry the opening was cut into.
      const margin = GDO_CONTENT_VALIDATOR_LIMITS.openingProbeMargin;
      const radius = GDO_CONTENT_VALIDATOR_LIMITS.openingProbeRadius;
      for (const axis of ['x', 'z']) {
        const half = (axis === 'x' ? opening.sizeX : opening.sizeZ) / 2;
        const reach = half - margin;
        measured.probes++;
        if (reach <= 0) {
          problems.push(`${landmark.id}/${opening.id}: the opening is narrower than the probe margin, so it cannot be walked`);
          continue;
        }
        sweep.querySweep(
          axis === 'x' ? opening.x - reach : opening.x, opening.y,
          axis === 'x' ? opening.z : opening.z - reach,
          axis === 'x' ? reach * 2 : 0, 0, axis === 'x' ? 0 : reach * 2,
          radius, out, GEO_QUERY_MASK.CAMERA_BLOCKER);
        if (out.hit) {
          problems.push(`${landmark.id}/${opening.id}: ${out.blockerId} intrudes into the opening (${axis} probe)`);
        }
      }
    }
  }
  if (problems.length) return failure('openings', problems.join('; '), { problems, measured });
  if (measured.openings === 0) return skip('openings', 'the landmarks declare no openings');
  return pass('openings', `${measured.openings} openings probed clear along both axes`, { measured });
}

/** `determinism`: a second compile must reproduce the first byte for byte. */
function checkDeterminism(compiled, expectedFingerprint) {
  const measured = { fingerprint: compiled.fingerprint, recompiled: null, expected: expectedFingerprint ?? null };
  const problems = [];
  if (compiled.recompiledFingerprint !== compiled.fingerprint) {
    measured.recompiled = compiled.recompiledFingerprint;
    problems.push(`recompiling produced ${compiled.recompiledFingerprint} instead of ${compiled.fingerprint}`);
  } else {
    measured.recompiled = compiled.fingerprint;
  }
  if (expectedFingerprint && expectedFingerprint !== compiled.fingerprint) {
    problems.push(`fingerprint ${compiled.fingerprint} does not match the pinned ${expectedFingerprint}`);
  }
  if (problems.length) return failure('determinism', problems.join('; '), { problems, measured });
  return pass('determinism', `stable fingerprint ${compiled.fingerprint}`, { measured });
}

/**
 * A bounded top-down preview: one character per colour family, aggregated over
 * height, with a legend. It is deliberately small so a reviewer can read it in
 * a terminal or a test diff.
 */
export function renderModulePreview(compiled, {
  width = GDO_CONTENT_VALIDATOR_LIMITS.maxPreviewWidth,
  height = GDO_CONTENT_VALIDATOR_LIMITS.maxPreviewHeight,
} = {}) {
  if (!compiled?.modules?.length) throw new TypeError('Preview needs a compiled recipe with modules');
  const cappedWidth = Math.max(4, Math.min(GDO_CONTENT_VALIDATOR_LIMITS.maxPreviewWidth, Math.trunc(width)));
  const cappedHeight = Math.max(2, Math.min(GDO_CONTENT_VALIDATOR_LIMITS.maxPreviewHeight, Math.trunc(height)));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let cell = Infinity;
  for (const entry of compiled.modules) {
    minX = Math.min(minX, entry.minX); maxX = Math.max(maxX, entry.maxX);
    minZ = Math.min(minZ, entry.minZ); maxZ = Math.max(maxZ, entry.maxZ);
    cell = Math.min(cell, entry.sizeX, entry.sizeZ);
  }
  const spanX = Math.max(1e-6, maxX - minX), spanZ = Math.max(1e-6, maxZ - minZ);
  // The grid follows the modules' own cell size, so a voxel recipe previews as
  // its voxel plan (one character per cell) instead of one merged blob.
  const unit = Number.isFinite(cell) && cell > 0 ? cell : 1;
  const columns = Math.max(1, Math.min(cappedWidth, Math.round(spanX / unit) + 1));
  const rows = Math.max(1, Math.min(cappedHeight, Math.round(spanZ / unit) + 1));
  const palette = [];
  const familyFor = color => {
    const index = palette.indexOf(color);
    if (index >= 0) return index;
    palette.push(color);
    return palette.length - 1;
  };
  const grid = Array.from({ length: rows }, () => new Array(columns).fill(' '));
  // Modules are drawn in declaration order, so a later module overlaps an
  // earlier one exactly as the compiler's order intends.
  for (const entry of compiled.modules) {
    const family = familyFor(entry.color);
    const glyph = PREVIEW_ALPHABET[family % PREVIEW_ALPHABET.length];
    const column = Math.min(columns - 1, Math.floor(((entry.x - minX) / spanX) * columns));
    const row = Math.min(rows - 1, Math.floor(((entry.z - minZ) / spanZ) * rows));
    grid[row][column] = glyph;
  }
  return Object.freeze({
    id: compiled.id ?? null,
    columns,
    rows,
    lines: Object.freeze(grid.map(line => line.join(''))),
    legend: Object.freeze(palette.map((color, index) => Object.freeze({
      glyph: PREVIEW_ALPHABET[index % PREVIEW_ALPHABET.length],
      color,
      modules: compiled.modules.filter(entry => entry.color === color).length,
    }))),
  });
}

function compilePackTwice(pack, options) {
  const first = compileStatePack(pack, options);
  const second = compileStatePack(pack, options);
  return { ...first, recompiledFingerprint: second.fingerprint };
}

/**
 * Validate one state pack: `schema` first, then the compiled checks. A refused
 * pack never reaches the later checks — they are reported as skipped with the
 * reason, so a report can never claim a budget check passed on a pack that did
 * not compile.
 */
export function validateContentPack(pack, {
  profile = 'low', bounds = null, providers = null, expectedFingerprint = null,
  preview = true, previewWidth, previewHeight,
} = {}) {
  const area = spawnBounds(bounds);
  const checks = [];
  const report = loadContentState(pack);
  if (!report.ok) {
    checks.push(failure('schema', report.errors.map(item => `${item.path}:${item.code}`).join('; '), {
      problems: report.errors.map(item => `${item.path}:${item.code}`),
      warnings: report.warnings.length,
    }));
    for (const id of GDO_CONTENT_CHECK_IDS.slice(1)) checks.push(skip(id, 'the pack did not pass the schema check'));
    return Object.freeze({
      namespace: GDO_CONTENT_VALIDATOR_NAMESPACE,
      kind: 'state-pack',
      id: pack?.stateId ?? null,
      profile,
      ok: false,
      checks: Object.freeze(checks),
      errors: Object.freeze(report.errors.slice(0, GDO_CONTENT_VALIDATOR_LIMITS.maxReportedErrors)),
      warnings: Object.freeze(report.warnings),
      compiled: null,
      preview: null,
      fingerprint: null,
    });
  }

  const compiled = compilePackTwice(pack, { profile });
  const compiledLandmarks = (report.data.landmarks ?? []).map(entry =>
    compileLandmarkRecipe(entry, { profile }));
  // Landmark modules and their pruning belong to the pack's budget too: a
  // landmark that overflowed its own ceiling is the pack's problem to report.
  const landmarkModules = compiledLandmarks.reduce((total, entry) => total + entry.modules.length, 0);
  const budgetDiagnostics = {
    modules: compiled.diagnostics.modules + landmarkModules,
    prunedModules: compiled.diagnostics.prunedModules +
      compiledLandmarks.reduce((total, entry) => total + (entry.diagnostics.overBudget ?? 0), 0),
  };
  const recipeCounts = [
    ...compiled.collectibles.map(entry => entry.modules.length),
    ...compiledLandmarks.map(entry => entry.modules.length),
  ];
  checks.push(pass('schema', `${report.data.collectibles.length} collectibles validated`,
    { warnings: report.warnings.length, migrationSteps: report.migration.steps.length }));
  checks.push(checkBounds([
    ...compiled.collectibles.map(entry => ({ id: entry.id, spawn: entry.spawn })),
    ...compiledLandmarks.map(entry => ({ id: entry.id, spawn: entry.spawn ?? null })).filter(entry => entry.spawn),
  ], area));
  checks.push(checkBudget({ diagnostics: budgetDiagnostics }, recipeCounts, profile));
  checks.push(checkAttribution(pack, providers));
  checks.push(checkOpenings(compiledLandmarks, profile));
  checks.push(checkDeterminism(compiled, expectedFingerprint));
  return Object.freeze({
    namespace: GDO_CONTENT_VALIDATOR_NAMESPACE,
    kind: 'state-pack',
    id: compiled.stateId,
    profile,
    ok: checks.every(check => check.ok),
    checks: Object.freeze(checks),
    errors: Object.freeze([]),
    warnings: Object.freeze(report.warnings),
    compiled,
    preview: preview ? renderModulePreview(compiled.collectibles[0], {
      width: previewWidth, height: previewHeight,
    }) : null,
    fingerprint: compiled.fingerprint,
  });
}

/**
 * Validate one landmark recipe, or a list of them. Landmarks carry their own
 * bounds (the modules themselves) and their own openings, so the `schema` check
 * here means "the compiler accepted it".
 */
export function validateLandmarkRecipe(recipes, {
  profile = 'low', bounds = null, expectedFingerprints = null, preview = true,
} = {}) {
  const list = Array.isArray(recipes) ? recipes : [recipes];
  const checks = [];
  let compiled;
  try {
    const first = list.map(recipe => compileLandmarkRecipe(recipe, { profile }));
    const second = list.map(recipe => compileLandmarkRecipe(recipe, { profile }));
    compiled = first.map((entry, index) => ({ ...entry, recompiledFingerprint: second[index].fingerprint }));
  } catch (error) {
    checks.push(failure('schema', error.message));
    for (const id of GDO_CONTENT_CHECK_IDS.slice(1)) checks.push(skip(id, 'the recipe did not compile'));
    return Object.freeze({
      namespace: GDO_CONTENT_VALIDATOR_NAMESPACE,
      kind: 'landmark',
      id: list[0]?.id ?? null,
      profile,
      ok: false,
      checks: Object.freeze(checks),
      errors: Object.freeze([{ path: 'recipe', code: 'compile-failed', detail: error.message }]),
      warnings: Object.freeze([]),
      compiled: null,
      preview: null,
      fingerprint: null,
    });
  }

  // A landmark's own modules define its bounds; a caller may still declare the
  // area it must sit inside.
  const measuredBounds = compiled.reduce((span, entry) => {
    for (const module of entry.modules) {
      span.minX = Math.min(span.minX, module.minX); span.maxX = Math.max(span.maxX, module.maxX);
      span.minZ = Math.min(span.minZ, module.minZ); span.maxZ = Math.max(span.maxZ, module.maxZ);
    }
    return span;
  }, { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
  const area = spawnBounds(bounds);
  const problems = [];
  if (bounds && (measuredBounds.minX < area.minX || measuredBounds.maxX > area.maxX ||
      measuredBounds.minZ < area.minZ || measuredBounds.maxZ > area.maxZ)) {
    problems.push(`compiled bounds (${measuredBounds.minX.toFixed(1)}, ${measuredBounds.minZ.toFixed(1)})–(${measuredBounds.maxX.toFixed(1)}, ${measuredBounds.maxZ.toFixed(1)}) leave the declared area`);
  }
  checks.push(pass('schema', `${list.length} landmark recipe(s) compiled`,
    { measured: { modules: compiled.reduce((total, entry) => total + entry.modules.length, 0) } }));
  checks.push(problems.length
    ? failure('bounds', problems.join('; '), { problems, measured: measuredBounds, limit: area })
    : pass('bounds', 'compiled bounds sit inside the declared area', { measured: measuredBounds, limit: area }));
  checks.push(checkBudget({
    diagnostics: {
      modules: compiled.reduce((total, entry) => total + entry.modules.length, 0),
      prunedModules: compiled.reduce((total, entry) => total + (entry.diagnostics.overBudget ?? 0), 0),
    },
  }, compiled.map(entry => entry.modules.length), profile));
  checks.push(skip('attribution', 'landmark recipes declare no mapped sources'));
  checks.push(checkOpenings(compiled, profile));
  const combined = {
    fingerprint: compiled.map(entry => entry.fingerprint).join('+'),
    recompiledFingerprint: compiled.map(entry => entry.recompiledFingerprint).join('+'),
  };
  const expected = Array.isArray(expectedFingerprints) ? expectedFingerprints.join('+') : expectedFingerprints;
  checks.push(checkDeterminism(combined, expected));
  return Object.freeze({
    namespace: GDO_CONTENT_VALIDATOR_NAMESPACE,
    kind: 'landmark',
    id: compiled.length === 1 ? compiled[0].id : null,
    profile,
    ok: checks.every(check => check.ok),
    checks: Object.freeze(checks),
    errors: Object.freeze([]),
    warnings: Object.freeze([]),
    compiled: Object.freeze(compiled),
    preview: preview ? renderModulePreview(compiled[0]) : null,
    fingerprint: combined.fingerprint,
  });
}

/** Printable lines for a report: the CLI and a test diff read the same text. */
export function formatValidatorReport(report) {
  const lines = [`${report.namespace} · ${report.kind} ${report.id ?? '(unnamed)'} · profile ${report.profile} · ${report.ok ? 'PASS' : 'FAIL'}`];
  for (const check of report.checks) {
    const state = check.skipped ? 'skip' : check.ok ? 'pass' : 'FAIL';
    lines.push(`  [${state}] ${check.id}: ${check.detail}`);
  }
  if (report.fingerprint) lines.push(`  fingerprint: ${report.fingerprint}`);
  if (report.preview) {
    lines.push(`  preview ${report.preview.columns}×${report.preview.rows}:`);
    for (const line of report.preview.lines) lines.push(`    ${line}`);
    lines.push(`    legend: ${report.preview.legend.map(entry => `${entry.glyph}=${entry.color}×${entry.modules}`).join(' ')}`);
  }
  return Object.freeze(lines);
}
