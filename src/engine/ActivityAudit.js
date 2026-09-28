/**
 * `GME-08` audit — the row's gate is "reproducible objectives from real
 * place/road/land context", and the research's hard rule is that a template may
 * only be emitted once the local context *proves* its affordance (a "cross two
 * bridges" objective after two reachable bridges exist) and that one date plus one
 * coordinate reproduces the same board.
 *
 * This is the scripted half of that proof: the runtime supplies a `step` that
 * walks the player and a `sample` that records the live numbers, and every verdict
 * here is computed from those records. The module holds no `three` and no DOM, so
 * the verdicts run against the coordinate world and against synthetic samples in
 * the unit tests alike.
 */

import { GDO_ACTIVITY_LIMITS, GDO_ACTIVITY_REFUSAL, GDO_ACTIVITY_TEMPLATES, LOCAL_ACTIVITIES_NAMESPACE } from './LocalActivities.js';

export const GDO_ACTIVITY_AUDIT_NAMESPACE = 'gdo:localActivityAudit:v1';

const AUDIT_FIELDS = Object.freeze([
  'board', 'completed', 'travelled', 'template', 'targets', 'title', 'progress', 'required',
  'state', 'unmatchedTargets', 'unprovedTemplates', 'refusals', 'refusalReasons',
  'steadyFrameAllocations', 'checks', 'bridges', 'hudTitle', 'hudTracksCurrent', 'seed',
]);

function fingerprint(samples) {
  let hash = 2166136261;
  for (const sample of samples) {
    for (const field of AUDIT_FIELDS) {
      const value = sample[field];
      const text = Array.isArray(value) ? value.join(',') : String(value);
      for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
    }
  }
  return hash.toString(16).padStart(8, '0');
}

const DECLARED_REFUSALS = new Set(Object.values(GDO_ACTIVITY_REFUSAL));

/**
 * Scripted activity audit. `step({ index, dt, samples })` advances the world one
 * frame; `sample(index)` returns the live record described by `AUDIT_FIELDS`.
 */
export function runActivityAudit({
  step,
  sample,
  reset = null,
  steps = 36,
  repeat = 2,
  dt = 1 / 30,
  caps = GDO_ACTIVITY_LIMITS.low,
  expect = null,
  label = 'coordinate-activities',
} = {}) {
  if (typeof step !== 'function' || typeof sample !== 'function') {
    throw new TypeError('runActivityAudit needs step(input) and sample(index) functions');
  }
  if (!Number.isFinite(steps) || steps < 2) throw new RangeError('Activity audit needs at least two steps');
  const runs = [];
  for (let pass = 0; pass < Math.max(1, repeat); pass++) {
    reset?.();
    const records = [];
    for (let index = 0; index < steps; index++) {
      step({ index, dt, pass });
      const record = sample(index, pass) ?? {};
      const missing = AUDIT_FIELDS.filter(field => record[field] === undefined);
      if (missing.length) throw new TypeError(`Activity sample ${index} is missing ${missing.join(', ')}`);
      records.push(Object.freeze({ index, ...record }));
    }
    runs.push(records);
  }
  const samples = runs[0];
  const record = (id, ok, detail) => Object.freeze({ id, ok: Boolean(ok), detail });
  const verdicts = [];
  const last = samples.at(-1);

  const withBoard = samples.filter(entry => entry.board > 0);
  verdicts.push(record('board-emitted', withBoard.length > 0,
    `${withBoard.length}/${samples.length} samples held a grounded objective board`));

  const unmatched = samples.reduce((total, entry) => total + (entry.unmatchedTargets ?? 0), 0);
  const unproved = [...new Set(samples.flatMap(entry => entry.unprovedTemplates ?? []))];
  verdicts.push(record('context-grounded', unmatched === 0 && unproved.length === 0,
    unmatched === 0 && unproved.length === 0
      ? 'every emitted objective names a target the resident context carries'
      : `${unmatched} unmatched target(s), unproved ${unproved.join('/')}`));

  const refusals = [...new Set(samples.flatMap(entry => entry.refusalReasons ?? []))];
  const unknown = refusals.filter(reason => !DECLARED_REFUSALS.has(reason));
  verdicts.push(record('refusals-named', refusals.length > 0 && unknown.length === 0,
    refusals.length
      ? `${refusals.length} declared refusal reason(s) used: ${refusals.join(', ')}`
      : 'the context never had to refuse anything'));

  // The documented rule, judged against the world's own bridges: while fewer than
  // two deck spans are resident the two-bridge template must refuse, and once two
  // are present the same template must ground a two-target objective.
  const bridgeTemplate = GDO_ACTIVITY_TEMPLATES.find(template => template.id === 'cross-bridge');
  const bridgeCount = last?.bridges ?? 0;
  const bridgePoints = last?.bridgePoints ?? [];
  const bridgeOutcome = bridgeTemplate?.ground({
    bridges: bridgePoints.slice(0, 2), seed: last?.seed ?? '00000000', limits: caps,
  });
  const bridgeObjectives = samples.reduce((total, entry) => total + (entry.bridgeObjectives ?? 0), 0);
  const bridgeRule = bridgeCount >= 2
    ? bridgeOutcome?.ok === true && bridgeOutcome.required === 2
    : (bridgeCount === 1 ? bridgeOutcome?.ok === false : bridgeObjectives === 0);
  verdicts.push(record('two-bridge', bridgeRule,
    bridgeCount >= 2
      ? `${bridgeCount} resident deck spans ground the two-bridge objective`
      : `${bridgeCount} resident deck span(s); the two-bridge objective is refused, not invented`));

  const progressed = samples.some((entry, index) => index > 0 &&
    (entry.completed > samples[index - 1].completed || entry.progress > samples[index - 1].progress));
  const completed = (last?.completed ?? 0) > 0;
  verdicts.push(record('progress', progressed || completed,
    `walk travelled ${last?.travelled ?? 0} m, ${last?.completed ?? 0} objective(s) complete`));
  verdicts.push(record('completion', completed,
    completed ? `${last?.completed} objective(s) completed on the scripted walk` : 'no objective completed'));

  const secondRun = runs[1] ?? runs[0];
  const boardShared = JSON.stringify(samples.map(entry => entry.template).filter(Boolean)) ===
    JSON.stringify(secondRun.map(entry => entry.template).filter(Boolean));
  const reproducible = boardShared && fingerprint(runs[0]) === fingerprint(secondRun) &&
    (!expect?.seed || samples.every(entry => entry.seed === expect.seed));
  verdicts.push(record('reproducible', reproducible,
    reproducible
      ? (expect?.seed
        ? `two passes from seed ${expect.seed} share the fingerprint ${fingerprint(samples)}`
        : `two passes share the fingerprint ${fingerprint(samples)}`)
      : 'two passes diverged'));

  const withinCaps = samples.every(entry => entry.board <= caps.board &&
    entry.targets <= caps.targets && entry.checks <= caps.checks &&
    (entry.steadyFrameAllocations ?? 0) === 0);
  verdicts.push(record('budget', withinCaps,
    `board ≤ ${caps.board}, targets ≤ ${caps.targets}, checks ≤ ${caps.checks}, ` +
    `worst steady-frame allocations ${Math.max(...samples.map(entry => entry.steadyFrameAllocations ?? 0))}`));

  const hudOk = samples.every(entry => entry.hudTracksCurrent === true && `${entry.hudTitle}`.length > 0);
  verdicts.push(record('hud', hudOk,
    hudOk ? 'the HUD line tracked the current objective for every sample' : 'the HUD line did not track the objective'));

  const failed = verdicts.filter(verdict => !verdict.ok);
  const report = {
    namespace: GDO_ACTIVITY_AUDIT_NAMESPACE,
    featureNamespace: LOCAL_ACTIVITIES_NAMESPACE,
    label,
    steps,
    dt,
    seed: last?.seed ?? null,
    bridges: bridgeCount,
    board: last?.board ?? 0,
    completed: last?.completed ?? 0,
    travelled: last?.travelled ?? 0,
    fingerprint: fingerprint(samples),
    samples: Object.freeze(samples.map(entry => Object.freeze({
      index: entry.index, template: entry.template, title: entry.title,
      progress: entry.progress, required: entry.required, state: entry.state,
      completed: entry.completed, travelled: entry.travelled,
    }))),
    verdicts: Object.freeze(verdicts),
    ok: failed.length === 0,
  };
  report.detail = report.ok
    ? `${samples.length} scripted samples passed ${verdicts.length} activity verdicts (${report.fingerprint})`
    : `failed: ${failed.map(verdict => verdict.id).join(', ')}`;
  return Object.freeze(report);
}

export function createActivityAuditRunner(options = {}) {
  let last = null;
  return {
    namespace: GDO_ACTIVITY_AUDIT_NAMESPACE,
    run(overrides = {}) {
      last = runActivityAudit({ ...options, ...overrides });
      return last;
    },
    get last() { return last; },
    get ok() { return last?.ok ?? null; },
    summary() {
      if (!last) return 'activity audit has not run';
      return `${last.namespace} ${last.ok ? 'pass' : 'fail'} (${last.fingerprint}) · ${last.detail}`;
    },
  };
}

/** Two runs at the same inputs must produce the same fingerprint. */
export function activityAuditDeterministic(first, second) {
  return Boolean(first && second) && first.fingerprint === second.fingerprint &&
    first.samples.length === second.samples.length && first.ok === second.ok;
}
