import * as THREE from 'three';
import { tileHeight } from './BiomeManager.js';
import { createCuratedDomain, CURATED_COLLISION_HALF_EXTENT, CURATED_FOOTPRINT_HALF_EXTENT } from './CuratedDomain.js';
import { supportUnderFoot } from '../engine/WorldDomain.js';
import { VoxelBatch, disposeGroup } from './VoxelBatch.js';
import { ThirdPersonCamera } from './ThirdPersonCamera.js';
import { ActionInput, slotForAction } from '../engine/ActionRegistry.js';

// Re-exported for callers that have always imported it from here; the
// implementation moved to the terrain module when `FND-08` gave the curated
// runtime a named domain to ask instead of a module-level function.
export { tileHeight };

/**
 * How far the body may be from the support it came from and still treat the
 * next support as a step rather than as a discontinuity. Matches the guard the
 * shipped falling branch used (`previousY >= ground - .6`).
 */
const CURATED_SUPPORT_PROXIMITY = .6;

export class Player {
  constructor(scene, camera, bridges, {
    inputTarget = window,
    canvas,
    onCameraHint,
    onSelectSlot,
    spawn = new THREE.Vector3(-42, 3, -20),
    orbitOptions = {},
    castShadow = true,
    domain = null,
  } = {}) {
    this.camera = camera; this.bridges = bridges; this.inputTarget = inputTarget;
    // `GME-05`: one callback for inventory selection, shared by the keyboard path
    // (`ActionInput` → `onAction`) and the on-screen buttons in `GameUI`.
    this.onSelectSlot = onSelectSlot;
    // The traversal surface used to be this class's own arithmetic over a
    // module-level terrain function plus `bridges`. `FND-08` gives it a name;
    // a caller may inject its own, otherwise one is built around the bridges.
    this.domain = domain ?? createCuratedDomain({ bridges });
    this.enabled = true;
    this.spawn = spawn.clone(); this.position = spawn.clone(); this.velocity = new THREE.Vector3();
    this.keys = new Set(); this.grounded = true; this.jumpQueued = false; this.disposed = false; this.mapMode = false;
    this.bounds = new THREE.Box3(); this.scratchBounds = new THREE.Box3();
    this.supportScratch = {}; this.motionResult = {};
    this.groundTransitionOptions = { footprintHalfExtent: CURATED_FOOTPRINT_HALF_EXTENT };
    this.groundTransitionResult = {};
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
    // `GME-05`: the curated runtime resolves input through the same shared action
    // registry as the coordinate runtime. `keys` stays the raw code set, so
    // callers and tests that add codes directly keep working.
    this.input = new ActionInput({
      runtime: 'curated',
      target: inputTarget,
      shouldIgnore: () => !this.enabled,
      onAction: action => {
        if (action === 'jump') this.jumpQueued = true;
        else if (action === 'map') {
          this.mapMode = !this.mapMode;
          this.orbit.mapMode = this.mapMode;
          this.orbit.release();
        } else {
          // `GME-05`: inventory slots reach the game through the same registry as
          // every other action. The keyboard and the on-screen buttons both end up
          // in `onSelectSlot`, so they cannot drift apart.
          const slot = slotForAction(action);
          if (slot >= 0) this.onSelectSlot?.(slot);
        }
      },
      onBlur: () => this.resetMotion(),
    });
    this.keys = this.input.keys;
    this.resetMotion = () => { this.jumpQueued = false; this.velocity.x = this.velocity.z = 0; };
    this.blur = () => { this.input.clear(); this.resetMotion(); };
    this.orbit = new ThirdPersonCamera(camera, canvas, spawn, {
      groundHeight: tileHeight,
      clipCamera: (target, desired, radius, out) => this.domain.clipCamera(target, desired, radius, out),
      onHint: onCameraHint,
      ...orbitOptions,
    });
    this.updateBounds();
  }
  groundAt(x, z) { return this.domain.supportAt(x, z, this.supportScratch).y; }
  boundsAt(position, box) {
    box.min.set(position.x - .6, position.y + .05, position.z - .6);
    box.max.set(position.x + .6, position.y + 4.35, position.z + .6); return box;
  }
  updateBounds() { return this.boundsAt(this.position, this.bounds); }
  /** Ground under the body, sampled at the four corners of its footprint. */
  supportUnderFoot(x = this.position.x, z = this.position.z) {
    return supportUnderFoot(this.domain, x, z, CURATED_FOOTPRINT_HALF_EXTENT, this.supportScratch).y;
  }
  /**
   * One-axis move under the shipped rule, kept for callers that drive an axis
   * directly. `step()` no longer uses it: horizontal blocking is the domain's
   * `moveCircle` and the step limit is its `resolveGroundStep`, which is the
   * same split the coordinate mode has always used.
   */
  moveAxis(axis, amount) {
    const previousX = this.position.x, previousZ = this.position.z;
    const motion = this.domain.moveCircle(
      previousX, previousZ,
      axis === 'x' ? amount : 0, axis === 'z' ? amount : 0,
      CURATED_COLLISION_HALF_EXTENT, 0, 1, this.motionResult, 0,
    );
    const moved = axis === 'x' ? motion.x - previousX : motion.z - previousZ;
    if (moved === 0 && amount !== 0) { this.velocity[axis] = 0; return false; }
    this.position.x = motion.x; this.position.z = motion.z;
    if (!this.grounded) return true;
    const transition = this.domain.resolveGroundStep(
      previousX, previousZ, motion.x, motion.z, this.groundTransitionOptions, this.groundTransitionResult,
    );
    if (!transition.accepted) {
      this.position.x = previousX; this.position.z = previousZ;
      this.velocity[axis] = 0;
      return false;
    }
    if (Math.abs(this.position.y - transition.from.y) > CURATED_SUPPORT_PROXIMITY) return true;
    if (transition.to.y > this.position.y) this.position.y = transition.to.y;
    return true;
  }
  step(dt) {
    const held = action => this.input.active(action);
    let x = Number(held('right')) - Number(held('left'));
    let z = Number(held('back')) - Number(held('forward'));
    const length = Math.hypot(x, z); if (length) { x /= length; z /= length; }
    const yaw = this.mapMode ? 0 : this.orbit.yaw;
    const localX = x;
    x = localX * Math.cos(yaw) + z * Math.sin(yaw);
    z = z * Math.cos(yaw) - localX * Math.sin(yaw);
    const speed = held('run') ? 19 : 12;
    const alpha = 1 - Math.exp(-14 * dt);
    this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, x * speed, alpha);
    this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, z * speed, alpha);
    if (this.jumpQueued && this.grounded) { this.velocity.y = 13; this.grounded = false; }
    this.jumpQueued = false;
    const previousX = this.position.x, previousZ = this.position.z;
    const deltaX = this.velocity.x * dt, deltaZ = this.velocity.z * dt;
    const motion = this.domain.moveCircle(
      previousX, previousZ, deltaX, deltaZ,
      CURATED_COLLISION_HALF_EXTENT, 0, 2, this.motionResult, 0,
    );
    this.position.x = motion.x; this.position.z = motion.z;
    // A reverted axis is a stopped axis; the domain does not slide, it undoes.
    if (deltaX !== 0 && motion.x === previousX) this.velocity.x = 0;
    if (deltaZ !== 0 && motion.z === previousZ) this.velocity.z = 0;
    if (this.grounded) {
      this.groundTransitionOptions.referenceY = this.position.y;
      const transition = this.domain.resolveGroundStep(
        previousX, previousZ, this.position.x, this.position.z,
        this.groundTransitionOptions, this.groundTransitionResult,
      );
      // A grounded body only steps onto its new support when it was standing on
      // the previous one. The shipped rule compared the floor against the body
      // (`floor > y + .55`), which a support-to-support policy cannot see; the
      // same guard is kept here because without it any position discontinuity —
      // a respawn, a debug teleport, a scenario pin — reads as a legitimate
      // step and lifts the body to the surface instead of letting gravity and
      // the world escape bound resolve it.
      const standingOnFrom = Math.abs(this.position.y - transition.from.y) <= CURATED_SUPPORT_PROXIMITY;
      if (!transition.accepted) {
        // The rise exceeded the policy, so the whole horizontal move is undone.
        // The coordinate mode resolves a rejected transition the same way.
        this.position.x = previousX; this.position.z = previousZ;
        this.velocity.x = 0; this.velocity.z = 0;
        this.position.y = transition.from.y;
      } else if (standingOnFrom && transition.to.y > this.position.y) {
        this.position.y = transition.to.y;
      }
    }
    const previousY = this.position.y; this.velocity.y -= 30 * dt; this.position.y += this.velocity.y * dt;
    const ground = this.supportUnderFoot();
    if (ground >= 0 && this.velocity.y <= 0 && previousY >= ground - .6 && this.position.y <= ground) {
      this.position.y = ground; this.velocity.y = 0; this.grounded = true;
    } else this.grounded = false;
    if (this.position.y < -5) { this.position.copy(this.spawn); this.velocity.set(0, 0, 0); this.grounded = true; }
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
  dispose() {
    if (this.disposed) return; this.disposed = true; this.blur();
    this.input.dispose();
    this.orbit.dispose();
    disposeGroup(this.root);
  }
}
