/**
 * `FND-07` programmatic verification surface.
 *
 * Browser capture is not a project dependency. Instead every runtime exposes one
 * scripted debug hook (`window.__gdo`) plus a bounded lifecycle logger, so any
 * claim about moving behaviour can be read back as numbers from a console, a
 * test, or an unattended audit run.
 *
 * No `three` and no DOM import: the module works in Node tests and in a page.
 */

export const GDO_DEBUG_HOOK_KEY = '__gdo';
export const GDO_DEBUG_VERSION = 'gdo:debugHooks:v1';
export const GDO_DEBUG_LOG_CAPACITY = 128;
export const GDO_DEBUG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

const LEVEL_ORDER = Object.fromEntries(GDO_DEBUG_LEVELS.map((level, index) => [level, index]));

function serialise(data) {
  if (data == null) return '';
  try {
    return typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    return '[unserialisable]';
  }
}

/**
 * Bounded ring logger. Every entry is a plain record, so a test can assert on
 * exact lines instead of scraping the console.
 */
export function createDebugLogger({
  capacity = GDO_DEBUG_LOG_CAPACITY,
  level = 'info',
  tag = 'gdo',
  clock = () => Date.now(),
  sink = null,
  mirrorToConsole = false,
} = {}) {
  const records = [];
  let written = 0, dropped = 0, minimum = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  const api = {
    tag,
    namespace: GDO_DEBUG_VERSION,
    get capacity() { return capacity; },
    /** Records currently retained (bounded by `capacity`). */
    get count() { return records.length; },
    /** Records written since creation, including dropped ones. */
    get written() { return written; },
    get dropped() { return dropped; },
    get level() { return Object.keys(LEVEL_ORDER).find(name => LEVEL_ORDER[name] === minimum) ?? 'info'; },
    get records() { return [...records]; },
    setLevel(next) {
      if (next in LEVEL_ORDER) minimum = LEVEL_ORDER[next];
      return api.level;
    },
    write(scope, message, data = null, entryLevel = 'info') {
      const severity = LEVEL_ORDER[entryLevel] ?? LEVEL_ORDER.info;
      if (severity < minimum) return null;
      const record = {
        index: written++,
        time: Number(clock()) || 0,
        level: entryLevel,
        scope: String(scope),
        message: String(message),
        data: data ?? null,
      };
      records.push(record);
      while (records.length > capacity) { records.shift(); dropped++; }
      sink?.(record);
      if (mirrorToConsole) console[entryLevel === 'debug' ? 'log' : entryLevel]?.(`[${tag}:${record.scope}] ${record.message}`, data ?? '');
      return record;
    },
    debug(scope, message, data) { return api.write(scope, message, data, 'debug'); },
    info(scope, message, data) { return api.write(scope, message, data, 'info'); },
    warn(scope, message, data) { return api.write(scope, message, data, 'warn'); },
    error(scope, message, data) { return api.write(scope, message, data, 'error'); },
    text() {
      return records
        .map(record => `${record.time} ${record.level} [${record.scope}] ${record.message}${record.data ? ` ${serialise(record.data)}` : ''}`)
        .join('\n');
    },
    byScope(scope) { return records.filter(record => record.scope === scope); },
    clear() { records.length = 0; return api; },
  };
  return api;
}

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch (error) {
    return typeof fallback === 'function' ? fallback(error) : fallback;
  }
}

/**
 * Installs the debug hook. Every probe is wrapped so a failing probe reports the
 * failure instead of breaking the caller (or the render loop).
 */
export function installDebugHooks(target, {
  ledger = null,
  logger = null,
  describe = () => ({}),
  step = null,
  audits = {},
  extras = {},
  version = GDO_DEBUG_VERSION,
  key = GDO_DEBUG_HOOK_KEY,
  enabled = true,
} = {}) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
    throw new Error('installDebugHooks needs a target object');
  }
  const previous = target[key] ?? null;
  if (!enabled) {
    return { enabled: false, dispose() {}, previous };
  }
  const startedAt = Date.now();
  const auditNames = Object.keys(audits);

  const hook = {
    version,
    namespace: version,
    get installed() { return target[key] === hook; },
    startedAt,
    ledger: () => safeCall(() => ledger?.snapshot(), TypeError),
    counts: () => safeCall(() => ledger?.counts() ?? null, TypeError),
    live: () => safeCall(() => ledger?.liveEntries() ?? [], TypeError),
    log: {
      get records() { return logger?.records ?? []; },
      get count() { return logger?.count ?? 0; },
      text: () => logger?.text?.() ?? '',
      clear: () => { logger?.clear?.(); return hook.log; },
      write: (scope, message, data) => logger?.write?.(scope, message, data) ?? null,
    },
    probe() {
      const described = safeCall(describe, error => ({ error: error?.message || String(error) }));
      return {
        version,
        time: Date.now() - startedAt,
        ledger: safeCall(() => ledger?.snapshot() ?? null, null),
        described,
      };
    },
    step(dt = 1 / 30, steps = 1) {
      if (typeof step !== 'function') return { ok: false, detail: 'no step driver installed' };
      const count = Math.max(1, Math.min(600, Math.floor(steps) || 1));
      const delta = Math.max(1 / 240, Math.min(.25, Number(dt) || 1 / 30));
      for (let index = 0; index < count; index++) step(delta, index);
      return { ok: true, steps: count, dt: delta };
    },
    audits: {
      list: () => [...auditNames],
      run(name, options = {}) {
        const runner = audits[name];
        if (typeof runner !== 'function') return { ok: false, detail: `unknown audit "${name}"`, available: auditNames };
        return safeCall(() => runner(options), error => ({ ok: false, detail: error?.message || String(error) }));
      },
    },
    ...extras,
    dispose() {
      if (target[key] === hook) delete target[key];
    },
  };

  target[key] = hook;
  return {
    enabled: true,
    hook,
    previous,
    describe: () => `hook ${key} v${version} · audits ${auditNames.join(', ') || 'none'}`,
    dispose() { hook.dispose(); },
  };
}

/** Compact one-line summary used by logs and by the audit runner output. */
export function describeDebugProbe(probe) {
  if (!probe) return 'no probe';
  const ledger = probe.ledger ? `${probe.ledger.total} live/${probe.ledger.released} released` : 'no ledger';
  const camera = probe.described?.camera?.mode ? ` · ${probe.described.camera.mode}` : '';
  return `${probe.version}${camera} · ${ledger}`;
}
