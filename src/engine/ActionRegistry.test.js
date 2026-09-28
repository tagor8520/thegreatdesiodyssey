import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_ACTION_KIND,
  keyName,
  GDO_ACTION_LIMITS,
  GDO_ACTION_NAMESPACE,
  actionCapabilitiesForDomain,
  createActionRegistry,
} from './ActionRegistry.js';
import { GDO_COORDINATE_PLAYER_DOMAIN } from '../geo/GeoPlayer.js';
import { GDO_CURATED_PLAYER_DOMAIN } from '../reference/Player.js';
import { featureNamespace } from './FeatureVersions.js';

/**
 * `GME-05` gate: one registry describes every gameplay action, and every surface
 * (desktop, touch, UI) reads it. `GME-03`'s "future actions must auto-register"
 * is the same gate seen from the touch pad.
 */

test('the default registry declares the shipped actions on every surface', () => {
  assert.equal(GDO_ACTION_NAMESPACE, 'gdo:actionRegistry:v1');
  assert.equal(featureNamespace('actionRegistry'), GDO_ACTION_NAMESPACE);
  const registry = createActionRegistry({ capabilities: actionCapabilitiesForDomain(GDO_COORDINATE_PLAYER_DOMAIN) });
  assert.deepEqual(registry.actions().map(action => action.id), ['move', 'look', 'run', 'jump', 'camera']);
  assert.equal(registry.action('jump').kind, GDO_ACTION_KIND.TAP);
  assert.equal(registry.action('run').kind, GDO_ACTION_KIND.HOLD);

  // Desktop: the movement cluster, run modifiers, jump, and the camera toggle.
  assert.equal(registry.keyboardBinding('KeyW'), 'move');
  assert.equal(registry.keyboardBinding('ArrowLeft'), 'move');
  assert.equal(registry.keyboardBinding('ShiftLeft'), 'run');
  assert.equal(registry.keyboardBinding('Space'), 'jump');
  assert.equal(registry.keyboardBinding('KeyC'), 'camera');
  assert.equal(registry.handlesKey('KeyQ'), false);
  assert.equal(registry.handlesKey('KeyV'), false, 'V stays a player-level camera alias, not a declared code');
  assert.equal(registry.keyboardHint(), 'WASD / arrows: move · Shift: run · Space: jump · V / C: switch camera');
  assert.equal(registry.pointerHint(), 'Drag: look around');
  assert.equal(keyName('ArrowUp'), '↑');
  assert.equal(keyName('KeyQ'), 'Q');
  assert.equal(keyName('Digit3'), '3');
  assert.equal(keyName('F3'), 'F3');

  // Touch and pointer surfaces.
  assert.deepEqual(registry.touchControls().map(control => `${control.id}:${control.control}`),
    ['move:joystick', 'look:drag', 'run:button', 'jump:button', 'camera:button']);
  assert.deepEqual(registry.pointerGestures(), ['drag']);
  assert.deepEqual(registry.surfaces().find(surface => surface.id === 'jump'),
    { id: 'jump', keyboard: ['Space'], pointer: null, touch: 'button' });

  const diagnostics = registry.diagnostics();
  assert.equal(diagnostics.namespace, GDO_ACTION_NAMESPACE);
  assert.equal(diagnostics.registered, 5);
  assert.deepEqual(diagnostics.skipped, []);
  assert.equal(diagnostics.sealed, false);
  assert.equal(diagnostics.touchButtons, 3);
});

test('an action whose domain capability is missing is skipped, not half-wired', () => {
  const withoutJump = createActionRegistry({ capabilities: actionCapabilitiesForDomain({ capabilities: { analogInput: true, pointerLook: true }, cameraModes: ['first-person'] }) });
  assert.deepEqual(withoutJump.actions().map(action => action.id), ['move', 'look', 'run']);
  assert.deepEqual(withoutJump.diagnostics().skipped,
    [{ id: 'jump', reason: 'capability', capability: 'jump' },
      { id: 'camera', reason: 'capability', capability: 'cameraToggle' }]);
  assert.equal(withoutJump.has('jump'), false);
  assert.equal(withoutJump.touchControls().length, 3, 'the joystick and the held run button follow their actions');

  // Both live players declare their own capability sets and both are complete.
  const coordinate = createActionRegistry({ capabilities: actionCapabilitiesForDomain(GDO_COORDINATE_PLAYER_DOMAIN) });
  const curated = createActionRegistry({ capabilities: actionCapabilitiesForDomain(GDO_CURATED_PLAYER_DOMAIN) });
  assert.deepEqual(coordinate.actions().map(action => action.id), curated.actions().map(action => action.id));
  assert.equal(actionCapabilitiesForDomain(GDO_COORDINATE_PLAYER_DOMAIN).cameraToggle, true);
  assert.equal(actionCapabilitiesForDomain(GDO_CURATED_PLAYER_DOMAIN).cameraToggle, true);
  assert.equal(actionCapabilitiesForDomain({}).cameraToggle, false);
  assert.equal(actionCapabilitiesForDomain({ cameraModes: ['map', 'third-person'] }).pointerLook, true);
});

test('a newly registered action auto-registers on every surface', () => {
  const registry = createActionRegistry({ capabilities: actionCapabilitiesForDomain(GDO_COORDINATE_PLAYER_DOMAIN) });
  const before = registry.touchControls().length;
  registry.register({
    id: 'interact', order: 60, kind: GDO_ACTION_KIND.TAP, label: 'Interact',
    capability: 'interaction', keyboard: ['KeyE'], touch: { control: 'button', label: 'USE' },
  });
  // No capability is declared, so it is skipped deterministically.
  assert.equal(registry.has('interact'), false);
  assert.deepEqual(registry.diagnostics().skipped, [{ id: 'interact', reason: 'capability', capability: 'interaction' }]);

  const interactive = createActionRegistry({
    capabilities: { ...actionCapabilitiesForDomain(GDO_COORDINATE_PLAYER_DOMAIN), interaction: true },
  });
  interactive.register({
    id: 'interact', order: 60, kind: GDO_ACTION_KIND.TAP, label: 'Interact',
    capability: 'interaction', keyboard: ['KeyE'], touch: { control: 'button', label: 'USE' },
  });
  assert.equal(interactive.has('interact'), true);
  // Desktop, touch, and the UI descriptor list all gain it together.
  assert.equal(interactive.keyboardBinding('KeyE'), 'interact');
  assert.equal(interactive.touchControls().length, before + 1);
  assert.equal(interactive.touchControls().at(-1).text, 'USE');
  assert.equal(interactive.surfaces().at(-1).id, 'interact');

  // Sealing stops a runtime surface from growing, and the table stays ordered.
  // A skipped action is not registered, so it can be retried once its capability
  // exists; an id that is already live cannot be redefined.
  assert.equal(registry.has('interact'), false);
  registry.register({ id: 'interact', order: 60, kind: GDO_ACTION_KIND.TAP, label: 'Interact', keyboard: ['KeyE'] });
  assert.equal(registry.has('interact'), true);
  assert.throws(() => registry.register({ id: 'interact', kind: GDO_ACTION_KIND.TAP, label: 'Again' }), /Duplicate action id/);
  interactive.seal();
  assert.equal(interactive.sealed, true);
  assert.throws(() => interactive.register({ id: 'later', kind: GDO_ACTION_KIND.TAP, label: 'Later' }), /sealed/);
});

test('caps prune deterministically and name what was dropped', () => {
  const registry = createActionRegistry({
    capabilities: { analogInput: true, jump: true, pointerLook: true, cameraToggle: true, interaction: true },
    limits: { actions: 3, touchButtons: 1, keyboardCodes: GDO_ACTION_LIMITS.keyboardCodes },
  });
  assert.deepEqual(registry.actions().map(action => action.id), ['move', 'look', 'run']);
  const skipped = registry.diagnostics().skipped;
  assert.deepEqual(skipped.filter(entry => entry.reason === 'cap').map(entry => entry.id), ['jump', 'camera']);
  // The action that overflowed the touch-button cap keeps its keyboard binding
  // and loses only the button, which is a declared fallback rather than a crash.
  const tight = createActionRegistry({
    capabilities: { analogInput: true, jump: true, pointerLook: true, cameraToggle: true },
    limits: { actions: 16, touchButtons: 1, keyboardCodes: GDO_ACTION_LIMITS.keyboardCodes },
  });
  assert.equal(tight.action('jump').keyboard.includes('Space'), true);
  assert.equal(tight.action('jump').touch, null);
  assert.deepEqual(tight.diagnostics().skipped, [
    { id: 'jump', reason: 'touch-cap' }, { id: 'camera', reason: 'touch-cap' },
  ]);
  const keyboardTight = createActionRegistry({
    capabilities: { analogInput: true },
    limits: { actions: 16, touchButtons: 8, keyboardCodes: 2 },
  });
  assert.equal(keyboardTight.keyboardCodes().length, 2);
  assert.deepEqual(keyboardTight.keyboardCodes(), ['ShiftLeft', 'ShiftRight']);
  assert.deepEqual(keyboardTight.diagnostics().skipped.filter(entry => entry.reason === 'keyboard-cap'),
    [{ id: 'move', reason: 'keyboard-cap' }]);
  // The move action keeps its joystick, loses its movement keys, and the drop is
  // named; an action that keeps no surface at all is skipped instead (below).
  assert.equal(keyboardTight.action('move').keyboard.length, 0);
  assert.equal(keyboardTight.action('move').touch.control, 'joystick');
  const deadRegistry = createActionRegistry({
    capabilities: { analogInput: true, jump: true, pointerLook: true, cameraToggle: true },
    limits: { actions: 16, touchButtons: 0, keyboardCodes: 0 },
  });
  assert.equal(deadRegistry.action('jump'), null, 'a jump action with no reachable surface is skipped');
  assert.deepEqual(deadRegistry.diagnostics().skipped.filter(entry => entry.id === 'jump'),
    [{ id: 'jump', reason: 'keyboard-cap' }, { id: 'jump', reason: 'touch-cap' }]);
});

test('malformed declarations fail loudly instead of producing a dead control', () => {
  assert.throws(() => createActionRegistry({ actions: [null] }), /must be an object/);
  assert.throws(() => createActionRegistry({ actions: [{ kind: 'tap', label: 'x' }] }), /needs an id/);
  assert.throws(() => createActionRegistry({ actions: [{ id: 'Bad Id', kind: 'tap', label: 'x' }] }), /lower kebab case/);
  assert.throws(() => createActionRegistry({ actions: [{ id: 'ok', kind: 'wiggle', label: 'x' }] }), /unknown kind/);
  assert.throws(() => createActionRegistry({ actions: [{ id: 'ok', kind: 'tap' }] }), /needs a label/);
  assert.throws(() => createActionRegistry({ actions: [{ id: 'ok', kind: 'tap', label: 'x', touch: { control: 'dial' } }] }), /unknown touch control/);
  assert.throws(() => createActionRegistry({ actions: [{ id: 'ok', kind: 'tap', label: 'x', touch: { control: 'button' } }] }), /touch button label/);
  assert.throws(() => createActionRegistry({ actions: [{ id: 'ok', kind: 'tap', label: 'x', keyboard: [''] }] }), /invalid key code/);
  assert.throws(() => createActionRegistry({ actions: [
    { id: 'ok', kind: 'tap', label: 'x' }, { id: 'ok', kind: 'tap', label: 'y' },
  ] }), /Duplicate action id/);
});

test('the action table is order-independent and reproducible', () => {
  const capabilities = actionCapabilitiesForDomain(GDO_COORDINATE_PLAYER_DOMAIN);
  const first = createActionRegistry({ capabilities });
  const reordered = createActionRegistry({ capabilities, actions: [...first.actions()].reverse() });
  assert.deepEqual(first.actions().map(action => action.id), reordered.actions().map(action => action.id));
  assert.deepEqual(first.touchControls(), reordered.touchControls());
  assert.deepEqual(first.keyboardCodes(), reordered.keyboardCodes());
  assert.deepEqual(first.diagnostics(), reordered.diagnostics());
  const third = createActionRegistry({ capabilities });
  assert.deepEqual(first.surfaces(), third.surfaces());
});
