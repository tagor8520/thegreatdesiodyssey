/**
 * Markup builders for the launcher and the in-game menu (`gdo:panels:v1`).
 *
 * One set of strings, two hosts: the front page and the pause menu render the
 * *same* location cards, the same options screen, and the same controls table, so
 * a setting cannot mean one thing at the title screen and another in a session.
 * These functions are pure — they take data and return a string — which is what
 * lets the whole menu surface be asserted in Node without a browser.
 *
 * Interactive elements carry `data-action="…"`; the hosts bind one delegated
 * click handler and one change handler. Nothing here attaches a listener.
 *
 * One house rule, imposed by the repository's use-before-declaration audit: a
 * markup builder never nests one template literal inside another. Each repeated
 * fragment (`qualityOptionMarkup`, `controlRowMarkup`, …) is its own function, and
 * a list is built with `map(...).join('')` in the *caller's* interpolation.
 */

import { keyName } from '../engine/ActionRegistry.js';
import { GDO_ACCESSIBILITY_CHANNELS, GDO_ACCESSIBILITY_SETTINGS } from '../engine/AccessibilitySettings.js';
import {
  GDO_DATA_ATTRIBUTION,
  GDO_FEATURE_CARDS,
  GDO_PROJECT_LINKS,
  GDO_WHATS_NEW,
} from './siteContent.js';
import { GDO_QUALITY_PROFILE_COPY, GDO_QUALITY_PROFILES, profileSummary } from './GameSettings.js';
import {
  GDO_LOCATION_GROUPS,
  formatCoordinate,
  locationsInGroup,
} from './locations.js';

export const GDO_PANELS_NAMESPACE = 'gdo:panels:v1';

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Every value that reaches markup goes through this; copy is data, not HTML. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ENTITIES[character]);
}

const attribute = value => escapeHtml(value);

/** `KeyW` → `W`, `ArrowUp` → `↑`, a code list → `W / ↑`. */
export function bindingLabel(codes = []) {
  if (!codes?.length) return 'unbound';
  return codes.map(code => keyName(code) ?? code).join(' / ');
}

/* ── places ─────────────────────────────────────────────────────────────── */

export function locationCardMarkup(location, { selected = false } = {}) {
  const label = `${location.name}, ${location.city}`;
  const pressed = selected ? 'true' : 'false';
  const state = selected ? ' is-selected' : '';
  return `
    <button class="gdo-place${state}" type="button"
      data-action="select-place" data-place="${attribute(location.id)}"
      aria-pressed="${pressed}" aria-label="Choose ${attribute(label)}">
      <span class="gdo-place-name">${escapeHtml(location.name)}</span>
      <span class="gdo-place-city">${escapeHtml(location.city)} · ${escapeHtml(location.region)}</span>
      <span class="gdo-place-blurb">${escapeHtml(location.blurb)}</span>
      <span class="gdo-place-coord">${escapeHtml(formatCoordinate(location.latitude, location.longitude, 3))}</span>
    </button>`;
}

/** One group's cards, in declaration order. */
export function placeGroupMarkup(group, { selectedId = null } = {}) {
  const places = locationsInGroup(group.id);
  if (!places.length) return '';
  return `
      <section class="gdo-place-group" aria-labelledby="gdo-group-${attribute(group.id)}">
        <h3 class="gdo-place-group-title" id="gdo-group-${attribute(group.id)}">${escapeHtml(group.label)}</h3>
        <div class="gdo-place-grid">${places.map(place => locationCardMarkup(place, { selected: place.id === selectedId })).join('')}</div>
      </section>`;
}

/** The picker: every group, every place, and nothing preselected by accident. */
export function locationDeckMarkup({ selectedId = null } = {}) {
  return GDO_LOCATION_GROUPS
    .map(group => placeGroupMarkup(group, { selectedId }))
    .filter(Boolean)
    .join('');
}

/** One recent entry: the same identity, one line, reopenable. */
export function recentMarkup(place, index) {
  return `
    <li class="gdo-recent">
      <button class="gdo-recent-open" type="button" data-action="launch-recent" data-recent="${index}">
        <span class="gdo-recent-name">${escapeHtml(place.name)}</span>
        <span class="gdo-recent-coord">${escapeHtml(formatCoordinate(place.latitude, place.longitude, 3))}</span>
      </button>
    </li>`;
}

export function recentsMarkup(recents = []) {
  if (!recents.length) {
    return '<p class="gdo-recents-empty">Nothing yet — the places you launch will collect here.</p>';
  }
  return `<ul class="gdo-recents">${recents.map((place, index) => recentMarkup(place, index)).join('')}</ul>`;
}

/** The typed-coordinate path, kept as the advanced option it is. */
export function coordinateFormMarkup({ latitude = '', longitude = '', message = '' } = {}) {
  const note = message || 'Anywhere on Earth. Roads load first, then buildings and landscape.';
  return `
    <form class="gdo-coordinate-form" data-action="coordinate-submit" novalidate>
      <label class="gdo-field">
        <span>Latitude</span>
        <input name="latitude" inputmode="decimal" autocomplete="off" placeholder="28.9845"
          value="${attribute(latitude)}" min="-85.05112878" max="85.05112878" step="any" required>
      </label>
      <label class="gdo-field">
        <span>Longitude</span>
        <input name="longitude" inputmode="decimal" autocomplete="off" placeholder="77.7064"
          value="${attribute(longitude)}" min="-180" max="180" step="any" required>
      </label>
      <button class="gdo-button gdo-button-secondary" type="submit">Explore these coordinates</button>
      <p class="gdo-form-note" role="status">${escapeHtml(note)}</p>
    </form>`;
}

/* ── options ────────────────────────────────────────────────────────────── */

const TOGGLE_COPY = Object.freeze({
  reducedMotion: Object.freeze({ label: 'Reduced motion', hint: 'Parks weather particles, plant wind, the pedestrian run cycle and the camera fade.' }),
  weatherEffects: Object.freeze({ label: 'Weather effects', hint: 'Precipitation particles and the wet shoreline on the water.' }),
  cameraFade: Object.freeze({ label: 'Camera fade', hint: 'The screen-door fade when structure blocks the camera.' }),
  touchControls: Object.freeze({ label: 'Touch controls', hint: 'The on-screen joystick and action pad. Detected automatically on touch devices.' }),
});

export function qualityOptionMarkup(profile, settings) {
  const copy = GDO_QUALITY_PROFILE_COPY[profile];
  const checked = settings.profile === profile;
  const state = checked ? ' is-selected' : '';
  const checkedAttribute = checked ? 'checked' : '';
  return `
        <label class="gdo-quality-option${state}">
          <input type="radio" name="profile" value="${attribute(profile)}"
            data-action="set-profile" ${checkedAttribute}>
          <span class="gdo-quality-head">${escapeHtml(copy.label)}</span>
          <span class="gdo-quality-summary">${escapeHtml(copy.summary)}</span>
          <span class="gdo-quality-detail">${escapeHtml(copy.detail)}</span>
        </label>`;
}

export function qualityOptionsMarkup(settings) {
  const relaunch = `Profile changes are stored now and apply the next time a place loads — the world builds its pools when it is created. ` +
    `${profileSummary(settings.profile).label} is the current choice.`;
  return `
    <fieldset class="gdo-quality">
      <legend>Quality profile</legend>${GDO_QUALITY_PROFILES.map(profile => qualityOptionMarkup(profile, settings)).join('')}
    </fieldset>
    <p class="gdo-relaunch-note" role="status" data-role="relaunch-note">${escapeHtml(relaunch)}</p>`;
}

export function toggleMarkup(key, settings) {
  const copy = TOGGLE_COPY[key];
  const on = settings[key] === true;
  const channels = GDO_ACCESSIBILITY_CHANNELS[key]?.join(', ') ?? '';
  return `
        <label class="gdo-toggle">
          <input type="checkbox" data-action="set-toggle" data-setting="${attribute(key)}" ${on ? 'checked' : ''}>
          <span class="gdo-toggle-body">
            <span class="gdo-toggle-label">${escapeHtml(copy.label)}</span>
            <span class="gdo-toggle-hint">${escapeHtml(copy.hint)}</span>
            <span class="gdo-toggle-channels">${escapeHtml(channels)}</span>
          </span>
        </label>`;
}

export function togglesMarkup(settings) {
  return `
    <fieldset class="gdo-toggles">
      <legend>Motion and effects</legend>${Object.keys(GDO_ACCESSIBILITY_SETTINGS).map(key => toggleMarkup(key, settings)).join('')}
    </fieldset>`;
}

export function displayOptionsMarkup(settings) {
  return `${qualityOptionsMarkup(settings)}${togglesMarkup(settings)}`;
}

/* ── controls ───────────────────────────────────────────────────────────── */

function controlRowMarkup(action, listening) {
  const listeningHere = listening === action.id;
  const surfaces = [
    action.touch ? `Touch: ${action.touch.label ?? action.touch.control}` : null,
    action.pointer ? `Pointer: ${action.pointer}` : null,
  ].filter(Boolean).join(' · ');
  const rowClass = listeningHere ? ' class="is-listening"' : '';
  const buttonText = listeningHere ? 'Press a key…' : 'Rebind';
  return `
      <tr${rowClass}>
        <th scope="row">${escapeHtml(action.label)}</th>
        <td><kbd>${escapeHtml(bindingLabel(action.keyboard))}</kbd></td>
        <td class="gdo-controls-surface">${escapeHtml(surfaces || 'Keyboard only')}</td>
        <td>
          <button class="gdo-button gdo-button-quiet" type="button" data-action="rebind"
            data-control="${attribute(action.id)}" aria-label="Rebind ${attribute(action.label)}">${buttonText}</button>
        </td>
      </tr>`;
}

export function controlsMarkup(registry, { listening = null, message = '' } = {}) {
  if (!registry?.actions) {
    return '<p class="gdo-empty">The action registry is created with the game; open Controls from the pause menu to remap keys.</p>';
  }
  const note = message || 'Click Rebind, then press the key you want. A key already in use is refused rather than stolen.';
  return `
    <table class="gdo-controls">
      <caption>Every action comes from one registry; the keyboard, the touch pad and the help line all read it.</caption>
      <thead><tr><th scope="col">Action</th><th scope="col">Keys</th><th scope="col">Other surfaces</th><th scope="col"><span class="gdo-visually-hidden">Change</span></th></tr></thead>
      <tbody>${registry.actions().map(action => controlRowMarkup(action, listening)).join('')}</tbody>
    </table>
    <div class="gdo-controls-footer">
      <button class="gdo-button gdo-button-quiet" type="button" data-action="reset-bindings">Reset to defaults</button>
      <p class="gdo-form-note" role="status">${escapeHtml(note)}</p>
    </div>`;
}

/* ── front page ─────────────────────────────────────────────────────────── */

export function featureCardMarkup(card) {
  return `
    <article class="gdo-feature">
      <span class="gdo-feature-glyph" aria-hidden="true">${escapeHtml(card.glyph)}</span>
      <h3>${escapeHtml(card.title)}</h3>
      <p>${escapeHtml(card.body)}</p>
      <footer>${escapeHtml(card.foot)}</footer>
    </article>`;
}

export function featureCardsMarkup() {
  return GDO_FEATURE_CARDS.map(featureCardMarkup).join('');
}

export function newsItemMarkup(item) {
  return `
    <li class="gdo-news">
      <span class="gdo-news-tag">${escapeHtml(item.tag)}</span>
      <span class="gdo-news-title">${escapeHtml(item.title)}</span>
      <span class="gdo-news-body">${escapeHtml(item.body)}</span>
    </li>`;
}

export function whatsNewMarkup() {
  return GDO_WHATS_NEW.map(newsItemMarkup).join('');
}

export function attributionMarkup() {
  return GDO_DATA_ATTRIBUTION
    .map(entry => `<a href="${attribute(entry.href)}" target="_blank" rel="noreferrer">${escapeHtml(entry.label)}</a>`)
    .join(' · ');
}

export function projectLinksMarkup() {
  return GDO_PROJECT_LINKS.map(link => {
    const external = link.internal ? '' : ' target="_blank" rel="noreferrer"';
    return `<a href="${attribute(link.href)}"${external}>${escapeHtml(link.label)}</a>`;
  }).join('');
}

/**
 * The headline action. It says what it will do — resume the last place, or pick
 * one — and there is deliberately no default place behind it.
 */
export function primaryActionMarkup({ last = null, selected = null } = {}) {
  if (selected) {
    return `<button class="gdo-button gdo-button-primary" type="button" data-action="launch-selected">Explore ${escapeHtml(selected.name)} <span aria-hidden="true">↗</span></button>`;
  }
  if (last) {
    return `<button class="gdo-button gdo-button-primary" type="button" data-action="launch-last">Continue at ${escapeHtml(last.name)} <span aria-hidden="true">↗</span></button>`;
  }
  return '<button class="gdo-button gdo-button-primary" type="button" data-action="focus-picker">Choose a place <span aria-hidden="true">↗</span></button>';
}

/** Small print that must not become a lie: what loads, and when. */
export const GDO_LAUNCH_NOTE = 'The 3D engine loads only after you choose a place. Map data is streamed from free public vector tiles; nothing is stored on a server.';
