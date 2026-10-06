// Squads (plan-squads): named groups with a goal, a member roster, and a
// channel that is a room thread (the thread-root message id; the thread is
// derived from message replyToId chains, see server/activity.mjs).
//
// Design note (posted to muse-room): a squad is NOT a tagged work-claim.
// Claims carry lease expiry, review policy, and claim-pr-sync polling —
// squad-as-claim would rot in the sweep, be miscounted as work, and claims
// have no members field. One small additive table instead.
//
// @squad/<name> in a message fans out through the mention lifecycle: this
// module only resolves handles to member ids; store.mjs inserts one
// mention_states row per member (reusing delivery/ack/timeout), exactly
// like a direct @mention. server/mention-lifecycle.mjs is untouched.
import { randomUUID } from "node:crypto";
import { ServiceError } from "./service-error.mjs";
import { MAX_MESSAGE_BODY_CHARS } from "../src/events.js";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const squadSchema = `
  CREATE TABLE IF NOT EXISTS squads (
    room_id TEXT NOT NULL,
    squad_id TEXT NOT NULL,
    name TEXT NOT NULL,
    goal TEXT NOT NULL DEFAULT '',
    members_json TEXT NOT NULL DEFAULT '[]',
    channel_message_id TEXT,
    owner_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','disbanded')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, squad_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS squads_room_name ON squads(room_id, name);
`;

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Pure: the normalized handle, or throws 422.
export function validateSquadName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name.trim())) {
    fail(422, "invalid_squad", "squad name must be 1..64 characters of letters, digits, _ or -");
  }
  return name.trim();
}

// Pure: ordered unique squad handles referenced as @squad/<name>.
// Namespaced so a squad never collides with a member @mention; @_squad/,
// emails, and bare @name are not squad mentions.
export function parseSquadMentions(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_MESSAGE_BODY_CHARS) return [];
  const found = [];
  const re = /(^|[^A-Za-z0-9_.@])@squad\/([A-Za-z0-9_-]{1,64})/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const name = match[2].toLowerCase();
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

function parseMembers(json) {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.filter(id => typeof id === "string") : [];
  } catch { return []; }
}

// Public view of one squad row.
export function squadView(row) {
  return {
    id: row.squad_id, name: row.name, goal: row.goal ?? "",
    members: parseMembers(row.members_json),
    channel: row.channel_message_id ?? null,
    owner: row.owner_id, state: row.state,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function activeMemberIds(room, ids) {
  const members = room?.state?.members ?? {};
  return [...new Set(ids)].filter(id => {
    const m = members[id];
    return m && m.active !== false;
  });
}

function getRow(db, roomId, squadId) {
  return db.prepare("SELECT * FROM squads WHERE room_id=? AND squad_id=?").get(roomId, squadId)
    ?? db.prepare("SELECT * FROM squads WHERE room_id=? AND lower(name)=lower(?)").get(roomId, squadId);
}

// Store-level read used by the claim routes to validate a squad target.
export function getActiveSquad(db, roomId, squadId) {
  if (typeof squadId !== "string" || !squadId) return null;
  const row = getRow(db, roomId, squadId);
  return row && row.state === "active" ? squadView(row) : null;
}

// Fanout resolution for the store.mjs mention hooks: active member ids for
// every @squad/<name> in the text. Never the sender; never inactive members;
// never disbanded squads; DMs (toMemberId set) do not fan out.
export function squadMentionTargets(db, roomId, text, senderMemberId, members, toMemberId = null) {
  if (toMemberId) return [];
  const names = parseSquadMentions(text);
  if (names.length === 0) return [];
  const rows = db.prepare("SELECT name, members_json FROM squads WHERE room_id=? AND state='active'").all(roomId);
  const byName = new Map(rows.map(r => [String(r.name).toLowerCase(), r]));
  const out = [];
  for (const name of names) {
    const row = byName.get(name);
    if (!row) continue;
    for (const id of parseMembers(row.members_json)) {
      if (id === senderMemberId || out.includes(id)) continue;
      const m = members?.[id];
      if (!m || m.active === false) continue;
      out.push(id);
    }
  }
  return out;
}

function mintId() {
  return "sq_" + randomUUID().replace(/-/g, "").slice(0, 12);
}

function checkBody(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail(422, "invalid_squad", "supply a squad object");
  const keys = Object.keys(data);
  const allowed = ["name", "goal", "channelMessageId", "memberIds"];
  if (!keys.includes("name") || keys.some(k => !allowed.includes(k))) {
    fail(422, "invalid_squad", "{name, goal?, channelMessageId?, memberIds?}");
  }
  const name = validateSquadName(data.name);
  if (data.goal !== undefined && (typeof data.goal !== "string" || data.goal.length > 500)) {
    fail(422, "invalid_squad", "goal must be a string of at most 500 characters");
  }
  if (data.channelMessageId !== undefined && data.channelMessageId !== null
    && (typeof data.channelMessageId !== "string" || !data.channelMessageId || data.channelMessageId.length > 384)) {
    fail(422, "invalid_squad", "channelMessageId must be a message id");
  }
  if (data.memberIds !== undefined && (!Array.isArray(data.memberIds)
    || data.memberIds.some(id => typeof id !== "string" || !id || id.length > 128))) {
    fail(422, "invalid_squad", "memberIds must be an array of member ids");
  }
  return { name, goal: data.goal ?? "", channelMessageId: data.channelMessageId ?? null, memberIds: data.memberIds ?? [] };
}

export function listSquads(store, token, roomId, expectedSessionBinding = null) {
  return store.readTransaction(() => {
    store.authenticate(token, roomId, expectedSessionBinding);
    const rows = store.db.prepare("SELECT * FROM squads WHERE room_id=? ORDER BY name").all(roomId);
    return { roomId, squads: rows.map(squadView) };
  });
}

export function getSquad(store, token, roomId, squadId, expectedSessionBinding = null) {
  return store.readTransaction(() => {
    store.authenticate(token, roomId, expectedSessionBinding);
    const row = typeof squadId === "string" ? getRow(store.db, roomId, squadId) : null;
    if (!row) fail(404, "squad_not_found", "No such squad in this room");
    return { roomId, squad: squadView(row) };
  });
}

export function createSquad(store, token, roomId, data, expectedSessionBinding = null) {
  const input = checkBody(data);
  return store.transaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const me = auth.member?.id;
    if (!me) fail(403, "access_denied", "Membership required");
    const room = store.room(roomId);
    if (input.channelMessageId && !room.state.messages.some(m => m.id === input.channelMessageId && !m.deletedAt)) {
      fail(422, "squad_channel_unknown", "channelMessageId is not a live message in this room");
    }
    const members = activeMemberIds(room, [...input.memberIds, me]);
    for (const id of input.memberIds) {
      if (!members.includes(id)) fail(422, "squad_member_unknown", `member "${id}" is not an active member of this room`);
    }
    if (store.db.prepare("SELECT 1 FROM squads WHERE room_id=? AND lower(name)=lower(?)").get(roomId, input.name)) {
      fail(409, "squad_exists", `Squad "${input.name}" already exists in this room`);
    }
    const now = store.now();
    const id = mintId();
    store.db.prepare(`INSERT INTO squads
      (room_id,squad_id,name,goal,members_json,channel_message_id,owner_id,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(roomId, id, input.name, input.goal, JSON.stringify(members),
      input.channelMessageId, me, "active", now, now);
    return { roomId, squad: squadView(store.db.prepare("SELECT * FROM squads WHERE room_id=? AND squad_id=?").get(roomId, id)) };
  });
}

export function updateSquadMembers(store, token, roomId, squadId, data, expectedSessionBinding = null) {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail(422, "invalid_squad", "supply {add?, remove?}");
  const keys = Object.keys(data);
  if (keys.some(k => !["add", "remove"].includes(k))) fail(422, "invalid_squad", "supply {add?, remove?}");
  for (const k of ["add", "remove"]) {
    if (data[k] !== undefined && (!Array.isArray(data[k]) || data[k].some(id => typeof id !== "string" || !id || id.length > 128))) {
      fail(422, "invalid_squad", `${k} must be an array of member ids`);
    }
  }
  return store.transaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const me = auth.member?.id;
    if (!me) fail(403, "access_denied", "Membership required");
    const row = typeof squadId === "string" ? getRow(store.db, roomId, squadId) : null;
    if (!row) fail(404, "squad_not_found", "No such squad in this room");
    if (row.state !== "active") fail(409, "squad_disbanded", "A disbanded squad has no roster changes");
    const isOwner = row.owner_id === me;
    const current = parseMembers(row.members_json);
    const room = store.room(roomId);
    const add = data.add ?? [], remove = data.remove ?? [];
    for (const id of add) {
      if (!isOwner) fail(403, "squad_owner_required", "Only the squad owner can add members");
      if (!activeMemberIds(room, [id]).length) fail(422, "squad_member_unknown", `member "${id}" is not an active member of this room`);
    }
    for (const id of remove) {
      if (!isOwner && id !== me) fail(403, "squad_owner_required", "Only the squad owner can remove other members");
      if (id === row.owner_id) fail(422, "invalid_squad", "The owner cannot be removed from an active squad");
    }
    const next = current.filter(id => !remove.includes(id));
    for (const id of add) if (!next.includes(id)) next.push(id);
    const now = store.now();
    store.db.prepare("UPDATE squads SET members_json=?, updated_at=? WHERE room_id=? AND squad_id=?")
      .run(JSON.stringify(next), now, roomId, row.squad_id);
    return { roomId, squad: squadView({ ...row, members_json: JSON.stringify(next), updated_at: now }) };
  });
}

export function disbandSquad(store, token, roomId, squadId, expectedSessionBinding = null) {
  return store.transaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const me = auth.member?.id;
    if (!me) fail(403, "access_denied", "Membership required");
    const row = typeof squadId === "string" ? getRow(store.db, roomId, squadId) : null;
    if (!row) fail(404, "squad_not_found", "No such squad in this room");
    if (row.owner_id !== me) fail(403, "squad_owner_required", "Only the squad owner can disband it");
    if (row.state === "disbanded") return { roomId, squad: squadView(row), changed: false };
    const now = store.now();
    store.db.prepare("UPDATE squads SET state='disbanded', updated_at=? WHERE room_id=? AND squad_id=?")
      .run(now, roomId, row.squad_id);
    return { roomId, squad: squadView({ ...row, state: "disbanded", updated_at: now }), changed: true };
  });
}
