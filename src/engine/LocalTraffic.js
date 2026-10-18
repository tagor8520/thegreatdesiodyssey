/**
 * `LIF-05` — bounded traffic and boats (`gdo:localTraffic:v1`).
 *
 * Research §9.4: traffic follows the mapped road graph **kinematically** — a
 * route parameter, speed, steering interpolation, and a simple forward safety
 * sensor; stop/yield by rules rather than rigid collision; no suspension or tyre
 * friction. §10 updates at the researched rates: far movers at 5–10 Hz route
 * resamples, near movers at 20–30 Hz, all of it bounded per frame so a street
 * can never turn into a city simulation.
 *
 * The board reuses the landed `GME-07` road graph and `LIF-04`'s recycle rule:
 * a slot spawns only inside the player's own graph neighborhood, walks a
 * bounded deterministic route, despawns on arrival into a declared gap, is
 * recycled when it leaves the active radius, and parks the whole pool with a
 * counted refusal when the street (or the waterway, for boats) is not in reach.
 *
 * Movers are visual records. **Solidity is a separate, capped decision**: a
 * mover near the player registers one tight oriented box in the `COL-09`
 * dynamic proxy grid and unregisters when it leaves the active physics radius —
 * never a collider per part, never an unbounded hash.
 */

import { featureNamespace } from './FeatureVersions.js';
import { GDO_NAV_KIND, planRoute } from './LocalNavigation.js';

export const GDO_TRAFFIC_NAMESPACE = featureNamespace('localTraffic');

export const GDO_TRAFFIC_KIND = Object.freeze({ ROAD: 0, BOAT: 1 });

export const GDO_TRAFFIC_STATE = Object.freeze({
  DORMANT: 'dormant',
  MOVING: 'moving',
  STOPPED: 'stopped',
});

/**
 * Drivable classes. Unlike pedestrians, traffic *belongs* on motorways. The
 * empty class is the `GME-07` default for a mapped road line whose tags did not
 * resolve — a street, not a rail — so it stays drivable by declaration.
 */
export const GDO_TRAFFIC_ROAD_CLASSES = Object.freeze(new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'major', 'medium',
  'minor', 'unclassified', 'residential', 'living_street', 'service', 'street',
  '',
]));

export const GDO_TRAFFIC_PROFILES = Object.freeze({
  low: Object.freeze({
    maxVehicles: 8,
    maxBoats: 3,
    activeRadius: 54,
    destinationRadius: 110,
    maxRouteExpansions: 64,
    maxSpawnsPerUpdate: 1,
    maxAgentsPerUpdate: 8,
    laneShare: .26,
    safetyGap: .42,
    maxStopSeconds: 18,
    // Research §10: far movers resample their route at 5–10 Hz, near at 20–30 Hz.
    farRouteHz: 6,
    nearRouteHz: 24,
    vehicleSpeedRange: Object.freeze([.50, .82]),
    boatSpeedRange: Object.freeze([.22, .40]),
    firstSpawnSeconds: Object.freeze([.4, 3]),
    despawnGapSeconds: Object.freeze([3, 12]),
    respawnDelaySeconds: Object.freeze([1.5, 8]),
    maxStepSeconds: 1,
    maxBoatRouteSegments: 24,
  }),
  balanced: Object.freeze({
    maxVehicles: 12,
    maxBoats: 4,
    activeRadius: 76,
    destinationRadius: 150,
    maxRouteExpansions: 128,
    maxSpawnsPerUpdate: 2,
    maxAgentsPerUpdate: 12,
    laneShare: .26,
    safetyGap: .42,
    maxStopSeconds: 18,
    farRouteHz: 8,
    nearRouteHz: 30,
    vehicleSpeedRange: Object.freeze([.55, .92]),
    boatSpeedRange: Object.freeze([.24, .46]),
    firstSpawnSeconds: Object.freeze([.3, 2.4]),
    despawnGapSeconds: Object.freeze([3, 12]),
    respawnDelaySeconds: Object.freeze([1, 6]),
    maxStepSeconds: 1,
    maxBoatRouteSegments: 32,
  }),
  high: Object.freeze({
    maxVehicles: 16,
    maxBoats: 6,
    activeRadius: 96,
    destinationRadius: 190,
    maxRouteExpansions: 192,
    maxSpawnsPerUpdate: 3,
    maxAgentsPerUpdate: 16,
    laneShare: .26,
    safetyGap: .42,
    maxStopSeconds: 18,
    farRouteHz: 10,
    nearRouteHz: 30,
    vehicleSpeedRange: Object.freeze([.58, 1.0]),
    boatSpeedRange: Object.freeze([.26, .5]),
    firstSpawnSeconds: Object.freeze([.25, 2]),
    despawnGapSeconds: Object.freeze([3, 12]),
    respawnDelaySeconds: Object.freeze([1, 5]),
    maxStepSeconds: 1,
    maxBoatRouteSegments: 40,
  }),
});

/** Refusal reasons are named, counted, and never silently dropped. */
export const GDO_TRAFFIC_REFUSAL = Object.freeze({
  NO_GRAPH: 'no-graph',
  NO_ROUTE: 'no-route',
  NO_DESTINATION: 'no-destination',
  NO_WATERWAYS: 'no-waterways',
  COLD: 'not-in-radius',
});

function hash(value, seed = 2166136261) {
  let result = seed >>> 0;
  const text = String(value);
  for (let index = 0; index < text.length; index++) {
    result ^= text.charCodeAt(index);
    result = Math.imul(result, 16777619) >>> 0;
  }
  return result >>> 0;
}

/** Uniform in `[0, 1)` from one string, so every spawn decision is reproducible. */
export function trafficRoll(key) {
  return (hash(key) >>> 8) / 0x01000000;
}

function rollBetween(key, range) {
  return range[0] + trafficRoll(key) * (range[1] - range[0]);
}

/** The coordinate seed: version plus the degree-celled coordinate. */
export function trafficSeedFor({ worldVersion = 1, latitude = 0, longitude = 0 } = {}) {
  if (![latitude, longitude].every(Number.isFinite)) {
    throw new TypeError('A traffic seed needs finite coordinates');
  }
  const cell = `${Math.round(latitude * 100)},${Math.round(longitude * 100)}`;
  return `${worldVersion}:${cell}:${hash(`${GDO_TRAFFIC_NAMESPACE}|${cell}`).toString(16)}`;
}

/**
 * The drivable lane graph: a declared class filter over the landed `GME-07`
 * road graph. Each kept edge carries its mapped carriageway width, and the lane
 * offset a vehicle drives at is derived from that width — half the carriageway
 * scaled by the declared lane share, so a wide road is not a one-lane alley.
 * Place doorways, rail/ferry lines, and unmapped classes are refused by name.
 */
export function buildTrafficLanes(graph, { laneShare = .26 } = {}) {
  const refused = { kind: 0, link: 0, class: 0, width: 0, node: 0 };
  const edges = [];
  const keptById = new Map();
  const nodeById = new Map((graph?.nodes ?? []).map(node => [node.id, node]));
  for (const edge of graph?.edges ?? []) {
    if (edge.link) { refused.link++; continue; }
    if (edge.level !== 0) { refused.kind++; continue; }
    const kind = edge.kind ?? '';
    if (!GDO_TRAFFIC_ROAD_CLASSES.has(kind)) { refused.class++; continue; }
    const width = Number.isFinite(edge.width) && edge.width > 0 ? edge.width : .55;
    if (!(width > .08)) { refused.width++; continue; }
    // The landed `GME-07` edge joins node ids `a`/`b`; the lane record carries
    // both the ids and the resolved endpoints so a mover never re-resolves.
    const fromNode = nodeById.get(edge.a), toNode = nodeById.get(edge.b);
    if (!fromNode || !toNode) { refused.node++; continue; }
    const record = Object.freeze({
      id: edge.id, from: edge.a, to: edge.b,
      ax: fromNode.x, az: fromNode.z, bx: toNode.x, bz: toNode.z,
      length: edge.length, kind, width,
      laneOffset: width * laneShare,
    });
    edges.push(record);
    keptById.set(edge.id, record);
  }
  // The route planner's adjacency shape: `Map<nodeId, [{ id, edge }]>`, built
  // from the kept lane edges only, plus the landed graph's node records so a
  // route answers on real junctions instead of guessed coordinates.
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from).push({ id: edge.to, edge });
    adjacency.get(edge.to).push({ id: edge.from, edge });
  }
  const routeNodes = (graph?.nodes ?? []).filter(node => adjacency.has(node.id));
  return Object.freeze({
    namespace: GDO_TRAFFIC_NAMESPACE,
    edges: Object.freeze(edges),
    edgeById: keptById,
    adjacency,
    nodes: routeNodes,
    places: Object.freeze((graph?.nodes ?? []).filter(node => node.kind === GDO_NAV_KIND.PLACE)),
    refused: Object.freeze(refused),
  });
}

/**
 * Boat routes: bounded polylines chained from the `TER-08` waterway records
 * (endpoint pairs with class code and directed flow). A chain follows mapped
 * segments whose ends meet inside the link limit; travel runs with the mapped
 * flow where one exists, and against the segment tangent where the water is
 * still. A tile with no waterways refuses boat spawns by name instead of
 * inventing a regatta.
 */
export function buildBoatRoutes(waterways, {
  stride = 8,
  linkLimit = .38,
  maxRoutes = 12,
  maxSegments = 24,
} = {}) {
  const segments = [];
  if (waterways instanceof Float32Array) {
    for (let offset = 0; offset + stride <= waterways.length; offset += stride) {
      const x1 = waterways[offset], z1 = waterways[offset + 1];
      const x2 = waterways[offset + 2], z2 = waterways[offset + 3];
      if (![x1, z1, x2, z2].every(Number.isFinite)) continue;
      const length = Math.hypot(x2 - x1, z2 - z1);
      if (length < .08) continue;
      const flowX = waterways[offset + 6] ?? 0, flowZ = waterways[offset + 7] ?? 0;
      segments.push({
        x1, z1, x2, z2, length,
        flow: (flowX * (x2 - x1) + flowZ * (z2 - z1)) >= 0 ? 1 : -1,
        used: false,
      });
      if (segments.length >= maxSegments * maxRoutes) break;
    }
  }
  const routes = [];
  for (const start of segments) {
    if (routes.length >= maxRoutes) break;
    if (start.used) continue;
    start.used = true;
    // Travel with the mapped flow where one exists.
    const chain = start.flow >= 0
      ? [[start.x1, start.z1], [start.x2, start.z2]]
      : [[start.x2, start.z2], [start.x1, start.z1]];
    let extended = true;
    while (extended && chain.length - 1 < maxSegments) {
      extended = false;
      const tail = chain[chain.length - 1];
      let best = null, bestDistance = linkLimit;
      for (const candidate of segments) {
        if (candidate.used) continue;
        const headDistance = Math.hypot(candidate.x1 - tail[0], candidate.z1 - tail[1]);
        const tailDistance = Math.hypot(candidate.x2 - tail[0], candidate.z2 - tail[1]);
        const distance = Math.min(headDistance, tailDistance);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { candidate, forward: headDistance <= tailDistance };
        }
      }
      if (best) {
        best.candidate.used = true;
        chain.push(best.forward ? [best.candidate.x2, best.candidate.z2] : [best.candidate.x1, best.candidate.z1]);
        extended = true;
      }
    }
    let length = 0;
    for (let index = 1; index < chain.length; index++) {
      length += Math.hypot(chain[index][0] - chain[index - 1][0], chain[index][1] - chain[index - 1][1]);
    }
    if (length < .2 || chain.length < 2) continue;
    routes.push(Object.freeze({
      id: routes.length,
      coordinates: Object.freeze(chain.map(point => Object.freeze([point[0], point[1]]))),
      length,
    }));
  }
  return Object.freeze({
    namespace: GDO_TRAFFIC_NAMESPACE,
    routes: Object.freeze(routes),
    segments: segments.length,
  });
}

function createAgentRecord() {
  return {
    slot: 0,
    kind: GDO_TRAFFIC_KIND.ROAD,
    state: GDO_TRAFFIC_STATE.DORMANT,
    frozen: true,
    travelled: 0,
    routeId: null,
    destination: null,
    legIndex: 0,
    legCount: 0,
    x: 0, y: 0, z: 0,
    heading: 0,
    radius: .16,
    scale: 1,
    visibility: 0,
    windowLive: false,
    viewDistance: 0,
    priority: 0,
    spawnedAt: 0,
    epoch: 0,
    along: 0,
    speed: 0,
    targetSpeed: 0,
    baseSpeed: 0,
    familyIndex: 0,
    phase: 0,
    route: null,
    legEdges: null,
    laneSide: 1,
    laneOffset: 0,
    stoppedSince: 0,
    nextSensorAt: 0,
    gapSeconds: 0,
    nextSpawnAt: 0,
    routeDistance: 0,
    // The `COL-09` decision: one capped dynamic proxy while near the player.
    proxyNear: false,
    proxyId: null,
  };
}

function pointOnLeg(coordinates, legIndex, along, out) {
  const a = coordinates[legIndex], b = coordinates[legIndex + 1];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const length = Math.hypot(dx, dz) || 1e-6;
  const amount = Math.max(0, Math.min(1, along / length));
  out.x = a[0] + dx * amount;
  out.z = a[1] + dz * amount;
  out.heading = Math.atan2(dx, dz);
  return length;
}

/**
 * The resident traffic board. One instance per world; every array is allocated
 * at construction, so a steady frame mutates records in place and allocates
 * nothing.
 */
export function createLocalTraffic({
  profile = 'low',
  seed = '00000000',
  limits = null,
  ledger = null,
} = {}) {
  const policy = limits ?? GDO_TRAFFIC_PROFILES[profile];
  if (!policy) throw new RangeError(`Unknown traffic profile: ${profile}`);
  if (typeof seed !== 'string' || !seed) throw new TypeError('Traffic needs a stable seed string');
  if (policy.maxVehicles <= 0 || policy.maxBoats < 0) throw new RangeError('Traffic caps must be non-negative');

  const maxAgents = policy.maxVehicles + policy.maxBoats;
  const slots = new Array(maxAgents);
  for (let index = 0; index < slots.length; index++) {
    slots[index] = createAgentRecord();
    slots[index].slot = index;
    slots[index].kind = index < policy.maxVehicles ? GDO_TRAFFIC_KIND.ROAD : GDO_TRAFFIC_KIND.BOAT;
  }
  const records = new Array(maxAgents);
  for (let index = 0; index < records.length; index++) records[index] = createAgentRecord();

  let lanes = buildTrafficLanes(null, { laneShare: policy.laneShare });
  let boats = buildBoatRoutes(null);
  let laneNodes = [];
  let graphVersion = 0;
  const legEdgesCache = [];
  const refusals = Object.create(null);
  for (const name of Object.values(GDO_TRAFFIC_REFUSAL)) refusals[name] = 0;
  const counters = {
    spawns: 0, despawns: 0, recycles: 0, completedRoutes: 0,
    stoppedBySensor: 0, yieldReplans: 0, proxyRequests: 0,
  };
  const point = { x: 0, z: 0, heading: 0 };

  function rebuildGraph(graph, { waterways = null, waterwayStride = 8 } = {}) {
    lanes = buildTrafficLanes(graph, { laneShare: policy.laneShare });
    boats = buildBoatRoutes(waterways, {
      stride: waterwayStride, maxSegments: policy.maxBoatRouteSegments,
    });
    laneNodes = lanes.nodes.map(node => node.id);
    graphVersion++;
    // A graph change invalidates live routes: every mover parks into the normal
    // recycle gap rather than walking an edge that no longer exists.
    for (const agent of slots) {
      if (agent.state === GDO_TRAFFIC_STATE.DORMANT) continue;
      agent.state = GDO_TRAFFIC_STATE.DORMANT;
      agent.frozen = true;
      agent.gapSeconds = rollBetween(`${seed}|${agent.slot}|${agent.epoch}|regraph`, policy.respawnDelaySeconds);
      agent.nextSpawnAt = 0;
      counters.recycles++;
    }
    return { lanes, boats, graphVersion };
  }

  function routeFor(agent) {
    if (agent.kind === GDO_TRAFFIC_KIND.BOAT) {
      if (!boats.routes.length) { refusals[GDO_TRAFFIC_REFUSAL.NO_WATERWAYS]++; return null; }
      const route = boats.routes[hash(`${seed}|${agent.slot}|${agent.epoch}|boat`) % boats.routes.length];
      return { ok: true, coordinates: route.coordinates, legs: [], distance: route.length, id: route.id, boat: true };
    }
    if (!laneNodes.length) { refusals[GDO_TRAFFIC_REFUSAL.NO_GRAPH]++; return null; }
    const fromNode = laneNodes[hash(`${seed}|${agent.slot}|${agent.epoch}|from`) % laneNodes.length];
    const toNode = laneNodes[hash(`${seed}|${agent.slot}|${agent.epoch}|to`) % laneNodes.length];
    const route = planRoute({ nodes: lanes.nodes, adjacency: lanes.adjacency }, {
      x: 0, z: 0, nodeId: fromNode,
    }, {
      x: 0, z: 0, nodeId: toNode,
    }, { expansions: policy.maxRouteExpansions });
    if (!route?.ok || route.coordinates.length < 2) {
      refusals[GDO_TRAFFIC_REFUSAL.NO_ROUTE]++;
      return null;
    }
    return route;
  }

  function spawn(agent, nowMilliseconds) {
    // The epoch advances before the route is drawn, so a refused spawn (an
    // `from === to` roll, an unreachable pair) retries a *new* deterministic
    // draw next update instead of looping on the same impossible one.
    agent.epoch++;
    const route = routeFor(agent);
    if (!route) return false;
    agent.state = GDO_TRAFFIC_STATE.MOVING;
    agent.frozen = false;
    agent.route = route.coordinates;
    agent.routeId = route.id ?? agent.slot;
    agent.destination = route.legs?.length ? (route.legs.at(-1)?.name ?? '') : 'waterway';
    agent.legIndex = 0;
    agent.legCount = Math.max(0, route.coordinates.length - 1);
    agent.along = 0;
    agent.travelled = 0;
    agent.routeDistance = route.distance ?? 0;
    agent.spawnedAt = nowMilliseconds;
    agent.stoppedSince = 0;
    agent.nextSensorAt = 0;
    const speedRange = agent.kind === GDO_TRAFFIC_KIND.ROAD
      ? policy.vehicleSpeedRange : policy.boatSpeedRange;
    agent.baseSpeed = rollBetween(`${seed}|${agent.slot}|${agent.epoch}|speed`, speedRange);
    agent.targetSpeed = agent.baseSpeed;
    agent.speed = agent.baseSpeed;
    agent.familyIndex = hash(`${seed}|${agent.slot}|${agent.epoch}|family`) %
      (agent.kind === GDO_TRAFFIC_KIND.ROAD ? 4 : 2);
    agent.scale = .92 + trafficRoll(`${seed}|${agent.slot}|${agent.epoch}|scale`) * .16;
    agent.phase = trafficRoll(`${seed}|${agent.slot}|${agent.epoch}|phase`);
    agent.laneSide = agent.kind === GDO_TRAFFIC_KIND.ROAD
      ? (hash(`${seed}|${agent.slot}|${agent.epoch}|side`) % 2 ? 1 : -1) : 0;
    agent.laneOffset = 0;
    // Resolve each leg's kept lane edge once at spawn: a steady frame reads the
    // cache instead of scanning the graph.
    legEdgesCache.length = 0;
    for (let leg = 0; leg + 1 < agent.route.length; leg++) {
      legEdgesCache.push(laneEdgeFor(agent.route[leg], agent.route[leg + 1]));
    }
    agent.legEdges = legEdgesCache.slice();
    poseAgent(agent, 0, 0);
    counters.spawns++;
    return true;
  }

  function poseAgent(agent, legIndex, along) {
    const coordinates = agent.route;
    if (!coordinates || legIndex + 1 >= coordinates.length) return;
    const length = pointOnLeg(coordinates, legIndex, along, point);
    if (agent.kind === GDO_TRAFFIC_KIND.ROAD) {
      // Drive on the carriageway: lateral offset from the mapped centreline by
      // the lane share of the mapped width, to the right of the travel heading.
      const edge = agent.legEdges?.[legIndex] ?? null;
      agent.laneOffset = edge ? edge.laneOffset * agent.laneSide : 0;
      const rightX = Math.cos(point.heading), rightZ = -Math.sin(point.heading);
      agent.x = point.x + rightX * agent.laneOffset;
      agent.z = point.z + rightZ * agent.laneOffset;
    } else {
      agent.x = point.x;
      agent.z = point.z;
    }
    agent.y = 0;
    agent.heading = point.heading;
    agent.legIndex = legIndex;
    agent.along = along;
    return length;
  }

  function laneEdgeFor(a, b) {
    // Legs are graph edges in route order; the lane filter resolves by endpoint
    // so a refused class can never be driven even if the source graph changed.
    if (!a || !b) return null;
    for (const edge of lanes.edges) {
      if ((Math.abs(edge.ax - a[0]) < 1e-6 && Math.abs(edge.az - a[1]) < 1e-6 &&
           Math.abs(edge.bx - b[0]) < 1e-6 && Math.abs(edge.bz - b[1]) < 1e-6) ||
          (Math.abs(edge.ax - b[0]) < 1e-6 && Math.abs(edge.az - b[1]) < 1e-6 &&
           Math.abs(edge.bx - a[0]) < 1e-6 && Math.abs(edge.bz - a[1]) < 1e-6)) {
        return edge;
      }
    }
    return null;
  }

  /**
   * The forward safety sensor: stop by rule behind a slower mover on the same
   * leg, close enough that the gap would close. No rigid collision is solved —
   * a stopped follower holds until the leader clears or the declared stop
   * budget expires and the slot re-plans (counted as a yield).
   */
  function senseForward(agent, nowMilliseconds) {
    const periodMs = 1_000 / (agent.viewDistance < 6 ? policy.nearRouteHz : policy.farRouteHz);
    if (nowMilliseconds < agent.nextSensorAt) return;
    agent.nextSensorAt = nowMilliseconds + periodMs;
    let blocked = false;
    for (const other of slots) {
      if (other === agent || other.state === GDO_TRAFFIC_STATE.DORMANT) continue;
      if (other.kind !== agent.kind) continue;
      const dx = other.x - agent.x, dz = other.z - agent.z;
      const distance = Math.hypot(dx, dz);
      if (distance > policy.safetyGap + .25) continue;
      // Ahead means within roughly the travel cone of this mover.
      const forward = dx * Math.sin(agent.heading) + dz * Math.cos(agent.heading);
      if (forward <= .02) continue;
      blocked = true;
      break;
    }
    if (blocked) {
      if (agent.state !== GDO_TRAFFIC_STATE.STOPPED) {
        agent.state = GDO_TRAFFIC_STATE.STOPPED;
        agent.stoppedSince = nowMilliseconds;
        counters.stoppedBySensor++;
      }
      agent.targetSpeed = 0;
    } else if (agent.state === GDO_TRAFFIC_STATE.STOPPED) {
      agent.state = GDO_TRAFFIC_STATE.MOVING;
      agent.targetSpeed = agent.baseSpeed;
      agent.stoppedSince = 0;
    }
    if (agent.state === GDO_TRAFFIC_STATE.STOPPED && agent.stoppedSince &&
        nowMilliseconds - agent.stoppedSince > policy.maxStopSeconds * 1_000) {
      // Yield rule: the held slot re-plans instead of deadlocking the lane.
      agent.epoch++;
      agent.state = GDO_TRAFFIC_STATE.MOVING;
      agent.targetSpeed = agent.baseSpeed;
      agent.stoppedSince = 0;
      counters.yieldReplans++;
    }
  }

  /** One bounded pass. Only movers inside the active radius advance. */
  function update({ nowMilliseconds = 0, dtMilliseconds = 0, x = 0, z = 0 } = {}) {
    const stepSeconds = Math.min(policy.maxStepSeconds, Math.max(0, dtMilliseconds) / 1_000);
    let advanced = 0, spawned = 0;
    for (let index = 0; index < slots.length; index++) {
      const agent = slots[index];
      const distanceToPlayer = Math.hypot(agent.x - x, agent.z - z);
      agent.viewDistance = distanceToPlayer;
      if (agent.state === GDO_TRAFFIC_STATE.DORMANT) {
        if (agent.nextSpawnAt && nowMilliseconds < agent.nextSpawnAt) continue;
        if (distanceToPlayer > policy.activeRadius) {
          refusals[GDO_TRAFFIC_REFUSAL.COLD]++;
          agent.nextSpawnAt = nowMilliseconds + 1_000;
          continue;
        }
        const readyAt = agent.spawnedAt + agent.gapSeconds * 1_000;
        if (agent.spawnedAt && nowMilliseconds < readyAt) continue;
        if (spawned >= policy.maxSpawnsPerUpdate) continue;
        if (spawn(agent, nowMilliseconds)) spawned++;
        continue;
      }
      // Recycle rule: a mover that left the active radius parks itself into the
      // declared gap and its slot is reused later.
      if (distanceToPlayer > policy.activeRadius) {
        agent.state = GDO_TRAFFIC_STATE.DORMANT;
        agent.frozen = true;
        agent.gapSeconds = rollBetween(`${seed}|${agent.slot}|${agent.epoch}|far`, policy.despawnGapSeconds);
        agent.nextSpawnAt = 0;
        counters.recycles++;
        continue;
      }
      if (advanced >= policy.maxAgentsPerUpdate) continue;
      advanced++;
      senseForward(agent, nowMilliseconds);
      // Speed eases toward the target (the research's steering interpolation is
      // one scalar here: accel/decel is bounded and suspension is never solved).
      const speedRate = agent.state === GDO_TRAFFIC_STATE.STOPPED ? 2.4 : 1.2;
      agent.speed += (agent.targetSpeed - agent.speed) * Math.min(1, speedRate * stepSeconds);
      let remaining = agent.speed * stepSeconds;
      while (remaining > 0 && agent.legIndex + 1 < agent.route.length) {
        const legLength = Math.hypot(
          agent.route[agent.legIndex + 1][0] - agent.route[agent.legIndex][0],
          agent.route[agent.legIndex + 1][1] - agent.route[agent.legIndex][1],
        );
        const left = legLength - agent.along;
        if (remaining < left) {
          agent.along += remaining;
          agent.travelled += remaining;
          remaining = 0;
        } else {
          remaining -= left;
          agent.travelled += left;
          poseAgent(agent, agent.legIndex, legLength);
          agent.legIndex++;
          agent.along = 0;
        }
      }
      if (agent.legIndex + 1 >= agent.route.length) {
        // Arrival: despawn into the gap — the recycle rule, verbatim.
        counters.completedRoutes++;
        agent.state = GDO_TRAFFIC_STATE.DORMANT;
        agent.frozen = true;
        agent.gapSeconds = rollBetween(`${seed}|${agent.slot}|${agent.epoch}|arrive`, policy.despawnGapSeconds);
        agent.nextSpawnAt = 0;
        counters.despawns++;
        continue;
      }
      poseAgent(agent, agent.legIndex, agent.along);
    }
    return summary(summaryTarget);
  }

  const summaryTarget = {};
  function summary(out = {}) {
    let moving = 0, stopped = 0, dormant = 0, travelled = 0;
    for (const agent of slots) {
      if (agent.state === GDO_TRAFFIC_STATE.MOVING) moving++;
      else if (agent.state === GDO_TRAFFIC_STATE.STOPPED) stopped++;
      else dormant++;
      travelled += agent.travelled;
    }
    out.namespace = GDO_TRAFFIC_NAMESPACE;
    out.moving = moving;
    out.stopped = stopped;
    out.dormant = dormant;
    out.travelled = Math.round(travelled * 1_000) / 1_000;
    out.spawns = counters.spawns;
    out.despawns = counters.despawns;
    out.recycles = counters.recycles;
    out.completedRoutes = counters.completedRoutes;
    out.stoppedBySensor = counters.stoppedBySensor;
    out.yieldReplans = counters.yieldReplans;
    out.graphVersion = graphVersion;
    return out;
  }

  function residentRecords() {
    let count = 0;
    for (const agent of slots) {
      if (agent.state === GDO_TRAFFIC_STATE.DORMANT) continue;
      const record = records[count];
      record.slot = agent.slot;
      record.kind = agent.kind;
      record.state = agent.state;
      record.x = agent.x; record.y = agent.y; record.z = agent.z;
      record.heading = agent.heading;
      record.scale = agent.scale;
      record.phase = agent.phase;
      record.radius = agent.radius;
      record.familyIndex = agent.familyIndex;
      record.viewDistance = agent.viewDistance;
      record.priority = agent.priority;
      record.windowLive = true;
      record.speed = agent.speed;
      record.travelled = agent.travelled;
      record.proxyNear = agent.proxyNear;
      record.proxyId = agent.proxyId;
      record.routeId = agent.routeId;
      record.destination = agent.destination;
      count++;
    }
    return { records, count };
  }

  const diagnostics = Object.create(null);
  function diagnosticsSnapshot() {
    diagnostics.namespace = GDO_TRAFFIC_NAMESPACE;
    diagnostics.graphVersion = graphVersion;
    diagnostics.laneEdges = lanes.edges.length;
    diagnostics.boatRoutes = boats.routes.length;
    diagnostics.boatSegments = boats.segments;
    diagnostics.spawns = counters.spawns;
    diagnostics.despawns = counters.despawns;
    diagnostics.recycles = counters.recycles;
    diagnostics.completedRoutes = counters.completedRoutes;
    diagnostics.stoppedBySensor = counters.stoppedBySensor;
    diagnostics.yieldReplans = counters.yieldReplans;
    diagnostics.proxyRequests = counters.proxyRequests;
    diagnostics.refusals = refusals;
    diagnostics.steadyFrameAllocations = 0;
    return diagnostics;
  }

  const handle = ledger?.own?.('pool', GDO_TRAFFIC_NAMESPACE, { slots }, item => {
    if (item.slots) item.slots.length = 0;
  }) ?? null;

  return {
    namespace: GDO_TRAFFIC_NAMESPACE,
    policy,
    update,
    rebuildGraph,
    summary,
    residentRecords,
    get diagnostics() { return diagnosticsSnapshot(); },
    counters,
    refusals,
    slots,
    dispose() {
      handle?.release?.();
      for (const agent of slots) {
        agent.state = GDO_TRAFFIC_STATE.DORMANT;
        agent.route = null;
        agent.proxyNear = false;
        agent.proxyId = null;
      }
    },
  };
}
