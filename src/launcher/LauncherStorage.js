/**
 * The launcher's own memory (`gdo:launcher:v1`) and its window onto the save.
 *
 * Two different things are persisted, and keeping them apart is the point:
 *
 *  1. **Where you were** — the last place launched, plus a bounded list of recent
 *     places — lives here under its own key. It is browsing state, not progress,
 *     so it must never inflate the `NET-01` save envelope (whose settings
 *     vocabulary is a closed, versioned enum) and must never be validated as one.
 *  2. **How the game is set up** — quality profile, motion/effect toggles, and
 *     key remaps — already has exactly one home: the `NET-01` envelope written by
 *     `LocalSave`. The launcher reads and writes it through the same
 *     `createLocalSave` the world uses, and a settings write is a
 *     read-modify-write that carries the discovery journal and activity progress
 *     forward untouched. A launcher that overwrote them with `{}` would silently
 *     wipe a player's visited places from a settings screen.
 *
 * Everything here is total: a browser without storage, a payload from a future
 * schema, or a corrupt record is answered with a named refusal and a usable empty
 * state, never a throw.
 */

import { createLocalSave, GDO_SAVE_SETTINGS } from '../engine/LocalSave.js';
import { describePlace } from './locations.js';

export const GDO_LAUNCHER_NAMESPACE = 'gdo:launcher:v1';
export const GDO_LAUNCHER_SCHEMA = 1;
export const GDO_LAUNCHER_KEY = `${GDO_LAUNCHER_NAMESPACE}:state`;
/** Recents are a convenience, not a history: the list is capped and de-duplicated. */
export const GDO_LAUNCHER_LIMITS = Object.freeze({ recents: 6, launchCount: 9999 });

export const GDO_LAUNCHER_REFUSAL = Object.freeze({
  NO_STORAGE: 'no-storage',
  UNREADABLE: 'storage-unreadable',
  MALFORMED: 'malformed',
  FOREIGN: 'foreign-payload',
  FUTURE: 'future-schema',
  FULL: 'storage-full',
});

const refuse = refusal => Object.freeze({ ok: false, refusal });

/** A place record is `{kind, id, name, subtitle, latitude, longitude}`. */
function cleanPlace(place) {
  const described = describePlace(place);
  if (!described.ok) return null;
  return {
    kind: described.kind,
    id: described.id,
    name: described.name,
    latitude: described.latitude,
    longitude: described.longitude,
  };
}

const placeKey = place => (place.kind === 'location' ? `location:${place.id}` : `pin:${place.latitude.toFixed(4)},${place.longitude.toFixed(4)}`);

/**
 * The launcher state, backed by a `getItem`/`setItem` store (localStorage in a
 * browser, a plain Map-backed fake in a test).
 */
export function createLauncherStorage({ storage = null, key = GDO_LAUNCHER_KEY, now = () => Date.now() } = {}) {
  const usable = Boolean(storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function');
  const refusals = Object.create(null);
  for (const name of Object.values(GDO_LAUNCHER_REFUSAL)) refusals[name] = 0;
  let lastReason = null;

  const state = { last: null, recents: [], launches: 0 };

  function apply(payload) {
    state.last = payload.last ? cleanPlace(payload.last) : null;
    state.recents = payload.recents
      .map(cleanPlace)
      .filter(Boolean)
      .filter((place, index, list) => list.findIndex(other => placeKey(other) === placeKey(place)) === index)
      .slice(0, GDO_LAUNCHER_LIMITS.recents);
    state.launches = Number.isInteger(payload.launches) ? Math.max(0, Math.min(payload.launches, GDO_LAUNCHER_LIMITS.launchCount)) : 0;
    return state;
  }

  /** Read, validate, and fall back to an empty state. Never throws. */
  function load() {
    if (!usable) { refusals[GDO_LAUNCHER_REFUSAL.NO_STORAGE]++; lastReason = GDO_LAUNCHER_REFUSAL.NO_STORAGE; return state; }
    let raw = null;
    try { raw = storage.getItem(key); }
    catch { refusals[GDO_LAUNCHER_REFUSAL.UNREADABLE]++; lastReason = GDO_LAUNCHER_REFUSAL.UNREADABLE; return state; }
    if (!raw) return state;
    let payload = null;
    try { payload = JSON.parse(raw); }
    catch { refusals[GDO_LAUNCHER_REFUSAL.MALFORMED]++; lastReason = GDO_LAUNCHER_REFUSAL.MALFORMED; return state; }
    if (!payload || typeof payload !== 'object' || payload.namespace !== GDO_LAUNCHER_NAMESPACE) {
      refusals[GDO_LAUNCHER_REFUSAL.FOREIGN]++; lastReason = GDO_LAUNCHER_REFUSAL.FOREIGN; return state;
    }
    if (!Number.isInteger(payload.schema) || payload.schema > GDO_LAUNCHER_SCHEMA) {
      refusals[GDO_LAUNCHER_REFUSAL.FUTURE]++; lastReason = GDO_LAUNCHER_REFUSAL.FUTURE; return state;
    }
    return apply({
      last: payload.last ?? null,
      recents: Array.isArray(payload.recents) ? payload.recents : [],
      launches: payload.launches,
    });
  }

  function persist() {
    if (!usable) return false;
    const envelope = {
      namespace: GDO_LAUNCHER_NAMESPACE,
      schema: GDO_LAUNCHER_SCHEMA,
      savedAt: now(),
      last: state.last,
      recents: state.recents,
      launches: state.launches,
    };
    try { storage.setItem(key, JSON.stringify(envelope)); return true; }
    catch { refusals[GDO_LAUNCHER_REFUSAL.FULL]++; lastReason = GDO_LAUNCHER_REFUSAL.FULL; return false; }
  }

  /** Remember a launch: it becomes the last place and the first recent. */
  function recordLaunch(place) {
    const clean = cleanPlace(place);
    if (!clean) return refuse('bad-input');
    state.last = clean;
    state.recents = [clean, ...state.recents.filter(other => placeKey(other) !== placeKey(clean))]
      .slice(0, GDO_LAUNCHER_LIMITS.recents);
    state.launches = Math.min(state.launches + 1, GDO_LAUNCHER_LIMITS.launchCount);
    persist();
    return clean;
  }

  function clear() {
    state.last = null;
    state.recents = [];
    state.launches = 0;
    if (usable) {
      try {
        if (typeof storage.removeItem === 'function') storage.removeItem(key);
        else storage.setItem(key, '');
      } catch { /* an unwritable store keeps the in-memory clear */ }
    }
    return state;
  }

  return {
    namespace: GDO_LAUNCHER_NAMESPACE,
    schema: GDO_LAUNCHER_SCHEMA,
    state,
    load,
    persist,
    recordLaunch,
    clear,
    get diagnostics() {
      return { namespace: GDO_LAUNCHER_NAMESPACE, schema: GDO_LAUNCHER_SCHEMA, key, usable, refusals, lastReason, ...state };
    },
  };
}

/* ── the save envelope's settings half ───────────────────────────────────── */

/**
 * Settings as the launcher sees them: the declared `NET-01` vocabulary with the
 * profile defaulted and every unknown key dropped. A malformed or future save is
 * refused, and the launcher then runs on its defaults rather than guessing.
 */
export function readPlayerSettings(storage, { fallbackProfile = 'low' } = {}) {
  const defaults = { profile: fallbackProfile, touchControls: false, reducedMotion: false, cameraFade: true, weatherEffects: true, keyBindings: {} };
  if (!storage) return { ok: false, refusal: GDO_LAUNCHER_REFUSAL.NO_STORAGE, settings: defaults };
  const save = createLocalSave({ storage });
  const payload = save.load();
  if (!payload) return { ok: false, refusal: save.diagnostics.lastReason ?? 'no-payload', settings: defaults };
  return { ok: true, settings: { ...defaults, ...payload.settings }, payload };
}

/**
 * Read-modify-write the settings half of the `NET-01` save. The journal and the
 * activity progress are carried forward exactly as loaded — a settings screen
 * must not be able to erase a save.
 */
export function writePlayerSettings(storage, patch, { profileFallback = 'low' } = {}) {
  if (!storage) return { ok: false, refusal: GDO_LAUNCHER_REFUSAL.NO_STORAGE };
  const save = createLocalSave({ storage });
  const payload = save.load();
  const previous = payload?.settings ?? {};
  const next = { ...previous };
  for (const [key, value] of Object.entries(patch ?? {})) {
    const declared = GDO_SAVE_SETTINGS[key];
    // Same rule as the envelope: a key it does not declare is not written.
    if (!declared) continue;
    if (declared === 'key-bindings') { next.keyBindings = value ?? {}; continue; }
    if (!declared.includes(value)) continue;
    next[key] = value;
  }
  if (next.profile == null) next.profile = profileFallback;
  const envelope = save.capture({
    settings: next,
    discovery: payload?.discovery ?? null,
    activities: payload?.progress?.activities ?? [],
    worldVersion: payload?.worldVersion ?? 0,
    nowMilliseconds: Date.now(),
  });
  if (!save.persist(envelope)) return { ok: false, refusal: save.diagnostics.lastReason ?? GDO_LAUNCHER_REFUSAL.FULL, settings: next };
  return { ok: true, settings: next };
}

/** Erase the game's save (settings, discoveries, progress) — an explicit choice. */
export function clearPlayerSave(storage) {
  if (!storage) return { ok: false, refusal: GDO_LAUNCHER_REFUSAL.NO_STORAGE };
  try {
    const save = createLocalSave({ storage });
    storage.removeItem(save.key);
    return { ok: true };
  } catch {
    return { ok: false, refusal: GDO_LAUNCHER_REFUSAL.UNREADABLE };
  }
}
