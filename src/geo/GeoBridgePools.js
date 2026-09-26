import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  GDO_BRIDGE_NAMESPACE,
  GEO_BRIDGE_FAMILY,
  GEO_BRIDGE_FAMILY_NAMES,
  GEO_BRIDGE_FIELD,
  GEO_BRIDGE_LIMITS,
  GEO_BRIDGE_STRIDE,
  bridgeRecipes,
} from './GeoBridgeGrammar.js';

export const GEO_BRIDGE_POOL_LIMITS = Object.freeze({
  maxOwners: 4,
  maxEntries: 384,
  maxFamilies: GEO_BRIDGE_FAMILY_NAMES.length,
  maxAddedDrawCalls: GEO_BRIDGE_FAMILY_NAMES.length,
  maxVisibleTriangles: 32_000,
  maxGpuBytes: 256 * 1024,
  // A tight compound per rail span and per reachable pier; never one bridge AABB.
  maxCompounds: 512,
  maxStructuralCompounds: 192,
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

/** Build each fixed DET-08 family once; placements never allocate box geometry. */
export function createBridgeGeometries() {
  return Object.freeze(bridgeRecipes().map(record => {
    const pieces = record.compiled.visualBoxes.map(coloredBox);
    const geometry = mergeGeometries(pieces, false);
    for (const piece of pieces) piece.dispose();
    if (!geometry) throw new Error(`Unable to compile bridge family ${record.name}`);
    geometry.name = `${GDO_BRIDGE_NAMESPACE}:${record.name}`;
    geometry.userData.bridgeFamily = record.family;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }));
}

function validatePlacements(values, stride) {
  if (!(values instanceof Float32Array) || stride !== GEO_BRIDGE_STRIDE ||
      values.length % GEO_BRIDGE_STRIDE !== 0) {
    throw new TypeError('Bridge placements require aligned Float32 data');
  }
  const seen = new Set();
  const halfPi = Math.PI / 2 + 1e-3;
  for (let offset = 0; offset < values.length; offset += GEO_BRIDGE_STRIDE) {
    const x = values[offset + GEO_BRIDGE_FIELD.X];
    const y = values[offset + GEO_BRIDGE_FIELD.Y];
    const z = values[offset + GEO_BRIDGE_FIELD.Z];
    const length = values[offset + GEO_BRIDGE_FIELD.LENGTH];
    const width = values[offset + GEO_BRIDGE_FIELD.WIDTH];
    const height = values[offset + GEO_BRIDGE_FIELD.HEIGHT];
    const yaw = values[offset + GEO_BRIDGE_FIELD.YAW];
    const pitch = values[offset + GEO_BRIDGE_FIELD.PITCH];
    const family = values[offset + GEO_BRIDGE_FIELD.FAMILY];
    const level = values[offset + GEO_BRIDGE_FIELD.LEVEL];
    const stableId = values[offset + GEO_BRIDGE_FIELD.STABLE_ID];
    if (![x, y, z, yaw, pitch].every(Number.isFinite) ||
        // 0 means "rigid unit"; a stretched module may reach 256x along its own axis.
        !(Number.isFinite(length) && length >= 0 && length <= 256) ||
        !(Number.isFinite(width) && width >= 0 && width <= 64) ||
        !(Number.isFinite(height) && height >= 0 && height <= 64) ||
        Math.abs(pitch) > halfPi ||
        !Number.isInteger(family) || family < 0 || family >= GEO_BRIDGE_FAMILY_NAMES.length ||
        !Number.isInteger(level) || level < 1 || level > 5 ||
        !Number.isInteger(stableId) || stableId < 0 || stableId > 0x00ffffff) {
      throw new TypeError('Bridge placement record is malformed');
    }
    if (seen.has(stableId)) throw new RangeError('Bridge stable IDs must be unique per owner');
    seen.add(stableId);
  }
  return values.length / GEO_BRIDGE_STRIDE;
}

function placementFamilyCounts(values) {
  const counts = Array(GEO_BRIDGE_FAMILY_NAMES.length).fill(0);
  for (let offset = 0; offset < values.length; offset += GEO_BRIDGE_STRIDE) {
    counts[values[offset + GEO_BRIDGE_FIELD.FAMILY]]++;
  }
  return counts;
}

function sortedOwnerEntries(owners) {
  return [...owners.entries()].sort((first, second) => first[0].localeCompare(second[0]));
}

function scaleOf(value) { return value > 0 ? value : 1; }

/**
 * Owner-scoped bridge-detail renderer. It consumes the self-describing
 * `DET-08` record stream, so it never samples terrain, never re-derives the
 * authoritative deck, and never writes a matrix on a steady frame.
 */
export class BridgePools {
  constructor(scene, {
    material,
    renderOrder = 0,
    limits = GEO_BRIDGE_POOL_LIMITS,
  } = {}) {
    if (!scene?.add || !material?.isMaterial) {
      throw new TypeError('BridgePools requires a scene and a shared material');
    }
    if (!limits || !Number.isInteger(limits.maxOwners) || limits.maxOwners <= 0 ||
        !Number.isInteger(limits.maxEntries) || limits.maxEntries <= 0 ||
        limits.maxFamilies !== GEO_BRIDGE_FAMILY_NAMES.length ||
        !Number.isInteger(limits.maxAddedDrawCalls) || limits.maxAddedDrawCalls <= 0 ||
        !Number.isInteger(limits.maxVisibleTriangles) || limits.maxVisibleTriangles <= 0 ||
        !Number.isInteger(limits.maxGpuBytes) || limits.maxGpuBytes <= 0 ||
        !Number.isInteger(limits.maxCompounds) || limits.maxCompounds <= 0 ||
        !Number.isInteger(limits.maxStructuralCompounds) || limits.maxStructuralCompounds <= 0) {
      throw new RangeError('Invalid bridge pool limits');
    }
    this.scene = scene;
    this.material = material;
    this.renderOrder = renderOrder;
    this.limits = limits;
    this.owners = new Map();
    this.geometries = createBridgeGeometries();
    this.meshTriangles = this.geometries.map(geometry => (geometry.index?.count ?? 0) / 3);
    const fixedGpuBytes = this.geometries.reduce((total, geometry) => total + geometryBytes(geometry), 0) +
      this.geometries.length * limits.maxEntries * 16 * Float32Array.BYTES_PER_ELEMENT;
    if (fixedGpuBytes > limits.maxGpuBytes) {
      for (const geometry of this.geometries) geometry.dispose();
      throw new RangeError('Bridge fixed GPU cap exceeded');
    }
    this.group = new THREE.Group();
    this.group.name = GDO_BRIDGE_NAMESPACE;
    this.meshes = this.geometries.map((geometry, family) => {
      const mesh = new THREE.InstancedMesh(geometry, material, limits.maxEntries);
      mesh.name = `bridge:${GEO_BRIDGE_FAMILY_NAMES[family]}`;
      mesh.count = 0;
      mesh.renderOrder = renderOrder;
      mesh.userData.bridgeFamily = family;
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
    this.capEvents = { owners: false, entries: false, draws: false, triangles: false, compounds: false };
    this.disposed = false;
    this._instance = new THREE.Object3D();
    this._instance.rotation.order = 'YXZ';
  }

  addOwner(owner, values, stride = GEO_BRIDGE_STRIDE) {
    if (this.disposed) throw new Error('BridgePools is disposed');
    if (typeof owner !== 'string' || !owner) throw new TypeError('Bridge owner must be a stable string');
    const count = validatePlacements(values, stride);
    const existing = this.owners.get(owner);
    const ownerCount = this.owners.size - Number(Boolean(existing)) + Number(count > 0);
    const prospectiveEntries = this.entries - (existing?.length ?? 0) / GEO_BRIDGE_STRIDE + count;
    const prospectiveFamilies = [...this.familyCounts];
    const oldFamilyCounts = existing ? placementFamilyCounts(existing) : prospectiveFamilies.map(() => 0);
    const newFamilyCounts = placementFamilyCounts(values);
    for (let family = 0; family < prospectiveFamilies.length; family++) {
      prospectiveFamilies[family] += newFamilyCounts[family] - oldFamilyCounts[family];
    }
    const prospectiveDraws = prospectiveFamilies.filter(Boolean).length;
    const prospectiveTriangles = prospectiveFamilies.reduce((total, familyCount, family) =>
      total + familyCount * this.meshTriangles[family], 0);
    if (ownerCount > this.limits.maxOwners || prospectiveEntries > this.limits.maxEntries ||
        prospectiveDraws > this.limits.maxAddedDrawCalls ||
        prospectiveTriangles > this.limits.maxVisibleTriangles) {
      this.capEvents = {
        owners: ownerCount > this.limits.maxOwners,
        entries: prospectiveEntries > this.limits.maxEntries,
        draws: prospectiveDraws > this.limits.maxAddedDrawCalls,
        triangles: prospectiveTriangles > this.limits.maxVisibleTriangles,
        compounds: false,
      };
      throw new RangeError('Bridge resident pool cap exceeded');
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
    const dummy = this._instance;
    for (const [, values] of sortedOwnerEntries(this.owners)) {
      const offsets = [];
      for (let offset = 0; offset < values.length; offset += GEO_BRIDGE_STRIDE) offsets.push(offset);
      // Stable upload order: family, then stable 24-bit identity.
      offsets.sort((first, second) =>
        values[first + GEO_BRIDGE_FIELD.FAMILY] - values[second + GEO_BRIDGE_FIELD.FAMILY] ||
        values[first + GEO_BRIDGE_FIELD.STABLE_ID] - values[second + GEO_BRIDGE_FIELD.STABLE_ID]);
      for (const offset of offsets) {
        const family = values[offset + GEO_BRIDGE_FIELD.FAMILY];
        const mesh = this.meshes[family], cursor = cursors[family]++;
        dummy.position.set(
          values[offset + GEO_BRIDGE_FIELD.X],
          values[offset + GEO_BRIDGE_FIELD.Y],
          values[offset + GEO_BRIDGE_FIELD.Z],
        );
        dummy.rotation.set(
          values[offset + GEO_BRIDGE_FIELD.PITCH],
          values[offset + GEO_BRIDGE_FIELD.YAW],
          0,
        );
        dummy.scale.set(
          scaleOf(values[offset + GEO_BRIDGE_FIELD.LENGTH]),
          scaleOf(values[offset + GEO_BRIDGE_FIELD.HEIGHT]),
          scaleOf(values[offset + GEO_BRIDGE_FIELD.WIDTH]),
        );
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

  /**
   * Tight per-module compounds: one AABB per rail line and per reachable pier.
   * A bridge never gets one enclosing AABB, and the walkable deck corridor is
   * never covered, so visuals and traversal truth stay in agreement.
   */
  compounds() {
    const instance = this._instance;
    const compounds = [];
    for (const [owner, values] of sortedOwnerEntries(this.owners)) {
      for (let offset = 0; offset < values.length; offset += GEO_BRIDGE_STRIDE) {
        const family = values[offset + GEO_BRIDGE_FIELD.FAMILY];
        const structural = family === GEO_BRIDGE_FAMILY.RAIL_SPAN ||
          (family === GEO_BRIDGE_FAMILY.PIER &&
            values[offset + GEO_BRIDGE_FIELD.HEIGHT] >= GEO_BRIDGE_LIMITS.minStructuralClearance);
        if (!structural) continue;
        const length = scaleOf(values[offset + GEO_BRIDGE_FIELD.LENGTH]);
        const height = scaleOf(values[offset + GEO_BRIDGE_FIELD.HEIGHT]);
        const width = scaleOf(values[offset + GEO_BRIDGE_FIELD.WIDTH]);
        const geometry = this.geometries[family];
        geometry.boundingBox ?? geometry.computeBoundingBox();
        const bounds = geometry.boundingBox;
        const corner = new THREE.Vector3();
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        instance.position.set(
          values[offset + GEO_BRIDGE_FIELD.X],
          values[offset + GEO_BRIDGE_FIELD.Y],
          values[offset + GEO_BRIDGE_FIELD.Z],
        );
        instance.rotation.set(values[offset + GEO_BRIDGE_FIELD.PITCH], values[offset + GEO_BRIDGE_FIELD.YAW], 0);
        instance.scale.set(length, height, width);
        instance.updateMatrix();
        // Transform the eight local bounds corners so pitched rails get a tight AABB.
        for (let index = 0; index < 8; index++) {
          corner.set(
            index & 1 ? bounds.max.x : bounds.min.x,
            index & 2 ? bounds.max.y : bounds.min.y,
            index & 4 ? bounds.max.z : bounds.min.z,
          ).applyMatrix4(instance.matrix);
          minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x);
          minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
          minZ = Math.min(minZ, corner.z); maxZ = Math.max(maxZ, corner.z);
        }
        compounds.push(Object.freeze({
          owner,
          family,
          kind: family === GEO_BRIDGE_FAMILY.PIER ? 'pier' : 'rail',
          level: values[offset + GEO_BRIDGE_FIELD.LEVEL],
          stableId: values[offset + GEO_BRIDGE_FIELD.STABLE_ID],
          structural,
          minX, minY, minZ, maxX, maxY, maxZ,
        }));
      }
    }
    compounds.sort((first, second) => first.owner.localeCompare(second.owner) ||
      first.family - second.family || first.stableId - second.stableId);
    return Object.freeze(compounds);
  }

  snapshot() {
    const records = [];
    for (const [owner, values] of sortedOwnerEntries(this.owners)) {
      for (let offset = 0; offset < values.length; offset += GEO_BRIDGE_STRIDE) records.push(Object.freeze({
        owner,
        x: values[offset + GEO_BRIDGE_FIELD.X],
        y: values[offset + GEO_BRIDGE_FIELD.Y],
        z: values[offset + GEO_BRIDGE_FIELD.Z],
        length: values[offset + GEO_BRIDGE_FIELD.LENGTH],
        width: values[offset + GEO_BRIDGE_FIELD.WIDTH],
        height: values[offset + GEO_BRIDGE_FIELD.HEIGHT],
        yaw: values[offset + GEO_BRIDGE_FIELD.YAW],
        pitch: values[offset + GEO_BRIDGE_FIELD.PITCH],
        family: values[offset + GEO_BRIDGE_FIELD.FAMILY],
        level: values[offset + GEO_BRIDGE_FIELD.LEVEL],
        stableId: values[offset + GEO_BRIDGE_FIELD.STABLE_ID],
      }));
    }
    records.sort((first, second) => first.family - second.family ||
      first.stableId - second.stableId || first.owner.localeCompare(second.owner));
    return Object.freeze({ namespace: GDO_BRIDGE_NAMESPACE, records: Object.freeze(records) });
  }

  fingerprint() {
    let hash = 2166136261;
    for (const record of this.snapshot().records) {
      const value = `${record.owner}:${record.family}:${record.stableId}:${record.x}:${record.y}:${record.z}:` +
        `${record.length}:${record.width}:${record.height}:${record.yaw}:${record.pitch}:${record.level}`;
      for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      hash >>>= 0;
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
      total + count * this.meshTriangles[family], 0);
    const compounds = this.compounds();
    const structural = compounds.filter(compound => compound.structural);
    // Ties the compound list to the no-enclosing-AABB rule: every compound is a
    // tight single-module box, and the narrowest one per owner is reported so a
    // bridge can never silently regress into one bridge-wide AABB.
    let maximumCompoundExtent = 0, narrowestCompoundExtent = Infinity;
    for (const compound of compounds) {
      const extent = Math.hypot(compound.maxX - compound.minX, compound.maxY - compound.minY,
        compound.maxZ - compound.minZ);
      maximumCompoundExtent = Math.max(maximumCompoundExtent, extent);
      narrowestCompoundExtent = Math.min(narrowestCompoundExtent, extent);
    }
    return Object.freeze({
      namespace: GDO_BRIDGE_NAMESPACE,
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
      compounds: compounds.length,
      structuralCompounds: structural.length,
      railCompounds: compounds.filter(compound => compound.kind === 'rail').length,
      pierCompounds: compounds.filter(compound => compound.kind === 'pier').length,
      maximumCompoundExtent,
      narrowestCompoundExtent: Number.isFinite(narrowestCompoundExtent) ? narrowestCompoundExtent : 0,
      repacks: this.repacks,
      matrixUploads: this.matrixUploads,
      steadyFrameMatrixUpdates: 0,
      contextRestorations: this.contextRestorations,
      capEvents: Object.freeze({ ...this.capEvents }),
      limits: this.limits,
      disposed: this.disposed,
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.owners.clear();
    this.entries = 0;
    this.group.removeFromParent();
    for (const mesh of this.meshes) mesh.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    this.group.clear();
  }
}
