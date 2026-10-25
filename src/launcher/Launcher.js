/**
 * The front page (`gdo:launcher:v1` shell).
 *
 * This is the game's only entry point. It does four things and nothing else:
 *
 *  1. **Names the game** — what it is, what it is not, and what will load.
 *  2. **Asks where** — a grouped place deck, recents, and typed coordinates. No
 *     place is preselected and nothing auto-starts, so the first launch is a
 *     decision rather than a default.
 *  3. **Edits the settings that exist** — Options (profile, motion/effects) and
 *     Controls (the one action registry, with working rebinds) render the same
 *     panels the in-game pause menu renders.
 *  4. **Credits the data** — the licences the streamed layers carry.
 *
 * State lives in `state`, markup comes from `Panels.js`, and one delegated click
 * handler plus one change handler do the wiring, so a re-render cannot multiply
 * listeners.
 */

import { GDO_LAUNCH_NOTE, attributionMarkup, controlsMarkup, coordinateFormMarkup, displayOptionsMarkup, featureCardsMarkup, locationDeckMarkup, locationCardMarkup, primaryActionMarkup, projectLinksMarkup, recentsMarkup, whatsNewMarkup } from './Panels.js';
import { GDO_LOCATIONS, describePlace, formatCoordinate, resolveLocation } from './locations.js';
import { GDO_PROJECT_LINKS } from './siteContent.js';
import { profileSummary } from './GameSettings.js';

/** The four places the front page features; the full deck is one click away. */
export const GDO_FEATURED_PLACE_IDS = Object.freeze([
  'delhi-india-gate', 'mumbai-marine-drive', 'varanasi-ghat', 'leh-bazaar',
]);

export const GDO_LAUNCHER_SCREENS = Object.freeze(['home', 'places', 'options', 'controls', 'credits']);

const brandMark = `
  <span class="gdo-brand-mark" aria-hidden="true">✦</span>
  <span class="gdo-brand-text">The Great <strong>Desi Odyssey</strong></span>`;

function heroMarkup(state) {
  const last = state.last ?? null;
  const selected = state.selectedId ? resolveLocation(state.selectedId) : null;
  return `
    <section class="gdo-hero" aria-labelledby="gdo-title">
      <p class="gdo-eyebrow">Building virtual Bharat</p>
      <h1 id="gdo-title">The Great<br><span>Desi Odyssey</span></h1>
      <p class="gdo-lede">Walk a real place. The streets, buildings, water and people around you are generated
        on this device from open map data — no install, no account, no server holding your position.</p>
      <div class="gdo-hero-actions">
        ${primaryActionMarkup({ last, selected })}
        <button class="gdo-button gdo-button-quiet" type="button" data-action="nav" data-screen="places">Browse all places</button>
      </div>
      <p class="gdo-launch-note" role="status" data-role="status">${state.message || GDO_LAUNCH_NOTE}</p>
      ${last ? `
      <div class="gdo-last">
        <span class="gdo-last-label">Last visited</span>
        <button class="gdo-last-open" type="button" data-action="launch-last">
          ${last.name} · ${formatCoordinate(last.latitude, last.longitude, 3)}
        </button>
      </div>` : ''}
    </section>`;
}

function featuredMarkup(state) {
  const places = GDO_FEATURED_PLACE_IDS.map(resolveLocation).filter(Boolean);
  return `
    <section class="gdo-section" aria-labelledby="gdo-featured-title">
      <header class="gdo-section-head">
        <h2 id="gdo-featured-title">Start somewhere</h2>
        <button class="gdo-link" type="button" data-action="nav" data-screen="places">All ${GDO_LOCATIONS.length} places →</button>
      </header>
      <div class="gdo-featured">
        ${places.map(place => locationCardMarkup(place, { selected: place.id === state.selectedId })).join('')}
      </div>
    </section>`;
}

function homeMarkup(state) {
  return `
    ${heroMarkup(state)}
    ${featuredMarkup(state)}
    ${state.recents.length ? `
    <section class="gdo-section" aria-labelledby="gdo-recents-title">
      <header class="gdo-section-head"><h2 id="gdo-recents-title">Recently played</h2></header>
      ${recentsMarkup(state.recents)}
    </section>` : ''}
    <section class="gdo-section" aria-labelledby="gdo-features-title">
      <header class="gdo-section-head"><h2 id="gdo-features-title">What is actually in the build</h2></header>
      <div class="gdo-features">${featureCardsMarkup()}</div>
    </section>
    <section class="gdo-section" aria-labelledby="gdo-news-title">
      <header class="gdo-section-head"><h2 id="gdo-news-title">What just landed</h2></header>
      <ul class="gdo-news-list">${whatsNewMarkup()}</ul>
    </section>`;
}

function placesMarkup(state) {
  const selected = state.selectedId ? resolveLocation(state.selectedId) : null;
  return `
    <section class="gdo-section" aria-labelledby="gdo-places-title">
      <header class="gdo-section-head">
        <h2 id="gdo-places-title">Choose a place</h2>
        <p class="gdo-section-note">Every entry is a real standing spot. The game streams whatever coordinate it is given.</p>
      </header>
      <div class="gdo-launch-bar" role="region" aria-label="Launch">
        <div class="gdo-launch-bar-place">
          ${selected
            ? `<strong>${selected.name}</strong><span>${selected.city} · ${selected.region} · ${formatCoordinate(selected.latitude, selected.longitude, 3)}</span>`
            : '<strong>Nothing selected</strong><span>Pick a card, or type coordinates below.</span>'}
        </div>
        ${primaryActionMarkup({ selected })}
      </div>
      ${locationDeckMarkup({ selectedId: state.selectedId })}
      ${state.recents.length ? `
      <section class="gdo-subsection" aria-labelledby="gdo-recents-title-places">
        <h3 id="gdo-recents-title-places">Recently played</h3>
        ${recentsMarkup(state.recents)}
      </section>` : ''}
      <section class="gdo-subsection" aria-labelledby="gdo-coords-title">
        <h3 id="gdo-coords-title">Or enter coordinates</h3>
        ${coordinateFormMarkup({ ...state.drafts, message: state.message })}
      </section>
    </section>`;
}

function optionsMarkup(state) {
  const settings = state.settings.snapshot();
  return `
    <section class="gdo-section" aria-labelledby="gdo-options-title">
      <header class="gdo-section-head">
        <h2 id="gdo-options-title">Options</h2>
        <p class="gdo-section-note">These are the settings the game actually reads. A change is written to the
          local save immediately; the quality profile takes effect the next time a place loads.</p>
      </header>
      <div class="gdo-options-grid">
        <div class="gdo-options-column">${displayOptionsMarkup(settings)}</div>
        <div class="gdo-options-column">
          <h3 class="gdo-column-title">Saved data</h3>
          <p class="gdo-body">Discovered places, activity progress, and these settings live in one versioned local
            save. Clearing it also clears the launcher's recents.</p>
          <button class="gdo-button gdo-button-danger" type="button" data-action="clear-save">Erase local save</button>
          <p class="gdo-form-note" role="status" data-role="options-status">${state.message}</p>
        </div>
      </div>
    </section>`;
}

function controlsMarkupScreen(state) {
  return `
    <section class="gdo-section" aria-labelledby="gdo-controls-title">
      <header class="gdo-section-head">
        <h2 id="gdo-controls-title">Controls</h2>
        <p class="gdo-section-note">One registry describes every action. The keyboard, the on-screen pad and the
          in-game help line are all generated from this table.</p>
      </header>
      ${controlsMarkup(state.registry, { listening: state.listening, message: state.message })}
    </section>`;
}

function creditsMarkupScreen(state) {
  return `
    <section class="gdo-section" aria-labelledby="gdo-credits-title">
      <header class="gdo-section-head"><h2 id="gdo-credits-title">Credits</h2></header>
      <div class="gdo-credits">
        <div>
          <h3>Map data</h3>
          <p class="gdo-attribution">${attributionMarkup()}</p>
          <p class="gdo-body">Vector tiles are streamed from free public providers and decoded on this device.
            A bounded cache keeps recently seen chunks; nothing about your position leaves the browser.</p>
        </div>
        <div>
          <h3>Project</h3>
          <p class="gdo-link-row">${projectLinksMarkup()}</p>
          <p class="gdo-body">Open source. Built by Pixellon.</p>
        </div>
      </div>
      <p class="gdo-form-note" role="status">${state.message}</p>
    </section>`;
}

const SCREEN_MARKUP = {
  home: homeMarkup,
  places: placesMarkup,
  options: optionsMarkup,
  controls: controlsMarkupScreen,
  credits: creditsMarkupScreen,
};

function shellMarkup(state) {
  const navButton = (screen, label) => `
    <button type="button" data-action="nav" data-screen="${screen}"
      ${state.screen === screen ? 'aria-current="page"' : ''}>${label}</button>`;
  const panel = SCREEN_MARKUP[state.screen] ?? homeMarkup;
  return `
    <div class="gdo-shell" data-screen="${state.screen}">
      <header class="gdo-topbar">
        <button class="gdo-brand" type="button" data-action="nav" data-screen="home" aria-label="The Great Desi Odyssey, home">
          ${brandMark}
        </button>
        <nav class="gdo-nav" aria-label="Main">${navButton('places', 'Places')}${navButton('options', 'Options')}${navButton('controls', 'Controls')}${navButton('credits', 'Credits')}</nav>
      </header>
      <main class="gdo-main" id="gdo-main">${panel(state)}</main>
      <footer class="gdo-footer">
        <p class="gdo-attribution">${attributionMarkup()}</p>
        <p class="gdo-footer-links">${projectLinksMarkup()}</p>
      </footer>
    </div>`;
}

/**
 * Mount the front page. `onLaunch({place, settings})` is called once a place is
 * chosen; the caller mounts the world and calls `show()` again on exit.
 */
export function mountLauncher(container, {
  storage = null,
  settings,
  launcherStorage,
  onLaunch,
  onSettingsChanged = null,
  onClearSave = null,
} = {}) {
  if (!container || typeof container.replaceChildren !== 'function') {
    throw new TypeError('The launcher needs a container element');
  }
  if (typeof onLaunch !== 'function') throw new TypeError('The launcher needs a launch handler');
  const store = launcherStorage;
  const saved = store?.load?.() ?? { last: null, recents: [], launches: 0 };

  const state = {
    screen: 'home',
    selectedId: null,
    listening: null,
    message: '',
    drafts: { latitude: '', longitude: '' },
    last: saved.last ?? null,
    recents: saved.recents ?? [],
    settings,
    registry: settings?.registry ?? null,
  };
  let disposed = false;
  let root = null;

  const setMessage = message => { state.message = message; render(); };

  function render() {
    if (disposed) return;
    container.innerHTML = shellMarkup(state);
    root = container.querySelector('.gdo-shell');
    // The picker's first card is not focused for the player: choosing is a move
    // they make, not a default the page makes for them.
    root?.querySelector('.gdo-main')?.setAttribute('tabindex', '-1');
  }

  function showScreen(screen) {
    if (!GDO_LAUNCHER_SCREENS.includes(screen)) return false;
    state.screen = screen;
    state.listening = null;
    state.message = '';
    render();
    return true;
  }

  /**
   * Hand the current settings to the host, which owns the `NET-01` write. The
   * launcher never writes the save envelope itself: one writer, one place.
   */
  function persistSettings() {
    try { onSettingsChanged?.(state.settings?.toSaveSettings?.() ?? null); }
    catch { /* a refused write is reported by the host, never thrown into the UI */ }
  }

  function launch(placeInput) {
    // A bare catalogue id is the launcher's own shorthand for choosing that card;
    // `describePlace` still does the resolving and the refusing.
    const place = describePlace(typeof placeInput === 'string' ? { kind: 'location', id: placeInput } : placeInput);
    if (!place.ok) {
      state.message = place.refusal === 'bad-coordinate'
        ? (place.message ?? 'Those coordinates are not on the map.')
        : 'That place is no longer in the catalogue.';
      render();
      return null;
    }
    const savedPlace = store?.recordLaunch?.(place) ?? null;
    state.last = savedPlace ?? state.last;
    if (savedPlace) state.recents = store.state.recents;
    const launched = onLaunch({
      place,
      settings: state.settings?.toSaveSettings?.() ?? null,
    });
    if (launched === false) {
      state.message = 'The world could not start. Try another place, or reload the page.';
      render();
      return null;
    }
    return place;
  }

  function launchCoordinates() {
    return launch({ kind: 'coordinate', latitude: state.drafts.latitude, longitude: state.drafts.longitude });
  }

  const click = event => {
    const target = event.target?.closest?.('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    if (action === 'nav') {
      event.preventDefault();
      showScreen(target.dataset.screen);
      return;
    }
    if (action === 'select-place') {
      event.preventDefault();
      state.selectedId = target.dataset.place;
      state.message = '';
      render();
      return;
    }
    if (action === 'focus-picker') {
      event.preventDefault();
      showScreen('places');
      return;
    }
    if (action === 'launch-selected') {
      event.preventDefault();
      if (state.selectedId) launch(state.selectedId);
      return;
    }
    if (action === 'launch-last') {
      event.preventDefault();
      if (state.last) launch({ kind: state.last.kind, id: state.last.id, latitude: state.last.latitude, longitude: state.last.longitude, name: state.last.name });
      return;
    }
    if (action === 'launch-recent') {
      event.preventDefault();
      const recent = state.recents[Number(target.dataset.recent)];
      if (recent) launch({ kind: recent.kind, id: recent.id, latitude: recent.latitude, longitude: recent.longitude, name: recent.name });
      return;
    }
    if (action === 'rebind') {
      event.preventDefault();
      state.listening = target.dataset.control;
      state.message = '';
      render();
      return;
    }
    if (action === 'reset-bindings') {
      event.preventDefault();
      state.settings?.resetBindings?.();
      persistSettings();
      state.listening = null;
      state.message = 'Every binding is back to its default.';
      render();
      return;
    }
    if (action === 'clear-save') {
      event.preventDefault();
      const confirmed = typeof globalThis.confirm === 'function'
        ? globalThis.confirm('Erase the local save? Discovered places, activity progress and settings will be lost.')
        : true;
      if (!confirmed) return;
      let result = { ok: true };
      try { result = onClearSave?.() ?? { ok: true }; }
      catch { result = { ok: false, refusal: 'storage-unreadable' }; }
      store?.clear?.();
      state.last = null;
      state.recents = [];
      state.message = result.ok ? 'Local save erased.' : 'The save could not be erased (storage refused).';
      render();
      return;
    }
  };

  const change = event => {
    const target = event.target;
    if (!target?.dataset) return;
    if (target.dataset.action === 'set-profile') {
      const applied = state.settings?.set?.('profile', target.value);
      if (applied) { persistSettings(); state.message = `${profileSummary(applied).label} will apply the next time a place loads.`; render(); }
      return;
    }
    if (target.dataset.action === 'set-toggle') {
      const applied = state.settings?.set?.(target.dataset.setting, target.checked);
      if (applied != null) { persistSettings(); state.message = ''; render(); }
      return;
    }
  };

  const input = event => {
    const name = event.target?.name;
    if (name === 'latitude' || name === 'longitude') state.drafts[name] = event.target.value;
  };

  const submit = event => {
    if (!event.target?.matches?.('.gdo-coordinate-form')) return;
    event.preventDefault();
    launchCoordinates();
  };

  const keydown = event => {
    if (!state.listening) return;
    if (event.code === 'Escape') {
      event.preventDefault();
      state.listening = null;
      state.message = '';
      render();
      return;
    }
    // A modifier alone is not a binding; wait for a key that means something.
    if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(event.code)) return;
    event.preventDefault();
    const result = state.settings?.rebind?.(state.listening, [event.code]);
    persistSettings();
    if (result?.ok) {
      state.listening = null;
      state.message = 'Binding updated.';
    } else {
      state.message = result?.reason === 'code-conflict'
        ? `That key is already used by ${result.conflicts?.join(', ') ?? 'another action'}. Press another, or Escape.`
        : `That key cannot be used (${result?.reason ?? 'refused'}).`;
    }
    render();
  };

  render();
  // Keyboard capture goes on the document when there is one: a browser has a
  // single keyboard owner, and a test harness can hand in its own.
  const keyboardTarget = container.ownerDocument ?? globalThis;
  const listeners = [
    [container, 'click', click],
    [container, 'change', change],
    [container, 'input', input],
    [container, 'submit', submit],
    [keyboardTarget, 'keydown', keydown],
  ];
  for (const [target, type, handler] of listeners) target?.addEventListener?.(type, handler);

  return {
    state,
    show() { render(); return state; },
    showScreen,
    launch,
    get screen() { return state.screen; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [target, type, handler] of listeners) target?.removeEventListener?.(type, handler);
      container.replaceChildren();
    },
  };
}

export { GDO_PROJECT_LINKS };
