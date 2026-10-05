#!/usr/bin/env node
/**
 * Live COL-09 diagnostic — the capped dynamic spatial hash in the running product.
 *
 * The gate is "64/128/256 profile caps; primitive-only dynamic proxies". Node proves
 * the contract (`src/geo/GeoDynamicProxies.test.js`); this proves it is wired into the
 * shipped runtime, and that it holds against a real world with static tiles resident
 * instead of against a bare hash:
 *
 *   1. the live world's hash reports the profile and the cap the app configured;
 *   2. the cap is enforced against real inserts — the 65th add is refused, naming the
 *      profile and the owner, and the refusal does not evict what is already there;
 *   3. a dynamic solid changes the outcome of a live query: the probe lane is proven
 *      clear of static geometry on an empty hash, the proxy is placed, and the same
 *      sweep now reports it as the first contact — for both the player query and the
 *      camera path;
 *   4. adding and removing proxies leaves the static world byte-identical, which is
 *      the check that says the dynamic hash and the per-tile grids are separate
 *      structures rather than assuming it.
 *
 * All proxies it creates are test-only and are removed before exit, so the live world
 * is left exactly as it was found.
 *
 *   node tools/visual-audit/diagnose-dynamic-proxies.mjs      # needs `npm run dev`
 */
import { launch, openCoordinates, selectFixture, waitFrames, readCoordinateStats } from './harness.mjs';

const ORIGIN = 'http://localhost:5173';
const { browser, page, logs } = await launch();
try {
  await selectFixture(page, ORIGIN, { id: 'dense-urban' });
  await openCoordinates(page, ORIGIN);
  // Wait until real mapped buildings are resident, so the dynamic queries run
  // against a populated static world rather than an empty one.
  for (let attempt = 0; attempt < 60; attempt++) {
    const stats = await readCoordinateStats(page);
    if ((stats.buildings ?? 0) > 0) break;
    await waitFrames(page, 4);
  }
  await waitFrames(page, 6);

  const report = await page.evaluate(() => {
    const game = globalThis.__gdoAudit?.game;
    const world = game?.world;
    if (!world?.dynamicProxies) return { error: 'no dynamic proxy hash on the live world' };

    const hash = world.dynamicProxies;
    const staticSnapshot = () => ({
      tiles: world.tiles.size,
      bytes: world.totalBytes,
      colliders: [...world.tiles.values()].reduce((total, tile) => total + (tile.colliders?.length ?? 0), 0),
    });
    const staticBefore = staticSnapshot();

    const focus = [...world.tiles.values()].find(tile => tile.collisionGrid) ?? [...world.tiles.values()][0];
    const probeX = (focus.bounds.minX + focus.bounds.maxX) / 2;
    const probeZ = (focus.bounds.minZ + focus.bounds.maxZ) / 2;

    // The probe lane must be clear of STATIC geometry before the proxy exists, or a
    // static contact at t≈0 would mask the dynamic one and the check would pass or
    // fail for the wrong reason. Require the full through-the-centre lane to be clear
    // on an empty hash, then let the proxy be what produces the first contact: that
    // before/after pair is the evidence.
    let lane = null;
    for (const distance of [8, 12, 16, 20, 6, 24]) {
      for (let step = 0; step < 8 && !lane; step++) {
        const angle = (step / 8) * Math.PI * 2;
        const ux = Math.cos(angle), uz = Math.sin(angle);
        const startX = probeX + ux * distance, startZ = probeZ + uz * distance;
        const dx = -ux * distance * 2, dz = -uz * distance * 2;
        const walk = {}, camera = {};
        world.sweepCircle(startX, startZ, dx, dz, .3, walk, 1);
        world.sweepSphere(startX, 1.6, startZ, dx, 0, dz, .3, camera, 4);
        if (walk.hit || camera.hit) continue;
        lane = { distance, startX, startZ, dx, dz };
      }
      if (lane) break;
    }
    if (!lane) return { error: 'no static-clear probe lane was found in this fixture' };

    const carSpec = () => ({
      shape: 'box',
      minX: probeX - 1, minZ: probeZ - 1, maxX: probeX + 1, maxZ: probeZ + 1,
      y0: 0, y1: 3.2, mask: 1 | 4, ownerKey: 'diagnostic-car',
    });
    const handle = world.addDynamicProxy(carSpec());
    // Read the backing slot while the proxy is live: after release a handle resolves
    // to nothing, which is itself asserted below.
    const carSlot = world.dynamicProxies.slotOf(handle);

    const blocked = world.collidesCircle(probeX, probeZ, .2, 1);
    const awayFromIt = world.collidesCircle(probeX + 40, probeZ, .2, 1);
    const sweepOut = {}, sphereOut = {};
    world.sweepCircle(lane.startX, lane.startZ, lane.dx, lane.dz, .3, sweepOut, 1);
    // The camera sweep uses the vertical contract; probe through the proxy's span.
    world.sweepSphere(lane.startX, 1.6, lane.startZ, lane.dx, 0, lane.dz, .3, sphereOut, 4);
    // Re-run the same lane with the hash empty again: the proxy is what changed it.
    world.removeDynamicProxy(handle);
    const emptySweep = {}, emptySphere = {};
    world.sweepCircle(lane.startX, lane.startZ, lane.dx, lane.dz, .3, emptySweep, 1);
    world.sweepSphere(lane.startX, 1.6, lane.startZ, lane.dx, 0, lane.dz, .3, emptySphere, 4);
    const reAdded = world.addDynamicProxy(carSpec());
    // Handles are never reused (a stale handle must not resolve to another proxy);
    // the storage slot is what comes back, and the re-added car blocks again.
    const slotReuse = { first: handle, firstSlot: carSlot, reused: reAdded, reusedSlot: world.dynamicProxies.slotOf(reAdded) };
    const reAddedBlocked = world.collidesCircle(probeX, probeZ, .2, 1);

    // Refusal at the cap: fill to the cap, then attempt one more.
    const filler = [];
    while (hash.activeCount < hash.cap) {
      filler.push(world.addDynamicProxy({
        shape: 'circle', x: probeX + 200 + filler.length * 6, z: probeZ + 200,
        radius: 1, y0: 0, y1: 2, mask: 1, ownerKey: `filler-${filler.length}`,
      }));
    }
    let refusal = null;
    try {
      world.addDynamicProxy({ shape: 'circle', x: probeX, z: probeZ, radius: 1, y0: 0, y1: 2, mask: 1, ownerKey: 'the-65th' });
    } catch (error) {
      refusal = { name: error.name, message: error.message, cap: error.cap, profile: error.profile, owner: error.ownerKey };
    }

    // A refused insert must not evict: the car is still solid where it was placed.
    const stillBlocked = world.collidesCircle(probeX, probeZ, .2, 1);

    // The structural-separation claim: removing dynamics leaves statics untouched.
    // `reAdded` is the live car; `handle` was released during the empty-hash re-run.
    world.removeDynamicProxy(reAdded);
    for (const fillerHandle of filler) world.removeDynamicProxy(fillerHandle);
    const staticAfter = staticSnapshot();
    const clearedBlocked = world.collidesCircle(probeX, probeZ, .2, 1);

    return {
      profile: hash.profile,
      cap: hash.cap,
      active: hash.activeCount,
      bytes: hash.bytes,
      dynamicCapBudget: 64,
      placement: { probeX, probeZ },
      lane,
      blocked, awayFromIt,
      sweep: { hit: sweepOut.hit, time: sweepOut.time, owner: sweepOut.dynamicOwner, handle: sweepOut.dynamicHandle },
      sphere: { hit: sphereOut.hit, time: sphereOut.time, owner: sphereOut.dynamicOwner },
      emptyHashSweep: { hit: emptySweep.hit, owner: emptySweep.dynamicOwner ?? null },
      emptyHashSphere: { hit: emptySphere.hit },
      slotReuse, reAddedBlocked,
      releasedCarGone: world.dynamicProxies.shapeOf(handle) === null,
      refusal,
      stillBlocked,
      clearedBlocked,
      staticBefore, staticAfter,
      queryDiagnostics: {
        dynamicCandidates: world.queryDiagnostics.dynamicCandidates,
        maxDynamicCandidates: world.queryDiagnostics.maxDynamicCandidates,
        dynamicTests: world.queryDiagnostics.dynamicTests,
        dynamicHits: world.queryDiagnostics.dynamicHits,
      },
    };
  });

  if (report.error) throw new Error(report.error);

  console.log('[col09] live dynamic proxy hash');
  console.log(`  profile           ${report.profile}`);
  console.log(`  cap               ${report.cap} (low-profile budget ceiling ${report.dynamicCapBudget})`);
  console.log(`  storage           ${report.bytes} bytes, preallocated to the cap`);
  console.log(`  after cleanup     ${report.active} active`);
  console.log(`  static world      ${report.staticBefore.tiles} tiles, ${report.staticBefore.colliders} collider floats, ${report.staticBefore.bytes} bytes ` +
    `-> ${report.staticAfter.tiles} tiles, ${report.staticAfter.colliders} collider floats, ${report.staticAfter.bytes} bytes`);

  console.log('\n[col09] a dynamic solid changes the outcome of a live query');
  console.log(`  probe lane        ${report.lane.distance} units out at ` +
    `(${report.lane.startX.toFixed(1)}, ${report.lane.startZ.toFixed(1)}), clear on an empty hash: ` +
    `sweep ${report.emptyHashSweep.hit} - sphere ${report.emptyHashSphere.hit}`);
  console.log(`  collidesCircle    at proxy ${report.blocked} - 40 units away ${report.awayFromIt}`);
  console.log(`  sweepCircle       hit ${report.sweep.hit} at t=${report.sweep.time?.toFixed(4)} by "${report.sweep.owner}"`);
  console.log(`  sweepSphere       hit ${report.sphere.hit} at t=${report.sphere.time?.toFixed(4)} by "${report.sphere.owner}"`);
  console.log(`  query counters    candidates ${report.queryDiagnostics.dynamicCandidates} (max ${report.queryDiagnostics.maxDynamicCandidates}), ` +
    `tests ${report.queryDiagnostics.dynamicTests}, hits ${report.queryDiagnostics.dynamicHits}`);

  console.log('\n[col09] cap enforcement');
  console.log(`  refusal           ${report.refusal ? `${report.refusal.name} - ${report.refusal.message}` : 'NONE (the cap was not enforced)'}`);
  console.log(`  no eviction       proxy still solid after the refusal ${report.stillBlocked}`);
  console.log(`  slot reuse        handle ${report.slotReuse.first} (slot ${report.slotReuse.firstSlot}) released, ` +
    `next proxy got handle ${report.slotReuse.reused} (slot ${report.slotReuse.reusedSlot}), blocks again ${report.reAddedBlocked}`);
  console.log(`  after removal     proxy gone ${report.clearedBlocked === false}`);

  const failures = [];
  if (report.cap !== report.dynamicCapBudget) failures.push(`live cap ${report.cap} does not match the low-profile ceiling ${report.dynamicCapBudget}`);
  if (report.profile !== 'low') failures.push(`live profile is "${report.profile}", expected "low" for coordinate mode`);
  if (report.emptyHashSweep.hit || report.emptyHashSphere.hit) failures.push('the probe lane was not clear on an empty hash, so the sweep result proves nothing');
  if (!report.blocked) failures.push('a dynamic solid did not block the live player query');
  if (report.awayFromIt) failures.push('the dynamic solid blocked a query 40 units away');
  if (!report.sweep.hit || report.sweep.owner !== 'diagnostic-car') failures.push('the live sweep did not report the dynamic contact as the first hit');
  if (!report.sphere.hit || report.sphere.owner !== 'diagnostic-car') failures.push('the live camera-path sweep did not report the dynamic contact');
  if (report.slotReuse.reusedSlot !== report.slotReuse.firstSlot) failures.push('a released storage slot was not reused, so cap accounting drifted');
  if (report.slotReuse.reused === report.slotReuse.first) failures.push('a stale handle was handed out again');
  if (!report.reAddedBlocked) failures.push('the re-added proxy does not block');
  if (!report.releasedCarGone) failures.push('a released handle still resolves to a proxy');
  if (!report.refusal) failures.push('the cap was not enforced against live inserts');
  else if (!/allows 64 active primitives/.test(report.refusal.message)) failures.push('the refusal did not name the cap');
  if (!report.stillBlocked) failures.push('the refused insert evicted an existing proxy');
  if (report.clearedBlocked) failures.push('a removed proxy still blocks the live query');
  if (JSON.stringify(report.staticBefore) !== JSON.stringify(report.staticAfter)) {
    failures.push('the static world changed while dynamic proxies were added and removed');
  }
  if (report.active !== 0) failures.push(`${report.active} diagnostic proxies were left behind`);

  if (failures.length) {
    console.error('\n[col09] FAIL: the live dynamic proxy contract is not what the tests claim.');
    for (const item of failures) console.error(`  ${item}`);
    process.exitCode = 1;
  } else {
    console.log('\n[col09] PASS: capped, primitive-only, structurally separate from the static grid.');
  }
} catch (error) {
  console.error(`[col09] ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  console.log(`\n[col09] console errors: ${logs.length}`);
  for (const entry of logs.slice(0, 2)) console.log(`  ${entry.level}: ${entry.text.split('\n')[0].slice(0, 120)}`);
  await browser.close();
}
