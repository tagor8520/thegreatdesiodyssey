import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_PBD_PROFILES,
  GDO_PBD_PUPPET,
  GDO_PBD_REFUSAL,
  GDO_PBD_WORLD_UNITS_PER_METRE,
  benchmarkPuppet,
  createPbdPuppet,
} from './PbdPuppet.js';
import { GDO_POSEFALL_NAMESPACE } from './PoseFall.js';

const names = GDO_PBD_PUPPET.particles;
const at = (positions, name, axis = 1) => positions[names.indexOf(name) * 3 + axis];
const distance = (positions, first, second) => Math.hypot(
  at(positions, first, 0) - at(positions, second, 0),
  at(positions, first, 1) - at(positions, second, 1),
  at(positions, first, 2) - at(positions, second, 2),
);
const restLength = (first, second) => {
  const a = GDO_PBD_PUPPET.offsets[names.indexOf(first)];
  const b = GDO_PBD_PUPPET.offsets[names.indexOf(second)];
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};
const buffer = puppet => JSON.stringify([...puppet.read().positions, ...puppet.read().previous]);

test('PHY-04 declares a bounded puppet with the research particle band', () => {
  assert.deepEqual(Object.values(GDO_PBD_REFUSAL).sort(),
    ['bad-input', 'profile-disabled', 'too-many-constraints', 'too-many-particles']);
  // The research asks for a 5–7-point prototype; this one carries two feet more.
  assert.ok(names.length >= 6 && names.length <= 10, `${names.length} particles`);
  assert.equal(GDO_PBD_PUPPET.distances.length + GDO_PBD_PUPPET.bends.length <= GDO_PBD_PROFILES.balanced.maxConstraints, true);
  assert.equal(GDO_PBD_WORLD_UNITS_PER_METRE, .1, 'the project metres→world scale');
  // Low profile may disable it — that is the row's own escape hatch.
  assert.equal(GDO_PBD_PROFILES.low.enabled, false);
  for (const profile of ['balanced', 'high']) {
    const policy = GDO_PBD_PROFILES[profile];
    assert.equal(policy.enabled, true);
    assert.ok(policy.iterations >= 3 && policy.iterations <= 5, `${profile} projects 3–5 times`);
    assert.ok(policy.maxParticles >= names.length && policy.maxConstraints >= 10);
    assert.ok(policy.maxStepsPerFrame >= 1);
  }
  // The rest lengths agree with the stance by construction.
  assert.ok(createPbdPuppet({ profile: 'balanced' }).diagnostics.restError < 1e-6,
    'the stance satisfies its own rest lengths exactly');
});

test('the low profile refuses by name instead of silently simulating', () => {
  const disabled = createPbdPuppet({ profile: 'low' });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.refusal, GDO_PBD_REFUSAL.PROFILE_DISABLED);
  assert.equal(disabled.particles, 0);
  assert.equal(disabled.step(16.7), 0);
  assert.equal(disabled.diagnostics.steps, 0);
  assert.equal(disabled.diagnostics.projections, 0);
  assert.equal(disabled.diagnostics.rigidBodies, 0);
  assert.equal(disabled.kick, undefined, 'a disabled puppet exposes no simulation entry point');
  const benchmark = benchmarkPuppet({ profile: 'low' });
  assert.equal(benchmark.enabled, false);
  assert.equal(benchmark.refusal, GDO_PBD_REFUSAL.PROFILE_DISABLED);
  assert.equal(benchmark.steps, 0);
  assert.equal(benchmark.proxy.projections, 0);
  assert.throws(() => createPbdPuppet({ profile: 'balanced', origin: [0, Number.NaN, 0] }), /finite/);
});

test('the puppet is deterministic, sleeps, and stays bounded on a long run', () => {
  const run = () => {
    const puppet = createPbdPuppet({ profile: 'balanced' });
    puppet.kick('handLeft', [1.2, 0, .4]);
    for (let frame = 0; frame < 400; frame++) puppet.step(16.7);
    return puppet;
  };
  const first = run(), second = run();
  assert.equal(buffer(first), buffer(second), 'the same script is byte-identical');

  const diagnostics = first.diagnostics;
  assert.equal(diagnostics.asleep, true, 'it settles instead of thrashing');
  assert.ok(diagnostics.maximumSpeed < 1, `bounded motion (${diagnostics.maximumSpeed})`);
  assert.equal(diagnostics.rigidBodies, 0);
  assert.equal(diagnostics.steadyFrameAllocations, 0);
  const positions = first.read().positions;
  for (let index = 0; index < positions.length; index++) {
    assert.ok(Number.isFinite(positions[index]), 'no NaN or infinity escapes');
  }
  // Every particle stays in a plausible envelope around the anchor.
  for (const name of names) {
    assert.ok(Math.abs(at(positions, name)) < 1, `${name} stays near the puppet`);
    assert.ok(Math.abs(at(positions, name, 1)) < 1);
  }
  // Frame packing cannot change the result.
  const packed = milliseconds => {
    const puppet = createPbdPuppet({ profile: 'balanced' });
    puppet.kick('handLeft', [1.2, 0, .4]);
    for (let frame = 0; frame < 200; frame++) puppet.step(milliseconds);
    return buffer(puppet);
  };
  assert.equal(packed(16.7), packed(33.4));
});

test('constraints hold their rest lengths and the floor wins where they meet', () => {
  // Flat ground: every joint converges to its authored length.
  const flat = createPbdPuppet({ profile: 'balanced' });
  for (let frame = 0; frame < 400; frame++) flat.step(16.7);
  const settled = flat.read().positions;
  for (const [first, second] of [['head', 'chest'], ['chest', 'pelvis'], ['pelvis', 'footRight'], ['pelvis', 'hem']]) {
    const error = Math.abs(distance(settled, first, second) - restLength(first, second));
    assert.ok(error < .06, `${first}-${second} converges (${error})`);
  }

  // Sloped ground: contact is the harder constraint, so it wins — and the
  // diagnostics report the compromise rather than hiding it.
  const slope = (x) => x * .02;
  const sloped = createPbdPuppet({ profile: 'balanced', heightAt: slope });
  for (let frame = 0; frame < 400; frame++) sloped.step(16.7);
  const positions = sloped.read().positions;
  const groundY = sloped.read().groundY, radius = sloped.read().radius;
  for (let part = 0; part < names.length; part++) {
    assert.ok(positions[part * 3 + 1] >= groundY[part] + radius[part] - 1e-6,
      `${names[part]} sits on its own ground`);
  }
  assert.ok(sloped.diagnostics.restError > 0, 'the floor-vs-joint compromise is measured');
  assert.ok(sloped.diagnostics.restError < .12, 'and stays inside the declared tolerance');
});

test('the anchor holds, impulses are clamped, and every bad input is named', () => {
  const puppet = createPbdPuppet({ profile: 'balanced', anchor: 'chest' });
  const anchored = at(puppet.read().positions, 'chest');
  for (let frame = 0; frame < 200; frame++) puppet.step(16.7);
  assert.equal(at(puppet.read().positions, 'chest'), anchored, 'the pinned chest does not fall');

  // An unclamped impulse would launch the hand; the pool clamps to its ceiling.
  const clamped = puppet.kick('handLeft', [1e6, 0, 0]);
  assert.equal(clamped.ok, true);
  assert.ok(clamped.speed <= GDO_PBD_PROFILES.balanced.maxVelocity);
  assert.equal(puppet.kick('elbow', [1, 0, 0]).refusal, GDO_PBD_REFUSAL.BAD_INPUT);
  assert.equal(puppet.kick('handLeft', [Number.NaN, 0, 0]).refusal, GDO_PBD_REFUSAL.BAD_INPUT);
  assert.equal(puppet.step(Number.NaN), 0);
  assert.ok(puppet.diagnostics.malformedInputs > 0);
  assert.equal(puppet.pin('nobody'), false);
  assert.equal(puppet.pin('handLeft', false), true);

  // A five-second stall is clamped to the substep cap.
  const stall = createPbdPuppet({ profile: 'balanced' });
  const steps = stall.step(5_000);
  assert.ok(steps <= GDO_PBD_PROFILES.balanced.maxStepsPerFrame);

  // Released from its anchor, the body still stays finite and bounded.
  const dropped = createPbdPuppet({ profile: 'balanced', anchor: null });
  for (let frame = 0; frame < 300; frame++) dropped.step(16.7);
  for (const value of dropped.read().positions) assert.ok(Number.isFinite(value) && Math.abs(value) < 1);
});

test('the benchmark reports a deterministic proxy beside machine-dependent timing', () => {
  const benchmark = benchmarkPuppet({ profile: 'balanced', steps: 120 });
  assert.equal(benchmark.enabled, true);
  assert.equal(benchmark.requestedSteps, 120);
  assert.ok(benchmark.steps > 0 && benchmark.steps <= 120, 'a settling puppet stops stepping');
  assert.equal(benchmark.asleep, benchmark.steps < 120, 'the shorter run is the sleeping one');
  assert.equal(benchmark.particles, names.length);
  assert.equal(benchmark.constraints, GDO_PBD_PUPPET.distances.length + GDO_PBD_PUPPET.bends.length);
  assert.equal(benchmark.iterations, GDO_PBD_PROFILES.balanced.iterations);
  // The proxy is the part a comparison can quote: it is a pure function of the
  // declared script, not of this machine.
  assert.equal(benchmark.proxy.constraintSolves, benchmark.constraints * benchmark.iterations * benchmark.steps);
  assert.equal(benchmark.proxy.projections, benchmark.proxy.constraintSolves);
  assert.equal(
    benchmark.proxy.collisionQueries,
    Math.min(names.length, GDO_PBD_PROFILES.balanced.maxCollisionQueriesPerStep) * benchmark.iterations * benchmark.steps,
    'one collision query per particle per iteration — the floor is solved with the joints',
  );
  assert.equal(benchmark.rigidBodies, 0);
  assert.equal(benchmark.baseline, GDO_POSEFALL_NAMESPACE, 'the comparison names what it is compared to');
  assert.equal(benchmark.timing.machineDependent, true);
  assert.ok(benchmark.timing.millisecondsTotal >= 0);
  assert.ok(benchmark.worstRestError >= 0);
  // Running it twice gives the same proxy.
  const repeated = benchmarkPuppet({ profile: 'balanced', steps: 120 });
  assert.deepEqual(repeated.proxy, benchmark.proxy);
  assert.throws(() => benchmarkPuppet({ steps: 0 }), /steps/);
  assert.throws(() => benchmarkPuppet({ steps: 9_000 }), /steps/);
});
