/**
 * The two shipped curated landmarks, as `DET-09` declarations.
 *
 * These are the **same boxes** the pre-`DET-09` `BiomeManager.gateway()` and `chariot()`
 * functions stamped, expressed as modules with repeat descriptors instead of hand-written
 * loops, plus the openings and proxies that were previously only implied. The parity table in
 * `GeoLandmarkGrammar.test.js` was transcribed from that source and is what makes the port
 * safe to accept: the curated look does not change, and the geometry can still be counted.
 *
 * What the port buys, concretely:
 *  - the Gateway's arch is a **declared void** with a profile, so the opening is a property of
 *    the artifact instead of an emergent consequence of two loops;
 *  - the camera blockers are **derived** from the same modules instead of being a second list
 *    kept in step by hand, and the derivation is where "one proxy per site" lives, so a wheel
 *    is one slab rather than sixteen stones;
 *  - finials, spokes, crenellations and trim declare `structural: false` and therefore cannot
 *    become walls — §17.2's "visual boxes that create colliders automatically: 0".
 *
 * All `y` values are **relative to the landmark's base** (the terrain height it stands on,
 * which is 3 across the curated map). The pre-`DET-09` code baked absolute world Y into every
 * call, which is why the two landmarks could not be moved to different ground without editing
 * every number in them.
 */
import { createLandmarkDefinition } from './GeoLandmarkGrammar.js';

const STONE = '#c6a06b';
const TRIM = '#e4c28a';
const FINIAL = '#80623b';
const CHARIOT_STONE = '#c9a777';
const CHARIOT_DARK = '#997d59';

/**
 * The Gateway: two piers carrying a lintel, with a stepped arch between them.
 *
 * The opening is expressed as its **free profile**, measured from the shipped voussoirs: full
 * width between the piers, then narrowing in four steps as the arch stones climb. `bottom` is
 * the top of the plinth rather than its centre, because the plinth is the paved threshold the
 * passage crosses — a floor, not an obstruction — and a void that started below it would have
 * rejected the floor it stands on.
 */
export const GATEWAY_LANDMARK = createLandmarkDefinition({
  id: 'gateway',
  base: 3,
  approach: { axis: 'z', clearance: 9, headHeight: 10 },
  voids: [{
    id: 'arch-passage',
    bottom: 4,
    halfDepth: 4.5,
    headHeight: 10,
    bands: [
      { top: 13.35, halfWidth: 4.5 },
      { top: 14.45, halfWidth: 3.6 },
      { top: 15.55, halfWidth: 2.95 },
      { top: 16.5, halfWidth: 2.3 },
    ],
  }],
  masses: [
    { id: 'plinth', order: 0, box: { y: .5, sizeX: 29, sizeY: 1, sizeZ: 15, color: TRIM }, structural: true },
    {
      // `proxyId` keeps the id the curated camera gate addresses (`gateway:pier:-1`), even
      // though the module is now one loop over two offsets.
      id: 'piers', order: 1, structural: true, proxyId: 'pier:{side}',
      repeat: { kind: 'grid', xOffsets: [-9, 9] },
      box: { y: 9, sizeX: 9, sizeY: 18, sizeZ: 9, color: STONE },
    },
    {
      // A mass whose collision is larger than its drawing: the tower's caps and finial sit
      // inside one 4x10x4 proxy rather than contributing colliders of their own.
      id: 'towers', order: 2, structural: true, proxyId: 'tower:{x}:{z}',
      repeat: { kind: 'grid', xOffsets: [-11, 11], zOffsets: [-4, 4] },
      box: { y: 23, sizeX: 3, sizeY: 6, sizeZ: 3, color: TRIM },
      proxy: { y: 25, sizeX: 4, sizeY: 10, sizeZ: 4 },
    },
    {
      id: 'lintel', order: 3, structural: true,
      box: { y: 18, sizeX: 29, sizeY: 3, sizeZ: 11, color: STONE },
      // The shipped camera blocker was deliberately a little larger than the drawn lintel —
      // 30 x 4.5 x 12 centred 0.25 above it — so a camera cannot graze through the beam.
      proxy: { y: 18.25, sizeX: 30, sizeY: 4.5, sizeZ: 12 },
    },
  ],
  repeats: [
    {
      // Masonry, not decoration: the voussoirs are what a camera must not pass through, and
      // they are also what narrows the declared void above 13.35 m.
      id: 'arch-voussoirs', order: 0, structural: true, proxyId: 'arch:{side}:{step}',
      repeat: { kind: 'walk', count: 5, start: [4.3, 11, 0], step: [-.65, 1.1, 0], mirror: 'x' },
      box: { sizeX: 1.4, sizeY: 1.3, sizeZ: 9, color: TRIM },
    },
    {
      id: 'roof-trim', order: 1,
      repeat: { kind: 'stack', count: 2, startY: 17, stepY: 3 },
      box: { sizeX: 30, sizeY: .7, sizeZ: 12, color: TRIM },
    },
    {
      id: 'tower-caps', order: 2,
      repeat: {
        kind: 'grid', xOffsets: [-11, 11], zOffsets: [-4, 4],
        each: { kind: 'stack', count: 3, stepY: .6, startY: 0, sizeStep: [-1, 0, -1] },
      },
      box: { y: 26, sizeX: 4, sizeY: .7, sizeZ: 4, color: STONE },
    },
  ],
  accents: [
    {
      id: 'crenellations', order: 0,
      repeat: { kind: 'line', axis: 'x', from: -13, to: 13, step: 2 },
      box: { y: 21, z: 5, sizeX: .7, sizeY: 1.5, sizeZ: 1, color: STONE },
    },
    {
      // §15.8: a visual finial does not enlarge structural collision. This module emits no
      // proxy at all; the tower mass above is what declares the collision it stands in.
      id: 'tower-finials', order: 1,
      repeat: { kind: 'grid', xOffsets: [-11, 11], zOffsets: [-4, 4] },
      box: { y: 29, sizeX: .5, sizeY: 2, sizeZ: .5, color: FINIAL },
    },
  ],
});

/**
 * The Chariot: a wheeled monument on a plinth, with four columns carrying six stepped roof
 * tiers. Two wheels are written as *four positions x sixteen rim stones* plus *eight spokes
 * each*, which is where the pattern vocabulary earns its keep: sixty-four rim blocks, thirty-two
 * spokes and four columns are three modules, and the wheels contribute four camera blockers
 * rather than two hundred.
 *
 * There is no opening to declare: the monument is solid, and saying so is part of the point —
 * a landmark without voids compiles with an empty void report rather than a guessed one.
 */
export const CHARIOT_LANDMARK = createLandmarkDefinition({
  id: 'chariot',
  base: 3,
  masses: [
    { id: 'plinth', order: 0, box: { y: 1, sizeX: 23, sizeY: 2, sizeZ: 21, color: CHARIOT_STONE }, structural: true },
    { id: 'body', order: 1, box: { y: 4, sizeX: 14, sizeY: 4, sizeZ: 12, color: CHARIOT_DARK }, structural: true },
    {
      // Six tiers in one loop, alternating stone and dark as the shipped code did. The colour
      // cycle is a module property rather than a second module, so the six tiers keep six
      // distinct proxy ids and one material family.
      id: 'roof', order: 2, structural: true, proxyId: 'roof:{step}',
      repeat: { kind: 'stack', count: 6, startY: 16, stepY: 1.3, sizeStep: [-2, 0, -1.7] },
      colorCycle: [CHARIOT_STONE, CHARIOT_DARK],
      box: { sizeX: 17, sizeY: 1.3, sizeZ: 14 },
    },
  ],
  repeats: [
    {
      id: 'wheel-rims', order: 0, structural: true, proxyId: 'wheel:{x}:{ndz}', proxyIdScale: 1.3,
      repeat: {
        kind: 'grid', xOffsets: [-5, 5], zOffsets: [-6.5, 6.5],
        each: { kind: 'arc', count: 16, radius: 3 },
      },
      box: { y: 4, sizeX: 1.3, sizeY: 1.4, sizeZ: 1.3, color: CHARIOT_STONE },
      // The shipped blocker was 7 x 7 x 1.8 and cut the rim: sixteen stones sit at radius 3.0
      // and are rotated to face the hub, so the ones at 45 degrees reach a corner 0.7 m
      // further out — a circumscribed radius of 3.7 m. The declared collision is therefore
      // 7.4 square, which contains every drawn stone. (The port's first attempt declared 7.3
      // from the *tangential* half-width and was still 5 cm short; the DET-09 gate measures the
      // reach from the drawn instances and caught it.)
      proxy: { sizeX: 7.4, sizeY: 7.4, sizeZ: 1.8 },
    },
    {
      id: 'wheel-columns', order: 1, structural: true, proxyId: 'column:{x}:{ndz}', proxyIdScale: 0.7,
      repeat: { kind: 'grid', xOffsets: [-5, 5], zOffsets: [-3.5, 3.5] },
      box: { y: 11, sizeX: 1.8, sizeY: 10, sizeZ: 1.8, color: CHARIOT_STONE },
    },
  ],
  accents: [
    {
      // §15.8's spoke rule, and §19.5 item 8 with it: eight spokes per wheel, one module, no
      // collider. The wheel's collision is the rim proxy above.
      id: 'wheel-spokes', order: 0,
      repeat: {
        kind: 'grid', xOffsets: [-5, 5], zOffsets: [-6.5, 6.5],
        each: { kind: 'ring', count: 8 },
      },
      box: { y: 4, sizeX: .45, sizeY: 5, sizeZ: .5, color: CHARIOT_STONE },
    },
  ],
});

/** The shipped landmark definitions, keyed by id. */
export const GEO_LANDMARK_DEFINITIONS = Object.freeze({
  gateway: GATEWAY_LANDMARK,
  chariot: CHARIOT_LANDMARK,
});
