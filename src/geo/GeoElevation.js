/**
 * `TER-04` — optional public elevation enrichment (`gdo:elevationEnrichment:v1`).
 *
 * Research §"Real local relief": an optional, no-auth Terrarium DEM tile,
 * downsampled and **datum-subtracted** to a 33×33 (or 49×49) mesh, with the flat
 * stylized field remaining the default. Research §"DEM candidate" is explicit
 * that the public dataset has **no application SLA**, so the rules here are:
 *
 *   - **optional**: with no provider, no network, a rejected fetch, a malformed
 *     raster, or a missed deadline, the enrichment layer simply does not exist
 *     and the procedural field is returned *identically* — a world with
 *     elevation unavailable renders exactly what it rendered before;
 *   - **bounded**: one DEM tile per request (never a bulk range), an in-flight
 *     cap, a burst cap, an LRU bounded by tiles *and* bytes, a TTL, and a
 *     deadline;
 *   - **attributed**: every ready record carries the provider's attribution;
 *   - **Y only**: elevation offsets are added to the ground's Y values and
 *     nothing else — footprints, roads, collision X/Z, and placement are
 *     untouched (research §"Optional terrain elevation modifies Y, never X/Z
 *     footprints").
 *
 * The provider is injected (`fetchTile`) so the module is testable and a
 * production host owns the actual HTTP policy.
 */

import { featureNamespace } from '../engine/FeatureVersions.js';

export const GDO_ELEVATION_NAMESPACE = featureNamespace('elevationEnrichment');

/** Terrarium encodes elevation as `(R * 256 + G + B / 256) - 32768` metres. */
export const GDO_ELEVATION_ENCODING = Object.freeze({ TERRARIUM: 'terrarium' });

export const GDO_ELEVATION_PROVIDERS = Object.freeze({
  terrarium: Object.freeze({
    id: 'terrarium',
    encoding: GDO_ELEVATION_ENCODING.TERRARIUM,
    urlTemplate: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    attribution: 'Elevation: AWS Open Data Terrain Tiles (Terrarium encoding)',
    // No SLA, no key: the dataset is optional by definition, never required.
    required: false,
    bulk: false,
  }),
});

export const GDO_ELEVATION_REFUSAL = Object.freeze({
  NO_PROVIDER: 'no-provider',
  DISABLED: 'disabled',
  BAD_BOUNDS: 'bad-bounds',
  BAD_ZOOM: 'bad-zoom',
  BAD_RASTER: 'bad-raster',
  FETCH_FAILED: 'fetch-failed',
  DEADLINE: 'deadline',
  BURST_CAPPED: 'burst-capped',
});

export const GDO_ELEVATION_LIMITS = Object.freeze({
  minZoom: 8,
  maxZoom: 14,
  defaultZoom: 12,
  gridResolution: 32,
  maxGridResolution: 48,
  maxTiles: 48,
  maxBytes: 768 * 1024,
  ttlMilliseconds: 900_000,
  maxInFlight: 2,
  maxRequestsPerBurst: 3,
  burstMilliseconds: 10_000,
  deadlineMilliseconds: 1_500,
  // The project's metres→world convention is ×0.1 (the wall grammar uses the
  // same scale), and relief is clamped so a DEM can never lift a tile out of
  // the stylized world.
  worldUnitsPerMetre: .1,
  maxReliefWorld: 3,
  maxRasterSide: 1024,
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Web Mercator row fraction: 0 at the north edge, 1 at the south edge. */
export function mercatorFraction(latitude) {
  const clamped = clamp(latitude, -85.05112878, 85.05112878);
  const radians = clamped * Math.PI / 180;
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
}

export function longitudeFraction(longitude) {
  return ((longitude + 180) / 360);
}

/** One DEM tile for a coordinate — never a range, never a bulk download. */
export function terrariumTileFor({ latitude, longitude, zoom = GDO_ELEVATION_LIMITS.defaultZoom } = {}) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 85.05112878 || Math.abs(longitude) > 180) {
    throw new RangeError('Elevation tile needs a finite coordinate inside Web Mercator bounds');
  }
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 22) throw new RangeError('Elevation tile zoom must be 0–22');
  const side = 2 ** zoom;
  const x = clamp(Math.floor(longitudeFraction(longitude) * side), 0, side - 1);
  const y = clamp(Math.floor(mercatorFraction(latitude) * side), 0, side - 1);
  const spec = GDO_ELEVATION_PROVIDERS.terrarium;
  const url = spec.urlTemplate.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y));
  return Object.freeze({ z: zoom, x, y, url, attribution: spec.attribution });
}

/** Decode a Terrarium RGBA raster into metres. Pure, validating, allocation-bounded. */
export function decodeTerrariumRaster(raster, limits = GDO_ELEVATION_LIMITS) {
  if (!raster || typeof raster !== 'object') throw new TypeError('Elevation raster is required');
  const { data, width, height } = raster;
  if (!ArrayBuffer.isView(data) || data instanceof DataView) throw new TypeError('Elevation raster data must be typed');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 ||
      width > limits.maxRasterSide || height > limits.maxRasterSide) {
    throw new RangeError('Elevation raster dimensions are out of bounds');
  }
  if (data.length < width * height * 4) throw new RangeError('Elevation raster data is short for its dimensions');
  const metres = new Float32Array(width * height);
  for (let index = 0, offset = 0; index < metres.length; index++, offset += 4) {
    metres[index] = data[offset] * 256 + data[offset + 1] + data[offset + 2] / 256 - 32768;
  }
  return metres;
}

function sampleBilinear(heights, width, height, u, v) {
  const x = clamp(u, 0, 1) * (width - 1);
  const y = clamp(v, 0, 1) * (height - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const top = heights[y0 * width + x0] * (1 - tx) + heights[y0 * width + x1] * tx;
  const bottom = heights[y1 * width + x0] * (1 - tx) + heights[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

function fingerprint(values) {
  let hash = 2166136261;
  const update = byte => { hash ^= byte; hash = Math.imul(hash, 16777619); };
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  for (let index = 0; index < bytes.length; index++) update(bytes[index]);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Resample one DEM tile over a map tile's geographic bounds into world-unit
 * offsets aligned 1:1 with `buildTerrainGrid`'s vertex order (row-major in Z,
 * then X). The datum is the sample mean, so relief is centred on the tile and a
 * flat raster yields exactly zero offset — never a lifted plateau.
 */
export function elevationOffsetsFromRaster({
  raster,
  tile,
  bounds,
  resolution = GDO_ELEVATION_LIMITS.gridResolution,
  limits = GDO_ELEVATION_LIMITS,
} = {}) {
  if (!bounds || ![bounds.north, bounds.south, bounds.east, bounds.west].every(Number.isFinite) ||
      bounds.north <= bounds.south || bounds.east <= bounds.west) {
    throw new RangeError('Elevation bounds must be finite and non-degenerate');
  }
  if (!Number.isInteger(resolution) || resolution < 2 || resolution > limits.maxGridResolution) {
    throw new RangeError('Elevation grid resolution is out of bounds');
  }
  if (!tile || !Number.isInteger(tile.z) || !Number.isInteger(tile.x) || !Number.isInteger(tile.y)) {
    throw new TypeError('Elevation tile coordinates are required');
  }
  const heights = decodeTerrariumRaster(raster, limits);
  const side = 2 ** tile.z;
  const u0 = longitudeFraction(bounds.west) * side - tile.x;
  const u1 = longitudeFraction(bounds.east) * side - tile.x;
  const v0 = mercatorFraction(bounds.north) * side - tile.y;
  const v1 = mercatorFraction(bounds.south) * side - tile.y;
  const vertexSide = resolution + 1;
  const samples = new Float32Array(vertexSide * vertexSide);
  let sum = 0;
  let minimum = Infinity, maximum = -Infinity;
  for (let row = 0; row < vertexSide; row++) {
    const v = v0 + (v1 - v0) * row / resolution;
    for (let column = 0; column < vertexSide; column++) {
      const u = u0 + (u1 - u0) * column / resolution;
      const value = sampleBilinear(heights, raster.width, raster.height, u, v);
      samples[row * vertexSide + column] = value;
      sum += value;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  const datum = sum / samples.length;
  const offsets = new Float32Array(samples.length);
  let minOffset = Infinity, maxOffset = -Infinity;
  for (let index = 0; index < offsets.length; index++) {
    const offset = clamp((samples[index] - datum) * limits.worldUnitsPerMetre, -limits.maxReliefWorld, limits.maxReliefWorld);
    offsets[index] = offset;
    minOffset = Math.min(minOffset, offset);
    maxOffset = Math.max(maxOffset, offset);
  }
  return Object.freeze({
    namespace: GDO_ELEVATION_NAMESPACE,
    encoding: GDO_ELEVATION_ENCODING.TERRARIUM,
    tile: Object.freeze({ z: tile.z, x: tile.x, y: tile.y }),
    resolution,
    offsets,
    datumMetres: datum,
    minimumMetres: minimum,
    maximumMetres: maximum,
    reliefMetres: maximum - minimum,
    minOffset,
    maxOffset,
    bytes: offsets.byteLength,
    fingerprint: fingerprint(offsets),
  });
}

/**
 * Add an enrichment layer to a `buildTerrainGrid` result, **Y only**. A null or
 * non-ready layer returns the base grid object itself, so a fallback is not
 * merely equal to the procedural field — it *is* it.
 */
export function applyElevationToGrid(base, layer, bounds) {
  if (!layer || layer.namespace !== GDO_ELEVATION_NAMESPACE || !(layer.offsets instanceof Float32Array)) return base;
  if (!base?.positions?.length || !base?.indices?.length) return base;
  const vertexSide = base.resolution + 1;
  if (layer.offsets.length !== vertexSide * vertexSide) return base;
  const positions = new Float32Array(base.positions);
  const heights = new Float32Array(vertexSide * vertexSide);
  for (let index = 0, cursor = 0; index < heights.length; index++, cursor += 3) {
    positions[cursor + 1] += layer.offsets[index];
    heights[index] = positions[cursor + 1];
  }
  // Normals come from the enriched heights, so relief actually lights.
  const normals = new Float32Array(base.normals.length);
  const spacingX = (bounds.maxX - bounds.minX) / base.resolution;
  const spacingZ = (bounds.maxZ - bounds.minZ) / base.resolution;
  const at = (column, row) => heights[clamp(row, 0, base.resolution) * vertexSide + clamp(column, 0, base.resolution)];
  for (let row = 0, cursor = 0; row <= base.resolution; row++) {
    for (let column = 0; column <= base.resolution; column++, cursor += 3) {
      const dx = (at(column + 1, row) - at(column - 1, row)) / (2 * spacingX);
      const dz = (at(column, row + 1) - at(column, row - 1)) / (2 * spacingZ);
      const inverse = 1 / Math.hypot(dx, 1, dz);
      normals[cursor] = -dx * inverse;
      normals[cursor + 1] = inverse;
      normals[cursor + 2] = -dz * inverse;
    }
  }
  return Object.freeze({
    ...base,
    positions,
    normals,
    elevation: Object.freeze({
      namespace: GDO_ELEVATION_NAMESPACE,
      fingerprint: layer.fingerprint,
      attribution: layer.attribution ?? null,
      minOffset: layer.minOffset,
      maxOffset: layer.maxOffset,
      reliefMetres: layer.reliefMetres,
    }),
  });
}

/**
 * The bounded, cached, optionally-absent enrichment source. `request` is
 * synchronous and **never throws**: it returns a record immediately (provisional
 * or fallback) plus a promise that always resolves — a caller can mount the
 * flat field first and upgrade later without any code path depending on the
 * network (research §"Roads still become visible before buildings").
 */
export function createElevationEnricher({
  fetchTile = null,
  provider = 'terrarium',
  zoom = GDO_ELEVATION_LIMITS.defaultZoom,
  limits = GDO_ELEVATION_LIMITS,
  now = () => Date.now(),
  timers = null,
} = {}) {
  const spec = GDO_ELEVATION_PROVIDERS[provider] ?? null;
  const merged = { ...GDO_ELEVATION_LIMITS, ...(limits ?? {}) };
  const setTimer = timers?.setTimeout ?? globalThis.setTimeout;
  const clearTimer = timers?.clearTimeout ?? globalThis.clearTimeout;
  const entries = new Map();
  const inFlight = new Map();
  let bytes = 0;
  let requests = 0, hits = 0, misses = 0, evictions = 0, joined = 0;
  let fallbacks = 0, deadlineMisses = 0, lateArrivals = 0, burstRefusals = 0, failures = 0;
  let burstWindowStart = -Infinity;
  let burstCount = 0;

  const resolveSpec = () => (spec && merged.maxTiles > 0 ? spec : null);
  const usable = () => Boolean(resolveSpec() && typeof fetchTile === 'function');

  const disabledRecord = refusal => Object.freeze({
    namespace: GDO_ELEVATION_NAMESPACE,
    status: 'fallback',
    fallback: 'flat',
    refusal,
    offsets: null,
    resolution: merged.gridResolution,
    attribution: null,
    fingerprint: null,
    minOffset: 0,
    maxOffset: 0,
    reliefMetres: 0,
    bytes: 0,
    cached: false,
    promise: Promise.resolve(null),
  });

  function recordFromEntry(entry, cached) {
    return Object.freeze({
      namespace: GDO_ELEVATION_NAMESPACE,
      status: 'ready',
      fallback: null,
      refusal: null,
      ...entry.layer,
      attribution: entry.attribution,
      bytes: entry.layer.bytes,
      cached,
      key: entry.key,
      promise: Promise.resolve(null),
    });
  }

  function adopt(key, raster, attribution) {
    const entry = { key, raster, attribution, storedAt: now(), bytes: raster.width * raster.height * 4 };
    entries.set(key, entry);
    bytes += entry.bytes;
    while (entries.size > merged.maxTiles || (bytes > merged.maxBytes && entries.size > 1)) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === key && entries.size === 1) break;
      const oldest = entries.get(oldestKey);
      entries.delete(oldestKey);
      bytes -= oldest.bytes;
      evictions++;
    }
    return entry;
  }

  function layerFor(entry, bounds, resolution) {
    return elevationOffsetsFromRaster({
      raster: entry.raster, tile: entry.raster.tile, bounds, resolution, limits: merged,
    });
  }

  /** Synchronous, total, and dependency-free. */
  function request({ bounds, resolution = merged.gridResolution, key = null } = {}) {
    requests++;
    if (!usable()) return disabledRecord(GDO_ELEVATION_REFUSAL.NO_PROVIDER);
    const validBounds = bounds && [bounds.north, bounds.south, bounds.east, bounds.west].every(Number.isFinite) &&
      bounds.north > bounds.south && bounds.east > bounds.west;
    if (!validBounds) {
      fallbacks++;
      return disabledRecord(GDO_ELEVATION_REFUSAL.BAD_BOUNDS);
    }
    if (!Number.isInteger(zoom) || zoom < merged.minZoom || zoom > merged.maxZoom) {
      fallbacks++;
      return disabledRecord(GDO_ELEVATION_REFUSAL.BAD_ZOOM);
    }
    const latitude = (bounds.north + bounds.south) / 2;
    const longitude = (bounds.east + bounds.west) / 2;
    const tile = terrariumTileFor({ latitude, longitude, zoom });
    const tileKey = key ?? `${tile.z}/${tile.x}/${tile.y}`;
    const cached = entries.get(tileKey);
    const stamp = now();
    if (cached) {
      if (stamp - cached.storedAt <= merged.ttlMilliseconds) {
        hits++;
        entries.delete(tileKey);
        entries.set(tileKey, cached);
        try {
          return recordFromEntry({ ...cached, layer: layerFor(cached, bounds, resolution) }, true);
        } catch (error) {
          fallbacks++;
          return disabledRecord(GDO_ELEVATION_REFUSAL.BAD_RASTER);
        }
      }
      entries.delete(tileKey);
      bytes -= cached.bytes;
      evictions++;
    }
    // Burst policy: this is a courtesy-throttled public dataset, not a CDN.
    if (stamp - burstWindowStart > merged.burstMilliseconds) {
      burstWindowStart = stamp;
      burstCount = 0;
    }
    if (burstCount >= merged.maxRequestsPerBurst) {
      burstRefusals++;
      fallbacks++;
      return disabledRecord(GDO_ELEVATION_REFUSAL.BURST_CAPPED);
    }
    if (inFlight.size >= merged.maxInFlight) {
      fallbacks++;
      return disabledRecord(GDO_ELEVATION_REFUSAL.BURST_CAPPED);
    }
    burstCount++;
    misses++;
    let settle = null;
    const promise = new Promise(resolve => { settle = resolve; });
    inFlight.set(tileKey, promise);
    let done = false;
    const finish = record => {
      if (done) return;
      done = true;
      inFlight.delete(tileKey);
      clearTimer(timer);
      settle(record);
    };
    const timer = setTimer(() => {
      // The deadline is the promise the world actually relies on: the tile keeps
      // its flat provisional surface and the late response is dropped, counted.
      deadlineMisses++;
      fallbacks++;
      finish(disabledRecord(GDO_ELEVATION_REFUSAL.DEADLINE));
    }, merged.deadlineMilliseconds);
    const provisional = Object.freeze({
      ...disabledRecord(null),
      status: 'provisional',
      refusal: null,
      key: tileKey,
      promise,
    });
    const received = Promise.resolve()
      .then(() => fetchTile({ ...tile }))
      .then(raster => {
        if (done) { lateArrivals++; return; }
        if (!raster) { failures++; fallbacks++; finish(disabledRecord(GDO_ELEVATION_REFUSAL.FETCH_FAILED)); return; }
        let layer;
        try {
          const entry = adopt(tileKey, { ...raster, tile }, spec.attribution);
          layer = layerFor(entry, bounds, resolution);
        } catch (error) {
          // A raster that cannot be resampled must not poison the cache.
          const poisoned = entries.get(tileKey);
          if (poisoned) {
            entries.delete(tileKey);
            bytes -= poisoned.bytes;
          }
          failures++;
          fallbacks++;
          finish(disabledRecord(GDO_ELEVATION_REFUSAL.BAD_RASTER));
          return;
        }
        finish(Object.freeze({
          namespace: GDO_ELEVATION_NAMESPACE,
          status: 'ready',
          fallback: null,
          refusal: null,
          ...layer,
          attribution: spec.attribution,
          key: tileKey,
          cached: false,
          promise: Promise.resolve(null),
        }));
      }, () => {
        if (done) { lateArrivals++; return; }
        failures++;
        fallbacks++;
        finish(disabledRecord(GDO_ELEVATION_REFUSAL.FETCH_FAILED));
      });
    // A rejected fetch already resolves; this only keeps the chain quiet.
    received.catch(() => {});
    return provisional;
  }

  return Object.freeze({
    namespace: GDO_ELEVATION_NAMESPACE,
    provider: spec ? spec.id : null,
    attribution: spec?.attribution ?? null,
    available: usable(),
    zoom,
    limits: merged,
    request,
    /** Convenience: request and wait, with the same never-rejects contract. */
    async resolve(options) {
      const record = request(options);
      if (record.status === 'ready' || record.status === 'fallback') return record;
      return record.promise;
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
    has: key => entries.has(key),
    get diagnostics() {
      return Object.freeze({
        namespace: GDO_ELEVATION_NAMESPACE,
        provider: spec?.id ?? null,
        available: usable(),
        attribution: spec?.attribution ?? null,
        zoom,
        cachedTiles: entries.size,
        cachedBytes: bytes,
        inFlight: inFlight.size,
        requests,
        hits,
        misses,
        joined,
        evictions,
        fallbacks,
        deadlineMisses,
        lateArrivals,
        burstRefusals,
        failures,
        maxTiles: merged.maxTiles,
        maxBytes: merged.maxBytes,
        limits: merged,
      });
    },
  });
}
