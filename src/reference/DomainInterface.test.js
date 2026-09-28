import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_DOMAIN_NAMESPACE,
  GDO_KNOWN_DOMAINS,
  assertDomainCompliance,
  createSupportQuery,
  describeDomain,
  describeDomainCompliance,
} from '../engine/DomainInterface.js';
import { BridgeManager } from './BridgeManager.js';
import { GDO_CURATED_WORLD_DOMAIN, WORLD, BiomeManager } from './BiomeManager.js';
import { GDO_CURATED_PLAYER_DOMAIN, Player, tileHeight } from './Player.js';
import { GDO_COORDINATE_WORLD_DOMAIN, GeoWorld } from '../geo/GeoWorld.js';
import { GDO_COORDINATE_PLAYER_DOMAIN, GeoPlayer, cameraNearPlaneSweepRadius } from '../geo/GeoPlayer.js';

/**
 * `FND-08` gate: the curated island and the streamed coordinate world must be
 * consumable by the same code while keeping their own scales. These tests drive
 * the real implementations, not stubs.
 */

const COORDINATE = { latitude: 28.9845, longitude: 77.7064 };

/** GeoPlayer attaches key/pointer listeners to the global targets. */
function withGlobals(run) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const windowTarget = new EventTarget();
  windowTarget.devicePixelRatio = 1;
  const documentTarget = new EventTarget();
  documentTarget.exitPointerLock = () => {};
  documentTarget.pointerLockElement = null;
  globalThis.window = windowTarget;
  globalThis.document = documentTarget;
  try {
    return run();
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
}

function fixtureWorker() {
  return class {
    addEventListener() {}
    postMessage() {}
    terminate() {}
  };
}

function createCuratedWorld(scene = new THREE.Scene()) {
  const world = new BiomeManager(scene, { loadRadius: 0, budgetMs: 1 });
  const bridges = new BridgeManager(scene);
  const camera = new THREE.PerspectiveCamera(62, 4 / 3, .08, 320);
  const player = new Player(scene, camera, bridges, {
    inputTarget: new EventTarget(),
    canvas: { addEventListener() {}, removeEventListener() {}, ownerDocument: null },
    spawn: new THREE.Vector3(-42, 3, -20),
  });
  return { world, player, bridges, camera, dispose() { player.dispose(); bridges.dispose(); } };
}

test('both worlds satisfy one interface at different scales', () => {
  const scene = new THREE.Scene();
  const curated = createCuratedWorld(scene);
  const previousWorker = globalThis.Worker;
  globalThis.Worker = fixtureWorker();
  const coordinate = new GeoWorld(new THREE.Scene(), { ...COORDINATE });
  try {
    const islandReport = describeDomainCompliance(curated.world, GDO_CURATED_WORLD_DOMAIN);
    const streamedReport = describeDomainCompliance(coordinate, GDO_COORDINATE_WORLD_DOMAIN);
    assert.equal(islandReport.ok, true, islandReport.detail);
    assert.equal(streamedReport.ok, true, streamedReport.detail);
    assert.equal(islandReport.namespace, GDO_DOMAIN_NAMESPACE);

    assert.deepEqual([...GDO_KNOWN_DOMAINS], [curated.world.domain.id, coordinate.domain.id]);
    // Same interface, deliberately different scale and residency shape.
    assert.equal(curated.world.domain.unitsPerMetre, 1);
    assert.equal(coordinate.domain.unitsPerMetre, .1);
    assert.equal(curated.world.domain.streaming, null);
    assert.deepEqual(coordinate.domain.streaming, { chunkSize: 2048, residentLimit: 4 });
    assert.deepEqual(curated.world.domain.bounds, { minX: WORLD.min, maxX: WORLD.max, minZ: WORLD.min, maxZ: WORLD.max });
    assert.equal(coordinate.domain.bounds, null, 'a streamed world declares residency instead of world bounds');
    assert.equal(describeDomain(coordinate.domain).includes('streamed/4'), true);
    assert.equal(describeDomain(curated.world.domain).includes('fixed'), true);
    assert.equal(coordinate.domain.worldUnits(30), 3);
    assert.equal(curated.world.domain.worldUnits(30), 30);
    // The same metric distance is a different number of world units per domain.
    assert.equal(curated.world.domain.metres(coordinate.domain.worldUnits(30)), 3);
    assert.equal(curated.world.domain.metres(30), 30);
    assert.equal(coordinate.domain.metres(30), 300);

    // Declared capabilities are the honest ones.
    assert.equal(coordinate.domain.capabilities.coordinates, true);
    assert.equal(coordinate.domain.capabilities.labels, true);
    assert.equal(curated.world.domain.capabilities.coordinates, false);
    assert.equal(curated.world.domain.capabilities.streamed, false);
    // `COL-06`: the island now answers the shared sweep member too, so both
    // worlds declare the same capability and are consumed by the same code.
    assert.equal(curated.world.domain.capabilities.dynamicSweep, true);
    assert.equal(coordinate.domain.capabilities.dynamicSweep, true);
  } finally {
    coordinate.dispose();
    curated.dispose();
    globalThis.Worker = previousWorker;
  }
});

test('players satisfy the shared control contract in both modes', () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = fixtureWorker();
  const scene = new THREE.Scene();
  const curated = createCuratedWorld(scene);
  const coordinate = new GeoWorld(new THREE.Scene(), { ...COORDINATE });
  const geoCamera = new THREE.PerspectiveCamera(68, 16 / 9, .02, 210);
  const geoCanvas = { addEventListener() {}, removeEventListener() {}, ownerDocument: null, style: {}, requestPointerLock() {} };
  const geoPlayer = withGlobals(() => new GeoPlayer(new THREE.Scene(), geoCamera, geoCanvas, coordinate, {}));
  try {
    const curatedReport = describeDomainCompliance(curated.player, GDO_CURATED_PLAYER_DOMAIN);
    const coordinateReport = describeDomainCompliance(geoPlayer, GDO_COORDINATE_PLAYER_DOMAIN);
    assert.equal(curatedReport.ok, true, curatedReport.detail);
    assert.equal(coordinateReport.ok, true, coordinateReport.detail);
    assert.deepEqual(GDO_CURATED_PLAYER_DOMAIN.cameraModes, ['third-person', 'map']);
    assert.deepEqual(GDO_COORDINATE_PLAYER_DOMAIN.cameraModes, ['first-person', 'third-person']);

    // Analog input moves both avatars through the same call.
    curated.player.enabled = true;
    curated.player.setPosition(-42, -20);
    const curatedStart = curated.player.position.clone();
    curated.player.setMoveInput(0, 1);
    for (let step = 0; step < 20; step++) curated.player.update(1 / 30);
    assert.ok(curated.player.position.distanceTo(curatedStart) > .2, 'curated avatar moved on analog input');
    curated.player.setMoveInput(0, 0);

    geoPlayer.enabled = true;
    geoPlayer.setPosition(0, 0);
    const coordinateStart = geoPlayer.position.clone();
    geoPlayer.setMoveInput(0, 1);
    for (let step = 0; step < 20; step++) geoPlayer.update(1 / 30);
    assert.ok(geoPlayer.position.distanceTo(coordinateStart) > .01, 'coordinate avatar moved on analog input');
    geoPlayer.setMoveInput(0, 0);

    // Camera-mode toggles are part of the interface for both avatars.
    assert.equal(curated.player.cameraMode, 'third-person');
    assert.equal(curated.player.toggleCameraMode(), 'map');
    assert.equal(describeDomainCompliance(curated.player, GDO_CURATED_PLAYER_DOMAIN).ok, true);
    assert.equal(geoPlayer.cameraMode, 'first-person');
    assert.equal(geoPlayer.toggleCameraMode(), 'third-person');
    assert.equal(describeDomainCompliance(geoPlayer, GDO_COORDINATE_PLAYER_DOMAIN).ok, true);
    assert.equal(typeof curated.player.querySnapshot, 'function');
    assert.equal(geoPlayer.querySnapshot().mode, 'third-person');
  } finally {
    // Disposal touches window/document, so it must run inside the same globals.
    withGlobals(() => geoPlayer.dispose());
    coordinate.dispose();
    curated.dispose();
    globalThis.Worker = previousWorker;
  }
});

test('one support query serves both worlds, in their own units', () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = fixtureWorker();
  const curated = createCuratedWorld();
  const coordinate = new GeoWorld(new THREE.Scene(), { ...COORDINATE });
  try {
    const islandQuery = createSupportQuery(curated.world, GDO_CURATED_WORLD_DOMAIN);
    const streamedQuery = createSupportQuery(coordinate, GDO_COORDINATE_WORLD_DOMAIN);
    assert.equal(islandQuery.domainId, 'curated');
    assert.equal(streamedQuery.domainId, 'coordinate');

    // The curated island is analytic terrain; the coordinate world's tile grid
    // agrees with its own player-height path.
    const islandSample = islandQuery.support(-42, -20);
    assert.equal(islandSample.y, tileHeight(-42, -20));
    const streamedSample = streamedQuery.support(0, 0);
    assert.equal(Number.isFinite(streamedSample.y), true);
    assert.equal(streamedSample.y, coordinate.supportAt(0, 0, {}).y);

    // One shared consumer: the camera sweep with each world's own profile radius.
    const camera = new THREE.PerspectiveCamera(68, 16 / 9, .02, 210);
    const radius = cameraNearPlaneSweepRadius(camera);
    const mappedClearance = coordinate.querySweep(0, 4, 0, 0, 0, 12, radius, {});
    assert.equal(typeof mappedClearance.hit, 'boolean');
    assert.equal(Number.isFinite(mappedClearance.time), true);
    assert.ok(coordinate.querySnapshot().queries.sphereSweeps >= 1);
    assert.ok(curated.world.querySnapshot().chunks <= curated.world.descriptors.length);

    // `COL-06`: the island answers the same member, with the same record shape,
    // and its own live structures are the ones that answer.
    // (The island's terrain is support, not a camera blocker, so the sweep is
    // aimed at a real structure: the elevated railway deck at z = -80.)
    const islandSweep = curated.world.querySweep(-64, 12, -80, 0, -8, 0, .3, {});
    assert.equal(typeof islandSweep.hit, 'boolean');
    assert.equal(Number.isFinite(islandSweep.time), true);
    assert.equal(islandSweep.hit, true, 'the island structure answers the sweep');
    assert.equal(islandSweep.blockerId, 'railway:deck');
    assert.equal(islandSweep.blockerRole, 'camera-blocker');
    assert.equal(Object.hasOwn(islandSweep, 'blockerMask'), true, 'the same record keys as the mapped sweep');
    assert.equal(Object.hasOwn(mappedClearance, 'blockerMask'), true);
    assert.equal(curated.world.querySnapshot().sweep.namespace, 'gdo:structureSweep:v1');
    // A drifted curated world fails the same way the mapped one does.
    const driftedIsland = Object.assign(Object.create(Object.getPrototypeOf(curated.world)), curated.world, { querySweep: undefined });
    assert.deepEqual(describeDomainCompliance(driftedIsland, GDO_CURATED_WORLD_DOMAIN).violations.map(item => item.member), ['querySweep']);
  } finally {
    coordinate.dispose();
    curated.dispose();
    globalThis.Worker = previousWorker;
  }
});

test('a drifted implementation fails loudly instead of at frame time', () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = fixtureWorker();
  const world = new GeoWorld(new THREE.Scene(), { ...COORDINATE });
  try {
    assert.equal(describeDomainCompliance(world, GDO_COORDINATE_WORLD_DOMAIN).ok, true);
    const drifted = Object.assign(Object.create(Object.getPrototypeOf(world)), world, { querySweep: undefined });
    const report = describeDomainCompliance(drifted, GDO_COORDINATE_WORLD_DOMAIN);
    assert.equal(report.ok, false);
    assert.deepEqual(report.violations.map(item => item.member), ['querySweep']);
    assert.throws(() => assertDomainCompliance(drifted, GDO_COORDINATE_WORLD_DOMAIN), /dynamicSweep declared without a sweep query/);
  } finally {
    world.dispose();
    globalThis.Worker = previousWorker;
  }
});
