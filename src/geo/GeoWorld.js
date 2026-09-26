import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GDO_FEATURE_VERSIONS, GDO_GENERATOR_VERSION } from '../engine/FeatureVersions.js';
import { PlantRenderPools } from '../engine/PlantRenderPools.js';
import { StreetFurniturePools } from './GeoStreetFurniturePools.js';
import { BridgePools } from './GeoBridgePools.js';
import { LandmarkPools } from './GeoLandmarkPools.js';
import {
  AmbientLifePools,
  GDO_AMBIENT_LIFE_SOURCE_TYPES,
} from '../engine/AmbientLifeMotion.js';
import {
  acquireProceduralMaterialLibrary,
  configureSemanticMaterial,
} from '../engine/ProceduralMaterials.js';
import { GEO_LAYER } from './GeoLayers.js';
import {
  GEO_DEFAULT_CROWN_ADAPTATION,
  GEO_PLANT_PLACEMENT_SCALE,
  GEO_PLANT_TYPE_FAMILIES,
} from './PlantClearance.js';
import {
  GDO_VEGETATION_MORPHOLOGY_NAMESPACE,
  GEO_MORPHOLOGY_STRIDE,
  decodeMorphologyScale,
} from './PlantMorphology.js';

export { GEO_PLANT_TYPE_FAMILIES } from './PlantClearance.js';
import {
  GEO_SUPPORT_SLOT_STRIDE,
  findPackedSupportSlot,
  releasePackedSupportSlot,
} from './GeoSupportSlots.js';
import {
  GEO_TERRAIN_DEFAULTS,
  buildTerrainGrid,
  queryTerrainSupport,
  terrainHeightAt,
  terrainSeedForCoordinate,
} from './GeoTerrain.js';
import {
  SOURCE_ZOOM,
  createGeoReference,
  worldToCoordinate,
  worldToTile,
  tileKey,
  wrapTileX,
  clampTileY,
} from './GeoMath.js';
import {
  GEO_QUERY_MASK,
  circleAabbPenetration,
  circleFootprintPenetration,
  circleIntersectsFootprint,
  sweepCircleAgainstFootprint,
  sweepPointAgainstAabb,
} from './GeoCollision.js';

export { circleIntersectsFootprint } from './GeoCollision.js';

export const GEO_STREAMING_LIMITS = Object.freeze({
  prefetchEdgeFraction: 0.2,
  maxResidentTiles: 4,
  maxActiveRequests: 2,
  collisionCellSize: 4,
});
const PREFETCH_EDGE_FRACTION = GEO_STREAMING_LIMITS.prefetchEdgeFraction;
const MAX_RESIDENT_TILES = GEO_STREAMING_LIMITS.maxResidentTiles;
const MAX_ACTIVE_REQUESTS = GEO_STREAMING_LIMITS.maxActiveRequests;
const COLLISION_CELL_SIZE = GEO_STREAMING_LIMITS.collisionCellSize;

const GEO_PLANT_TYPES = new Set(Object.keys(GEO_PLANT_TYPE_FAMILIES).map(Number));

function hashText(value, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function plantPlacementFromDecoration(
  owner, sourceIndex, values, index, groundHeight, clearanceValues, morphologyValues,
) {
  const type = Math.round(values[index + 3]);
  const family = GEO_PLANT_TYPE_FAMILIES[type];
  const id = `${owner}:plant:${sourceIndex.toString(36)}`;
  const seed = hashText(id);
  const sourceScale = values[index + 2] * GEO_PLANT_PLACEMENT_SCALE[type];
  const morphologyOffset = sourceIndex * GEO_MORPHOLOGY_STRIDE;
  const hasMorphology = morphologyValues instanceof Uint8Array &&
    morphologyOffset + GEO_MORPHOLOGY_STRIDE - 1 < morphologyValues.length;
  const scaleX = hasMorphology ? decodeMorphologyScale(morphologyValues[morphologyOffset]) : 1;
  const scaleY = hasMorphology ? decodeMorphologyScale(morphologyValues[morphologyOffset + 1]) : 1;
  const scaleZ = hasMorphology ? decodeMorphologyScale(morphologyValues[morphologyOffset + 2]) : 1;
  const clearanceOffset = sourceIndex * 4;
  const clearance = [...GEO_DEFAULT_CROWN_ADAPTATION];
  if (clearanceValues && clearanceOffset + 3 < clearanceValues.length &&
      Number.isFinite(clearanceValues[clearanceOffset]) && Number.isFinite(clearanceValues[clearanceOffset + 1]) &&
      Number.isFinite(clearanceValues[clearanceOffset + 2]) && Number.isFinite(clearanceValues[clearanceOffset + 3]) &&
      clearanceValues[clearanceOffset] > 0 && clearanceValues[clearanceOffset] <= 1 &&
      clearanceValues[clearanceOffset + 1] > 0 && clearanceValues[clearanceOffset + 1] <= 1 &&
      Math.abs(clearanceValues[clearanceOffset + 2]) <= 2 && Math.abs(clearanceValues[clearanceOffset + 3]) <= 2) {
    clearance[0] = clearanceValues[clearanceOffset];
    clearance[1] = clearanceValues[clearanceOffset + 1];
    clearance[2] = clearanceValues[clearanceOffset + 2];
    clearance[3] = clearanceValues[clearanceOffset + 3];
  }
  return Object.freeze({
    id,
    sourceType: type,
    placement: Object.freeze({
      family,
      archetypeIndex: hasMorphology
        ? morphologyValues[morphologyOffset + 3] % 2
        : Math.abs(Math.round(values[index + 5])) % 2,
      owner,
      position: Object.freeze([values[index], groundHeight, values[index + 1]]),
      yaw: values[index + 4],
      scale: Object.freeze([sourceScale * scaleX, sourceScale * scaleY, sourceScale * scaleZ]),
      paletteSlot: hasMorphology
        ? morphologyValues[morphologyOffset + 4] & 7
        : (Math.abs(Math.round(values[index + 5])) + (seed >>> 29)) & 7,
      age: hasMorphology ? morphologyValues[morphologyOffset + 5] / 255 : .62 + ((seed >>> 8) & 255) / 255 * .38,
      windStiffness: hasMorphology
        ? morphologyValues[morphologyOffset + 6] / 255
        : .35 + ((seed >>> 16) & 255) / 255 * .58,
      clearance: Object.freeze(clearance),
    }),
  });
}

function considerSweepHit(out, time, normalX, normalY, normalZ, tile, colliderIndex) {
  if (!Number.isFinite(time) || time < 0 || time > 1 || (out.hit && time >= out.time)) return;
  out.hit = true;
  out.time = time;
  out.normalX = normalX;
  out.normalY = normalY;
  out.normalZ = normalZ;
  out.tileKey = tile.key;
  out.polygonIndex = colliderIndex / 4;
}

function createBufferGeometry(data) {
  if (!data?.positions?.length || !data?.indices?.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  if (data.normals?.length) geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  if (data.colors?.length) geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function buildCollisionGrid(colliders) {
  const grid = new Map();
  const large = [];
  for (let index = 0; index < colliders.length; index += 4) {
    const minX = colliders[index], minZ = colliders[index + 1];
    const maxX = colliders[index + 2], maxZ = colliders[index + 3];
    const minCellX = Math.floor(minX / COLLISION_CELL_SIZE);
    const maxCellX = Math.floor(maxX / COLLISION_CELL_SIZE);
    const minCellZ = Math.floor(minZ / COLLISION_CELL_SIZE);
    const maxCellZ = Math.floor(maxZ / COLLISION_CELL_SIZE);
    if ((maxCellX - minCellX + 1) * (maxCellZ - minCellZ + 1) > 64) {
      large.push(index);
      continue;
    }
    for (let x = minCellX; x <= maxCellX; x++) for (let z = minCellZ; z <= maxCellZ; z++) {
      const key = `${x}:${z}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(index);
    }
  }
  return { grid, large };
}

export function buildRoadSupportGrid(values, stride = 8) {
  const grid = new Map(), large = [];
  if (!(values instanceof Float32Array) || stride !== 8 || values.length % stride !== 0) return { grid, large };
  for (let offset = 0; offset < values.length; offset += stride) {
    const halfWidth = values[offset + 6];
    const minCellX = Math.floor((Math.min(values[offset], values[offset + 3]) - halfWidth) / COLLISION_CELL_SIZE);
    const maxCellX = Math.floor((Math.max(values[offset], values[offset + 3]) + halfWidth) / COLLISION_CELL_SIZE);
    const minCellZ = Math.floor((Math.min(values[offset + 1], values[offset + 4]) - halfWidth) / COLLISION_CELL_SIZE);
    const maxCellZ = Math.floor((Math.max(values[offset + 1], values[offset + 4]) + halfWidth) / COLLISION_CELL_SIZE);
    if ((maxCellX - minCellX + 1) * (maxCellZ - minCellZ + 1) > 64) {
      large.push(offset);
      continue;
    }
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
      const key = `${cellX}:${cellZ}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(offset);
    }
  }
  return { grid, large };
}

function coloredBox(size, position, color, rotationY = 0, rotationZ = 0) {
  const geometry = new THREE.BoxGeometry(...size);
  geometry.rotateY(rotationY);
  geometry.rotateZ(rotationZ);
  geometry.translate(...position);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  for (let index = 0; index < geometry.attributes.position.count; index++) colors.set(color, index * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function createDecorationGeometry(type) {
  const pieces = [];
  if (type === 0) {
    pieces.push(coloredBox([.13, .48, .13], [0, .24, 0], [.16, .06, .02]));
    pieces.push(coloredBox([.62, .48, .58], [0, .60, 0], [.04, .19, .04]));
    pieces.push(coloredBox([.43, .38, .42], [.08, .92, -.03], [.07, .30, .06]));
  } else if (type === 1) {
    pieces.push(coloredBox([.10, 1.05, .10], [0, .52, 0], [.22, .08, .02], .08));
    for (let index = 0; index < 4; index++) {
      pieces.push(coloredBox([.82, .065, .16], [Math.cos(index * Math.PI / 2) * .23, 1.04, Math.sin(index * Math.PI / 2) * .23], [.05, .27, .05], index * Math.PI / 2));
    }
    pieces.push(coloredBox([.22, .20, .22], [0, 1.04, 0], [.11, .36, .05]));
  } else if (type === 2) {
    pieces.push(coloredBox([.42, .28, .38], [0, .14, 0], [.08, .21, .04]));
    pieces.push(coloredBox([.27, .22, .26], [.08, .32, -.04], [.16, .30, .05]));
  } else if (type === 3) {
    pieces.push(coloredBox([.045, .72, .045], [0, .36, 0], [.03, .04, .03]));
    pieces.push(coloredBox([.26, .045, .045], [.105, .70, 0], [.03, .04, .03]));
    pieces.push(coloredBox([.14, .13, .14], [.23, .66, 0], [1.0, .48, .06]));
  } else if (type === 4) {
    pieces.push(coloredBox([.34, .24, .29], [-.10, .12, 0], [.18, .15, .11], .18));
    pieces.push(coloredBox([.27, .32, .25], [.12, .16, -.04], [.28, .23, .16], -.22));
    pieces.push(coloredBox([.20, .15, .18], [.02, .29, .04], [.38, .31, .20], .1));
  } else if (type === 5) {
    pieces.push(coloredBox([.035, .34, .035], [0, .17, 0], [.04, .24, .03]));
    pieces.push(coloredBox([.16, .045, .08], [-.06, .18, 0], [.06, .32, .04], .45));
    pieces.push(coloredBox([.18, .16, .18], [0, .37, 0], [.92, .18, .08], .2));
    pieces.push(coloredBox([.07, .09, .07], [0, .38, .10], [1.0, .64, .08]));
  } else if (type === 6) {
    pieces.push(coloredBox([.62, .09, .20], [0, .32, 0], [.30, .12, .035]));
    pieces.push(coloredBox([.62, .08, .12], [0, .55, .08], [.42, .18, .05]));
    pieces.push(coloredBox([.07, .32, .07], [-.24, .16, 0], [.08, .05, .025]));
    pieces.push(coloredBox([.07, .32, .07], [.24, .16, 0], [.08, .05, .025]));
  } else if (type === 7) {
    pieces.push(coloredBox([.30, .16, .58], [0, .15, 0], [.72, .05, .025]));
    pieces.push(coloredBox([.25, .15, .28], [0, .29, -.02], [.04, .18, .29]));
    pieces.push(coloredBox([.33, .055, .11], [0, .30, -.18], [.58, .66, .70]));
    for (const x of [-.17, .17]) for (const z of [-.19, .19]) {
      pieces.push(coloredBox([.055, .13, .13], [x, .09, z], [.018, .02, .022]));
    }
  } else if (type === 8) {
    pieces.push(coloredBox([.52, .055, .13], [0, .055, 0], [.08, .40, .035], .42));
    pieces.push(coloredBox([.46, .05, .14], [.02, .075, .01], [.12, .48, .045], -.62));
    const sprouts = [[-.20,-.12,.24], [.15,-.16,.30], [-.04,.13,.38], [.24,.13,.22], [-.27,.16,.27]];
    for (let index = 0; index < sprouts.length; index++) {
      const [x, z, height] = sprouts[index];
      pieces.push(coloredBox([.04, height, .04], [x, height / 2, z], [.04, .30 + index * .018, .025]));
      pieces.push(coloredBox([.20, .045, .08], [x + (index % 2 ? -.055 : .055), height * .62, z], [.10, .46, .045], index * .7));
    }
  } else if (type === 9) {
    const grasses = [[-.28,-.18,.36], [-.12,.18,.51], [.06,-.08,.43], [.22,.18,.56], [.30,-.19,.32], [-.34,.12,.45]];
    for (let index = 0; index < grasses.length; index++) {
      const [x, z, height] = grasses[index];
      const color = index % 3 === 0 ? [.45, .37, .075] : [.18, .43, .05];
      pieces.push(coloredBox([.048, height, .048], [x, height / 2, z], color, index * .8, index % 2 ? .07 : -.07));
    }
  }
  // Ambient-life decoration types 10/11 are deliberately absent: birds and
  // bees render from the flat 2D sprite pools in `gdo:ambientLifeMotion:v1`
  // instead of per-tile 3D box clusters.
  const merged = mergeGeometries(pieces, false);
  for (const piece of pieces) piece.dispose();
  merged.computeBoundingSphere();
  return merged;
}

function createTerrainMaterial(vertexColors, library, semantic = 'ground') {
  const material = new THREE.MeshStandardMaterial({
    color: vertexColors ? '#ffffff' : '#668a55', vertexColors, roughness: 1, metalness: 0, side: THREE.DoubleSide,
  });
  return configureSemanticMaterial(material, semantic, library, 'low');
}

function createRoadMaterial(library) {
  // Unlit road colour is deliberate: markings and boundaries remain readable on
  // low-end devices even when the sun is behind the camera or normals overlap.
  return configureSemanticMaterial(
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    'road', library, 'low',
  );
}

function createBuildingMaterial(library) {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: .78,
    metalness: .02,
    side: THREE.FrontSide,
  });
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFacadePosition;\nvarying vec3 vFacadeNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacadePosition = position;\nvFacadeNormal = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vFacadePosition;
        varying vec3 vFacadeNormal;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float wall = 1.0 - smoothstep(0.36, 0.48, abs(vFacadeNormal.y));
        float alongPosition = abs(vFacadeNormal.x) > abs(vFacadeNormal.z) ? vFacadePosition.z : vFacadePosition.x;
        vec2 facadeCell = vec2(alongPosition / 0.46, vFacadePosition.y / 0.34);
        vec2 facadeUv = fract(facadeCell);
        vec2 facadeWidth = max(fwidth(facadeCell), vec2(0.006));
        float insideX = smoothstep(0.18 - facadeWidth.x, 0.18 + facadeWidth.x, facadeUv.x) *
          (1.0 - smoothstep(0.78 - facadeWidth.x, 0.78 + facadeWidth.x, facadeUv.x));
        float insideY = smoothstep(0.22 - facadeWidth.y, 0.22 + facadeWidth.y, facadeUv.y) *
          (1.0 - smoothstep(0.72 - facadeWidth.y, 0.72 + facadeWidth.y, facadeUv.y));
        float windowMask = wall * insideX * insideY * smoothstep(0.34, 0.42, vFacadePosition.y) * gdoDistanceVisibility;
        float windowRandom = texture2D(gdoSurfaceNoise, (floor(facadeCell) + 0.5) / 64.0).g;
        vec3 coolGlass = vec3(0.035, 0.13, 0.20);
        vec3 warmGlass = vec3(0.52, 0.25, 0.055);
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(coolGlass, warmGlass, smoothstep(0.80, 0.88, windowRandom)), windowMask * 0.88);
        float outerX = smoothstep(0.12 - facadeWidth.x, 0.12 + facadeWidth.x, facadeUv.x) *
          (1.0 - smoothstep(0.84 - facadeWidth.x, 0.84 + facadeWidth.x, facadeUv.x));
        float outerY = smoothstep(0.15 - facadeWidth.y, 0.15 + facadeWidth.y, facadeUv.y) *
          (1.0 - smoothstep(0.79 - facadeWidth.y, 0.79 + facadeWidth.y, facadeUv.y));
        float frame = wall * max(0.0, outerX * outerY - insideX * insideY) *
          smoothstep(0.34, 0.42, vFacadePosition.y) * gdoDistanceVisibility;
        diffuseColor.rgb = mix(diffuseColor.rgb, min(vec3(0.82), diffuseColor.rgb * 1.75 + vec3(0.08)), frame * 0.72);
        float floorTrim = wall * (1.0 - smoothstep(0.055 - facadeWidth.y, 0.055 + facadeWidth.y, facadeUv.y)) *
          smoothstep(0.34, 0.42, vFacadePosition.y) * gdoDistanceVisibility;
        diffuseColor.rgb *= 1.0 - floorTrim * 0.20;
        float plinth = wall * (1.0 - smoothstep(0.12, 0.20, vFacadePosition.y));
        diffuseColor.rgb *= 1.0 - plinth * 0.28;`);
  };
  material.customProgramCacheKey = () => 'gdo-map-facades-v3';
  return configureSemanticMaterial(material, 'facade', library, 'low');
}

function createWaterMaterial(library) {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: {
      uTime: { value: 0 },
      uSurfaceNoise: { value: library.textures.surfaceNoise },
      uWaterNormal: { value: library.textures.waterNormal },
      uNormalFade: { value: new THREE.Vector2(10, 52) },
      fogColor: { value: new THREE.Color() },
      fogNear: { value: 1 },
      fogFar: { value: 1000 },
    },
    vertexShader: `
      #include <fog_pars_vertex>
      varying vec3 vWorldPosition;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec3 transformed = position;
        vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
        vWorldPosition = worldPosition.xyz;
        vec4 mvPosition = viewMatrix * worldPosition;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      #include <fog_pars_fragment>
      uniform float uTime;
      uniform sampler2D uSurfaceNoise;
      uniform sampler2D uWaterNormal;
      uniform vec2 uNormalFade;
      varying vec3 vWorldPosition;
      varying vec3 vColor;
      void main() {
        vec3 eye = normalize(cameraPosition - vWorldPosition);
        float distanceToEye = distance(cameraPosition, vWorldPosition);
        float normalVisibility = 1.0 - smoothstep(uNormalFade.x, uNormalFade.y, distanceToEye);
        vec2 normalUv = vWorldPosition.xz * 0.18 + vec2(uTime * 0.004, -uTime * 0.003);
        vec3 waterNormal = texture2D(uWaterNormal, normalUv).xyz * 2.0 - 1.0;
        waterNormal = normalize(vec3(waterNormal.xy * normalVisibility, max(0.2, waterNormal.z)));
        float macro = texture2D(uSurfaceNoise, vWorldPosition.xz * 0.035).r;
        float fresnel = pow(1.0 - max(dot(eye, waterNormal.xzy), 0.0), 2.0);
        vec3 color = mix(vColor * mix(0.88, 1.04, macro), vec3(0.42, 0.73, 0.82), fresnel * 0.52);
        gl_FragColor = vec4(color, 0.90);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
    vertexColors: true,
  });
  return material;
}

function prefersReducedPlantMotion(environment = globalThis) {
  try { return environment?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true; }
  catch { return false; }
}

export class GeoWorld {
  constructor(scene, {
    latitude,
    longitude,
    onStatus = () => {},
    onInitialReady = () => {},
    providers,
    materialLibrary = null,
    camera = null,
    viewportHeight = 720,
    reducedMotion = prefersReducedPlantMotion(),
  }) {
    this.scene = scene;
    this.materialLibraryHandle = materialLibrary ? null : acquireProceduralMaterialLibrary();
    this.materialLibrary = materialLibrary ?? this.materialLibraryHandle.library;
    this.reference = createGeoReference(latitude, longitude, SOURCE_ZOOM);
    this.terrainSeed = terrainSeedForCoordinate(latitude, longitude);
    this.onStatus = onStatus;
    this.onInitialReady = onInitialReady;
    this.providers = providers;
    this.tiles = new Map();
    this.queue = [];
    this.activeRequests = 0;
    this.nextRequestId = 1;
    this.disposed = false;
    this.initialReady = false;
    this.lastFocusKey = null;
    this.totalBytes = 0;
    this.provider = 'Connecting…';
    this.timings = null;
    this.mountDiagnostics = { lastMilliseconds: 0, maximumMilliseconds: 0, phases: Object.create(null) };
    this.viewCamera = camera;
    this.viewportHeight = Math.max(1, Number(viewportHeight) || 720);
    this.plantCameraPosition = [0, 2, 0];
    this.plantView = {
      cameraPosition: this.plantCameraPosition,
      verticalFovRadians: Math.PI / 3,
      viewportHeight: this.viewportHeight,
      nowMilliseconds: 0,
    };
    this.pendingPlantOwners = new Map();
    this.plantMountTimer = null;
    // Reused by continuous movement queries to avoid allocating one hit record
    // per simulation substep. Query candidate Sets are still bounded by the
    // local collision-grid cells touched by the sweep.
    this.sweepCandidate = {};
    this.motionSweep = {};
    this.penetrationCandidate = {};
    this.motionDepenetration = {};
    this.sphereCandidate = {};
    this.supportCandidate = {};
    this.cameraSupportCandidate = {};
    this.transitionCandidate = { from: {}, to: {} };
    this.sweepCandidates = new Set();
    this.supportCandidates = new Set();
    this.queryDiagnostics = {
      overlaps: 0,
      sweeps: 0,
      sphereSweeps: 0,
      candidates: 0,
      exactTests: 0,
      depenetrations: 0,
      maxCandidates: 0,
      placementQueries: 0,
      placementClaims: 0,
      placementRejects: 0,
      placementReleases: 0,
      supportQueries: 0,
      supportCandidates: 0,
      maxSupportCandidates: 0,
      groundTransitions: 0,
      groundRejects: 0,
      terrainCameraTests: 0,
      terrainCameraHits: 0,
    };

    this.root = new THREE.Group();
    this.root.name = 'coordinate-map-world';
    scene.add(this.root);

    this.groundMaterial = createTerrainMaterial(false, this.materialLibrary, 'ground');
    this.groundColorTarget = this.groundMaterial.color.clone();
    this.lastGroundBlendMilliseconds = 0;
    this.roadMaterial = createRoadMaterial(this.materialLibrary);
    this.landMaterial = createTerrainMaterial(true, this.materialLibrary, 'land');
    this.buildingMaterial = createBuildingMaterial(this.materialLibrary);
    this.waterMaterial = createWaterMaterial(this.materialLibrary);
    this.decorationMaterial = configureSemanticMaterial(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .84, metalness: 0 }),
      'decoration', this.materialLibrary, 'low',
    );
    this.decorationGeometries = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
      .map(type => GEO_PLANT_TYPES.has(type) || GDO_AMBIENT_LIFE_SOURCE_TYPES[type]
        ? null : createDecorationGeometry(type));
    this.streetFurniturePools = new StreetFurniturePools(this.root, {
      material: this.decorationMaterial,
      terrainSeed: this.terrainSeed,
      renderOrder: GEO_LAYER.decoration.renderBand,
    });
    // DET-08 bridge detail is a purely self-describing instanced stream: the
    // pool never samples terrain and never re-derives the authoritative deck.
    this.bridgePools = new BridgePools(this.root, {
      material: this.decorationMaterial,
      renderOrder: GEO_LAYER.decoration.renderBand,
    });
    // DET-09 hero landmarks are one compiled, hidden-face-reduced mesh per tile.
    // Only the focused tile's hero is visible, so a landmark costs one draw.
    this.landmarkPools = new LandmarkPools(this.root, {
      material: this.decorationMaterial,
      renderOrder: GEO_LAYER.building.renderBand + 2,
    });
    // VEG-09 already owns reduced motion for plants; ambient life reads the
    // same flag so one preference change covers every animated family.
    this.ambientLifePools = new AmbientLifePools(this.root, {
      terrainSeed: this.terrainSeed,
      renderOrder: GEO_LAYER.ambience.renderBand,
      layer: GEO_LAYER.ambience,
      reducedMotion,
      resolveGroundHeight: terrainHeightAt,
    });
    this.plantRenderPools = new PlantRenderPools(this.root, {
      profile: 'low',
      // Recipe geometry is global and versioned; geographic variation belongs
      // to compact placement morphology, not coordinate-specific libraries.
      environmentKey: GDO_VEGETATION_MORPHOLOGY_NAMESPACE,
      seedSalt: hashText(GDO_VEGETATION_MORPHOLOGY_NAMESPACE),
      materialLibrary: this.materialLibrary,
      renderOrder: GEO_LAYER.decoration.renderBand,
      reducedMotion,
    });
    // Preserve the VEG-05 diagnostics surface while the visible VEG-06 owner
    // pool becomes the lifecycle authority.
    this.plantLods = this.plantRenderPools.library;
    this.plantLodSelector = this.plantRenderPools.selector;
    this.activeBiome = { id: 'temperate', label: 'Reading map landscape…', ground: [.16, .30, .10] };

    this.worker = new Worker(new URL('./GeoTileWorker.js', import.meta.url), { type: 'module', name: 'map-tile-generator' });
    this.worker.addEventListener('message', event => this._handleWorkerMessage(event.data));
    this.worker.addEventListener('error', event => {
      this._emitStatus(`Map worker error: ${event.message || 'unknown error'}`, true);
    });

    const initial = worldToTile(this.reference, 0, 0);
    this.initialKey = tileKey(initial.x, initial.y);
    this._requestTile(initial.x, initial.y, 0);
  }

  _tileBounds(tileX, tileY) {
    const size = this.reference.tileSize;
    const minX = (tileX - this.reference.originX) * size;
    const minZ = (tileY - this.reference.originY) * size;
    return { minX, minZ, maxX: minX + size, maxZ: minZ + size };
  }

  _requestTile(x, y, priority) {
    if (this.disposed || y < 0 || y >= 2 ** this.reference.zoom) return;
    const key = tileKey(x, y);
    const existing = this.tiles.get(key);
    if (existing) {
      const now = performance.now();
      existing.lastUsed = now;
      if (existing.state === 'error' && now >= existing.retryAt) {
        existing.state = 'queued';
        existing.requestId = this.nextRequestId++;
        existing.priority = priority;
        this.queue.push(existing);
        this.queue.sort((a, b) => a.priority - b.priority);
        this._pumpQueue();
      }
      return;
    }

    const root = new THREE.Group();
    root.name = `map-tile:${key}`;
    const bounds = this._tileBounds(x, y);
    const groundGeometry = createBufferGeometry(buildTerrainGrid(bounds, this.terrainSeed));
    const ground = new THREE.Mesh(groundGeometry, this.groundMaterial);
    ground.renderOrder = GEO_LAYER.ground.renderBand;
    ground.userData.geoLayer = GEO_LAYER.ground;
    ground.userData.terrainSeed = this.terrainSeed;
    ground.userData.terrainResolution = GEO_TERRAIN_DEFAULTS.gridResolution;
    ground.receiveShadow = false;
    root.add(ground);
    this.root.add(root);

    const tile = {
      key, x, y, root, bounds, ground,
      state: 'queued', requestId: this.nextRequestId++, priority,
      roads: null, land: null, water: null, decorations: [], buildings: null, buildingDetails: null,
      labels: [], biome: null, environment: null, roadMeta: null, buildingMeta: null, timings: null,
      waterDomain: null, waterDomainMeta: null, streetFurnitureMeta: null, streetFurnitureCount: 0,
      bridgeMeta: null, bridgeCount: 0,
      landmarkMeta: null, landmarkGrammar: null, landmarkCount: 0,
      clearanceDiagnostics: null, morphologyDiagnostics: null,
      roadSupportSegments: null, roadSupportStride: 0, roadSupportGrid: null,
      colliders: null, collisionGrid: null,
      collisionVertices: null, collisionRingOffsets: null, collisionPolygonOffsets: null,
      collisionSpans: null, collisionMasks: null,
      supportSlots: null, supportSlotStates: null, supportSlotStride: 0,
      lastUsed: performance.now(), bytes: 0,
      roadFeatures: 0, landFeatures: 0, waterFeatures: 0, decorationCount: 0, plantPoolCount: 0,
      ambientLifeCount: 0, buildingFeatures: 0, truncated: false,
      retryCount: 0, retryAt: 0,
    };
    this.tiles.set(key, tile);
    this.queue.push(tile);
    this.queue.sort((a, b) => a.priority - b.priority);
    this._pumpQueue();
    this._emitStatus();
  }

  _pumpQueue() {
    while (!this.disposed && this.activeRequests < MAX_ACTIVE_REQUESTS && this.queue.length) {
      const tile = this.queue.shift();
      if (!this.tiles.has(tile.key) || tile.state !== 'queued') continue;
      tile.state = 'loading';
      this.activeRequests++;
      this.worker.postMessage({
        type: 'load',
        request: {
          requestId: tile.requestId,
          key: tile.key,
          tileX: tile.x,
          tileY: tile.y,
          urlX: wrapTileX(tile.x, this.reference.zoom),
          urlY: clampTileY(tile.y, this.reference.zoom),
          zoom: this.reference.zoom,
          originX: this.reference.originX,
          originY: this.reference.originY,
          tileSize: this.reference.tileSize,
          latitude: this.reference.latitude,
          longitude: this.reference.longitude,
          terrainSeed: this.terrainSeed,
          providers: this.providers,
          featureVersions: GDO_FEATURE_VERSIONS,
        },
      });
    }
  }

  _applyBiome(biome) {
    if (!biome?.ground || biome.ground.length !== 3 || ![...biome.ground].every(Number.isFinite)) return;
    this.activeBiome = biome;
    this.groundColorTarget.setRGB(...biome.ground);
  }

  _blendEnvironmentGround(nowMilliseconds) {
    if (!Number.isFinite(nowMilliseconds) || nowMilliseconds - this.lastGroundBlendMilliseconds < 100) return;
    const elapsed = this.lastGroundBlendMilliseconds ? nowMilliseconds - this.lastGroundBlendMilliseconds : 100;
    this.lastGroundBlendMilliseconds = nowMilliseconds;
    this.groundMaterial.color.lerp(this.groundColorTarget, 1 - Math.exp(-elapsed / 1_200));
  }

  _mountDecorations(tile, values, stride = 6, clearanceValues = null, morphologyValues = null) {
    const counts = Array(this.decorationGeometries.length).fill(0);
    const lastType = counts.length - 1;
    const typeAt = index => Math.max(0, Math.min(lastType, Math.round(values[index + 3])));
    const keep = index => values && index + 5 < values.length &&
      Number.isFinite(values[index]) && Number.isFinite(values[index + 1]) && Number.isFinite(values[index + 2]) &&
      Number.isFinite(values[index + 3]) && Number.isFinite(values[index + 4]) && Number.isFinite(values[index + 5]) && values[index + 2] > 0 &&
      Math.hypot(values[index], values[index + 1]) >= 2.8;
    let ambientRecords = 0;
    for (let index = 0; index < values.length; index += stride) {
      if (!keep(index)) continue;
      const type = typeAt(index);
      // Birds and bees keep their source decoration record but render from the
      // global 2D sprite pools instead of a tile-local instanced mesh.
      if (GDO_AMBIENT_LIFE_SOURCE_TYPES[type]) { ambientRecords++; continue; }
      counts[type]++;
    }
    const meshes = counts.map((count, type) => count && !GEO_PLANT_TYPES.has(type) ? new THREE.InstancedMesh(
      this.decorationGeometries[type], this.decorationMaterial, count,
    ) : null);
    const cursors = counts.map(() => 0);
    const plantPlacements = [];
    const dummy = new THREE.Object3D();
    for (let index = 0; index < values.length; index += stride) {
      if (!keep(index)) continue;
      const type = typeAt(index);
      if (GDO_AMBIENT_LIFE_SOURCE_TYPES[type]) continue;
      const phase = values[index + 4];
      const groundHeight = terrainHeightAt(values[index], values[index + 1], this.terrainSeed);
      if (GEO_PLANT_TYPES.has(type)) {
        plantPlacements.push(plantPlacementFromDecoration(
          tile.key, index / stride, values, index, groundHeight, clearanceValues, morphologyValues,
        ));
        continue;
      }
      const mesh = meshes[type];
      if (!mesh) continue;
      const cursor = cursors[type]++;
      dummy.position.set(values[index], groundHeight, values[index + 1]);
      dummy.rotation.set(0, phase, 0);
      dummy.scale.setScalar(values[index + 2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(cursor, dummy.matrix);
    }
    const names = ['trees', 'palms', 'shrubs', 'street-lamps', 'rocks', 'flowers', 'benches', 'parked-cars', 'herbs', 'tall-grass', 'birds', 'bees', 'bamboo'];
    for (let type = 0; type < meshes.length; type++) {
      const mesh = meshes[type];
      if (!mesh) continue;
      mesh.name = `${names[type]}:${tile.key}`;
      mesh.renderOrder = GEO_LAYER.decoration.renderBand;
      mesh.userData.geoLayer = GEO_LAYER.decoration;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      tile.root.add(mesh);
      tile.decorations.push(mesh);
    }
    if (plantPlacements.length) this._queuePlantOwner(tile.key, plantPlacements);
    return counts.reduce((sum, count) => sum + count, 0) + ambientRecords;
  }

  _plantView(nowMilliseconds = performance.now()) {
    const camera = this.viewCamera;
    if (camera?.position) {
      this.plantCameraPosition[0] = camera.position.x;
      this.plantCameraPosition[1] = camera.position.y;
      this.plantCameraPosition[2] = camera.position.z;
    }
    this.plantView.verticalFovRadians = Number.isFinite(camera?.fov) ? camera.fov * Math.PI / 180 : Math.PI / 3;
    this.plantView.viewportHeight = this.viewportHeight;
    this.plantView.nowMilliseconds = nowMilliseconds;
    return this.plantView;
  }

  _queuePlantOwner(owner, placements) {
    this.pendingPlantOwners.set(owner, placements);
    // Worker phases are roads → context → buildings. Do not even schedule the
    // optional compiler until the authoritative building/collision phase has
    // made this tile usable.
    if (this.tiles.get(owner)?.state === 'ready') this._schedulePlantMounts();
  }

  _schedulePlantMounts() {
    if (this.plantMountTimer != null || !this.pendingPlantOwners.size) return;
    this.plantMountTimer = setTimeout(() => {
      this.plantMountTimer = null;
      this._flushPlantMounts();
    }, 0);
  }

  _flushPlantMounts(nowMilliseconds = performance.now(), includeUnready = false) {
    if (this.disposed || !this.pendingPlantOwners.size) return 0;
    let mounted = 0;
    const pending = [...this.pendingPlantOwners.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const view = this._plantView(nowMilliseconds);
    for (const [owner, placements] of pending) {
      const tile = this.tiles.get(owner);
      if (!tile) { this.pendingPlantOwners.delete(owner); continue; }
      if (!includeUnready && tile.state !== 'ready') continue;
      this.pendingPlantOwners.delete(owner);
      try {
        this.plantRenderPools.removeOwner(owner);
        tile.plantPoolCount = this.plantRenderPools.addOwner(owner, placements, view);
        mounted += tile.plantPoolCount;
      } catch (error) {
        tile.plantPoolCount = 0;
        tile.contextWarning = [tile.contextWarning, `plants: ${error.message || error}`].filter(Boolean).join('; ');
      }
    }
    this._emitStatus();
    return mounted;
  }

  _recordMountTiming(phase, started) {
    const milliseconds = performance.now() - started;
    this.mountDiagnostics.lastMilliseconds = milliseconds;
    this.mountDiagnostics.maximumMilliseconds = Math.max(this.mountDiagnostics.maximumMilliseconds, milliseconds);
    this.mountDiagnostics.phases[phase] = milliseconds;
  }

  _handleWorkerMessage(message) {
    if (this.disposed) return;
    const tile = this.tiles.get(message.key);
    if (!tile || tile.requestId !== message.requestId) return;

    if (message.type === 'tile-error') {
      tile.state = 'error';
      tile.retryCount++;
      tile.retryAt = performance.now() + Math.min(60000, 5000 * 2 ** (tile.retryCount - 1));
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this._emitStatus(`${message.message} Retrying when this chunk remains in view.`, true);
      this._pumpQueue();
      return;
    }
    if (message.type !== 'tile-phase') return;

    const mountStarted = performance.now();
    this.provider = message.provider || this.provider;
    this.timings = message.timings ?? this.timings;
    tile.timings = message.timings ?? tile.timings;
    if (!tile.bytes) {
      tile.bytes = message.bytes || 0;
      this.totalBytes += tile.bytes;
    }
    const geometry = createBufferGeometry(message.geometry);
    if (message.phase === 'roads') {
      if (tile.roads) {
        tile.roads.removeFromParent();
        tile.roads.geometry.dispose();
        tile.roads = null;
      }
      if (geometry) {
        tile.roads = new THREE.Mesh(geometry, this.roadMaterial);
        tile.roads.name = `roads:${tile.key}`;
        tile.roads.renderOrder = GEO_LAYER.road.renderBand;
        tile.roads.userData.geoLayer = GEO_LAYER.road;
        tile.roads.userData.transportLevels = message.geometry.meta?.transportLevels ?? null;
        tile.root.add(tile.roads);
      }
      tile.roadMeta = message.geometry.meta ?? null;
      tile.transportLevels = message.geometry.meta?.transportLevels ?? null;
      tile.roadSupportSegments = message.geometry.supportSegments ?? null;
      tile.roadSupportStride = message.geometry.supportSegmentStride ?? 0;
      tile.roadSupportGrid = buildRoadSupportGrid(tile.roadSupportSegments, tile.roadSupportStride);
      tile.roadFeatures = message.geometry.meta?.features ?? 0;
      tile.truncated ||= Boolean(message.geometry.meta?.truncated);
      tile.state = 'roads-ready';
      this._recordMountTiming('roads', mountStarted);
      this._emitStatus();
      return;
    }

    if (message.phase === 'context') {
      const context = message.context || {};
      // Commit metadata first so one malformed provider geometry cannot suppress
      // the biome, map names, or every other detail family on the tile.
      tile.labels = Array.isArray(context.labels) ? context.labels : [];
      tile.biome = context.biome || tile.biome;
      tile.environment = context.environment || tile.environment;
      tile.landFeatures = context.land?.meta?.features ?? 0;
      tile.waterFeatures = context.water?.meta?.features ?? 0;
      tile.waterDomain = context.waterDomain ?? null;
      tile.waterDomainMeta = context.waterDomain?.meta ?? null;
      tile.streetFurnitureMeta = context.streetFurniture?.meta ?? null;
      tile.bridgeMeta = context.bridges?.meta ?? null;
      tile.clearanceDiagnostics = context.clearanceDiagnostics ?? null;
      tile.morphologyDiagnostics = context.morphologyDiagnostics ?? null;
      tile.truncated ||= Boolean(context.land?.meta?.truncated) ||
        Boolean(context.clearanceDiagnostics?.capEvents &&
          Object.values(context.clearanceDiagnostics.capEvents).some(Boolean));
      const warnings = [];
      tile.land?.geometry.dispose();
      tile.water?.geometry.dispose();
      tile.land?.removeFromParent();
      tile.water?.removeFromParent();
      for (const decoration of tile.decorations) decoration.removeFromParent();
      this.pendingPlantOwners.delete(tile.key);
      this.plantRenderPools.removeOwner(tile.key);
      this.streetFurniturePools.removeOwner(tile.key);
      this.bridgePools.removeOwner(tile.key);
      this.landmarkPools.removeOwner(tile.key);
      this.ambientLifePools.removeOwner(tile.key);
      tile.land = null; tile.water = null; tile.decorations.length = 0;
      tile.decorationCount = 0; tile.plantPoolCount = 0; tile.streetFurnitureCount = 0;
      tile.ambientLifeCount = 0;
      try {
        const landGeometry = createBufferGeometry(context.land);
        if (landGeometry) {
          tile.land = new THREE.Mesh(landGeometry, this.landMaterial);
          tile.land.name = `land-cover:${tile.key}`;
          tile.land.renderOrder = GEO_LAYER.land.renderBand;
          tile.land.userData.geoLayer = GEO_LAYER.land;
          tile.root.add(tile.land);
        }
      } catch (error) { warnings.push(`land: ${error.message || error}`); }
      try {
        const waterGeometry = createBufferGeometry(context.water);
        if (waterGeometry) {
          tile.water = new THREE.Mesh(waterGeometry, this.waterMaterial);
          tile.water.name = `water:${tile.key}`;
          tile.water.renderOrder = GEO_LAYER.water.renderBand;
          tile.water.userData.geoLayer = GEO_LAYER.water;
          tile.root.add(tile.water);
        }
      } catch (error) { warnings.push(`water: ${error.message || error}`); }
      try {
        const furnitureValues = context.streetFurniture?.placements instanceof Float32Array
          ? context.streetFurniture.placements : new Float32Array();
        tile.streetFurnitureCount = this.streetFurniturePools.addOwner(
          tile.key, furnitureValues, context.streetFurniture?.stride || 6,
        );
      } catch (error) { warnings.push(`street furniture: ${error.message || error}`); }
      try {
        // Bridge detail is its own bounded pool: a malformed or over-capped
        // span stream must never suppress furniture or decoration mounting.
        const bridgeValues = context.bridges?.placements instanceof Float32Array
          ? context.bridges.placements : new Float32Array();
        tile.bridgeCount = this.bridgePools.addOwner(
          tile.key, bridgeValues, context.bridges?.stride || 11,
        );
      } catch (error) { warnings.push(`bridges: ${error.message || error}`); }
      try {
        const decorationValues = context.decorations instanceof Float32Array ? context.decorations : new Float32Array();
        const clearanceValues = context.decorationClearances instanceof Float32Array ? context.decorationClearances : null;
        const morphologyValues = context.decorationMorphologies instanceof Uint8Array ? context.decorationMorphologies : null;
        tile.decorationCount = this._mountDecorations(
          tile, decorationValues, context.decorationStride || 6, clearanceValues, morphologyValues,
        );
      } catch (error) { warnings.push(`details: ${error.message || error}`); }
      try {
        // Ambient life is a separate bounded pool: a malformed or over-capped
        // sprite stream must never suppress the other decoration families.
        const decorationValues = context.decorations instanceof Float32Array ? context.decorations : new Float32Array();
        tile.ambientLifeCount = this.ambientLifePools.addOwner(tile.key, decorationValues, context.decorationStride || 6);
      } catch (error) { warnings.push(`ambient life: ${error.message || error}`); }
      tile.contextWarning = warnings.join('; ');
      if (tile.key === this.initialKey || tile.key === this.lastFocusKey) this._applyBiome(tile.biome);
      this._recordMountTiming('context', mountStarted);
      this._emitStatus(tile.contextWarning ? `Some map ambience was skipped: ${tile.contextWarning}` : '', false);
      return;
    }

    if (message.phase === 'buildings') {
      const warnings = [];
      if (tile.buildings) {
        tile.buildings.removeFromParent();
        tile.buildings.geometry.dispose();
        tile.buildings = null;
      }
      if (tile.buildingDetails) {
        tile.buildingDetails.removeFromParent();
        tile.buildingDetails.geometry.dispose();
        tile.buildingDetails = null;
      }
      if (geometry) {
        tile.buildings = new THREE.Mesh(geometry, this.buildingMaterial);
        tile.buildings.name = `buildings:${tile.key}`;
        tile.buildings.renderOrder = GEO_LAYER.building.renderBand;
        tile.buildings.userData.geoLayer = GEO_LAYER.building;
        tile.root.add(tile.buildings);
      }
      const detailGeometry = createBufferGeometry({
        positions: message.geometry.detailPositions,
        normals: message.geometry.detailNormals,
        colors: message.geometry.detailColors,
        indices: message.geometry.detailIndices,
      });
      if (detailGeometry) {
        tile.buildingDetails = new THREE.Mesh(detailGeometry, this.decorationMaterial);
        tile.buildingDetails.name = `building-details:${tile.key}`;
        tile.buildingDetails.renderOrder = GEO_LAYER.building.renderBand + 1;
        tile.buildingDetails.userData.geoLayer = GEO_LAYER.building;
        tile.buildingDetails.userData.visualOnly = true;
        tile.buildingDetails.visible = tile.key === (this.lastFocusKey ?? this.initialKey);
        tile.root.add(tile.buildingDetails);
      }
      tile.buildingMeta = message.geometry.meta ?? null;
      tile.buildingFeatures = message.geometry.meta?.features ?? 0;
      tile.truncated ||= Boolean(message.geometry.meta?.truncated);
      tile.colliders = message.geometry.colliders;
      tile.collisionVertices = message.geometry.collisionVertices;
      tile.collisionRingOffsets = message.geometry.collisionRingOffsets;
      tile.collisionPolygonOffsets = message.geometry.collisionPolygonOffsets;
      tile.collisionSpans = message.geometry.collisionSpans;
      tile.collisionMasks = message.geometry.collisionMasks;
      tile.supportSlots = message.geometry.supportSlots;
      tile.supportSlotStates = message.geometry.supportSlotStates;
      tile.supportSlotStride = message.geometry.supportSlotStride ?? 0;
      tile.collisionGrid = buildCollisionGrid(tile.colliders);
      try {
        // A hero is already compiled and hidden-face reduced, so the pool only
        // merges, mounts, and releases it. A malformed hero stream must never
        // suppress the plain building geometry.
        const landmarkMeta = message.geometry.meta?.landmarkGrammar;
        tile.landmarkCount = this.landmarkPools.addOwner(tile.key, {
          geometry: {
            positions: message.geometry.landmarkPositions,
            normals: message.geometry.landmarkNormals,
            colors: message.geometry.landmarkColors,
            indices: message.geometry.landmarkIndices,
            bytes: landmarkMeta?.bytes ?? 0,
          },
          heroes: landmarkMeta?.heroes ?? [],
          compounds: (landmarkMeta?.heroes ?? []).flatMap(hero => hero.compounds ?? []),
        });
      } catch (error) { warnings.push(`landmarks: ${error.message || error}`); }
      tile.landmarkGrammar = message.geometry.meta?.landmarkGrammar ?? null;
      // Mirror the mapped-detail focus rule so the first hero is visible before
      // the first focus change arrives.
      this.landmarkPools.setFocus(this.lastFocusKey ?? this.initialKey);
      if (warnings.length) {
        tile.contextWarning = [tile.contextWarning, warnings.join('; ')].filter(Boolean).join('; ');
        this._emitStatus(`Some map ambience was skipped: ${tile.contextWarning}`, false);
      }
      tile.state = 'ready';
      this.activeRequests = Math.max(0, this.activeRequests - 1);

      if (!this.initialReady && tile.key === this.initialKey) {
        this.initialReady = true;
        this.onInitialReady(this.findSafePosition(0, 0));
      }
      this._recordMountTiming('buildings', mountStarted);
      this._emitStatus();
      this._pumpQueue();
      this._schedulePlantMounts();
    }
  }

  _emitStatus(errorMessage = '', error = false) {
    const stats = this.stats;
    this.onStatus({ ...stats, error, message: errorMessage });
  }

  get stats() {
    let roads = 0, buildings = 0, land = 0, water = 0, decorations = 0, streetFurniture = 0, bridges = 0, labels = 0;
    let landmarks = 0;
    let plantClearanceRejected = 0, plantClearanceAdapted = 0, plantObstacleSamples = 0, waterDomainSegments = 0;
    let morphologySamples = 0, morphologyPlants = 0, waterDomainBytes = 0;
    let buildingDetailBuildings = 0, buildingDetailBoxes = 0, buildingDetailTriangles = 0, buildingDetailBytes = 0;
    const waterClassCounts = { unknown: 0, stream: 0, canal: 0, river: 0, lake: 0, ocean: 0 };
    let supportSlots = 0, occupiedSupportSlots = 0, ready = 0, truncated = false;
    for (const tile of this.tiles.values()) {
      roads += tile.roadFeatures;
      buildings += tile.buildingFeatures;
      land += tile.landFeatures;
      water += tile.waterFeatures;
      decorations += tile.decorationCount;
      streetFurniture += tile.streetFurnitureCount;
      bridges += tile.bridgeCount;
      landmarks += tile.landmarkCount ?? 0;
      labels += tile.labels.length;
      plantClearanceRejected += tile.clearanceDiagnostics?.rejected ?? 0;
      plantClearanceAdapted += tile.clearanceDiagnostics?.adapted ?? 0;
      plantObstacleSamples += tile.clearanceDiagnostics?.obstacleSamples?.total ?? 0;
      morphologySamples += tile.morphologyDiagnostics?.samples ?? 0;
      morphologyPlants += tile.morphologyDiagnostics?.plants ?? 0;
      waterDomainSegments += tile.waterDomainMeta?.waterwaySegments ?? 0;
      waterDomainBytes += tile.waterDomainMeta?.bytes ?? 0;
      const buildingGrammar = tile.buildingMeta?.buildingGrammar;
      buildingDetailBytes += buildingGrammar?.bytes ?? 0;
      if (tile.buildingDetails?.visible) {
        buildingDetailBuildings += buildingGrammar?.selectedBuildings ?? 0;
        buildingDetailBoxes += buildingGrammar?.boxes ?? 0;
        buildingDetailTriangles += buildingGrammar?.triangles ?? 0;
      }
      for (const name of Object.keys(waterClassCounts)) {
        waterClassCounts[name] += tile.waterDomainMeta?.classCounts?.[name] ?? 0;
      }
      supportSlots += tile.supportSlotStates?.length ?? 0;
      if (tile.supportSlotStates) for (const state of tile.supportSlotStates) occupiedSupportSlots += Number(state !== 0);
      if (tile.state === 'ready') ready++;
      truncated ||= tile.truncated;
    }
    const streetFurnitureDiagnostics = this.streetFurniturePools.diagnostics;
    const ambientLifeDiagnostics = this.ambientLifePools.diagnostics;
    const bridgeDiagnostics = this.bridgePools.diagnostics;
    const landmarkDiagnostics = this.landmarkPools.diagnostics;
    return Object.freeze({
      provider: this.provider,
      generatorVersion: GDO_GENERATOR_VERSION,
      terrainSeed: this.terrainSeed,
      terrainResolution: GEO_TERRAIN_DEFAULTS.gridResolution,
      resident: this.tiles.size,
      ready,
      queued: this.queue.length,
      loading: this.activeRequests,
      roads,
      buildings,
      land,
      water,
      decorations,
      streetFurniture,
      streetFurnitureFamilies: streetFurnitureDiagnostics.activeDrawPools,
      streetFurnitureTriangles: streetFurnitureDiagnostics.visibleTriangles,
      bridges,
      bridgeFamilies: bridgeDiagnostics.activeDrawPools,
      bridgeTriangles: bridgeDiagnostics.visibleTriangles,
      bridgeCompounds: bridgeDiagnostics.compounds,
      bridgeStructuralCompounds: bridgeDiagnostics.structuralCompounds,
      landmarkBoxes: landmarks,
      landmarkHeroes: landmarkDiagnostics.heroes,
      landmarkTriangles: landmarkDiagnostics.visibleTriangles,
      landmarkAddedDrawCalls: landmarkDiagnostics.addedDrawCalls,
      landmarkOpenings: landmarkDiagnostics.openings,
      landmarkPassableOpenings: landmarkDiagnostics.passableOpenings,
      landmarkCompounds: landmarkDiagnostics.compounds,
      landmarkStructuralCompounds: landmarkDiagnostics.structuralCompounds,
      // Must stay zero: a hero never keeps one enclosing AABB.
      landmarkEnclosingCompounds: landmarkDiagnostics.enclosingCompounds,
      ambientLifeEntries: ambientLifeDiagnostics.entries,
      ambientLifeFamilies: ambientLifeDiagnostics.activeDrawPools,
      ambientLifeTriangles: ambientLifeDiagnostics.visibleTriangles,
      ambientLifeCapPruned: ambientLifeDiagnostics.capEvents.pruned,
      ambientLifeUniformWrites: ambientLifeDiagnostics.uniformWrites,
      ambientLifeCpuMatrixUpdates: ambientLifeDiagnostics.cpuMatrixUpdates,
      ambientLifeReducedMotion: ambientLifeDiagnostics.reducedMotion,
      labels,
      supportSlots,
      occupiedSupportSlots,
      biome: this.activeBiome.label,
      bytes: this.totalBytes,
      timings: this.timings,
      materialLibrary: this.materialLibrary.diagnostics,
      materialTextureBytes: this.materialLibrary.diagnostics.estimatedBytes,
      plantRenderEntries: this.plantRenderPools.diagnostics.entries,
      plantRenderPools: this.plantRenderPools.diagnostics.activeDrawPools,
      plantRenderTriangles: this.plantRenderPools.diagnostics.visibleTriangles,
      plantWindUniformWrites: this.plantRenderPools.diagnostics.windUniformWrites,
      plantWindCpuMatrixUpdates: this.plantRenderPools.diagnostics.windCpuMatrixUpdates,
      plantWindReducedMotion: this.plantRenderPools.diagnostics.reducedMotion,
      plantClearanceRejected,
      plantClearanceAdapted,
      plantObstacleSamples,
      morphologySamples,
      morphologyPlants,
      waterDomainSegments,
      waterDomainBytes,
      waterClassCounts: Object.freeze(waterClassCounts),
      buildingDetailBuildings,
      buildingDetailBoxes,
      buildingDetailTriangles,
      buildingDetailBytes,
      mountMilliseconds: this.mountDiagnostics.lastMilliseconds,
      maximumMountMilliseconds: this.mountDiagnostics.maximumMilliseconds,
      truncated,
      initialReady: this.initialReady,
    });
  }

  setReducedMotion(value) {
    const plants = this.plantRenderPools.setReducedMotion(value);
    const ambience = this.ambientLifePools.setReducedMotion(value);
    return plants || ambience;
  }

  configurePlantWind(options = {}) {
    return this.plantRenderPools.configureWind(options);
  }

  get visibleLabels() {
    const seen = new Set();
    const labels = [];
    for (const tile of this.tiles.values()) for (const label of tile.labels) {
      const key = label.name.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push(label);
    }
    return labels.sort((a, b) => b.priority - a.priority).slice(0, 14);
  }

  // Ambient life motion now lives entirely in the shared vertex program; the
  // world only forwards the frame clock (one uniform write, zero matrices).

  update(position, camera = this.viewCamera, viewportHeight = this.viewportHeight, nowMilliseconds = performance.now()) {
    if (this.disposed) return;
    if (camera?.isCamera) this.viewCamera = camera;
    this.viewportHeight = Math.max(1, Number(viewportHeight) || this.viewportHeight);
    if (!this.viewCamera) {
      this.plantCameraPosition[0] = position.x;
      this.plantCameraPosition[1] = 2;
      this.plantCameraPosition[2] = position.z;
    }
    this.plantRenderPools.update(this._plantView(nowMilliseconds));
    this._blendEnvironmentGround(nowMilliseconds);
    const time = nowMilliseconds * .001;
    this.waterMaterial.uniforms.uTime.value = time;
    this.ambientLifePools.update(nowMilliseconds);
    const fractionalX = this.reference.originX + position.x / this.reference.tileSize;
    const fractionalY = this.reference.originY + position.z / this.reference.tileSize;
    const x = Math.floor(fractionalX), y = Math.floor(fractionalY);
    const focusKey = tileKey(x, y);
    if (focusKey !== this.lastFocusKey) {
      this._applyBiome(this.tiles.get(focusKey)?.biome);
      for (const tile of this.tiles.values()) {
        if (tile.buildingDetails) tile.buildingDetails.visible = tile.key === focusKey;
      }
      this.landmarkPools.setFocus(focusKey);
    }
    this.lastFocusKey = focusKey;
    const localX = fractionalX - x, localY = fractionalY - y;
    const wanted = new Set([focusKey]);
    const xDirections = [];
    const yDirections = [];
    if (localX < PREFETCH_EDGE_FRACTION) xDirections.push(-1);
    if (localX > 1 - PREFETCH_EDGE_FRACTION) xDirections.push(1);
    if (localY < PREFETCH_EDGE_FRACTION) yDirections.push(-1);
    if (localY > 1 - PREFETCH_EDGE_FRACTION) yDirections.push(1);

    this._requestTile(x, y, 0);
    for (const dx of xDirections) {
      wanted.add(tileKey(x + dx, y));
      this._requestTile(x + dx, y, 1);
    }
    for (const dy of yDirections) {
      wanted.add(tileKey(x, y + dy));
      this._requestTile(x, y + dy, 1);
    }
    for (const dx of xDirections) for (const dy of yDirections) {
      wanted.add(tileKey(x + dx, y + dy));
      this._requestTile(x + dx, y + dy, 2);
    }

    // Keep only the current tile and immediate look-ahead set. Four tiles are
    // sufficient at a corner and bound CPU/GPU memory independently of travel.
    const candidates = [...this.tiles.values()]
      .filter(tile => !wanted.has(tile.key))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.tiles.size > MAX_RESIDENT_TILES && candidates.length) this._evictTile(candidates.shift());
    for (const tile of candidates) {
      if (Math.max(Math.abs(tile.x - x), Math.abs(tile.y - y)) > 1) this._evictTile(tile);
    }
  }

  _evictTile(tile) {
    if (!tile || !this.tiles.delete(tile.key)) return;
    if (tile.state === 'loading' || tile.state === 'roads-ready') {
      this.worker.postMessage({ type: 'cancel', requestId: tile.requestId });
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    }
    this.queue = this.queue.filter(candidate => candidate !== tile);
    this.pendingPlantOwners.delete(tile.key);
    this.plantRenderPools.removeOwner(tile.key);
    this.streetFurniturePools.removeOwner(tile.key);
    this.bridgePools.removeOwner(tile.key);
    this.landmarkPools.removeOwner(tile.key);
    this.ambientLifePools.removeOwner(tile.key);
    tile.plantPoolCount = 0;
    tile.streetFurnitureCount = 0;
    tile.landmarkCount = 0;
    tile.landmarkGrammar = null;
    tile.bridgeCount = 0;
    tile.ambientLifeCount = 0;
    tile.root.removeFromParent();
    tile.ground?.geometry.dispose();
    tile.roads?.geometry.dispose();
    tile.land?.geometry.dispose();
    tile.water?.geometry.dispose();
    tile.buildings?.geometry.dispose();
    tile.buildingDetails?.geometry.dispose();
    tile.decorations.length = 0;
    tile.waterDomain = null;
    tile.waterDomainMeta = null;
    tile.streetFurnitureMeta = null;
    tile.bridgeMeta = null;
    tile.clearanceDiagnostics = null;
    tile.morphologyDiagnostics = null;
    tile.environment = null;
    tile.root.clear();
    this.totalBytes = Math.max(0, this.totalBytes - tile.bytes);
    this._pumpQueue();
  }

  _proxyMatches(tile, colliderIndex, queryMask, minY = -Infinity, maxY = Infinity) {
    const polygonIndex = colliderIndex / 4;
    const mask = tile.collisionMasks?.[polygonIndex] ??
      (GEO_QUERY_MASK.SOLID_PLAYER | GEO_QUERY_MASK.CAMERA_BLOCKER | GEO_QUERY_MASK.LOS_BLOCKER | GEO_QUERY_MASK.PLACEMENT);
    if ((mask & queryMask) === 0) return false;
    if (!tile.collisionSpans || polygonIndex * 2 + 1 >= tile.collisionSpans.length) return true;
    const base = tile.collisionSpans[polygonIndex * 2];
    const top = tile.collisionSpans[polygonIndex * 2 + 1];
    return maxY >= base && minY <= top;
  }

  _collectCollisionCandidates(tile, minX, minZ, maxX, maxZ) {
    const candidates = this.sweepCandidates;
    candidates.clear();
    for (const index of tile.collisionGrid.large) candidates.add(index);
    const minCellX = Math.floor(minX / COLLISION_CELL_SIZE);
    const maxCellX = Math.floor(maxX / COLLISION_CELL_SIZE);
    const minCellZ = Math.floor(minZ / COLLISION_CELL_SIZE);
    const maxCellZ = Math.floor(maxZ / COLLISION_CELL_SIZE);
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
      for (const index of tile.collisionGrid.grid.get(`${cellX}:${cellZ}`) ?? []) candidates.add(index);
    }
    this.queryDiagnostics.candidates += candidates.size;
    this.queryDiagnostics.maxCandidates = Math.max(this.queryDiagnostics.maxCandidates, candidates.size);
    return candidates;
  }

  collidesCircle(
    x, z, radius,
    queryMask = GEO_QUERY_MASK.SOLID_PLAYER,
    minY = -Infinity,
    maxY = Infinity,
  ) {
    this.queryDiagnostics.overlaps++;
    for (const tile of this.tiles.values()) {
      if (!tile.collisionGrid || x + radius < tile.bounds.minX || x - radius > tile.bounds.maxX ||
          z + radius < tile.bounds.minZ || z - radius > tile.bounds.maxZ) continue;
      const candidates = this._collectCollisionCandidates(tile, x - radius, z - radius, x + radius, z + radius);
      for (const index of candidates) {
        if (!this._proxyMatches(tile, index, queryMask, minY, maxY) ||
            x + radius < tile.colliders[index] || x - radius > tile.colliders[index + 2] ||
            z + radius < tile.colliders[index + 1] || z - radius > tile.colliders[index + 3]) continue;
        const hasExactFootprint = tile.collisionVertices?.length && tile.collisionRingOffsets?.length > 1 && tile.collisionPolygonOffsets?.length > 1;
        if (!hasExactFootprint) return true;
        this.queryDiagnostics.exactTests++;
        if (circleIntersectsFootprint(
          x, z, radius, index / 4,
          tile.collisionVertices, tile.collisionRingOffsets, tile.collisionPolygonOffsets,
        )) return true;
      }
    }
    return false;
  }

  /** Earliest continuous horizontal hit against resident static footprints. */
  sweepCircle(
    x, z, dx, dz, radius, out = {},
    queryMask = GEO_QUERY_MASK.SOLID_PLAYER,
    minY = -Infinity,
    maxY = Infinity,
  ) {
    this.queryDiagnostics.sweeps++;
    out.hit = false;
    out.time = 1;
    out.normalX = 0;
    out.normalZ = 0;
    out.startedOverlapping = false;
    out.tileKey = null;
    out.polygonIndex = -1;

    const sweepMinX = Math.min(x, x + dx) - radius;
    const sweepMaxX = Math.max(x, x + dx) + radius;
    const sweepMinZ = Math.min(z, z + dz) - radius;
    const sweepMaxZ = Math.max(z, z + dz) + radius;
    for (const tile of this.tiles.values()) {
      if (!tile.collisionGrid || sweepMaxX < tile.bounds.minX || sweepMinX > tile.bounds.maxX ||
          sweepMaxZ < tile.bounds.minZ || sweepMinZ > tile.bounds.maxZ) continue;

      const candidates = this._collectCollisionCandidates(tile, sweepMinX, sweepMinZ, sweepMaxX, sweepMaxZ);
      const hasExactFootprints = tile.collisionVertices?.length && tile.collisionRingOffsets?.length > 1 &&
        tile.collisionPolygonOffsets?.length > 1;
      for (const index of candidates) {
        if (!this._proxyMatches(tile, index, queryMask, minY, maxY)) continue;
        const candidate = this.sweepCandidate;
        // The expanded AABB is a conservative swept broad phase only. Exact
        // rings below remain authoritative and preserve concavities/holes.
        sweepPointAgainstAabb(
          x, z, dx, dz,
          tile.colliders[index] - radius, tile.colliders[index + 1] - radius,
          tile.colliders[index + 2] + radius, tile.colliders[index + 3] + radius,
          candidate,
        );
        if (!candidate.hit || candidate.time > out.time) continue;
        if (hasExactFootprints) {
          this.queryDiagnostics.exactTests++;
          sweepCircleAgainstFootprint(
            x, z, dx, dz, radius, index / 4,
            tile.collisionVertices, tile.collisionRingOffsets, tile.collisionPolygonOffsets,
            candidate,
          );
        }
        if (!candidate.hit || (out.hit && candidate.time >= out.time)) continue;
        out.hit = true;
        out.time = candidate.time;
        out.normalX = candidate.normalX;
        out.normalZ = candidate.normalZ;
        out.startedOverlapping = candidate.startedOverlapping;
        out.tileKey = tile.key;
        out.polygonIndex = index / 4;
      }
    }
    return out;
  }

  /** Recover a circle from bounded startup/streaming/numeric overlap. */
  depenetrateCircle(
    x, z, radius, maxDistance = .12, maxIterations = 2, out = {},
    queryMask = GEO_QUERY_MASK.SOLID_PLAYER,
  ) {
    let currentX = x, currentZ = z, moved = 0, iterations = 0;
    const limit = Math.max(0, maxDistance);
    for (; iterations < Math.max(1, Math.min(2, maxIterations)) && moved < limit; iterations++) {
      let bestDepth = 0, bestNormalX = 0, bestNormalZ = 0;
      for (const tile of this.tiles.values()) {
        if (!tile.collisionGrid || currentX + radius < tile.bounds.minX || currentX - radius > tile.bounds.maxX ||
            currentZ + radius < tile.bounds.minZ || currentZ - radius > tile.bounds.maxZ) continue;
        const candidates = this._collectCollisionCandidates(
          tile, currentX - radius, currentZ - radius, currentX + radius, currentZ + radius,
        );
        const hasExactFootprints = tile.collisionVertices?.length && tile.collisionRingOffsets?.length > 1 &&
          tile.collisionPolygonOffsets?.length > 1;
        for (const index of candidates) {
          if (!this._proxyMatches(tile, index, queryMask) ||
              currentX + radius < tile.colliders[index] || currentX - radius > tile.colliders[index + 2] ||
              currentZ + radius < tile.colliders[index + 1] || currentZ - radius > tile.colliders[index + 3]) continue;
          const penetration = this.penetrationCandidate;
          if (hasExactFootprints) {
            this.queryDiagnostics.exactTests++;
            circleFootprintPenetration(
              currentX, currentZ, radius, index / 4,
              tile.collisionVertices, tile.collisionRingOffsets, tile.collisionPolygonOffsets,
              penetration,
            );
          } else {
            circleAabbPenetration(
              currentX, currentZ, radius,
              tile.colliders[index], tile.colliders[index + 1],
              tile.colliders[index + 2], tile.colliders[index + 3],
              penetration,
            );
          }
          if (penetration.overlap && penetration.depth > bestDepth) {
            bestDepth = penetration.depth;
            bestNormalX = penetration.normalX;
            bestNormalZ = penetration.normalZ;
          }
        }
      }
      if (bestDepth <= 0) break;
      const amount = Math.min(bestDepth + 1e-4, limit - moved);
      currentX += bestNormalX * amount;
      currentZ += bestNormalZ * amount;
      moved += amount;
    }
    out.x = currentX;
    out.z = currentZ;
    out.moved = moved;
    out.iterations = iterations;
    out.depenetrated = moved > 0;
    if (out.depenetrated) this.queryDiagnostics.depenetrations++;
    return out;
  }

  /**
   * Resolve one bounded movement delta with at most two sweep/slide contacts.
   * `projectedX/Z` is the collision-projected full-frame delta, allowing the
   * player controller to preserve tangential velocity without axis-order bias.
   */
  moveCircle(x, z, dx, dz, radius, skin = .003, maxContacts = 2, out = {}, maxDepenetration = .12) {
    const queryRadius = Math.max(0, radius + skin);
    let currentX = x, currentZ = z;
    let remainingX = Number.isFinite(dx) ? dx : 0;
    let remainingZ = Number.isFinite(dz) ? dz : 0;
    let projectedX = remainingX, projectedZ = remainingZ;
    let recoveryAttempted = false;
    out.hit = false;
    out.contacts = 0;
    out.depenetrated = false;
    out.depenetrationDistance = 0;
    out.normalX = 0;
    out.normalZ = 0;

    for (let contact = 0; contact < Math.max(1, Math.min(2, maxContacts)); contact++) {
      if (remainingX * remainingX + remainingZ * remainingZ < 1e-12) break;
      const hit = this.sweepCircle(currentX, currentZ, remainingX, remainingZ, queryRadius, this.motionSweep);
      if (hit.startedOverlapping && !recoveryAttempted) {
        const depenetration = this.depenetrateCircle(
          currentX, currentZ, queryRadius, maxDepenetration, 2, this.motionDepenetration,
        );
        recoveryAttempted = true;
        if (depenetration.depenetrated) {
          currentX = depenetration.x;
          currentZ = depenetration.z;
          out.depenetrated = true;
          out.depenetrationDistance = depenetration.moved;
          contact--;
          continue;
        }
      }
      if (!hit.hit) {
        currentX += remainingX;
        currentZ += remainingZ;
        remainingX = 0;
        remainingZ = 0;
        break;
      }

      out.hit = true;
      out.contacts++;
      out.normalX = hit.normalX;
      out.normalZ = hit.normalZ;
      const distance = Math.hypot(remainingX, remainingZ);
      const safeTime = Math.max(0, hit.time - 1e-4 / Math.max(distance, 1e-6));
      currentX += remainingX * safeTime;
      currentZ += remainingZ * safeTime;

      const remainingFraction = Math.max(0, 1 - hit.time);
      remainingX *= remainingFraction;
      remainingZ *= remainingFraction;
      const intoSurface = remainingX * hit.normalX + remainingZ * hit.normalZ;
      if (intoSurface < 0) {
        remainingX -= hit.normalX * intoSurface;
        remainingZ -= hit.normalZ * intoSurface;
      }
      const projectedIntoSurface = projectedX * hit.normalX + projectedZ * hit.normalZ;
      if (projectedIntoSurface < 0) {
        projectedX -= hit.normalX * projectedIntoSurface;
        projectedZ -= hit.normalZ * projectedIntoSurface;
      }
    }

    out.x = currentX;
    out.z = currentZ;
    out.projectedX = projectedX;
    out.projectedZ = projectedZ;
    return out;
  }

  /** Continuous sphere sweep against vertically bounded building prisms. */
  sweepSphere(x, y, z, dx, dy, dz, radius, out = {}, queryMask = GEO_QUERY_MASK.CAMERA_BLOCKER) {
    this.queryDiagnostics.sphereSweeps++;
    out.hit = false;
    out.time = 1;
    out.normalX = 0;
    out.normalY = 0;
    out.normalZ = 0;
    out.tileKey = null;
    out.polygonIndex = -1;
    const sweepMinX = Math.min(x, x + dx) - radius;
    const sweepMaxX = Math.max(x, x + dx) + radius;
    const sweepMinZ = Math.min(z, z + dz) - radius;
    const sweepMaxZ = Math.max(z, z + dz) + radius;
    const sweepMinY = Math.min(y, y + dy) - radius;
    const sweepMaxY = Math.max(y, y + dy) + radius;

    for (const tile of this.tiles.values()) {
      if (!tile.collisionGrid || sweepMaxX < tile.bounds.minX || sweepMinX > tile.bounds.maxX ||
          sweepMaxZ < tile.bounds.minZ || sweepMinZ > tile.bounds.maxZ) continue;
      const candidates = this._collectCollisionCandidates(tile, sweepMinX, sweepMinZ, sweepMaxX, sweepMaxZ);
      const hasExactFootprints = tile.collisionVertices?.length && tile.collisionRingOffsets?.length > 1 &&
        tile.collisionPolygonOffsets?.length > 1;
      for (const index of candidates) {
        if (!this._proxyMatches(tile, index, queryMask, sweepMinY, sweepMaxY)) continue;
        const polygonIndex = index / 4;
        const base = tile.collisionSpans?.[polygonIndex * 2] ?? -Infinity;
        const top = tile.collisionSpans?.[polygonIndex * 2 + 1] ?? Infinity;
        const candidate = this.sphereCandidate;
        sweepPointAgainstAabb(
          x, z, dx, dz,
          tile.colliders[index] - radius, tile.colliders[index + 1] - radius,
          tile.colliders[index + 2] + radius, tile.colliders[index + 3] + radius,
          candidate,
        );
        if (candidate.hit && candidate.time <= out.time) {
          if (hasExactFootprints) {
            this.queryDiagnostics.exactTests++;
            sweepCircleAgainstFootprint(
              x, z, dx, dz, radius, polygonIndex,
              tile.collisionVertices, tile.collisionRingOffsets, tile.collisionPolygonOffsets,
              candidate,
            );
          }
          if (candidate.hit) {
            const contactY = y + dy * candidate.time;
            if (contactY + radius >= base && contactY - radius <= top) {
              let normalX = candidate.normalX, normalZ = candidate.normalZ;
              if (candidate.startedOverlapping && Math.hypot(normalX, normalZ) < 1e-8) {
                const horizontal = Math.hypot(dx, dz) || 1;
                normalX = -dx / horizontal;
                normalZ = -dz / horizontal;
              }
              considerSweepHit(out, candidate.time, normalX, 0, normalZ, tile, index);
            }
          }
        }

        if (!Number.isFinite(base) || !Number.isFinite(top) || Math.abs(dy) < 1e-9) continue;
        let planeTime = Infinity, normalY = 0;
        if (dy < 0 && y - radius >= top && y + dy - radius <= top) {
          planeTime = (top + radius - y) / dy;
          normalY = 1;
        } else if (dy > 0 && y + radius <= base && y + dy + radius >= base) {
          planeTime = (base - radius - y) / dy;
          normalY = -1;
        }
        if (planeTime < 0 || planeTime > 1 || (out.hit && planeTime >= out.time)) continue;
        const planeX = x + dx * planeTime, planeZ = z + dz * planeTime;
        const overlapsFootprint = hasExactFootprints
          ? circleIntersectsFootprint(
            planeX, planeZ, radius, polygonIndex,
            tile.collisionVertices, tile.collisionRingOffsets, tile.collisionPolygonOffsets,
          )
          : planeX + radius >= tile.colliders[index] && planeX - radius <= tile.colliders[index + 2] &&
            planeZ + radius >= tile.colliders[index + 1] && planeZ - radius <= tile.colliders[index + 3];
        if (hasExactFootprints) this.queryDiagnostics.exactTests++;
        if (overlapsFootprint) considerSweepHit(out, planeTime, 0, normalY, 0, tile, index);
      }
    }
    return out;
  }

  clipCamera(target, desired, radius = .03, out = {}) {
    const dx = desired.x - target.x;
    const dy = desired.y - target.y;
    const dz = desired.z - target.z;
    const hit = this.sweepSphere(target.x, target.y, target.z, dx, dy, dz, radius, out);
    let previousAmount = 0;
    for (let sample = 1; sample <= 8; sample++) {
      const amount = sample / 8;
      const x = target.x + dx * amount, y = target.y + dy * amount, z = target.z + dz * amount;
      this.queryDiagnostics.terrainCameraTests++;
      if (y - radius >= terrainHeightAt(x, z, this.terrainSeed)) { previousAmount = amount; continue; }
      let low = previousAmount, high = amount;
      for (let iteration = 0; iteration < 5; iteration++) {
        const middle = (low + high) / 2;
        const middleX = target.x + dx * middle, middleY = target.y + dy * middle, middleZ = target.z + dz * middle;
        if (middleY - radius >= terrainHeightAt(middleX, middleZ, this.terrainSeed)) low = middle;
        else high = middle;
      }
      if (!hit.hit || high < hit.time) {
        const support = queryTerrainSupport(
          target.x + dx * high, target.z + dz * high, this.terrainSeed, this.cameraSupportCandidate,
        );
        hit.hit = true;
        hit.time = high;
        hit.normalX = support.normalX;
        hit.normalY = support.normalY;
        hit.normalZ = support.normalZ;
        hit.tileKey = 'terrain';
        hit.polygonIndex = -1;
      }
      this.queryDiagnostics.terrainCameraHits++;
      break;
    }
    out.blocked = hit.hit;
    out.amount = 1;
    if (!hit.hit) return out;
    const distance = Math.hypot(dx, dy, dz);
    const safeAmount = Math.max(0, hit.time - 1e-3 / Math.max(distance, 1e-6));
    desired.set(
      target.x + dx * safeAmount,
      target.y + dy * safeAmount,
      target.z + dz * safeAmount,
    );
    out.amount = safeAmount;
    return out;
  }

  supportAt(x, z, out = this.supportCandidate, { referenceY = Number.NaN } = {}) {
    this.queryDiagnostics.supportQueries++;
    queryTerrainSupport(x, z, this.terrainSeed, out);
    let bestDistance = Number.isFinite(referenceY) ? Math.abs(out.y - referenceY) : -out.y;
    for (const tile of this.tiles.values()) {
      const values = tile.roadSupportSegments, grid = tile.roadSupportGrid;
      if (!(values instanceof Float32Array) || tile.roadSupportStride !== 8 || !grid) continue;
      this.supportCandidates.clear();
      for (const offset of grid.large) this.supportCandidates.add(offset);
      for (const offset of grid.grid.get(`${Math.floor(x / COLLISION_CELL_SIZE)}:${Math.floor(z / COLLISION_CELL_SIZE)}`) ?? []) {
        this.supportCandidates.add(offset);
      }
      this.queryDiagnostics.supportCandidates += this.supportCandidates.size;
      this.queryDiagnostics.maxSupportCandidates = Math.max(
        this.queryDiagnostics.maxSupportCandidates, this.supportCandidates.size,
      );
      for (const offset of this.supportCandidates) {
        const x1 = values[offset], z1 = values[offset + 1], y1 = values[offset + 2];
        const x2 = values[offset + 3], z2 = values[offset + 4], y2 = values[offset + 5];
        const halfWidth = values[offset + 6], physicalLevel = Math.round(values[offset + 7]);
        const dx = x2 - x1, dz = z2 - z1, lengthSquared = dx * dx + dz * dz;
        const amount = lengthSquared ? Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / lengthSquared)) : 0;
        const nearestX = x1 + dx * amount, nearestZ = z1 + dz * amount;
        if ((x - nearestX) ** 2 + (z - nearestZ) ** 2 > halfWidth * halfWidth) continue;
        const y = y1 + (y2 - y1) * amount;
        const distance = Number.isFinite(referenceY) ? Math.abs(y - referenceY) : -y;
        const groundRoadOverridesTerrain = physicalLevel === 0 && out.kind === 'terrain';
        if (!groundRoadOverridesTerrain && (distance > bestDistance + 1e-6 ||
          (Math.abs(distance - bestDistance) <= 1e-6 && y <= out.y))) continue;
        const length = Math.sqrt(lengthSquared) || 1;
        const rise = (y2 - y1) / length;
        const inverseNormal = 1 / Math.hypot(rise, 1);
        out.x = x;
        out.y = y;
        out.z = z;
        out.normalX = -dx / length * rise * inverseNormal;
        out.normalY = inverseNormal;
        out.normalZ = -dz / length * rise * inverseNormal;
        out.slopeRadians = Math.acos(Math.max(-1, Math.min(1, out.normalY)));
        out.walkable = out.slopeRadians <= GEO_TERRAIN_DEFAULTS.maxWalkableSlope;
        out.kind = physicalLevel === 0 ? 'road' : physicalLevel > 0 ? 'bridge' : 'tunnel';
        out.physicalLevel = physicalLevel;
        bestDistance = distance;
      }
    }
    return out;
  }

  resolveGroundStep(fromX, fromZ, toX, toZ, {
    referenceY = Number.NaN,
    maxStepUp = GEO_TERRAIN_DEFAULTS.maxStepUp,
    maxStepDown = GEO_TERRAIN_DEFAULTS.maxStepDown,
    maxSlope = GEO_TERRAIN_DEFAULTS.maxWalkableSlope,
  } = {}, out = this.transitionCandidate) {
    if (![maxStepUp, maxStepDown, maxSlope].every(Number.isFinite) || maxStepUp < 0 || maxStepDown < 0 || maxSlope < 0) {
      throw new RangeError('Invalid ground-step policy');
    }
    this.queryDiagnostics.groundTransitions++;
    out.from = this.supportAt(fromX, fromZ, out.from ?? {}, { referenceY });
    out.to = this.supportAt(toX, toZ, out.to ?? {}, { referenceY: out.from.y });
    out.heightDelta = out.to.y - out.from.y;
    out.accepted = true;
    out.reason = 'accepted';
    if (out.to.slopeRadians > maxSlope) { out.accepted = false; out.reason = 'slope'; }
    else if (out.heightDelta > maxStepUp) { out.accepted = false; out.reason = 'step-up'; }
    else if (out.heightDelta < -maxStepDown) { out.accepted = false; out.reason = 'drop'; }
    if (!out.accepted) this.queryDiagnostics.groundRejects++;
    return out;
  }

  findSupportSlot(x, z, options = {}) {
    this.queryDiagnostics.placementQueries++;
    let best = null;
    for (const tile of this.tiles.values()) {
      if (tile.supportSlotStride !== GEO_SUPPORT_SLOT_STRIDE || !(tile.supportSlots instanceof Float32Array) ||
          !(tile.supportSlotStates instanceof Uint8Array)) continue;
      const candidate = findPackedSupportSlot(tile.supportSlots, tile.supportSlotStates, {
        ...options,
        nearX: x,
        nearZ: z,
      });
      if (!candidate) continue;
      if (best && (candidate.distanceSquared > best.distanceSquared + 1e-12 ||
        (Math.abs(candidate.distanceSquared - best.distanceSquared) <= 1e-12 &&
          (candidate.id > best.id || (candidate.id === best.id && tile.key >= best.tileKey))))) continue;
      best = { ...candidate, tileKey: tile.key };
    }
    return best;
  }

  claimSupportSlot(x, z, options = {}) {
    const slot = this.findSupportSlot(x, z, options);
    if (!slot) { this.queryDiagnostics.placementRejects++; return null; }
    const tile = this.tiles.get(slot.tileKey);
    if (!tile?.supportSlotStates || tile.supportSlotStates[slot.index] !== 0) {
      this.queryDiagnostics.placementRejects++;
      return null;
    }
    tile.supportSlotStates[slot.index] = 2;
    this.queryDiagnostics.placementClaims++;
    return slot;
  }

  releaseSupportSlot(slot) {
    if (!slot || typeof slot.tileKey !== 'string') return false;
    const released = releasePackedSupportSlot(this.tiles.get(slot.tileKey)?.supportSlotStates, slot.index);
    if (released) this.queryDiagnostics.placementReleases++;
    return released;
  }

  findSafePosition(x, z, radius = .16) {
    if (!this.collidesCircle(x, z, radius)) return { x, z };
    for (let ring = 1; ring <= 20; ring++) {
      const distance = ring * .55;
      const samples = Math.max(8, ring * 8);
      for (let sample = 0; sample < samples; sample++) {
        const angle = sample / samples * Math.PI * 2;
        const px = x + Math.cos(angle) * distance;
        const pz = z + Math.sin(angle) * distance;
        if (!this.collidesCircle(px, pz, radius)) return { x: px, z: pz };
      }
    }
    return { x, z };
  }

  coordinateAt(x, z) {
    return worldToCoordinate(this.reference, x, z);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.plantMountTimer != null) clearTimeout(this.plantMountTimer);
    this.plantMountTimer = null;
    this.pendingPlantOwners.clear();
    this.worker.terminate();
    for (const tile of [...this.tiles.values()]) this._evictTile(tile);
    this.tiles.clear(); this.queue.length = 0;
    this.plantRenderPools.dispose();
    this.streetFurniturePools.dispose();
    this.bridgePools.dispose();
    this.landmarkPools.dispose();
    this.ambientLifePools.dispose();
    this.root.removeFromParent(); this.root.clear();
    this.groundMaterial.dispose();
    this.roadMaterial.dispose(); this.landMaterial.dispose(); this.buildingMaterial.dispose();
    this.waterMaterial.dispose(); this.decorationMaterial.dispose();
    for (const geometry of this.decorationGeometries) geometry?.dispose();
    this.materialLibraryHandle?.release();
  }
}
