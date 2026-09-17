import * as THREE from 'three';
import { VoxelBatch, disposeGroup } from './VoxelBatch.js';
import { tileHeight } from './Player.js';

import { HOARDINGS } from './GameplayLayout.js';
export { HOARDINGS } from './GameplayLayout.js';

/** Board and separate post proxies leave the real under-sign opening clear. */
export function createHoardingCameraBlockers() {
  const boxes = [];
  for (const spec of HOARDINGS) {
    const ground = tileHeight(spec.x, spec.z);
    const board = new THREE.Box3(
      new THREE.Vector3(spec.x - 7.75, ground + 3.5, spec.z - .35),
      new THREE.Vector3(spec.x + 7.75, ground + 9.5, spec.z + .35),
    );
    board.userData = { id: `hoarding:${spec.text}:board`, role: 'camera-blocker' };
    boxes.push(board);
    for (const dx of [-5.5, 5.5]) {
      const post = new THREE.Box3(
        new THREE.Vector3(spec.x + dx - .325, ground, spec.z - .325),
        new THREE.Vector3(spec.x + dx + .325, ground + 7, spec.z + .325),
      );
      post.userData = { id: `hoarding:${spec.text}:post:${dx}`, role: 'camera-blocker' };
      boxes.push(post);
    }
  }
  return boxes;
}

export class HoardingManager {
  constructor(scene, { textureScale = 1 } = {}) {
    if (!(textureScale > 0 && textureScale <= 1)) throw new RangeError('textureScale must be between 0 and 1');
    this.root = new THREE.Group(); this.root.name = 'biome-welcome-signs'; this.textures = []; this.disposed = false;
    this.cameraBlockers = createHoardingCameraBlockers();
    for (const spec of HOARDINGS) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(1024 * textureScale); canvas.height = Math.round(384 * textureScale);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas2D is required for biome sign textures');
      ctx.scale(textureScale, textureScale);
      ctx.fillStyle = spec.color; ctx.fillRect(0, 0, 1024, 384);
      ctx.strokeStyle = '#eac791'; ctx.lineWidth = 14; ctx.strokeRect(12, 12, 1000, 360);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff4d8';
      ctx.font = '600 62px sans-serif'; ctx.fillText(spec.lines[0], 512, 123, 930);
      ctx.font = 'bold 94px sans-serif'; ctx.fillText(spec.lines[1], 512, 251, 930);
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; this.textures.push(texture);
      const ground = tileHeight(spec.x, spec.z), batch = new VoxelBatch();
      for (const dx of [-5.5, 5.5]) batch.box(spec.x + dx, ground + 3.5, spec.z, .65, 7, .65, '#65462d');
      batch.box(spec.x, ground + 6.5, spec.z, 15.5, 6, .7, '#795432');
      this.root.add(batch.build());
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(15, 5.625), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, side: THREE.DoubleSide }));
      sign.name = spec.text; sign.position.set(spec.x, ground + 6.5, spec.z + .36); this.root.add(sign);
      const back = sign.clone(); back.rotation.y = Math.PI; back.position.z = spec.z - .36; this.root.add(back);
    }
    scene.add(this.root);
  }
  dispose() { if (this.disposed) return; this.disposed = true; disposeGroup(this.root); this.textures.forEach(t => t.dispose()); this.textures.length = 0; }
}
