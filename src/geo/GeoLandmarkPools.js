import * as THREE from 'three';
import { GDO_LANDMARK_NAMESPACE, GEO_LANDMARK_LIMITS } from './GeoLandmarkGrammar.js';

export const GEO_LANDMARK_POOL_LIMITS = Object.freeze({
  // One hero is visible at a time; four resident owners keep streaming smooth.
  maxOwners: 4,
  maxHeroes: GEO_LANDMARK_LIMITS.heroesPerTile * 4,
  maxBoxes: GEO_LANDMARK_LIMITS.maxBoxesPerHero * 4,
  maxVisibleTriangles: GEO_LANDMARK_LIMITS.maxTrianglesPerHero,
  maxAddedDrawCalls: 1,
  maxGpuBytes: GEO_LANDMARK_LIMITS.bytesPerTile * 4,
  // Tight compounds only: one AABB per structural module, never a hero-wide box.
  maxCompounds: GEO_LANDMARK_LIMITS.maxStructuralCompounds * 4,
  maxStructuralCompounds: GEO_LANDMARK_LIMITS.maxStructuralCompounds * 4,
});

function typed(value, kind) {
  return kind === 'index' ? value instanceof Uint32Array : value instanceof Float32Array;
}

function validateGeometry(geometry) {
  const { positions, normals, colors, indices } = geometry ?? {};
  if (!typed(positions, 'position') || !typed(normals, 'normal') || !typed(colors, 'color') ||
      !typed(indices, 'index')) {
    throw new TypeError('Landmark geometry requires typed vertex and index data');
  }
  if (positions.length % 3 !== 0 || normals.length !== positions.length || colors.length !== positions.length ||
      indices.length % 3 !== 0) {
    throw new RangeError('Landmark geometry arrays are not aligned');
  }
  const vertices = positions.length / 3;
  for (let index = 0; index < indices.length; index++) {
    if (indices[index] >= vertices) throw new RangeError('Landmark geometry index is out of range');
  }
  return Object.freeze({ vertices, triangles: indices.length / 3, bytes: geometry.bytes ?? (
    (positions.byteLength + normals.byteLength + colors.byteLength + indices.byteLength)
  ) });
}

function validateHeroes(heroes) {
  if (!Array.isArray(heroes) || heroes.length > GEO_LANDMARK_LIMITS.heroesPerTile) {
    throw new RangeError('Landmark owners carry at most one hero per tile');
  }
  let boxes = 0, openings = 0, passable = 0, enclosing = 0;
  for (const hero of heroes) {
    if (!hero || hero.namespace !== GDO_LANDMARK_NAMESPACE || typeof hero.id !== 'string' || !hero.id ||
        typeof hero.form !== 'string' || !hero.form) {
      throw new TypeError('Landmark hero descriptor is malformed');
    }
    if (!Number.isInteger(hero.boxes) || hero.boxes <= 0 ||
        !Number.isInteger(hero.structuralCompounds) || hero.structuralCompounds < 0 ||
        !Number.isInteger(hero.enclosingCompounds) || hero.enclosingCompounds < 0) {
      throw new TypeError('Landmark hero descriptor is missing its bounded counts');
    }
    boxes += hero.boxes;
    openings += hero.openings;
    passable += hero.passableOpenings;
    enclosing += hero.enclosingCompounds;
  }
  return Object.freeze({ boxes, openings, passable, enclosing });
}

function validateCompounds(compounds) {
  if (!Array.isArray(compounds) || compounds.length > GEO_LANDMARK_POOL_LIMITS.maxCompounds) {
    throw new RangeError('Landmark owner exceeds its structural compound cap');
  }
  const records = [];
  for (const compound of compounds) {
    if (!Array.isArray(compound) || compound.length !== 6 || !compound.every(Number.isFinite) ||
        compound[0] >= compound[3] || compound[1] >= compound[4] || compound[2] >= compound[5]) {
      throw new TypeError('Landmark compound record is malformed');
    }
    records.push(Object.freeze({
      minimumX: compound[0], minimumY: compound[1], minimumZ: compound[2],
      maximumX: compound[3], maximumY: compound[4], maximumZ: compound[5],
      structural: true,
    }));
  }
  return Object.freeze(records);
}

function geometryFrom(positions, normals, colors, indices) {
  if (!positions.length || !indices.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  geometry.name = GDO_LANDMARK_NAMESPACE;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function sortedOwnerEntries(owners) {
  return [...owners.entries()].sort((first, second) => first[0].localeCompare(second[0]));
}

/**
 * Owner-scoped landmark renderer. A hero arrives already compiled and
 * hidden-face reduced, so this pool only merges, mounts, and releases it: it
 * never re-derives geometry, never samples terrain, and never writes a matrix on
 * a steady frame. Only the focused tile's hero is visible, so a landmark costs
 * exactly one draw call.
 */
export class LandmarkPools {
  constructor(runtime, { material, renderOrder = 0, limits = GEO_LANDMARK_POOL_LIMITS } = {}) {
    if (!runtime?.add || !material?.isMaterial) {
      throw new TypeError('LandmarkPools requires a scene and a shared material');
    }
    if (!limits || !Number.isInteger(limits.maxOwners) || limits.maxOwners <= 0 ||
        !Number.isInteger(limits.maxHeroes) || limits.maxHeroes <= 0 ||
        !Number.isInteger(limits.maxBoxes) || limits.maxBoxes <= 0 ||
        !Number.isInteger(limits.maxVisibleTriangles) || limits.maxVisibleTriangles <= 0 ||
        !Number.isInteger(limits.maxAddedDrawCalls) || limits.maxAddedDrawCalls <= 0 ||
        !Number.isInteger(limits.maxGpuBytes) || limits.maxGpuBytes <= 0 ||
        !Number.isInteger(limits.maxCompounds) || limits.maxCompounds <= 0 ||
        !Number.isInteger(limits.maxStructuralCompounds) || limits.maxStructuralCompounds <= 0) {
      throw new RangeError('Invalid landmark pool limits');
    }
    this.runtime = runtime;
    this.material = material;
    this.renderOrder = renderOrder;
    this.limits = limits;
    this.owners = new Map();
    this.group = new THREE.Group();
    this.group.name = `${GDO_LANDMARK_NAMESPACE}:pool`;
    runtime.add(this.group);
    this.focusKey = null;
    this.heroes = 0;
    this.boxes = 0;
    this.triangles = 0;
    this.gpuBytes = 0;
    this.openings = 0;
    this.passableOpenings = 0;
    this.enclosingCompounds = 0;
    this.visibilityWrites = 0;
    this.contextRestorations = 0;
    this.capEvents = {
      owners: false, heroes: false, boxes: false, bytes: false, compounds: false, triangles: false,
    };
    this.disposed = false;
  }

  /** Mount one tile's heroes. Rejects pre-mutation so a cap never half-mounts. */
  addOwner(owner, { geometry, heroes = [], compounds = [] } = {}) {
    if (this.disposed) throw new Error('LandmarkPools is disposed');
    if (typeof owner !== 'string' || !owner) throw new TypeError('Landmark owner must be a stable string');
    const measured = validateGeometry(geometry);
    const heroCounts = validateHeroes(heroes);
    const records = validateCompounds(compounds);
    const existing = this.owners.get(owner);
    const ownerCount = this.owners.size - Number(Boolean(existing)) + Number(measured.triangles > 0);
    const prospectiveBytes = this.gpuBytes - (existing?.measured.bytes ?? 0) + measured.bytes;
    const prospectiveHeroes = this.heroes - (existing?.heroes.length ?? 0) + heroes.length;
    const prospectiveBoxes = this.boxes - (existing?.heroCounts.boxes ?? 0) + heroCounts.boxes;
    const prospectiveCompounds = this.compounds().length -
      (existing?.compounds.length ?? 0) + records.length;
    if (ownerCount > this.limits.maxOwners || prospectiveHeroes > this.limits.maxHeroes ||
        prospectiveBoxes > this.limits.maxBoxes || prospectiveCompounds > this.limits.maxCompounds ||
        measured.triangles > this.limits.maxVisibleTriangles || prospectiveBytes > this.limits.maxGpuBytes) {
      this.capEvents = {
        owners: ownerCount > this.limits.maxOwners,
        heroes: prospectiveHeroes > this.limits.maxHeroes,
        boxes: prospectiveBoxes > this.limits.maxBoxes,
        bytes: prospectiveBytes > this.limits.maxGpuBytes,
        compounds: prospectiveCompounds > this.limits.maxCompounds,
        triangles: measured.triangles > this.limits.maxVisibleTriangles,
      };
      throw new RangeError('Landmark resident pool cap exceeded');
    }
    if (existing) this._release(owner, existing);
    if (!measured.triangles) {
      this.owners.delete(owner);
      this._recount();
      return 0;
    }
    const mesh = new THREE.Mesh(geometryFrom(geometry.positions, geometry.normals,
      geometry.colors, geometry.indices), this.material);
    mesh.name = `landmark:${owner}`;
    mesh.renderOrder = this.renderOrder;
    mesh.userData.visualOnly = true;
    mesh.userData.geoLayer = 'landmark';
    mesh.visible = owner === this.focusKey;
    this.group.add(mesh);
    this.owners.set(owner, {
      owner, mesh, heroes: Object.freeze([...heroes]), compounds: records,
      measured: Object.freeze({ ...measured, bytes: measured.bytes }), heroCounts,
    });
    this._recount();
    return heroCounts.boxes;
  }

  removeOwner(owner) {
    if (this.disposed) return false;
    const existing = this.owners.get(owner);
    if (!existing) return false;
    this._release(owner, existing);
    this.owners.delete(owner);
    this._recount();
    return true;
  }

  _release(owner, entry) {
    entry.mesh.removeFromParent();
    entry.mesh.geometry.dispose();
    this.group.remove(entry.mesh);
  }

  _recount() {
    let heroes = 0, boxes = 0, triangles = 0, bytes = 0;
    let openings = 0, passable = 0, enclosing = 0;
    for (const entry of this.owners.values()) {
      heroes += entry.heroes.length;
      boxes += entry.heroCounts.boxes;
      triangles += entry.measured.triangles;
      bytes += entry.measured.bytes;
      openings += entry.heroCounts.openings;
      passable += entry.heroCounts.passable;
      enclosing += entry.heroCounts.enclosing;
    }
    this.heroes = heroes; this.boxes = boxes; this.triangles = triangles;
    this.gpuBytes = bytes; this.openings = openings; this.passableOpenings = passable;
    this.enclosingCompounds = enclosing;
  }

  /** Exactly one hero is drawn: the focused tile's. */
  setFocus(key) {
    if (this.disposed || this.focusKey === key) return false;
    this.focusKey = key ?? null;
    for (const entry of this.owners.values()) {
      const visible = entry.owner === this.focusKey;
      if (entry.mesh.visible !== visible) {
        entry.mesh.visible = visible;
        this.visibilityWrites++;
      }
    }
    return true;
  }

  /** Tight per-module compounds: no landmark ever gets one enclosing AABB. */
  compounds() {
    const compounds = [];
    for (const entry of sortedOwnerEntries(this.owners)) {
      for (const compound of entry[1].compounds) compounds.push(Object.freeze({ owner: entry[0], ...compound }));
    }
    return Object.freeze(compounds);
  }

  snapshot() {
    const records = [];
    for (const entry of sortedOwnerEntries(this.owners)) {
      for (const hero of entry[1].heroes) records.push(Object.freeze({
        owner: entry[0],
        id: hero.id,
        form: hero.form,
        formSource: hero.formSource,
        boxes: hero.boxes,
        triangles: hero.triangles,
        hiddenFaces: hero.hiddenFaces,
        openings: hero.openings,
        passableOpenings: hero.passableOpenings,
        structuralCompounds: hero.structuralCompounds,
        enclosingCompounds: hero.enclosingCompounds,
      }));
    }
    records.sort((first, second) => first.owner.localeCompare(second.owner) || first.id.localeCompare(second.id));
    return Object.freeze({ namespace: GDO_LANDMARK_NAMESPACE, records: Object.freeze(records) });
  }

  fingerprint() {
    let hash = 2166136261;
    for (const record of this.snapshot().records) {
      const value = `${record.owner}:${record.id}:${record.form}:${record.boxes}:${record.triangles}:` +
        `${record.hiddenFaces}:${record.openings}:${record.passableOpenings}:${record.structuralCompounds}`;
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
    for (const entry of this.owners.values()) {
      const attributes = entry.mesh.geometry.attributes;
      for (const name of Object.keys(attributes)) attributes[name].needsUpdate = true;
      entry.mesh.geometry.index.needsUpdate = true;
    }
    this.contextRestorations++;
    return true;
  }

  get diagnostics() {
    const compounds = this.compounds();
    let maximumCompoundExtent = 0, narrowestCompoundExtent = Infinity;
    for (const compound of compounds) {
      const extent = Math.hypot(compound.maximumX - compound.minimumX,
        compound.maximumY - compound.minimumY, compound.maximumZ - compound.minimumZ);
      maximumCompoundExtent = Math.max(maximumCompoundExtent, extent);
      narrowestCompoundExtent = Math.min(narrowestCompoundExtent, extent);
    }
    const visibleTriangles = [...this.owners.values()]
      .reduce((total, entry) => total + (entry.mesh.visible ? entry.measured.triangles : 0), 0);
    return Object.freeze({
      namespace: GDO_LANDMARK_NAMESPACE,
      owners: this.owners.size,
      heroes: this.heroes,
      boxes: this.boxes,
      residentTriangles: this.triangles,
      visibleTriangles,
      addedDrawCalls: [...this.owners.values()].filter(entry => entry.mesh.visible).length,
      gpuBytes: this.gpuBytes,
      openings: this.openings,
      passableOpenings: this.passableOpenings,
      compounds: compounds.length,
      structuralCompounds: compounds.filter(compound => compound.structural).length,
      // Ties the compound list to the no-enclosing-AABB rule: nothing may cover
      // the hero it belongs to.
      enclosingCompounds: this.enclosingCompounds,
      maximumCompoundExtent,
      narrowestCompoundExtent: Number.isFinite(narrowestCompoundExtent) ? narrowestCompoundExtent : 0,
      visibilityWrites: this.visibilityWrites,
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
    for (const [owner, entry] of [...this.owners.entries()]) {
      this._release(owner, entry);
      this.owners.delete(owner);
    }
    this.group.removeFromParent();
    this.group.clear();
    this._recount();
  }
}
