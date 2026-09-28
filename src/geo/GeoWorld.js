import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GDO_FEATURE_VERSIONS, GDO_GENERATOR_VERSION } from '../engine/FeatureVersions.js';
import { PlantRenderPools } from '../engine/PlantRenderPools.js';
import { StreetFurniturePools } from './GeoStreetFurniturePools.js';
import { BridgePools } from './GeoBridgePools.js';
import { LandmarkPools } from './GeoLandmarkPools.js';
import { GEO_TILE_CACHE_LIMITS } from './GeoTileCache.js';
import { LifecycleLedger } from '../engine/LifecycleContract.js';
import { defineWorldDomain } from '../engine/DomainInterface.js';
import { resolveMapSchema } from './GeoMapSemantics.js';
import {
  GEO_ECOLOGICAL_DOMAIN,
  GEO_WATER_CLASS,
  GEO_WATER_FLOW_SOURCE,
  queryWaterDomain,
  waterClassName,
} from './GeoWaterDomains.js';
import {
  AmbientLifePools,
  GDO_AMBIENT_LIFE_SOURCE_TYPES,
  createAmbientLifeMaterial,
} from '../engine/AmbientLifeMotion.js';
import { createAmbientLifeScheduler } from '../engine/AmbientLifeScheduler.js';
import { createCameraFade } from '../engine/CameraFade.js';
import { GDO_WATER_VISUAL_CLASSES } from '../engine/WaterVisualClasses.js';
import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';
import {
  GDO_PROP_FAMILIES, GDO_PROP_FAMILY_IDS, propToneColor, queryPropTriggerStream,
} from '../engine/PropGrammar.js';
import {
  createWaterVisualMaterial, createWaterVisualPolicy, waterVisualAppearance,
} from '../engine/WaterVisualClasses.js';
import {
  applySurfaceDetail, describeSurfaceDetailCatalogue, rolloutSurfaceDetails,
  selectSurfaceDetail, surfaceDetailOf,
} from '../engine/SurfaceDetailCatalogue.js';
import { DynamicProxyGrid } from '../engine/DynamicProxyGrid.js';
import { createDiscoveryJournal, createJournalStorage } from '../engine/DiscoveryJournal.js';
import {
  GDO_WATER_CONTACT_PROFILES,
  GDO_WATER_STATE,
  GDO_WATER_SURFACE_SOURCE,
  classifyWaterContact,
  planWaterExit,
} from '../engine/WaterContact.js';
import {
  acquireProceduralMaterialLibrary,
  configureSemanticMaterial,
} from '../engine/ProceduralMaterials.js';
import { GEO_LAYER, GEO_SURFACE_Y } from './GeoLayers.js';
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
const GEO_TILE_CACHE_PROFILES = GEO_TILE_CACHE_LIMITS.profiles;
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
  // `ENV-03`: the water vertex bake — class tints, wave manner, flow, shore.
  if (data.shallow?.length) geometry.setAttribute('gdoWaterShallow', new THREE.BufferAttribute(data.shallow, 3));
  if (data.deep?.length) geometry.setAttribute('gdoWaterDeep', new THREE.BufferAttribute(data.deep, 3));
  if (data.manner?.length) geometry.setAttribute('gdoWaterManner', new THREE.BufferAttribute(data.manner, 4));
  if (data.flow?.length) geometry.setAttribute('gdoWaterFlow', new THREE.BufferAttribute(data.flow, 2));
  if (data.classCode?.length) geometry.setAttribute('gdoWaterClass', new THREE.BufferAttribute(data.classCode, 1));
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

/** `DET-10`: the prop families' geometry range inside the decoration table. */
const PROP_TYPE_BASE = 13;

function createPropGeometry(familyIndex) {
  const family = GDO_PROP_FAMILIES[familyIndex];
  const pieces = [];
  const moduleBoxes = family.modules.map((module, index) => ({
    index, role: module.role, size: module.size, offset: module.offset,
    tone: module.tone, spin: module.spin ?? 0, tilt: module.tilt ?? 0,
  }));
  for (const module of moduleBoxes) {
    const [width, height, depth] = module.size;
    const [x, y, z] = module.offset;
    // Every module keeps its own grammar tone, so a topping never reads as part
    // of the structure it sits on.
    pieces.push(coloredBox([width, height, depth], [x, y, z], propToneColor(module.tone), module.spin ?? 0, module.tilt ?? 0));
  }
  const merged = mergeGeometries(pieces, false);
  for (const piece of pieces) piece.dispose();
  merged.computeBoundingSphere();
  return merged;
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

/** GLSL-style smoothstep, used by the CPU mirror of generated-material fades. */
function smoothstep(edge0, edge1, value) {
  if (!(edge1 > edge0)) return value < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function prefersReducedPlantMotion(environment = globalThis) {
  try { return environment?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true; }
  catch { return false; }
}

/**
 * `FND-08`: the coordinate world declares the same world-domain interface as the
 * curated island, at its own scale (0.1 world units per metre), with the
 * capabilities it actually has: coordinates, streamed residency, terrain
 * support, a dynamic camera sweep, place labels, and graded bridges.
 */
export const GDO_COORDINATE_WORLD_DOMAIN = defineWorldDomain({
  id: 'coordinate',
  label: 'Coordinate explorer',
  unitsPerMetre: .1,
  streaming: { chunkSize: 2048, residentLimit: 4 },
  capabilities: {
    coordinates: true, terrainSupport: true, dynamicSweep: true,
    labels: true, streamed: true, verticalGrades: true,
    // `DET-10`: the props the world places are the interaction target the
    // `GME-05` registry's `interact` action is declared against.
    interaction: true,
  },
});

export class GeoWorld {
  constructor(scene, {
    latitude,
    longitude,
    onStatus = () => {},
    onInitialReady = () => {},
    providers,
    profile = 'low',
    materialLibrary = null,
    camera = null,
    viewportHeight = 720,
    reducedMotion = prefersReducedPlantMotion(),
    ledger = null,
  }) {
    this.scene = scene;
    // `FND-08`: one shared domain descriptor, so shared consumers can query this
    // world exactly like the curated island without assuming either scale.
    this.domain = GDO_COORDINATE_WORLD_DOMAIN;
    this.unitsPerMetreScale = this.domain.unitsPerMetre;
    this.domainBounds = null;
    // `FND-07`: the world owns one ledger scope. Every worker, listener, timer,
    // material, tile geometry, and pool resource below registers in it, so
    // `dispose()` is auditable and a remount provably returns to baseline.
    this.lifecycle = ledger ? ledger.child('world') : new LifecycleLedger({ label: 'world' });
    this.tileLifecycle = this.lifecycle.child('tiles');
    this.materialLibraryHandle = materialLibrary ? null : acquireProceduralMaterialLibrary();
    this.materialLibrary = materialLibrary ?? this.materialLibraryHandle.library;
    this.reference = createGeoReference(latitude, longitude, SOURCE_ZOOM);
    this.terrainSeed = terrainSeedForCoordinate(latitude, longitude);
    this.onStatus = onStatus;
    this.onInitialReady = onInitialReady;
    this.providers = providers;
    // MAP-09 storage policy follows the active quality profile; the low ceiling
    // is the default so an unset profile can never widen persistent storage.
    this.profile = GEO_TILE_CACHE_PROFILES.includes(profile) ? profile : 'low';
    this.tileCacheDiagnostics = null;
    this.tileCacheServed = 0;
    // `DET-10`: props are counted once per placement, and only authored proxies
    // can ever appear in the collision stream.
    this.tileProps = 0;
    this.propPlacements = 0;
    this.propSolidBoxes = 0;
    this.propTriggerCeiling = GDO_LOW_PROFILE_BUDGETS.propTriggersPerTile;
    // `DET-10`: the host registers the `interact` verb through the `GME-05`
    // registry (GeoGame owns it) and records the outcome here.
    this.propInteraction = null;
    this.tileCacheRetained = '';
    this.tiles = new Map();
    this.queue = [];
    this.activeRequests = 0;
    this.nextRequestId = 1;
    this.disposed = false;
    this.initialReady = false;
    this.lastFocusKey = null;
    this.totalBytes = 0;
    this.provider = 'Connecting…';
    // `MAP-08`: the schema of the provider that actually served the resident
    // tiles, so the debug surface can name the vocabulary being normalized.
    this.providerSchema = resolveMapSchema(this.providers?.[0]?.schema ?? this.providers?.[0]?.id);
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
    // `ENV-03`: the water material and its class/profile policy. The low path is
    // opaque and single-family; higher profiles are the bounded blended path.
    this.waterMaterial = createWaterVisualMaterial({ library: this.materialLibrary, profile });
    this.waterVisual = createWaterVisualPolicy({ material: this.waterMaterial, library: this.materialLibrary, profile });
    this.decorationMaterial = configureSemanticMaterial(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .84, metalness: 0 }),
      'decoration', this.materialLibrary, 'low',
    );
    // `MAT-05`: the catalogue decides which generated detail pattern each surface
    // wears at this profile. Patterns are applied in catalogue priority order, one
    // per live material — a surface whose material already carries a pattern (the
    // roof rides the building material) or whose material is bespoke (the water
    // shader owns its own surface) is reported as skipped with its reason instead
    // of silently overwriting a neighbour. The key is the world's own terrain seed
    // plus the profile, so the same coordinate and quality always roll out the
    // same set.
    this.surfaceDetailRollout = rolloutSurfaceDetails(profile ?? 'low');
    this.surfaceDetailKey = `${this.terrainSeed}:${profile ?? 'low'}`;
    const detailMaterials = new Map([
      ['ground', this.groundMaterial], ['land', this.landMaterial], ['road', this.roadMaterial],
      ['facade', this.buildingMaterial], ['roof', this.buildingMaterial], ['water', this.waterMaterial],
      ['decoration', this.decorationMaterial],
    ]);
    const applied = {}, skipped = [], assigned = new Set();
    for (const entry of this.surfaceDetailRollout.entries) {
      const material = detailMaterials.get(entry.surface);
      if (!material) { skipped.push(Object.freeze({ surface: entry.surface, pattern: entry.id, reason: 'no-material' })); continue; }
      if (!material.userData?.gdoSemanticMaterial) {
        skipped.push(Object.freeze({ surface: entry.surface, pattern: entry.id, reason: 'bespoke-shader' }));
        continue;
      }
      if (assigned.has(material)) {
        skipped.push(Object.freeze({ surface: entry.surface, pattern: entry.id, reason: 'material-shared' }));
        continue;
      }
      applied[entry.surface] = applySurfaceDetail(material, entry, this.materialLibrary, profile ?? 'low').id;
      assigned.add(material);
    }
    this.surfaceDetailSurfaces = Object.freeze({
      namespace: this.surfaceDetailRollout.namespace,
      profile: profile ?? 'low',
      applied: Object.freeze(applied),
      appliedCount: assigned.size,
      skipped: Object.freeze(skipped),
    });
    this.decorationGeometries = [
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
        .map(type => GEO_PLANT_TYPES.has(type) || GDO_AMBIENT_LIFE_SOURCE_TYPES[type]
          ? null : createDecorationGeometry(type)),
      // `DET-10`: one compiled geometry per prop family, drawn by the same pools.
      ...GDO_PROP_FAMILIES.map((family, index) => createPropGeometry(index)),
    ];
    this.propTypes = Object.freeze(Object.fromEntries(
      GDO_PROP_FAMILIES.map((family, index) => [PROP_TYPE_BASE + index, family.id])));
    this.lifecycle.own('material', 'ground', this.groundMaterial, item => item.dispose?.());
    for (const [name, material] of [['road', this.roadMaterial], ['land', this.landMaterial],
      ['building', this.buildingMaterial], ['water', this.waterMaterial], ['decoration', this.decorationMaterial]]) {
      this.lifecycle.own('material', name, material, item => item.dispose?.());
    }
    this.decorationGeometries.forEach((geometry, index) => {
      if (geometry) this.lifecycle.own('geometry', `decoration:${index}`, geometry, item => item.dispose?.());
    });
    this.lifecycle.own('node', 'root', this.root, item => item.removeFromParent?.());
    if (this.materialLibraryHandle) this.lifecycle.handle('material-library',
      () => this.materialLibraryHandle.release(), this.materialLibraryHandle.library);
    this.streetFurniturePools = new StreetFurniturePools(this.root, {
      material: this.decorationMaterial,
      terrainSeed: this.terrainSeed,
      renderOrder: GEO_LAYER.decoration.renderBand,
      ledger: this.lifecycle,
    });
    // DET-08 bridge detail is a purely self-describing instanced stream: the
    // pool never samples terrain and never re-derives the authoritative deck.
    this.bridgePools = new BridgePools(this.root, {
      material: this.decorationMaterial,
      renderOrder: GEO_LAYER.decoration.renderBand,
      ledger: this.lifecycle,
    });
    // DET-09 hero landmarks are one compiled, hidden-face-reduced mesh per tile.
    // Only the focused tile's hero is visible, so a landmark costs one draw.
    this.landmarkPools = new LandmarkPools(this.root, {
      material: this.decorationMaterial,
      renderOrder: GEO_LAYER.building.renderBand + 2,
      ledger: this.lifecycle,
    });
    // VEG-09 already owns reduced motion for plants; ambient life reads the
    // same flag so one preference change covers every animated family.
    // `LAY-06`: the camera-fade policy owns the one screen-door discard rule,
    // and the ambient sprites are its explicitly eligible clutter. The dither
    // mask is `MAT-02`'s shared one; the fade path creates no texture.
    this.cameraFade = createCameraFade({ profile: 'low', reducedMotion });
    const fadeDither = this.materialLibrary?.textures?.dither ?? null;
    if (fadeDither) this.cameraFade.uniforms.dither.value = fadeDither;
    this.ambientLifeMaterial = fadeDither
      ? createAmbientLifeMaterial({ ditherUniform: this.cameraFade.uniforms.dither })
      : null;
    this.ambientLifePools = new AmbientLifePools(this.root, {
      material: this.ambientLifeMaterial ?? null,
      ledger: this.lifecycle,
      terrainSeed: this.terrainSeed,
      renderOrder: GEO_LAYER.ambience.renderBand,
      layer: GEO_LAYER.ambience,
      reducedMotion,
      resolveGroundHeight: terrainHeightAt,
    });
    this.lastAmbientFade = null;
    this.lastCameraFadeMilliseconds = 0;
    // `LIF-02`: the explicit screen-space/activity scheduler on top of the
    // ambient pools. It reads the same camera the world already renders with.
    this.ambientScheduler = createAmbientLifeScheduler({ profile: 'low', ledger: this.lifecycle });
    this.ambientView = {
      x: 0, y: 0, z: 0, forwardX: 0, forwardZ: -1, rightX: 1, rightZ: 0,
      fovRadians: Math.PI / 3, viewportHeight: 720, aspect: 1,
      cycleIndex: 0, nowMilliseconds: 0,
    };
    this.ambientSchedule = null;
    this.ambientForward = new THREE.Vector3();
    this.ambientRight = new THREE.Vector3();
    this.plantRenderPools = new PlantRenderPools(this.root, {
      profile: 'low',
      // Recipe geometry is global and versioned; geographic variation belongs
      // to compact placement morphology, not coordinate-specific libraries.
      environmentKey: GDO_VEGETATION_MORPHOLOGY_NAMESPACE,
      seedSalt: hashText(GDO_VEGETATION_MORPHOLOGY_NAMESPACE),
      materialLibrary: this.materialLibrary,
      renderOrder: GEO_LAYER.decoration.renderBand,
      reducedMotion,
      ledger: this.lifecycle,
    });
    // Preserve the VEG-05 diagnostics surface while the visible VEG-06 owner
    // pool becomes the lifecycle authority.
    this.plantLods = this.plantRenderPools.library;
    this.plantLodSelector = this.plantRenderPools.selector;
    // `COL-09`: the capped moving-solid hash. It shares the semantic masks with
    // the static tiles, so `collidesCircle`/`sweepCircle`/`sweepSphere` merge one
    // contact set for the player, the camera, and future agents.
    this.dynamicProxies = new DynamicProxyGrid({ profile: 'low', ledger: this.lifecycle });
    // `GME-06`: the discovery journal is bounded local state. Ids and eviction
    // are deterministic, so the same walk keeps the same journal, and the
    // versioned payload restores through a store that refuses to guess.
    this.discoveryJournal = createDiscoveryJournal({ profile: this.profile });
    this.discoverySummary = null;
    this.discoveryStorage = null;
    try {
      // A browser that refuses storage (private mode, quota) just runs without
      // persistence: the accessor itself can throw, so it is probed here.
      const store = globalThis.localStorage;
      if (store && typeof store.getItem === 'function') {
        this.discoveryStorage = createJournalStorage(store);
        this.discoveryStorage.load(this.discoveryJournal, 0);
      }
    } catch { this.discoveryStorage = null; }
    this.nextDiscoveryPassMilliseconds = 0;
    this.dynamicCandidateIds = [];
    this.dynamicWindow = { x: 0, z: 0, radius: 0 };
    this.activeBiome = { id: 'temperate', label: 'Reading map landscape…', ground: [.16, .30, .10] };

    this.worker = new Worker(new URL('./GeoTileWorker.js', import.meta.url), { type: 'module', name: 'map-tile-generator' });
    this.lifecycle.worker(this.worker, 'tile-generator');
    this.lifecycle.listener(this.worker, 'message', event => this._handleWorkerMessage(event.data));
    this.lifecycle.listener(this.worker, 'error', event => {
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

    // The ground grid is tile-owned like every other slot, so eviction and
    // remount account for it through the same ledger path.
    const tile = {
      key, x, y, root, bounds, ground,
      lifecycleEntries: new Map(),
      state: 'queued', requestId: this.nextRequestId++, priority,
      roads: null, land: null, water: null, decorations: [], buildings: null, buildingDetails: null,
      labels: [], biome: null, environment: null, roadMeta: null, buildingMeta: null, timings: null,
      waterDomain: null, waterDomainMeta: null, streetFurnitureMeta: null, streetFurnitureCount: 0,
      bridgeMeta: null, bridgeCount: 0,
      landmarkMeta: null, landmarkGrammar: null, landmarkCount: 0,
      clearanceDiagnostics: null, morphologyDiagnostics: null,
      roadSupportSegments: null, roadSupportStride: 0, roadSupportGrid: null,
      colliders: null, collisionGrid: null,
      // `DET-10`: prop records, triggers, authored solids, and their diagnostics.
      props: null, propTriggers: null, propSolids: null, propStride: 6, propDiagnostics: null,
      collisionVertices: null, collisionRingOffsets: null, collisionPolygonOffsets: null,
      collisionSpans: null, collisionMasks: null,
      supportSlots: null, supportSlotStates: null, supportSlotStride: 0,
      lastUsed: performance.now(), bytes: 0,
      roadFeatures: 0, landFeatures: 0, waterFeatures: 0, decorationCount: 0, plantPoolCount: 0,
      ambientLifeCount: 0, buildingFeatures: 0, truncated: false,
      retryCount: 0, retryAt: 0,
    };
    this._ownTileGeometry(tile, 'ground', groundGeometry);
    this.tiles.set(key, tile);
    this.queue.push(tile);
    this.queue.sort((a, b) => a.priority - b.priority);
    this._pumpQueue();
    this._retainTileCacheEntries();
    this._emitStatus();
  }

  /**
   * Tell the worker which resident tiles own the cache's pinned slots, so LRU
   * trims can never remove the tiles the player is actually standing in. Bounded
   * to the four resident tiles and sent only when that set changes.
   */
  _retainTileCacheEntries() {
    if (this.disposed || !this.worker) return;
    const descriptors = [...this.tiles.values()]
      .map(tile => ({
        zoom: this.reference.zoom,
        urlX: wrapTileX(tile.x, this.reference.zoom),
        urlY: clampTileY(tile.y, this.reference.zoom),
      }))
      .sort((first, second) => first.zoom - second.zoom || first.urlX - second.urlX || first.urlY - second.urlY);
    // One message per resident-set change, never per frame.
    const fingerprint = descriptors.map(entry => `${entry.zoom}/${entry.urlX}/${entry.urlY}`).join(',');
    if (fingerprint === this.tileCacheRetained) return;
    this.tileCacheRetained = fingerprint;
    this.worker.postMessage({ type: 'retain', descriptors, providers: this.providers, profile: this.profile });
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
          profile: this.profile,
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
    const names = ['trees', 'palms', 'shrubs', 'street-lamps', 'rocks', 'flowers', 'benches', 'parked-cars', 'herbs', 'tall-grass', 'birds', 'bees', 'bamboo',
      // `DET-10`: the prop families draw under their own family names.
      ...GDO_PROP_FAMILY_IDS];
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
    const timer = setTimeout(() => {
      this.plantMountTimer = null;
      this.plantTimerHandle?.release();
      this.plantTimerHandle = null;
      this._flushPlantMounts();
    }, 0);
    this.plantMountTimer = timer;
    this.plantTimerHandle = this.lifecycle.timer('timer', timer, handle => clearTimeout(handle), 'plant-mount');
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
    if (message.tileCache) {
      this.tileCacheDiagnostics = message.tileCache;
      // A cache hit is a skipped download: the HUD reports it as saved bytes.
      if (message.servedFromCache) this.tileCacheServed++;
    }

    const mountStarted = performance.now();
    this.provider = message.provider || this.provider;
    this.providerSchema = resolveMapSchema(message.providerId ?? message.provider, this.providerSchema);
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
        this._releaseTileGeometry(tile, 'roads');
        tile.roads = null;
      }
      if (geometry) {
        this._ownTileGeometry(tile, 'roads', geometry);
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
      this._releaseTileGeometry(tile, 'land');
      this._releaseTileGeometry(tile, 'water');
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
      // `DET-10`: a released tile keeps no prop records, triggers, or solids.
      tile.props = null; tile.propTriggers = null; tile.propSolids = null; tile.propDiagnostics = null;
      if (tile.collisionHasPropSolids) tile.collisionHasPropSolids = false;
      tile.decorationCount = 0; tile.plantPoolCount = 0; tile.streetFurnitureCount = 0;
      tile.ambientLifeCount = 0;
      try {
        const landGeometry = createBufferGeometry(context.land);
        if (landGeometry) {
          this._ownTileGeometry(tile, 'land', landGeometry);
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
          this._ownTileGeometry(tile, 'water', waterGeometry);
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
      // `DET-10`: the placed props, the flat trigger stream gameplay reads, and
      // the authored solid proxies that (and only those) may block the player.
      tile.props = context.props instanceof Float32Array ? context.props : null;
      tile.propTriggers = context.propTriggers instanceof Float32Array ? context.propTriggers : null;
      tile.propSolids = context.propSolids instanceof Float32Array ? context.propSolids : null;
      tile.propStride = context.propStride || 6;
      tile.propDiagnostics = context.propDiagnostics ?? null;
      if (tile.propDiagnostics?.placed) {
        this.tileProps++;
        this.propPlacements += tile.propDiagnostics.placed;
      }
      if (tile.propDiagnostics?.solidProxies) this.propSolidBoxes += tile.propDiagnostics.solidProxies;
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
        this._releaseTileGeometry(tile, 'buildings');
        tile.buildings = null;
      }
      if (tile.buildingDetails) {
        tile.buildingDetails.removeFromParent();
        this._releaseTileGeometry(tile, 'buildingDetails');
        tile.buildingDetails = null;
      }
      if (geometry) {
        this._ownTileGeometry(tile, 'buildings', geometry);
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
        this._ownTileGeometry(tile, 'buildingDetails', detailGeometry);
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
      // `DET-10`: a prop without an authored solid proxy contributes nothing here;
      // a family that declares one contributes exactly its declared boxes.
      const propSolids = tile.propSolids?.length
        ? new Float32Array([...tile.colliders, ...tile.propSolids])
        : tile.colliders;
      tile.collisionGrid = buildCollisionGrid(propSolids);
      tile.collisionHasPropSolids = Boolean(tile.propSolids?.length);
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
      providerSchema: this.providerSchema,
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
      // MAP-09 persistent tile cache. The ceilings are the active profile's own,
      // so the debug panel can show how much of the allowance is in use.
      tileCacheEntries: this.tileCacheDiagnostics?.entries ?? 0,
      tileCacheBytes: this.tileCacheDiagnostics?.bytes ?? 0,
      tileCacheMaxEntries: this.tileCacheDiagnostics?.maxEntries ?? GEO_TILE_CACHE_LIMITS.maxEntries[this.profile],
      tileCacheMaxBytes: this.tileCacheDiagnostics?.maxBytes ?? GEO_TILE_CACHE_LIMITS.maxBytes[this.profile],
      tileCacheHits: this.tileCacheDiagnostics?.hits ?? 0,
      tileCacheMisses: this.tileCacheDiagnostics?.misses ?? 0,
      tileCacheWrites: this.tileCacheDiagnostics?.writes ?? 0,
      tileCacheEvictions: this.tileCacheDiagnostics?.evictions ?? 0,
      tileCacheExpirations: this.tileCacheDiagnostics?.expirations ?? 0,
      tileCacheAttributionRejections: this.tileCacheDiagnostics?.attributionRejections ?? 0,
      tileCacheStorageErrors: this.tileCacheDiagnostics?.storageErrors ?? 0,
      tileCacheServed: this.tileCacheServed,
      tileCachePersistent: this.tileCacheDiagnostics?.persistent ?? false,
      tileCacheStorageKind: this.tileCacheDiagnostics?.storageKind ?? 'none',
      tileCachePinned: this.tileCacheDiagnostics?.pinned ?? 0,
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
      // `DET-10`: the placed props, their triggers, and the authored proxies that
      // are the only prop geometry allowed to reach the collision stream.
      propFamilies: GDO_PROP_FAMILIES.length,
      propPlacements: this.propPlacements,
      propTiles: this.tileProps,
      propTriggers: this.propTriggerCount(),
      propTriggerCeiling: this.propTriggerCeiling,
      propSolidBoxes: this.propSolidBoxes,
      propInteraction: this.propInteraction,
      // `ENV-03`: the water path, its class table, and the per-frame counters.
      waterVisualPath: this.waterVisual?.appearance.path ?? null,
      waterVisualClasses: Object.keys(GDO_WATER_VISUAL_CLASSES).length,
      waterVisualBlendedFamilies: this.waterVisual?.appearance.blendedFamilies ?? 0,
      waterVisualOverdrawLayers: this.waterVisual?.appearance.overdrawLayers ?? 0,
      waterVisualWaveScales: this.waterVisual?.appearance.waveScales ?? 0,
      waterVisualUniformWrites: this.waterVisual?.diagnostics.steadyFrameWrites ?? 0,
      waterVisualSteadyFrameAllocations: this.waterVisual?.diagnostics.steadyFrameAllocations ?? 0,
      // `MAT-05`: the generated detail patterns this world rolled out per surface,
      // and the surfaces it deliberately left alone with the reason.
      surfaceDetailPatterns: this.surfaceDetailRollout?.patterns ?? 0,
      surfaceDetailApplied: this.surfaceDetailSurfaces?.appliedCount ?? 0,
      surfaceDetailSurfaces: this.surfaceDetailSurfaces?.applied ?? null,
      surfaceDetailSkipped: this.surfaceDetailSurfaces?.skipped ?? null,
      plantRenderEntries: this.plantRenderPools.diagnostics.entries,
      plantRenderPools: this.plantRenderPools.diagnostics.activeDrawPools,
      plantRenderTriangles: this.plantRenderPools.diagnostics.visibleTriangles,
      // `VEG-02`: the live silhouette cost after LOD, not an estimate.
      plantBoxModules: this.plantRenderPools.diagnostics.boxModules,
      plantDrawnInstances: this.plantRenderPools.diagnostics.drawnInstances,
      plantLodSwitches: this.plantLodSelector.diagnostics.switches,
      plantLodHysteresisHolds: this.plantLodSelector.diagnostics.hysteresisHolds,
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

  /**
   * `LIF-02`: one screen-space scheduling pass per frame. The camera's own basis
   * and field of view are the inputs, so first- and third-person both work, and
   * the pool parks what the budget cannot afford.
   */
  scheduleAmbientLife(nowMilliseconds = this.lastAmbientScheduleMilliseconds ?? 0) {
    const pools = this.ambientLifePools, scheduler = this.ambientScheduler;
    if (!pools || !scheduler || this.disposed) return null;
    if ((pools.entries ?? 0) === 0 && (pools.packedRecords?.every(records => records.length === 0) ?? true)) {
      return null;
    }
    const view = this.ambientView;
    const camera = this.viewCamera;
    if (camera) {
      view.x = camera.position.x;
      view.y = camera.position.y;
      view.z = camera.position.z;
      camera.getWorldDirection(this.ambientForward);
      const horizontal = Math.hypot(this.ambientForward.x, this.ambientForward.z);
      if (horizontal > 1e-4) {
        view.forwardX = this.ambientForward.x / horizontal;
        view.forwardZ = this.ambientForward.z / horizontal;
        // The right vector is the horizontal forward turned 90°.
        view.rightX = -view.forwardZ;
        view.rightZ = view.forwardX;
      }
      view.fovRadians = (camera.fov ?? 60) * Math.PI / 180;
      view.aspect = camera.aspect || 1;
    }
    view.viewportHeight = this.viewportHeight;
    view.nowMilliseconds = Number.isFinite(nowMilliseconds) ? nowMilliseconds : 0;
    view.cycleIndex = Math.floor(view.nowMilliseconds / 1_000);
    this.lastAmbientScheduleMilliseconds = view.nowMilliseconds;
    this.ambientSchedule = pools.scheduleVisibility(scheduler, view);
    return this.ambientSchedule;
  }

  // Ambient life motion now lives entirely in the shared vertex program; the
  // world only forwards the frame clock (one uniform write, zero matrices).

  /**
   * `GME-06`: one discovery pass over the names the readout is already showing.
   *
   * The pass is throttled to the label-refresh cadence, so the journal never
   * rebuilds the visible-name list every frame, and it writes local state only
   * when something became visited (plus a slow heartbeat) — a reload keeps what
   * the player found without a storage write per frame.
   */
  observeDiscovery(x, z, nowMilliseconds = 0) {
    const journal = this.discoveryJournal;
    if (!journal || this.disposed) return this.discoverySummary;
    if (nowMilliseconds < this.nextDiscoveryPassMilliseconds) return this.discoverySummary;
    this.nextDiscoveryPassMilliseconds = nowMilliseconds + 250;
    journal.observeAll(this.visibleLabels, { x, z, clock: nowMilliseconds });
    const summary = journal.progress();
    this.discoverySummary = summary;
    if (this.discoveryStorage &&
        (summary.visited !== (this.discoverySavedVisited ?? 0) ||
          nowMilliseconds - (this.discoverySavedMilliseconds ?? nowMilliseconds) >= 30_000)) {
      this.discoverySavedVisited = summary.visited;
      this.discoverySavedMilliseconds = nowMilliseconds;
      this.discoveryStorage.save(journal);
    }
    return summary;
  }

  /** `GME-06`: restore the journal from the local store, if there is one. */
  /**
   * `DET-10`: the nearest prop trigger within its own declared range, read from
   * the resident tiles' flat streams. The test is a bounded distance check over
   * preallocated records — no `Box3`, no per-frame rebuild, no allocation — so a
   * bobbing or spinning prop keeps the same stable interaction range.
   */
  queryPropTrigger(x, y, z, { range = 0 } = {}) {
    let best = null;
    for (const tile of this.tiles.values()) {
      const stream = tile.propTriggers;
      if (!stream?.length) continue;
      const hit = queryPropTriggerStream(stream, tile.propStride ?? 6, x, y, z);
      if (!hit) continue;
      if (range > 0 && hit.distance > range) continue;
      if (best && hit.distance >= best.distance) continue;
      best = { ...hit, tileKey: tile.key };
    }
    if (!best) return null;
    const family = GDO_PROP_FAMILIES[best.action] ?? null;
    return Object.freeze({
      tileKey: best.tileKey,
      family: family?.id ?? null,
      order: best.prop,
      distance: best.distance,
      range: best.radius,
      action: 'interact',
    });
  }

  /** Resident prop triggers, so the debug surface can show the live count. */
  propTriggerCount() {
    let total = 0;
    for (const tile of this.tiles.values()) total += (tile.propTriggers?.length ?? 0) / (tile.propStride ?? 6);
    return total;
  }

  loadDiscovery() {
    return this.discoveryStorage?.load(this.discoveryJournal, 0) ?? 0;
  }

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
    this.waterVisual.beginFrame(time);
    this.ambientLifePools.update(nowMilliseconds);
    this.scheduleAmbientLife(nowMilliseconds);
    // `LAY-06`: the fade decision runs on the same camera and avatar the frame
    // uses, after the scheduler has parked what it cannot afford, so a parked
    // sprite never costs a fade upload.
    if (this.cameraFade && !this.cameraFade.disposed && this.viewCamera) {
      const fadeStep = Number.isFinite(this.lastCameraFadeMilliseconds)
        ? nowMilliseconds - this.lastCameraFadeMilliseconds : 0;
      this.lastCameraFadeMilliseconds = nowMilliseconds;
      this.lastAmbientFade = this.ambientLifePools.applyCameraFade(this.cameraFade, {
        cameraX: this.viewCamera.position.x,
        cameraY: this.viewCamera.position.y,
        cameraZ: this.viewCamera.position.z,
        avatarX: position.x,
        avatarY: position.y,
        avatarZ: position.z,
        dtMilliseconds: fadeStep,
      });
    }
    this.observeDiscovery(position.x, position.z, nowMilliseconds);
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
    this._retainTileCacheEntries();
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
    for (const slot of ['ground', 'roads', 'land', 'water', 'buildings', 'buildingDetails']) {
      this._releaseTileGeometry(tile, slot);
    }
    tile.decorations.length = 0;
    // `DET-10`: a prop's records, triggers, and authored solids leave with its tile.
    tile.props = null;
    tile.propTriggers = null;
    tile.propSolids = null;
    tile.propDiagnostics = null;
    tile.collisionHasPropSolids = false;
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
    // `COL-09`: moving solids answer the same query as the static tiles.
    if (this.dynamicOverlapsCircle(x, z, radius, queryMask, minY, maxY)) return true;
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
    out.dynamicId = null;
    out.dynamicKind = null;

    const sweepMinX = Math.min(x, x + dx) - radius;
    const sweepMaxX = Math.max(x, x + dx) + radius;
    const sweepMinZ = Math.min(z, z + dz) - radius;
    const sweepMaxZ = Math.max(z, z + dz) + radius;
    // `COL-09`: the merged moving-solid hit competes with the static hit on time.
    const dynamicHit = this.dynamicSweepCircle(x, z, dx, dz, radius, queryMask, minY, maxY);
    if (dynamicHit && dynamicHit.time <= out.time) {
      out.hit = true;
      out.time = dynamicHit.time;
      out.normalX = 0;
      out.normalZ = 0;
      out.startedOverlapping = dynamicHit.time === 0;
      out.tileKey = null;
      out.polygonIndex = -1;
      out.dynamicId = dynamicHit.id;
      out.dynamicKind = dynamicHit.kind;
      out.blockerId = dynamicHit.id ?? null;
      out.blockerRole = dynamicHit.kind ?? 'dynamic';
      out.blockerMask = queryMask;
    }
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

  /**
   * `COL-09`: exact overlap against the merged moving solids. Mirrors the static
   * path's role/Y filtering so a proxy cannot bypass the semantic masks.
   */
  dynamicOverlapsCircle(x, z, radius, queryMask, minY, maxY) {
    const grid = this.dynamicProxies;
    if (!grid || !grid.activeProxies) return null;
    const record = grid.overlapsCircle(x, z, radius, { queryMask, minY, maxY, out: this.dynamicCandidateIds ??= [] });
    if (!record) return null;
    for (const primitive of record.primitives) {
      if ((record.mask & queryMask) === 0) continue;
      if (maxY < primitive.ySpan[0] || minY > primitive.ySpan[1]) continue;
      return record;
    }
    return null;
  }

  /** `COL-09`: earliest continuous hit against the merged moving solids. */
  dynamicSweepCircle(x, z, dx, dz, radius, queryMask, minY, maxY) {
    const grid = this.dynamicProxies;
    if (!grid || !grid.activeProxies) return null;
    return grid.sweepCircle(x, z, dx, dz, radius, {
      queryMask, minY, maxY, out: this.dynamicCandidateIds ??= [],
    });
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
    // `COL-06`: the shared sweep record names its contact the same way the
    // curated structural sweep does, so a caller that consumes `querySweep`
    // needs no branch for which world answered.
    out.blockerId = null;
    out.blockerRole = null;
    out.blockerMask = 0;
    out.blockerDistance = 0;
    const sweepMinX = Math.min(x, x + dx) - radius;
    const sweepMaxX = Math.max(x, x + dx) + radius;
    const sweepMinZ = Math.min(z, z + dz) - radius;
    const sweepMaxZ = Math.max(z, z + dz) + radius;
    const sweepMinY = Math.min(y, y + dy) - radius;
    const sweepMaxY = Math.max(y, y + dy) + radius;

    // `COL-09`: a moving solid competes with the static hit on time here too, so
    // the camera, LOS and interaction sweeps share one authority.
    const dynamicHit = this.dynamicSweepCircle(x, z, dx, dz, radius, queryMask, sweepMinY, sweepMaxY);
    if (dynamicHit && dynamicHit.time <= out.time) {
      out.hit = true;
      out.time = dynamicHit.time;
      out.normalX = 0;
      out.normalY = 0;
      out.normalZ = 0;
      out.startedOverlapping = dynamicHit.time === 0;
      out.tileKey = null;
      out.polygonIndex = -1;
      out.dynamicId = dynamicHit.id;
      out.dynamicKind = dynamicHit.kind;
    }

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
    if (out.hit) {
      out.blockerDistance = Math.hypot(dx, dy, dz) * out.time;
      if (out.blockerId == null) {
        out.blockerId = out.polygonIndex >= 0 ? `${out.tileKey}:${out.polygonIndex}` : out.tileKey;
        out.blockerRole = 'structure';
        out.blockerMask = queryMask;
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

  /** Shared world interface: support height in world units at any x/z. */
  querySupport(x, z, out = this.supportCandidate) {
    const support = this.supportAt(x, z, out);
    return support;
  }


  /**
   * `COL-08`: water is a sensor, not a collider. The mapped surface under a body
   * plus its feet decide `dry`/`wading`/`swimming`/`submerged`, and the record
   * carries the speed, gravity, camera, and current values the player applies.
   */
  waterContact(x, z, { feetY = 0, groundY = null, bodyHeight = .18, gravity = 5.2, profile = 'low' } = {},
    out = this.waterContactRecord ??= {}) {
    if (![x, z, feetY, bodyHeight, gravity].every(Number.isFinite)) {
      throw new TypeError('Water contact needs finite coordinates, height, and gravity');
    }
    const tile = this._waterTileAt(x, z);
    const support = groundY === null
      ? this.supportAt(x, z, this.waterSupport ??= {}).y
      : groundY;
    if (!tile?.waterDomain) {
      return classifyWaterContact({
        waterSurfaceY: -Infinity, feetY, groundY: support, bodyHeight, gravity, profile,
        inWater: false, wet: false, source: GDO_WATER_SURFACE_SOURCE.NONE,
      }, out);
    }
    const water = queryWaterDomain(tile.waterDomain, x, z, this.waterQueryRecord ??= {});
    const wetlandDepth = GDO_WATER_CONTACT_PROFILES[profile]?.wetlandDepth ?? .05;
    const inWater = water.inWater;
    const waterSurfaceY = inWater ? GEO_SURFACE_Y.WATER
      : water.wetland ? GEO_SURFACE_Y.WATER - wetlandDepth
        : -Infinity;
    return classifyWaterContact({
      waterSurfaceY,
      feetY,
      groundY: support,
      bodyHeight,
      gravity,
      profile,
      inWater: inWater || water.wetland,
      wet: water.inWater || water.wetland || water.kind === GEO_ECOLOGICAL_DOMAIN.SHORELINE,
      flowX: water.flowX,
      flowZ: water.flowZ,
      waterClass: water.waterClass,
      waterClassName: water.waterClassName,
      source: inWater
        ? (water.flowSource === GEO_WATER_FLOW_SOURCE.WATERWAY
          ? GDO_WATER_SURFACE_SOURCE.MAPPED_WATERWAY : GDO_WATER_SURFACE_SOURCE.MAPPED_POLYGON)
        : water.wetland ? GDO_WATER_SURFACE_SOURCE.MAPPED_WETLAND : GDO_WATER_SURFACE_SOURCE.NONE,
    }, out);
  }

  /**
   * `COL-08` exit rules: the best bank inside a bounded four-sample fan. The
   * query answers "can this body climb out here, and if not, why".
   */
  waterExitPlan(x, z, { feetY = 0, bodyHeight = .18, gravity = 5.2, profile = 'low', radius = .055 } = {},
    out = this.waterExitRecord ??= {}) {
    const contact = this.waterContact(x, z, { feetY, bodyHeight, gravity, profile }, this.waterExitContact ??= {});
    let bestY = Number.NaN, bestWalkable = false, bestBlocked = true;
    for (let index = 0; index < 4; index++) {
      const angle = index * Math.PI / 2;
      const sampleX = x + Math.cos(angle) * radius * 2;
      const sampleZ = z + Math.sin(angle) * radius * 2;
      const support = this.supportAt(sampleX, sampleZ, this.waterExitSupport ??= {});
      const blocked = this.collidesCircle(sampleX, sampleZ, radius, GEO_QUERY_MASK.SOLID_PLAYER, feetY + .02, feetY + bodyHeight);
      if (blocked) continue;
      if (Number.isNaN(bestY) || (support.y ?? 0) > bestY) {
        bestY = support.y ?? 0;
        bestWalkable = support.walkable !== false;
        bestBlocked = false;
      }
    }
    return planWaterExit({
      contact,
      supportY: bestY,
      walkable: bestWalkable,
      blocked: bestBlocked,
      profile,
    }, out);
  }

  /** The resident tile that owns the water domain for a point, else the nearest. */
  _waterTileAt(x, z) {
    let nearest = null, nearestDistance = Infinity;
    for (const tile of this.tiles.values()) {
      if (!tile.waterDomain || !tile.bounds) continue;
      if (x >= tile.bounds.minX && x <= tile.bounds.maxX && z >= tile.bounds.minZ && z <= tile.bounds.maxZ) return tile;
      const dx = x < tile.bounds.minX ? tile.bounds.minX - x : x > tile.bounds.maxX ? x - tile.bounds.maxX : 0;
      const dz = z < tile.bounds.minZ ? tile.bounds.minZ - z : z > tile.bounds.maxZ ? z - tile.bounds.maxZ : 0;
      const distance = Math.hypot(dx, dz);
      if (distance < nearestDistance) { nearestDistance = distance; nearest = tile; }
    }
    return nearest;
  }

  /** `GME-04` richer map readout: the mapped semantics around a point — the
   * support surface the player stands on, the water class beneath it, the
   * nearest mapped name, and the resident tile that owns it. This is the HUD's
   * map layer; `GME-07` builds navigation guidance on top of it.
   */
  mapReadout(x, z, out = this.mapReadoutRecord ??= {}) {
    const support = this.supportAt(x, z, this.readoutSupport ??= {});
    out.x = x;
    out.z = z;
    out.supportKind = support.kind ?? 'ground';
    out.supportLevel = support.physicalLevel ?? 0;
    out.supportY = support.y ?? 0;
    if (support.slopeRadians !== undefined) out.slopeRadians = support.slopeRadians;
    out.providerSchema = this.providerSchema;
    out.residentTiles = this.tiles.size;

    let tile = null, distance = Infinity;
    for (const candidate of this.tiles.values()) {
      if (!candidate.bounds) continue;
      const dx = x < candidate.bounds.minX ? candidate.bounds.minX - x : x > candidate.bounds.maxX ? x - candidate.bounds.maxX : 0;
      const dz = z < candidate.bounds.minZ ? candidate.bounds.minZ - z : z > candidate.bounds.maxZ ? z - candidate.bounds.maxZ : 0;
      const candidateDistance = Math.hypot(dx, dz);
      if (candidateDistance < distance) { distance = candidateDistance; tile = candidate; }
    }
    out.tileKey = tile?.key ?? null;
    out.tileDistance = Number.isFinite(distance) ? distance : null;
    out.roadFeatures = tile?.roadFeatures ?? 0;
    out.buildingFeatures = tile?.buildingFeatures ?? 0;

    out.waterClass = GEO_WATER_CLASS.UNKNOWN;
    out.waterClassName = waterClassName(GEO_WATER_CLASS.UNKNOWN);
    out.inWater = false;
    out.wetland = false;
    if (tile?.waterDomain) {
      const water = queryWaterDomain(tile.waterDomain, x, z, this.readoutWater ??= {});
      // The domain always reports the nearest class; the HUD only claims a water
      // class for the point itself, or for a genuinely adjacent shoreline.
      const local = water.inWater || water.waterDistance <= .5;
      out.waterClass = local ? water.waterClass : GEO_WATER_CLASS.UNKNOWN;
      out.waterClassName = waterClassName(out.waterClass);
      out.inWater = Boolean(water.inWater);
      out.wetland = Boolean(water.wetland);
      out.waterDistance = water.waterDistance;
    } else {
      out.waterDistance = Infinity;
    }

    let nearest = null, nearestDistance = Infinity;
    for (const label of tile?.labels ?? []) {
      const labelDistance = Math.hypot(label.x - x, label.z - z);
      if (labelDistance < nearestDistance) { nearestDistance = labelDistance; nearest = label; }
    }
    out.placeName = nearest?.name ?? null;
    out.placeKind = nearest?.kind ?? null;
    out.placeDistance = nearest ? nearestDistance : Infinity;
    return out;
  }

  /** Shared world interface: bounded diagnostic record for logs and the HUD. */
  querySnapshot() {
    return {
      domain: this.domain.id,
      resident: this.tiles.size,
      queued: this.queue.length,
      activeRequests: this.activeRequests,
      provider: this.provider,
      labels: this.visibleLabels.length,
      lifecycle: this.lifecycle?.snapshot?.().total ?? 0,
      queries: {
        sweeps: this.queryDiagnostics.sweeps,
        sphereSweeps: this.queryDiagnostics.sphereSweeps,
        maxCandidates: this.queryDiagnostics.maxCandidates,
        maxSupportCandidates: this.queryDiagnostics.maxSupportCandidates,
      },
    };
  }

  /** Shared world interface: the dynamic sweep, already role-aware. */
  querySweep(x, y, z, dx, dy, dz, radius, out = {}) {
    return this.sweepSphere(x, y, z, dx, dy, dz, radius, out);
  }

  coordinateAt(x, z) {
    return worldToCoordinate(this.reference, x, z);
  }

  /**
   * `FND-07`/`QLT-06` programmatic movement sample.
   *
   * This is the replacement for the retired browser-capture matrix: the exact
   * numbers a screenshot or video used to be inspected for — camera clearance
   * against real blockers, live render bands and transparency flags, per-family
   * plant LOD selection, and a CPU mirror of the `MAT-03` derivative fade — read
   * straight out of running state so a test, a console, or an unattended audit
   * can assert on them.
   */
  probeCameraClearance(target, position, radius = .03, out = {}) {
    const dx = position.x - target.x, dy = position.y - target.y, dz = position.z - target.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 1e-6) return { clearance: 0, blocked: false, distance: 0, hit: false };
    const hit = this.sweepSphere(target.x, target.y, target.z, dx, dy, dz, radius, out);
    out.clearance = hit.hit ? -(1 - hit.time) * distance : 0;
    out.blocked = Boolean(hit.hit && hit.time < 1);
    out.distance = distance;
    return out;
  }

  /**
   * `VEG-02`: one live silhouette/LOD sample of the resident vegetation, in the
   * shape `PlantSilhouetteAudit` consumes. Reuses one record per call site.
   */
  plantSilhouetteSample(out = this.silhouetteSample ??= {}) {
    const pools = this.plantRenderPools;
    const selector = this.plantLodSelector;
    const families = out.families ??= [];
    const familySets = this.silhouetteFamilySets ??= new Map();
    const placements = out.placements ??= [];
    families.length = 0;
    placements.length = 0;
    familySets.clear();
    this.silhouetteFamilyEntries ??= new Map();
    let next = 0;
    for (const record of pools.records.values()) {
      const family = record.placement.family;
      if (!familySets.has(family)) {
        families.push(family);
        // The compiled levels of a family are immutable, so the descriptor is
        // cached instead of rebuilt on every audit sample.
        let entry = this.silhouetteFamilyEntries.get(family);
        if (!entry) {
          const set = pools.library.getForPlacement(record.placement);
          entry = { levels: set.diagnostics.levels, boundsSize: set.bounds.size };
          this.silhouetteFamilyEntries.set(family, entry);
        }
        familySets.set(family, entry);
      }
      const slot = placements[next] ??= { family: '', expectedFamily: null, lod: null };
      next++;
      slot.family = family;
      slot.expectedFamily = GEO_PLANT_TYPE_FAMILIES[record.sourceType] ?? null;
      slot.lod = record.lod;
    }
    placements.length = next;
    out.profile = this.profile;
    out.entries = pools.diagnostics.entries;
    out.instances = pools.diagnostics.entries;
    out.drawnInstances = pools.diagnostics.drawnInstances;
    out.boxModules = pools.diagnostics.boxModules;
    out.triangles = pools.diagnostics.tierTriangles;
    out.drawPools = pools.diagnostics.activeDrawPools;
    out.sourceGeometries = pools.diagnostics.sourceGeometries;
    out.byLod = pools.diagnostics.byLod;
    out.switches = selector.diagnostics.switches;
    out.hysteresisHolds = selector.diagnostics.hysteresisHolds;
    out.evaluations = selector.diagnostics.evaluations;
    // The audit reads the family table by key, so expose the cached map as a
    // plain record view without rebuilding the descriptors themselves.
    const view = out.familySetsView ??= {};
    for (const key of Object.keys(view)) if (!familySets.has(key)) delete view[key];
    for (const [key, entry] of familySets) view[key] = entry;
    out.familySets = view;
    return out;
  }

  /** Per-family dominant plant LOD, used to measure resident churn. */
  plantLodByFamily() {
    const counts = new Map();
    for (const record of this.plantRenderPools.records.values()) {
      const family = record.placement?.family;
      const lod = record.lod;
      if (family == null || typeof lod !== 'number') continue;
      const key = `${family}:${lod}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const best = new Map();
    for (const [key, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const family = key.slice(0, key.indexOf(':'));
      const current = best.get(family);
      if (!current || count > current.count) best.set(family, { lod: Number(key.slice(key.indexOf(':') + 1)), count });
    }
    const out = {};
    for (const [family, entry] of [...best.entries()].sort((a, b) => a[0].localeCompare(b[0]))) out[family] = entry.lod;
    return out;
  }

  /**
   * CPU mirror of the generated-material derivative fade. `pixels` counts
   * style-mask texels per device pixel, so a value below one is exactly the
   * subpixel case the shader has to fade rather than alias.
   */
  surfaceDetailSamples({ camera = this.viewCamera, viewportHeight = this.viewportHeight, pixelRatio = 1, distance = 12 } = {}) {
    const library = this.materialLibrary;
    const atlasWidth = library?.textures?.styleMasks?.image?.width ?? 0;
    const fov = camera?.fov ?? 52;
    const pixelsPerWorldUnit = (viewportHeight * pixelRatio) /
      (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2) * Math.max(.01, distance));
    const output = [];
    for (const [key, material] of [
      ['ground', this.groundMaterial], ['road', this.roadMaterial], ['land', this.landMaterial],
      ['facade', this.buildingMaterial], ['water', this.waterMaterial], ['decoration', this.decorationMaterial],
    ]) {
      const state = material?.userData?.gdoSemanticMaterial;
      if (!state) continue;
      const styleScale = state.uniforms.gdoStyleScale?.value ?? 0;
      const minimumPixels = state.uniforms.gdoMinimumPixels?.value ?? 0;
      const fadeNear = state.uniforms.gdoDetailFade?.value?.x ?? Infinity;
      if (!(styleScale > 0) || !atlasWidth) continue;
      const texelsPerWorldUnit = styleScale * atlasWidth;
      const pixels = texelsPerWorldUnit * pixelsPerWorldUnit;
      // Mirrors the shader: fwidth(styleCoord) ≈ 1 texel/pixel in style space.
      const footprint = pixels > 0 ? (16 * minimumPixels) / pixels : Infinity;
      const footprintVisibility = 1 - smoothstep(0.42, 1, footprint);
      const distanceVisibility = 1 - smoothstep(fadeNear, state.uniforms.gdoDetailFade.value.y, distance);
      const visibility = footprintVisibility * distanceVisibility;
      const detail = surfaceDetailOf(material);
      output.push({
        key,
        // `MAT-05`: which catalogue pattern this surface wears, and its source.
        detail: detail?.id ?? null,
        detailSource: detail?.source ?? null,
        detailStyle: detail?.style ?? null,
        pixels,
        minimumPixels,
        footprint,
        visibility,
        mip: material.map?.generateMipmaps !== false || library?.textures?.styleMasks != null,
        faded: visibility < 1,
      });
    }
    return output;
  }

  movementSnapshot({
    camera = this.viewCamera,
    renderer = null,
    cameraMode = 'first-person',
    clearance = 0,
    pathId = null,
    index = -1,
    phase = 0,
  } = {}) {
    const position = camera?.position ?? { x: 0, y: 0, z: 0 };
    const bands = [];
    const push = (name, order, material, transparent = false) => bands.push({
      name, order, transparent, opaqueOrder: GEO_LAYER.building.renderBand, material: material?.type ?? null,
    });
    push('ground', GEO_LAYER.ground.renderBand, this.groundMaterial);
    push('road', GEO_LAYER.road.renderBand, this.roadMaterial);
    push('land', GEO_LAYER.land.renderBand, this.landMaterial);
    push('building', GEO_LAYER.building.renderBand, this.buildingMaterial);
    push('landmark', GEO_LAYER.building.renderBand + 2, this.decorationMaterial);
    push('plants', this.plantRenderPools.renderOrder, this.plantRenderPools.material);
    push('ambient', GEO_LAYER.ambience.renderBand, this.ambientLifePools.material);
    push('water', GEO_LAYER.water.renderBand, this.waterMaterial, Boolean(this.waterMaterial?.transparent));
    return {
      pathId, index, phase,
      camera: { mode: cameraMode, position: { x: position.x, y: position.y, z: position.z }, clearance },
      bands,
      lod: this.plantLodByFamily(),
      subpixel: this.surfaceDetailSamples({ camera, renderer }),
      residentTiles: [...this.tiles.keys()].sort(),
      renderCalls: renderer?.info?.render?.calls ?? 0,
      triangles: renderer?.info?.render?.triangles ?? 0,
      layers: this.layers?.length ?? 0,
      lifecycle: this.lifecycle.snapshot(),
    };
  }

  /**
   * `FND-07` tile-geometry ownership. Keyed by slot so a phase that replaces its
   * own geometry releases the previous ledger entry instead of leaving a live
   * ghost behind; every slot releases through the ledger on eviction.
   */
  _ownTileGeometry(tile, name, geometry) {
    if (!geometry) return geometry;
    tile.lifecycleEntries ??= new Map();
    tile.lifecycleEntries.get(name)?.release();
    tile.lifecycleEntries.set(name,
      this.tileLifecycle.own('geometry', `${tile.key}/${name}`, geometry, item => item.dispose?.()));
    return geometry;
  }

  _releaseTileGeometry(tile, name) {
    const handle = tile.lifecycleEntries?.get(name);
    if (!handle) return false;
    handle.release();
    tile.lifecycleEntries.delete(name);
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // `GME-06`: the last pass may have happened before the final visit, so the
    // journal gets one explicit save before its storage is released.
    this.discoveryStorage?.save(this.discoveryJournal);
    if (this.plantMountTimer != null) clearTimeout(this.plantMountTimer);
    this.plantMountTimer = null;
    this.plantTimerHandle?.release();
    this.plantTimerHandle = null;
    this.pendingPlantOwners.clear();
    for (const tile of [...this.tiles.values()]) this._evictTile(tile);
    this.tiles.clear(); this.queue.length = 0;
    // Pools, materials, geometries, listeners, the worker, and the root node all
    // release through the same ledger: anything left is a real lifecycle defect.
    this.lifecycle.disposeAll();
  }
}
