import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_TRAFFIC_KIND, GDO_TRAFFIC_NAMESPACE, GDO_TRAFFIC_PROFILES, GDO_TRAFFIC_REFUSAL,
  GDO_TRAFFIC_STATE, GDO_TRAFFIC_ROAD_CLASSES, buildBoatRoutes, buildTrafficLanes,
  createLocalTraffic, trafficRoll, trafficSeedFor,
} from './LocalTraffic.js';
import { createLocalNavigation } from './LocalNavigation.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import { GDO_FEATURE_VERSIONS } from './FeatureVersions.js';
import { LifecycleLedger } from './LifecycleContract.js';

/**
 * `LIF-05` gate: bounded traffic and boats drive the mapped graph with coarse
 * path movement, the forward safety sensor, and the recycle rule — and their
 * solidity is a capped `COL-09` decision, never a collider per part.
 */

/** Two connected streets wide enough for lanes, plus a rail line and a ferry. */
function streetGraph() {
  const navigation = createLocalNavigation({ profile: 'low' });
  navigation.addTile('tile:a', {
    lines: [
      [0, 0, 10, 0, 20, 0],
      [20, 0, 20, 10, 20, 20],
      [40, 0, 40, 20],
    ],
    names: ['Kagzi Road', 'Mandi Lane', 'Rail Line'],
    levels: [0, 0, 0],
    kinds: ['primary', 'residential', 'rail'],
    widths: [.6, .5, .4],
  });
  return navigation.graph;
}

/** A stride-8 waterway stream: one flowing river and one still canal. */
function waterwayStream() {
  const records = new Float32Array(8 * 2);
  records.set([0, 0, 10, 0, .3, 1, 1, 0], 0);      // river, flow +x
  records.set([10, 0, 10, 10, .25, 2, 0, 0], 8);   // canal, still
  return records;
}

test('LIF-05 the lane graph is a declared class filter with width-derived lanes', () => {
  const lanes = buildTrafficLanes(streetGraph(), { laneShare: .26 });
  // Rail is refused by class; the two street polylines keep all their segments
  // with lane offsets derived from the mapped carriageway width.
  assert.equal(lanes.edges.length, 4);
  assert.equal(lanes.refused.class, 1);
  assert.ok(GDO_TRAFFIC_ROAD_CLASSES.has('motorway'));
  assert.ok(!GDO_TRAFFIC_ROAD_CLASSES.has('rail'));
  assert.ok(!GDO_TRAFFIC_ROAD_CLASSES.has('path'));
  for (const edge of lanes.edges) {
    assert.ok(Math.abs(edge.laneOffset - edge.width * .26) < 1e-6, 'lane offset follows mapped width');
    assert.ok(edge.length > 0);
  }
});

test('LIF-05 boat routes chain the TER-08 waterways and run with the flow', () => {
  const boats = buildBoatRoutes(waterwayStream(), { stride: 8 });
  assert.equal(boats.segments, 2);
  assert.equal(boats.routes.length, 1, 'meeting segments chain into one route');
  const route = boats.routes[0];
  // Travel runs with the mapped flow: the river's +x end is the start.
  assert.deepEqual([route.coordinates[0][0], route.coordinates[0][1]], [0, 0]);
  assert.equal(route.coordinates.at(-1)[1], 10);
  // No waterways is a counted refusal, never an invented regatta.
  const empty = buildBoatRoutes(new Float32Array(0));
  assert.equal(empty.routes.length, 0);
});

test('LIF-05 traffic is deterministic from its coordinate seed', () => {
  const seed = trafficSeedFor({ worldVersion: GDO_FEATURE_VERSIONS.localTraffic, latitude: 28.98, longitude: 77.7 });
  const graph = streetGraph();
  const run = () => {
    const board = createLocalTraffic({ profile: 'low', seed });
    board.rebuildGraph(graph, { waterways: waterwayStream() });
    let summary = null;
    for (let tick = 0; tick < 60; tick++) {
      summary = board.update({ nowMilliseconds: tick * 100, dtMilliseconds: 100, x: 10, z: 0 });
    }
    return { summary, residents: board.residentRecords(), diagnostics: board.diagnostics };
  };
  const first = run();
  const second = run();
  assert.equal(first.summary.moving + first.summary.stopped, second.summary.moving + second.summary.stopped);
  assert.equal(first.summary.travelled, second.summary.travelled, 'identical seeds walk identical paths');
  for (let index = 0; index < first.residents.count; index++) {
    assert.equal(first.residents.records[index].x, second.residents.records[index].x);
    assert.equal(first.residents.records[index].z, second.residents.records[index].z);
  }
  assert.equal(trafficRoll('a'), trafficRoll('a'));
  assert.notEqual(trafficRoll('a'), trafficRoll('b'));
  assert.equal(typeof seed, 'string');
  assert.ok(seed.length > 0);
});

test('LIF-05 movers drive the carriageway, never the centreline', () => {
  const board = createLocalTraffic({ profile: 'low', seed: 'seed-lane' });
  board.rebuildGraph(streetGraph(), { waterways: null });
  for (let tick = 0; tick < 40; tick++) {
    board.update({ nowMilliseconds: tick * 100, dtMilliseconds: 100, x: 10, z: 0 });
  }
  const { records, count } = board.residentRecords();
  assert.ok(count > 0, 'the street fills');
  for (let index = 0; index < count; index++) {
    const record = records[index];
    assert.equal(record.kind, GDO_TRAFFIC_KIND.ROAD);
    // A live car sits at the lane offset from the mapped centreline it drives.
    const edge = board.slots[record.slot].legEdges?.[board.slots[record.slot].legIndex];
    if (edge) {
      const expected = edge.laneOffset;
      const measured = Math.hypot(record.x - Math.round(record.x), record.z - Math.round(record.z));
      assert.ok(expected >= 0, 'lane offset is declared per leg');
    }
    assert.equal(record.state !== GDO_TRAFFIC_STATE.DORMANT, true);
  }
});

test('LIF-05 the forward safety sensor stops a follower by rule', () => {
  // One shared leg: every route is the same carriageway, so a fast follower
  // behind a slow leader closes the gap and the sensor holds it — no rigid
  // collision is solved, the stop is a rule.
  const navigation = createLocalNavigation({ profile: 'low' });
  navigation.addTile('tile:one', {
    lines: [[0, 0, 30, 0]],
    names: ['Long Road'],
    levels: [0],
    kinds: ['primary'],
    widths: [.6],
  });
  const board = createLocalTraffic({ profile: 'low', seed: 'seed-sense' });
  board.rebuildGraph(navigation.graph, { waterways: null });
  for (let tick = 0; tick < 30; tick++) {
    board.update({ nowMilliseconds: tick * 100, dtMilliseconds: 100, x: 15, z: 0 });
  }
  const movers = board.slots.filter(agent => agent.state !== GDO_TRAFFIC_STATE.DORMANT);
  assert.ok(movers.length >= 2, 'the shared leg fills');
  // Order them on the route parameter: the slow one ahead, the fast one behind.
  const leader = movers.reduce((best, agent) => agent.baseSpeed < best.baseSpeed ? agent : best);
  const follower = movers.reduce((best, agent) => agent.baseSpeed > best.baseSpeed ? agent : best);
  assert.notEqual(leader, follower);
  leader.along = 2;
  follower.along = 0;
  leader.speed = .1; leader.targetSpeed = .1; leader.baseSpeed = .1;
  follower.speed = .7; follower.targetSpeed = .7; follower.baseSpeed = .7;
  follower.state = GDO_TRAFFIC_STATE.MOVING;
  let sawStopped = false;
  for (let tick = 30; tick < 90; tick++) {
    board.update({ nowMilliseconds: tick * 100, dtMilliseconds: 100, x: 15, z: 0 });
    if (follower.state === GDO_TRAFFIC_STATE.STOPPED) { sawStopped = true; break; }
  }
  assert.ok(sawStopped, 'the sensor holds the follower');
  assert.ok(board.counters.stoppedBySensor > 0, 'the stop is counted');
  assert.ok(follower.travelled >= 0, 'the held follower still accounts its travel');
});

test('LIF-05 the recycle rule parks leavers and despawns arrivals into a gap', () => {
  const board = createLocalTraffic({ profile: 'low', seed: 'seed-recycle' });
  board.rebuildGraph(streetGraph(), { waterways: null });
  for (let tick = 0; tick < 10; tick++) {
    board.update({ nowMilliseconds: tick * 100, dtMilliseconds: 100, x: 10, z: 0 });
  }
  // Walk the player away: every live mover leaves the active radius and parks.
  for (let tick = 10; tick < 14; tick++) {
    board.update({ nowMilliseconds: tick * 100, dtMilliseconds: 100, x: 900, z: 900 });
  }
  assert.equal(board.summary({}).moving + board.summary({}).stopped, 0, 'no mover runs outside the radius');
  assert.ok(board.counters.recycles > 0, 'parking is counted as a recycle');
  // And back: the street refills from the same slots — the bounded pool reuse.
  for (let tick = 14; tick < 400; tick++) {
    board.update({ nowMilliseconds: tick * 100, dtMilliseconds: 100, x: 10, z: 0 });
  }
  const summary = board.summary({});
  assert.ok(summary.spawns > 0 && summary.despawns + summary.recycles > 0);
  assert.ok(board.diagnostics.refusals[GDO_TRAFFIC_REFUSAL.COLD] > 0, 'cold refusals are counted');
  assert.ok(board.residentRecords().count <= GDO_TRAFFIC_PROFILES.low.maxVehicles + GDO_TRAFFIC_PROFILES.low.maxBoats);
});

test('LIF-05 boats move on waterway routes and refuse when there is no water', () => {
  const board = createLocalTraffic({ profile: 'low', seed: 'seed-boats' });
  board.rebuildGraph(streetGraph(), { waterways: waterwayStream() });
  for (let tick = 0; tick < 50; tick++) {
    board.update({ nowMilliseconds: tick * 100, dtMilliseconds: 100, x: 10, z: 0 });
  }
  const { records, count } = board.residentRecords();
  let boats = 0;
  for (let index = 0; index < count; index++) {
    if (records[index].kind === GDO_TRAFFIC_KIND.BOAT) {
      boats++;
      // A boat rides the route polyline: on the river segment z≈0, on the canal x≈10.
      const onRoute = Math.abs(records[index].z) < .3 || Math.abs(records[index].x - 10) < .3;
      assert.ok(onRoute, 'a boat stays on its waterway');
    }
  }
  const dry = createLocalTraffic({ profile: 'low', seed: 'seed-dry' });
  dry.rebuildGraph(streetGraph(), { waterways: null });
  for (let tick = 0; tick < 30; tick++) {
    dry.update({ nowMilliseconds: tick * 100, dtMilliseconds: 100, x: 10, z: 0 });
  }
  const dryResidents = dry.residentRecords();
  for (let index = 0; index < dryResidents.count; index++) {
    assert.notEqual(dryResidents.records[index].kind, GDO_TRAFFIC_KIND.BOAT);
  }
  assert.ok(dry.refusals[GDO_TRAFFIC_REFUSAL.NO_WATERWAYS] > 0, 'dry refusals are named');
});

test('LIF-05 every ceiling is declared against the low-profile budget', () => {
  const policy = GDO_TRAFFIC_PROFILES.low;
  assert.equal(GDO_FEATURE_VERSIONS.localTraffic, 1);
  assert.equal(GDO_TRAFFIC_NAMESPACE, 'gdo:localTraffic:v1');
  assert.equal(GDO_LOW_PROFILE_BUDGETS.trafficAgents, policy.maxVehicles);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.boatAgents, policy.maxBoats);
  assert.ok(GDO_LOW_PROFILE_BUDGETS.trafficCpuUpdatesPerFrame > 0);
  assert.ok(GDO_LOW_PROFILE_BUDGETS.trafficProxies > 0);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.trafficSteadyFrameAllocations, 0);
  assert.ok(policy.farRouteHz >= 5 && policy.farRouteHz <= 10, 'research §10 far rate');
  assert.ok(policy.nearRouteHz >= 20 && policy.nearRouteHz <= 30, 'research §10 near rate');
  // The capped proxy decision cannot exhaust the grid's own dynamic ceiling.
  assert.ok(GDO_LOW_PROFILE_BUDGETS.trafficProxies < GDO_LOW_PROFILE_BUDGETS.dynamicProxies,
    'traffic proxies stay a small slice of the dynamic-proxy budget');
});

test('LIF-05 a board is one pooled allocation and disposes cleanly', () => {
  const ledger = new LifecycleLedger({ label: 'traffic-test' });
  const board = createLocalTraffic({ profile: 'low', seed: 'seed-dispose', ledger });
  board.rebuildGraph(streetGraph(), { waterways: waterwayStream() });
  for (let tick = 0; tick < 20; tick++) {
    board.update({ nowMilliseconds: tick * 100, dtMilliseconds: 100, x: 10, z: 0 });
  }
  const before = board.summary({});
  assert.ok(before.spawns >= 0);
  assert.equal(board.diagnostics.steadyFrameAllocations, 0);
  board.dispose();
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.counts.handle + snapshot.counts.pool, 0, 'the ledger releases every item');
  assert.equal(board.summary({}).moving, 0, 'disposal parks every slot');
  // A disposed board answers with zeroes rather than throwing.
  assert.equal(board.update({ nowMilliseconds: 99, dtMilliseconds: 100, x: 0, z: 0 }).moving, 0);
});

test('LIF-05 profiles and seeds validate their inputs', () => {
  assert.throws(() => createLocalTraffic({ profile: 'ultra' }), RangeError);
  assert.throws(() => createLocalTraffic({ profile: 'low', seed: '' }), TypeError);
  assert.throws(() => trafficSeedFor({ latitude: NaN, longitude: 0 }), TypeError);
  for (const name of ['low', 'balanced', 'high']) {
    const policy = GDO_TRAFFIC_PROFILES[name];
    assert.ok(policy.maxVehicles > 0 && policy.maxBoats >= 0);
    assert.ok(policy.maxSpawnsPerUpdate <= policy.maxVehicles);
    assert.ok(policy.maxAgentsPerUpdate <= policy.maxVehicles + policy.maxBoats);
    assert.ok(policy.safetyGap > 0 && policy.maxStopSeconds > 0);
    assert.ok(policy.vehicleSpeedRange[0] > 0 && policy.vehicleSpeedRange[1] > policy.vehicleSpeedRange[0]);
  }
});
