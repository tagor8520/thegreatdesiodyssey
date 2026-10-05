/**
 * `GME-05` action-surface gate *(both runtimes)*
 *
 * The Node tier decides the registry's consistency and the generated markup. This
 * tier decides what only a browser can: that the **mounted** runtimes actually
 * expose the controls the registry declares, that pressing them moves the player,
 * and that the same physical press reaches different actions in the two modes.
 *
 * The mount path is the product's own — the real landing flow, the real curated
 * mount, the real Coordinate Explorer mount — so a control that exists in the
 * registry but never reaches the DOM, or a DOM control wired to nothing, fails
 * here. Nothing in this scenario reads a pixel: "exposed" means a real element a
 * player can press, driven through real pointer events rather than a direct call
 * into the player, because calling `setVirtualInput` would test the very layer
 * under suspicion.
 */
import { freshRunDirectory, openCoordinates, openCurated, waitFrames } from '../harness.mjs';
// The Node half of the gate reads the registry directly, so the assertions about
// slots and selectors are made against the same declarations the page renders from.
import { GAMEPLAY_ACTIONS, uiSelector } from '../../../src/engine/ActionRegistry.js';

/**
 * Runs in the page.
 *
 * Presses a mounted touch control with real pointer events and reports what the
 * player's input object observed, so the browser decides whether the wiring works.
 * `pointerdown` is dispatched on the element itself, which is what a finger does.
 */
/**
 * Measure the mounted touch controls on whatever viewport the page currently has.
 *
 * Used for the phone pass, where the question is not "is the wiring right" (the
 * runtime passes above prove that) but "can a thumb actually hit this".
 */
const MEASURE_IN_PAGE = async (mode) => {
  const root = document.querySelector(`.gdo-touch[data-runtime="${mode}"]`);
  if (!root) return { mounted: false };
  const buttons = [...root.querySelectorAll('.gdo-actions [data-action]')];
  const zone = root.querySelector('[data-action-zone="joystick"]');
  const box = element => {
    const rect = element.getBoundingClientRect();
    return { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) };
  };
  return {
    mounted: true,
    mobileAttribute: root.dataset.mobile,
    buttons: buttons.map(button => ({ action: button.dataset.action, box: box(button) })),
    zone: zone ? box(zone) : null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
};

const PROBE_IN_PAGE = async (mode) => {
  const registry = await import('/src/engine/ActionRegistry.js');
  const { describeRegistry, touchActionsForRuntime, actionsForSurface, GAMEPLAY_ACTIONS } = registry;
  const game = globalThis.__gdoAudit?.game;
  if (!game) throw new Error('the dev audit bridge exposed no game handle');

  const input = mode === 'curated' ? game.player?.input : game.player?.input;
  if (!input) throw new Error(`${mode}: the mount handle exposed no ActionInput`);

  const root = document.querySelector(`.gdo-touch[data-runtime="${mode}"]`);
  const declared = touchActionsForRuntime(mode);
  const renderedButtons = root
    ? [...root.querySelectorAll('.gdo-actions [data-action]')].map(element => element.dataset.action)
    : [];
  const zone = root?.querySelector('[data-action-zone="joystick"]') ?? null;
  // The joystick covers four analogue actions with one control, so the zone
  // declares which ones it speaks for; the gate compares that set too.
  const rendered = [...renderedButtons, ...(zone?.dataset.actions?.split(/\s+/).filter(Boolean) ?? [])];

  // Drive one hold control through real pointer events and read the input's view.
  const pressed = {};
  for (const action of declared) {
    const element = root?.querySelector(`.gdo-actions [data-action="${action}"]`);
    if (!element) {
      // Not a button, so it must be covered by the joystick zone; that is proven
      // by the set comparison above, and there is nothing to press here.
      pressed[action] = { rendered: rendered.includes(action), control: 'joystick' };
      continue;
    }
    const firedBefore = input.diagnostics.actionsFired;
    const before = input.active(action);
    const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 });
    element.dispatchEvent(down);
    const during = input.active(action);
    const firedDuring = input.diagnostics.actionsFired - firedBefore;
    const up = new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 });
    element.dispatchEvent(up);
    const after = input.active(action);
    pressed[action] = {
      rendered: true, control: 'button',
      kind: GAMEPLAY_ACTIONS[action].kind,
      before, during, firedDuring, after,
    };
  }

  // Drive the joystick with a real pointer sequence and read what the player's
  // input observed. Without this the four analogue actions would only be proven
  // by the zone's own claim about which actions it covers.
  let joystick = null;
  if (zone) {
    const bounds = zone.getBoundingClientRect();
    const startX = bounds.left + Math.min(80, bounds.width / 2);
    const startY = bounds.top + bounds.height / 2;
    const options = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true };
    const down = { ...options, clientX: startX, clientY: startY };
    zone.dispatchEvent(new PointerEvent('pointerdown', down));
    zone.dispatchEvent(new PointerEvent('pointermove', { ...options, clientX: startX, clientY: startY - 60 }));
    const forward = {
      analog: { ...(input.analog ?? {}) },
      active: {
        forward: input.active('forward'), back: input.active('back'),
        left: input.active('left'), right: input.active('right'),
      },
    };
    zone.dispatchEvent(new PointerEvent('pointermove', { ...options, clientX: startX + 60, clientY: startY }));
    const rightward = {
      analog: { ...(input.analog ?? {}) },
      active: {
        forward: input.active('forward'), back: input.active('back'),
        left: input.active('left'), right: input.active('right'),
      },
    };
    zone.dispatchEvent(new PointerEvent('pointerup', { ...options, clientX: startX + 60, clientY: startY }));
    joystick = {
      mounted: true,
      forward,
      rightward,
      released: {
        analog: { ...(input.analog ?? {}) },
        active: {
          forward: input.active('forward'), back: input.active('back'),
          left: input.active('left'), right: input.active('right'),
        },
      },
    };
  }

  // A real keypress through the page's own listener, not a direct call.
  const actionForCode = registry.actionForCode;
  const keyboard = {};
  for (const code of ['KeyW', 'KeyM', 'KeyV', 'F3', 'Digit1']) {
    const action = actionForCode(code, mode);
    // Record the resolution even when it is "no action", so a per-runtime binding
    // assertion can tell "resolved to nothing" from "the probe forgot to look".
    if (!action) { keyboard[code] = { action: null }; continue; }
    const firedBefore = input.diagnostics.actionsFired;
    const before = input.active(action);
    // A real key press through the page's own listener path, on both the document
    // and the window, because the runtimes register on different targets.
    document.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    const kind = GAMEPLAY_ACTIONS[action].kind;
    keyboard[code] = {
      action,
      before,
      kind,
      fired: input.diagnostics.actionsFired - firedBefore,
      after: input.active(action),
    };
    window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
  }

  // `ui` surface: the on-screen inventory buttons must select the same slot the
  // registry says the number keys select. Both writes are asserted against the
  // rendered `aria-pressed` state, which is what the player actually sees.
  // React 18 batches and renders asynchronously, so the `aria-pressed` state a
  // click produces is not in the DOM by the time `click()` returns. Two frames is
  // enough for the store notification to reach the committed DOM.
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const ui = { declared: [], actions: [], slots: [], clicks: [], keys: [] };
  // Not every runtime has an inventory (the coordinate explorer has no slots at
  // all), so the ui surface is read from the registry per runtime, not assumed.
  const uiActions = actionsForSurface(mode, 'ui');
  for (const action of uiActions) {
    const slot = registry.slotForAction(action);
    const selector = registry.uiSelector(action);
    const element = root?.ownerDocument?.querySelector(selector) ?? document.querySelector(selector);
    ui.declared.push(action);
    ui.actions.push(action);
    ui.slots.push(slot);
    if (!element) { ui.clicks.push({ action, slot, rendered: false }); continue; }
    element.click();
    await settle();
    ui.clicks.push({
      action, slot, rendered: true,
      pressed: element.getAttribute('aria-pressed') === 'true',
    });
  }
  // Now the keyboard must reach the same slot through `ActionInput`.
  for (const action of uiActions) {
    const slot = registry.slotForAction(action);
    const code = GAMEPLAY_ACTIONS[action].codes[0];
    document.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    await settle();
    const element = document.querySelector(registry.uiSelector(action));
    ui.keys.push({ action, slot, pressed: element?.getAttribute('aria-pressed') === 'true' });
  }

  return {
    ui,
    report: describeRegistry(),
    declared,
    rendered,
    hasJoystickZone: Boolean(zone),
    joystick,
    ui,
    joystickDeclared: declared.some(action => GAMEPLAY_ACTIONS[action].touch?.control === 'joystick'),
    declaredJoystickActions: declared.filter(action => GAMEPLAY_ACTIONS[action].touch?.control === 'joystick'),
    pressed,
    keyboard,
    mobileAttribute: root?.dataset.mobile ?? null,
    snapshot: input.snapshot(),
  };
};

/**
 * The pointer-press assertions, applied to both modes by the caller.
 *
 * Hold and tap controls are proven differently, because they *are* different:
 * a hold control must leave the action active for as long as the finger is down,
 * and a tap control must fire once and leave nothing held. Asserting "active
 * during press" on a tap would have been satisfied by the very bug this gate
 * found — a tap that stayed held forever.
 */
function judgePresses(mode, probe, failures) {
  for (const action of probe.declared) {
    const press = probe.pressed[action];
    if (!press?.rendered) { failures.push(`${mode}: ${action} is declared for touch but no control was rendered`); continue; }
    if (press.control !== 'button') continue;
    if (press.after === true) failures.push(`${mode}: ${action} stayed active after release`);
    if (press.kind === 'tap' || press.firedDuring >= 1) {
      if (press.firedDuring < 1) failures.push(`${mode}: pressing the ${action} control did not fire the action`);
    } else if (press.during !== true) {
      failures.push(`${mode}: pressing the ${action} control did not reach the player`);
    }
  }
  if (probe.rendered.length !== probe.declared.length) {
    failures.push(`${mode}: rendered ${probe.rendered.length} control(s) for ${probe.declared.length} declared action(s)`);
  }
  if (probe.joystickDeclared !== probe.hasJoystickZone) {
    failures.push(`${mode}: joystick zone presence (${probe.hasJoystickZone}) does not match the registry (${probe.joystickDeclared})`);
  }
  // The `ui` surface: a rendered button per ui action, and the button and the key
  // both selecting the same slot. A registry that named a slot no button carries
  // would pass the Node tier and fail here.
  // A runtime with no inventory is not a failure; a runtime that *declares* one
  // and cannot reach it is.
  if (probe.ui?.declared?.length) {
    for (const [index, action] of probe.ui.actions.entries()) {
      const click = probe.ui.clicks[index];
      if (!click?.rendered) { failures.push(`${mode}: ${action} claims the ui surface but no ${uiSelector(action)} control is mounted`); continue; }
      if (!click.pressed) failures.push(`${mode}: selecting ${action} by button did not select slot ${click.slot}`);
    }
    for (const [index, entry] of probe.ui.keys.entries()) {
      if (!entry.pressed) failures.push(`${mode}: pressing ${GAMEPLAY_ACTIONS[entry.action].codes[0]} did not select slot ${entry.slot}`);
      const click = probe.ui.clicks[index];
      if (click?.rendered && click.slot !== entry.slot) {
        failures.push(`${mode}: ${entry.action} selects slot ${entry.slot} from the registry but the button selects ${click.slot}`);
      }
    }
  } else if (mode === 'curated') failures.push(`${mode}: the curated runtime declares no ui-surface action at all`);

  // The analogue actions are only genuinely covered if dragging the stick moves
  // the player's own input state — a zone that exists but reports nothing would
  // otherwise satisfy a set comparison.
  const stick = probe.joystick;
  if (probe.joystickDeclared) {
    if (!stick?.mounted) { failures.push(`${mode}: the joystick zone did not respond to a pointer drag`); return; }
    const push = stick.forward;
    if (!(push.analog.z < -.1)) failures.push(`${mode}: dragging the stick up did not produce backward input vector (z=${push.analog.z})`);
    if (push.active.forward !== true) failures.push(`${mode}: dragging the stick up did not activate forward`);
    if (push.active.back === true) failures.push(`${mode}: dragging the stick up also activated back`);
    const side = stick.rightward;
    if (!(side.analog.x > .1)) failures.push(`${mode}: dragging the stick right did not produce a positive x vector (x=${side.analog.x})`);
    if (side.active.right !== true) failures.push(`${mode}: dragging the stick right did not activate right`);
    const released = stick.released;
    if (released.analog.x !== 0 || released.analog.z !== 0) failures.push(`${mode}: releasing the stick left a non-zero vector`);
    for (const [action, active] of Object.entries(released.active)) {
      if (active) failures.push(`${mode}: ${action} stayed active after the stick was released`);
    }
  }
}

export async function run({ page, baseUrl, log = console.log }) {
  const directory = freshRunDirectory('gme05-action-surfaces');
  const failures = [];

  log(`\n[gme05] curated runtime at ${baseUrl}`);
  await openCurated(page, baseUrl);
  await waitFrames(page, 4);
  const curated = await page.evaluate(PROBE_IN_PAGE, 'curated');

  log(`[gme05] Coordinate Explorer at ${baseUrl}`);
  await openCoordinates(page, baseUrl);
  await waitFrames(page, 4);
  const coordinates = await page.evaluate(PROBE_IN_PAGE, 'coordinates');

  for (const [mode, probe] of [['curated', curated], ['coordinates', coordinates]]) {
    log(`\n[gme05] ${mode}`);
    log(`  registry          ${probe.report.actions} actions; this runtime declares ${probe.declared.length} touch action(s)`);
    log(`  rendered controls ${probe.rendered.join(', ') || '(none)'}`);
    log(`  joystick zone     ${probe.hasJoystickZone}`);
    for (const action of probe.declared) {
      const press = probe.pressed[action] ?? {};
      log(`  press ${action.padEnd(14)} rendered=${press.rendered} activeDuring=${press.during} activeAfter=${press.after}`);
    }
    if (probe.joystick) {
      log(`  joystick push     analog z=${probe.joystick.forward.analog.z.toFixed(3)} forward=${probe.joystick.forward.active.forward}` +
        ` · right x=${probe.joystick.rightward.analog.x.toFixed(3)} right=${probe.joystick.rightward.active.right}` +
        ` · released x=${probe.joystick.released.analog.x} z=${probe.joystick.released.analog.z}`);
    }
    if (probe.ui?.declared?.length) {
      log(`  ui surface        ${probe.ui.actions.map((action, index) => `${action}→slot ${probe.ui.clicks[index]?.slot} button=${probe.ui.clicks[index]?.pressed ? 'ok' : 'FAIL'} key=${probe.ui.keys[index]?.pressed ? 'ok' : 'FAIL'}`).join(' · ')}`);
    }
    const keyLines = Object.entries(probe.keyboard)
      .map(([code, result]) => `${code}->${result ? result.action : 'none'}`)
      .join(' ');
    log(`  keyboard binding  ${keyLines}`);
    log(`  held at capture   ${probe.snapshot.held}`);
    judgePresses(mode, probe, failures);
  }

  // The mobile path is a *device* question, not a "did the game start" question:
  // on a phone-shaped, touch-capable viewport the same mount must decide for itself
  // to show the controls, and they must be laid out where a thumb can reach them.
  log('\n[gme05] curated runtime on a phone-shaped viewport');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await openCurated(page, baseUrl);
  await waitFrames(page, 4);
  const phoneCurated = await page.evaluate(MEASURE_IN_PAGE, 'curated');
  log('  curated');
  for (const button of phoneCurated.buttons ?? []) {
    log(`    ${button.action.padEnd(7)} ${button.box.w}x${button.box.h} at (${button.box.x}, ${button.box.y})`);
  }
  log(`    joystick ${phoneCurated.zone ? `${phoneCurated.zone.w}x${phoneCurated.zone.h}` : 'none'} · data-mobile=${phoneCurated.mobileAttribute} · viewport ${phoneCurated.viewport?.w}x${phoneCurated.viewport?.h}`);

  await openCoordinates(page, baseUrl);
  await waitFrames(page, 4);
  const phoneCoordinates = await page.evaluate(MEASURE_IN_PAGE, 'coordinates');
  log('  coordinates');
  for (const button of phoneCoordinates.buttons ?? []) {
    log(`    ${button.action.padEnd(7)} ${button.box.w}x${button.box.h} at (${button.box.x}, ${button.box.y})`);
  }
  log(`    joystick ${phoneCoordinates.zone ? `${phoneCoordinates.zone.w}x${phoneCoordinates.zone.h}` : 'none'} · data-mobile=${phoneCoordinates.mobileAttribute} · viewport ${phoneCoordinates.viewport?.w}x${phoneCoordinates.viewport?.h}`);

  for (const [mode, phone] of [['curated', phoneCurated], ['coordinates', phoneCoordinates]]) {
    if (!phone.mounted) { failures.push(`phone: no ${mode} touch layer was mounted`); continue; }
    if (phone.mobileAttribute !== 'true') failures.push(`phone: a touch-capable phone viewport did not enable the ${mode} controls (data-mobile=${phone.mobileAttribute})`);
    const zoneIsLaidOut = Boolean(phone.zone && phone.zone.h > 0);
    for (const action of ['forward', 'back', 'left', 'right']) {
      if (zoneIsLaidOut) continue;
      if (!phone.buttons.some(button => button.action === action && button.box.h > 0)) {
        failures.push(`phone: the ${action} control is not laid out in ${mode}`);
      }
    }
    for (const button of phone.buttons) {
      // A control a thumb cannot hit is not a control: 44px is the platform floor.
      if (button.box.h < 44 || button.box.w < 44) failures.push(`phone: the ${mode} ${button.action} button is ${button.box.w}x${button.box.h}, below the 44px touch target`);
      if (button.box.h > 0 && (button.box.y < 0 || button.box.y + button.box.h > phone.viewport.h + 1)) {
        failures.push(`phone: the ${mode} ${button.action} button is off-screen at y=${button.box.y}`);
      }
    }
    if (!zoneIsLaidOut) failures.push(`phone: the ${mode} joystick zone has no layout area`);
  }
  log(`\n[gme05] desktop pass     data-mobile=${curated.mobileAttribute} (a mouse-driven browser must not get touch controls)`);
  if (curated.mobileAttribute !== 'false') failures.push(`desktop: a non-touch browser showed touch controls (data-mobile=${curated.mobileAttribute})`);

  // The same physical key must reach different actions in the two modes, and the
  // other mode's keys must reach nothing — this is what makes the registry
  // per-runtime rather than a global keymap.
  const curatedMap = curated.keyboard.KeyM?.action ?? null;
  const coordinateMap = coordinates.keyboard.KeyM?.action ?? null;
  log('\n[gme05] per-runtime binding');
  log(`  KeyM   curated=${curatedMap ?? 'none'} coordinates=${coordinateMap ?? 'none'}`);
  log(`  KeyV   curated=${curated.keyboard.KeyV?.action ?? 'none'} coordinates=${coordinates.keyboard.KeyV?.action ?? 'none'}`);
  log(`  F3     curated=${curated.keyboard.F3?.action ?? 'none'} coordinates=${coordinates.keyboard.F3?.action ?? 'none'}`);
  if (curatedMap !== 'map') failures.push('curated: KeyM must resolve to map mode');
  if (coordinateMap !== null) failures.push('coordinates: KeyM must resolve to nothing');
  if (coordinates.keyboard.KeyV?.action !== 'camera') failures.push('coordinates: KeyV must resolve to camera');
  if (curated.keyboard.KeyV?.action !== null) failures.push('curated: KeyV must resolve to nothing');
  if (coordinates.keyboard.F3?.action !== 'debug') failures.push('coordinates: F3 must resolve to the debug overlay');
  if (curated.keyboard.F3?.action !== null) failures.push('curated: F3 must resolve to nothing');

  log(`\n[gme05] ${failures.length ? `FAIL (${failures.length}): ${failures[0]}` : 'PASS: every declared action is reachable on every surface it claims.'}`);

  return {
    directory,
    blockers: failures.length,
    sweepFrames: 0,
    totalPenetrations: 0,
    actionFailures: failures,
    registry: { actions: curated.report.actions, curated: curated.report.runtimes[0], coordinates: coordinates.report.runtimes[1] },
    phone: {
      curated: { attribute: phoneCurated.mobileAttribute, buttons: phoneCurated.buttons, zone: phoneCurated.zone },
      coordinates: { attribute: phoneCoordinates.mobileAttribute, buttons: phoneCoordinates.buttons, zone: phoneCoordinates.zone },
      viewport: phoneCurated.viewport,
    },
    curated: { declared: curated.declared, rendered: curated.rendered, pressed: curated.pressed, keyboard: curated.keyboard, joystick: curated.hasJoystickZone, joystickDrive: curated.joystick, ui: curated.ui },
    coordinates: { declared: coordinates.declared, rendered: coordinates.rendered, pressed: coordinates.pressed, keyboard: coordinates.keyboard, joystick: coordinates.hasJoystickZone, joystickDrive: coordinates.joystick },
  };
}
