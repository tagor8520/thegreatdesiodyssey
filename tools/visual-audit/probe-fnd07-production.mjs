#!/usr/bin/env node
/**
 * FND-07 production counterpart — does the SHIPPED build retain anything across a
 * curated remount?
 *
 * The `remount-lifecycle` scenario needs the dev-only audit bridge
 * (`globalThis.__gdoAudit`) to arm disposal and to know when a mount is live, so
 * it can only run against `npm run dev`. That leaves one question it cannot answer
 * on its own:
 *
 *   the curated path retains its discarded React root containers in the dev build
 *   (VISUAL_GATES §6.F3). Is that retention an app defect, or dev-only framework
 *   bookkeeping that ships to nobody?
 *
 * This probe answers it against `npm run preview`. It drives the real landing UI —
 * no audit bridge, it clicks the buttons a player clicks — and injects only the
 * measuring instrument. Then it drops the instrument's own references to the
 * orphaned targets, forces a collection over CDP, and checks whether the page
 * still holds them.
 *
 * As in the dev scenario, a warm-up cycle absorbs one-time page initialisation:
 * `react-dom` registers a delegated `selectionchange` on `document` the first time
 * it needs that event type and keeps it for the life of the root. The three
 * measured cycles must each land back on the warm reference exactly.
 *
 *   npm run build && npm run preview -- --host 0.0.0.0 --port 4173   # terminal 1
 *   node tools/visual-audit/probe-fnd07-production.mjs               # terminal 2
 *
 * Exit 0: every sampled discarded target was collected — nothing shipped retains a
 *         mount, so the §6.F3 retention is dev-only.
 * Exit 1: a target survived, or a measured cycle did not return to the warm
 *         reference — that would be a real leak in the shipped game.
 */
import fs from 'node:fs';
import path from 'node:path';
import { freshRunDirectory, launch, waitFrames } from './harness.mjs';
import {
  lifecycleInstrument, lifecycleSnapshot, releaseOrphanTargets, orphanRefsAlive,
} from './lifecycle.mjs';

const ORIGIN = 'http://localhost:4173/';
const CYCLES = 3;

async function exitToLanding(page) {
  await page.evaluate(() => {
    const button = document.querySelector('.odyssey-exit') ??
      [...document.querySelectorAll('button')].find(candidate => /exit/i.test(candidate.textContent ?? ''));
    button?.click();
  });
  await page.waitForSelector('.odyssey-start', { timeout: 60_000 });
  await waitFrames(page, 4);
}

/** One mount -> exit, driven through the real landing UI. */
async function mountCycle(page) {
  await page.click('.odyssey-start');
  await page.waitForFunction(
    () => Boolean(document.querySelector('.odyssey-exit') ??
      [...document.querySelectorAll('button')].some(button => /exit/i.test(button.textContent ?? ''))),
    { timeout: 60_000 },
  );
  await waitFrames(page, 6);
  await exitToLanding(page);
}

async function main() {
  const { browser, page, logs } = await launch();
  try {
    await page.evaluateOnNewDocument(lifecycleInstrument);
    await page.goto(ORIGIN, { waitUntil: 'networkidle2', timeout: 90_000 });
    await page.waitForSelector('.odyssey-start', { timeout: 30_000 });
    const baseline = await page.evaluate(lifecycleSnapshot);
    console.log(`[fnd07-prod] landing baseline: listeners=${baseline.listenersPersistent} dom=${baseline.domNodes} host=${baseline.hostNodes}`);

    await mountCycle(page);
    const reference = await page.evaluate(lifecycleSnapshot);
    const oneTime = {
      listeners: reference.listenersPersistent - baseline.listenersPersistent,
      domNodes: reference.domNodes - baseline.domNodes,
      newListeners: reference.persistentDetail.filter(line => !baseline.persistentDetail.includes(line)),
    };
    console.log(`[fnd07-prod] warm-up: one-time delta vs fresh load = ${oneTime.listeners} listener(s), ${oneTime.domNodes} DOM node(s)`);
    for (const line of oneTime.newListeners) console.log(`[fnd07-prod]   one-time listener: ${line}`);

    const cycles = [];
    for (let index = 1; index <= CYCLES; index++) {
      await page.click('.odyssey-start');
      await page.waitForFunction(
        () => Boolean(document.querySelector('.odyssey-exit') ??
          [...document.querySelectorAll('button')].some(button => /exit/i.test(button.textContent ?? ''))),
        { timeout: 60_000 },
      );
      await waitFrames(page, 6);
      const during = await page.evaluate(lifecycleSnapshot);
      await exitToLanding(page);
      const after = await page.evaluate(lifecycleSnapshot);
      console.log(`[fnd07-prod] cycle ${index}: mounted listeners=${during.listenersPersistent} canvi=${during.canvases} | ` +
        `after exit listeners=${after.listenersPersistent} (warm ${reference.listenersPersistent}) ` +
        `host=${after.hostNodes} canvi=${after.canvases} orphaned=${after.listenersOrphaned}`);
      cycles.push({
        cycle: index,
        mounted: { listeners: during.listenersPersistent, canvases: during.canvases },
        after: {
          listeners: after.listenersPersistent, hostNodes: after.hostNodes, canvases: after.canvases,
          orphaned: after.listenersOrphaned, domNodes: after.domNodes,
        },
      });
    }

    const sampled = await page.evaluate(releaseOrphanTargets, 6);
    const client = await page.createCDPSession();
    for (let attempt = 0; attempt < 3; attempt++) {
      await client.send('HeapProfiler.collectGarbage');
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 60)));
    }
    const result = await page.evaluate(orphanRefsAlive);
    await client.detach();
    console.log(`\n[fnd07-prod] collectability: ${sampled} discarded target(s) sampled, ${result.retained} retained after forced GC`);
    for (const detail of result.retainedDetail) console.log(`  retained: ${detail}`);

    // Every measured cycle must return to the warm reference exactly. (`orphaned`
    // is expected to rise: the instrument holds a reference to each discarded
    // target until `releaseOrphanTargets` drops it, which is what makes the
    // collectability check meaningful.)
    const failures = [];
    for (const record of cycles) {
      const { cycle, after } = record;
      if (after.canvases !== 0) failures.push(`cycle ${cycle}: ${after.canvases} canvas element(s) left in the host after exit`);
      if (after.listeners !== reference.listenersPersistent) failures.push(`cycle ${cycle}: live listeners moved to ${after.listeners} (warm reference ${reference.listenersPersistent})`);
      if (after.hostNodes !== reference.hostNodes) failures.push(`cycle ${cycle}: host subtree moved to ${after.hostNodes} nodes (warm reference ${reference.hostNodes})`);
      if (after.domNodes !== reference.domNodes) failures.push(`cycle ${cycle}: document moved to ${after.domNodes} nodes (warm reference ${reference.domNodes})`);
    }
    if (result.retained > 0) {
      failures.push(`${result.retained}/${result.sampled} discarded target(s) still reachable — the shipped build retains a mount`);
    }

    const last = cycles.at(-1);
    const report = {
      scenario: 'fnd07-production-retention',
      gate: 'FND-07',
      claim: 'the shipped build retains nothing across a curated remount; the §6.F3 retention is dev-only',
      target: ORIGIN,
      cycles: CYCLES,
      warmUpOneTime: oneTime,
      reference: {
        listeners: reference.listenersPersistent, hostNodes: reference.hostNodes, domNodes: reference.domNodes,
      },
      freshLoad: {
        listeners: baseline.listenersPersistent, hostNodes: baseline.hostNodes, domNodes: baseline.domNodes,
      },
      measured: cycles,
      collectability: { sampled: result.sampled, retained: result.retained, retainedDetail: result.retainedDetail },
      failures,
      passed: failures.length === 0 && result.retained === 0,
    };
    const directory = freshRunDirectory('fnd07-production-retention');
    report.directory = directory;
    fs.writeFileSync(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

    console.log('\n[fnd07-prod] summary');
    console.log(`  exit state        listeners ${last.after.listeners} (warm ${reference.listenersPersistent}, fresh load ${baseline.listenersPersistent}), ` +
      `host nodes ${last.after.hostNodes} (${reference.hostNodes}), 0 canvases`);
    console.log(`  one-time init     ${oneTime.listeners} listener(s), ${oneTime.domNodes} DOM node(s)`);
    console.log(`  retained targets  ${result.retained}/${result.sampled} after forced GC`);
    console.log(`  console errors    ${logs.length}`);
    console.log(`  report            ${path.join(directory, 'report.json')}`);
    if (failures.length) {
      console.error('\n[fnd07-prod] FAIL: the production build retains state across a curated remount.');
      for (const failure of failures) console.error(`  ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log('\n[fnd07-prod] PASS: nothing shipped survives a remount; §6.F3 retention is dev-only.');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(`[fnd07-prod] ${error.stack || error.message}`);
  process.exitCode = 1;
});
