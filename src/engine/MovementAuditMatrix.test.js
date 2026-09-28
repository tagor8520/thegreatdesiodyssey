import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_AUDIT_MATRIX_BUDGET_KEYS,
  GDO_AUDIT_MATRIX_FIXTURES,
  MOVEMENT_AUDIT_MATRIX_NAMESPACE,
  createMovementAuditMatrixRunner,
  runMovementAuditMatrix,
} from './MovementAuditMatrix.js';
import { MOVEMENT_AUDIT_NAMESPACE } from './MovementAudit.js';
import { featureNamespace } from './FeatureVersions.js';

/**
 * `QLT-06` gate: the scripted movement audit runs across the canonical biomes in
 * declaration order, each fixture reports the same measured budgets, and the
 * whole matrix has one deterministic fingerprint.
 */

/** A synthetic fixture run: deterministic step/probe/measure, no three, no DOM. */
function syntheticRun(fixture, index, { brokenVerdict = null, budgets = null } = {}) {
  let step = 0;
  const state = { x: 0, y: 0, z: 0 };
  return {
    reset: () => { step = 0; state.x = 0; state.y = 0; state.z = 0; },
    step: (input, { dt = 1 / 30 } = {}) => {
      step++;
      const yaw = (input.yawTurns ?? 0) * Math.PI * 2;
      state.x += Math.sin(yaw) * 1.2 * dt * (input.forward ?? 0);
      state.z += Math.cos(yaw) * 1.2 * dt * (input.forward ?? 0);
      state.y = (index + 1) * .01;
      // A fixture that names a verdict flips one observable so that verdict fails.
      if (brokenVerdict === 'clipping') state.y = -1;
    },
    probe: info => ({
      pathId: info?.pathId ?? null, index: info?.index ?? -1,
      camera: { mode: info?.cameraMode ?? 'first-person', position: { ...state }, clearance: state.y < 0 ? -1 : 2 },
      bands: [{ name: 'water', order: 12, transparent: true, opaqueOrder: 2 }],
      lod: {},
      subpixel: [],
      residentTiles: [`fixture:${fixture.fixtureId}`],
      renderCalls: 10, triangles: 100,
    }),
    measure: () => budgets ?? {
      residentTiles: 1, drawCalls: 10, triangles: 100, queryMaxCandidates: 4, lifecycleResources: 12,
    },
  };
}

test('the matrix is declared and runs every canonical biome in order', () => {
  assert.equal(MOVEMENT_AUDIT_MATRIX_NAMESPACE, featureNamespace('auditMatrix'));
  assert.equal(MOVEMENT_AUDIT_MATRIX_NAMESPACE, 'gdo:auditMatrix:v1');
  assert.deepEqual(GDO_AUDIT_MATRIX_FIXTURES.map(fixture => fixture.id),
    ['urban', 'rural', 'coast', 'wetland', 'mountain', 'arid']);
  assert.deepEqual(GDO_AUDIT_MATRIX_FIXTURES.map(fixture => fixture.fixtureId),
    ['dense-urban', 'sparse-rural', 'mapped-coast', 'wetland-basin', 'mountain-terrace', 'arid-basin']);
  assert.ok(GDO_AUDIT_MATRIX_BUDGET_KEYS.includes('triangles'));

  const seen = [];
  const report = runMovementAuditMatrix({
    createRun: (fixture, index) => { seen.push(fixture.id); return syntheticRun(fixture, index); },
  });
  assert.deepEqual(seen, ['urban', 'rural', 'coast', 'wetland', 'mountain', 'arid']);
  assert.equal(report.namespace, MOVEMENT_AUDIT_MATRIX_NAMESPACE);
  assert.equal(report.auditNamespace, MOVEMENT_AUDIT_NAMESPACE);
  assert.equal(report.ok, true, report.detail);
  assert.deepEqual(report.failed, []);
  assert.equal(report.fixtures.length, 6);
  assert.equal(report.dt, 1 / 30);
  assert.equal(report.repeat, 2);
  for (const entry of report.fixtures) {
    assert.equal(entry.ok, true, `${entry.id}: ${entry.failed.join(',')}`);
    assert.equal(entry.verdicts.length, 8, 'determinism, the six movement verdicts, and the water state check');
    assert.deepEqual(entry.failed, []);
    assert.ok(entry.samples > 0);
    assert.match(entry.fingerprint, /^[0-9a-f]{8}$/);
    assert.deepEqual(Object.keys(entry.budgets).sort(),
      ['drawCalls', 'lifecycleResources', 'queryMaxCandidates', 'residentTiles', 'triangles']);
    assert.equal(entry.budgetDetail, 'residentTiles=1 drawCalls=10 triangles=100 queryMaxCandidates=4 lifecycleResources=12');
  }
  assert.match(report.fingerprint, /^[0-9a-f]{8}$/);
  assert.deepEqual(Object.keys(report.fingerprints), ['urban', 'rural', 'coast', 'wetland', 'mountain', 'arid']);
  for (const value of Object.values(report.fingerprints)) assert.match(value, /^[0-9a-f]{8}$/);
  // Deterministic: the same synthetic runs produce the same matrix fingerprint.
  const replay = runMovementAuditMatrix({ createRun: syntheticRun });
  assert.equal(replay.fingerprint, report.fingerprint);
  assert.deepEqual(replay.fingerprints, report.fingerprints);
});

test('a failing verdict is localized to the fixture that caused it', () => {
  const report = runMovementAuditMatrix({
    repeat: 1,
    createRun: (fixture, index) => syntheticRun(fixture, index,
      fixture.id === 'wetland' ? { brokenVerdict: 'clipping' } : {}),
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.failed, ['wetland']);
  assert.equal(report.detail, 'failed: wetland(clipping)');
  const wetland = report.fixtures.find(entry => entry.id === 'wetland');
  assert.equal(wetland.ok, false);
  assert.deepEqual(wetland.failed, ['clipping']);
  const clipping = wetland.verdicts.find(verdict => verdict.id === 'clipping');
  assert.equal(clipping.ok, false);
  assert.match(clipping.detail, /inside a blocker/);
  for (const entry of report.fixtures.filter(entry => entry.id !== 'wetland')) {
    assert.equal(entry.ok, true, `${entry.id} stayed green`);
  }
});

test('a fixture that cannot report its budgets fails the matrix', () => {
  const report = runMovementAuditMatrix({
    repeat: 1,
    createRun: (fixture, index) => syntheticRun(fixture, index, fixture.id === 'arid'
      ? { budgets: { residentTiles: 1, drawCalls: Number.NaN, triangles: 100 } }
      : {}),
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.failed, ['arid']);
  const arid = report.fixtures.find(entry => entry.id === 'arid');
  assert.deepEqual(arid.failed, ['budgets']);
  assert.deepEqual(arid.budgetDetail && arid.verdicts.length ? arid.failed : [], ['budgets']);
  assert.match(report.detail, /arid\(budgets\)/);
  // A run with no measurement at all is a failure, never a silent pass.
  const missing = runMovementAuditMatrix({
    repeat: 1,
    createRun: (fixture, index) => {
      const run = syntheticRun(fixture, index);
      delete run.measure;
      return run;
    },
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.failed, ['urban', 'rural', 'coast', 'wetland', 'mountain', 'arid']);
});

test('the matrix runner exposes the last report and refuses malformed requests', () => {
  const runner = createMovementAuditMatrixRunner({ createRun: syntheticRun, repeat: 1 });
  assert.equal(runner.ok, null);
  assert.equal(runner.summary(), 'movement audit matrix has not run');
  const report = runner.run();
  assert.equal(runner.ok, true);
  assert.equal(runner.last, report);
  assert.match(runner.summary(), /gdo:auditMatrix:v1 pass \([0-9a-f]{8}\)/);
  assert.throws(() => runMovementAuditMatrix({}), /needs createRun/);
  assert.throws(() => runMovementAuditMatrix({ createRun: syntheticRun, fixtures: [] }), /at least one fixture/);
  assert.throws(() => runMovementAuditMatrix({
    createRun: () => ({}), fixtures: [{ id: 'x', fixtureId: 'y' }],
  }), /did not supply step\/probe/);
});
