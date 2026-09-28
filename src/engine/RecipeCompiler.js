import { loadContentState } from './ContentSchema.js';
import { featureNamespace } from './FeatureVersions.js';

/**
 * `CNT-02` state/landmark recipe compiler.
 *
 * A contributor writes **data**: a collectible's voxel rows (the `CNT-01`
 * content pack) or a landmark's modules declared as small parametric ops
 * (`box`, `grid`, `step`, `tier`) plus the openings that must stay walkable.
 * This module turns that data into the compiled module list the runtime
 * consumes, so no supported module needs contributor-authored `three` code and
 * no consumer has to re-derive layout arithmetic.
 *
 * Rules that keep it honest:
 * - **Visual is not collision.** Compiled modules produce camera/visual proxies
 *   only; `solidProxies` stays empty unless the recipe explicitly declares a
 *   footprint, and interaction proxies are never implied.
 * - **Openings are reservations, not boxes.** A declared opening is never
 *   represented by one enclosing AABB: modules entirely inside it are dropped
 *   and counted, and modules that merely border it are reported by name.
 * - **Deterministic.** Fixed iteration order, integer/quantized layout,
 *   bounded counts, and a fingerprint over the compiled module list, so the
 *   same recipe always compiles to the same bytes.
 *
 * No `three` and no DOM import.
 */

export const GDO_RECIPE_NAMESPACE = featureNamespace('recipeCompiler');

export const GDO_RECIPE_KINDS = Object.freeze({
  COLLECTIBLE: 'collectible',
  LANDMARK: 'landmark',
});

/** Op kinds a landmark recipe may declare. Anything else fails by name. */
export const GDO_RECIPE_OPS = Object.freeze(['box', 'grid', 'step', 'tier']);

export const GDO_RECIPE_LIMITS = Object.freeze({
  profiles: Object.freeze({
    low: Object.freeze({ maxModulesPerRecipe: 512, maxModulesPerPack: 4_096 }),
    balanced: Object.freeze({ maxModulesPerRecipe: 1_024, maxModulesPerPack: 8_192 }),
    high: Object.freeze({ maxModulesPerRecipe: 2_048, maxModulesPerPack: 16_384 }),
  }),
  maxOpCount: 64,
  maxRepeatCount: 256,
});

export function recipeBudgetForProfile(profile) {
  const budget = GDO_RECIPE_LIMITS.profiles[profile];
  if (!budget) throw new RangeError(`Unknown recipe profile: ${profile}`);
  return budget;
}

function fnv(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

function finite(value, what) {
  if (!Number.isFinite(value)) throw new TypeError(`Recipe ${what} must be a finite number`);
  return value;
}

function vector(value, what) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(`Recipe ${what} must be a three-number array`);
  }
  return value.map((entry, index) => finite(entry, `${what}[${index}]`));
}

function template(text, fields) {
  return String(text).replace(/\{(\w+)\}/g, (match, key) =>
    (Object.hasOwn(fields, key) ? String(fields[key]) : match));
}

/** One compiled module: a box in the landmark/collectible's own local space. */
function module(id, center, size, options = {}) {
  return Object.freeze({
    id,
    x: center[0], y: center[1], z: center[2],
    sizeX: size[0], sizeY: size[1], sizeZ: size[2],
    color: options.color ?? null,
    variant: options.variant ?? null,
    minX: center[0] - size[0] / 2, maxX: center[0] + size[0] / 2,
    minY: center[1] - size[1] / 2, maxY: center[1] + size[1] / 2,
    minZ: center[2] - size[2] / 2, maxZ: center[2] + size[2] / 2,
  });
}

function intersectsOpening(entry, opening) {
  return entry.maxX > opening.minX && entry.minX < opening.maxX &&
    entry.maxY > opening.minY && entry.minY < opening.maxY &&
    entry.maxZ > opening.minZ && entry.minZ < opening.maxZ;
}

function containedByOpening(entry, opening) {
  return entry.minX >= opening.minX && entry.maxX <= opening.maxX &&
    entry.minY >= opening.minY && entry.maxY <= opening.maxY &&
    entry.minZ >= opening.minZ && entry.maxZ <= opening.maxZ;
}

function normalizeOpenings(openings) {
  return (openings ?? []).map(opening => {
    const center = vector(opening.at, 'opening.at');
    const size = vector(opening.size, 'opening.size');
    if (size.some(entry => entry <= 0)) throw new RangeError('Recipe opening sizes must be positive');
    return Object.freeze({
      id: opening.id ?? `opening:${center.join(',')}`,
      x: center[0], y: center[1], z: center[2],
      sizeX: size[0], sizeY: size[1], sizeZ: size[2],
      minX: center[0] - size[0] / 2, maxX: center[0] + size[0] / 2,
      minY: center[1] - size[1] / 2, maxY: center[1] + size[1] / 2,
      minZ: center[2] - size[2] / 2, maxZ: center[2] + size[2] / 2,
    });
  });
}

/**
 * Expand a landmark recipe's ops into modules. Every op is bounded, every count
 * is checked, and each module is named from its op's `id` template.
 */
function expandOps(recipe, budget) {
  const ops = recipe.modules ?? [];
  if (!Array.isArray(ops)) throw new TypeError('Recipe modules must be an array');
  if (ops.length > GDO_RECIPE_LIMITS.maxOpCount) {
    throw new RangeError(`Recipe declares ${ops.length} ops, over the ${GDO_RECIPE_LIMITS.maxOpCount} cap`);
  }
  const entries = [];
  const skipped = { overBudget: 0, malformed: 0 };
  const push = (id, center, size, options) => {
    if (entries.length >= budget.maxModulesPerRecipe) { skipped.overBudget++; return; }
    if (size.some(entry => entry <= 0)) { skipped.malformed++; return; }
    entries.push(module(id, center, size, options));
  };
  const branchCount = op => (op.branches?.length ?? 0) || 1;

  for (const op of ops) {
    const kind = op?.op;
    if (!GDO_RECIPE_OPS.includes(kind)) throw new RangeError(`Unknown recipe op: ${String(kind)}`);
    const fields = { op: kind, id: op.id ?? kind, index: 0 };
    if (kind === 'box') {
      push(template(op.id, fields), vector(op.at, 'box.at'), vector(op.size, 'box.size'), op);
      continue;
    }
    if (kind === 'grid') {
      const offsets = op.offsets ?? {};
      const xs = offsets.x ?? [0], zs = offsets.z ?? [0];
      const at = vector(op.at, 'grid.at'), size = vector(op.size, 'grid.size');
      const scale = { x: finite(op.scale?.x ?? 1, 'grid.scale.x'), z: finite(op.scale?.z ?? 1, 'grid.scale.z') };
      if (xs.length * zs.length > GDO_RECIPE_LIMITS.maxRepeatCount) {
        throw new RangeError('Recipe grid is over the repeat cap');
      }
      // Template fields a grid offers: `{x}`/`{z}` offsets, `{xSign}`/`{zSign}`
      // (-1/0/1, so a symmetric pair can name itself `pier:{xSign}`), and
      // `{xIndex}`/`{zIndex}` for positional naming.
      for (let xIndex = 0; xIndex < xs.length; xIndex++) {
        for (let zIndex = 0; zIndex < zs.length; zIndex++) {
          const ox = xs[xIndex], oz = zs[zIndex];
          push(template(op.id, {
            ...fields, x: ox, z: oz,
            xSign: Math.sign(ox), zSign: Math.sign(oz), xIndex, zIndex,
          }), [at[0] + ox * scale.x, at[1], at[2] + oz * scale.z], size, op);
        }
      }
      continue;
    }
    // `step`/`tier`: a bounded march, optionally repeated per branch (mirrored
    // sides), with a per-step size delta for tiered profiles.
    const base = vector(op.at, 'step.at');
    const size = vector(op.size, 'step.size');
    const step = vector(op.step ?? [0, 0, 0], 'step.step');
    const sizeStep = vector(op.sizeStep ?? [0, 0, 0], 'step.sizeStep');
    const count = Math.trunc(finite(op.count ?? 1, 'step.count'));
    if (count < 1 || count > GDO_RECIPE_LIMITS.maxRepeatCount) {
      throw new RangeError(`Recipe ${kind} count ${count} is outside [1, ${GDO_RECIPE_LIMITS.maxRepeatCount}]`);
    }
    const branches = op.branches?.length ? op.branches : [{ name: null, at: [0, 0, 0], step: [0, 0, 0] }];
    for (const branch of branches) {
      const branchAt = vector(branch.at ?? [0, 0, 0], 'branch.at');
      const branchStep = vector(branch.step ?? [0, 0, 0], 'branch.step');
      for (let index = 0; index < count; index++) {
        push(template(op.id, { ...fields, index, side: branch.name ?? '', branch: branch.name ?? '' }),
          [base[0] + branchAt[0] + (step[0] + branchStep[0]) * index,
            base[1] + branchAt[1] + (step[1] + branchStep[1]) * index,
            base[2] + branchAt[2] + (step[2] + branchStep[2]) * index],
          [size[0] + sizeStep[0] * index, size[1] + sizeStep[1] * index, size[2] + sizeStep[2] * index],
          op);
      }
    }
  }
  return { entries, skipped, branches: ops.reduce((total, op) => total + branchCount(op), 0) };
}

/**
 * Compile one collectible's voxel recipe into modules whose offsets reproduce
 * the projected layout exactly: voxels are centred on their own bounding box
 * and scaled, never re-quantized, so the compiled list is the same geometry the
 * legacy builder produced.
 */
export function compileCollectibleRecipe(recipe, { scale = .2, profile = 'low', origin = [0, 0, 0] } = {}) {
  const budget = recipeBudgetForProfile(profile);
  if (!recipe || typeof recipe !== 'object') throw new TypeError('Recipe must be an object');
  const voxels = recipe.voxels;
  if (!Array.isArray(voxels) || voxels.length === 0) {
    throw new TypeError('Collectible recipe needs a non-empty voxel list');
  }
  finite(scale, 'scale');
  if (scale <= 0) throw new RangeError('Recipe scale must be positive');
  const base = vector(origin, 'origin');
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const row of voxels) {
    if (!Array.isArray(row) || row.length < 3) throw new TypeError('Voxel rows need at least three coordinates');
    const x = finite(row[0], 'voxel.x'), y = finite(row[1], 'voxel.y'), z = finite(row[2], 'voxel.z');
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const skipped = { overBudget: 0, malformed: 0 };
  const modules = [];
  // The fingerprint hashes the *local* layout, so the same recipe placed at
  // another origin is the same recipe, without floating-point drift.
  const layout = [];
  voxels.forEach((row, index) => {
    const [x, y, z, color = null] = row;
    if (modules.length >= budget.maxModulesPerRecipe) { skipped.overBudget++; return; }
    const localX = (x - cx) * scale, localY = (y - cy) * scale, localZ = (z - cz) * scale;
    const id = `${recipe.id ?? 'voxel'}:${index}`;
    modules.push(module(id, [localX + base[0], localY + base[1], localZ + base[2]],
      [scale, scale, scale], { color }));
    layout.push(`${id}|${localX},${localY},${localZ}|${color}`);
  });
  const families = new Map();
  for (const entry of modules) families.set(entry.color, (families.get(entry.color) ?? 0) + 1);
  return Object.freeze({
    namespace: GDO_RECIPE_NAMESPACE,
    kind: GDO_RECIPE_KINDS.COLLECTIBLE,
    id: recipe.id ?? null,
    // Display fields travel with the compiled recipe so a consumer never has to
    // reach back into the raw pack for them.
    name: recipe.name ?? recipe.id ?? null,
    description: recipe.description ?? null,
    icon: recipe.icon ?? null,
    profile,
    scale,
    center: Object.freeze([cx, cy, cz]),
    modules: Object.freeze(modules),
    drawFamilies: Object.freeze([...families].map(([color, count]) => Object.freeze({ color, count }))),
    spawn: recipe.spawnPosition ? Object.freeze({ ...recipe.spawnPosition }) : null,
    buff: recipe.buff ? Object.freeze({ ...recipe.buff }) : null,
    cameraProxies: Object.freeze(modules.map(entry => Object.freeze({
      id: entry.id, minX: entry.minX, minY: entry.minY, minZ: entry.minZ,
      maxX: entry.maxX, maxY: entry.maxY, maxZ: entry.maxZ,
    }))),
    // A pick-up is visual-only; its interaction radius is the caller's rule.
    solidProxies: Object.freeze([]),
    interactionProxies: Object.freeze([]),
    fingerprint: fnv(layout.join(';')),
    diagnostics: Object.freeze({ modules: modules.length, families: families.size, ...skipped }),
  });
}

/**
 * Compile a landmark recipe: bounded ops into modules, declared openings left
 * genuinely open, and camera proxies from the modules alone.
 */
export function compileLandmarkRecipe(recipe, { profile = 'low', origin = [0, 0, 0], color = null } = {}) {
  const budget = recipeBudgetForProfile(profile);
  if (!recipe || typeof recipe !== 'object') throw new TypeError('Recipe must be an object');
  if (recipe.kind && recipe.kind !== GDO_RECIPE_KINDS.LANDMARK) {
    throw new RangeError(`Landmark compiler refuses kind ${String(recipe.kind)}`);
  }
  const base = vector(origin, 'origin');
  const openings = normalizeOpenings(recipe.openings);
  const expanded = expandOps(recipe, budget);
  const modules = [];
  const reservations = openings.map(opening => ({
    id: opening.id,
    x: opening.x + base[0], y: opening.y + base[1], z: opening.z + base[2],
    sizeX: opening.sizeX, sizeY: opening.sizeY, sizeZ: opening.sizeZ,
    minX: opening.minX + base[0], maxX: opening.maxX + base[0],
    minY: opening.minY + base[1], maxY: opening.maxY + base[1],
    minZ: opening.minZ + base[2], maxZ: opening.maxZ + base[2],
    boundaryModules: [], enclosedModules: [],
  }));
  const skipped = { ...expanded.skipped };
  // Identity, not placement: the fingerprint comes from the local expansion.
  const layout = expanded.entries.map(entry =>
    `${entry.id}|${entry.x},${entry.y},${entry.z}|${entry.sizeX},${entry.sizeY},${entry.sizeZ}`);
  for (const entry of expanded.entries) {
    const placed = module(entry.id,
      [entry.x + base[0], entry.y + base[1], entry.z + base[2]],
      [entry.sizeX, entry.sizeY, entry.sizeZ],
      { color: entry.color ?? recipe.color ?? color });
    // An opening is a reservation: modules wholly inside it are dropped, and
    // modules that border it are reported as its boundary.
    let enclosed = false;
    for (const reservation of reservations) {
      if (!intersectsOpening(placed, reservation)) continue;
      if (containedByOpening(placed, reservation)) {
        reservation.enclosedModules.push(placed.id);
        enclosed = true;
        break;
      }
      reservation.boundaryModules.push(placed.id);
    }
    if (enclosed) { skipped.overBudget += 0; continue; }
    if (modules.length >= budget.maxModulesPerRecipe) { skipped.overBudget++; continue; }
    modules.push(placed);
  }
  const collision = recipe.collision;
  let solidProxies = [];
  if (collision === 'footprint') {
    const center = vector(recipe.footprint?.at ?? [0, 0, 0], 'footprint.at');
    const size = vector(recipe.footprint?.size ?? [0, 0, 0], 'footprint.size');
    if (size.some(entry => entry <= 0)) throw new RangeError('Recipe footprint needs positive sizes');
    solidProxies = [Object.freeze({
      id: `${recipe.id ?? 'landmark'}:footprint`,
      x: center[0] + base[0], y: center[1] + base[1], z: center[2] + base[2],
      sizeX: size[0], sizeY: size[1], sizeZ: size[2],
      minX: center[0] + base[0] - size[0] / 2, maxX: center[0] + base[0] + size[0] / 2,
      minY: center[1] + base[1] - size[1] / 2, maxY: center[1] + base[1] + size[1] / 2,
      minZ: center[2] + base[2] - size[2] / 2, maxZ: center[2] + base[2] + size[2] / 2,
    })];
  }
  const families = new Map();
  for (const entry of modules) families.set(entry.color, (families.get(entry.color) ?? 0) + 1);
  return Object.freeze({
    namespace: GDO_RECIPE_NAMESPACE,
    kind: GDO_RECIPE_KINDS.LANDMARK,
    id: recipe.id ?? null,
    profile,
    origin: Object.freeze([...base]),
    modules: Object.freeze(modules),
    openings: Object.freeze(reservations.map(entry => Object.freeze({
      ...entry,
      boundaryModules: Object.freeze([...entry.boundaryModules]),
      enclosedModules: Object.freeze([...entry.enclosedModules]),
    }))),
    drawFamilies: Object.freeze([...families].map(([family, count]) => Object.freeze({ color: family, count }))),
    cameraProxies: Object.freeze(modules.map(entry => Object.freeze({
      id: entry.id, minX: entry.minX, minY: entry.minY, minZ: entry.minZ,
      maxX: entry.maxX, maxY: entry.maxY, maxZ: entry.maxZ,
    }))),
    solidProxies: Object.freeze(solidProxies),
    interactionProxies: Object.freeze([]),
    fingerprint: fnv(layout.join(';')),
    diagnostics: Object.freeze({
      modules: modules.length, ops: recipe.modules?.length ?? 0, families: families.size,
      openings: openings.length,
      modulesReserved: reservations.reduce((total, entry) => total + entry.enclosedModules.length, 0),
      ...skipped,
    }),
  });
}

/**
 * Compile every collectible of a `CNT-01` content pack through the schema loader
 * first, so a bad pack is refused before any module exists. The compiled list is
 * what a runtime consumes; the raw pack is never read again.
 */
export function compileStatePack(pack, { scale = .22, profile = 'low' } = {}) {
  const budget = recipeBudgetForProfile(profile);
  const report = loadContentState(pack);
  if (!report.ok) {
    const error = new TypeError(`Content pack refused before compiling: ${report.errors.map(item => `${item.path}:${item.code}`).join(', ')}`);
    error.report = report;
    throw error;
  }
  const collectibles = [];
  const modules = [];
  const families = new Map();
  let prunedModules = 0;
  for (const item of report.data.collectibles) {
    const compiled = compileCollectibleRecipe(item, { scale, profile });
    // Deterministic pack cap: the first declarations keep their modules.
    const room = Math.max(0, budget.maxModulesPerPack - modules.length);
    const kept = compiled.modules.slice(0, room);
    prunedModules += compiled.modules.length - kept.length;
    for (const entry of kept) {
      modules.push(entry);
      families.set(entry.color, (families.get(entry.color) ?? 0) + 1);
    }
    collectibles.push(Object.freeze({
      ...compiled,
      modules: Object.freeze(kept),
      keptOnCollection: kept.length,
    }));
  }
  return Object.freeze({
    namespace: GDO_RECIPE_NAMESPACE,
    kind: 'state-pack',
    stateId: report.data.stateId,
    profile,
    scale,
    collectibles: Object.freeze(collectibles),
    modules: Object.freeze(modules),
    drawFamilies: Object.freeze([...families].map(([color, count]) => Object.freeze({ color, count }))),
    spawns: Object.freeze(collectibles.map(entry => entry.spawn).filter(Boolean)),
    fingerprint: fnv(collectibles.map(entry => `${entry.id}:${entry.fingerprint}`).join('|')),
    diagnostics: Object.freeze({
      collectibles: collectibles.length,
      modules: modules.length,
      families: families.size,
      prunedModules,
      migrationSteps: report.migration.steps.length,
      warnings: report.warnings.length,
      maxModulesPerPack: budget.maxModulesPerPack,
    }),
  });
}
