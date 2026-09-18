// Agent handoff protocol for the inbox (omnichannel task 23). When triage
// returns needs_human, the owner (or a triaging agent) hands a thread to a
// named agent with a compact structured context packet: a summary, open
// questions, pending actions, and channel constraints, alongside the source
// ids, channel, SLA clock, and triage reasons the receiver needs to pick the
// thread up.
//
// PII rule: the packet carries no raw PII beyond what the inbox already
// stores. It references thread/source ids and sender labels the thread view
// already shows, plus free-text fields (summary, open questions, pending
// actions, excerpt) authored or already visible to the handing party, all
// with hard length caps. Nothing here fetches a new message, resolves a new
// identity, or persists anything outside the handoff journal.
//
// Handoffs are journaled so nothing closes unowned, mirroring the room's
// claim/receipt discipline: a handoff is open until the named agent accepts
// it, and stays accounted-for until it is completed or released. One open
// handoff per thread: a second create for the same thread returns the
// existing receipt (idempotent), exactly like the inbox command dedupe.
//
// Validation raises ServiceError (422/404/409) rather than a bespoke error
// class so the pure builder can be shared between the packet module and the
// HTTP layer without a translation step; the codes read the same in unit
// tests and over the wire.
//
// Purely additive at the store level: a new journal table, IF NOT EXISTS, no
// data migration, no schema version bump — the same pattern as
// pending_channel_updates. The table is intentionally outside the writer
// fence (see unfencedAdditiveTables in server/writer-fence.mjs): older
// writers have no code path to it and rows are always scoped to an existing
// account.
import { randomUUID } from "node:crypto";
import { validId } from "../src/events.js";
import { ServiceError } from "./store.mjs";
import { ACTIONS as TRIAGE_ACTIONS } from "./inbox-triage.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const check = (condition, code, message) => { if (!condition) fail(422, code, message); };
const CODE = "invalid_handoff_packet";

export const handoffPacketVersion = 1;
// The digest's inert handoff descriptor carries a context of
// { threadId, channel, sourceIds, senderId, senderLabel, subject, occurredAt,
// sla, reasons }; the journaled packet below is its superset — same field
// names, plus the authored summary/questions/actions and channel constraints.
export const inboxHandoffStatuses = Object.freeze(["open", "accepted", "completed", "released"]);
const terminalStatuses = new Set(["completed", "released"]);
const handoffTransitions = Object.freeze({ open: ["accepted", "released"], accepted: ["completed", "released"],
  completed: [], released: [] });

const agentId = (value, field) => {
  check(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value), CODE, `${field} must be a 1..128 character agent id`);
  return value;
};
const text = (value, max, field, { optional = false } = {}) => {
  if (value === undefined || value === null) {
    check(optional, CODE, `${field} is required`);
    return null;
  }
  check(typeof value === "string" && value.isWellFormed() && value.length > 0 && value.length <= max, CODE,
    `${field} must be 1..${max} well-formed characters`);
  return value;
};
const optionalText = (value, max, field) => value === undefined || value === null ? null : text(value, max, field);
const textList = (value, maxItems, maxChars, field) => {
  if (value === undefined || value === null) return null;
  check(Array.isArray(value) && value.length <= maxItems, CODE, `${field} must be a list of at most ${maxItems}`);
  return Object.freeze(value.map((item, i) => text(item, maxChars, `${field}[${i}]`)));
};
const isoOf = (value, field) => {
  const parsed = text(value, 64, field);
  check(Number.isFinite(Date.parse(parsed)), CODE, `${field} must be a parseable timestamp`);
  return new Date(parsed).toISOString();
};
const slaStatuses = Object.freeze(["on_track", "at_risk", "breached", "responded", "not_applicable", "unknown_channel"]);
const numberOrNull = (value, field) => {
  if (value === undefined || value === null) return null;
  check(typeof value === "number" && Number.isFinite(value), CODE, `${field} must be a finite number`);
  return value;
};
const slaOf = value => {
  if (value === undefined || value === null) return null;
  check(value !== null && typeof value === "object" && !Array.isArray(value), CODE, "sla must be an object");
  check(Object.keys(value).every(k => ["status", "targetMs", "label", "elapsedMs", "awaitingSince", "deadlineAt"].includes(k)),
    CODE, "sla carries only status/targetMs/label/elapsedMs/awaitingSince/deadlineAt");
  check(slaStatuses.includes(value.status), CODE, `sla.status must be one of ${slaStatuses.join(",")}`);
  return Object.freeze({ status: value.status, targetMs: numberOrNull(value.targetMs, "sla.targetMs"),
    label: value.label === undefined || value.label === null ? null : text(value.label, 32, "sla.label"),
    elapsedMs: numberOrNull(value.elapsedMs, "sla.elapsedMs"),
    awaitingSince: value.awaitingSince === undefined || value.awaitingSince === null ? null : isoOf(value.awaitingSince, "sla.awaitingSince"),
    deadlineAt: value.deadlineAt === undefined || value.deadlineAt === null ? null : isoOf(value.deadlineAt, "sla.deadlineAt") });
};
const triageOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), CODE, "triage must be an object");
  check(Object.keys(value).every(k => ["action", "reasons"].includes(k)), CODE, "triage carries only action/reasons");
  check(TRIAGE_ACTIONS.includes(value.action), CODE, `triage.action must be one of ${TRIAGE_ACTIONS.join(",")}`);
  check(Array.isArray(value.reasons) && value.reasons.length <= 20, CODE, "triage.reasons must be a list of at most 20");
  return Object.freeze({ action: value.action,
    reasons: Object.freeze(value.reasons.map((reason, i) => text(reason, 256, `triage.reasons[${i}]`))) });
};
// Channel constraints tell the receiving agent how it may reply: tone, hard
// provider limits, how thread identity works, and what the surface cannot
// do. Unknown channels stay explicitly unknown — a guessed surface is worse
// than none, so the agent must ask the owner before replying.
const channelConstraintTable = {
  telegram: { tone: "chat-concise", maxReplyChars: 4096, threadIdentity: "telegram chat — replies stay in the same chat",
    readReceipts: false, notes: ["Bot replies stay in the bot's own chat; the bot never sees the sender's personal DMs.", "No contact sync: reply text only."] },
  whatsapp: { tone: "chat-concise", maxReplyChars: 4096, threadIdentity: "whatsapp conversation — replies stay in the same conversation",
    readReceipts: false, notes: [] },
  email: { tone: "formal", maxReplyChars: null, threadIdentity: "email thread (In-Reply-To/References) — replies stay in the thread",
    readReceipts: false, notes: ["Subject threading is the identity; changing the subject starts a new thread."] },
};
export const channelConstraintsOf = channel => {
  const known = typeof channel === "string" ? channelConstraintTable[channel] ?? null : null;
  return Object.freeze({ channel, known: known !== null, tone: known?.tone ?? "unknown",
    maxReplyChars: known?.maxReplyChars ?? null,
    threadIdentity: known?.threadIdentity ?? "unknown channel — confirm the reply surface with the owner before replying",
    readReceipts: known?.readReceipts ?? false,
    notes: Object.freeze([...(known?.notes ?? []),
      ...(known ? [] : ["Unknown channel: do not reply until the owner confirms the surface."])]) });
};
// Validate and freeze one handoff context packet. handoffId/createdAt are
// assigned by the journal; every other field is caller-supplied and checked.
export function buildHandoffPacket(value) {
  check(value !== null && typeof value === "object" && !Array.isArray(value), CODE, "a handoff packet must be an object");
  const allowed = ["handoffId", "createdAt", "threadId", "channel", "sourceIds", "sender", "subject", "occurredAt",
    "sla", "triage", "summary", "openQuestions", "pendingActions", "excerpt", "from", "to"];
  check(Object.keys(value).every(k => allowed.includes(k)), CODE, `handoff packet carries only ${allowed.join(",")}`);
  const handoffId = agentId(value.handoffId, "handoffId"), createdAt = isoOf(value.createdAt, "createdAt");
  const threadId = text(value.threadId, 1024, "threadId"), channel = text(value.channel, 64, "channel");
  check(Array.isArray(value.sourceIds) && value.sourceIds.length >= 1 && value.sourceIds.length <= 100, CODE,
    "sourceIds must be a list of 1..100");
  const sourceIds = Object.freeze([...new Set(value.sourceIds.map((id, i) => text(id, 512, `sourceIds[${i}]`)))]);
  check(sourceIds.length >= 1, CODE, "sourceIds must name at least one source");
  check(value.sender !== null && typeof value.sender === "object" && !Array.isArray(value), CODE, "sender must be an object");
  check(Object.keys(value.sender).every(k => ["id", "label"].includes(k)), CODE, "sender carries only id/label");
  const sender = Object.freeze({ id: text(value.sender.id, 512, "sender.id"),
    label: text(value.sender.label, 256, "sender.label") });
  return Object.freeze({ packetVersion: handoffPacketVersion, handoffId, createdAt, threadId, channel, sourceIds, sender,
    subject: text(value.subject, 500, "subject"), occurredAt: isoOf(value.occurredAt, "occurredAt"),
    sla: slaOf(value.sla), triage: triageOf(value.triage),
    summary: optionalText(value.summary, 2000, "summary"),
    openQuestions: textList(value.openQuestions, 5, 500, "openQuestions"),
    pendingActions: textList(value.pendingActions, 10, 300, "pendingActions"),
    excerpt: optionalText(value.excerpt, 500, "excerpt"),
    from: agentId(value.from, "from"), to: agentId(value.to, "to"),
    constraints: channelConstraintsOf(channel) });
}
export const inboxHandoffSchema = `
  CREATE TABLE IF NOT EXISTS inbox_handoffs (
    handoff_id TEXT NOT NULL PRIMARY KEY,
    account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    packet TEXT NOT NULL CHECK(json_valid(packet)),
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','accepted','completed','released')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    history TEXT NOT NULL CHECK(json_valid(history))
  );
  CREATE INDEX IF NOT EXISTS inbox_handoffs_account_status ON inbox_handoffs(account_id,status,created_at);
`;
const receiptOf = row => ({ handoffId: row.handoff_id, accountId: row.account_id, threadId: row.thread_id,
  channel: row.channel, status: row.status, fromAgent: row.from_agent, toAgent: row.to_agent,
  createdAt: row.created_at, updatedAt: row.updated_at,
  packet: JSON.parse(row.packet), history: JSON.parse(row.history) });
const scope = accountId => { if (!validId(accountId)) fail(422, "invalid_handoff_account", "Supply an account."); };

export class InboxHandoffJournal {
  constructor(store) { this.store = store; this.db = store.db; }
  // A read-only open of a file written before this journal finds none of
  // these objects and must not migrate, so allowAbsent accepts a wholly
  // missing schema; a partially present one still fails.
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = inboxHandoffSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Inbox handoff journal schema requires operator reconciliation");
    }
    return true;
  }
  // Offline integrity: every row's packet names the handoff id and thread id
  // it is keyed by, statuses stay in the enum, and every handoff starts open.
  verify() {
    for (const row of this.db.prepare("SELECT * FROM inbox_handoffs").all()) {
      const packet = JSON.parse(row.packet), history = JSON.parse(row.history);
      if (packet.handoffId !== row.handoff_id || packet.threadId !== row.thread_id)
        throw new Error(`Inbox handoff ${row.handoff_id} packet does not name its own key`);
      if (!inboxHandoffStatuses.includes(row.status)) throw new Error(`Inbox handoff ${row.handoff_id} has an unknown status`);
      if (!Array.isArray(history) || history.length === 0 || history[0].status !== "open")
        throw new Error(`Inbox handoff ${row.handoff_id} has no open origin`);
    }
  }
  // Journal a handoff: one open handoff per thread. A second create for the
  // same thread returns the existing receipt (duplicate: true) instead of a
  // second row — the thread stays owned by exactly one open handoff.
  create(accountId, fields, { from = "owner", to } = {}) {
    scope(accountId);
    check(fields !== null && typeof fields === "object" && !Array.isArray(fields), CODE, "a handoff packet must be an object");
    const threadId = text(fields.threadId, 1024, "threadId");
    return this.store.transaction(() => {
      const now = this.store.now();
      const open = this.db.prepare("SELECT * FROM inbox_handoffs WHERE account_id=? AND thread_id=? AND status='open' ORDER BY created_at DESC LIMIT 1")
        .get(accountId, threadId);
      if (open) return { receipt: receiptOf(open), duplicate: true };
      const packet = buildHandoffPacket({ ...fields, threadId, from, to, handoffId: randomUUID(), createdAt: new Date(now).toISOString() });
      const history = JSON.stringify([{ status: "open", at: packet.createdAt }]);
      this.db.prepare(`INSERT INTO inbox_handoffs
        (handoff_id,account_id,thread_id,channel,packet,from_agent,to_agent,status,created_at,updated_at,history)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(packet.handoffId, accountId, packet.threadId, packet.channel, JSON.stringify(packet),
          packet.from, packet.to, "open", now, now, history);
      return { receipt: receiptOf(this.db.prepare("SELECT * FROM inbox_handoffs WHERE handoff_id=?").get(packet.handoffId)),
        duplicate: false };
    });
  }
  // The "nothing closes unowned" sweep: every open handoff and its history.
  list(accountId, { status = null } = {}) {
    scope(accountId);
    if (status !== null && status !== undefined) {
      check(inboxHandoffStatuses.includes(status), "invalid_handoff_status", `status must be one of ${inboxHandoffStatuses.join(",")}`);
    }
    return this.store.readTransaction(() => (status === null || status === undefined
      ? this.db.prepare("SELECT * FROM inbox_handoffs WHERE account_id=? ORDER BY created_at DESC LIMIT 500").all(accountId)
      : this.db.prepare("SELECT * FROM inbox_handoffs WHERE account_id=? AND status=? ORDER BY created_at DESC LIMIT 500").all(accountId, status)
    ).map(receiptOf));
  }
  // Move a handoff along its lifecycle. Terminal handoffs are immutable;
  // illegal edges are refused, never silently rewritten.
  transition(accountId, handoffId, status, { note = null } = {}) {
    scope(accountId);
    agentId(handoffId, "handoffId");
    check(inboxHandoffStatuses.includes(status), "invalid_handoff_status", `status must be one of ${inboxHandoffStatuses.join(",")}`);
    const trimmed = note === undefined || note === null ? null : text(note, 500, "note");
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT * FROM inbox_handoffs WHERE account_id=? AND handoff_id=?").get(accountId, handoffId);
      if (!row) fail(404, "handoff_not_found", "No such handoff for this account.");
      if (!handoffTransitions[row.status].includes(status))
        fail(409, "invalid_handoff_transition", `A ${row.status} handoff cannot move to ${status}.`);
      const now = this.store.now();
      const history = [...JSON.parse(row.history), { status, at: new Date(now).toISOString(), ...(trimmed ? { note: trimmed } : {}) }];
      this.db.prepare("UPDATE inbox_handoffs SET status=?,updated_at=?,history=? WHERE account_id=? AND handoff_id=?")
        .run(status, now, JSON.stringify(history), accountId, handoffId);
      return receiptOf(this.db.prepare("SELECT * FROM inbox_handoffs WHERE handoff_id=?").get(handoffId));
    });
  }
}
export { terminalStatuses };
