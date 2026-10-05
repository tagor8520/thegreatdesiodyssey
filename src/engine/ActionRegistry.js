/**
 * The shared gameplay action registry (`GME-05`).
 *
 * Before this module, an action existed only as a call site. Coordinate mode
 * wrote `held('right', 'KeyD', 'ArrowRight')` and listed its touch buttons in an
 * HTML string; the curated mode repeated the same key codes in a second
 * `if (!['KeyW', …].includes(event.code)) return;` guard and had **no touch
 * controls at all**, so the curated runtime could not be played on a phone. The
 * markup vocabulary (`data-hold-action`, `data-tap-action`) hinted at a registry
 * without there being one: nothing enumerated the actions, so nothing could say
 * whether a surface had missed one.
 *
 * This module is that enumeration. Each action is declared once with the
 * surfaces it is exposed on, and every consumer — keyboard handling in both
 * players, the touch layer in both runtimes, and the audit gate — reads the same
 * declaration. A surface that misses an action is then a failing assertion
 * instead of an oversight nobody can see.
 *
 * It imports nothing, so the Node gate and the browser gate can both load it,
 * and so `ActionInput` stays testable with a plain `EventTarget`.
 */

/** Runtime identifiers used by the registry and the mount handles. */
export const ACTION_RUNTIMES = Object.freeze(['curated', 'coordinates']);

/** The surfaces an action can be exposed on. */
export const ACTION_SURFACES = Object.freeze(['keyboard', 'touch', 'ui']);

/**
 * `hold` actions are active while the input is down. `tap` actions fire once on
 * press and ignore auto-repeat — the distinction that, when it was implicit, had
 * to be re-implemented at each call site.
 */
export const ACTION_KINDS = Object.freeze(['hold', 'tap']);

const both = ['curated', 'coordinates'];

/**
 * The canonical action set. `id` is the canonical name used by every surface;
 * `codes` are `KeyboardEvent.code` values; `runtimes` says which modes the action
 * exists in; `surfaces` says where a player can reach it; `touch` describes the
 * control the runtime must render for it.
 */
export const GAMEPLAY_ACTIONS = Object.freeze({
  forward: {
    label: 'Move forward', kind: 'hold', codes: ['KeyW', 'ArrowUp'],
    runtimes: both, surfaces: ['keyboard', 'touch'],
    touch: { control: 'joystick' }, group: 'locomotion',
  },
  back: {
    label: 'Move back', kind: 'hold', codes: ['KeyS', 'ArrowDown'],
    runtimes: both, surfaces: ['keyboard', 'touch'],
    touch: { control: 'joystick' }, group: 'locomotion',
  },
  left: {
    label: 'Move left', kind: 'hold', codes: ['KeyA', 'ArrowLeft'],
    runtimes: both, surfaces: ['keyboard', 'touch'],
    touch: { control: 'joystick' }, group: 'locomotion',
  },
  right: {
    label: 'Move right', kind: 'hold', codes: ['KeyD', 'ArrowRight'],
    runtimes: both, surfaces: ['keyboard', 'touch'],
    touch: { control: 'joystick' }, group: 'locomotion',
  },
  run: {
    label: 'Run', kind: 'hold', codes: ['ShiftLeft', 'ShiftRight'],
    runtimes: both, surfaces: ['keyboard', 'touch'],
    touch: { control: 'button', text: 'RUN', grid: '2 / 1', size: 52 }, group: 'locomotion',
  },
  jump: {
    label: 'Jump', kind: 'tap', codes: ['Space'],
    runtimes: both, surfaces: ['keyboard', 'touch'],
    touch: { control: 'button', text: 'JUMP', grid: '1 / 2 / 3 / 3', size: 72 }, group: 'locomotion',
  },
  camera: {
    label: 'First/third-person camera', kind: 'tap', codes: ['KeyV', 'KeyC'],
    runtimes: ['coordinates'], surfaces: ['keyboard', 'touch'],
    touch: { control: 'button', text: 'TPP', grid: '1 / 1', size: 46 }, group: 'view',
  },
  map: {
    label: 'Map mode', kind: 'tap', codes: ['KeyM'],
    runtimes: ['curated'], surfaces: ['keyboard', 'touch'],
    touch: { control: 'button', text: 'MAP', grid: '1 / 1', size: 46 }, group: 'view',
  },
  debug: {
    label: 'Debug overlay', kind: 'tap', codes: ['F3'],
    runtimes: ['coordinates'], surfaces: ['keyboard'], group: 'diagnostics',
  },
  selectSlot1: {
    label: 'Select food slot 1', kind: 'tap', codes: ['Digit1'],
    runtimes: ['curated'], surfaces: ['keyboard', 'ui'], group: 'inventory', slot: 0,
  },
  selectSlot2: {
    label: 'Select food slot 2', kind: 'tap', codes: ['Digit2'],
    runtimes: ['curated'], surfaces: ['keyboard', 'ui'], group: 'inventory', slot: 1,
  },
  selectSlot3: {
    label: 'Select food slot 3', kind: 'tap', codes: ['Digit3'],
    runtimes: ['curated'], surfaces: ['keyboard', 'ui'], group: 'inventory', slot: 2,
  },
});

export const REGISTERED_ACTIONS = Object.freeze(Object.keys(GAMEPLAY_ACTIONS));

/**
 * What each runtime must expose before a player can play it. `locomotion` is the
 * floor: a runtime that cannot move, run and jump on the surface in question is
 * not playable there. This is the half of the gate that would have caught the
 * curated runtime having no touch controls.
 */
export const REQUIRED_ACTION_GROUPS = Object.freeze({
  curated: Object.freeze({ keyboard: ['locomotion'], touch: ['locomotion', 'view'] }),
  coordinates: Object.freeze({ keyboard: ['locomotion', 'view', 'diagnostics'], touch: ['locomotion', 'view'] }),
});

export class ActionRegistryError extends TypeError {
  constructor(message) { super(message); this.name = 'ActionRegistryError'; }
}

export function actionDefinition(action) {
  const definition = GAMEPLAY_ACTIONS[action];
  if (!definition) throw new ActionRegistryError(`Unknown gameplay action: ${JSON.stringify(action)}`);
  return definition;
}

export function isRegisteredAction(action) {
  return typeof action === 'string' && Object.hasOwn(GAMEPLAY_ACTIONS, action);
}

export function codesFor(action) { return actionDefinition(action).codes; }

export function isHold(action) { return actionDefinition(action).kind === 'hold'; }
export function isTap(action) { return actionDefinition(action).kind === 'tap'; }

export function actionsForRuntime(runtime) {
  if (!ACTION_RUNTIMES.includes(runtime)) throw new ActionRegistryError(`Unknown runtime: ${JSON.stringify(runtime)}`);
  return REGISTERED_ACTIONS.filter(action => GAMEPLAY_ACTIONS[action].runtimes.includes(runtime));
}

/**
 * The zero-based slot an inventory action selects, or `-1`.
 *
 * The inventory keys and the inventory buttons are the same three actions, so the
 * one place that knows `selectSlot2` means slot 1 is here — not in the player, the
 * React component and the stylesheet separately.
 */
export function slotForAction(action) {
  const slot = GAMEPLAY_ACTIONS[action]?.slot;
  return Number.isInteger(slot) ? slot : -1;
}

/** The markup selector for an action's `ui` control, or `null` if it has none. */
export function uiSelector(action) {
  return slotForAction(action) >= 0 ? `[data-slot="${slotForAction(action) + 1}"]` : null;
}

export function actionsForSurface(runtime, surface) {
  if (!ACTION_SURFACES.includes(surface)) throw new ActionRegistryError(`Unknown surface: ${JSON.stringify(surface)}`);
  return actionsForRuntime(runtime).filter(action => GAMEPLAY_ACTIONS[action].surfaces.includes(surface));
}

/** Actions this runtime must render a touch control for, in declaration order. */
export function touchActionsForRuntime(runtime) {
  return actionsForSurface(runtime, 'touch');
}

/**
 * Resolve a keyboard code to an action **within one runtime**. Codes are only
 * unique per runtime, which is the point: `KeyM` is map mode in curated and
 * nothing at all in coordinate mode, so a global lookup would be wrong.
 */
export function actionForCode(code, runtime) {
  if (typeof code !== 'string') return null;
  for (const action of actionsForRuntime(runtime)) {
    if (GAMEPLAY_ACTIONS[action].codes.includes(code)) return action;
  }
  return null;
}

/** Every code a runtime binds, mapped to its action. Used by the gate. */
export function codeMapForRuntime(runtime) {
  const map = new Map();
  for (const action of actionsForRuntime(runtime)) {
    for (const code of GAMEPLAY_ACTIONS[action].codes) map.set(code, action);
  }
  return map;
}

/** A report for docs, diagnostics and the gate; never throws. */
export function describeRegistry() {
  return {
    actions: REGISTERED_ACTIONS.length,
    entries: REGISTERED_ACTIONS.map(action => {
      const definition = GAMEPLAY_ACTIONS[action];
      return {
        action,
        label: definition.label,
        kind: definition.kind,
        codes: [...definition.codes],
        runtimes: [...definition.runtimes],
        surfaces: [...definition.surfaces],
        group: definition.group,
        touchControl: definition.touch?.control ?? null,
      };
    }),
    runtimes: ACTION_RUNTIMES.map(runtime => ({
      runtime,
      actions: actionsForRuntime(runtime),
      keyboard: actionsForSurface(runtime, 'keyboard'),
      touch: touchActionsForRuntime(runtime),
      ui: actionsForSurface(runtime, 'ui'),
    })),
  };
}

function registryProblems() {
  const problems = [];
  for (const [action, definition] of Object.entries(GAMEPLAY_ACTIONS)) {
    if (!definition.label) problems.push(`${action} has no label`);
    if (!ACTION_KINDS.includes(definition.kind)) problems.push(`${action} has kind ${JSON.stringify(definition.kind)}, expected one of ${ACTION_KINDS.join(', ')}`);
    if (!Array.isArray(definition.codes) || definition.codes.length === 0) problems.push(`${action} binds no keyboard codes, so desktop cannot reach every action`);
    if (!Array.isArray(definition.runtimes) || definition.runtimes.length === 0) problems.push(`${action} declares no runtime`);
    if (!Array.isArray(definition.surfaces) || definition.surfaces.length === 0) problems.push(`${action} declares no surface`);
    for (const runtime of definition.runtimes ?? []) {
      if (!ACTION_RUNTIMES.includes(runtime)) problems.push(`${action} names unknown runtime ${JSON.stringify(runtime)}`);
    }
    for (const surface of definition.surfaces ?? []) {
      if (!ACTION_SURFACES.includes(surface)) problems.push(`${action} names unknown surface ${JSON.stringify(surface)}`);
    }
    // A surface that cannot reach an action must not claim it.
    if (definition.surfaces?.includes('keyboard') && !(definition.codes?.length > 0)) {
      problems.push(`${action} claims the keyboard surface without binding a code`);
    }
    if (definition.surfaces?.includes('touch') && !definition.touch) {
      problems.push(`${action} claims the touch surface without declaring a touch control`);
    }
    if (definition.touch && !definition.surfaces?.includes('touch')) {
      problems.push(`${action} declares a touch control but not the touch surface`);
    }
    if (definition.touch?.control === 'button' && !definition.touch.text) {
      problems.push(`${action} wants a touch button with no label text`);
    }
    if (definition.touch?.control === 'button' && !definition.touch.grid) {
      problems.push(`${action} wants a touch button with no grid placement, so it would land wherever the browser puts it`);
    }
    // The size used to be left to the stylesheet, and the first version rendered
    // RUN and MAP 15px tall on a 390px phone — visible only in a phone-shaped
    // browser, where a 15px target is unusable. Declaring it here means the floor
    // is checked in Node, not discovered by a player.
    if (definition.touch?.control === 'button' && !definition.touch.size) {
      problems.push(`${action} wants a touch button with no size, so its hit target is whatever the stylesheet does`);
    }
    if (definition.touch?.size !== undefined && (!Number.isFinite(definition.touch.size) || definition.touch.size < 44)) {
      problems.push(`${action} declares a ${definition.touch.size}px touch button, below the 44px minimum touch target`);
    }
    // `ui` is a surface like any other: claiming it without a slot is claiming a
    // control that cannot be found in the DOM.
    if (definition.surfaces?.includes('ui') && slotForAction(action) < 0) {
      problems.push(`${action} claims the ui surface without a slot`);
    }
    if (slotForAction(action) >= 0 && !definition.surfaces?.includes('ui')) {
      problems.push(`${action} declares slot ${slotForAction(action)} but not the ui surface`);
    }
  }
  // A code bound to two actions in one runtime is ambiguous, and the loser is
  // silent: whichever action the loop reaches first wins and the other action
  // becomes unreachable from the keyboard with no error anywhere.
  for (const runtime of ACTION_RUNTIMES) {
    const owners = new Map();
    for (const action of actionsForRuntime(runtime)) {
      for (const code of GAMEPLAY_ACTIONS[action].codes) {
        if (owners.has(code)) problems.push(`runtime ${runtime} binds ${code} to both ${owners.get(code)} and ${action}`);
        else owners.set(code, action);
      }
    }
  }
  // Every declared runtime must be playable on every surface it declares.
  for (const runtime of ACTION_RUNTIMES) {
    for (const [surface, groups] of Object.entries(REQUIRED_ACTION_GROUPS[runtime] ?? {})) {
      for (const group of groups) {
        const covered = actionsForSurface(runtime, surface).some(action => GAMEPLAY_ACTIONS[action].group === group);
        if (!covered) problems.push(`runtime ${runtime} exposes no ${group} action on the ${surface} surface`);
      }
    }
  }
  // Two actions claiming one slot in one runtime would leave one of them
  // unselectable — the same failure as the touch grid collision, one surface over.
  for (const runtime of ACTION_RUNTIMES) {
    const slots = new Map();
    for (const action of actionsForRuntime(runtime)) {
      const slot = slotForAction(action);
      if (slot < 0) continue;
      if (slots.has(slot)) problems.push(`runtime ${runtime} gives ${slots.get(slot)} and ${action} the same ui slot (${slot})`);
      else slots.set(slot, action);
    }
  }
  // Two touch buttons in one grid cell means one of them is unreachable behind
  // the other — invisible in code, obvious only when a player cannot press it.
  for (const runtime of ACTION_RUNTIMES) {
    const cells = new Map();
    for (const action of touchActionsForRuntime(runtime)) {
      const grid = GAMEPLAY_ACTIONS[action].touch?.grid;
      if (!grid) continue;
      if (cells.has(grid)) problems.push(`runtime ${runtime} places ${cells.get(grid)} and ${action} in the same touch grid cell (${grid})`);
      else cells.set(grid, action);
    }
  }
  return problems;
}

/** Throw unless the registry is internally consistent. */
export function assertActionRegistry() {
  const problems = registryProblems();
  if (problems.length) {
    throw new ActionRegistryError(`The action registry is inconsistent: ${problems.join('; ')}`);
  }
  return true;
}

/** Throws unless the action exists and belongs to this runtime. */
export function requireRuntimeAction(action, runtime) {
  const definition = actionDefinition(action);
  if (!definition.runtimes.includes(runtime)) {
    throw new ActionRegistryError(`Action ${JSON.stringify(action)} does not exist in the ${runtime} runtime`);
  }
  return definition;
}

const IGNORE_SELECTOR = 'input,textarea,select,[contenteditable="true"]';

/**
 * Keyboard and synthetic input for one runtime, driven by the registry.
 *
 * The class owns its listeners so a runtime can hand it a target and dispose it
 * as one object (`FND-07` counts listeners, and a handler that cannot be removed
 * is the defect that gate exists for). It exposes `keys` as the raw code set so
 * existing callers and tests that add codes directly keep working — those codes
 * are still resolved through the registry, so a direct `keys.add('KeyD')` is
 * exactly as legitimate as a real keypress.
 */
export class ActionInput {
  constructor({
    runtime,
    target = globalThis.window,
    onAction = null,
    /** Extra client-side veto, e.g. a disabled player. */
    shouldIgnore = null,
    /** Runs after a blur clears input, so an owner can reset velocity and the like. */
    onBlur = null,
    document = globalThis.document,
  } = {}) {
    if (!ACTION_RUNTIMES.includes(runtime)) throw new ActionRegistryError(`Unknown runtime: ${JSON.stringify(runtime)}`);
    assertActionRegistry();
    this.runtime = runtime;
    this.target = target;
    this.document = document;
    this.onAction = onAction;
    this.shouldIgnore = shouldIgnore;
    this.onBlur = onBlur;
    this.keys = new Set();
    this.virtual = new Set();
    this.disposed = false;
    this.diagnostics = { keydowns: 0, actionsFired: 0, ignored: 0, unknownCodes: 0 };

    this.keydown = event => this.handleKeydown(event);
    this.keyup = event => { if (this.keys.delete(event.code)) this.diagnostics.keydowns && void 0; };
    // Clearing input is this object's job; resetting the *rest* of a runtime's
    // state on blur is the owner's, so the owner gets told rather than having to
    // register a second blur listener that could drift away from this one.
    this.blur = () => { this.clear(); this.onBlur?.(); };
    target?.addEventListener?.('keydown', this.keydown);
    target?.addEventListener?.('keyup', this.keyup);
    target?.addEventListener?.('blur', this.blur);
  }

  /**
   * Resolve one key event.
   *
   * The code is looked up **before** the veto, so the counters mean different
   * things and stay useful: `unknownCodes` counts keys this runtime does not bind
   * (including keys meant for the other mode), while `ignored` counts presses of
   * this runtime's own actions that arrived while the runtime was not accepting
   * input — the "game is paused" case. Checking the veto first would have lumped
   * the two together and made the number unactionable.
   *
   * @returns {boolean} true when this runtime consumed the event. A recognised
   * action that was vetoed returns false, because nothing happened as a result.
   */
  handleKeydown(event) {
    if (this.disposed) return false;
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.target?.closest?.(IGNORE_SELECTOR)) return false;
    const action = actionForCode(event.code, this.runtime);
    if (!action) { this.diagnostics.unknownCodes++; return false; }
    if (this.shouldIgnore?.()) { this.diagnostics.ignored++; return false; }
    this.diagnostics.keydowns++;
    event.preventDefault?.();
    if (isTap(action)) {
      if (!event.repeat) this.fire(action);
      return true;
    }
    this.keys.add(event.code);
    return true;
  }

  handleKeyup(event) { if (this.disposed) return false; return this.keys.delete(event.code); }

  /** Fire a tap action's handler. Protected so tests can assert the plumbing. */
  fire(action) { this.diagnostics.actionsFired++; this.onAction?.(action, actionDefinition(action)); return true; }

  /** True while the action is held, from either the keyboard or a touch control. */
  active(action) {
    if (!isRegisteredAction(action)) return false;
    if (this.virtual.has(action)) return true;
    const codes = codesFor(action);
    for (const code of codes) if (this.keys.has(code)) return true;
    return false;
  }

  /**
   * Touch or UI input for an action. Tap actions fire immediately; hold actions
   * stay active until released. Unknown or runtime-foreign actions are rejected
   * rather than silently ignored, because a control wired to a misnamed action
   * is exactly the failure this registry exists to make visible.
   */
  setVirtual(action, active) {
    const definition = requireRuntimeAction(action, this.runtime);
    if (definition.kind === 'tap') {
      // A tap fires and is done. Putting it in the held set would make
      // `active('jump')` true forever after one press, which is exactly what the
      // first version of this method did — and what the gate caught.
      if (active) this.fire(action);
      else this.virtual.delete(action);
      return this;
    }
    if (active) this.virtual.add(action);
    else this.virtual.delete(action);
    return this;
  }

  /** Analogue movement from a joystick, in the range [-1, 1]. */
  setAnalog(x, z) { this.analog ??= { x: 0, z: 0 }; this.analog.x = x; this.analog.z = z; return this; }

  clear() {
    this.keys.clear();
    this.virtual.clear();
    if (this.analog) { this.analog.x = 0; this.analog.z = 0; }
  }

  /** Snapshot for diagnostics and the audit bridge. */
  snapshot() {
    return {
      runtime: this.runtime,
      held: this.keys.size,
      virtual: [...this.virtual],
      analog: this.analog ? { x: this.analog.x, z: this.analog.z } : null,
      diagnostics: { ...this.diagnostics },
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.target?.removeEventListener?.('keydown', this.keydown);
    this.target?.removeEventListener?.('keyup', this.keyup);
    this.target?.removeEventListener?.('blur', this.blur);
  }
}
