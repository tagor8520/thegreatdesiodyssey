import test from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleLedger } from './LifecycleContract.js';
import {
  GDO_AMBIENT_AUDIO_NAMESPACE,
  GDO_AMBIENT_KINDS,
  GDO_AMBIENT_PROFILES,
  GDO_AMBIENT_REFUSAL,
  createAmbientAudio,
} from './AmbientAudio.js';

/** A recording stand-in for a Web Audio context — the module only asks for
 *  gain/filter/buffer-source/oscillator nodes, which this stub provides. */
function stubAudioContext() {
  const created = [];
  const makeNode = (kind) => {
    const node = {
      kind,
      connected: [],
      started: 0,
      stopped: 0,
      disconnected: 0,
      connect(target) { this.connected.push(target); return target; },
      disconnect() { this.disconnected += 1; },
      start() { this.started += 1; },
      stop() { this.stopped += 1; },
    };
    created.push(node);
    return node;
  };
  return {
    created,
    sampleRate: 8000,
    destination: { kind: 'destination' },
    state: 'running',
    resume() { return Promise.resolve(); },
    createGain() {
      const node = makeNode('gain');
      node.gain = {
        value: 1,
        setTargetAtTimeCalls: [],
        setTargetAtTime(value) { this.setTargetAtTimeCalls.push(value); this.value = value; },
      };
      return node;
    },
    createBiquadFilter() {
      const node = makeNode('filter');
      node.type = 'lowpass';
      node.frequency = { value: 350 };
      node.Q = { value: 1 };
      return node;
    },
    createBufferSource() {
      const node = makeNode('source');
      node.buffer = null;
      node.loop = false;
      return node;
    },
    createBuffer(channels, frames) {
      return {
        channels,
        frames,
        data: new Float32Array(frames),
        getChannelData() { return this.data; },
      };
    },
    createOscillator() {
      const node = makeNode('oscillator');
      node.frequency = { value: 440 };
      return node;
    },
  };
}

function clearWeather(over = {}) {
  return {
    wind: { strength: 0.42, gustiness: 0.18 },
    precipitation: 'none',
    habitat: { flyers: 1, insects: 1 },
    ...over,
  };
}

test('ambient audio: zones carry declared distance falloff and stay inside the profile caps', () => {
  const audio = createAmbientAudio({ profile: 'default' });
  assert.equal(audio.profile.id, 'default');
  assert.equal(audio.profile.maxVoices, GDO_AMBIENT_PROFILES.default.maxVoices);
  assert.equal(audio.namespace, GDO_AMBIENT_AUDIO_NAMESPACE);

  const zones = [
    { id: 'water-a', kind: GDO_AMBIENT_KINDS.WATER, x: 4, z: 0, radius: 12, gain: 0.9 },
    { id: 'water-b', kind: GDO_AMBIENT_KINDS.WATER, x: 200, z: 0, radius: 12, gain: 0.9 },
  ];
  const result = audio.setZones(zones);
  assert.equal(result.accepted, 2);
  assert.equal(result.refused, 0);

  const near = audio.update({
    listenerX: 0,
    listenerZ: 0,
    weather: clearWeather({ wind: { strength: 0, gustiness: 0 }, habitat: { flyers: 0, insects: 0 } }),
    nowMilliseconds: 100,
  });
  assert.equal(near.refused, false);
  // The far zone is past its radius and the profile's maxDistance — silent by
  // data; only the near water and the always-on wind bed remain audible.
  assert.deepEqual(near.voices.map((v) => v.id), ['water-a', 'bed:wind']);
  assert.ok(near.voices[0].gain > 0.4, `near zone should be clearly audible, got ${near.voices[0].gain}`);

  // Standing on the zone's centre keeps it loud…
  const centre = audio.update({
    listenerX: 200,
    listenerZ: 0,
    weather: clearWeather({ wind: { strength: 0, gustiness: 0 }, habitat: { flyers: 0, insects: 0 } }),
    nowMilliseconds: 500,
  });
  assert.ok(centre.voices.some((v) => v.id === 'water-b' && v.gain > 0.4));
  // …and stepping past its radius silences it entirely — the falloff is data.
  const past = audio.update({
    listenerX: 220,
    listenerZ: 0,
    weather: clearWeather({ wind: { strength: 0, gustiness: 0 }, habitat: { flyers: 0, insects: 0 } }),
    nowMilliseconds: 900,
  });
  assert.ok(!past.voices.some((v) => v.id === 'water-b'));

  const diagnostics = audio.diagnostics();
  assert.equal(diagnostics.zoneCount, 2);
  assert.equal(diagnostics.counters.zonesAccepted, 2);
  audio.dispose();
});

test('ambient audio: the activity cap keeps the loudest voices and counts the rest', () => {
  const audio = createAmbientAudio({ profile: 'compact' }); // maxVoices: 3
  const zones = [];
  for (let i = 0; i < 6; i += 1) {
    zones.push({ id: `water-${i}`, kind: GDO_AMBIENT_KINDS.WATER, x: i, z: 0, radius: 10, gain: 0.2 + i * 0.1 });
  }
  audio.setZones(zones);

  const result = audio.update({
    listenerX: 0,
    listenerZ: 0,
    // Quiet weather so the zone voices dominate the 3 slots.
    weather: clearWeather({ wind: { strength: 0, gustiness: 0 }, habitat: { flyers: 0, insects: 0 } }),
    nowMilliseconds: 200,
  });
  assert.equal(result.voices.length, 3);
  // Six zones plus the always-on wind bed compete for three slots.
  assert.equal(result.dropped, 4);
  assert.equal(audio.diagnostics().counters.zoneOverCap, 4);
  // The winners are the loudest zones — 5, 4, 3.
  assert.deepEqual(result.voices.map((v) => v.id), ['water-5', 'water-4', 'water-3']);
  audio.dispose();
});

test('ambient audio: zone vocabulary is refused by name and the update loop is rate limited', () => {
  const audio = createAmbientAudio({ profile: 'default' });

  const result = audio.setZones([
    { id: 'ok', kind: GDO_AMBIENT_KINDS.SURF, x: 0, z: 0, radius: 8, gain: 0.5 },
    { id: 'bad', kind: 'teleport', x: 0, z: 0, radius: 8, gain: 0.5 },
    { kind: GDO_AMBIENT_KINDS.WATER, x: 0, z: 0, radius: 8, gain: 0.5 },
    { id: 'ok', kind: GDO_AMBIENT_KINDS.WATER, x: 1, z: 0, radius: 8, gain: 0.5 },
    { id: 'another', kind: 'bogus', x: 0, z: 0, radius: 8, gain: 0.5 },
  ]);
  assert.equal(result.accepted, 1);
  assert.equal(result.refused, 4);

  const refusals = audio.diagnostics().refusals;
  assert.equal(refusals[GDO_AMBIENT_REFUSAL.UNKNOWN_KIND], 2);
  assert.equal(refusals[GDO_AMBIENT_REFUSAL.MISSING_ZONE_ID], 1);
  assert.equal(refusals[GDO_AMBIENT_REFUSAL.DUPLICATE_ZONE_ID], 1);

  audio.update({ listenerX: 0, listenerZ: 0, nowMilliseconds: 1000 });
  const throttled = audio.update({ listenerX: 0, listenerZ: 0, nowMilliseconds: 1050 });
  assert.equal(throttled.refused, true);
  assert.equal(throttled.reason, GDO_AMBIENT_REFUSAL.UPDATE_THROTTLE);
  assert.equal(audio.diagnostics().counters.updateThrottle, 1);

  const afterInterval = audio.update({ listenerX: 0, listenerZ: 0, nowMilliseconds: 1200 });
  assert.equal(afterInterval.refused, false);

  const missingListener = audio.update({ nowMilliseconds: 1400 });
  assert.equal(missingListener.reason, GDO_AMBIENT_REFUSAL.BAD_LISTENER);

  const overCap = [];
  for (let i = 0; i < GDO_AMBIENT_PROFILES.default.maxZones + 3; i += 1) {
    overCap.push({ id: `z-${i}`, kind: GDO_AMBIENT_KINDS.WIND, x: i, z: 0, radius: 6, gain: 0.4 });
  }
  const capped = audio.setZones(overCap);
  assert.equal(capped.accepted, GDO_AMBIENT_PROFILES.default.maxZones);
  assert.equal(capped.refused, 3);
  assert.equal(audio.diagnostics().refusals[GDO_AMBIENT_REFUSAL.ZONE_CAP], 3);
  audio.dispose();
});

test('ambient audio: a real context receives the capped voice graph and disposal stops it', () => {
  const context = stubAudioContext();
  const audio = createAmbientAudio({ profile: 'default', context });

  audio.setZones([{ id: 'water-a', kind: GDO_AMBIENT_KINDS.WATER, x: 2, z: 0, radius: 12, gain: 0.9 }]);
  const result = audio.update({
    listenerX: 0,
    listenerZ: 0,
    weather: clearWeather({ wind: { strength: 0.5, gustiness: 0.2 } }),
    nowMilliseconds: 100,
  });
  assert.equal(result.applied, true);

  // One voice per audible kind — never one per zone (the activity cap).
  const diagnostics = audio.diagnostics();
  assert.ok(diagnostics.activeVoices <= GDO_AMBIENT_PROFILES.default.maxVoices);
  assert.ok(diagnostics.counters.voicesCreated > 0);
  assert.ok(diagnostics.counters.voicesCreated <= GDO_AMBIENT_PROFILES.default.maxVoices);
  // Every gain node landed on the destination through its filter chain.
  const gains = context.created.filter((n) => n.kind === 'gain');
  assert.ok(gains.some((n) => n.connected.length > 0));

  // Rain arrives through ENV-04's precipitation and raises the plan.
  const rain = audio.update({
    listenerX: 0,
    listenerZ: 0,
    weather: clearWeather({ precipitation: 'rain', wind: { strength: 0.5, gustiness: 0.2 } }),
    nowMilliseconds: 400,
  });
  assert.ok(rain.voices.some((v) => v.id === 'bed:rain' && v.gain > 0.5));

  // The habitat beds follow the world activity multiplier (birds sleep at 0).
  const night = audio.update({
    listenerX: 0,
    listenerZ: 0,
    weather: clearWeather({ precipitation: 'rain', wind: { strength: 0.5, gustiness: 0.2 } }),
    activity: 0,
    nowMilliseconds: 700,
  });
  const birds = night.voices.find((v) => v.id === 'bed:birds');
  const morning = audio.update({
    listenerX: 0,
    listenerZ: 0,
    weather: clearWeather({ precipitation: 'rain', wind: { strength: 0.5, gustiness: 0.2 } }),
    activity: 1,
    nowMilliseconds: 1000,
  });
  const loud = morning.voices.find((v) => v.id === 'bed:birds');
  if (birds && loud) assert.ok(birds.gain < loud.gain);
  else assert.ok(birds || loud, 'the birds bed should be audible at some activity level');

  audio.dispose();
  assert.equal(audio.disposed, true);
  assert.equal(audio.diagnostics().counters.disposeCount, 1);
  // Dispose stops every source and oscillator it ever started.
  const started = context.created.filter((n) => (n.kind === 'source' || n.kind === 'oscillator') && n.started > 0);
  assert.ok(started.length > 0);
  for (const node of started) assert.ok(node.stopped > 0);
  const again = audio.update({ listenerX: 0, listenerZ: 0, nowMilliseconds: 2000 });
  assert.equal(again.reason, GDO_AMBIENT_REFUSAL.ALREADY_DISPOSED);
});

test('ambient audio: no context is a counted refusal, never an error', () => {
  const audio = createAmbientAudio({ profile: 'default', context: null });
  audio.setZones([{ id: 'water-a', kind: GDO_AMBIENT_KINDS.WATER, x: 2, z: 0, radius: 12, gain: 0.9 }]);
  const result = audio.update({ listenerX: 0, listenerZ: 0, weather: clearWeather(), nowMilliseconds: 100 });
  assert.equal(result.refused, false);
  assert.equal(result.applied, false);
  assert.ok(result.voices.length > 0);
  assert.equal(audio.diagnostics().counters.noContext, 1);
  audio.dispose();
});

test('ambient audio: the lifecycle ledger owns the surface and the disposal lands there', () => {
  const ledger = new LifecycleLedger({ label: 'ambient-audio-test' });
  const audio = createAmbientAudio({ profile: 'default', ledger });
  assert.equal(ledger.snapshot().counts.handle, 1, 'the ledger owns the surface');

  audio.dispose();
  assert.equal(ledger.snapshot().counts.handle, 0, 'the ledger releases the surface');
  assert.equal(audio.diagnostics().counters.disposeCount, 1);
  audio.dispose();
  assert.equal(audio.diagnostics().counters.disposed, 1, 'a second dispose is counted, never an error');

  // A ledger-side release tears the voices down too.
  const context = stubAudioContext();
  const second = createAmbientAudio({ profile: 'default', context, ledger });
  second.setZones([{ id: 'water-a', kind: GDO_AMBIENT_KINDS.WATER, x: 0, z: 0, radius: 12, gain: 0.9 }]);
  second.update({ listenerX: 0, listenerZ: 0, nowMilliseconds: 3000 });
  ledger.disposeAll();
  assert.equal(second.disposed, true);
});
