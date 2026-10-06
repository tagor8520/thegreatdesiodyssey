#!/usr/bin/env node
/**
 * Visual audit CLI.
 *
 *   npm run visual:audit -- --list
 *   npm run visual:audit -- curated-camera [--url http://localhost:5173/]
 *
 * Requires a running dev or preview server (`npm run dev`), because the harness
 * drives the real product through its own landing flow rather than a fixture
 * page. Results (JSON report + PNG frames) are written under
 * `tools/visual-audit/out/<timestamp>-<scenario>/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { launch, freshRunDirectory, classifyConsoleErrors } from './harness.mjs';
import * as curatedCamera from './scenarios/curated-camera.mjs';
import * as coordinateCamera from './scenarios/coordinate-camera.mjs';
import * as coordinateMatrix from './scenarios/coordinate-matrix.mjs';
import * as waterOrder from './scenarios/water-order.mjs';
import * as shimmerLowDpr from './scenarios/shimmer-low-dpr.mjs';
import * as remountLifecycle from './scenarios/remount-lifecycle.mjs';
import * as domainInterface from './scenarios/domain-interface.mjs';
import * as actionSurfaces from './scenarios/action-surfaces.mjs';
import * as contentSchema from './scenarios/content-schema.mjs';
import * as labelLos from './scenarios/label-los.mjs';
import * as ambientLife from './scenarios/ambient-life.mjs';

const SCENARIOS = new Map([
  ['curated-camera', {
    module: curatedCamera,
    prepares: 'curated',
    summary: 'COL-06 curated camera structure obstruction: orbit sweeps, per-frame penetration sampling, compression latency, Gateway arch compound check.',
  }],
  ['shimmer-low-dpr', {
    module: shimmerLowDpr,
    prepares: 'coordinates',
    fixture: 'dense-urban',
    // MAT-03's gate names a low-pixel-ratio condition, so the scenario needs its
    // own browser at a reduced device scale factor rather than the shared one.
    deviceScaleFactor: 0.5,
    summary: 'MAT-03 moving low-pixel-ratio shimmer capture: sub-pixel camera rotation over ground at deviceScaleFactor 0.5, temporal aliasing measured against a mip-disabled control.',
  }],
  ['water-order', {
    module: waterOrder,
    prepares: 'coordinates',
    fixture: 'mapped-coast',
    summary: 'LAY-03 transparent water policy: render bands, identical-input order stability across cardinal directions and grazing angles, sort-enabled/disabled comparison, duplicate-blend and blended-foliage checks.',
  }],
  ['coordinate-matrix', {
    module: coordinateMatrix,
    prepares: 'coordinates',
    fixture: 'dense-urban',
    summary: 'COL-05 shape-family matrix: the same orbit sweep across every fixture that carries building geometry (dense-urban, concave-building, courtyard-hole, sparse-rural, stacked-bridge).',
  }],
  ['remount-lifecycle', {
    module: remountLifecycle,
    fixture: 'mapped-coast',
    // No `prepares`: this scenario owns its navigation because it instruments the
    // page before any application module runs, then drives both mount paths.
    summary: 'FND-07 zero-growth remount: 3 mount/exit cycles in both Coordinate Explorer and the curated runtime, asserting workers, observers, listeners, geometries and textures return to baseline.',
  }],
  ['domain-interface', {
    module: domainInterface,
    fixture: 'dense-urban',
    // No `prepares`: the scenario drives both runtimes itself, in one session,
    // because the gate is precisely that the same probe fits both.
    summary: 'FND-08 domain interface: the shared probe run against the shipped curated and coordinate runtimes, plus the guard that keeps their scales distinct.',
  }],
  ['action-surfaces', {
    module: actionSurfaces,
    // No `prepares`: the scenario drives both runtimes itself, because the gate is
    // that the same registry serves both.
    summary: 'GME-05 action registry: every declared action reachable on every surface it claims, verified against the mounted DOM in both runtimes with real pointer and key events.',
  }],
  ['content-schema', {
    module: contentSchema,
    // No `prepares` and no fixture: this gate validates the content *files* over the
    // dev server, so it needs neither a coordinate fixture nor a mounted runtime.
    summary: 'CNT-01 content schema: both shipped state packs fetched over the dev server and validated in-page by the real ContentSchema module, byte-identical to the files the Node tier validates, plus the legacy-migration and rejection paths.',
  }],
  ['label-los', {
    module: labelLos,
    fixture: 'dense-urban',
    // No `prepares`: the scenario opens coordinates itself, because it instruments
    // `world.sweepSphere` before any label ray is cast.
    summary: 'GME-04 label LOS: a found occluded place name hides within the update interval while a clear name stays visible, label rays ask for LOS_BLOCKER only, the per-second budget holds, and the coordinate readout names the nearest place.',
  }],
  ['ambient-life', {
    module: ambientLife,
    fixture: 'dense-urban',
    // No `prepares`: the scenario opens coordinates itself and installs its probe after
    // the runtime is mounted, because it reads the renderer's own instance buffers.
    summary: 'LIF-02 ambient-life budget: the scheduler draws no more agents than the profile ceiling and poses no more per frame than its budget, the renderer\'s own instance buffers confirm only that set moves while culled agents are collapsed, and the activity budget winds ambience down and back up on a live request.',
  }],
  ['coordinate-camera', {
    module: coordinateCamera,
    prepares: 'coordinates',
    fixture: 'dense-urban',
    summary: 'COL-05 coordinate TPP camera sweep: 360-degree orbits at min/max distance around mapped buildings, near-plane corner containment, first-frame compression latency.',
  }],
]);

function parseArguments(argv) {
  const options = { scenario: null, url: 'http://localhost:5173/', list: false, width: 1280, height: 720, fixture: null, variant: null };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--list') options.list = true;
    else if (token === '--url') options.url = argv[++index];
    else if (token === '--width') options.width = Number(argv[++index]);
    else if (token === '--height') options.height = Number(argv[++index]);
    else if (token === '--fixture') options.fixture = argv[++index];
    else if (token === '--variant') options.variant = argv[++index];
    else if (!token.startsWith('-')) options.scenario ??= token;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.list || !options.scenario) {
    console.log('Visual audit scenarios:\n');
    for (const [name, entry] of SCENARIOS) console.log(`  ${name.padEnd(18)} ${entry.summary}`);
    if (!options.scenario) process.exitCode = options.list ? 0 : 1;
    return;
  }
  const entry = SCENARIOS.get(options.scenario);
  if (!entry) throw new Error(`Unknown scenario: ${options.scenario}`);

  const { browser, page, logs } = await launch({
    width: options.width, height: options.height,
    deviceScaleFactor: entry.deviceScaleFactor ?? 1,
  });
  try {
    // Scenario setup imports lazily so `--list` stays dependency-free.
    if (entry.prepares === 'curated') {
      const { openCurated } = await import('./harness.mjs');
      console.log(`[audit] opening curated runtime at ${options.url}`);
      await openCurated(page, options.url);
    } else if (entry.prepares === 'coordinates') {
      const { openCoordinates, selectFixture } = await import('./harness.mjs');
      const fixture = options.fixture ?? entry.fixture ?? 'dense-urban';
      console.log(`[audit] selecting offline fixture ${fixture} and opening Coordinate Explorer at ${options.url}`);
      await selectFixture(page, options.url, { id: fixture, variant: options.variant ?? entry.variant ?? 'openmaptiles' });
      await openCoordinates(page, options.url);
    }
    const summary = await entry.module.run({
      page, baseUrl: options.url, log: console.log,
      fixture: options.fixture ?? entry.fixture ?? 'dense-urban',
      variant: options.variant ?? entry.variant ?? 'openmaptiles',
    });
    const { relevant, known } = classifyConsoleErrors(logs);
    summary.consoleErrors = relevant;
    summary.knownConsoleDefects = known;
    if (known.length) {
      const ids = [...new Set(known.map(item => item.defectId))].join(', ');
      console.log(`\n[audit] ${known.length} console error(s) matched TRACKED known defects (${ids}) — reported, not ignored`);
      for (const item of known.slice(0, 3)) console.log(`  ${item.defectId}: ${item.text.split('\n')[0]}`);
      console.log(`  recorded in ${known[0].recordedIn}`);
    }
    const reportPath = path.join(summary.directory, 'report.json');
    fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log('\n[audit] summary');
    console.log(`  blockers          ${summary.blockers}`);
    console.log(`  sweep frames      ${summary.sweepFrames}`);
    console.log(`  penetrations      ${summary.totalPenetrations}`);
    if ('archPreserved' in summary) console.log(`  arch preserved    ${summary.archPreserved}`);
    if ('fixtures' in summary) console.log(`  fixtures          ${summary.fixtures.join(', ')}`);
    if ('shapes' in summary) console.log(`  shapes sampled    ${summary.shapes.join(', ')}`);
    if ('exactRefinements' in summary) console.log(`  exact-ring tests  ${summary.exactRefinements}`);
    if ('metricValidated' in summary) {
      console.log(`  metric validated  ${summary.metricValidated === true
        ? 'yes' : `NO (sensitivity ${summary.metricSensitivity?.toFixed(3) ?? 'n/a'}x)`}`);
    }
    if ('suppressionRatio' in summary) {
      console.log(`  dpr               ${summary.deviceScaleFactor} (pixelRatio ${summary.pixelRatio})`);
      console.log(`  shimmer variance  production ${summary.productionVariance.toFixed(4)} vs control ${summary.controlVariance.toFixed(4)}`);
      console.log(`  suppression       ${summary.suppressionRatio === null ? 'n/a' : `${summary.suppressionRatio.toFixed(3)}x`}`);
      console.log(`  hardware sign-off ${summary.hardwareSignOff}`);
    }
    if ('contentFailures' in summary) {
      for (const pack of summary.packs) {
        console.log(`  pack ${pack.name.padEnd(12)} ${pack.ok ? 'ok' : 'FAILED'} · ${pack.collectibles} collectible(s) · ${pack.voxels} voxel(s)` +
          ` · served-vs-disk ${pack.hashMatch ? 'identical' : 'DIFFERS'} · ${pack.warnings.length} warning(s)`);
      }
      console.log(`  schema            v${summary.schemaVersion} (${summary.namespace}) · runtime mount: ${summary.runtimeMounted ? 'yes' : 'dormant'}`);
    }
    if ('actionFailures' in summary) {
      for (const mode of ['curated', 'coordinates']) {
        const result = summary[mode];
        console.log(`  ${mode.padEnd(17)} ${result.declared.length} touch action(s): ${result.rendered.join(', ') || '(none)'}` +
          ` · joystick ${result.joystick ? 'yes' : 'no'}`);
      }
      console.log(`  registered        ${summary.registry.actions} action(s) across both runtimes`);
      if (summary.phone) {
        const phoneSummary = ['curated', 'coordinates'].map(mode => {
          const pass = summary.phone[mode];
          return `${mode} ${pass.attribute}/${pass.buttons.length} button(s)${pass.zone ? '/joystick' : ''}`;
        }).join(' · ');
        console.log(`  phone viewport    ${summary.phone.viewport.w}x${summary.phone.viewport.h}: ${phoneSummary}`);
      }
    }
    if ('domainFailures' in summary) {
      console.log(`  interface         curated ${summary.interface.curated.complete ? 'complete' : 'INCOMPLETE'} · coordinates ${summary.interface.coordinates.complete ? 'complete' : 'INCOMPLETE'}`);
      console.log(`  scale guard       ${summary.scaleVerdict.ok ? 'pass' : 'FAIL'} · footprint ratio ${summary.scaleVerdict.ratios.footprintHalfExtent?.toFixed(3)}x`);
      for (const mode of ['curated', 'coordinates']) {
        const probe = summary[mode].probe;
        console.log(`  ${mode.padEnd(17)} move hit=${probe.move.hit} advanced=${probe.move.advanced.toFixed(3)}` +
          ` · camera blocked=${probe.camera.blocked} clear=${!probe.camera.clearRayBlocked}`);
      }
    }
    if ('zeroGrowth' in summary) {
      console.log(`  zero growth       ${summary.zeroGrowth === true ? 'yes' : 'NO'}`);
      if (summary.collectability) {
        for (const mode of ['coordinates', 'curated']) {
          const result = summary.collectability[mode];
          console.log(`  collectability    ${mode}: ${result.retained}/${result.sampled} orphaned target(s) survived forced GC`);
        }
      }
      for (const retention of summary.frameworkRetention ?? []) {
        console.log(`  framework         ${retention.mode}: ${retention.retained} dev-only retained target(s) — ${retention.disposition}`);
      }
      for (const mode of ['coordinates', 'curated']) {
        const state = summary[mode];
        console.log(`  ${mode.padEnd(17)} ${summary.cyclesPerMode} cycles · mounted ${state.steadyState.workers}w/${state.steadyState.observers}o/` +
          `${state.steadyState.listenersPersistent}l/${state.steadyState.geometries}g/${state.steadyState.textures}t · ` +
          `after exit ${state.afterExit.workers}w/${state.afterExit.observers}o/${state.afterExit.listenersPersistent}l, ` +
          `${state.afterExit.released} released, ${state.afterExit.outstanding} outstanding`);
        console.log(`  ${''.padEnd(17)} warm reference ${state.warmReference.workers}w/${state.warmReference.observers}o/` +
          `${state.warmReference.listenersPersistent}l · one-time init ${state.oneTimeInitialisation.listeners} listener(s), ` +
          `${state.oneTimeInitialisation.domNodes} DOM node(s)`);
      }
    }
    if ('labelFailures' in summary) {
      const occluded = summary.occluded;
      console.log(`  labels            ${summary.committedLabels.length} committed · ${summary.searchHits} obstructed sample(s) (${summary.interiorHits} with a wall between) · ${summary.clearHits} clear`);
      console.log(`  occluded          ${occluded
        ? `${occluded.name} hidden, contact t=${occluded.rayTime?.toFixed(3)}, blocker ${occluded.liveBlocker}, dom ${occluded.domHidden ? 'hidden' : 'SHOWN'}/${occluded.domLos ?? 'no marker'}`
        : 'NONE — the criterion is unproven'}`);
      console.log(`  visible half      ${summary.visible ? `${summary.visible.name} shown with a clear ray` : 'NONE — the criterion is unproven'}`);
      console.log(`  ray discipline    ${summary.runtime.sweeps} sweep(s), masks [${summary.runtime.masks.join(', ')}] vs LOS_BLOCKER ${summary.losMask} · profile ${summary.diagnostics.profile} ${summary.diagnostics.testsPerSecond}/s × ${summary.diagnostics.simultaneousLabels}`);
      console.log(`  label counters    tests ${summary.diagnostics.tests} · hidden ${summary.diagnostics.hidden} · age ${Math.round(summary.diagnostics.updateAgeMilliseconds)}ms`);
      console.log(`  coordinate HUD    ${summary.runtime.coordinateText}`);
    }
    if ('ambientFailures' in summary && summary.profile) {
      console.log(`  ambience          profile ${summary.profile} · drawn ${summary.drawn}/${summary.ceiling} · poses/pass ${summary.posesThisPass}/${summary.perFrame} · resident ${summary.resident.instances} on ${summary.resident.tiles} tile(s)`);
      console.log(`  upload            ${summary.upload.moved} of ${summary.upload.instances} instance(s) moved in ${summary.upload.passesDelta} pass(es), allowance ${summary.upload.allowance}, ${summary.upload.collapsed} collapsed`);
      console.log(`  culls             distance ${summary.culls.distance} · screen ${summary.culls.screen} · activity ${summary.culls.activity} · activity 0 → drawn ${summary.activity.off.drawn} (${summary.activity.off.collapsed} collapsed), restored → ${summary.activity.on.drawn}`);
      console.log(`  ambience surface  ${summary.panelLine ?? 'no ambience line'}`);
    }
    if ('stabilitySamples' in summary) {
      console.log(`  stable renders    ${summary.stabilitySamples - summary.orderInstabilitySamples}/${summary.stabilitySamples}`);
      console.log(`  alpha foliage     ${summary.alphaBlendedFoliage.length}`);
    }
    if (summary.skipped?.length) console.log(`  uncovered         ${summary.skipped.map(s => s.fixture).join(', ')}`);
    console.log(`  console errors    ${relevant.length} gate-relevant, ${known.length} tracked-known`);
    console.log(`  report            ${reportPath}`);
    if (summary.totalPenetrations > 0) {
      console.error('\n[audit] FAIL: the camera rendered from inside a blocker.');
      process.exitCode = 1;
    }
    // A scenario that ran but could not reach a verdict must not look like a
    // pass. Exit 2 is distinct from 1 so callers can tell "decided bad" from
    // "could not decide".
    // Zero growth is a hard assertion, not a measurement to interpret: the scenario
    // reports the offending class and call sites in `leaks`.
    if (summary.zeroGrowth === false) {
      console.error('\n[audit] FAIL: remount grew a resource that FND-07 requires to hold steady.');
      for (const leak of summary.leaks) console.error(`  ${leak}`);
      process.exitCode = 1;
    }
    // The domain interface is a hard assertion: the probe either drove both
    // runtimes to the same semantics or it did not.
    if (summary.domainFailures?.length) {
      console.error('\n[audit] FAIL: the curated/coordinate domain interface does not hold.');
      for (const failure of summary.domainFailures) console.error(`  ${failure}`);
      process.exitCode = 1;
    }
    // The action registry is a hard assertion: an action a surface claims but
    // cannot reach is unreachable gameplay, not a measurement to interpret.
    if (summary.actionFailures?.length) {
      console.error('\n[audit] FAIL: a registered gameplay action is not reachable on a surface it claims.');
      for (const failure of summary.actionFailures) console.error(`  ${failure}`);
      process.exitCode = 1;
    }
    // Content is validated by the product's own schema module: a pack that fails it
    // cannot be rendered correctly, so an exit 0 would be a lie.
    if (summary.contentFailures?.length) {
      console.error('\n[audit] FAIL: shipped state content does not satisfy the content schema.');
      for (const failure of summary.contentFailures) console.error(`  ${failure}`);
      process.exitCode = 1;
    }
    // Label line of sight is a hard assertion: a name readable through a building,
    // a ray that consults the wrong proxies, or a budget breach are all defects, not
    // measurements to interpret.
    if (summary.labelFailures?.length) {
      console.error('\n[audit] FAIL: the label line-of-sight contract does not hold.');
      for (const failure of summary.labelFailures) console.error(`  ${failure}`);
      process.exitCode = 1;
    }
    // The ambient-life budget is a hard assertion: agents drawn past the ceiling, more
    // per-frame work than the profile allows, or a frame loop that moves instances the
    // scheduler never admitted are defects, not measurements to interpret.
    if (summary.ambientFailures?.length) {
      console.error('\n[audit] FAIL: the ambient-life budget does not hold.');
      for (const failure of summary.ambientFailures) console.error(`  ${failure}`);
      process.exitCode = 1;
    }
    if (summary.metricValidated === false) {
      console.error('\n[audit] INCONCLUSIVE: the scenario ran but its metric is not');
      console.error('  validated, so its numbers do not support any conclusion.');
      console.error(`  metric sensitivity ${summary.metricSensitivity?.toFixed(3) ?? 'n/a'}x ` +
        '(positive control over production; 1.5x required).');
      process.exitCode = 2;
    }
    if (relevant.length) {
      console.error('\n[audit] FAIL: runtime logged gate-relevant errors during capture.');
      for (const entryLog of relevant.slice(0, 5)) console.error(`  ${entryLog.level}: ${entryLog.text}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(`[audit] ${error.stack || error.message}`);
  process.exitCode = 1;
});
