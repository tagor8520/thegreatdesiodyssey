/**
 * `DET-09` — landmark grammar and openings (Node tier).
 *
 * Registered gate (feature-roadmap/README.md order 098):
 *   "Repeated modules batched; arches never use one enclosing AABB"
 *
 * Each clause is a claim that can be false while a screenshot looks right, so each is
 * measured rather than described:
 *
 * 1. **Repeated modules batched** — the landmark's boxes come from *declared loops* (a share
 *    the compiler reports, over 0.9 for both shipped landmarks) and they are stamped into
 *    **one** `VoxelBatch`, which instances by material family. So the draw cost of the
 *    108-box chariot is the number of families it uses. That is counted, not asserted.
 * 2. **Arches never use one enclosing AABB** — the Gateway declares its opening as a
 *    *profile* (a stack of bands, each with a free half-width) and the compiler refuses any
 *    box or proxy that enters it. The sharp form of the claim is checked directly: no single
 *    proxy spans the doorway, the passage is clear for a walker and a camera, the masonry
 *    beside and above the opening *is* solid, and a probe that would have filled the arch —
 *    which the parity fixture proves the pre-`DET-09` code shipped — is rejected.
 * 3. **The port changed nothing visible** — every compiled box is compared against
 *    `GeoLandmarks.legacy.js`, a table captured by *executing* the pre-`DET-09` loops, not by
 *    transcribing them. Parity is exact, including rotations and colours.
 *
 * The negative controls that make the browser tier falsifiable live in
 * `tools/visual-audit/scenarios/landmark-openings.mjs`; this file is the deterministic half.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GEO_LANDMARK_BOX_BUDGETS,
  GEO_LANDMARK_ROLE,
  GEO_LANDMARK_VOID_TOLERANCE,
  boxIntrudesIntoVoid,
  compileLandmark,
  createLandmarkDefinition,
  landmarkBatches,
  landmarkCameraBlockers,
  landmarkPassageClear,
  landmarkProxyId,
  landmarkVoidHalfWidthAt,
  stampLandmark,
} from './GeoLandmarkGrammar.js';
import { CHARIOT_LANDMARK, GATEWAY_LANDMARK, GEO_LANDMARK_DEFINITIONS } from './GeoLandmarks.js';
import { GEO_LEGACY_LANDMARK_BOXES } from './GeoLandmarks.legacy.js';

const ORIGINS = { gateway: { x: -66, z: -44 }, chariot: { x: 62, z: -44 } };
const compile = (name, profile = 'low') =>
  compileLandmark(GEO_LANDMARK_DEFINITIONS[name], { profile, origin: ORIGINS[name] });

const round6 = value => Number(value.toFixed(6));
const boxKey = box => [
  round6(box.x), round6(box.y), round6(box.z),
  round6(box.sx ?? box.sizeX), round6(box.sy ?? box.sizeY), round6(box.sz ?? box.sizeZ),
  box.color, (box.rotation ?? [0, 0, 0]).map(round6).join(','),
].join('|');

test('the port is geometry-neutral: every compiled box matches the pre-DET-09 loop', () => {
  for (const name of ['gateway', 'chariot']) {
    const compiled = compile(name);
    const mine = compiled.boxes.map(box => boxKey({
      x: box.x - compiled.origin.x, y: box.y - compiled.base, z: box.z - compiled.origin.z,
      sizeX: box.sizeX, sizeY: box.sizeY, sizeZ: box.sizeZ, color: box.color, rotation: box.rotation,
    })).sort();
    const legacy = GEO_LEGACY_LANDMARK_BOXES[name].map(boxKey).sort();
    assert.equal(mine.length, legacy.length, `${name}: box count changed`);
    assert.deepEqual(mine, legacy, `${name}: the compiled boxes differ from the shipped loops`);
  }
  // Spelled out, because these are the numbers the curated runtime draws: 50 + 108 boxes.
  assert.equal(compile('gateway').diagnostics.emittedBoxes, 50);
  assert.equal(compile('chariot').diagnostics.emittedBoxes, 108);
  assert.equal(GEO_LEGACY_LANDMARK_BOXES.gateway.length, 50);
  assert.equal(GEO_LEGACY_LANDMARK_BOXES.chariot.length, 108);
  // And the camera blockers are the same 34 the curated camera gate addresses by id.
  const ids = [...compile('gateway').proxies, ...compile('chariot').proxies].map(proxy => proxy.id);
  assert.equal(ids.length, 34);
  assert.equal(new Set(ids).size, ids.length, 'proxy ids must be unique or a gate cannot address one');
  for (const wanted of ['gateway:plinth', 'gateway:pier:-1', 'gateway:pier:1', 'gateway:tower:-11:-4',
    'gateway:lintel', 'gateway:arch:1:4', 'chariot:plinth', 'chariot:body', 'chariot:roof:5',
    'chariot:wheel:-5:-5', 'chariot:column:5:5']) {
    assert.ok(ids.includes(wanted), `the pre-DET-09 id ${wanted} must survive the port`);
  }
});

test('repeated modules carry the geometry, and one batch carries the draws', () => {
  const compiled = compile('chariot');
  const report = compiled.diagnostics;
  assert.equal(report.declaredModules, 6, 'the chariot is six declarations');
  assert.equal(report.sites, 20, 'expanded to twenty sites');
  assert.ok(report.repeatedShare > 0.9, `the chariot is mostly loop-built, got ${report.repeatedShare}`);
  // The wheels are four sites of geometry each: 8 modules become 64 rim stones and 32 spokes.
  const rim = compiled.boxes.filter(box => box.moduleId === 'wheel-rims');
  const spokes = compiled.boxes.filter(box => box.moduleId === 'wheel-spokes');
  const roof = compiled.boxes.filter(box => box.moduleId === 'roof');
  assert.equal(rim.length, 64, 'four wheels of sixteen rim stones');
  assert.equal(spokes.length, 32, 'four wheels of eight spokes');
  assert.equal(roof.length, 6, 'six roof tiers from one loop');
  // One material family: the shipped landmarks are single-material, so one instanced draw.
  const batches = landmarkBatches(compiled);
  assert.equal(batches.length, 1, 'a single-family landmark is a single draw');
  assert.equal(batches[0].boxes, 108, 'and it carries every box of the landmark');
  assert.equal(batches[0].boxesPerDraw, 108);
  // The Gateway is likewise one family, two draws for the pair.
  assert.equal(landmarkBatches(compile('gateway')).length, 1);
  // `metalness` is the family key, so a second family would show up as a second draw.
  const twoFamilies = createLandmarkDefinition({
    id: 'two-family',
    masses: [
      { id: 'a', box: { y: 1, sizeX: 2, sizeY: 2, sizeZ: 2, color: '#fff' } },
      { id: 'b', box: { y: 1, sizeX: 2, sizeY: 2, sizeZ: 2, color: '#fff', metalness: .5 } },
    ],
    voids: [],
  });
  assert.equal(landmarkBatches(compileLandmark(twoFamilies)).length, 2, 'two families, two boxes, two draws');
});

test('the arches never use one enclosing AABB', () => {
  const compiled = compile('gateway');
  const voidDefinition = Object.values(compiled.voids)[0];
  const [x, z] = [compiled.origin.x, compiled.origin.z];
  // 1. No single proxy contains the opening's free volume: a compound may have a member that
  //    spans the doorway *above* the arch (the lintel does, of course) or *beside* it (the
  //    piers do), but nothing may cover the passage in x, z **and** y at once — that box is
  //    the enclosing AABB this gate forbids, and one such box is exactly what fills an arch.
  const freeAtWalker = landmarkVoidHalfWidthAt(voidDefinition, 5.5);
  const headTop = voidDefinition.bands[voidDefinition.bands.length - 1].top;
  const containsFreeVolume = proxy =>
    proxy.x - proxy.sizeX / 2 <= x - freeAtWalker && proxy.x + proxy.sizeX / 2 >= x + freeAtWalker &&
    proxy.z - proxy.sizeZ / 2 <= z + voidDefinition.offsetZ - voidDefinition.halfDepth &&
    proxy.z + proxy.sizeZ / 2 >= z + voidDefinition.offsetZ + voidDefinition.halfDepth &&
    proxy.y - proxy.sizeY / 2 <= voidDefinition.bottom && proxy.y + proxy.sizeY / 2 >= headTop;
  for (const proxy of compiled.proxies) {
    assert.equal(containsFreeVolume(proxy), false,
      `proxy ${proxy.id} contains the whole opening, which is the enclosing AABB this gate forbids`);
  }
  // The check has teeth: the hypothetical single box is caught by it.
  assert.equal(containsFreeVolume({ id: 'enclosing', x, y: 10, z, sizeX: 30, sizeY: 20, sizeZ: 15 }), true);
  // 2. The walker and the camera get through it. The probes are taken *above the plinth*,
  //    which is a 1 m step the player walks on rather than a wall: the declared passage starts
  //    at the plinth top, and a body centre at that height would intersect the step it stands
  //    on. The camera probe is the height the shipped `clipCamera` test uses.
  assert.equal(landmarkPassageClear(compiled, { y: 5.5, fromZ: z - 16, toZ: z + 16, radius: .6 }), true,
    'a 0.6 m walker must pass under the arch');
  assert.equal(landmarkPassageClear(compiled, { y: 10, fromZ: z - 16, toZ: z + 16, radius: .6 }), true,
    'and so must a camera at 10 m');
  // 3. The masonry beside and above the opening is solid: closing the gap would not be a fix.
  assert.equal(landmarkPassageClear(compiled, { y: 10, x: x - 9, fromZ: z - 16, toZ: z + 16, radius: .6 }), false,
    'the pier line is masonry, not passage');
  assert.equal(
    compiled.boxes.some(box => box.y + box.sizeY / 2 > 13.35 && box.y - box.sizeY / 2 < 20 && Math.abs(box.x - x) < 14 && Math.abs(box.sizeX) > 20),
    true, 'the lintel spans the opening above the arch head',
  );
  // 4. Above the declared head the free width is gone — the profile ends, the lintel begins —
  //    so the arch head is not a gap a camera or a body can slip through.
  assert.equal(landmarkVoidHalfWidthAt(voidDefinition, 17), 0);
  assert.equal(landmarkVoidHalfWidthAt(voidDefinition, 3), 0, 'nor is the plinth a passage');
  assert.equal(landmarkPassageClear(compiled, { y: 17, fromZ: z - 16, toZ: z + 16, radius: .6 }), false,
    'the arch head is where the opening ends');
  // 5. The void is a *profile*, not one number: it narrows as it climbs.
  const widths = [1, 10, 14, 15, 16, 17].map(y => landmarkVoidHalfWidthAt(voidDefinition, y));
  assert.deepEqual(widths, [0, 4.5, 3.6, 2.95, 2.3, 0], 'the free width must step in with the voussoirs, then end at the head');
});

test('the probe that would have filled the arch is refused and counted', () => {
  // The control the browser tier re-runs live, in its deterministic form: a box laid across
  // the opening — exactly the shape the pre-DET-09 combined AABB would have had.
  const gateway = GATEWAY_LANDMARK;
  const definition = createLandmarkDefinition({
    id: 'gateway-as-one-box',
    base: gateway.base,
    voids: Object.values(gateway.voids),
    masses: [
      ...gateway.modules.filter(module => module.role === GEO_LANDMARK_ROLE.SILHOUETTE),
      { id: 'enclosing-aabb', order: 99, box: { y: 10, sizeX: 30, sizeY: 20, sizeZ: 15, color: '#c6a06b' }, structural: true },
    ],
    accents: gateway.modules.filter(module => module.role === GEO_LANDMARK_ROLE.ACCENT),
  });
  const compiled = compileLandmark(definition, { origin: ORIGINS.gateway });
  assert.ok(compiled.diagnostics.intrusions > 0, 'the enclosing mass must be refused');
  assert.equal(compiled.boxes.some(box => box.moduleId === 'enclosing-aabb'), false, 'and it must not be drawn');
  assert.equal(landmarkPassageClear(compiled, { y: 5.5, fromZ: -60, toZ: -28, radius: .6 }), true,
    'the genuine opening survives the refused mass');
  // A proxy that would block the passage is refused too, and reported separately.
  const blockingProxy = createLandmarkDefinition({
    id: 'gateway-with-blocking-proxy',
    base: gateway.base,
    voids: Object.values(gateway.voids),
    masses: [
      // The drawn post stands with the pier, clear of the passage; its *collision* is a
      // landmark-wide slab. That is the shape of the defect the rule exists for, and it is
      // refused rather than merely reported.
      { id: 'poster', box: { x: 9, y: 12, sizeX: 1.4, sizeY: 16, sizeZ: 1.4, color: '#c6a06b' }, proxy: { x: 0, y: 10, sizeX: 30, sizeY: 20, sizeZ: 15 } },
    ],
    accents: [],
  });
  const blocked = compileLandmark(blockingProxy, { origin: ORIGINS.gateway });
  assert.equal(blocked.diagnostics.proxyIntrusions, 1, 'a proxy that would fill the opening is counted');
  assert.equal(blocked.proxies.length, 0, 'and is not emitted as a collider');
  assert.equal(blocked.diagnostics.intrusions, 0, 'the drawn box is inside the masonry, not in the opening');
});

test('visual modules never create colliders, and every accent says so', () => {
  // §17.2 "visual boxes that create colliders automatically: 0", expressed as a rule about
  // roles: an accent module contributes no proxy, in either shipped landmark.
  for (const name of ['gateway', 'chariot']) {
    const compiled = compile(name);
    const accentModules = new Set(compiled.boxes.filter(box => box.role === GEO_LANDMARK_ROLE.ACCENT).map(box => box.moduleId));
    assert.ok(accentModules.size > 0, `${name} must have accents, or this rule is vacuous`);
    for (const moduleId of accentModules) {
      assert.equal(compiled.proxies.some(proxy => proxy.id.includes(moduleId)), false,
        `${name}: accent module ${moduleId} produced a collider`);
    }
  }
  // The Gateway's finials and crenellations are accents; its voussoirs are masonry.
  assert.equal(compile('gateway').proxies.length, 18);
  assert.equal(compile('chariot').proxies.length, 16);
  assert.equal(compile('gateway').boxes.filter(box => box.moduleId === 'tower-finials').length, 4);
  assert.equal(compile('gateway').boxes.filter(box => box.moduleId === 'crenellations').length, 14);
  assert.equal(compile('gateway').boxes.filter(box => box.moduleId === 'arch-voussoirs').length, 10);
  assert.equal(compile('gateway').proxies.filter(proxy => proxy.id.startsWith('gateway:arch:')).length, 10);
  // A wheel is sixteen rim stones, eight spokes and exactly one collider (§19.5 item 8).
  const wheels = compile('chariot').proxies.filter(proxy => proxy.id.startsWith('chariot:wheel:'));
  assert.equal(wheels.length, 4, 'four wheels, four colliders, not four hundred');
  assert.equal(compile('chariot').proxies.filter(proxy => proxy.id.startsWith('chariot:column:')).length, 4);
  assert.equal(compile('chariot').proxies.filter(proxy => proxy.id.startsWith('chariot:roof:')).length, 6);
  // Wheel collisions contain what is drawn, measured as the reach of the *rotated* stones: a
  // stone's radial extent is its box's support along the outward direction, not half of
  // whichever side happens to be longest. Sixteen stones at radius 3.0, rotated to face the
  // hub, put a corner 0.7 m out at 45 degrees — 3.7 m — which is what the pre-DET-09 7 m slab
  // cut off, and what the port's first 7.3 m attempt still clipped by 5 cm.
  const hubs = [];
  for (const dx of [-5, 5]) for (const dz of [-6.5, 6.5]) hubs.push({ x: ORIGINS.chariot.x + dx, y: 3 + 4, z: ORIGINS.chariot.z + dz });
  const radialReach = box => {
    const hub = hubs.reduce((best, candidate) =>
      Math.hypot(box.x - candidate.x, box.y - candidate.y) < Math.hypot(box.x - best.x, box.y - best.y) ? candidate : best);
    const distance = Math.hypot(box.x - hub.x, box.y - hub.y);
    const angle = box.rotation[2] ?? 0;
    const radial = [(box.x - hub.x) / distance, (box.y - hub.y) / distance];
    const support = (Math.abs(Math.cos(angle) * box.sizeX * radial[0] + Math.sin(angle) * box.sizeX * radial[1]) +
      Math.abs(-Math.sin(angle) * box.sizeY * radial[0] + Math.cos(angle) * box.sizeY * radial[1])) / 2;
    return distance + support;
  };
  const rimReach = Math.max(...compile('chariot').boxes.filter(box => box.moduleId === 'wheel-rims').map(radialReach));
  assert.ok(Math.abs(rimReach - 3.7) < 1e-6, `the drawn rim reaches ${rimReach.toFixed(3)} m from its hub`);
  assert.ok(3.5 < rimReach - 1e-6, 'the pre-DET-09 7 m slab (half-extent 3.5) must be shown to cut the rim');
  assert.ok(wheels.every(proxy => proxy.sizeX / 2 >= rimReach - 1e-6),
    `the wheel collider (${wheels[0].sizeX / 2} m) must contain the drawn rim (${rimReach.toFixed(3)} m)`);
  // And the visual-only rule has teeth at definition time: an accent that declares collision
  // is rejected rather than silently ignored.
  assert.throws(() => createLandmarkDefinition({
    id: 'bad', masses: [], repeats: [], void: [],
    accents: [{ id: 'finial', box: { y: 1, sizeX: 1, sizeY: 1, sizeZ: 1, color: '#fff' }, structural: true }],
  }), /accent that declares collision/);
});

test('openings are declared profiles, and the compiler enforces them everywhere', () => {
  const voidDefinition = Object.values(GATEWAY_LANDMARK.voids)[0];
  const box = (overrides = {}) => ({ x: 0, y: 10, z: 0, sizeX: 1, sizeY: 1, sizeZ: 1, ...overrides });
  // Inside the free core, at every band.
  assert.equal(boxIntrudesIntoVoid(box({ x: 0 }), voidDefinition), true);
  assert.equal(boxIntrudesIntoVoid(box({ x: 3.4 }), voidDefinition), true, 'inside the widest band');
  assert.equal(boxIntrudesIntoVoid(box({ x: 2.9 }), voidDefinition), true, 'still inside the widest band');
  assert.equal(boxIntrudesIntoVoid(box({ x: 5 }), voidDefinition), false, 'clear of the widest band');
  // The stepped profile is what the test is for: a box that clears the wide base band can
  // still intrude higher up, and above the declaed head there is no opening at all.
  assert.equal(boxIntrudesIntoVoid(box({ x: 1.3, y: 16 }), voidDefinition), true, 'inside the narrow top band');
  assert.equal(boxIntrudesIntoVoid(box({ y: 3 }), voidDefinition), false, 'below the passage floor is the plinth');
  assert.equal(boxIntrudesIntoVoid(box({ z: 12 }), voidDefinition), false, 'beyond the passage depth is clear');
  // The tolerance exists because the voussoirs are *defined* by the band edges: a step whose
  // inner face is the band boundary must be masonry, not an intrusion.
  const atEdge = { x: 4.5 - 1.4 / 2, y: 10, z: 0, sizeX: 1.4, sizeY: 1.3, sizeZ: 9 };
  assert.equal(boxIntrudesIntoVoid({ ...atEdge, y: 10 }, voidDefinition), true, 'a stone reaching past the edge is masonry');
  assert.equal(boxIntrudesIntoVoid({ ...atEdge, x: 4.5 + 1.4 / 2 }, voidDefinition), false, 'a stone that ends exactly at the edge is not');
  assert.ok(GEO_LANDMARK_VOID_TOLERANCE > 0 && GEO_LANDMARK_VOID_TOLERANCE < 1e-3);
  // Definition validation catches the mistakes that would make a void meaningless.
  assert.throws(() => createLandmarkDefinition({ id: 'a', voids: [{ id: 'v', bottom: 0, halfDepth: 1, bands: [] }] }), /at least one band/);
  assert.throws(() => createLandmarkDefinition({ id: 'b', voids: [{ id: 'v', bottom: 0, halfDepth: 1, bands: [{ top: 5, halfWidth: 1 }, { top: 4, halfWidth: 1 }] }] }), /increasing top/);
  assert.throws(() => createLandmarkDefinition({ id: 'c', voids: [{ id: 'v', bottom: 0, halfDepth: 0, bands: [{ top: 5, halfWidth: 1 }] }] }), /halfDepth/);
  // The Chariot is solid, and says so rather than leaving it ambiguous.
  assert.deepEqual(Object.keys(CHARIOT_LANDMARK.voids), []);
  assert.deepEqual(compile('chariot').diagnostics.voidReport, {});
});

test('budgets are enforced by dropping accents first, and reported', () => {
  const budget = GEO_LANDMARK_BOX_BUDGETS.low;
  assert.deepEqual(GEO_LANDMARK_BOX_BUDGETS, { low: 120, balanced: 220, high: 400 });
  // A landmark that overflows drops decoration: the load-bearing masses survive.
  const overcrowded = createLandmarkDefinition({
    id: 'overcrowded',
    masses: [{ id: 'keep', box: { y: 2, sizeX: 4, sizeY: 4, sizeZ: 4, color: '#fff' }, structural: true }],
    accents: [{ id: 'thousand-finials', repeat: { kind: 'line', axis: 'x', from: -200, to: 200, step: 1 }, box: { y: 8, sizeX: .2, sizeY: .2, sizeZ: .2, color: '#eee' } }],
    voids: [],
  });
  const compiled = compileLandmark(overcrowded, { profile: 'low' });
  assert.ok(compiled.boxes.length <= budget, `${compiled.boxes.length} boxes must fit ${budget}`);
  assert.equal(compiled.boxes.some(box => box.moduleId === 'keep'), true, 'the mass is never dropped for its decoration');
  assert.ok(compiled.diagnostics.budgetSkips > 0, 'the overflow is counted rather than silent');
  assert.equal(compiled.boxes.length + compiled.diagnostics.budgetSkips, 402, 'every box is either emitted or dropped');
  // A higher profile simply fits more; nothing is ever silently emitted past the budget.
  for (const profile of ['low', 'balanced', 'high']) {
    const at = compileLandmark(overcrowded, { profile });
    assert.ok(at.boxes.length <= at.budget, `${profile}: ${at.boxes.length} > ${at.budget}`);
    assert.equal(at.boxes.length + at.diagnostics.budgetSkips, 402);
  }
  // Both shipped landmarks fit the *low* budget with room, which is the profile the
  // coordinate runtime runs and the curated runtime's default.
  for (const name of ['gateway', 'chariot']) {
    const compiled = compile(name);
    assert.equal(compiled.diagnostics.budgetSkips, 0, `${name} must fit the low budget without dropping anything`);
    assert.ok(compiled.boxes.length <= budget);
  }
  assert.throws(() => compileLandmark(GATEWAY_LANDMARK, { profile: 'ultra' }), /Unknown landmark profile/);
});

test('the compiler is deterministic, and stamping is the only thing it asks for', () => {
  const first = compile('gateway'), second = compile('gateway');
  assert.deepEqual(first.boxes.map(boxKey), second.boxes.map(boxKey), 'the same declaration compiles identically');
  assert.deepEqual(first.proxies, second.proxies);
  assert.deepEqual(compile('gateway', 'high').boxes, first.boxes, 'a bigger budget does not change the geometry');
  // The grammar never imports a renderer: stamping goes through any box sink, which is what
  // lets the runtime pass its VoxelBatch and the tests pass a recorder.
  const recorded = [];
  const stamped = stampLandmark(first, { box: (...args) => recorded.push(args) });
  assert.equal(stamped, 50);
  assert.equal(recorded.length, 50);
  assert.deepEqual(recorded[0], [first.boxes[0].x, first.boxes[0].y, first.boxes[0].z,
    first.boxes[0].sizeX, first.boxes[0].sizeY, first.boxes[0].sizeZ,
    first.boxes[0].color, [...first.boxes[0].rotation], first.boxes[0].metalness]);
  assert.throws(() => stampLandmark(first, {}), /box sink/);
  // Camera blockers are plain descriptors, ready to wrap in Box3 without the grammar knowing.
  const blockers = landmarkCameraBlockers(first);
  assert.equal(blockers.length, 18);
  assert.ok(blockers.every(blocker => blocker.role === 'camera-blocker' && blocker.structural === true));
  // Proxy id templating is filled from the site, so ids are stable and addressable.
  assert.equal(landmarkProxyId({ id: 'wheels', proxyId: 'wheel:{x}:{ndz}', proxyIdScale: 1.3, repeat: {} }, 2, [-5, 0, 6.5]), 'wheel:-5:5');
  assert.equal(landmarkProxyId({ id: 'plain', repeat: null }, 0, [0, 0, 0]), 'plain');
});
