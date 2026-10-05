/**
 * The curated/coordinate domain interface (`FND-08`).
 *
 * Both runtimes answer the same five questions about the world — where is the
 * ground, what is in the way, where does a body end up after moving, may a body
 * step there, and where may the camera sit — and both already answered them
 * through ad-hoc shapes: the coordinate player talks to `GeoWorld`, and the
 * curated player talks to `BridgeManager` plus a module-level terrain function.
 * `ThirdPersonCamera` solved the same problem for its own two ports by taking
 * injected callables, which is the pattern this module names and generalises.
 *
 * The contract deliberately does **not** unify the two modes' scales. Curated
 * resolves ground on a 4-metre lattice at 1:1 world scale with a camera sweep
 * radius clamped to `[.6, 1.25]`; coordinate resolves a 33×33 terrain sample
 * grid per tile at 1:10 scale with a sweep radius clamped to `[.03, .04]`. The
 * footprints differ by exactly the documented horizontal scale, and
 * `compareDomainScales` asserts that they stay different — so a future change
 * cannot "simplify" the interface by collapsing one mode into the other, and
 * cannot silently drift the 1:10 invariant either.
 *
 * This module imports nothing, so the Node tier can drive a real `GeoWorld` and
 * a real curated bridge/player pair through one identical probe.
 */

/** Bumped when a member's argument shape or return shape changes incompatibly. */
export const WORLD_DOMAIN_VERSION = 1;

/**
 * The required members, with the minimum arity each must declare.
 *
 * Arity is a floor, not an equality: a domain may accept extra optional
 * arguments (coordinate `collidesCircle` takes query masks and a Y span) as
 * long as the first N parameters carry the shared meaning. `Function.length`
 * stops counting at the first default or rest parameter, so a domain that
 * writes `collidesCircle(x, z, radius, mask = 1, minY, maxY)` still declares 3.
 */
export const WORLD_DOMAIN_MEMBERS = Object.freeze({
  supportAt: {
    minArity: 2,
    signature: 'supportAt(x, z, out?) -> { y, normalY, slopeRadians, walkable, kind }',
    meaning: 'Ground or structure support at one point, in this domain\'s own units.',
  },
  collidesCircle: {
    minArity: 3,
    signature: 'collidesCircle(x, z, radius, ...) -> boolean',
    meaning: 'True when a solid overlapping this horizontal circle already occupies the point.',
  },
  moveCircle: {
    minArity: 5,
    signature: 'moveCircle(x, z, dx, dz, radius, ...) -> { x, z, hit, contacts, normalX, normalZ }',
    meaning: 'Where a horizontal circle of this radius ends up when displaced, resolving contacts.',
  },
  resolveGroundStep: {
    minArity: 4,
    signature: 'resolveGroundStep(fromX, fromZ, toX, toZ, options?, out?) -> { from, to, heightDelta, accepted, reason }',
    meaning: 'Whether a grounded body may move between two supports under this domain\'s step/slope policy. When `options.footprintHalfExtent` is finite the domain samples support under a square footprint instead of at the centre; a domain whose body is a point leaves it undefined and samples the centre.',
  },
  clipCamera: {
    // Two, not three: both implementations default the sweep radius, and
    // `Function.length` stops counting at the first default parameter. The
    // radius is still part of the call — the shared probe passes one and judges
    // the result — but the floor is the two arguments no domain may omit.
    minArity: 2,
    signature: 'clipCamera(target, desired, radius?, out?) -> { blocked, amount, time, normalX, normalY, normalZ }',
    meaning: 'Pull `desired` in to the first obstruction on the segment from `target`. Mutates `desired`, which must therefore be a Vector3-like with `set(x, y, z)` — both modes write the clipped position back through it.',
  },
  readDiagnostics: {
    minArity: 0,
    signature: 'readDiagnostics() -> object',
    meaning: 'Counters for the queries above, as a snapshot. Domains report their own keys.',
  },
});

/** Members whose semantics must hold in both modes, in declaration order. */
export const WORLD_DOMAIN_MEMBER_NAMES = Object.freeze(Object.keys(WORLD_DOMAIN_MEMBERS));

/**
 * Scale fields with the same meaning in both modes, used by the anti-merge
 * guard. `footprintHalfExtent` is the horizontal half extent the player
 * occupies and samples around; `supportSampleSpacing` is the ground-feature
 * spacing the domain resolves; the two sweep fields are the clamp a mode puts
 * on its own camera clip radius, which follows from its field of view and near
 * plane rather than from the interface.
 */
export const WORLD_DOMAIN_SCALE_KEYS = Object.freeze([
  'footprintHalfExtent',
  'supportSampleSpacing',
  'sweepRadiusMin',
  'sweepRadiusMax',
]);

/** The horizontal scale invariant the whole project is built on. */
export const GDO_HORIZONTAL_SCALE = 10;

export class WorldDomainError extends TypeError {
  constructor(message) { super(message); this.name = 'WorldDomainError'; }
}

/**
 * Throw unless `domain` satisfies the interface. The message names every
 * missing or malformed member at once, so one run fixes the whole gap rather
 * than one member per attempt.
 */
export function assertWorldDomain(domain, label = 'domain') {
  if (!domain || typeof domain !== 'object') {
    throw new WorldDomainError(`${label} must be an object exposing the curated/coordinate domain interface`);
  }
  const problems = [];
  for (const name of WORLD_DOMAIN_MEMBER_NAMES) {
    const member = domain[name];
    if (typeof member !== 'function') { problems.push(`${name} is ${member === undefined ? 'missing' : typeof member}`); continue; }
    const shared = WORLD_DOMAIN_MEMBERS[name];
    if (member.length < shared.minArity) {
      problems.push(`${name} declares ${member.length} parameter(s), needs at least ${shared.minArity} (${shared.signature})`);
    }
  }
  if (domain.name !== undefined && typeof domain.name !== 'string') problems.push('name must be a string when present');
  if (domain.scale === undefined) problems.push('scale is missing, so the mode\'s own units are undeclared');
  else problems.push(...scaleProblems(domain.scale));
  if (problems.length) {
    throw new WorldDomainError(`${label} does not implement the domain interface: ${problems.join('; ')}`);
  }
  return domain;
}

function scaleProblems(scale) {
  if (!scale || typeof scale !== 'object') return ['scale must be an object of numbers'];
  const problems = [];
  for (const key of WORLD_DOMAIN_SCALE_KEYS) {
    const value = scale[key];
    if (!Number.isFinite(value) || value <= 0) problems.push(`scale.${key} must be a positive finite number`);
  }
  return problems;
}

/** A report for docs, diagnostics and the gate; never throws. */
export function describeWorldDomain(domain) {
  const members = {};
  for (const name of WORLD_DOMAIN_MEMBER_NAMES) {
    const member = domain?.[name];
    members[name] = typeof member === 'function' ? member.length : null;
  }
  return {
    version: WORLD_DOMAIN_VERSION,
    name: domain?.name ?? null,
    members,
    complete: WORLD_DOMAIN_MEMBER_NAMES.every(name => members[name] !== null &&
      members[name] >= WORLD_DOMAIN_MEMBERS[name].minArity),
    scale: domain?.scale ? { ...domain.scale } : null,
  };
}

/**
 * The one shared assertion that keeps "shared interface" from becoming "one
 * visual scale". Returns measured ratios instead of a bare verdict, so a
 * failure says what the two modes actually are.
 */
export function compareDomainScales(left, right) {
  const problems = [];
  const la = left?.scale, lb = right?.scale;
  if (!la || !lb) return { ok: false, problems: ['both domains must declare a scale descriptor'], ratios: {} };
  const ratio = (a, b) => (a && b ? Math.max(a, b) / Math.min(a, b) : Number.NaN);
  const ratios = {};
  for (const key of WORLD_DOMAIN_SCALE_KEYS) ratios[key] = ratio(la[key], lb[key]);

  const clampsOverlap = la.sweepRadiusMax >= lb.sweepRadiusMin && lb.sweepRadiusMax >= la.sweepRadiusMin;
  if (clampsOverlap) {
    problems.push(`camera sweep clamps overlap ([${la.sweepRadiusMin}, ${la.sweepRadiusMax}] vs [${lb.sweepRadiusMin}, ${lb.sweepRadiusMax}]), so one mode's near-plane sizing would leak into the other`);
  }
  const footprint = ratios.footprintHalfExtent;
  if (!Number.isFinite(footprint)) problems.push('footprintHalfExtent is not comparable across the two domains');
  else if (Math.abs(footprint - GDO_HORIZONTAL_SCALE) > GDO_HORIZONTAL_SCALE * .25) {
    problems.push(`footprint ratio is ${footprint.toFixed(3)}x, must stay near the documented ${GDO_HORIZONTAL_SCALE}:1 horizontal scale`);
  }
  if (!(ratios.supportSampleSpacing > 1)) {
    problems.push(`supportSampleSpacing ratio is ${ratios.supportSampleSpacing}, so the coarser mode no longer resolves a wider ground feature`);
  }
  return { ok: problems.length === 0, problems, ratios };
}

/**
 * The probe's own Vector3-like. `clipCamera` writes the clipped position back
 * through `desired.set(x, y, z)`, so a plain object literal is not enough: both
 * real modes call it. Defined here rather than imported so this module stays
 * dependency-free.
 */
function probeVec3(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    set(nx, ny, nz) { this.x = nx; this.y = ny; this.z = nz; return this; },
  };
}

const cornerSupport = {}, bestSupport = {};

/**
 * Ground support under a body, sampled this domain's way.
 *
 * Both players currently do the same thing by hand: take the highest support
 * over the four corners of a square footprint. Naming it puts the footprint
 * half extent in the caller — and therefore in that mode's scale descriptor —
 * instead of duplicating a magic `0.55` in two runtimes.
 *
 * The winning corner's whole support record travels into `out`, not just its
 * height, so a caller can still read the surface kind or slope it landed on.
 * Both scratch objects are module-level, so a grounded frame allocates nothing.
 */
export function supportUnderFoot(domain, x, z, halfExtent, out = {}) {
  const reach = Number.isFinite(halfExtent) && halfExtent > 0 ? halfExtent : 0;
  let bestY = -Infinity, bestX = x, bestZ = z;
  for (const dx of [-reach, reach]) {
    for (const dz of [-reach, reach]) {
      const support = domain.supportAt(x + dx, z + dz, cornerSupport);
      if (support.y > bestY) { bestY = support.y; bestX = x + dx; bestZ = z + dz; Object.assign(bestSupport, cornerSupport); }
    }
  }
  Object.assign(out, bestSupport, { x: bestX, y: bestY, z: bestZ });
  return out;
}

/**
 * The shared probe. Drives one identical sequence of questions against any
 * domain and returns a comparable record, so the gate can assert the same
 * semantics in both modes without asserting the same numbers.
 *
 * `lane.from` must be clear ground and `lane.toward` must hold a solid, both in
 * the domain's own units; the caller places the solid when the domain can (the
 * coordinate tier adds a dynamic proxy, the curated tier uses a bridge rail).
 * The clear-lane check runs first, because a lane that starts inside geometry
 * decides the outcome and the measurement then proves nothing.
 *
 * The camera half carries two controls rather than one: a segment ending inside
 * the solid, which must report a block, and a segment of `camera.clearDistance`
 * back down the clear lane, which must not. A single blocked measurement cannot
 * tell a working clip from one that refuses everything.
 */
export function probeWorldDomain(domain, {
  lane,
  moveDistance,
  radius,
  step,
  camera = {},
} = {}) {
  assertWorldDomain(domain, domain?.name ?? 'domain');
  const { from, toward } = lane ?? {};
  if (!from || !toward) throw new WorldDomainError('probeWorldDomain requires lane.from and lane.toward');

  const sweepRadius = Number.isFinite(radius) && radius > 0
    ? radius
    : (domain.scale.sweepRadiusMin + domain.scale.sweepRadiusMax) / 2;
  const length = Math.hypot(toward.x - from.x, toward.z - from.z) || 1;
  const ux = (toward.x - from.x) / length, uz = (toward.z - from.z) / length;
  const distance = Number.isFinite(moveDistance) && moveDistance > 0 ? moveDistance : length;

  const support = domain.supportAt(from.x, from.z, {});
  const laneClear = !domain.collidesCircle(from.x, from.z, domain.scale.footprintHalfExtent);
  const solidPresent = domain.collidesCircle(toward.x, toward.z, domain.scale.footprintHalfExtent);

  // The move is driven in player-sized sub-steps and stops at the first
  // contact. Handing a mode one large delta measures the wrong thing in curated
  // mode, whose move is a whole-delta step that reverts: it would report that it
  // advanced nothing, which is true of the call and false of the behaviour. The
  // sub-step size is small against both modes' smallest obstacle so neither can
  // tunnel through the thing it is being measured against.
  const steps = 60;
  const stride = distance / steps;
  let movedX = from.x, movedZ = from.z, hit = false, contacts = 0, stepsTaken = 0;
  for (let index = 0; index < steps && !hit; index++) {
    const motion = domain.moveCircle(movedX, movedZ, ux * stride, uz * stride, domain.scale.footprintHalfExtent, .003, 2, {}, .12);
    hit = motion.hit === true;
    contacts += motion.contacts ?? 0;
    movedX = motion.x; movedZ = motion.z;
    stepsTaken++;
    if (!Number.isFinite(movedX) || !Number.isFinite(movedZ)) break;
  }
  const advanced = Math.hypot(movedX - from.x, movedZ - from.z);
  const remainingToSolid = Math.hypot(toward.x - movedX, toward.z - movedZ);

  const stepProbe = probeSteps(domain, step, support.y);

  const height = Number.isFinite(camera.height) ? camera.height : 0;
  const eye = value => probeVec3(value.x, support.y + height, value.z);
  const clearDistance = Number.isFinite(camera.clearDistance) && camera.clearDistance > 0 ? camera.clearDistance : distance;
  const blockedDesired = probeVec3(toward.x, support.y + height, toward.z);
  const blocked = domain.clipCamera(eye(from), blockedDesired, sweepRadius, {});
  const clearDesired = probeVec3(from.x - ux * clearDistance, support.y + height, from.z - uz * clearDistance);
  const clear = domain.clipCamera(eye(from), clearDesired, sweepRadius, {});

  return {
    name: domain.name ?? null,
    scale: { ...domain.scale },
    sweepRadius,
    support: {
      y: support.y,
      finite: Number.isFinite(support.y),
      walkable: support.walkable !== false,
      kind: support.kind ?? null,
    },
    lane: { clear: laneClear, solidPresent },
    move: {
      hit,
      contacts,
      stride,
      stepsTaken,
      advanced,
      remainingToSolid,
      // Reaching the solid at all — by sliding to a stop or by refusing the
      // step — is a failure. The two modes differ in *how* they stop, and that
      // difference is theirs to keep.
      stoppedShortOfSolid: advanced < distance && remainingToSolid > 0,
      x: movedX,
      z: movedZ,
      finite: Number.isFinite(movedX) && Number.isFinite(movedZ),
    },
    step: stepProbe,
    camera: {
      height,
      clearDistance,
      blocked: blocked.blocked === true,
      amount: blocked.amount,
      time: blocked.time,
      finite: Number.isFinite(blocked.amount) && Number.isFinite(blocked.time),
      inRange: blocked.amount >= 0 && blocked.amount <= 1 && blocked.time >= 0 && blocked.time <= 1,
      clearRayBlocked: clear.blocked === true,
      clearRayAmount: clear.amount,
    },
    diagnostics: domain.readDiagnostics(),
  };
}

function probeSteps(domain, step, referenceY) {
  const blank = { finite: null, levelAccepted: null, levelReason: null, riseAccepted: null, riseReason: null };
  if (!step?.from || !step.level || !step.rise) return blank;
  const policy = {
    referenceY,
    maxStepUp: step.policy?.maxStepUp ?? 0,
    maxStepDown: step.policy?.maxStepDown ?? 0,
    maxSlope: step.policy?.maxSlope ?? Math.PI / 2,
  };
  const level = domain.resolveGroundStep(step.from.x, step.from.z, step.level.x, step.level.z, policy, {});
  const rise = domain.resolveGroundStep(step.from.x, step.from.z, step.rise.x, step.rise.z, policy, {});
  return {
    finite: Number.isFinite(level.heightDelta) && Number.isFinite(rise.heightDelta),
    levelAccepted: level.accepted === true,
    levelReason: level.reason ?? null,
    riseAccepted: rise.accepted === true,
    riseReason: rise.reason ?? null,
  };
}

/**
 * The semantic assertions the gate applies to a probe record. Kept beside the
 * probe so the browser tier and the Node tier cannot drift apart: both call
 * this, and both fail with the same sentences.
 */
export function judgeWorldDomain(probe) {
  const failures = [];
  const require = (condition, message) => { if (!condition) failures.push(message); };
  require(probe.support.finite, 'supportAt must return a finite height');
  require(probe.lane.clear, 'probe lane must start clear of solids, or the measurement proves nothing');
  require(probe.lane.solidPresent, 'probe lane must end at a solid, or a blocked move cannot be distinguished from open ground');
  require(probe.move.finite, 'moveCircle must return finite coordinates');
  require(probe.move.hit, 'moveCircle must report a contact when sent into a solid');
  require(probe.move.contacts >= 1, 'moveCircle must count the contact it reported');
  require(probe.move.stoppedShortOfSolid, 'moveCircle must not reach the solid it collided with');
  require(probe.move.stepsTaken > 1, 'the move probe must approach in sub-steps, not one whole delta');
  require(probe.step.finite === true, 'resolveGroundStep must report a finite height delta for both sample pairs');
  require(probe.step.levelAccepted === true, 'a level step must be accepted');
  require(probe.step.riseAccepted === false, 'a step above the policy ceiling must be rejected');
  require(probe.step.riseReason === 'step-up', `a rejected rise must name the reason 'step-up', not '${probe.step.riseReason}'`);
  require(probe.camera.finite && probe.camera.inRange, 'clipCamera must return finite amount/time inside [0, 1]');
  require(probe.camera.blocked, 'clipCamera must report a block on a segment that ends inside a solid');
  require(probe.camera.clearRayBlocked === false, 'clipCamera must not report a block on the clear control segment');
  return { ok: failures.length === 0, failures };
}
