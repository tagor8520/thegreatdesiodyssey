import * as THREE from 'three';
import {
  createProceduralEngine,
  createProceduralLightRig,
  createTimeOfDayLighting,
  GDO_PALETTE,
} from '../engine/ProceduralEngine.js';
import { createTimeOfDayState, luminance, nightReadability } from '../engine/TimeOfDaySky.js';
import { GeoWorld } from './GeoWorld.js';
import { GeoPlayer, probeAuditedCameraClearance } from './GeoPlayer.js';
import { FlexibleJoystick, shouldUseTouchControls } from './GeoControls.js';
import { validateCoordinate } from './GeoMath.js';
import { LifecycleLedger } from '../engine/LifecycleContract.js';
import { createDebugLogger, installDebugHooks } from '../engine/DebugHooks.js';
import { createMovementAuditRunner } from '../engine/MovementAudit.js';
import { createSupportQuery, describeDomainCompliance } from '../engine/DomainInterface.js';
import { createLabelLosTester } from './GeoLabelLos.js';
import { createMapLabelLayer } from './GeoMapLabels.js';
import { createPlantSilhouetteAuditRunner } from '../engine/PlantSilhouetteAudit.js';
import { createTimeOfDayAuditRunner } from '../engine/TimeOfDayAudit.js';
import { actionCapabilitiesForDomain, createActionRegistry } from '../engine/ActionRegistry.js';
import { createTouchActionControls, touchActionMarkup } from './GeoActionControls.js';
import { createContentValidatorExtras } from '../engine/ContentValidatorTool.js';
import './geo.css';

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// `GME-03`/`GME-05`: the on-screen pad and the keyboard filter are generated from
// one registry built on the coordinate player domain's declared capabilities.
const coordinateActions = createActionRegistry({
  capabilities: actionCapabilitiesForDomain(GDO_COORDINATE_PLAYER_DOMAIN),
});

function uiMarkup() {
  return `
    <div class="geo-ui">
      <div class="geo-map-labels" aria-hidden="true"></div>
      <div class="geo-panel geo-stats">
        <strong>Coordinate Explorer <span class="geo-scale-badge">1:10 footprint scale</span></strong>
        <div class="geo-coordinates">Locating…</div>
        <div class="geo-map-readout" aria-live="off">Reading map…</div>
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
      <div class="geo-panel geo-help">${coordinateActions.keyboardHint()} · F3: debug · Click: look · Scroll: TPP zoom</div>
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
          ${touchActionMarkup(coordinateActions.touchControls())}
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
  const mapReadoutElement = overlay.querySelector('.geo-map-readout');
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
  // `ENV-02`: one geographic clock drives the sky dome, the light rig, the fog,
  // the exposure, the star field, and the lamp/window emissive level. The world
  // only reads the numbers it already had; the suntime is the only new input.
  const timeOfDayLighting = createTimeOfDayLighting({
    sky: engine.sky,
    rig: lightRig,
    renderer,
    scene,
  });
  const timeOfDay = createTimeOfDayState({
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
    profile: 'low',
    writers: timeOfDayLighting.writers,
    ledger: lifecycle,
  });
  timeOfDayLighting.apply(timeOfDay.state);
  world.timeOfDayState = timeOfDay;

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
  // `GME-04`: labels are occlusion-tested through the shared `LOS_BLOCKER` sweep
  // at a bounded rate, so a name behind a building is hidden instead of drawn on
  // top of it, and the DOM/HUD read the same verdicts the tests assert.
  const labelLos = createLabelLosTester({ world, profile: world.profile });
  const losAnchor = new THREE.Vector3();
  world.labelLosDiagnostics = labelLos.diagnostics();
  // `LAY-05`: the placement decision — LOS verdict, screen margin, range, sparse
  // no-overlap layout, and the capped element pool — lives in one tested module.
  const labels = createMapLabelLayer({
    profile: world.profile,
    layer: mapLabelLayer,
    tester: labelLos,
    world,
    camera,
    createElement: () => {
      const element = document.createElement('span');
      element.className = 'geo-map-label';
      return element;
    },
  });
  // `FND-07`: the label pool is owned like every other runtime resource.
  lifecycle.own('node', 'map-labels', labels, layer => layer.dispose());
  let displayedLabels = [], nextLabelRefresh = 0, lastLosTests = 0, silhouetteClock = 0;
  const updateMapLabels = now => {
    if (now >= nextLabelRefresh) {
      displayedLabels = world.visibleLabels;
      nextLabelRefresh = now + 250;
    }
    // The tester probes from the live camera eye to each label anchor.
    losAnchor.copy(camera.position);
    labels.layout(displayedLabels, {
      camera: { position: losAnchor },
      nowMilliseconds: now,
      screen: { width: container.clientWidth, height: container.clientHeight },
      project: (x, y, z, out) => out.copy(projectedLabel.set(x, y, z).project(camera)),
    });
    world.labelLosDiagnostics = labelLos.diagnostics();
    world.mapLabelDiagnostics = labels.diagnostics();
  };

  const joystick = new FlexibleJoystick(
    joystickZone,
    joystickBase,
    joystickKnob,
    (x, z) => player.setMoveInput(x, z),
  );
  const touchCleanups = [];
  // `GME-03`/`GME-05`: hold and tap controls are wired from the shared action
  // registry, so a newly registered action needs no edit in this file.
  const touchControls = createTouchActionControls({
    container: overlay,
    registry: coordinateActions,
    lifecycle,
    onAction: (id, phase) => {
      const action = coordinateActions.action(id);
      if (action?.kind === 'tap') {
        if (id === 'camera') { player.toggleCameraMode(); return; }
        player.setVirtualInput(id, true);
        player.setVirtualInput(id, false);
        return;
      }
      player.setVirtualInput(id, phase === 'hold');
    },
  });
  touchCleanups.push(() => touchControls.dispose());

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
    // `ENV-02`: the world clock advances with real time, and the bounded writer
    // only touches the sky/light/fog/exposure when a value actually changed.
    timeOfDay.advance(frameGap);
    timeOfDay.update(now);
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
      const los = world.labelLosDiagnostics;
      // `GME-04` budget surface: the rate actually achieved over the last second,
      // and the steady-frame allocation claim the tester's tests prove.
      world.labelLosRate = Math.max(0, (los?.tests ?? 0) - (lastLosTests ?? 0));
      lastLosTests = los?.tests ?? 0;
      world.labelLosSteadyFrameAllocations = los?.steadyFrameAllocations ?? 0;
      // `GME-04` richer map: the HUD names the mapped surface, water class, and
      // nearest mapped place instead of stopping at raw coordinates.
      const readout = world.mapReadout(player.position.x, player.position.z);
      const water = player.waterDiagnostics();
      world.waterContactSummary = water;
      mapReadoutElement.textContent = `${readout.supportKind}${readout.supportLevel ? ` L${readout.supportLevel}` : ''} · ${readout.waterClassName}${water.state === 'dry' ? '' : ` (${water.state})`}${readout.inWater && water.state === 'dry' ? ' (in water)' : ''} · ${readout.placeName ? `${readout.placeName} ${Math.round(readout.placeDistance)}u` : 'no mapped name'} · tile ${readout.tileKey ?? '—'} · ${readout.providerSchema ?? 'schema unknown'}`;
      runtimeElement.textContent = `${Math.round(fps)} FPS · ${averageCpu.toFixed(1)}ms CPU · ${Math.round(worstFrameGap)}ms worst · ${renderer.info.render.calls} calls · ${Math.round(renderer.info.render.triangles / 1000)}k tris · ${renderer.info.memory.geometries} geo · ${longTaskCount} stalls · q ${queries.sweeps}/${queries.sphereSweeps} sweeps · ${queries.maxCandidates} max collision · ${queries.maxSupportCandidates} max support · ${queries.groundRejects} ground rejects · ${queries.depenetrations} recoveries · ${latestStatus?.roads ?? 0} roads · ${latestStatus?.buildings ?? 0} buildings · ${latestStatus?.decorations ?? 0} details · ${latestStatus?.labels ?? 0} names · LOS ${los?.tests ?? 0}/${los?.testsPerSecond ?? 0} per s · ${los?.hidden ?? 0} hidden${latestStatus?.truncated ? ' · safety cap reached' : ''} · ${world.ambientSchedule?.active ?? 0}/${world.ambientLifePools?.entries ?? 0} life · ${world.discoverySummary?.visited ?? 0}/${world.discoverySummary?.records ?? 0} found`;
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
    // `QLT-06`: first-person clearance means "the eye is inside a blocker", not
    // "a facade is a metre ahead of the eye it is facing".
    const clearanceProbe = probeAuditedCameraClearance(
      world, player.cameraTarget, camera, player.cameraMode === 'first-person',
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
  // `VEG-02`: the same scripted-walk approach measures the vegetation silhouette
  // and its LOD cost against the declared low-profile ceilings.
  const silhouetteAudit = createPlantSilhouetteAuditRunner({
    step: info => {
      const yaw = (info.yawTurns ?? 0) * Math.PI * 2;
      const distance = (info.forward ?? 0) * .85;
      player.position.x += Math.sin(yaw) * distance;
      player.position.z += Math.cos(yaw) * distance;
      silhouetteClock += 1000 / 30;
      player.update(info.dt ?? 1 / 30);
      world.update(player.position, camera, renderer.domElement.height, silhouetteClock);
    },
    probe: () => world.plantSilhouetteSample(),
    reset: () => {
      silhouetteClock = 0;
      player.setPosition(0, 0);
      world.plantLodSelector.clear();
    },
    warmup: true,
    label: 'coordinate-silhouette',
  });
  const runSilhouetteAudit = options => {
    const report = silhouetteAudit.run(options);
    world.plantSilhouetteSummary = silhouetteAudit.summary();
    logger.info('audit', 'plant silhouette audit complete', {
      ok: report.ok, samples: report.samples, fingerprint: report.fingerprint,
      failed: report.verdicts.filter(verdict => !verdict.ok).map(verdict => verdict.id),
    });
    return report;
  };
  // `ENV-02`: the same scripted-audit shape the movement and silhouette audits
  // use, with the day cycle's named overrides. Every recorded number is read
  // back off the live `three` objects, so the audit proves the sky and the rig
  // really moved — not merely that the state object changed.
  const timeOfDayAudit = createTimeOfDayAuditRunner({
    label: 'coordinate-time-of-day',
    reset: () => { timeOfDay.override(null); },
    sample: name => {
      timeOfDay.override(name);
      timeOfDay.advance(1000);
      timeOfDay.update(timeOfDay.clockMilliseconds);
      timeOfDayLighting.apply(timeOfDay.state);
      const state = timeOfDay.state;
      return {
        phase: state.phase,
        elevationDegrees: state.elevationDegrees,
        nightFactor: state.nightFactor,
        starOpacity: state.starOpacity,
        moonOpacity: state.moonOpacity,
        emissive: state.emissive,
        sunIntensity: lightRig.sun.intensity,
        hemisphereIntensity: lightRig.fill.intensity,
        exposure: state.exposure,
        horizonLuminance: luminance(state.horizon),
        zenithLuminance: luminance(state.zenith),
        fogLuminance: luminance(state.fog),
        readabilityOk: nightReadability(state).ok,
        starGeometryCount: engine.sky?.starPoints?.geometry?.attributes?.position?.count ?? 0,
        starVisible: engine.sky?.starPoints?.visible ?? false,
        sunHeight: lightRig.sun.position.y,
        toneMappingExposure: renderer.toneMappingExposure,
        writesThisUpdate: timeOfDay.diagnostics().writesThisUpdate,
        overBudgetUpdates: timeOfDay.diagnostics().overBudgetUpdates,
      };
    },
  });
  const runTimeOfDayAudit = options => {
    const report = timeOfDayAudit.run(options);
    world.timeOfDaySummary = timeOfDayAudit.summary();
    logger.info('audit', 'time-of-day audit complete', {
      ok: report.ok, samples: report.samples, fingerprint: report.fingerprint,
      failed: report.verdicts.filter(verdict => !verdict.ok).map(verdict => verdict.id),
    });
    return report;
  };
  const runMovementAudit = options => {
    // `ENV-02`: research item 8 runs the movement script at dawn/noon/sunset/night
    // through exactly this audit, with a time-of-day override.
    const override = options?.timeOfDay ?? null;
    if (override) {
      timeOfDay.override(override);
      timeOfDay.advance(1000);
      timeOfDay.update(timeOfDay.clockMilliseconds);
      timeOfDayLighting.apply(timeOfDay.state);
    }
    const report = movementAudit.run(options);
    // The debug panel and the world snapshot read the same verdict summary.
    world.movementAuditSummary = movementAudit.summary();
    if (override) {
      timeOfDay.override(null);
      timeOfDayLighting.apply(timeOfDay.state);
    }
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
        labelLos: world.labelLosDiagnostics ? { ...world.labelLosDiagnostics } : null,
        mapReadout: { ...world.mapReadout(player.position.x, player.position.z) },
        // `FND-08`: both live domains, so a debug session shows which interface
        // and scale the world and avatar are answering on.
        domains: {
          world: { id: world.domain.id, compliant: describeDomainCompliance(world, world.domain).ok },
          player: { id: player.playerDomain.id, compliant: describeDomainCompliance(player, player.playerDomain).ok },
          queries: world.domain.capabilities.coordinates ? 1 : 0,
        },
        // `GME-05`: which actions the live registry exposes and how they are bound.
        actions: coordinateActions.diagnostics(),
        dispatched: player.actionDiagnostics().recent,
        support: createSupportQuery(world, world.domain).support(player.position.x, player.position.z),
        movementAudit: movementAudit.summary(),
        plantSilhouette: silhouetteAudit.summary(),
        // `ENV-02`: the live phase, sun elevation, and the day verdict summary.
        timeOfDay: timeOfDay.diagnostics(),
        // `COL-08`: the live water state, the current it feels, and the last landing.
        water: { ...player.waterDiagnostics() },
        // `LIF-02`: what the screen-space scheduler drew and parked last frame.
        ambientSchedule: world.ambientSchedule ? { ...world.ambientSchedule } : null,
        // `LAY-05`: how many names the DOM layer is showing and why the rest
        // are hidden.
        mapLabels: world.mapLabelDiagnostics ?? null,
        // `GME-06`: what the journal remembers, what is still merely sighted,
        // and whether the local store accepted the last write.
        discovery: world.discoverySummary ? { ...world.discoverySummary } : null,
        discoveryJournal: world.discoveryJournal?.diagnostics?.() ?? null,
        discoveryStorage: world.discoveryStorage?.diagnostics?.() ?? null,
        timeOfDayAudit: timeOfDayAudit.summary(),
        profile: world.profile,
      };
    },
    step: (dt, index) => {
      player.enabled = true;
      player.update(dt);
      world.update(player.position, camera, renderer.domElement.height, auditClock + index * dt * 1000);
    },
    audits: {
      movement: options => runMovementAudit(options),
      silhouette: options => runSilhouetteAudit(options),
      timeOfDay: options => runTimeOfDayAudit(options),
    },
    extras: {
      world, player, camera, renderer,
      movementAudit,
      snapshot: () => world.movementSnapshot({ camera, renderer, cameraMode: player.cameraMode }),
      // `CNT-03`: the content tool is reachable from a browser console, so a
      // contributor can paste a pack or a landmark recipe and read the same
      // verdict the CLI prints.
      ...createContentValidatorExtras({ providers: providers ?? null, profile: profile ?? 'low' }),
    },
  });
  if (debugHooks) logger.info('debug', 'hook installed', { key: '__gdo', audits: ['movement', 'silhouette', 'timeOfDay'] });

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
