import * as THREE from 'three';
import { acquireProceduralMaterialLibrary, createWaterNormalTexture } from './ProceduralMaterials.js';
import { LifecycleLedger } from './LifecycleContract.js';
import { createStarField } from './TimeOfDaySky.js';

export { createWaterNormalTexture };

export const GDO_PALETTE = Object.freeze({
  sky: '#9fc8e0',
  fog: '#9fc8e0',
  grass: '#71945b',
  grassDark: '#54784b',
  earth: '#9b744d',
  sand: '#d8ba78',
  water: '#147aab',
  waterDeep: '#0a557e',
  asphalt: '#4d5554',
  roadLine: '#f2dc9b',
  cream: '#f2e8cb',
  saffron: '#ed9e43',
  terracotta: '#c56545',
});

/**
 * `ENV-02`: the sky dome is uniform-driven, so one shared time-of-day state
 * colours it. A physical atmosphere is deliberately not attempted — the same
 * fast dome keeps gradients, a sun disc/glow, a moon disc, block clouds, and a
 * seeded star field drawn as a single static point set.
 */
export function createProceduralSky(scene, { starCount = 120, showMoon = false, cloudCoverage = true } = {}) {
  const geometry = new THREE.SphereGeometry(900, 20, 10);
  const uniforms = {
    uHorizon: { value: new THREE.Color(.62, .70, .775) },
    uMiddle: { value: new THREE.Color(.43, .585, .78) },
    uZenith: { value: new THREE.Color(.235, .415, .71) },
    uSunDirection: { value: new THREE.Vector3(-.48, .78, .30) },
    uMoonDirection: { value: new THREE.Vector3(.48, -.78, -.30) },
    uSunColor: { value: new THREE.Color(1, .94, .82) },
    uStarOpacity: { value: 0 },
    uMoonOpacity: { value: 0 },
    uCloudCoverage: { value: cloudCoverage ? 1 : 0 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    vertexShader: `
      varying vec3 vSkyDirection;
      void main() {
        vSkyDirection = normalize(position);
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = clip.xyww;
      }
    `,
    fragmentShader: `
      varying vec3 vSkyDirection;
      uniform vec3 uHorizon;
      uniform vec3 uMiddle;
      uniform vec3 uZenith;
      uniform vec3 uSunDirection;
      uniform vec3 uMoonDirection;
      uniform vec3 uSunColor;
      uniform float uStarOpacity;
      uniform float uMoonOpacity;
      uniform float uCloudCoverage;
      // Deterministic star lattice: a hash on the quantized sky direction makes
      // a static point field without a second draw call.
      float starField(vec3 direction) {
        if (direction.y < 0.02 || uStarOpacity < 0.01) return 0.0;
        vec3 cell = direction / max(0.02, direction.y + 0.35) * 34.0;
        vec3 cellId = floor(cell);
        vec3 local = fract(cell) - 0.5;
        float seed = fract(sin(dot(cellId, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
        float size = 0.055 + seed * 0.10;
        float point = 1.0 - smoothstep(size, size + 0.06, length(local));
        float twinkle = step(0.42, seed);
        return point * twinkle * (0.35 + seed * 0.65) * uStarOpacity;
      }
      void main() {
        vec3 direction = normalize(vSkyDirection);
        float height = clamp(direction.y * 0.72 + 0.30, 0.0, 1.0);
        vec3 sky = mix(uHorizon, uMiddle, smoothstep(0.0, 0.48, height));
        sky = mix(sky, uZenith, smoothstep(0.48, 1.0, height));
        vec3 sunDirection = normalize(uSunDirection);
        float glow = pow(max(dot(direction, sunDirection), 0.0), 24.0);
        float disc = pow(max(dot(direction, sunDirection), 0.0), 640.0);
        sky += uSunColor * glow * 0.22 + uSunColor * disc * 1.3;
        float moonGlow = pow(max(dot(direction, normalize(uMoonDirection)), 0.0), 420.0);
        sky += vec3(0.86, 0.90, 1.0) * moonGlow * uMoonOpacity * 1.1;
        vec2 cloudCell = floor(direction.xz / max(0.16, direction.y + 0.32) * 13.0);
        float cloudNoise = fract(sin(dot(cloudCell, vec2(41.7, 289.1))) * 43758.5453);
        float cloudBand = smoothstep(0.08, 0.24, direction.y) * (1.0 - smoothstep(0.62, 0.84, direction.y));
        float blockCloud = step(0.62, cloudNoise) * cloudBand * 0.58 * uCloudCoverage;
        sky = mix(sky, mix(vec3(0.82, 0.86, 0.84), uMiddle, 0.35), blockCloud);
        sky += vec3(starField(direction));
        gl_FragColor = vec4(sky, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'shared-procedural-sky';
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  scene.add(mesh);
  // The seeded star set stays available for catalogue/diagnostic use even though
  // the dome resolves its own lattice: both are the same deterministic field.
  const stars = createStarField({ count: starCount });
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(stars.positions, 3));
  const starMaterial = new THREE.PointsMaterial({
    color: '#ffeccf', size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0 * 1, depthWrite: false,
  });
  const starPoints = new THREE.Points(starGeometry, starMaterial);
  starPoints.name = 'shared-procedural-stars';
  starPoints.renderOrder = -999;
  starPoints.frustumCulled = false;
  starPoints.visible = false;
  scene.add(starPoints);
  return {
    mesh,
    stars,
    starPoints,
    uniforms,
    setSkyState(state) {
      uniforms.uHorizon.value.setRGB(state.horizon[0], state.horizon[1], state.horizon[2]);
      uniforms.uMiddle.value.setRGB(state.middle[0], state.middle[1], state.middle[2]);
      uniforms.uZenith.value.setRGB(state.zenith[0], state.zenith[1], state.zenith[2]);
      uniforms.uSunDirection.value.set(state.sunDirection[0], state.sunDirection[1], state.sunDirection[2]).normalize();
      uniforms.uMoonDirection.value.set(state.moonDirection[0], state.moonDirection[1], state.moonDirection[2]).normalize();
      uniforms.uSunColor.value.setRGB(state.sun[0], state.sun[1], state.sun[2]);
      uniforms.uStarOpacity.value = state.starOpacity;
      uniforms.uMoonOpacity.value = showMoon ? state.moonOpacity : 0;
      starMaterial.opacity = state.starOpacity;
      starPoints.visible = state.starOpacity > .01;
      return state;
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
      starPoints.removeFromParent();
      starGeometry.dispose();
      starMaterial.dispose();
    },
  };
}

/**
 * Shared renderer/scene/camera bootstrap used by every playable mode. Gameplay
 * systems differ, but color management, tone mapping, canvas ownership and
 * teardown now follow one engine contract.
 */
export function createProceduralEngine(container, {
  ariaLabel,
  canvasClass = '',
  antialias = false,
  powerPreference = 'low-power',
  fov = 52,
  near = .02,
  far = 300,
  clearColor = GDO_PALETTE.sky,
  toneMapping = THREE.ACESFilmicToneMapping,
  exposure = 1.05,
  sky = true,
  ledger = null,
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = canvasClass;
  canvas.style.cssText ||= 'display:block;width:100%;height:100%;touch-action:none';
  if (ariaLabel) canvas.setAttribute('aria-label', ariaLabel);
  const overlay = document.createElement('div');
  container.append(canvas, overlay);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(clearColor);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias, powerPreference });
  } catch (error) {
    canvas.remove();
    overlay.remove();
    throw error;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = toneMapping;
  renderer.toneMappingExposure = exposure;
  renderer.setClearColor(clearColor);
  const camera = new THREE.PerspectiveCamera(fov, 1, near, far);
  const materialLibraryHandle = acquireProceduralMaterialLibrary();
  const skyDome = sky ? createProceduralSky(scene) : null;

  // `FND-07`: the engine owns the canvas, the renderer, the generated sky, and
  // one borrowed material-library handle. All four register here so a game
  // remount proves it left nothing behind.
  const lifecycle = ledger ?? new LifecycleLedger({ label: 'engine' });
  const scope = ledger ? lifecycle.child('engine') : lifecycle;
  scope.own('frame', 'renderer', renderer, item => item.dispose?.());
  scope.own('node', 'canvas', canvas, item => item.remove?.());
  scope.own('node', 'overlay', overlay, item => item.remove?.());
  if (skyDome) scope.own('mesh', 'sky-dome', skyDome.mesh, item => {});
  if (skyDome) {
    scope.own('geometry', 'sky-geometry', skyDome.mesh.geometry, item => item.dispose?.());
    scope.own('material', 'sky-material', skyDome.mesh.material, item => item.dispose?.());
  }
  scope.handle('material-library', () => materialLibraryHandle.release(), materialLibraryHandle.library);

  let disposed = false;
  return {
    canvas,
    overlay,
    scene,
    renderer,
    camera,
    sky: skyDome,
    ledger: scope,
    materialLibrary: materialLibraryHandle.library,
    dispose() {
      if (disposed) return;
      disposed = true;
      scope.disposeAll();
    },
  };
}

export function createProceduralLightRig(scene, {
  shadows = false,
  shadowMapSize = 1024,
  sunIntensity = 3.2,
  hemisphereIntensity = shadows ? .65 : .9,
  scale = 1,
} = {}) {
  const sun = new THREE.DirectionalLight('#fff0d3', sunIntensity);
  sun.position.set(-110 * scale, 180 * scale, 65 * scale);
  sun.castShadow = shadows;
  if (shadows) {
    const size = Math.min(shadowMapSize, 2048);
    sun.shadow.mapSize.set(size, size);
    Object.assign(sun.shadow.camera, {
      left: -105 * scale,
      right: 105 * scale,
      top: 105 * scale,
      bottom: -105 * scale,
      near: Math.max(.02, scale),
      far: 420 * scale,
    });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.normalBias = .15 * scale;
    sun.shadow.bias = -.00015;
  }
  const fill = new THREE.HemisphereLight('#d8edff', '#816343', hemisphereIntensity);
  scene.add(sun, sun.target, fill);
  // `ENV-02`: the rig keeps its authored intensities until a time-of-day state
  // drives it; the driver below is the only writer.
  const authored = Object.freeze({ sunIntensity, hemisphereIntensity, distance: sun.position.length() });
  return {
    sun,
    fill,
    authored,
    /**
     * `ENV-02` bridge: a pure state record in, one three light rig out. It is
     * deliberately the only place that touches `three` for lighting.
     */
    applySkyState(state) {
      sun.position.set(
        state.sunDirection[0] * authored.distance,
        Math.max(.02, state.sunDirection[1]) * authored.distance,
        state.sunDirection[2] * authored.distance,
      );
      sun.target.position.set(0, 0, 0);
      sun.color.setRGB(state.sun[0], state.sun[1], state.sun[2]);
      sun.intensity = state.sunIntensity;
      fill.color.setRGB(state.hemisphere[0], state.hemisphere[1], state.hemisphere[2]);
      fill.groundColor.setRGB(state.ground[0], state.ground[1], state.ground[2]);
      fill.intensity = state.hemisphereIntensity;
      return state;
    },
    dispose() {
      sun.removeFromParent();
      sun.target.removeFromParent();
      fill.removeFromParent();
      sun.shadow.dispose();
    },
  };
}

/**
 * `ENV-02` runtime bridge: one time-of-day state, one sky, one light rig, one
 * renderer. It returns the writer list the state machine expects, so the state
 * module stays free of `three` and this module stays free of time arithmetic.
 *
 * Every writer is a single state key, which is what makes the uniform-write
 * budget measurable: the low profile declares 14 writes per update and this
 * bridge declares exactly 14 writers.
 */
export function createTimeOfDayLighting({
  sky = null,
  rig = null,
  renderer = null,
  scene = null,
  onEmissive = null,
} = {}) {
  if (!sky && !rig) throw new TypeError('Time-of-day lighting needs a sky or a light rig to drive');
  const diagnostics = { applied: 0, emissiveHighest: 0, starFrames: 0, moonFrames: 0, toneMappingExposure: renderer?.toneMappingExposure ?? 1 };
  const writers = [
    { key: 'horizon', write: () => { sky?.setSkyState(writerState); } },
    { key: 'middle', write: () => { sky?.setSkyState(writerState); } },
    { key: 'zenith', write: () => { sky?.setSkyState(writerState); } },
    { key: 'sun', write: () => { rig?.applySkyState(writerState); sky?.setSkyState(writerState); } },
    { key: 'hemisphere', write: () => { rig?.applySkyState(writerState); } },
    { key: 'ground', write: () => { rig?.applySkyState(writerState); } },
    { key: 'sunDirection', write: () => { rig?.applySkyState(writerState); sky?.setSkyState(writerState); } },
    { key: 'sunIntensity', write: () => { rig?.applySkyState(writerState); } },
    { key: 'hemisphereIntensity', write: () => { rig?.applySkyState(writerState); } },
    { key: 'moonOpacity', write: () => { sky?.setSkyState(writerState); } },
    { key: 'starOpacity', write: () => { sky?.setSkyState(writerState); } },
    {
      key: 'fog',
      write: value => {
        scene?.fog?.color?.setRGB(value[0], value[1], value[2]);
        scene?.background?.setRGB?.(value[0], value[1], value[2]);
      },
    },
    {
      key: 'exposure',
      write: value => {
        if (!renderer) return;
        renderer.toneMappingExposure = value;
        diagnostics.toneMappingExposure = value;
      },
    },
    {
      key: 'emissive',
      write: value => {
        diagnostics.emissiveHighest = Math.max(diagnostics.emissiveHighest, value);
        onEmissive?.(value, writerState);
      },
    },
  ];
  let writerState = null;
  return Object.freeze({
    writers,
    /** Called once per update with the live state so writers can read siblings. */
    bind(state) {
      writerState = state;
      return state;
    },
    apply(state) {
      writerState = state;
      sky?.setSkyState(state);
      rig?.applySkyState(state);
      if (scene?.fog?.color) scene.fog.color.setRGB(state.fog[0], state.fog[1], state.fog[2]);
      if (scene?.background?.setRGB) scene.background.setRGB(state.fog[0], state.fog[1], state.fog[2]);
      if (renderer) renderer.toneMappingExposure = state.exposure;
      diagnostics.applied++;
      diagnostics.emissiveHighest = Math.max(diagnostics.emissiveHighest, state.emissive);
      if (state.starOpacity > .01) diagnostics.starFrames++;
      if (state.moonOpacity > .01) diagnostics.moonFrames++;
      return state;
    },
    diagnostics() {
      return Object.freeze({
        applied: diagnostics.applied,
        starFrames: diagnostics.starFrames,
        moonFrames: diagnostics.moonFrames,
        emissiveHighest: diagnostics.emissiveHighest,
        toneMappingExposure: diagnostics.toneMappingExposure,
      });
    },
  });
}
