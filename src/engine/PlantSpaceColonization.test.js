import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_COLONIZATION_LIMITS,
  GDO_COLONIZATION_NAMESPACE,
  GDO_COLONIZATION_REFUSAL,
  colonizePlantArchetype,
  colonizedArchetypeKey,
  colonizedPlantSkeleton,
  createColonizedArchetypeCache,
} from './PlantSpaceColonization.js';
import {
  GDO_PLANT_GEOMETRY_PROFILES,
  compilePlantGeometry,
  plantGeometryFingerprint,
} from './PlantGeometryCompiler.js';
import { GDO_PLANT_FAMILY_RECIPES, GDO_PLANT_ORGANS } from './PlantGrammar.js';
import { acquirePlantLodLibrary } from './PlantLodCompiler.js';

const FAMILIES = Object.freeze(Object.keys(GDO_PLANT_FAMILY_RECIPES));
const snapshot = value => JSON.stringify(value);

function insideEnvelope(envelope, position, organ) {
  const radial = Math.hypot(position[0], position[2]);
  if (position[1] < -1e-6 || position[1] > envelope.height + 1e-6) return false;
  if (radial > envelope.radius + 1e-6) return false;
  if ((envelope.shape === 'rounded' || envelope.shape === 'mound') &&
      organ !== GDO_PLANT_ORGANS.TRUNK && organ !== GDO_PLANT_ORGANS.STEM) {
    const normalizedY = Math.max(0, Math.min(1, position[1] / envelope.height));
    const crownFactor = envelope.shape === 'mound'
      ? .42 + Math.sin(normalizedY * Math.PI) * .68
      : .34 + Math.sin(normalizedY * Math.PI) * .82;
    return radial <= envelope.radius * crownFactor + 1e-6;
  }
  return true;
}

test('VEG-11 declares one versioned, bounded colonization budget', () => {
  assert.equal(GDO_COLONIZATION_NAMESPACE, 'gdo:plantColonization:v1');
  assert.deepEqual(Object.values(GDO_COLONIZATION_REFUSAL).sort(), [
    'bad-archetype', 'cache-full', 'per-tree-search', 'unknown-family', 'unknown-profile',
  ]);
  for (const field of ['attractors', 'iterations', 'nodes', 'nearestTests', 'growthPerStep', 'archetypes']) {
    assert.ok(Number.isFinite(GDO_COLONIZATION_LIMITS[field]) && GDO_COLONIZATION_LIMITS[field] > 0, field);
  }
  // The key carries the archetype, never a placed plant's identity.
  const key = colonizedArchetypeKey({ family: 'broadleaf', archetypeIndex: 2, profile: 'low', environmentKey: 'temperate', seedSalt: 4 });
  assert.equal(key, 'low:temperate:4:broadleaf:2');
  assert.equal(colonizedArchetypeKey({ family: 'broadleaf', archetypeIndex: 2 }), 'low:default:0:broadleaf:2');
});

test('colonized archetypes grow toward their attractors, inside the family envelope', () => {
  for (const family of FAMILIES) {
    const colony = colonizePlantArchetype({ family, archetypeIndex: 0, environmentKey: 'temperate' });
    assert.equal(colony.namespace, GDO_COLONIZATION_NAMESPACE, family);
    assert.ok(colony.nodes.length > 3, `${family} actually grew a structure`);
    assert.ok(colony.diagnostics.growthSteps > 0, `${family} recorded growth`);
    assert.ok(colony.diagnostics.attractorsConsumed > 0, `${family} reached its own attraction points`);
    assert.ok(colony.attractors.length > 0, `${family} placed attractions`);
    assert.ok(colony.attractors.some(attractor => attractor.reached), `${family} consumed at least one attractor`);
    assert.ok(colony.diagnostics.nearestTests <= colony.limits.nearestTests, `${family} stayed in the test budget`);
    for (const node of colony.nodes) {
      assert.equal(node.id, colony.nodes.indexOf(node));
      assert.ok(insideEnvelope(colony.envelope, node.position, node.organ),
        `${family} node ${node.id} sits inside the envelope`);
      assert.ok(node.radius > 0 && node.stiffness >= 0 && node.stiffness <= 1);
      assert.ok(node.phaseGroup >= 0 && node.phaseGroup < 4);
      assert.ok(node.depth <= GDO_PLANT_FAMILY_RECIPES[family].maxDepth);
    }
    // Terminal tips become crown clusters with declared extents.
    const skeleton = colonizedPlantSkeleton(colony);
    assert.ok(skeleton.clusters.length > 0, `${family} crowns its tips`);
    for (const cluster of skeleton.clusters) {
      assert.ok(cluster.extent.every(value => value > 0));
      assert.ok(cluster.paletteSlot >= 0 && cluster.paletteSlot <= 7);
      assert.ok(cluster.center.every(Number.isFinite));
    }
    // Deterministic and archetype-specific.
    const repeated = colonizePlantArchetype({ family, archetypeIndex: 0, environmentKey: 'temperate' });
    assert.equal(snapshot(colony), snapshot(repeated), `${family} is deterministic`);
    const other = colonizePlantArchetype({ family, archetypeIndex: 1, environmentKey: 'temperate' });
    assert.notEqual(snapshot(colony.nodes), snapshot(other.nodes), `${family} archetype 1 differs from 0`);
  }
});

test('colonized archetypes compile into real furniture inside the geometry caps', () => {
  for (const family of FAMILIES) {
    for (const profile of ['low', 'balanced', 'high']) {
      const colony = colonizePlantArchetype({ family, archetypeIndex: 0, profile, environmentKey: 'temperate' });
      const skeleton = colonizedPlantSkeleton(colony);
      const geometry = compilePlantGeometry(skeleton);
      const limits = GDO_PLANT_GEOMETRY_PROFILES[profile];
      assert.ok(geometry.diagnostics.boxesEmitted > 0, `${family}/${profile} emits boxes`);
      assert.ok(geometry.diagnostics.boxesEmitted <= limits.maxBoxes, `${family}/${profile} within box cap`);
      assert.ok(geometry.diagnostics.trianglesAfter <= limits.maxTriangles, `${family}/${profile} within triangle cap`);
      assert.ok(geometry.positions.length > 0 && geometry.indices.length > 0);
      assert.equal(geometry.diagnostics.boxesEmitted,
        (skeleton.nodes.length - 1) + skeleton.clusters.length, 'one module per node segment and crown');
      const repeated = compilePlantGeometry(colonizedPlantSkeleton(colony));
      assert.equal(plantGeometryFingerprint(geometry), plantGeometryFingerprint(repeated),
        `${family}/${profile} compiles deterministically`);
    }
  }
});

test('hard ceilings truncate by name instead of overrunning the search', () => {
  const tiny = colonizePlantArchetype({
    family: 'broadleaf',
    archetypeIndex: 0,
    limits: { nodes: 6, iterations: 2, attractors: 8, nearestTests: 1_000 },
  });
  assert.ok(tiny.nodes.length <= 6);
  assert.ok(tiny.attractors.length <= 8);
  assert.ok(tiny.diagnostics.iterations <= 2);
  assert.ok(tiny.diagnostics.nearestTests <= 1_000);
  assert.equal(tiny.diagnostics.truncated, 1);
  assert.ok(['node-cap', 'iteration-cap', 'test-cap', 'no-attraction', 'attractors-consumed']
    .includes(tiny.diagnostics.truncationReason), tiny.diagnostics.truncationReason);

  // The nearest-node budget is a real ceiling: a deliberately starved budget
  // names `test-cap` rather than quietly exceeding it.
  const starved = colonizePlantArchetype({
    family: 'shrub',
    archetypeIndex: 0,
    limits: { attractors: 72, nodes: 28, nearestTests: 1_000, iterations: 40 },
  });
  assert.ok(starved.diagnostics.nearestTests <= 1_000);
  assert.equal(starved.diagnostics.truncationReason, 'test-cap');

  // A budget never exceeds what the geometry profile can carry.
  const greedy = colonizePlantArchetype({ family: 'broadleaf', archetypeIndex: 0, limits: { nodes: 500, attractors: 500 } });
  const modules = greedy.nodes.length - 1 + colonizedPlantSkeleton(greedy).clusters.length;
  assert.ok(modules <= GDO_PLANT_GEOMETRY_PROFILES.low.maxBoxes, `${modules} modules fit the low profile`);

  assert.throws(() => colonizePlantArchetype({ family: 'sequoia' }), /Unknown plant family/);
  assert.throws(() => colonizePlantArchetype({ family: 'broadleaf', archetypeIndex: 9 }), /archetype indices/);
  assert.throws(() => colonizedPlantSkeleton({ namespace: 'gdo:other:v1' }), /colonized archetype/);
});

test('archetypes are authored once, shared by every placement, and cached within a cap', () => {
  const cache = createColonizedArchetypeCache({ limits: { archetypes: 2 } });
  const keys = ['broadleaf', 'shrub'];
  let firstShared;
  for (let placement = 0; placement < 40; placement++) {
    const family = keys[placement % keys.length];
    const result = cache.request({ family, archetypeIndex: 0, profile: 'low', environmentKey: 'temperate', seedSalt: 7 });
    assert.equal(result.ok, true);
    assert.equal(result.shared, true);
    assert.equal(result.hit, placement >= keys.length, 'only the first sight of a key compiles');
    if (placement === 0) firstShared = result.archetype;
    if (family === 'broadleaf') assert.equal(result.archetype, firstShared, 'every tree shares one archetype');
  }
  let diagnostics = cache.diagnostics;
  assert.equal(diagnostics.compiles, 2, 'forty placements compiled two archetypes');
  assert.equal(diagnostics.hits, 38);
  assert.equal(diagnostics.perTreeSearches, 0);

  // A cached archetype is exactly what a fresh search would produce.
  const fresh = colonizedPlantSkeleton(colonizePlantArchetype({
    family: 'broadleaf', archetypeIndex: 0, profile: 'low', environmentKey: 'temperate', seedSalt: 7,
  }));
  assert.equal(snapshot(firstShared), snapshot(fresh));
  assert.equal(firstShared.namespace, 'gdo:vegetationGrammar:v1', 'the cache stores the skeleton consumers consume');
  assert.equal(firstShared.origin, GDO_COLONIZATION_NAMESPACE);

  // Per-tree identity is refused by name — this is the "no runtime search" gate.
  for (const perTree of [{ owner: 'tile:4' }, { placementSeed: 11 }, { position: [1, 2, 3] }, { seed: 5 }]) {
    const refused = cache.request({ family: 'broadleaf', archetypeIndex: 0, ...perTree });
    assert.equal(refused.ok, false);
    assert.equal(refused.refusal, GDO_COLONIZATION_REFUSAL.PER_TREE_SEARCH);
  }
  assert.equal(cache.request({ family: 'sequoia' }).refusal, GDO_COLONIZATION_REFUSAL.UNKNOWN_FAMILY);
  assert.equal(cache.request({ family: 'broadleaf', archetypeIndex: 9 }).refusal, GDO_COLONIZATION_REFUSAL.BAD_ARCHETYPE);

  // The cap is an LRU, not an unbounded map.
  const before = cache.diagnostics.evictions;
  cache.request({ family: 'palm', archetypeIndex: 0, profile: 'low', environmentKey: 'temperate', seedSalt: 7 });
  diagnostics = cache.diagnostics;
  assert.ok(diagnostics.entries <= 2);
  assert.equal(diagnostics.evictions, before + 1);
  assert.equal(diagnostics.keys.includes('low:temperate:7:palm:0'), true);
  // Placement 39 was `shrub`, so `broadleaf` is the least recently used key.
  assert.equal(diagnostics.keys.includes('low:temperate:7:broadleaf:0'), false, 'the least recent key left first');
  assert.equal(diagnostics.keys.includes('low:temperate:7:shrub:0'), true, 'the most recent key survived');

  // Library-shaped access for the LOD/geometry compilers.
  const library = createColonizedArchetypeCache();
  const skeleton = library.getArchetype('broadleaf', 0, { environmentKey: 'temperate' });
  assert.equal(skeleton.family, 'broadleaf');
  assert.ok(compilePlantGeometry(skeleton).positions.length > 0);
  assert.throws(() => library.getArchetype('sequoia', 0), /Colonized archetype refused: unknown-family/);
  library.clear();
  assert.equal(library.diagnostics.entries, 0);
});

test('the live LOD pipeline consumes colonized archetypes without a per-plant search', () => {
  const handle = acquirePlantLodLibrary({
    profile: 'low', environmentKey: 'temperate', seedSalt: 3, archetypeSource: 'colonized',
  });
  try {
    const library = handle.library;
    const expectedCompiles = library.families.length * library.variantsPerFamily;
    for (const family of library.families) {
      for (let archetypeIndex = 0; archetypeIndex < library.variantsPerFamily; archetypeIndex++) {
        const lodSet = library.getLodSet(family, archetypeIndex);
        assert.ok(lodSet.diagnostics.levels.near.boxes > 0, `${family}/${archetypeIndex} has geometry`);
        // The same archetype asked for again is the same LOD set, not a rebuild.
        assert.equal(library.getLodSet(family, archetypeIndex), lodSet);
        // Per-placement lookups resolve to the shared archetype.
        assert.equal(library.getForPlacement({ family, archetypeIndex, owner: 'tile:9', placementSeed: 4 }), lodSet);
      }
    }
    const diagnostics = library.diagnostics;
    assert.equal(diagnostics.archetypeSource, 'colonized');
    assert.equal(diagnostics.archetypeCache.compiles, expectedCompiles, 'one search per archetype, not per placement');
    assert.equal(diagnostics.archetypeCache.perTreeSearches, 0);
    // The LOD layer absorbs repeated placement lookups before they reach the
    // archetype cache, so every archetype was searched exactly once and the
    // archetype cache needed no second hit.
    assert.equal(diagnostics.archetypeCache.hits, 0, 'no placement triggered a second search');
    assert.ok(diagnostics.cachedSets === expectedCompiles);
    assert.ok(diagnostics.nearTriangles > 0);
  } finally { handle.release(); }

  // The grammar source remains the default and is a distinct cache entry.
  const grammar = acquirePlantLodLibrary({ profile: 'low', environmentKey: 'temperate', seedSalt: 3 });
  try {
    assert.equal(grammar.library.diagnostics.archetypeSource, 'grammar');
    assert.equal(grammar.library.diagnostics.archetypeCache, null);
    assert.ok(grammar.library.getLodSet('broadleaf', 0).diagnostics.levels.near.boxes > 0);
  } finally { grammar.release(); }
  assert.throws(() => acquirePlantLodLibrary({ archetypeSource: 'procedural' }), /Unknown plant archetype source/);
});
