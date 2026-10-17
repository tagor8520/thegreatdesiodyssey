import * as THREE from 'three';
import {
  GDO_FALL_IMPACT,
  GDO_WATER_CONTACT_PROFILES,
  GDO_WATER_STATE,
  classifyFallImpact,
  stepWaterMotion,
} from '../engine/WaterContact.js';
import { terrainHeight } from './BiomeManager.js';
import { VoxelBatch, disposeGroup } from './VoxelBatch.js';
import { ThirdPersonCamera } from './ThirdPersonCamera.js';
import { definePlayerDomain } from '../engine/DomainInterface.js';

// Match the rendered four-unit tile centers, including shoreline steps.
export const CURATED_BODY_HEIGHT = 1.7;

export function tileHeight(x, z) { return terrainHeight(Math.floor(x / 4) * 4 + 2, Math.floor(z / 4) * 4 + 2); }

/** `FND-08`: the curated avatar declares the shared player interface. Keyboard
 * input stays its primary path, but analog move input and camera-mode switching
 * are part of the same contract the coordinate avatar implements. */
export const GDO_CURATED_PLAYER_DOMAIN = definePlayerDomain({
  id: 'curated-player',
  label: 'Curated adventurer',
  worldId: 'curated',
  cameraModes: ['third-person', 'map'],
  capabilities: { analogInput: true, jump: true, pointerLook: true },
});

export class Player {
  constructor(scene, camera, bridges, {
    inputTarget = window,
    canvas,
    onCameraHint,
    spawn = new THREE.Vector3(-42, 3, -20),
    orbitOptions = {},
    castShadow = true,
    manager = null,
  } = {}) {
    this.camera = camera; this.bridges = bridges; this.inputTarget = inputTarget;
    // `COL-08`: the island's biome manager answers the shared water sensor.
    this.manager = manager;
    this.waterContact = {};
    this.waterMotion = {};
    this.fallImpact = {};
    this.waterState = GDO_WATER_STATE.DRY;
    this.lastFallImpact = GDO_FALL_IMPACT.NONE;
    this.enabled = true;
    this.spawn = spawn.clone(); this.position = spawn.clone(); this.velocity = new THREE.Vector3();
    this.keys = new Set(); this.grounded = true; this.jumpQueued = false; this.disposed = false; this.mapMode = false;
    this.playerDomain = GDO_CURATED_PLAYER_DOMAIN;
    this.analogMove = { x: 0, z: 0 };
    this.unitsPerMetreScale = this.playerDomain.capabilities ? 1 : 1;
    this.bounds = new THREE.Box3(); this.scratchBounds = new THREE.Box3();
    this.root = new THREE.Group(); this.root.name = 'adventurer'; this.root.position.copy(spawn);
    this.geometry = new THREE.BoxGeometry(1, 1, 1); this.materials = new Map(); this.phase = 0;
    const box = (parent, x, y, z, sx, sy, sz, color) => {
      if (!this.materials.has(color)) this.materials.set(color, new THREE.MeshStandardMaterial({ color, roughness: .85 }));
      const mesh = new THREE.Mesh(this.geometry, this.materials.get(color));
      mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz);
      mesh.castShadow = castShadow; mesh.receiveShadow = castShadow; parent.add(mesh); return mesh;
    };
    const staticBatch = new VoxelBatch();
    const staticBox = (x, y, z, sx, sy, sz, color) => staticBatch.box(x, y, z, sx, sy, sz, color);

    // Local +Z faces forward. Animated limbs keep independent pivots; all
    // non-animated body voxels share one instanced palette draw.
    this.legs = [-1, 1].map(side => {
      const pivot = new THREE.Group(); pivot.position.set(side * .4, 1.6, 0); this.root.add(pivot);
      box(pivot, 0, -.6, 0, .65, 1.2, .7, '#253c60'); box(pivot, 0, -1.4, .12, .7, .4, 1, '#f2e8cb'); return pivot;
    });
    staticBox(0, 2.25, 0, 1.65, 1.4, .85, '#f5d795');
    for (const side of [-1, 1]) staticBox(side * .58, 2.25, .48, .5, 1.45, .18, '#387aac');
    staticBox(0, 2.4, .46, .42, .38, .08, '#ed7148');
    staticBox(0, 2.05, .46, .25, .2, .08, '#428e70');
    this.arms = [-1, 1].map(side => {
      const pivot = new THREE.Group(); pivot.position.set(side * 1.05, 2.8, 0); this.root.add(pivot);
      box(pivot, 0, -.5, 0, .5, 1, .65, '#387aac'); box(pivot, 0, -1.1, 0, .48, .4, .6, '#b9794e'); return pivot;
    });
    staticBox(0, 3.6, 0, 1.3, 1.25, 1.15, '#b9794e');
    staticBox(0, 4.2, -.06, 1.38, .3, 1.2, '#292322');
    staticBox(0, 3.97, .01, 1.43, .25, 1.24, '#d52e37');
    staticBox(.83, 3.85, -.2, .4, .3, .45, '#db3942');
    staticBox(1, 3.45, -.3, .25, .8, .2, '#d52e37');
    for (const side of [-1, 1]) {
      staticBox(side * .34, 3.68, .61, .58, .34, .15, '#18242d');
      staticBox(side * .34 - .12, 3.74, .7, .14, .1, .04, '#b7e5df');
    }
    staticBox(0, 3.7, .62, .18, .1, .15, '#18242d');
    const staticRoot = staticBatch.build();
    staticRoot.traverse(object => { if (object.isMesh) object.castShadow = castShadow; });
    this.root.add(staticRoot);
    scene.add(this.root);
    this.keydown = event => {
      if (!this.enabled) return;
      if (event.target?.closest?.('input,textarea,select,[contenteditable="true"]') || event.ctrlKey || event.metaKey || event.altKey) return;
      if (!['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','ShiftLeft','ShiftRight','KeyM'].includes(event.code)) return;
      event.preventDefault(); this.keys.add(event.code);
      if (event.code === 'Space' && !event.repeat) this.jumpQueued = true;
      if (event.code === 'KeyM' && !event.repeat) { this.mapMode = !this.mapMode; this.orbit.mapMode = this.mapMode; this.orbit.release(); }
    };
    this.keyup = event => this.keys.delete(event.code);
    this.blur = () => { this.keys.clear(); this.jumpQueued = false; this.velocity.x = this.velocity.z = 0; };
    inputTarget.addEventListener('keydown', this.keydown); inputTarget.addEventListener('keyup', this.keyup); inputTarget.addEventListener('blur', this.blur);
    this.orbit = new ThirdPersonCamera(camera, canvas, spawn, {
      groundHeight: tileHeight,
      clipCamera: (target, desired, radius, out) => bridges.clipCamera(target, desired, radius, out),
      onHint: onCameraHint,
      ...orbitOptions,
    });
    this.updateBounds();
  }
  groundAt(x, z) { return Math.max(tileHeight(x, z), this.bridges.heightAt(x, z)); }
  boundsAt(position, box) {
    box.min.set(position.x - .6, position.y + .05, position.z - .6);
    box.max.set(position.x + .6, position.y + 4.35, position.z + .6); return box;
  }
  updateBounds() { return this.boundsAt(this.position, this.bounds); }
  moveAxis(axis, amount) {
    const old = this.position[axis]; this.position[axis] += amount;
    let floor = -Infinity;
    for (const dx of [-.55, .55]) for (const dz of [-.55, .55]) floor = Math.max(floor, this.groundAt(this.position.x + dx, this.position.z + dz));
    if (Math.abs(this.position.x) > 126 || Math.abs(this.position.z) > 126 || floor > this.position.y + .55 || this.bridges.intersectsRail(this.boundsAt(this.position, this.scratchBounds))) {
      this.position[axis] = old; this.velocity[axis] = 0;
    } else if (this.grounded && floor > this.position.y) this.position.y = floor;
  }
  /** Shared player interface: normalized analog move input (touch/UI/gamepad). */
  setMoveInput(x, z) {
    const length = Math.hypot(x, z);
    const scale = length > 1 ? 1 / length : 1;
    this.analogMove.x = x * scale;
    this.analogMove.z = z * scale;
  }
  /** Shared player interface: teleport to a ground-supported point. */
  setPosition(x, z) {
    const ground = this.groundAt(x, z);
    this.position.set(x, ground, z);
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.root.position.copy(this.position);
    this.updateBounds();
  }
  get cameraMode() { return this.mapMode ? 'map' : 'third-person'; }
  toggleCameraMode() {
    this.mapMode = !this.mapMode;
    this.orbit.mapMode = this.mapMode;
    return this.cameraMode;
  }
  step(dt) {
    const held = (...codes) => codes.some(code => this.keys.has(code));
    let x = this.analogMove.x + Number(held('KeyD','ArrowRight')) - Number(held('KeyA','ArrowLeft'));
    let z = this.analogMove.z + Number(held('KeyS','ArrowDown')) - Number(held('KeyW','ArrowUp'));
    const length = Math.hypot(x, z); if (length) { x /= length; z /= length; }
    const yaw = this.mapMode ? 0 : this.orbit.yaw;
    const localX = x;
    x = localX * Math.cos(yaw) + z * Math.sin(yaw);
    z = z * Math.cos(yaw) - localX * Math.sin(yaw);
    // `COL-08`: water scales the walk target before the axis moves are swept.
    const water = this.manager?.waterContact
      ? this.manager.waterContact(this.position.x, this.position.z, {
        feetY: this.position.y, gravity: 30, bodyHeight: CURATED_BODY_HEIGHT, profile: 'low',
      }, this.waterContact)
      : null;
    this.waterState = water?.state ?? GDO_WATER_STATE.DRY;
    const speed = (held('ShiftLeft','ShiftRight') ? 19 : 12) * (water?.speedMultiplier ?? 1);
    const alpha = 1 - Math.exp(-14 * dt);
    this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, x * speed, alpha);
    this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, z * speed, alpha);
    if (this.jumpQueued && this.grounded) { this.velocity.y = 13; this.grounded = false; }
    this.jumpQueued = false;
    this.moveAxis('x', this.velocity.x * dt); this.moveAxis('z', this.velocity.z * dt);
    const previousY = this.position.y;
    if (water && water.submersion > 0) {
      stepWaterMotion({ contact: water, velocityY: this.velocity.y, gravity: 30, dt }, this.waterMotion);
      this.velocity.y = this.waterMotion.velocityY;
    } else this.velocity.y -= 30 * dt;
    // §9.9: the fall speed is capped in the curated island too.
    this.velocity.y = Math.max(this.velocity.y, -GDO_WATER_CONTACT_PROFILES.low.maxFallSpeedRatio * 30);
    this.position.y += this.velocity.y * dt;
    let ground = -Infinity;
    for (const dx of [-.55,.55]) for (const dz of [-.55,.55]) ground = Math.max(ground, this.groundAt(this.position.x + dx, this.position.z + dz));
    if (ground >= 0 && this.velocity.y <= 0 && previousY >= ground - .6 && this.position.y <= ground) {
      // `COL-08`: the landing is classified before the velocity is cleared.
      classifyFallImpact({
        verticalSpeed: this.velocity.y, gravity: 30, bodyHeight: CURATED_BODY_HEIGHT,
        profile: 'low', landedInWater: (water?.submersion ?? 0) > .2,
      }, this.fallImpact);
      this.lastFallImpact = this.fallImpact.impact;
      if (this.fallImpact.impact === GDO_FALL_IMPACT.STUMBLE) { this.velocity.x *= .45; this.velocity.z *= .45; }
      else if (this.fallImpact.impact === GDO_FALL_IMPACT.KNOCKDOWN) { this.velocity.x = 0; this.velocity.z = 0; }
      this.position.y = ground; this.velocity.y = 0; this.grounded = true;
    } else this.grounded = false;
    if (this.position.y < -5) { this.position.copy(this.spawn); this.velocity.set(0, 0, 0); this.grounded = true; }
    if (water && water.submersion > 0) {
      // §9.5 horizontal drag and mapped-flow push, applied to the driven velocity.
      const decay = Math.exp(-water.horizontalDragPerSecond * dt);
      this.velocity.x = this.velocity.x * decay + water.currentX * dt;
      this.velocity.z = this.velocity.z * decay + water.currentZ * dt;
    }
    if (length) {
      const target = Math.atan2(x, z), difference = Math.atan2(Math.sin(target - this.root.rotation.y), Math.cos(target - this.root.rotation.y));
      this.root.rotation.y += difference * (1 - Math.exp(-16 * dt));
    }
    this.phase += Math.hypot(this.velocity.x, this.velocity.z) * dt * .65;
    const swing = this.grounded ? Math.sin(this.phase) * Math.min(.6, Math.hypot(this.velocity.x,this.velocity.z) * .05) : .2;
    this.legs[0].rotation.x = swing; this.legs[1].rotation.x = -swing;
    this.arms[0].rotation.x = -swing; this.arms[1].rotation.x = swing;
    this.root.position.copy(this.position); this.updateBounds();
  }
  update(dt) {
    // Bound each collision step to 1/120 s, including low-FPS frames.
    let remaining = Math.min(Math.max(dt, 0), .1);
    while (remaining > 1e-8) { const step = Math.min(remaining, 1 / 120); this.step(step); remaining -= step; }
    this.orbit.mapMode = this.mapMode; this.orbit.update(dt, this.position);
  }
  querySnapshot() {
    return {
      domain: this.playerDomain.id,
      mode: this.cameraMode,
      position: { x: this.position.x, y: this.position.y, z: this.position.z },
      grounded: this.grounded,
    };
  }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.analogMove.x = 0; this.analogMove.z = 0; this.blur();
    this.inputTarget.removeEventListener('keydown', this.keydown); this.inputTarget.removeEventListener('keyup', this.keyup); this.inputTarget.removeEventListener('blur', this.blur);
    this.orbit.dispose();
    disposeGroup(this.root);
  }
}
