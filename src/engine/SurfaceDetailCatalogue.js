import {
  GDO_MATERIAL_DETAIL_PROFILES,
  GDO_MATERIAL_RECIPES,
  GDO_STYLE_MASK_NAMES,
} from './ProceduralMaterials.js';
import { GDO_SURFACE_DETAIL_CAPS, GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import { featureNamespace } from './FeatureVersions.js';

/**
 * `MAT-05` surface-detail catalogue rollout.
 *
 * `MAT-02` generates the tiny texture library, `MAT-03` declares how a detail
 * fades with distance and footprint, and `MAT-04` gives each semantic its recipe.
 * What was missing is the **catalogue**: one prioritized, declared list of the
 * surface detail patterns the game ships, each naming the generated source it
 * reads, the repeat it wants, the filter policy it obeys, and the lowest profile
 * that may afford it.
 *
 * Two properties are the point of the whole module:
 *
 * 1. **No downloaded baseline textures.** Every entry reads a texture that
 *    `generateMaterialData` computed at runtime — a surface-noise channel, one
 *    of the 16×16 style masks, or the palette LUT — or it is purely analytical.
 *    `validateSurfaceDetailSources` refuses anything else by name, so a future
 *    entry cannot smuggle in an image file.
 * 2. **Prioritized rollout.** The list order *is* the priority. A profile gets
 *    the first `cap` entries, the rest are reported as pruned, and the shipped
 *    style-mask vocabulary is fully covered: every declared mask is reachable by
 *    exactly one catalogue pattern, so no generated pattern exists in code that
 *    the catalogue has forgotten.
 */

export const GDO_SURFACE_DETAIL_NAMESPACE = featureNamespace('surfaceDetail');

/** Where a pattern's data comes from. `analytical` needs no texture at all. */
export const GDO_SURFACE_DETAIL_SOURCES = Object.freeze(['surfaceNoise', 'styleMasks', 'paletteLUT', 'analytical']);

/** `MAT-03`'s filter vocabulary, so a pattern cannot invent its own policy. */
export const GDO_SURFACE_DETAIL_FILTERS = Object.freeze(['mip', 'derivative', 'nearest', 'analytical']);

/**
 * The catalogue, in priority order. Each entry:
 *   `surface`  — the `MAT-04` semantic this pattern dresses;
 *   `style`    — the generated 16×16 mask it draws with (must be declared);
 *   `source`   — the generated texture it samples, and through which channel;
 *   `repeat`   — metres per pattern tile, so scale is a property of the surface;
 *   `samples`  — texture reads a fragment of that surface spends;
 *   `filter`   — the `MAT-03` policy that keeps the pattern from shimmering;
 *   `minProfile` — the lowest detail profile that may afford it;
 *   `research` — the research section the pattern comes from.
 */
export const GDO_SURFACE_DETAIL_PATTERNS = Object.freeze([
  Object.freeze({ id: 'facade.plaster', surface: 'facade', style: 'plaster', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: .7, samples: 1, filter: 'mip', minProfile: 'low', research: '§5.3 plaster/limewash' }),
  Object.freeze({ id: 'roof.tile-rows', surface: 'roof', style: 'roofTile', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: 1.1, samples: 1, filter: 'mip', minProfile: 'low', research: '§5.3 roof tiles' }),
  Object.freeze({ id: 'road.asphalt', surface: 'road', style: 'asphalt', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: .45, samples: 1, filter: 'mip', minProfile: 'low', research: '§5.2 asphalt aggregate' }),
  Object.freeze({ id: 'bark.ridge', surface: 'bark', style: 'bark', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: 1.6, samples: 1, filter: 'mip', minProfile: 'low', research: '§5.4 bark ridges' }),
  Object.freeze({ id: 'leaf.canopy-dapple', surface: 'leaf', style: 'leaf', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: 1.2, samples: 1, filter: 'mip', minProfile: 'low', research: '§5.4 canopy dapple' }),
  Object.freeze({ id: 'water.foam-chop', surface: 'water', style: 'foam', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: .8, samples: 1, filter: 'mip', minProfile: 'low', research: '§5.5 water surface' }),
  Object.freeze({ id: 'land.paddy-grid', surface: 'land', style: 'paddy', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: .42, samples: 1, filter: 'mip', minProfile: 'low', research: '§5.1 paddy/wet-field grid' }),
  Object.freeze({ id: 'ground.leaf-litter', surface: 'ground', style: 'litter', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: .9, samples: 1, filter: 'mip', minProfile: 'low', research: '§5.1 leaf litter' }),
  Object.freeze({ id: 'ground.pebble-gravel', surface: 'ground', style: 'gravel', source: Object.freeze({ texture: 'styleMasks', channel: 'g' }), repeat: 2.4, samples: 1, filter: 'mip', minProfile: 'balanced', research: '§5.1 gravel/pebbles' }),
  Object.freeze({ id: 'road.paver-bond', surface: 'road', style: 'paver', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: .6, samples: 1, filter: 'mip', minProfile: 'balanced', research: '§5.2 brick/herringbone paver' }),
  Object.freeze({ id: 'facade.brick-bond', surface: 'facade', style: 'brick', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: .7, samples: 1, filter: 'mip', minProfile: 'balanced', research: '§5.3 brick bond' }),
  Object.freeze({ id: 'roof.corrugated-band', surface: 'roof', style: 'corrugated', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: 1.4, samples: 1, filter: 'mip', minProfile: 'balanced', research: '§5.3 corrugated metal' }),
  Object.freeze({ id: 'decoration.wood-grain', surface: 'decoration', style: 'wood', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: .9, samples: 1, filter: 'derivative', minProfile: 'balanced', research: '§5.3 wood grain' }),
  Object.freeze({ id: 'decoration.fabric-check', surface: 'decoration', style: 'fabric', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: .8, samples: 1, filter: 'nearest', minProfile: 'balanced', research: '§5.3 fabric/awning check' }),
  Object.freeze({ id: 'leaf.frond-band', surface: 'leaf', style: 'frond', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: 1.5, samples: 1, filter: 'mip', minProfile: 'balanced', research: '§5.4 palm frond bands' }),
  Object.freeze({ id: 'bark.moss-patch', surface: 'bark', style: 'moss', source: Object.freeze({ texture: 'styleMasks', channel: 'b' }), repeat: 3.1, samples: 1, filter: 'mip', minProfile: 'balanced', research: '§5.4 moss/lichen' }),
  Object.freeze({ id: 'facade.jali-screen', surface: 'facade', style: 'jali', source: Object.freeze({ texture: 'styleMasks', channel: 'a' }), repeat: 1.2, samples: 1, filter: 'nearest', minProfile: 'high', research: '§5.3 jali/perforated screen' }),
  Object.freeze({ id: 'facade.paint-wear', surface: 'facade', style: 'wear', source: Object.freeze({ texture: 'styleMasks', channel: 'g' }), repeat: 1.3, samples: 1, filter: 'nearest', minProfile: 'high', research: '§5.3 painted wear/chips' }),
  Object.freeze({ id: 'roof.rust-streak', surface: 'roof', style: 'rust', source: Object.freeze({ texture: 'styleMasks', channel: 'b' }), repeat: 2.2, samples: 1, filter: 'mip', minProfile: 'high', research: '§5.3 rust/oxidation' }),
  Object.freeze({ id: 'road.crack-ridge', surface: 'road', style: 'crack', source: Object.freeze({ texture: 'styleMasks', channel: 'b' }), repeat: 3.2, samples: 1, filter: 'mip', minProfile: 'high', research: '§5.2 road crack' }),
  Object.freeze({ id: 'ground.stone-block', surface: 'ground', style: 'stone', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: 2.6, samples: 1, filter: 'mip', minProfile: 'high', research: '§5.1 rock speckle / §5.3 stone block' }),
  Object.freeze({ id: 'leaf.flower-spot', surface: 'leaf', style: 'flower', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: 1.1, samples: 1, filter: 'nearest', minProfile: 'high', research: '§5.4 flower center/petal' }),
  Object.freeze({ id: 'road.rain-sheen', surface: 'road', style: 'rain', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: 5, samples: 1, filter: 'mip', minProfile: 'high', research: '§5.5 wet sheen' }),
  Object.freeze({ id: 'ground.snow-cover', surface: 'ground', style: 'snow', source: Object.freeze({ texture: 'styleMasks', channel: 'r' }), repeat: 4, samples: 1, filter: 'mip', minProfile: 'high', research: '§5.1 snow/frost cover' }),
]);

/** Order *is* priority: index 0 is the first pattern a constrained device gets. */
export function surfaceDetailPriority(id) {
  const index = GDO_SURFACE_DETAIL_PATTERNS.findIndex(entry => entry.id === id);
  if (index < 0) throw new RangeError(`Unknown surface detail pattern: ${id}`);
  return index;
}

export function surfaceDetailEntry(id) {
  const entry = GDO_SURFACE_DETAIL_PATTERNS.find(candidate => candidate.id === id);
  if (!entry) throw new RangeError(`Unknown surface detail pattern: ${id}`);
  return entry;
}

export function surfaceDetailPatternsFor(surface) {
  if (!GDO_MATERIAL_RECIPES[surface]) throw new RangeError(`Unknown surface semantic: ${surface}`);
  return Object.freeze(GDO_SURFACE_DETAIL_PATTERNS.filter(entry => entry.surface === surface));
}

const PROFILE_ORDER = Object.freeze(['low', 'balanced', 'high']);

function profileRank(profile) {
  const rank = PROFILE_ORDER.indexOf(profile);
  if (rank < 0) throw new RangeError(`Unknown surface-detail profile: ${profile}`);
  return rank;
}

/**
 * The rollout for one profile: the highest-priority entries that profile may
 * afford, what was pruned and why, and the measured sample cost per surface. The
 * low profile keeps one generated pattern per surface, which is the research's
 * "low uses one sample" rule expressed as a ceiling rather than a convention.
 */
export function rolloutSurfaceDetails(profile = 'low') {
  const rank = profileRank(profile);
  const caps = GDO_SURFACE_DETAIL_CAPS[profile];
  if (!caps) throw new RangeError(`Unknown surface-detail profile: ${profile}`);
  const enabled = [], pruned = [];
  const samplesPerSurface = new Map();
  for (const entry of GDO_SURFACE_DETAIL_PATTERNS) {
    const surfaceSamples = samplesPerSurface.get(entry.surface) ?? 0;
    // The floor is checked first: a pattern this profile cannot afford is pruned
    // for that reason, not merely reported as overflow once the cap is full.
    if (profileRank(entry.minProfile) > rank) { pruned.push(Object.freeze({ id: entry.id, reason: 'profile-floor' })); continue; }
    if (enabled.length >= caps.patterns) { pruned.push(Object.freeze({ id: entry.id, reason: 'profile-cap' })); continue; }
    if (surfaceSamples + entry.samples > caps.samplesPerSurface) {
      pruned.push(Object.freeze({ id: entry.id, reason: 'surface-samples' }));
      continue;
    }
    enabled.push(entry);
    samplesPerSurface.set(entry.surface, surfaceSamples + entry.samples);
  }
  return Object.freeze({
    namespace: GDO_SURFACE_DETAIL_NAMESPACE,
    profile,
    cap: caps.patterns,
    patterns: enabled.length,
    ids: Object.freeze(enabled.map(entry => entry.id)),
    entries: Object.freeze(enabled),
    pruned: Object.freeze(pruned),
    samplesPerSurface: Object.freeze(Object.fromEntries(
      [...samplesPerSurface.entries()].sort((a, b) => a[0].localeCompare(b[0])))),
    surfaces: Object.freeze([...samplesPerSurface.keys()].sort()),
    totalSamples: enabled.reduce((total, entry) => total + entry.samples, 0),
    // The rollout reads the textures `MAT-02` already generated; it never adds one.
    generatedTextures: new Set(enabled.filter(entry => entry.source.texture).map(entry => entry.source.texture)).size,
  });
}

function fnv(text, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic pattern choice for one surface. The same `key` (a tile key, a
 * world seed, a mount context) always selects the same pattern, and over many
 * keys every enabled pattern of that surface is reached, so a rollout variant is
 * reachable rather than decorative.
 */
export function selectSurfaceDetail(surface, { key = 'default', profile = 'low' } = {}) {
  const enabled = rolloutSurfaceDetails(profile).entries.filter(entry => entry.surface === surface);
  if (enabled.length === 0) throw new RangeError(`No ${profile}-profile pattern for surface: ${surface}`);
  const index = fnv(`${surface}:${key}`) % enabled.length;
  return enabled[index];
}

/**
 * Prove the catalogue only ever reads generated data. A violation names the
 * entry, so a future pattern cannot quietly reference a file.
 */
export function validateSurfaceDetailSources(library = null) {
  const violations = [];
  const styleNames = new Set(GDO_STYLE_MASK_NAMES);
  const recordFor = name => library?.diagnostics?.records?.find(record => record.name === name) ?? null;
  const seenStyles = new Map();
  for (const entry of GDO_SURFACE_DETAIL_PATTERNS) {
    if (!GDO_MATERIAL_RECIPES[entry.surface]) violations.push(`${entry.id}: unknown surface ${entry.surface}`);
    if (!styleNames.has(entry.style)) violations.push(`${entry.id}: unknown style mask ${entry.style}`);
    if (seenStyles.has(entry.style)) {
      violations.push(`${entry.id}: style mask ${entry.style} is already rolled out by ${seenStyles.get(entry.style)}`);
    }
    seenStyles.set(entry.style, entry.id);
    if (!GDO_SURFACE_DETAIL_FILTERS.includes(entry.filter)) violations.push(`${entry.id}: unknown filter ${entry.filter}`);
    if (!PROFILE_ORDER.includes(entry.minProfile)) violations.push(`${entry.id}: unknown profile ${entry.minProfile}`);
    if (!(entry.repeat > 0) || !Number.isInteger(entry.samples) || entry.samples < 1) {
      violations.push(`${entry.id}: invalid repeat/samples`);
    }
    const source = entry.source;
    if (!source || typeof source !== 'object') { violations.push(`${entry.id}: missing source`); continue; }
    if (source.texture === undefined) {
      // An analytical source names a computation; it never names a file.
      if (typeof source.analytical !== 'string' || !source.analytical) {
        violations.push(`${entry.id}: analytical source needs a name`);
      }
      continue;
    }
    if (!GDO_SURFACE_DETAIL_SOURCES.includes(source.texture)) {
      violations.push(`${entry.id}: unknown generated source ${source.texture}`);
      continue;
    }
    if (!['r', 'g', 'b', 'a'].includes(source.channel)) {
      violations.push(`${entry.id}: channel ${source.channel} is not a generated channel`);
    }
    if (!library) continue;
    const texture = library.textures?.[source.texture];
    if (!texture) { violations.push(`${entry.id}: ${source.texture} is not in the shared library`); continue; }
    // A generated texture carries the library's own marker and behaves like
    // typed data; a file-backed one would carry a URL or an external flag.
    if (!texture.userData?.proceduralMaterial) {
      violations.push(`${entry.id}: ${source.texture} is not generated at runtime`);
    }
    if (typeof texture.image === 'string' || texture.userData?.gdoExternal) {
      violations.push(`${entry.id}: ${source.texture} is not generated at runtime`);
    }
    const record = recordFor(source.texture);
    if (!record) { violations.push(`${entry.id}: ${source.texture} has no generated-texture record`); continue; }
    if (!/^[0-9a-f]{8}$/.test(record.checksum ?? '')) {
      violations.push(`${entry.id}: ${source.texture} carries no pinned generated checksum`);
    }
    if (record.ownership !== 'shared-engine') {
      violations.push(`${entry.id}: ${source.texture} is not owned by the shared library`);
    }
  }
  // The vocabulary and the catalogue have to agree in both directions, so no
  // declared generated mask can be left unreachable.
  for (const style of GDO_STYLE_MASK_NAMES) {
    if (!seenStyles.has(style)) violations.push(`style mask ${style} is declared but no catalogue pattern rolls it out`);
  }
  return Object.freeze({
    namespace: GDO_SURFACE_DETAIL_NAMESPACE,
    ok: violations.length === 0,
    patterns: GDO_SURFACE_DETAIL_PATTERNS.length,
    styles: seenStyles.size,
    surfaces: new Set(GDO_SURFACE_DETAIL_PATTERNS.map(entry => entry.surface)).size,
    violations: Object.freeze(violations),
  });
}

/**
 * `MAT-05`: dress one already-configured material with a catalogue pattern.
 *
 * Uniform-only on purpose: a pattern's mask rect, repeat and strength are the
 * same three uniforms every semantic already reads, so rolling a surface onto
 * another generated pattern never recompiles a shader and never adds a texture.
 * The material keeps its recipe's palette row unless the entry overrides it.
 */
export function applySurfaceDetail(material, entry, library, profileName = 'low') {
  const state = material?.userData?.gdoSemanticMaterial, profile = GDO_MATERIAL_DETAIL_PROFILES[profileName];
  if (!state || !profile) throw new TypeError('applySurfaceDetail needs a configured semantic material');
  if (!entry?.id || !entry.style || !entry.source) throw new TypeError('applySurfaceDetail needs a catalogue entry');
  if (!library?.styleRects?.[entry.style]) throw new RangeError(`Unknown procedural style mask: ${entry.style}`);
  const uniforms = state.uniforms;
  uniforms.gdoStyleRect.value.set(...library.styleRects[entry.style]);
  // The catalogue's repeat is metres per pattern tile, so the material's own
  // style scale is the base rather than a per-pattern hardcoded number.
  uniforms.gdoStyleScale.value = state.recipe.styleScale * (entry.styleScale ?? 1);
  uniforms.gdoStyleStrength.value = (entry.styleStrength ?? state.recipe.styleStrength) * profile.styleStrength;
  if (Number.isFinite(entry.paletteRow)) uniforms.gdoPaletteRow.value = entry.paletteRow;
  const record = Object.freeze({
    namespace: GDO_SURFACE_DETAIL_NAMESPACE,
    id: entry.id,
    surface: entry.surface,
    style: entry.style,
    source: entry.source,
    repeat: entry.repeat,
    samples: entry.samples,
    filter: entry.filter,
    minProfile: entry.minProfile,
    research: entry.research,
    profile: profileName,
    recompiled: false,
  });
  material.userData.gdoSurfaceDetail = record;
  return record;
}

/** Read back the catalogue pattern a material is wearing, if any. */
export function surfaceDetailOf(material) {
  return material?.userData?.gdoSurfaceDetail ?? null;
}

/** Diagnostics view: what the catalogue declares and what a profile may afford. */
export function describeSurfaceDetailCatalogue({ library = null, profile = 'low' } = {}) {
  const rollout = rolloutSurfaceDetails(profile);
  return Object.freeze({
    namespace: GDO_SURFACE_DETAIL_NAMESPACE,
    patterns: GDO_SURFACE_DETAIL_PATTERNS.length,
    styles: new Set(GDO_SURFACE_DETAIL_PATTERNS.map(entry => entry.style)).size,
    surfaces: [...new Set(GDO_SURFACE_DETAIL_PATTERNS.map(entry => entry.surface))].sort(),
    rollout,
    rolloutBudget: GDO_LOW_PROFILE_BUDGETS.surfaceDetailPatterns,
    sources: validateSurfaceDetailSources(library),
    profiles: Object.freeze(Object.fromEntries(PROFILE_ORDER.map(name => [name, rolloutSurfaceDetails(name).patterns]))),
    detailProfiles: Object.keys(GDO_MATERIAL_DETAIL_PROFILES),
  });
}
