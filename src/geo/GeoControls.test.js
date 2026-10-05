import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FlexibleJoystick, normalizeJoystick, shouldUseTouchControls } from './GeoControls.js';
import { GeoPlayer } from './GeoPlayer.js';
import { createFlatDomain } from '../engine/FlatDomain.js';

test('mobile detection requires a mobile hint or touch-oriented device', () => {
  assert.equal(shouldUseTouchControls({
    navigator: { maxTouchPoints: 0, userAgent: 'Desktop' },
    screen: { width: 1920, height: 1080 },
    matchMedia: () => ({ matches: false }),
  }), false);
  assert.equal(shouldUseTouchControls({
    navigator: { maxTouchPoints: 5, userAgent: 'Desktop' },
    screen: { width: 800, height: 1280 },
    matchMedia: query => ({ matches: query === '(pointer: coarse)' }),
  }), true);
  assert.equal(shouldUseTouchControls({
    navigator: { maxTouchPoints: 1, userAgent: 'Mozilla/5.0 (iPhone; Mobile)' },
    screen: { width: 1170, height: 2532 },
    matchMedia: () => ({ matches: false }),
  }), true);
});

test('joystick normalization applies its dead zone, direction, and radius cap', () => {
  assert.deepEqual(normalizeJoystick(2, 2, 44), { x: 0, z: 0, magnitude: 0 });
  const right = normalizeJoystick(44, 0, 44);
  assert.equal(right.x, 1);
  assert.equal(right.z, 0);
  assert.equal(right.magnitude, 1);
  const capped = normalizeJoystick(0, -100, 44);
  assert.equal(capped.x, 0);
  assert.equal(capped.z, -1);
  assert.equal(capped.magnitude, 1);
});

test('coordinate explorer defaults to FPP and switches cleanly to TPP', () => {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  documentTarget.pointerLockElement = null;
  documentTarget.exitPointerLock = () => {};
  globalThis.window = windowTarget;
  globalThis.document = documentTarget;

  const canvas = new EventTarget();
  canvas.setPointerCapture = () => {};
  canvas.requestPointerLock = () => {};
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, 1, .02, 210);
  const modes = [];
  let blockCamera = false;
  // `FND-08`: this used to be a two-method object literal plus a compatibility
  // path inside `GeoPlayer`. The player now requires the domain interface, so
  // the double implements it.
  const world = createFlatDomain({
    clipCamera(target, desired, radius, out = {}) {
      assert.ok(radius >= .03 && radius <= .04);
      if (blockCamera) desired.lerpVectors(target, desired, .5);
      out.blocked = blockCamera;
      out.amount = blockCamera ? .5 : 1;
      out.time = out.amount;
      return out;
    },
  });
  const player = new GeoPlayer(scene, camera, canvas, world, {
    onCameraModeChange: mode => modes.push(mode),
  });
  try {
    assert.equal(player.cameraMode, 'first-person');
    assert.equal(player.avatar.visible, false);
    assert.equal(player.avatar.material.vertexColors, true);
    assert.equal(player.avatar.geometry.attributes.color.count, player.avatar.geometry.attributes.position.count);
    assert.equal(camera.fov, 68);
    assert.ok(Math.abs(camera.position.y - .18) < 1e-9);
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    assert.ok(direction.z < -.999);
    player.enabled = true;
    player.setMoveInput(0, -1);
    player.update(.1);
    assert.ok(player.position.z < 0, 'upward joystick input should move forward');
    player.setMoveInput(0, 0);

    assert.equal(player.toggleCameraMode(), 'third-person');
    assert.equal(player.avatar.visible, true);
    assert.equal(camera.fov, 52);
    assert.ok(camera.position.z > 0);
    const clearDistance = camera.position.distanceTo(player.cameraTarget);
    blockCamera = true;
    player.updateCamera(.016);
    const compressedDistance = camera.position.distanceTo(player.cameraTarget);
    assert.ok(compressedDistance < clearDistance * .51, 'new obstruction should compress the camera immediately');
    blockCamera = false;
    player.updateCamera(.1);
    const recoveringDistance = camera.position.distanceTo(player.cameraTarget);
    assert.ok(recoveringDistance > compressedDistance && recoveringDistance < clearDistance,
      'clear space should recover outward more slowly');
    assert.deepEqual(modes, ['first-person', 'third-person']);
  } finally {
    player.dispose();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});

test('coordinate player snaps to shared support and rejects an invalid ground transition', () => {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { pointerLockElement: null, exitPointerLock() {} });
  const canvas = Object.assign(new EventTarget(), { setPointerCapture() {}, requestPointerLock() {} });
  let rejectTransition = false;
  let landingReference = Number.NaN;
  const support = (x, z, out = {}, options = {}) => {
    if (Number.isFinite(options.referenceY)) landingReference = options.referenceY;
    return Object.assign(out, {
      x, z, y: .12 + z * .01, normalX: 0, normalY: 1, normalZ: 0,
      slopeRadians: 0, walkable: true, kind: 'terrain', physicalLevel: 0,
    });
  };
  const world = {
    supportAt: support,
    resolveGroundStep(fromX, fromZ, toX, toZ, options, out = {}) {
      out.from = support(fromX, fromZ, out.from ?? {});
      out.to = support(toX, toZ, out.to ?? {});
      out.accepted = !rejectTransition;
      out.reason = rejectTransition ? 'slope' : 'accepted';
      return out;
    },
    moveCircle(x, z, dx, dz, radius, skin, contacts, out = {}) {
      return Object.assign(out, { x: x + dx, z: z + dz, hit: false, projectedX: dx, projectedZ: dz });
    },
    clipCamera(target, desired, radius, out = {}) {
      out.blocked = false; out.amount = 1; out.time = 1;
      return Object.assign(out, { normalX: 0, normalY: 1, normalZ: 0 });
    },
    readDiagnostics() { return {}; },
  };
  const player = new GeoPlayer(new THREE.Scene(), new THREE.PerspectiveCamera(), canvas, world);
  try {
    player.setPosition(0, 0);
    assert.equal(player.position.y, .12);
    player.enabled = true;
    player.setMoveInput(0, -1);
    player.update(.1);
    assert.ok(player.position.z < 0);
    assert.ok(Math.abs(player.position.y - (.12 + player.position.z * .01)) < 1e-9);
    const before = player.position.clone();
    rejectTransition = true;
    player.update(1 / 60);
    assert.equal(player.position.x, before.x);
    assert.equal(player.position.z, before.z);

    rejectTransition = false;
    player.setMoveInput(0, 0);
    const launchSupport = player.position.y;
    player.setVirtualInput('jump', true);
    player.setVirtualInput('jump', false);
    player.update(1 / 120);
    assert.equal(player.grounded, false);
    assert.ok(Math.abs(landingReference - launchSupport) < 1e-9,
      'airborne support queries should retain the launch level under stacked roads');
  } finally {
    player.dispose();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});

test('flexible joystick disposes listeners and resets movement', () => {
  class Element extends EventTarget {
    constructor() {
      super();
      this.style = {};
      this.classList = { add() {}, remove() {} };
    }
    getBoundingClientRect() { return { left: 0, top: 0 }; }
    setPointerCapture() {}
  }
  const values = [];
  const joystick = new FlexibleJoystick(new Element(), new Element(), new Element(), (x, z) => values.push([x, z]));
  joystick.dispose();
  assert.deepEqual(values.at(-1), [0, 0]);
});
