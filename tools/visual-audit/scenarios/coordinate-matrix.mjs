/**
 * `COL-05` shape-family matrix *(coordinate mode)*
 *
 * Research criterion §15.3-1 asks for orbits around "rectangular, rotated,
 * L-shaped, concave, and thin buildings". A single fixture cannot supply all of
 * those: `dense-urban` buildings share one rectangular footprint, so an orbit
 * sweep there only ever proves the rectangular case. The canonical fixtures
 * exist precisely to cover the rest, so this driver walks every fixture that
 * carries building geometry and runs the same orbit sweep against each, in one
 * browser session, producing a single consolidated report.
 *
 * Fixture switching is server-side (`POST /__fixture-tiles/select`) and tile
 * responses are `no-store`, so each reload genuinely re-fetches the new
 * geometry rather than replaying a cached tile.
 */
import { freshRunDirectory, openCoordinates, selectFixture, waitFrames } from '../harness.mjs';
import { sweepFixture } from './coordinate-camera.mjs';

/** Fixtures that carry building geometry worth orbiting. */
export const MATRIX_FIXTURES = Object.freeze([
  'dense-urban',
  'concave-building',
  'courtyard-hole',
  'sparse-rural',
  'stacked-bridge',
]);

export async function run({ page, baseUrl, log = console.log, fixtures = MATRIX_FIXTURES }) {
  const directory = freshRunDirectory('col05-coordinate-matrix');
  const sections = [];
  const skipped = [];

  for (const fixture of fixtures) {
    log(`\n[col05-matrix] ===== ${fixture} =====`);
    await selectFixture(page, baseUrl, { id: fixture });
    await openCoordinates(page, baseUrl);
    await waitFrames(page, 2);
    try {
      const section = await sweepFixture({ page, log, fixture, directory, installProbeFirst: true });
      if (!section.blockers) {
        skipped.push({ fixture, reason: 'no camera-blocking buildings in this fixture' });
        log(`[col05-matrix] ${fixture}: no blockers — recorded as uncovered, not passed`);
        continue;
      }
      sections.push(section);
    } catch (error) {
      // A fixture with no buildings is a coverage gap, not a pass. Record it.
      skipped.push({ fixture, reason: error.message });
      log(`[col05-matrix] ${fixture}: ${error.message}`);
    }
  }

  const totalPenetrations = sections.reduce((sum, section) => sum + section.totalPenetrations, 0);
  const sweepFrames = sections.reduce((sum, section) => sum + section.sweepFrames, 0);
  const shapes = [...new Set(sections.flatMap(section => section.shapes))];
  const latency = sections.flatMap(section =>
    section.latency.map(entry => ({ fixture: section.fixture, ...entry })));

  return {
    directory,
    // run.mjs prints `summary.blockers`; report the matrix total so the summary
    // line is meaningful rather than undefined.
    blockers: sections.reduce((sum, section) => sum + section.blockers, 0),
    exactRefinements: sections.reduce((sum, section) => sum + section.exactRefinements, 0),
    fixtureCount: sections.length,
    fixtures: sections.map(section => section.fixture),
    skipped,
    shapes,
    sweepFrames,
    totalPenetrations,
    latency,
    sections,
    screenshots: sections.flatMap(section => section.screenshots),
  };
}
