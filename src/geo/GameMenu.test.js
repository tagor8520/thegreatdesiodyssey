import test from 'node:test';
import assert from 'node:assert/strict';
import { GDO_GAME_MENU_TABS, createGameMenu } from './GameMenu.js';
import { createGameSettings } from '../launcher/GameSettings.js';
import { createLauncherActionRegistry } from '../launcher/actions.js';

/**
 * The pause menu's contract: it is the only thing that can freeze the session,
 * it says what the settings will do, and it offers exactly two ways out.
 *
 * The menu builds into a forty-line fake element for the same reason the launcher
 * does — its wiring is innerHTML plus three delegated listeners, and the parts
 * worth asserting are the state machine and the refusals, not the paint.
 */

function fakeElement(tag = 'div') {
  const listeners = new Map();
  const element = {
    tagName: tag.toUpperCase(),
    innerHTML: '',
    hidden: false,
    className: '',
    removed: false,
    attributes: {},
    ownerDocument: null,
    appendChild(node) { element.child = node; return node; },
    setAttribute(name, value) { element.attributes[name] = value; },
    removeAttribute(name) { delete element.attributes[name]; },
    addEventListener(type, handler) { listeners.set(type, [...(listeners.get(type) ?? []), handler]); },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry !== handler));
    },
    querySelector(selector) { return element.nodes?.[selector] ?? null; },
    querySelectorAll: () => [],
    focus() { element.focused = true; },
    remove() { element.removed = true; },
    dispatch(type, event) { for (const handler of listeners.get(type) ?? []) handler(event); },
    listenerCount: type => (listeners.get(type) ?? []).length,
  };
  return element;
}

function target(dataset) {
  const node = {
    dataset,
    matches: () => false,
    closest: selector => (selector === '[data-menu-action]' ? node : null),
  };
  return node;
}

function mount(overrides = {}) {
  const container = fakeElement('div');
  const document = fakeElement('document');
  document.createElement = () => {
    const element = fakeElement('div');
    element.ownerDocument = document;
    return element;
  };
  container.ownerDocument = document;
  const settings = createGameSettings({ registry: createLauncherActionRegistry() });
  const calls = [];
  const menu = createGameMenu({
    container,
    settings,
    registry: createLauncherActionRegistry(),
    place: { name: 'India Gate', subtitle: 'New Delhi · Delhi NCR' },
    onOpen: () => calls.push('open'),
    onClose: () => calls.push('close'),
    onChangePlace: () => calls.push('change-place'),
    onQuit: () => calls.push('quit'),
    getDiagnostics: () => ({ tileCache: { entries: 12, bytes: 4 * 1024 * 1024, hits: 3, evictions: 1 } }),
    ...overrides,
  });
  return { container, document, settings, menu, calls, root: menu.element };
}

test('the menu starts closed, and opening reports to the host that owns the pause', () => {
  const { menu, calls, root, document } = mount();
  assert.equal(menu.namespace, 'gdo:gameMenu:v1');
  assert.equal(root.hidden, true);
  assert.equal(root.attributes.role, 'dialog');
  assert.equal(root.attributes['aria-modal'], 'true');
  assert.equal(menu.isOpen, false);
  assert.deepEqual(calls, []);

  assert.equal(menu.open(), true);
  assert.equal(menu.isOpen, true);
  assert.equal(root.hidden, false);
  assert.deepEqual(calls, ['open']);
  assert.match(root.innerHTML, /Paused/, 'the dialog names its state');
  assert.match(root.innerHTML, /India Gate/, 'and the place it froze');
  for (const tab of GDO_GAME_MENU_TABS) assert.match(root.innerHTML, new RegExp(tab.label));
  assert.match(root.innerHTML, /Resume/);
  assert.match(root.innerHTML, /Change place/);
  assert.match(root.innerHTML, /Quit to title/);
  // Opening twice is a no-op rather than a second stack of overlays.
  assert.equal(menu.open(), true);
  assert.deepEqual(calls, ['open']);
  // The document owns the keyboard for the dialog.
  assert.ok(document.listenerCount('keydown') > 0);
});

test('tabs swap the panel, and the session tab reads the live cache', () => {
  const { menu, root } = mount();
  menu.open();
  assert.match(root.innerHTML, /Quality profile/, 'Options is the first tab');
  assert.equal(menu.tab, 'options');

  root.dispatch('click', { target: target({ menuAction: 'tab', tab: 'controls' }) });
  assert.equal(menu.tab, 'controls');
  assert.match(root.innerHTML, /data-control="jump"/);
  assert.match(root.innerHTML, /one registry|One registry/i);

  root.dispatch('click', { target: target({ menuAction: 'tab', tab: 'session' }) });
  assert.match(root.innerHTML, /12 chunks/, 'the cache numbers come from the world');
  assert.match(root.innerHTML, /4 MB stored/);
  assert.match(root.innerHTML, /frozen while this menu is open/);
});

test('Escape closes the menu; the two ways out reach the host', () => {
  const { menu, calls, root } = mount();
  menu.open();
  menu.element; // the dialog listens on the document it was built into
  const document = root.ownerDocument;
  document.dispatch('keydown', { code: 'Escape', preventDefault() {} });
  assert.equal(menu.isOpen, false);
  assert.deepEqual(calls, ['open', 'close']);

  menu.open();
  root.dispatch('click', { target: target({ menuAction: 'change-place' }) });
  assert.equal(menu.isOpen, false);
  assert.deepEqual(calls, ['open', 'close', 'open', 'close', 'change-place']);

  menu.open();
  root.dispatch('click', { target: target({ menuAction: 'quit' }) });
  assert.deepEqual(calls.at(-1), 'quit');
  assert.equal(menu.isOpen, false);
});

test('a setting changed inside the menu is applied live and announced once', () => {
  const writes = [];
  const { menu, settings, root } = mount();
  menu.open();
  root.dispatch('change', { target: { dataset: { action: 'set-toggle', setting: 'cameraFade' }, checked: false } });
  assert.equal(settings.settings.cameraFade, false);
  root.dispatch('change', { target: { dataset: { action: 'set-profile' }, value: 'high' } });
  assert.equal(settings.settings.profile, 'high');
  assert.match(root.innerHTML, /will apply the next time a place loads/);
  // The menu never wrote the save itself: the settings model is the only writer.
  assert.deepEqual(writes, []);
});

test('rebinding works in the menu exactly as it does on the front page', () => {
  const { menu, root, settings } = mount();
  menu.open();
  root.dispatch('click', { target: target({ menuAction: 'tab', tab: 'controls' }) });
  root.dispatch('click', { target: target({ menuAction: 'rebind', control: 'jump' }) });
  assert.match(root.innerHTML, /Press a key…/);

  root.ownerDocument.dispatch('keydown', { code: 'KeyJ', preventDefault() {} });
  assert.deepEqual(settings.registry.action('jump').keyboard, ['KeyJ']);
  assert.match(root.innerHTML, /Binding updated/);

  root.dispatch('click', { target: target({ menuAction: 'rebind', control: 'jump' }) });
  root.ownerDocument.dispatch('keydown', { code: 'KeyW', preventDefault() {} });
  assert.deepEqual(settings.registry.action('jump').keyboard, ['KeyJ'], 'a conflict is refused');
  assert.match(root.innerHTML, /already used/);

  root.dispatch('click', { target: target({ menuAction: 'reset-bindings' }) });
  assert.deepEqual(settings.registry.action('jump').keyboard, ['Space']);
});

test('dispose closes the dialog and detaches every listener', () => {
  const { menu, root, container } = mount();
  menu.open();
  menu.dispose();
  assert.equal(menu.isOpen, false);
  assert.equal(root.removed, true);
  assert.equal(root.listenerCount('click'), 0);
  assert.equal(root.listenerCount('change'), 0);
  assert.equal(container.child, root);
  // A disposed menu cannot reopen a session it no longer owns.
  assert.equal(menu.open(), true, 'open() still answers, but it is detached');
  menu.close();
});
