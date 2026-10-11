import { uiText } from './strings.js';
// Project Room sound cues (assets v0). Opt-in, off by default, per room and
// per browser. Cues are synthesized with Web Audio oscillators (the same
// partials as the design-sync assets), so there are no audio files and no
// media fetch, and the app CSP stays as it is. A cue plays only when the
// room's setting is on and the tab is visible, at most once every 1.5 s.
// Every failure (no Web Audio, autoplay refused, storage blocked) is silent.
// No Stop cue until execution stop is acknowledged reliably (#2510).
export const CUES = Object.freeze(['result-ready', 'picked-up', 'needs-you']);
// [frequency Hz, start s, decay s, gain]; a quiet 2nd harmonic is added.
export const VOICES = Object.freeze({
  'result-ready': [[659, 0, 0.32, 1], [1109, 0.07, 0.28, 0.8]],
  'picked-up': [[784, 0, 0.06, 0.8], [1047, 0.09, 0.08, 0.8]],
  'needs-you': [[880, 0, 0.07, 1], [880, 0.18, 0.09, 1]],
});
const MIN_GAP_MS = 1500;
const MASTER_GAIN = 0.2; // about -14 dBFS
const RETAIN = 200; // cued identities kept, newest last
const CUED_KEY = 'room.sounds.cued';

// Acquiring localStorage can itself throw (sandboxed frames, blocked cookies).
export function defaultStorage() { try { return globalThis.localStorage ?? null; } catch { return null; } }
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

export function soundsSettingKey(roomId) { return `room.sounds:${roomId}`; }
export function soundsEnabled(roomId, storage = defaultStorage()) {
  return Boolean(roomId) && safe(() => storage?.getItem(soundsSettingKey(roomId)) === '1', false);
}
export function setSoundsEnabled(roomId, on, storage = defaultStorage()) {
  if (!roomId || !storage) return false;
  return safe(() => { if (on) storage.setItem(soundsSettingKey(roomId), '1'); else storage.removeItem(soundsSettingKey(roomId)); return true; }, false);
}

export function createRoomSounds({ enabled = () => false, doc = globalThis.document, AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext, now = () => Date.now() } = {}) {
  let last = -Infinity, ctx = null, pending = null;
  const eligible = () => safe(() => enabled() && doc?.visibilityState !== 'hidden', false);
  function schedule(name) {
    const at = ctx.currentTime + 0.01, master = ctx.createGain();
    master.gain.value = MASTER_GAIN; master.connect(ctx.destination);
    for (const [freq, start, decay, gain] of VOICES[name]) for (const [mult, level] of [[1, 1], [2, 0.18]]) {
      const osc = ctx.createOscillator(), env = ctx.createGain(), t = at + start;
      osc.frequency.value = freq * mult;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(gain * level, t + 0.004);
      env.gain.setTargetAtTime(0, t + 0.004, decay);
      osc.connect(env); env.connect(master); osc.start(t); osc.stop(t + 0.004 + decay * 6);
    }
  }
  // preview is only for the sample the setting plays when someone turns it on.
  function play(name, { preview = false } = {}) {
    if (!CUES.includes(name) || !AudioContext) return false;
    if (!preview && (!eligible() || now() - last < MIN_GAP_MS)) return false;
    last = now();
    try {
      ctx ??= new AudioContext();
      if (ctx.state === 'running') { schedule(name); return true; }
      // Resuming is async and may be refused. Keep only the newest request and
      // re-check the gate when it resolves, so a delayed resume never plays
      // after mute or a hidden tab, and never plays a backlog.
      const first = pending === null; pending = { name, preview };
      if (first) Promise.resolve(ctx.resume()).then(() => {
        const job = pending; pending = null;
        if (job && ctx.state === 'running' && (job.preview || eligible())) schedule(job.name);
      }, () => { pending = null; });
    } catch { return false; }
    return true;
  }
  return { play, eligible };
}

// Durable, bounded record of cued identities shared by tabs. The claim is
// atomic across same-origin tabs through Web Locks when available; without
// it, read-then-write is best effort.
export function createCueLedger({ storage = defaultStorage(), locks = safe(() => globalThis.navigator?.locks, null) } = {}) {
  const memory = new Set();
  const read = () => safe(() => { const list = JSON.parse(storage?.getItem(CUED_KEY) ?? '[]'); return Array.isArray(list) ? list : []; }, []);
  const write = list => safe(() => storage?.setItem(CUED_KEY, JSON.stringify(list.slice(-RETAIN))), undefined);
  const claimNow = id => {
    if (memory.has(id)) return false;
    const list = read(); memory.add(id);
    if (list.includes(id)) return false;
    list.push(id); write(list); return true;
  };
  return {
    // Record without sounding (first sighting of an old result).
    mark(id) { if (!memory.has(id)) { memory.add(id); const list = read(); if (!list.includes(id)) { list.push(id); write(list); } } },
    claim(id) {
      if (memory.has(id)) return Promise.resolve(false);
      if (locks?.request) return Promise.resolve(locks.request('room-sounds-cue', () => claimNow(id))).catch(() => false);
      return Promise.resolve(claimNow(id));
    },
  };
}

// Decide which cue a run update deserves, with a durable identity:
// - only runs the viewer started,
// - never on the first sighting of a run (page load, reconnect, replay);
//   an already finished result seen first is recorded so it never chimes,
// - result-ready keys on the stored result message id, not on status alone,
// - picked-up once per run, needs-you once per run revision.
export function askCueFor(prev, run, displayStatus) {
  if (!prev) return null;
  const resultId = run.resultMessageId ?? null;
  if (displayStatus === 'done' && resultId && resultId !== prev.resultId) return { cue: 'result-ready', id: `result:${resultId}` };
  if (displayStatus === 'working' && ['asked', 'not_picked_up', 'queued'].includes(prev.status)) return { cue: 'picked-up', id: `pickup:${run.id}` };
  if (displayStatus === 'needs_input' && prev.status !== 'needs_input') return { cue: 'needs-you', id: ['needs', run.id, run.revision ?? 0].join(':') };
  return null;
}

// One call for the ask card: askSounds(run, displayStatus). Returns a promise
// of whether a cue played. Only an eligible (enabled and visible) tab claims,
// so a hidden tab never consumes the visible tab's cue.
export function installAskSounds({ getRoomId, getViewerId, storage = defaultStorage(), locks, sounds, ...options } = {}) {
  const player = sounds ?? createRoomSounds({ enabled: () => soundsEnabled(getRoomId?.(), storage), ...options });
  const ledger = createCueLedger({ storage, ...(locks !== undefined ? { locks } : {}) });
  const seen = new Map();
  return (run, displayStatus) => {
    if (!run?.id || !displayStatus) return Promise.resolve(false);
    const prev = seen.get(run.id);
    seen.set(run.id, { status: displayStatus, resultId: run.resultMessageId ?? null });
    const viewer = safe(() => getViewerId?.(), null);
    if (!viewer || run.initiatorId !== viewer) return Promise.resolve(false);
    if (!prev) { if (run.resultMessageId) ledger.mark(`result:${run.resultMessageId}`); return Promise.resolve(false); }
    const next = askCueFor(prev, run, displayStatus);
    if (!next || !player.eligible()) return Promise.resolve(false);
    return ledger.claim(next.id).then(ok => ok && player.play(next.cue));
  };
}

// The per-room setting: a labelled checkbox, off by default. Turning it on
// plays one sample, which also unlocks audio from that user gesture. The
// caller re-syncs it when the room changes.
export function mountSoundSetting(container, { getRoomId, storage = defaultStorage(), doc = globalThis.document, sounds } = {}) {
  if (!container || !doc) return null;
  const preview = sounds ?? createRoomSounds();
  const label = doc.createElement('label'); label.className = 'room-sound-setting';
  const input = doc.createElement('input'); input.type = 'checkbox'; input.id = 'room-sound-setting';
  const text = doc.createElement('span'); text.textContent = uiText('sounds.setting.label');
  label.append(input, text); container.append(label);
  const sync = () => { input.checked = soundsEnabled(safe(() => getRoomId?.(), null), storage); };
  input.addEventListener('change', () => {
    const roomId = safe(() => getRoomId?.(), null);
    if (!setSoundsEnabled(roomId, input.checked, storage)) { sync(); return; }
    if (input.checked) preview.play('result-ready', { preview: true });
  });
  sync();
  return { input, sync };
}
