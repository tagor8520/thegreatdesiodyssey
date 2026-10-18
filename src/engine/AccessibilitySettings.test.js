import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_ACCESSIBILITY_CHANNELS, GDO_ACCESSIBILITY_NAMESPACE, GDO_ACCESSIBILITY_REFUSAL,
  GDO_ACCESSIBILITY_SETTINGS, createAccessibilitySettings,
} from './AccessibilitySettings.js';
import { createActionRegistry } from './ActionRegistry.js';
import { GDO_FEATURE_VERSIONS } from './FeatureVersions.js';
import { createLocalSave } from './LocalSave.js';
import { LifecycleLedger } from './LifecycleContract.js';

/**
 * `GME-10` gate: keyboard/touch mapping over the one `GME-05` registry, and
 * motion/effect settings that persist through the `NET-01` envelope — with
 * every refusal named and every channel declared.
 */

test('GME-10 remapping goes through the registry and refuses conflicts by name', () => {
  const registry = createActionRegistry();
  // `GeoGame` registers the guide verb the same way before the surface exists.
  registry.register({
    id: 'guide', kind: 'tap', label: 'Guide', hint: 'G',
    capability: 'navigation', keyboard: ['KeyG'], pointer: null, touch: null,
  });
  const accessibility = createAccessibilitySettings({ registry });
  // Move holds WASD at construction; remap its forward key and the registry
  // (the same table the pad and the help sentence read) follows.
  const result = accessibility.rebind('jump', ['KeyG']);
  assert.equal(result.ok, false, 'G is the guide verb — the conflict refuses');
  assert.equal(result.reason, 'code-conflict');
  assert.deepEqual(result.conflicts, ['KeyG']);
  assert.equal(accessibility.refusals[GDO_ACCESSIBILITY_REFUSAL.CODE_CONFLICT], 1);

  const jumped = accessibility.rebind('jump', ['Space', 'KeyZ']);
  assert.equal(jumped.ok, true);
  assert.deepEqual(registry.action('jump').keyboard, ['Space', 'KeyZ']);
  assert.equal(accessibility.settings.keyBindings.jump.includes('KeyZ'), true);
  assert.equal(accessibility.counters.rebinds, 1);

  assert.equal(accessibility.rebind('no-such-action', ['KeyQ']).reason, 'unknown-action');
  assert.equal(accessibility.rebind('jump', []).reason, 'empty-binding');
  assert.equal(accessibility.refusals[GDO_ACCESSIBILITY_REFUSAL.UNKNOWN_ACTION], 1);
  assert.equal(accessibility.refusals[GDO_ACCESSIBILITY_REFUSAL.EMPTY_BINDING], 1);

  // Reset is data: the registry's construction-time bindings return.
  accessibility.resetBindings();
  assert.deepEqual(registry.action('jump').keyboard, [...registry.defaultBindings().jump]);
  assert.equal(accessibility.counters.resets, 1);
});

test('GME-10 the toggles validate against their declared vocabulary', () => {
  const accessibility = createAccessibilitySettings({});
  assert.equal(accessibility.set('reducedMotion', true), true);
  assert.equal(accessibility.settings.reducedMotion, true);
  assert.equal(accessibility.set('weatherEffects', false), false);
  assert.equal(accessibility.set('volume', 11), null);
  assert.equal(accessibility.refusals[GDO_ACCESSIBILITY_REFUSAL.UNKNOWN_SETTING], 1);
  assert.equal(accessibility.set('reducedMotion', 'yes'), null);
  assert.equal(accessibility.refusals[GDO_ACCESSIBILITY_REFUSAL.INVALID_SETTING], 1);
  for (const key of Object.keys(GDO_ACCESSIBILITY_SETTINGS)) {
    assert.ok(Array.isArray(GDO_ACCESSIBILITY_SETTINGS[key]));
    assert.ok(GDO_ACCESSIBILITY_CHANNELS[key].length > 0,
      'every toggle names the channels it touches');
  }
});

test('GME-10 motion/effect settings persist through the NET-01 envelope', () => {
  const registry = createActionRegistry();
  const accessibility = createAccessibilitySettings({ registry, reducedMotion: false });
  accessibility.set('reducedMotion', true);
  accessibility.set('weatherEffects', false);
  accessibility.rebind('jump', ['KeyZ']);

  const memory = new Map();
  const storage = {
    getItem(key) { return memory.has(key) ? memory.get(key) : null; },
    setItem(key, value) { memory.set(key, String(value)); },
    removeItem(key) { memory.delete(key); },
  };
  const save = createLocalSave({ storage, key: 'a11y-test' });
  save.persist(save.capture({ settings: accessibility.toSaveSettings() }));

  // A fresh game: fresh registry, fresh surface, restored from the envelope.
  const secondRegistry = createActionRegistry();
  const second = createAccessibilitySettings({ registry: secondRegistry });
  const payload = createLocalSave({ storage, key: 'a11y-test' }).load();
  second.applySaveSettings(payload.settings);
  assert.equal(second.settings.reducedMotion, true);
  assert.equal(second.settings.weatherEffects, false);
  assert.deepEqual(secondRegistry.action('jump').keyboard, ['KeyZ'],
    'the remapped keyboard returns on the live registry');
  assert.equal(second.counters.applied, 1);
});

test('GME-10 a malformed remap map refuses by name and keeps the rest', () => {
  const registry = createActionRegistry();
  const accessibility = createAccessibilitySettings({ registry });
  accessibility.applySaveSettings({
    reducedMotion: true,
    keyBindings: { jump: ['NotAKey'] },
  });
  assert.equal(accessibility.settings.reducedMotion, true);
  assert.deepEqual(registry.action('jump').keyboard, [...registry.defaultBindings().jump],
    'a malformed map never reaches the registry');
  assert.equal(accessibility.refusals[GDO_ACCESSIBILITY_REFUSAL.INVALID_SETTING], 1);
});

test('GME-10 the effects policy is a declaration and the surface disposes cleanly', () => {
  const accessibility = createAccessibilitySettings({});
  const policy = accessibility.effectsPolicy();
  assert.equal(policy.length, Object.keys(GDO_ACCESSIBILITY_CHANNELS).length);
  for (const entry of policy) {
    assert.equal(typeof entry.value, 'boolean');
    assert.deepEqual(entry.channels, GDO_ACCESSIBILITY_CHANNELS[entry.setting]);
  }
  assert.equal(GDO_ACCESSIBILITY_NAMESPACE, 'gdo:accessibility:v1');
  assert.equal(GDO_FEATURE_VERSIONS.accessibility, 1);
  assert.equal(accessibility.diagnostics.steadyFrameAllocations, 0);

  const ledger = new LifecycleLedger({ label: 'a11y-test' });
  const owned = createAccessibilitySettings({ registry: createActionRegistry(), ledger });
  owned.rebind('jump', ['KeyZ']);
  owned.dispose();
  assert.equal(ledger.snapshot().counts.handle, 0, 'the ledger releases the surface');
});

test('GME-10 a registry without rebind is refused at construction', () => {
  assert.throws(() => createAccessibilitySettings({ registry: {} }), TypeError);
});
