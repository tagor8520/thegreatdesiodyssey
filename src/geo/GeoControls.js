/**
 * Coordinate-mode input module.
 *
 * The device gating, joystick maths and joystick element behaviour moved to
 * `src/engine/TouchControls.js` when the curated runtime needed the same touch
 * primitives (`GME-05`) — they were never coordinate-specific, and two copies of
 * a joystick would be two places for a pointer-teardown leak to hide. Everything
 * that used to import from here still can; this file re-exports the moved names.
 */
export { FlexibleJoystick, normalizeJoystick, shouldUseTouchControls } from '../engine/TouchControls.js';
