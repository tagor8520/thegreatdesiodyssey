import { featureNamespace } from './FeatureVersions.js';

/**
 * `CNT-04` shipped state-pack catalogue.
 *
 * A browser cannot list a directory, so the packs the game ships are declared
 * here: one id per pack, in one place, with the path the runtime fetches and the
 * path the tooling validates. The catalogue is what makes "added only through
 * the validated pipeline" checkable — a pack file that is not in this list, or
 * an entry with no file, is a mismatch the CLI and the tests both refuse, so
 * content can never be added by dropping an unvalidated JSON file in the folder.
 *
 * No `three`, no DOM, no filesystem: the runtime imports this, and the Node
 * tooling reads the same list.
 */

export const GDO_STATE_CATALOG_NAMESPACE = featureNamespace('stateCatalog');

/** The packs that ship today, in the order a UI should offer them. */
export const GDO_STATE_PACK_IDS = Object.freeze([
  'kerala', 'maharashtra', 'karnataka', 'punjab', 'tamil_nadu',
]);

/** Where a pack lives on disk, relative to the repository root. */
export function statePackSourcePath(id) {
  if (!GDO_STATE_PACK_IDS.includes(id)) {
    throw new RangeError(`Unknown state pack "${id}"; register it in GDO_STATE_PACK_IDS first`);
  }
  return `public/content/states/${id}.json`;
}

/** Where the runtime fetches that pack (Vite serves `public/` at the root). */
export function statePackRuntimePath(id) {
  if (!GDO_STATE_PACK_IDS.includes(id)) {
    throw new RangeError(`Unknown state pack "${id}"; register it in GDO_STATE_PACK_IDS first`);
  }
  return `/content/states/${id}.json`;
}

/**
 * Compare the catalogue against the ids actually present in the content folder.
 * Returns every mismatch in both directions instead of throwing, so a caller can
 * report all of them at once.
 */
export function verifyStatePackFiles(shippedIds) {
  const shipped = [...new Set((shippedIds ?? []).map(String))].sort();
  const listed = [...GDO_STATE_PACK_IDS].sort();
  return Object.freeze({
    ok: shipped.length === listed.length && shipped.every((id, index) => id === listed[index]),
    listed: Object.freeze(listed),
    shipped: Object.freeze(shipped),
    /** Registered packs with no file on disk. */
    missing: Object.freeze(listed.filter(id => !shipped.includes(id))),
    /** Files on disk that no one registered, so no one validates them. */
    unlisted: Object.freeze(shipped.filter(id => !listed.includes(id))),
  });
}

/** Diagnostics view: what the game ships, and where it reads it from. */
export function describeStateCatalog() {
  return Object.freeze({
    namespace: GDO_STATE_CATALOG_NAMESPACE,
    count: GDO_STATE_PACK_IDS.length,
    ids: Object.freeze([...GDO_STATE_PACK_IDS]),
    runtimePaths: Object.freeze(GDO_STATE_PACK_IDS.map(statePackRuntimePath)),
  });
}
