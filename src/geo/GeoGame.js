import * as THREE from 'three';
import {
  createProceduralEngine,
  createProceduralLightRig,
  createTimeOfDayLighting,
  GDO_PALETTE,
} from '../engine/ProceduralEngine.js';
import { createTimeOfDayState, luminance, nightReadability } from '../engine/TimeOfDaySky.js';
import { GeoWorld, GDO_COORDINATE_WORLD_DOMAIN } from './GeoWorld.js';
import { GDO_COORDINATE_PLAYER_DOMAIN, GeoPlayer, probeAuditedCameraClearance } from './GeoPlayer.js';
import { registerPropInteraction } from '../engine/PropGrammar.js';
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
import { activityAuditWalk, createActivityAuditRunner } from '../engine/ActivityAudit.js';
import { activityHudText } from '../engine/LocalActivities.js';
import { createWeatherAuditRunner } from '../engine/WeatherAudit.js';
import { weatherHudText } from '../engine/WeatherState.js';
import { pedestrianHudText } from '../engine/LocalPedestrians.js';
import { GDO_PEDESTRIAN_AUDIT_SCRIPT, createPedestrianAuditRunner, pedestrianAuditPlayerAt } from '../engine/PedestrianAudit.js';
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
  capabilities: {
    ...actionCapabilitiesForDomain(GDO_COORDINATE_PLAYER_DOMAIN),
    // `DET-10`: the world declares that it mounts interaction targets, so the
    // prop `interact` verb reaches the pad, the key filter, and the help line
    // exactly like every other registered action.
    interaction: GDO_COORDINATE_WORLD_DOMAIN.capabilities.interaction === true,
    // `GME-07`: the world derives guidance from mapped places, so the `guide`
    // verb reaches the same pad, filter, and help line as every other action.
    navigation: GDO_COORDINATE_WORLD_DOMAIN.capabilities.navigation === true,
  },
});

function uiMarkup() {
  return `
    <div class="geo-ui">
      <div class="geo-map-labels" aria-hidden="true"></div>
      <div class="geo-panel geo-stats">
        <strong>Coordinate Explorer <span class="geo-scale-badge">1:10 footprint scale</span></strong>
        <div class="geo-coordinates">Locating…</div>
        <div class="geo-map-readout" aria-live="off">Reading map…</div>
      <div class="geo-hud-stack">
        <div class="geo-navigation" aria-live="polite">
          <canvas class="geo-minimap" width="132" height="132" aria-label="Local minimap"></canvas>
          <div class="geo-nav-detail">
            <div class="geo-nav-target">No route · choose a place from the map</div>
            <div class="geo-nav-guidance">Guidance appears once a target is chosen</div>
          </div>
        </div>
        <div class="geo-activities" aria-live="polite">
          <div class="geo-activity-title">Local activities appear once the map is resident</div>
          <div class="geo-activity-progress"></div>
        </div>
        <div class="geo-weather" aria-live="polite">
          <div class="geo-weather-title">Weather appears once the map is resident</div>
          <div class="geo-weather-detail"></div>
        </div>
        <div class="geo-pedestrians" aria-live="polite">
          <div class="geo-pedestrian-title">Pedestrians appear once the streets are resident</div>
          <div class="geo-pedestrian-detail"></div>
        </div>
      </div>
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
  const minimapElement = overlay.querySelector('.geo-minimap');
  const navTargetElement = overlay.querySelector('.geo-nav-target');
  const navGuidanceElement = overlay.querySelector('.geo-nav-guidance');
  const activityTitleElement = overlay.querySelector('.geo-activity-title');
  const activityProgressElement = overlay.querySelector('.geo-activity-progress');
  const weatherTitleElement = overlay.querySelector('.geo-weather-title');
  const weatherDetailElement = overlay.querySelector('.geo-weather-detail');
  const pedestrianTitleElement = overlay.querySelector('.geo-pedestrian-title');
  const pedestrianDetailElement = overlay.querySelector('.geo-pedestrian-detail');
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
  // `ENV-04`: the world's weather machine weathers the `ENV-02` day cycle rather
  // than replacing it — same rig, same fog, same renderer — plus the sky dome's
  // cloud uniforms and the world's own landed wind and habitat responses.
  const weatherTargets = {
    rig: lightRig,
    renderer,
    scene,
    sky: engine.sky ?? null,
    wind: options => world.configurePlantWind(options),
    habitat: options => { world.weatherHabitat = options; },
    fogNear: 78,
    fogFar: 175,
  };
  world.setWeatherTargets(weatherTargets);
  // `ENV-02`: the diagnostics surface reports the day-cycle state the sky, the
  // light rig, the fog, and the weather machine are already reading. It is
  // attached *after* the world exists — nothing constructs with it.
  world.timeOfDayState = timeOfDay;
  const updateCameraUI = mode => {
    const firstPerson = mode === 'first-person';
    cameraStatusElement.textContent = `${firstPerson ? 'First' : 'Third'}-person camera · V to switch`;
    cameraButton.textContent = firstPerson ? 'TPP' : 'FPP';
    cameraButton.setAttribute('aria-label', `Switch to ${firstPerson ? 'third' : 'first'}-person camera`);
  };
  // `GME-05`/`GME-07`: the avatar consumes the *same* action registry the UI does,
  // so a verb declared for guidance is dispatchable from the keyboard the moment
  // it is registered — no second table, no edit in the input filter.
  player = new GeoPlayer(scene, camera, canvas, world, {
    onCameraModeChange: updateCameraUI, actions: coordinateActions,
  });
  // `LAY-06`: the avatar fades through the same policy the world's ambient
  // clutter does, so a close third-person camera dithers it once.
  if (world.cameraFade) player.attachCameraFade(world.cameraFade);
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
  // `DET-10`: the prop `interact` verb joins the one registry, so the pad, the
  // keyboard filter, and the help sentence pick it up together.
  world.propInteraction = registerPropInteraction(coordinateActions);
  // `GME-07`: `guide` picks the nearest mapped place, and repeats cycle through the
  // ranked local targets — every one of them is a real name from a resident tile.
  let navigationTargetIndex = -1;
  const chooseNavigationTarget = () => {
    const targets = world.navigationTargets(player.position.x, player.position.z, { limit: 6 });
    if (!targets.length) return null;
    navigationTargetIndex = (navigationTargetIndex + 1) % targets.length;
    const target = targets[navigationTargetIndex];
    const route = world.navigateTo({ placeId: target.id }, { x: player.position.x, z: player.position.z });
    logger.info('navigation', 'guidance target chosen', {
      target: target.name, ok: Boolean(route?.ok), reason: route?.reason ?? null,
      distanceMetres: route?.distanceMetres ?? 0,
    });
    return route;
  };
  const guideRegistration = coordinateActions.register({
    id: 'guide', kind: 'tap', label: 'Guide', hint: 'G',
    capability: 'navigation', keyboard: ['KeyG'], touch: { control: 'button', label: 'GUIDE' },
  });
  if (coordinateActions.has('guide')) {
    world.navigationInteraction = { registered: true, reason: null };
  } else {
    world.navigationInteraction = { registered: false, reason: guideRegistration?.reason ?? 'capability' };
  }
  if (coordinateActions.has('guide')) {
    // Desktop and the pad share the one handler: key `G` cycles the target, and a
    // second, longer hold cancels the guidance instead of re-targeting.
    player.setActionHandler('guide', entry => { chooseNavigationTarget(); return entry; });
  }
  const cancelGuidance = () => {
    const had = world.cancelNavigation();
    navigationTargetIndex = -1;
    if (had) logger.info('navigation', 'guidance cancelled', {});
    return had;
  };
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

  // `GME-07`: the minimap and its guidance sentence are drawn from the world's
  // navigation *model* — normalized 2D points — on this canvas, which the caller
  // already owns. No scene object, no material, no draw call joins the render.
  const minimapContext = minimapElement?.getContext?.('2d') ?? null;
  const minimapPalette = {
    tile: 'rgba(140, 170, 200, .10)', road: 'rgba(226, 232, 240, .55)',
    route: '#7dd3fc', routeEdge: 'rgba(125, 211, 252, .28)',
    place: '#fbbf24', player: '#f8fafc', north: 'rgba(226, 232, 240, .7)',
  };
  let drawnRouteKey = null, drawnMinimapHeading = null;
  const drawMinimap = (model, routeKey) => {
    if (!minimapContext || !model) return 0;
    const { width, height } = minimapElement;
    minimapContext.clearRect(0, 0, width, height);
    const px = u => (u * .5 + .5) * width;
    const py = v => (v * .5 + .5) * height;
    minimapContext.fillStyle = 'rgba(12, 18, 28, .55)';
    minimapContext.fillRect(0, 0, width, height);
    minimapContext.strokeStyle = minimapPalette.tile;
    minimapContext.lineWidth = 1;
    for (const tile of model.tiles) {
      minimapContext.strokeRect(px(tile.u), py(tile.v), tile.w * .5 * width, tile.h * .5 * height);
    }
    minimapContext.strokeStyle = minimapPalette.road;
    minimapContext.lineWidth = 1;
    minimapContext.beginPath();
    for (const segment of model.roads) {
      minimapContext.moveTo(px(segment.u1), py(segment.v1));
      minimapContext.lineTo(px(segment.u2), py(segment.v2));
    }
    minimapContext.stroke();
    if (model.route.length > 1) {
      minimapContext.strokeStyle = minimapPalette.routeEdge;
      minimapContext.lineWidth = 4;
      minimapContext.beginPath();
      model.route.forEach(([u, v], index) => {
        if (index === 0) minimapContext.moveTo(px(u), py(v));
        else minimapContext.lineTo(px(u), py(v));
      });
      minimapContext.stroke();
      minimapContext.strokeStyle = minimapPalette.route;
      minimapContext.lineWidth = 2;
      minimapContext.stroke();
    }
    for (const place of model.places) {
      minimapContext.fillStyle = minimapPalette.place;
      minimapContext.beginPath();
      minimapContext.arc(px(place.u), py(place.v), 2.4, 0, Math.PI * 2);
      minimapContext.fill();
    }
    // North-up, so the player marker is what turns: a small heading triangle.
    const heading = (model.player.headingDegrees ?? 0) * Math.PI / 180;
    minimapContext.save();
    minimapContext.translate(width / 2, height / 2);
    minimapContext.rotate(Math.PI - heading);
    minimapContext.fillStyle = minimapPalette.player;
    minimapContext.beginPath();
    minimapContext.moveTo(0, 5.5);
    minimapContext.lineTo(-3.5, -3.5);
    minimapContext.lineTo(3.5, -3.5);
    minimapContext.closePath();
    minimapContext.fill();
    minimapContext.restore();
    minimapContext.fillStyle = minimapPalette.north;
    minimapContext.font = '9px system-ui, sans-serif';
    minimapContext.fillText('N', width / 2 - 3, 10);
    drawnRouteKey = routeKey;
    drawnMinimapHeading = model.player.headingDegrees;
    return model.segments;
  };

  const updateNavigation = () => {
    // The world rate-limits by movement, so this is a per-frame call that only
    // re-plans, re-models, or re-draws when something actually changed.
    const guidance = world.navigationGuidance(player.position.x, player.position.z, {
      headingDegrees: (player.cameraMode === 'first-person' ? player.yaw : camera.rotation.y) * 180 / Math.PI,
    });
    world.navigationGuidanceRecord = guidance;
    const minimap = guidance.minimap;
    const changed = guidance.routeKey !== drawnRouteKey
      || drawnMinimapHeading == null
      || Math.abs(((guidance.heading - drawnMinimapHeading + 540) % 360) - 180) > 6;
    if (!guidance.reused || changed) {
      // A reused record whose heading has not turned is redrawn from the same
      // model — the loop keeps its allocation count at zero either way.
      world.navigationMinimapSegments = drawMinimap(minimap, guidance.routeKey);
    }
    if (navTargetElement) {
      navTargetElement.textContent = guidance.route?.ok
        ? `${guidance.route.targetName || 'Route'} · ${Math.round(guidance.progress?.remainingMetres ?? 0)} m remaining`
        : 'No route · choose a place from the map';
    }
    if (navGuidanceElement) {
      navGuidanceElement.textContent = guidance.guidance?.text ?? 'Guidance appears once a target is chosen';
    }
    return guidance;
  };

  // `GME-08`: the HUD line for the current local activity. The world rebuilds the
  // board only when its resident context changed, so this is a cheap read; the
  // text only changes when the objective or its progress actually changed.
  let drawnActivityText = null;
  const updateActivities = () => {
    const summary = world.activitySummary ?? world.updateActivities(
      player.position.x, player.position.z, performance.now(),
    );
    if (!activityTitleElement || !summary) return summary;
    const text = activityHudText(summary);
    const key = `${text.title}|${text.progress}`;
    if (key === drawnActivityText) return summary;
    drawnActivityText = key;
    activityTitleElement.textContent = text.title;
    activityProgressElement.textContent = text.progress;
    return summary;
  };

  // `ENV-04`: the HUD line for the current weather. Every number it shows is read
  // off the machine the renderer is using, so the line cannot drift from the sky.
  let drawnWeatherText = null;
  const updateWeatherHud = () => {
    if (!weatherTitleElement || !world.weather) return null;
    const text = weatherHudText(world.weather.state);
    if (text.text === drawnWeatherText) return text;
    drawnWeatherText = text.text;
    weatherTitleElement.textContent = `${text.text} · run ${world.weather.state.run}`;
    const surface = world.weather.state.surface;
    // `ENV-05`: the same line reports the bounded effect family the weather is
    // drawing, so a player reads the particles and their cost together.
    const effects = world.weatherEffects?.diagnostics ?? null;
    const effectNote = effects?.family ? `${effects.particles} ${effects.family} · 1 draw` : 'no particles';
    weatherDetailElement.textContent =
      `wind ${world.weather.state.wind.strength.toFixed(2)} · ${surface.wetness >= .5 ? 'wet ground' : surface.dust >= .5 ? 'dust' : surface.snow >= .5 ? 'snow' : 'dry ground'} · ${effectNote}`;
    return text;
  };

  // `LIF-04`: the HUD line for the local street. It is written from the board's
  // own `pedestrianHudText`, so the line and the audit read one summary.
  let drawnPedestrianText = null;
  const updatePedestrianHud = () => {
    const summary = world.pedestrianSummary;
    if (!pedestrianTitleElement || !summary) return null;
    const text = pedestrianHudText(summary);
    if (text.text === drawnPedestrianText) return text;
    drawnPedestrianText = text.text;
    pedestrianTitleElement.textContent = text.text;
    pedestrianDetailElement.textContent = text.detail;
    return text;
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
      // `GME-07`: a pad tap on `guide` cycles the guidance target exactly like the key.
      if (id === 'guide' && phase === 'tap') { chooseNavigationTarget(); return; }
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
    const dayWrote = timeOfDay.update(now);
    world.setWeatherSkyState(timeOfDay.state);
    player.update(dt);
    world.update(player.position, camera, renderer.domElement.height, now);
    // `ENV-04`: the day cycle and the weather machine write the same sun, fog, and
    // exposure channels. When `ENV-02` lands a keyframe it overwrites the weather's
    // scale, so one bounded re-apply puts the moderated numbers back.
    if (dayWrote) world.reapplyWeather();
    debugOverlay?.update(world, player.position, renderer, now);
    renderer.render(scene, camera);
    updateMapLabels(now);
    updateNavigation();
    updateActivities();
    updateWeatherHud();
    updatePedestrianHud();
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
      camera, renderer, cameraMode: player.cameraMode, player,
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
  // `GME-08`: the scripted activity audit. It walks the player at the current
  // objective's own target, steps the world and the HUD exactly like a frame
  // does, and records what the objectives did — so the row's "reproducible
  // objectives from real place/road/land context" gate is proven without a
  // browser session.
  const activityAuditClock = { value: 0 };
  const activityAudit = createActivityAuditRunner({
    label: 'coordinate-activities',
    reset: () => {
      // A run must be independent of the previous one, so the clock, the
      // throttle, the board, and the journal all start over.
      activityAuditClock.value = 0;
      world.activityOriginSet = false;
      world.nextActivityPassMilliseconds = 0;
      world.nextDiscoveryPassMilliseconds = 0;
      world.discoveryJournal?.reset?.();
      world.activities?.reset();
      const origin = world.activityStart ?? { x: 0, z: 0 };
      player.setPosition(origin.x, origin.z);
      player.update(1 / 30);
      world.update(player.position, camera, renderer.domElement.height, 0);
    },
    step: ({ index, dt }) => {
      activityAuditClock.value += dt * 1000;
      // One shared planner: it approaches a named target, and gives a
      // self-referential objective (which names none) its own bounded leg, so the
      // scripted walk advances on every date-seeded board.
      const next = activityAuditWalk({
        x: player.position.x, z: player.position.z,
        objective: world.activities?.current() ?? null,
        targets: world.activities?.currentTargets?.() ?? [],
        index, dt,
      });
      if (next.x !== player.position.x || next.z !== player.position.z) player.setPosition(next.x, next.z);
      player.update(dt);
      world.update(player.position, camera, renderer.domElement.height, activityAuditClock.value);
      updateMapLabels(activityAuditClock.value);
      updateNavigation();
      updateActivities();
      updatePedestrianHud();
    },
    sample: index => {
      const record = world.activitySample(index);
      const hudTitle = activityTitleElement?.textContent ?? '';
      const hudProgress = activityProgressElement?.textContent ?? '';
      // The HUD half of the gate: the DOM line must equal the copy the board's own
      // summary renders, so the objective the player reads is the objective the
      // audit measured — not a second, independently formatted string.
      const text = activityHudText(world.activities.summary());
      const hudTracksCurrent = hudTitle === text.title && hudProgress === text.progress;
      return { ...record, hudTitle, hudProgress, hudTracksCurrent };
    },
  });
  const runActivityAudit = options => {
    const report = activityAudit.run(options);
    world.activityAuditSummary = activityAudit.summary();
    logger.info('audit', 'activity audit complete', {
      ok: report.ok, samples: report.samples, fingerprint: report.fingerprint,
      seed: report.seed, bridges: report.bridges,
      failed: report.verdicts.filter(verdict => !verdict.ok).map(verdict => verdict.id),
    });
    return report;
  };
  // `ENV-04`: the scripted weather audit. It compresses a session — jumping to
  // just past each run boundary and then stepping over the blend — and samples the
  // world's own weather record, so "deterministic transitions, environment
  // response, low-profile fallback" is proven without a browser session.
  const weatherAuditClock = { value: 0 };
  // A sample slot for the audit: the day cycle's own sampler writes into it, so a
  // scripted run never mutates (or inherits) the runtime's live state record.
  const weatherAuditSky = {
    horizon: [0, 0, 0], middle: [0, 0, 0], zenith: [0, 0, 0], fog: [0, 0, 0],
    sun: [0, 0, 0], hemisphere: [0, 0, 0], ground: [0, 0, 0],
    sunDirection: [0, 1, 0], moonDirection: [0, -1, 0],
  };
  const weatherAudit = createWeatherAuditRunner({
    label: 'coordinate-weather',
    reset: () => {
      weatherAuditClock.value = 0;
      world.weather?.reset();
      timeOfDay.setClock(0);
      world.setWeatherSkyState(timeOfDay.sampleNow(weatherAuditSky));
    },
    step: ({ dt }) => {
      const boundary = world.weather.nextRunBoundary(weatherAuditClock.value);
      const cross = world.weather.limits.runMilliseconds * .5;
      weatherAuditClock.value = weatherAuditClock.value + cross >= boundary
        ? boundary + world.weather.limits.blendMilliseconds * .25
        : weatherAuditClock.value + cross;
      // The day cycle advances on the same scripted clock, so the machine is
      // moderating a real `ENV-02` keyframe rather than a frozen noon. `sampleNow`
      // is the day cycle's own sampler: it answers for that instant without
      // depending on the runtime's write cadence, so a second pass replays the
      // first one exactly.
      timeOfDay.setClock(weatherAuditClock.value);
      world.setWeatherSkyState(timeOfDay.sampleNow(weatherAuditSky));
      player.update(dt);
      world.update(player.position, camera, renderer.domElement.height, weatherAuditClock.value);
      updateWeatherHud();
    },
    sample: index => {
      const record = world.weatherSample(index);
      const text = weatherHudText(world.weather.state);
      return {
        ...record,
        // The HUD half of the gate: the DOM line is the copy the machine's own
        // state renders, so what the player reads is what the audit measured.
        hudTitle: weatherTitleElement?.textContent ?? '',
        hudDetail: weatherDetailElement?.textContent ?? '',
        hudTracksCurrent: (weatherTitleElement?.textContent ?? '').startsWith(text.text),
      };
    },
    expect: {
      requiredFallbacks: world.weather?.policy.cloudCoverage === false ? ['cloudCoverage'] : [],
      minStates: 3,
      maxWritesPerUpdate: world.weather?.limits.maxWritesPerUpdate ?? 12,
      fogFar: 175,
    },
  });
  // `LIF-04`: the scripted pedestrian audit. It walks the player from the tile
  // centre out past the active radius and back while the world steps exactly like
  // a frame, so the row's "route graph, despawn/reuse, no dense global simulation"
  // gate is measured on the live board instead of asserted in a comment.
  const pedestrianAuditClock = { value: 0 };
  // The world owns where its audit can walk to, so the script is a property of the
  // map rather than a number a reader has to trust.
  const worldPedestrianAuditScript = () => {
    const far = world.pedestrianAuditScript();
    return Object.freeze({ ...GDO_PEDESTRIAN_AUDIT_SCRIPT, farX: far.dx, farZ: far.dz });
  };
  const pedestrianAudit = createPedestrianAuditRunner({
    label: 'coordinate-pedestrians',
    steps: GDO_PEDESTRIAN_AUDIT_SCRIPT.steps,
    dt: GDO_PEDESTRIAN_AUDIT_SCRIPT.dt,
    reset: () => {
      pedestrianAuditClock.value = 0;
      world.pedestrians?.reset();
      world.lastPedestrianMilliseconds = null;
      world.pedestrianSummary = null;
      const origin = world.pedestrianAuditOrigin();
      player.setPosition(origin.x, origin.z);
      player.update(GDO_PEDESTRIAN_AUDIT_SCRIPT.dt);
      world.update(player.position, camera, renderer.domElement.height, 0);
      updatePedestrianHud();
    },
    step: ({ index, dt, steps }) => {
      pedestrianAuditClock.value += dt * 1000;
      // The shared script: stand in the street, step outside every declared active
      // radius, then come back. The board is told nothing — the radius decides.
      const origin = world.pedestrianAuditOrigin();
      const at = pedestrianAuditPlayerAt(index, steps, worldPedestrianAuditScript());
      player.setPosition(origin.x + at.x, origin.z + at.z);
      player.update(dt);
      world.update(player.position, camera, renderer.domElement.height, pedestrianAuditClock.value);
      updatePedestrianHud();
    },
    sample: index => {
      const record = world.pedestrianSample(index);
      const text = pedestrianHudText(world.pedestrianSummary ?? {});
      return {
        ...record,
        // The HUD half of the gate: the DOM line is the board's own copy, so what
        // the player reads is what the audit measured.
        hudText: pedestrianTitleElement?.textContent ?? '',
        hudDetail: pedestrianDetailElement?.textContent ?? '',
        hudTracksBoard: (pedestrianTitleElement?.textContent ?? '').startsWith(text.text),
      };
    },
    context: () => world.pedestrianAuditContext(),
    expect: {
      profile: world.profile,
      maxAgents: world.pedestrians?.limits.maxAgents,
      farPoint: world.pedestrianAuditScript().found,
    },
  });
  const runPedestrianAudit = options => {
    const report = pedestrianAudit.run(options);
    world.pedestrianAuditSummary = pedestrianAudit.summary();
    logger.info('audit', 'pedestrian audit complete', {
      ok: report.ok, samples: report.samples, fingerprint: report.fingerprint,
      spawns: report.spawns, recycles: report.recycles, live: report.liveAgents,
      failed: report.verdicts.filter(verdict => !verdict.ok).map(verdict => verdict.id),
    });
    return report;
  };

  const runWeatherAudit = options => {
    const report = weatherAudit.run(options);
    world.weatherAuditSummary = weatherAudit.summary();
    logger.info('audit', 'weather audit complete', {
      ok: report.ok, samples: report.samples, fingerprint: report.fingerprint,
      states: report.states, transitions: report.transitions,
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
        // `DET-10`: the placed props, their triggers, and the registered verb.
        props: {
          families: world.stats.propFamilies,
          placements: world.stats.propPlacements,
          tiles: world.stats.propTiles,
          triggers: world.stats.propTriggers,
          triggerCeiling: world.stats.propTriggerCeiling,
          solidBoxes: world.stats.propSolidBoxes,
          interaction: world.propInteraction,
        },
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
        // `GME-08`: the day's objectives, what they were grounded in, and what
        // was refused because the resident context could not prove the affordance.
        // `ENV-04`: the live weather state, its climate, and what the profile
        // refused to render this frame.
        weather: world.weather ? {
          ...world.weather.describe(),
          diagnostics: world.weather.diagnostics(),
          limits: world.weather.limits,
          fallback: world.weather.fallback,
        } : null,
        weatherState: world.weather ? { ...world.weather.state } : null,
        weatherAudit: weatherAudit.summary(),
        activities: world.activitySummary ? { ...world.activitySummary } : null,
        activitiesDiagnostics: world.activities ? { ...world.activities.diagnostics() } : null,
        pedestrians: world.pedestrianSummary ? { ...world.pedestrianSummary } : null,
        pedestrianDiagnostics: world.pedestrians ? world.pedestrians.diagnostics : null,
        pedestrianPools: world.pedestrianPools?.diagnostics ?? null,
        activityRefusals: world.activities?.refusals ?? null,
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
      activities: options => runActivityAudit(options),
      weather: options => runWeatherAudit(options),
      pedestrians: options => runPedestrianAudit(options),
    },
    extras: {
      world, player, camera, renderer,
      movementAudit,
      snapshot: () => world.movementSnapshot({ camera, renderer, cameraMode: player.cameraMode }),
      // `CNT-03`: the content tool is reachable from a browser console, so a
      // contributor can paste a pack or a landmark recipe and read the same
      // verdict the CLI prints.
      ...createContentValidatorExtras({ providers: providers ?? null, profile: profile ?? 'low' }),
      // `LAY-06`: the fade policy is reachable from a debug session, and the
      // avatar shares it.
      cameraFade: world.cameraFade?.diagnostics ?? null,
      // `GME-08`: run the activity audit from the console and read its verdicts.
      runActivityAudit: options => runActivityAudit(options),
      activityAuditSummary: () => world.activityAuditSummary ?? null,
      // `ENV-04`: run the weather audit from the console, and drive the machine
      // directly for a side-by-side look at the sky.
      runWeatherAudit: options => runWeatherAudit(options),
      weatherAuditSummary: () => world.weatherAuditSummary ?? null,
      weather: world.weather,
      // `LIF-04`: run the pedestrian audit from the console and read the live board.
      runPedestrianAudit: options => runPedestrianAudit(options),
      pedestrianAuditSummary: () => world.pedestrianAuditSummary ?? null,
      pedestrians: world.pedestrians,
      pedestrianSample: index => world.pedestrianSample(index),
    },
  });
  if (debugHooks) logger.info('debug', 'hook installed', { key: '__gdo', audits: ['movement', 'silhouette', 'timeOfDay', 'activities', 'weather', 'pedestrians'] });

  return {
    scene, camera, renderer, world, player,
    lifecycle,
    logger,
    debugHooks: debugSurface,
    runMovementAudit,
    runWeatherAudit,
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
