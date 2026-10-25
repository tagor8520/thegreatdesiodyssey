import test from 'node:test';
import assert from 'node:assert/strict';
import { mountLauncher } from './Launcher.js';
import { createGameSettings } from './GameSettings.js';
import { createLauncherActionRegistry } from './actions.js';
import { createLauncherStorage } from './LauncherStorage.js';
import { GDO_LOCATIONS } from './locations.js';
import { GDO_FEATURED_PLACE_IDS } from './Launcher.js';

/**
 * The front page's behaviour, driven through its real handlers.
 *
 * The shell is deliberately DOM-light — innerHTML plus four delegated listeners —
 * so a forty-line fake element is enough to prove the parts that matter: nothing
 * launches by itself, a chosen place is what launches, a refusal is shown in
 * place, and a settings change reaches the host that owns the save.
 */

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
  };
}

function fakeElement() {
  const listeners = new Map();
  const element = {
    innerHTML: '',
    ownerDocument: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, handler) { listeners.set(type, [...(listeners.get(type) ?? []), handler]); },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry !== handler));
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    replaceChildren() { element.innerHTML = ''; },
    dispatch(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event);
      return event;
    },
    listenerCount: type => (listeners.get(type) ?? []).length,
  };
  return element;
}

/** A click target that answers `closest('[data-action]')` with the given dataset. */
function target(dataset) {
  const node = {
    dataset,
    matches: () => false,
    closest: selector => (selector === '[data-action]' ? node : null),
  };
  return node;
}

function mount() {
  const container = fakeElement();
  const document = fakeElement();
  container.ownerDocument = document;
  const storage = memoryStorage();
  const launcherStorage = createLauncherStorage({ storage });
  launcherStorage.load();
  const settings = createGameSettings({ registry: createLauncherActionRegistry() });
  const launches = [];
  const writes = [];
  const launcher = mountLauncher(container, {
    storage,
    settings,
    launcherStorage,
    onLaunch: payload => { launches.push(payload); return true; },
    onSettingsChanged: save => writes.push(save),
    onClearSave: () => ({ ok: true }),
  });
  return { container, document, launcher, launches, writes, launcherStorage, settings };
}

test('the page opens with a deck and no launch of its own', () => {
  const { container, launcher, launches } = mount();
  assert.equal(launcher.screen, 'home');
  assert.match(container.innerHTML, /Choose a place/, 'the headline asks for a decision');
  assert.equal(GDO_FEATURED_PLACE_IDS.length, 4);
  for (const id of GDO_FEATURED_PLACE_IDS) {
    assert.ok(container.innerHTML.includes(`data-place="${id}"`), `${id} is a featured card`);
  }
  assert.match(container.innerHTML, /What is actually in the build/);
  assert.equal(launches.length, 0, 'nothing mounted on load');
  assert.equal(container.innerHTML.includes('aria-pressed="true"'), false, 'nothing selected');
});

test('navigation swaps screens and keeps the state that matters', () => {
  const { container, launcher } = mount();
  container.dispatch('click', { preventDefault() {}, target: target({ action: 'nav', screen: 'options' }) });
  assert.equal(launcher.screen, 'options');
  assert.match(container.innerHTML, /Quality profile/);
  assert.match(container.innerHTML, /Motion and effects/);

  container.dispatch('click', { preventDefault() {}, target: target({ action: 'nav', screen: 'places' }) });
  assert.equal(launcher.screen, 'places');
  for (const location of GDO_LOCATIONS) {
    assert.ok(container.innerHTML.includes(`data-place="${location.id}"`), `${location.id} is in the full deck`);
  }
  assert.match(container.innerHTML, /Or enter coordinates/, 'the advanced path is still there');

  container.dispatch('click', { preventDefault() {}, target: target({ action: 'nav', screen: 'controls' }) });
  assert.match(container.innerHTML, /data-control="jump"/);
  container.dispatch('click', { preventDefault() {}, target: target({ action: 'nav', screen: 'credits' }) });
  assert.match(container.innerHTML, /OpenStreetMap/);
  // An unknown screen is refused rather than blanking the page.
  assert.equal(launcher.showScreen('nope'), false);
  assert.equal(launcher.screen, 'credits');
});

test('choosing a place is a separate act from launching it', () => {
  const { container, launcher, launches, launcherStorage } = mount();
  container.dispatch('click', { preventDefault() {}, target: target({ action: 'select-place', place: 'varanasi-ghat' }) });
  assert.equal(launcher.state.selectedId, 'varanasi-ghat');
  assert.equal(launches.length, 0, 'selecting does not launch');
  assert.match(container.innerHTML, /Explore Dashashwamedh Ghat/);
  assert.match(container.innerHTML, /aria-pressed="true"/);

  container.dispatch('click', { preventDefault() {}, target: target({ action: 'launch-selected' }) });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].place.kind, 'location');
  assert.equal(launches[0].place.id, 'varanasi-ghat');
  assert.equal(launches[0].place.latitude, 25.3109);
  assert.equal(launches[0].settings.profile, 'low', 'the launch carries the settings the world will read');
  // The launch is remembered, so Continue has something real to offer.
  assert.equal(launcherStorage.state.last.id, 'varanasi-ghat');
  assert.equal(launcher.state.last.id, 'varanasi-ghat');
});

test('the coordinate form launches what was typed, and refuses what was not', () => {
  const { container, launcher, launches } = mount();
  container.dispatch('click', { preventDefault() {}, target: target({ action: 'nav', screen: 'places' }) });
  container.dispatch('input', { target: { name: 'latitude', value: '26.9124' } });
  container.dispatch('input', { target: { name: 'longitude', value: '75.7873' } });
  container.dispatch('submit', { preventDefault() {}, target: { matches: selector => selector === '.gdo-coordinate-form' } });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].place.kind, 'coordinate');
  assert.equal(launches[0].place.latitude, 26.9124);

  // A bad coordinate keeps the player on the page with an explanation.
  container.dispatch('input', { target: { name: 'latitude', value: '400' } });
  container.dispatch('submit', { preventDefault() {}, target: { matches: selector => selector === '.gdo-coordinate-form' } });
  assert.equal(launches.length, 1, 'nothing launched');
  assert.match(launcher.state.message, /Latitude must be between/);
  assert.match(container.innerHTML, /Latitude must be between/);
});

test('a settings change is applied, rendered, and handed to the save owner', () => {
  const { container, launcher, settings, writes } = mount();
  container.dispatch('click', { preventDefault() {}, target: target({ action: 'nav', screen: 'options' }) });

  container.dispatch('change', { target: { dataset: { action: 'set-toggle', setting: 'reducedMotion' }, checked: true } });
  assert.equal(settings.settings.reducedMotion, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].reducedMotion, true);
  assert.equal(writes[0].profile, 'low');

  container.dispatch('change', { target: { dataset: { action: 'set-profile' }, value: 'high' } });
  assert.equal(settings.settings.profile, 'high');
  assert.equal(settings.requiresRelaunch, true);
  assert.equal(writes.at(-1).profile, 'high');
  assert.match(launcher.state.message, /will apply the next time a place loads/);
});

test('rebinding listens for one key and reports a conflict instead of stealing it', () => {
  const { container, document, settings, writes } = mount();
  container.dispatch('click', { preventDefault() {}, target: target({ action: 'nav', screen: 'controls' }) });
  container.dispatch('click', { preventDefault() {}, target: target({ action: 'rebind', control: 'jump' }) });
  assert.match(container.innerHTML, /Press a key…/);

  document.dispatch('keydown', { code: 'KeyJ', preventDefault() {} });
  assert.deepEqual(settings.registry.action('jump').keyboard, ['KeyJ']);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].keyBindings, { jump: ['KeyJ'] });
  assert.match(container.innerHTML, /Binding updated/);

  // Now grab a key another action owns.
  container.dispatch('click', { preventDefault() {}, target: target({ action: 'rebind', control: 'jump' }) });
  document.dispatch('keydown', { code: 'KeyW', preventDefault() {} });
  assert.deepEqual(settings.registry.action('jump').keyboard, ['KeyJ'], 'nothing was stolen');
  assert.match(container.innerHTML, /already used/);

  // Escape cancels the capture rather than binding Escape.
  container.dispatch('click', { preventDefault() {}, target: target({ action: 'rebind', control: 'camera' }) });
  document.dispatch('keydown', { code: 'Escape', preventDefault() {} });
  assert.equal(container.innerHTML.includes('Press a key…'), false);

  container.dispatch('click', { preventDefault() {}, target: target({ action: 'reset-bindings' }) });
  assert.deepEqual(settings.registry.action('jump').keyboard, ['Space']);
  assert.match(container.innerHTML, /back to its default/);
});

test('a failed mount reports itself and leaves the launcher usable', () => {
  const container = fakeElement();
  container.ownerDocument = fakeElement();
  const settings = createGameSettings({ registry: createLauncherActionRegistry() });
  const launcherStorage = createLauncherStorage({ storage: memoryStorage() });
  const launcher = mountLauncher(container, {
    settings,
    launcherStorage,
    onLaunch: () => false,
  });
  launcher.launch({ kind: 'location', id: 'delhi-india-gate' });
  assert.match(launcher.state.message, /could not start/);
  assert.match(container.innerHTML, /could not start/);
  assert.equal(launcher.screen, 'home', 'the page is still there to try again');
});

test('dispose detaches every listener it added', () => {
  const { container, document, launcher } = mount();
  assert.ok(container.listenerCount('click') > 0);
  assert.ok(document.listenerCount('keydown') > 0);
  launcher.dispose();
  assert.equal(container.listenerCount('click'), 0);
  assert.equal(container.listenerCount('change'), 0);
  assert.equal(document.listenerCount('keydown'), 0);
  assert.equal(container.innerHTML, '');
  launcher.show();
  assert.equal(container.innerHTML, '', 'a disposed launcher cannot paint over a mounted game');
});
