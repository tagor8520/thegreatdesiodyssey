import * as THREE from 'three';
import { biomeAt, LANDMARKS } from './BiomeManager.js';
import { tileHeight } from './Player.js';
import { VoxelBatch, randomFor, disposeGroup } from './VoxelBatch.js';
import { isGameplayClearance } from './GameplayLayout.js';

export const FOOD_ITEMS = Object.freeze([
  { id: 'vada-pav', name: 'Vada Pav', biome: 'maharashtra', points: 10 },
  { id: 'cutting-chai', name: 'Cutting Chai', biome: 'maharashtra', points: 15 },
  { id: 'filter-coffee', name: 'Filter Coffee', biome: 'karnataka', points: 15 },
  { id: 'mysore-pak', name: 'Mysore Pak', biome: 'karnataka', points: 20 },
  { id: 'banana-chips', name: 'Banana Chips', biome: 'kerala', points: 10 },
  { id: 'podi-dosa', name: 'Podi Dosa', biome: 'kerala', points: 25 },
  { id: 'kerala-porotta', name: 'Kerala Porotta', biome: 'kerala', points: 30 },
]);

export function createFoodModel(id) {
  const b = new VoxelBatch();
  if (id === 'vada-pav') {
    b.box(0, .1, 0, 1.8, .35, 1.5, '#e4b86c'); b.box(0, .36, 0, 1.9, .12, 1.6, '#4d9132');
    b.box(0, .65, 0, 1.5, .5, 1.3, '#c48620'); b.box(0, 1, 0, 1.9, .35, 1.5, '#e6a14a'); b.box(0, 1.25, 0, 1.5, .2, 1.2, '#efb663');
  } else if (id === 'filter-coffee' || id === 'cutting-chai') {
    const coffee = id === 'filter-coffee';
    b.box(0, 0, 0, coffee ? 2 : 1.2, .12, coffee ? 2 : 1.2, '#bdcbd0');
    b.box(0, .6, 0, 1.1, 1.1, 1.1, coffee ? '#aabcc5' : '#779c9d');
    b.box(0, 1.18, 0, 1.05, .12, 1.05, coffee ? '#d5ab70' : '#a66c37');
    b.box(-.3, .6, .56, .15, .85, .05, '#f1eee0');
  } else if (id === 'mysore-pak') {
    b.box(0, 0, 0, 2.2, .1, 1.8, '#e2ddd1');
    for (const x of [-.55,.55]) b.box(x, .45, 0, .95, .8, 1.4, '#dbac35');
    for (let i = 0; i < 5; i++) b.box(-.85 + i * .4, .87, .15, .15, .07, .18, '#b27b25');
  } else if (id === 'banana-chips') {
    b.box(0, 0, 0, 2.4, .12, 1.8, '#40852e');
    for (let i = 0; i < 7; i++) { const x = (i % 3 - 1) * .6, z = (Math.floor(i / 3) - 1) * .5; b.box(x, .2 + i % 2 * .13, z, .65, .16, .55, '#f0c335', [0, i, 0]); }
  } else if (id === 'podi-dosa') {
    b.box(0, 0, 0, 2.6, .1, 1.8, '#498a30');
    for (let i = -2; i <= 2; i++) b.box(0, .25 + (2 - Math.abs(i)) * .17, i * .22, 2.3, .25, .28, i % 2 ? '#c88a38' : '#e4b663');
    b.box(1, .17, .65, .45, .2, .45, '#bf4f27');
  } else if (id === 'kerala-porotta') {
    b.box(0, 0, 0, 2.2, .1, 2, '#497c37');
    for (let i = 0; i < 5; i++) b.box(0, .18 + i * .15, 0, 1.7 - i % 2 * .2, .13, 1.6 - i % 2 * .2, i % 2 ? '#d2ab73' : '#f4deb0', [0, i * .25, 0]);
  } else throw new Error(`Unknown food: ${id}`);
  return b.build();
}

export class ItemManager {
  constructor(scene, { seed = 2026, perType = 5, onCollect = () => {}, activeRadius = Infinity, initialFocus = null } = {}) {
    if (!Number.isInteger(perType) || perType < 1 || perType > 100) throw new RangeError('perType must be 1–100');
    if (!(activeRadius > 0)) throw new RangeError('activeRadius must be positive');
    this.scene = scene; this.onCollect = onCollect; this.activeRadius = activeRadius;
    this.items = new Map(); this.score = 0; this.collected = 0; this.disposed = false;
    // `NET-01`: the instance ids this session has picked up, in collection order. The id is
    // already stable across sessions (`${definition.id}:${i}` over a seeded layout), so this
    // list *is* the progress a save file stores, and restoring it removes exactly the items
    // the player already took rather than respawning them.
    this.collectedIds = [];
    const random = randomFor(91, 17, seed), positions = [];
    for (const definition of FOOD_ITEMS) for (let i = 0; i < perType; i++) {
      let position = null;
      // A first pickup is visible immediately, without granting points at spawn.
      if (definition.id === 'vada-pav' && i === 0) position = new THREE.Vector3(-36, 3, -20);
      for (let attempt = 0; !position && attempt < 2000; attempt++) {
        const x = -115 + random() * 230, z = -110 + random() * 220, height = tileHeight(x, z);
        if (height < 0 || biomeAt(x,z) !== definition.biome || isGameplayClearance(x,z) || (z < -73 && z > -87)) continue;
        if (Object.values(LANDMARKS).some(([lx,lz]) => Math.abs(x-lx) < 20 && Math.abs(z-lz) < 20)) continue;
        if (positions.some(p => Math.hypot(p.x-x,p.z-z) < 5)) continue;
        position = new THREE.Vector3(x, height, z);
      }
      if (!position) { this.dispose(); throw new Error(`Unable to place ${definition.id}`); }
      positions.push(position);
      const mesh = createFoodModel(definition.id), id = `${definition.id}:${i}`;
      mesh.name = `food:${id}`; mesh.position.copy(position).y += 1.25;
      if (initialFocus && Number.isFinite(activeRadius)) {
        mesh.visible = Math.hypot(position.x - initialFocus.x, position.z - initialFocus.z) <= activeRadius;
      }
      scene.add(mesh);
      this.items.set(id, { id, definition, mesh, baseY: position.y + 1.25, phase: random() * Math.PI * 2, bounds: new THREE.Box3() });
    }
    this.total = this.items.size;
  }
  update(seconds, playerBounds) {
    if (this.disposed) return;
    const centerX = (playerBounds.min.x + playerBounds.max.x) * .5;
    const centerZ = (playerBounds.min.z + playerBounds.max.z) * .5;
    const activeRadiusSq = this.activeRadius * this.activeRadius;
    for (const [id, item] of this.items) {
      const dx = item.mesh.position.x - centerX, dz = item.mesh.position.z - centerZ;
      const active = dx * dx + dz * dz <= activeRadiusSq;
      item.mesh.visible = active;
      if (!active) continue;

      item.mesh.position.y = item.baseY + Math.sin(seconds * 2 + item.phase) * .22;
      item.mesh.rotation.y = seconds * .9 + item.phase;
      const p = item.mesh.position;
      // Conservative AABB covers every orientation and bob position this frame.
      item.bounds.min.set(p.x - 1.6, p.y - .2, p.z - 1.6);
      item.bounds.max.set(p.x + 1.6, p.y + 1.5, p.z + 1.6);
      if (item.bounds.intersectsBox(playerBounds)) {
        this.items.delete(id); disposeGroup(item.mesh);
        this.score += item.definition.points; this.collected++;
        if (!this.collectedIds.includes(id)) this.collectedIds.push(id);
        this.onCollect({ ...item.definition, instanceId: id, score: this.score, collected: this.collected, total: this.total });
      }
    }
  }
  /**
   * Remove items a previous session had already collected (`NET-01`).
   *
   * The layout is seeded, so instance `vada-pav:3` is the same vada pav in the same place in
   * every session — restoring progress means removing exactly those instances and adding back
   * the points they were worth, which is why the id, not the position, is what a save stores.
   * An id the layout does not hold is reported rather than ignored: it means the save names
   * something this build cannot place, and the caller has to decide what to say about it.
   */
  restore(instanceIds) {
    const report = { restored: 0, missing: [] };
    for (const id of Array.isArray(instanceIds) ? instanceIds : []) {
      const item = this.items.get(id);
      if (!item) { report.missing.push(id); continue; }
      this.items.delete(id);
      disposeGroup(item.mesh);
      this.score += item.definition.points;
      this.collected++;
      this.collectedIds.push(id);
      report.restored++;
    }
    return report;
  }

  /**
   * The progress section's per-state records, keyed by the item's own biome.
   *
   * The biome is the content-pack vocabulary (`vada-pav` is a `maharashtra` item), so the key
   * a save uses is the key the content pipeline already uses, rather than a second naming
   * scheme invented by the save file.
   */
  progressByState(out = {}) {
    for (const id of this.collectedIds) {
      const definition = FOOD_ITEMS.find(item => id.startsWith(`${item.id}:`));
      if (!definition) continue;
      const record = out[definition.biome] ?? { collected: [], score: 0 };
      record.collected.push(id);
      record.score += definition.points;
      out[definition.biome] = record;
    }
    return out;
  }

  dispose() { if (this.disposed) return; this.disposed = true; this.items.forEach(item => disposeGroup(item.mesh)); this.items.clear(); }
}
