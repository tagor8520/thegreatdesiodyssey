/**
 * `FND-08` — curated/coordinate domain interface conformance.
 *
 * The registered gate is "shared world/player/query interfaces without forcing
 * one visual scale", and this file is its Node half. It does three things the
 * interface alone cannot:
 *
 * 1. Drives one identical probe against a **real** `GeoWorld` (with a compiled
 *    fixture, a placed dynamic proxy, and the static collision grids resident)
 *    and a **real** curated `BridgeManager`. Both are constructible in Node —
 *    `Gameplay.test.js` already builds the curated pair out of `three` alone —
 *    so the shared semantics are decided by the actual runtimes and not by
 *    doubles.
 * 2. Asserts the two modes stay **different** where they must. A "shared
 *    interface" that is achieved by collapsing one mode's scale into the
 *    other's is a regression against the gate's own wording, so the scale
 *    ratios are asserted, not merely reported.
 * 3. Carries negative controls for both the gate and its guard, because a check
 *    that cannot fail proves nothing. The contract assertion is shown rejecting
 *    a domain with a missing member, and the scale guard is shown rejecting a
 *    coordinate-shaped twin of the curated domain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  WORLD_DOMAIN_MEMBER_NAMES, WORLD_DOMAIN_VERSION, WORLD_DOMAIN_MEMBERS,
  WorldDomainError, assertWorldDomain, compareDomainScales, describeWorldDomain,
  probeWorldDomain, judgeWorldDomain, supportUnderFoot,
} from '../engine/WorldDomain.js';
import { createFlatDomain } from '../engine/FlatDomain.js';
import { GEO_QUERY_MASK } from '../geo/GeoCollision.js';
import { GeoWorld } from '../geo/GeoWorld.js';
import { applyCompilation } from '../geo/GeoTestSupport.js';
import { compileGeoFixture } from '../geo/GeoFixtures.js';
import { BridgeManager, BRIDGES } from './BridgeManager.js';
import { createCuratedDomain, CURATED_FOOTPRINT_HALF_EXTENT } from './CuratedDomain.js';
import { tileHeight } from './BiomeManager.js';
import { bridgeLane, curatedStepPoints, probeCoordinateDomain, probeCuratedDomain } from '../engine/WorldDomainProbe.js';

const PROXY_MASK = GEO_QUERY_MASK.SOLID_PLAYER | GEO_QUERY_MASK.CAMERA_BLOCKER;

/**
 * `GeoWorld` constructs its tile worker eagerly, so Node needs the same stub the
 * other geo tests install. It never delivers a message: the fixture is applied
 * directly through `applyCompilation`.
 */
function withWorkerStub(run) {
  const original = globalThis.Worker;
  globalThis.Worker = class {
    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
    terminate() {}
  };
  try { return run(); } finally { globalThis.Worker = original; }
}

function mountFixtureWorld(fixtureId = 'dense-urban') {
  return withWorkerStub(() => {
    const scene = new THREE.Scene();
    const world = new GeoWorld(scene, { latitude: 28.9845, longitude: 77.7064 });
    const tile = [...world.tiles.values()][0];
    applyCompilation(world, tile, compileGeoFixture(fixtureId, 'openmaptiles'));
    return { world, tile, scene };
  });
}

test('both real runtimes satisfy the domain interface', () => {
  const { world } = mountFixtureWorld();
  const bridges = new BridgeManager(new THREE.Scene());
  const curated = createCuratedDomain({ bridges });
  try {
    for (const [label, domain] of [['coordinate', world], ['curated', curated]]) {
      assert.doesNotThrow(() => assertWorldDomain(domain, label), `${label} must implement the interface`);
      const report = describeWorldDomain(domain);
      assert.equal(report.complete, true, `${label} report claims completeness`);
      assert.equal(report.version, WORLD_DOMAIN_VERSION);
      for (const name of WORLD_DOMAIN_MEMBER_NAMES) {
        assert.ok(report.members[name] >= WORLD_DOMAIN_MEMBERS[name].minArity,
          `${label}.${name} declares ${report.members[name]} parameters, needs ${WORLD_DOMAIN_MEMBERS[name].minArity}`);
      }
      assert.equal(Object.isFrozen(domain.scale), true, `${label} scale descriptor must be frozen and declared`);
    }
  } finally { world.dispose(); bridges.dispose(); }
});

test('one probe drives both runtimes to the same semantics', () => {
  const { world } = mountFixtureWorld();
  const bridges = new BridgeManager(new THREE.Scene());
  const curated = createCuratedDomain({ bridges });
  try {
    const coordinate = probeCoordinateDomain(world);

    const curatedProbe = probeCuratedDomain(curated, bridges);

    const coordinateVerdict = judgeWorldDomain(coordinate);
    const curatedVerdict = judgeWorldDomain(curatedProbe);
    assert.deepEqual(coordinateVerdict.failures, [], 'coordinate mode must satisfy every shared semantic');
    assert.deepEqual(curatedVerdict.failures, [], 'curated mode must satisfy every shared semantic');

    // The two modes resolved the same questions through different machinery.
    assert.equal(coordinate.name, 'coordinate');
    assert.equal(curatedProbe.name, 'curated');
    assert.ok(coordinate.diagnostics.overlaps > 0, 'the coordinate probe ran against the world, not a stub');
    assert.ok(curatedProbe.diagnostics.collisionQueries > 0, 'the curated probe ran against the bridge manager');
    assert.notEqual(coordinate.move.advanced, curatedProbe.move.advanced,
      'the two modes must not coincide; a shared number would mean one lane was measured twice');
    // The probe places a solid to measure against, so it must clean up after
    // itself: a gate that leaves geometry behind changes the world it measured.
    assert.equal(world.dynamicProxies.activeCount, 0, 'the probe must remove the solid it placed');
  } finally { world.dispose(); bridges.dispose(); }
});

test('the guard keeps the two modes on their own scales', () => {
  const bridges = new BridgeManager(new THREE.Scene());
  const curated = createCuratedDomain({ bridges });
  const { world } = mountFixtureWorld();
  try {
    const verdict = compareDomainScales(world, curated);
    assert.equal(verdict.ok, true, `scales must remain distinct but coherent: ${verdict.problems.join('; ')}`);
    assert.ok(Math.abs(verdict.ratios.footprintHalfExtent - 10) < 2.5,
      `footprint ratio ${verdict.ratios.footprintHalfExtent} must stay near the documented 10:1 horizontal scale`);
    assert.ok(verdict.ratios.supportSampleSpacing > 1,
      'the coordinate lattice resolves ground more finely than the curated 4 m tiles');

    // Negative control: a curated domain that adopted coordinate's near-plane
    // clamp would be exactly the "forced into one visual scale" failure.
    const collapsed = createFlatDomain({
      name: 'collapsed', footprintHalfExtent: .055, supportSampleSpacing: .12,
      sweepRadiusMin: .03, sweepRadiusMax: .04,
    });
    const collapsedVerdict = compareDomainScales(world, collapsed);
    assert.equal(collapsedVerdict.ok, false, 'the guard must reject a mode that adopted the other mode\'s clamp');
    assert.ok(collapsedVerdict.problems.some(p => p.includes('sweep clamps overlap')),
      `expected an overlap complaint, got: ${collapsedVerdict.problems.join('; ')}`);

    // …and one that drifted the horizontal scale.
    const drifted = createFlatDomain({
      name: 'drifted', footprintHalfExtent: .011, supportSampleSpacing: .12,
      sweepRadiusMin: .6, sweepRadiusMax: 1.25,
    });
    const driftedVerdict = compareDomainScales(world, drifted);
    assert.equal(driftedVerdict.ok, false, 'the guard must reject a footprint that drifted off the 1:10 scale');
    assert.ok(driftedVerdict.problems.some(p => p.includes('horizontal scale')),
      `expected a scale complaint, got: ${driftedVerdict.problems.join('; ')}`);
  } finally { world.dispose(); bridges.dispose(); }
});

test('the contract assertion names what a domain is missing', () => {
  const incomplete = createFlatDomain({ name: 'incomplete' });
  delete incomplete.resolveGroundStep;
  assert.throws(() => assertWorldDomain(incomplete, 'incomplete'), error => {
    assert.ok(error instanceof WorldDomainError);
    assert.match(error.message, /incomplete does not implement the domain interface/);
    assert.match(error.message, /resolveGroundStep is missing/);
    return true;
  });

  const shallow = createFlatDomain({ name: 'shallow' });
  shallow.collidesCircle = (x, z) => false;
  assert.throws(() => assertWorldDomain(shallow, 'shallow'),
    /collidesCircle declares 2 parameter\(s\), needs at least 3/);

  assert.throws(() => assertWorldDomain({ name: 'bare' }, 'bare'), /supportAt is missing/);
  assert.throws(() => probeWorldDomain(createFlatDomain(), {}), /requires lane\.from and lane\.toward/);
});

test('a probe that cannot distinguish a solid from open ground fails its own judgement', () => {
  // Negative control for the probe: a domain that never reports a contact must
  // not be able to pass. Without this, the semantics above could be satisfied by
  // a world that simply refuses to move.
  const hollow = createFlatDomain({ name: 'hollow', solidAt: () => false });
  const probe = probeWorldDomain(hollow, {
    lane: { from: { x: 0, z: 0 }, toward: { x: 4, z: 0 } },
    step: {
      from: { x: 0, z: 0 }, level: { x: 1, z: 0 }, rise: { x: 0, z: 0 },
      policy: { maxStepUp: 0, maxStepDown: 0, maxSlope: Math.PI / 2 },
    },
    camera: { height: 1, clearDistance: 1 },
  });
  const verdict = judgeWorldDomain(probe);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some(f => f.includes('must end at a solid')), verdict.failures.join('; '));
  assert.ok(verdict.failures.some(f => f.includes('must report a contact')), verdict.failures.join('; '));
});

test('curated keeps the shipped terrain rule behind the interface', () => {
  const bridges = new BridgeManager(new THREE.Scene());
  const curated = createCuratedDomain({ bridges });
  try {
    // Support is still the highest of terrain and deck, including `heightAt`'s
    // `-Infinity` on open ground, which must not escape as a height.
    for (const [x, z] of [[0, 0], [-42, -20], [62, -44], [12, 40]]) {
      const expected = Math.max(tileHeight(x, z), bridges.heightAt(x, z));
      assert.equal(curated.supportAt(x, z, {}).y, expected, `curated support at ${x},${z}`);
    }
    // The four-corner sampling the player used to inline is now the shared
    // helper, and it must agree with the old arithmetic exactly.
    for (const [x, z] of [[-42, -20], [0, 0], [30, 12]]) {
      let expected = -Infinity;
      for (const dx of [-.55, .55]) for (const dz of [-.55, .55]) {
        expected = Math.max(expected, Math.max(tileHeight(x + dx, z + dz), bridges.heightAt(x + dx, z + dz)));
      }
      assert.equal(supportUnderFoot(curated, x, z, CURATED_FOOTPRINT_HALF_EXTENT, {}).y, expected,
        `footprint support at ${x},${z}`);
    }
    // The step policy reproduces `floor > y + .55`: a rise over the limit is
    // named, and a level pair inside one tile is accepted.
    const step = curatedStepPoints(bridges, bridgeLane(bridges).rail);
    const rejected = curated.resolveGroundStep(step.from.x, step.from.z, step.rise.x, step.rise.z,
      step.policy, {});
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, 'step-up');
    const accepted = curated.resolveGroundStep(step.from.x, step.from.z, step.level.x, step.level.z,
      step.policy, {});
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.reason, 'accepted');
    assert.throws(() => curated.resolveGroundStep(0, 0, 1, 1, { maxStepUp: -1 }, {}), /Invalid ground-step policy/);
  } finally { bridges.dispose(); }
});

test('the bridge fixtures the probe relies on are the ones that exist', () => {
  // If the fixture set changed so that no rail is usable as a lane, the gate
  // above would throw rather than pass. This asserts the precondition loudly.
  const bridges = new BridgeManager(new THREE.Scene());
  try {
    assert.ok(BRIDGES.length > 0);
    assert.ok(bridges.rails.length > 0, 'curated bridges must expose rail boxes');
    assert.doesNotThrow(() => bridgeLane(bridges));
  } finally { bridges.dispose(); }
});
