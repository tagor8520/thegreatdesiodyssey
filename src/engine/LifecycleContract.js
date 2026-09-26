/**
 * `FND-07` shared lifecycle/disposal contract.
 *
 * Every runtime owner (engine, game, world, pools, workers) registers what it
 * creates in one ledger. A ledger knows the kind, the stable name, the owning
 * label, and the exact release function for each resource, so teardown is
 * deterministic and remount growth is measurable instead of asserted.
 *
 * This module intentionally has no `three` and no DOM import: the same contract
 * runs in the browser, in the tile worker, and under `node --test`.
 */

export const LIFECYCLE_NAMESPACE = 'gdo:lifecycle:v1';

/** Bounded resource kinds. Anything else is rejected so typos cannot invent budgets. */
export const LIFECYCLE_KINDS = Object.freeze([
  'worker',
  'listener',
  'observer',
  'timer',
  'frame',
  'geometry',
  'material',
  'texture',
  'mesh',
  'node',
  'pool',
  'handle',
]);

const KIND_SET = new Set(LIFECYCLE_KINDS);

let nextLedgerId = 1;

function isFunction(value) {
  return typeof value === 'function';
}

function normaliseKind(kind) {
  const value = String(kind ?? '').trim();
  if (!KIND_SET.has(value)) {
    throw new Error(`Unknown lifecycle resource kind "${kind}" (expected one of ${LIFECYCLE_KINDS.join(', ')})`);
  }
  return value;
}

function emptyCounts() {
  const counts = Object.create(null);
  for (const kind of LIFECYCLE_KINDS) counts[kind] = 0;
  return counts;
}

/**
 * One owner-scoped resource registry. Owners nest: a world ledger is a child of
 * the game ledger, so a game snapshot already contains every world resource.
 */
export class LifecycleLedger {
  constructor({ label = 'root', namespace = LIFECYCLE_NAMESPACE } = {}) {
    this.id = nextLedgerId++;
    this.label = String(label);
    this.namespace = namespace;
    this.parent = null;
    this.children = new Set();
    this.entries = new Map();
    this.order = 0;
    this.disposed = false;
    this.released = 0;
    this.rejections = 0;
  }

  child(label) {
    const ledger = new LifecycleLedger({ label, namespace: this.namespace });
    ledger.parent = this;
    this.children.add(ledger);
    return ledger;
  }

  /**
   * Registers one owned resource. `dispose` runs on release when supplied, and
   * a throwing disposer is contained: teardown must never abort halfway.
   */
  own(kind, name, resource = null, dispose = null) {
    const entry = {
      id: this.order++,
      kind: normaliseKind(kind),
      name: String(name ?? kind),
      label: this.label,
      resource,
      dispose: isFunction(dispose) ? dispose : null,
      released: false,
      failures: 0,
    };
    this.entries.set(entry.id, entry);
    const ledger = this;
    return {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      ledger,
      get released() { return entry.released; },
      release() { return ledger._release(entry); },
    };
  }

  /**
   * Symmetric listener ownership: release removes the exact handler it added.
   * The contract never installs a handler it cannot remove. A host that offers no
   * complete event API (a degraded double or a missing browser feature) is
   * counted as `degraded` instead of crashing the mount, and nothing is attached.
   */
  listener(target, type, handler, options = undefined) {
    const canAdd = typeof target?.addEventListener === 'function';
    const canRemove = typeof target?.removeEventListener === 'function';
    if (!canAdd || !canRemove) {
      this.degraded = (this.degraded ?? 0) + 1;
      return {
        id: null, kind: 'listener', name: `${type}:degraded`, ledger: this,
        target, type, handler, degraded: true, released: false,
        release() { return false; },
      };
    }
    target.addEventListener(type, handler, options);
    const handle = this.own('listener', String(type), target, () => {
      target.removeEventListener(type, handler, options);
    });
    return { ...handle, target, type, handler, degraded: false };
  }

  observer(instance, name = 'observer') {
    if (!instance || !isFunction(instance.disconnect)) {
      this.rejections++;
      throw new Error(`Cannot own "${name}": observers must expose disconnect()`);
    }
    return this.own('observer', name, instance, () => instance.disconnect());
  }

  /** Cancels an animation frame, interval, or timeout handle on release. */
  timer(kind, handle, cancel, name = kind) {
    if (!isFunction(cancel)) {
      this.rejections++;
      throw new Error(`Cannot own "${name}": timers need an explicit cancel function`);
    }
    return this.own(kind, name, handle, () => cancel(handle));
  }

  worker(worker, name = 'worker') {
    if (!worker || !isFunction(worker.terminate)) {
      this.rejections++;
      throw new Error(`Cannot own "${name}": workers must expose terminate()`);
    }
    return this.own('worker', name, worker, () => worker.terminate());
  }

  /** Borrowed, reference-counted handles (materials, caches) release through their own API. */
  handle(name, dispose, resource = null) {
    return this.own('handle', name, resource, dispose);
  }

  _release(entry) {
    if (entry.released) return false;
    entry.released = true;
    this.released++;
    if (entry.dispose) {
      try {
        entry.dispose(entry.resource);
      } catch (error) {
        entry.failures++;
        this.failures = (this.failures ?? 0) + 1;
        this.lastFailure = `${entry.kind}:${entry.name}: ${error?.message || error}`;
      }
    }
    return true;
  }

  /** Releases this ledger's own entries and every descendant, newest first. */
  disposeAll() {
    let released = 0;
    for (const child of [...this.children].reverse()) released += child.disposeAll();
    const entries = [...this.entries.values()].sort((a, b) => b.id - a.id);
    for (const entry of entries) if (this._release(entry)) released++;
    this.disposed = true;
    return released;
  }

  counts() {
    const counts = emptyCounts();
    for (const entry of this.entries.values()) if (!entry.released) counts[entry.kind]++;
    for (const child of this.children) {
      const childCounts = child.counts();
      for (const kind of LIFECYCLE_KINDS) counts[kind] += childCounts[kind];
    }
    return counts;
  }

  liveEntries({ kinds = null } = {}) {
    const output = [];
    for (const entry of this.entries.values()) {
      if (entry.released) continue;
      if (kinds && !kinds.includes(entry.kind)) continue;
      output.push({ id: entry.id, kind: entry.kind, name: entry.name, label: entry.label, failures: entry.failures });
    }
    for (const child of this.children) output.push(...child.liveEntries({ kinds }));
    return output;
  }

  /** Right after `disposeAll()`, every remaining live entry is a real leak. */
  leaks() {
    if (!this.disposed) return [];
    return this.liveEntries();
  }

  snapshot({ entries = false } = {}) {
    const counts = this.counts();
    let total = 0;
    for (const kind of LIFECYCLE_KINDS) total += counts[kind];
    let released = this.released, failures = this.failures ?? 0, degraded = this.degraded ?? 0;
    let disposed = this.disposed;
    for (const child of this.children) {
      const childSnapshot = child.snapshot();
      released += childSnapshot.released;
      failures += childSnapshot.failures;
      degraded += childSnapshot.degraded;
      disposed &&= childSnapshot.disposed;
    }
    const snapshot = {
      namespace: this.namespace,
      label: this.label,
      disposed,
      total,
      counts,
      released,
      failures,
      degraded,
    };
    if (entries) snapshot.entries = this.liveEntries();
    return snapshot;
  }

  describe() {
    const snapshot = this.snapshot();
    const live = LIFECYCLE_KINDS
      .filter(kind => snapshot.counts[kind] > 0)
      .map(kind => `${kind} ${snapshot.counts[kind]}`);
    return `${this.label}: ${snapshot.total} live${live.length ? ` (${live.join(', ')})` : ''} · ${snapshot.released} released`
      + (snapshot.failures ? ` · ${snapshot.failures} disposer failures` : '');
  }
}

/**
 * Registers a pool's or owner's fixed resources in one labelled child scope.
 * Pools, worlds, and engines share the exact same call so growth is comparable
 * between them.
 */
export function adoptPoolResources(ledger, name, {
  geometries = null,
  material = null,
  meshes = null,
  node = null,
  extra = null,
} = {}) {
  if (!ledger) return null;
  const scope = ledger.child(String(name));
  const own = (kind, items, dispose) => {
    const list = Array.isArray(items) ? items : (items ? [items] : []);
    list.forEach((item, index) => {
      if (!item) return;
      const suffix = list.length > 1 ? `:${index}` : '';
      scope.own(kind, `${name}:${kind}${suffix}`, item, dispose);
    });
  };
  own('geometry', geometries, item => item.dispose?.());
  if (material) scope.own('material', `${name}:material`, material, item => item.dispose?.());
  own('mesh', meshes, item => item.removeFromParent?.());
  if (node) scope.own('node', `${name}:node`, node, item => item.removeFromParent?.());
  if (typeof extra === 'function') extra(scope);
  return scope;
}

/** Per-kind difference between two snapshots, used by every growth assertion. */
export function lifecycleSnapshotDelta(before, after) {
  const delta = {};
  for (const kind of LIFECYCLE_KINDS) {
    const difference = (after.counts?.[kind] ?? 0) - (before.counts?.[kind] ?? 0);
    if (difference !== 0) delta[kind] = difference;
  }
  const totalDifference = (after.total ?? 0) - (before.total ?? 0);
  if (totalDifference !== 0) delta.total = totalDifference;
  return delta;
}

export function lifecycleSnapshotEqual(first, second) {
  return Object.keys(lifecycleSnapshotDelta(first, second)).length === 0;
}

export function describeLifecycleSnapshot(snapshot) {
  const live = LIFECYCLE_KINDS
    .filter(kind => (snapshot.counts?.[kind] ?? 0) > 0)
    .map(kind => `${kind} ${snapshot.counts[kind]}`);
  return `${snapshot.label}: ${snapshot.total} live${live.length ? ` (${live.join(', ')})` : ''}`;
}

/**
 * Mount/unmount the same owner `cycles` times and compare idle samples. Any
 * counter that drifts between idle cycles is a lifecycle defect, not noise.
 */
export function runLifecycleAudit({
  cycles = 3,
  mount,
  unmount,
  sample,
  describe = null,
  label = 'lifecycle-audit',
}) {
  if (!isFunction(mount) || !isFunction(unmount) || !isFunction(sample)) {
    throw new Error('runLifecycleAudit needs mount, unmount, and sample functions');
  }
  const idleSamples = [];
  const mountedSamples = [];
  const baseline = { ...sample() };
  idleSamples.push(baseline);
  for (let index = 0; index < cycles; index++) {
    let mountError = null;
    try {
      mount(index);
    } catch (error) {
      mountError = error?.message || String(error);
    }
    mountedSamples.push({ ...sample() });
    try {
      unmount(index);
    } catch (error) {
      mountError ??= `unmount: ${error?.message || error}`;
    }
    idleSamples.push({ ...sample() });
    if (mountError) {
      return {
        namespace: LIFECYCLE_NAMESPACE,
        label,
        cycles: index + 1,
        ok: false,
        detail: mountError,
        baseline,
        idleSamples,
        mountedSamples,
        growth: [],
      };
    }
  }
  const keys = new Set(idleSamples.flatMap(item => Object.keys(item)));
  const growth = [];
  for (const key of [...keys].sort()) {
    const first = idleSamples[0]?.[key];
    const last = idleSamples[idleSamples.length - 1]?.[key];
    if (typeof first !== 'number' || typeof last !== 'number') continue;
    if (first !== last) growth.push({ key, first, last, delta: last - first });
  }
  const peakGrowth = [];
  const worstMounted = mountedSamples[mountedSamples.length - 1] ?? {};
  for (const key of [...keys].sort()) {
    const first = baseline?.[key];
    const last = worstMounted?.[key];
    if (typeof first !== 'number' || typeof last !== 'number') continue;
    peakGrowth.push({ key, idle: first, mounted: last, delta: last - first });
  }
  const report = {
    namespace: LIFECYCLE_NAMESPACE,
    label,
    cycles,
    ok: growth.length === 0,
    growth,
    baseline,
    idleSamples,
    mountedSamples,
    peakGrowth,
    released: idleSamples.map(item => item.released ?? 0),
  };
  report.detail = report.ok
    ? `${cycles} mount/unmount cycles returned to the same ${Object.keys(baseline).length} idle counters`
    : `growth after ${cycles} cycles: ${growth.map(item => `${item.key} ${item.first}→${item.last}`).join(', ')}`;
  if (describe) report.described = describe(report);
  return report;
}

/** Bounded per-profile live-resource ceiling shared by every owner. */
export function lifecycleCountsWithinCeiling(counts, ceiling) {
  const violations = [];
  for (const kind of LIFECYCLE_KINDS) {
    const limit = ceiling?.[kind];
    if (limit == null) continue;
    if ((counts[kind] ?? 0) > limit) violations.push({ kind, value: counts[kind], limit });
  }
  const total = LIFECYCLE_KINDS.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
  if (ceiling?.total != null && total > ceiling.total) violations.push({ kind: 'total', value: total, limit: ceiling.total });
  return { ok: violations.length === 0, total, violations };
}
