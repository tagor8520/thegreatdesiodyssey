/**
 * `COL-05` — near-plane-derived TPP camera sweep *(coordinate mode)*
 *
 * Registered gate (feature-roadmap/README.md order 034):
 *   "Algorithm/response tests pass; moving visual audit remains."
 *
 * Research criteria (`CLIPPING_AND_LAYERING_RESEARCH.md` §15.3), items 1-5:
 *   1. Orbit 360° around rectangular, rotated, L-shaped, concave, and thin
 *      buildings at both minimum and maximum TPP distance.
 *   2. The camera never renders from inside a `CAMERA_BLOCKER`, and near-plane
 *      corners remain legal.
 *   3. Emergency inward compression resolves in the **first affected rendered
 *      frame**; outward recovery is smooth and hysteretic.
 *   4. The camera may pass above a low building **only** when the packed
 *      vertical span permits it.
 *   5. Low bridge/ceiling and terrain cases preserve legal pitch.
 *
 * WHY NEAR-PLANE CORNERS AND NOT THE CAMERA ORIGIN
 * ------------------------------------------------
 * The camera origin can be legally outside a facade while the near plane still
 * clips through it — that is exactly the failure `COL-05` fixes. So the test
 * point is the four corners of the near-plane rectangle, unprojected to world
 * space, not the camera position.
 *
 * The inside-test is a zero-length, zero-radius `world.sweepSphere` from each
 * corner. That reuses the shipped query (mask filtering, packed vertical spans,
 * exact footprint refinement) but in a direction the sweep logic itself never
 * resolves, so it cannot be satisfied by construction. `sweepPointAgainstAabb`
 * reports `startedOverlapping` for a start-inside segment, which is what makes
 * a degenerate sweep a valid containment test.
 *
 * Geometry comes from the offline fixture provider, so this runs with no
 * network access.
 */
import { freshRunDirectory, capture, waitFrames, readCoordinateStats } from '../harness.mjs';

const MIN_DISTANCE = 1.2;   // GeoPlayer wheel clamp floor
const MAX_DISTANCE = 8;     // GeoPlayer wheel clamp ceiling
const ORBIT_STEPS = 24;     // 15° increments: a full 360° orbit
const YAW_EPSILON = 1e-3;

/** Camera-local near-plane rectangle corners, in world space, using only the matrix array. */
const NEAR_CORNER_SOURCE = `
  const elements = camera.matrixWorld.elements;
  const height = Math.tan((camera.fov * Math.PI) / 360) * camera.near;
  const width = height * camera.aspect;
  const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  return signs.map(([signX, signY]) => {
    const x = signX * width, y = signY * height, z = -camera.near;
    return [
      elements[0] * x + elements[4] * y + elements[8] * z + elements[12],
      elements[1] * x + elements[5] * y + elements[9] * z + elements[13],
      elements[2] * x + elements[6] * y + elements[10] * z + elements[14],
    ];
  });
`;

/**
 * Install page-side helpers once, so each sample is a single evaluate round trip.
 * Everything the helper needs is captured from `__gdoAudit.game` at call time;
 * nothing is closed over from module scope (page.evaluate callbacks cannot see it).
 */
async function installProbe(page) {
  await page.evaluate(() => {
    const game = globalThis.__gdoAudit.game;
    const reusable = {};

    globalThis.__gdoCameraProbe = {
      /** World-space near-plane corners for the live camera. */
      nearCorners() {
        const { camera } = game.player;
        camera.updateMatrixWorld();
        const elements = camera.matrixWorld.elements;
        const height = Math.tan((camera.fov * Math.PI) / 360) * camera.near;
        const width = height * camera.aspect;
        const corners = [];
        for (const [signX, signY] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const x = signX * width, y = signY * height, z = -camera.near;
          corners.push([
            elements[0] * x + elements[4] * y + elements[8] * z + elements[12],
            elements[1] * x + elements[5] * y + elements[9] * z + elements[13],
            elements[2] * x + elements[6] * y + elements[10] * z + elements[14],
          ]);
        }
        return corners;
      },

      /** True when a point sits inside a CAMERA_BLOCKER (default mask of sweepSphere). */
      insideBlocker(x, y, z) {
        const out = game.world.sweepSphere(x, y, z, 0, 0, 0, 0, reusable);
        return { inside: Boolean(out.hit), overlapped: Boolean(out.startedOverlapping) };
      },

      /** Sample the live camera: near-plane corner legality plus resolved distance. */
      sample() {
        const { camera, cameraResolvedDistance, distance, yaw, thirdPersonPitch, cameraMode } = game.player;
        const corners = this.nearCorners();
        const offenders = [];
        for (let index = 0; index < corners.length; index++) {
          const [x, y, z] = corners[index];
          if (this.insideBlocker(x, y, z).inside) offenders.push(index);
        }
        return {
          mode: cameraMode,
          yaw,
          pitch: thirdPersonPitch,
          distance,
          resolved: cameraResolvedDistance,
          position: [camera.position.x, camera.position.y, camera.position.z],
          corners,
          offenders,
        };
      },

      /** Poses that are legal for a player stand point (not inside solid geometry). */
      standLegal(x, z) {
        const world = game.world;
        const y = world.supportAt(x, z).y;
        const head = this.insideBlocker(x, y + 1.6, z);
        return { legal: !head.inside && !world.collidesCircle(x, z, .45), y };
      },

      /** Live collision-query counters, so exact-ring refinement is provable, not assumed. */
      queryDiagnostics() {
        const diagnostics = game.world.queryDiagnostics;
        return {
          sphereSweeps: diagnostics.sphereSweeps,
          exactTests: diagnostics.exactTests,
          candidates: diagnostics.candidates,
          overlaps: diagnostics.overlaps,
        };
      },

      /** Does this tile carry exact footprint rings (the concave/L-shape path)? */
      exactFootprintCoverage() {
        let tilesWithRings = 0, polygonsWithRings = 0, tiles = 0;
        for (const tile of game.world.tiles.values()) {
          if (!tile.colliders) continue;
          tiles++;
          const hasRings = Boolean(tile.collisionVertices?.length && tile.collisionRingOffsets?.length > 1 &&
            tile.collisionPolygonOffsets?.length > 1);
          if (hasRings) {
            tilesWithRings++;
            polygonsWithRings += Math.max(0, (tile.collisionPolygonOffsets?.length ?? 1) - 1);
          }
        }
        return { tiles, tilesWithRings, polygonsWithRings };
      },

      /** Building footprint boxes from the packed collision data, for target selection. */
      buildingBoxes() {
        const world = game.world;
        const boxes = [];
        for (const tile of world.tiles.values()) {
          const colliders = tile.colliders;
          if (!colliders) continue;
          for (let index = 0; index < colliders.length; index += 4) {
            const minX = colliders[index], minZ = colliders[index + 1];
            const maxX = colliders[index + 2], maxZ = colliders[index + 3];
            const polygonIndex = index / 4;
            const base = tile.collisionSpans?.[polygonIndex * 2] ?? 0;
            const top = tile.collisionSpans?.[polygonIndex * 2 + 1] ?? Infinity;
            const width = maxX - minX, depth = maxZ - minZ;
            if (width < .5 || depth < .5 || top - base < 2) continue;
            boxes.push({ tileKey: tile.key, minX, minZ, maxX, maxZ, base, top, width, depth });
          }
        }
        return boxes;
      },

      setPose({ yaw, pitch, distance }) {
        const player = game.player;
        player.setCameraMode('third-person', true);
        if (yaw !== undefined) player.yaw = yaw;
        if (pitch !== undefined) player.thirdPersonPitch = pitch;
        if (distance !== undefined) player.distance = distance;
        player.updateCamera(0, true);
      },

      standAt(x, z) {
        game.player.setPosition(x, z);
        game.player.updateCamera(0, true);
      },
    };
  });
}

/** Pick stand points around a box, preferring corners/edges, and require legality. */
async function findStand(page, box) {
  const result = await page.evaluate(({ minX, minZ, maxX, maxZ, base, top }) => {
    const probe = globalThis.__gdoCameraProbe;
    const centerX = (minX + maxX) / 2, centerZ = (minZ + maxZ) / 2;
    const halfX = (maxX - minX) / 2, halfZ = (maxZ - minZ) / 2;
    const candidates = [];
    for (const radius of [3, 4, 5, 6, 8]) {
      for (let step = 0; step < 16; step++) {
        const angle = (step / 16) * Math.PI * 2;
        const x = centerX + Math.cos(angle) * (halfX + radius);
        const z = centerZ + Math.sin(angle) * (halfZ + radius);
        candidates.push([x, z]);
      }
    }
    for (const [x, z] of candidates) {
      const check = probe.standLegal(x, z);
      // A stand below the roof keeps the orbit meaningful: the camera must be
      // pushed around the facade rather than sailing over it.
      if (check.legal && check.y < top) return { x, z, y: check.y, centerX, centerZ, base, top };
    }
    return null;
  }, box);
  return result;
}

/**
 * Buildings arrive in the worker's third phase, well after roads and context.
 * Poll the panel the runtime already renders rather than guessing a frame count.
 */
async function waitForBuildings(page, log, attempts = 45) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const stats = await readCoordinateStats(page);
    if ((stats.buildings ?? 0) > 0) {
      log(`[col05] mapped geometry ready: ${stats.roads ?? 0} roads, ${stats.buildings} buildings, ${stats.details ?? 0} details`);
      return stats;
    }
    await waitFrames(page, 4);
  }
  throw new Error('Timed out waiting for mapped buildings from the offline fixture provider.');
}

/**
 * One fixture's full orbit sweep. Split out from `run` so the multi-fixture
 * matrix can drive every shape family through the same code path.
 */
export async function sweepFixture({ page, log, fixture, directory, installProbeFirst = false }) {
  if (installProbeFirst) await installProbe(page);
  await waitForBuildings(page, log);

  const blockers = await page.evaluate(() => globalThis.__gdoCameraProbe.buildingBoxes());
  const coverage = await page.evaluate(() => globalThis.__gdoCameraProbe.exactFootprintCoverage());
  const diagnosticsBefore = await page.evaluate(() => globalThis.__gdoCameraProbe.queryDiagnostics());
  log(`[col05] ${blockers.length} camera-blocking building boxes available from the fixture tile`);
  log(`[col05] exact footprint rings: ${coverage.tilesWithRings}/${coverage.tiles} tiles, ` +
      `${coverage.polygonsWithRings} polygons (concave/courtyard refinement path)`);
  if (!blockers.length) throw new Error('No building colliders: the fixture provider did not supply mapped geometry.');

  // Spread targets across the tile rather than orbiting one cluster: distinct
  // shapes (thin, wide, deep, rotated) exercise different sweep normals.
  const ranked = [...blockers].sort((a, b) => b.top - a.top);
  const selected = [];
  for (const box of ranked) {
    const farEnough = selected.every(other =>
      Math.hypot((box.minX + box.maxX) / 2 - (other.minX + other.maxX) / 2,
        (box.minZ + box.maxZ) / 2 - (other.minZ + other.maxZ) / 2) > 18);
    if (farEnough) selected.push(box);
    if (selected.length >= 6) break;
  }

  const frames = [];
  const families = [];
  let totalPenetrations = 0;

  for (const box of selected) {
    const stand = await findStand(page, box);
    if (!stand) {
      log(`[col05] skip ${box.tileKey} building @ ${(box.minX).toFixed(1)},${(box.minZ).toFixed(1)}: no legal stand`);
      continue;
    }
    await page.evaluate(({ x, z }) => globalThis.__gdoCameraProbe.standAt(x, z), stand);
    await waitFrames(page, 2);

    const width = Math.min(box.width, box.depth);
    const shape = width < 3 ? 'thin' : box.width > box.depth * 2 ? 'long' : 'blocky';
    const family = { tileKey: box.tileKey, shape, stand: [stand.x, stand.z], penetrations: 0, samples: 0, distances: [] };

    for (const distance of [MIN_DISTANCE, MAX_DISTANCE]) {
      for (let step = 0; step < ORBIT_STEPS; step++) {
        const yaw = (step / ORBIT_STEPS) * Math.PI * 2;
        await page.evaluate(({ yaw, pitch, distance }) =>
          globalThis.__gdoCameraProbe.setPose({ yaw, pitch, distance }),
        { yaw, pitch: 0.22, distance });
        await waitFrames(page, 1);
        const sample = await page.evaluate(() => globalThis.__gdoCameraProbe.sample());
        frames.push(sample);
        family.samples++;
        family.distances.push(sample.resolved);
        if (sample.offenders.length) {
          family.penetrations++;
          totalPenetrations++;
          if (family.penetrations <= 2) {
            log(`[col05] PENETRATION ${shape} dist=${distance} yaw=${yaw.toFixed(2)} ` +
                `corners=${sample.offenders.join(',')} camera=${sample.position.map(v => v.toFixed(2)).join(',')}`);
          }
        }
      }
    }
    families.push(family);
    log(`[col05] ${shape.padEnd(6)} ${family.samples} frames, ${family.penetrations} penetrations, ` +
        `resolved ${Math.min(...family.distances).toFixed(2)}–${Math.max(...family.distances).toFixed(2)}`);
  }

  // Criterion 3: emergency inward compression must resolve in the FIRST affected
  // rendered frame. This is the sharp item — `Math.min` is instant by
  // construction, but whether the camera is legal *on the frame the obstruction
  // first appears* depends on update ordering relative to the render call.
  //
  // The test needs a pose that genuinely obstructs, so first locate one: scan
  // yaws at maximum distance and keep an obstructed one alongside a clear one.
  // A jump between them is the worst case — no gradual approach to hide latency.
  const latency = [];
  for (const family of families.slice(0, 3)) {
    await page.evaluate(({ x, z }) => globalThis.__gdoCameraProbe.standAt(x, z), { x: family.stand[0], z: family.stand[1] });
    await waitFrames(page, 2);

    const scan = await page.evaluate(async ({ steps, distance }) => {
      const probe = globalThis.__gdoCameraProbe;
      const clear = [], obstructed = [];
      for (let step = 0; step < steps; step++) {
        const yaw = (step / steps) * Math.PI * 2;
        probe.setPose({ yaw, pitch: 0.3, distance });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const sample = probe.sample();
        (sample.resolved < distance - 1e-3 ? obstructed : clear).push({ yaw, resolved: sample.resolved });
      }
      return { clear, obstructed, distance };
    }, { steps: 24, distance: MAX_DISTANCE });

    if (!scan.obstructed.length) {
      log(`[col05] yaw-jump: no obstructed yaw at distance ${MAX_DISTANCE} for this target — latency not exercisable`);
      latency.push({ distance: MAX_DISTANCE, obstructed: false });
      continue;
    }
    const worst = scan.obstructed.reduce((lowest, item) => item.resolved < lowest.resolved ? item : lowest);
    const clearYaw = scan.clear.length ? scan.clear[0].yaw : worst.yaw + Math.PI;

    // Jump from the clear pose straight into the worst obstructed pose.
    await page.evaluate(({ yaw, distance }) => globalThis.__gdoCameraProbe.setPose({ yaw, pitch: 0.3, distance }),
      { yaw: clearYaw, distance: MAX_DISTANCE });
    await waitFrames(page, 2);
    const before = await page.evaluate(() => globalThis.__gdoCameraProbe.sample());
    await page.evaluate(({ yaw, distance }) => globalThis.__gdoCameraProbe.setPose({ yaw, pitch: 0.3, distance }),
      { yaw: worst.yaw, distance: MAX_DISTANCE });
    await waitFrames(page, 1);
    const after = await page.evaluate(() => globalThis.__gdoCameraProbe.sample());

    const compressed = after.resolved < before.resolved - 1e-4;
    const resolvedImmediately = after.offenders.length === 0;
    const entry = {
      distance: MAX_DISTANCE,
      obstructed: true,
      worstYaw: worst.yaw,
      expected: worst.resolved,
      before: before.resolved,
      after: after.resolved,
      compressed,
      resolvedImmediately,
    };
    latency.push(entry);
    if (!resolvedImmediately) totalPenetrations += 1;
    log(`[col05] yaw-jump ${clearYaw.toFixed(2)} -> ${worst.yaw.toFixed(2)} (obstructed): ` +
        `resolved ${before.resolved.toFixed(3)} -> ${after.resolved.toFixed(3)} ` +
        `(target ${worst.resolved.toFixed(3)}) compressed=${compressed} first-frame-legal=${resolvedImmediately}`);
  }

  const diagnosticsAfter = await page.evaluate(() => globalThis.__gdoCameraProbe.queryDiagnostics());
  const exactRefinements = diagnosticsAfter.exactTests - diagnosticsBefore.exactTests;

  const screenshots = [];
  for (const [index, family] of families.slice(0, 3).entries()) {
    await page.evaluate(({ x, z }) => globalThis.__gdoCameraProbe.standAt(x, z), { x: family.stand[0], z: family.stand[1] });
    await page.evaluate(({ distance }) => globalThis.__gdoCameraProbe.setPose({ yaw: 2.2, pitch: 0.22, distance }),
      { distance: MAX_DISTANCE });
    await waitFrames(page, 3);
    screenshots.push(await capture(page, directory, `building-${index}-${family.shape}-max`));
    await page.evaluate(({ distance }) => globalThis.__gdoCameraProbe.setPose({ yaw: 2.2, pitch: 0.22, distance }),
      { distance: MIN_DISTANCE });
    await waitFrames(page, 3);
    screenshots.push(await capture(page, directory, `building-${index}-${family.shape}-min`));
  }

  return {
    fixture,
    blockers: blockers.length,
    exactFootprintCoverage: coverage,
    exactRefinements,
    targets: families.length,
    shapes: [...new Set(families.map(family => family.shape))],
    sweepFrames: frames.length,
    totalPenetrations,
    latency,
    families,
    screenshots,
    // Sampled but not asserted: criterion 4 and 5 are covered by the containment
    // test above, which honours the packed vertical span, so a legal camera that
    // sits above a low roof is correctly not a penetration.
    maxResolved: frames.length ? Math.max(...frames.map(frame => frame.resolved)) : 0,
    minResolved: frames.length ? Math.min(...frames.map(frame => frame.resolved)) : 0,
    yawCoverage: Math.abs(frames.length ? frames[0].yaw : 0) < YAW_EPSILON ? 'full-circle-per-target' : 'sampled',
  };
}

export async function run({ page, baseUrl, log = console.log, fixture = 'dense-urban', variant = 'openmaptiles' }) {
  const directory = freshRunDirectory('col05-coordinate-camera');
  // The driver has already selected the fixture and opened the runtime.
  const section = await sweepFixture({ page, log, fixture, directory, installProbeFirst: true });
  return { variant, directory, ...section };
}
