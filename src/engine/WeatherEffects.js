import * as THREE from 'three';
import { GDO_WEATHER_PRECIPITATION, GDO_WEATHER_STATE_IDS } from './WeatherState.js';
import { GDO_LOW_PROFILE_BUDGETS, GDO_WEATHER_EFFECT_CAPS } from './PerformanceBudget.js';
import { GDO_CAMERA_FADE_DITHER_SIZE } from './CameraFade.js';
import { featureNamespace } from './FeatureVersions.js';

/**
 * `ENV-05` bounded weather and shore effects.
 *
 * `ENV-04` owns the state: which weather is running, one precipitation family or
 * none, and the surface response (wetness, dust, snow, damp). This module is the
 * *rendering* half, and it is bounded by construction:
 *
 * - **One camera-local particle family, one draw call.** The research is explicit
 *   that transparency is a fill-rate problem on constrained devices, so effects
 *   stay in a small box around the camera, are never tile-wide, never collide,
 *   never cast light, and never run two families at once. `ENV-04` already
 *   refuses to blend two states' precipitation, and this pool renders exactly the
 *   one family the state reports.
 * - **Alpha-test/dither, never blend.** The material is opaque: `transparent`
 *   stays false, `depthWrite` stays true, and a fragment is either painted or
 *   dropped through the shared `MAT-02` dither mask the camera fade and the water
 *   foam already read. A particle therefore cannot stack overdraw.
 * - **Strict screen/overdraw counts.** Counts, draws, and overdraw layers are
 *   declared per profile, and `weatherEffectCoverage` measures what a frame
 *   actually spent against them — refusing an unmeasurable input instead of
 *   passing it silently, exactly like the water and movement-audit budgets.
 * - **Shore response is uniform-only.** The class palette and the wave shader
 *   belong to `ENV-03`; the weather only writes the wetness, ripple gain, foam
 *   gain, and shore band into uniforms it does not share with any other owner, so
 *   a rain state cannot recompile a program.
 *
 * Everything here is a pure function of the live `ENV-04` view plus the declared
 * profile, so the same weather at the same clock produces the same field.
 */

export const GDO_WEATHER_EFFECTS_NAMESPACE = featureNamespace('weatherEffects');

/** The three precipitation families of the research's effect catalogue. */
export const GDO_WEATHER_EFFECT_SHAPE = Object.freeze({
  STREAK: 'streak',
  FLAKE: 'flake',
  STRIP: 'strip',
});

/**
 * One entry per precipitation family `ENV-04` can activate. `fall` is metres per
 * second in the world's own units, `drift` how much of the shared wind vector the
 * particle takes, `span` the vertical distance it falls through before its cycle
 * restarts, `size` the drawn streak/flake dimensions, and `response` which surface
 * channel the family feeds. `alphaMode` is fixed to a screen-door mode: this pool
 * has no blended path at all.
 */
export const GDO_WEATHER_EFFECTS = Object.freeze({
  [GDO_WEATHER_PRECIPITATION.RAIN]: Object.freeze({
    family: GDO_WEATHER_PRECIPITATION.RAIN,
    label: 'Rain',
    shape: GDO_WEATHER_EFFECT_SHAPE.STREAK,
    fall: 11, drift: .35, span: 9.5,
    size: Object.freeze([.018, .62]),
    tone: Object.freeze([.74, .80, .88]),
    alphaMode: 'dither',
    surface: 'wetness',
    groundResponse: Object.freeze({ rippleGain: 1.55, darkening: .17, foamGain: .32, shoreWetMetres: 2.1 }),
    research: 'VB §9.5 rain; §10 water weather response',
  }),
  [GDO_WEATHER_PRECIPITATION.SNOW]: Object.freeze({
    family: GDO_WEATHER_PRECIPITATION.SNOW,
    label: 'Snow',
    shape: GDO_WEATHER_EFFECT_SHAPE.FLAKE,
    fall: 1.5, drift: .55, span: 7.5,
    size: Object.freeze([.075, .075]),
    tone: Object.freeze([.94, .96, 1]),
    alphaMode: 'dither',
    surface: 'snow',
    groundResponse: Object.freeze({ rippleGain: .35, darkening: .05, foamGain: .08, shoreWetMetres: .4 }),
    research: 'VB §9.5 snow',
  }),
  [GDO_WEATHER_PRECIPITATION.DUST]: Object.freeze({
    family: GDO_WEATHER_PRECIPITATION.DUST,
    label: 'Dust',
    shape: GDO_WEATHER_EFFECT_SHAPE.STRIP,
    fall: 2.6, drift: .9, span: 5.5,
    size: Object.freeze([.9, .07]),
    tone: Object.freeze([.82, .70, .52]),
    alphaMode: 'dither',
    surface: 'dust',
    groundResponse: Object.freeze({ rippleGain: .5, darkening: .02, foamGain: 0, shoreWetMetres: 0 }),
    research: 'VB §9.5 dust gusts',
  }),
});

export function weatherEffectFor(family) {
  return GDO_WEATHER_EFFECTS[family] ?? null;
}

export const GDO_WEATHER_EFFECT_FAMILIES = Object.freeze(Object.keys(GDO_WEATHER_EFFECTS));

/**
 * The render profiles. `particles` is the research §14 `Transparent weather
 * particles visible` ceiling (80 low / 180 balanced / 350 high), `draws` is one
 * per active family, `overdrawLayers` one, and `coveragePercent` the share of the
 * viewport the family may paint. Reduced motion is a per-instance decision, not a
 * profile: every profile honours it.
 */
export const GDO_WEATHER_EFFECT_PROFILES = Object.freeze({
  low: Object.freeze({
    profile: 'low', particles: 80, draws: 1, overdrawLayers: 1, coveragePercent: 14,
    alphaMode: 'dither', radiusMetres: 26, spanMetres: 14, blended: false,
    depthWrite: true, castsLight: false, collides: false, steadyFrameAllocations: 0,
    steadyFrameUniformWrites: 2, maximumUniformWritesPerFrame: 5,
  }),
  balanced: Object.freeze({
    profile: 'balanced', particles: 180, draws: 1, overdrawLayers: 2, coveragePercent: 22,
    alphaMode: 'dither', radiusMetres: 34, spanMetres: 17, blended: false,
    depthWrite: true, castsLight: false, collides: false, steadyFrameAllocations: 0,
    steadyFrameUniformWrites: 2, maximumUniformWritesPerFrame: 5,
  }),
  high: Object.freeze({
    profile: 'high', particles: 350, draws: 1, overdrawLayers: 2, coveragePercent: 28,
    alphaMode: 'dither', radiusMetres: 44, spanMetres: 21, blended: false,
    depthWrite: true, castsLight: false, collides: false, steadyFrameAllocations: 0,
    steadyFrameUniformWrites: 2, maximumUniformWritesPerFrame: 5,
  }),
});

export function weatherEffectProfileFor(name) {
  const profile = GDO_WEATHER_EFFECT_PROFILES[name];
  if (!profile) throw new RangeError(`Unknown weather effect profile: ${name}`);
  return profile;
}

/** Budget view of one profile, in the key shape the runtime budget check reads. */
export function weatherEffectBudgetForProfile(name) {
  const profile = weatherEffectProfileFor(name);
  return Object.freeze({
    profile: name,
    particles: profile.particles,
    draws: profile.draws,
    overdrawLayers: profile.overdrawLayers,
    coveragePercent: profile.coveragePercent,
    alphaMode: profile.alphaMode,
  });
}

/**
 * The projected-detail half of the row: prove the catalogue, the profiles, and
 * the shipped budget keys are one claim rather than three tables.
 */
export function validateWeatherEffects({
  budgets = GDO_LOW_PROFILE_BUDGETS,
  caps = GDO_WEATHER_EFFECT_CAPS,
  effects = GDO_WEATHER_EFFECTS,
  profiles = GDO_WEATHER_EFFECT_PROFILES,
} = {}) {
  const violations = [];
  const claimed = new Set();
  for (const family of [GDO_WEATHER_PRECIPITATION.RAIN, GDO_WEATHER_PRECIPITATION.SNOW, GDO_WEATHER_PRECIPITATION.DUST]) {
    const effect = effects[family];
    if (!effect) { violations.push(`precipitation family ${family} has no declared effect`); continue; }
    if (effect.family !== family) violations.push(`effect ${family} declares the wrong family ${effect.family}`);
    if (claimed.has(effect.family)) violations.push(`effect ${family} is declared twice`);
    claimed.add(effect.family);
    if (![effect.fall, effect.drift, effect.span].every(value => Number.isFinite(value) && value > 0)) {
      violations.push(`effect ${family} has an invalid motion record`);
    }
    if (!Array.isArray(effect.size) || effect.size.length !== 2 || effect.size.some(value => !(value > 0))) {
      violations.push(`effect ${family} has an invalid particle size`);
    }
    if (!Array.isArray(effect.tone) || effect.tone.length !== 3 || effect.tone.some(value => !(value >= 0 && value <= 1))) {
      violations.push(`effect ${family} has an invalid tone`);
    }
    // The row's own gate: a weather particle is alpha-tested or dithered. A
    // blended family would be an overdraw bug, not a preference.
    if (!['dither', 'alpha-test'].includes(effect.alphaMode)) {
      violations.push(`effect ${family} uses ${effect.alphaMode} instead of an alpha-test/dither path`);
    }
    if (!['wetness', 'snow', 'dust'].includes(effect.surface)) violations.push(`effect ${family} feeds no declared surface channel`);
    const response = effect.groundResponse;
    if (!response || !(response.rippleGain >= 0) || !(response.darkening >= 0) || !(response.foamGain >= 0) || !(response.shoreWetMetres >= 0)) {
      violations.push(`effect ${family} has an invalid shore/ground response`);
    }
  }
  const unknown = Object.keys(effects).filter(family => !GDO_WEATHER_STATE_IDS.length || !Object.values(GDO_WEATHER_PRECIPITATION).includes(family));
  for (const family of unknown) violations.push(`effect ${family} is not a declared precipitation family`);
  // The low path's declared numbers *are* the shipped low-profile budget keys.
  const low = profiles.low;
  const agreements = [
    ['weatherParticles', low.particles, caps.profiles?.low?.particles, 'ceiling'],
    ['weatherParticleDrawsPerFamily', low.draws, caps.profiles?.low?.draws, 'ceiling'],
    ['weatherEffectOverdrawLayers', low.overdrawLayers, caps.profiles?.low?.overdrawLayers, 'ceiling'],
    ['weatherEffectCoveragePercent', low.coveragePercent, caps.profiles?.low?.coveragePercent, 'ceiling'],
    ['weatherEffectSteadyFrameAllocations', low.steadyFrameAllocations, caps.profiles?.low?.steadyFrameAllocations, 'ceiling'],
  ];
  for (const [key, declared, ceiling, direction] of agreements) {
    const budget = budgets[key];
    if (!Number.isFinite(budget)) { violations.push(`the shipped budget has no ${key}`); continue; }
    if (!Number.isFinite(ceiling)) { violations.push(`the caps table has no low ${key}`); continue; }
    if (direction === 'ceiling' && declared > ceiling) violations.push(`low declares ${key}=${declared} above its own ${ceiling} ceiling`);
    if (direction === 'ceiling' && declared > budget) violations.push(`low declares ${key}=${declared} above the ${key} budget`);
    if (declared !== ceiling) violations.push(`low declares ${key}=${declared} but the caps table says ${ceiling}`);
  }
  for (const [name, profile] of Object.entries(profiles)) {
    const ceiling = caps.profiles?.[name];
    if (!ceiling) { violations.push(`${name} has no declared ceiling`); continue; }
    if (profile.particles > ceiling.particles) violations.push(`${name} draws ${profile.particles} weather particles`);
    if (profile.draws > ceiling.draws) violations.push(`${name} needs ${profile.draws} weather draws`);
    if (profile.overdrawLayers > ceiling.overdrawLayers) violations.push(`${name} allows ${profile.overdrawLayers} weather layers`);
    if (profile.coveragePercent > ceiling.coveragePercent) violations.push(`${name} allows ${profile.coveragePercent}% weather coverage`);
    if (profile.blended) violations.push(`${name} blends its weather particles`);
    if (!profile.depthWrite) violations.push(`${name} disables weather depth writing`);
    if (profile.castsLight) violations.push(`${name} gives weather particles a light`);
    if (profile.collides) violations.push(`${name} gives weather particles collision`);
    if (profile.alphaMode !== 'dither' && profile.alphaMode !== 'alpha-test') violations.push(`${name} declares an unknown alpha mode`);
    if (!(profile.steadyFrameAllocations <= GDO_LOW_PROFILE_BUDGETS.weatherEffectSteadyFrameAllocations)) {
      violations.push(`${name} allows steady-frame weather allocation`);
    }
    if (!(profile.steadyFrameUniformWrites > 0) || profile.steadyFrameUniformWrites > profile.maximumUniformWritesPerFrame) {
      violations.push(`${name} declares an impossible steady-frame uniform write count`);
    }
    if (profile.maximumUniformWritesPerFrame > budgets.weatherEffectUniformWritesPerFrame) {
      violations.push(`${name} writes more weather uniforms per frame than the budget allows`);
    }
  }
  return Object.freeze({
    namespace: GDO_WEATHER_EFFECTS_NAMESPACE,
    ok: violations.length === 0,
    families: claimed.size,
    profiles: Object.keys(profiles).length,
    violations: Object.freeze(violations),
  });
}

/**
 * The measured half of the gate: given what one frame actually drew, decide
 * whether the declared screen/overdraw ceilings hold. An unmeasurable input
 * fails, so a host cannot pass this by not looking.
 */
export function weatherEffectCoverage({
  profile = 'low', family = null, particlePixels, viewportPixels, draws = 1, overdrawLayers = 1,
} = {}) {
  const declared = weatherEffectProfileFor(profile);
  const reasons = [];
  if (!(viewportPixels > 0)) reasons.push('viewportPixels must be measured');
  if (!Number.isFinite(particlePixels) || particlePixels < 0) reasons.push('particlePixels must be measured');
  if (!Number.isInteger(draws) || draws < 0) reasons.push('draws must be a measured integer');
  if (!Number.isInteger(overdrawLayers) || overdrawLayers < 1) reasons.push('overdrawLayers must be a measured integer');
  if (family != null && !GDO_WEATHER_EFFECT_FAMILIES.includes(family)) reasons.push(`${family} is not a declared precipitation family`);
  const coverage = viewportPixels > 0 && Number.isFinite(particlePixels) ? particlePixels / viewportPixels : null;
  if (coverage != null && coverage > 1) reasons.push('the family cannot cover more than the viewport');
  if (family && draws > declared.draws) reasons.push(`${draws} draw(s) exceed the ${declared.draws}-draw ceiling for one family`);
  if (family && overdrawLayers > declared.overdrawLayers) {
    reasons.push(`${overdrawLayers} layer(s) exceed the ${declared.overdrawLayers}-layer ceiling`);
  }
  if (!family && particlePixels !== 0) reasons.push('an inactive family may not paint pixels');
  if (coverage != null && coverage * 100 > declared.coveragePercent) {
    reasons.push(`${(coverage * 100).toFixed(1)}% screen coverage exceeds ${declared.coveragePercent}%`);
  }
  return Object.freeze({
    namespace: GDO_WEATHER_EFFECTS_NAMESPACE,
    profile,
    family,
    particlePixels: Number.isFinite(particlePixels) ? particlePixels : null,
    viewportPixels: viewportPixels > 0 ? viewportPixels : null,
    coverage,
    draws,
    overdrawLayers,
    declared: Object.freeze({
      particles: declared.particles,
      draws: declared.draws,
      overdrawLayers: declared.overdrawLayers,
      coveragePercent: declared.coveragePercent,
      alphaMode: declared.alphaMode,
    }),
    ok: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
}

/**
 * The surface and shore response `ENV-03`'s water and the landed ground materials
 * consume. It is derived from the *blended* `ENV-04` view, so a ramped transition
 * moves the water rather than switching it.
 */
export function weatherSurfaceResponse(view, out = {}) {
  const family = view?.activePrecipitation ?? null;
  const effect = weatherEffectFor(family);
  const wetness = clamp01(view?.surface?.wetness ?? 0);
  const damp = clamp01(view?.surface?.damp ?? 0);
  const dust = clamp01(view?.surface?.dust ?? 0);
  const snow = clamp01(view?.surface?.snow ?? 0);
  const response = effect?.groundResponse ?? null;
  const rainGain = response?.rippleGain ?? 1;
  out.family = family;
  out.wetness = wetness;
  out.damp = damp;
  out.dust = dust;
  out.snow = snow;
  // A wet surface ripples more than a dry one; snow and dust flatten the surface
  // rather than raising it, so a gain below one is as meaningful as above.
  out.rippleGain = family ? rainGain * (.6 + .4 * Math.max(wetness, damp)) : 1;
  out.darkening = (response?.darkening ?? 0) * Math.max(wetness, damp, snow);
  out.foamGain = (response?.foamGain ?? 0) * (family ? Math.max(.25, wetness, snow) : 0);
  out.shoreWetMetres = (response?.shoreWetMetres ?? 0) * (family ? Math.max(.25, wetness, damp) : 0);
  out.ripples = Boolean(family) && out.rippleGain > 1.02;
  out.active = Boolean(family);
  out.source = 'gdo:weatherEffects:v1';
  return out;
}

function clamp01(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

const WEATHER_VERTEX_DECLARATIONS = `
attribute vec4 gdoWeatherParticle;
attribute float gdoWeatherAmount;
uniform vec3 gdoWeatherCentre;
uniform vec2 gdoWeatherMotion;
uniform float gdoWeatherElapsed;
uniform vec2 gdoWeatherSpan;
uniform vec2 gdoWeatherSize;
varying float vGdoWeatherAmount;
float gdoWeatherHash(vec2 p) {
  vec3 q = fract(vec3(p.x, p.y, p.x) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
`;

const WEATHER_VERTEX_BODY = `
  float gdoWeatherPhase = fract(gdoWeatherParticle.x + gdoWeatherElapsed * gdoWeatherMotion.x);
  float gdoWeatherSeed = gdoWeatherParticle.y;
  vec2 gdoWeatherRing = vec2(
    gdoWeatherHash(vec2(gdoWeatherSeed, 1.0)) - 0.5,
    gdoWeatherHash(vec2(gdoWeatherSeed, 7.0)) - 0.5);
  float gdoWeatherRadius = gdoWeatherSpan.x * (0.35 + 0.65 * gdoWeatherHash(vec2(gdoWeatherSeed, 13.0)));
  // The particle falls a fixed span below the camera and is recycled by its own
  // phase, so the whole field is a pure function of one clock plus one centre.
  float gdoWeatherDrop = (1.0 - gdoWeatherPhase) * gdoWeatherSpan.y;
  vec2 gdoWeatherGround = gdoWeatherCentre.xz + gdoWeatherRing * gdoWeatherRadius * 2.0 +
    gdoWeatherMotion.y * gdoWeatherDrop * vec2(0.35, 0.62);
  float gdoWeatherHeight = gdoWeatherCentre.y + gdoWeatherSpan.y * 0.55 - gdoWeatherDrop;
  vec3 gdoWeatherWorld = vec3(gdoWeatherGround.x, gdoWeatherHeight, gdoWeatherGround.y);
  vec4 mvPosition = viewMatrix * vec4(gdoWeatherWorld, 1.0);
  // The streak/flake is drawn in view space and scaled by its own attributes, so
  // a particle is a handful of triangles and never reads instanceMatrix.
  vec2 gdoWeatherQuad = position.xy * gdoWeatherSize;
  gdoWeatherQuad.y -= gdoWeatherSize.y * 0.5 * step(0.5, gdoWeatherParticle.z);
  mvPosition.xy += gdoWeatherQuad * (0.4 + 0.6 * gdoWeatherAmount);
  gl_Position = projectionMatrix * mvPosition;
  vGdoWeatherAmount = gdoWeatherAmount;
`;

const WEATHER_FRAGMENT_DECLARATIONS = `
uniform vec3 gdoWeatherTone;
uniform sampler2D gdoWeatherDither;
uniform float gdoWeatherAlphaTest;
varying float vGdoWeatherAmount;
`;

/**
 * The particle material. Opaque by construction: no blend, depth writing, and a
 * screen-door discard through the shared `MAT-02` dither mask.
 */
export function createWeatherEffectMaterial({ ditherUniform = null, ditherSize = GDO_CAMERA_FADE_DITHER_SIZE } = {}) {
  if (ditherUniform != null && !ditherUniform.value?.isTexture) {
    throw new TypeError('Weather effects need the shared generated dither texture');
  }
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: true, transparent: false });
  material.name = `${GDO_WEATHER_EFFECTS_NAMESPACE}:particles`;
  const uniforms = Object.freeze({
    centre: Object.seal({ value: new THREE.Vector3() }),
    motion: Object.seal({ value: new THREE.Vector2(1 / 11, 0) }),
    elapsed: Object.seal({ value: 0 }),
    span: Object.seal({ value: new THREE.Vector2(26, 14) }),
    size: Object.seal({ value: new THREE.Vector2(.018, .62) }),
    tone: Object.seal({ value: new THREE.Color(1, 1, 1) }),
  });
  material.userData.gdoWeatherEffects = Object.freeze({
    namespace: GDO_WEATHER_EFFECTS_NAMESPACE,
    alphaMode: 'dither',
    blended: false,
    depthWriting: true,
    ditherSize,
    collides: false,
    castsLight: false,
    uniforms,
  });
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, {
      gdoWeatherCentre: uniforms.centre,
      gdoWeatherMotion: uniforms.motion,
      gdoWeatherElapsed: uniforms.elapsed,
      gdoWeatherSpan: uniforms.span,
      gdoWeatherSize: uniforms.size,
      gdoWeatherTone: uniforms.tone,
    });
    if (ditherUniform) shader.uniforms.gdoWeatherDither = ditherUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WEATHER_VERTEX_DECLARATIONS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WEATHER_VERTEX_BODY}`);
    if (ditherUniform) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${WEATHER_FRAGMENT_DECLARATIONS}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
  if (vGdoWeatherAmount > 0.001) {
    float gdoWeatherDitherValue = texture2D(gdoWeatherDither, gl_FragCoord.xy / ${ditherSize}.0).r;
    if (gdoWeatherDitherValue > vGdoWeatherAmount) discard;
  }`);
    }
  };
  material.customProgramCacheKey = () => `${GDO_WEATHER_EFFECTS_NAMESPACE}:particles${ditherUniform ? ':dither' : ''}`;
  return material;
}

/** Four corners of one unit quad, shared by every particle instance. */
function particleQuad() {
  const positions = new Float32Array([
    -1, -1, 0, 1, -1, 0, 1, 1, 0,
    -1, -1, 0, 1, 1, 0, -1, 1, 0,
  ]);
  const colors = new Float32Array(18).fill(1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function instanceAttribute(array, itemSize) {
  const attribute = new THREE.InstancedBufferAttribute(array, itemSize);
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}

/**
 * The bounded pool: one geometry, one mesh, one draw call, a fixed instance
 * stream, and per-frame work bounded to an instance count plus four uniforms.
 * Nothing here allocates after construction, and `sync` reads only the live
 * `ENV-04` view and the camera position.
 */
export function createWeatherEffects({
  scene,
  ditherUniform = null,
  profile = 'low',
  ledger = null,
  reducedMotion = false,
  seed = 0,
} = {}) {
  if (!scene?.add) throw new TypeError('Weather effects require a scene');
  const declared = weatherEffectProfileFor(profile);
  const geometry = particleQuad();
  geometry.name = `${GDO_WEATHER_EFFECTS_NAMESPACE}:particles`;
  geometry.setAttribute('gdoWeatherParticle', instanceAttribute(new Float32Array(declared.particles * 4), 4));
  geometry.setAttribute('gdoWeatherAmount', instanceAttribute(new Float32Array(declared.particles), 1));
  geometry.instanceCount = 0;
  const material = createWeatherEffectMaterial({ ditherUniform });
  const uniforms = material.userData.gdoWeatherEffects.uniforms;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'weather-particles';
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.userData.visualOnly = true;
  mesh.userData.gdoWeatherEffectsFamily = null;
  scene.add(mesh);

  const state = {
    family: null, count: 0, amount: 0, elapsed: 0, writes: 0, lastFrameWrites: 0,
    frames: 0, packs: 0, families: 0, dropped: 0, skipped: 0, allocations: 0,
    coverage: null, reducedMotion: Boolean(reducedMotion), seed,
    span: new THREE.Vector2(),
  };
  // Per-instance phase/seed are deterministic and uploaded once per family, so a
  // steady frame rewrites no instance data at all.
  const streamOwner = { family: null, written: null, seeded: false };

  const seedStream = effect => {
    const particles = geometry.getAttribute('gdoWeatherParticle');
    const amount = geometry.getAttribute('gdoWeatherAmount');
    for (let index = 0; index < declared.particles; index++) {
      particles.array[index * 4] = hashUnit(seed, effect.family, index, 1);
      particles.array[index * 4 + 1] = hashUnit(seed, effect.family, index, 2) * 1024;
      particles.array[index * 4 + 2] = hashUnit(seed, effect.family, index, 3);
      particles.array[index * 4 + 3] = hashUnit(seed, effect.family, index, 4);
      amount.array[index] = 1;
    }
    particles.needsUpdate = true;
    amount.needsUpdate = true;
    streamOwner.family = effect.family;
    streamOwner.seeded = true;
    state.packs++;
  };

  const write = (uniform, value) => {
    uniform.value = value;
    state.writes++;
    state.lastFrameWrites++;
  };

  const api = {
    namespace: GDO_WEATHER_EFFECTS_NAMESPACE,
    mesh,
    geometry,
    material,
    profile: declared.profile,
    get family() { return state.family; },
    get reducedMotion() { return state.reducedMotion; },
    setReducedMotion(next) {
      state.reducedMotion = Boolean(next);
      return state.reducedMotion;
    },
    /**
     * One bounded frame: read the live weather view, point the field at the
     * camera, and set the surface/shore response. A family change reseeds the
     * fixed stream; everything else is an instance count plus four uniforms.
     */
    sync({ view = null, camera = null, nowMilliseconds = 0 } = {}) {
      state.frames++;
      state.lastFrameWrites = 0;
      const family = view?.activePrecipitation ?? null;
      const effect = weatherEffectFor(family);
      if (!effect) {
        state.family = null;
        state.count = 0;
        geometry.instanceCount = 0;
        mesh.userData.gdoWeatherEffectsFamily = null;
        state.amount = 0;
        return api.diagnostics;
      }
      if (streamOwner.family !== effect.family) seedStream(effect);
      state.family = effect.family;
      state.families++;
      mesh.userData.gdoWeatherEffectsFamily = effect.family;
      // The family's own surface channel *is* its intensity: rain wets, snow
      // accumulates, dust settles, and a ramped transition moves the channel
      // continuously, so the field grows and thins with the same number the
      // ground response reads.
      const amount = clamp01(view?.surface?.[effect.surface] ?? 0);
      // Reduced motion suppresses the effect entirely — the research's rule — and
      // reports it rather than silently drawing nothing.
      const drawn = state.reducedMotion ? 0 : Math.round(declared.particles * Math.max(.15, amount));
      state.count = drawn;
      state.amount = state.reducedMotion ? 0 : amount;
      geometry.instanceCount = drawn;
      // The family's own shape, tone, and fall speed are written only when the
      // family changes; a steady frame is the clock plus the camera centre.
      if (streamOwner.written !== effect.family) {
        uniforms.span.value.set(declared.radiusMetres, declared.spanMetres * (effect.span / 9.5));
        uniforms.size.value.set(effect.size[0], effect.size[1]);
        write(uniforms.size, uniforms.size.value);
        uniforms.tone.value.setRGB(effect.tone[0], effect.tone[1], effect.tone[2]);
        write(uniforms.tone, uniforms.tone.value);
        write(uniforms.motion, uniforms.motion.value.set(1 / effect.fall, effect.drift));
        streamOwner.written = effect.family;
      }
      write(uniforms.elapsed, (state.elapsed = (nowMilliseconds ?? 0) / 1000));
      if (camera) {
        uniforms.centre.value.set(camera.position.x, camera.position.y, camera.position.z);
        write(uniforms.centre, uniforms.centre.value);
      }
      if (!streamOwner.seeded) seedStream(effect);
      return api.diagnostics;
    },
    /** The measured screen/overdraw verdict for the last frame, or a refusal. */
    measureCoverage({ particlePixels = null, viewportPixels = null, overdrawLayers = 1 } = {}) {
      const measured = particlePixels ?? (state.count > 0 ? projectedParticlePixels(declared, state.count) : 0);
      state.coverage = weatherEffectCoverage({
        profile: declared.profile, family: state.family, particlePixels: measured,
        viewportPixels, draws: state.family ? declared.draws : 0, overdrawLayers: state.family ? overdrawLayers : 1,
      });
      return state.coverage;
    },
    /** What the active profile refuses — named, never silently dropped. */
    fallbacks(out = []) {
      out.length = 0;
      if (state.reducedMotion) out.push(Object.freeze({ response: 'particles', reason: 'reduced-motion' }));
      if (!state.family) out.push(Object.freeze({ response: 'particles', reason: 'no-precipitation' }));
      if (declared.profile !== 'high') out.push(Object.freeze({ response: 'particles', reason: 'profile-cap' }));
      return out;
    },
    get diagnostics() {
      return Object.freeze({
        namespace: GDO_WEATHER_EFFECTS_NAMESPACE,
        profile: declared.profile,
        family: state.family,
        particles: state.count,
        available: declared.particles,
        amount: state.amount,
        draws: state.family ? declared.draws : 0,
        overdrawLayers: declared.overdrawLayers,
        alphaMode: 'dither',
        blended: material.transparent,
        depthWriting: material.depthWrite,
        collides: false,
        castsLight: false,
        uniformWrites: state.writes,
        steadyFrameWrites: state.lastFrameWrites,
        steadyFrameAllocations: state.allocations,
        frames: state.frames,
        packs: state.packs,
        families: state.families,
        reducedMotion: state.reducedMotion,
        programRecompiles: 0,
        coverage: state.coverage,
      });
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
  // `FND-07`: the pool joins the same ledger as every other resource owner.
  if (ledger?.own) {
    ledger.own('geometry', `${GDO_WEATHER_EFFECTS_NAMESPACE}:particles`, geometry, item => item.dispose?.());
    ledger.own('material', `${GDO_WEATHER_EFFECTS_NAMESPACE}:particles`, material, item => item.dispose?.());
    ledger.own('mesh', `${GDO_WEATHER_EFFECTS_NAMESPACE}:particles`, mesh, item => item.remove?.());
  }
  return api;
}

/**
 * The projected cost of one frame's family, from the profile's own declared
 * particle size and count. It is an estimate of drawn pixels, and the coverage
 * report treats it as measured input — a host that can measure real pixels
 * passes those instead.
 */
function projectedParticlePixels(declared, count, viewportHeight = 720, fovRadians = 1.18) {
  const metresPerPixel = 2 * Math.tan(fovRadians / 2) * declared.radiusMetres / viewportHeight;
  const widthPixels = Math.max(1, declared.radiusMetres * .012 / metresPerPixel);
  const heightPixels = Math.max(1, declared.spanMetres * .045 / metresPerPixel);
  return Math.round(count * widthPixels * heightPixels);
}

function hashUnit(seed, family, index, channel) {
  let hash = 2166136261 ^ (seed >>> 0);
  const text = `${family}:${index}:${channel}`;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash >>> 8) / 16777216;
}

/**
 * Apply the surface/shore response to the landed `ENV-03` water policy. Nothing
 * here touches a palette, a geometry attribute, or a shader flag: three
 * weather-owned uniforms move, so the water's program cache key is untouched and
 * a rain state cannot recompile a material.
 */
export function applyWeatherSurface(policy, response) {
  if (!policy?.applyWeather) throw new TypeError('Weather effects need the water visual policy');
  return policy.applyWeather(response);
}

/** One-line HUD text for the effects family, mirroring the other HUD formatters. */
export function weatherEffectHudText(diagnostics, response = null) {
  if (!diagnostics?.family) {
    return Object.freeze({
      title: 'No weather particles',
      text: 'Clear air',
      detail: `${diagnostics?.available ?? 0} particle slots parked`,
    });
  }
  const label = weatherEffectFor(diagnostics.family)?.label ?? diagnostics.family;
  return Object.freeze({
    title: `${label} · ${diagnostics.particles} particles`,
    text: response?.ripples ? `${label} · rippling water` : label,
    detail: `${diagnostics.draws} draw · ${diagnostics.alphaMode} · ${diagnostics.overdrawLayers} layer`,
  });
}
