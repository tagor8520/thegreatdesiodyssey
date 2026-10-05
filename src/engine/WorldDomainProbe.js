/**
 * Lane construction and probing for the `FND-08` gate, shared by both tiers.
 *
 * The Node test and the browser scenario must measure the same thing through
 * the same code, or the two tiers can disagree about what "the interface holds"
 * means. They cannot share a test file — one runs under `node --test` and the
 * other is imported into the page over the dev server — so the lane search and
 * the probe orchestration live here, in a module both can reach.
 *
 * This module is imported by `*.test.js` files and by `tools/visual-audit`; no
 * entry point reaches it, so it is not part of the production bundle.
 *
 * Every lane is *found*, never hard-coded. Two attempts at picking one by hand
 * during this feature both produced a lane that was already inside something —
 * a building in the coordinate fixture, a bridge pier behind the curated start —
 * and a probe measured from inside geometry proves nothing about a query.
 */

import * as THREE from 'three';
import { GEO_QUERY_MASK } from '../geo/GeoCollision.js';
import { probeWorldDomain } from './WorldDomain.js';
import { tileHeight } from '../reference/BiomeManager.js';
import { CURATED_FOOTPRINT_HALF_EXTENT } from '../reference/CuratedDomain.js';

/** A solid that both the player overlap query and the camera sweep must see. */
export const COORDINATE_PROXY_MASK = GEO_QUERY_MASK.SOLID_PLAYER | GEO_QUERY_MASK.CAMERA_BLOCKER;

const r3 = (x = 0, y = 0, z = 0) => ({
  x, y, z,
  set(nx, ny, nz) { this.x = nx; this.y = ny; this.z = nz; return this; },
});

/**
 * A coordinate lane whose start is clear of static geometry **and** whose
 * reverse camera control is clear; the solid is placed later by the caller.
 */
export function findCoordinateLane(world, { advance = 6, control = 4, half = .055 } = {}) {
  for (const tile of world.tiles.values()) {
    const minX = tile.bounds.minX + 1, maxX = tile.bounds.maxX - advance - 1;
    const minZ = tile.bounds.minZ + 1, maxZ = tile.bounds.maxZ - control - 1;
    for (let x = minX; x <= maxX; x += 1) {
      for (let z = minZ; z <= maxZ; z += 1) {
        if (world.collidesCircle(x, z, half)) continue;
        const target = r3(x, 1.5, z);
        const back = r3(x - control, 1.5, z);
        if (world.clipCamera(target, back, .04, {}).blocked) continue;
        return {
          from: { x, z },
          toward: { x: x + advance, z },
          cameraHeight: 1.5 - world.supportAt(x, z, {}).y,
        };
      }
    }
  }
  throw new Error('no clear coordinate lane with a clear camera control behind it');
}

/**
 * Step pairs for the coordinate world, found by scanning the resident tile for
 * its support extremes rather than assuming a fixture is hilly. The policy
 * ceiling is set to half the measured span, which makes the reject case true by
 * construction and leaves the level pair inside it.
 */
export function coordinateStepPoints(world, from) {
  const tile = [...world.tiles.values()][0];
  let low = null, high = null;
  for (let x = tile.bounds.minX; x <= tile.bounds.maxX; x += 1) {
    for (let z = tile.bounds.minZ; z <= tile.bounds.maxZ; z += 1) {
      const y = world.supportAt(x, z, {}).y;
      if (!low || y < low.y) low = { x, z, y };
      if (!high || y > high.y) high = { x, z, y };
    }
  }
  const span = high.y - low.y;
  if (!(span > 0)) throw new Error('the resident tile presents no support range to test the step policy against');
  const maxStepUp = span / 2;
  let level = low;
  for (let x = tile.bounds.minX; x <= tile.bounds.maxX && level === low; x += 1) {
    const y = world.supportAt(x, low.z, {}).y;
    if (x !== low.x && Math.abs(y - low.y) < maxStepUp) level = { x, z: low.z, y };
  }
  return {
    from: { x: from.x, z: from.z },
    level: { x: level.x, z: level.z },
    rise: { x: high.x, z: high.z },
    policy: { maxStepUp, maxStepDown: maxStepUp, maxSlope: Math.PI / 2 },
  };
}

export function probeCoordinateDomain(world, { ownerKey = 'fnd08-probe' } = {}) {
  const lane = findCoordinateLane(world);
  const handle = world.addDynamicProxy({
    shape: 'circle', x: lane.toward.x, z: lane.toward.z, radius: 1,
    y0: 0, y1: 3, mask: COORDINATE_PROXY_MASK, ownerKey,
  });
  try {
    return probeWorldDomain(world, {
      lane,
      radius: .035,
      step: coordinateStepPoints(world, lane.from),
      camera: { height: lane.cameraHeight, clearDistance: 4 },
    });
  } finally {
    world.removeDynamicProxy(handle);
  }
}

/**
 * A curated lane that satisfies every precondition the probe asserts: the start
 * is clear of rails, the reverse control segment is clear of camera blockers,
 * and the forward segment into the rail is not.
 */
export function bridgeLane(bridges, { sweepRadius = .9, clearDistance = 1.5, advance = 6, half = .55 } = {}) {
  const box = new THREE.Box3();
  const railClear = (x, z) => !bridges.intersectsRail(box.set(
    new THREE.Vector3(x - half, -Infinity, z - half),
    new THREE.Vector3(x + half, Infinity, z + half),
  ));
  for (const rail of bridges.rails) {
    const centre = rail.getCenter(new THREE.Vector3());
    for (const sign of [1, -1]) {
      const start = { x: centre.x, z: centre.z + sign * advance };
      if (Math.abs(start.x) > 120 || Math.abs(start.z) > 120) continue;
      if (!railClear(start.x, start.z) || !railClear(start.x, start.z + sign * clearDistance)) continue;
      const support = Math.max(tileHeight(start.x, start.z), bridges.heightAt(start.x, start.z));
      const height = centre.y - support;
      if (bridges.clipCamera(r3(start.x, support + height, start.z),
        r3(start.x, support + height, start.z + sign * clearDistance), sweepRadius, {}).blocked) continue;
      if (!bridges.clipCamera(r3(start.x, support + height, start.z),
        r3(centre.x, support + height, centre.z), sweepRadius, {}).blocked) continue;
      return {
        rail,
        lane: { from: { x: start.x, z: start.z }, toward: { x: centre.x, z: centre.z } },
        height, sweepRadius, clearDistance,
      };
    }
  }
  throw new Error('no curated rail yields a lane with a clear camera control and a blocked forward segment');
}

/**
 * Step pairs for the curated world. The rise must come from a deck genuinely
 * above the limit: the arches reach about three units over the terrain, but only
 * near mid-span, and a point chosen by eye sat under a deck only `.24` units up
 * — a legal step, which would have made the reject assertion a lie about its
 * own precondition.
 */
export function curatedStepPoints(bridges, rail) {
  const centre = rail.getCenter(new THREE.Vector3());
  const fromX = Math.floor(centre.x / 4) * 4 + 2;
  const fromZ = Math.floor((rail.max.z + 8) / 4) * 4 + 2;
  const fromY = Math.max(tileHeight(fromX, fromZ), bridges.heightAt(fromX, fromZ));
  let rise = null;
  for (const deck of bridges.colliders) {
    const deckCentre = deck.getCenter(new THREE.Vector3());
    const top = bridges.heightAt(deckCentre.x, deckCentre.z);
    if (!Number.isFinite(top) || top <= fromY + CURATED_FOOTPRINT_HALF_EXTENT) continue;
    if (!rise || top > rise.top) rise = { x: deckCentre.x, z: deckCentre.z, top };
  }
  if (!rise) throw new Error('curated bridges present no deck above the step ceiling for the reject case');
  return {
    from: { x: fromX, z: fromZ },
    level: { x: fromX + 1, z: fromZ },
    rise: { x: rise.x, z: rise.z },
    policy: { maxStepUp: CURATED_FOOTPRINT_HALF_EXTENT, maxStepDown: 64, maxSlope: Math.PI / 2 },
  };
}

export function probeCuratedDomain(domain, bridges) {
  const { rail, lane, height, sweepRadius, clearDistance } = bridgeLane(bridges);
  return probeWorldDomain(domain, {
    lane, radius: sweepRadius,
    step: curatedStepPoints(bridges, rail),
    camera: { height, clearDistance },
  });
}
