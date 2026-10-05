import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GDO_LOW_PROFILE_BUDGETS, evaluateLowProfileBudget } from '../engine/PerformanceBudget.js';
import { GEO_QUERY_MASK } from './GeoCollision.js';
import {
  GEO_DYNAMIC_CELL_SIZE,
  GEO_DYNAMIC_COMPOUND_MAX,
  GEO_DYNAMIC_PROXY_CAPS,
  GeoDynamicProxyCapError,
  GeoDynamicProxyHash,
  GeoDynamicProxyShapeError,
} from './GeoDynamicProxies.js';
import { GEO_STREAMING_LIMITS, GeoWorld } from './GeoWorld.js';

/**
 * COL-09 gate: "64/128/256 profile caps; primitive-only dynamic proxies".
 *
 * The two halves of that criterion are asserted separately, because they fail
 * differently: the caps must be *exact* and must never evict, and the primitive
 * restriction must reject everything that is not one of the four admitted shapes
 * with a message that names what arrived.
 */

const SOLID = GEO_QUERY_MASK.SOLID_PLAYER;
const CAMERA = GEO_QUERY_MASK.CAMERA_BLOCKER;

/** A stale Worker stub: GeoWorld constructs a tile worker in its constructor. */
function withStubWorker(run) {
  const previous = globalThis.Worker;
  globalThis.Worker = class {
    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
    terminate() {}
  };
  try { return run(); } finally { globalThis.Worker = previous; }
}

function circleSpec(overrides = {}) {
  return { shape: 'circle', x: 0, z: 0, radius: 1, y0: 0, y1: 2, mask: SOLID, ownerKey: 'test', ...overrides };
}

test('COL-09: the cell lattice matches the static grid so the two cannot drift', () => {
  assert.equal(GEO_DYNAMIC_CELL_SIZE, GEO_STREAMING_LIMITS.collisionCellSize,
    'the dynamic hash buckets on the same 4-unit lattice as the static grid');
});

test('COL-09: profile caps are exactly 64/128/256 and the default profile is the low one', () => {
  assert.deepEqual(GEO_DYNAMIC_PROXY_CAPS, { low: 64, balanced: 128, high: 256 });
  const defaulted = new GeoDynamicProxyHash();
  assert.equal(defaulted.profile, 'low');
  assert.equal(defaulted.cap, 64);
  for (const [profile, cap] of Object.entries(GEO_DYNAMIC_PROXY_CAPS)) {
    const hash = new GeoDynamicProxyHash({ profile });
    assert.equal(hash.cap, cap, `${profile} must cap at ${cap}`);
  }
  assert.throws(() => new GeoDynamicProxyHash({ profile: 'desktop' }), RangeError,
    'an unknown profile must not silently fall back to a cap');
});

test('each profile accepts exactly its cap and rejects the next proxy descriptively', () => {
  for (const [profile, cap] of Object.entries(GEO_DYNAMIC_PROXY_CAPS)) {
    const hash = new GeoDynamicProxyHash({ profile });
    const handles = [];
    for (let index = 0; index < cap; index++) {
      // Spread them out so bucketing stays realistic, and keep every proxy valid.
      handles.push(hash.add(circleSpec({ x: index * 8, ownerKey: `owner-${index}` })));
    }
    assert.equal(hash.activeCount, cap);
    assert.equal(new Set(handles).size, cap, 'every proxy gets a distinct handle');

    let rejection = null;
    try {
      hash.add(circleSpec({ x: cap * 8, ownerKey: 'overflow' }));
    } catch (error) { rejection = error; }
    assert.ok(rejection instanceof GeoDynamicProxyCapError, `${profile} must reject past ${cap}`);
    assert.match(rejection.message, new RegExp(`profile "${profile}" allows ${cap} active primitives`));
    assert.match(rejection.message, /overflow/, 'the rejection names the owner that did not fit');
    assert.equal(rejection.cap, cap);
    assert.equal(rejection.active, cap);

    // Rejection must not evict: the cap is a ceiling, not a ring buffer.
    assert.equal(hash.activeCount, cap, 'a rejected add leaves the population untouched');
    for (const handle of handles) assert.notEqual(hash.shapeOf(handle), null, 'no existing proxy was evicted');
    assert.equal(hash.diagnostics.capRejects, 1);
  }
});

test('a rejected add leaves the query result byte-identical to before the attempt', () => {
  const hash = new GeoDynamicProxyHash({ cap: 2 });
  hash.add(circleSpec({ x: 0, z: 0 }));
  hash.add(circleSpec({ x: 100, z: 0 }));
  const before = hash.collect(0, 0, 4, SOLID);
  assert.throws(() => hash.add(circleSpec({ x: 200, z: 0 })), GeoDynamicProxyCapError);
  const after = hash.collect(0, 0, 4, SOLID);
  assert.equal(after, before);
  assert.equal(hash.overlapsCircle(0, 0, 4, SOLID), true);
  assert.equal(hash.overlapsCircle(200, 0, 4, SOLID), false);
});

test('a compound is all-or-nothing when it does not fit under the cap', () => {
  const hash = new GeoDynamicProxyHash({ cap: 3 });
  hash.add(circleSpec());
  assert.throws(() => hash.addCompound(
    { ownerKey: 'bus', mask: SOLID, y0: 0, y1: 3 },
    [0, 1, 2, 3].map(index => ({ shape: 'circle', x: index * 2, z: 0, radius: .5 })),
  ), GeoDynamicProxyCapError);
  assert.equal(hash.activeCount, 1, 'a compound that cannot fit must place nothing at all');
  assert.equal(hash.ownerCount, 1, 'no half-placed owner is registered');
});

test('a compound is a short list: more than four primitives is rejected', () => {
  const hash = new GeoDynamicProxyHash();
  assert.throws(() => hash.addCompound(
    { ownerKey: 'train', mask: SOLID, y0: 0, y1: 3 },
    Array.from({ length: GEO_DYNAMIC_COMPOUND_MAX + 1 }, (index => ({ shape: 'box', minX: index, minZ: 0, maxX: index + .5, maxZ: 1 }))),
  ), GeoDynamicProxyShapeError, 'a compound is not a nested graph');
  assert.equal(hash.activeCount, 0);
});

test('a compound places each primitive and releases them all with one owner call', () => {
  const hash = new GeoDynamicProxyHash();
  const handles = hash.addCompound(
    { ownerKey: 'truck', mask: SOLID, y0: .2, y1: 2.4 },
    [
      { shape: 'box', minX: -2, minZ: -1, maxX: 2, maxZ: 1 },
      { shape: 'circle', x: 2.4, z: 0, radius: .6 },
    ],
  );
  assert.equal(handles.length, 2);
  assert.equal(hash.activeCount, 2);
  assert.equal(hash.ownerOf(handles[0]), 'truck');
  // The compound's Y span is inherited by primitives that do not declare one.
  assert.deepEqual(hash.spanAt(handles[1]), { y0: .2, y1: 2.4 });
  assert.equal(hash.removeOwner('truck'), 2);
  assert.equal(hash.activeCount, 0);
  assert.equal(hash.cellCount, 0, 'releasing an owner empties its buckets');
});

test('primitive-only: the four admitted shapes are accepted and identified', () => {
  const hash = new GeoDynamicProxyHash();
  const shapes = {
    circle: { shape: 'circle', x: 0, z: 0, radius: 1 },
    capsule: { shape: 'capsule', x1: -1, z1: 0, x2: 1, z2: 0, radius: .4 },
    box: { shape: 'box', minX: -1, minZ: -1, maxX: 1, maxZ: 1 },
    obb: { shape: 'obb', x: 5, z: 5, halfX: 2, halfZ: .5, yaw: Math.PI / 4 },
  };
  const canonical = { circle: 'circle', capsule: 'capsule', box: 'box', obb: 'oriented-box' };
  for (const [name, spec] of Object.entries(shapes)) {
    const handle = hash.add({ ...spec, y0: 0, y1: 2, mask: SOLID, ownerKey: name });
    assert.equal(hash.shapeOf(handle), canonical[name], `${name} must round-trip to its canonical shape kind`);
  }
  // Aliases resolve to the same primitive rather than adding a fifth shape.
  assert.equal(hash.shapeOf(hash.add({ shape: 'aabb', minX: 40, minZ: 0, maxX: 41, maxZ: 1, y0: 0, y1: 1, mask: SOLID })), 'box');
  assert.equal(hash.shapeOf(hash.add({ shape: 'orientedBox', x: 50, z: 0, halfX: 1, halfZ: 1, yaw: 0, y0: 0, y1: 1, mask: SOLID })), 'oriented-box');
  // The two alias forms resolved to the same primitives, so all six are placed.
  assert.equal(hash.activeCount, 6, 'aliases resolve to the same primitives instead of a fifth shape');
});

test('primitive-only: anything that is not a primitive is rejected by name', () => {
  const hash = new GeoDynamicProxyHash();
  const rejected = [
    ['mesh', 'mesh'],
    ['rendered-object', { isMesh: true }],
    ['nested-compound', { primitives: [{ shape: 'circle' }] }],
    ['sphere', 'sphere'],
    ['undefined', undefined],
  ];
  for (const [label, shape] of rejected) {
    let error = null;
    try { hash.add(circleSpec({ shape })); } catch (caught) { error = caught; }
    assert.ok(error instanceof GeoDynamicProxyShapeError, `${label} must be rejected`);
    assert.match(error.message, /primitives only \(circle, capsule, box, obb\)/);
  }
  assert.equal(hash.activeCount, 0, 'nothing was placed by a rejected shape');
  assert.equal(hash.diagnostics.shapeRejects, rejected.length);
});

test('primitive-only: malformed numbers and an unbounded Y span are rejected', () => {
  const hash = new GeoDynamicProxyHash();
  const cases = [
    ['missing Y span', { y0: undefined, y1: undefined }],
    ['inverted Y span', { y0: 2, y1: 1 }],
    ['empty Y span', { y0: 1, y1: 1 }],
    ['non-finite Y span', { y0: 0, y1: Infinity }],
    ['zero radius', { radius: 0 }],
    ['negative radius', { radius: -1 }],
    ['non-finite centre', { x: NaN }],
  ];
  for (const [label, overrides] of cases) {
    assert.throws(() => hash.add(circleSpec(overrides)), GeoDynamicProxyShapeError, `${label} must be rejected`);
  }
  assert.equal(hash.activeCount, 0);

  // A capsule and an oriented box validate their own fields too.
  assert.throws(() => hash.add({ shape: 'capsule', x1: 0, z1: 0, x2: 0, z2: 0, radius: 0, y0: 0, y1: 1 }), GeoDynamicProxyShapeError);
  assert.throws(() => hash.add({ shape: 'box', minX: 1, minZ: 0, maxX: 1, maxZ: 1, y0: 0, y1: 1 }), GeoDynamicProxyShapeError);
  assert.throws(() => hash.add({ shape: 'obb', x: 0, z: 0, halfX: 0, halfZ: 1, yaw: 0, y0: 0, y1: 1 }), GeoDynamicProxyShapeError);
});

test('primitive-only: a proxy too large to hash is rejected rather than unbounded', () => {
  const hash = new GeoDynamicProxyHash();
  let error = null;
  try {
    hash.add(circleSpec({ radius: 1000 }));
  } catch (caught) { error = caught; }
  assert.ok(error instanceof GeoDynamicProxyShapeError);
  assert.match(error.message, /over the 64-cell limit/);
  assert.match(error.message, /compound of smaller primitives/);
  assert.equal(hash.activeCount, 0);
});

test('reinsert happens only when a proxy crosses a cell boundary', () => {
  const hash = new GeoDynamicProxyHash();
  // Start at (6, 6): with radius .5 the bounds are 5.5..6.5 on both axes, entirely
  // inside cell (1, 1) — cells span 4..8 — so a slide up to x=7.4 stays in one bucket.
  const handle = hash.add(circleSpec({ x: 6, z: 6, radius: .5 }));
  const startReinserts = hash.diagnostics.reinserts;
  assert.equal(hash.cellCount, 1, 'the proxy starts in exactly one bucket');

  // Slide well within that cell: no re-bucketing, but the new position must take
  // effect immediately for queries.
  for (let step = 1; step <= 7; step++) hash.update(handle, { x: 6 + step * .2 });
  assert.equal(hash.diagnostics.reinserts - startReinserts, 0,
    'a proxy moving inside its cell must not be re-bucketed');
  assert.equal(hash.diagnostics.updates, 7);
  assert.equal(hash.overlapsCircle(7.4, 6, .5, SOLID), true, 'the move is visible to queries at once');
  assert.equal(hash.overlapsCircle(6, 6, .5, SOLID), false, 'the old position must stop matching');

  // Crossing into the next cell re-buckets exactly once. Bounds reach 9.0..10.0,
  // which floor to cell 2.
  hash.update(handle, { x: 9.5 });
  assert.equal(hash.diagnostics.reinserts - startReinserts, 1, 'a boundary crossing re-buckets exactly once');
  assert.equal(hash.overlapsCircle(9.5, 6, .5, SOLID), true);
  assert.equal(hash.overlapsCircle(7.4, 6, .5, SOLID), false, 'the old bucket must not still match');
  assert.equal(hash.collect(7.4, 6, .5, SOLID), 0);

  // A long move followed by a return: two more crossings, and no stale candidates.
  hash.update(handle, { x: 40 });
  assert.equal(hash.collect(9.5, 6, .5, SOLID), 0, 'nothing is left behind in the old cells');
  hash.update(handle, { x: 6 });
  assert.equal(hash.diagnostics.reinserts - startReinserts, 3);
  assert.equal(hash.cellCount, 1, 'only the occupied cell remains bucketed');
});

test('a multi-cell proxy is a single candidate per query, not one per cell', () => {
  const hash = new GeoDynamicProxyHash();
  // A 12x12 box spans 4x4 cells (16 buckets) at the 4-unit cell size.
  const handle = hash.add({ shape: 'box', minX: -6, minZ: -6, maxX: 6, maxZ: 6, y0: 0, y1: 2, mask: SOLID, ownerKey: 'wide' });
  assert.equal(hash.cellCount, 16);
  const count = hash.collect(0, 0, 1, SOLID);
  assert.equal(count, 1, 'the stamp array dedupes a proxy reached through many buckets');
  assert.deepEqual([...hash.candidates()], [0]);
  assert.equal(hash.overlapsCircle(0, 0, 1, SOLID), true);
  assert.equal(hash.updateDynamicProxy, undefined, 'the hash has no world-level update alias');
  assert.equal(hash.remove(handle), true);
  assert.equal(hash.cellCount, 0);
});

test('overlap is exact for every primitive, including a rotated oriented box', () => {
  const hash = new GeoDynamicProxyHash();
  const circle = hash.add({ shape: 'circle', x: 0, z: 0, radius: 1, y0: 0, y1: 2, mask: SOLID });
  const capsule = hash.add({ shape: 'capsule', x1: 10, z1: -2, x2: 10, z2: 2, radius: .5, y0: 0, y1: 2, mask: SOLID });
  const box = hash.add({ shape: 'box', minX: 20, minZ: -1, maxX: 22, maxZ: 1, y0: 0, y1: 2, mask: SOLID });
  const obb = hash.add({ shape: 'obb', x: 40, z: 0, halfX: 3, halfZ: .5, yaw: Math.PI / 2, y0: 0, y1: 2, mask: SOLID });

  // Circle: touching at exactly (radius + r) counts, a hair beyond does not.
  assert.equal(hash.overlapsCircle(1.1, 0, .1, SOLID), true);
  assert.equal(hash.overlapsCircle(1.101, 0, .1, SOLID), false);
  // Capsule: the round cap and the flat side both count.
  assert.equal(hash.overlapsCircle(10, 2.4, .1, SOLID), true);
  assert.equal(hash.overlapsCircle(10, 2.7, .1, SOLID), false);
  assert.equal(hash.overlapsCircle(10.5, 0, .1, SOLID), true);
  assert.equal(hash.overlapsCircle(10.7, 0, .1, SOLID), false);
  // Box: corner distance is respected, so a diagonal miss is a miss.
  assert.equal(hash.overlapsCircle(22.06, 1.06, .1, SOLID), true);
  assert.equal(hash.overlapsCircle(22.2, 1.2, .1, SOLID), false);
  // OBB rotated a quarter turn: halfX=3 maps to the world Z extent and halfZ=0.5 to
  // the world X extent, so the box is long in Z and thin in X. A point inside the
  // rotated extent but outside the unrotated one proves the yaw is applied.
  assert.equal(hash.overlapsCircle(40, 2.4, .1, SOLID), true, 'inside the rotated long axis');
  assert.equal(hash.overlapsCircle(40, 3.4, .1, SOLID), false, 'beyond the rotated long axis');
  assert.equal(hash.overlapsCircle(42.4, 0, .1, SOLID), false, 'the rotated box is thin in X');
  assert.equal(hash.shapeOf(circle), 'circle');
  assert.equal(hash.shapeOf(capsule), 'capsule');
  assert.equal(hash.shapeOf(box), 'box');
  assert.equal(hash.shapeOf(obb), 'oriented-box');
});

test('Y span and query mask both filter, and they filter the sweep too', () => {
  const hash = new GeoDynamicProxyHash();
  hash.add({ shape: 'box', minX: -1, minZ: -1, maxX: 1, maxZ: 1, y0: 8, y1: 12, mask: CAMERA, ownerKey: 'deck' });
  // Wrong height: neither an overlap nor a sweep may see it.
  assert.equal(hash.overlapsCircle(0, 0, .5, CAMERA, 0, 2), false, 'a query below the span must not see the proxy');
  assert.equal(hash.collect(0, 0, .5, CAMERA, 0, 2), 0);
  const lowSweep = hash.sweepCircle(-5, 0, 10, 0, .2, {}, CAMERA, 0, 2);
  assert.equal(lowSweep.hit, false, 'a sweep below the span must not hit');
  // Right height: both see it.
  assert.equal(hash.overlapsCircle(0, 0, .5, CAMERA, 9, 10), true);
  const highSweep = hash.sweepCircle(-5, 0, 10, 0, .2, {}, CAMERA, 9, 10);
  assert.equal(highSweep.hit, true);
  // Wrong role: a solid query must not see a camera-only proxy.
  assert.equal(hash.overlapsCircle(0, 0, .5, SOLID, 9, 10), false, 'the mask is authoritative');
  assert.equal(hash.collect(0, 0, .5, SOLID, 9, 10), 0);
});

test('a sweep returns the earliest contact with a normal opposing the motion', () => {
  const hash = new GeoDynamicProxyHash();
  const far = hash.add({ shape: 'box', minX: 8, minZ: -1, maxX: 9, maxZ: 1, y0: 0, y1: 2, mask: SOLID, ownerKey: 'far' });
  const near = hash.add({ shape: 'box', minX: 3, minZ: -1, maxX: 4, maxZ: 1, y0: 0, y1: 2, mask: SOLID, ownerKey: 'near' });
  const out = hash.sweepCircle(0, 0, 10, 0, .25, {}, SOLID);
  assert.equal(out.hit, true);
  // Contact at x = 3 - .25 = 2.75 along a 10-unit sweep.
  assert.ok(Math.abs(out.time - .275) < 1e-9, `expected contact time 0.275, received ${out.time}`);
  assert.equal(out.dynamicHandle, near, 'the nearest proxy wins');
  assert.ok(out.normalX * 10 + out.normalZ * 0 < 0, 'the normal must oppose the motion');
  assert.equal(out.dynamicOwner, 'near');

  // A sweep that starts beyond both, and one that stops short, both miss.
  assert.equal(hash.sweepCircle(20, 0, 1, 0, .25, {}, SOLID).hit, false);
  assert.equal(hash.sweepCircle(0, 0, 2, 0, .1, {}, SOLID).hit, false);
  // A moving radius larger than the gap hits sooner than the point sweep would.
  assert.ok(hash.sweepCircle(0, 0, 10, 0, 2, {}, SOLID).time < out.time);
  assert.equal(hash.shapeOf(far), 'box');
});

test('a swept capsule target is hit at the correct time (circle and capsule agree)', () => {
  const hash = new GeoDynamicProxyHash();
  hash.add({ shape: 'circle', x: 5, z: 0, radius: .5, y0: 0, y1: 2, mask: SOLID });
  const circleSweep = hash.sweepCircle(0, 0, 10, 0, .5, {}, SOLID);
  // Point swept against a radius (0.5 + 0.5) target centred at 5 → time (5-1)/10.
  assert.ok(Math.abs(circleSweep.time - .4) < 1e-9, `expected 0.4, received ${circleSweep.time}`);

  const other = new GeoDynamicProxyHash();
  other.add({ shape: 'capsule', x1: 5, z1: -3, x2: 5, z2: 3, radius: .5, y0: 0, y1: 2, mask: SOLID });
  const capsuleSweep = other.sweepCircle(0, 0, 10, 0, .5, {}, SOLID);
  assert.ok(Math.abs(capsuleSweep.time - .4) < 1e-9, 'a capsule side contact matches the circle contact');
  assert.ok(Math.abs(capsuleSweep.normalX + 1) < 1e-6, 'the normal points back down the sweep');
});

test('an oriented box can be swept through and stops the sweep at its rotated face', () => {
  const hash = new GeoDynamicProxyHash();
  // Rotated a quarter turn: halfZ=0.5 becomes the world X half extent, so the near
  // X face sits at x = 29.5 and a 0.5-radius sweep contacts at x = 29.0.
  hash.add({ shape: 'obb', x: 30, z: 0, halfX: 3, halfZ: .5, yaw: Math.PI / 2, y0: 0, y1: 2, mask: SOLID });
  const out = hash.sweepCircle(0, 0, 60, 0, .5, {}, SOLID);
  assert.equal(out.hit, true);
  assert.ok(Math.abs(out.time - 29 / 60) < 1e-9, `expected a contact at x=29, received time ${out.time}`);
  assert.ok(out.normalX < -.99, 'the contact normal is the rotated face normal in world space');
  // A path that passes to the side of the thin axis must clear it.
  assert.equal(hash.sweepCircle(0, 5, 60, 0, .5, {}, SOLID).hit, false);
});

test('remove and clear release the proxy and its buckets', () => {
  const hash = new GeoDynamicProxyHash();
  const handle = hash.add(circleSpec({ x: 2, z: 2 }));
  assert.equal(hash.remove(handle), true);
  assert.equal(hash.remove(handle), false, 'removing twice is a no-op');
  assert.equal(hash.activeCount, 0);
  assert.equal(hash.cellCount, 0);
  assert.equal(hash.overlapsCircle(2, 2, 1, SOLID), false);

  hash.add(circleSpec({ x: 3, z: 3 }));
  hash.clear();
  assert.equal(hash.activeCount, 0);
  assert.equal(hash.cellCount, 0);
  assert.equal(hash.ownerCount, 0);
  // Storage is reusable after a clear, and the slots are recycled.
  const reused = hash.add(circleSpec({ x: 4, z: 4 }));
  assert.equal(hash.overlapsCircle(4, 4, 1, SOLID), true);
  assert.equal(typeof reused, 'number');

  hash.dispose();
  assert.throws(() => hash.add(circleSpec()), /disposed/);
  assert.equal(hash.activeCount, 0);
});

test('a disposed or unknown handle can never move a proxy', () => {
  const hash = new GeoDynamicProxyHash();
  const handle = hash.add(circleSpec({ x: 0, z: 0 }));
  hash.remove(handle);
  assert.equal(hash.update(handle, { x: 50 }), false, 'an unknown handle reports failure rather than throwing');
  hash.dispose();
  assert.equal(hash.update(handle, { x: 50 }), false);
  assert.equal(hash.remove(handle), false);
  assert.equal(hash.spanAt(handle), null);
  assert.equal(hash.collect(0, 0, 10, SOLID), 0);
});

test('storage is preallocated: bytes and candidate buffers are fixed, not per-proxy', () => {
  const hash = new GeoDynamicProxyHash({ profile: 'low' });
  const emptyBytes = hash.bytes;
  const emptyCandidates = hash.candidates();
  for (let index = 0; index < GEO_DYNAMIC_PROXY_CAPS.low; index++) {
    hash.add(circleSpec({ x: index * 7, z: index % 5, ownerKey: `owner-${index}` }));
  }
  // A per-decorative-box body would grow storage with the proxy count. This does
  // not: the typed arrays are sized to the cap at construction.
  assert.equal(hash.bytes, emptyBytes, 'the structure does not grow when proxies are added');
  assert.equal(hash.activeCount, GEO_DYNAMIC_PROXY_CAPS.low);

  // The candidate buffer is reused across queries rather than reallocated, and is
  // the same allocation the constructor made.
  const first = hash.candidates();
  assert.equal(first.buffer, emptyCandidates.buffer);
  for (let query = 0; query < 500; query++) {
    hash.collect(query % 20, query % 3, 1.5, SOLID);
  }
  assert.equal(hash.candidates().buffer, first.buffer, 'queries reuse one candidate allocation');
  assert.ok(hash.diagnostics.candidates > 0, 'the queries actually saw candidates');

  // A caller-supplied `out` object is written into, never replaced.
  const out = {};
  for (let query = 0; query < 200; query++) {
    const result = hash.sweepCircle(0, 0, 100, 0, .3, out, SOLID);
    assert.equal(result, out, 'the sweep writes into the caller buffer');
  }
  assert.equal(out.hit, true);
});

test('the cap ceiling is wired into the low-profile budget', () => {
  assert.equal(GDO_LOW_PROFILE_BUDGETS.dynamicProxies, 64);
  const within = evaluateLowProfileBudget({ dynamicProxies: 64 });
  assert.equal(within.ok, true);
  assert.ok(within.checked.some(item => item.metric === 'dynamicProxies'), 'the ceiling participates in the budget');
  const over = evaluateLowProfileBudget({ dynamicProxies: 65 });
  assert.equal(over.ok, false);
  assert.equal(over.breaches[0].metric, 'dynamicProxies');
  assert.equal(over.breaches[0].ceiling, 64);
  assert.match(over.breaches[0].label, /active dynamic proxies/);
});

test('COL-09: a world defaults to the 64-proxy profile and its solids block and clip', () => {
  withStubWorker(() => {
    const world = new GeoWorld(new THREE.Scene(), { latitude: 0, longitude: 0 });
    try {
      assert.equal(world.dynamicProxies.cap, 64, 'coordinate mode ships the low profile');
      assert.equal(world.dynamicProxies.activeCount, 0);

      // No static geometry is needed: this is a bare world with one dynamic solid.
      const handle = world.addDynamicProxy({
        shape: 'box', minX: -1, minZ: -1, maxX: 1, maxZ: 1,
        y0: 0, y1: 2, mask: SOLID | CAMERA, ownerKey: 'car',
      });
      assert.equal(world.collidesCircle(0, 0, .2, SOLID), true, 'a dynamic solid blocks the player query');
      assert.equal(world.collidesCircle(3, 0, .2, SOLID), false, 'and only where it is');
      assert.equal(world.collidesCircle(0, 0, .2, GEO_QUERY_MASK.PLACEMENT), false,
        'a SOLID|CAMERA proxy must stay out of placement queries, exactly like a static one');

      // The merged sweep reports the dynamic contact and labels it as dynamic.
      // The moving circle contacts the expanded box at minX - radius = -1.3, which
      // is 4.7 of the 12-unit displacement from x = -6.
      const sweep = world.sweepCircle(-6, 0, 12, 0, .3, {}, SOLID);
      assert.equal(sweep.hit, true);
      assert.ok(Math.abs(sweep.time - 4.7 / 12) < 1e-9, `expected contact at x=-1.3, received ${sweep.time}`);
      assert.equal(sweep.dynamicHandle, handle, 'the merged sweep identifies the dynamic proxy');
      assert.equal(sweep.dynamicOwner, 'car');
      assert.equal(sweep.tileKey, null, 'a dynamic contact does not pretend to be a tile footprint');

      // A moving solid keeps blocking from its new position.
      assert.equal(world.updateDynamicProxy(handle, { minX: 9, maxX: 11 }), true);
      assert.equal(world.collidesCircle(0, 0, .2, SOLID), false);
      assert.equal(world.collidesCircle(10, 0, .2, SOLID), true);
      assert.equal(world.dynamicProxyDiagnostics.reinserts, 1);

      // The camera path sees the same solid through sweepSphere: from x = 0 the
      // 12-unit ray reaches the expanded face at 9 - 0.3 = 8.7.
      const sphereHit = world.sweepSphere(0, 1, 0, 12, 0, 0, .3, {}, CAMERA);
      assert.equal(sphereHit.hit, true);
      assert.equal(sphereHit.dynamicOwner, 'car');
      assert.ok(Math.abs(sphereHit.time - 8.7 / 12) < 1e-9, `expected a contact at x=8.7, received ${sphereHit.time}`);
      assert.equal(sphereHit.tileKey, null);
      // `clipCamera` merges the same sweep with the procedural terrain fallback, so
      // an earlier terrain contact is a legitimate reason to stop sooner; what is
      // asserted is that it never travels past the dynamic solid.
      const clipped = world.clipCamera(new THREE.Vector3(0, 1, 0), new THREE.Vector3(12, 1, 0), .3, {});
      assert.equal(clipped.blocked, true, 'the camera boom is shortened');
      assert.ok(clipped.amount <= 8.7 / 12 + 1e-9, `the camera must not pass the proxy, ended at ${clipped.amount}`);
      assert.ok(world.queryDiagnostics.dynamicHits > 0);
      assert.ok(world.queryDiagnostics.maxDynamicCandidates >= 1);

      // Disposal releases the hash with the world.
      world.dispose();
      assert.equal(world.dynamicProxies.activeCount, 0);
      assert.equal(world.dynamicProxies.cellCount, 0);
    } finally {
      if (!world.disposed) world.dispose();
    }
  });
});

test('COL-09: a world can be given a higher profile, and an explicit cap overrides it', () => {
  withStubWorker(() => {
    const balanced = new GeoWorld(new THREE.Scene(), { latitude: 0, longitude: 0, dynamicProxyProfile: 'balanced' });
    const custom = new GeoWorld(new THREE.Scene(), { latitude: 0, longitude: 0, dynamicProxyCap: 8 });
    try {
      assert.equal(balanced.dynamicProxies.cap, GEO_DYNAMIC_PROXY_CAPS.balanced);
      assert.equal(custom.dynamicProxies.cap, 8);
      for (let index = 0; index < 8; index++) {
        custom.addDynamicProxy(circleSpec({ x: index * 6, ownerKey: `agent-${index}` }));
      }
      assert.throws(() => custom.addDynamicProxy(circleSpec({ x: 100 })), GeoDynamicProxyCapError);
      assert.equal(custom.removeDynamicProxiesFor('agent-3'), 1);
      assert.equal(custom.addDynamicProxy(circleSpec({ x: 100, ownerKey: 'agent-9' })) > 0, true,
        'releasing a slot lets the next proxy in');
    } finally {
      balanced.dispose();
      custom.dispose();
    }
  });
});
