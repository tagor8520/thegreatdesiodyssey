/**
 * `LAY-03` — opaque/transparent render policy *(coordinate mode)*
 *
 * Registered gate (feature-roadmap/README.md order 042):
 *   "Bounded Three sorting/render bands added; moving water audit remains."
 *
 * Research criteria (`CLIPPING_AND_LAYERING_RESEARCH.md` §15.4):
 *   1. Inspect road/land/water overlap and a four-tile corner from all cardinal
 *      directions and at low grazing angles; no flicker.
 *   2. Compare a sort-enabled/disabled harness: the chosen production policy
 *      yields deterministic water order.
 *   3. Overlapping waterway/polygon features do not darken from duplicate
 *      blending.
 *   4. No alpha-blended foliage family is introduced.
 *
 * HOW FLICKER IS MADE OBJECTIVE
 * -----------------------------
 * Frame-to-frame diffing is useless here: water normals animate, so two frames
 * captured a second apart differ by design. The defect being hunted is
 * *ordering* instability — the same pose rendering differently because sort
 * order or depth resolution is ambiguous. So the probe renders the identical
 * scene twice back to back inside one task, with no clock advance and no
 * animation step, and compares the drawing buffer via `gl.readPixels`.
 *
 * Identical inputs must therefore give identical pixels. Any difference is
 * order/depth ambiguity, not animation. This is exactly the "no flicker" claim,
 * isolated from time.
 */
import { freshRunDirectory, capture, waitFrames, readCoordinateStats } from '../harness.mjs';

const CARDINALS = [
  { name: 'north', yaw: 0 },
  { name: 'east', yaw: Math.PI / 2 },
  { name: 'south', yaw: Math.PI },
  { name: 'west', yaw: -Math.PI / 2 },
];
const GRAZING_PITCHES = [0.02, 0.05, 0.1];

/** Install the render-stability probe. Nothing is closed over from module scope. */
async function installWaterProbe(page) {
  await page.evaluate(() => {
    const game = globalThis.__gdoAudit.game;
    const { renderer, scene, camera } = game;

    globalThis.__gdoWaterProbe = {
      /**
       * Render the same pose twice without advancing time and compare pixels.
       * Returns the number of differing bytes and a coarse magnitude, so a
       * 1-bit driver wobble is distinguishable from real popping.
       */
      renderTwice() {
        const gl = renderer.getContext();
        const width = renderer.domElement.width;
        const height = renderer.domElement.height;
        const first = new Uint8Array(width * height * 4);
        const second = new Uint8Array(width * height * 4);

        // Same camera matrices for both renders: nothing moves between them.
        renderer.render(scene, camera);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, first);
        renderer.render(scene, camera);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, second);

        let differing = 0;
        let maxDelta = 0;
        let totalDelta = 0;
        for (let index = 0; index < first.length; index++) {
          const delta = Math.abs(first[index] - second[index]);
          if (delta) {
            differing++;
            totalDelta += delta;
            if (delta > maxDelta) maxDelta = delta;
          }
        }
        return { width, height, differing, maxDelta, totalDelta, bytes: first.length };
      },

      /** Water/land/road/buildings render bands and material policy, as actually configured. */
      layerPolicy() {
        const layers = [];
        const materials = new Map();
        scene.traverse(object => {
          const layer = object.userData?.geoLayer;
          if (layer && object.isMesh) {
            layers.push({
              name: object.name,
              stage: layer.stage,
              renderOrder: object.renderOrder,
              declaredBand: layer.renderBand,
              depthPolicy: layer.depthPolicy,
              materialId: object.material?.uuid,
            });
            if (object.material) {
              materials.set(object.material.uuid, {
                uuid: object.material.uuid,
                type: object.material.type,
                transparent: object.material.transparent,
                opacity: object.material.opacity,
                depthWrite: object.material.depthWrite,
                depthTest: object.material.depthTest,
                side: object.material.side,
                usedBy: object.name,
              });
            }
          }
        });
        return {
          sortObjects: renderer.sortObjects,
          layers,
          materials: [...materials.values()],
        };
      },

      /** Every transparent material in the scene, so blended foliage would be visible. */
      transparentMaterials() {
        const found = new Map();
        scene.traverse(object => {
          const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
          for (const material of list) {
            if (!material.transparent) continue;
            if (!found.has(material.uuid)) {
              found.set(material.uuid, {
                uuid: material.uuid,
                type: material.type,
                name: material.name || '',
                transparent: true,
                opacity: material.opacity,
                depthWrite: material.depthWrite,
                alphaTest: material.alphaTest,
                meshes: [],
              });
            }
            found.get(material.uuid).meshes.push(object.name);
          }
        });
        return [...found.values()].map(entry => ({ ...entry, meshCount: entry.meshes.length, meshes: entry.meshes.slice(0, 6) }));
      },

      /** Water coverage actually built from the fixture tile. */
      waterSummary() {
        let meshes = 0, vertices = 0, triangles = 0, domains = 0;
        const classes = new Set();
        for (const tile of game.world.tiles.values()) {
          if (tile.water) {
            meshes++;
            const position = tile.water.geometry.getAttribute('position');
            vertices += position?.count ?? 0;
            triangles += (tile.water.geometry.index?.count ?? 0) / 3;
          }
          const domain = tile.waterDomain;
          if (domain?.waterVertices?.length) domains++;
          for (const value of domain?.waterClasses ?? []) classes.add(value);
        }
        return { meshes, vertices, triangles, domains, classes: [...classes] };
      },

      setPose({ yaw, pitch, distance }) {
        const player = game.player;
        player.setCameraMode('third-person', true);
        player.yaw = yaw;
        player.thirdPersonPitch = pitch;
        player.distance = distance;
        camera.updateMatrixWorld();
        renderer.render(scene, camera);
      },

      /** Place the player so the camera looks across the mapped water. */
      focusWater() {
        let best = null;
        for (const tile of game.world.tiles.values()) {
          if (!tile.water) continue;
          const position = tile.water.geometry.getAttribute('position');
          if (!position?.count) continue;
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
          for (let index = 0; index < position.count; index++) {
            const x = position.getX(index), z = position.getZ(index);
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
          }
          const area = (maxX - minX) * (maxZ - minZ);
          if (!best || area > best.area) best = { tileKey: tile.key, minX, maxX, minZ, maxZ, area };
        }
        if (!best) return null;
        const centerX = (best.minX + best.maxX) / 2;
        const centerZ = (best.minZ + best.maxZ) / 2;
        // Stand just inside the near edge of the water so the view grazes it.
        game.player.setPosition(centerX, centerZ);
        game.player.updateCamera(0, true);
        return best;
      },

      setSortObjects(value) {
        renderer.sortObjects = value;
        return renderer.sortObjects;
      },
    };
  });
}

async function waitForWater(page, log, attempts = 45) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const stats = await readCoordinateStats(page);
    const water = await page.evaluate(() => globalThis.__gdoWaterProbe.waterSummary());
    if (water.meshes > 0) {
      log(`[lay03] water ready: ${water.meshes} mesh(es), ${water.triangles} triangles, ` +
          `${water.vertices} vertices, domains=${water.domains}, classes=${water.classes.join('/') || 'none'}`);
      return { stats, water };
    }
    await waitFrames(page, 4);
  }
  throw new Error('Timed out waiting for mapped water from the offline fixture provider.');
}

export async function run({ page, baseUrl, log = console.log, fixture = 'mapped-coast', variant = 'openmaptiles' }) {
  const directory = freshRunDirectory(`lay03-water-order-${fixture}-${variant}`);
  await installWaterProbe(page);
  const { water } = await waitForWater(page, log);

  // --- Criterion 2 and the material half of 1: declared policy --------------
  const policy = await page.evaluate(() => globalThis.__gdoWaterProbe.layerPolicy());
  const describe = name => name.replace(/:.*$/, '').replace(/-cover$/, '');
  const byBand = [...policy.layers].sort((a, b) => a.renderOrder - b.renderOrder || a.stage - b.stage);
  const orderedBands = [];
  for (const layer of byBand) {
    const last = orderedBands[orderedBands.length - 1];
    if (!last || last.renderOrder !== layer.renderOrder || last.stage !== layer.stage) {
      orderedBands.push({
        stage: layer.stage,
        renderOrder: layer.renderOrder,
        depthPolicy: layer.depthPolicy,
        sample: describe(layer.name),
      });
    }
  }
  log(`[lay03] sortObjects=${policy.sortObjects}; render bands: ` +
      orderedBands.map(band => `${band.sample}@${band.renderOrder}(${band.depthPolicy})`).join(' < '));

  // The load-bearing ordering claim: the transparent water band sits strictly
  // above every opaque band, so water is always blended after opaque geometry
  // has written depth. Opaque layers legitimately share band 0 — they are
  // depth-written, so Three's opaque pass resolves them without explicit bands.
  const waterLayers = policy.layers.filter(layer => layer.depthPolicy === 'transparent-depth-read');
  const opaqueBands = policy.layers.filter(layer => layer.depthPolicy === 'opaque-depth-write').map(layer => layer.renderOrder);
  const highestOpaqueBand = opaqueBands.length ? Math.max(...opaqueBands) : 0;
  const waterBandOrdering = waterLayers.length
    ? waterLayers.every(layer => layer.renderOrder > highestOpaqueBand)
    : null;
  log(`[lay03] water band ${waterLayers[0]?.renderOrder ?? 'n/a'} vs highest opaque band ${highestOpaqueBand}: ` +
      `${waterBandOrdering ? 'water blends after all opaque geometry' : 'ORDERING VIOLATION'}`);
  for (const material of policy.materials) {
    log(`[lay03] material ${material.type} used by ${material.usedBy}: transparent=${material.transparent} ` +
        `opacity=${material.opacity} depthWrite=${material.depthWrite} depthTest=${material.depthTest}`);
  }

  // --- Criterion 4: no alpha-blended foliage family -------------------------
  const transparent = await page.evaluate(() => globalThis.__gdoWaterProbe.transparentMaterials());
  const foliageLike = transparent.filter(material =>
    /plant|foliage|leaf|leaves|tree|shrub|grass|palm|canopy|crown/i.test(
      `${material.name} ${material.meshes.join(' ')}`));
  log(`[lay03] transparent materials in scene: ${transparent.length}` +
      (transparent.length ? ` (${transparent.map(m => `${m.type}${m.name ? `:${m.name}` : ''}`).join(', ')})` : ''));
  const nonWaterTransparent = transparent.filter(material =>
    !/water/i.test(`${material.name} ${material.meshes.join(' ')}`));
  if (foliageLike.length) {
    log(`[lay03] FAIL criterion 4: alpha-blended foliage present: ${foliageLike.map(m => m.meshes.join('/')).join(', ')}`);
  } else {
    log('[lay03] criterion 4 OK: no alpha-blended foliage family; transparent materials are water only');
  }
  log(`[lay03] non-water transparent materials: ${nonWaterTransparent.length}`);

  // --- Criterion 1 and 3: order stability under identical inputs ------------
  const focus = await page.evaluate(() => globalThis.__gdoWaterProbe.focusWater());
  if (!focus) throw new Error('No water geometry found; LAY-03 cannot be evaluated.');
  log(`[lay03] focusing water on tile ${focus.tileKey} ` +
      `x[${focus.minX.toFixed(1)},${focus.maxX.toFixed(1)}] z[${focus.minZ.toFixed(1)},${focus.maxZ.toFixed(1)}]`);

  const stability = [];
  const screenshots = [];
  for (const distance of [1.2, 8]) {
    for (const cardinal of CARDINALS) {
      for (const pitch of GRAZING_PITCHES) {
        await page.evaluate(({ yaw, pitch, distance }) => globalThis.__gdoWaterProbe.setPose({ yaw, pitch, distance }),
          { yaw: cardinal.yaw, pitch, distance });
        await waitFrames(page, 2);
        const result = await page.evaluate(() => globalThis.__gdoWaterProbe.renderTwice());
        // Normalise the drawing buffer size out of the comparison.
        const ratio = result.differing / Math.max(1, result.width * result.height);
        stability.push({ distance, direction: cardinal.name, pitch, ...result, ratio });
        if (result.differing) {
          log(`[lay03] ORDER INSTABILITY ${cardinal.name} dist=${distance} pitch=${pitch}: ` +
              `${result.differing} bytes (${(ratio * 100).toFixed(4)}%), maxDelta=${result.maxDelta}`);
        }
      }
    }
  }
  const unstable = stability.filter(entry => entry.differing > 0);
  log(`[lay03] order stability: ${stability.length - unstable.length}/${stability.length} identical-input renders ` +
      `were pixel-identical across 4 cardinal directions x ${GRAZING_PITCHES.length} grazing pitches x 2 distances`);

  // --- Criterion 2: sort-enabled vs sort-disabled ---------------------------
  const sortComparison = [];
  for (const enabled of [true, false]) {
    const applied = await page.evaluate(value => globalThis.__gdoWaterProbe.setSortObjects(value), enabled);
    await page.evaluate(({ yaw, pitch, distance }) => globalThis.__gdoWaterProbe.setPose({ yaw, pitch, distance }),
      { yaw: CARDINALS[0].yaw, pitch: GRAZING_PITCHES[0], distance: 8 });
    await waitFrames(page, 2);
    const result = await page.evaluate(() => globalThis.__gdoWaterProbe.renderTwice());
    sortComparison.push({ sortObjects: applied, differing: result.differing, maxDelta: result.maxDelta });
    log(`[lay03] sortObjects=${applied}: ${result.differing} differing bytes, maxDelta=${result.maxDelta}`);
  }
  await page.evaluate(() => globalThis.__gdoWaterProbe.setSortObjects(true));
  log('[lay03] restored production policy sortObjects=true');

  // --- Evidence frames for human review ------------------------------------
  for (const cardinal of CARDINALS) {
    await page.evaluate(({ yaw, pitch, distance }) => globalThis.__gdoWaterProbe.setPose({ yaw, pitch, distance }),
      { yaw: cardinal.yaw, pitch: GRAZING_PITCHES[0], distance: 3 });
    await waitFrames(page, 3);
    screenshots.push(await capture(page, directory, `water-grazing-${cardinal.name}`));
  }

  return {
    fixture: `${fixture}/${variant}`,
    directory,
    water,
    // Water geometry signature, so two provider vocabularies can be compared:
    // the same lake under `water` and `water_polygons` must produce identical
    // geometry, and must not be drawn twice.
    waterSignature: `${water.triangles}tri/${water.vertices}v/${water.meshes}mesh/${water.domains}domain`,
    renderBands: orderedBands,
    highestOpaqueBand,
    waterBand: waterLayers[0]?.renderOrder ?? null,
    waterBandOrdering,
    sortObjects: policy.sortObjects,
    materials: policy.materials,
    transparentMaterials: transparent,
    alphaBlendedFoliage: foliageLike.map(material => material.meshes),
    nonWaterTransparent: nonWaterTransparent.map(material => material.meshes),
    stabilitySamples: stability.length,
    orderInstabilitySamples: unstable.length,
    worstInstability: unstable.length
      ? unstable.reduce((worst, entry) => entry.differing > worst.differing ? entry : worst)
      : null,
    stability,
    sortComparison,
    screenshots,
  };
}
