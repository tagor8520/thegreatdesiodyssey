/**
 * The curated runtime's seven shop items, as `CNT-02` recipes.
 *
 * These are the **same boxes** `createFoodModel()` hand-wrote before this slice — same centres,
 * same sizes, same colours, same rotations — expressed as declarative steps instead of
 * imperative `batch.box(...)` calls and hand-rolled loops. `ContentRecipe.test.js` carries a
 * transcription of the old function as `legacyModel()` and asserts the compiler reproduces it
 * box for box, which is what makes the port safe to accept: the curated look does not change,
 * and the geometry can still be counted.
 *
 * What the port buys, concretely:
 *  - an item is **data**. Adding one is a recipe entry, not a branch in an if/else chain with a
 *    `throw` at the end for the case nobody remembered;
 *  - the loops become **modules**: the five parotta layers are one `stack` with a parity size and
 *    a per-layer spin, the chip basket is one `grid` with a parity lift, the dosa fan is one
 *    `stack` with a `crown`;
 *  - colours become **roles**, so the palette is the only place a hex literal lives and a
 *    recolor cannot change the geometry;
 *  - every parameter is validated against the module's declared range before anything is built,
 *    so a typo is a named refusal instead of a `NaN` that reaches the GPU as an invisible prop.
 *
 * Palette role names are the item's own vocabulary (`bun`, `patty`, `chutney`, `dosa`, …) rather
 * than a generic base/accent pair: a contributor reading a recipe should be able to see what
 * each part *is*.
 */

/** The seed the curated items compile with. Nothing here is seeded today; a future `scatter` is. */
export const FOOD_RECIPE_SEED = 0x5eed;

export const FOOD_RECIPES = Object.freeze({
  'vada-pav': {
    palette: {
      bread: '#e4b86c',
      chutney: '#4d9132',
      patty: '#c48620',
      bun: '#e6a14a',
      bunTop: '#efb663',
    },
    steps: [
      // The stack is explicit rather than a run: a burger's layers are each their own decision,
      // which is exactly the shape `stack` takes `layers` for.
      { module: 'stack', layers: [
        { at: [0, 0.1, 0], size: [1.8, 0.35, 1.5], color: 'bread' },
        { at: [0, 0.36, 0], size: [1.9, 0.12, 1.6], color: 'chutney' },
        { at: [0, 0.65, 0], size: [1.5, 0.5, 1.3], color: 'patty' },
        { at: [0, 1, 0], size: [1.9, 0.35, 1.5], color: 'bun' },
        { at: [0, 1.25, 0], size: [1.5, 0.2, 1.2], color: 'bunTop' },
      ] },
    ],
  },

  'cutting-chai': {
    palette: { saucer: '#bdcbd0', cup: '#779c9d', lid: '#a66c37', handle: '#f1eee0' },
    steps: [
      { module: 'box', at: [0, 0, 0], size: [1.2, 0.12, 1.2], color: 'saucer' },
      { module: 'box', at: [0, 0.6, 0], size: [1.1, 1.1, 1.1], color: 'cup' },
      { module: 'box', at: [0, 1.18, 0], size: [1.05, 0.12, 1.05], color: 'lid' },
      { module: 'box', at: [-0.3, 0.6, 0.56], size: [0.15, 0.85, 0.05], color: 'handle' },
    ],
  },

  'filter-coffee': {
    // The same object one size up — the reason both are recipes and not one recipe with an
    // `if`: a contributor wanting a third cup adds a third entry.
    palette: { saucer: '#bdcbd0', cup: '#aabcc5', lid: '#d5ab70', handle: '#f1eee0' },
    steps: [
      { module: 'box', at: [0, 0, 0], size: [2, 0.12, 2], color: 'saucer' },
      { module: 'box', at: [0, 0.6, 0], size: [1.1, 1.1, 1.1], color: 'cup' },
      { module: 'box', at: [0, 1.18, 0], size: [1.05, 0.12, 1.05], color: 'lid' },
      { module: 'box', at: [-0.3, 0.6, 0.56], size: [0.15, 0.85, 0.05], color: 'handle' },
    ],
  },

  'mysore-pak': {
    palette: { tray: '#e2ddd1', block: '#dbac35', stripe: '#b27b25' },
    steps: [
      // One block, mirrored: the pair is a property of the symmetry rather than two numbers a
      // contributor has to keep equal by hand.
      { module: 'box', at: [-0.55, 0.45, 0], size: [0.95, 0.8, 1.4], color: 'block' },
      { op: 'mirrorX' },
      { module: 'box', at: [0, 0, 0], size: [2.2, 0.1, 1.8], color: 'tray' },
      { module: 'row', at: [-0.85, 0.87, 0.15], step: [0.4, 0, 0], count: 5, size: [0.15, 0.07, 0.18], color: 'stripe' },
    ],
  },

  'banana-chips': {
    palette: { tray: '#40852e', chips: '#f0c335' },
    steps: [
      { module: 'box', at: [0, 0, 0], size: [2.4, 0.12, 1.8], color: 'tray' },
      // Seven chips in a 3x3 tray: every other cell lifted, every chip spun by its own index.
      { module: 'grid', at: [0, 0.2, 0], size: [0.65, 0.16, 0.55], columns: 3, rows: 3, stepX: 0.6, stepZ: 0.5, parityY: 0.13, spinStep: 1, count: 7, color: 'chips' },
    ],
  },

  'podi-dosa': {
    palette: { plate: '#498a30', dosa: '#e4b663', dosaEdge: '#c88a38', chutney: '#bf4f27' },
    steps: [
      { module: 'box', at: [0, 0, 0], size: [2.6, 0.1, 1.8], color: 'plate' },
      // A fan: the middle slice is the tallest, and `crown` is the whole of that sentence.
      { module: 'stack', count: 5, y: 0.25, crown: 0.17, zStep: 0.22, size: [2.3, 0.25, 0.28], colorCycle: ['dosa', 'dosaEdge'] },
      { module: 'box', at: [1, 0.17, 0.65], size: [0.45, 0.2, 0.45], color: 'chutney' },
    ],
  },

  'kerala-porotta': {
    palette: { plate: '#497c37', layer: '#f4deb0', layerEdge: '#d2ab73' },
    steps: [
      { module: 'box', at: [0, 0, 0], size: [2.2, 0.1, 2], color: 'plate' },
      // Five torn layers: every other layer a little smaller and turned a little further.
      { module: 'stack', count: 5, y: 0.18, yStep: 0.15, size: [1.7, 0.13, 1.6], paritySize: [0.2, 0, 0.2], spinStep: 0.25, colorCycle: ['layer', 'layerEdge'] },
    ],
  },
});

/**
 * A worked example of the modules the shipped items do not use, kept here so the contributor
 * documentation and the tests compile the *same* recipe rather than two copies of it.
 *
 * It is deliberately composed of vocabulary no shipped item uses — `ring`, `translate`,
 * `rotateY`, `metalness` — because an example that only repeats what already ships documents
 * nothing. It is not spawned by the runtime: `CNT-04` adds packs, and when it does, this is the
 * shape a new item arrives in.
 */
export const DIWALI_LAMP_RECIPE = Object.freeze({
  palette: { clay: '#b4552e', rim: '#e8a33d', flame: '#ffd766', shadow: '#7c3a1f' },
  steps: [
    { module: 'box', at: [0, 0.15, 0], size: [1.6, 0.3, 1.6], color: 'clay' },
    { module: 'ring', at: [0, 0.45, 0], size: [0.35, 0.3, 0.35], radius: 0.7, count: 8, axis: 'y', colorCycle: ['rim', 'clay'] },
    { module: 'box', at: [0, 0.9, 0], size: [0.4, 0.6, 0.4], color: 'flame' },
    { module: 'scatter', at: [0, 0.35, 0], area: [2.2, 0.1, 2.2], count: 12, size: [0.12, 0.12, 0.12], sizeVariance: 0.4, color: 'shadow' },
    { op: 'translate', by: [0, 2, 0] },
    { op: 'rotateY', turns: 1 },
  ],
});
