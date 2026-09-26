import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOVEMENT_AUDIT_NAMESPACE,
  MOVEMENT_AUDIT_PATHS,
  MOVEMENT_AUDIT_THRESHOLDS,
  createMovementAuditRunner,
  runMovementAudit,
} from './MovementAudit.js';

/**
 * Deterministic stand-in runtime. The audit must be able to prove a clean
 * runtime passes and to name the exact defect when one is injected.
 */
function createSyntheticRuntime({ bands, lodFor, subpixelFor, clearanceFor, residentFor, stateful = true } = {}) {
  let step = 0;
  const state = { tiles: ['0:0'], zoom: 4.5 };
  const inputs = [];
  return {
    inputs,
    state,
    /** Mirrors a real runtime resetting to the script origin between passes. */
    reset() { step = 0; state.tiles = ['0:0']; state.zoom = 4.5; },
    drive(input) {
      inputs.push({ ...input });
      step++;
      if (stateful) {
        state.zoom = 4.5 + (input.zoomTurns ?? 0) * 2;
        state.tiles = input.index % 12 === 11 ? (state.tiles[0] === '0:0' ? ['0:0', '1:0'] : ['0:0']) : state.tiles;
      }
    },
    probe({ pathId, index, phase }) {
      // Local travel keeps each path continuous, like a real scripted walk.
      const distance = (index + 1) * .18 + (pathId.length % 3) * .05;
      return {
        pathId,
        index,
        phase,
        camera: {
          mode: 'third-person',
          position: { x: Math.cos(phase * Math.PI * 2) * distance, y: 2.4 + Math.sin(phase * Math.PI) * .4, z: Math.sin(phase * Math.PI * 2) * distance },
          clearance: clearanceFor ? clearanceFor(step) : .62 - Math.abs(Math.sin(phase * Math.PI * 4)) * .3,
        },
        bands: bands ?? [
          { name: 'ground', order: 0, transparent: false, opaqueOrder: 0 },
          { name: 'building', order: 6, transparent: false, opaqueOrder: 0 },
          { name: 'water', order: 48, transparent: true, opaqueOrder: 6 },
        ],
        lod: lodFor ? lodFor(step) : { broadleaf: 0, palm: 1, grass: 2 },
        subpixel: subpixelFor ? subpixelFor(step) : [
          { key: 'road-line', pixels: 3.4, mip: true, faded: false },
          { key: 'facade-edge', pixels: .6, mip: true, faded: true },
        ],
        residentTiles: residentFor ? residentFor(step) : state.tiles,
        renderCalls: 8,
        triangles: 1200,
      };
    },
  };
}

test('movement audit passes a deterministic, well-behaved runtime', () => {
  const runtime = createSyntheticRuntime();
  const report = runMovementAudit({ step: runtime.drive, probe: runtime.probe, reset: runtime.reset });
  assert.equal(report.namespace, MOVEMENT_AUDIT_NAMESPACE);
  assert.equal(report.ok, true, report.detail);
  assert.equal(report.paths.length, MOVEMENT_AUDIT_PATHS.length);
  assert.equal(report.samples, MOVEMENT_AUDIT_PATHS.reduce((sum, path) => sum + path.steps, 0));
  assert.match(report.fingerprint, /^[0-9a-f]{8}$/);
  assert.match(report.detail, /passed 7 movement verdicts/);
  assert.deepEqual(report.verdicts.map(verdict => verdict.id),
    ['determinism', 'clipping', 'ordering', 'popping', 'shimmer', 'stability', 'residency']);
  assert.equal(report.verdicts.find(verdict => verdict.id === 'popping').families.broadleaf.toggles, 0);
  assert.ok(report.verdicts.find(verdict => verdict.id === 'shimmer').detail.includes('mip-mapped'));
  assert.ok(runtime.inputs.length >= report.samples * 2, 'the audit runs the script in two passes');
  assert.equal(runtime.inputs[0].cameraMode, 'first-person');
  assert.equal(runtime.inputs.at(-1).cameraMode, 'third-person');
});

test('movement audit names camera clipping, ordering, popping, shimmer, and drift defects', () => {
  const runtime = createSyntheticRuntime();
  let calls = 0;
  const clipped = runMovementAudit({
    step: runtime.drive,
    probe: info => {
      const record = runtime.probe(info);
      // One sample on the fourth path dips the camera inside a blocker.
      return info.pathId === 'tpp-focus-orbit' && info.index === 40
        ? { ...record, camera: { ...record.camera, clearance: -.12 } }
        : record;
    },
    repeat: 1,
  });
  calls++;
  assert.equal(clipped.ok, false);
  const clipping = clipped.verdicts.find(verdict => verdict.id === 'clipping');
  assert.equal(clipping.ok, false);
  assert.match(clipping.detail, /inside a blocker, worst -0.120/);
  assert.equal(clipping.violations[0].clearance, -.12);
  assert.equal(clipping.violations[0].pathId, 'tpp-focus-orbit');
  assert.match(clipped.detail, /clipping/);
  assert.equal(calls, 1);
});

test('movement audit rejects a transparent band that sorts below opaque geometry', () => {
  const runtime = createSyntheticRuntime({
    bands: [
      { name: 'ground', order: 0, transparent: false, opaqueOrder: 0 },
      { name: 'water', order: 3, transparent: true, opaqueOrder: 6 },
    ],
  });
  const report = runMovementAudit({ step: runtime.drive, probe: runtime.probe, repeat: 1 });
  assert.equal(report.ok, false);
  const ordering = report.verdicts.find(verdict => verdict.id === 'ordering');
  assert.equal(ordering.ok, false);
  assert.equal(ordering.violations[0].reason, 'transparent band sorts at or below opaque');
  assert.equal(ordering.violations[0].band, 'water');
});

test('movement audit flags water order regression between samples', () => {
  let sample = 0;
  const runtime = createSyntheticRuntime();
  const probe = info => {
    const record = runtime.probe(info);
    sample++;
    return { ...record, bands: [{ ...record.bands[2], order: sample === 30 ? 12 : 48 }, record.bands[0], record.bands[1]] };
  };
  const report = runMovementAudit({ step: runtime.drive, probe, repeat: 1 });
  const ordering = report.verdicts.find(verdict => verdict.id === 'ordering');
  assert.equal(ordering.ok, false);
  assert.match(ordering.violations[0].reason, /water order regressed/);
});

test('movement audit measures LOD churn instead of trusting hysteresis', () => {
  const runtime = createSyntheticRuntime({ lodFor: step => ({ broadleaf: step % 2, palm: 1 }) });
  const report = runMovementAudit({ step: runtime.drive, probe: runtime.probe, repeat: 1 });
  const popping = report.verdicts.find(verdict => verdict.id === 'popping');
  assert.equal(popping.ok, false);
  assert.ok(popping.families.broadleaf.ratio > MOVEMENT_AUDIT_THRESHOLDS.maximumToggleRatio);
  assert.match(popping.detail, /LOD churn above threshold: broadleaf/);
  assert.equal(popping.families.palm.toggles, 0);
});

test('movement audit requires mip or fade for subpixel surfaces', () => {
  const runtime = createSyntheticRuntime({
    subpixelFor: () => [{ key: 'road-line', pixels: .4, mip: false, faded: false }],
  });
  const report = runMovementAudit({ step: runtime.drive, probe: runtime.probe, repeat: 1 });
  const shimmer = report.verdicts.find(verdict => verdict.id === 'shimmer');
  assert.equal(shimmer.ok, false);
  assert.equal(shimmer.violations[0].reason, 'subpixel surface without mip or fade');
  assert.equal(shimmer.violations[0].key, 'road-line');
});

test('movement audit bounds per-step travel, non-finite state, and resident churn', () => {
  const jumping = createSyntheticRuntime();
  let call = 0;
  const report = runMovementAudit({
    step: jumping.drive,
    probe: info => {
      const record = jumping.probe(info);
      call++;
      if (call === 20) return { ...record, camera: { ...record.camera, position: { x: NaN, y: 2, z: 0 } } };
      if (call === 40) return { ...record, camera: { ...record.camera, position: { x: 900, y: 2, z: 0 } } };
      return record;
    },
    repeat: 1,
  });
  const stability = report.verdicts.find(verdict => verdict.id === 'stability');
  assert.equal(stability.ok, false);
  assert.equal(stability.nonFinite, 1);
  assert.ok(stability.worstStep > MOVEMENT_AUDIT_THRESHOLDS.maximumStepDistance);
  assert.match(stability.detail, /non-finite sample/);

  const churn = createSyntheticRuntime({ residentFor: step => [`tile-${step % 8}`] });
  const churnReport = runMovementAudit({ step: churn.drive, probe: churn.probe, repeat: 1 });
  const residency = churnReport.verdicts.find(verdict => verdict.id === 'residency');
  assert.equal(residency.ok, false);
  assert.ok(residency.changeCount > MOVEMENT_AUDIT_THRESHOLDS.maximumResidentChanges);
});

test('movement audit proves non-determinism rather than hiding it', () => {
  let noise = 0;
  const runtime = createSyntheticRuntime();
  const report = runMovementAudit({
    step: input => { runtime.drive(input); noise++; },
    probe: info => ({ ...runtime.probe(info), renderCalls: info ? 8 + (noise % 3) : 8 }),
    repeat: 2,
  });
  const determinism = report.verdicts.find(verdict => verdict.id === 'determinism');
  assert.equal(determinism.ok, false);
  assert.match(determinism.detail, /passes 1\.\.2 share the same movement fingerprint/);
  assert.equal(report.ok, false);
});

test('movement audit validates its own inputs and the reusable runner keeps the last report', () => {
  assert.throws(() => runMovementAudit({}), /needs step\(input\) and probe\(\)/);
  const runtime = createSyntheticRuntime();
  const runner = createMovementAuditRunner({ step: runtime.drive, probe: runtime.probe, reset: runtime.reset, repeat: 1 });
  assert.equal(runner.ok, null);
  assert.match(runner.summary(), /has not run/);
  const report = runner.run();
  assert.equal(report.ok, true);
  assert.equal(runner.ok, true);
  assert.equal(runner.last.fingerprint, report.fingerprint);
  assert.match(runner.summary(), /gdo:movementAudit:v1 pass/);
  const shorter = runner.run({ paths: MOVEMENT_AUDIT_PATHS.slice(0, 1) });
  assert.equal(shorter.paths.length, 1);
  assert.equal(runner.last.paths.length, 1);
});
