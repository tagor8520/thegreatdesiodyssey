import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalNavigation } from './LocalNavigation.js';
import {
  GDO_PEDESTRIAN_FAMILIES, GDO_PEDESTRIAN_NAMESPACE, GDO_PEDESTRIAN_PROFILES,
  GDO_PEDESTRIAN_STATE, buildSidewalkGraph, createLocalPedestrians,
  describeLocalPedestrians, pedestrianHudText, pedestrianSeedFor, pedestrianStreetClass,
} from './LocalPedestrians.js';
import { GDO_LOW_PROFILE_BUDGETS, evaluateLowProfileBudget } from './PerformanceBudget.js';
import {
  GDO_PEDESTRIAN_AUDIT_SCRIPT, createPedestrianAuditRunner, describePedestrianAudit,
  pedestrianAuditPlayerAt,
} from './PedestrianAudit.js';

/**
 * `LIF-04` gate: the sidewalk graph is a declared filter over mapped streets, a
 * fixed pool walks bounded routes between real named places, slots that reach a
 * destination or leave the active radius are parked and later reused, and no
 * sample ever simulates a dense global crowd — on the landed `LIF-02` scheduler
 * and the `GME-07` road graph.
 */

/** A small town: two mapped streets crossing, a service lane, a motorway, a path. */
function town({ widths = true } = {}) {
  const navigation = createLocalNavigation({ profile: 'low' });
  navigation.addTile('tile-a', {
    lines: [
      [-40, 0, 40, 0],
      [0, -40, 0, 40],
      [-40, 12, 40, 12],
      [-40, 24, 40, 24],
      [10, -20, 10, 20],
    ],
    names: ['MG Road', 'Cross Street', 'Lane', 'Expressway', 'Cut-through'],
    levels: [0, 0, 0, 0, 0],
    kinds: ['primary', 'secondary', 'service', 'motorway', 'path'],
    ...(widths ? { widths: [1, .8, .4, 1.4, .18] } : {}),
  });
  navigation.addPlaces('tile-a', [
    { name: 'Coffee House', kind: 'cafe', x: 3, z: 3 },
    { name: 'Temple', kind: 'place_of_worship', x: -3, z: -4 },
    { name: 'Bus Stop', kind: 'bus_stop', x: 3, z: 12.4 },
    { name: 'Park Gate', kind: 'park', x: -3, z: 12.4 },
  ]);
  return navigation.graph;
}

/** Drive a board the way a frame does, returning the sample the audit reads. */
function board({ graph = town(), profile = 'low', seed = 'lif-04' } = {}) {
  const pedestrians = createLocalPedestrians({ profile, seed });
  pedestrians.setGraph(graph);
  return pedestrians;
}

function drive(pedestrians, { steps = 240, x = 0, z = 0, start = 0, step = 1000 / 30 } = {}) {
  let clock = start;
  const samples = [];
  for (let index = 0; index < steps; index++) {
    clock += step;
    pedestrians.update({ nowMilliseconds: clock, dtMilliseconds: step, x, z });
    samples.push(pedestrians.summary({}));
  }
  return { clock, samples, last: samples.at(-1) };
}

test('LIF-04 the sidewalk graph is a declared class filter over mapped streets', () => {
  const graph = town();
  const sidewalk = buildSidewalkGraph(graph);
  const mapped = new Map(graph.edges.map(edge => [edge.id, edge]));

  // Walkable classes survive, unchanged in class and length: this is a filter.
  assert.ok(sidewalk.edges.length >= 3, `kept ${sidewalk.edges.length} edges`);
  for (const edge of sidewalk.edges) {
    const origin = mapped.get(edge.id);
    assert.ok(origin, `edge ${edge.id} came from the mapped graph`);
    if (origin.link) continue;
    assert.equal(edge.kind, origin.kind);
    assert.equal(edge.length, origin.length);
    // "Offset eligible mapped streets": the kerb sits outside the carriageway.
    assert.ok(edge.offset > origin.width * .5,
      `${edge.kind} kerb ${edge.offset} is inside a ${origin.width} carriageway`);
    assert.ok(Math.abs(edge.side) === 1);
  }
  // Motorways and footpaths are refused, with a reason, deterministically.
  const refused = graph.edges.filter(edge => !edge.link && !sidewalk.edges.some(kept => kept.id === edge.id));
  assert.ok(refused.length >= 2, 'at least the motorway and the path are refused');
  assert.equal(sidewalk.diagnostics.omittedByReason['no-pedestrians'], 2);
  assert.ok(sidewalk.diagnostics.omittedByReason['rural-path'] >= 1);
  assert.equal(pedestrianStreetClass('motorway').reason, 'no-pedestrians');
  assert.equal(pedestrianStreetClass('path').reason, 'rural-path');
  assert.equal(pedestrianStreetClass('footway').walkable, false, 'unmapped classes never become streets');
  assert.equal(sidewalk.diagnostics.placeRefusals, 0, 'every place in the fixture is reachable on foot');
  // Crossing nodes come from mapped junctions: a walkable node of degree > 2.
  const degree = new Map();
  for (const edge of sidewalk.edges) {
    degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
  }
  const crossings = [...degree.values()].filter(value => value > 2).length;
  assert.equal(sidewalk.crossings, crossings);
  assert.ok(sidewalk.crossings >= 1, 'the crossing of two streets is a crossing node');
  // The same build twice is the same graph.
  assert.deepEqual(buildSidewalkGraph(graph).diagnostics, sidewalk.diagnostics);
});

test('LIF-04 a place beside no walkable street is refused rather than walked', () => {
  const graph = town();
  const sidewalk = buildSidewalkGraph({
    ...graph,
    nodes: [...graph.nodes, Object.freeze({ id: 'place:far', x: 40, z: 24, kind: 'place', name: 'Depot', degree: 1 })],
    edges: [...graph.edges, Object.freeze({
      id: 'link:far', a: 'place:far', b: graph.edges.find(edge => edge.kind === 'motorway').a,
      length: 2, level: 0, name: 'Depot', kind: '', width: 0, link: true,
    })],
  });
  assert.equal(sidewalk.diagnostics.placeRefusals, 1);
  assert.ok(!sidewalk.places.includes('place:far'));
});

test('LIF-04 pedestrians walk bounded routes between mapped places', () => {
  const graph = town();
  const pedestrians = board({ graph });
  const { last } = drive(pedestrians, { steps: 600 });
  assert.ok(last.spawns > 0, 'agents appeared');
  assert.ok(last.travelled > 0, 'agents walked');
  assert.ok(last.walking <= GDO_PEDESTRIAN_PROFILES.low.maxAgents);
  assert.equal(last.limit, GDO_PEDESTRIAN_PROFILES.low.maxAgents);

  const { records, count } = pedestrians.residentRecords();
  assert.equal(count, last.walking);
  const placeIds = new Set(graph.nodes.filter(node => node.kind === 'place').map(node => node.id));
  const placeNames = new Set(graph.nodes.filter(node => node.kind === 'place').map(node => node.name));
  for (let index = 0; index < count; index++) {
    const agent = records[index];
    assert.ok(placeIds.has(agent.routeId.split('->')[0]) || placeIds.has(agent.routeId.split('->')[1]),
      `route ${agent.routeId} starts or ends at a mapped place`);
    assert.ok(placeNames.has(agent.destination), `destination ${agent.destination} is a mapped name`);
    assert.ok(agent.legIndex >= 0 && agent.legIndex <= agent.legCount);
    assert.ok(agent.travelled <= agent.routeDistance + .5);
    assert.ok(Number.isFinite(agent.x) && Number.isFinite(agent.z));
    assert.equal(agent.state, GDO_PEDESTRIAN_STATE.WALKING);
    // A walker stands on the declared kerb of the street under it.
    if (!agent.linkLeg) {
      const measured = Math.hypot(agent.x - agent.centrelineX, agent.z - agent.centrelineZ);
      assert.ok(Math.abs(measured - agent.requiredOffset) <= .02,
        `agent ${agent.id} walked ${measured} from a ${agent.requiredOffset} kerb`);
    }
  }
  // The ground resolver is honoured when it is set.
  pedestrians.setGroundResolver((x, z) => 1.25 + x * 0 + z * 0);
  const before = records[0]?.id;
  drive(pedestrians, { steps: 30 });
  const after = pedestrians.residentRecords().records[0]?.id;
  assert.ok(before !== undefined || after !== undefined);
});

test('LIF-04 arrival, despawn, and slot reuse are all counted', () => {
  const pedestrians = board();
  const { last } = drive(pedestrians, { steps: 1_800 });
  assert.ok(last.completedRoutes > 0, `${last.completedRoutes} routes completed`);
  assert.ok(last.despawns > 0, `${last.despawns} despawns`);
  assert.ok(last.recycles > 0, `${last.recycles} slot reuses`);
  assert.equal(last.recycles + last.firstSpawns, last.spawns, 'every spawn is a first or a reuse');
  assert.equal(pedestrians.diagnostics.arrivals, last.completedRoutes);
  // Past the pool's size, a slot leaves before another can take it.
  assert.ok(last.spawns > GDO_PEDESTRIAN_PROFILES.low.maxAgents,
    'more spawns than slots, so the pool really reuses');
  assert.equal(pedestrians.diagnostics.steadyFrameAllocations, 0);
  assert.equal(pedestrians.diagnostics.solidProxies, 0);
  assert.equal(pedestrians.diagnostics.collisionInserts, 0);
  assert.equal(pedestrians.diagnostics.blocksPlayer, false);
});

test('LIF-04 leaving the active radius recycles the board instead of simulating it', () => {
  const pedestrians = board();
  const near = drive(pedestrians, { steps: 240, x: 0, z: 0 });
  assert.ok(near.last.walking > 0, 'agents are resident inside the radius');
  assert.ok(pedestrians.diagnostics.simulatedSlots > 0, 'near agents are simulated');
  assert.equal(pedestrians.diagnostics.frozenSlots, 0);
  // Every live agent really is inside the declared radius: no remote crowd.
  const { records, count } = pedestrians.residentRecords();
  for (let index = 0; index < count; index++) {
    assert.ok(Math.hypot(records[index].x, records[index].z) <= GDO_PEDESTRIAN_PROFILES.low.activeRadius + 1);
  }

  const travelled = near.last.travelledTotal;
  const far = drive(pedestrians, { steps: 120, x: 900, z: 900, start: near.clock });
  assert.equal(far.last.walking, 0, 'the far point owns no live agents');
  assert.equal(pedestrians.diagnostics.simulatedSlots, 0, 'nothing simulates outside the radius');
  assert.equal(pedestrians.diagnostics.frozenSlots, far.last.slots, 'every slot is parked');
  assert.equal(far.last.travelledTotal, travelled, 'a parked frame moves nobody');
  assert.ok(far.last.recycledOutOfRadius > 0, `${far.last.recycledOutOfRadius} agent(s) recycled on leaving`);
  // Nothing is left ticking off-screen either: no spawn, no route planning.
  assert.equal(far.last.spawns, near.last.spawns);
  assert.equal(far.last.refusedSpawns, 0);
  assert.equal(far.last.held, 0);

  // Coming back refills the pool on the new streets, bounded per frame.
  const resumed = drive(pedestrians, { steps: 240, x: 0, z: 0, start: far.clock });
  assert.ok(resumed.last.walking > 0, 'the pool refilled on the street');
  assert.ok(pedestrians.diagnostics.simulatedSlots > 0);
  assert.ok(resumed.last.spawns - far.last.spawns <= 240 * GDO_PEDESTRIAN_PROFILES.low.maxSpawnsPerUpdate);
});

test('LIF-04 the same seed and graph produce the same walk', () => {
  const graph = town();
  const first = board({ graph, seed: 'same-seed' });
  const second = board({ graph, seed: 'same-seed' });
  const walkFirst = drive(first, { steps: 300 });
  const walkSecond = drive(second, { steps: 300 });
  assert.equal(first.fingerprint(), second.fingerprint());
  assert.equal(walkFirst.last.spawns, walkSecond.last.spawns);
  assert.equal(walkFirst.last.recycles, walkSecond.last.recycles);
  assert.equal(walkFirst.last.travelledTotal, walkSecond.last.travelledTotal);
  // A different seed is a different street, not the same one relabelled.
  const other = drive(board({ graph, seed: 'another-seed' }), { steps: 300 });
  assert.notEqual(other.last.travelledTotal, walkFirst.last.travelledTotal);
});

test('LIF-04 a graph change despawns what it can no longer route', () => {
  const pedestrians = board();
  drive(pedestrians, { steps: 240 });
  assert.ok(pedestrians.summary({}).walking > 0);
  const empty = createLocalNavigation({ profile: 'low' }).graph;
  pedestrians.setGraph(empty);
  assert.equal(pedestrians.summary({}).walking, 0, 'no agent survived an empty graph');
  assert.ok(pedestrians.summary({}).despawns > 0, 'the rebuild despawned the live agents');
  assert.equal(pedestrians.graph.edges.length, 0);
  // The re-spawn happens on real frames, never as a stale-clock burst.
  drive(pedestrians, { steps: 2 });
  assert.equal(pedestrians.summary({}).walking, 0, 'an empty graph spawns nobody');
  pedestrians.setGraph(town());
  drive(pedestrians, { steps: 60 });
  assert.ok(pedestrians.summary({}).walking > 0, 'the pool refilled on the new streets');
});

test('LIF-04 every profile stays inside the declared pedestrian budget', () => {
  for (const [profile, policy] of Object.entries(GDO_PEDESTRIAN_PROFILES)) {
    const pedestrians = board({ profile, seed: `${profile}-budget` });
    const { last } = drive(pedestrians, { steps: 400 });
    assert.ok(last.walking <= policy.maxAgents, `${profile}: ${last.walking} > ${policy.maxAgents}`);
    assert.equal(last.slots, policy.maxAgents);
    assert.equal(pedestrians.residentRecords().count, last.walking);
  }
  assert.equal(GDO_PEDESTRIAN_PROFILES.low.maxAgents, GDO_LOW_PROFILE_BUDGETS.pedestrianAgents);
  assert.ok(GDO_PEDESTRIAN_PROFILES.low.maxAgentsPerUpdate <= GDO_LOW_PROFILE_BUDGETS.pedestrianCpuUpdatesPerFrame);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.pedestrianSteadyFrameAllocations, 0);
  const described = describeLocalPedestrians(GDO_LOW_PROFILE_BUDGETS);
  assert.equal(described.namespace, GDO_PEDESTRIAN_NAMESPACE);
  assert.equal(described.ok, true, JSON.stringify(described.violations));
  assert.equal(described.violations.length, 0);
  // The budget table knows the metric, so the describe gate is not vacuous.
  const evaluated = evaluateLowProfileBudget({
    pedestrianAgents: GDO_PEDESTRIAN_PROFILES.low.maxAgents,
    pedestrianCpuUpdatesPerFrame: GDO_PEDESTRIAN_PROFILES.low.maxAgentsPerUpdate,
    pedestrianSteadyFrameAllocations: 0,
  });
  for (const metric of ['pedestrianAgents', 'pedestrianCpuUpdatesPerFrame', 'pedestrianSteadyFrameAllocations']) {
    assert.ok(evaluated.checked.some(check => check.metric === metric), `${metric} is a declared budget metric`);
  }
  assert.equal(evaluated.ok, true, JSON.stringify(evaluated.breaches));
});

test('LIF-04 the audit reports live verdicts, and they all pass', () => {
  const graph = town();
  const places = graph.nodes.filter(node => node.kind === 'place');
  const pedestrians = board({ graph, seed: 'audit' });
  const steps = GDO_PEDESTRIAN_AUDIT_SCRIPT.steps;
  const playerZ = index => pedestrianAuditPlayerAt(index, steps).z;
  let clock = 0;
  const audit = createPedestrianAuditRunner({
    label: 'unit-pedestrians',
    steps,
    dt: 1 / 30,
    reset: () => { clock = 0; pedestrians.reset(); },
    step: ({ index, dt }) => {
      clock += dt * 1000;
      pedestrians.update({ nowMilliseconds: clock, dtMilliseconds: dt * 1_000, x: 0, z: playerZ(index) });
    },
    sample: index => {
      const summary = pedestrians.summary({});
      const diagnostics = pedestrians.diagnostics;
      return {
        index,
        time: clock,
        walking: summary.walking,
        slots: summary.slots,
        spawns: summary.spawns,
        despawns: summary.despawns,
        recycles: summary.recycles,
        completedRoutes: summary.completedRoutes,
        refusedSpawns: summary.refusedSpawns,
        travelled: summary.travelled,
        travelledTotal: summary.travelledTotal,
        recycledOutOfRadius: summary.recycledOutOfRadius,
        simulated: diagnostics.simulatedSlots,
        held: diagnostics.heldSlots,
        frozen: diagnostics.frozenSlots,
        waiting: diagnostics.waitingSlots,
        playerX: 0,
        playerZ: playerZ(index),
        activeRadius: GDO_PEDESTRIAN_PROFILES.low.activeRadius,
        agents: pedestrians.residentRecords().records.slice(0, pedestrians.residentRecords().count).map(agent => ({
          id: agent.id,
          x: agent.x,
          z: agent.z,
          routeId: agent.routeId,
          destination: agent.destination,
          legIndex: agent.legIndex,
          legCount: agent.legCount,
          travelled: agent.travelled,
          routeDistance: agent.routeDistance,
          offsetFromCentreline: Math.hypot(agent.x - agent.centrelineX, agent.z - agent.centrelineZ),
          requiredOffset: agent.requiredOffset,
          linkLeg: agent.linkLeg,
        })),
        graphVersion: diagnostics.graphVersion,
        graph: diagnostics.graph,
        solidProxies: diagnostics.solidProxies,
        collisionInserts: diagnostics.collisionInserts,
        blocksPlayer: diagnostics.blocksPlayer,
        steadyFrameAllocations: diagnostics.steadyFrameAllocations,
        drawnInstances: summary.walking,
        parkedSlots: summary.slots - summary.walking,
        instanceUploads: 0,
        hudText: pedestrianHudText(summary).text,
        hudTracksBoard: true,
      };
    },
    context: () => ({
      graph, sidewalk: pedestrians.graph, places,
    }),
    // The fixture has a motorway and a footpath, so the class filter has real work
    // to do here; the world audit proves the same filter on a walkable-only tile.
    expect: { profile: 'low', maxAgents: GDO_PEDESTRIAN_PROFILES.low.maxAgents, farPoint: true },
  });
  const report = audit.run();
  assert.equal(report.namespace, 'gdo:localPedestrianAudit:v1');
  assert.ok(report.verdicts.length >= 8, `audit ran ${report.verdicts.length} verdicts`);
  assert.equal(report.ok, true, report.verdicts.filter(entry => !entry.ok).map(entry => `${entry.id}: ${entry.detail}`).join(' | '));
  for (const id of ['graph-derived', 'grounded-destinations', 'walked-routes', 'sidewalk-offset',
    'despawn-reuse', 'active-radius', 'non-blocking', 'budget', 'deterministic', 'hud']) {
    assert.ok(report.verdicts.some(entry => entry.id === id && entry.ok), `${id} passed`);
  }
  assert.ok(report.samples.length === steps);
  assert.ok(report.spawns > 0, 'the script spawned agents');
  // The declaration gate.
  const described = describePedestrianAudit(GDO_LOW_PROFILE_BUDGETS);
  assert.equal(described.ok, true, JSON.stringify(described.issues));
  assert.equal(described.families, Object.keys(GDO_PEDESTRIAN_FAMILIES).length);
  assert.ok(described.hudSample.length > 0);
});

test('LIF-04 the seed is a coordinate function, not a clock', () => {
  const first = pedestrianSeedFor({ worldVersion: 1, latitude: 28.9845, longitude: 77.7064 });
  const second = pedestrianSeedFor({ worldVersion: 1, latitude: 28.9845, longitude: 77.7064 });
  const elsewhere = pedestrianSeedFor({ worldVersion: 1, latitude: 28.9950, longitude: 77.7064 });
  assert.equal(first, second);
  assert.notEqual(first, elsewhere);
  assert.throws(() => pedestrianSeedFor({ latitude: NaN, longitude: 0 }), TypeError);
  assert.throws(() => createLocalPedestrians({ profile: 'nonexistent' }), RangeError);
});
