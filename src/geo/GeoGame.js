import * as THREE from 'three';
import { createProceduralEngine, createProceduralLightRig, GDO_PALETTE } from '../engine/ProceduralEngine.js';
import { GeoWorld } from './GeoWorld.js';
import { GeoPlayer, cameraNearPlaneSweepRadius } from './GeoPlayer.js';
import { FlexibleJoystick, shouldUseTouchControls } from './GeoControls.js';
import { validateCoordinate } from './GeoMath.js';
import { LifecycleLedger } from '../engine/LifecycleContract.js';
import { createDebugLogger, installDebugHooks } from '../engine/DebugHooks.js';
import { createMovementAuditRunner } from '../engine/MovementAudit.js';
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
      <div class="geo-touch" aria-label="Touch controls" aria-hidden="true">
        <div class="geo-joystick-zone" aria-label="Flexible movement joystick">
          <div class="geo-joystick-hint"><span></span>MOVE</div>
          <div class="geo-joystick-base"><div class="geo-joystick-knob"></div></div>
        </div>
        <div class="geo-look-hint">DRAG TO LOOK</div>
        <div class="geo-actions">
          <button data-hold-action="run" aria-label="Hold to move faster">RUN</button>
          <button data-tap-action="camera" aria-label="Switch to third-person camera">TPP</button>
          <button class="geo-jump" data-hold-action="jump" aria-label="Jump">JUMP</button>
        </div>
      </div>
    </div>
  `;
}

export function mountGeoGame(container, { latitude, longitude, onExitRequest, providers, profile, debugHooks = true } = {}) {
  const coordinate = validateCoordinate(latitude, longitude);
  // `FND-07`: one ledger owns this mount. The engine, the world, every pool, the
  // DOM listeners below, and the debug hook all register in it, so `dispose()`
  // is provable and a remount cannot silently leak.
  const lifecycle = new LifecycleLedger({ label: 'coordinate-game' });
  const logger = createDebugLogger({ tag: 'gdo', level: 'debug' });
  logger.info('lifecycle', 'mount requested', { latitude: coordinate.latitude, longitude: coordinate.longitude, profile: profile ?? 'low' });
  const engine = createProceduralEngine(container, {
    ledger: lifecycle,
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
  const cameraButton = overlay.querySelector('[data-tap-action="camera"]');
  const mapLabelLayer = overlay.querySelector('.geo-map-labels');
  const touchElement = overlay.querySelector('.geo-touch');
  const joystickZone = overlay.querySelector('.geo-joystick-zone');
  const joystickBase = overlay.querySelector('.geo-joystick-base');
  const joystickKnob = overlay.querySelector('.geo-joystick-knob');
  const touchControlsEnabled = shouldUseTouchControls(window);
  uiElement.classList.toggle('geo-mobile', touchControlsEnabled);
  touchElement.setAttribute('aria-hidden', String(!touchControlsEnabled));

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
    // MAP-09 storage ceilings follow the active quality profile; the world keeps
    // the low ceiling when no profile is supplied.
    profile,
    materialLibrary: engine.materialLibrary,
    camera,
    viewportHeight: renderer.domElement.height || 720,
    ledger: lifecycle,
    onStatus: status => {
      if (disposed) return;
      latestStatus = status;
      const tileTiming = status.timings?.totalMilliseconds
        ? ` · last tile ${Math.round(status.timings.totalMilliseconds)}ms (${Math.round(status.timings.buildingsMilliseconds)}ms buildings)`
        : '';
      const cacheNote = status.tileCacheServed
        ? ` · ${status.tileCacheServed} chunk${status.tileCacheServed === 1 ? '' : 's'} from cache` : '';
      sourceElement.textContent = `${status.provider} · ${status.biome} · ${status.resident} resident chunk${status.resident === 1 ? '' : 's'} · ${formatBytes(status.bytes)} downloaded${cacheNote}${tileTiming}`;
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
    cameraButton.textContent = firstPerson ? 'TPP' : 'FPP';
    cameraButton.setAttribute('aria-label', `Switch to ${firstPerson ? 'third' : 'first'}-person camera`);
  };
  player = new GeoPlayer(scene, camera, canvas, world, { onCameraModeChange: updateCameraUI });
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
  const debugKeydown = event => {
    if (event.code !== 'F3' || event.ctrlKey || event.metaKey || event.altKey ||
        event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    toggleDebug(event);
  };
  lifecycle.listener(debugButton, 'click', toggleDebug);
  lifecycle.listener(window, 'keydown', debugKeydown);
  let initialDebug = false;
  try { initialDebug = new URLSearchParams(window.location.search).get('debug') === '1'; } catch { /* optional */ }
  setDebugEnabled(initialDebug);

  const projectedLabel = new THREE.Vector3();
  const labelElements = [];
  let displayedLabels = [], nextLabelRefresh = 0;
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
    const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    for (let index = 0; index < labelElements.length; index++) {
      const element = labelElements[index], label = labels[index];
      if (!label) { element.hidden = true; continue; }
      const distance = Math.hypot(label.x - player.position.x, label.z - player.position.z);
      const labelOffset = label.kind === 'place' ? 1.25 : label.kind === 'poi' ? .72 : label.kind === 'water' ? .28 : .42;
      projectedLabel.set(label.x, (label.y ?? 0) + labelOffset, label.z).project(camera);
      const screenX = (projectedLabel.x * .5 + .5) * width;
      const screenY = (-projectedLabel.y * .5 + .5) * height;
      let visible = projectedLabel.z > -1 && projectedLabel.z < 1 &&
        Math.abs(projectedLabel.x) < 1.06 && Math.abs(projectedLabel.y) < 1.06 && distance < 72;
      if (visible && occupied.some(position => Math.abs(position.x - screenX) < 96 && Math.abs(position.y - screenY) < 28)) visible = false;
      element.hidden = !visible;
      if (!visible) continue;
      occupied.push({ x: screenX, y: screenY });
      element.textContent = label.name;
      element.dataset.kind = label.kind;
      element.style.transform = `translate3d(${screenX}px, ${screenY}px, 0) translate(-50%, -50%)`;
      element.style.opacity = String(Math.min(1, Math.max(.35, 1 - distance / 90)));
    }
  };

  const joystick = new FlexibleJoystick(
    joystickZone,
    joystickBase,
    joystickKnob,
    (x, z) => player.setMoveInput(x, z),
  );
  const touchCleanups = [];
  for (const button of overlay.querySelectorAll('[data-hold-action]')) {
    const action = button.dataset.holdAction;
    const activate = event => {
      event.preventDefault();
      event.stopPropagation();
      button.classList.add('is-active');
      player.setVirtualInput(action, true);
      button.setPointerCapture?.(event.pointerId);
    };
    const deactivate = event => {
      event.preventDefault();
      event.stopPropagation();
      button.classList.remove('is-active');
      player.setVirtualInput(action, false);
    };
    button.addEventListener('pointerdown', activate);
    button.addEventListener('pointerup', deactivate);
    button.addEventListener('pointercancel', deactivate);
    button.addEventListener('lostpointercapture', deactivate);
    touchCleanups.push(() => {
      button.removeEventListener('pointerdown', activate);
      button.removeEventListener('pointerup', deactivate);
      button.removeEventListener('pointercancel', deactivate);
      button.removeEventListener('lostpointercapture', deactivate);
    });
  }
  const toggleCamera = event => {
    event.preventDefault();
    event.stopPropagation();
    player.toggleCameraMode();
  };
  cameraButton.addEventListener('pointerdown', toggleCamera);
  touchCleanups.push(() => cameraButton.removeEventListener('pointerdown', toggleCamera));

  const exit = () => onExitRequest?.();
  // The exit listener is owned by the lifecycle ledger below, together with the
  // visibility and context listeners.

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
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  lifecycle.observer(observer, 'container-resize');
  resize();

  const targetFrameInterval = 1000 / 30;
  let lastFrame = performance.now(), sampleStart = lastFrame, sampleFrames = 0;
  let slowSamples = 0, recoverySamples = 0;
  let sampleCpuMilliseconds = 0, worstFrameGap = 0, longTaskCount = 0;
  const longTaskObserver = typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ? new PerformanceObserver(entries => { longTaskCount += entries.getEntries().length; })
    : null;
  longTaskObserver?.observe({ type: 'longtask', buffered: false });
  if (longTaskObserver) lifecycle.observer(longTaskObserver, 'long-task');
  let auditClock = 0;
  const frame = now => {
    if (disposed || lost) return;
    animationFrame = requestAnimationFrame(frame);
    auditClock = now;
    if (document.hidden || now - lastFrame < targetFrameInterval - 1) return;
    const frameGap = now - lastFrame;
    const dt = Math.min(frameGap / 1000, .1);
    const cpuStart = performance.now();
    lastFrame = now;
    player.update(dt);
    world.update(player.position, camera, renderer.domElement.height, now);
    debugOverlay?.update(world, player.position, renderer, now);
    renderer.render(scene, camera);
    updateMapLabels(now);
    sampleCpuMilliseconds += performance.now() - cpuStart;
    worstFrameGap = Math.max(worstFrameGap, frameGap);
    sampleFrames++;

    if (now - sampleStart >= 1000) {
      const fps = sampleFrames * 1000 / (now - sampleStart);
      const location = world.coordinateAt(player.position.x, player.position.z);
      coordinateElement.textContent = `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`;
      const averageCpu = sampleFrames ? sampleCpuMilliseconds / sampleFrames : 0;
      const queries = world.queryDiagnostics;
      runtimeElement.textContent = `${Math.round(fps)} FPS · ${averageCpu.toFixed(1)}ms CPU · ${Math.round(worstFrameGap)}ms worst · ${renderer.info.render.calls} calls · ${Math.round(renderer.info.render.triangles / 1000)}k tris · ${renderer.info.memory.geometries} geo · ${longTaskCount} stalls · q ${queries.sweeps}/${queries.sphereSweeps} sweeps · ${queries.maxCandidates} max collision · ${queries.maxSupportCandidates} max support · ${queries.groundRejects} ground rejects · ${queries.depenetrations} recoveries · ${latestStatus?.roads ?? 0} roads · ${latestStatus?.buildings ?? 0} buildings · ${latestStatus?.decorations ?? 0} details · ${latestStatus?.labels ?? 0} names${latestStatus?.truncated ? ' · safety cap reached' : ''}`;
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
    joystick.reset();
    player.blur();
  };
  const contextLost = event => {
    event.preventDefault(); lost = true; cancelAnimationFrame(animationFrame); player.blur();
  };
  const contextRestored = () => {
    world.plantRenderPools.handleContextRestored();
    world.streetFurniturePools.handleContextRestored();
    world.bridgePools.handleContextRestored();
    world.landmarkPools.handleContextRestored();
    world.ambientLifePools.handleContextRestored();
    lost = false; resize(); lastFrame = performance.now(); animationFrame = requestAnimationFrame(frame);
  };
  lifecycle.listener(document, 'visibilitychange', visibility);
  lifecycle.listener(canvas, 'webglcontextlost', contextLost);
  lifecycle.listener(canvas, 'webglcontextrestored', contextRestored);
  lifecycle.listener(exitButton, 'click', exit);
  lifecycle.timer('frame', 0, () => cancelAnimationFrame(animationFrame), 'animation-loop');
  animationFrame = requestAnimationFrame(frame);
  logger.info('lifecycle', 'world mounted', {
    worker: true, pools: 5, ownedResources: lifecycle.snapshot().total,
  });

  // `FND-07`/`QLT-06`: the retired capture matrix is replaced by a scripted,
  // fixed-step movement audit over the real player, camera, and world. Every
  // verdict below is read from live state, so it runs in a page, in the debug
  // hook, and unattended.
  const auditInput = { forward: 0, strafe: 0, yawTurns: 0, zoomTurns: 0 };
  const auditReset = () => {
    player.setCameraMode('first-person', true);
    player.setPosition(player.position.x, player.position.z);
    player.yaw = 0;
    player.thirdPersonPitch = .32;
    player.distance = 2.6;
    player.setMoveInput(0, 0);
    player.update(1 / 30);
    world.update(player.position, camera, renderer.domElement.height, auditClock);
  };
  const auditStep = (input, { dt = 1 / 30 } = {}) => {
    if (player.cameraMode !== input.cameraMode) player.setCameraMode(input.cameraMode, true);
    player.yaw = (input.yawTurns ?? 0) * Math.PI * 2;
    if (input.zoomTurns != null) player.distance = 2.6 + input.zoomTurns * 3.4;
    auditInput.forward = input.forward ?? 0;
    auditInput.strafe = input.strafe ?? 0;
    player.setMoveInput(auditInput.strafe, auditInput.forward);
    player.enabled = true;
    auditClock += dt * 1000;
    player.update(dt);
    world.update(player.position, camera, renderer.domElement.height, auditClock);
  };
  const auditProbe = info => {
    const clearanceProbe = world.probeCameraClearance(
      player.cameraTarget, camera.position, cameraNearPlaneSweepRadius(camera), {},
    );
    return world.movementSnapshot({
      camera, renderer, cameraMode: player.cameraMode,
      clearance: clearanceProbe.clearance,
      pathId: info?.pathId ?? null, index: info?.index ?? -1, phase: info?.phase ?? 0,
    });
  };
  const movementAudit = createMovementAuditRunner({
    step: auditStep, probe: auditProbe, reset: auditReset, label: 'coordinate-movement',
  });
  const runMovementAudit = options => {
    const report = movementAudit.run(options);
    // The debug panel and the world snapshot read the same verdict summary.
    world.movementAuditSummary = movementAudit.summary();
    logger.info('audit', 'movement audit complete', {
      ok: report.ok, samples: report.samples, fingerprint: report.fingerprint,
      failed: report.verdicts.filter(verdict => !verdict.ok).map(verdict => verdict.id),
    });
    return report;
  };
  const debugSurface = installDebugHooks(window, {
    enabled: debugHooks,
    ledger: lifecycle,
    logger,
    describe: () => {
      const snapshot = world.movementSnapshot({ camera, renderer, cameraMode: player.cameraMode });
      return {
        coordinate: world.coordinateAt(player.position.x, player.position.z),
        camera: { mode: player.cameraMode, distance: player.cameraResolvedDistance },
        bands: snapshot.bands,
        plantLod: snapshot.lod,
        residentTiles: snapshot.residentTiles.length,
        query: world.queryDiagnostics,
        movementAudit: movementAudit.summary(),
        profile: world.profile,
      };
    },
    step: (dt, index) => {
      player.enabled = true;
      player.update(dt);
      world.update(player.position, camera, renderer.domElement.height, auditClock + index * dt * 1000);
    },
    audits: { movement: options => runMovementAudit(options) },
    extras: {
      world, player, camera, renderer,
      movementAudit,
      snapshot: () => world.movementSnapshot({ camera, renderer, cameraMode: player.cameraMode }),
    },
  });
  if (debugHooks) logger.info('debug', 'hook installed', { key: '__gdo', audits: ['movement'] });

  return {
    scene, camera, renderer, world, player,
    lifecycle,
    logger,
    debugHooks: debugSurface,
    runMovementAudit,
    get debugOverlay() { return debugOverlay; },
    dispose() {
      if (disposed) return; disposed = true;
      cancelAnimationFrame(animationFrame);
      touchCleanups.forEach(cleanup => cleanup());
      joystick.dispose();
      debugOverlay?.dispose();
      player.dispose();
      world.dispose();
      lightRig.dispose();
      engine.dispose();
      debugSurface.dispose();
      // Everything above released its own resources; the ledger then releases the
      // remaining listeners, observers, timers, and handles and reports any leak.
      const released = lifecycle.disposeAll();
      const leaks = lifecycle.leaks();
      logger.info('lifecycle', leaks.length ? 'unmount leaked resources' : 'unmount clean', {
        released, leaks: leaks.map(entry => `${entry.kind}:${entry.name}`),
      });
      if (leaks.length && typeof console !== 'undefined') {
        console.warn('Coordinate mount leaked lifecycle resources', leaks);
      }
    },
  };
}
