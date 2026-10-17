import test from 'node:test';
import assert from 'node:assert/strict';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import {
  DynamicProxyGrid,
  GDO_DYNAMIC_PROXY_KIND,
  GDO_DYNAMIC_PROXY_NAMESPACE,
  GDO_DYNAMIC_PROXY_PROFILES,
  dynamicProxyCapForProfile,
} from './DynamicProxyGrid.js';
import { featureNamespace } from './FeatureVersions.js';

/**
 * `COL-09` gate: the capped dynamic spatial hash for moving solid proxies —
 * primitive-only proxies, boundary-crossing reinsertion, profile caps that skip
 * deterministically, and a merged query the movement layer can consume.
 */

const CIRCLE = (x, z, radius = 1, ySpan = [0, 2]) => ({ kind: GDO_DYNAMIC_PROXY_KIND.CIRCLE, x, z, radius, ySpan });
const BOX = (minX, minZ, maxX, maxZ, ySpan = [0, 3]) => ({ kind: GDO_DYNAMIC_PROXY_KIND.BOX, minX, minZ, maxX, maxZ, ySpan });

test('the dynamic proxy contract matches the researched caps', () => {
  assert.equal(GDO_DYNAMIC_PROXY_NAMESPACE, 'gdo:dynamicProxy:v1');
  assert.equal(featureNamespace('dynamicProxy'), GDO_DYNAMIC_PROXY_NAMESPACE);
  assert.equal(dynamicProxyCapForProfile('low'), 64);
  assert.equal(dynamicProxyCapForProfile('balanced'), 128);
  assert.equal(dynamicProxyCapForProfile('high'), 256);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.dynamicProxies, 64);
  assert.throws(() => dynamicProxyCapForProfile('unknown'), /Unknown dynamic proxy profile/);
  assert.throws(() => new DynamicProxyGrid({ profile: 'unknown' }), /Unknown dynamic proxy profile/);
  assert.throws(() => new DynamicProxyGrid({ maxProxies: 65 }), /cap must be 1–64/);
  assert.throws(() => new DynamicProxyGrid({ cellSize: 0 }), /cell size must be positive/);
});

test('primitive-only proxies are validated instead of guessing shapes', () => {
  const grid = new DynamicProxyGrid({ profile: 'low' });
  assert.equal(grid.insert('circle', CIRCLE(0, 0)), 'circle');
  assert.equal(grid.insert('capsule', { kind: 'capsule', ax: 0, az: 0, bx: 4, bz: 0, radius: .5, ySpan: [0, 1.8] }), 'capsule');
  assert.equal(grid.insert('box', BOX(10, 10, 12, 12)), 'box');
  assert.equal(grid.insert('obb', { kind: 'obb', x: 20, z: 20, halfX: 2, halfZ: 1, rotation: Math.PI / 4, ySpan: [0, 1.5] }), 'obb');
  assert.equal(grid.insert('compound', {
    kind: 'compound',
    primitives: [CIRCLE(30, 30, .6), BOX(31, 30, 32, 31, [0, 2]), { kind: 'capsule', ax: 29, az: 31, bx: 30, bz: 31, radius: .3, ySpan: [0, 1] }],
  }), 'compound');
  assert.equal(grid.activeProxies, 5);
  assert.throws(() => grid.insert('bad-kind', { kind: 'torus', x: 0, z: 0 }), /Unknown dynamic proxy kind/);
  assert.throws(() => grid.insert('no-span', { kind: 'circle', x: 0, z: 0, radius: 1 }), /finite \[minY, maxY\] span/);
  assert.throws(() => grid.insert('bad-radius', { kind: 'circle', x: 0, z: 0, radius: 0, ySpan: [0, 1] }), /positive radius/);
  assert.throws(() => grid.insert('bad-box', { kind: 'box', minX: 4, minZ: 0, maxX: 1, maxZ: 1, ySpan: [0, 1] }), /ordered bounds/);
  assert.throws(() => grid.insert('empty-compound', { kind: 'compound', primitives: [] }), /needs primitives/);
  assert.throws(() => grid.insert('', CIRCLE(0, 0)), /needs an id/);
  assert.throws(() => grid.insert('circle', CIRCLE(0, 0)), /already active/);
  // A decorative box is never promoted to a moving body: only real proxies pass.
  assert.equal(grid.diagnostics().limits.maxProxies, 64);
  grid.dispose();
});

test('the cap refuses over-cap proxies by name instead of growing', () => {
  const grid = new DynamicProxyGrid({ profile: 'low' });
  for (let index = 0; index < 64; index++) {
    assert.equal(grid.insert(`p${index}`, CIRCLE(index * 3, 0)), `p${index}`);
  }
  assert.equal(grid.activeProxies, 64);
  assert.equal(grid.insert('overflow', CIRCLE(0, 40)), null, 'the 65th proxy is refused');
  assert.equal(grid.activeProxies, 64);
  assert.equal(grid.diagnostics().capSkips, 1);
  // Removing one frees exactly one slot; the hash never reallocates.
  assert.equal(grid.remove('p0'), true);
  assert.equal(grid.insert('replacement', CIRCLE(0, 40)), 'replacement');
  assert.equal(grid.activeProxies, 64);
  assert.equal(grid.diagnostics().capSkips, 1, 'a freed slot is not a cap skip');
  // A compound that would span too many cells is refused rather than smeared.
  const small = new DynamicProxyGrid({ profile: 'low', cellSize: 1 });
  assert.equal(small.insert('huge', { kind: 'box', minX: -20, minZ: -20, maxX: 20, maxZ: 20, ySpan: [0, 1] }), null);
  assert.equal(small.diagnostics().reinsertsSkipped, 1);
  assert.equal(small.activeProxies, 0);
  // The balanced and desktop profiles accept the same code with their own caps.
  const balanced = new DynamicProxyGrid({ profile: 'balanced' });
  assert.equal(balanced.diagnostics().maxProxies, 128);
  balanced.dispose(); small.dispose(); grid.dispose();
});

test('a proxy is reinserted only after crossing a cell boundary', () => {
  const grid = new DynamicProxyGrid({ profile: 'low', cellSize: 4 });
  grid.insert('car', BOX(0, 0, 2, 2));
  const inserts = grid.diagnostics().inserts;
  // Small steps inside the same cells cost nothing.
  for (let step = 0; step < 50; step++) assert.equal(grid.move('car', .02, .01), true);
  assert.equal(grid.diagnostics().inserts, inserts, 'no cell churn while inside the same cells');
  assert.equal(grid.diagnostics().reinserts, 0);
  assert.equal(grid.diagnostics().reinsertsSkipped, 50);
  // Crossing the boundary reinserts once and lands in the new cells.
  assert.equal(grid.move('car', 4, 0), true);
  assert.equal(grid.diagnostics().reinserts, 1);
  const candidates = grid.queryCircle(6, 1, .2, 1);
  assert.deepEqual(candidates, ['car']);
  assert.deepEqual(grid.queryCircle(0, 1, .2, 1), [], 'the stale cell no longer lists the proxy');
  // Vertical movement alone does not touch the XZ cells.
  const before = grid.diagnostics().reinserts;
  assert.equal(grid.move('car', 0, 0, { y: 1.5, dy: 1.5 }), true);
  assert.equal(grid.diagnostics().reinserts, before);
  assert.equal(grid.record('car').ySpan[0], 1.5);
  grid.dispose();
});

test('queries filter by role mask, Y span, and shape exactly', () => {
  const grid = new DynamicProxyGrid({ profile: 'low' });
  grid.insert('road-car', CIRCLE(0, 0, 1), { mask: 1 });
  grid.insert('camera-only', CIRCLE(6, 0, 1), { mask: 4 });
  grid.insert('boat', BOX(12, -1, 14, 1, [-.5, .8]), { mask: 2 });

  assert.deepEqual(grid.queryCircle(0, 0, .5, 1), ['road-car']);
  assert.deepEqual(grid.queryCircle(6, 0, .5, 1), [], 'a mask the query does not ask for is skipped');
  assert.deepEqual(grid.queryCircle(6, 0, .5, 4), ['camera-only']);
  assert.deepEqual([...grid.queryCircle(13, 0, .5, 1 | 2 | 4)], ['boat'], 'a local window stays local');
  assert.deepEqual([...grid.queryCircle(7, 0, 12, 1 | 2 | 4)].sort(), ['boat', 'camera-only', 'road-car'],
    'a wide window merges every role the caller asks for');

  // Exact overlap: the circle edge is inside, a point outside is not.
  assert.equal(grid.overlapsCircle(1.1, 0, .2, { minY: 0, maxY: 1.8 })?.id, 'road-car');
  assert.equal(grid.overlapsCircle(1.5, 0, .2, { minY: 0, maxY: 1.8 }), null, 'the reach is radius + radius exactly');
  // The Y span gates the hit: a wading body under a hull is not blocked.
  assert.equal(grid.overlapsCircle(13, 0, .4, { minY: 1.5, maxY: 2.2, queryMask: 2 }), null);
  assert.equal(grid.overlapsCircle(13, 0, .4, { minY: .2, maxY: 1.5, queryMask: 2 })?.id, 'boat');

  // Sweeps: earliest hit wins, and a miss stays a miss.
  const circle = grid.sweepCircle(-6, 0, 12, 0, .4, { minY: 0, maxY: 1.8 });
  assert.equal(circle.id, 'road-car');
  assert.ok(circle.time > .1 && circle.time < .6, `time ${circle.time}`);
  assert.equal(grid.sweepCircle(-6, 40, 12, 0, .4, { minY: 0, maxY: 1.8 }), null);
  assert.equal(grid.sweepCircle(-6, 0, 12, 0, .4, { minY: 5, maxY: 6 }), null, 'a sweep above the roof misses');
  // A zero-length sweep reports an immediate contact instead of dividing by zero.
  assert.equal(grid.sweepCircle(0, 0, 0, 0, .4, { minY: 0, maxY: 1.8 }).time, 0);
  assert.deepEqual(grid.sweepCircle(60, 60, 0, 0, .4, { minY: 0, maxY: 1.8 }), null);
  grid.dispose();
});

test('capsules and OBBs sweep with the same truth as circles and boxes', () => {
  const grid = new DynamicProxyGrid({ profile: 'low' });
  grid.insert('capsule', { kind: 'capsule', ax: 0, az: -3, bx: 0, bz: 3, radius: .5, ySpan: [0, 1.8] });
  grid.insert('obb', { kind: 'obb', x: 20, z: 0, halfX: 1, halfZ: 4, rotation: Math.PI / 2, ySpan: [0, 2] });
  // The capsule blocks a straight walk along +x and leaves the parallel lane open.
  const hit = grid.sweepCircle(-6, 0, 12, 0, .4, { minY: 0, maxY: 1.8 });
  assert.equal(hit.id, 'capsule');
  assert.ok(Math.abs(hit.time - (6 - .9) / 12) < 1e-9, `capsule time ${hit.time}`);
  assert.equal(grid.sweepCircle(-6, 5, 12, 0, .4, { minY: 0, maxY: 1.8 }), null);
  // Rotating the OBB by 90° puts its long axis on world +x (16…24) and its short
  // axis on z (−1…1): the sweep sees the long side, and the lateral lane is open.
  const obb = grid.sweepCircle(10, 0, 12, 0, .4, { minY: 0, maxY: 1.8 });
  assert.equal(obb.id, 'obb');
  assert.ok(obb.time > 0 && obb.time < 1);
  assert.equal(grid.overlapsCircle(23, .5, .2, { minY: 0, maxY: 1 })?.id, 'obb');
  assert.equal(grid.overlapsCircle(20, 2, .2, { minY: 0, maxY: 1 }), null, 'outside the short axis');
  assert.equal(grid.overlapsCircle(25.5, 0, .2, { minY: 0, maxY: 1 }), null, 'outside the long axis');
  assert.equal(grid.sweepCircle(10, 6, 12, 0, .4, { minY: 0, maxY: 1.8 }), null, 'the lane beside it is clear');
  grid.dispose();
});

test('a compound proxy uses its earliest primitive and stays bounded', () => {
  const grid = new DynamicProxyGrid({ profile: 'low' });
  grid.insert('train', {
    kind: 'compound',
    primitives: [
      BOX(0, 0, 8, 2, [0, 3]),
      BOX(8, 0, 16, 2, [0, 3]),
      CIRCLE(18, 1, 2, [0, 3]),
    ],
  });
  const near = grid.sweepCircle(-6, 1, 24, 0, .4, { minY: 0, maxY: 1.8 });
  assert.equal(near.id, 'train');
  assert.ok(Math.abs(near.time - (6 - .4) / 24) < 1e-9, `compound time ${near.time}`);
  assert.equal(near.primitive, 0, 'the first mass answers for a sweep that reaches it first');
  // Every primitive participates: a sweep starting inside the second mass reports
  // immediate contact against that primitive, and the round mass counts too.
  const second = grid.sweepCircle(9, 1, 14, 0, .4, { minY: 0, maxY: 1.8, queryMask: 1 });
  assert.equal(second.id, 'train');
  assert.equal(second.primitive, 1);
  assert.equal(second.time, 0);
  assert.equal(grid.overlapsCircle(18, 1, .5, { minY: 0, maxY: 1 })?.id, 'train');
  assert.equal(grid.overlapsCircle(4, 6, .2, { minY: 0, maxY: 1 }), null, 'the L gap stays open');
  assert.throws(() => grid.insert('too-many', {
    kind: 'compound',
    primitives: [CIRCLE(0, 0, .2), CIRCLE(1, 0, .2), CIRCLE(2, 0, .2), CIRCLE(3, 0, .2), CIRCLE(4, 0, .2)],
  }), /exceeds 4 primitives/);
  // A compound is never exploded into per-box dynamic bodies.
  assert.equal(grid.activeProxies, 1);
  assert.deepEqual(grid.diagnostics().limits.maxProxies, 64);
  grid.dispose();
});

test('the grid is allocation-free in steady state, ordered, and disposable', () => {
  const grid = new DynamicProxyGrid({ profile: 'low' });
  for (let index = 0; index < 8; index++) grid.insert(`p${index}`, CIRCLE(index, 0, .5));
  const out = [];
  const first = grid.queryCircle(4, 0, 3, 1, out);
  assert.equal(first, out, 'the caller array is reused');
  const expected = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  assert.deepEqual([...first], expected, 'cell order and insertion order both stay stable');
  const second = grid.queryCircle(4, 0, 3, 1, out);
  assert.equal(second, out);
  assert.deepEqual([...second], expected);
  assert.equal(grid.diagnostics().steadyFrameAllocations, 0);
  assert.equal(grid.diagnostics().queries, 2);
  assert.equal(grid.diagnostics().maxCandidates >= 6, true);

  // Identity, removal, and disposal semantics.
  assert.equal(grid.has('p3'), true);
  assert.equal(grid.remove('p3'), true);
  assert.equal(grid.remove('p3'), false);
  assert.equal(grid.activeProxies, 7);
  assert.equal(grid.queryCircle(4, 0, 3, 1).includes('p3'), false);
  grid.clear();
  assert.equal(grid.activeProxies, 0);
  assert.equal(grid.diagnostics().cells, 0);
  const disposed = new DynamicProxyGrid({ profile: 'low' });
  disposed.dispose();
  assert.equal(disposed.diagnostics().disposed, true);
  assert.throws(() => disposed.insert('late', CIRCLE(0, 0)), /disposed/);
  assert.throws(() => disposed.queryCircle(0, 0, 1, 1), /disposed/);
  assert.throws(() => disposed.sweepCircle(0, 0, 1, 0, .3, {}), /disposed/);
  // Disposal is idempotent, and a remount reuses the same grid contract.
  disposed.dispose();
  assert.throws(() => disposed.insert('bad-move', CIRCLE(0, 0)), /disposed/);
  assert.equal(grid.diagnostics().disposed, false, 'the live grid is untouched by another grid disposing');
});
