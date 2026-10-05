export function shouldUseTouchControls(environment = globalThis) {
  const navigator = environment.navigator ?? {};
  const touchPoints = Number(navigator.maxTouchPoints ?? 0);
  const coarsePointer = environment.matchMedia?.('(pointer: coarse)').matches ?? false;
  const mobileHint = navigator.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent ?? '');
  const narrowTouchScreen = touchPoints > 0 && Math.min(
    environment.screen?.width ?? Infinity,
    environment.screen?.height ?? Infinity,
  ) <= 1024;
  return mobileHint || (touchPoints > 0 && coarsePointer) || narrowTouchScreen;
}

export function normalizeJoystick(deltaX, deltaY, radius, deadZone = .12) {
  if (!(radius > 0)) return { x: 0, z: 0, magnitude: 0 };
  const distance = Math.hypot(deltaX, deltaY);
  const rawMagnitude = Math.min(1, distance / radius);
  if (rawMagnitude <= deadZone || distance === 0) return { x: 0, z: 0, magnitude: 0 };
  const magnitude = (rawMagnitude - deadZone) / (1 - deadZone);
  return {
    x: deltaX / distance * magnitude,
    z: deltaY / distance * magnitude,
    magnitude,
  };
}

export class FlexibleJoystick {
  constructor(zone, base, knob, onMove, { radius = 44 } = {}) {
    this.zone = zone;
    this.base = base;
    this.knob = knob;
    this.onMove = onMove;
    this.radius = radius;
    this.pointerId = null;
    this.originX = 0;
    this.originY = 0;

    this.pointerdown = event => {
      if (this.pointerId !== null || event.pointerType === 'mouse') return;
      event.preventDefault();
      event.stopPropagation();
      this.pointerId = event.pointerId;
      this.originX = event.clientX;
      this.originY = event.clientY;
      const bounds = this.zone.getBoundingClientRect();
      this.base.style.left = `${event.clientX - bounds.left}px`;
      this.base.style.top = `${event.clientY - bounds.top}px`;
      this.base.classList.add('is-engaged');
      this.zone.classList.add('is-engaged');
      // Capture is a nicety, not a requirement: it throws if the pointer is
      // already gone, and a joystick that stops tracking because capture failed
      // is worse than one that simply loses the drag when the finger leaves.
      try { this.zone.setPointerCapture?.(event.pointerId); } catch { /* keep tracking */ }
      this._move(event.clientX, event.clientY);
    };
    this.pointermove = event => {
      if (event.pointerId !== this.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      this._move(event.clientX, event.clientY);
    };
    this.pointerup = event => {
      if (event.pointerId !== this.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      this.reset();
    };

    zone.addEventListener('pointerdown', this.pointerdown);
    zone.addEventListener('pointermove', this.pointermove);
    zone.addEventListener('pointerup', this.pointerup);
    zone.addEventListener('pointercancel', this.pointerup);
    zone.addEventListener('lostpointercapture', this.pointerup);
  }

  _move(clientX, clientY) {
    const dx = clientX - this.originX;
    const dy = clientY - this.originY;
    const distance = Math.hypot(dx, dy);
    const scale = distance > this.radius ? this.radius / distance : 1;
    this.knob.style.transform = `translate(calc(-50% + ${dx * scale}px), calc(-50% + ${dy * scale}px))`;
    const value = normalizeJoystick(dx, dy, this.radius);
    this.onMove(value.x, value.z);
  }

  reset() {
    this.pointerId = null;
    this.knob.style.transform = 'translate(-50%, -50%)';
    this.base.classList.remove('is-engaged');
    this.zone.classList.remove('is-engaged');
    this.onMove(0, 0);
  }

  dispose() {
    this.reset();
    this.zone.removeEventListener('pointerdown', this.pointerdown);
    this.zone.removeEventListener('pointermove', this.pointermove);
    this.zone.removeEventListener('pointerup', this.pointerup);
    this.zone.removeEventListener('pointercancel', this.pointerup);
    this.zone.removeEventListener('lostpointercapture', this.pointerup);
  }
}

import { GAMEPLAY_ACTIONS, touchActionsForRuntime, requireRuntimeAction } from './ActionRegistry.js';

/**
 * The joystick's four directions are analogue, so they are not separate buttons.
 * One zone reports a vector and the mount maps it onto the registry's locomotion
 * actions, which keeps the registry honest: `forward`/`back`/`left`/`right` are
 * still declared actions with keyboard codes, they just share one touch control.
 */
export const JOYSTICK_ACTIONS = Object.freeze(['forward', 'back', 'left', 'right']);

/**
 * Build the touch markup for a runtime from the registry (`GME-05`).
 *
 * Every control carries `data-action` with a registered id, and the set of ids
 * is exactly `touchActionsForRuntime(runtime)`. That is what lets the gate assert
 * coverage as a property of the DOM rather than by reading this function.
 *
 * Placement comes from `touch.grid` in the registry, so the stylesheet carries no
 * per-action rules and adding an action does not mean editing CSS.
 */
export function touchControlsMarkup(runtime, { mobile = false } = {}) {
  const actions = touchActionsForRuntime(runtime);
  const buttons = actions.filter(action => GAMEPLAY_ACTIONS[action].touch?.control === 'button');
  const joystickActions = actions.filter(action => GAMEPLAY_ACTIONS[action].touch?.control === 'joystick');
  const hasJoystick = joystickActions.length > 0;
  const buttonMarkup = buttons.map(action => {
    const touch = GAMEPLAY_ACTIONS[action].touch;
    // Placed by the registry: `grid-area` from `touch.grid`, and the hit target
    // size from `touch.size`. `place-self:center` keeps a 72px jump button centred
    // in its two-cell area instead of stretched into an oval.
    const style = [
      `grid-area:${touch.grid}`,
      `width:${touch.size}px`, `height:${touch.size}px`,
      'place-self:center',
    ].join(';');
    const kind = GAMEPLAY_ACTIONS[action].kind;
    return `<button type="button" data-action="${action}" data-kind="${kind}" aria-label="${GAMEPLAY_ACTIONS[action].label}" style="${style}">${touch.text}</button>`;
  }).join('\n          ');
  return `
      <div class="gdo-touch" data-runtime="${runtime}" data-mobile="${mobile ? 'true' : 'false'}" aria-label="Touch controls">
        ${hasJoystick ? `<div class="gdo-joystick-zone" data-action-zone="joystick" data-actions="${joystickActions.join(' ')}" aria-label="Flexible movement joystick">
          <div class="gdo-joystick-hint"><span></span>MOVE</div>
          <div class="gdo-joystick-base"><div class="gdo-joystick-knob"></div></div>
        </div>
        <div class="gdo-look-hint">DRAG TO LOOK</div>` : ''}
        <div class="gdo-actions" data-action-zone="buttons">
          ${buttonMarkup}
        </div>
      </div>
  `;
}

/**
 * Mount the touch layer for one runtime and wire it to that runtime's
 * `ActionInput`. Returns a handle with its own cleanup, because `FND-07` counts
 * listeners and every pointer subscription here has to come back off.
 */
export function mountTouchControls({
  runtime,
  container,
  input,
  environment = globalThis,
  mobile = shouldUseTouchControls(environment),
  radius = 44,
} = {}) {
  if (!container) throw new TypeError('mountTouchControls requires a container');
  if (!input || typeof input.setVirtual !== 'function') throw new TypeError('mountTouchControls requires an ActionInput');
  const cleanups = [];
  container.insertAdjacentHTML('beforeend', touchControlsMarkup(runtime, { mobile }));
  const root = container.querySelector(`.gdo-touch[data-runtime="${runtime}"]`);
  if (!root) throw new Error(`the touch layer for ${runtime} did not mount`);

  const on = (element, type, handler, options) => {
    element.addEventListener(type, handler, options);
    cleanups.push(() => element.removeEventListener(type, handler, options));
  };

  const zone = root.querySelector('.gdo-joystick-zone');
  if (zone) {
    const base = root.querySelector('.gdo-joystick-base');
    const knob = root.querySelector('.gdo-joystick-knob');
    const joystick = new FlexibleJoystick(zone, base, knob, (x, z) => {
      input.setAnalog?.(x, z);
      // The registry's locomotion actions mirror the analogue vector for held
      // state, so a consumer that reads `active('forward')` sees the joystick too.
      input.setVirtual('forward', z < -.12);
      input.setVirtual('back', z > .12);
      input.setVirtual('left', x < -.12);
      input.setVirtual('right', x > .12);
    }, { radius });
    cleanups.push(() => { joystick.dispose(); input.setAnalog?.(0, 0); for (const action of JOYSTICK_ACTIONS) input.setVirtual(action, false); });
  }

  for (const button of root.querySelectorAll('.gdo-actions [data-action]')) {
    const action = button.dataset.action;
    // A control wired to an action this runtime does not have must fail loudly at
    // mount; the whole point of the registry is that a mis-wired control cannot
    // sit there doing nothing.
    requireRuntimeAction(action, runtime);
    const definition = GAMEPLAY_ACTIONS[action];
    const press = event => {
      event.preventDefault();
      event.stopPropagation();
      button.classList.add('is-active');
      input.setVirtual(action, true);
      button.setPointerCapture?.(event.pointerId);
    };
    const release = event => {
      event?.preventDefault?.();
      button.classList.remove('is-active');
      if (definition.kind === 'hold') input.setVirtual(action, false);
    };
    on(button, 'pointerdown', press);
    on(button, 'pointerup', release);
    on(button, 'pointercancel', release);
    on(button, 'lostpointercapture', release);
    // Keyboard reachability for the control itself: a button in the tab order
    // that ignores Enter is a button that a switch-access user cannot press.
    on(button, 'keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      input.setVirtual(action, true);
      if (definition.kind === 'tap') input.setVirtual(action, false);
    });
    on(button, 'keyup', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (definition.kind === 'hold') input.setVirtual(action, false);
    });
  }

  return {
    runtime,
    root,
    mobile,
    actions: touchActionsForRuntime(runtime),
    setMobile(value) { root.dataset.mobile = value ? 'true' : 'false'; this.mobile = value; },
    dispose() {
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
      root.remove();
    },
  };
}
