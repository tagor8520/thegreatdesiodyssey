import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import { featureNamespace } from './FeatureVersions.js';

/**
 * `DET-10` prop/food grammar and triggers.
 *
 * A prop is a small compiled object with three deliberately separate parts:
 *
 * - **modules** — the visible boxes. Ordinary near props stay inside 2–12 boxes,
 *   a hero food kiosk inside 12–32, and plates, toppings, handles, and layers are
 *   marked `visual` so nothing downstream can mistake them for structure.
 * - **solid proxy** — authored, never inferred. A family that declares no proxy
 *   contributes no blocker at all; a family that declares one lists its own boxes,
 *   and the visual modules are never consulted to build it. `solidProxy` is `null`
 *   for every family without the flag, which is what "props do not become player
 *   blockers unless a deliberate solid proxy is authored" means in code.
 * - **trigger** — a stable spherical interaction range from the family's declared
 *   interaction height and radius, generously sized (`generosity > 1`) so a player
 *   who can see the prop can reach it. It is *not* derived from the visual boxes'
 *   `Box3`, so a bob, spin, or scale animation never rebuilds it, and it carries
 *   its own action id from the `GME-05` registry.
 *
 * The grammar is data: `compileProp()` is a pure function of family, seed, and
 * scale, so the same seed always yields the same prop anywhere in the world.
 */

export const GDO_PROP_NAMESPACE = featureNamespace('propGrammar');

export const GDO_PROP_LIMITS = Object.freeze({
  families: 8,
  ordinaryModules: 12,
  heroModules: 32,
  heroMinimumModules: 12,
  anchorHeightMetres: 12,
  interactionActions: 1,
});

/** Module roles. `visual` modules are never structure, whatever they look like. */
export const GDO_PROP_ROLE = Object.freeze({
  VISUAL: 'visual',
  PLATE: 'plate',
  TOPPING: 'topping',
  HANDLE: 'handle',
  STRUCTURE: 'structure',
});

const VISUAL_ROLES = Object.freeze([GDO_PROP_ROLE.VISUAL, GDO_PROP_ROLE.PLATE, GDO_PROP_ROLE.TOPPING, GDO_PROP_ROLE.HANDLE]);

/**
 * The families, in placement priority order. `size`/`offset` are metres scaled by
 * the prop's own scale, `tone` indexes the shared palette, `spin`/`tilt` are the
 * module's own small rotation, and `role` says what the box is allowed to be.
 */
export const GDO_PROP_FAMILIES = Object.freeze([
  Object.freeze({
    id: 'chaat-cart', tier: 'hero', label: 'Chaat cart', tone: 11,
    interaction: Object.freeze({ action: 'interact', radiusMetres: 2.4, generosity: 1.35, heightMetres: 1.05, hint: 'Try the chaat' }),
    solid: null, placementKinds: Object.freeze(['market', 'residential', 'commercial', 'street']), roadOffsetMetres: 2.6, weight: 3,
    modules: Object.freeze([
      Object.freeze({ role: 'structure', size: Object.freeze([1.5, .08, .85]), offset: Object.freeze([0, .46, 0]), tone: 11 }),
      Object.freeze({ role: 'structure', size: Object.freeze([.07, .46, .07]), offset: Object.freeze([-.62, .23, -.32]), tone: 6 }),
      Object.freeze({ role: 'structure', size: Object.freeze([.07, .46, .07]), offset: Object.freeze([.62, .23, -.32]), tone: 6 }),
      Object.freeze({ role: 'structure', size: Object.freeze([.07, .46, .07]), offset: Object.freeze([-.62, .23, .32]), tone: 6 }),
      Object.freeze({ role: 'structure', size: Object.freeze([.07, .46, .07]), offset: Object.freeze([.62, .23, .32]), tone: 6 }),
      Object.freeze({ role: 'structure', size: Object.freeze([1.35, .05, .7]), offset: Object.freeze([0, .52, 0]), tone: 4 }),
      Object.freeze({ role: 'structure', size: Object.freeze([.42, .3, .42]), offset: Object.freeze([-.45, .7, 0]), tone: 8 }),
      Object.freeze({ role: 'structure', size: Object.freeze([.3, .34, .3]), offset: Object.freeze([.5, .72, 0]), tone: 3 }),
      Object.freeze({ role: 'plate', size: Object.freeze([.28, .035, .26]), offset: Object.freeze([-.45, .87, 0]), tone: 1 }),
      Object.freeze({ role: 'topping', size: Object.freeze([.16, .06, .14]), offset: Object.freeze([-.45, .91, .02]), tone: 2 }),
      Object.freeze({ role: 'visual', size: Object.freeze([.05, .05, .05]), offset: Object.freeze([-.45, .94, -.06]), tone: 0 }),
      Object.freeze({ role: 'handle', size: Object.freeze([.03, .16, .03]), offset: Object.freeze([.3, 1.02, .28]), tone: 6 }),
    ]),
  }),
  Object.freeze({
    id: 'chai-stall', tier: 'hero', label: 'Chai stall', tone: 9,
    interaction: Object.freeze({ action: 'interact', radiusMetres: 2.2, generosity: 1.4, heightMetres: 1.1, hint: 'A glass of chai' }),
    solid: Object.freeze([Object.freeze({ size: Object.freeze([1.2, .9, .6]), offset: Object.freeze([0, .45, 0]) })]),
    placementKinds: Object.freeze(['market', 'commercial', 'industrial', 'street']), roadOffsetMetres: 2.2, weight: 3,
    modules: Object.freeze([
      Object.freeze({ role: 'structure', size: Object.freeze([1.2, .5, .6]), offset: Object.freeze([0, .25, 0]), tone: 5 }),
      Object.freeze({ role: 'structure', size: Object.freeze([1.0, .06, .5]), offset: Object.freeze([0, .53, 0]), tone: 4 }),
      Object.freeze({ role: 'structure', size: Object.freeze([.22, .3, .22]), offset: Object.freeze([-.35, .7, 0]), tone: 8 }),
      Object.freeze({ role: 'structure', size: Object.freeze([.26, .42, .26]), offset: Object.freeze([.32, .76, 0]), tone: 3 }),
      Object.freeze({ role: 'visual', size: Object.freeze([.08, .09, .08]), offset: Object.freeze([.32, 1.0, 0]), tone: 1 }),
      Object.freeze({ role: 'plate', size: Object.freeze([.3, .03, .24]), offset: Object.freeze([-.35, .87, 0]), tone: 1 }),
      Object.freeze({ role: 'topping', size: Object.freeze([.1, .04, .1]), offset: Object.freeze([-.35, .9, .04]), tone: 2 }),
      Object.freeze({ role: 'visual', size: Object.freeze([.12, .12, .12]), offset: Object.freeze([-.35, .9, -.1]), tone: 0 }),
      Object.freeze({ role: 'handle', size: Object.freeze([.02, .5, .02]), offset: Object.freeze([.58, .78, .26]), tone: 6 }),
      Object.freeze({ role: 'visual', size: Object.freeze([.5, .04, .34]), offset: Object.freeze([0, .56, .1]), tone: 7 }),
      Object.freeze({ role: 'topping', size: Object.freeze([.14, .05, .12]), offset: Object.freeze([.1, .59, .12]), tone: 2 }),
      Object.freeze({ role: 'visual', size: Object.freeze([.05, .18, .05]), offset: Object.freeze([-.5, .6, -.2]), tone: 6 }),
    ]),
  }),
  Object.freeze({
    id: 'produce-crate', tier: 'ordinary', label: 'Produce crate', tone: 6,
    interaction: Object.freeze({ action: 'interact', radiusMetres: 1.1, generosity: 1.5, heightMetres: .45, hint: 'Take a look' }),
    solid: null, placementKinds: Object.freeze(['market', 'residential', 'farmland']), roadOffsetMetres: 2.0, weight: 4,
    modules: Object.freeze([
      Object.freeze({ role: 'structure', size: Object.freeze([.52, .26, .38]), offset: Object.freeze([0, .13, 0]), tone: 6 }),
      Object.freeze({ role: 'topping', size: Object.freeze([.44, .1, .3]), offset: Object.freeze([0, .31, 0]), tone: 2 }),
      Object.freeze({ role: 'topping', size: Object.freeze([.14, .1, .12]), offset: Object.freeze([-.12, .38, .06]), tone: 0 }),
      Object.freeze({ role: 'topping', size: Object.freeze([.12, .11, .12]), offset: Object.freeze([.08, .39, -.04]), tone: 1 }),
      Object.freeze({ role: 'plate', size: Object.freeze([.5, .03, .36]), offset: Object.freeze([0, .435, 0]), tone: 4 }),
    ]),
  }),
  Object.freeze({
    id: 'tiffin-stack', tier: 'ordinary', label: 'Tiffin stack', tone: 8,
    interaction: Object.freeze({ action: 'interact', radiusMetres: 1.0, generosity: 1.5, heightMetres: .4, hint: 'A stacked tiffin' }),
    solid: null, placementKinds: Object.freeze(['market', 'residential']), roadOffsetMetres: 1.8, weight: 3,
    modules: Object.freeze([
      Object.freeze({ role: 'structure', size: Object.freeze([.3, .12, .3]), offset: Object.freeze([0, .06, 0]), tone: 8 }),
      Object.freeze({ role: 'structure', size: Object.freeze([.27, .12, .27]), offset: Object.freeze([0, .18, 0]), tone: 8 }),
      Object.freeze({ role: 'structure', size: Object.freeze([.24, .12, .24]), offset: Object.freeze([0, .3, 0]), tone: 8 }),
      Object.freeze({ role: 'handle', size: Object.freeze([.16, .03, .03]), offset: Object.freeze([0, .37, 0]), tone: 6 }),
    ]),
  }),
  Object.freeze({
    id: 'grain-sack', tier: 'ordinary', label: 'Grain sack', tone: 4,
    interaction: Object.freeze({ action: 'interact', radiusMetres: 1.0, generosity: 1.5, heightMetres: .5, hint: 'Grain sacks' }),
    solid: null, placementKinds: Object.freeze(['market', 'farmland', 'industrial']), roadOffsetMetres: 2.1, weight: 3,
    modules: Object.freeze([
      Object.freeze({ role: 'structure', size: Object.freeze([.42, .5, .34]), offset: Object.freeze([0, .25, 0]), tone: 4 }),
      Object.freeze({ role: 'visual', size: Object.freeze([.26, .08, .22]), offset: Object.freeze([0, .54, 0]), tone: 4 }),
      Object.freeze({ role: 'visual', size: Object.freeze([.36, .04, .28]), offset: Object.freeze([.02, .3, 0]), tone: 7 }),
    ]),
  }),
  Object.freeze({
    id: 'steel-kettle', tier: 'ordinary', label: 'Steel kettle', tone: 3,
    interaction: Object.freeze({ action: 'interact', radiusMetres: .9, generosity: 1.6, heightMetres: .3, hint: 'Steaming kettle' }),
    solid: null, placementKinds: Object.freeze(['market', 'residential', 'commercial', 'street']), roadOffsetMetres: 1.6, weight: 2,
    modules: Object.freeze([
      Object.freeze({ role: 'structure', size: Object.freeze([.2, .24, .2]), offset: Object.freeze([0, .12, 0]), tone: 3 }),
      Object.freeze({ role: 'handle', size: Object.freeze([.22, .03, .03]), offset: Object.freeze([0, .3, 0]), tone: 6 }),
      Object.freeze({ role: 'visual', size: Object.freeze([.05, .1, .05]), offset: Object.freeze([.1, .28, 0]), tone: 1 }),
    ]),
  }),
]);

/**
 * The grammar's own tone table: the same twelve generated colours every prop
 * module indexes. `tone` is a small integer so a module spec stays data, and the
 * geometry builder and any future instanced palette read the same rows.
 */
export const GDO_PROP_TONES = Object.freeze([
  Object.freeze([.86, .30, .22]), Object.freeze([.94, .62, .24]), Object.freeze([.55, .70, .28]),
  Object.freeze([.74, .78, .82]), Object.freeze([.83, .70, .46]), Object.freeze([.46, .52, .58]),
  Object.freeze([.52, .36, .24]), Object.freeze([.90, .86, .78]), Object.freeze([.68, .58, .44]),
  Object.freeze([.36, .42, .34]), Object.freeze([.58, .30, .30]), Object.freeze([.80, .48, .34]),
]);

export function propToneColor(tone) {
  return GDO_PROP_TONES[tone % GDO_PROP_TONES.length] ?? GDO_PROP_TONES[0];
}

export const GDO_PROP_FAMILY_IDS = Object.freeze(GDO_PROP_FAMILIES.map(family => family.id));

export function propFamilyFor(id) {
  const family = GDO_PROP_FAMILIES.find(candidate => candidate.id === id);
  if (!family) throw new RangeError(`Unknown prop family: ${id}`);
  return family;
}

export function isPropVisualRole(role) {
  return VISUAL_ROLES.includes(role);
}

function fnv(text, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The visible box list, with the family's palette tones resolved to the shared
 * palette rows. Geometry compilation and placement both read this, so a drawn
 * prop and a compiled prop can never disagree.
 */
export function propModuleBoxes(id) {
  const family = propFamilyOf(id);
  return Object.freeze(family.modules.map((module, index) => Object.freeze({
    index,
    role: module.role,
    visual: isPropVisualRole(module.role),
    size: module.size,
    offset: module.offset,
    tone: module.tone,
    spin: module.spin ?? 0,
    tilt: module.tilt ?? 0,
  })));
}

function propFamilyOf(id) {
  return typeof id === 'string' ? propFamilyFor(id) : id;
}

/**
 * Compile one prop. Pure in `(family, seed, scale)`: the same seed gives the same
 * boxes, the same proxy, and the same trigger everywhere in the world.
 */
export function compileProp(familyOrId, { seed = 0, scale = 1, interactionRange = null } = {}) {
  const family = propFamilyOf(familyOrId);
  if (!(scale > 0)) throw new RangeError(`Prop ${family.id} needs a positive scale`);
  const boxes = [];
  const counts = { boxes: 0, visual: 0, structure: 0 };
  let visualRadius = 0, tallest = 0;
  for (const module of propModuleBoxes(family)) {
    // The seed only jitters the small visual modules, so a prop's silhouette and
    // its proxy stay stable while its dressing varies.
    const jitter = module.visual ? ((fnv(`${family.id}:${seed}:${module.index}`) % 1000) / 1000 - .5) * .12 : 0;
    const box = Object.freeze({
      role: module.role,
      visual: module.visual,
      size: Object.freeze([
        module.size[0] * (1 + jitter), module.size[1] * (1 - jitter * .5), module.size[2] * (1 + jitter * .5),
      ]),
      offset: Object.freeze([
        module.offset[0] + (module.visual ? jitter * .3 : 0), module.offset[1], module.offset[2] + (module.visual ? -jitter * .3 : 0),
      ]),
      tone: module.tone,
      spin: module.spin,
      tilt: module.tilt,
    });
    boxes.push(box);
    counts.boxes++;
    if (box.visual) counts.visual++; else counts.structure++;
    visualRadius = Math.max(visualRadius,
      Math.hypot(box.offset[0], box.offset[2]) + Math.max(box.size[0], box.size[2]) * .5);
    tallest = Math.max(tallest, box.offset[1] + box.size[1] * .5);
    if (counts.boxes > GDO_PROP_LIMITS.heroModules) throw new RangeError(`Prop ${family.id} exceeds the module ceiling`);
  }
  const declared = family.interaction;
  // The trigger is its own declared sphere, generously sized, and it never reads
  // the visual boxes: that is the separation this row exists to prove.
  const triggerRadius = (interactionRange ?? declared.radiusMetres) * declared.generosity;
  const trigger = Object.freeze({
    action: declared.action,
    hint: declared.hint,
    radius: triggerRadius * scale,
    generosity: declared.generosity,
    centre: Object.freeze([0, declared.heightMetres * scale, 0]),
    source: 'declared-interaction-sphere-v1',
    derivedFromVisualBoxes: false,
  });
  const solidProxy = family.solid
    ? Object.freeze(family.solid.map(box => Object.freeze({
      size: Object.freeze([box.size[0] * scale, box.size[1] * scale, box.size[2] * scale]),
      offset: Object.freeze([box.offset[0] * scale, box.offset[1] * scale, box.offset[2] * scale]),
    })))
    : null;
  return Object.freeze({
    namespace: GDO_PROP_NAMESPACE,
    family: family.id,
    tier: family.tier,
    label: family.label,
    seed,
    scale,
    anchorHeightMetres: Math.min(tallest, GDO_PROP_LIMITS.anchorHeightMetres),
    visualRadius: visualRadius * scale,
    boxes: Object.freeze(boxes),
    counts: Object.freeze(counts),
    solidProxy,
    blocker: solidProxy != null,
    trigger,
    interaction: Object.freeze({
      action: declared.action,
      // The range a gameplay probe uses is the trigger's own radius; the visual
      // radius is only ever a styling input.
      range: trigger.radius,
      generous: trigger.radius >= visualRadius * scale,
    }),
  });
}

/** Cheap containment test in the prop's own local frame. */
export function propTriggerContains(prop, x, y, z) {
  if (!prop?.trigger) return false;
  const dx = x - prop.trigger.centre[0], dy = y - prop.trigger.centre[1], dz = z - prop.trigger.centre[2];
  return dx * dx + dy * dy + dz * dz <= prop.trigger.radius * prop.trigger.radius;
}

/**
 * The nearest trigger inside range, or `null`. Reads a flat trigger stream
 * `[x, y, z, radius, actionIndex, propIndex]` per record, so a caller with many
 * props never builds a `Box3` and never allocates.
 */
export function queryPropTriggerStream(stream, stride, x, y, z) {
  if (!stream?.length || stride < 4) return null;
  let bestIndex = -1, bestDistance = Infinity;
  for (let index = 0; index + stride <= stream.length; index += stride) {
    const dx = x - stream[index], dy = y - stream[index + 1], dz = z - stream[index + 2];
    const distance = dx * dx + dy * dy + dz * dz;
    const radius = stream[index + 3];
    if (distance > radius * radius || distance >= bestDistance) continue;
    bestDistance = distance;
    bestIndex = index;
  }
  if (bestIndex < 0) return null;
  return Object.freeze({
    index: bestIndex / stride,
    action: stream[bestIndex + 4],
    prop: stream[bestIndex + 5],
    distance: Math.sqrt(bestDistance),
    radius: stream[bestIndex + 3],
  });
}

/**
 * Bind the prop interaction to the `GME-05` registry. The action is declared with
 * the `interaction` capability, so a world that declares it gets the action and a
 * world that does not skips it *by name* rather than silently dropping it.
 */
export const GDO_PROP_INTERACT_ACTION = Object.freeze({
  id: 'interact', order: 60, kind: 'tap', label: 'Interact', hint: 'E',
  capability: 'interaction', keyboard: Object.freeze(['KeyE']),
  pointer: null, touch: Object.freeze({ control: 'button', label: 'USE' }),
});

export function registerPropInteraction(registry) {
  if (!registry?.register || !registry?.has) throw new TypeError('registerPropInteraction needs an action registry');
  if (!registry.has(GDO_PROP_INTERACT_ACTION.id)) registry.register(GDO_PROP_INTERACT_ACTION);
  const registered = registry.has(GDO_PROP_INTERACT_ACTION.id);
  // A refused action is reported with the registry's own reason, so a world that
  // never declared the capability knows it skipped `interact` and why.
  const skip = registered ? null : (registry.diagnostics?.()?.skipped ?? [])
    .find(entry => entry.id === GDO_PROP_INTERACT_ACTION.id) ?? null;
  return Object.freeze({
    namespace: GDO_PROP_NAMESPACE,
    action: GDO_PROP_INTERACT_ACTION.id,
    registered,
    reason: registered ? null : (skip?.reason ?? 'unknown'),
  });
}

/** Caps and role split, checked against the shipped budget keys. */
export function validatePropFamilies({ budgets = GDO_LOW_PROFILE_BUDGETS, families = GDO_PROP_FAMILIES } = {}) {
  const violations = [];
  const ids = new Set();
  if (families.length > budgets.propFamilies) violations.push(`${families.length} families exceed the ${budgets.propFamilies}-family budget`);
  for (const family of families) {
    if (ids.has(family.id)) violations.push(`family ${family.id} is declared twice`);
    ids.add(family.id);
    if (!['ordinary', 'hero'].includes(family.tier)) violations.push(`family ${family.id} has an unknown tier`);
    const ceiling = family.tier === 'hero' ? budgets.propHeroModules : budgets.propOrdinaryModules;
    if (family.modules.length > ceiling) violations.push(`family ${family.id} has ${family.modules.length} modules over its ${ceiling} ceiling`);
    if (family.tier === 'hero' && family.modules.length < GDO_PROP_LIMITS.heroMinimumModules) {
      violations.push(`hero family ${family.id} has only ${family.modules.length} modules`);
    }
    if (family.tier === 'ordinary' && family.modules.length < 2) violations.push(`ordinary family ${family.id} needs at least two modules`);
    for (const module of family.modules) {
      if (!isPropVisualRole(module.role) && module.role !== 'structure') {
        violations.push(`family ${family.id} has an unknown module role ${module.role}`);
      }
      if (module.size.some(value => !(value > 0))) violations.push(`family ${family.id} has a degenerate module`);
    }
    if (!family.interaction || !family.interaction.action) violations.push(`family ${family.id} has no interaction action`);
    else {
      if (!(family.interaction.generosity > 1)) violations.push(`family ${family.id} has an ungenerous trigger`);
      if (!(family.interaction.radiusMetres > 0) || !(family.interaction.heightMetres >= 0)) {
        violations.push(`family ${family.id} has an invalid trigger size`);
      }
    }
    if (family.solid) {
      for (const box of family.solid) if (box.size.some(value => !(value > 0))) violations.push(`family ${family.id} has a degenerate solid proxy`);
    }
    if (!family.placementKinds?.length) violations.push(`family ${family.id} declares no placement context`);
  }
  // A prop that declares no proxy must compile to no blocker at all.
  for (const family of families) {
    const compiled = compileProp(family, { seed: 7 });
    if (!family.solid && (compiled.solidProxy !== null || compiled.blocker)) {
      violations.push(`family ${family.id} blocks the player without an authored proxy`);
    }
    if (family.solid && !compiled.solidProxy?.length) violations.push(`family ${family.id} lost its authored proxy`);
    if (compiled.trigger.derivedFromVisualBoxes) violations.push(`family ${family.id} derives its trigger from visual boxes`);
    if (!(compiled.trigger.radius >= compiled.visualRadius)) {
      violations.push(`family ${family.id} has a trigger tighter than its body`);
    }
  }
  return Object.freeze({
    namespace: GDO_PROP_NAMESPACE,
    ok: violations.length === 0,
    families: families.length,
    ordinary: families.filter(family => family.tier === 'ordinary').length,
    hero: families.filter(family => family.tier === 'hero').length,
    violations: Object.freeze(violations),
  });
}

/** Diagnostics view: the grammar, its caps, and one compiled sample per family. */
export function describePropGrammar({ seed = 0 } = {}) {
  return Object.freeze({
    namespace: GDO_PROP_NAMESPACE,
    families: GDO_PROP_FAMILY_IDS,
    limits: GDO_PROP_LIMITS,
    validation: validatePropFamilies(),
    samples: Object.freeze(Object.fromEntries(GDO_PROP_FAMILIES.map(family => [family.id, compileProp(family, { seed }).counts.boxes]))),
    blocking: GDO_PROP_FAMILIES.filter(family => family.solid).map(family => family.id),
    action: GDO_PROP_INTERACT_ACTION.id,
  });
}
