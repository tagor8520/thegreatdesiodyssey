import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_ACTIVITY_CONTEXT_SOURCES, GDO_ACTIVITY_LIMITS, GDO_ACTIVITY_REFUSAL, GDO_ACTIVITY_STATE,
  GDO_ACTIVITY_TEMPLATES, LOCAL_ACTIVITIES_NAMESPACE,
  activityDateKey, activityHudText, activityPlaces, activitySeedFor,
  createLocalActivities, describeLocalActivities,
} from './LocalActivities.js';
import { GDO_FEATURE_VERSIONS } from './FeatureVersions.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

/**
 * `GME-08` gate, engine side: an objective may only be emitted once the context
 * proves the affordance it names, the board is a deterministic function of the
 * date and the coordinate, and progress is driven by the `GME-06` journal's own
 * records rather than by the audit's opinion.
 */

const CONTEXT = Object.freeze({
  origin: Object.freeze({ x: 0, z: 0 }),
  places: Object.freeze([
    Object.freeze({ id: 'place:market@0:0-1', name: 'Sabzi Mandi', kind: 'place', x: 4, z: 1 }),
    Object.freeze({ id: 'place:temple@0:0-2', name: 'Old Temple', kind: 'poi', x: 2, z: 6 }),
    Object.freeze({ id: 'place:school@0:0-3', name: 'Primary School', kind: 'poi', x: 9, z: 3 }),
  ]),
  roads: Object.freeze([
    Object.freeze({ id: 'road:1', name: 'Mandi Lane', kind: 'road', x: 3, z: 0 }),
    Object.freeze({ id: 'road:2', name: 'Grid Road 2', kind: 'road', x: 0, z: 3 }),
  ]),
  bridges: Object.freeze([
    Object.freeze({ id: 'tile:0:0:0', name: 'the elevated deck', kind: 'bridge', x: 5, z: 5 }),
    Object.freeze({ id: 'tile:0:0:1', name: 'the elevated deck', kind: 'bridge', x: 7, z: 2 }),
  ]),
  water: Object.freeze([
    Object.freeze({ id: 'tile:0:0:water:0:0', name: 'river', kind: 'water', classKind: 'river', className: 'river', x: 6, z: 4 }),
  ]),
  props: Object.freeze([
    Object.freeze({ id: 'tile:0:0:prop:0', name: 'chai-stall', kind: 'prop', family: 'chai-stall', x: 1, z: 2 }),
  ]),
});

test('GME-08 the board is emitted only from the context it was grounded in', () => {
  const activities = createLocalActivities({ profile: 'low', seed: activitySeedFor({ worldVersion: 1, latitude: 28.9845, longitude: 77.7064, dateKey: '2026-09-29' }) });
  const board = activities.refresh(CONTEXT);
  assert.ok(board.length > 0, 'the fixture context grounds at least one objective');
  assert.ok(board.length <= GDO_LOW_PROFILE_BUDGETS.activityBoard);
  const ids = new Set([...CONTEXT.places, ...CONTEXT.roads, ...CONTEXT.bridges, ...CONTEXT.water, ...CONTEXT.props].map(entry => entry.id));
  for (const entry of board) {
    for (const target of entry.targets) {
      // A self-referential objective names the walk start, which the context is.
      if (target.id === 'origin') continue;
      assert.ok(ids.has(target.id), `${entry.template} names ${target.id}, which the context carries`);
    }
    assert.ok(entry.proof.length > 0, `${entry.template} states what proved it`);
    assert.equal(entry.state, GDO_ACTIVITY_STATE.ACTIVE);
  }
});

test('GME-08 a template whose affordance is missing is refused with a reason, never invented', () => {
  const activities = createLocalActivities({ profile: 'low', seed: 'a1b2c3d4' });
  activities.refresh({ ...CONTEXT, bridges: [], water: [], props: [] });
  const refused = new Map(activities.refusals.map(refusal => [refusal.template, refusal.reason]));
  assert.equal(refused.get('cross-bridge'), GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE);
  assert.equal(refused.get('reach-water'), GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE);
  assert.equal(refused.get('find-stall'), GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE);
  assert.equal(activities.board.some(entry => GDO_ACTIVITY_CONTEXT_SOURCES[entry.template] === 'bridges'), false);
  assert.equal(activities.board.some(entry => GDO_ACTIVITY_CONTEXT_SOURCES[entry.template] === 'water'), false);

  // The documented rule in isolation: one bridge refuses, two bridges ground it.
  const bridgeTemplate = GDO_ACTIVITY_TEMPLATES.find(template => template.id === 'cross-bridge');
  const limits = GDO_ACTIVITY_LIMITS.low;
  assert.deepEqual(bridgeTemplate.ground({ bridges: [CONTEXT.bridges[0]], seed: 'x', limits }),
    { ok: false, reason: GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE });
  const grounded = bridgeTemplate.ground({ bridges: CONTEXT.bridges, seed: 'x', limits });
  assert.equal(grounded.ok, true);
  assert.equal(grounded.required, 2);
  assert.equal(grounded.targets.length, 2);
});

test('GME-08 the empty context emits only self-referential objectives', () => {
  const activities = createLocalActivities({ profile: 'low', seed: 'beef1234' });
  const board = activities.refresh({ origin: { x: 0, z: 0 } });
  const contextRequiring = GDO_ACTIVITY_TEMPLATES.filter(template => GDO_ACTIVITY_CONTEXT_SOURCES[template.id]);
  for (const entry of board) {
    assert.equal(GDO_ACTIVITY_CONTEXT_SOURCES[entry.template] ?? null, null,
      `${entry.template} needs no map affordance`);
  }
  assert.equal(activities.refusals.length, contextRequiring.length);
  assert.ok(activities.refusals.every(refusal => refusal.reason === GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE));
});

test('GME-08 the date plus the coordinate reproduces the board, and nothing else does', () => {
  const seed = activitySeedFor({ worldVersion: GDO_FEATURE_VERSIONS.localActivities, latitude: 28.9845, longitude: 77.7064, dateKey: '2026-09-29' });
  assert.equal(seed, activitySeedFor({ worldVersion: GDO_FEATURE_VERSIONS.localActivities, latitude: 28.9845, longitude: 77.7064, dateKey: '2026-09-29' }));
  assert.notEqual(seed, activitySeedFor({ worldVersion: GDO_FEATURE_VERSIONS.localActivities, latitude: 28.9845, longitude: 77.7064, dateKey: '2026-09-30' }));
  // The coordinate is quantized to ~100 m, so a different 3-decimal latitude is
  // still the same day's board; a different town is not.
  assert.equal(activitySeedFor({ worldVersion: 1, latitude: 28.98462, longitude: 77.7064, dateKey: '2026-09-29' }), seed);
  assert.notEqual(seed, activitySeedFor({ worldVersion: GDO_FEATURE_VERSIONS.localActivities, latitude: 28.994, longitude: 77.7064, dateKey: '2026-09-29' }));
  assert.equal(activityDateKey(Date.UTC(2026, 8, 29, 23, 30)), '2026-09-29');

  const first = createLocalActivities({ profile: 'low', seed });
  const second = createLocalActivities({ profile: 'low', seed });
  assert.deepEqual(first.refresh(CONTEXT).map(entry => entry.id), second.refresh(CONTEXT).map(entry => entry.id));
  const drifted = createLocalActivities({ profile: 'low', seed: activitySeedFor({ worldVersion: 1, latitude: 28.9845, longitude: 77.7064, dateKey: '2026-09-30' }) });
  drifted.refresh(CONTEXT);
  assert.notDeepEqual(first.refresh(CONTEXT).map(entry => entry.id), drifted.board.map(entry => entry.id));
});

test('GME-08 progress follows the journal records, the clock, and the real position', () => {
  const activities = createLocalActivities({
    profile: 'low', seed: 'cafe0123', arrivalRadius: 2,
    // Every groundable template on one board, so the test can name them.
    limits: { board: GDO_ACTIVITY_TEMPLATES.length, targets: 3, checks: 24, placeTargets: 2 },
  });
  activities.setOrigin(0, 0);
  const board = activities.refresh(CONTEXT);
  assert.ok(board.some(entry => entry.template === 'visit-places'), 'the visit objective is on the board');
  const target = board.flatMap(entry => entry.targets)[0];
  // A teleport is not walking: one huge jump cannot complete the odometer.
  activities.advance({ x: 90, z: 90, metresPerUnit: 10 });
  assert.ok(activities.travelled <= 500, `capped travel ${activities.travelled}`);
  activities.advance({ x: target.x, z: target.z, metresPerUnit: 10 });
  const nearTarget = activities.board.filter(entry => entry.targets.some(candidate =>
    Math.hypot(candidate.x - target.x, candidate.z - target.z) <= 1));
  assert.ok(nearTarget.length > 0, 'standing on a target touches the objective that names it');
  assert.ok(nearTarget.every(entry => entry.state === GDO_ACTIVITY_STATE.COMPLETE));
  // The visit objective answers the journal's own ids, not the position alone.
  const visited = new Set(CONTEXT.places.map(place => place.id));
  const transitions = activities.advance({ x: target.x, z: target.z, metresPerUnit: 10, visitedIds: visited });
  const board_ = activities.board;
  const visit = board_.find(entry => entry.template === 'visit-places');
  assert.equal(visit.state, GDO_ACTIVITY_STATE.COMPLETE, 'the visited places completed the visit objective');
  assert.ok(transitions.some(transition => transition.template === 'visit-places' && transition.state === 'complete'));
  assert.ok(board_.filter(entry => entry.state === GDO_ACTIVITY_STATE.COMPLETE).length > 0);
  assert.ok(board_.every(entry => entry.progress <= entry.required));
  const summary = activities.summary();
  assert.equal(summary.completed, board_.filter(entry => entry.state === GDO_ACTIVITY_STATE.COMPLETE).length);
  const hud = activityHudText(summary);
  assert.equal(hud.title, summary.current.title);
  assert.match(hud.progress, /Progress \d+ of \d+/);
});

test('GME-08 the board audit walks the objectives and passes its nine verdicts', () => {
  const activities = createLocalActivities({ profile: 'low', seed: 'f00dbabe' });
  const report = activities.auditBoard({ snapshot: CONTEXT, steps: 48 });
  assert.equal(report.ok, true, report.detail);
  assert.equal(report.verdicts.length, 9);
  assert.deepEqual(report.verdicts.map(verdict => verdict.id), [
    'namespace', 'grounded', 'two-bridge', 'grounding', 'refusals', 'progress', 'completion', 'budget', 'determinism',
  ]);
  assert.equal(report.samples, 48);
  assert.match(report.fingerprint, /^[0-9a-f]{8}$/);
  const [first, second] = [activities.auditBoard({ snapshot: CONTEXT }), activities.auditBoard({ snapshot: CONTEXT })];
  assert.equal(first.fingerprint, second.fingerprint);
});

test('GME-08 a steady frame re-uses the board and allocates nothing per refresh', () => {
  const activities = createLocalActivities({ profile: 'low', seed: 'deadbe11' });
  activities.setOrigin(0, 0);
  const board = activities.refresh(CONTEXT);
  const emissions = activities.diagnostics().emissions;
  const again = activities.refresh(CONTEXT);
  assert.deepEqual(again.map(entry => entry.id), board.map(entry => entry.id));
  assert.equal(again.every(entry => entry.state === GDO_ACTIVITY_STATE.ACTIVE), true);
  assert.equal(activities.diagnostics().emissions, emissions, 'a repeated snapshot emits nothing new');
  assert.equal(activities.diagnostics().checks, GDO_ACTIVITY_TEMPLATES.length);
  const current = activities.current();
  assert.equal(activities.current(), current, 'the HUD record is reused');
  assert.equal(activities.diagnostics().steadyFrameAllocations, 0);
  // A template that was grounded but did not fit the board is trimmed, not refused.
  assert.equal(activities.diagnostics().trimmed, GDO_ACTIVITY_TEMPLATES.length - activities.size - activities.refusals.length);
  assert.ok(activities.refusals.every(refusal => Object.values(GDO_ACTIVITY_REFUSAL).includes(refusal.reason)));
});

test('GME-08 the declared ceilings match the shipped low-profile budget', () => {
  const described = describeLocalActivities();
  assert.equal(described.ok, true, described.violations.join('; '));
  assert.equal(described.templates, GDO_ACTIVITY_TEMPLATES.length);
  assert.ok(GDO_ACTIVITY_TEMPLATES.length <= GDO_LOW_PROFILE_BUDGETS.activityTemplates);
  const low = GDO_ACTIVITY_LIMITS.low;
  assert.ok(low.board <= GDO_LOW_PROFILE_BUDGETS.activityBoard);
  assert.ok(low.targets <= GDO_LOW_PROFILE_BUDGETS.activityTargets);
  assert.ok(low.checks <= GDO_LOW_PROFILE_BUDGETS.activityChecks);
  // Higher profiles may spend more, never less.
  for (const limits of [GDO_ACTIVITY_LIMITS.balanced, GDO_ACTIVITY_LIMITS.high]) {
    assert.ok(limits.board >= low.board && limits.targets >= low.targets && limits.checks >= low.checks);
  }
  const withoutGround = GDO_ACTIVITY_TEMPLATES.map(template => ({ ...template, ground: undefined }));
  const broken = describeLocalActivities(GDO_LOW_PROFILE_BUDGETS, GDO_ACTIVITY_LIMITS.low);
  assert.equal(broken.ok, true, 'the shipped catalogue is complete');
  const crafted = createLocalActivities({ profile: 'low', seed: 'x', templates: withoutGround });
  crafted.refresh(CONTEXT);
  assert.equal(crafted.board.length, 0, 'a template without a proof cannot emit anything');
});

test('GME-08 place ids are the journal’s ids, so progress cannot drift from discovery', () => {
  const places = activityPlaces([
    { name: 'Sabzi Mandi', kind: 'place', x: 4, z: 1 },
    { name: 'Sabzi Mandi', kind: 'place', x: 4.2, z: 1.1 },
    { name: 'Sabzi Mandi', kind: 'place', x: 40, z: 1 },
    { name: '', kind: 'place', x: 1, z: 1 },
  ], { mergeRadius: 4 });
  assert.equal(places.length, 2, 'a name inside the merge radius is one place, a distant one is another');
  assert.ok(places.every(place => place.id.startsWith('place:sabzi-mandi@')));
  assert.equal(LOCAL_ACTIVITIES_NAMESPACE, 'gdo:localActivities:v1');
  assert.equal(GDO_FEATURE_VERSIONS.localActivities, 1);
});
