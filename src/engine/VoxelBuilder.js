import * as THREE from 'three';
import { compileCollectibleRecipe } from './RecipeCompiler.js';

const materialCache = new Map();

/**
 * Returns a cached MeshLambertMaterial for the given hex color.
 * @param {string} hexColor - e.g. "#FF5500"
 * @returns {THREE.MeshLambertMaterial}
 */
function getMaterial(hexColor) {
  if (!materialCache.has(hexColor)) {
    materialCache.set(
      hexColor,
      new THREE.MeshLambertMaterial({ color: new THREE.Color(hexColor) })
    );
  }
  return materialCache.get(hexColor);
}

/**
 * `CNT-02`: a compiled module list is the one place voxel layout arithmetic
 * lives. This adapter only turns compiled modules into `three` objects, so a
 * contributor never writes layout code — and a content pack never needs a
 * hand-written builder.
 *
 * @param {object} compiled - result of `compileCollectibleRecipe`
 * @param {object} [options]
 * @returns {THREE.Group}
 */
export function buildModuleGroup(compiled, { scale = compiled?.scale ?? .2, shadow = true } = {}) {
  if (!compiled || !Array.isArray(compiled.modules)) {
    throw new TypeError('Module group needs a compiled recipe');
  }
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(1, 1, 1);
  for (const entry of compiled.modules) {
    const mesh = new THREE.Mesh(geo, getMaterial(entry.color ?? '#ffffff'));
    mesh.position.set(entry.x, entry.y, entry.z);
    // Compiled sizes are already world-space metres, so this is exact for both
    // the uniform-voxel collectible path and mixed-size landmark modules.
    mesh.scale.set(entry.sizeX, entry.sizeY, entry.sizeZ);
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    mesh.name = entry.id;
    group.add(mesh);
  }
  return group;
}

/**
 * Builds a composite Three.js Group from an array of voxel descriptors.
 *
 * Since `CNT-02` this is a thin wrapper over the recipe compiler: the voxel rows
 * are compiled into modules and the modules are built. A legacy caller keeps the
 * exact geometry it always had — proven by the compiler's parity gate.
 *
 * @param {Array<[number, number, number, string]>} voxelData - [x, y, z, hexColor]
 * @param {number} scale - uniform scale factor for each voxel unit
 * @returns {THREE.Group}
 */
export function buildVoxelMesh(voxelData, scale = 0.2) {
  const compiled = compileCollectibleRecipe({ id: 'voxel-mesh', voxels: voxelData }, { scale });
  return buildModuleGroup(compiled, { scale });
}

/**
 * Clears the material cache (useful for memory management between scenes).
 */
export function clearMaterialCache() {
  materialCache.forEach(mat => mat.dispose());
  materialCache.clear();
}
