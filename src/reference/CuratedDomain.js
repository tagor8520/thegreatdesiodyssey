/**
 * Curated mode's implementation of the domain interface (`FND-08`).
 *
 * Curated never had a "world" object. Its traversal surface was spread across
 * three places: `BiomeManager`'s module-level 4 m terrain lattice, the bridge
 * manager's rail boxes and deck heights, and the player's own hard-coded
 * collision box. This class collects those into the same five questions the
 * coordinate mode answers, so one probe can drive both.
 *
 * It is an adapter, not a rewrite: every rule here is the shipped one, moved
 * behind a name. The scan order for terrain sampling, the ±.6 rail box, the
 * centre-based world bound and the axis-separated revert are all reproduced
 * exactly, because curated's traversal feel is a product decision and not a
 * side effect of refactoring.
 *
 * Curated differences that are intentional, and that the interface carries
 * rather than hides:
 *
 * - Support is the **highest** surface at a point (`max(terrain, deck)`), not the
 *   nearest to a reference height. `supportAt` therefore accepts the reference
 *   parameter for interface parity and does not use it; curated has no
 *   overlapping multi-level surfaces to disambiguate.
 * - There is no slope rule. The 4 m lattice exposes no normal, so every sample
 *   reports `walkable: true` and traversal is decided entirely by
 *   `resolveGroundStep`'s height policy.
 * - A blocked horizontal move **reverts**, it does not slide. There is no
 *   projected remainder to hand back, so `projectedX`/`projectedZ` are zero.
 * - The camera sweep radius clamp is `[.6, 1.25]` against coordinate's
 *   `[.03, .04]`, because the two near planes and fields of view differ by
 *   design. `compareDomainScales` asserts the clamps never overlap.
 */

import * as THREE from 'three';
import { tileHeight } from './BiomeManager.js';
import { supportUnderFoot } from '../engine/WorldDomain.js';

/** The shipped curated world bound: a body centre outside ±126 is blocked. */
export const CURATED_WORLD_EXTENT = 126;
/** The shipped rail-collision half extent used by `Player.moveAxis`. */
export const CURATED_COLLISION_HALF_EXTENT = .6;
/** The shipped vertical span of the curated player's collision box, above the feet. */
export const CURATED_COLLISION_FEET = .05;
export const CURATED_COLLISION_HEAD = 4.35;
/** The shipped ground-sampling half extent (`±.55` on both axes). */
export const CURATED_FOOTPRINT_HALF_EXTENT = .55;
/** Curated has no drop limit; the world escape depth at `y < -5` is the only bound. */
export const CURATED_DROP_LIMIT = 64;
/** Curated samples ground on the 4 m biome lattice. */
export const CURATED_SUPPORT_SPACING = 4;

export class CuratedDomain {
  constructor({ bridges, worldScene = null } = {}) {
    if (!bridges || typeof bridges.intersectsRail !== 'function') {
      throw new TypeError('CuratedDomain requires a bridge manager exposing intersectsRail()');
    }
    this.name = 'curated';
    this.bridges = bridges;
    this.scene = worldScene;
    this.scale = Object.freeze({
      footprintHalfExtent: CURATED_FOOTPRINT_HALF_EXTENT,
      supportSampleSpacing: CURATED_SUPPORT_SPACING,
      sweepRadiusMin: .6,
      sweepRadiusMax: 1.25,
    });
    this.scratchBox = new THREE.Box3();
    this.candidates = {};
    this.counters = {
      supportQueries: 0, collisionQueries: 0, motionQueries: 0,
      groundTransitions: 0, groundRejects: 0, cameraQueries: 0,
    };
  }

  /**
   * The highest surface at one point: biome terrain, or a bridge deck above it.
   * Reproduces `Player.groundAt` and `BridgeManager.heightAt` exactly, including
   * `heightAt`'s `-Infinity` when the point is over no deck at all.
   */
  supportAt(x, z, out = {}) {
    this.counters.supportQueries++;
    const terrain = tileHeight(x, z);
    const deck = this.bridges.heightAt(x, z);
    const onDeck = Number.isFinite(deck) && deck >= terrain;
    out.x = x;
    out.y = onDeck ? deck : terrain;
    out.z = z;
    out.normalX = 0;
    out.normalY = 1;
    out.normalZ = 0;
    out.slopeRadians = 0;
    out.walkable = true;
    out.kind = onDeck ? 'bridge' : 'terrain';
    return out;
  }

  /**
   * A rail box or the world bound overlapping this circle. The vertical span is
   * taken literally from `minY`/`maxY` so a caller can reproduce the shipped
   * feet-to-head box; the defaults span everything, which is the conservative
   * reading for a query that does not care about height.
   */
  collidesCircle(x, z, radius, _queryMask = 0, minY = -Infinity, maxY = Infinity) {
    this.counters.collisionQueries++;
    if (Math.abs(x) > CURATED_WORLD_EXTENT || Math.abs(z) > CURATED_WORLD_EXTENT) return true;
    const box = this.scratchBox;
    box.min.set(x - radius, minY, z - radius);
    box.max.set(x + radius, maxY, z + radius);
    return this.bridges.intersectsRail(box);
  }

  /**
   * Axis-separated move and revert. Each axis is attempted on its own, in x then
   * z, and one that ends inside a rail or outside the world is undone without
   * touching the other — which is what lets a player slide along a bridge rail
   * instead of sticking to it.
   *
   * The step policy is deliberately **not** applied here: a floor that rose too
   * far is a traversal decision, and `resolveGroundStep` owns it in both modes.
   */
  moveCircle(x, z, dx, dz, radius, _skin = 0, _maxContacts = 2, out = {}, _maxDepenetration = 0) {
    this.counters.motionQueries++;
    let currentX = x, currentZ = z, hit = false, contacts = 0, normalX = 0, normalZ = 0;
    const attempt = (amount, axis) => {
      if (!amount) return;
      const nextX = axis === 'x' ? currentX + amount : currentX;
      const nextZ = axis === 'z' ? currentZ + amount : currentZ;
      if (this.collidesCircle(nextX, nextZ, radius)) {
        hit = true;
        contacts++;
        const away = amount > 0 ? -1 : 1;
        if (axis === 'x') normalX = away; else normalZ = away;
        return;
      }
      currentX = nextX;
      currentZ = nextZ;
    };
    attempt(dx, 'x');
    attempt(dz, 'z');

    out.hit = hit;
    out.contacts = contacts;
    out.depenetrated = false;
    out.depenetrationDistance = 0;
    out.normalX = normalX;
    out.normalZ = normalZ;
    out.x = currentX;
    out.z = currentZ;
    // Reverting discards the remainder; there is no projected component to keep.
    out.projectedX = 0;
    out.projectedZ = 0;
    return out;
  }

  /**
   * The shipped traversal rule, expressed as a policy.
   *
   * `Player.moveAxis` blocked when the four-corner floor rose more than `.55`
   * above the feet, and let gravity handle every drop. That is a step-up limit
   * of `.55`, no drop limit inside the world, and no slope rule at all — the
   * constants below record exactly that, including the fact that
   * `footprintHalfExtent` is what makes the two ends match the old four-corner
   * maximum instead of a single centre sample.
   */
  resolveGroundStep(fromX, fromZ, toX, toZ, {
    referenceY = Number.NaN,
    maxStepUp = CURATED_FOOTPRINT_HALF_EXTENT,
    maxStepDown = CURATED_DROP_LIMIT,
    maxSlope = Math.PI / 2,
    footprintHalfExtent = CURATED_FOOTPRINT_HALF_EXTENT,
  } = {}, out = {}) {
    if (![maxStepUp, maxStepDown, maxSlope].every(Number.isFinite) || maxStepUp < 0 || maxStepDown < 0 || maxSlope < 0) {
      throw new RangeError('Invalid ground-step policy');
    }
    this.counters.groundTransitions++;
    out.from = this._sampleSupport(fromX, fromZ, referenceY, footprintHalfExtent, out.from ?? {});
    out.to = this._sampleSupport(toX, toZ, out.from.y, footprintHalfExtent, out.to ?? {});
    out.heightDelta = out.to.y - out.from.y;
    out.accepted = true;
    out.reason = 'accepted';
    if (out.to.slopeRadians > maxSlope) { out.accepted = false; out.reason = 'slope'; }
    else if (out.heightDelta > maxStepUp) { out.accepted = false; out.reason = 'step-up'; }
    else if (out.heightDelta < -maxStepDown) { out.accepted = false; out.reason = 'drop'; }
    if (!out.accepted) this.counters.groundRejects++;
    return out;
  }

  _sampleSupport(x, z, referenceY, footprintHalfExtent, out) {
    if (Number.isFinite(footprintHalfExtent) && footprintHalfExtent > 0) {
      return supportUnderFoot(this, x, z, footprintHalfExtent, out);
    }
    return this.supportAt(x, z, out);
  }

  /** Delegates to the bridge manager, which already had the right shape. */
  clipCamera(target, desired, radius = this.scale.sweepRadiusMin, out = {}) {
    this.counters.cameraQueries++;
    return this.bridges.clipCamera(target, desired, radius, out);
  }

  readDiagnostics() { return { ...this.counters }; }
}

export function createCuratedDomain(options) { return new CuratedDomain(options); }
