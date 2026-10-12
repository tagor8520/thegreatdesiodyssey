/**
 * `CNT-02` — the recipe compiler: **content authored as data, geometry produced here**.
 *
 * Registered gate (feature-roadmap/README.md order 161):
 *   *"No contributor-authored Three.js required for supported modules"*
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT
 * -----------------------------------
 * `DET-09` already made the **landmark** half true: `createLandmarkDefinition()` takes a plain
 * description (masses, repeats, accents, voids) and the grammar builds the geometry, so a
 * contributor writing a landmark writes data. The **state/prop** half was not: the curated
 * runtime's seven shop items were imperative Three.js — `b.box(0, .1, 0, 1.8, .35, 1.5, …)`
 * calls with hand-computed loops and a `throw new Error('Unknown food: …')` for anything the
 * branch chain did not recognise. Adding an item meant writing engine code, and getting a loop
 * wrong meant a silently misshapen prop.
 *
 * So this module is the *lower* half of the pipeline: a small declared vocabulary of **modules**
 * (a box, a stack of slabs, a row, a grid, a ring, a scatter) plus **operations** that move,
 * mirror and turn what the modules emitted, all emitting one primitive — a **box**: centre,
 * size, rotation, colour and metalness. That primitive is what both live consumers already
 * take:
 *
 *   - the curated `VoxelBatch.box(...)` (one instanced draw per material family), and
 *   - the state-content `voxels` list, where a voxel *is* a unit box at an integer cell, which
 *     is why `toVoxelList()` exists and refuses anything that is not.
 *
 * One vocabulary, two sinks, no contributor-authored Three.js in between.
 *
 * WHAT IS DECLARED, AND WHY EACH DECLARATION PAYS FOR ITSELF
 * ----------------------------------------------------------
 * 0. **A recipe is a sequence of steps.** `steps: [{ module: 'box', … }, { op: 'mirrorX' }, …]` —
 *    one ordered list, because that is how the code it replaces read and how a shape is
 *    described: this, then a copy of it, then a lid. An operation applies to what the steps
 *    *before* it emitted, so `mirrorX` two boxes in is a pair of legs and mirrorX at the end is
 *    a symmetric whole. Making the list ordered is what lets the shipped art be reproduced
 *    exactly instead of approximately.
 * 1. **The module table is the schema.** `CONTENT_RECIPE_MODULES` declares, per module, its
 *    parameters (name, type, default, range, required), what it produces, and whether it is
 *    seeded. The compiler validates against that table before it compiles, so an unknown
 *    module, a misspelled parameter, an out-of-range number or a missing required field is a
 *    **refusal with the path and the reason** rather than a `NaN` that reaches the GPU.
 * 2. **Colours are roles, not literals.** A module names a role (`bun`, `chips`, `stone`) and
 *    the recipe's palette resolves it. A recolor is a palette edit and cannot change the
 *    geometry; an unknown role is a refusal; a palette entry that is not a six-digit hex is a
 *    refusal. The curated items keep their exact shipped colours with this indirection in
 *    place — that is asserted, not asserted-by-eye.
 * 3. **Determinism is structural.** Everything except `scatter` is a pure function of its
 *    parameters, and `scatter` is a pure function of its parameters **and the recipe's seed**.
 *    `compileContentRecipe(recipe, { seed })` therefore returns byte-identical boxes for the
 *    same inputs, and the result carries a `digest` a gate can compare across a reload, a
 *    rebuild or another process.
 * 4. **Bounds are the renderer's own arithmetic.** The compiled bounds are measured with
 *    `THREE.Box3` over transforms built exactly as `VoxelBatch` builds them, so "the recipe's
 *    bounds" and "the mesh in the scene" are the same number and a gate can compare them
 *    without a tolerance chosen to make the comparison pass.
 * 5. **Budgets and refusals are stated.** Boxes per recipe, a coordinate extent, a size
 *    ceiling, modules and ops per recipe. The limit table is small and printed by
 *    `describeContentRecipe()`, which is what a contributor tool (`CNT-03`) shows before it
 *    previews anything.
 *
 * WHAT THIS SLICE DELIBERATELY LEAVES ALONE
 * -----------------------------------------
 * The two shipped landmarks are **not re-authored**: `DET-09` already expresses them as data and
 * re-writing them would change nothing but the diff. The state packs keep their literal
 * `voxels` lists for the same reason — the recipe path is *proved* against them (a compiled
 * recipe passes the `CNT-01` validator), and converting the packs is `CNT-04`'s work, done
 * through the preview tool `CNT-03` builds.
 */
import * as THREE from 'three';

/** The recipe format's version. A file from a newer version is refused rather than guessed at. */
export const CONTENT_RECIPE_VERSION = 1;

/** Declared ceilings. Every one of these is a refusal, not a warning. */
export const CONTENT_RECIPE_LIMITS = Object.freeze({
  /** Boxes one recipe may compile to. */
  boxesPerRecipe: 256,
  /** Steps one recipe may declare (a step is one module or one operation). */
  stepsPerRecipe: 64,
  /** Operations one recipe may apply. */
  operationsPerRecipe: 16,
  /** No box centre may sit outside ±this on any axis. */
  extent: 64,
  /** No box may be larger than this on any axis. */
  size: 16,
  /** Palette entries one recipe may declare. */
  paletteRoles: 16,
  /** A single module's own emitted-box ceiling (`stack`, `grid` and `scatter` can loop). */
  boxesPerModule: 128,
});

/** Thrown for every refusal this module makes. `path` names the field that was wrong. */
export class ContentRecipeError extends Error {
  constructor(message, { path = null, code = 'recipe' } = {}) {
    super(message);
    this.name = 'ContentRecipeError';
    this.path = path;
    this.code = code;
  }
}

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
// A role is an object key a contributor types: lowercase first, camelCase allowed.
const ROLE_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;

const fail = (message, path, code) => { throw new ContentRecipeError(message, { path, code }); };

// ---------------------------------------------------------------------------------------------
// Parameter vocabulary
// ---------------------------------------------------------------------------------------------

const number = (name, { min = -CONTENT_RECIPE_LIMITS.extent, max = CONTENT_RECIPE_LIMITS.extent, fallback = 0 } = {}) =>
  ({ name, type: 'number', min, max, default: fallback });
const positive = (name, { min = 0, max = CONTENT_RECIPE_LIMITS.size, fallback = 1 } = {}) =>
  ({ name, type: 'number', min, max, default: fallback });
const count = (name, { min = 1, max = 64, fallback = 1 } = {}) =>
  ({ name, type: 'integer', min, max, default: fallback });
const vec3 = (name, fallback = [0, 0, 0], { min = -CONTENT_RECIPE_LIMITS.extent, max = CONTENT_RECIPE_LIMITS.extent } = {}) =>
  ({ name, type: 'vec3', min, max, default: fallback });
const size3 = (name, fallback = [1, 1, 1]) => ({ name, type: 'size3', min: 0, max: CONTENT_RECIPE_LIMITS.size, default: fallback });
const role = (name, { required = true } = {}) => ({ name, type: 'role', required, default: null });
const roles = (name, { required = false } = {}) => ({ name, type: 'role[]', required, default: null });

// ---------------------------------------------------------------------------------------------
// The module table — the supported modules the gate names
// ---------------------------------------------------------------------------------------------

/**
 * One emitted box. `VoxelBatch.box(...)` takes exactly these fields in this order, and
 * `toVoxelList()` collapses them when (and only when) they are unit boxes at integer cells.
 */

const boxOf = (x, y, z, size, color, rotation = [0, 0, 0], metalness = 0) => ({
  x, y, z,
  sizeX: size[0], sizeY: size[1], sizeZ: size[2],
  rx: rotation[0], ry: rotation[1], rz: rotation[2],
  color, metalness,
});

const emit = (context, list) => {
  if (list.length > CONTENT_RECIPE_LIMITS.boxesPerModule) {
    fail(`a ${context.module} module emits ${list.length} boxes, over the ${CONTENT_RECIPE_LIMITS.boxesPerModule} ceiling`, context.path, 'budget');
  }
  if (!list.length) fail(`a ${context.module} module emitted nothing — its parameters describe an empty shape`, context.path, 'empty');
  return list;
};

/** `box` — the primitive. Every other module is sugar over this one, and so is every pack voxel. */
const MODULE_BOX = {
  id: 'box',
  summary: 'One box: a centre, a size and a colour role. The primitive every other module expands to.',
  seeded: false,
  params: [
    vec3('at'), size3('size', [1, 1, 1]), role('color'),
    vec3('rotation', [0, 0, 0], { min: -Math.PI * 2, max: Math.PI * 2 }),
    number('metalness', { min: 0, max: 1, fallback: 0 }),
  ],
  compile: ({ at, size, color, rotation, metalness }, context) =>
    [boxOf(at[0], at[1], at[2], size, context.resolve(color), rotation, metalness)],
};

/**
 * `stack` — slabs piled on the Y axis.
 *
 * Two ways to say it, because both are natural: `layers` for a shape whose slabs are each their
 * own decision (a burger), and `count`/`yStep`/`sizeStep`/`crown` for one that repeats (a
 * parotta, a row of dosa slices). The parameters compose: `crown` lifts the middle of a run,
 * which is how a fan of slices reads as a fan rather than a wall.
 */
const MODULE_STACK = {
  id: 'stack',
  summary: 'Slabs piled on Y: explicit `layers`, or `count` with y/size/spin steps and an optional `crown`.',
  seeded: false,
  params: [
    { name: 'layers', type: 'layers', required: false, default: null },
    count('count', { max: 24, fallback: 1 }),
    number('y', { min: -CONTENT_RECIPE_LIMITS.extent, max: CONTENT_RECIPE_LIMITS.extent, fallback: 0 }),
    number('yStep', { min: -CONTENT_RECIPE_LIMITS.size, max: CONTENT_RECIPE_LIMITS.size, fallback: 0 }),
    number('zStep', { min: -CONTENT_RECIPE_LIMITS.extent, max: CONTENT_RECIPE_LIMITS.extent, fallback: 0 }),
    number('crown', { min: 0, max: CONTENT_RECIPE_LIMITS.size, fallback: 0 }),
    size3('size', [1, 1, 1]),
    size3('sizeStep', [0, 0, 0]),
    vec3('paritySize', [0, 0, 0], { min: -CONTENT_RECIPE_LIMITS.size, max: CONTENT_RECIPE_LIMITS.size }),
    number('spinStep', { min: -Math.PI * 2, max: Math.PI * 2, fallback: 0 }),
    role('color', { required: false }), roles('colorCycle'),
  ],
  compile: (params, context) => {
    const boxes = [];
    const cycle = params.colorCycle ?? (params.color ? [params.color] : [null]);
    if (params.layers) {
      params.layers.forEach((layer, index) => {
        const selected = layer.color ?? cycle[index % cycle.length];
        if (!selected) fail(`stack layer ${index} names no colour and the module declares no cycle to fall back on`, context.path, 'required');
        boxes.push(boxOf(layer.at[0], layer.at[1], layer.at[2], layer.size,
          context.resolve(selected),
          layer.rotation ?? [0, 0, 0], layer.metalness ?? 0));
      });
      return emit(context, boxes);
    }
    const middle = (params.count - 1) / 2;
    for (let index = 0; index < params.count; index++) {
      const lift = params.crown ? params.crown * (middle - Math.abs(index - middle)) : 0;
      const parity = index % 2 ? -1 : 0;
      const size = [
        params.size[0] + params.sizeStep[0] * index + params.paritySize[0] * parity,
        params.size[1] + params.sizeStep[1] * index + params.paritySize[1] * parity,
        params.size[2] + params.sizeStep[2] * index + params.paritySize[2] * parity,
      ];
      if (size.some(value => value <= 0)) {
        fail(`stack layer ${index} has a non-positive size (${size.join(', ')}) — the step has eaten the slab`, context.path, 'degenerate');
      }
      boxes.push(boxOf(
        0,
        params.y + params.yStep * index + lift,
        (index - middle) * params.zStep,
        size,
        context.resolve(cycle[index % cycle.length] ?? cycle[0]),
        [0, params.spinStep * index, 0],
      ));
    }
    return emit(context, boxes);
  },
};

/** `row` — the same box placed along one vector, with a cycled colour. Stripes, slats, spokes. */
const MODULE_ROW = {
  id: 'row',
  summary: '`count` copies of one box stepping along `step` from `at`, with an optional cycled colour.',
  seeded: false,
  params: [
    vec3('at'), size3('size', [1, 1, 1]), vec3('step', [1, 0, 0]), count('count', { max: 64 }),
    role('color', { required: false }), roles('colorCycle'),
    number('spinStep', { min: -Math.PI * 2, max: Math.PI * 2, fallback: 0 }),
  ],
  compile: (params, context) => {
    const boxes = [];
    for (let index = 0; index < params.count; index++) {
      const selected = params.colorCycle?.length ? params.colorCycle[index % params.colorCycle.length] : params.color;
      boxes.push(boxOf(
        params.at[0] + params.step[0] * index,
        params.at[1] + params.step[1] * index,
        params.at[2] + params.step[2] * index,
        params.size,
        context.resolve(selected),
        [0, params.spinStep * index, 0],
      ));
    }
    return emit(context, boxes);
  },
};

/**
 * `grid` — cells in a rectangle, in column-major order.
 *
 * The cell order is declared rather than incidental (column first, then row) because the
 * shipped chip basket alternates a cell's height and spins it by its **index**, and an
 * undocumented order would make the recipe depend on the compiler's loop nesting. `count` stops
 * the fill early, which is how a basket of seven chips in a 3x3 tray is said in one module.
 */
const MODULE_GRID = {
  id: 'grid',
  summary: 'A rectangle of cells: `columns` x `rows`, column-major, with parity lift, per-index spin and an optional early `count`.',
  seeded: false,
  params: [
    vec3('at'), size3('size', [1, 1, 1]),
    count('columns', { max: 16, fallback: 1 }), count('rows', { max: 16, fallback: 1 }),
    number('stepX', { min: 0, max: CONTENT_RECIPE_LIMITS.extent, fallback: 1 }),
    number('stepZ', { min: 0, max: CONTENT_RECIPE_LIMITS.extent, fallback: 1 }),
    number('parityY', { min: -CONTENT_RECIPE_LIMITS.size, max: CONTENT_RECIPE_LIMITS.size, fallback: 0 }),
    number('spinStep', { min: -Math.PI * 2, max: Math.PI * 2, fallback: 0 }),
    count('count', { max: 256, fallback: 0 }),
    role('color', { required: false }), roles('colorCycle'),
    { name: 'skipCenter', type: 'boolean', required: false, default: false },
  ],
  compile: (params, context) => {
    const boxes = [];
    const total = params.columns * params.rows;
    const limit = params.count ? Math.min(params.count, total) : total;
    for (let index = 0; index < limit; index++) {
      const column = index % params.columns, rowIndex = Math.floor(index / params.columns);
      if (params.skipCenter && column === (params.columns - 1) / 2 && rowIndex === (params.rows - 1) / 2) continue;
      const selected = params.colorCycle?.length ? params.colorCycle[index % params.colorCycle.length] : params.color;
      boxes.push(boxOf(
        params.at[0] + (column - (params.columns - 1) / 2) * params.stepX,
        params.at[1] + (index % 2 ? params.parityY : 0),
        params.at[2] + (rowIndex - (params.rows - 1) / 2) * params.stepZ,
        params.size,
        context.resolve(selected),
        [0, params.spinStep * index, 0],
      ));
    }
    return emit(context, boxes);
  },
};

/** `ring` — boxes on a circle in one of the three planes. Wheels, rims, garlands, lamps. */
const MODULE_RING = {
  id: 'ring',
  summary: '`count` boxes evenly spaced on a circle of `radius` in the declared axis plane.',
  seeded: false,
  params: [
    vec3('at'), size3('size', [1, 1, 1]),
    positive('radius', { min: 0, max: CONTENT_RECIPE_LIMITS.extent, fallback: 1 }),
    count('count', { max: 64, fallback: 8 }),
    { name: 'axis', type: 'enum', oneOf: ['x', 'y', 'z'], default: 'y' },
    number('phase', { min: -Math.PI * 2, max: Math.PI * 2, fallback: 0 }),
    role('color', { required: false }), roles('colorCycle'),
  ],
  compile: (params, context) => {
    const boxes = [];
    for (let index = 0; index < params.count; index++) {
      const angle = params.phase + (Math.PI * 2 * index) / params.count;
      const offset = [Math.cos(angle) * params.radius, Math.sin(angle) * params.radius];
      const [x, y, z] = params.axis === 'y' ? [offset[0], 0, offset[1]] : params.axis === 'x' ? [0, offset[0], offset[1]] : [offset[0], offset[1], 0];
      const selected = params.colorCycle?.length ? params.colorCycle[index % params.colorCycle.length] : params.color;
      boxes.push(boxOf(params.at[0] + x, params.at[1] + y, params.at[2] + z, params.size, context.resolve(selected)));
    }
    return emit(context, boxes);
  },
};

/**
 * `scatter` — the one **seeded** module.
 *
 * It exists because a plausible-looking sprinkle of detail (gravel, crumbs, petals, rubble)
 * must still be the same sprinkle after a reload, and the honest way to promise that is to
 * declare the module seeded and derive every draw from the recipe's seed through a named
 * generator. A negative control that removes the seed dependency fails the determinism test.
 */
const MODULE_SCATTER = {
  id: 'scatter',
  summary: 'Seeded, deterministic scatter of `count` boxes inside an `area` volume, with a size range and a cycled colour.',
  seeded: true,
  params: [
    vec3('at'), size3('area', [2, 1, 2]), count('count', { max: 96, fallback: 8 }),
    size3('size', [0.2, 0.2, 0.2]), number('sizeVariance', { min: 0, max: CONTENT_RECIPE_LIMITS.size, fallback: 0 }),
    role('color'), roles('colorCycle'),
  ],
  compile: (params, context) => {
    const boxes = [];
    const random = seededRandom(context.seed, context.path);
    for (let index = 0; index < params.count; index++) {
      const factor = params.sizeVariance ? 1 + (random() * 2 - 1) * params.sizeVariance : 1;
      const size = params.size.map(value => Math.max(0.01, value * factor));
      const selected = params.colorCycle?.length ? params.colorCycle[index % params.colorCycle.length] : params.color;
      boxes.push(boxOf(
        params.at[0] + (random() - 0.5) * params.area[0],
        params.at[1] + (random() - 0.5) * params.area[1],
        params.at[2] + (random() - 0.5) * params.area[2],
        size,
        context.resolve(selected),
        [0, random() * Math.PI * 2, 0],
      ));
    }
    return emit(context, boxes);
  },
};

export const CONTENT_RECIPE_MODULES = Object.freeze(Object.fromEntries(
  [MODULE_BOX, MODULE_STACK, MODULE_ROW, MODULE_GRID, MODULE_RING, MODULE_SCATTER].map(module => [module.id, Object.freeze(module)]),
));

// ---------------------------------------------------------------------------------------------
// Operations — the algebra over what the modules emitted
// ---------------------------------------------------------------------------------------------

export const CONTENT_RECIPE_OPERATIONS = Object.freeze({
  translate: Object.freeze({
    id: 'translate',
    summary: 'Move every box emitted so far by `by`.',
    params: [vec3('by', [0, 1, 0])],
    apply: (boxes, params) => boxes.map(box => ({ ...box, x: box.x + params.by[0], y: box.y + params.by[1], z: box.z + params.by[2] })),
  }),
  mirrorX: Object.freeze({
    id: 'mirrorX',
    summary: 'Append a mirrored copy of every box emitted so far across the X axis (rotations mirror with it).',
    params: [vec3('about', [0, 0, 0])],
    apply: (boxes, params) => [
      ...boxes,
      ...boxes.map(box => ({
        ...box,
        x: 2 * params.about[0] - box.x,
        // A mirrored box that also spins must turn the other way, or the copy faces its pair.
        // `Math.abs` keeps a zero rotation a zero: `-0` and `0` are different strings to a
        // digest and different values to `deepStrictEqual`, which would make a parity test fail
        // for a reason that has nothing to do with the shape.
        ry: -box.ry + 0, rz: -box.rz + 0,
      })),
    ],
  }),
  rotateY: Object.freeze({
    id: 'rotateY',
    summary: 'Turn every box emitted so far about the Y axis in quarter turns (`turns` x 90 degrees).',
    params: [{ name: 'turns', type: 'integer', min: -4, max: 4, default: 1 }],
    apply: (boxes, params) => {
      const angle = (params.turns * Math.PI) / 2;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      return boxes.map(box => ({
        ...box,
        x: box.x * cos + box.z * sin,
        z: -box.x * sin + box.z * cos,
        ry: box.ry + angle,
      }));
    },
  }),
});

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

function seededRandom(seed, path) {
  // A 32-bit LCG seeded from the recipe's own seed and the module's path: the same recipe in
  // the same position always draws the same numbers, and moving a module changes its stream
  // rather than everything after it.
  let state = fnv1a(`${seed}|${path}`) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** FNV-1a, the project's one hash (`providerFingerprint`, place ids and now recipe digests). */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const HEX_OF = hash => hash.toString(16).padStart(8, '0');

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function checkNumber(value, spec, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${spec.name} must be a finite number, got ${JSON.stringify(value)}`, path, 'type');
  }
  if (spec.type === 'integer' && !Number.isInteger(value)) {
    fail(`${spec.name} must be an integer, got ${value}`, path, 'type');
  }
  if (value < spec.min || value > spec.max) {
    fail(`${spec.name} is ${value}, outside the declared range ${spec.min}..${spec.max}`, path, 'range');
  }
  return value;
}

function checkVec(value, spec, path) {
  if (!Array.isArray(value) || value.length !== 3) fail(`${spec.name} must be three numbers, got ${JSON.stringify(value)}`, path, 'type');
  value.forEach((entry, index) => checkNumber(entry, { ...spec, name: `${spec.name}[${index}]`, type: 'number' }, path));
  return value;
}

function checkRole(value, spec, palette, path) {
  if (typeof value !== 'string' || !ROLE_PATTERN.test(value)) {
    fail(`${spec.name} must be a role name (lowercase first letter, letters/digits/underscores), got ${JSON.stringify(value)}`, path, 'type');
  }
  if (!Object.prototype.hasOwnProperty.call(palette, value)) {
    fail(`${spec.name} names the role "${value}", which the palette does not declare (it has: ${Object.keys(palette).join(', ') || 'none'})`, path, 'palette');
  }
  return value;
}

function checkParams(module, declared, palette, path) {
  const params = {};
  const known = new Set(module.params.map(spec => spec.name));
  for (const key of Object.keys(declared)) {
    if (!known.has(key)) {
      fail(`module "${module.id}" has no parameter "${key}" (it has: ${[...known].join(', ')})`, `${path}.${key}`, 'parameter');
    }
  }
  for (const spec of module.params) {
    const raw = declared[spec.name];
    const present = raw !== undefined && raw !== null;
    if (!present) {
      if (spec.required) fail(`module "${module.id}" requires "${spec.name}"`, `${path}.${spec.name}`, 'required');
      params[spec.name] = spec.default;
      continue;
    }
    switch (spec.type) {
      case 'number': case 'integer': params[spec.name] = checkNumber(raw, spec, `${path}.${spec.name}`); break;
      case 'size3': params[spec.name] = checkVec(raw, spec, `${path}.${spec.name}`).map((entry, index) => {
        if (entry <= 0) fail(`${spec.name}[${index}] must be positive, got ${entry}`, `${path}.${spec.name}`, 'degenerate');
        return entry;
      }); break;
      case 'vec3': params[spec.name] = checkVec(raw, spec, `${path}.${spec.name}`); break;
      case 'role': params[spec.name] = checkRole(raw, spec, palette, `${path}.${spec.name}`); break;
      case 'role[]':
        if (!Array.isArray(raw) || !raw.length) fail(`${spec.name} must be a non-empty array of role names`, `${path}.${spec.name}`, 'type');
        params[spec.name] = raw.map(entry => checkRole(entry, spec, palette, `${path}.${spec.name}`));
        break;
      case 'enum':
        if (!spec.oneOf.includes(raw)) fail(`${spec.name} must be one of ${spec.oneOf.join(', ')}, got ${JSON.stringify(raw)}`, `${path}.${spec.name}`, 'type');
        params[spec.name] = raw;
        break;
      case 'boolean': params[spec.name] = Boolean(raw); break;
      case 'layers': {
        if (!Array.isArray(raw) || !raw.length) fail(`${spec.name} must be a non-empty array of layers`, `${path}.${spec.name}`, 'type');
        params[spec.name] = raw.map((layer, index) => {
          const layerPath = `${path}.${spec.name}[${index}]`;
          if (!isPlainObject(layer)) fail('a layer must be an object', layerPath, 'type');
          const keys = new Set(['at', 'size', 'color', 'rotation', 'metalness']);
          for (const key of Object.keys(layer)) if (!keys.has(key)) fail(`a layer has no field "${key}" (it has: ${[...keys].join(', ')})`, `${layerPath}.${key}`, 'parameter');
          if (!Array.isArray(layer.size) || layer.size.length !== 3) fail('a layer requires size [x, y, z]', `${layerPath}.size`, 'required');
          const size = checkVec(layer.size, { name: 'size', min: 0, max: CONTENT_RECIPE_LIMITS.size }, `${layerPath}.size`).map((entry, axis) => {
            if (entry <= 0) fail(`size[${axis}] must be positive, got ${entry}`, `${layerPath}.size`, 'degenerate');
            return entry;
          });
          return {
            at: layer.at ? checkVec(layer.at, { name: 'at', min: -CONTENT_RECIPE_LIMITS.extent, max: CONTENT_RECIPE_LIMITS.extent }, `${layerPath}.at`) : [0, 0, 0],
            size,
            color: layer.color ? checkRole(layer.color, { name: 'color' }, palette, `${layerPath}.color`) : null,
            rotation: layer.rotation ? checkVec(layer.rotation, { name: 'rotation', min: -Math.PI * 2, max: Math.PI * 2 }, `${layerPath}.rotation`) : null,
            metalness: layer.metalness === undefined ? 0 : checkNumber(layer.metalness, { name: 'metalness', type: 'number', min: 0, max: 1 }, `${layerPath}.metalness`),
          };
        });
        break;
      }
      default: fail(`the compiler does not know the parameter type "${spec.type}"`, `${path}.${spec.name}`, 'internal');
    }
  }
  // `stack` and `row`/`grid`/`ring` accept either a single colour or a cycle; requiring at least
  // one is what stops a module compiling with an undefined role that only shows up as a black
  // prop. A stack whose explicit layers each name their own colour needs neither.
  const layered = Array.isArray(params.layers) && params.layers.every(layer => layer.color);
  if ('color' in params && params.color === null && !params.colorCycle && !layered) {
    fail(`module "${module.id}" needs a colour role, a colour cycle, or per-layer colours`, `${path}.color`, 'required');
  }
  return params;
}

/** The printable description a contributor tool (`CNT-03`) shows before a preview. */
export function describeContentRecipe() {
  return {
    version: CONTENT_RECIPE_VERSION,
    limits: { ...CONTENT_RECIPE_LIMITS },
    modules: Object.values(CONTENT_RECIPE_MODULES).map(module => ({
      id: module.id,
      summary: module.summary,
      seeded: module.seeded,
      parameters: module.params.map(spec => ({
        name: spec.name, type: spec.type, required: Boolean(spec.required),
        default: spec.default === undefined ? null : spec.default,
        range: spec.oneOf ? spec.oneOf : (spec.min === undefined ? null : [spec.min, spec.max]),
      })),
    })),
    operations: Object.values(CONTENT_RECIPE_OPERATIONS).map(operation => ({
      id: operation.id,
      summary: operation.summary,
      parameters: operation.params.map(spec => ({ name: spec.name, type: spec.type, default: spec.default })),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------------------------

const round6 = value => Math.round(value * 1e6) / 1e6;

/** Bounds measured the way the renderer measures them: the transform is the batch's own. */
const TURN = Math.PI * 2;

/**
 * Report an angle in (-pi, pi]. A box turned by a full turn is the box, so a recipe that says
 * `rotateY { turns: 4 }` or a `spinStep` of 2pi must land on the same numbers as one that says
 * nothing — otherwise the digest would call two identical poses different, and the digest is the
 * thing the state pack and the visual gate both compare.
 */
const wrapAngle = angle => angle - TURN * Math.round(angle / TURN);

const BOUNDS_UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

function boundsOf(boxes) {
  const box = new THREE.Box3();
  // A unit box scaled, moved and turned exactly as `VoxelBatch` instances it. `precise` measures
  // the eight real corners, so a spun box is bounded by its silhouette rather than by a
  // conservative wrap — the same number the renderer's own `Box3.setFromObject` reports.
  const object = new THREE.Mesh(BOUNDS_UNIT_BOX);
  object.matrixAutoUpdate = true;
  for (const entry of boxes) {
    object.position.set(entry.x, entry.y, entry.z);
    object.scale.set(entry.sizeX, entry.sizeY, entry.sizeZ);
    object.rotation.set(entry.rx, entry.ry, entry.rz);
    box.expandByObject(object, true);
  }
  return { min: [round6(box.min.x), round6(box.min.y), round6(box.min.z)], max: [round6(box.max.x), round6(box.max.y), round6(box.max.z)] };
}

/**
 * Compile a recipe into boxes.
 *
 * Refusals happen before anything is emitted and again after: an unknown module or op, a bad
 * parameter, an unknown role, a palette that is not a palette, a recipe over its box budget, a
 * box outside the declared extent. `notes` carries what the compiler *did* have to decide —
 * overlapping boxes it merged — so a contributor sees the repair rather than discovering it.
 */
export function compileContentRecipe(recipe, { seed = 0 } = {}) {
  if (!isPlainObject(recipe)) fail(`a recipe must be an object, got ${typeof recipe}`, 'recipe', 'type');
  const version = recipe.version ?? CONTENT_RECIPE_VERSION;
  if (!Number.isInteger(version) || version < 1) fail(`recipe version must be a positive integer, got ${JSON.stringify(recipe.version)}`, 'recipe.version', 'type');
  if (version > CONTENT_RECIPE_VERSION) {
    fail(`this build compiles recipe version ${CONTENT_RECIPE_VERSION}, and the recipe is version ${version}`, 'recipe.version', 'version');
  }
  const palette = recipe.palette;
  if (!isPlainObject(palette) || !Object.keys(palette).length) fail('a recipe needs a palette of colour roles', 'recipe.palette', 'required');
  if (Object.keys(palette).length > CONTENT_RECIPE_LIMITS.paletteRoles) {
    fail(`a palette may declare at most ${CONTENT_RECIPE_LIMITS.paletteRoles} roles, this one has ${Object.keys(palette).length}`, 'recipe.palette', 'budget');
  }
  for (const [name, colour] of Object.entries(palette)) {
    if (!ROLE_PATTERN.test(name)) fail(`palette role "${name}" must be lowercase letters, digits and underscores`, `recipe.palette.${name}`, 'type');
    if (typeof colour !== 'string' || !COLOR_PATTERN.test(colour)) {
      fail(`palette role "${name}" must be a six-digit hex colour, got ${JSON.stringify(colour)}`, `recipe.palette.${name}`, 'color');
    }
  }
  if (!Array.isArray(recipe.steps) || !recipe.steps.length) fail('a recipe needs a non-empty `steps` array', 'recipe.steps', 'required');
  if (recipe.steps.length > CONTENT_RECIPE_LIMITS.stepsPerRecipe) {
    fail(`a recipe may declare at most ${CONTENT_RECIPE_LIMITS.stepsPerRecipe} steps, this one has ${recipe.steps.length}`, 'recipe.steps', 'budget');
  }

  // Unreachable while every colour parameter passes through `checkRole`, which names the step
  // and the field. It is kept as the last line of defence for a module added later: an
  // `undefined` colour does not fail here, it fails on the GPU as an invisible box.
  const resolveRole = name => {
    if (!Object.prototype.hasOwnProperty.call(palette, name)) {
      fail(`a module asked for the palette role "${name}", which the palette does not declare (it has: ${Object.keys(palette).join(', ') || 'none'})`, 'recipe.palette', 'palette');
    }
    return palette[name];
  };

  let boxes = [];
  const usedModules = [];
  const usedOperations = [];
  const notes = [];
  let operationCount = 0;
  recipe.steps.forEach((declared, index) => {
    const path = `recipe.steps[${index}]`;
    if (!isPlainObject(declared)) fail('a step must be an object', path, 'type');
    const isOperation = typeof declared.op === 'string';
    const isModule = typeof declared.module === 'string';
    if (isOperation === isModule) {
      fail(`a step declares either "module" or "op", and this one declares ${isOperation && isModule ? 'both' : 'neither'}`, path, 'type');
    }
    if (isOperation) {
      const operation = CONTENT_RECIPE_OPERATIONS[declared.op];
      if (!operation) {
        fail(`unknown operation ${JSON.stringify(declared.op)} (supported: ${Object.keys(CONTENT_RECIPE_OPERATIONS).join(', ')})`, `${path}.op`, 'operation');
      }
      operationCount++;
      if (operationCount > CONTENT_RECIPE_LIMITS.operationsPerRecipe) {
        fail(`a recipe may apply at most ${CONTENT_RECIPE_LIMITS.operationsPerRecipe} operations`, path, 'budget');
      }
      const known = new Set(operation.params.map(spec => spec.name));
      for (const key of Object.keys(declared)) {
        if (key !== 'op' && !known.has(key)) fail(`operation "${operation.id}" has no parameter "${key}"`, `${path}.${key}`, 'parameter');
      }
      const params = {};
      for (const spec of operation.params) {
        const raw = declared[spec.name];
        params[spec.name] = raw === undefined ? spec.default
          : spec.type === 'integer' ? checkNumber(raw, spec, `${path}.${spec.name}`)
            : checkVec(raw, spec, `${path}.${spec.name}`);
      }
      usedOperations.push(operation.id);
      // An operation with nothing before it is legal and empty (`mirrorX` of nothing is still
      // nothing) but it is almost always a reordered recipe, so it is worth saying out loud.
      if (!boxes.length) notes.push(`step ${index} (${operation.id}) ran before any box was emitted, so it had nothing to act on`);
      boxes = operation.apply(boxes, params);
      return;
    }
    const module = CONTENT_RECIPE_MODULES[declared.module];
    if (!module) {
      fail(`unknown module ${JSON.stringify(declared.module)} (supported: ${Object.keys(CONTENT_RECIPE_MODULES).join(', ')})`, `${path}.module`, 'module');
    }
    // The step's own discriminator is not a module parameter: it is stripped before the module
    // sees the declaration, so `{ module: 'box', … }` does not have to declare a `module` param.
    const { module: _discriminator, ...paramSource } = declared;
    const params = checkParams(module, paramSource, palette, path);
    usedModules.push(module.id);
    boxes = boxes.concat(module.compile(params, { module: module.id, path, seed, resolve: resolveRole }));
  });

  // Overlapping boxes are merged rather than refused: two modules describing the same cell is a
  // composition a contributor will write on purpose (a lid over a pot), and the *last* box wins
  // — the language's own precedence rule — with a note so the merge is visible.
  // Every number is rounded to the micrometre the compiler reports, and `-0` is normalised to
  // `0`: a mirrored or quarter-turned box can produce it, and it is a different string to the
  // digest and a different value to `deepStrictEqual` while being the same place in space.
  const clean = value => (round6(value) === 0 ? 0 : round6(value));
  boxes = boxes.map(box => ({
    ...box,
    x: clean(box.x), y: clean(box.y), z: clean(box.z),
    sizeX: clean(box.sizeX), sizeY: clean(box.sizeY), sizeZ: clean(box.sizeZ),
    rx: clean(wrapAngle(box.rx)), ry: clean(wrapAngle(box.ry)), rz: clean(wrapAngle(box.rz)),
    metalness: clean(box.metalness),
  }));

  const byCell = new Map();
  for (const box of boxes) {
    const key = `${box.x}|${box.y}|${box.z}|${box.sizeX}|${box.sizeY}|${box.sizeZ}`;
    const previous = byCell.get(key);
    if (previous && previous.color !== box.color) notes.push(`two boxes at (${box.x}, ${box.y}, ${box.z}) overlapped; the later colour ${box.color} replaced ${previous.color}`);
    byCell.set(key, box);
  }
  boxes = [...byCell.values()];

  if (boxes.length > CONTENT_RECIPE_LIMITS.boxesPerRecipe) {
    fail(`the recipe compiles to ${boxes.length} boxes, over the ${CONTENT_RECIPE_LIMITS.boxesPerRecipe} ceiling`, 'recipe.modules', 'budget');
  }
  for (const box of boxes) {
    for (const axis of ['x', 'y', 'z']) {
      if (Math.abs(box[axis]) > CONTENT_RECIPE_LIMITS.extent) {
        fail(`a box sits at ${axis}=${box[axis]}, outside the declared ±${CONTENT_RECIPE_LIMITS.extent} extent`, 'recipe.operations', 'extent');
      }
    }
    for (const axis of ['sizeX', 'sizeY', 'sizeZ']) {
      if (box[axis] > CONTENT_RECIPE_LIMITS.size) {
        fail(`a box is ${box[axis]} on ${axis}, over the ${CONTENT_RECIPE_LIMITS.size} size ceiling`, 'recipe.modules', 'budget');
      }
    }
    if (!COLOR_PATTERN.test(box.color)) fail(`a compiled box carries the colour ${JSON.stringify(box.color)}`, 'recipe.palette', 'color');
  }

  const digest = HEX_OF(fnv1a(canonicalRecipeKey(boxes)));
  return {
    version,
    boxes,
    boxCount: boxes.length,
    bounds: boundsOf(boxes),
    modules: usedModules,
    operations: usedOperations,
    steps: recipe.steps.length,
    palette: { ...palette },
    seeded: usedModules.some(id => CONTENT_RECIPE_MODULES[id].seeded),
    notes,
    digest,
  };
}

/**
 * The digest's input: every field of every box, rounded to the micrometre the compiler reports
 * and ordered by the compiler's own emission order. A different palette, a different seed or a
 * nudge to any parameter changes it; nothing else does.
 */
function canonicalRecipeKey(boxes) {
  return boxes.map(box => [
    box.x, box.y, box.z, box.sizeX, box.sizeY, box.sizeZ, box.rx, box.ry, box.rz, box.color, box.metalness,
  ].map(value => (typeof value === 'number' ? round6(value) : value)).join(',')).join(';');
}

/**
 * The state-content adapter: a recipe's boxes as a `CNT-01` `voxels` list.
 *
 * A voxel is a **unit box at an integer cell**, so this refuses anything else — a box that is
 * 0.65 wide or sits at y = 0.5 is a *prop*, and quietly rounding it would put a pack's geometry
 * somewhere the pack does not say. The refusal is the feature: it is the boundary between the
 * two sinks this compiler serves, stated once.
 */
export function toVoxelList(compiled) {
  const boxes = compiled?.boxes ?? compiled;
  if (!Array.isArray(boxes)) fail('toVoxelList needs a compiled recipe or a box list', 'voxels', 'type');
  return boxes.map((box, index) => {
    const integer = value => Number.isInteger(round6(value));
    if (![box.x, box.y, box.z].every(integer)) {
      fail(`box ${index} is centred at (${box.x}, ${box.y}, ${box.z}); a voxel sits on an integer cell`, 'voxels', 'voxel');
    }
    if (![box.sizeX, box.sizeY, box.sizeZ].every(value => round6(value) === 1)) {
      fail(`box ${index} is (${box.sizeX}, ${box.sizeY}, ${box.sizeZ}); a voxel is a unit box`, 'voxels', 'voxel');
    }
    if (round6(box.rx) || round6(box.ry) || round6(box.rz)) fail(`box ${index} is rotated; a voxel is axis-aligned`, 'voxels', 'voxel');
    return [Math.round(box.x), Math.round(box.y), Math.round(box.z), box.color];
  });
}
