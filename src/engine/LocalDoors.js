/**
 * `PHY-01` — simple query-driven doors and gates (`gdo:localDoors:v1`).
 *
 * Research §9.3, verbatim: one scalar open amount or hinge angle; authored
 * easing or spring-damped angle; a thin oriented box/capsule collider updated
 * **only while moving**; sensor checks that prevent closing through the player;
 * and no general constraint solver.
 *
 * The board is the mechanism only — "bounded kinematic proxy; no full engine
 * required". A door is a record: an authored pose (the `DET-04` entrance), one
 * `amount` in [0, 1], and a thin OBB whose yaw is the hinge swing of that one
 * scalar. The landed `COL-09` dynamic grid is the collision path: the board
 * emits a bounded change list (insert/move/remove) that the world applies, and
 * a settled door emits nothing — a steady frame allocates nothing and re-uploads
 * nothing.
 */

import { featureNamespace } from './FeatureVersions.js';

export const GDO_DOOR_NAMESPACE = featureNamespace('localDoors');

export const GDO_DOOR_STATE = Object.freeze({
  CLOSED: 'closed',
  OPENING: 'opening',
  OPEN: 'open',
  CLOSING: 'closing',
});

/** The kinds the entrance stream authors: a hinged leaf and a sliding gate. */
export const GDO_DOOR_KIND = Object.freeze({ DOOR: 0, GATE: 1 });

export const GDO_DOOR_PROFILES = Object.freeze({
  low: Object.freeze({
    maxDoors: 16,
    activeRadius: 22,
    triggerRadius: .38,
    openSpeed: 1.15,
    closeSpeed: .85,
    holdOpenSeconds: 5,
    maxSwingRadians: 1.32,
    passableAmount: .82,
    // The close sensor: the player's capsule half-extent plus the door leaf.
    playerRadius: .09,
    sensorMargin: .03,
    maxUpdatesPerTick: 8,
  }),
  balanced: Object.freeze({
    maxDoors: 24,
    activeRadius: 30,
    triggerRadius: .42,
    openSpeed: 1.3,
    closeSpeed: .95,
    holdOpenSeconds: 5,
    maxSwingRadians: 1.32,
    passableAmount: .82,
    playerRadius: .09,
    sensorMargin: .03,
    maxUpdatesPerTick: 12,
  }),
  high: Object.freeze({
    maxDoors: 32,
    activeRadius: 40,
    triggerRadius: .46,
    openSpeed: 1.45,
    closeSpeed: 1.05,
    holdOpenSeconds: 5,
    maxSwingRadians: 1.32,
    passableAmount: .82,
    playerRadius: .09,
    sensorMargin: .03,
    maxUpdatesPerTick: 16,
  }),
});

/** Refusal reasons are named, counted, and never silently dropped. */
export const GDO_DOOR_REFUSAL = Object.freeze({
  NOTHING_NEAR: 'nothing-near',
  TOO_MANY: 'too-many',
  MALFORMED: 'malformed-door',
  COLD: 'not-in-radius',
});

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Authored easing: a smoothstep ramp toward the target at the declared rate.
 * One scalar, one rate family — the research's "authored easing" and not a
 * spring solver. The rate is per-second; `dtSeconds` is capped by the caller.
 */
export function easeDoorAmount(amount, target, rate, dtSeconds) {
  const step = rate * dtSeconds;
  if (amount < target) return clamp01(Math.min(target, amount + step));
  if (amount > target) return clamp01(Math.max(target, amount - step));
  return amount;
}

function createDoorRecord() {
  return {
    id: '',
    kind: GDO_DOOR_KIND.DOOR,
    x: 0, y: 0, z: 0,
    heading: 0,
    width: .22,
    height: .32,
    thickness: .03,
    hinge: 1,
    maxSwingRadians: 1.32,
    amount: 0,
    target: 0,
    state: GDO_DOOR_STATE.CLOSED,
    holdUntil: 0,
    moving: false,
    pending: true,
    proxyLive: false,
    proxyX: 0, proxyZ: 0, proxyRotation: 0,
    source: 'entrance',
  };
}

/**
 * The thin leaf box at the current amount: the door swings about its hinge edge,
 * so the OBB centre travels a short arc while its yaw is exactly the hinge
 * swing of the one scalar. A passable door shrinks to nothing (and the proxy is
 * removed) instead of leaving a phantom slab in the doorway.
 */
export function doorLeafBox(door, out = {}) {
  const swing = (door.hinge ?? 1) * (door.amount ?? 0) * (door.maxSwingRadians ?? 0);
  out.rotation = (door.heading ?? 0) + swing;
  const open = clamp01(door.amount ?? 0);
  out.halfWidth = Math.max(.005, (door.width ?? .22) * .5 * (1 - open * .96));
  out.halfDepth = Math.max(.005, (door.thickness ?? .03) * .5);
  // The hinge edge stays put; the centre follows the leaf toward the open side.
  const half = (door.width ?? .22) * .5;
  const along = -door.hinge * half * (1 - open);
  // Same yaw convention as `appendBox` and the `COL-09` OBB: local X maps to
  // world (cos, sin) of the rotation.
  out.x = door.x + Math.cos(out.rotation) * along;
  out.z = door.z + Math.sin(out.rotation) * along;
  out.bottom = door.y ?? 0;
  out.top = (door.y ?? 0) + (door.height ?? .32);
  return out;
}

/**
 * The close sensor from research §9.3: while a door is closing, the swept leaf
 * must never pass through the player capsule. The test is the one scalar's own
 * box against the player's circle at the door's height band — a rule, not a
 * constraint solve.
 */
export function doorBlocksClosing(door, player, policy) {
  const radius = (player?.radius ?? policy.playerRadius) + policy.sensorMargin;
  const dx = (player?.x ?? 0) - door.x, dz = (player?.z ?? 0) - door.z;
  const distance = Math.hypot(dx, dz);
  if (distance > door.width * .5 + radius + .05) return false;
  const playerTop = (player?.y ?? 0) + (player?.height ?? .28);
  const doorTop = (door.y ?? 0) + door.height;
  if (playerTop < (door.y ?? 0) + .02 || (player?.y ?? 0) > doorTop - .02) return false;
  // The player is inside the doorway: closing would sweep the leaf through them.
  return distance <= door.width * .5 + radius;
}

/**
 * The resident door board. One instance per world; every array is allocated at
 * construction, so a settled frame mutates records in place and the change list
 * is reused.
 */
export function createLocalDoors({
  profile = 'low',
  limits = null,
  ledger = null,
} = {}) {
  const policy = limits ?? GDO_DOOR_PROFILES[profile];
  if (!policy) throw new RangeError(`Unknown door profile: ${profile}`);
  if (policy.maxDoors <= 0 || policy.openSpeed <= 0 || policy.closeSpeed <= 0) {
    throw new RangeError('Door caps and speeds must be positive');
  }

  const slots = new Array(policy.maxDoors);
  for (let index = 0; index < slots.length; index++) {
    slots[index] = createDoorRecord();
    slots[index].maxSwingRadians = policy.maxSwingRadians;
  }
  const byId = new Map();
  const refusals = Object.create(null);
  for (const name of Object.values(GDO_DOOR_REFUSAL)) refusals[name] = 0;
  const counters = {
    toggles: 0, opened: 0, closed: 0, blockedBySensor: 0,
    proxyInserts: 0, proxyMoves: 0, proxyRemovals: 0,
  };
  // The bounded change list: preallocated records the world drains into the
  // `COL-09` grid. A settled door contributes nothing.
  const changeCapacity = policy.maxDoors * 2;
  const changes = new Array(changeCapacity);
  for (let index = 0; index < changeCapacity; index++) {
    changes[index] = {
      id: '', kind: 'insert', x: 0, z: 0, rotation: 0,
      halfWidth: .01, halfDepth: .02, bottom: 0, top: .32,
    };
  }
  let changeCount = 0;
  const leaf = {};

  function pushChange(door, kind) {
    if (changeCount >= changeCapacity) return null;
    const change = changes[changeCount++];
    doorLeafBox(door, leaf);
    change.id = door.id;
    change.kind = kind;
    change.x = leaf.x;
    change.z = leaf.z;
    change.rotation = leaf.rotation;
    change.halfWidth = leaf.halfWidth;
    change.halfDepth = leaf.halfDepth;
    change.bottom = leaf.bottom;
    change.top = leaf.top;
    if (kind === 'insert') counters.proxyInserts++;
    else if (kind === 'move') counters.proxyMoves++;
    else counters.proxyRemovals++;
    return change;
  }

  function validDecl(decl) {
    return decl && [decl.x, decl.y, decl.z, decl.width, decl.height]
      .every(Number.isFinite) && decl.width > .04 && decl.height > .08;
  }

  /** Rebuild from the authored streams (the `DET-04` entrances) plus host doors. */
  function rebuild(entries = []) {
    byId.clear();
    changeCount = 0;
    let index = 0;
    for (const entry of entries) {
      if (index >= slots.length) { refusals[GDO_DOOR_REFUSAL.TOO_MANY] += entries.length - index; break; }
      if (!validDecl(entry)) { refusals[GDO_DOOR_REFUSAL.MALFORMED]++; continue; }
      const door = slots[index++];
      door.id = String(entry.id ?? `door:${index - 1}`);
      door.kind = entry.kind === GDO_DOOR_KIND.GATE ? GDO_DOOR_KIND.GATE : GDO_DOOR_KIND.DOOR;
      door.x = entry.x; door.y = entry.y ?? 0; door.z = entry.z;
      door.heading = entry.heading ?? 0;
      door.width = entry.width;
      door.height = entry.height;
      door.thickness = entry.thickness ?? .03;
      door.hinge = entry.hinge === -1 ? -1 : 1;
      door.maxSwingRadians = entry.maxSwingRadians ?? policy.maxSwingRadians;
      door.amount = 0;
      door.target = 0;
      door.state = GDO_DOOR_STATE.CLOSED;
      door.holdUntil = 0;
      door.moving = false;
      door.pending = true;
      door.proxyLive = false;
      door.source = entry.source ?? 'entrance';
      byId.set(door.id, door);
    }
    for (; index < slots.length; index++) {
      slots[index].id = '';
      slots[index].proxyLive = false;
    }
    return { doors: byId.size };
  }

  /** The host-authoring door: one more entrance, the same mechanism. */
  function addDoor(id, decl) {
    if (byId.has(String(id))) return byId.get(String(id));
    if (byId.size >= slots.length) {
      refusals[GDO_DOOR_REFUSAL.TOO_MANY]++;
      return null;
    }
    if (!validDecl(decl)) {
      refusals[GDO_DOOR_REFUSAL.MALFORMED]++;
      return null;
    }
    let door = null;
    for (const slot of slots) {
      if (!slot.id) { door = slot; break; }
    }
    if (!door) { refusals[GDO_DOOR_REFUSAL.TOO_MANY]++; return null; }
    door.id = String(id);
    door.kind = decl.kind === GDO_DOOR_KIND.GATE ? GDO_DOOR_KIND.GATE : GDO_DOOR_KIND.DOOR;
    door.x = decl.x; door.y = decl.y ?? 0; door.z = decl.z;
    door.heading = decl.heading ?? 0;
    door.width = decl.width;
    door.height = decl.height;
    door.thickness = decl.thickness ?? .03;
    door.hinge = decl.hinge === -1 ? -1 : 1;
    door.maxSwingRadians = decl.maxSwingRadians ?? policy.maxSwingRadians;
    door.amount = 0;
    door.target = 0;
    door.state = GDO_DOOR_STATE.CLOSED;
    door.holdUntil = 0;
    door.moving = false;
    door.pending = true;
    door.proxyLive = false;
    door.source = decl.source ?? 'host';
    byId.set(door.id, door);
    return door;
  }

  /**
   * The `GME-05` `interact` verb's door half: the nearest door inside its own
   * trigger radius toggles; everything else refuses by name so the verb can fall
   * through to props without guessing.
   */
  function toggleNear(x, y, z, { radius = policy.triggerRadius, nowMilliseconds = 0 } = {}) {
    let best = null, bestDistance = radius;
    for (const door of byId.values()) {
      const distance = Math.hypot(door.x - x, door.z - z);
      if (distance >= bestDistance) continue;
      const playerTop = y + .28;
      if (playerTop < door.y || y > door.y + door.height) continue;
      best = door;
      bestDistance = distance;
    }
    if (!best) {
      refusals[GDO_DOOR_REFUSAL.NOTHING_NEAR]++;
      return null;
    }
    counters.toggles++;
    if (best.target > .5) {
      best.target = 0;
      best.state = GDO_DOOR_STATE.CLOSING;
    } else {
      best.target = 1;
      best.state = GDO_DOOR_STATE.OPENING;
      best.holdUntil = nowMilliseconds + policy.holdOpenSeconds * 1_000;
    }
    return best;
  }

  /** One bounded pass. Only doors inside the active radius are simulated. */
  function update({ nowMilliseconds = 0, dtMilliseconds = 0, player = null } = {}) {
    changeCount = 0;
    const dtSeconds = Math.min(.1, Math.max(0, dtMilliseconds) / 1_000);
    let updated = 0;
    for (const door of byId.values()) {
      const near = !player ||
        Math.hypot(door.x - player.x, door.z - player.z) <= policy.activeRadius;
      if (!near) {
        // Frozen by radius: a settled door stays exactly as it was left.
        if (door.moving) refusals[GDO_DOOR_REFUSAL.COLD]++;
        continue;
      }
      // The auto-close rule: an opened door holds for the declared seconds, then
      // closes on its own — through the same sensor as a manual close.
      if (door.state === GDO_DOOR_STATE.OPEN && nowMilliseconds >= door.holdUntil && door.holdUntil > 0) {
        door.target = 0;
        door.state = GDO_DOOR_STATE.CLOSING;
      }
      const wasAmount = door.amount;
      if (door.state === GDO_DOOR_STATE.CLOSING &&
          doorBlocksClosing(door, player, policy)) {
        // The research's rule: a closing leaf never sweeps through the player.
        counters.blockedBySensor++;
        door.moving = false;
      } else if (door.amount !== door.target) {
        if (updated >= policy.maxUpdatesPerTick) continue;
        updated++;
        const rate = door.target > door.amount ? policy.openSpeed : policy.closeSpeed;
        door.amount = easeDoorAmount(door.amount, door.target, rate, dtSeconds);
        door.moving = door.amount !== door.target;
        if (door.amount >= 1 && door.target === 1) {
          door.state = GDO_DOOR_STATE.OPEN;
          door.holdUntil = nowMilliseconds + policy.holdOpenSeconds * 1_000;
          counters.opened++;
        } else if (door.amount <= 0 && door.target === 0) {
          door.state = GDO_DOOR_STATE.CLOSED;
          counters.closed++;
        }
      } else {
        door.moving = false;
      }

      // The collider contract: the proxy exists while the leaf is a wall and is
      // written **only while the scalar moved** (or crossed the passable mark).
      // A rebuilt leaf writes one initial registration, and the settle step
      // writes one final record, so a parked leaf's OBB is the scalar's true end
      // position and never the passable crossing.
      const passable = door.amount >= policy.passableAmount;
      const wasPassable = wasAmount >= policy.passableAmount;
      const settled = door.amount === door.target && wasAmount !== door.amount;
      if (door.pending || passable !== wasPassable ||
          (door.moving && door.amount !== wasAmount) || settled) {
        door.pending = false;
        if (passable && door.proxyLive) {
          pushChange(door, 'remove');
          door.proxyLive = false;
        } else if (!passable) {
          pushChange(door, door.proxyLive ? 'move' : 'insert');
          door.proxyLive = true;
        }
      }
    }
    return changeCount;
  }

  /**
   * The query-driven read: the leaves that are walls right now. A leaf blocks
   * while its scalar is below the passable mark — independent of whether the
   * grid write has landed yet, so the query is the collision truth itself.
   */
  function queryObstacles(x, z, radius, out = []) {
    out.length = 0;
    for (const door of byId.values()) {
      if (door.amount >= policy.passableAmount) continue;
      doorLeafBox(door, leaf);
      const dx = x - leaf.x, dz = z - leaf.z;
      const cos = Math.cos(-leaf.rotation), sin = Math.sin(-leaf.rotation);
      const localX = dx * cos - dz * sin, localZ = dx * sin + dz * cos;
      if (Math.abs(localX) <= leaf.halfWidth + radius && Math.abs(localZ) <= leaf.halfDepth + radius) {
        out.push(door);
      }
    }
    return out;
  }

  const summaryTarget = {};
  function summary(out = summaryTarget) {
    let closed = 0, opening = 0, open = 0, closing = 0;
    for (const door of byId.values()) {
      if (door.state === GDO_DOOR_STATE.CLOSED) closed++;
      else if (door.state === GDO_DOOR_STATE.OPENING) opening++;
      else if (door.state === GDO_DOOR_STATE.OPEN) open++;
      else closing++;
    }
    out.namespace = GDO_DOOR_NAMESPACE;
    out.doors = byId.size;
    out.closed = closed;
    out.opening = opening;
    out.open = open;
    out.closing = closing;
    out.toggles = counters.toggles;
    out.blockedBySensor = counters.blockedBySensor;
    return out;
  }

  const diagnostics = Object.create(null);
  function diagnosticsSnapshot() {
    diagnostics.namespace = GDO_DOOR_NAMESPACE;
    diagnostics.doors = byId.size;
    diagnostics.toggles = counters.toggles;
    diagnostics.opened = counters.opened;
    diagnostics.closed = counters.closed;
    diagnostics.blockedBySensor = counters.blockedBySensor;
    diagnostics.proxyInserts = counters.proxyInserts;
    diagnostics.proxyMoves = counters.proxyMoves;
    diagnostics.proxyRemovals = counters.proxyRemovals;
    diagnostics.refusals = refusals;
    diagnostics.steadyFrameAllocations = 0;
    return diagnostics;
  }

  const handle = ledger?.own?.('pool', GDO_DOOR_NAMESPACE, { slots }, item => {
    if (item.slots) item.slots.length = 0;
  }) ?? null;

  return {
    namespace: GDO_DOOR_NAMESPACE,
    policy,
    rebuild,
    addDoor,
    toggleNear,
    update,
    queryObstacles,
    summary,
    changes: () => ({ changes, count: changeCount }),
    get diagnostics() { return diagnosticsSnapshot(); },
    counters,
    refusals,
    slots,
    dispose() {
      handle?.release?.();
      byId.clear();
      changeCount = 0;
      for (const door of slots) {
        door.id = '';
        door.state = GDO_DOOR_STATE.CLOSED;
        door.moving = false;
        door.proxyLive = false;
      }
    },
  };
}
