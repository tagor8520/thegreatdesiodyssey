import * as THREE from 'three';
import { activeProceduralMaterialLibrary, configureSemanticMaterial } from '../engine/ProceduralMaterials.js';

let renderOptions = { castShadow: false, receiveShadow: true, materialDetail: 'low' };
let sharedGeometry = null;
let geometryReferences = 0;
const sharedMaterials = new Map();

/** Configure batches created after this call. Existing batches are not mutated. */
export function configureVoxelRendering({ castShadow = false, receiveShadow = true, materialDetail = 'low' } = {}) {
  renderOptions = {
    castShadow: Boolean(castShadow),
    receiveShadow: Boolean(receiveShadow),
    materialDetail,
  };
}

function acquireGeometry() {
  if (!sharedGeometry) {
    sharedGeometry = new THREE.BoxGeometry(1, 1, 1);
    sharedGeometry.userData.sharedVoxelResource = true;
  }
  geometryReferences++;
  return sharedGeometry;
}

function releaseGeometry() {
  geometryReferences = Math.max(0, geometryReferences - 1);
  if (geometryReferences === 0 && sharedGeometry) {
    sharedGeometry.dispose();
    sharedGeometry = null;
  }
}

function materialKey(metalness) {
  return Number(metalness).toFixed(3);
}

function acquireMaterial(metalness) {
  const key = materialKey(metalness);
  let record = sharedMaterials.get(key);
  if (!record) {
    const material = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      vertexColors: false,
      metalness,
      roughness: metalness ? 0.24 : 0.88,
      flatShading: true,
    });
    // Three's built-in instanceColor path rendered black on some constrained
    // WebGL/SwiftShader drivers. A named instance attribute and tiny shader hook
    // keeps palette batching to one draw family without relying on that path.
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 voxelColor;\nvarying vec3 vVoxelColor;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvVoxelColor = voxelColor;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vVoxelColor;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vVoxelColor;');
    };
    material.customProgramCacheKey = () => `gdo-voxel-palette-v1:${key}`;
    const materialLibrary = activeProceduralMaterialLibrary();
    if (materialLibrary) configureSemanticMaterial(material, 'voxel', materialLibrary, renderOptions.materialDetail);
    material.userData.sharedVoxelResource = true;
    record = { material, references: 0 };
    sharedMaterials.set(key, record);
  }
  record.references++;
  return { key, material: record.material };
}

function releaseMaterial(key) {
  const record = sharedMaterials.get(key);
  if (!record) return;
  record.references = Math.max(0, record.references - 1);
  if (record.references === 0) {
    record.material.dispose();
    sharedMaterials.delete(key);
  }
}

/**
 * One instanced draw per material family per batch. Voxel color is stored as an
 * instance attribute, avoiding a separate material/draw for every palette color.
 */
export class VoxelBatch {
  constructor() { this.groups = new Map(); }

  box(x, y, z, sx, sy, sz, color, rotation = [0, 0, 0], metalness = 0) {
    const key = materialKey(metalness);
    if (!this.groups.has(key)) this.groups.set(key, { metalness, instances: [] });
    this.groups.get(key).instances.push([x, y, z, sx, sy, sz, ...rotation, color]);
  }

  build() {
    const root = new THREE.Group();
    if (this.groups.size === 0) return root;

    const geometry = acquireGeometry();
    const materialKeys = [];
    const dummy = new THREE.Object3D();
    const instanceColor = new THREE.Color();
    let released = false;

    for (const { metalness, instances } of this.groups.values()) {
      const acquired = acquireMaterial(metalness);
      materialKeys.push(acquired.key);
      // The cube has only 24 vertices, so a tiny geometry wrapper per draw family
      // is cheaper than letting one batch overwrite another batch's attributes.
      const meshGeometry = geometry.clone();
      delete meshGeometry.userData.sharedVoxelResource;
      const palette = new Float32Array(instances.length * 3);
      const mesh = new THREE.InstancedMesh(meshGeometry, acquired.material, instances.length);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      instances.forEach(([x, y, z, sx, sy, sz, rx, ry, rz, color], index) => {
        dummy.position.set(x, y, z);
        dummy.scale.set(sx, sy, sz);
        dummy.rotation.set(rx, ry, rz);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
        instanceColor.set(color).toArray(palette, index * 3);
      });
      meshGeometry.setAttribute('voxelColor', new THREE.InstancedBufferAttribute(palette, 3));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      mesh.castShadow = renderOptions.castShadow;
      mesh.receiveShadow = renderOptions.receiveShadow;
      root.add(mesh);
    }

    // A parent owner may dispose a hierarchy containing several independent batches.
    root.userData.releaseVoxelBatch = () => {
      if (released) return;
      released = true;
      materialKeys.forEach(releaseMaterial);
      releaseGeometry();
    };
    return root;
  }
}

export function disposeGroup(root) {
  root.removeFromParent();
  const geometries = new Set();
  const materials = new Set();
  const releases = new Set();

  root.traverse(object => {
    if (typeof object.userData?.releaseVoxelBatch === 'function') releases.add(object.userData.releaseVoxelBatch);
    if (object.geometry && !object.geometry.userData?.sharedVoxelResource) geometries.add(object.geometry);
    if (object.material) {
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      objectMaterials.forEach(material => {
        if (!material.userData?.sharedVoxelResource) materials.add(material);
      });
    }
    if (object.isInstancedMesh) object.dispose();
  });

  root.clear();
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  releases.forEach(release => release());
}

/** Exposed for diagnostics and resource-lifecycle tests. */
export function voxelResourceStats() {
  return Object.freeze({
    geometryReferences,
    materialFamilies: sharedMaterials.size,
    materialReferences: [...sharedMaterials.values()].reduce((sum, record) => sum + record.references, 0),
  });
}

export function randomFor(x, z, seed) {
  let state = (Math.imul(x, 73856093) ^ Math.imul(z, 19349663) ^ seed) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
