/**
 * A tiny in-memory domain used by tests (`FND-08`).
 *
 * Two existing tests hand-rolled a fake world that answered whatever the player
 * happened to ask for. When `FND-08` made the interface required rather than
 * optional those fakes stopped being worlds at all — which is the point: the
 * interface is now something a caller either implements or does not.
 *
 * This double implements it in full, and doubles as proof that the contract is
 * satisfiable by a third party in about forty lines without importing either
 * runtime. It is imported by `*.test.js` files only; no entry point reaches it,
 * so it is not part of the production bundle.
 */

const EMPTY = Object.freeze({});

export function createFlatDomain({
  name = 'flat-test',
  height = 0,
  footprintHalfExtent = .5,
  supportSampleSpacing = 1,
  sweepRadiusMin = .25,
  sweepRadiusMax = .5,
  /** @returns {boolean} true when a solid occupies this circle. */
  solidAt = () => false,
  /** Optional camera obstruction; defaults to an unobstructed segment. */
  clipCamera = null,
  /** Optional transition verdict: `(heightDelta, options) => boolean`. */
  acceptTransition = null,
  dispose = null,
} = {}) {
  const counters = {
    supportQueries: 0, collisionQueries: 0, motionQueries: 0,
    groundTransitions: 0, groundRejects: 0, cameraQueries: 0,
  };
  const domain = {
    name,
    scale: Object.freeze({ footprintHalfExtent, supportSampleSpacing, sweepRadiusMin, sweepRadiusMax }),
    supportAt(x, z, out = {}) {
      counters.supportQueries++;
      out.x = x; out.y = height; out.z = z;
      out.normalX = 0; out.normalY = 1; out.normalZ = 0;
      out.slopeRadians = 0; out.walkable = true; out.kind = 'flat';
      return out;
    },
    collidesCircle(x, z, radius) {
      counters.collisionQueries++;
      return solidAt(x, z, radius) === true;
    },
    moveCircle(x, z, dx, dz, radius, _skin = 0, _maxContacts = 1, out = {}, _maxDepenetration = 0) {
      counters.motionQueries++;
      let currentX = x, currentZ = z, hit = false, contacts = 0, normalX = 0, normalZ = 0;
      const attempt = (amount, axis) => {
        if (!amount) return;
        const nextX = axis === 'x' ? currentX + amount : currentX;
        const nextZ = axis === 'z' ? currentZ + amount : currentZ;
        if (solidAt(nextX, nextZ, radius) === true) {
          hit = true; contacts++;
          if (axis === 'x') normalX = amount > 0 ? -1 : 1; else normalZ = amount > 0 ? -1 : 1;
          return;
        }
        currentX = nextX; currentZ = nextZ;
      };
      attempt(dx, 'x');
      attempt(dz, 'z');
      return Object.assign(out, {
        x: currentX, z: currentZ, hit, contacts,
        depenetrated: false, depenetrationDistance: 0,
        normalX, normalZ, projectedX: dx, projectedZ: dz,
      });
    },
    resolveGroundStep(fromX, fromZ, toX, toZ, options = {}, out = {}) {
      counters.groundTransitions++;
      out.from = domain.supportAt(fromX, fromZ, out.from ?? {});
      out.to = domain.supportAt(toX, toZ, out.to ?? {});
      out.heightDelta = out.to.y - out.from.y;
      out.accepted = acceptTransition ? acceptTransition(out.heightDelta, options) === true : true;
      out.reason = out.accepted ? 'accepted' : 'step-up';
      if (!out.accepted) counters.groundRejects++;
      return out;
    },
    clipCamera(target, desired, radius = sweepRadiusMin, out = {}) {
      counters.cameraQueries++;
      if (clipCamera) return clipCamera(target, desired, radius, out);
      out.blocked = false; out.amount = 1; out.time = 1;
      out.normalX = 0; out.normalY = 1; out.normalZ = 0;
      return out;
    },
    readDiagnostics() { return { ...counters }; },
  };
  if (dispose) domain.dispose = dispose;
  return Object.assign(domain, { __scratch: EMPTY });
}
