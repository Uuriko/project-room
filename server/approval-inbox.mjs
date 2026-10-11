// Unified approval inbox — queue business logic for pending HUMAN decisions
// (WAVE-500 guild 10). One live surface for cards the scattered tap list used
// to hold: money, identity, deploy, permission, publish, other. Only a human
// identity can decide; agents get a not_human gate (403 semantics). Nothing
// here approves itself: genuinely-undecidable items wait for a person.
//
// Store seam (sibling slice 1 builds server/approval-inbox-store.mjs against
// this interface — do NOT edit their file):
//   store = { get(cardId) -> card|null, save(card) -> void, list() -> card[] }
// Pass a store to createApprovalInbox; a tiny in-memory store is the default.
//
// Pure logic, frozen outputs; clock and id generator are injected. The
// receiptRef on a resolution is the link seam for the receipts slice: it
// resolves the decision to a linkable receipt.
import { randomUUID } from "node:crypto";
import { identityOf } from "./inbox-assign.mjs";

export class ApprovalInboxError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "ApprovalInboxError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
const fail = (code, message, detail) => { throw new ApprovalInboxError(code, message, detail); };
const check = (condition, code, message, detail) => { if (!condition) fail(code, message, detail); };

export const cardStatuses = Object.freeze(["pending", "approved", "rejected", "changes", "expired"]);
export const cardKinds = Object.freeze(["money", "identity", "deploy", "permission", "publish", "other"]);
export const decisions = Object.freeze(["approve", "approve-session", "deny-stop"]);
const terminalStatuses = new Set(["approved", "rejected", "expired"]);
const transitions = Object.freeze({
  pending: ["approved", "rejected", "changes", "expired"],
  approved: [], rejected: [], changes: [], expired: [],
});

const textOf = (value, max, field, { optional = false } = {}) => {
  if (value === undefined || value === null) {
    check(optional, "inbox_invalid", `${field} is required`);
    return null;
  }
  check(typeof value === "string" && value.isWellFormed() && value.trim().length >= 1 && value.length <= max,
    "inbox_invalid", `${field} must be 1..${max} well-formed characters`);
  return value;
};
// One error contract per module: inbox-assign's errors are rewrapped as
// inbox_invalid / inbox_not_human here.
const identity = (value, field) => {
  try { return identityOf(value, field); } catch (error) { fail("inbox_invalid", error.message); }
};
// Borrowed from server/inbox-approval.mjs (humanOf): deciding is human-only.
const humanOf = (value, field = "by") => {
  const who = identity(value, field);
  check(who.kind === "human", "inbox_not_human",
    `${field} must be a human identity — only humans decide (agents get 403).`);
  return who;
};
const isoOf = ms => new Date(ms).toISOString();

const linksOf = value => {
  if (value === undefined || value === null) return Object.freeze([]);
  check(Array.isArray(value) && value.length <= 20, "inbox_invalid", "contextLinks must be an array of at most 20 links");
  return Object.freeze(value.map(l => textOf(l, 2000, "contextLinks[]")));
};
const optionsOf = value => {
  if (value === undefined || value === null) return Object.freeze([]);
  check(Array.isArray(value) && value.length <= 8, "inbox_invalid", "options must be an array of at most 8 options");
  return Object.freeze(value.map(o => {
    check(o !== null && typeof o === "object" && !Array.isArray(o), "inbox_invalid", "each option must be an object");
    check(Object.keys(o).every(k => ["label", "consequence"].includes(k)), "inbox_invalid",
      "option carries only label/consequence");
    return Object.freeze({ label: textOf(o.label, 80, "option.label"),
      consequence: textOf(o.consequence, 300, "option.consequence") });
  }));
};
const expiresAtOf = (value, now) => {
  if (value === undefined || value === null) return null;
  const ms = typeof value === "number" ? value
    : typeof value === "string" ? Date.parse(value) : NaN;
  check(Number.isFinite(ms), "inbox_invalid", "expiresAt must be epoch ms or an ISO date string");
  check(ms > now, "inbox_invalid", "expiresAt must be in the future");
  return isoOf(ms);
};

const freezeCard = card => Object.freeze({ ...card,
  contextLinks: Object.freeze(card.contextLinks), options: Object.freeze(card.options),
  requestedBy: Object.freeze({ ...card.requestedBy }),
  resolution: card.resolution ? Object.freeze({ ...card.resolution,
    by: Object.freeze({ ...card.resolution.by }) }) : null,
  history: Object.freeze(card.history.map(h => Object.freeze({ ...h, by: Object.freeze({ ...h.by }) }))),
});

const memoryStore = () => {
  const rows = new Map();
  return { get: id => rows.get(id) ?? null, save: card => { rows.set(card.cardId, card); }, list: () => [...rows.values()] };
};

export function createApprovalInbox({ store = memoryStore(), clock = () => Date.now(), id = () => randomUUID() } = {}) {
  const getCard = cardId => {
    check(typeof cardId === "string" && cardId.length >= 1, "inbox_invalid", "cardId must be a non-empty string");
    const card = store.get(cardId);
    if (!card) fail("inbox_not_found", "No such approval card.", { cardId });
    return card;
  };
  const move = (card, status, by, extra = {}) => {
    if (!transitions[card.status].includes(status))
      fail("inbox_transition", `A ${card.status} card cannot move to ${status}.`,
        { from: card.status, to: status });
    const next = freezeCard({ ...card, status, updatedAt: isoOf(clock()),
      history: [...card.history, { status, at: isoOf(clock()), by, ...extra }] });
    store.save(next);
    return next;
  };

  // A (human or agent) requester opens a decision card. Opening never
  // decides — it only queues the question for a human.
  function openCard({ kind, title, what, contextLinks, options, requestedBy, expiresAt } = {}) {
    check(cardKinds.includes(kind), "inbox_invalid", `kind must be one of ${cardKinds.join(",")}`);
    const now = clock();
    const card = freezeCard({ cardId: `apc-${id()}`, kind,
      title: textOf(title, 140, "title"), what: textOf(what, 2000, "what"),
      contextLinks: linksOf(contextLinks), options: optionsOf(options),
      requestedBy: identity(requestedBy, "requestedBy"),
      createdAt: isoOf(now), updatedAt: isoOf(now),
      expiresAt: expiresAtOf(expiresAt, now),
      status: "pending", resolution: null,
      history: [{ status: "pending", at: isoOf(now), by: identity(requestedBy, "requestedBy") }] });
    store.save(card);
    return card;
  }

  // The human verdict. approve clears the card; approve-session clears it for
  // the requesting session only; deny-stop rejects it outright.
  function decideCard({ cardId, decision, by, note = null } = {}) {
    check(decisions.includes(decision), "inbox_invalid", `decision must be one of ${decisions.join(",")}`);
    const card = getCard(cardId);
    const who = humanOf(by);
    const target = decision === "deny-stop" ? "rejected" : "approved";
    const resolution = { decision, scope: decision === "approve-session" ? "session" : "once",
      by: who, at: isoOf(clock()), receiptRef: `apc/${card.cardId}`,
      ...(note === null || note === undefined ? {} : { note: textOf(note, 1000, "note") }) };
    const moved = move(card, target, who, { note: resolution.note ?? null });
    const resolved = freezeCard({ ...moved, resolution });
    store.save(resolved);
    return resolved;
  }

  // The human asks for changes instead of deciding; the card parks in
  // `changes` with the human's note attached. Resubmission is another slice.
  function requestChanges(cardId, { by, note } = {}) {
    const card = getCard(cardId);
    const who = humanOf(by);
    const requested = textOf(note, 1000, "note");
    return move(card, "changes", who, { note: requested });
  }

  // Expire every pending card whose expiresAt has passed. Returns the expired
  // card ids; never touches non-pending cards.
  function expireSweep({ now = clock() } = {}) {
    const expired = [];
    for (const card of store.list()) {
      if (card.status !== "pending" || card.expiresAt === null) continue;
      if (Date.parse(card.expiresAt) > now) continue;
      const next = move(card, "expired", { kind: "system", id: "expiry", label: "expiry" });
      expired.push(next.cardId);
    }
    return Object.freeze(expired);
  }

  function get(cardId) { return getCard(cardId); }
  function list({ status = null, kind = null } = {}) {
    if (status !== null && status !== undefined)
      check(cardStatuses.includes(status), "inbox_invalid", `status must be one of ${cardStatuses.join(",")}`);
    if (kind !== null && kind !== undefined)
      check(cardKinds.includes(kind), "inbox_invalid", `kind must be one of ${cardKinds.join(",")}`);
    let rows = store.list();
    if (status) rows = rows.filter(c => c.status === status);
    if (kind) rows = rows.filter(c => c.kind === kind);
    return Object.freeze(rows);
  }
  function pendingCount() { return store.list().filter(c => c.status === "pending").length; }

  return Object.freeze({ openCard, decideCard, requestChanges, expireSweep, get, list, pendingCount,
    statuses: cardStatuses, kinds: cardKinds, terminalStatuses });
}
