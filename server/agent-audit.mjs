// Read model over the room event log (and the receipt rows that wrap those
// events). One actor's actions, newest first: time, action, target, result.
// Message text is never copied. The owner and the agent can read; anyone
// else gets a 403 with one next step. No store and no route: a denial is a
// value, not an HTTP error, until the route lands.

export const AGENT_AUDIT_DEFAULT_LIMIT = 50;
export const AGENT_AUDIT_MAX_LIMIT = 1000;

const MESSAGE_RESULT = Object.freeze({
  "message.posted": "posted",
  "message.edited": "edited",
  "message.deleted": "deleted",
  "message.redacted": "redacted",
  "dm.posted": "posted",
});
const TARGET_KEYS = Object.freeze([
  "workItemId", "claimId", "messageId", "memberId", "identityId", "inviteId", "targetId", "channelId",
]);
const RESULT_KEYS = Object.freeze(["state", "verdict", "status", "outcome", "ciState", "action", "result"]);
const ACTION_TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const RESULT_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

function denial(status, code, message, hint, command) {
  const next = Object.freeze([Object.freeze({ command })]);
  return Object.freeze({
    ok: false,
    status,
    code,
    message,
    hint,
    next,
    body: Object.freeze({
      error: Object.freeze({ code, message }),
      status: "action_required",
      reason: code,
      hint,
      next,
    }),
  });
}

function isPrivateRoom(room) {
  if (!room || typeof room !== "object") return false;
  if (room.private === true) return true;
  return room.visibility === "private";
}

function viewerMayRead(viewer, memberId) {
  if (!viewer || typeof viewer !== "object" || typeof viewer.memberId !== "string" || viewer.memberId.length === 0) return false;
  if (viewer.memberId === memberId) return true;
  if (viewer.isOwner === true) return true;
  if (typeof viewer.ownerId === "string" && viewer.ownerId.length > 0 && viewer.ownerId === viewer.memberId) return true;
  return false;
}

function pick(data, keys, pattern) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && pattern.test(value)) return value;
  }
  return null;
}

function projectAction(event, privateRoom) {
  const data = event.data;
  const messageResult = MESSAGE_RESULT[event.type];
  if (messageResult) {
    return Object.freeze({
      time: typeof event.at === "string" ? event.at : null,
      action: event.type,
      // A private room row does not carry the message id. The text stays out
      // either way: body, text, and note are not target or result fields.
      target: privateRoom ? null : pick(data, TARGET_KEYS, ID_TOKEN),
      result: messageResult,
    });
  }
  return Object.freeze({
    time: typeof event.at === "string" ? event.at : null,
    action: event.type,
    target: pick(data, TARGET_KEYS, ID_TOKEN),
    result: pick(data, RESULT_KEYS, RESULT_TOKEN),
  });
}

// Receipt row, eventsAfter row, or a raw event. Index is the fallback order
// when the log sequence is missing.
function unwrap(row, index) {
  if (!row || typeof row !== "object") return null;
  let event = null;
  let sequence = null;
  if (row.entry && typeof row.entry === "object" && row.entry.event && typeof row.entry.event === "object") {
    event = row.entry.event;
    sequence = row.entry.sequence ?? row.seq;
  } else if (row.event && typeof row.event === "object" && typeof row.event.type === "string") {
    event = row.event;
    sequence = row.sequence;
  } else if (typeof row.type === "string" && typeof row.actorId === "string") {
    event = row;
    sequence = row.sequence;
  } else return null;
  if (typeof event.type !== "string" || !ACTION_TOKEN.test(event.type)) return null;
  if (typeof event.actorId !== "string" || event.actorId.length === 0) return null;
  if (!Number.isSafeInteger(sequence) || sequence < 0) sequence = index + 1;
  const id = typeof event.id === "string" ? event.id : "";
  return { sequence, id, event };
}

const CURSOR_DENIAL = () => denial(422, "invalid_audit_cursor", "That audit cursor is not from this agent.",
  "Drop the cursor and read the first page.",
  "Read the audit again with no cursor.");

function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  if (typeof cursor !== "string") return CURSOR_DENIAL();
  let parsed;
  try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
  catch { return CURSOR_DENIAL(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !Number.isSafeInteger(parsed.s) || parsed.s < 0
    || (parsed.i !== undefined && typeof parsed.i !== "string")) return CURSOR_DENIAL();
  return { sequence: parsed.s, id: typeof parsed.i === "string" ? parsed.i : "" };
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ s: row.sequence, i: row.id }), "utf8").toString("base64url");
}

function olderThan(row, cursor) {
  if (row.sequence !== cursor.sequence) return row.sequence < cursor.sequence;
  return row.id < cursor.id;
}

export function readAgentAudit({ viewer, memberId, events, cursor = null, limit = AGENT_AUDIT_DEFAULT_LIMIT, room = null } = {}) {
  if (!viewerMayRead(viewer, memberId)) {
    return denial(403, "agent_audit_forbidden", "Only the room owner or this agent can read this audit.",
      "Ask the room owner to open this audit.",
      "Ask the room owner to open this agent's audit.");
  }
  if (typeof memberId !== "string" || memberId.length === 0 || memberId.length > 128) {
    return denial(422, "invalid_agent_audit", "Name the agent whose audit you want.",
      "Use the member id from the room roster.",
      "Read the roster, then request that member's audit.");
  }
  if (!Array.isArray(events)) {
    return denial(422, "invalid_agent_audit", "Audit events must be a list.",
      "Pass the room event log or its receipt rows.",
      "Read the audit from the room event log.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_AUDIT_MAX_LIMIT) {
    return denial(422, "invalid_audit_limit", "Page size must be a whole number from 1 to 1000.",
      "Ask again with the page size omitted, or from 1 to 1000.",
      "Read the audit again with no limit.");
  }
  const position = decodeCursor(cursor);
  if (position && position.ok === false) return position;
  const privateRoom = isPrivateRoom(room);
  const rows = [];
  for (let index = 0; index < events.length; index += 1) {
    const row = unwrap(events[index], index);
    if (!row || row.event.actorId !== memberId) continue;
    if (position && !olderThan(row, position)) continue;
    rows.push(row);
  }
  rows.sort((a, b) => (a.sequence !== b.sequence ? b.sequence - a.sequence : (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)));
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;
  return Object.freeze({
    ok: true,
    memberId,
    actions: Object.freeze(page.map(row => projectAction(row.event, privateRoom))),
    nextCursor,
  });
}
