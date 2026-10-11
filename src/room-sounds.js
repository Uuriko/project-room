import { uiText } from './strings.js';
// Project Room sound cues (assets v0). Opt-in, off by default, per room and
// per browser. A cue plays only when the room's setting is on and the tab is
// visible, at most once every 1.5 s. Browsers can't read the OS mute switch;
// they do follow system volume. Every failure (no Audio, autoplay refused,
// storage blocked, offline) stays silent and never affects the caller.
// stop-confirm and message-tick are designed but not shipped: no Stop cue
// until execution stop is acknowledged reliably (#2510).
export const CUES = Object.freeze(['result-ready', 'picked-up', 'needs-you']);
const MIN_GAP_MS = 1500;
// Which ask display-status transitions deserve a sound. Everything else is silent.
export function cueFor(prev, next) {
  if (!next || !prev || prev === next) return null;
  if (next === 'done') return 'result-ready';
  if (next === 'working' && ['asked', 'not_picked_up', 'queued'].includes(prev)) return 'picked-up';
  if (next === 'needs_input') return 'needs-you';
  return null;
}
export function soundsSettingKey(roomId) { return `room.sounds:${roomId}`; }
export function soundsEnabled(roomId, storage = globalThis.localStorage) {
  try { return Boolean(roomId) && storage?.getItem(soundsSettingKey(roomId)) === '1'; } catch { return false; }
}
export function setSoundsEnabled(roomId, on, storage = globalThis.localStorage) {
  try { if (on) storage?.setItem(soundsSettingKey(roomId), '1'); else storage?.removeItem(soundsSettingKey(roomId)); return true; } catch { return false; }
}
// The audio bytes live in room-sound-data.js and load only on the first play.
const loadSoundData = () => import('./room-sound-data.js').then(module => module.SOUND_DATA);
export function createRoomSounds({ enabled = () => false, doc = globalThis.document, Audio = globalThis.Audio, now = () => Date.now(), load = loadSoundData } = {}) {
  let last = -Infinity, data = null;
  const cache = new Map();
  // preview is only for the explicit sample the setting plays when turned on.
  function play(name, { preview = false } = {}) {
    if (!CUES.includes(name) || !Audio) return false;
    if (!preview && (!enabled() || doc?.visibilityState === 'hidden' || now() - last < MIN_GAP_MS)) return false;
    last = now();
    const start = sounds => {
      try {
        let audio = cache.get(name);
        if (!audio) { audio = new Audio(sounds[name]); cache.set(name, audio); }
        audio.currentTime = 0; audio.play()?.catch?.(() => {});
      } catch { /* no audio here: stay quiet */ }
    };
    if (data && !(data instanceof Promise)) start(data);
    else (data ||= load()).then(sounds => { data = sounds; start(sounds); }, () => { data = null; });
    return true;
  }
  return { play };
}
// Watches ask runs and returns the cue for a real transition:
// - only for runs the viewer started,
// - never on the first sighting of a run (page load, reconnect, replay),
// - result-ready only once the run carries a stored result message,
// - at most once per run and state across tabs (best effort via storage).
export function createAskCues({ viewerId, storage = globalThis.localStorage } = {}) {
  const seen = new Map();
  const claimOnce = (runId, state) => {
    const key = `room.sounds.cued:${runId}`;
    try { if (storage?.getItem(key) === state) return false; storage?.setItem(key, state); } catch { /* storage blocked: this tab still dedupes */ }
    return true;
  };
  return function observe(run, displayStatus) {
    if (!run?.id || !displayStatus) return null;
    const prev = seen.get(run.id);
    seen.set(run.id, displayStatus);
    const viewer = typeof viewerId === 'function' ? viewerId() : viewerId;
    if (prev === undefined || !viewer || run.initiatorId !== viewer) return null;
    const cue = cueFor(prev, displayStatus);
    if (!cue || (cue === 'result-ready' && !run.resultMessageId)) return null;
    return claimOnce(run.id, displayStatus) ? cue : null;
  };
}
// One call for the ask card: askSounds(run, displayStatus). Wiring is one
// line where the card's data-face-status changes (left to the card's owner).
export function installAskSounds({ getRoomId, getViewerId, storage = globalThis.localStorage, ...options } = {}) {
  const sounds = createRoomSounds({ enabled: () => soundsEnabled(getRoomId?.(), storage), ...options });
  const observe = createAskCues({ viewerId: () => getViewerId?.(), storage });
  return (run, displayStatus) => { const cue = observe(run, displayStatus); return cue ? sounds.play(cue) : false; };
}
// The per-room setting: a labelled checkbox, off by default. Turning it on
// plays one sample, so the person hears what they chose (and the first play
// follows a user gesture). The caller re-syncs it when the room changes.
export function mountSoundSetting(container, { getRoomId, storage = globalThis.localStorage, doc = globalThis.document, sounds } = {}) {
  if (!container || !doc) return null;
  const preview = sounds ?? createRoomSounds();
  const label = doc.createElement('label'); label.className = 'room-sound-setting';
  const input = doc.createElement('input'); input.type = 'checkbox'; input.id = 'room-sound-setting';
  const text = doc.createElement('span'); text.textContent = uiText('sounds.setting.label');
  label.append(input, text); container.append(label);
  const sync = () => { input.checked = soundsEnabled(getRoomId?.(), storage); };
  input.addEventListener('change', () => {
    const roomId = getRoomId?.();
    if (!roomId || !setSoundsEnabled(roomId, input.checked, storage)) { sync(); return; }
    if (input.checked) preview.play('result-ready', { preview: true });
  });
  sync();
  return { input, sync };
}
