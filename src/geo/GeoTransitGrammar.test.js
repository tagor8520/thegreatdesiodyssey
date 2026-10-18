import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMapTransport, GEO_MAP_SCHEMA, GEO_ROAD_CLASS } from './GeoMapSemantics.js';
import {
  GDO_TRANSIT_FAMILY,
  GDO_TRANSIT_LIMITS,
  GDO_TRANSIT_NAMESPACE,
  GDO_TRANSIT_RECIPES,
  GDO_TRANSIT_REFUSAL,
  classifyTransitCrossing,
  isAirsideFamily,
  isRailFamily,
  planLevelCrossing,
  planSegmentTransitDetail,
  transitFamily,
} from './GeoTransitGrammar.js';
import { GDO_FEATURE_VERSIONS, featureNamespace } from '../engine/FeatureVersions.js';

function recordingEmitter() {
  const quads = [];
  const boxes = [];
  return {
    quads,
    boxes,
    quad(x1, z1, x2, z2, halfWidth, y1, y2, color) {
      quads.push({ x1, z1, x2, z2, halfWidth, y1, y2, color });
    },
    box(x, y, z, sizeX, sizeY, sizeZ, color) {
      boxes.push({ x, y, z, sizeX, sizeY, sizeZ, color });
    },
  };
}

test('TER-09 transit: the grammar namespace and every family recipe are declared data', () => {
  assert.equal(GDO_TRANSIT_NAMESPACE, 'gdo:transitGrammar:v1');
  assert.equal(featureNamespace('transitGrammar'), GDO_TRANSIT_NAMESPACE);
  assert.equal(GDO_FEATURE_VERSIONS.transitGrammar, 1);

  for (const family of Object.values(GDO_TRANSIT_FAMILY)) {
    if (family === GDO_TRANSIT_FAMILY.NONE) continue;
    const recipe = GDO_TRANSIT_RECIPES[family];
    assert.ok(recipe, `family ${family} has a recipe`);
    assert.equal(recipe.family, family);
    assert.ok(recipe.widthMetres > 0 && Number.isFinite(recipe.widthMetres));
    assert.equal(recipe.surfaceColor.length, 3);
  }
  // Rail families carry a gauge and rail heads; the tram is inlaid (no sleepers).
  for (const family of [GDO_TRANSIT_FAMILY.HEAVY_RAIL, GDO_TRANSIT_FAMILY.LIGHT_RAIL,
    GDO_TRANSIT_FAMILY.SUBWAY, GDO_TRANSIT_FAMILY.FUNICULAR]) {
    assert.ok(GDO_TRANSIT_RECIPES[family].rail.gaugeMetres > 0, `${family} declares a gauge`);
    assert.ok(GDO_TRANSIT_RECIPES[family].sleeper, `${family} declares a sleeper rhythm`);
  }
  assert.equal(GDO_TRANSIT_RECIPES[GDO_TRANSIT_FAMILY.TRAM].sleeper, null);
  // Airside families declare their markings; only a runway has threshold bars.
  assert.ok(GDO_TRANSIT_RECIPES[GDO_TRANSIT_FAMILY.RUNWAY].threshold.bars >= 4);
  assert.equal(GDO_TRANSIT_RECIPES[GDO_TRANSIT_FAMILY.TAXIWAY].threshold, null);
});

test('TER-09 transit: families come from the one MAP-08 transport record, both schemas', () => {
  const cases = [
    [{ class: 'rail' }, GEO_MAP_SCHEMA.OPENMAPTILES, GDO_TRANSIT_FAMILY.HEAVY_RAIL],
    [{ class: 'rail', subclass: 'tram' }, GEO_MAP_SCHEMA.OPENMAPTILES, GDO_TRANSIT_FAMILY.TRAM],
    [{ class: 'rail', subclass: 'light_rail' }, GEO_MAP_SCHEMA.OPENMAPTILES, GDO_TRANSIT_FAMILY.LIGHT_RAIL],
    [{ class: 'rail', subclass: 'monorail' }, GEO_MAP_SCHEMA.OPENMAPTILES, GDO_TRANSIT_FAMILY.MONORAIL],
    [{ class: 'rail', subclass: 'subway' }, GEO_MAP_SCHEMA.OPENMAPTILES, GDO_TRANSIT_FAMILY.SUBWAY],
    [{ class: 'rail', subclass: 'funicular' }, GEO_MAP_SCHEMA.OPENMAPTILES, GDO_TRANSIT_FAMILY.FUNICULAR],
    [{ kind: 'tram' }, GEO_MAP_SCHEMA.SHORTBREAD, GDO_TRANSIT_FAMILY.TRAM],
    [{ kind: 'monorail' }, GEO_MAP_SCHEMA.SHORTBREAD, GDO_TRANSIT_FAMILY.MONORAIL],
    [{ kind: 'runway' }, GEO_MAP_SCHEMA.SHORTBREAD, GDO_TRANSIT_FAMILY.RUNWAY],
    [{ kind: 'taxiway' }, GEO_MAP_SCHEMA.SHORTBREAD, GDO_TRANSIT_FAMILY.TAXIWAY],
    [{ kind: 'residential' }, GEO_MAP_SCHEMA.SHORTBREAD, GDO_TRANSIT_FAMILY.NONE],
    [{ class: 'primary' }, GEO_MAP_SCHEMA.OPENMAPTILES, GDO_TRANSIT_FAMILY.NONE],
    [{ class: 'runway' }, GEO_MAP_SCHEMA.OPENMAPTILES, GDO_TRANSIT_FAMILY.RUNWAY],
    [{ class: 'taxiway' }, GEO_MAP_SCHEMA.OPENMAPTILES, GDO_TRANSIT_FAMILY.TAXIWAY],
  ];
  for (const [properties, schema, expected] of cases) {
    const transport = describeMapTransport(properties, schema);
    assert.equal(transitFamily(transport), expected, `${JSON.stringify(properties)} → ${expected}`);
  }
  assert.equal(transitFamily(null), GDO_TRANSIT_FAMILY.NONE);
  assert.equal(transitFamily({}), GDO_TRANSIT_FAMILY.NONE);
  assert.ok(isRailFamily(GDO_TRANSIT_FAMILY.HEAVY_RAIL));
  assert.ok(!isRailFamily(GDO_TRANSIT_FAMILY.RUNWAY));
  assert.ok(isAirsideFamily(GDO_TRANSIT_FAMILY.TAXIWAY));
});

test('TER-09 transit: the crossing rule accepts one road × one rail at ground and refuses by name', () => {
  const road = { family: 'minor', physicalLevel: 0 };
  const rail = { family: GDO_TRANSIT_FAMILY.HEAVY_RAIL, physicalLevel: 0 };

  const crossing = classifyTransitCrossing(road, rail);
  assert.equal(crossing.crossing, true);
  assert.equal(crossing.kind, 'level-crossing');
  assert.equal(crossing.railFamily, GDO_TRANSIT_FAMILY.HEAVY_RAIL);
  assert.equal(crossing.roadFamily, 'minor');
  // Order does not matter.
  assert.equal(classifyTransitCrossing(rail, road).crossing, true);

  // Grade-separated pairs are not crossings — the layering already separates them.
  const overpass = classifyTransitCrossing({ family: 'minor', physicalLevel: 1 }, rail);
  assert.equal(overpass.crossing, false);
  assert.equal(overpass.refusal, GDO_TRANSIT_REFUSAL.DIFFERENT_LEVEL);
  const bridgeRail = classifyTransitCrossing(road, { family: GDO_TRANSIT_FAMILY.HEAVY_RAIL, physicalLevel: -1 });
  assert.equal(bridgeRail.refusal, GDO_TRANSIT_REFUSAL.DIFFERENT_LEVEL);

  // Airside roads never cross a track; rails never cross each other; nothing is
  // invented from two ordinary roads.
  assert.equal(classifyTransitCrossing({ family: 'runway', physicalLevel: 0 }, rail).refusal,
    GDO_TRANSIT_REFUSAL.AIRSIDE_SEPARATION);
  assert.equal(classifyTransitCrossing({ family: 'minor', physicalLevel: 0 }, { family: GDO_TRANSIT_FAMILY.RUNWAY, physicalLevel: 0 }).refusal,
    GDO_TRANSIT_REFUSAL.AIRSIDE_SEPARATION);
  assert.equal(classifyTransitCrossing(rail, { family: GDO_TRANSIT_FAMILY.TRAM, physicalLevel: 0 }).refusal,
    GDO_TRANSIT_REFUSAL.TRANSIT_JUNCTION);
  assert.equal(classifyTransitCrossing({ family: 'minor', physicalLevel: 0 }, { family: 'path', physicalLevel: 0 }).refusal,
    GDO_TRANSIT_REFUSAL.NO_TRANSIT);
});

test('TER-09 transit: rail detail is the declared gauge and sleeper rhythm, capped and deterministic', () => {
  const emitter = recordingEmitter();
  const budget = { quads: 0, boxes: 0, crossings: 0, crossingParts: 0 };
  const plan = planSegmentTransitDetail({
    family: GDO_TRANSIT_FAMILY.HEAVY_RAIL,
    x1: 0, z1: 0, x2: 2, z2: 0,
    heightAt: () => 0,
    emitter,
    budget,
    firstOfLine: true,
    lastOfLine: true,
  });
  // Two rail heads plus one sleeper per period along a 20 m segment.
  const recipe = GDO_TRANSIT_RECIPES[GDO_TRANSIT_FAMILY.HEAVY_RAIL];
  const expectedSleepers = Math.ceil((2 - recipe.sleeper.periodMetres * 0.05) / (recipe.sleeper.periodMetres * 0.1));
  assert.equal(plan.quads, 2 + expectedSleepers);
  assert.equal(emitter.quads[0].halfWidth, recipe.rail.widthMetres * 0.05);
  const gaugeOffset = Math.abs(emitter.quads[0].z1);
  assert.ok(Math.abs(gaugeOffset - recipe.rail.gaugeMetres * 0.05) < 1e-9, 'rail heads sit at the declared gauge');

  // The same plan twice is byte-identical.
  const second = recordingEmitter();
  const secondBudget = { quads: 0, boxes: 0, crossings: 0, crossingParts: 0 };
  planSegmentTransitDetail({
    family: GDO_TRANSIT_FAMILY.HEAVY_RAIL,
    x1: 0, z1: 0, x2: 2, z2: 0,
    heightAt: () => 0, emitter: second, budget: secondBudget, firstOfLine: true, lastOfLine: true,
  });
  assert.deepEqual(second.quads, emitter.quads);

  // A saturated budget truncates deterministically and says so — never throws.
  const tinyBudget = { quads: GDO_TRANSIT_LIMITS.maxDetailQuads - 2, boxes: 0, crossings: 0, crossingParts: 0 };
  const truncatedEmitter = recordingEmitter();
  const truncated = planSegmentTransitDetail({
    family: GDO_TRANSIT_FAMILY.HEAVY_RAIL,
    x1: 0, z1: 0, x2: 2, z2: 0,
    heightAt: () => 0, emitter: truncatedEmitter, budget: tinyBudget,
  });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.quads, 2, 'only the room left in the budget is used');
});

test('TER-09 transit: airside markings land at declared offsets and thresholds only at line ends', () => {
  const recipe = GDO_TRANSIT_RECIPES[GDO_TRANSIT_FAMILY.RUNWAY];
  const emitter = recordingEmitter();
  const budget = { quads: 0, boxes: 0, crossings: 0, crossingParts: 0 };
  const plan = planSegmentTransitDetail({
    family: GDO_TRANSIT_FAMILY.RUNWAY,
    x1: 0, z1: 0, x2: 4, z2: 0,
    heightAt: () => 0,
    emitter,
    budget,
    firstOfLine: true,
    lastOfLine: false,
  });
  // Two edge lines + the dashed centreline + one threshold cluster at the start.
  const thresholdQuads = recipe.threshold.bars;
  assert.ok(plan.quads > thresholdQuads + 2);
  const edgeOffset = Math.abs(emitter.quads[0].z1);
  const expectedEdge = recipe.widthMetres * 0.05 - recipe.edge.insetMetres * 0.1 - recipe.edge.widthMetres * 0.05;
  assert.ok(Math.abs(edgeOffset - expectedEdge) < 1e-9, 'edge lines sit at the declared inset');

  // No line end, no threshold cluster.
  const middle = recordingEmitter();
  const middleBudget = { quads: 0, boxes: 0, crossings: 0, crossingParts: 0 };
  const middlePlan = planSegmentTransitDetail({
    family: GDO_TRANSIT_FAMILY.RUNWAY,
    x1: 0, z1: 0, x2: 4, z2: 0,
    heightAt: () => 0,
    emitter: middle,
    budget: middleBudget,
    firstOfLine: false,
    lastOfLine: false,
  });
  assert.equal(middlePlan.quads, plan.quads - thresholdQuads);

  // Taxiway: one continuous yellow centreline and its edges, no thresholds.
  const taxi = recordingEmitter();
  const taxiBudget = { quads: 0, boxes: 0, crossings: 0, crossingParts: 0 };
  const taxiPlan = planSegmentTransitDetail({
    family: GDO_TRANSIT_FAMILY.TAXIWAY,
    x1: 0, z1: 0, x2: 4, z2: 0,
    heightAt: () => 0,
    emitter: taxi,
    budget: taxiBudget,
    firstOfLine: true,
    lastOfLine: true,
  });
  assert.equal(taxiPlan.quads, 3);
  assert.deepEqual(taxi.quads[2].color, GDO_TRANSIT_RECIPES[GDO_TRANSIT_FAMILY.TAXIWAY].centerline.color);
});

test('TER-09 transit: the crossing patch is a road slab and one post/boom pair per approach', () => {
  const emitter = recordingEmitter();
  const budget = { quads: 0, boxes: 0, crossings: 0, crossingParts: 0 };
  const plan = planLevelCrossing({
    x: 5, z: 7,
    heightAt: () => 0,
    roadDirectionX: 1, roadDirectionZ: 0,
    railDirectionX: 0, railDirectionZ: 1,
    roadColor: [0.1, 0.1, 0.1],
    emitter,
    budget,
  });
  assert.equal(plan.parts, 5);          // slab + 2 posts + 2 booms
  assert.equal(plan.truncated, false);
  assert.equal(emitter.quads.length, 1);
  assert.equal(emitter.boxes.length, 4);
  assert.deepEqual(emitter.quads[0].color, [0.1, 0.1, 0.1]);
  // The parts land at the crossing point, not at the origin.
  assert.ok(Math.abs(emitter.quads[0].x1 - 5) < 0.3);

  // A saturated crossing cap refuses the next crossing by count, never grows.
  const cappedBudget = {
    quads: 0, boxes: 0,
    crossings: GDO_TRANSIT_LIMITS.maxCrossings,
    crossingParts: 0,
  };
  const refused = planLevelCrossing({
    x: 0, z: 0,
    heightAt: () => 0,
    roadDirectionX: 1, roadDirectionZ: 0,
    railDirectionX: 0, railDirectionZ: 1,
    emitter: recordingEmitter(),
    budget: cappedBudget,
  });
  assert.equal(refused.truncated, true);
  assert.equal(refused.parts, 0);
  assert.equal(budget.crossings, 1);
});

test('TER-09 transit: the tram runs inlaid in the street — rails, no sleeper rhythm', () => {
  const emitter = recordingEmitter();
  const budget = { quads: 0, boxes: 0, crossings: 0, crossingParts: 0 };
  const plan = planSegmentTransitDetail({
    family: GDO_TRANSIT_FAMILY.TRAM,
    x1: 0, z1: 0, x2: 1, z2: 0,
    heightAt: () => 0,
    emitter,
    budget,
  });
  assert.equal(plan.quads, 2, 'exactly the two inlaid rail heads');
  // The monorail is its beam: two edge strips plus the declared struts.
  const monorailEmitter = recordingEmitter();
  const monorailBudget = { quads: 0, boxes: 0, crossings: 0, crossingParts: 0 };
  const monorailPlan = planSegmentTransitDetail({
    family: GDO_TRANSIT_FAMILY.MONORAIL,
    x1: 0, z1: 0, x2: 2, z2: 0,
    heightAt: () => 0,
    emitter: monorailEmitter,
    budget: monorailBudget,
  });
  assert.equal(monorailPlan.quads, 2);
  assert.ok(monorailPlan.boxes >= 3, 'a 20 m beam carries its strut rhythm');
});
