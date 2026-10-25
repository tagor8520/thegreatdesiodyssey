/**
 * Places the launcher offers (`gdo:locations:v1`).
 *
 * The game is not a walk through one city: it streams whatever coordinate it is
 * given from the public vector-tile providers. This catalogue is therefore a
 * *shortlist*, not a map boundary — every entry is a real, hand-picked standing
 * spot with published coordinates, grouped so the picker reads like a travel
 * card rather than a form. Typed coordinates remain the advanced path, and the
 * picker never silently changes one.
 *
 * Nothing is preselected and nothing auto-starts: `resolveLocation` answers by id,
 * `describePlace` validates a typed coordinate, and the launcher renders whatever
 * these functions return.
 */

import { validateCoordinate } from '../geo/GeoMath.js';

export const GDO_LOCATIONS_NAMESPACE = 'gdo:locations:v1';

/**
 * `at` is the place a player actually stands: a gate, a ghat, a palace courtyard
 * or a bazaar, not a city centroid — a centroid is usually inside a building.
 */
export const GDO_LOCATIONS = Object.freeze([
  Object.freeze({
    id: 'delhi-india-gate', name: 'India Gate', city: 'New Delhi', region: 'Delhi NCR',
    group: 'capital', latitude: 28.6129, longitude: 77.2295,
    blurb: 'The Rajpath axis, lawns, and the boulevard traffic around the arch.',
  }),
  Object.freeze({
    id: 'delhi-connaught', name: 'Connaught Place', city: 'New Delhi', region: 'Delhi NCR',
    group: 'capital', latitude: 28.6315, longitude: 77.2167,
    blurb: 'Two concentric colonnaded blocks; the densest street grid in the country.',
  }),
  Object.freeze({
    id: 'mumbai-gateway', name: 'Gateway of India', city: 'Mumbai', region: 'Maharashtra',
    group: 'coast', latitude: 18.9220, longitude: 72.8347,
    blurb: 'Harbour water, the old fort walls, and the Colaba waterfront.',
  }),
  Object.freeze({
    id: 'mumbai-marine-drive', name: 'Marine Drive', city: 'Mumbai', region: 'Maharashtra',
    group: 'coast', latitude: 18.9433, longitude: 72.8232,
    blurb: 'The sea wall curve, back-to-back apartment towers, evening traffic.',
  }),
  Object.freeze({
    id: 'bengaluru-mg-road', name: 'MG Road', city: 'Bengaluru', region: 'Karnataka',
    group: 'metro', latitude: 12.9756, longitude: 77.6068,
    blurb: 'The metro viaduct overhead, glass offices, and the old parade ground.',
  }),
  Object.freeze({
    id: 'mysuru-palace', name: 'Mysore Palace', city: 'Mysuru', region: 'Karnataka',
    group: 'heritage', latitude: 12.3052, longitude: 76.6552,
    blurb: 'The palace compound, its gates, and the wide roads around it.',
  }),
  Object.freeze({
    id: 'chennai-marina', name: 'Marina Beach', city: 'Chennai', region: 'Tamil Nadu',
    group: 'coast', latitude: 13.0500, longitude: 80.2824,
    blurb: 'One long promenade, the Bay of Bengal, and the lighthouse end.',
  }),
  Object.freeze({
    id: 'madurai-temple', name: 'Meenakshi Temple', city: 'Madurai', region: 'Tamil Nadu',
    group: 'heritage', latitude: 9.9195, longitude: 78.1193,
    blurb: 'Four gopuram streets meeting in the temple square.',
  }),
  Object.freeze({
    id: 'amritsar-golden-temple', name: 'Golden Temple', city: 'Amritsar', region: 'Punjab',
    group: 'heritage', latitude: 31.6200, longitude: 74.8765,
    blurb: 'The sarovar, the causeway, and the old-city lanes around it.',
  }),
  Object.freeze({
    id: 'jaipur-hawa-mahal', name: 'Hawa Mahal', city: 'Jaipur', region: 'Rajasthan',
    group: 'heritage', latitude: 26.9239, longitude: 75.8267,
    blurb: 'The pink facade, the bazaar street, and the walled-city grid.',
  }),
  Object.freeze({
    id: 'varanasi-ghat', name: 'Dashashwamedh Ghat', city: 'Varanasi', region: 'Uttar Pradesh',
    group: 'heritage', latitude: 25.3109, longitude: 83.0107,
    blurb: 'Ghat steps onto the Ganga, with the old town stacked behind them.',
  }),
  Object.freeze({
    id: 'kolkata-victoria', name: 'Victoria Memorial', city: 'Kolkata', region: 'West Bengal',
    group: 'heritage', latitude: 22.5448, longitude: 88.3426,
    blurb: 'The Maidan, the memorial grounds, and the Hooghly to the west.',
  }),
  Object.freeze({
    id: 'hyderabad-charminar', name: 'Charminar', city: 'Hyderabad', region: 'Telangana',
    group: 'heritage', latitude: 17.3616, longitude: 78.4747,
    blurb: 'Four arches over the bazaar crossroads of the old city.',
  }),
  Object.freeze({
    id: 'kochi-fort', name: 'Fort Kochi', city: 'Kochi', region: 'Kerala',
    group: 'coast', latitude: 9.9658, longitude: 76.2421,
    blurb: 'Backwater waterfront, fishing nets, and narrow colonial streets.',
  }),
  Object.freeze({
    id: 'panaji-riverfront', name: 'Panaji Riverfront', city: 'Panaji', region: 'Goa',
    group: 'coast', latitude: 15.4989, longitude: 73.8278,
    blurb: 'The Mandovi bank, the ferry slips, and the Latin quarter behind.',
  }),
  Object.freeze({
    id: 'leh-bazaar', name: 'Leh Main Bazaar', city: 'Leh', region: 'Ladakh',
    group: 'highland', latitude: 34.1642, longitude: 77.5848,
    blurb: 'High thin air, the old town below the palace, and dry ridges.',
  }),
  Object.freeze({
    id: 'meerut-ghantaghar', name: 'Ghantaghar', city: 'Meerut', region: 'Uttar Pradesh',
    group: 'metro', latitude: 28.9845, longitude: 77.7064,
    blurb: 'The clock tower crossroads the engine was first tuned against.',
  }),
  Object.freeze({
    id: 'shimla-mall', name: 'The Mall', city: 'Shimla', region: 'Himachal Pradesh',
    group: 'highland', latitude: 31.1048, longitude: 77.1734,
    blurb: 'A ridge road with a steep drop on both sides and stair-streets below.',
  }),
]);

/** Declaration order is the picker's order; a consumer iterates this. */
export const GDO_LOCATION_IDS = Object.freeze(GDO_LOCATIONS.map(location => location.id));

/** The groups, in the order the picker shows them. */
export const GDO_LOCATION_GROUPS = Object.freeze([
  Object.freeze({ id: 'capital', label: 'The capital' }),
  Object.freeze({ id: 'metro', label: 'Metro centres' }),
  Object.freeze({ id: 'heritage', label: 'Heritage squares' }),
  Object.freeze({ id: 'coast', label: 'Coast and water' }),
  Object.freeze({ id: 'highland', label: 'Hills' }),
]);

const byId = new Map(GDO_LOCATIONS.map(location => [location.id, location]));

/** One catalogue entry by id, or `null`. Never a guess by name. */
export function resolveLocation(id) {
  if (typeof id !== 'string' || !id) return null;
  return byId.get(id) ?? null;
}

/** The entries of one group, in declaration order. */
export function locationsInGroup(groupId) {
  return GDO_LOCATIONS.filter(location => location.group === groupId);
}

/** `28.6129° N, 77.2295° E` — the notation the HUD uses for a live position. */
export function formatCoordinate(latitude, longitude, digits = 4) {
  const lat = Number(latitude), lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '—';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(digits)}° ${ns}, ${Math.abs(lon).toFixed(digits)}° ${ew}`;
}

/**
 * Turn anything a launch can name into the one shape the game mounts from.
 *
 * A catalogue id is resolved; a typed coordinate is validated by the same
 * `validateCoordinate` the world uses, so a coordinate that reaches `mountGeoGame`
 * has already passed the check that would otherwise throw there. A bad input is a
 * refusal with a reason, never a silent default to some other place.
 */
export function describePlace(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, refusal: 'bad-input' };
  }
  // An explicit kind wins; otherwise a string id is the strong name and a typed
  // coordinate is the fallback, so both `{kind:'location'}` and `{latitude}` work.
  const wantsLocation = input.kind === 'location' || (input.kind == null && typeof input.id === 'string');
  if (wantsLocation) {
    const location = resolveLocation(input.id);
    if (!location) return { ok: false, refusal: 'unknown-location', id: input.id ?? null };
    return {
      ok: true,
      kind: 'location',
      id: location.id,
      name: location.name,
      subtitle: `${location.city} · ${location.region}`,
      latitude: location.latitude,
      longitude: location.longitude,
    };
  }
  let coordinate;
  try {
    coordinate = validateCoordinate(input.latitude, input.longitude);
  } catch (error) {
    return { ok: false, refusal: 'bad-coordinate', message: error.message };
  }
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 60) : 'Dropped pin';
  return {
    ok: true,
    kind: 'coordinate',
    id: null,
    name,
    subtitle: formatCoordinate(coordinate.latitude, coordinate.longitude),
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
  };
}
