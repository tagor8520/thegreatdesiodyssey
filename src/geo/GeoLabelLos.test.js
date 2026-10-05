/**
 * `GME-04` — the label line-of-sight contract and the map-bearing helper.
 *
 * The scheduler is driven with a **synthetic blocker** rather than a compiled
 * fixture, because the contract is about what the label layer asks and how much it
 * asks, not about whether a particular building happens to be in the way:
 *
 * 1. §15.6.1 — a label behind a blocker is hidden, one in front stays visible.
 * 2. §15.6.2 — the query mask is `LOS_BLOCKER` and nothing else, so a pickup or a
 *    bird cannot blank a name; asserted by inspecting the mask argument the
 *    scheduler passes, which is the only place that claim can be checked.
 * 3. §13 — the per-second and simultaneous-label ceilings are honoured, including
 *    under a burst and across a stall.
 * 4. §12 — the diagnostics expose the ray, the blocker and the update age.
 *
 * The browser tier proves the same criteria against real buildings in a real scene;
 * this tier proves the rules, cheaply and deterministically.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GEO_LABEL_LOS_PROFILES, GEO_LABEL_LOS_RADIUS, GEO_LABEL_LOS_REFRESH_MILLISECONDS,
  GeoLabelLosError, LabelLosScheduler, compassBearing, compassPoint, formatMetres,
} from '../geo/GeoLabelLos.js';
import { GEO_QUERY_MASK } from '../geo/GeoCollision.js';

/**
 * A synthetic world: a wall at z = 0 spanning x in [-5, 5] and y in [0, 3].
 * A ray from an eye at z = -6 to a label at z = +6 crosses it; a label at z = -2
 * sits in front of it.
 */
function wallSweep() {
  const calls = [];
  const sweep = (x, y, z, dx, dy, dz, radius, out, mask) => {
    calls.push({ x, y, z, dx, dy, dz, radius, mask });
    const crossesWall = (z <= 0 && z + dz >= 0) || (z >= 0 && z + dz <= 0);
    // Where along the ray does it cross, and is that crossing inside the wall's span?
    const time = dz === 0 ? 0 : (0 - z) / dz;
    const hitX = x + dx * time;
    const hitY = y + dy * time;
    const blocked = crossesWall && time > 0 && time < 1 &&
      Math.abs(hitX) <= 5 + radius && hitY >= -radius && hitY <= 3 + radius;
    out.hit = blocked;
    out.time = blocked ? time : 1;
    out.tileKey = blocked ? 'tile:0:0' : null;
    return blocked;
  };
  return { sweep, calls };
}

const EYE = Object.freeze({ x: 0, y: 1.6, z: -6 });
const BEHIND = Object.freeze({ key: 'behind', x: 0, y: 1.5, z: 6 });
const IN_FRONT = Object.freeze({ key: 'front', x: 0, y: 1.5, z: -2 });

test('a label behind geometry is hidden and one in front stays visible', () => {
  const { sweep } = wallSweep();
  const scheduler = new LabelLosScheduler({ sweep, profile: 'low' });
  const result = scheduler.update([BEHIND, IN_FRONT], EYE, 1000);

  assert.equal(result.tested, 2);
  assert.equal(result.hidden, 1, 'exactly one of the two labels is occluded');
  assert.equal(scheduler.isHidden('behind'), true);
  assert.equal(scheduler.isHidden('front'), false);
  // §12.1 diagnostics: the ray, the blocker and the age must all be reportable.
  const diagnostics = scheduler.diagnostics();
  assert.equal(diagnostics.blockedNow, 1);
  assert.equal(diagnostics.hidden, 1);
  assert.equal(diagnostics.tests, 2);
  assert.equal(diagnostics.profile, 'low');
  assert.equal(result.lastBlocked.key, 'behind');
  assert.equal(result.lastBlocked.blocker, 'tile:0:0');
  assert.deepEqual(result.lastBlocked.ray.from, EYE);
  assert.equal(result.lastBlocked.ray.to.z, 6);
  assert.ok(result.lastBlocked.time > 0 && result.lastBlocked.time < 1, 'the contact is on the segment, not at an endpoint');
});

test('the query asks for LOS blockers only', () => {
  // §15.6.2. A collectible, a blade of grass, a bird or a bee carries other roles;
  // if this call ever widened its mask, a drifting bee would blank a place name.
  const { sweep, calls } = wallSweep();
  const scheduler = new LabelLosScheduler({ sweep });
  scheduler.update([BEHIND], EYE, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mask, GEO_QUERY_MASK.LOS_BLOCKER);
  for (const role of ['SOLID_PLAYER', 'CAMERA_BLOCKER', 'FADE_ELIGIBLE', 'INTERACTION', 'PLACEMENT', 'SUPPORT']) {
    assert.equal(calls[0].mask & GEO_QUERY_MASK[role], 0, `the label ray must not consult ${role}`);
  }
  // A ray that hits nothing in its path reports no blocker, and the label is shown.
  const clear = new LabelLosScheduler({ sweep });
  clear.update([IN_FRONT], EYE, 0);
  assert.equal(clear.isHidden('front'), false);
  assert.equal(clear.diagnostics().blockedNow, 0);
  assert.equal(clear.diagnostics().lastBlocker, null);
});

test('a verdict is held for the refresh interval instead of re-tested every frame', () => {
  const { sweep, calls } = wallSweep();
  const scheduler = new LabelLosScheduler({ sweep, refreshMilliseconds: 250 });
  scheduler.update([BEHIND], EYE, 0);
  assert.equal(calls.length, 1);
  const second = scheduler.update([BEHIND], EYE, 16);
  assert.equal(second.tested, 0, '16ms later the previous verdict still holds');
  assert.equal(second.skippedForRefresh, 1);
  assert.equal(calls.length, 1);
  assert.equal(scheduler.isHidden('behind'), true, 'and the label stays hidden between tests');
  // Once the interval has passed it is re-tested.
  const third = scheduler.update([BEHIND], EYE, 250);
  assert.equal(third.tested, 1);
  assert.equal(calls.length, 2);
  // The age readout tracks the last test, which is the *LOS update age* diagnostic.
  assert.equal(scheduler.ageMilliseconds('behind', 250), 0);
  assert.equal(scheduler.ageMilliseconds('behind', 400), 150);
  assert.equal(scheduler.ageMilliseconds('unknown', 400), null);
  assert.equal(scheduler.diagnostics(400).updateAgeMilliseconds, 150);
});

test('the per-second and simultaneous ceilings are hard, under bursts and stalls', () => {
  const { sweep, calls } = wallSweep();
  const scheduler = new LabelLosScheduler({ sweep, profile: 'low', refreshMilliseconds: 1 });
  const many = Array.from({ length: 20 }, (_, index) => ({ key: `label_${index}`, x: index, y: 1.5, z: 6 }));
  // A burst of passes inside one second must not exceed the per-second ceiling.
  let total = 0;
  for (let pass = 0; pass < 10; pass++) total += scheduler.update(many, EYE, pass * 10).tested;
  assert.ok(total <= GEO_LABEL_LOS_PROFILES.low.testsPerSecond, `burst tested ${total}, over the 20/s ceiling`);
  assert.equal(scheduler.counters.skippedForBudget > 0, true, 'the excess must be reported as skipped, not silently dropped');

  // A long stall must not be repaid as an unbounded burst: the bucket is capped at
  // one pass's worth, so the next pass still respects `simultaneousLabels`.
  const stalled = new LabelLosScheduler({ sweep, profile: 'low', refreshMilliseconds: 1 });
  const staleness = stalled.update(many, EYE, 0);
  assert.equal(staleness.tested, GEO_LABEL_LOS_PROFILES.low.simultaneousLabels);
  const afterStall = stalled.update(many, EYE, 60_000);
  assert.equal(afterStall.tested, GEO_LABEL_LOS_PROFILES.low.simultaneousLabels, 'a 60-second stall must still not exceed one pass of the budget');

  // The profiles are the research's own numbers, not invented ones.
  assert.deepEqual(GEO_LABEL_LOS_PROFILES.low, { testsPerSecond: 20, simultaneousLabels: 5 });
  assert.deepEqual(GEO_LABEL_LOS_PROFILES.balanced, { testsPerSecond: 40, simultaneousLabels: 10 });
  assert.deepEqual(GEO_LABEL_LOS_PROFILES.high, { testsPerSecond: 80, simultaneousLabels: 14 });
  const high = new LabelLosScheduler({ sweep, profile: 'high', refreshMilliseconds: 1 });
  assert.equal(high.update(many, EYE, 0).tested, 14);
});

test('a label can clear, and a retired label cannot keep a stale verdict', () => {
  const { sweep } = wallSweep();
  const scheduler = new LabelLosScheduler({ sweep, refreshMilliseconds: 1 });
  scheduler.update([BEHIND], EYE, 0);
  assert.equal(scheduler.isHidden('behind'), true);
  // Move the label in front of the wall: the same key must come back visible.
  scheduler.update([{ key: 'behind', x: 0, y: 1.5, z: -2 }], EYE, 10);
  assert.equal(scheduler.isHidden('behind'), false, 'a label that moves clear must be shown again');
  // A label that is no longer a candidate is forgotten, so a recycled name cannot
  // inherit another label's occlusion. (A later frame — reusing the same
  // millisecond would leave the previous verdict standing by design.)
  scheduler.update([{ key: 'behind', x: 0, y: 1.5, z: 6 }], EYE, 20);
  assert.equal(scheduler.isHidden('behind'), true);
  scheduler.retain(new Set());
  assert.equal(scheduler.isHidden('behind'), false);
  assert.equal(scheduler.diagnostics().tracked, 0);
  scheduler.reset();
  assert.equal(scheduler.diagnostics().tests, 0);
});

test('a sweep that returns its out object rather than a boolean is read correctly', () => {
  // `world.sweepSphere` returns `out`, which is truthy even when nothing was hit.
  // Treating that return value as the verdict would hide every label in the scene,
  // so the scheduler reads `out.hit` and only trusts a *strict* boolean return.
  const clear = new LabelLosScheduler({
    sweep: (x, y, z, dx, dy, dz, radius, out) => { out.hit = false; out.time = 1; return out; },
  });
  clear.update([BEHIND, IN_FRONT], EYE, 0);
  assert.equal(clear.isHidden('behind'), false, 'an unobstructed world-style sweep must not hide anything');
  assert.equal(clear.diagnostics().blockedNow, 0);

  const blocking = new LabelLosScheduler({
    sweep: (x, y, z, dx, dy, dz, radius, out) => { out.hit = true; out.time = .4; out.tileKey = 'tile:1:1'; return out; },
  });
  blocking.update([IN_FRONT], EYE, 0);
  assert.equal(blocking.isHidden('front'), true, 'and a blocked world-style sweep must hide the label');
  assert.equal(blocking.diagnostics().lastBlocker.blocker, 'tile:1:1');
});

test('the scheduler refuses a malformed configuration instead of guessing', () => {
  assert.throws(() => new LabelLosScheduler({}), GeoLabelLosError);
  assert.throws(() => new LabelLosScheduler({ sweep: () => false, profile: 'ultra' }), GeoLabelLosError);
  assert.throws(() => new LabelLosScheduler({ sweep: () => false, refreshMilliseconds: 0 }), GeoLabelLosError);
  assert.equal(GEO_LABEL_LOS_RADIUS < .055, false, 'the probe must not be smaller than the collision footprint, or it would slip through walls');
  assert.ok(GEO_LABEL_LOS_RADIUS < 1, 'and it must stay small, or a distant wall would blank labels it cannot hide');
  assert.equal(GEO_LABEL_LOS_REFRESH_MILLISECONDS, 250, 'the refresh interval is the "update interval" §15.6.1 names');
});

test('the map bearing and distance are geographically correct', () => {
  // 0.01 degrees of latitude is ~1113 m anywhere; 0.01 of longitude shrinks with
  // latitude by cos(lat), which is the whole reason the bearing is computed from
  // coordinates rather than from world axes.
  const north = compassBearing(28.9845, 77.7064, 28.9945, 77.7064);
  assert.equal(north.point, 'N');
  assert.equal(Math.round(north.metres), 1113);
  assert.ok(Math.abs(north.degrees) < .001);

  const east = compassBearing(28.9845, 77.7064, 28.9845, 77.7164);
  assert.equal(east.point, 'E');
  assert.equal(Math.round(east.metres), Math.round(1113 * Math.cos(28.9845 * Math.PI / 180)));

  assert.equal(compassBearing(0, 0, -1, 0).point, 'S');
  assert.equal(compassBearing(0, 0, 0, -1).point, 'W');
  assert.equal(compassBearing(0, 0, 1, 1).point, 'NE');
  assert.equal(compassBearing(0, 0, -1, 1).point, 'SE');
  assert.equal(compassBearing(0, 0, -1, -1).point, 'SW');
  assert.equal(compassBearing(0, 0, 1, -1).point, 'NW');
  assert.equal(compassBearing(28.98, 77.70, 28.98, 77.70).metres, 0, 'a place is zero metres from itself');

  // Sixteen slices: every point name is reachable and the rounding wraps cleanly.
  const points = new Set();
  for (let degrees = 0; degrees < 360; degrees += 1) points.add(compassPoint(degrees));
  assert.equal(points.size, 16);
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(-1), 'N');
  assert.equal(compassPoint(Number.NaN), null);

  assert.equal(formatMetres(840), '840 m');
  assert.equal(formatMetres(1400), '1.4 km');
  assert.equal(formatMetres(14900), '15 km');
  assert.equal(formatMetres(Number.NaN), '—');
});
