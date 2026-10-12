/**
 * `CNT-02` — the content-recipe language gate (compiler tier).
 *
 * The registered gate is *"No contributor-authored Three.js required for supported modules"*, and
 * that is a claim about a **language**, so this file tests the language rather than the props:
 *
 * 1. **Every declared module and operation does what its summary says.** A module that exists in
 *    the table but has never compiled a box is documentation, not a feature.
 * 2. **Refusal is total and named.** Each refusal carries the `path` inside the recipe and a
 *    `code` from the declared set, because "invalid recipe" is not actionable for a contributor
 *    who typed a colour role that is one letter off. Every error class below is a real negative
 *    control: it must throw, and it must name the field.
 * 3. **Determinism is structural.** Compiling twice, compiling after a JSON round trip, and
 *    compiling with the same seed all produce the same boxes and the same digest; the *only*
 *    seed-dependent module is the one that declares itself seeded. If a future edit makes a
 *    module draw from `Math.random`, the digest tests fail rather than the art wobbling.
 * 4. **The two sinks stay distinct.** `toVoxelList()` is the boundary between a prop box and a
 *    state-pack voxel, and it must refuse a prop — a 0.15-wide handle is not a voxel, and
 *    rounding it silently would put content somewhere the pack does not say.
 *
 * The shipped seven props are covered separately, in `src/reference/FoodRecipes.test.js`, against
 * a transcription of the imperative function this slice replaced.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTENT_RECIPE_LIMITS, CONTENT_RECIPE_MODULES, CONTENT_RECIPE_OPERATIONS,
  CONTENT_RECIPE_VERSION, ContentRecipeError, compileContentRecipe, describeContentRecipe,
  fnv1a, toVoxelList,
} from './ContentRecipe.js';

/** A minimal valid recipe. Every refusal below is a mutation of this, which keeps the failure
 *  attributable to the mutation rather than to a badly-formed fixture. */
const base = (overrides = {}) => ({
  palette: { clay: '#b4552e', rim: '#e8a33d' },
  steps: [{ module: 'box', at: [0, 0, 0], size: [1, 1, 1], color: 'clay' }],
  ...overrides,
});

const compile = (recipe = base()) => compileContentRecipe(recipe, { seed: 41 });

/** Assert a refusal *and* the two fields that make it actionable. */
function refuses(mutate, { path, code, match }, options) {
  const recipe = mutate(base());
  let error = null;
  try {
    compileContentRecipe(recipe, options ?? { seed: 41 });
  } catch (caught) { error = caught; }
  const where = `at ${path} (${code})`;
  assert.ok(error, `expected a refusal ${where} — the recipe compiled instead`);
  assert.ok(error instanceof ContentRecipeError, `expected a ContentRecipeError ${where}, got ${error.name}: ${error.message}`);
  assert.equal(error.path, path, `expected the refusal ${where}, got path ${error.path}`);
  assert.equal(error.code, code, `expected the refusal ${where}, got code ${error.code}`);
  assert.match(error.message, match);
}

test('the module table is a table: every declared module compiles, in the shape it documents', () => {
  const describe = describeContentRecipe();
  assert.equal(describe.version, CONTENT_RECIPE_VERSION);
  assert.deepEqual(describe.modules.map(module => module.id), ['box', 'stack', 'row', 'grid', 'ring', 'scatter']);
  assert.deepEqual(describe.operations.map(operation => operation.id), ['translate', 'mirrorX', 'rotateY']);
  for (const module of describe.modules) {
    assert.ok(module.summary.length > 20, `${module.id} documents itself`);
    assert.ok(module.parameters.length > 0, `${module.id} declares its parameters`);
    assert.equal(module.seeded, module.id === 'scatter');
  }
  // Every module in the table must actually emit: a module that cannot compile is dead weight in
  // a language whose whole point is that a contributor can name it.
  const cases = {
    box: { module: 'box', at: [0, 1, 0], size: [1, 2, 1], color: 'clay' },
    stack: { module: 'stack', count: 3, y: 0, yStep: 0.5, size: [1, 1, 1], color: 'clay' },
    row: { module: 'row', at: [0, 0, 0], step: [0.5, 0, 0], count: 3, size: [0.4, 0.4, 0.4], color: 'rim' },
    grid: { module: 'grid', at: [0, 0, 0], columns: 2, rows: 2, stepX: 1, stepZ: 1, size: [0.5, 0.5, 0.5], color: 'clay' },
    ring: { module: 'ring', at: [0, 0, 0], radius: 1, count: 4, size: [0.2, 0.2, 0.2], color: 'rim' },
    scatter: { module: 'scatter', at: [0, 0, 0], area: [2, 1, 2], count: 4, size: [0.2, 0.2, 0.2], color: 'clay' },
  };
  for (const [id, step] of Object.entries(cases)) {
    const compiled = compileContentRecipe(base({ steps: [step] }), { seed: 41 });
    assert.ok(compiled.boxCount > 0, `${id} emitted boxes`);
    assert.ok(compiled.modules.includes(id), `${id} is named in the result`);
    // Every colour a module emits is a resolved hex, never a role name and never `undefined`:
    // the invariant the palette resolver protects as its last line of defence.
    for (const box of compiled.boxes) {
      assert.match(box.color, /^#[0-9a-f]{6}$/, `${id} emitted the colour ${JSON.stringify(box.color)}`);
      assert.ok(Object.values(base().palette).includes(box.color), `${box.color} is a declared palette colour`);
    }
  }
});

test('an omitted parameter is the default the description publishes, not an accident', () => {
  // `at` and `size` are optional and documented as such: a contributor writing the smallest
  // possible step gets a unit box at the origin, and the description says so before they try.
  const compiled = compile(base({ steps: [{ module: 'box', color: 'clay' }] }));
  assert.deepEqual([compiled.boxes[0].x, compiled.boxes[0].y, compiled.boxes[0].z], [0, 0, 0]);
  assert.deepEqual([compiled.boxes[0].sizeX, compiled.boxes[0].sizeY, compiled.boxes[0].sizeZ], [1, 1, 1]);
  const box = describeContentRecipe().modules.find(module => module.id === 'box');
  const published = Object.fromEntries(box.parameters.map(parameter => [parameter.name, parameter]));
  assert.deepEqual(published.at.default, [0, 0, 0]);
  assert.deepEqual(published.size.default, [1, 1, 1]);
  assert.equal(published.color.required, true, 'the colour has no default — a silent default would hide a typo');
  assert.equal(published.color.default, null);
});

test('a box is a centre, a size, a resolved colour and a rotation, in that order', () => {
  const compiled = compile(base({ steps: [{ module: 'box', at: [1, 2, 3], size: [0.5, 1, 1.5], color: 'rim', rotation: [0, 0.25, 0], metalness: 0.5 }] }));
  assert.equal(compiled.boxCount, 1);
  assert.deepEqual(compiled.boxes[0], {
    x: 1, y: 2, z: 3, sizeX: 0.5, sizeY: 1, sizeZ: 1.5,
    rx: 0, ry: 0.25, rz: 0, color: '#e8a33d', metalness: 0.5,
  });
  // The palette role is resolved to a hex, not carried as a name: a sink never needs the table.
  assert.equal(compiled.boxes[0].color, '#e8a33d');
});

test('steps are ordered: an operation acts on what precedes it, and only on that', () => {
  const moved = compile(base({
    steps: [
      { module: 'box', at: [0, 0, 0], size: [1, 1, 1], color: 'clay' },
      { op: 'translate', by: [0, 5, 0] },
      { module: 'box', at: [0, 0, 0], size: [1, 1, 1], color: 'rim' },
    ],
  }));
  assert.deepEqual(moved.boxes.map(box => box.y), [5, 0], 'the second box was not translated');
  assert.deepEqual(moved.operations, ['translate']);
});

test('mirrorX copies across X and mirrors the spin, without producing a negative zero', () => {
  const compiled = compile(base({
    steps: [
      { module: 'box', at: [-0.55, 0.45, 0], size: [0.95, 0.8, 1.4], color: 'clay', rotation: [0, 0.5, 0] },
      { op: 'mirrorX' },
    ],
  }));
  assert.equal(compiled.boxCount, 2);
  assert.deepEqual(compiled.boxes.map(box => box.x), [-0.55, 0.55]);
  assert.deepEqual(compiled.boxes.map(box => box.ry), [0.5, -0.5], 'the mirrored copy turns the other way');
  // `-0` and `0` are different strings to the digest and different values to `deepStrictEqual`
  // while being the same place in space, so a mirror of a zero rotation must stay a clean zero.
  const flat = compile(base({ steps: [{ module: 'box', at: [-1, 0, 0], size: [1, 1, 1], color: 'clay' }, { op: 'mirrorX' }] }));
  for (const box of flat.boxes) {
    for (const axis of ['rx', 'ry', 'rz']) assert.ok(Object.is(box[axis], 0), `${axis} is a clean zero`);
    assert.ok(Object.is(box.y, 0) && Object.is(box.z, 0));
  }
  // A mirror about a non-zero line is the same operation with a different pivot.
  const about = compile(base({ steps: [{ module: 'box', at: [1, 0, 0], size: [1, 1, 1], color: 'clay' }, { op: 'mirrorX', about: [3, 0, 0] }] }));
  assert.deepEqual(about.boxes.map(box => box.x), [1, 5]);
});

test('rotateY turns quarter turns about the origin and adds the same angle to the spin', () => {
  const compiled = compile(base({
    palette: { clay: '#b4552e' },
    steps: [
      { module: 'box', at: [2, 0, 0], size: [1, 1, 1], color: 'clay', rotation: [0, 0.25, 0] },
      { op: 'rotateY', turns: 1 },
    ],
  }));
  const box = compiled.boxes[0];
  assert.ok(Math.abs(box.x - 0) < 1e-6, `x is ${box.x}`);
  assert.ok(Math.abs(box.z + 2) < 1e-6, `z is ${box.z}`);
  assert.ok(Math.abs(box.ry - (0.25 + Math.PI / 2)) < 1e-6, `ry is ${box.ry}`);
  // Four quarter turns is the identity, which is the property that makes the op checkable by
  // arithmetic rather than by eye.
  const round = compile(base({ steps: [{ module: 'box', at: [2, 1, -3], size: [1, 1, 1], color: 'clay' }, { op: 'rotateY', turns: 4 }] }));
  assert.deepEqual([round.boxes[0].x, round.boxes[0].y, round.boxes[0].z], [2, 1, -3]);
  // A full turn is the identity *including the reported angle*: rotations are reported in
  // (-pi, pi] so that two ways of saying one pose produce one digest.
  assert.equal(round.boxes[0].ry, 0);
  assert.equal(compile(base({ steps: [{ module: 'box', at: [0, 0, 0], size: [1, 1, 1], color: 'clay', rotation: [0, Math.PI * 2, 0] }] })).boxes[0].ry, 0);
  assert.ok(Math.abs(compile(base({ steps: [{ module: 'box', at: [0, 0, 0], size: [1, 1, 1], color: 'clay', rotation: [0, -Math.PI, 0] }] })).boxes[0].ry + Math.PI) < 1e-6, 'half a turn is reported as a half turn');
});

test('an operation with nothing before it is legal, empty, and says so', () => {
  const compiled = compile(base({ steps: [{ op: 'mirrorX' }, { module: 'box', at: [1, 0, 0], size: [1, 1, 1], color: 'clay' }] }));
  assert.equal(compiled.boxCount, 1, 'nothing was mirrored');
  assert.equal(compiled.notes.length, 1);
  assert.match(compiled.notes[0], /mirrorX.*nothing to act on/);
});

test('overlapping identical boxes merge, last wins, and the merge is a note rather than a silence', () => {
  const same = compile(base({
    steps: [
      { module: 'box', at: [0, 0, 0], size: [1, 1, 1], color: 'clay' },
      { module: 'box', at: [0, 0, 0], size: [1, 1, 1], color: 'clay' },
    ],
  }));
  assert.equal(same.boxCount, 1, 'two boxes at the same cell and size are one box');
  assert.equal(same.notes.length, 0, 'the same colour is a plain dedupe, not a repair');

  const recoloured = compile(base({
    steps: [
      { module: 'box', at: [0, 0, 0], size: [1, 1, 1], color: 'clay' },
      { module: 'box', at: [0, 0, 0], size: [1, 1, 1], color: 'rim' },
    ],
  }));
  assert.equal(recoloured.boxCount, 1);
  assert.equal(recoloured.boxes[0].color, '#e8a33d', 'the later box wins');
  assert.equal(recoloured.notes.length, 1);
  assert.match(recoloured.notes[0], /the later colour #e8a33d replaced #b4552e/);

  // A partial overlap is *not* merged: two boxes that share volume but differ in size are a
  // composition, and merging them would silently change the shape.
  const composition = compile(base({
    palette: { clay: '#b4552e', rim: '#e8a33d' },
    steps: [
      { module: 'box', at: [0, 0, 0], size: [2, 0.1, 2], color: 'clay' },
      { module: 'box', at: [0, 0.3, 0], size: [0.4, 0.6, 0.4], color: 'rim' },
    ],
  }));
  assert.equal(composition.boxCount, 2);
});

test('compiling is deterministic, seed-independent unless a module is seeded, and stable across JSON', () => {
  const recipe = base({
    steps: [
      { module: 'stack', count: 4, y: 0.1, yStep: 0.3, paritySize: [0.1, 0, 0.1], spinStep: 0.25, size: [1, 0.2, 1], color: 'clay' },
      { module: 'row', at: [-1, 1, 0], step: [0.5, 0, 0], count: 4, size: [0.3, 0.3, 0.3], colorCycle: ['clay', 'rim'] },
      { op: 'rotateY', turns: 1 },
    ],
  });
  const first = compile(recipe);
  const second = compile(recipe);
  assert.deepEqual(second.boxes, first.boxes);
  assert.equal(second.digest, first.digest);
  assert.equal(first.seeded, false);
  // A different seed must not change a recipe that declares no seeded module: the seed is not a
  // global random knob, it only feeds the modules that say they need it.
  assert.equal(compileContentRecipe(recipe, { seed: 999 }).digest, first.digest);
  // The digest survives being written and read back, which is what a save file or a pack does.
  const roundTrip = compileContentRecipe(JSON.parse(JSON.stringify(recipe)), { seed: 41 });
  assert.equal(roundTrip.digest, first.digest);
  assert.deepEqual(roundTrip.boxes, first.boxes);
});

test('scatter is the seeded module: same seed, same sprinkle; different seed, different sprinkle', () => {
  const recipe = base({
    steps: [{ module: 'scatter', at: [0, 1, 0], area: [4, 1, 4], count: 12, size: [0.2, 0.2, 0.2], sizeVariance: 0.3, color: 'clay' }],
  });
  const a = compileContentRecipe(recipe, { seed: 7 });
  const b = compileContentRecipe(recipe, { seed: 7 });
  const c = compileContentRecipe(recipe, { seed: 8 });
  assert.equal(a.seeded, true);
  assert.deepEqual(b.boxes, a.boxes);
  assert.equal(b.digest, a.digest);
  assert.notEqual(c.digest, a.digest, 'a different seed is a different sprinkle');
  // Every draw lands inside the declared area and no box is degenerate: the seed changes *where*
  // the boxes are, never whether they are valid.
  for (const box of a.boxes) {
    assert.ok(Math.abs(box.x - 0) <= 2, `x ${box.x} is inside the area`);
    assert.ok(Math.abs(box.y - 1) <= 0.5, `y ${box.y} is inside the area`);
    assert.ok(Math.abs(box.z - 0) <= 2, `z ${box.z} is inside the area`);
    assert.ok(box.sizeX >= 0.01 && box.sizeY >= 0.01 && box.sizeZ >= 0.01);
  }
  // A module whose stream is derived from its own path: moving it changes its draws, which is why
  // the seed is mixed with the path rather than consumed in declaration order.
  const moved = compileContentRecipe(base({
    steps: [
      { module: 'box', at: [0, 0, 0], size: [1, 1, 1], color: 'clay' },
      recipe.steps[0],
    ],
  }), { seed: 7 });
  const scatterOnly = a.boxes.map(box => [box.x, box.y, box.z].join(','));
  const scatterShifted = moved.boxes.slice(1).map(box => [box.x, box.y, box.z].join(','));
  assert.notDeepEqual(scatterShifted, scatterOnly);
});

test('bounds are measured from the boxes as drawn, so a spun box is bounded by its silhouette', () => {
  const straight = compile(base({ steps: [{ module: 'box', at: [0, 0, 0], size: [2, 1, 2], color: 'clay' }] }));
  // A 2x2 footprint turned 45 degrees reaches sqrt(2) further on each axis than the box itself.
  const turned = compile(base({ steps: [{ module: 'box', at: [0, 0, 0], size: [2, 1, 2], color: 'clay', rotation: [0, Math.PI / 4, 0] }] }));
  assert.deepEqual(straight.bounds, { min: [-1, -0.5, -1], max: [1, 0.5, 1] });
  const reach = Math.SQRT2;
  assert.ok(Math.abs(turned.bounds.max[0] - reach) < 1e-6, `turned max x is ${turned.bounds.max[0]}`);
  assert.ok(Math.abs(turned.bounds.max[2] - reach) < 1e-6, `turned max z is ${turned.bounds.max[2]}`);
  assert.ok(Math.abs(turned.bounds.max[1] - 0.5) < 1e-6, 'the height is untouched by a Y spin');
  // Y is the axis of the spin, so a rotated box must not grow vertically — the failure mode a
  // conservative AABB would hide.
});

test('refusals name the path and the code, in every class the compiler claims to check', () => {
  // Shape and version.
  refuses(() => null, { path: 'recipe', code: 'type', match: /must be an object/ });
  refuses(() => base({ version: CONTENT_RECIPE_VERSION + 1 }), { path: 'recipe.version', code: 'version', match: /compiles recipe version/ });
  refuses(() => base({ steps: [] }), { path: 'recipe.steps', code: 'required', match: /non-empty/ });
  refuses(() => base({ palette: {} }), { path: 'recipe.palette', code: 'required', match: /colour roles/ });
  refuses(() => base({ palette: { clay: 'orange' } }), { path: 'recipe.palette.clay', code: 'color', match: /six-digit hex/ });
  refuses(() => base({ palette: { Clay: '#b4552e' } }), { path: 'recipe.palette.Clay', code: 'type', match: /lowercase/ });
  refuses(() => base({ palette: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`r${i}`, '#b4552e'])) }), { path: 'recipe.palette', code: 'budget', match: /at most 16 roles/ });

  // Steps: the discriminator itself.
  refuses(() => base({ steps: [{ op: 'mirrorX', module: 'box' }] }), { path: 'recipe.steps[0]', code: 'type', match: /declares either/ });
  refuses(() => base({ steps: [{ at: [0, 0, 0] }] }), { path: 'recipe.steps[0]', code: 'type', match: /declares either/ });
  refuses(() => base({ steps: ['box'] }), { path: 'recipe.steps[0]', code: 'type', match: /must be an object/ });
  refuses(() => base({ steps: [{ module: 'cone' }] }), { path: 'recipe.steps[0].module', code: 'module', match: /unknown module "cone"/ });
  refuses(() => base({ steps: [{ op: 'scale' }] }), { path: 'recipe.steps[0].op', code: 'operation', match: /unknown operation "scale"/ });

  // Parameters.
  refuses(() => base({ steps: [{ module: 'box', at: [0, 0, 0], size: [1, 1, 1] }] }), { path: 'recipe.steps[0].color', code: 'required', match: /requires "color"/ });
  refuses(() => base({ steps: [{ module: 'box', at: [0, 0, 0], size: [1, 1, 1], color: 'gold' }] }), { path: 'recipe.steps[0].color', code: 'palette', match: /does not declare/ });
  refuses(() => base({ steps: [{ module: 'box', at: [0, 0, 0], size: [1, 1, 1], colour: 'clay' }] }), { path: 'recipe.steps[0].colour', code: 'parameter', match: /no parameter "colour"/ });
  refuses(() => base({ steps: [{ module: 'box', at: [0, 0, 0], size: [0, 1, 1], color: 'clay' }] }), { path: 'recipe.steps[0].size', code: 'degenerate', match: /must be positive/ });
  refuses(() => base({ steps: [{ module: 'box', at: [0, 0, 0], size: [1, 1, 1], color: 'clay', rotation: [0, 0, 0, 0] }] }), { path: 'recipe.steps[0].rotation', code: 'type', match: /three numbers/ });
  refuses(() => base({ steps: [{ module: 'box', at: [0, 'x', 0], size: [1, 1, 1], color: 'clay' }] }), { path: 'recipe.steps[0].at', code: 'type', match: /finite number/ });
  refuses(() => base({ steps: [{ module: 'box', at: [0, 0, 0], size: [1, 1, 1], color: 'clay', metalness: 2 }] }), { path: 'recipe.steps[0].metalness', code: 'range', match: /outside the declared range/ });
  refuses(() => base({ steps: [{ module: 'grid', at: [0, 0, 0], columns: 0, size: [1, 1, 1], color: 'clay' }] }), { path: 'recipe.steps[0].columns', code: 'range', match: /outside the declared range/ });
  refuses(() => base({ steps: [{ module: 'grid', at: [0, 0, 0], columns: 1, rows: 1, skipCenter: true, size: [1, 1, 1], color: 'clay' }] }), { path: 'recipe.steps[0]', code: 'empty', match: /emitted nothing/ });
  refuses(() => base({ steps: [{ module: 'ring', at: [0, 0, 0], radius: 1, count: 4, axis: 'w', size: [1, 1, 1], color: 'clay' }] }), { path: 'recipe.steps[0].axis', code: 'type', match: /must be one of x, y, z/ });
  refuses(() => base({ steps: [{ module: 'stack', layers: [] }] }), { path: 'recipe.steps[0].layers', code: 'type', match: /non-empty array of layers/ });
  // A stack whose layers each name their own colour needs no cycle; one that names neither is
  // refused at the parameter that is missing rather than at the first layer that inherits it.
  refuses(() => base({ steps: [{ module: 'stack', layers: [{ at: [0, 0, 0], size: [1, 1, 1] }] }] }), { path: 'recipe.steps[0].color', code: 'required', match: /needs a colour role, a colour cycle, or per-layer colours/ });
  refuses(() => base({ steps: [{ module: 'stack', count: 2, size: [1, 0.3, 1], paritySize: [0, 0.5, 0], color: 'clay' }] }), { path: 'recipe.steps[0]', code: 'degenerate', match: /non-positive size/ });
  // Every repeating module takes its colour one of three ways, and all three are checked.
  for (const step of [
    { module: 'row', at: [0, 0, 0], count: 3, size: [1, 1, 1] },
    { module: 'stack', count: 2, size: [1, 1, 1] },
    { module: 'grid', at: [0, 0, 0], columns: 2, rows: 1, size: [1, 1, 1] },
    { module: 'ring', at: [0, 0, 0], radius: 1, count: 4, size: [1, 1, 1] },
  ]) {
    refuses(() => base({ steps: [step] }), { path: 'recipe.steps[0].color', code: 'required', match: /needs a colour role, a colour cycle, or per-layer colours/ });
  }

  // Budgets and the declared world.
  refuses(() => base({ steps: Array.from({ length: CONTENT_RECIPE_LIMITS.stepsPerRecipe + 1 }, () => ({ op: 'mirrorX' })) }), { path: 'recipe.steps', code: 'budget', match: /at most 64 steps/ });
  refuses(() => base({ steps: [{ module: 'grid', at: [0, 0, 0], columns: 16, rows: 16, stepX: 1, stepZ: 1, size: [0.05, 0.05, 0.05], color: 'clay' }] }), { path: 'recipe.steps[0]', code: 'budget', match: /over the 128 ceiling/ });
  refuses(() => base({
    steps: [
      { module: 'grid', at: [0, 0, 0], columns: 11, rows: 11, stepX: 0.05, stepZ: 0.05, size: [0.05, 0.05, 0.05], color: 'clay' },
      { module: 'grid', at: [3, 0, 0], columns: 11, rows: 11, stepX: 0.05, stepZ: 0.05, size: [0.05, 0.05, 0.05], color: 'clay' },
      { module: 'row', at: [0, 3, 0], step: [0.05, 0, 0], count: 15, size: [0.05, 0.05, 0.05], color: 'clay' },
    ],
  }), { path: 'recipe.modules', code: 'budget', match: /over the 256 ceiling/ });
  // An operation's own parameters are range-checked where they are declared...
  refuses(() => base({ steps: [{ op: 'translate', by: [CONTENT_RECIPE_LIMITS.extent + 1, 0, 0] }] }), { path: 'recipe.steps[0].by', code: 'range', match: /outside the declared range/ });
  // ...and the *result* is checked against the world, which is the case a parameter range cannot
  // see: both numbers are legal and their sum is not.
  refuses(() => base({ steps: [{ module: 'box', at: [40, 0, 0], size: [1, 1, 1], color: 'clay' }, { op: 'translate', by: [40, 0, 0] }] }), { path: 'recipe.operations', code: 'extent', match: /outside the declared/ });
  refuses(() => base({ steps: [{ module: 'box', at: [0, 0, 0], size: [CONTENT_RECIPE_LIMITS.size + 1, 1, 1], color: 'clay' }] }), { path: 'recipe.steps[0].size', code: 'range', match: /outside the declared range/ });
});

test('the published description is generated from the table it documents', () => {
  // `describeContentRecipe()` is what `CNT-03`'s tool and the contributor docs will render, so it
  // has to be the same table the compiler runs rather than a second copy that drifts.
  const describe = describeContentRecipe();
  assert.deepEqual(describe.limits, CONTENT_RECIPE_LIMITS);
  assert.deepEqual(Object.keys(describe).sort(), ['limits', 'modules', 'operations', 'version']);
  const types = new Set(['number', 'integer', 'size3', 'vec3', 'role', 'role[]', 'enum', 'boolean', 'layers']);
  for (const module of describe.modules) {
    for (const parameter of module.parameters) {
      assert.ok(types.has(parameter.type), `${module.id}.${parameter.name} has the declared type ${parameter.type}`);
      const range = parameter.range;
      assert.ok(range === null || Array.isArray(range), `${module.id}.${parameter.name} publishes a range or an enum`);
      if (parameter.type === 'enum') assert.ok(range.every(entry => typeof entry === 'string'), `${module.id}.${parameter.name} enumerates its values`);
      else assert.ok(range === null || range.every(Number.isFinite), `${module.id}.${parameter.name} has a numeric range`);
    }
    assert.deepEqual(describeContentRecipe().modules.find(entry => entry.id === module.id), module, `${module.id} describes itself the same way twice`);
  }
  // A tool reads it as JSON, so it must survive JSON without losing a value: `Infinity` or a
  // function would become `null` and quietly change what the docs say.
  const roundTrip = JSON.parse(JSON.stringify(describe));
  assert.deepEqual(roundTrip, describe);
});

test('toVoxelList is the prop/voxel boundary: a voxel is a unit box on an integer cell', () => {
  const voxels = compile(base({ steps: [{ module: 'box', at: [3, 0, -2], size: [1, 1, 1], color: 'clay' }] }));
  assert.deepEqual(toVoxelList(voxels), [[3, 0, -2, '#b4552e']]);
  // Accepts the box list directly, so a pack author can go from a compiled recipe to a
  // `CNT-01` `voxels` list without constructing the wrapper object.
  assert.deepEqual(toVoxelList(voxels.boxes), toVoxelList(voxels));
  // And refuses everything that is a prop rather than a voxel. Each case is a real shipped shape:
  // the chai handle is 0.15 wide, the chips sit at y 0.5, the parotta layers are spun.
  const cases = [
    { step: { module: 'box', at: [0, 0, 0], size: [0.15, 0.85, 0.05], color: 'clay' }, match: /a voxel is a unit box/ },
    { step: { module: 'box', at: [0, 0.5, 0], size: [1, 1, 1], color: 'clay' }, match: /integer cell/ },
    { step: { module: 'box', at: [0, 0, 0], size: [1, 1, 1], color: 'clay', rotation: [0, 0.25, 0] }, match: /is rotated/ },
  ];
  for (const { step, match } of cases) {
    const compiled = compile(base({ steps: [step] }));
    assert.throws(() => toVoxelList(compiled), error => {
      assert.equal(error.path, 'voxels');
      assert.equal(error.code, 'voxel');
      assert.match(error.message, match);
      return true;
    });
  }
  assert.throws(() => toVoxelList('nope'), error => error.code === 'type');
});

test('fnv1a is the project hash and the digest is eight lowercase hex characters of it', () => {
  assert.equal(fnv1a(''), 0x811c9dc5);
  assert.equal(typeof fnv1a('recipe'), 'number');
  assert.equal(fnv1a('recipe'), fnv1a('recipe'), 'stable across calls');
  assert.notEqual(fnv1a('recipe'), fnv1a('recipes'), 'sensitive to every character');
  const compiled = compile();
  assert.match(compiled.digest, /^[0-9a-f]{8}$/);
  assert.equal(compiled.digest, compiled.digest.toLowerCase());
});

test('a digest follows what is drawn, not how it was said: a recolour changes colour and digest, never geometry', () => {
  const geometry = JSON.stringify(compile().boxes.map(({ color, ...rest }) => rest));
  const recoloured = compile(base({ palette: { clay: '#00ff00', rim: '#e8a33d' } }));
  assert.notEqual(recoloured.digest, compile().digest);
  assert.equal(JSON.stringify(recoloured.boxes.map(({ color, ...rest }) => rest)), geometry);
  assert.equal(recoloured.boxes[0].color, '#00ff00');
  // Two ways of saying one shape: the modules are sugar over the same primitive, so a box and a
  // one-layer stack that describe the same slab compile to the same boxes and the same digest.
  const direct = compile(base({ steps: [{ module: 'box', at: [0, 1, 0], size: [1, 2, 1], color: 'clay' }] }));
  const stacked = compile(base({ steps: [{ module: 'stack', layers: [{ at: [0, 1, 0], size: [1, 2, 1], color: 'clay' }] }] }));
  assert.deepEqual(stacked.boxes, direct.boxes);
  assert.equal(stacked.digest, direct.digest);
});
