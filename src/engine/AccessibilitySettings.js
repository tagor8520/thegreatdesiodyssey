/**
 * `GME-10` — accessibility, remapping, and reduced motion (`gdo:accessibility:v1`).
 *
 * The row's claim is two halves, both data: **keyboard/touch mapping** — one
 * remap surface over the landed `GME-05` registry whose rebinds refuse by name
 * (a code another action owns is never silently stolen) and whose touch side
 * stays the registry's own pad buttons — and **motion/effect settings that
 * persist** through the landed `NET-01` envelope's declared settings
 * vocabulary, so a reload restores exactly the mapping and the motion policy
 * the player chose.
 *
 * The effect toggles name their channels rather than reaching into systems:
 * `effectsPolicy()` is the declaration every consumer reads, so "reduced
 * motion" means the same thing to the weather, the wind, the run cycle, and
 * the camera fade — and the debug surface can show which channels a setting
 * actually touches.
 */

import { featureNamespace } from './FeatureVersions.js';

export const GDO_ACCESSIBILITY_NAMESPACE = featureNamespace('accessibility');

/** The toggles. Each names its channels in `GDO_ACCESSIBILITY_CHANNELS`. */
export const GDO_ACCESSIBILITY_SETTINGS = Object.freeze({
  reducedMotion: Object.freeze([true, false]),
  weatherEffects: Object.freeze([true, false]),
  cameraFade: Object.freeze([true, false]),
  touchControls: Object.freeze([true, false]),
});

/**
 * What a toggle touches, by name. A system that does not implement a channel
 * simply has nothing to apply; the declaration never gains an unnamed side
 * effect.
 */
export const GDO_ACCESSIBILITY_CHANNELS = Object.freeze({
  reducedMotion: Object.freeze(['weatherParticles', 'ambientWind', 'pedestrianRunCycle', 'plantWind', 'cameraFade']),
  weatherEffects: Object.freeze(['weatherParticles', 'weatherShore']),
  cameraFade: Object.freeze(['cameraFade']),
  touchControls: Object.freeze(['touchPad']),
});

export const GDO_ACCESSIBILITY_REFUSAL = Object.freeze({
  UNKNOWN_ACTION: 'unknown-action',
  UNKNOWN_SETTING: 'unknown-setting',
  INVALID_SETTING: 'invalid-setting',
  EMPTY_BINDING: 'empty-binding',
  CODE_CONFLICT: 'code-conflict',
  KEYBOARD_CAP: 'keyboard-cap',
});

const KEY_CODE_PATTERN = /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Space|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Tab|Enter|Escape|Slash|Comma|Period|Bracket(Left|Right)|Minus|Equal|Backquote)$/;

function validBindingMap(bindings) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return null;
  const entries = Object.entries(bindings);
  if (entries.length > 16) return null;
  const clean = Object.create(null);
  for (const [id, codes] of entries) {
    if (typeof id !== 'string' || !id || !Array.isArray(codes) || codes.length > 8) return null;
    const list = [];
    for (const code of codes) {
      const value = String(code);
      if (!KEY_CODE_PATTERN.test(value)) return null;
      if (!list.includes(value)) list.push(value);
    }
    clean[id] = Object.freeze(list);
  }
  return clean;
}

/**
 * The accessibility surface. One instance per game; the registry is the same
 * one the keyboard, the pad, and the help sentence already read.
 */
export function createAccessibilitySettings({
  registry = null,
  reducedMotion = false,
  ledger = null,
} = {}) {
  if (registry && typeof registry.rebind !== 'function') {
    throw new TypeError('Accessibility remapping needs a registry with rebind');
  }
  const settings = {
    reducedMotion: Boolean(reducedMotion),
    weatherEffects: true,
    cameraFade: true,
    touchControls: true,
    keyBindings: Object.create(null),
  };
  const defaults = registry?.defaultBindings?.() ?? Object.freeze(Object.create(null));
  const refusals = Object.create(null);
  for (const name of Object.values(GDO_ACCESSIBILITY_REFUSAL)) refusals[name] = 0;
  const counters = { rebinds: 0, resets: 0, applied: 0, settingsChanges: 0 };

  /** Remap one action's keyboard codes through the registry's own rules. */
  function rebind(actionId, codes) {
    if (!registry) {
      refusals[GDO_ACCESSIBILITY_REFUSAL.UNKNOWN_ACTION]++;
      return null;
    }
    const result = registry.rebind(actionId, codes);
    if (!result?.ok) {
      const reason = result?.reason === 'code-conflict' ? GDO_ACCESSIBILITY_REFUSAL.CODE_CONFLICT
        : result?.reason === 'empty-binding' ? GDO_ACCESSIBILITY_REFUSAL.EMPTY_BINDING
        : result?.reason === 'keyboard-cap' ? GDO_ACCESSIBILITY_REFUSAL.KEYBOARD_CAP
        : GDO_ACCESSIBILITY_REFUSAL.UNKNOWN_ACTION;
      refusals[reason]++;
      return result;
    }
    settings.keyBindings[actionId] = Object.freeze([...result.keyboard]);
    counters.rebinds++;
    return result;
  }

  /** Reset every remap to the registry's construction-time bindings. */
  function resetBindings() {
    for (const [id, codes] of Object.entries(defaults)) {
      registry?.rebind?.(id, codes);
      settings.keyBindings[id] = Object.freeze([...codes]);
    }
    for (const id of Object.keys(settings.keyBindings)) {
      if (!(id in defaults)) delete settings.keyBindings[id];
    }
    counters.resets++;
    return settings.keyBindings;
  }

  /** Set one declared toggle. An unknown key or value refuses by name. */
  function set(key, value) {
    if (!(key in GDO_ACCESSIBILITY_SETTINGS)) {
      refusals[GDO_ACCESSIBILITY_REFUSAL.UNKNOWN_SETTING]++;
      return null;
    }
    if (!GDO_ACCESSIBILITY_SETTINGS[key].includes(value)) {
      refusals[GDO_ACCESSIBILITY_REFUSAL.INVALID_SETTING]++;
      return null;
    }
    settings[key] = value;
    counters.settingsChanges++;
    return value;
  }

  /** The `NET-01` settings half of this surface: declared keys only. */
  function toSaveSettings() {
    return {
      reducedMotion: settings.reducedMotion,
      weatherEffects: settings.weatherEffects,
      cameraFade: settings.cameraFade,
      touchControls: settings.touchControls,
      keyBindings: { ...settings.keyBindings },
    };
  }

  /** Restore from a `NET-01` payload. Unknown or invalid entries refuse by name. */
  function applySaveSettings(saved) {
    if (!saved || typeof saved !== 'object') return null;
    for (const key of Object.keys(GDO_ACCESSIBILITY_SETTINGS)) {
      if (!(key in saved)) continue;
      set(key, saved[key]);
    }
    const bindings = validBindingMap(saved.keyBindings);
    if (saved.keyBindings && !bindings) {
      refusals[GDO_ACCESSIBILITY_REFUSAL.INVALID_SETTING]++;
    } else if (bindings) {
      for (const [id, codes] of Object.entries(bindings)) {
        rebind(id, codes);
      }
    }
    counters.applied++;
    return settings;
  }

  /** The declaration: which channels each toggle touches. */
  function effectsPolicy(out = []) {
    out.length = 0;
    for (const [key, channels] of Object.entries(GDO_ACCESSIBILITY_CHANNELS)) {
      out.push({ setting: key, value: settings[key], channels });
    }
    return out;
  }

  const diagnostics = Object.create(null);
  function diagnosticsSnapshot() {
    diagnostics.namespace = GDO_ACCESSIBILITY_NAMESPACE;
    diagnostics.settings = settings;
    diagnostics.counters = counters;
    diagnostics.refusals = refusals;
    diagnostics.channels = GDO_ACCESSIBILITY_CHANNELS;
    diagnostics.steadyFrameAllocations = 0;
    return diagnostics;
  }

  const handle = ledger?.own?.('handle', GDO_ACCESSIBILITY_NAMESPACE, settings, () => {
    for (const key of Object.keys(settings.keyBindings)) delete settings.keyBindings[key];
  }) ?? null;

  return {
    namespace: GDO_ACCESSIBILITY_NAMESPACE,
    settings,
    rebind,
    resetBindings,
    set,
    toSaveSettings,
    applySaveSettings,
    effectsPolicy,
    get diagnostics() { return diagnosticsSnapshot(); },
    counters,
    refusals,
    dispose() {
      handle?.release?.();
    },
  };
}
