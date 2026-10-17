import * as THREE from 'three';
import { adoptPoolResources } from '../engine/LifecycleContract.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { terrainHeightAt } from './GeoTerrain.js';
import {
  GDO_ROCK_NAMESPACE,
  GEO_ROCK_FAMILY_NAMES,
  GEO_ROCK_STRIDE,
  rockClusterRecipes,
} from './GeoRockGrammar.js';

export const GEO_ROCK_POOL_LIMITS = Object.freeze({
  maxOwners: 4,
  maxEntries: 48,
  maxFamilies: GEO_ROCK_FAMILY_NAMES.length,
  maxAddedDrawCalls: 4,
  maxVisibleTriangles: 24_000,
  maxGpuBytes: 256 * 1024,
});

function coloredBox(box) {
  const geometry = new THREE.BoxGeometry(box.sizeX, box.sizeY, box.sizeZ);
  geometry.rotateY(box.yaw ?? 0);
  geometry.translate(box.centerX, box.bottom + box.sizeY / 2, box.centerZ);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  for (let index = 0; index < geometry.attributes.position.count; index++) colors.set(box.color, index * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function geometryBytes(geometry) {
  let bytes = geometry.index?.array?.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes ?? {})) bytes += attribute.array?.byteLength ?? 0;
  return bytes;
}

/**
 * One merged geometry per family, compiled once from the canonical `DET-06`
 * recipe. Placements never allocate box geometry; per-cluster variety comes
 * from the deterministic non-uniform scale and yaw in the instance stream.
 */
export function createRockGeometries() {
  return Object.freeze(rockClusterRecipes().map(record => {
    const pieces = record.compiled.compiled.visualBoxes.map(coloredBox);
    const geometry = mergeGeometries(pieces, false);
    for (const piece of pieces) piece.dispose();
    if (!geometry) throw new Error(`Unable to compile rock family ${record.name}`);
    geometry.name = `${GDO_ROCK_NAMESPACE}:${record.name}`;
    geometry.userData.rockFamily = record.family;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }));
}

function hashText(value, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function validatePlacements(values, stride) {
  if (!(values instanceof Float32Array) || stride !== GEO_ROCK_STRIDE || values.length % stride !== 0) {
    throw new TypeError('Rock placements require aligned Float32 data');
  }
  const seen = new Set();
  for (let offset = 0; offset < values.length; offset += stride) {
    const x = values[offset], z = values[offset + 1], yaw = values[offset + 2];
    const scaleX = values[offset + 3], scaleY = values[offset + 4], scaleZ = values[offset + 5];
    const family = values[offset + 6], stableId = values[offset + 7];
    if (![x, z, yaw, scaleX, scaleY, scaleZ, family, stableId].every(Number.isFinite) ||
        scaleX <= 0 || scaleY <= 0 || scaleZ <= 0 || scaleX > 3 || scaleY > 3 || scaleZ > 3 ||
        !Number.isInteger(family) || family < 0 || family >= GEO_ROCK_FAMILY_NAMES.length ||
        !Number.isInteger(stableId) || stableId < 0 || stableId > 0x00ffffff) {
      throw new TypeError('Rock placement record is malformed');
    }
    if (seen.has(stableId)) throw new RangeError('Rock stable IDs must be unique per owner');
    seen.add(stableId);
  }
  return values.length / stride;
}

function placementFamilyCounts(values) {
  const counts = Array(GEO_ROCK_FAMILY_NAMES.length).fill(0);
  for (let offset = 0; offset < values.length; offset += GEO_ROCK_STRIDE) counts[values[offset + 6]]++;
  return counts;
}

function sortedOwnerEntries(owners) {
  return [...owners.entries()].sort((first, second) => first[0].localeCompare(second[0]));
}

/** Owner-scoped rock cluster pools: one draw per active family, zero per-frame updates. */
export class RockPools {
  constructor(scene, {
    ledger = null,
    material,
    terrainSeed = 0,
    renderOrder = 0,
    limits = GEO_ROCK_POOL_LIMITS,
  } = {}) {
    if (!scene?.add || !material?.isMaterial || !Number.isFinite(terrainSeed)) {
      throw new TypeError('RockPools requires a scene, shared material, and terrain seed');
    }
    if (!limits || !Number.isInteger(limits.maxOwners) || limits.maxOwners <= 0 ||
        !Number.isInteger(limits.maxEntries) || limits.maxEntries <= 0 ||
        limits.maxFamilies !== GEO_ROCK_FAMILY_NAMES.length ||
        !Number.isInteger(limits.maxAddedDrawCalls) || limits.maxAddedDrawCalls <= 0 ||
        !Number.isInteger(limits.maxVisibleTriangles) || limits.maxVisibleTriangles <= 0 ||
        !Number.isInteger(limits.maxGpuBytes) || limits.maxGpuBytes <= 0) {
      throw new RangeError('Invalid rock pool limits');
    }
    this.scene = scene;
    this.material = material;
    this.terrainSeed = terrainSeed;
    this.renderOrder = renderOrder;
    this.limits = limits;
    this.lifecycle = ledger ? adoptPoolResources(ledger, `${GDO_ROCK_NAMESPACE}:pools`, {
      geometries: this.geometries ?? null,
      meshes: this.meshes ?? null,
      node: this.group ?? null,
    }) : null;
    this.owners = new Map();
    this.geometries = createRockGeometries();
    const fixedGpuBytes = this.geometries.reduce((total, geometry) => total + geometryBytes(geometry), 0) +
      this.geometries.length * limits.maxEntries * 16 * Float32Array.BYTES_PER_ELEMENT;
    if (fixedGpuBytes > limits.maxGpuBytes) {
      for (const geometry of this.geometries) geometry.dispose();
      throw new RangeError('Rock fixed GPU cap exceeded');
    }
    this.group = new THREE.Group();
    this.group.name = GDO_ROCK_NAMESPACE;
    this.meshes = this.geometries.map((geometry, family) => {
      const mesh = new THREE.InstancedMesh(geometry, material, limits.maxEntries);
      mesh.name = `rocks:${GEO_ROCK_FAMILY_NAMES[family]}`;
      mesh.count = 0;
      mesh.renderOrder = renderOrder;
      mesh.userData.rockFamily = family;
      mesh.userData.visualOnly = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      return mesh;
    });
    scene.add(this.group);
    this.entries = 0;
    this.familyCounts = Array(this.meshes.length).fill(0);
    this.repacks = 0;
    this.matrixUploads = 0;
    this.contextRestorations = 0;
    this.disposed = false;
  }

  addOwner(owner, values, stride = GEO_ROCK_STRIDE) {
    if (this.disposed) throw new Error('RockPools is disposed');
    if (typeof owner !== 'string' || !owner) throw new TypeError('Rock owner must be a stable string');
    const count = validatePlacements(values, stride);
    const existing = this.owners.get(owner);
    const ownerCount = this.owners.size - Number(Boolean(existing)) + Number(count > 0);
    const prospectiveEntries = this.entries - (existing?.length ?? 0) / GEO_ROCK_STRIDE + count;
    const prospectiveFamilies = [...this.familyCounts];
    const oldFamilyCounts = existing ? placementFamilyCounts(existing) : prospectiveFamilies.map(() => 0);
    const newFamilyCounts = placementFamilyCounts(values);
    for (let family = 0; family < prospectiveFamilies.length; family++) {
      prospectiveFamilies[family] += newFamilyCounts[family] - oldFamilyCounts[family];
    }
    const prospectiveDraws = prospectiveFamilies.filter(Boolean).length;
    const prospectiveTriangles = prospectiveFamilies.reduce((total, familyCount, family) =>
      total + familyCount * (this.geometries[family].index?.count ?? 0) / 3, 0);
    if (ownerCount > this.limits.maxOwners || prospectiveEntries > this.limits.maxEntries ||
        prospectiveDraws > this.limits.maxAddedDrawCalls ||
        prospectiveTriangles > this.limits.maxVisibleTriangles) {
      throw new RangeError('Rock resident pool cap exceeded');
    }
    if (count) this.owners.set(owner, new Float32Array(values));
    else this.owners.delete(owner);
    this._repack();
    return count;
  }

  removeOwner(owner) {
    if (this.disposed || !this.owners.delete(owner)) return false;
    this._repack();
    return true;
  }

  _repack() {
    const cursors = Array(this.meshes.length).fill(0);
    const dummy = new THREE.Object3D();
    for (const [, values] of sortedOwnerEntries(this.owners)) {
      const offsets = [];
      for (let offset = 0; offset < values.length; offset += GEO_ROCK_STRIDE) offsets.push(offset);
      offsets.sort((first, second) => values[first + 7] - values[second + 7] ||
        values[first + 6] - values[second + 6] || values[first] - values[second] || values[first + 1] - values[second + 1]);
      for (const offset of offsets) {
        const family = values[offset + 6], mesh = this.meshes[family], cursor = cursors[family]++;
        dummy.position.set(
          values[offset],
          terrainHeightAt(values[offset], values[offset + 1], this.terrainSeed),
          values[offset + 1],
        );
        dummy.rotation.set(0, values[offset + 2], 0);
        // Non-uniform scale is the research's cluster-variety rule; the base
        // sits on the shared height field the collision already reads.
        dummy.scale.set(values[offset + 3], values[offset + 4], values[offset + 5]);
        dummy.updateMatrix();
        mesh.setMatrixAt(cursor, dummy.matrix);
      }
    }
    for (let family = 0; family < this.meshes.length; family++) {
      const mesh = this.meshes[family];
      mesh.count = cursors[family];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.count) mesh.computeBoundingSphere();
      this.matrixUploads++;
    }
    this.familyCounts = cursors;
    this.entries = cursors.reduce((total, value) => total + value, 0);
    this.repacks++;
  }

  snapshot() {
    const records = [];
    for (const [owner, values] of sortedOwnerEntries(this.owners)) {
      for (let offset = 0; offset < values.length; offset += GEO_ROCK_STRIDE) records.push(Object.freeze({
        owner,
        x: values[offset], z: values[offset + 1], yaw: values[offset + 2],
        scaleX: values[offset + 3], scaleY: values[offset + 4], scaleZ: values[offset + 5],
        family: values[offset + 6], stableId: values[offset + 7],
      }));
    }
    records.sort((first, second) => first.family - second.family || first.stableId - second.stableId ||
      first.owner.localeCompare(second.owner));
    return Object.freeze({ namespace: GDO_ROCK_NAMESPACE, records: Object.freeze(records) });
  }

  fingerprint() {
    let hash = 2166136261;
    for (const record of this.snapshot().records) {
      const value = `${record.owner}:${record.family}:${record.stableId}:${record.x}:${record.z}:${record.scaleX}:${record.scaleY}:${record.scaleZ}:${record.yaw}`;
      hash = hashText(value, hash);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  handleContextRestored() {
    if (this.disposed) return false;
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
    this.matrixUploads += this.meshes.length;
    this.contextRestorations++;
    return true;
  }

  get diagnostics() {
    const sourceGeometryBytes = this.geometries.reduce((total, geometry) => total + geometryBytes(geometry), 0);
    const matrixCapacityBytes = this.meshes.reduce((total, mesh) => total + mesh.instanceMatrix.array.byteLength, 0);
    const visibleTriangles = this.familyCounts.reduce((total, count, family) =>
      total + count * (this.geometries[family].index?.count ?? 0) / 3, 0);
    return Object.freeze({
      namespace: GDO_ROCK_NAMESPACE,
      owners: this.owners.size,
      entries: this.entries,
      sourceGeometries: this.geometries.length,
      activeDrawPools: this.familyCounts.filter(Boolean).length,
      addedDrawCalls: this.familyCounts.filter(Boolean).length,
      familyCounts: Object.freeze([...this.familyCounts]),
      visibleTriangles,
      sourceGeometryBytes,
      matrixCapacityBytes,
      gpuBytes: sourceGeometryBytes + matrixCapacityBytes,
      repacks: this.repacks,
      matrixUploads: this.matrixUploads,
      steadyFrameMatrixUpdates: 0,
      contextRestorations: this.contextRestorations,
      limits: this.limits,
      disposed: this.disposed,
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle?.disposeAll();
    this.owners.clear();
    this.entries = 0;
    this.group.removeFromParent();
    for (const mesh of this.meshes) mesh.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    this.group.clear();
  }
}
