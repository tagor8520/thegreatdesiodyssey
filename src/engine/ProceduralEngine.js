import * as THREE from 'three';
import { acquireProceduralMaterialLibrary, createWaterNormalTexture } from './ProceduralMaterials.js';

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
 * The shared sky dome.
 *
 * `ENV-02` turned this from a fixed shader into a **uniform-driven** one: every colour,
 * the sun and moon directions, star visibility and cloud cover are uniforms, and their
 * defaults reproduce the previous fixed look exactly, so a scene that never touches
 * them renders the same frame it did before. `bindTimeOfDayUniforms` points them at a
 * `TimeOfDay` state so a state change is a uniform write rather than a rebuild.
 *
 * Stars and the moon are drawn in the same fragment pass — a hashed direction field and
 * a disc term — so night costs **no extra draw call and no texture**, per §9.1's warning
 * that a multi-sample atmosphere is not appropriate for the low-end default.
 */
export function createProceduralSky(scene, {
  radius = 900,
  clouds = true,
} = {}) {
  const geometry = new THREE.SphereGeometry(radius, 20, 10);
  const uniforms = {
    uHorizon: { value: new THREE.Color(0.22, 0.42, 0.52) },
    uMiddle: { value: new THREE.Color(0.12, 0.34, 0.58) },
    uZenith: { value: new THREE.Color(0.03, 0.18, 0.42) },
    uSunColor: { value: new THREE.Color(1.0, 0.94, 0.83) },
    uSunDirection: { value: new THREE.Vector3(-0.48, 0.78, 0.30).normalize() },
    uMoonDirection: { value: new THREE.Vector3(0.48, 0.30, -0.30).normalize() },
    uStarVisibility: { value: 0 },
    uMoonVisibility: { value: 0 },
    uCloudCover: { value: clouds ? 0.38 : 0 },
  };
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms,
    vertexShader: `
      varying vec3 vSkyDirection;
      void main() {
        vSkyDirection = normalize(position);
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = clip.xyww;
      }
    `,
    fragmentShader: `
      uniform vec3 uHorizon;
      uniform vec3 uMiddle;
      uniform vec3 uZenith;
      uniform vec3 uSunColor;
      uniform vec3 uSunDirection;
      uniform vec3 uMoonDirection;
      uniform float uStarVisibility;
      uniform float uMoonVisibility;
      uniform float uCloudCover;
      varying vec3 vSkyDirection;

      // A cheap direction hash for the star field: no texture, no draw call, and it is
      // evaluated only where stars are visible at all.
      float gdoStarHash(vec3 cell) {
        vec3 mixed = fract(cell * 0.1031);
        mixed += dot(mixed, mixed.yzx + 33.33);
        return fract((mixed.x + mixed.y) * mixed.z);
      }

      void main() {
        vec3 direction = normalize(vSkyDirection);
        float height = clamp(direction.y * 0.72 + 0.30, 0.0, 1.0);
        vec3 sky = mix(uHorizon, uMiddle, smoothstep(0.0, 0.48, height));
        sky = mix(sky, uZenith, smoothstep(0.48, 1.0, height));
        float sunAlign = max(dot(direction, uSunDirection), 0.0);
        float glow = pow(sunAlign, 24.0);
        float disc = pow(sunAlign, 640.0);
        sky += uSunColor * glow * 0.22 + uSunColor * disc * 1.3 * step(0.001, uSunDirection.y);

        // Stars: quantised direction cells with one point each, faded in by the state
        // and only above the horizon. \`step\` guards keep this free when it is daytime.
        if (uStarVisibility > 0.001) {
          vec3 cell = floor(direction * 190.0);
          float seed = gdoStarHash(cell);
          vec3 local = fract(direction * 190.0) - 0.5;
          float point = 1.0 - smoothstep(0.04, 0.30, length(local));
          float twinkle = 0.65 + 0.35 * gdoStarHash(cell + 7.0);
          sky += vec3(0.90, 0.93, 1.00) * step(0.9972, seed) * point * twinkle *
            uStarVisibility * smoothstep(0.02, 0.16, direction.y);
        }

        // Moon: a disc plus a small halo, at the state's moon direction.
        if (uMoonVisibility > 0.001) {
          float moonAlign = max(dot(direction, uMoonDirection), 0.0);
          float moonDisc = smoothstep(0.99955, 0.99975, moonAlign);
          float moonHalo = pow(moonAlign, 220.0) * 0.10;
          sky += vec3(0.86, 0.89, 0.96) * (moonDisc * 0.85 + moonHalo) * uMoonVisibility *
            smoothstep(0.0, 0.10, direction.y);
        }

        vec2 cloudCell = floor(direction.xz / max(0.16, direction.y + 0.32) * 13.0);
        float cloudNoise = fract(sin(dot(cloudCell, vec2(41.7, 289.1))) * 43758.5453);
        float cloudBand = smoothstep(0.08, 0.24, direction.y) * (1.0 - smoothstep(0.62, 0.84, direction.y));
        float blockCloud = step(1.0 - uCloudCover, cloudNoise) * cloudBand * 0.58;
        sky = mix(sky, mix(vec3(0.82, 0.86, 0.84), uHorizon * 1.35 + 0.06, 0.55), blockCloud);
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
  return {
    mesh,
    uniforms,
    material,
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
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

  let disposed = false;
  return {
    canvas,
    overlay,
    scene,
    renderer,
    camera,
    sky: skyDome,
    materialLibrary: materialLibraryHandle.library,
    dispose() {
      if (disposed) return;
      disposed = true;
      skyDome?.dispose();
      materialLibraryHandle.release();
      renderer.dispose();
      canvas.remove();
      overlay.remove();
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
  return {
    sun,
    fill,
    dispose() {
      sun.removeFromParent();
      sun.target.removeFromParent();
      fill.removeFromParent();
      sun.shadow.dispose();
    },
  };
}
