// Sizes of one room's stored projection. Numbers and fixed component names
// only: this never returns message text, member names, ids, or secrets.
// The components of a stored row sum to its byte length. Detail rows sit
// inside those components (a receipt card is part of messages) or name
// bytes that are not on rooms.projection at all.

export const PROJECTION_CAP_BYTES = 4 * 1024 * 1024;

const COMPONENT_OF = new Map([
  ["messages", "messages"],
  ["members", "members"],
  ["workItems", "board"],
  ["channels", "channels"],
  ["room", "room"],
  ["messagesArchive", "retainedHistory"],
  ["pins", "retainedHistory"],
  ["replyRequests", "retainedHistory"],
  ["eventLog", "replayBookkeeping"],
  ["seenEvents", "replayBookkeeping"],
  ["seenIdempotencyKeys", "replayBookkeeping"]
]);

const COMPONENT_ORDER = Object.freeze([
  "messages", "members", "board", "channels", "room",
  "retainedHistory", "replayBookkeeping", "other", "framing"
]);

const UNBOUNDED_KEYS = Object.freeze([
  "receiptHistory", "verificationHistory", "decisionHistory",
  "handoffHistory", "attempts", "evidenceWithdrawals"
]);

const NULL_RUN = Object.freeze(["workItemId", "replyToId", "toMemberId"]);
const TRIPLET_BYTES = Buffer.byteLength('"workItemId":null,"replyToId":null,"toMemberId":null');
const MARKER_BYTES = Buffer.byteLength('"_nul":1');

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function messageDetails(messages) {
  const details = {
    count: 0, entityRefs: 0, inlineBodyBytes: 0, bodyRefBytes: 0,
    receiptCards: 0, receiptCardBytes: 0, editHistoryEntries: 0, editHistoryBytes: 0,
    nullTriplets: 0, nullTripletBytes: 0, nullEnvelopes: 0, nullEnvelopeSavedBytes: 0
  };
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    details.count += 1;
    if (message._entity === 1) details.entityRefs += 1;
    if (typeof message.body === "string") details.inlineBodyBytes += Buffer.byteLength(message.body);
    if (typeof message.bodyRef === "string") details.bodyRefBytes += Buffer.byteLength(message.bodyRef);
    if (message.kind === "receipt_card") {
      details.receiptCards += 1;
      details.receiptCardBytes += jsonBytes(message);
    }
    if (Array.isArray(message.editHistory) && message.editHistory.length) {
      details.editHistoryEntries += message.editHistory.length;
      details.editHistoryBytes += jsonBytes(message.editHistory);
    }
    if (NULL_RUN.every(name => message[name] === null)) {
      details.nullTriplets += 1;
      details.nullTripletBytes += TRIPLET_BYTES;
    }
    if (message._nul === 1) {
      details.nullEnvelopes += 1;
      details.nullEnvelopeSavedBytes += TRIPLET_BYTES - MARKER_BYTES;
    }
  }
  return details;
}

function memberDetails(members) {
  const details = { count: 0, statusLines: 0, statusBytes: 0 };
  if (!members || typeof members !== "object") return details;
  for (const member of Object.values(members)) {
    details.count += 1;
    if (typeof member?.statusMessage === "string" && member.statusMessage) {
      details.statusLines += 1;
      details.statusBytes += Buffer.byteLength(member.statusMessage);
    }
  }
  return details;
}

function boardDetails(workItems) {
  const unbounded = {};
  for (const key of UNBOUNDED_KEYS) unbounded[key] = { lists: 0, entries: 0, bytes: 0 };
  const details = { count: 0, entityRefs: 0, inlineBytes: 0, unbounded };
  if (!workItems || typeof workItems !== "object") return details;
  for (const item of Object.values(workItems)) {
    details.count += 1;
    if (item?._workEntity === 1) { details.entityRefs += 1; continue; }
    details.inlineBytes += jsonBytes(item ?? null);
    for (const key of UNBOUNDED_KEYS) {
      const list = item?.[key];
      if (!Array.isArray(list) || !list.length) continue;
      unbounded[key].lists += 1;
      unbounded[key].entries += list.length;
      unbounded[key].bytes += jsonBytes(list);
    }
  }
  return details;
}

// Break a stored rooms.projection value into components. `framing` is the
// object braces plus any byte the per-value encoding does not claim, so the
// components add up to projectionBytes.
export function accountProjection(projectionText, { capBytes = PROJECTION_CAP_BYTES } = {}) {
  if (typeof projectionText !== "string") throw new TypeError("projection text is required");
  const projectionBytes = Buffer.byteLength(projectionText);
  let state;
  try { state = JSON.parse(projectionText); }
  catch { return { projectionBytes, capBytes, readable: false, components: [] }; }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return { projectionBytes, capBytes, readable: false, components: [] };
  }
  const buckets = new Map(COMPONENT_ORDER.map(name => [name, 0]));
  let claimed = 0;
  for (const [index, [key, value]] of Object.entries(state).entries()) {
    const piece = Buffer.byteLength(JSON.stringify(key)) + 1 + jsonBytes(value) + (index === 0 ? 0 : 1);
    claimed += piece;
    const bucket = COMPONENT_OF.get(key) ?? "other";
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + piece);
  }
  buckets.set("framing", projectionBytes - claimed);
  const components = COMPONENT_ORDER.map(name => ({ name, bytes: buckets.get(name) ?? 0 }));
  const messages = Array.isArray(state.messages) ? state.messages : [];
  return {
    projectionBytes,
    capBytes,
    readable: true,
    headroomBytes: capBytes - projectionBytes,
    components,
    messages: messageDetails(messages),
    members: memberDetails(state.members),
    board: boardDetails(state.workItems),
    retainedHistory: {
      archivedMessages: Number.isInteger(state.messagesArchive?.count) ? state.messagesArchive.count : 0,
      pins: Array.isArray(state.pins) ? state.pins.length : 0,
      replyRequests: state.replyRequests && typeof state.replyRequests === "object" ? Object.keys(state.replyRequests).length : 0
    },
    // Job cursors and heartbeats live in their own tables. A room projection
    // has no job record today; the zero is the finding, not an omission.
    jobRecords: { bytes: 0, inProjection: false }
  };
}

function scalar(db, sql, params) {
  try { return Number(db.prepare(sql).get(...params)?.n) || 0; }
  catch { return null; }
}

function unboundedOutside(db, roomId) {
  const totals = {};
  for (const key of UNBOUNDED_KEYS) totals[key] = { lists: 0, entries: 0, bytes: 0 };
  let scanned = 0;
  let rows;
  try {
    rows = db.prepare("SELECT body FROM work_entities WHERE room_id=? LIMIT 500").all(roomId);
  } catch { return null; }
  for (const row of rows) {
    scanned += 1;
    let item;
    try { item = JSON.parse(row.body); } catch { continue; }
    for (const key of UNBOUNDED_KEYS) {
      const list = item?.[key];
      if (!Array.isArray(list) || !list.length) continue;
      totals[key].lists += 1;
      totals[key].entries += list.length;
      totals[key].bytes += jsonBytes(list);
    }
  }
  return { scanned, unbounded: totals };
}

// Read-only sizes for one room: the projection breakdown plus the tables
// that hold the bytes the 4 MiB cap does not count.
export function accountStoredRoom(db, roomId) {
  const row = db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId);
  if (!row || typeof row.projection !== "string") return null;
  const account = accountProjection(row.projection);
  account.outsideProjection = {
    projectionBodiesBytes: scalar(db, "SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS n FROM projection_bodies WHERE room_id=?", [roomId]),
    messageBodiesBytes: scalar(db, "SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS n FROM messages WHERE room_id=?", [roomId]),
    messageRecordsBytes: scalar(db, "SELECT COALESCE(SUM(length(CAST(record_json AS BLOB))), 0) AS n FROM messages WHERE room_id=?", [roomId]),
    messageExtrasBytes: scalar(db, "SELECT COALESCE(SUM(length(CAST(reducer_extras_json AS BLOB))), 0) AS n FROM messages WHERE room_id=?", [roomId]),
    messageRows: scalar(db, "SELECT COUNT(*) AS n FROM messages WHERE room_id=?", [roomId]),
    workEntityBytes: scalar(db, "SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS n FROM work_entities WHERE room_id=?", [roomId]),
    workClaimBytes: scalar(db, "SELECT COALESCE(SUM(length(CAST(item_json AS BLOB))), 0) AS n FROM work_claims WHERE room_id=?", [roomId]),
    workClaimHistoryBytes: scalar(db, "SELECT COALESCE(SUM(length(CAST(stamp_json AS BLOB))), 0) AS n FROM work_claim_history WHERE room_id=?", [roomId]),
    eventBytes: scalar(db, "SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS n FROM events WHERE room_id=?", [roomId]),
    workEntityHistories: unboundedOutside(db, roomId)
  };
  return account;
}

// Sizes for the room with the longest stored projection. The room id stays
// in this function; the result is the same numbers accountStoredRoom returns.
export function largestProjectionAccount(db) {
  let row;
  try {
    row = db.prepare("SELECT id FROM rooms ORDER BY length(CAST(projection AS BLOB)) DESC LIMIT 1").get();
  } catch { return null; }
  if (typeof row?.id !== "string") return null;
  return accountStoredRoom(db, row.id);
}
