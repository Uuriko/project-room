import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CUES, cueFor, createRoomSounds, createAskCues, installAskSounds, mountSoundSetting, soundsEnabled, setSoundsEnabled } from '../src/room-sounds.js';
import { SOUND_DATA } from '../src/room-sound-data.js';
import { publicAssetPaths } from '../deploy/public-assets.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function memoryStorage() { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; }
const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
function fakeAudio(played) { return class { constructor(src) { this.src = src; } play() { played.push(this.src); return Promise.resolve(); } }; }
const visible = { visibilityState: 'visible' };
const fakeData = async () => ({ 'result-ready': 'rr', 'picked-up': 'pu', 'needs-you': 'ny' });

test('cueFor only sounds on transitions people need to notice, and never for Stop', () => {
  assert.equal(cueFor('working', 'done'), 'result-ready');
  assert.equal(cueFor('asked', 'working'), 'picked-up');
  assert.equal(cueFor('not_picked_up', 'working'), 'picked-up');
  assert.equal(cueFor('working', 'needs_input'), 'needs-you');
  for (const [a, b] of [['working', 'working'], ['working', 'stalled'], ['asked', 'not_picked_up'], ['working', 'cancelled'], ['cancel_requested', 'cancelled'], [undefined, 'done'], [null, null]]) assert.equal(cueFor(a, b), null, `${a} -> ${b}`);
});

test('the per-room setting is off by default, per room, and quiet when storage is blocked', () => {
  const s = memoryStorage();
  assert.equal(soundsEnabled('commons', s), false);
  assert.equal(setSoundsEnabled('commons', true, s), true);
  assert.equal(soundsEnabled('commons', s), true);
  assert.equal(soundsEnabled('other', s), false);
  setSoundsEnabled('commons', false, s);
  assert.equal(soundsEnabled('commons', s), false);
  assert.equal(soundsEnabled('commons', blocked), false);
  assert.equal(setSoundsEnabled('commons', true, blocked), false);
  assert.equal(soundsEnabled(undefined, s), false);
});

test('sounds stay silent unless enabled and visible, rate-limit bursts, and only preview bypasses', async () => {
  const played = []; let t = 0; const state = { on: false, hidden: false };
  const sounds = createRoomSounds({ load: fakeData, enabled: () => state.on, Audio: fakeAudio(played), doc: { get visibilityState() { return state.hidden ? 'hidden' : 'visible'; } }, now: () => t });
  assert.equal(sounds.play('result-ready'), false);
  assert.equal(sounds.play('result-ready', { force: true }), false, 'no other bypass');
  state.on = true; state.hidden = true;
  assert.equal(sounds.play('needs-you'), false);
  state.hidden = false;
  assert.equal(sounds.play('needs-you'), true);
  t += 500; assert.equal(sounds.play('needs-you'), false);
  t += 1100; assert.equal(sounds.play('picked-up'), true);
  assert.equal(sounds.play('agent-chatter', { preview: true }), false);
  await flush();
  assert.deepEqual(played, ['ny', 'pu']);
  state.on = false;
  assert.equal(sounds.play('result-ready', { preview: true }), true);
});

test('ask cues fire only on live transitions of asks the viewer started, once across tabs', () => {
  const storage = memoryStorage();
  const load = createAskCues({ viewerId: 'me', storage });
  assert.equal(load({ id: 'r0', initiatorId: 'me', resultMessageId: 'm' }, 'done'), null, 'first sighting (load, reconnect, replay) is silent');
  const tab = createAskCues({ viewerId: () => 'me', storage });
  const mine = { id: 'r1', initiatorId: 'me' };
  assert.equal(tab(mine, 'asked'), null);
  assert.equal(tab(mine, 'working'), 'picked-up');
  assert.equal(tab(mine, 'working'), null, 'repaint is silent');
  assert.equal(tab(mine, 'done'), null, 'done without a stored result message is silent');
  const a = createAskCues({ viewerId: 'me', storage }), b = createAskCues({ viewerId: 'me', storage });
  const run = { id: 'r2', initiatorId: 'me', resultMessageId: 'm2' };
  a(run, 'working'); b(run, 'working');
  assert.equal(a(run, 'done'), 'result-ready');
  assert.equal(b(run, 'done'), null, 'a second tab does not re-chime');
  const theirs = createAskCues({ viewerId: 'me', storage });
  theirs({ id: 'r3', initiatorId: 'sam' }, 'working');
  assert.equal(theirs({ id: 'r3', initiatorId: 'sam', resultMessageId: 'm' }, 'done'), null, "someone else's ask never sounds");
  const noStore = createAskCues({ viewerId: 'me', storage: blocked });
  noStore(run, 'working');
  assert.equal(noStore(run, 'done'), 'result-ready', 'blocked storage still dedupes within the tab');
});

test('installAskSounds plays only when the room setting is on', async () => {
  const played = [], storage = memoryStorage();
  const askSounds = installAskSounds({ getRoomId: () => 'commons', getViewerId: () => 'me', storage, Audio: fakeAudio(played), doc: visible, load: fakeData });
  const run = { id: 'r9', initiatorId: 'me', resultMessageId: 'm9' };
  askSounds(run, 'working'); assert.equal(askSounds(run, 'done'), false, 'setting off');
  setSoundsEnabled('commons', true, storage);
  const run2 = { id: 'r10', initiatorId: 'me', resultMessageId: 'm10' };
  askSounds(run2, 'working'); assert.equal(askSounds(run2, 'done'), true);
  await flush();
  assert.deepEqual(played, ['rr']);
});

function fakeDoc() {
  const el = tag => ({ tag, children: [], listeners: {}, append(...c) { this.children.push(...c); }, addEventListener(type, fn) { this.listeners[type] = fn; } });
  return { createElement: el };
}
test('the sound setting control reflects the room, previews once when turned on, and reverts if storage fails', () => {
  const doc = fakeDoc(), container = { children: [], append(c) { this.children.push(c); } }, storage = memoryStorage();
  const previews = []; const sounds = { play: (name, opts) => previews.push([name, opts]) };
  let room = 'commons';
  const ui = mountSoundSetting(container, { getRoomId: () => room, storage, doc, sounds });
  assert.equal(ui.input.type, 'checkbox'); assert.equal(ui.input.checked, false, 'off by default');
  assert.match(container.children[0].children[1].textContent, /Play sounds in this room/);
  ui.input.checked = true; ui.input.listeners.change();
  assert.equal(soundsEnabled('commons', storage), true);
  assert.deepEqual(previews, [['result-ready', { preview: true }]]);
  room = 'other'; ui.sync(); assert.equal(ui.input.checked, false, 'per room');
  const failing = mountSoundSetting(container, { getRoomId: () => 'commons', storage: blocked, doc, sounds });
  failing.input.checked = true; failing.input.listeners.change();
  assert.equal(failing.input.checked, false, 'reverts when the choice cannot be saved');
});

test('audio failures never throw into the caller', async () => {
  class Refusing { play() { return Promise.reject(new Error('NotAllowedError')); } }
  class Throwing { constructor() { throw new Error('no audio'); } }
  for (const Audio of [Refusing, Throwing]) assert.doesNotThrow(() => createRoomSounds({ enabled: () => true, Audio, doc: visible, load: fakeData }).play('needs-you'));
  assert.doesNotThrow(() => createRoomSounds({ enabled: () => true, Audio: class {}, doc: visible, load: () => Promise.reject(new Error('offline')) }).play('needs-you'));
  await flush();
});

test('shipped cues are small embedded MP3 data, loaded lazily, and packaged', () => {
  assert.deepEqual(Object.keys(SOUND_DATA).sort(), [...CUES].sort());
  for (const cue of CUES) {
    const [head, body] = SOUND_DATA[cue].split(',');
    assert.equal(head, 'data:audio/mpeg;base64');
    assert.ok(Buffer.from(body, 'base64').length < 20 * 1024, `${cue} under 20 KB`);
  }
  for (const path of ['src/room-sounds.js', 'src/room-sound-data.js', 'src/ask-motion.css']) assert.ok(publicAssetPaths.includes(path), path);
  assert.doesNotMatch(readFileSync(new URL('../src/room-sounds.js', import.meta.url), 'utf8'), /^import .*room-sound-data/m, 'audio bytes never load with the page');
});

test('ask status motion is linked, finite, and only runs without a reduced-motion preference', () => {
  assert.match(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /<link rel="stylesheet" href="\.\/src\/ask-motion\.css">/);
  const css = readFileSync(new URL('../src/ask-motion.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\binfinite\b/);
  for (const m of css.matchAll(/animation:\s*[\w-]+\s+[\d.]+m?s\s+[^;]*?\s(\d+)(\s|;)/g)) assert.ok(Number(m[1]) <= 3, m[0]);
  const start = css.indexOf('@media (prefers-reduced-motion: no-preference)');
  assert.ok(start > 0);
  assert.doesNotMatch(css.slice(0, start), /\banimation\s*:/, 'no animation outside the no-preference block');
  for (const state of ['asked', 'working', 'done', 'not_picked_up', 'stalled', 'failed']) assert.match(css, new RegExp(`data-face-status="${state}"`));
});
