/**
 * One settings model for the launcher and the in-game menu (`gdo:gameSettings:v1`).
 *
 * Two screens edit the same five declared values, and a third consumer — the
 * world — reads them at mount. That is only safe if there is exactly one model:
 * the toggles and key remaps come from the landed `GME-10` accessibility surface
 * (which already owns the registry's rebind rules and refusal names), the quality
 * profile comes from the `NET-01` declared vocabulary, and the write path is the
 * `NET-01` envelope. Nothing here invents a second settings store.
 *
 * The profile is read when the world is *constructed*, so a change to it cannot
 * take effect in the running world. This model therefore reports
 * `requiresRelaunch` honestly instead of pretending a live change happened.
 */

import { createAccessibilitySettings, GDO_ACCESSIBILITY_REFUSAL, GDO_ACCESSIBILITY_SETTINGS } from '../engine/AccessibilitySettings.js';
import { GDO_SAVE_SETTINGS } from '../engine/LocalSave.js';

export const GDO_GAME_SETTINGS_NAMESPACE = 'gdo:gameSettings:v1';
export const GDO_QUALITY_PROFILES = GDO_SAVE_SETTINGS.profile; // one declared vocabulary

/** What each profile actually costs, said in the menu rather than implied. */
export const GDO_QUALITY_PROFILE_COPY = Object.freeze({
  low: Object.freeze({
    label: 'Low',
    summary: 'The safe default. Smallest tile cache, fewest labels, particles and pedestrians.',
    detail: '6 MB tile cache · 24 chunks · 80 weather particles · 16 pedestrians',
  }),
  balanced: Object.freeze({
    label: 'Balanced',
    summary: 'More of everything while the frame budget still holds on a laptop.',
    detail: '16 MB tile cache · 64 chunks · 180 weather particles · 32 pedestrians',
  }),
  high: Object.freeze({
    label: 'High',
    summary: 'For a desktop GPU: the widest pools and the most detail that stays bounded.',
    detail: '32 MB tile cache · 128 chunks · 350 weather particles · 48 pedestrians',
  }),
});

export const GDO_GAME_SETTINGS_REFUSAL = Object.freeze({
  UNKNOWN_SETTING: 'unknown-setting',
  INVALID_VALUE: 'invalid-value',
  NO_REGISTRY: 'no-registry',
});

/**
 * Suggest a profile for the device, honestly and cheaply: a phone or a machine
 * with few cores gets `low`, everything else starts at `balanced`. This is a
 * starting point the player can override, never a lock.
 */
export function suggestProfile(navigatorLike = globalThis.navigator, windowLike = globalThis.window) {
  const cores = Number(navigatorLike?.hardwareConcurrency);
  const memory = Number(navigatorLike?.deviceMemory);
  const coarse = windowLike?.matchMedia?.('(pointer: coarse)')?.matches === true;
  const narrow = Number(windowLike?.innerWidth) > 0 && Number(windowLike.innerWidth) < 820;
  const touch = (Number(navigatorLike?.maxTouchPoints) || 0) > 0;
  if (coarse || narrow || touch) return 'low';
  if (Number.isFinite(cores) && cores > 0 && cores <= 4) return 'low';
  if (Number.isFinite(memory) && memory > 0 && memory <= 4) return 'low';
  return 'balanced';
}

/**
 * The model. `registry` is the `GME-05` action registry, which is what makes the
 * remap real: the same registry drives the keyboard, the touch pad, and the help
 * sentence, so a rebind reaches all three.
 */
export function createGameSettings({
  registry = null,
  saved = {},
  profile = null,
  onChange = null,
  ledger = null,
} = {}) {
  const accessibility = createAccessibilitySettings({
    registry,
    reducedMotion: saved.reducedMotion === true,
  });
  // Restore the declared settings (and the remaps) from the save first, then let
  // an explicit profile override win — the launcher knows the device, the save
  // knows the player.
  accessibility.applySaveSettings(saved ?? {});

  const settings = {
    profile: GDO_QUALITY_PROFILES.includes(profile) ? profile
      : GDO_QUALITY_PROFILES.includes(saved?.profile) ? saved.profile : 'low',
    reducedMotion: accessibility.settings.reducedMotion,
    weatherEffects: accessibility.settings.weatherEffects,
    cameraFade: accessibility.settings.cameraFade,
    touchControls: accessibility.settings.touchControls,
    keyBindings: accessibility.settings.keyBindings,
  };
  const counters = { changes: 0, profileChanges: 0, rebinds: 0, applied: 0 };
  const refusals = Object.create(null);
  for (const name of Object.values(GDO_GAME_SETTINGS_REFUSAL)) refusals[name] = 0;
  for (const name of Object.values(GDO_ACCESSIBILITY_REFUSAL)) refusals[name] = 0;
  let requiresRelaunch = false;

  function announce(key, value) {
    counters.changes++;
    try { onChange?.(key, value, snapshot()); } catch { /* a listener cannot break settings */ }
  }

  /** Set one declared toggle or the profile. Refuses by name, never coerces. */
  function set(key, value) {
    if (key === 'profile') {
      if (!GDO_QUALITY_PROFILES.includes(value)) { refusals[GDO_GAME_SETTINGS_REFUSAL.INVALID_VALUE]++; return null; }
      if (settings.profile === value) return value;
      settings.profile = value;
      counters.profileChanges++;
      requiresRelaunch = true;
      announce(key, value);
      return value;
    }
    if (!(key in GDO_ACCESSIBILITY_SETTINGS)) { refusals[GDO_GAME_SETTINGS_REFUSAL.UNKNOWN_SETTING]++; return null; }
    const applied = accessibility.set(key, value);
    if (applied == null) { refusals[GDO_ACCESSIBILITY_REFUSAL.INVALID_SETTING]++; return null; }
    settings[key] = applied;
    announce(key, applied);
    return applied;
  }

  /** Remap one action through the registry's own conflict rules. */
  function rebind(actionId, codes) {
    const result = accessibility.rebind(actionId, codes);
    if (result?.ok) {
      counters.rebinds++;
      announce('keyBindings', { ...settings.keyBindings });
    } else if (result?.reason) {
      refusals[result.reason] = (refusals[result.reason] ?? 0) + 1;
    }
    return result;
  }

  function resetBindings() {
    const bindings = accessibility.resetBindings();
    counters.rebinds++;
    announce('keyBindings', { ...bindings });
    return bindings;
  }

  /** Exactly the declared `NET-01` vocabulary — nothing extra rides along. */
  function toSaveSettings() {
    return {
      profile: settings.profile,
      reducedMotion: settings.reducedMotion,
      weatherEffects: settings.weatherEffects,
      cameraFade: settings.cameraFade,
      touchControls: settings.touchControls,
      keyBindings: { ...accessibility.settings.keyBindings },
    };
  }

  function snapshot() {
    return {
      profile: settings.profile,
      reducedMotion: settings.reducedMotion,
      weatherEffects: settings.weatherEffects,
      cameraFade: settings.cameraFade,
      touchControls: settings.touchControls,
      requiresRelaunch,
    };
  }

  const handle = ledger?.own?.('handle', GDO_GAME_SETTINGS_NAMESPACE, settings, () => {
    for (const key of Object.keys(settings.keyBindings)) delete settings.keyBindings[key];
  }) ?? null;

  return {
    namespace: GDO_GAME_SETTINGS_NAMESPACE,
    settings,
    accessibility,
    registry,
    set,
    rebind,
    resetBindings,
    toSaveSettings,
    snapshot,
    get requiresRelaunch() { return requiresRelaunch; },
    /** Clear the "restart to apply" flag once the world that wanted it is gone. */
    markApplied() { requiresRelaunch = false; counters.applied++; },
    get diagnostics() {
      return {
        namespace: GDO_GAME_SETTINGS_NAMESPACE,
        settings: snapshot(),
        counters,
        refusals,
        accessibility: accessibility.diagnostics,
        handle: Boolean(handle),
      };
    },
  };
}

/** The label a profile switch shows in the menu, in one place for both screens. */
export function profileSummary(profile) {
  return GDO_QUALITY_PROFILE_COPY[profile] ?? GDO_QUALITY_PROFILE_COPY.low;
}
