/**
 * Read the provider list the game runs on (`public/map-providers.json`).
 *
 * The list is data, not code: a host can re-point a tile source without a rebuild,
 * which is the whole reason it is a file. Two shapes are legitimate now that
 * `MAP-10a` shipped — an XYZ template with `{z}/{x}/{y}`, and a PMTiles archive
 * addressed by range request — so an entry is accepted when it is *either*, and
 * refused when it is neither. Everything a caller can rely on travels with the
 * descriptor: the id (cache key), the schema (`MAP-08`), and the credit (`MAP-09`
 * refuses to persist an uncredited payload).
 */

const SAFE_URL = /^(https:\/\/|\/(?!\/))/;

/** Is this a usable entry, and which kind is it? `null` means refuse it. */
export function classifyProvider(provider) {
  if (!provider || typeof provider !== 'object') return null;
  const { id, url, kind } = provider;
  if (typeof id !== 'string' || !id.trim()) return null;
  if (typeof url !== 'string' || !SAFE_URL.test(url)) return null;
  const isArchive = kind === 'pmtiles' || /\.pmtiles(\?|#|$)/i.test(url);
  const isTemplate = url.includes('{z}') && url.includes('{x}') && url.includes('{y}');
  if (kind === 'pmtiles') return isTemplate ? null : 'pmtiles';
  if (kind === 'xyz') return isTemplate ? 'xyz' : null;
  if (kind != null) return null;
  if (isArchive && !isTemplate) return 'pmtiles';
  return isTemplate ? 'xyz' : null;
}

/** Normalise one declared provider, keeping only the fields the game reads. */
export function describeProvider(provider) {
  const kind = classifyProvider(provider);
  if (!kind) return null;
  const clean = {
    id: provider.id.trim(),
    label: typeof provider.label === 'string' && provider.label.trim() ? provider.label.trim() : provider.id.trim(),
    url: provider.url,
    kind,
  };
  if (typeof provider.schema === 'string' && provider.schema.trim()) clean.schema = provider.schema.trim();
  const attribution = typeof provider.attribution === 'string' ? provider.attribution.trim() : '';
  if (attribution) clean.attribution = attribution.slice(0, 160);
  return Object.freeze(clean);
}

/**
 * Parse a provider document. Returns the usable providers in declared order, or
 * `undefined` when nothing can be used — the caller then mounts with the engine's
 * own defaults, which is a working free path rather than a failure.
 */
export function parseProviderDocument(document_) {
  const list = Array.isArray(document_?.providers) ? document_.providers : [];
  const providers = list.map(describeProvider).filter(Boolean);
  return providers.length ? providers : undefined;
}

/** Fetch the deployed list. A missing or broken file is not an error state. */
export async function loadMapProviders({ baseUrl = import.meta.env?.BASE_URL ?? '/', fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') return undefined;
  try {
    const response = await fetchImpl(`${baseUrl}map-providers.json`, { cache: 'no-cache', credentials: 'same-origin' });
    if (!response.ok) return undefined;
    return parseProviderDocument(await response.json());
  } catch {
    return undefined;
  }
}
