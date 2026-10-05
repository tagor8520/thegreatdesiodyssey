import * as THREE from 'three';
import { featureNamespace } from './FeatureVersions.js';
import { GDO_PLANT_GEOMETRY_NAMESPACE, plantGeometryFingerprint } from './PlantGeometryCompiler.js';
import {
  GDO_PLANT_LOD_NAMESPACE,
  GDO_PLANT_LOD_PROFILES,
  PlantLodSelector,
  acquirePlantLodLibrary,
  plantLodScheduleSlot,
} from './PlantLodCompiler.js';
import { configureSemanticMaterial } from './ProceduralMaterials.js';
import {
  GDO_PLANT_WIND_NAMESPACE,
  GDO_PLANT_WIND_PROFILES,
  PlantWindState,
} from './PlantWind.js';

const MEBIBYTE = 1024 * 1024;
const LODS = Object.freeze(['near', 'mid', 'far']);
const FAMILY_NAMES = Object.freeze(['broadleaf', 'palm', 'shrub', 'herb', 'grass', 'bamboo']);
const DEFAULT_CLEARANCE = Object.freeze([1, 1, 0, 0]);
const ATTRIBUTE_LAYOUT = Object.freeze({
  gdoPlantMeta0: Object.freeze({ itemSize: 4, normalized: false, source: 'palette/bend/phase/detail' }),
  gdoPlantLod0: Object.freeze({ itemSize: 1, normalized: true, source: 'lodWeight' }),
  gdoPlantPalette: Object.freeze({ itemSize: 1, normalized: false, instance: true }),
  gdoPlantTraits: Object.freeze({ itemSize: 3, normalized: true, instance: true, source: 'age/stiffness/phase' }),
  gdoPlantVariant: Object.freeze({ itemSize: 1, normalized: false, instance: true }),
  gdoPlantClearance: Object.freeze({ itemSize: 4, normalized: false, instance: true, source: 'crown-scale/shift' }),
});

export const GDO_PLANT_RENDER_NAMESPACE = featureNamespace('vegetationRender');
// Eight paired static streams + four instance-matrix columns + four custom
// instance streams exactly meet the WebGL minimum vertex-attribute guarantee.
export const GDO_PLANT_VERTEX_ATTRIBUTE_LOCATIONS = 16;
export const GDO_PLANT_RENDER_PROFILES = Object.freeze({
  low: Object.freeze({
    maxOwners: 4,
    maxEntries: 5_360,
    maxVariantsPerTier: 2,
    maxDrawPools: 18,
    maxSourceGeometries: 48,
    maxGpuGeometryBytes: 1.5 * MEBIBYTE,
    maxVisibleTriangles: 75_000,
    maxAddedDrawCalls: 8,
  }),
});
export const GDO_PLANT_POOL_ATTRIBUTE_LAYOUT = ATTRIBUTE_LAYOUT;

function hashText(value, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function finiteVector(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function finiteClearance(value) {
  return value == null || (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) &&
    value[0] > 0 && value[0] <= 1 && value[1] > 0 && value[1] <= 1 &&
    Math.abs(value[2]) <= 2 && Math.abs(value[3]) <= 2);
}

function nextCapacity(count) {
  let capacity = 8;
  while (capacity < count) capacity *= 2;
  return capacity;
}

function staticGeometryBytes(geometry) {
  let bytes = geometry.index?.array?.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes)) {
    if (!attribute.isInstancedBufferAttribute) bytes += attribute.array?.byteLength ?? 0;
  }
  return bytes;
}

function validateSourceGeometry(source, family) {
  if (!source || source.namespace !== GDO_PLANT_GEOMETRY_NAMESPACE || source.family !== family ||
      !(source.positions instanceof Float32Array) || !(source.normals instanceof Float32Array) ||
      !(source.indices instanceof Uint16Array) || !(source.paletteSlots instanceof Uint8Array) ||
      !(source.bendWeights instanceof Uint8Array) || !(source.phaseGroups instanceof Uint8Array) ||
      !(source.detailRoles instanceof Uint8Array) || !(source.lodWeights instanceof Uint8Array)) {
    throw new TypeError('Plant GPU upload requires compatible exposed-face geometry');
  }
  return source;
}

function deindexSource(source, output, slot, vertexCount) {
  const positionName = slot === 0 ? 'position' : `gdoPlantPosition${slot}`;
  const normalName = slot === 0 ? 'normal' : `gdoPlantNormal${slot}`;
  const metaName = `gdoPlantMeta${slot}`;
  const lodName = `gdoPlantLod${slot}`;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const metadata = new Uint8Array(vertexCount * 4);
  const lodWeights = new Uint8Array(vertexCount);
  const sourceVertexCount = source.indices.length;
  const pivotX = source.pivot?.[0] ?? 0;
  const pivotY = source.pivot?.[1] ?? 0;
  const pivotZ = source.pivot?.[2] ?? 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const padded = vertex >= sourceVertexCount;
    const sourceIndex = padded ? source.indices[0] : source.indices[vertex];
    const sourceOffset = sourceIndex * 3;
    const positionOffset = vertex * 3;
    if (padded) {
      positions[positionOffset] = pivotX;
      positions[positionOffset + 1] = pivotY;
      positions[positionOffset + 2] = pivotZ;
      normals[positionOffset + 1] = 1;
    } else {
      positions[positionOffset] = source.positions[sourceOffset];
      positions[positionOffset + 1] = source.positions[sourceOffset + 1];
      positions[positionOffset + 2] = source.positions[sourceOffset + 2];
      normals[positionOffset] = source.normals[sourceOffset];
      normals[positionOffset + 1] = source.normals[sourceOffset + 1];
      normals[positionOffset + 2] = source.normals[sourceOffset + 2];
    }
    const metadataOffset = vertex * 4;
    metadata[metadataOffset] = source.paletteSlots[sourceIndex];
    metadata[metadataOffset + 1] = source.bendWeights[sourceIndex];
    metadata[metadataOffset + 2] = source.phaseGroups[sourceIndex];
    metadata[metadataOffset + 3] = source.detailRoles[sourceIndex];
    lodWeights[vertex] = padded ? 0 : source.lodWeights[sourceIndex];
  }
  output.setAttribute(positionName, new THREE.BufferAttribute(positions, 3));
  output.setAttribute(normalName, new THREE.BufferAttribute(normals, 3));
  output.setAttribute(metaName, new THREE.BufferAttribute(metadata, 4, false));
  output.setAttribute(lodName, new THREE.BufferAttribute(lodWeights, 1, true));
}

/**
 * Upload one low-profile family/LOD tier. Two deterministic archetype variants
 * share one draw by selecting de-indexed vertex streams with a custom instance
 * attribute. Shorter streams are padded with degenerate triangles at the pivot.
 */
export function uploadPlantGeometryTier({ family, lod, sources, windEnabled = false } = {}) {
  if (!FAMILY_NAMES.includes(family) || !LODS.includes(lod) || !Array.isArray(sources) ||
      sources.length < 1 || sources.length > GDO_PLANT_RENDER_PROFILES.low.maxVariantsPerTier) {
    throw new RangeError('Invalid plant family/LOD GPU upload');
  }
  const validated = sources.map(source => validateSourceGeometry(source, family));
  const vertexCount = Math.max(...validated.map(source => source.indices.length));
  if (!vertexCount || vertexCount % 3 !== 0) throw new Error('Plant upload source must contain complete triangles');
  const geometry = new THREE.BufferGeometry();
  for (let slot = 0; slot < validated.length; slot++) deindexSource(validated[slot], geometry, slot, vertexCount);
  if (validated.length === 1) {
    // Keep the shader and attribute contract identical when a test or degraded
    // profile supplies one variant.
    deindexSource(validated[0], geometry, 1, vertexCount);
  }

  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  box.makeEmpty();
  for (let slot = 0; slot < Math.max(2, validated.length); slot++) {
    const attribute = geometry.getAttribute(slot === 0 ? 'position' : `gdoPlantPosition${slot}`);
    for (let index = 0; index < attribute.count; index++) {
      const offset = index * 3;
      point.fromArray(attribute.array, offset);
      box.expandByPoint(point);
    }
  }
  // Vertex wind is visual-only, so when it is enabled the static geometry bounds
  // reserve its worst-case horizontal displacement instead of moving any
  // instance matrix. Wind is opt-in (`wind: true`); when it is disabled no
  // vertex is displaced, so no culling reserve is withheld from the bounds.
  const windDisplacementMargin = windEnabled ? GDO_PLANT_WIND_PROFILES.low.maximumDisplacement : 0;
  box.min.x -= windDisplacementMargin;
  box.min.z -= windDisplacementMargin;
  box.max.x += windDisplacementMargin;
  box.max.z += windDisplacementMargin;
  geometry.boundingBox = box;
  geometry.boundingSphere = new THREE.Sphere();
  box.getBoundingSphere(geometry.boundingSphere);
  const fingerprints = Object.freeze(validated.map(plantGeometryFingerprint));
  const sourceTriangles = Object.freeze(validated.map(source => source.indices.length / 3));
  const staticBytes = staticGeometryBytes(geometry);
  geometry.name = `plant-tier:${family}:${lod}`;
  geometry.userData.gdoPlantUpload = Object.freeze({
    namespace: GDO_PLANT_RENDER_NAMESPACE,
    sourceNamespace: GDO_PLANT_LOD_NAMESPACE,
    family,
    lod,
    variants: validated.length,
    fingerprints,
    sourceTriangles,
    drawTriangles: vertexCount / 3,
    staticBytes,
    windDisplacementMargin,
    runtimeCsgOperations: 0,
    collisionProxies: 0,
  });
  return geometry;
}

/** Driver-safe palette/age/stiffness shader path; deliberately avoids instanceColor. */
export function createPlantPoolMaterial(materialLibrary = null, options = {}) {
  const windOptions = typeof options === 'string'
    ? { profile: options }
    : options && typeof options === 'object' ? options : {};
  const profile = windOptions.profile ?? 'low';
  // Wind is opt-in. The product decision on 2026-10-03 was that whole-plant wind
  // is not worth its per-vertex cost, so the default path compiles no wind ALU
  // at all. Enabling it adds the `GDO_PLANT_WIND` define and the uniform bindings.
  const windEnabled = windOptions.wind === true;
  const wind = new PlantWindState(windOptions);
  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: .88,
    metalness: 0,
    vertexColors: false,
    side: THREE.FrontSide,
  });
  if (windEnabled) material.defines = { ...material.defines, GDO_PLANT_WIND: '' };
  if (materialLibrary) configureSemanticMaterial(material, 'leaf', materialLibrary, profile);
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = shader => {
    previousCompile(shader);
    shader.uniforms ??= {};
    if (windEnabled) {
      shader.uniforms.gdoPlantWindClock = wind.uniforms.clock;
      shader.uniforms.gdoPlantWindField = wind.uniforms.field;
      shader.uniforms.gdoPlantWindAmplitude = wind.uniforms.amplitude;
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 gdoPlantPosition1;
        attribute vec3 gdoPlantNormal1;
        attribute vec4 gdoPlantMeta0;
        attribute vec4 gdoPlantMeta1;
        attribute float gdoPlantLod0;
        attribute float gdoPlantLod1;
        attribute float gdoPlantPalette;
        attribute vec3 gdoPlantTraits;
        attribute float gdoPlantVariant;
        attribute vec4 gdoPlantClearance;
        #ifdef GDO_PLANT_WIND
        uniform float gdoPlantWindClock;
        uniform vec4 gdoPlantWindField;
        uniform float gdoPlantWindAmplitude;
        #endif
        varying vec3 vGdoPlantTint;
        varying vec3 vGdoPlantTraits;

        float gdoPlantSmoothTriangle(float cycles) {
          float linear = abs(fract(cycles) * 2.0 - 1.0);
          float smoothed = linear * linear * (3.0 - 2.0 * linear);
          return smoothed * 2.0 - 1.0;
        }

        #ifdef GDO_PLANT_WIND
        vec2 gdoPlantWholeWind(vec3 plantPosition, vec4 plantMeta, vec3 plantTraits) {
          mat4 plantWorldMatrix = modelMatrix;
          #ifdef USE_INSTANCING
          plantWorldMatrix = modelMatrix * instanceMatrix;
          #endif
          vec2 axisX = plantWorldMatrix[0].xz;
          vec2 axisZ = plantWorldMatrix[2].xz;
          float scaleX = max(0.0001, length(axisX));
          float scaleZ = max(0.0001, length(axisZ));
          vec2 localWind = vec2(
            dot(gdoPlantWindField.xy, axisX / scaleX) / scaleX,
            dot(gdoPlantWindField.xy, axisZ / scaleZ) / scaleZ
          );
          localWind /= max(0.0001, length(localWind));
          vec2 worldOrigin = plantWorldMatrix[3].xz;
          float spatialPhase = dot(worldOrigin, vec2(0.013, 0.009));
          float slowWave = gdoPlantSmoothTriangle(gdoPlantWindClock * 4.0 + plantTraits.z + spatialPhase);
          float gustEnvelope = 0.5 + 0.5 * gdoPlantSmoothTriangle(
            gdoPlantWindClock + spatialPhase * 0.37
          );
          float turbulence = gdoPlantSmoothTriangle(
            gdoPlantWindClock * 13.0 + plantTraits.z * 1.73 + spatialPhase * 2.1
          );
          float wave = slowWave * 0.82 + turbulence * gustEnvelope * gdoPlantWindField.w * 0.18;
          float heightResponse = smoothstep(0.01, 0.55, max(0.0, plantPosition.y));
          float bendResponse = mix(0.78, 1.0, clamp(plantMeta.y / 255.0, 0.0, 1.0));
          float rootMask = step(0.5, abs(plantMeta.w - 2.0));
          float flexibility = mix(1.05, 0.35, clamp(plantTraits.y, 0.0, 1.0));
          return localWind * (gdoPlantWindAmplitude * gdoPlantWindField.z * wave *
            heightResponse * bendResponse * flexibility * rootMask);
        }
        #endif`)
      .replace('#include <beginnormal_vertex>', `
        float gdoPlantVariantMix = step(0.5, gdoPlantVariant);
        vec4 gdoPlantVertexMeta = mix(gdoPlantMeta0, gdoPlantMeta1, gdoPlantVariantMix);
        float gdoPlantVertexLod = mix(gdoPlantLod0, gdoPlantLod1, gdoPlantVariantMix);
        float gdoPlantAdaptiveRole = max(
          step(0.5, gdoPlantVertexMeta.w) * (1.0 - step(1.5, gdoPlantVertexMeta.w)),
          step(4.5, gdoPlantVertexMeta.w)
        );
        vec2 gdoPlantCrownScale = mix(vec2(1.0), gdoPlantClearance.xy, gdoPlantAdaptiveRole);
        vec3 objectNormal = normalize(mix(normal, gdoPlantNormal1, gdoPlantVariantMix));
        objectNormal = normalize(vec3(
          objectNormal.x / max(0.01, gdoPlantCrownScale.x),
          objectNormal.y,
          objectNormal.z / max(0.01, gdoPlantCrownScale.y)
        ));
        #ifdef GDO_PLANT_WIND
        vec3 gdoPlantWindPosition = mix(position, gdoPlantPosition1, gdoPlantVariantMix);
        gdoPlantWindPosition.xz = gdoPlantWindPosition.xz * gdoPlantCrownScale +
          gdoPlantClearance.zw * gdoPlantAdaptiveRole;
        vec2 gdoPlantWindOffset = gdoPlantWholeWind(
          gdoPlantWindPosition, gdoPlantVertexMeta, gdoPlantTraits
        );
        objectNormal = normalize(vec3(
          objectNormal.x - gdoPlantWindOffset.x * objectNormal.y * 1.2,
          objectNormal.y,
          objectNormal.z - gdoPlantWindOffset.y * objectNormal.y * 1.2
        ));
        #else
        vec2 gdoPlantWindOffset = vec2(0.0);
        #endif`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = mix(position, gdoPlantPosition1, gdoPlantVariantMix);
        transformed.xz = transformed.xz * gdoPlantCrownScale +
          gdoPlantClearance.zw * gdoPlantAdaptiveRole + gdoPlantWindOffset;
        float gdoPlantPaletteIndex = mod(gdoPlantPalette + gdoPlantVertexMeta.x, 8.0);
        float gdoPlantWood = 1.0 - step(2.5, gdoPlantVertexMeta.w);
        float gdoPlantFlower = step(7.5, gdoPlantVertexMeta.w);
        vec3 gdoPlantGreen = mix(vec3(0.16, 0.34, 0.055), vec3(0.42, 0.61, 0.10), gdoPlantPaletteIndex / 7.0);
        vec3 gdoPlantBark = mix(vec3(0.20, 0.075, 0.025), vec3(0.38, 0.19, 0.055), gdoPlantPaletteIndex / 7.0);
        vec3 gdoPlantBloom = mix(vec3(0.92, 0.16, 0.07), vec3(1.0, 0.68, 0.10), mod(gdoPlantPaletteIndex, 3.0) / 2.0);
        vGdoPlantTint = mix(mix(gdoPlantGreen, gdoPlantBark, gdoPlantWood), gdoPlantBloom, gdoPlantFlower);
        vGdoPlantTint *= mix(0.94, 1.04, gdoPlantVertexLod);
        vGdoPlantTraits = gdoPlantTraits;`)
      .replace('vGdoMaterialWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;', `#ifdef USE_INSTANCING
        vGdoMaterialWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
        vGdoMaterialWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGdoPlantTint;\nvarying vec3 vGdoPlantTraits;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= vGdoPlantTint * mix(0.76, 1.04, vGdoPlantTraits.x);
        diffuseColor.rgb *= mix(0.96, 1.03, vGdoPlantTraits.y);`);
  };
  material.customProgramCacheKey = () =>
    `${previousKey()}:${GDO_PLANT_RENDER_NAMESPACE}:${GDO_PLANT_WIND_NAMESPACE}:${profile}:wind-${windEnabled ? 'on' : 'off'}:custom-instance-data`;
  material.userData.gdoPlantWind = wind;
  material.userData.gdoPlantPoolMaterial = Object.freeze({
    namespace: GDO_PLANT_RENDER_NAMESPACE,
    windNamespace: GDO_PLANT_WIND_NAMESPACE,
    windEnabled,
    builtInInstanceColor: false,
    attributes: Object.freeze(['gdoPlantPalette', 'gdoPlantTraits', 'gdoPlantVariant', 'gdoPlantClearance']),
  });
  material.addEventListener('dispose', () => wind.dispose());
  return material;
}

function validatePlacement(owner, item) {
  const placement = item?.placement;
  if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 160 ||
      !placement || placement.owner !== owner || !FAMILY_NAMES.includes(placement.family) ||
      !Number.isInteger(placement.archetypeIndex) || placement.archetypeIndex < 0 ||
      !finiteVector(placement.position) || !finiteVector(placement.scale) || !Number.isFinite(placement.yaw) ||
      !Number.isInteger(placement.paletteSlot) || placement.paletteSlot < 0 || placement.paletteSlot > 7 ||
      !Number.isFinite(placement.age) || placement.age < 0 || placement.age > 1 ||
      !Number.isFinite(placement.windStiffness) || placement.windStiffness < 0 || placement.windStiffness > 1 ||
      !finiteClearance(placement.clearance)) {
    throw new TypeError('Invalid owner-aware plant pool placement');
  }
  return placement;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function bucketKey(family, lod) { return `${family}:${lod}`; }

/**
 * Global resident pools. Owner changes and LOD switches deterministically
 * repack sorted stable IDs; continuous frames do not touch vegetation matrices.
 */
export class PlantRenderPools {
  constructor(scene, {
    profile = 'low',
    environmentKey = 'default',
    seedSalt = 0,
    materialLibrary = null,
    maxEntries,
    maxOwners,
    renderOrder = 30,
    reducedMotion = false,
    wind = false,
    windDirection,
    windStrength,
    windGustiness,
  } = {}) {
    const limits = GDO_PLANT_RENDER_PROFILES[profile];
    const lodPolicy = GDO_PLANT_LOD_PROFILES[profile];
    if (!scene?.isObject3D || !limits || !lodPolicy) throw new RangeError(`Unsupported plant render profile: ${profile}`);
    this.profile = profile;
    this.limits = limits;
    this.maxEntries = maxEntries ?? limits.maxEntries;
    this.maxOwners = maxOwners ?? limits.maxOwners;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > limits.maxEntries ||
        !Number.isInteger(this.maxOwners) || this.maxOwners < 1 || this.maxOwners > limits.maxOwners) {
      throw new RangeError('Invalid plant resident-pool limits');
    }
    this.group = new THREE.Group();
    this.group.name = 'resident-plant-pools';
    this.group.userData.gdoPlantRenderNamespace = GDO_PLANT_RENDER_NAMESPACE;
    scene.add(this.group);
    this.material = createPlantPoolMaterial(materialLibrary, {
      profile,
      reducedMotion,
      wind,
      direction: windDirection,
      strength: windStrength,
      gustiness: windGustiness,
    });
    this.wind = this.material.userData.gdoPlantWind;
    this.windEnabled = this.material.userData.gdoPlantPoolMaterial.windEnabled;
    this.renderOrder = renderOrder;
    this.libraryHandle = acquirePlantLodLibrary({ profile, environmentKey, seedSalt });
    this.library = this.libraryHandle.library;
    this.selector = new PlantLodSelector({ profile, maxEntries: this.maxEntries });
    this.records = new Map();
    this.owners = new Map();
    this.resources = new Map();
    this.buckets = new Map();
    this.schedule = Array.from({ length: lodPolicy.scheduleSlots }, () => []);
    this.dirtyBuckets = new Set();
    this.dummy = new THREE.Object3D();
    this.cameraPosition = [0, 2, 0];
    this.evaluationInput = {
      id: '', placement: null, lodSet: null, cameraPosition: this.cameraPosition,
      verticalFovRadians: Math.PI / 3, viewportHeight: 720, nowMilliseconds: 0,
      focusCellKey: null, force: false,
    };
    this.evaluationResult = {};
    this.disposed = false;
    this.lastScheduleStep = -1;
    this.lastMatrixUploads = 0;
    this.totalMatrixUploads = 0;
    this.repacks = 0;
    this.ownerAdds = 0;
    this.ownerRemovals = 0;
    this.contextRestores = 0;
    const pools = this;
    this.diagnostics = Object.freeze({
      namespace: GDO_PLANT_RENDER_NAMESPACE,
      profile,
      get owners() { return pools.owners.size; },
      get entries() { return pools.records.size; },
      get drawPools() { return pools.buckets.size; },
      get activeDrawPools() { return pools.#activeDrawPools(); },
      get sourceGeometries() { return pools.#sourceGeometryCount(); },
      get gpuGeometryBytes() { return pools.#gpuGeometryBytes(); },
      get instanceBytes() { return pools.#instanceBytes(); },
      get visibleTriangles() { return pools.#visibleTriangles(); },
      get legacyEquivalentDraws() { return pools.#legacyEquivalentDraws(); },
      get addedDrawCalls() { return Math.max(0, pools.#activeDrawPools() - pools.#legacyEquivalentDraws()); },
      get byLod() { return pools.#lodCounts(); },
      get repacks() { return pools.repacks; },
      get ownerAdds() { return pools.ownerAdds; },
      get ownerRemovals() { return pools.ownerRemovals; },
      get lastMatrixUploads() { return pools.lastMatrixUploads; },
      get totalMatrixUploads() { return pools.totalMatrixUploads; },
      get steadyFrameAllocations() { return 0; },
      get windEnabled() { return pools.windEnabled; },
      get wind() { return pools.wind.diagnostics; },
      get windUniformWrites() { return pools.windEnabled ? pools.wind.lastUniformWrites : 0; },
      get windCpuMatrixUpdates() { return 0; },
      get windSteadyFrameAllocations() { return 0; },
      get reducedMotion() { return pools.wind.reducedMotion; },
      get contextRestores() { return pools.contextRestores; },
      get disposed() { return pools.disposed; },
      limits: Object.freeze({ ...limits, maxEntries: pools.maxEntries, maxOwners: pools.maxOwners }),
      attributeLayout: ATTRIBUTE_LAYOUT,
      vertexAttributeLocations: GDO_PLANT_VERTEX_ATTRIBUTE_LOCATIONS,
    });
  }

  #activeDrawPools() {
    let count = 0;
    for (const bucket of this.buckets.values()) count += Number(bucket.ids.size > 0);
    return count;
  }

  #sourceGeometryCount() {
    let count = 0;
    for (const resource of this.resources.values()) count += resource.userData.gdoPlantUpload.variants;
    return count;
  }

  #gpuGeometryBytes() {
    let bytes = 0;
    for (const resource of this.resources.values()) bytes += resource.userData.gdoPlantUpload.staticBytes;
    return bytes;
  }

  #instanceBytes() {
    let bytes = 0;
    for (const bucket of this.buckets.values()) if (bucket.mesh) {
      bytes += bucket.mesh.instanceMatrix.array.byteLength;
      bytes += bucket.geometry.getAttribute('gdoPlantPalette')?.array.byteLength ?? 0;
      bytes += bucket.geometry.getAttribute('gdoPlantTraits')?.array.byteLength ?? 0;
      bytes += bucket.geometry.getAttribute('gdoPlantVariant')?.array.byteLength ?? 0;
      bytes += bucket.geometry.getAttribute('gdoPlantClearance')?.array.byteLength ?? 0;
    }
    return bytes;
  }

  #visibleTriangles() {
    let triangles = 0;
    for (const bucket of this.buckets.values()) {
      triangles += bucket.ids.size * bucket.geometry.userData.gdoPlantUpload.drawTriangles;
    }
    return triangles;
  }

  #legacyEquivalentDraws() {
    let total = 0;
    for (const ids of this.owners.values()) {
      const keys = new Set();
      for (const id of ids) {
        const record = this.records.get(id);
        keys.add(record.sourceType ?? record.placement.family);
      }
      total += keys.size;
    }
    return total;
  }

  #lodCounts() {
    const counts = { near: 0, mid: 0, far: 0, beyond: 0 };
    for (const record of this.records.values()) counts[record.lod]++;
    return Object.freeze(counts);
  }

  #ensureFamilyResources(family, lodSets) {
    for (const lod of LODS) {
      const key = bucketKey(family, lod);
      if (this.resources.has(key)) continue;
      const sources = lodSets.map(set => set.geometries[lod]);
      const sourceCount = this.#sourceGeometryCount() + sources.length;
      if (sourceCount > this.limits.maxSourceGeometries || this.resources.size + 1 > this.limits.maxDrawPools) {
        throw new Error('Plant GPU geometry-tier cap reached');
      }
      const geometry = uploadPlantGeometryTier({ family, lod, sources, windEnabled: this.windEnabled });
      if (this.#gpuGeometryBytes() + geometry.userData.gdoPlantUpload.staticBytes > this.limits.maxGpuGeometryBytes) {
        geometry.dispose();
        throw new Error(`Plant GPU geometry byte cap reached: ${this.limits.maxGpuGeometryBytes}`);
      }
      this.resources.set(key, geometry);
      this.buckets.set(key, { key, family, lod, geometry, ids: new Set(), mesh: null, capacity: 0 });
    }
  }

  #setEvaluationView(view, force) {
    const camera = view?.cameraPosition ?? this.cameraPosition;
    if (!finiteVector(camera)) throw new TypeError('Plant pool view requires a finite camera position');
    this.cameraPosition[0] = camera[0];
    this.cameraPosition[1] = camera[1];
    this.cameraPosition[2] = camera[2];
    const input = this.evaluationInput;
    input.verticalFovRadians = view?.verticalFovRadians ?? input.verticalFovRadians;
    input.viewportHeight = view?.viewportHeight ?? input.viewportHeight;
    input.nowMilliseconds = view?.nowMilliseconds ?? input.nowMilliseconds;
    input.focusCellKey = view?.focusCellKey ?? null;
    input.force = force;
    if (!Number.isFinite(input.verticalFovRadians) || input.verticalFovRadians <= 0 || input.verticalFovRadians >= Math.PI ||
        !Number.isFinite(input.viewportHeight) || input.viewportHeight <= 0 ||
        !Number.isFinite(input.nowMilliseconds) || input.nowMilliseconds < 0) {
      throw new TypeError('Plant pool view requires finite projection and time values');
    }
  }

  #evaluateRecord(record, force) {
    const input = this.evaluationInput;
    input.id = record.id;
    input.placement = record.placement;
    input.lodSet = record.lodSet;
    input.force = force;
    this.selector.evaluate(input, this.evaluationResult);
    return this.evaluationResult.lod;
  }

  #rebuildSchedule() {
    for (const slot of this.schedule) slot.length = 0;
    const ids = [...this.records.keys()].sort();
    for (const id of ids) this.schedule[plantLodScheduleSlot(id, this.schedule.length)].push(id);
  }

  #ensureMesh(bucket, count) {
    if (bucket.mesh && bucket.capacity >= count) return bucket.mesh;
    const capacity = Math.min(this.maxEntries, nextCapacity(count));
    const oldMesh = bucket.mesh;
    if (oldMesh) {
      oldMesh.removeFromParent();
      oldMesh.dispose();
    }
    const palette = new THREE.InstancedBufferAttribute(new Uint8Array(capacity), 1, false);
    const traits = new THREE.InstancedBufferAttribute(new Uint8Array(capacity * 3), 3, true);
    const variants = new THREE.InstancedBufferAttribute(new Uint8Array(capacity), 1, false);
    const clearance = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4, false);
    palette.setUsage(THREE.DynamicDrawUsage);
    traits.setUsage(THREE.DynamicDrawUsage);
    variants.setUsage(THREE.DynamicDrawUsage);
    clearance.setUsage(THREE.DynamicDrawUsage);
    bucket.geometry.setAttribute('gdoPlantPalette', palette);
    bucket.geometry.setAttribute('gdoPlantTraits', traits);
    bucket.geometry.setAttribute('gdoPlantVariant', variants);
    bucket.geometry.setAttribute('gdoPlantClearance', clearance);
    const mesh = new THREE.InstancedMesh(bucket.geometry, this.material, capacity);
    mesh.name = `plant-pool:${bucket.key}`;
    mesh.count = 0;
    mesh.renderOrder = this.renderOrder;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.userData.gdoPlantPool = Object.freeze({
      namespace: GDO_PLANT_RENDER_NAMESPACE,
      family: bucket.family,
      lod: bucket.lod,
      ownerAware: true,
      builtInInstanceColor: false,
    });
    bucket.mesh = mesh;
    bucket.capacity = capacity;
    this.group.add(mesh);
    return mesh;
  }

  #repackBucket(key) {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    const ids = [...bucket.ids].sort();
    if (!ids.length) {
      if (bucket.mesh) bucket.mesh.count = 0;
      this.repacks++;
      return;
    }
    const mesh = this.#ensureMesh(bucket, ids.length);
    const palette = bucket.geometry.getAttribute('gdoPlantPalette');
    const traits = bucket.geometry.getAttribute('gdoPlantTraits');
    const variants = bucket.geometry.getAttribute('gdoPlantVariant');
    const clearance = bucket.geometry.getAttribute('gdoPlantClearance');
    const dummy = this.dummy;
    for (let index = 0; index < ids.length; index++) {
      const record = this.records.get(ids[index]);
      const placement = record.placement;
      dummy.position.set(placement.position[0], placement.position[1], placement.position[2]);
      dummy.rotation.set(0, placement.yaw, 0);
      dummy.scale.set(placement.scale[0], placement.scale[1], placement.scale[2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      palette.setX(index, placement.paletteSlot);
      traits.setXYZ(index, clampByte(placement.age), clampByte(placement.windStiffness), record.phaseByte);
      variants.setX(index, placement.archetypeIndex % this.limits.maxVariantsPerTier);
      const crown = placement.clearance ?? DEFAULT_CLEARANCE;
      clearance.setXYZW(index, crown[0], crown[1], crown[2], crown[3]);
      record.bucketIndex = index;
    }
    mesh.count = ids.length;
    mesh.instanceMatrix.needsUpdate = true;
    palette.needsUpdate = true;
    traits.needsUpdate = true;
    variants.needsUpdate = true;
    clearance.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.lastMatrixUploads += ids.length;
    this.totalMatrixUploads += ids.length;
    this.repacks++;
  }

  #flushDirtyBuckets() {
    const keys = [...this.dirtyBuckets].sort();
    for (const key of keys) this.#repackBucket(key);
    this.dirtyBuckets.clear();
  }

  addOwner(owner, placements, view = {}) {
    if (this.disposed) throw new Error('Plant render pools are disposed');
    if (typeof owner !== 'string' || !owner || owner.length > 128 || !Array.isArray(placements)) {
      throw new TypeError('Plant pool owner and placements are required');
    }
    if (this.owners.has(owner)) throw new Error(`Plant pool owner already mounted: ${owner}`);
    if (this.owners.size >= this.maxOwners) throw new Error(`Plant owner cap reached: ${this.maxOwners}`);
    if (this.records.size + placements.length > this.maxEntries) throw new Error(`Plant resident entry cap reached: ${this.maxEntries}`);

    const prepared = [];
    const ids = new Set();
    const familySets = new Map();
    for (const item of placements) {
      const placement = validatePlacement(owner, item);
      if (ids.has(item.id) || this.records.has(item.id)) throw new Error(`Duplicate plant stable ID: ${item.id}`);
      ids.add(item.id);
      let lodSets = familySets.get(placement.family);
      if (!lodSets) {
        lodSets = [];
        for (let variant = 0; variant < this.library.variantsPerFamily; variant++) {
          lodSets.push(this.library.getLodSet(placement.family, variant));
        }
        familySets.set(placement.family, lodSets);
      }
      const lodSet = lodSets[placement.archetypeIndex % lodSets.length];
      prepared.push({
        id: item.id,
        owner,
        placement,
        lodSet,
        sourceType: item.sourceType,
        phaseByte: hashText(`${item.id}:phase`) & 255,
        lod: null,
        bucketKey: null,
        bucketIndex: -1,
      });
    }
    for (const [family, lodSets] of familySets) this.#ensureFamilyResources(family, lodSets);

    this.#setEvaluationView(view, true);
    if (this.windEnabled) this.wind.update(this.evaluationInput.nowMilliseconds);
    this.lastMatrixUploads = 0;
    prepared.sort((first, second) => first.id.localeCompare(second.id));
    try {
      for (const record of prepared) {
        record.lod = this.#evaluateRecord(record, true);
        record.bucketKey = record.lod === 'beyond' ? null : bucketKey(record.placement.family, record.lod);
      }
    } catch (error) {
      for (const record of prepared) this.selector.remove(record.id);
      throw error;
    }
    const activeKeys = new Set();
    for (const bucket of this.buckets.values()) if (bucket.ids.size) activeKeys.add(bucket.key);
    const legacyKeys = new Set();
    let predictedTriangles = this.#visibleTriangles();
    for (const record of prepared) {
      legacyKeys.add(record.sourceType ?? record.placement.family);
      if (!record.bucketKey) continue;
      activeKeys.add(record.bucketKey);
      predictedTriangles += this.buckets.get(record.bucketKey).geometry.userData.gdoPlantUpload.drawTriangles;
    }
    const predictedAddedDraws = Math.max(0,
      activeKeys.size - (this.#legacyEquivalentDraws() + legacyKeys.size));
    if (predictedTriangles > this.limits.maxVisibleTriangles || predictedAddedDraws > this.limits.maxAddedDrawCalls) {
      for (const record of prepared) this.selector.remove(record.id);
      throw new Error(`Plant render budget reached: ${predictedTriangles} triangles, ${predictedAddedDraws} added draws`);
    }

    const ownerIds = [];
    for (const record of prepared) {
      this.records.set(record.id, record);
      ownerIds.push(record.id);
      if (record.bucketKey) {
        this.buckets.get(record.bucketKey).ids.add(record.id);
        this.dirtyBuckets.add(record.bucketKey);
      }
    }
    this.owners.set(owner, ownerIds);
    this.#rebuildSchedule();
    this.#flushDirtyBuckets();
    this.ownerAdds++;
    return ownerIds.length;
  }

  removeOwner(owner) {
    if (this.disposed) return 0;
    const ids = this.owners.get(owner);
    if (!ids) return 0;
    this.lastMatrixUploads = 0;
    for (const id of ids) {
      const record = this.records.get(id);
      if (record?.bucketKey) {
        this.buckets.get(record.bucketKey)?.ids.delete(id);
        this.dirtyBuckets.add(record.bucketKey);
      }
      this.selector.remove(id);
      this.records.delete(id);
    }
    this.owners.delete(owner);
    this.#rebuildSchedule();
    this.#flushDirtyBuckets();
    this.ownerRemovals++;
    return ids.length;
  }

  /** Wind is opt-in; without it these are inert so callers cannot half-enable it. */
  configureWind(options = {}) {
    if (this.disposed || !this.windEnabled) return false;
    return this.wind.configure(options);
  }

  setReducedMotion(value) {
    if (this.disposed) return false;
    return this.wind.setReducedMotion(value);
  }

  update(view = {}) {
    if (this.disposed || !this.records.size) return 0;
    this.#setEvaluationView(view, false);
    // Disabled wind compiles no clock uniform, so a steady frame performs zero
    // wind work rather than writing a uniform that no shader reads.
    if (this.windEnabled) this.wind.update(this.evaluationInput.nowMilliseconds);
    this.lastMatrixUploads = 0;
    const sliceMilliseconds = 1000 / (this.selector.policy.maxReevaluationsHz * this.schedule.length);
    const step = Math.floor(this.evaluationInput.nowMilliseconds / sliceMilliseconds);
    if (step === this.lastScheduleStep) return 0;
    this.lastScheduleStep = step;
    const slot = ((step % this.schedule.length) + this.schedule.length) % this.schedule.length;
    let evaluated = 0;
    for (const id of this.schedule[slot]) {
      const record = this.records.get(id);
      if (!record) continue;
      const previousLod = record.lod;
      const lod = this.#evaluateRecord(record, false);
      evaluated += Number(this.evaluationResult.evaluated);
      if (lod === previousLod) continue;
      if (record.bucketKey) {
        this.buckets.get(record.bucketKey)?.ids.delete(id);
        this.dirtyBuckets.add(record.bucketKey);
      }
      record.lod = lod;
      record.bucketKey = lod === 'beyond' ? null : bucketKey(record.placement.family, lod);
      if (record.bucketKey) {
        this.buckets.get(record.bucketKey).ids.add(id);
        this.dirtyBuckets.add(record.bucketKey);
      }
    }
    if (this.dirtyBuckets.size) this.#flushDirtyBuckets();
    return evaluated;
  }

  handleContextRestored() {
    if (this.disposed) return;
    this.contextRestores++;
    this.wind.handleContextRestored();
    for (const bucket of this.buckets.values()) {
      for (const attribute of Object.values(bucket.geometry.attributes)) attribute.needsUpdate = true;
      if (!bucket.mesh) continue;
      bucket.mesh.instanceMatrix.needsUpdate = true;
      bucket.geometry.getAttribute('gdoPlantPalette').needsUpdate = true;
      bucket.geometry.getAttribute('gdoPlantTraits').needsUpdate = true;
      bucket.geometry.getAttribute('gdoPlantVariant').needsUpdate = true;
      bucket.geometry.getAttribute('gdoPlantClearance').needsUpdate = true;
    }
  }

  getRecord(id) {
    const record = this.records.get(id);
    return record ? Object.freeze({
      id: record.id,
      owner: record.owner,
      family: record.placement.family,
      archetypeIndex: record.placement.archetypeIndex,
      lod: record.lod,
      bucketKey: record.bucketKey,
      bucketIndex: record.bucketIndex,
    }) : null;
  }

  snapshot() {
    const records = [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id)).map(record => Object.freeze({
      id: record.id,
      owner: record.owner,
      family: record.placement.family,
      archetypeIndex: record.placement.archetypeIndex,
      lod: record.lod,
      bucketKey: record.bucketKey,
      bucketIndex: record.bucketIndex,
      paletteSlot: record.placement.paletteSlot,
      age: record.placement.age,
      windStiffness: record.placement.windStiffness,
      position: Object.freeze([...record.placement.position]),
      yaw: record.placement.yaw,
      scale: Object.freeze([...record.placement.scale]),
      clearance: Object.freeze([...(record.placement.clearance ?? DEFAULT_CLEARANCE)]),
    }));
    const pools = [...this.buckets.values()].filter(bucket => bucket.ids.size).sort((a, b) => a.key.localeCompare(b.key))
      .map(bucket => Object.freeze({ key: bucket.key, ids: Object.freeze([...bucket.ids].sort()) }));
    return Object.freeze({
      namespace: GDO_PLANT_RENDER_NAMESPACE,
      owners: Object.freeze([...this.owners.keys()].sort()),
      records: Object.freeze(records),
      pools: Object.freeze(pools),
    });
  }

  fingerprint() {
    return hashText(JSON.stringify(this.snapshot())).toString(16).padStart(8, '0');
  }

  dispose() {
    if (this.disposed) return;
    for (const owner of [...this.owners.keys()]) this.removeOwner(owner);
    for (const bucket of this.buckets.values()) {
      bucket.mesh?.removeFromParent();
      bucket.mesh?.dispose();
    }
    for (const geometry of this.resources.values()) geometry.dispose();
    this.material.dispose();
    this.group.removeFromParent();
    this.group.clear();
    this.selector.dispose();
    this.libraryHandle.release();
    this.records.clear();
    this.owners.clear();
    this.resources.clear();
    this.buckets.clear();
    this.disposed = true;
  }
}
