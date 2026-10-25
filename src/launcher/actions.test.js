import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_LAUNCHER_ACTION_CAPABILITIES,
  createLauncherActionRegistry,
} from './actions.js';
import { actionCapabilitiesForDomain, createActionRegistry } from '../engine/ActionRegistry.js';
import { GDO_COORDINATE_PLAYER_DOMAIN } from '../geo/GeoPlayer.js';
import { GDO_COORDINATE_WORLD_DOMAIN } from '../geo/GeoWorld.js';

/**
 * The guard that makes the launcher's duplicated capability list safe.
 *
 * The front page must not import the world (three.js is lazily loaded on launch,
 * `FND-03`), so it declares the coordinate action capabilities as data. This test
 * builds the registry the way `GeoGame` does — from the coordinate player domain
 * plus the coordinate world's own capability flags — and asserts the two agree on
 * every action, every key, and the touch pad. If a domain changes, the front page
 * fails this test instead of quietly showing a key that no longer does anything.
 */

test('the launcher registry matches the one the game builds', () => {
  const launcher = createLauncherActionRegistry();
  const inGame = createActionRegistry({
    capabilities: {
      ...actionCapabilitiesForDomain(GDO_COORDINATE_PLAYER_DOMAIN),
      interaction: GDO_COORDINATE_WORLD_DOMAIN.capabilities.interaction === true,
      navigation: GDO_COORDINATE_WORLD_DOMAIN.capabilities.navigation === true,
    },
  });

  assert.deepEqual(launcher.actions().map(action => action.id), inGame.actions().map(action => action.id));
  assert.deepEqual(launcher.keyboardCodes(), inGame.keyboardCodes());
  assert.deepEqual(
    launcher.actions().map(action => [action.id, action.keyboard]),
    inGame.actions().map(action => [action.id, action.keyboard]),
  );
  assert.deepEqual(launcher.touchControls().map(control => control.id),
    inGame.touchControls().map(control => control.id));
  assert.equal(launcher.keyboardHint(), inGame.keyboardHint());
  assert.deepEqual(launcher.pointerGestures(), inGame.pointerGestures());

  // The declared object is itself the shape `createActionRegistry` expects.
  assert.deepEqual(GDO_LAUNCHER_ACTION_CAPABILITIES, {
    ...actionCapabilitiesForDomain(GDO_COORDINATE_PLAYER_DOMAIN),
    interaction: true,
    navigation: true,
  });
});
