import { GEO_TRANSPORT_KIND, GEO_TRANSPORT_LEVEL, resolveTransportLevel, transportSurfaceY } from './GeoLayers.js';
import { GEO_WATER_CLASS, classifyWaterClass, waterClassName } from './GeoWaterDomains.js';

/**
 * `MAP-08` — the one semantic map adapter.
 *
 * OpenMapTiles and Shortbread are the two schemas this world streams. They spell
 * the same OSM reality differently: OpenMapTiles uses `class`/`subclass`,
 * `brunnel`/`layer`, `render_height`, and layer names like `transportation` or
 * `building`; Shortbread uses `kind` with the raw OSM value, boolean
 * `bridge`/`tunnel`/`link`/`rail` flags, no height field at all, and layer names
 * like `streets`, `buildings` or `water_polygons`.
 *
 * Every consumer in this repository reads provider facts through this module, so
 * a road class, a vertical level, a building height, a land cover class, or a
 * place label means the same thing whichever provider served the tile. Nothing
 * here reads render state, so an unknown or malformed value stays a declared
 * fallback rather than becoming geometry by accident.
 */

export const GEO_MAP_SCHEMA = Object.freeze({
  OPENMAPTILES: 'openmaptiles',
  SHORTBREAD: 'shortbread',
  UNKNOWN: 'unknown',
});

/** Schema ids a provider descriptor may declare, longest match first. */
const SCHEMA_ALIASES = Object.freeze([
  // Shortbread spellings first: `versatiles` and `openstreetmap` both serve it.
  ['shortbread', GEO_MAP_SCHEMA.SHORTBREAD],
  ['openstreetmap', GEO_MAP_SCHEMA.SHORTBREAD],
  ['versatiles', GEO_MAP_SCHEMA.SHORTBREAD],
  ['openmaptiles', GEO_MAP_SCHEMA.OPENMAPTILES],
  ['open-map-tiles', GEO_MAP_SCHEMA.OPENMAPTILES],
  ['openfreemap', GEO_MAP_SCHEMA.OPENMAPTILES],
  ['maptiler', GEO_MAP_SCHEMA.OPENMAPTILES],
]);

export function resolveMapSchema(providerId, fallback = GEO_MAP_SCHEMA.OPENMAPTILES) {
  const text = String(providerId ?? '').trim().toLowerCase();
  if (!text) return fallback;
  for (const [needle, schema] of SCHEMA_ALIASES) if (text.includes(needle)) return schema;
  return GEO_MAP_SCHEMA.UNKNOWN;
}

/**
 * Semantic roles. A role is what the geometry means, never where it came from,
 * so layer-name probes in builders and context readers collapse to one table.
 */
export const GEO_MAP_ROLE = Object.freeze({
  TRANSPORT: 'transport',
  TRANSPORT_LABEL: 'transport-label',
  BUILDING: 'building',
  WATER_POLYGON: 'water-polygon',
  WATER_LINE: 'water-line',
  WATER_LABEL: 'water-label',
  LAND: 'land',
  PLACE: 'place',
  BOUNDARY: 'boundary',
  UNKNOWN: 'unknown',
});

/** Layer name → role, covering both schemas in one place. */
const LAYER_ROLES = Object.freeze({
  // OpenMapTiles
  transportation: GEO_MAP_ROLE.TRANSPORT,
  transportation_name: GEO_MAP_ROLE.TRANSPORT_LABEL,
  building: GEO_MAP_ROLE.BUILDING,
  water: GEO_MAP_ROLE.WATER_POLYGON,
  ocean: GEO_MAP_ROLE.WATER_POLYGON,
  waterway: GEO_MAP_ROLE.WATER_LINE,
  water_name: GEO_MAP_ROLE.WATER_LABEL,
  landcover: GEO_MAP_ROLE.LAND,
  landuse: GEO_MAP_ROLE.LAND,
  park: GEO_MAP_ROLE.LAND,
  place: GEO_MAP_ROLE.PLACE,
  mountain_peak: GEO_MAP_ROLE.PLACE,
  aerodrome_label: GEO_MAP_ROLE.PLACE,
  // Shortbread
  streets: GEO_MAP_ROLE.TRANSPORT,
  street_polygons: GEO_MAP_ROLE.TRANSPORT,
  street_labels: GEO_MAP_ROLE.TRANSPORT_LABEL,
  buildings: GEO_MAP_ROLE.BUILDING,
  water_polygons: GEO_MAP_ROLE.WATER_POLYGON,
  water_polygons_labels: GEO_MAP_ROLE.WATER_LABEL,
  water_lines: GEO_MAP_ROLE.WATER_LINE,
  water_lines_labels: GEO_MAP_ROLE.WATER_LABEL,
  dam_lines: GEO_MAP_ROLE.WATER_LINE,
  dam_polygons: GEO_MAP_ROLE.WATER_POLYGON,
  land: GEO_MAP_ROLE.LAND,
  sites: GEO_MAP_ROLE.LAND,
  place_labels: GEO_MAP_ROLE.PLACE,
  boundaries: GEO_MAP_ROLE.BOUNDARY,
});

/**
 * Layer names per role, ordered by preference across both schemas. The order is
 * the existing render lift order, so a provider-neutral tile keeps its surface
 * offsets: land first, then the more specific Shortbread `land`/`sites` spellings.
 */
const ROLE_LAYERS = Object.freeze({
  [GEO_MAP_ROLE.TRANSPORT]: Object.freeze(['transportation', 'streets', 'street_polygons']),
  [GEO_MAP_ROLE.TRANSPORT_LABEL]: Object.freeze(['transportation_name', 'street_labels']),
  [GEO_MAP_ROLE.BUILDING]: Object.freeze(['building', 'buildings']),
  [GEO_MAP_ROLE.WATER_POLYGON]: Object.freeze(['water_polygons', 'water', 'ocean']),
  [GEO_MAP_ROLE.WATER_LINE]: Object.freeze(['waterway', 'water_lines', 'dam_lines']),
  [GEO_MAP_ROLE.WATER_LABEL]: Object.freeze(['water_polygons_labels', 'water_lines_labels', 'water_name']),
  [GEO_MAP_ROLE.LAND]: Object.freeze(['land', 'landcover', 'landuse', 'park', 'sites']),
  [GEO_MAP_ROLE.PLACE]: Object.freeze(['place_labels', 'place', 'mountain_peak', 'aerodrome_label']),
  [GEO_MAP_ROLE.BOUNDARY]: Object.freeze(['boundaries']),
});

export function mapLayerRole(layerName) {
  return LAYER_ROLES[String(layerName ?? '').trim().toLowerCase()] ?? GEO_MAP_ROLE.UNKNOWN;
}

export function mapLayersForRole(role) {
  return Object.freeze([...(ROLE_LAYERS[role] ?? [])]);
}

/** The first declared layer name for a role; undefined when the role has none. */
export function mapLayerNameForRole(role) {
  return ROLE_LAYERS[role]?.[0];
}

/** First present layer for one semantic role, with its resolved role name. */
export function pickMapLayer(vectorTileLayers, role) {
  for (const name of ROLE_LAYERS[role] ?? []) {
    const layer = vectorTileLayers?.[name];
    if (layer) return { name, role, layer };
  }
  return null;
}

/**
 * Canonical road classes. These are the families the geometry, width, colour,
 * and level code switch on; provider spellings collapse into them.
 */
export const GEO_ROAD_CLASS = Object.freeze({
  MOTORWAY: 'motorway',
  TRUNK: 'trunk',
  PRIMARY: 'primary',
  SECONDARY: 'secondary',
  TERTIARY: 'tertiary',
  MINOR: 'minor',
  LIVING_STREET: 'living_street',
  SERVICE: 'service',
  BUSWAY: 'busway',
  TRACK: 'track',
  PATH: 'path',
  RAIL: 'rail',
  FERRY: 'ferry',
  RUNWAY: 'runway',
  TAXIWAY: 'taxiway',
  JUNCTION: 'junction',
  UNKNOWN: 'minor',
});

const ROAD_CLASS_VALUES = new Set(Object.values(GEO_ROAD_CLASS));

/** OpenMapTiles `transportation.class` values, including construction variants. */
const OPENMAPTILES_CONSTRUCTION = /_(construction)$/;

/** Shortbread `streets.kind` is the raw OSM value and needs a real mapping. */
const SHORTBREAD_ROAD_CLASSES = Object.freeze({
  motorway: GEO_ROAD_CLASS.MOTORWAY,
  trunk: GEO_ROAD_CLASS.TRUNK,
  primary: GEO_ROAD_CLASS.PRIMARY,
  secondary: GEO_ROAD_CLASS.SECONDARY,
  tertiary: GEO_ROAD_CLASS.TERTIARY,
  unclassified: GEO_ROAD_CLASS.MINOR,
  residential: GEO_ROAD_CLASS.MINOR,
  living_street: GEO_ROAD_CLASS.LIVING_STREET,
  service: GEO_ROAD_CLASS.SERVICE,
  busway: GEO_ROAD_CLASS.BUSWAY,
  bus_guideway: GEO_ROAD_CLASS.BUSWAY,
  track: GEO_ROAD_CLASS.TRACK,
  footway: GEO_ROAD_CLASS.PATH,
  steps: GEO_ROAD_CLASS.PATH,
  path: GEO_ROAD_CLASS.PATH,
  cycleway: GEO_ROAD_CLASS.PATH,
  bridleway: GEO_ROAD_CLASS.PATH,
  pedestrian: GEO_ROAD_CLASS.PATH,
  raceway: GEO_ROAD_CLASS.TRACK,
  runway: GEO_ROAD_CLASS.RUNWAY,
  taxiway: GEO_ROAD_CLASS.TAXIWAY,
  rail: GEO_ROAD_CLASS.RAIL,
  narrow_gauge: GEO_ROAD_CLASS.RAIL,
  tram: GEO_ROAD_CLASS.RAIL,
  light_rail: GEO_ROAD_CLASS.RAIL,
  funicular: GEO_ROAD_CLASS.RAIL,
  subway: GEO_ROAD_CLASS.RAIL,
  monorail: GEO_ROAD_CLASS.RAIL,
  ferry: GEO_ROAD_CLASS.FERRY,
  pier: GEO_ROAD_CLASS.FERRY,
});

const RAIL_SUBCLASSES = new Set(['rail', 'narrow_gauge', 'tram', 'light_rail', 'funicular', 'subway', 'monorail', 'preserved']);
const PATH_SUBCLASSES = new Set(['footway', 'steps', 'path', 'cycleway', 'bridleway', 'pedestrian', 'corridor', 'platform']);

function text(value) {
  return String(value ?? '').trim().toLowerCase();
}

function flag(value) {
  if (value === true || value === 1) return true;
  const normalized = text(value);
  return normalized === 'yes' || normalized === 'true' || normalized === '1';
}

/**
 * Canonical road class plus the provider spelling that produced it. A class is
 * only rewritten when the schema documents it or when the value is unknown, so
 * a provider that already speaks the canonical vocabulary is passed through.
 */
export function resolveRoadClass(properties = {}, schema = GEO_MAP_SCHEMA.UNKNOWN) {
  const sourceClass = text(properties.class);
  const sourceKind = text(properties.kind);
  const sourceSubclass = text(properties.subclass);
  const sourceType = text(properties.type);
  const rail = flag(properties.rail) || RAIL_SUBCLASSES.has(sourceClass) || RAIL_SUBCLASSES.has(sourceSubclass);
  const declaration = sourceClass || sourceKind || sourceType;

  let roadClass;
  let subclass = sourceSubclass;
  let construction = false;
  if (schema === GEO_MAP_SCHEMA.SHORTBREAD || (!sourceClass && sourceKind && SHORTBREAD_ROAD_CLASSES[sourceKind])) {
    roadClass = SHORTBREAD_ROAD_CLASSES[sourceKind] ?? GEO_ROAD_CLASS.MINOR;
    // Preserve the provider's own spelling for diagnostics and path sub-kinds.
    if (!subclass && sourceKind && sourceKind !== roadClass) subclass = sourceKind;
  } else if (declaration) {
    const constructionMatch = declaration.match(OPENMAPTILES_CONSTRUCTION);
    construction = Boolean(constructionMatch);
    const base = constructionMatch ? declaration.slice(0, constructionMatch.index) : declaration;
    if (base === 'motorway_junction') roadClass = GEO_ROAD_CLASS.JUNCTION;
    else if (base === 'transit') roadClass = GEO_ROAD_CLASS.RAIL;
    else if (ROAD_CLASS_VALUES.has(base)) roadClass = base;
    else if (RAIL_SUBCLASSES.has(base)) { roadClass = GEO_ROAD_CLASS.RAIL; subclass = subclass || base; }
    else if (PATH_SUBCLASSES.has(base)) { roadClass = GEO_ROAD_CLASS.PATH; subclass = subclass || base; }
    else roadClass = GEO_ROAD_CLASS.UNKNOWN;
  } else {
    roadClass = GEO_ROAD_CLASS.UNKNOWN;
  }

  return Object.freeze({
    schema: schema ?? GEO_MAP_SCHEMA.UNKNOWN,
    roadClass,
    subclass: subclass || (RAIL_SUBCLASSES.has(roadClass) ? roadClass : ''),
    rail: rail || roadClass === GEO_ROAD_CLASS.RAIL,
    link: flag(properties.link) || declaration.endsWith('_link') || flag(properties.ramp),
    construction,
    oneway: Number(properties.oneway) === -1 || flag(properties.oneway_reverse) ? -1 : Number(properties.oneway) === 1 || flag(properties.oneway) ? 1 : 0,
    surface: text(properties.surface),
  });
}

const BRIDGE_FLAGS = ['bridge', 'brunnel'];
const TUNNEL_FLAGS = ['tunnel'];

/**
 * Canonical vertical level. OpenMapTiles carries `layer`/`level` plus `brunnel`;
 * Shortbread carries only the boolean `bridge`/`tunnel` flags, so its decks and
 * tunnels sit at one canonical step instead of a surveyed height.
 */
export function resolveMapTransportLevel(properties = {}, schema = GEO_MAP_SCHEMA.UNKNOWN) {
  const bridge = BRIDGE_FLAGS.some(key => (key === 'brunnel' ? text(properties.brunnel) === 'bridge' : flag(properties[key])));
  const tunnel = TUNNEL_FLAGS.some(key => flag(properties[key])) || text(properties.brunnel) === 'tunnel';
  const declared = bridge || tunnel || (!flag(properties.bridge) && !flag(properties.tunnel) && !properties.brunnel);
  const layered = schema !== GEO_MAP_SCHEMA.SHORTBREAD && (properties.layer !== undefined || properties.level !== undefined);
  let level;
  if (layered) {
    const raw = Number(properties.layer ?? properties.level);
    level = Number.isFinite(raw) ? Math.max(GEO_TRANSPORT_LEVEL.MIN, Math.min(GEO_TRANSPORT_LEVEL.MAX, Math.round(raw))) : 0;
    if (bridge && level <= 0) level = 1;
    if (tunnel && level >= 0) level = -1;
  } else if (bridge) level = GEO_TRANSPORT_LEVEL.BRIDGE;
  else if (tunnel) level = GEO_TRANSPORT_LEVEL.TUNNEL;
  else level = GEO_TRANSPORT_LEVEL.GROUND;

  const resolved = resolveTransportLevel({ ...properties, layer: level });
  return Object.freeze({ ...resolved, schema, declared, ford: text(properties.brunnel) === 'ford' });
}

/**
 * Canonical road record: class, transport level, and the width/colour family the
 * geometry code needs. This is the only place a provider class is interpreted.
 */
export function describeMapTransport(properties = {}, schema = GEO_MAP_SCHEMA.UNKNOWN) {
  const road = resolveRoadClass(properties, schema);
  const level = resolveMapTransportLevel(properties, schema);
  const subtype = road.subclass || (road.rail && road.roadClass !== GEO_ROAD_CLASS.RAIL ? road.subclass : '');
  return Object.freeze({
    schema: road.schema, roadClass: road.roadClass, subclass: road.subclass, subtype,
    rail: road.rail, link: road.link, construction: road.construction, oneway: road.oneway, surface: road.surface,
    kind: level.kind, sourceLevel: level.sourceLevel, physicalLevel: level.physicalLevel, surfaceY: level.surfaceY,
    bridge: level.kind === GEO_TRANSPORT_KIND.BRIDGE, tunnel: level.kind === GEO_TRANSPORT_KIND.TUNNEL,
    ford: level.ford, levelDeclared: level.declared,
  });
}

export const GEO_BUILDING_LEVEL = Object.freeze({
  HAS_HEIGHT_FIELD: 'height-field',
  HAS_MIN_HEIGHT_FIELD: 'min-height-field',
  STYLIZED: 'stylized',
});

/**
 * Canonical building heights. OpenMapTiles publishes `render_height` and
 * `render_min_height`; Shortbread 1.0's `buildings` layer carries only a `dummy`
 * marker, so its height is stylized from the footprint hash — documented, and
 * deterministic for a given tile and footprint.
 */
export function describeMapBuilding(properties = {}, schema = GEO_MAP_SCHEMA.UNKNOWN, { footprintArea = 1, hash = 0 } = {}) {
  const explicit = Number(properties.render_height ?? properties.height);
  const explicitMin = Number(properties.render_min_height ?? properties.min_height);
  const hasHeight = Number.isFinite(explicit) && explicit > 0;
  const hasMinHeight = Number.isFinite(explicitMin) && explicitMin > 0;
  const hidden = flag(properties.hide_3d) || text(properties['building:part']) === 'no';
  const stylized = !hasHeight;
  // Shortbread 1.0 `buildings` is a flat marker layer; a height there can only be
  // stylized, so the source of the number is recorded with the number.
  const metres = stylized
    ? 5 + Math.min(12, Math.sqrt(Math.max(footprintArea, .01)) * 2.2) + (hash % 18)
    : explicit;
  return Object.freeze({
    schema,
    source: hasHeight ? GEO_BUILDING_LEVEL.HAS_HEIGHT_FIELD : GEO_BUILDING_LEVEL.STYLIZED,
    heightMetres: metres,
    minHeightMetres: hasMinHeight ? explicitMin : 0,
    hasHeightField: hasHeight,
    hasMinHeightField: hasMinHeight,
    hidden,
  });
}

/** Canonical land cover classes, aligned with the renderer's colour table. */
export const GEO_LAND_COVER = Object.freeze({
  WOOD: 'wood',
  FOREST: 'forest',
  GRASS: 'grass',
  GRASSLAND: 'grassland',
  MEADOW: 'meadow',
  FARMLAND: 'farmland',
  ORCHARD: 'orchard',
  SCRUB: 'scrub',
  HEATH: 'heath',
  PARK: 'park',
  GARDEN: 'garden',
  SAND: 'sand',
  BEACH: 'beach',
  ICE: 'ice',
  ROCK: 'rock',
  WETLAND: 'wetland',
  RESIDENTIAL: 'residential',
  COMMERCIAL: 'commercial',
  INDUSTRIAL: 'industrial',
  CEMETERY: 'cemetery',
  ISLAND: 'island',
  UNKNOWN: 'default',
});

const LAND_COVER_ALIASES = Object.freeze({
  // OpenMapTiles landcover.class / landuse.class
  farmland: GEO_LAND_COVER.FARMLAND,
  ice: GEO_LAND_COVER.ICE,
  glacier: GEO_LAND_COVER.ICE,
  wood: GEO_LAND_COVER.WOOD,
  rock: GEO_LAND_COVER.ROCK,
  bare_rock: GEO_LAND_COVER.ROCK,
  scree: GEO_LAND_COVER.ROCK,
  grass: GEO_LAND_COVER.GRASS,
  wetland: GEO_LAND_COVER.WETLAND,
  sand: GEO_LAND_COVER.SAND,
  // Shortbread land.kind / sites.kind
  forest: GEO_LAND_COVER.FOREST,
  meadow: GEO_LAND_COVER.MEADOW,
  grassland: GEO_LAND_COVER.GRASSLAND,
  orchard: GEO_LAND_COVER.ORCHARD,
  vineyard: GEO_LAND_COVER.ORCHARD,
  allotments: GEO_LAND_COVER.FARMLAND,
  plant_nursery: GEO_LAND_COVER.FARMLAND,
  greenhouse_horticulture: GEO_LAND_COVER.FARMLAND,
  cemetery: GEO_LAND_COVER.CEMETERY,
  grave_yard: GEO_LAND_COVER.CEMETERY,
  village_green: GEO_LAND_COVER.GRASS,
  recreation_ground: GEO_LAND_COVER.GRASS,
  heath: GEO_LAND_COVER.HEATH,
  scrub: GEO_LAND_COVER.SCRUB,
  shingle: GEO_LAND_COVER.BEACH,
  swamp: GEO_LAND_COVER.WETLAND,
  bog: GEO_LAND_COVER.WETLAND,
  string_bog: GEO_LAND_COVER.WETLAND,
  wet_meadow: GEO_LAND_COVER.WETLAND,
  marsh: GEO_LAND_COVER.WETLAND,
  saltmarsh: GEO_LAND_COVER.WETLAND,
  reedbed: GEO_LAND_COVER.WETLAND,
  tidalflat: GEO_LAND_COVER.WETLAND,
  mangrove: GEO_LAND_COVER.WETLAND,
  golf_course: GEO_LAND_COVER.GRASS,
  park: GEO_LAND_COVER.PARK,
  garden: GEO_LAND_COVER.GARDEN,
  playground: GEO_LAND_COVER.GRASS,
  miniature_golf: GEO_LAND_COVER.GRASS,
  residential: GEO_LAND_COVER.RESIDENTIAL,
  industrial: GEO_LAND_COVER.INDUSTRIAL,
  commercial: GEO_LAND_COVER.COMMERCIAL,
  garages: GEO_LAND_COVER.INDUSTRIAL,
  retail: GEO_LAND_COVER.COMMERCIAL,
  railway: GEO_LAND_COVER.INDUSTRIAL,
  landfill: GEO_LAND_COVER.INDUSTRIAL,
  quarry: GEO_LAND_COVER.ROCK,
  brownfield: GEO_LAND_COVER.INDUSTRIAL,
  greenfield: GEO_LAND_COVER.GRASS,
  farmyard: GEO_LAND_COVER.FARMLAND,
  farm: GEO_LAND_COVER.FARMLAND,
  military: GEO_LAND_COVER.INDUSTRIAL,
  danger_area: GEO_LAND_COVER.INDUSTRIAL,
  school: GEO_LAND_COVER.COMMERCIAL,
  university: GEO_LAND_COVER.COMMERCIAL,
  college: GEO_LAND_COVER.COMMERCIAL,
  hospital: GEO_LAND_COVER.COMMERCIAL,
  prison: GEO_LAND_COVER.COMMERCIAL,
  parking: GEO_LAND_COVER.INDUSTRIAL,
  bicycle_parking: GEO_LAND_COVER.INDUSTRIAL,
  construction: GEO_LAND_COVER.INDUSTRIAL,
  sports_centre: GEO_LAND_COVER.GRASS,
  island: GEO_LAND_COVER.ISLAND,
});

/**
 * Canonical land cover class. A value the renderer already knows is passed
 * through untouched, so provider-neutral tiles keep their existing colours and
 * only provider-specific spellings are rewritten.
 */
export function resolveLandCoverClass(properties = {}, fallback = GEO_LAND_COVER.UNKNOWN) {
  if (typeof properties === 'string') {
    const value = text(properties);
    if (!value) return fallback;
    return LAND_COVER_ALIASES[value] ?? value;
  }
  const candidates = [properties.class, properties.kind, properties.subclass, properties.landuse, properties.natural, properties.leisure, properties.type];
  for (const candidate of candidates) {
    const value = text(candidate);
    if (!value) continue;
    return LAND_COVER_ALIASES[value] ?? value;
  }
  return fallback;
}

/** Canonical place classes used for label priority and screen size. */
export const GEO_PLACE_CLASS = Object.freeze({
  CAPITAL: 'capital',
  CITY: 'city',
  TOWN: 'town',
  VILLAGE: 'village',
  SUBURB: 'suburb',
  NEIGHBOURHOOD: 'neighbourhood',
  ISOLATED: 'isolated',
  OTHER: 'other',
});

const PLACE_CLASSES = Object.freeze({
  country: GEO_PLACE_CLASS.CITY,
  state: GEO_PLACE_CLASS.CITY,
  province: GEO_PLACE_CLASS.CITY,
  capital: GEO_PLACE_CLASS.CAPITAL,
  state_capital: GEO_PLACE_CLASS.CAPITAL,
  city: GEO_PLACE_CLASS.CITY,
  town: GEO_PLACE_CLASS.TOWN,
  village: GEO_PLACE_CLASS.VILLAGE,
  hamlet: GEO_PLACE_CLASS.VILLAGE,
  suburb: GEO_PLACE_CLASS.SUBURB,
  quarter: GEO_PLACE_CLASS.SUBURB,
  neighbourhood: GEO_PLACE_CLASS.NEIGHBOURHOOD,
  isolated_dwelling: GEO_PLACE_CLASS.ISOLATED,
  farm: GEO_PLACE_CLASS.ISOLATED,
  locality: GEO_PLACE_CLASS.OTHER,
  island: GEO_PLACE_CLASS.OTHER,
});

/** Shortbread publishes `population` where OpenMapTiles publishes `rank`. */
const POPULATION_RANKS = Object.freeze([
  [100000, 1], [50000, 2], [10000, 3], [5000, 4], [1000, 5], [500, 6], [100, 7], [50, 8],
]);

export function describeMapPlace(properties = {}, schema = GEO_MAP_SCHEMA.UNKNOWN) {
  const declared = text(properties.class || properties.kind || properties.subclass || properties.place || properties.type);
  const placeClass = PLACE_CLASSES[declared] ?? GEO_PLACE_CLASS.OTHER;
  let rank = Number(properties.rank ?? properties.labelrank ?? properties.label_rank);
  if (!Number.isFinite(rank)) {
    const population = Number(properties.population);
    rank = Number.isFinite(population)
      ? (POPULATION_RANKS.find(([threshold]) => population >= threshold)?.[1] ?? 8)
      : 0;
  }
  return Object.freeze({ schema, placeClass, declared, rank: Math.max(0, Math.round(rank)) });
}

/**
 * One entry point for the builder and context readers: give it a layer name (or
 * a resolved role) and raw properties, and it returns the canonical record for
 * that role. Unknown roles return null so a caller never fabricates semantics.
 */
export function describeMapFeature(properties = {}, { layer = '', schema = GEO_MAP_SCHEMA.UNKNOWN, footprintArea = 1, hash = 0 } = {}) {
  const role = mapLayerRole(layer);
  if (role === GEO_MAP_ROLE.TRANSPORT) return Object.freeze({ role, transport: describeMapTransport(properties, schema) });
  if (role === GEO_MAP_ROLE.BUILDING) return Object.freeze({ role, building: describeMapBuilding(properties, schema, { footprintArea, hash }) });
  if (role === GEO_MAP_ROLE.LAND) return Object.freeze({ role, landCover: resolveLandCoverClass(properties) });
  if (role === GEO_MAP_ROLE.PLACE) return Object.freeze({ role, place: describeMapPlace(properties, schema) });
  return null;
}

/** Bounded diagnostics for one compiled tile: what the adapter actually saw. */
export function createSchemaDiagnostics(schema = GEO_MAP_SCHEMA.UNKNOWN) {
  const roadClasses = new Map(), levels = new Map(), buildingSources = new Map(), landCovers = new Map(), places = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  return {
    schema,
    record(record) {
      if (!record) return;
      if (record.transport) {
        bump(roadClasses, record.transport.roadClass);
        bump(levels, record.transport.kind);
      } else if (record.building) bump(buildingSources, record.building.source);
      else if (record.landCover) bump(landCovers, record.landCover);
      else if (record.place) bump(places, record.place.placeClass);
    },
    diagnostics() {
      return Object.freeze({
        schema,
        roadClasses: Object.freeze(Object.fromEntries([...roadClasses].sort(([a], [b]) => (a < b ? -1 : 1)))),
        levels: Object.freeze(Object.fromEntries([...levels].sort(([a], [b]) => (a < b ? -1 : 1)))),
        buildingSources: Object.freeze(Object.fromEntries([...buildingSources].sort(([a], [b]) => (a < b ? -1 : 1)))),
        landCovers: Object.freeze(Object.fromEntries([...landCovers].sort(([a], [b]) => (a < b ? -1 : 1)))),
        places: Object.freeze(Object.fromEntries([...places].sort(([a], [b]) => (a < b ? -1 : 1)))),
        providerNeutral: true,
      });
    },
  };
}

/**
 * Shortbread `water_polygons.kind` spells an inland lake `water` and a dock
 * `dock`; OpenMapTiles spells the same bodies `lake` and the waterway classes.
 * `TER-08`'s classifier deliberately refuses to guess from a bare `water`, so the
 * schema-aware alias lives here, at the boundary that knows which provider
 * served the payload. Waterways keep their finer `subclass`/`waterway` class,
 * because the classifier runs first and only an unknown result is aliased.
 */
const SHORTBREAD_WATER_ALIASES = Object.freeze({
  water: GEO_WATER_CLASS.LAKE,
  basin: GEO_WATER_CLASS.LAKE,
  reservoir: GEO_WATER_CLASS.LAKE,
  dock: GEO_WATER_CLASS.CANAL,
});

export function resolveMapWaterClass(properties = {}, schema = GEO_MAP_SCHEMA.UNKNOWN) {
  const direct = classifyWaterClass(properties);
  if (direct !== GEO_WATER_CLASS.UNKNOWN) return direct;
  const declared = text(typeof properties === 'string' ? properties : properties.class ?? properties.kind ?? properties.type);
  const aliased = declared ? SHORTBREAD_WATER_ALIASES[declared] : undefined;
  // A bare `water`/`dock` kind is unambiguous wherever it appears, and any other
  // unknown spelling stays unknown instead of being guessed into a class.
  return aliased ?? GEO_WATER_CLASS.UNKNOWN;
}

/** Canonical class *name* for the water-domain records the context hands down. */
export function resolveMapWaterKind(properties = {}, schema = GEO_MAP_SCHEMA.UNKNOWN) {
  return waterClassName(resolveMapWaterClass(properties, schema));
}

export { transportSurfaceY };
