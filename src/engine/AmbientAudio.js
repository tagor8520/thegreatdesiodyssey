/**
 * GDO `AmbientAudio` — the `gdo:ambientAudio:v1` procedural ambient audio
 * zones (roadmap `ENV-06`).
 *
 * The world's ambience is **generated, never sampled**: every voice this
 * module builds is a noise loop or oscillator run through its own filter and
 * gain — browser-generated audio that is legal by construction, with no
 * packaged or copyrighted material anywhere in the graph. The noise buffer is
 * a fixed-seed LCG so every build sounds the same.
 *
 * Two hard caps are the row's acceptance:
 *
 * - **distance caps** — a zone is audible only inside its own radius and the
 *   profile's `maxDistance`, with a declared falloff; anything past the edge
 *   is silent by data, not by hope.
 * - **activity caps** — at most `maxVoices` procedural voices run at once
 *   (the loudest candidates win, the rest count `zone-over-cap`), the update
 *   loop is rate limited (`updateIntervalMilliseconds`, counting
 *   `update-throttle`), and the habitat beds (birds/insects) follow the
 *   world's own `activity` multiplier so a sleeping city stays quiet.
 *
 * The module runs happily with **no** audio context at all (node tests, a
 * blocked autoplay policy): it counts `no-context` and keeps computing the
 * exact gain/voice plan a context would receive, so the caps and falloffs are
 * deterministically testable. A context, when present, is only ever asked for
 * the declared node types — `createGain`, `createBiquadFilter`,
 * `createBufferSource` + `createBuffer` (a 2 s white-noise loop), and
 * `createOscillator` (a slow tremolo).
 */

import { featureNamespace } from './FeatureVersions.js';

export const GDO_AMBIENT_AUDIO_NAMESPACE = featureNamespace('ambientAudio');

// Local, allocation-free math — this module stays self-contained.
function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Hermite smoothstep on [edge0, edge1]; monotone, clamped, zero outside. */
function smoothstep(edge0, edge1, x) {
  if (!(edge0 < edge1)) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function length2(x, z) {
  return Math.sqrt(x * x + z * z);
}

/** The zone/bed kinds the module knows. Each maps to one voice recipe. */
export const GDO_AMBIENT_KINDS = Object.freeze({
  WATER: 'water',       // TER-07 waterways: river/lake/canal body
  SURF: 'surf',         // shoreline/wetland edge intensity
  WIND: 'wind',         // open-field wind bed
  RAIN: 'rain',         // weather precipitation bed
  BIRDS: 'birds',       // habitat flyers
  INSECTS: 'insects',   // habitat insects
});

export const GDO_AMBIENT_PROFILES = Object.freeze({
  compact: Object.freeze({ maxVoices: 3, maxZones: 12, maxDistance: 22, updateIntervalMilliseconds: 120, fadeMilliseconds: 120 }),
  default: Object.freeze({ maxVoices: 5, maxZones: 24, maxDistance: 34, updateIntervalMilliseconds: 100, fadeMilliseconds: 160 }),
  large: Object.freeze({ maxVoices: 7, maxZones: 40, maxDistance: 48, updateIntervalMilliseconds: 100, fadeMilliseconds: 200 }),
});

/** Voice recipes: filter type + frequency + Q for the one noise source. */
const GDO_AMBIENT_RECIPES = Object.freeze({
  water: Object.freeze({ filter: 'bandpass', frequency: 380, q: 0.9 }),
  surf: Object.freeze({ filter: 'lowpass', frequency: 260, q: 0.6 }),
  wind: Object.freeze({ filter: 'lowpass', frequency: 320, q: 0.4 }),
  rain: Object.freeze({ filter: 'highpass', frequency: 900, q: 0.5 }),
  birds: Object.freeze({ filter: 'bandpass', frequency: 2600, q: 2.2 }),
  insects: Object.freeze({ filter: 'bandpass', frequency: 4200, q: 1.6 }),
});

export const GDO_AMBIENT_REFUSAL = Object.freeze({
  UNKNOWN_KIND: 'unknown-kind',
  MISSING_ZONE_ID: 'missing-zone-id',
  DUPLICATE_ZONE_ID: 'duplicate-zone-id',
  ZONE_CAP: 'zone-cap',
  UPDATE_THROTTLE: 'update-throttle',
  NO_CONTEXT: 'no-context',
  BAD_LISTENER: 'bad-listener',
  ALREADY_DISPOSED: 'already-disposed',
});

const VALID_KINDS = new Set(Object.values(GDO_AMBIENT_KINDS));

/** Distance falloff: full at the zone core, smooth to zero at `radius`. */
function zoneFalloff(distance, radius) {
  if (radius <= 0) return 0;
  if (distance >= radius) return 0;
  return 1 - smoothstep(radius * 0.35, radius, distance);
}

function profileFor(profile) {
  const resolved = GDO_AMBIENT_PROFILES[profile] || GDO_AMBIENT_PROFILES.default;
  return Object.freeze({ ...resolved, id: GDO_AMBIENT_PROFILES[profile] ? profile : 'default' });
}

/** Apply a target gain through whichever setter the graph node offers. */
function applyGain(gainNode, value, fadeSeconds) {
  if (!gainNode) return;
  const gain = gainNode.gain ?? gainNode;
  if (gain && typeof gain.setTargetAtTime === 'function') {
    try {
      gain.setTargetAtTime(value, 0, Math.max(0.01, fadeSeconds));
      return;
    } catch {
      /* fall through to the plain assignment */
    }
  }
  if (gain && typeof gain === 'object' && 'value' in gain) {
    gain.value = value;
    return;
  }
  gainNode.value = value;
}

export function createAmbientAudio(options = {}) {
  const {
    profile = 'default',
    context = null,
    ledger = null,
  } = options;

  const resolvedProfile = profileFor(profile);
  const refusals = Object.create(null);
  const counters = {
    zonesAccepted: 0,
    updates: 0,
    voicesCreated: 0,
    zoneOverCap: 0,
    updateThrottle: 0,
    noContext: 0,
    badListener: 0,
    disposed: 0,
    disposeCount: 0,
    activeVoices: 0,
  };

  let zones = [];
  let lastUpdate = -Infinity;
  let voicePool = new Map();     // kind -> voice record (≤ maxVoices live)
  let disposed = false;

  function refuse(name) {
    refusals[name] = (refusals[name] || 0) + 1;
  }

  // ── graph helpers (context-optional) ─────────────────────────────────────

  function noiseSource() {
    if (!context || typeof context.createBufferSource !== 'function') return null;
    const sampleRate = context.sampleRate || 44100;
    const frames = Math.floor(sampleRate * 2);
    const buffer = context.createBuffer(1, frames, sampleRate);
    const data = buffer.getChannelData(0);
    // Deterministic white noise: a fixed LCG so every build sounds the same.
    let seed = 0x9e3779b9;
    for (let i = 0; i < frames; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 0xffffffff) * 2 - 1;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    return source;
  }

  function buildVoice(kind) {
    if (!context || typeof context.createGain !== 'function') return null;
    const recipe = GDO_AMBIENT_RECIPES[kind] || GDO_AMBIENT_RECIPES.wind;
    const nodes = [];
    const gain = context.createGain();
    nodes.push(gain);
    applyGain(gain, 0, 0.01);
    let head = gain;

    if (typeof context.createBiquadFilter === 'function') {
      const filter = context.createBiquadFilter();
      filter.type = recipe.filter;
      if (filter.frequency) filter.frequency.value = recipe.frequency;
      if (filter.Q) filter.Q.value = recipe.q;
      filter.connect(gain);
      nodes.push(filter);
      head = filter;
    }

    const source = noiseSource();
    if (!source) return null;
    nodes.push(source);
    source.connect(head);
    if (typeof source.start === 'function') source.start();

    if (typeof context.createOscillator === 'function' && typeof context.createGain === 'function') {
      // A slow tremolo gives the beds movement without any sample content.
      const lfo = context.createOscillator();
      const lfoGain = context.createGain();
      if (lfo.frequency) lfo.frequency.value = 0.12 + (recipe.frequency % 7) * 0.01;
      if (lfoGain.gain) lfoGain.gain.value = 0.06;
      lfo.connect(lfoGain);
      lfoGain.connect(gain.gain);
      nodes.push(lfo, lfoGain);
      if (typeof lfo.start === 'function') lfo.start();
    }

    if (typeof gain.connect === 'function' && context.destination) gain.connect(context.destination);

    counters.voicesCreated += 1;
    return { kind, nodes, gain };
  }

  function disposeVoice(voice) {
    if (!voice) return;
    for (const node of voice.nodes) {
      try {
        if (node && typeof node.stop === 'function') node.stop();
      } catch { /* already stopped */ }
      try {
        if (node && typeof node.disconnect === 'function') node.disconnect();
      } catch { /* already gone */ }
    }
  }

  function teardown() {
    if (disposed) return false;
    for (const voice of voicePool.values()) disposeVoice(voice);
    voicePool = new Map();
    zones = [];
    disposed = true;
    counters.disposeCount += 1;
    return true;
  }

  // ── the surface ──────────────────────────────────────────────────────────

  function setZones(next) {
    if (disposed) {
      refuse(GDO_AMBIENT_REFUSAL.ALREADY_DISPOSED);
      return { refused: true, reason: GDO_AMBIENT_REFUSAL.ALREADY_DISPOSED };
    }
    const list = Array.isArray(next) ? next : [];
    const accepted = [];
    const seen = new Set();
    let refused = 0;
    for (const zone of list) {
      const id = zone && typeof zone.id === 'string' && zone.id ? zone.id : null;
      const kind = zone && typeof zone.kind === 'string' ? zone.kind : null;
      if (!id) {
        refuse(GDO_AMBIENT_REFUSAL.MISSING_ZONE_ID);
        refused += 1;
        continue;
      }
      if (!kind || !VALID_KINDS.has(kind)) {
        refuse(GDO_AMBIENT_REFUSAL.UNKNOWN_KIND);
        refused += 1;
        continue;
      }
      if (seen.has(id)) {
        refuse(GDO_AMBIENT_REFUSAL.DUPLICATE_ZONE_ID);
        refused += 1;
        continue;
      }
      if (accepted.length >= resolvedProfile.maxZones) {
        refuse(GDO_AMBIENT_REFUSAL.ZONE_CAP);
        refused += 1;
        continue;
      }
      seen.add(id);
      accepted.push(Object.freeze({
        id,
        kind,
        x: Number.isFinite(zone.x) ? zone.x : 0,
        z: Number.isFinite(zone.z) ? zone.z : 0,
        radius: clamp(Number.isFinite(zone.radius) ? zone.radius : resolvedProfile.maxDistance, 0, resolvedProfile.maxDistance),
        gain: clamp(Number.isFinite(zone.gain) ? zone.gain : 0.6, 0, 1),
      }));
      counters.zonesAccepted += 1;
    }
    zones = accepted;
    return { refused, accepted: accepted.length };
  }

  /**
   * Recompute the audible plan and apply it. `weather` is any record carrying
   * the `ENV-04` fields (`wind.strength`, `precipitation`, `habitat`), and
   * `activity` (0..1) is the shared life-activity multiplier.
   */
  function update(input = {}) {
    if (disposed) {
      refuse(GDO_AMBIENT_REFUSAL.ALREADY_DISPOSED);
      return { refused: true, reason: GDO_AMBIENT_REFUSAL.ALREADY_DISPOSED };
    }
    const now = Number.isFinite(input.nowMilliseconds) ? input.nowMilliseconds : 0;
    if (counters.updates > 0 && now - lastUpdate < resolvedProfile.updateIntervalMilliseconds) {
      refuse(GDO_AMBIENT_REFUSAL.UPDATE_THROTTLE);
      counters.updateThrottle += 1;
      return { refused: true, reason: GDO_AMBIENT_REFUSAL.UPDATE_THROTTLE };
    }
    lastUpdate = now;
    counters.updates += 1;

    const listenerX = Number.isFinite(input.listenerX) ? input.listenerX : null;
    const listenerZ = Number.isFinite(input.listenerZ) ? input.listenerZ : null;
    if (listenerX === null || listenerZ === null) {
      refuse(GDO_AMBIENT_REFUSAL.BAD_LISTENER);
      counters.badListener += 1;
      return { refused: true, reason: GDO_AMBIENT_REFUSAL.BAD_LISTENER };
    }

    const weather = input.weather && typeof input.weather === 'object' ? input.weather : null;
    const windStrength = clamp01(weather && weather.wind ? weather.wind.strength : 0);
    const gustiness = clamp01(weather && weather.wind ? weather.wind.gustiness : 0);
    const precipitation = weather && typeof weather.precipitation === 'string' ? weather.precipitation : 'none';
    const habitat = weather && weather.habitat ? weather.habitat : null;
    const activity = clamp01(Number.isFinite(input.activity) ? input.activity : 1);
    const fadeSeconds = resolvedProfile.fadeMilliseconds / 1000;

    // Distance plan for positional zones (TER-07 waterways, shoreline).
    const candidates = [];
    for (const zone of zones) {
      const distance = length2(zone.x - listenerX, zone.z - listenerZ);
      const falloff = zoneFalloff(distance, Math.min(zone.radius, resolvedProfile.maxDistance));
      if (falloff <= 0) continue;
      candidates.push({ kind: zone.kind, id: zone.id, gain: zone.gain * falloff });
    }

    // Global beds from the ENV-04 state (no position: always "near").
    const rainGain = precipitation === 'rain' ? 0.72 : precipitation === 'dust' ? 0.16 : 0;
    if (rainGain > 0) candidates.push({ kind: GDO_AMBIENT_KINDS.RAIN, id: 'bed:rain', gain: rainGain });
    const windGain = 0.22 + windStrength * 0.55 + gustiness * 0.12;
    candidates.push({ kind: GDO_AMBIENT_KINDS.WIND, id: 'bed:wind', gain: windGain });
    if (habitat) {
      const birdGain = 0.34 * clamp01(habitat.flyers) * lerp(0.35, 1, activity);
      const insectGain = 0.28 * clamp01(habitat.insects) * lerp(0.25, 1, activity);
      if (birdGain > 0.01) candidates.push({ kind: GDO_AMBIENT_KINDS.BIRDS, id: 'bed:birds', gain: birdGain });
      if (insectGain > 0.01) candidates.push({ kind: GDO_AMBIENT_KINDS.INSECTS, id: 'bed:insects', gain: insectGain });
    }

    // Activity cap: the loudest `maxVoices` candidates keep a voice.
    candidates.sort((a, b) => b.gain - a.gain || (a.id < b.id ? -1 : 1));
    const winners = candidates.slice(0, resolvedProfile.maxVoices);
    const over = candidates.length - winners.length;
    if (over > 0) {
      counters.zoneOverCap += over;
    }

    if (!context) {
      if (counters.noContext === 0) refuse(GDO_AMBIENT_REFUSAL.NO_CONTEXT);
      counters.noContext += 1;
      counters.activeVoices = winners.length;
      return {
        refused: false,
        voices: winners,
        dropped: over,
        applied: false,
      };
    }

    // Retire voices for kinds that fell out of the plan; build missing ones.
    const wanted = new Map();
    for (const winner of winners) {
      if (!wanted.has(winner.kind)) wanted.set(winner.kind, winner.gain);
      else wanted.set(winner.kind, Math.max(wanted.get(winner.kind), winner.gain));
    }
    for (const [kind, voice] of voicePool) {
      if (!wanted.has(kind)) {
        disposeVoice(voice);
        voicePool.delete(kind);
      }
    }
    for (const [kind, gain] of wanted) {
      let voice = voicePool.get(kind);
      if (!voice) {
        voice = buildVoice(kind);
        if (!voice) {
          refuse(GDO_AMBIENT_REFUSAL.NO_CONTEXT);
          counters.noContext += 1;
          continue;
        }
        voicePool.set(kind, voice);
      }
      applyGain(voice.gain, gain, fadeSeconds);
    }
    counters.activeVoices = voicePool.size;

    return { refused: false, voices: winners, dropped: over, applied: true };
  }

  function diagnostics() {
    return {
      namespace: GDO_AMBIENT_AUDIO_NAMESPACE,
      profile: resolvedProfile.id,
      maxVoices: resolvedProfile.maxVoices,
      maxZones: resolvedProfile.maxZones,
      maxDistance: resolvedProfile.maxDistance,
      zoneCount: zones.length,
      activeVoices: counters.activeVoices,
      counters: { ...counters },
      refusals: { ...refusals },
      disposed,
    };
  }

  const handle = ledger?.own?.('handle', GDO_AMBIENT_AUDIO_NAMESPACE, null, () => {
    teardown();
  }) ?? null;

  return Object.freeze({
    namespace: GDO_AMBIENT_AUDIO_NAMESPACE,
    profile: resolvedProfile,
    setZones,
    update,
    diagnostics,
    dispose() {
      if (!teardown()) {
        counters.disposed += 1;
        return;
      }
      handle?.release?.();
    },
    get disposed() { return disposed; },
  });
}
