/**
 * The in-game pause menu (`gdo:gameMenu:v1`).
 *
 * The session used to expose one `Exit` button, which meant every settings change
 * required leaving the world and losing the place. This menu keeps the session and
 * puts the same panels the front page uses — Options and Controls — one keypress
 * away, plus the two ways out: pick another place, or quit to the title.
 *
 * It owns no simulation: `open()` reports back through `onOpen`, and the host
 * freezes the frame loop. That split is what makes "paused" true rather than a
 * panel drawn over a world that keeps streaming.
 */

import { controlsMarkup, displayOptionsMarkup, escapeHtml } from '../launcher/Panels.js';
import { profileSummary } from '../launcher/GameSettings.js';

export const GDO_GAME_MENU_NAMESPACE = 'gdo:gameMenu:v1';
export const GDO_GAME_MENU_TABS = Object.freeze([
  Object.freeze({ id: 'options', label: 'Options' }),
  Object.freeze({ id: 'controls', label: 'Controls' }),
  Object.freeze({ id: 'session', label: 'This session' }),
]);

function panelMarkup(tab, { settings, registry, place, listening, message, diagnostics }) {
  const snapshot = settings?.snapshot?.() ?? { profile: 'low' };
  if (tab === 'options') {
    return `
      <h3 class="gdo-pause-section-title">Display and motion</h3>
      ${displayOptionsMarkup(snapshot)}
      <p class="gdo-form-note" role="status">${escapeHtml(message || `Profile: ${profileSummary(snapshot.profile).label}. A profile change applies the next time a place loads.`)}</p>`;
  }
  if (tab === 'controls') {
    return `
      <h3 class="gdo-pause-section-title">Actions</h3>
      ${controlsMarkup(registry, { listening, message })}`;
  }
  const cache = diagnostics?.tileCache ?? null;
  const profile = profileSummary(snapshot.profile);
  return `
    <h3 class="gdo-pause-section-title">Where you are</h3>
    <p class="gdo-body">${escapeHtml(place?.name ?? 'This place')}${place?.subtitle ? ` · ${escapeHtml(place.subtitle)}` : ''}</p>
    <h3 class="gdo-pause-section-title">Quality</h3>
    <p class="gdo-body">${escapeHtml(profile.label)} — ${escapeHtml(profile.detail)}</p>
    <p class="gdo-body">${escapeHtml(profile.summary)}</p>
    ${cache ? `
    <h3 class="gdo-pause-section-title">Tile cache</h3>
    <p class="gdo-body">${cache.entries ?? 0} chunks · ${Math.round((cache.bytes ?? 0) / 1024 / 1024 * 10) / 10} MB stored ·
      ${cache.hits ?? 0} served from cache · ${cache.evictions ?? 0} evicted</p>` : ''}
    <h3 class="gdo-pause-section-title">Session</h3>
    <p class="gdo-body">${escapeHtml(message || 'The world is frozen while this menu is open. Nothing streams, nothing moves.')}</p>`;
}

/**
 * Create the pause menu inside the game overlay. `onOpen`/`onClose` are how the
 * host freezes and resumes the frame loop; `onChangePlace` and `onQuit` are the
 * two ways out.
 */
export function createGameMenu({
  container,
  settings = null,
  registry = null,
  place = null,
  onChange = null,
  onOpen = null,
  onClose = null,
  onChangePlace = null,
  onQuit = null,
  getDiagnostics = null,
} = {}) {
  if (!container) throw new TypeError('The game menu needs a container');
  const documentRef = container.ownerDocument ?? globalThis.document;
  const root = documentRef?.createElement?.('div') ?? null;
  if (!root) throw new TypeError('The game menu needs a document to build into');

  const state = { open: false, tab: 'options', listening: null, message: '' };
  let body = null;

  root.className = 'gdo-pause';
  root.hidden = true;
  root.setAttribute?.('role', 'dialog');
  root.setAttribute?.('aria-modal', 'true');
  root.setAttribute?.('aria-label', 'Paused');
  container.appendChild?.(root);

  const tabsMarkup = () => GDO_GAME_MENU_TABS
    .map(tab => `<button type="button" data-menu-action="tab" data-tab="${tab.id}"
      aria-pressed="${state.tab === tab.id ? 'true' : 'false'}">${tab.label}</button>`).join('');

  function paint() {
    const diagnostics = (() => {
      try { return getDiagnostics?.() ?? null; } catch { return null; }
    })();
    root.innerHTML = `
      <div class="gdo-pause-panel">
        <div class="gdo-pause-head">
          <h2>Paused</h2>
          <span class="gdo-pause-place">${escapeHtml(place?.name ?? 'This place')}</span>
        </div>
        <div class="gdo-pause-tabs" role="group" aria-label="Menu sections">${tabsMarkup()}</div>
        <div class="gdo-pause-body">
          ${panelMarkup(state.tab, { settings, registry, place, listening: state.listening, message: state.message, diagnostics })}
        </div>
        <div class="gdo-pause-actions">
          <button class="gdo-button gdo-button-primary" type="button" data-menu-action="resume">Resume</button>
          <button class="gdo-button gdo-button-quiet" type="button" data-menu-action="change-place">Change place</button>
          <button class="gdo-button gdo-button-danger" type="button" data-menu-action="quit">Quit to title</button>
        </div>
      </div>`;
    body = root.querySelector('.gdo-pause-body');
  }

  function repaint() {
    if (!state.open) return;
    paint();
  }

  function open() {
    if (state.open) return true;
    state.open = true;
    state.listening = null;
    state.message = '';
    root.hidden = false;
    paint();
    try { onOpen?.(); } catch { /* a host hook cannot break the menu */ }
    // Focus lands on the safest action, not on the way out.
    root.querySelector?.('[data-menu-action="resume"]')?.focus?.();
    return true;
  }

  function close() {
    if (!state.open) return false;
    state.open = false;
    state.listening = null;
    root.hidden = true;
    root.innerHTML = '';
    try { onClose?.(); } catch { /* same */ }
    return true;
  }

  function toggle() { return state.open ? close() : open(); }

  function setMessage(message) { state.message = message; repaint(); }

  function persist() {
    try { onChange?.(settings?.toSaveSettings?.() ?? null); }
    catch { /* the host reports a refused write */ }
  }

  const click = event => {
    const target = event.target?.closest?.('[data-menu-action]');
    if (!target || !state.open) return;
    const action = target.dataset.menuAction;
    if (action === 'tab') {
      state.tab = target.dataset.tab;
      state.listening = null;
      repaint();
      return;
    }
    if (action === 'resume') { close(); return; }
    if (action === 'change-place') { close(); onChangePlace?.(); return; }
    if (action === 'quit') { close(); onQuit?.(); return; }
    if (action === 'rebind') {
      state.listening = target.dataset.control;
      state.message = '';
      repaint();
      return;
    }
    if (action === 'reset-bindings') {
      settings?.resetBindings?.();
      persist();
      state.listening = null;
      state.message = 'Every binding is back to its default.';
      repaint();
      return;
    }
  };

  const change = event => {
    if (!state.open || !event.target?.dataset) return;
    const data = event.target.dataset;
    // Panels keep their `data-action` names in both hosts, so the handler reads
    // the same attributes the front page uses.
    if (data.action === 'set-profile') {
      const applied = settings?.set?.('profile', event.target.value);
      if (applied) {
        persist();
        state.message = `${profileSummary(applied).label} will apply the next time a place loads.`;
        repaint();
      }
      return;
    }
    if (data.action === 'set-toggle') {
      const applied = settings?.set?.(data.setting, event.target.checked);
      if (applied != null) { persist(); state.message = ''; repaint(); }
    }
  };

  const keydown = event => {
    if (!state.open) return;
    if (state.listening) {
      if (event.code === 'Escape') {
        event.preventDefault();
        state.listening = null;
        state.message = '';
        repaint();
        return;
      }
      if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(event.code)) return;
      event.preventDefault();
      const result = settings?.rebind?.(state.listening, [event.code]);
      persist();
      if (result?.ok) { state.listening = null; state.message = 'Binding updated.'; }
      else {
        state.message = result?.reason === 'code-conflict'
          ? `That key is already used by ${result.conflicts?.join(', ') ?? 'another action'}.`
          : `That key cannot be used (${result?.reason ?? 'refused'}).`;
      }
      repaint();
      return;
    }
    // Escape resumes; it is the key the player already reaches for.
    if (event.code === 'Escape') { event.preventDefault(); close(); }
  };

  root.addEventListener?.('click', click);
  root.addEventListener?.('change', change);
  const keyboardTarget = documentRef ?? globalThis;
  keyboardTarget?.addEventListener?.('keydown', keydown);

  return {
    namespace: GDO_GAME_MENU_NAMESPACE,
    element: root,
    open,
    close,
    toggle,
    setMessage,
    /** Re-paint after a setting changed elsewhere (e.g. a host-level a11y toggle). */
    refresh: repaint,
    get isOpen() { return state.open; },
    get tab() { return state.tab; },
    get body() { return body; },
    dispose() {
      if (state.open) close();
      keyboardTarget?.removeEventListener?.('keydown', keydown);
      root.removeEventListener?.('click', click);
      root.removeEventListener?.('change', change);
      root.remove?.();
    },
  };
}
