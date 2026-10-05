import * as THREE from 'three';
import { VoxelBatch, disposeGroup } from './VoxelBatch.js';
import { terrainHeight } from './BiomeManager.js';
import { sweepPointAgainstAabb3 } from '../geo/GeoCollision.js';

import { BRIDGES } from './GameplayLayout.js';
export { BRIDGES } from './GameplayLayout.js';

export class BridgeManager {
  constructor(scene, { cameraBlockers = [] } = {}) {
    this.root = new THREE.Group(); this.root.name = 'bridges';
    this.colliders = []; this.rails = []; this.cameraBlockers = [...cameraBlockers];
    this.cameraSweep = {}; this.disposed = false;
    BRIDGES.forEach(spec => this.buildBridge(spec)); scene.add(this.root);
  }
  buildBridge({ id, x, z, axis, length, width, material }) {
    const batch = new VoxelBatch(), stone = material === 'stone';
    const color = stone ? '#bba582' : '#996137';
    const segments = Math.ceil(length);
    const sample = (px, pz) => Math.max(3, terrainHeight(Math.floor(px / 4) * 4 + 2, Math.floor(pz / 4) * 4 + 2)) + .15;
    const startY = sample(x - (axis === 'x' ? length / 2 : 0), z - (axis === 'z' ? length / 2 : 0));
    const endY = sample(x + (axis === 'x' ? length / 2 : 0), z + (axis === 'z' ? length / 2 : 0));
    for (let i = 0; i < segments; i++) {
      const distance = -length / 2 + (i + .5) * length / segments;
      const t = (i + .5) / segments;
      const top = THREE.MathUtils.lerp(startY, endY, t) + Math.sin(t * Math.PI) * 3;
      const cx = axis === 'x' ? x + distance : x, cz = axis === 'z' ? z + distance : z;
      const sx = axis === 'x' ? length / segments + .02 : width;
      const sz = axis === 'z' ? length / segments + .02 : width;
      batch.box(cx, top - .35, cz, sx, .7, sz, color);
      const deck = new THREE.Box3(
        new THREE.Vector3(cx - sx / 2, top - .7, cz - sz / 2),
        new THREE.Vector3(cx + sx / 2, top, cz + sz / 2),
      );
      this.colliders.push(deck);
      deck.userData = { id: `${id}:deck:${i}`, role: 'camera-blocker' };
      this.cameraBlockers.push(deck);
      for (const side of [-1, 1]) {
        const rx = cx + (axis === 'z' ? side * (width / 2 - .2) : 0);
        const rz = cz + (axis === 'x' ? side * (width / 2 - .2) : 0);
        const rw = axis === 'x' ? sx : .4, rd = axis === 'z' ? sz : .4;
        batch.box(rx, top + 1.5, rz, rw, .3, rd, stone ? '#d1bb94' : '#c09354');
        const rail = new THREE.Box3(
          new THREE.Vector3(rx - rw / 2, top, rz - rd / 2),
          new THREE.Vector3(rx + rw / 2, top + 1.7, rz + rd / 2),
        );
        this.rails.push(rail);
        rail.userData = { id: `${id}:rail:${i}:${side}`, role: 'camera-blocker' };
        this.cameraBlockers.push(rail);
        if (i % 4 === 0) batch.box(rx, top + .8, rz, .5, 1.8, .5, color);
      }
      if (i % 8 === 0 && i > 3 && i < segments - 3) {
        const pierWidth = axis === 'x' ? 1 : width - 1;
        const pierDepth = axis === 'z' ? 1 : width - 1;
        batch.box(cx, (top - 3) / 2, cz, pierWidth, top + 3, pierDepth, color);
        const pier = new THREE.Box3(
          new THREE.Vector3(cx - pierWidth / 2, -3, cz - pierDepth / 2),
          new THREE.Vector3(cx + pierWidth / 2, top, cz + pierDepth / 2),
        );
        pier.userData = { id: `${id}:pier:${i}`, role: 'camera-blocker' };
        this.cameraBlockers.push(pier);
      }
    }
    const mesh = batch.build(); mesh.name = id; this.root.add(mesh);
  }
  heightAt(x, z) {
    let height = -Infinity;
    for (const box of this.colliders) if (x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z) height = Math.max(height, box.max.y);
    return height;
  }
  intersectsRail(box) { return this.rails.some(rail => rail.intersectsBox(box)); }
  clipCamera(target, desired, radius, out = {}) {
    const dx = desired.x - target.x, dy = desired.y - target.y, dz = desired.z - target.z;
    out.blocked = false;
    out.amount = 1;
    out.time = 1;
    for (const box of this.cameraBlockers) {
      const hit = sweepPointAgainstAabb3(
        target.x, target.y, target.z, dx, dy, dz,
        box.min.x - radius, box.min.y - radius, box.min.z - radius,
        box.max.x + radius, box.max.y + radius, box.max.z + radius,
        this.cameraSweep,
      );
      if (!hit.hit || hit.time >= out.time) continue;
      out.blocked = true;
      out.time = hit.time;
      out.normalX = hit.normalX;
      out.normalY = hit.normalY;
      out.normalZ = hit.normalZ;
    }
    if (!out.blocked) return out;
    const distance = Math.hypot(dx, dy, dz);
    out.amount = Math.max(0, out.time - .02 / Math.max(distance, 1e-6));
    desired.set(
      target.x + dx * out.amount,
      target.y + dy * out.amount,
      target.z + dz * out.amount,
    );
    return out;
  }
  dispose() {
    if (this.disposed) return; this.disposed = true; disposeGroup(this.root);
    this.colliders.length = this.rails.length = this.cameraBlockers.length = 0;
  }
}
