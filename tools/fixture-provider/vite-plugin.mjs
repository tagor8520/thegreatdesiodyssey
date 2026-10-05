/**
 * Development-only offline map provider.
 *
 * WHY
 * ---
 * Coordinate Explorer normally fetches vector tiles from public map servers.
 * Those hosts are unreachable in restricted build environments, which blocked
 * every visual gate that needs mapped geometry: `COL-05` (orbit real buildings),
 * `LAY-03` (transparent water order), and the mapped half of `MAT-03`.
 *
 * The canonical fixtures in `src/geo/GeoFixtures.js` already describe dense
 * urban, coastal, and stacked-bridge tiles. This plugin encodes the selected
 * fixture into a real MVT protobuf (`GeoFixtureTileEncoder`) and serves it at the
 * provider template URL, so the **production worker, decoder, and builders** run
 * unchanged with no network access.
 *
 * SAFETY
 * ------
 * `apply: 'serve'` means this never participates in `vite build`. The production
 * `public/map-providers.json` is untouched on disk; the fixture provider is
 * injected into the response only in dev, and only ahead of the real providers
 * so that a reachable network still works normally when the fixture is not
 * selected.
 *
 * USAGE
 * -----
 * Defaults come from `GDO_FIXTURE_ID` / `GDO_FIXTURE_VARIANT`. A running audit
 * can switch fixture without restarting the server:
 *
 *   POST /__fixture-tiles/select   {"id":"mapped-coast","variant":"openmaptiles"}
 *   GET  /__fixture-tiles/current
 */
import { readFile } from 'node:fs/promises';
import {
  encodeFixtureVectorTileReport,
  GEO_FIXTURE_TILE_SCHEMA,
} from '../../src/geo/GeoFixtureTileEncoder.js';
import { GEO_FIXTURE_MATRIX } from '../../src/geo/GeoFixtures.js';

export const FIXTURE_PROVIDER_ID = 'gdo-offline-fixture';
const TILE_PREFIX = '/fixture-tiles/';
const SELECT_PATH = '/__fixture-tiles/select';
const CURRENT_PATH = '/__fixture-tiles/current';

const VALID = new Map(GEO_FIXTURE_MATRIX.map(entry => [entry.id, entry.variants]));

function resolveSelection(id, variant) {
  const variants = VALID.get(id);
  if (!variants) throw new RangeError(`Unknown fixture id "${id}". Known: ${[...VALID.keys()].join(', ')}`);
  if (!variants.includes(variant)) {
    throw new RangeError(`Fixture "${id}" does not support variant "${variant}". Try: ${variants.join(', ')}`);
  }
  return { id, variant };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  });
  response.end(body);
}

export function fixtureProvider({ id = 'dense-urban', variant = 'openmaptiles', log = true } = {}) {
  let selection = resolveSelection(
    process.env.GDO_FIXTURE_ID || id,
    process.env.GDO_FIXTURE_VARIANT || variant,
  );
  let served = 0;

  /** Serve the selected fixture as a real MVT for any requested z/x/y. */
  function serveTile(response) {
    const report = encodeFixtureVectorTileReport(selection.id, selection.variant);
    served++;
    if (log && served <= 3) {
      const layers = report.layers.map(layer => `${layer.name}:${layer.features}`).join(', ');
      console.log(`  [fixture-provider] served ${selection.id}/${selection.variant} ` +
        `(${report.bytes} B) ${layers}`);
    }
    response.writeHead(200, {
      'content-type': 'application/x-protobuf',
      'content-length': report.data.byteLength,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-gdo-fixture': `${selection.id}/${selection.variant}`,
      'x-gdo-fixture-schema': GEO_FIXTURE_TILE_SCHEMA,
    });
    response.end(Buffer.from(report.data));
  }

  return {
    name: 'gdo-fixture-provider',
    apply: 'serve',

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url, 'http://localhost');

        // Fixture selection control, used by the visual audit harness.
        if (url.pathname === CURRENT_PATH) {
          sendJson(response, 200, { ...selection, schema: GEO_FIXTURE_TILE_SCHEMA, served });
          return;
        }
        if (url.pathname === SELECT_PATH) {
          void (async () => {
            try {
              const body = await readBody(request);
              const parsed = body ? JSON.parse(body) : {};
              selection = resolveSelection(parsed.id ?? selection.id, parsed.variant ?? selection.variant);
              console.log(`  [fixture-provider] selection -> ${selection.id}/${selection.variant}`);
              sendJson(response, 200, { ...selection, schema: GEO_FIXTURE_TILE_SCHEMA });
            } catch (error) {
              sendJson(response, 400, { error: error.message });
            }
          })();
          return;
        }

        // The MVT payload itself.
        if (url.pathname.startsWith(TILE_PREFIX)) {
          try {
            serveTile(response);
          } catch (error) {
            sendJson(response, 500, { error: error.message });
          }
          return;
        }

        // Inject the offline provider ahead of the real ones, in dev only.
        if (url.pathname.endsWith('/map-providers.json')) {
          void (async () => {
            try {
              const raw = await readFile(new URL('../../public/map-providers.json', import.meta.url), 'utf8');
              const config = JSON.parse(raw);
              const providers = Array.isArray(config.providers) ? config.providers : [];
              const fixtureProviderEntry = {
                id: FIXTURE_PROVIDER_ID,
                label: `Offline fixture (dev) — ${selection.id}/${selection.variant}`,
                url: `${TILE_PREFIX}{z}/{x}/{y}.pbf`,
              };
              const withoutFixture = providers.filter(provider => provider.id !== FIXTURE_PROVIDER_ID);
              sendJson(response, 200, { ...config, providers: [fixtureProviderEntry, ...withoutFixture] });
            } catch (error) {
              next(error);
            }
          })();
          return;
        }

        next();
      });
    },
  };
}

/**
 * Keep the fixture `.pbf` artefacts out of production output.
 *
 * The tiles must live in `public/` so the dev server can serve them at a
 * same-origin URL without loader changes. `public/` is copied verbatim by
 * `vite build`, so without this the inert bytes would ship to players. Nothing
 * in production references them (`dist/map-providers.json` is the untouched
 * source file), but shipping unused fixture data is still wrong: it is dead
 * weight, and it invites a future change to wire a fixture provider up in
 * production. Prune it, loudly.
 */
export function pruneFixtureTiles({ log = true } = {}) {
  return {
    name: 'gdo-fixture-tiles-prune',
    apply: 'build',
    async closeBundle() {
      const directory = new URL('../../dist/fixture-tiles', import.meta.url);
      const { rm } = await import('node:fs/promises');
      try {
        await rm(directory, { recursive: true, force: true });
        if (log) console.log('  [fixture-tiles] pruned public/fixture-tiles from dist/ (dev-only artefacts)');
      } catch (error) {
        if (log) console.warn(`  [fixture-tiles] could not prune dist/fixture-tiles: ${error.message}`);
      }
    },
  };
}

export default fixtureProvider;
