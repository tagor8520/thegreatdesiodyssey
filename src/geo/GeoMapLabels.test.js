import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GEO_MAP_LABEL_LAYOUT,
  GEO_MAP_LABEL_NAMESPACE,
  GEO_MAP_LABEL_OFFSETS,
  GEO_MAP_LABEL_PROFILES,
  createMapLabelLayer,
  mapLabelBudgetForProfile,
} from './GeoMapLabels.js';
import { featureNamespace } from '../engine/FeatureVersions.js';
import { GEO_QUERY_MASK } from './GeoCollision.js';
import { createLabelLosTester } from './GeoLabelLos.js';

/**
 * `LAY-05` gate: the DOM label layer shows a name only when it is unoccluded,
 * on screen, near enough, and not stacking on a name already placed, and it can
 * never grow more elements than its profile allows.
 */

/** A DOM stand-in: the module only touches these five members. */
function createPool() {
  const created = [];
  const create = () => {
    const element = {
      hidden: true, textContent: '', dataset: {},
      style: { transform: '', opacity: '' },
      remove() { element.removed = true; },
      removed: false,
    };
    created.push(element);
    return element;
  };
  return {
    created,
    layer: { children: [], append(element) { this.children.push(element); } },
    create,
  };
}

/** A camera stand-in: the projection is the caller's, so `three` is not needed. */
function createProjector({ yaw = 0, x = 0, z = 0, width = 1_280, height = 720 } = {}) {
  return (labelX, labelY, labelZ, out) => {
    const dx = labelX - x, dz = labelZ - z;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const depth = dz * cos - dx * sin;
    if (depth >= .5) { out.x = 99; out.y = 99; out.z = 2; return out; }
    out.x = (dx * cos + dz * sin) / Math.max(.5, -depth);
    out.y = (labelY - 2) / Math.max(.5, -depth);
    out.z = Math.min(.99, Math.max(-.99, -depth / 100));
    return out;
  };
}

const labels = [
  { name: 'Near Place', kind: 'place', x: 0, y: 0, z: -8 },
  { name: 'Far Place', kind: 'place', x: 0, y: 0, z: -400 },
  { name: 'Behind', kind: 'poi', x: 0, y: 0, z: 60 },
  { name: 'Stacked Twin', kind: 'place', x: 0, y: 0, z: -8.05 },
  { name: 'Side Street', kind: 'street', x: 30, y: 0, z: -8 },
];

test('the label budget is declared per profile and capped', () => {
  assert.equal(GEO_MAP_LABEL_NAMESPACE, featureNamespace('mapLabels'));
  assert.equal(GEO_MAP_LABEL_NAMESPACE, 'gdo:mapLabels:v1');
  assert.deepEqual(Object.keys(GEO_MAP_LABEL_PROFILES), ['low', 'balanced', 'high']);
  assert.equal(mapLabelBudgetForProfile('low'), GEO_MAP_LABEL_PROFILES.low);
  assert.equal(mapLabelBudgetForProfile('unknown'), GEO_MAP_LABEL_PROFILES.low);
  assert.ok(GEO_MAP_LABEL_PROFILES.low.maxElements <= GEO_MAP_LABEL_PROFILES.balanced.maxElements);
  assert.ok(GEO_MAP_LABEL_PROFILES.balanced.maxElements <= GEO_MAP_LABEL_PROFILES.high.maxElements);
  assert.equal(GEO_MAP_LABEL_OFFSETS.place, 1.25);
  assert.ok(GEO_MAP_LABEL_LAYOUT.collisionHalfWidth > GEO_MAP_LABEL_LAYOUT.collisionHalfHeight);
});

test('sparse placement: occluded, offscreen, distant and overlapping names stay hidden', () => {
  const pool = createPool();
  const layer = createMapLabelLayer({
    profile: 'low', layer: pool.layer, createElement: pool.create,
    camera: { position: { x: 0, y: 2, z: 0 } },
  });
  try {
    const visible = layer.layout(labels, {
      screen: { width: 1_280, height: 720 },
      project: createProjector(),
      nowMilliseconds: 0,
    });
    const names = visible.map(label => label.name);
    // The near place wins; its stacked twin collides with it and stays hidden.
    assert.deepEqual(names, ['Near Place']);
    assert.equal(layer.poolSize, 1, 'only placed labels create elements');
    assert.equal(pool.created[0].hidden, false);
    assert.equal(pool.created[0].textContent, 'Near Place');
    assert.equal(pool.created[0].dataset.kind, 'place');
    assert.match(pool.created[0].style.transform, /^translate3d\(/);
    assert.ok(Number(pool.created[0].style.opacity) >= GEO_MAP_LABEL_PROFILES.low.minOpacity);
    // The counters describe the frame that just ran, so read them before the next.
    const first = layer.diagnostics();
    assert.equal(first.hiddenOffscreen >= 1, true, 'the label behind the camera is counted offscreen');
    assert.equal(first.hiddenRange >= 1, true, 'the far label is counted out of range');
    assert.equal(first.hiddenOverlap >= 1, true, 'the stacked twin is counted as an overlap');

    // A wider field of view sees more, and the layer reuses its pool.
    const wide = layer.layout(labels, {
      screen: { width: 1_280, height: 720 },
      project: createProjector({ yaw: .9 }),
      nowMilliseconds: 40,
    });
    assert.ok(wide.length >= 1);
    assert.ok(layer.poolSize <= GEO_MAP_LABEL_PROFILES.low.maxElements);

    const diagnostics = layer.diagnostics();
    assert.equal(diagnostics.namespace, GEO_MAP_LABEL_NAMESPACE);
    assert.equal(diagnostics.frames, 2);
    assert.equal(diagnostics.candidates, labels.length);
    assert.equal(diagnostics.poolCap, GEO_MAP_LABEL_PROFILES.low.maxElements);
    assert.equal(diagnostics.steadyFrameAllocations, 0);
    assert.equal(diagnostics.visible + diagnostics.hidden, labels.length);
  } finally {
    layer.dispose();
  }
});

test('the element pool is capped, and a crowded map cannot grow it', () => {
  const pool = createPool();
  const layer = createMapLabelLayer({
    profile: 'low', layer: pool.layer, createElement: pool.create,
  });
  try {
    // 64 names spread across the view, all inside the label range: far more than
    // the low-profile cap can place.
    const crowd = Array.from({ length: 64 }, (_, index) => ({
      name: `Crowd ${index}`, kind: 'street',
      x: (index % 8) * 5 - 17.5, y: 0, z: -30 - Math.floor(index / 8) * .5,
    }));
    const visible = layer.layout(crowd, {
      screen: { width: 1_280, height: 720 },
      project: createProjector(),
      nowMilliseconds: 0,
    });
    assert.ok(visible.length <= GEO_MAP_LABEL_PROFILES.low.maxVisible);
    assert.equal(layer.poolSize, visible.length);
    assert.ok(layer.poolSize <= GEO_MAP_LABEL_PROFILES.low.maxElements,
      `pool ${layer.poolSize} stayed under the ${GEO_MAP_LABEL_PROFILES.low.maxElements} cap`);
    const crowded = layer.diagnostics();
    assert.ok(crowded.hiddenOverflow >= 1, 'the overflow is counted, not ignored');
    for (let frame = 0; frame < 20; frame++) {
      layer.layout(crowd, {
        screen: { width: 1_280, height: 720 },
        project: createProjector({ yaw: frame * .1 }),
        nowMilliseconds: frame * 33,
      });
    }
    assert.ok(layer.poolSize <= GEO_MAP_LABEL_PROFILES.low.maxElements,
      'twenty more frames never grew the pool past the cap');
    assert.ok(pool.layer.children.length <= GEO_MAP_LABEL_PROFILES.low.maxElements);
    // Losing the labels hides the pool instead of leaving stale names on screen.
    assert.deepEqual(layer.layout([], { screen: { width: 1_280, height: 720 }, project: createProjector() }), []);
    assert.equal(pool.created.every(element => element.hidden), true, 'an empty frame hides every pooled name');
    assert.equal(layer.reset(), true);
    layer.dispose();
    assert.equal(pool.created.every(element => element.removed), true, 'dispose removes the nodes it created');
    assert.equal(layer.poolSize, 0);
  } finally {
    layer.dispose();
  }
});

test('the LOS verdict is the first filter and occluded names never take a slot', () => {
  const pool = createPool();
  // A world with exactly one LOS blocker, tested through the tester's real
  // positional sweep contract.
  // The blocker sits exactly on the eye-to-anchor ray for "Blocked" (y 1.3 at
  // z -4) and far from the ray to "Open".
  const blocker = { x: 0, y: 1.3, z: -4 };
  const world = {
    sweepSphere(fromX, fromY, fromZ, dx, dy, dz, radius, out = {}, mask) {
      assert.equal(mask, GEO_QUERY_MASK.LOS_BLOCKER, 'labels only test LOS blockers');
      const lengthSq = dx * dx + dy * dy + dz * dz;
      const t = lengthSq > 0
        ? Math.max(0, Math.min(1, ((blocker.x - fromX) * dx + (blocker.y - fromY) * dy + (blocker.z - fromZ) * dz) / lengthSq))
        : 0;
      const distance = Math.hypot(
        fromX + dx * t - blocker.x, fromY + dy * t - blocker.y, fromZ + dz * t - blocker.z);
      out.hit = distance <= radius;
      out.time = t;
      out.clearance = out.hit ? -distance : distance;
      out.blocked = out.hit;
      return out;
    },
  };
  const tester = createLabelLosTester({ world, profile: 'low' });
  const layer = createMapLabelLayer({ profile: 'low', layer: pool.layer, createElement: pool.create, tester });
  const named = [
    { name: 'Blocked', kind: 'street', x: 0, y: 0, z: -9 },
    { name: 'Open', kind: 'street', x: 22, y: 0, z: -9 },
  ];
  const frame = now => layer.layout(named, {
    camera: { position: { x: 0, y: 2, z: 0 } },
    screen: { width: 1_280, height: 720 },
    project: createProjector(),
    nowMilliseconds: now,
  });
  try {
    // The tester's budget refills from elapsed time, so the first frame at t=0
    // spends nothing and the second frame at t=1s tests the labels.
    frame(0);
    const visible = frame(1_000);
    assert.deepEqual(visible.map(label => label.name), ['Open'], 'the occluded name is not shown');
    assert.ok(layer.diagnostics().hiddenOccluded >= 1, 'and it is reported as occluded');
    assert.ok(tester.diagnostics().tests >= 2, 'the LOS budget was actually spent');
    assert.equal(tester.diagnostics().hidden >= 1, true);
  } finally {
    layer.dispose();
  }
});

test('a layer built without a projector or screen refuses to guess', () => {
  const pool = createPool();
  const layer = createMapLabelLayer({ profile: 'low', layer: pool.layer, createElement: pool.create });
  try {
    assert.throws(() => layer.layout(null, {}), /array of labels/);
    assert.throws(() => layer.layout([], { screen: { width: 10, height: 10 } }), /project\(x, y, z, out\)/);
    assert.throws(() => layer.layout([], { project: createProjector() }), /project\(x, y, z, out\)/);
  } finally {
    layer.dispose();
  }
});
