import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_PANELS_NAMESPACE,
  GDO_LAUNCH_NOTE,
  attributionMarkup,
  bindingLabel,
  controlsMarkup,
  coordinateFormMarkup,
  displayOptionsMarkup,
  escapeHtml,
  featureCardsMarkup,
  locationCardMarkup,
  locationDeckMarkup,
  primaryActionMarkup,
  projectLinksMarkup,
  recentsMarkup,
  whatsNewMarkup,
} from './Panels.js';
import { GDO_LOCATIONS } from './locations.js';
import { createLauncherActionRegistry } from './actions.js';
import { createGameSettings } from './GameSettings.js';
import { GDO_FEATURE_CARDS, GDO_WHATS_NEW } from './siteContent.js';

/**
 * The panels are pure strings, so the whole menu surface can be asserted without
 * a browser. What matters here is not "it renders" but the promises the markup
 * makes: every place is offered, nothing is preselected, a setting is bound to a
 * real key, and no value reaches the document unescaped.
 */

test('the deck offers every catalogue place, grouped, with none preselected', () => {
  const markup = locationDeckMarkup({});
  assert.equal(GDO_PANELS_NAMESPACE, 'gdo:panels:v1');
  for (const location of GDO_LOCATIONS) {
    assert.ok(markup.includes(`data-place="${location.id}"`), `${location.id} is offered`);
    assert.ok(markup.includes(location.name), `${location.name} is labelled`);
  }
  // Selection is an explicit state, and no card starts selected or checked.
  assert.equal(markup.includes('is-selected'), false);
  assert.equal(markup.includes('aria-pressed="true"'), false);
  assert.equal(markup.includes('checked'), false);
  assert.equal(markup.includes('autofocus'), false);
  assert.equal(locationCardMarkup(GDO_LOCATIONS[0], { selected: true }).includes('aria-pressed="true"'), true);
});

test('every value that reaches markup is escaped', () => {
  assert.equal(escapeHtml('<script>alert("x")</script> & \''),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;');
  const hostile = locationCardMarkup({ id: 'x"onload="y', name: '<b>Bold</b>', city: 'A&B', region: 'R', blurb: '"><img>', latitude: 1, longitude: 2 });
  assert.equal(hostile.includes('<b>Bold</b>'), false);
  assert.equal(hostile.includes('<img>'), false);
  assert.equal(hostile.includes('id="x"onload="y"'), false);
});

test('the headline action says what it will do, and starts nothing by default', () => {
  const fresh = primaryActionMarkup({});
  assert.match(fresh, /Choose a place/);
  assert.equal(fresh.includes('launch-selected'), false);
  const resumed = primaryActionMarkup({ last: { name: 'India Gate' } });
  assert.match(resumed, /Continue at India Gate/);
  const chosen = primaryActionMarkup({ selected: { name: 'Charminar' } });
  assert.match(chosen, /Explore Charminar/);
  assert.match(GDO_LAUNCH_NOTE, /loads only after you choose/);
});

test('the options panel binds every declared toggle and profile to a control', () => {
  const settings = createGameSettings({ registry: createLauncherActionRegistry() });
  const markup = displayOptionsMarkup(settings.snapshot());
  for (const profile of ['low', 'balanced', 'high']) {
    assert.ok(markup.includes(`data-action="set-profile"`) && markup.includes(`value="${profile}"`), `${profile} is offered`);
  }
  assert.equal((markup.match(/type="radio"/g) ?? []).length, 3);
  assert.equal((markup.match(/type="checkbox"/g) ?? []).length, 4);
  for (const key of ['reducedMotion', 'weatherEffects', 'cameraFade', 'touchControls']) {
    assert.ok(markup.includes(`data-setting="${key}"`), `${key} has a control`);
  }
  assert.match(markup, /apply the next time a place loads/, 'the relaunch contract is stated, not implied');
});

test('the controls table is generated from the registry, not typed by hand', () => {
  const registry = createLauncherActionRegistry();
  const markup = controlsMarkup(registry);
  assert.equal((markup.match(/data-action="rebind"/g) ?? []).length, registry.actions().length);
  for (const action of registry.actions()) {
    assert.ok(markup.includes(action.label), `${action.id} has a row`);
    assert.ok(markup.includes(`data-control="${action.id}"`), `${action.id} can be rebound`);
  }
  assert.equal(bindingLabel(['KeyW', 'ArrowUp']), 'W / ↑');
  assert.equal(bindingLabel([]), 'unbound');
  assert.equal(controlsMarkup(null).includes('pause menu'), true, 'a registry-less host says so');
  // The listening state is visible and keyboard-reachable, not a modal.
  assert.equal(controlsMarkup(registry, { listening: 'jump' }).includes('Press a key…'), true);
});

test('the coordinate form keeps what was typed and reports refusals in place', () => {
  const markup = coordinateFormMarkup({ latitude: '28.98', longitude: '77.70', message: 'Those coordinates are not on the map.' });
  assert.match(markup, /value="28.98"/);
  assert.match(markup, /value="77.70"/);
  assert.match(markup, /Those coordinates are not on the map/);
  assert.equal(markup.includes('novalidate'), true, 'validation is the engine\'s, not the browser\'s guess');
});

test('features, news, and credits describe the build rather than a pitch', () => {
  const features = featureCardsMarkup();
  for (const card of GDO_FEATURE_CARDS) assert.ok(features.includes(card.title), `${card.id} is shown`);
  assert.ok(features.includes('OpenFreeMap'), 'tile provenance is named');
  const news = whatsNewMarkup();
  for (const item of GDO_WHATS_NEW) assert.ok(news.includes(item.tag), `${item.id} is shown`);
  const credits = attributionMarkup();
  assert.match(credits, /OpenStreetMap/);
  assert.equal((credits.match(/rel="noreferrer"/g) ?? []).length >= 4, true);
  const links = projectLinksMarkup();
  assert.match(links, /href="\/vision.html"/);
  assert.match(links, /target="_blank" rel="noreferrer"/);
});
