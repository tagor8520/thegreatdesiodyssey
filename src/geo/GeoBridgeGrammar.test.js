import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_BRIDGE_NAMESPACE,
  GEO_BRIDGE_FAMILY,
  GEO_BRIDGE_FAMILY_NAMES,
  GEO_BRIDGE_FIELD,
  GEO_BRIDGE_LIMITS,
  GEO_BRIDGE_STRIDE,
  bridgeCorridorHalfWidth,
  bridgeRecipes,
  bridgeRequiredCorridorHalfWidth,
  compileBridges,
} from './GeoBridgeGrammar.js';
import { GEO_PLAYER_COLLISION_PROFILE } from './GeoCollision.js';
import { GEO_SUPPORT_ROLE } from './GeoSupportSlots.js';
import { transportSurfaceY } from './GeoLayers.js';
import { terrainHeightAt } from './GeoTerrain.js';

const request = Object.freeze({
  tileX: 0, tileY: 0, originX: 0, originY: 0, tileSize: 100, terrainSeed: 7,
});

function point(x, y) { return Object.freeze({ x, y }); }

function feature(points, properties = {}) {
  const geometry = [points.map(([x, y]) => point(x, y))];
  return Object.freeze({
    type: 2,
    extent: 100,
    properties: Object.freeze({ ...properties }),
    loadGeometry: () => geometry,
  });
}

function layer(...features) {
  return Object.freeze({ length: features.length, feature: index => features[index] });
}

function compile(features, options = {}) {
  return compileBridges({ layers: { transportation: layer(...features) } }, { ...request, ...options });
}

// A 40 m mapped bridge across the tile centre: primary grade, one physical level up.
const bridgeLine = [[10, 50], [90, 50]];
const bridge = properties => feature(bridgeLine, { class: 'primary', brunnel: 'bridge', ...properties });

function recordsOf(result) {
  const records = [];
  for (let offset = 0; offset < result.placements.length; offset += GEO_BRIDGE_STRIDE) {
    records.push(Object.fromEntries(Object.entries(GEO_BRIDGE_FIELD)
      .map(([name, index]) => [name.toLowerCase(), result.placements[offset + index]])));
  }
  return records;
}

const byFamily = (result, family) => recordsOf(result).filter(record => record.family === family);

test('DET-08 declares seven fixed DET-02 families from a bridge-deck support role', () => {
  const recipes = bridgeRecipes();
  assert.equal(GDO_BRIDGE_NAMESPACE, 'gdo:bridgeGrammar:v1');
  assert.equal(GEO_BRIDGE_STRIDE, 11);
  assert.equal(recipes.length, 7);
  assert.deepEqual(recipes.map(record => record.name), GEO_BRIDGE_FAMILY_NAMES);
  for (const record of recipes) {
    assert.ok(record.compiled.visualBoxes.length >= 2);
    assert.ok(record.compiled.visualBoxes.length <= GEO_BRIDGE_LIMITS.maxBoxesPerFamily);
    assert.ok(record.compiled.visualBoxes.every(box => ['silhouette', 'surface', 'accent'].includes(box.role)));
    assert.equal(record.recipe.support.roleMask, GEO_SUPPORT_ROLE.BRIDGE_DECK);
    assert.equal(record.recipe.authoritativeFootprint, 'physical-transport-level-deck');
    // No visual module may carry a proxy of any kind.
    assert.equal(record.compiled.solidProxies.length, 0);
    assert.equal(record.compiled.interactionProxies.length, 0);
    assert.equal(record.compiled.cameraRoles.length, 0);
  }
  // Linear families are authored to exactly one world unit on their scale axes.
  assert.equal(recipes[GEO_BRIDGE_FAMILY.RAIL_SPAN].recipe.visualBounds.minX, -.5);
  assert.equal(recipes[GEO_BRIDGE_FAMILY.RAIL_SPAN].recipe.visualBounds.maxX, .5);
  assert.equal(recipes[GEO_BRIDGE_FAMILY.DECK_SIDE].recipe.visualBounds.minZ, -.515);
  assert.deepEqual([
    recipes[GEO_BRIDGE_FAMILY.PIER].recipe.visualBounds.minY,
    recipes[GEO_BRIDGE_FAMILY.PIER].recipe.visualBounds.maxY,
  ], [-1, 0], 'pier modules hang below their deck-underside origin');
});

test('DET-08 only builds elevated grades and keeps every module on the semantic deck level', () => {
  const ground = feature(bridgeLine, { class: 'primary' });
  const tunnel = feature(bridgeLine, { class: 'primary', brunnel: 'tunnel' });
  const result = compile([ground, tunnel]);
  assert.equal(result.placements.length, 0);
  assert.equal(result.meta.spans, 0);
  assert.equal(result.meta.transportFeatures, 0);

  const single = compile([bridge()]);
  assert.ok(single.meta.placements > 0);
  assert.equal(single.meta.spans, 1);
  assert.equal(single.meta.maximumLevel, 1);
  assert.deepEqual(single.meta.levelCounts, { 1: 1 });
  const deckOffset = transportSurfaceY(1);
  assert.equal(deckOffset > transportSurfaceY(0), true);
  for (const record of recordsOf(single)) {
    // Deck-frame modules sit on the authoritative elevation, never a decal bias.
    assert.ok(Math.abs(record.y - (terrainHeightAt(record.x, record.z, request.terrainSeed) + deckOffset)) <= .13,
      `module ${record.family} drifted from the deck level`);
    assert.equal(record.level, 1);
  }
  // A second physical level raises every generated module by exactly one step.
  const raised = compile([feature(bridgeLine, { class: 'primary', brunnel: 'bridge', level: 2 })]);
  assert.equal(raised.meta.maximumLevel, 2);
  const piers = byFamily(single, GEO_BRIDGE_FAMILY.PIER).sort((a, b) => a.x - b.x);
  const raisedPiers = byFamily(raised, GEO_BRIDGE_FAMILY.PIER).sort((a, b) => a.x - b.x);
  assert.equal(raisedPiers.length, piers.length);
  for (let index = 0; index < piers.length; index++) {
    assert.equal(raisedPiers[index].x, piers[index].x);
    assert.ok(Math.abs((raisedPiers[index].y - piers[index].y) -
      (transportSurfaceY(2) - transportSurfaceY(1))) < 1e-4);
  }
});

test('DET-08 deck, rails, and openings agree with the traversal truth', () => {
  const result = compile([bridge()]);
  const required = bridgeRequiredCorridorHalfWidth();
  assert.equal(required, GEO_PLAYER_COLLISION_PROFILE.radius + GEO_PLAYER_COLLISION_PROFILE.skin +
    GEO_BRIDGE_LIMITS.corridorMargin);
  assert.equal(result.meta.railedSpans, 1);
  assert.equal(result.meta.narrowSpans, 0);
  assert.ok(result.meta.minimumCorridorHalfWidth >= required);

  const halfWidth = .5;
  const rails = byFamily(result, GEO_BRIDGE_FAMILY.RAIL_SPAN);
  assert.equal(rails.length, 2, 'one continuous rail line per deck side');
  const piers = byFamily(result, GEO_BRIDGE_FAMILY.PIER);
  assert.ok(piers.length >= 1);
  assert.equal(result.meta.piers, piers.length);
  assert.equal(result.meta.structuralPiers, piers.length);

  const centreX = 50, centreZ = 50;
  for (const rail of rails) {
    // The rail line stays outside the player's walkable corridor.
    const lateral = Math.abs(rail.z - centreZ);
    assert.ok(lateral + GEO_BRIDGE_LIMITS.railHalfThickness <= halfWidth + 1e-6,
      'rail must stay inside the mapped deck');
    assert.ok(lateral - GEO_BRIDGE_LIMITS.railHalfThickness >= required - 1e-6,
      'rail must leave the player corridor clear');
    // The rail is a silhouette band above the deck top, not a wall through it.
    assert.ok(rail.length > 0, 'rail spans use long segments rather than repeated boxes');
  }
  for (const pier of piers) {
    // Piers reach real terrain support instead of floating.
    const ground = terrainHeightAt(pier.x, pier.z, request.terrainSeed);
    assert.ok(Math.abs((pier.y - pier.height) - ground) < 1e-4, 'pier base must reach terrain support');
    assert.ok(pier.height >= GEO_BRIDGE_LIMITS.minStructuralClearance);
  }
  // Openings that cannot fit a pier are reported rather than faked.
  assert.ok(result.meta.minimumUndersideClearance >= GEO_BRIDGE_LIMITS.minPierClearance);
  assert.equal(result.meta.familyCounts[GEO_BRIDGE_FAMILY.RAIL_POST] > 0, true);
});

test('DET-08 skips rails on decks too narrow to keep the player corridor clear', () => {
  // A 1.8 m mapped path bridge is narrower than the authoritative player profile.
  const narrow = compile([feature(bridgeLine, { class: 'footway', brunnel: 'bridge' })]);
  assert.equal(narrow.meta.spans, 1);
  assert.equal(narrow.meta.narrowSpans, 1);
  assert.equal(narrow.meta.railedSpans, 0);
  assert.equal(byFamily(narrow, GEO_BRIDGE_FAMILY.RAIL_SPAN).length, 0);
  assert.equal(byFamily(narrow, GEO_BRIDGE_FAMILY.RAIL_POST).length, 0);
  assert.equal(narrow.meta.accents, 0);
  // Deck structure and piers are still built, so the bridge is never bare.
  assert.ok(byFamily(narrow, GEO_BRIDGE_FAMILY.DECK_SIDE).length === 1);
  assert.equal(byFamily(narrow, GEO_BRIDGE_FAMILY.DECK_BAND).length, 2);
  assert.ok(byFamily(narrow, GEO_BRIDGE_FAMILY.PIER).length >= 1);
  const halfWidth = 1.8 * .1 / 2;
  assert.ok(bridgeCorridorHalfWidth(halfWidth) < bridgeRequiredCorridorHalfWidth());
  assert.ok(bridgeCorridorHalfWidth(.275) > bridgeRequiredCorridorHalfWidth());
});

test('DET-08 output is byte-stable across feature order and line direction', () => {
  const forward = compile([bridge()]);
  const reversed = compile([feature([...bridgeLine].reverse(), { class: 'primary', brunnel: 'bridge' })]);
  const reordered = compile([
    feature([[10, 80], [90, 80]], { class: 'residential', brunnel: 'bridge' }),
    bridge(),
  ]);
  const reorderedAgain = compile([
    bridge(),
    feature([[10, 80], [90, 80]], { class: 'residential', brunnel: 'bridge' }),
  ]);
  // Winding must not change one byte of the module stream.
  assert.deepEqual([...forward.placements], [...reversed.placements]);
  assert.equal(forward.meta.placements, reversed.meta.placements);
  // Provider feature order must not either.
  assert.deepEqual([...reordered.placements], [...reorderedAgain.placements]);
  assert.equal(reordered.meta.spans, 2);
  assert.equal(reordered.meta.railedSpans, 2);
  assert.ok(reordered.meta.placements > forward.meta.placements);
  // Stable IDs are unique and 24-bit within one owner payload.
  const ids = recordsOf(reordered).map(record => record.stable_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => Number.isInteger(id) && id >= 0 && id <= 0x00ffffff));
  // A translated tile reproduces the same structure even though terrain, and so
  // the deck height, is a different function of the new world position.
  const shifted = compile([bridge()], { originX: -1 });
  // Pier height tracks the real terrain below each span, so structure compares
  // the module set rather than the terrain-driven stretch factor.
  const structure = result => recordsOf(result)
    .filter(record => record.family !== GEO_BRIDGE_FAMILY.LAMP && record.family !== GEO_BRIDGE_FAMILY.SIGN)
    .map(record => [record.family, record.length, record.width, record.level].join(':'))
    .sort();
  assert.deepEqual(structure(shifted), structure(forward));
  for (const record of recordsOf(shifted)) assert.ok(record.x >= 100, 'translated tile moved every module');
});

test('DET-08 malformed or capped source domains fail closed without partial bridges', () => {
  const broken = Object.freeze({
    type: 2, extent: 100,
    properties: Object.freeze({ class: 'primary', brunnel: 'bridge' }),
    loadGeometry: () => { throw new Error('bad geometry'); },
  });
  const malformed = compile([bridge(), broken]);
  assert.equal(malformed.meta.malformedSegments, 1);
  assert.equal(malformed.meta.capEvents.malformedSegments, true);
  assert.equal(malformed.meta.spans, 1, 'well-formed spans still build');

  const nan = compile([feature([[10, 50], [90, 50]], { class: 'primary', brunnel: 'bridge', level: 'x' })]);
  assert.equal(nan.meta.maximumLevel, 1);

  const tooMany = Array.from({ length: GEO_BRIDGE_LIMITS.maxSegments + 4 }, (_, index) => {
    const column = index % 32, row = Math.floor(index / 32);
    return feature([[column * 3, row * 3], [column * 3 + 2, row * 3 + 2]], { class: 'primary', brunnel: 'bridge' });
  });
  const truncated = compile(tooMany);
  assert.equal(truncated.meta.capEvents.segments, true);
  assert.equal(truncated.placements.length, 0, 'a truncated source set yields no partial bridge stream');
  assert.equal(truncated.meta.placements, 0);

  const noTransport = compileBridges({ layers: {} }, request);
  assert.equal(noTransport.placements.length, 0);
  assert.throws(() => compileBridges({ layers: {} }, { tileSize: 0 }), /finite source-tile request/);
});

test('DET-08 keeps accents sparse, non-solid, and off rail-graded spans', () => {
  const lines = Array.from({ length: 9 }, (_, index) => [10, 8 + index * 10, 90, 8 + index * 10]);
  const result = compile(lines.map(([x1, z1, x2, z2]) => feature([[x1, z1], [x2, z2]],
    { class: 'primary', brunnel: 'bridge' })));
  assert.equal(result.meta.spans, 9);
  assert.ok(result.meta.accents > 0);
  assert.ok(result.meta.accents <= GEO_BRIDGE_LIMITS.maxAccentsPerTile);
  assert.ok(result.meta.accents <= result.meta.spans, 'at most one accent per span');
  assert.ok(result.meta.accents < result.meta.spans * GEO_BRIDGE_LIMITS.accentSpanInterval / 2,
    'accents stay sparse rather than covering every span');
  for (const record of recordsOf(result)) {
    if (record.family !== GEO_BRIDGE_FAMILY.LAMP && record.family !== GEO_BRIDGE_FAMILY.SIGN) continue;
    // Accents mount on the rail line at deck grade, never below it.
    assert.ok(record.height === 0 && record.length === 0 && record.width === 0);
  }
  const railGrade = compile([feature(bridgeLine, { class: 'rail', brunnel: 'bridge' })]);
  assert.equal(railGrade.meta.accents, 0, 'rail-graded bridges get no street furniture');
  assert.equal(byFamily(railGrade, GEO_BRIDGE_FAMILY.RAIL_SPAN).length, 2);
});

test('DET-08 admits spans whole and stays inside its per-tile record ceiling', () => {
  const dense = Array.from({ length: 40 }, (_, index) => feature(
    [[4, 4 + index * 2.2], [96, 4 + index * 2.2]], { class: 'motorway', brunnel: 'bridge' },
  ));
  const result = compile(dense);
  assert.ok(result.meta.placements <= GEO_BRIDGE_LIMITS.maxPlacementsPerTile);
  assert.ok(result.placements.byteLength <= GEO_BRIDGE_LIMITS.bytesPerTile);
  assert.equal(result.meta.capEvents.placements, true);
  // Every admitted span is complete: deck sides, joint bands, and both rails.
  const spans = result.meta.spans;
  assert.ok(spans > 0 && spans < dense.length);
  assert.equal(byFamily(result, GEO_BRIDGE_FAMILY.DECK_SIDE).length, spans);
  assert.equal(byFamily(result, GEO_BRIDGE_FAMILY.DECK_BAND).length, spans * 2);
  assert.equal(byFamily(result, GEO_BRIDGE_FAMILY.RAIL_SPAN).length, spans * 2);
  assert.equal(result.meta.rejected.placementCap, dense.length - spans);
});
