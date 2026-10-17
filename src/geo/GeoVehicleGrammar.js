/**
 * `DET-07` — vehicle grammar and tight proxy (`gdo:vehicleGrammar:v1`).
 *
 * Research §15.6: chassis/body → cabin/roof → bumpers → wheel blocks →
 * light/window accents, in three cost tiers (far 2–3 boxes, mid 5–8, near
 * 8–14). The collision gate is construction, not convention: **a solid vehicle
 * carries exactly one tight oriented body footprint** (its height reaches the
 * roof), compiled from the body module alone. Wheels, mirrors, bumpers, cargo
 * detail, and lights live in separate `DET-02` modules and can never appear in
 * `solidProxies`, so they cannot expand body collision.
 */

import { featureNamespace } from '../engine/FeatureVersions.js';
import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';
import {
  GEO_OBJECT_LOD,
  compileObjectRecipe,
  createObjectRecipe,
} from './GeoObjectRecipe.js';
import { GEO_SUPPORT_ROLE } from './GeoSupportSlots.js';
import { terrainHeightAt } from './GeoTerrain.js';
import { queryWaterDomain } from './GeoWaterDomains.js';

export const GDO_VEHICLE_NAMESPACE = featureNamespace('vehicleGrammar');

/** x, z, yaw, scaleX, scaleY, scaleZ, family, stableId */
export const GEO_VEHICLE_STRIDE = 8;
/** centerX, centerZ, halfWidth, halfDepth, yaw, bottom, top — the body only. */
export const GEO_VEHICLE_PROXY_STRIDE = 7;

export const GEO_VEHICLE_FAMILY = Object.freeze({
  HATCHBACK: 0,
  SEDAN: 1,
  SUV: 2,
  VAN: 3,
});

export const GEO_VEHICLE_FAMILY_NAMES = Object.freeze([
  'hatchback', 'sedan', 'suv', 'van',
]);

export const GEO_VEHICLE_LIMITS = Object.freeze({
  maxPlacementsPerTile: GDO_LOW_PROFILE_BUDGETS.vehiclePlacementsPerTile,
  maxPlacementTestsPerTile: GDO_LOW_PROFILE_BUDGETS.vehiclePlacementTestsPerTile,
  maxBoxesPerVehicle: GDO_LOW_PROFILE_BUDGETS.vehicleBoxesPerVehicle,
  maxModulesPerVehicle: 7,
  maxBodyProxiesPerVehicle: GDO_LOW_PROFILE_BUDGETS.vehicleBodyProxiesPerVehicle,
  maxProxiesPerTile: GDO_LOW_PROFILE_BUDGETS.vehicleProxiesPerTile,
  // Parked beside the carriageway, never in the lane the player drives.
  kerbShare: .31,
  minSegmentLength: 3.2,
  minSpacing: .7,
  bytesPerTile: GDO_LOW_PROFILE_BUDGETS.vehicleBytesPerTile,
});

/** Only these mapped classes receive parked vehicles (the legacy street set). */
export const GDO_VEHICLE_ROAD_KINDS = Object.freeze(new Set([
  'primary', 'secondary', 'tertiary', 'major', 'medium',
]));

/**
 * Family templates in world units at 1:10. The body box is the *only* proxy
 * source; every other module is visual by construction.
 */
const FAMILIES = Object.freeze([
  Object.freeze({
    id: GEO_VEHICLE_FAMILY.HATCHBACK, name: 'hatchback',
    body: Object.freeze({ sizeX: .28, sizeY: .15, sizeZ: .52, bottom: .075 }),
    cabin: Object.freeze({ sizeX: .235, sizeY: .115, sizeZ: .25, offsetZ: -.02 }),
    color: Object.freeze([.72, .12, .05]), cabinColor: Object.freeze([.05, .12, .18]),
  }),
  Object.freeze({
    id: GEO_VEHICLE_FAMILY.SEDAN, name: 'sedan',
    body: Object.freeze({ sizeX: .29, sizeY: .135, sizeZ: .58, bottom: .075 }),
    cabin: Object.freeze({ sizeX: .24, sizeY: .10, sizeZ: .30, offsetZ: -.01 }),
    color: Object.freeze([.10, .22, .52]), cabinColor: Object.freeze([.05, .12, .18]),
  }),
  Object.freeze({
    id: GEO_VEHICLE_FAMILY.SUV, name: 'suv',
    body: Object.freeze({ sizeX: .31, sizeY: .175, sizeZ: .56, bottom: .085 }),
    cabin: Object.freeze({ sizeX: .28, sizeY: .135, sizeZ: .33, offsetZ: 0 }),
    color: Object.freeze([.16, .30, .17]), cabinColor: Object.freeze([.05, .12, .18]),
  }),
  Object.freeze({
    id: GEO_VEHICLE_FAMILY.VAN, name: 'van',
    body: Object.freeze({ sizeX: .30, sizeY: .21, sizeZ: .62, bottom: .085 }),
    cabin: Object.freeze({ sizeX: .275, sizeY: .16, sizeZ: .44, offsetZ: .01 }),
    color: Object.freeze([.78, .72, .60]), cabinColor: Object.freeze([.10, .14, .17]),
  }),
]);

function mix32(value) {
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function random01(value) {
  return (mix32(value >>> 0) >>> 8) / 0x01000000;
}

function channel(seed, index) {
  return random01(mix32((seed >>> 0) ^ Math.imul(index + 1, 0x9e3779b1)));
}

function hashText(value, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return mix32(hash);
}

function tone(color, amount) {
  return color.map(base => Math.max(.02, Math.min(.98, base * (.86 + amount * .28))));
}

/**
 * Compile one vehicle from `(family, seed, scale)`. Deterministic. The
 * `solidProxies` list is built from the body module alone and is therefore
 * byte-identical no matter what wheels, mirrors, bumpers, lights, or cargo the
 * seed adds — that is the row's gate, enforced by construction.
 */
export function compileVehicle(familyIndex, { seed = 0, scale = 1 } = {}) {
  const family = FAMILIES[familyIndex];
  if (!family) throw new RangeError(`Unknown vehicle family: ${familyIndex}`);
  if (!Number.isFinite(seed)) throw new TypeError('Vehicle seed must be finite');
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('Vehicle scale must be finite and positive');

  const paint = tone(family.color, channel(seed, 0));
  const glass = tone(family.cabinColor, channel(seed, 1));
  const dark = [.028, .03, .032];
  const body = {
    centerX: 0,
    bottom: family.body.bottom * scale,
    centerZ: 0,
    sizeX: family.body.sizeX * scale,
    sizeY: family.body.sizeY * scale,
    sizeZ: family.body.sizeZ * scale,
    yaw: 0,
    color: paint,
  };
  const cabin = {
    centerX: 0,
    bottom: (family.body.bottom + family.body.sizeY * .72) * scale,
    centerZ: family.cabin.offsetZ * scale,
    sizeX: family.cabin.sizeX * scale,
    sizeY: family.cabin.sizeY * scale,
    sizeZ: family.cabin.sizeZ * scale,
    yaw: 0,
    color: paint,
  };

  const wheelRadius = .062 * scale;
  const wheels = [];
  for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) {
    wheels.push({
      centerX: sideX * (family.body.sizeX / 2 - .012) * scale,
      bottom: 0,
      centerZ: sideZ * family.body.sizeZ * .29 * scale,
      sizeX: .05 * scale,
      sizeY: wheelRadius * 2,
      sizeZ: .11 * scale,
      yaw: 0,
      color: dark,
    });
  }
  const underbody = {
    centerX: 0,
    bottom: family.body.bottom * .55 * scale,
    centerZ: 0,
    sizeX: family.body.sizeX * .78 * scale,
    sizeY: .035 * scale,
    sizeZ: family.body.sizeZ * .78 * scale,
    yaw: 0,
    color: dark,
  };
  const windowBand = {
    centerX: 0,
    bottom: (family.body.bottom + family.body.sizeY * .82) * scale,
    centerZ: family.cabin.offsetZ * scale,
    sizeX: family.cabin.sizeX * 1.04 * scale,
    sizeY: family.cabin.sizeY * .52 * scale,
    sizeZ: family.cabin.sizeZ * 1.02 * scale,
    yaw: 0,
    color: glass,
  };
  const bumpers = [];
  for (const sideZ of [-1, 1]) {
    bumpers.push({
      centerX: 0,
      bottom: family.body.bottom * .8 * scale,
      centerZ: sideZ * (family.body.sizeZ / 2 + .012) * scale,
      sizeX: family.body.sizeX * .94 * scale,
      sizeY: .05 * scale,
      sizeZ: .045 * scale,
      yaw: 0,
      color: dark,
    });
  }
  const mirrors = [];
  for (const sideX of [-1, 1]) {
    mirrors.push({
      centerX: sideX * (family.body.sizeX / 2 + .022) * scale,
      bottom: (family.body.bottom + family.body.sizeY * .88) * scale,
      centerZ: (family.cabin.offsetZ - family.cabin.sizeZ * .32) * scale,
      sizeX: .03 * scale,
      sizeY: .028 * scale,
      sizeZ: .02 * scale,
      yaw: 0,
      color: dark,
    });
  }
  const lights = [];
  for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) {
    lights.push({
      centerX: sideX * family.body.sizeX * .30 * scale,
      bottom: (family.body.bottom + family.body.sizeY * .42) * scale,
      centerZ: sideZ * (family.body.sizeZ / 2 + .006) * scale,
      sizeX: .055 * scale,
      sizeY: .028 * scale,
      sizeZ: .018 * scale,
      yaw: 0,
      color: sideZ > 0 ? [1.0, .92, .58] : [.82, .06, .04],
    });
  }
  const roofAccent = {
    centerX: 0,
    bottom: (family.body.bottom + family.body.sizeY + family.cabin.sizeY * (family.id === GEO_VEHICLE_FAMILY.VAN ? .96 : .1)) * scale,
    centerZ: family.cabin.offsetZ * scale,
    sizeX: family.cabin.sizeX * .62 * scale,
    sizeY: .028 * scale,
    sizeZ: family.cabin.sizeZ * .52 * scale,
    yaw: 0,
    color: dark,
  };

  const supportId = (mix32(seed >>> 0) % 100_000) + 1;
  const recipe = createObjectRecipe({
    id: `${GDO_VEHICLE_NAMESPACE}:${family.name}:${supportId}`,
    owner: 'vehicle-grammar',
    support: {
      id: supportId,
      roleMask: GEO_SUPPORT_ROLE.ROAD_EDGE,
      x: 0, y: 0, z: 0,
      halfWidth: family.body.sizeX * scale,
      halfDepth: family.body.sizeZ * scale,
      yaw: 0,
    },
    height: (family.body.bottom + family.body.sizeY + family.cabin.sizeY) * scale,
    silhouette: [
      { id: 'chassis-body', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [body] },
      { id: 'cabin-roof', minimumLod: GEO_OBJECT_LOD.FAR, boxes: [cabin] },
    ],
    surface: [
      { id: 'underbody', minimumLod: GEO_OBJECT_LOD.MID, boxes: [underbody] },
      { id: 'wheel-blocks', minimumLod: GEO_OBJECT_LOD.MID, boxes: wheels },
      { id: 'window-band', minimumLod: GEO_OBJECT_LOD.MID, boxes: [windowBand] },
    ],
    accents: [
      { id: 'bumpers', minimumLod: GEO_OBJECT_LOD.NEAR, boxes: bumpers },
      { id: 'mirrors', minimumLod: GEO_OBJECT_LOD.NEAR, boxes: mirrors },
      { id: 'lights', minimumLod: GEO_OBJECT_LOD.NEAR, boxes: lights },
      { id: 'roof-accent', minimumLod: GEO_OBJECT_LOD.NEAR, boxes: [roofAccent] },
    ],
    visualBounds: {
      minX: -family.body.sizeX * .6 * scale,
      minY: 0,
      minZ: -family.body.sizeZ * .58 * scale,
      maxX: family.body.sizeX * .6 * scale,
      maxY: (family.body.bottom + family.body.sizeY + family.cabin.sizeY + .04) * scale,
      maxZ: family.body.sizeZ * .58 * scale,
    },
    // The one and only proxy source: the oriented body footprint, its height
    // reaching the roof. Nothing derived from wheels, mirrors, bumpers, lights,
    // windows, or cargo may enter this list.
    solidProxies: [bodyProxy(body)],
    interactionProxies: [],
    cameraRoles: [],
  });
  const compiled = compileObjectRecipe(recipe, {
    lod: GEO_OBJECT_LOD.NEAR,
    maxModules: GEO_VEHICLE_LIMITS.maxModulesPerVehicle,
    maxBoxes: GEO_VEHICLE_LIMITS.maxBoxesPerVehicle,
  });
  return Object.freeze({
    namespace: GDO_VEHICLE_NAMESPACE,
    family: family.id,
    name: family.name,
    scale,
    recipe,
    compiled,
    proxies: recipe.solidProxies,
    body,
    diagnostics: Object.freeze({
      boxes: compiled.diagnostics.emittedBoxes,
      skippedModules: compiled.diagnostics.skippedModules,
      proxies: recipe.solidProxies.length,
    }),
  });
}

function bodyProxy(body) {
  return {
    id: 'vehicle-body',
    shape: 'obb',
    x: body.centerX,
    z: body.centerZ,
    halfWidth: body.sizeX / 2,
    halfDepth: body.sizeZ / 2,
    yaw: body.yaw ?? 0,
    bottom: body.bottom,
    top: body.bottom + body.sizeY,
  };
}

/** Canonical family recipes: what the render pools compile once and instance. */
export function vehicleRecipes() {
  return Object.freeze(FAMILIES.map(family => Object.freeze({
    family: family.id,
    name: family.name,
    compiled: compileVehicle(family.id, { seed: 0xca7001, scale: 1 }),
  })));
}

function pointInAabb(x, z, box) {
  return x >= box[0] && x <= box[2] && z >= box[1] && z <= box[3];
}

/** Accept building records as `{minX,minZ,maxX,maxZ}` or plain AABB arrays. */
function normalizeAabbs(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (Array.isArray(entry) && entry.length >= 4) out.push(entry);
    else if (entry && [entry.minX, entry.minZ, entry.maxX, entry.maxZ].every(Number.isFinite)) {
      out.push([entry.minX, entry.minZ, entry.maxX, entry.maxZ]);
    }
    if (out.length >= 2_048) break;
  }
  return out;
}

/**
 * Place parked vehicles beside mapped carriageways. Segments arrive as the
 * world already decoded them (`GME-07`'s line stream: flat point pairs plus
 * the mapped class and width), so this pass never re-reads the provider. Each
 * accepted vehicle contributes one placement record and exactly one body OBB
 * in world space.
 */
export function placeVehicles({
  lines = [],
  kinds = [],
  widths = [],
  terrainSeed = 0,
  seed = 0,
  obstacles = {},
  waterDomain = null,
  maxPlacements = GEO_VEHICLE_LIMITS.maxPlacementsPerTile,
} = {}) {
  if (!Number.isFinite(terrainSeed) || !Number.isFinite(seed)) {
    throw new TypeError('Vehicle placement requires finite seeds');
  }
  const buildings = normalizeAabbs(obstacles.buildings);
  const accepted = [];
  const proxies = [];
  let tests = 0, testsCapped = false;
  const rejected = { kind: 0, water: 0, building: 0, spacing: 0 };

  for (let lineIndex = 0; lineIndex < lines.length && accepted.length < maxPlacements; lineIndex++) {
    const kind = kinds[lineIndex] ?? '';
    if (!GDO_VEHICLE_ROAD_KINDS.has(kind)) { rejected.kind++; continue; }
    const width = Number.isFinite(widths[lineIndex]) ? widths[lineIndex] : .24;
    const line = lines[lineIndex];
    for (let index = 1; index + 2 < line.length && accepted.length < maxPlacements; index += 2) {
      const x1 = line[index - 1], z1 = line[index];
      const x2 = line[index + 1], z2 = line[index + 2];
      const dx = x2 - x1, dz = z2 - z1;
      const length = Math.hypot(dx, dz);
      if (length < GEO_VEHICLE_LIMITS.minSegmentLength) continue;
      const slots = Math.min(5, Math.floor(length / GEO_VEHICLE_LIMITS.minSegmentLength));
      for (let slot = 1; slot <= slots && accepted.length < maxPlacements; slot++) {
        if (tests >= GEO_VEHICLE_LIMITS.maxPlacementTestsPerTile) { testsCapped = true; break; }
        const localSeed = hashText(`${GDO_VEHICLE_NAMESPACE}:${seed}:${lineIndex}:${index}:${slot}`);
        tests++;
        // Sparse and deterministic: most slots stay empty, so a street reads as
        // a parked row here and there, not a showroom.
        if (random01(localSeed ^ 0x5bd1e995) > .42) continue;
        const amount = slot / (slots + 1), side = (slot + lineIndex) % 2 ? 1 : -1;
        const nx = -dz / length, nz = dx / length;
        const offset = side * Math.max(.13, width * GEO_VEHICLE_LIMITS.kerbShare);
        const x = x1 + dx * amount + nx * offset;
        const z = z1 + dz * amount + nz * offset;

        const family = pickFamily(localSeed);
        const vehicle = compileVehicle(family, {
          seed: (localSeed ^ 0x7ee1) >>> 0,
          scale: .86 + random01(localSeed ^ 0xc2b2ae35) * .22,
        });
        const radius = Math.max(vehicle.body.sizeX, vehicle.body.sizeZ) * .55;
        if (waterDomain && queryWaterDomain(waterDomain, x, z, {}).waterDistance <= radius + .05) {
          rejected.water++; continue;
        }
        if (buildings.some(box => pointInAabb(x, z, [
          box[0] - radius, box[1] - radius, box[2] + radius, box[3] + radius,
        ]))) { rejected.building++; continue; }
        const spacing = GEO_VEHICLE_LIMITS.minSpacing + radius;
        if (accepted.some(other =>
          (other.x - x) ** 2 + (other.z - z) ** 2 < (spacing + other.radius) ** 2)) {
          rejected.spacing++; continue;
        }

        const yaw = Math.atan2(dx, dz);
        const groundY = terrainHeightAt(x, z, terrainSeed);
        const stableId = (localSeed >>> 8) & 0x00ffffff;
        accepted.push({
          x, z, yaw,
          scaleX: vehicle.scale, scaleY: vehicle.scale, scaleZ: vehicle.scale,
          family: vehicle.family, stableId, radius, groundY, vehicle,
        });
      }
    }
  }

  accepted.sort((first, second) => first.family - second.family || first.stableId - second.stableId ||
    first.x - second.x || first.z - second.z);
  const placementValues = [];
  for (const item of accepted) {
    placementValues.push(item.x, item.z, item.yaw, item.scaleX, item.scaleY, item.scaleZ,
      item.family, item.stableId);
    // One tight body OBB per vehicle, rotated by the parked yaw. The proxy
    // stream never grows a second record for wheels, mirrors, or lights.
    for (const proxy of item.vehicle.proxies) {
      if (proxies.length / GEO_VEHICLE_PROXY_STRIDE >= GEO_VEHICLE_LIMITS.maxProxiesPerTile) break;
      const cosine = Math.cos(item.yaw), sine = Math.sin(item.yaw);
      const worldX = item.x + (proxy.x * cosine - proxy.z * sine) * item.scaleX;
      const worldZ = item.z + (proxy.x * sine + proxy.z * cosine) * item.scaleZ;
      proxies.push(
        worldX, worldZ,
        proxy.halfWidth * item.scaleX, proxy.halfDepth * item.scaleZ,
        proxy.yaw + item.yaw,
        item.groundY + proxy.bottom,
        item.groundY + proxy.top,
      );
    }
  }

  const placements = new Float32Array(placementValues);
  const proxyStream = new Float32Array(proxies);
  const bytes = placements.byteLength + proxyStream.byteLength;
  return Object.freeze({
    namespace: GDO_VEHICLE_NAMESPACE,
    placements,
    proxies: proxyStream,
    stride: GEO_VEHICLE_STRIDE,
    proxyStride: GEO_VEHICLE_PROXY_STRIDE,
    meta: Object.freeze({
      namespace: GDO_VEHICLE_NAMESPACE,
      vehicles: accepted.length,
      familyCounts: Object.freeze(countFamilies(accepted)),
      proxyCount: proxyStream.length / GEO_VEHICLE_PROXY_STRIDE,
      tests,
      bytes,
      rejected: Object.freeze(rejected),
      capEvents: Object.freeze({
        tests: testsCapped,
        placements: accepted.length >= maxPlacements,
        proxies: proxyStream.length / GEO_VEHICLE_PROXY_STRIDE >= GEO_VEHICLE_LIMITS.maxProxiesPerTile,
        bytes: bytes > GEO_VEHICLE_LIMITS.bytesPerTile,
      }),
    }),
  });
}

function countFamilies(accepted) {
  const counts = Array(GEO_VEHICLE_FAMILY_NAMES.length).fill(0);
  for (const item of accepted) counts[item.family]++;
  return counts;
}

function pickFamily(seed) {
  const roll = random01(seed ^ 0x2c1b3c6d);
  return roll < .32 ? GEO_VEHICLE_FAMILY.HATCHBACK
    : roll < .62 ? GEO_VEHICLE_FAMILY.SEDAN
      : roll < .84 ? GEO_VEHICLE_FAMILY.SUV
        : GEO_VEHICLE_FAMILY.VAN;
}
