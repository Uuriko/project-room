// Room sounds: two short cues, synthesized with Web Audio from the recipes
// below, so there is no audio file to fetch, package or cache.
//
//   forYou  something new is addressed to you (mention, reply, named on work,
//           access request): two soft plucks, a rising fourth.
//   done    work you are on finished: a warm three-note rise.
//
// When they play is decided by the caller (app.js plays only for new unread
// items in your notification feed, never for the feed's first load). This
// module only adds the guards every caller needs: the person's setting, at
// most one cue per MIN_GAP_MS, and no sound before the browser allows audio.
// scripts/render-room-sounds.mjs renders the same recipes to WAV previews.

import { EVENT_TYPES } from "./events.js";

export const SOUNDS_KEY = "project-room-sounds";
export const MIN_GAP_MS = 4000;
// Each tone fades to silence over its last RELEASE_S, so cutting the oscillator
// at `dur` never clicks.
export const RELEASE_S = 0.025;

// A tone is an additive pluck: partials of `freq` (ratio, amplitude), a short
// linear attack, then exponential decay with time constant `tau`. Times are in
// seconds from the start of the cue. Peak level is checked by
// tests/room-sounds.test.js so a cue can never clip.
export const SOUND_RECIPES = Object.freeze({
  forYou: Object.freeze({
    gain: 0.22,
    tones: Object.freeze([
      Object.freeze({ freq: 880.0, start: 0, dur: 0.32, attack: 0.004, tau: 0.09, partials: [[1, 1], [2, 0.22], [3.01, 0.06]] }),
      Object.freeze({ freq: 1174.66, start: 0.085, dur: 0.42, attack: 0.004, tau: 0.13, partials: [[1, 1], [2, 0.18], [3.01, 0.05]] })
    ])
  }),
  done: Object.freeze({
    gain: 0.2,
    tones: Object.freeze([
      Object.freeze({ freq: 523.25, start: 0, dur: 0.5, attack: 0.006, tau: 0.16, partials: [[1, 1], [2, 0.3], [4.2, 0.04]] }),
      Object.freeze({ freq: 659.25, start: 0.075, dur: 0.5, attack: 0.006, tau: 0.16, partials: [[1, 1], [2, 0.28], [4.2, 0.04]] }),
      Object.freeze({ freq: 783.99, start: 0.15, dur: 0.7, attack: 0.006, tau: 0.24, partials: [[1, 1], [2, 0.26], [4.2, 0.05]] })
    ])
  })
});

// Sample-accurate value of one cue at time t (seconds). The browser path and
// the offline renderer both use the same recipe; this is the renderer's math.
export function sampleCue(recipe, t) {
  let value = 0;
  for (const tone of recipe.tones) {
    const local = t - tone.start;
    if (local < 0 || local > tone.dur) continue;
    const release = Math.min(1, (tone.dur - local) / RELEASE_S);
    const envelope = (local < tone.attack ? local / tone.attack : 1) * Math.exp(-local / tone.tau) * release;
    const peak = 1 / tone.partials.reduce((sum, [, a]) => sum + a, 0);
    for (const [ratio, amplitude] of tone.partials) value += amplitude * peak * envelope * Math.sin(2 * Math.PI * tone.freq * ratio * local);
  }
  return value * recipe.gain;
}

export function cueDuration(recipe) {
  return Math.max(...recipe.tones.map(tone => tone.start + tone.dur));
}

function readSetting(storage) {
  try { return storage?.getItem(SOUNDS_KEY) !== "off"; } catch { return true; }
}

export function soundsEnabled(storage = globalThis.localStorage) {
  return readSetting(storage);
}

export function setSoundsEnabled(on, storage = globalThis.localStorage) {
  try { storage?.setItem(SOUNDS_KEY, on ? "on" : "off"); } catch { /* private mode: setting lasts this page only */ }
}

// One player per page. The AudioContext is created lazily on the first user
// gesture (browsers refuse audio before one), and reused after that.
export function createRoomSounds({
  AudioContextCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  storage = globalThis.localStorage,
  now = () => Date.now()
} = {}) {
  let context = null, lastAt = -Infinity, unlocked = false;
  function unlock() {
    unlocked = true;
    if (!AudioContextCtor) return;
    try {
      context ??= new AudioContextCtor();
      if (context.state === "suspended") void context.resume?.();
    } catch { context = null; }
  }
  function schedule(recipe) {
    const start = context.currentTime + 0.01, master = context.createGain();
    master.gain.value = recipe.gain;
    master.connect(context.destination);
    for (const tone of recipe.tones) {
      const at = start + tone.start, peak = 1 / tone.partials.reduce((sum, [, a]) => sum + a, 0);
      for (const [ratio, amplitude] of tone.partials) {
        const osc = context.createOscillator(), env = context.createGain();
        osc.type = "sine";
        osc.frequency.value = tone.freq * ratio;
        env.gain.setValueAtTime(0, at);
        env.gain.linearRampToValueAtTime(amplitude * peak, at + tone.attack);
        // setTargetAtTime decays toward 0 with the recipe's time constant.
        env.gain.setTargetAtTime(0, at + tone.attack, tone.tau);
        const fadeAt = at + tone.dur - RELEASE_S;
        env.gain.setValueAtTime(amplitude * peak * Math.exp(-(tone.dur - RELEASE_S - tone.attack) / tone.tau), fadeAt);
        env.gain.linearRampToValueAtTime(0, at + tone.dur);
        osc.connect(env).connect(master);
        osc.start(at);
        osc.stop(at + tone.dur);
      }
    }
  }
  function play(kind) {
    const recipe = SOUND_RECIPES[kind];
    if (!recipe || !unlocked || !readSetting(storage)) return false;
    const at = now();
    if (at - lastAt < MIN_GAP_MS) return false;
    if (!context) unlock();
    if (!context) return false;
    try { schedule(recipe); } catch { return false; }
    lastAt = at;
    return true;
  }
  return { play, unlock, get unlocked() { return unlocked; } };
}

// Which cue, if any, a batch of notification items deserves. `seen` is the set
// of item keys already shown; a cue plays only for keys not in it. `done`
// outranks `forYou` when both arrive together. A feed item is coalesced per
// target and its `sequence` moves when a newer event lands, so the key changes
// on every new arrival. `done` is a work update whose latest event is the
// completion itself (server/notifications.mjs records it as eventType).
const FOR_YOU = new Set(["mention", "reply", "assignment", "access_request"]);
export function notificationKey(item) {
  return [item.kind, item.messageId ?? item.requestId ?? item.eventId ?? item.workItemId ?? "", item.sequence ?? item.at ?? ""].join(":");
}
export function cueForNewItems(items, seen) {
  let cue = null;
  for (const item of items ?? []) {
    if (seen.has(notificationKey(item))) continue;
    if (item.kind === "work_update" && item.eventType === EVENT_TYPES.WORK_COMPLETED) return "done";
    if (FOR_YOU.has(item.kind)) cue = "forYou";
  }
  return cue;
}
