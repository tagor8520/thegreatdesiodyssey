import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_WATER_VISUAL_CLASSES,
  GDO_WATER_VISUAL_NAMESPACE,
  GDO_WATER_VISUAL_PROFILES,
  createWaterVisualMaterial,
  createWaterVisualPolicy,
  validateWaterVisualClasses,
  waterCoverageReport,
  waterVisualAppearance,
  waterVisualBaseColor,
  waterVisualBudgetForProfile,
  waterVisualProfileFor,
  waterVisualVertexAppearance,
} from './WaterVisualClasses.js';
import { GDO_LOW_PROFILE_BUDGETS, GDO_WATER_VISUAL_CAPS } from './PerformanceBudget.js';
import { featureNamespace } from './FeatureVersions.js';
import { acquireProceduralMaterialLibrary } from './ProceduralMaterials.js';
import { GEO_WATER_CLASS, GEO_WATER_CLASS_NAMES, GEO_WATER_FLOWING_CLASSES } from '../geo/GeoWaterDomains.js';

/**
 * `ENV-03` gate: the water appearance is one declared class table, the low path
 * is opaque and single-family, the higher path is blended but bounded by declared
 * ceilings that the coverage report measures against, and the class/flow bake
 * reaches the mesh as attributes rather than as per-frame class work.
 */

test('every TER-08 class has one declared appearance, and still water stays still', () => {
  assert.equal(GDO_WATER_VISUAL_NAMESPACE, featureNamespace('waterVisual'));
  assert.equal(GDO_WATER_VISUAL_NAMESPACE, 'gdo:waterVisual:v1');
  assert.equal(Object.keys(GDO_WATER_VISUAL_CLASSES).length, GEO_WATER_CLASS_NAMES.length);
  for (const name of GEO_WATER_CLASS_NAMES) {
    const code = GEO_WATER_CLASS_NAMES.indexOf(name);
    const appearance = waterVisualAppearance(code);
    assert.equal(appearance.name, name);
    assert.equal(appearance.code, code);
    assert.deepEqual(waterVisualAppearanceByNameAlias(name), code);
    // Tints are real colours in range, and shallow is lighter than deep: the
    // bank-to-centre gradient the research asks for is a table property.
    const luma = tint => tint[0] * .2126 + tint[1] * .7152 + tint[2] * .0722;
    assert.ok(luma(appearance.shallow) > luma(appearance.deep), `${name} bank is lighter than its centre`);
    // The classes that advect waves are exactly `TER-08`'s flowing classes.
    if (GEO_WATER_FLOWING_CLASSES.includes(code)) assert.ok(appearance.flowAlignment > 0, name);
    else assert.equal(appearance.flowAlignment, 0, name);
    assert.equal(appearance.waveScales.length, GDO_WATER_VISUAL_CAPS.waveScalesPerClass, name);
    const vertex = waterVisualVertexAppearance(code);
    assert.deepEqual([...vertex.shallow], [...appearance.shallow]);
    assert.deepEqual([...vertex.manner], [appearance.waveStrength, appearance.flowAlignment, appearance.foam, appearance.reflect]);
    assert.deepEqual([...waterVisualBaseColor(code)], [...appearance.deep]);
  }
  // Lakes and oceans must not advertise flow: TER-08 keeps their tangent zero and
  // the appearance table agrees, while the ocean still swells.
  assert.equal(waterVisualAppearance(GEO_WATER_CLASS.LAKE).flowAlignment, 0);
  assert.equal(waterVisualAppearance(GEO_WATER_CLASS.OCEAN).flowAlignment, 0);
  assert.equal(waterVisualAppearance(GEO_WATER_CLASS.LAKE).usesFlow, false);
  assert.ok(waterVisualAppearance(GEO_WATER_CLASS.OCEAN).waveStrength > waterVisualAppearance(GEO_WATER_CLASS.LAKE).waveStrength);
  // An unknown code is a declared fallback, not an undefined read.
  assert.equal(waterVisualAppearance(99).name, 'unknown');
  assert.throws(() => waterVisualProfileFor('ultra'), /Unknown water visual profile/);
  assert.throws(() => waterVisualAppearanceByNameAlias('nope'), /Unknown water visual class/);
});

/** Local helper: the name lookup without importing it twice in the same file. */
function waterVisualAppearanceByNameAlias(name) {
  const code = GEO_WATER_CLASS_NAMES.indexOf(name);
  if (code < 0) throw new RangeError(`Unknown water visual class: ${name}`);
  return code;
}

test('the low path is opaque and single-family, and the budget proves it', () => {
  const low = waterVisualProfileFor('low');
  assert.equal(low.path, 'opaque');
  assert.equal(low.blended, false);
  assert.equal(low.alpha, 1);
  assert.equal(low.depthWrite, true);
  assert.equal(low.blendedFamilies, 0);
  assert.equal(low.overdrawLayers, 1);
  assert.equal(low.waveScaleCount, 1);
  assert.equal(low.foamMode, 'dither');
  // The declared path and the shipped budget are the same claim.
  assert.equal(low.blendedFamilies, GDO_LOW_PROFILE_BUDGETS.waterVisualBlendedFamilies);
  assert.equal(low.overdrawLayers, GDO_LOW_PROFILE_BUDGETS.waterVisualOverdrawLayers);
  assert.equal(low.waveScaleCount, GDO_LOW_PROFILE_BUDGETS.waterVisualWaveScales);
  assert.ok(low.alpha >= GDO_LOW_PROFILE_BUDGETS.waterVisualMinimumAlpha, 'the low path never fades below the floor');
  assert.equal(low.blendedCoveragePercent, GDO_LOW_PROFILE_BUDGETS.waterVisualBlendedCoveragePercent);
  const verdict = validateWaterVisualClasses();
  assert.equal(verdict.ok, true, verdict.violations.join('; '));
  assert.equal(verdict.classes, GEO_WATER_CLASS_NAMES.length);
  assert.equal(verdict.profiles, 3);
  // A widened low path and an over-ceiling higher path are both refused.
  const widened = validateWaterVisualClasses({
    budgets: GDO_LOW_PROFILE_BUDGETS,
    caps: { ...GDO_WATER_VISUAL_CAPS, profiles: { ...GDO_WATER_VISUAL_CAPS.profiles, low: { ...GDO_WATER_VISUAL_CAPS.profiles.low, blendedFamilies: 1 } } },
  });
  assert.equal(widened.ok, false);
  assert.ok(widened.violations.some(violation => /low path declares waterVisualBlendedFamilies/.test(violation)));
  const overHigh = validateWaterVisualClasses({
    budgets: GDO_LOW_PROFILE_BUDGETS,
    caps: { ...GDO_WATER_VISUAL_CAPS, profiles: { ...GDO_WATER_VISUAL_CAPS.profiles, high: { ...GDO_WATER_VISUAL_CAPS.profiles.high, overdrawLayers: 2 } } },
  });
  assert.equal(overHigh.ok, false);
  assert.ok(overHigh.violations.some(violation => /high allows 3 water layers/.test(violation)));
  for (const profile of ['low', 'balanced', 'high']) {
    const budget = waterVisualBudgetForProfile(profile);
    assert.equal(budget.overdrawLayers, waterVisualProfileFor(profile).overdrawLayers);
    assert.equal(budget.blendedFamilies, waterVisualProfileFor(profile).blendedFamilies);
  }
});

test('the higher path is blended but bounded, and the coverage report measures it', () => {
  const viewportPixels = 1280 * 720;
  // Low: any amount of water is still zero blended coverage.
  const low = waterCoverageReport({ profile: 'low', waterPixels: viewportPixels, viewportPixels, layers: 1, blendedFamilies: 0 });
  assert.equal(low.ok, true);
  assert.equal(low.blendedCoverage, 0);
  // One blended family is the ceiling at balanced and high; two is refused.
  const twoFamilies = waterCoverageReport({ profile: 'balanced', waterPixels: 1000, viewportPixels, layers: 2, blendedFamilies: 2 });
  assert.equal(twoFamilies.ok, false);
  assert.ok(twoFamilies.reasons.some(reason => /blended families exceed/.test(reason)));
  // Overdraw is capped per profile: low allows one layer, high three, none four.
  assert.equal(waterCoverageReport({ profile: 'low', waterPixels: 1000, viewportPixels, layers: 2 }).ok, false);
  assert.equal(waterCoverageReport({ profile: 'high', waterPixels: 1000, viewportPixels, layers: 3 }).ok, true);
  assert.equal(waterCoverageReport({ profile: 'high', waterPixels: 1000, viewportPixels, layers: 4 }).ok, false);
  // Blended coverage is bounded: full-screen water passes at high, fails past it.
  assert.equal(waterCoverageReport({ profile: 'high', waterPixels: viewportPixels * .9, viewportPixels, layers: 2 }).ok, true);
  assert.equal(waterCoverageReport({ profile: 'balanced', waterPixels: viewportPixels * .8, viewportPixels, layers: 1 }).ok, false);
  // Unmeasurable input fails instead of passing silently.
  const unmeasured = waterCoverageReport({ profile: 'high', waterPixels: NaN, viewportPixels: 0 });
  assert.equal(unmeasured.ok, false);
  assert.equal(unmeasured.waterPixels, null);
  assert.ok(unmeasured.reasons.some(reason => /viewportPixels must be measured/.test(reason)));
});

test('one material holds both paths, and switching profile recompiles nothing', () => {
  const handle = acquireProceduralMaterialLibrary();
  try {
    const material = createWaterVisualMaterial({ library: handle.library, profile: 'low' });
    assert.equal(material.name, 'gdo:waterVisual');
    assert.equal(material.transparent, false);
    assert.equal(material.depthWrite, true);
    // The opaque path discards rather than blends, using the one shared 8×8
    // dither the fade policy also reads.
    assert.equal(material.uniforms.uFoamDither.value, handle.library.textures.dither);
    assert.equal(material.uniforms.uDitherSize.value, GDO_LOW_PROFILE_BUDGETS.waterVisualDitherSize);
    assert.equal(handle.library.textures.dither.image.width, GDO_LOW_PROFILE_BUDGETS.waterVisualDitherSize);
    assert.equal(material.uniforms.uWaterAlpha.value, 1);
    assert.equal(material.uniforms.uWaveStrength.value.y, 0, 'low enables one wave scale');
    assert.match(material.fragmentShader, /if \(dither > foam \* 0\.35\) discard;/);
    assert.match(material.vertexShader, /attribute float gdoWaterClass;/);
    assert.doesNotMatch(material.fragmentShader, /uWaterShallow\[/);

    const policy = createWaterVisualPolicy({ material, library: handle.library, profile: 'low' });
    assert.equal(policy.namespace, GDO_WATER_VISUAL_NAMESPACE);
    assert.equal(policy.appearance.path, 'opaque');
    assert.equal(policy.appearance.transparent, false);
    assert.equal(policy.appearance.depthWrite, true);
    const programKey = material.customProgramCacheKey?.() ?? 'none';
    const before = material.uniforms.uWaterAlpha.value;
    const high = policy.setProfile('high');
    assert.equal(high.path, 'blended');
    assert.equal(high.blendedFamilies, 1);
    assert.equal(material.transparent, true);
    assert.equal(material.depthWrite, false);
    assert.equal(material.uniforms.uWaterAlpha.value, waterVisualProfileFor('high').alpha);
    assert.notEqual(material.uniforms.uWaterAlpha.value, before);
    assert.equal(material.uniforms.uWaveStrength.value.y > 0, true, 'high enables the fine wave scale');
    assert.equal(material.uniforms.uFoamMode.value, 1, 'high blends foam');
    assert.equal(material.uniforms.uNormalFade.value.toArray().join(), '28,120');
    assert.equal(material.customProgramCacheKey?.() ?? 'none', programKey);
    assert.equal(material.needsUpdate, undefined, 'a profile change is uniform-only');
    // Back to low: the same material, the same program, the opaque path again.
    assert.equal(policy.setProfile('low').path, 'opaque');
    assert.equal(material.transparent, false);

    // Per-frame cost is one write into a preallocated uniform, and nothing is
    // allocated on a steady frame.
    policy.beginFrame(1000);
    policy.beginFrame(1016);
    const diagnostics = policy.diagnostics;
    assert.equal(diagnostics.steadyFrameWrites, GDO_LOW_PROFILE_BUDGETS.waterVisualUniformWritesPerFrame);
    assert.equal(diagnostics.steadyFrameAllocations, GDO_LOW_PROFILE_BUDGETS.waterVisualSteadyFrameAllocations);
    assert.equal(diagnostics.materialRecompiles, 0);
    assert.equal(diagnostics.classes, GEO_WATER_CLASS_NAMES.length);
    assert.ok(diagnostics.uniformWrites > diagnostics.steadyFrameWrites);
    // The material and policy refuse to exist without the shared library.
    assert.throws(() => createWaterVisualMaterial({ library: { textures: {} } }), /shared generated material library/);
    assert.throws(() => createWaterVisualMaterial({ library: { textures: { waterNormal: {}, surfaceNoise: {} } } }), /dither texture/);
    assert.throws(() => createWaterVisualPolicy({ material: {} }), /needs a water material/);
    material.dispose();
  } finally {
    handle.release();
  }
});
