/**
 * Front-page copy (`gdo:siteContent:v1`).
 *
 * Every card below names something that actually ships, and says what it costs or
 * where it comes from — the landing page is a description of the build, not a
 * pitch. `GDO_WHATS_NEW` is a curated list, updated when a slice lands, because
 * fetching the changelog at runtime would make the front page depend on a file it
 * does not otherwise need.
 */

export const GDO_FEATURE_CARDS = Object.freeze([
  Object.freeze({
    id: 'map', title: 'Real map data', glyph: '🗺️',
    body: 'Streets, buildings, water, bridges, rail and land cover stream from free OpenStreetMap-based vector tiles as you walk. A bounded cache keeps what you have already seen.',
        foot: 'OpenFreeMap · OpenMapTiles · Shortbread',
  }),
  Object.freeze({
    id: 'weather', title: 'Weather that moves', glyph: '🌦️',
    body: 'Eight weather states on a deterministic day clock. Precipitation is one opaque, dithered draw per frame; the ground and the water read the same number the sky does.',
    foot: 'Rain · snow · dust · haze',
  }),
  Object.freeze({
    id: 'life', title: 'A living street', glyph: '🚶',
    body: 'Pedestrians walk the mapped sidewalks on their own routes, traffic follows mappable road classes, and none of them is ever a wall in your way.',
    foot: 'Bounded pools · zero collision',
  }),
  Object.freeze({
    id: 'navigation', title: 'Navigation that reads the map', glyph: '🧭',
    body: 'A local road graph is built from the tiles already resident: junctions, named places, turn-by-turn meters, and a minimap that owns no scene object.',
    foot: 'No routing server',
  }),
  Object.freeze({
    id: 'activities', title: 'Things to do', glyph: '🎯',
    body: 'A board of objectives is a deterministic function of the place and the day. One that the resident streets cannot ground is never shown.',
    foot: 'Eight templates · refusals by name',
  }),
  Object.freeze({
    id: 'physics', title: 'Small, honest physics', glyph: '🪨',
    body: 'Pushables on a fixed step, pose-fall knock-downs, breakable crates, ragdolls and boats — capped, deterministic, and frozen at the low profile where they should be.',
    foot: 'No rigid-body engine',
  }),
]);

/** The last few things that landed, newest first. Keep it short and true. */
export const GDO_WHATS_NEW = Object.freeze([
  Object.freeze({ id: 'map-10', tag: 'MAP-10a', title: 'Project tiles are a provider now', body: 'A PMTiles archive can serve a region over range requests, with a local header parser and directory reader. The decide-where-it-hosts record ships with it.' }),
  Object.freeze({ id: 'net-04', tag: 'NET-04', title: 'Other players visible, not simulated', body: 'Remote avatars interpolate 100 ms behind with a capped extrapolation and transfer no geometry at all.' }),
  Object.freeze({ id: 'phy-06', tag: 'PHY-06', title: 'Breakables and flags', body: 'Props break into a fixed pool of authored chunks; flags sample the shared wind field. Mapped buildings are refused by name, never fractured.' }),
  Object.freeze({ id: 'veg-10', tag: 'VEG-10', title: 'Branch groups on one clock', body: 'Four plant phase groups are offsets of a single wave, so a copse sways together instead of four independent animations.' }),
]);

/**
 * Attribution shown on the front page and in `Credits`. These are the licences the
 * streamed layers carry; the map-providers file is the runtime source of truth for
 * the tile URLs, and this list must not drift from it.
 */
export const GDO_DATA_ATTRIBUTION = Object.freeze([
  Object.freeze({ id: 'osm', label: '© OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright' }),
  Object.freeze({ id: 'openfreemap', label: 'Tiles by OpenFreeMap', href: 'https://openfreemap.org/' }),
  Object.freeze({ id: 'openmaptiles', label: 'OpenMapTiles schema', href: 'https://www.openmaptiles.org/' }),
  Object.freeze({ id: 'overture', label: 'Overture Maps (planned extracts)', href: 'https://overturemaps.org/' }),
  Object.freeze({ id: 'terrarium', label: 'Elevation: Terrarium tiles', href: 'https://registry.opendata.aws/terrain-tiles/' }),
]);

/** Where the project lives. `internal` links stay in the same tab. */
export const GDO_PROJECT_LINKS = Object.freeze([
  Object.freeze({ id: 'vision', label: 'Vision', href: '/vision.html', internal: true }),
  Object.freeze({ id: 'contribution', label: 'Contribute', href: '/contribution.html', internal: true }),
  Object.freeze({ id: 'tnc', label: 'Terms', href: '/tnc.html', internal: true }),
  Object.freeze({ id: 'repo', label: 'Source', href: 'https://github.com/tagor8520/thegreatdesiodyssey', internal: false }),
  Object.freeze({ id: 'pixellon', label: 'Pixellon', href: 'https://pixellon.in', internal: false }),
]);
