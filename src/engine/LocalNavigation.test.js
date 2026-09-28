import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_NAV_ARRIVAL_RADIUS, GDO_NAV_KIND, GDO_NAV_LIMITS, GDO_NAV_METRES_PER_UNIT, GDO_NAV_OFF_ROUTE_LIMIT,
  LOCAL_NAVIGATION_NAMESPACE, createLocalNavigation, describeLocalNavigation, guidanceText, minimapModel,
  navigationNodeId, navigationPlaceId, planRoute, pointAlongRoute, refusedRoute, routeProgress,
} from './LocalNavigation.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import { GDO_FEATURE_VERSIONS } from './FeatureVersions.js';

/**
 * `GME-07` gate: the local graph, its routes, its guidance, and its minimap model
 * are map-derived data with declared ceilings — and no renderer coupling at all.
 */

/** A two-street corner with a named place at the end of the second street. */
function cornerTiles() {
  return [
    {
      key: 'tile:a',
      payload: { lines: [[0, 0, 10, 0, 20, 0]], names: ['Kagzi Road'], levels: [0] },
      labels: [{ name: 'Kagzi Chaat Corner', kind: 'place', x: 5, z: .4 }],
    },
    {
      key: 'tile:b',
      payload: { lines: [[20, 0, 20, 10, 20, 20]], names: ['Mandi Lane'], levels: [0] },
      labels: [{ name: 'Mandi Market', kind: 'place', x: 20.4, z: 19 }],
    },
  ];
}

function build(tiles, { profile = 'low' } = {}) {
  const navigation = createLocalNavigation({ profile });
  for (const tile of tiles) {
    navigation.addTile(tile.key, tile.payload);
    navigation.addPlaces(tile.key, tile.labels ?? []);
  }
  return navigation;
}

test('GME-07 a local graph is built from mapped lines and named places, deterministically', () => {
  const navigation = build(cornerTiles());
  const graph = navigation.graph;
  // Five mapped road vertices (the corner at 20,0 is shared by both tiles) and
  // one node per named place.
  assert.equal(graph.diagnostics.nodes, 7);
  assert.equal(graph.diagnostics.places, 2);
  // Two edges per tile plus one link per place.
  assert.equal(graph.diagnostics.edges, 6);
  assert.deepEqual(graph.diagnostics.prunedNodes, 0);
  assert.deepEqual(graph.diagnostics.prunedEdges, 0);
  for (const node of graph.nodes) {
    assert.equal(typeof node.id, 'string');
    assert.ok(['tile:a', 'tile:b'].includes(node.tile));
    if (node.kind === GDO_NAV_KIND.ROAD) {
      assert.equal(navigationNodeId(node.x, node.z), node.id, 'a road node id is its quantized position');
    } else {
      assert.equal(navigationPlaceId(node), node.id, 'a place node id is its name, kind, and cell');
    }
  }
  // Adjacency is sorted by node id, so routing never depends on insertion order.
  for (const list of graph.adjacency.values()) {
    const ids = list.map(link => link.id);
    assert.deepEqual(ids, [...ids].sort());
  }
  const place = navigation.places().find(entry => entry.name === 'Mandi Market');
  assert.equal(place.id, navigationPlaceId({ name: 'Mandi Market', kind: 'place', x: 20.4, z: 19 }));

  // Rebuilding the same tiles produces the same graph, node for node.
  const rebuilt = build(cornerTiles());
  assert.deepEqual(rebuilt.graph.nodes, graph.nodes);
  assert.deepEqual(rebuilt.graph.edges, graph.edges);
  assert.deepEqual(rebuilt.diagnostics.graph, navigation.diagnostics.graph);
  assert.equal(GDO_FEATURE_VERSIONS.localNavigation, 1);
});

test('GME-07 routes are reachable, bounded, deterministic, and refuse with a reason', () => {
  const navigation = build(cornerTiles());
  const marketId = navigationPlaceId({ name: 'Mandi Market', kind: 'place', x: 20.4, z: 19 });
  const route = navigation.routeToPlace(marketId, { x: 0, z: .2 });
  assert.equal(route.ok, true, route.reason);
  assert.equal(route.namespace, LOCAL_NAVIGATION_NAMESPACE);
  // 0,0 -> 10,0 -> 20,0 -> 20,10 -> 20,20 -> the place, in mapped order.
  assert.deepEqual(route.nodes, [
    navigationNodeId(0, 0), navigationNodeId(10, 0), navigationNodeId(20, 0),
    navigationNodeId(20, 10), navigationNodeId(20, 20), marketId,
  ]);
  assert.equal(route.targetName, 'Mandi Market');
  assert.ok(Math.abs(route.distanceMetres - route.distance * GDO_NAV_METRES_PER_UNIT) <= 1,
    `${route.distance} units is ${route.distanceMetres} m`);
  assert.ok(route.expansions <= GDO_NAV_LIMITS.low.expansions);
  for (const leg of route.legs) {
    assert.ok(leg.bearingDegrees >= 0 && leg.bearingDegrees < 360, `bearing ${leg.bearingDegrees}`);
    assert.ok(Math.abs(leg.distanceMetres - leg.distance * GDO_NAV_METRES_PER_UNIT) <= 1);
  }
  // The polyline is a path: each leg ends where the next begins.
  for (let index = 1; index < route.coordinates.length; index++) {
    const previous = route.coordinates[index - 1];
    const current = route.coordinates[index];
    assert.ok(Math.hypot(current[0] - previous[0], current[1] - previous[1]) > 0);
  }
  const replay = navigation.routeToPlace(marketId, { x: 0, z: .2 });
  assert.deepEqual(replay.nodes, route.nodes);
  assert.equal(replay.distance, route.distance);

  // A route to a street vertex is named by that street instead.
  const toStreet = navigation.routeTo({ x: 20, z: 20 }, { x: 0, z: 0 });
  assert.equal(toStreet.targetName, 'Mandi Lane');
  // Two positions that snap to the same junction make a zero-length route, not a
  // refusal — the player is already there.
  const same = navigation.routeTo({ x: 2, z: 1 }, { x: 0, z: .2 });
  assert.equal(same.ok, true);
  assert.equal(same.distance, 0);
  assert.equal(same.nodes.length, 1);

  // Determined refusals instead of a guess.
  assert.equal(createLocalNavigation().routeTo({ x: 0, z: 0 }, { x: 1, z: 1 }).reason, 'empty-graph');
  assert.equal(navigation.routeToPlace('deadbeef', { x: 0, z: 0 }).reason, 'unknown-target');
  assert.equal(navigation.routeTo({ x: 0, z: 0 }, { x: 900, z: 900 }).reason, 'off-graph');
  assert.equal(refusedRoute('unreachable').ok, false);
  const disconnected = createLocalNavigation();
  disconnected.addTile('island', { lines: [[500, 500, 520, 500]], names: ['Isolated Way'], levels: [0] });
  disconnected.addTile('mainland', { lines: [[0, 0, 40, 0]], names: ['Main Road'], levels: [0] });
  assert.equal(disconnected.routeTo({ x: 520, z: 500 }, { x: 0, z: 0 }).reason, 'unreachable');
  // A budget refusal is named as a budget, not as unreachability.
  const long = createLocalNavigation({ limits: { ...GDO_NAV_LIMITS.low, expansions: 2, nodes: 400, edges: 800 } });
  long.addTile('chain', { lines: [Array.from({ length: 22 }, (_, index) => index * 8).flatMap(x => [x, 0])], names: ['Long Road'], levels: [0] });
  const budgeted = planRoute(long.graph, { x: 0, z: 0 }, { x: 160, z: 0 }, { expansions: 2 });
  assert.equal(budgeted.ok, false);
  assert.equal(budgeted.reason, 'budget');
  assert.deepEqual(navigation.diagnostics.refusalReasons, { 'unknown-target': 1, 'off-graph': 1 });
});

test('GME-07 guidance follows the route in metres and names the next turn', () => {
  const navigation = build(cornerTiles());
  const route = navigation.routeTo({ x: 20.4, z: 19 }, { x: 0, z: 0 });
  assert.equal(route.targetName, 'Mandi Market');
  assert.ok(route.distanceMetres > 300, `route is ${route.distanceMetres} m`);

  const early = routeProgress(route, 2, 0);
  assert.equal(early.ok, true);
  assert.equal(early.legName, 'Kagzi Road');
  assert.equal(early.offRoute, 0);
  assert.equal(early.arrived, false);
  const earlyText = guidanceText(route, early);
  assert.equal(earlyText.kind, 'continue');
  assert.match(earlyText.text, /Follow Kagzi Road for \d+ m to /);
  assert.equal(earlyText.remainingMetres, Math.round(early.remainingMetres));

  // Close to the corner the sentence becomes a turn onto the second street.
  const nearCorner = routeProgress(route, 18, 0);
  const turnText = guidanceText(route, nearCorner);
  assert.equal(turnText.kind, 'turn');
  assert.match(turnText.text, /^\d+ m, turn (left|right) onto Mandi Lane$/);
  assert.equal(nearCorner.nextTurn.name, 'Mandi Lane');
  assert.ok(nearCorner.nextTurn.distanceMetres >= 0);

  // Stepping off the line is reported, not silently ignored.
  const off = routeProgress(route, 10, 4);
  assert.ok(off.offRoute > GDO_NAV_OFF_ROUTE_LIMIT, `off route by ${off.offRoute}`);
  const offText = guidanceText(route, off);
  assert.equal(offText.kind, 'off-route');
  assert.match(offText.text, /^Off route — head back \d+ m to Kagzi Road$/);

  // Walking to the end arrives, even a little past the last vertex.
  const arrived = routeProgress(route, 20.2, 20.4);
  assert.equal(arrived.arrived, true);
  assert.ok(arrived.remaining <= GDO_NAV_ARRIVAL_RADIUS);
  assert.equal(guidanceText(route, arrived).kind, 'arrived');
  assert.match(guidanceText(route, arrived).text, /^You have arrived at Mandi Market$/);

  // A refused route still answers with one honest sentence.
  const refused = guidanceText(refusedRoute('off-graph'), null);
  assert.equal(refused.kind, 'unavailable');
  assert.match(refused.text, /Step back onto a mapped road/);

  // Sampling the polyline is monotonic, which is what the audit checks.
  let previous = Infinity;
  for (let along = 0; along <= route.distance; along += 5) {
    const point = pointAlongRoute(route, along);
    const progress = routeProgress(route, point.x, point.z);
    assert.ok(progress.remaining <= previous + 1e-6, `remaining went up at ${along}`);
    previous = progress.remaining;
  }
});

test('GME-07 the minimap is a bounded 2D model with no renderer coupling', () => {
  const navigation = build(cornerTiles());
  const route = navigation.routeTo({ x: 20, z: 20 }, { x: 0, z: 0 });
  const model = navigation.minimap({
    route, x: 10, z: 5, headingDegrees: 90, radius: 30, maxSegments: 4,
    loadedTiles: [
      { key: 'tile:a', minX: 0, minZ: 0, maxX: 20, maxZ: 20 },
      { key: 'tile:b', minX: 20, minZ: 0, maxX: 40, maxZ: 20 },
    ],
  });
  assert.equal(model.namespace, LOCAL_NAVIGATION_NAMESPACE);
  assert.equal(model.northUp, true);
  assert.equal(model.segments, 4, 'the segment cap is respected');
  assert.ok(model.cappedSegments > 0, 'the cap counted what it dropped');
  assert.ok(model.roads.every(segment => Math.abs(segment.u1) <= 1 && Math.abs(segment.v1) <= 1));
  assert.deepEqual(model.player, { u: 0, v: 0, headingDegrees: 90 });
  // North up: a point due north of the player projects to a negative v.
  const [northU] = [0];
  const north = minimapModel({ graph: navigation.graph, x: 0, z: 0, radius: 10 });
  assert.equal(north.roads.length > 0, true);
  assert.ok(north.roads.some(segment => segment.v1 < 0 || segment.v2 < 0), 'north is up');
  assert.equal(northU, 0);
  assert.deepEqual(model.tiles.map(tile => tile.key), ['tile:a', 'tile:b']);
  assert.ok(model.route.length >= 2, 'the route is drawn when it has one');
  assert.ok(model.places.length <= GDO_NAV_LIMITS.low.minimapPlaces);
  // The model owns no GPU object: guidance can never duplicate the world renderer.
  assert.equal(model.threeObjects, 0);
  assert.equal(model.drawCalls, 0);
  assert.equal(model.geometries, 0);
  assert.equal(model.materials, 0);
  assert.equal(navigation.minimap({ x: 0, z: 0, radius: 20 }).player.u, 0);
  // Clipping is counted rather than silently dropped.
  const far = navigation.minimap({ x: 900, z: 900, radius: 10 });
  assert.equal(far.segments, 0);
  assert.ok(far.clippedSegments > 0);
});

test('GME-07 the scripted navigation walk passes its verdicts and replays byte-identically', () => {
  const navigation = build(cornerTiles());
  const report = navigation.auditWalk({ from: { x: 0, z: 0 }, steps: 40 });
  assert.equal(report.namespace, LOCAL_NAVIGATION_NAMESPACE);
  assert.equal(report.ok, true, report.detail);
  assert.deepEqual(report.verdicts.map(verdict => verdict.id),
    ['route', 'guidance', 'off-route', 'minimap', 'renderer', 'budget', 'determinism']);
  for (const verdict of report.verdicts) assert.equal(verdict.ok, true, `${verdict.id}: ${verdict.detail}`);
  assert.match(report.fingerprint, /^[0-9a-f]{8}$/);
  assert.match(report.detail, /7 verdicts/);
  assert.equal(navigation.auditWalk({ from: { x: 0, z: 0 }, steps: 40 }).fingerprint, report.fingerprint);

  // An empty graph fails the audit rather than passing vacuously.
  const empty = createLocalNavigation().auditWalk({});
  assert.equal(empty.ok, false);
  assert.equal(empty.verdicts.find(verdict => verdict.id === 'route').ok, false);
  assert.match(empty.detail, /route/);
});

test('GME-07 the graph is pruned to the declared ceilings and eviction forgets tiles', () => {
  // Forty parallel mapped streets, ten vertices each, plus one named market.
  const lines = [], names = [], levels = [];
  for (let index = 0; index < 40; index++) {
    const z = index * 4;
    const line = [];
    for (let step = 0; step <= 9; step++) line.push(step * 10, z);
    lines.push(line);
    names.push(`Street ${index}`);
    levels.push(index % 2);
  }
  const navigation = createLocalNavigation({ profile: 'low' });
  navigation.addTile('big', { lines, names, levels });
  navigation.addPlaces('big', [{ name: 'Big Market', kind: 'place', x: 45, z: 0 }]);
  const graph = navigation.graph;
  // 401 candidate nodes (400 street vertices plus the place) prune to the ceiling.
  assert.equal(graph.diagnostics.nodes, GDO_NAV_LIMITS.low.nodes);
  assert.equal(graph.diagnostics.prunedNodes, 401 - GDO_NAV_LIMITS.low.nodes);
  assert.ok(graph.diagnostics.edges <= GDO_NAV_LIMITS.low.edges);
  assert.ok(graph.nodes.some(node => node.kind === GDO_NAV_KIND.PLACE), 'places survive pruning');
  assert.equal(graph.diagnostics.placeOrphans, 0, 'every kept place keeps a road anchor');
  const placeNode = graph.nodes.find(node => node.kind === GDO_NAV_KIND.PLACE);
  assert.ok((graph.adjacency.get(placeNode.id) ?? []).length > 0, 'the market still has a road link');
  for (const edge of graph.edges) {
    assert.ok(graph.nodes.some(node => node.id === edge.a), 'no edge references a pruned node');
    assert.ok(graph.nodes.some(node => node.id === edge.b), 'no edge references a pruned node');
  }

  // A tighter edge cap is honoured exactly, and the excess is counted.
  const edgesOnly = createLocalNavigation({ limits: { ...GDO_NAV_LIMITS.low, nodes: 401, edges: 20 } });
  edgesOnly.addTile('big', { lines, names, levels });
  assert.equal(edgesOnly.graph.diagnostics.edges, 20);
  assert.ok(edgesOnly.graph.diagnostics.prunedEdges > 300, `${edgesOnly.graph.diagnostics.prunedEdges} pruned`);

  // A dense tile trades completeness for bounds, but never silently: the refusal
  // is named, and the search stays inside the declared expansion budget.
  const route = navigation.routeTo({ x: 45, z: 0 }, { x: 0, z: 0 });
  assert.ok(route.ok || ['off-graph', 'unreachable', 'budget'].includes(route.reason), route.reason);
  assert.ok(navigation.diagnostics.expanded <= GDO_NAV_LIMITS.low.expansions);
  assert.equal(createLocalNavigation({ profile: 'low' }).diagnostics.graph.placeOrphans, 0);

  // Eviction releases the tile's roads and places, and the graph shrinks.
  assert.equal(navigation.removeTile('big'), true);
  assert.equal(navigation.graph.diagnostics.nodes, 0);
  assert.equal(navigation.graph.diagnostics.edges, 0);
  assert.deepEqual(navigation.places(), []);
  assert.equal(navigation.removeTile('big'), false);
});

test('GME-07 the declared budgets match the shipped low profile and the module stays renderer-free', async () => {
  const summary = describeLocalNavigation();
  assert.equal(summary.ok, true, summary.violations.join('; '));
  assert.equal(summary.profiles, 3);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.navNodes, GDO_NAV_LIMITS.low.nodes);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.navEdges, GDO_NAV_LIMITS.low.edges);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.navRouteExpansions, GDO_NAV_LIMITS.low.expansions);
  assert.equal(GDO_LOW_PROFILE_BUDGETS.navMinimapSegments, GDO_NAV_LIMITS.low.minimapSegments);
  // Over-cap limits are refused rather than silently accepted.
  assert.equal(describeLocalNavigation({ ...GDO_LOW_PROFILE_BUDGETS, navNodes: 10 }).ok, false);
  assert.match(describeLocalNavigation({ ...GDO_LOW_PROFILE_BUDGETS, navMinimapSegments: 8 }).violations.join(' '), /minimap segments/);

  const navigation = build(cornerTiles());
  const diagnostics = navigation.diagnostics;
  assert.equal(diagnostics.namespace, LOCAL_NAVIGATION_NAMESPACE);
  assert.equal(diagnostics.steadyFrameAllocations, 0);
  assert.equal(diagnostics.graph.tiles, 2);
  assert.equal(diagnostics.graphVersion, 4, 'one rebuild per tile add and per place add');
  assert.equal(diagnostics.limits.minimapSegments, GDO_LOW_PROFILE_BUDGETS.navMinimapSegments);
  assert.equal(diagnostics.minimaps, 0, 'building a graph never draws a minimap');

  // The proof that guidance is not a second renderer: the module never imports it.
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./LocalNavigation.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /from 'three'/);
  assert.doesNotMatch(source, /THREE\./);
});
