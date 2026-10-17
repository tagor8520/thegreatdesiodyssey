import * as THREE from 'three';
import { featureNamespace } from './FeatureVersions.js';

export const GDO_PLANT_WIND_NAMESPACE = featureNamespace('vegetationWind');

export const GDO_PLANT_WIND_PROFILES = Object.freeze({
  low: Object.freeze({
    amplitude: .055,
    maximumDisplacement: .06,
    defaultDirection: Object.freeze([.8192319346130006, .5734623242290992]),
    defaultStrength: .52,
    defaultGustiness: .24,
    reducedMotionStrength: .10,
    clockPeriodSeconds: 65_536,
    maxUniformWritesPerFrame: 1,
    cpuMatrixUpdatesPerFrame: 0,
    steadyFrameAllocations: 0,
  }),
});

const ROOT_DETAIL_ROLE = 2;
const CLOCK_DIVISOR_SECONDS = 64;
const CLOCK_WRAP = 1_024;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(minimum, maximum, value) {
  const amount = clamp((value - minimum) / (maximum - minimum), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

function smoothTriangle(cycles) {
  const phase = cycles - Math.floor(cycles);
  const linear = Math.abs(phase * 2 - 1);
  const smoothed = linear * linear * (3 - 2 * linear);
  return smoothed * 2 - 1;
}

function finiteDirection(value) {
  return value != null && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
    Math.hypot(value[0], value[1]) > 1e-6;
}

function finiteUnit(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function resolveProfile(profile) {
  return GDO_PLANT_WIND_PROFILES[profile] ?? GDO_PLANT_WIND_PROFILES.low;
}

/**
 * CPU mirror of the bounded whole-plant vertex deformation. It exists for
 * deterministic acceptance tests and tooling; the live renderer evaluates the
 * same field in the vertex shader and never rewrites vegetation matrices.
 */
export function samplePlantWindOffset({
  profile = 'low',
  positionY = 0,
  bendWeight = 0,
  detailRole = 0,
  phase = 0,
  stiffness = .5,
  worldX = 0,
  worldZ = 0,
  yaw = 0,
  timeMilliseconds = 0,
  direction,
  strength,
  gustiness,
  reducedMotion = false,
} = {}, out = {}) {
  const limits = resolveProfile(profile);
  const defaultDirection = limits.defaultDirection;
  let directionX = finiteDirection(direction) ? Number(direction[0]) : defaultDirection[0];
  let directionZ = finiteDirection(direction) ? Number(direction[1]) : defaultDirection[1];
  const directionLength = Math.hypot(directionX, directionZ);
  directionX /= directionLength;
  directionZ /= directionLength;
  const resolvedStrength = finiteUnit(strength) ? strength : limits.defaultStrength;
  const effectiveStrength = reducedMotion
    ? Math.min(resolvedStrength, limits.reducedMotionStrength)
    : resolvedStrength;
  const effectiveGustiness = reducedMotion ? 0 : (finiteUnit(gustiness) ? gustiness : limits.defaultGustiness);
  const resolvedTime = Number.isFinite(timeMilliseconds) && timeMilliseconds >= 0 ? timeMilliseconds : 0;
  const clock = (resolvedTime * .001 / CLOCK_DIVISOR_SECONDS) % CLOCK_WRAP;
  const spatialPhase = worldX * .013 + worldZ * .009;
  const stablePhase = clamp(phase, 0, 1);
  const slowWave = smoothTriangle(clock * 4 + stablePhase + spatialPhase);
  const gustEnvelope = .5 + .5 * smoothTriangle(clock + spatialPhase * .37);
  const turbulence = smoothTriangle(clock * 13 + stablePhase * 1.73 + spatialPhase * 2.1);
  const wave = slowWave * .82 + turbulence * gustEnvelope * effectiveGustiness * .18;
  const heightResponse = smoothstep(.01, .55, Math.max(0, positionY));
  const bendResponse = .78 + .22 * clamp(bendWeight, 0, 1);
  const rootMask = detailRole === ROOT_DETAIL_ROLE ? 0 : 1;
  const flexibility = 1.05 - clamp(stiffness, 0, 1) * .7;
  const displacement = limits.amplitude * effectiveStrength * wave * heightResponse * bendResponse *
    flexibility * rootMask;
  const cosine = Math.cos(yaw), sine = Math.sin(yaw);
  out.x = (cosine * directionX - sine * directionZ) * displacement;
  out.z = (sine * directionX + cosine * directionZ) * displacement;
  return out;
}

/** One shared, bounded wind field for every resident plant material. */
export class PlantWindState {
  constructor(options = {}) {
    const validOptions = options != null && typeof options === 'object';
    const profile = validOptions ? options.profile ?? 'low' : 'low';
    const direction = validOptions ? options.direction : undefined;
    const strength = validOptions ? options.strength : undefined;
    const gustiness = validOptions ? options.gustiness : undefined;
    const reducedMotion = validOptions ? options.reducedMotion ?? false : false;
    this.profile = Object.hasOwn(GDO_PLANT_WIND_PROFILES, profile) ? profile : 'low';
    this.limits = GDO_PLANT_WIND_PROFILES[this.profile];
    this.field = new THREE.Vector4();
    this.uniforms = Object.freeze({
      clock: Object.seal({ value: 0 }),
      field: Object.seal({ value: this.field }),
      amplitude: Object.seal({ value: this.limits.amplitude }),
    });
    this.directionX = this.limits.defaultDirection[0];
    this.directionZ = this.limits.defaultDirection[1];
    this.strength = this.limits.defaultStrength;
    this.gustiness = this.limits.defaultGustiness;
    this.reducedMotion = Boolean(reducedMotion);
    this.lastTimeMilliseconds = 0;
    this.lastUniformWrites = 0;
    this.totalClockWrites = 0;
    this.totalFieldWrites = 0;
    this.malformedInputs = validOptions && Object.hasOwn(GDO_PLANT_WIND_PROFILES, profile) ? 0 : 1;
    this.contextRestores = 0;
    this.disposed = false;
    this.configure({ direction, strength, gustiness });
  }

  #writeField() {
    const effectiveStrength = this.reducedMotion
      ? Math.min(this.strength, this.limits.reducedMotionStrength)
      : this.strength;
    const effectiveGustiness = this.reducedMotion ? 0 : this.gustiness;
    this.field.set(this.directionX, this.directionZ, effectiveStrength, effectiveGustiness);
    this.totalFieldWrites++;
  }

  configure(options = {}) {
    if (this.disposed) return false;
    const validOptions = options != null && typeof options === 'object';
    const direction = validOptions ? options.direction : undefined;
    const strength = validOptions ? options.strength : undefined;
    const gustiness = validOptions ? options.gustiness : undefined;
    let malformed = !validOptions;
    if (!validOptions) {
      this.directionX = this.limits.defaultDirection[0];
      this.directionZ = this.limits.defaultDirection[1];
      this.strength = this.limits.defaultStrength;
      this.gustiness = this.limits.defaultGustiness;
    }
    if (direction !== undefined) {
      if (finiteDirection(direction)) {
        const length = Math.hypot(direction[0], direction[1]);
        this.directionX = direction[0] / length;
        this.directionZ = direction[1] / length;
      } else {
        this.directionX = this.limits.defaultDirection[0];
        this.directionZ = this.limits.defaultDirection[1];
        malformed = true;
      }
    }
    if (strength !== undefined) {
      if (finiteUnit(strength)) this.strength = strength;
      else { this.strength = this.limits.defaultStrength; malformed = true; }
    }
    if (gustiness !== undefined) {
      if (finiteUnit(gustiness)) this.gustiness = gustiness;
      else { this.gustiness = this.limits.defaultGustiness; malformed = true; }
    }
    this.malformedInputs += Number(malformed);
    this.#writeField();
    return !malformed;
  }

  setReducedMotion(value) {
    if (this.disposed) return false;
    const next = Boolean(value);
    if (next === this.reducedMotion) return false;
    this.reducedMotion = next;
    this.#writeField();
    return true;
  }

  update(nowMilliseconds = this.lastTimeMilliseconds) {
    if (this.disposed) return 0;
    this.lastUniformWrites = 0;
    if (!Number.isFinite(nowMilliseconds) || nowMilliseconds < 0) {
      this.malformedInputs++;
      return 0;
    }
    this.lastTimeMilliseconds = nowMilliseconds;
    const clock = (nowMilliseconds * .001 / CLOCK_DIVISOR_SECONDS) % CLOCK_WRAP;
    if (clock === this.uniforms.clock.value) return 0;
    this.uniforms.clock.value = clock;
    this.lastUniformWrites = 1;
    this.totalClockWrites++;
    return 1;
  }

  handleContextRestored() {
    if (!this.disposed) this.contextRestores++;
  }

  get diagnostics() {
    return Object.freeze({
      namespace: GDO_PLANT_WIND_NAMESPACE,
      profile: this.profile,
      direction: Object.freeze([this.directionX, this.directionZ]),
      strength: this.field.z,
      gustiness: this.field.w,
      reducedMotion: this.reducedMotion,
      amplitude: this.limits.amplitude,
      maximumDisplacement: this.limits.maximumDisplacement,
      lastUniformWrites: this.lastUniformWrites,
      totalClockWrites: this.totalClockWrites,
      totalFieldWrites: this.totalFieldWrites,
      cpuMatrixUpdates: 0,
      steadyFrameAllocations: 0,
      malformedInputs: this.malformedInputs,
      contextRestores: this.contextRestores,
      disposed: this.disposed,
      limits: this.limits,
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
  }
}
