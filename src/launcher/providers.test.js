import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyProvider, describeProvider, loadMapProviders, parseProviderDocument } from './providers.js';

/**
 * The provider file is data a host can re-point without a rebuild, which means it
 * is also the place a bad URL could get in. These tests pin the two shapes the
 * game accepts — an XYZ template and, since `MAP-10a`, a PMTiles archive — and
 * the fields that must travel with either.
 */

const REAL = JSON.parse(readFileSync(new URL('../../public/map-providers.json', import.meta.url), 'utf8'));

test('the shipped provider file survives the reader unchanged', () => {
  const providers = parseProviderDocument(REAL);
  assert.ok(providers.length >= 2, 'the free path has at least two providers');
  for (const provider of providers) {
    assert.equal(provider.kind, 'xyz');
    assert.match(provider.url, /\{z\}/);
    assert.ok(provider.attribution, `${provider.id} carries its credit`);
    assert.ok(provider.schema, `${provider.id} carries its schema`);
  }
  // Order is the game's fallback order, so it is preserved.
  assert.deepEqual(providers.map(provider => provider.id), REAL.providers.map(provider => provider.id));
  assert.ok(Object.isFrozen(providers[0]));
});

test('a PMTiles archive is a provider now, and a template is still a template', () => {
  assert.equal(classifyProvider({ id: 'a', url: 'https://tiles.example/city.pmtiles' }), 'pmtiles');
  assert.equal(classifyProvider({ id: 'a', kind: 'pmtiles', url: 'https://tiles.example/city' }), 'pmtiles');
  assert.equal(classifyProvider({ id: 'a', url: 'https://t/x/{z}/{x}/{y}.pbf' }), 'xyz');
  assert.equal(classifyProvider({ id: 'a', kind: 'xyz', url: 'https://t/x/{z}/{x}/{y}.mvt' }), 'xyz');
  // Contradictions and half-templates are refused rather than guessed at.
  assert.equal(classifyProvider({ id: 'a', kind: 'pmtiles', url: 'https://t/{z}/{x}/{y}.pbf' }), null);
  assert.equal(classifyProvider({ id: 'a', kind: 'xyz', url: 'https://tiles.example/city.pmtiles' }), null);
  assert.equal(classifyProvider({ id: 'a', kind: 'vector', url: 'https://t/x/{z}/{x}/{y}.pbf' }), null);
  assert.equal(classifyProvider({ id: 'a', url: 'https://t/x/{z}/{y}.pbf' }), null);
  assert.equal(classifyProvider({ id: '', url: 'https://t/{z}/{x}/{y}.pbf' }), null);
  assert.equal(classifyProvider({ id: 'a', url: 'http://insecure/{z}/{x}/{y}.pbf' }), null, 'plain http is refused');
  assert.equal(classifyProvider({ id: 'a', url: '//protocol-relative/{z}/{x}/{y}.pbf' }), null);
  assert.equal(classifyProvider(null), null);

  // A relative path is legitimate: the game can ship its own extract.
  assert.equal(classifyProvider({ id: 'a', url: '/tiles/city.pmtiles' }), 'pmtiles');
});

test('a provider descriptor keeps only what the game reads', () => {
  const described = describeProvider({
    id: ' gdo ', label: '', url: 'https://tiles.example/city.pmtiles', kind: 'pmtiles',
    attribution: '  © OpenStreetMap contributors  ', schema: ' openmaptiles ', extra: { nested: true },
  });
  assert.deepEqual(described, {
    id: 'gdo',
    label: 'gdo',
    url: 'https://tiles.example/city.pmtiles',
    kind: 'pmtiles',
    schema: 'openmaptiles',
    attribution: '© OpenStreetMap contributors',
  });
  assert.equal(describeProvider({ id: 'a', url: 'https://t/{z}/{x}/{y}.pbf' }).attribution, undefined);
  // A credit that is absurdly long is clipped rather than smuggled into the HUD.
  assert.equal(describeProvider({
    id: 'a', url: 'https://t/{z}/{x}/{y}.pbf', attribution: 'x'.repeat(400),
  }).attribution.length, 160);
  assert.equal(describeProvider({ id: 'a', url: 'https://t/nothing.bin' }), null);
});

test('an unusable document means "use the engine defaults", not a failed launch', async () => {
  assert.equal(parseProviderDocument(null), undefined);
  assert.equal(parseProviderDocument({ providers: [] }), undefined);
  assert.equal(parseProviderDocument({ providers: [{ id: 'a', url: 'ftp://nope' }] }), undefined);
  assert.equal(parseProviderDocument({ providers: 'nope' }), undefined);

  const working = async () => ({ ok: true, json: async () => REAL });
  assert.ok((await loadMapProviders({ baseUrl: '/', fetchImpl: working })).length >= 2);
  const missing = async () => ({ ok: false, status: 404, json: async () => ({}) });
  assert.equal(await loadMapProviders({ fetchImpl: missing }), undefined);
  const throwing = async () => { throw new Error('offline'); };
  assert.equal(await loadMapProviders({ fetchImpl: throwing }), undefined);
  assert.equal(await loadMapProviders({ fetchImpl: null }), undefined);

  // The URL it asks for is the deployed file, not a build-time constant.
  const seen = [];
  await loadMapProviders({ baseUrl: '/preview/', fetchImpl: async url => { seen.push(url); return { ok: true, json: async () => REAL }; } });
  assert.deepEqual(seen, ['/preview/map-providers.json']);
});
