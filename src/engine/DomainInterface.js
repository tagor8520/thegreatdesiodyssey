/**
 * `FND-08` curated/coordinate domain interface.
 *
 * The adventure and the coordinate explorer are deliberately different worlds:
 * one is a 256 × 256 voxel island at 1 world unit per metre, the other streams
 * Web Mercator tiles at 0.1 units per metre with exact mapped footprints. They
 * must nevertheless be *consumable by the same code*: one support query, one
 * sweep query, one player control surface, one debug/diagnostic summary.
 *
 * This module defines that shared language. A domain is a **descriptor**
 * (identity, scale, bounds/streaming, declared capabilities) plus a validated
 * **implementation** (the members the host object must provide). Validation is
 * real: declared capabilities are checked against the live object and probes are
 * run against real query functions, so a half-implemented world fails with a
 * named violation instead of failing much later inside a frame.
 *
 * Nothing here imposes a visual scale. `unitsPerMetre` is data: 1 for the
 * curated island, 0.1 for the coordinate world, and consumers convert through
 * `worldUnits()`/`metres()` rather than assuming either.
 *
 * No `three` and no DOM import.
 */

export const GDO_DOMAIN_NAMESPACE = 'gdo:domainInterface:v1';

/** The descriptor ids the runtime currently declares; shared consumers key off these. */
export const GDO_KNOWN_DOMAINS = Object.freeze(['curated', 'coordinate']);

export const GDO_DOMAIN_KIND = Object.freeze({ WORLD: 'world', PLAYER: 'player' });

/** Members every world domain must implement, whatever its scale. */
export const GDO_WORLD_MEMBERS = Object.freeze([
  'unitsPerMetreScale',
  'update',
  'dispose',
  'querySupport',
  'querySnapshot',
]);

/** Members every player domain must implement. */
export const GDO_PLAYER_MEMBERS = Object.freeze([
  'update',
  'dispose',
  'setMoveInput',
  'setPosition',
]);

/** Capability keys a world may declare; each one must be honoured by a member. */
export const GDO_WORLD_CAPABILITIES = Object.freeze([
  'coordinates',      // x/z map to a real latitude/longitude
  'terrainSupport',   // querySupport returns a real ground height
  'dynamicSweep',     // querySweep moves a sphere through dynamic blockers
  'labels',           // visibleLabels exposes map/place labels
  'interaction',      // an interaction/action registry is mounted
  'navigation',       // local guidance is derived from mapped roads and places
  'pedestrians',      // bounded local residents walk mapped streets, never block the player
  'verticalGrades',   // bridges and tunnels occupy distinct physical levels
  'streamed',         // residency is a bounded sliding window, not a fixed island
]);

/** Camera modes the shared player contract understands. */
export const GDO_CAMERA_MODES = Object.freeze(['first-person', 'third-person', 'map']);

function isFunction(value) { return typeof value === 'function'; }

function finiteNumber(value) { return typeof value === 'number' && Number.isFinite(value); }

function normaliseCapabilities(capabilities = {}) {
  const output = {};
  for (const key of GDO_WORLD_CAPABILITIES) output[key] = capabilities[key] === true;
  for (const key of Object.keys(capabilities)) {
    if (!GDO_WORLD_CAPABILITIES.includes(key)) {
      throw new RangeError(`Unknown world-domain capability "${key}" (expected one of ${GDO_WORLD_CAPABILITIES.join(', ')})`);
    }
  }
  return Object.freeze(output);
}

/**
 * Declares one world. `id` is stable and used by caches/diagnostics, so a
 * second domain with the same id but a different shape is a programming error.
 */
export function defineWorldDomain({
  id,
  label = id,
  unitsPerMetre,
  bounds = null,
  streaming = null,
  capabilities = {},
  supports = Object.freeze({}),
} = {}) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('World domain needs a stable string id');
  if (!finiteNumber(unitsPerMetre) || unitsPerMetre <= 0) {
    throw new RangeError(`World domain "${id}" needs a positive finite unitsPerMetre`);
  }
  let finiteBounds = null;
  if (bounds != null) {
    const { minX, maxX, minZ, maxZ } = bounds;
    if (![minX, maxX, minZ, maxZ].every(finiteNumber) || !(maxX > minX) || !(maxZ > minZ)) {
      throw new RangeError(`World domain "${id}" needs ordered finite bounds`);
    }
    finiteBounds = Object.freeze({ minX, maxX, minZ, maxZ });
  }
  const caps = normaliseCapabilities(capabilities);
  if (!bounds && !caps.streamed) {
    throw new RangeError(`World domain "${id}" must declare finite bounds or the streamed capability`);
  }
  let residency = null;
  if (streaming != null) {
    const { chunkSize, residentLimit } = streaming;
    if (!finiteNumber(chunkSize) || chunkSize <= 0) {
      throw new RangeError(`World domain "${id}" needs a positive chunkSize`);
    }
    if (!Number.isInteger(residentLimit) || residentLimit < 1) {
      throw new RangeError(`World domain "${id}" needs a resident limit of at least one`);
    }
    residency = Object.freeze({ chunkSize, residentLimit });
  }
  return Object.freeze({
    namespace: GDO_DOMAIN_NAMESPACE,
    kind: GDO_DOMAIN_KIND.WORLD,
    id: String(id),
    label: String(label),
    unitsPerMetre,
    bounds: finiteBounds,
    streaming: residency,
    capabilities: caps,
    supports,
    /** Shared conversion helpers: consumers never assume a visual scale. */
    worldUnits(metres) { return metres * unitsPerMetre; },
    metres(worldUnits) { return worldUnits / unitsPerMetre; },
  });
}

/** Declares one player control surface. Capabilities are checked, not decorative. */
export function definePlayerDomain({
  id,
  label = id,
  worldId,
  cameraModes,
  capabilities = {},
} = {}) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('Player domain needs a stable string id');
  if (!Array.isArray(cameraModes) || !cameraModes.length ||
      cameraModes.some(mode => !GDO_CAMERA_MODES.includes(mode))) {
    throw new RangeError(`Player domain "${id}" needs at least one known camera mode`);
  }
  const caps = Object.freeze({
    analogInput: capabilities.analogInput === true,
    jump: capabilities.jump === true,
    pointerLook: capabilities.pointerLook === true,
    touch: capabilities.touch === true,
  });
  return Object.freeze({
    namespace: GDO_DOMAIN_NAMESPACE,
    kind: GDO_DOMAIN_KIND.PLAYER,
    id: String(id),
    label: String(label),
    worldId: worldId == null ? null : String(worldId),
    cameraModes: Object.freeze([...cameraModes]),
    capabilities: caps,
  });
}

function probeSupport(implementation, points) {
  const samples = [];
  for (const point of points) {
    const out = {};
    const value = implementation.querySupport(point.x, point.z, out);
    const y = finiteNumber(value?.y) ? value.y : (finiteNumber(out.y) ? out.y : value);
    samples.push({ x: point.x, z: point.z, y: finiteNumber(y) ? y : Number.NaN });
  }
  return samples;
}

/**
 * Validates a live implementation against its descriptor. Returns every
 * violation it finds with the member, the reason, and (for probes) the sample.
 */
export function describeDomainCompliance(implementation, descriptor) {
  const violations = [];
  if (!implementation || typeof implementation !== 'object') {
    return { ok: false, namespace: GDO_DOMAIN_NAMESPACE, id: descriptor?.id ?? null, kind: descriptor?.kind ?? null, violations: [{ member: 'implementation', reason: 'missing' }] };
  }
  if (!descriptor) {
    return { ok: false, namespace: GDO_DOMAIN_NAMESPACE, id: null, kind: null, violations: [{ member: 'descriptor', reason: 'missing' }] };
  }
  const record = implementation.domain ?? implementation.playerDomain ?? null;
  if (record !== descriptor) {
    violations.push({ member: 'domain', reason: 'implementation does not expose the descriptor it claims to satisfy' });
  }
  const required = descriptor.kind === GDO_DOMAIN_KIND.PLAYER ? GDO_PLAYER_MEMBERS : GDO_WORLD_MEMBERS;
  for (const member of required) {
    if (member === 'unitsPerMetreScale') {
      const scale = implementation.unitsPerMetreScale ?? implementation.domain?.unitsPerMetre;
      if (!finiteNumber(scale) || scale <= 0) violations.push({ member, reason: 'not a positive finite scale' });
      continue;
    }
    if (!isFunction(implementation[member])) violations.push({ member, reason: 'not a function' });
  }

  if (descriptor.kind === GDO_DOMAIN_KIND.WORLD) {
    const caps = descriptor.capabilities;
    if (caps.terrainSupport) {
      if (!isFunction(implementation.querySupport)) {
        violations.push({ member: 'querySupport', reason: 'capability terrainSupport declared without a query' });
      } else {
        const bounds = descriptor.bounds;
        const points = bounds
          ? [{ x: bounds.minX + 1, z: bounds.minZ + 1 }, { x: 0, z: 0 }, { x: bounds.maxX - 1, z: bounds.maxZ - 1 }]
          : [{ x: 0, z: 0 }];
        for (const sample of probeSupport(implementation, points)) {
          if (!Number.isFinite(sample.y)) {
            violations.push({ member: 'querySupport', reason: `non-finite support probe at ${sample.x},${sample.z}` });
          } else if (bounds && (sample.y < -4096 || sample.y > 4096)) {
            violations.push({ member: 'querySupport', reason: `support probe outside any plausible unit range at ${sample.x},${sample.z}` });
          }
        }
      }
    }
    if (caps.dynamicSweep && !isFunction(implementation.querySweep)) {
      violations.push({ member: 'querySweep', reason: 'capability dynamicSweep declared without a sweep query' });
    }
    if (caps.labels && !implementation.visibleLabels) {
      violations.push({ member: 'visibleLabels', reason: 'capability labels declared without a label source' });
    }
    if (caps.streamed && !descriptor.streaming) {
      violations.push({ member: 'streaming', reason: 'streamed capability declared without resident limits' });
    }
    if (caps.navigation && !isFunction(implementation.navigationGuidance)) {
      violations.push({ member: 'navigationGuidance', reason: 'capability navigation declared without a guidance query' });
    }
    if (caps.pedestrians && (!implementation.pedestrians || !isFunction(implementation.pedestrianSample))) {
      violations.push({ member: 'pedestrianSample', reason: 'capability pedestrians declared without a resident pedestrian board' });
    }
    if (caps.coordinates && !isFunction(implementation.coordinateAt)) {
      violations.push({ member: 'coordinateAt', reason: 'capability coordinates declared without a coordinate conversion' });
    }
    if (descriptor.bounds && !implementation.bounds && !implementation.domainBounds) {
      violations.push({ member: 'bounds', reason: 'finite bounds declared but the implementation exposes none' });
    }
  } else {
    const position = implementation.position;
    if (!position || !finiteNumber(position.x) || !finiteNumber(position.z)) {
      violations.push({ member: 'position', reason: 'player position is not finite x/z' });
    }
    if (!('enabled' in implementation)) violations.push({ member: 'enabled', reason: 'missing player enable flag' });
    if (descriptor.cameraModes.length > 1 && !isFunction(implementation.toggleCameraMode)) {
      violations.push({ member: 'toggleCameraMode', reason: 'multiple camera modes declared without a toggle' });
    }
    const mode = implementation.cameraMode ?? 'third-person';
    if (!descriptor.cameraModes.includes(mode)) {
      violations.push({ member: 'cameraMode', reason: `active mode "${mode}" is not declared by the domain` });
    }
  }
  return {
    namespace: GDO_DOMAIN_NAMESPACE,
    id: descriptor.id,
    kind: descriptor.kind,
    ok: violations.length === 0,
    violations,
    detail: violations.length
      ? `${descriptor.id}: ${violations.map(item => `${item.member} ${item.reason}`).join('; ')}`
      : `${descriptor.id}: ${required.length} required members and ${Object.values(descriptor.capabilities ?? {}).filter(Boolean).length} capabilities satisfied`,
  };
}

export function assertDomainCompliance(implementation, descriptor) {
  const report = describeDomainCompliance(implementation, descriptor);
  if (!report.ok) throw new Error(`Domain compliance failed — ${report.detail}`);
  return report;
}

/**
 * One query surface for both worlds. Callers pass metres-of-interest in world
 * units and get a normalised record back, so label/HUD/audit code never branches
 * on which world it is talking to.
 */
export function createSupportQuery(implementation, descriptor) {
  if (!implementation || !isFunction(implementation.querySupport)) {
    throw new TypeError('createSupportQuery needs a world exposing querySupport');
  }
  const scale = descriptor?.unitsPerMetre ?? implementation.unitsPerMetreScale ?? 1;
  return Object.freeze({
    namespace: GDO_DOMAIN_NAMESPACE,
    domainId: descriptor?.id ?? 'unknown',
    unitsPerMetre: scale,
    /** Ground/support height in world units at a world x/z. */
    support(x, z, out = {}) {
      const value = implementation.querySupport(x, z, out) ?? out;
      const y = finiteNumber(value?.y) ? value.y : null;
      return Object.freeze({
        x, z, y,
        kind: value?.kind ?? 'ground',
        slopeRadians: finiteNumber(value?.slopeRadians) ? value.slopeRadians : 0,
        metresAboveSupport: finiteNumber(value?.metresAboveSupport) ? value.metresAboveSupport : 0,
      });
    },
    /** Deterministic sample grid used by diagnostics and audits. */
    sample(points) {
      return points.map(({ x, z }) => this.support(x, z));
    },
  });
}

/** Compact one-line summary shared by logs, the debug hook, and the HUD. */
export function describeDomain(descriptor, implementation = null) {
  if (!descriptor) return 'no domain';
  const capabilities = Object.entries(descriptor.capabilities ?? {})
    .filter(([, value]) => value).map(([key]) => key);
  const streaming = descriptor.streaming ? ` streamed/${descriptor.streaming.residentLimit}` : ' fixed';
  const scale = `${descriptor.unitsPerMetre} u/m`;
  const compliance = implementation ? (describeDomainCompliance(implementation, descriptor).ok ? ' compliant' : ' VIOLATIONS') : '';
  return `${descriptor.id} (${descriptor.kind}) ${scale}${streaming} [${capabilities.join(',') || 'none'}]${compliance}`;
}
