export const GDO_FEATURE_VERSIONS = Object.freeze({
  registry: 1,
  mapTile: 3,
  collision: 4,
  terrain: 1,
  qualityFixture: 1,
  diagnostics: 1,
  materialLibrary: 2,
  vegetationGrammar: 1,
  vegetationGeometry: 1,
  vegetationLod: 1,
  vegetationRender: 1,
  waterDomain: 2,
  vegetationClearance: 1,
  vegetationMorphology: 1,
  vegetationWind: 1,
  objectGrammar: 2,
  streetFurniture: 1,
  // `CNT-01` (2026-10-05): the versioned state-content schema exists, so this is no
  // longer a researched contract. `saveSchema` stays 0 — that is `NET-01`'s.
  contentSchema: 1,
  saveSchema: 0,
});

export const GDO_GENERATOR_VERSION = Object.entries(GDO_FEATURE_VERSIONS)
  .map(([name, version]) => `${name}@${version}`)
  .join('|');

/** Stable namespace for hashes, caches, generated resources and migrations. */
export function featureNamespace(name) {
  if (!Object.hasOwn(GDO_FEATURE_VERSIONS, name)) throw new RangeError(`Unknown feature version: ${name}`);
  return `gdo:${name}:v${GDO_FEATURE_VERSIONS[name]}`;
}

/** Zero marks a researched contract that has not produced a compatible schema yet. */
export function featureAvailable(name) {
  if (!Object.hasOwn(GDO_FEATURE_VERSIONS, name)) return false;
  return GDO_FEATURE_VERSIONS[name] > 0;
}
