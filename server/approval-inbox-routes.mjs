// Approval inbox REST routes (WAVE-500 guild 10): one live surface for
// pending HUMAN decisions as cards, replacing the scattered tap list.
//
// Card: { id, kind, title, what, context, options[] {label, consequence},
// requestedBy, createdAt, expiresAt, status, decision }. kinds:
// money|identity|deploy|permission|publish|other. statuses:
// pending|approved|rejected|changes|expired. Decisions on
// POST .../approvals/{id}/decide: approve | approve-session | deny-stop.
// ONLY humans decide — an agent identity gets 403 approval_not_human.
// Any member may open a card (agents surface genuinely-undecidable items);
// the create policy gate rejects optionless or pre-decided cards (422).
// Expiry is projected on reads (stored state untouched); deciding an
// expired card is 409 approval_expired, any other non-pending decide is
// 409 approval_invalid_transition.
//
// Wiring (sibling slice 5 owns server/http.mjs — do NOT edit it here):
//   import { mountApprovalInboxRoutes, approvalInboxRegistry } from "./approval-inbox-routes.mjs";
//   // inside the authenticated room block, after the credential, fence and
//   // rate-limit checks, with e.g.:
//   // const approvalMatch = /^\/api\/rooms\/[^/]+\/approvals(\/|$)/.test(pathname);
//   if (approvalMatch) {
//     return await mountApprovalInboxRoutes({ req, res, url, store, roomId, auth,
//       registry: store.approvals ?? approvalInboxRegistry, helpers: { json, reject, body } });
//   }
//
// Pure, dependency-free, frozen outputs. The in-memory registry is the
// test fixture and the default; a SQLite-backed registry with the same
// get/set/list/has interface can replace it without touching routes.
import { randomUUID } from "node:crypto";

export class ApprovalInboxError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "ApprovalInboxError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
const fail = (code, message, detail) => { throw new ApprovalInboxError(code, message, detail); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

export const APPROVAL_KINDS = Object.freeze(["money", "identity", "deploy", "permission", "publish", "other"]);
export const APPROVAL_STATUSES = Object.freeze(["pending", "approved", "rejected", "changes", "expired"]);
export const APPROVAL_DECISIONS = Object.freeze(["approve", "approve-session", "deny-stop"]);
const DECISION_STATUS = Object.freeze({ approve: "approved", "approve-session": "approved", "deny-stop": "rejected" });
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// Per-room registry: roomId -> Map(id -> card).
export function createApprovalInboxRegistry() {
  const rooms = new Map();
  const room = roomId => {
    let entry = rooms.get(roomId);
    if (!entry) { entry = new Map(); rooms.set(roomId, entry); }
    return entry;
  };
  return {
    get(roomId, id) { return room(roomId).get(id) ?? null; },
    set(roomId, item) { room(roomId).set(item.id, item); return item; },
    list(roomId) { return [...room(roomId).values()]; },
    has(roomId, id) { return room(roomId).has(id); },
  };
}
export const approvalInboxRegistry = createApprovalInboxRegistry();

const textOf = (value, max, field, { optional = false } = {}) => {
  if (value === undefined || value === null) { check(optional, "approval_invalid", `${field} is required`); return null; }
  check(typeof value === "string" && value.isWellFormed() && value.length >= 1 && value.length <= max,
    "approval_invalid", `${field} must be 1..${max} well-formed characters`);
  return value;
};

const shape = (value, allowed, required, what) => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "approval_invalid", `${what} must be an object`);
  const keys = Object.keys(value);
  check(required.every(k => Object.hasOwn(value, k)), "approval_invalid", `${what} is missing a required field`);
  check(keys.every(k => allowed.has(k)), "approval_invalid", `${what} has an unknown field`);
  return value;
};

const optionOf = (value, index) => {
  const opt = shape(value, new Set(["label", "consequence"]), ["label", "consequence"], `options[${index}]`);
  return Object.freeze({ label: textOf(opt.label, 80, `options[${index}].label`), consequence: textOf(opt.consequence, 500, `options[${index}].consequence`) });
};

const isoFutureOf = (value, nowMs) => {
  if (value === undefined || value === null) return null;
  check(typeof value === "string", "approval_invalid", "expiresAt must be an ISO timestamp");
  const ms = Date.parse(value);
  check(Number.isFinite(ms), "approval_invalid", "expiresAt must be an ISO timestamp");
  check(ms > nowMs, "approval_invalid", "expiresAt must be in the future");
  return new Date(ms).toISOString();
};

// Policy gate: a card is a genuine question for a human — kind, title, what,
// and at least one option with its consequence; nothing pre-decided.
export function openApproval(registry, roomId, data, { by, nowMs = Date.now(), id = randomUUID() } = {}) {
  const body = shape(data, new Set(["kind", "title", "what", "context", "options", "requestedBy", "expiresAt"]),
    ["kind", "title", "what", "options"], "approval");
  check(APPROVAL_KINDS.includes(body.kind), "approval_invalid", `kind must be one of ${APPROVAL_KINDS.join("|")}`);
  check(Array.isArray(body.options) && body.options.length >= 1 && body.options.length <= 8,
    "approval_invalid", "options must list 1..8 choices — an approval with nothing to choose is not undecidable");
  const card = Object.freeze({
    id: String(id),
    kind: body.kind,
    title: textOf(body.title, 200, "title"),
    what: textOf(body.what, 2000, "what"),
    context: textOf(body.context, 2000, "context", { optional: true }),
    options: Object.freeze(body.options.map(optionOf)),
    requestedBy: textOf(body.requestedBy ?? by, 128, "requestedBy"),
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: isoFutureOf(body.expiresAt, nowMs),
    status: "pending",
    decision: null,
  });
  registry.set(roomId, card);
  return card;
}

export const isExpired = (card, nowMs) =>
  card.status === "pending" && card.expiresAt !== null && Date.parse(card.expiresAt) <= nowMs;

// Read projection: expiry shows on reads without mutating stored state.
export function projectApproval(card, nowMs = Date.now()) {
  if (!isExpired(card, nowMs)) return card;
  return Object.freeze({ ...card, status: "expired" });
}

export function decideApproval(registry, roomId, id, { decision, note, by, byKind, nowMs = Date.now() } = {}) {
  check(byKind === "human", "approval_not_human", "Only a human identity can decide — agents cannot clear approval cards.");
  const body = shape({ decision, note }, new Set(["decision", "note"]), ["decision"], "decision body");
  check(APPROVAL_DECISIONS.includes(body.decision), "approval_invalid", `decision must be one of ${APPROVAL_DECISIONS.join("|")}`);
  const card = registry.get(roomId, id);
  check(card, "approval_not_found", `No approval card ${id} in this room.`);
  check(!isExpired(card, nowMs), "approval_expired", "This card expired before it was decided.");
  check(card.status === "pending", "approval_invalid_transition", `Cannot decide a card with status ${card.status}.`);
  const decided = Object.freeze({
    ...card,
    status: DECISION_STATUS[body.decision],
    decision: Object.freeze({
      type: body.decision,
      by: textOf(by, 128, "by"),
      note: textOf(body.note, 500, "note", { optional: true }),
      at: new Date(nowMs).toISOString(),
      ...(body.decision === "approve-session" ? { session: true } : {}),
    }),
  });
  registry.set(roomId, decided);
  return decided;
}

const APPROVAL_PATH = /^\/api\/rooms\/[^/]+\/approvals(?:\/([^/]+)(?:\/(decide))?)?\/?$/;
export function matchApprovalRoute(pathname) {
  const m = APPROVAL_PATH.exec(pathname ?? "");
  if (!m) return null;
  if (!m[1]) return { route: "list", id: null };
  if (m[2] === "decide") return { route: "decide", id: m[1] };
  if (!ID_PATTERN.test(m[1])) return null;
  return { route: "read", id: m[1] };
}

const STATUS_FOR_CODE = Object.freeze({
  approval_invalid: 422, approval_not_found: 404, approval_not_human: 403,
  approval_invalid_transition: 409, approval_expired: 409,
});

export function handleApprovals({ req, res, url, store, roomId, auth, approvalRoute, approvalId, registry, helpers, nowMs }) {
  const { json, reject, body } = helpers;
  const inbox = registry ?? store?.approvals ?? approvalInboxRegistry;
  const member = auth?.member;
  if (!member?.id) reject(401, "unauthenticated", "Room membership required");
  const now = nowMs ?? (typeof store?.now === "function" ? store.now() : Date.now());
  const failAs = error => {
    if (error instanceof ApprovalInboxError) reject(STATUS_FOR_CODE[error.code] ?? 500, error.code, error.message);
    throw error;
  };
  const method = req.method;
  try {
    if (approvalRoute === "list") {
      if (method === "POST") {
        const data = body(req);
        return json(res, 201, openApproval(inbox, roomId, data, { by: member.id, nowMs: now }));
      }
      if (method !== "GET" && method !== "HEAD") reject(405, "method_not_allowed", "Use GET to list or POST to open a card");
      const kind = url.searchParams.get("kind");
      const status = url.searchParams.get("status");
      if (kind !== null) check(APPROVAL_KINDS.includes(kind), "approval_invalid", `kind filter must be one of ${APPROVAL_KINDS.join("|")}`);
      if (status !== null) check(APPROVAL_STATUSES.includes(status), "approval_invalid", `status filter must be one of ${APPROVAL_STATUSES.join("|")}`);
      const approvals = inbox.list(roomId)
        .map(card => projectApproval(card, now))
        .filter(card => (kind === null || card.kind === kind) && (status === null || card.status === status));
      return json(res, 200, { approvals, total: approvals.length });
    }
    if (approvalRoute === "read") {
      if (method !== "GET" && method !== "HEAD") reject(405, "method_not_allowed", "Use GET to read a card");
      const card = inbox.get(roomId, approvalId);
      check(card, "approval_not_found", `No approval card ${approvalId} in this room.`);
      return json(res, 200, projectApproval(card, now));
    }
    if (approvalRoute === "decide") {
      if (method !== "POST") reject(405, "method_not_allowed", "Use POST to decide a card");
      const data = body(req) ?? {};
      return json(res, 200, decideApproval(inbox, roomId, approvalId,
        { decision: data.decision, note: data.note, by: member.id, byKind: member.kind, nowMs: now }));
    }
    reject(404, "not_found", "Unknown approval route");
  } catch (error) { failAs(error); }
}

// The mount function: slice 5 calls this from server/http.mjs inside the
// authenticated room block. It classifies the sub-route and dispatches.
export function mountApprovalInboxRoutes(options) {
  const match = matchApprovalRoute(options.url?.pathname ?? "");
  if (!match) options.helpers.reject(404, "not_found", "Unknown approval route");
  return handleApprovals({ ...options, approvalRoute: match.route, approvalId: match.id });
}
