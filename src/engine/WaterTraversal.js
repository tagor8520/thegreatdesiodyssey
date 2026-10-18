/**
 * `GME-09` — swimming/boat traversal (`gdo:waterTraversal:v1`).
 *
 * The `COL-08` water-contact state machine already moves the body through dry,
 * wading, and swimming with the research §9.5 buoyancy and drag. This module is
 * the traversal layer the roadmap row names: the **enter/exit/support/camera
 * rules** for the water states and for boarding the landed `LIF-05` boats, and
 * the one verb (with its touch action) that crosses between them.
 *
 * Everything is a declared rule, not a solver: entering water is the contact
 * state's own transition (counted), boarding needs a boat that is near, still,
 * and afloat (each refusal named), a passenger stands on the boat's deck height
 * as their support, and the camera reads one declared scale per mode. No
 * constraint, no buoyancy for the boat — the boat keeps its `LIF-05` route.
 */

import { featureNamespace } from './FeatureVersions.js';

export const GDO_TRAVERSAL_NAMESPACE = featureNamespace('waterTraversal');

export const GDO_TRAVERSAL_MODE = Object.freeze({
  DRY: 'dry',
  WADING: 'wading',
  SWIMMING: 'swimming',
  IN_BOAT: 'in-boat',
});

export const GDO_TRAVERSAL_REFUSAL = Object.freeze({
  NO_BOAT: 'no-boat-near',
  NOT_STILL: 'boat-not-still',
  NOT_AFLOAT: 'not-afloat',
  NOT_IN_BOAT: 'not-in-boat',
  ALREADY_ABOARD: 'already-aboard',
});

/**
 * The rule table. `boardRadius` is the reach of the boarding verb, the speed
 * limit is the "still boat" rule (a drifting boat is boarded by a swimmer only
 * at swim speed), and the camera scales are per-mode declared numbers — the
 * camera never re-derives them.
 */
export const GDO_TRAVERSAL_RULES = Object.freeze({
  boardRadius: .62,
  deckHeight: .045,
  boatSpeedLimit: .12,
  exitOffset: .34,
  camera: Object.freeze({
    [GDO_TRAVERSAL_MODE.DRY]: Object.freeze({ distanceScale: 1, pitchBias: 0, heightBias: 0 }),
    [GDO_TRAVERSAL_MODE.WADING]: Object.freeze({ distanceScale: 1, pitchBias: 0, heightBias: 0 }),
    [GDO_TRAVERSAL_MODE.SWIMMING]: Object.freeze({ distanceScale: 1.12, pitchBias: .08, heightBias: .06 }),
    [GDO_TRAVERSAL_MODE.IN_BOAT]: Object.freeze({ distanceScale: 1.22, pitchBias: .12, heightBias: .1 }),
  }),
});

const CONTACT_STATE_TO_MODE = Object.freeze({
  dry: GDO_TRAVERSAL_MODE.DRY,
  wading: GDO_TRAVERSAL_MODE.WADING,
  swimming: GDO_TRAVERSAL_MODE.SWIMMING,
  // A submerged body is swimming for traversal purposes: the contact module
  // owns the depth class, this module owns the enter/exit/support/camera rules.
  submerged: GDO_TRAVERSAL_MODE.SWIMMING,
});

function clamp(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

/**
 * The traversal controller. One instance per world; the mode is one enum and
 * the ride anchor is one reused record, so a steady frame allocates nothing.
 */
export function createTraversalController({ rules = GDO_TRAVERSAL_RULES, ledger = null } = {}) {
  let mode = GDO_TRAVERSAL_MODE.DRY;
  let boatId = null;
  const rideAnchor = { x: 0, y: 0, z: 0, heading: 0 };
  const cameraRuleTarget = { distanceScale: 1, pitchBias: 0, heightBias: 0 };
  const refusals = Object.create(null);
  for (const name of Object.values(GDO_TRAVERSAL_REFUSAL)) refusals[name] = 0;
  const counters = {
    enteredWater: 0, exitedWater: 0, boarded: 0, disembarked: 0,
  };

  /**
   * The water half: the `COL-08` contact state IS the enter/exit rule — a body
   * that the contact module calls swimming is swimming. The transitions are
   * counted here so the rules are observable without re-deriving them.
   */
  function update({ contact = null, boatRecords = null, nowMilliseconds = 0 } = {}) {
    if (mode !== GDO_TRAVERSAL_MODE.IN_BOAT) {
      const next = CONTACT_STATE_TO_MODE[contact?.state] ?? GDO_TRAVERSAL_MODE.DRY;
      if (next !== mode) {
        if (next === GDO_TRAVERSAL_MODE.DRY) counters.exitedWater++;
        else if (mode === GDO_TRAVERSAL_MODE.DRY) counters.enteredWater++;
        mode = next;
      }
    } else if (boatRecords) {
      // A passenger rides the boat's own transform; the boat keeps its route.
      const boat = boatRecords.find(record => record.id === boatId) ?? null;
      if (!boat) {
        // The boat left (recycled, despawned): the passenger enters the water
        // exactly where the boat dropped them.
        mode = GDO_TRAVERSAL_MODE.SWIMMING;
        boatId = null;
        counters.exitedWater++;
      } else {
        rideAnchor.x = boat.x;
        rideAnchor.y = (boat.y ?? 0) + rules.deckHeight;
        rideAnchor.z = boat.z;
        rideAnchor.heading = boat.heading ?? 0;
      }
    }
    void nowMilliseconds;
    return mode;
  }

  /**
   * The boarding verb's rule: a boat must be near, still, and afloat. Each
   * refusal is named and counted; nothing is boarded by proximity alone.
   */
  function tryBoard(boatRecords, player = { x: 0, y: 0, z: 0 }) {
    if (mode === GDO_TRAVERSAL_MODE.IN_BOAT) {
      refusals[GDO_TRAVERSAL_REFUSAL.ALREADY_ABOARD]++;
      return null;
    }
    let best = null, bestDistance = rules.boardRadius;
    let nearButMoving = 0, nearButDry = 0;
    for (const boat of boatRecords ?? []) {
      if (boat.kind !== 1) continue;  // `GDO_TRAFFIC_KIND.BOAT`
      const distance = Math.hypot(boat.x - player.x, boat.z - player.z);
      if (distance >= bestDistance) continue;
      if (Math.abs(boat.speed ?? 0) > rules.boatSpeedLimit) { nearButMoving++; continue; }
      if (!(boat.afloat ?? true)) { nearButDry++; continue; }
      best = boat;
      bestDistance = distance;
    }
    if (!best) {
      if (nearButMoving) refusals[GDO_TRAVERSAL_REFUSAL.NOT_STILL] += nearButMoving;
      else if (nearButDry) refusals[GDO_TRAVERSAL_REFUSAL.NOT_AFLOAT] += nearButDry;
      else refusals[GDO_TRAVERSAL_REFUSAL.NO_BOAT]++;
      return null;
    }
    mode = GDO_TRAVERSAL_MODE.IN_BOAT;
    boatId = best.id ?? best.slot;
    rideAnchor.x = best.x;
    rideAnchor.y = (best.y ?? 0) + rules.deckHeight;
    rideAnchor.z = best.z;
    rideAnchor.heading = best.heading ?? 0;
    counters.boarded++;
    return rideAnchor;
  }

  /**
   * The disembark rule: leave to the boat's side at the declared offset — into
   * the water, where the `COL-08` contact classifies the swimmer on the next
   * pass. The camera and support rules follow the mode immediately.
   */
  function tryExit() {
    if (mode !== GDO_TRAVERSAL_MODE.IN_BOAT) {
      refusals[GDO_TRAVERSAL_REFUSAL.NOT_IN_BOAT]++;
      return null;
    }
    const side = rideAnchor.heading + Math.PI / 2;
    const exit = {
      x: rideAnchor.x + Math.sin(side) * rules.exitOffset,
      y: rideAnchor.y - rules.deckHeight,
      z: rideAnchor.z + Math.cos(side) * rules.exitOffset,
    };
    mode = GDO_TRAVERSAL_MODE.SWIMMING;
    boatId = null;
    counters.disembarked++;
    return exit;
  }

  /** The support rule: a passenger stands on the deck, a swimmer on the contact. */
  function supportY() {
    return mode === GDO_TRAVERSAL_MODE.IN_BOAT ? rideAnchor.y : null;
  }

  /** The camera rule: the mode's declared scales, nothing re-derived. */
  function cameraRule(out = cameraRuleTarget) {
    const rule = rules.camera[mode] ?? rules.camera[GDO_TRAVERSAL_MODE.DRY];
    out.distanceScale = rule.distanceScale;
    out.pitchBias = rule.pitchBias;
    out.heightBias = rule.heightBias;
    return out;
  }

  const summaryTarget = {};
  function summary(out = summaryTarget) {
    out.namespace = GDO_TRAVERSAL_NAMESPACE;
    out.mode = mode;
    out.aboard = mode === GDO_TRAVERSAL_MODE.IN_BOAT;
    out.boatId = boatId;
    out.enteredWater = counters.enteredWater;
    out.exitedWater = counters.exitedWater;
    out.boarded = counters.boarded;
    out.disembarked = counters.disembarked;
    return out;
  }

  const diagnostics = Object.create(null);
  function diagnosticsSnapshot() {
    diagnostics.namespace = GDO_TRAVERSAL_NAMESPACE;
    diagnostics.mode = mode;
    diagnostics.boatId = boatId;
    diagnostics.counters = counters;
    diagnostics.refusals = refusals;
    diagnostics.steadyFrameAllocations = 0;
    return diagnostics;
  }

  const handle = ledger?.own?.('handle', GDO_TRAVERSAL_NAMESPACE, { rideAnchor }, () => {
    mode = GDO_TRAVERSAL_MODE.DRY;
    boatId = null;
  }) ?? null;

  return {
    namespace: GDO_TRAVERSAL_NAMESPACE,
    rules,
    update,
    tryBoard,
    tryExit,
    supportY,
    cameraRule,
    summary,
    get mode() { return mode; },
    get boatId() { return boatId; },
    get rideAnchor() { return rideAnchor; },
    get diagnostics() { return diagnosticsSnapshot(); },
    counters,
    refusals,
    dispose() {
      handle?.release?.();
      mode = GDO_TRAVERSAL_MODE.DRY;
      boatId = null;
    },
  };
}
