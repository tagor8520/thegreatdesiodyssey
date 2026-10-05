import * as THREE from 'three';
import { createProceduralEngine, createProceduralLightRig, GDO_PALETTE } from '../engine/ProceduralEngine.js';
import { GeoWorld } from './GeoWorld.js';
import { GEO_QUERY_MASK } from './GeoCollision.js';
import { GeoPlayer } from './GeoPlayer.js';
import { mountTouchControls } from '../engine/TouchControls.js';
import { validateCoordinate } from './GeoMath.js';
import {
  LabelLosScheduler, compassBearing, formatMetres,
} from './GeoLabelLos.js';
import './geo.css';

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function uiMarkup() {
  return `
    <div class="geo-ui">
      <div class="geo-map-labels" aria-hidden="true"></div>
      <div class="geo-panel geo-stats">
        <strong>Coordinate Explorer <span class="geo-scale-badge">1:10 footprint scale</span></strong>
        <div class="geo-coordinates">Locating…</div>
        <div class="geo-camera-status">First-person camera · V to switch</div>
        <div class="geo-runtime">Preparing local map generator…</div>
        <div class="geo-source"></div>
      </div>
      <button class="geo-debug-toggle" type="button" aria-label="Toggle query and layer diagnostics" aria-controls="geo-debug-output" aria-pressed="false">Debug</button>
      <button class="geo-exit" type="button" aria-label="Exit coordinate explorer">Exit</button>
      <pre id="geo-debug-output" class="geo-panel geo-debug-output" hidden aria-live="polite"></pre>
      <div class="geo-panel geo-loading" role="status" aria-live="polite">
        <div class="geo-loading-title">Downloading one small vector chunk…</div>
        <div class="geo-loading-detail">Roads are generated first. Landscape and buildings follow in a background worker.</div>
      </div>
      <div class="geo-panel geo-help">WASD / arrows: move · Shift: faster · Space: jump · V: FPP/TPP · F3: debug · Click: look · Scroll: TPP zoom</div>
      <div class="geo-attribution">Map data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> ·
        <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> ·
        tiles by <a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a> ·
        <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">Fix the map</a>
      </div>
      <!-- The touch layer is rendered from the shared action registry (GME-05);
           see mountTouchControls(). Hard-coding the buttons here is what let
           curated mode ship with no touch controls at all. -->
    </div>
  `;
}

export function mountGeoGame(container, {
  latitude, longitude, onExitRequest, providers,
  // Coordinate mode runs one low-power configuration rather than a quality ladder,
  // so the dynamic-proxy cap follows the low profile (64). A future device profile
  // can pass 'balanced' or 'high' without touching the world.
  dynamicProxyProfile = 'low',
} = {}) {
  const coordinate = validateCoordinate(latitude, longitude);
  const engine = createProceduralEngine(container, {
    ariaLabel: `Procedural OpenStreetMap world at ${coordinate.latitude}, ${coordinate.longitude}`,
    canvasClass: 'geo-game-canvas',
    antialias: false,
    powerPreference: 'low-power',
    fov: 68,
    near: .02,
    far: 210,
  });
  const { canvas, overlay, renderer, scene, camera } = engine;
  overlay.innerHTML = uiMarkup();

  const coordinateElement = overlay.querySelector('.geo-coordinates');
  const runtimeElement = overlay.querySelector('.geo-runtime');
  const sourceElement = overlay.querySelector('.geo-source');
  const loadingElement = overlay.querySelector('.geo-loading');
  const loadingTitle = overlay.querySelector('.geo-loading-title');
  const loadingDetail = overlay.querySelector('.geo-loading-detail');
  const exitButton = overlay.querySelector('.geo-exit');
  const debugButton = overlay.querySelector('.geo-debug-toggle');
  const debugOutput = overlay.querySelector('.geo-debug-output');
  const uiElement = overlay.querySelector('.geo-ui');
  const cameraStatusElement = overlay.querySelector('.geo-camera-status');
  // Filled in after the registry-driven touch layer mounts, which happens with
  // the player because the layer needs the player's input object.
  let cameraButton = null;
  let touchControls = null;
  const mapLabelLayer = overlay.querySelector('.geo-map-labels');

  renderer.shadowMap.enabled = false;
  // Three r170 ignores renderOrder when sorting is disabled. The coordinate
  // scene has a bounded object count, so normal sorting is both correct for
  // transparent water and comfortably inside the low-profile budget.
  renderer.sortObjects = true;
  scene.background = new THREE.Color(GDO_PALETTE.sky);
  scene.fog = new THREE.Fog(GDO_PALETTE.fog, 78, 175);
  const lightRig = createProceduralLightRig(scene, {
    shadows: false,
    sunIntensity: 2.25,
    hemisphereIntensity: 1.0,
    scale: .32,
  });

  let disposed = false, lost = false, animationFrame = 0, initialReady = false;
  let player;
  let latestStatus = null;
  const world = new GeoWorld(scene, {
    ...coordinate,
    providers,
    materialLibrary: engine.materialLibrary,
    camera,
    viewportHeight: renderer.domElement.height || 720,
    dynamicProxyProfile,
    onStatus: status => {
      if (disposed) return;
      latestStatus = status;
      const tileTiming = status.timings?.totalMilliseconds
        ? ` · last tile ${Math.round(status.timings.totalMilliseconds)}ms (${Math.round(status.timings.buildingsMilliseconds)}ms buildings)`
        : '';
      sourceElement.textContent = `${status.provider} · ${status.biome} · ${status.resident} resident chunk${status.resident === 1 ? '' : 's'} · ${formatBytes(status.bytes)} downloaded${tileTiming}`;
      if (status.error && !status.initialReady) {
        loadingElement.hidden = false;
        loadingTitle.textContent = 'Map data could not be loaded';
        loadingTitle.classList.add('geo-error');
        loadingDetail.textContent = status.message;
      } else if (status.error) {
        loadingElement.hidden = true;
        sourceElement.textContent += ' · neighbor unavailable; will retry';
      } else if (!status.initialReady) {
        loadingElement.hidden = false;
        loadingTitle.classList.remove('geo-error');
        loadingTitle.textContent = status.roads > 0 ? 'Roads generated — growing the local world…' : 'Downloading one small vector chunk…';
        loadingDetail.textContent = `${status.roads} roads · ${status.land} land areas · ${status.water} waters · ${status.buildings} buildings generated locally`;
      }
    },
    onInitialReady: safePosition => {
      if (disposed) return;
      initialReady = true;
      player.setPosition(safePosition.x, safePosition.z);
      player.enabled = true;
      loadingElement.hidden = true;
      canvas.tabIndex = 0; canvas.focus({ preventScroll: true });
    },
  });
  const updateCameraUI = mode => {
    const firstPerson = mode === 'first-person';
    cameraStatusElement.textContent = `${firstPerson ? 'First' : 'Third'}-person camera · V to switch`;
    if (cameraButton) {
      cameraButton.textContent = firstPerson ? 'TPP' : 'FPP';
      cameraButton.setAttribute('aria-label', `Switch to ${firstPerson ? 'third' : 'first'}-person camera`);
    }
  };
  player = new GeoPlayer(scene, camera, canvas, world, {
    onCameraModeChange: updateCameraUI,
    // Declared here, invoked by the registry's `debug` action.
    onDebugToggle: () => toggleDebug(),
  });
  // `GME-05`: the touch layer is rendered from the shared action registry rather
  // than hard-coded in `uiMarkup()`, so the controls a player sees are exactly the
  // actions this runtime declares.
  touchControls = mountTouchControls({ runtime: 'coordinates', container: overlay, input: player.input });
  cameraButton = touchControls.root.querySelector('[data-action="camera"]');
  const touchControlsEnabled = touchControls.mobile;
  uiElement.classList.toggle('geo-mobile', touchControlsEnabled);
  updateCameraUI();
  let debugOverlay = null, debugRequested = false, debugLoad = null, debugLoadFailed = false;
  const updateDebugButton = () => {
    debugButton.setAttribute('aria-pressed', String(debugRequested && Boolean(debugOverlay)));
    debugButton.textContent = debugRequested ? (debugOverlay ? 'Debug on' : 'Debug…') : 'Debug';
  };
  const setDebugEnabled = enabled => {
    debugRequested = Boolean(enabled);
    if (!debugRequested) {
      debugOverlay?.setEnabled(false);
      updateDebugButton();
      return;
    }
    if (debugOverlay) {
      debugOverlay.setEnabled(true);
      debugOverlay.update(world, player.position, renderer, performance.now(), true);
      updateDebugButton();
      return;
    }
    updateDebugButton();
    if (debugLoadFailed) return;
    debugLoad ??= import('./GeoDebugOverlay.js').catch(error => {
      debugLoadFailed = true;
      debugRequested = false;
      debugButton.title = `Debug overlay unavailable: ${error?.message || error}`;
      updateDebugButton();
      console.warn('Debug overlay unavailable', error);
      return null;
    });
    void debugLoad.then(module => {
      if (!module || disposed || !debugRequested || debugOverlay) return;
      debugOverlay = new module.GeoDebugOverlay(scene, debugOutput);
      debugOverlay.setEnabled(true);
      debugOverlay.update(world, player.position, renderer, performance.now(), true);
      updateDebugButton();
    });
  };
  const toggleDebug = event => {
    event?.preventDefault();
    event?.stopPropagation();
    setDebugEnabled(!(debugRequested && (debugOverlay?.enabled ?? true)));
  };
  // The `F3` binding lives in the action registry, not here: `ActionInput` resolves
  // the code and calls `onDebugToggle`, which is the same `toggleDebug` the button
  // uses. One keymap, one handler, two surfaces.
  debugButton.addEventListener('click', toggleDebug);
  let initialDebug = false;
  try { initialDebug = new URLSearchParams(window.location.search).get('debug') === '1'; } catch { /* optional */ }
  setDebugEnabled(initialDebug);

  const projectedLabel = new THREE.Vector3();
  const labelElements = [];
  let displayedLabels = [], nextLabelRefresh = 0;
  let nearestPlace = null;
  // `GME-04`: the DOM label layer does not take part in WebGL depth, so a name
  // would otherwise draw straight through the building in front of it. The
  // scheduler is budgeted per the layering research (20 tests/second and 5 labels
  // at the low profile) and asks only for `LOS_BLOCKER`, so a pickup or a bird
  // between the eye and a name cannot blank it.
  const labelLos = new LabelLosScheduler({
    profile: 'low',
    sweep: (x, y, z, dx, dy, dz, radius, out, mask) => world.sweepSphere(x, y, z, dx, dy, dz, radius, out, mask),
  });
  const updateMapLabels = now => {
    if (now >= nextLabelRefresh) {
      displayedLabels = world.visibleLabels;
      nextLabelRefresh = now + 250;
    }
    const labels = displayedLabels;
    while (labelElements.length < labels.length) {
      const element = document.createElement('span');
      element.className = 'geo-map-label';
      mapLabelLayer.append(element);
      labelElements.push(element);
    }
    const occupied = [];
    const losCandidates = [];
    nearestPlace = null;
    const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    for (let index = 0; index < labelElements.length; index++) {
      const element = labelElements[index], label = labels[index];
      if (!label) {
        element.hidden = true;
        if (element.dataset.label !== undefined) { delete element.dataset.label; delete element.dataset.los; }
        continue;
      }
      const distance = Math.hypot(label.x - player.position.x, label.z - player.position.z);
      const labelOffset = label.kind === 'place' ? 1.25 : label.kind === 'poi' ? .72 : label.kind === 'water' ? .28 : .42;
      projectedLabel.set(label.x, (label.y ?? 0) + labelOffset, label.z).project(camera);
      const screenX = (projectedLabel.x * .5 + .5) * width;
      const screenY = (-projectedLabel.y * .5 + .5) * height;
      let visible = projectedLabel.z > -1 && projectedLabel.z < 1 &&
        Math.abs(projectedLabel.x) < 1.06 && Math.abs(projectedLabel.y) < 1.06 && distance < 72;
      if (visible && occupied.some(position => Math.abs(position.x - screenX) < 96 && Math.abs(position.y - screenY) < 28)) visible = false;
      // Occlusion is checked only for labels that are otherwise on screen and not
      // overlapped: the budget is spent on names a player is about to read, and a
      // label outside the frustum needs no ray at all.
      if (visible) losCandidates.push({ key: label.name, x: label.x, y: (label.y ?? 0) + labelOffset, z: label.z });
      const occluded = visible && labelLos.isHidden(label.name);
      if (occluded) visible = false;
      element.hidden = !visible;
      if (!visible) {
        // `data-los` is the diagnostic the research asks for on a hidden label; the
        // browser gate reads it, and the overlay line reports the aggregate.
        if (occluded) element.dataset.los = 'blocked';
        else delete element.dataset.los;
        continue;
      }
      delete element.dataset.los;
      occupied.push({ x: screenX, y: screenY });
      element.textContent = label.name;
      element.dataset.kind = label.kind;
      // The name is the label's identity in the DOM: the gate needs to address a
      // specific name, and a devtools reader should not have to match pixels.
      if (element.dataset.label !== label.name) element.dataset.label = label.name;
      element.style.transform = `translate3d(${screenX}px, ${screenY}px, 0) translate(-50%, -50%)`;
      element.style.opacity = String(Math.min(1, Math.max(.35, 1 - distance / 90)));
      if (nearestPlace === null || distance < nearestPlace.distance) {
        nearestPlace = { name: label.name, kind: label.kind, distance, x: label.x, z: label.z };
      }
    }
    // One scheduler pass per label refresh, over the candidates that survived the
    // frustum and overlap gates. The camera position is the eye of every ray.
    labelLos.retain(losCandidates.map(candidate => candidate.key));
    labelLos.update(losCandidates, camera.position, now);
  };

  const exit = () => onExitRequest?.();
  exitButton.addEventListener('click', exit);

  const maximumPixelRatio = touchControlsEnabled ? .72 : .85;
  const minimumPixelRatio = touchControlsEnabled ? .5 : .6;
  let pixelRatioLimit = maximumPixelRatio;
  const resize = () => {
    if (disposed) return;
    const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    renderer.setPixelRatio(Math.max(minimumPixelRatio, Math.min(window.devicePixelRatio || 1, 1) * pixelRatioLimit));
    renderer.setSize(width, height, false);
    camera.aspect = width / height; camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize); observer.observe(container); resize();

  const targetFrameInterval = 1000 / 30;
  let lastFrame = performance.now(), sampleStart = lastFrame, sampleFrames = 0;
  let slowSamples = 0, recoverySamples = 0;
  let sampleCpuMilliseconds = 0, worstFrameGap = 0, longTaskCount = 0;
  const longTaskObserver = typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ? new PerformanceObserver(entries => { longTaskCount += entries.getEntries().length; })
    : null;
  longTaskObserver?.observe({ type: 'longtask', buffered: false });
  const frame = now => {
    if (disposed || lost) return;
    animationFrame = requestAnimationFrame(frame);
    if (document.hidden || now - lastFrame < targetFrameInterval - 1) return;
    const frameGap = now - lastFrame;
    const dt = Math.min(frameGap / 1000, .1);
    const cpuStart = performance.now();
    lastFrame = now;
    player.update(dt);
    world.update(player.position, camera, renderer.domElement.height, now);
    debugOverlay?.update(world, player.position, renderer, now, { labels: labelLos.diagnostics(now) });
    renderer.render(scene, camera);
    updateMapLabels(now);
    sampleCpuMilliseconds += performance.now() - cpuStart;
    worstFrameGap = Math.max(worstFrameGap, frameGap);
    sampleFrames++;

    if (now - sampleStart >= 1000) {
      const fps = sampleFrames * 1000 / (now - sampleStart);
      const location = world.coordinateAt(player.position.x, player.position.z);
      // `GME-04`'s "richer map" half: the coordinate readout says where the nearest
      // named place is, not only where the player is. The bearing comes from the
      // latitude/longitude pair — the authority on orientation — rather than from
      // world axes, so it cannot disagree with the numbers printed beside it.
      let nearest = '';
      if (nearestPlace) {
        const target = world.coordinateAt(nearestPlace.x, nearestPlace.z);
        const bearing = compassBearing(location.latitude, location.longitude, target.latitude, target.longitude);
        nearest = ` · ${nearestPlace.kind === 'water' ? 'water' : 'nearest'} ${nearestPlace.name} ${formatMetres(bearing.metres)} ${bearing.point}`;
      }
      coordinateElement.textContent = `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}${nearest}`;
      const averageCpu = sampleFrames ? sampleCpuMilliseconds / sampleFrames : 0;
      const queries = world.queryDiagnostics;
      runtimeElement.textContent = `${Math.round(fps)} FPS · ${averageCpu.toFixed(1)}ms CPU · ${Math.round(worstFrameGap)}ms worst · ${renderer.info.render.calls} calls · ${Math.round(renderer.info.render.triangles / 1000)}k tris · ${renderer.info.memory.geometries} geo · ${longTaskCount} stalls · q ${queries.sweeps}/${queries.sphereSweeps} sweeps · ${queries.maxCandidates} max collision · ${queries.maxSupportCandidates} max support · ${queries.groundRejects} ground rejects · ${queries.depenetrations} recoveries · label LOS ${labelLos.counters.tests}/${labelLos.counters.hidden} hidden ${labelLos.counters.blockedNow} now · ${latestStatus?.roads ?? 0} roads · ${latestStatus?.buildings ?? 0} buildings · ${latestStatus?.decorations ?? 0} details · ${latestStatus?.labels ?? 0} names${latestStatus?.truncated ? ' · safety cap reached' : ''}`;
      // Ignore samples contaminated by a tab/screenshot stall, and require
      // sustained slowness before reallocating the drawing buffer.
      const stableSample = worstFrameGap < 100;
      if (initialReady && stableSample && fps < 24 && pixelRatioLimit > minimumPixelRatio) {
        slowSamples++;
        recoverySamples = 0;
        if (slowSamples >= 3) {
          pixelRatioLimit = Math.max(minimumPixelRatio, pixelRatioLimit - .1);
          slowSamples = 0;
          resize();
        }
      } else if (stableSample && fps > 29 && pixelRatioLimit < maximumPixelRatio) {
        slowSamples = 0;
        recoverySamples++;
        if (recoverySamples >= 8) {
          pixelRatioLimit = Math.min(maximumPixelRatio, pixelRatioLimit + .05);
          recoverySamples = 0;
          resize();
        }
      } else {
        if (stableSample) slowSamples = 0;
        recoverySamples = 0;
      }
      sampleStart = now;
      sampleFrames = 0;
      sampleCpuMilliseconds = 0;
      worstFrameGap = 0;
    }
  };

  const visibility = () => {
    lastFrame = sampleStart = performance.now();
    sampleFrames = 0;
    sampleCpuMilliseconds = 0;
    worstFrameGap = 0;
    player.input.clear();
    player.blur();
  };
  const contextLost = event => {
    event.preventDefault(); lost = true; cancelAnimationFrame(animationFrame); player.blur();
  };
  const contextRestored = () => {
    world.plantRenderPools.handleContextRestored();
    world.streetFurniturePools.handleContextRestored();
    lost = false; resize(); lastFrame = performance.now(); animationFrame = requestAnimationFrame(frame);
  };
  document.addEventListener('visibilitychange', visibility);
  canvas.addEventListener('webglcontextlost', contextLost);
  canvas.addEventListener('webglcontextrestored', contextRestored);
  animationFrame = requestAnimationFrame(frame);

  return {
    scene, camera, renderer, world, player,
    // `FND-08`: the world is the coordinate domain; exposing it under this name
    // lets the shared probe address both runtimes the same way.
    domain: world,
    // `GME-04`: the label layer's own diagnostics — the LOS profile, the tests and
    // hidden counts, the newest blocker with its ray, and the update age. Exposed
    // because the gate has to compare the DOM's verdict against the scheduler's.
    get labelDiagnostics() { return { ...labelLos.diagnostics(performance.now()), nearest: nearestPlace }; },
    get labelScheduler() { return labelLos; },
    // The collision vocabulary the label ray is filtered by. An audit that wants to
    // reproduce the label query must ask for the *same* mask rather than hard-coding
    // a bit, so the mask is part of the runtime's public surface.
    get queryMasks() { return GEO_QUERY_MASK; },
    get debugOverlay() { return debugOverlay; },
    dispose() {
      if (disposed) return; disposed = true;
      cancelAnimationFrame(animationFrame); observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);

      debugButton.removeEventListener('click', toggleDebug);
      canvas.removeEventListener('webglcontextlost', contextLost); canvas.removeEventListener('webglcontextrestored', contextRestored);
      exitButton.removeEventListener('click', exit);
      touchControls.dispose();
      longTaskObserver?.disconnect();
      debugOverlay?.dispose(); player.dispose(); world.dispose(); lightRig.dispose(); engine.dispose();
    },
  };
}
