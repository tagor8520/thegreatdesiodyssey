/**
 * `GME-05` — shared interaction/action registry conformance.
 *
 * The registered gate reads: *desktop/touch/UI expose every registered gameplay
 * action.* That sentence has three parts and each can fail on its own, so each is
 * asserted separately:
 *
 * 1. **The registry is consistent.** Unique codes per runtime, a declared kind and
 *    surface for every action, and no action claiming a surface it cannot reach.
 *    The code-collision check is the one that matters: two actions sharing a key
 *    in one runtime is silent — whichever the lookup reaches first wins and the
 *    other becomes unreachable with no error anywhere.
 * 2. **Every surface reaches every action it claims.** Both runtimes are checked
 *    against a declared group floor, which is the assertion that would have caught
 *    the curated runtime shipping with no touch controls at all.
 * 3. **The rendered controls match the declaration.** The markup is generated from
 *    the registry, so the DOM can be parsed in Node and compared to the registry
 *    without a browser: every declared touch action has a control, every control
 *    names a registered action, and buttons carry their own placement so the
 *    stylesheet needs no per-action rules.
 *
 * `ActionInput` gets its own behavioural tests, because a registry that is never
 * consulted is documentation rather than a contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTION_RUNTIMES, ACTION_SURFACES, GAMEPLAY_ACTIONS, REGISTERED_ACTIONS,
  slotForAction, uiSelector,
  REQUIRED_ACTION_GROUPS, ActionInput, ActionRegistryError,
  actionForCode, actionsForRuntime, actionsForSurface, assertActionRegistry,
  codeMapForRuntime, codesFor, describeRegistry, isHold, isRegisteredAction,
  isTap, requireRuntimeAction, touchActionsForRuntime,
} from '../engine/ActionRegistry.js';
import { touchControlsMarkup } from '../engine/TouchControls.js';

/** Minimal DOM stand-ins: the module under test needs events, not a browser. */
class StubTarget extends EventTarget {
  constructor() { super(); this.defaultPrevented = 0; }
}

function keyEvent(code, { repeat = false, target = null, ...modifiers } = {}) {
  return {
    code, repeat, target,
    ctrlKey: false, metaKey: false, altKey: false, ...modifiers,
    preventDefault() { this.defaultPrevented = true; },
  };
}

test('the registry is internally consistent', () => {
  assert.doesNotThrow(() => assertActionRegistry());
  const report = describeRegistry();
  assert.equal(report.actions, REGISTERED_ACTIONS.length);
  assert.ok(REGISTERED_ACTIONS.length > 0);
});

test('no keyboard code is bound to two actions in one runtime', () => {
  // Stated as its own test because this is the failure that is invisible at
  // runtime: the losing action simply never fires.
  for (const runtime of ACTION_RUNTIMES) {
    const seen = new Map();
    for (const [code, action] of codeMapForRuntime(runtime)) {
      assert.equal(seen.has(code), false, `${runtime}: ${code} is bound by both ${seen.get(code)} and ${action}`);
      seen.set(code, action);
    }
  }
});

test('every action declares a kind, a surface and a reachable code', () => {
  for (const action of REGISTERED_ACTIONS) {
    const definition = GAMEPLAY_ACTIONS[action];
    assert.ok(['hold', 'tap'].includes(definition.kind), `${action} kind`);
    assert.ok(definition.label?.length > 0, `${action} label`);
    assert.ok(definition.surfaces.length > 0, `${action} surfaces`);
    assert.ok(definition.codes.length > 0, `${action} must be reachable from the keyboard`);
    for (const surface of definition.surfaces) assert.ok(ACTION_SURFACES.includes(surface), `${action}/${surface}`);
    if (definition.surfaces.includes('touch')) {
      assert.ok(definition.touch, `${action} claims touch without a control`);
      assert.ok(['button', 'joystick'].includes(definition.touch.control), `${action} touch control kind`);
    }
    if (definition.touch?.control === 'button') {
      // 44px is the platform minimum touch target. This was not theoretical: the
      // first version left the size to the stylesheet and rendered RUN and MAP
      // 15px tall on a 390px-wide phone.
      assert.ok(Number.isFinite(definition.touch.size), `${action} button must declare a size`);
      assert.ok(definition.touch.size >= 44, `${action} button is ${definition.touch.size}px, below the 44px minimum`);
      assert.ok(definition.touch.text?.length > 0, `${action} button must have label text`);
    }
  }
});

test('each runtime exposes every action group it declares, per surface', () => {
  for (const runtime of ACTION_RUNTIMES) {
    for (const [surface, groups] of Object.entries(REQUIRED_ACTION_GROUPS[runtime])) {
      const covered = new Set(actionsForSurface(runtime, surface).map(action => GAMEPLAY_ACTIONS[action].group));
      for (const group of groups) {
        assert.ok(covered.has(group), `${runtime} exposes no ${group} action on the ${surface} surface`);
      }
    }
  }
  // The specific regression: curated had no touch surface whatsoever.
  const curatedTouch = touchActionsForRuntime('curated');
  assert.ok(curatedTouch.length >= 5, `curated must expose touch controls, found ${curatedTouch.length}`);
  assert.ok(curatedTouch.includes('jump'), 'curated touch must include jump');
  assert.ok(curatedTouch.includes('run'), 'curated touch must include run');
  for (const action of ['forward', 'back', 'left', 'right']) {
    assert.ok(curatedTouch.includes(action), `curated touch must include ${action}`);
  }
});

test('rendered touch controls match the registry exactly', () => {
  for (const runtime of ACTION_RUNTIMES) {
    const html = touchControlsMarkup(runtime, { mobile: true });
    const rendered = [...html.matchAll(/data-action="([a-z0-9]+)"/g)].map(match => match[1]).sort();
    const declared = touchActionsForRuntime(runtime).filter(action => GAMEPLAY_ACTIONS[action].touch?.control === 'button').sort();
    assert.deepEqual(rendered, declared, `${runtime} button set must equal its registered touch buttons`);

    // A joystick, if declared, must actually be rendered — and vice versa: a
    // joystick zone with no joystick actions is dead markup.
    const declaresJoystick = touchActionsForRuntime(runtime).some(action => GAMEPLAY_ACTIONS[action].touch?.control === 'joystick');
    assert.equal(/data-action-zone="joystick"/.test(html), declaresJoystick, `${runtime} joystick presence must match the registry`);
    assert.match(html, new RegExp(`data-runtime="${runtime}"`));
    // Non-mobile markup must render as hidden, or a desktop player gets a joystick.
    assert.match(touchControlsMarkup(runtime, { mobile: false }), /data-mobile="false"/);
  }
});

test('a control can never name an action the runtime does not have', () => {
  const coordinateOnly = REGISTERED_ACTIONS.filter(action => !GAMEPLAY_ACTIONS[action].runtimes.includes('curated'));
  assert.ok(coordinateOnly.length > 0, 'the fixture set must contain a runtime-specific action for this to prove anything');
  for (const action of coordinateOnly) {
    assert.throws(() => requireRuntimeAction(action, 'curated'), ActionRegistryError,
      `${action} must be rejected by the curated runtime`);
    assert.equal(touchControlsMarkup('curated').includes(`data-action="${action}"`), false);
  }
  assert.equal(actionForCode('no-such-code', 'curated'), null);
});

test('codes resolve per runtime, not globally', () => {
  // `KeyM` is map mode in curated and nothing at all in coordinate mode: a global
  // lookup would hand the coordinate player an action its runtime has no handler for.
  assert.equal(actionForCode('KeyM', 'curated'), 'map');
  assert.equal(actionForCode('KeyM', 'coordinates'), null);
  assert.equal(actionForCode('F3', 'coordinates'), 'debug');
  assert.equal(actionForCode('F3', 'curated'), null);
  assert.equal(actionForCode('KeyV', 'coordinates'), 'camera');
  for (const runtime of ACTION_RUNTIMES) {
    assert.equal(actionForCode('KeyW', runtime), 'forward');
    assert.equal(actionForCode('ArrowRight', runtime), 'right');
  }
  assert.equal(isRegisteredAction('forward'), true);
  assert.equal(isRegisteredAction('Forward'), false);
  assert.equal(isRegisteredAction(null), false);
  assert.equal(isTap('jump'), true);
  assert.equal(isHold('jump'), false);
  assert.deepEqual(codesFor('run'), ['ShiftLeft', 'ShiftRight']);
  assert.equal(describeRegistry().entries.every(entry => REGISTERED_ACTIONS.includes(entry.action)), true);
});

test('ActionInput tracks held state and fires taps without repeating', () => {
  const target = new StubTarget();
  const fired = [];
  const input = new ActionInput({
    runtime: 'curated', target, document: null,
    onAction: action => fired.push(action),
  });
  try {
    assert.equal(input.handleKeydown(keyEvent('KeyW')), true);
    assert.equal(input.active('forward'), true);
    assert.equal(input.active('back'), false);
    input.handleKeyup(keyEvent('KeyW'));
    assert.equal(input.active('forward'), false);
    // Arrows are the same action, so either binding drives the same state.
    input.handleKeydown(keyEvent('ArrowUp'));
    assert.equal(input.active('forward'), true);
    input.handleKeyup(keyEvent('ArrowUp'));

    assert.equal(input.handleKeydown(keyEvent('Space')), true);
    assert.deepEqual(fired, ['jump']);
    // Auto-repeat must not re-fire a tap, or holding jump bunny-hops.
    input.handleKeydown(keyEvent('Space', { repeat: true }));
    assert.deepEqual(fired, ['jump']);
    input.handleKeyup(keyEvent('Space'));

    assert.equal(input.handleKeydown(keyEvent('KeyM')), true);
    assert.deepEqual(fired, ['jump', 'map']);
    assert.equal(input.active('map'), false, 'a tap action is not left held');

    // An action this runtime does not have is not handled at all.
    assert.equal(input.handleKeydown(keyEvent('F3')), false);
    assert.equal(input.diagnostics.unknownCodes, 1);
    assert.equal(input.active('debug'), false);
  } finally { input.dispose(); }
});

test('ActionInput refuses to fire an action from another runtime or a typo', () => {
  const input = new ActionInput({ runtime: 'curated', target: new StubTarget(), document: null });
  try {
    assert.throws(() => input.setVirtual('camera', true), ActionRegistryError, 'camera is coordinate-only');
    assert.throws(() => input.setVirtual('jumpz', true), ActionRegistryError, 'a typo must throw, not no-op');
    assert.doesNotThrow(() => input.setVirtual('map', true));
  } finally { input.dispose(); }
});

test('ActionInput ignores modified keys, text fields and a vetoed state', () => {
  const input = new ActionInput({ runtime: 'curated', target: new StubTarget(), document: null, shouldIgnore: () => false });
  const veto = new ActionInput({ runtime: 'curated', target: new StubTarget(), document: null, shouldIgnore: () => true });
  try {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      assert.equal(input.handleKeydown(keyEvent('KeyW', { [modifier]: true })), false, modifier);
    }
    assert.equal(input.active('forward'), false);
    const inField = { closest: selector => selector.includes('input') };
    assert.equal(input.handleKeydown(keyEvent('KeyW', { target: inField })), false, 'typing in a text field must not move the player');
    // A recognised action that the owner vetoed is *not* consumed: nothing
    // happened, and the event should be left for whatever else wants it.
    assert.equal(veto.handleKeydown(keyEvent('KeyW')), false);
    assert.equal(veto.diagnostics.ignored, 1, 'the press is recorded as ignored, not as unknown');
    assert.equal(veto.diagnostics.unknownCodes, 0, 'an ignored action must not inflate the unknown-key count');
    assert.equal(veto.active('forward'), false, 'and it must not become active');
    veto.handleKeydown(keyEvent('KeyQ'));
    assert.equal(veto.diagnostics.unknownCodes, 1, 'a key this runtime does not bind is unknown, even while vetoed');
  } finally { input.dispose(); veto.dispose(); }
});

test('ActionInput clears on blur, on dispose, and reports a snapshot', () => {
  const target = new StubTarget();
  let blurs = 0;
  const input = new ActionInput({
    runtime: 'coordinates', target, document: null, onBlur: () => { blurs++; },
  });
  input.handleKeydown(keyEvent('KeyW'));
  input.setVirtual('run', true);
  input.setAnalog(.5, -.5);
  const snapshot = input.snapshot();
  assert.equal(snapshot.held, 1);
  assert.deepEqual(snapshot.virtual, ['run']);
  assert.deepEqual(snapshot.analog, { x: .5, z: -.5 });

  target.dispatchEvent(new Event('blur'));
  assert.equal(blurs, 1, 'the owner is told, so it can reset velocity without a second listener');
  assert.equal(input.keys.size, 0);
  assert.equal(input.virtual.size, 0);
  assert.deepEqual(input.analog, { x: 0, z: 0 });

  input.handleKeydown(keyEvent('KeyD'));
  input.dispose();
  assert.equal(input.active('right'), false);
  // After dispose the object is inert: further events are ignored rather than
  // throwing, because a late event from a removed listener must not crash a page.
  assert.equal(input.handleKeydown(keyEvent('KeyD')), false);
  assert.equal(input.active('right'), false);
});

test('the ui surface is real, not just declared', () => {
  // `ui` in `surfaces` means a control in the mounted DOM. The selector is derived
  // from the registry so the markup carries the same number the registry does.
  const uiActions = REGISTERED_ACTIONS.filter(action => GAMEPLAY_ACTIONS[action].surfaces.includes('ui'));
  assert.deepEqual(uiActions, ['selectSlot1', 'selectSlot2', 'selectSlot3']);
  for (const [index, action] of uiActions.entries()) {
    assert.equal(slotForAction(action), index, `${action} slot`);
    assert.equal(uiSelector(action), `[data-slot="${index + 1}"]`);
  }
  assert.equal(slotForAction('jump'), -1);
  assert.equal(uiSelector('forward'), null);
  // Every ui action is also on the keyboard, so the two surfaces select the same
  // thing — a ui-only action would be unreachable for a keyboard player.
  for (const action of uiActions) assert.ok(GAMEPLAY_ACTIONS[action].codes.length > 0);
});

test('nothing outside the registry declares a gameplay keymap', () => {
  // The gate is "one named surface", and a second `['Digit1','Digit2','Digit3']`
  // array in a React component is exactly what breaks it: the two lists are free
  // to disagree and no runtime error would ever say so. This test reads the source
  // instead of the behaviour, because the failure mode is a *new* call site, which
  // no amount of runtime testing can enumerate.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  // `AGENTS.md`: `src/world/`, `src/ui/` and the legacy `src/engine/` controllers
  // are reachable only from `/classic.html`, the frozen explorer, and no new work
  // goes there. They keep their own keymaps on purpose; the current runtimes may not.
  const FROZEN_LEGACY = ['src/main.js', 'src/ui/', 'src/world/', 'src/network/',
    'src/engine/PlayerController.js', 'src/engine/LerpPlayerController.js'];
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!/\.(js|jsx)$/.test(entry) || /\.test\.js$/.test(entry)) continue;
      const relativePath = relative(root, path).split('\\').join('/');
      if (FROZEN_LEGACY.some(prefix => relativePath === prefix || relativePath.startsWith(prefix))) continue;
      files.push([relativePath, readFileSync(path, 'utf8')]);
    }
  };
  walk(join(root, 'src'));
  assert.ok(files.length > 10, `expected to scan the source tree, found ${files.length} file(s)`);

  const offenders = [];
  for (const code of REGISTERED_ACTIONS.flatMap(action => GAMEPLAY_ACTIONS[action].codes)) {
    // `ActionRegistry.js` is the keymap; it is the one file allowed to name a code.
    for (const [relativePath, contents] of files) {
      if (relativePath === 'src/engine/ActionRegistry.js') continue;
      if (contents.includes(`'${code}'`) || contents.includes(`"${code}"`)) {
        offenders.push(`${relativePath} names ${code} directly`);
      }
    }
  }
  assert.deepEqual(offenders, [], `gameplay keys must come from the registry:\n  ${offenders.join('\n  ')}`);
});

test('dispose removes every listener it registered', () => {
  // `FND-07` counts listeners; an input object that leaves its keydown handler on
  // `window` is exactly the leak that gate exists to catch.
  const target = new StubTarget();
  let added = 0, removed = 0;
  const originalAdd = target.addEventListener.bind(target);
  const originalRemove = target.removeEventListener.bind(target);
  target.addEventListener = (...args) => { added++; return originalAdd(...args); };
  target.removeEventListener = (...args) => { removed++; return originalRemove(...args); };
  const input = new ActionInput({ runtime: 'curated', target, document: null });
  assert.equal(added, 3, 'keydown, keyup and blur');
  input.dispose();
  assert.equal(removed, 3);
  assert.equal(added - removed, 0);
});
