import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GDO_RECIPE_KINDS,
  GDO_RECIPE_LIMITS,
  GDO_RECIPE_NAMESPACE,
  GDO_RECIPE_OPS,
  compileCollectibleRecipe,
  compileLandmarkRecipe,
  compileStatePack,
  recipeBudgetForProfile,
} from './RecipeCompiler.js';
import { featureNamespace } from './FeatureVersions.js';
import { GDO_CONTENT_SCHEMA_VERSION } from './ContentSchema.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

/**
 * `CNT-02` gate: a contributor writes data — voxel rows or parametric landmark
 * modules — and the compiler turns it into the module list the runtime consumes.
 * Layout arithmetic, caps, opening reservations, and fingerprints live here, so
 * no supported module needs contributor-authored `three` code.
 */

const readPack = name => JSON.parse(
  readFileSync(new URL(`../../public/content/states/${name}.json`, import.meta.url), 'utf8'));

test('the recipe compiler is declared, versioned, and bounded per profile', () => {
  assert.equal(GDO_RECIPE_NAMESPACE, featureNamespace('recipeCompiler'));
  assert.equal(GDO_RECIPE_NAMESPACE, 'gdo:recipeCompiler:v1');
  assert.deepEqual(Object.values(GDO_RECIPE_KINDS), ['collectible', 'landmark']);
  assert.deepEqual([...GDO_RECIPE_OPS], ['box', 'grid', 'step', 'tier']);
  assert.equal(recipeBudgetForProfile('low').maxModulesPerPack, GDO_LOW_PROFILE_BUDGETS.contentRecipeModules);
  assert.equal(recipeBudgetForProfile('low').maxModulesPerRecipe, GDO_LOW_PROFILE_BUDGETS.contentRecipeModulesPerRecipe);
  assert.throws(() => recipeBudgetForProfile('enormous'), /Unknown recipe profile/);
  assert.throws(() => compileCollectibleRecipe(null), /Recipe must be an object/);
  assert.throws(() => compileCollectibleRecipe({ voxels: [] }), /non-empty voxel list/);
  assert.throws(() => compileCollectibleRecipe({ voxels: [[0, 0]] }), /at least three coordinates/);
  assert.throws(() => compileCollectibleRecipe({ voxels: [[0, 0, Number.NaN]] }), /finite number/);
  assert.throws(() => compileCollectibleRecipe({ voxels: [[0, 0, 0]] }, { scale: 0 }), /scale must be positive/);
  assert.throws(() => compileLandmarkRecipe(null), /Recipe must be an object/);
  assert.throws(() => compileLandmarkRecipe({ kind: 'collectible' }), /refuses kind collectible/);
  assert.throws(() => compileLandmarkRecipe({ modules: [{ op: 'sphere' }] }), /Unknown recipe op: sphere/);
  assert.throws(() => compileLandmarkRecipe({ modules: [{ op: 'box', at: [0, 0, 0], size: [1, 1] }] }),
    /three-number array/);
  assert.throws(() => compileLandmarkRecipe({
    openings: [{ at: [0, 0, 0], size: [0, 1, 1] }],
  }), /opening sizes must be positive/);
  assert.throws(() => compileLandmarkRecipe({
    modules: [{ op: 'tier', count: 9_000, at: [0, 0, 0], size: [1, 1, 1] }],
  }), /outside \[1, 256\]/);
});

test('a voxel recipe compiles to the projected, centred module layout', () => {
  const recipe = {
    id: 'cube', name: 'Cube', description: 'test', icon: '🧊',
    buff: { type: 'jump', multiplier: 2, duration: 5_000 },
    spawnPosition: { x: 3, y: 1, z: -2 },
    voxels: [[0, 0, 0, '#111111'], [2, 0, 0, '#222222'], [0, 0, 2, '#111111']],
  };
  const compiled = compileCollectibleRecipe(recipe, { scale: .5 });
  assert.equal(compiled.namespace, GDO_RECIPE_NAMESPACE);
  assert.equal(compiled.kind, GDO_RECIPE_KINDS.COLLECTIBLE);
  assert.equal(compiled.modules.length, 3);
  // The centre is the voxel-space bounding-box middle, exactly as the legacy
  // builder computed it: (min + max) / 2 = (0 + 2) / 2 = 1 on both axes.
  assert.deepEqual([...compiled.center], [1, 0, 1]);
  assert.deepEqual(
    compiled.modules.map(entry => [entry.x, entry.y, entry.z]),
    [[-.5, 0, -.5], [.5, 0, -.5], [-.5, 0, .5]],
  );
  assert.equal(compiled.modules.every(entry => entry.sizeX === .5 && entry.sizeY === .5 && entry.sizeZ === .5), true);
  assert.deepEqual(compiled.modules.map(entry => entry.id), ['cube:0', 'cube:1', 'cube:2']);
  // Display data and the declared spawn travel with the compiled recipe.
  assert.equal(compiled.name, 'Cube');
  assert.deepEqual(compiled.spawn, { x: 3, y: 1, z: -2 });
  assert.deepEqual(compiled.buff, { type: 'jump', multiplier: 2, duration: 5_000 });
  assert.deepEqual(compiled.drawFamilies, [{ color: '#111111', count: 2 }, { color: '#222222', count: 1 }]);
  // A pick-up is visual-only: camera proxies exist, solid/interaction ones do not.
  assert.equal(compiled.cameraProxies.length, 3);
  assert.deepEqual(compiled.solidProxies, []);
  assert.deepEqual(compiled.interactionProxies, []);
  // Deterministic bytes and an origin offset that shifts without re-laying out.
  assert.equal(compileCollectibleRecipe(recipe, { scale: .5 }).fingerprint, compiled.fingerprint);
  const shifted = compileCollectibleRecipe(recipe, { scale: .5, origin: [10, 0, 0] });
  assert.deepEqual(shifted.modules.map(entry => entry.x), [9.5, 10.5, 9.5]);
  assert.equal(shifted.fingerprint, compiled.fingerprint, 'placement is not part of the recipe identity');
});

test('the landmark ops cover boxes, grids, steps, and shrinking tiers', () => {
  const recipe = {
    id: 'pavilion', color: '#abcdef',
    modules: [
      { op: 'box', id: 'pavilion:base', at: [0, 1, 0], size: [10, 2, 10] },
      { op: 'grid', id: 'pavilion:post:{xSign}:{index}', offsets: { x: [-4, 4] }, at: [0, 6, 0], size: [1, 6, 1] },
      {
        op: 'step', id: 'pavilion:stair:{index}', count: 3,
        at: [-2, 2, 6], step: [-.5, .5, 1], size: [2, 1, 2],
      },
      {
        op: 'tier', id: 'pavilion:roof:{index}', count: 3,
        at: [0, 10, 0], step: [0, 1, 0], size: [12, 1, 12], sizeStep: [-3, 0, -3],
      },
    ],
  };
  const compiled = compileLandmarkRecipe(recipe);
  assert.deepEqual(compiled.modules.map(entry => entry.id), [
    'pavilion:base',
    'pavilion:post:-1:0', 'pavilion:post:1:0',
    'pavilion:stair:0', 'pavilion:stair:1', 'pavilion:stair:2',
    'pavilion:roof:0', 'pavilion:roof:1', 'pavilion:roof:2',
  ]);
  const post = compiled.modules[1];
  assert.equal(post.x, -4);
  assert.equal(post.y, 6);
  const stair = compiled.modules[4];
  assert.deepEqual([stair.x, stair.y, stair.z], [-2.5, 2.5, 7]);
  const roof = compiled.modules[8];
  assert.deepEqual([roof.sizeX, roof.sizeY, roof.sizeZ], [6, 1, 6]);
  assert.equal(roof.color, '#abcdef', 'the recipe colour reaches every module that declares none');
  assert.equal(compiled.diagnostics.modules, 9);
  assert.equal(compiled.diagnostics.families, 1);
  assert.equal(compileLandmarkRecipe(recipe).fingerprint, compiled.fingerprint, 'stable fingerprint');
  // A landmark is visual-only unless the recipe declares a footprint.
  assert.deepEqual(compiled.solidProxies, []);
  const solid = compileLandmarkRecipe({
    ...recipe, collision: 'footprint', footprint: { at: [0, 1, 0], size: [10, 2, 10] },
  });
  assert.equal(solid.solidProxies.length, 1);
  assert.equal(solid.solidProxies[0].minX, -5);
  assert.throws(() => compileLandmarkRecipe({ ...recipe, collision: 'footprint', footprint: { size: [0, 1, 1] } }),
    /footprint needs positive sizes/);
});

test('a declared opening is a reservation, never an enclosing box', () => {
  const recipe = {
    id: 'arcade',
    openings: [{ id: 'arcade:arch', at: [0, 3, 0], size: [4.5, 6, 4] }],
    modules: [
      // Two piers flanking the opening, and one block that sits wholly inside it.
      { op: 'box', id: 'arcade:pier:-1', at: [-3, 3, 0], size: [2, 6, 4] },
      { op: 'box', id: 'arcade:pier:1', at: [3, 3, 0], size: [2, 6, 4] },
      { op: 'box', id: 'arcade:infill', at: [0, 3, 0], size: [4, 6, 3] },
      { op: 'box', id: 'arcade:lintel', at: [0, 6.5, 0], size: [10, 2, 4] },
    ],
  };
  const compiled = compileLandmarkRecipe(recipe);
  const ids = compiled.modules.map(entry => entry.id);
  assert.equal(ids.includes('arcade:infill'), false, 'a module inside the opening is dropped');
  assert.deepEqual(ids, ['arcade:pier:-1', 'arcade:pier:1', 'arcade:lintel']);
  const [opening] = compiled.openings;
  assert.equal(opening.id, 'arcade:arch');
  assert.deepEqual([...opening.enclosedModules], ['arcade:infill']);
  assert.deepEqual([...opening.boundaryModules].sort(), ['arcade:lintel', 'arcade:pier:-1', 'arcade:pier:1']);
  assert.equal(compiled.diagnostics.modulesReserved, 1);
  // A module that merely *touches* an opening is not inside it, so no masonry
  // is silently deleted, and no compiled module is one box covering the opening.
  assert.equal(compiled.modules.some(entry =>
    entry.minX <= -2.2 && entry.maxX >= 2.2 && entry.minY <= 3 && entry.maxY >= 6), false);
  assert.deepEqual(Object.keys(compiled.openings[0]).filter(key => key.startsWith('solid')), []);
  assert.equal(compiled.cameraProxies.length, compiled.modules.length);
});

test('a state pack compiles once, deterministically, under the pack cap', () => {
  for (const name of ['kerala', 'maharashtra']) {
    const pack = readPack(name);
    const compiled = compileStatePack(pack, { scale: .22 });
    assert.equal(compiled.namespace, GDO_RECIPE_NAMESPACE);
    assert.equal(compiled.kind, 'state-pack');
    assert.equal(compiled.stateId, name);
    assert.equal(compiled.collectibles.length, pack.collectibles.length);
    assert.equal(compiled.diagnostics.collectibles, pack.collectibles.length);
    assert.equal(compiled.modules.length, pack.collectibles.reduce((total, item) => total + item.voxels.length, 0));
    assert.ok(compiled.diagnostics.modules <= compiled.diagnostics.maxModulesPerPack);
    assert.equal(compiled.collectibles.every((entry, index) =>
      entry.modules.length === pack.collectibles[index].voxels.length), true);
    // Every spawn the raw pack declared survives the compile, in order.
    assert.deepEqual([...compiled.spawns], pack.collectibles.map(item => item.spawnPosition));
    assert.deepEqual([...compiled.spawns], pack.collectibles.map(item => ({ ...item.spawnPosition })));
    // Deterministic: two compiles of the same pack agree byte for byte.
    assert.equal(compileStatePack(pack, { scale: .22 }).fingerprint, compiled.fingerprint);
    assert.deepEqual(
      compileStatePack(pack, { scale: .22 }).modules.map(entry => entry.id),
      compiled.modules.map(entry => entry.id));
    assert.equal(compiled.diagnostics.migrationSteps, 0);
  }
  // A legacy v0 pack migrates through the `CNT-01` schema before compiling.
  const legacy = readPack('kerala');
  delete legacy.schemaVersion;
  const migrated = compileStatePack(legacy);
  assert.equal(migrated.diagnostics.migrationSteps, 2, 'v0 -> v1 runs its two named steps');
  assert.equal(migrated.fingerprint, compileStatePack(readPack('kerala')).fingerprint);
});

test('a refused pack never compiles, and a full pack prunes deterministically', () => {
  const pack = readPack('kerala');
  const broken = { ...pack, collectibles: [...pack.collectibles, { ...pack.collectibles[0] }] };
  assert.throws(() => compileStatePack(broken), error => {
    assert.match(error.message, /collectibles\[2\]\.id:duplicate-id/);
    assert.equal(error.report.ok, false);
    return true;
  });
  // A pack from the future is refused by the schema's own down-migration guard,
  // and the refusal names the version instead of compiling half a pack.
  assert.throws(() => compileStatePack({ ...pack, schemaVersion: GDO_CONTENT_SCHEMA_VERSION + 9 }),
    /Cannot migrate a v10 pack down to v1/);

  // A schema-legal pack cannot reach the pack cap: `CNT-01` already bounds a
  // pack to 16 collectibles of at most 96 voxels, so the module cap is a second,
  // independent ceiling rather than a way to silently drop a contributor's pack.
  assert.ok(GDO_RECIPE_LIMITS.profiles.low.maxModulesPerPack > 16 * 96);
  const maxPack = readPack('kerala');
  maxPack.collectibles = Array.from({ length: 16 }, (_, item) => ({
    id: `item_${item}`, name: `Item ${item}`, description: 'x', icon: '🟥',
    buff: { type: 'focus', multiplier: 1.2, duration: 6_000 },
    spawnPosition: { x: item, y: 1, z: 0 },
    voxels: Array.from({ length: 96 }, (_, index) =>
      [index % 5, Math.floor(index / 5) % 5, Math.floor(index / 25) % 5, '#00ff00']),
  }));
  const compiledPack = compileStatePack(maxPack);
  assert.equal(compiledPack.diagnostics.modules, 16 * 96);
  assert.equal(compiledPack.diagnostics.prunedModules, 0, 'a legal pack is never trimmed');

  // A landmark recipe can reach the per-recipe ceiling, and the overflow is
  // counted and deterministic instead of silently expanding.
  const overCap = {
    id: 'over', modules: [
      { op: 'tier', id: 'over:a:{index}', count: 256, at: [0, 0, 0], step: [0, 1, 0], size: [4, 1, 4] },
      { op: 'tier', id: 'over:b:{index}', count: 256, at: [0, 0, 0], step: [0, 1, 0], size: [4, 1, 4] },
      { op: 'tier', id: 'over:c:{index}', count: 256, at: [0, 0, 0], step: [0, 1, 0], size: [4, 1, 4] },
    ],
  };
  const pruned = compileLandmarkRecipe(overCap);
  assert.equal(pruned.modules.length, GDO_RECIPE_LIMITS.profiles.low.maxModulesPerRecipe);
  assert.equal(pruned.diagnostics.overBudget, 256);
  assert.equal(compileLandmarkRecipe(overCap).fingerprint, pruned.fingerprint, 'pruning is deterministic');
  // A malformed module (non-positive size) is counted, never emitted.
  const malformed = compileLandmarkRecipe({
    id: 'malformed', modules: [
      { op: 'box', id: 'ok', at: [0, 0, 0], size: [1, 1, 1] },
      { op: 'box', id: 'bad', at: [0, 0, 0], size: [1, 0, 1] },
    ],
  });
  assert.deepEqual(malformed.modules.map(entry => entry.id), ['ok']);
  assert.equal(malformed.diagnostics.malformed, 1);
  assert.equal(malformed.diagnostics.modules, 1);
});
