import * as THREE from 'three';
import { biomeAt, LANDMARKS } from './BiomeManager.js';
import { tileHeight } from './Player.js';
import { VoxelBatch, randomFor, disposeGroup } from './VoxelBatch.js';
import { isGameplayClearance } from './GameplayLayout.js';
import { compileContentRecipe } from '../engine/ContentRecipe.js';
import { FOOD_RECIPES, FOOD_RECIPE_SEED } from './FoodRecipes.js';

// `CNT-02`: the recipes are the authoring surface, and these two helpers are what a tool or a
// gate uses to see what the runtime will draw without building a scene — the same compile the
// renderer runs, exposed so the two cannot drift.

/** The declared recipes, by id. */
export { FOOD_RECIPES } from './FoodRecipes.js';

/** Compile one declared item. Throws with the declared ids when asked for something unknown. */
export function compileFoodRecipe(id) {
  const recipe = FOOD_RECIPES[id];
  if (!recipe) {
    throw new RangeError(`Unknown food: ${JSON.stringify(id)} (declared: ${Object.keys(FOOD_RECIPES).join(', ')})`);
  }
  return compileContentRecipe(recipe, { seed: FOOD_RECIPE_SEED });
}

export const FOOD_ITEMS = Object.freeze([
  { id: 'vada-pav', name: 'Vada Pav', biome: 'maharashtra', points: 10 },
  { id: 'cutting-chai', name: 'Cutting Chai', biome: 'maharashtra', points: 15 },
  { id: 'filter-coffee', name: 'Filter Coffee', biome: 'karnataka', points: 15 },
  { id: 'mysore-pak', name: 'Mysore Pak', biome: 'karnataka', points: 20 },
  { id: 'banana-chips', name: 'Banana Chips', biome: 'kerala', points: 10 },
  { id: 'podi-dosa', name: 'Podi Dosa', biome: 'kerala', points: 25 },
  { id: 'kerala-porotta', name: 'Kerala Porotta', biome: 'kerala', points: 30 },
]);

/**
 * `CNT-02`: build one item by **compiling its recipe** and stamping the boxes through
 * `VoxelBatch`. The batch is a sink here, not an authoring surface: no geometry decision is
 * made in this file, and a contributor adding an item adds a recipe entry rather than a branch.
 */
export function createFoodModel(id) {
  const compiled = compileFoodRecipe(id);
  const batch = new VoxelBatch();
  for (const box of compiled.boxes) {
    // The order is `VoxelBatch.box`'s own: centre, size, colour, rotation, metalness.
    batch.box(box.x, box.y, box.z, box.sizeX, box.sizeY, box.sizeZ, box.color, [box.rx, box.ry, box.rz], box.metalness);
  }
  const group = batch.build();
  // What was drawn, recorded on the thing that was drawn: a gate reading the live scene can see
  // which recipe produced this mesh and what it compiled to, without a second source of truth.
  group.userData.recipe = { id, digest: compiled.digest, boxes: compiled.boxCount, bounds: compiled.bounds };
  return group;
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
