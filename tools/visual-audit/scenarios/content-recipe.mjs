/**
 * `CNT-02` — content recipes: the shipped props are data, and a reload draws the same data
 *
 * Registered gate (feature-roadmap/README.md order 161):
 *   "No contributor-authored Three.js required for supported modules"
 *
 * WHAT THIS SCENARIO IS FOR, GIVEN THAT `ContentRecipe.test.js` AND `FoodRecipes.test.js` EXIST
 * -------------------------------------------------------------------------------------------
 * The Node tier proves the *language* (every module compiles, every refusal names a field, the
 * compiler is deterministic) and the *parity* (the seven recipes draw exactly the boxes the
 * deleted imperative function drew, from a transcription of it). What it cannot prove is that any
 * of that is what a player's browser does:
 *
 * 1. **The compiler runs in a browser, from the served modules.** The gate is about a contributor
 *    never having to write Three.js, so the language has to work where content is authored and
 *    where it is compiled — the page imports `/src/engine/ContentRecipe.js` itself and compiles
 *    every shipped item, twice, and the digests have to match the frozen table in the Node tier.
 *    A Node-only API that slipped into the compiler fails here.
 * 2. **The live scene is the compiled recipe.** The curated runtime spawns 35 props through
 *    `ItemManager`; each spawned group carries the recipe that drew it (`userData.recipe`), and
 *    each instanced matrix is compared against a matrix composed from the compiled box. So the
 *    claim is not "the recipe compiles" but "these are the boxes on screen": position, size,
 *    colour and pose, instance for instance.
 * 3. **A reload draws the same thing.** Props are rebuilt from scratch on every mount, so a
 *    module that reached for `Math.random`, a palette iteration order that depended on insertion
 *    order, or a compiler that consumed its seed in declaration order would show up as a different
 *    digest and a different matrix set after `page.reload()`. Both are compared exactly.
 *
 * THE VISUAL HALF
 * ---------------
 * The runtime culls props outside `profile.itemRadius` (`activeRadius`), so a screenshot proves
 * nothing unless a prop is actually inside the band. The scenario teleports the player next to the
 * one deterministic spawn (`vada-pav:0` is pinned at (-36, 3, -20) so the first pickup is visible
 * immediately) and asserts the mesh's own `visible` flag flips to true, then captures the frame.
 *
 * NEGATIVE CONTROLS (run by hand, each must exit 1, then reverted)
 * ---------------------------------------------------------------
 *  - a parameter nudge (`mysore-pak` stripe step 0.4 → 0.45): the frozen digest comparison fails;
 *  - a recolour (`vada-pav` bread #e4b86c → #e4b86d): the digest covers colour, so it fails;
 *  - injected non-determinism (`Math.random()` added to a box's x in the compiler): the in-page
 *    double compile disagrees;
 *  - a tamper in the *live* path (`createFoodModel` dropping its last box): the scene read finds
 *    fewer instances than the recipe compiles, which is the leg the Node tier cannot see.
 */
import { freshRunDirectory, capture, selectFixture, waitFrames, waitForAuditBridge } from '../harness.mjs';

/** The geometry of each shipped item, recorded from the compiler. The same numbers are frozen in
 *  `src/reference/FoodRecipes.test.js`; two tiers agreeing on a constant is the point. */
const RECORDED = Object.freeze({
  'vada-pav': { boxes: 5, digest: 'be4eaf3f' },
  'cutting-chai': { boxes: 4, digest: '22fc466f' },
  'filter-coffee': { boxes: 4, digest: 'e6c1826c' },
  'mysore-pak': { boxes: 8, digest: '376ded50' },
  'banana-chips': { boxes: 8, digest: '3454ad05' },
  'podi-dosa': { boxes: 7, digest: 'fa476fc2' },
  'kerala-porotta': { boxes: 6, digest: 'cf0e9afa' },
});
const IDS = Object.keys(RECORDED);
const SPAWNED_PER_TYPE = 5;
const TOTAL_PROPS = IDS.length * SPAWNED_PER_TYPE;

/**
 * In the page: compile every shipped recipe **through the served compiler**, twice, and return
 * the boxes so Node can compare them with what the scene is drawing.
 */
const COMPILE_IN_PAGE = async (ids) => {
  const engine = await import('/src/engine/ContentRecipe.js');
  const recipes = await import('/src/reference/FoodRecipes.js');
  const compiled = {};
  for (const id of ids) {
    const recipe = recipes.FOOD_RECIPES[id];
    const first = engine.compileContentRecipe(recipe, { seed: recipes.FOOD_RECIPE_SEED });
    const second = engine.compileContentRecipe(recipe, { seed: recipes.FOOD_RECIPE_SEED });
    compiled[id] = {
      digest: first.digest,
      secondDigest: second.digest,
      boxes: first.boxCount,
      bounds: first.bounds,
      steps: first.steps,
      seeded: first.seeded,
      modules: first.modules,
      notes: first.notes,
      declared: first.boxes,
    };
  }
  return { version: engine.CONTENT_RECIPE_VERSION, seed: recipes.FOOD_RECIPE_SEED, compiled };
};

/** In the page: read every spawned prop's recorded recipe and every instance matrix. */
const READ_SCENE = () => {
  const game = globalThis.__gdoAudit?.game;
  const manager = game?.items;
  if (!manager) return { error: 'the curated runtime has no item manager' };
  const types = {};
  const props = [];
  for (const [instanceId, entry] of manager.items) {
    const mesh = entry.mesh;
    const groups = [];
    mesh.traverse(object => {
      if (!object.isInstancedMesh) return;
      const array = object.instanceMatrix.array;
      const matrices = [];
      for (let index = 0; index < object.count; index++) {
        const offset = index * 16;
        const values = [];
        for (let slot = 0; slot < 16; slot++) values.push(Math.round(array[offset + slot] * 100000) / 100000);
        matrices.push(values);
      }
      groups.push({ count: object.count, matrices, material: object.material?.type ?? null, triangles: object.geometry?.index ? null : null });
    });
    const id = entry.definition?.id ?? null;
    types[id] ??= [];
    // `mesh.position.y` and `mesh.rotation.y` are a live bob and spin inside the pickup radius
    // (`ItemManager.update`), so the *layout* is x/z plus the spawned `baseY` and `phase` the
    // animation is built on. Those four are what a reload has to reproduce; the bob is a
    // function of the clock and is not a layout claim.
    types[id].push({
      instanceId, visible: mesh.visible, families: groups.length,
      instances: groups.reduce((sum, group) => sum + group.count, 0),
      matrices: groups.flatMap(group => group.matrices),
      recipe: mesh.userData?.recipe ?? null,
      position: [mesh.position.x, mesh.position.y, mesh.position.z],
      baseY: entry.baseY, phase: entry.phase,
      material: groups.map(group => group.material),
    });
    props.push({ instanceId, id, visible: mesh.visible, recipes: groups.length });
  }
  return { total: manager.total, collected: manager.collected, score: manager.score, types, props };
};

/** In the page: teleport next to the one pinned spawn and let the camera catch up. */
const POSE_AT_PINNED_PROP = () => {
  const game = globalThis.__gdoAudit.game;
  const pinned = [...game.items.items.values()].find(entry => entry.id === 'vada-pav:0');
  if (!pinned) return { error: 'vada-pav:0 is not spawned' };
  const target = pinned.mesh.position;
  const ground = game.player.supportUnderFoot(target.x, target.z + 7);
  game.player.position.set(target.x, ground, target.z + 7);
  game.player.root.position.copy(game.player.position);
  // Face north, towards the prop: the third-person camera sits behind the player on this yaw.
  if (game.player.orbit) { game.player.orbit.yaw = 0; game.player.orbit.pitch = 0.25; }
  game.camera.position.set(target.x, ground + 3, target.z + 11);
  game.camera.lookAt(target.x, target.y, target.z);
  return { target: [target.x, target.y, target.z], ground, before: pinned.mesh.visible };
};

/**
 * In the page: build a **sheet** of the seven shipped items with the runtime's own factory and
 * stand it in front of the live camera, so the capture shows the content rather than a corner of a
 * 230 m world. The camera is read from its world matrix (position, right and forward basis) rather
 * than moved, because the frame loop re-poses the camera every frame and a scenario that moved it
 * would be photographing its own override.
 *
 * This is a presentation of the gate, not a claim about the world: every box in these models is
 * already compared instance-for-instance against the compiled recipe in the scene leg, and the
 * digest each model carries is compared again here.
 */
const BUILD_SHEET = async (ids) => {
  const { createFoodModel } = await import('/src/reference/ItemManager.js');
  const game = globalThis.__gdoAudit.game;
  const elements = game.camera.matrixWorld.elements;
  const origin = [elements[12], elements[13], elements[14]];
  const right = [elements[0], elements[1], elements[2]];
  const forward = [-elements[8], -elements[9], -elements[10]];
  const models = [];
  const placements = [];
  const round = value => Math.round(value * 100) / 100;
  // Two rows of floating items in the rig's foreground — the near row 10 m from the camera, the far
  // row 14 m — offset below the look ray and to one side of it, because the player stands on that
  // ray and a shelf centred on it would be photographed through the avatar's legs. The items float,
  // exactly as the real collectibles do (`ItemManager` holds them 1.25 m over the terrain), so the
  // shot reads the way a pickup does in play.
  ids.forEach((id, index) => {
    const row = index < 4 ? 0 : 1;
    const column = index < 4 ? index : index - 4;
    const lateral = (column - (index < 4 ? 1.5 : 1)) * (row ? 3.4 : 3) + 1.2;
    const depth = row ? 14 : 10;
    const x = origin[0] + forward[0] * depth + right[0] * lateral;
    const z = origin[2] + forward[2] * depth + right[2] * lateral;
    const y = origin[1] + forward[1] * depth - 1.9 + (row ? 1.8 : 0);
    const group = createFoodModel(id);
    // Named so the cleanup pass can find and dispose exactly these, and nothing the runtime owns.
    group.name = `recipe-sheet:${id}`;
    group.position.set(x, y, z);
    placements.push({ id, at: [round(x), round(y), round(z)] });
    // The models' front is +Z — the side the chai handle and the coffee filter sit on — so the
    // group is turned to face back down the look ray towards the camera.
    group.rotation.y = Math.atan2(-forward[0], -forward[2]);
    game.scene.add(group);
    models.push({ id, group, digest: group.userData.recipe?.digest ?? null, hasRecipe: Boolean(group.userData.recipe) });
  });
  return {
    placed: models.map(model => ({ id: model.id, digest: model.digest, recipe: model.group.userData.recipe ?? null })),
    camera: { at: origin.map(round), right: right.map(round), forward: forward.map(round) },
    placements,
  };
};

/**
 * In the page: is the third-person rig done moving?
 *
 * The teleport above moves the player, but the rig does not snap to a new pose: it eases in from
 * the runtime's wide opening framing (`resolvedDistance` starts around 66 m) towards its working
 * distance at roughly ten percent a frame, and its look target lags the player the same way. At
 * SwiftShader's one to two frames a second that is ten to twenty seconds of convergence — which is
 * how the first attempts at the sheet shot ended up photographing a pose the camera had already
 * left. So this returns the *settled* pose and the scenario refuses to build the shelf until it is
 * actually settled.
 */
const CAMERA_POSE = () => {
  const game = globalThis.__gdoAudit.game;
  const orbit = game.player.orbit;
  const elements = game.camera.matrixWorld.elements;
  return {
    at: [elements[12], elements[13], elements[14]],
    distance: orbit.distance,
    resolved: orbit.resolvedDistance,
    target: [orbit.target.x, orbit.target.y, orbit.target.z],
    player: [game.player.position.x, game.player.position.y, game.player.position.z],
  };
};

/** In the page: take the sheet back out, disposing exactly what `BUILD_SHEET` added. */
const CLEAR_SHEET = async () => {
  const { disposeGroup } = await import('/src/reference/VoxelBatch.js');
  const game = globalThis.__gdoAudit?.game;
  if (!game) return 0;
  const doomed = [];
  game.scene.traverse(object => { if (typeof object.name === 'string' && object.name.startsWith('recipe-sheet:')) doomed.push(object); });
  for (const object of doomed) { object.parent?.remove(object); disposeGroup(object); }
  return doomed.length;
};

/** In the page: has the pinned prop's mesh become visible now that the player is inside the band? */
const READ_PINNED = () => {
  const pinned = [...globalThis.__gdoAudit.game.items.items.values()].find(entry => entry.id === 'vada-pav:0');
  return pinned ? { visible: pinned.mesh.visible } : { error: 'vada-pav:0 is not spawned' };
};

/** Navigate, clear any save from an earlier scenario on this profile, and mount the curated game. */
async function openFresh(page, baseUrl, fixture) {
  await selectFixture(page, baseUrl, { id: fixture, variant: 'openmaptiles' });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForSelector('.odyssey-start', { timeout: 30_000 });
  // A restored pickup would remove a prop from the layout and turn a parity check into a
  // false failure, so this scenario starts from no progress at all.
  await page.evaluate(() => localStorage.clear());
  await page.click('.odyssey-start');
  await waitForAuditBridge(page);
  await waitFrames(page, 6);
}

/** Compose the matrix a box should draw as, for the pose the compiler reports. */
function poseMatrix(box) {
  const cos = Math.cos(box.ry), sin = Math.sin(box.ry);
  return [
    cos * box.sizeX, 0, -sin * box.sizeX, 0,
    0, box.sizeY, 0, 0,
    sin * box.sizeZ, 0, cos * box.sizeZ, 0,
    box.x, box.y, box.z, 1,
  ];
}

const sameMatrix = (a, b, tolerance = 2e-5) => a.every((value, index) => Math.abs(value - b[index]) <= tolerance);

export async function run({ page, baseUrl, log = console.log, fixture = 'dense-urban' }) {
  const directory = freshRunDirectory('cnt02-content-recipe');
  const failures = [];
  const fail = message => { failures.push(message); log(`  FAIL ${message}`); };

  // ---------------------------------------------------------------- leg 1: the page's compiler
  await openFresh(page, baseUrl, fixture);
  const compile = await page.evaluate(COMPILE_IN_PAGE, IDS);
  log(`\n[cnt02] recipe language v${compile.version}, seed ${compile.seed} — compiled in the browser`);
  const declared = {};
  for (const id of IDS) {
    const entry = compile.compiled[id];
    declared[id] = entry.declared;
    const recorded = RECORDED[id];
    const agrees = entry.digest === recorded.digest && entry.boxes === recorded.boxes;
    log(`  ${id.padEnd(15)} ${String(entry.boxes).padStart(2)} box(es) · digest ${entry.digest} ${agrees ? 'matches' : `DIFFERS from the recorded ${recorded.digest}`} · ${entry.steps} step(s) [${entry.modules.join('+')}]${entry.seeded ? ' · SEEDED' : ''}`);
    if (!agrees) fail(`${id}: the browser compiles ${entry.digest}/${entry.boxes} box(es), the Node tier recorded ${recorded.digest}/${recorded.boxes}`);
    if (entry.digest !== entry.secondDigest) fail(`${id}: compiling the same recipe twice gave ${entry.digest} then ${entry.secondDigest}`);
    if (entry.notes.length) log(`    note: ${entry.notes.join('; ')}`);
    if (entry.seeded) fail(`${id}: a shipped prop compiles as seeded, which would make its art depend on a seed`);
    for (const box of entry.declared) {
      if (box.rx !== 0 || box.rz !== 0) {
        fail(`${id}: a box is rotated on ${box.rx ? 'X' : 'Z'}, which this scenario's Y-only pose comparison cannot cover — extend it`);
      }
    }
  }

  // ------------------------------------------------------------- leg 2: the live scene, box for box
  const scene = await page.evaluate(READ_SCENE);
  if (scene.error) {
    fail(scene.error);
  } else {
    log(`\n[cnt02] live scene: ${scene.total} prop(s) spawned (${scene.collected} already collected)`);
    if (scene.total !== TOTAL_PROPS) fail(`the runtime spawned ${scene.total} props, expected ${TOTAL_PROPS} (${SPAWNED_PER_TYPE} of each of ${IDS.length})`);
    let instances = 0;
    for (const id of IDS) {
      const spawned = scene.types[id] ?? [];
      const entry = compile.compiled[id];
      const boxes = [...entry.declared].sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
      instances += spawned.reduce((sum, item) => sum + item.instances, 0);
      if (spawned.length !== SPAWNED_PER_TYPE) fail(`${id}: ${spawned.length} prop(s) spawned, expected ${SPAWNED_PER_TYPE}`);
      const digests = new Set(spawned.map(item => item.recipe?.digest ?? 'none'));
      if (digests.size !== 1 || !digests.has(RECORDED[id].digest)) {
        fail(`${id}: the spawned meshes carry ${[...digests].join(', ')}, expected ${RECORDED[id].digest}`);
      }
      const ids = new Set(spawned.map(item => item.recipe?.id ?? 'none'));
      if (ids.size !== 1 || !ids.has(id)) fail(`${id}: the spawned meshes name ${[...ids].join(', ')}`);
      for (const item of spawned) {
        if (item.families !== 1) fail(`${id}/${item.instanceId}: ${item.families} material famil(ies), expected one`);
        if (item.instances !== boxes.length) {
          fail(`${id}/${item.instanceId}: the scene draws ${item.instances} instance(s), the recipe compiles ${boxes.length}`);
          continue;
        }
        const drawn = [...item.matrices].sort((a, b) => a[12] - b[12] || a[13] - b[13] || a[14] - b[14]);
        for (let index = 0; index < boxes.length; index++) {
          if (!sameMatrix(drawn[index], poseMatrix(boxes[index]))) {
            fail(`${id}/${item.instanceId} box ${index}: the drawn matrix is not the compiled box (${JSON.stringify(drawn[index])} vs ${JSON.stringify(poseMatrix(boxes[index]))})`);
            break;
          }
        }
      }
    }
    log(`  instances        ${instances} drawn across ${scene.total} prop(s), compared matrix for matrix against the compiled boxes`);

    // The visual half: a prop inside `profile.itemRadius` must really be drawn.
    const posed = await page.evaluate(POSE_AT_PINNED_PROP);
    if (posed.error) {
      fail(posed.error);
    } else {
      await waitFrames(page, 8);
      const pinned = await page.evaluate(READ_PINNED);
      // A capture of the seven items themselves, built by the runtime, in front of the live camera.
      // The camera is allowed to settle first, and the capture happens immediately after the build:
      // both halves matter, for the reason `CAMERA_POSE` documents.
      // The rig clamps its distance to 10..65 and its pitch to .12..1.35, so these are legal camera
      // settings rather than an override of the render — 10 m and a shallow pitch, which is what
      // puts a two-metre tray at a size a reader can judge.
      await page.evaluate(() => {
        const orbit = globalThis.__gdoAudit.game.player.orbit;
        orbit.distance = 16; orbit.pitch = 0.35; orbit.yaw = 0;
      });
      let settled = null;
      let converged = false;
      for (let step = 0; step < 90; step++) {
        await waitFrames(page, 1);
        const pose = await page.evaluate(CAMERA_POSE);
        const eased = Math.abs(pose.resolved - pose.distance) < 0.4;
        const still = settled && Math.hypot(pose.at[0] - settled.at[0], pose.at[1] - settled.at[1], pose.at[2] - settled.at[2]) < 0.05;
        settled = pose;
        if (eased && still) { converged = true; break; }
      }
      const distanceToPlayer = settled ? Math.hypot(settled.at[0] - settled.player[0], settled.at[2] - settled.player[2]) : null;
      log(`  camera settled   (${(settled?.at ?? []).map(value => value.toFixed(2)).join(', ')}) after ${converged ? 'converging' : '90 FRAMES WITHOUT CONVERGING'} · rig distance ${settled?.resolved?.toFixed(2)} of ${settled?.distance}, ${distanceToPlayer?.toFixed(2)} m from the player`);
      if (!converged) fail('the third-person rig never settled, so the shelf would be composed against a moving camera');
      const sheetProbe = await page.evaluate(BUILD_SHEET, IDS);
      const sheetFile = await capture(page, directory, 'prop-sheet');
      for (const entry of sheetProbe.placed) {
        if (!entry.recipe) fail(`the sheet model ${entry.id} carries no recipe`);
        else if (entry.recipe.digest !== RECORDED[entry.id].digest) fail(`the sheet model ${entry.id} carries digest ${entry.recipe.digest}, recorded ${RECORDED[entry.id].digest}`);
        else if (entry.recipe.id !== entry.id) fail(`the sheet model ${entry.id} names recipe ${entry.recipe.id}`);
      }
      log(`  sheet            ${sheetProbe.placed.length} item(s) built by the runtime's own factory in front of the camera — ${sheetFile}`);
      log(`    camera at (${sheetProbe.camera.at.join(', ')}) forward (${sheetProbe.camera.forward.join(', ')})`);
      log(`    placements ${sheetProbe.placements.map(entry => `${entry.id}@(${entry.at.join(',')})`).join(' ')}`);
      const cleared = await page.evaluate(CLEAR_SHEET);
      log(`  sheet cleared    ${cleared} sheet model(s) removed and disposed`);
      const file = await capture(page, directory, 'props-vada-pav');
      log(`  visibility       vada-pav:0 at (${posed.target.map(value => value.toFixed(1)).join(', ')}) — visible ${posed.before} → ${pinned.visible} with the player ${7} m away`);
      log(`  frame            ${file}`);
      if (pinned.visible !== true) fail('the pinned prop is still culled with the player inside the pickup radius');
    }
  }

  // ------------------------------------------------------------------------ leg 3: the reload
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForSelector('.odyssey-start', { timeout: 30_000 });
  await page.click('.odyssey-start');
  await waitForAuditBridge(page);
  await waitFrames(page, 6);
  const reloadScene = await page.evaluate(READ_SCENE);
  if (reloadScene.error) {
    fail(`after a reload: ${reloadScene.error}`);
  } else {
    log(`\n[cnt02] reload: ${reloadScene.total} prop(s) respawned`);
    if (reloadScene.total !== scene.total) fail(`the reload spawned ${reloadScene.total} props, the first session ${scene.total}`);
    for (const id of IDS) {
      const first = scene.types[id] ?? [];
      const second = reloadScene.types[id] ?? [];
      if (second.length !== first.length) { fail(`${id}: ${second.length} prop(s) after the reload, ${first.length} before`); continue; }
      for (let index = 0; index < first.length; index++) {
        const before = first[index], after = second[index];
        if (before.recipe?.digest !== after.recipe?.digest) {
          fail(`${id}/${before.instanceId}: digest ${before.recipe?.digest} → ${after.recipe?.digest} across the reload`);
        }
        for (const axis of [0, 2]) {
          if (Math.abs(before.position[axis] - after.position[axis]) > 1e-6) {
            fail(`${id}/${before.instanceId}: the prop moved ${['x', 'z'][axis === 0 ? 0 : 1]} across the reload (${before.position[axis]} → ${after.position[axis]})`);
          }
        }
        if (Math.abs(before.baseY - after.baseY) > 1e-6 || Math.abs(before.phase - after.phase) > 1e-6) {
          fail(`${id}/${before.instanceId}: the spawn height or bob phase changed across the reload (${before.baseY}/${before.phase} → ${after.baseY}/${after.phase})`);
        }
        if (before.matrices.length !== after.matrices.length) { fail(`${id}/${before.instanceId}: ${after.matrices.length} instance(s) after the reload, ${before.matrices.length} before`); continue; }
        for (let slot = 0; slot < before.matrices.length; slot++) {
          if (!sameMatrix(before.matrices[slot], after.matrices[slot], 0)) {
            fail(`${id}/${before.instanceId} instance ${slot}: the drawn matrix changed across the reload`);
            break;
          }
        }
      }
    }
    const digests = IDS.map(id => `${id}:${(reloadScene.types[id] ?? [])[0]?.recipe?.digest ?? 'none'}`);
    log(`  identities       ${digests.join(' · ')}`);
    const file = await capture(page, directory, 'props-after-reload');
    log(`  frame            ${file}`);
  }

  log(`\n[cnt02] ${failures.length ? `FAIL (${failures.length}): ${failures[0]}` : `PASS: ${IDS.length} recipes compile in the browser to the recorded digests, ${scene.total || 0} spawned props are those recipes box for box, and a reload draws the same matrices.`}`);

  return {
    directory,
    blockers: failures.length,
    sweepFrames: 0,
    totalPenetrations: 0,
    recipeFailures: failures,
    summary: {
      version: compile.version,
      seed: compile.seed,
      recorded: IDS.length,
      spawned: scene.total ?? null,
      recompiled: IDS.map(id => ({ id, digest: compile.compiled[id].digest, boxes: compile.compiled[id].boxes, steps: compile.compiled[id].steps, modules: compile.compiled[id].modules })),
      reloaded: reloadScene.error ? null : reloadScene.total,
    },
  };
}
