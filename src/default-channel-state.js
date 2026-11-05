import {DEFAULT_CHANNEL_ID} from './events.js';
// Shared original retained-checkpoint/open-time default. Its null timestamp
// fallback intentionally differs from the per-event default.
export function ensureDefaultChannelState(state) {
  if (!state?.room) return false;
  state.channels ??= {};
  if (state.channels[DEFAULT_CHANNEL_ID]) return false;
  state.channels[DEFAULT_CHANNEL_ID] = {
    id: DEFAULT_CHANNEL_ID,
    name: DEFAULT_CHANNEL_ID,
    createdBy: state.room.ownerId,
    createdAt: state.room.createdAt ?? null,
    archivedAt: null
  };
  return true;
}
