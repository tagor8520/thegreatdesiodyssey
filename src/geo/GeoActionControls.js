/**
 * `GME-03` / `GME-05` — the touch pad is generated from the shared action
 * registry, so a newly registered action appears on the device surface (and in
 * the keyboard filter) without another hand-written button.
 */

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Pure markup for the registry's touch controls; the joystick and drag hint stay fixed. */
export function touchActionMarkup(controls) {
  const buttons = (controls ?? []).filter(control => control.control === 'button');
  if (!buttons.length) return '';
  return buttons.map(control => {
    const className = control.className ? ` class="${escapeAttribute(control.className)}"` : '';
    const attribute = control.kind === 'tap' ? 'data-tap-action' : 'data-hold-action';
    return `<button${className} ${attribute}="${escapeAttribute(control.id)}" aria-label="${escapeAttribute(control.label)}">${escapeAttribute(control.text)}</button>`;
  }).join('\n          ');
}

/**
 * Wire every registered hold/tap button to one action callback, through the
 * `FND-07` lifecycle ledger so the listeners are owned and disposed.
 */
export function createTouchActionControls({ container, registry, lifecycle = null, onAction }) {
  if (!container) throw new TypeError('Touch action controls need a container');
  if (typeof onAction !== 'function') throw new TypeError('Touch action controls need an action callback');
  const listen = (target, type, handler, options) =>
    lifecycle?.listener ? lifecycle.listener(target, type, handler, options) : target.addEventListener(type, handler, options);
  const buttons = [];
  for (const control of registry?.touchControls?.() ?? []) {
    const selector = `[data-${control.kind === 'tap' ? 'tap' : 'hold'}-action="${control.id}"]`;
    const button = container.querySelector(selector);
    if (!button) continue;
    if (control.kind === 'tap') {
      listen(button, 'click', event => {
        event.preventDefault();
        event.stopPropagation();
        onAction(control.id, 'tap');
      });
      listen(button, 'pointerdown', event => event.stopPropagation());
    } else {
      const activate = event => {
        event.preventDefault();
        event.stopPropagation();
        button.classList.add('is-active');
        onAction(control.id, 'hold');
        button.setPointerCapture?.(event.pointerId);
      };
      const deactivate = event => {
        event.preventDefault?.();
        button.classList.remove('is-active');
        onAction(control.id, 'release');
      };
      listen(button, 'pointerdown', activate);
      listen(button, 'pointerup', deactivate);
      listen(button, 'pointercancel', deactivate);
      listen(button, 'lostpointercapture', deactivate);
    }
    buttons.push(button);
  }
  let wired = buttons;
  return {
    /** Live list of wired buttons; `dispose()` empties it. */
    get buttons() { return wired; },
    diagnostics: Object.freeze({
      registered: registry?.diagnostics?.().registered ?? 0,
      wired: wired.length,
    }),
    dispose() {
      for (const button of wired) button.classList?.remove('is-active');
      wired = [];
    },
  };
}
