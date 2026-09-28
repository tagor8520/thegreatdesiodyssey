import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GEO_PLAYER_COLLISION_PROFILE } from './GeoCollision.js';
import { definePlayerDomain } from '../engine/DomainInterface.js';
import { actionCapabilitiesForDomain, createActionRegistry } from '../engine/ActionRegistry.js';

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

/**
 * `FND-08`: the coordinate avatar implements the same player-domain contract as
 * the curated adventurer (analog input, jump, pointer look, camera modes).
 */
export const GDO_COORDINATE_PLAYER_DOMAIN = definePlayerDomain({
  id: 'coordinate-player',
  label: 'Coordinate explorer avatar',
  worldId: 'coordinate',
  cameraModes: ['first-person', 'third-person'],
  capabilities: { analogInput: true, jump: true, pointerLook: true, touch: true },
});

export class GeoPlayer {
  constructor(scene, camera, canvas, world, { onCameraModeChange = () => {}, actions } = {}) {
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.world = world;
    this.onCameraModeChange = onCameraModeChange;
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
    this.playerDomain = GDO_COORDINATE_PLAYER_DOMAIN;
    // `GME-05`: the registry owns the action table, so this avatar accepts exactly
    // the keys a registered action declares instead of a hand-maintained list.
    this.actions = actions ?? createActionRegistry({ capabilities: actionCapabilitiesForDomain(GDO_COORDINATE_PLAYER_DOMAIN) });
    // `GME-05`: gameplay verbs plug in here instead of editing the key filter, so a
    // newly declared action is dispatchable the moment its handler is registered.
    this.actionHandlers = new Map();
    this.actionLog = [];
    this.unitsPerMetreScale = this.world?.domain?.unitsPerMetre ?? .1;
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

    this.keydown = event => {
      if (!this.enabled || event.ctrlKey || event.metaKey || event.altKey ||
          event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      const action = this.actions.keyboardBinding(event.code) ?? (event.code === 'KeyV' ? 'camera' : null);
      if (!action) return;
      // `GME-05`: desktop input follows the registry too, so a future action is
      // dispatchable from the keyboard the moment it is declared.
      const descriptor = this.actions.action(action);
      const handler = this.actionHandlers.get(action);
      if (handler) {
        event.preventDefault();
        if (event.repeat) return;
        const entry = Object.freeze({ id: action, code: event.code, phase: 'press' });
        this.actionLog.push(entry);
        if (this.actionLog.length > 8) this.actionLog.shift();
        handler(entry);
        return;
      }
      if (descriptor?.kind === 'tap') {
        event.preventDefault();
        if (event.repeat) return;
        if (action === 'camera') this.toggleCameraMode();
        else if (action === 'jump') this.jumpQueued = true;
        return;
      }
      event.preventDefault();
      this.keys.add(event.code);
    };
    this.keyup = event => this.keys.delete(event.code);
    this.blur = () => {
      this.keys.clear();
      this.virtual.clear();
      this.analogMove.x = 0;
      this.analogMove.z = 0;
      this.velocity.x = 0;
      this.velocity.z = 0;
      this.jumpQueued = false;
      this.lookPointerId = null;
    };
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

    window.addEventListener('keydown', this.keydown);
    window.addEventListener('keyup', this.keyup);
    window.addEventListener('blur', this.blur);
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

  querySnapshot() {
    return {
      domain: this.playerDomain.id,
      mode: this.cameraMode,
      position: { x: this.position.x, y: this.position.y, z: this.position.z },
      grounded: this.grounded,
      distance: this.cameraResolvedDistance,
    };
  }

  toggleCameraMode() {
    this.setCameraMode(this.cameraMode === 'first-person' ? 'third-person' : 'first-person', true);
    return this.cameraMode;
  }

  setMoveInput(x, z) {
    const length = Math.hypot(x, z);
    const scale = length > 1 ? 1 / length : 1;
    this.analogMove.x = x * scale;
    this.analogMove.z = z * scale;
  }

  setVirtualInput(action, active) {
    if (active) this.virtual.add(action);
    else this.virtual.delete(action);
    if (action === 'jump' && active && this.enabled) this.jumpQueued = true;
  }

  setPosition(x, z) {
    const groundY = this.world.supportAt?.(x, z, this.supportResult)?.y ?? 0;
    this.position.set(x, groundY, z);
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.airborneSupportY = groundY;
    this.root.position.copy(this.position);
    this.updateCamera(0, true);
  }

  /**
   * `GME-05`: an action's held state reads the registry binding unless the caller
   * passes explicit codes, so a rebound or newly declared key needs no editor.
   */
  held(action, ...codes) {
    const bound = codes.length ? codes : (this.actions.action(action)?.keyboard ?? []);
    return this.virtual.has(action) || bound.some(code => this.keys.has(code));
  }

  /** Plug behaviour into a registered action; throws for an unknown action id. */
  setActionHandler(id, handler) {
    if (!this.actions.has(id)) throw new RangeError(`Unknown action: ${id}`);
    if (typeof handler !== 'function') throw new TypeError(`Action handler for ${id} must be a function`);
    this.actionHandlers.set(id, handler);
    return () => { if (this.actionHandlers.get(id) === handler) this.actionHandlers.delete(id); };
  }

  /** Declared surfaces for the live action table, for the debug snapshot. */
  actionDiagnostics() {
    const diagnostics = this.actions.diagnostics();
    return Object.freeze({
      ...diagnostics,
      handlers: this.actionHandlers.size,
      recent: Object.freeze([...this.actionLog]),
    });
  }

  step(dt) {
    // `GME-05`: direction keys are filtered through the move action's declared
    // binding, so a rebind or a newly declared movement key needs no edit here.
    const moveKeys = this.actions.action('move')?.keyboard ?? [];
    const bound = codes => codes.filter(code => moveKeys.includes(code));
    let inputX = this.analogMove.x + Number(this.held('right', ...bound(['KeyD', 'ArrowRight']))) - Number(this.held('left', ...bound(['KeyA', 'ArrowLeft'])));
    let inputZ = this.analogMove.z + Number(this.held('back', ...bound(['KeyS', 'ArrowDown']))) - Number(this.held('forward', ...bound(['KeyW', 'ArrowUp'])));
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
    if (typeof this.world.moveCircle === 'function') {
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
    } else {
      // Compatibility path for lightweight test/embedding worlds that expose
      // only the original overlap query.
      const queryRadius = GEO_PLAYER_COLLISION_PROFILE.radius + GEO_PLAYER_COLLISION_PROFILE.skin;
      const nextX = this.position.x + deltaX;
      if (!this.world.collidesCircle(nextX, this.position.z, queryRadius)) this.position.x = nextX;
      else this.velocity.x = 0;
      const nextZ = this.position.z + deltaZ;
      if (!this.world.collidesCircle(this.position.x, nextZ, queryRadius)) this.position.z = nextZ;
      else this.velocity.z = 0;
    }

    if (this.grounded && typeof this.world.resolveGroundStep === 'function') {
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
    } else if (this.grounded && typeof this.world.supportAt === 'function') {
      this.position.y = this.world.supportAt(this.position.x, this.position.z, this.supportResult).y;
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
      const groundY = this.world.supportAt?.(
        this.position.x, this.position.z, this.supportResult, this.landingSupportOptions,
      )?.y ?? 0;
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
    const cameraGround = this.world.supportAt?.(
      this.cameraIdeal.x, this.cameraIdeal.z, this.cameraSupportResult,
    )?.y ?? 0;
    this.cameraIdeal.y = Math.max(cameraGround + .3, this.cameraIdeal.y);
    this.cameraDesired.copy(this.cameraIdeal);
    const clip = this.world.clipCamera?.(
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
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('keyup', this.keyup);
    window.removeEventListener('blur', this.blur);
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
