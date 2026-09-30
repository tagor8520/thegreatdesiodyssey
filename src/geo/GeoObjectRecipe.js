import { GEO_SUPPORT_ROLE } from './GeoSupportSlots.js';

export const GEO_OBJECT_ROLE = Object.freeze({
  SILHOUETTE: 'silhouette',
  SURFACE: 'surface',
  ACCENT: 'accent',
});

export const GEO_OBJECT_LOD = Object.freeze({ FAR: 'far', MID: 'mid', NEAR: 'near' });
const LOD_RANK = Object.freeze({ far: 0, mid: 1, near: 2 });

function finitePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be finite and positive`);
  return value;
}

function normalizeBox(box, moduleId) {
  if (!box || ![box.centerX, box.bottom, box.centerZ].every(Number.isFinite)) {
    throw new TypeError(`Object module ${moduleId} has an invalid box position`);
  }
  const color = Array.isArray(box.color) && box.color.length === 3 && box.color.every(Number.isFinite)
    ? Object.freeze([...box.color])
    : null;
  if (!color) throw new TypeError(`Object module ${moduleId} requires a linear RGB color`);
  const yaw = box.yaw ?? 0;
  if (!Number.isFinite(yaw)) throw new TypeError(`Object module ${moduleId} has an invalid box yaw`);
  return Object.freeze({
    centerX: box.centerX,
    bottom: box.bottom,
    centerZ: box.centerZ,
    sizeX: finitePositive(box.sizeX, 'box.sizeX'),
    sizeY: finitePositive(box.sizeY, 'box.sizeY'),
    sizeZ: finitePositive(box.sizeZ, 'box.sizeZ'),
    yaw,
    color,
  });
}

function normalizeModule(module, role, index) {
  if (!module || typeof module.id !== 'string' || !module.id) throw new TypeError(`Invalid ${role} module ID`);
  const minimumLod = module.minimumLod ?? (role === GEO_OBJECT_ROLE.SILHOUETTE ? GEO_OBJECT_LOD.FAR
    : role === GEO_OBJECT_ROLE.SURFACE ? GEO_OBJECT_LOD.MID : GEO_OBJECT_LOD.NEAR);
  if (!Object.hasOwn(LOD_RANK, minimumLod)) throw new RangeError(`Invalid object module LOD: ${minimumLod}`);
  const boxes = (module.boxes ?? []).map(box => normalizeBox(box, module.id));
  if (!boxes.length && typeof module.material !== 'string') {
    throw new TypeError(`Object module ${module.id} needs boxes or a material assignment`);
  }
  return Object.freeze({
    id: module.id,
    role,
    order: Number.isFinite(module.order) ? module.order : index,
    minimumLod,
    boxes: Object.freeze(boxes),
    material: typeof module.material === 'string' ? module.material : null,
  });
}

function normalizeProxy(proxy, kind, index) {
  if (!proxy || typeof proxy !== 'object') throw new TypeError(`Invalid ${kind} proxy`);
  return Object.freeze({ ...proxy, id: String(proxy.id ?? `${kind}:${index}`), role: kind });
}

/**
 * Immutable object IR. Visual modules and query proxies are accepted through
 * separate fields so adding a small box can never enlarge collision implicitly.
 */
export function createObjectRecipe({
  id,
  owner,
  support,
  authoritativeFootprint = null,
  height = 0,
  silhouette = [],
  surface = [],
  accents = [],
  visualBounds = null,
  solidProxies = [],
  interactionProxies = [],
  cameraRoles = [],
} = {}) {
  if (typeof id !== 'string' || !id || typeof owner !== 'string' || !owner) {
    throw new TypeError('Object recipes require stable id and owner strings');
  }
  if (!support || !Number.isInteger(support.id) || support.id <= 0 || !Number.isInteger(support.roleMask) || support.roleMask <= 0) {
    throw new TypeError('Object recipes require a declared support slot');
  }
  if (!Number.isFinite(height) || height < 0) throw new RangeError('Object recipe height must be finite and non-negative');
  const normalizedSupport = Object.freeze({
    id: support.id,
    roleMask: support.roleMask,
    x: support.x,
    y: support.y,
    z: support.z,
    halfWidth: support.halfWidth,
    halfDepth: support.halfDepth,
    yaw: support.yaw ?? 0,
  });
  if (![normalizedSupport.x, normalizedSupport.y, normalizedSupport.z, normalizedSupport.halfWidth,
    normalizedSupport.halfDepth, normalizedSupport.yaw].every(Number.isFinite) ||
    normalizedSupport.halfWidth <= 0 || normalizedSupport.halfDepth <= 0) {
    throw new TypeError('Object recipe support geometry is invalid');
  }
  const recipe = {
    id,
    owner,
    support: normalizedSupport,
    authoritativeFootprint,
    height,
    silhouette: Object.freeze(silhouette.map((module, index) => normalizeModule(module, GEO_OBJECT_ROLE.SILHOUETTE, index))),
    surface: Object.freeze(surface.map((module, index) => normalizeModule(module, GEO_OBJECT_ROLE.SURFACE, index))),
    accents: Object.freeze(accents.map((module, index) => normalizeModule(module, GEO_OBJECT_ROLE.ACCENT, index))),
    visualBounds: visualBounds ? Object.freeze({ ...visualBounds }) : null,
    solidProxies: Object.freeze(solidProxies.map((proxy, index) => normalizeProxy(proxy, 'solid', index))),
    interactionProxies: Object.freeze(interactionProxies.map((proxy, index) => normalizeProxy(proxy, 'interaction', index))),
    cameraRoles: Object.freeze(cameraRoles.map((proxy, index) => normalizeProxy(proxy, 'camera', index))),
  };
  return Object.freeze(recipe);
}

export function compileObjectRecipe(recipe, {
  lod = GEO_OBJECT_LOD.NEAR,
  maxModules = 12,
  maxBoxes = 20,
} = {}) {
  if (!recipe || !Object.hasOwn(LOD_RANK, lod)) throw new RangeError(`Invalid object recipe LOD: ${lod}`);
  if (!Number.isInteger(maxModules) || maxModules < 0 || !Number.isInteger(maxBoxes) || maxBoxes < 0) {
    throw new RangeError('Object recipe budgets must be non-negative integers');
  }
  const roleRank = { silhouette: 0, surface: 1, accent: 2 };
  const modules = [...recipe.silhouette, ...recipe.surface, ...recipe.accents]
    .filter(module => LOD_RANK[lod] >= LOD_RANK[module.minimumLod])
    .sort((first, second) => roleRank[first.role] - roleRank[second.role] ||
      first.order - second.order || first.id.localeCompare(second.id));
  const visualBoxes = [], materials = [];
  let emittedModules = 0, skippedModules = 0;
  for (const module of modules) {
    if (emittedModules >= maxModules || visualBoxes.length + module.boxes.length > maxBoxes) {
      skippedModules++;
      continue;
    }
    for (const box of module.boxes) visualBoxes.push(Object.freeze({ ...box, moduleId: module.id, role: module.role }));
    if (module.material) materials.push(Object.freeze({ moduleId: module.id, role: module.role, material: module.material }));
    emittedModules++;
  }
  return Object.freeze({
    recipeId: recipe.id,
    owner: recipe.owner,
    support: recipe.support,
    visualBoxes: Object.freeze(visualBoxes),
    materials: Object.freeze(materials),
    // Proxies are copied only from explicit recipe fields, never visual bounds.
    solidProxies: recipe.solidProxies,
    interactionProxies: recipe.interactionProxies,
    cameraRoles: recipe.cameraRoles,
    diagnostics: Object.freeze({
      attemptedModules: modules.length,
      emittedModules,
      skippedModules,
      emittedBoxes: visualBoxes.length,
      boxBudget: maxBoxes,
    }),
  });
}

export function createRoofTankRecipe({ owner, support, height, color }) {
  if ((support?.roleMask & GEO_SUPPORT_ROLE.ROOF_DETAIL) === 0) {
    throw new RangeError('Roof tanks require a roof-detail support slot');
  }
  const size = Math.min(support.halfWidth, support.halfDepth) * 2;
  return createObjectRecipe({
    id: `${owner}:roof-tank:${support.id}`,
    owner,
    support,
    authoritativeFootprint: 'mapped-building-rings',
    height,
    silhouette: [{
      id: 'tank-mass',
      minimumLod: GEO_OBJECT_LOD.FAR,
      boxes: [{
        centerX: support.x,
        bottom: support.y + .018,
        centerZ: support.z,
        sizeX: size,
        sizeY: height,
        sizeZ: size,
        color,
      }],
    }],
    visualBounds: {
      minX: support.x - size / 2,
      minY: support.y + .018,
      minZ: support.z - size / 2,
      maxX: support.x + size / 2,
      maxY: support.y + .018 + height,
      maxZ: support.z + size / 2,
    },
    solidProxies: [],
    interactionProxies: [],
    cameraRoles: [],
  });
}
