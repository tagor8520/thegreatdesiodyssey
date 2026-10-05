/**
 * Test support for fixture-driven geo worlds.
 *
 * The visual gate suite mounts compiled fixtures into a real `GeoWorld` with the
 * same three worker phases a live tile emits. That mount sequence has to exist in
 * exactly one place, so a lifecycle proof and a byte-equivalence proof are always
 * driving the world through identical code.
 *
 * This module is imported by `*.test.js` files only and is never reachable from a
 * Vite entry point, so it is not part of the production bundle.
 */

/** @param {ReturnType<typeof import('./GeoFixtures.js').compileGeoFixture>} compilation */
export function applyCompilation(world, tile, compilation) {
  const common = {
    type: 'tile-phase', requestId: tile.requestId, key: tile.key,
    bytes: 2048, provider: `Fixture/${compilation.fixture.variant}`,
  };
  world._handleWorkerMessage({
    ...common, phase: 'roads', geometry: compilation.roads,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2 },
  });
  world._handleWorkerMessage({
    ...common, phase: 'context', context: compilation.context,
    timings: { fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3 },
  });
  world._handleWorkerMessage({
    ...common, phase: 'buildings', geometry: compilation.buildings,
    timings: {
      fetchMilliseconds: 1, roadsMilliseconds: 2, contextMilliseconds: 3,
      buildingsMilliseconds: 4, totalMilliseconds: 10,
    },
  });
}
