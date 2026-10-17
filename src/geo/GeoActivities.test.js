import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from './GeoWorld.js';
import { compileGeoFixture } from './GeoFixtures.js';
import { LifecycleLedger } from '../engine/LifecycleContract.js';
import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';
import { GDO_FEATURE_VERSIONS } from '../engine/FeatureVersions.js';
import {
  GDO_ACTIVITY_CONTEXT_SOURCES, GDO_ACTIVITY_LIMITS, GDO_ACTIVITY_REFUSAL,
  GDO_ACTIVITY_TEMPLATES, activityDateKey, activityHudText, activitySeedFor,
} from '../engine/LocalActivities.js';
import { activityAuditWalk, createActivityAuditRunner } from '../engine/ActivityAudit.js';

/**
 * `GME-08` gate, live: the coordinate world mounts a real fixture, grounds its
 * objectives in that fixture's own places, roads, water, decks, and props, walks
 * the scripted audit, and refuses — with a reason — anything the resident context
 * cannot prove.
 */

globalThis.Worker ??= class { addEventListener() {} postMessage() {} terminate() {} };

function mount(fixtureId = 'dense-urban', { profile = 'low', activityDate = null } = {}) {
  const scene = new THREE.Scene();
  const ledger = new LifecycleLedger({ label: `gme-08-${fixtureId}` });
  const world = new GeoWorld(scene, {
    latitude: 28.9845, longitude: 77.7064, ledger, profile, activityDate,
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

/** Drive the world the way a frame does, so the throttled activity pass runs. */
function drive(world, position, clock) {
  world.update(position, null, 720, clock);
  return world.activitySample(0);
}

test('GME-08 the world grounds its objectives in the fixture it mounted', () => {
  const { world, scene, ledger } = mount('dense-urban');
  try {
    const position = new THREE.Vector3(0, 1.7, 0);
    drive(world, position, 0);
    drive(world, position, 300);
    const sample = world.activitySample(0);
    assert.ok(sample.board >= 1, `the fixture grounded ${sample.board} objective(s)`);
    assert.ok(sample.board <= GDO_LOW_PROFILE_BUDGETS.activityBoard);
    assert.equal(sample.unmatchedTargets, 0, 'every objective target exists in the resident context');
    assert.deepEqual(sample.unprovedTemplates, [], 'no objective survived without its affordance');
    assert.equal(world.activities.namespace, 'gdo:localActivities:v1');
    // The seeded board is the documented function of version, coordinate, and day.
    assert.equal(world.activities.seed, activitySeedFor({
      worldVersion: GDO_FEATURE_VERSIONS.localActivities,
      latitude: 28.9845, longitude: 77.7064, dateKey: activityDateKey(),
    }));
    assert.ok(world.activityContextCounts.places >= 1, 'the fixture names real places');
    assert.equal(world.activityContextCounts.places, world.visibleLabels.length);
    assert.ok(world.activityContextCounts.roads >= 1, 'the objectives read the navigation graph roads');
    for (const entry of world.activities.board) {
      const source = GDO_ACTIVITY_CONTEXT_SOURCES[entry.template];
      if (!source) continue;
      assert.ok(world.activityContextCounts[source] > 0,
        `${entry.template} was only emitted because ${source} are resident`);
    }
    assert.ok(GDO_ACTIVITY_TEMPLATES.length <= GDO_LOW_PROFILE_BUDGETS.activityTemplates);
  } finally {
    world.dispose();
    ledger.disposeAll();
    scene.clear();
  }
});

test('GME-08 a fixture without two deck spans refuses the two-bridge objective', () => {
  const bridgeTemplate = GDO_ACTIVITY_TEMPLATES.find(template => template.id === 'cross-bridge');
  for (const fixtureId of ['dense-urban', 'sparse-rural', 'mountain-terrace']) {
    const { world, scene, ledger } = mount(fixtureId);
    try {
      drive(world, new THREE.Vector3(0, 1.7, 0), 0);
      drive(world, new THREE.Vector3(0, 1.7, 0), 300);
      const sample = world.activitySample(0);
      const grounded = bridgeTemplate.ground({
        bridges: sample.bridgePoints.slice(0, 2), seed: sample.seed, limits: GDO_ACTIVITY_LIMITS.low,
      });
      if (sample.bridges >= 2) {
        assert.equal(grounded.ok, true, `${fixtureId}: two deck spans ground the objective`);
        assert.equal(grounded.required, 2);
      } else {
        assert.equal(grounded.ok, false, `${fixtureId}: ${sample.bridges} deck span(s) cannot ground it`);
        assert.equal(grounded.reason, GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE);
        assert.equal(sample.bridgeObjectives, 0, `${fixtureId}: no bridge objective was invented`);
        assert.ok(sample.refusalReasons.includes(GDO_ACTIVITY_REFUSAL.NO_AFFORDANCE),
          `${fixtureId}: the refusal was recorded with its reason`);
      }
    } finally {
      world.dispose();
      ledger.disposeAll();
      scene.clear();
    }
  }
});

test('GME-08 the same coordinate and day reproduce the board, a different day does not', () => {
  const boards = [];
  for (const pass of [0, 1]) {
    const { world, scene, ledger } = mount('dense-urban');
    try {
      drive(world, new THREE.Vector3(0, 1.7, 0), 0);
      drive(world, new THREE.Vector3(0, 1.7, 0), 300);
      boards.push({
        seed: world.activities.seed,
        ids: world.activities.board.map(entry => entry.id),
        describe: JSON.stringify(world.activities.describe()),
        pass,
      });
    } finally {
      world.dispose();
      ledger.disposeAll();
      scene.clear();
    }
  }
  assert.equal(boards[0].seed, boards[1].seed);
  assert.deepEqual(boards[0].ids, boards[1].ids, 'the same day at the same coordinate repeats the board');
  assert.equal(boards[0].describe, boards[1].describe, 'titles, proofs, and targets repeat too');

  // Another day is another board. Both sides of the comparison are *explicit*
  // dates: comparing a fixed date against the live "today" made this check pass
  // or fail by calendar — on the day the hardcoded date really is today, the
  // world under test and the fixture agree and the assertion is vacuous.
  const days = [];
  for (const activityDate of ['2026-09-30', '2026-01-15']) {
    const { world, scene, ledger } = mount('dense-urban', { activityDate });
    try {
      drive(world, new THREE.Vector3(0, 1.7, 0), 0);
      drive(world, new THREE.Vector3(0, 1.7, 0), 300);
      days.push({
        seed: world.activities.seed,
        expected: activitySeedFor({
          worldVersion: GDO_FEATURE_VERSIONS.localActivities,
          latitude: 28.9845, longitude: 77.7064, dateKey: activityDate,
        }),
        ids: world.activities.board.map(entry => entry.id),
      });
    } finally {
      world.dispose();
      ledger.disposeAll();
      scene.clear();
    }
  }
  assert.equal(days[0].seed, days[0].expected, 'the declared date seeds the declared board');
  assert.notEqual(days[0].seed, days[1].seed, 'another day seeds another board');
  // The default world is seeded from the live UTC day, which the earlier test
  // already proved; here it only has to differ from an explicit other day.
  assert.notEqual(days[0].seed, days[1].seed);
});

test('GME-08 objectives advance from the player position and the discovery journal', () => {
  const { world, scene, ledger } = mount('dense-urban');
  try {
    const position = new THREE.Vector3(0, 1.7, 0);
    drive(world, position, 0);
    drive(world, position, 300);
    const current = world.activities.current();
    assert.ok(current, 'the board has a current objective');
    // The board is date-seeded, so the first entry is not always the active one —
    // and `return-home` legitimately targets the origin the player already stands
    // on. Walk to the active objective's own mapped target instead, so the
    // odometer assertion measures the same thing whatever day the suite runs.
    const active = world.activities.board.find(entry => entry.id === current.id);
    const target = active?.targets.find(entry => entry.kind !== 'origin') ?? active?.targets[0] ?? null;
    assert.deepEqual(world.activities.currentTargets(), active?.targets ?? [], 'the accessor serves the live targets');
    // A context-requiring objective must name a target the context carries; a
    // self-referential one (`walk-distance`) declares its own goal and names none,
    // which is why this assertion is conditional rather than universal.
    if (GDO_ACTIVITY_CONTEXT_SOURCES[current.template]) {
      assert.ok(target, `the context-grounded objective ${current.template} names at least one target`);
    }
    // Walk the objective the way the shared planner walks it, over a few frames.
    let clock = 600;
    for (let index = 0; index < 12; index++) {
      const next = activityAuditWalk({
        x: position.x, z: position.z, objective: current,
        targets: world.activities.currentTargets(), index, dt: 1 / 30,
      });
      position.set(next.x, position.y, next.z);
      clock += 300;
      world.update(position, null, 720, clock);
    }
    const sample = world.activitySample(0);
    assert.equal(sample.unmatchedTargets, 0);
    assert.ok(sample.travelled > 0, `the odometer recorded ${sample.travelled} m`);
    assert.ok(sample.completed >= 0);
    const summary = world.activities.summary();
    assert.equal(summary.board, world.activities.size);
    const hud = activityHudText(summary);
    assert.ok(hud.title.length > 0 && hud.progress.length > 0);
    if (summary.current) assert.equal(hud.title, summary.current.title);
  } finally {
    world.dispose();
    ledger.disposeAll();
    scene.clear();
  }
});

test('GME-08 the scripted activity audit passes against the live world', () => {
  const { world, scene, ledger } = mount('dense-urban');
  try {
    const camera = new THREE.PerspectiveCamera(68, 16 / 9, .02, 210);
    const position = new THREE.Vector3(0, 1.7, 0);
    let clock = 0;
    const audit = createActivityAuditRunner({
      label: 'coordinate-activities',
      reset: () => {
        // An audit run must be independent of the previous one: the clock, the
        // board, the throttle, and the journal all return to their start state.
        clock = 0;
        world.activityOriginSet = false;
        world.nextActivityPassMilliseconds = 0;
        world.nextDiscoveryPassMilliseconds = 0;
        world.discoveryJournal?.reset?.();
        world.activities.reset();
        position.set(0, 1.7, 0);
      },
      step: ({ index, dt }) => {
        clock += dt * 1000;
        // The engine's own planner, so the test drives the scripted walk the live
        // host drives — including the leg a self-referential objective needs.
        const next = activityAuditWalk({
          x: position.x, z: position.z,
          objective: world.activities.current(),
          targets: world.activities.currentTargets(),
          index, dt,
        });
        position.set(next.x, 1.7, next.z);
        world.update(position, camera, 720, clock);
      },
      sample: index => {
        const record = world.activitySample(index);
        const summary = world.activities.summary();
        const hud = activityHudText(summary);
        return {
          ...record,
          // The HUD text the coordinate HUD renders is this formatter's output, so
          // the audit proves the same string the player reads.
          hudTitle: hud.title,
          hudProgress: hud.progress,
          hudTracksCurrent: hud.title.length > 0 && hud.progress.length > 0,
        };
      },
    });
    const report = audit.run({ steps: 36, repeat: 2 });
    assert.equal(report.ok, true, `${report.detail} :: ${report.verdicts.filter(v => !v.ok).map(v => `${v.id} (${v.detail})`).join('; ')}`);
    assert.equal(report.verdicts.length, 9);
    assert.deepEqual(report.verdicts.map(verdict => verdict.id), [
      'board-emitted', 'context-grounded', 'refusals-named', 'two-bridge', 'progress',
      'completion', 'reproducible', 'budget', 'hud',
    ]);
    assert.equal(report.seed, world.activities.seed);
    // The audit is deterministic: the second pass is the run that was fingerprinted.
    assert.equal(audit.ok, true);
    assert.match(audit.summary(), /gdo:localActivityAudit:v1 pass/);
  } finally {
    world.dispose();
    ledger.disposeAll();
    scene.clear();
  }
});
