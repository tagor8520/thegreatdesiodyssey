import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_MATERIAL_DETAIL_PROFILES,
  GDO_MATERIAL_RECIPES,
  GDO_STYLE_MASK_NAMES,
  acquireProceduralMaterialLibrary,
  configureSemanticMaterial,
  generateDitherData,
  generatePaletteData,
  generateStyleAtlasData,
  generateSurfaceNoiseData,
  generateWaterNormalData,
  materialDataChecksum,
  proceduralMaterialLibraryStats,
  setSemanticMaterialDetail,
} from './ProceduralMaterials.js';
import { assertLowProfileBudget, GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

const EXPECTED_CHECKSUMS = Object.freeze({
  surfaceNoise: '55400a48', styleMasks: '9461769d', dither: '285622a5',
  paletteLUT: '098d901e', waterNormal: '1e66cc41',
});

function assertRgbaSeam(data, size) {
  for (let position = 0; position < size; position++) for (let channel = 0; channel < 4; channel++) {
    assert.equal(data[(position * size) * 4 + channel], data[(position * size + size - 1) * 4 + channel]);
    assert.equal(data[position * 4 + channel], data[((size - 1) * size + position) * 4 + channel]);
  }
}

test('generated material channels are deterministic, version-pinned, and seamless', () => {
  const surface = generateSurfaceNoiseData();
  const style = generateStyleAtlasData();
  const dither = generateDitherData();
  const palette = generatePaletteData();
  const water = generateWaterNormalData();
  assert.deepEqual({
    surfaceNoise: materialDataChecksum(surface),
    styleMasks: materialDataChecksum(style.data),
    dither: materialDataChecksum(dither),
    paletteLUT: materialDataChecksum(palette),
    waterNormal: materialDataChecksum(water),
  }, EXPECTED_CHECKSUMS);
  assert.deepEqual(surface, generateSurfaceNoiseData());
  assert.deepEqual(style.data, generateStyleAtlasData().data);
  assertRgbaSeam(surface, 64);
  assertRgbaSeam(water, 128);

  // Every 16x16 semantic source has a repeated last row/column inside the atlas.
  for (const name of GDO_STYLE_MASK_NAMES) {
    const rect = style.rects[name];
    const originX = Math.round(rect[0] * 128 - .5);
    const originY = Math.round(rect[1] * 128 - .5);
    for (let position = 0; position < 16; position++) for (let channel = 0; channel < 4; channel++) {
      const horizontalA = ((originY + position) * 128 + originX) * 4 + channel;
      const horizontalB = ((originY + position) * 128 + originX + 15) * 4 + channel;
      const verticalA = (originY * 128 + originX + position) * 4 + channel;
      const verticalB = ((originY + 15) * 128 + originX + position) * 4 + channel;
      assert.equal(style.data[horizontalA], style.data[horizontalB], `${name} horizontal seam`);
      assert.equal(style.data[verticalA], style.data[verticalB], `${name} vertical seam`);
    }
  }
});

test('browser material generation defers bounded slices so roads-first startup can proceed', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  const handle = acquireProceduralMaterialLibrary();
  try {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    assert.equal(handle.library.diagnostics.deferred, true);
    assert.equal(handle.library.diagnostics.ready, false);
    // Acquiring only queues tasks, so startup never waits on generation.
    assert.ok(handle.library.diagnostics.startupMilliseconds < 8);
    assert.equal(await handle.library.whenReady, true);
    assert.equal(handle.library.diagnostics.ready, true);
    assert.ok(handle.library.diagnostics.generationSlices > 1, 'work is spread over several slices');
    assert.ok(handle.library.diagnostics.maximumTaskMilliseconds > 0);
    // The scheduler guarantee that survives a loaded or preempted machine: a
    // slice may finish the indivisible task it already started, but it never
    // starts another one after the budget is spent.
    const { sliceMilliseconds, maximumSliceMilliseconds, maximumTaskMilliseconds } = handle.library.diagnostics;
    assert.ok(maximumSliceMilliseconds <= sliceMilliseconds + maximumTaskMilliseconds + 1,
      `largest slice ${maximumSliceMilliseconds.toFixed(2)} ms vs budget ${sliceMilliseconds} ms ` +
      `+ longest task ${maximumTaskMilliseconds.toFixed(2)} ms`);
    assert.equal(materialDataChecksum(handle.library.textures.surfaceNoise.image.data), EXPECTED_CHECKSUMS.surfaceNoise);
  } finally {
    // Never leave the shared library acquired: a leaked reference would corrupt
    // the reference-count assertions in the following tests.
    handle.release();
  }
});

test('one shared low-profile library declares formats, filtering, color spaces, and memory', () => {
  const first = acquireProceduralMaterialLibrary();
  const second = acquireProceduralMaterialLibrary();
  assert.equal(first.library, second.library);
  assert.equal(proceduralMaterialLibraryStats().references, 2);
  const { textures, diagnostics } = first.library;
  assert.equal(diagnostics.records.length, 5);
  assert.ok(diagnostics.records.every(record => record.ownership === 'shared-engine' && record.wrap && record.minFilter));
  assert.deepEqual(Object.fromEntries(diagnostics.records.map(record => [record.name, record.checksum])), EXPECTED_CHECKSUMS);
  assert.ok(diagnostics.estimatedBytes <= GDO_LOW_PROFILE_BUDGETS.materialTextureBytes);
  assertLowProfileBudget({ materialTextureBytes: diagnostics.estimatedBytes });
  assert.equal(textures.surfaceNoise.image.width, 64);
  assert.equal(textures.styleMasks.image.width, 128);
  assert.equal(textures.dither.image.width, 8);
  assert.equal(textures.paletteLUT.image.width, 32);
  assert.equal(textures.paletteLUT.image.height, 8);
  assert.equal(textures.waterNormal.image.width, 128);
  assert.equal(textures.surfaceNoise.colorSpace, THREE.NoColorSpace);
  assert.equal(textures.styleMasks.colorSpace, THREE.NoColorSpace);
  assert.equal(textures.dither.colorSpace, THREE.NoColorSpace);
  assert.equal(textures.waterNormal.colorSpace, THREE.NoColorSpace);
  assert.equal(textures.paletteLUT.colorSpace, THREE.SRGBColorSpace);
  assert.equal(textures.surfaceNoise.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(textures.waterNormal.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(textures.styleMasks.minFilter, THREE.NearestFilter);
  assert.equal(textures.styleMasks.generateMipmaps, false);
  assert.equal(textures.dither.format, THREE.RedFormat);
  assert.equal(textures.dither.generateMipmaps, false);
  assert.equal(textures.paletteLUT.wrapS, THREE.ClampToEdgeWrapping);
  first.release();
  assert.equal(proceduralMaterialLibraryStats().references, 1);
  assert.equal(proceduralMaterialLibraryStats().active, true);
  second.release();
  assert.deepEqual(proceduralMaterialLibraryStats(), { references: 0, active: false, estimatedBytes: 0 });
});

test('last material-library owner disposes textures once and cancels deferred generation', async () => {
  const first = acquireProceduralMaterialLibrary();
  const second = acquireProceduralMaterialLibrary();
  let disposals = 0;
  Object.values(first.library.textures).forEach(texture => texture.addEventListener('dispose', () => disposals++));
  first.release();
  first.release();
  assert.equal(disposals, 0);
  second.release();
  second.release();
  assert.equal(disposals, 5);
  assert.equal(proceduralMaterialLibraryStats().active, false);

  const previousWindow = globalThis.window;
  globalThis.window = {};
  const deferred = acquireProceduralMaterialLibrary();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  assert.equal(deferred.library.diagnostics.ready, false);
  const ready = deferred.library.whenReady;
  deferred.release();
  assert.equal(await ready, false);
  assert.equal(proceduralMaterialLibraryStats().active, false);
});

test('semantic recipes are bounded and anti-shimmer policy is uniform-controlled', () => {
  for (const semantic of ['ground', 'road', 'facade', 'roof', 'bark', 'leaf', 'water']) {
    assert.ok(GDO_MATERIAL_RECIPES[semantic], semantic);
    assert.ok(GDO_STYLE_MASK_NAMES.includes(GDO_MATERIAL_RECIPES[semantic].style));
  }
  assert.deepEqual(Object.keys(GDO_MATERIAL_DETAIL_PROFILES), ['low', 'balanced', 'high']);
  const handle = acquireProceduralMaterialLibrary();
  const material = new THREE.MeshStandardMaterial();
  configureSemanticMaterial(material, 'facade', handle.library, 'low');
  const key = material.customProgramCacheKey();
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\nvoid main(){\n#include <begin_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main(){ vec4 diffuseColor=vec4(1.0);\n#include <color_fragment>\n}',
  };
  material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /fwidth\(gdoStyleCoord\.x\)/);
  assert.match(shader.fragmentShader, /smoothstep\(gdoDetailFade\.x, gdoDetailFade\.y/);
  assert.match(shader.fragmentShader, /texture2D\(gdoSurfaceNoise/);
  assert.match(shader.fragmentShader, /texture2D\(gdoStyleMasks/);
  assert.match(shader.fragmentShader, /texture2D\(gdoPaletteLUT/);
  assert.equal(shader.uniforms.gdoPaletteLUT.value, handle.library.textures.paletteLUT);
  assert.doesNotMatch(shader.fragmentShader, /fract\(sin\(/);
  const before = material.userData.gdoSemanticMaterial.uniforms.gdoDetailFade.value.clone();
  assert.equal(setSemanticMaterialDetail(material, 'high'), true);
  assert.equal(material.customProgramCacheKey(), key);
  assert.ok(material.userData.gdoSemanticMaterial.uniforms.gdoDetailFade.value.y > before.y);
  assert.equal(material.needsUpdate, undefined);
  material.dispose();
  handle.release();
});
