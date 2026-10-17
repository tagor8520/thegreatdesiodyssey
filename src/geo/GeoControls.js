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
      this.zone.setPointerCapture?.(event.pointerId);
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
