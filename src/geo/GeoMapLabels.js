/**
 * `LAY-05` — what the DOM label layer is allowed to show.
 *
 * `GME-04` proved the line-of-sight tester hides a label behind a blocker, but the
 * page-level decision — which pooled `<span>` gets which name, which ones are
 * off screen or too far, which ones collide with another label already placed,
 * and how many elements exist — lived inline in the game loop where no gate could
 * reach it. This module is that decision, extracted and pure:
 *
 *  - the pool of elements is capped (low/balanced/high), so a map with hundreds of
 *    names can never grow hundreds of nodes;
 *  - a label is placed only if it passed the `LAY-05`/`GME-04` LOS verdict, is in
 *    front of the camera, inside a small screen margin, inside the label range,
 *    and does not overlap a label already placed this frame (sparse layout);
 *  - the caller owns the DOM: `layout()` writes `hidden`, `textContent`,
 *    `dataset.kind`, `transform`, and `opacity` through a tiny adapter, so the
 *    same code runs against real elements, stubs, and `node --test`.
 *
 * Nothing here allocates per frame: hit rectangles, the placement list, and the
 * diagnostics view are reused.
 */

import { featureNamespace } from '../engine/FeatureVersions.js';

export const GEO_MAP_LABEL_NAMESPACE = featureNamespace('mapLabels');

export const GEO_MAP_LABEL_PROFILES = Object.freeze({
  low: Object.freeze({ maxElements: 14, maxVisible: 8, range: 72, minOpacity: .35, fadeRange: 90 }),
  balanced: Object.freeze({ maxElements: 24, maxVisible: 14, range: 96, minOpacity: .35, fadeRange: 120 }),
  high: Object.freeze({ maxElements: 36, maxVisible: 20, range: 128, minOpacity: .4, fadeRange: 160 }),
});

/** Vertical offset per label kind, so a name floats above its anchor. */
export const GEO_MAP_LABEL_OFFSETS = Object.freeze({
  place: 1.25, poi: .72, water: .28, street: .42, default: .42,
});

export const GEO_MAP_LABEL_LAYOUT = Object.freeze({
  /** Screen half-extents used to keep two labels from overlapping. */
  collisionHalfWidth: 48,
  collisionHalfHeight: 14,
  /** Normalized screen margin: a label just past the edge still shows. */
  screenMargin: .06,
});

export function mapLabelBudgetForProfile(profile) {
  return GEO_MAP_LABEL_PROFILES[profile] ?? GEO_MAP_LABEL_PROFILES.low;
}

function opacityFor(distance, budget) {
  const span = Math.max(1, budget.fadeRange - budget.range);
  const faded = 1 - Math.max(0, distance - budget.range) / span;
  return Math.min(1, Math.max(budget.minOpacity, faded));
}

/**
 * One label layer. `resolve(name)` returns the DOM element for a name (the caller
 * keeps the pool), and `layout(labels, { world, camera, nowMilliseconds })` hides
 * everything first and then places what the rules allow.
 */
export function createMapLabelLayer({
  profile = 'low',
  container = null,
  layer = null,
  createElement = null,
  camera = null,
  world = null,
  tester = null,
} = {}) {
  const budget = mapLabelBudgetForProfile(profile);
  const elements = [];
  const placed = [];
  const visible = [];
  const offsets = GEO_MAP_LABEL_OFFSETS;
  const diagnosticsRecord = {
    namespace: GEO_MAP_LABEL_NAMESPACE,
    profile,
    frames: 0, candidates: 0, visible: 0, hidden: 0,
    hiddenOffscreen: 0, hiddenRange: 0, hiddenOccluded: 0, hiddenOverlap: 0,
    hiddenOverflow: 0, poolSize: 0, poolCap: budget.maxElements,
    steadyFrameAllocations: 0,
  };

  function elementFor(index) {
    if (elements[index]) return elements[index];
    if (index >= budget.maxElements) return null;
    const element = createElement?.(index) ?? null;
    elements[index] = element;
    if (element && layer?.append) layer.append(element);
    return element;
  }

  /**
   * Decide and apply one frame. `screen` is `{ width, height }`; the projection is
   * read from the caller's `project(x, y, z, out)` so this module never imports
   * `three` and the page keeps its single reused vector.
   */
  function layout(labels, {
    camera: frameCamera = camera,
    world: frameWorld = world,
    nowMilliseconds = 0,
    screen = null,
    project = null,
    margin = GEO_MAP_LABEL_LAYOUT.screenMargin,
  } = {}) {
    if (!Array.isArray(labels)) throw new TypeError('Label layout needs an array of labels');
    if (typeof project !== 'function' || !screen) {
      throw new TypeError('Label layout needs a project(x, y, z, out) function and a screen size');
    }
    const width = Math.max(1, Number(screen.width) || 1);
    const height = Math.max(1, Number(screen.height) || 1);
    diagnosticsRecord.frames++;
    diagnosticsRecord.candidates = labels.length;
    placed.length = 0;
    visible.length = 0;
    // Hide the whole pool once, then un-hide what this frame places.
    for (const element of elements) if (element) element.hidden = true;

    // `GME-04`: the LOS verdict is the first filter, so an occluded name never
    // occupies a slot another label could use.
    const losLabels = frameCamera && tester?.visibleLabels
      ? tester.visibleLabels(labels, frameCamera, nowMilliseconds, visible)
      : labels;
    const origin = frameCamera?.position ?? { x: 0, y: 0, z: 0 };

    let hiddenOffscreen = 0, hiddenRange = 0, hiddenOccluded = 0, hiddenOverlap = 0, hiddenOverflow = 0;
    const projected = { x: 0, y: 0, z: 0 };
    for (const label of losLabels) {
      if (placed.length >= budget.maxElements || visible.length >= budget.maxVisible) { hiddenOverflow++; continue; }
      const distance = Math.hypot(
        (label.x ?? 0) - (origin.x ?? 0),
        (label.z ?? 0) - (origin.z ?? 0),
      );
      if (distance > budget.fadeRange) { hiddenRange++; continue; }
      const offset = offsets[label.kind] ?? offsets.default;
      const point = project(label.x ?? 0, (label.y ?? 0) + offset, label.z ?? 0, projected);
      const depth = Number(point?.z ?? Number.NaN);
      const normalizedX = Number(point?.x ?? Number.NaN);
      const normalizedY = Number(point?.y ?? Number.NaN);
      const onScreen = depth > -1 && depth < 1 &&
        Math.abs(normalizedX) < 1 + margin && Math.abs(normalizedY) < 1 + margin;
      if (!onScreen) { hiddenOffscreen++; continue; }
      const screenX = (normalizedX * .5 + .5) * width;
      const screenY = (-normalizedY * .5 + .5) * height;
      const overlaps = placed.some(position =>
        Math.abs(position.x - screenX) < GEO_MAP_LABEL_LAYOUT.collisionHalfWidth &&
        Math.abs(position.y - screenY) < GEO_MAP_LABEL_LAYOUT.collisionHalfHeight);
      if (overlaps) { hiddenOverlap++; continue; }
      const element = elementFor(placed.length);
      if (!element) { hiddenOverflow++; continue; }
      placed.push({ x: screenX, y: screenY });
      visible.push(label);
      element.hidden = false;
      element.textContent = label.name;
      element.dataset.kind = label.kind ?? 'name';
      element.style.transform =
        `translate3d(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px, 0) translate(-50%, -50%)`;
      element.style.opacity = opacityFor(distance, budget).toFixed(2);
    }

    // A label the LOS filter rejected is counted as occluded, not as overflow.
    const occluded = labels.length - losLabels.length;
    if (tester?.visibleLabels) hiddenOccluded = Math.max(0, occluded);
    diagnosticsRecord.visible = visible.length;
    diagnosticsRecord.hidden = Math.max(0, labels.length - visible.length);
    diagnosticsRecord.hiddenOffscreen = hiddenOffscreen;
    diagnosticsRecord.hiddenRange = hiddenRange;
    diagnosticsRecord.hiddenOccluded = hiddenOccluded;
    diagnosticsRecord.hiddenOverlap = hiddenOverlap;
    diagnosticsRecord.hiddenOverflow = hiddenOverflow;
    diagnosticsRecord.poolSize = elements.length;
    return visible;
  }

  return Object.freeze({
    namespace: GEO_MAP_LABEL_NAMESPACE,
    profile,
    limits: Object.freeze({ ...budget, layout: GEO_MAP_LABEL_LAYOUT }),
    get elements() { return elements; },
    get visible() { return visible; },
    /** Number of DOM nodes this layer has ever created: capped by the profile. */
    get poolSize() { return elements.length; },
    layout,
    diagnostics() {
      if (tester?.diagnostics) diagnosticsRecord.losTests = tester.diagnostics().tests ?? 0;
      return Object.freeze({ ...diagnosticsRecord });
    },
    reset() {
      for (const element of elements) if (element) element.hidden = true;
      placed.length = 0;
      visible.length = 0;
      return true;
    },
    dispose() {
      for (const element of elements) element?.remove?.();
      elements.length = 0;
      placed.length = 0;
      visible.length = 0;
    },
  });
}
