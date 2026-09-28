/**
 * `QLT-06` — the deterministic movement-audit matrix.
 *
 * `runMovementAudit` replaced the retired capture tooling for *one* world. The
 * roadmap asks for the same scripted audit across the canonical biomes, with the
 * per-fixture verdicts, fingerprints, and budgets recorded in one report, so a
 * moving-behaviour regression is localized to the biome that caused it instead
 * of failing an undifferentiated sweep.
 *
 * This module is transport-agnostic orchestration: the caller supplies one run
 * per fixture (`step`, `probe`, `reset`, `measure`), and the matrix runs the
 * audit in declaration order, folds the verdicts and the measured budgets into
 * a per-fixture entry, and reports a deterministic matrix fingerprint. Budget
 * keys are declared here so every fixture reports the same numbers and a missing
 * or non-finite budget is a failure rather than a gap.
 */

import { featureNamespace } from './FeatureVersions.js';
import { MOVEMENT_AUDIT_NAMESPACE, runMovementAudit } from './MovementAudit.js';

export const MOVEMENT_AUDIT_MATRIX_NAMESPACE = featureNamespace('auditMatrix');

/** The six canonical biomes `QLT-06` names, in the order they are audited. */
export const GDO_AUDIT_MATRIX_FIXTURES = Object.freeze([
  Object.freeze({ id: 'urban', fixtureId: 'dense-urban', label: 'Dense urban grid' }),
  Object.freeze({ id: 'rural', fixtureId: 'sparse-rural', label: 'Sparse rural fields' }),
  Object.freeze({ id: 'coast', fixtureId: 'mapped-coast', label: 'Mapped coast' }),
  Object.freeze({ id: 'wetland', fixtureId: 'wetland-basin', label: 'Wetland basin' }),
  Object.freeze({ id: 'mountain', fixtureId: 'mountain-terrace', label: 'Mountain terrace' }),
  Object.freeze({ id: 'arid', fixtureId: 'arid-basin', label: 'Arid basin' }),
]);

/** Every fixture reports these measured numbers, or the matrix fails its budget. */
export const GDO_AUDIT_MATRIX_BUDGET_KEYS = Object.freeze([
  'residentTiles',
  'drawCalls',
  'triangles',
  'queryMaxCandidates',
  'lifecycleResources',
]);

function hash(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

function evaluateBudgets(budgets, budgetKeys) {
  if (!budgets || typeof budgets !== 'object') {
    return Object.freeze({ id: 'budgets', ok: false, detail: 'no budget measurement was supplied', missing: [...budgetKeys] });
  }
  const missing = budgetKeys.filter(key => !Number.isFinite(budgets[key]));
  return Object.freeze({
    id: 'budgets',
    ok: missing.length === 0,
    detail: missing.length === 0
      ? budgetKeys.map(key => `${key}=${budgets[key]}`).join(' ')
      : `missing or non-finite budgets: ${missing.join(', ')}`,
    missing: Object.freeze(missing),
  });
}

/**
 * Run the scripted audit over every fixture. `createRun(fixture, index)` returns
 * `{ step, probe, reset?, measure }`; the matrix never touches a world itself, so
 * it runs in the page, in the debug hook, and under `node --test`.
 */
export function runMovementAuditMatrix({
  createRun,
  fixtures = GDO_AUDIT_MATRIX_FIXTURES,
  budgetKeys = GDO_AUDIT_MATRIX_BUDGET_KEYS,
  paths = undefined,
  thresholds = undefined,
  dt = 1 / 30,
  repeat = 2,
  onFixture = null,
} = {}) {
  if (typeof createRun !== 'function') throw new TypeError('runMovementAuditMatrix needs createRun(fixture, index)');
  if (!Array.isArray(fixtures) || fixtures.length === 0) throw new RangeError('The audit matrix needs at least one fixture');
  if (!Array.isArray(budgetKeys)) throw new TypeError('budgetKeys must be an array');
  const entries = [], failures = [];
  for (let index = 0; index < fixtures.length; index++) {
    const fixture = fixtures[index];
    if (!fixture?.id || !fixture?.fixtureId) throw new TypeError('Every matrix fixture needs an id and a fixtureId');
    const run = createRun(fixture, index);
    if (typeof run?.step !== 'function' || typeof run?.probe !== 'function') {
      throw new TypeError(`Fixture ${fixture.id} did not supply step/probe`);
    }
    const report = runMovementAudit({
      step: run.step, probe: run.probe, reset: run.reset ?? null,
      paths, thresholds, dt, repeat, label: `${MOVEMENT_AUDIT_NAMESPACE}/${fixture.id}`,
    });
    const budgets = typeof run.measure === 'function' ? run.measure() : null;
    const budget = evaluateBudgets(budgets, budgetKeys);
    const failed = [...report.verdicts.filter(verdict => !verdict.ok).map(verdict => verdict.id),
      ...(budget.ok ? [] : ['budgets'])];
    const entry = Object.freeze({
      id: fixture.id,
      fixtureId: fixture.fixtureId,
      label: fixture.label ?? fixture.id,
      ok: report.ok && budget.ok,
      failed: Object.freeze(failed),
      fingerprint: report.fingerprint,
      samples: report.samples,
      paths: Object.freeze([...report.paths]),
      verdicts: Object.freeze(report.verdicts.map(verdict =>
        Object.freeze({ id: verdict.id, ok: verdict.ok, detail: verdict.detail }))),
      budgets: Object.freeze({ ...(budgets ?? {}) }),
      budgetDetail: budget.detail,
    });
    entries.push(entry);
    if (!entry.ok) failures.push(fixture.id);
    onFixture?.(entry, fixture, index);
  }
  const fingerprint = hash(entries.map(entry =>
    `${entry.id}:${entry.fingerprint}:${entry.ok ? 1 : 0}:${entry.failed.join('+')}`).join('|'));
  const report = {
    namespace: MOVEMENT_AUDIT_MATRIX_NAMESPACE,
    auditNamespace: MOVEMENT_AUDIT_NAMESPACE,
    fixtures: entries,
    fingerprints: Object.freeze(Object.fromEntries(entries.map(entry => [entry.id, entry.fingerprint]))),
    budgetKeys: Object.freeze([...budgetKeys]),
    dt,
    repeat,
    fingerprint,
    failed: Object.freeze(failures),
    ok: failures.length === 0,
  };
  report.detail = report.ok
    ? `${entries.length} fixtures passed the movement audit and reported ${budgetKeys.length} budgets each (${fingerprint})`
    : `failed: ${failures.map(id => `${id}(${entries.find(entry => entry.id === id).failed.join('+')})`).join(', ')}`;
  return report;
}

/** Reusable runner for the debug hook: one call per explicit audit request. */
export function createMovementAuditMatrixRunner(options = {}) {
  let last = null;
  return {
    namespace: MOVEMENT_AUDIT_MATRIX_NAMESPACE,
    run(overrides = {}) {
      last = runMovementAuditMatrix({ ...options, ...overrides });
      return last;
    },
    get last() { return last; },
    get ok() { return last?.ok ?? null; },
    summary() {
      if (!last) return 'movement audit matrix has not run';
      return `${last.namespace} ${last.ok ? 'pass' : 'fail'} (${last.fingerprint}) · ${last.detail}`;
    },
  };
}
