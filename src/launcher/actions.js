/**
 * The action registry the front page can build without loading the world.
 *
 * `FND-03` says the WebGL world must not be fetched until a place is chosen, and
 * the coordinate player domain lives in a module that imports three.js. So the
 * launcher declares the same capability set here as **data** and builds the same
 * `GME-05` registry from it — which is what lets the Controls screen list real
 * actions, real keys, and a real remap before any 3D code has been downloaded.
 *
 * The duplication is deliberate and guarded: `actions.test.js` builds a registry
 * the way `GeoGame` does (from `GDO_COORDINATE_PLAYER_DOMAIN` plus the coordinate
 * world's declared `interaction`/`navigation` capabilities) and asserts the two
 * produce the same actions, the same keys and the same touch pad. If the domain
 * ever changes, that test fails instead of the front page quietly lying.
 */

import { createActionRegistry } from '../engine/ActionRegistry.js';

/**
 * `actionCapabilitiesForDomain(GDO_COORDINATE_PLAYER_DOMAIN)` produces exactly
 * this, with the coordinate world's two extra verbs added by the mount. Written
 * out so the launcher imports no map code.
 */
export const GDO_LAUNCHER_ACTION_CAPABILITIES = Object.freeze({
  analogInput: true,
  jump: true,
  pointerLook: true,
  cameraToggle: true,
  interaction: true,   // `DET-10`: the world places interaction targets.
  touch: true,
  navigation: true,    // `GME-07`: the world derives guidance from the map.
});

export function createLauncherActionRegistry() {
  return createActionRegistry({ capabilities: GDO_LAUNCHER_ACTION_CAPABILITIES });
}
