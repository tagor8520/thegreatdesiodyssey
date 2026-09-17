import React from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { createProceduralEngine } from '../engine/ProceduralEngine.js';
import { GameUI, createUIStore } from './GameUI.jsx';
import { BiomeManager } from './BiomeManager.js';
import { Environment } from './Environment.js';
import { Player } from './Player.js';
import { BridgeManager } from './BridgeManager.js';
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
  const player = new Player(scene, camera, bridges, {
    canvas,
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

  const hoardings = new HoardingManager(scene, { textureScale: profile.signTextureScale });
  bridges.cameraBlockers.push(...hoardings.cameraBlockers);
  let environment = new Environment({
    scene,
    renderer,
    camera,
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
    store.set({ started: false, cameraHint: 'Click to look · Scroll to zoom' });
  };
  ui.render(<GameUI store={store} onSelect={onSelect} onStart={onStart} onExit={onExit} onToggleSound={onToggleSound} />);
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
    environment.update(seconds);
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
      ambientOcclusion: profile.ambientOcclusion,
      environmentMap: profile.environmentMap,
      shadows: profile.shadows,
      shadowMapSize: profile.shadowMapSize,
      pixelRatio: profile.pixelRatio,
      fogNear: profile.fogNear,
      fogFar: profile.fogFar,
    });
    resize(); lost = false; resetSampling(); animationFrame = requestAnimationFrame(frame);
  };
  canvas.addEventListener('webglcontextlost', contextLost);
  canvas.addEventListener('webglcontextrestored', contextRestored);
  document.addEventListener('visibilitychange', resetSampling);
  animationFrame = requestAnimationFrame(frame);

  return {
    scene, camera, biomes, store, player, bridges, items, hoardings, sound, profile,
    dispose() {
      if (disposed) return; disposed = true;
      cancelAnimationFrame(animationFrame); observer.disconnect(); unsubscribePing?.();
      document.removeEventListener('visibilitychange', resetSampling);
      canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('webglcontextrestored', contextRestored);
      ui.unmount(); sound.dispose(); player.dispose(); items.dispose(); hoardings.dispose();
      bridges.dispose(); biomes.dispose(); environment.dispose(); engine.dispose();
    },
  };
}
