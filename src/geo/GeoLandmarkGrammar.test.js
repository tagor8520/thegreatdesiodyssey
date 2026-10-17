import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_LANDMARK_NAMESPACE,
  GEO_LANDMARK_FORM,
  GEO_LANDMARK_LIMITS,
  GEO_LANDMARK_MASS,
  carveRectangle,
  compileLandmarkGeometry,
  compileLandmarks,
  createLandmarkHeroRecipe,
  discoverLandmarkOpenings,
  landmarkAxis,
  landmarkCompounds,
  landmarkEligibility,
  landmarkFormFor,
  landmarkFrame,
  landmarkOpeningClear,
  landmarkPathClear,
  landmarkSegmentHit,
  landmarkSignalFromProperties,
  landmarkViewCorridor,
  selectLandmarkHero,
} from './GeoLandmarkGrammar.js';

function rectangle(minimumX, minimumZ, maximumX, maximumZ) {
  return [[minimumX, minimumZ], [maximumX, minimumZ], [maximumX, maximumZ], [minimumX, maximumZ]];
}

function heroInput(overrides = {}) {
  return {
    id: 'tile:0:building:1:landmark',
    owner: 'tile:0:building:1',
    rings: [rectangle(-1.2, -.9, 1.2, .9)],
    foundationY: 0,
    roofY: 2.6,
    height: 2.6,
    hash: 0x51ed2701,
    wallColor: [.72, .62, .5],
    roofColor: [.38, .3, .26],
    formSignal: GEO_LANDMARK_FORM.GATE,
    ...overrides,
  };
}

function roadFacing(overrides = {}) {
  return {
    found: true, source: 'mapped-road', edgeLength: 1.1,
    centerX: 0, centerZ: .9, normalX: 0, normalZ: 1, tangentX: 1, tangentZ: 0, yaw: 0,
    ...overrides,
  };
}

test('DET-09 landmark frame snaps the approach axis and maps local rectangles into world space', () => {
  const rings = [rectangle(-1.2, -.9, 1.2, .9)];
  assert.deepEqual(landmarkAxis(0, 1, 3), [0, 1]);
  assert.deepEqual(landmarkAxis(0, -1, 3), [0, -1]);
  assert.deepEqual(landmarkAxis(.9, .2, 0), [1, 0]);
  assert.deepEqual(landmarkAxis(0, 0, 1), [-1, 0]);
  const frame = landmarkFrame(rings, landmarkAxis(0, 1, 0));
  assert.equal(frame.alongZ, 1);
  assert.equal(frame.alongHalf, .9);
  assert.equal(frame.acrossHalf, 1.2);
  const area = frame.localRect(-.4, .4, -.2, .2);
  assert.ok(area.minimumX < area.maximumX && area.minimumZ < area.maximumZ);
  assert.ok(area.minimumZ >= -.9 - 1e-9 && area.maximumZ <= .9 + 1e-9,
    'the arch void must run through the hero along its own approach axis');
  assert.throws(() => landmarkFrame(rings, [1, 1]), TypeError);
  assert.throws(() => landmarkFrame([[[0, 0]]], [1, 0]), TypeError);
});

test('DET-09 eligibility gates footprints before any shell is reserved', () => {
  assert.equal(landmarkEligibility([rectangle(-1, -1, 1, 1)], 2).eligible, true);
  assert.equal(landmarkEligibility([rectangle(-1, -1, 1, 1)], .4).reason, 'height');
  assert.equal(landmarkEligibility([rectangle(-.2, -.2, .2, .2)], 2).reason, 'footprint');
  assert.equal(landmarkEligibility([rectangle(-.3, -1, .3, 1)], 2).reason, 'footprint');
  assert.equal(landmarkEligibility([[[0, 0], [1, 1]]], 2).reason, 'rings');
});

test('DET-09 explicit mapped signals choose the form and never fabricate identity', () => {
  assert.equal(landmarkSignalFromProperties({ class: 'Monument' }), GEO_LANDMARK_FORM.GATE);
  assert.equal(landmarkSignalFromProperties({ kind: 'clock-tower' }), GEO_LANDMARK_FORM.TOWER);
  assert.equal(landmarkSignalFromProperties({ subclass: 'cathedral' }), GEO_LANDMARK_FORM.DOME);
  // No name, POI, or tourist claim may choose a silhouette.
  assert.equal(landmarkSignalFromProperties({ name: 'Gateway of India', tourism: 'attraction' }), null);
  assert.equal(landmarkSignalFromProperties({ heritage: 'yes' }), null);
  assert.equal(landmarkFormFor({ properties: { class: 'gate' } }).source, 'mapped-signal');
  const fallback = landmarkFormFor({ footprintArea: .4, height: 3.2, hash: 9 });
  assert.equal(fallback.source, 'form-fallback');
  assert.ok(['gate', 'tower', 'dome'].includes(fallback.form));
  assert.equal(landmarkFormFor({ footprintArea: .4, height: 3.2, hash: 9 }).form,
    fallback.form, 'form fallback stays deterministic for one hash');
});

test('DET-09 selection admits one hero, prefers mapped signals, and truncates bounded lists', () => {
  const small = heroInput({ id: 'a', rings: [rectangle(-.5, -.5, .5, .5)], roofY: 1.2, height: 1.2, formSignal: null });
  const signal = heroInput({ id: 'b', rings: [rectangle(-.5, -.5, .5, .5)], roofY: 3, height: 3, formSignal: GEO_LANDMARK_FORM.TOWER });
  const big = heroInput({ id: 'c', rings: [rectangle(-3, -2, 3, 2)], roofY: 1.4, height: 1.4, formSignal: null });
  const selection = selectLandmarkHero([small, big, signal]);
  assert.equal(selection.selected.length, 1);
  assert.equal(selection.selected[0].id, 'b', 'an explicit mapped signal outranks raw size');
  assert.equal(selection.eligible, 3);
  assert.equal(selectLandmarkHero([small, big]).selected[0].id, 'c', 'larger footprints win otherwise');
  assert.equal(selectLandmarkHero([small], 4).selected.length, 1);
  assert.equal(selectLandmarkHero([small], 0).selected.length, 0);
  const overflow = Array.from({ length: GEO_LANDMARK_LIMITS.maxSourceBuildings + 3 },
    (unused, index) => heroInput({ id: `over:${index}`, formSignal: null }));
  assert.equal(selectLandmarkHero(overflow).truncated, true);
  assert.throws(() => selectLandmarkHero('nope'), TypeError);
  assert.throws(() => selectLandmarkHero([], -1), RangeError);
});

test('DET-09 openings are discovered before any module is placed', () => {
  const rings = [rectangle(-1.2, -.9, 1.2, .9), rectangle(-.3, -.3, .3, .3)];
  const frame = landmarkFrame(rings, [0, 1]);
  const gate = discoverLandmarkOpenings({
    rings, form: GEO_LANDMARK_FORM.GATE, foundationY: .1, height: 2.4, hash: 3, frame,
  });
  assert.ok(gate.gate, 'a gate hero reserves a walkable arch void');
  assert.equal(gate.gate.passable, true);
  assert.ok(gate.gate.acrossWidth >= GEO_LANDMARK_LIMITS.minPassageWidth);
  assert.ok(gate.gate.height >= GEO_LANDMARK_LIMITS.minPassageHeight);
  assert.equal(gate.openings.filter(opening => opening.kind === 'arch').length, 1,
    'a mapped hole plus an arch never duplicate the same opening');
  assert.equal(gate.openings.filter(opening => opening.kind === 'passage').length, 1);
  const tower = discoverLandmarkOpenings({
    rings: [rectangle(-.6, -.6, .6, .6)], form: GEO_LANDMARK_FORM.TOWER,
    foundationY: 0, height: 3, hash: 5, frame: landmarkFrame([rectangle(-.6, -.6, .6, .6)], [0, 1]),
  });
  assert.equal(tower.gate, null, 'only the gate archetype reserves a walkable arch');
  assert.equal(tower.door, null);
  const door = discoverLandmarkOpenings({
    rings: [rectangle(-.6, -.6, .6, .6)], form: GEO_LANDMARK_FORM.TOWER, foundationY: 0, height: 3,
    hash: 5, roadFacing: roadFacing(), frame: landmarkFrame([rectangle(-.6, -.6, .6, .6)], [0, 1]),
  });
  assert.ok(door.door && door.door.passable, 'a mapped-road door stays traversable');
  const corridor = landmarkViewCorridor({
    rings: [rectangle(-1, -1, 1, 1)], axis: [0, 1], foundationY: 0,
  });
  assert.ok(corridor.minimumZ >= 1 - 1e-9, 'the viewing corridor starts at the hero edge');
  assert.equal(corridor.passable, true);
});

test('DET-09 gate arch is genuinely empty while its flanking masses stay solid', () => {
  const hero = createLandmarkHeroRecipe(heroInput());
  assert.equal(hero.form, GEO_LANDMARK_FORM.GATE);
  const gate = hero.openings.find(opening => opening.id === 'arch:gate');
  assert.ok(gate && gate.passable);
  assert.equal(landmarkOpeningClear(hero, gate), true, 'no structural compound may enter the arch void');
  const frame = hero.frame;
  const along = frame.alongHalf + 1;
  const approach = { x: frame.toWorldX(-along, 0), y: .22, z: frame.toWorldZ(-along, 0) };
  const exit = { x: frame.toWorldX(along, 0), y: .22, z: frame.toWorldZ(along, 0) };
  assert.equal(landmarkPathClear(hero, approach, exit, { radius: .058 }), true,
    'a walker passes through the arch along the reserved approach axis');
  const acrossStart = { x: frame.toWorldX(0, -(frame.acrossHalf + 1)), y: .22, z: frame.toWorldZ(0, -(frame.acrossHalf + 1)) };
  const acrossEnd = { x: frame.toWorldX(0, frame.acrossHalf + 1), y: .22, z: frame.toWorldZ(0, frame.acrossHalf + 1) };
  assert.equal(landmarkPathClear(hero, acrossStart, acrossEnd, { radius: .058 }), false,
    'the flanking piers and plinth still block the cross axis');
  assert.equal(landmarkPathClear(hero, acrossStart, acrossEnd, { radius: .058, includeOrnament: true }), false);
  // Above the arch the tier stack is solid again, so the hero is not a tunnel.
  const high = { ...approach, y: 1.2 }, highExit = { ...exit, y: 1.2 };
  assert.equal(landmarkPathClear(hero, high, highExit, { radius: 0 }), false);
  assert.equal(hero.diagnostics.enclosingCompounds, 0);
  assert.equal(hero.diagnostics.passableOpenings, 1);
  assert.ok(hero.diagnostics.walkerBlockingCompounds > 0);
  // The carve proof is not vacuous: a hero-wide void would be sealed by the very
  // masses that flank the arch.
  assert.equal(hero.diagnostics.sealedOpenings, 0);
  assert.deepEqual([...hero.diagnostics.sealedOpeningIds], []);
  assert.equal(hero.diagnostics.capEvents.sealedOpenings, false);
  assert.equal(landmarkOpeningClear(hero, {
    ...gate, minimumX: hero.frame.bounds.minimumX, maximumX: hero.frame.bounds.maximumX,
    minimumZ: hero.frame.bounds.minimumZ, maximumZ: hero.frame.bounds.maximumZ,
  }), false, 'a landmark-wide void must be detected as sealed');
  for (const opening of hero.openings) {
    assert.equal(landmarkOpeningClear(hero, opening), true, `${opening.id} stays empty`);
  }
});

test('DET-09 repeated modules come from bounded spacing loops and batch into one draw', () => {
  const hero = createLandmarkHeroRecipe(heroInput());
  const diagnostics = hero.diagnostics;
  assert.ok(diagnostics.tiers >= GEO_LANDMARK_LIMITS.tierCount[0] - 1);
  assert.ok(diagnostics.columns > 0);
  assert.ok(diagnostics.merlons > 0);
  assert.equal(diagnostics.boxes, hero.boxes.length);
  assert.ok(diagnostics.boxes <= GEO_LANDMARK_LIMITS.maxBoxesPerHero);
  assert.equal(diagnostics.batches, 1);
  assert.equal(diagnostics.drawCalls, 1);
  assert.equal(hero.compiled.diagnostics.attemptedModules <= GEO_LANDMARK_LIMITS.maxModulesPerHero, true);
  assert.ok(hero.compiled.diagnostics.emittedModules <= 3,
    'masses, detail, and ornament compile into at most three role modules');
  const masses = new Set(hero.boxes.map(box => box.mass));
  assert.ok(masses.has(GEO_LANDMARK_MASS.PLINTH) && masses.has(GEO_LANDMARK_MASS.PIER));
  assert.ok(masses.has(GEO_LANDMARK_MASS.LINTEL) && masses.has(GEO_LANDMARK_MASS.VOUSSOIR));
  assert.ok(masses.has(GEO_LANDMARK_MASS.TIER) && masses.has(GEO_LANDMARK_MASS.COLUMN));
  assert.ok(masses.has(GEO_LANDMARK_MASS.MERLON) && masses.has(GEO_LANDMARK_MASS.FINIAL));
  assert.deepEqual(diagnostics.prunedModules, []);
  assert.equal(diagnostics.budgetSkips, 0, 'no loop may emit a partial module');
  // Whole-module pruning: a tight budget drops whole loops, never half of one.
  const pruned = createLandmarkHeroRecipe({ ...heroInput(), boxBudget: 30 });
  assert.ok(pruned.boxes.length <= 30);
  assert.ok(pruned.diagnostics.prunedModules.includes('merlons'));
  assert.equal(pruned.diagnostics.budgetSkips, 0);
  assert.ok(pruned.diagnostics.tiers > 0, 'load-bearing masses are never pruned');
  assert.equal(pruned.diagnostics.batches, 1);
  // A footprint too large for the authored spacing stays bounded instead.
  const wide = createLandmarkHeroRecipe({
    ...heroInput({ rings: [rectangle(-10, -10, 10, 10)], roofY: 6, height: 6 }),
  });
  assert.equal(wide.diagnostics.prunedModules.length, 0);
  assert.ok(wide.diagnostics.columns <= GEO_LANDMARK_LIMITS.maxColumnsPerSide * 4);
  assert.ok(wide.diagnostics.merlons <= GEO_LANDMARK_LIMITS.maxMerlonsPerSide * 4);
  assert.ok(wide.boxes.length <= GEO_LANDMARK_LIMITS.maxBoxesPerHero);
  assert.throws(() => createLandmarkHeroRecipe({ ...heroInput(), boxBudget: 2 }), RangeError);
  assert.throws(() => createLandmarkHeroRecipe({ ...heroInput(), boxBudget: 4_000 }), RangeError);
});

test('DET-09 hidden-face compilation drops contained boxes and covered faces deterministically', () => {
  const box = (centerX, bottom, centerZ, size, color) => ({
    centerX, bottom, centerZ, sizeX: size, sizeY: size, sizeZ: size, color,
  });
  const single = compileLandmarkGeometry({
    boxes: [{ ...box(0, 0, 0, 1, [.5, .5, .5]), mass: GEO_LANDMARK_MASS.PLINTH }],
  });
  assert.equal(single.triangles, 12);
  assert.equal(single.positions.length / 3, 24);
  assert.equal(single.hiddenFaces, 0);
  assert.equal(single.containedBoxes, 0);
  const stacked = compileLandmarkGeometry({
    boxes: [
      { ...box(0, 0, 0, 1, [.5, .5, .5]), mass: GEO_LANDMARK_MASS.TIER },
      { ...box(0, 1, 0, 1, [.5, .5, .5]), mass: GEO_LANDMARK_MASS.TIER },
    ],
  });
  assert.equal(stacked.triangles, 20, 'the shared face between two stacked boxes is removed');
  assert.equal(stacked.hiddenFaces, 2);
  const contained = compileLandmarkGeometry({
    boxes: [
      { ...box(0, 0, 0, 2, [.5, .5, .5]), mass: GEO_LANDMARK_MASS.TIER },
      { ...box(0, .4, 0, .4, [.9, .9, .9]), mass: GEO_LANDMARK_MASS.FINIAL },
    ],
  });
  assert.equal(contained.containedBoxes, 1);
  assert.equal(contained.triangles, 12);
  // Winding and normals agree with the geometric normal of every triangle.
  const geometry = compileLandmarkGeometry({
    boxes: [
      { ...box(0, 0, 0, 1, [.5, .5, .5]), mass: GEO_LANDMARK_MASS.TIER, yaw: .4 },
      { ...box(.2, .5, .1, .4, [.6, .6, .6]), mass: GEO_LANDMARK_MASS.BAND },
    ],
  });
  for (let index = 0; index < geometry.indices.length; index += 3) {
    const [a, b, c] = [0, 1, 2].map(offset => geometry.indices[index + offset] * 3);
    const first = [0, 1, 2].map(axis => geometry.positions[b + axis] - geometry.positions[a + axis]);
    const second = [0, 1, 2].map(axis => geometry.positions[c + axis] - geometry.positions[a + axis]);
    const cross = [
      first[1] * second[2] - first[2] * second[1],
      first[2] * second[0] - first[0] * second[2],
      first[0] * second[1] - first[1] * second[0],
    ];
    const length = Math.hypot(...cross);
    assert.ok(length > 1e-6, 'no degenerate triangle may be emitted');
    const normal = [0, 1, 2].map(axis => geometry.normals[a + axis]);
    const alignment = (cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2]) / length;
    assert.ok(alignment > .999, 'triangle winding must agree with its vertex normal');
  }
  assert.equal(compileLandmarkGeometry({
    boxes: [{ ...box(0, 0, 0, 1, [.5, .5, .5]), mass: GEO_LANDMARK_MASS.TIER }],
  }).triangles, compileLandmarkGeometry({
    boxes: [{ ...box(0, 0, 0, 1, [.5, .5, .5]), mass: GEO_LANDMARK_MASS.TIER }],
  }).triangles);
  assert.throws(() => compileLandmarkGeometry({ boxes: [] }), TypeError);
  assert.throws(() => compileLandmarkGeometry({
    boxes: [box(0, 0, 0, 1, [.5, .5, .5])],
  }, { maxHiddenFaceTests: -1 }), RangeError);
});

test('DET-09 compounds stay tight, exclude ornament, and never enclose the hero', () => {
  const hero = createLandmarkHeroRecipe(heroInput());
  const compounds = landmarkCompounds(hero);
  assert.equal(compounds.length, hero.boxes.length);
  const byMass = mass => compounds.filter(compound => compound.mass === mass);
  for (const mass of [GEO_LANDMARK_MASS.PLINTH, GEO_LANDMARK_MASS.PIER,
    GEO_LANDMARK_MASS.LINTEL, GEO_LANDMARK_MASS.TIER]) {
    assert.ok(byMass(mass).every(compound => compound.structural), `${mass} is structural`);
  }
  // Skyline ornament and colonnade pilasters never earn collision.
  for (const mass of [GEO_LANDMARK_MASS.VOUSSOIR, GEO_LANDMARK_MASS.BAND, GEO_LANDMARK_MASS.MERLON,
    GEO_LANDMARK_MASS.RIB, GEO_LANDMARK_MASS.FINIAL, GEO_LANDMARK_MASS.COLUMN]) {
    assert.ok(byMass(mass).every(compound => !compound.structural), `${mass} stays visual-only`);
  }
  const structural = compounds.filter(compound => compound.structural);
  assert.ok(structural.length > 0);
  assert.ok(structural.length <= GEO_LANDMARK_LIMITS.maxStructuralCompounds);
  assert.equal(hero.diagnostics.enclosingCompounds, 0);
  assert.ok(hero.diagnostics.maximumCompoundExtent <= hero.diagnostics.heroExtent,
    'no compound may cover the whole hero');
  const bounds = hero.frame.bounds;
  for (const compound of compounds) {
    assert.ok(compound.maximumX - compound.minimumX <= hero.frame.width + 1e-6);
    assert.ok(compound.maximumZ - compound.minimumZ <= hero.frame.depth + 1e-6);
    assert.ok(compound.minimumX >= bounds.minimumX - 1e-6 && compound.maximumX <= bounds.maximumX + 1e-6);
    assert.ok(compound.minimumY >= hero.foundationY - 1e-6);
  }
  // A single hero-wide AABB would fail this: the union of tight boxes must not be
  // representable by one box that covers the footprint at every height.
  const tall = structural.filter(compound => compound.minimumY <= hero.foundationY + .01);
  assert.ok(tall.length >= 3, 'the base resolves into separate modules, not one slab');
  // The canonical gate: no compound may be one landmark-wide AABB, so every
  // structural module is strictly narrower than the hero in at least one plan
  // axis even where it is a full tier band.
  for (const compound of structural) {
    const coversPlan = compound.minimumX <= bounds.minimumX + 1e-6 &&
      compound.maximumX >= bounds.maximumX - 1e-6 &&
      compound.minimumZ <= bounds.minimumZ + 1e-6 &&
      compound.maximumZ >= bounds.maximumZ - 1e-6;
    assert.equal(coversPlan, false, `compound ${compound.mass} must not cover the hero plan`);
  }
  assert.equal(hero.diagnostics.sealedOpenings, 0);
});

test('DET-09 carveRectangle preserves a reserved void exactly', () => {
  const plate = { minimumX: 0, maximumX: 4, minimumZ: 0, maximumZ: 4 };
  const reserved = { minimumX: 1, maximumX: 3, minimumZ: -1, maximumZ: 5 };
  const parts = carveRectangle(plate, reserved);
  assert.ok(parts.length >= 1);
  for (const part of parts) {
    assert.ok(part.maximumX <= 1 + 1e-9 || part.minimumX >= 3 - 1e-9,
      'no part may cover the reserved rectangle');
  }
  const area = parts.reduce((total, part) => total + (part.maximumX - part.minimumX) * (part.maximumZ - part.minimumZ), 0);
  assert.ok(area <= (plate.maximumX - plate.minimumX) * (plate.maximumZ - plate.minimumZ) + 1e-9);
  assert.deepEqual(carveRectangle(plate, { minimumX: 9, maximumX: 10, minimumZ: 9, maximumZ: 10 }), [plate]);
  assert.equal(landmarkSegmentHit({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 4 },
    { minimumX: -.5, maximumX: .5, minimumY: -.5, maximumY: .5, minimumZ: 1, maximumZ: 2 }), true);
  assert.equal(landmarkSegmentHit({ x: 3, y: 0, z: 0 }, { x: 3, y: 0, z: 4 },
    { minimumX: -.5, maximumX: .5, minimumY: -.5, maximumY: .5, minimumZ: 1, maximumZ: 2 }), false);
  assert.throws(() => landmarkSegmentHit({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, {}), TypeError);
});

test('DET-09 hero compilation is deterministic and rejects malformed mapped input', () => {
  const first = createLandmarkHeroRecipe(heroInput());
  const second = createLandmarkHeroRecipe(heroInput());
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.deepEqual([...first.geometry.positions], [...second.geometry.positions]);
  assert.deepEqual([...first.geometry.indices], [...second.geometry.indices]);
  assert.deepEqual(first.compounds, second.compounds);
  assert.equal(first.namespace, GDO_LANDMARK_NAMESPACE);
  assert.equal(first.geometry.namespace, GDO_LANDMARK_NAMESPACE);
  assert.equal(first.geometry.runtimeCsgOperations, 0);
  assert.equal(first.geometry.collisionProxies, 0);
  assert.equal(first.compiled.solidProxies.length, 0);
  assert.equal(first.compiled.interactionProxies.length, 0);
  assert.equal(first.compiled.cameraRoles.length, 0);
  // The floor plan and approach are mapped, never invented.
  assert.equal(first.compiled.recipeId, first.id);
  assert.equal(first.compiled.owner, first.owner);
  assert.equal(first.height, heroInput().height);
  assert.throws(() => createLandmarkHeroRecipe(heroInput({ rings: [[[0, 0], [1, 1]]] })), TypeError);
  assert.throws(() => createLandmarkHeroRecipe(heroInput({ hash: 0, wallColor: [1, 2] })), TypeError);
  assert.throws(() => createLandmarkHeroRecipe(heroInput({ roofY: 0 })), TypeError);
  assert.throws(() => createLandmarkHeroRecipe(heroInput({ height: 0 })), TypeError);
});

test('DET-09 tile entry point applies whole-hero caps and reports them', () => {
  const compiled = compileLandmarks([heroInput()]);
  assert.equal(compiled.heroes.length, 1);
  assert.equal(compiled.namespace, GDO_LANDMARK_NAMESPACE);
  assert.equal(compiled.boxes, compiled.heroes[0].boxes.length);
  assert.equal(compiled.bytes, compiled.heroes[0].geometry.bytes);
  assert.deepEqual(compiled.capEvents, { heroes: false, boxes: false, bytes: false, malformed: false });
  const byteCapped = compileLandmarks([heroInput()], { bytesPerTile: 64 });
  assert.equal(byteCapped.heroes.length, 0);
  assert.equal(byteCapped.capEvents.bytes, true);
  const boxCapped = compileLandmarks([heroInput()], { boxesPerTile: 4 });
  assert.equal(boxCapped.heroes.length, 0);
  assert.equal(boxCapped.capEvents.boxes, true);
  const ineligible = compileLandmarks([heroInput({ rings: null })]);
  assert.equal(ineligible.heroes.length, 0);
  assert.equal(ineligible.eligible, 0);
  assert.equal(ineligible.capEvents.malformed, false, 'ineligible footprints are skipped, not failed');
  const malformed = compileLandmarks([heroInput({ wallColor: [1, 2] })]);
  assert.equal(malformed.heroes.length, 0);
  assert.equal(malformed.capEvents.malformed, true, 'a hero that cannot be completed is never emitted');
  const heroCapped = compileLandmarks([heroInput({ id: 'a' }), heroInput({ id: 'b' })]);
  assert.equal(heroCapped.heroes.length, GEO_LANDMARK_LIMITS.heroesPerTile);
  assert.equal(heroCapped.capEvents.heroes, true);
});
