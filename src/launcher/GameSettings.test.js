import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_GAME_SETTINGS_NAMESPACE,
  GDO_QUALITY_PROFILES,
  GDO_QUALITY_PROFILE_COPY,
  createGameSettings,
  profileSummary,
  suggestProfile,
} from './GameSettings.js';
import { createLauncherActionRegistry } from './actions.js';
import { GDO_SAVE_SETTINGS } from '../engine/LocalSave.js';

/**
 * One settings model, two hosts. The tests that matter are the ones that would
 * otherwise let the title screen and the pause menu disagree: the declared
 * vocabulary, a refused value, a profile that cannot apply live, and the exact
 * shape written into the `NET-01` envelope.
 */

test('the model declares the same vocabulary the save does', () => {
  const settings = createGameSettings({ registry: createLauncherActionRegistry() });
  assert.equal(settings.namespace, 'gdo:gameSettings:v1');
  assert.equal(GDO_GAME_SETTINGS_NAMESPACE, 'gdo:gameSettings:v1');
  assert.deepEqual(GDO_QUALITY_PROFILES, GDO_SAVE_SETTINGS.profile);
  assert.deepEqual(Object.keys(GDO_QUALITY_PROFILE_COPY), [...GDO_QUALITY_PROFILES]);
  for (const profile of GDO_QUALITY_PROFILES) {
    assert.ok(profileSummary(profile).label);
    assert.ok(profileSummary(profile).detail.includes('MB'), `${profile} names its cache ceiling`);
  }
  assert.equal(settings.settings.profile, 'low', 'an unset profile is the safe one');
  assert.equal(settings.settings.weatherEffects, true, 'effects default on, as the accessibility surface declares');
});

test('saved settings are restored, and the launcher profile wins over the stale save', () => {
  const saved = {
    profile: 'high', reducedMotion: true, weatherEffects: false,
    cameraFade: false, touchControls: true,
    keyBindings: { move: ['KeyI'] },
  };
  const fromSave = createGameSettings({ registry: createLauncherActionRegistry(), saved });
  assert.equal(fromSave.settings.profile, 'high');
  assert.equal(fromSave.settings.reducedMotion, true);
  assert.equal(fromSave.settings.weatherEffects, false);
  assert.equal(fromSave.settings.cameraFade, false);
  // The remap reached the registry, which is what the keyboard reads.
  assert.deepEqual(fromSave.registry.action('move').keyboard, ['KeyI']);

  const overridden = createGameSettings({ registry: createLauncherActionRegistry(), saved, profile: 'balanced' });
  assert.equal(overridden.settings.profile, 'balanced');
  const invalid = createGameSettings({ registry: createLauncherActionRegistry(), saved, profile: 'ultra' });
  assert.equal(invalid.settings.profile, 'high', 'an invalid override falls back to the save, not to a guess');
});

test('a profile change is stored but cannot pretend to apply live', () => {
  const changes = [];
  const settings = createGameSettings({ registry: createLauncherActionRegistry(), onChange: (key, value) => changes.push([key, value]) });
  assert.equal(settings.requiresRelaunch, false);
  assert.equal(settings.set('profile', 'balanced'), 'balanced');
  assert.equal(settings.requiresRelaunch, true, 'the world reads the profile when it is constructed');
  assert.deepEqual(changes, [['profile', 'balanced']]);
  // Setting the same value does not announce a phantom change.
  assert.equal(settings.set('profile', 'balanced'), 'balanced');
  assert.equal(changes.length, 1);
  // And a bogus one is refused by name, leaving the value alone.
  assert.equal(settings.set('profile', 'ultra'), null);
  assert.equal(settings.settings.profile, 'balanced');
  assert.equal(settings.diagnostics.refusals['invalid-value'], 1);
  settings.markApplied();
  assert.equal(settings.requiresRelaunch, false);
});

test('toggles go through the accessibility surface and are refused by name', () => {
  const settings = createGameSettings({ registry: createLauncherActionRegistry() });
  assert.equal(settings.set('reducedMotion', true), true);
  assert.equal(settings.settings.reducedMotion, true);
  assert.equal(settings.accessibility.settings.reducedMotion, true, 'one owner for the value');
  assert.equal(settings.set('weatherEffects', 'yes'), null, 'a string is not a boolean');
  assert.ok(settings.diagnostics.refusals['invalid-setting'] >= 1);
  assert.equal(settings.set('notASetting', true), null);
  assert.equal(settings.diagnostics.refusals['unknown-setting'], 1);
});

test('rebinding uses the registry rules, including the conflict refusal', () => {
  const settings = createGameSettings({ registry: createLauncherActionRegistry() });
  const ok = settings.rebind('jump', ['KeyJ']);
  assert.equal(ok.ok, true);
  assert.deepEqual(settings.registry.action('jump').keyboard, ['KeyJ']);

  // Space is still the jump default in the table? No — after the rebind the old
  // code is free, so grabbing `KeyW` (move) is a conflict, not a steal.
  const conflict = settings.rebind('jump', ['KeyW']);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, 'code-conflict');
  assert.deepEqual(settings.registry.action('jump').keyboard, ['KeyJ'], 'a refused rebind changes nothing');

  assert.equal(settings.rebind('nope', ['KeyZ']).ok, false);
  settings.resetBindings();
  assert.deepEqual(settings.registry.action('jump').keyboard, ['Space'], 'reset restores the defaults');
});

test('toSaveSettings is exactly the NET-01 vocabulary, with the profile included', () => {
  const settings = createGameSettings({ registry: createLauncherActionRegistry() });
  settings.set('profile', 'high');
  settings.set('cameraFade', false);
  settings.rebind('camera', ['KeyK']);
  const save = settings.toSaveSettings();
  assert.deepEqual(Object.keys(save).sort(),
    ['cameraFade', 'keyBindings', 'profile', 'reducedMotion', 'touchControls', 'weatherEffects']);
  for (const [key, value] of Object.entries(save)) {
    const declared = GDO_SAVE_SETTINGS[key];
    if (declared === 'key-bindings') { assert.deepEqual(value, { camera: ['KeyK'] }); continue; }
    assert.ok(declared.includes(value), `${key}=${value} is declared`);
  }
  // A listener that throws cannot break the settings surface.
  const survivor = createGameSettings({ registry: createLauncherActionRegistry(), onChange: () => { throw new Error('boom'); } });
  assert.equal(survivor.set('reducedMotion', true), true);
});

test('suggestProfile is a starting point, never a lock', () => {
  const desktop = { hardwareConcurrency: 12, deviceMemory: 16, maxTouchPoints: 0 };
  const phone = { hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 5 };
  const laptop = { hardwareConcurrency: 4, deviceMemory: 8, maxTouchPoints: 0 };
  const narrow = { innerWidth: 480, matchMedia: () => ({ matches: false }) };
  const wide = { innerWidth: 1440, matchMedia: () => ({ matches: false }) };
  assert.equal(suggestProfile(desktop, wide), 'balanced');
  assert.equal(suggestProfile(phone, wide), 'low', 'touch devices start low');
  assert.equal(suggestProfile(laptop, wide), 'low', 'four cores is the boundary');
  assert.equal(suggestProfile({ hardwareConcurrency: 2 }, wide), 'low');
  assert.equal(suggestProfile({ hardwareConcurrency: 8, deviceMemory: 4 }, wide), 'low');
  assert.equal(suggestProfile({ hardwareConcurrency: 8 }, narrow), 'low', 'a narrow window starts low');
  assert.equal(suggestProfile({}, wide), 'balanced', 'an unreadable device still gets a profile');
  assert.ok(GDO_QUALITY_PROFILES.includes(suggestProfile(desktop, wide)));
});
