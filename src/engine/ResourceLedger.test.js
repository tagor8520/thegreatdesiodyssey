import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyCompilation } from '../geo/GeoTestSupport.js';
import { compileGeoFixture } from '../geo/GeoFixtures.js';
import { FlexibleJoystick } from '../geo/GeoControls.js';
import { GeoPlayer } from '../geo/GeoPlayer.js';
import { GeoWorld } from '../geo/GeoWorld.js';
import { armResourceDisposal, installResourceLedger } from './ResourceLedger.js';

/**
 * FND-07 gate: "All workers, observers, textures, geometries and listeners prove
 * zero-growth remount."
 *
 * These tests prove the classes Node can drive faithfully, across REPEAT mounts —
 * a single clean teardown is not the property the gate names. Textures and
 * observers cannot be reached here (both need a WebGL context), so they are proven
 * by the `remount-lifecycle` browser scenario, which measures all five classes
 * through the real product in both runtime modes.
 */

/** Records subscriptions so a terminated worker with listeners left behind is visible. */
class StubWorker {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  postMessage() {}
  terminate() {}
}

function mountFixtureTile(world, { fixture = 'provider-equivalence', variant = 'openmaptiles' } = {}) {
  const tile = [...world.tiles.values()][0];
  applyCompilation(world, tile, compileGeoFixture(fixture, variant));
  world._flushPlantMounts(0);
  return tile;
}

test('FND-07: a geo world remounts three times without growing a worker, listener, geometry or texture', () => {
  const ledger = installResourceLedger({ worker: StubWorker });
  const scene = new THREE.Scene();
  try {
    const baseline = ledger.snapshot();
    const cycles = [];
    for (let cycle = 1; cycle <= 3; cycle++) {
      const world = new GeoWorld(scene, { latitude: 28.9845, longitude: 77.7064 });
      const tile = mountFixtureTile(world);
      // Arm after the mount so the count covers exactly what this mount owns.
      const disposal = armResourceDisposal(world.root);
      assert.ok(disposal.geometries > 0, `cycle ${cycle}: the mount must own geometry for the proof to mean anything`);
      assert.deepEqual(ledger.workerSubscriptions(), { total: 2, onLiveWorkers: 2, onTerminatedWorkers: 0 });

      world.dispose();

      // Worker: terminated, and its message/error channels released with it.
      // `listeners` is a Map of event type -> handler set, so the size that
      // matters is the handler total, not the number of types ever seen.
      const stubHandlers = [...world.worker.listeners.values()].reduce((total, set) => total + set.size, 0);
      assert.equal(stubHandlers, 0,
        `cycle ${cycle}: worker subscriptions must be removed on dispose, not left on the terminated worker`);
      assert.deepEqual(ledger.workerSubscriptions(), { total: 0, onLiveWorkers: 0, onTerminatedWorkers: 0 },
        `cycle ${cycle}: disposal must release every worker subscription`);
      // Geometry/texture: ownership, not count — every armed resource was released.
      assert.equal(disposal.outstanding(), 0,
        `cycle ${cycle}: undisposed after teardown — ${disposal.outstandingDetail().join(', ')}`);
      assert.equal(disposal.released(), disposal.armed, `cycle ${cycle}: every armed resource must fire dispose`);
      assert.equal(world.root.children.length, 0, `cycle ${cycle}: the world root must be empty`);
      assert.equal(world.totalBytes, 0, `cycle ${cycle}: tile storage must be released`);
      cycles.push({ snapshot: ledger.snapshot(), disposal, tile });
    }

    // Growth across cycles is the assertion: the third mount may not hold more
    // resources than the first one did.
    const first = cycles[0], last = cycles.at(-1);
    assert.equal(last.snapshot.workersLive, first.snapshot.workersLive, 'live workers must not accumulate');
    assert.equal(last.snapshot.listenersLive, first.snapshot.listenersLive, 'live listeners must not accumulate');
    assert.equal(last.snapshot.observersLive, first.snapshot.observersLive, 'live observers must not accumulate');
    assert.equal(last.disposal.armed, first.disposal.armed, 'a remount must own the same resource footprint');
    assert.equal(ledger.state.workers.created, 3, 'each remount constructs exactly one worker');
    assert.equal(ledger.state.workers.terminated, 3, 'each remount terminates exactly one worker');
    // No net listener growth over the whole run, not just at the end of a cycle.
    assert.equal(ledger.snapshot().listenersLive, baseline.listenersLive,
      `live listeners after three remounts: ${ledger.liveListeners().join(', ') || '(none)'}`);
  } finally {
    scene.clear();
    ledger.restore();
  }
});

test('FND-07: a disposed world ignores a late worker message instead of reviving', () => {
  const ledger = installResourceLedger({ worker: StubWorker });
  try {
    const world = new GeoWorld(new THREE.Scene(), { latitude: 0, longitude: 0 });
    const tile = mountFixtureTile(world);
    const requestId = tile.requestId;
    const key = tile.key;
    world.dispose();
    // The handler is detached, so nothing observes this message; calling it
    // directly must still be inert rather than resurrecting disposed state.
    world._handleWorkerMessage({ type: 'tile-phase', phase: 'roads', requestId, key, bytes: 1, geometry: null });
    assert.equal(world.tiles.size, 0, 'a late message must not re-create tile state on a disposed world');
    assert.equal(world.root.children.length, 0, 'a late message must not re-attach geometry');
    assert.deepEqual(ledger.workerSubscriptions(), { total: 0, onLiveWorkers: 0, onTerminatedWorkers: 0 });
  } finally {
    ledger.restore();
  }
});

test('FND-07: input owners release every listener across three construct/dispose cycles', () => {
  const ledger = installResourceLedger({ worker: StubWorker });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  class Element extends EventTarget {
    constructor() {
      super();
      this.style = {};
      this.classList = { add() {}, remove() {} };
    }
    getBoundingClientRect() { return { left: 0, top: 0 }; }
    setPointerCapture() {}
  }
  try {
    const baseline = ledger.snapshot();
    for (let cycle = 1; cycle <= 3; cycle++) {
      const windowTarget = new EventTarget();
      const documentTarget = Object.assign(new EventTarget(), { pointerLockElement: null, exitPointerLock() {} });
      globalThis.window = windowTarget;
      globalThis.document = documentTarget;
      const canvas = Object.assign(new Element(), {
        width: 1280, height: 720, requestPointerLock() {}, setPointerCapture() {},
      });
      const camera = new THREE.PerspectiveCamera(65, 16 / 9, .1, 2000);
      const world = new GeoWorld(new THREE.Scene(), { latitude: 0, longitude: 0 });
      const player = new GeoPlayer(new THREE.Scene(), camera, canvas, world, { onCameraModeChange: () => {} });
      const joystick = new FlexibleJoystick(new Element(), new Element(), new Element(), () => {});

      const attached = ledger.snapshot().listenersLive - baseline.listenersLive;
      assert.ok(attached >= 10,
        `cycle ${cycle}: the inputs must attach their pointer/keyboard listeners (attached ${attached})`);

      // `GeoPlayer.dispose()` runs the pointer-lock and key handlers teardown;
      // `FlexibleJoystick.dispose()` runs the five pointer teardowns on the zone.
      player.dispose();
      joystick.dispose();
      world.dispose();

      assert.equal(ledger.snapshot().listenersLive, baseline.listenersLive,
        `cycle ${cycle}: listeners left attached — ${ledger.liveListeners().join(', ')}`);
    }
    assert.equal(ledger.snapshot().workersLive, 0, 'no worker may outlive its world');
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    ledger.restore();
  }
});
