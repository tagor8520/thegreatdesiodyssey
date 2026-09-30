import { GEO_QUERY_MASK } from './GeoCollision.js';

/**
 * `GME-04` — throttled place-label line-of-sight.
 *
 * Labels are DOM overlays, so an occluded name is a plain depth error: the
 * research requires the label ray to be tested against `LOS_BLOCKER` proxies
 * only, at a bounded rate, with the verdict cached between tests. Nothing here
 * touches foliage, collectibles, birds, or bees: those proxies carry no
 * `LOS_BLOCKER` bit, so the shared role-aware sweep can never hit them.
 */

export const GEO_LABEL_LOS_NAMESPACE = 'gdo:labelLos:v1';

/**
 * Per-profile test budget from `CLIPPING_AND_LAYERING_RESEARCH.md` §13: label
 * LOS tests per second, and labels tested in one frame at most.
 */
export const GEO_LABEL_LOS_PROFILES = Object.freeze({
  low: Object.freeze({ testsPerSecond: 20, candidates: 5 }),
  balanced: Object.freeze({ testsPerSecond: 40, candidates: 10 }),
  high: Object.freeze({ testsPerSecond: 80, candidates: 14 }),
});

export const GEO_LABEL_LOS_DEFAULTS = Object.freeze({
  // A near-plane-sized probe: a label is occluded when a solid blocker covers
  // the ray, not when the ray grazes a surface beside it.
  radius: .012,
  // Verdicts older than this are re-tested even if the rotation has not reached
  // the label again, so a fast camera swing cannot keep a stale verdict forever.
  staleMilliseconds: 400,
  maxDistance: 96,
});

export function labelLosBudgetForProfile(profile) {
  return GEO_LABEL_LOS_PROFILES[profile] ?? GEO_LABEL_LOS_PROFILES.low;
}

/**
 * Deterministic, allocation-free label LOS tester.
 *
 * `visibleLabels(labels, camera, nowMilliseconds)` returns the visible subset in
 * the input order, reusing the caller's array and the tester's own records. The
 * test budget is refilled by elapsed time, so 20 tests/second stays 20 tests/
 * second regardless of frame rate, and labels are visited in a stable rotation.
 */
export function createLabelLosTester({ world, profile = 'low', radius = GEO_LABEL_LOS_DEFAULTS.radius, staleMilliseconds = GEO_LABEL_LOS_DEFAULTS.staleMilliseconds, maxDistance = GEO_LABEL_LOS_DEFAULTS.maxDistance } = {}) {
  if (!world || typeof world.sweepSphere !== 'function') throw new TypeError('Label LOS needs a world with a shared sweep query');
  if (!Number.isFinite(radius) || radius <= 0) throw new RangeError('Label LOS radius must be positive and finite');
  if (!Number.isFinite(staleMilliseconds) || staleMilliseconds <= 0) throw new RangeError('Label LOS stale window must be positive and finite');
  const limits = labelLosBudgetForProfile(profile);
  const sweep = {};
  const eye = { x: 0, y: 0, z: 0 };
  // Records are keyed by the label object and reused for its whole lifetime.
  const records = new Map();
  const counters = { tests: 0, hidden: 0, visible: 0, stale: 0, probes: 0, batches: 0 };
  // One reused diagnostics view: the HUD reads it every frame, so a fresh object
  // per frame would be a steady-state allocation.
  const view = {
    namespace: GEO_LABEL_LOS_NAMESPACE, profile, testsPerSecond: limits.testsPerSecond,
    candidates: limits.candidates, radius, staleMilliseconds, maxDistance,
    tests: 0, probes: 0, hidden: 0, visible: 0, stale: 0, batches: 0, lastBatch: 0, tracked: 0,
    steadyFrameAllocations: 0,
  };
  let cursor = 0;
  let credit = 0;
  let lastMilliseconds = null;
  let lastBatch = 0;

  const recordFor = label => {
    let record = records.get(label);
    if (!record) {
      record = { blocked: false, testedAt: -Infinity, age: Infinity, tested: false };
      records.set(label, record);
    }
    return record;
  };

  /** One LOS probe: true when a solid LOS blocker stands between the eye and the label. */
  function probe(fromX, fromY, fromZ, toX, toY, toZ) {
    counters.probes++;
    world.sweepSphere(fromX, fromY, fromZ, toX - fromX, toY - fromY, toZ - fromZ, radius, sweep, GEO_QUERY_MASK.LOS_BLOCKER);
    // A hit at the very end of the segment is the label's own surface, not an
    // occluder, so the comparison keeps a small epsilon margin.
    return Boolean(sweep.hit) && sweep.time < 1 - 1e-6;
  }

  function visibleLabels(labels, camera, nowMilliseconds = 0, out = []) {
    const list = Array.isArray(labels) ? labels : [];
    out.length = 0;
    if (!list.length) {
      counters.hidden = 0;
      counters.visible = 0;
      lastBatch = 0;
      return out;
    }
    const now = Number.isFinite(nowMilliseconds) ? nowMilliseconds : 0;
    if (lastMilliseconds === null) lastMilliseconds = now;
    const elapsed = Math.max(0, now - lastMilliseconds);
    lastMilliseconds = now;
    credit = Math.min(limits.candidates * 4, credit + elapsed / 1000 * limits.testsPerSecond);
    const budget = Math.min(limits.candidates, Math.floor(credit));
    credit -= budget;
    lastBatch = budget;

    const cameraPosition = camera?.position;
    eye.x = Number.isFinite(cameraPosition?.x) ? cameraPosition.x : 0;
    eye.y = Number.isFinite(cameraPosition?.y) ? cameraPosition.y : 0;
    eye.z = Number.isFinite(cameraPosition?.z) ? cameraPosition.z : 0;

    // Live labels shed their cached record when a tile evicts them, so the map
    // cannot grow with the number of labels ever seen.
    if (records.size > list.length * 2 + 16) {
      for (const key of records.keys()) if (!list.includes(key)) records.delete(key);
    }

    let tested = 0;
    if (budget > 0) {
      const count = list.length;
      for (let step = 0; step < count && tested < budget; step++) {
        const index = (cursor + step) % count;
        const label = list[index];
        const record = recordFor(label);
        const anchorY = (Number.isFinite(label?.y) ? label.y : 0) + (label?.kind === 'place' ? 1.25 : label?.kind === 'poi' ? .72 : label?.kind === 'water' ? .28 : .42);
        record.blocked = probe(eye.x, eye.y, eye.z, label.x, anchorY, label.z);
        record.testedAt = now;
        record.age = 0;
        record.tested = true;
        tested++;
      }
      cursor = (cursor + tested) % count;
      counters.batches++;
    }
    counters.tests += tested;

    counters.hidden = 0;
    counters.visible = 0;
    counters.stale = 0;
    for (const label of list) {
      const record = recordFor(label);
      record.age = Number.isFinite(record.testedAt) ? now - record.testedAt : Infinity;
      const blocked = record.tested && record.blocked;
      // A label whose verdict went stale while it is off-screen is treated as
      // visible and re-tested on the next rotation; an occluded label stays
      // hidden until its own verdict says otherwise.
      if (blocked) counters.hidden++;
      else {
        counters.visible++;
        if (!Number.isFinite(record.testedAt) || record.age > staleMilliseconds) counters.stale++;
        out.push(label);
      }
    }
    return out;
  }

  /**
   * Live view, updated in place. Read it directly for the HUD; copy the fields
   * (`{ ...tester.diagnostics() }`) when a snapshot must be retained.
   */
  function diagnostics() {
    view.tests = counters.tests;
    view.probes = counters.probes;
    view.hidden = counters.hidden;
    view.visible = counters.visible;
    view.stale = counters.stale;
    view.batches = counters.batches;
    view.lastBatch = lastBatch;
    view.tracked = records.size;
    return view;
  }

  function reset() {
    records.clear();
    cursor = 0;
    credit = 0;
    lastMilliseconds = null;
    lastBatch = 0;
    for (const key of Object.keys(counters)) counters[key] = 0;
  }

  return { namespace: GEO_LABEL_LOS_NAMESPACE, visibleLabels, probe, diagnostics, reset, dispose: reset, limits };
}
