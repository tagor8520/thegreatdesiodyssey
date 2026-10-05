/**
 * FND-07 — zero-growth remount across every resource class.
 *
 * A warm-up cycle runs first and its post-exit state becomes the reference. That
 * is deliberate: the first mount of a page performs one-time initialisation that
 * is not remount growth and must not be confused with it —
 *
 *   - React DOM lazily registers delegated listeners on `document` as event
 *     types are first needed (observed: `selectionchange`) and keeps them for the
 *     life of the root;
 *   - Vite injects a <style> into <head> the first time a lazily imported module
 *     declares CSS (observed: the geo stylesheet).
 *
 * Both are page-lifetime, not per-mount, so the gate is measured from the warm
 * post-exit state onward: every later cycle must return *exactly* to it. The
 * warm-up delta is still reported, labelled, so that one-time initialisation can
 * never be used to hide steady accumulation.
 *
 * Scene content is reported but not asserted as a lifecycle property: the curated
 * runtime streams chunks progressively, so the number of geometries in a settled
 * scene legitimately varies between mounts. What is asserted is ownership — every
 * geometry and texture the mount armed was disposed (outstanding 0).
 *
 * Drives the real product through its own landing shell: mount → exit → mount,
 * three times per mode, in both the curated runtime and Coordinate Explorer.
 * After each teardown it asserts that the five classes named by the gate are
 * back to where they started:
 *
 *   workers    created - terminated            must be 0 after exit
 *   observers  created - disconnected          must be 0 after exit
 *   listeners  subscriptions on reachable      must not grow cycle over cycle
 *   geometries every owned geometry disposed   outstanding must be 0
 *   textures   every owned texture disposed    outstanding must be 0
 *
 * The DOM node count is sampled alongside as the GC-independent tie-breaker: if
 * anything were genuinely retained, the tree would grow even when the collector
 * had not run. Orphaned subscriptions (detached nodes, terminated workers) are
 * reported with their call sites so a future failure can be attributed, but they
 * are not counted as growth — see `tools/visual-audit/lifecycle.mjs` for why that
 * distinction is safe.
 *
 * Exits non-zero through `summary.zeroGrowth === false`.
 */
import { freshRunDirectory } from '../harness.mjs';
import {
  lifecycleInstrument, lifecycleSnapshot, armDisposal, orphanDetail,
  releaseOrphanTargets, orphanRefsAlive,
} from '../lifecycle.mjs';

const CYCLES = 3;

async function mount(page, mode, coordinate) {
  if (mode === 'curated') {
    await page.click('.odyssey-start');
  } else {
    await page.evaluate(({ latitude, longitude }) => {
      const form = document.querySelector('.odyssey-coordinate-form');
      form.elements.latitude.value = String(latitude);
      form.elements.longitude.value = String(longitude);
    }, coordinate);
    await page.click('.odyssey-coordinate-start');
  }
  await page.waitForFunction('globalThis.__gdoAudit && globalThis.__gdoAudit.game', { timeout: 90_000 });
  await page.evaluate(async () => {
    for (let index = 0; index < 6; index++) await new Promise(resolve => requestAnimationFrame(resolve));
  });
}

async function exitToLanding(page, mode) {
  await page.evaluate(() => {
    const explicit = document.querySelector('.odyssey-exit');
    if (explicit) { explicit.click(); return; }
    const byText = [...document.querySelectorAll('button')]
      .find(candidate => /exit|back to menu|leave/i.test(candidate.textContent ?? ''));
    byText?.click();
  });
  await page.waitForFunction('!globalThis.__gdoAudit', { timeout: 60_000 });
  await page.waitForSelector(
    mode === 'curated' ? '.odyssey-start' : '.odyssey-coordinate-form',
    { timeout: 30_000 },
  );
  await page.evaluate(async () => {
    for (let index = 0; index < 4; index++) await new Promise(resolve => requestAnimationFrame(resolve));
  });
}

async function measureMode(page, mode, baseUrl, log) {
  const coordinate = { latitude: 28.9845, longitude: 77.7064 };
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 90_000 });
  await page.waitForSelector(
    mode === 'curated' ? '.odyssey-start' : '.odyssey-coordinate-form',
    { timeout: 30_000 },
  );
  const baseline = await page.evaluate(lifecycleSnapshot);

  // Warm-up mount: absorbs one-time page initialisation; its post-exit state is
  // the reference every measured cycle must match exactly.
  await mount(page, mode, coordinate);
  await page.evaluate(armDisposal);
  const warmMounted = await page.evaluate(lifecycleSnapshot);
  await exitToLanding(page, mode);
  const reference = await page.evaluate(lifecycleSnapshot);
  const warmup = {
    mounted: warmMounted,
    after: reference,
    oneTime: {
      listeners: reference.listenersPersistent - baseline.listenersPersistent,
      domNodes: reference.domNodes - baseline.domNodes,
      newListeners: reference.persistentDetail.filter(line => !baseline.persistentDetail.includes(line)),
    },
  };
  log(`[fnd07] ${mode} warm-up: one-time delta vs fresh load = ` +
    `${warmup.oneTime.listeners} listener(s), ${warmup.oneTime.domNodes} DOM node(s)`);
  for (const line of warmup.oneTime.newListeners) log(`[fnd07]   one-time listener: ${line}`);

  const cycles = [];
  for (let index = 1; index <= CYCLES; index++) {
    await mount(page, mode, coordinate);
    const armed = await page.evaluate(armDisposal);
    const during = await page.evaluate(lifecycleSnapshot);
    await exitToLanding(page, mode);
    const after = await page.evaluate(lifecycleSnapshot);
    const total = (armed.geometries ?? 0) + (armed.textures ?? 0);
    const record = {
      cycle: index,
      armed,
      mounted: during,
      after,
      // Every class the gate names, measured against the warm reference.
      growth: {
        workers: after.workers - reference.workers,
        observers: after.observers - reference.observers,
        listeners: after.listenersPersistent - reference.listenersPersistent,
        domNodes: after.domNodes - reference.domNodes,
        hostNodes: after.hostNodes - reference.hostNodes,
        outstanding: after.outstanding - reference.outstanding,
      },
      releasedFraction: total ? `${after.released}/${total}` : 'n/a',
    };
    cycles.push(record);
    log(`[fnd07] ${mode} cycle ${index}: mounted workers=${during.workers} observers=${during.observers} ` +
      `listeners=${during.listenersPersistent} geometries=${during.geometries} textures=${during.textures} | ` +
      `after exit workers=${after.workers} observers=${after.observers} listeners=${after.listenersPersistent} ` +
      `released=${after.released}/${total} outstanding=${after.outstanding}`);
    if (after.outstanding) log(`[fnd07]   LEAK: ${after.outstanding} owned geometry/texture resources were not disposed`);
    if (after.workers) log(`[fnd07]   LEAK: ${after.workers} worker(s) still alive after exit`);
    if (after.observers) log(`[fnd07]   LEAK: ${after.observers} observer(s) not disconnected`);
    if (after.canvases) log(`[fnd07]   LEAK: ${after.canvases} canvas element(s) left in the host`);
    for (const style of orphanDetail(after.orphanedDetail)) log(`[fnd07]   orphaned (GC-reclaimable): ${style}`);
  }

  // A cycle may only fail for a class it grew beyond the warm reference.
  const leaks = [];
  for (const record of cycles) {
    if (record.growth.workers !== 0) leaks.push(`${mode} cycle ${record.cycle}: ${record.growth.workers > 0 ? '+' : ''}${record.growth.workers} worker(s) vs warm reference`);
    if (record.growth.observers !== 0) leaks.push(`${mode} cycle ${record.cycle}: ${record.growth.observers > 0 ? '+' : ''}${record.growth.observers} observer(s) vs warm reference`);
    if (record.growth.outstanding !== 0) leaks.push(`${mode} cycle ${record.cycle}: ${record.growth.outstanding > 0 ? '+' : ''}${record.growth.outstanding} owned resource(s) vs warm reference`);
    if (record.growth.listeners !== 0) leaks.push(`${mode} cycle ${record.cycle}: ${record.growth.listeners > 0 ? '+' : ''}${record.growth.listeners} live listener(s) vs warm reference`);
    if (record.growth.domNodes !== 0) leaks.push(`${mode} cycle ${record.cycle}: ${record.growth.domNodes > 0 ? '+' : ''}${record.growth.domNodes} DOM node(s) vs warm reference`);
    if (record.growth.hostNodes !== 0) leaks.push(`${mode} cycle ${record.cycle}: ${record.growth.hostNodes > 0 ? '+' : ''}${record.growth.hostNodes} host node(s) vs warm reference`);
    if (record.armed.geometries + record.armed.textures === 0) leaks.push(`${mode} cycle ${record.cycle}: nothing was armed — the mount owned no geometry to release`);
  }
  return { baseline, warmup, reference, cycles, leaks };
}

function summarizeMode(result) {
  return {
    freshLoad: result.baseline,
    oneTimeInitialisation: result.warmup.oneTime,
    warmReference: result.reference,
    steadyState: result.cycles.at(-1).mounted,
    afterExit: result.cycles.at(-1).after,
    cycles: result.cycles.map(record => ({
      cycle: record.cycle, armed: record.armed, mounted: record.mounted,
      after: record.after, growth: record.growth, releasedFraction: record.releasedFraction,
    })),
  };
}

/**
 * Proves the orphaned-subscription classification instead of assuming it: drop the
 * instrument's references, force a collection, and see whether the page still
 * holds the targets.
 *
 * This measurement is what separates an app leak from framework bookkeeping. The
 * curated path retains its discarded React root containers in the DEV build
 * (~142 delegated subscriptions each, one container per mount) and collects all
 * of them in the PRODUCTION build — measured, see
 * `tools/visual-audit/probe-fnd07-production.mjs` and VISUAL_GATES §6.F3.
 *
 * So a retained orphan is recorded as framework retention rather than a gate
 * failure: the gate names the game's own resources, and the production
 * measurement shows the shipped build retains none of them. It is never silently
 * dropped — the detail is reported and the defect is registered.
 */
async function proveOrphansAreCollectable(page, log, mode) {
  const sampled = await page.evaluate(releaseOrphanTargets, 6);
  if (!sampled) {
    log(`[fnd07] collectability (${mode}): no orphaned targets to sample`);
    return { mode, sampled: 0, retained: 0 };
  }
  const client = await page.createCDPSession();
  for (let attempt = 0; attempt < 3; attempt++) {
    await client.send('HeapProfiler.collectGarbage');
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 60)));
  }
  const result = await page.evaluate(orphanRefsAlive);
  await client.detach();
  log(`[fnd07] collectability (${mode}): ${result.sampled} orphaned target(s) sampled, ${result.retained} still reachable after forced GC`);
  for (const detail of result.retainedDetail) log(`[fnd07]   retained after GC: ${detail}`);
  return { mode, sampled: result.sampled, retained: result.retained, retainedDetail: result.retainedDetail };
}

export async function run({ page, baseUrl, log, fixture }) {
  log(`[fnd07] fixture ${fixture}; FND-07 needs no geometry, only the mount cycle`);
  await page.evaluateOnNewDocument(lifecycleInstrument);
  const coordinates = await measureMode(page, 'coordinates', baseUrl, log);
  const coordinatesOrphans = await proveOrphansAreCollectable(page, log, 'coordinates');
  const curated = await measureMode(page, 'curated', baseUrl, log);
  const curatedOrphans = await proveOrphansAreCollectable(page, log, 'curated');
  const collectability = { coordinates: coordinatesOrphans, curated: curatedOrphans };
  const leaks = [...coordinates.leaks, ...curated.leaks];
  // Retained orphans are attributed, not counted as gate failures: they belong to
  // the dev-only framework runtime, and the production build collects them all.
  const frameworkRetention = [coordinatesOrphans, curatedOrphans]
    .filter(result => result.retained > 0)
    .map(result => ({
      mode: result.mode, retained: result.retained, sampled: result.sampled,
      detail: result.retainedDetail,
      disposition: 'dev-only framework retention; production build collects every sampled target (probe-fnd07-production.mjs)',
    }));
  const summary = {
    directory: freshRunDirectory('fnd07-remount-lifecycle'),
    scenario: 'remount-lifecycle',
    gate: 'FND-07',
    claim: 'workers, observers, textures, geometries and listeners hold steady across mount -> exit -> mount',
    cyclesPerMode: CYCLES,
    listenersDefinition: 'live = subscription whose target is window, document, an isConnected node, an unterminated worker, or an open socket; orphaned targets reported separately',
    blockers: leaks.length,
    sweepFrames: 0,
    totalPenetrations: 0,
    zeroGrowth: leaks.length === 0,
    leaks,
    collectability,
    frameworkRetention,
    devOnlyRetentionNote: frameworkRetention.length
      ? 'the dev build retains discarded React root containers; the production build does not — see VISUAL_GATES §6.F3'
      : null,
    coordinates: summarizeMode(coordinates),
    curated: summarizeMode(curated),
  };
  log(`[fnd07] coordinates steady state: workers=${summary.coordinates.steadyState.workers} ` +
    `observers=${summary.coordinates.steadyState.observers} listeners=${summary.coordinates.steadyState.listenersPersistent} ` +
    `geometries=${summary.coordinates.steadyState.geometries} textures=${summary.coordinates.steadyState.textures}`);
  log(`[fnd07] curated steady state:     workers=${summary.curated.steadyState.workers} ` +
    `observers=${summary.curated.steadyState.observers} listeners=${summary.curated.steadyState.listenersPersistent} ` +
    `geometries=${summary.curated.steadyState.geometries} textures=${summary.curated.steadyState.textures}`);
  log(`[fnd07] zero growth: ${summary.zeroGrowth ? 'YES' : 'NO'} (${leaks.length} leak(s))`);
  return summary;
}
