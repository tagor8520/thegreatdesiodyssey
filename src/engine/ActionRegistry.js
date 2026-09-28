/**
 * `GME-05` / `GME-03` — one shared interaction/action registry.
 *
 * Desktop input, touch buttons, and the debug UI all read this table, so a new
 * gameplay action is declared once and then appears on every surface. The
 * registry also consumes the `FND-08` player-domain descriptor: an action whose
 * declared capability the domain does not implement is skipped deterministically
 * (named in `diagnostics().skipped`) instead of being wired into a control that
 * cannot do anything.
 */

export const GDO_ACTION_NAMESPACE = 'gdo:actionRegistry:v1';

export const GDO_ACTION_KIND = Object.freeze({
  AXIS: 'axis',
  HOLD: 'hold',
  TAP: 'tap',
});

export const GDO_ACTION_SURFACE = Object.freeze({
  KEYBOARD: 'keyboard',
  TOUCH: 'touch',
  POINTER: 'pointer',
});

/** Declared ceilings: over-cap actions are skipped by order, never silently kept. */
export const GDO_ACTION_LIMITS = Object.freeze({
  actions: 16,
  touchButtons: 8,
  keyboardCodes: 32,
});

/**
 * Canonical action set. `capability` names a key of the player-domain
 * capability record, so pruning follows the live domain instead of the device.
 */
export const GDO_DEFAULT_ACTIONS = Object.freeze([
  Object.freeze({
    id: 'move', order: 10, kind: GDO_ACTION_KIND.AXIS, label: 'Move', hint: 'WASD / arrows',
    capability: 'analogInput', keyboard: Object.freeze(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']),
    pointer: null, touch: Object.freeze({ control: 'joystick', label: 'MOVE' }),
  }),
  Object.freeze({
    id: 'look', order: 20, kind: GDO_ACTION_KIND.AXIS, label: 'Look around',
    capability: 'pointerLook', keyboard: Object.freeze([]),
    pointer: 'drag', touch: Object.freeze({ control: 'drag', label: 'DRAG TO LOOK' }),
  }),
  Object.freeze({
    id: 'run', order: 30, kind: GDO_ACTION_KIND.HOLD, label: 'Run', hint: 'Shift',
    capability: 'analogInput', keyboard: Object.freeze(['ShiftLeft', 'ShiftRight']),
    pointer: null, touch: Object.freeze({ control: 'button', label: 'RUN' }),
  }),
  Object.freeze({
    id: 'jump', order: 40, kind: GDO_ACTION_KIND.TAP, label: 'Jump',
    capability: 'jump', keyboard: Object.freeze(['Space']),
    pointer: null, touch: Object.freeze({ control: 'button', label: 'JUMP', className: 'geo-jump' }),
  }),
  Object.freeze({
    id: 'camera', order: 50, kind: GDO_ACTION_KIND.TAP, label: 'Switch camera', hint: 'V / C',
    capability: 'cameraToggle', keyboard: Object.freeze(['KeyC']),
    pointer: null, touch: Object.freeze({ control: 'button', label: 'TPP' }),
  }),
]);

const KINDS = new Set(Object.values(GDO_ACTION_KIND));

/** Human key names, so the help sentence reads like the controls. */
const KEY_NAMES = Object.freeze({
  ArrowUp: '↑', ArrowLeft: '←', ArrowDown: '↓', ArrowRight: '→',
  ShiftLeft: 'Shift', ShiftRight: 'Shift', Space: 'Space', Enter: 'Enter', Escape: 'Esc',
});

export function keyName(code) {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return code;
}

function shortCodes(codes) {
  return [...new Set(codes.map(keyName))].join('/');
}
const TOUCH_CONTROLS = new Set(['joystick', 'drag', 'button']);

function text(value) {
  return String(value ?? '').trim();
}

/**
 * Registry capabilities from an `FND-08` player domain: declared control
 * capabilities plus `cameraToggle`, which follows the declared camera modes.
 */
export function actionCapabilitiesForDomain(domain) {
  const capabilities = domain?.capabilities ?? {};
  return Object.freeze({
    analogInput: Boolean(capabilities.analogInput),
    jump: Boolean(capabilities.jump),
    pointerLook: Boolean(capabilities.pointerLook) || domain?.cameraModes?.length > 1,
    cameraToggle: (domain?.cameraModes?.length ?? 0) > 1,
    interaction: Boolean(capabilities.interaction),
    touch: Boolean(capabilities.touch) || Boolean(capabilities.analogInput),
  });
}

function validate(action, index) {
  if (!action || typeof action !== 'object') throw new TypeError(`Action ${index} must be an object`);
  const id = text(action.id);
  if (!id) throw new TypeError(`Action ${index} needs an id`);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new RangeError(`Action id must be lower kebab case: ${id}`);
  if (!KINDS.has(action.kind)) throw new RangeError(`Action ${id} has unknown kind: ${action.kind}`);
  const label = text(action.label);
  if (!label) throw new TypeError(`Action ${id} needs a label`);
  const touch = action.touch ?? null;
  if (touch && !TOUCH_CONTROLS.has(touch.control)) throw new RangeError(`Action ${id} has unknown touch control: ${touch.control}`);
  if (touch?.control === 'button' && !text(touch.label)) throw new TypeError(`Action ${id} needs a touch button label`);
  const keyboard = [...(action.keyboard ?? [])];
  for (const code of keyboard) if (typeof code !== 'string' || !code) throw new TypeError(`Action ${id} has an invalid key code`);
  const order = Number.isFinite(action.order) ? action.order : (index + 1) * 10;
  return Object.freeze({
    id, order, kind: action.kind, label,
    capability: text(action.capability) || null,
    hint: text(action.hint) || null,
    keyboard: Object.freeze(keyboard),
    pointer: action.pointer ?? null,
    touch: touch ? Object.freeze({ ...touch, label: text(touch.label) || label }) : null,
  });
}

/**
 * `createActionRegistry({ actions, capabilities })`.
 *
 * A declaration is registered when its capability is present and the caps allow
 * it; otherwise it is skipped with a named reason. `seal()` freezes the table so
 * a runtime surface cannot grow mid-frame; `register()` keeps working for tests
 * and future UI code before sealing.
 */
export function createActionRegistry({ actions = GDO_DEFAULT_ACTIONS, capabilities = null, limits = GDO_ACTION_LIMITS } = {}) {
  const registered = [];
  const skipped = [];
  const byId = new Map();
  const keyboardBindings = new Map();
  let sealed = false;

  const add = (action, index) => {
    const descriptor = validate(action, index);
    if (byId.has(descriptor.id)) throw new RangeError(`Duplicate action id: ${descriptor.id}`);
    if (descriptor.capability && capabilities && !capabilities[descriptor.capability]) {
      skipped.push(Object.freeze({ id: descriptor.id, reason: 'capability', capability: descriptor.capability }));
      return descriptor;
    }
    if (registered.length >= limits.actions) {
      skipped.push(Object.freeze({ id: descriptor.id, reason: 'cap' }));
      return descriptor;
    }
    const touchButtons = registered.filter(entry => entry.touch?.control === 'button').length;
    const wantsButton = descriptor.touch?.control === 'button';
    const overflowButton = wantsButton && touchButtons >= limits.touchButtons;
    const keyboardCodes = [...keyboardBindings.keys()].length;
    const overflowing = descriptor.keyboard.some(code => !keyboardBindings.has(code)) &&
      keyboardCodes + descriptor.keyboard.filter(code => !keyboardBindings.has(code)).length > limits.keyboardCodes;
    // An action keeps whatever surfaces the caps allow; one that keeps none is
    // skipped instead of being registered as a control that cannot be reached.
    const losesKeyboard = overflowing && descriptor.keyboard.length > 0;
    const losesTouch = overflowButton && descriptor.touch?.control === 'button';
    if (losesKeyboard) skipped.push(Object.freeze({ id: descriptor.id, reason: 'keyboard-cap' }));
    if (losesTouch) skipped.push(Object.freeze({ id: descriptor.id, reason: 'touch-cap' }));
    if (losesKeyboard && losesTouch) return descriptor;
    const effective = losesKeyboard || losesTouch
      ? Object.freeze({ ...descriptor, touch: losesTouch ? null : descriptor.touch, keyboard: losesKeyboard ? Object.freeze([]) : descriptor.keyboard })
      : descriptor;
    registered.push(effective);
    byId.set(effective.id, effective);
    for (const code of effective.keyboard) if (!keyboardBindings.has(code)) keyboardBindings.set(code, effective.id);
    return effective;
  };

  for (const [index, action] of [...actions].entries()) add(action, index);
  registered.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  return {
    namespace: GDO_ACTION_NAMESPACE,
    limits,
    /** Register one more action (a plugin, a future gameplay verb, a test). */
    register(action) {
      if (sealed) throw new Error('Action registry is sealed');
      return add(action, registered.length + skipped.length);
    },
    seal() { sealed = true; return this; },
    get sealed() { return sealed; },
    actions() { return Object.freeze([...registered]); },
    action(id) { return byId.get(text(id)) ?? null; },
    has(id) { return byId.has(text(id)); },
    /**
     * Every keyboard code any registered action owns, in declared action order,
     * so the table is reproducible regardless of registration order.
     */
    keyboardCodes() {
      const codes = [];
      for (const action of registered) for (const code of action.keyboard) if (!codes.includes(code)) codes.push(code);
      return Object.freeze(codes);
    },
    keyboardBinding(code) { return keyboardBindings.get(code) ?? null; },
    handlesKey(code) { return keyboardBindings.has(code); },
    /** Declared pointer gestures, e.g. one `drag` for the look action. */
    pointerGestures() { return Object.freeze([...new Set(registered.map(action => action.pointer).filter(Boolean))]); },
    /** Touch controls, in declared order, for the on-screen pad. */
    touchControls() {
      return Object.freeze(registered
        .filter(action => action.touch)
        .map(action => Object.freeze({
          id: action.id, kind: action.kind, label: action.label,
          control: action.touch.control, text: action.touch.label,
          className: action.touch.className ?? null, order: action.order,
        })));
    },
    /**
     * The keyboard help sentence, derived from the table: a future action with a
     * keyboard binding appears here without editing the markup that shows it.
     */
    keyboardHint() {
      return registered
        .filter(action => action.keyboard.length)
        .map(action => `${action.hint ?? shortCodes(action.keyboard)}: ${action.label.toLowerCase()}`)
        .join(' · ');
    },
    /** The pointer help text, derived the same way. */
    pointerHint() {
      return registered
        .filter(action => action.pointer)
        .map(action => `${action.pointer === 'drag' ? 'Drag' : action.pointer}: ${action.label.toLowerCase()}`)
        .join(' · ');
    },
    /** Declared surfaces for every registered action: desktop, touch, pointer. */
    surfaces() {
      return Object.freeze(registered.map(action => Object.freeze({
        id: action.id,
        keyboard: action.keyboard,
        pointer: action.pointer,
        touch: action.touch?.control ?? null,
      })));
    },
    diagnostics() {
      return Object.freeze({
        namespace: GDO_ACTION_NAMESPACE,
        declared: actions.length,
        registered: registered.length,
        skipped: Object.freeze([...skipped]),
        keyboardCodes: keyboardBindings.size,
        touchButtons: registered.filter(action => action.touch?.control === 'button').length,
        limits,
        sealed,
      });
    },
  };
}
