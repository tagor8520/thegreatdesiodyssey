import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { detectQuality, resolveQuality } from './Quality.js';
import { BiomeManager } from './BiomeManager.js';
import { VoxelBatch, configureVoxelRendering, disposeGroup, voxelResourceStats } from './VoxelBatch.js';
import { acquireProceduralMaterialLibrary } from '../engine/ProceduralMaterials.js';

test('auto quality is conservative for constrained devices and URL-overridable', () => {
  assert.equal(detectQuality({
    location: { search: '' },
    navigator: { deviceMemory: 4, hardwareConcurrency: 8 },
    screen: { width: 1920 },
  }), 'low');
  assert.equal(detectQuality({
    location: { search: '' },
    navigator: { deviceMemory: 16, hardwareConcurrency: 12 },
    screen: { width: 1920 },
  }), 'balanced');
  assert.equal(detectQuality({ location: { search: '?quality=high' }, navigator: {} }), 'high');
  assert.equal(resolveQuality('low').targetFps, 30);
  assert.throws(() => resolveQuality('ultra'), /Unknown quality profile/);
});

test('palette colors share one draw family and shared resources are released', () => {
  configureVoxelRendering({ castShadow: false, receiveShadow: false });
  const batch = new VoxelBatch();
  batch.box(0, 0, 0, 1, 1, 1, '#ff0000');
  batch.box(1, 0, 0, 1, 1, 1, '#00ff00');
  batch.box(2, 0, 0, 1, 1, 1, '#ffffff', [0, 0, 0], .5);
  const root = batch.build();

  assert.equal(root.children.length, 2, 'one dielectric and one metallic draw family');
  assert.equal(root.children[0].count, 2, 'different colors share the dielectric mesh');
  assert.equal(root.children[0].instanceColor, null);
  assert.equal(root.children[0].geometry.getAttribute('voxelColor').count, 2);
  assert.equal(root.children[0].castShadow, false);
  assert.deepEqual(voxelResourceStats(), { geometryReferences: 1, materialFamilies: 2, materialReferences: 2 });

  disposeGroup(root);
  assert.deepEqual(voxelResourceStats(), { geometryReferences: 0, materialFamilies: 0, materialReferences: 0 });
});

test('curated voxel families consume the engine-shared material masks without adding draw families', () => {
  const handle = acquireProceduralMaterialLibrary();
  configureVoxelRendering({ materialDetail: 'balanced' });
  const batch = new VoxelBatch();
  batch.box(0, 0, 0, 1, 1, 1, '#71945b');
  batch.box(1, 0, 0, 1, 1, 1, '#c56545');
  const root = batch.build();
  assert.equal(root.children.length, 1);
  const material = root.children[0].material;
  assert.equal(material.userData.gdoSemanticMaterial.semantic, 'voxel');
  assert.equal(material.userData.gdoSemanticMaterial.profile, 'balanced');
  assert.equal(material.userData.gdoSemanticMaterial.uniforms.gdoSurfaceNoise.value,
    handle.library.textures.surfaceNoise);
  disposeGroup(root);
  handle.release();
});

test('low-power streaming considers only a local chunk neighborhood', () => {
  const manager = new BiomeManager(new THREE.Scene(), { loadRadius: 90, unloadRadius: 122, decorationDensity: .55 });
  const nearby = manager.nearbyDescriptors(new THREE.Vector3(-42, 3, -20));
  assert.ok(nearby.length > 0);
  assert.ok(nearby.length < manager.descriptors.length);
  assert.deepEqual(manager.nearbyDescriptors(new THREE.Vector3(-42, 3, -20)), nearby, 'nearby list is cached');
  manager.dispose();
});
