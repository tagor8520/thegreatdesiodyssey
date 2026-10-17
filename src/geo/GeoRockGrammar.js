/**
 * `DET-06` — rocks and geology grammar (`gdo:rockGrammar:v1`).
 *
 * Research §15.5: a cluster is one hero mass, 1–3 intersecting angular
 * secondary masses, and 0–3 chips/plates that exist at near LOD only. Small
 * rocks stay visual; a gameplay-blocking cluster gets **one or two tight
 * yaw-aligned proxies around major masses only** — never the whole visual
 * cluster AABB, and never a chip. Placement is founded on the `TER-06`
 * morphology: the same `GeoTerrain` field the mesh and the collision read
 * classifies the site (plain/plateau/flank/cliff), so a rock the grammar calls
 * a cliff outcrop stands on ground the collision already refuses to walk.
 *
 * The compiler speaks the `DET-02` object IR (`GeoObjectRecipe`), so visual
 * modules and query proxies are accepted through separate fields and a small
 * box can never enlarge collision implicitly.
 */

import { featureNamespace } from '../engine/FeatureVersions.js';
import { GDO_LOW_PROFILE_BUDGETS } from '../engine/PerformanceBudget.js';
import {
  GEO_OBJECT_LOD,
  compileObjectRecipe,
  createObjectRecipe,
} from './GeoObjectRecipe.js';
import { GEO_SUPPORT_ROLE } from './GeoSupportSlots.js';
import {
  GEO_TERRAIN_DEFAULTS,
  terrainHeightAt,
  terrainSlopeRadiansAt,
} from './GeoTerrain.js';
import { GDO_GEOLOGY_CLASS, classifyGeologyPoint } from './GeoGeology.js';
import { queryWaterDomain } from './GeoWaterDomains.js';

export const GDO_ROCK_NAMESPACE = featureNamespace('rockGrammar');

/** x, z, yaw, scaleX, scaleY, scaleZ, family, stableId */
export const GEO_ROCK_STRIDE = 8;
/** centerX, centerZ, halfWidth, halfDepth, yaw, bottom, top — one major mass. */
export const GEO_ROCK_PROXY_STRIDE = 7;

export const GEO_ROCK_FAMILY = Object.freeze({
  BOULDER: 0,
  OUTCROP: 1,
  SLAB: 2,
  SCREE: 3,
});

export const GEO_ROCK_FAMILY_NAMES = Object.freeze([
  'boulder', 'outcrop', 'slab', 'scree',
]);

export const GEO_ROCK_LIMITS = Object.freeze({
  maxClustersPerTile: 24,
  maxCandidates: 96,
  maxPlacementTestsPerTile: GDO_LOW_PROFILE_BUDGETS.rockPlacementTestsPerTile,
  maxBoxesPerCluster: GDO_LOW_PROFILE_BUDGETS.rockBoxesPerCluster,
  maxModulesPerCluster: 6,
  maxMajorProxiesPerCluster: GDO_LOW_PROFILE_BUDGETS.rockMajorProxiesPerCluster,
  maxProxiesPerTile: GDO_LOW_PROFILE_BUDGETS.rockProxiesPerTile,
  // A hero smaller than this is a chip, not a mass the player can be blocked by.
  minMajorMass: .22,
  // A secondary only earns a proxy when it is a real second mass.
  majorSecondaryRatio: .55,
  // Refuse a site steeper than this so a cluster never clings to a near-vertical
  // face the drawn grid barely contains.
  maxPlacementSlope: 1.05,
  minClusterSpacing: 1.6,
  bytesPerTile: GDO_LOW_PROFILE_BUDGETS.rockBytesPerTile,
});

/**
 * Family templates. Sizes are world units at 1:10 (one unit ≈ ten metres).
 * `blocking` families may earn major-mass proxies; `scree` is the research's
 * "small rocks are visual" tier and is never solid.
 */
const FAMILIES = Object.freeze([
  Object.freeze({
    id: GEO_ROCK_FAMILY.BOULDER, name: 'boulder', blocking: true,
    hero: Object.freeze({ sizeX: .52, sizeY: .40, sizeZ: .46 }),
    secondaries: 2, plates: 1, chips: 2,
    tones: Object.freeze([.32, .30, .26]),
  }),
  Object.freeze({
    id: GEO_ROCK_FAMILY.OUTCROP, name: 'outcrop', blocking: true,
    hero: Object.freeze({ sizeX: .78, sizeY: .34, sizeZ: .38 }),
    secondaries: 3, plates: 2, chips: 1,
    tones: Object.freeze([.38, .33, .25]),
  }),
  Object.freeze({
    id: GEO_ROCK_FAMILY.SLAB, name: 'slab', blocking: true,
    hero: Object.freeze({ sizeX: .66, sizeY: .18, sizeZ: .52 }),
    secondaries: 1, plates: 2, chips: 3,
    tones: Object.freeze([.42, .38, .31]),
  }),
  Object.freeze({
    id: GEO_ROCK_FAMILY.SCREE, name: 'scree', blocking: false,
    hero: Object.freeze({ sizeX: .20, sizeY: .13, sizeZ: .18 }),
    secondaries: 2, plates: 0, chips: 3,
    tones: Object.freeze([.36, .32, .27]),
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

function channel(seed, index) {
  return random01(mix32((seed >>> 0) ^ Math.imul(index + 1, 0x9e3779b1)));
}

function random01(value) {
  return (mix32(value >>> 0) >>> 8) / 0x01000000;
}

function finitePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be finite and positive`);
  return value;
}

function toneVariation(tones, amount) {
  return tones.map(base => Math.max(.02, Math.min(.98, base * (.82 + amount * .36))));
}

function rockBox({ centerX, bottom, centerZ, sizeX, sizeY, sizeZ, yaw, color }) {
  return { centerX, bottom, centerZ, sizeX, sizeY, sizeZ, yaw, color };
}

/**
 * Compile one rock cluster from `(family, seed, scale)`. Deterministic: the
 * same triple always produces the same boxes, proxies, and diagnostics. The
 * result is a `DET-02` recipe whose `solidProxies` are tight yaw-aligned boxes
 * around major masses only.
 */
export function compileRockCluster(familyIndex, { seed = 0, scale = 1 } = {}) {
  const family = FAMILIES[familyIndex];
  if (!family) throw new RangeError(`Unknown rock family: ${familyIndex}`);
  if (!Number.isFinite(seed)) throw new TypeError('Rock cluster seed must be finite');
  finitePositive(scale, 'Rock cluster scale');

  const heroYaw = channel(seed, 0) * Math.PI * 2;
  const heroSize = {
    sizeX: family.hero.sizeX * (0.82 + channel(seed, 1) * .42) * scale,
    sizeY: family.hero.sizeY * (0.78 + channel(seed, 2) * .48) * scale,
    sizeZ: family.hero.sizeZ * (0.82 + channel(seed, 3) * .42) * scale,
  };
  const hero = rockBox({
    centerX: 0, bottom: 0, centerZ: 0,
    ...heroSize, yaw: heroYaw,
    color: toneVariation(family.tones, channel(seed, 4)),
  });

  const silhouette = [{
    id: 'hero-mass',
    minimumLod: GEO_OBJECT_LOD.FAR,
    boxes: [hero],
  }];

  const secondaryBoxes = [];
  const secondaryCount = family.secondaries > 1
    ? 1 + Math.floor(channel(seed, 5) * family.secondaries)
    : family.secondaries;
  for (let index = 0; index < secondaryCount; index++) {
    const share = .34 + channel(seed, 6 + index * 4) * .30;
    const angle = heroYaw + (channel(seed, 7 + index * 4) - .5) * 2.4;
    // Satellites intersect the hero: the cluster silhouette is one massif, not
    // a scatter of equal rocks (research §15.5).
    const reach = (hero.sizeX + hero.sizeZ) * .22;
    const sizeX = hero.sizeX * share * (1 + channel(seed, 8 + index * 4) * .3);
    const sizeZ = hero.sizeZ * share * (1 + channel(seed, 9 + index * 4) * .3);
    secondaryBoxes.push(rockBox({
      centerX: Math.cos(angle) * reach,
      bottom: hero.sizeY * channel(seed, 10 + index * 4) * .12,
      centerZ: Math.sin(angle) * reach,
      sizeX,
      sizeY: hero.sizeY * share * (.8 + channel(seed, 11 + index * 4) * .5),
      sizeZ,
      yaw: angle + channel(seed, 12 + index * 4),
      color: toneVariation(family.tones, channel(seed, 13 + index * 4)),
    }));
    if (silhouette.length < 3) {
      silhouette.push({ id: `secondary-mass-${index}`, minimumLod: GEO_OBJECT_LOD.MID, boxes: [secondaryBoxes[secondaryBoxes.length - 1]] });
    } else {
      silhouette[1].boxes.push(secondaryBoxes[secondaryBoxes.length - 1]);
    }
  }

  const plates = [];
  for (let index = 0; index < family.plates; index++) {
    plates.push(rockBox({
      centerX: (channel(seed, 20 + index) - .5) * hero.sizeX * .9,
      bottom: hero.sizeY * (.18 + channel(seed, 21 + index) * .5),
      centerZ: (channel(seed, 22 + index) - .5) * hero.sizeZ * .9,
      sizeX: hero.sizeX * (.3 + channel(seed, 23 + index) * .28),
      sizeY: .035 * scale,
      sizeZ: hero.sizeZ * (.3 + channel(seed, 24 + index) * .28),
      yaw: heroYaw + channel(seed, 25 + index) * 1.4,
      color: toneVariation(family.tones, channel(seed, 26 + index) + .18),
    }));
  }
  const chips = [];
  for (let index = 0; index < family.chips; index++) {
    const angle = channel(seed, 30 + index) * Math.PI * 2;
    const reach = (hero.sizeX + hero.sizeZ) * (.30 + channel(seed, 31 + index) * .22);
    chips.push(rockBox({
      centerX: Math.cos(angle) * reach,
      bottom: 0,
      centerZ: Math.sin(angle) * reach,
      sizeX: (.07 + channel(seed, 32 + index) * .09) * scale,
      sizeY: (.05 + channel(seed, 33 + index) * .07) * scale,
      sizeZ: (.07 + channel(seed, 34 + index) * .09) * scale,
      yaw: channel(seed, 35 + index) * Math.PI * 2,
      color: toneVariation(family.tones, channel(seed, 36 + index)),
    }));
  }

  const supportId = (mix32(seed >>> 0) % 100_000) + 1;
  const maxHalf = Math.max(hero.sizeX, hero.sizeZ) / 2 + .2;
  const recipe = createObjectRecipe({
    id: `${GDO_ROCK_NAMESPACE}:${family.name}:${supportId}`,
    owner: 'rock-grammar',
    support: {
      id: supportId,
      roleMask: GEO_SUPPORT_ROLE.GROUND_DETAIL,
      x: 0, y: 0, z: 0,
      halfWidth: maxHalf,
      halfDepth: maxHalf,
      yaw: heroYaw,
    },
    height: hero.sizeY,
    silhouette,
    surface: plates.length ? [{ id: 'strata-plates', minimumLod: GEO_OBJECT_LOD.MID, boxes: plates }] : [],
    accents: chips.length ? [{ id: 'chips', minimumLod: GEO_OBJECT_LOD.NEAR, boxes: chips }] : [],
    visualBounds: {
      minX: -maxHalf, minY: 0, minZ: -maxHalf,
      maxX: maxHalf, maxY: hero.sizeY * 1.2, maxZ: maxHalf,
    },
    // Proxies: major masses only. A chip or a strata plate can never appear
    // here, and a non-blocking family carries none at all.
    solidProxies: majorMassProxies(family, hero, secondaryBoxes),
    interactionProxies: [],
    cameraRoles: [],
  });
  const compiled = compileObjectRecipe(recipe, {
    lod: GEO_OBJECT_LOD.NEAR,
    maxModules: GEO_ROCK_LIMITS.maxModulesPerCluster,
    maxBoxes: GEO_ROCK_LIMITS.maxBoxesPerCluster,
  });
  return Object.freeze({
    namespace: GDO_ROCK_NAMESPACE,
    family: family.id,
    name: family.name,
    blocking: family.blocking,
    scale,
    recipe,
    compiled,
    proxies: recipe.solidProxies,
    diagnostics: Object.freeze({
      boxes: compiled.diagnostics.emittedBoxes,
      skippedModules: compiled.diagnostics.skippedModules,
      proxies: recipe.solidProxies.length,
    }),
  });
}

/**
 * One tight yaw-aligned box per major mass: the hero when it is genuinely a
 * mass, plus at most one secondary that is a real second mass. The result is
 * capped at `maxMajorProxiesPerCluster`, so "one/two tight proxies around major
 * masses only" is a construction rule, not a hope.
 */
function majorMassProxies(family, hero, secondaries) {
  if (!family.blocking) return [];
  const proxies = [];
  const heroIsMass = Math.max(hero.sizeX, hero.sizeZ) >= GEO_ROCK_LIMITS.minMajorMass;
  if (heroIsMass) proxies.push(massProxy('hero', hero));
  const candidates = secondaries
    .filter(box => Math.max(box.sizeX, box.sizeZ) >= GEO_ROCK_LIMITS.minMajorMass &&
      Math.max(box.sizeX, box.sizeZ) >= Math.max(hero.sizeX, hero.sizeZ) * GEO_ROCK_LIMITS.majorSecondaryRatio)
    .sort((first, second) => (second.sizeX * second.sizeZ) - (first.sizeX * first.sizeZ) ||
      first.centerX - second.centerX || first.centerZ - second.centerZ);
  for (const box of candidates) {
    if (proxies.length >= GEO_ROCK_LIMITS.maxMajorProxiesPerCluster) break;
    proxies.push(massProxy('secondary', box));
  }
  return proxies;
}

function massProxy(id, box) {
  return {
    id: `rock-${id}`,
    shape: 'obb',
    x: box.centerX,
    z: box.centerZ,
    halfWidth: box.sizeX / 2,
    halfDepth: box.sizeZ / 2,
    yaw: box.yaw ?? 0,
    bottom: box.bottom,
    top: box.bottom + box.sizeY,
  };
}

/** Canonical family recipes: what the render pools compile once and instance. */
export function rockClusterRecipes() {
  return Object.freeze(FAMILIES.map(family => Object.freeze({
    family: family.id,
    name: family.name,
    blocking: family.blocking,
    compiled: compileRockCluster(family.id, { seed: 0x5eed01, scale: 1 }),
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

/** Accept road records as `[x1,z1,x2,z2,radius,level]` segments or AABB arrays. */
function normalizeRoads(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (Array.isArray(entry) && entry.length >= 6 && entry[5] === 0) {
      const [x1, z1, x2, z2, radius = 0] = entry;
      if (![x1, z1, x2, z2].every(Number.isFinite)) continue;
      out.push([
        Math.min(x1, x2) - radius, Math.min(z1, z2) - radius,
        Math.max(x1, x2) + radius, Math.max(z1, z2) + radius,
      ]);
    } else if (Array.isArray(entry) && entry.length >= 4) {
      out.push(entry);
    }
    if (out.length >= 2_048) break;
  }
  return out;
}

function hashText(value, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return mix32(hash);
}

/**
 * Scatter clusters over the tile from the one shared height/morphology field.
 *
 * The pass is bounded twice over (candidates and placement tests) and refuses a
 * site inside a building, a road carriageway, mapped water, or an already
 * accepted cluster's spacing ring. Each accepted cluster contributes one
 * placement record and — for blocking families above the major-mass threshold —
 * its tight major-mass proxies in world space.
 */
export function placeRockClusters({
  tileMinX = 0,
  tileMinZ = 0,
  tileSize = 1,
  terrainSeed = 0,
  seed = 0,
  obstacles = {},
  waterDomain = null,
  landKindAt = null,
  maxClusters = GEO_ROCK_LIMITS.maxClustersPerTile,
} = {}) {
  if (!Number.isFinite(tileMinX) || !Number.isFinite(tileMinZ) || !(tileSize > 0)) {
    throw new TypeError('Rock placement requires finite tile bounds');
  }
  if (!Number.isFinite(terrainSeed) || !Number.isFinite(seed)) {
    throw new TypeError('Rock placement requires finite seeds');
  }
  const buildings = normalizeAabbs(obstacles.buildings);
  const roads = normalizeRoads(obstacles.roads);
  const cells = 8;
  const accepted = [];
  const proxies = [];
  let tests = 0, testsCapped = false;
  let rejected = { water: 0, building: 0, road: 0, spacing: 0, slope: 0, geology: 0 };
  let geologyCounts = { plain: 0, plateau: 0, flank: 0, cliff: 0 };

  for (let row = 0; row < cells && accepted.length < maxClusters; row++) {
    for (let column = 0; column < cells && accepted.length < maxClusters; column++) {
      if (tests >= GEO_ROCK_LIMITS.maxPlacementTestsPerTile) { testsCapped = true; break; }
      const localSeed = hashText(`${GDO_ROCK_NAMESPACE}:${seed}:${row}:${column}`);
      const x = tileMinX + (column + .2 + random01(localSeed) * .6) / cells * tileSize;
      const z = tileMinZ + (row + .2 + random01(localSeed ^ 0x27d4eb2f) * .6) / cells * tileSize;
      tests++;

      // The morphology decision comes from the one shared field: the class is
      // the collision's own slope test (`GeoGeology`), so placement and terrain
      // agree by construction.
      const geologyName = classifyGeologyPoint(x, z, terrainSeed);
      const slope = terrainSlopeRadiansAt(x, z, terrainSeed, GEO_TERRAIN_DEFAULTS.normalSample);
      if (slope > GEO_ROCK_LIMITS.maxPlacementSlope) { rejected.slope++; continue; }
      const affinity = {
        [GDO_GEOLOGY_CLASS.CLIFF]: .82,
        [GDO_GEOLOGY_CLASS.FLANK]: .62,
        [GDO_GEOLOGY_CLASS.PLATEAU]: .38,
        [GDO_GEOLOGY_CLASS.PLAIN]: .16,
      }[geologyName] ?? .16;
      const kind = typeof landKindAt === 'function' ? (landKindAt(x, z) ?? '') : '';
      const rockyKind = ['rock', 'bare_rock', 'scree', 'shingle', 'sand', 'beach', 'cliff', 'stone']
        .some(name => kind.includes(name)) ? .30 : 0;
      const roll = random01(localSeed ^ 0x85ebca6b);
      if (roll > affinity + rockyKind) { rejected.geology++; continue; }

      const family = pickFamily(geologyName, rockyKind > 0, localSeed);
      const scale = .78 + random01(localSeed ^ 0xc2b2ae35) * .64;
      const cluster = compileRockCluster(family, {
        seed: (localSeed ^ 0x51f15e) >>> 0,
        scale,
      });
      const radius = Math.max(cluster.recipe.support.halfWidth, cluster.recipe.support.halfDepth) * scale;

      if (waterDomain && queryWaterDomain(waterDomain, x, z, {}).waterDistance <= radius + .12) {
        rejected.water++; continue;
      }
      if (buildings.some(box => pointInAabb(x, z, [
        box[0] - radius, box[1] - radius, box[2] + radius, box[3] + radius,
      ]))) { rejected.building++; continue; }
      if (roads.some(box => pointInAabb(x, z, [
        box[0] - radius, box[1] - radius, box[2] + radius, box[3] + radius,
      ]))) { rejected.road++; continue; }

      const spacing = GEO_ROCK_LIMITS.minClusterSpacing + radius;
      if (accepted.some(other =>
        (other.x - x) ** 2 + (other.z - z) ** 2 < (spacing + other.radius) ** 2)) {
        rejected.spacing++; continue;
      }

      const yaw = random01(localSeed ^ 0x165667b1) * Math.PI * 2;
      const groundY = terrainHeightAt(x, z, terrainSeed);
      const stableId = (localSeed >>> 8) & 0x00ffffff;
      accepted.push({
        x, z, yaw, scaleX: scale, scaleY: scale, scaleZ: scale,
        family: cluster.family, stableId, radius, groundY, cluster,
      });
      geologyCounts[geologyName] = (geologyCounts[geologyName] ?? 0) + 1;
    }
  }

  accepted.sort((first, second) => first.family - second.family || first.stableId - second.stableId ||
    first.x - second.x || first.z - second.z);
  const placementValues = [];
  for (const item of accepted) {
    placementValues.push(item.x, item.z, item.yaw, item.scaleX, item.scaleY, item.scaleZ,
      item.family, item.stableId);
    // World-space major-mass proxies: the recipe's local OBBs rotated by the
    // cluster yaw and scaled. Chips and plates contribute nothing here.
    for (const proxy of item.cluster.proxies) {
      if (proxies.length / GEO_ROCK_PROXY_STRIDE >= GEO_ROCK_LIMITS.maxProxiesPerTile) break;
      const cosine = Math.cos(item.yaw), sine = Math.sin(item.yaw);
      const worldX = item.x + (proxy.x * cosine - proxy.z * sine) * item.scaleX;
      const worldZ = item.z + (proxy.x * sine + proxy.z * cosine) * item.scaleZ;
      proxies.push(
        worldX, worldZ,
        proxy.halfWidth * item.scaleX, proxy.halfDepth * item.scaleZ,
        proxy.yaw + item.yaw,
        item.groundY + proxy.bottom * item.scaleY,
        item.groundY + proxy.top * item.scaleY,
      );
    }
  }

  const placements = new Float32Array(placementValues);
  const proxyStream = new Float32Array(proxies);
  const bytes = placements.byteLength + proxyStream.byteLength;
  return Object.freeze({
    namespace: GDO_ROCK_NAMESPACE,
    placements,
    proxies: proxyStream,
    stride: GEO_ROCK_STRIDE,
    proxyStride: GEO_ROCK_PROXY_STRIDE,
    meta: Object.freeze({
      namespace: GDO_ROCK_NAMESPACE,
      clusters: accepted.length,
      familyCounts: Object.freeze(countFamilies(accepted)),
      proxyCount: proxyStream.length / GEO_ROCK_PROXY_STRIDE,
      tests,
      bytes,
      geologyCounts: Object.freeze(geologyCounts),
      rejected: Object.freeze(rejected),
      capEvents: Object.freeze({
        tests: testsCapped,
        clusters: accepted.length >= maxClusters,
        proxies: proxyStream.length / GEO_ROCK_PROXY_STRIDE >= GEO_ROCK_LIMITS.maxProxiesPerTile,
        bytes: bytes > GEO_ROCK_LIMITS.bytesPerTile,
      }),
    }),
  });
}

function countFamilies(accepted) {
  const counts = Array(GEO_ROCK_FAMILY_NAMES.length).fill(0);
  for (const item of accepted) counts[item.family]++;
  return counts;
}

function pickFamily(geologyName, rocky, seed) {
  const roll = random01(seed ^ 0x51f15e);
  if (geologyName === GDO_GEOLOGY_CLASS.CLIFF) return roll < .5 ? GEO_ROCK_FAMILY.OUTCROP : GEO_ROCK_FAMILY.BOULDER;
  if (geologyName === GDO_GEOLOGY_CLASS.FLANK) return roll < .36 ? GEO_ROCK_FAMILY.OUTCROP : roll < .74 ? GEO_ROCK_FAMILY.BOULDER : GEO_ROCK_FAMILY.SLAB;
  if (geologyName === GDO_GEOLOGY_CLASS.PLATEAU) return roll < .46 ? GEO_ROCK_FAMILY.SLAB : roll < .78 ? GEO_ROCK_FAMILY.BOULDER : GEO_ROCK_FAMILY.SCREE;
  return rocky
    ? (roll < .58 ? GEO_ROCK_FAMILY.SCREE : GEO_ROCK_FAMILY.SLAB)
    : (roll < .72 ? GEO_ROCK_FAMILY.SCREE : GEO_ROCK_FAMILY.BOULDER);
}
