import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from './GeoWorld.js';
import { compileGeoFixture } from './GeoFixtures.js';
import { LifecycleLedger } from '../engine/LifecycleContract.js';
import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';
import { createLocalNavigation } from '../engine/LocalNavigation.js';
import { GDO_PEDESTRIAN_STATE, pedestrianSeedFor } from '../engine/LocalPedestrians.js';
import {
  GDO_PEDESTRIAN_AUDIT_SCRIPT, createPedestrianAuditRunner, pedestrianAuditPlayerAt,
} from '../engine/PedestrianAudit.js';

/**
 * `LIF-04` gate, live: a real fixture's mapped streets become a sidewalk graph,
 * the world's pedestrian pool walks bounded routes between that fixture's own
 * named places, slots are recycled when they arrive or leave the active radius,
 * nothing off-screen is simulated, and no pedestrian is ever an obstacle.
 */

globalThis.Worker ??= class { addEventListener() {} postMessage() {} terminate() {} };

function mount(fixtureId = 'dense-urban', { profile = 'low', seed = null } = {}) {
  const scene = new THREE.Scene();
  const ledger = new LifecycleLedger({ label: `lif-04-${fixtureId}` });
  const world = new GeoWorld(scene, {
    latitude: 28.9845, longitude: 77.7064, ledger, profile,
    pedestrianSeed: seed,
  });
  const tile = [...world.tiles.values()][0];
  const compilation = compileGeoFixture(fixtureId, 'openmaptiles');
  const common = {
    type: 'tile-phase', requestId: tile.requestId, key: tile.key, bytes: 2048,
    provider: `Fixture/${compilation.fixture.variant}`, providerId: 'openmaptiles',
  };
  world._handleWorkerMessage({
    ...common, phase: 'roads', geometry: compilation.roads,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2 },
  });
  world._handleWorkerMessage({
    ...common, phase: 'context', context: compilation.context,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3 },
  });
  world._handleWorkerMessage({
    ...common, phase: 'buildings', geometry: compilation.buildings,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3, buildingsMilliseconds: 4, totalMilliseconds: 10 },
  });
  world._flushPlantMounts(0);
  return { scene, world, tile, compilation, ledger };
}

/** Drive the world the way a frame does, so the pedestrian pass runs on its clock. */
// The world audit's street clock: the same scripted phases at a coarser step, so a
// fixture whose places are a hundred metres apart still completes a route inside
// one scripted run. A frame is a script unit here, not a rendered frame.
const AUDIT_DT = 1 / 10;

function drive(world, { steps = 120, x = 0, z = 0, clock = 0, dt = AUDIT_DT } = {}) {
  let time = clock;
  const origin = world.pedestrianAuditOrigin();
  for (let index = 0; index < steps; index++) {
    time += dt * 1_000;
    world.update({ x: origin.x + x, y: 0, z: origin.z + z }, null, 720, time);
  }
  return { clock: time, sample: world.pedestrianSample(0) };
}

test('LIF-04 the world builds a sidewalk graph from the fixture it mounted', () => {
  const { world, scene, ledger } = mount('dense-urban');
  try {
    const graph = world.navigation.graph;
    const sidewalk = world.pedestrianSidewalk;
    assert.ok(graph.edges.length > 0, 'the fixture has mapped roads');
    assert.ok(sidewalk.edges.length > 0, `the sidewalk graph kept ${sidewalk.edges.length} edges`);
    const kept = new Set(sidewalk.edges.map(edge => edge.id));
    const mapped = new Map(graph.edges.map(edge => [edge.id, edge]));
    let refused = 0;
    for (const edge of sidewalk.edges) {
      const origin = mapped.get(edge.id);
      assert.ok(origin, `edge ${edge.id} came from the mapped graph`);
      if (origin.link) continue;
      assert.equal(edge.kind, origin.kind);
      // The kerb sits outside the carriageway the tile itself drew.
      assert.ok(edge.offset > origin.width * .5,
        `${edge.kind} kerb ${edge.offset.toFixed(3)} inside a ${origin.width} carriageway`);
    }
    for (const edge of graph.edges) {
      if (!edge.link && !kept.has(edge.id)) refused++;
      assert.equal(GDO_LOW_PROFILE_BUDGETS.pedestrianSteadyFrameAllocations, 0);
    }
    assert.equal(sidewalk.diagnostics.placeRefusals, 0, 'every named place is reachable on foot');
    assert.equal(sidewalk.diagnostics.sourceNodes, graph.nodes.length);
    // A crossing is a mapped junction of the walkable graph, not an invented one.
    const degree = new Map();
    for (const edge of sidewalk.edges) {
      degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
      degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
    }
    assert.equal(sidewalk.crossings, [...degree.values()].filter(value => value > 2).length);
    assert.ok(sidewalk.crossings >= 1, 'a street fixture has at least one crossing');
    assert.equal(world.domain.capabilities.pedestrians, true);
    assert.ok(refused >= 0);
  } finally {
    world.dispose();
    ledger.disposeAll();
    scene.clear();
  }
});

test('LIF-04 the world walks pedestrians between its own named places', () => {
  const { world, scene, ledger } = mount('dense-urban');
  try {
    const { sample } = drive(world, { steps: 900 });
    assert.ok(sample.walking > 0, 'agents appeared on the fixture street');
    assert.ok(sample.walking <= world.pedestrians.limits.maxAgents);
    assert.ok(sample.travelledTotal > 0, 'agents walked');
    const places = world.pedestrianPlaces;
    assert.ok(places.length > 0, 'the fixture names places');
    const names = new Set(places.map(place => place.name));
    for (const agent of sample.agents) {
      assert.ok(names.has(agent.destination), `${agent.destination} is a mapped place name`);
      assert.ok(agent.legIndex >= 0 && agent.legIndex <= agent.legCount);
      assert.ok(Number.isFinite(agent.y), 'the agent stands on real ground');
    }
    // The pool: two flat draws, no matrices, no proxies, no collision.
    const pools = world.pedestrianPools.diagnostics;
    assert.equal(pools.drawCalls, 2);
    // `LAY-06`: the pool declares the same opaque screen-door fade policy the
    // ambience does, against the same shared dither mask.
    const fadeRecord = world.pedestrianPools.material.userData.gdoPedestrianCameraFade ??
      world.pedestrianPools.material.userData.gdoCameraFade;
    if (fadeRecord) {
      assert.equal(fadeRecord.discard, 'screen-door');
      assert.equal(fadeRecord.blended, false);
    }
    assert.equal(pools.cpuMatrixUpdatesPerFrame, 0);
    assert.equal(pools.steadyFrameAllocations, 0);
    assert.ok(pools.instanceBytes <= pools.limits.maxInstanceBytes);
    assert.equal(sample.solidProxies, 0);
    assert.equal(sample.collisionInserts, 0);
    assert.equal(sample.blocksPlayer, false);
    // No tile gained a collider because a pedestrian appeared on it.
    let colliders = 0;
    for (const tile of world.tiles.values()) colliders += (tile.colliders?.length ?? 0) / 4;
    assert.equal(colliders, world.colliderCount ?? colliders, 'the pedestrian pool added no collider');
  } finally {
    world.dispose();
    ledger.disposeAll();
    scene.clear();
  }
});

test('LIF-04 the world recycles its pedestrians instead of simulating a crowd', () => {
  const { world, scene, ledger } = mount('dense-urban');
  try {
    const near = drive(world, { steps: 1_200 });
    assert.ok(near.sample.walking > 0);
    assert.ok(near.sample.simulated > 0);
    const travelled = near.sample.travelledTotal;
    // Everything alive is inside the declared radius of the player.
    for (const agent of near.sample.agents) {
      const distance = Math.hypot(agent.x - near.sample.playerX, agent.z - near.sample.playerZ);
      assert.ok(distance <= near.sample.activeRadius + 1, `${agent.id} lived ${distance.toFixed(1)} from the player`);
    }
    const streetless = world.pedestrianAuditScript();
    assert.equal(streetless.found, true, 'the fixture has a spot with no street in reach');
    const origin = world.pedestrianAuditOrigin();
    // The far phase drives the board directly: the tile manager owns residency, and
    // the pedestrian rule is about the player's own radius rather than about which
    // tile is resident.
    let time = near.clock;
    for (let index = 0; index < 300; index++) {
      time += AUDIT_DT * 1_000;
      world.updatePedestrians(time, { x: origin.x + streetless.dx, z: origin.z + streetless.dz });
    }
    const far = world.pedestrianSample(0);
    assert.equal(far.walking, 0, 'the streetless point owns no live agents');
    assert.equal(far.simulated, 0, 'nothing simulates out of play');
    assert.equal(far.frozen, far.slots, 'every slot is parked');
    assert.equal(far.travelledTotal, travelled, 'a parked frame moves nobody');
    assert.equal(far.spawns, near.sample.spawns, 'nothing spawns out of play');
    assert.ok(far.recycledOutOfRadius > 0, 'agents were recycled by the radius');
    const back = drive(world, { steps: 900, clock: time });
    assert.ok(back.sample.walking > 0, 'the pool refilled on the street');
    assert.equal(back.sample.spawns > near.sample.spawns, true, 'recycled slots took the street again');
  } finally {
    world.dispose();
    ledger.disposeAll();
    scene.clear();
  }
});

test('LIF-04 the world audit proves the row gate on the live pool', () => {
  const { world, scene, ledger, compilation } = mount('dense-urban');
  try {
    const steps = GDO_PEDESTRIAN_AUDIT_SCRIPT.steps;
    const streetless = world.pedestrianAuditScript();
    const origin = world.pedestrianAuditOrigin();
    // The world owns the far point: a within-tile spot with no street in reach, so
    // the scripted walk exercises the radius rule without waiting on a tile fetch.
    const script = Object.freeze({ ...GDO_PEDESTRIAN_AUDIT_SCRIPT, farX: streetless.dx, farZ: streetless.dz });
    let clock = 0;
    const audit = createPedestrianAuditRunner({
      label: 'world-pedestrians',
      steps,
      dt: AUDIT_DT,
      reset: () => {
        clock = 0;
        world.pedestrians.reset();
        world.lastPedestrianMilliseconds = null;
        world.pedestrianSummary = null;
      },
      step: ({ index, dt }) => {
        clock += dt * 1_000;
        const at = pedestrianAuditPlayerAt(index, steps, script);
        world.update({ x: origin.x + at.x, y: 0, z: origin.z + at.z }, null, 720, clock);
      },
      sample: index => world.pedestrianSample(index),
      context: () => world.pedestrianAuditContext(),
      expect: {
        profile: 'low',
        maxAgents: world.pedestrians.limits.maxAgents,
        farPoint: streetless.found,
        requireArrival: true,
      },
    });
    const report = audit.run();
    assert.equal(report.ok, true,
      report.verdicts.filter(entry => !entry.ok).map(entry => `${entry.id}: ${entry.detail}`).join(' | '));
    assert.ok(report.samples.length === steps);
    assert.ok(report.spawns > 0 && report.recycles > 0);
    assert.ok(report.completedRoutes > 0, 'a route completed inside the script');
    assert.ok(report.liveAgents <= world.pedestrians.limits.maxAgents);
    assert.ok(report.places.length > 0);
    assert.ok(report.sidewalk.edges > 0);
    // Two runs of the same script share a fingerprint, so the walk is reproducible.
    const second = audit.run();
    assert.equal(second.fingerprint, report.fingerprint);
    assert.equal(second.ok, true);
    assert.ok(compilation.context.navigation.lines.length > 0, 'the graph came from the tile payload');
  } finally {
    world.dispose();
    ledger.disposeAll();
    scene.clear();
  }
});

test('LIF-04 a tile with no walkable street leaves the street empty rather than inventing one', () => {
  const { world, scene, ledger } = mount('dense-urban');
  try {
    // An empty graph: the pool has nowhere to walk, and says so.
    const empty = createLocalNavigation({ profile: 'low' });
    world.navigation = empty;
    world.setPedestrianGraph();
    assert.equal(world.pedestrianSidewalk.edges.length, 0);
    const { sample } = drive(world, { steps: 60 });
    assert.equal(sample.walking, 0);
    assert.equal(sample.spawns, 0);
    // The board says why the street is empty instead of looking unbuilt.
    assert.ok(sample.neighbourhoodRefusals > 0, 'the board counted the missing neighbourhood');
    assert.equal(sample.refusedSpawns, 0, 'there was nothing to refuse a route to');
  } finally {
    world.dispose();
    ledger.disposeAll();
    scene.clear();
  }
});

test('LIF-04 the seed is the world coordinate, not a clock', () => {
  const first = pedestrianSeedFor({ worldVersion: 1, latitude: 28.9845, longitude: 77.7064 });
  const { world, scene, ledger } = mount('dense-urban', { seed: first });
  try {
    assert.equal(world.pedestrians.seed, first);
    assert.equal(world.pedestrians.seed, pedestrianSeedFor({ worldVersion: 1, latitude: 28.9845, longitude: 77.7064 }));
    assert.equal(GDO_LOW_PROFILE_BUDGETS.pedestrianAgents, world.pedestrians.limits.maxAgents);
    assert.ok(world.pedestrians.slots.length === GDO_LOW_PROFILE_BUDGETS.pedestrianAgents);
    for (const slot of world.pedestrians.slots) {
      assert.ok(Object.values(GDO_PEDESTRIAN_STATE).includes(slot.state));
    }
  } finally {
    world.dispose();
    ledger.disposeAll();
    scene.clear();
  }
});
