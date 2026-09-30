import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  AmbientLifePools,
  GDO_AMBIENT_LIFE_ATTRIBUTE_LAYOUT,
  GDO_AMBIENT_LIFE_FAMILIES,
  GDO_AMBIENT_LIFE_FAMILY_ORDER,
  GDO_AMBIENT_LIFE_LIMITS,
  GDO_AMBIENT_LIFE_NAMESPACE,
  GDO_AMBIENT_LIFE_SOURCE_TYPES,
  GDO_AMBIENT_LIFE_SOLVER,
  GDO_AMBIENT_LIFE_SPRITE_PART,
  ambientLifeCycleWindow,
  createAmbientLifeMaterial,
  createAmbientSpriteData,
  deriveAmbientLifeRecord,
  rollAmbientLifePath,
  sampleAmbientLifePose,
} from './AmbientLifeMotion.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';

// Radius of the removed CPU orbits: birds `.72–1.2`, bees `.13–.22`.
const REMOVED_ORBIT_CIRCUMFERENCE = Object.freeze({ bird: 2 * Math.PI * 1.2, bee: 2 * Math.PI * .22 });

function decorationValues(records) {
  const values = new Float32Array(records.length * 6);
  records.forEach((record, index) => {
    values.set([record.x ?? index, record.z ?? index, record.scale ?? 1,
      record.type, record.yaw ?? index * .37, record.tag ?? index % 5], index * 6);
  });
  return values;
}

function sampleAppearance(record, cycle, steps = 48) {
  const window = ambientLifeCycleWindow(record, cycle);
  const points = [];
  for (let step = 0; step <= steps; step++) {
    // Stay strictly inside the window: the boundary sample belongs to the
    // neighbouring cycle roll and is invisible anyway (envelope is 0 there).
    const fraction = .002 + (step / steps) * .996;
    const pose = sampleAmbientLifePose(record, window.start + fraction * (window.liveEnd - window.start));
    points.push({ ...pose });
  }
  return { window, points };
}

function appearanceMetrics(points) {
  const start = points[0], end = points[points.length - 1];
  const meanX = end.x - start.x, meanZ = end.z - start.z;
  const meanLength = Math.hypot(meanX, meanZ);
  let pathLength = 0, alongSpan = 0, lateralSpan = 0, minimumSegmentAgreement = 1;
  for (let index = 1; index < points.length; index++) {
    const dx = points[index].x - points[index - 1].x, dz = points[index].z - points[index - 1].z;
    const segment = Math.hypot(dx, dz);
    pathLength += segment;
    if (segment > 1e-9 && meanLength > 1e-9) {
      minimumSegmentAgreement = Math.min(minimumSegmentAgreement,
        (dx * meanX + dz * meanZ) / (segment * meanLength));
    }
    const along = ((points[index].x - start.x) * meanX + (points[index].z - start.z) * meanZ) / (meanLength || 1);
    const lateral = ((points[index].x - start.x) * -meanZ + (points[index].z - start.z) * meanX) / (meanLength || 1);
    alongSpan = Math.max(alongSpan, Math.abs(along));
    lateralSpan = Math.max(lateralSpan, Math.abs(lateral));
  }
  return { endDistance: meanLength, pathLength, alongSpan, lateralSpan, minimumSegmentAgreement };
}

test('LIF-01/LIF-03 keep ambient life bounded, flat, and free of CPU matrix work', () => {
  assert.equal(GDO_AMBIENT_LIFE_NAMESPACE, 'gdo:ambientLifeMotion:v1');
  assert.deepEqual(GDO_AMBIENT_LIFE_FAMILY_ORDER, ['bird', 'bee']);
  assert.deepEqual(GDO_AMBIENT_LIFE_SOURCE_TYPES, { 10: 'bird', 11: 'bee' });
  assert.equal(GDO_AMBIENT_LIFE_LIMITS.maxInstancesPerFamily, GDO_LOW_PROFILE_BUDGETS.ambientLifeInstancesPerFamily);
  assert.equal(GDO_AMBIENT_LIFE_LIMITS.maxAddedDrawCalls, GDO_LOW_PROFILE_BUDGETS.ambientLifeAddedDrawCalls);
  assert.equal(GDO_AMBIENT_LIFE_LIMITS.maxInstanceBytes, GDO_LOW_PROFILE_BUDGETS.ambientLifeInstanceBytes);
  assert.equal(GDO_AMBIENT_LIFE_LIMITS.maxUniformWritesPerFrame, 1);
  assert.equal(GDO_AMBIENT_LIFE_LIMITS.cpuMatrixUpdatesPerFrame, 0);
  assert.equal(GDO_AMBIENT_LIFE_LIMITS.steadyFrameAllocations, 0);
  assert.ok(GDO_AMBIENT_LIFE_SOLVER.solverClockWrapSeconds > 60 * GDO_AMBIENT_LIFE_FAMILIES.bird.cycleSeconds[1]);
  assert.ok(GDO_AMBIENT_LIFE_SOLVER.flapClockWrapSeconds > 0);
  assert.deepEqual(Object.keys(GDO_AMBIENT_LIFE_ATTRIBUTE_LAYOUT), [
    'position', 'color', 'gdoAmbientPart', 'gdoAmbientAnchor', 'gdoAmbientPath',
    'gdoAmbientCycle', 'gdoAmbientForm', 'gdoAmbientSprite', 'gdoAmbientRange',
  ]);
  assert.equal(GDO_AMBIENT_LIFE_ATTRIBUTE_LAYOUT.position.source.includes('z always 0'), true);
  assert.equal(GDO_AMBIENT_LIFE_ATTRIBUTE_LAYOUT.gdoAmbientPath.per, 'instance');
  assert.equal(Object.values(GDO_AMBIENT_LIFE_ATTRIBUTE_LAYOUT).some(item => item.source?.includes('matrix')), false);

  for (const family of GDO_AMBIENT_LIFE_FAMILY_ORDER) {
    const recipe = GDO_AMBIENT_LIFE_FAMILIES[family];
    const orbit = REMOVED_ORBIT_CIRCUMFERENCE[family];
    assert.ok(recipe.travel[0] > orbit * 3,
      `${family} appearances must travel far beyond the removed ${orbit.toFixed(2)}-unit orbit`);
    assert.ok(recipe.travel[1] > recipe.travel[0]);
    // Elongation is what forbids a closed loop: even the shortest route with
    // the widest possible sway must stay far longer than it is wide.
    // Even the shortest route with the widest possible sway stays elongated:
    // a closed loop would need the two spans to be comparable.
    assert.ok(recipe.travel[0] * GDO_AMBIENT_LIFE_SOLVER.travelScale[0] >
      recipe.lateral[1] * GDO_AMBIENT_LIFE_SOLVER.lateralScale[1] * 3,
    `${family} travel must dominate lateral sway`);
    assert.ok(recipe.cycleSeconds[0] > 0 && recipe.liveFraction[0] > 0 && recipe.liveFraction[1] < 1);
    assert.ok(recipe.viewDistance > recipe.travel[1], `${family} view distance should cover a full appearance`);
    assert.equal(recipe.triangles, 10, `${family} sprites are two coplanar triangle quads`);
  }
});

test('flat 2D silhouettes replace the removed 3D box clusters deterministically', () => {
  for (const family of GDO_AMBIENT_LIFE_FAMILY_ORDER) {
    const first = createAmbientSpriteData(family);
    const repeated = createAmbientSpriteData(family);
    assert.equal(first.family, family);
    assert.equal(first.flat, true);
    assert.equal(first.triangles, first.triangles);
    assert.deepEqual([...first.positions], [...repeated.positions], family);
    assert.deepEqual([...first.colors], [...repeated.colors], family);
    assert.deepEqual([...first.parts], [...repeated.parts], family);
    // Every vertex lies on the sprite plane: no depth, no volume.
    for (let index = 2; index < first.positions.length; index += 3) assert.equal(first.positions[index], 0);
    assert.equal(first.positions.length / 9, GDO_AMBIENT_LIFE_FAMILIES[family].triangles);
    assert.equal(first.runtimeCsgOperations, 0);
    assert.equal(first.collisionProxies, 0);
    assert.ok(first.triangles < 36, 'the removed 3D box cluster cost 36 triangles per instance');
    const parts = new Set(first.parts);
    assert.ok(parts.has(GDO_AMBIENT_LIFE_SPRITE_PART.BODY));
    assert.ok(parts.has(GDO_AMBIENT_LIFE_SPRITE_PART.LEFT_WING));
    assert.ok(parts.has(GDO_AMBIENT_LIFE_SPRITE_PART.RIGHT_WING));
    if (family === 'bird') assert.ok(parts.has(GDO_AMBIENT_LIFE_SPRITE_PART.TAIL));
  }
});

test('one shared billboard program consumes the flat sprite streams and a single clock uniform', () => {
  const material = createAmbientLifeMaterial();
  try {
    assert.equal(material.vertexColors, true);
    assert.equal(material.side, THREE.DoubleSide);
    assert.equal(material.transparent, false, 'sprites stay in the opaque band and need no alpha test');
    assert.equal(material.userData.gdoAmbientLife.billboard, 'view-plane-2d');
    assert.equal(material.userData.gdoAmbientLife.cpuMatrixUpdatesPerFrame, 0);
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\nvoid main(){\n#include <begin_vertex>\n#include <project_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main(){ vec4 diffuseColor = vec4(1.0);\n#include <color_fragment>\n}',
    };
    material.onBeforeCompile(shader);
    for (const attribute of ['gdoAmbientAnchor', 'gdoAmbientPath', 'gdoAmbientCycle', 'gdoAmbientForm',
      'gdoAmbientSprite', 'gdoAmbientRange', 'gdoAmbientPart']) {
      assert.match(shader.vertexShader, new RegExp(`attribute \\w+ ${attribute};`), attribute);
    }
    assert.match(shader.vertexShader, /void main\(\)\{\n#include <begin_vertex>/);
    assert.match(shader.vertexShader, /viewMatrix \* vec4\(gdoAmbientCenter, 1\.0\)/);
    assert.match(shader.vertexShader, /mvPosition\.xy \+= gdoAmbientViewOffset/);
    assert.match(shader.vertexShader, /gl_Position = projectionMatrix \* mvPosition/);
    assert.match(shader.vertexShader, /gdoAmbientRoll\(gdoAmbientCycle\.w, gdoAmbientCycleIndex/);
    assert.match(shader.vertexShader, /step\(0\.5, gdoAmbientPart\)/);
    // Sprites read no mesh matrix, no surface recipe, and no instance matrix.
    assert.doesNotMatch(shader.vertexShader, /instanceMatrix/);
    assert.doesNotMatch(shader.vertexShader, /gdoStyleMasks|vGdoMaterialWorld/);
    assert.match(shader.vertexShader, /uniform vec2 gdoAmbientClock;/);
    assert.match(shader.vertexShader, /gdoAmbientClock\.y \* gdoAmbientSprite\.w/, 'wing beats use the fast clock');
    assert.doesNotMatch(shader.vertexShader, /gdoAmbientClock\.x \* gdoAmbientSprite\.w/);
    assert.equal(shader.uniforms.gdoAmbientClock, material.userData.gdoAmbientLife.uniforms.clock);
    assert.equal(shader.uniforms.gdoAmbientReduced, material.userData.gdoAmbientLife.uniforms.reduced);
    assert.equal(Object.isSealed(shader.uniforms.gdoAmbientClock), true);
    assert.equal(material.customProgramCacheKey(), 'gdo:ambientLifeMotion:v1:sprite');
  } finally { material.dispose(); }
});

test('appearance records are deterministic, long, and can never close a loop', () => {
  for (const family of GDO_AMBIENT_LIFE_FAMILY_ORDER) {
    const recipe = GDO_AMBIENT_LIFE_FAMILIES[family];
    const values = decorationValues(Array.from({ length: 40 }, (_, index) => ({ type: recipe.sourceType })));
    let cycleChanged = 0;
    for (let index = 0; index < 40; index++) {
      const offset = index * 6;
      const record = deriveAmbientLifeRecord('tile:fixture', index, values, offset, family, 'gdo:ambientLifeMotion:v1', 2.5);
      const repeated = deriveAmbientLifeRecord('tile:fixture', index, values, offset, family, 'gdo:ambientLifeMotion:v1', 2.5);
      assert.equal(record.id, `tile:fixture:ambient:${index.toString(36)}`);
      assert.equal(record.family, family);
      assert.equal(record.groundY, 2.5);
      for (const key of ['headingX', 'headingZ', 'travel', 'lateral', 'cycleSeconds', 'cycleOffset', 'liveFraction', 'scale']) {
        assert.equal(record[key], repeated[key], `${key} must be reproducible`);
      }
      assert.ok(record.travel >= recipe.travel[0] && record.travel <= recipe.travel[1]);
      assert.ok(record.lateral >= recipe.lateral[0] && record.lateral <= recipe.lateral[1]);
      assert.ok(record.cycleOffset >= 0 && record.cycleOffset < record.cycleSeconds,
        'an appearance offset must stay inside its own cycle');
      assert.ok(Math.abs(Math.hypot(record.headingX, record.headingZ) - 1) < 1e-9);

      for (let cycle = 0; cycle < 3; cycle++) {
        const { points } = sampleAppearance(record, cycle);
        const metrics = appearanceMetrics(points);
        assert.ok(metrics.pathLength >= record.travel * .6, `${family} must fly a long route`);
        assert.ok(metrics.alongSpan >= record.travel * .55, `${family} must advance along one heading`);
        assert.ok(metrics.lateralSpan <= metrics.alongSpan * .35, `${family} routes stay elongated, never circular`);
        assert.ok(metrics.minimumSegmentAgreement > 0,
          `${family} must never reverse: the route cannot close a loop`);
        assert.ok(metrics.endDistance >= record.travel * .6, `${family} must end far from its start`);
        for (const pose of points) {
          assert.ok(pose.y - record.groundY > .2, `${family} sprites stay above their habitat anchor`);
          assert.ok(pose.existence >= 0 && pose.existence <= 1);
        }
        const plan = rollAmbientLifePath(record, cycle);
        const repeatedPlan = rollAmbientLifePath(record, cycle);
        assert.deepEqual(plan, repeatedPlan);
        assert.ok(plan !== repeatedPlan, 'plans allocate only when the caller asks for a fresh object');
      }
      const firstCycle = rollAmbientLifePath(record, 0);
      const secondCycle = rollAmbientLifePath(record, 1);
      if (Math.hypot(firstCycle.headingX - secondCycle.headingX, firstCycle.headingZ - secondCycle.headingZ) > .01) {
        cycleChanged++;
      }
    }
    assert.ok(cycleChanged >= 32, `${family} appearances re-roll their random route`);
  }
});

test('sprites fade in and out of existence and stay dormant between appearances', () => {
  const values = decorationValues([{ type: 10 }, { type: 11 }]);
  for (const [offset, family] of [[0, 'bird'], [6, 'bee']]) {
    const record = deriveAmbientLifeRecord('tile:exist', offset / 6, values, offset, family, 'exist-salt', 0);
    const window = ambientLifeCycleWindow(record, 0);
    const at = fraction => sampleAmbientLifePose(record, window.start + fraction * (window.liveEnd - window.start));
    assert.equal(at(0).existence, 0, 'an appearance starts invisible');
    assert.equal(at(1).existence, 0, 'an appearance ends invisible');
    assert.equal(at(.5).existence, 1, 'the middle of an appearance is fully materialised');
    assert.ok(at(.1).existence < at(.25).existence && at(.25).existence <= 1);
    assert.ok(at(.9).existence < at(.75).existence);
    // The remainder of the cycle is spent out of existence.
    const dormant = sampleAmbientLifePose(record, window.liveEnd + (window.end - window.liveEnd) * .5);
    assert.equal(dormant.existence, 0);
    assert.equal(dormant.live, false);
    // The next appearance re-rolls its route instead of replaying the last one.
    const first = rollAmbientLifePath(record, 0);
    const next = rollAmbientLifePath(record, 1);
    assert.notDeepEqual([first.headingX, first.headingZ], [next.headingX, next.headingZ]);
  }
});

test('reduced motion parks every sprite at its habitat anchor with a stable pose', () => {
  const values = decorationValues([{ type: 10 }, { type: 11 }]);
  for (const [offset, family] of [[0, 'bird'], [6, 'bee']]) {
    const record = deriveAmbientLifeRecord('tile:calm', offset / 6, values, offset, family, 'calm-salt', 1.5);
    const poses = [0, 5_000, 250_000, 999_999].map(now =>
      sampleAmbientLifePose(record, now, { reducedMotion: true }));
    for (const pose of poses) {
      assert.deepEqual([pose.x, pose.y, pose.z], [poses[0].x, poses[0].y, poses[0].z],
        'reduced motion must not depend on the clock');
      assert.equal(pose.existence, 1, 'a parked sprite never fades in or out');
      assert.equal(pose.cycle, 0);
      assert.ok(Math.hypot(pose.x - record.x, pose.z - record.z) <= record.travel * .4,
        'the parked sprite holds its anchor');
      assert.ok(pose.y > record.groundY + .2);
    }
  }
});

test('sprite pools prune deterministically and release every owner record on eviction', () => {
  const scene = new THREE.Scene();
  const pools = new AmbientLifePools(scene, { terrainSeed: 7, resolveGroundHeight: () => 1.25, renderOrder: 0 });
  try {
    assert.equal(pools.diagnostics.namespace, 'gdo:ambientLifeMotion:v1');
    assert.equal(pools.meshes.length, 2);
    assert.equal(pools.meshes.every(mesh => mesh.geometry.userData.gdoAmbientSprite.flat), true);
    assert.equal(pools.meshes.every(mesh => mesh.material.userData.gdoAmbientLife.billboard === 'view-plane-2d'), true);
    assert.equal(pools.meshes.every(mesh => mesh.frustumCulled === false), true);
    // Four resident tiles of bird-heavy ground cover exceed the family cap.
    const perOwner = Array.from({ length: 12 }, () => ({ type: 10 }));
    for (let owner = 0; owner < 4; owner++) {
      const values = decorationValues(perOwner);
      assert.equal(pools.addOwner(`tile:${owner}`, values, 6), 12);
    }
    const diagnostics = pools.diagnostics;
    assert.equal(diagnostics.entries, GDO_AMBIENT_LIFE_LIMITS.maxInstancesPerFamily);
    assert.equal(diagnostics.familyCounts[0], GDO_AMBIENT_LIFE_LIMITS.maxInstancesPerFamily);
    assert.equal(diagnostics.activeDrawPools, 1);
    assert.equal(diagnostics.addedDrawCalls, 1);
    assert.ok(diagnostics.capEvents.pruned > 0, 'over-cap candidates are pruned, never overflowed');
    assert.equal(diagnostics.capEvents.kept, diagnostics.entries);
    assert.equal(diagnostics.visibleTriangles,
      GDO_AMBIENT_LIFE_LIMITS.maxInstancesPerFamily * GDO_AMBIENT_LIFE_FAMILIES.bird.triangles);
    assert.ok(diagnostics.visibleTriangles <= GDO_LOW_PROFILE_BUDGETS.ambientLifeVisibleTriangles);
    assert.ok(diagnostics.instanceBytes <= GDO_LOW_PROFILE_BUDGETS.ambientLifeInstanceBytes);
    assert.equal(pools.geometries[0].instanceCount, GDO_AMBIENT_LIFE_LIMITS.maxInstancesPerFamily);
    assert.equal(pools.geometries[0].getAttribute('gdoAmbientAnchor').isInstancedBufferAttribute, true);
    assert.equal(pools.geometries[0].getAttribute('gdoAmbientAnchor').array[1], 1.25, 'anchors use the tile terrain height');

    const firstSnapshot = pools.spriteSnapshot();
    const fingerprint = pools.fingerprint();
    assert.deepEqual(pools.spriteSnapshot(), firstSnapshot, 'repacking the same owners is byte-stable');
    // A steady frame writes one clock uniform, updates no instance data, and allocates nothing.
    assert.equal(pools.update(1_000), 1);
    assert.equal(pools.update(1_000), 0);
    assert.equal(pools.update(2_000), 1);
    assert.equal(pools.update(Number.NaN), 0);
    assert.equal(pools.diagnostics.malformedInputs, 1);
    assert.equal(pools.material.userData.gdoAmbientLife.uniforms.clock.value.x, 2);
    assert.equal(pools.material.userData.gdoAmbientLife.uniforms.clock.value.y, 2);
    assert.equal(pools.diagnostics.cpuMatrixUpdates, 0);
    assert.equal(pools.diagnostics.steadyFrameAllocations, 0);
    assert.deepEqual(pools.spriteSnapshot(), firstSnapshot);

    assert.equal(pools.setReducedMotion(true), true);
    assert.equal(pools.setReducedMotion(true), false);
    assert.equal(pools.diagnostics.reducedMotion, true);
    assert.equal(pools.material.userData.gdoAmbientLife.uniforms.reduced.value, 1);
    assert.equal(pools.handleContextRestored(), true);
    assert.ok(pools.diagnostics.contextRestorations === 1);

    assert.equal(pools.removeOwner('tile:2'), true);
    assert.equal(pools.diagnostics.entries, GDO_AMBIENT_LIFE_LIMITS.maxInstancesPerFamily,
      'the remaining owners refill the pruned slots deterministically');
    assert.equal(pools.removeOwner('tile:2'), false);
    pools.removeOwner('tile:0'); pools.removeOwner('tile:1'); pools.removeOwner('tile:3');
    assert.equal(pools.diagnostics.entries, 0);
    assert.equal(pools.geometries[0].instanceCount, 0);

    // Remounting the identical payload restores the identical bytes.
    for (let owner = 0; owner < 4; owner++) pools.addOwner(`tile:${owner}`, decorationValues(perOwner), 6);
    assert.equal(pools.fingerprint(), fingerprint);
    assert.deepEqual(pools.spriteSnapshot(), firstSnapshot);
    assert.equal(pools.owners.get('tile:0') instanceof Float32Array, true, 'owner streams are copied, not aliased');
    assert.equal(scene.children.includes(pools.group), true);
    assert.equal(pools.group.userData.visualOnly, undefined);
    assert.equal(pools.meshes.every(mesh => mesh.userData.visualOnly === true), true);
    // Ambient life never exposes collision, camera, or clearance authority.
    for (const surface of ['collidesCircle', 'supportAt', 'queryMask', 'colliders']) {
      assert.equal(pools[surface], undefined, surface);
    }
    assert.deepEqual(Object.keys(pools.diagnostics).filter(key => key.includes('collision')), []);
  } finally {
    pools.dispose();
    assert.equal(pools.disposed, true);
    assert.equal(scene.children.length, 0);
    assert.equal(pools.update(1), 0, 'a disposed pool stops consuming frames');
  }
});

test('malformed ambient streams and caps fail closed instead of fabricating sprites', () => {
  const scene = new THREE.Scene();
  const pools = new AmbientLifePools(scene, {});
  try {
    assert.throws(() => pools.addOwner('tile:bad', [1, 2, 3, 10, 0, 0], 6), /aligned decoration data/);
    assert.throws(() => pools.addOwner('tile:bad', new Float32Array(18), 5), /aligned decoration data/);
    assert.throws(() => pools.addOwner('', decorationValues([{ type: 10 }]), 6), /stable string/);
    // Decoration families that the pool does not own are ignored, not errors.
    assert.equal(pools.addOwner('tile:other', decorationValues([{ type: 6 }, { type: 11 }]), 6), 1);
    assert.equal(pools.diagnostics.entries, 1);
    // Malformed ambient records are rejected while the owner survives.
    const malformed = decorationValues([{ type: 10 }]);
    malformed[2] = Number.NaN;
    assert.throws(() => pools.addOwner('tile:nan', malformed, 6), /not finite/);
    assert.equal(pools.owners.has('tile:nan'), false, 'a rejected stream commits no owner state');
    const zeroScale = decorationValues([{ type: 10 }]);
    zeroScale[2] = 0;
    assert.throws(() => pools.addOwner('tile:zero', zeroScale, 6), /scale is out of range/);
    const outOfRange = decorationValues([{ type: 11 }]);
    outOfRange[2] = 9;
    assert.throws(() => pools.addOwner('tile:big', outOfRange, 6), /scale is out of range/);
    // An empty stream drops the owner instead of keeping a phantom slot.
    pools.addOwner('tile:empty', new Float32Array(0), 6);
    assert.equal(pools.owners.has('tile:empty'), false);
    assert.equal(pools.diagnostics.entries, 1);
    pools.removeOwner('tile:other');
    for (let owner = 0; owner < 4; owner++) pools.addOwner(`tile:cap:${owner}`, decorationValues([{ type: 10 }]), 6);
    assert.throws(() => pools.addOwner('tile:overflow', decorationValues([{ type: 10 }]), 6),
      /resident owner cap exceeded/);
    assert.equal(pools.diagnostics.malformedInputs, 0);
    assert.equal(Number.isFinite(pools.diagnostics.entries), true);
  } finally { pools.dispose(); }
});
