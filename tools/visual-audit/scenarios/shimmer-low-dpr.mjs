/**
 * `MAT-03` — moving low-pixel-ratio shimmer capture *(coordinate mode)*
 *
 * Registered gate (feature-roadmap/README.md order 062):
 *   "Mip/filter, derivative-edge, distance/profile, and normal-first fade tests
 *    pass; moving low-pixel-ratio shimmer capture remains."
 *
 * The four automated halves already pass. This produces the missing capture and
 * makes it *measurable* rather than a matter of opinion.
 *
 * WHAT SHIMMER IS, AND WHY THE MEASUREMENT IS AN A/B
 * --------------------------------------------------
 * Shimmer is temporal aliasing: undersampled high-frequency surface detail
 * changes value between frames even when the visible scene barely moves. On its
 * own, "camera barely moved but pixels changed" is meaningless — water normals
 * animate, so pixels legitimately change. So the metric is not absolute
 * variance, it is variance *relative to a mip-disabled control*.
 *
 * Production ships `surfaceNoise` and `waterNormal` at
 * `LinearMipmapLinearFilter` with mip chains (7 and 8 levels). The control
 * forces the same textures to `LinearFilter` with `generateMipmaps = false` —
 * aliasing with no mip filtering at all. If the shipped policy is doing its job,
 * production temporal variance must be clearly *lower* than the control at the
 * same camera micro-motion.
 *
 * THE RECORDED CAVEAT, HONOURED
 * -----------------------------
 * This scenario reports a `metricValidated` flag and exits inconclusive (2) when
 * its statistic fails the positive control. As of 2026-10-04 the statistic does
 * **not** respond to stripping the whole anti-alias policy, so no verdict is
 * available here and the shimmer sign-off needs a real-GPU capture. It does NOT
 * claim any software equivalence to hardware.
 */
import { freshRunDirectory, capture, waitFrames, readCoordinateStats } from '../harness.mjs';

/** Sub-pixel yaw increments: slow rotation is the classic shimmer trigger. */
const STEPS = 24;
const YAW_PER_STEP = 0.0022;
const FRAME_WIDTH = 480;
const FRAME_HEIGHT = 270;
/** A centre crop avoids the HUD overlay and the sky, keeping the metric on surfaces. */
const CROP = { x: 90, y: 90, width: 300, height: 110 };

export const SHIMMER_LOW_DPR = 0.5;

async function openLowRatioScene(page, baseUrl, { latitude, longitude }) {
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 90_000 });
  await page.waitForSelector('.odyssey-coordinate-form', { timeout: 30_000 });
  await page.evaluate(({ latitude: lat, longitude: lon }) => {
    const form = document.querySelector('.odyssey-coordinate-form');
    form.elements.latitude.value = String(lat);
    form.elements.longitude.value = String(lon);
  }, { latitude, longitude });
  await page.click('.odyssey-coordinate-start');
  await page.waitForFunction('globalThis.__gdoAudit && globalThis.__gdoAudit.game', { timeout: 60_000 });
}

async function installShimmerProbe(page) {
  await page.evaluate(() => {
    const game = globalThis.__gdoAudit.game;

    /**
     * Frame-to-frame temporal statistics over a crop.
     *
     * Computed **in the page**. Returning the raw frames instead meant shipping
     * ~12 MB per measurement back over the CDP bridge, which dominated runtime
     * and eventually exceeded the protocol timeout.
     *
     * The mean alone is a poor shimmer detector: a crop that is mostly flat
     * surface averages a handful of flipping pixels away to nothing. Shimmer is
     * localised, so the useful statistics are the upper tail (p99.9 — how bad
     * the worst pixels get) and the hot fraction (what share of pixels visibly
     * flipped). Validation uses the tail, not the mean.
     */
    function temporalStats(frames, width, height, crop) {
      const deltas = [];
      let accumulated = 0;
      let hot = 0;
      for (let index = 1; index < frames.length; index++) {
        const previous = frames[index - 1];
        const current = frames[index];
        for (let y = crop.y; y < crop.y + crop.height; y++) {
          for (let x = crop.x; x < crop.x + crop.width; x++) {
            const offset = (y * width + x) * 4;
            // Luma-weighted, so chroma noise does not dominate.
            const a = previous[offset] * 0.299 + previous[offset + 1] * 0.587 + previous[offset + 2] * 0.114;
            const b = current[offset] * 0.299 + current[offset + 1] * 0.587 + current[offset + 2] * 0.114;
            const delta = Math.abs(a - b);
            deltas.push(delta);
            accumulated += delta;
            if (delta > 2) hot++;
          }
        }
      }
      if (!deltas.length) return { mean: 0, p999: 0, hotFraction: 0, samples: 0 };
      deltas.sort((left, right) => left - right);
      return {
        mean: accumulated / deltas.length,
        p999: deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.999))],
        hotFraction: hot / deltas.length,
        samples: deltas.length,
      };
    }

    globalThis.__gdoShimmerProbe = {
      /** How many semantic materials expose the pattable anti-alias uniforms. */
      semanticMaterialCount() {
        let count = 0;
        const visited = new Set();
        const visit = material => {
          if (!material || visited.has(material.uuid)) return;
          visited.add(material.uuid);
          if (material.userData?.gdoSemanticMaterial) count++;
        };
        game.scene.traverse(object => {
          const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
          for (const material of list) visit(material);
        });
        for (const material of [game.world?.landMaterial, game.world?.waterMaterial,
          game.world?.facadeMaterial, game.world?.roofMaterial]) visit(material);
        return count;
      },

      /**
       * Textures the mip policy applies to, plus their shipped filter settings.
       * Two discovery paths: direct material properties (`material.map`) and
       * shader uniforms (`material.uniforms.uSurfaceNoise.value`), because the
       * coordinate world pipes its procedural detail in through uniforms.
       */
      texturePolicy() {
        const found = [];
        const seen = new Set();
        const consider = (texture, key, object) => {
          if (!texture?.isTexture || seen.has(texture.uuid)) return;
          seen.add(texture.uuid);
          found.push({
            uuid: texture.uuid,
            name: texture.name || key,
            width: texture.image?.width ?? null,
            height: texture.image?.height ?? null,
            generateMipmaps: texture.generateMipmaps,
            minFilter: texture.minFilter,
            magFilter: texture.magFilter,
            usedBy: `${key}<-${object.name || object.type}`,
          });
        };
        game.scene.traverse(object => {
          const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
          for (const material of list) {
            for (const key of Object.keys(material)) consider(material[key], key, object);
            for (const [key, uniform] of Object.entries(material.uniforms ?? {})) {
              consider(uniform?.value, `uniforms.${key}`, object);
            }
          }
        });
        // The coordinate world builds its textured materials up front, whether or
        // not the current fixture has water, so a scene walk alone misses them.
        const world = game.world;
        for (const [slot, material] of Object.entries({
          waterMaterial: world?.waterMaterial,
          landMaterial: world?.landMaterial,
          facadeMaterial: world?.facadeMaterial,
          roofMaterial: world?.roofMaterial,
        })) {
          if (!material) continue;
          for (const [key, uniform] of Object.entries(material.uniforms ?? {})) {
            consider(uniform?.value, `${slot}.${key}`, { name: slot });
          }
          for (const key of Object.keys(material)) consider(material[key], `${slot}.${key}`, { name: slot });
        }
        for (const [key, texture] of Object.entries(world?.materialLibrary?.textures ?? {})) {
          consider(texture, `materialLibrary.${key}`, { name: 'materialLibrary' });
        }
        return found;
      },

      /**
       * Disable the mip chains the shipped policy relies on. Returns what changed
       * so the control is auditable rather than assumed.
       */
      disableMipmaps({ nearest = false } = {}) {
        const changed = [];
        const seen = new Set();
        const consider = (texture, key) => {
          if (!texture?.isTexture || seen.has(texture.uuid)) return;
          seen.add(texture.uuid);
          const mipFilters = [1008 /* LinearMipmapLinearFilter */, 1006 /* LinearMipmapNearestFilter */,
            1007 /* NearestMipmapLinearFilter */, 1004 /* NearestMipmapNearestFilter */];
          const wasMipped = texture.generateMipmaps || mipFilters.includes(texture.minFilter);
          if (!wasMipped && !nearest) return;
          changed.push({ name: texture.name || key, minFilter: texture.minFilter, generateMipmaps: texture.generateMipmaps });
          texture.generateMipmaps = false;
          // 1003 = THREE.NearestFilter: point sampling with no mip selection.
          // Documented as unusable in this harness — see the note in run().
          texture.minFilter = nearest ? 1003 : 1006;
          texture.needsUpdate = true;
        };
        const visit = material => {
          for (const key of Object.keys(material)) consider(material[key], key);
          for (const [key, uniform] of Object.entries(material.uniforms ?? {})) consider(uniform?.value, `uniforms.${key}`);
        };
        game.scene.traverse(object => {
          const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
          for (const material of list) visit(material);
        });
        const world = game.world;
        for (const material of [world?.waterMaterial, world?.landMaterial, world?.facadeMaterial, world?.roofMaterial]) {
          if (material) visit(material);
        }
        return changed;
      },

      /**
       * Rotate the camera in sub-pixel steps and read the drawing buffer at each
       * step, with no animation step in between. Returns the raw frames plus the
       * world-space normal of the shake so the motion is reproducible.
       */
      captureSequence({ steps, yawPerStep, width, height, frozenTime = 0, crop }) {
        const game = globalThis.__gdoAudit.game;
        const renderer = game.renderer;
        const scene = game.scene;
        const camera = game.camera;
        const player = game.player;
        const gl = renderer.getContext();
        const baseYaw = player.yaw;
        const water = game.world?.waterMaterial?.uniforms?.uTime;

        // The water shader offsets its normal-map lookup by `uTime`, which the
        // render loop sets from wall-clock milliseconds. Left running, the wave
        // phase differs between the production and control measurements, and the
        // phase changes how much high-frequency detail faces the camera — so the
        // comparison measured animation phase, not aliasing. Pinning it makes
        // every measurement share one phase. This whole loop is synchronous, so
        // no animation frame can run inside it.
        const previousTime = water?.value ?? null;
        if (water) water.value = frozenTime;

        const frames = [];
        for (let step = 0; step < steps; step++) {
          if (water) water.value = frozenTime;
          player.yaw = baseYaw + step * yawPerStep;
          player.updateCamera(0, true);
          camera.updateMatrixWorld();
          renderer.render(scene, camera);
          const pixels = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          frames.push(pixels);
        }
        if (water && previousTime !== null) water.value = previousTime;
        player.yaw = baseYaw;
        player.updateCamera(0, true);
        // Only the statistics cross the bridge, never the pixel buffers.
        return {
          stats: temporalStats(frames, width, height, crop),
          frameCount: frames.length,
          baseYaw, cameraY: camera.position.y,
          pixelRatio: renderer.getPixelRatio(),
          frozenTime: water ? frozenTime : null,
        };
      },

      /**
       * POSITIVE CONTROL: strip the whole anti-alias policy, not just the mip
       * chains. A low production number only means something if the metric can
       * rise when aliasing is actually present, so this removes every fade the
       * policy relies on:
       *
       *   gdoDetailFade      -> (0, 1e6)  distance visibility pinned to 1
       *   gdoMinimumPixels   -> 0         footprint fade can never trigger
       *   uNormalFade        -> (0, 1e6)  water keeps full normal detail at range
       *
       * Originals are snapshotted so the policy can be restored exactly.
       */
      disableAntiAliasPolicy() {
        const changed = [];
        const originals = [];
        const patch = (uniforms, key, apply) => {
          const uniform = uniforms?.[key];
          if (!uniform?.value) return;
          originals.push({ uniform, value: uniform.value.clone ? uniform.value.clone() : uniform.value });
          apply(uniform);
          changed.push(key);
        };
        const visited = new Set();
        const visit = material => {
          if (!material || visited.has(material.uuid)) return;
          visited.add(material.uuid);
          const semantic = material.userData?.gdoSemanticMaterial;
          if (semantic) {
            patch(semantic.uniforms, 'gdoDetailFade', uniform => uniform.value.set(0, 1e6));
            patch(semantic.uniforms, 'gdoMinimumPixels', uniform => { uniform.value = 0; });
          }
          patch(material.uniforms, 'uNormalFade', uniform => uniform.value.set(0, 1e6));
        };
        game.scene.traverse(object => {
          const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
          for (const material of list) visit(material);
        });
        for (const material of [game.world?.landMaterial, game.world?.waterMaterial,
          game.world?.facadeMaterial, game.world?.roofMaterial]) visit(material);
        this.savedOriginals = originals;
        return changed;
      },

      /** Put every patched uniform back to its shipped value. */
      restoreAntiAliasPolicy() {
        const originals = this.savedOriginals ?? [];
        for (const { uniform, value } of originals) {
          if (value?.clone) uniform.value.copy(value);
          else uniform.value = value;
        }
        this.savedOriginals = [];
        return originals.length;
      },

      /**
       * Put the camera low over the water surface at a grazing angle when the
       * fixture has water — the worst case for normal-map aliasing — and fall
       * back to ground level otherwise.
       */
      groundLevelPose() {
        const world = globalThis.__gdoAudit.game.world;
        const player = globalThis.__gdoAudit.game.player;
        let focused = null;
        for (const tile of world.tiles.values()) {
          if (!tile.water) continue;
          const position = tile.water.geometry.getAttribute('position');
          if (!position?.count) continue;
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
          for (let index = 0; index < position.count; index++) {
            const x = position.getX(index), z = position.getZ(index);
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
          }
          focused = { tileKey: tile.key, x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
          break;
        }
        if (focused) player.setPosition(focused.x, focused.z);
        player.setCameraMode('third-person', true);
        player.thirdPersonPitch = 0.01;
        player.distance = 6;
        player.updateCamera(0, true);
        return focused ? { surface: 'water', ...focused } : { surface: 'ground' };
      },
    };
  });
}

/** Frozen water-animation phase, shared by every measurement in a run. */
const FROZEN_TIME = 12;

async function measure(page, label, log) {
  const result = await page.evaluate(({ steps, yawPerStep, width, height, frozenTime, crop }) =>
    globalThis.__gdoShimmerProbe.captureSequence({ steps, yawPerStep, width, height, frozenTime, crop }),
  { steps: STEPS, yawPerStep: YAW_PER_STEP, width: FRAME_WIDTH, height: FRAME_HEIGHT,
    frozenTime: FROZEN_TIME, crop: CROP });
  const stats = result.stats;
  log(`[mat03] ${label}: mean |Δluma| = ${stats.mean.toFixed(4)}, p99.9 = ${stats.p999.toFixed(1)}, ` +
      `hot pixels = ${(stats.hotFraction * 100).toFixed(3)}% over ${STEPS} sub-pixel steps ` +
      `(Δyaw/step = ${YAW_PER_STEP}, wave phase pinned at ${result.frozenTime ?? 'n/a'})`);
  return { label, stats, variance: stats.mean, p999: stats.p999, hotFraction: stats.hotFraction,
    baseYaw: result.baseYaw, pixelRatio: result.pixelRatio };
}

export async function run({ page, baseUrl, log = console.log, fixture = 'dense-urban', variant = 'openmaptiles' }) {
  const directory = freshRunDirectory('mat03-shimmer-low-dpr');
  await installShimmerProbe(page);

  const policy = await page.evaluate(() => globalThis.__gdoShimmerProbe.texturePolicy());
  const mipped = policy.filter(texture => texture.generateMipmaps);
  log(`[mat03] textures in scene: ${policy.length}, with mip chains: ${mipped.length}`);
  for (const texture of mipped) {
    log(`[mat03]   ${texture.name} ${texture.width}x${texture.height} minFilter=${texture.minFilter} ` +
        `mipmaps=${texture.generateMipmaps}`);
  }

  // Tiles stream in asynchronously; posture on whatever surfaces actually
  // arrived rather than on an empty world.
  for (let attempt = 0; attempt < 45; attempt++) {
    const stats = await readCoordinateStats(page);
    if ((stats.buildings ?? 0) > 0) break;
    await waitFrames(page, 4);
  }
  const surface = await page.evaluate(() => globalThis.__gdoShimmerProbe.groundLevelPose());
  log(`[mat03] shimmer surface: ${surface.surface}${surface.tileKey ? ` on tile ${surface.tileKey}` : ''}, camera pitch 0.01 (grazing)`);
  const ratio = await page.evaluate(() => globalThis.__gdoAudit.game.renderer.getPixelRatio());
  log(`[mat03] renderer pixel ratio ${ratio} (deviceScaleFactor ${SHIMMER_LOW_DPR}) — the low-pixel-ratio condition`);

  // A: production policy.
  const production = await measure(page, 'production (mip chains active)', log);

  // B: mip-disabled control at the identical camera micro-motion.
  const changed = await page.evaluate(() => globalThis.__gdoShimmerProbe.disableMipmaps());
  log(`[mat03] control: disabled mip chains on ${changed.length} texture(s): ` +
      `${changed.map(texture => texture.name).join(', ') || 'none'}`);
  if (!changed.length) throw new Error('No mipped textures found; the shimmer control cannot be built.');
  const control = await measure(page, 'control (mipmaps disabled)', log);

  const ratioObserved = production.variance > 0 ? control.variance / production.variance : null;
  log(`[mat03] mip control / production ratio = ` + `${ratioObserved === null ? 'n/a' : ratioObserved.toFixed(3)}x`);
  // A 1.001x ratio is not a contribution. Require a real margin before calling
  // the mip policy effective, or the harness will report a benefit that is not
  // there — which is exactly the mistake this scenario exists to prevent.
  const MIP_EFFECT_THRESHOLD = 1.05;
  log(`[mat03] mip policy contribution: ${ratioObserved !== null && ratioObserved > MIP_EFFECT_THRESHOLD
    ? `measurably suppresses temporal aliasing (${ratioObserved.toFixed(3)}x)`
    : `no measurable effect (${ratioObserved === null ? 'n/a' : `${ratioObserved.toFixed(3)}x`}, threshold ${MIP_EFFECT_THRESHOLD}x)`}`);

  // C: POSITIVE CONTROL — is the metric even able to see shimmer? Restore the
  // shipped mip chains first so this isolates the fade policy alone.
  const semanticMaterials = await page.evaluate(() => globalThis.__gdoShimmerProbe.semanticMaterialCount());
  log(`[mat03] semantic materials exposing the anti-alias uniforms: ${semanticMaterials}`);
  // NOTE: a stronger positive control — forcing NearestFilter as well as
  // disabling mips — was tried and abandoned. Under SwiftShader that
  // configuration makes each capture take minutes instead of seconds and the
  // run never completed inside a 900s protocol timeout, so it produced no data.
  // Do not reintroduce it without first measuring its per-frame cost.
  const stripped = await page.evaluate(() => globalThis.__gdoShimmerProbe.disableAntiAliasPolicy());
  log(`[mat03] positive control: stripped fades on ${stripped.length} uniform(s)`);
  let positive = null;
  let sensitivity = null;
  if (stripped.length) {
    positive = await measure(page, 'positive control (anti-alias policy stripped)', log);
    // Validate on the upper tail, which is where localised shimmer shows up.
    sensitivity = production.p999 > 0 ? positive.p999 / production.p999 : null;
    log(`[mat03] positive control / production ratio (p99.9) = ` +
        `${sensitivity === null ? 'n/a' : sensitivity.toFixed(3)}x`);
    log(`[mat03] metric sensitivity: ${sensitivity !== null && sensitivity > 1.5
      ? 'CONFIRMED — the metric detects aliasing when filtering and fades are removed'
      : 'NOT CONFIRMED — the metric cannot distinguish maximal aliasing from shipped policy, so its numbers prove nothing'}`);
    const restored = await page.evaluate(() => globalThis.__gdoShimmerProbe.restoreAntiAliasPolicy());
    log(`[mat03] restored ${restored} uniform(s) to shipped policy`);
  } else {
    log('[mat03] WARNING: no anti-alias uniforms were reachable; the metric is unvalidated');
  }

  const screenshots = [];
  screenshots.push(await capture(page, directory, 'shimmer-low-dpr'));
  screenshots.push(await capture(page, directory, 'shimmer-pixel-ratio'));

  // The single source of truth for whether this run reached a verdict. Also read
  // by run.mjs, which exits 2 (inconclusive) rather than 0 when it is false.
  const metricValidated = sensitivity !== null && sensitivity > 1.5;

  return {
    fixture: `${fixture}/${variant}`,
    directory,
    surface,
    deviceScaleFactor: SHIMMER_LOW_DPR,
    pixelRatio: ratio,
    texturePolicy: policy,
    mippedTextures: mipped,
    controlTexturesChanged: changed,
    steps: STEPS,
    yawPerStep: YAW_PER_STEP,
    frozenWavePhase: FROZEN_TIME,
    productionVariance: production.variance,
    controlVariance: control.variance,
    suppressionRatio: ratioObserved,
    semanticMaterialCount: semanticMaterials,
    strippedUniforms: stripped,
    positiveControlVariance: positive?.variance ?? null,
    positiveControlP999: positive?.p999 ?? null,
    positiveControlHotFraction: positive?.hotFraction ?? null,
    productionP999: production.p999,
    productionHotFraction: production.hotFraction,
    metricSensitivity: sensitivity,
    // A low production variance only means something once the positive control
    // shows the metric can rise. Recorded explicitly so the verdict below is
    // never read as stronger than the evidence.
    metricValidated,
    sweeps: 0,
    blockers: 0,
    // Deliberately explicit, and the primary thing a reader should take away:
    // this run reached no verdict. Stated in the artifact itself so a later
    // reader cannot mistake a completed run for a pass.
    verdict: metricValidated
      ? 'metric validated; see the reported ratios'
      : 'INCONCLUSIVE — the statistic did not respond to a positive control that strips the whole anti-alias policy, so it cannot certify or refute the policy',
    hardwareSignOff: 'required — no software metric here can decide shimmer; capture on a real GPU with the same scenario and statistics',
    screenshots,
  };
}
