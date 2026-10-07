import * as THREE from 'three';
import {
  createProceduralEngine, createProceduralLightRig, createProceduralSky, GDO_PALETTE,
} from '../engine/ProceduralEngine.js';
import {
  TimeOfDay, applyStarUniforms, applyTimeOfDay, bindTimeOfDayUniforms,
} from '../engine/TimeOfDay.js';
import {
  WeatherState, applyWeather, bindWeatherUniforms, climateForLatitude, weatherSeedForCoordinate,
} from '../engine/WeatherState.js';
import { GeoWorld } from './GeoWorld.js';
import { GEO_QUERY_MASK } from './GeoCollision.js';
import { GeoPlayer } from './GeoPlayer.js';
import { mountTouchControls } from '../engine/TouchControls.js';
import { validateCoordinate } from './GeoMath.js';
import {
  LabelLosScheduler, compassBearing, formatMetres,
} from './GeoLabelLos.js';
import { DiscoveryJournal, GEO_DISCOVERY_MAX_RADIUS } from '../engine/DiscoveryJournal.js';
// `NET-01`: the session survives a reload. The store is created before the world so a restored
// setting (`showDebug`) can decide what the mount does, and the journal is restored into as soon
// as it exists — the dependencies were designed for this (`GME-06`'s ids are stable across
// sessions precisely so a save can name a place rather than a moment).
import {
  SaveStore, captureDiscovery, restoreDiscovery,
} from '../engine/SaveState.js';
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
  // `NET-01`: one store per mounted runtime. `read()` runs before anything is constructed because
  // a restored setting has to be able to change the mount itself, and a document this build
  // cannot read is reported rather than acted on.
  const saveStore = new SaveStore();
  const saveReport = saveStore.read();
  const engine = createProceduralEngine(container, {
    ariaLabel: `Procedural OpenStreetMap world at ${coordinate.latitude}, ${coordinate.longitude}`,
    canvasClass: 'geo-game-canvas',
    antialias: false,
    powerPreference: 'low-power',
    fov: 68,
    near: .02,
    far: 210,
    // `ENV-02`: the dome is uniform-driven now, so it is built with the shared sky
    // handle's uniforms and a time-of-day state points at them below.
    sky: false,
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
  // `ENV-04`: the clear-weather fog range. The weather receives it and shortens `near`/`far`
  // from these values, so a clear frame is bit-for-bit the pre-weather fog and the mutation is
  // always recomputed from the baseline rather than from the previous frame's result.
  const GEO_FOG_NEAR = 78, GEO_FOG_FAR = 175;
  scene.fog = new THREE.Fog(GDO_PALETTE.fog, GEO_FOG_NEAR, GEO_FOG_FAR);
  const lightRig = createProceduralLightRig(scene, {
    shadows: false,
    sunIntensity: 2.25,
    hemisphereIntensity: 1.0,
    scale: .32,
  });
  // `ENV-02` time of day. The clock starts at solar noon for this coordinate, so the
  // default frame is the daylight the fixed sky used to hard-code; a caller can set it.
  const sky = createProceduralSky(scene);
  const timeOfDay = new TimeOfDay({
    profile: 'low',
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
    dayOfYear: 172,
    timeScale: 0,
  });
  bindTimeOfDayUniforms(sky, timeOfDay.state);
  /**
   * `ENV-04` weather.
   *
   * The schedule is a function of the coordinate — the same seed at the same latitude and
   * longitude, whichever session or device asks — the macro climate the latitude and the
   * season imply, and the **time-of-day clock**, so the weather and the light can never
   * disagree about what time it is. `timeScale` is zero in this runtime, which means the
   * weather is frozen at solar noon unless a caller moves the clock: no transition happens
   * on a frame the player did not ask for, and the frame cost of the whole feature on a
   * still clock is one comparison.
   *
   * The provider is part of the seed because the terrain is: the same coordinates served by a
   * different map source are a different world and may reasonably have different weather.
   */
  const weather = new WeatherState({
    profile: 'low',
    seed: weatherSeedForCoordinate({
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      provider: providers?.[0]?.id ?? '',
    }),
    climate: climateForLatitude(coordinate.latitude, timeOfDay.dayOfYear),
    minutes: timeOfDay.minutes,
    // The calendar belongs to the time-of-day state, so the weather reads the day from the
    // same place it reads the hour: a schedule that advanced its own day would be a second
    // clock, and two clocks is how a sun and a sky end up disagreeing.
    day: timeOfDay.dayOfYear,
  });
  bindWeatherUniforms(sky, weather.state);

  /**
   * How much of the ambient budget each phase spends.
   *
   * `AGENTS.md` item 6: a dusk or night state winds the ambience down through
   * `world.setAmbientActivity()` — the hook `LIF-02` built — rather than through a second
   * animation controller. Birds and insects roost at night instead of being switched off,
   * so the scheduler still draws a few and the transition is a change of *budget* rather
   * than of code path. The values are deliberately mild: this is ambience, not a spawn gate.
   */
  const GEO_AMBIENT_ACTIVITY_BY_PHASE = Object.freeze({
    night: 0.35, 'blue-hour': 0.6, sunset: 1, 'low-sun': 1, golden: 1, day: 1,
  });
  let ambientActivity = 1;
  let ambientSpeciesKey = '';
  // `ENV-04`: whether the world exists yet. The first apply happens before `GeoWorld` is
  // constructed — it has to, the world builds under the shipped lighting — so the ambient
  // budget and the water material are only reachable from the second apply onward.
  let worldReady = false;
  // The water handle the weather writes its ripple and wetness through. Null until the world
  // exists, which is why `applyWeather` is called with a possibly-absent handle rather than
  // the material itself.
  let weatherWater = null;
  let lastWeatherMilliseconds = null;
  const applyTimeOfDayState = now => {
    applyTimeOfDay(timeOfDay.state, { lightRig, scene, renderer, scale: .32 });
    applyStarUniforms(sky, timeOfDay.state);
    // `ENV-04`: the weather composes **on top of** the time-of-day state and writes absolute
    // values, so the two can be applied in either order and a repeated apply cannot compound.
    // `deltaSeconds` is real elapsed time since the previous weather write, clamped: the sky's
    // cloud drift advances by wall time, not by how often the uniforms happened to be written.
    const elapsed = lastWeatherMilliseconds === null || !Number.isFinite(now)
      ? 0 : Math.min(Math.max((now - lastWeatherMilliseconds) / 1000, 0), .5);
    applyWeather(timeOfDay.state, weather.state, {
      sky,
      scene,
      lightRig,
      renderer,
      water: weatherWater,
      fogNear: GEO_FOG_NEAR,
      fogFar: GEO_FOG_FAR,
      deltaSeconds: elapsed,
    });
    lastWeatherMilliseconds = Number.isFinite(now) ? now : lastWeatherMilliseconds;
    weather.markApplied();
    const activity = GEO_AMBIENT_ACTIVITY_BY_PHASE[timeOfDay.state.phase] ?? 1;
    // `AGENTS.md` item 6: the habitat response rides the same `setAmbientActivity` channel.
    // The phase decides the budget and the weather decides how each species spends it, so a
    // storm at noon has the day's budget at a tenth of the birds — one code path, two inputs.
    const species = weather.speciesActivity();
    const speciesKey = `${species.bird}|${species.bee}`;
    if (worldReady && (activity !== ambientActivity || speciesKey !== ambientSpeciesKey)) {
      ambientActivity = world.setAmbientActivity(activity, species);
      ambientSpeciesKey = speciesKey;
    }
    timeOfDay.markApplied();
  };
  applyTimeOfDayState();

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
    // `LIF-02`: the ambient-fauna budget follows the same profile as the dynamic-proxy
    // cap. It is a separate option so a future quality ladder can scale the two
    // independently, but it defaults to the same low tier today.
    ambientProfile: dynamicProxyProfile,
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
  // `ENV-04`: the world exists, so the weather can reach its water and the ambient budget.
  weatherWater = { material: world.waterMaterial };
  worldReady = true;
  applyTimeOfDayState();
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
    const enabled = !(debugRequested && (debugOverlay?.enabled ?? true));
    setDebugEnabled(enabled);
    // `NET-01`: the panel state is one of the two shipped settings, and this is the only place
    // it changes — the button and F3 both arrive here (`GME-05`'s registry routes the key), so
    // the save cannot be written from one surface and not the other.
    saveStore.update(save => { save.settings.showDebug = enabled; });
  };
  // The `F3` binding lives in the action registry, not here: `ActionInput` resolves
  // the code and calls `onDebugToggle`, which is the same `toggleDebug` the button
  // uses. One keymap, one handler, two surfaces.
  debugButton.addEventListener('click', toggleDebug);
  let initialDebug = false;
  try { initialDebug = new URLSearchParams(window.location.search).get('debug') === '1'; } catch { /* optional */ }
  // `?debug=1` still wins for a capture, but a saved preference opens the panel too: this is the
  // one place a `NET-01` setting is visible in the frame rather than only in diagnostics.
  setDebugEnabled(initialDebug || saveStore.save.settings.showDebug === true);

  const projectedLabel = new THREE.Vector3();
  const labelElements = [];
  let displayedLabels = [], nextLabelRefresh = 0;
  let nearestPlace = null;
  // `GME-04`: the DOM label layer does not take part in WebGL depth, so a name
  // would otherwise draw straight through the building in front of it. The
  // scheduler is budgeted per the layering research (20 tests/second and 5 labels
  // at the low profile) and asks only for `LOS_BLOCKER`, so a pickup or a bird
  // between the eye and a name cannot blank it.
  // `GME-06`: walking into a named place records it. The journal is fed the labels the
  // runtime is already showing — `displayedLabels`, refreshed every 250ms, is passed as the
  // candidate array itself, so the per-frame cost is one squared-distance test per visible
  // name and no allocation at all. What it holds is bounded by its own capacity, never by
  // how far the player has walked.
  const discoveryJournal = new DiscoveryJournal();
  // `NET-01`: the place the player walked into last session is already journalled. `restoreDiscovery`
  // re-derives every id from its own anchor and refuses an entry that does not match, so this is
  // the only path by which an entry can enter the journal without the runtime having derived it.
  const saveRestore = restoreDiscovery(discoveryJournal, saveStore.save.discovery);
  // `GME-06`: discovery is a **radius test over the resident labels**, not over the names the
  // HUD chose to draw. The label layer shows at most 14 names by static map priority, so a
  // journal fed from the displayed set would leave a place undiscoverable whenever fourteen
  // higher-priority names were on screen — the browser gate caught exactly that as a
  // second-session flake. The candidate array is reused, so a refresh allocates nothing, and
  // the per-refresh cost is one distance test per resident label (≤ 18 per tile).
  // `NET-01`: the mount itself is progress — the landing shell resumes from these two fields,
  // and they are written once per mount rather than per frame.
  saveStore.update(save => {
    save.progress.lastMode = 'coordinate';
    save.progress.lastCoordinate = { latitude: coordinate.latitude, longitude: coordinate.longitude };
  });
  const discoveryCandidates = [];
  const gatherDiscoveryCandidates = position => {
    discoveryCandidates.length = 0;
    const limit = GEO_DISCOVERY_MAX_RADIUS * GEO_DISCOVERY_MAX_RADIUS;
    for (const tile of world.tiles.values()) {
      for (const label of tile.labels) {
        const dx = label.x - position.x, dz = label.z - position.z;
        if (dx * dx + dz * dz > limit) continue;
        discoveryCandidates.push(label);
      }
    }
    return discoveryCandidates;
  };
  const labelLos = new LabelLosScheduler({
    profile: 'low',
    sweep: (x, y, z, dx, dy, dz, radius, out, mask) => world.sweepSphere(x, y, z, dx, dy, dz, radius, out, mask),
  });
  const updateMapLabels = now => {
    let labelsRefreshed = false;
    if (now >= nextLabelRefresh) {
      displayedLabels = world.visibleLabels;
      nextLabelRefresh = now + 250;
      labelsRefreshed = true;
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
    // The journal reads the same resident labels the layer draws, so a name that is on
    // screen is a name that can be discovered, and a place the tiles have dropped is only
    // remembered (the journal's whole point) rather than re-derived from a label that has
    // streamed away. It runs on the label refresh rather than every frame: the candidate set
    // only changes four times a second, and a journal that re-offered the same names sixty
    // times a second would spend the same answer sixty times.
    if (labelsRefreshed) {
      const found = discoveryJournal.update(player.position, gatherDiscoveryCandidates(player.position), { now });
      // A journal that changed is a save that changed: the section is rebuilt from the live
      // journal on the same 250 ms refresh the discovery itself runs on, so the document cannot
      // drift from what the player has actually been shown.
      if (found > 0) saveStore.update(save => { save.discovery = captureDiscovery(discoveryJournal); });
    }
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
    // `ENV-02`: at most one uniform write per profile interval, and only when the state
    // actually moved, so a frozen clock writes nothing however fast the frame runs.
    const timeChanged = timeOfDay.update(dt, now);
    // `ENV-04`: the weather reads the same clock. It is a pure function of the clock, so a
    // still clock is a still sky: the write below is refused before it reaches the GPU.
    weather.setClock(timeOfDay.minutes, timeOfDay.dayOfYear);
    const weatherChanged = weather.update(now);
    if (timeChanged || weatherChanged) applyTimeOfDayState(now);
    player.update(dt);
    world.update(player.position, camera, renderer.domElement.height, now);
    // `NET-01`: a tick, not a write. The store is dirty-tracked and interval-coalesced, so
    // however many frames run, the document is written at most once a second and only when
    // something in it moved.
    saveStore.tick();
    debugOverlay?.update(world, player.position, renderer, now, {
      labels: labelLos.diagnostics(now),
      timeOfDay: timeOfDay.diagnostics(),
      weather: weather.diagnostics(),
      discoveries: discoveryJournal.diagnostics(),
      save: saveStore.diagnostics(),
    });
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
    // `ENV-02`: the runtime's clock and light state. Exposed because the gate has to
    // move the clock, read what the runtime decided, and compare that against the pixels
    // it rendered — a gate that only read the model would be checking the model.
    get timeOfDay() { return timeOfDay; },
    get sky() { return sky; },
    /**
     * Set the clock in UTC minutes and apply immediately, bypassing the rate ceiling.
     *
     * The weather rides the same clock, so a jump moves both: `ENV-02`'s gate moves the sun to
     * the night and this one moves the sky to a storm through the same call, and neither can
     * end up out of step with the other.
     */
    setClockMinutes(minutes) {
      timeOfDay.setClock(minutes);
      timeOfDay.sample();
      weather.setClock(minutes, timeOfDay.dayOfYear);
      weather.sample();
      applyTimeOfDayState(performance.now());
      return timeOfDay.diagnostics();
    },
    get timeOfDayDiagnostics() { return timeOfDay.diagnostics(); },
    // `ENV-04`: the weather model, its report, and one bypass of the write ceiling for a gate
    // or a capture. Exposed the same way `ENV-02` exposed the clock: the gate has to be able to
    // stand in a climate and read what the runtime decided, then compare that against pixels.
    // `weatherState` is a copy on purpose — a caller can read it without being able to hold a
    // reference to the live object the apply path writes.
    get weather() { return weather; },
    get weatherState() { return { ...weather.state }; },
    get weatherDiagnostics() { return weather.diagnostics(); },
    /** Re-seed, re-climate or re-sample at the current clock without waiting for a change. */
    refreshWeather() {
      weather.sample();
      applyTimeOfDayState(performance.now());
      return { ...weather.state };
    },
    /** The ambient budget the current phase is spending (`AGENTS.md` item 6). */
    get ambientActivity() { return world.ambientActivity; },
    // `GME-06`: the journal itself and its report. The gate drives it through the runtime's
    // own object rather than a copy, so what it measures is what the player would carry.
    get discoveryJournal() { return discoveryJournal; },
    get discoveries() { return discoveryJournal.diagnostics(); },
    /** The names the runtime is currently showing, which are the journal's candidates. */
    get visiblePlaces() { return displayedLabels.map(label => ({ name: label.name, kind: label.kind, x: label.x, z: label.z })); },
    /** The resident labels inside the discovery radius — what the journal actually reads. */
    get discoverablePlaces() { return gatherDiscoveryCandidates(player.position).map(label => ({ name: label.name, kind: label.kind, x: label.x, z: label.z })); },
    // The collision vocabulary the label ray is filtered by. An audit that wants to
    // reproduce the label query must ask for the *same* mask rather than hard-coding
    // a bit, so the mask is part of the runtime's public surface.
    get queryMasks() { return GEO_QUERY_MASK; },
    get debugOverlay() { return debugOverlay; },
    // `NET-01`: the store, its report, one forced write and one destructive action. The gate
    // drives all four rather than reading a copy: what it measures has to be what the player
    // would carry to the next session.
    get saveStore() { return saveStore; },
    get save() { return saveStore.save; },
    get saveDiagnostics() { return saveStore.diagnostics(); },
    get saveReport() { return saveReport; },
    get saveRestore() { return saveRestore; },
    /** Write the document now, bypassing the interval — a capture or a scenario's checkpoint. */
    saveNow() { return saveStore.write({ force: true }); },
    clearSave() { return saveStore.clear(); },
    dispose() {
      if (disposed) return; disposed = true;
      cancelAnimationFrame(animationFrame); observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);

      debugButton.removeEventListener('click', toggleDebug);
      canvas.removeEventListener('webglcontextlost', contextLost); canvas.removeEventListener('webglcontextrestored', contextRestored);
      exitButton.removeEventListener('click', exit);
      touchControls.dispose();
      longTaskObserver?.disconnect();
      // On the way out, the last change is written rather than left for the next tick: an exit
      // is exactly the moment a session's progress has just changed and the frame loop is about
      // to stop. `flush` ignores the interval and is still a no-op when nothing is dirty.
      saveStore.flush();
      debugOverlay?.dispose(); player.dispose(); world.dispose(); lightRig.dispose(); sky.dispose(); engine.dispose();
    },
  };
}
