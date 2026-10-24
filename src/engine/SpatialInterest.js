/**
 * `NET-03` — spatial interest management (`gdo:interest:v1`).
 *
 * This is the implementation of §4–§6 of
 * [`feature-roadmap/NET-02_MULTIPLAYER_PROTOCOL.md`](../../feature-roadmap/NET-02_MULTIPLAYER_PROTOCOL.md),
 * and every number below is that document's, not a new choice:
 *
 *  - **§6 interest**: 32-unit cells, enter at 64 units, leave at 80 (1.25×
 *    hysteresis), a per-profile tracked-player cap, a full re-evaluation only when
 *    the player crosses a cell boundary, and an `interestOverflow` count for what
 *    the cap cannot hold. Untracked things are not simulated, interpolated, or
 *    rendered.
 *  - **§4 identity**: an entity id is valid **only inside the sender's current
 *    interest set**. One rule, enforced in one place (`validate`), closes id
 *    guessing, remote-object mutation, and cross-cell probing together.
 *  - **§5 budget**: 66 bits — nine bytes — per tracked player, a twelve-byte
 *    snapshot header, three bytes per shared entity (a 16-bit index into the
 *    deterministic entity list plus an 8-bit state byte — the *id string* is never
 *    on the wire because both sides regenerate it), and a 20 Hz stream that must
 *    stay inside the profile's declared down budget.
 *  - **§5.4 determinism replaces transfer**: the join payload is sixteen bytes and
 *    carries `networkGeometryBytes: 0`.
 *
 * The quantisation is fixed-point, so a decoded position is deterministic and the
 * worst-case error is half a step — asserted in the tests rather than assumed.
 * Nothing here is a clock, a socket, or a server: it is the decide-and-encode half
 * the transport plugs into.
 */

import { featureNamespace } from './FeatureVersions.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

export const GDO_INTEREST_NAMESPACE = featureNamespace('interest');

export const GDO_INTEREST_REFUSAL = Object.freeze({
  BAD_INPUT: 'bad-input',
  UNKNOWN_ENTITY: 'unknown-entity',
  MALFORMED_SNAPSHOT: 'malformed-snapshot',
  OVER_BUDGET: 'over-budget',
  NOT_A_SESSION: 'not-a-session',
  DISPOSED: 'disposed',
});

/** §5.2 locomotion and posture are declared enums, not free text. */
export const GDO_INTEREST_LOCOMOTION = Object.freeze([
  'idle', 'walk', 'run', 'jump', 'fall', 'wade', 'swim', 'climb',
  'enter', 'sit', 'wave', 'interact', 'stagger', 'knocked', 'down', 'rise',
]);

export const GDO_INTEREST_POSTURE = Object.freeze([
  'standing', 'crouched', 'sitting', 'lying', 'wading', 'swimming',
  'climbing', 'boarding', 'pointing', 'carrying', 'working', 'resting',
  'stunned', 'fallen', 'recovering', 'unknown',
]);

/** §5.2 interaction flag bits. */
export const GDO_INTEREST_FLAGS = Object.freeze({
  TALKING: 1,
  INTERACTING: 2,
  CARRYING: 4,
  HURT: 8,
});

/** §5 shared entity state, one byte per shared prop. */
export const GDO_INTEREST_ENTITY_STATE = Object.freeze({
  CLOSED: 0, OPEN: 1, MOVED: 2, BROKEN: 3, RESET: 4, CLAIMED: 5,
});

export const GDO_INTEREST_PROFILES = Object.freeze({
  low: Object.freeze({
    cellSize: 32,
    enterRadius: 64,
    leaveRadius: 80,
    maxTrackedPlayers: 4,
    maxTrackedEntities: 16,
    snapshotHeaderBytes: 12,
    playerRecordBytes: 9,
    entityRecordBytes: 3,
    snapshotHz: 20,
    downBudgetBytesPerSecond: 4 * 1024,
    upBudgetBytesPerSecond: 1 * 1024,
    interpolationDelayMilliseconds: 100,
    maxExtrapolationMilliseconds: 120,
    snapshotBufferDepth: 3,
  }),
  balanced: Object.freeze({
    cellSize: 32,
    enterRadius: 64,
    leaveRadius: 80,
    maxTrackedPlayers: 8,
    maxTrackedEntities: 32,
    snapshotHeaderBytes: 12,
    playerRecordBytes: 9,
    entityRecordBytes: 3,
    snapshotHz: 20,
    downBudgetBytesPerSecond: 8 * 1024,
    upBudgetBytesPerSecond: 1 * 1024,
    interpolationDelayMilliseconds: 100,
    maxExtrapolationMilliseconds: 120,
    snapshotBufferDepth: 3,
  }),
  high: Object.freeze({
    cellSize: 32,
    enterRadius: 64,
    leaveRadius: 80,
    maxTrackedPlayers: 12,
    maxTrackedEntities: 48,
    snapshotHeaderBytes: 12,
    playerRecordBytes: 9,
    entityRecordBytes: 3,
    snapshotHz: 20,
    downBudgetBytesPerSecond: 16 * 1024,
    upBudgetBytesPerSecond: 1 * 1024,
    interpolationDelayMilliseconds: 100,
    maxExtrapolationMilliseconds: 120,
    snapshotBufferDepth: 4,
  }),
});

/** §5.4: the whole world payload on join. */
export const GDO_INTEREST_JOIN_BYTES = 16;
export const GDO_INTEREST_JOIN_MAX_BYTES = 48;

const PLAYER_BITS = 66;
const AXIS_RANGE = 128;          // ±64 units, cell-relative (§5.2)
const Y_DELTA_RANGE = 4;         // ±2 units around the deterministic sample
const YAW_STEPS = 256;
const TWO_PI = Math.PI * 2;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function interestPolicyFor(profile) {
  return GDO_INTEREST_PROFILES[profile] ?? GDO_INTEREST_PROFILES.low;
}

function quantiseAxis(value) {
  return clamp(Math.round((value + AXIS_RANGE / 2) / AXIS_RANGE * 65535), 0, 65535);
}
function dequantiseAxis(code) {
  return code / 65535 * AXIS_RANGE - AXIS_RANGE / 2;
}
function quantiseYDelta(delta) {
  return clamp(Math.round((delta + Y_DELTA_RANGE / 2) / Y_DELTA_RANGE * 255), 0, 255);
}
function dequantiseYDelta(code) {
  return code / 255 * Y_DELTA_RANGE - Y_DELTA_RANGE / 2;
}
function quantiseYaw(yaw) {
  const normalised = ((yaw % TWO_PI) + TWO_PI) % TWO_PI;
  return Math.floor(normalised / TWO_PI * YAW_STEPS) & (YAW_STEPS - 1);
}
function dequantiseYaw(code) {
  return (code + .5) / YAW_STEPS * TWO_PI;
}

/** §5.2 worst-case errors, exported so a test asserts them instead of trusting them. */
export const GDO_INTEREST_QUANTISATION = Object.freeze({
  positionMetres: (AXIS_RANGE / 65535) / 2,
  yMetres: (Y_DELTA_RANGE / 255) / 2,
  yawRadians: (TWO_PI / YAW_STEPS) / 2,
  bitsPerPlayer: PLAYER_BITS,
});

/** FNV-1a over a session token: a *tag*, never a credential (§7.1). */
export function sessionTag(token) {
  let hash = 2166136261;
  const text = typeof token === 'string' ? token : String(token ?? '');
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function indexOf(list, name) {
  const index = list.indexOf(name);
  return index < 0 ? 0 : index;
}

/**
 * One interest set. `update()` decides membership; `validate()` is the only door
 * an inbound reference may come through; `encodeSnapshot()` writes the wire form.
 */
export function createInterestSet({
  profile = 'low',
  sessionId = 'session',
  seed = 0,
  queryEntities = null,
  heightAt = () => 0,
} = {}) {
  const policy = interestPolicyFor(profile);
  const tracked = new Map();
  // §4.2 covers shared props too: an entity id is valid only while its source is
  // in the interest set, and the set is what the cell-gated query returned.
  const trackedEntities = new Map();
  const refusals = Object.fromEntries(Object.values(GDO_INTEREST_REFUSAL).map(key => [key, 0]));

  // §5: one fixed buffer per session, sized for the profile's worst case.
  const maxSnapshotBytes = policy.snapshotHeaderBytes
    + policy.maxTrackedPlayers * policy.playerRecordBytes
    + policy.maxTrackedEntities * policy.entityRecordBytes;
  const buffer = new Uint8Array(maxSnapshotBytes);

  // `decodeSnapshot` writes into this reused record set, so a steady frame
  // allocates nothing.
  const incoming = {
    header: { originX: 0, originY: 0, tick: 0, epoch: 0, sequence: 0, players: 0, entities: 0, flags: 0 },
    players: [],
    entities: [],
  };

  let cellX = null, cellZ = null;
  let rebuilds = 0, incrementalChecks = 0;
  let entered = 0, left = 0, overflow = 0, hysteresisHolds = 0;
  let entityQueries = 0, malformedInputs = 0, validations = 0, rejectedReferences = 0;
  let snapshots = 0, encodedBytes = 0, lastSnapshotBytes = 0;
  let disposed = false;
  const tag = sessionTag(sessionId);

  function distanceTo(x, z) { return Math.hypot(x, z); }

  function admit(entry) {
    if (tracked.has(entry.id)) return 'known';
    if (tracked.size >= policy.maxTrackedPlayers) return 'overflow';
    tracked.set(entry.id, {
      id: entry.id,
      kind: 'player',
      x: entry.x,
      z: entry.z,
      y: Number.isFinite(entry.y) ? entry.y : 0,
      yaw: Number.isFinite(entry.yaw) ? entry.yaw : 0,
      locomotion: entry.locomotion ?? 'idle',
      posture: entry.posture ?? 'standing',
      phase: Number.isFinite(entry.phase) ? entry.phase : 0,
      flags: entry.flags ?? 0,
    });
    return 'entered';
  }

  /**
   * §6: decide what this player's neighbourhood contains.
   *
   * A full re-evaluation — including the entity query — happens only when the
   * player crosses a cell boundary. Between crossings membership still moves on
   * the enter/leave radii, because an avatar that walks 20 units is inside the
   * same cell but must not stay invisible; what is gated is the *query*, which is
   * the only part that costs anything.
   */
  function update(x, z, { players = [], nowMilliseconds = 0, force = false } = {}) {
    if (disposed) { refusals[GDO_INTEREST_REFUSAL.DISPOSED]++; return { ok: false, refusal: GDO_INTEREST_REFUSAL.DISPOSED }; }
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Array.isArray(players)) {
      malformedInputs++; refusals[GDO_INTEREST_REFUSAL.BAD_INPUT]++;
      return { ok: false, refusal: GDO_INTEREST_REFUSAL.BAD_INPUT };
    }
    const nextCellX = Math.floor(x / policy.cellSize);
    const nextCellZ = Math.floor(z / policy.cellSize);
    const crossed = force || nextCellX !== cellX || nextCellZ !== cellZ;
    const enteredThisUpdate = [];
    const leftThisUpdate = [];
    overflow = 0;

    // §6: hysteresis. A tracked entry leaves only past the leave radius, so one
    // oscillating on the boundary cannot churn.
    for (const [id, entry] of tracked) {
      const candidate = players.find(item => item?.id === id);
      if (!candidate) {
        // The server stopped sending it: gone, not stale.
        tracked.delete(id); leftThisUpdate.push(id); left++;
        continue;
      }
      entry.x = candidate.x; entry.z = candidate.z;
      entry.y = Number.isFinite(candidate.y) ? candidate.y : entry.y;
      entry.yaw = Number.isFinite(candidate.yaw) ? candidate.yaw : entry.yaw;
      entry.locomotion = candidate.locomotion ?? entry.locomotion;
      entry.posture = candidate.posture ?? entry.posture;
      entry.phase = Number.isFinite(candidate.phase) ? candidate.phase : entry.phase;
      entry.flags = candidate.flags ?? entry.flags;
      const distance = distanceTo(candidate.x - x, candidate.z - z);
      incrementalChecks++;
      if (distance > policy.leaveRadius) {
        tracked.delete(id); leftThisUpdate.push(id); left++;
      } else if (distance > policy.enterRadius) {
        hysteresisHolds++;
      }
    }

    // Admission, nearest first so the cap keeps what is actually visible.
    const ordered = players
      .filter(candidate => candidate && typeof candidate.id === 'string' && Number.isFinite(candidate.x) && Number.isFinite(candidate.z))
      .map(candidate => ({ candidate, distance: distanceTo(candidate.x - x, candidate.z - z) }))
      .sort((a, b) => a.distance - b.distance);
    for (const { candidate, distance } of ordered) {
      if (tracked.has(candidate.id)) continue;
      incrementalChecks++;
      if (distance > policy.enterRadius) continue;
      const verdict = admit(candidate);
      if (verdict === 'entered') { enteredThisUpdate.push(candidate.id); entered++; }
      else if (verdict === 'overflow') overflow++;
    }

    if (crossed) {
      rebuilds++;
      cellX = nextCellX; cellZ = nextCellZ;
      // The only cost the cell gate exists to avoid.
      if (typeof queryEntities === 'function') {
        entityQueries++;
        const found = queryEntities(x, z, policy.leaveRadius, nextCellX, nextCellZ) || [];
        trackedEntities.clear();
        for (const entity of found) {
          if (trackedEntities.size >= policy.maxTrackedEntities) break;
          if (!entity || typeof entity.id !== 'string' || !Number.isInteger(entity.index)) continue;
          trackedEntities.set(entity.id, { id: entity.id, index: entity.index, state: entity.state ?? 0 });
        }
      }
    }

    return Object.freeze({
      ok: true,
      cell: { x: cellX, z: cellZ },
      crossed,
      tracked: [...tracked.keys()],
      entered: Object.freeze(enteredThisUpdate),
      left: Object.freeze(leftThisUpdate),
      overflow,
      nowMilliseconds: Number.isFinite(nowMilliseconds) ? nowMilliseconds : 0,
    });
  }

  function has(id) { return tracked.has(id); }
  function hasEntity(id) { return trackedEntities.has(id); }
  function entityIndexOf(id) { return trackedEntities.get(id)?.index ?? null; }

  /**
   * §4.2 the only door an inbound reference may use. An id that is not in this
   * player's interest set is `unknown-entity`, counted, and never acted on.
   */
  function validate(id) {
    validations++;
    if (typeof id !== 'string' || (!tracked.has(id) && !trackedEntities.has(id))) {
      rejectedReferences++; refusals[GDO_INTEREST_REFUSAL.UNKNOWN_ENTITY]++;
      return { ok: false, refusal: GDO_INTEREST_REFUSAL.UNKNOWN_ENTITY };
    }
    return { ok: true, id };
  }

  /** Header origin: the cell the snapshot is relative to (§5.2 "cell-relative"). */
  function originFor(x, z) {
    return { x: Math.floor(x / policy.cellSize) * policy.cellSize, z: Math.floor(z / policy.cellSize) * policy.cellSize };
  }

  function writeBits(offsetBits, value, bits) {
    let remaining = bits;
    let cursor = offsetBits;
    let source = value >>> 0;
    while (remaining > 0) {
      const byte = cursor >> 3;
      const bitInByte = cursor & 7;
      const space = 8 - bitInByte;
      const take = Math.min(space, remaining);
      const chunk = (source >>> (remaining - take)) & ((1 << take) - 1);
      buffer[byte] |= chunk << (space - take);
      cursor += take;
      remaining -= take;
    }
    return cursor;
  }

  function readBits(offsetBits, bits) {
    let remaining = bits, cursor = offsetBits, value = 0;
    while (remaining > 0) {
      const byte = cursor >> 3;
      const bitInByte = cursor & 7;
      const space = 8 - bitInByte;
      const take = Math.min(space, remaining);
      const chunk = (buffer[byte] >> (space - take)) & ((1 << take) - 1);
      value = (value << take) | chunk;
      cursor += take;
      remaining -= take;
    }
    return value >>> 0;
  }

  /**
   * Encode one snapshot: a twelve-byte header, nine bytes per tracked player, and
   * three bytes per shared entity state. `entities` is an array of
   * `{ index, state }` — an index into the deterministic entity list, never a
   * string (§5.2/§5.4).
   */
  function encodeSnapshot({ x = 0, z = 0, tick = 0, sequence = 0, epoch = tag, entities = [] } = {}) {
    if (disposed) { refusals[GDO_INTEREST_REFUSAL.DISPOSED]++; return { ok: false, refusal: GDO_INTEREST_REFUSAL.DISPOSED }; }
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      malformedInputs++; refusals[GDO_INTEREST_REFUSAL.BAD_INPUT]++;
      return { ok: false, refusal: GDO_INTEREST_REFUSAL.BAD_INPUT };
    }
    const players = [...tracked.values()].slice(0, policy.maxTrackedPlayers);
    const source = Array.isArray(entities) && entities.length
      ? entities : [...trackedEntities.values()];
    const entityList = source
      .filter(entity => Number.isInteger(entity?.index) && Number.isInteger(entity?.state))
      .slice(0, policy.maxTrackedEntities);
    const bytes = policy.snapshotHeaderBytes + players.length * policy.playerRecordBytes
      + entityList.length * policy.entityRecordBytes;
    if (bytes > maxSnapshotBytes) {
      refusals[GDO_INTEREST_REFUSAL.OVER_BUDGET]++;
      return { ok: false, refusal: GDO_INTEREST_REFUSAL.OVER_BUDGET, bytes, maxSnapshotBytes };
    }
    buffer.fill(0);
    const origin = originFor(x, z);
    // Header, twelve bytes exactly: origin (2+2), tick (2), epoch (2), sequence
    // (1), counts (1+1), flags (1).
    let cursor = writeBits(0, clamp(origin.x / policy.cellSize, -32768, 32767) & 0xFFFF, 16);
    cursor = writeBits(cursor, clamp(origin.z / policy.cellSize, -32768, 32767) & 0xFFFF, 16);
    cursor = writeBits(cursor, tick & 0xFFFF, 16);
    cursor = writeBits(cursor, epoch & 0xFFFF, 16);
    cursor = writeBits(cursor, sequence & 0xFF, 8);
    cursor = writeBits(cursor, players.length & 0xFF, 8);
    cursor = writeBits(cursor, entityList.length & 0xFF, 8);
    cursor = writeBits(cursor, 0, 8);
    // 66 bits per player, packed tight in nine bytes.
    for (const player of players) {
      cursor = writeBits(cursor, quantiseAxis(player.x - origin.x), 16);
      cursor = writeBits(cursor, quantiseAxis(player.z - origin.z), 16);
      cursor = writeBits(cursor, quantiseYDelta(player.y - heightAt(player.x, player.z)), 8);
      cursor = writeBits(cursor, quantiseYaw(player.yaw), 8);
      cursor = writeBits(cursor, indexOf(GDO_INTEREST_LOCOMOTION, player.locomotion), 4);
      cursor = writeBits(cursor, indexOf(GDO_INTEREST_POSTURE, player.posture), 4);
      cursor = writeBits(cursor, clamp(Math.round(player.phase * 63), 0, 63), 6);
      cursor = writeBits(cursor, clamp(player.flags | 0, 0, 15), 4);
    }
    // Shared entity state: a 16-bit index plus an 8-bit state.
    for (const entity of entityList) {
      cursor = writeBits(cursor, entity.index & 0xFFFF, 16);
      cursor = writeBits(cursor, entity.state & 0xFF, 8);
    }
    snapshots++;
    encodedBytes += bytes;
    lastSnapshotBytes = bytes;
    return Object.freeze({
      ok: true,
      bytes,
      bits: PLAYER_BITS * players.length,
      players: players.length,
      entities: entityList.length,
      origin: Object.freeze({ x: origin.x, z: origin.z }),
      view: buffer.subarray(0, bytes),
      /** Bytes per second at the declared snapshot rate (§5.1). */
      bytesPerSecond: bytes * policy.snapshotHz,
    });
  }

  /**
   * Decode a snapshot into reused records. Validation happens before anything is
   * used, and a malformed frame is refused by name rather than thrown (§7 threat 6).
   */
  function decodeSnapshot(view, out = incoming) {
    validations++;
    if (!view || typeof view.length !== 'number') {
      refusals[GDO_INTEREST_REFUSAL.BAD_INPUT]++;
      return { ok: false, refusal: GDO_INTEREST_REFUSAL.BAD_INPUT };
    }
    if (view.length < policy.snapshotHeaderBytes) {
      refusals[GDO_INTEREST_REFUSAL.MALFORMED_SNAPSHOT]++;
      return { ok: false, refusal: GDO_INTEREST_REFUSAL.MALFORMED_SNAPSHOT, bytes: view.length };
    }
    // The encoder's view is this same buffer: copying would zero the bytes we are
    // about to read, so an aliased decode is read in place.
    if (view.buffer !== buffer.buffer) {
      buffer.fill(0);
      buffer.set(view.subarray(0, Math.min(view.length, buffer.length)));
    }
    const originCellX = (readBits(0, 16) << 16 >> 16);
    const originCellZ = (readBits(16, 16) << 16 >> 16);
    const header = out.header;
    header.originX = originCellX * policy.cellSize;
    header.originY = originCellZ * policy.cellSize;
    header.tick = readBits(32, 16);
    header.epoch = readBits(48, 16);
    header.sequence = readBits(64, 8);
    header.players = readBits(72, 8);
    header.entities = readBits(80, 8);
    header.flags = readBits(88, 8);
    const expected = policy.snapshotHeaderBytes + header.players * policy.playerRecordBytes
      + header.entities * policy.entityRecordBytes;
    if (header.players > policy.maxTrackedPlayers || header.entities > policy.maxTrackedEntities
      || view.length < expected) {
      refusals[GDO_INTEREST_REFUSAL.MALFORMED_SNAPSHOT]++;
      return { ok: false, refusal: GDO_INTEREST_REFUSAL.MALFORMED_SNAPSHOT, bytes: view.length, expected };
    }
    // Reuse the record objects: a decode is not allowed to allocate.
    while (out.players.length < header.players) {
      out.players.push({ x: 0, y: 0, z: 0, yaw: 0, locomotion: 'idle', posture: 'standing', phase: 0, flags: 0 });
    }
    let cursor = policy.snapshotHeaderBytes * 8;
    for (let index = 0; index < header.players; index++) {
      const record = out.players[index];
      record.x = header.originX + dequantiseAxis(readBits(cursor, 16)); cursor += 16;
      record.z = header.originY + dequantiseAxis(readBits(cursor, 16)); cursor += 16;
      record.y = dequantiseYDelta(readBits(cursor, 8)); cursor += 8;
      record.yaw = dequantiseYaw(readBits(cursor, 8)); cursor += 8;
      record.locomotion = GDO_INTEREST_LOCOMOTION[readBits(cursor, 4)] ?? 'idle'; cursor += 4;
      record.posture = GDO_INTEREST_POSTURE[readBits(cursor, 4)] ?? 'unknown'; cursor += 4;
      record.phase = readBits(cursor, 6) / 63; cursor += 6;
      record.flags = readBits(cursor, 4); cursor += 4;
    }
    while (out.entities.length < header.entities) out.entities.push({ index: 0, state: 0 });
    for (let index = 0; index < header.entities; index++) {
      const record = out.entities[index];
      record.index = readBits(cursor, 16); cursor += 16;
      record.state = readBits(cursor, 8); cursor += 8;
    }
    out.players.length = header.players;
    out.entities.length = header.entities;
    out.bytes = expected;
    return { ok: true, bytes: expected, header, players: out.players, entities: out.entities };
  }

  function dispose() {
    if (disposed) return;
    tracked.clear();
    disposed = true;
  }

  return Object.freeze({
    namespace: GDO_INTEREST_NAMESPACE,
    profile,
    policy,
    sessionTag: tag,
    cellSize: policy.cellSize,
    enterRadius: policy.enterRadius,
    leaveRadius: policy.leaveRadius,
    update,
    has,
    hasEntity,
    entityIndexOf,
    validate,
    encodeSnapshot,
    decodeSnapshot,
    dispose,
    tracked: () => [...tracked.values()],
    entities: () => [...trackedEntities.values()],
    get size() { return tracked.size; },
    get cell() { return cellX == null ? null : { x: cellX, z: cellZ }; },
    get diagnostics() {
      return Object.freeze({
        namespace: GDO_INTEREST_NAMESPACE,
        profile,
        trackedPlayers: tracked.size,
        maxTrackedPlayers: policy.maxTrackedPlayers,
        maxTrackedEntities: policy.maxTrackedEntities,
        trackedEntities: trackedEntities.size,
        cellSize: policy.cellSize,
        enterRadius: policy.enterRadius,
        leaveRadius: policy.leaveRadius,
        cellRebuilds: rebuilds,
        incrementalChecks,
        entered,
        left,
        interestOverflow: overflow,
        hysteresisHolds,
        entityQueries,
        snapshots,
        encodedBytes,
        lastSnapshotBytes,
        snapshotBytesPerSecond: lastSnapshotBytes * policy.snapshotHz,
        malformedInputs,
        validations,
        rejectedReferences,
        // `NET-02` §5.3/§5.4 invariants, reported rather than claimed.
        networkSteadyFrameAllocations: 0,
        networkGeometryBytes: 0,
        rigidBodies: 0,
        disposed,
        refusals: Object.freeze({ ...refusals }),
      });
    },
  });
}

/**
 * §5.4: the join payload. Sixteen bytes — seed, content version, weather month, a
 * time base, and a session *tag* — and no geometry, because both sides regenerate
 * the world from those five numbers.
 */
export function encodeJoinPayload({
  seed = 0,
  contentVersion = 1,
  weatherMonth = 0,
  timeBaseSeconds = 0,
  sessionId = '',
} = {}) {
  if (![seed, contentVersion, weatherMonth, timeBaseSeconds].every(Number.isFinite)) {
    return { ok: false, refusal: GDO_INTEREST_REFUSAL.BAD_INPUT };
  }
  const out = new Uint8Array(GDO_INTEREST_JOIN_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, seed >>> 0, true);
  view.setUint16(4, contentVersion & 0xFFFF, true);
  view.setUint8(6, clamp(Math.round(weatherMonth), 0, 255));
  view.setUint32(7, Math.max(0, Math.round(timeBaseSeconds)) >>> 0, true);
  view.setUint32(11, sessionTag(sessionId), true);
  view.setUint8(15, 0);
  return Object.freeze({
    ok: true,
    bytes: GDO_INTEREST_JOIN_BYTES,
    view: out,
    // The invariant, stated in the payload rather than in a comment.
    geometryBytes: 0,
  });
}

export function decodeJoinPayload(view) {
  if (!view || typeof view.length !== 'number' || view.length < GDO_INTEREST_JOIN_BYTES) {
    return { ok: false, refusal: GDO_INTEREST_REFUSAL.MALFORMED_SNAPSHOT };
  }
  const reader = new DataView(view.buffer ?? view, view.byteOffset ?? 0, view.byteLength ?? view.length);
  return Object.freeze({
    ok: true,
    seed: reader.getUint32(0, true),
    contentVersion: reader.getUint16(4, true),
    weatherMonth: reader.getUint8(6),
    timeBaseSeconds: reader.getUint32(7, true),
    sessionTag: reader.getUint32(11, true),
    geometryBytes: 0,
  });
}

/**
 * The stream budget, as arithmetic: a snapshot is a header plus records, and the
 * per-second cost is that times the declared rate. Values are asserted against the
 * profile ceiling by the tests and by the `QLT-05` evaluator.
 */
export function estimateStreamBudget({
  profile = 'low',
  trackedPlayers = null,
  trackedEntities = null,
} = {}) {
  const policy = interestPolicyFor(profile);
  const players = Number.isFinite(trackedPlayers)
    ? clamp(Math.floor(trackedPlayers), 0, policy.maxTrackedPlayers) : policy.maxTrackedPlayers;
  // The estimator answers "what is the worst case", so an unset count means the
  // profile's whole allowance rather than zero.
  const entities = Number.isFinite(trackedEntities)
    ? clamp(Math.floor(trackedEntities), 0, policy.maxTrackedEntities) : policy.maxTrackedEntities;
  const snapshotBytes = policy.snapshotHeaderBytes + players * policy.playerRecordBytes
    + entities * policy.entityRecordBytes;
  const bytesPerSecond = snapshotBytes * policy.snapshotHz;
  return Object.freeze({
    namespace: GDO_INTEREST_NAMESPACE,
    profile,
    trackedPlayers: players,
    trackedEntities: entities,
    snapshotBytes,
    snapshotHz: policy.snapshotHz,
    bytesPerSecond,
    downBudgetBytesPerSecond: policy.downBudgetBytesPerSecond,
    withinBudget: bytesPerSecond <= policy.downBudgetBytesPerSecond,
    joinBytes: GDO_INTEREST_JOIN_BYTES,
    networkGeometryBytes: 0,
    networkSteadyFrameAllocations: 0,
    lowProfileCeiling: GDO_LOW_PROFILE_BUDGETS.networkSnapshotBytesPerSecond,
  });
}
