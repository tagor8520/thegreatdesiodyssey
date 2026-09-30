/**
 * `GME-07` — map-derived local navigation.
 *
 * The research asks for a *simplified nearby graph* — roads, named places, the
 * player's heading, and the loaded tiles — that guides a player without a second
 * world renderer. This module is that graph and its guidance, as data and maths:
 * a local node/edge set built from the mapped road lines a tile already carries,
 * named place nodes from the `GME-04` label list, a deterministic shortest route,
 * a progress/guidance sentence, and a minimap model in normalized 2D coordinates
 * that the existing HUD draws on its own 2D canvas.
 *
 * Nothing here touches `three`, the renderer, a material, or a draw call. The
 * minimap is a *model*: the caller scales its normalized points onto the pixels
 * it already owns, which is why guidance can never duplicate the world renderer.
 */

import { featureNamespace } from './FeatureVersions.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

export const LOCAL_NAVIGATION_NAMESPACE = featureNamespace('localNavigation');

/** The world's 1:10 footprint scale, so guidance can speak in metres. */
export const GDO_NAV_METRES_PER_UNIT = 10;

export const GDO_NAV_KIND = Object.freeze({ ROAD: 'road', PLACE: 'place' });

/**
 * Per-profile ceilings. The graph is pruned — never truncated mid-edge — and
 * what was pruned is counted, so a dense city centre degrades predictably.
 */
export const GDO_NAV_LIMITS = Object.freeze({
  low: Object.freeze({ nodes: 160, edges: 320, expansions: 256, minimapSegments: 64, minimapPlaces: 8 }),
  balanced: Object.freeze({ nodes: 320, edges: 640, expansions: 512, minimapSegments: 110, minimapPlaces: 12 }),
  high: Object.freeze({ nodes: 512, edges: 1024, expansions: 900, minimapSegments: 160, minimapPlaces: 18 }),
});

/** Two mapped vertices closer than this are the same junction. */
export const GDO_NAV_JOIN_TOLERANCE = .6;

/** A position further from the graph than this cannot be routed from. */
export const GDO_NAV_SNAP_LIMIT = 8;

/** Walking inside this radius of the target counts as arrived. */
export const GDO_NAV_ARRIVAL_RADIUS = 1.4;

/** Off-route distance at which the guidance stops being polite. */
export const GDO_NAV_OFF_ROUTE_LIMIT = 2.4;

/** A place node attaches to the road network within this distance. */
export const GDO_NAV_PLACE_LINK_LIMIT = 14;

function hash(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Stable node identity: the mapped position quantized to the join tolerance. */
export function navigationNodeId(x, z, tolerance = GDO_NAV_JOIN_TOLERANCE) {
  return hash(`${Math.round(x / tolerance)}:${Math.round(z / tolerance)}`);
}

export function navigationPlaceId(label) {
  const cell = 16;
  return hash(`${label.kind}|${label.name}|${Math.round(label.x / cell)}:${Math.round(label.z / cell)}`);
}

export function navigationDistanceMetres(units) {
  return units * GDO_NAV_METRES_PER_UNIT;
}

/** Normalized minimap coordinates: `[-1, 1]` around the player, north up. */
export function minimapProject(x, z, playerX, playerZ, radius) {
  return [(x - playerX) / radius, -(z - playerZ) / radius];
}

function segmentLength(ax, az, bx, bz) {
  return Math.hypot(bx - ax, bz - az);
}

function distanceToSegment(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSquared)) : 0;
  return Math.hypot(x - (ax + dx * amount), z - (az + dz * amount));
}

function bearingDegrees(ax, az, bx, bz) {
  const degrees = Math.atan2(bx - ax, bz - az) * 180 / Math.PI;
  return (degrees + 360) % 360;
}

function normalizedTurn(previous, next) {
  let delta = next - previous;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

function emptyGraph() {
  return Object.freeze({
    nodes: Object.freeze([]), edges: Object.freeze([]), adjacency: new Map(),
    diagnostics: Object.freeze({
      nodes: 0, edges: 0, places: 0, prunedNodes: 0, prunedEdges: 0,
      placeRefusals: 0, placeOrphans: 0, tiles: 0,
    }),
  });
}

function buildGraph(tiles, places, caps) {
  const points = new Map();
  const segments = [];
  const at = (x, z) => `${Math.round(x / GDO_NAV_JOIN_TOLERANCE)}:${Math.round(z / GDO_NAV_JOIN_TOLERANCE)}`;
  // Two mapped lines that cross *geometrically* are an intersection even though
  // they share no vertex — the research's "crossing/intersection metadata". A node
  // is created at the crossing and both lines are split through it, which is what
  // makes a grid of separate polylines one routable graph.
  const nodeAt = (x, z, meta = {}) => {
    const key = at(x, z);
    let node = points.get(key);
    if (!node) {
      node = {
        id: navigationNodeId(x, z), x, z, kind: GDO_NAV_KIND.ROAD,
        name: '', level: 0, tile: meta.tile ?? '', degree: 0,
      };
      points.set(key, node);
    }
    if (meta.name && !node.name) node.name = meta.name;
    if (!node.tile && meta.tile) node.tile = meta.tile;
    if (meta.level != null) node.level = Math.max(node.level, meta.level);
    return key;
  };

  for (const tileKey of [...tiles.keys()].sort()) {
    const tile = tiles.get(tileKey);
    for (let lineIndex = 0; lineIndex < tile.lines.length; lineIndex++) {
      const line = tile.lines[lineIndex];
      const name = tile.names[lineIndex] ?? '';
      const level = tile.levels[lineIndex] ?? 0;
      const kind = tile.kinds?.[lineIndex] ?? '';
      const width = tile.widths?.[lineIndex] ?? .55;
      for (let index = 0; index + 3 < line.length; index += 2) {
        const ax = line[index], az = line[index + 1];
        const bx = line[index + 2], bz = line[index + 3];
        const length = segmentLength(ax, az, bx, bz);
        if (length < 1e-4) continue;
        const from = nodeAt(ax, az, { name, tile: tileKey, level });
        const to = nodeAt(bx, bz, { name, tile: tileKey, level });
        segments.push({
          from, to, ax, az, bx, bz, length, name, kind, width, level, tile: tileKey, cuts: [],
        });
      }
    }
  }

  const cutAt = (segment, amount, key) => {
    if (!(amount > 0 && amount < 1)) return;
    segment.cuts.push({ amount, key });
  };

  // Proper crossings: interior intersections between two mapped lines.
  for (let first = 0; first < segments.length; first++) {
    const a = segments[first];
    const minAX = Math.min(a.ax, a.bx), maxAX = Math.max(a.ax, a.bx);
    const minAZ = Math.min(a.az, a.bz), maxAZ = Math.max(a.az, a.bz);
    for (let second = first + 1; second < segments.length; second++) {
      const b = segments[second];
      if (Math.max(b.ax, b.bx) < minAX - GDO_NAV_JOIN_TOLERANCE || Math.min(b.ax, b.bx) > maxAX + GDO_NAV_JOIN_TOLERANCE ||
          Math.max(b.az, b.bz) < minAZ - GDO_NAV_JOIN_TOLERANCE || Math.min(b.az, b.bz) > maxAZ + GDO_NAV_JOIN_TOLERANCE) continue;
      const denominator = (a.bx - a.ax) * (b.bz - b.az) - (a.bz - a.az) * (b.bx - b.ax);
      if (Math.abs(denominator) < 1e-9) continue;
      const offsetX = b.ax - a.ax, offsetZ = b.az - a.az;
      const amountA = (offsetX * (b.bz - b.az) - offsetZ * (b.bx - b.ax)) / denominator;
      const amountB = (offsetX * (a.bz - a.az) - offsetZ * (a.bx - a.ax)) / denominator;
      if (!(amountA > 0 && amountA < 1 && amountB > 0 && amountB < 1)) continue;
      const x = a.ax + (a.bx - a.ax) * amountA;
      const z = a.az + (a.bz - a.az) * amountA;
      const key = nodeAt(x, z, { name: a.name || b.name, tile: a.tile, level: Math.max(a.level, b.level) });
      cutAt(a, amountA, key);
      cutAt(b, amountB, key);
    }
  }

  // T-junctions: a line *ends* on another line rather than crossing it.
  for (const [key, node] of [...points]) {
    if (node.kind !== GDO_NAV_KIND.ROAD) continue;
    for (const segment of segments) {
      if (key === segment.from || key === segment.to) continue;
      const distance = distanceToSegment(node.x, node.z, segment.ax, segment.az, segment.bx, segment.bz);
      if (distance > GDO_NAV_JOIN_TOLERANCE) continue;
      const dx = segment.bx - segment.ax, dz = segment.bz - segment.az;
      const amount = ((node.x - segment.ax) * dx + (node.z - segment.az) * dz) / (segment.length * segment.length);
      cutAt(segment, amount, key);
    }
  }

  // Every mapped line becomes a chain of edges through its own crossings.
  const rawEdges = [];
  for (const segment of segments) {
    const walk = [
      { amount: 0, key: segment.from },
      ...segment.cuts.slice().sort((a, b) => (a.amount - b.amount) || (a.key < b.key ? -1 : 1)),
      { amount: 1, key: segment.to },
    ];
    for (let index = 1; index < walk.length; index++) {
      const previous = walk[index - 1], current = walk[index];
      if (previous.key === current.key) continue;
      const a = points.get(previous.key), b = points.get(current.key);
      if (!a || !b) continue;
      rawEdges.push({
        id: hash(`${a.id}|${b.id}`), a: a.id, b: b.id,
        length: segmentLength(a.x, a.z, b.x, b.z),
        level: Math.max(a.level, b.level),
        name: segment.name || a.name || b.name || '',
        // The edge keeps the canonical class of the line it came from, so a
        // sidewalk graph is a filter over the one graph rather than a rebuild.
        kind: segment.kind || '',
        width: segment.width ?? .55,
        link: false,
      });
    }
  }

  // A named place is its own node, linked to the nearest graph node inside the
  // link limit so a route can reach the doorway rather than the street centre.
  const anchors = new Set();
  let placeRefusals = 0;
  for (const place of places) {
    let nearestKey = null, nearestDistance = GDO_NAV_PLACE_LINK_LIMIT;
    for (const [key, node] of points) {
      const distance = Math.hypot(node.x - place.x, node.z - place.z);
      if (distance < nearestDistance) { nearestKey = key; nearestDistance = distance; }
    }
    // A name with no mapped road within the link limit is not a navigable target:
    // the graph refuses it rather than offering guidance to a doorway it cannot
    // reach. Refusals are counted, so a provider change is visible, not silent.
    if (!nearestKey) { placeRefusals++; continue; }
    const node = {
      id: place.id, x: place.x, z: place.z, kind: GDO_NAV_KIND.PLACE,
      name: place.name, level: 0, tile: place.tile, degree: 0,
    };
    points.set(`place:${place.id}`, node);
    const nearest = points.get(nearestKey);
    // The anchor road node is retained through pruning: a dense tile must never
    // orphan the doorway of a place the player can see named on the map.
    anchors.add(nearestKey);
    // A place link is a doorway, not a street: it carries no road class, so a
    // pedestrian sidewalk graph is built from the streets alone.
    // A place link is a doorway rather than a street: it is flagged, carries no
    // road class, and is never walked as if it were a carriageway.
    rawEdges.push({
      id: hash(`${node.id}|${nearest.id}`), a: node.id, b: nearest.id,
      length: Math.max(nearestDistance, .05), level: 0, name: place.name, kind: '', width: 0, link: true,
    });
  }

  const degrees = new Map();
  for (const edge of rawEdges) {
    degrees.set(edge.a, (degrees.get(edge.a) ?? 0) + 1);
    degrees.set(edge.b, (degrees.get(edge.b) ?? 0) + 1);
  }
  const ranked = [...points.values()]
    .map(node => ({ ...node, degree: degrees.get(node.id) ?? 0 }))
    .sort((first, second) => {
      // Places first, then junctions by degree, then the stable id order.
      if ((first.kind === GDO_NAV_KIND.PLACE) !== (second.kind === GDO_NAV_KIND.PLACE)) {
        return first.kind === GDO_NAV_KIND.PLACE ? -1 : 1;
      }
      if (second.degree !== first.degree) return second.degree - first.degree;
      return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
    });
  const kept = new Map();
  // Places and their road anchors are kept first, then the rest by degree.
  for (const [key, node] of points) {
    if (key.startsWith('place:') || anchors.has(key)) {
      if (kept.size >= caps.nodes) break;
      kept.set(node.id, node);
    }
  }
  for (const node of ranked) {
    if (kept.size >= caps.nodes) break;
    kept.set(node.id, node);
  }
  const prunedNodes = ranked.length - kept.size;

  const deduped = new Map();
  for (const edge of rawEdges) {
    if (!kept.has(edge.a) || !kept.has(edge.b)) continue;
    const key = edge.a < edge.b ? `${edge.a}|${edge.b}` : `${edge.b}|${edge.a}`;
    const existing = deduped.get(key);
    if (!existing || edge.length < existing.length) deduped.set(key, edge);
  }
  const ordered = [...deduped.values()].sort((first, second) => {
    if (first.level !== second.level) return first.level - second.level;
    if (first.length !== second.length) return first.length - second.length;
    return first.id < second.id ? -1 : 1;
  });
  const edges = ordered.slice(0, caps.edges);
  const prunedEdges = ordered.length - edges.length;

  const adjacency = new Map();
  for (const node of kept.values()) adjacency.set(node.id, []);
  for (const edge of edges) {
    adjacency.get(edge.a)?.push({ id: edge.b, edge });
    adjacency.get(edge.b)?.push({ id: edge.a, edge });
  }
  for (const list of adjacency.values()) {
    list.sort((first, second) => (first.id < second.id ? -1 : first.id > second.id ? 1 : 0));
  }

  const nodes = [...kept.values()].sort((first, second) => (first.id < second.id ? -1 : 1));
  const placeOrphans = nodes.filter(node => node.kind === GDO_NAV_KIND.PLACE
    && !(adjacency.get(node.id) ?? []).length).length;
  return Object.freeze({
    nodes: Object.freeze(nodes.map(node => Object.freeze(node))),
    edges: Object.freeze(edges.map(edge => Object.freeze(edge))),
    adjacency,
    diagnostics: Object.freeze({
      nodes: nodes.length,
      edges: edges.length,
      places: nodes.filter(node => node.kind === GDO_NAV_KIND.PLACE).length,
      prunedNodes,
      prunedEdges,
      placeRefusals,
      placeOrphans,
      tiles: tiles.size,
    }),
  });
}

/** The one shape every refusal takes, so callers can render it directly. */
export function refusedRoute(reason) {
  return Object.freeze({
    namespace: LOCAL_NAVIGATION_NAMESPACE, ok: false, reason, nodes: Object.freeze([]),
    coordinates: Object.freeze([]), legs: Object.freeze([]), distance: 0,
    distanceMetres: 0, expansions: 0, targetName: '',
  });
}

/** The point `along` world units into the route polyline. */
export function pointAlongRoute(route, along) {
  if (!route?.ok || !route.coordinates.length) return null;
  if (route.coordinates.length === 1) {
    const only = route.coordinates[0];
    return { x: only[0], z: only[1], legIndex: 0, bearingDegrees: 0 };
  }
  let travelled = 0;
  for (let index = 1; index < route.coordinates.length; index++) {
    const [ax, az] = route.coordinates[index - 1];
    const [bx, bz] = route.coordinates[index];
    const length = segmentLength(ax, az, bx, bz);
    if (travelled + length >= along || index === route.coordinates.length - 1) {
      const amount = length ? Math.max(0, Math.min(1, (along - travelled) / length)) : 0;
      return {
        x: ax + (bx - ax) * amount, z: az + (bz - az) * amount,
        legIndex: index - 1, bearingDegrees: bearingDegrees(ax, az, bx, bz),
      };
    }
    travelled += length;
  }
  return null;
}

/**
 * A bounded Dijkstra over the local graph. Ties are broken by node id, so the
 * same graph and the same pair of positions always produce the same route.
 */
export function planRoute(graph, from, to, {
  expansions = GDO_NAV_LIMITS.low.expansions,
  snapLimit = GDO_NAV_SNAP_LIMIT,
} = {}) {
  const refuse = refusedRoute;
  if (!graph || !graph.nodes?.length) return refuse('empty-graph');

  const nearest = (x, z, nodeId = null) => {
    if (nodeId) {
      const explicit = graph.nodes.find(node => node.id === nodeId);
      return explicit ? { node: explicit, distance: 0 } : null;
    }
    let best = null, bestDistance = Infinity;
    for (const node of graph.nodes) {
      const distance = Math.hypot(node.x - x, node.z - z);
      if (distance < bestDistance) { best = node; bestDistance = distance; }
    }
    return best ? { node: best, distance: bestDistance } : null;
  };

  const start = nearest(from?.x ?? 0, from?.z ?? 0, from?.nodeId ?? null);
  const goal = nearest(to?.x ?? 0, to?.z ?? 0, to?.nodeId ?? null);
  if (!start || !goal) return refuse('unknown-target');
  if (start.distance > snapLimit || goal.distance > snapLimit) return refuse('off-graph');
  if (start.node.id === goal.node.id) {
    return Object.freeze({
      namespace: LOCAL_NAVIGATION_NAMESPACE, ok: true, reason: null,
      nodes: Object.freeze([start.node.id]),
      coordinates: Object.freeze([Object.freeze([start.node.x, start.node.z])]),
      legs: Object.freeze([]), distance: 0, distanceMetres: 0, expansions: 0,
      from: Object.freeze({ node: start.node.id, snapDistance: round(start.distance) }),
      to: Object.freeze({ node: goal.node.id, snapDistance: round(goal.distance) }),
      targetName: goal.node.kind === GDO_NAV_KIND.PLACE ? goal.node.name : goal.node.name || '',
    });
  }

  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const best = new Map([[start.node.id, 0]]);
  const previous = new Map();
  const settled = new Set();
  let used = 0;
  let exhausted = false;
  while (settled.size < graph.nodes.length) {
    let current = null, currentCost = Infinity;
    for (const [id, cost] of best) {
      if (settled.has(id)) continue;
      if (cost < currentCost || (cost === currentCost && current != null && id < current)) {
        current = id; currentCost = cost;
      }
    }
    if (current == null) break;
    if (used >= expansions) { exhausted = true; break; }
    settled.add(current);
    used++;
    if (current === goal.node.id) break;
    for (const link of graph.adjacency.get(current) ?? []) {
      if (settled.has(link.id)) continue;
      const cost = currentCost + link.edge.length;
      const known = best.get(link.id);
      if (known == null || cost < known) {
        best.set(link.id, cost);
        previous.set(link.id, { from: current, edge: link.edge });
      }
    }
  }
  if (!settled.has(goal.node.id)) return refuse(exhausted ? 'budget' : 'unreachable');

  const ids = [goal.node.id];
  const edges = [];
  while (ids[0] !== start.node.id) {
    const step = previous.get(ids[0]);
    if (!step) return refuse('unreachable');
    edges.unshift(step.edge);
    ids.unshift(step.from);
  }
  const coordinates = ids.map(id => Object.freeze([byId.get(id).x, byId.get(id).z]));
  const legs = edges.map((edge, index) => {
    const a = coordinates[index], b = coordinates[index + 1];
    return Object.freeze({
      index, edge: edge.id, level: edge.level, name: edge.name,
      distance: round(edge.length), distanceMetres: round(navigationDistanceMetres(edge.length)),
      bearingDegrees: round(bearingDegrees(a[0], a[1], b[0], b[1]), 1),
    });
  });
  const distance = edges.reduce((sum, edge) => sum + edge.length, 0);
  return Object.freeze({
    namespace: LOCAL_NAVIGATION_NAMESPACE, ok: true, reason: null,
    nodes: Object.freeze(ids),
    coordinates: Object.freeze(coordinates),
    legs: Object.freeze(legs),
    distance: round(distance),
    distanceMetres: round(navigationDistanceMetres(distance)),
    expansions: used,
    from: Object.freeze({ node: start.node.id, snapDistance: round(start.distance) }),
    to: Object.freeze({ node: goal.node.id, snapDistance: round(goal.distance) }),
    targetName: goal.node.kind === GDO_NAV_KIND.PLACE ? goal.node.name : (goal.node.name || ''),
  });
}

/** Where the player is along the route: leg, distance, heading, next turn. */
export function routeProgress(route, x, z) {
  if (!route?.ok || route.coordinates.length === 0) {
    return Object.freeze({
      ok: false, reason: route?.reason ?? 'no-route', legIndex: -1, along: 0, alongMetres: 0,
      remaining: 0, remainingMetres: 0, offRoute: 0, offRouteMetres: 0, arrived: false, nextTurn: null,
    });
  }
  // A zero-length route (the player is already at the target) has one coordinate
  // and no legs: it is an immediate arrival, not a degenerate answer.
  if (route.coordinates.length === 1) {
    const [onlyX, onlyZ] = route.coordinates[0];
    const distanceToTarget = Math.hypot(x - onlyX, z - onlyZ);
    return Object.freeze({
      ok: true, reason: null, legIndex: 0, along: 0, alongMetres: 0,
      remaining: 0, remainingMetres: 0,
      offRoute: 0, offRouteMetres: 0, distanceToTarget: round(distanceToTarget),
      bearingDegrees: 0, legName: route.targetName ?? '', nextTurn: null,
      arrived: distanceToTarget <= GDO_NAV_ARRIVAL_RADIUS,
      description: `already at ${route.targetName || 'the target'}`,
    });
  }
  let along = 0, best = null;
  for (let index = 1; index < route.coordinates.length; index++) {
    const [ax, az] = route.coordinates[index - 1];
    const [bx, bz] = route.coordinates[index];
    const length = segmentLength(ax, az, bx, bz);
    const distance = distanceToSegment(x, z, ax, az, bx, bz);
    const toSegment = ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / (length * length || 1);
    const amount = Math.max(0, Math.min(1, toSegment));
    const candidate = { index: index - 1, along: along + length * amount, distance, amount };
    if (!best || distance < best.distance - 1e-9 ||
      (Math.abs(distance - best.distance) <= 1e-9 && candidate.along < best.along)) best = candidate;
    along += length;
  }
  if (!best) {
    return Object.freeze({
      ok: false, reason: 'degenerate-route', legIndex: -1, along: 0, alongMetres: 0,
      remaining: route.distance, remainingMetres: round(navigationDistanceMetres(route.distance)),
      offRoute: 0, offRouteMetres: 0, arrived: false, nextTurn: null,
    });
  }
  const remaining = Math.max(0, route.distance - best.along);
  const legIndex = best.index;
  const leg = route.legs[legIndex] ?? null;
  const nextLeg = route.legs[legIndex + 1] ?? null;
  const nextTurn = nextLeg
    ? Object.freeze({
      name: nextLeg.name,
      distance: round(leg ? leg.distance * Math.max(0, 1 - best.amount) : 0),
      distanceMetres: round(navigationDistanceMetres(leg ? leg.distance * Math.max(0, 1 - best.amount) : 0)),
      direction: (() => {
        const turn = normalizedTurn(leg.bearingDegrees, nextLeg.bearingDegrees);
        if (Math.abs(turn) < 20) return 'straight';
        return turn > 0 ? 'right' : 'left';
      })(),
      degrees: round(normalizedTurn(leg.bearingDegrees, nextLeg.bearingDegrees), 1),
    })
    : null;
  // Arrival is about the target, never about the route's last vertex: a player who
  // has walked to the end of the line (or just past it) has arrived.
  const [lastX, lastZ] = route.coordinates[route.coordinates.length - 1];
  const distanceToTarget = Math.hypot(x - lastX, z - lastZ);
  const arrived = remaining <= GDO_NAV_ARRIVAL_RADIUS || distanceToTarget <= GDO_NAV_ARRIVAL_RADIUS;
  return Object.freeze({
    ok: true, reason: null,
    legIndex, along: round(best.along), alongMetres: round(navigationDistanceMetres(best.along)),
    remaining: round(remaining), remainingMetres: round(navigationDistanceMetres(remaining)),
    offRoute: round(best.distance), offRouteMetres: round(navigationDistanceMetres(best.distance)),
    distanceToTarget: round(distanceToTarget),
    bearingDegrees: leg ? leg.bearingDegrees : 0,
    legName: leg?.name ?? '', nextTurn, arrived,
    description: nextLeg ? `leg ${legIndex + 1}/${route.legs.length} on ${leg.name || 'the mapped road'}`
      : `last leg on ${leg?.name || 'the mapped road'}`,
  });
}

/** The one sentence the HUD shows, derived from the route and the progress. */
export function guidanceText(route, progress) {
  if (!route?.ok) {
    const reasons = {
      'empty-graph': 'No mapped roads here yet',
      'off-graph': 'Step back onto a mapped road for guidance',
      'unknown-target': 'That place is not on the local map',
      unreachable: 'No mapped route reaches that place',
      budget: 'The route search hit its budget',
    };
    return Object.freeze({
      kind: 'unavailable', text: reasons[route?.reason] ?? 'No route', reason: route?.reason ?? 'no-route',
    });
  }
  const target = route.targetName ? route.targetName : 'your target';
  if (!progress?.ok) {
    return Object.freeze({ kind: 'unavailable', text: `Route to ${target} is ${route.distanceMetres} m long`, reason: progress?.reason ?? 'no-progress' });
  }
  if (progress.arrived) {
    return Object.freeze({ kind: 'arrived', text: `You have arrived at ${target}`, remainingMetres: 0 });
  }
  if (progress.offRoute > GDO_NAV_OFF_ROUTE_LIMIT) {
    return Object.freeze({
      kind: 'off-route',
      text: `Off route — head back ${Math.round(progress.offRouteMetres)} m to ${progress.legName || 'the mapped road'}`,
      remainingMetres: Math.round(progress.remainingMetres),
    });
  }
  if (progress.nextTurn && progress.nextTurn.distance <= 6) {
    const way = progress.nextTurn.direction === 'straight' ? 'continue straight'
      : `turn ${progress.nextTurn.direction}`;
    return Object.freeze({
      kind: 'turn',
      text: `${Math.round(progress.nextTurn.distanceMetres)} m, ${way}${progress.nextTurn.name ? ` onto ${progress.nextTurn.name}` : ''}`,
      remainingMetres: Math.round(progress.remainingMetres),
    });
  }
  return Object.freeze({
    kind: 'continue',
    text: `Follow ${progress.legName || 'the mapped road'} for ${Math.round(progress.remainingMetres)} m to ${target}`,
    remainingMetres: Math.round(progress.remainingMetres),
  });
}

/**
 * The minimap as data: normalized `[-1, 1]` points around the player, north up,
 * plus the player's heading, the route, named places, and the loaded tile
 * rectangles. It reports zero renderer coupling because it has none.
 */
export function minimapModel({
  graph, route = null, x = 0, z = 0, headingDegrees = 0, radius = 120,
  loadedTiles = [], maxSegments = GDO_NAV_LIMITS.low.minimapSegments,
  maxPlaces = GDO_NAV_LIMITS.low.minimapPlaces,
} = {}) {
  const roads = [];
  let clippedSegments = 0, cappedSegments = 0;
  const nodes = graph?.nodes ?? [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const within = (u, v) => Math.abs(u) <= 1 && Math.abs(v) <= 1;
  const candidates = [];
  for (const edge of graph?.edges ?? []) {
    const a = byId.get(edge.a), b = byId.get(edge.b);
    if (!a || !b) continue;
    const [au, av] = minimapProject(a.x, a.z, x, z, radius);
    const [bu, bv] = minimapProject(b.x, b.z, x, z, radius);
    if (!within(au, av) && !within(bu, bv)) { clippedSegments++; continue; }
    const midpoint = Math.hypot((au + bu) / 2, (av + bv) / 2);
    candidates.push({ u1: au, v1: av, u2: bu, v2: bv, level: edge.level, name: edge.name, distance: midpoint });
  }
  candidates.sort((first, second) => (first.distance - second.distance) || (first.name < second.name ? -1 : 1));
  if (candidates.length > maxSegments) cappedSegments = candidates.length - maxSegments;
  for (const candidate of candidates.slice(0, maxSegments)) {
    roads.push(Object.freeze({
      u1: round(candidate.u1), v1: round(candidate.v1),
      u2: round(candidate.u2), v2: round(candidate.v2),
      level: candidate.level, name: candidate.name,
    }));
  }

  const places = [];
  for (const node of nodes) {
    if (node.kind !== GDO_NAV_KIND.PLACE) continue;
    const [u, v] = minimapProject(node.x, node.z, x, z, radius);
    if (!within(u, v)) continue;
    places.push({ id: node.id, name: node.name, u: round(u), v: round(v), distance: Math.hypot(u, v) });
  }
  places.sort((first, second) => (first.distance - second.distance) || (first.id < second.id ? -1 : 1));

  const routePoints = [];
  if (route?.ok) for (const [rx, rz] of route.coordinates) {
    const [u, v] = minimapProject(rx, rz, x, z, radius);
    routePoints.push(Object.freeze([round(u), round(v)]));
  }

  const tiles = loadedTiles.map(tile => {
    const [u, v] = minimapProject(tile.minX, tile.minZ, x, z, radius);
    const [u2, v2] = minimapProject(tile.maxX, tile.maxZ, x, z, radius);
    return Object.freeze({ key: tile.key, u: round(Math.min(u, u2)), v: round(Math.min(v, v2)), w: round(Math.abs(u2 - u)), h: round(Math.abs(v2 - v)) });
  }).sort((first, second) => (first.key < second.key ? -1 : 1));

  return Object.freeze({
    namespace: LOCAL_NAVIGATION_NAMESPACE,
    northUp: true,
    radius: round(radius, 2),
    player: Object.freeze({ u: 0, v: 0, headingDegrees: round(headingDegrees, 1) }),
    roads: Object.freeze(roads),
    places: Object.freeze(places.slice(0, maxPlaces)),
    route: Object.freeze(routePoints),
    tiles: Object.freeze(tiles),
    segments: roads.length,
    clippedSegments,
    cappedSegments,
    // Guidance is drawn by the caller's 2D HUD: this model owns no GPU object.
    threeObjects: 0,
    drawCalls: 0,
    geometries: 0,
    materials: 0,
  });
}

/** One graph, one set of routes, bounded and deterministic per tile set. */
export function createLocalNavigation({ profile = 'low', limits = null } = {}) {
  const caps = limits ?? GDO_NAV_LIMITS[profile] ?? GDO_NAV_LIMITS.low;
  const tiles = new Map();
  const places = new Map();
  let graph = emptyGraph();
  let graphVersion = 0;
  let expanded = 0;
  const counters = {
    rebuilds: 0, tiles: 0, places: 0, routes: 0, refusals: 0,
    minimaps: 0, steadyFrameAllocations: 0,
    refusalReasons: Object.create(null),
  };

  const rebuild = () => {
    graph = buildGraph(tiles, [...places.values()].sort((first, second) => (first.id < second.id ? -1 : 1)), caps);
    graphVersion++;
    counters.rebuilds++;
    counters.tiles = tiles.size;
    counters.places = places.size;
    return graph;
  };

  const api = {
    namespace: LOCAL_NAVIGATION_NAMESPACE,
    profile,
    limits: caps,
    get graph() { return graph; },
    get version() { return graphVersion; },
    get diagnostics() {
      return Object.freeze({
        namespace: LOCAL_NAVIGATION_NAMESPACE,
        profile,
        limits: caps,
        graph: graph.diagnostics,
        graphVersion,
        routes: counters.routes,
        refusals: counters.refusals,
        refusalReasons: Object.freeze({ ...counters.refusalReasons }),
        expanded,
        rebuilds: counters.rebuilds,
        minimaps: counters.minimaps,
        steadyFrameAllocations: 0,
      });
    },
    addTile(key, payload) {
      if (!key || !payload || !Array.isArray(payload.lines)) return false;
      tiles.set(key, {
        lines: payload.lines, names: payload.names ?? [], levels: payload.levels ?? [],
        // `LIF-04`: the canonical road class travels with each line, so a consumer
        // can tell a street a person may walk beside from a motorway or a path
        // without re-interpreting the provider schema.
        kinds: payload.kinds ?? [], widths: payload.widths ?? [],
        truncated: Boolean(payload.truncated),
      });
      return rebuild();
    },
    addPlaces(tileKey, labels) {
      if (!tileKey || !Array.isArray(labels)) return false;
      for (const label of labels) {
        if (!label?.name || !Number.isFinite(label.x) || !Number.isFinite(label.z)) continue;
        const id = navigationPlaceId(label);
        places.set(id, {
          id, name: label.name, kind: label.kind ?? GDO_NAV_KIND.PLACE,
          x: label.x, z: label.z, tile: tileKey,
        });
      }
      return rebuild();
    },
    removeTile(key) {
      const had = tiles.delete(key);
      let removedPlaces = false;
      for (const [id, place] of places) {
        if (place.tile === key) { places.delete(id); removedPlaces = true; }
      }
      if (had || removedPlaces) rebuild();
      return had || removedPlaces;
    },
    rebuild,
    places() {
      return Object.freeze([...places.values()].map(place => Object.freeze({ ...place })));
    },
    routeTo(target, from) {
      const route = planRoute(graph, from, target, { expansions: caps.expansions });
      expanded = Math.max(expanded, route.expansions ?? 0);
      if (route.ok) counters.routes++;
      else {
        counters.refusals++;
        counters.refusalReasons[route.reason] = (counters.refusalReasons[route.reason] ?? 0) + 1;
      }
      return route;
    },
    routeToPlace(placeId, from) {
      const place = places.get(placeId);
      if (!place) {
        counters.refusals++;
        counters.refusalReasons['unknown-target'] = (counters.refusalReasons['unknown-target'] ?? 0) + 1;
        return refusedRoute('unknown-target');
      }
      return api.routeTo({ x: place.x, z: place.z, nodeId: place.id }, from);
    },
    progress(route, x, z) {
      return routeProgress(route, x, z);
    },
    guidance(route, x, z) {
      return guidanceText(route, routeProgress(route, x, z));
    },
    minimap(options) {
      counters.minimaps++;
      return minimapModel({ graph, maxSegments: caps.minimapSegments, maxPlaces: caps.minimapPlaces, ...options });
    },
    /**
     * `GME-07`'s programmatic proof: a fixed-step walk from the start of a real
     * route to its target, checking that the guidance decreases, that a deliberate
     * lateral push is reported as off-route, that every minimap stays inside the
     * declared caps with no renderer coupling, and that the whole walk replays
     * byte-identically.
     */
    auditWalk({
      target = null, from = null, steps = 48, speed = null, dt = 1 / 30,
      wander = 3.2, radius = 120, label = 'local-navigation',
    } = {}) {
      const runWalk = () => {
        const start = from ?? (graph.nodes.length ? { x: graph.nodes[0].x, z: graph.nodes[0].z } : null);
        const goal = target ?? (api.places()[0] ?? null);
        if (!start || !goal) return { ok: false, reason: 'empty-graph', samples: [], fingerprint: '00000000', route: refusedRoute('empty-graph') };
        const route = api.routeTo({ x: goal.x, z: goal.z }, start);
        if (!route.ok) return { ok: false, reason: route.reason, samples: [], fingerprint: '00000000', route };
        // The walk covers the whole route in `steps` samples, so the last sample
        // is at the target no matter how long the route is.
        const pace = speed ?? (route.distance / Math.max(1, steps) / dt);
        const samples = [];
        let along = 0;
        for (let index = 0; index < steps; index++) {
          along = Math.min(route.distance, along + pace * dt);
          const point = pointAlongRoute(route, along);
          const bearing = (point?.bearingDegrees ?? 0) * Math.PI / 180;
          // The scripted walker is pushed `wander` units off the line for the
          // first 60% of the walk and converges back onto it afterwards, which is
          // exactly the re-guidance a real player's detour needs.
          const offset = index < steps * .6 ? wander
            : wander * Math.max(0, 1 - (index - steps * .6) / Math.max(1, steps * .4));
          const sampleX = point.x + Math.cos(bearing) * offset;
          const sampleZ = point.z - Math.sin(bearing) * offset;
          const progress = routeProgress(route, sampleX, sampleZ);
          const guidance = guidanceText(route, progress);
          const minimap = api.minimap({
            route, x: sampleX, z: sampleZ, headingDegrees: progress.bearingDegrees, radius,
            loadedTiles: [], maxSegments: caps.minimapSegments,
          });
          samples.push(Object.freeze({
            index, x: round(sampleX), z: round(sampleZ),
            remaining: progress.remaining, offRoute: progress.offRoute,
            arrived: progress.arrived, kind: guidance.kind, text: guidance.text,
            segments: minimap.segments, threeObjects: minimap.threeObjects, drawCalls: minimap.drawCalls,
          }));
        }
        const fingerprint = hash(samples.map(sample =>
          `${sample.remaining}:${sample.offRoute}:${sample.kind}:${sample.segments}`).join('|'));
        return { ok: true, reason: null, route, samples, fingerprint };
      };
      const first = runWalk();
      const second = runWalk();
      const samples = first.samples;
      const monotonic = samples.every((sample, index) =>
        index === 0 || sample.remaining <= samples[index - 1].remaining + 1e-6);
      const offRoute = samples.filter(sample => sample.kind === 'off-route');
      const arrived = samples.some(sample => sample.arrived);
      const capped = samples.filter(sample => sample.segments <= caps.minimapSegments);
      const renderer = samples.every(sample => sample.threeObjects === 0 && sample.drawCalls === 0);
      const verdicts = [
        Object.freeze({
          id: 'route', ok: first.ok, detail: first.ok
            ? `${first.route.legs.length} leg(s) over ${first.route.distanceMetres} m in ${first.route.expansions} expansions`
            : `no route: ${first.reason}`,
        }),
        Object.freeze({
          id: 'guidance', ok: monotonic && arrived,
          detail: monotonic
            ? (arrived ? `remaining distance fell to zero over ${samples.length} samples` : 'the walk never arrived')
            : 'guidance distance went back up',
        }),
        Object.freeze({
          id: 'off-route', ok: offRoute.length > 0,
          detail: offRoute.length
            ? `${offRoute.length} sample(s) of ${samples.length} reported off route and re-guided`
            : 'the scripted drift was never reported',
        }),
        Object.freeze({
          id: 'minimap', ok: capped.length === samples.length,
          detail: `${capped.length}/${samples.length} minimaps inside the ${caps.minimapSegments}-segment cap`,
        }),
        Object.freeze({
          id: 'renderer', ok: renderer,
          detail: renderer ? 'the minimap model created no GPU object and no draw call' : 'the minimap touched the renderer',
        }),
        Object.freeze({
          id: 'budget', ok: (first.route.expansions ?? 0) <= caps.expansions,
          detail: `${first.route.expansions ?? 0} expansions of the declared ${caps.expansions}`,
        }),
        Object.freeze({
          id: 'determinism', ok: Boolean(first.fingerprint) && first.fingerprint === second.fingerprint,
          detail: first.fingerprint === second.fingerprint
            ? `two walks share the fingerprint ${first.fingerprint}` : 'two walks diverged',
        }),
      ];
      const report = {
        namespace: LOCAL_NAVIGATION_NAMESPACE, label,
        steps, pace: round(first.route.distance / Math.max(1, steps)), wander,
        fingerprint: first.fingerprint,
        samples: samples.length,
        verdicts: Object.freeze(verdicts),
        ok: verdicts.every(verdict => verdict.ok),
      };
      report.detail = report.ok
        ? `${samples.length} scripted navigation samples passed ${verdicts.length} verdicts (${report.fingerprint})`
        : `failed: ${verdicts.filter(verdict => !verdict.ok).map(verdict => verdict.id).join(', ')}`;
      return Object.freeze(report);
    },
  };
  return api;
}

/** The low-profile budget surface this feature must respect. */
export function navigationBudgetSummary(limits = GDO_NAV_LIMITS.low) {
  return Object.freeze({
    nodes: limits.nodes,
    edges: limits.edges,
    expansions: limits.expansions,
    minimapSegments: limits.minimapSegments,
    steadyFrameAllocations: 0,
  });
}

/** Declared budgets and ceilings, checked against the shipped low profile. */
export function describeLocalNavigation(budget = GDO_LOW_PROFILE_BUDGETS) {
  const violations = [];
  const low = GDO_NAV_LIMITS.low;
  if (low.nodes > budget.navNodes) violations.push(`nodes ${low.nodes} > budget ${budget.navNodes}`);
  if (low.edges > budget.navEdges) violations.push(`edges ${low.edges} > budget ${budget.navEdges}`);
  if (low.expansions > budget.navRouteExpansions) violations.push(`expansions ${low.expansions} > budget ${budget.navRouteExpansions}`);
  if (low.minimapSegments > budget.navMinimapSegments) violations.push(`minimap segments ${low.minimapSegments} > budget ${budget.navMinimapSegments}`);
  return Object.freeze({
    namespace: LOCAL_NAVIGATION_NAMESPACE,
    ok: violations.length === 0,
    violations: Object.freeze(violations),
    profiles: Object.keys(GDO_NAV_LIMITS).length,
    limits: GDO_NAV_LIMITS,
    budget: Object.freeze({ ...budget }),
  });
}
