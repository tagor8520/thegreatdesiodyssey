import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_ROCK_NAMESPACE,
  GEO_ROCK_FAMILY,
  GEO_ROCK_FAMILY_NAMES,
  GEO_ROCK_LIMITS,
  GEO_ROCK_PROXY_STRIDE,
  GEO_ROCK_STRIDE,
  compileRockCluster,
  placeRockClusters,
  rockClusterRecipes,
} from './GeoRockGrammar.js';
import { GEO_ROCK_POOL_LIMITS, RockPools } from './GeoRockPools.js';
import { GEO_SUPPORT_ROLE } from './GeoSupportSlots.js';
import { GEO_OBJECT_LOD, compileObjectRecipe } from './GeoObjectRecipe.js';

function proxyPlanMatches(proxy, box) {
  return Math.abs(proxy.halfWidth - box.sizeX / 2) < 1e-9 &&
    Math.abs(proxy.halfDepth - box.sizeZ / 2) < 1e-9 &&
    Math.abs(proxy.x - box.centerX) < 1e-9 &&
    Math.abs(proxy.z - box.centerZ) < 1e-9 &&
    Math.abs(proxy.bottom - box.bottom) < 1e-9 &&
    Math.abs(proxy.top - (box.bottom + box.sizeY)) < 1e-9;
}

test('DET-06 compiles deterministic versioned clusters through the DET-02 IR', () => {
  assert.equal(GDO_ROCK_NAMESPACE, 'gdo:rockGrammar:v1');
  const recipes = rockClusterRecipes();
  assert.deepEqual(recipes.map(record => record.name), GEO_ROCK_FAMILY_NAMES);
  for (const family of Object.values(GEO_ROCK_FAMILY)) {
    const first = compileRockCluster(family, { seed: 12345, scale: 1.1 });
    const second = compileRockCluster(family, { seed: 12345, scale: 1.1 });
    assert.deepEqual(first.compiled.visualBoxes, second.compiled.visualBoxes);
    assert.deepEqual(first.proxies, second.proxies);
    assert.ok(first.compiled.visualBoxes.length >= 2);
    assert.ok(first.compiled.visualBoxes.length <= GEO_ROCK_LIMITS.maxBoxesPerCluster);
    assert.ok(first.compiled.visualBoxes.every(box => ['silhouette', 'surface', 'accent'].includes(box.role)));
    assert.ok((first.recipe.support.roleMask & GEO_SUPPORT_ROLE.GROUND_DETAIL) !== 0);
    assert.equal(first.recipe.interactionProxies.length, 0);
    assert.equal(first.recipe.cameraRoles.length, 0);
    assert.throws(() => compileRockCluster(family, { seed: 1, scale: 0 }), RangeError);
    assert.throws(() => compileRockCluster(99, { seed: 1 }), RangeError);
  }
});

test('DET-06 major masses earn tight proxies; chips and plates never do', () => {
  const chipBoxes = [], plateBoxes = [], majorBoxes = [];
  for (let family = 0; family < GEO_ROCK_FAMILY_NAMES.length; family++) {
    let proxiesSeen = 0;
    for (let seed = 0; seed < 24; seed++) {
      const cluster = compileRockCluster(family, { seed: seed * 7919 + 3, scale: .9 + (seed % 5) * .08 });
      const proxies = cluster.proxies;
      proxiesSeen += proxies.length;
      // The gate: at most one/two tight proxies per cluster, scree never solid.
      assert.ok(proxies.length <= GEO_ROCK_LIMITS.maxMajorProxiesPerCluster);
      if (cluster.name === 'scree') assert.equal(proxies.length, 0, 'scree stays visual');
      for (const proxy of proxies) {
        // Every proxy is a tight yaw-aligned box around ONE major mass box.
        const majors = cluster.compiled.visualBoxes
          .filter(box => box.role === 'silhouette');
        assert.ok(majors.some(box => proxyPlanMatches(proxy, box)),
          'a proxy must match one major mass exactly');
        const visuals = cluster.compiled.visualBoxes;
        // Never the whole cluster AABB: some visual box reaches outside the
        // proxy plan whenever satellites or chips exist around the hero.
        assert.ok(visuals.some(box =>
          Math.abs(box.centerX) + box.sizeX / 2 > Math.abs(proxy.x) + proxy.halfWidth + 1e-9 ||
          Math.abs(box.centerZ) + box.sizeZ / 2 > Math.abs(proxy.z) + proxy.halfDepth + 1e-9 ||
          box.bottom + box.sizeY > proxy.top + 1e-9 ||
          box.bottom < proxy.bottom - 1e-9,
        ) || visuals.length === 1, 'a proxy must not enclose the whole visual cluster');
      }
      for (const box of cluster.compiled.visualBoxes) {
        if (box.role === 'accent') chipBoxes.push({ box, proxies });
        else if (box.role === 'surface') plateBoxes.push({ box, proxies });
        else majorBoxes.push(box);
      }
      // Compiled output never gains a proxy the recipe did not declare.
      assert.equal(cluster.compiled.solidProxies.length, proxies.length);
    }
    if (family === GEO_ROCK_FAMILY.SCREE) assert.equal(proxiesSeen, 0);
    else assert.ok(proxiesSeen > 0, 'blocking families must produce proxies somewhere');
  }
  // No chip or plate is ever the source of a proxy: none matches a proxy plan.
  for (const { box, proxies } of [...chipBoxes, ...plateBoxes]) {
    for (const proxy of proxies) {
      assert.ok(!proxyPlanMatches(proxy, box), 'small chips and plates stay visual');
    }
  }
});

test('DET-06 near-only chips drop at far LOD without touching proxies', () => {
  const cluster = compileRockCluster(GEO_ROCK_FAMILY.BOULDER, { seed: 999, scale: 1 });
  const near = compileObjectRecipe(cluster.recipe, {
    lod: GEO_OBJECT_LOD.NEAR, maxModules: 6, maxBoxes: GEO_ROCK_LIMITS.maxBoxesPerCluster,
  });
  const far = compileObjectRecipe(cluster.recipe, {
    lod: GEO_OBJECT_LOD.FAR, maxModules: 6, maxBoxes: GEO_ROCK_LIMITS.maxBoxesPerCluster,
  });
  assert.ok(near.visualBoxes.length > far.visualBoxes.length, 'chips are near-only');
  assert.ok(far.visualBoxes.every(box => box.role !== 'accent'));
  assert.deepEqual(near.solidProxies, far.solidProxies);
});

test('DET-06 placement is morphology-founded, deterministic, bounded, and refuses mapped space', () => {
  const base = {
    tileMinX: 0, tileMinZ: 0, tileSize: 100,
    terrainSeed: 4242, seed: 9001,
  };
  const first = placeRockClusters(base);
  const second = placeRockClusters(base);
  assert.equal(GDO_ROCK_NAMESPACE, first.namespace);
  assert.deepEqual(first.placements, second.placements);
  assert.deepEqual(first.proxies, second.proxies);
  assert.equal(first.placements.length % GEO_ROCK_STRIDE, 0);
  assert.equal(first.proxies.length % GEO_ROCK_PROXY_STRIDE, 0);
  assert.ok(first.meta.clusters <= GEO_ROCK_LIMITS.maxClustersPerTile);
  assert.equal(first.meta.clusters, first.placements.length / GEO_ROCK_STRIDE);
  assert.equal(first.meta.proxyCount, first.proxies.length / GEO_ROCK_PROXY_STRIDE);
  assert.ok(first.meta.tests <= GEO_ROCK_LIMITS.maxPlacementTestsPerTile);
  assert.ok(first.meta.bytes <= GEO_ROCK_LIMITS.bytesPerTile);
  assert.ok(first.meta.clusters > 0, 'open ground receives clusters');

  // Proxies only come from blocking clusters, and stay under the tile cap.
  assert.equal(first.meta.clusters, first.placements.length / GEO_ROCK_STRIDE);
  assert.ok(first.meta.proxyCount <= GEO_ROCK_LIMITS.maxProxiesPerTile);
  for (let offset = 0; offset < first.proxies.length; offset += GEO_ROCK_PROXY_STRIDE) {
    assert.ok(first.proxies[offset + 2] > 0 && first.proxies[offset + 3] > 0);
    assert.ok(first.proxies[offset + 5] <= first.proxies[offset + 6]);
    assert.ok(Math.abs(first.proxies[offset]) <= 100 && Math.abs(first.proxies[offset + 1]) <= 100);
  }
  assert.ok(first.meta.proxyCount > 0, 'blocking clusters contribute major-mass proxies');

  const blocked = placeRockClusters({
    ...base,
    obstacles: { buildings: [[-10, -10, 110, 110]] },
  });
  assert.equal(blocked.meta.clusters, 0, 'mapped buildings keep their ground');

  const capped = placeRockClusters({ ...base, maxClusters: 2 });
  assert.ok(capped.meta.clusters <= 2);
});

test('DET-06 global rock pools repack owners, remount byte-stable, and release on dispose', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  const pool = new RockPools(scene, { material, terrainSeed: 17 });
  try {
    const first = new Float32Array([
      10, 10, .4, 1, 1, 1, GEO_ROCK_FAMILY.BOULDER, 30,
      12, 10, 0, .9, 1.1, .9, GEO_ROCK_FAMILY.SCREE, 10,
    ]);
    const second = new Float32Array([
      20, 20, Math.PI, 1, 1, 1, GEO_ROCK_FAMILY.OUTCROP, 20,
    ]);
    assert.equal(pool.addOwner('tile:b', second), 1);
    assert.equal(pool.addOwner('tile:a', first), 2);
    const fingerprint = pool.fingerprint();
    assert.equal(pool.diagnostics.owners, 2);
    assert.equal(pool.diagnostics.entries, 3);
    assert.ok(pool.diagnostics.activeDrawPools <= GEO_ROCK_POOL_LIMITS.maxAddedDrawCalls);
    assert.ok(pool.diagnostics.visibleTriangles > 0);
    assert.ok(pool.diagnostics.gpuBytes <= GEO_ROCK_POOL_LIMITS.maxGpuBytes);
    assert.equal(pool.diagnostics.steadyFrameMatrixUpdates, 0);
    assert.ok(pool.meshes.every(mesh => mesh.userData.visualOnly));

    assert.equal(pool.removeOwner('tile:a'), true);
    pool.addOwner('tile:a', first);
    assert.equal(pool.fingerprint(), fingerprint, 'remount reproduces pool membership');

    assert.throws(() => pool.addOwner('bad', new Float32Array([1, 2, 0, 1, 1, 1, 99, 1])), TypeError);
    assert.throws(() => pool.addOwner('dup', new Float32Array([
      1, 1, 0, 1, 1, 1, 0, 5,
      2, 2, 0, 1, 1, 1, 0, 5,
    ])), RangeError);
    assert.equal(pool.handleContextRestored(), true);
  } finally {
    pool.dispose();
    material.dispose();
  }
  assert.equal(pool.diagnostics.disposed, true);
});
