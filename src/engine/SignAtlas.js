/**
 * `MAT-06` — the bounded generated sign atlas (`gdo:signAtlas:v1`) and the
 * comparison that decides where it may be used.
 *
 * The row's gate is a value question — "only if 3D signs beat existing DOM labels
 * within memory cap" — and the texture research answers half of it already (§5.3,
 * §6.4): **map names stay in the existing DOM path** until an in-scene sign system
 * is justified, and any such system must be "one shared atlas or strict LRU",
 * "≤ 4 live 64×32 sign tiles on low profile", "map-derived text only",
 * "regenerate only on label set changes", and must "dispose evicted
 * canvases/textures". This module is that system plus the arithmetic that says
 * whether it earned the bytes.
 *
 * Two decisions follow from taking that literally:
 *
 * 1. **Tiles carry masks, not colour.** The palette lives outside the texture, so
 *    one rendered mask serves every material and biome tint and a 64×32 tile costs
 *    2 KiB instead of 8. `toRGBA()` is the only place colour exists, and it exists
 *    for the upload the host asks for.
 * 2. **The atlas only replaces a DOM label when a DOM label is the wrong tool.**
 *    A geographic name is a screen-space annotation: crisp at any distance, free
 *    of texture budget, and correct to leave in the DOM. A *sign plate* is scene
 *    weight — it must sit on the plate, occlude with the geometry, and cost nothing
 *    per frame — so that is where the atlas earns. The benchmark prices both and
 *    can refuse either, including when the plate count exceeds the tile budget and
 *    the atlas would thrash.
 *
 * Nothing here uses a canvas, a device font, or `Math.random()`: the 5×7 glyph
 * mask is a constant, rendering is a plain loop over a typed array, and every tile
 * has a checksum a test can pin.
 */

import { featureNamespace } from './FeatureVersions.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

export const GDO_SIGN_ATLAS_NAMESPACE = featureNamespace('signAtlas');

export const GDO_SIGN_REFUSAL = Object.freeze({
  BAD_INPUT: 'bad-input',
  TEXT_TOO_LONG: 'text-too-long',
  UNSUPPORTED_GLYPH: 'unsupported-glyph',
  TILE_BUDGET: 'tile-budget',
  MEMORY_CAP: 'memory-cap',
  DISPOSED: 'disposed',
});

export const GDO_SIGN_STRATEGY = Object.freeze({
  DOM_LABELS: 'dom-labels',
  GENERATED_ATLAS: 'generated-atlas',
});

export const GDO_SIGN_REASON = Object.freeze({
  NOTHING_TO_SHOW: 'nothing-to-show',
  MAP_NAMES_STAY_DOM: 'map-names-stay-dom',
  MEMORY_CAP: 'memory-cap',
  TILE_THRASH: 'tile-thrash',
  ATLAS_EARNED: 'atlas-earned',
  DOM_CHEAPER: 'dom-cheaper',
});

/** Research §6.4: "≤ 4 live 64×32 sign tiles on low profile". */
export const GDO_SIGN_PROFILES = Object.freeze({
  low: Object.freeze({
    maxTiles: 4,
    tileWidth: 64,
    tileHeight: 32,
    maxChars: 12,
    maxGlyphScale: 2,
    pad: 4,
    border: 1,
    maxDrawCalls: 1,
    maxSteadyFrameWrites: 0,
    maxRegenerationsPerSync: 4,
    maxBytes: 4 * 64 * 32,
    // Declared DOM model: a pooled span with a style box, a dataset, and a text
    // node. Estimated, not measured in this repository — flagged as such.
    domNodeBytes: 1280,
    domWritesPerNode: 5,
  }),
  balanced: Object.freeze({
    maxTiles: 8,
    tileWidth: 64,
    tileHeight: 32,
    maxChars: 12,
    maxGlyphScale: 3,
    pad: 4,
    border: 1,
    maxDrawCalls: 1,
    maxSteadyFrameWrites: 0,
    maxRegenerationsPerSync: 8,
    maxBytes: 8 * 64 * 32,
    domNodeBytes: 1280,
    domWritesPerNode: 5,
  }),
  high: Object.freeze({
    maxTiles: 16,
    tileWidth: 64,
    tileHeight: 32,
    maxChars: 12,
    maxGlyphScale: 3,
    pad: 4,
    border: 1,
    maxDrawCalls: 2,
    maxSteadyFrameWrites: 0,
    maxRegenerationsPerSync: 16,
    maxBytes: 16 * 64 * 32,
    domNodeBytes: 1280,
    domWritesPerNode: 5,
  }),
});

/** Mask values inside a tile: the palette lives outside, so these are levels. */
export const GDO_SIGN_MASK = Object.freeze({ BACKGROUND: 0, BORDER: 1, INK: 2 });

/**
 * A 5×7 pixel glyph mask, five bits per row (`0x10` is the leftmost column). It is
 * a constant, not a font lookup: the same bytes render the same tile on every
 * machine and in every browser.
 */
export const GDO_SIGN_GLYPHS = Object.freeze({
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  A: [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
  B: [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
  C: [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
  D: [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E],
  E: [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
  F: [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
  G: [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0E],
  H: [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
  I: [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
  M: [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
  P: [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
  Q: [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
  R: [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
  S: [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
  T: [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11],
  X: [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
  0: [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
  1: [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
  2: [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
  3: [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
  4: [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
  5: [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
  6: [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
  7: [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
  9: [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
  '-': [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C],
  '/': [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
  '&': [0x0C, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0D],
  '?': [0x0E, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
});

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const GLYPH_ADVANCE = 6;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function policyFor(profile) {
  return GDO_SIGN_PROFILES[profile] ?? GDO_SIGN_PROFILES.low;
}

/** Upper-case and replace anything the mask cannot draw, reporting the swap. */
export function sanitiseSignText(text) {
  const source = typeof text === 'string' ? text : '';
  const upper = source.toUpperCase();
  let substituted = 0;
  let output = '';
  for (const character of upper) {
    if (Object.hasOwn(GDO_SIGN_GLYPHS, character)) { output += character; continue; }
    output += '?';
    substituted++;
  }
  return { text: output, substituted };
}

/** The largest integer scale (1..max) at which `length` characters still fit. */
export function signGlyphScale(length, policy) {
  const usable = policy.tileWidth - policy.pad * 2 - policy.border * 2;
  const fit = Math.floor(usable / (Math.max(1, length) * GLYPH_ADVANCE));
  return clamp(fit, 1, policy.maxGlyphScale);
}

/**
 * Legibility as the renderer's own quantity: texels per glyph column. A 5×7 glyph
 * at scale 1 is barely readable, at scale 3 it is crisp; the score is the scale
 * achieved relative to the profile's best.
 */
export function signLegibility(length, policy) {
  return signGlyphScale(length, policy) / policy.maxGlyphScale;
}

function tileBytesFor(policy) {
  return policy.tileWidth * policy.tileHeight;
}

/**
 * The atlas: a fixed pool of mask tiles with LRU eviction. Allocation happens once
 * at construction; rendering writes into an existing tile; eviction zeroes the
 * tile it takes (that *is* the dispose of a generated canvas, and it is counted).
 */
export function createSignAtlas({ profile = 'low', memoryCapBytes = null } = {}) {
  const policy = policyFor(profile);
  const tileBytes = tileBytesFor(policy);
  // Two independent ceilings: the profile's own tile cap and whatever the caller
  // (the world passes `QLT-05`'s material texture budget) will actually allow.
  const cap = Number.isFinite(memoryCapBytes) && memoryCapBytes >= 0
    ? Math.min(memoryCapBytes, policy.maxBytes) : policy.maxBytes;
  const maxTiles = Math.min(policy.maxTiles, Math.floor(cap / tileBytes));
  const buffers = [];
  const used = new Uint8Array(Math.max(0, maxTiles));
  /** LRU order: the first key is the least recently used. */
  const order = new Map();
  const refusals = Object.fromEntries(Object.values(GDO_SIGN_REFUSAL).map(key => [key, 0]));

  let renders = 0, evictions = 0, reuses = 0, syncs = 0, regenerations = 0;
  let malformedInputs = 0, substitutedGlyphs = 0;
  let disposed = false;
  let lastSyncSignature = null;

  function allocate(index) {
    buffers[index] ??= new Uint8Array(tileBytes);
    used[index] = 1;
    return buffers[index];
  }

  function evictOldest() {
    const oldest = order.keys().next();
    if (oldest.done) return null;
    const key = oldest.value;
    const index = order.get(key);
    order.delete(key);
    if (index != null && buffers[index]) {
      // Disposing a generated tile means its pixels are gone, not garbage-collected.
      buffers[index].fill(0);
      used[index] = 0;
    }
    evictions++;
    return { key, index };
  }

  function freeIndex() {
    for (let index = 0; index < maxTiles; index++) if (!used[index]) return index;
    return -1;
  }

  /** Render `text` into a mask tile, reusing its tile if it is already resident. */
  function render(text, { tile = null } = {}) {
    if (disposed) { refusals[GDO_SIGN_REFUSAL.DISPOSED]++; return { ok: false, refusal: GDO_SIGN_REFUSAL.DISPOSED }; }
    if (typeof text !== 'string' || text.length === 0) {
      refusals[GDO_SIGN_REFUSAL.BAD_INPUT]++; malformedInputs++;
      return { ok: false, refusal: GDO_SIGN_REFUSAL.BAD_INPUT };
    }
    const sanitised = sanitiseSignText(text);
    if (sanitised.text.length > policy.maxChars) {
      refusals[GDO_SIGN_REFUSAL.TEXT_TOO_LONG]++; malformedInputs++;
      return { ok: false, refusal: GDO_SIGN_REFUSAL.TEXT_TOO_LONG, maxChars: policy.maxChars };
    }
    if (sanitised.substituted) {
      refusals[GDO_SIGN_REFUSAL.UNSUPPORTED_GLYPH]++;
      substitutedGlyphs += sanitised.substituted;
    }
    const key = sanitised.text;
    const resident = order.get(key);
    if (resident != null) {
      // Touch: the entry becomes the most recently used and keeps its pixels.
      order.delete(key);
      order.set(key, resident);
      reuses++;
      return {
        ok: true, key, tile: resident, width: policy.tileWidth, height: policy.tileHeight,
        scale: signGlyphScale(key.length, policy), reused: true,
        legibility: signLegibility(key.length, policy),
        substituted: sanitised.substituted, checksum: checksumOf(resident),
      };
    }
    if (maxTiles <= 0) {
      refusals[GDO_SIGN_REFUSAL.MEMORY_CAP]++;
      return { ok: false, refusal: GDO_SIGN_REFUSAL.MEMORY_CAP, memoryCapBytes: cap };
    }
    const explicit = Number.isInteger(tile) && tile >= 0 && tile < maxTiles ? tile : null;
    let index;
    if (explicit != null && !used[explicit]) index = explicit;
    else {
      index = freeIndex();
      if (index < 0) {
        const evicted = evictOldest();
        index = evicted?.index ?? -1;
        if (index < 0) {
          refusals[GDO_SIGN_REFUSAL.TILE_BUDGET]++;
          return { ok: false, refusal: GDO_SIGN_REFUSAL.TILE_BUDGET, maxTiles };
        }
      }
    }
    const mask = allocate(index);
    mask.fill(GDO_SIGN_MASK.BACKGROUND);
    // Border first: a 1px frame is what makes a plate read as a plate.
    if (policy.border) {
      for (let x = 0; x < policy.tileWidth; x++) {
        mask[x] = GDO_SIGN_MASK.BORDER;
        mask[(policy.tileHeight - 1) * policy.tileWidth + x] = GDO_SIGN_MASK.BORDER;
      }
      for (let y = 0; y < policy.tileHeight; y++) {
        mask[y * policy.tileWidth] = GDO_SIGN_MASK.BORDER;
        mask[y * policy.tileWidth + policy.tileWidth - 1] = GDO_SIGN_MASK.BORDER;
      }
    }
    const scale = signGlyphScale(key.length, policy);
    const textWidth = key.length * GLYPH_ADVANCE * scale - scale;
    const textHeight = GLYPH_HEIGHT * scale;
    const originX = Math.round((policy.tileWidth - textWidth) / 2);
    const originY = Math.round((policy.tileHeight - textHeight) / 2);
    for (let glyph = 0; glyph < key.length; glyph++) {
      const rows = GDO_SIGN_GLYPHS[key[glyph]];
      for (let row = 0; row < GLYPH_HEIGHT; row++) {
        const bits = rows[row];
        for (let column = 0; column < GLYPH_WIDTH; column++) {
          if (!(bits & (1 << (GLYPH_WIDTH - 1 - column)))) continue;
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
            const x = originX + (glyph * GLYPH_ADVANCE + column) * scale + dx;
            const y = originY + row * scale + dy;
            if (x <= 0 || y <= 0 || x >= policy.tileWidth - 1 || y >= policy.tileHeight - 1) continue;
            mask[y * policy.tileWidth + x] = GDO_SIGN_MASK.INK;
          }
        }
      }
    }
    order.set(key, index);
    renders++;
    return {
      ok: true, key, tile: index, width: policy.tileWidth, height: policy.tileHeight,
      scale, reused: false, legibility: signLegibility(key.length, policy),
      substituted: sanitised.substituted, checksum: checksumOf(index),
    };
  }

  function checksumOf(index) {
    const mask = buffers[index];
    if (!mask) return null;
    let hash = 2166136261;
    for (let byte = 0; byte < mask.length; byte++) {
      hash ^= mask[byte];
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  /** The tile mask a renderer uploads; colour never enters the tile. */
  function maskFor(index) {
    return buffers[index] ?? null;
  }

  /** Expand one mask tile into RGBA with the caller's palette — the only colour. */
  function toRGBA(index, { background = [24, 26, 30, 255], border = [92, 98, 110, 255], ink = [238, 242, 248, 255] } = {}) {
    const mask = buffers[index];
    if (!mask) return null;
    const rgba = new Uint8Array(tileBytes * 4);
    for (let pixel = 0; pixel < mask.length; pixel++) {
      const level = mask[pixel];
      const colour = level === GDO_SIGN_MASK.INK ? ink
        : level === GDO_SIGN_MASK.BORDER ? border : background;
      rgba[pixel * 4] = colour[0];
      rgba[pixel * 4 + 1] = colour[1];
      rgba[pixel * 4 + 2] = colour[2];
      rgba[pixel * 4 + 3] = colour[3];
    }
    return rgba;
  }

  /**
   * Bring the resident set to `texts`. Research §6.4: "regenerate only on label set
   * changes" — an unchanged set does no work at all, and the report says so.
   */
  function sync(texts = []) {
    if (disposed) return { ok: false, refusal: GDO_SIGN_REFUSAL.DISPOSED };
    if (!Array.isArray(texts)) { refusals[GDO_SIGN_REFUSAL.BAD_INPUT]++; return { ok: false, refusal: GDO_SIGN_REFUSAL.BAD_INPUT }; }
    syncs++;
    const unique = [...new Set(texts.filter(text => typeof text === 'string' && text.length))]
      .map(text => sanitiseSignText(text).text)
      .filter(text => text.length <= policy.maxChars);
    const signature = [...unique].sort().join('|');
    if (signature === lastSyncSignature) {
      return { ok: true, changed: false, tiles: [...order.keys()], renders: 0, thrash: 0 };
    }
    lastSyncSignature = signature;
    let rendered = 0;
    for (const text of unique) {
      if (rendered >= policy.maxRegenerationsPerSync) break;
      const before = renders;
      const result = render(text);
      if (result.ok && !result.reused) rendered++;
      if (result.ok && renders > before) regenerations++;
    }
    // Anything the tile budget cannot hold is named, not hidden: that is the
    // thrash the benchmark refuses.
    const thrash = Math.max(0, unique.length - maxTiles);
    return { ok: true, changed: true, tiles: [...order.keys()], renders: rendered, thrash, requested: unique.length };
  }

  function dispose() {
    if (disposed) return;
    for (const buffer of buffers) buffer?.fill(0);
    buffers.length = 0;
    order.clear();
    used.fill(0);
    disposed = true;
  }

  return Object.freeze({
    namespace: GDO_SIGN_ATLAS_NAMESPACE,
    profile,
    policy,
    memoryCapBytes: cap,
    maxTiles,
    tileBytes,
    render,
    sync,
    maskFor,
    toRGBA,
    checksum: index => checksumOf(index),
    tiles: () => [...order.keys()],
    dispose,
    get bytes() { return order.size * tileBytes; },
    get diagnostics() {
      return Object.freeze({
        namespace: GDO_SIGN_ATLAS_NAMESPACE,
        profile,
        maxTiles,
        tiles: order.size,
        tileBytes,
        bytes: order.size * tileBytes,
        memoryCapBytes: cap,
        renders,
        regenerations,
        reuses,
        evictions,
        syncs,
        substitutedGlyphs,
        malformedInputs,
        // One shared atlas, palette outside the texture: no per-building material,
        // no per-frame upload, no steady-frame allocation.
        materials: order.size > 0 ? 1 : 0,
        addedDrawCalls: order.size > 0 ? 1 : 0,
        steadyFrameAllocations: 0,
        disposed,
        refusals: Object.freeze({ ...refusals }),
      });
    },
  });
}

/** What a DOM label costs, as a declared model (`measured: false`). */
export function estimateDomLabelCost({ nodes = 0, visible = null, profile = 'low' } = {}) {
  const policy = policyFor(profile);
  const count = Math.max(0, Math.floor(nodes));
  const shown = Number.isFinite(visible) ? Math.max(0, Math.min(count, Math.floor(visible))) : count;
  return Object.freeze({
    strategy: GDO_SIGN_STRATEGY.DOM_LABELS,
    measured: false,
    source: 'declared-dom-model',
    nodes: count,
    visible: shown,
    bytes: count * policy.domNodeBytes,
    // A DOM label writes hidden, text, transform, opacity, and a dataset key every
    // frame it is laid out; that is where its steady cost lives.
    steadyFrameWrites: shown * policy.domWritesPerNode,
    layoutOpsPerFrame: shown,
    textureBytes: 0,
    addedDrawCalls: 0,
    // A name is a screen-space annotation: always readable, never scene weight.
    value: Object.freeze({ anchoring: 0, readability: 1, steadyWork: 0.15 }),
  });
}

/** What the atlas costs for the same content, as exact arithmetic. */
export function estimateAtlasCost({ plates = [], profile = 'low', memoryCapBytes = null } = {}) {
  const policy = policyFor(profile);
  const texts = [...new Set(plates.filter(text => typeof text === 'string' && text.length))]
    .map(text => sanitiseSignText(text).text)
    .filter(text => text.length <= policy.maxChars);
  const cap = Number.isFinite(memoryCapBytes) && memoryCapBytes >= 0
    ? Math.min(memoryCapBytes, policy.maxBytes) : policy.maxBytes;
  const tileBytes = tileBytesFor(policy);
  const maxTiles = Math.min(policy.maxTiles, Math.floor(cap / tileBytes));
  const tiles = Math.min(texts.length, Math.max(0, maxTiles));
  const legibility = texts.length
    ? texts.reduce((total, text) => total + signLegibility(text.length, policy), 0) / texts.length : 0;
  return Object.freeze({
    strategy: GDO_SIGN_STRATEGY.GENERATED_ATLAS,
    measured: true,
    tiles,
    maxTiles,
    tileBytes,
    bytes: tiles * tileBytes,
    uniqueTexts: texts.length,
    // Everything the budget cannot hold is regenerated on every label change.
    thrash: Math.max(0, texts.length - Math.max(0, maxTiles)),
    steadyFrameWrites: 0,
    layoutOpsPerFrame: 0,
    textureBytes: tiles * tileBytes,
    addedDrawCalls: tiles > 0 ? 1 : 0,
    legibility,
    value: Object.freeze({ anchoring: 1, readability: legibility, steadyWork: 1 }),
  });
}

/** Value weights: scene anchoring, then readability, then steady-frame work. */
export const GDO_SIGN_VALUE_WEIGHTS = Object.freeze({ anchoring: 3, readability: 2, steadyWork: 2 });
export const GDO_SIGN_VALUE_MARGIN = .1;

function valueOf(candidate, weights = GDO_SIGN_VALUE_WEIGHTS) {
  const total = weights.anchoring + weights.readability + weights.steadyWork;
  return (candidate.value.anchoring * weights.anchoring
    + candidate.value.readability * weights.readability
    + candidate.value.steadyWork * weights.steadyWork) / total;
}

/**
 * The decision the row is gated on.
 *
 * `labels` are geographic names (the DOM path the research protects); `plates` are
 * in-scene sign texts the atlas could carry. The atlas is chosen only when it fits
 * the memory cap, has no tile thrash, and beats the DOM model by the declared
 * value margin.
 */
export function benchmarkSignStrategy({
  profile = 'low',
  labels = [],
  plates = [],
  viewport = { width: 1280, height: 720 },
  memoryCapBytes = null,
  weights = GDO_SIGN_VALUE_WEIGHTS,
  margin = GDO_SIGN_VALUE_MARGIN,
} = {}) {
  const policy = policyFor(profile);
  const cap = Number.isFinite(memoryCapBytes) && memoryCapBytes >= 0
    ? Math.min(memoryCapBytes, policy.maxBytes) : policy.maxBytes;
  const labelCount = Array.isArray(labels) ? labels.length : 0;
  const plateTexts = Array.isArray(plates) ? plates : [];

  const dom = estimateDomLabelCost({ nodes: labelCount + plateTexts.length, visible: labelCount + plateTexts.length, profile });
  const atlas = estimateAtlasCost({ plates: plateTexts, profile, memoryCapBytes: cap });
  const domValue = valueOf(dom, weights);
  const atlasValue = valueOf(atlas, weights);

  let decision;
  if (labelCount === 0 && atlas.uniqueTexts === 0) {
    decision = Object.freeze({ profile, strategy: GDO_SIGN_STRATEGY.DOM_LABELS, reason: GDO_SIGN_REASON.NOTHING_TO_SHOW, tiles: 0, bytes: 0, overflow: 0 });
  } else if (atlas.uniqueTexts === 0) {
    // Only geographic names: the research keeps them in the DOM path.
    decision = Object.freeze({
      profile, strategy: GDO_SIGN_STRATEGY.DOM_LABELS, reason: GDO_SIGN_REASON.MAP_NAMES_STAY_DOM,
      tiles: 0, bytes: 0, overflow: 0, domValue, atlasValue,
    });
  } else if (atlas.tiles === 0 || atlas.bytes > cap) {
    decision = Object.freeze({
      profile, strategy: GDO_SIGN_STRATEGY.DOM_LABELS, reason: GDO_SIGN_REASON.MEMORY_CAP,
      tiles: 0, bytes: 0, overflow: atlas.uniqueTexts, memoryCapBytes: cap, domValue, atlasValue,
    });
  } else if (atlas.thrash > 0) {
    // More distinct plates than tiles: the atlas would regenerate every frame the
    // set changes, so the DOM keeps them and the overflow is named.
    decision = Object.freeze({
      profile, strategy: GDO_SIGN_STRATEGY.DOM_LABELS, reason: GDO_SIGN_REASON.TILE_THRASH,
      tiles: atlas.tiles, bytes: atlas.bytes, overflow: atlas.thrash, domValue, atlasValue,
    });
  } else if (atlasValue >= domValue + margin) {
    decision = Object.freeze({
      profile, strategy: GDO_SIGN_STRATEGY.GENERATED_ATLAS, reason: GDO_SIGN_REASON.ATLAS_EARNED,
      tiles: atlas.tiles, bytes: atlas.bytes, overflow: 0, domValue, atlasValue,
    });
  } else {
    decision = Object.freeze({
      profile, strategy: GDO_SIGN_STRATEGY.DOM_LABELS, reason: GDO_SIGN_REASON.DOM_CHEAPER,
      tiles: 0, bytes: 0, overflow: atlas.uniqueTexts, domValue, atlasValue,
    });
  }

  return Object.freeze({
    namespace: GDO_SIGN_ATLAS_NAMESPACE,
    profile,
    viewport: Object.freeze({ ...viewport }),
    budget: Object.freeze({
      maxTiles: policy.maxTiles,
      tileBytes: tileBytesFor(policy),
      maxBytes: policy.maxBytes,
      memoryCapBytes: cap,
      maxDrawCalls: policy.maxDrawCalls,
      maxSteadyFrameWrites: policy.maxSteadyFrameWrites,
      materialTextureBudgetBytes: GDO_LOW_PROFILE_BUDGETS.materialTextureBytes,
    }),
    candidates: Object.freeze([dom, atlas]),
    decision,
    weights: Object.freeze({ ...weights }),
    margin,
    // Nothing here is a clock: DOM bytes are a declared model, atlas bytes are
    // arithmetic over the tile grid, and the value terms are the exported weights.
    timing: null,
    deterministic: true,
  });
}
