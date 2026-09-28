import * as THREE from 'three';
import { featureNamespace } from './FeatureVersions.js';
import { adoptPoolResources } from './LifecycleContract.js';
import { GEO_QUERY_MASK } from '../geo/GeoCollision.js';
import { GDO_CAMERA_FADE_DITHER_SIZE } from './CameraFade.js';

/**
 * `gdo:ambientLifeMotion:v1` replaces the coordinate bird/bee orbit-and-bob
 * animation with flat 2D sprites that travel long, per-appearance randomised,
 * non-looping paths and fade in and out of existence. Every sprite pose is
 * evaluated in one shared vertex program from a single clock uniform, so a
 * steady frame writes one uniform and zero instance matrices.
 */
export const GDO_AMBIENT_LIFE_NAMESPACE = featureNamespace('ambientLifeMotion');

/** Flat silhouette roles baked into the sprite vertex stream. */
export const GDO_AMBIENT_LIFE_SPRITE_PART = Object.freeze({
  BODY: 0,
  LEFT_WING: 1,
  RIGHT_WING: 2,
  TAIL: 3,
});

/**
 * Attribute contract. `position`/`color`/`gdoAmbientPart` are per-vertex and
 * describe the flat silhouette; every other stream is per-instance and is the
 * only data a resident sprite needs. No instance matrix is ever read or
 * written by the motion program.
 */
export const GDO_AMBIENT_LIFE_ATTRIBUTE_LAYOUT = Object.freeze({
  position: Object.freeze({ itemSize: 3, per: 'vertex', source: 'flat sprite offset (z always 0)' }),
  color: Object.freeze({ itemSize: 3, per: 'vertex', source: 'silhouette vertex colour' }),
  gdoAmbientPart: Object.freeze({ itemSize: 1, per: 'vertex', source: 'body/left-wing/right-wing/tail role' }),
  gdoAmbientAnchor: Object.freeze({ itemSize: 3, per: 'instance', source: 'habitat anchor x/ground y/z' }),
  gdoAmbientPath: Object.freeze({ itemSize: 4, per: 'instance', source: 'heading x/heading z/travel distance/lateral amplitude' }),
  gdoAmbientCycle: Object.freeze({ itemSize: 4, per: 'instance', source: 'cycle seconds/cycle offset/live fraction/seed' }),
  gdoAmbientForm: Object.freeze({ itemSize: 4, per: 'instance', source: 'hover/vertical amplitude/lateral rate/bob rate' }),
  gdoAmbientSprite: Object.freeze({ itemSize: 4, per: 'instance', source: 'scale/width/height/flap rate' }),
  gdoAmbientRange: Object.freeze({ itemSize: 2, per: 'instance', source: 'view distance/climb rate' }),
});

export const GDO_AMBIENT_LIFE_FAMILY_ORDER = Object.freeze(['bird', 'bee']);

/**
 * Bounded families. Travel distances, cycle lengths and altitudes are the
 * authoritative per-family ranges shared by the shader contract, the CPU
 * mirror, and the acceptance tests. The removed CPU orbits had a radius of
 * `.72–1.2` (birds) and `.13–.22` (bees), so every range here is measurably
 * longer than a closed loop.
 */
export const GDO_AMBIENT_LIFE_FAMILIES = Object.freeze({
  bird: Object.freeze({
    index: 0,
    sourceType: 10,
    spriteWidth: .54,
    spriteHeight: .30,
    triangles: 10,
    flapRate: Object.freeze([3.1, 4.4]),
    travel: Object.freeze([34, 74]),
    lateral: Object.freeze([.7, 2.1]),
    lateralRate: Object.freeze([1.6, 2.7]),
    cycleSeconds: Object.freeze([20, 38]),
    liveFraction: Object.freeze([.60, .74]),
    hover: Object.freeze([2.15, 3.30]),
    climb: Object.freeze([-.95, .95]),
    vertical: Object.freeze([.16, .42]),
    bobRate: Object.freeze([.45, .85]),
    scale: Object.freeze([.78, 1.32]),
    viewDistance: 168,
  }),
  bee: Object.freeze({
    index: 1,
    sourceType: 11,
    spriteWidth: .21,
    spriteHeight: .17,
    triangles: 10,
    flapRate: Object.freeze([8.5, 12.5]),
    travel: Object.freeze([6, 15]),
    lateral: Object.freeze([.35, 1.05]),
    lateralRate: Object.freeze([2.2, 3.6]),
    cycleSeconds: Object.freeze([9, 17]),
    liveFraction: Object.freeze([.52, .68]),
    hover: Object.freeze([.48, .78]),
    climb: Object.freeze([-.28, .28]),
    vertical: Object.freeze([.04, .10]),
    bobRate: Object.freeze([1.1, 1.9]),
    scale: Object.freeze([.82, 1.24]),
    viewDistance: 46,
  }),
});

/** Source decoration type → family. Anything else is not ambient life. */
export const GDO_AMBIENT_LIFE_SOURCE_TYPES = Object.freeze({
  10: 'bird',
  11: 'bee',
});

export const GDO_AMBIENT_LIFE_LIMITS = Object.freeze({
  maxOwners: 4,
  maxInstancesPerFamily: 30,
  maxFamilies: GDO_AMBIENT_LIFE_FAMILY_ORDER.length,
  maxAddedDrawCalls: GDO_AMBIENT_LIFE_FAMILY_ORDER.length,
  maxVisibleTriangles: 1_000,
  maxInstanceBytes: 8 * 1024,
  maxUniformWritesPerFrame: 1,
  cpuMatrixUpdatesPerFrame: 0,
  steadyFrameAllocations: 0,
});

/** Shared solver constants: the CPU mirror and the vertex program both use them. */
export const GDO_AMBIENT_LIFE_SOLVER = Object.freeze({
  fadeInFraction: .20,
  fadeOutFraction: .26,
  headingSpread: .72,
  bankRadians: .13,
  flapRadians: .34,
  travelScale: Object.freeze([.72, 1.28]),
  lateralScale: Object.freeze([.68, 1.32]),
  climbScale: Object.freeze([.55, 1.45]),
  reducedTravelFraction: .32,
  // Two wrapped clocks in one `vec2` uniform write: a long solver horizon
  // (matches the plant wind period) and a short fast clock for wing beats,
  // which would otherwise lose all float precision after hours of play.
  solverClockWrapSeconds: 65_536,
  flapClockWrapSeconds: 7,
});

const FLOAT_COUNT_PER_INSTANCE = 3 + 4 + 4 + 4 + 4 + 2;
const FAMILY_INDEX = Object.freeze(Object.fromEntries(
  GDO_AMBIENT_LIFE_FAMILY_ORDER.map((family, index) => [family, index]),
));

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(minimum, maximum, value) {
  const amount = clamp((value - minimum) / (maximum - minimum), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

export function ambientLifeHash(value, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** splitmix32: one stable 32-bit channel source for records and cycle rolls. */
function mixChannel(state) {
  state.value = (state.value + 0x9e3779b9) >>> 0;
  let mixed = state.value;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97) >>> 0;
  return ((mixed ^ (mixed >>> 15)) >>> 0) / 4_294_967_296;
}

function lerp(range, amount) {
  return range[0] + (range[1] - range[0]) * amount;
}

function malformed(source) {
  if (!(source.values instanceof Float32Array)) return 'ambient-life decorations require Float32 data';
  if (!Number.isInteger(source.stride) || source.stride < 6 || source.values.length % source.stride !== 0) {
    return 'ambient-life decoration stream is not aligned';
  }
  const recipe = GDO_AMBIENT_LIFE_FAMILIES[source.family];
  if (!recipe) return `unknown ambient-life family: ${source.family}`;
  const values = source.values, offset = source.offset;
  const numbers = [values[offset], values[offset + 1], values[offset + 2], values[offset + 3],
    values[offset + 4], values[offset + 5]];
  if (!numbers.every(Number.isFinite)) return 'ambient-life decoration record is not finite';
  if (values[offset + 2] <= 0 || values[offset + 2] > 4) return 'ambient-life decoration scale is out of range';
  return null;
}

/**
 * One frozen sprite record. Geography selects the habitat anchor; the stable
 * record id selects the long random path, its appearance cycle and silhouette
 * traits, so remounting a tile reproduces every byte without storing motion
 * state.
 */
export function deriveAmbientLifeRecord(owner, index, values, offset, family, salt, groundY = 0) {
  const error = malformed({ values, offset, stride: 6, family });
  if (error) throw new TypeError(error);
  const recipe = GDO_AMBIENT_LIFE_FAMILIES[family];
  const sourceScale = values[offset + 2];
  const sourcePhase = values[offset + 4];
  const state = { value: ambientLifeHash(`${salt}|${owner}|${family}|${index}`) };
  const heading = sourcePhase + (mixChannel(state) - .5) * GDO_AMBIENT_LIFE_SOLVER.headingSpread;
  const cycleSeconds = lerp(recipe.cycleSeconds, mixChannel(state));
  return Object.freeze({
    id: `${owner}:ambient:${index.toString(36)}`,
    owner,
    index,
    family,
    sourceType: recipe.sourceType,
    x: values[offset],
    z: values[offset + 1],
    groundY: Number.isFinite(groundY) ? groundY : 0,
    headingX: Math.cos(heading),
    headingZ: Math.sin(heading),
    travel: lerp(recipe.travel, mixChannel(state)),
    lateral: lerp(recipe.lateral, mixChannel(state)),
    lateralRate: lerp(recipe.lateralRate, mixChannel(state)),
    bobRate: lerp(recipe.bobRate, mixChannel(state)),
    hover: lerp(recipe.hover, mixChannel(state)),
    climb: lerp(recipe.climb, mixChannel(state)),
    vertical: lerp(recipe.vertical, mixChannel(state)),
    cycleSeconds,
    // The appearance offset stays inside one cycle so a window always starts
    // at `cycle * cycleSeconds - cycleOffset`.
    cycleOffset: mixChannel(state) * cycleSeconds,
    liveFraction: lerp(recipe.liveFraction, mixChannel(state)),
    phase: mixChannel(state) * Math.PI * 2,
    priority: ambientLifeHash(`${salt}|${owner}|${index}|priority`),
    seedChannel: mixChannel(state),
    scale: sourceScale * lerp(recipe.scale, mixChannel(state)),
    spriteWidth: recipe.spriteWidth,
    spriteHeight: recipe.spriteHeight,
    flapRate: lerp(recipe.flapRate, mixChannel(state)),
    viewDistance: recipe.viewDistance,
  });
}

/**
 * Absolute millisecond window of one appearance. `start`/`liveEnd` bound the
 * travel and `end` is the cycle boundary where the sprite is dormant.
 */
export function ambientLifeCycleWindow(record, cycle, out = {}) {
  const start = (cycle * record.cycleSeconds - record.cycleOffset) * 1_000;
  out.start = start;
  out.liveEnd = start + record.liveFraction * record.cycleSeconds * 1_000;
  out.end = start + record.cycleSeconds * 1_000;
  return out;
}

/**
 * Per-appearance plan. Every new cycle re-rolls heading, distance and climb
 * from the record seed, so no two appearances walk the same route and none of
 * them can close a loop: travel advances monotonically along one heading while
 * the bounded lateral sway keeps the heading deviation far below a full turn.
 */
export function rollAmbientLifePath(record, cycle, out = {}) {
  const state = { value: (record.priority ^ Math.imul((cycle | 0) + 1, 0x9e3779b1)) >>> 0 };
  const headingOffset = (mixChannel(state) - .5) * GDO_AMBIENT_LIFE_SOLVER.headingSpread;
  const cosine = Math.cos(headingOffset), sine = Math.sin(headingOffset);
  out.headingX = record.headingX * cosine - record.headingZ * sine;
  out.headingZ = record.headingX * sine + record.headingZ * cosine;
  out.travel = record.travel * lerp(GDO_AMBIENT_LIFE_SOLVER.travelScale, mixChannel(state));
  out.lateral = record.lateral * lerp(GDO_AMBIENT_LIFE_SOLVER.lateralScale, mixChannel(state));
  out.climb = record.climb * lerp(GDO_AMBIENT_LIFE_SOLVER.climbScale, mixChannel(state));
  out.cycle = cycle | 0;
  return out;
}

/**
 * CPU mirror of the shared vertex program. The shader remains authoritative for
 * rendering; this mirror reproduces the same channels and bounds so acceptance
 * tests can prove determinism, travel length, non-looping routes, the existence
 * envelope and the reduced-motion pose without a WebGL context.
 */
export function sampleAmbientLifePose(record, timeMilliseconds, {
  reducedMotion = false,
  cameraPosition = null,
} = {}, out = {}) {
  // The mirror accepts any finite clock, including the negative times that
  // belong to the first appearance window of a sample; the renderer clock is
  // monotonic and wrapped at `solverClockWrapSeconds` for float precision.
  const time = Number.isFinite(timeMilliseconds) ? timeMilliseconds : 0;
  const plan = rollAmbientLifePath(record, reducedMotion ? 0 : Math.floor((time * .001 + record.cycleOffset) / record.cycleSeconds));
  if (reducedMotion) {
    // Reduced motion parks the sprite beside its habitat anchor with a fixed
    // silhouette: no clock term, no flap, no appearance envelope flicker.
    out.x = record.x + plan.headingX * record.travel * GDO_AMBIENT_LIFE_SOLVER.reducedTravelFraction;
    out.z = record.z + plan.headingZ * record.travel * GDO_AMBIENT_LIFE_SOLVER.reducedTravelFraction;
    out.y = record.groundY + record.hover + record.vertical * .25;
    out.existence = 1;
    out.travelled = record.travel * GDO_AMBIENT_LIFE_SOLVER.reducedTravelFraction;
    out.cycle = 0;
    out.live = true;
  } else {
    const shifted = (time * .001 + record.cycleOffset) / record.cycleSeconds;
    const age = shifted - Math.floor(shifted);
    const progress = clamp(age / record.liveFraction, 0, 1);
    const along = progress * plan.travel;
    const sway = plan.lateral * Math.sin(record.lateralRate * Math.PI * 2 * progress + record.phase) * (1 - .35 * progress);
    out.x = record.x + plan.headingX * along - plan.headingZ * sway;
    out.z = record.z + plan.headingZ * along + plan.headingX * sway;
    out.y = record.groundY + record.hover + plan.climb * (progress - .5) +
      record.vertical * Math.sin(Math.PI * 2 * record.bobRate * progress + record.phase);
    out.existence = smoothstep(0, GDO_AMBIENT_LIFE_SOLVER.fadeInFraction, progress) *
      (1 - smoothstep(1 - GDO_AMBIENT_LIFE_SOLVER.fadeOutFraction, 1, progress));
    out.travelled = along;
    out.cycle = plan.cycle;
    out.live = age < record.liveFraction;
  }
  out.visibility = 1;
  if (Array.isArray(cameraPosition) && cameraPosition.length === 3 && cameraPosition.every(Number.isFinite)) {
    const distance = Math.hypot(cameraPosition[0] - out.x, cameraPosition[1] - out.y, cameraPosition[2] - out.z);
    out.visibility = 1 - smoothstep(record.viewDistance * .62, record.viewDistance, distance);
  }
  out.headingX = plan.headingX;
  out.headingZ = plan.headingZ;
  return out;
}

function spriteQuad(x0, y0, x1, y1, color, part) {
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y0], [x1, y1], [x0, y1]];
  const positions = [], colors = [], parts = [];
  for (const [x, y] of corners) {
    positions.push(x, y, 0);
    colors.push(color[0], color[1], color[2]);
    parts.push(part);
  }
  return { positions, colors, parts };
}

/**
 * Flat 2D silhouettes. Every vertex sits on the sprite plane (`z = 0`); the
 * silhouette is composed from coplanar quads instead of the previous 3D box
 * clusters, so one sprite costs a handful of triangles and needs no texture,
 * no alpha test, and no transparency.
 */
export function createAmbientSpriteData(family) {
  const recipe = GDO_AMBIENT_LIFE_FAMILIES[family];
  if (!recipe) throw new RangeError(`Unknown ambient-life family: ${family}`);
  const pieces = family === 'bird'
    ? [
      spriteQuad(-.44, -.13, .36, .13, [.13, .11, .10], GDO_AMBIENT_LIFE_SPRITE_PART.BODY),
      spriteQuad(.30, -.10, .50, .10, [.11, .09, .08], GDO_AMBIENT_LIFE_SPRITE_PART.BODY),
      spriteQuad(-.92, -.30, -.40, .06, [.16, .13, .11], GDO_AMBIENT_LIFE_SPRITE_PART.TAIL),
      spriteQuad(-.30, .10, .22, .58, [.20, .17, .15], GDO_AMBIENT_LIFE_SPRITE_PART.LEFT_WING),
      spriteQuad(-.30, -.58, .22, -.10, [.20, .17, .15], GDO_AMBIENT_LIFE_SPRITE_PART.RIGHT_WING),
    ]
    : [
      spriteQuad(-.30, -.16, .28, .16, [.88, .50, .025], GDO_AMBIENT_LIFE_SPRITE_PART.BODY),
      spriteQuad(-.06, -.16, .10, .16, [.09, .06, .03], GDO_AMBIENT_LIFE_SPRITE_PART.BODY),
      spriteQuad(.28, -.11, .46, .11, [.12, .08, .04], GDO_AMBIENT_LIFE_SPRITE_PART.BODY),
      spriteQuad(-.18, .12, .12, .52, [.66, .80, .88], GDO_AMBIENT_LIFE_SPRITE_PART.LEFT_WING),
      spriteQuad(-.18, -.52, .12, -.12, [.66, .80, .88], GDO_AMBIENT_LIFE_SPRITE_PART.RIGHT_WING),
    ];
  const positions = new Float32Array(pieces.length * 18);
  const colors = new Float32Array(pieces.length * 18);
  const parts = new Float32Array(pieces.length * 6);
  let positionCursor = 0, partCursor = 0;
  for (const piece of pieces) {
    positions.set(piece.positions, positionCursor);
    colors.set(piece.colors, positionCursor);
    parts.set(piece.parts, partCursor);
    positionCursor += piece.positions.length;
    partCursor += piece.parts.length;
  }
  return Object.freeze({
    family,
    namespace: GDO_AMBIENT_LIFE_NAMESPACE,
    positions,
    colors,
    parts,
    triangles: positions.length / 9,
    flat: true,
    width: recipe.spriteWidth,
    height: recipe.spriteHeight,
    runtimeCsgOperations: 0,
    collisionProxies: 0,
  });
}

function ambientFadeDiscard() {
  return `
  if (vGdoAmbientFade > 0.001) {
    if (texture2D(gdoCameraDither, gl_FragCoord.xy / ${GDO_CAMERA_FADE_DITHER_SIZE}.0).r < vGdoAmbientFade) discard;
  }`;
}

const VERTEX_DECLARATIONS = `
attribute vec3 gdoAmbientAnchor;
attribute vec4 gdoAmbientPath;
attribute vec4 gdoAmbientCycle;
attribute vec4 gdoAmbientForm;
attribute vec4 gdoAmbientSprite;
attribute vec2 gdoAmbientRange;
attribute float gdoAmbientPart;
attribute float gdoAmbientFade;
varying float vGdoAmbientFade;
uniform vec2 gdoAmbientClock;
uniform float gdoAmbientReduced;
float gdoAmbientHash(vec2 p) {
  vec3 q = fract(vec3(p.x, p.y, p.x) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
vec2 gdoAmbientRoll(float seed, float cycle, float channel) {
  vec2 input = vec2(seed * 0.0137 + cycle * 0.719 + channel * 3.17,
    cycle * 0.311 + channel * 7.07 + seed * 0.0007);
  return vec2(gdoAmbientHash(input), gdoAmbientHash(input.yx + 19.19));
}
`;

function solverBody() {
  const solver = GDO_AMBIENT_LIFE_SOLVER;
  return `
  float gdoAmbientCycleSeconds = max(gdoAmbientCycle.x, 1.0);
  float gdoAmbientShifted = (gdoAmbientClock.x + gdoAmbientCycle.y) / gdoAmbientCycleSeconds;
  float gdoAmbientCycleIndex = floor(gdoAmbientShifted);
  float gdoAmbientAge = fract(gdoAmbientShifted);
  float gdoAmbientLive = clamp(gdoAmbientCycle.z, 0.05, 1.0);
  float gdoAmbientProgress = clamp(gdoAmbientAge / gdoAmbientLive, 0.0, 1.0);
  vec2 gdoAmbientRollA = gdoAmbientRoll(gdoAmbientCycle.w, gdoAmbientCycleIndex, 1.0);
  vec2 gdoAmbientRollB = gdoAmbientRoll(gdoAmbientCycle.w, gdoAmbientCycleIndex, 7.0);
  float gdoAmbientHeading = atan(gdoAmbientPath.y, gdoAmbientPath.x) + (gdoAmbientRollA.x - 0.5) * ${solver.headingSpread};
  vec2 gdoAmbientForward = vec2(cos(gdoAmbientHeading), sin(gdoAmbientHeading));
  vec2 gdoAmbientSide = vec2(-gdoAmbientForward.y, gdoAmbientForward.x);
  float gdoAmbientTravel = gdoAmbientPath.z * (${solver.travelScale[0]} + gdoAmbientRollA.y * ${solver.travelScale[1]});
  float gdoAmbientLateral = gdoAmbientPath.w * (${solver.lateralScale[0]} + gdoAmbientRollB.x * ${solver.lateralScale[1]});
  float gdoAmbientAlong = gdoAmbientProgress * gdoAmbientTravel;
  float gdoAmbientLateralPhase = gdoAmbientForm.z * 6.2831853 * gdoAmbientProgress + gdoAmbientCycle.w * 6.2831853;
  float gdoAmbientSway = gdoAmbientLateral * sin(gdoAmbientLateralPhase) * (1.0 - 0.35 * gdoAmbientProgress);
  float gdoAmbientClimb = gdoAmbientRange.y * (gdoAmbientProgress - 0.5) * (${solver.climbScale[0]} + gdoAmbientRollB.y * ${solver.climbScale[1]});
  float gdoAmbientBob = gdoAmbientForm.y * sin(6.2831853 * gdoAmbientForm.w * gdoAmbientProgress + gdoAmbientCycle.w * 6.2831853);
  vec3 gdoAmbientCenter = gdoAmbientAnchor + vec3(
    gdoAmbientForward.x * gdoAmbientAlong + gdoAmbientSide.x * gdoAmbientSway,
    gdoAmbientForm.x + gdoAmbientClimb + gdoAmbientBob,
    gdoAmbientForward.y * gdoAmbientAlong + gdoAmbientSide.y * gdoAmbientSway);
  float gdoAmbientExistence = smoothstep(0.0, ${solver.fadeInFraction}, gdoAmbientProgress) *
    (1.0 - smoothstep(${1 - solver.fadeOutFraction}, 1.0, gdoAmbientProgress));
  vec2 gdoAmbientOffset = position.xy * vec2(gdoAmbientSprite.y, gdoAmbientSprite.z) * 0.5;
  float gdoAmbientWing = step(0.5, gdoAmbientPart) * (1.0 - 2.0 * step(1.5, gdoAmbientPart)) *
    (1.0 - step(2.5, gdoAmbientPart));
  float gdoAmbientFlap = gdoAmbientWing * ${solver.flapRadians} *
    sin(6.2831853 * gdoAmbientClock.y * gdoAmbientSprite.w + gdoAmbientCycle.w * 6.2831853);
  float gdoAmbientFlapCos = cos(gdoAmbientFlap), gdoAmbientFlapSin = sin(gdoAmbientFlap);
  gdoAmbientOffset = vec2(gdoAmbientOffset.x * gdoAmbientFlapCos - gdoAmbientOffset.y * gdoAmbientFlapSin,
    gdoAmbientOffset.x * gdoAmbientFlapSin + gdoAmbientOffset.y * gdoAmbientFlapCos);
  vec2 gdoAmbientViewForward = (viewMatrix * vec4(gdoAmbientForward.x, 0.0, gdoAmbientForward.y, 0.0)).xy;
  float gdoAmbientFacing = length(gdoAmbientViewForward) > 0.001 ? atan(gdoAmbientViewForward.y, gdoAmbientViewForward.x) : 0.0;
  float gdoAmbientSpin = gdoAmbientFacing + ${solver.bankRadians} * sin(gdoAmbientLateralPhase);
  float gdoAmbientSpinCos = cos(gdoAmbientSpin), gdoAmbientSpinSin = sin(gdoAmbientSpin);
  gdoAmbientOffset = vec2(gdoAmbientOffset.x * gdoAmbientSpinCos - gdoAmbientOffset.y * gdoAmbientSpinSin,
    gdoAmbientOffset.x * gdoAmbientSpinSin + gdoAmbientOffset.y * gdoAmbientSpinCos);
  if (gdoAmbientReduced > 0.5) {
    gdoAmbientCenter = gdoAmbientAnchor + vec3(gdoAmbientPath.x * gdoAmbientPath.z * ${solver.reducedTravelFraction},
      gdoAmbientForm.x, gdoAmbientPath.y * gdoAmbientPath.z * ${solver.reducedTravelFraction});
    gdoAmbientOffset = position.xy * vec2(gdoAmbientSprite.y, gdoAmbientSprite.z) * 0.5;
    gdoAmbientExistence = 1.0;
  }
  float gdoAmbientCameraDistance = distance(cameraPosition, gdoAmbientCenter);
  float gdoAmbientVisibility = 1.0 - smoothstep(gdoAmbientRange.x * 0.62, gdoAmbientRange.x, gdoAmbientCameraDistance);
  vec2 gdoAmbientViewOffset = gdoAmbientOffset * gdoAmbientSprite.x * gdoAmbientExistence * gdoAmbientVisibility;
  vGdoAmbientFade = clamp(gdoAmbientFade, 0.0, 1.0) * gdoAmbientVisibility;
`;
}

const PROJECT_VERTEX = `
  vec4 gdoAmbientViewCenter = viewMatrix * vec4(gdoAmbientCenter, 1.0);
  vec4 mvPosition = gdoAmbientViewCenter;
  mvPosition.xy += gdoAmbientViewOffset;
  gl_Position = projectionMatrix * mvPosition;
`;

/**
 * One shared billboard program for both families. Sprites are projected in
 * view space (always facing the camera), never read `instanceMatrix`, and take
 * every pose value from the instanced streams plus one clock uniform.
 */
export function createAmbientLifeMaterial({ ditherUniform = null } = {}) {
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    fog: true,
    // `LAY-06`: fading a sprite is a screen-door *discard*, never a blend.
    transparent: false,
  });
  material.name = `${GDO_AMBIENT_LIFE_NAMESPACE}:sprite`;
  const uniforms = Object.freeze({
    clock: Object.seal({ value: new THREE.Vector2() }),
    reduced: Object.seal({ value: 0 }),
  });
  if (ditherUniform != null && !ditherUniform.value?.isTexture) {
    throw new TypeError('Ambient life needs the shared camera-fade dither texture');
  }
  material.userData.gdoAmbientLife = Object.freeze({
    namespace: GDO_AMBIENT_LIFE_NAMESPACE,
    billboard: 'view-plane-2d',
    uniforms,
    cpuMatrixUpdatesPerFrame: 0,
  });
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, {
      gdoAmbientClock: uniforms.clock,
      gdoAmbientReduced: uniforms.reduced,
    });
    if (ditherUniform) shader.uniforms.gdoCameraDither = ditherUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECLARATIONS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${solverBody()}`)
      .replace('#include <project_vertex>', PROJECT_VERTEX);
    if (ditherUniform) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vGdoAmbientFade;\nuniform sampler2D gdoCameraDither;`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${ambientFadeDiscard()}`);
    }
  };
  material.customProgramCacheKey = () =>
    `${GDO_AMBIENT_LIFE_NAMESPACE}:sprite${ditherUniform ? ':camera-fade' : ''}`;
  material.userData.gdoAmbientCameraFade = ditherUniform
    ? Object.freeze({
      namespace: GDO_AMBIENT_LIFE_NAMESPACE,
      ditherSize: GDO_CAMERA_FADE_DITHER_SIZE,
      blended: false,
      depthWriting: true,
      discard: 'screen-door',
    })
    : null;
  return material;
}

function instanceAttribute(array, itemSize) {
  const attribute = new THREE.InstancedBufferAttribute(array, itemSize);
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}

function geometryBytes(geometry) {
  let bytes = geometry.index?.array?.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes ?? {})) bytes += attribute.array?.byteLength ?? 0;
  return bytes;
}

/**
 * Global, owner-scoped sprite pools: one flat 2D draw per family regardless of
 * how many tiles are resident. Repacking is bounded by the family caps, runs
 * only when ownership changes, and prunes deterministically by stable record
 * priority instead of overflowing the ceiling.
 */
export class AmbientLifePools {
  constructor(scene, {
    material = null,
    terrainSeed = 0,
    seedSalt = GDO_AMBIENT_LIFE_NAMESPACE,
    renderOrder = 0,
    reducedMotion = false,
    limits = GDO_AMBIENT_LIFE_LIMITS,
    resolveGroundHeight = null,
    layer = null,
    ledger = null,
  } = {}) {
    if (!scene?.add || !Number.isFinite(terrainSeed) || typeof seedSalt !== 'string') {
      throw new TypeError('AmbientLifePools requires a scene, terrain seed, and seed salt');
    }
    if (!limits || limits.maxFamilies !== GDO_AMBIENT_LIFE_FAMILY_ORDER.length ||
        !Number.isInteger(limits.maxInstancesPerFamily) || limits.maxInstancesPerFamily <= 0 ||
        !Number.isInteger(limits.maxOwners) || limits.maxOwners <= 0) {
      throw new RangeError('Invalid ambient-life pool limits');
    }
    this.limits = limits;
    this.layer = layer;
    this.stride = 6;
    this.seedSalt = seedSalt;
    this.terrainSeed = terrainSeed;
    this.resolveGroundHeight = resolveGroundHeight;
    this.owners = new Map();
    this.material = material ?? createAmbientLifeMaterial();
    this.geometries = GDO_AMBIENT_LIFE_FAMILY_ORDER.map(family => {
      const data = createAmbientSpriteData(family);
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.name = `${GDO_AMBIENT_LIFE_NAMESPACE}:${family}`;
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
      geometry.setAttribute('gdoAmbientPart', new THREE.BufferAttribute(data.parts, 1));
      geometry.setAttribute('gdoAmbientAnchor', instanceAttribute(new Float32Array(limits.maxInstancesPerFamily * 3), 3));
      geometry.setAttribute('gdoAmbientPath', instanceAttribute(new Float32Array(limits.maxInstancesPerFamily * 4), 4));
      geometry.setAttribute('gdoAmbientCycle', instanceAttribute(new Float32Array(limits.maxInstancesPerFamily * 4), 4));
      geometry.setAttribute('gdoAmbientForm', instanceAttribute(new Float32Array(limits.maxInstancesPerFamily * 4), 4));
      geometry.setAttribute('gdoAmbientSprite', instanceAttribute(new Float32Array(limits.maxInstancesPerFamily * 4), 4));
      geometry.setAttribute('gdoAmbientRange', instanceAttribute(new Float32Array(limits.maxInstancesPerFamily * 2), 2));
      // `LAY-06`: one screen-door fade level per instance, zero by default, so
      // the stream exists (and the shader reads a defined value) even when no
      // camera-fade policy is attached.
      geometry.setAttribute('gdoAmbientFade', instanceAttribute(new Float32Array(limits.maxInstancesPerFamily), 1));
      geometry.instanceCount = 0;
      geometry.userData.gdoAmbientSprite = Object.freeze({
        family, triangles: data.triangles, flat: true, runtimeCsgOperations: 0, collisionProxies: 0,
      });
      return geometry;
    });
    const fixedInstanceBytes = this.geometries.reduce((total, geometry) =>
      total + geometry.getAttribute('gdoAmbientAnchor').array.byteLength +
        geometry.getAttribute('gdoAmbientPath').array.byteLength +
        geometry.getAttribute('gdoAmbientCycle').array.byteLength +
        geometry.getAttribute('gdoAmbientForm').array.byteLength +
        geometry.getAttribute('gdoAmbientSprite').array.byteLength +
        geometry.getAttribute('gdoAmbientRange').array.byteLength +
        geometry.getAttribute('gdoAmbientFade').array.byteLength, 0);
    if (fixedInstanceBytes > limits.maxInstanceBytes) {
      for (const geometry of this.geometries) geometry.dispose();
      throw new RangeError('Ambient-life fixed instance bytes exceed the low-profile cap');
    }
    this.group = new THREE.Group();
    this.group.name = GDO_AMBIENT_LIFE_NAMESPACE;
    this.meshes = this.geometries.map((geometry, index) => {
      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.name = `ambient-${GDO_AMBIENT_LIFE_FAMILY_ORDER[index]}`;
      // Sprites are projected into view space by the vertex program, so the
      // authored bounds and the object matrix never describe their position.
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = renderOrder;
      mesh.userData.geoLayer = layer;
      mesh.userData.gdoAmbientLifeFamily = GDO_AMBIENT_LIFE_FAMILY_ORDER[index];
      mesh.userData.visualOnly = true;
      this.group.add(mesh);
      return mesh;
    });
    scene.add(this.group);
    // `FND-07`: sprites, their fixed instance buffers, and the shared material
    // join the same ledger every other pool uses.
    this.lifecycleScope = ledger ? adoptPoolResources(ledger, GDO_AMBIENT_LIFE_NAMESPACE, {
      geometries: this.geometries,
      material: this.material,
      meshes: this.meshes,
      node: this.group,
    }) : null;
    this.familyCounts = GDO_AMBIENT_LIFE_FAMILY_ORDER.map(() => 0);
    // `LIF-02`: the packed records, per family, so the screen-space scheduler
    // reads the same instance stream the GPU draws.
    this.packedRecords = GDO_AMBIENT_LIFE_FAMILY_ORDER.map(() => []);
    this.entries = 0;
    this.repacks = 0;
    this.instanceUploads = 0;
    this.lastUniformWrites = 0;
    this.totalClockWrites = 0;
    this.malformedInputs = 0;
    this.contextRestorations = 0;
    // `LAY-06` bookkeeping: the cached per-instance levels, the uploads they
    // cost, and the policy that decided them.
    this.fadeLevels = GDO_AMBIENT_LIFE_FAMILY_ORDER.map(() =>
      new Float32Array(limits.maxInstancesPerFamily).fill(-1));
    this.fadeSlots = GDO_AMBIENT_LIFE_FAMILY_ORDER.map(() =>
      new Int32Array(limits.maxInstancesPerFamily).fill(-1));
    this.fadeUploadFamilies = 0;
    this.cameraFade = null;
    this.fadeUploads = 0;
    this.lastFade = null;
    this.fadeDecisions = 0;
    this.fadeRejected = 0;
    // `LIF-02` scheduling counters: parked instances and the attribute uploads
    // they caused, so churn stays a measured number.
    this.visibilityUploads = 0;
    this.visibleEntries = 0;
    this.parkedEntries = 0;
    this.lastSchedule = null;
    this.capEvents = { candidates: 0, kept: 0, pruned: 0, families: GDO_AMBIENT_LIFE_FAMILY_ORDER.map(() => 0) };
    this.reducedMotion = Boolean(reducedMotion);
    this.uniforms = this.material.userData.gdoAmbientLife?.uniforms ?? null;
    if (this.uniforms) this.uniforms.reduced.value = this.reducedMotion ? 1 : 0;
    this.disposed = false;
  }

  addOwner(owner, values, stride = 6) {
    if (this.disposed) throw new Error('AmbientLifePools is disposed');
    if (typeof owner !== 'string' || !owner) throw new TypeError('Ambient-life owner must be a stable string');
    if (!(values instanceof Float32Array) || !Number.isInteger(stride) || stride < 6 || values.length % stride !== 0) {
      throw new TypeError('Ambient-life owners require aligned decoration data');
    }
    const existing = this.owners.get(owner);
    const prospectiveOwners = this.owners.size - Number(Boolean(existing)) + Number(values.length > 0);
    if (prospectiveOwners > this.limits.maxOwners) throw new RangeError('Ambient-life resident owner cap exceeded');
    // Validate every ambient record before mutating pool state so a malformed
    // stream can never leave a partially committed owner behind.
    for (let offset = 0; offset + 5 < values.length; offset += stride) {
      const family = GDO_AMBIENT_LIFE_SOURCE_TYPES[Math.round(values[offset + 3])];
      if (!family) continue;
      deriveAmbientLifeRecord(owner, offset / stride, values, offset, family, this.seedSalt, 0);
    }
    if (values.length) this.owners.set(owner, new Float32Array(values));
    else this.owners.delete(owner);
    this.stride = stride;
    this._repack();
    return this.ownerRecordCount(owner);
  }

  ownerRecordCount(owner) {
    const values = this.owners.get(owner);
    if (!values) return 0;
    const stride = this.stride ?? 6;
    let count = 0;
    for (let offset = 0; offset + 5 < values.length; offset += stride) {
      if (GDO_AMBIENT_LIFE_SOURCE_TYPES[Math.round(values[offset + 3])]) count++;
    }
    return count;
  }

  removeOwner(owner) {
    if (this.disposed || !this.owners.delete(owner)) return false;
    this._repack();
    return true;
  }

  _groundHeight(x, z) {
    const height = this.resolveGroundHeight ? this.resolveGroundHeight(x, z, this.terrainSeed) : 0;
    return Number.isFinite(height) ? height : 0;
  }

  _repack() {
    const stride = this.stride ?? 6;
    const cursors = GDO_AMBIENT_LIFE_FAMILY_ORDER.map(() => 0);
    const candidates = GDO_AMBIENT_LIFE_FAMILY_ORDER.map(() => 0);
    const packedByFamily = this._packedByFamily ??= new Map();
    const families = GDO_AMBIENT_LIFE_FAMILY_ORDER.map((family, familyIndex) => {
      const records = [];
      for (const [owner, values] of [...this.owners.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        for (let offset = 0; offset + 5 < values.length; offset += stride) {
          const recordFamily = GDO_AMBIENT_LIFE_SOURCE_TYPES[Math.round(values[offset + 3])];
          if (!recordFamily || FAMILY_INDEX[recordFamily] !== familyIndex) continue;
          records.push(deriveAmbientLifeRecord(owner, offset / stride, values, offset, recordFamily, this.seedSalt,
            this._groundHeight(values[offset], values[offset + 1])));
        }
      }
      records.sort((first, second) => first.priority - second.priority || first.id.localeCompare(second.id));
      candidates[familyIndex] = records.length;
      const kept = records.slice(0, this.limits.maxInstancesPerFamily);
      const geometry = this.geometries[familyIndex];
      const anchor = geometry.getAttribute('gdoAmbientAnchor').array;
      const path = geometry.getAttribute('gdoAmbientPath').array;
      const cycle = geometry.getAttribute('gdoAmbientCycle').array;
      const form = geometry.getAttribute('gdoAmbientForm').array;
      const sprite = geometry.getAttribute('gdoAmbientSprite').array;
      const range = geometry.getAttribute('gdoAmbientRange').array;
      for (let index = 0; index < kept.length; index++) {
        const record = kept[index], cursor = cursors[familyIndex]++;
        anchor.set([record.x, record.groundY, record.z], cursor * 3);
        path.set([record.headingX, record.headingZ, record.travel, record.lateral], cursor * 4);
        cycle.set([record.cycleSeconds, record.cycleOffset, record.liveFraction, record.seedChannel], cursor * 4);
        form.set([record.hover, record.vertical, record.lateralRate, record.bobRate], cursor * 4);
        sprite.set([record.scale, record.spriteWidth, record.spriteHeight, record.flapRate], cursor * 4);
        range.set([record.viewDistance, record.climb], cursor * 2);
      }
      for (const name of ['gdoAmbientAnchor', 'gdoAmbientPath', 'gdoAmbientCycle', 'gdoAmbientForm',
        'gdoAmbientSprite', 'gdoAmbientRange', 'gdoAmbientFade']) {
        geometry.getAttribute(name).needsUpdate = true;
      }
      // A fresh instance stream starts opaque; the next fade pass re-derives it.
      this.fadeLevels?.[familyIndex]?.fill(-1);
      geometry.instanceCount = kept.length;
      packedByFamily.set(family, kept);
      // The repack just rewrote the authored scales; drop the cached verdicts so
      // the next scheduling pass re-derives every visibility.
      this.scheduledVisibility = null;
      return family;
    });
    this.familyCounts = cursors;
    this.entries = cursors.reduce((total, value) => total + value, 0);
    this.packedRecords = families.map(family => this._packedByFamily.get(family) ?? []);
    this.capEvents = {
      candidates: candidates.reduce((total, value) => total + value, 0),
      kept: this.entries,
      pruned: candidates.reduce((total, value, index) => total + Math.max(0, value - cursors[index]), 0),
      families: Object.freeze(candidates.map((value, index) => Math.max(0, value - cursors[index]))),
    };
    this.instanceUploads += families.length;
    this.repacks++;
  }

  /** Per-frame work: one clock uniform write, zero matrix or attribute writes. */
  update(nowMilliseconds = this.lastTimeMilliseconds ?? 0) {
    if (this.disposed) return 0;
    this.lastUniformWrites = 0;
    if (!Number.isFinite(nowMilliseconds) || nowMilliseconds < 0) {
      this.malformedInputs++;
      return 0;
    }
    this.lastTimeMilliseconds = nowMilliseconds;
    if (!this.uniforms) return 0;
    const solver = (nowMilliseconds * .001) % GDO_AMBIENT_LIFE_SOLVER.solverClockWrapSeconds;
    const flap = (nowMilliseconds * .001) % GDO_AMBIENT_LIFE_SOLVER.flapClockWrapSeconds;
    const value = this.uniforms.clock.value;
    if (value.x === solver && value.y === flap) return 0;
    value.set(solver, flap);
    this.lastUniformWrites = 1;
    this.totalClockWrites++;
    return 1;
  }

  /**
   * `LIF-02` screen-space/activity scheduling.
   *
   * The scheduler decides which resident sources are worth drawing (on screen,
   * large enough to read, inside their appearance window, inside the per-frame
   * budget). A parked source gets a zero scale in the very instance attribute the
   * vertex program multiplies its offset by, so parking adds no draw call, no
   * blend work and no shader branch, and the stream only re-uploads when a
   * verdict actually changes.
   */
  scheduleVisibility(scheduler, view = {}) {
    if (this.disposed || !scheduler?.begin) return null;
    scheduler.begin(view);
    const nowMilliseconds = Number.isFinite(view.nowMilliseconds) ? view.nowMilliseconds : 0;
    let offered = 0;
    // Pass one: every resident sprite states its case. The offer order is the
    // packed instance order, so offer index `n` is instance `n` of its family.
    for (let familyIndex = 0; familyIndex < GDO_AMBIENT_LIFE_FAMILY_ORDER.length; familyIndex++) {
      const records = this.packedRecords[familyIndex];
      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        const cycle = Math.floor(nowMilliseconds / (record.cycleSeconds * 1_000));
        const window = ambientLifeCycleWindow(record, cycle, this._schedulerWindow ??= {});
        scheduler.evaluate({
          id: record.id, familyIndex, x: record.x, y: record.groundY + record.hover, z: record.z,
          radius: Math.max(record.spriteWidth, record.spriteHeight) * record.scale * .5,
          viewDistance: record.viewDistance, priority: record.priority,
          // The shader's own appearance envelope: a source is live between its
          // window start and its live end, and dormant for the rest of the cycle.
          windowLive: nowMilliseconds >= window.start && nowMilliseconds <= window.liveEnd,
        });
        offered++;
      }
    }
    const summary = scheduler.finish();
    // Pass two: the verdicts become the geometry. A parked sprite gets a zero
    // scale in the attribute the vertex program multiplies its offset by, and a
    // sprite that keeps its verdict keeps its bytes — uploads only on change.
    const visibility = this.scheduledVisibility ??= GDO_AMBIENT_LIFE_FAMILY_ORDER.map(() =>
      new Float32Array(this.limits.maxInstancesPerFamily).fill(-1));
    let offer = 0;
    for (let familyIndex = 0; familyIndex < GDO_AMBIENT_LIFE_FAMILY_ORDER.length; familyIndex++) {
      const records = this.packedRecords[familyIndex];
      const attribute = this.geometries[familyIndex].getAttribute('gdoAmbientSprite');
      const scales = visibility[familyIndex];
      for (let index = 0; index < records.length && offer < scheduler.decisionCount; index++, offer++) {
        const next = scheduler.visibilityAt(offer);
        if (scales[index] === next) continue;
        scales[index] = next;
        attribute.array[index * 4] = records[index].scale * next;
        this.visibilityUploads++;
        attribute.needsUpdate = true;
      }
    }
    // `entries` stays the resident count the pools own; the scheduling verdicts
    // live beside it so a reader can tell "resident" from "drawn".
    this.visibleEntries = summary.active;
    this.parkedEntries = summary.parked;
    this.lastSchedule = Object.freeze({ ...summary, offered });
    return this.lastSchedule;
  }

  /**
   * `LAY-06`: one camera-fade pass over the resident sprites.
   *
   * Every resident sprite is offered to the policy as an *eligible* candidate
   * (ambient life is exactly the clutter the research allows to fade), the
   * policy decides the verdicts for this frame, the levels are stepped once, and
   * only instances whose level actually changed re-upload their slice of the
   * fade stream. A sprite that is not fading costs nothing.
   */
  applyCameraFade(cameraFade, {
    cameraX = 0, cameraY = 0, cameraZ = 0,
    avatarX = 0, avatarY = 0, avatarZ = 0,
    dtMilliseconds = 16.7,
  } = {}) {
    if (this.disposed || !cameraFade?.beginFrame || !cameraFade?.consider) return null;
    this.cameraFade = cameraFade;
    cameraFade.beginFrame({ cameraX, cameraY, cameraZ, avatarX, avatarY, avatarZ });
    let offered = 0, rejected = 0;
    for (let familyIndex = 0; familyIndex < GDO_AMBIENT_LIFE_FAMILY_ORDER.length; familyIndex++) {
      const records = this.packedRecords[familyIndex];
      const slots = this.fadeSlots[familyIndex];
      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        const slot = cameraFade.consider({
          id: record.id,
          // Ambient life is clutter: explicitly eligible, and never a camera
          // blocker, so it can fade where a structural mass would compress.
          mask: GEO_QUERY_MASK.FADE_ELIGIBLE,
          x: record.x,
          y: record.groundY + record.hover,
          z: record.z,
          radius: Math.max(record.spriteWidth, record.spriteHeight) * record.scale * .5,
        });
        slots[index] = slot;
        if (slot < 0) { rejected++; this.fadeRejected++; continue; }
        offered++;
        this.fadeDecisions++;
      }
    }
    // One step per frame, after every candidate has stated its case, so a frame's
    // verdict depends on that frame's inputs alone.
    const stepped = cameraFade.advanceFrame(dtMilliseconds);
    let changed = 0, faded = 0;
    for (let familyIndex = 0; familyIndex < GDO_AMBIENT_LIFE_FAMILY_ORDER.length; familyIndex++) {
      const records = this.packedRecords[familyIndex];
      const slots = this.fadeSlots[familyIndex];
      const attribute = this.geometries[familyIndex].getAttribute('gdoAmbientFade');
      const cache = this.fadeLevels[familyIndex];
      let familyUploads = 0;
      for (let index = 0; index < records.length; index++) {
        const slot = slots[index];
        const level = slot >= 0 ? cameraFade.levelAt(slot) : 0;
        if (level > 0) faded++;
        if (cache[index] === level) continue;
        cache[index] = level;
        attribute.array[index] = level;
        attribute.needsUpdate = true;
        this.fadeUploads++;
        familyUploads++;
        changed++;
      }
      if (familyUploads > 0) this.fadeUploadFamilies++;
    }
    this.lastFade = Object.freeze({
      offered, rejected, changed, faded, stepped,
      avatarLevel: cameraFade.diagnostics.avatarLevel,
      levels: cameraFade.levels,
      ditherSize: cameraFade.ditherSize,
    });
    return this.lastFade;
  }

  setReducedMotion(value) {
    if (this.disposed) return false;
    const next = Boolean(value);
    if (next === this.reducedMotion) return false;
    this.reducedMotion = next;
    if (this.uniforms) this.uniforms.reduced.value = next ? 1 : 0;
    return true;
  }

  handleContextRestored() {
    if (this.disposed) return false;
    for (const geometry of this.geometries) {
      for (const name of ['gdoAmbientAnchor', 'gdoAmbientPath', 'gdoAmbientCycle', 'gdoAmbientForm',
        'gdoAmbientSprite', 'gdoAmbientRange', 'gdoAmbientFade']) {
        geometry.getAttribute(name).needsUpdate = true;
      }
      for (const name of ['position', 'color', 'gdoAmbientPart']) geometry.getAttribute(name).needsUpdate = true;
      this.instanceUploads++;
    }
    this.contextRestorations++;
    return true;
  }

  /** Frozen copy of the resident instance streams for deterministic tooling. */
  spriteSnapshot() {
    return Object.freeze(GDO_AMBIENT_LIFE_FAMILY_ORDER.map((family, familyIndex) => {
      const geometry = this.geometries[familyIndex];
      const count = geometry.instanceCount;
      const slice = name => [...geometry.getAttribute(name).array.slice(0, count *
        geometry.getAttribute(name).itemSize)];
      return Object.freeze({
        family,
        count,
        triangles: count * geometry.userData.gdoAmbientSprite.triangles,
        anchor: Object.freeze(slice('gdoAmbientAnchor')),
        path: Object.freeze(slice('gdoAmbientPath')),
        cycle: Object.freeze(slice('gdoAmbientCycle')),
        form: Object.freeze(slice('gdoAmbientForm')),
        sprite: Object.freeze(slice('gdoAmbientSprite')),
        range: Object.freeze(slice('gdoAmbientRange')),
        // `LAY-06`: the screen-door levels are frame state, not authored data, so
        // they travel beside the snapshot instead of inside it.
        fade: Object.freeze(slice('gdoAmbientFade')),
      });
    }));
  }

  fingerprint() {
    let hash = 2166136261;
    for (const record of this.spriteSnapshot()) {
      hash = ambientLifeHash(`${record.family}:${record.count}`, hash);
      for (const name of ['anchor', 'path', 'cycle', 'form', 'sprite', 'range']) {
        for (const value of record[name]) hash = ambientLifeHash(`${value}`, hash);
      }
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  get diagnostics() {
    const visibleTriangles = this.familyCounts.reduce((total, count, familyIndex) =>
      total + count * this.geometries[familyIndex].userData.gdoAmbientSprite.triangles, 0);
    const fadeLevels = [...this.fadeLevels[0], ...this.fadeLevels[1]].filter(level => level > 0).length;
    const geometryBytesTotal = this.geometries.reduce((total, geometry) => total + geometryBytes(geometry), 0);
    return Object.freeze({
      namespace: GDO_AMBIENT_LIFE_NAMESPACE,
      owners: this.owners.size,
      entries: this.entries,
      familyCounts: Object.freeze([...this.familyCounts]),
      activeDrawPools: this.familyCounts.filter(Boolean).length,
      addedDrawCalls: this.familyCounts.filter(Boolean).length,
      spriteTriangles: this.geometries[0]?.userData.gdoAmbientSprite.triangles ?? 0,
      visibleTriangles,
      instanceBytes: this.limits.maxInstanceBytes,
      geometryBytes: geometryBytesTotal,
      planar: true,
      repacks: this.repacks,
      instanceUploads: this.instanceUploads,
      uniformWrites: this.lastUniformWrites,
      totalClockWrites: this.totalClockWrites,
      cpuMatrixUpdates: 0,
      steadyFrameAllocations: 0,
      // `LIF-02`: screen-space scheduling — how many resident sprites are drawn,
      // how many are parked, and how many attribute uploads that caused.
      visibleEntries: this.visibleEntries,
      parkedEntries: this.parkedEntries,
      visibilityUploads: this.visibilityUploads,
      lastSchedule: this.lastSchedule,
      capEvents: Object.freeze({ ...this.capEvents, families: Object.freeze([...this.capEvents.families]) }),
      // `LAY-06`: how many resident sprites are mid-fade, what the pass cost,
      // and which policy decided it.
      fadeLevels,
      fadeUploads: this.fadeUploads,
      fadeUploadFamilies: this.fadeUploadFamilies,
      fadeDecisions: this.fadeDecisions,
      fadeRejected: this.fadeRejected,
      lastFade: this.lastFade,
      cameraFade: this.cameraFade?.diagnostics ?? null,
      reducedMotion: this.reducedMotion,
      malformedInputs: this.malformedInputs,
      contextRestorations: this.contextRestorations,
      limits: this.limits,
      disposed: this.disposed,
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.owners.clear();
    this.entries = 0;
    this.familyCounts = GDO_AMBIENT_LIFE_FAMILY_ORDER.map(() => 0);
    this.group.removeFromParent();
    this.group.clear();
    for (const geometry of this.geometries) geometry.dispose();
    if (this.material.userData.gdoAmbientLife) this.material.dispose();
    this.lifecycleScope?.disposeAll();
  }
}

/** Family lookups used by the world mount path and the debug tooling. */
export function ambientLifeFamilyForSourceType(type) {
  return GDO_AMBIENT_LIFE_SOURCE_TYPES[Math.round(type)] ?? null;
}

/** Bounded per-family triangle ceiling used by the fixture budget collector. */
export function ambientLifeSpriteTriangles(family) {
  const data = GDO_AMBIENT_LIFE_FAMILIES[family];
  return data ? data.triangles : 0;
}

export function ambientLifeInstanceFloats() {
  return FLOAT_COUNT_PER_INSTANCE;
}
