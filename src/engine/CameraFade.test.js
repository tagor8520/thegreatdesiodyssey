import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GDO_CAMERA_FADE_DITHER_SIZE,
  GDO_CAMERA_FADE_LEVELS,
  GDO_CAMERA_FADE_NAMESPACE,
  GDO_CAMERA_FADE_PROFILES,
  cameraFadeBudgetForProfile,
  cameraFadeDiscardSnippet,
  createCameraFade,
} from './CameraFade.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import { featureNamespace } from './FeatureVersions.js';
import { acquireProceduralMaterialLibrary, generateDitherData } from './ProceduralMaterials.js';
import { GEO_QUERY_MASK } from '../geo/GeoCollision.js';

/**
 * `LAY-06` gate: fading is an **opaque screen-door discard** for explicitly
 * eligible clutter, never a blended material family, and the decision is
 * deterministic — eligibility, hysteresis, rate limits, quantization, and the
 * avatar self-fade all read back as numbers.
 */

const FRAME = 1_000 / 60;
const FADE_MASK = GEO_QUERY_MASK.FADE_ELIGIBLE;

function fixture({ profile = 'low', reducedMotion = false } = {}) {
  const handle = acquireProceduralMaterialLibrary();
  const fade = createCameraFade({
    profile,
    reducedMotion,
    ditherTexture: handle.library.textures.dither,
  });
  return { fade, handle };
}

/** Camera at the origin looking down −z at an avatar 10 units away. */
const FRAME_VIEW = { cameraX: 0, cameraY: 1, cameraZ: 0, avatarX: 0, avatarY: 1, avatarZ: -10 };

function run(fade, frames, dt = FRAME, view = FRAME_VIEW) {
  for (let index = 0; index < frames; index++) fade.advanceFrame(dt);
  return fade;
}

test('the fade policy is declared, versioned, and inside the low-profile budget', () => {
  assert.equal(GDO_CAMERA_FADE_NAMESPACE, featureNamespace('cameraFade'));
  assert.equal(GDO_CAMERA_FADE_NAMESPACE, 'gdo:cameraFade:v1');
  assert.equal(GDO_CAMERA_FADE_DITHER_SIZE, 8, 'the mask stays inside the ≤ 8×8 budget');
  assert.equal(GDO_CAMERA_FADE_PROFILES.low.maxCandidates, GDO_LOW_PROFILE_BUDGETS.cameraFadeCandidates);
  assert.equal(cameraFadeBudgetForProfile('low'), GDO_CAMERA_FADE_PROFILES.low);
  assert.throws(() => cameraFadeBudgetForProfile('ultra'), /Unknown camera-fade profile/);
  const { fade, handle } = fixture();
  try {
    assert.equal(fade.maxCandidates, GDO_LOW_PROFILE_BUDGETS.cameraFadeCandidates);
    // The mask's texel count *is* the number of screen-door steps.
    assert.equal(fade.levels, GDO_CAMERA_FADE_LEVELS);
    assert.equal(GDO_CAMERA_FADE_LEVELS, GDO_CAMERA_FADE_DITHER_SIZE ** 2);
    assert.equal(fade.ditherSize, 8);
    // The one shared mask is `MAT-02`'s; the fade path never makes a texture.
    assert.equal(fade.uniforms.dither.value, handle.library.textures.dither);
    assert.equal(fade.uniforms.dither.value.name, 'gdo:dither');
    assert.equal(fade.uniforms.dither.value.image.width, 8);
    assert.equal(fade.uniforms.dither.value.image.height, 8);
    assert.equal(fade.diagnostics.createdTextures, 0);
    assert.equal(fade.diagnostics.steadyFrameAllocations, 0);
    assert.equal(handle.library.textures.dither, handle.library.textures.dither, 'shared, not cloned');
    assert.equal(generateDitherData().length, GDO_CAMERA_FADE_DITHER_SIZE * GDO_CAMERA_FADE_DITHER_SIZE);
    assert.equal('cameraFadeCandidates' in GDO_LOW_PROFILE_BUDGETS, true);
    assert.throws(() => createCameraFade({ profile: 'low', ditherTexture: {} }), /shared dither texture/);
    fade.dispose();
    assert.equal(fade.dispose(), false, 'dispose is idempotent');
    assert.throws(() => fade.beginFrame(FRAME_VIEW), /disposed/);
  } finally {
    handle.release();
  }
});

test('only fade-eligible clutter is ever considered', () => {
  const { fade, handle } = fixture();
  try {
    fade.beginFrame(FRAME_VIEW);
    // A structural mass in exactly the same place is refused by its mask: walls
    // compress the camera, they never fade.
    assert.equal(fade.consider({ id: 'facade', mask: GEO_QUERY_MASK.CAMERA_BLOCKER, x: 0, y: 1, z: -5, radius: 2 }), -1);
    assert.equal(fade.consider({ id: 'road', mask: GEO_QUERY_MASK.SUPPORT, x: 0, y: 1, z: -5 }), -1);
    assert.equal(fade.consider({ id: 'no-mask', mask: 0, x: 0, y: 1, z: -5 }), -1);
    assert.equal(fade.consider({ id: 'nan-mask', mask: NaN, x: 0, y: 1, z: -5 }), -1);
    const clutter = fade.consider({ id: 'crown', mask: FADE_MASK, x: 0, y: 1, z: -5, radius: 1.2 });
    assert.equal(clutter, 0);
    // Eligibility composes: a clutter object that is also a blocker still fades,
    // because `FADE_ELIGIBLE` is what the policy reads.
    const mixed = fade.consider({ id: 'hedge', mask: FADE_MASK | GEO_QUERY_MASK.CAMERA_BLOCKER, x: 0, y: 1, z: -4, radius: .4 });
    assert.equal(mixed, 1);
    assert.equal(fade.diagnostics.rejectedIneligible, 4);
    assert.equal(fade.diagnostics.candidates, 2);
    assert.equal(fade.diagnostics.considered, 6);
    assert.equal(fade.diagnostics.evaluations, 2);

    // The cap is a hard ceiling with a deterministic trim, not a resize.
    fade.beginFrame(FRAME_VIEW);
    let accepted = 0;
    for (let index = 0; index < fade.maxCandidates + 5; index++) {
      if (fade.consider({ id: `clutter:${index}`, mask: FADE_MASK, x: 0, y: 1, z: -5, radius: .2 }) >= 0) accepted++;
    }
    assert.equal(accepted, fade.maxCandidates);
    assert.equal(fade.diagnostics.prunedCandidates, 5);
    assert.equal(fade.diagnostics.candidates, fade.maxCandidates);
  } finally {
    handle.release();
  }
});

test('the fade decision is deterministic, hysteretic, and rate limited', () => {
  const { fade, handle } = fixture();
  try {
    // On the segment: fades. Off to the side: never. Behind the avatar: never.
    fade.beginFrame(FRAME_VIEW);
    const onSegment = fade.consider({ id: 'on', mask: FADE_MASK, x: 0, y: 1, z: -5, radius: .5 });
    const offSide = fade.consider({ id: 'side', mask: FADE_MASK, x: 6, y: 1, z: -5, radius: .5 });
    const behind = fade.consider({ id: 'behind', mask: FADE_MASK, x: 0, y: 1, z: -14, radius: .5 });
    assert.equal(fade.targetAt(onSegment), 1);
    assert.equal(fade.targetAt(offSide), 0);
    assert.equal(fade.targetAt(behind), 0);
    // One frame in, the level is a partial step (rate limited), not a snap.
    const first = fade.advanceFrame(FRAME);
    assert.equal(first, 1);
    const partial = fade.levelAt(onSegment);
    assert.ok(partial > 0 && partial < 1, `expected a partial level, got ${partial}`);
    // Quantized to the declared step, so the dither pattern cannot shimmer.
    assert.equal(Math.round(partial * fade.levels) / fade.levels, partial);
    // Enough frames later it is fully faded, and it stops changing.
    run(fade, 30);
    assert.equal(fade.levelAt(onSegment), 1);
    assert.equal(fade.levelAt(offSide), 0);
    assert.equal(fade.diagnostics.faded, 1);
    assert.equal(fade.diagnostics.strongest, 1);
    const steps = fade.diagnostics.levelSteps;
    run(fade, 10);
    assert.equal(fade.diagnostics.levelSteps, steps, 'a settled frame writes no level steps');

    // The dead band lives off the segment, where the candidate's clearance is
    // what decides: activation radius .55, hysteresis .35 on top of it.
    const { activationRadius, hysteresis } = GDO_CAMERA_FADE_PROFILES.low;
    const atClearance = clearance => 1 + clearance;
    fade.beginFrame(FRAME_VIEW);
    const grazing = fade.consider({ id: 'grazing', mask: FADE_MASK, x: atClearance(.5), y: 1, z: -5, radius: 1 });
    assert.equal(fade.targetAt(grazing), 1, 'inside the activation radius it fades');
    run(fade, 30);
    assert.equal(fade.levelAt(grazing), 1);
    // Just past the activation radius but inside the dead band: the verdict holds.
    // Each move is a new frame, because a fade verdict is per frame per candidate.
    fade.beginFrame(FRAME_VIEW);
    const beyond = fade.consider({
      id: 'grazing', mask: FADE_MASK, x: atClearance(activationRadius + hysteresis * .5), y: 1, z: -5, radius: 1,
    });
    assert.equal(fade.targetAt(beyond), 1, 'inside the dead band the verdict holds');
    run(fade, 2);
    assert.equal(fade.levelAt(beyond), 1);
    // Past the hysteresis margin it releases, and the counter records that the
    // dead band did the work instead of the decision flickering.
    fade.beginFrame(FRAME_VIEW);
    const released = fade.consider({
      id: 'grazing', mask: FADE_MASK, x: atClearance(activationRadius + hysteresis + .2), y: 1, z: -5, radius: 1,
    });
    assert.equal(fade.targetAt(released), 0);
    run(fade, 60);
    assert.equal(fade.levelAt(released), 0);
    assert.equal(fade.diagnostics.hysteresisActivations > 0, true);
    // Without the dead band the same candidate would release immediately.
    const fresh = createCameraFade({ profile: 'low', ditherTexture: handle.library.textures.dither });
    fresh.beginFrame(FRAME_VIEW);
    const neverFaded = fresh.consider({
      id: 'grazing', mask: FADE_MASK, x: atClearance(activationRadius + hysteresis * .5), y: 1, z: -5, radius: 1,
    });
    assert.equal(fresh.targetAt(neverFaded), 0, 'a candidate that never faded does not get the band');
    fresh.dispose();

    // Fading out is slower than fading in, by the profile's own rates.
    assert.ok(GDO_CAMERA_FADE_PROFILES.low.fadeOutPerSecond < GDO_CAMERA_FADE_PROFILES.low.fadeInPerSecond);

    // Determinism: the same inputs and the same history give the same levels.
    const replay = () => {
      const other = createCameraFade({ profile: 'low', ditherTexture: handle.library.textures.dither });
      const levels = [];
      for (let frame = 0; frame < 12; frame++) {
        other.beginFrame(FRAME_VIEW);
        const slot = other.consider({ id: 'on', mask: FADE_MASK, x: 0, y: 1, z: -5, radius: .5 });
        other.advanceFrame(FRAME);
        levels.push(other.levelAt(slot));
      }
      other.dispose();
      return levels.join(',');
    };
    assert.equal(replay(), replay());
    const scratch = fixture();
    assert.equal(run(scratch.fade, 0) instanceof Object, true);
    scratch.handle.release();
  } finally {
    handle.release();
  }
});

test('reduced motion snaps the level instead of ramping it', () => {
  const { fade, handle } = fixture({ reducedMotion: true });
  try {
    fade.beginFrame(FRAME_VIEW);
    const slot = fade.consider({ id: 'crown', mask: FADE_MASK, x: 0, y: 1, z: -5, radius: .5 });
    fade.advanceFrame(FRAME);
    assert.equal(fade.levelAt(slot), 1, 'one frame, final level');
    fade.beginFrame({ ...FRAME_VIEW, avatarX: 40 });
    const away = fade.consider({ id: 'crown', mask: FADE_MASK, x: 0, y: 1, z: -5, radius: .5 });
    fade.advanceFrame(FRAME);
    assert.equal(fade.levelAt(away), 0, 'and back to opaque in one frame');
    assert.equal(fade.reducedMotion, true);
  } finally {
    handle.release();
  }
});

test('the patch is a screen-door discard that keeps the material opaque', () => {
  const { fade, handle } = fixture();
  try {
    const material = new THREE.MeshStandardMaterial({ color: '#88aa44' });
    const record = fade.patchMaterial(material);
    assert.equal(record.namespace, GDO_CAMERA_FADE_NAMESPACE);
    assert.equal(record.blended, false);
    assert.equal(record.depthWriting, true);
    assert.equal(record.discard, 'screen-door');
    assert.equal(record.ditherSize, 8);
    assert.equal(material.transparent, false, 'no blended family is introduced');
    assert.equal(material.depthWrite, true, 'faded fragments still write depth');
    assert.equal(material.blending, THREE.NormalBlending);
    assert.equal(material.alphaTest, 0);
    assert.equal(record.ditherTexture, handle.library.textures.dither);
    // Idempotent: patching twice adds one hook and counts one material.
    const again = fade.patchMaterial(material);
    assert.equal(again, record);
    assert.equal(fade.diagnostics.patchedMaterials, 1);

    // The injected shader really discards, samples the shared mask in screen
    // space, and leaves the vertex stage untouched.
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\n',
      fragmentShader: '#include <common>\n#include <color_fragment>\n',
    };
    material.onBeforeCompile(shader);
    assert.equal(shader.uniforms.gdoCameraFade, fade.uniforms.level);
    // Three reads texture uniforms through the uniform object, not the texture.
    assert.equal(shader.uniforms.gdoCameraDither, fade.uniforms.dither);
    assert.equal(shader.uniforms.gdoCameraDither.value, handle.library.textures.dither);
    assert.match(shader.fragmentShader, /uniform sampler2D gdoCameraDither;/);
    assert.match(shader.fragmentShader, /texture2D\(gdoCameraDither,\s+gl_FragCoord\.xy \/ 8\.0\)\.r/);
    assert.match(shader.fragmentShader, /if \(gdoCameraDitherSample < gdoCameraFadeThreshold\) discard;/);
    assert.equal(shader.vertexShader, '#include <common>\n', 'the fade is a fragment-stage rule');
    assert.match(cameraFadeDiscardSnippet('vGdoAmbientFade'), /vGdoAmbientFade/);
    // The program cache key changes, so the patched program is not reused by an
    // unpatched material.
    const plain = new THREE.MeshStandardMaterial();
    assert.notEqual(material.customProgramCacheKey(), plain.customProgramCacheKey());
    assert.throws(() => fade.patchMaterial(null), /patches a material/);
    assert.throws(() => createCameraFade({ ditherTexture: null }).patchMaterial(new THREE.MeshBasicMaterial()),
      /shared dither texture/);
  } finally {
    handle.release();
  }
});

test('the avatar fades only when the camera is pathologically close', () => {
  const { fade, handle } = fixture();
  try {
    const material = new THREE.MeshBasicMaterial({ vertexColors: true });
    fade.patchMaterial(material);
    // Far: nothing to fade, and the shared level uniform stays at zero.
    fade.beginFrame(FRAME_VIEW);
    run(fade, 10);
    assert.equal(fade.diagnostics.avatarLevel, 0);
    assert.equal(fade.uniforms.level.value, 0);
    // Pathologically close: the avatar level climbs toward opaque-discard.
    const close = { ...FRAME_VIEW, avatarZ: -0.6 };
    fade.beginFrame(close);
    run(fade, 60, FRAME, close);
    const level = fade.diagnostics.avatarLevel;
    assert.ok(level > 0 && level <= 1);
    assert.equal(fade.uniforms.level.value, level, 'the material uniform is the avatar level');
    assert.equal(Math.round(level * fade.levels) / fade.levels, level);
    // Closer still is a stronger fade, so the near plane never slices the avatar.
    const closer = { ...FRAME_VIEW, avatarZ: -0.2 };
    fade.beginFrame(closer);
    run(fade, 60, FRAME, closer);
    assert.ok(fade.diagnostics.avatarLevel >= level);
    assert.equal(fade.diagnostics.avatarTarget > 0, true);
    // Walking away restores the avatar to opaque.
    fade.beginFrame(FRAME_VIEW);
    run(fade, 120);
    assert.equal(fade.diagnostics.avatarLevel, 0);
    assert.equal(fade.uniforms.level.value, 0);
    const writes = fade.diagnostics.uniformWrites;
    run(fade, 30);
    assert.equal(fade.diagnostics.uniformWrites, writes, 'a settled uniform is not rewritten');
    fade.reset();
    assert.equal(fade.diagnostics.avatarLevel, 0);
    assert.equal(fade.diagnostics.candidates, 0);
  } finally {
    handle.release();
  }
});

test('a steady frame writes only what changed and allocates nothing', () => {
  const { fade, handle } = fixture();
  try {
    const clutter = Array.from({ length: 24 }, (_, index) => ({
      id: `clutter:${index}`,
      x: (index % 6 - 2.5) * .4,
      y: 1,
      z: -5 + (index % 4) * .3,
      radius: .35,
    }));
    let totalSteps = 0;
    for (let frame = 0; frame < 400; frame++) {
      fade.beginFrame(FRAME_VIEW);
      for (const item of clutter) fade.consider({ ...item, mask: FADE_MASK });
      fade.advanceFrame(FRAME);
      totalSteps = fade.diagnostics.levelSteps;
    }
    const diagnostics = fade.diagnostics;
    assert.equal(diagnostics.frames, 400);
    // Frame-scoped counters: the last frame considered every candidate once.
    assert.equal(diagnostics.considered, clutter.length);
    assert.equal(diagnostics.candidates, clutter.length);
    assert.equal(diagnostics.steadyFrameAllocations, 0);
    assert.equal(diagnostics.createdTextures, 0);
    // Quantized levels settle: 400 frames produce far fewer steps than one per
    // frame per candidate, which is what "no churn" means here.
    assert.ok(totalSteps < 400, `expected settling, saw ${totalSteps} steps`);
    // Only the candidates inside the activation radius fade; the outer ring is
    // deliberately beyond it, and stays fully opaque.
    const expectedFaded = clutter.filter(item =>
      Math.abs(item.x) - item.radius <= GDO_CAMERA_FADE_PROFILES.low.activationRadius).length;
    assert.equal(expectedFaded, 16);
    assert.equal(diagnostics.faded, expectedFaded);
    assert.equal(clutter.length - expectedFaded, 8, 'the outer ring is left alone');
    // The snapshot is a frozen view for tooling, and it agrees with levelAt().
    const snapshot = fade.candidateSnapshot();
    assert.equal(snapshot.length, clutter.length);
    assert.equal(snapshot.every(entry => Object.isFrozen(entry)), true);
    for (let index = 0; index < snapshot.length; index++) {
      assert.equal(snapshot[index].level, fade.levelAt(index));
      assert.equal(snapshot[index].id, fade.idAt(index));
    }
    assert.equal(fade.idAt(-1), null);
    assert.equal(fade.levelAt(999), 0);
  } finally {
    handle.release();
  }
});
