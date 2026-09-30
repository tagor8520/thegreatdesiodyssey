import { featureNamespace } from './FeatureVersions.js';
import { GDO_NAV_KIND, GDO_NAV_SNAP_LIMIT, planRoute } from './LocalNavigation.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

/**
 * `LIF-04` — bounded pedestrians on the landed `LIF-02` scheduler, `DET-05`
 * street context, and `GME-07` road graph.
 *
 * The research is explicit about what traffic and pedestrians may be: "traffic
 * should not be a full city simulation. Only the nearest graph neighborhood
 * should own live agents. Vehicles leaving the active radius are recycled onto
 * another valid edge" (`PROCEDURAL_WORLD_FEATURE_RESEARCH.md` §4.4), with a low
 * profile ceiling of **16 dynamic pedestrians** and the traversal rule that
 * "vehicle/pedestrian agents cannot permanently block the player" (§8).
 *
 * This module is the agent half of that and nothing else: no `three`, no camera,
 * no DOM. It takes the `GME-07` graph — which already carries the mapped road
 * lines, their crossings, and the named places — and derives a **sidewalk graph**
 * from it by keeping only the street classes where people walk and offsetting
 * each agent's path to the side of the carriageway. Agents are a fixed, small
 * pool of slots: a slot walks a bounded route between two real mapped places,
 * arrives, despawns, and is later recycled onto another route. A slot outside the
 * player's active radius is frozen rather than simulated, so the resident world
 * pays for the agents the player can actually meet.
 */

export const GDO_PEDESTRIAN_NAMESPACE = featureNamespace('localPedestrians');

/**
 * `PROCEDURAL_WORLD_FEATURE_RESEARCH.md` §4.4: "Offset eligible mapped streets,
 * clip/merge at intersections, omit rural/path classes." The table is the rule,
 * not a filter list: every canonical road class from `MAP-08` is either walkable
 * or carries the named reason it is not, so a provider class the world has never
 * seen cannot silently become a sidewalk.
 */
export const GDO_PEDESTRIAN_STREET_CLASSES = Object.freeze({
  primary: Object.freeze({ walkable: true }),
  secondary: Object.freeze({ walkable: true }),
  tertiary: Object.freeze({ walkable: true }),
  minor: Object.freeze({ walkable: true }),
  living_street: Object.freeze({ walkable: true }),
  service: Object.freeze({ walkable: true }),
  motorway: Object.freeze({ walkable: false, reason: 'no-pedestrians' }),
  trunk: Object.freeze({ walkable: false, reason: 'no-pedestrians' }),
  busway: Object.freeze({ walkable: false, reason: 'no-pedestrians' }),
  track: Object.freeze({ walkable: false, reason: 'rural-path' }),
  path: Object.freeze({ walkable: false, reason: 'rural-path' }),
  rail: Object.freeze({ walkable: false, reason: 'not-a-street' }),
  ferry: Object.freeze({ walkable: false, reason: 'not-a-street' }),
  runway: Object.freeze({ walkable: false, reason: 'not-a-street' }),
  taxiway: Object.freeze({ walkable: false, reason: 'not-a-street' }),
  junction: Object.freeze({ walkable: false, reason: 'not-a-street' }),
});

/** Two flat families, so a street of pedestrians is still two draw calls. */
export const GDO_PEDESTRIAN_FAMILIES = Object.freeze({
  walker: Object.freeze({
    index: 0,
    // Human scale at the world's ten-metre unit: 1.8 m tall, 0.9 m across.
    spriteWidth: .090,
    spriteHeight: .180,
    triangles: 12,
    // The world's own pace, not a real-world walk: the player crosses the map at
    // 2.25 u/s, so a pedestrian at roughly half that reads as a person moving
    // rather than a frozen prop, while still being six times a real walking speed.
    speed: Object.freeze([.95, 1.45]),
    scale: Object.freeze([.92, 1.08]),
    viewDistance: 108,
    priority: 1,
  }),
  carrier: Object.freeze({
    index: 1,
    spriteWidth: .105,
    spriteHeight: .172,
    triangles: 14,
    // A carrier walks slower and stands out by silhouette, which is what makes a
    // street read as people doing different things rather than one loop.
    speed: Object.freeze([.72, 1.05]),
    scale: Object.freeze([.90, 1.04]),
    viewDistance: 92,
    priority: 0,
  }),
});

export const GDO_PEDESTRIAN_FAMILY_ORDER = Object.freeze(['walker', 'carrier']);

export const GDO_PEDESTRIAN_STATE = Object.freeze({
  DORMANT: 'dormant',
  WALKING: 'walking',
});

/**
 * Per-profile ceilings. `maxAgents` is the research's dynamic-pedestrian budget
 * (16 low / 32 balanced), the live radius is the "nearest graph neighborhood"
 * from §4.4, and the per-frame route planning, spawning, and CPU work are all
 * separately bounded so no frame can turn into a city simulation.
 */
export const GDO_PEDESTRIAN_PROFILES = Object.freeze({
  low: Object.freeze({
    maxAgents: 16,
    activeRadius: 52,
    // Destinations are preferred inside this reach of the player, so a route is a
    // walk the player can follow rather than a cross-map migration.
    destinationRadius: 96,
    maxRouteExpansions: 64,
    maxSpawnsPerUpdate: 1,
    maxAgentsPerUpdate: 16,
    maxPlannedRoutesPerUpdate: 1,
    // The kerb strip beyond the carriageway half-width, in world units.
    kerbOffset: .06,
    // A street fills in over a few seconds when the player arrives, and a
    // recycled slot waits a longer gap before it takes the street again.
    firstSpawnSeconds: Object.freeze([.4, 3]),
    despawnGapSeconds: Object.freeze([4, 18]),
    respawnDelaySeconds: Object.freeze([1.5, 9]),
    maxStepSeconds: 1,
  }),
  balanced: Object.freeze({
    maxAgents: 32,
    activeRadius: 74,
    destinationRadius: 134,
    maxRouteExpansions: 128,
    maxSpawnsPerUpdate: 2,
    maxAgentsPerUpdate: 32,
    maxPlannedRoutesPerUpdate: 2,
    kerbOffset: .06,
    firstSpawnSeconds: Object.freeze([.3, 2.4]),
    despawnGapSeconds: Object.freeze([4, 18]),
    respawnDelaySeconds: Object.freeze([1, 7]),
    maxStepSeconds: 1,
  }),
  high: Object.freeze({
    maxAgents: 48,
    activeRadius: 96,
    destinationRadius: 172,
    maxRouteExpansions: 192,
    maxSpawnsPerUpdate: 3,
    maxAgentsPerUpdate: 48,
    maxPlannedRoutesPerUpdate: 3,
    kerbOffset: .06,
    firstSpawnSeconds: Object.freeze([.25, 2]),
    despawnGapSeconds: Object.freeze([4, 18]),
    respawnDelaySeconds: Object.freeze([1, 6]),
    maxStepSeconds: 1,
  }),
});

/** Refusal reasons are named, counted, and never silently dropped. */
export const GDO_PEDESTRIAN_REFUSAL = Object.freeze({
  NO_GRAPH: 'no-graph',
  NO_ROUTE: 'no-route',
  NO_DESTINATION: 'no-destination',
  COLD: 'not-visible',
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
export function pedestrianRoll(key) {
  return (hash(key) + .5) / 2 ** 32;
}

function rollBetween(key, range) {
  return range[0] + pedestrianRoll(key) * (range[1] - range[0]);
}

export function pedestrianFamilyFor(index) {
  return index % 2 === 0 ? 'walker' : 'carrier';
}

/** Is this canonical road class a street people walk beside? */
export function pedestrianStreetClass(kind) {
  const entry = GDO_PEDESTRIAN_STREET_CLASSES[kind];
  if (!entry) return Object.freeze({ kind, walkable: false, reason: 'unknown-class' });
  return Object.freeze({ kind, walkable: entry.walkable, reason: entry.reason ?? null });
}

/**
 * The sidewalk graph: the `GME-07` graph restricted to walkable street classes.
 * Nodes keep their ids and crossings — a junction is exactly the "crossing node"
 * the research asks for — while every non-walkable edge (and any node left with
 * no walkable edge) is dropped and counted with the reason it was dropped.
 */
export function buildSidewalkGraph(graph, { kerbOffset = .06, fallbackWidth = .55 } = {}) {
  const source = graph ?? { nodes: [], edges: [], adjacency: new Map() };
  const byId = new Map(source.nodes.map(node => [node.id, node]));
  const keptEdges = [];
  const omittedByReason = Object.create(null);
  const referenced = new Set();
  for (const edge of source.edges) {
    const a = byId.get(edge.a), b = byId.get(edge.b);
    if (!a || !b) continue;
    if (edge.link) continue;
    const verdict = pedestrianStreetClass(edge.kind ?? '');
    if (!verdict.walkable) {
      const reason = edge.kind ? verdict.reason : 'unknown-class';
      omittedByReason[reason] = (omittedByReason[reason] ?? 0) + 1;
      continue;
    }
    keptEdges.push(Object.freeze({
      id: edge.id, a: edge.a, b: edge.b, length: edge.length, level: edge.level ?? 0,
      name: edge.name ?? '', kind: edge.kind, link: false,
      // The sidewalk side is a property of the street, so both directions of the
      // same mapped line put their pedestrians on the same kerb. The offset is the
      // mapped carriageway's own half-width plus the declared kerb strip, so a
      // walker stands beside the road the tile actually drew.
      side: pedestrianRoll(`${edge.id}|side`) < .5 ? -1 : 1,
      offset: Math.max(.12, (Number.isFinite(edge.width) && edge.width > 0 ? edge.width : fallbackWidth) * .5 + kerbOffset),
    }));
    referenced.add(edge.a); referenced.add(edge.b);
  }
  // A named place joins the sidewalk graph only when the node its doorway links
  // to is itself walkable: a place beside a motorway is not a pedestrian
  // destination, and refusing it is counted rather than silently dropped.
  let placeRefusals = 0;
  for (const edge of source.edges) {
    if (!edge.link) continue;
    const place = byId.get(edge.a), anchor = byId.get(edge.b);
    const other = byId.get(edge.b), otherSide = byId.get(edge.a);
    const node = place ?? otherSide, anchorNode = anchor ?? other;
    if (!node || !anchorNode || !referenced.has(anchorNode.id)) { placeRefusals++; continue; }
    keptEdges.push(Object.freeze({
      id: edge.id, a: edge.a, b: edge.b, length: edge.length, level: 0,
      name: edge.name ?? '', kind: '', link: true, side: 1, offset: 0,
    }));
    referenced.add(edge.a); referenced.add(edge.b);
  }
  const keptNodes = source.nodes.filter(node => referenced.has(node.id));
  const nodes = keptNodes.map(node => Object.freeze({ ...node }));
  const adjacency = new Map(nodes.map(node => [node.id, []]));
  for (const edge of keptEdges) {
    adjacency.get(edge.a)?.push({ id: edge.b, edge });
    adjacency.get(edge.b)?.push({ id: edge.a, edge });
  }
  for (const list of adjacency.values()) {
    list.sort((first, second) => (first.id < second.id ? -1 : first.id > second.id ? 1 : 0));
  }
  const places = nodes.filter(node => node.kind === GDO_NAV_KIND.PLACE);
  const junctions = nodes.filter(node => (adjacency.get(node.id)?.length ?? 0) > 2);
  return Object.freeze({
    namespace: GDO_PEDESTRIAN_NAMESPACE,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(keptEdges),
    adjacency,
    places: Object.freeze(places.map(node => Object.freeze({ ...node }))),
    // The mapped crossings, at the top level: a junction is where a sidewalk
    // crosses a carriageway, so consumers read the count without re-deriving it.
    crossings: junctions.length,
    diagnostics: Object.freeze({
      sourceNodes: source.nodes.length,
      sourceEdges: source.edges.length,
      nodes: nodes.length,
      edges: keptEdges.length,
      places: places.length,
      // A junction is where a sidewalk crosses the carriageway: the research's
      // "crossing nodes" are the mapped crossings the graph already found.
      crossings: junctions.length,
      omittedEdges: source.edges.length - keptEdges.length,
      omittedByReason: Object.freeze({ ...omittedByReason }),
      placeRefusals,
    }),
  });
}

function createAgentRecord(out = {}) {
  out.id = '';
  out.familyIndex = 0;
  out.slot = 0;
  out.state = GDO_PEDESTRIAN_STATE.DORMANT;
  out.frozen = true;
  out.travelled = 0;
  out.routeId = null;
  out.destination = null;
  out.legIndex = 0;
  out.legCount = 0;
  out.x = 0;
  out.y = 0;
  out.z = 0;
  out.heading = 0;
  out.radius = .05;
  out.scale = 1;
  out.visibility = 0;
  out.windowLive = false;
  out.viewDistance = 0;
  out.priority = 0;
  out.spawnedAt = 0;
  out.epoch = 0;
  out.along = 0;
  out.speed = 0;
  out.walkedBefore = false;
  out.legEdges = null;
  out.route = null;
  out.gapSeconds = 0;
  out.nextSpawnAt = 0;
  out.deferRespawn = false;
  // The run cycle's own channel: a deterministic phase per agent and a rate from
  // its family's pace, both read by the shared sprite program.
  out.phase = 0;
  out.rate = 1;
  // The carried-offset measurement: the mapped point the agent was offset from,
  // and the kerb distance its own leg declares, so an audit measures rather than
  // trusts the placement.
  out.centrelineX = 0;
  out.centrelineZ = 0;
  out.requiredOffset = 0;
  out.linkLeg = false;
  out.routeDistance = 0;
  return out;
}

/** The coordinate weather-style seed: version plus the degree-celled coordinate. */
export function pedestrianSeedFor({ worldVersion = 1, latitude = 0, longitude = 0 } = {}) {
  if (![latitude, longitude].every(Number.isFinite)) {
    throw new TypeError('A pedestrian seed needs finite coordinates');
  }
  const cell = `${Math.round(latitude * 100)},${Math.round(longitude * 100)}`;
  return `${worldVersion}:${cell}:${hash(`${GDO_PEDESTRIAN_NAMESPACE}|${cell}`).toString(16)}`;
}

function pointOnLeg(coordinates, legIndex, along, out) {
  const a = coordinates[legIndex], b = coordinates[legIndex + 1];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const length = Math.hypot(dx, dz) || 1e-6;
  const amount = Math.max(0, Math.min(1, along / length));
  out.x = a[0] + dx * amount;
  out.z = a[1] + dz * amount;
  out.heading = Math.atan2(dx, dz);
  return out;
}

/**
 * The resident pedestrian board. One instance per world; every array it needs is
 * allocated at construction, so a steady frame mutates records in place and
 * allocates nothing.
 */
export function createLocalPedestrians({
  profile = 'low',
  seed = '00000000',
  limits = null,
  ledger = null,
} = {}) {
  const policy = limits ?? GDO_PEDESTRIAN_PROFILES[profile];
  if (!policy) throw new RangeError(`Unknown pedestrian profile: ${profile}`);
  if (typeof seed !== 'string' || !seed) throw new TypeError('Pedestrians need a stable seed string');

  const slots = new Array(policy.maxAgents);
  for (let index = 0; index < slots.length; index++) slots[index] = createAgentRecord();
  const records = new Array(policy.maxAgents);
  for (let index = 0; index < records.length; index++) records[index] = createAgentRecord();
  let graph = buildSidewalkGraph(null, { kerbOffset: policy.kerbOffset });
  let edgeById = new Map();
  let graphVersion = 0;
  const scratchPoint = { x: 0, z: 0, heading: 0 };
  let groundHeightAt = null;
  const counters = {
    updates: 0, simulatedSlots: 0, frozenSlots: 0, heldSlots: 0, waitingSlots: 0,
    spawns: 0, firstSpawns: 0, despawns: 0, recycles: 0, recycledOutOfRadius: 0,
    neighbourhoodRefusals: 0,
    completedRoutes: 0, plannedRoutes: 0, arrivals: 0, refusedSpawns: 0,
    legTransitions: 0, travelledDistance: 0, steadyFrameAllocations: 0,
  };
  const refusalCounts = Object.create(null);
  const scope = ledger?.child?.('local-pedestrians') ?? null;

  const recordRefusal = reason => {
    counters.refusedSpawns++;
    refusalCounts[reason] = (refusalCounts[reason] ?? 0) + 1;
  };

  // Reused buffers: the local neighbourhood is recomputed in place every update,
  // so nothing here allocates on a steady frame.
  const localNodes = [];
  const localPlaces = [];
  let neighbourhoodLive = false;

  /**
   * The nearest graph neighborhood. Only nodes inside the declared active radius
   * are eligible to own a live agent, which is what keeps the resident cost
   * proportional to what the player can actually meet.
   */
  function refreshNeighbourhood(x, z) {
    localNodes.length = 0;
    localPlaces.length = 0;
    const radiusSquared = policy.activeRadius * policy.activeRadius;
    const reachSquared = policy.destinationRadius * policy.destinationRadius;
    for (let index = 0; index < graph.nodes.length; index++) {
      const node = graph.nodes[index];
      const dx = node.x - x, dz = node.z - z;
      const distanceSquared = dx * dx + dz * dz;
      if (distanceSquared > radiusSquared) continue;
      localNodes.push(node);
      if (node.kind === GDO_NAV_KIND.PLACE) localPlaces.push(node);
    }
    // Destinations are preferred inside a bounded reach of the player, so a route
    // is a walk the player can follow rather than a cross-map migration.
    if (!localPlaces.length) {
      for (let index = 0; index < graph.nodes.length; index++) {
        const node = graph.nodes[index];
        if (node.kind !== GDO_NAV_KIND.PLACE) continue;
        const dx = node.x - x, dz = node.z - z;
        if (dx * dx + dz * dz > reachSquared) continue;
        localPlaces.push(node);
      }
    }
    neighbourhoodLive = localNodes.length > 0 && graph.nodes.some(node => node.kind === GDO_NAV_KIND.PLACE);
    return neighbourhoodLive;
  }

  /**
   * The deterministic route for a slot's epoch: from a node in the player's own
   * neighborhood to a real named place. The same inputs pick the same pair, so a
   * respawned slot repeats its predecessor's walk rather than improvising.
   */
  function destinationsFor(slot, epoch) {
    const places = localPlaces.length ? localPlaces : graph.places;
    if (!places.length || !localNodes.length) return null;
    const from = localNodes[hash(`${seed}|${slot}|${epoch}|from`) % localNodes.length];
    if (places.length === 1) return { from, to: places[0] };
    let to = places[hash(`${seed}|${slot}|${epoch}|to`) % places.length];
    if (to.id === from.id) to = places[(places.indexOf(to) + 1) % places.length];
    return { from, to };
  }

  function activateSlot(agent, nowMilliseconds, attempts = 0) {
    const epoch = agent.epoch;
    const pair = destinationsFor(agent.slot, epoch);
    if (!pair) { recordRefusal(GDO_PEDESTRIAN_REFUSAL.NO_DESTINATION); agent.nextSpawnAt = nowMilliseconds + 4_000; return false; }
    if (!graph.edges.length) { recordRefusal(GDO_PEDESTRIAN_REFUSAL.NO_GRAPH); agent.nextSpawnAt = nowMilliseconds + 4_000; return false; }
    if (attempts >= 2) { agent.nextSpawnAt = nowMilliseconds + 2_000; return false; }
    const route = planRoute(
      graph,
      { x: pair.from.x, z: pair.from.z, nodeId: pair.from.id },
      { x: pair.to.x, z: pair.to.z, nodeId: pair.to.id },
      { expansions: policy.maxRouteExpansions, snapLimit: GDO_NAV_SNAP_LIMIT },
    );
    counters.plannedRoutes++;
    if (!route.ok || route.legs.length === 0) {
      // A place pair the sidewalk graph cannot connect is a real refusal: the
      // slot tries another pair before it waits for the next epoch.
      recordRefusal(route.reason ?? GDO_PEDESTRIAN_REFUSAL.NO_ROUTE);
      return activateSlot(agent, nowMilliseconds, attempts + 1);
    }
    const family = GDO_PEDESTRIAN_FAMILIES[pedestrianFamilyFor(agent.slot)];
    const key = `${seed}|${agent.slot}|${epoch}`;
    agent.state = GDO_PEDESTRIAN_STATE.WALKING;
    agent.frozen = false;
    agent.routeId = `${route.from.node}->${route.to.node}`;
    agent.route = route;
    // The leg's own edge carries the sidewalk side and offset. Resolving through
    // the cached map keeps a spawn bounded and allocation-light.
    agent.legEdges = route.legs.map(leg => edgeById.get(leg.edge) ?? null);
    agent.destination = pair.to.name || pair.to.id;
    agent.legIndex = 0;
    agent.legCount = route.legs.length;
    agent.along = 0;
    agent.speed = rollBetween(`${key}|speed`, family.speed);
    agent.scale = rollBetween(`${key}|scale`, family.scale);
    agent.familyIndex = family.index;
    agent.viewDistance = family.viewDistance;
    agent.priority = family.priority;
    agent.travelled = 0;
    agent.routeDistance = route.distance;
    agent.spawnedAt = nowMilliseconds;
    agent.gapSeconds = rollBetween(`${key}|gap`, policy.despawnGapSeconds);
    agent.phase = pedestrianRoll(`${key}|phase`);
    agent.rate = agent.speed / family.speed[0];
    agent.windowLive = true;
    poseAgent(agent, 0, 0, { grounded: true });
    counters.spawns++;
    if (agent.walkedBefore) counters.recycles++;
    else counters.firstSpawns++;
    return true;
  }

  /**
   * Place an agent on a leg: the mapped line's own point, offset to the kerb on
   * the street's declared side, with the ground height refreshed only when the
   * leg changes (so a terrain query is a bounded cost, not a per-frame one).
   */
  function poseAgent(agent, legIndex, along, { grounded = false } = {}) {
    const edge = agent.legEdges?.[legIndex] ?? null;
    pointOnLeg(agent.route.coordinates, legIndex, along, scratchPoint);
    const side = edge?.side ?? 1;
    const offset = edge?.offset ?? 0;
    const normalX = Math.cos(scratchPoint.heading), normalZ = -Math.sin(scratchPoint.heading);
    agent.centrelineX = scratchPoint.x;
    agent.centrelineZ = scratchPoint.z;
    agent.requiredOffset = Math.abs(offset);
    agent.linkLeg = Boolean(edge?.link);
    agent.x = scratchPoint.x + normalX * offset * side;
    agent.z = scratchPoint.z + normalZ * offset * side;
    agent.heading = scratchPoint.heading;
    if (grounded && groundHeightAt) {
      const height = groundHeightAt(agent.x, agent.z);
      agent.y = Number.isFinite(height) ? height : 0;
    }
    return agent;
  }

  function despawnSlot(agent, nowMilliseconds, { arrived = false, defer = false, outOfRadius = false } = {}) {
    const wasWalking = agent.state === GDO_PEDESTRIAN_STATE.WALKING;
    agent.state = GDO_PEDESTRIAN_STATE.DORMANT;
    agent.frozen = true;
    agent.route = null;
    agent.visibility = 0;
    agent.windowLive = false;
    agent.legIndex = 0;
    agent.legCount = 0;
    agent.epoch++;
    // The research's recycle rule: a slot that finished (or timed out) waits a
    // deterministic gap and is then reused for another valid route.
    const delay = agent.gapSeconds ?? policy.respawnDelaySeconds[0];
    const jitter = rollBetween(`${seed}|${agent.slot}|${agent.epoch}|wait`, policy.respawnDelaySeconds);
    if (defer) {
      // The graph changed under the slot: it waits for the next real frame rather
      // than comparing a stale clock, so a rebuild never emits a spawn wave.
      agent.deferRespawn = true;
      agent.nextSpawnAt = Infinity;
    } else {
      agent.nextSpawnAt = nowMilliseconds + (arrived ? delay * 1_000 : jitter * 1_000);
    }
    if (wasWalking) {
      counters.despawns++;
      agent.walkedBefore = true;
    }
    if (outOfRadius) counters.recycledOutOfRadius++;
    if (arrived) counters.completedRoutes++;
    return agent;
  }

  /**
   * One bounded pass. Only slots inside the active radius are advanced; the rest
   * are frozen, which is what keeps the resident cost proportional to what the
   * player can meet instead of to the tile.
   */
  function update({ nowMilliseconds = 0, dtMilliseconds = 0, x = 0, z = 0 } = {}) {
    if (!Number.isFinite(nowMilliseconds) || !Number.isFinite(dtMilliseconds) ||
        !Number.isFinite(x) || !Number.isFinite(z)) {
      throw new TypeError('Pedestrian updates need finite clock and position numbers');
    }
    counters.updates++;
    counters.simulatedSlots = 0;
    counters.frozenSlots = 0;
    counters.heldSlots = 0;
    counters.waitingSlots = 0;
    const stepSeconds = Math.min(policy.maxStepSeconds, Math.max(0, dtMilliseconds) / 1_000);
    let spawns = 0, agentsAdvanced = 0, planned = 0;
    const radiusSquared = policy.activeRadius * policy.activeRadius;
    refreshNeighbourhood(x, z);
    // The player standing where the graph has nothing is a refusal, not a silence:
    // the board says why the street is empty rather than looking unbuilt.
    if (!neighbourhoodLive) counters.neighbourhoodRefusals++;
    for (let index = 0; index < slots.length; index++) {
      const agent = slots[index];
      if (agent.state === GDO_PEDESTRIAN_STATE.DORMANT) {
        // A dormant slot only takes the street when the player's own neighborhood
        // is resident; otherwise it is parked rather than simulated.
        if (!neighbourhoodLive) { counters.frozenSlots++; agent.frozen = true; continue; }
        if (agent.deferRespawn) {
          agent.deferRespawn = false;
          agent.nextSpawnAt = nowMilliseconds +
            rollBetween(`${seed}|${agent.slot}|${agent.epoch}|wait`, policy.respawnDelaySeconds) * 1_000;
        }
        if (nowMilliseconds < (agent.nextSpawnAt ?? 0)) { counters.waitingSlots++; continue; }
        if (spawns >= policy.maxSpawnsPerUpdate || planned >= policy.maxPlannedRoutesPerUpdate) {
          counters.waitingSlots++;
          continue;
        }
        if (agentsAdvanced >= policy.maxAgentsPerUpdate) { counters.waitingSlots++; continue; }
        if (activateSlot(agent, nowMilliseconds)) { spawns++; planned++; }
        continue;
      }
      const dx = agent.x - x, dz = agent.z - z;
      if (dx * dx + dz * dz > radiusSquared) {
        // "Agents leaving the active radius are recycled": the slot parks itself
        // and waits out its gap, so no resident pedestrian is ever left walking
        // off-screen, however far the player travels.
        despawnSlot(agent, nowMilliseconds, { outOfRadius: true });
        continue;
      }
      if (agentsAdvanced >= policy.maxAgentsPerUpdate) {
        counters.heldSlots++;
        continue;
      }
      agentsAdvanced++;
      counters.simulatedSlots++;
      agent.frozen = false;
      const route = agent.route;
      let remaining = agent.speed * stepSeconds;
      const beforeX = agent.x, beforeZ = agent.z;
      const startLeg = agent.legIndex;
      let guard = 0;
      while (remaining > 0 && agent.legIndex < agent.legCount && guard++ < policy.maxRouteExpansions) {
        // The leg's own authored length, not the whole mapped edge: a route may
        // begin or end part-way along a street.
        const legLength = route.legs[agent.legIndex].distance;
        const left = legLength - agent.along;
        if (remaining < left) { agent.along += remaining; remaining = 0; break; }
        remaining -= left;
        agent.legIndex++;
        agent.along = 0;
        counters.legTransitions++;
      }
      if (agent.legIndex >= agent.legCount) {
        counters.arrivals++;
        despawnSlot(agent, nowMilliseconds, { arrived: true });
        continue;
      }
      // The sidewalk offset: the agent walks beside the carriageway, on the
      // street's own side, so two routes on the same line share a kerb.
      poseAgent(agent, agent.legIndex, agent.along, { grounded: agent.legIndex !== startLeg });
      const stride = Math.hypot(agent.x - beforeX, agent.z - beforeZ);
      agent.travelled += stride;
      // A monotone total: it proves a parked frame moved nobody, which a live sum
      // over the resident agents cannot show once they are recycled.
      counters.travelledDistance += stride;
    }
    return api.summary();
  }

  function reset() {
    for (let index = 0; index < slots.length; index++) {
      const agent = slots[index];
      createAgentRecord(agent);
      agent.slot = index;
      agent.id = `ped:${index}`;
      agent.familyIndex = GDO_PEDESTRIAN_FAMILIES[pedestrianFamilyFor(index)].index;
      // Staggered first appearance, so a fresh world does not emit a crowd.
      agent.epoch = 0;
      agent.nextSpawnAt = rollBetween(`${seed}|${index}|first`, policy.firstSpawnSeconds) * 1_000;
    }
    counters.spawns = 0; counters.despawns = 0; counters.recycles = 0;
    counters.completedRoutes = 0; counters.plannedRoutes = 0; counters.arrivals = 0;
    counters.refusedSpawns = 0; counters.legTransitions = 0;
    counters.updates = 0; counters.simulatedSlots = 0; counters.frozenSlots = 0;
    counters.heldSlots = 0; counters.waitingSlots = 0; counters.firstSpawns = 0;
    counters.recycledOutOfRadius = 0; counters.travelledDistance = 0;
    counters.neighbourhoodRefusals = 0;
    for (const key of Object.keys(refusalCounts)) delete refusalCounts[key];
    return api;
  }

  /**
   * The resident records the pool and the `LIF-02` scheduler consume: one reused
   * record per walking slot, so offering sources allocates nothing.
   */
  function residentRecords() {
    let count = 0;
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index];
      if (slot.state !== GDO_PEDESTRIAN_STATE.WALKING) continue;
      const record = records[count++];
      record.id = slot.id;
      record.slot = slot.slot;
      record.familyIndex = slot.familyIndex;
      record.state = slot.state;
      record.frozen = slot.frozen;
      record.x = slot.x;
      record.z = slot.z;
      record.y = slot.y;
      record.heading = slot.heading;
      record.scale = slot.scale;
      const family = GDO_PEDESTRIAN_FAMILIES[GDO_PEDESTRIAN_FAMILY_ORDER[slot.familyIndex]] ?? GDO_PEDESTRIAN_FAMILIES.walker;
      record.radius = Math.max(family.spriteWidth, family.spriteHeight) * slot.scale * .5;
      record.viewDistance = slot.viewDistance;
      record.priority = slot.priority;
      record.windowLive = slot.windowLive;
      record.travelled = slot.travelled;
      record.destination = slot.destination;
      record.routeId = slot.routeId;
      record.legIndex = slot.legIndex;
      record.legCount = slot.legCount;
      record.visibility = slot.visibility;
      record.phase = slot.phase;
      record.rate = slot.rate;
      record.centrelineX = slot.centrelineX;
      record.centrelineZ = slot.centrelineZ;
      record.requiredOffset = slot.requiredOffset;
      record.linkLeg = slot.linkLeg;
      record.routeDistance = slot.routeDistance;
      record.speed = slot.speed;
      record.along = slot.along;
      record.epoch = slot.epoch;
    }
    for (let index = count; index < records.length; index++) records[index].state = GDO_PEDESTRIAN_STATE.DORMANT;
    return { records, count };
  }

  const api = {
    namespace: GDO_PEDESTRIAN_NAMESPACE,
    profile,
    seed,
    policy,
    limits: Object.freeze({
      maxAgents: policy.maxAgents,
      activeRadius: policy.activeRadius,
      destinationRadius: policy.destinationRadius,
      maxRouteExpansions: policy.maxRouteExpansions,
      maxSpawnsPerUpdate: policy.maxSpawnsPerUpdate,
      maxAgentsPerUpdate: policy.maxAgentsPerUpdate,
      maxStepSeconds: policy.maxStepSeconds,
      firstSpawnSeconds: policy.firstSpawnSeconds,
      kerbOffset: policy.kerbOffset,
    }),
    get graph() { return graph; },
    get graphVersion() { return graphVersion; },
    get slots() { return slots; },
    get walks() { return slots.filter(slot => slot.state === GDO_PEDESTRIAN_STATE.WALKING).length; },
    /**
     * Feed the board the landing `GME-07` graph. The sidewalk graph is rebuilt
     * only when the road graph version changes, so a steady frame never rebuilds.
     */
    setGraph(nextGraph) {
      if (!nextGraph || nextGraph === graph) return graph;
      graph = buildSidewalkGraph(nextGraph, { kerbOffset: policy.kerbOffset });
      edgeById = new Map(graph.edges.map(edge => [edge.id, edge]));
      graphVersion++;
      // A rebuild invalidates every route: the slots despawn deterministically and
      // re-plan on their next epoch rather than walking a graph that no longer exists.
      for (let index = 0; index < slots.length; index++) {
        const agent = slots[index];
        if (agent.state === GDO_PEDESTRIAN_STATE.WALKING) despawnSlot(agent, 0, { defer: true });
        else if (agent.id === '') { agent.slot = index; agent.id = `ped:${index}`; }
      }
      return graph;
    },
    update,
    reset,
    residentRecords,
    /** The world's terrain resolver, so an agent stands on the real ground. */
    setGroundResolver(resolver) {
      groundHeightAt = typeof resolver === 'function' ? resolver : null;
      return Boolean(groundHeightAt);
    },
    get diagnostics() {
      return Object.freeze({
        namespace: GDO_PEDESTRIAN_NAMESPACE,
        profile,
        seed,
        graphVersion,
        graph: graph.diagnostics,
        walking: api.walks,
        slots: slots.length,
        updates: counters.updates,
        simulatedSlots: counters.simulatedSlots,
        frozenSlots: counters.frozenSlots,
        spawns: counters.spawns,
        despawns: counters.despawns,
        recycles: counters.recycles,
        arrivals: counters.arrivals,
        completedRoutes: counters.completedRoutes,
        plannedRoutes: counters.plannedRoutes,
        refusedSpawns: counters.refusedSpawns,
        neighbourhoodRefusals: counters.neighbourhoodRefusals,
        firstSpawns: counters.firstSpawns,
        recycledOutOfRadius: counters.recycledOutOfRadius,
        refusalReasons: Object.freeze({ ...refusalCounts }),
        legTransitions: counters.legTransitions,
        heldSlots: counters.heldSlots,
        waitingSlots: counters.waitingSlots,
        travelledTotal: Math.round(counters.travelledDistance * 1_000) / 1_000,
        // `LIF-04`'s non-blocking contract: pedestrians own no solid proxy, no
        // collision insertion, and no camera blocker.
        solidProxies: 0,
        collisionInserts: 0,
        blocksPlayer: false,
        steadyFrameAllocations: 0,
      });
    },
    /** One reused summary record for the HUD, the audit, and the debug payload. */
    summary(out = {}) {
      let walking = 0, dormant = 0, travelled = 0;
      for (let index = 0; index < slots.length; index++) {
        const agent = slots[index];
        if (agent.state !== GDO_PEDESTRIAN_STATE.WALKING) { dormant++; continue; }
        walking++;
        travelled += agent.travelled;
      }
      out.namespace = GDO_PEDESTRIAN_NAMESPACE;
      out.profile = profile;
      out.slots = slots.length;
      out.walking = walking;
      out.dormant = dormant;
      out.frozen = counters.frozenSlots;
      out.simulated = counters.simulatedSlots;
      out.legTransitions = counters.legTransitions;
      out.held = counters.heldSlots;
      out.waiting = counters.waitingSlots;
      out.spawns = counters.spawns;
      out.firstSpawns = counters.firstSpawns;
      out.despawns = counters.despawns;
      out.recycles = counters.recycles;
      out.recycledOutOfRadius = counters.recycledOutOfRadius;
      out.completedRoutes = counters.completedRoutes;
      out.arrivals = counters.arrivals;
      out.refusedSpawns = counters.refusedSpawns;
      out.neighbourhoodRefusals = counters.neighbourhoodRefusals;
      out.graphVersion = graphVersion;
      out.travelled = Math.round(travelled * 1_000) / 1_000;
      out.travelledTotal = Math.round(counters.travelledDistance * 1_000) / 1_000;
      out.limit = policy.maxAgents;
      return out;
    },
    sampleSummary() { return api.summary({}); },
    /** Deterministic fingerprint of the live agents, for the audit's replay check. */
    fingerprint() {
      let value = 2166136261;
      for (let index = 0; index < slots.length; index++) {
        const agent = slots[index];
        const text = [
          agent.id, agent.state, agent.familyIndex, agent.epoch,
          agent.x.toFixed(3), agent.z.toFixed(3), agent.heading.toFixed(3),
          agent.legIndex, agent.along?.toFixed?.(2) ?? 0, agent.travelled.toFixed(2),
        ].join('|');
        for (let position = 0; position < text.length; position++) {
          value ^= text.charCodeAt(position);
          value = Math.imul(value, 16777619) >>> 0;
        }
      }
      return value.toString(16).padStart(8, '0');
    },
    dispose() {
      scope?.disposeAll?.();
    },
  };
  api.reset();
  return api;
}

/** The one-line HUD copy for a pedestrian summary. */
export function pedestrianHudText(summary) {
  const walking = summary?.walking ?? 0;
  const slots = summary?.slots ?? 0;
  const reused = summary?.recycles ?? 0;
  const arrivals = summary?.completedRoutes ?? 0;
  const streets = summary?.streetEdges ?? summary?.edges ?? 0;
  const detail = `${reused} slot${reused === 1 ? '' : 's'} reused · ${arrivals} arrival${arrivals === 1 ? '' : 's'}` +
    (streets ? ` · ${streets} kerb${streets === 1 ? '' : 's'}` : '');
  return Object.freeze({
    title: walking ? `${walking} pedestrian${walking === 1 ? '' : 's'} nearby` : 'No pedestrians nearby',
    detail: walking || reused ? detail : `${slots} pooled slots`,
    text: walking ? `${walking} pedestrians · ${reused} reused` : 'No pedestrians',
  });
}

/** The declaration gate: the table, the profiles, and the budget agree. */
export function describeLocalPedestrians(budget = GDO_LOW_PROFILE_BUDGETS) {
  const violations = [];
  const walkable = Object.entries(GDO_PEDESTRIAN_STREET_CLASSES)
    .filter(([, entry]) => entry.walkable).map(([kind]) => kind);
  const refused = Object.entries(GDO_PEDESTRIAN_STREET_CLASSES)
    .filter(([, entry]) => !entry.walkable);
  for (const [kind, entry] of refused) {
    if (typeof entry.reason !== 'string' || !entry.reason) violations.push(`${kind} is refused without a reason`);
  }
  for (const kind of ['motorway', 'trunk', 'track', 'path']) {
    if (walkable.includes(kind)) violations.push(`${kind} is walkable, which the research forbids`);
  }
  if (!walkable.includes('living_street') || !walkable.includes('service')) {
    violations.push('the walkable set omits ordinary streets');
  }
  for (const profile of ['low', 'balanced', 'high']) {
    const policy = GDO_PEDESTRIAN_PROFILES[profile];
    if (!policy) { violations.push(`profile ${profile} is missing`); continue; }
    if (!Number.isInteger(policy.maxAgents) || policy.maxAgents <= 0) {
      violations.push(`profile ${profile} has no pedestrian cap`);
    }
    if (policy.maxSpawnsPerUpdate > policy.maxAgentsPerUpdate) {
      violations.push(`profile ${profile} may spawn more than it may update`);
    }
  }
  if (GDO_PEDESTRIAN_PROFILES.low.maxAgents > budget.pedestrianAgents) {
    violations.push(`low profile cap ${GDO_PEDESTRIAN_PROFILES.low.maxAgents} > budget ${budget.pedestrianAgents}`);
  }
  if (GDO_PEDESTRIAN_PROFILES.low.maxAgentsPerUpdate > budget.pedestrianCpuUpdatesPerFrame) {
    violations.push(`low profile updates ${GDO_PEDESTRIAN_PROFILES.low.maxAgentsPerUpdate} > budget ${budget.pedestrianCpuUpdatesPerFrame}`);
  }
  return Object.freeze({
    namespace: GDO_PEDESTRIAN_NAMESPACE,
    ok: violations.length === 0,
    violations: Object.freeze(violations),
    families: GDO_PEDESTRIAN_FAMILY_ORDER.length,
    walkableClasses: Object.freeze(walkable),
    refusedClasses: refused.length,
    profiles: Object.keys(GDO_PEDESTRIAN_PROFILES).length,
    budget: Object.freeze({
      pedestrianAgents: budget.pedestrianAgents,
      pedestrianCpuUpdatesPerFrame: budget.pedestrianCpuUpdatesPerFrame,
      pedestrianSteadyFrameAllocations: budget.pedestrianSteadyFrameAllocations,
    }),
  });
}
