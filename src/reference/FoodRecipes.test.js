/**
 * `CNT-02` — the shipped seven props, as recipes (content tier).
 *
 * The registered gate is *"No contributor-authored Three.js required for supported modules"*, and
 * the half of it that a language test cannot make is this one: the seven items the curated runtime
 * actually spawns must still be the art they were before the port. So this file carries a
 * **transcription of the imperative function this slice deleted** (`createFoodModel`, from
 * `git show HEAD:src/reference/ItemManager.js`) and asserts, item by item, that compiling the
 * recipe draws the same boxes.
 *
 * Three claims, each with its own failure mode:
 *
 * 1. **Parity.** Same box count, same centres, same sizes, same colours, same material, and the
 *    same rotations *modulo a full turn* — the compiler reports angles in (-pi, pi], so a chip
 *    spun by 6 radians is the same chip as one spun by -0.283. Any other difference is an
 *    accidental art change and fails here naming the item.
 * 2. **Frozen digests.** The per-item digest and bounds are recorded, so an edit that moves a
 *    slab by a millimetre fails with the digest that changed rather than with a screenshot nobody
 *    diffs. The browser scenario (`content-recipe`) checks the same digests out of the live scene,
 *    which is what ties this table to what a player sees.
 * 3. **Two tables, one truth.** `FOOD_ITEMS` (what spawns where) and `FOOD_RECIPES` (what it looks
 *    like) are keyed by the same ids in the same order. A new item that forgets its recipe, or a
 *    recipe with no item, fails here rather than at spawn time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { FOOD_ITEMS, compileFoodRecipe, createFoodModel } from './ItemManager.js';
import { DIWALI_LAMP_RECIPE, FOOD_RECIPES, FOOD_RECIPE_SEED } from './FoodRecipes.js';
import { compileContentRecipe } from '../engine/ContentRecipe.js';

const TURN = Math.PI * 2;
const wrap = angle => angle - TURN * Math.round(angle / TURN);

/** The compiler reports angles in (-pi, pi]; a full turn is not a difference between two poses. */
const sameAngle = (a, b) => Math.abs(wrap(a - b)) < 1e-6;

/** The pre-port function, transcribed from `git show HEAD:src/reference/ItemManager.js`. It is
 *  never imported by anything: it is the reference the port is measured against. */
function legacyBoxes(id) {
  const boxes = [];
  const box = (x, y, z, sx, sy, sz, color, rotation = [0, 0, 0]) => boxes.push({
    x, y, z, sizeX: sx, sizeY: sy, sizeZ: sz, rx: rotation[0], ry: rotation[1], rz: rotation[2], color, metalness: 0,
  });
  if (id === 'vada-pav') {
    box(0, .1, 0, 1.8, .35, 1.5, '#e4b86c'); box(0, .36, 0, 1.9, .12, 1.6, '#4d9132');
    box(0, .65, 0, 1.5, .5, 1.3, '#c48620'); box(0, 1, 0, 1.9, .35, 1.5, '#e6a14a'); box(0, 1.25, 0, 1.5, .2, 1.2, '#efb663');
  } else if (id === 'filter-coffee' || id === 'cutting-chai') {
    const coffee = id === 'filter-coffee';
    box(0, 0, 0, coffee ? 2 : 1.2, .12, coffee ? 2 : 1.2, '#bdcbd0');
    box(0, .6, 0, 1.1, 1.1, 1.1, coffee ? '#aabcc5' : '#779c9d');
    box(0, 1.18, 0, 1.05, .12, 1.05, coffee ? '#d5ab70' : '#a66c37');
    box(-.3, .6, .56, .15, .85, .05, '#f1eee0');
  } else if (id === 'mysore-pak') {
    box(0, 0, 0, 2.2, .1, 1.8, '#e2ddd1');
    for (const x of [-.55, .55]) box(x, .45, 0, .95, .8, 1.4, '#dbac35');
    for (let i = 0; i < 5; i++) box(-.85 + i * .4, .87, .15, .15, .07, .18, '#b27b25');
  } else if (id === 'banana-chips') {
    box(0, 0, 0, 2.4, .12, 1.8, '#40852e');
    for (let i = 0; i < 7; i++) { const x = (i % 3 - 1) * .6, z = (Math.floor(i / 3) - 1) * .5; box(x, .2 + i % 2 * .13, z, .65, .16, .55, '#f0c335', [0, i, 0]); }
  } else if (id === 'podi-dosa') {
    box(0, 0, 0, 2.6, .1, 1.8, '#498a30');
    for (let i = -2; i <= 2; i++) box(0, .25 + (2 - Math.abs(i)) * .17, i * .22, 2.3, .25, .28, i % 2 ? '#c88a38' : '#e4b663');
    box(1, .17, .65, .45, .2, .45, '#bf4f27');
  } else if (id === 'kerala-porotta') {
    box(0, 0, 0, 2.2, .1, 2, '#497c37');
    for (let i = 0; i < 5; i++) box(0, .18 + i * .15, 0, 1.7 - i % 2 * .2, .13, 1.6 - i % 2 * .2, i % 2 ? '#d2ab73' : '#f4deb0', [0, i * .25, 0]);
  } else throw new Error(`Unknown food: ${id}`);
  // Round the way the compiler reports, so the comparison is between two reported geometries
  // rather than between a reported one and a double.
  return boxes.map(entry => Object.fromEntries(Object.entries(entry).map(([key, value]) => [
    key, typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value,
  ])));
}

/** The recorded geometry of each shipped item, as compiled today. */
const RECORDED = Object.freeze({
  'vada-pav': { boxes: 5, digest: 'be4eaf3f', bounds: { min: [-0.95, -0.075, -0.8], max: [0.95, 1.35, 0.8] } },
  'cutting-chai': { boxes: 4, digest: '22fc466f', bounds: { min: [-0.6, -0.06, -0.6], max: [0.6, 1.24, 0.6] } },
  'filter-coffee': { boxes: 4, digest: 'e6c1826c', bounds: { min: [-1, -0.06, -1], max: [1, 1.24, 1] } },
  'mysore-pak': { boxes: 8, digest: '376ded50', bounds: { min: [-1.1, -0.05, -0.9], max: [1.1, 0.905, 0.9] } },
  // The only item whose reported angle changed in this port (a chip spun by 6 radians is reported
  // as -0.283), which is why its digest differs from the pre-port number while posing identically.
  'banana-chips': { boxes: 8, digest: '3454ad05', bounds: { min: [-1.2, -0.06, -0.922061], max: [1.2, 0.41, 0.9] } },
  'podi-dosa': { boxes: 7, digest: 'fa476fc2', bounds: { min: [-1.3, -0.05, -0.9], max: [1.3, 0.715, 0.9] } },
  'kerala-porotta': { boxes: 6, digest: 'cf0e9afa', bounds: { min: [-1.132434, -0.05, -1.147492], max: [1.132434, 0.845, 1.147492] } },
});

/** A multiset comparison: the recipe declares its own emission order, which is not a rendered
 *  difference — the boxes are instanced into one buffer per material family. */
const multiset = boxes => boxes.map(box => JSON.stringify(box)).sort();

test('the two tables are keyed by the same ids, in the same order', () => {
  const itemIds = FOOD_ITEMS.map(definition => definition.id);
  assert.deepEqual(Object.keys(FOOD_RECIPES), itemIds);
  // Spawn order is load-bearing: the manager draws every position from one seeded stream in this
  // order, and `NET-01` stores progress under `${definition.id}:${i}`, so a reorder would move
  // every prop *and* invalidate every saved pickup.
  assert.equal(new Set(itemIds).size, itemIds.length, 'no duplicate ids');
  for (const id of itemIds) {
    assert.ok(FOOD_RECIPES[id].palette, `${id} declares a palette`);
    assert.ok(FOOD_RECIPES[id].steps.length, `${id} declares steps`);
  }
});

test('every shipped item compiles to exactly the boxes the imperative function drew', () => {
  let total = 0;
  for (const definition of FOOD_ITEMS) {
    const id = definition.id;
    const compiled = compileFoodRecipe(id);
    const legacy = legacyBoxes(id);
    total += compiled.boxCount;
    assert.equal(compiled.boxCount, legacy.length, `${id}: ${compiled.boxCount} box(es) compiled, ${legacy.length} drawn before`);
    // Compare geometry-and-colour first, so a mismatch reports as "these boxes differ" rather
    // than as a rotation-tolerance failure on the wrong box.
    const strip = boxes => boxes.map(({ rx, ry, rz, ...rest }) => rest);
    assert.deepEqual(multiset(strip(compiled.boxes)), multiset(strip(legacy)), `${id}: geometry or colour changed`);
    const compiledOrdered = [...compiled.boxes].sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
    const legacyOrdered = [...legacy].sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
    for (let index = 0; index < compiledOrdered.length; index++) {
      const a = compiledOrdered[index], b = legacyOrdered[index];
      for (const axis of ['rx', 'ry', 'rz']) {
        assert.ok(sameAngle(a[axis], b[axis]), `${id} box ${index}: ${axis} ${a[axis]} is not the pose ${b[axis]}`);
      }
    }
    assert.equal(new Set(compiled.boxes.map(box => box.metalness)).size, 1, `${id} stays in one material family`);
    assert.equal(compiled.seeded, false, `${id} is deterministic without a seed`);
    assert.equal(compiled.notes.length, 0, `${id} compiles without a repair note: ${compiled.notes.join('; ')}`);
  }
  assert.equal(total, 42, 'seven items, forty-two boxes');
});

test('the recorded digests and bounds are the ones the compiler produces', () => {
  const changed = [];
  for (const [id, recorded] of Object.entries(RECORDED)) {
    const compiled = compileFoodRecipe(id);
    if (compiled.boxCount !== recorded.boxes) changed.push(`${id}: ${recorded.boxes} box(es) recorded, ${compiled.boxCount} compiled`);
    if (compiled.digest !== recorded.digest) changed.push(`${id}: digest ${recorded.digest} recorded, ${compiled.digest} compiled`);
    if (JSON.stringify(compiled.bounds) !== JSON.stringify(recorded.bounds)) {
      changed.push(`${id}: bounds ${JSON.stringify(recorded.bounds)} recorded, ${JSON.stringify(compiled.bounds)} compiled`);
    }
  }
  assert.deepEqual(changed, [], `the shipped art changed:\n  ${changed.join('\n  ')}`);
  // And the digests are the documented property they claim to be: stable, and different per item.
  assert.equal(new Set(Object.values(RECORDED).map(entry => entry.digest)).size, Object.keys(RECORDED).length);
  assert.equal(compileFoodRecipe('vada-pav').digest, compileFoodRecipe('vada-pav').digest);
});

test('the compiled recipe is what the batch is asked to draw, box for box', () => {
  for (const definition of FOOD_ITEMS) {
    const id = definition.id;
    const compiled = compileFoodRecipe(id);
    const group = createFoodModel(id);
    const instances = [];
    let families = 0;
    group.traverse(object => {
      if (!object.isInstancedMesh) return;
      families++;
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      for (let index = 0; index < object.count; index++) {
        object.getMatrixAt(index, matrix);
        matrix.decompose(position, quaternion, scale);
        instances.push({
          x: position.x, y: position.y, z: position.z,
          sizeX: scale.x, sizeY: scale.y, sizeZ: scale.z,
          // A pose is compared as a quaternion, not as an Euler triple: `asin` in the Euler
          // decomposition has two branches, so a chip spun by 3 radians reads back as (pi, 0.14, pi)
          // — the same pose written twice, which is exactly the kind of false failure this file
          // must not have.
          pose: quaternion.clone(),
          color: readInstanceColor(object, index),
        });
      }
    });
    assert.equal(families, 1, `${id} is one instanced mesh (one material family)`);
    assert.equal(instances.length, compiled.boxCount, `${id}: ${instances.length} instances for ${compiled.boxCount} boxes`);
    const expected = [...compiled.boxes].sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
    const actual = [...instances].sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
    for (let index = 0; index < expected.length; index++) {
      for (const axis of ['x', 'y', 'z', 'sizeX', 'sizeY', 'sizeZ']) {
        assert.ok(Math.abs(actual[index][axis] - expected[index][axis]) < 1e-6, `${id} box ${index}: ${axis} drifted`);
      }
      const expectedPose = new THREE.Quaternion().setFromEuler(new THREE.Euler(expected[index].rx, expected[index].ry, expected[index].rz, 'XYZ'));
      const dot = Math.abs(actual[index].pose.dot(expectedPose));
      assert.ok(dot > 1 - 1e-6, `${id} box ${index}: pose drifted (|dot| ${dot})`);
      assert.equal(actual[index].color, expected[index].color, `${id} box ${index}: colour is the palette's`);
    }
    // The scene carries the recipe that drew it, so a gate (or a future debug overlay) can read
    // what was compiled from the live object rather than from a second source of truth.
    assert.deepEqual(group.userData.recipe, { id, digest: compiled.digest, boxes: compiled.boxCount, bounds: compiled.bounds });
  }
});

test('an unknown id is refused by name, in both the compiler and the factory', () => {
  assert.throws(() => compileFoodRecipe('pizza'), error => {
    assert.ok(error instanceof RangeError);
    assert.match(error.message, /Unknown food: "pizza"/);
    assert.match(error.message, /vada-pav/);
    return true;
  });
  assert.throws(() => createFoodModel('pizza'), /Unknown food: "pizza"/);
});

test('the worked example uses the vocabulary the shipped items do not, and still compiles', () => {
  // `ring`, `translate`, `rotateY` and a seeded `scatter` — the four things a contributor reading
  // the seven items would never see. It is the recipe `CNT-03`'s documentation shows.
  const compiled = compileContentRecipe(DIWALI_LAMP_RECIPE, { seed: FOOD_RECIPE_SEED });
  assert.ok(compiled.modules.includes('ring') && compiled.modules.includes('scatter'));
  assert.deepEqual(compiled.operations, ['translate', 'rotateY']);
  assert.equal(compiled.seeded, true);
  assert.equal(compiled.notes.length, 0);
  // It is a *lamp*, so it is lit: the metalness of the clay base reached the box it was written on.
  const lit = compileContentRecipe({ palette: DIWALI_LAMP_RECIPE.palette, steps: [{ module: 'box', at: [0, 0, 0], size: [1, 1, 1], color: 'rim', metalness: 0.35 }] }, { seed: 1 });
  assert.equal(lit.boxes[0].metalness, 0.35);
  assert.ok(compiled.boxes.every(box => box.metalness === 0), 'the example itself stays unlit');
  // The example is not spawned: the runtime's items are the seven shipped ones and nothing else.
  assert.equal(Object.keys(FOOD_RECIPES).length, FOOD_ITEMS.length);
});

/** The palette attribute the batch writes (`voxelColor`), read back per instance. */
function readInstanceColor(mesh, index) {
  const attribute = mesh.geometry.getAttribute('voxelColor');
  const value = new THREE.Color(attribute.getX(index), attribute.getY(index), attribute.getZ(index));
  return `#${value.getHexString()}`;
}
