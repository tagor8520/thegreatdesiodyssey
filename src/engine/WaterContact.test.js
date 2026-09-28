import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_FALL_IMPACT,
  GDO_WATER_CONTACT_NAMESPACE,
  GDO_WATER_CONTACT_PROFILES,
  GDO_WATER_EXIT_REASON,
  GDO_WATER_STATE,
  GDO_WATER_SURFACE_SOURCE,
  classifyFallImpact,
  classifyWaterContact,
  mergeWaterContacts,
  planWaterExit,
  stepWaterMotion,
  submersionAt,
  waterBudgetForProfile,
} from './WaterContact.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

/**
 * `COL-08` gate: the four water states come out of the depth, the §9.5 drag and
 * buoyancy step is the declared formula, exit rules refuse a deep bottom, and
 * fall impact bands are capped — all in world units the coordinate world uses.
 */

// Coordinate world numbers: gravity 5.2, body 0.18, water surface 0.020.
const COORDINATE = { gravity: 5.2, bodyHeight: .18, waterSurfaceY: .020 };
const feetAt = depth => COORDINATE.waterSurfaceY - depth;

test('submersion is the declared formula and the four states follow it', () => {
  assert.equal(GDO_WATER_CONTACT_NAMESPACE, 'gdo:waterContact:v1');
  assert.equal(submersionAt({ waterSurfaceY: .02, bodyBottom: .02 - .18, bodyHeight: .18 }), 1);
  assert.equal(submersionAt({ waterSurfaceY: .02, bodyBottom: .02, bodyHeight: .18 }), 0);
  assert.equal(submersionAt({ waterSurfaceY: .02, bodyBottom: .2, bodyHeight: .18 }), 0, 'above the surface clamps to dry');
  assert.equal(Math.abs(submersionAt({ waterSurfaceY: .02, bodyBottom: .02 - .09, bodyHeight: .18 }) - .5) < 1e-12, true);
  assert.throws(() => submersionAt({ waterSurfaceY: .02, bodyBottom: 0, bodyHeight: 0 }), /positive body height/);
  assert.throws(() => submersionAt({ waterSurfaceY: Number.NaN, bodyBottom: 0, bodyHeight: 1 }), /finite heights/);

  const contact = {};
  // Feet on dry land above the surface: dry, and a raised road over the pond is
  // dry even when the map says water is below it.
  classifyWaterContact({ ...COORDINATE, feetY: .025, groundY: .025, inWater: true }, contact);
  assert.equal(contact.state, GDO_WATER_STATE.DRY);
  assert.equal(contact.wet, true, 'standing over mapped water still reads as wet');
  assert.equal(contact.speedMultiplier, 1 - GDO_WATER_CONTACT_PROFILES.low.shorelineWetDepth);

  // Ankle/waist deep: wading. Deep water: swimming. Full submersion: submerged.
  classifyWaterContact({ ...COORDINATE, feetY: feetAt(.05), groundY: feetAt(.05), inWater: true }, contact);
  assert.equal(contact.state, GDO_WATER_STATE.WADING);
  assert.ok(contact.submersion > .2 && contact.submersion < .4, `submersion ${contact.submersion}`);
  assert.equal(contact.canStand, true);
  assert.ok(contact.speedMultiplier < 1 && contact.speedMultiplier > GDO_WATER_CONTACT_PROFILES.low.wadingSpeedFalloff);
  assert.equal(contact.cameraSubmerged, false);

  classifyWaterContact({ ...COORDINATE, feetY: feetAt(.12), groundY: feetAt(.12), inWater: true }, contact);
  assert.equal(contact.state, GDO_WATER_STATE.SWIMMING);
  assert.equal(contact.canStand, true, 'the feet still reach a shallow bottom');
  classifyWaterContact({ ...COORDINATE, feetY: feetAt(.12), groundY: feetAt(.4), inWater: true }, contact);
  assert.equal(contact.state, GDO_WATER_STATE.SWIMMING);
  assert.equal(contact.grounded, false);
  assert.equal(contact.canStand, false, 'floating over a deep bottom is not standing');
  // A body floating at the waterline over deep water is swimming, not wading.
  classifyWaterContact({ ...COORDINATE, feetY: feetAt(.015), groundY: feetAt(.4), inWater: true }, contact);
  assert.ok(contact.submersion < .1, `floating submersion ${contact.submersion}`);
  assert.equal(contact.state, GDO_WATER_STATE.SWIMMING);
  classifyWaterContact({ ...COORDINATE, feetY: feetAt(.12), groundY: feetAt(.12), inWater: true }, contact);
  assert.equal(contact.headUnder, false);
  assert.equal(contact.speedMultiplier, GDO_WATER_CONTACT_PROFILES.low.swimSpeedMultiplier);
  assert.equal(contact.cameraSubmerged, true);
  assert.ok(contact.cameraMinY > .02, 'the eye is held above the surface');

  classifyWaterContact({ ...COORDINATE, feetY: feetAt(.24), groundY: feetAt(.24), inWater: true }, contact);
  assert.equal(contact.state, GDO_WATER_STATE.SUBMERGED);
  assert.equal(contact.headUnder, true);
  assert.ok(contact.submersion >= GDO_WATER_CONTACT_PROFILES.low.headFraction);
  assert.equal(contact.speedMultiplier, GDO_WATER_CONTACT_PROFILES.low.submergedSpeedMultiplier);
  assert.ok(contact.horizontalDragPerSecond > GDO_WATER_CONTACT_PROFILES.low.horizontalDragPerSecond);

  // Dry ground far from water keeps the state at exactly the dry defaults.
  classifyWaterContact({ ...COORDINATE, feetY: -.02, groundY: -.02, inWater: false, source: GDO_WATER_SURFACE_SOURCE.NONE }, contact);
  assert.equal(contact.state, GDO_WATER_STATE.DRY);
  assert.equal(contact.speedMultiplier, 1);
  assert.equal(contact.gravityScale, 1);
  assert.equal(contact.currentX, 0);
  assert.throws(() => classifyWaterContact({ ...COORDINATE, feetY: 0, bodyHeight: 0 }), /positive body height/);
  assert.throws(() => classifyWaterContact({ ...COORDINATE, feetY: 0, gravity: 0 }), /positive gravity/);
  assert.throws(() => classifyWaterContact({ ...COORDINATE, feetY: 0, profile: 'deep' }), /Unknown water-contact profile/);
});

test('the §9.5 step floats a swimming body and drags it back', () => {
  const contact = classifyWaterContact({ ...COORDINATE, feetY: feetAt(.14), groundY: feetAt(.14), inWater: true });
  const motion = {};
  // A body under water accelerates up and its sinking speed decays.
  stepWaterMotion({ contact, velocityY: -1, dt: 1 / 60, gravity: COORDINATE.gravity }, motion);
  assert.ok(motion.verticalAcceleration > 0, `buoyancy wins at submersion ${contact.submersion}`);
  assert.ok(motion.velocityY > -1, 'the sink is arrested');
  const sinking = stepWaterMotion({ contact, velocityY: -1, dt: 1 / 60, gravity: COORDINATE.gravity }, {});
  assert.ok(sinking.velocityY > -1);
  // At full submersion without drag the acceleration is exactly buoyancy minus gravity.
  const submerged = classifyWaterContact({ ...COORDINATE, feetY: feetAt(.3), groundY: feetAt(.3), inWater: true });
  const still = stepWaterMotion({ contact: submerged, velocityY: 0, dt: 0, gravity: COORDINATE.gravity }, {});
  assert.ok(Math.abs(still.verticalAcceleration -
    (GDO_WATER_CONTACT_PROFILES.low.buoyancyRatio * COORDINATE.gravity -
      COORDINATE.gravity * submerged.gravityScale)) < 1e-9);

  // Horizontal velocity decays exponentially and the mapped flow pushes the body.
  const flowing = classifyWaterContact({
    ...COORDINATE, feetY: feetAt(.14), groundY: feetAt(.14), inWater: true, flowX: 1, flowZ: 0,
  });
  const pushed = stepWaterMotion({ contact: flowing, velocityX: 2, velocityZ: 0, dt: 1 / 30, gravity: COORDINATE.gravity }, {});
  assert.ok(pushed.velocityX < 2, 'the water slows horizontal travel');
  assert.ok(pushed.velocityX > 1.8, 'but not instantly');
  assert.ok(Math.abs(pushed.horizontalDecay - Math.exp(-flowing.horizontalDragPerSecond / 30)) < 1e-12);
  // A floating body with no input still drifts with the mapped flow.
  const drifting = stepWaterMotion({ contact: flowing, velocityX: 0, velocityZ: 0, dt: 1 / 30, gravity: COORDINATE.gravity }, {});
  assert.ok(drifting.velocityX > 0, 'the mapped current pushes with the flow');
  assert.ok(Math.abs(drifting.velocityX - flowing.currentX / 30) < 1e-12);
  assert.equal(drifting.velocityZ, 0, 'no cross-current when the map says the flow is straight');

  // A dry body is untouched by the step beyond ordinary gravity.
  const dry = classifyWaterContact({ ...COORDINATE, feetY: -.02, groundY: -.02 });
  const falling = stepWaterMotion({ contact: dry, velocityY: 0, dt: 1 / 60, gravity: COORDINATE.gravity }, {});
  assert.ok(Math.abs(falling.velocityY - (-COORDINATE.gravity / 60)) < 1e-12);
  assert.equal(falling.horizontalDecay, 1);
  assert.throws(() => stepWaterMotion({ velocityY: 0, dt: 0 }), /contact record/);
  assert.throws(() => stepWaterMotion({ contact: dry, velocityY: 0, dt: -1 }), /non-negative timestep/);
  assert.throws(() => stepWaterMotion({ contact: dry, velocityY: Number.NaN, dt: 0 }), /finite numbers/);
});

test('exit rules accept a shallow bank and refuse a deep or blocked one', () => {
  const wading = classifyWaterContact({ ...COORDINATE, feetY: feetAt(.06), groundY: feetAt(.06), inWater: true });
  const swimming = classifyWaterContact({ ...COORDINATE, feetY: feetAt(.14), groundY: feetAt(.14), inWater: true });
  const dry = classifyWaterContact({ ...COORDINATE, feetY: -.02, groundY: -.02 });
  const plan = {};

  planWaterExit({ contact: dry, supportY: -.02 }, plan);
  assert.equal(plan.allowed, true);
  assert.equal(plan.reason, GDO_WATER_EXIT_REASON.DRY);

  // A wading body on its own feet may simply walk out.
  planWaterExit({ contact: wading, supportY: feetAt(0) }, plan);
  assert.equal(plan.allowed, true);
  assert.equal(plan.reason, GDO_WATER_EXIT_REASON.SHALLOW);

  // A swimming body needs a bank at or above the exit depth.
  planWaterExit({ contact: swimming, supportY: .019 }, plan);
  assert.equal(plan.allowed, true);
  assert.equal(plan.reason, GDO_WATER_EXIT_REASON.WALKABLE_SUPPORT);
  assert.equal(plan.targetY, .019);
  planWaterExit({ contact: swimming, supportY: -.2 }, plan);
  assert.equal(plan.allowed, false);
  assert.equal(plan.reason, GDO_WATER_EXIT_REASON.TOO_DEEP, 'a bottom far below the surface is a wall, not a bank');
  planWaterExit({ contact: swimming, supportY: .019, walkable: false }, plan);
  assert.equal(plan.allowed, false);
  assert.equal(plan.reason, GDO_WATER_EXIT_REASON.UNWALKABLE, 'a steep bank is refused');
  planWaterExit({ contact: swimming, supportY: .019, blocked: true }, plan);
  assert.equal(plan.allowed, false);
  planWaterExit({ contact: swimming, supportY: Number.NaN }, plan);
  assert.equal(plan.reason, GDO_WATER_EXIT_REASON.NO_SUPPORT);
  assert.throws(() => planWaterExit({}), /contact record/);
  assert.throws(() => planWaterExit({ contact: dry, profile: 'abyss' }), /Unknown water-contact profile/);
});

test('fall impact bands are ratios of gravity, capped, and water is a soft landing', () => {
  const impact = {};
  // A coordinate jump lands at 1.65 world units/s: a light landing, not a knock-down.
  classifyFallImpact({ verticalSpeed: -1.65, gravity: COORDINATE.gravity, bodyHeight: COORDINATE.bodyHeight }, impact);
  assert.equal(impact.impact, GDO_FALL_IMPACT.LIGHT);
  assert.equal(impact.capped, false);
  assert.equal(impact.cameraResponse, .35);
  // Gravity alone with no speed is no impact at all.
  classifyFallImpact({ verticalSpeed: 0, gravity: COORDINATE.gravity, bodyHeight: COORDINATE.bodyHeight }, impact);
  assert.equal(impact.impact, GDO_FALL_IMPACT.NONE);
  // A taller drop stumbles, a long one knocks down, and the speed is capped.
  classifyFallImpact({ verticalSpeed: -2.2, gravity: COORDINATE.gravity, bodyHeight: COORDINATE.bodyHeight }, impact);
  assert.equal(impact.impact, GDO_FALL_IMPACT.STUMBLE);
  classifyFallImpact({ verticalSpeed: -3.4, gravity: COORDINATE.gravity, bodyHeight: COORDINATE.bodyHeight }, impact);
  assert.equal(impact.impact, GDO_FALL_IMPACT.KNOCKDOWN);
  assert.equal(impact.cameraResponse, 1);
  classifyFallImpact({ verticalSpeed: -40, gravity: COORDINATE.gravity, bodyHeight: COORDINATE.bodyHeight }, impact);
  assert.equal(impact.capped, true);
  assert.ok(Math.abs(impact.maxFallSpeed - GDO_WATER_CONTACT_PROFILES.low.maxFallSpeedRatio * COORDINATE.gravity) < 1e-12);
  // A curated jump is the same size of fall, so it is also a light landing.
  classifyFallImpact({ verticalSpeed: -13, gravity: 30, bodyHeight: 1.7 }, impact);
  assert.equal(impact.impact, GDO_FALL_IMPACT.LIGHT, 'the curated island reads the same band');
  classifyFallImpact({ verticalSpeed: -19, gravity: 30, bodyHeight: 1.7 }, impact);
  assert.equal(impact.impact, GDO_FALL_IMPACT.STUMBLE, 'a 6 m drop is a stumble');
  classifyFallImpact({ verticalSpeed: -25, gravity: 30, bodyHeight: 1.7 }, impact);
  assert.equal(impact.impact, GDO_FALL_IMPACT.KNOCKDOWN, 'a 10 m drop is a knock-down');
  // Landing in water is always soft.
  classifyFallImpact({ verticalSpeed: -40, gravity: COORDINATE.gravity, bodyHeight: COORDINATE.bodyHeight, landedInWater: true }, impact);
  assert.equal(impact.impact, GDO_FALL_IMPACT.LIGHT);
  assert.equal(impact.capped, true);
  assert.throws(() => classifyFallImpact({ verticalSpeed: -1, gravity: 0 }), /positive gravity/);
  assert.throws(() => classifyFallImpact({ verticalSpeed: -1, bodyHeight: 0 }), /positive body height/);
  assert.throws(() => classifyFallImpact({ verticalSpeed: Number.NaN }), /finite numbers/);
});

test('a bounded footprint never reports a shallower state than its deepest sample', () => {
  const shallow = classifyWaterContact({ ...COORDINATE, feetY: feetAt(.03), groundY: feetAt(.03), inWater: true }, {});
  const deep = classifyWaterContact({ ...COORDINATE, feetY: feetAt(.16), groundY: feetAt(.16), inWater: true }, {});
  const merged = mergeWaterContacts([shallow, deep]);
  assert.equal(merged.state, GDO_WATER_STATE.SWIMMING);
  assert.equal(merged.samples, 2);
  assert.equal(merged.merged, true);
  assert.equal(mergeWaterContacts([deep, shallow]).submersion, deep.submersion);
  assert.throws(() => mergeWaterContacts([]), /at least one contact/);
  // The profile caps how many samples a lookup may take.
  const budget = waterBudgetForProfile('low');
  assert.equal(budget.maxSamplesPerLookup, GDO_WATER_CONTACT_PROFILES.low.maxSamplesPerLookup);
  assert.equal(budget.maxSamplesPerLookup, GDO_LOW_PROFILE_BUDGETS.waterSamplesPerLookup);
  assert.equal(budget.maxSamplesPerStep, GDO_LOW_PROFILE_BUDGETS.waterSamplesPerStep);
  assert.equal(waterBudgetForProfile('balanced').maxSamplesPerLookup, 5);
  assert.throws(() => waterBudgetForProfile('nope'), /Unknown water-contact profile/);
});
