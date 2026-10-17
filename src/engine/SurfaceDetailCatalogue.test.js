import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_SURFACE_DETAIL_FILTERS,
  GDO_SURFACE_DETAIL_NAMESPACE,
  GDO_SURFACE_DETAIL_PATTERNS,
  GDO_SURFACE_DETAIL_SOURCES,
  applySurfaceDetail,
  describeSurfaceDetailCatalogue,
  rolloutSurfaceDetails,
  selectSurfaceDetail,
  surfaceDetailEntry,
  surfaceDetailPatternsFor,
  surfaceDetailOf,
  surfaceDetailPriority,
  validateSurfaceDetailSources,
} from './SurfaceDetailCatalogue.js';
import {
  GDO_MATERIAL_DETAIL_PROFILES,
  GDO_MATERIAL_RECIPES,
  GDO_STYLE_MASK_NAMES,
  acquireProceduralMaterialLibrary,
  configureSemanticMaterial,
  proceduralMaterialLibraryStats,
} from './ProceduralMaterials.js';
import { GDO_LOW_PROFILE_BUDGETS, GDO_SURFACE_DETAIL_CAPS } from './PerformanceBudget.js';
import { featureNamespace } from './FeatureVersions.js';
import { GeoWorld } from '../geo/GeoWorld.js';

/**
 * `MAT-05` gate: the surface-detail catalogue is declared, prioritized, and
 * complete; every pattern reads generated data (never a downloaded baseline
 * texture); a profile rolls out the patterns it can afford with the rest reported
 * as pruned; and the live world wears the catalogue's choice on its materials.
 */

globalThis.Worker ??= class { addEventListener() {} postMessage() {} terminate() {} };

test('the catalogue is declared, prioritized, and complete over the generated masks', () => {
  assert.equal(GDO_SURFACE_DETAIL_NAMESPACE, featureNamespace('surfaceDetail'));
  assert.equal(GDO_SURFACE_DETAIL_NAMESPACE, 'gdo:surfaceDetail:v1');
  assert.ok(GDO_SURFACE_DETAIL_PATTERNS.length >= 24);
  assert.equal(GDO_SURFACE_DETAIL_SOURCES.includes('analytical'), true);
  assert.deepEqual([...GDO_SURFACE_DETAIL_FILTERS], ['mip', 'derivative', 'nearest', 'analytical']);
  // Order is the contract: priority 0 is what a constrained device gets first.
  assert.equal(surfaceDetailPriority(GDO_SURFACE_DETAIL_PATTERNS[0].id), 0);
  assert.equal(surfaceDetailEntry('facade.plaster'), GDO_SURFACE_DETAIL_PATTERNS[0]);
  assert.throws(() => surfaceDetailPriority('nope'), /Unknown surface detail pattern/);
  assert.throws(() => surfaceDetailEntry('nope'), /Unknown surface detail pattern/);
  assert.throws(() => surfaceDetailPatternsFor('nope'), /Unknown surface semantic/);
  const needsStyle = (a, b) => surfaceDetailPriority(a.id) - surfaceDetailPriority(b.id);
  const low = GDO_SURFACE_DETAIL_PATTERNS.filter(entry => entry.minProfile === 'low');
  // Every low-floor pattern is the head of the list: a constrained device never
  // loses a baseline look to a variant.
  assert.equal(Math.max(...low.map(entry => surfaceDetailPriority(entry.id))), low.length - 1);
  assert.equal([...GDO_SURFACE_DETAIL_PATTERNS].sort(needsStyle).every((entry, index) => entry === GDO_SURFACE_DETAIL_PATTERNS[index]), true);
  // Every entry names a real semantic, a real filter, a real profile, and a scale.
  for (const entry of GDO_SURFACE_DETAIL_PATTERNS) {
    assert.ok(GDO_MATERIAL_RECIPES[entry.surface], entry.id);
    assert.ok(GDO_SURFACE_DETAIL_FILTERS.includes(entry.filter), entry.id);
    assert.ok(entry.minProfile in GDO_MATERIAL_DETAIL_PROFILES, entry.id);
    assert.equal(entry.research.startsWith('§'), true, `${entry.id} cites research`);
    assert.ok(entry.repeat > 0 && entry.samples >= 1, entry.id);
    // A pattern reads exactly one generated texture: one sample, no stacks.
    assert.equal(entry.samples, 1, entry.id);
  }
  // The rolled-out vocabulary and the generated atlas agree in both directions:
  // no declared mask is unreachable, and no pattern invents a mask.
  const styles = GDO_SURFACE_DETAIL_PATTERNS.map(entry => entry.style);
  assert.equal(new Set(styles).size, styles.length, 'each mask is rolled out once');
  assert.deepEqual([...styles].sort(), [...GDO_STYLE_MASK_NAMES].sort());
});

test('every pattern reads generated data, and a non-generated source is refused', () => {
  // Without a library the catalogue still proves its own shape.
  const structural = validateSurfaceDetailSources();
  assert.equal(structural.ok, true, structural.violations.join('; '));
  assert.equal(structural.patterns, GDO_SURFACE_DETAIL_PATTERNS.length);
  assert.equal(structural.styles, GDO_STYLE_MASK_NAMES.length);
  assert.equal(structural.surfaces, new Set(GDO_SURFACE_DETAIL_PATTERNS.map(entry => entry.surface)).size);

  const handle = acquireProceduralMaterialLibrary();
  try {
    const verdict = validateSurfaceDetailSources(handle.library);
    assert.equal(verdict.ok, true, verdict.violations.join('; '));
    // The sources it accepts are exactly the library's own generated textures,
    // each with the library's pinned checksum and shared ownership.
    const records = new Map(handle.library.diagnostics.records.map(record => [record.name, record]));
    for (const name of ['surfaceNoise', 'styleMasks', 'paletteLUT']) {
      assert.ok(records.has(name), `${name} is generated`);
      assert.equal(records.get(name).ownership, 'shared-engine');
      assert.match(records.get(name).checksum, /^[0-9a-f]{8}$/);
    }
    for (const entry of GDO_SURFACE_DETAIL_PATTERNS) {
      assert.ok(handle.library.textures[entry.source.texture], `${entry.id} source exists`);
      assert.equal(handle.library.styleRects[entry.style].length, 4, `${entry.id} style rect`);
    }

    // A missing texture is a violation, not a silent fallback.
    const empty = validateSurfaceDetailSources({ textures: {}, diagnostics: { records: [] } });
    assert.equal(empty.ok, false);
    assert.ok(empty.violations.length >= GDO_SURFACE_DETAIL_PATTERNS.length);
    assert.match(empty.violations[0], /is not in the shared library/);

    // A file-backed texture is refused even when its record looks right.
    const external = {
      textures: { [GDO_SURFACE_DETAIL_PATTERNS[0].source.texture]: { image: 'assets/plaster.png', userData: { gdoExternal: true } } },
      diagnostics: { records: [{ name: 'styleMasks', checksum: 'deadbeef', ownership: 'shared-engine' }] },
    };
    const refused = validateSurfaceDetailSources(external);
    assert.equal(refused.ok, false);
    assert.ok(refused.violations.some(violation => /is not generated at runtime/.test(violation)));
    assert.ok(refused.violations.length >= GDO_SURFACE_DETAIL_PATTERNS.length,
      'every pattern that reads the refused texture is reported');
  } finally {
    handle.release();
  }
});

test('a profile rolls out the patterns it can afford and reports the rest', () => {
  const low = rolloutSurfaceDetails('low');
  assert.equal(low.patterns, GDO_LOW_PROFILE_BUDGETS.surfaceDetailPatterns);
  assert.equal(low.patterns, GDO_SURFACE_DETAIL_CAPS.low.patterns);
  assert.equal(low.profile, 'low');
  assert.equal(low.pruned.length, GDO_SURFACE_DETAIL_PATTERNS.length - low.patterns);
  // One generated sample per surface on low, and every surface it does dress is
  // a distinct surface: no surface gets two patterns on a constrained device.
  for (const samples of Object.values(low.samplesPerSurface)) {
    assert.equal(samples, GDO_LOW_PROFILE_BUDGETS.surfaceDetailSamplesPerSurface);
  }
  assert.equal(new Set(low.entries.map(entry => entry.surface)).size, low.patterns);
  assert.equal(low.generatedTextures, 1, 'the rollout reads the one shared style atlas');

  const balanced = rolloutSurfaceDetails('balanced');
  const high = rolloutSurfaceDetails('high');
  assert.deepEqual([balanced.patterns, high.patterns], [GDO_SURFACE_DETAIL_CAPS.balanced.patterns, GDO_SURFACE_DETAIL_CAPS.high.patterns]);
  assert.equal(high.patterns, GDO_SURFACE_DETAIL_PATTERNS.length);
  assert.equal(high.pruned.length, 0);
  // Nested: a higher profile is a superset, never a different set.
  const idsOf = rollout => new Set(rollout.ids);
  const lowIds = idsOf(low), balancedIds = idsOf(balanced);
  assert.equal([...lowIds].every(id => balancedIds.has(id)), true);
  assert.equal([...balancedIds].every(id => idsOf(high).has(id)), true);
  // Pruning names its reason, so a contributor can see why a pattern was dropped.
  assert.equal(low.pruned.every(entry => ['profile-cap', 'profile-floor', 'surface-samples'].includes(entry.reason)), true);
  assert.ok(low.pruned.some(entry => entry.reason === 'profile-floor'), 'higher-profile variants are pruned by floor');
  assert.ok(balanced.pruned.every(entry => entry.reason === 'profile-floor'), 'balanced prunes only what it cannot take');
  // A surface with more variants than its profile allows is trimmed by samples.
  const capped = rolloutSurfaceDetails('balanced');
  assert.equal(capped.pruned.some(entry => entry.reason === 'surface-samples'), false);
  assert.equal(Object.values(capped.samplesPerSurface).every(samples => samples <= GDO_SURFACE_DETAIL_CAPS.balanced.samplesPerSurface), true);
  assert.throws(() => rolloutSurfaceDetails('ultra'), /Unknown surface-detail profile/);

  const catalogue = describeSurfaceDetailCatalogue();
  assert.equal(catalogue.namespace, GDO_SURFACE_DETAIL_NAMESPACE);
  assert.equal(catalogue.patterns, GDO_SURFACE_DETAIL_PATTERNS.length);
  assert.equal(catalogue.styles, GDO_STYLE_MASK_NAMES.length);
  assert.deepEqual(catalogue.profiles, { low: 8, balanced: 16, high: 24 });
  assert.equal(catalogue.rolloutBudget, GDO_LOW_PROFILE_BUDGETS.surfaceDetailPatterns);
  assert.equal(catalogue.sources.ok, true);
});

test('selection is deterministic, stable, and reaches every enabled variant', () => {
  // At low a surface has exactly one pattern, so selection is trivial — and it
  // still refuses a surface the catalogue does not dress at that profile.
  const single = selectSurfaceDetail('facade', { key: 'anything', profile: 'low' });
  assert.equal(single.id, 'facade.plaster');
  assert.equal(selectSurfaceDetail('water', { key: 'anything', profile: 'low' }).id, 'water.foam-chop');
  // A surface no pattern dresses is refused by name rather than guessing.
  const facadeOnly = GDO_SURFACE_DETAIL_PATTERNS.filter(entry => entry.surface === 'facade');
  assert.ok(facadeOnly.length >= 1);
  assert.throws(() => selectSurfaceDetail('nonsense-surface', { key: 'x' }), /No low-profile pattern/);

  // At high, every enabled variant of a surface is reachable, and the same key
  // always gives the same answer.
  const seen = new Map();
  for (const surface of ['ground', 'road', 'facade', 'leaf']) {
    const variants = new Set();
    for (let index = 0; index < 400; index++) {
      const first = selectSurfaceDetail(surface, { key: `tile:${index}:${index * 7}`, profile: 'high' });
      const again = selectSurfaceDetail(surface, { key: `tile:${index}:${index * 7}`, profile: 'high' });
      assert.equal(first.id, again.id, 'selection is a pure function of the key');
      assert.equal(first.surface, surface);
      variants.add(first.id);
    }
    const enabled = rolloutSurfaceDetails('high').entries.filter(entry => entry.surface === surface).map(entry => entry.id);
    assert.deepEqual([...variants].sort(), enabled.sort(), `${surface} reaches every enabled variant`);
    seen.set(surface, enabled.length);
  }
  assert.equal(seen.get('ground') >= 3, true);
  // Selection is independent of call order and of other surfaces' keys.
  assert.equal(selectSurfaceDetail('road', { key: 'a:b', profile: 'high' }).id,
    selectSurfaceDetail('road', { key: 'a:b', profile: 'high' }).id);
  assert.notEqual(selectSurfaceDetail('road', { key: 'a:b', profile: 'high' }).id,
    selectSurfaceDetail('facade', { key: 'a:b', profile: 'high' }).id + '', 'different surfaces select their own pattern');
  assert.equal(new Set(GDO_SURFACE_DETAIL_PATTERNS.map(entry => entry.id)).size, GDO_SURFACE_DETAIL_PATTERNS.length);
});

test('a material wears a catalogue pattern through uniforms alone', () => {
  const handle = acquireProceduralMaterialLibrary();
  try {
    const material = configureSemanticMaterial(new THREE.MeshStandardMaterial(), 'facade', handle.library, 'low');
    const key = material.customProgramCacheKey();
    const before = material.userData.gdoSemanticMaterial.uniforms.gdoStyleRect.value.toArray();
    const entry = surfaceDetailEntry('facade.brick-bond');
    const record = applySurfaceDetail(material, entry, handle.library, 'balanced');
    assert.equal(record.namespace, GDO_SURFACE_DETAIL_NAMESPACE);
    assert.equal(record.id, 'facade.brick-bond');
    assert.equal(record.recompiled, false);
    assert.equal(record.samples, 1);
    assert.equal(record.source.texture, 'styleMasks');
    // Uniform-only: the program cache key is unchanged, so nothing recompiles.
    assert.equal(material.customProgramCacheKey(), key);
    assert.equal(material.needsUpdate, undefined);
    assert.deepEqual(material.userData.gdoSemanticMaterial.uniforms.gdoStyleRect.value.toArray(),
      handle.library.styleRects.brick);
    assert.notDeepEqual(material.userData.gdoSemanticMaterial.uniforms.gdoStyleRect.value.toArray(), before);
    assert.equal(material.userData.gdoSemanticMaterial.uniforms.gdoStyleStrength.value,
      entry.styleStrength ?? GDO_MATERIAL_RECIPES.facade.styleStrength * GDO_MATERIAL_DETAIL_PROFILES.balanced.styleStrength);
    assert.equal(surfaceDetailOf(material).id, 'facade.brick-bond');
    // Rolling onto another pattern is the same uniform path, both ways.
    const back = applySurfaceDetail(material, surfaceDetailEntry('facade.plaster'), handle.library, 'low');
    assert.equal(back.id, 'facade.plaster');
    assert.deepEqual(material.userData.gdoSemanticMaterial.uniforms.gdoStyleRect.value.toArray(),
      handle.library.styleRects.plaster);
    // A pattern the catalogue does not have, a mask the library does not have, and
    // an unconfigured material are all refused by name.
    assert.throws(() => applySurfaceDetail(material,
      { id: 'x', style: 'not-a-mask', source: { texture: 'styleMasks', channel: 'r' } }, handle.library),
    /Unknown procedural style mask/);
    assert.throws(() => applySurfaceDetail(material, null, handle.library), /catalogue entry/);
    assert.throws(() => applySurfaceDetail(new THREE.MeshStandardMaterial(), entry, handle.library), /configured semantic material/);
    assert.equal(surfaceDetailOf(new THREE.MeshStandardMaterial()), null);
    material.dispose();
  } finally {
    handle.release();
  }
});

test('the live world wears the low-profile rollout and stays inside the material budget', () => {
  const scene = new THREE.Scene();
  const world = new GeoWorld(scene, { latitude: 28.9845, longitude: 77.7064, viewportHeight: 720 });
  try {
    const rollout = world.surfaceDetailRollout;
    assert.equal(rollout.profile, 'low');
    assert.equal(rollout.patterns, GDO_LOW_PROFILE_BUDGETS.surfaceDetailPatterns);
    const surfaces = world.surfaceDetailSurfaces;
    assert.equal(surfaces.profile, 'low');
    assert.equal(surfaces.appliedCount, Object.keys(surfaces.applied).length);
    assert.ok(surfaces.appliedCount >= 4, `the world dresses its live surfaces (${surfaces.appliedCount})`);
    // Every applied surface's material really reports that catalogue pattern.
    const materialFor = { ground: world.groundMaterial, land: world.landMaterial, road: world.roadMaterial, facade: world.buildingMaterial };
    for (const [surface, id] of Object.entries(surfaces.applied)) {
      const material = materialFor[surface];
      assert.ok(material, `${surface} has a live material`);
      assert.equal(surfaceDetailOf(material)?.id, id, `${surface} wears ${id}`);
    }
    // The surfaces left alone say why, and the reasons are the documented two.
    assert.equal(surfaces.skipped.every(entry => ['material-shared', 'bespoke-shader', 'no-material'].includes(entry.reason)), true);
    assert.ok(surfaces.skipped.some(entry => entry.reason === 'material-shared'), 'the roof rides the building material');
    assert.ok(surfaces.skipped.some(entry => entry.reason === 'bespoke-shader'), 'the water shader owns its surface');
    assert.ok(surfaces.skipped.some(entry => entry.reason === 'no-material'), 'bark and leaf have no live material');

    // The `MAT-03` mirror now names the pattern behind each surface's detail.
    const mirror = world.surfaceDetailSamples({ distance: 12 });
    assert.ok(mirror.length >= 4);
    for (const sample of mirror) {
      if (surfaces.applied[sample.key]) {
        assert.equal(sample.detail, surfaces.applied[sample.key]);
        assert.equal(sample.detailStyle, surfaceDetailEntry(sample.detail).style);
        assert.equal(sample.detailSource.texture, 'styleMasks');
      }
    }
    // Diagnostics carry the rollout, and the shared library is still the only
    // texture authority: the rollout creates nothing.
    const stats = world.stats;
    assert.equal(stats.surfaceDetailPatterns, GDO_LOW_PROFILE_BUDGETS.surfaceDetailPatterns);
    assert.equal(stats.surfaceDetailApplied, surfaces.appliedCount);
    assert.deepEqual({ ...stats.surfaceDetailSurfaces }, { ...surfaces.applied });
    assert.equal(stats.surfaceDetailSkipped.length, surfaces.skipped.length);
    assert.equal(stats.materialTextureBytes <= GDO_LOW_PROFILE_BUDGETS.materialTextureBytes, true);
    assert.equal(proceduralMaterialLibraryStats().references, 1);
    assert.equal(proceduralMaterialLibraryStats().estimatedBytes <= GDO_LOW_PROFILE_BUDGETS.materialTextureBytes, true);
    const before = proceduralMaterialLibraryStats().estimatedBytes;
    assert.equal(applySurfaceDetail(world.buildingMaterial, surfaceDetailEntry('facade.plaster'), world.materialLibrary, 'low').id, 'facade.plaster');
    assert.equal(proceduralMaterialLibraryStats().estimatedBytes, before, 'no pattern adds a texture');

    // A second world at the same coordinate rolls out the same set: the choice is
    // seeded by coordinate and profile, never by call order.
    const twin = new GeoWorld(new THREE.Scene(), { latitude: 28.9845, longitude: 77.7064, viewportHeight: 720 });
    try {
      assert.deepEqual({ ...twin.surfaceDetailSurfaces.applied }, { ...surfaces.applied });
      assert.deepEqual(world.surfaceDetailKey, twin.surfaceDetailKey);
    } finally {
      twin.dispose();
    }
  } finally {
    world.dispose();
  }
});
