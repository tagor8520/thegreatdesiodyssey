import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_MAX_ACTIVE_PLANT_LIBRARIES,
  GDO_PLANT_FAMILY_RECIPES,
  GDO_PLANT_GRAMMAR_NAMESPACE,
  GDO_PLANT_ORGANS,
  GDO_PLANT_PROFILES,
  acquirePlantArchetypeLibrary,
  compilePlantSkeleton,
  createPlantPlacementRecord,
  plantArchetypeLibraryStats,
  plantKeyedValue,
  plantSkeletonFingerprint,
  recolorPlantSkeleton,
} from './PlantGrammar.js';
import { assertLowProfileBudget } from './PerformanceBudget.js';

const FAMILIES = ['broadleaf', 'palm', 'shrub', 'herb', 'grass', 'bamboo'];

function assertSkeletonContract(skeleton, profileName = skeleton.profile) {
  const profile = GDO_PLANT_PROFILES[profileName];
  const paths = new Set();
  assert.equal(skeleton.namespace, GDO_PLANT_GRAMMAR_NAMESPACE);
  assert.deepEqual(skeleton.pivot, [0, 0, 0]);
  assert.ok(skeleton.nodes.length >= 1 && skeleton.nodes.length <= profile.maxNodes);
  assert.ok(skeleton.clusters.length <= profile.maxClusters);
  assert.ok(skeleton.roots.length <= profile.maxRoots);
  assert.ok(skeleton.diagnostics.modules <= profile.maxModules);
  assert.ok(skeleton.diagnostics.maximumDepth <= profile.maxDepth);
  for (const node of skeleton.nodes) {
    assert.equal(node.id >= 0 && node.id < skeleton.nodes.length, true);
    assert.equal(node.id === 0 ? node.parent === -1 : node.parent >= 0 && node.parent < node.id, true);
    assert.equal(paths.has(node.path), false, `duplicate path ${node.path}`);
    paths.add(node.path);
    assert.ok(node.position.every(Number.isFinite));
    assert.ok(node.direction.every(Number.isFinite));
    assert.ok(Math.hypot(node.position[0], node.position[2]) <= skeleton.envelope.radius + 1e-7);
    const minimumY = node.organ === GDO_PLANT_ORGANS.ROOT ? -skeleton.envelope.rootDepth : 0;
    assert.ok(node.position[1] >= minimumY - 1e-7 && node.position[1] <= skeleton.envelope.height + 1e-7);
    assert.ok(node.phaseGroup >= 0 && node.phaseGroup < 4);
  }
  for (const root of skeleton.roots) {
    assert.equal(Number.isInteger(root), true);
    assert.equal(skeleton.nodes[root].organ, GDO_PLANT_ORGANS.ROOT);
  }
  for (const cluster of skeleton.clusters) {
    assert.ok(cluster.center.every(Number.isFinite));
    assert.ok(cluster.extent.every(value => Number.isFinite(value) && value > 0));
    assert.ok(cluster.paletteSlot >= 0 && cluster.paletteSlot < 8);
    assert.equal(cluster.overlapRole, 'crown-union');
  }
}

test('VEG-03 defines six initial versioned semantic plant families', () => {
  assert.equal(GDO_PLANT_GRAMMAR_NAMESPACE, 'gdo:vegetationGrammar:v1');
  assert.deepEqual(Object.keys(GDO_PLANT_FAMILY_RECIPES), FAMILIES);
  assert.deepEqual(Object.keys(GDO_PLANT_PROFILES), ['low', 'balanced', 'high']);
  assert.deepEqual(Object.values(GDO_PLANT_PROFILES).map(profile => profile.variantsPerFamily), [2, 3, 4]);
  assert.ok(Object.values(GDO_PLANT_FAMILY_RECIPES).every(item =>
    item.unit === 1 && item.envelope.radius > 0 && item.envelope.height > 0));
});

test('fixed version, family, environment, and archetype reproduce byte-stable skeleton IR', () => {
  const first = compilePlantSkeleton({ family: 'broadleaf', archetypeIndex: 0, profile: 'low' });
  const second = compilePlantSkeleton({ family: 'broadleaf', archetypeIndex: 0, profile: 'low' });
  assert.deepEqual(first, second);
  assert.equal(plantSkeletonFingerprint(first), '79ebcebf');
  assertSkeletonContract(first);
  assert.ok(first.roots.length >= 2);
  assert.ok(first.nodes.some(node => node.organ === GDO_PLANT_ORGANS.BRANCH));
  assert.ok(first.clusters.length > 0);
});

test('keyed random channels and palette remapping cannot perturb branch topology', () => {
  const lengthBeforePalette = plantKeyedValue('broadleaf', 1, 'branch/2', 'length');
  const palette = plantKeyedValue('broadleaf', 1, 'branch/2', 'palette');
  const azimuth = plantKeyedValue('broadleaf', 1, 'branch/2', 'azimuth');
  assert.equal(plantKeyedValue('broadleaf', 1, 'branch/2', 'length'), lengthBeforePalette);
  assert.notEqual(lengthBeforePalette, palette);
  assert.notEqual(lengthBeforePalette, azimuth);

  const base = compilePlantSkeleton({ family: 'broadleaf', archetypeIndex: 1, profile: 'low' });
  const recolored = recolorPlantSkeleton(base, 3);
  assert.equal(recolored.nodes, base.nodes, 'topology is shared, not regenerated');
  assert.equal(recolored.roots, base.roots);
  assert.equal(recolored.bounds, base.bounds);
  assert.deepEqual(recolored.clusters.map(cluster => cluster.center), base.clusters.map(cluster => cluster.center));
  assert.deepEqual(recolored.clusters.map(cluster => cluster.extent), base.clusters.map(cluster => cluster.extent));
  assert.deepEqual(recolored.clusters.map(cluster => cluster.paletteSlot),
    base.clusters.map(cluster => (cluster.paletteSlot + 3) & 7));
});

test('quality caps preserve shared node paths and every family terminates inside low budgets', () => {
  for (const family of FAMILIES) {
    const skeleton = compilePlantSkeleton({ family, archetypeIndex: 0, profile: 'low' });
    assertSkeletonContract(skeleton);
    assert.ok(skeleton.diagnostics.attemptedNodes < 100, `${family} recursion did not terminate`);
  }
  const low = compilePlantSkeleton({ family: 'broadleaf', archetypeIndex: 0, profile: 'low' });
  const high = compilePlantSkeleton({ family: 'broadleaf', archetypeIndex: 0, profile: 'high' });
  const highByPath = new Map(high.nodes.map(node => [node.path, node]));
  for (const node of low.nodes) {
    const shared = highByPath.get(node.path);
    assert.ok(shared, node.path);
    assert.deepEqual(shared.position, node.position);
    assert.deepEqual(shared.direction, node.direction);
    assert.equal(shared.radius, node.radius);
  }
  assert.deepEqual(high.pivot, low.pivot);
  assert.equal(high.seed, low.seed);
});

test('explicit depth, node, cluster, root, retry, and module reductions are hard caps', () => {
  const skeleton = compilePlantSkeleton({
    family: 'broadleaf',
    profile: 'high',
    archetypeIndex: 0,
    limits: {
      maxDepth: 1,
      maxNodes: 5,
      maxClusters: 2,
      maxRoots: 1,
      maxOccupancyRetries: 1,
      maxModules: 5,
    },
  });
  assert.ok(skeleton.nodes.length <= 5);
  assert.ok(skeleton.clusters.length <= 2);
  assert.ok(skeleton.roots.length <= 1);
  assert.ok(skeleton.diagnostics.maximumDepth <= 1);
  assert.ok(skeleton.diagnostics.occupancyRetries <= 1);
  assert.ok(skeleton.diagnostics.modules <= 5);
  assert.ok(skeleton.diagnostics.rejectedBudget + skeleton.diagnostics.clustersOmitted > 0);
  assert.throws(() => compilePlantSkeleton({ family: 'broadleaf', limits: { maxNodes: -1 } }), /non-negative/);
});

test('family IR retains semantic organs and materially different normalized silhouettes', () => {
  const skeletons = Object.fromEntries(FAMILIES.map(family => [family,
    compilePlantSkeleton({ family, archetypeIndex: 0, profile: 'low' })]));
  assert.ok(skeletons.palm.nodes.some(node => node.organ === GDO_PLANT_ORGANS.FROND));
  assert.ok(skeletons.bamboo.nodes.some(node => node.organ === GDO_PLANT_ORGANS.CULM));
  assert.ok(skeletons.grass.nodes.every(node => node.organ === GDO_PLANT_ORGANS.STEM || node.organ === GDO_PLANT_ORGANS.BLADE));
  assert.ok(skeletons.palm.bounds.size[1] > skeletons.shrub.bounds.size[1] * 2.5);
  assert.ok(skeletons.broadleaf.bounds.size[0] > skeletons.herb.bounds.size[0] * 2);
  assert.equal(new Set(Object.values(skeletons).map(plantSkeletonFingerprint)).size, FAMILIES.length);
});

test('placement records keep anchors stable and refer to shared archetypes', () => {
  const first = createPlantPlacementRecord({
    family: 'palm', archetypeIndex: 1, owner: 'tile:14/11727/6820', position: [4, .2, -7], placementSeed: 42,
  });
  const repeated = createPlantPlacementRecord({
    family: 'palm', archetypeIndex: 1, owner: 'tile:14/11727/6820', position: [4, .2, -7], placementSeed: 42,
  });
  const recolored = createPlantPlacementRecord({
    family: 'palm', archetypeIndex: 1, owner: 'tile:14/11727/6820', position: [4, .2, -7], placementSeed: 42,
    paletteOffset: 3,
  });
  assert.deepEqual(first, repeated);
  assert.equal(first.archetypeKey, 'palm:1');
  for (const field of ['position', 'yaw', 'scale', 'age', 'windStiffness']) assert.deepEqual(recolored[field], first[field]);
  assert.equal(recolored.paletteSlot, (first.paletteSlot + 3) & 7);
});

test('shared archetype libraries compile once, stay bounded, and clear on last release', () => {
  const first = acquirePlantArchetypeLibrary({ profile: 'low', environmentKey: 'subtropical' });
  const second = acquirePlantArchetypeLibrary({ profile: 'low', environmentKey: 'subtropical' });
  assert.equal(first.library, second.library);
  assert.deepEqual(plantArchetypeLibraryStats(), { libraries: 1, references: 2, cachedArchetypes: 0 });
  for (const family of FAMILIES) for (let variant = 0; variant < first.library.variantsPerFamily; variant++) {
    const skeleton = first.library.getArchetype(family, variant);
    assert.equal(first.library.getArchetype(family, variant), skeleton);
  }
  const diagnostics = first.library.diagnostics;
  assert.equal(diagnostics.cachedArchetypes, FAMILIES.length * 2);
  assert.equal(diagnostics.misses, FAMILIES.length * 2);
  assert.equal(diagnostics.hits, FAMILIES.length * 2);
  assert.ok(diagnostics.cachedArchetypes <= diagnostics.limits.maxArchetypes);
  assertLowProfileBudget({
    plantArchetypes: diagnostics.cachedArchetypes,
    plantSkeletonNodes: diagnostics.maximumSkeletonNodes,
    plantSkeletonModules: diagnostics.maximumSkeletonModules,
  });
  first.release();
  first.release();
  assert.equal(diagnostics.disposed, false);
  second.release();
  second.release();
  assert.equal(diagnostics.disposed, true);
  assert.deepEqual(plantArchetypeLibraryStats(), { libraries: 0, references: 0, cachedArchetypes: 0 });
  assert.throws(() => first.library.getArchetype('grass', 0), /disposed/);

  const bounded = Array.from({ length: GDO_MAX_ACTIVE_PLANT_LIBRARIES }, (_, index) =>
    acquirePlantArchetypeLibrary({ profile: 'low', environmentKey: `environment-${index}` }));
  assert.throws(() => acquirePlantArchetypeLibrary({ profile: 'low', environmentKey: 'one-too-many' }),
    /Active plant-library cap/);
  bounded.forEach(handle => handle.release());
  assert.deepEqual(plantArchetypeLibraryStats(), { libraries: 0, references: 0, cachedArchetypes: 0 });
});

test('invalid families, profiles, archetypes, owners, and positions fail closed', () => {
  assert.throws(() => compilePlantSkeleton({ family: 'unknown' }), /Unknown plant family/);
  assert.throws(() => compilePlantSkeleton({ family: 'grass', profile: 'ultra' }), /Unknown plant profile/);
  assert.throws(() => compilePlantSkeleton({ family: 'grass', profile: 'low', archetypeIndex: 2 }), /supports archetype/);
  assert.throws(() => createPlantPlacementRecord({ family: 'grass', owner: '', position: [0, 0, 0] }), /owner/);
  assert.throws(() => createPlantPlacementRecord({ family: 'grass', owner: 'tile', position: [0, Number.NaN, 0] }), /finite/);
});
