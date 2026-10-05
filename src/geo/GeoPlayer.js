import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GEO_PLAYER_COLLISION_PROFILE } from './GeoCollision.js';
import { ActionInput, codesFor } from '../engine/ActionRegistry.js';

// Horizontal source geometry is 1:10, so a roughly 1.8 m avatar is 0.18 units.
// The movement shape and its skin together remain inside the measured profile;
// arm animation and camera clearance do not enlarge this solid proxy.
const MODEL_SCALE = 0.05;
const FIRST_PERSON_EYE_HEIGHT = 0.18;

export function cameraNearPlaneSweepRadius(camera, skin = .006) {
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.near;
  const halfWidth = halfHeight * Math.max(.25, camera.aspect || 1);
  return THREE.MathUtils.clamp(Math.hypot(halfWidth, halfHeight) + skin, .03, .04);
}

function createAvatar() {
  const parts = [
    [-.38,.65,0,.58,1.3,.62,'#253c60'], [.38,.65,0,.58,1.3,.62,'#253c60'],
    [0,1.8,0,1.55,1.25,.82,'#f5d795'],
    [-.92,1.85,0,.42,1.45,.55,'#387aac'], [.92,1.85,0,.42,1.45,.55,'#387aac'],
    [0,3.05,0,1.25,1.15,1.05,'#b9794e'], [0,3.68,0,1.34,.28,1.1,'#292322'],
    [0,3.48,.57,1.25,.27,.12,'#18242d'], [0,3.72,.05,1.38,.22,1.12,'#d52e37'],
  ];
  // Merge the coloured voxel parts into one static mesh. This retains a single
  // reliable draw call while making the TPP character share the curated mode's
  // detailed avatar language (instead of a flat diagnostic silhouette).
  const geometries = parts.map(([x,y,z,sx,sy,sz,color]) => {
    const geometry = new THREE.BoxGeometry(sx, sy, sz);
    geometry.translate(x, y, z);
    const vertexColor = new THREE.Color(color);
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    for (let index = 0; index < geometry.attributes.position.count; index++) vertexColor.toArray(colors, index * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  });
  const geometry = mergeGeometries(geometries, false);
  for (const part of geometries) part.dispose();
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = true;
  return mesh;
}

export class GeoPlayer {
  constructor(scene, camera, canvas, world, { onCameraModeChange = () => {}, onDebugToggle = null } = {}) {
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.world = world;
    this.onCameraModeChange = onCameraModeChange;
    this.onDebugToggle = onDebugToggle;
    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.keys = new Set();
    this.virtual = new Set();
    this.analogMove = { x: 0, z: 0 };
    this.enabled = false;
    this.grounded = true;
    this.jumpQueued = false;
    this.disposed = false;
    this.yaw = 0;
    this.firstPersonPitch = 0;
    this.thirdPersonPitch = .32;
    this.distance = 2.6;
    this.cameraResolvedDistance = this.distance;
    this.cameraMode = 'first-person';
    this.lookPointerId = null;
    this.lastPointerX = 0;
    this.lastPointerY = 0;

    this.root = new THREE.Group();
    this.root.name = 'coordinate-explorer';
    this.avatar = createAvatar();
    this.avatar.visible = false;
    this.root.add(this.avatar);
    this.root.scale.setScalar(MODEL_SCALE);
    scene.add(this.root);

    this.cameraTarget = new THREE.Vector3();
    this.cameraIdeal = new THREE.Vector3();
    this.cameraDesired = new THREE.Vector3();
    this.lookDirection = new THREE.Vector3();
    this.motionResult = {};
    this.groundTransitionResult = { from: {}, to: {} };
    this.groundTransitionOptions = { referenceY: 0 };
    this.supportResult = {};
    this.landingSupportOptions = { referenceY: 0 };
    this.airborneSupportY = 0;
    this.cameraSupportResult = {};
    this.cameraClipResult = {};

    // Input is resolved through the shared action registry (`GME-05`) instead of
    // a hard-coded code list living in this constructor. `keys`, `virtual` and
    // `setVirtualInput` remain the same surface, so callers and tests that drive
    // input directly are unaffected — but every code is now interpreted by the
    // registry, and an action this runtime does not have is rejected by name.
    this.input = new ActionInput({
      runtime: 'coordinates',
      target: window,
      shouldIgnore: () => !this.enabled,
      onAction: action => {
        if (action === 'jump') this.jumpQueued = true;
        else if (action === 'camera') this.toggleCameraMode();
        // `GME-05`: `F3` used to be a second keydown listener in `GeoGame`, sitting
        // alongside the registry's own binding for the same key. The registry is
        // the only keymap now, and this is the runtime's handler for the action.
        else if (action === 'debug') this.onDebugToggle?.();
      },
      onBlur: () => this.resetMotion(),
    });
    this.keys = this.input.keys;
    this.virtual = this.input.virtual;
    // The analogue stick lives on the input object, so a joystick wired through
    // the shared touch layer and a direct `setMoveInput()` call are the same path.
    this.input.setAnalog(0, 0);
    this.analogMove = this.input.analog;
    /** Clears movement and look state without touching the input sets. */
    this.resetMotion = () => {
      this.analogMove.x = 0;
      this.analogMove.z = 0;
      this.velocity.x = 0;
      this.velocity.z = 0;
      this.jumpQueued = false;
      this.lookPointerId = null;
    };
    /** Kept for callers and tests that reset the player directly. */
    this.blur = () => { this.input.clear(); this.resetMotion(); };
    this.mousedown = event => {
      if (event.button !== 0 || this.disposed) return;
      if (canvas.requestPointerLock) {
        try { canvas.requestPointerLock()?.catch(() => {}); } catch {}
      }
    };
    this.mousemove = event => {
      if (document.pointerLockElement !== canvas || this.disposed) return;
      this._orbit(event.movementX, event.movementY);
    };
    this.pointerdown = event => {
      if (event.pointerType === 'mouse' || this.disposed || this.lookPointerId !== null) return;
      this.lookPointerId = event.pointerId;
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
      canvas.setPointerCapture?.(event.pointerId);
    };
    this.pointermove = event => {
      if (event.pointerId !== this.lookPointerId || event.pointerType === 'mouse') return;
      const dx = event.clientX - this.lastPointerX;
      const dy = event.clientY - this.lastPointerY;
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
      this._orbit(dx * 1.2, dy * 1.2);
    };
    this.pointerup = event => {
      if (event.pointerId === this.lookPointerId) this.lookPointerId = null;
    };
    this.wheel = event => {
      if (this.cameraMode !== 'third-person') return;
      event.preventDefault();
      this.distance = THREE.MathUtils.clamp(
        this.distance * Math.exp(THREE.MathUtils.clamp(event.deltaY, -300, 300) * .001),
        1.2,
        8,
      );
    };

    // Keyboard, keyup and blur listeners belong to `this.input`, which removes
    // them in its own dispose; `FND-07` counts listeners, and a handler registered
    // in two places is a handler that gets removed from one of them.
    document.addEventListener('mousemove', this.mousemove);
    canvas.addEventListener('mousedown', this.mousedown);
    canvas.addEventListener('pointerdown', this.pointerdown);
    canvas.addEventListener('pointermove', this.pointermove);
    canvas.addEventListener('pointerup', this.pointerup);
    canvas.addEventListener('pointercancel', this.pointerup);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    this.setCameraMode('first-person', true);
  }

  _orbit(dx, dy) {
    this.yaw = THREE.MathUtils.euclideanModulo(this.yaw - dx * .004 + Math.PI, Math.PI * 2) - Math.PI;
    if (this.cameraMode === 'first-person') {
      this.firstPersonPitch = THREE.MathUtils.clamp(this.firstPersonPitch + dy * .0035, -1.32, 1.32);
    } else {
      this.thirdPersonPitch = THREE.MathUtils.clamp(this.thirdPersonPitch + dy * .004, .16, 1.25);
    }
  }

  setCameraMode(mode, snap = false) {
    if (!['first-person', 'third-person'].includes(mode)) throw new RangeError(`Unknown camera mode: ${mode}`);
    this.cameraMode = mode;
    this.avatar.visible = mode === 'third-person';
    this.camera.fov = mode === 'first-person' ? 68 : 52;
    this.camera.updateProjectionMatrix();
    this.updateCamera(0, snap);
    this.onCameraModeChange(mode);
  }

  toggleCameraMode() {
    this.setCameraMode(this.cameraMode === 'first-person' ? 'third-person' : 'first-person', true);
    return this.cameraMode;
  }

  setMoveInput(x, z) {
    const length = Math.hypot(x, z);
    const scale = length > 1 ? 1 / length : 1;
    this.input.setAnalog(x * scale, z * scale);
  }

  /**
   * Touch/UI input. The registry validates the action name against this runtime,
   * so a control wired to a typo or to another mode's action throws instead of
   * silently doing nothing — which is how the old version could accept any
   * string at all.
   */
  setVirtualInput(action, active) {
    this.input.setVirtual(action, active && this.enabled);
  }

  setPosition(x, z) {
    const groundY = this.world.supportAt(x, z, this.supportResult).y;
    this.position.set(x, groundY, z);
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.airborneSupportY = groundY;
    this.root.position.copy(this.position);
    this.updateCamera(0, true);
  }

  /**
   * Held state for one registered action. The code list comes from the registry,
   * so a rebind is a registry edit rather than a search for every call site.
   */
  held(action) {
    if (this.virtual.has(action)) return true;
    for (const code of codesFor(action)) if (this.keys.has(code)) return true;
    return false;
  }

  step(dt) {
    let inputX = this.analogMove.x + Number(this.held('right')) - Number(this.held('left'));
    let inputZ = this.analogMove.z + Number(this.held('back')) - Number(this.held('forward'));
    const inputLength = Math.hypot(inputX, inputZ);
    if (inputLength > 1) {
      inputX /= inputLength;
      inputZ /= inputLength;
    }
    const x = inputX * Math.cos(this.yaw) + inputZ * Math.sin(this.yaw);
    const z = inputZ * Math.cos(this.yaw) - inputX * Math.sin(this.yaw);
    const running = this.held('run');
    const speed = running ? 3.8 : 2.25;
    const alpha = 1 - Math.exp(-12 * dt);
    this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, x * speed, alpha);
    this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, z * speed, alpha);

    const deltaX = this.velocity.x * dt;
    const deltaZ = this.velocity.z * dt;
    const previousX = this.position.x, previousZ = this.position.z;
    // The domain interface is required, not optional. This used to branch on
    // whether the world exposed `moveCircle`, with a hand-rolled overlap path
    // for "lightweight test/embedding worlds" — which meant the shipped
    // contract was whatever happened to be present at call time, and no test
    // ever exercised the fallback against a real world.
    const motion = this.world.moveCircle(
      this.position.x, this.position.z, deltaX, deltaZ,
      GEO_PLAYER_COLLISION_PROFILE.radius,
      GEO_PLAYER_COLLISION_PROFILE.skin,
      GEO_PLAYER_COLLISION_PROFILE.maxContacts,
      this.motionResult,
      GEO_PLAYER_COLLISION_PROFILE.maxDepenetration,
    );
    this.position.x = motion.x;
    this.position.z = motion.z;
    if (motion.hit && dt > 0) {
      this.velocity.x = motion.projectedX / dt;
      this.velocity.z = motion.projectedZ / dt;
    }

    if (this.grounded) {
      this.groundTransitionOptions.referenceY = this.position.y;
      const transition = this.world.resolveGroundStep(
        previousX, previousZ, this.position.x, this.position.z,
        this.groundTransitionOptions, this.groundTransitionResult,
      );
      if (!transition.accepted) {
        this.position.x = previousX;
        this.position.z = previousZ;
        this.velocity.x = 0;
        this.velocity.z = 0;
        this.position.y = transition.from.y;
      } else this.position.y = transition.to.y;
    }

    if (this.jumpQueued && this.grounded) {
      this.airborneSupportY = this.position.y;
      this.velocity.y = 1.65;
      this.grounded = false;
    }
    this.jumpQueued = false;
    if (!this.grounded) {
      this.velocity.y -= 5.2 * dt;
      this.position.y += this.velocity.y * dt;
      this.landingSupportOptions.referenceY = this.airborneSupportY;
      const groundY = this.world.supportAt(
        this.position.x, this.position.z, this.supportResult, this.landingSupportOptions,
      ).y;
      if (this.velocity.y <= 0 && this.position.y <= groundY) {
        this.position.y = groundY;
        this.velocity.y = 0;
        this.grounded = true;
        this.airborneSupportY = groundY;
      }
    }

    if (inputLength > .01) {
      const target = Math.atan2(x, z);
      const difference = Math.atan2(Math.sin(target - this.root.rotation.y), Math.cos(target - this.root.rotation.y));
      this.root.rotation.y += difference * (1 - Math.exp(-14 * dt));
    }
    this.root.position.copy(this.position);
  }

  updateCamera(dt, snap = false) {
    if (this.cameraMode === 'first-person') {
      this.cameraDesired.copy(this.position);
      this.cameraDesired.y += FIRST_PERSON_EYE_HEIGHT;
      this.camera.position.copy(this.cameraDesired);
      const horizontal = Math.cos(this.firstPersonPitch);
      this.lookDirection.set(
        -Math.sin(this.yaw) * horizontal,
        -Math.sin(this.firstPersonPitch),
        -Math.cos(this.yaw) * horizontal,
      );
      this.cameraTarget.copy(this.camera.position).add(this.lookDirection);
      this.camera.lookAt(this.cameraTarget);
      return;
    }

    this.cameraTarget.copy(this.position);
    this.cameraTarget.y += .12;
    this.cameraIdeal.set(
      Math.sin(this.yaw) * Math.cos(this.thirdPersonPitch) * this.distance,
      Math.sin(this.thirdPersonPitch) * this.distance,
      Math.cos(this.yaw) * Math.cos(this.thirdPersonPitch) * this.distance,
    ).add(this.cameraTarget);
    const cameraGround = this.world.supportAt(
      this.cameraIdeal.x, this.cameraIdeal.z, this.cameraSupportResult,
    ).y;
    this.cameraIdeal.y = Math.max(cameraGround + .3, this.cameraIdeal.y);
    this.cameraDesired.copy(this.cameraIdeal);
    const clip = this.world.clipCamera(
      this.cameraTarget,
      this.cameraDesired,
      cameraNearPlaneSweepRadius(this.camera),
      this.cameraClipResult,
    );
    const allowedDistance = this.cameraDesired.distanceTo(this.cameraTarget);
    if (snap || !Number.isFinite(this.cameraResolvedDistance)) {
      this.cameraResolvedDistance = allowedDistance;
    } else if (clip?.blocked) {
      // New obstruction compresses immediately so the previous frame's camera
      // cannot linger inside or behind a facade.
      this.cameraResolvedDistance = Math.min(this.cameraResolvedDistance, allowedDistance);
    } else {
      // Clear space recovers more slowly to prevent doorway/corner pumping.
      const recovery = 1 - Math.exp(-4 * Math.max(0, dt));
      this.cameraResolvedDistance = THREE.MathUtils.lerp(this.cameraResolvedDistance, allowedDistance, recovery);
    }
    this.lookDirection.copy(this.cameraIdeal).sub(this.cameraTarget).normalize();
    this.camera.position.copy(this.cameraTarget).addScaledVector(this.lookDirection, this.cameraResolvedDistance);
    this.camera.lookAt(this.cameraTarget);
  }

  update(dt) {
    if (this.enabled) {
      let remaining = Math.min(Math.max(dt, 0), .1);
      while (remaining > 1e-6) {
        const step = Math.min(remaining, 1 / 60);
        this.step(step);
        remaining -= step;
      }
    }
    this.updateCamera(dt);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.blur();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.input.dispose();
    document.removeEventListener('mousemove', this.mousemove);
    this.canvas.removeEventListener('mousedown', this.mousedown);
    this.canvas.removeEventListener('pointerdown', this.pointerdown);
    this.canvas.removeEventListener('pointermove', this.pointermove);
    this.canvas.removeEventListener('pointerup', this.pointerup);
    this.canvas.removeEventListener('pointercancel', this.pointerup);
    this.canvas.removeEventListener('wheel', this.wheel);
    this.root.removeFromParent();
    this.avatar.dispose?.();
    this.avatar.geometry.dispose();
    this.avatar.material.dispose();
    this.root.clear();
  }
}
