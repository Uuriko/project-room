import { ownMember } from "../src/events.js";

// Read model over the room event log (and the receipt rows that wrap those
// events). One actor's actions, newest first: time, action, target, result.
// Message text is never copied. The agent can read their own page. Anyone
// else can read it only when state.room.ownerId is their member id. A
// caller-supplied owner flag is not authority. An action in a DM, or in a
// private channel, drops every target id unless that owner is a party or a
// channel member. No store and no route: a denial is a value, not an HTTP
// error, until the route lands.

export const AGENT_AUDIT_DEFAULT_LIMIT = 50;
export const AGENT_AUDIT_MAX_LIMIT = 1000;

const MESSAGE_RESULT = Object.freeze({
  "message.posted": "posted",
  "message.edited": "edited",
  "message.deleted": "deleted",
  "message.redacted": "redacted",
  "dm.posted": "posted",
});
const DM_FOLLOW_UP = new Set([
  "message.edited", "message.deleted", "message.redacted",
  "poll.voted", "message.pinned", "message.unpinned",
]);
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

function stringId(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function partyList(...values) {
  const ids = [];
  for (const value of values) {
    const id = stringId(value);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// Owner is whoever the room projection names. viewer.isOwner and
// viewer.ownerId are ignored, including when they match the caller.
function viewerMayRead(viewer, memberId, state) {
  if (!stringId(viewer?.memberId)) return false;
  if (viewer.memberId === memberId) return true;
  const ownerId = stringId(state?.room?.ownerId);
  return ownerId !== null && ownerId === viewer.memberId;
}

function ownerMatches(ownerId, ids, state) {
  if (!ownerId || ids.length === 0) return false;
  if (ids.includes(ownerId)) return true;
  const identityId = stringId(ownMember(state?.members, ownerId)?.identityId);
  return identityId !== null && ids.includes(identityId);
}

function pick(data, keys, pattern) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && pattern.test(value)) return value;
  }
  return null;
}

// DMs the projection (or this same event list) already knows. Follow-up
// events do not repeat toMemberId, so the parties have to be looked up.
function dmPartyIndex(events, messages) {
  const parties = new Map();
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const id = stringId(message?.id);
      const to = stringId(message?.toMemberId);
      if (id && to) parties.set(id, partyList(message.authorId, to));
    }
  }
  if (!Array.isArray(events)) return parties;
  for (let index = 0; index < events.length; index += 1) {
    const row = unwrap(events[index], index);
    const event = row?.event;
    if (!event || event.type !== "message.posted") continue;
    const to = stringId(event.data?.toMemberId);
    if (!to) continue;
    const id = stringId(event.data?.messageId) || stringId(event.id);
    if (id && !parties.has(id)) parties.set(id, partyList(event.actorId, to));
  }
  return parties;
}

function messageIndex(messages) {
  const byId = new Map();
  if (!Array.isArray(messages)) return byId;
  for (const message of messages) {
    if (stringId(message?.id)) byId.set(message.id, message);
  }
  return byId;
}

function dmOwnerIsOut(event, ownerId, state, parties) {
  const data = event.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data : {};
  if (event.type === "dm.posted") {
    return !ownerMatches(ownerId, partyList(data.fromIdentityId, data.toIdentityId, data.to, data.toMemberId, event.actorId), state);
  }
  if (event.type === "dm.consent_changed") {
    return !ownerMatches(ownerId, partyList(data.requesterId, data.targetId), state);
  }
  if (event.type === "message.posted" && stringId(data.toMemberId)) {
    return !ownerMatches(ownerId, partyList(event.actorId, data.toMemberId), state);
  }
  if (DM_FOLLOW_UP.has(event.type)) {
    const known = parties.get(stringId(data.messageId));
    if (known) return !ownerMatches(ownerId, known, state);
  }
  return false;
}

function channelMemberIds(channel) {
  if (Array.isArray(channel.memberIds)) return channel.memberIds.filter(id => stringId(id));
  if (channel.members && typeof channel.members === "object") return Object.keys(channel.members).filter(id => stringId(id));
  return [];
}

function channelIsPrivate(channel) {
  return channel.private === true || channel.visibility === "private";
}

function channelFor(event, state, messages) {
  const channels = state?.channels;
  if (!channels || typeof channels !== "object") return null;
  const direct = stringId(event.data?.channelId);
  if (direct && channels[direct] && typeof channels[direct] === "object") return channels[direct];
  const message = messages.get(stringId(event.data?.messageId));
  const fromMessage = stringId(message?.channelId);
  if (fromMessage && channels[fromMessage] && typeof channels[fromMessage] === "object") return channels[fromMessage];
  return null;
}

function privateChannelOwnerIsOut(event, ownerId, state, messages) {
  const channel = channelFor(event, state, messages);
  if (!channel || !channelIsPrivate(channel)) return false;
  return !ownerMatches(ownerId, channelMemberIds(channel), state);
}

function projectAction(event, omitTarget) {
  const data = event.data;
  const messageResult = MESSAGE_RESULT[event.type];
  const target = omitTarget ? null : pick(data, TARGET_KEYS, ID_TOKEN);
  if (messageResult) {
    return Object.freeze({
      time: typeof event.at === "string" ? event.at : null,
      action: event.type,
      // Body, text, and note are not target or result fields, so the text
      // stays out. omitTarget also drops message, channel, and member ids.
      target,
      result: messageResult,
    });
  }
  return Object.freeze({
    time: typeof event.at === "string" ? event.at : null,
    action: event.type,
    target,
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

export function readAgentAudit({ viewer, memberId, events, cursor = null, limit = AGENT_AUDIT_DEFAULT_LIMIT, state = null } = {}) {
  if (!viewerMayRead(viewer, memberId, state)) {
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
  const ownerId = stringId(state?.room?.ownerId);
  const parties = dmPartyIndex(events, state?.messages);
  const messages = messageIndex(state?.messages);
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
    actions: Object.freeze(page.map(row => projectAction(row.event,
      dmOwnerIsOut(row.event, ownerId, state, parties) || privateChannelOwnerIsOut(row.event, ownerId, state, messages)))),
    nextCursor,
  });
}
