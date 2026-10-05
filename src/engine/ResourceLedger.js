/**
 * Resource ledger — test support for the FND-07 lifecycle/disposal contract.
 *
 * The gate reads: "All workers, observers, textures, geometries and listeners
 * prove zero-growth remount." Each of those five classes fails differently, so
 * each needs a different instrument:
 *
 *   workers     counted by constructing a tracking subclass; `terminate()` is the
 *               release event. Per-worker subscriptions are recorded too, because
 *               a worker whose listeners outlive it is exactly the defect this
 *               gate was written to catch.
 *   observers   same shape, with `disconnect()` as the release event.
 *   listeners   every EventTarget subscription is recorded on add and cleared on
 *               remove, keyed by target + type + handler identity, so a real
 *               removal cancels a real addition. Counts are NET, not cumulative:
 *               a class that removes what it adds shows zero.
 *   geometries  measured by release, not by count. `renderer.info.memory` is
 *   textures    per-renderer and a remount creates a new renderer, so a metric
 *               that counts objects cannot see across the boundary. Attaching
 *               dispose listeners to the owned objects and requiring all of them
 *               to fire is the ownership property that actually matters.
 *
 * Scope note: this covers what Node can drive faithfully — the geo world, its
 * worker, the pooled owners, and the input owners via the EventTarget shims the
 * existing tests already use. Textures and observers are proven end-to-end in the
 * `remount-lifecycle` visual scenario, which runs the real product in a browser
 * (`npm run visual:audit -- remount-lifecycle`).
 *
 * Test-only: imported by `*.test.js` files and never reachable from a Vite entry
 * point.
 */

/** Wraps a Worker base class so construction, termination and subscriptions count. */
function trackedWorker(Base) {
  return class TrackedWorker extends Base {
    constructor(...args) {
      super(...args);
      this.__trackedAlive = true;
      this.__trackedListeners = new Map();
    }
    addEventListener(type, handler, options) {
      const set = this.__trackedListeners.get(type) ?? new Set();
      set.add(handler);
      this.__trackedListeners.set(type, set);
      return super.addEventListener?.(type, handler, options);
    }
    removeEventListener(type, handler, options) {
      this.__trackedListeners.get(type)?.delete(handler);
      return super.removeEventListener?.(type, handler, options);
    }
    terminate() {
      if (this.__trackedAlive) { this.__trackedAlive = false; globalThis.__gdoResourceLedger.workers.terminated++; }
      return super.terminate?.();
    }
  };
}

function trackedObserver(Base) {
  return class TrackedObserver extends Base {
    constructor(...args) {
      super(...args);
      this.__trackedAlive = true;
      globalThis.__gdoResourceLedger.observers.created++;
    }
    disconnect() {
      if (this.__trackedAlive) { this.__trackedAlive = false; globalThis.__gdoResourceLedger.observers.disconnected++; }
      return super.disconnect?.();
    }
  };
}

/**
 * Installs the counting instruments. `options.worker` supplies the Worker base
 * class to wrap — tests pass their stub, so the stub the world constructs and the
 * stub the ledger counts are always the same class.
 */
export function installResourceLedger({ worker = globalThis.Worker, observers = true } = {}) {
  const state = {
    workers: { created: 0, terminated: 0, live: new Set(), all: new Set() },
    observers: { created: 0, disconnected: 0 },
    listeners: { added: 0, removed: 0, live: new Map() },
    originals: {
      Worker: globalThis.Worker,
      observers: {},
      addEventListener: null,
      removeEventListener: null,
    },
  };
  globalThis.__gdoResourceLedger = state;

  if (worker && typeof worker === 'function') {
    const Tracked = trackedWorker(worker);
    globalThis.Worker = class extends Tracked {
      constructor(...args) {
        super(...args);
        state.workers.created++;
        state.workers.live.add(this);
        state.workers.all.add(this);
      }
      terminate() {
        state.workers.live.delete(this);
        return super.terminate();
      }
    };
  }

  if (observers) {
    for (const name of ['ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'PerformanceObserver']) {
      const Base = globalThis[name];
      if (!Base || typeof Base !== 'function') continue;
      state.originals.observers[name] = Base;
      globalThis[name] = trackedObserver(Base);
    }
  }

  const proto = globalThis.EventTarget?.prototype;
  if (proto) {
    const nativeAdd = proto.addEventListener;
    const nativeRemove = proto.removeEventListener;
    state.originals.addEventListener = nativeAdd;
    state.originals.removeEventListener = nativeRemove;
    // Handler identity lives in a WeakMap so application handlers are never
    // mutated by the instrument, and add/remove keys always agree.
    const handlerIds = new WeakMap();
    const handlerId = handler => {
      if (handler === null || (typeof handler !== 'object' && typeof handler !== 'function')) return String(handler);
      let id = handlerIds.get(handler);
      if (!id) { id = Symbol('handler'); handlerIds.set(handler, id); }
      return id;
    };
    const targetIds = new WeakMap();
    const targetId = target => {
      let id = targetIds.get(target);
      if (!id) { id = Symbol('target'); targetIds.set(target, id); }
      return id;
    };
    const listenKey = (target, type, handler) => `${String(targetId(target))}|${type}|${String(handlerId(handler))}`;
    proto.addEventListener = function (type, handler, options) {
      state.listeners.added++;
      state.listeners.live.set(listenKey(this, type, handler), { type, target: this, handler });
      return nativeAdd.call(this, type, handler, options);
    };
    proto.removeEventListener = function (type, handler, options) {
      state.listeners.removed++;
      state.listeners.live.delete(listenKey(this, type, handler));
      return nativeRemove.call(this, type, handler, options);
    };
  }

  return {
    get state() { return state; },
    snapshot() {
      return {
        workersLive: state.workers.live.size,
        workersCreated: state.workers.created,
        workersTerminated: state.workers.terminated,
        observersLive: state.observers.created - state.observers.disconnected,
        listenersLive: state.listeners.live.size,
        listenersAdded: state.listeners.added,
        listenersRemoved: state.listeners.removed,
      };
    },
    /**
     * Worker subscriptions, split by whether the worker still runs. A terminated
     * worker with listeners still attached is the FND-07 defect in miniature: the
     * resource is gone but the subscription was never released, leaving the
     * caller's handler reachable from a dead channel.
     */
    workerSubscriptions() {
      const count = workers => {
        let total = 0;
        for (const worker of workers) {
          for (const set of worker.__trackedListeners?.values() ?? []) total += set.size;
        }
        return total;
      };
      return {
        total: count(state.workers.all),
        onLiveWorkers: count(state.workers.live),
        onTerminatedWorkers: count([...state.workers.all].filter(worker => !worker.__trackedAlive)),
      };
    },
    /** Live subscription detail, for failure messages that name the culprit. */
    liveListeners() {
      return [...state.listeners.live.values()].map(entry =>
        `${entry.type} on ${entry.target?.constructor?.name ?? typeof entry.target}`);
    },
    restore() {
      if (proto) {
        proto.addEventListener = state.originals.addEventListener;
        proto.removeEventListener = state.originals.removeEventListener;
      }
      for (const [name, Base] of Object.entries(state.originals.observers)) globalThis[name] = Base;
      globalThis.Worker = state.originals.Worker;
      delete globalThis.__gdoResourceLedger;
    },
  };
}

/**
 * Arms release counting over every geometry, texture and material reachable from
 * `root` (a THREE.Object3D, or an iterable of them).
 */
export function armResourceDisposal(root) {
  const geometries = new Set();
  const textures = new Set();
  const materials = new Set();
  const outstanding = new Set();
  let released = 0;

  const watch = resource => {
    if (!resource || typeof resource.addEventListener !== 'function') return;
    if (outstanding.has(resource)) return;
    outstanding.add(resource);
    resource.addEventListener('dispose', () => { outstanding.delete(resource); released++; });
  };

  const roots = typeof root?.traverse === 'function' ? [root] : [...(root ?? [])];
  for (const node of roots) {
    if (typeof node?.traverse !== 'function') continue;
    node.traverse(object => {
      if (object.geometry) { geometries.add(object.geometry); watch(object.geometry); }
      const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      for (const material of list) {
        materials.add(material);
        watch(material);
        for (const value of Object.values(material)) if (value?.isTexture) { textures.add(value); watch(value); }
        for (const uniform of Object.values(material.uniforms ?? {})) {
          if (uniform?.value?.isTexture) { textures.add(uniform.value); watch(uniform.value); }
        }
      }
    });
  }

  return {
    geometries: geometries.size,
    textures: textures.size,
    materials: materials.size,
    armed: outstanding.size,
    released: () => released,
    outstanding: () => outstanding.size,
    outstandingDetail: () => [...outstanding].map(resource => `${resource.constructor?.name ?? 'resource'}:${resource.name || '(unnamed)'}`),
  };
}
