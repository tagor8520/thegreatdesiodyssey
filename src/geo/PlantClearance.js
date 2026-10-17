import { featureNamespace } from '../engine/FeatureVersions.js';
import { GDO_PLANT_FAMILY_RECIPES } from '../engine/PlantGrammar.js';
import { queryTerrainSupport } from './GeoTerrain.js';
import { GEO_ECOLOGICAL_DOMAIN, queryWaterDomain } from './GeoWaterDomains.js';

export const GDO_VEGETATION_CLEARANCE_NAMESPACE = featureNamespace('vegetationClearance');
export const GEO_PLANT_CLEARANCE_SAMPLES = 16;
export const GEO_PLANT_CLEARANCE_STRIDE = 4;
export const GEO_DEFAULT_CROWN_ADAPTATION = Object.freeze([1, 1, 0, 0]);

export const GEO_PLANT_TYPE_FAMILIES = Object.freeze({
  0: 'broadleaf',
  1: 'palm',
  2: 'shrub',
  5: 'herb',
  8: 'herb',
  9: 'grass',
  12: 'bamboo',
});

/** Matches the normalized grammar-to-world placement scale in GeoWorld. */
export const GEO_PLANT_PLACEMENT_SCALE = Object.freeze({
  0: .65,
  1: .55,
  2: .65,
  5: .48,
  8: .55,
  9: .80,
  12: .58,
});

const TYPE_ROLE = Object.freeze({
  0: 'canopy-tree',
  1: 'canopy-tree',
  2: 'shrub',
  5: 'herb',
  8: 'ground-cover',
  9: 'grass',
  12: 'canopy-tree',
});

const GROUND_LAND_KINDS = Object.freeze([
  'forest', 'wood', 'park', 'garden', 'grass', 'grassland', 'meadow', 'farmland',
  'farmyard', 'orchard', 'scrub', 'heath', 'wetland', 'swamp', 'marsh', 'sand',
  'beach', 'desert', 'cemetery',
]);

const DISALLOWED_GROUND_LAND_KINDS = Object.freeze([
  'industrial', 'commercial', 'residential', 'retail', 'construction', 'railway', 'runway',
]);
const ANCHOR_ORGANS = Object.freeze(['trunk', 'stem', 'culm']);
const ROOT_ORGANS = Object.freeze(['root']);
const ADAPTED_ORGANS = Object.freeze(['branch', 'frond', 'blade', 'leaf', 'flower']);

function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }

function pointInRing(x, z, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, zi] = ring[index], [xj, zj] = ring[previous];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(x, z, rings) {
  return Boolean(rings.length && pointInRing(x, z, rings[0]) &&
    !rings.slice(1).some(ring => pointInRing(x, z, ring)));
}

function nearestOnSegment(x, z, x1, z1, x2, z2, out) {
  const dx = x2 - x1, dz = z2 - z1;
  const lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared ? clamp(((x - x1) * dx + (z - z1) * dz) / lengthSquared, 0, 1) : 0;
  const nearestX = x1 + dx * amount, nearestZ = z1 + dz * amount;
  const distanceSquared = (x - nearestX) ** 2 + (z - nearestZ) ** 2;
  if (distanceSquared < out.distanceSquared) {
    out.distanceSquared = distanceSquared;
    out.x = nearestX;
    out.z = nearestZ;
  }
}

function nearestOnRings(x, z, rings, out = { distanceSquared: Infinity, x, z }) {
  for (const ring of rings) for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    nearestOnSegment(x, z,
      ring[previous][0], ring[previous][1], ring[index][0], ring[index][1], out);
  }
  return out;
}

function distanceToSegmentSquared(x, z, segment) {
  const x1 = segment[0], z1 = segment[1], dx = segment[2] - x1, dz = segment[3] - z1;
  const lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared ? clamp(((x - x1) * dx + (z - z1) * dz) / lengthSquared, 0, 1) : 0;
  const offsetX = x - (x1 + dx * amount), offsetZ = z - (z1 + dz * amount);
  return offsetX * offsetX + offsetZ * offsetZ;
}

function buildingWithin(building, x, z, radius) {
  if (x < building.minX - radius || x > building.maxX + radius ||
      z < building.minZ - radius || z > building.maxZ + radius) return false;
  if (pointInPolygon(x, z, building.rings)) return true;
  const limit = radius * radius;
  return building.rings.some(ring => {
    const nearest = nearestOnRings(x, z, [ring]);
    return nearest.distanceSquared <= limit;
  });
}

function pointInBuildingMass(buildings, x, z) {
  for (const building of buildings) {
    if (x < building.minX || x > building.maxX || z < building.minZ || z > building.maxZ) continue;
    if (pointInPolygon(x, z, building.rings)) return true;
  }
  return false;
}

function routeWithin(roads, x, z, radius) {
  return roads.some(segment => segment[5] === 0 &&
    distanceToSegmentSquared(x, z, segment) <= (segment[4] + radius) ** 2);
}

function landKindAllowsGroundCover(kind) {
  if (!kind) return true;
  const normalized = String(kind).toLowerCase();
  if (DISALLOWED_GROUND_LAND_KINDS.some(value => normalized.includes(value))) return false;
  return GROUND_LAND_KINDS.some(value => normalized.includes(value));
}

export function plantClearanceProfile(type, sourceScale = 1) {
  const family = GEO_PLANT_TYPE_FAMILIES[type];
  const recipe = GDO_PLANT_FAMILY_RECIPES[family];
  const placementScale = GEO_PLANT_PLACEMENT_SCALE[type];
  if (!recipe || !placementScale || !Number.isFinite(sourceScale) || sourceScale <= 0) return null;
  const worldScale = placementScale * sourceScale;
  const rootRadius = recipe.maxRoots > 0
    ? Math.max(recipe.trunkRadius * 1.6, recipe.envelope.rootDepth * 1.7) * worldScale
    : recipe.trunkRadius * worldScale;
  return Object.freeze({
    namespace: GDO_VEGETATION_CLEARANCE_NAMESPACE,
    type,
    family,
    role: TYPE_ROLE[type],
    worldScale,
    baseRadius: recipe.trunkRadius * worldScale,
    rootRadius,
    rootDepth: recipe.envelope.rootDepth * worldScale,
    crownRadius: recipe.envelope.radius * worldScale,
    routeMargin: TYPE_ROLE[type] === 'ground-cover' || TYPE_ROLE[type] === 'grass' ? .015 : .035,
    maximumSlope: TYPE_ROLE[type] === 'canopy-tree' ? .78 : TYPE_ROLE[type] === 'shrub' ? .88 : 1.0,
    anchorOrgans: ANCHOR_ORGANS,
    rootOrgans: ROOT_ORGANS,
    adaptedOrgans: ADAPTED_ORGANS,
    crownMayOverhangRouteVerge: true,
    crownMayOverhangGroundCover: true,
    solid: false,
  });
}

export function createPlantClearanceDiagnostics() {
  return {
    namespace: GDO_VEGETATION_CLEARANCE_NAMESPACE,
    roles: {},
    reasons: {},
    candidates: 0,
    accepted: 0,
    rejected: 0,
    adapted: 0,
    obstacleSamples: { total: 0, maximumPerCandidate: 0, limitPerCandidate: GEO_PLANT_CLEARANCE_SAMPLES },
    capEvents: {},
  };
}

function recordDiagnostics(diagnostics, result) {
  if (!diagnostics) return;
  diagnostics.candidates++;
  diagnostics[result.accepted ? 'accepted' : 'rejected']++;
  diagnostics.adapted += Number(result.adapted);
  diagnostics.reasons[result.reason] = (diagnostics.reasons[result.reason] || 0) + 1;
  diagnostics.obstacleSamples.total += result.samples.tested;
  diagnostics.obstacleSamples.maximumPerCandidate = Math.max(
    diagnostics.obstacleSamples.maximumPerCandidate, result.samples.tested,
  );
  const role = diagnostics.roles[result.profile.role] ??= {
    candidates: 0, accepted: 0, rejected: 0, adapted: 0,
    declaredExtents: {
      minimumBaseRadius: Infinity, maximumBaseRadius: 0,
      minimumRootRadius: Infinity, maximumRootRadius: 0,
      minimumCrownRadius: Infinity, maximumCrownRadius: 0,
    },
  };
  role.candidates++;
  role[result.accepted ? 'accepted' : 'rejected']++;
  role.adapted += Number(result.adapted);
  const extents = role.declaredExtents;
  extents.minimumBaseRadius = Math.min(extents.minimumBaseRadius, result.profile.baseRadius);
  extents.maximumBaseRadius = Math.max(extents.maximumBaseRadius, result.profile.baseRadius);
  extents.minimumRootRadius = Math.min(extents.minimumRootRadius, result.profile.rootRadius);
  extents.maximumRootRadius = Math.max(extents.maximumRootRadius, result.profile.rootRadius);
  extents.minimumCrownRadius = Math.min(extents.minimumCrownRadius, result.profile.crownRadius);
  extents.maximumCrownRadius = Math.max(extents.maximumCrownRadius, result.profile.crownRadius);
}

function rejected(profile, reason, support, tested = 0, blocked = 0) {
  return {
    accepted: false,
    adapted: false,
    reason,
    profile,
    support,
    adaptation: GEO_DEFAULT_CROWN_ADAPTATION,
    samples: { tested, blocked },
  };
}

function transformedCrownPoint(x, z, radius, yaw, adaptation, angle) {
  const localX = Math.cos(angle) * radius * adaptation[0] + adaptation[2];
  const localZ = Math.sin(angle) * radius * adaptation[1] + adaptation[3];
  const cosine = Math.cos(yaw), sine = Math.sin(yaw);
  return [x + localX * cosine + localZ * sine, z - localX * sine + localZ * cosine];
}

function adaptationClearsBuildings(buildings, x, z, radius, yaw, adaptation) {
  let blocked = 0;
  for (let sample = 0; sample < GEO_PLANT_CLEARANCE_SAMPLES; sample++) {
    const inner = sample % 2;
    const ringRadius = radius * (inner ? .56 : 1);
    const angle = Math.floor(sample / 2) / (GEO_PLANT_CLEARANCE_SAMPLES / 2) * Math.PI * 2 + inner * .17;
    const point = transformedCrownPoint(x, z, ringRadius, yaw, adaptation, angle);
    blocked += Number(pointInBuildingMass(buildings, point[0], point[1]));
  }
  return blocked;
}

function crownAdaptation(profile, buildings, x, z, yaw) {
  let nearest = null;
  for (const building of buildings) {
    if (!buildingWithin(building, x, z, profile.crownRadius)) continue;
    const candidate = nearestOnRings(x, z, building.rings);
    if (!nearest || candidate.distanceSquared < nearest.distanceSquared) nearest = candidate;
  }
  if (!nearest) return { adaptation: GEO_DEFAULT_CROWN_ADAPTATION, adapted: false, blocked: 0, tested: 0 };

  const distance = Math.sqrt(nearest.distanceSquared);
  const nearRatio = (distance - Math.max(.008, profile.baseRadius * .12)) / profile.crownRadius;
  if (nearRatio < .38) return {
    adaptation: null, adapted: false, blocked: GEO_PLANT_CLEARANCE_SAMPLES, tested: GEO_PLANT_CLEARANCE_SAMPLES,
  };
  const worldDirectionX = (nearest.x - x) / (distance || 1);
  const worldDirectionZ = (nearest.z - z) / (distance || 1);
  const cosine = Math.cos(yaw), sine = Math.sin(yaw);
  const localDirectionX = worldDirectionX * cosine - worldDirectionZ * sine;
  const localDirectionZ = worldDirectionX * sine + worldDirectionZ * cosine;
  const shiftRatio = Math.min(.18, Math.max(.04, (1 - nearRatio) * .30));
  const alongScale = clamp(nearRatio + shiftRatio, .56, 1 - shiftRatio);
  const crossScale = 1 - shiftRatio;
  const scaleX = alongScale + (crossScale - alongScale) * Math.abs(localDirectionZ);
  const scaleZ = alongScale + (crossScale - alongScale) * Math.abs(localDirectionX);
  // Shift values are normalized grammar units because the instance matrix later
  // applies worldScale to both geometry and adaptation.
  const shiftLocal = shiftRatio * profile.crownRadius / profile.worldScale;
  let adaptation = [
    scaleX,
    scaleZ,
    -localDirectionX * shiftLocal,
    -localDirectionZ * shiftLocal,
  ];
  const blocked = adaptationClearsBuildings(buildings, x, z, profile.crownRadius, yaw, [
    adaptation[0], adaptation[1], adaptation[2] * profile.worldScale, adaptation[3] * profile.worldScale,
  ]);
  return {
    adaptation: blocked ? null : Object.freeze(adaptation),
    adapted: !blocked,
    blocked,
    tested: GEO_PLANT_CLEARANCE_SAMPLES,
  };
}

/**
 * Role-specific, bounded vegetation acceptance. Building checks use exact rings;
 * only crown/branch geometry is adapted, while anchors and roots never move.
 */
export function evaluatePlantClearance({
  type,
  sourceScale,
  x,
  z,
  yaw = 0,
  obstacles,
  waterDomain,
  terrainSeed = 0,
  mappedLandKind = '',
  diagnostics = null,
} = {}) {
  const profile = plantClearanceProfile(type, sourceScale);
  if (!profile || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw) ||
      !obstacles || !Array.isArray(obstacles.buildings) || !Array.isArray(obstacles.roads) || !waterDomain) {
    throw new TypeError('A plant type, finite transform, obstacles and water domain are required');
  }
  const support = queryTerrainSupport(x, z, terrainSeed, {});
  const water = queryWaterDomain(waterDomain, x, z, {});
  support.ecologicalDomain = water.kind;
  support.waterDistance = water.waterDistance;
  support.mappedLandKind = mappedLandKind || 'unmapped-ground';

  let result;
  if (profile.role === 'ground-cover' || profile.role === 'grass') {
    if (!landKindAllowsGroundCover(mappedLandKind)) result = rejected(profile, 'mapped-land-kind', support);
  }
  if (!result && support.slopeRadians > profile.maximumSlope) result = rejected(profile, 'ground-slope', support);
  if (!result && !water.groundSupport) result = rejected(profile, 'water-support', support);
  if (!result && water.waterDistance <= profile.baseRadius) result = rejected(profile, 'base-water-clearance', support);
  if (!result && obstacles.buildings.some(building => buildingWithin(building, x, z, profile.baseRadius))) {
    result = rejected(profile, 'base-building-ring', support);
  }
  if (!result && routeWithin(obstacles.roads, x, z, profile.baseRadius + profile.routeMargin)) {
    result = rejected(profile, 'base-route-reservation', support);
  }
  if (!result && profile.rootRadius > profile.baseRadius + 1e-7 &&
      obstacles.buildings.some(building => buildingWithin(building, x, z, profile.rootRadius))) {
    result = rejected(profile, 'root-building-ring', support);
  }
  if (!result && profile.rootRadius > profile.baseRadius + 1e-7 &&
      routeWithin(obstacles.roads, x, z, profile.rootRadius)) {
    result = rejected(profile, 'root-route-reservation', support);
  }
  if (!result && profile.rootRadius > profile.baseRadius + 1e-7 && water.waterDistance <= profile.rootRadius) {
    result = rejected(profile, 'root-water-support', support);
  }
  if (!result) {
    const crown = crownAdaptation(profile, obstacles.buildings, x, z, yaw);
    result = crown.adaptation ? {
      accepted: true,
      adapted: crown.adapted,
      reason: crown.adapted ? 'accepted-crown-adapted' : 'accepted',
      profile,
      support,
      adaptation: crown.adaptation,
      samples: { tested: crown.tested, blocked: crown.blocked },
    } : rejected(profile, 'crown-building-mass', support, crown.tested, crown.blocked);
  }
  recordDiagnostics(diagnostics, result);
  return result;
}

export function finalizePlantClearanceDiagnostics(diagnostics, capEvents = {}) {
  if (!diagnostics || diagnostics.namespace !== GDO_VEGETATION_CLEARANCE_NAMESPACE) {
    throw new TypeError('Versioned plant-clearance diagnostics required');
  }
  diagnostics.capEvents = Object.freeze({ ...capEvents });
  for (const role of Object.values(diagnostics.roles)) {
    role.declaredExtents = Object.freeze({ ...role.declaredExtents });
    Object.freeze(role);
  }
  diagnostics.roles = Object.freeze({ ...diagnostics.roles });
  diagnostics.reasons = Object.freeze({ ...diagnostics.reasons });
  diagnostics.obstacleSamples = Object.freeze({ ...diagnostics.obstacleSamples });
  return Object.freeze(diagnostics);
}

export function ecologicalDomainName(kind) {
  return Object.keys(GEO_ECOLOGICAL_DOMAIN).find(name => GEO_ECOLOGICAL_DOMAIN[name] === kind)?.toLowerCase() ?? 'unknown';
}
