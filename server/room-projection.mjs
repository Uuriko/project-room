// Scoped room projection read (RR-D2): return a named slice of the room
// instead of the whole snapshot document.
//
// The slice is cut from the EXISTING viewer-filtered, redacted, windowed
// snapshot (readRoomSnapshot in server/snapshot-window.mjs), so this module
// adds no new auth, visibility, or redaction path: a caller can only ever
// receive classes the shared room read would already have shown them.
//
// Serialisation honesty: this is a WIRE-LEVEL projection. The store still
// materialises the whole room projection server-side (store.snapshot
// spreads room.state) and readRoomSnapshot still builds the windowed
// snapshot before the slice is cut. What this read avoids is SENDING the
// unrequested classes. Serving a slice without the whole load belongs to
// the storage seam (store.snapshot / the stored projection load) and is
// filed as a follow-up packet, not claimed here.
import { readRoomSnapshot } from "./snapshot-window.mjs";

export const PROJECTION_VERSION = 1;

// Named classes -> the snapshot.state keys each class carries. `summary`
// is a derived pseudo-class (counts + the room record), handled separately.
export const PROJECTION_CLASS_KEYS = Object.freeze({
  room: Object.freeze(["room"]),
  members: Object.freeze(["members"]),
  channels: Object.freeze(["channels"]),
  messages: Object.freeze(["messages"]),
  work: Object.freeze(["workItems"]),
  audit: Object.freeze(["eventLog"]),
  pins: Object.freeze(["pins"]),
  bonds: Object.freeze(["bonds"])
});
export const PROJECTION_CLASSES = Object.freeze(["summary", ...Object.keys(PROJECTION_CLASS_KEYS)]);

const CANONICAL_ORDER = new Map(PROJECTION_CLASSES.map((name, index) => [name, index]));

// Parse the `fields` query value: a comma-separated list of class names.
// Returns the requested classes in canonical order, or null for anything
// malformed (missing, empty token, unknown class, duplicate). Returning
// null — never a partial parse — keeps a typo from silently widening or
// narrowing the slice.
export function parseProjectionFields(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const names = raw.split(",").map(part => part.trim());
  if (names.some(name => name === "" || !CANONICAL_ORDER.has(name))) return null;
  if (new Set(names).size !== names.length) return null;
  return Object.freeze(names.sort((a, b) => CANONICAL_ORDER.get(a) - CANONICAL_ORDER.get(b)));
}

function countOf(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

// The summary slice: the room record plus per-class counts. No message
// bodies, no member records, no event payloads — counts only, so a caller
// deciding what to fetch next pays bytes proportional to the room's class
// list, not its history.
export function projectionSummary(snapshot) {
  const state = snapshot?.state ?? {};
  return {
    room: state.room ?? null,
    counts: {
      members: countOf(state.members),
      channels: countOf(state.channels),
      messages: countOf(state.messages),
      workItems: countOf(state.workItems),
      pins: countOf(state.pins),
      eventLog: countOf(state.eventLog),
      bonds: countOf(state.bonds)
    }
  };
}

// Cut `fields` out of a snapshot built by the shared room read. The result
// names what it omitted: `omittedClasses` lists every class present in the
// snapshot that was not requested, so a reader can prove the slice is a
// slice (delivered + omitted = the snapshot's classes) instead of trusting
// that nothing else exists.
export function projectRoomSnapshot(snapshot, fields) {
  const state = snapshot?.state ?? {};
  const requested = new Set(fields);
  const sliced = {};
  const returnedClasses = [];
  for (const [name, keys] of Object.entries(PROJECTION_CLASS_KEYS)) {
    if (!requested.has(name)) continue;
    let carried = false;
    for (const key of keys) {
      if (Object.hasOwn(state, key)) { sliced[key] = state[key]; carried = true; }
    }
    if (carried) returnedClasses.push(name);
  }
  const omittedClasses = [];
  for (const [name, keys] of Object.entries(PROJECTION_CLASS_KEYS)) {
    if (requested.has(name)) continue;
    if (keys.some(key => Object.hasOwn(state, key))) omittedClasses.push(name);
  }
  return {
    projectionVersion: PROJECTION_VERSION,
    roomId: snapshot.roomId,
    sequence: snapshot.sequence,
    fields: [...fields],
    returnedClasses,
    omittedClasses,
    ...(requested.has("summary") ? { summary: projectionSummary(snapshot) } : {}),
    state: sliced,
    ...(requested.has("room") && snapshot.charter !== undefined ? { charter: snapshot.charter } : {}),
    ...(requested.has("messages") && snapshot.messagesWindow !== undefined ? { messagesWindow: snapshot.messagesWindow } : {}),
    ...(requested.has("messages") && snapshot.messagesPage !== undefined ? { messagesPage: snapshot.messagesPage } : {}),
    cursor: snapshot.cursor ?? null,
    catchUpCursor: snapshot.catchUpCursor ?? null,
    viewerId: snapshot.viewerId,
    viewerAccountId: snapshot.viewerAccountId ?? null,
    viewerAuthEpoch: snapshot.viewerAuthEpoch ?? null,
    viewerSessionBinding: snapshot.viewerSessionBinding,
    viewerSessionRevision: snapshot.viewerSessionRevision ?? null
  };
}

// The read itself: the shared windowed snapshot, then the slice. The
// reader is injectable so the contract is testable without a store; the
// route always uses the default (the real shared read).
export function readRoomProjection(store, token, roomId, fence, fields, reader = readRoomSnapshot) {
  const snapshot = reader(store, token, roomId, fence, { view: "full", windowed: true });
  return projectRoomSnapshot(snapshot, fields);
}
