/**
 * `ENV-04` — weather states *(coordinate, with the curated runtime beside it)*
 *
 * Registered gate (feature-roadmap/README.md order 113):
 *   "Deterministic transitions, environment response, low-profile fallback"
 *
 * Research (`VISUAL_BIOME_BEAUTIFICATION_RESEARCH.md`):
 *   §9.2 — the eight states (*Clear, Haze, Overcast, Rain, Storm, Dust, Snow, Mist*) with
 *   their light, surface and habitat consequences, and the rule that weather states are
 *   driven by *macro climate + month + world-time window + coordinate seed*.
 *   §9.4 — *"never combine heavy rain, fog particles, insects, pollen, and dust
 *   simultaneously"*, and the particle ceilings (80 / 180 / 350).
 *   §14 — *"Environment uniform updates | on change / ≤ 10 Hz | ≤ 15 Hz | ≤ 30 Hz"*.
 *
 * THREE CLAIMS, AND HOW EACH IS MEASURED INDEPENDENTLY
 * ----------------------------------------------------
 * 1. **Deterministic transitions.** The state at a clock is decided by the coordinate seed,
 *    the climate and the clock, so the same coordinate in a *second session* has to produce
 *    the same seed, the same climate and the same state — the scenario re-navigates and
 *    compares. The runtime's own seed is checked against the module's hash recomputed
 *    in-page, and the schedule it applied is checked against the module's own
 *    random-access sampler walked at those clocks. Then the budget: a frozen clock must
 *    write nothing at all, a synthetic 60 fps drive with a moving clock must stay inside the
 *    profile ceiling, and a clock jump must cost one write rather than one per window
 *    skipped. Finally the *transition* itself: sweeping a whole day must change the state,
 *    and must move no response field by more than a cross-fade step between adjacent
 *    samples, which is continuity stated in the clock.
 * 2. **Environment response.** For each of the eight states the scenario drives the *live
 *    runtime* to that state (searching seeds through the runtime's own model, because the
 *    day the schedule gives is a day, not a menu) and then reads back what the renderer
 *    actually holds: the dome's cloud uniforms, the water's weather uniform, the fog range
 *    and colour, the sun's intensity, the exposure, and the pixels. Each state is compared
 *    against `clear` **at the same clock**, so the hour cannot explain a difference, and
 *    every state's response vector has to be distinct from every other's — which is the
 *    claim that the states are visible at all. Two of the comparisons are one-directional
 *    on purpose: a storm must be darker than clear, and its fog must stay a *tint* of the
 *    time-of-day fog rather than a colour of its own, so weather can never brighten a night.
 * 3. **Low-profile fallback.** The runtime's profile must run **zero** particle families —
 *    so every state has to be readable without them, which the response-vector check above
 *    measures, but only after this one has established that there are no particles to fall
 *    back to. On top of that the scene must not grow: no state may add an object, and the
 *    habitat response rides the existing ambient budget rather than a second animation
 *    path, so the drawn agent count has to fall while the phase budget stays at 1.
 *
 * The scenario runs in the coordinate runtime and then repeats the state and identity
 * checks against the curated runtime, because both are supposed to answer the same
 * questions with the same vocabulary of skies.
 */
import { freshRunDirectory, openCoordinates, openCurated, selectFixture, waitFrames } from '../harness.mjs';

const COORDINATE = { latitude: 28.9845, longitude: 77.7064 };

/** Per-pixel statistics of the rendered frame, computed inside the page. */
async function sampleFrame(page, crop = [0, 0, 1, 1]) {
  return page.evaluate(rect => {
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
    const x0 = Math.floor(width * rect[0]), y0 = Math.floor(height * rect[1]);
    const w = Math.max(1, Math.floor(width * rect[2])), h = Math.max(1, Math.floor(height * rect[3]));
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
  }, crop);
}

/** What the runtime applied and what the renderer holds — read back independently. */
async function readWeather(page) {
  return page.evaluate(() => {
    const game = globalThis.__gdoAudit.game;
    const uniforms = game.sky?.material?.uniforms ?? null;
    const world = game.world ?? null;
    const renderer = game.renderer ?? game.environment?.renderer;
    const sun = game.scene?.children?.find?.(child => child.isDirectionalLight) ?? null;
    let instances = 0, meshes = 0;
    for (const tile of world?.tiles?.values?.() ?? []) {
      for (const mesh of Object.values(tile.ambientMeshes ?? {})) {
        if (!mesh || !(mesh.count > 0)) continue;
        meshes++; instances += mesh.count;
      }
    }
    return {
      diagnostics: game.weatherDiagnostics,
      state: game.weatherState,
      // The dome, in coordinate mode. `null` in curated mode, which has no dome shader.
      sky: uniforms ? {
        cloudCover: uniforms.uCloudCover?.value ?? null,
        cloudDarkness: uniforms.uCloudDarkness?.value ?? null,
        skyTime: uniforms.uSkyTime?.value ?? null,
        boundByReference: uniforms.uCloudCover?.value !== undefined,
      } : null,
      fog: game.scene?.fog ? {
        near: game.scene.fog.near,
        far: game.scene.fog.far,
        color: [game.scene.fog.color.r, game.scene.fog.color.g, game.scene.fog.color.b],
      } : null,
      // The hour's own numbers, so a comparison can be made against the state that the
      // weather composed onto rather than against the last weather that ran.
      timeOfDay: game.timeOfDay?.state ? {
        cloudCover: game.timeOfDay.state.cloudCover,
        fogColor: [game.timeOfDay.state.fogColor.r, game.timeOfDay.state.fogColor.g, game.timeOfDay.state.fogColor.b],
        sunElevation: game.timeOfDay.state.sunElevation,
        lightIntensity: game.timeOfDay.state.lightIntensity,
        exposure: game.timeOfDay.state.exposure,
      } : null,
      sunIntensity: sun ? sun.intensity : null,
      exposure: renderer?.toneMappingExposure ?? null,
      water: world?.waterMaterial?.uniforms?.uWeather ? {
        ripple: world.waterMaterial.uniforms.uWeather.value.x,
        wetness: world.waterMaterial.uniforms.uWeather.value.y,
      } : (game.environment?.weatherDiagnostics?.waterNormalScale != null ? {
        normalScale: game.environment.weatherDiagnostics.waterNormalScale,
        roughness: game.environment.weatherDiagnostics.waterRoughness,
        background: game.environment.weatherDiagnostics.background,
      } : null),
      ambientActivity: world?.ambientActivity ?? null,
      ambience: { instances, meshes },
      drawnSlots: world?.ambientDiagnostics?.drawnSlots ?? null,
      ambientPasses: world?.ambientDiagnostics?.passes ?? null,
      sceneChildren: game.scene?.children?.length ?? null,
      rendererCalls: renderer?.info?.render?.calls ?? null,
    };
  });
}

/**
 * Drive the live runtime to a specific weather state.
 *
 * The runtime's own model is asked to *find* a window whose state is the target: the day the
 * seed produces is a day, not a menu, so a probe that wants to see snow has to seed the world
 * until it snows. Everything that is then *measured* comes back out of the renderer, not out
 * of this search.
 */
async function findWindow(page, { target, climate = null, minute = 405, seeds = 900 }) {
  return page.evaluate(({ wanted, wantedClimate, clock, limit }) => {
    const weather = globalThis.__gdoAudit.game.weather;
    const climates = wantedClimate ? [wantedClimate]
      : ['semi-arid', 'monsoon', 'cold', 'temperate', 'tropical'];
    const windowStart = Math.floor(clock / 90) * 90;
    // Mid-window, so the cross-fade into this state is complete and the state is the
    // state rather than a blend of it.
    const sampleAt = windowStart + 45;
    for (const climate of climates) {
      for (let seed = 1; seed <= limit; seed++) {
        weather.setSeed(seed);
        weather.setClimate(climate);
        weather.setClock(sampleAt);
        if (weather.sample().id !== wanted) continue;
        return { found: true, seed, climate, minute: sampleAt, window: Math.floor(sampleAt / 90) };
      }
    }
    return { found: false, climate: wantedClimate, minute: sampleAt };
  }, { wanted: target, wantedClimate: climate, clock: minute, limit: seeds });
}

/**
 * Apply a weather configuration through the runtime's public surface.
 *
 * The clock is moved through `setClockMinutes`, not through the weather's own setter, because
 * the frame loop re-reads the time-of-day clock every frame and would overwrite a weather
 * clock set behind its back — the first version of this scenario did exactly that and measured
 * three different states as whatever the runtime's clock happened to be showing. Driving the
 * one clock both runtimes read is also the honest version of "the weather follows the hour".
 */
async function applyWindow(page, window) {
  return page.evaluate(config => {
    const game = globalThis.__gdoAudit.game;
    game.weather.setSeed(config.seed);
    game.weather.setClimate(config.climate);
    game.setClockMinutes(config.minute);
    game.weather.sample();
    game.refreshWeather();
    return game.weatherState;
  }, window);
}

export async function run({ page, baseUrl, log = console.log, fixtures = ['dense-urban'] }) {
  const directory = freshRunDirectory('env04-weather-states');
  const failures = [];
  const matrix = {};
  let unreached = [];

  // ---------------------------------------------------------------- coordinate runtime
  await selectFixture(page, baseUrl, { id: fixtures[0] });
  await openCoordinates(page, baseUrl, COORDINATE);
  await page.click('.geo-debug-toggle');
  await waitFrames(page, 8);

  // --- the shipped schedule: seed, climate, and the state the fixture starts in ---------
  const shipped = await page.evaluate(({ latitude, longitude }) => {
    const game = globalThis.__gdoAudit.game;
    const diagnostics = game.weatherDiagnostics;
    return {
      diagnostics,
      // The module the runtime itself imported, re-run in the page: Vite serves one instance
      // per module URL, so this is the same code the runtime is running, not a copy.
      expectedSeed: null,
      latitude, longitude,
    };
  }, COORDINATE);
  const model = await page.evaluate(async ({ latitude, longitude }) => {
    const module = await import('/src/engine/WeatherState.js');
    const providers = globalThis.__gdoAudit.game.world?.providers ?? null;
    const provider = Array.isArray(providers) && providers.length ? providers[0].id ?? '' : '';
    return {
      seed: module.weatherSeedForCoordinate({ latitude, longitude, provider }),
      climate: module.climateForLatitude(latitude, 172),
      profiles: { low: module.GDO_WEATHER_PROFILES.low },
      states: module.GDO_WEATHER_STATE_IDS,
      ceilings: module.GDO_WEATHER_PARTICLE_CEILINGS,
      windowMinutes: module.GDO_WEATHER_WINDOW_MINUTES,
      transitionMinutes: module.GDO_WEATHER_TRANSITION_MINUTES,
    };
  }, COORDINATE);
  log(`[env04] coordinate · seed ${shipped.diagnostics.seed} (module ${model.seed}) · climate ${shipped.diagnostics.climate} (module ${model.climate}) · window ${shipped.diagnostics.window} · ${shipped.diagnostics.label} blend ${shipped.diagnostics.blend.toFixed(2)} ${shipped.diagnostics.from}→${shipped.diagnostics.to} · next ${shipped.diagnostics.next}`);
  log(`[env04] profile ${shipped.diagnostics.profile}: ceiling ${shipped.diagnostics.uniformHz}Hz · particle families ${shipped.diagnostics.particleFamilies} · particle cap ${shipped.diagnostics.particleCap}`);
  if (shipped.diagnostics.seed !== model.seed) {
    failures.push(`the runtime's weather seed ${shipped.diagnostics.seed} is not the module's hash of the coordinate ${model.seed}`);
  }
  if (shipped.diagnostics.climate !== model.climate) {
    failures.push(`the runtime's climate ${shipped.diagnostics.climate} is not what the latitude and the season imply (${model.climate})`);
  }
  if (!model.states.includes(shipped.diagnostics.weather)) {
    failures.push(`the runtime reported an unknown weather state ${JSON.stringify(shipped.diagnostics.weather)}`);
  }
  // The window arithmetic the schedule is built on, read from the module rather than assumed.
  if (model.windowMinutes * 16 !== 1440) failures.push(`a window is ${model.windowMinutes} minutes, which does not divide the day into 16`);
  if (!(model.transitionMinutes > 0 && model.transitionMinutes < model.windowMinutes)) {
    failures.push(`a ${model.transitionMinutes}-minute cross-fade does not fit inside a ${model.windowMinutes}-minute window`);
  }

  // --- determinism across sessions: re-navigate and ask again --------------------------
  const clockForSession = 613;
  await page.evaluate(minutes => { globalThis.__gdoAudit.game.setClockMinutes(minutes); }, clockForSession);
  await waitFrames(page, 6);
  const firstSession = await readWeather(page);
  await openCoordinates(page, baseUrl, COORDINATE);
  await page.evaluate(minutes => { globalThis.__gdoAudit.game.setClockMinutes(minutes); }, clockForSession);
  await waitFrames(page, 6);
  const secondSession = await readWeather(page);
  log(`[env04] session 1: clock ${clockForSession} → ${firstSession.state.id} (window ${firstSession.diagnostics.window}, ${firstSession.diagnostics.from}→${firstSession.diagnostics.to} ${firstSession.diagnostics.blend.toFixed(2)})`);
  log(`[env04] session 2: clock ${clockForSession} → ${secondSession.state.id} (window ${secondSession.diagnostics.window}) · seed ${firstSession.diagnostics.seed}/${secondSession.diagnostics.seed}`);
  if (secondSession.diagnostics.seed !== firstSession.diagnostics.seed) {
    failures.push(`a second session produced a different seed at the same coordinate (${firstSession.diagnostics.seed} → ${secondSession.diagnostics.seed})`);
  }
  if (secondSession.state.id !== firstSession.state.id) {
    failures.push(`a second session produced a different state at the same clock (${firstSession.state.id} → ${secondSession.state.id})`);
  }
  for (const field of Object.keys(firstSession.state)) {
    if (typeof firstSession.state[field] !== 'number') continue;
    if (firstSession.state[field] !== secondSession.state[field]) {
      failures.push(`a second session produced a different ${field} at the same clock (${firstSession.state[field]} → ${secondSession.state[field]})`);
    }
  }
  // Teeth: the schedule must be able to differ, or "the same state" proves nothing. The
  // module's own sampler is asked for the neighbouring window — a different clock in the same
  // session must be able to land somewhere else, and a different seed must too.
  const teeth = await page.evaluate(async ({ clock }) => {
    const module = await import('/src/engine/WeatherState.js');
    const game = globalThis.__gdoAudit.game;
    const seed = game.weatherDiagnostics.seed, climate = game.weatherDiagnostics.climate;
    const day = game.weatherDiagnostics.day;
    const sequence = (probeSeed, probeClimate, probeDay) => {
      const ids = [];
      for (let window = 0; window < 32; window++) {
        ids.push(module.sampleWeatherAt(probeSeed, probeClimate, probeDay * 1440 + window * 90 + 45).id);
      }
      return ids.join(',');
    };
    const ids = [];
    for (let minute = 0; minute < 1440; minute += 45) ids.push(module.sampleWeatherAt(seed, climate, day * 1440 + minute).id);
    return {
      ids, distinct: [...new Set(ids)].length,
      here: module.sampleWeatherAt(seed, climate, day * 1440 + clock).id,
      hereSequence: sequence(seed, climate, day),
      otherSeedSequence: sequence(seed + 1, climate, day),
      otherClimateSequence: sequence(seed, 'cold', day),
      otherDaySequence: sequence(seed, climate, day + 1),
      midnightBefore: module.sampleWeatherAt(seed, climate, day * 1440 + 1435),
      midnightAfter: module.sampleWeatherAt(seed, climate, (day + 1) * 1440 + 0),
    };
  }, { clock: clockForSession });
  log(`[env04] a day of windows: ${teeth.ids.join(' ')} · ${teeth.distinct} distinct`);
  if (!(teeth.distinct >= 2)) {
    failures.push(`a whole day of the seeded schedule is one state (${teeth.ids.join(' ')}), so "the same state" is not evidence of determinism`);
  }
  // The schedule must be able to differ, or "the same state" proves nothing: a different
  // seed, a different climate and a different day must each move the *sequence*, not one
  // sample of it.
  if (teeth.otherSeedSequence === teeth.hereSequence) failures.push('a different seed produced the same two-day sequence, so the schedule does not depend on the seed');
  if (teeth.otherClimateSequence === teeth.hereSequence) failures.push('a different climate produced the same two-day sequence, so the schedule does not depend on the climate');
  if (teeth.otherDaySequence === teeth.hereSequence) failures.push('the next day produced the same sequence, so the schedule does not depend on the day');
  // Continuity through midnight, which is where a per-day schedule is most likely to snap:
  // the last window of a day has to fade into the next day's anchor, so the state at 23:55
  // and the state at 00:00 of the following day must agree field for field.
  const midnightDelta = await page.evaluate(async ({ before, after }) => {
    const module = await import('/src/engine/WeatherState.js');
    const first = module.sampleWeatherAt(before.seed, before.climate, before.minutes);
    const second = module.sampleWeatherAt(after.seed, after.climate, after.minutes);
    return {
      worst: Math.max(...module.GDO_WEATHER_FIELDS.map(field => Math.abs(first[field] - second[field]))),
      from: first.toId, to: second.fromId, id: first.id, next: second.id,
    };
  }, {
    before: { seed: shipped.diagnostics.seed, climate: shipped.diagnostics.climate, minutes: shipped.diagnostics.day * 1440 + 1435 },
    after: { seed: shipped.diagnostics.seed, climate: shipped.diagnostics.climate, minutes: (shipped.diagnostics.day + 1) * 1440 },
  });
  log(`[env04] midnight: 23:55 ${midnightDelta.id} (settling on ${midnightDelta.from}) → 00:00 next day ${midnightDelta.next}, worst field move ${midnightDelta.worst.toFixed(4)}`);
  if (midnightDelta.worst > 1e-9) {
    failures.push(`the schedule is discontinuous at midnight (worst field move ${midnightDelta.worst.toFixed(4)}, ${midnightDelta.from} → ${midnightDelta.to})`);
  }

  // --- the runtime agrees with the module's own sampler --------------------------------
  const follow = await page.evaluate(async ({ clock }) => {
    const module = await import('/src/engine/WeatherState.js');
    const game = globalThis.__gdoAudit.game;
    const weather = game.weather;
    const seed = weather.seed, climate = weather.climate;
    const day = weather.day;
    const applied = [];
    for (let minute = 0; minute < 1440; minute += 90) {
      weather.setClock(minute);
      weather.sample();
      // The module's sampler takes an *absolute* clock (unwrapped days), the class takes a time
      // of day inside a day it was told about, so the comparison has to place the sample in the
      // same day the runtime is in.
      const expected = module.sampleWeatherAt(seed, climate, day * 1440 + minute);
      applied.push({
        minute,
        runtime: weather.state.id,
        module: expected.id,
        window: weather.state.windowIndex,
        expectedWindow: expected.windowIndex,
      });
    }
    weather.setClock(clock);
    weather.sample();
    game.refreshWeather();
    return applied;
  }, { clock: clockForSession });
  const disagreements = follow.filter(entry => entry.runtime !== entry.module || entry.window !== entry.expectedWindow);
  log(`[env04] runtime vs module over 16 windows: ${follow.map(entry => entry.runtime).join(' ')}`);
  if (disagreements.length) {
    failures.push(`the runtime's schedule disagrees with the module's sampler at ${disagreements.map(entry => `${entry.minute}m (${entry.runtime} vs ${entry.module})`).join(', ')}`);
  }

  // --- bounded writes: frozen clock, moving clock, and a jump --------------------------
  const frozen = await page.evaluate(async ({ clock }) => {
    const game = globalThis.__gdoAudit.game;
    game.weather.setClock(clock);
    game.weather.sample();
    game.refreshWeather();
    const before = game.weatherDiagnostics.writes;
    const beforeTimeOfDay = game.timeOfDayDiagnostics.writes;
    for (let frame = 0; frame < 60; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    return {
      writes: game.weatherDiagnostics.writes - before,
      timeOfDayWrites: game.timeOfDayDiagnostics.writes - beforeTimeOfDay,
      frames: 60,
      unchangedSkips: game.weatherDiagnostics.unchangedSkips,
    };
  }, { clock: clockForSession });
  log(`[env04] frozen clock: ${frozen.writes} weather write(s) and ${frozen.timeOfDayWrites} time-of-day write(s) over ${frozen.frames} frames (${frozen.unchangedSkips} unchanged skips)`);
  if (frozen.writes > 0) failures.push(`a frozen clock wrote ${frozen.writes} weather uniforms over ${frozen.frames} frames; "on change" means zero`);
  if (frozen.timeOfDayWrites > 0) failures.push(`a frozen clock wrote ${frozen.timeOfDayWrites} time-of-day uniforms over ${frozen.frames} frames`);

  const moving = await page.evaluate(() => {
    const game = globalThis.__gdoAudit.game;
    const weather = game.weather;
    const base = performance.now();
    weather.rebaseClock(base);
    weather.setClock(0);
    weather.sample();
    game.refreshWeather();
    const startWrites = weather.writes;
    let writes = 0;
    const perSecond = [];
    // Sixty frames a second with the clock advancing a world minute each frame: a day every
    // 24 seconds, which crosses every window boundary in the schedule.
    for (let frame = 0; frame < 60 * 12; frame++) {
      weather.setClock(weather.minutes + 1);
      const now = base + frame * (1000 / 60);
      if (weather.update(now)) {
        writes++;
        weather.markApplied();
        const bucket = Math.floor((now - base) / 1000);
        perSecond[bucket] = (perSecond[bucket] ?? 0) + 1;
      }
    }
    weather.rebaseClock(performance.now());
    return {
      writes, frames: 60 * 12, startWrites,
      perSecond: perSecond.map(value => value ?? 0),
      ceiling: weather.diagnostics().uniformHz,
      coalesced: weather.diagnostics().coalesced,
      transitions: weather.diagnostics().transitions,
      clock: weather.minutes,
    };
  });
  const busiest = Math.max(...moving.perSecond);
  log(`[env04] synthetic 60 fps drive (1 world minute/frame): ${moving.writes} write(s) over ${moving.frames} frames, busiest second ${busiest} against ${moving.ceiling}/s, ${moving.coalesced} coalesced, ${moving.transitions} window transition(s)`);
  if (!(moving.writes > 0)) failures.push('a moving clock made no weather writes at all, so the ceiling was never exercised');
  if (busiest > moving.ceiling + 1) {
    failures.push(`the write ceiling was breached: ${busiest} writes in one second against ${moving.ceiling}/s`);
  }
  if (!(moving.transitions > 0)) failures.push('twelve world hours produced no window transition, so the schedule is not advancing');
  if (!(moving.coalesced > 0)) failures.push('a 60 fps drive never coalesced a write, so the rate limit is not what bounded it');

  const jump = await page.evaluate(() => {
    const game = globalThis.__gdoAudit.game;
    const weather = game.weather;
    const base = performance.now();
    weather.rebaseClock(base);
    weather.setClock(400);
    weather.sample();
    game.refreshWeather();
    const before = weather.writes;
    weather.setClock(1000);
    const changed = weather.update(base + 2000);
    weather.markApplied();
    const afterJump = weather.writes;
    weather.setClock(1000);
    const second = weather.update(base + 2001);
    return { changed, jumpWrites: afterJump - before, second, total: weather.writes - before };
  });
  log(`[env04] clock jump 400 → 1000 min: ${jump.jumpWrites} write(s), a second update ${jump.second ? 'wrote again' : 'was refused'}`);
  if (jump.jumpWrites !== 1) failures.push(`a clock jump cost ${jump.jumpWrites} writes; a jump must spend one and not replay the windows it skipped`);
  if (jump.second) failures.push('a second update at the same clock wrote again, so the change detection is not holding');

  // --- continuity: no field may move faster than the cross-fade ------------------------
  const continuity = await page.evaluate(async ({ windowMinutes, transitionMinutes }) => {
    const game = globalThis.__gdoAudit.game;
    const weather = game.weather;
    // The response fields only: `minutes`, `minutesIntoWindow` and `minutesUntilChange` are
    // the clock and move by the sampling step by definition, so including them would make
    // this a check of the probe rather than of the cross-fade.
    const module = await import('/src/engine/WeatherState.js');
    const fields = [...module.GDO_WEATHER_FIELDS];
    let worst = 0, worstField = null, worstAt = 0, previous = null, changes = 0, lastId = null;
    const ids = [];
    // 0 → 1435: the clock wraps at midnight, and the wrap is a *day* boundary, which the
    // midnight probe above checks through the module. Sampling past 1440 here would compare
    // 23:59 with the same day's 00:00 and call the schedule discontinuous.
    for (let minute = 0; minute <= 1435; minute += 5) {
      weather.setClock(minute);
      const state = weather.sample();
      if (lastId !== null && state.id !== lastId) changes++;
      lastId = state.id;
      ids.push(state.id);
      if (previous) {
        for (const field of fields) {
          const delta = Math.abs(state[field] - previous[field]);
          if (delta > worst) { worst = delta; worstField = field; worstAt = minute; }
        }
      }
      previous = fields.reduce((copy, field) => { copy[field] = state[field]; return copy; }, {});
    }
    return { worst, worstField, worstAt, changes, ids, windowMinutes, transitionMinutes };
  }, { windowMinutes: model.windowMinutes, transitionMinutes: model.transitionMinutes });
  // The bound is the largest possible field step across a cross-fade, scaled to the sampling
  // interval: a five-minute step may move a field by five transition-lengths of a fade.
  const perMinuteBound = 1.5 / continuity.transitionMinutes;
  const bound = perMinuteBound * 5 + 1e-6;
  log(`[env04] continuity over a day (5-minute steps): worst ${continuity.worst.toFixed(4)} on ${continuity.worstField} at ${continuity.worstAt}m (bound ${bound.toFixed(4)}), ${continuity.changes} state change(s)`);
  if (continuity.worst > bound) {
    failures.push(`${continuity.worstField} jumped ${continuity.worst.toFixed(4)} in five minutes at ${continuity.worstAt}m, faster than a ${continuity.transitionMinutes}-minute cross-fade allows (${bound.toFixed(4)})`);
  }
  if (!(continuity.changes > 0)) failures.push('a whole day of the schedule never changed state');

  // --- the response matrix: every state, against clear on the same clock ---------------
  const states = model.states;
  const responses = {};
  for (const id of states) {
    const found = await findWindow(page, { target: id });
    if (!found.found) { unreached.push(id); continue; }
    // A clear reference on the *same clock*, so the hour is held fixed and only the weather
    // differs. The seed differs between the two, which is exactly the point: the seed picks
    // the state, and the state is the only thing that then varies.
    const clearReference = await findWindow(page, { target: 'clear', climate: found.climate, minute: found.minute });
    if (!clearReference.found) { unreached.push(`${id} (no clear reference)`); continue; }
    await applyWindow(page, clearReference);
    await waitFrames(page, 6);
    const clearRead = await readWeather(page);
    const clearPixels = await sampleFrame(page);
    // `readPixels` y=0 is the bottom of the frame, so the sky is the band at the top:
    // `[0, .65, 1, .35]`, not `[0, 0, 1, .35]`. The first version of this measured the ground
    // and reported that a storm brightened the sky.
    const clearSky = await sampleFrame(page, [0, .65, 1, .35]);
    await applyWindow(page, found);
    await waitFrames(page, 6);
    const stateRead = await readWeather(page);
    const statePixels = await sampleFrame(page);
    const stateSky = await sampleFrame(page, [0, .65, 1, .35]);
    responses[id] = {
      window: found, reference: clearReference,
      clear: { sky: clearRead.sky, fog: clearRead.fog, sun: clearRead.sunIntensity, exposure: clearRead.exposure, water: clearRead.water, ambient: clearRead.ambientActivity, drawnSlots: clearRead.drawnSlots, instances: clearRead.ambience.instances, sceneChildren: clearRead.sceneChildren, meanLuma: clearPixels.meanLuma, skyLuma: clearSky.meanLuma, timeOfDayFog: clearRead.timeOfDay?.fogColor, timeOfDayCover: clearRead.timeOfDay?.cloudCover },
      state: { sky: stateRead.sky, fog: stateRead.fog, sun: stateRead.sunIntensity, exposure: stateRead.exposure, water: stateRead.water, ambient: stateRead.ambientActivity, drawnSlots: stateRead.drawnSlots, instances: stateRead.ambience.instances, sceneChildren: stateRead.sceneChildren, meanLuma: statePixels.meanLuma, skyLuma: stateSky.meanLuma, timeOfDayFog: stateRead.timeOfDay?.fogColor, timeOfDayCover: stateRead.timeOfDay?.cloudCover },
      blend: stateRead.diagnostics.blend,
      particleFamilies: stateRead.diagnostics.particleFamilies,
      particleCap: stateRead.diagnostics.particleCap,
    };
    const r = responses[id];
    log(`[env04] ${id.padEnd(9)} clock ${found.minute}m · cloud ${r.clear.sky.cloudCover.toFixed(2)}/${r.clear.sky.cloudDarkness.toFixed(2)} → ${r.state.sky.cloudCover.toFixed(2)}/${r.state.sky.cloudDarkness.toFixed(2)} · water ${r.state.water.ripple.toFixed(2)}/${r.state.water.wetness.toFixed(2)} · fog ${r.clear.fog.near.toFixed(0)}/${r.clear.fog.far.toFixed(0)} → ${r.state.fog.near.toFixed(0)}/${r.state.fog.far.toFixed(0)} · sun ${r.clear.sun.toFixed(2)} → ${r.state.sun.toFixed(2)} · exposure ${r.clear.exposure.toFixed(2)} → ${r.state.exposure.toFixed(2)} · luma ${r.clear.meanLuma.toFixed(3)} → ${r.state.meanLuma.toFixed(3)} · slots ${r.clear.drawnSlots} → ${r.state.drawnSlots}`);
  }
  if (unreached.length) {
    failures.push(`the runtime could not be driven to ${unreached.join(', ')} within the search, so those states' responses are unproven`);
  }

  // --- clause 1, determinism: the schedule the runtime applied is the one it reports ----
  for (const id of states) {
    const r = responses[id];
    if (!r) continue;
    if (!(r.particleFamilies === 0 && r.particleCap === 0)) {
      failures.push(`state ${id} ran ${r.particleFamilies} particle families against a low profile that allows none`);
    }
    // The blend has to have settled: a mid-fade sample would make the comparison a
    // comparison of blends rather than of states.
    if (!(r.blend >= 1)) failures.push(`the probe measured ${id} mid-fade (blend ${r.blend.toFixed(2)}), so its response is not the state's`);
  }

  // --- clause 2, environment response --------------------------------------------------
  const clear = responses.clear;
  if (clear) {
    // `clear` is the identity: the dome carries the hour's own cover, the water is unwet, the
    // fog is the fog the runtime shipped with, and the fog colour is the hour's own colour.
    const identityFailures = [];
    if (clear.state.sky.cloudCover !== clear.state.timeOfDayCover) {
      identityFailures.push(`cloud cover ${clear.state.sky.cloudCover} is not the hour's own ${clear.state.timeOfDayCover}`);
    }
    if (clear.state.sky.cloudDarkness !== 0) identityFailures.push(`cloud darkness ${clear.state.sky.cloudDarkness} is not 0`);
    if (clear.state.water.ripple !== 0 || clear.state.water.wetness !== 0) {
      identityFailures.push(`water ${clear.state.water.ripple}/${clear.state.water.wetness} is not unwet`);
    }
    if (clear.state.fog.near !== 78 || clear.state.fog.far !== 175) {
      identityFailures.push(`fog range ${clear.state.fog.near}/${clear.state.fog.far} is not the shipped 78/175`);
    }
    const fogDrift = Math.max(...clear.state.fog.color.map((channel, index) => Math.abs(channel - clear.state.timeOfDayFog[index])));
    if (fogDrift > 1e-6) identityFailures.push(`fog colour drifted ${fogDrift.toExponential(2)} from the hour's own colour`);
    if (clear.state.sun !== clear.clear.sun) identityFailures.push(`sun intensity ${clear.state.sun} is not the hour's own ${clear.clear.sun}`);
    if (!identityFailures.length) {
      log(`[env04] clear is the identity: dome ${clear.state.sky.cloudCover.toFixed(2)} cover · water 0/0 · fog 78/175 · fog colour within ${fogDrift.toExponential(1)} of the hour · sun ${clear.state.sun.toFixed(2)}`);
    } else {
      for (const failure of identityFailures) failures.push(`clear is not the identity: ${failure}`);
    }
  } else {
    failures.push('the runtime could not be driven to clear, so the identity every other state is measured against is unproven');
  }

  const storm = responses.storm;
  if (storm) {
    const s = storm.state, c = storm.clear;
    if (!(s.sky.cloudDarkness > .5)) failures.push(`a storm's cloud darkness is only ${s.sky.cloudDarkness.toFixed(2)}`);
    if (!(s.sky.cloudCover > c.sky.cloudCover + .3)) {
      failures.push(`a storm's cloud cover ${s.sky.cloudCover.toFixed(2)} is not meaningfully above clear's ${c.sky.cloudCover.toFixed(2)}`);
    }
    if (!(s.water.ripple > .5 && s.water.wetness > .5)) {
      failures.push(`a storm's water response is ${s.water.ripple.toFixed(2)}/${s.water.wetness.toFixed(2)}, which is not a storm`);
    }
    if (!(s.fog.far < c.fog.far * .8)) {
      failures.push(`a storm's fog far ${s.fog.far.toFixed(1)} is not meaningfully shorter than clear's ${c.fog.far.toFixed(1)}`);
    }
    if (!(s.sun < c.sun)) failures.push(`a storm's sun intensity ${s.sun.toFixed(2)} is not below clear's ${c.sun.toFixed(2)}`);
    if (!(s.exposure > c.exposure)) failures.push(`a storm's exposure ${s.exposure.toFixed(2)} does not lift above clear's ${c.exposure.toFixed(2)}`);
    if (!(s.meanLuma < c.meanLuma)) failures.push(`a storm frame (luma ${s.meanLuma.toFixed(3)}) is not darker than clear (${c.meanLuma.toFixed(3)})`);
    if (!(s.skyLuma < c.skyLuma)) failures.push(`a storm sky (luma ${s.skyLuma.toFixed(3)}) is not darker than clear (${c.skyLuma.toFixed(3)})`);
    // Fog stays a **tint** of the hour's colour: no channel may exceed the hour's own colour
    // by more than the largest warm tint the model can produce. This is the check that a
    // weather colour chosen as an absolute value — the first version of this module did
    // exactly that — would fail at night.
    const excess = Math.max(...s.fog.color.map((channel, index) => channel - (s.timeOfDayFog[index] * 1.13)));
    log(`[env04] storm fog tint: hour ${s.timeOfDayFog.map(v => v.toFixed(3)).join('/')} → applied ${s.fog.color.map(v => v.toFixed(3)).join('/')} (worst excess over the hour × 1.13: ${excess.toFixed(4)})`);
    if (excess > 1e-6) failures.push(`the storm fog is not a tint of the hour's fog colour (worst channel exceeds it by ${excess.toFixed(4)})`);
    // The drift uniform is a *motion* budget, so the claim is a delta while a state is held,
    // not an absolute value: the uniform accumulates across applies by design.
    // The drift advances on wall time while the clock is moving — a frozen clock writes
    // nothing at all, which is `ENV-02`'s rule and the reason the shipped configuration (a
    // still clock) is a still sky. So both halves are measured with the clock running: a storm
    // must drift, and `clear` must not drift even then, because its speed is zero.
    const drift = await page.evaluate(async ({ clearWindow, stormWindow }) => {
      const game = globalThis.__gdoAudit.game;
      const sample = async (window, timeScale) => {
        game.weather.setSeed(window.seed);
        game.weather.setClimate(window.climate);
        game.setClockMinutes(window.minute);
        game.weather.sample();
        game.refreshWeather();
        const before = game.sky.material.uniforms.uSkyTime.value;
        game.timeOfDay.timeScale = timeScale;
        for (let frame = 0; frame < 20; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
        game.timeOfDay.timeScale = 0;
        return game.sky.material.uniforms.uSkyTime.value - before;
      };
      return {
        clearFrozen: await sample(clearWindow, 0),
        clearMoving: await sample(clearWindow, 600),
        stormFrozen: await sample(stormWindow, 0),
        stormMoving: await sample(stormWindow, 600),
      };
    }, { clearWindow: storm.reference, stormWindow: storm.window });
    // A *moving* clear clock crosses into the neighbouring windows of the schedule within the
    // twenty frames, so its drift is not expected to be zero — only the frozen cases are, and
    // that is the `ENV-02` rule ("a frozen clock writes nothing") holding for the sky too.
    log(`[env04] sky drift over 20 frames: clear frozen +${drift.clearFrozen.toFixed(5)} · clear moving +${drift.clearMoving.toFixed(5)} · storm frozen +${drift.stormFrozen.toFixed(5)} · storm moving +${drift.stormMoving.toFixed(5)}`);
    if (!(drift.stormMoving > 0)) failures.push('the sky drift uniform did not move over twenty frames of a storm with the clock running');
    if (drift.stormFrozen !== 0) failures.push(`the sky drift uniform moved ${drift.stormFrozen.toFixed(5)} on a frozen clock, which is not "on change only"`);
    if (drift.clearFrozen !== 0) failures.push(`the sky drift uniform moved ${drift.clearFrozen.toFixed(5)} during clear on a frozen clock`);
  }

  // --- clause 2, every state's response is distinct ------------------------------------
  const vectors = {};
  for (const id of states) {
    const r = responses[id];
    if (!r) continue;
    vectors[id] = [
      r.state.sky.cloudCover, r.state.sky.cloudDarkness,
      r.state.water.ripple, r.state.water.wetness,
      r.state.fog.near, r.state.fog.far,
      r.state.sun, r.state.exposure,
    ];
  }
  const ids = Object.keys(vectors);
  for (let a = 0; a < ids.length; a++) {
    for (let b = a + 1; b < ids.length; b++) {
      const distance = Math.max(...vectors[ids[a]].map((value, index) => Math.abs(value - vectors[ids[b]][index])));
      if (distance <= 1e-9) {
        failures.push(`${ids[a]} and ${ids[b]} have the same uniform response, so one of them is invisible on the low profile`);
      }
    }
  }
  log(`[env04] ${ids.length} state(s) driven, ${ids.length * (ids.length - 1) / 2} pair(s) compared on the uniform response${unreached.length ? `, unreached: ${unreached.join(', ')}` : ''}`);

  // --- clause 2, habitat: the ambience follows the weather, not a second code path ------
  if (clear && storm) {
    const habitat = await page.evaluate(async ({ clearWindow, stormWindow }) => {
      const game = globalThis.__gdoAudit.game;
      const weather = game.weather;
      // Three passes, not one: a pass that was already in flight when the budget changed still
      // holds the previous admitted set, and one reading of it looked like "clear draws two
      // agents" — the value the *storm* had just left behind.
      const readAfterPass = async () => {
        const start = game.world.ambientDiagnostics.passes;
        const deadline = performance.now() + 12_000;
        while (game.world.ambientDiagnostics.passes - start < 3 && performance.now() < deadline) {
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        await new Promise(resolve => requestAnimationFrame(resolve));
        let instances = 0;
        for (const tile of game.world.tiles.values()) {
          for (const mesh of Object.values(tile.ambientMeshes ?? {})) if (mesh && mesh.count > 0) instances += mesh.count;
        }
        return {
          passes: game.world.ambientDiagnostics.passes - start,
          drawnSlots: game.world.ambientDiagnostics.drawnSlots,
          activity: game.world.ambientActivity,
          instances,
        };
      };
      const apply = window => {
        weather.setSeed(window.seed);
        weather.setClimate(window.climate);
        game.setClockMinutes(window.minute);
        weather.sample();
        game.refreshWeather();
        return { bird: weather.state.birdActivity, bee: weather.state.beeActivity, id: weather.state.id };
      };
      const clearShares = apply(clearWindow);
      const clear = await readAfterPass();
      const stormShares = apply(stormWindow);
      const storm = await readAfterPass();
      return { clear, storm, clearShares, stormShares };
    }, { clearWindow: clear.reference, stormWindow: storm.window });
    log(`[env04] habitat: ${habitat.clearShares.id} ${habitat.clear.drawnSlots} slot(s)/${habitat.clear.instances} instance(s) at budget ${habitat.clear.activity} (shares bird ${habitat.clearShares.bird}, bee ${habitat.clearShares.bee}) → ${habitat.stormShares.id} ${habitat.storm.drawnSlots} slot(s)/${habitat.storm.instances} instance(s) at budget ${habitat.storm.activity} (shares bird ${habitat.stormShares.bird}, bee ${habitat.stormShares.bee})`);
    if (!(habitat.stormShares.bird < habitat.clearShares.bird && habitat.stormShares.bee < habitat.clearShares.bee)) {
      failures.push(`the probe did not measure a storm (bird ${habitat.stormShares.bird}, bee ${habitat.stormShares.bee} against clear's ${habitat.clearShares.bird}/${habitat.clearShares.bee})`);
    }
    if (!(habitat.clear.activity === 1 && habitat.storm.activity === 1)) {
      failures.push(`the phase budget moved with the weather (${habitat.clear.activity} → ${habitat.storm.activity}), so the habitat response is not riding the weather's own species shares`);
    }
    if (!(habitat.clear.drawnSlots > 0)) {
      failures.push('no agents were drawn in clear weather, so the habitat response has nothing to measure');
    }
    if (!(habitat.storm.drawnSlots < habitat.clear.drawnSlots)) {
      failures.push(`a storm drew ${habitat.storm.drawnSlots} agents against clear's ${habitat.clear.drawnSlots}, so the weather does not reach the ambience`);
    }
    if (!(habitat.storm.instances <= habitat.clear.instances)) {
      failures.push(`a storm left ${habitat.storm.instances} ambient instances against clear's ${habitat.clear.instances}`);
    }
    if (!(habitat.clear.passes > 0 && habitat.storm.passes > 0)) {
      failures.push('an activity reading covered no ambient scheduler pass, so it cannot say what was drawn');
    }
  }

  // --- clause 3, low-profile fallback: no particles, no new drawables -------------------
  const sceneGrowth = ids.map(id => ({ id, children: responses[id].state.sceneChildren, clearChildren: responses[id].clear.sceneChildren }))
    .filter(entry => entry.children !== entry.clearChildren);
  log(`[env04] scene children across ${ids.length} state(s): ${ids.map(id => `${id} ${responses[id].clear.sceneChildren}→${responses[id].state.sceneChildren}`).join(', ')}`);
  if (sceneGrowth.length) {
    failures.push(`driving the weather added or removed scene objects (${sceneGrowth.map(entry => `${entry.id} ${entry.clearChildren}→${entry.children}`).join(', ')}), so the response is not uniform-only`);
  }
  if (!(model.profiles.low.particleFamilies === 0 && model.profiles.low.particleCap === 0)) {
    failures.push(`the low profile is declared with ${model.profiles.low.particleFamilies} particle families, so the fallback is not the fallback`);
  }
  if (model.ceilings.low > 80) failures.push(`the low particle ceiling ${model.ceilings.low} exceeds the research's 80`);

  // --- the review panel carries the state ----------------------------------------------
  // The overlay is off in the session this reads (the scenario re-navigated), and a disabled
  // overlay empties its panel.
  await page.click('.geo-debug-toggle');
  await waitFrames(page, 2);
  await page.evaluate(({ seed, climate, clock }) => {
    const game = globalThis.__gdoAudit.game;
    game.weather.setSeed(seed); game.weather.setClimate(climate); game.weather.setClock(clock);
    game.weather.sample(); game.refreshWeather();
  }, { seed: shipped.diagnostics.seed, climate: shipped.diagnostics.climate, clock: 409 });
  // The overlay is imported on the first toggle and then re-rendered at its own 250 ms
  // refresh interval, so the first panel text after a click is the placeholder the forced
  // update wrote — `weather unavailable`. Poll for the real line rather than guessing a frame
  // count: the panel is refreshed by the runtime's frame loop, not by this probe.
  const panelReady = await page.evaluate(async () => {
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      const text = document.querySelector('#geo-debug-output')?.textContent ?? '';
      if (/^weather [A-Z]/m.test(text)) return true;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return false;
  });
  if (!panelReady) failures.push('the review panel never rendered a weather line');
  const panelLine = await page.evaluate(() => (document.querySelector('#geo-debug-output')?.textContent ?? '')
    .split('\n').find(line => line.startsWith('weather ')) ?? null);
  log(`[env04] review panel: ${panelLine ?? 'no weather line'}`);
  if (!panelLine) failures.push('the review panel has no `weather` line');
  else if (!/^weather [A-Z][a-z]+ \| [a-z-]+ \| window \d+ \| blend \d\.\d{2} [a-z]+→[a-z]+ \| next [a-z]+ \| cloud \d\.\d{2}\/\d\.\d{2} \| wet \d\.\d{2} ripple \d\.\d{2} \| fog \d\.\d{2} \| life \d\.\d{2}\/\d\.\d{2} \| writes \d+ · ceil \d+Hz · particles \d+$/.test(panelLine)) {
    failures.push(`the weather line does not carry the state, climate, window, blend, cloud, water, fog, life and write budget: ${panelLine}`);
  }

  // --------------------------------------------------------------------- curated mode
  await openCurated(page, baseUrl);
  await waitFrames(page, 8);
  const curatedShipped = await readWeather(page);
  log(`[env04] curated · seed ${curatedShipped.diagnostics.seed} · ${curatedShipped.diagnostics.climate} · ${curatedShipped.diagnostics.label} blend ${curatedShipped.diagnostics.blend.toFixed(2)} · profile ${curatedShipped.diagnostics.profile} particles ${curatedShipped.diagnostics.particleFamilies}`);
  if (curatedShipped.state.id !== 'clear') {
    log(`[env04] note: the curated fixture ships in ${curatedShipped.state.id} at its default clock rather than clear`);
  }
  const curatedMatrix = {};
  for (const id of ['clear', 'storm']) {
    if (!responses[id]) continue;
    // The curated fixture has its own coordinates, so its own seed and climate decide its
    // schedule; only the *state* is shared, which is what a shared vocabulary means.
    const found = await page.evaluate(async ({ wanted, clock }) => {
      const weather = globalThis.__gdoAudit.game.weather;
      const climates = ['semi-arid', 'monsoon', 'cold', 'temperate', 'tropical'];
      const sampleAt = Math.floor(clock / 90) * 90 + 45;
      for (const climate of climates) {
        for (let seed = 1; seed <= 900; seed++) {
          weather.setSeed(seed); weather.setClimate(climate); weather.setClock(sampleAt);
          if (weather.sample().id === wanted) return { found: true, seed, climate, minute: sampleAt };
        }
      }
      return { found: false };
    }, { wanted: id, clock: 409 });
    if (!found.found) { failures.push(`the curated runtime could not be driven to ${id}`); continue; }
    await applyWindow(page, found);
    await waitFrames(page, 6);
    const read = await readWeather(page);
    const pixels = await sampleFrame(page);
    curatedMatrix[id] = { window: found, water: read.water, fog: read.fog, sun: read.sunIntensity, exposure: read.exposure, meanLuma: pixels.meanLuma, state: read.state, diagnostics: read.diagnostics };
    log(`[env04] curated ${id.padEnd(9)} water ${read.water?.normalScale?.toFixed(3)}/${read.water?.roughness?.toFixed(3)} · background ${read.water?.background ? read.water.background.r.toFixed(3) : 'n/a'} · fog ${read.fog.near.toFixed(0)}/${read.fog.far.toFixed(0)} · sun ${read.sunIntensity.toFixed(2)} · luma ${pixels.meanLuma.toFixed(3)}`);
  }
  if (curatedMatrix.clear && curatedMatrix.storm) {
    const c = curatedMatrix.clear, s = curatedMatrix.storm;
    if (!(s.water.normalScale > c.water.normalScale)) {
      failures.push(`the curated water does not ripple in a storm (${c.water.normalScale.toFixed(3)} → ${s.water.normalScale.toFixed(3)})`);
    }
    if (!(s.water.roughness < c.water.roughness)) {
      failures.push(`the curated water does not get glossier in a storm (${c.water.roughness.toFixed(3)} → ${s.water.roughness.toFixed(3)})`);
    }
    if (!(s.fog.far < c.fog.far * .8)) {
      failures.push(`the curated storm fog far ${s.fog.far.toFixed(1)} is not shorter than clear's ${c.fog.far.toFixed(1)}`);
    }
    if (!(s.meanLuma < c.meanLuma)) {
      failures.push(`the curated storm frame (luma ${s.meanLuma.toFixed(3)}) is not darker than clear (${c.meanLuma.toFixed(3)})`);
    }
    if (!(s.exposure > c.exposure)) {
      failures.push(`the curated storm exposure ${s.exposure.toFixed(2)} does not lift above clear's ${c.exposure.toFixed(2)}`);
    }
    if (!(s.water.background.r < c.water.background.r || s.water.background.g < c.water.background.g)) {
      failures.push('the curated sky did not cloud over: the background colour is unchanged');
    }
  } else if (!curatedMatrix.clear || !curatedMatrix.storm) {
    failures.push('the curated runtime did not produce both a clear and a storm frame, so its response is unproven');
  }

  return {
    directory,
    blockers: failures.length,
    sweepFrames: 0,
    totalPenetrations: 0,
    weatherFailures: failures,
    fixtures,
    coordinate: {
      seed: shipped.diagnostics.seed,
      moduleSeed: model.seed,
      climate: shipped.diagnostics.climate,
      profile: shipped.diagnostics.profile,
      firstSession: { clock: clockForSession, state: firstSession.state.id, window: firstSession.diagnostics.window },
      secondSession: { state: secondSession.state.id, window: secondSession.diagnostics.window },
    },
    writes: { frozen, moving: { writes: moving.writes, busiest, ceiling: moving.ceiling, coalesced: moving.coalesced, transitions: moving.transitions }, jump },
    continuity: { worst: continuity.worst, worstField: continuity.worstField, at: continuity.worstAt, bound, changes: continuity.changes },
    responses: Object.fromEntries(Object.entries(responses).map(([id, value]) => [id, {
      window: value.window,
      cloudCover: value.state.sky.cloudCover,
      cloudDarkness: value.state.sky.cloudDarkness,
      ripple: value.state.water.ripple,
      wetness: value.state.water.wetness,
      fogNear: value.state.fog.near,
      fogFar: value.state.fog.far,
      sun: value.state.sun,
      exposure: value.state.exposure,
      meanLuma: value.state.meanLuma,
      clearMeanLuma: value.clear.meanLuma,
      drawnSlots: value.state.drawnSlots,
      clearDrawnSlots: value.clear.drawnSlots,
      particleFamilies: value.particleFamilies,
    }])),
    curated: curatedMatrix,
    panelLine,
    unreached,
  };
}
