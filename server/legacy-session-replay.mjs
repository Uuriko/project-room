// Explicit operator reconstruction only. Never a public command/replay default.
import { applyEvent, EVENT_TYPES, emptyRoomState } from '../src/events.js';
// PR749 added exactly these three lifecycle effects to session events. Keep
// every public reducer validation and every other session/permission field.
export function applyPre749SessionEvent(state, incoming) {
  const previous = state.workItems?.[incoming.data?.workItemId]?.state;
  const next = applyEvent(state, incoming), item = next.workItems?.[incoming.data?.workItemId];
  if (incoming.type === EVENT_TYPES.SESSION_STARTED && previous === 'proposed'
  && item?.state === 'accepted') item.state = previous;
  else if (incoming.type === EVENT_TYPES.SESSION_STATUS_CHANGED && incoming.data?.status === 'active'
  && previous === 'accepted' && item?.state === 'working') item.state = previous;
  else if (incoming.type === EVENT_TYPES.SESSION_STOPPED && incoming.data?.status !== 'done'
  && ['accepted', 'working'].includes(previous) && item?.state === 'proposed') item.state = previous;
  return next;
}
export function replayPre749Sessions(events) {
  let state = emptyRoomState();
  for (const incoming of events) state = applyPre749SessionEvent(state, incoming);
  return { ...state, eventLog: [], seenEvents: { }, seenIdempotencyKeys: { } };
}
