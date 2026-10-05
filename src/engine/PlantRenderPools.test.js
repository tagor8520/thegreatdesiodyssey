import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_PLANT_POOL_ATTRIBUTE_LAYOUT,
  GDO_PLANT_RENDER_NAMESPACE,
  GDO_PLANT_RENDER_PROFILES,
  GDO_PLANT_VERTEX_ATTRIBUTE_LOCATIONS,
  PlantRenderPools,
  createPlantPoolMaterial,
  uploadPlantGeometryTier,
} from './PlantRenderPools.js';
import { acquirePlantLodLibrary, plantLodLibraryStats, plantLodScheduleSlot } from './PlantLodCompiler.js';
import { acquireProceduralMaterialLibrary } from './ProceduralMaterials.js';
import { GDO_LOW_PROFILE_BUDGETS, assertLowProfileBudget } from './PerformanceBudget.js';

const VIEW = Object.freeze({
  cameraPosition: Object.freeze([0, 2, 3]),
  verticalFovRadians: Math.PI / 3,
  viewportHeight: 720,
  nowMilliseconds: 0,
});

function placement(owner, id, {
  family = 'broadleaf',
  archetypeIndex = 0,
  position = [0, 0, 0],
  scale = [1, 1, 1],
  yaw = 0,
  paletteSlot = 2,
  age = .8,
  windStiffness = .65,
  sourceType = 0,
  clearance,
} = {}) {
  return {
    id,
    sourceType,
    placement: Object.freeze({
      family,
      archetypeIndex,
      owner,
      position: Object.freeze([...position]),
      scale: Object.freeze([...scale]),
      yaw,
      paletteSlot,
      age,
      windStiffness,
      ...(clearance ? { clearance: Object.freeze([...clearance]) } : {}),
    }),
  };
}

function withPools(options, callback) {
  const scene = new THREE.Scene();
  const pools = new PlantRenderPools(scene, options);
  try { return callback(pools, scene); } finally { pools.dispose(); }
}

function activeGpuSnapshot(pools) {
  return [...pools.buckets.values()].filter(bucket => bucket.ids.size).sort((a, b) => a.key.localeCompare(b.key)).map(bucket => ({
    key: bucket.key,
    matrices: [...bucket.mesh.instanceMatrix.array.slice(0, bucket.ids.size * 16)],
    palette: [...bucket.geometry.getAttribute('gdoPlantPalette').array.slice(0, bucket.ids.size)],
    traits: [...bucket.geometry.getAttribute('gdoPlantTraits').array.slice(0, bucket.ids.size * 3)],
    variants: [...bucket.geometry.getAttribute('gdoPlantVariant').array.slice(0, bucket.ids.size)],
    clearance: [...bucket.geometry.getAttribute('gdoPlantClearance').array.slice(0, bucket.ids.size * 4)],
  }));
}

test('VEG-06 defines bounded owner-aware render resources and driver-safe attributes', () => {
  assert.equal(GDO_PLANT_RENDER_NAMESPACE, 'gdo:vegetationRender:v1');
  assert.deepEqual(GDO_PLANT_RENDER_PROFILES.low, {
    maxOwners: 4,
    maxEntries: 5_360,
    maxVariantsPerTier: 2,
    maxDrawPools: 18,
    maxSourceGeometries: 48,
    maxGpuGeometryBytes: 1.5 * 1024 * 1024,
    maxVisibleTriangles: 75_000,
    maxAddedDrawCalls: 8,
  });
  assert.equal(GDO_PLANT_POOL_ATTRIBUTE_LAYOUT.gdoPlantPalette.instance, true);
  assert.equal(GDO_PLANT_POOL_ATTRIBUTE_LAYOUT.gdoPlantTraits.source, 'age/stiffness/phase');
  assert.equal(GDO_PLANT_POOL_ATTRIBUTE_LAYOUT.gdoPlantClearance.itemSize, 4);
  assert.equal(GDO_PLANT_POOL_ATTRIBUTE_LAYOUT.gdoPlantClearance.source, 'crown-scale/shift');
  assert.equal(GDO_PLANT_VERTEX_ATTRIBUTE_LOCATIONS, 16);
});

test('compiled variant tiers upload deterministically as paired exposed-face vertex streams', () => {
  const handle = acquirePlantLodLibrary({ profile: 'low', environmentKey: 'upload-test' });
  try {
    const sets = [0, 1].map(index => handle.library.getLodSet('broadleaf', index));
    const first = uploadPlantGeometryTier({
      family: 'broadleaf', lod: 'mid', sources: sets.map(set => set.geometries.mid),
    });
    const repeated = uploadPlantGeometryTier({
      family: 'broadleaf', lod: 'mid', sources: sets.map(set => set.geometries.mid),
    });
    try {
      assert.deepEqual(Object.keys(first.attributes), [
        'position', 'normal', 'gdoPlantMeta0', 'gdoPlantLod0',
        'gdoPlantPosition1', 'gdoPlantNormal1', 'gdoPlantMeta1', 'gdoPlantLod1',
      ]);
      for (const name of Object.keys(first.attributes)) {
        assert.deepEqual(first.getAttribute(name).array, repeated.getAttribute(name).array, name);
      }
      const source = sets[0].geometries.mid;
      const firstSourceVertex = source.indices[0];
      assert.deepEqual([...first.getAttribute('position').array.slice(0, 3)],
        [...source.positions.slice(firstSourceVertex * 3, firstSourceVertex * 3 + 3)]);
      assert.deepEqual([...first.getAttribute('gdoPlantMeta0').array.slice(0, 4)], [
        source.paletteSlots[firstSourceVertex], source.bendWeights[firstSourceVertex],
        source.phaseGroups[firstSourceVertex], source.detailRoles[firstSourceVertex],
      ]);
      assert.equal(first.getAttribute('gdoPlantLod0').normalized, true);
      assert.equal(first.index, null);
      assert.deepEqual(first.userData.gdoPlantUpload, repeated.userData.gdoPlantUpload);
      assert.equal(first.userData.gdoPlantUpload.variants, 2);
      assert.equal(first.userData.gdoPlantUpload.runtimeCsgOperations, 0);
      assert.equal(first.userData.gdoPlantUpload.collisionProxies, 0);
      // Wind is opt-in, so the default tier withholds no culling reserve.
      assert.equal(first.userData.gdoPlantUpload.windDisplacementMargin, 0);
      assert.ok(first.boundingSphere.radius > 0);
    } finally {
      first.dispose(); repeated.dispose();
    }
  } finally { handle.release(); }
});

function compileShaderSource(material) {
  const shader = {
    vertexShader: '#include <common>\nvoid main(){\n#include <beginnormal_vertex>\n#include <begin_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main(){ vec4 diffuseColor=vec4(1.0);\n#include <color_fragment>\n}',
  };
  material.onBeforeCompile(shader);
  return shader;
}

test('plant material consumes custom palette/age/stiffness data without instanceColor', () => {
  const material = createPlantPoolMaterial();
  try {
    const shader = compileShaderSource(material);
    assert.match(shader.vertexShader, /attribute float gdoPlantPalette/);
    assert.match(shader.vertexShader, /attribute vec3 gdoPlantTraits/);
    assert.match(shader.vertexShader, /attribute float gdoPlantVariant/);
    assert.match(shader.vertexShader, /attribute vec4 gdoPlantClearance/);
    assert.match(shader.vertexShader, /gdoPlantAdaptiveRole/);
    assert.match(shader.vertexShader, /mix\(position, gdoPlantPosition1/);
    assert.match(shader.fragmentShader, /vGdoPlantTraits\.x/);
    assert.equal(material.userData.gdoPlantPoolMaterial.windNamespace, 'gdo:vegetationWind:v1');
    assert.equal(material.userData.gdoPlantPoolMaterial.builtInInstanceColor, false);
    assert.equal(material.vertexColors, false);
  } finally { material.dispose(); }
});

test('wind is opt-in and the default path compiles no wind ALU', () => {
  const disabled = createPlantPoolMaterial();
  try {
    const shader = compileShaderSource(disabled);
    assert.equal(disabled.userData.gdoPlantPoolMaterial.windEnabled, false);
    // The guard must be present in source but the define must not be set, so the
    // driver's preprocessor removes every wind instruction.
    assert.ok(disabled.defines?.GDO_PLANT_WIND === undefined, 'default path sets no wind define');
    assert.match(shader.vertexShader, /#ifdef GDO_PLANT_WIND/);
    assert.ok(!shader.uniforms.gdoPlantWindClock, 'no clock uniform is bound when wind is off');
    assert.ok(!shader.uniforms.gdoPlantWindField);
    assert.ok(!shader.uniforms.gdoPlantWindAmplitude);
    assert.match(shader.vertexShader, /vec2 gdoPlantWindOffset = vec2\(0\.0\);/);
    // The displacement call site must sit inside the guard, not before it.
    assert.ok(
      shader.vertexShader.indexOf('gdoPlantWholeWind(\n') >
      shader.vertexShader.indexOf('#ifdef GDO_PLANT_WIND'),
      'wind call site remains inside the compile-time guard',
    );
    assert.notEqual(disabled.customProgramCacheKey(), '', 'cache key never collapses to empty');
  } finally { disabled.dispose(); }
});

test('enabling wind restores the define, uniforms and guarded displacement', () => {
  const enabled = createPlantPoolMaterial(null, { wind: true });
  try {
    const shader = compileShaderSource(enabled);
    assert.equal(enabled.userData.gdoPlantPoolMaterial.windEnabled, true);
    assert.equal(enabled.defines.GDO_PLANT_WIND, '');
    assert.match(shader.vertexShader, /gdoPlantWholeWind/);
    assert.match(shader.vertexShader, /plantMeta\.y \/ 255\.0/);
    assert.match(shader.vertexShader, /plantTraits\.z \+ spatialPhase/);
    assert.doesNotMatch(shader.vertexShader, /plantMeta\.z/, 'VEG-10 branch-group phase remains deferred');
    assert.match(shader.vertexShader, /rootMask/);
    assert.equal(shader.uniforms.gdoPlantWindClock, enabled.userData.gdoPlantWind.uniforms.clock);
    assert.equal(shader.uniforms.gdoPlantWindField, enabled.userData.gdoPlantWind.uniforms.field);
    assert.equal(shader.uniforms.gdoPlantWindAmplitude, enabled.userData.gdoPlantWind.uniforms.amplitude);
  } finally { enabled.dispose(); }
});

test('plant custom shader composes with the shared semantic material hook', () => {
  const handle = acquireProceduralMaterialLibrary();
  const material = createPlantPoolMaterial(handle.library);
  try {
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\nvoid main(){\n#include <beginnormal_vertex>\n#include <begin_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main(){ vec4 diffuseColor=vec4(1.0);\n#include <color_fragment>\n}',
    };
    material.onBeforeCompile(shader);
    assert.match(shader.vertexShader, /vGdoMaterialWorld =/);
    assert.match(shader.vertexShader, /modelMatrix \* instanceMatrix/);
    assert.match(shader.vertexShader, /gdoPlantVariantMix/);
    assert.match(shader.fragmentShader, /gdoSurfaceNoise/);
    assert.match(shader.fragmentShader, /vGdoPlantTint/);
    assert.ok(shader.uniforms.gdoPaletteLUT);
  } finally { material.dispose(); handle.release(); }
});

test('resident owners share family/LOD draws rather than multiplying pools by tile', () => withPools({}, (pools, scene) => {
  assert.throws(() => pools.addOwner('tile:bad', [
    placement('tile:bad', 'tile:bad:plant:0', { clearance: [1.2, 1, 0, 0] }),
  ], VIEW), /Invalid owner-aware plant pool placement/);
  const first = [placement('tile:0', 'tile:0:plant:0')];
  const second = [placement('tile:1', 'tile:1:plant:0', {
    position: [1, 0, 0], archetypeIndex: 1, clearance: [.7, .9, -.1, 0],
  })];
  pools.addOwner('tile:0', first, VIEW);
  const activeAfterOne = pools.diagnostics.activeDrawPools;
  pools.addOwner('tile:1', second, VIEW);
  assert.equal(activeAfterOne, 1);
  assert.equal(pools.diagnostics.activeDrawPools, 1);
  assert.equal(pools.diagnostics.drawPools, 3, 'one family owns three reusable LOD tiers');
  assert.equal(pools.diagnostics.sourceGeometries, 6);
  assert.equal(pools.diagnostics.entries, 2);
  assert.deepEqual(pools.diagnostics.byLod, { near: 2, mid: 0, far: 0, beyond: 0 });
  const mesh = pools.group.children[0];
  assert.equal(mesh.count, 2);
  assert.equal(mesh.instanceColor, null);
  assert.ok(mesh.geometry.getAttribute('gdoPlantPalette').isInstancedBufferAttribute);
  assert.ok(mesh.geometry.getAttribute('gdoPlantTraits').isInstancedBufferAttribute);
  assert.ok(mesh.geometry.getAttribute('gdoPlantVariant').isInstancedBufferAttribute);
  assert.ok(mesh.geometry.getAttribute('gdoPlantClearance').isInstancedBufferAttribute);
  assert.deepEqual([...mesh.geometry.getAttribute('gdoPlantClearance').array.slice(0, 8)],
    [1, 1, 0, 0, Math.fround(.7), Math.fround(.9), Math.fround(-.1), 0]);
  assert.equal(mesh.geometry.getAttribute('gdoPlantTraits').normalized, true);
  assert.equal(scene.children.filter(child => child.name === 'resident-plant-pools').length, 1);
}));

test('every record has exactly one active LOD membership, including beyond culling', () => withPools({}, pools => {
  pools.addOwner('tile:one', [
    placement('tile:one', 'plant:near', { position: [0, 0, 0] }),
    placement('tile:one', 'plant:far', { family: 'grass', sourceType: 9, position: [0, 0, -80] }),
    placement('tile:one', 'plant:beyond', { family: 'grass', sourceType: 9, position: [0, 0, -1000] }),
  ], VIEW);
  const snapshot = pools.snapshot();
  const memberships = new Map(snapshot.records.map(record => [record.id, 0]));
  for (const pool of snapshot.pools) for (const id of pool.ids) memberships.set(id, memberships.get(id) + 1);
  for (const record of snapshot.records) {
    assert.equal(memberships.get(record.id), record.lod === 'beyond' ? 0 : 1, record.id);
  }
  assert.equal(pools.getRecord('plant:beyond').bucketKey, null);
  assert.equal(pools.diagnostics.entries, 3);
  assert.equal(Object.values(pools.diagnostics.byLod).reduce((sum, count) => sum + count, 0), 3);
}));

test('staggered projected-size changes move membership without steady-frame matrix work', () => withPools({}, pools => {
  const id = 'tile:lod:plant:0';
  pools.addOwner('tile:lod', [placement('tile:lod', id)], VIEW);
  assert.equal(pools.getRecord(id).lod, 'near');
  const slot = plantLodScheduleSlot(id, 8);
  const step = 80 + slot;
  const movedView = {
    ...VIEW,
    cameraPosition: [0, 2, 250],
    nowMilliseconds: step * (1000 / 32) + .01,
  };
  pools.update(movedView);
  assert.notEqual(pools.getRecord(id).lod, 'near');
  assert.ok(pools.diagnostics.lastMatrixUploads > 0);
  const total = pools.diagnostics.totalMatrixUploads;
  assert.equal(pools.update(movedView), 0, 'same schedule slice is skipped');
  assert.equal(pools.diagnostics.lastMatrixUploads, 0);
  assert.equal(pools.diagnostics.totalMatrixUploads, total);
  assert.equal(pools.diagnostics.steadyFrameAllocations, 0);
}));

test('disabling wind performs zero wind work on steady frames', () => withPools({}, pools => {
  pools.addOwner('tile:nowind', [
    placement('tile:nowind', 'nowind:0', { position: [1, 0, 2], yaw: .7 }),
    placement('tile:nowind', 'nowind:1', { position: [2, 0, 2], yaw: 1.1 }),
  ], VIEW);
  pools.update({ ...VIEW, nowMilliseconds: 10 });
  pools.update({ ...VIEW, nowMilliseconds: 20 });
  assert.equal(pools.diagnostics.windEnabled, false);
  assert.equal(pools.diagnostics.windUniformWrites, 0, 'no clock uniform write when wind is off');
  assert.equal(pools.diagnostics.windCpuMatrixUpdates, 0);
  assert.equal(pools.diagnostics.windSteadyFrameAllocations, 0);
  // Inert rather than half-enabled: callers cannot configure a disabled field.
  assert.equal(pools.configureWind({ direction: [0, 1], strength: 1 }), false);
  assert.equal(pools.diagnostics.wind.malformedInputs, 0, 'disabled wind rejects without touching state');
}));

test('GPU wind advances one shared uniform without CPU instance-matrix work', () => withPools({ wind: true }, pools => {
  pools.addOwner('tile:wind', [
    placement('tile:wind', 'wind:0', { position: [1, 0, 2], yaw: .7, windStiffness: .2 }),
    placement('tile:wind', 'wind:1', { position: [2, 0, 2], yaw: 1.1, windStiffness: .8 }),
  ], VIEW);
  const mesh = [...pools.buckets.values()].find(bucket => bucket.mesh)?.mesh;
  const matrices = [...mesh.instanceMatrix.array];
  const totalMatrixUploads = pools.diagnostics.totalMatrixUploads;
  pools.update({ ...VIEW, nowMilliseconds: 10 });
  assert.equal(pools.diagnostics.windUniformWrites, 1);
  assert.equal(pools.diagnostics.lastMatrixUploads, 0);
  assert.equal(pools.diagnostics.totalMatrixUploads, totalMatrixUploads);
  assert.deepEqual([...mesh.instanceMatrix.array], matrices);
  pools.update({ ...VIEW, nowMilliseconds: 20 });
  assert.equal(pools.diagnostics.windUniformWrites, 1);
  assert.equal(pools.diagnostics.lastMatrixUploads, 0);
  assert.equal(pools.diagnostics.windCpuMatrixUpdates, 0);
  assert.equal(pools.diagnostics.windSteadyFrameAllocations, 0);
  assert.equal(pools.diagnostics.wind.namespace, 'gdo:vegetationWind:v1');
  assert.equal(pools.setReducedMotion(true), true);
  assert.equal(pools.diagnostics.wind.gustiness, 0);
  assert.equal(pools.diagnostics.reducedMotion, true);
  assert.equal(pools.configureWind({ direction: [0, 0], strength: Infinity }), false);
  assert.ok(pools.diagnostics.wind.malformedInputs > 0);
  assert.deepEqual([...mesh.instanceMatrix.array], matrices, 'wind configuration remains visual-only');
}));

test('owner eviction repacks sorted stable IDs exactly and remount reproduces the same state', () => {
  const ownerA = [
    placement('tile:a', 'tile:a:plant:2', { position: [-1, 0, 0] }),
    placement('tile:a', 'tile:a:plant:0', { position: [-2, 0, 0], archetypeIndex: 1 }),
  ];
  const ownerB = [
    placement('tile:b', 'tile:b:plant:1', {
      position: [2, 0, 0], yaw: .4, paletteSlot: 6, clearance: [.72, .88, -.14, .03],
    }),
    placement('tile:b', 'tile:b:plant:0', { position: [1, 0, 0], age: .72 }),
  ];
  const scene = new THREE.Scene();
  const pools = new PlantRenderPools(scene);
  const fresh = new PlantRenderPools(new THREE.Scene());
  try {
    pools.addOwner('tile:a', ownerA, VIEW);
    pools.addOwner('tile:b', ownerB, VIEW);
    assert.equal(pools.removeOwner('tile:a'), 2);
    assert.deepEqual(pools.snapshot().owners, ['tile:b']);
    assert.deepEqual(pools.snapshot().pools[0].ids, ['tile:b:plant:0', 'tile:b:plant:1']);
    assert.deepEqual(pools.snapshot().records.map(record => record.bucketIndex), [0, 1]);

    fresh.addOwner('tile:b', ownerB, VIEW);
    assert.equal(pools.fingerprint(), fresh.fingerprint(), 'eviction repack is history-independent');
    assert.deepEqual(activeGpuSnapshot(pools), activeGpuSnapshot(fresh), 'matrices and custom upload bytes repack identically');
    const expected = pools.fingerprint();
    const expectedGpu = activeGpuSnapshot(pools);
    pools.removeOwner('tile:b');
    pools.addOwner('tile:b', ownerB, VIEW);
    assert.equal(pools.fingerprint(), expected, 'same owner remount reproduces pool records');
    assert.deepEqual(activeGpuSnapshot(pools), expectedGpu, 'remount reproduces active GPU records');
    assert.equal(pools.removeOwner('missing'), 0);
  } finally { pools.dispose(); fresh.dispose(); }
});

test('resident, geometry, triangle, draw-delta, and memory counters remain hard bounded', () => withPools({}, pools => {
  const families = ['broadleaf', 'palm', 'shrub', 'herb', 'grass', 'bamboo'];
  pools.addOwner('tile:caps', families.map((family, index) => placement('tile:caps', `caps:${index}`, {
    family, sourceType: index, position: [index * .2, 0, 0], archetypeIndex: index & 1,
  })), VIEW);
  const metrics = {
    plantRenderEntries: pools.diagnostics.entries,
    plantRenderPools: pools.diagnostics.activeDrawPools,
    plantRenderSourceGeometries: pools.diagnostics.sourceGeometries,
    plantRenderGpuBytes: pools.diagnostics.gpuGeometryBytes,
    plantRenderVisibleTriangles: pools.diagnostics.visibleTriangles,
    plantRenderAddedDrawCalls: pools.diagnostics.addedDrawCalls,
  };
  assert.equal(pools.diagnostics.drawPools, 18);
  assert.equal(pools.diagnostics.sourceGeometries, 36);
  assert.ok(pools.diagnostics.gpuGeometryBytes <= GDO_PLANT_RENDER_PROFILES.low.maxGpuGeometryBytes);
  assert.ok(pools.diagnostics.visibleTriangles <= GDO_PLANT_RENDER_PROFILES.low.maxVisibleTriangles);
  assert.ok(pools.diagnostics.addedDrawCalls <= GDO_PLANT_RENDER_PROFILES.low.maxAddedDrawCalls);
  assert.equal(assertLowProfileBudget(metrics).ok, true);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.plantRenderEntries, 5_360);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.plantRenderPools, 18);
}));

test('visible-triangle cap rejects an owner atomically before pool membership', () => withPools({ maxEntries: 500 }, pools => {
  const crowded = Array.from({ length: 500 }, (_, index) => placement('tile:crowded', `crowded:${index}`));
  assert.throws(() => pools.addOwner('tile:crowded', crowded, VIEW), /render budget reached/);
  assert.equal(pools.diagnostics.entries, 0);
  assert.equal(pools.selector.diagnostics.entries, 0);
  assert.equal(pools.diagnostics.activeDrawPools, 0);
}));

test('caps reject atomically and context restoration/disposal retain clean lifecycle', () => {
  const before = plantLodLibraryStats();
  const scene = new THREE.Scene();
  const pools = new PlantRenderPools(scene, { maxOwners: 1, maxEntries: 2, environmentKey: 'lifecycle' });
  let geometryDisposals = 0, materialDisposed = false;
  try {
    assert.throws(() => pools.addOwner('tile:too-many', [
      placement('tile:too-many', 'cap:0'), placement('tile:too-many', 'cap:1'), placement('tile:too-many', 'cap:2'),
    ], VIEW), /entry cap/);
    assert.equal(pools.diagnostics.entries, 0);
    pools.addOwner('tile:ok', [placement('tile:ok', 'ok:0')], VIEW);
    assert.throws(() => pools.addOwner('tile:second', [], VIEW), /owner cap/);
    assert.equal(pools.diagnostics.owners, 1);
    for (const geometry of pools.resources.values()) geometry.addEventListener('dispose', () => { geometryDisposals++; });
    pools.material.addEventListener('dispose', () => { materialDisposed = true; });
    const versions = [...pools.resources.values()].map(geometry => geometry.getAttribute('position').version);
    const windField = pools.wind.uniforms.field.value;
    pools.handleContextRestored();
    assert.equal(pools.diagnostics.contextRestores, 1);
    assert.equal(pools.diagnostics.wind.contextRestores, 1);
    assert.equal(pools.wind.uniforms.field.value, windField);
    assert.deepEqual([...pools.resources.values()].map(geometry => geometry.getAttribute('position').version),
      versions.map(version => version + 1));
  } finally { pools.dispose(); }
  assert.equal(geometryDisposals, 3);
  assert.equal(materialDisposed, true);
  assert.equal(scene.children.length, 0);
  assert.equal(pools.diagnostics.disposed, true);
  assert.equal(pools.diagnostics.wind.disposed, true);
  assert.throws(() => pools.addOwner('after', [], VIEW), /disposed/);
  const after = plantLodLibraryStats();
  assert.equal(after.libraries, before.libraries);
  assert.equal(after.references, before.references);
});
