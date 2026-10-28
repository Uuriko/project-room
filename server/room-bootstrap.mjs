// One read for opening a room: the shared message window plus the sections
// a client otherwise fetches on its own (attention, presence, horizon, saved, updates).
import { AccessRequests } from "./access-requests.mjs";
import { getReadHorizon, listSaved } from "./activity.mjs";
import { attentionReport } from "./owner-attention.mjs";
import { ServiceError } from "./service-error.mjs";
import { readRoomSnapshot } from "./snapshot-window.mjs";
import { listRoomUpdates } from "./updates.mjs";

function section(fn) {
  try {
    return { available: true, value: fn() };
  } catch (error) {
    // Callers throw their own ServiceError (owner attention does, to stay
    // cycle-free). A 4xx with a code is a section the caller cannot read.
    if (error instanceof ServiceError || (error?.status >= 400 && error.status < 500 && typeof error.code === "string")) {
      return { available: false, code: error.code };
    }
    throw error;
  }
}

export function buildRoomBootstrap(store, token, roomId, fence, { accessRequests = null, watchers = [] } = {}) {
  const requests = accessRequests ?? new AccessRequests(store);
  const snapshot = readRoomSnapshot(store, token, roomId, fence, { view: "full", windowed: true });
  return {
    bootstrapVersion: 1,
    roomId,
    sequence: snapshot.sequence,
    snapshot,
    needsAttention: section(() => attentionReport({ store, accessRequests: requests }, token, roomId, fence, Date.now())),
    presence: section(() => store.presence(token, roomId, watchers, fence)),
    readHorizon: section(() => getReadHorizon(store, token, roomId, {}, fence)),
    saved: section(() => listSaved(store, token, roomId, fence)),
    updates: section(() => listRoomUpdates(store, token, roomId, {}, fence))
  };
}
