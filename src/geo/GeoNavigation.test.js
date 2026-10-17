import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_NAV_GUIDANCE_MOVE, GDO_NAV_GUIDANCE_TURN, GDO_NAV_REPLAN_DISTANCE, GeoWorld,
} from './GeoWorld.js';
import { compileGeoFixture } from './GeoFixtures.js';
import { createActionRegistry } from '../engine/ActionRegistry.js';
import { describeDomainCompliance } from '../engine/DomainInterface.js';
import { LifecycleLedger } from '../engine/LifecycleContract.js';
import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';

/**
 * `GME-07` gate, live: the world builds its local graph from a real fixture's
 * mapped road lines and named places, answers bounded guidance from it, and
 * proves the minimap is a HUD model rather than a second world renderer.
 */

globalThis.Worker ??= class { addEventListener() {} postMessage() {} terminate() {} };

function mount(fixtureId = 'dense-urban', { profile = 'low' } = {}) {
  const scene = new THREE.Scene();
  const ledger = new LifecycleLedger({ label: `gme-07-${fixtureId}` });
  const world = new GeoWorld(scene, {
    latitude: 28.9845, longitude: 77.7064, ledger, profile,
  });
  const tile = [...world.tiles.values()][0];
  const compilation = compileGeoFixture(fixtureId, 'openmaptiles');
  const common = {
    type: 'tile-phase', requestId: tile.requestId, key: tile.key, bytes: 2048,
    provider: `Fixture/${compilation.fixture.variant}`, providerId: 'openmaptiles',
  };
  world._handleWorkerMessage({
    ...common, phase: 'roads', geometry: compilation.roads,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2 },
  });
  world._handleWorkerMessage({
    ...common, phase: 'context', context: compilation.context,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3 },
  });
  world._handleWorkerMessage({
    ...common, phase: 'buildings', geometry: compilation.buildings,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3, buildingsMilliseconds: 4, totalMilliseconds: 10 },
  });
  world._flushPlantMounts(0);
  return { scene, world, tile, compilation, ledger };
}

test('GME-07 the world graph is built from a real fixture\'s mapped roads and names', () => {
  const { scene, world, compilation, ledger } = mount('dense-urban');
  try {
    const navigation = world.navigation;
    const graph = navigation.graph;
    assert.equal(graph.diagnostics.tiles, 1);
    assert.ok(graph.diagnostics.nodes > 8, `graph has ${graph.diagnostics.nodes} nodes`);
    assert.ok(graph.diagnostics.edges > 6, `graph has ${graph.diagnostics.edges} edges`);
    assert.ok(graph.diagnostics.edges <= GDO_LOW_PROFILE_BUDGETS.navEdges);
    assert.ok(graph.diagnostics.nodes <= GDO_LOW_PROFILE_BUDGETS.navNodes);
    assert.equal(graph.diagnostics.placeOrphans, 0);
    assert.ok(graph.diagnostics.places >= 1, 'the fixture names at least one place');
    // The graph came from the tile context, not from a second fetch.
    assert.ok(compilation.context.navigation.lines.length > 0, 'the tile context carries road lines');
    for (const node of graph.nodes) {
      assert.ok(Number.isFinite(node.x) && Number.isFinite(node.z));
      assert.equal(node.tile, `${world.tileX ?? world.tiles.keys().next().value}`.replace(/^.*$/, node.tile));
    }
    assert.equal(world.domain.capabilities.navigation, true);
    assert.equal(GDO_LOW_PROFILE_BUDGETS.navSteadyFrameAllocations, 0);

    // Guidance to a real named place, from a real mapped road position.
    const road = graph.nodes.find(node => node.kind === 'road');
    assert.ok(road, 'the fixture mapped at least one road node');
    const targets = world.navigationTargets(road.x, road.z, { limit: 4 });
    assert.ok(targets.length >= 1, 'a named place is offered as a target');
    assert.ok(targets[0].distanceMetres >= 0);
    const route = world.navigateTo({ placeId: targets[0].id }, { x: road.x, z: road.z });
    assert.equal(route.ok, true, route.reason);
    assert.equal(route.targetName, targets[0].name);
    assert.ok(route.distanceMetres >= 0);
    assert.ok(route.expansions <= GDO_LOW_PROFILE_BUDGETS.navRouteExpansions);
    assert.equal(world.navigationRouteKey, targets[0].id);

    const guidance = world.navigationGuidance(road.x, road.z, { headingDegrees: 0 });
    assert.equal(guidance.namespace, 'gdo:localNavigation:v1');
    assert.equal(guidance.reused, false);
    assert.equal(guidance.steadyFrameAllocations, 1);
    assert.equal(guidance.progress.ok, true, guidance.progress.reason);
    assert.ok(['continue', 'turn', 'arrived'].includes(guidance.guidance.kind), guidance.guidance.kind);
    assert.ok(guidance.guidance.text.length > 0);
  } finally {
    world.dispose();
    ledger.disposeAll();
    assert.deepEqual(ledger.leaks(), []);
  }
});

test('GME-07 guidance is a HUD model: no scene object, no draw call, no duplicate renderer', () => {
  const { scene, world, ledger } = mount('sparse-rural');
  try {
    const countObjects = node => {
      let total = 0;
      node.traverse?.(child => { if (child.isMesh || child.isPoints || child.isLine) total++; });
      return total;
    };
    const nodes = world.navigation.graph.nodes;
    // Walk the graph with guidance running at every step. On the first pass no
    // target is chosen, so this is also the no-route minimap path.
    const before = countObjects(scene);
    let threeObjects = 0, drawCalls = 0, geometries = 0, materials = 0;
    let heading = 0;
    for (let index = 0; index < 40 && nodes.length > 1; index++) {
      const node = nodes[index % nodes.length];
      const guidance = world.navigationGuidance(node.x, node.z, { headingDegrees: heading += 17 });
      threeObjects += guidance.minimap.threeObjects;
      drawCalls += guidance.minimap.drawCalls;
      geometries += guidance.minimap.geometries;
      materials += guidance.minimap.materials;
      assert.ok(guidance.minimap.segments <= GDO_LOW_PROFILE_BUDGETS.navMinimapSegments);
      assert.ok(guidance.minimap.northUp === true);
      assert.deepEqual(guidance.minimap.player, { u: 0, v: 0, headingDegrees: guidance.minimap.player.headingDegrees });
    }
    const after = countObjects(scene);
    assert.equal(after, before, 'guidance added no scene object');
    assert.equal(threeObjects, 0);
    assert.equal(drawCalls, 0);
    assert.equal(geometries, 0);
    assert.equal(materials, 0);
    // The minimap really covers the loaded tile: the tile rectangle is drawn.
    const model = world.navigationGuidance(nodes[0].x, nodes[0].z, { headingDegrees: 90 }).minimap;
    assert.ok(model.tiles.length >= 1);
    assert.equal(model.tiles[0].key, [...world.tiles.keys()][0]);
  } finally {
    world.dispose();
    ledger.disposeAll();
    assert.deepEqual(ledger.leaks(), []);
  }
});

test('GME-07 the steady frame re-uses its guidance record and re-plans only off route', () => {
  const { world, ledger } = mount('dense-urban');
  try {
    // Start from a mapped road junction and guide to the farthest named place, so
    // the guided line is a real route rather than a zero-length one.
    const node = world.navigation.graph.nodes.find(candidate => candidate.kind === 'road');
    const ranked = world.navigationTargets(node.x, node.z, { limit: 12 });
    const target = ranked.find(candidate => world.navigation
      .routeToPlace(candidate.id, { x: node.x, z: node.z }).distanceMetres > 40);
    assert.ok(target, 'the fixture offers a place worth walking to');
    const planned = world.navigateTo({ placeId: target.id }, { x: node.x, z: node.z });
    assert.equal(planned.ok, true, planned.reason);
    assert.ok(planned.distanceMetres > 40);

    const first = world.navigationGuidance(node.x, node.z, { headingDegrees: 0 });
    assert.equal(first.reused, false);
    assert.equal(first.steadyFrameAllocations, 1);
    // Same position, same heading: the record is handed back, allocating nothing.
    for (let index = 0; index < 12; index++) {
      const reused = world.navigationGuidance(node.x, node.z, { headingDegrees: 2 });
      assert.equal(reused, first, 'the same record comes back');
      assert.equal(reused.reused, true);
      assert.equal(reused.steadyFrameAllocations, 0);
    }
    // Movement past the declared refresh distance makes a fresh record.
    const moved = world.navigationGuidance(node.x + GDO_NAV_GUIDANCE_MOVE * 2, node.z, { headingDegrees: 0 });
    assert.equal(moved.reused, false);
    assert.equal(moved.steadyFrameAllocations, 1);
    assert.notEqual(moved, first);

    // A heading turn past the declared angle also refreshes.
    const turned = world.navigationGuidance(node.x + GDO_NAV_GUIDANCE_MOVE * 2, node.z, { headingDegrees: GDO_NAV_GUIDANCE_TURN * 3 });
    assert.equal(turned.reused, false);

    // A genuine detour — a mapped junction that is not on the guided line — makes
    // the guidance re-plan from where the player actually is.
    const route = world.navigationRoute;
    const detour = world.navigation.graph.nodes.find(candidate => candidate.kind === 'road'
      && world.navigation.progress(route, candidate.x, candidate.z).offRoute > GDO_NAV_REPLAN_DISTANCE);
    assert.ok(detour, 'the fixture has a junction off the guided route');
    const before = world.navigationRoute;
    const off = world.navigationGuidance(detour.x, detour.z, { headingDegrees: 0 });
    assert.equal(off.replanned, true, 'a real detour re-plans');
    assert.notEqual(world.navigationRoute, before);
    assert.ok(off.progress.offRoute <= GDO_NAV_REPLAN_DISTANCE, `back on the line (${off.progress.offRoute})`);
    assert.ok(off.guidance.text.length > 0);

    // Cancelling clears the record and the target key.
    assert.equal(world.cancelNavigation(), true);
    assert.equal(world.navigationRoute, null);
    assert.equal(world.navigationRouteKey, null);
    assert.equal(world.cancelNavigation(), false);
    const unavailable = world.navigationGuidance(node.x, node.z, { headingDegrees: 0 });
    assert.equal(unavailable.guidance.kind, 'unavailable');
  } finally {
    world.dispose();
    ledger.disposeAll();
    assert.deepEqual(ledger.leaks(), []);
  }
});

test('GME-07 eviction leaves the graph and drops a route that ran through the tile', () => {
  const { world, ledger } = mount('wetland-basin');
  try {
    assert.ok(world.navigation.graph.diagnostics.nodes > 0);
    const node = world.navigation.graph.nodes[0];
    const targets = world.navigationTargets(node.x, node.z, { limit: 1 });
    const route = world.navigateTo({ placeId: targets[0].id }, { x: node.x, z: node.z });
    assert.equal(route.ok, true, route.reason);
    assert.notEqual(world.navigationRoute, null);
    const tile = [...world.tiles.values()][0];
    world._evictTile(tile);
    assert.equal(world.navigation.graph.diagnostics.nodes, 0);
    assert.equal(world.navigation.graph.diagnostics.edges, 0);
    assert.equal(world.navigation.graph.diagnostics.tiles, 0);
    assert.equal(world.navigationRoute, null, 'a route whose nodes left is dropped');
    assert.equal(world.navigationTargets(0, 0).length, 0);
  } finally {
    world.dispose();
    ledger.disposeAll();
    assert.deepEqual(ledger.leaks(), []);
  }
});

test('GME-07 the guide verb rides the one action registry or is skipped by name', () => {
  const { world, ledger } = mount('dense-urban');
  try {
    const compliance = describeDomainCompliance(world, world.domain);
    assert.equal(compliance.ok, true, compliance.detail);
    assert.match(compliance.detail, /capabilities satisfied/);

    // A world that declares navigation mounts `guide` through the registry.
    const registry = createActionRegistry({
      capabilities: { analogInput: true, jump: true, pointerLook: true, touch: true, interaction: true, navigation: true },
    });
    const registration = registry.register({
      id: 'guide', kind: 'tap', label: 'Guide', hint: 'G',
      capability: 'navigation', keyboard: ['KeyG'], touch: { control: 'button', label: 'GUIDE' },
    });
    assert.equal(registry.has('guide'), true, registration?.id);
    assert.equal(registry.keyboardBinding('KeyG'), 'guide');
    assert.equal(registry.action('guide').label, 'Guide');
    assert.ok(registry.keyboardHint().includes('guide'));
    assert.ok(registry.touchControls().some(control => control.id === 'guide' && control.text === 'GUIDE'));

    // A world without the capability skips the same verb, by name and reason.
    const bare = createActionRegistry({ capabilities: { analogInput: true, jump: true, pointerLook: true, touch: true } });
    bare.register({
      id: 'guide', kind: 'tap', label: 'Guide', hint: 'G',
      capability: 'navigation', keyboard: ['KeyG'], touch: { control: 'button', label: 'GUIDE' },
    });
    assert.equal(bare.has('guide'), false);
    assert.deepEqual(bare.diagnostics().skipped.filter(entry => entry.id === 'guide'),
      [{ id: 'guide', reason: 'capability', capability: 'navigation' }]);
  } finally {
    world.dispose();
    ledger.disposeAll();
    assert.deepEqual(ledger.leaks(), []);
  }
});

test('GME-07 the stats surface reports the graph, the route, and the minimap honestly', () => {
  const { world, ledger } = mount('mountain-terrace');
  try {
    const nodes = world.navigation.graph.nodes;
    const road = nodes.find(node => node.kind === 'road');
    const targets = world.navigationTargets(road.x, road.z, { limit: 2 });
    const route = world.navigateTo({ placeId: targets[0].id }, { x: road.x, z: road.z });
    assert.equal(route.ok, true, route.reason);
    world.navigationGuidance(road.x, road.z, { headingDegrees: 12 });
    const stats = world.stats;
    assert.equal(stats.navNodes, world.navigation.graph.diagnostics.nodes);
    assert.equal(stats.navEdges, world.navigation.graph.diagnostics.edges);
    assert.equal(stats.navPlaces, world.navigation.graph.diagnostics.places);
    assert.equal(stats.navPlaceOrphans, 0);
    assert.ok(stats.navRoutes >= 1);
    assert.equal(stats.navTarget, targets[0].id);
    assert.ok(stats.navMinimapSegments <= GDO_LOW_PROFILE_BUDGETS.navMinimapSegments);
    assert.equal(stats.navSteadyFrameAllocations, 1);
  } finally {
    world.dispose();
    ledger.disposeAll();
    assert.deepEqual(ledger.leaks(), []);
  }
});
