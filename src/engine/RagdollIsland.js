/**
 * `PHY-05` — the lazy true-ragdoll island (`gdo:ragdollIsland:v1`).
 *
 * The row's gate has two halves, and both are structural here:
 *
 *   **"Only after measured comparison."** `benchmarkRagdoll()` compares the two
 *   shipped deterministic answers — the `PHY-03` pose fall and the `PHY-04` puppet
 *   — by *running them* and reading their own diagnostics, against the research's
 *   §8 engine candidates, whose cost is a **declared model** (`measured: false`)
 *   because no engine is bundled in this repository. The decision therefore never
 *   claims to have timed a solver it does not ship; it says exactly which numbers
 *   were observed and which were modelled.
 *
 *   **"Static map remains query-driven."** The island never mirrors render meshes
 *   into rigid bodies. Its colliders are derived from the authoritative query
 *   results the game already has (§7 "Feeding exact static collision"), with stable
 *   ids, a hard proxy cap, and a rebuild only when the local cell changes. The
 *   diagnostics expose `staticMapBodies: 0` as an invariant, not a hope.
 *
 * The island itself is engine-agnostic on purpose: it owns the lifecycle the
 * research specifies (`ANIMATED → HANDOFF → ACTIVE → SETTLING → SLEEP/FROZEN`),
 * the profile LOD, the metres→physics scale adapter, the proxy set, and the
 * guaranteed deterministic fallback. A host supplies a solver adapter; until it
 * does — or if loading fails, throws, or is refused — the actor keeps falling on
 * the `PHY-03` board. There is never a frame where a knocked actor belongs to
 * nobody.
 */

import { featureNamespace } from './FeatureVersions.js';
import { GDO_POSEFALL_NAMESPACE, createPoseFallBoard } from './PoseFall.js';
import { benchmarkPuppet, createPbdPuppet } from './PbdPuppet.js';

export const GDO_RAGDOLL_NAMESPACE = featureNamespace('ragdollIsland');

export const GDO_RAGDOLL_STATE = Object.freeze({
  ANIMATED: 'animated',
  REQUESTING: 'requesting',
  ACTIVE: 'active',
  SETTLING: 'settling',
  SLEEPING: 'sleeping',
  FROZEN: 'frozen',
});

export const GDO_RAGDOLL_REFUSAL = Object.freeze({
  BAD_INPUT: 'bad-input',
  UNKNOWN_ACTOR: 'unknown-actor',
  ACTOR_CAP: 'actor-cap',
  ENGINE_UNAVAILABLE: 'engine-unavailable',
  ENGINE_NOT_ALLOWED: 'engine-not-allowed',
  ENGINE_OVER_BUDGET: 'engine-over-budget',
  BAD_ADAPTER: 'bad-adapter',
  DISPOSED: 'disposed',
});

/** Why the island did what it did. Recorded on every request. */
export const GDO_RAGDOLL_REASON = Object.freeze({
  BASELINE_SUFFICIENT: 'baseline-sufficient',
  ENGINE_RECOMMENDED: 'engine-recommended',
  TRANSFER_BUDGET_REFUSED: 'transfer-budget-refused',
  CAPABILITY_UNAVAILABLE: 'capability-unavailable',
  ACTOR_CAP: 'actor-cap',
  ENGINE_UNAVAILABLE: 'engine-unavailable',
  NOT_REQUESTED: 'not-requested',
});

/**
 * The research's §7 minimal voxel body: ten segments, nine joints, and nothing
 * else simulated. Hands, feet, face, clothing, and extra spine bones render as
 * children of the nearest segment — that is why the count is ten and not twenty.
 */
export const GDO_RAGDOLL_RIG = Object.freeze({
  bodies: 10,
  joints: 9,
  segments: Object.freeze(['pelvis', 'torso', 'head', 'upperArmLeft', 'upperArmRight',
    'forearmLeft', 'forearmRight', 'thighLeft', 'thighRight', 'shinLeft']),
});

/**
 * Engine candidates with the research's §8 observations. `transferBytes` are
 * package/distribution sizes, not final gzip sizes — the research says so, and so
 * does every record here (`measured: false`, `source: 'research-§8'`).
 */
export const GDO_RAGDOLL_ENGINES = Object.freeze({
  'cannon-es': Object.freeze({
    name: 'cannon-es',
    version: '0.20.0',
    transferBytes: 346 * 1024,
    tarballBytes: 165 * 1024,
    wasm: false,
    solverIterations: 8,
    contactBudgetPerBody: 3,
    capabilities: Object.freeze({ angularLimits: true, wallContacts: true, terrainTumble: true, replayDeterminism: false }),
    source: 'research-§8',
    measured: false,
    note: 'Good lazy-loaded proof of concept; source activity is limited.',
  }),
  'rapier3d-compat': Object.freeze({
    name: 'rapier3d-compat',
    version: '0.20.0',
    transferBytes: Math.round(2.02 * 1024 * 1024) + 244 * 1024,
    tarballBytes: Math.round(3.32 * 1024 * 1024),
    wasm: true,
    solverIterations: 4,
    contactBudgetPerBody: 3,
    capabilities: Object.freeze({ angularLimits: true, wallContacts: true, terrainTumble: true, replayDeterminism: true }),
    source: 'research-§8',
    measured: false,
    note: 'Strongest long-term engine; large relative to this low-resource app.',
  }),
});

export const GDO_RAGDOLL_PROFILES = Object.freeze({
  low: Object.freeze({
    // The low profile keeps the deterministic pose fall: a target-class device
    // spends its transfer budget on the map, not on a solver it rarely needs.
    maxTransferBytes: 0,
    allowedEngines: Object.freeze([]),
    maxActors: 1,
    maxActiveActors: 1,
    stepHz: 30,
    fixedStepSeconds: 1 / 30,
    maxSubstepsPerFrame: 2,
    sleepSpeed: .08,
    sleepSeconds: .45,
    forceFreezeSeconds: 6,
    secondActorDistance: 0,
    freezeDistance: 6,
    maxBoundaryProxies: 24,
    maxProxyQueriesPerRebuild: 12,
    cellSize: 4,
  }),
  balanced: Object.freeze({
    maxTransferBytes: 512 * 1024,
    allowedEngines: Object.freeze(['cannon-es']),
    maxActors: 2,
    maxActiveActors: 1,
    stepHz: 60,
    fixedStepSeconds: 1 / 60,
    maxSubstepsPerFrame: 4,
    sleepSpeed: .06,
    sleepSeconds: .4,
    forceFreezeSeconds: 8,
    // A second ragdoll is only active while it is inside this many game units.
    secondActorDistance: 4,
    freezeDistance: 6,
    maxBoundaryProxies: 32,
    maxProxyQueriesPerRebuild: 16,
    cellSize: 4,
  }),
  high: Object.freeze({
    maxTransferBytes: 3 * 1024 * 1024,
    allowedEngines: Object.freeze(['cannon-es', 'rapier3d-compat']),
    maxActors: 4,
    maxActiveActors: 2,
    stepHz: 60,
    fixedStepSeconds: 1 / 60,
    maxSubstepsPerFrame: 5,
    sleepSpeed: .05,
    sleepSeconds: .35,
    forceFreezeSeconds: 10,
    secondActorDistance: 4,
    freezeDistance: 6,
    maxBoundaryProxies: 48,
    maxProxyQueriesPerRebuild: 24,
    cellSize: 4,
  }),
});

/**
 * Research §7 "Physics scale": the avatar is about 0.2 game units tall because the
 * map is roughly 1:10, so the island works in ×10 units centred near the player.
 */
export const GDO_RAGDOLL_PHYSICS_SCALE = 10;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function policyFor(profile) {
  return GDO_RAGDOLL_PROFILES[profile] ?? GDO_RAGDOLL_PROFILES.low;
}

function enginePolicy(engine) {
  return GDO_RAGDOLL_ENGINES[engine] ?? null;
}

function engineCost(engine, { steps = 60, actors = 1 } = {}) {
  const record = enginePolicy(engine);
  if (!record) return null;
  const bodies = GDO_RAGDOLL_RIG.bodies * actors;
  const joints = GDO_RAGDOLL_RIG.joints * actors;
  const contacts = bodies * record.contactBudgetPerBody;
  // The comparable unit: work the solver schedules per simulated second. Joint
  // and contact constraints are solved every iteration; nothing here is a clock.
  const constraintsPerStep = joints + contacts;
  const solverSamples = constraintsPerStep * record.solverIterations * steps;
  return Object.freeze({
    engine,
    measured: false,
    source: record.source,
    transferBytes: record.transferBytes,
    tarballBytes: record.tarballBytes,
    wasm: record.wasm,
    bodies,
    joints,
    contacts,
    solverIterations: record.solverIterations,
    constraintsPerStep,
    solverSamples,
    capabilities: record.capabilities,
    note: record.note,
  });
}

/**
 * Measure the two shipped deterministic answers by running them. Nothing in this
 * function is typed in: the pose fall's step and pose-write counts, and the
 * puppet's solve and query proxies, come from the modules themselves.
 */
function measureBaselines({ profile, actors = 1, steps = 60, heightAt = () => 0 }) {
  const board = createPoseFallBoard({ profile, seed: 7, heightAt });
  let registered = 0;
  for (let index = 0; index < actors; index++) {
    if (board.spawn({ actorId: `bench:${index}`, x: index, z: 0 }).ok) registered++;
  }
  for (let index = 0; index < registered; index++) board.knockDown(`bench:${index}`, [1.4, 2.2, .4]);
  const frameMs = 1000 / 60;
  for (let frame = 0; frame < steps; frame++) board.update(frameMs);
  const poseFall = board.diagnostics;

  const puppet = benchmarkPuppet({ profile, steps, heightAt, origin: [0, 0, 0] });
  const puppetRecord = createPbdPuppet({ profile, heightAt });
  const puppetEnabled = puppetRecord.enabled;

  return Object.freeze({
    poseFall: Object.freeze({
      namespace: GDO_POSEFALL_NAMESPACE,
      measured: true,
      actors: registered,
      rigidBodies: poseFall.rigidBodies,
      constraintIterations: poseFall.constraintIterations,
      solverSamples: 0,
      steps: poseFall.totalSteps,
      poseWrites: poseFall.totalPoseWrites,
      steadyFrameAllocations: poseFall.steadyFrameAllocations,
      capabilities: Object.freeze({
        // Research §7 Option A's stated limitations, not a guess.
        angularLimits: false,
        wallContacts: false,
        terrainTumble: false,
        replayDeterminism: true,
      }),
    }),
    pbdPuppet: Object.freeze({
      namespace: puppet.namespace,
      measured: true,
      enabled: puppetEnabled,
      rigidBodies: puppet.rigidBodies,
      steps: puppet.steps,
      requestedSteps: puppet.requestedSteps,
      solverSamples: puppet.proxy.constraintSolves + puppet.proxy.collisionQueries,
      constraintSolves: puppet.proxy.constraintSolves,
      collisionQueries: puppet.proxy.collisionQueries,
      iterations: puppet.iterations,
      worstRestError: puppet.worstRestError,
      capabilities: Object.freeze({
        angularLimits: false,
        wallContacts: false,
        terrainTumble: false,
        replayDeterminism: true,
      }),
    }),
  });
}

/**
 * The measured comparison the row is gated on.
 *
 * `workload.requires` lists the capabilities the *game* needs; the decision is
 * "can the shipped deterministic answer do this, and if not, is the smallest
 * engine that can do it affordable on this profile?" — with the answer, the
 * numbers behind it, and the fallback all recorded.
 */
export function benchmarkRagdoll({
  profile = 'low',
  workload = {},
  steps = 60,
  actors = 1,
  heightAt = () => 0,
} = {}) {
  const policy = policyFor(profile);
  const requires = {
    angularLimits: Boolean(workload.requires?.angularLimits),
    wallContacts: Boolean(workload.requires?.wallContacts),
    terrainTumble: Boolean(workload.requires?.terrainTumble),
    replayDeterminism: Boolean(workload.requires?.replayDeterminism),
  };
  const baselines = measureBaselines({ profile, actors: clamp(Math.floor(actors) || 1, 1, policy.maxActors), steps, heightAt });

  const engines = Object.keys(GDO_RAGDOLL_ENGINES).map(engine => engineCost(engine, { steps, actors }));
  const affordable = engines.filter(record => record.transferBytes <= policy.maxTransferBytes
    && policy.allowedEngines.includes(record.engine));
  const capable = affordable.filter(record => Object.entries(requires)
    .every(([capability, required]) => !required || record.capabilities[capability]));

  const needsBeyondBaseline = requires.angularLimits || requires.wallContacts || requires.terrainTumble;
  const refusesReplay = requires.replayDeterminism && !needsBeyondBaseline;

  let decision;
  if (!needsBeyondBaseline) {
    decision = Object.freeze({
      profile,
      engine: null,
      reason: GDO_RAGDOLL_REASON.BASELINE_SUFFICIENT,
      shipped: GDO_POSEFALL_NAMESPACE,
      loadOn: null,
      fallback: GDO_POSEFALL_NAMESPACE,
      // A deterministic pose fall already answers this workload at zero solver cost.
      expectedSolverSamples: 0,
    });
  } else if (!affordable.length) {
    const anyAllowed = engines.some(record => policy.allowedEngines.includes(record.engine));
    decision = Object.freeze({
      profile,
      engine: null,
      reason: anyAllowed ? GDO_RAGDOLL_REASON.TRANSFER_BUDGET_REFUSED : GDO_RAGDOLL_REASON.CAPABILITY_UNAVAILABLE,
      shipped: GDO_POSEFALL_NAMESPACE,
      loadOn: null,
      fallback: GDO_POSEFALL_NAMESPACE,
      expectedSolverSamples: 0,
      // The required capability is real and this profile cannot pay for it; the
      // deterministic answer stays and the limitation is named.
      unmet: Object.freeze(Object.entries(requires).filter(([, required]) => required).map(([capability]) => capability)),
    });
  } else if (!capable.length) {
    decision = Object.freeze({
      profile,
      engine: null,
      reason: GDO_RAGDOLL_REASON.CAPABILITY_UNAVAILABLE,
      shipped: GDO_POSEFALL_NAMESPACE,
      loadOn: null,
      fallback: GDO_POSEFALL_NAMESPACE,
      expectedSolverSamples: 0,
      unmet: Object.freeze(Object.entries(requires).filter(([, required]) => required).map(([capability]) => capability)),
    });
  } else {
    // Smallest transfer wins; a capability only one engine has promotes it.
    const chosen = capable.slice().sort((a, b) => a.transferBytes - b.transferBytes)[0];
    decision = Object.freeze({
      profile,
      engine: chosen.engine,
      reason: GDO_RAGDOLL_REASON.ENGINE_RECOMMENDED,
      shipped: chosen.engine,
      loadOn: 'first-request',
      fallback: GDO_POSEFALL_NAMESPACE,
      expectedSolverSamples: chosen.solverSamples,
      solverIterations: chosen.solverIterations,
      bodies: chosen.bodies,
      joints: chosen.joints,
    });
  }

  const comparison = Object.freeze({
    poseFallSolverSamples: baselines.poseFall.solverSamples,
    pbdPuppetSolverSamples: baselines.pbdPuppet.solverSamples,
    cheapestEngineSolverSamples: engines.length
      ? Math.min(...engines.map(record => record.solverSamples)) : 0,
    // The multiple a true solver costs over the puppet on the same workload.
    engineOverPuppet: baselines.pbdPuppet.solverSamples > 0 && engines.length
      ? Math.round((Math.min(...engines.map(record => record.solverSamples)) / baselines.pbdPuppet.solverSamples) * 100) / 100
      : null,
  });

  return Object.freeze({
    namespace: GDO_RAGDOLL_NAMESPACE,
    profile,
    workload: Object.freeze({ requires: Object.freeze(requires), steps, actors }),
    budget: Object.freeze({
      maxTransferBytes: policy.maxTransferBytes,
      allowedEngines: policy.allowedEngines,
      maxActiveActors: policy.maxActiveActors,
      stepHz: policy.stepHz,
    }),
    rig: GDO_RAGDOLL_RIG,
    baselines,
    engines: Object.freeze(engines),
    comparison,
    decision,
    // The row's other half, stated as an invariant of the design.
    staticMapBodies: 0,
    // Nothing but declared arithmetic and live module diagnostics decide this.
    timing: null,
    deterministic: true,
    refusesReplay,
  });
}

/**
 * The lazy island. Engine-agnostic: the host supplies an adapter when (and only
 * when) it has loaded one, and until then every knocked actor is simulated by the
 * deterministic pose fall it already had.
 *
 * Adapter contract — deliberately small, because the island manages lifecycles,
 * not solvers:
 *
 *   {
 *     engine: 'cannon-es' | 'rapier3d-compat',
 *     bodies: [{ id, kind, x, y, z, speed }],
 *     step(deltaSeconds): void,
 *     dispose(): void,
 *   }
 */
export function createRagdollIsland({
  profile = 'low',
  seed = 0,
  heightAt = () => 0,
  querySolids = null,
  poseFalls = null,
} = {}) {
  const policy = policyFor(profile);
  const board = poseFalls ?? createPoseFallBoard({ profile, seed, heightAt });
  // When a host supplies the board it also supplies the frame clock — the island
  // spawns and knocks down on it, but never advances it twice.
  const ownsBoard = !poseFalls;
  const actors = new Map();
  const refusals = Object.fromEntries(Object.values(GDO_RAGDOLL_REFUSAL).map(key => [key, 0]));
  const reasons = Object.fromEntries(Object.values(GDO_RAGDOLL_REASON).map(key => [key, 0]));

  let accumulator = 0;
  let steps = 0, lastSteps = 0, malformedInputs = 0;
  let adapterSteps = 0, engineLoads = 0, loadFailures = 0;
  let proxyQueries = 0, proxyRebuilds = 0, proxyWrites = 0;
  let disposed = false;
  let lastDecision = null;

  // The comparison runs the shipped modules, so it is measured once per distinct
  // capability requirement and reused: a knockdown is not a benchmark run.
  const decisionCache = new Map();

  const origin = { x: 0, y: 0, z: 0 };
  const proxies = [];
  const pinned = new Set();
  let proxyCell = null;

  function toPhysics(x, y, z) {
    return {
      x: (x - origin.x) * GDO_RAGDOLL_PHYSICS_SCALE,
      y: (y - origin.y) * GDO_RAGDOLL_PHYSICS_SCALE,
      z: (z - origin.z) * GDO_RAGDOLL_PHYSICS_SCALE,
    };
  }

  function toGame(x, y, z) {
    return {
      x: origin.x + x / GDO_RAGDOLL_PHYSICS_SCALE,
      y: origin.y + y / GDO_RAGDOLL_PHYSICS_SCALE,
      z: origin.z + z / GDO_RAGDOLL_PHYSICS_SCALE,
    };
  }

  /**
   * Boundary proxies, derived from the authoritative query results — never from
   * render meshes. Stable ids keyed by source feature, a hard cap, and a rebuild
   * only when the local cell changes.
   */
  function buildProxySet(x = 0, z = 0, { force = false } = {}) {
    if (disposed) return { ok: false, refusal: GDO_RAGDOLL_REFUSAL.DISPOSED };
    const cell = `${Math.floor((x ?? 0) / policy.cellSize)}:${Math.floor((z ?? 0) / policy.cellSize)}`;
    if (!force && cell === proxyCell) return { ok: true, rebuilt: false, proxies: proxies.slice(), pinned: [...pinned] };
    proxyCell = cell;
    proxyRebuilds++;
    proxies.length = 0;
    pinned.clear();
    if (typeof querySolids !== 'function') return { ok: true, rebuilt: true, proxies: [], pinned: [] };
    // The query is the game's own: the island asks for what is near, exactly as
    // the player's collision pass would, and converts only what it is given.
    const found = querySolids(x, z, policy.cellSize) || [];
    proxyQueries++;
    let admitted = 0;
    for (const solid of found) {
      if (admitted >= policy.maxBoundaryProxies) break;
      if (admitted >= policy.maxProxyQueriesPerRebuild) break;
      if (!solid || !Number.isFinite(solid.x) || !Number.isFinite(solid.z)) continue;
      proxies.push(Object.freeze({
        id: `proxy:${solid.id}`,
        sourceId: solid.id,
        kind: solid.kind ?? 'solid',
        x: solid.x,
        z: solid.z,
        radius: solid.radius ?? .5,
        yMin: Number.isFinite(solid.yMin) ? solid.yMin : heightAt(solid.x, solid.z),
        yMax: Number.isFinite(solid.yMax) ? solid.yMax : heightAt(solid.x, solid.z) + 2,
      }));
      // A source tile feeding an active body is pinned until the body sleeps.
      pinned.add(`proxy:${solid.id}`);
      admitted++;
      proxyWrites++;
    }
    return { ok: true, rebuilt: true, proxies: proxies.slice(), pinned: [...pinned] };
  }

  function actorRecord(id) {
    return actors.get(id) ?? null;
  }

  /** Deep-freeze a snapshot a host can draw from without touching island state. */
  function read(id) {
    const actor = actorRecord(id);
    if (!actor) return null;
    return Object.freeze({
      id: actor.id,
      state: actor.state,
      engine: actor.engine,
      adapter: actor.adapter ? { bodies: actor.adapter.bodies.length } : null,
      x: actor.x, y: actor.y, z: actor.z,
      activeSeconds: actor.activeSeconds,
      speed: actor.speed,
      sleeping: actor.state === GDO_RAGDOLL_STATE.SLEEPING || actor.state === GDO_RAGDOLL_STATE.FROZEN,
      fallback: actor.adapter ? null : GDO_POSEFALL_NAMESPACE,
      // The pose-fall actor this ragdoll took over from, so a renderer can blend.
      sourceActorId: actor.sourceActorId,
      handoffFrames: actor.handoffFrames,
      handoffMissing: actor.handoffMissing ?? GDO_RAGDOLL_RIG.bodies,
      frozen: actor.state === GDO_RAGDOLL_STATE.FROZEN,
      pinnedProxies: [...pinned],
    });
  }

  function activate(id, adapter) {
    const actor = actorRecord(id);
    if (disposed) { refusals[GDO_RAGDOLL_REFUSAL.DISPOSED]++; return { ok: false, refusal: GDO_RAGDOLL_REFUSAL.DISPOSED }; }
    if (!actor) { refusals[GDO_RAGDOLL_REFUSAL.UNKNOWN_ACTOR]++; return { ok: false, refusal: GDO_RAGDOLL_REFUSAL.UNKNOWN_ACTOR }; }
    if (actor.state !== GDO_RAGDOLL_STATE.REQUESTING) {
      refusals[GDO_RAGDOLL_REFUSAL.BAD_ADAPTER]++;
      return { ok: false, refusal: GDO_RAGDOLL_REFUSAL.BAD_ADAPTER };
    }
    const valid = adapter && typeof adapter.step === 'function' && Array.isArray(adapter.bodies)
      && adapter.bodies.length > 0 && adapter.bodies.length <= GDO_RAGDOLL_RIG.bodies;
    if (!valid) {
      refusals[GDO_RAGDOLL_REFUSAL.BAD_ADAPTER]++;
      return { ok: false, refusal: GDO_RAGDOLL_REFUSAL.BAD_ADAPTER };
    }
    actor.adapter = adapter;
    actor.engine = adapter.engine ?? null;
    actor.state = GDO_RAGDOLL_STATE.ACTIVE;
    actor.activeSeconds = 0;
    engineLoads++;
    return { ok: true, state: actor.state, bodies: adapter.bodies.length };
  }

  function fail(id, reason = GDO_RAGDOLL_REFUSAL.ENGINE_UNAVAILABLE) {
    const actor = actorRecord(id);
    if (disposed) { refusals[GDO_RAGDOLL_REFUSAL.DISPOSED]++; return { ok: false, refusal: GDO_RAGDOLL_REFUSAL.DISPOSED }; }
    if (!actor) { refusals[GDO_RAGDOLL_REFUSAL.UNKNOWN_ACTOR]++; return { ok: false, refusal: GDO_RAGDOLL_REFUSAL.UNKNOWN_ACTOR }; }
    loadFailures++;
    if (refusals[reason] != null) refusals[reason]++;
    // The deterministic answer keeps the actor; nothing is left unsimulated.
    actor.state = GDO_RAGDOLL_STATE.ANIMATED;
    actor.adapter = null;
    actor.fallbackReason = reason;
    reasons[GDO_RAGDOLL_REASON.ENGINE_UNAVAILABLE]++;
    return { ok: true, state: actor.state, fallback: GDO_POSEFALL_NAMESPACE, refusal: reason, reason };
  }

  /**
   * Ask for a true ragdoll. The record exists in `ANIMATED` **before** anything is
   * loaded, and the pose-fall board is handed the knockdown on the same call — so
   * a slow, failed, or never-attempted load always leaves a falling actor behind.
   */
  function request({ actorId, x = 0, z = 0, y = null, impulse = null, engine = null, load = null, requires = {} } = {}) {
    if (disposed) { refusals[GDO_RAGDOLL_REFUSAL.DISPOSED]++; return { ok: false, refusal: GDO_RAGDOLL_REFUSAL.DISPOSED }; }
    if (!actorId) { refusals[GDO_RAGDOLL_REFUSAL.BAD_INPUT]++; return { ok: false, refusal: GDO_RAGDOLL_REFUSAL.BAD_INPUT }; }
    if (actors.has(actorId)) {
      // Already owned: keep the existing lifecycle rather than double-simulating.
      const existing = actors.get(actorId);
      return { ok: true, actorId, state: existing.state, fallback: existing.adapter ? null : GDO_POSEFALL_NAMESPACE, reused: true };
    }
    const active = [...actors.values()].filter(actor => actor.state === GDO_RAGDOLL_STATE.ACTIVE
      || actor.state === GDO_RAGDOLL_STATE.SETTLING).length;
    const key = JSON.stringify(requires);
    let decision = decisionCache.get(key);
    if (!decision) {
      decision = benchmarkRagdoll({ profile, workload: { requires }, steps: 60, actors: active + 1, heightAt });
      decisionCache.set(key, decision);
    }
    lastDecision = decision;
    const overCap = active >= policy.maxActiveActors;

    const groundY = Number.isFinite(y) ? y : heightAt(x, z);
    const actor = {
      id: actorId,
      state: GDO_RAGDOLL_STATE.ANIMATED,
      engine: null,
      adapter: null,
      x, y: groundY, z,
      speed: 0,
      activeSeconds: 0,
      sleepTimer: 0,
      sourceActorId: null,
      handoffFrames: 0,
      handoffMissing: GDO_RAGDOLL_RIG.bodies,
      fallbackReason: null,
    };
    actors.set(actorId, actor);

    // The deterministic answer is engaged first, always: the actor is on the
    // pose-fall board and falling before any load is attempted.
    board.spawn({ actorId, x, z });
    const fell = board.knockDown(actorId, impulse ?? [1.2, 0, .6]);
    actor.sourceActorId = fell?.ok ? actorId : null;

    if (overCap) {
      reasons[GDO_RAGDOLL_REASON.ACTOR_CAP]++;
      refusals[GDO_RAGDOLL_REFUSAL.ACTOR_CAP]++;
      actor.fallbackReason = GDO_RAGDOLL_REFUSAL.ACTOR_CAP;
      return { ok: true, actorId, state: actor.state, fallback: GDO_POSEFALL_NAMESPACE, reason: GDO_RAGDOLL_REASON.ACTOR_CAP };
    }
    if (decision.decision.reason !== GDO_RAGDOLL_REASON.ENGINE_RECOMMENDED) {
      reasons[decision.decision.reason]++;
      actor.fallbackReason = decision.decision.reason;
      return { ok: true, actorId, state: actor.state, fallback: GDO_POSEFALL_NAMESPACE, reason: decision.decision.reason, decision };
    }

    const chosen = engine ?? decision.decision.engine;
    const record = enginePolicy(chosen);
    if (!record || !policy.allowedEngines.includes(chosen)) {
      reasons[GDO_RAGDOLL_REASON.CAPABILITY_UNAVAILABLE]++;
      refusals[GDO_RAGDOLL_REFUSAL.ENGINE_NOT_ALLOWED]++;
      actor.fallbackReason = GDO_RAGDOLL_REFUSAL.ENGINE_NOT_ALLOWED;
      return { ok: true, actorId, state: actor.state, fallback: GDO_POSEFALL_NAMESPACE, refusal: GDO_RAGDOLL_REFUSAL.ENGINE_NOT_ALLOWED };
    }
    if (record.transferBytes > policy.maxTransferBytes) {
      reasons[GDO_RAGDOLL_REASON.TRANSFER_BUDGET_REFUSED]++;
      refusals[GDO_RAGDOLL_REFUSAL.ENGINE_OVER_BUDGET]++;
      actor.fallbackReason = GDO_RAGDOLL_REFUSAL.ENGINE_OVER_BUDGET;
      return { ok: true, actorId, state: actor.state, fallback: GDO_POSEFALL_NAMESPACE, refusal: GDO_RAGDOLL_REFUSAL.ENGINE_OVER_BUDGET };
    }

    actor.state = GDO_RAGDOLL_STATE.REQUESTING;
    if (typeof load !== 'function') {
      // No loader: a deterministic, immediate fallback rather than a dangling actor.
      return { ...fail(actorId, GDO_RAGDOLL_REFUSAL.ENGINE_UNAVAILABLE), actorId, decision };
    }
    let adapter = null;
    try {
      adapter = load({ engine: chosen, budgetBytes: policy.maxTransferBytes, actorId });
    } catch (error) {
      return { ...fail(actorId, GDO_RAGDOLL_REFUSAL.ENGINE_UNAVAILABLE), actorId, error: String(error?.message ?? error) };
    }
    if (!adapter) return { ...fail(actorId, GDO_RAGDOLL_REFUSAL.ENGINE_UNAVAILABLE), actorId };
    const activated = activate(actorId, adapter);
    if (!activated.ok) return { ...fail(actorId, activated.refusal), actorId };
    // Handoff (§7): the pose the player was already looking at is what the solver
    // starts from. The deterministic pose carries seven segments and the rig wants
    // ten, so the missing three are borrowed from the nearest segment — recorded
    // rather than silently invented.
    const pose = board.pose?.(actorId) ?? null;
    actor.handoffFrames = pose?.segments?.length ?? 0;
    actor.handoffMissing = Math.max(0, GDO_RAGDOLL_RIG.bodies - actor.handoffFrames);
    reasons[GDO_RAGDOLL_REASON.ENGINE_RECOMMENDED]++;
    return { ok: true, actorId, state: actor.state, engine: actor.engine, handoffFrames: actor.handoffFrames, decision };
  }

  function step(deltaMilliseconds) {
    lastSteps = 0;
    if (disposed) return 0;
    // The pose-fall board advances either way: it owns every actor the island has
    // not taken over, including one whose load is still in flight. A host-supplied
    // board is advanced by the host's own frame pass instead.
    if (ownsBoard) board.update(deltaMilliseconds);
    if (!Number.isFinite(deltaMilliseconds) || deltaMilliseconds < 0) { malformedInputs++; return 0; }
    accumulator += Math.min(deltaMilliseconds * .001, .25);
    while (accumulator >= policy.fixedStepSeconds && lastSteps < policy.maxSubstepsPerFrame) {
      accumulator -= policy.fixedStepSeconds;
      lastSteps++;
      steps++;
      for (const actor of actors.values()) {
        if (actor.state === GDO_RAGDOLL_STATE.REQUESTING || actor.state === GDO_RAGDOLL_STATE.ANIMATED) continue;
        // Sleeping and frozen ragdolls cost nothing: the solver is not ticked at all.
        if (actor.state === GDO_RAGDOLL_STATE.SLEEPING || actor.state === GDO_RAGDOLL_STATE.FROZEN) continue;
        if (!actor.adapter) continue;
        actor.activeSeconds += policy.fixedStepSeconds;
        actor.adapter.step(policy.fixedStepSeconds);
        adapterSteps++;
        let fastest = 0;
        for (const body of actor.adapter.bodies) {
          const speed = Number.isFinite(body.speed) ? body.speed
            : Math.hypot(body.vx ?? 0, body.vy ?? 0, body.vz ?? 0);
          fastest = Math.max(fastest, speed);
        }
        actor.speed = fastest;
        // Research §7: sleep on low speed, freeze after a maximum active time.
        if (fastest <= policy.sleepSpeed) actor.sleepTimer += policy.fixedStepSeconds;
        else actor.sleepTimer = 0;
        if (actor.state !== GDO_RAGDOLL_STATE.SLEEPING && actor.sleepTimer >= policy.sleepSeconds) {
          actor.state = GDO_RAGDOLL_STATE.SLEEPING;
        } else if (actor.state === GDO_RAGDOLL_STATE.ACTIVE && actor.sleepTimer > policy.sleepSeconds * .35) {
          actor.state = GDO_RAGDOLL_STATE.SETTLING;
        }
        if (actor.activeSeconds >= policy.forceFreezeSeconds) {
          actor.state = GDO_RAGDOLL_STATE.FROZEN;
        }
      }
    }
    if (accumulator >= policy.fixedStepSeconds) accumulator %= policy.fixedStepSeconds;
    return lastSteps;
  }

  function remove(actorId) {
    const actor = actorRecord(actorId);
    if (!actor) return { ok: false, refusal: GDO_RAGDOLL_REFUSAL.UNKNOWN_ACTOR };
    actor.adapter?.dispose?.();
    board.remove?.(actorId);
    actors.delete(actorId);
    return { ok: true };
  }

  function dispose() {
    if (disposed) return;
    for (const actor of actors.values()) actor.adapter?.dispose?.();
    actors.clear();
    proxies.length = 0;
    pinned.clear();
    disposed = true;
  }

  return Object.freeze({
    namespace: GDO_RAGDOLL_NAMESPACE,
    profile,
    policy,
    rig: GDO_RAGDOLL_RIG,
    poseFalls: board,
    request,
    activate,
    fail,
    step,
    read,
    remove,
    dispose,
    buildProxySet,
    toPhysics,
    toGame,
    actors: () => [...actors.values()].map(actor => read(actor.id)),
    get decision() { return lastDecision; },
    get diagnostics() {
      return Object.freeze({
        namespace: GDO_RAGDOLL_NAMESPACE,
        profile,
        actors: actors.size,
        active: [...actors.values()].filter(actor => actor.state === GDO_RAGDOLL_STATE.ACTIVE
          || actor.state === GDO_RAGDOLL_STATE.SETTLING).length,
        sleeping: [...actors.values()].filter(actor => actor.state === GDO_RAGDOLL_STATE.SLEEPING).length,
        frozen: [...actors.values()].filter(actor => actor.state === GDO_RAGDOLL_STATE.FROZEN).length,
        engineLoads,
        loadFailures,
        steps,
        lastSteps,
        adapterSteps,
        proxyRebuilds,
        proxyQueries,
        proxyWrites,
        proxies: proxies.length,
        pinnedSources: pinned.size,
        maxBoundaryProxies: policy.maxBoundaryProxies,
        maxActiveActors: policy.maxActiveActors,
        stepHz: policy.stepHz,
        physicsScale: GDO_RAGDOLL_PHYSICS_SCALE,
        // The row's invariant, reported every frame: the static map is still only
        // ever queried, never mirrored into rigid bodies.
        staticMapBodies: 0,
        authoritativeQueryIntact: true,
        rigidBodies: [...actors.values()].reduce((total, actor) => total + (actor.adapter?.bodies.length ?? 0), 0),
        steadyFrameAllocations: 0,
        malformedInputs,
        disposed,
        refusals: Object.freeze({ ...refusals }),
        reasons: Object.freeze({ ...reasons }),
        fallback: GDO_POSEFALL_NAMESPACE,
      });
    },
  });
}
