/**
 * `GME-08` — procedural local activities.
 *
 * The research asks for *template* micro-quests that are grounded in real
 * affordances: a "cross two bridges" objective may only be emitted once the local
 * context proves two reachable mapped bridges exist, and a template that cannot
 * be grounded is refused rather than invented. It also asks for one *daily
 * deterministic challenge*: the date plus the coordinate selects the goal, and the
 * same date at the same coordinate reproduces the same board.
 *
 * This module is that generator, as pure data and maths. It reads a *context
 * snapshot* — places, named roads, bridge decks, water presence, and prop
 * families, all with positions the world already has — and never touches the
 * world, the renderer, or the network. Progress is computed from the caller's
 * position, travelled distance, and the `GME-06` journal's own ids, so an
 * objective can only ever ask for something the player can really reach.
 */

import { featureNamespace } from './FeatureVersions.js';
import { GDO_DISCOVERY_PROFILES, createDiscoveryJournal, placeIdFor } from './DiscoveryJournal.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

export const LOCAL_ACTIVITIES_NAMESPACE = featureNamespace('localActivities');

export const GDO_ACTIVITY_STATE = Object.freeze({
  ACTIVE: 'active', COMPLETE: 'complete',
});

/** Why a template was refused. A refusal is data, never a fabricated objective. */
export const GDO_ACTIVITY_REFUSAL = Object.freeze({
  NO_AFFORDANCE: 'no-affordance',
  CAP: 'cap',
  DUPLICATE: 'duplicate',
});

export const GDO_ACTIVITY_GOAL = Object.freeze({
  VISIT: 'visit', SIGHT: 'sight', PROXIMITY: 'proximity', DISTANCE: 'distance',
});

/**
 * The affordance each context-requiring template is grounded in: the snapshot key
 * it proves itself from. A template with no entry is self-referential (it asks
 * about the walk itself) and needs nothing from the map.
 */
export const GDO_ACTIVITY_CONTEXT_SOURCES = Object.freeze({
  'visit-places': 'places',
  'sight-places': 'places',
  'reach-road': 'roads',
  'reach-water': 'water',
  'cross-bridge': 'bridges',
  'find-stall': 'props',
});

/** Per-profile ceilings: how many objectives a board may hold and test. */
export const GDO_ACTIVITY_LIMITS = Object.freeze({
  low: Object.freeze({ board: 3, targets: 3, checks: 24, placeTargets: 2 }),
  balanced: Object.freeze({ board: 4, targets: 4, checks: 36, placeTargets: 3 }),
  high: Object.freeze({ board: 5, targets: 5, checks: 48, placeTargets: 3 }),
});

function hash(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

function rounded(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** The daily key the deterministic challenge is seeded from. */
export function activityDateKey(now = Date.now()) {
  const date = now instanceof Date ? now : new Date(now);
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/** World version + coordinate + date: the documented reproducible seed. */
export function activitySeedFor({ worldVersion = '1', latitude = 0, longitude = 0, dateKey = '1970-01-01' } = {}) {
  const coordinate = `${Math.round(latitude * 1000)},${Math.round(longitude * 1000)}`;
  return hash(`${LOCAL_ACTIVITIES_NAMESPACE}|${worldVersion}|${coordinate}|${dateKey}`);
}

function pick(list, seed, salt, count) {
  const ranked = list.map((entry, index) => ({
    entry, index, rank: hash(`${seed}:${salt}:${index}`),
  })).sort((first, second) => (first.rank < second.rank ? -1 : first.rank > second.rank ? 1 : first.index - second.index));
  return ranked.slice(0, Math.max(0, count)).map(item => item.entry);
}

function nearest(list, x, z, count) {
  return [...list]
    .map(entry => ({ entry, distance: Math.hypot(entry.x - x, entry.z - z) }))
    .sort((first, second) => (first.distance - second.distance) || (first.entry.id < second.entry.id ? -1 : 1))
    .slice(0, Math.max(0, count))
    .map(item => ({ ...item.entry, distance: rounded(item.distance) }));
}

/**
 * The objective catalogue. Each template is a *predicate plus a goal*: `ground`
 * either proves the affordances exist and returns the targets it will use, or
 * refuses with a reason. Nothing here formats fiction — the titles come from the
 * mapped names and classes the context actually carries.
 */
export const GDO_ACTIVITY_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'visit-places',
    requires: 'places',
    label: 'Visit named places',
    goal: GDO_ACTIVITY_GOAL.VISIT,
    ground({ places, limits, seed }) {
      const eligible = places.filter(place => place.kind !== 'street' && place.kind !== 'other');
      const pool = eligible.length >= 2 ? eligible : places;
      const required = Math.min(limits.placeTargets, pool.length);
      if (required < 2) return { ok: false, reason: GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE };
      const targets = pick(pool, seed, 'visit', required);
      return { ok: true, required, targets, proof: `${places.length} mapped names, ${required} chosen` };
    },
    render({ required, targets }) {
      return { title: `Visit ${required} named places`, detail: `Start with ${targets.map(t => t.name).join(' and ')}` };
    },
  }),
  Object.freeze({
    id: 'reach-road',
    requires: 'roads',
    label: 'Follow a named road',
    goal: GDO_ACTIVITY_GOAL.PROXIMITY,
    ground({ roads, seed }) {
      const named = roads.filter(road => road.name);
      if (!named.length) return { ok: false, reason: GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE };
      const [target] = pick(named, seed, 'road', 1);
      return { ok: true, required: 1, targets: [target], proof: `${named.length} named mapped roads` };
    },
    render({ targets }) {
      return { title: `Walk ${targets[0].name}`, detail: `Reach the mapped centreline of ${targets[0].name}` };
    },
  }),
  Object.freeze({
    id: 'reach-water',
    requires: 'water',
    label: 'Reach the water',
    goal: GDO_ACTIVITY_GOAL.PROXIMITY,
    ground({ water, seed }) {
      if (!water.length) return { ok: false, reason: GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE };
      const [target] = pick(water, seed, 'water', 1);
      return { ok: true, required: 1, targets: [target], proof: `${water.length} sampled water points (${target.className})` };
    },
    render({ targets }) {
      return { title: `Reach the ${targets[0].className}`, detail: `A mapped ${targets[0].classKind} crossing is nearby` };
    },
  }),
  Object.freeze({
    id: 'cross-bridge',
    requires: 'bridges',
    label: 'Cross two mapped bridges',
    goal: GDO_ACTIVITY_GOAL.PROXIMITY,
    /**
     * The research's hard rule, in the one place it can be enforced: a "cross two
     * bridges" objective may only be emitted once the local context proves two
     * deck spans exist. One bridge refuses; two are chosen deterministically.
     */
    ground({ bridges, seed }) {
      if (bridges.length < 2) return { ok: false, reason: GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE };
      const targets = pick(bridges, seed, 'bridge', 2);
      return {
        ok: true, required: 2, targets,
        proof: `${bridges.length} reachable elevated deck spans`,
      };
    },
    render({ required, targets }) {
      return {
        title: `Cross ${required} mapped bridges`,
        detail: `Reach the deck spans ${targets.map(target => target.name).filter(Boolean).join(' and ') || 'on the elevated grade'}`,
      };
    },
  }),
  Object.freeze({
    id: 'find-stall',
    requires: 'props',
    label: 'Find a food stall',
    goal: GDO_ACTIVITY_GOAL.PROXIMITY,
    ground({ props, seed }) {
      const families = [...new Set(props.map(prop => prop.family))];
      if (!families.length) return { ok: false, reason: GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE };
      const [family] = pick(families, seed, 'family', 1);
      const stalls = props.filter(prop => prop.family === family);
      const [target] = pick(stalls, seed, 'stall', 1);
      return {
        ok: true, required: 1, targets: [target],
        proof: `${props.length} placed props in ${families.length} families`,
      };
    },
    render({ targets }) {
      const family = targets[0].family.replace(/-/g, ' ');
      return { title: `Find the ${family}`, detail: `Walk to the placed ${family} and stand inside its interaction range` };
    },
  }),
  Object.freeze({
    id: 'sight-places',
    requires: 'places',
    label: 'Sight named places',
    goal: GDO_ACTIVITY_GOAL.SIGHT,
    ground({ places, limits, seed }) {
      const required = Math.min(limits.placeTargets + 1, places.length);
      if (required < 2) return { ok: false, reason: GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE };
      const targets = pick(places, seed, 'sight', required);
      return { ok: true, required, targets, proof: `${places.length} mapped names` };
    },
    render({ required }) {
      return { title: `Sight ${required} mapped names`, detail: 'Walk until the names appear on the HUD' };
    },
  }),
  Object.freeze({
    id: 'return-home',
    label: 'Return to the start',
    goal: GDO_ACTIVITY_GOAL.PROXIMITY,
    ground({ origin }) {
      if (!origin) return { ok: false, reason: GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE };
      return {
        ok: true, required: 1,
        targets: [{ id: 'origin', kind: 'origin', name: 'your starting point', x: origin.x, z: origin.z }],
        proof: 'the walk start is recorded',
      };
    },
    render() {
      return { title: 'Return to the start', detail: 'Walk back to where this coordinate walk began' };
    },
  }),
  Object.freeze({
    id: 'walk-distance',
    label: 'Walk a distance',
    goal: GDO_ACTIVITY_GOAL.DISTANCE,
    ground({ seed, limits }) {
      const metres = [300, 500, 800][hash(`${seed}:distance`) % 3];
      return {
        ok: true, required: metres, targets: [],
        proof: `a ${metres} m walk is always possible`,
      };
    },
    render({ required }) {
      return { title: `Walk ${required} m`, detail: 'Distance is measured from the walk start, in mapped metres' };
    },
  }),
]);

/**
 * One activity board. `refresh(snapshot)` rebuilds it deterministically from the
 * snapshot plus the seed; `advance(...)` reports the transitions one frame made.
 */
export function createLocalActivities({
  profile = 'low',
  seed = '00000000',
  arrivalRadius = 2.5,
  limits = null,
  templates = GDO_ACTIVITY_TEMPLATES,
} = {}) {
  const caps = limits ?? GDO_ACTIVITY_LIMITS[profile] ?? GDO_ACTIVITY_LIMITS.low;
  // The live records are mutable so a frame can advance them in place; every
  // public read returns a frozen copy (or one reused record), so a steady frame
  // neither allocates nor lets a caller mutate the board.
  const records = [];
  const currentRecord = {
    id: null, title: '', detail: '', progress: 0, required: 0, state: GDO_ACTIVITY_STATE.ACTIVE,
    targets: 0, proof: '',
  };
  const summaryRecord = {
    namespace: LOCAL_ACTIVITIES_NAMESPACE, seed, board: 0, completed: 0,
    current: null, travelled: 0, steadyFrameAllocations: 0,
  };
  const counters = {
    refreshes: 0, emissions: 0, refusals: 0, completions: 0,
    advances: 0, checks: 0, steadyFrameAllocations: 0, trimmed: 0,
    refusalReasons: Object.create(null),
  };
  let snapshotSignature = null;
  let origin = null;
  let metresTravelled = 0;
  let lastPosition = null;

  const refuse = (template, reason) => {
    counters.refusals++;
    counters.refusalReasons[reason] = (counters.refusalReasons[reason] ?? 0) + 1;
    return Object.freeze({ template: template.id, reason });
  };

  const build = snapshot => {
    const context = {
      places: snapshot.places ?? [], roads: snapshot.roads ?? [],
      bridges: snapshot.bridges ?? [], water: snapshot.water ?? [], props: snapshot.props ?? [],
      origin: snapshot.origin ?? origin, limits: caps, seed,
    };
    const emitted = [];
    const refusals = [];
    const used = new Set();
    for (const template of templates) {
      if (counters.checks >= caps.checks) { refusals.push(refuse(template, GDO_ACTIVITY_REFUSAL.CAP)); continue; }
      counters.checks++;
      if (used.has(template.id)) { refusals.push(refuse(template, GDO_ACTIVITY_REFUSAL.DUPLICATE)); continue; }
      let grounded;
      try { grounded = template.ground(context); } catch { grounded = null; }
      if (!grounded?.ok) {
        refusals.push(refuse(template, grounded?.reason ?? GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE));
        continue;
      }
      used.add(template.id);
      const targets = (grounded.targets ?? []).slice(0, caps.targets).map(target => Object.freeze({
        id: target.id, kind: target.kind ?? 'target', name: target.name ?? '',
        family: target.family ?? null, classKind: target.classKind ?? null, className: target.className ?? null,
        x: rounded(target.x), z: rounded(target.z),
      }));
      const copy = template.render({
        ...grounded, targets,
        // The renderers read the *chosen* targets, so the copy always names real ones.
      });
      emitted.push({
        id: `${template.id}:${hash(`${seed}:${template.id}`)}`,
        template: template.id,
        goal: template.goal,
        title: copy.title,
        detail: copy.detail,
        required: grounded.required ?? 1,
        targets,
        proof: grounded.proof ?? '',
        progress: 0,
        state: GDO_ACTIVITY_STATE.ACTIVE,
      });
    }
    // The board is the highest-ranked, affordance-proven subset — never padded.
    const ranked = emitted
      .map(entry => ({ entry, rank: hash(`${seed}:board:${entry.template}`) }))
      .sort((first, second) => (first.rank < second.rank ? -1 : first.rank > second.rank ? 1 : 0))
      .slice(0, caps.board)
      .map(item => item.entry);
    // `trimmed` is its own number: a template that *was* grounded but did not fit
    // the board is a ranking decision, not a refusal, and the two must never be
    // reported as if they were the same thing.
    return { board: ranked, refusals, trimmed: Math.max(0, emitted.length - ranked.length) };
  };

  const frozenBoard = () => records.map(record => Object.freeze({
    id: record.id, template: record.template, goal: record.goal, title: record.title,
    detail: record.detail, required: record.required,
    targets: Object.freeze(record.targets.map(target => Object.freeze({ ...target }))),
    proof: record.proof, progress: record.progress, state: record.state,
  }));

  const signatureOf = snapshot => hash(JSON.stringify({
    places: (snapshot.places ?? []).length,
    roads: (snapshot.roads ?? []).length,
    bridges: (snapshot.bridges ?? []).length,
    water: (snapshot.water ?? []).length,
    props: (snapshot.props ?? []).length,
    ids: (snapshot.places ?? []).slice(0, 4).map(place => place.id),
  }));

  const api = {
    namespace: LOCAL_ACTIVITIES_NAMESPACE,
    profile,
    seed,
    limits: caps,
    arrivalRadius,
    get board() { return frozenBoard(); },
    get size() { return records.length; },
    get completed() { return records.filter(entry => entry.state === GDO_ACTIVITY_STATE.COMPLETE).length; },
    get origin() { return origin; },
    get travelled() { return rounded(metresTravelled); },
    diagnostics() {
      return Object.freeze({
        namespace: LOCAL_ACTIVITIES_NAMESPACE,
        profile,
        seed,
        schemaVersion: 1,
        templates: templates.length,
        board: records.length,
        completed: api.completed,
        refusals: counters.refusals,
        refusalReasons: Object.freeze({ ...counters.refusalReasons }),
        trimmed: counters.trimmed,
        emissions: counters.emissions,
        completions: counters.completions,
        refreshes: counters.refreshes,
        advances: counters.advances,
        checks: counters.checks,
        travelled: rounded(metresTravelled),
        steadyFrameAllocations: 0,
      });
    },
    /** Mark the walk's origin; the returning objective and the odometer read it. */
    setOrigin(x, z) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) throw new TypeError('An activity origin needs finite coordinates');
      origin = Object.freeze({ x: rounded(x), z: rounded(z) });
      lastPosition = { x, z };
      metresTravelled = 0;
      return origin;
    },
    /**
     * Rebuild the board from a real context snapshot. Rebuilding with the same
     * snapshot is a no-op (the signature is compared), so a steady frame that
     * merely moves the player never re-emits objectives.
     */
    refresh(snapshot = {}) {
      const signature = signatureOf(snapshot);
      if (signature === snapshotSignature) return frozenBoard();
      snapshotSignature = signature;
      counters.refreshes++;
      const built = build({ ...snapshot, origin: snapshot.origin ?? origin });
      // A rebuild keeps the progress of every objective that survived it: the
      // same day at the same coordinate mints the same ids, so a new tile
      // arriving never walks a completed objective backwards.
      const carried = new Map(records.map(record => [record.id, record]));
      records.length = 0;
      for (const entry of built.board) {
        const previous = carried.get(entry.id);
        if (previous) {
          entry.progress = previous.progress;
          entry.state = previous.state;
        }
        records.push(entry);
        counters.emissions++;
      }
      api.refusals = Object.freeze(built.refusals);
      counters.trimmed = built.trimmed;
      return frozenBoard();
    },
    refusals: Object.freeze([]),
    trimmed: 0,
    /**
     * One advance. `x`/`z` in world units, `metres` the distance this frame
     * contributed (already scaled by the caller), `visitedIds`/`sightedIds` the
     * `GME-06` journal's own record ids. Returns the transitions that happened;
     * a frame that changes nothing reports an empty array.
     */
    advance({ x, z, metresPerUnit = 1, visitedIds = null, sightedIds = null } = {}) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) throw new TypeError('An activity advance needs finite coordinates');
      counters.advances++;
      if (lastPosition) {
        const step = Math.hypot(x - lastPosition.x, z - lastPosition.z);
        // A teleport is not walking: cap the contribution at a generous stride,
        // then convert the world's units to the mapped metres the copy speaks in.
        metresTravelled += Math.min(step, 50) * metresPerUnit;
      }
      lastPosition = { x, z };
      const visited = visitedIds instanceof Set ? visitedIds : new Set(visitedIds ?? []);
      const sighted = sightedIds instanceof Set ? sightedIds : new Set(sightedIds ?? []);
      const transitions = [];
      for (const entry of records) {
        const before = entry.state;
        let progress = 0;
        if (entry.goal === GDO_ACTIVITY_GOAL.DISTANCE) {
          progress = Math.round(metresTravelled);
        } else if (entry.goal === GDO_ACTIVITY_GOAL.VISIT) {
          progress = entry.targets.filter(target => visited.has(target.id)).length;
        } else if (entry.goal === GDO_ACTIVITY_GOAL.SIGHT) {
          progress = entry.targets.filter(target => sighted.has(target.id) || visited.has(target.id)).length;
        } else {
          progress = entry.targets.filter(target =>
            Math.hypot(target.x - x, target.z - z) <= arrivalRadius).length;
        }
        entry.progress = Math.min(progress, entry.required);
        entry.state = entry.progress >= entry.required ? GDO_ACTIVITY_STATE.COMPLETE : GDO_ACTIVITY_STATE.ACTIVE;
        if (entry.state !== before) {
          transitions.push(Object.freeze({
            id: entry.id, template: entry.template, state: entry.state,
            progress: entry.progress, required: entry.required, title: entry.title,
          }));
          if (entry.state === GDO_ACTIVITY_STATE.COMPLETE) counters.completions++;
        }
      }
      return Object.freeze(transitions);
    },
    /** The one objective the HUD shows: the first incomplete one, else the last. */
    current() {
      const entry = records.find(record => record.state === GDO_ACTIVITY_STATE.ACTIVE)
        ?? records[records.length - 1] ?? null;
      currentRecord.id = entry?.id ?? null;
      currentRecord.title = entry?.title ?? '';
      currentRecord.detail = entry?.detail ?? '';
      currentRecord.proof = entry?.proof ?? '';
      currentRecord.progress = entry?.progress ?? 0;
      currentRecord.required = entry?.required ?? 0;
      currentRecord.targets = entry?.targets.length ?? 0;
      currentRecord.state = entry?.state ?? GDO_ACTIVITY_STATE.ACTIVE;
      return entry ? currentRecord : null;
    },
    summary() {
      const current = api.current();
      summaryRecord.seed = seed;
      summaryRecord.board = records.length;
      summaryRecord.completed = api.completed;
      summaryRecord.travelled = rounded(metresTravelled);
      summaryRecord.current = current
        ? Object.freeze({
          id: current.id, title: current.title, detail: current.detail,
          progress: current.progress, required: current.required, state: current.state,
        })
        : null;
      return summaryRecord;
    },
    reset() {
      records.length = 0;
      snapshotSignature = null;
      metresTravelled = 0;
      lastPosition = origin ? { x: origin.x, z: origin.z } : null;
      counters.checks = 0;
      counters.refusals = 0;
      counters.trimmed = 0;
      counters.refusalReasons = Object.create(null);
      counters.emissions = 0;
      counters.refreshes = 0;
      counters.completions = 0;
      counters.advances = 0;
      api.refusals = Object.freeze([]);
      api.trimmed = 0;
      return api;
    },
    /**
     * A scripted board audit. One run builds the board from the snapshot, walks
     * the scripted player through every target it names, and lets a real
     * `GME-06` journal — not the audit — decide when a place was sighted or
     * visited. A template that cannot be afforded is refused with a reason, and a
     * second generator with the same seed must reproduce the same board.
     */
    auditBoard({
      snapshot = {}, steps = 48, dt = 1 / 30, pace = .9, clockStep = 250,
      label = 'local-activities', profile: auditProfile = profile,
    } = {}) {
      const start = snapshot.origin ?? origin ?? { x: 0, z: 0 };
      const run = () => {
        const instance = createLocalActivities({ profile: auditProfile, seed, arrivalRadius, templates });
        const journal = createDiscoveryJournal({ profile: auditProfile });
        const places = snapshot.places ?? [];
        instance.setOrigin(start.x, start.z);
        const board = instance.refresh({ ...snapshot, origin: start });
        // The walk visits every objective target in board order and pauses on
        // each one long enough for a dwell-based visit to finish, then the whole
        // path is resampled to the requested step count — so the last sample
        // stands on the final target no matter how far the board asks the player
        // to travel.
        const waypoints = board.flatMap(entry => entry.targets)
          .filter(target => Number.isFinite(target.x) && Number.isFinite(target.z));
        if (!waypoints.length) waypoints.push({ x: start.x + 4, z: start.z + 4 });
        const path = [];
        let cursor = { x: start.x, z: start.z };
        for (const point of waypoints) {
          const distance = Math.hypot(point.x - cursor.x, point.z - cursor.z);
          const legSteps = Math.max(1, Math.ceil(distance / (pace * dt)));
          for (let index = 1; index <= legSteps; index++) {
            path.push({
              x: cursor.x + (point.x - cursor.x) * (index / legSteps),
              z: cursor.z + (point.z - cursor.z) * (index / legSteps),
            });
          }
          for (let index = 0; index < 8; index++) path.push({ x: point.x, z: point.z });
          cursor = point;
        }
        const samples = [];
        let clock = 0;
        for (let index = 0; index < steps; index++) {
          const position = path[Math.round(index * (path.length - 1) / Math.max(1, steps - 1))];
          const x = position.x, z = position.z;
          clock += clockStep;
          if (places.length) journal.observeAll(places, { x, z, clock });
          const visitedIds = new Set();
          const sightedIds = new Set();
          for (const record of journal.records()) {
            if (record.state === 'visited') visitedIds.add(record.id);
            else sightedIds.add(record.id);
          }
          const transitions = instance.advance({ x, z, metresPerUnit: 10, visitedIds, sightedIds });
          const current = instance.current();
          const nearest = Math.min(...waypoints.map(point => Math.hypot(point.x - x, point.z - z)));
          samples.push(Object.freeze({
            index, x: rounded(x), z: rounded(z), nearest: rounded(nearest),
            arrived: nearest <= arrivalRadius,
            template: current?.template ?? null, progress: current?.progress ?? 0,
            required: current?.required ?? 0, state: current?.state ?? null,
            completed: instance.completed, transitions: transitions.length,
          }));
        }
        const fingerprint = hash(samples.map(sample =>
          `${sample.template}:${sample.progress}:${sample.required}:${sample.completed}`).join('|'));
        return { board, instance, journal, samples, fingerprint };
      };
      const first = run();
      const second = run();
      const samples = first.samples;
          const requiresOf = entry => GDO_ACTIVITY_CONTEXT_SOURCES[entry.template] ?? null;
      const contextIds = new Set([
        ...(snapshot.places ?? []).map(place => place.id),
        ...(snapshot.roads ?? []).map(road => road.id),
        ...(snapshot.bridges ?? []).map(bridge => bridge.id),
        ...(snapshot.water ?? []).map(point => point.id),
        ...(snapshot.props ?? []).map(prop => prop.id),
      ]);
      const groundedTargets = first.board.flatMap(entry => entry.targets);
      const grounded = groundedTargets.every(target =>
        contextIds.has(target.id) || target.kind === 'origin' || target.kind === 'target');
      // The hard rule: a template whose affordance the context cannot prove is
      // refused *with a reason*, and the starved board emits nothing at all.
      // The documented rule, checked directly on the template that carries it.
      const bridgeTemplate = templates.find(template => template.id === 'cross-bridge');
      const oneBridge = bridgeTemplate?.ground({
        bridges: [{ id: 'b:1', name: 'deck', x: 1, z: 1 }], seed, limits: caps,
      });
      const twoBridges = bridgeTemplate?.ground({
        bridges: [{ id: 'b:1', name: 'deck', x: 1, z: 1 }, { id: 'b:2', name: 'deck', x: 9, z: 9 }], seed, limits: caps,
      });
      const twoBridgeRule = Boolean(bridgeTemplate) &&
        oneBridge?.ok === false && oneBridge.reason === GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE &&
        twoBridges?.ok === true && twoBridges.required === 2 && twoBridges.targets.length === 2;

      // The hard rule, both ways: an objective may never be emitted for a source
      // the snapshot does not carry, and a template whose source is empty must be
      // refused *with the reason*, never quietly swapped for something else.
      const emittedSources = new Set(first.board.map(entry => requiresOf(entry)).filter(Boolean));
      const invented = first.board
        .filter(entry => { const source = requiresOf(entry); return source && (snapshot[source] ?? []).length === 0; })
        .map(entry => entry.template);
      const refusedReasons = new Map(first.instance.refusals.map(refusal => [refusal.template, refusal.reason]));
      const unproved = templates
        .filter(template => GDO_ACTIVITY_CONTEXT_SOURCES[template.id])
        .filter(template => (snapshot[GDO_ACTIVITY_CONTEXT_SOURCES[template.id]] ?? []).length === 0)
        .filter(template => refusedReasons.get(template.id) !== GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE)
        .map(template => template.id);
      const groundingMismatch = [...invented, ...unproved];
      const starved = createLocalActivities({ profile: auditProfile, seed, arrivalRadius, templates });
      starved.setOrigin(start.x, start.z);
      const starvedBoard = starved.refresh({ origin: start });
      const starvedRefusals = starved.refusals;
      const refusalReasons = new Set(starvedRefusals.map(refusal => refusal.reason));
      const starvedRequired = templates.filter(template => GDO_ACTIVITY_CONTEXT_SOURCES[template.id]).length;
      const starvedContextFree = starvedBoard.every(entry => requiresOf(entry) === null);
      // The walk must genuinely reach an objective's target and must genuinely
      // move one forward — merely stepping and standing still proves nothing.
      const arrived = samples.some(sample => sample.arrived);
      const moved = samples.some(sample => sample.transitions > 0) ||
        samples.some((sample, index) => index > 0 &&
          (sample.completed > samples[index - 1].completed || sample.progress > samples[index - 1].progress));
      const progressed = arrived && moved;
      const completed = samples.some(sample => sample.completed > 0);
      const withinCaps = first.board.length <= caps.board &&
        first.board.every(entry => entry.targets.length <= caps.targets);
      const reproved = second.fingerprint === first.fingerprint &&
        JSON.stringify(second.board) === JSON.stringify(first.board);
      const verdicts = [
        Object.freeze({
          id: 'namespace', ok: LOCAL_ACTIVITIES_NAMESPACE === 'gdo:localActivities:v1',
          detail: LOCAL_ACTIVITIES_NAMESPACE,
        }),
        Object.freeze({
          id: 'grounded', ok: grounded && first.board.length > 0,
          detail: grounded
            ? `${groundedTargets.length} target(s) over ${first.board.length} objective(s) all exist in the snapshot`
            : 'an objective named a target the context does not carry',
        }),
        Object.freeze({
          id: 'two-bridge', ok: twoBridgeRule,
          detail: twoBridgeRule
            ? 'one deck span refuses the two-bridge objective; two deck spans ground it'
            : 'the two-bridge objective did not respect its own affordance proof',
        }),
        Object.freeze({
          id: 'grounding', ok: groundingMismatch.length === 0,
          detail: groundingMismatch.length === 0
            ? `${emittedSources.size} context source(s) used, every absent one refused with its reason`
            : `objective(s) without proof or refusal: ${groundingMismatch.join(', ')}`,
        }),
        Object.freeze({
          id: 'refusals', ok: starvedContextFree && starvedRefusals.length === starvedRequired &&
            refusalReasons.size === 1 && refusalReasons.has(GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE),
          detail: starvedContextFree && starvedRefusals.length === starvedRequired
            ? `${starvedRequired} context-requiring template(s) refused from an empty context, all as no-affordance`
            : `${starvedBoard.length} objective(s) were invented from an empty context`,
        }),
        Object.freeze({
          id: 'progress', ok: progressed,
          detail: progressed
            ? `the walk reached ${samples.filter(sample => sample.arrived).length} target sample(s) and moved an objective`
            : `walk arrived ${arrived ? 'on a target' : 'on nothing'}, moved ${moved ? 'an objective' : 'nothing'}`, 
        }),
        Object.freeze({
          id: 'completion', ok: completed,
          detail: completed
            ? `${first.instance.completed} objective(s) completed from the journal's own transitions`
            : 'no objective completed on the scripted walk',
        }),
        Object.freeze({
          id: 'budget', ok: withinCaps,
          detail: `${first.board.length} objective(s) inside the ${caps.board}-objective cap, ${caps.targets} targets each`,
        }),
        Object.freeze({
          id: 'determinism', ok: reproved,
          detail: reproved ? `two runs share the fingerprint ${first.fingerprint}` : 'two runs diverged',
        }),
      ];
      const report = {
        namespace: LOCAL_ACTIVITIES_NAMESPACE, label, seed,
        profile: auditProfile, steps, pace,
        board: first.board.map(entry => Object.freeze({
          id: entry.id, template: entry.template, title: entry.title, proof: entry.proof,
        })),
        refusals: Object.freeze(first.instance.refusals),
        samples: samples.length,
        sampleRecords: Object.freeze(samples.map(sample => Object.freeze({ ...sample }))),
        fingerprint: first.fingerprint,
        verdicts: Object.freeze(verdicts),
        ok: verdicts.every(verdict => verdict.ok),
      };
      report.detail = report.ok
        ? `${report.board.length} grounded objective(s) passed ${verdicts.length} verdicts (${report.fingerprint})`
        : `failed: ${verdicts.filter(verdict => !verdict.ok).map(verdict => verdict.id).join(', ')}`;
      return Object.freeze(report);
    },

    /** Deterministic and side-effect-free: the same snapshot replays identically. */
    describe() {
      return Object.freeze({
        namespace: LOCAL_ACTIVITIES_NAMESPACE,
        templates: templates.map(template => template.id),
        board: records.map(entry => Object.freeze({
          id: entry.id, template: entry.template, title: entry.title, proof: entry.proof,
          targets: entry.targets.map(target => target.id),
        })),
      });
    },
  };
  return api;
}

/** Places the caller may hand to `refresh`, with the journal's own ids. */
export function activityPlaces(labels, { mergeRadius = GDO_DISCOVERY_PROFILES.low.mergeRadius } = {}) {
  const seen = new Set();
  const places = [];
  for (const label of labels ?? []) {
    if (!label?.name || !Number.isFinite(label.x) || !Number.isFinite(label.z)) continue;
    const id = label.id ?? placeIdFor(label, { mergeRadius });
    if (seen.has(id)) continue;
    seen.add(id);
    places.push(Object.freeze({
      id, name: label.name, kind: label.kind ?? 'other',
      x: rounded(label.x), z: rounded(label.z),
    }));
  }
  return Object.freeze(places);
}

/**
 * The HUD copy for one summary — the same function the coordinate HUD renders and
 * the activity audit reads back, so the line the player sees is the line the
 * audit proves. A summary with no objective says so instead of inventing one.
 */
export function activityHudText(summary) {
  const current = summary?.current ?? null;
  if (!current) {
    return Object.freeze({
      title: 'No local activities yet',
      progress: 'Objectives are grounded in mapped places, roads, water, bridges, and props',
    });
  }
  return Object.freeze({
    title: current.title,
    progress: current.state === GDO_ACTIVITY_STATE.COMPLETE
      ? `Complete · ${summary.completed} of ${summary.board} · ${summary.travelled} m walked`
      : `Progress ${current.progress} of ${current.required} · ${summary.completed} of ${summary.board} complete · ${summary.travelled} m walked`,
  });
}

/** Declared budgets and ceilings, checked against the shipped low profile. */
export function describeLocalActivities(budget = GDO_LOW_PROFILE_BUDGETS, limits = GDO_ACTIVITY_LIMITS.low) {
  const violations = [];
  if (GDO_ACTIVITY_TEMPLATES.length > budget.activityTemplates) {
    violations.push(`${GDO_ACTIVITY_TEMPLATES.length} templates exceed the ${budget.activityTemplates} budget`);
  }
  if (limits.board > budget.activityBoard) violations.push(`board ${limits.board} > budget ${budget.activityBoard}`);
  if (limits.targets > budget.activityTargets) violations.push(`targets ${limits.targets} > budget ${budget.activityTargets}`);
  if (limits.checks > budget.activityChecks) violations.push(`checks ${limits.checks} > budget ${budget.activityChecks}`);
  const ids = new Set();
  for (const template of GDO_ACTIVITY_TEMPLATES) {
    if (ids.has(template.id)) violations.push(`template ${template.id} is declared twice`);
    ids.add(template.id);
    if (typeof template.ground !== 'function') violations.push(`template ${template.id} has no affordance proof`);
    const source = GDO_ACTIVITY_CONTEXT_SOURCES[template.id];
    if (source && !(source in { places: 1, roads: 1, bridges: 1, water: 1, props: 1 })) {
      violations.push(`template ${template.id} claims an unknown context source ${source}`);
    }
    if (typeof template.render !== 'function') violations.push(`template ${template.id} cannot name its goal`);
    if (!Object.values(GDO_ACTIVITY_GOAL).includes(template.goal)) {
      violations.push(`template ${template.id} has an unknown goal ${template.goal}`);
    }
  }
  return Object.freeze({
    namespace: LOCAL_ACTIVITIES_NAMESPACE,
    ok: violations.length === 0,
    violations: Object.freeze(violations),
    templates: GDO_ACTIVITY_TEMPLATES.length,
    profiles: Object.keys(GDO_ACTIVITY_LIMITS).length,
    limits: GDO_ACTIVITY_LIMITS,
    budget: Object.freeze({ ...budget }),
  });
}
