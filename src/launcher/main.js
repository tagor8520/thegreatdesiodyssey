/**
 * The game's entry point.
 *
 * One page, one container, two states: the launcher, and the world. Choosing a
 * place writes the settings, mounts the world into the same container, and hands
 * it the place it was given; leaving the world (Quit, or Change place from the
 * pause menu) disposes it through its own lifecycle ledger and puts the launcher
 * back. Nothing here knows how the world is built — `GeoGame` is imported only
 * when a place has actually been chosen, which is what keeps three.js out of the
 * first paint (`FND-03`).
 */

import './launcher.css';
import { mountLauncher } from './Launcher.js';
import { createGameSettings, suggestProfile } from './GameSettings.js';
import { createLauncherActionRegistry } from './actions.js';
import {
  clearPlayerSave,
  createLauncherStorage,
  readPlayerSettings,
  writePlayerSettings,
} from './LauncherStorage.js';
import { loadMapProviders } from './providers.js';

const container = document.getElementById('game-root') ?? document.querySelector('main');

/** A browser that refuses storage still plays; it just forgets. */
function safeStorage() {
  try {
    const store = globalThis.localStorage;
    if (!store || typeof store.getItem !== 'function') return null;
    const probe = '__gdo_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

if (container) {
  const storage = safeStorage();
  const launcherStorage = createLauncherStorage({ storage });
  launcherStorage.load();

  const initial = readPlayerSettings(storage, { fallbackProfile: suggestProfile() });
  const settings = createGameSettings({
    registry: createLauncherActionRegistry(),
    saved: initial.settings,
    profile: initial.settings.profile,
  });

  let game = null;
  let mounting = false;

  const writeSettings = save => {
    if (save) writePlayerSettings(storage, save);
  };

  const exitToTitle = () => {
    const current = game;
    game = null;
    try { current?.dispose?.(); } catch (error) { console.error('world dispose failed', error); }
    container.classList.remove('gdo-playing');
    launcher.show();
  };

  const onLaunch = ({ place, settings: save }) => {
    if (mounting) return false;
    mounting = true;
    writeSettings(save);
    // The launcher's note doubles as the loading line: the world is a dynamic
    // import, so naming what is loading is true for the whole time it loads.
    launcher.state.message = `Loading ${place.name} — downloading one small map chunk…`;
    launcher.show();
    (async () => {
      try {
        const providers = await loadMapProviders();
        const { mountGeoGame } = await import('../geo/GeoGame.js');
        container.replaceChildren();
        container.classList.add('gdo-playing');
        game = mountGeoGame(container, {
          latitude: place.latitude,
          longitude: place.longitude,
          profile: save?.profile ?? 'low',
          providers,
          place,
          onExitRequest: () => queueMicrotask(exitToTitle),
        });
        launcher.state.message = '';
      } catch (error) {
        console.error(error);
        launcher.state.message = `Unable to start ${place.name}: ${error.message}`;
        launcher.show();
      } finally {
        mounting = false;
      }
    })();
    return true;
  };

  const launcher = mountLauncher(container, {
    storage,
    settings,
    launcherStorage,
    onLaunch,
    onSettingsChanged: writeSettings,
    onClearSave: () => clearPlayerSave(storage),
  });

  if (import.meta.hot) import.meta.hot.dispose(() => game?.dispose?.());
}
