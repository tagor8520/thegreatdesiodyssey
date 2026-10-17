import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GeoWorld } from './GeoWorld.js';
import { buildContextData } from './GeoTileContext.js';
import { GEO_WATER_CLASS, GEO_WATER_FLOWING_CLASSES, waterClassName } from './GeoWaterDomains.js';
import { GEO_SURFACE_Y } from './GeoLayers.js';
import {
  GDO_WATER_VISUAL_PROFILES,
  waterCoverageReport,
  waterVisualVertexAppearance,
} from '../engine/WaterVisualClasses.js';
import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';

/**
 * `ENV-03` gate, world side: the class/flow/shore bake reaches the water mesh as
 * attributes, the flow tangents are the domain's own resolved ones, the low path
 * mounts opaque and single-family, and the bounded blended path is measured
 * against its declared ceilings.
 */

globalThis.Worker ??= class { addEventListener() {} postMessage() {} terminate() {} };

const point = (x, y) => ({ x, y });
const layer = feature => ({ length: 1, feature: () => feature });

/** A tile with a wide lake, a river polygon that a waterway runs through, and a stream. */
function tileContext() {
  const lake = {
    type: 3, extent: 4096, properties: { kind: 'water' },
    loadGeometry: () => [[
      point(256, 256), point(3584, 256), point(3584, 3584), point(256, 3584), point(256, 256),
    ]],
  };
  const river = {
    type: 3, extent: 4096, properties: { class: 'river' },
    loadGeometry: () => [[
      point(128, 3072), point(3968, 3072), point(3968, 3328), point(128, 3328), point(128, 3072),
    ]],
  };
  const stream = {
    type: 3, extent: 4096, properties: { class: 'stream' },
    loadGeometry: () => [[
      point(64, 128), point(2000, 128), point(2000, 320), point(64, 320), point(64, 128),
    ]],
  };
  const waterway = {
    type: 2, extent: 4096, properties: { class: 'river' },
    loadGeometry: () => [[point(0, 3200), point(4096, 3200)]],
  };
  const water = { length: 3, feature: index => [lake, river, stream][index] };
  const waterways = { length: 1, feature: () => waterway };
  return buildContextData({ layers: { water, waterway: waterways } }, {
    tileX: 0, tileY: 0, originX: 0, originY: 0, tileSize: 100, terrainSeed: 1,
  });
}

test('the tile bake carries class, flow, and shore per water vertex', () => {
  const context = tileContext();
  const water = context.water, domain = context.waterDomain;
  const vertices = water.positions.length / 3;
  assert.ok(vertices > 0);
  // Every attribute covers exactly the mesh's vertices: no per-vertex guesswork.
  assert.equal(water.shallow.length, vertices * 3);
  assert.equal(water.deep.length, vertices * 3);
  assert.equal(water.manner.length, vertices * 4);
  assert.equal(water.flow.length, vertices * 2);
  assert.equal(water.classCode.length, vertices);
  assert.equal(water.meta.visualClasses, 3, 'three mapped water bodies were baked');
  assert.equal(water.meta.shallowToDeep, 'noise-driven-shared-surface-noise-v1');

  // The rendered class is the domain's class, vertex for vertex, and the tints
  // are that class's declared palette.
  const classAt = index => water.classCode[index];
  for (let index = 0; index < vertices; index++) {
    const code = classAt(index);
    const appearance = waterVisualVertexAppearance(code);
    // The bake travels as Float32, so compare with tolerance rather than by
    // exact double equality.
    const close = (actual, expected, label) => {
      assert.equal(actual.length, expected.length, label);
      for (let channel = 0; channel < expected.length; channel++) {
        assert.ok(Math.abs(actual[channel] - expected[channel]) < 1e-6,
          `${label}[${channel}] ${actual[channel]} ≈ ${expected[channel]}`);
      }
    };
    close([water.shallow[index * 3], water.shallow[index * 3 + 1], water.shallow[index * 3 + 2]], appearance.shallow, 'shallow');
    close([water.deep[index * 3], water.deep[index * 3 + 1], water.deep[index * 3 + 2]], appearance.deep, 'deep');
    close([...water.manner.slice(index * 4, index * 4 + 4)], appearance.manner, 'manner');
  }
  // The domain's own polygon order and the geometry's polygon order agree, so
  // each polygon's resolved flow lands on that polygon's vertices.
  const polygonClass = index => domain.waterClasses[index];
  const polygonFlow = index => [domain.waterFlowDirections[index * 2], domain.waterFlowDirections[index * 2 + 1]];
  assert.deepEqual([0, 1, 2].map(polygonClass).map(waterClassName), ['lake', 'river', 'stream']);
  // Only the river has a mapped tangent, and it is the waterway's own direction.
  assert.deepEqual(polygonFlow(0), [0, 0], 'a lake stays still');
  assert.deepEqual(polygonFlow(1), [32767, 0], 'the river inherits the waterway tangent');
  assert.deepEqual(polygonFlow(2), [0, 0], 'an unmatched stream stays still');
  let flowing = 0;
  for (let index = 0; index < vertices; index++) {
    const flowX = water.flow[index * 2], flowZ = water.flow[index * 2 + 1];
    if (waterClassName(classAt(index)) === 'river') {
      assert.ok(Math.abs(flowX - 1) < 1e-4 && flowZ === 0, 'river vertices advect along +x');
      if (flowX) flowing++;
    } else {
      assert.equal(flowX, 0, `only flowing classes carry a tangent (${waterClassName(classAt(index))})`);
      assert.equal(flowZ, 0);
    }
  }
  assert.equal(flowing, water.meta.flowingVertices);
  assert.ok(flowing > 0);
  // The rendered flowing classes are exactly `TER-08`'s flowing vocabulary.
  const renderedFlowClasses = new Set();
  for (let index = 0; index < vertices; index++) if (water.flow[index * 2] || water.flow[index * 2 + 1]) renderedFlowClasses.add(classAt(index));
  for (const code of renderedFlowClasses) assert.ok(GEO_WATER_FLOWING_CLASSES.includes(code));
  // The mesh's per-vertex class code is the domain's class, so a debug surface
  // can name what each water vertex thinks it is without a second lookup.
  for (let index = 0; index < vertices; index++) {
    assert.ok(GEO_WATER_CLASS[waterClassName(classAt(index)).toUpperCase()] === classAt(index));
  }
});

test('the world mounts the bake, and the low path stays opaque and single-family', () => {
  const world = new GeoWorld(new THREE.Scene(), { latitude: 28.9845, longitude: 77.7064, viewportHeight: 720 });
  try {
    const tile = [...world.tiles.values()][0];
    const context = tileContext();
    world._handleWorkerMessage({
      type: 'tile-phase', requestId: tile.requestId, key: tile.key, bytes: 4096,
      provider: 'Fixture/openmaptiles', providerId: 'openmaptiles', phase: 'context',
      context, timings: {},
    });
    assert.ok(tile.water, 'the water mesh mounted');
    const geometry = tile.water.geometry;
    // The attributes reached the buffer geometry with the right shapes, which is
    // what makes the shader's class work unnecessary.
    assert.equal(geometry.getAttribute('gdoWaterShallow').itemSize, 3);
    assert.equal(geometry.getAttribute('gdoWaterDeep').itemSize, 3);
    assert.equal(geometry.getAttribute('gdoWaterManner').itemSize, 4);
    assert.equal(geometry.getAttribute('gdoWaterFlow').itemSize, 2);
    assert.equal(geometry.getAttribute('gdoWaterClass').itemSize, 1);
    assert.equal(geometry.getAttribute('gdoWaterClass').count, geometry.getAttribute('position').count);
    assert.equal(tile.water.material, world.waterMaterial, 'one water family, one material');
    assert.equal(tile.water.userData.geoLayer.surfaceY, GEO_SURFACE_Y.WATER);

    // The low path: opaque, depth-writing, no blended family, one wave scale.
    const material = world.waterMaterial;
    assert.equal(material.transparent, false);
    assert.equal(material.depthWrite, true);
    assert.equal(material.uniforms.uWaterAlpha.value, 1);
    assert.equal(material.uniforms.uWaveStrength.value.y, 0);
    assert.equal(material.uniforms.uFoamMode.value, 0);
    assert.equal(world.stats.waterVisualPath, 'opaque');
    assert.equal(world.stats.waterVisualBlendedFamilies, GDO_LOW_PROFILE_BUDGETS.waterVisualBlendedFamilies);
    assert.equal(world.stats.waterVisualOverdrawLayers, GDO_LOW_PROFILE_BUDGETS.waterVisualOverdrawLayers);
    assert.equal(world.stats.waterVisualWaveScales, GDO_LOW_PROFILE_BUDGETS.waterVisualWaveScales);
    assert.equal(world.stats.waterVisualClasses, 6);

    // One uniform write per frame, and no steady-frame allocation.
    world.update({ x: 0, y: 2, z: 0 }, null, 720, 1000);
    world.update({ x: 0, y: 2, z: 0 }, null, 720, 1016);
    assert.equal(world.stats.waterVisualUniformWrites, GDO_LOW_PROFILE_BUDGETS.waterVisualUniformWritesPerFrame);
    assert.equal(world.stats.waterVisualSteadyFrameAllocations, 0);

    // The bounded blended path is a profile switch on the same material, and the
    // blended coverage it allows is measured, not assumed.
    const coverage = world.waterVisual.recordCoverage({ waterPixels: 400 * 720, viewportPixels: 1280 * 720, layers: 1, blendedFamilies: 0 });
    assert.equal(coverage.ok, true);
    assert.equal(coverage.blendedCoverage, 0, 'an opaque path blends nothing however much water is on screen');
    world.waterVisual.setProfile('high');
    const blended = world.waterVisual.recordCoverage({ waterPixels: 400 * 720, viewportPixels: 1280 * 720, layers: 2, blendedFamilies: 1 });
    assert.equal(blended.ok, true, blended.reasons.join('; '));
    assert.ok(blended.blendedCoverage > 0);
    assert.equal(world.stats.waterVisualPath, 'blended');
    assert.equal(world.stats.waterVisualBlendedFamilies, GDO_WATER_VISUAL_PROFILES.high.blendedFamilies);
    assert.ok(world.stats.waterVisualBlendedFamilies >= 1, 'the higher path is allowed exactly one blended family');
    assert.equal(world.waterMaterial.transparent, true);
    assert.equal(world.waterMaterial.uniforms.uWaterAlpha.value, GDO_WATER_VISUAL_PROFILES.high.alpha);
    // Past the ceiling the report fails instead of shrugging.
    const over = world.waterVisual.recordCoverage({ waterPixels: 1279 * 720, viewportPixels: 1280 * 720, layers: 3, blendedFamilies: 1 });
    assert.equal(over.ok, false);
    assert.ok(over.reasons.some(reason => /blended coverage exceeds/.test(reason)));
    assert.equal(waterCoverageReport({ profile: 'high', waterPixels: 0, viewportPixels: 0, layers: 1 }).ok, false);
  } finally {
    world.dispose();
  }
});
