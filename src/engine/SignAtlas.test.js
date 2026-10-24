import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from '../geo/GeoWorld.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import {
  GDO_SIGN_ATLAS_NAMESPACE,
  GDO_SIGN_GLYPHS,
  GDO_SIGN_MASK,
  GDO_SIGN_PROFILES,
  GDO_SIGN_REFUSAL,
  GDO_SIGN_REASON,
  GDO_SIGN_STRATEGY,
  GDO_SIGN_VALUE_WEIGHTS,
  benchmarkSignStrategy,
  createSignAtlas,
  estimateAtlasCost,
  estimateDomLabelCost,
  sanitiseSignText,
  signGlyphScale,
  signLegibility,
} from './SignAtlas.js';

test('MAT-06 declares the research bounds: 64×32 masks, four low tiles, palette outside', () => {
  assert.equal(GDO_SIGN_ATLAS_NAMESPACE, 'gdo:signAtlas:v1');

  // Research §6.4: "≤ 4 live 64×32 sign tiles on low profile".
  const low = GDO_SIGN_PROFILES.low;
  assert.equal(low.maxTiles, 4);
  assert.equal(low.tileWidth, 64);
  assert.equal(low.tileHeight, 32);
  assert.ok(GDO_SIGN_PROFILES.balanced.maxTiles > low.maxTiles);
  assert.ok(GDO_SIGN_PROFILES.high.maxTiles > GDO_SIGN_PROFILES.balanced.maxTiles);
  // One shared atlas or strict LRU: one draw call, no steady-frame writes.
  for (const policy of Object.values(GDO_SIGN_PROFILES)) {
    assert.equal(policy.maxSteadyFrameWrites, 0);
    assert.ok(policy.maxDrawCalls <= 2);
  }

  // The palette lives outside the texture: a tile is a single-channel mask.
  const atlas = createSignAtlas({ profile: 'low' });
  assert.equal(atlas.tileBytes, low.tileWidth * low.tileHeight);
  assert.ok(atlas.tileBytes * low.maxTiles <= GDO_LOW_PROFILE_BUDGETS.materialTextureBytes,
    'the whole atlas fits inside the shared material texture budget');
  assert.deepEqual(Object.values(GDO_SIGN_MASK).sort(), [0, 1, 2], 'background, border, ink');

  // The glyph mask is a constant covering the map-derived vocabulary.
  for (const character of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -./&?') {
    assert.ok(Object.hasOwn(GDO_SIGN_GLYPHS, character), `glyph ${character}`);
    assert.equal(GDO_SIGN_GLYPHS[character].length, 7, `${character} is seven rows tall`);
    for (const row of GDO_SIGN_GLYPHS[character]) assert.ok(row >= 0 && row <= 0x1F, `${character} is five columns wide`);
  }
  // Only the shipped letters: nothing outside the table reaches the mask.
  assert.deepEqual(sanitiseSignText('café 12'), { text: 'CAF? 12', substituted: 1 });
});

test('rendering is deterministic and the tile is a mask, not a colour image', () => {
  const first = createSignAtlas({ profile: 'low' });
  const second = createSignAtlas({ profile: 'low' });
  const rendered = first.render('MG ROAD');
  assert.equal(rendered.ok, true);
  assert.equal(rendered.tile, 0);
  assert.equal(rendered.width, 64);
  assert.equal(rendered.height, 32);
  assert.equal(rendered.reused, false);
  assert.equal(rendered.key, 'MG ROAD');
  // The same text renders the same pixels on an independent atlas.
  assert.equal(rendered.checksum, first.checksum(0));
  assert.equal(first.render('mg road').checksum, rendered.checksum, 'map text is case-folded');
  assert.equal(second.render('MG ROAD').checksum, rendered.checksum);
  assert.notEqual(first.render('CHAI').checksum, rendered.checksum);

  // The mask holds only the declared levels, with a border frame and ink inside it.
  const mask = first.maskFor(0);
  const seen = new Set(mask);
  for (const level of seen) assert.ok(level === 0 || level === 1 || level === 2);
  assert.equal(mask[0], GDO_SIGN_MASK.BORDER, 'the frame starts at the corner');
  assert.equal(mask[(32 - 1) * 64 + 63], GDO_SIGN_MASK.BORDER);
  let ink = 0;
  for (let index = 0; index < mask.length; index++) if (mask[index] === GDO_SIGN_MASK.INK) ink++;
  assert.ok(ink > 0, 'the glyphs are drawn');

  // Colour only exists when a host asks for it, and it comes from the caller.
  const rgba = first.toRGBA(0, { ink: [255, 0, 0, 255] });
  assert.equal(rgba.length, first.tileBytes * 4);
  const inkPixel = [...mask].indexOf(GDO_SIGN_MASK.INK);
  assert.deepEqual([...rgba.subarray(inkPixel * 4, inkPixel * 4 + 4)], [255, 0, 0, 255]);
  assert.equal(first.maskFor(9), null, 'an unrendered tile has no mask');
  assert.equal(first.toRGBA(9), null);
});

test('the atlas is a strict LRU: reuse, evict, zero the tile, never grow', () => {
  const atlas = createSignAtlas({ profile: 'low' });
  const policy = GDO_SIGN_PROFILES.low;
  assert.equal(atlas.maxTiles, policy.maxTiles);

  const chai = atlas.render('CHAI');
  atlas.render('BOOKS');
  atlas.render('SECTOR 4');
  atlas.render('MARKET');
  const before = atlas.bytes;
  assert.equal(atlas.diagnostics.tiles, policy.maxTiles);
  assert.equal(before, policy.maxTiles * atlas.tileBytes);

  // Touching the first entry makes it most-recently-used instead of least.
  const again = atlas.render('CHAI');
  assert.equal(again.reused, true);
  assert.equal(again.tile, chai.tile, 'a resident text keeps its tile');
  assert.equal(again.checksum, chai.checksum, 'and its pixels');

  // The next new text evicts the actual least-recently-used entry, not tile zero.
  const evictedTiles = [];
  const marketChecksum = atlas.checksum(atlas.render('MARKET').tile);
  const newest = atlas.render('FLOWERS');
  assert.equal(newest.ok, true);
  assert.equal(atlas.diagnostics.evictions, 1);
  assert.equal(atlas.tiles().includes('BOOKS'), false, 'the least recently used text is gone');
  assert.equal(atlas.tiles().includes('CHAI'), true, 'the text just touched survived');
  assert.equal(atlas.bytes, before, 'the pool never grows');
  assert.ok(atlas.tiles().length <= policy.maxTiles);
  evictedTiles.push(marketChecksum);
  assert.equal(atlas.diagnostics.steadyFrameAllocations, 0);

  // Rendering an evicted text again is a fresh render, not a stale hit.
  const rebuilt = atlas.render('BOOKS');
  assert.equal(rebuilt.reused, false);
  assert.equal(atlas.diagnostics.evictions, 2);
  assert.equal(atlas.diagnostics.reuses, 2, 'two resident hits: CHAI and MARKET');

  // A caller may pin the tile it wants when it is free.
  const pinned = createSignAtlas({ profile: 'low' });
  assert.equal(pinned.render('CHAI', { tile: 3 }).tile, 3);
  assert.equal(pinned.render('BOOKS', { tile: 3 }).tile, 0, 'a taken tile is not stolen');
});

test('bad text and exhausted budgets are named refusals, never silent drawings', () => {
  const atlas = createSignAtlas({ profile: 'low' });
  assert.equal(atlas.render('').refusal, GDO_SIGN_REFUSAL.BAD_INPUT);
  assert.equal(atlas.render(null).refusal, GDO_SIGN_REFUSAL.BAD_INPUT);
  assert.equal(atlas.render(42).refusal, GDO_SIGN_REFUSAL.BAD_INPUT);
  assert.equal(atlas.render('X'.repeat(GDO_SIGN_PROFILES.low.maxChars + 1)).refusal,
    GDO_SIGN_REFUSAL.TEXT_TOO_LONG);

  // An unsupported character is substituted and counted, not silently dropped.
  const substituted = atlas.render('CAFÉ');
  assert.equal(substituted.ok, true);
  assert.equal(substituted.key, 'CAF?');
  assert.equal(substituted.substituted, 1);
  assert.equal(atlas.diagnostics.substitutedGlyphs, 1);
  assert.equal(atlas.diagnostics.refusals[GDO_SIGN_REFUSAL.UNSUPPORTED_GLYPH], 1);

  // A cap that cannot hold even one tile refuses by name instead of over-allocating.
  const starved = createSignAtlas({ profile: 'low', memoryCapBytes: 0 });
  assert.equal(starved.maxTiles, 0);
  assert.equal(starved.render('CHAI').refusal, GDO_SIGN_REFUSAL.MEMORY_CAP);
  const half = createSignAtlas({ profile: 'low', memoryCapBytes: 2048 });
  assert.equal(half.maxTiles, 1, 'the cap is honoured exactly, not rounded up');
  assert.equal(half.render('CHAI').ok, true);
  assert.equal(half.render('BOOKS').ok, true);
  assert.equal(half.bytes, 2048, 'and never exceeds it');
  assert.equal(half.maxTiles, 1);

  atlas.dispose();
  assert.equal(atlas.render('CHAI').refusal, GDO_SIGN_REFUSAL.DISPOSED);
  assert.equal(atlas.sync(['CHAI']).refusal, GDO_SIGN_REFUSAL.DISPOSED);
  assert.equal(atlas.diagnostics.disposed, true);
  atlas.dispose();
  assert.equal(atlas.diagnostics.bytes, 0, 'dispose is idempotent and frees the tiles');
});

test('sync regenerates only when the label set changes', () => {
  const atlas = createSignAtlas({ profile: 'low' });
  const first = atlas.sync(['CHAI', 'BOOKS']);
  assert.equal(first.changed, true);
  assert.equal(first.renders, 2);
  assert.equal(first.thrash, 0);
  assert.equal(atlas.diagnostics.renders, 2);

  // An unchanged set does no work at all — the research's explicit rule.
  const second = atlas.sync(['BOOKS', 'CHAI', 'CHAI']);
  assert.equal(second.changed, false);
  assert.equal(second.renders, 0);
  assert.equal(atlas.diagnostics.renders, 2, 'no regeneration');

  // One new text renders one new tile and reuses the rest.
  const third = atlas.sync(['CHAI', 'BOOKS', 'MARKET']);
  assert.equal(third.changed, true);
  assert.equal(third.renders, 1, 'only the new text is drawn');
  assert.equal(atlas.diagnostics.renders, 3);
  assert.equal(atlas.diagnostics.reuses, 2, 'the two residents are touched, not redrawn');

  // More distinct plates than tiles: the excess is reported as thrash, not hidden.
  const fourth = atlas.sync(['CHAI', 'BOOKS', 'MARKET', 'FLOWERS', 'SECTOR 4', 'BAKERY']);
  assert.equal(fourth.thrash, 2);
  assert.ok(fourth.renders <= GDO_SIGN_PROFILES.low.maxRegenerationsPerSync);

  // Unrenderable entries are dropped from the set rather than poisoning it.
  const filtered = atlas.sync(['CHAI', '', null, 'X'.repeat(20)]);
  assert.equal(filtered.requested, 1);
  assert.equal(atlas.sync('not an array').refusal, GDO_SIGN_REFUSAL.BAD_INPUT);
});

test('the comparison keeps map names in the DOM and earns the atlas only for plates', () => {
  // Geographic names only: the research's protected DOM path wins outright.
  const names = benchmarkSignStrategy({ profile: 'low', labels: ['MG ROAD', 'MEERUT', 'GANGA'] });
  assert.equal(names.namespace, GDO_SIGN_ATLAS_NAMESPACE);
  assert.equal(names.deterministic, true);
  assert.equal(names.timing, null);
  assert.equal(names.decision.strategy, GDO_SIGN_STRATEGY.DOM_LABELS);
  assert.equal(names.decision.reason, GDO_SIGN_REASON.MAP_NAMES_STAY_DOM);
  assert.equal(names.decision.tiles, 0);

  // An in-scene sign plate is scene weight: the atlas earns its tiles.
  const plates = benchmarkSignStrategy({ profile: 'low', plates: ['CHAI CORNER', 'BOOKS'] });
  assert.equal(plates.decision.strategy, GDO_SIGN_STRATEGY.GENERATED_ATLAS);
  assert.equal(plates.decision.reason, GDO_SIGN_REASON.ATLAS_EARNED);
  assert.ok(plates.decision.tiles >= 1 && plates.decision.tiles <= GDO_SIGN_PROFILES.low.maxTiles);
  assert.ok(plates.decision.bytes <= plates.budget.memoryCapBytes);
  const atlas = plates.candidates.find(candidate => candidate.strategy === GDO_SIGN_STRATEGY.GENERATED_ATLAS);
  const dom = plates.candidates.find(candidate => candidate.strategy === GDO_SIGN_STRATEGY.DOM_LABELS);
  assert.equal(atlas.steadyFrameWrites, 0, 'the atlas does no per-frame DOM work');
  assert.equal(atlas.addedDrawCalls, 1, 'one shared draw for every plate');
  assert.equal(dom.measured, false, 'the DOM side is a declared model, and says so');
  assert.ok(dom.steadyFrameWrites > 0, 'a DOM label writes every frame it is laid out');
  assert.ok(plates.decision.atlasValue > plates.decision.domValue + plates.margin);

  // More plates than tiles: the atlas would thrash, so the DOM keeps them.
  const crowded = benchmarkSignStrategy({
    profile: 'low',
    plates: Array.from({ length: 9 }, (_, index) => `SHOP ${index + 1}`),
  });
  assert.equal(crowded.decision.reason, GDO_SIGN_REASON.TILE_THRASH);
  assert.equal(crowded.decision.strategy, GDO_SIGN_STRATEGY.DOM_LABELS);
  assert.equal(crowded.decision.overflow, 9 - GDO_SIGN_PROFILES.low.maxTiles);
  // The same set fits on high, and is then served by the atlas.
  const roomy = benchmarkSignStrategy({
    profile: 'high',
    plates: Array.from({ length: 9 }, (_, index) => `SHOP ${index + 1}`),
  });
  assert.equal(roomy.decision.strategy, GDO_SIGN_STRATEGY.GENERATED_ATLAS);

  // The memory cap can refuse the technique before value is considered.
  const capped = benchmarkSignStrategy({ profile: 'high', plates: ['CHAI'], memoryCapBytes: 0 });
  assert.equal(capped.decision.reason, GDO_SIGN_REASON.MEMORY_CAP);
  assert.equal(capped.decision.tiles, 0);
  assert.equal(capped.decision.overflow, 1);

  // With nothing at all, neither path is chosen.
  const empty = benchmarkSignStrategy({ profile: 'low' });
  assert.equal(empty.decision.reason, GDO_SIGN_REASON.NOTHING_TO_SHOW);

  // Re-weighting can reverse the answer, and the reason changes with it.
  const readabilityFirst = benchmarkSignStrategy({
    profile: 'low', plates: ['CHAI'],
    weights: { anchoring: 0, readability: 4, steadyWork: 0 },
  });
  assert.equal(readabilityFirst.decision.strategy, GDO_SIGN_STRATEGY.DOM_LABELS);
  assert.equal(readabilityFirst.decision.reason, GDO_SIGN_REASON.DOM_CHEAPER);
});

test('every priced quantity is arithmetic a second run reproduces exactly', () => {
  const options = { profile: 'balanced', labels: ['A', 'B'], plates: ['CHAI', 'BOOKS'] };
  assert.deepEqual(benchmarkSignStrategy(options), benchmarkSignStrategy(options));

  const atlas = estimateAtlasCost({ plates: ['CHAI', 'BOOKS'], profile: 'balanced' });
  assert.equal(atlas.tileBytes, GDO_SIGN_PROFILES.balanced.tileWidth * GDO_SIGN_PROFILES.balanced.tileHeight);
  assert.equal(atlas.bytes, atlas.tiles * atlas.tileBytes);
  assert.equal(atlas.steadyFrameWrites, 0);
  assert.equal(atlas.layoutOpsPerFrame, 0);
  assert.ok(atlas.bytes <= GDO_LOW_PROFILE_BUDGETS.materialTextureBytes);

  const dom = estimateDomLabelCost({ nodes: 10, profile: 'balanced' });
  assert.equal(dom.bytes, 10 * GDO_SIGN_PROFILES.balanced.domNodeBytes);
  assert.equal(dom.steadyFrameWrites, 10 * GDO_SIGN_PROFILES.balanced.domWritesPerNode);

  // Legibility is the renderer's own scale, so it cannot be tuned independently.
  const policy = GDO_SIGN_PROFILES.balanced;
  assert.equal(signGlyphScale(1, policy), policy.maxGlyphScale);
  assert.equal(signGlyphScale(12, policy), 1);
  assert.equal(signLegibility(4, policy), signGlyphScale(4, policy) / policy.maxGlyphScale);
  assert.equal(GDO_SIGN_VALUE_WEIGHTS.anchoring > GDO_SIGN_VALUE_WEIGHTS.readability, true,
    'scene anchoring outranks screen-space readability, by declaration');

  // Malformed input cannot be coerced into a favourable answer.
  const malformed = benchmarkSignStrategy({ profile: 'nonsense', labels: 'nope', plates: null });
  assert.equal(malformed.scene, undefined);
  assert.equal(malformed.decision.reason, GDO_SIGN_REASON.NOTHING_TO_SHOW);
});

test('the world mounts the atlas and keeps its map names in the DOM', () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  try {
    const world = new GeoWorld(new THREE.Scene(), { latitude: 28.99, longitude: 77.71 });
    assert.equal(world.signAtlas.namespace, GDO_SIGN_ATLAS_NAMESPACE);
    // The atlas may never borrow from the shared material texture budget.
    assert.ok(world.signAtlas.memoryCapBytes <= GDO_LOW_PROFILE_BUDGETS.materialTextureBytes);

    const plate = world.renderSignPlate('MG ROAD');
    assert.equal(plate.ok, true);
    assert.equal(plate.namespace, GDO_SIGN_ATLAS_NAMESPACE);
    assert.equal(plate.tile, 0);
    assert.ok(plate.bytes <= world.signAtlas.memoryCapBytes);
    assert.equal(typeof plate.checksum, 'string');
    assert.equal(world.signAtlasSummary.tiles, 1);

    // Only on a set change.
    assert.equal(world.syncSignPlates(['MG ROAD', 'CHAI']).changed, true);
    assert.equal(world.syncSignPlates(['MG ROAD', 'CHAI']).changed, false);
    assert.ok(world.signAtlasSummary.renders >= 2);
    assert.ok(world.signAtlasSummary.bytes <= world.signAtlas.memoryCapBytes);

    // The world's own names stay in the DOM path: no plates, no atlas. (With no
    // resident tiles there are no names either, and the honest answer is nothing.)
    const namesOnly = world.signStrategy({ labels: ['MG ROAD', 'MEERUT'] });
    assert.equal(namesOnly.decision.reason, GDO_SIGN_REASON.MAP_NAMES_STAY_DOM);
    assert.equal(namesOnly.decision.tiles, 0);
    assert.equal(world.signStrategy().decision.reason, GDO_SIGN_REASON.NOTHING_TO_SHOW);
    // A plate is where the atlas earns, and the world quotes it.
    const withPlate = world.signStrategy({ plates: ['CHAI'] });
    assert.equal(withPlate.decision.reason, GDO_SIGN_REASON.ATLAS_EARNED);
    assert.equal(withPlate.profile, 'low');

    world.dispose();
    assert.equal(world.renderSignPlate('CHAI').refusal, 'disposed');
    assert.equal(world.signAtlas.diagnostics.disposed, true, 'disposed through the world ledger');
  } finally {
    globalThis.Worker = originalWorker;
  }
});
