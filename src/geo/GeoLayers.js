import { GEO_BUILDING_QUERY_MASK, GEO_QUERY_MASK } from './GeoCollision.js';

export const GEO_GENERATION_STAGE = Object.freeze({
  GROUND: 0,
  ROADS: 10,
  CONTEXT: 20,
  BUILDINGS: 30,
  DETAILS: 40,
  AMBIENCE: 50,
});

export const GEO_TRANSPORT_KIND = Object.freeze({
  TUNNEL: 'tunnel',
  GROUND: 'ground',
  BRIDGE: 'bridge',
});

export const GEO_TRANSPORT_LEVEL = Object.freeze({
  MIN: -5,
  MAX: 5,
  TUNNEL: -1,
  GROUND: 0,
  BRIDGE: 1,
  // At the 1:10 world scale, one source level gives 3.6 real-world metres.
  STEP: 0.36,
});

export const GEO_SURFACE_Y = Object.freeze({
  GROUND: 0,
  LAND_BASE: 0.006,
  LAND_STEP: 0.002,
  WATER: 0.020,
  ROAD: 0.025,
  TUNNEL_ROAD: 0.025 - GEO_TRANSPORT_LEVEL.STEP,
  BRIDGE_DECK: 0.025 + GEO_TRANSPORT_LEVEL.STEP,
  JUNCTION_OFFSET: 0.001,
  CURB_OFFSET: -0.002,
  LANE_MARK_OFFSET: 0.007,
  CROSSING_OFFSET: 0.009,
});

function sourceTransportLevel(properties) {
  for (const key of ['layer', 'level']) {
    const raw = properties?.[key];
    if (raw === '' || raw === null || raw === undefined || typeof raw === 'boolean') continue;
    const number = Number(raw);
    if (Number.isFinite(number)) {
      return Math.max(GEO_TRANSPORT_LEVEL.MIN, Math.min(GEO_TRANSPORT_LEVEL.MAX, Math.round(number)));
    }
  }
  return GEO_TRANSPORT_LEVEL.GROUND;
}

function providerFlag(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'yes' || normalized === 'true' || normalized === '1';
}

/** Normalize OpenMapTiles/Shortbread transport elevation into one physical grade. */
export function resolveTransportLevel(properties = {}) {
  const sourceLevel = sourceTransportLevel(properties);
  const brunnel = String(properties.brunnel ?? '').trim().toLowerCase();
  const explicitBridge = brunnel === 'bridge' || providerFlag(properties.bridge);
  const explicitTunnel = brunnel === 'tunnel' || providerFlag(properties.tunnel);
  let kind;
  if (brunnel === 'bridge') kind = GEO_TRANSPORT_KIND.BRIDGE;
  else if (brunnel === 'tunnel') kind = GEO_TRANSPORT_KIND.TUNNEL;
  else if (explicitBridge && !explicitTunnel) kind = GEO_TRANSPORT_KIND.BRIDGE;
  else if (explicitTunnel && !explicitBridge) kind = GEO_TRANSPORT_KIND.TUNNEL;
  else if (sourceLevel < 0) kind = GEO_TRANSPORT_KIND.TUNNEL;
  else if (sourceLevel > 0) kind = GEO_TRANSPORT_KIND.BRIDGE;
  // Malformed direct bridge+tunnel flags use one documented stable tie-break.
  else if (explicitBridge) kind = GEO_TRANSPORT_KIND.BRIDGE;
  else kind = GEO_TRANSPORT_KIND.GROUND;

  const magnitude = Math.max(1, Math.abs(sourceLevel));
  const physicalLevel = kind === GEO_TRANSPORT_KIND.BRIDGE ? magnitude
    : kind === GEO_TRANSPORT_KIND.TUNNEL ? -magnitude
      : GEO_TRANSPORT_LEVEL.GROUND;
  return Object.freeze({ kind, sourceLevel, physicalLevel, surfaceY: transportSurfaceY(physicalLevel) });
}

export function transportSurfaceY(physicalLevel) {
  const level = Number.isFinite(physicalLevel)
    ? Math.max(GEO_TRANSPORT_LEVEL.MIN, Math.min(GEO_TRANSPORT_LEVEL.MAX, Math.round(physicalLevel)))
    : GEO_TRANSPORT_LEVEL.GROUND;
  return GEO_SURFACE_Y.ROAD + level * GEO_TRANSPORT_LEVEL.STEP;
}

export const GEO_RENDER_BAND = Object.freeze({
  OPAQUE_WORLD: 0,
  ALPHA_TESTED: 40,
  TRANSPARENT_WATER: 100,
  OVERLAY: 200,
});

export const GEO_DEPTH_POLICY = Object.freeze({
  OPAQUE: 'opaque-depth-write',
  ALPHA_TESTED: 'alpha-test-depth-write',
  WATER: 'transparent-depth-read',
  OVERLAY: 'overlay-explicit',
});

function descriptor(stage, surfaceY, renderBand, depthPolicy, queryMask) {
  return Object.freeze({ stage, surfaceY, renderBand, depthPolicy, queryMask });
}

/**
 * One semantic descriptor per generated role. A visual role may have no query
 * bits; this is intentional and prevents render bounds from becoming solids.
 */
export const GEO_LAYER = Object.freeze({
  ground: descriptor(
    GEO_GENERATION_STAGE.GROUND,
    GEO_SURFACE_Y.GROUND,
    GEO_RENDER_BAND.OPAQUE_WORLD,
    GEO_DEPTH_POLICY.OPAQUE,
    GEO_QUERY_MASK.SUPPORT | GEO_QUERY_MASK.PLACEMENT,
  ),
  land: descriptor(
    GEO_GENERATION_STAGE.CONTEXT,
    GEO_SURFACE_Y.LAND_BASE,
    GEO_RENDER_BAND.OPAQUE_WORLD,
    GEO_DEPTH_POLICY.OPAQUE,
    GEO_QUERY_MASK.SUPPORT | GEO_QUERY_MASK.PLACEMENT,
  ),
  water: descriptor(
    GEO_GENERATION_STAGE.CONTEXT,
    GEO_SURFACE_Y.WATER,
    GEO_RENDER_BAND.TRANSPARENT_WATER,
    GEO_DEPTH_POLICY.WATER,
    0,
  ),
  road: descriptor(
    GEO_GENERATION_STAGE.ROADS,
    GEO_SURFACE_Y.ROAD,
    GEO_RENDER_BAND.OPAQUE_WORLD,
    GEO_DEPTH_POLICY.OPAQUE,
    GEO_QUERY_MASK.SUPPORT | GEO_QUERY_MASK.PLACEMENT,
  ),
  bridgeDeck: descriptor(
    GEO_GENERATION_STAGE.ROADS,
    GEO_SURFACE_Y.BRIDGE_DECK,
    GEO_RENDER_BAND.OPAQUE_WORLD,
    GEO_DEPTH_POLICY.OPAQUE,
    GEO_QUERY_MASK.SUPPORT | GEO_QUERY_MASK.CAMERA_BLOCKER | GEO_QUERY_MASK.LOS_BLOCKER,
  ),
  tunnelRoad: descriptor(
    GEO_GENERATION_STAGE.ROADS,
    GEO_SURFACE_Y.TUNNEL_ROAD,
    GEO_RENDER_BAND.OPAQUE_WORLD,
    GEO_DEPTH_POLICY.OPAQUE,
    GEO_QUERY_MASK.SUPPORT,
  ),
  building: descriptor(
    GEO_GENERATION_STAGE.BUILDINGS,
    0,
    GEO_RENDER_BAND.OPAQUE_WORLD,
    GEO_DEPTH_POLICY.OPAQUE,
    GEO_BUILDING_QUERY_MASK,
  ),
  decoration: descriptor(
    GEO_GENERATION_STAGE.DETAILS,
    0,
    GEO_RENDER_BAND.OPAQUE_WORLD,
    GEO_DEPTH_POLICY.OPAQUE,
    0,
  ),
  ambience: descriptor(
    GEO_GENERATION_STAGE.AMBIENCE,
    0,
    GEO_RENDER_BAND.OPAQUE_WORLD,
    GEO_DEPTH_POLICY.OPAQUE,
    0,
  ),
});

export function landSurfaceY(sourceLayerIndex) {
  return GEO_SURFACE_Y.LAND_BASE + Math.max(0, sourceLayerIndex | 0) * GEO_SURFACE_Y.LAND_STEP;
}
