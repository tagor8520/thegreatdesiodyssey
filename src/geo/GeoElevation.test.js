import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_ELEVATION_LIMITS,
  GDO_ELEVATION_NAMESPACE,
  GDO_ELEVATION_PROVIDERS,
  GDO_ELEVATION_REFUSAL,
  applyElevationToGrid,
  createElevationEnricher,
  decodeTerrariumRaster,
  elevationOffsetsFromRaster,
  mercatorFraction,
  terrariumTileFor,
} from './GeoElevation.js';
import { buildTerrainGrid, GEO_TERRAIN_DEFAULTS } from './GeoTerrain.js';
import * as THREE from 'three';
import { GeoWorld } from './GeoWorld.js';

const BOUNDS = Object.freeze({ minX: 0, minZ: 0, maxX: 100, maxZ: 100 });
const GEO = Object.freeze({ north: 28.9850, south: 28.9840, east: 77.7070, west: 77.7062 });

/** A Terrarium RGBA raster of `size²` pixels whose height is a linear ramp. */
function rampRaster({ size = 32, from = 200, to = 260 } = {}) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let row = 0; row < size; row++) {
    const metres = from + (to - from) * row / (size - 1);
    const encoded = metres + 32768;
    for (let column = 0; column < size; column++) {
      const offset = (row * size + column) * 4;
      data[offset] = Math.floor(encoded / 256);
      data[offset + 1] = encoded % 256;
      data[offset + 2] = 0;
      data[offset + 3] = 255;
    }
  }
  return { data, width: size, height: size };
}

function flatRaster(size = 16, metres = 240) {
  const encoded = metres + 32768;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let index = 0; index < size * size; index++) {
    data[index * 4] = Math.floor(encoded / 256);
    data[index * 4 + 1] = encoded % 256;
    data[index * 4 + 2] = 0;
  }
  return { data, width: size, height: size };
}

test('TER-04 declares one optional, attributed elevation provider and a bounded budget', () => {
  assert.equal(GDO_ELEVATION_NAMESPACE, 'gdo:elevationEnrichment:v1');
  const provider = GDO_ELEVATION_PROVIDERS.terrarium;
  assert.equal(provider.encoding, 'terrarium');
  assert.equal(provider.required, false, 'the public dataset has no SLA: never required');
  assert.equal(provider.bulk, false, 'one tile per request, never a bulk range');
  assert.match(provider.urlTemplate, /\{z\}.*\{x\}.*\{y\}/);
  assert.ok(provider.attribution.length > 10, 'attribution travels with the data');
  for (const field of ['maxTiles', 'maxBytes', 'ttlMilliseconds', 'maxInFlight', 'maxRequestsPerBurst', 'deadlineMilliseconds']) {
    assert.ok(GDO_ELEVATION_LIMITS[field] > 0, field);
  }
  assert.ok(GDO_ELEVATION_LIMITS.maxInFlight <= 4, 'a courtesy throttle, not a crawler');

  // Tile math is monotone and stable, and the URL is the tile's own.
  const centre = terrariumTileFor({ latitude: 28.9845, longitude: 77.7064, zoom: 12 });
  assert.deepEqual(centre, terrariumTileFor({ latitude: 28.9845, longitude: 77.7064, zoom: 12 }));
  assert.ok(centre.x >= 0 && centre.x < 4096 && centre.y >= 0 && centre.y < 4096);
  assert.equal(centre.url, `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/${centre.x}/${centre.y}.png`);
  assert.ok(terrariumTileFor({ latitude: 28.9845, longitude: 77.71, zoom: 12 }).x >= centre.x, 'east is not west');
  assert.ok(terrariumTileFor({ latitude: 28.98, longitude: 77.7064, zoom: 12 }).y >= centre.y, 'south is not north');
  assert.ok(mercatorFraction(0) === .5 && mercatorFraction(60) < .5 && mercatorFraction(-60) > .5);
  assert.throws(() => terrariumTileFor({ latitude: 100, longitude: 0 }), /Web Mercator/);
});

test('Terrarium decoding is exact and refuses a malformed raster', () => {
  // height = (R * 256 + G + B / 256) - 32768
  const encode = metres => {
    const value = metres + 32768;
    return [Math.floor(value / 256), Math.floor(value) % 256, Math.round((value % 1) * 256)];
  };
  const samples = [0, 100, -42, 8848, 1234.5];
  const data = new Uint8ClampedArray(samples.length * 4);
  samples.forEach((metres, index) => {
    const [r, g, b] = encode(metres);
    data.set([r, g, b, 255], index * 4);
  });
  // Two rows of the same samples: the decoder's floor is 2×2 pixels.
  const twoRows = new Uint8ClampedArray(data.length * 2);
  twoRows.set(data, 0);
  twoRows.set(data, data.length);
  const decoded = decodeTerrariumRaster({ data: twoRows, width: samples.length, height: 2 });
  samples.forEach((metres, index) => {
    assert.ok(Math.abs(decoded[index] - metres) < 1 / 128, `${metres} survives the decode`);
  });

  assert.throws(() => decodeTerrariumRaster({ data: new Uint8Array(4), width: 4, height: 4 }), /short/);
  assert.throws(() => decodeTerrariumRaster({ data: new Uint8Array(64), width: 1, height: 1 }), /dimensions/);
  assert.throws(() => decodeTerrariumRaster({ data: new Uint8Array(64), width: 99_999, height: 2 }), /dimensions/);
  assert.throws(() => decodeTerrariumRaster(null), /required/);
});

test('resampling subtracts the local datum, clamps relief, and is deterministic', () => {
  const tile = terrariumTileFor({ latitude: 28.9845, longitude: 77.7064, zoom: 12 });
  const raster = { ...rampRaster(), tile };
  const layer = elevationOffsetsFromRaster({ raster, tile, bounds: GEO });
  assert.equal(layer.namespace, GDO_ELEVATION_NAMESPACE);
  assert.equal(layer.offsets.length, (GDO_ELEVATION_LIMITS.gridResolution + 1) ** 2);
  // A linear DEM sampled over one small map tile is still a small, centred relief.
  assert.ok(layer.reliefMetres > 0 && layer.reliefMetres < 60, 'only the sampled window matters');
  assert.ok(layer.minOffset < 0 && layer.maxOffset > 0, 'relief is centred, not lifted');
  assert.ok(Math.abs(layer.minOffset + layer.maxOffset) < .05, 'a linear ramp balances around its mean');
  assert.ok(layer.maxOffset - layer.minOffset <= GDO_ELEVATION_LIMITS.maxReliefWorld * 2);

  // Relief is clamped: an absurd DEM cannot lift a tile out of the world.
  const extreme = elevationOffsetsFromRaster({ raster: { ...rampRaster({ from: 0, to: 8000 }), tile }, tile, bounds: GEO });
  assert.ok(Math.abs(extreme.maxOffset - GDO_ELEVATION_LIMITS.maxReliefWorld) < 1e-6);
  assert.ok(Math.abs(extreme.minOffset + GDO_ELEVATION_LIMITS.maxReliefWorld) < 1e-6);

  const flat = elevationOffsetsFromRaster({ raster: { ...flatRaster(), tile }, tile, bounds: GEO });
  assert.ok(flat.offsets.every(value => value === 0), 'a flat DEM enriches to exactly zero');

  // Deterministic fingerprint, and resolution is honoured within the cap.
  const repeated = elevationOffsetsFromRaster({ raster, tile, bounds: GEO });
  assert.equal(layer.fingerprint, repeated.fingerprint);
  const coarse = elevationOffsetsFromRaster({ raster, tile, bounds: GEO, resolution: 8 });
  assert.equal(coarse.offsets.length, 81);
  // The corner sample is shared by both grids; the interior is not.
  assert.equal(coarse.offsets[0], layer.offsets[0]);
  assert.notEqual(coarse.offsets[40], layer.offsets[544]);
  assert.throws(() => elevationOffsetsFromRaster({ raster, tile, bounds: GEO, resolution: 99 }), /resolution/);
  assert.throws(() => elevationOffsetsFromRaster({ raster, tile, bounds: { north: 1, south: 1, east: 2, west: 1 } }), /bounds/);
});

test('elevation moves Y and nothing else, and a missing layer is the identity', () => {
  const base = buildTerrainGrid(BOUNDS, 7);
  const tile = terrariumTileFor({ latitude: 28.9845, longitude: 77.7064, zoom: 12 });
  const raster = { ...rampRaster(), tile };
  const layer = Object.freeze({
    ...elevationOffsetsFromRaster({ raster, tile, bounds: GEO }),
    attribution: GDO_ELEVATION_PROVIDERS.terrarium.attribution,
  });
  const elevated = applyElevationToGrid(base, layer, BOUNDS);
  assert.equal(elevated.positions.length, base.positions.length);
  assert.equal(elevated.indices, base.indices);
  for (let index = 0; index < base.positions.length; index += 3) {
    assert.equal(elevated.positions[index], base.positions[index], 'X is untouched');
    assert.equal(elevated.positions[index + 2], base.positions[index + 2], 'Z is untouched');
    assert.ok(Math.abs(
      (elevated.positions[index + 1] - base.positions[index + 1]) - layer.offsets[index / 3],
    ) < 1e-6, 'Y is exactly the offset');
  }
  // The base grid is never mutated: the fallback stays available.
  const pristine = buildTerrainGrid(BOUNDS, 7);
  assert.deepEqual([...base.positions], [...pristine.positions]);

  // Normals are unit-length and reflect the enriched relief.
  for (let index = 0; index < elevated.normals.length; index += 3) {
    assert.ok(Math.abs(Math.hypot(elevated.normals[index], elevated.normals[index + 1], elevated.normals[index + 2]) - 1) < 1e-5);
  }
  assert.equal(elevated.elevation.fingerprint, layer.fingerprint);
  assert.ok(elevated.elevation.attribution.length > 10);

  // No layer, a fallback record, or a mismatched grid returns the base object.
  assert.equal(applyElevationToGrid(base, null, BOUNDS), base);
  assert.equal(applyElevationToGrid(base, { namespace: 'gdo:other:v1', offsets: new Float32Array(9) }, BOUNDS), base);
  assert.equal(applyElevationToGrid(base, layer, BOUNDS).positions === base.positions, false);
  assert.equal(applyElevationToGrid({ ...base, resolution: 3 }, layer, BOUNDS).positions, base.positions === undefined ? undefined : base.positions);
});

test('without a provider the enrichment is absent, named, and byte-identical', () => {
  const absent = createElevationEnricher();
  assert.equal(absent.available, false);
  const record = absent.request({ bounds: GEO });
  assert.equal(record.status, 'fallback');
  assert.equal(record.refusal, GDO_ELEVATION_REFUSAL.NO_PROVIDER);
  assert.equal(record.offsets, null);
  assert.equal(record.fallback, 'flat');
  assert.equal(absent.diagnostics.requests, 1);

  // With a provider but a broken/absent fetch, the answers stay identical.
  const broken = createElevationEnricher({ fetchTile: () => { throw new Error('offline'); } });
  const rejected = createElevationEnricher({ fetchTile: () => Promise.reject(new Error('offline')) });
  const missing = createElevationEnricher({ fetchTile: () => null });
  const malformed = createElevationEnricher({ fetchTile: () => ({ data: new Uint8Array(8), width: 2, height: 1 }) });

  const base = buildTerrainGrid(BOUNDS, 7);
  const apply = async enricher => applyElevationToGrid(base, await enricher.resolve({ bounds: GEO }), BOUNDS);
  return Promise.all([broken, rejected, missing, malformed].map(apply)).then(results => {
    for (const grid of results) {
      assert.equal(grid.positions, base.positions, 'a failed enrichment is exactly the procedural field');
    }
    assert.equal(broken.diagnostics.failures, 1);
    assert.equal(rejected.diagnostics.failures, 1);
    assert.equal(missing.diagnostics.failures, 1);
    assert.equal(malformed.diagnostics.failures, 1);
    assert.equal(malformed.diagnostics.cachedTiles, 0, 'an undecodable raster is never cached');
  }).then(() => {
    assert.equal(absent.request({ bounds: { north: 1, south: 1, east: 2, west: 1 } }).refusal,
      GDO_ELEVATION_REFUSAL.NO_PROVIDER, 'no provider is reported before bad bounds');
    const typed = createElevationEnricher({ fetchTile: () => flatRaster() });
    assert.equal(typed.request({ bounds: { north: 1, south: 1, east: 2, west: 1 } }).refusal, GDO_ELEVATION_REFUSAL.BAD_BOUNDS);
  });
});

test('a ready enrichment is Y-only, attributed, and reusable from the cache', async () => {
  let fetches = 0;
  const enricher = createElevationEnricher({
    fetchTile: () => { fetches++; return rampRaster(); },
  });
  const provisional = enricher.request({ bounds: GEO });
  assert.equal(provisional.status, 'provisional');
  assert.equal(provisional.offsets, null, 'the caller can mount flat immediately');
  const record = await provisional.promise;
  assert.equal(record.status, 'ready');
  assert.equal(record.attribution, GDO_ELEVATION_PROVIDERS.terrarium.attribution);
  assert.ok(record.offsets instanceof Float32Array);
  assert.equal(fetches, 1);

  const cached = enricher.request({ bounds: GEO });
  assert.equal(cached.status, 'ready');
  assert.equal(cached.cached, true);
  assert.equal(fetches, 1, 'the second request is served from the cache');
  assert.equal(cached.fingerprint, record.fingerprint, 'and it is the same field');

  const base = buildTerrainGrid(BOUNDS, 7);
  const elevated = applyElevationToGrid(base, cached, BOUNDS);
  assert.notEqual(elevated.positions[1], base.positions[1], 'the ground actually gains relief');
  assert.ok(Math.abs(elevated.positions[1] - base.positions[1] - cached.offsets[0]) < 1e-6);

  const diagnostics = enricher.diagnostics;
  assert.equal(diagnostics.hits, 1);
  assert.equal(diagnostics.misses, 1);
  assert.equal(diagnostics.cachedTiles, 1);
  assert.ok(diagnostics.cachedBytes > 0 && diagnostics.cachedBytes <= GDO_ELEVATION_LIMITS.maxBytes);
});

test('the cache is bounded by tiles and TTL, and the network by burst and in-flight caps', async () => {
  let clock = 1_000;
  const enricher = createElevationEnricher({
    fetchTile: () => flatRaster(),
    limits: { maxTiles: 2, maxInFlight: 1, maxRequestsPerBurst: 2, burstMilliseconds: 1_000 },
    now: () => clock,
  });
  const at = longitude => ({ ...GEO, east: longitude + .0004, west: longitude - .0004 });

  // In-flight cap: a second tile cannot start while the first is still going.
  const first = enricher.request({ bounds: at(77.7) });
  assert.equal(first.status, 'provisional');
  const blocked = enricher.request({ bounds: at(77.9) });
  assert.equal(blocked.status, 'fallback');
  assert.equal(blocked.refusal, GDO_ELEVATION_REFUSAL.BURST_CAPPED);
  assert.equal((await first.promise).status, 'ready');
  assert.equal((await blocked.promise), null);

  // Burst cap is per window and recovers with time.
  clock += 5_000;
  assert.equal((await enricher.resolve({ bounds: at(77.9) })).status, 'ready');
  clock += 5_000;
  assert.equal((await enricher.resolve({ bounds: at(78.1) })).status, 'ready');
  const diagnostics = enricher.diagnostics;
  assert.ok(diagnostics.cachedTiles <= 2, 'the tile LRU holds');
  assert.ok(diagnostics.evictions >= 1, 'and it evicts, counting what it drops');

  // TTL: the same key re-fetches once it is stale.
  const fetchesBefore = diagnostics.misses;
  clock += GDO_ELEVATION_LIMITS.ttlMilliseconds + 1;
  const refetched = await enricher.resolve({ bounds: at(78.1) });
  assert.equal(refetched.status, 'ready');
  assert.equal(enricher.diagnostics.misses, fetchesBefore + 1, 'a stale tile is re-requested, not reused');
});

test('a missed deadline is a named fallback and a late response is dropped', async () => {
  const timers = [];
  const enricher = createElevationEnricher({
    fetchTile: () => new Promise(() => {}),
    timers: {
      setTimeout: callback => { timers.push(callback); return timers.length - 1; },
      clearTimeout: () => {},
    },
  });
  const provisional = enricher.request({ bounds: GEO });
  assert.equal(provisional.status, 'provisional');
  await Promise.resolve();
  assert.equal(timers.length, 1, 'one deadline timer, not one per frame');
  timers[0]();
  const record = await provisional.promise;
  assert.equal(record.status, 'fallback');
  assert.equal(record.refusal, GDO_ELEVATION_REFUSAL.DEADLINE);
  assert.equal(record.offsets, null);
  assert.equal(enricher.diagnostics.deadlineMisses, 1);
  // The world keeps the flat surface; the timer also freed the in-flight slot.
  assert.equal(enricher.diagnostics.inFlight, 0);
  assert.equal(enricher.request({ bounds: GEO }).status, 'provisional', 'a new tile can start after a miss');
});

test('the world mounts elevation flat-first and upgrades Y only when it arrives', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class { addEventListener() {} postMessage() {} terminate() {} };
  const scene = new THREE.Scene();
  const world = new GeoWorld(scene, { latitude: 28.9845, longitude: 77.7064 });
  try {
    // No provider: the world is exactly the procedural field, and asking for
    // enrichment changes nothing.
    const tile = [...world.tiles.values()][0];
    const flatY = [...tile.ground.geometry.attributes.position.array];
    assert.equal(world.elevation, null, 'nothing is mounted by default');
    world.enableElevation();
    assert.equal(world.elevation.available, false);
    assert.equal(world.elevation.request({ bounds: world.tileGeographicBounds(tile.x, tile.y) }).refusal,
      'no-provider');

    // Now a provider that answers with a ramp.
    const raster = (() => {
      const size = 32;
      const data = new Uint8ClampedArray(size * size * 4);
      for (let row = 0; row < size; row++) {
        const metres = 120 + 260 * row / (size - 1);
        const encoded = metres + 32768;
        for (let column = 0; column < size; column++) {
          const offset = (row * size + column) * 4;
          data[offset] = Math.floor(encoded / 256);
          data[offset + 1] = encoded % 256;
          data[offset + 2] = 0;
          data[offset + 3] = 255;
        }
      }
      return { data, width: size, height: size };
    })();
    world.enableElevation({ fetchTile: () => raster });
    world.elevationTiles.clear();
    world._requestTileElevation(tile, tile.ground.geometry);
    assert.equal(tile.elevation.status, 'provisional', 'the flat surface stays mounted while waiting');
    assert.deepEqual([...tile.ground.geometry.attributes.position.array], flatY, 'no blocking on the network');
    await tile.elevation.promise;
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(tile.elevated, true, 'the tile upgraded');
    assert.equal(world.elevationUpgrades, 1);
    const elevated = tile.ground.geometry.attributes.position.array;
    assert.equal(elevated.length, flatY.length);
    let moved = 0;
    for (let index = 0; index < flatY.length; index += 3) {
      assert.equal(elevated[index], flatY[index], 'X is never touched');
      assert.equal(elevated[index + 2], flatY[index + 2], 'Z is never touched');
      if (elevated[index + 1] !== flatY[index + 1]) moved++;
    }
    assert.ok(moved > 0, 'the ground gained relief where the DEM varied');
    assert.ok(tile.ground.userData.elevation.fingerprint);
    assert.match(tile.ground.userData.elevation.attribution, /Elevation/);
  } finally {
    world.dispose();
    globalThis.Worker = originalWorker;
  }
});
