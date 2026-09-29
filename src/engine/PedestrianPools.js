import * as THREE from 'three';
import { adoptPoolResources } from './LifecycleContract.js';
import { GDO_CAMERA_FADE_DITHER_SIZE } from './CameraFade.js';
import { createAmbientLifeScheduler } from './AmbientLifeScheduler.js';
import {
  GDO_PEDESTRIAN_FAMILIES,
  GDO_PEDESTRIAN_FAMILY_ORDER,
  GDO_PEDESTRIAN_NAMESPACE,
  GDO_PEDESTRIAN_STATE,
} from './LocalPedestrians.js';

/**
 * `LIF-04` rendering half: flat pedestrian silhouettes whose **run cycle** is
 * computed in one shared vertex program from a single clock uniform.
 *
 * The brief is the classic flat agent — a walking figure whose limbs swing — but
 * without the cost such agents usually carry: no CPU limb transforms, no per-frame
 * instance matrices, no animation textures. Every sprite is one flat 2D quad set
 * (body, head, arms, legs, and a carried bag for the carrier family) whose parts
 * rotate about declared pivots in the shader, so a steady frame writes one clock
 * uniform and one bounded position stream, and the pools keep two draw calls
 * regardless of how many pedestrians are resident.
 *
 * Serving is the landed `LIF-02` scheduler: every resident agent is offered once
 * per frame and drawn only when it is on screen, large enough to read, and inside
 * the pedestrian budget; the rest are parked at zero scale. Agents are visual-only
 * — no proxy, no collider, no camera blocker — so a pedestrian can never block the
 * player, and its disposal is the pool's own ledger adoption.
 */

export const GDO_PEDESTRIAN_SPRITE_PART = Object.freeze({
  BODY: 0,
  HEAD: 1,
  LEFT_LEG: 2,
  RIGHT_LEG: 3,
  LEFT_ARM: 4,
  RIGHT_ARM: 5,
  BAG: 6,
});

export const GDO_PEDESTRIAN_POOL_LIMITS = Object.freeze({
  maxInstancesPerFamily: 48,
  maxAddedDrawCalls: GDO_PEDESTRIAN_FAMILY_ORDER.length,
  maxInstanceBytes: 8 * 1024,
  maxUniformWritesPerFrame: 1,
  cpuMatrixUpdatesPerFrame: 0,
  steadyFrameAllocations: 0,
});

/** Shared run-cycle constants: the vertex program and the audit read the same numbers. */
export const GDO_PEDESTRIAN_RUN_SOLVER = Object.freeze({
  /** Limb swing frequency multiplier applied to an agent's own pace. */
  stepRate: 5.2,
  legSwingRadians: .52,
  armSwingRadians: .38,
  bobFraction: .022,
  /** Seconds wrapped by the shared clock, so precision never degrades. */
  clockWrapSeconds: 3_600,
});

function quad(x0, y0, x1, y1, color, part, pivotX, pivotY) {
  const positions = new Float32Array([
    x0, y0, 0, x1, y0, 0, x1, y1, 0,
    x0, y0, 0, x1, y1, 0, x0, y1, 0,
  ]);
  const colors = new Float32Array(18);
  for (let corner = 0; corner < 6; corner++) {
    colors[corner * 3] = color[0];
    colors[corner * 3 + 1] = color[1];
    colors[corner * 3 + 2] = color[2];
  }
  const parts = new Float32Array(6).fill(part);
  const pivots = new Float32Array(12);
  for (let corner = 0; corner < 6; corner++) {
    pivots[corner * 2] = pivotX;
    pivots[corner * 2 + 1] = pivotY;
  }
  return { positions, colors, parts, pivots };
}

/**
 * Flat silhouettes in the sprite's local units (the sprite is scaled by the
 * instance's own form channel). The local origin is the agent's feet at the
 * centre of the body, `+y` is up, and `+x` is the agent's own right.
 */
export function createPedestrianSpriteData(family) {
  const recipe = GDO_PEDESTRIAN_FAMILIES[family];
  if (!recipe) throw new RangeError(`Unknown pedestrian family: ${family}`);
  const skin = [.52, .36, .25];
  const cloth = family === 'carrier' ? [.86, .32, .19] : [.26, .34, .52];
  const trouser = [.22, .24, .30];
  const hair = [.14, .11, .10];
  const hipY = .46, shoulderY = .79, headY = .86;
  const pieces = [
    // Torso and head stand still; the legs and arms swing about their own pivots.
    quad(-.085, hipY, .085, shoulderY + .04, cloth, GDO_PEDESTRIAN_SPRITE_PART.BODY, 0, 0),
    quad(-.055, headY, .055, headY + .12, skin, GDO_PEDESTRIAN_SPRITE_PART.HEAD, 0, 0),
    quad(-.05, headY + .08, .05, headY + .13, hair, GDO_PEDESTRIAN_SPRITE_PART.HEAD, 0, 0),
    quad(-.045, 0, .015, hipY, trouser, GDO_PEDESTRIAN_SPRITE_PART.LEFT_LEG, 0, hipY),
    quad(.015, 0, .045, hipY, trouser, GDO_PEDESTRIAN_SPRITE_PART.RIGHT_LEG, 0, hipY),
    quad(-.105, shoulderY - .30, -.085, shoulderY, skin, GDO_PEDESTRIAN_SPRITE_PART.LEFT_ARM, 0, shoulderY),
    quad(.085, shoulderY - .30, .105, shoulderY, skin, GDO_PEDESTRIAN_SPRITE_PART.RIGHT_ARM, 0, shoulderY),
  ];
  if (family === 'carrier') {
    // A carried bag changes the silhouette without changing the walk.
    pieces.push(quad(-.09, shoulderY - .34, .09, shoulderY - .12, [.10, .42, .38],
      GDO_PEDESTRIAN_SPRITE_PART.BAG, 0, shoulderY));
  }
  const vertexCount = pieces.reduce((total, piece) => total + piece.positions.length, 0);
  const positions = new Float32Array(vertexCount);
  const colors = new Float32Array(vertexCount);
  const parts = new Float32Array(vertexCount / 3);
  const pivots = new Float32Array(vertexCount / 3 * 2);
  let positionCursor = 0, partCursor = 0;
  for (const piece of pieces) {
    positions.set(piece.positions, positionCursor);
    colors.set(piece.colors, positionCursor);
    parts.set(piece.parts, partCursor);
    pivots.set(piece.pivots, partCursor * 2);
    positionCursor += piece.positions.length;
    partCursor += piece.parts.length;
  }
  return Object.freeze({
    family,
    namespace: GDO_PEDESTRIAN_NAMESPACE,
    positions,
    colors,
    parts,
    pivots,
    triangles: positions.length / 9,
    flat: true,
    runtimeCsgOperations: 0,
    collisionProxies: 0,
  });
}

function ambientFadeDiscard() {
  return `
  if (vGdoPedestrianPark > 0.001) {
    if (texture2D(gdoCameraDither, gl_FragCoord.xy / ${GDO_CAMERA_FADE_DITHER_SIZE}.0).r < vGdoPedestrianPark) discard;
  }`;
}

const VERTEX_DECLARATIONS = `
attribute float gdoPedPart;
attribute vec2 gdoPedPivot;
attribute vec4 gdoPedAnchor;
attribute vec4 gdoPedForm;
attribute vec4 gdoPedPose;
attribute float gdoPedPark;
varying float vGdoPedestrianPark;
uniform vec2 gdoPedestrianClock;
uniform float gdoPedestrianReduced;
`;

function solverBody() {
  const solver = GDO_PEDESTRIAN_RUN_SOLVER;
  return `
  // The run cycle: one sine per agent drives both legs and both arms about their
  // declared pivots, with the arms opposite to the legs and a small vertical bob.
  float gdoPedRate = max(gdoPedForm.z, 0.25);
  float gdoPedPhase = gdoPedForm.y * 6.2831853;
  float gdoPedSwing = sin(gdoPedestrianClock.x * gdoPedRate * ${solver.stepRate} + gdoPedPhase);
  float gdoPedLegSign = step(1.5, gdoPedPart) * (1.0 - 2.0 * step(2.5, gdoPedPart));
  float gdoPedArmSign = step(3.5, gdoPedPart) * (1.0 - 2.0 * step(4.5, gdoPedPart));
  float gdoPedAngle = gdoPedSwing * (gdoPedLegSign * ${solver.legSwingRadians}
    - gdoPedArmSign * ${solver.armSwingRadians});
  vec2 gdoPedOffset = position.xy;
  if (abs(gdoPedAngle) > 0.0001) {
    vec2 gdoPedLocal = gdoPedOffset - gdoPedPivot;
    float gdoPedCos = cos(gdoPedAngle), gdoPedSin = sin(gdoPedAngle);
    gdoPedOffset = vec2(gdoPedLocal.x * gdoPedCos - gdoPedLocal.y * gdoPedSin,
      gdoPedLocal.x * gdoPedSin + gdoPedLocal.y * gdoPedCos) + gdoPedPivot;
  }
  float gdoPedBob = abs(gdoPedSwing) * ${solver.bobFraction};
  // A reduced-motion agent stands still: the walk cycle is the first thing to go.
  if (gdoPedestrianReduced > 0.5) gdoPedOffset = position.xy;
  float gdoPedScale = max(gdoPedForm.x, 0.0001);
  // The form channel's w carries the family, so the two silhouettes keep their
  // own declared extents while sharing one program.
  vec2 gdoPedSize = mix(vec2(${GDO_PEDESTRIAN_FAMILIES.walker.spriteWidth.toFixed(4)},
    ${GDO_PEDESTRIAN_FAMILIES.walker.spriteHeight.toFixed(4)}),
    vec2(${GDO_PEDESTRIAN_FAMILIES.carrier.spriteWidth.toFixed(4)},
    ${GDO_PEDESTRIAN_FAMILIES.carrier.spriteHeight.toFixed(4)}), step(0.5, gdoPedForm.w));
  vec2 gdoPedBody = gdoPedOffset * gdoPedSize * gdoPedScale;
  // The flat sprite yaws with the agent's own heading, so a walker seen from the
  // side shows its profile and a walker walking away shows its back.
  vec2 gdoPedRight = vec2(cos(gdoPedAnchor.w), -sin(gdoPedAnchor.w));
  vec2 gdoPedViewRight = (viewMatrix * vec4(gdoPedRight.x, 0.0, gdoPedRight.y, 0.0)).xy;
  float gdoPedSpin = length(gdoPedViewRight) > 0.001 ? atan(gdoPedViewRight.y, gdoPedViewRight.x) : 0.0;
  float gdoPedSpinCos = cos(gdoPedSpin), gdoPedSpinSin = sin(gdoPedSpin);
  vec2 gdoPedSprite = vec2(gdoPedBody.x * gdoPedSpinCos - gdoPedBody.y * gdoPedSpinSin,
    gdoPedBody.x * gdoPedSpinSin + gdoPedBody.y * gdoPedSpinCos);
  vec3 gdoPedCenter = vec3(gdoPedAnchor.x, gdoPedAnchor.y + gdoPedBob * gdoPedScale, gdoPedAnchor.z);
  float gdoPedDistance = distance(cameraPosition, gdoPedCenter);
  float gdoPedVisibility = 1.0 - smoothstep(gdoPedPose.y * 0.62, gdoPedPose.y, gdoPedDistance);
  vec2 gdoPedViewOffset = gdoPedSprite * gdoPedVisibility * gdoPedPose.z * gdoPedPose.x;
  vGdoPedestrianPark = clamp(gdoPedPark, 0.0, 1.0) * gdoPedVisibility;
`;
}

const PROJECT_VERTEX = `
  vec4 gdoPedViewCenter = viewMatrix * vec4(gdoPedCenter, 1.0);
  vec4 mvPosition = gdoPedViewCenter;
  mvPosition.xy += gdoPedViewOffset;
  gl_Position = projectionMatrix * mvPosition;
`;

export function createPedestrianMaterial({ ditherUniform = null } = {}) {
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    fog: true,
    // `LAY-06`: parking a pedestrian is a screen-door discard, never a blend.
    transparent: false,
  });
  material.name = `${GDO_PEDESTRIAN_NAMESPACE}:sprite`;
  const uniforms = Object.freeze({
    clock: Object.seal({ value: new THREE.Vector2() }),
    reduced: Object.seal({ value: 0 }),
  });
  if (ditherUniform != null && !ditherUniform.value?.isTexture) {
    throw new TypeError('Pedestrian sprites need the shared camera-fade dither texture');
  }
  material.userData.gdoPedestrian = Object.freeze({
    namespace: GDO_PEDESTRIAN_NAMESPACE,
    billboard: 'view-plane-2d',
    runCycle: 'vertex',
    uniforms,
    cpuMatrixUpdatesPerFrame: 0,
  });
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, {
      gdoPedestrianClock: uniforms.clock,
      gdoPedestrianReduced: uniforms.reduced,
    });
    if (ditherUniform) shader.uniforms.gdoCameraDither = ditherUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECLARATIONS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${solverBody()}`)
      .replace('#include <project_vertex>', PROJECT_VERTEX);
    if (ditherUniform) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vGdoPedestrianPark;\nuniform sampler2D gdoCameraDither;`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${ambientFadeDiscard()}`);
    }
  };
  material.customProgramCacheKey = () =>
    `${GDO_PEDESTRIAN_NAMESPACE}:sprite${ditherUniform ? ':camera-fade' : ''}`;
  // `LAY-06`: a pedestrian that cannot be afforded is a screen-door discard off the
  // one shared mask, exactly like the ambience — never a blend.
  material.userData.gdoPedestrianCameraFade = ditherUniform
    ? Object.freeze({
      namespace: GDO_PEDESTRIAN_NAMESPACE,
      ditherSize: GDO_CAMERA_FADE_DITHER_SIZE,
      blended: false,
      depthWriting: true,
      discard: 'screen-door',
    })
    : null;
  return material;
}

function instanceAttribute(array, itemSize) {
  const attribute = new THREE.InstancedBufferAttribute(array, itemSize);
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}

/**
 * Two flat draws for every pedestrian in the resident world. The pool owns the
 * sprite streams, the material, and its own `LIF-02` scheduler instance (with the
 * pedestrian budget as its own declared limit), and it packs the board's live
 * records into per-family slots.
 */
export class PedestrianPools {
  constructor(scene, {
    material = null,
    profile = 'low',
    maxAgents = 16,
    renderOrder = 0,
    layer = null,
    reducedMotion = false,
    ledger = null,
    limits = GDO_PEDESTRIAN_POOL_LIMITS,
  } = {}) {
    if (!scene?.add) throw new TypeError('PedestrianPools requires a scene');
    if (!Number.isInteger(maxAgents) || maxAgents <= 0) {
      throw new RangeError('PedestrianPools needs a positive agent cap');
    }
    if (!Number.isInteger(limits.maxInstancesPerFamily) || maxAgents > limits.maxInstancesPerFamily) {
      throw new RangeError('Pedestrian pool cap exceeds the declared instance ceiling');
    }
    this.limits = limits;
    this.profile = profile;
    this.maxAgents = maxAgents;
    this.layer = layer;
    this.reducedMotion = Boolean(reducedMotion);
    this.material = material ?? createPedestrianMaterial();
    this.uniforms = this.material.userData.gdoPedestrian?.uniforms ?? null;
    if (this.uniforms) this.uniforms.reduced.value = this.reducedMotion ? 1 : 0;
    this.geometries = GDO_PEDESTRIAN_FAMILY_ORDER.map(family => {
      const data = createPedestrianSpriteData(family);
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.name = `${GDO_PEDESTRIAN_NAMESPACE}:${family}`;
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
      geometry.setAttribute('gdoPedPart', new THREE.BufferAttribute(data.parts, 1));
      geometry.setAttribute('gdoPedPivot', new THREE.BufferAttribute(data.pivots, 2));
      geometry.setAttribute('gdoPedAnchor', instanceAttribute(new Float32Array(limits.maxInstancesPerFamily * 4), 4));
      geometry.setAttribute('gdoPedForm', instanceAttribute(new Float32Array(limits.maxInstancesPerFamily * 4), 4));
      geometry.setAttribute('gdoPedPose', instanceAttribute(new Float32Array(limits.maxInstancesPerFamily * 4), 4));
      geometry.setAttribute('gdoPedPark', instanceAttribute(new Float32Array(limits.maxInstancesPerFamily), 1));
      geometry.instanceCount = 0;
      geometry.userData.gdoPedestrianSprite = Object.freeze({
        family, triangles: data.triangles, flat: true, runCycle: 'vertex',
        runtimeCsgOperations: 0, collisionProxies: 0,
      });
      return geometry;
    });
    let instanceBytes = 0;
    for (const geometry of this.geometries) {
      for (const name of ['gdoPedAnchor', 'gdoPedForm', 'gdoPedPose', 'gdoPedPark']) {
        instanceBytes += geometry.getAttribute(name).array.byteLength;
      }
    }
    if (instanceBytes > limits.maxInstanceBytes) {
      for (const geometry of this.geometries) geometry.dispose();
      throw new RangeError('Pedestrian instance bytes exceed the declared ceiling');
    }
    this.instanceBytes = instanceBytes;
    this.group = new THREE.Group();
    this.group.name = GDO_PEDESTRIAN_NAMESPACE;
    this.meshes = this.geometries.map((geometry, index) => {
      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.name = `pedestrian-${GDO_PEDESTRIAN_FAMILY_ORDER[index]}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = renderOrder;
      mesh.userData.geoLayer = layer;
      mesh.userData.gdoPedestrianFamily = GDO_PEDESTRIAN_FAMILY_ORDER[index];
      mesh.userData.visualOnly = true;
      this.group.add(mesh);
      return mesh;
    });
    scene.add(this.group);
    this.lifecycleScope = ledger ? adoptPoolResources(ledger, GDO_PEDESTRIAN_NAMESPACE, {
      geometries: this.geometries,
      material: this.material,
      meshes: this.meshes,
      node: this.group,
    }) : null;
    // `LIF-02`: the pedestrian board is served by the landed scheduler, with the
    // research's own dynamic-pedestrian budget as this instance's declared limit.
    this.scheduler = createAmbientLifeScheduler({
      profile,
      ledger,
      limits: { maxActiveSources: maxAgents, maxSourcesPerUpdate: maxAgents, maxResidentSources: maxAgents },
    });
    this.familyCounts = GDO_PEDESTRIAN_FAMILY_ORDER.map(() => 0);
    this.parkedSlots = 0;
    this.drawnInstances = 0;
    this.instanceUploads = 0;
    this.uniformWrites = 0;
    this.packs = 0;
    this.lastPack = null;
    this.lastClock = null;
    this.disposed = false;
  }

  /**
   * One bounded pack: offer every resident agent to the scheduler, write the
   * survivors' pose streams, park the rest at zero visibility, and upload only
   * when something actually changed.
   */
  sync(board, { nowMilliseconds = 0, view = null } = {}) {
    if (this.disposed || !board?.residentRecords) return null;
    const { records, count } = board.residentRecords();
    const scheduler = this.scheduler;
    let uploads = 0, parked = 0;
    scheduler.begin(view ?? {});
    for (let index = 0; index < count; index++) {
      const record = records[index];
      scheduler.evaluate({
        id: record.id,
        familyIndex: record.familyIndex,
        x: record.x,
        y: record.y,
        z: record.z,
        radius: record.radius,
        viewDistance: record.viewDistance,
        priority: record.priority,
        windowLive: record.windowLive !== false && record.state === GDO_PEDESTRIAN_STATE.WALKING,
      });
    }
    const verdict = scheduler.finish();
    for (let familyIndex = 0; familyIndex < this.geometries.length; familyIndex++) {
      const geometry = this.geometries[familyIndex];
      const anchor = geometry.getAttribute('gdoPedAnchor').array;
      const form = geometry.getAttribute('gdoPedForm').array;
      const pose = geometry.getAttribute('gdoPedPose').array;
      const park = geometry.getAttribute('gdoPedPark').array;
      let slot = 0;
      for (let index = 0; index < count; index++) {
        const record = records[index];
        if (record.familyIndex !== familyIndex) continue;
        const decision = scheduler.decisions[index];
        const visibility = decision ? decision.visibility : 0;
        const base = slot * 4;
        const changed = anchor[base] !== record.x || anchor[base + 1] !== record.y ||
          anchor[base + 2] !== record.z || anchor[base + 3] !== record.heading ||
          form[base] !== record.scale || pose[base + 2] !== visibility;
        anchor[base] = record.x;
        anchor[base + 1] = record.y;
        anchor[base + 2] = record.z;
        anchor[base + 3] = record.heading;
        form[base] = record.scale;
        form[base + 1] = record.phase;
        form[base + 2] = record.rate;
        form[base + 3] = familyIndex;
        pose[base] = 1;
        pose[base + 1] = record.viewDistance;
        pose[base + 2] = visibility;
        pose[base + 3] = record.legIndex;
        // The scheduler's visibility parks a pruned agent at zero scale; a faded
        // agent keeps a screen-door level in the same stream the shader discards on.
        const parkLevel = visibility <= 0 ? 1 : Math.min(1, Math.max(0, 1 - visibility));
        if (park[slot] !== parkLevel) { park[slot] = parkLevel; geometry.getAttribute('gdoPedPark').needsUpdate = true; }
        if (visibility <= 0) parked++;
        if (changed) {
          geometry.getAttribute('gdoPedAnchor').needsUpdate = true;
          geometry.getAttribute('gdoPedForm').needsUpdate = true;
          geometry.getAttribute('gdoPedPose').needsUpdate = true;
          uploads++;
        }
        slot++;
      }
      this.familyCounts[familyIndex] = slot;
      if (geometry.instanceCount !== slot) {
        geometry.instanceCount = slot;
        uploads++;
      }
    }
    if (uploads > 0) this.instanceUploads += uploads;
    this.drawnInstances = this.familyCounts.reduce((total, value) => total + value, 0);
    this.parkedSlots = parked;
    this.packs++;
    this.lastPack = Object.freeze({
      namespace: GDO_PEDESTRIAN_NAMESPACE,
      offered: count,
      drawn: this.drawnInstances,
      parked,
      active: verdict.active,
      pruned: verdict.pruned,
      uploads,
      families: Object.freeze([...this.familyCounts]),
      steadyFrameAllocations: 0,
    });
    return this.lastPack;
  }

  /** One clock uniform write per changed frame; a settled frame writes nothing. */
  update(nowMilliseconds) {
    if (this.disposed || !this.uniforms || !Number.isFinite(nowMilliseconds)) return 0;
    const value = (nowMilliseconds * .001) % GDO_PEDESTRIAN_RUN_SOLVER.clockWrapSeconds;
    if (this.uniforms.clock.value.x === value) return 0;
    this.uniforms.clock.value.set(value, 0);
    this.uniformWrites++;
    this.lastClock = value;
    return 1;
  }

  setReducedMotion(value) {
    if (this.disposed) return false;
    const next = Boolean(value);
    if (next === this.reducedMotion) return false;
    this.reducedMotion = next;
    if (this.uniforms) this.uniforms.reduced.value = next ? 1 : 0;
    return true;
  }

  get diagnostics() {
    return Object.freeze({
      namespace: GDO_PEDESTRIAN_NAMESPACE,
      profile: this.profile,
      maxAgents: this.maxAgents,
      instanceBytes: this.instanceBytes,
      drawnInstances: this.drawnInstances,
      parkedSlots: this.parkedSlots,
      instanceUploads: this.instanceUploads,
      uniformWrites: this.uniformWrites,
      packs: this.packs,
      families: Object.freeze([...this.familyCounts]),
      drawCalls: GDO_PEDESTRIAN_FAMILY_ORDER.length,
      cpuMatrixUpdatesPerFrame: 0,
      steadyFrameAllocations: 0,
      limits: this.limits,
    });
  }

  /** Deterministic fingerprint of the resident sprite streams. */
  fingerprint() {
    let hash = 2166136261;
    for (let familyIndex = 0; familyIndex < this.geometries.length; familyIndex++) {
      const geometry = this.geometries[familyIndex];
      const count = geometry.instanceCount;
      for (const name of ['gdoPedAnchor', 'gdoPedForm', 'gdoPedPose']) {
        const attribute = geometry.getAttribute(name);
        for (let index = 0; index < count * attribute.itemSize; index++) {
          const text = attribute.array[index].toFixed(3);
          for (let position = 0; position < text.length; position++) {
            hash ^= text.charCodeAt(position);
            hash = Math.imul(hash, 16777619) >>> 0;
          }
        }
      }
    }
    return hash.toString(16).padStart(8, '0');
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler?.dispose?.();
    this.lifecycleScope?.disposeAll?.();
  }
}
