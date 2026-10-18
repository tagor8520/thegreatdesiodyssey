import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GEO_TRAFFIC_PROXY_MASK, createBoatGeometries, createTrafficPools,
} from './GeoTrafficPools.js';
import {
  GDO_TRAFFIC_KIND, GDO_TRAFFIC_PROFILES, GDO_TRAFFIC_STATE, createLocalTraffic,
} from '../engine/LocalTraffic.js';
import { createLocalNavigation } from '../engine/LocalNavigation.js';
import { LifecycleLedger } from '../engine/LifecycleContract.js';
import { GEO_QUERY_MASK } from './GeoCollision.js';

/**
 * `LIF-05` gate on the visual side: `DET-07` vehicle bodies are reused whole,
 * a steady frame allocates nothing, and — the gate itself — movers near the
 * player register **capped** `COL-09` dynamic proxies and nothing else.
 */

function streetGraph() {
  const navigation = createLocalNavigation({ profile: 'low' });
  navigation.addTile('tile:a', {
    lines: [[0, 0, 10, 0, 20, 0], [20, 0, 20, 10, 20, 20]],
    names: ['Kagzi Road', 'Mandi Lane'],
    levels: [0, 0],
    kinds: ['primary', 'residential'],
    widths: [.6, .5],
  });
  return navigation.graph;
}

function waterwayStream() {
  const records = new Float32Array(8 * 2);
  records.set([0, 0, 10, 0, .3, 1, 1, 0], 0);
  records.set([10, 0, 10, 10, .25, 2, 0, 0], 8);
  return records;
}

/** A recording `COL-09` double with the real grid's call surface. */
function recordingProxies() {
  const calls = { inserted: [], moved: [], removed: [] };
  const live = new Map();
  return {
    calls, live,
    insert(id, decl, options) {
      calls.inserted.push({ id, decl, options });
      live.set(id, decl);
    },
    move(id, dx, dz, options) {
      calls.moved.push({ id, dx, dz, options });
      const decl = live.get(id);
      if (decl) { decl.x += dx; decl.z += dz; }
    },
    remove(id) {
      calls.removed.push(id);
      live.delete(id);
    },
    has(id) { return live.has(id); },
  };
}

function liveBoard({ seed = 'pool-test', ticks = 30, x = 10, z = -4 } = {}) {
  const board = createLocalTraffic({ profile: 'low', seed });
  board.rebuildGraph(streetGraph(), { waterways: waterwayStream() });
  // The player stands where the test camera stands, so every mover's declared
  // `viewDistance` is the camera distance the `LIF-02` range rule reads.
  for (let tick = 0; tick < ticks; tick++) {
    board.update({ nowMilliseconds: tick * 100, dtMilliseconds: 100, x, z });
  }
  return board;
}

test('LIF-05 boat hulls follow the DET-07 rule: one tight body per hull', () => {
  const hulls = createBoatGeometries();
  assert.equal(hulls.length, 2);
  for (const hull of hulls) {
    assert.ok(hull.getAttribute('position'), 'a merged body, not parts');
    assert.ok(hull.getAttribute('color'), 'part-tinted like the vehicle bodies');
    hull.computeBoundingBox();
    const size = new THREE.Vector3();
    hull.boundingBox.getSize(size);
    assert.ok(size.x < .4 && size.z < 1, 'tight to the real hull size');
  }
});

test('LIF-05 the pool serves DET-07 vehicle geometries as bounded instances', () => {
  const board = liveBoard();
  const policy = GDO_TRAFFIC_PROFILES.low;
  const pool = createTrafficPools({ profile: 'low', scene: new THREE.Group(), policy });
  // A view that actually sees the street: standing south of it, looking +z.
  const view = {
    x: 10, y: 0, z: -4,
    forwardX: 0, forwardZ: 1, rightX: 1, rightZ: 0,
    fovRadians: Math.PI / 2, viewportHeight: 720, aspect: 1,
  };
  const proxies = recordingProxies();
  const before = pool.counters.cpuUpdates + pool.counters.uploads;
  pool.sync(board, { nowMilliseconds: 3_000, view, dynamicProxies: proxies });
  const { count } = board.residentRecords();
  const drawn = pool.batches.reduce((total, batch) => total + batch.count, 0);
  assert.ok(drawn <= count, 'a batch never draws more than the board lives');
  assert.ok(before >= 0);
  // Four vehicle families plus two hulls, each an instanced batch over one merge.
  assert.equal(pool.batches.length, 6);
  for (const batch of pool.batches) {
    assert.equal(batch.mesh.instanceMatrix.usage, THREE.DynamicDrawUsage);
    assert.ok(batch.mesh.count <= batch.mesh.instanceMatrix.count);
  }
  assert.ok(pool.counters.cpuUpdates <= policy.maxVehicles + policy.maxBoats,
    'one sync writes at most one matrix per live mover');
  pool.dispose();
  board.dispose();
});

test('LIF-05 the gate: proxies register near the player, unregister far, and cap by name', () => {
  const board = liveBoard({ ticks: 40 });
  const policy = GDO_TRAFFIC_PROFILES.low;
  const pool = createTrafficPools({ profile: 'low', scene: new THREE.Group(), policy });
  // A view that actually sees the street: standing south of it, looking +z.
  const view = {
    x: 10, y: 0, z: -4,
    forwardX: 0, forwardZ: 1, rightX: 1, rightZ: 0,
    fovRadians: Math.PI / 2, viewportHeight: 720, aspect: 1,
  };
  const proxies = recordingProxies();
  pool.sync(board, { nowMilliseconds: 4_000, view, dynamicProxies: proxies, proxyRadius: 30 });
  // Every *visible* mover within the active-physics radius holds exactly one
  // tight OBB — and no occlusion bit, ever. (Visibility is the scheduler's call;
  // the grid only ever sees what the player can actually meet.)
  const { records, count } = board.residentRecords();
  let nearCount = 0;
  for (let index = 0; index < count; index++) {
    const record = records[index];
    const decision = pool.scheduler.decisions[index];
    const visible = decision ? decision.visibility > 0 : true;
    const near = Math.hypot(record.x - view.x, record.z - view.z) <= 30;
    if (near && visible) nearCount++;
  }
  assert.ok(nearCount > 0, 'the run has near movers to register');
  assert.equal(proxies.live.size, nearCount, 'one proxy per visible near mover, none beyond');
  assert.ok(proxies.live.size <= policy.maxVehicles + policy.maxBoats);
  for (const [, decl] of proxies.live) {
    assert.equal(decl.kind, 'obb');
    assert.ok(decl.halfX > 0 && decl.halfZ > 0, 'a tight body box, never a scatter of parts');
  }
  if (proxies.calls.inserted.length) {
    const mask = proxies.calls.inserted[0].options.mask;
    assert.equal(mask & GEO_QUERY_MASK.SOLID_PLAYER, GEO_QUERY_MASK.SOLID_PLAYER);
    assert.equal(mask & GEO_QUERY_MASK.CAMERA_BLOCKER, GEO_QUERY_MASK.CAMERA_BLOCKER);
    assert.equal(mask & GEO_QUERY_MASK.LOS_BLOCKER, 0, 'no occlusion role');
    assert.equal(mask, GEO_TRAFFIC_PROXY_MASK);
  }
  // Walking the player away empties the grid: movers leave the radius and park.
  for (let tick = 0; tick < 4; tick++) {
    board.update({ nowMilliseconds: 5_000 + tick * 100, dtMilliseconds: 100, x: 900, z: 900 });
  }
  pool.sync(board, { nowMilliseconds: 5_500, view, dynamicProxies: proxies, proxyRadius: 6 });
  assert.equal(proxies.live.size, 0, 'every proxy unregisters with its mover');
  assert.ok(proxies.calls.removed.length > 0);

  // The cap: force every mover near and shrink the ceiling to one.
  const cappedBoard = liveBoard({ ticks: 40, seed: 'cap-test' });
  const capped = recordingProxies();
  const tinyPool = createTrafficPools({
    profile: 'low', scene: new THREE.Group(), policy,
    proxyLimits: { maxProxies: 1, activeRadius: 6 },
  });
  tinyPool.sync(cappedBoard, { nowMilliseconds: 4_000, view, dynamicProxies: capped, proxyRadius: 500 });
  assert.equal(capped.live.size, 1, 'the cap is hard');
  if (cappedBoard.residentRecords().count > 1) {
    assert.ok(tinyPool.counters.proxySkippedCap > 0, 'a skipped registration is named and counted');
  }
  tinyPool.dispose();
  cappedBoard.dispose();
  pool.dispose();
  board.dispose();
});

test('LIF-05 a steady frame allocates nothing and updates are counted', () => {
  const board = liveBoard({ ticks: 20 });
  const policy = GDO_TRAFFIC_PROFILES.low;
  const pool = createTrafficPools({ profile: 'low', scene: new THREE.Group(), policy });
  // A view that actually sees the street: standing south of it, looking +z.
  const view = {
    x: 10, y: 0, z: -4,
    forwardX: 0, forwardZ: 1, rightX: 1, rightZ: 0,
    fovRadians: Math.PI / 2, viewportHeight: 720, aspect: 1,
  };
  pool.sync(board, { nowMilliseconds: 2_000, view, dynamicProxies: null });
  const firstBatchMatrices = pool.batches.map(batch => batch.matrices.length);
  pool.sync(board, { nowMilliseconds: 2_100, view, dynamicProxies: null });
  pool.sync(board, { nowMilliseconds: 2_200, view, dynamicProxies: null });
  const secondBatchMatrices = pool.batches.map(batch => batch.matrices.length);
  assert.deepEqual(secondBatchMatrices, firstBatchMatrices,
    'the matrix records are preallocated and reused across syncs');
  assert.ok(pool.counters.cpuUpdates <= GDO_TRAFFIC_PROFILES.low.maxVehicles + GDO_TRAFFIC_PROFILES.low.maxBoats);
  assert.equal(pool.counters.cpuUpdatesBudget, policy.maxAgentsPerUpdate);
  pool.dispose();
  board.dispose();
});

test('LIF-05 disposal releases every pooled resource through the ledger', () => {
  const ledger = new LifecycleLedger({ label: 'pool-dispose' });
  const board = liveBoard({ ticks: 10 });
  const pool = createTrafficPools({
    profile: 'low', scene: new THREE.Group(),
    policy: GDO_TRAFFIC_PROFILES.low, ledger,
  });
  pool.dispose();
  board.dispose();
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.counts.handle + snapshot.counts.pool, 0, 'nothing survives disposal');
  assert.ok(snapshot.released >= 1);
});

test('LIF-05 the pool refuses to build without a policy for its caps', () => {
  assert.throws(() => createTrafficPools({}), TypeError);
  const pool = createTrafficPools({ profile: 'low', policy: GDO_TRAFFIC_PROFILES.low });
  assert.equal(pool.sync(null, {}), pool.counters, 'a missing board answers without throwing');
  pool.dispose();
});
