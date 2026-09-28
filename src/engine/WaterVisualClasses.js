import * as THREE from 'three';
import { GEO_WATER_CLASS, GEO_WATER_CLASS_NAMES, GEO_WATER_FLOWING_CLASSES } from '../geo/GeoWaterDomains.js';
import { GDO_LOW_PROFILE_BUDGETS, GDO_WATER_VISUAL_CAPS } from './PerformanceBudget.js';
import { featureNamespace } from './FeatureVersions.js';

/**
 * `ENV-03` water visual classes.
 *
 * `TER-08` already answers *what* a water body is — a provider-neutral class per
 * polygon and per waterway segment, plus a truthful normalized flow direction
 * that stays zero for lakes, oceans, and anything unmatched. This module is the
 * apperance half: one class table the CPU bakes into the water geometry, one
 * profile table that decides how many families and how much blending the render
 * path may spend, and the water material itself.
 *
 * The gate is a two-path policy, and it is structural rather than cosmetic:
 *
 * - **Low is opaque and single-family.** `transparent` stays false, `depthWrite`
 *   stays true, the shader writes alpha 1, one broad wave scale and a screen-door
 *   dither stand in for foam, and the blended family count is zero. A constrained
 *   device never pays for water sorting or overdraw.
 * - **Higher profiles are bounded, not open.** At most one blended family, an
 *   alpha no lower than the profile's declared floor, a declared overdraw layer
 *   count, and a declared blended screen-coverage ceiling that `coverageReport`
 *   measures against. Foam is either dithered or blended, never stacked.
 *
 * Class appearance is baked per vertex: the tile builder asks this module for the
 * class's shallow/deep tint and wave manner at build time, so the shader indexes
 * nothing and the palette can grow a class without touching GLSL.
 */

export const GDO_WATER_VISUAL_NAMESPACE = featureNamespace('waterVisual');

/**
 * One entry per `TER-08` class. `shallow` is the bank tint, `deep` the centre
 * tint, `waveScales` is broad-flow then fine-wind, `flowAlignment` is how much
 * the mapped flow tangent drives the wave advection (0 = no mapped flow), `foam` is
 * the class's base foam amount, `reflect` how strongly the horizon tint is mixed
 * in, and `speed` the class's time multiplier for wave motion.
 */
export const GDO_WATER_VISUAL_CLASSES = Object.freeze({
  [GEO_WATER_CLASS.UNKNOWN]: Object.freeze({
    code: GEO_WATER_CLASS.UNKNOWN, name: 'unknown', usesFlow: false,
    shallow: Object.freeze([.36, .52, .56]), deep: Object.freeze([.20, .36, .46]),
    waveScales: Object.freeze([.055, .21]), waveStrength: .7, flowAlignment: 0,
    foam: .08, reflect: .44, speed: .8,
  }),
  [GEO_WATER_CLASS.STREAM]: Object.freeze({
    code: GEO_WATER_CLASS.STREAM, name: 'stream', usesFlow: true,
    shallow: Object.freeze([.44, .60, .55]), deep: Object.freeze([.20, .40, .42]),
    waveScales: Object.freeze([.09, .34]), waveStrength: 1.05, flowAlignment: .85,
    foam: .30, reflect: .34, speed: 1.25,
  }),
  [GEO_WATER_CLASS.CANAL]: Object.freeze({
    code: GEO_WATER_CLASS.CANAL, name: 'canal', usesFlow: true,
    shallow: Object.freeze([.40, .55, .52]), deep: Object.freeze([.18, .34, .38]),
    waveScales: Object.freeze([.06, .20]), waveStrength: .78, flowAlignment: .7,
    foam: .16, reflect: .38, speed: .95,
  }),
  [GEO_WATER_CLASS.RIVER]: Object.freeze({
    code: GEO_WATER_CLASS.RIVER, name: 'river', usesFlow: true,
    shallow: Object.freeze([.42, .58, .54]), deep: Object.freeze([.19, .37, .43]),
    waveScales: Object.freeze([.075, .28]), waveStrength: .95, flowAlignment: .9,
    foam: .26, reflect: .36, speed: 1.15,
  }),
  [GEO_WATER_CLASS.LAKE]: Object.freeze({
    code: GEO_WATER_CLASS.LAKE, name: 'lake', usesFlow: false,
    shallow: Object.freeze([.40, .58, .58]), deep: Object.freeze([.18, .34, .46]),
    waveScales: Object.freeze([.045, .18]), waveStrength: .6, flowAlignment: 0,
    foam: .06, reflect: .55, speed: .75,
  }),
  [GEO_WATER_CLASS.OCEAN]: Object.freeze({
    code: GEO_WATER_CLASS.OCEAN, name: 'ocean', usesFlow: false,
    shallow: Object.freeze([.38, .60, .62]), deep: Object.freeze([.12, .28, .44]),
    waveScales: Object.freeze([.035, .13]), waveStrength: 1.15, flowAlignment: 0,
    foam: .34, reflect: .48, speed: .62,
  }),
});

/** A class the table does not name resolves to the declared unknown appearance. */
export function waterVisualAppearance(classCode) {
  return GDO_WATER_VISUAL_CLASSES[classCode] ?? GDO_WATER_VISUAL_CLASSES[GEO_WATER_CLASS.UNKNOWN];
}

export function waterVisualAppearanceByName(name) {
  const entry = GEO_WATER_CLASS_NAMES.indexOf(name);
  if (entry < 0) throw new RangeError(`Unknown water visual class: ${name}`);
  return waterVisualAppearance(entry);
}

/**
 * The render paths. `low` is the opaque single-family path; `balanced`/`high`
 * are the bounded blended paths. Every number here is checked against the
 * `PerformanceBudget` caps by `validateWaterVisualClasses`.
 */
export const GDO_WATER_VISUAL_PROFILES = Object.freeze({
  low: Object.freeze({
    profile: 'low', path: 'opaque', blended: false, alpha: 1, depthWrite: true,
    blendedFamilies: 0, overdrawLayers: 1, blendedCoveragePercent: 0,
    foamMode: 'dither', waveScaleCount: 1, waveStrength: .75, reflectStrength: .4,
    normalFade: Object.freeze([10, 52]),
  }),
  balanced: Object.freeze({
    profile: 'balanced', path: 'blended', blended: true, alpha: .92, depthWrite: false,
    blendedFamilies: 1, overdrawLayers: 2, blendedCoveragePercent: 75,
    foamMode: 'dither', waveScaleCount: 2, waveStrength: 1, reflectStrength: .5,
    normalFade: Object.freeze([18, 82]),
  }),
  high: Object.freeze({
    profile: 'high', path: 'blended', blended: true, alpha: .88, depthWrite: false,
    blendedFamilies: 1, overdrawLayers: 3, blendedCoveragePercent: 90,
    foamMode: 'blended', waveScaleCount: 2, waveStrength: 1.25, reflectStrength: .58,
    normalFade: Object.freeze([28, 120]),
  }),
});

export function waterVisualProfileFor(name) {
  const profile = GDO_WATER_VISUAL_PROFILES[name];
  if (!profile) throw new RangeError(`Unknown water visual profile: ${name}`);
  return profile;
}

/** Budget view of one profile, in the key shape the runtime budget check reads. */
export function waterVisualBudgetForProfile(name) {
  const profile = waterVisualProfileFor(name);
  return Object.freeze({
    profile: name,
    path: profile.path,
    blendedFamilies: profile.blendedFamilies,
    overdrawLayers: profile.overdrawLayers,
    waveScales: profile.waveScaleCount,
    alpha: profile.alpha,
  });
}

/**
 * The per-vertex bake. `manner` packs `[waveStrength, flowAlignment, foam,
 * reflect]` so the shader needs no class table, no array indexing, and no
 * per-frame class work.
 */
export function waterVisualVertexAppearance(classCode) {
  const appearance = waterVisualAppearance(classCode);
  return Object.freeze({
    classCode: appearance.code,
    name: appearance.name,
    usesFlow: appearance.usesFlow,
    shallow: appearance.shallow,
    deep: appearance.deep,
    manner: Object.freeze([appearance.waveStrength, appearance.flowAlignment, appearance.foam, appearance.reflect]),
    waveScales: appearance.waveScales,
  });
}

/** Colour a class's own water geometry is tinted with, for the legacy path. */
export function waterVisualBaseColor(classCode) {
  const appearance = waterVisualAppearance(classCode);
  const [r, g, b] = appearance.deep;
  return Object.freeze([r, g, b]);
}

/**
 * Prove the class table and the profile table against the shipped caps: every
 * declared class is named once, the low path is opaque with no blended family,
 * and no profile exceeds a budget ceiling.
 */
export function validateWaterVisualClasses({ budgets = GDO_LOW_PROFILE_BUDGETS, caps = GDO_WATER_VISUAL_CAPS } = {}) {
  const violations = [];
  const seenNames = new Set();
  for (const name of GEO_WATER_CLASS_NAMES) {
    const code = GEO_WATER_CLASS_NAMES.indexOf(name);
    const appearance = GDO_WATER_VISUAL_CLASSES[code];
    if (!appearance) { violations.push(`class ${name} has no declared appearance`); continue; }
    if (appearance.name !== name) violations.push(`class ${name} declares the wrong name ${appearance.name}`);
    if (seenNames.has(appearance.name)) violations.push(`class ${name} is declared twice`);
    seenNames.add(appearance.name);
    for (const field of ['shallow', 'deep']) {
      const value = appearance[field];
      if (!Array.isArray(value) || value.length !== 3 || value.some(channel => !(channel >= 0 && channel <= 1))) {
        violations.push(`class ${name} has an invalid ${field} tint`);
      }
    }
    for (const field of ['waveStrength', 'flowAlignment', 'foam', 'reflect', 'speed']) {
      if (!(appearance[field] >= 0)) violations.push(`class ${name} has an invalid ${field}`);
    }
    // The rendered classes that advect waves are exactly `TER-08`'s flowing
    // classes: a lake cannot advertise a tangent and a river cannot ignore one.
    const flowing = GEO_WATER_FLOWING_CLASSES.includes(code);
    if (appearance.usesFlow !== flowing) {
      violations.push(`class ${name} disagrees with the flowing vocabulary`);
    }
    if (flowing && !(appearance.flowAlignment > 0)) {
      violations.push(`class ${name} is flowing water but ignores its flow tangent`);
    }
    if (!flowing && appearance.flowAlignment !== 0) {
      violations.push(`class ${name} has no mapped flow but aligns to a tangent`);
    }
    if (appearance.waveScales.length !== caps.waveScalesPerClass) {
      violations.push(`class ${name} declares ${appearance.waveScales.length} wave scales`);
    }
  }
  if (seenNames.size !== GEO_WATER_CLASS_NAMES.length) {
    violations.push(`the table declares ${seenNames.size} of ${GEO_WATER_CLASS_NAMES.length} classes`);
  }
  const low = GDO_WATER_VISUAL_PROFILES.low;
  if (low.path !== 'opaque' || low.blended || low.alpha !== 1 || !low.depthWrite || low.blendedFamilies !== 0) {
    violations.push('the low path must be opaque, depth-writing, and single-family');
  }
  if (low.foamMode !== 'dither') violations.push('the low path may not blend foam');
  if (low.overdrawLayers !== 1) violations.push('the low path may not stack water layers');
  // The low path's declared numbers and the shipped low-profile budget are the
  // same claim: prove it rather than letting them drift apart.
  const lowCeiling = caps.profiles?.low ?? {};
  const withheldAgreement = [
    ['waterVisualBlendedFamilies', low.blendedFamilies, lowCeiling.blendedFamilies],
    ['waterVisualOverdrawLayers', low.overdrawLayers, lowCeiling.overdrawLayers],
    ['waterVisualWaveScales', low.waveScaleCount, lowCeiling.waveScales],
    ['waterVisualMinimumAlpha', low.alpha, lowCeiling.minimumAlpha],
    ['waterVisualBlendedCoveragePercent', low.blendedCoveragePercent, lowCeiling.blendedCoveragePercent],
  ];
  for (const [key, declared, ceiling] of withheldAgreement) {
    if (!(ceiling >= 0)) { violations.push(`the low path has no ${key} ceiling`); continue; }
    if (declared !== ceiling) violations.push(`the low path declares ${key}=${declared} but the ceiling is ${ceiling}`);
    // `waterVisualMinimumAlpha` is a floor, every other low-profile key a ceiling.
    if (!(budgets[key] >= 0)) continue;
    if (key === 'waterVisualMinimumAlpha') {
      if (declared < budgets[key]) violations.push(`the low path fades below the ${key} floor`);
    } else if (declared > budgets[key]) violations.push(`the low path exceeds the ${key} budget`);
  }
  for (const [name, profile] of Object.entries(GDO_WATER_VISUAL_PROFILES)) {
    const ceiling = caps.profiles?.[name];
    if (!ceiling) { violations.push(`${name} has no declared ceiling`); continue; }
    if (profile.blendedFamilies > ceiling.blendedFamilies) violations.push(`${name} spends ${profile.blendedFamilies} blended water families`);
    if (profile.overdrawLayers > ceiling.overdrawLayers) violations.push(`${name} allows ${profile.overdrawLayers} water layers`);
    if (profile.waveScaleCount > ceiling.waveScales) violations.push(`${name} enables ${profile.waveScaleCount} wave scales`);
    if (profile.alpha < ceiling.minimumAlpha) violations.push(`${name} fades water to ${profile.alpha}, below the floor`);
    if (profile.blendedCoveragePercent > ceiling.blendedCoveragePercent) {
      violations.push(`${name} allows ${profile.blendedCoveragePercent}% blended water coverage`);
    }
    if (profile.blended !== (profile.blendedFamilies > 0)) violations.push(`${name} disagrees about whether it blends`);
    if (profile.foamMode === 'blended' && !profile.blended) violations.push(`${name} blends foam on an opaque path`);
    if (profile.waveScaleCount < 1 || profile.waveScaleCount > caps.waveScalesPerClass) {
      violations.push(`${name} declares an impossible wave scale count`);
    }
    if (!['opaque', 'blended'].includes(profile.path)) violations.push(`${name} declares an unknown path`);
  }
  return Object.freeze({
    namespace: GDO_WATER_VISUAL_NAMESPACE,
    ok: violations.length === 0,
    classes: seenNames.size,
    profiles: Object.keys(GDO_WATER_VISUAL_PROFILES).length,
    violations: Object.freeze(violations),
  });
}

/**
 * The measured half of "bounded": given what the frame actually drew, decide
 * whether the profile's declared ceilings hold. An unmeasurable input fails
 * instead of passing silently, exactly like the movement-audit budgets.
 */
export function waterCoverageReport({ profile = 'low', waterPixels, viewportPixels, layers = 1, blendedFamilies = 0 } = {}) {
  const declared = waterVisualProfileFor(profile);
  const reasons = [];
  if (!(viewportPixels > 0)) reasons.push('viewportPixels must be measured');
  if (!(waterPixels >= 0) || !Number.isFinite(waterPixels)) reasons.push('waterPixels must be measured');
  if (!Number.isInteger(layers) || layers < 1) reasons.push('layers must be a measured integer');
  if (!Number.isInteger(blendedFamilies) || blendedFamilies < 0) reasons.push('blendedFamilies must be a measured integer');
  const coverage = viewportPixels > 0 && Number.isFinite(waterPixels) ? waterPixels / viewportPixels : null;
  const blendedCoverage = declared.blended ? coverage : 0;
  if (coverage != null && coverage > 1) reasons.push('water cannot cover more than the viewport');
  if (layers > declared.overdrawLayers) reasons.push(`${layers} water layers exceed the ${declared.overdrawLayers}-layer ceiling`);
  if (blendedFamilies > declared.blendedFamilies) {
    reasons.push(`${blendedFamilies} blended families exceed the ${declared.blendedFamilies}-family ceiling`);
  }
  if (blendedCoverage != null && blendedCoverage * 100 > declared.blendedCoveragePercent) {
    reasons.push(`${(blendedCoverage * 100).toFixed(1)}% blended coverage exceeds ${declared.blendedCoveragePercent}%`);
  }
  return Object.freeze({
    namespace: GDO_WATER_VISUAL_NAMESPACE,
    profile,
    path: declared.path,
    waterPixels: Number.isFinite(waterPixels) ? waterPixels : null,
    viewportPixels: viewportPixels > 0 ? viewportPixels : null,
    coverage,
    blendedCoverage,
    layers,
    blendedFamilies,
    declared: waterVisualBudgetForProfile(profile),
    ok: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
}

const WATER_VERTEX_SHADER = `
  #include <fog_pars_vertex>
  attribute vec3 gdoWaterShallow;
  attribute vec3 gdoWaterDeep;
  attribute vec4 gdoWaterManner;
  attribute vec2 gdoWaterFlow;
  attribute float gdoWaterClass;
  varying vec3 vWorldPosition;
  varying vec3 vColor;
  varying vec3 vWaterShallow;
  varying vec3 vWaterDeep;
  varying vec4 vWaterManner;
  varying vec2 vWaterFlow;
  varying float vWaterClass;
  void main() {
    vColor = color;
    vWaterShallow = gdoWaterShallow;
    vWaterDeep = gdoWaterDeep;
    vWaterManner = gdoWaterManner;
    vWaterFlow = gdoWaterFlow;
    vWaterClass = gdoWaterClass;
    vec3 transformed = position;
    vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
    vWorldPosition = worldPosition.xyz;
    vec4 mvPosition = viewMatrix * worldPosition;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const WATER_FRAGMENT_SHADER = `
  #include <fog_pars_fragment>
  uniform float uTime;
  uniform sampler2D uSurfaceNoise;
  uniform sampler2D uWaterNormal;
  uniform sampler2D uFoamDither;
  uniform vec2 uNormalFade;
  uniform vec2 uWaveScales;
  uniform vec2 uWaveStrength;
  uniform float uWaveSpeed;
  uniform float uWaterAlpha;
  uniform float uReflectStrength;
  uniform float uFoamMode;
  uniform float uDitherSize;
  varying vec3 vWorldPosition;
  varying vec3 vColor;
  varying vec3 vWaterShallow;
  varying vec3 vWaterDeep;
  varying vec4 vWaterManner;
  varying vec2 vWaterFlow;
  varying float vWaterClass;
  void main() {
    vec3 eye = normalize(cameraPosition - vWorldPosition);
    float distanceToEye = distance(cameraPosition, vWorldPosition);
    float normalVisibility = 1.0 - smoothstep(uNormalFade.x, uNormalFade.y, distanceToEye);
    // Flowing classes advect their ripples along the mapped tangent; still
    // classes (and every unmatched polygon) only breathe in place.
    vec2 flow = vWaterFlow * vWaterManner.y;
    float speed = uWaveSpeed * uWaveSpeed;
    vec2 broadUv = vWorldPosition.xz * uWaveScales.x - flow * uTime * 0.06;
    vec2 fineUv = vWorldPosition.xz * uWaveScales.y - flow * uTime * 0.11;
    vec2 normalUv = broadUv + vec2(-uTime * 0.004, uTime * 0.003);
    vec3 waterNormal = texture2D(uWaterNormal, normalUv).xyz * 2.0 - 1.0;
    float fine = texture2D(uSurfaceNoise, fineUv).r - 0.5;
    waterNormal = normalize(vec3(
      waterNormal.xy * normalVisibility * vWaterManner.x,
      max(0.2, waterNormal.z)));
    float macro = texture2D(uSurfaceNoise, vWorldPosition.xz * 0.035 + flow * uTime * 0.01).r;
    float fresnel = pow(1.0 - max(dot(eye, waterNormal.xzy), 0.0), 2.0);
    // Shallow tint into the deep tint, both from the class's own palette. A
    // mapped water mesh only has ring vertices, so there is no interior sample to
    // carry a geometric bank band: the shallow/deep blend is driven by the same
    // broad generated noise the rest of the world reads, biased to the deep tint.
    float depth = clamp(0.35 + (macro - 0.5) * 0.9, 0.0, 1.0);
    vec3 body = mix(vWaterDeep, vWaterShallow, depth);
    body = mix(body, mix(body, vColor, 0.35), 0.25);
    vec3 color = mix(body * mix(0.90, 1.06, macro), vec3(0.42, 0.73, 0.82) * mix(0.8, 1.2, uReflectStrength),
      fresnel * uReflectStrength);
    color += fine * 0.035 * vWaterManner.x;
    // Foam is a class property, and a dithered one on the opaque paths: a
    // fragment is either painted or dropped, never stacked.
    float foam = vWaterManner.z * (0.55 + 0.45 * fine * 2.0) * uWaveStrength.x;
    if (foam > 0.001) {
      float dither = texture2D(uFoamDither, gl_FragCoord.xy / uDitherSize).r;
      if (uFoamMode < 0.5) {
        if (dither > foam * 0.35) discard;
        color = mix(color, vec3(0.94, 0.97, 0.98), 0.55);
      } else {
        color = mix(color, vec3(0.94, 0.97, 0.98), clamp(foam * 0.35, 0.0, 0.5));
      }
    }
    gl_FragColor = vec4(color, uWaterAlpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/**
 * The water material. One material, one draw family per tile at every profile:
 * the profile decides the blend path and the uniform values, never the family
 * count. Switching profiles is uniform-only plus the two material flags, so no
 * recompile happens and the program cache key stays put.
 */
export function createWaterVisualMaterial({ library, profile = 'low', dither = true } = {}) {
  const declared = waterVisualProfileFor(profile);
  if (!library?.textures?.waterNormal || !library?.textures?.surfaceNoise) {
    throw new RangeError('Water visuals need the shared generated material library');
  }
  const ditherTexture = library.textures.dither ?? null;
  if (dither && !ditherTexture) throw new RangeError('Water visuals need the shared dither texture');
  const material = new THREE.ShaderMaterial({
    transparent: declared.blended,
    depthWrite: declared.depthWrite,
    fog: true,
    vertexColors: true,
    uniforms: {
      uTime: { value: 0 },
      uSurfaceNoise: { value: library.textures.surfaceNoise },
      uWaterNormal: { value: library.textures.waterNormal },
      uFoamDither: { value: ditherTexture },
      uNormalFade: { value: new THREE.Vector2(...declared.normalFade) },
      uWaveScales: { value: new THREE.Vector2(...waterVisualAppearance(GEO_WATER_CLASS.LAKE).waveScales) },
      uWaveStrength: { value: new THREE.Vector2(declared.waveStrength, declared.waveScaleCount > 1 ? declared.waveStrength : 0) },
      uWaveSpeed: { value: 1 },
      uWaterAlpha: { value: declared.alpha },
      uReflectStrength: { value: declared.reflectStrength },
      uFoamMode: { value: declared.foamMode === 'blended' ? 1 : 0 },
      uDitherSize: { value: GDO_LOW_PROFILE_BUDGETS.waterVisualDitherSize },
      fogColor: { value: new THREE.Color() },
      fogNear: { value: 1 },
      fogFar: { value: 1000 },
    },
    vertexShader: WATER_VERTEX_SHADER,
    fragmentShader: WATER_FRAGMENT_SHADER,
  });
  material.name = 'gdo:waterVisual';
  material.userData.gdoWaterVisual = Object.freeze({
    namespace: GDO_WATER_VISUAL_NAMESPACE,
    profile,
    path: declared.path,
    blendedFamilies: declared.blendedFamilies,
    overdrawLayers: declared.overdrawLayers,
    waveScales: declared.waveScaleCount,
    alpha: declared.alpha,
    foamMode: declared.foamMode,
    recompiles: 0,
  });
  return material;
}

/**
 * Runtime policy around one water material: profile changes, the per-frame time
 * uniform, and the counters the debug surface reports. Everything it does per
 * frame is one uniform write into preallocated objects.
 */
export function createWaterVisualPolicy({ material, library = null, profile = 'low' } = {}) {
  if (!material?.uniforms?.uWaterAlpha) throw new TypeError('Water visual policy needs a water material');
  const state = {
    profile, writes: 0, frames: 0, profileChanges: 0, allocations: 0,
    coverage: null, lastFrameWrites: 0,
  };
  const record = () => {
    const declared = GDO_WATER_VISUAL_PROFILES[state.profile];
    return Object.freeze({
      namespace: GDO_WATER_VISUAL_NAMESPACE,
      profile: state.profile,
      path: declared.path,
      blendedFamilies: declared.blendedFamilies,
      overdrawLayers: declared.overdrawLayers,
      waveScales: declared.waveScaleCount,
      alpha: declared.alpha,
      foamMode: declared.foamMode,
      transparent: material.transparent,
      depthWrite: material.depthWrite,
      coveragePercent: declared.blendedCoveragePercent,
    });
  };
  const write = (name, value) => { material.uniforms[name].value = value; state.writes++; state.lastFrameWrites++; };
  const applyProfile = name => {
    const declared = waterVisualProfileFor(name);
    material.transparent = declared.blended;
    material.depthWrite = declared.depthWrite;
    write('uWaterAlpha', declared.alpha);
    write('uWaveStrength', new THREE.Vector2(declared.waveStrength, declared.waveScaleCount > 1 ? declared.waveStrength : 0));
    write('uReflectStrength', declared.reflectStrength);
    write('uFoamMode', declared.foamMode === 'blended' ? 1 : 0);
    write('uNormalFade', new THREE.Vector2(...declared.normalFade));
    state.profile = name;
    state.profileChanges++;
    return record();
  };
  applyProfile(profile);
  return {
    namespace: GDO_WATER_VISUAL_NAMESPACE,
    material,
    get profile() { return state.profile; },
    get appearance() { return record(); },
    setProfile: applyProfile,
    /** One uniform write per steady frame; `dt` is unused so frames stay frame-keyed. */
    beginFrame(nowMilliseconds) {
      state.frames++;
      state.lastFrameWrites = 0;
      write('uTime', (nowMilliseconds ?? 0) / 1000);
    },
    /** Bind the class table to a vertex of one class; the CPU bake entry point. */
    appearanceForClass: waterVisualVertexAppearance,
    /** Record the measured coverage of a frame for the bounded-path verdict. */
    recordCoverage(measured) {
      state.coverage = waterCoverageReport({ profile: state.profile, ...measured });
      return state.coverage;
    },
    get diagnostics() {
      return Object.freeze({
        namespace: GDO_WATER_VISUAL_NAMESPACE,
        profile: state.profile,
        path: GDO_WATER_VISUAL_PROFILES[state.profile].path,
        classes: Object.keys(GDO_WATER_VISUAL_CLASSES).length,
        blendedFamilies: GDO_WATER_VISUAL_PROFILES[state.profile].blendedFamilies,
        materialRecompiles: 0,
        uniformWrites: state.writes,
        steadyFrameWrites: state.lastFrameWrites,
        steadyFrameAllocations: state.allocations,
        profileChanges: state.profileChanges,
        frames: state.frames,
        coverage: state.coverage,
      });
    },
  };
}
