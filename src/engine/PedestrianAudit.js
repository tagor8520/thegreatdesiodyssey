import { featureNamespace } from './FeatureVersions.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import {
  GDO_PEDESTRIAN_FAMILIES,
  GDO_PEDESTRIAN_NAMESPACE,
  GDO_PEDESTRIAN_PROFILES,
  GDO_PEDESTRIAN_STATE,
  buildSidewalkGraph,
  pedestrianHudText,
  pedestrianStreetClass,
} from './LocalPedestrians.js';

/**
 * `LIF-04` — the scripted pedestrian audit.
 *
 * The row's gate is "route graph, despawn/reuse, no dense global simulation" on
 * top of the `LIF-02` scheduler, the `DET-05` street context, and the `GME-07`
 * road graph. Every one of those is a claim about what the resident world does
 * over time, so the proof is a script: drive the board over a real graph, step
 * the clock, and record what the agents did. The verdicts read the live board and
 * the live pool — never a re-simulation of them.
 */

export const GDO_PEDESTRIAN_AUDIT_NAMESPACE = featureNamespace('localPedestrianAudit');

/**
 * The one scripted walk both hosts share: stand in the street, step outside every
 * declared active radius, then come back. The phases are declared here so the
 * world audit and the engine audit drive the same script and a failure can be
 * compared between them.
 */
export const GDO_PEDESTRIAN_AUDIT_SCRIPT = Object.freeze({
  steps: 600,
  dt: 1 / 30,
  repeat: 2,
  farFrom: .62,
  farUntil: .72,
  farX: 0,
  farZ: 320,
});

/**
 * The player's scripted position on step `index`: standing in the street, or
 * parked at the script's far point. A host whose world is a single tile passes
 * its own `farX`/`farZ` inside that tile, so the script never asks the tile
 * manager for a tile the audit cannot wait for.
 */
export function pedestrianAuditPlayerAt(index, steps = GDO_PEDESTRIAN_AUDIT_SCRIPT.steps, script = GDO_PEDESTRIAN_AUDIT_SCRIPT) {
  const from = Math.floor(steps * script.farFrom);
  const until = Math.floor(steps * script.farUntil);
  return index >= from && index < until ? { x: script.farX, z: script.farZ } : { x: 0, z: 0 };
}

const AUDIT_FIELDS = Object.freeze([
  'index', 'time', 'walking', 'slots', 'spawns', 'despawns', 'recycles',
  'completedRoutes', 'refusedSpawns', 'travelled', 'travelledTotal',
  'recycledOutOfRadius', 'simulated', 'held', 'frozen', 'waiting',
  'playerX', 'playerZ', 'activeRadius',
  'agents', 'graphVersion', 'graph', 'solidProxies', 'collisionInserts',
  'blocksPlayer', 'steadyFrameAllocations', 'drawnInstances', 'parkedSlots',
  'instanceUploads', 'hudText', 'hudTracksBoard',
]);

function fingerprint(samples) {
  let hash = 2166136261;
  for (const sample of samples) {
    const text = [
      sample.index, sample.walking, sample.spawns, sample.despawns, sample.recycles,
      sample.completedRoutes, sample.refusedSpawns, sample.travelledTotal,
      sample.recycledOutOfRadius, sample.graphVersion,
      sample.agents.map(agent => `${agent.id}@${agent.x.toFixed(2)},${agent.z.toFixed(2)}`).join(','),
    ].join('|');
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Run the scripted pedestrian audit.
 *
 * `step({ index, dt, pass, steps })` advances one frame of the script;
 * `sample(index, pass)` returns the live record described by `AUDIT_FIELDS`;
 * `context()` optionally returns the world's own graph, sidewalk graph, and place
 * list so the audit can check the derivation against real map context rather than
 * a private world.
 *
 * The default script stands the player in the street, then steps outside every
 * declared radius, then comes back — so spawn, arrival, recycle, and reuse all
 * happen inside one scripted run.
 */
export function runPedestrianAudit({
  step,
  sample,
  reset = null,
  context = null,
  steps = GDO_PEDESTRIAN_AUDIT_SCRIPT.steps,
  repeat = GDO_PEDESTRIAN_AUDIT_SCRIPT.repeat,
  dt = GDO_PEDESTRIAN_AUDIT_SCRIPT.dt,
  expect = null,
  label = 'coordinate-pedestrians',
} = {}) {
  if (typeof step !== 'function' || typeof sample !== 'function') {
    throw new TypeError('runPedestrianAudit needs step(input) and sample(index, pass) functions');
  }
  if (!Number.isFinite(steps) || steps < 8) throw new RangeError('Pedestrian audit needs at least eight steps');
  const runs = [];
  for (let pass = 0; pass < Math.max(1, repeat); pass++) {
    reset?.(pass);
    const records = [];
    for (let index = 0; index < steps; index++) {
      step({ index, dt, pass, steps });
      const record = sample(index, pass) ?? {};
      const missing = AUDIT_FIELDS.filter(field => record[field] === undefined);
      if (missing.length) throw new TypeError(`Pedestrian sample ${index} is missing ${missing.join(', ')}`);
      records.push(Object.freeze({ ...record }));
    }
    runs.push(records);
  }
  const samples = runs[0];
  const last = samples.at(-1);
  const verdict = (id, ok, detail) => Object.freeze({ id, ok: Boolean(ok), detail });
  const verdicts = [];
  const cap = expect?.maxAgents ?? GDO_PEDESTRIAN_PROFILES.low.maxAgents;

  // --- the graph is a filter over real map context --------------------------
  const live = context?.() ?? null;
  const source = live?.graph ?? null;
  const sidewalk = live?.sidewalk ?? null;
  const graphIssues = [];
  if (!source || !sidewalk) {
    graphIssues.push('the world has no live navigation graph to filter');
  } else {
    const sourceEdges = new Map(source.edges.map(edge => [edge.id, edge]));
    const keptIds = new Set(sidewalk.edges.map(edge => edge.id));
    if (!sidewalk.edges.length) graphIssues.push('the sidewalk graph kept no edges');
    for (const edge of sidewalk.edges) {
      const origin = sourceEdges.get(edge.id);
      if (!origin) { graphIssues.push(`edge ${edge.id} is not a mapped edge`); continue; }
      if (origin.link) continue;
      if (origin.length !== edge.length) graphIssues.push(`edge ${edge.id} changed length`);
      if (edge.kind !== origin.kind) graphIssues.push(`edge ${edge.id} changed road class`);
      // "Offset eligible mapped streets": the offset is the mapped carriageway's
      // own half-width plus the declared kerb, so it can never sit inside the road.
      const minimum = (Number.isFinite(origin.width) ? origin.width : .55) * .5;
      if (!(edge.offset >= minimum)) {
        graphIssues.push(`edge ${edge.id} offset ${edge.offset} is inside the carriageway`);
      }
    }
    // The class filter is proven by counting, not by expecting a refusal: every
    // mapped line whose own class is not walkable must be missing, and every
    // walkable one must be present. A tile with no motorway simply has nothing to
    // refuse, and this still holds.
    const mustRefuse = [...sourceEdges.values()]
      .filter(edge => !edge.link && !pedestrianStreetClass(edge.kind ?? '').walkable);
    const refused = [...sourceEdges.values()].filter(edge => !edge.link && !keptIds.has(edge.id));
    for (const edge of refused) {
      const verdictForClass = pedestrianStreetClass(edge.kind ?? '');
      if (verdictForClass.walkable) {
        graphIssues.push(`walkable class ${edge.kind} was dropped without a reason`);
      }
    }
    if (refused.length !== mustRefuse.length) {
      graphIssues.push(`refused ${refused.length} edge(s) where ${mustRefuse.length} are not walkable`);
    }
  }
  verdicts.push(verdict('graph-derived', graphIssues.length === 0,
    graphIssues.length === 0
      ? `${sidewalk.edges.length} sidewalk edge(s) filtered from ${source.edges.length} mapped edge(s)`
      : graphIssues.slice(0, 3).join('; ')));

  // --- every destination is a real named place ------------------------------
  const placeIds = new Set((live?.places ?? []).map(place => place.id));
  const placeNames = new Set((live?.places ?? []).map(place => place.name));
  const groundedIssues = [];
  const seenAgents = new Map();
  for (const entry of samples) {
    for (const agent of entry.agents) {
      if (!agent.routeId) { groundedIssues.push(`${agent.id} walked without a route`); continue; }
      const [from, to] = agent.routeId.split('->');
      if (!placeIds.has(from) && !placeIds.has(to)) {
        groundedIssues.push(`${agent.id} walked ${agent.routeId}, which names no mapped place`);
      }
      if (agent.destination && !placeNames.has(agent.destination)) {
        groundedIssues.push(`${agent.id} aimed at ${agent.destination}, which is not a mapped name`);
      }
      seenAgents.set(agent.id, agent);
    }
  }
  verdicts.push(verdict('grounded-destinations', groundedIssues.length === 0,
    groundedIssues.length === 0
      ? `${seenAgents.size} route(s) between mapped places`
      : groundedIssues.slice(0, 3).join('; ')));

  // --- the agents really walk their routes ----------------------------------
  const walkIssues = [];
  if (last.travelled <= 0) walkIssues.push('no agent moved');
  for (const entry of samples) {
    for (const agent of entry.agents) {
      if (agent.routeDistance > 0 && agent.travelled > agent.routeDistance * 1.05) {
        walkIssues.push(`${agent.id} walked ${agent.travelled} on a ${agent.routeDistance} route`);
      }
      if (agent.legIndex < 0 || agent.legIndex > agent.legCount) walkIssues.push(`${agent.id} left its route`);
    }
  }
  verdicts.push(verdict('walked-routes', walkIssues.length === 0,
    walkIssues.length === 0
      ? `${last.travelled} world units walked across ${samples.length} samples`
      : walkIssues.slice(0, 3).join('; ')));

  // --- agents stand on the kerb, not on the centreline ----------------------
  const kerbIssues = [];
  let offsetSamples = 0;
  for (const entry of samples) {
    for (const agent of entry.agents) {
      if (agent.linkLeg) continue;
      if (!Number.isFinite(agent.offsetFromCentreline) || !Number.isFinite(agent.requiredOffset)) continue;
      offsetSamples++;
      if (agent.offsetFromCentreline + .002 < agent.requiredOffset) {
        kerbIssues.push(`${agent.id} walked ${agent.offsetFromCentreline?.toFixed(3)} from a ${agent.requiredOffset?.toFixed(3)} kerb`);
      }
      if (agent.offsetFromCentreline > agent.requiredOffset + .02) {
        kerbIssues.push(`${agent.id} drifted ${agent.offsetFromCentreline?.toFixed(3)} past its ${agent.requiredOffset?.toFixed(3)} kerb`);
      }
    }
  }
  verdicts.push(verdict('sidewalk-offset', kerbIssues.length === 0 && offsetSamples > 0,
    kerbIssues.length === 0
      ? `${offsetSamples} sample(s) stood on the declared kerb`
      : kerbIssues.slice(0, 3).join('; ')));

  // --- spawn, arrival, despawn, reuse --------------------------------------
  const recycleIssues = [];
  if (last.spawns <= 0) recycleIssues.push('no agent ever appeared');
  if (last.completedRoutes <= 0 && expect?.requireArrival !== false) {
    // A route that never completes is not reuse, it is a treadmill.
    recycleIssues.push('no route was ever completed');
  }
  if (last.despawns <= 0) recycleIssues.push('no agent ever despawned');
  if (last.recycles <= 0) recycleIssues.push('no slot was ever reused');
  if (last.recycledOutOfRadius <= 0 && expect?.farPoint) {
    recycleIssues.push('no agent was ever recycled for leaving the radius');
  }
  if (last.walking > cap) recycleIssues.push(`${last.walking} live agents exceed the ${cap} cap`);
  verdicts.push(verdict('despawn-reuse', recycleIssues.length === 0,
    recycleIssues.length === 0
      ? `${last.spawns} spawn(s), ${last.completedRoutes} arrival(s), ${last.recycles} reuse(s), ` +
        `${last.recycledOutOfRadius} recycled out of radius`
      : recycleIssues.join('; ')));

  // --- no dense global simulation ------------------------------------------
  // The research's rule is stronger than a per-frame count: only the player's own
  // neighborhood owns live agents, so this measures the distance from the player
  // to every living pedestrian on every sample.
  const parked = samples.filter(entry => entry.simulated === 0 && entry.walking === 0);
  const simulated = samples.filter(entry => entry.simulated > 0);
  const densityIssues = [];
  let worstLiveDistance = 0;
  if (!(last.spawns > 0)) densityIssues.push('nothing ever spawned, so the far case was not exercised');
  if (!simulated.length) densityIssues.push('no sample ever simulated an agent');
  if (expect?.farPoint && !parked.length) densityIssues.push('the far point never left the active radius');
  let previousTravelled = samples[0]?.travelledTotal ?? 0;
  for (const entry of samples) {
    if (entry.walking > cap) densityIssues.push(`${entry.walking} live agents over the cap`);
    if (entry.simulated > entry.slots || entry.walking > entry.slots) {
      densityIssues.push('the board counted more agents than it has slots');
    }
    // A parked board is a still board: an out-of-play frame must not advance
    // anybody, so the monotone walk total is the strongest cheap witness.
    if (entry.travelledTotal < previousTravelled) densityIssues.push('the walk total went backwards');
    if (entry.simulated === 0 && entry.walking === 0 && entry.travelledTotal !== previousTravelled) {
      densityIssues.push('an out-of-play frame moved an agent');
    }
    previousTravelled = entry.travelledTotal;
    for (const agent of entry.agents) {
      const distance = Math.hypot(agent.x - entry.playerX, agent.z - entry.playerZ);
      worstLiveDistance = Math.max(worstLiveDistance, distance);
      // One step of slack: an agent is recycled on the frame after it crosses.
      if (distance > entry.activeRadius + 1) {
        densityIssues.push(`${agent.id} lived ${distance.toFixed(1)} from a ${entry.activeRadius} radius`);
      }
    }
  }
  verdicts.push(verdict('active-radius', densityIssues.length === 0,
    densityIssues.length === 0
      ? `every live agent stayed inside the radius (worst ${worstLiveDistance.toFixed(1)}), ` +
        `${parked.length} out-of-play sample(s) parked the whole pool`
      : densityIssues.slice(0, 3).join('; ')));

  // --- agents are not obstacles --------------------------------------------
  const blockingIssues = [];
  for (const entry of samples) {
    if (entry.solidProxies !== 0) blockingIssues.push(`${entry.solidProxies} solid proxies`);
    if (entry.collisionInserts !== 0) blockingIssues.push(`${entry.collisionInserts} collision inserts`);
    if (entry.blocksPlayer !== false) blockingIssues.push('the board claimed it blocks the player');
  }
  verdicts.push(verdict('non-blocking', blockingIssues.length === 0,
    blockingIssues.length === 0
      ? 'every sample reported zero proxies, zero collision inserts, and no blocking'
      : [...new Set(blockingIssues)].slice(0, 3).join('; ')));

  // --- inside the declared budget ------------------------------------------
  const budgetIssues = [];
  const worstWalking = Math.max(...samples.map(entry => entry.walking));
  if (worstWalking > cap) budgetIssues.push(`${worstWalking} live agents > ${cap}`);
  if (expect?.maxSimulatedPerFrame && Math.max(...samples.map(entry => entry.simulated)) > expect.maxSimulatedPerFrame) {
    budgetIssues.push('more agents simulated per frame than declared');
  }
  if (samples.some(entry => entry.steadyFrameAllocations !== 0)) budgetIssues.push('a frame allocated');
  if (samples.some(entry => entry.drawnInstances > cap)) budgetIssues.push('more sprites drawn than the cap');
  if (samples.some(entry => entry.instanceUploads < 0)) budgetIssues.push('impossible upload count');
  budgetIssues.push(...(expect?.budgetIssues ?? []));
  verdicts.push(verdict('budget', budgetIssues.length === 0,
    budgetIssues.length === 0
      ? `worst ${worstWalking} live of ${cap}, ${Math.max(...samples.map(entry => entry.drawnInstances))} sprite(s) drawn`
      : budgetIssues.slice(0, 3).join('; ')));

  // --- it repeats -----------------------------------------------------------
  const second = runs[1] ?? runs[0];
  const reproducible = fingerprint(runs[0]) === fingerprint(second) &&
    JSON.stringify(samples.map(entry => entry.agents.map(agent => [agent.id, agent.x.toFixed(3), agent.z.toFixed(3)]))) ===
    JSON.stringify(second.map(entry => entry.agents.map(agent => [agent.id, agent.x.toFixed(3), agent.z.toFixed(3)])));
  verdicts.push(verdict('deterministic', reproducible,
    reproducible
      ? `two passes share the fingerprint ${fingerprint(samples)}`
      : 'two passes diverged'));

  // --- the HUD reads the board ---------------------------------------------
  const hudBreaches = samples.filter(entry => !entry.hudTracksBoard);
  verdicts.push(verdict('hud', hudBreaches.length === 0,
    hudBreaches.length === 0
      ? `the HUD line matched the board on all ${samples.length} samples`
      : `${hudBreaches.length} sample(s) disagreed with the board`));

  const failed = verdicts.filter(entry => !entry.ok);
  const report = {
    namespace: GDO_PEDESTRIAN_AUDIT_NAMESPACE,
    label,
    steps,
    dt,
    profile: expect?.profile ?? 'low',
    steps_visited: samples.length,
    sampleCount: samples.length,
    places: (live?.places ?? []).map(place => place.name ?? place.id),
    sidewalk: sidewalk ? { nodes: sidewalk.nodes.length, edges: sidewalk.edges.length, crossings: sidewalk.crossings } : null,
    spawns: last.spawns,
    despawns: last.despawns,
    recycles: last.recycles,
    recycledOutOfRadius: last.recycledOutOfRadius,
    completedRoutes: last.completedRoutes,
    refusedSpawns: last.refusedSpawns,
    liveAgents: last.walking,
    travelled: last.travelledTotal,
    fingerprint: fingerprint(samples),
    samples: Object.freeze(samples.map(entry => Object.freeze({
      index: entry.index, time: entry.time, walking: entry.walking, spawns: entry.spawns,
      despawns: entry.despawns, recycles: entry.recycles, travelled: entry.travelledTotal,
      simulated: entry.simulated, held: entry.held, frozen: entry.frozen, waiting: entry.waiting,
    }))),
    verdicts: Object.freeze(verdicts),
    ok: failed.length === 0,
  };
  report.detail = report.ok
    ? `${samples.length} scripted samples, ${report.spawns} spawn(s), ${report.liveAgents} live, ` +
      `${report.travelled} units walked — passed ${verdicts.length} pedestrian verdicts (${report.fingerprint})`
    : `failed: ${failed.map(entry => `${entry.id} (${entry.detail})`).join(' | ')}`;
  return Object.freeze(report);
}

export function createPedestrianAuditRunner(options = {}) {
  let last = null;
  return {
    namespace: GDO_PEDESTRIAN_AUDIT_NAMESPACE,
    run(overrides = {}) {
      last = runPedestrianAudit({ ...options, ...overrides });
      return last;
    },
    get last() { return last; },
    get ok() { return last?.ok ?? null; },
    summary() {
      if (!last) return 'pedestrian audit has not run';
      return `${last.namespace} ${last.ok ? 'pass' : 'fail'} (${last.fingerprint}) · ${last.detail}`;
    },
  };
}

/** Two runs at the same inputs must produce the same fingerprint. */
export function pedestrianAuditDeterministic(first, second) {
  return Boolean(first && second) && first.fingerprint === second.fingerprint &&
    first.spawns === second.spawns && first.recycles === second.recycles && first.ok === second.ok;
}

/** The declaration gate: the walkable table, the caps, and the budget agree. */
export function describePedestrianAudit(budget = GDO_LOW_PROFILE_BUDGETS) {
  const issues = [];
  if (GDO_PEDESTRIAN_PROFILES.low.maxAgents > budget.pedestrianAgents) {
    issues.push('the low profile exceeds the pedestrian budget');
  }
  if (GDO_PEDESTRIAN_PROFILES.low.maxAgentsPerUpdate > budget.pedestrianCpuUpdatesPerFrame) {
    issues.push('the low profile exceeds the pedestrian CPU budget');
  }
  const sidewalk = buildSidewalkGraph({
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
    adjacency: new Map(),
  });
  if (sidewalk.edges.length !== 0) issues.push('an empty graph produced sidewalk edges');
  return Object.freeze({
    namespace: GDO_PEDESTRIAN_AUDIT_NAMESPACE,
    ok: issues.length === 0,
    issues: Object.freeze(issues),
    namespace_checked: GDO_PEDESTRIAN_NAMESPACE,
    families: Object.keys(GDO_PEDESTRIAN_FAMILIES).length,
    states: Object.values(GDO_PEDESTRIAN_STATE).length,
    hudSample: pedestrianHudText({ walking: 0, slots: 1, recycles: 0, completedRoutes: 0 }).text,
  });
}
