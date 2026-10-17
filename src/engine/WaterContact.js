/**
 * `COL-08` — water, swimming, and fall support semantics.
 *
 * The research is explicit that water is a sensor and a small state machine, not
 * a fluid solver (`MINIMAL_PHYSICS_RESEARCH.md` §5.7) and that swimming needs one
 * drag/buoyancy approximation with a single body-centre sample (§9.5):
 *
 * ```text
 * submersion = clamp((h - bodyBottom) / bodyHeight, 0, 1)
 * verticalAcceleration += buoyancy * submersion - drag * velocityY * submersion
 * horizontalVelocity *= exp(-waterDrag * submersion * dt)
 * ```
 *
 * This module is that machine: mapped surfaces and depth produce one of `dry`,
 * `wading`, `swimming`, or `submerged`, with the speed/gravity/camera changes the
 * state implies, an exit plan for climbing out, and the fall-impact bands §9.9
 * asks for. It is unit-agnostic — the coordinate world and the curated island
 * pass their own gravity and body height — and it allocates nothing in steady
 * state, because every entry point writes into the caller's reused record.
 */

import { featureNamespace } from './FeatureVersions.js';

export const GDO_WATER_CONTACT_NAMESPACE = featureNamespace('waterContact');

export const GDO_WATER_STATE = Object.freeze({
  DRY: 'dry',
  WADING: 'wading',
  SWIMMING: 'swimming',
  SUBMERGED: 'submerged',
});

export const GDO_WATER_STATE_ORDER = Object.freeze([
  GDO_WATER_STATE.DRY, GDO_WATER_STATE.WADING, GDO_WATER_STATE.SWIMMING, GDO_WATER_STATE.SUBMERGED,
]);

/** Where the water height came from, so a debug session can tell the modes apart. */
export const GDO_WATER_SURFACE_SOURCE = Object.freeze({
  NONE: 'none',
  MAPPED_POLYGON: 'mapped-polygon',
  MAPPED_WATERWAY: 'mapped-waterway',
  MAPPED_WETLAND: 'mapped-wetland',
  CURATED_PLANE: 'curated-plane',
});

export const GDO_FALL_IMPACT = Object.freeze({
  NONE: 'none',
  LIGHT: 'light',
  STUMBLE: 'stumble',
  KNOCKDOWN: 'knockdown',
});

/**
 * Ratios, not absolute numbers, so one machine serves the coordinate world
 * (gravity 5.2 world units/s², body 0.18) and the curated island (gravity 30 m/s²,
 * body 1.7 m) without pretending the two share a scale.
 */
export const GDO_WATER_CONTACT_PROFILES = Object.freeze({
  low: Object.freeze({
    maxSamplesPerStep: 1,
    maxSamplesPerLookup: 4,
    chestFraction: .55,
    headFraction: .9,
    buoyancyRatio: 1.42,
    verticalDragRatio: .65,
    horizontalDragPerSecond: 2.8,
    deepHorizontalDragPerSecond: 3.6,
    currentStrength: .35,
    wadingSpeedFalloff: .58,
    swimSpeedMultiplier: .4,
    submergedSpeedMultiplier: .26,
    wadingGravityFalloff: .45,
    swimGravityScale: .12,
    submergedGravityScale: .05,
    maxExitReach: .6,
    maxExitDepth: .12,
    maxFallSpeedRatio: .9,
    lightImpactBodyHeights: 2,
    stumbleImpactBodyHeights: 5,
    eyeAboveWaterMargin: .04,
    // A floating body oscillates across the waterline, so an unsupported body
    // counts as in water until it clears the surface by this fraction.
    floatToleranceFraction: .12,
    wetlandDepth: .05,
    shorelineWetDepth: .012,
  }),
  balanced: Object.freeze({
    maxSamplesPerStep: 1,
    maxSamplesPerLookup: 5,
    chestFraction: .55,
    headFraction: .9,
    buoyancyRatio: 1.46,
    verticalDragRatio: .62,
    horizontalDragPerSecond: 2.6,
    deepHorizontalDragPerSecond: 3.4,
    currentStrength: .35,
    wadingSpeedFalloff: .6,
    swimSpeedMultiplier: .44,
    submergedSpeedMultiplier: .3,
    wadingGravityFalloff: .42,
    swimGravityScale: .12,
    submergedGravityScale: .05,
    maxExitReach: .7,
    maxExitDepth: .14,
    maxFallSpeedRatio: .9,
    lightImpactBodyHeights: 2,
    stumbleImpactBodyHeights: 5,
    eyeAboveWaterMargin: .04,
    // A floating body oscillates across the waterline, so an unsupported body
    // counts as in water until it clears the surface by this fraction.
    floatToleranceFraction: .12,
    wetlandDepth: .05,
    shorelineWetDepth: .012,
  }),
  high: Object.freeze({
    maxSamplesPerStep: 2,
    maxSamplesPerLookup: 6,
    chestFraction: .55,
    headFraction: .9,
    buoyancyRatio: 1.5,
    verticalDragRatio: .6,
    horizontalDragPerSecond: 2.4,
    deepHorizontalDragPerSecond: 3.2,
    currentStrength: .35,
    wadingSpeedFalloff: .62,
    swimSpeedMultiplier: .48,
    submergedSpeedMultiplier: .34,
    wadingGravityFalloff: .4,
    swimGravityScale: .12,
    submergedGravityScale: .05,
    maxExitReach: .8,
    maxExitDepth: .16,
    maxFallSpeedRatio: .9,
    lightImpactBodyHeights: 2,
    stumbleImpactBodyHeights: 5,
    eyeAboveWaterMargin: .04,
    // A floating body oscillates across the waterline, so an unsupported body
    // counts as in water until it clears the surface by this fraction.
    floatToleranceFraction: .12,
    wetlandDepth: .05,
    shorelineWetDepth: .012,
  }),
});

export const GDO_WATER_EXIT_REASON = Object.freeze({
  DRY: 'already-dry',
  SHALLOW: 'shallow-bottom',
  WALKABLE_SUPPORT: 'walkable-support',
  TOO_DEEP: 'support-too-deep',
  UNWALKABLE: 'unwalkable-support',
  NO_SUPPORT: 'no-support',
});

function clamp(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

export function waterBudgetForProfile(profile) {
  const policy = GDO_WATER_CONTACT_PROFILES[profile];
  if (!policy) throw new RangeError(`Unknown water-contact profile: ${profile}`);
  return Object.freeze({
    maxSamplesPerStep: policy.maxSamplesPerStep,
    maxSamplesPerLookup: policy.maxSamplesPerLookup,
    maxExitReach: policy.maxExitReach,
    maxExitDepth: policy.maxExitDepth,
  });
}

function requireNumbers(values, message) {
  for (const value of values) if (!Number.isFinite(value)) throw new TypeError(message);
}

/** §9.5, exactly: `clamp((h - bodyBottom) / bodyHeight, 0, 1)`. */
export function submersionAt({ waterSurfaceY, bodyBottom, bodyHeight }) {
  requireNumbers([waterSurfaceY, bodyBottom, bodyHeight], 'Submersion needs finite heights');
  if (bodyHeight <= 0) throw new RangeError('Submersion needs a positive body height');
  return clamp((waterSurfaceY - bodyBottom) / bodyHeight, 0, 1);
}

function createContact(out) {
  out.namespace = GDO_WATER_CONTACT_NAMESPACE;
  out.state = GDO_WATER_STATE.DRY;
  out.previousState = GDO_WATER_STATE.DRY;
  out.changed = false;
  out.source = GDO_WATER_SURFACE_SOURCE.NONE;
  out.inWater = false;
  out.wet = false;
  out.submersion = 0;
  out.depth = 0;
  out.wadingDepth = 0;
  out.headClearance = 0;
  out.chestClearance = 0;
  out.canStand = true;
  out.headUnder = false;
  out.grounded = true;
  out.speedMultiplier = 1;
  out.gravityScale = 1;
  out.buoyancyAcceleration = 0;
  out.verticalDragPerSecond = 0;
  out.horizontalDragPerSecond = 0;
  out.currentX = 0;
  out.currentZ = 0;
  out.cameraMinY = -Infinity;
  out.cameraSubmerged = false;
  out.waterClass = 0;
  out.waterClassName = 'unknown';
  out.samples = 0;
  out.feetY = 0;
  out.groundY = 0;
  out.bodyHeight = 0;
  out.waterSurfaceY = null;
  out.merged = false;
  return out;
}

/**
 * Classify one body against one water surface. `feetY` is the body bottom,
 * `groundY` the support under it, `bodyHeight` the standing body height.
 */
export function classifyWaterContact({
  waterSurfaceY = -Infinity,
  feetY,
  groundY = feetY,
  bodyHeight,
  gravity = 9.8,
  inWater = false,
  wet = false,
  flowX = 0,
  flowZ = 0,
  source = GDO_WATER_SURFACE_SOURCE.NONE,
  waterClass = 0,
  waterClassName = 'unknown',
  profile = 'low',
} = {}, out = {}) {
  const policy = GDO_WATER_CONTACT_PROFILES[profile];
  if (!policy) throw new RangeError(`Unknown water-contact profile: ${profile}`);
  requireNumbers([feetY, groundY, bodyHeight, gravity], 'Water contact needs finite heights and gravity');
  if (bodyHeight <= 0) throw new RangeError('Water contact needs a positive body height');
  if (gravity <= 0) throw new RangeError('Water contact needs a positive gravity');
  createContact(out);
  out.previousState = out.state;
  out.source = source;
  out.waterClass = waterClass;
  out.waterClassName = waterClassName;
  out.samples = 1;
  out.feetY = feetY;
  out.groundY = groundY;
  out.bodyHeight = bodyHeight;
  out.waterSurfaceY = Number.isFinite(waterSurfaceY) ? waterSurfaceY : null;
  out.merged = false;
  out.grounded = feetY <= groundY + bodyHeight * .2;

  const depth = waterSurfaceY - groundY;
  const wadingDepth = waterSurfaceY - feetY;
  out.depth = depth;
  out.wadingDepth = wadingDepth;
  const bodyTop = feetY + bodyHeight;
  const chestY = feetY + bodyHeight * policy.chestFraction;
  const headY = feetY + bodyHeight * policy.headFraction;
  out.chestClearance = chestY - waterSurfaceY;
  out.headClearance = bodyTop - waterSurfaceY;

  // Water above the feet is what wets a body; water above the ground is what
  // makes a place water at all. A raised road crossing a mapped pond stays dry,
  // and a body floating exactly at the waterline still counts as swimming.
  const floatTolerance = out.grounded ? 0 : bodyHeight * policy.floatToleranceFraction;
  const submerged = inWater && Number.isFinite(waterSurfaceY) && feetY <= waterSurfaceY + floatTolerance;
  if (!submerged) {
    out.wet = inWater || wet;
    out.state = GDO_WATER_STATE.DRY;
    out.cameraMinY = -Infinity;
    out.canStand = true;
    out.headUnder = false;
    if (out.wet) {
      // Wet ground still costs a little speed and grip, but nothing else.
      out.speedMultiplier = 1 - policy.shorelineWetDepth;
      out.grounded = true;
    }
    return out;
  }

  const submersion = submersionAt({ waterSurfaceY, bodyBottom: feetY, bodyHeight });
  out.submersion = submersion;
  out.inWater = true;
  out.wet = true;
  out.headUnder = bodyTop <= waterSurfaceY;
  // A body may keep its feet on the bottom as long as the head is still out.
  out.canStand = out.grounded && !out.headUnder;
  out.buoyancyAcceleration = policy.buoyancyRatio * gravity * submersion;
  out.verticalDragPerSecond = policy.verticalDragRatio * gravity * submersion;
  out.horizontalDragPerSecond = (submersion >= policy.headFraction
    ? policy.deepHorizontalDragPerSecond : policy.horizontalDragPerSecond) * submersion;
  out.currentX = flowX * policy.currentStrength;
  out.currentZ = flowZ * policy.currentStrength;
  const chestUnder = chestY <= waterSurfaceY;
  // Floating over water too deep to stand in is swimming even at the waterline:
  // the state describes what the body is doing, not only how deep it is.
  const floating = !out.grounded && depth > bodyHeight * policy.chestFraction;
  out.state = out.headUnder ? GDO_WATER_STATE.SUBMERGED
    : chestUnder || floating ? GDO_WATER_STATE.SWIMMING
      : GDO_WATER_STATE.WADING;
  if (out.state === GDO_WATER_STATE.WADING) {
    const reach = clamp(submersion / policy.chestFraction, 0, 1);
    out.speedMultiplier = 1 - (1 - policy.wadingSpeedFalloff) * reach;
    out.gravityScale = 1 - (1 - policy.wadingGravityFalloff) * reach;
  } else {
    out.speedMultiplier = out.state === GDO_WATER_STATE.SUBMERGED
      ? policy.submergedSpeedMultiplier : policy.swimSpeedMultiplier;
    out.gravityScale = out.state === GDO_WATER_STATE.SUBMERGED
      ? policy.submergedGravityScale : policy.swimGravityScale;
  }
  // The eye never rides under the surface: swimming raises the camera instead.
  out.cameraSubmerged = chestUnder;
  out.cameraMinY = chestUnder ? waterSurfaceY + policy.eyeAboveWaterMargin : -Infinity;
  return out;
}

/**
 * §9.5 motion step. `dt` in seconds; velocities in world units per second. The
 * caller keeps its own integration order; this only answers "what do the
 * velocities become".
 */
export function stepWaterMotion({
  contact, velocityX = 0, velocityY = 0, velocityZ = 0, gravity = 9.8, dt,
} = {}, out = {}) {
  if (!contact) throw new TypeError('Water motion needs a contact record');
  requireNumbers([velocityX, velocityY, velocityZ, gravity, dt], 'Water motion needs finite numbers');
  if (dt < 0) throw new RangeError('Water motion needs a non-negative timestep');
  const buoyancy = contact.buoyancyAcceleration ?? 0;
  const verticalDrag = contact.verticalDragPerSecond ?? 0;
  // velocityY += (buoyancy - gravity * gravityScale - drag * velocityY) * dt
  const verticalAcceleration = buoyancy - gravity * (contact.gravityScale ?? 1) - verticalDrag * velocityY;
  out.velocityY = velocityY + verticalAcceleration * dt;
  const decay = Math.exp(-(contact.horizontalDragPerSecond ?? 0) * dt);
  out.velocityX = velocityX * decay + (contact.currentX ?? 0) * dt;
  out.velocityZ = velocityZ * decay + (contact.currentZ ?? 0) * dt;
  out.verticalAcceleration = verticalAcceleration;
  out.horizontalDecay = decay;
  return out;
}

/**
 * `COL-08` exit rules: can the body leave the water here? A support must be
 * walkable, no deeper than the profile's exit depth below the surface, and
 * inside the exit reach — otherwise the reason says why.
 */
export function planWaterExit({
  contact, supportY = -Infinity, walkable = true, blocked = false, waterSurfaceY = -Infinity,
  profile = 'low',
} = {}, out = {}) {
  const policy = GDO_WATER_CONTACT_PROFILES[profile];
  if (!policy) throw new RangeError(`Unknown water-contact profile: ${profile}`);
  if (!contact) throw new TypeError('Water exit needs a contact record');
  if (contact.state === GDO_WATER_STATE.DRY) {
    out.allowed = true;
    out.reason = GDO_WATER_EXIT_REASON.DRY;
    out.targetY = supportY;
    out.requiredRise = 0;
    return out;
  }
  const surface = contact.waterSurfaceY ?? waterSurfaceY;
  out.requiredRise = supportY - (Number.isFinite(contact.feetY) ? contact.feetY : supportY);
  if (contact.canStand && contact.state === GDO_WATER_STATE.WADING) {
    out.allowed = true;
    out.reason = GDO_WATER_EXIT_REASON.SHALLOW;
    out.targetY = supportY;
    return out;
  }
  if (!Number.isFinite(supportY)) {
    out.allowed = false;
    out.reason = GDO_WATER_EXIT_REASON.NO_SUPPORT;
    out.targetY = Number.NaN;
    return out;
  }
  if (blocked) {
    out.allowed = false;
    out.reason = GDO_WATER_EXIT_REASON.UNWALKABLE;
    out.targetY = supportY;
    return out;
  }
  if (!walkable) {
    out.allowed = false;
    out.reason = GDO_WATER_EXIT_REASON.UNWALKABLE;
    out.targetY = supportY;
    return out;
  }
  if (supportY < surface - policy.maxExitDepth) {
    out.allowed = false;
    out.reason = GDO_WATER_EXIT_REASON.TOO_DEEP;
    out.targetY = supportY;
    return out;
  }
  const reach = Math.abs(contact.feetY - supportY);
  if (Number.isFinite(contact.feetY) && reach > policy.maxExitReach) {
    out.allowed = false;
    out.reason = GDO_WATER_EXIT_REASON.TOO_DEEP;
    out.targetY = supportY;
    return out;
  }
  out.allowed = true;
  out.reason = GDO_WATER_EXIT_REASON.WALKABLE_SUPPORT;
  out.targetY = supportY;
  return out;
}

/**
 * §9.9 fall, knockdown, and recovery. The bands are fall *heights in body
 * heights* (`v² / (2 g · bodyHeight)`), which is what makes a coordinate jump and
 * a curated jump land the same way — a band in seconds or metres would not — and
 * the impact speed is always capped.
 */
export function classifyFallImpact({
  verticalSpeed = 0, gravity = 9.8, bodyHeight = 1, profile = 'low', landedInWater = false,
} = {}, out = {}) {
  const policy = GDO_WATER_CONTACT_PROFILES[profile];
  if (!policy) throw new RangeError(`Unknown water-contact profile: ${profile}`);
  requireNumbers([verticalSpeed, gravity, bodyHeight], 'Fall impact needs finite numbers');
  if (gravity <= 0) throw new RangeError('Fall impact needs a positive gravity');
  if (bodyHeight <= 0) throw new RangeError('Fall impact needs a positive body height');
  // Only downward speed matters.
  const speed = Math.max(0, -verticalSpeed);
  const cap = policy.maxFallSpeedRatio * gravity;
  const capped = speed > cap;
  const fallHeight = (speed * speed) / (2 * gravity);
  const bodyHeights = fallHeight / bodyHeight;
  const lightCeiling = policy.lightImpactBodyHeights;
  const stumbleCeiling = policy.stumbleImpactBodyHeights;
  // A water landing is a soft landing: it can never exceed the light band.
  const effectiveBodyHeights = landedInWater ? Math.min(bodyHeights, lightCeiling * .5) : bodyHeights;
  out.speed = speed;
  out.capped = capped;
  out.maxFallSpeed = cap;
  out.fallHeight = fallHeight;
  out.bodyHeights = bodyHeights;
  out.effectiveBodyHeights = effectiveBodyHeights;
  out.landedInWater = landedInWater;
  out.impact = effectiveBodyHeights <= 0 ? GDO_FALL_IMPACT.NONE
    : effectiveBodyHeights < lightCeiling ? GDO_FALL_IMPACT.LIGHT
      : effectiveBodyHeights < stumbleCeiling ? GDO_FALL_IMPACT.STUMBLE
        : GDO_FALL_IMPACT.KNOCKDOWN;
  out.cameraResponse = out.impact === GDO_FALL_IMPACT.NONE ? 0
    : out.impact === GDO_FALL_IMPACT.LIGHT ? .35
      : out.impact === GDO_FALL_IMPACT.STUMBLE ? .7 : 1;
  return out;
}

/**
 * The deepest contact of a bounded footprint, so an edge sample can never
 * report a body dry while a neighbouring sample is under water. The pattern is
 * fixed and the count is capped per profile; the caller passes pre-computed
 * samples to keep this allocation-free.
 */
export function mergeWaterContacts(contacts, out = {}) {
  if (!Array.isArray(contacts) || contacts.length === 0) {
    throw new TypeError('Merging water contacts needs at least one contact');
  }
  let deepest = contacts[0];
  for (const contact of contacts) if ((contact.submersion ?? 0) > (deepest.submersion ?? 0)) deepest = contact;
  for (const key of Object.keys(deepest)) out[key] = deepest[key];
  out.samples = contacts.length;
  out.merged = true;
  return out;
}
