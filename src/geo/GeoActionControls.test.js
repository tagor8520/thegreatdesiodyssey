import test from 'node:test';
import assert from 'node:assert/strict';
import { GDO_ACTION_KIND, actionCapabilitiesForDomain, createActionRegistry } from '../engine/ActionRegistry.js';
import { GDO_COORDINATE_PLAYER_DOMAIN } from './GeoPlayer.js';
import { createTouchActionControls, touchActionMarkup } from './GeoActionControls.js';

/**
 * `GME-03` gate: the device surface is generated from the shared registry, so a
 * future action reaches the touch pad and the keyboard filter together.
 */

function fakeButton(id, kind = 'hold') {
  const attribute = kind === 'tap' ? 'data-tap-action' : 'data-hold-action';
  const listeners = new Map();
  const classes = new Set();
  return {
    dataset: { [kind === 'tap' ? 'tapAction' : 'holdAction']: id },
    className: '',
    classes,
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
    },
    addEventListener(type, handler) { listeners.set(`${type}`, handler); },
    removeEventListener(type) { listeners.delete(`${type}`); },
    setPointerCapture() {},
    fire(type, event = {}) { listeners.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event }); },
    get listeners() { return listeners; },
    attribute,
  };
}

function fakeContainer(buttons) {
  const bySelector = new Map(buttons.map(button => [`.geo-actions [${button.attribute}="${button.dataset[button.attribute === 'data-tap-action' ? 'tapAction' : 'holdAction']}"]`, button]));
  return {
    buttons,
    querySelector(selector) {
      if (bySelector.has(selector)) return bySelector.get(selector);
      const match = selector.match(/"([^"]+)"/);
      return buttons.find(button => button.dataset.holdAction === match?.[1] || button.dataset.tapAction === match?.[1]) ?? null;
    },
  };
}

test('the touch markup is generated from the registry, not hand-written', () => {
  const registry = createActionRegistry({ capabilities: actionCapabilitiesForDomain(GDO_COORDINATE_PLAYER_DOMAIN) });
  const markup = touchActionMarkup(registry.touchControls());
  assert.match(markup, /data-hold-action="run" aria-label="Run">RUN<\/button>/);
  assert.match(markup, /class="geo-jump" data-tap-action="jump" aria-label="Jump">JUMP<\/button>/);
  assert.match(markup, /data-tap-action="camera" aria-label="Switch camera">TPP<\/button>/);
  assert.equal(markup.includes('joystick'), false, 'the joystick is fixed markup, not a button');
  assert.equal(touchActionMarkup([]), '', 'a registry with no buttons renders nothing');
  assert.equal(touchActionMarkup(undefined), '');

  // A future action's button appears with no UI change, and its text is escaped.
  registry.register({
    id: 'interact', order: 60, kind: GDO_ACTION_KIND.TAP, label: 'Interact <now>',
    keyboard: ['KeyE'], touch: { control: 'button', label: '<USE>' },
  });
  const extended = touchActionMarkup(registry.touchControls());
  assert.match(extended, /data-tap-action="interact"/);
  assert.match(extended, /aria-label="Interact &lt;now&gt;"/);
  assert.equal(extended.includes('<USE>'), false, 'button text is escaped');
  assert.match(extended, /&lt;USE&gt;/);
});

test('every registered control is wired through the lifecycle ledger', () => {
  const registry = createActionRegistry({ capabilities: actionCapabilitiesForDomain(GDO_COORDINATE_PLAYER_DOMAIN) });
  const container = fakeContainer([fakeButton('run'), fakeButton('jump', 'tap'), fakeButton('camera', 'tap')]);
  const events = [];
  const ledgerListeners = [];
  const ledger = {
    listener(target, type, handler, options) {
      ledgerListeners.push(`${type}`);
      target.addEventListener(type, handler, options);
      return handler;
    },
  };
  const controls = createTouchActionControls({
    container, registry, lifecycle: ledger,
    onAction: (id, phase) => events.push(`${id}:${phase}`),
  });
  assert.deepEqual(controls.diagnostics, { registered: 5, wired: 3 });
  // Held buttons take down/up/cancel/lost-capture; tap buttons take click plus a
  // swallowing pointerdown. Everything goes through the ledger, nothing else.
  assert.deepEqual(ledgerListeners.slice().sort(),
    ['click', 'click', 'lostpointercapture', 'pointercancel', 'pointerdown', 'pointerdown', 'pointerdown', 'pointerup']);

  const [run, jump, camera] = container.buttons;
  run.fire('pointerdown');
  assert.deepEqual(events, ['run:hold']);
  assert.equal(run.classes.has('is-active'), true);
  run.fire('pointerup');
  assert.deepEqual(events, ['run:hold', 'run:release']);
  assert.equal(run.classes.has('is-active'), false);
  run.fire('pointercancel');
  assert.deepEqual(events.at(-1), 'run:release');
  jump.fire('click');
  camera.fire('click');
  assert.deepEqual(events.slice(-2), ['jump:tap', 'camera:tap']);

  controls.dispose();
  assert.equal(controls.buttons.length, 0);
});

test('a newly registered action is wired without touching this helper', () => {
  const registry = createActionRegistry({ capabilities: actionCapabilitiesForDomain(GDO_COORDINATE_PLAYER_DOMAIN) });
  registry.register({
    id: 'interact', order: 60, kind: GDO_ACTION_KIND.HOLD, label: 'Interact',
    keyboard: ['KeyE'], touch: { control: 'button', label: 'USE' },
  });
  const container = fakeContainer([fakeButton('run'), fakeButton('interact')]);
  const events = [];
  const controls = createTouchActionControls({ container, registry, onAction: (id, phase) => events.push(`${id}:${phase}`) });
  assert.equal(controls.diagnostics.wired, 2);
  container.buttons.at(-1).fire('pointerdown');
  assert.deepEqual(events, ['interact:hold']);
  assert.throws(() => createTouchActionControls({ container, registry }), /action callback/);
  assert.throws(() => createTouchActionControls({ registry, onAction() {} }), /container/);
});
