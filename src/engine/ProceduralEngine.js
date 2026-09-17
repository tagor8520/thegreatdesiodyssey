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

export function createProceduralSky(scene) {
  const geometry = new THREE.SphereGeometry(900, 20, 10);
  const material = new THREE.ShaderMaterial({
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
      void main() {
        vec3 direction = normalize(vSkyDirection);
        float height = clamp(direction.y * 0.72 + 0.30, 0.0, 1.0);
        vec3 horizon = vec3(0.22, 0.42, 0.52);
        vec3 middle = vec3(0.12, 0.34, 0.58);
        vec3 zenith = vec3(0.03, 0.18, 0.42);
        vec3 sky = mix(horizon, middle, smoothstep(0.0, 0.48, height));
        sky = mix(sky, zenith, smoothstep(0.48, 1.0, height));
        vec3 sunDirection = normalize(vec3(-0.48, 0.78, 0.30));
        float glow = pow(max(dot(direction, sunDirection), 0.0), 24.0);
        float disc = pow(max(dot(direction, sunDirection), 0.0), 640.0);
        sky += vec3(1.0, 0.58, 0.24) * glow * 0.22 + vec3(1.0, 0.88, 0.58) * disc * 1.3;
        vec2 cloudCell = floor(direction.xz / max(0.16, direction.y + 0.32) * 13.0);
        float cloudNoise = fract(sin(dot(cloudCell, vec2(41.7, 289.1))) * 43758.5453);
        float cloudBand = smoothstep(0.08, 0.24, direction.y) * (1.0 - smoothstep(0.62, 0.84, direction.y));
        float blockCloud = step(0.62, cloudNoise) * cloudBand * 0.58;
        sky = mix(sky, vec3(0.82, 0.86, 0.84), blockCloud);
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
