import test from "node:test";
import assert from "node:assert/strict";
import { SOUND_RECIPES, SOUNDS_KEY, MIN_GAP_MS, RELEASE_S, sampleCue, cueDuration, createRoomSounds, cueForNewItems, notificationKey, soundsEnabled, setSoundsEnabled } from "../src/room-sounds.js";
import { renderCue } from "../scripts/render-room-sounds.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: k => map.has(k) ? map.get(k) : null, setItem: (k, v) => map.set(k, String(v)) };
}

// A fake Web Audio graph that records what was scheduled and rejects any
// method the player is not expected to call.
function fakeAudio() {
  const made = { contexts: 0, oscillators: 0, resumes: 0 };
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} });
  const node = extra => Object.assign({ connect: next => next ?? node() }, extra);
  class Ctx {
    constructor() { made.contexts++; this.state = "suspended"; this.currentTime = 0; this.destination = node(); }
    resume() { made.resumes++; this.state = "running"; return Promise.resolve(); }
    createGain() { return node({ gain: param() }); }
    createOscillator() { made.oscillators++; return node({ type: "", frequency: param(), start() {}, stop() {} }); }
  }
  return { Ctx, made };
}

test("every cue stays well under full scale and ends in silence (no clip, no click)", () => {
  for (const [name, recipe] of Object.entries(SOUND_RECIPES)) {
    const samples = renderCue(recipe);
    const peak = samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
    assert.ok(peak > 0.05 && peak < 0.5, `${name} peak ${peak}`);
    for (const tone of recipe.tones) {
      assert.ok(tone.dur > RELEASE_S + tone.attack, `${name} tone long enough for its release`);
      const alone = { gain: recipe.gain, tones: [tone] };
      assert.ok(Math.abs(sampleCue(alone, tone.start + tone.dur - 1e-6)) < 0.001, `${name} tone ends in silence`);
    }
    assert.ok(cueDuration(recipe) <= 1, `${name} is short`);
  }
});

test("the setting defaults to on and persists off", () => {
  const storage = memoryStorage();
  assert.equal(soundsEnabled(storage), true);
  setSoundsEnabled(false, storage);
  assert.equal(storage.getItem(SOUNDS_KEY), "off");
  assert.equal(soundsEnabled(storage), false);
  assert.equal(soundsEnabled({ getItem() { throw new Error("blocked"); } }), true, "blocked storage falls back to on");
});

test("no sound before a user gesture, when off, or twice inside the gap", () => {
  const { Ctx, made } = fakeAudio(), storage = memoryStorage();
  let clock = 1000;
  const sounds = createRoomSounds({ AudioContextCtor: Ctx, storage, now: () => clock });
  assert.equal(sounds.play("forYou"), false, "locked before a gesture");
  assert.equal(made.contexts, 0);
  sounds.unlock();
  assert.equal(made.resumes, 1);
  assert.equal(sounds.play("forYou"), true);
  const perCue = made.oscillators;
  assert.equal(perCue, SOUND_RECIPES.forYou.tones.reduce((n, t) => n + t.partials.length, 0));
  clock += MIN_GAP_MS - 1;
  assert.equal(sounds.play("done"), false, "rate limited");
  clock += 1;
  assert.equal(sounds.play("done"), true);
  clock += MIN_GAP_MS;
  setSoundsEnabled(false, storage);
  assert.equal(sounds.play("forYou"), false, "off");
  assert.equal(sounds.play("nope"), false, "unknown cue");
  assert.equal(made.contexts, 1, "one context reused");
});

test("no audio support is a silent no-op", () => {
  const sounds = createRoomSounds({ AudioContextCtor: undefined, storage: memoryStorage() });
  sounds.unlock();
  assert.equal(sounds.play("forYou"), false);
});

test("cue selection: new items only; finished work outranks for-you; quiet kinds stay quiet", () => {
  const mention = { kind: "mention", messageId: "m1", sequence: 10 };
  const done = { kind: "work_update", workItemId: "w1", sequence: 12, eventType: T.WORK_COMPLETED };
  const progress = { kind: "work_update", workItemId: "w2", sequence: 13, eventType: T.WORK_PROGRESS_REPORTED ?? "work.progress_reported" };
  const decision = { kind: "access_decision", eventId: "e1", sequence: 14 };
  assert.equal(cueForNewItems([mention], new Set()), "forYou");
  assert.equal(cueForNewItems([mention], new Set([notificationKey(mention)])), null, "already seen");
  assert.equal(cueForNewItems([mention, done], new Set()), "done");
  assert.equal(cueForNewItems([progress, decision], new Set()), null);
  assert.equal(cueForNewItems([{ kind: "reply", messageId: "m2", sequence: 3 }], new Set()), "forYou");
  // A coalesced item that gets a newer event is a new arrival.
  const again = { ...mention, sequence: 20 };
  assert.equal(cueForNewItems([again], new Set([notificationKey(mention)])), "forYou");
  assert.equal(cueForNewItems(undefined, new Set()), null);
});
