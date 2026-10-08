// The Summons: the room calls the agent by name.
//
// Every onboarding flow is newcomer → room: the agent arrives, proves
// itself, and hunts for work. A summons inverts it. A member posts a
// standing, public call for capabilities the room needs; the call persists
// in the room, outliving its poster's session. The moment the room learns
// what a member can do — capabilities.advertised, usually minutes after
// arrival — the room answers with a public summons.called event naming
// them: "we have been holding this for someone like you." Posting a
// summons likewise calls every member whose advertised capabilities
// already match. Answering is a public, celebrated first act
// (summons.answered), and the table below stays the source of truth; the
// events are the timeline-visible fanfare (same split as
// server/work-claim-events.mjs).
//
// This is the room → agent complement to work-wants (agent → room opt-in
// wakes) and work-matchmaking (seeker-initiated): the want exists before
// the agent does, so a stranger's first minute can feel expected rather
// than cold. Matching is an explainable label intersection, deliberately
// not a ranker — "why was I called" must have an answer a human can check.
import { randomUUID } from "node:crypto";
import { EVENT_TYPES } from "../src/events.js";
import { appendRoomEvent, stableEventId } from "./receipt-cards.mjs";

export const SUMMONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS room_summons (
    room_id TEXT NOT NULL,
    id TEXT NOT NULL,
    labels TEXT NOT NULL,
    note TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','answered','withdrawn')) DEFAULT 'open',
    answered_by TEXT,
    answered_at INTEGER,
    PRIMARY KEY (room_id, id)
  );
  CREATE INDEX IF NOT EXISTS room_summons_open ON room_summons(room_id, status);
  CREATE TABLE IF NOT EXISTS room_summons_calls (
    room_id TEXT NOT NULL,
    summons_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    called_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, summons_id, member_id)
  );`;

export const SUMMONS_STATUSES = Object.freeze(["open", "answered", "withdrawn"]);
const MAX_LABELS = 8;
const MAX_NOTE = 500;
const LABEL = /^[a-z0-9][a-z0-9._:-]{0,39}$/;

export class SummonsInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "SummonsInputError";
    this.code = "invalid_request";
  }
}

// A summons names the capabilities it is calling for in the room's shared
// label vocabulary (the same shape as work-wants labels), plus a human
// note saying what is actually needed.
export function normalizeSummonsInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SummonsInputError("Send { labels, note }");
  }
  const { labels, note } = input;
  if (!Array.isArray(labels) || labels.length === 0 || labels.length > MAX_LABELS) {
    throw new SummonsInputError(`labels must be a list of 1 to ${MAX_LABELS} entries`);
  }
  const clean = [];
  for (const entry of labels) {
    const normalized = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (!LABEL.test(normalized)) {
      throw new SummonsInputError("labels entries are 1 to 40 characters of a-z, 0-9, \".\", \"_\", \":\" or \"-\"");
    }
    if (!clean.includes(normalized)) clean.push(normalized);
  }
  const text = typeof note === "string" ? note.trim() : "";
  if (!text) throw new SummonsInputError("note is required");
  if (text.length > MAX_NOTE) throw new SummonsInputError(`note must be at most ${MAX_NOTE} characters`);
  return { labels: clean, note: text };
}

// Pure: which open summonses does this capability list answer? Returns the
// summonses with the labels that matched, so the call can say exactly why.
export function matchSummons(openSummons, capabilities) {
  const caps = new Set(
    (Array.isArray(capabilities) ? capabilities : [])
      .filter(entry => typeof entry === "string")
      .map(entry => entry.trim().toLowerCase())
      .filter(Boolean)
  );
  if (caps.size === 0) return [];
  const hits = [];
  for (const summons of openSummons ?? []) {
    if (!summons || summons.status !== "open") continue;
    const matchedLabels = (summons.labels ?? []).filter(label => caps.has(label));
    if (matchedLabels.length) hits.push({ summons, matchedLabels });
  }
  return hits;
}

const parseLabels = text => {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.filter(entry => typeof entry === "string") : [];
  } catch {
    return [];
  }
};

const view = row => row ? {
  id: row.id,
  roomId: row.room_id,
  labels: parseLabels(row.labels),
  note: row.note,
  createdBy: row.created_by,
  createdAt: new Date(row.created_at).toISOString(),
  status: row.status,
  answeredBy: row.answered_by ?? null,
  answeredAt: row.answered_at == null ? null : new Date(row.answered_at).toISOString(),
} : null;

export function createSummons(db, roomId, input, { byMemberId, now } = {}) {
  const { labels, note } = normalizeSummonsInput(input);
  if (typeof byMemberId !== "string" || !byMemberId) throw new SummonsInputError("byMemberId is required");
  const at = Number.isFinite(now) ? now : Date.now();
  const id = `smn_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db.prepare(`INSERT INTO room_summons(room_id, id, labels, note, created_by, created_at, status)
    VALUES(?,?,?,?,?,?,'open')`).run(roomId, id, JSON.stringify(labels), note, byMemberId, at);
  return getSummons(db, roomId, id);
}

export function listSummons(db, roomId, { status = "open" } = {}) {
  if (status !== "all" && !SUMMONS_STATUSES.includes(status)) throw new SummonsInputError("unknown status");
  const rows = status === "all"
    ? db.prepare("SELECT * FROM room_summons WHERE room_id=? ORDER BY created_at ASC").all(roomId)
    : db.prepare("SELECT * FROM room_summons WHERE room_id=? AND status=? ORDER BY created_at ASC").all(roomId, status);
  return rows.map(view);
}

export function getSummons(db, roomId, id) {
  if (typeof id !== "string" || !id) return null;
  return view(db.prepare("SELECT * FROM room_summons WHERE room_id=? AND id=?").get(roomId, id));
}

// Answering is the newcomer's public first act. The summoner's own call is
// not answerable — withdraw it instead.
export function answerSummons(db, roomId, id, { byMemberId, now } = {}) {
  const summons = getSummons(db, roomId, id);
  if (!summons) throw new SummonsInputError("summons not found");
  if (summons.status === "answered") throw new SummonsInputError("summons already answered");
  if (summons.status !== "open") throw new SummonsInputError("summons is not open");
  if (summons.createdBy === byMemberId) throw new SummonsInputError("cannot answer your own summons");
  const at = Number.isFinite(now) ? now : Date.now();
  db.prepare("UPDATE room_summons SET status='answered', answered_by=?, answered_at=? WHERE room_id=? AND id=?")
    .run(byMemberId, at, roomId, id);
  return getSummons(db, roomId, id);
}

export function withdrawSummons(db, roomId, id, { now } = {}) {
  const summons = getSummons(db, roomId, id);
  if (!summons) throw new SummonsInputError("summons not found");
  if (summons.status !== "open") throw new SummonsInputError("summons is not open");
  const at = Number.isFinite(now) ? now : Date.now();
  db.prepare("UPDATE room_summons SET status='withdrawn' WHERE room_id=? AND id=?").run(roomId, id);
  return { ...getSummons(db, roomId, id), withdrawnAt: new Date(at).toISOString() };
}

const nameOf = (state, memberId) => {
  const member = state?.members?.[memberId];
  const name = member?.displayName;
  return typeof name === "string" && name.trim() ? name.trim() : memberId;
};

const ownerOf = state => state?.room?.ownerId ?? null;

const insertCall = db => db.prepare(
  "INSERT OR IGNORE INTO room_summons_calls(room_id, summons_id, member_id, called_at) VALUES(?,?,?,?)");

const summonsCard = (state, summons) => ({
  id: summons.id,
  labels: summons.labels,
  note: summons.note,
  summonerId: summons.createdBy,
  summonerDisplayName: nameOf(state, summons.createdBy),
  createdAt: summons.createdAt,
});

// The room answers the moment it learns what a member can do. One call per
// (summons, member) ever: the calls table is the idempotency record, and
// the stable event id makes even a double-append a no-op.
export function noteCapabilitiesAdvertised(store, roomId, memberId, capabilities, { now } = {}) {
  if (!store?.db || typeof memberId !== "string" || !memberId) return null;
  const atMs = Number.isFinite(now) ? now : Date.now();
  let room;
  try {
    room = store.room(roomId);
  } catch {
    return null;
  }
  const state = room?.state;
  const member = state?.members?.[memberId];
  if (!member || member.active === false) return null;
  const fresh = [];
  const insert = insertCall(store.db);
  for (const { summons } of matchSummons(listSummons(store.db, roomId, { status: "open" }), capabilities)) {
    if (insert.run(roomId, summons.id, memberId, atMs).changes === 1) fresh.push(summons);
  }
  if (!fresh.length) return null;
  const actorId = ownerOf(state);
  if (!actorId) return null;
  const id = stableEventId("sc", `${roomId}\0${memberId}\0${fresh.map(s => s.id).sort().join(",")}`);
  return appendRoomEvent(store, roomId, {
    id,
    type: EVENT_TYPES.SUMMONS_CALLED,
    actorId,
    atMs,
    data: {
      calledMemberId: memberId,
      calledDisplayName: nameOf(state, memberId),
      trigger: "capabilities_advertised",
      summons: fresh.map(s => summonsCard(state, s)),
    },
  });
}

// Posting a summons calls the members the room already knows can answer —
// each by name, each once. The summoner is never called on their own post.
export function noteSummonsIssued(store, roomId, summons, { now } = {}) {
  if (!store?.db || !summons || summons.status !== "open") return [];
  const atMs = Number.isFinite(now) ? now : Date.now();
  let room;
  try {
    room = store.room(roomId);
  } catch {
    return [];
  }
  const state = room?.state;
  const actorId = ownerOf(state);
  if (!actorId) return [];
  const calls = [];
  const insert = insertCall(store.db);
  for (const memberId of Object.keys(state?.members ?? {})) {
    const member = state.members[memberId];
    if (!member || member.active === false || memberId === summons.createdBy) continue;
    if (!matchSummons([summons], member.capabilities).length) continue;
    if (insert.run(roomId, summons.id, memberId, atMs).changes !== 1) continue;
    const id = stableEventId("sc", `${roomId}\0${summons.id}\0${memberId}`);
    const appended = appendRoomEvent(store, roomId, {
      id,
      type: EVENT_TYPES.SUMMONS_CALLED,
      actorId,
      atMs,
      data: {
        calledMemberId: memberId,
        calledDisplayName: nameOf(state, memberId),
        trigger: "summons_issued",
        summons: [summonsCard(state, summons)],
      },
    });
    if (appended) calls.push({ memberId, sequence: appended.sequence });
  }
  return calls;
}

// store.command() postamble: the room answers the moment it learns what a
// member can do, over every transport (HTTP commands, MCP, internal).
// Best-effort — the caller wraps this in try/catch so a summons failure
// never fails the command that triggered it.
export function maybeNoteCapabilitiesAdvertised(store, roomId, command, result, notify = noteCapabilitiesAdvertised) {
  if (!command || command.type !== EVENT_TYPES.CAPABILITIES_ADVERTISED) return null;
  if (!result || result.duplicate === true) return null;
  const memberId = result.event?.actorId;
  const capabilities = command.data?.capabilities;
  if (typeof memberId !== "string" || !Array.isArray(capabilities)) return null;
  const now = typeof store?.now === "function" ? store.now() : Date.now();
  return notify(store, roomId, memberId, capabilities, { now });
}
