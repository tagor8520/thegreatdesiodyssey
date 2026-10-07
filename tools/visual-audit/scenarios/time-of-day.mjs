/**
 * `ENV-02` — time-of-day light/sky state *(coordinate, with the curated runtime beside it)*
 *
 * Registered gate (feature-roadmap/README.md order 111):
 *   "Bounded uniform updates, readable night, no per-frame allocation"
 *
 * Research (`VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md`):
 *   §9.1 — a uniform-driven sky with named phases, and the warning that a full physical
 *   atmosphere is *not* appropriate for the low-end default.
 *   §14 — *"Environment uniform updates | on change / ≤ 10 Hz | ≤ 15 Hz | ≤ 30 Hz"*.
 *   §9.2 — night and weather states read this state (§9.2's table lists *"night"* as a
 *   light state that weather then modifies).
 *
 * THREE CLAIMS, AND HOW EACH IS MEASURED INDEPENDENTLY
 * --------------------------------------------------
 * 1. **Bounded uniform updates.** The scenario drives the runtime's own frame loop with a
 *    moving clock and counts the writes the runtime reports over real seconds, against the
 *    profile's ceiling; then it freezes the clock and requires **zero** further writes. A
 *    gate that only read the model's counters would be checking the model, so the second
 *    half of this one is measured from the *renderer's* side as well: the sky uniforms and
 *    the light rig are read back and compared against the state they claim to hold.
 * 2. **Readable night.** Not "the model says the luminance is fine" but what the frame
 *    actually looks like: the scenario sets the clock to local midnight, renders, and reads
 *    the WebGL buffer, reporting mean luma, the fraction of the frame above a visible
 *    floor, and the blue/red balance. Night has to be *darker than day* and still
 *    *legible* — both are asserted, so a night that is merely dark fails, and so does a
 *    night that is not dark at all.
 * 3. **No per-frame allocation.** Heap sampling on a browser is not trustworthy for
 *    transient garbage, so the deterministic half is asserted instead: the state object
 *    graph must be the same instances after a hundred frames, and the uniform objects must
 *    be the state's own (bound by reference), so applying a state cannot allocate.
 *
 * The scenario runs in the coordinate runtime and then repeats the state and budget checks
 * against the curated runtime, because both are supposed to answer the same questions.
 */
import { freshRunDirectory, openCoordinates, openCurated, selectFixture, waitFrames } from '../harness.mjs';

/** Per-pixel statistics of the rendered frame, computed inside the page. */
const PIXEL_PROBE = `(crop) => {
  const game = globalThis.__gdoAudit.game;
  const renderer = game.renderer ?? game.environment?.renderer;
  const gl = renderer.getContext();
  // The frame must be drawn and read in the *same* task: the default framebuffer is
  // presented — and its contents become undefined — as soon as the task yields, so
  // reading pixels from the animation loop's last frame returns black. Drawing here is
  // what makes the measurement about the state that was just applied.
  if (game.environment?.render) game.environment.render(0.016);
  else renderer.render(game.scene, game.camera);
  const canvas = renderer.domElement;
  const width = canvas.width, height = canvas.height;
  const x0 = Math.floor(width * crop[0]), y0 = Math.floor(height * crop[1]);
  const w = Math.max(1, Math.floor(width * crop[2])), h = Math.max(1, Math.floor(height * crop[3]));
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let sum = 0, count = 0, visible = 0, red = 0, blue = 0, maxLuma = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const offset = (y * width + x) * 4;
    const r = pixels[offset] / 255, g = pixels[offset + 1] / 255, b = pixels[offset + 2] / 255;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma; count++;
    if (luma > 0.035) visible++;
    if (luma > maxLuma) maxLuma = luma;
    red += r; blue += b;
  }
  return {
    width, height, samples: count,
    meanLuma: sum / count,
    maxLuma,
    visibleFraction: visible / count,
    redBlueRatio: blue > 0 ? red / blue : 0,
  };
}`;

async function sampleFrame(page, crop = [0, 0, 1, 1]) {
  return page.evaluate(`(${PIXEL_PROBE})(${JSON.stringify(crop)})`);
}

/** Read what the runtime says, and what the renderer actually holds. */
async function readRuntime(page, runtime) {
  return page.evaluate(runtimeName => {
    const game = globalThis.__gdoAudit.game;
    const diagnostics = runtimeName === 'curated' ? game.timeOfDayDiagnostics : game.timeOfDayDiagnostics;
    const state = game.timeOfDay?.state ?? null;
    const skyUniforms = game.sky?.material?.uniforms ?? null;
    const environment = game.environment ?? null;
    return {
      diagnostics,
      state: state ? {
        phase: state.phase,
        sunElevation: state.sunElevation,
        sunAzimuth: state.sunAzimuth,
        lightIntensity: state.lightIntensity,
        groundLuminance: state.groundLuminance,
        starVisibility: state.starVisibility,
        exposure: state.exposure,
        sunDirection: [state.sunDirection.x, state.sunDirection.y, state.sunDirection.z],
        lightDirection: [state.lightDirection.x, state.lightDirection.y, state.lightDirection.z],
        horizon: [state.horizon.r, state.horizon.g, state.horizon.b],
        fog: [state.fogColor.r, state.fogColor.g, state.fogColor.b],
      } : null,
      // What the *scene* holds, read back independently of the state.
      scene: {
        background: game.scene?.background?.isColor,
        fogColor: game.scene?.fog?.color?.getHex?.() ?? null,
      },
      // Coordinate mode exposes the dome; curated's sky lives inside Environment.
      sky: skyUniforms ? {
        starVisibility: skyUniforms.uStarVisibility.value,
        cloudCover: skyUniforms.uCloudCover.value,
        sunDirection: skyUniforms.uSunDirection.value.toArray(),
        horizon: skyUniforms.uHorizon.value.toArray(),
        boundByReference: skyUniforms.uHorizon.value === state?.horizon,
      } : null,
      lightRig: (() => {
        const sun = game.world?.scene?.getObjectByProperty?.('isDirectionalLight', true) ??
          game.scene?.children?.find?.(child => child.isDirectionalLight) ?? null;
        return sun ? { intensity: sun.intensity, position: sun.position.toArray(),
          color: [sun.color.r, sun.color.g, sun.color.b] } : null;
      })(),
      environmentMapBuilds: environment?.environmentMapBuilds ?? null,
      exposure: (game.renderer ?? environment?.renderer)?.toneMappingExposure ?? null,
    };
  }, runtime);
}

export async function run({ page, baseUrl, log = console.log, fixtures = ['dense-urban'] }) {
  const directory = freshRunDirectory('env02-time-of-day');
  const failures = [];

  // ------------------------------------------------------------------ coordinate mode
  await selectFixture(page, baseUrl, { id: fixtures[0] });
  await openCoordinates(page, baseUrl, { latitude: 28.9845, longitude: 77.7064 });
  await page.click('.geo-debug-toggle');
  await page.evaluate(() => { globalThis.__gdoAudit.game.setClockMinutes(409); });
  await waitFrames(page, 8);

  const noon = await readRuntime(page, 'coordinates');
  const noonPixels = await sampleFrame(page);
  log(`[env02] coordinates · ${noon.diagnostics.clock} ${noon.diagnostics.phase} (${noon.diagnostics.phaseLabel}) · sun ${noon.state.sunElevation.toFixed(1)}° · light ${noon.state.lightIntensity.toFixed(2)} · exposure ${noon.state.exposure.toFixed(2)}`);
  log(`[env02] noon frame: mean luma ${noonPixels.meanLuma.toFixed(3)}, visible ${(noonPixels.visibleFraction * 100).toFixed(1)}%, max ${noonPixels.maxLuma.toFixed(2)}`);
  // `AGENTS.md` item 6: the dusk/night state winds the ambient budget down through
  // `world.setAmbientActivity()` rather than through a second animation path. Read from the
  // world's own field, so a runtime that kept a private copy would not pass.
  const noonAmbience = await page.evaluate(() => globalThis.__gdoAudit.game.world?.ambientActivity ?? null);
  log(`[env02] ambient budget at noon: ${noonAmbience}`);

  // --- bounded uniform updates: frozen clock writes nothing -------------------------
  const frozenWrites = await page.evaluate(async () => {
    const game = globalThis.__gdoAudit.game;
    game.timeOfDay.setClock(409);
    const before = game.timeOfDayDiagnostics.writes;
    for (let frame = 0; frame < 60; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    return { writes: game.timeOfDayDiagnostics.writes - before, frames: 60 };
  });
  log(`[env02] frozen clock: ${frozenWrites.writes} uniform write(s) over 60 frames`);
  if (frozenWrites.writes > 0) failures.push(`a frozen clock wrote ${frozenWrites.writes} uniforms over ${frozenWrites.frames} frames; "on change" means zero`);

  // --- bounded uniform updates: a moving clock honours the ceiling ------------------
  const moving = await page.evaluate(async () => {
    const game = globalThis.__gdoAudit.game;
    game.timeOfDay.timeScale = 600;
    const startWrites = game.timeOfDayDiagnostics.writes;
    const start = performance.now();
    let seconds = 0;
    // Accumulate writes per whole real second so the ceiling can be judged per second.
    const perSecond = [];
    let windowStart = performance.now(), windowStartWrites = startWrites, framesObserved = 0;
    while (performance.now() - start < 5000) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      framesObserved++;
      const now = performance.now();
      if (now - windowStart >= 1000) {
        perSecond.push(game.timeOfDayDiagnostics.writes - windowStartWrites);
        windowStart = now; windowStartWrites = game.timeOfDayDiagnostics.writes;
        seconds++;
      }
    }
    game.timeOfDay.timeScale = 0;
    return {
      perSecond, seconds,
      elapsed: performance.now() - start,
      elapsedSeconds: (performance.now() - start) / 1000,
      framesObserved,
      total: game.timeOfDayDiagnostics.writes - startWrites,
      coalesced: game.timeOfDayDiagnostics.coalesced,
      profile: game.timeOfDayDiagnostics.profile,
      uniformHz: game.timeOfDayDiagnostics.uniformHz,
      frameCount: game.timeOfDayDiagnostics.writes,
    };
  });
  log(`[env02] moving clock (600 min/s): ${moving.total} write(s) in ${moving.elapsedSeconds.toFixed(1)}s over ${moving.framesObserved} frames (~${(moving.framesObserved / moving.elapsedSeconds).toFixed(1)} fps), profile ceiling ${moving.uniformHz}/s, per second [${moving.perSecond.join(', ')}], ${moving.coalesced} coalesced`);
  // The renderer here runs at a few frames per second, so the live loop *cannot* reach a
  // 10 Hz ceiling — the frame rate bounds it first. So the ceiling is also driven
  // synthetically through the same module instance at 60 fps, which is what the Node tier
  // does too; the live loop then proves the other half, that a frozen clock writes nothing.
  const syntheticWrites = await page.evaluate(() => {
    const game = globalThis.__gdoAudit.game;
    const subject = game.timeOfDay;
    const previous = subject.timeScale;
    // The driver owns the timeline here: it emits 60 fps timestamps into a three-second
    // simulated window, so the limiter is re-anchored to that timeline and restored to the
    // runtime's own clock afterwards.
    const base = performance.now();
    subject.timeScale = 600;
    subject.rebaseClock(base);
    let writes = 0, frames = 0;
    for (let frame = 0; frame < 180; frame++) {
      if (subject.update(1 / 60, base + frame * (1000 / 60))) { writes++; subject.markApplied(); }
      frames++;
    }
    subject.timeScale = previous;
    subject.rebaseClock(performance.now());
    return { writes, frames, perSecond: writes / 3, ceiling: subject.diagnostics().uniformHz };
  });
  log(`[env02] synthetic 60 fps drive: ${syntheticWrites.writes} write(s) over ${syntheticWrites.frames} frames (${syntheticWrites.perSecond.toFixed(1)}/s against ${syntheticWrites.ceiling}/s)`);
  if (!(syntheticWrites.writes > 0)) failures.push('a 60 fps drive made no uniform writes, so the ceiling is not being exercised');
  if (syntheticWrites.perSecond > syntheticWrites.ceiling + 0.5) {
    failures.push(`a 60 fps drive wrote ${syntheticWrites.perSecond.toFixed(1)} uniforms/s against a ${syntheticWrites.ceiling}/s ceiling`);
  }
  if (!(moving.uniformHz > 0)) failures.push('the runtime did not report a uniform-write ceiling');
  if (moving.perSecond.some(count => count > moving.uniformHz + 1)) {
    failures.push(`uniform writes exceeded the ceiling: [${moving.perSecond.join(', ')}] against ${moving.uniformHz}/s`);
  }
  if (!(moving.total > 0)) failures.push('a moving clock made no uniform writes at all, so the ceiling was never exercised');
  if (!(moving.total < moving.elapsedSeconds * 60)) {
    failures.push(`the moving clock wrote ${moving.total} times in ${moving.elapsedSeconds.toFixed(1)}s, which is not bounded below the frame rate`);
  }
  // The state must remain bound by reference throughout — that is the no-allocation half.
  const identity = await page.evaluate(async () => {
    const game = globalThis.__gdoAudit.game;
    const state = game.timeOfDay.state;
    const nested = [state.horizon, state.middle, state.zenith, state.sunColor, state.sunDirection, state.lightDirection];
    for (let frame = 0; frame < 100; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    return {
      sameState: game.timeOfDay.state === state,
      sameNested: nested.every((value, index) => [state.horizon, state.middle, state.zenith, state.sunColor, state.sunDirection, state.lightDirection][index] === value),
      uniformBound: game.sky ? game.sky.material.uniforms.uHorizon.value === state.horizon : null,
    };
  });
  log(`[env02] after 100 frames: state identity ${identity.sameState}, nested identity ${identity.sameNested}, uniforms bound by reference ${identity.uniformBound}`);
  if (!identity.sameState || !identity.sameNested) failures.push('the state object graph was rebuilt across frames, so a frame allocates');
  if (identity.uniformBound === false) failures.push('the sky uniform is not the state object, so applying a state copies rather than points');

  // --- readable night, measured from the frame -------------------------------------
  await page.evaluate(() => { globalThis.__gdoAudit.game.setClockMinutes(1080); }); // 18:00 UTC = 23:11 local solar
  await waitFrames(page, 8);
  const night = await readRuntime(page, 'coordinates');
  const nightPixels = await sampleFrame(page);
  log(`[env02] coordinates · ${night.diagnostics.clock} ${night.diagnostics.phase} · sun ${night.state.sunElevation.toFixed(1)}° · stars ${night.state.starVisibility.toFixed(2)} · light ${night.state.lightIntensity.toFixed(2)} · exposure ${night.state.exposure.toFixed(2)}`);
  log(`[env02] night frame: mean luma ${nightPixels.meanLuma.toFixed(3)}, visible ${(nightPixels.visibleFraction * 100).toFixed(1)}%, red/blue ${nightPixels.redBlueRatio.toFixed(2)}`);
  if (night.diagnostics.phase !== 'night') failures.push(`18:00 UTC at 77.7°E should be night, runtime says ${night.diagnostics.phase}`);
  if (!(nightPixels.meanLuma < noonPixels.meanLuma * 0.75)) {
    failures.push(`night is not meaningfully darker than day (${nightPixels.meanLuma.toFixed(3)} vs ${noonPixels.meanLuma.toFixed(3)})`);
  }
  // Readability is a **relative** claim: a night that keeps a large part of the daylight
  // frame's legible coverage is readable, and one that has collapsed to a fraction of it is
  // not — an absolute floor of a few per cent passed a night that had lost its moon and
  // most of its ambient term.
  if (!(nightPixels.visibleFraction >= 0.4 * noonPixels.visibleFraction)) {
    failures.push(`night keeps only ${(nightPixels.visibleFraction * 100).toFixed(1)}% legible coverage against the day's ${(noonPixels.visibleFraction * 100).toFixed(1)}% — dark is not the same as readable`);
  }
  if (!(nightPixels.meanLuma >= 0.05)) failures.push(`the night frame is nearly black (mean luma ${nightPixels.meanLuma.toFixed(3)})`);
  if (!(nightPixels.maxLuma > 0.15)) failures.push(`nothing in the night frame is bright (max luma ${nightPixels.maxLuma.toFixed(3)})`);
  if (!(night.state.starVisibility > 0.5)) failures.push(`the night sky should carry stars, got ${night.state.starVisibility.toFixed(2)}`);
  if (night.sky && !(night.sky.starVisibility > 0.5)) failures.push('the star uniform on the dome does not carry the state value');
  if (!(night.state.sunElevation < 0)) failures.push('the sun is above the horizon at this clock');
  const nightAmbience = await page.evaluate(() => globalThis.__gdoAudit.game.world?.ambientActivity ?? null);
  log(`[env02] ambient budget through the phase change: ${noonAmbience} at noon → ${nightAmbience} at night`);
  if (noonAmbience === null || nightAmbience === null) failures.push('the runtime does not expose the ambient activity budget');
  else {
    if (!(noonAmbience === 1)) failures.push(`the ambient budget is ${noonAmbience} in full daylight, not the full 1`);
    // Wound down, not switched off: the budget falls but ambience stays drawn, which is the
    // difference between a state change and a second spawn controller.
    if (!(nightAmbience < noonAmbience && nightAmbience > 0)) {
      failures.push(`the night state does not wind the ambient budget down (${noonAmbience} → ${nightAmbience}); AGENTS.md item 6 wants a budget change, not an off switch`);
    }
  }

  // --- the light rig follows the state, read back from the scene -------------------
  const showsSun = noon.state.sunElevation > 0;
  if (noon.lightRig) {
    const direction = noon.lightRig.position;
    const length = Math.hypot(...direction);
    const unit = direction.map(value => value / length);
    const stateDirection = showsSun ? noon.state.lightDirection : night.state.lightDirection;
    const alignment = Math.abs(unit[0] * stateDirection[0] + unit[1] * stateDirection[1] + unit[2] * stateDirection[2]);
    log(`[env02] light rig at noon: intensity ${noon.lightRig.intensity.toFixed(2)}, direction alignment ${alignment.toFixed(4)}`);
    if (!(alignment > 0.999)) failures.push(`the directional light is not on the state's direction (alignment ${alignment.toFixed(4)})`);
  }
  if (noon.scene.background === false) failures.push('the scene background is not a colour the state can drive');
  if (night.scene.fogColor === noon.scene.fogColor) failures.push('the fog colour did not change between noon and night');

  // --- the review panel carries the state ------------------------------------------
  const panelLine = await page.evaluate(() => (document.querySelector('#geo-debug-output')?.textContent ?? '')
    .split('\n').find(line => line.startsWith('time ')) ?? null);
  log(`[env02] review panel: ${panelLine ?? 'no time-of-day line'}`);
  if (!panelLine) failures.push('the review panel has no `time` line');
  else if (!/^time \d{2}:\d{2} UTC · phase [a-z-]+ · sun -?\d+\.\d° · light \d+\.\d{2} · stars \d\.\d{2} · exposure \d\.\d{2} · writes \d+ · ceil \d+Hz$/.test(panelLine)) {
    failures.push(`the time-of-day line does not carry the clock, phase, sun elevation, stars and write budget: ${panelLine}`);
  }

  // --------------------------------------------------------------------- curated mode
  await openCurated(page, baseUrl);
  await page.evaluate(() => { globalThis.__gdoAudit.game.setClockMinutes(409); });
  await waitFrames(page, 8);
  const curatedNoon = await readRuntime(page, 'curated');
  const curatedNoonPixels = await sampleFrame(page);
  await page.evaluate(() => { globalThis.__gdoAudit.game.setClockMinutes(1080); });
  await waitFrames(page, 8);
  const curatedNight = await readRuntime(page, 'curated');
  const curatedPixels = await sampleFrame(page);
  log(`[env02] curated · noon ${curatedNoon.diagnostics.phase} ${curatedNoon.state.sunElevation.toFixed(1)}° → night ${curatedNight.diagnostics.phase} ${curatedNight.state.sunElevation.toFixed(1)}° · stars ${curatedNight.state.starVisibility.toFixed(2)}`);
  log(`[env02] curated night frame: mean luma ${curatedPixels.meanLuma.toFixed(3)}, visible ${(curatedPixels.visibleFraction * 100).toFixed(1)}%`);
  if (!curatedNoon.diagnostics?.phase) failures.push('the curated runtime does not expose a time-of-day state');
  if (curatedNight.diagnostics?.phase !== 'night') failures.push(`the curated runtime did not reach night (${curatedNight.diagnostics?.phase})`);
  if (curatedNight.state && !(curatedNight.state.sunElevation < 0)) failures.push('the curated sun is above the horizon at night');
  if (!(curatedPixels.visibleFraction >= 0.4 * curatedNoonPixels.visibleFraction)) {
    failures.push(`the curated night keeps only ${(curatedPixels.visibleFraction * 100).toFixed(1)}% legible coverage against its day's ${(curatedNoonPixels.visibleFraction * 100).toFixed(1)}%`);
  }
  // The environment map must be rebuilt per phase, not per frame: bounded work, and the
  // count has to be small compared with the frames that ran.
  const builds = curatedNight.environmentMapBuilds;
  log(`[env02] curated environment-map builds: ${builds}`);
  if (builds !== null && !(builds <= 6)) {
    failures.push(`the curated environment map was rebuilt ${builds} times, which is per-frame work rather than per-phase`);
  }

  return {
    directory,
    blockers: failures.length,
    sweepFrames: 0,
    totalPenetrations: 0,
    ambientFailures: failures.length ? [] : undefined,
    timeOfDayFailures: failures,
    fixtures,
    coordinate: {
      noon: { clock: noon.diagnostics.clock, phase: noon.diagnostics.phase, sun: noon.state.sunElevation, exposure: noon.state.exposure },
      night: { clock: night.diagnostics.clock, phase: night.diagnostics.phase, sun: night.state.sunElevation, stars: night.state.starVisibility, exposure: night.state.exposure },
    },
    pixels: { noon: noonPixels, night: nightPixels, curatedNoon: curatedNoonPixels, curatedNight: curatedPixels },
    writes: {
      frozen: frozenWrites,
      moving: { perSecond: moving.perSecond, total: moving.total, ceiling: moving.uniformHz, elapsedSeconds: moving.elapsedSeconds, coalesced: moving.coalesced, framesObserved: moving.framesObserved },
      synthetic: syntheticWrites,
    },
    identity,
    lightRig: noon.lightRig,
    environmentMapBuilds: builds,
    panelLine,
  };
}
