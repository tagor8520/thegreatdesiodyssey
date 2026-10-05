/**
 * FND-07 lifecycle instrumentation — the measurement half of the zero-growth
 * remount gate.
 *
 * The gate reads: "All workers, observers, textures, geometries and listeners
 * prove zero-growth remount." Proving it needs a definition of *live* that does
 * not depend on the garbage collector, because the collector runs when it
 * feels like it and a gate that waits for it is not a gate.
 *
 * Definition used here:
 *
 *   A subscription is LIVE when its target is still reachable from the page —
 *   `window`, `document`, a DOM node with `isConnected === true`, a worker that
 *   has not been terminated, or a socket that has not been closed.
 *
 * Subscriptions on detached nodes and terminated workers are reported as
 * ORPHANED and are not counted as growth. Two independent checks keep that from
 * being an assumption:
 *
 *   1. the DOM node count is asserted flat — if a detached subtree were really
 *      retained, the tree (or the mount host) would grow even before a collection;
 *   2. `releaseOrphanTargets()` drops the instrument's own references to those
 *      targets and `orphanRefsAlive()` reports, after a forced collection over
 *      CDP, how many the page still holds. Anything the app kept would show up
 *      there — the instrument cannot hide a real retention behind its own map,
 *      because the map entry is what it deletes first.
 *
 * React is the main producer of orphans: `react-dom` registers a large delegated
 * listener set on the root container, and a remount discards that container.
 *
 * Geometries and textures are measured by RELEASE, not by count. Three's
 * `renderer.info.memory` is per-renderer and is recreated by every mount, so it
 * cannot see across a remount. Attaching `dispose` listeners to the live objects
 * and requiring every one of them to fire on exit is the property that matters:
 * it is the actual ownership contract between the mount and its resources.
 */

/** Runs in the page before any application module. Counts from birth. */
export function lifecycleInstrument() {
  const state = {
    workers: { created: 0, terminated: 0 },
    observers: { created: 0, disconnected: 0 },
    listeners: { added: 0, removed: 0, live: new Map() },
  };
  globalThis.__gdoLifecycle = state;

  const NativeWorker = globalThis.Worker;
  if (NativeWorker) {
    globalThis.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        state.workers.created++;
        this.__gdoAlive = true;
        const terminate = this.terminate.bind(this);
        this.terminate = () => {
          if (this.__gdoAlive) { this.__gdoAlive = false; state.workers.terminated++; }
          return terminate();
        };
      }
    };
  }

  for (const name of ['WebSocket']) {
    const Native = globalThis[name];
    if (!Native) continue;
    globalThis[name] = class extends Native {
      constructor(...args) {
        super(...args);
        this.__gdoAlive = true;
        const close = this.close.bind(this);
        this.close = (...closeArgs) => { this.__gdoAlive = false; return close(...closeArgs); };
      }
    };
  }

  for (const name of ['ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'PerformanceObserver']) {
    const Native = globalThis[name];
    if (!Native) continue;
    globalThis[name] = class extends Native {
      constructor(...args) {
        super(...args);
        state.observers.created++;
        this.__gdoAlive = true;
        const disconnect = this.disconnect?.bind(this);
        if (disconnect) {
          this.disconnect = () => {
            if (this.__gdoAlive) { this.__gdoAlive = false; state.observers.disconnected++; }
            return disconnect();
          };
        }
      }
    };
  }

  const targetId = target => {
    if (!target.__gdoListenerId) {
      Object.defineProperty(target, '__gdoListenerId', {
        value: Math.random().toString(36).slice(2), enumerable: false,
      });
    }
    return target.__gdoListenerId;
  };
  const describeTarget = target => {
    if (target === globalThis) return 'window';
    if (target === globalThis.document) return 'document';
    const name = target?.constructor?.name ?? typeof target;
    const tag = target?.tagName ? target.tagName.toLowerCase() : '';
    const cls = typeof target?.className === 'string' && target.className
      ? `.${target.className.split(/\s+/)[0]}` : '';
    const id = target?.id ? `#${target.id}` : '';
    return `${name}(${tag}${id}${cls})`;
  };

  // Handler identity lives in a WeakMap rather than as a property on the handler:
  // application handlers must not be mutated by the audit, and identity has to
  // match exactly between add and remove for a removal to cancel an addition.
  const handlerIds = new WeakMap();
  const handlerId = handler => {
    if (handler === null || (typeof handler !== 'object' && typeof handler !== 'function')) return String(handler);
    let id = handlerIds.get(handler);
    if (!id) { id = Math.random().toString(36).slice(2); handlerIds.set(handler, id); }
    return id;
  };

  const proto = globalThis.EventTarget?.prototype;
  if (proto) {
    const nativeAdd = proto.addEventListener;
    const nativeRemove = proto.removeEventListener;
    proto.addEventListener = function (type, handler, options) {
      const stack = (new Error().stack ?? '').split('\n')
        .map(line => line.trim())
        .filter(line => /^\s*at /.test(line) && !/lifecycle\.mjs|addEventListener|EventListener/.test(line));
      state.listeners.added++;
      state.listeners.live.set(`${targetId(this)}|${type}|${handlerId(handler)}`, {
        type, target: this, label: describeTarget(this),
        caller: (stack[0] ?? '?').replace(/^at\s+/, ''), options,
      });
      return nativeAdd.call(this, type, handler, options);
    };
    proto.removeEventListener = function (type, handler, options) {
      state.listeners.removed++;
      state.listeners.live.delete(`${targetId(this)}|${type}|${handlerId(handler)}`);
      return nativeRemove.call(this, type, handler, options);
    };
  }
}

/**
 * Classifies the live subscription map and counts resources owned by the mounted
 * game. Runs in the page.
 */
export function lifecycleSnapshot() {
  const game = globalThis.__gdoAudit?.game ?? null;
  const state = globalThis.__gdoLifecycle;
  const persistent = [];
  const orphaned = [];
  for (const entry of state.listeners.live.values()) {
    const target = entry.target;
    const reachable = target === globalThis || target === globalThis.document ||
      target?.isConnected === true || target?.__gdoAlive === true;
    (reachable ? persistent : orphaned).push(`${entry.type} on ${entry.label} <- ${entry.caller}`);
  }
  const disposal = globalThis.__gdoDisposal ?? null;
  return {
    mounted: Boolean(game),
    workers: state.workers.created - state.workers.terminated,
    observers: state.observers.created - state.observers.disconnected,
    listenersPersistent: persistent.length,
    listenersOrphaned: orphaned.length,
    persistentDetail: persistent.sort(),
    orphanedDetail: orphaned.sort(),
    geometries: disposal?.geometries ?? null,
    textures: disposal?.textures ?? null,
    released: disposal?.released() ?? null,
    outstanding: disposal?.outstanding() ?? null,
    domNodes: document.querySelectorAll('*').length,
    // The mount host's own subtree: the DOM the lifecycle owner is responsible
    // for. `domNodes` above includes <head>, where the bundler injects stylesheets.
    hostNodes: document.querySelector('#reference-game')?.querySelectorAll('*').length ?? 0,
    canvases: document.querySelector('#reference-game')?.querySelectorAll('canvas').length ?? 0,
    rendererMemory: game?.renderer ? { ...game.renderer.info.memory } : null,
  };
}

/** Arms dispose counting over every geometry/texture the mounted scene owns. */
export function armDisposal() {
  const game = globalThis.__gdoAudit?.game;
  const scene = game?.scene;
  if (!scene) return { error: 'no mounted scene' };
  const geometries = new Set();
  const textures = new Set();
  const record = new Set();
  let released = 0;
  const watch = resource => {
    if (!resource || record.has(resource)) return;
    record.add(resource);
    resource.addEventListener('dispose', () => { record.delete(resource); released++; });
  };
  scene.traverse(object => {
    if (object.geometry) { geometries.add(object.geometry); watch(object.geometry); }
    const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
    for (const material of list) {
      for (const value of Object.values(material)) if (value?.isTexture) { textures.add(value); watch(value); }
      for (const uniform of Object.values(material.uniforms ?? {})) {
        if (uniform?.value?.isTexture) { textures.add(uniform.value); watch(uniform.value); }
      }
    }
  });
  // Textures owned by the shared material library are mounted-scene resources too.
  for (const value of Object.values(game?.materialLibrary?.textures ?? {})) {
    if (value?.isTexture) { textures.add(value); watch(value); }
  }
  globalThis.__gdoDisposal = {
    geometries: geometries.size, textures: textures.size,
    released: () => released, outstanding: () => record.size,
  };
  return { geometries: geometries.size, textures: textures.size };
}

/**
 * Deletes the instrument's references to orphaned targets and returns WeakRefs to
 * a sample, so a forced collection can say whether anything else still holds them.
 */
export function releaseOrphanTargets(limit = 6) {
  // Defined inline: `page.evaluate` serialises this function alone, so nothing from
  // module scope is available while it runs in the page.
  const describe = target => {
    const name = target?.constructor?.name ?? typeof target;
    const tag = target?.tagName ? target.tagName.toLowerCase() : '';
    const id = target?.id ? `#${target.id}` : '';
    const cls = typeof target?.className === 'string' && target.className
      ? `.${target.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')}` : '';
    const reactKeys = target && typeof target === 'object'
      ? Object.keys(target).filter(key => key.startsWith('__react')).length : 0;
    return `${name}(${tag}${id}${cls})${reactKeys ? ` [react keys:${reactKeys}]` : ''} connected=${target?.isConnected}`;
  };
  const state = globalThis.__gdoLifecycle;
  const sample = new Set();
  const refs = [];
  for (const [key, entry] of [...state.listeners.live]) {
    const target = entry.target;
    const reachable = target === globalThis || target === globalThis.document ||
      target?.isConnected === true || target?.__gdoAlive === true;
    if (reachable) continue;
    state.listeners.live.delete(key);
    if (!sample.has(target) && refs.length < limit) {
      sample.add(target);
      refs.push({ ref: new WeakRef(target), label: describe(target) });
    }
  }
  globalThis.__gdoOrphanRefs = refs;
  return refs.length;
}

/** How many sampled orphan targets survived a forced collection, and which. */
export function orphanRefsAlive() {
  const refs = globalThis.__gdoOrphanRefs ?? [];
  return {
    sampled: refs.length,
    retained: refs.filter(entry => entry.ref.deref() !== undefined).length,
    retainedDetail: refs.filter(entry => entry.ref.deref() !== undefined).map(entry => entry.label),
  };
}

/** Reads back the subscribers that were still attached after a teardown. */
export function orphanDetail(list) {
  const counts = new Map();
  for (const entry of list) counts.set(entry, (counts.get(entry) ?? 0) + 1);
  return [...counts].map(([entry, count]) => `${count}x ${entry}`).slice(0, 8);
}
