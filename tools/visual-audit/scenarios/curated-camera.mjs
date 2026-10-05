/**
 * COL-06 — Curated camera structure obstruction.
 *
 * Roadmap gate: "All current static bridge/landmark/sign/skyline/rail masses have
 * tight tested compounds; moving audit remains."
 * Research criteria: CLIPPING_AND_LAYERING_RESEARCH.md §15.3 items 1-5.
 *
 * WHAT THIS PROVES
 * 1. Orbit sweeps at minimum and maximum TPP distance around every structural
 *    family, sampling EVERY rendered frame, never place the camera inside a
 *    CAMERA_BLOCKER. The camera must never render from inside geometry.
 * 2. Inward compression resolves within the first affected frame. The `Math.min`
 *    path cannot leave the camera beyond the clipped allowance, and this measures
 *    whether that holds against the real render loop.
 * 3. The Gateway arch is a compound of tight boxes rather than one enclosing
 *    AABB: a horizontal sweep through the opening stays legal even though the
 *    union box of those same blockers contains that sweep.
 *
 * Every frame is real rendered output from the actual game, and the assertions
 * read the same objects the renderer uses.
 */
import { capture, freshRunDirectory, waitFrames } from '../harness.mjs';

const MIN_DISTANCE = 10;
const MAX_DISTANCE = 65;
const PITCH = .35;

/** Install page-side helpers once per loaded document. */
async function installHelpers(page) {
  await page.evaluate(() => {
    const game = globalThis.__gdoAudit.game;
    const blockers = game.bridges.cameraBlockers;
    let pinned = null;

    const inside = (point, box) =>
      point.x > box.min.x && point.x < box.max.x &&
      point.y > box.min.y && point.y < box.max.y &&
      point.z > box.min.z && point.z < box.max.z;

    const applyPin = () => {
      if (!pinned) return;
      const player = game.player;
      player.position.set(pinned.x, pinned.y, pinned.z);
      player.velocity.set(0, 0, 0);
      player.grounded = true;
      player.root.position.copy(player.position);
      player.orbit.target.copy(player.position).y += 2;
    };

    const penetration = () => {
      const position = game.camera.position;
      for (const box of blockers) if (inside(position, box)) return box.userData?.id ?? 'unlabelled-blocker';
      return null;
    };

    /**
     * The camera orbits `player.position + (0,2,0)`. If the harness teleports the
     * player inside a solid, that target sits inside a blocker and the sweep can
     * never be legal — a harness defect, not a product defect. Teleporting
     * bypasses collision, so the stand position must be validated explicitly.
     */
    const targetBlocker = () => {
      const target = game.player.position;
      for (const box of blockers) {
        if (target.x > box.min.x && target.x < box.max.x &&
            target.y + 2 > box.min.y && target.y + 2 < box.max.y &&
            target.z > box.min.z && target.z < box.max.z) {
          return box.userData?.id ?? 'unlabelled-blocker';
        }
      }
      return null;
    };

    globalThis.__audit = {
      version: globalThis.__gdoAudit.version,
      mode: globalThis.__gdoAudit.mode,
      inventory() {
        return blockers.map(box => ({
          id: box.userData?.id ?? 'unlabelled-blocker',
          size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z],
          center: [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2],
        }));
      },
      /** Mirror of curatedCameraSweepRadius so probes use the rendered radius. */
      sweepRadius() {
        const camera = game.camera;
        const halfHeight = Math.tan((camera.fov * Math.PI) / 360) * camera.near;
        const halfWidth = halfHeight * Math.max(.25, camera.aspect || 1);
        return Math.min(1.25, Math.max(.6, Math.hypot(halfWidth, halfHeight) + .15));
      },
      /** Pin the player. `y` defaults to the terrain/bridge height at x,z. */
      pin({ x, y, z }) {
        pinned = { x, y: Number.isFinite(y) ? y : game.player.groundAt(x, z), z };
        applyPin();
        return { ...pinned };
      },
      /** Aim the orbit camera; re-pins so a sweep measures the camera, not drift. */
      aim({ yaw, pitch = .35, distance }) {
        applyPin();
        const orbit = game.player.orbit;
        orbit.yaw = yaw;
        orbit.pitch = pitch;
        orbit.distance = distance;
        return { yaw, pitch, distance };
      },
      sample() {
        const position = game.camera.position;
        return {
          camera: [position.x, position.y, position.z],
          insideId: penetration(),
          targetInsideId: targetBlocker(),
          resolvedDistance: game.player.orbit.resolvedDistance,
          idealDistance: game.player.orbit.distance,
        };
      },
      /** Validate a candidate stand position before using it for a sweep. */
      standCheck({ x, z }) {
        const ground = game.player.groundAt(x, z);
        const previous = game.player.position.clone?.();
        game.player.position.set(x, ground, z);
        const blocker = targetBlocker();
        if (previous) game.player.position.copy(previous);
        return { ground, targetInsideId: blocker };
      },
      /**
       * Per-frame recorder. The tick re-pins before sampling so each entry is the
       * pose that frame actually rendered with a static player.
       */
      startRecorder() {
        const samples = [];
        let running = true;
        const tick = () => {
          if (!running) return;
          applyPin();
          samples.push({
            insideId: penetration(),
            targetInsideId: targetBlocker(),
            camera: [game.camera.position.x, game.camera.position.y, game.camera.position.z],
            resolvedDistance: game.player.orbit.resolvedDistance,
            idealDistance: game.player.orbit.distance,
          });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        globalThis.__auditStopRecorder = () => { running = false; return samples; };
      },
      stopRecorder() { return globalThis.__auditStopRecorder?.() ?? []; },
      /**
       * Direct probe against the real clipCamera. An orbit cannot express
       * "sweep through the opening", so the arch criterion is tested directly.
       */
      probe({ target, desired, radius }) {
        const out = {};
        game.bridges.clipCamera(
          { x: target[0], y: target[1], z: target[2] },
          {
            x: desired[0], y: desired[1], z: desired[2],
            distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z); },
            set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; },
          },
          radius,
          out,
        );
        return { blocked: Boolean(out.blocked), time: out.time, amount: out.amount };
      },
      /**
       * Slab test for "does this swept segment cross the box". A single enclosing
       * AABB would report blocked for any segment crossing it, so comparing this
       * against the real clipCamera result proves the compounds are tight.
       */
      segmentHitsBox({ from, to, min, max }) {
        let enter = 0;
        let exit = 1;
        for (const axis of [0, 1, 2]) {
          const origin = from[axis];
          const delta = to[axis] - origin;
          const low = min[axis];
          const high = max[axis];
          if (Math.abs(delta) < 1e-9) {
            if (origin < low || origin > high) return false;
            continue;
          }
          let first = (low - origin) / delta;
          let second = (high - origin) / delta;
          if (first > second) { const swap = first; first = second; second = swap; }
          enter = Math.max(enter, first);
          exit = Math.min(exit, second);
          if (enter > exit) return false;
        }
        return true;
      },
      /** Union box of the gateway family: what a single enclosing AABB would be. */
      gatewayUnion() {
        const boxes = blockers.filter(box => box.userData?.id?.startsWith('gateway:'));
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (const box of boxes) {
          min[0] = Math.min(min[0], box.min.x); min[1] = Math.min(min[1], box.min.y); min[2] = Math.min(min[2], box.min.z);
          max[0] = Math.max(max[0], box.max.x); max[1] = Math.max(max[1], box.max.y); max[2] = Math.max(max[2], box.max.z);
        }
        return { count: boxes.length, min, max };
      },
    };
  });
}

/** One representative stand position per structural family, from live data. */
function selectTargets(inventory) {
  const byId = id => inventory.find(entry => entry.id === id);
  const byPrefix = prefix => inventory.find(entry => entry.id.startsWith(prefix));
  const from = (family, entry) => entry
    ? { family, id: entry.id, center: entry.center, size: entry.size }
    : null;
  return [
    from('landmark:gateway-pier', byId('gateway:pier:-1')),
    from('landmark:gateway-tower', byId('gateway:tower:-11:-4')),
    from('structure:tech-tower', byPrefix('tech-tower')),
    from('structure:skyline-tower', byPrefix('skyline-tower')),
    from('railway:pier', byPrefix('railway:pier')),
    from('railway:deck', byPrefix('railway:deck')),
  ].filter(Boolean);
}

/**
 * Find a stand position whose orbit target is outside every blocker. Candidates
 * fan outward from the structure so a sweep always starts from legal ground.
 */
async function chooseStand(page, entry) {
  const candidates = [];
  for (const radius of [20, 24, 28, 32]) {
    for (let step = 0; step < 8; step++) {
      const angle = (step / 8) * Math.PI * 2;
      candidates.push([
        entry.center[0] + Math.cos(angle) * radius,
        entry.center[2] + Math.sin(angle) * radius,
      ]);
    }
  }
  for (const [x, z] of candidates) {
    const check = await page.evaluate(({ x, z }) => globalThis.__audit.standCheck({ x, z }), { x, z });
    if (!check.targetInsideId) return { stand: [x, z], ground: check.ground };
  }
  return { stand: [candidates[0][0], candidates[0][1]], ground: null, fallback: true };
}

export async function run({ page, baseUrl, log = console.log }) {
  const directory = freshRunDirectory('col06-curated-camera');
  await installHelpers(page);

  const inventory = await page.evaluate(() => globalThis.__audit.inventory());
  const targets = selectTargets(inventory);
  log(`[COL-06] ${inventory.length} blockers, ${targets.length} representative targets`);

  for (const target of targets) {
    const chosen = await chooseStand(page, target);
    target.stand = chosen.stand;
    target.standFallback = Boolean(chosen.fallback);
    if (chosen.fallback) log(`[COL-06] WARNING: no legal stand found for ${target.family}`);
  }

  const results = [];
  const screenshots = [];
  const steps = 12;

  // --- 1. Orbit sweeps with per-frame penetration sampling -------------------
  for (const target of targets) {
    for (const distance of [MIN_DISTANCE, MAX_DISTANCE]) {
      await page.evaluate(({ x, z, distance: d }) => {
        globalThis.__audit.pin({ x, z });
        globalThis.__audit.aim({ yaw: 0, distance: d });
      }, { x: target.stand[0], z: target.stand[1], distance });
      await waitFrames(page, 4);
      await page.evaluate(() => globalThis.__audit.startRecorder());

      for (let step = 0; step < steps; step++) {
        await page.evaluate(({ yaw, distance: d }) => globalThis.__audit.aim({ yaw, distance: d }),
          { yaw: (step / steps) * Math.PI * 2, distance });
        await waitFrames(page, 2);
        await page.evaluate(() => globalThis.__audit.sample());
      }

      const recorded = await page.evaluate(() => globalThis.__audit.stopRecorder());
      const penetrations = recorded.filter(entry => entry.insideId);
      const compressed = recorded.filter(entry => entry.resolvedDistance < entry.idealDistance - .01).length;
      const targetInside = recorded.filter(entry => entry.targetInsideId).length;
      results.push({
        family: target.family, id: target.id, distance,
        stand: target.stand,
        framesSampled: recorded.length,
        penetrations: penetrations.length,
        penetrationIds: [...new Set(penetrations.map(entry => entry.insideId))],
        penetrationExamples: penetrations.slice(0, 3).map(entry => ({
          id: entry.insideId, camera: entry.camera.map(value => Number(value.toFixed(2))),
        })),
        framesWithTargetInsideBlocker: targetInside,
        compressedFrames: compressed,
      });
      log(`[COL-06] orbit ${target.family} @${distance}u: ${recorded.length} frames, ` +
          `${penetrations.length} penetrations, ${compressed} compressed` +
          (targetInside ? `, TARGET-INSIDE=${targetInside}` : ''));
    }
  }

  // --- 2. Compression latency after a forced 180-degree yaw jump -------------
  const jumpTarget = targets[0];
  await page.evaluate(({ x, z, distance }) => {
    globalThis.__audit.pin({ x, z });
    globalThis.__audit.aim({ yaw: 0, distance });
  }, { x: jumpTarget.stand[0], z: jumpTarget.stand[1], distance: MAX_DISTANCE });
  await waitFrames(page, 8);
  await page.evaluate(() => globalThis.__audit.startRecorder());
  await page.evaluate(({ distance }) => globalThis.__audit.aim({ yaw: Math.PI, distance }), { distance: MAX_DISTANCE });
  await waitFrames(page, 12);
  const jumpRecorded = await page.evaluate(() => globalThis.__audit.stopRecorder());
  const jumpPenetrations = jumpRecorded.filter(entry => entry.insideId);
  results.push({
    family: 'compression-latency', id: jumpTarget.id,
    framesSampled: jumpRecorded.length,
    penetrations: jumpPenetrations.length,
    penetrationIds: [...new Set(jumpPenetrations.map(entry => entry.insideId))],
    firstLegalFrame: jumpRecorded.findIndex(entry => !entry.insideId),
  });
  log(`[COL-06] 180-degree jump: ${jumpRecorded.length} frames, ${jumpPenetrations.length} penetrations`);

  // --- 3. Gateway arch: tight compound versus enclosing AABB -----------------
  const sweepRadius = await page.evaluate(() => globalThis.__audit.sweepRadius());
  const union = await page.evaluate(() => globalThis.__audit.gatewayUnion());
  const pinResult = await page.evaluate(() => globalThis.__audit.pin({ x: -66, y: 4, z: -44 }));
  await waitFrames(page, 3);
  const throughOpening = await page.evaluate(({ r }) => globalThis.__audit.probe({
    target: [-66, 6, -44], desired: [-66, 6, -24], radius: r,
  }), { r: sweepRadius });
  const intoPier = await page.evaluate(({ r }) => globalThis.__audit.probe({
    target: [-66, 6, -44], desired: [-76, 6, -44], radius: r,
  }), { r: sweepRadius });
  // The swept opening segment runs from the arch centre to a point beyond it.
  // It crosses the union of the gateway blockers, so an enclosing AABB would
  // have blocked it; only tight compounds let it through.
  const unionWouldBlock = await page.evaluate(({ min, max }) => globalThis.__audit.segmentHitsBox({
    from: [-66, 6, -44], to: [-66, 6, -24], min, max,
  }), { min: union.min, max: union.max });
  const arch = {
    family: 'gateway-arch', id: 'gateway',
    sweepRadius,
    blockerCount: union.count,
    unionBox: { min: union.min, max: union.max },
    pin: pinResult,
    throughOpeningBlocked: throughOpening.blocked,
    intoPierBlocked: intoPier.blocked,
    unionWouldBlock,
  };
  results.push(arch);
  log(`[COL-06] arch (radius ${sweepRadius.toFixed(3)}): through-opening=` +
      `${throughOpening.blocked ? 'BLOCKED' : 'open'}, into-pier=` +
      `${intoPier.blocked ? 'blocked' : 'OPEN'}, union-would-block=${unionWouldBlock}`);

  // --- 4. Human-reviewable frames -------------------------------------------
  const reviewPoses = [
    { name: 'gateway-arch-front', x: -66, y: 4, z: -24, yaw: 0, pitch: .18, distance: 34 },
    { name: 'gateway-pier-compressed', x: -57, z: -44, yaw: -Math.PI / 2, pitch: .3, distance: MAX_DISTANCE },
    { name: 'gateway-tower-wide', x: -66, z: -22, yaw: 0, pitch: .5, distance: MAX_DISTANCE },
    { name: 'railway-deck', x: targets.at(-1).stand[0], z: targets.at(-1).stand[1], yaw: Math.PI, pitch: .25, distance: 40 },
  ];
  for (const pose of reviewPoses) {
    await page.evaluate(({ x, y, z, yaw, pitch, distance }) => {
      globalThis.__audit.pin({ x, y, z });
      globalThis.__audit.aim({ yaw, pitch, distance });
    }, pose);
    await waitFrames(page, 5);
    screenshots.push(await capture(page, directory, pose.name));
    log(`[COL-06] frame ${pose.name}`);
  }

  const sweeps = results.filter(entry => entry.family !== 'compression-latency' && entry.family !== 'gateway-arch');
  return {
    scenario: 'col06-curated-camera',
    directory,
    blockers: inventory.length,
    targets: targets.map(target => target.id),
    sweepFrames: sweeps.reduce((sum, entry) => sum + entry.framesSampled, 0),
    totalPenetrations: results.reduce((sum, entry) => sum + (entry.penetrations ?? 0), 0),
    archPreserved: !throughOpening.blocked && intoPier.blocked && unionWouldBlock,
    results,
    screenshots,
  };
}
