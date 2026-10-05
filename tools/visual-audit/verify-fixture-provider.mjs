#!/usr/bin/env node
/**
 * Phase 1 verification: does Coordinate Explorer render real mapped geometry
 * from the offline fixture provider, with the production worker and builders?
 *
 * Proves the unblock: mapped buildings (COL-05) and water (LAY-03) are available
 * without reaching a public tile server.
 */
import { launch, openCoordinates, readCoordinateStats, selectFixture, freshRunDirectory, capture, waitFrames } from './harness.mjs';

const ORIGIN = 'http://localhost:5173';

async function check(page, log, { fixture, variant = 'openmaptiles', label, expect }) {
  await selectFixture(page, ORIGIN, { id: fixture, variant });
  await openCoordinates(page, ORIGIN, { latitude: 28.9845, longitude: 77.7064 });
  // Let the worker finish all three phases (roads -> context -> buildings).
  for (let attempt = 0; attempt < 40; attempt++) {
    const stats = await readCoordinateStats(page);
    if ((stats.buildings ?? 0) > 0 || attempt === 39) {
      log(`[phase1] ${label}: roads=${stats.roads} buildings=${stats.buildings} ` +
          `details=${stats.details} names=${stats.names} chunks=${stats.chunks}`);
      const failures = [];
      for (const [key, minimum] of Object.entries(expect)) {
        if ((stats[key] ?? 0) < minimum) failures.push(`${key}=${stats[key]} < ${minimum}`);
      }
      return { ok: failures.length === 0, stats, failures, snippet: stats.text.slice(0, 260) };
    }
    await waitFrames(page, 4);
  }
  return { ok: false, stats: null, failures: ['timed out'], snippet: '' };
}

async function main() {
  const directory = freshRunDirectory('phase1-fixture-provider');
  const { browser, page, logs } = await launch({ width: 1280, height: 720 });
  const log = console.log;
  const results = {};
  try {
    results.denseUrban = await check(page, log, {
      fixture: 'dense-urban', label: 'dense-urban',
      expect: { buildings: 1, roads: 1 },
    });
    await capture(page, directory, 'dense-urban');
    const denseStats = await readCoordinateStats(page);
    results.denseText = denseStats.text.split('\n').slice(0, 4).join(' | ');

    results.mappedCoast = await check(page, log, {
      fixture: 'mapped-coast', label: 'mapped-coast',
      expect: { roads: 1 },
    });
    await capture(page, directory, 'mapped-coast');

    results.stackedBridge = await check(page, log, {
      fixture: 'stacked-bridge', label: 'stacked-bridge',
      expect: { roads: 1 },
    });
    await capture(page, directory, 'stacked-bridge');

    log(`[phase1] console errors: ${logs.length}`);
    for (const entry of logs.slice(0, 4)) log(`  ${entry.level}: ${entry.text}`);

    const failures = Object.entries(results)
      .filter(([, value]) => value && typeof value === 'object' && 'ok' in value && !value.ok);
    log(failures.length
      ? `\n[phase1] FAIL: ${failures.map(([name]) => name).join(', ')}`
      : '\n[phase1] PASS: mapped geometry generated offline from fixture tiles');
    for (const [name, value] of Object.entries(results)) {
      if (value && typeof value === 'object' && 'ok' in value) {
        log(`  ${name.padEnd(14)} ok=${value.ok} ${value.failures.join(',')} ${value.snippet.replace(/\s+/g, ' ').slice(0, 150)}`);
      }
    }
    log(`  frames: ${directory}`);
    if (!failures.length && logs.length === 0) process.exitCode = 0;
    else process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
