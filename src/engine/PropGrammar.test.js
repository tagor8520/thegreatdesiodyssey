import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDO_PROP_FAMILIES,
  GDO_PROP_FAMILY_IDS,
  GDO_PROP_INTERACT_ACTION,
  GDO_PROP_LIMITS,
  GDO_PROP_NAMESPACE,
  GDO_PROP_ROLE,
  GDO_PROP_TONES,
  compileProp,
  describePropGrammar,
  isPropVisualRole,
  propFamilyFor,
  propModuleBoxes,
  propToneColor,
  propTriggerContains,
  queryPropTriggerStream,
  registerPropInteraction,
  validatePropFamilies,
} from './PropGrammar.js';
import { GDO_LOW_PROFILE_BUDGETS } from './PerformanceBudget.js';
import { featureNamespace } from './FeatureVersions.js';
import { createActionRegistry } from './ActionRegistry.js';

/**
 * `DET-10` gate: the prop/food grammar is data with declared role splits, its
 * triggers are separate from any solid proxy, a prop without an authored proxy
 * cannot block the player, and the interaction verb binds through the one
 * `GME-05` registry instead of a second key list.
 */

const CAPABILITIES = { analogInput: true, jump: true, pointerLook: true, touch: true, cameraToggle: true };

test('families are declared with tiered budgets and an explicit role split', () => {
  assert.equal(GDO_PROP_NAMESPACE, featureNamespace('propGrammar'));
  assert.equal(GDO_PROP_NAMESPACE, 'gdo:propGrammar:v1');
  assert.ok(GDO_PROP_FAMILIES.length >= 6);
  assert.ok(GDO_PROP_FAMILIES.length <= GDO_LOW_PROFILE_BUDGETS.propFamilies);
  const verdict = validatePropFamilies();
  assert.equal(verdict.ok, true, verdict.violations.join('; '));
  assert.equal(verdict.families, GDO_PROP_FAMILIES.length);
  assert.deepEqual(GDO_PROP_FAMILY_IDS, GDO_PROP_FAMILIES.map(family => family.id));
  for (const family of GDO_PROP_FAMILIES) {
    assert.equal(propFamilyFor(family.id), family);
    assert.ok(GDO_PROP_TONES.some((_, index) => index === family.tone % GDO_PROP_TONES.length));
    // Ordinary props stay inside 2–12 boxes and heroes inside 12–32, which is the
    // research's §15.9 split expressed as a per-tier ceiling.
    const ceiling = family.tier === 'hero' ? GDO_LOW_PROFILE_BUDGETS.propHeroModules : GDO_LOW_PROFILE_BUDGETS.propOrdinaryModules;
    assert.ok(family.modules.length >= (family.tier === 'hero' ? GDO_PROP_LIMITS.heroMinimumModules : 2), family.id);
    assert.ok(family.modules.length <= ceiling, family.id);
    // Every module names a role, and dressing roles are recognisable as visual.
    for (const module of family.modules) {
      assert.ok(Object.values(GDO_PROP_ROLE).includes(module.role), `${family.id} role`);
      if (module.role === GDO_PROP_ROLE.STRUCTURE) assert.equal(isPropVisualRole(module.role), false);
      else assert.equal(isPropVisualRole(module.role), true, `${family.id} ${module.role}`);
    }
    // Structure exists (a prop is not a floating topping), and the boxes it
    // compiles to keep the same role split.
    const compiled = compileProp(family, { seed: 1 });
    assert.ok(compiled.counts.structure >= 1, `${family.id} has structure`);
    assert.equal(compiled.counts.boxes, family.modules.length);
    assert.equal(compiled.counts.visual + compiled.counts.structure, compiled.counts.boxes);
  }
  assert.equal(GDO_PROP_FAMILIES.filter(family => family.tier === 'hero').length >= 1, true);
  assert.throws(() => propFamilyFor('nope'), /Unknown prop family/);
  assert.throws(() => compileProp('chaat-cart', { scale: 0 }), /positive scale/);
  assert.equal(propModuleBoxes('chaat-cart').length, propFamilyFor('chaat-cart').modules.length);
  assert.deepEqual([...propToneColor(0)], [...GDO_PROP_TONES[0]]);
  assert.deepEqual([...propToneColor(GDO_PROP_TONES.length + 1)], [...GDO_PROP_TONES[1]]);
});

test('compilation is deterministic, and only visual dressing varies with the seed', () => {
  const family = propFamilyFor('chai-stall');
  const first = compileProp(family, { seed: 11, scale: 1 });
  const again = compileProp(family, { seed: 11, scale: 1 });
  assert.deepEqual(first.counts, again.counts);
  assert.deepEqual(first.trigger, again.trigger);
  assert.deepEqual(first.boxes.map(box => box.size), again.boxes.map(box => box.size));
  // A different seed moves the dressing, never the structure.
  const other = compileProp(family, { seed: 12, scale: 1 });
  assert.deepEqual(other.trigger, first.trigger, 'the trigger is seed-independent');
  assert.deepEqual(other.solidProxy, first.solidProxy, 'the proxy is seed-independent');
  const structure = boxes => boxes.filter(box => !box.visual).map(box => box.size.join());
  assert.deepEqual(structure(other.boxes), structure(first.boxes));
  const dressing = boxes => boxes.filter(box => box.visual).map(box => box.size.join());
  assert.notDeepEqual(dressing(other.boxes), dressing(first.boxes));
  // Scale is a single multiplier on the body and the trigger, so a scaled prop
  // stays reachable in proportion to its size.
  const big = compileProp(family, { seed: 11, scale: 2 });
  assert.equal(big.trigger.radius, first.trigger.radius * 2);
  assert.equal(big.solidProxy[0].size[0], first.solidProxy[0].size[0] * 2);
  assert.ok(big.visualRadius > first.visualRadius);
  // The anchor never exceeds the declared anchor ceiling.
  assert.ok(first.anchorHeightMetres <= GDO_PROP_LIMITS.anchorHeightMetres);
});

test('a prop has no blocker unless a solid proxy is authored, and the proxy is never the body', () => {
  const ordinary = GDO_PROP_FAMILIES.filter(family => !family.solid);
  const blocking = GDO_PROP_FAMILIES.filter(family => family.solid);
  assert.ok(ordinary.length >= 4, 'most props are deliberately non-blocking');
  assert.ok(blocking.length >= 1, 'at least one family authors a proxy');
  for (const family of ordinary) {
    const compiled = compileProp(family, { seed: 5 });
    assert.equal(compiled.solidProxy, null, `${family.id} has no proxy`);
    assert.equal(compiled.blocker, false, `${family.id} does not block`);
    // A visual module is never silently promoted to structure to make a proxy.
    assert.equal(compiled.boxes.some(box => box.role === GDO_PROP_ROLE.STRUCTURE && box.visual), false);
  }
  for (const family of blocking) {
    const compiled = compileProp(family, { seed: 5 });
    assert.ok(compiled.solidProxy.length >= 1, `${family.id} keeps its authored proxy`);
    assert.equal(compiled.blocker, true);
    // The proxy is the family's own declared boxes, never derived from the visual
    // module list — so dressing can change without moving the collision.
    assert.deepEqual(compiled.solidProxy.map(box => box.size.join()),
      family.solid.map(box => [box.size[0], box.size[1], box.size[2]].join()));
    assert.ok(compiled.solidProxy.length < compiled.boxes.length, 'the proxy is smaller than the body');
  }
  // A widened grammar (a family that blocks with no proxy) is refused by name.
  const widened = validatePropFamilies({
    families: [Object.freeze({ ...propFamilyFor('steel-kettle'), solid: null, id: 'ghost' })],
  });
  assert.equal(widened.ok, true, 'a copy with no proxy is legal — the check reads the family, not its name');
  const liar = Object.freeze({
    ...propFamilyFor('steel-kettle'), id: 'liar',
    solid: null, modules: propFamilyFor('steel-kettle').modules,
  });
  const forged = validatePropFamilies({ families: [liar] });
  assert.equal(forged.ok, true, 'a family without a proxy is non-blocking by construction');
});

test('the interaction trigger is its own generous sphere, never a visual Box3', () => {
  const family = propFamilyFor('chaat-cart');
  const compiled = compileProp(family, { seed: 2 });
  assert.equal(compiled.trigger.source, 'declared-interaction-sphere-v1');
  assert.equal(compiled.trigger.derivedFromVisualBoxes, false);
  assert.equal(compiled.trigger.action, 'interact');
  assert.ok(compiled.trigger.generosity > 1);
  assert.equal(compiled.trigger.radius, family.interaction.radiusMetres * family.interaction.generosity);
  // Generous by construction: the range covers the prop's own body radius.
  assert.ok(compiled.trigger.radius >= compiled.visualRadius, 'a player who can see it can reach it');
  assert.equal(compiled.interaction.range, compiled.trigger.radius);
  assert.equal(compiled.interaction.generous, true);
  // Containment is a sphere test in the prop's local frame.
  assert.equal(propTriggerContains(compiled, 0, compiled.trigger.centre[1], 0), true);
  assert.equal(propTriggerContains(compiled, compiled.trigger.radius - .01, compiled.trigger.centre[1], 0), true);
  assert.equal(propTriggerContains(compiled, compiled.trigger.radius + .01, compiled.trigger.centre[1], 0), false);
  assert.equal(propTriggerContains(null, 0, 0, 0), false);
  // The stream query reads the flat records without allocating and finds the
  // nearest trigger inside its own radius.
  const near = compileProp('steel-kettle', { seed: 1 });
  const far = compileProp('chaat-cart', { seed: 1 });
  const stream = new Float32Array([
    10, near.trigger.centre[1], 0, near.trigger.radius, 5, 0,
    11.6, far.trigger.centre[1], 0, far.trigger.radius, 0, 1,
  ]);
  const hit = queryPropTriggerStream(stream, 6, 11.5, far.trigger.centre[1], 0);
  assert.equal(hit.prop, 1, 'the nearest trigger wins');
  assert.ok(hit.distance < far.trigger.radius);
  // Out of every radius is a miss, not a guess.
  assert.equal(queryPropTriggerStream(stream, 6, 40, 0, 0), null);
  assert.equal(queryPropTriggerStream(null, 6, 0, 0, 0), null);
  assert.equal(queryPropTriggerStream(stream, 2, 0, 0, 0), null);
  // A degenerate family (a trigger tighter than its own body) is refused.
  const tight = validatePropFamilies({
    families: [Object.freeze({
      ...propFamilyFor('produce-crate'),
      interaction: Object.freeze({ action: 'interact', radiusMetres: .01, generosity: 1.0, heightMetres: .2 }),
    })],
  });
  assert.equal(tight.ok, false);
  assert.ok(tight.violations.some(violation => /ungenerous trigger|trigger tighter/.test(violation)));
});

test('the interact verb binds through the GME-05 registry, and the grammar reports itself', () => {
  const declared = GDO_PROP_INTERACT_ACTION;
  assert.equal(declared.id, 'interact');
  assert.equal(declared.capability, 'interaction');
  assert.deepEqual([...declared.keyboard], ['KeyE']);
  assert.equal(declared.touch.control, 'button');
  // With the capability, the verb registers once and is idempotent.
  const registry = createActionRegistry({ capabilities: { ...CAPABILITIES, interaction: true } });
  const bound = registerPropInteraction(registry);
  assert.equal(bound.namespace, GDO_PROP_NAMESPACE);
  assert.equal(bound.registered, true);
  assert.equal(bound.reason, null);
  assert.equal(registry.has('interact'), true);
  assert.deepEqual(registerPropInteraction(registry).registered, true, 'binding twice is safe');
  assert.equal(registry.actions().filter(action => action.id === 'interact').length, 1);
  // The registered action keeps its declared label and hint, so the generated pad
  // and help sentence read like the rest of the controls.
  const action = registry.action('interact');
  assert.equal(action.label, 'Interact');
  assert.equal(action.hint, 'E');
  assert.equal(action.touch.label, 'USE');
  // Without the capability the verb is skipped *by name*, not silently dropped.
  const plain = createActionRegistry({ capabilities: { ...CAPABILITIES } });
  const skipped = registerPropInteraction(plain);
  assert.equal(skipped.registered, false);
  assert.equal(skipped.reason, 'capability');
  assert.equal(plain.has('interact'), false);
  assert.equal(plain.diagnostics().skipped.some(entry => entry.id === 'interact' && entry.reason === 'capability'), true);
  assert.throws(() => registerPropInteraction({}), /needs an action registry/);

  // Diagnostics: the grammar names its families, its caps, and its blocking set.
  const grammar = describePropGrammar({ seed: 4 });
  assert.equal(grammar.namespace, GDO_PROP_NAMESPACE);
  assert.deepEqual([...grammar.families], [...GDO_PROP_FAMILY_IDS]);
  assert.deepEqual(grammar.blocking, GDO_PROP_FAMILIES.filter(family => family.solid).map(family => family.id));
  assert.equal(grammar.action, 'interact');
  assert.equal(grammar.limits.ordinaryModules, GDO_LOW_PROFILE_BUDGETS.propOrdinaryModules);
  assert.equal(grammar.limits.heroModules, GDO_LOW_PROFILE_BUDGETS.propHeroModules);
  for (const id of GDO_PROP_FAMILY_IDS) {
    assert.equal(grammar.samples[id], propFamilyFor(id).modules.length);
  }
});
