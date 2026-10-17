/**
 * `CNT-02` curated landmark recipes — **data only**.
 *
 * The island's two structural landmarks are declared here as parametric modules
 * (`box`, `grid`, `step`, `tier`) plus the openings that must stay walkable, and
 * `RecipeCompiler` turns them into the compiled module list the camera sweep and
 * the (future) visual batch consume. Nothing in this file imports `three`, knows
 * about a mesh, or does layout arithmetic of its own: a contributor adds a
 * landmark by adding numbers.
 */

export const GDO_CURATED_LANDMARKS = Object.freeze({
  gateway: Object.freeze({
    id: 'gateway',
    label: 'India Gate-style gateway',
    color: '#c9a777',
    // The genuine central arch is a reservation, never one enclosing box: the
    // prism is the clear passage between the piers and under the first voussoir
    // ring, so the stepped stones above it are its boundary, not its contents.
    openings: Object.freeze([
      Object.freeze({ id: 'gateway:arch', at: Object.freeze([0, 8.675, 0]), size: Object.freeze([9, 9.35, 9]) }),
    ]),
    modules: Object.freeze([
      // Plinth, then the two masonry piers that flank the arch.
      Object.freeze({ op: 'box', id: 'gateway:plinth', at: Object.freeze([0, 3.5, 0]), size: Object.freeze([29, 1, 15]) }),
      Object.freeze({
        op: 'grid', id: 'gateway:pier:{xSign}', offsets: Object.freeze({ x: Object.freeze([-9, 9]) }),
        at: Object.freeze([0, 12, 0]), size: Object.freeze([9, 18, 9]),
      }),
      // Stepped voussoir stones march up and inward from both piers.
      Object.freeze({
        op: 'step', id: 'gateway:arch:{side}:{index}', count: 5,
        at: Object.freeze([0, 14, 0]), size: Object.freeze([1.4, 1.3, 9]),
        branches: Object.freeze([
          Object.freeze({ name: -1, at: Object.freeze([-4.3, 0, 0]), step: Object.freeze([.65, 1.1, 0]) }),
          Object.freeze({ name: 1, at: Object.freeze([4.3, 0, 0]), step: Object.freeze([-.65, 1.1, 0]) }),
        ]),
      }),
      Object.freeze({ op: 'box', id: 'gateway:lintel', at: Object.freeze([0, 21.25, 0]), size: Object.freeze([30, 4.5, 12]) }),
      Object.freeze({
        op: 'grid', id: 'gateway:tower:{x}:{z}',
        offsets: Object.freeze({ x: Object.freeze([-11, 11]), z: Object.freeze([-4, 4]) }),
        at: Object.freeze([0, 28, 0]), size: Object.freeze([4, 10, 4]),
      }),
    ]),
  }),
  chariot: Object.freeze({
    id: 'chariot',
    label: 'Stone chariot',
    color: '#997d59',
    openings: Object.freeze([]),
    modules: Object.freeze([
      Object.freeze({ op: 'box', id: 'chariot:plinth', at: Object.freeze([0, 4, 0]), size: Object.freeze([23, 2, 21]) }),
      Object.freeze({ op: 'box', id: 'chariot:body', at: Object.freeze([0, 7, 0]), size: Object.freeze([14, 4, 12]) }),
      // Wheels ride the plinth plane, columns stand at the body corners.
      Object.freeze({
        op: 'grid', id: 'chariot:wheel:{x}:{z}',
        offsets: Object.freeze({ x: Object.freeze([-5, 5]), z: Object.freeze([-5, 5]) }),
        at: Object.freeze([0, 7, 0]), size: Object.freeze([7, 7, 1.8]), scale: Object.freeze({ z: 1.3 }),
      }),
      Object.freeze({
        op: 'grid', id: 'chariot:column:{x}:{z}',
        offsets: Object.freeze({ x: Object.freeze([-5, 5]), z: Object.freeze([-5, 5]) }),
        at: Object.freeze([0, 14, 0]), size: Object.freeze([1.8, 10, 1.8]), scale: Object.freeze({ z: .7 }),
      }),
      // Six shrinking roof tiers.
      Object.freeze({
        op: 'tier', id: 'chariot:roof:{index}', count: 6,
        at: Object.freeze([0, 19, 0]), step: Object.freeze([0, 1.3, 0]),
        size: Object.freeze([17, 1.3, 14]), sizeStep: Object.freeze([-2, 0, -1.7]),
      }),
    ]),
  }),
});

/** Landmark ids in declaration order; a consumer iterates this, not `Object.keys`. */
export const GDO_CURATED_LANDMARK_IDS = Object.freeze(Object.keys(GDO_CURATED_LANDMARKS));

/**
 * Compile every curated landmark at its island origin. Returns the compiled
 * recipes plus the flattened module list a camera sweep or a visual batch reads.
 */
export function compileCuratedLandmarks(compileLandmarkRecipe, origins, { profile = 'low' } = {}) {
  if (typeof compileLandmarkRecipe !== 'function') {
    throw new TypeError('Curated landmarks need the recipe compiler');
  }
  const landmarks = GDO_CURATED_LANDMARK_IDS.map(id => {
    const origin = origins?.[id];
    if (!origin) throw new RangeError(`Curated landmark ${id} has no declared origin`);
    return compileLandmarkRecipe(GDO_CURATED_LANDMARKS[id], { profile, origin });
  });
  return Object.freeze({
    landmarks: Object.freeze(landmarks),
    modules: Object.freeze(landmarks.flatMap(entry => entry.modules)),
  });
}
