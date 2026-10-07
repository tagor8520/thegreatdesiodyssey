import React from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { createProceduralEngine } from '../engine/ProceduralEngine.js';
import { GameUI, ITEMS, createUIStore } from './GameUI.jsx';
import { BiomeManager, LANDMARKS } from './BiomeManager.js';
import { Environment } from './Environment.js';
import { Player } from './Player.js';
import { BridgeManager } from './BridgeManager.js';
import { createCuratedDomain } from './CuratedDomain.js';
import { mountTouchControls } from '../engine/TouchControls.js';
import { TimeOfDay } from '../engine/TimeOfDay.js';
import {
  WeatherState, climateForLatitude, weatherSeedForCoordinate,
} from '../engine/WeatherState.js';
import { DiscoveryJournal } from '../engine/DiscoveryJournal.js';
import '../engine/touch-controls.css';
import { HoardingManager } from './HoardingManager.js';
import { ItemManager } from './ItemManager.js';
import { GameAudio } from './GameAudio.js';
import { resolveQuality } from './Quality.js';
import { configureVoxelRendering } from './VoxelBatch.js';

/**
 * Mount into a sized container. Transport ownership stays with the caller.
 * `quality` accepts auto, low, balanced, high, or a complete custom profile.
 * `initialStarted` lets the lightweight app shell enter gameplay after lazy import.
 */
export function mountReferenceGame(container, {
  getWorldTime,
  subscribePing,
  onSelect,
  onExitRequest,
  quality = 'auto',
  initialStarted = false,
} = {}) {
  const profile = resolveQuality(quality);
  configureVoxelRendering({
    castShadow: profile.voxelShadows,
    receiveShadow: profile.shadows,
    materialDetail: profile.name ?? 'low',
  });

  const engine = createProceduralEngine(container, {
    ariaLabel: 'The Great Desi Odyssey three-state world',
    antialias: profile.antialias,
    powerPreference: profile.powerPreference,
    fov: 42,
    near: 1,
    far: profile.cameraFar,
  });
  const { canvas, overlay, scene, renderer, camera } = engine;
  // Keep statistics for all passes in the current frame; reset explicitly below.
  renderer.info.autoReset = false;
  const biomes = new BiomeManager(scene, {
    loadRadius: profile.loadRadius,
    unloadRadius: profile.unloadRadius,
    budgetMs: profile.streamBudgetMs,
    decorationDensity: profile.decorationDensity,
  });
  const bridges = new BridgeManager(scene, { cameraBlockers: biomes.cameraBlockers });
  const store = createUIStore();
  // `FND-08`: the curated runtime gets its domain explicitly at mount, so the
  // interface it is driven through is a construction decision and not an
  // assumption about what a `bridges` object happens to expose.
  const domain = createCuratedDomain({ bridges, worldScene: scene });
  // `GME-05`: the inventory has exactly one entry point. The keyboard reaches it
  // through `ActionInput` → `Player.onAction` → here, and the on-screen buttons in
  // `GameUI` call the same function, so the two surfaces cannot disagree.
  const selectSlot = slot => {
    store.set({ selected: slot });
    onSelect?.(ITEMS[slot]);
  };
  const player = new Player(scene, camera, bridges, {
    canvas,
    domain,
    onSelectSlot: selectSlot,
    onCameraHint: cameraHint => store.set({ cameraHint }),
    orbitOptions: {
      overviewGlobal: profile.overviewGlobal,
      overviewHeight: profile.overviewHeight,
      overviewDistance: profile.overviewDistance,
    },
    castShadow: profile.shadows,
  });
  player.enabled = false; player.root.visible = false; player.orbit.mapMode = true;
  player.orbit.update(0, player.position, true);
  // `GME-05`: the curated runtime had no touch controls at all, so it could not be
  // played on a phone. The layer is rendered from the shared action registry, the
  // same one the coordinate runtime uses, so the two modes expose the same actions.
  const touch = mountTouchControls({ runtime: 'curated', container, input: player.input });
  // Two separate questions: is this a touch device, and has the player started?
  // The controls are only useful during play, and a joystick drawn across the
  // landing page would be both useless and in the way. Keeping them separate also
  // means a desktop browser never gets them, whatever the start state.
  const touchDevice = touch.mobile;
  touch.setMobile(false);

  const hoardings = new HoardingManager(scene, { textureScale: profile.signTextureScale });
  bridges.cameraBlockers.push(...hoardings.cameraBlockers);
  // `ENV-02`: the curated world is stylised and not coordinate-driven, so it uses a
  // fixed reference point rather than pretending to a real ephemeris. What the two modes
  // share is the *state contract* — the same colours, the same phase names, the same
  // bounded write rule — not the same sky.
  // `GME-06`: the curated world's named places. Derived from the landmark vocabulary the
  // scene is built from (`BiomeManager.LANDMARKS`) rather than invented here, so a rename in
  // the world builder cannot leave the journal naming a place that no longer exists.
  const discoveryJournal = new DiscoveryJournal();
  const curatedPlaces = Object.entries(LANDMARKS).map(([name, [x, z]]) => ({
    name: name.charAt(0).toUpperCase() + name.slice(1),
    kind: 'landmark',
    x,
    z,
    radius: 12,
  }));
  const timeOfDay = new TimeOfDay({
    profile: profile.name === 'high' ? 'high' : profile.name === 'balanced' ? 'balanced' : 'low',
    latitude: 20.5,
    longitude: 78.9,
    dayOfYear: 172,
    timeScale: 0,
  });
  // `ENV-04`: the curated world's weather. The fixture sits at 20.5°N, so its macro climate is
  // the monsoon band in summer and the dry band either side of it, and the seed comes from the
  // coordinate like the coordinate runtime's does — the same state machine, seeded the same
  // way, so a reviewer sees the same vocabulary of skies in both modes. The curve is `clear`
  // at this clock, which is the point: the shipped frame is the frame the world had before the
  // weather existed, and a caller has to move the clock or the climate to see anything else.
  const weather = new WeatherState({
    profile: profile.name === 'high' ? 'high' : profile.name === 'balanced' ? 'balanced' : 'low',
    seed: weatherSeedForCoordinate({ latitude: 20.5, longitude: 78.9, provider: 'curated' }),
    climate: climateForLatitude(20.5, 172),
    minutes: timeOfDay.minutes,
    day: timeOfDay.dayOfYear,
  });
  let environment = new Environment({
    scene,
    renderer,
    camera,
    timeOfDay,
    weather,
    environmentScale: 1,
    ambientOcclusion: profile.ambientOcclusion,
    environmentMap: profile.environmentMap,
    shadows: profile.shadows,
    shadowMapSize: profile.shadowMapSize,
    pixelRatio: profile.pixelRatio,
    fogNear: profile.fogNear,
    fogFar: profile.fogFar,
    materialLibrary: engine.materialLibrary,
    materialDetail: profile.name ?? 'low',
  });
  const ui = createRoot(overlay);
  const sound = new GameAudio();
  const items = new ItemManager(scene, {
    activeRadius: profile.itemRadius,
    initialFocus: player.position,
    onCollect: item => {
      store.set({ score: item.score, collected: item.collected, lastPickup: `${item.name} +${item.points}` });
      sound.pickup(item.points);
    },
  });
  store.set({ total: items.total, quality: profile.label, renderScale: renderer.getPixelRatio() });

  const onStart = () => {
    if (store.getSnapshot().started) return;
    void sound.unlock().then(ok => { if (!sound.disposed && !ok) store.set({ soundEnabled: false }); });
    player.blur(); player.enabled = true; player.root.visible = true; player.orbit.mapMode = false;
    touch.setMobile(touchDevice);
    player.input.clear();
    store.set({ started: true }); canvas.tabIndex = 0; canvas.focus({ preventScroll: true });
  };
  const onToggleSound = () => {
    const enabled = !store.getSnapshot().soundEnabled;
    sound.setMuted(!enabled); store.set({ soundEnabled: enabled });
    if (enabled) void sound.unlock().then(ok => { if (!sound.disposed && !ok) store.set({ soundEnabled: false }); });
  };
  const onExit = () => {
    if (!store.getSnapshot().started) return;
    player.blur(); player.orbit.release();
    if (onExitRequest) {
      onExitRequest();
      return;
    }
    player.enabled = false; player.root.visible = false;
    player.mapMode = false; player.orbit.mapMode = true;
    touch.setMobile(false);
    store.set({ started: false, cameraHint: 'Click to look · Scroll to zoom' });
  };
  ui.render(<GameUI store={store} onSelectSlot={selectSlot} onStart={onStart} onExit={onExit} onToggleSound={onToggleSound} />);
  if (initialStarted) onStart();

  const unsubscribePing = subscribePing?.(rtt => {
    store.set({ pingMs: Number.isFinite(rtt) && rtt >= 0 ? rtt : null });
  });
  const resize = () => environment.resize(container.clientWidth, container.clientHeight);
  const observer = new ResizeObserver(resize); observer.observe(container); resize();

  const startedAt = performance.now();
  const frameInterval = 1000 / profile.targetFps;
  let lastFrame = startedAt, sampleStart = startedAt, frames = 0;
  let disposed = false, lost = false, animationFrame = 0;
  let slowSamples = 0, fastSamples = 0;
  const mapFocus = new THREE.Vector3(0, 0, -7);

  const adaptResolution = fps => {
    if (!profile.adaptiveResolution) return;
    if (fps < profile.targetFps * .82) {
      slowSamples++; fastSamples = 0;
      if (slowSamples >= 2 && environment.pixelRatio > profile.minPixelRatio) {
        environment.setPixelRatioLimit(Math.max(profile.minPixelRatio, environment.pixelRatio - .1));
        slowSamples = 0;
      }
    } else if (fps > profile.targetFps * .96) {
      fastSamples++; slowSamples = 0;
      if (fastSamples >= 8 && environment.pixelRatio < profile.pixelRatio) {
        environment.setPixelRatioLimit(Math.min(profile.pixelRatio, environment.pixelRatio + .05));
        fastSamples = 0;
      }
    } else {
      slowSamples = fastSamples = 0;
    }
  };

  const frame = now => {
    if (disposed || lost) return;
    animationFrame = requestAnimationFrame(frame);
    if (document.hidden || now - lastFrame < frameInterval - 1) return;

    const delta = Math.min((now - lastFrame) / 1000, .1); lastFrame = now;
    const seconds = getWorldTime ? getWorldTime() : (now - startedAt) / 1000;
    const startedPlaying = store.getSnapshot().started;
    if (startedPlaying) {
      player.update(delta);
      items.update(seconds, player.bounds);
    } else {
      player.orbit.update(delta, player.position);
    }
    const overviewFocus = profile.overviewGlobal ? mapFocus : player.position;
    biomes.update(!startedPlaying || player.mapMode ? overviewFocus : player.position, seconds);
    // `GME-06`: the curated world's named places are the two landmarks the scene is built
    // around, so the journal here records the same kind of event as the coordinate runtime
    // records from streamed map labels — the player walked into a named place. The list is
    // fixed and tiny, so there is nothing to stream and nothing to allocate per frame.
    discoveryJournal.update(player.position, curatedPlaces, { now });
    environment.update(seconds, now);
    renderer.info.reset();
    environment.render(delta);
    frames++;

    if (now - sampleStart >= 500) {
      const fps = frames * 1000 / (now - sampleStart);
      adaptResolution(fps);
      store.set({
        fps,
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        residentChunks: biomes.chunks.size,
        renderScale: renderer.getPixelRatio(),
      });
      frames = 0; sampleStart = now;
    }
  };

  const resetSampling = () => {
    lastFrame = sampleStart = performance.now(); frames = 0; slowSamples = fastSamples = 0;
    store.set({ fps: null });
    if (document.hidden) player.blur();
  };
  const contextLost = event => {
    event.preventDefault(); lost = true; cancelAnimationFrame(animationFrame); player.blur(); resetSampling();
  };
  const contextRestored = () => {
    environment.dispose();
    environment = new Environment({
      scene, renderer, camera,
      // Restoring the context restores the same environment, clocks included — a restored
      // runtime without its time-of-day or weather state would quietly be a different world.
      timeOfDay,
      weather,
      ambientOcclusion: profile.ambientOcclusion,
      environmentMap: profile.environmentMap,
      shadows: profile.shadows,
      shadowMapSize: profile.shadowMapSize,
      pixelRatio: profile.pixelRatio,
      fogNear: profile.fogNear,
      fogFar: profile.fogFar,
      materialLibrary: engine.materialLibrary,
      materialDetail: profile.name ?? 'low',
    });
    resize(); lost = false; resetSampling(); animationFrame = requestAnimationFrame(frame);
  };
  canvas.addEventListener('webglcontextlost', contextLost);
  canvas.addEventListener('webglcontextrestored', contextRestored);
  document.addEventListener('visibilitychange', resetSampling);
  animationFrame = requestAnimationFrame(frame);

  return {
    scene, camera, biomes, store, player, bridges, items, hoardings, sound, profile, domain, touch,
    // `GME-06`: the same journal surface the coordinate runtime exposes. The gate drives it
    // through the runtime's own object rather than a copy of it.
    get discoveryJournal() { return discoveryJournal; },
    get discoveries() { return discoveryJournal.diagnostics(); },
    get visiblePlaces() { return curatedPlaces.map(entry => ({ ...entry })); },
    // `ENV-02`: the same diagnostics surface the coordinate runtime exposes, so a gate can
    // ask both runtimes the same question.
    get timeOfDay() { return timeOfDay; },
    // The environment is exposed so the audit can see how many environment maps were
    // built — the bounded-work half of the `ENV-02` claim on this runtime.
    get environment() { return environment; },
    get timeOfDayDiagnostics() { return environment.timeOfDayDiagnostics; },
    // `ENV-04`: the same weather surface the coordinate runtime exposes, so one scenario can
    // drive both modes. `weatherState` is a copy; `weather` is the live model, for a gate that
    // needs to stand the world in a climate instead of waiting for a season to pass.
    get weather() { return weather; },
    get weatherState() { return { ...weather.state }; },
    get weatherDiagnostics() { return environment.weatherDiagnostics; },
    /** Re-sample and re-apply at the current clock, bypassing the rate ceiling. */
    refreshWeather() {
      weather.sample();
      environment.applyWeather();
      return { ...weather.state };
    },
    /** Set the clock in minutes and apply immediately, bypassing the rate ceiling. */
    setClockMinutes(minutes) {
      timeOfDay.setClock(minutes);
      timeOfDay.sample();
      weather.setClock(minutes, timeOfDay.dayOfYear);
      weather.sample();
      environment.applyTimeOfDay({ regenerateEnvironment: true });
      return environment.timeOfDayDiagnostics;
    },
    dispose() {
      if (disposed) return; disposed = true;
      cancelAnimationFrame(animationFrame); observer.disconnect(); unsubscribePing?.();
      document.removeEventListener('visibilitychange', resetSampling);
      canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('webglcontextrestored', contextRestored);
      ui.unmount(); touch.dispose(); sound.dispose(); player.dispose(); items.dispose(); hoardings.dispose();
      bridges.dispose(); biomes.dispose(); environment.dispose(); engine.dispose();
    },
  };
}
