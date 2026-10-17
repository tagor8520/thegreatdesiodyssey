export const MAX_MERCATOR_LATITUDE = 85.05112878;
export const SOURCE_ZOOM = 14;
export const MAP_SCALE = 0.1;
export const EARTH_CIRCUMFERENCE_METRES = 40075016.68557849;

export function clampLatitude(latitude) {
  return Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
}

export function normalizeLongitude(longitude) {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

/** Return fractional XYZ-tile coordinates in Web Mercator. */
export function coordinateToTileFraction(latitude, longitude, zoom = SOURCE_ZOOM) {
  const lat = clampLatitude(Number(latitude));
  const lon = normalizeLongitude(Number(longitude));
  const count = 2 ** zoom;
  const radians = lat * Math.PI / 180;
  return {
    x: (lon + 180) / 360 * count,
    y: (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * count,
    zoom,
  };
}

export function tileFractionToCoordinate(x, y, zoom = SOURCE_ZOOM) {
  const count = 2 ** zoom;
  return {
    latitude: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / count))) * 180 / Math.PI,
    longitude: normalizeLongitude(x / count * 360 - 180),
  };
}

/**
 * Web Mercator tiles have constant projected width. Multiplying by cos(latitude)
 * gives a useful local ground-distance approximation. MAP_SCALE=0.1 is 1:10.
 */
export function tileSizeInGameUnits(latitude, zoom = SOURCE_ZOOM, mapScale = MAP_SCALE) {
  const groundMetres = EARTH_CIRCUMFERENCE_METRES * Math.cos(clampLatitude(latitude) * Math.PI / 180) / 2 ** zoom;
  return groundMetres * mapScale;
}

export function tileKey(x, y) {
  return `${x}:${y}`;
}

export function wrapTileX(x, zoom = SOURCE_ZOOM) {
  const count = 2 ** zoom;
  return ((x % count) + count) % count;
}

export function clampTileY(y, zoom = SOURCE_ZOOM) {
  return Math.max(0, Math.min(2 ** zoom - 1, y));
}

export function validateCoordinate(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new TypeError('Latitude and longitude must be numbers.');
  }
  if (lat < -MAX_MERCATOR_LATITUDE || lat > MAX_MERCATOR_LATITUDE) {
    throw new RangeError(`Latitude must be between -${MAX_MERCATOR_LATITUDE} and ${MAX_MERCATOR_LATITUDE}.`);
  }
  if (lon < -180 || lon > 180) throw new RangeError('Longitude must be between -180 and 180.');
  return { latitude: lat, longitude: lon };
}

export function createGeoReference(latitude, longitude, zoom = SOURCE_ZOOM) {
  const coordinate = validateCoordinate(latitude, longitude);
  const origin = coordinateToTileFraction(coordinate.latitude, coordinate.longitude, zoom);
  return Object.freeze({
    ...coordinate,
    zoom,
    originX: origin.x,
    originY: origin.y,
    tileSize: tileSizeInGameUnits(coordinate.latitude, zoom),
  });
}

export function worldToCoordinate(reference, worldX, worldZ) {
  return tileFractionToCoordinate(
    reference.originX + worldX / reference.tileSize,
    reference.originY + worldZ / reference.tileSize,
    reference.zoom,
  );
}

export function worldToTile(reference, worldX, worldZ) {
  return {
    x: Math.floor(reference.originX + worldX / reference.tileSize),
    y: Math.floor(reference.originY + worldZ / reference.tileSize),
  };
}
