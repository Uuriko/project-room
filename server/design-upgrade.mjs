// Design upgrade (flag designUpgrade): one task status, the Needs you inbox,
// acknowledgement, and a task result. REST and the room MCP tools share this
// module. Tables are additive and created on first use. Older writers have
// no path to them.
import { ServiceError } from "./service-error.mjs";
import { resolveNamedReviewers, hasCurrentReview } from "./work-claims.mjs";
import { DESIGN_UPGRADE_FLAG, designUpgradeEnabled } from "../src/design-upgrade-flag.js";
import { taskStatusFromClaim, taskStatusFromWork } from "../src/task-status.js";
import { ackState, claimHolderAck, mentionAck } from "../src/ack-state.js";
import { readTaskResult } from "../src/task-result.js";
import { assembleNeedsYou } from "../src/needs-you.js";
import { nextWorkStep } from "../src/workflow.js";
import { validId } from "../src/events.js";

export const DESIGN_UPGRADE_TABLES = Object.freeze([
  "design_upgrade_flags",
  "design_upgrade_acks",
  "design_upgrade_results",
]);

const DESIGN_UPGRADE_TOOLS = new Set([
  "room_needs_you",
  "room_task_status",
  "room_ack_task",
  "room_put_task_result",
  "room_read_task_result",
]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS design_upgrade_flags (
  room_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS design_upgrade_acks (
  room_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  opened_at INTEGER,
  acked_at INTEGER,
  PRIMARY KEY (room_id, subject_kind, subject_id, member_id)
);
CREATE TABLE IF NOT EXISTS design_upgrade_results (
  room_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  links_json TEXT NOT NULL,
  author_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, subject_kind, subject_id)
);
`;

const ensured = new WeakSet();

export function ensureDesignUpgrade(db) {
  if (!db || ensured.has(db)) return;
  db.exec(SCHEMA);
  ensured.add(db);
}

function upgradeError(status, code, message, next) {
  const error = new ServiceError(status, code, message);
  if (next) error.next = next;
  return error;
}

function step(method, path, hint, body) {
  return { method, path, hint, ...(body === undefined ? {} : { body }) };
}

function flagOffNext(roomId) {
  return step("POST", `/api/rooms/${roomId}/design-upgrade`,
    "The room owner turns designUpgrade on. muse-room is on until an owner turns it off.",
    { enabled: true });
}

function cursorNext(roomId) {
  return step("GET", `/api/rooms/${roomId}/needs-you`,
    "Omit cursor for the first page, or pass nextCursor from the previous page. limit is 1 to 50.");
}

function requireRoomId(roomId) {
  if (!validId(roomId)) throw upgradeError(422, "invalid_id", "Invalid id",
    step("GET", "/api/rooms/{roomId}/design-upgrade", "Use the room id, then retry."));
  return roomId;
}

function requireSubjectId(roomId, id) {
  if (!validId(id)) throw upgradeError(422, "invalid_id", "Invalid id",
    step("GET", `/api/rooms/${roomId}/task-status`, "Use the task id from the room, then retry."));
  return id;
}

function requireKind(roomId, kind, allowed) {
  if (!allowed.includes(kind)) throw upgradeError(422, "invalid_kind", "Invalid kind",
    step("GET", `/api/rooms/${roomId}/task-status`, `kind is ${allowed.join(" or ")}.`));
  return kind;
}

function dbOf(store) {
  if (!store?.db?.prepare) throw upgradeError(500, "internal", "Request could not be completed");
  ensureDesignUpgrade(store.db);
  return store.db;
}

function roomState(store, roomId) {
  const room = store.room(roomId);
  return room?.state ?? {};
}

function nowOf(store) {
  const now = typeof store.now === "function" ? store.now() : Date.now();
  return Number.isFinite(now) ? now : Date.now();
}

function isoAt(value, fallback) {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(Date.parse(value)).toISOString();
  if (Number.isFinite(value)) return new Date(value).toISOString();
  return new Date(fallback).toISOString();
}

function missingTable(error) {
  return /no such table/i.test(String(error?.message ?? ""));
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

export function readFlag(store, roomId) {
  requireRoomId(roomId);
  const db = dbOf(store);
  const row = db.prepare("SELECT enabled FROM design_upgrade_flags WHERE room_id=?").get(roomId);
  return {
    flag: DESIGN_UPGRADE_FLAG,
    enabled: designUpgradeEnabled(roomId, row ? row.enabled : undefined),
    roomId,
  };
}

export function writeFlag(store, member, roomId, enabled) {
  requireRoomId(roomId);
  const ownerId = roomState(store, roomId).room?.ownerId ?? null;
  if (!member?.id || member.id !== ownerId) {
    throw upgradeError(403, "not_owner", "Only the room owner can change designUpgrade",
      step("POST", `/api/rooms/${roomId}/design-upgrade`, "Ask the room owner to turn designUpgrade on.", { enabled: true }));
  }
  if (typeof enabled !== "boolean") {
    throw upgradeError(422, "invalid_flag", "Invalid flag",
      step("POST", `/api/rooms/${roomId}/design-upgrade`, "Send enabled true or false.", { enabled: true }));
  }
  const db = dbOf(store);
  db.prepare(`INSERT INTO design_upgrade_flags (room_id, enabled, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(roomId, enabled ? 1 : 0, nowOf(store), member.id);
  return readFlag(store, roomId);
}

export function assertDesignUpgrade(store, roomId) {
  const flag = readFlag(store, roomId);
  if (!flag.enabled) throw upgradeError(409, "design_upgrade_off", "designUpgrade is off for this room", flagOffNext(roomId));
  return flag;
}

function claimsOf(store, roomId) {
  const list = store.workClaims?.list?.(roomId);
  return Array.isArray(list) ? list : [];
}

function findClaim(store, roomId, id) {
  return claimsOf(store, roomId).find(item => item?.id === id) ?? null;
}

function findWork(store, roomId, id) {
  const items = roomState(store, roomId).workItems ?? {};
  return items[id] ?? null;
}

function findAsk(store, roomId, id) {
  const requests = roomState(store, roomId).replyRequests ?? {};
  return requests[id] ?? null;
}

function ackRow(db, roomId, kind, id, memberId) {
  return db.prepare(`SELECT opened_at, acked_at FROM design_upgrade_acks
    WHERE room_id=? AND subject_kind=? AND subject_id=? AND member_id=?`)
    .get(roomId, kind, id, memberId) ?? null;
}

function writeAck(db, roomId, kind, id, memberId, openedAt, ackedAt) {
  db.prepare(`INSERT INTO design_upgrade_acks (room_id, subject_kind, subject_id, member_id, opened_at, acked_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, subject_kind, subject_id, member_id) DO UPDATE SET
      acked_at=COALESCE(design_upgrade_acks.acked_at, excluded.acked_at),
      opened_at=COALESCE(design_upgrade_acks.opened_at, excluded.opened_at)`)
    .run(roomId, kind, id, memberId, Number.isFinite(openedAt) ? openedAt : null, ackedAt);
}

function ackPayload(roomId, kind, id, memberId, view, canAck) {
  return {
    roomId,
    kind,
    id,
    memberId,
    state: view?.state ?? "waiting",
    label: view?.label ?? "Waiting",
    at: view?.at ?? null,
    canAck: Boolean(canAck),
  };
}

function claimReviewer(claim, member, members, ownerId) {
  const status = taskStatusFromClaim(claim);
  if (status?.status !== "needs_you") return false;
  const named = resolveNamedReviewers(claim, members);
  if (named.length) return named.includes(member.id);
  return ownerId === member.id && ownerId !== claim.owner;
}

function claimGate(store, roomId, id, member) {
  const claim = findClaim(store, roomId, id);
  if (!claim) {
    throw upgradeError(404, "unknown_task", "Unknown task",
      step("GET", `/api/rooms/${roomId}/task-status`, "Check the id and kind, then read the task again."));
  }
  if (claim.state === "unclaimed" || !claim.owner) {
    throw upgradeError(409, "not_assigned", "Not assigned",
      step("POST", `/api/rooms/${roomId}/acks`, "Claim this work first, then acknowledge it.", { kind: "claim", id }));
  }
  if (claim.state === "closed") {
    throw upgradeError(409, "not_assigned", "Not assigned",
      step("GET", `/api/rooms/${roomId}/task-status`, "This claim is closed. Read its status instead of acknowledging it."));
  }
  const state = roomState(store, roomId);
  const ownerId = state.room?.ownerId ?? null;
  const reviewer = claimReviewer(claim, member, state.members ?? {}, ownerId);
  if (!reviewer && member.id !== claim.owner) {
    throw upgradeError(403, "not_assignee", "Not the assignee",
      step("GET", `/api/rooms/${roomId}/needs-you`, "Only the assigned member can acknowledge this."));
  }
  return { claim, reviewer, ownerId };
}

function workGate(store, roomId, id, member) {
  const item = findWork(store, roomId, id);
  if (!item) {
    throw upgradeError(404, "unknown_task", "Unknown task",
      step("GET", `/api/rooms/${roomId}/task-status`, "Check the id and kind, then read the task again."));
  }
  const ownerId = roomState(store, roomId).room?.ownerId ?? null;
  let next = null;
  try { next = nextWorkStep(item, nowOf(store), ownerId); } catch { next = null; }
  const assignee = member.id === item.accountableMemberId || next?.memberId === member.id;
  if (!assignee) {
    throw upgradeError(403, "not_assignee", "Not the assignee",
      step("GET", `/api/rooms/${roomId}/needs-you`, "Only the assigned member can acknowledge this."));
  }
  return { item, ownerId, next };
}

function mentionGate(store, roomId, id, member) {
  const db = dbOf(store);
  if (!tableExists(db, "mention_states")) {
    throw upgradeError(404, "mention_not_found", "Mention not found",
      step("GET", `/api/rooms/${roomId}/needs-you`, "Read what needs you, then acknowledge a mention id from that list."));
  }
  const mine = db.prepare(`SELECT state, created_at AS createdAt, timeout_at AS timeoutAt, decided_at AS decidedAt
    FROM mention_states WHERE room_id=? AND message_event_id=? AND mentioned_member_id=?`)
    .get(roomId, id, member.id);
  if (!mine) {
    const any = db.prepare("SELECT 1 FROM mention_states WHERE room_id=? AND message_event_id=?").get(roomId, id);
    if (any) {
      throw upgradeError(403, "not_assignee", "Not the assignee",
        step("GET", `/api/rooms/${roomId}/needs-you`, "Only the mentioned member can acknowledge this."));
    }
    throw upgradeError(404, "mention_not_found", "Mention not found",
      step("GET", `/api/rooms/${roomId}/needs-you`, "Read what needs you, then acknowledge a mention id from that list."));
  }
  return mine;
}

function askGate(store, roomId, id, member) {
  const request = findAsk(store, roomId, id);
  if (!request) {
    throw upgradeError(404, "unknown_task", "Unknown task",
      step("GET", `/api/rooms/${roomId}/needs-you`, "Read what needs you, then acknowledge an ask id from that list."));
  }
  if (request.recipientId !== member.id) {
    throw upgradeError(403, "not_assignee", "Not the assignee",
      step("GET", `/api/rooms/${roomId}/needs-you`, "Only the asked member can acknowledge this."));
  }
  if (request.status !== "open") {
    throw upgradeError(409, "not_assigned", "Not assigned",
      step("GET", `/api/rooms/${roomId}/needs-you`, "This ask is already closed."));
  }
  return request;
}

function claimAckView(claim, member, reviewer, row, now) {
  if (reviewer) {
    const opened = Date.parse(claim.deliveredAt ?? claim.claimedAt ?? "");
    const view = ackState({
      openedAt: Number.isFinite(opened) ? opened : null,
      ackedAt: row?.acked_at ?? null,
      now,
    });
    return { view, canAck: view.state !== "acknowledged" };
  }
  const view = claimHolderAck(claim, { now, ackedAt: row?.acked_at ?? null });
  if (!view) return { view: null, canAck: false };
  return { view, canAck: view.state !== "acknowledged" && claim.state === "claimed" };
}

function workAckView(item, row, now) {
  const opened = Date.parse(item.updatedAt ?? item.createdAt ?? "");
  const started = item.state === "working" || item.state === "blocked";
  const view = ackState({
    openedAt: Number.isFinite(opened) ? opened : now,
    ackedAt: row?.acked_at ?? null,
    now,
    pickedUp: started,
  });
  return { view, canAck: view.state !== "acknowledged" };
}

export function readAck(store, member, roomId, kind, id) {
  assertDesignUpgrade(store, roomId);
  requireKind(roomId, kind, ["claim", "work", "mention", "ask"]);
  requireSubjectId(roomId, id);
  const db = dbOf(store);
  const now = nowOf(store);
  const row = ackRow(db, roomId, kind, id, member.id);
  if (kind === "claim") {
    const gate = claimGate(store, roomId, id, member);
    const { view, canAck } = claimAckView(gate.claim, member, gate.reviewer, row, now);
    return ackPayload(roomId, kind, id, member.id, view, canAck);
  }
  if (kind === "work") {
    const gate = workGate(store, roomId, id, member);
    const { view, canAck } = workAckView(gate.item, row, now);
    return ackPayload(roomId, kind, id, member.id, view, canAck);
  }
  if (kind === "mention") {
    const mention = mentionGate(store, roomId, id, member);
    const view = row?.acked_at != null
      ? ackState({ ackedAt: row.acked_at, now, pickedUp: true })
      : mentionAck(mention, now);
    return ackPayload(roomId, kind, id, member.id, view, view?.state !== "acknowledged");
  }
  const request = askGate(store, roomId, id, member);
  const opened = Date.parse(request.createdAt ?? "");
  const view = ackState({
    openedAt: Number.isFinite(opened) ? opened : now,
    ackedAt: row?.acked_at ?? null,
    now,
  });
  return ackPayload(roomId, kind, id, member.id, view, view.state !== "acknowledged");
}

export function acknowledge(store, secret, member, roomId, kind, id) {
  const current = readAck(store, member, roomId, kind, id);
  if (kind === "mention" && typeof store.acknowledgeMention === "function") {
    try {
      store.acknowledgeMention(secret, roomId, id);
    } catch (error) {
      if (error instanceof ServiceError && !error.next) {
        error.next = step("GET", `/api/rooms/${roomId}/needs-you`, "Read what needs you, then acknowledge a mention id from that list.");
      }
      throw error;
    }
  }
  const db = dbOf(store);
  const existing = ackRow(db, roomId, kind, id, member.id);
  if (existing?.acked_at == null) {
    const opened = existing?.opened_at ?? Date.parse(current.at ?? "") ;
    writeAck(db, roomId, kind, id, member.id, Number.isFinite(opened) ? opened : nowOf(store), nowOf(store));
  }
  return readAck(store, member, roomId, kind, id);
}

function statusOf(store, roomId, kind, id, member) {
  const now = nowOf(store);
  const ownerId = roomState(store, roomId).room?.ownerId ?? null;
  if (kind === "claim") {
    const claim = findClaim(store, roomId, id);
    if (!claim) return null;
    const status = taskStatusFromClaim(claim);
    const state = roomState(store, roomId);
    const reviewer = claim.owner && claimReviewer(claim, member, state.members ?? {}, ownerId);
    let ack = null;
    if (claim.owner && claim.state !== "unclaimed" && claim.state !== "closed" && (reviewer || member.id === claim.owner)) {
      const row = ackRow(dbOf(store), roomId, kind, id, member.id);
      const view = claimAckView(claim, member, reviewer, row, now);
      ack = ackPayload(roomId, kind, id, member.id, view.view, view.canAck);
    }
    return compactStatus(roomId, kind, id, claim.state, status, ack);
  }
  const item = findWork(store, roomId, id);
  if (!item) return null;
  let status = null;
  try { status = taskStatusFromWork(item, now, ownerId); } catch { status = null; }
  let ack = null;
  try {
    const gate = workGate(store, roomId, id, member);
    const row = ackRow(dbOf(store), roomId, kind, id, member.id);
    const view = workAckView(gate.item, row, now);
    ack = ackPayload(roomId, kind, id, member.id, view.view, view.canAck);
  } catch (error) {
    if (!(error instanceof ServiceError) || error.code !== "not_assignee") throw error;
  }
  return compactStatus(roomId, kind, id, item.state, status, ack);
}

function compactStatus(roomId, kind, id, legacy, status, ack) {
  return {
    roomId,
    kind,
    id,
    status: status?.status ?? null,
    label: status?.label ?? null,
    legacy: status?.legacy ?? legacy ?? null,
    ...(status?.outcome ? { outcome: status.outcome } : {}),
    ...(ack ? { ack } : {}),
  };
}

export function readTaskStatus(store, member, roomId, { kind, id, ids } = {}) {
  assertDesignUpgrade(store, roomId);
  requireKind(roomId, kind, ["claim", "work"]);
  const hasId = id !== undefined && id !== null && id !== "";
  const hasIds = ids !== undefined && ids !== null && ids !== "";
  if (hasId === hasIds) {
    throw upgradeError(422, "invalid_id", "Invalid id",
      step("GET", `/api/rooms/${roomId}/task-status`, "Pass one id, or ids with at most 40 task ids."));
  }
  if (hasId) {
    requireSubjectId(roomId, id);
    const one = statusOf(store, roomId, kind, id, member);
    if (!one) {
      throw upgradeError(404, "unknown_task", "Unknown task",
        step("GET", `/api/rooms/${roomId}/task-status`, "Check the id and kind, then read the task again."));
    }
    return one;
  }
  const list = String(ids).split(",").map(part => part.trim()).filter(Boolean);
  if (list.length < 1 || list.length > 40 || list.some(part => !validId(part))) {
    throw upgradeError(422, "invalid_batch", "Invalid batch",
      step("GET", `/api/rooms/${roomId}/task-status`, "Pass ids as a comma-separated list of at most 40 task ids."));
  }
  const tasks = list.map(part => statusOf(store, roomId, kind, part, member) ?? { id: part, error: "unknown_task" });
  return { roomId, kind, tasks };
}

function resultGate(store, roomId, kind, id, member, writing) {
  assertDesignUpgrade(store, roomId);
  requireKind(roomId, kind, ["claim", "work"]);
  requireSubjectId(roomId, id);
  const ownerId = roomState(store, roomId).room?.ownerId ?? null;
  if (kind === "claim") {
    const claim = findClaim(store, roomId, id);
    if (!claim) {
      throw upgradeError(404, "unknown_task", "Unknown task",
        step("GET", `/api/rooms/${roomId}/task-result`, "Check the id and kind, then read the result again."));
    }
    if (writing && member.id !== claim.owner && member.id !== ownerId) {
      throw upgradeError(403, "not_assignee", "Not the assignee",
        step("GET", `/api/rooms/${roomId}/task-result`, "Only the claim owner or the room owner can attach a result."));
    }
    return claim;
  }
  const item = findWork(store, roomId, id);
  if (!item) {
    throw upgradeError(404, "unknown_task", "Unknown task",
      step("GET", `/api/rooms/${roomId}/task-result`, "Check the id and kind, then read the result again."));
  }
  if (writing && member.id !== item.accountableMemberId && member.id !== ownerId) {
    throw upgradeError(403, "not_assignee", "Not the assignee",
      step("GET", `/api/rooms/${roomId}/task-result`, "Only the accountable member or the room owner can attach a result."));
  }
  return item;
}

function resultBody(roomId, kind, id, row) {
  if (!row) return { roomId, kind, id, result: null };
  let links = [];
  try { links = JSON.parse(row.links_json); } catch { links = []; }
  return {
    roomId,
    kind,
    id,
    result: {
      summary: row.summary,
      links,
      authorId: row.author_id,
      updatedAt: new Date(row.updated_at).toISOString(),
    },
  };
}

export function readResult(store, member, roomId, kind, id) {
  resultGate(store, roomId, kind, id, member, false);
  const row = dbOf(store).prepare(`SELECT summary, links_json, author_id, updated_at FROM design_upgrade_results
    WHERE room_id=? AND subject_kind=? AND subject_id=?`).get(roomId, kind, id);
  return resultBody(roomId, kind, id, row);
}

export function putResult(store, member, roomId, kind, id, input) {
  resultGate(store, roomId, kind, id, member, true);
  let parsed;
  try {
    parsed = readTaskResult(input);
  } catch (error) {
    if (error?.code === "invalid_result") {
      throw upgradeError(422, "invalid_result", "Invalid result",
        step("POST", `/api/rooms/${roomId}/task-result`,
          "Send a summary and https links, then retry.",
          { kind, id, summary: "What changed", links: [{ href: "https://example.com/result", label: "Result" }] }));
    }
    throw error;
  }
  const db = dbOf(store);
  const at = nowOf(store);
  db.prepare(`INSERT INTO design_upgrade_results (room_id, subject_kind, subject_id, summary, links_json, author_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, subject_kind, subject_id) DO UPDATE SET
      summary=excluded.summary, links_json=excluded.links_json, author_id=excluded.author_id, updated_at=excluded.updated_at`)
    .run(roomId, kind, id, parsed.summary, JSON.stringify(parsed.links), member.id, at);
  return readResult(store, member, roomId, kind, id);
}

function claimNeedsViewer(claim, viewer, members, ownerId) {
  const named = resolveNamedReviewers(claim, members);
  if (named.length) return named.includes(viewer) && !hasCurrentReview(claim, viewer);
  return ownerId === viewer && ownerId !== claim.owner;
}

function clip(text, max = 80) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return value.slice(0, max - 3) + "...";
}

function inboxAck(roomId, kind, id, memberId, view, canAck) {
  if (!view) return null;
  return { state: view.state, label: view.label, at: view.at, memberId, canAck: Boolean(canAck) };
}

export function collectNeedsYou(store, member, roomId, { cursor = null, limit, now } = {}) {
  assertDesignUpgrade(store, roomId);
  const db = dbOf(store);
  const clock = Number.isFinite(now) ? now : nowOf(store);
  const state = roomState(store, roomId);
  const ownerId = state.room?.ownerId ?? null;
  const members = state.members ?? {};
  const viewer = member.id;
  const items = [];
  const incomplete = [];
  const stored = new Map();
  for (const row of db.prepare(`SELECT subject_kind, subject_id, opened_at, acked_at FROM design_upgrade_acks
    WHERE room_id=? AND member_id=?`).all(roomId, viewer)) {
    stored.set(`${row.subject_kind}:${row.subject_id}`, row);
  }

  for (const request of Object.values(state.replyRequests ?? {})) {
    if (!request || request.status !== "open" || request.recipientId !== viewer || !validId(request.id)) continue;
    const row = stored.get(`ask:${request.id}`);
    const opened = Date.parse(request.createdAt ?? "");
    const view = ackState({
      openedAt: Number.isFinite(opened) ? opened : clock,
      ackedAt: row?.acked_at ?? null,
      now: clock,
    });
    const title = request.private === true || typeof request.title !== "string" || !request.title.trim()
      ? "Reply requested"
      : clip(request.title);
    items.push({
      id: `ask:${request.id}`,
      kind: "ask",
      subjectKind: "ask",
      subjectId: request.id,
      title,
      at: isoAt(request.createdAt, clock),
      status: "needs_you",
      label: "Needs you",
      ack: inboxAck(roomId, "ask", request.id, viewer, view, view.state !== "acknowledged"),
    });
  }

  for (const item of Object.values(state.workItems ?? {})) {
    if (!item || !validId(item.id)) continue;
    let status = null;
    let next = null;
    try {
      status = taskStatusFromWork(item, clock, ownerId);
      next = nextWorkStep(item, clock, ownerId);
    } catch { continue; }
    if (status?.status !== "needs_you" || next?.memberId !== viewer) continue;
    const row = stored.get(`work:${item.id}`);
    const view = workAckView(item, row, clock).view;
    items.push({
      id: `task:${item.id}`,
      kind: "task",
      subjectKind: "work",
      subjectId: item.id,
      title: clip(item.title || "Task"),
      at: isoAt(item.updatedAt ?? item.createdAt, clock),
      status: "needs_you",
      label: "Needs you",
      ack: inboxAck(roomId, "work", item.id, viewer, view, view.state !== "acknowledged"),
    });
  }

  try {
    for (const claim of claimsOf(store, roomId)) {
      if (!claim || !validId(claim.id)) continue;
      const status = taskStatusFromClaim(claim);
      if (status?.status !== "needs_you" || !claimNeedsViewer(claim, viewer, members, ownerId)) continue;
      const row = stored.get(`claim:${claim.id}`);
      const view = claimAckView(claim, member, true, row, clock).view;
      items.push({
        id: `task:${claim.id}`,
        kind: "task",
        subjectKind: "claim",
        subjectId: claim.id,
        title: clip(claim.title || "Task"),
        at: isoAt(claim.deliveredAt ?? claim.claimedAt, clock),
        status: "needs_you",
        label: "Needs you",
        ack: inboxAck(roomId, "claim", claim.id, viewer, view, view?.state !== "acknowledged"),
      });
    }
  } catch {
    incomplete.push("tasks");
  }

  if (tableExists(db, "mention_states")) {
    try {
      const joinEvents = tableExists(db, "events");
      const sql = joinEvents
        ? `SELECT m.message_event_id AS id, m.state, m.created_at AS createdAt, m.timeout_at AS timeoutAt, m.decided_at AS decidedAt,
              json_extract(e.body, '$.data.body') AS body, json_extract(e.body, '$.data.toMemberId') AS toMemberId
           FROM mention_states m LEFT JOIN events e ON e.room_id=m.room_id AND e.id=m.message_event_id
           WHERE m.room_id=? AND m.mentioned_member_id=? AND m.state IN ('delivered', 'timed_out')`
        : `SELECT message_event_id AS id, state, created_at AS createdAt, timeout_at AS timeoutAt, decided_at AS decidedAt
           FROM mention_states WHERE room_id=? AND mentioned_member_id=? AND state IN ('delivered', 'timed_out')`;
      for (const mention of db.prepare(sql).all(roomId, viewer)) {
        if (!validId(mention.id)) continue;
        const row = stored.get(`mention:${mention.id}`);
        if (row?.acked_at != null) continue;
        const view = mentionAck(mention, clock);
        if (!view || view.state === "acknowledged") continue;
        const title = mention.toMemberId ? "Mentioned you" : (mention.body ? clip(mention.body) : "Mentioned you");
        items.push({
          id: `mention:${mention.id}`,
          kind: "mention",
          subjectKind: "mention",
          subjectId: mention.id,
          title,
          at: isoAt(mention.createdAt, clock),
          status: "needs_you",
          label: "Needs you",
          ack: inboxAck(roomId, "mention", mention.id, viewer, view, true),
        });
      }
    } catch (error) {
      if (!missingTable(error)) incomplete.push("mentions");
    }
  }

  const permissions = Array.isArray(member.permissions) ? member.permissions : [];
  if ((viewer === ownerId || permissions.includes("manage_members")) && tableExists(db, "access_requests")) {
    try {
      const rows = db.prepare(`SELECT request_id, display_name, created_at FROM access_requests
        WHERE room_id=? AND status IN ('pending', 'pending_upgrade')`).all(roomId);
      for (const row of rows) {
        if (!validId(row.request_id)) continue;
        const name = typeof row.display_name === "string" ? row.display_name.trim() : "";
        items.push({
          id: `approval:${row.request_id}`,
          kind: "approval",
          subjectKind: "approval",
          subjectId: row.request_id,
          title: name ? clip(name) : "Join request",
          at: isoAt(row.created_at, clock),
          status: "needs_you",
          label: "Needs you",
          ack: null,
        });
      }
    } catch (error) {
      if (!missingTable(error)) incomplete.push("approvals");
    }
  }

  let page;
  try {
    page = assembleNeedsYou({ items, cursor, limit, incomplete });
  } catch (error) {
    if (error?.code === "invalid_cursor") throw upgradeError(422, "invalid_cursor", error.message, cursorNext(roomId));
    throw error;
  }
  return { roomId, count: page.count, items: page.items, nextCursor: page.nextCursor, incomplete: page.incomplete };
}

export function isDesignUpgradeTool(name) {
  return DESIGN_UPGRADE_TOOLS.has(name);
}

export function validDesignUpgradeArgs(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const allow = {
    room_needs_you: ["roomId", "cursor", "limit"],
    room_task_status: ["roomId", "kind", "id"],
    room_ack_task: ["roomId", "kind", "id"],
    room_put_task_result: ["roomId", "kind", "id", "summary", "links"],
    room_read_task_result: ["roomId", "kind", "id"],
  }[name];
  if (!allow) return false;
  const keys = Object.keys(args);
  const required = name === "room_needs_you" ? ["roomId"] : name === "room_put_task_result"
    ? ["roomId", "kind", "id", "summary"] : ["roomId", "kind", "id"];
  if (!keys.every(key => allow.includes(key)) || !required.every(key => Object.hasOwn(args, key))) return false;
  if (!validId(args.roomId)) return false;
  if (name === "room_needs_you") {
    if (args.cursor !== undefined && (typeof args.cursor !== "string" || args.cursor.length < 1 || args.cursor.length > 200)) return false;
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) return false;
    return true;
  }
  const kinds = name === "room_ack_task" ? ["claim", "work", "mention", "ask"] : ["claim", "work"];
  if (!kinds.includes(args.kind) || !validId(args.id)) return false;
  if (name === "room_put_task_result") {
    if (typeof args.summary !== "string") return false;
    if (args.links !== undefined && !Array.isArray(args.links)) return false;
  }
  return true;
}

export function callDesignUpgradeTool(store, secret, name, args) {
  const auth = store.authenticate(secret, args.roomId);
  const member = auth?.member;
  if (!member?.id) throw upgradeError(401, "unauthenticated", "Room membership required");
  if (name === "room_needs_you") return collectNeedsYou(store, member, args.roomId, { cursor: args.cursor ?? null, limit: args.limit });
  if (name === "room_task_status") return readTaskStatus(store, member, args.roomId, { kind: args.kind, id: args.id });
  if (name === "room_ack_task") return acknowledge(store, secret, member, args.roomId, args.kind, args.id);
  if (name === "room_put_task_result") {
    return putResult(store, member, args.roomId, args.kind, args.id, { summary: args.summary, links: args.links });
  }
  if (name === "room_read_task_result") return readResult(store, member, args.roomId, args.kind, args.id);
  throw upgradeError(404, "unknown_tool", "Unknown tool");
}
