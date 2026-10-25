/**
 * Landmark recipe fixtures — **data only**, for the `CNT-02`/`CNT-03` gates.
 *
 * These two parametric recipes used to live beside the curated island, which the
 * coordinate world replaced. The *validator* gate is still real — a recipe must
 * compile, its openings must be probed clear, and its bounds must hold — so the
 * data it is exercised against moves here instead of disappearing with the island.
 *
 * Nothing imports this module at runtime: it is the input a test hands to
 * `validateLandmarkRecipe` / `compileLandmarkRecipe` / `renderModulePreview`. A
 * contributor's own recipe goes in `public/content/`, never here.
 */

export const GDO_LANDMARK_FIXTURES = Object.freeze({
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

/** Fixture ids in declaration order; a consumer iterates this, not `Object.keys`. */
export const GDO_LANDMARK_FIXTURE_IDS = Object.freeze(Object.keys(GDO_LANDMARK_FIXTURES));
