import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_VEHICLE_NAMESPACE,
  GEO_VEHICLE_FAMILY,
  GEO_VEHICLE_FAMILY_NAMES,
  GEO_VEHICLE_LIMITS,
  GEO_VEHICLE_PROXY_STRIDE,
  GDO_VEHICLE_ROAD_KINDS,
  GEO_VEHICLE_STRIDE,
  compileVehicle,
  placeVehicles,
  vehicleRecipes,
} from './GeoVehicleGrammar.js';
import { GEO_VEHICLE_POOL_LIMITS, VehiclePools } from './GeoVehiclePools.js';
import { GEO_SUPPORT_ROLE } from './GeoSupportSlots.js';
import { GEO_OBJECT_LOD, compileObjectRecipe } from './GeoObjectRecipe.js';

test('DET-07 compiles deterministic tiered vehicles through the DET-02 IR', () => {
  assert.equal(GDO_VEHICLE_NAMESPACE, 'gdo:vehicleGrammar:v1');
  const recipes = vehicleRecipes();
  assert.deepEqual(recipes.map(record => record.name), GEO_VEHICLE_FAMILY_NAMES);
  for (const family of Object.values(GEO_VEHICLE_FAMILY)) {
    const first = compileVehicle(family, { seed: 777, scale: 1.05 });
    const second = compileVehicle(family, { seed: 777, scale: 1.05 });
    assert.deepEqual(first.compiled.visualBoxes, second.compiled.visualBoxes);
    assert.deepEqual(first.proxies, second.proxies);
    assert.ok(first.compiled.visualBoxes.length >= 8, 'mid/near tiers are present');
    assert.ok(first.compiled.visualBoxes.length <= GEO_VEHICLE_LIMITS.maxBoxesPerVehicle);
    assert.ok((first.recipe.support.roleMask & GEO_SUPPORT_ROLE.ROAD_EDGE) !== 0);
    assert.equal(first.recipe.interactionProxies.length, 0);
    assert.equal(first.recipe.cameraRoles.length, 0);
    // Far tier is the body plus cabin only.
    const far = compileObjectRecipe(first.recipe, {
      lod: GEO_OBJECT_LOD.FAR, maxModules: GEO_VEHICLE_LIMITS.maxModulesPerVehicle,
      maxBoxes: GEO_VEHICLE_LIMITS.maxBoxesPerVehicle,
    });
    assert.ok(far.visualBoxes.length >= 2 && far.visualBoxes.length <= 3);
    assert.throws(() => compileVehicle(family, { seed: 1, scale: 0 }), RangeError);
    assert.throws(() => compileVehicle(42, { seed: 1 }), RangeError);
  }
});

test('DET-07 wheels, mirrors, bumpers, and lights cannot expand body collision', () => {
  for (const family of Object.values(GEO_VEHICLE_FAMILY)) {
    for (let seed = 0; seed < 16; seed++) {
      for (const scale of [.86, 1, 1.08]) {
        const vehicle = compileVehicle(family, { seed: seed * 104729 + 7, scale });
        // Exactly one proxy: the oriented body footprint, roof height included.
        assert.equal(vehicle.proxies.length, GEO_VEHICLE_LIMITS.maxBodyProxiesPerVehicle);
        const proxy = vehicle.proxies[0];
        const body = vehicle.compiled.visualBoxes.find(box => box.moduleId === 'chassis-body');
        assert.ok(body, 'the body module exists');
        assert.ok(Math.abs(proxy.halfWidth - body.sizeX / 2) < 1e-9);
        assert.ok(Math.abs(proxy.halfDepth - body.sizeZ / 2) < 1e-9);
        assert.ok(Math.abs(proxy.x - body.centerX) < 1e-9);
        assert.ok(Math.abs(proxy.z - body.centerZ) < 1e-9);
        assert.ok(Math.abs(proxy.bottom - body.bottom) < 1e-9);
        assert.ok(Math.abs(proxy.top - (body.bottom + body.sizeY)) < 1e-9);

        // Detail modules reach *outside* the body proxy, so if they had been
        // folded in, the collision would be measurably larger. They are not.
        const outsideReach = vehicle.compiled.visualBoxes
          .filter(box => ['wheel-blocks', 'mirrors', 'bumpers', 'lights'].includes(box.moduleId))
          .some(box =>
            Math.abs(box.centerX) + box.sizeX / 2 > proxy.halfWidth + 1e-9 ||
            Math.abs(box.centerZ) + box.sizeZ / 2 > proxy.halfDepth + 1e-9);
        assert.ok(outsideReach, 'detail modules extend past the body footprint');

        // The proxy is seed-invariant for a family/scale: visual variety can
        // never leak into collision.
        const baseline = compileVehicle(family, { seed: 0, scale });
        assert.deepEqual(vehicle.proxies, baseline.proxies);

        // And the compiled proxy list is exactly the declared one.
        assert.equal(vehicle.compiled.solidProxies.length, 1);
        assert.equal(vehicle.compiled.solidProxies[0].shape, 'obb');
      }
    }
  }
});

test('DET-07 dropping every visual module leaves the body proxy untouched', () => {
  const vehicle = compileVehicle(GEO_VEHICLE_FAMILY.SUV, { seed: 42, scale: 1 });
  const stripped = compileObjectRecipe({
    ...vehicle.recipe,
    silhouette: [],
    surface: [],
    accents: [],
  }, {
    lod: GEO_OBJECT_LOD.NEAR,
    maxModules: GEO_VEHICLE_LIMITS.maxModulesPerVehicle,
    maxBoxes: GEO_VEHICLE_LIMITS.maxBoxesPerVehicle,
  });
  assert.deepEqual(stripped.solidProxies, vehicle.compiled.solidProxies,
    'proxies come from declared body geometry, never from visual modules');
});

test('DET-07 placement parks beside mapped roads with one body proxy per vehicle', () => {
  const lines = [
    [0, 20, 25, 20, 50, 20, 75, 20, 100, 20],
    [40, 0, 40, 25, 40, 50, 40, 75, 40, 100],
  ];
  const base = {
    lines,
    kinds: ['primary', 'motorway'],
    widths: [.3, .3],
    terrainSeed: 31,
    seed: 5150,
  };
  const first = placeVehicles(base);
  const second = placeVehicles(base);
  assert.equal(first.namespace, GDO_VEHICLE_NAMESPACE);
  assert.deepEqual(first.placements, second.placements);
  assert.deepEqual(first.proxies, second.proxies);
  assert.equal(first.placements.length % GEO_VEHICLE_STRIDE, 0);
  assert.equal(first.proxies.length % GEO_VEHICLE_PROXY_STRIDE, 0);
  assert.ok(first.meta.vehicles <= GEO_VEHICLE_LIMITS.maxPlacementsPerTile);
  assert.equal(first.meta.vehicles, first.placements.length / GEO_VEHICLE_STRIDE);
  assert.equal(first.meta.proxyCount, first.meta.vehicles, 'exactly one body proxy per vehicle');
  assert.ok(first.meta.tests <= GEO_VEHICLE_LIMITS.maxPlacementTestsPerTile);
  assert.ok(first.meta.bytes <= GEO_VEHICLE_LIMITS.bytesPerTile);
  assert.ok(first.meta.vehicles > 0, 'the primary street receives parked vehicles');
  assert.ok(first.meta.rejected.kind > 0, 'a motorway is not a parking street');

  for (let offset = 0; offset < first.proxies.length; offset += GEO_VEHICLE_PROXY_STRIDE) {
    const halfWidth = first.proxies[offset + 2], halfDepth = first.proxies[offset + 3];
    assert.ok(halfWidth > 0 && halfDepth > 0);
    assert.ok(first.proxies[offset + 5] <= first.proxies[offset + 6], 'body span is ordered');
    // Parked beside the carriageway: the body never centres on the lane.
    const z = first.proxies[offset + 1];
    assert.ok(Math.abs(z - 20) > .1 || Math.abs(first.proxies[offset] - 40) > .1);
  }

  const blocked = placeVehicles({
    ...base,
    obstacles: { buildings: [[-10, -10, 110, 110]] },
  });
  assert.equal(blocked.meta.vehicles, 0, 'buildings keep their ground');
  assert.ok(GDO_VEHICLE_ROAD_KINDS.has('primary') && !GDO_VEHICLE_ROAD_KINDS.has('motorway'));
});

test('DET-07 global vehicle pools repack owners, remount byte-stable, and release on dispose', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  const pool = new VehiclePools(scene, { material, terrainSeed: 17 });
  try {
    const first = new Float32Array([
      10, 10, .2, 1, 1, 1, GEO_VEHICLE_FAMILY.HATCHBACK, 30,
      12, 10, 0, .95, .95, .95, GEO_VEHICLE_FAMILY.VAN, 10,
    ]);
    const second = new Float32Array([
      20, 20, Math.PI, 1, 1, 1, GEO_VEHICLE_FAMILY.SEDAN, 20,
    ]);
    assert.equal(pool.addOwner('tile:b', second), 1);
    assert.equal(pool.addOwner('tile:a', first), 2);
    const fingerprint = pool.fingerprint();
    assert.equal(pool.diagnostics.owners, 2);
    assert.equal(pool.diagnostics.entries, 3);
    assert.ok(pool.diagnostics.activeDrawPools <= GEO_VEHICLE_POOL_LIMITS.maxAddedDrawCalls);
    assert.ok(pool.diagnostics.visibleTriangles > 0);
    assert.ok(pool.diagnostics.gpuBytes <= GEO_VEHICLE_POOL_LIMITS.maxGpuBytes);
    assert.equal(pool.diagnostics.steadyFrameMatrixUpdates, 0);

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
