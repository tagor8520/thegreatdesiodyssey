/**
 * `FND-08` domain-interface conformance *(both runtimes)*
 *
 * The Node tier drives a real `GeoWorld` and a real curated bridge/player pair
 * through the shared probe inside `node --test`. This tier repeats it against
 * the **shipped** runtimes: real landing flow, real mount, real worker, real
 * renderer — the same probe module loaded into the page over the dev server and
 * the same lane search, so the two tiers cannot drift.
 *
 * Only the probe itself runs in the page. The verdict is reached here in Node
 * by calling the same `judgeWorldDomain` and `compareDomainScales` the Node tier
 * calls, so a failure is reported with the same sentences in both tiers.
 *
 * Not a pixel gate: nothing here reads a rendering. What it proves is that both
 * modes answer the same five questions through the same named interface, with
 * their own scales intact, against their own real worlds — and that the answer
 * comes from a lane that was first shown to be clear.
 */
import { freshRunDirectory, openCoordinates, openCurated, selectFixture, waitFrames } from '../harness.mjs';

/** Runs in the page; module-scope helpers are not visible here. */
const PROBE_IN_PAGE = async (mode) => {
  const { probeCoordinateDomain, probeCuratedDomain } = await import('/src/engine/WorldDomainProbe.js');
  const { describeWorldDomain } = await import('/src/engine/WorldDomain.js');
  const game = globalThis.__gdoAudit?.game;
  if (!game) throw new Error('the dev audit bridge exposed no game handle');
  if (mode === 'curated') {
    if (!game.domain || !game.bridges) throw new Error('the curated mount handle exposed no domain or bridges');
    return {
      report: describeWorldDomain(game.domain),
      probe: probeCuratedDomain(game.domain, game.bridges),
      handleKeys: Object.keys(game).sort(),
    };
  }
  if (!game.domain || !game.world) throw new Error('the coordinate mount handle exposed no domain or world');
  if (game.domain !== game.world) throw new Error('the coordinate domain is not the world it queries');
  return {
    report: describeWorldDomain(game.domain),
    probe: probeCoordinateDomain(game.domain),
    handleKeys: Object.keys(game).sort(),
  };
};

export async function run({ page, baseUrl, log = console.log, fixture = 'dense-urban', variant = 'openmaptiles' }) {
  const directory = freshRunDirectory('fnd08-domain-interface');
  const { judgeWorldDomain, compareDomainScales } = await import('../../../src/engine/WorldDomain.js');

  log(`\n[fnd08] curated runtime at ${baseUrl}`);
  await openCurated(page, baseUrl);
  await waitFrames(page, 4);
  const curated = await page.evaluate(PROBE_IN_PAGE, 'curated');

  log(`[fnd08] selecting offline fixture ${fixture} and opening Coordinate Explorer`);
  await selectFixture(page, baseUrl, { id: fixture, variant });
  await openCoordinates(page, baseUrl);
  await waitFrames(page, 4);
  const coordinates = await page.evaluate(PROBE_IN_PAGE, 'coordinates');

  const failures = [];
  for (const [mode, result] of [['curated', curated], ['coordinates', coordinates]]) {
    const verdict = judgeWorldDomain(result.probe);
    for (const failure of verdict.failures) failures.push(`${mode}: ${failure}`);
    log(`\n[fnd08] ${mode}`);
    log(`  interface         ${result.report.complete ? 'complete' : 'INCOMPLETE'} (v${result.report.version})`);
    log(`  members           ${Object.entries(result.report.members).map(([k, v]) => `${k}/${v}`).join(' ')}`);
    log(`  scale             footprint ${result.probe.scale.footprintHalfExtent} · spacing ${result.probe.scale.supportSampleSpacing}` +
      ` · sweep [${result.probe.scale.sweepRadiusMin}, ${result.probe.scale.sweepRadiusMax}]`);
    log(`  support           y=${result.probe.support.y.toFixed(4)} kind=${result.probe.support.kind ?? 'n/a'} walkable=${result.probe.support.walkable}`);
    log(`  lane              clear=${result.probe.lane.clear} solidAtEnd=${result.probe.lane.solidPresent}`);
    log(`  move              hit=${result.probe.move.hit} contacts=${result.probe.move.contacts}` +
      ` · advanced=${result.probe.move.advanced.toFixed(3)} in ${result.probe.move.stepsTaken} steps of ${result.probe.move.stride.toFixed(3)}` +
      ` · remaining to solid=${result.probe.move.remainingToSolid.toFixed(3)}`);
    log(`  step              level=${result.probe.step.levelAccepted} rise=${result.probe.step.riseAccepted} (${result.probe.step.riseReason})`);
    log(`  camera            blocked=${result.probe.camera.blocked} amount=${Number(result.probe.camera.amount).toFixed(3)}` +
      ` · clear control blocked=${result.probe.camera.clearRayBlocked}`);
    log(`  semantics         ${verdict.ok ? 'PASS' : `FAIL (${verdict.failures.length})`}`);
    if (!result.report.complete) failures.push(`${mode}: interface report is incomplete`);
  }

  const scaleVerdict = compareDomainScales({ scale: coordinates.probe.scale }, { scale: curated.probe.scale });
  log('\n[fnd08] the two modes must stay on their own scales');
  log(`  footprint ratio   ${scaleVerdict.ratios.footprintHalfExtent?.toFixed(3)}x (documented horizontal scale 10:1)`);
  log(`  spacing ratio     ${scaleVerdict.ratios.supportSampleSpacing?.toFixed(3)}x`);
  log(`  sweep clamps      [${coordinates.probe.scale.sweepRadiusMin}, ${coordinates.probe.scale.sweepRadiusMax}] vs` +
    ` [${curated.probe.scale.sweepRadiusMin}, ${curated.probe.scale.sweepRadiusMax}]`);
  log(`  guard             ${scaleVerdict.ok ? 'PASS' : 'FAIL'}`);
  for (const problem of scaleVerdict.problems) failures.push(`scales: ${problem}`);

  log(`\n[fnd08] ${failures.length ? `FAIL (${failures.length}): ${failures[0]}` : 'PASS: one probe, two runtimes, two scales.'}`);

  return {
    directory,
    fixture,
    // The runner's existing contract: `blockers` counts problems and a non-zero
    // `domainFailures` decides the exit code.
    blockers: failures.length,
    sweepFrames: 0,
    totalPenetrations: 0,
    domainFailures: failures,
    interface: { curated: curated.report, coordinates: coordinates.report },
    curated: { probe: curated.probe, handleKeys: curated.handleKeys },
    coordinates: { probe: coordinates.probe, handleKeys: coordinates.handleKeys },
    scaleVerdict,
  };
}
