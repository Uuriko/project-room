import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CUES, VOICES, createRoomSounds, createCueLedger, askCueFor, installAskSounds, mountSoundSetting, soundsEnabled, setSoundsEnabled, defaultStorage } from '../src/ask-sounds.js';
import { publicAssetPaths } from '../deploy/public-assets.mjs';

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };
function memoryStorage() { const m = new Map(); return { map: m, getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; }
const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
// A fake Web Audio context that records which cue voices were scheduled.
function fakeAudio({ state = 'running', resume = () => Promise.resolve() } = {}) {
  const started = [];
  class Ctx {
    constructor() { this.state = state; this.currentTime = 0; this.destination = {}; }
    resume() { return resume(this); }
    createGain() { return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} }, connect() {} }; }
    createOscillator() { return { frequency: { value: 0 }, connect() {}, start() { started.push(this.frequency.value); }, stop() {} }; }
  }
  return { Ctx, started, cues: () => started.length / 4 }; // 2 notes x (fundamental + harmonic)
}
// Web Locks stand-in: one holder at a time, FIFO, like navigator.locks.
function fakeLocks() { let chain = Promise.resolve(); return { request(_name, fn) { const run = chain.then(fn); chain = run.catch(() => {}); return run; } }; }
const visibleDoc = () => { const d = { visibilityState: 'visible' }; return d; };

test('askCueFor keys cues on durable identities, never on status alone', () => {
  const run = { id: 'r1', resultMessageId: 'm1', revision: 4 };
  assert.deepEqual(askCueFor({ status: 'working', resultId: null }, run, 'done'), { cue: 'result-ready', id: 'result:m1' });
  assert.equal(askCueFor({ status: 'working', resultId: null }, { id: 'r1' }, 'done'), null, 'done without a stored result is silent');
  assert.deepEqual(askCueFor({ status: 'done', resultId: null }, run, 'done'), { cue: 'result-ready', id: 'result:m1' }, 'the result arriving after done still cues');
  assert.equal(askCueFor({ status: 'done', resultId: 'm1' }, run, 'done'), null);
  assert.deepEqual(askCueFor({ status: 'asked' }, run, 'working'), { cue: 'picked-up', id: 'pickup:r1' });
  assert.deepEqual(askCueFor({ status: 'working' }, run, 'needs_input'), { cue: 'needs-you', id: 'needs:r1:4' });
  for (const [prev, status] of [['working', 'working'], ['working', 'stalled'], ['asked', 'not_picked_up'], ['working', 'cancelled'], ['cancel_requested', 'cancelled']]) assert.equal(askCueFor({ status: prev }, { id: 'r1' }, status), null, `${prev} -> ${status}`);
  assert.equal(askCueFor(undefined, run, 'done'), null);
});

test('a throwing localStorage getter never escapes, and the setting is off by default and per room', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    assert.equal(defaultStorage(), null);
    assert.equal(soundsEnabled('commons'), false);
    assert.equal(setSoundsEnabled('commons', true), false);
    assert.doesNotThrow(() => createCueLedger().mark('x'));
    assert.doesNotThrow(() => installAskSounds({ getRoomId: () => 'commons', getViewerId: () => 'me', locks: null })({ id: 'r', initiatorId: 'me' }, 'asked'));
  } finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; }
  const s = memoryStorage();
  assert.equal(soundsEnabled('commons', s), false);
  assert.equal(setSoundsEnabled('commons', true, s), true);
  assert.equal(soundsEnabled('commons', s), true);
  assert.equal(soundsEnabled('other', s), false);
  setSoundsEnabled('commons', false, s);
  assert.equal(soundsEnabled('commons', s), false);
  assert.equal(soundsEnabled('commons', blocked), false);
  assert.equal(setSoundsEnabled('commons', true, blocked), false);
});

test('sounds are silent unless enabled and visible, rate-limited, and only preview bypasses', () => {
  const audio = fakeAudio(); let t = 0; const state = { on: false }, doc = visibleDoc();
  const sounds = createRoomSounds({ enabled: () => state.on, AudioContext: audio.Ctx, doc, now: () => t });
  assert.equal(sounds.play('result-ready'), false);
  assert.equal(sounds.play('result-ready', { force: true }), false, 'no other bypass');
  state.on = true; doc.visibilityState = 'hidden';
  assert.equal(sounds.play('needs-you'), false);
  doc.visibilityState = 'visible';
  assert.equal(sounds.play('needs-you'), true);
  t += 500; assert.equal(sounds.play('needs-you'), false);
  t += 1100; assert.equal(sounds.play('picked-up'), true);
  assert.equal(sounds.play('agent-chatter', { preview: true }), false);
  assert.equal(audio.cues(), 2);
  state.on = false; assert.equal(sounds.play('result-ready', { preview: true }), true);
});

test('a delayed audio unlock re-checks mute and visibility, and never plays a backlog', async () => {
  let release; const audio = fakeAudio({ state: 'suspended', resume: ctx => new Promise(r => { release = () => { ctx.state = 'running'; r(); }; }) });
  let t = 0; const state = { on: true }, doc = visibleDoc();
  const sounds = createRoomSounds({ enabled: () => state.on, AudioContext: audio.Ctx, doc, now: () => t });
  sounds.play('picked-up'); t += 2000; sounds.play('needs-you'); t += 2000; sounds.play('result-ready');
  release(); await flush();
  assert.equal(audio.cues(), 1, 'only the newest queued cue');
  assert.equal(audio.started[0], VOICES['result-ready'][0][0]);
  const muted = fakeAudio({ state: 'suspended', resume: ctx => new Promise(r => { release = () => { ctx.state = 'running'; r(); }; }) });
  const later = createRoomSounds({ enabled: () => state.on, AudioContext: muted.Ctx, doc, now: () => t });
  later.play('result-ready'); state.on = false; release(); await flush();
  assert.equal(muted.started.length, 0, 'muted while unlocking: silent');
  state.on = true; const hidden = fakeAudio({ state: 'suspended', resume: ctx => new Promise(r => { release = () => { ctx.state = 'running'; r(); }; }) });
  const third = createRoomSounds({ enabled: () => state.on, AudioContext: hidden.Ctx, doc, now: () => t });
  third.play('result-ready'); doc.visibilityState = 'hidden'; release(); await flush();
  assert.equal(hidden.started.length, 0, 'hidden while unlocking: silent');
  const refused = fakeAudio({ state: 'suspended', resume: () => Promise.reject(new Error('NotAllowedError')) });
  doc.visibilityState = 'visible';
  assert.doesNotThrow(() => createRoomSounds({ enabled: () => true, AudioContext: refused.Ctx, doc }).play('needs-you'));
  class Throwing { constructor() { throw new Error('no audio'); } }
  assert.equal(createRoomSounds({ enabled: () => true, AudioContext: Throwing, doc }).play('needs-you'), false);
  assert.equal(createRoomSounds({ enabled: () => true, AudioContext: undefined, doc }).play('needs-you'), false);
  await flush();
});

function tab({ storage, locks, viewer = 'me', on = true, doc = visibleDoc() }) {
  if (on) setSoundsEnabled('commons', true, storage);
  const audio = fakeAudio(); let t = 0;
  const sounds = createRoomSounds({ enabled: () => soundsEnabled('commons', storage), AudioContext: audio.Ctx, doc, now: () => (t += 2000) });
  return { audio, doc, observe: installAskSounds({ getRoomId: () => 'commons', getViewerId: () => viewer, storage, locks, sounds }) };
}

test('cues fire only for live transitions of the viewer\'s own asks', async () => {
  const storage = memoryStorage(), a = tab({ storage, locks: fakeLocks() });
  assert.equal(await a.observe({ id: 'old', initiatorId: 'me', resultMessageId: 'm0' }, 'done'), false, 'first sighting is silent');
  const mine = { id: 'r1', initiatorId: 'me' };
  assert.equal(await a.observe(mine, 'asked'), false);
  assert.equal(await a.observe(mine, 'working'), true, 'picked-up');
  assert.equal(await a.observe(mine, 'working'), false, 'repaint');
  assert.equal(await a.observe(mine, 'done'), false, 'no stored result yet');
  assert.equal(await a.observe({ ...mine, resultMessageId: 'm1' }, 'done'), true, 'result arrives after done: still cues');
  assert.equal(await a.observe({ ...mine, resultMessageId: 'm1' }, 'asked'), false);
  assert.equal(await a.observe({ ...mine, resultMessageId: 'm1' }, 'working'), false, 'picked-up is once per run');
  assert.equal(await a.observe({ ...mine, resultMessageId: 'm1' }, 'done'), false, 'done -> asked -> working -> done does not re-chime');
  const theirs = { id: 'r3', initiatorId: 'sam' };
  await a.observe(theirs, 'working');
  assert.equal(await a.observe({ ...theirs, resultMessageId: 'm3' }, 'done'), false);
  assert.equal(a.audio.cues(), 2);
  const off = tab({ storage: memoryStorage(), locks: null, on: false });
  await off.observe(mine, 'working');
  assert.equal(await off.observe({ ...mine, resultMessageId: 'm1' }, 'done'), false, 'setting off');
});

test('across tabs: one cue per identity, old results stay quiet, and a hidden tab never takes the cue', async () => {
  const storage = memoryStorage(), locks = fakeLocks();
  const a = tab({ storage, locks }), b = tab({ storage, locks });
  const run = { id: 'r2', initiatorId: 'me' };
  await Promise.all([a.observe(run, 'working'), b.observe(run, 'working')]);
  const done = { ...run, resultMessageId: 'm2' };
  const results = await Promise.all([a.observe(done, 'done'), b.observe(done, 'done')]);
  assert.deepEqual(results.filter(Boolean).length, 1, 'concurrent tabs: exactly one chime');
  const reload = tab({ storage, locks });
  await reload.observe({ id: 'r4', initiatorId: 'me', resultMessageId: 'm4' }, 'done');
  const other = tab({ storage, locks });
  await other.observe({ id: 'r4', initiatorId: 'me' }, 'working');
  assert.equal(await other.observe({ id: 'r4', initiatorId: 'me', resultMessageId: 'm4' }, 'done'), false, 'a result first seen finished is recorded durably');
  const hiddenDoc = visibleDoc(); hiddenDoc.visibilityState = 'hidden';
  const hidden = tab({ storage, locks, doc: hiddenDoc }), shown = tab({ storage, locks });
  const r5 = { id: 'r5', initiatorId: 'me' };
  await hidden.observe(r5, 'working'); await shown.observe(r5, 'working');
  assert.equal(await hidden.observe({ ...r5, resultMessageId: 'm5' }, 'done'), false);
  assert.equal(await shown.observe({ ...r5, resultMessageId: 'm5' }, 'done'), true, 'the visible tab still gets it');
});

test('the cue ledger is bounded and tolerates blocked or corrupt storage', async () => {
  const storage = memoryStorage(), ledger = createCueLedger({ storage, locks: null });
  for (let i = 0; i < 10000; i += 1) await ledger.claim(`result:m${i}`);
  assert.ok(JSON.parse(storage.getItem('room.askSounds.cued')).length <= 200);
  assert.equal(await ledger.claim('result:m9999'), false);
  storage.setItem('room.askSounds.cued', '{not json');
  assert.equal(await createCueLedger({ storage, locks: null }).claim('result:new'), true);
  const noStore = createCueLedger({ storage: blocked, locks: null });
  assert.equal(await noStore.claim('result:x'), false, 'no durable record, no cue');
  const failingLocks = { request() { return Promise.reject(new Error('lock')); } };
  assert.equal(await createCueLedger({ storage, locks: failingLocks }).claim('result:y'), false, 'a lock failure stays quiet');
});

function fakeDoc() {
  const el = tag => ({ tag, children: [], listeners: {}, append(...c) { this.children.push(...c); }, addEventListener(type, fn) { this.listeners[type] = fn; } });
  return { createElement: el };
}
test('the sound setting control is off by default, per room, previews once, and reverts if it cannot save', () => {
  const doc = fakeDoc(), container = { children: [], append(c) { this.children.push(c); } }, storage = memoryStorage();
  const previews = []; const sounds = { play: (name, opts) => previews.push([name, opts]) };
  let room = 'commons';
  const ui = mountSoundSetting(container, { getRoomId: () => room, storage, doc, sounds });
  assert.equal(ui.input.type, 'checkbox'); assert.equal(ui.input.checked, false);
  assert.match(container.children[0].children[1].textContent, /Play sounds in this room/);
  ui.input.checked = true; ui.input.listeners.change();
  assert.equal(soundsEnabled('commons', storage), true);
  assert.deepEqual(previews, [['result-ready', { preview: true }]]);
  room = 'other'; ui.sync(); assert.equal(ui.input.checked, false);
  const failing = mountSoundSetting(container, { getRoomId: () => 'commons', storage: blocked, doc, sounds });
  failing.input.checked = true; failing.input.listeners.change();
  assert.equal(failing.input.checked, false);
});

test('cues are synthesized in code: no audio files, no media fetch, CSP unchanged', () => {
  assert.deepEqual(Object.keys(VOICES).sort(), [...CUES].sort());
  const source = readFileSync(new URL('../src/ask-sounds.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /new Audio\b|data:audio|\.mp3|\.ogg|fetch\(/);
  assert.ok(publicAssetPaths.includes('src/ask-sounds.js'));
  assert.ok(publicAssetPaths.includes('src/ask-motion.css'));
  const edge = readFileSync(new URL('../cloudflare/edge-public.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(edge, /media-src/, 'no CSP widening was needed');
});

test('ask status motion is linked, finite, and only runs without a reduced-motion preference', () => {
  assert.match(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /<link rel="stylesheet" href="\.\/src\/ask-motion\.css">/);
  const css = readFileSync(new URL('../src/ask-motion.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\binfinite\b/);
  const start = css.indexOf('@media (prefers-reduced-motion: no-preference)');
  assert.ok(start > 0);
  assert.doesNotMatch(css.slice(0, start), /\banimation\s*:/, 'no animation outside the no-preference block');
  for (const m of css.slice(start).matchAll(/animation:[^;]*?\s(\d+)(?:\s+both)?;/g)) assert.ok(Number(m[1]) <= 3, m[0]);
  for (const state of ['asked', 'working', 'done', 'not_picked_up', 'stalled', 'failed']) assert.match(css, new RegExp(`data-face-status="${state}"`));
});

function unlockable() {
  let release; const audio = fakeAudio({ state: 'suspended', resume: ctx => new Promise(r => { release = () => { ctx.state = 'running'; r(); }; }) });
  return { audio, release: () => release() };
}

test('a pending sample is cancelled by turning the setting off or hiding the tab', async () => {
  const doc = visibleDoc();
  let u = unlockable(); let s = createRoomSounds({ AudioContext: u.audio.Ctx, doc });
  s.play('result-ready', { preview: true }); s.cancel(); u.release(); await flush();
  assert.equal(u.audio.started.length, 0, 'cancelled');
  u = unlockable(); s = createRoomSounds({ AudioContext: u.audio.Ctx, doc });
  s.play('result-ready', { preview: true }); doc.visibilityState = 'hidden'; u.release(); await flush();
  assert.equal(u.audio.started.length, 0, 'hidden');
  doc.visibilityState = 'visible'; u = unlockable(); s = createRoomSounds({ AudioContext: u.audio.Ctx, doc });
  s.play('result-ready', { preview: true }); u.release(); await flush();
  assert.equal(u.audio.cues(), 1, 'an intentional audition still plays');
  const dom = fakeDoc(), container = { children: [], append(c) { this.children.push(c); } }, storage = memoryStorage();
  u = unlockable(); s = createRoomSounds({ AudioContext: u.audio.Ctx, doc });
  const ui = mountSoundSetting(container, { getRoomId: () => 'commons', storage, doc: dom, sounds: s });
  ui.input.checked = true; ui.input.listeners.change(); ui.input.checked = false; ui.input.listeners.change();
  u.release(); await flush();
  assert.equal(u.audio.started.length, 0, 'on then off before audio unlocks: silent');
});

test('the rate-limit gap counts from real playback, not from a delayed request', async () => {
  const u = unlockable(); let t = 0;
  const s = createRoomSounds({ enabled: () => true, AudioContext: u.audio.Ctx, doc: visibleDoc(), now: () => t });
  s.play('picked-up'); t = 5000; u.release(); await flush();
  assert.equal(u.audio.cues(), 1);
  t = 5001; assert.equal(s.play('result-ready'), false, '1 ms after actual playback is too soon');
  t = 6600; assert.equal(s.play('result-ready'), true);
});

test('marking an old result takes the same lock and never overwrites another tab\'s claim', async () => {
  const storage = memoryStorage(), locks = fakeLocks();
  const a = createCueLedger({ storage, locks }), b = createCueLedger({ storage, locks });
  await Promise.all([a.claim('result:m1'), b.mark('result:m2'), a.claim('result:m3'), b.mark('result:m4')]);
  assert.deepEqual(JSON.parse(storage.getItem('room.askSounds.cued')).sort(), ['result:m1', 'result:m2', 'result:m3', 'result:m4']);
});

test('a readable ledger that cannot be written reports no claim and plays nothing', async () => {
  const storage = memoryStorage(); setSoundsEnabled('commons', true, storage);
  const quota = { getItem: k => storage.getItem(k), setItem(k, v) { if (k === 'room.askSounds.cued') throw new Error('QuotaExceededError'); storage.setItem(k, v); }, removeItem: k => storage.removeItem(k) };
  assert.equal(await createCueLedger({ storage: quota, locks: null }).claim('result:q'), false);
  const audio = fakeAudio(); let t = 0;
  const sounds = createRoomSounds({ enabled: () => soundsEnabled('commons', quota), AudioContext: audio.Ctx, doc: visibleDoc(), now: () => (t += 2000) });
  const observe = installAskSounds({ getRoomId: () => 'commons', getViewerId: () => 'me', storage: quota, locks: null, sounds });
  await observe({ id: 'rq', initiatorId: 'me' }, 'working');
  assert.equal(await observe({ id: 'rq', initiatorId: 'me', resultMessageId: 'mq' }, 'done'), false);
  assert.equal(audio.started.length, 0);
});
