import test from 'node:test';
import assert from 'node:assert/strict';
import { featureAvailable, featureNamespace, GDO_FEATURE_VERSIONS } from './FeatureVersions.js';
import {
  GDO_CAMERA_MODES,
  GDO_DOMAIN_KIND,
  GDO_DOMAIN_NAMESPACE,
  GDO_KNOWN_DOMAINS,
  GDO_WORLD_CAPABILITIES,
  assertDomainCompliance,
  createSupportQuery,
  definePlayerDomain,
  defineWorldDomain,
  describeDomain,
  describeDomainCompliance,
} from './DomainInterface.js';

/** Minimal compliant pair: one streamed, one fixed, with different scales. */
function streamedWorld() {
  const domain = defineWorldDomain({
    id: 'coordinate',
    unitsPerMetre: .1,
    streaming: { chunkSize: 2048, residentLimit: 4 },
    capabilities: { coordinates: true, terrainSupport: true, dynamicSweep: true, labels: true, streamed: true, verticalGrades: true },
  });
  return {
    domain,
    unitsPerMetreScale: .1,
    visibleLabels: [],
    bounds: null,
    update() {},
    dispose() {},
    coordinateAt(x, z) { return { latitude: 28 + z * 1e-5, longitude: 77 + x * 1e-5 }; },
    querySupport(x, z, out = {}) { out.y = x * .01 + z * .02; return out; },
    querySweep() { return { hit: false, time: 1 }; },
    querySnapshot() { return { tiles: 1 }; },
  };
}

function fixedWorld() {
  const domain = defineWorldDomain({
    id: 'curated',
    unitsPerMetre: 1,
    bounds: { minX: -128, maxX: 128, minZ: -128, maxZ: 128 },
    capabilities: { terrainSupport: true, verticalGrades: true },
  });
  return {
    domain,
    unitsPerMetreScale: 1,
    bounds: { minX: -128, maxX: 128, minZ: -128, maxZ: 128 },
    update() {},
    dispose() {},
    querySupport(x, z, out = {}) { out.y = Math.max(0, 4 - Math.hypot(x, z) * .01); return out; },
    querySnapshot() { return { chunks: 3 }; },
  };
}

function playerWith(overrides = {}) {
  const domain = definePlayerDomain({
    id: 'coordinate-player',
    worldId: 'coordinate',
    cameraModes: ['first-person', 'third-person'],
    capabilities: { analogInput: true, jump: true, pointerLook: true, touch: true },
  });
  return {
    playerDomain: domain,
    position: { x: 1, y: 2, z: 3 },
    enabled: true,
    cameraMode: 'first-person',
    update() {},
    dispose() {},
    setMoveInput() {},
    setPosition() {},
    toggleCameraMode() { this.cameraMode = this.cameraMode === 'first-person' ? 'third-person' : 'first-person'; return this.cameraMode; },
    ...overrides,
  };
}

test('a world descriptor declares identity, scale, residency, and honest capabilities', () => {
  const domain = defineWorldDomain({
    id: 'coordinate',
    unitsPerMetre: .1,
    streaming: { chunkSize: 2048, residentLimit: 4 },
    capabilities: { coordinates: true, streamed: true, terrainSupport: true },
  });
  assert.equal(domain.namespace, GDO_DOMAIN_NAMESPACE);
  assert.equal(domain.kind, GDO_DOMAIN_KIND.WORLD);
  assert.equal(domain.unitsPerMetre, .1);
  assert.deepEqual(domain.streaming, { chunkSize: 2048, residentLimit: 4 });
  assert.equal(domain.capabilities.coordinates, true);
  assert.equal(domain.capabilities.labels, false, 'undeclared capabilities default to false');
  assert.equal(domain.worldUnits(10), 1);
  assert.equal(domain.metres(1), 10);
  assert.deepEqual(GDO_WORLD_CAPABILITIES.slice(0, 3), ['coordinates', 'terrainSupport', 'dynamicSweep']);
});

test('world and player descriptors reject malformed input instead of guessing', () => {
  assert.throws(() => defineWorldDomain({ unitsPerMetre: 1, bounds: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 } }), /stable string id/);
  assert.throws(() => defineWorldDomain({ id: 'x', unitsPerMetre: 0, bounds: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 } }), /positive finite unitsPerMetre/);
  assert.throws(() => defineWorldDomain({ id: 'x', unitsPerMetre: 1 }), /finite bounds or the streamed capability/);
  assert.throws(() => defineWorldDomain({ id: 'x', unitsPerMetre: 1, bounds: { minX: 1, maxX: 1, minZ: 0, maxZ: 1 } }), /ordered finite bounds/);
  assert.throws(() => defineWorldDomain({ id: 'x', unitsPerMetre: 1, bounds: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, capabilities: { teleport: true } }), /Unknown world-domain capability/);
  assert.throws(() => defineWorldDomain({
    id: 'x', unitsPerMetre: 1, streaming: { chunkSize: 4, residentLimit: 0 }, capabilities: { streamed: true },
  }), /resident limit of at least one/);
  assert.throws(() => defineWorldDomain({
    id: 'x', unitsPerMetre: 1, streaming: { chunkSize: 0, residentLimit: 4 }, capabilities: { streamed: true },
  }), /positive chunkSize/);
  assert.throws(() => definePlayerDomain({ id: 'p', cameraModes: ['cinematic'] }), /known camera mode/);
  assert.throws(() => definePlayerDomain({ id: 'p' }), /at least one known camera mode/);
  assert.deepEqual(GDO_CAMERA_MODES, ['first-person', 'third-person', 'map']);
});

test('compliance proves both a fixed-scale island and a streamed 1:10 world satisfy one interface', () => {
  for (const world of [streamedWorld(), fixedWorld()]) {
    const report = describeDomainCompliance(world, world.domain);
    assert.equal(report.ok, true, report.detail);
    assert.equal(report.violations.length, 0);
    assert.match(report.detail, /required members and \d+ capabilities satisfied/);
  }
  const island = describeDomainCompliance(fixedWorld(), fixedWorld().domain);
  assert.equal(island.kind, 'world');
  // The two domains share the interface but not a scale.
  assert.equal(describeDomain(streamedWorld().domain).includes('.1 u/m'), true);
  assert.equal(describeDomain(fixedWorld().domain).includes('1 u/m'), true);
  assert.equal(describeDomain(streamedWorld().domain).includes('streamed/4'), true);
  assert.equal(describeDomain(fixedWorld().domain).includes('fixed'), true);
  assert.equal(describeDomain(null), 'no domain');
});

test('compliance names the exact missing member or unhonoured capability', () => {
  const world = streamedWorld();
  delete world.querySweep;
  const missingSweep = describeDomainCompliance(world, world.domain);
  assert.equal(missingSweep.ok, false);
  assert.deepEqual(missingSweep.violations.map(item => item.member), ['querySweep']);
  assert.match(missingSweep.violations[0].reason, /dynamicSweep declared without a sweep query/);

  const labelLess = streamedWorld();
  labelLess.visibleLabels = null;
  assert.deepEqual(describeDomainCompliance(labelLess, labelLess.domain).violations.map(item => item.member), ['visibleLabels']);

  const brokenSupport = fixedWorld();
  brokenSupport.querySupport = () => ({ y: Number.NaN });
  const brokenReport = describeDomainCompliance(brokenSupport, brokenSupport.domain);
  assert.equal(brokenReport.ok, false);
  assert.equal(brokenReport.violations.some(item => item.member === 'querySupport'), true);
  assert.throws(() => assertDomainCompliance(brokenSupport, brokenSupport.domain), /Domain compliance failed/);

  const wiredToNothing = fixedWorld();
  assert.equal(describeDomainCompliance(wiredToNothing, defineWorldDomain({
    id: 'other', unitsPerMetre: 1, bounds: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 },
  })).violations[0].member, 'domain');

  assert.equal(describeDomainCompliance(null, null).ok, false);
  assert.equal(describeDomainCompliance({}, null).violations[0].member, 'descriptor');
  const noCoordinates = streamedWorld();
  delete noCoordinates.coordinateAt;
  assert.deepEqual(describeDomainCompliance(noCoordinates, noCoordinates.domain).violations.map(item => item.member), ['coordinateAt']);
});

test('player compliance covers both control surfaces and reports mode drift', () => {
  const player = playerWith();
  const report = describeDomainCompliance(player, player.playerDomain);
  assert.equal(report.ok, true, report.detail);
  assert.equal(player.playerDomain.kind, GDO_DOMAIN_KIND.PLAYER);
  assert.deepEqual(player.playerDomain.capabilities, { analogInput: true, jump: true, pointerLook: true, touch: true });

  player.cameraMode = 'map';
  assert.deepEqual(describeDomainCompliance(player, player.playerDomain).violations.map(item => item.member), ['cameraMode']);

  const keyboardOnly = playerWith({
    cameraMode: 'third-person',
    setMoveInput: undefined,
    position: { x: Number.NaN, y: 0, z: 0 },
  });
  const violations = describeDomainCompliance(keyboardOnly, keyboardOnly.playerDomain).violations.map(item => item.member);
  assert.deepEqual(violations, ['setMoveInput', 'position']);

  const singleMode = definePlayerDomain({ id: 'map-only', cameraModes: ['map'] });
  const mapPlayer = { playerDomain: singleMode, position: { x: 0, y: 0, z: 0 }, enabled: true, cameraMode: 'map', update() {}, dispose() {}, setMoveInput() {}, setPosition() {} };
  assert.equal(describeDomainCompliance(mapPlayer, singleMode).ok, true, 'one declared mode needs no toggle');
});

test('createSupportQuery gives both worlds one identical query shape in their own units', () => {
  for (const world of [streamedWorld(), fixedWorld()]) {
    const query = createSupportQuery(world, world.domain);
    assert.equal(query.domainId, world.domain.id);
    assert.equal(query.unitsPerMetre, world.domain.unitsPerMetre);
    const sample = query.support(32, -16);
    assert.equal(Number.isFinite(sample.y), true);
    assert.equal(sample.kind, 'ground');
    assert.equal(sample.slopeRadians, 0);
    const samples = query.sample([{ x: 0, z: 0 }, { x: 8, z: 8 }]);
    assert.equal(samples.length, 2);
    assert.equal(samples.every(entry => Number.isFinite(entry.y)), true);
    assert.throws(() => Object.assign(sample, { y: 99 }), TypeError, 'query records are frozen');
  }
  // The same metric request means different numbers in each world by design.
  const coordinate = createSupportQuery(streamedWorld(), streamedWorld().domain);
  const island = createSupportQuery(fixedWorld(), fixedWorld().domain);
  assert.equal(coordinate.unitsPerMetre, .1);
  assert.equal(island.unitsPerMetre, 1);
  assert.notEqual(coordinate.support(100, 100).y, undefined);
  assert.throws(() => createSupportQuery({}, null), /needs a world exposing querySupport/);
});

test('the contract namespace matches the feature registry', () => {
  assert.equal(featureNamespace('domainInterface'), GDO_DOMAIN_NAMESPACE);
  assert.equal(featureAvailable('domainInterface'), true);
  assert.equal(GDO_DOMAIN_NAMESPACE.endsWith(`v${GDO_FEATURE_VERSIONS.domainInterface}`), true);
  assert.deepEqual([...GDO_KNOWN_DOMAINS], ['curated', 'coordinate']);
});
