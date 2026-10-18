// #3342 — Owner Cockpit slice 1: the cross-room read model behind
// GET /api/owner/overview (spec: project-room-owner-cockpit.md §§2, 4, 6).
// #3343 — Slice 2 adds the Money (§5) and Roster (§3) sections below:
// Panel C (cents, spendAllowanceReport) and Panel R (milli-credits, the
// escrow ledger) as separate field families that are never summed, plus
// presence()-derived roster rows. Money and roster are owner-only: an
// admin-everywhere viewer receives neither section (null, not empty).
//
// Every owner reader in the product is per-room (#662 owner-attention) or
// agent-scoped (needs-me). This module is the account-scoped fan-out: it
// enumerates the viewer's rooms with the accountRooms/member_accounts
// pattern, calls the existing per-room readers, and merges Decisions
// (#662 kinds plus open disputes) and Exceptions into one document.
//
// Contract rules carried from the spec:
// - Partial failure is surfaced, never hidden: a room whose read throws
//   lands in roomErrors[] and as an Exceptions stub; the response never
//   500s because one room is broken, and totals are labelled "N of M
//   rooms" whenever a room was excluded.
// - Admins (manage_members, non-owner) contribute only access_request
//   decision items for their rooms — the #662 split, preserved.
// - Cents and milli-credits are never summed or co-displayed as one
//   figure: money at stake travels as amountCents XOR amountMillis.
// - No new tables, no new write path: access-request approve/deny reuses
//   the existing decide endpoint via the #662 actions verbatim.
//
// Local ServiceError mirrors server/owner-attention.mjs (store.mjs imports
// are avoided to keep the Workers bundle cycle-free; http.mjs injects its
// store, AccessRequests and job-health reader).
import { attentionReport, accessRequestAttentionItem } from "./owner-attention.mjs";
import { REQUEST_TTL_MS } from "./access-requests.mjs";
import { DISPUTE_TIMEOUT_MS, BOUNTY_GROUPS, stateGroup, POOL_ACCOUNT, canonicalLane } from "./bounty-escrow.mjs";
import { spendAllowanceReport } from "./spend-allowance.mjs";
import { claimIdle } from "./agent-fleet.mjs";
import { reputationSummary } from "./bounty-reputation.mjs";
import { getTier, DEFAULT_AUTONOMY_TIER } from "./autonomy-tiers.mjs";
import { SESSION_EVENT_TYPES, sessionRecord } from "../src/work-item-session.js";

class ServiceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const OVERVIEW_WINDOWS = Object.freeze({ "24h": 24 * 3600 * 1000, "7d": 7 * 24 * 3600 * 1000, "30d": 30 * 24 * 3600 * 1000 });
const DECISIONS_CAP = 50;
const EXCEPTIONS_CAP = 50;
const ROOM_PAGE = 50;
// A dispute this close to its default-release deadline is critical: the
// money moves by itself at the deadline (spec §6).
const DISPUTE_NEAR_DEFAULT_MS = 48 * 3600 * 1000;
// Stale-claim severity ladder (spec §6): warn at claimIdle's 2h, critical
// at 24h untouched.
const STALE_CLAIM_CRITICAL_MS = 24 * 3600 * 1000;
const SEVERITY_RANK = Object.freeze({ critical: 3, warn: 2, info: 1 });
const TERMINAL_CLAIM_STATES = new Set(["done", "closed"]);

const ms = value => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
};
const iso = value => (Number.isFinite(value) ? new Date(value).toISOString() : null);

// Consequence-of-inaction lines (spec §4.3), each derived from the source
// constant named beside it — never hand-invented deadlines.
const CONSEQUENCE = Object.freeze({
  access_request: "If you don't decide, this request lapses undecided after 7 days and the requester is not notified",
  dispute: "If this dispute stays unresolved for 14 days it defaults to release — the poster loses by default",
  claim_lease: "When the lease expires the work returns to the board",
  verification: "Settlement stays locked in escrow and the worker stays unpaid until this is verified",
  decision: "Settlement stays locked in escrow and the worker stays unpaid until you decide",
  spend: "At zero headroom, new session starts are refused",
});

function reviewBountiesAction(roomId) {
  return Object.freeze([Object.freeze({ action: "review", method: "GET",
    path: `/api/rooms/${roomId}/bounties` })]);
}

function usageDrill(roomId) {
  return Object.freeze({ action: "review", method: "GET", path: `/api/rooms/${roomId}/usage` });
}

export function ownerOverview(deps, token, binding, nowMs = Date.now(), { window = "7d", after = null } = {}) {
  const { store, accessRequests, jobHealth = null } = deps ?? {};
  if (!store || !accessRequests) fail(500, "misconfigured", "Owner overview is not wired");
  if (!Object.hasOwn(OVERVIEW_WINDOWS, window)) {
    fail(422, "invalid_overview_query", "window must be one of 24h, 7d, 30d");
  }
  if (after !== null && (typeof after !== "string" || after.length === 0 || after.length > 384)) {
    fail(422, "invalid_room", "Invalid room continuation");
  }
  const windowMs = OVERVIEW_WINDOWS[window];
  const windowStart = nowMs - windowMs;
  const auth = store.authenticateAccountSession(token, null, binding);
  const accountId = auth.account.id;

  const allRoomIds = store.db.prepare(
    "SELECT room_id FROM member_accounts WHERE account_id=? ORDER BY room_id").all(accountId).map(row => row.room_id);

  // Role probe for one room. Returns "owner" | "admin" | null (no live
  // human membership, or a member who is neither). Store errors other
  // than the 403 membership refusal propagate to the caller's contract.
  const probeRole = roomId => {
    let roomAuth;
    try { roomAuth = store.authenticateAccountSession(token, roomId, binding); }
    catch (error) { if (error.status === 403) return null; throw error; }
    const member = roomAuth.member;
    if (!member || member.kind !== "human") return null;
    const state = store.room(roomId).state;
    if (member.id === state.room.ownerId) return "owner";
    if (Array.isArray(member.permissions) && member.permissions.includes("manage_members")) return "admin";
    return null;
  };

  // The 403 gate looks past the current page: an owner whose rooms sort
  // beyond the page still owns rooms.
  let viewerHasStanding = false;
  for (const roomId of allRoomIds) {
    try { if (probeRole(roomId) !== null) { viewerHasStanding = true; break; } }
    catch { /* a broken room cannot confer standing; the fan-out reports it */ }
  }
  if (!viewerHasStanding) fail(403, "owner_required", "Only a room owner or membership admin can view the owner overview");

  const pageIds = allRoomIds.filter(roomId => after === null || roomId > after).slice(0, ROOM_PAGE);
  const hasMore = allRoomIds.filter(roomId => after === null || roomId > after).length > ROOM_PAGE;

  const decisions = [];
  const exceptions = [];
  const roomErrors = [];
  const moneyRooms = [];
  const rosterRows = [];
  let roomsConsidered = 0;
  let roomsIncluded = 0;
  let ownerRoomsIncluded = 0;

  const collectRoom = roomId => {
    let role;
    try { role = probeRole(roomId); }
    catch (error) { roomsConsidered++; throw error; } // attempted and excluded: it counts toward the M in "N of M rooms"
    if (role === null) return;
    roomsConsidered++;
    const state = store.room(roomId).state;
    const roomName = state.room.title ?? roomId;
    const evaluatedThrough = store.room(roomId).sequence;
    const base = { roomId, roomName, evaluatedThrough };

    if (role === "admin") {
      // #662 split: admins see only the access-request queue they may act
      // on. list() enforces membership administration itself (including
      // owner-delegation grants); a refusal means no items, not an error.
      let requests;
      try { requests = accessRequests.list(token, roomId, { status: "pending" }, binding); }
      catch (error) { if (error.status === 403) { roomsIncluded++; return; } throw error; }
      for (const request of requests) {
        const createdAtMs = ms(request.createdAt);
        decisions.push(enrichDecision(accessRequestAttentionItem(roomId, request), base, {
          createdAtMs, consequenceAtMs: createdAtMs === null ? null : createdAtMs + REQUEST_TTL_MS,
          consequence: CONSEQUENCE.access_request,
        }, nowMs));
      }
      roomsIncluded++;
      return;
    }

    // Owner room: the #662 rollup is the canonical per-room source. Page
    // through its fingerprint cursor until the queue is exhausted.
    const items = [];
    let cursor = null;
    for (let page = 0; page < 8; page++) {
      const report = attentionReport({ store, accessRequests }, token, roomId, binding, nowMs, { cursor });
      items.push(...report.items);
      if (!report.nextCursor || items.length >= report.itemCount) break;
      cursor = report.nextCursor;
    }
    const requestsById = new Map();
    for (const request of accessRequests.list(token, roomId, { status: "pending" }, binding)) {
      requestsById.set(request.requestId, request);
    }
    const workItems = state.workItems ?? {};
    const budgetsByWorkItem = sessionBudgetsByWorkItem(store, roomId);
    for (const item of items) {
      if (item.kind === "jev_escalation") continue; // shadow diagnostics are not decisions (spec §4.1)
      decisions.push(enrichDecision(item, base, decisionFacts(item, {
        requestsById, workItems, budgetsByWorkItem,
      }), nowMs));
    }

    collectDisputes(store, roomId, base, nowMs, decisions, exceptions);
    collectRoomExceptions(store, roomId, base, state, nowMs, windowStart, exceptions);
    const moneyEntry = collectRoomMoney(store, roomId, base, state, nowMs, windowStart, moneyRooms);
    collectRoomRoster({ store, token, binding }, roomId, base, state, nowMs, moneyEntry, rosterRows);
    roomsIncluded++;
    ownerRoomsIncluded++;
  };

  for (const roomId of pageIds) {
    try { collectRoom(roomId); }
    catch (error) {
      const code = typeof error?.code === "string" ? error.code : "room_read_failed";
      roomErrors.push(Object.freeze({ roomId, error: code }));
      exceptions.push(Object.freeze({
        severity: "warn", kind: "room_read_failed", roomId, roomName: null, subjectId: roomId,
        firstSeenInWindow: iso(nowMs), detail: `This room could not be read (${code}); it is excluded from the totals below`,
        drill: null, evaluatedThrough: null,
      }));
    }
  }

  // §10: a viewer who is an admin everywhere and an owner nowhere gets
  // the access-request queue only — no exceptions section at all.
  if (ownerRoomsIncluded === 0) exceptions.length = 0;
  else collectJobExceptions(jobHealth, nowMs, exceptions);

  // Slice 2 sections are owner-only: with no owned room in the page they
  // are null (absent), never an empty aggregate an admin could read.
  const money = ownerRoomsIncluded === 0 ? null : buildMoneySection(moneyRooms);
  const roster = ownerRoomsIncluded === 0 ? null : buildRosterSection(rosterRows);

  const sortedDecisions = [...decisions].sort(decisionOrder);
  const sortedExceptions = [...exceptions].sort(exceptionOrder);
  const overdue = sortedDecisions.filter(item => item.consequenceAtMs !== null && item.consequenceAtMs <= nowMs).length;
  const oldestAgeMs = sortedDecisions.reduce((max, item) => Math.max(max, item.ageMs ?? 0), 0);

  return Object.freeze({
    contractVersion: 1,
    generatedAt: iso(nowMs),
    window: Object.freeze({ key: window, ms: windowMs, since: iso(windowStart) }),
    viewer: Object.freeze({ accountId, authEpoch: auth.account.authEpoch,
      sessionRevision: auth.sessionRevision, sessionBinding: auth.sessionBinding }),
    rooms: Object.freeze({
      considered: roomsConsidered,
      included: roomsIncluded,
      label: roomsIncluded < roomsConsidered ? `${roomsIncluded} of ${roomsConsidered} rooms` : null,
      nextCursor: hasMore ? pageIds[pageIds.length - 1] : null,
    }),
    decisions: Object.freeze({
      total: sortedDecisions.length,
      waiting: sortedDecisions.length,
      overdue,
      oldestAgeMs,
      items: Object.freeze(sortedDecisions.slice(0, DECISIONS_CAP)),
    }),
    exceptions: Object.freeze({
      total: sortedExceptions.length,
      items: Object.freeze(sortedExceptions.slice(0, EXCEPTIONS_CAP)),
    }),
    money,
    roster,
    roomErrors: Object.freeze(roomErrors),
  });
}

// Attach the §4 fields (age, consequence, money at stake) to a #662 item
// without changing the item's own shape contract: the merged queue item is
// the #662 item plus room provenance and these derived fields.
function enrichDecision(item, base, facts, nowMs) {
  const createdAtMs = facts.createdAtMs ?? null;
  return Object.freeze({
    ...item,
    ...base,
    createdAtMs,
    ageMs: createdAtMs === null ? null : Math.max(0, nowMs - createdAtMs),
    consequence: facts.consequence ?? null,
    consequenceAtMs: facts.consequenceAtMs ?? null,
    timeToConsequenceMs: facts.consequenceAtMs == null ? null : facts.consequenceAtMs - nowMs,
    ...(facts.amountMillis != null ? { amountMillis: facts.amountMillis } : {}),
    ...(facts.amountCents != null ? { amountCents: facts.amountCents } : {}),
    ...(facts.bountyId ? { bountyId: facts.bountyId } : {}),
  });
}

function decisionFacts(item, { requestsById, workItems, budgetsByWorkItem }) {
  if (item.kind === "access_request") {
    const request = requestsById.get(item.id);
    const createdAtMs = request ? ms(request.createdAt) : null;
    return { createdAtMs, consequenceAtMs: createdAtMs === null ? null : createdAtMs + REQUEST_TTL_MS,
      consequence: CONSEQUENCE.access_request };
  }
  const workItem = workItems[item.id] ?? null;
  if (item.kind === "claim_lease") {
    const expiresAtMs = workItem?.claim ? ms(workItem.claim.expiresAt) : null;
    return { createdAtMs: workItem ? ms(workItem.createdAt) : null,
      consequenceAtMs: expiresAtMs, consequence: CONSEQUENCE.claim_lease };
  }
  if (item.kind === "verification" || item.kind === "decision") {
    // Waiting since the completion landed (updatedAt tracks the last
    // transition); money at stake is the work's session budget cap where
    // one was declared — the escrow amount lives on the bounty, which is
    // a separate record from the work item.
    const budget = budgetsByWorkItem.get(item.id);
    return { createdAtMs: workItem ? (ms(workItem.updatedAt) ?? ms(workItem.createdAt)) : null,
      consequenceAtMs: null, consequence: CONSEQUENCE[item.kind],
      amountCents: typeof budget === "number" ? budget : null };
  }
  if (item.kind === "spend") {
    return { createdAtMs: null, consequenceAtMs: null, consequence: CONSEQUENCE.spend };
  }
  return { createdAtMs: workItem ? ms(workItem.createdAt) : null, consequenceAtMs: null, consequence: null };
}

// §4.2 ordering: overdue first, then nearest consequence, then money at
// stake descending, then oldest first. Money comparison reads whichever
// single currency field the item carries — the fields themselves stay
// disjoint; only the sort key is shared, exactly as the spec's key 3
// defines it (dispute millis, then budget cents).
function decisionOrder(a, b) {
  const overdueA = a.consequenceAtMs !== null && a.timeToConsequenceMs <= 0 ? 0 : 1;
  const overdueB = b.consequenceAtMs !== null && b.timeToConsequenceMs <= 0 ? 0 : 1;
  if (overdueA !== overdueB) return overdueA - overdueB;
  const ttcA = a.timeToConsequenceMs, ttcB = b.timeToConsequenceMs;
  if (ttcA !== ttcB) {
    if (ttcA === null) return 1;
    if (ttcB === null) return -1;
    return ttcA - ttcB;
  }
  const moneyA = a.amountMillis ?? a.amountCents ?? 0;
  const moneyB = b.amountMillis ?? b.amountCents ?? 0;
  if (moneyA !== moneyB) return moneyB - moneyA;
  return (a.createdAtMs ?? Number.MAX_SAFE_INTEGER) - (b.createdAtMs ?? Number.MAX_SAFE_INTEGER);
}

function exceptionOrder(a, b) {
  const rank = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (rank !== 0) return rank;
  const seenA = ms(a.firstSeenInWindow) ?? 0, seenB = ms(b.firstSeenInWindow) ?? 0;
  if (seenA !== seenB) return seenB - seenA;
  return String(a.kind).localeCompare(String(b.kind));
}

// Open disputes: bounties in the disputed state whose dispute record (when
// one is persisted) is not terminal. The bounty row carries the opened
// timestamp and the amount; the dispute record's state is authoritative
// when present because finality settles through it.
function openDisputes(store, roomId) {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bounty_records'").get()) return [];
  const rows = store.db.prepare(
    "SELECT bounty_id, title, amount_millis, dispute_id, dispute_opened_ms, state_changed_ms FROM bounty_records WHERE room_id=? AND state='disputed'"
  ).all(roomId);
  const hasDisputeTable = Boolean(store.db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='bounty_disputes'").get());
  return rows.filter(row => {
    if (!hasDisputeTable || !row.dispute_id) return true;
    const record = store.db.prepare("SELECT body FROM bounty_disputes WHERE dispute_id=?").get(row.dispute_id);
    if (!record) return true;
    try {
      const parsed = JSON.parse(record.body);
      return !["resolved", "withdrawn"].includes(parsed.state);
    } catch { return true; }
  }).map(row => ({
    bountyId: row.bounty_id,
    title: row.title,
    amountMillis: row.amount_millis,
    disputeId: row.dispute_id ?? row.bounty_id,
    openedMs: row.dispute_opened_ms ?? row.state_changed_ms,
  }));
}

function collectDisputes(store, roomId, base, nowMs, decisions, exceptions) {
  for (const dispute of openDisputes(store, roomId)) {
    const consequenceAtMs = dispute.openedMs === null ? null : dispute.openedMs + DISPUTE_TIMEOUT_MS;
    decisions.push(enrichDecision(Object.freeze({
      kind: "dispute",
      id: dispute.disputeId,
      severity: "action",
      title: `Dispute: ${dispute.title}`,
      detail: `${dispute.amountMillis} milli-credits at stake on bounty ${dispute.bountyId}`,
      actions: reviewBountiesAction(roomId),
    }), base, {
      createdAtMs: dispute.openedMs, consequenceAtMs, consequence: CONSEQUENCE.dispute,
      amountMillis: dispute.amountMillis, bountyId: dispute.bountyId,
    }, nowMs));
    if (consequenceAtMs !== null && consequenceAtMs - nowMs < DISPUTE_NEAR_DEFAULT_MS) {
      exceptions.push(Object.freeze({
        severity: "critical", kind: "dispute_nearing_default", roomId, roomName: base.roomName,
        subjectId: dispute.disputeId,
        firstSeenInWindow: iso(dispute.openedMs),
        detail: `Dispute on "${dispute.title}" defaults to release soon — ${dispute.amountMillis} milli-credits move on their own at the deadline`,
        drill: Object.freeze({ action: "review", method: "GET", path: `/api/rooms/${roomId}/bounties` }),
        evaluatedThrough: base.evaluatedThrough,
      }));
    }
  }
}

// Per-room exceptions (spec §6), owner rooms only.
function collectRoomExceptions(store, roomId, base, state, nowMs, windowStart, exceptions) {
  const push = entry => exceptions.push(Object.freeze({ roomId, roomName: base.roomName,
    evaluatedThrough: base.evaluatedThrough, ...entry }));

  // Budget trip-wire stops + other-cause session stops, from the same
  // events read roomUsageSummary folds. The tripping amount is never
  // displayed: the SESSION_STOPPED source omits it (known defect, spec
  // §1) — the drill goes to the session ledger instead.
  const sinceIso = iso(windowStart);
  const sessionRows = store.db.prepare(
    `SELECT json_extract(body,'$.type') AS type, json_extract(body,'$.data.workItemId') AS workItemId,
            json_extract(body,'$.data.budgetEnforced') AS budgetEnforced, json_extract(body,'$.at') AS at
     FROM events WHERE room_id=? AND json_extract(body,'$.type') IN ('session.started','session.status_changed','session.stopped')
       AND json_extract(body,'$.at')>=? ORDER BY sequence`
  ).all(roomId, sinceIso);
  const workItems = state.workItems ?? {};
  const budgetStops = new Map(); // workItemId -> earliest stop ms
  const otherStops = new Map(); // workItemId -> latest stop ms
  for (const row of sessionRows) {
    if (row.type !== "session.stopped" || typeof row.workItemId !== "string") continue;
    const atMs = ms(row.at);
    if (atMs === null) continue;
    if (row.budgetEnforced === 1 || row.budgetEnforced === true) {
      if (!budgetStops.has(row.workItemId) || atMs < budgetStops.get(row.workItemId)) budgetStops.set(row.workItemId, atMs);
    } else if (!otherStops.has(row.workItemId) || atMs > otherStops.get(row.workItemId)) {
      otherStops.set(row.workItemId, atMs);
    }
  }
  for (const [workItemId, atMs] of budgetStops) {
    const title = workItems[workItemId]?.title ?? workItemId;
    push({ severity: "warn", kind: "budget_stop", subjectId: workItemId, firstSeenInWindow: iso(atMs),
      detail: `Session stopped on budget — ${title}`, drill: usageDrill(roomId) });
  }
  for (const [workItemId, atMs] of otherStops) {
    const item = workItems[workItemId];
    if (item && item.state === "completed") continue; // settled work is not an exception
    const title = item?.title ?? workItemId;
    push({ severity: "info", kind: "session_stopped", subjectId: workItemId, firstSeenInWindow: iso(atMs),
      detail: `Session stopped — ${title}`, drill: usageDrill(roomId) });
  }

  // Stale board claims (claimIdle: untouched past its idle threshold).
  let claims = [];
  try { claims = store.workClaims?.list(roomId) ?? []; } catch { claims = []; }
  for (const claim of claims) {
    if (!claim || claim.owner == null || TERMINAL_CLAIM_STATES.has(claim.state)) continue;
    if (!claimIdle(claim, nowMs)) continue;
    const touchedMs = Math.max(ms(claim.updatedAt) ?? 0, ms(claim.leaseStartAt) ?? 0, ms(claim.claimedAt) ?? 0);
    const idleMs = touchedMs > 0 ? nowMs - touchedMs : 0;
    push({ severity: idleMs >= STALE_CLAIM_CRITICAL_MS ? "critical" : "warn", kind: "stale_claim",
      subjectId: claim.id, firstSeenInWindow: iso(touchedMs || null),
      detail: `Claim untouched for ${Math.floor(idleMs / 3600000)}h — ${claim.title ?? claim.id}`,
      drill: Object.freeze({ action: "review", method: "GET", path: `/api/rooms/${roomId}/work-context?workItemId=${encodeURIComponent(claim.id)}` }) });
  }

  // Expired claim leases on work items (#662 carries these as decisions
  // too; spec §6 lists the expired form here as a warning).
  for (const item of Object.values(workItems)) {
    const claim = item.claim;
    if (claim && claim.status === "active" && typeof claim.expiresAt === "string") {
      const expiresMs = ms(claim.expiresAt);
      if (expiresMs !== null && expiresMs <= nowMs) {
        push({ severity: "warn", kind: "claim_lease_expired", subjectId: item.id,
          firstSeenInWindow: iso(expiresMs), detail: `Claim lease expired unworked — ${item.title}`,
          drill: Object.freeze({ action: "review", method: "GET", path: `/api/rooms/${roomId}/work-context?workItemId=${encodeURIComponent(item.id)}` }) });
      }
    }
  }

  // Access requests that lapsed undecided inside the window: rows the
  // per-room read has already flipped to expired whose lapse moment
  // (created + REQUEST_TTL_MS) falls in the window.
  const lapsed = store.db.prepare(
    "SELECT COUNT(*) AS n FROM access_requests WHERE room_id=? AND status='expired' AND created_at>? AND created_at<=?"
  ).get(roomId, windowStart - REQUEST_TTL_MS, nowMs - REQUEST_TTL_MS);
  if (lapsed && lapsed.n > 0) {
    push({ severity: "info", kind: "lapsed_access_requests", subjectId: roomId,
      firstSeenInWindow: iso(windowStart), count: lapsed.n,
      detail: `${lapsed.n} access request${lapsed.n === 1 ? "" : "s"} lapsed undecided in this window`,
      drill: null });
  }

  // Spend allowance already over.
  const spend = spendAllowanceReport(state, nowMs);
  if (spend.allowance && typeof spend.overCents === "number" && spend.overCents > 0) {
    push({ severity: "warn", kind: "spend_exceeded", subjectId: "spend-allowance",
      firstSeenInWindow: iso(nowMs), detail: `Spend allowance exceeded by ${spend.overCents}c`,
      drill: Object.freeze({ action: "review", method: "GET", path: `/api/rooms/${roomId}/spend-allowance` }) });
  }

  // Quiet room: agents present but nothing accepted in the last 7 days.
  const members = Object.values(state.members ?? {}).filter(member => member && member.active !== false);
  const hasAgents = members.some(member => member.kind === "agent" && member.system !== true);
  if (hasAgents) {
    const quietSince = nowMs - OVERVIEW_WINDOWS["7d"];
    const acceptedWork = Object.values(workItems).some(item =>
      item.state === "completed" && (ms(item.updatedAt) ?? 0) >= quietSince);
    let acceptedBounty = false;
    if (!acceptedWork && store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bounty_records'").get()) {
      acceptedBounty = Boolean(store.db.prepare(
        "SELECT 1 FROM bounty_records WHERE room_id=? AND state='paid' AND state_changed_ms>=? LIMIT 1").get(roomId, quietSince));
    }
    if (!acceptedWork && !acceptedBounty) {
      push({ severity: "info", kind: "quiet_room", subjectId: roomId, firstSeenInWindow: iso(quietSince),
        detail: "Agents are present but no work was accepted in the last 7 days", drill: null });
    }
  }
}

// Latest declared session budget cap per work item (session.started event
// data) — the money-at-stake fallback for verification/decision items.
function sessionBudgetsByWorkItem(store, roomId) {
  const budgets = new Map();
  const rows = store.db.prepare(
    `SELECT json_extract(body,'$.data.workItemId') AS workItemId,
            json_extract(body,'$.data.budget.maxSpendCents') AS maxSpendCents
     FROM events WHERE room_id=? AND json_extract(body,'$.type')='session.started' ORDER BY sequence`
  ).all(roomId);
  for (const row of rows) {
    if (typeof row.workItemId === "string" && typeof row.maxSpendCents === "number") budgets.set(row.workItemId, row.maxSpendCents);
  }
  return budgets;
}

// Deployment job health (spec §6): critical at >=3 consecutive failures,
// or the integrity job failing at all; any other failing job warns.
// Deployment-scoped — identical for every owner, carries no user data.
function collectJobExceptions(jobHealth, nowMs, exceptions) {
  if (typeof jobHealth !== "function") return;
  let jobs;
  try { jobs = jobHealth(); } catch { return; }
  if (!Array.isArray(jobs)) return;
  for (const job of jobs) {
    if (!job || job.enabled === false) continue;
    const failures = job.consecutiveFailures ?? 0;
    if (!Number.isFinite(failures) || failures <= 0) continue;
    const isIntegrity = typeof job.name === "string" && job.name.toLowerCase().includes("integrity");
    const critical = failures >= 3 || isIntegrity;
    exceptions.push(Object.freeze({
      severity: critical ? "critical" : "warn", kind: "job_health", roomId: null, roomName: null,
      subjectId: job.name, firstSeenInWindow: job.lastErrorAt ?? null,
      detail: `Deployment job ${job.name} has failed ${failures} time${failures === 1 ? "" : "s"} in a row`,
      drill: Object.freeze({ action: "review", method: "GET", path: "/api/health/jobs" }),
      evaluatedThrough: null,
    }));
  }
}

// ---------------------------------------------------------------------------
// Slice 2 (§5) — Money. Two panels, always separate: Panel C carries only
// *Cents fields, Panel R only *Millis fields, and no field anywhere sums
// or converts between them. Spend is agent-reported (spec §0.3): an
// attempt that never reported renders "unknown", is excluded from sums,
// and is counted — never zeroed.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;
// Escrow states whose award is still locked in the ledger (spec §5.2).
const LOCKED_BOUNTY_STATES = Object.freeze(["funded", "claimed", "submitted", "accepted", "disputed"]);
const LOT_STATES = Object.freeze(["payable", "locked", "attributed", "approved"]);

const hasTable = (store, name) => Boolean(store.db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

// Fold the window's session events into attempts with the foldSessionEvents
// semantics (usage-summary.mjs): a session.started opens an attempt, the
// latest cumulative spendCents report wins, session.stopped closes it. The
// fold here additionally carries the attempt's worker (the session.started
// actor) so spend attributes per agent and per task from the same pass —
// the room totals equal foldSessionEvents' on the same rows (pinned by
// test). usage-summary.mjs itself is not imported: it pulls store.mjs,
// which this module deliberately stays cycle-free of (see header).
function foldAttribution(rows) {
  const open = new Map();
  const attempts = [];
  const attemptFor = (workItemId, fresh, actorId) => {
    if (fresh || !open.has(workItemId)) {
      const attempt = { workItemId, actorId: actorId ?? null, spendCents: null };
      attempts.push(attempt);
      open.set(workItemId, attempt);
    }
    return open.get(workItemId);
  };
  for (const row of rows) {
    if (row.type === SESSION_EVENT_TYPES.STARTED) attemptFor(row.workItemId, true, row.actorId);
    if (Number.isSafeInteger(row.spendCents) && row.spendCents >= 0) attemptFor(row.workItemId, false, row.actorId).spendCents = row.spendCents;
    if (row.type === SESSION_EVENT_TYPES.STOPPED) open.delete(row.workItemId);
  }
  return attempts;
}

// Group folded attempts by a key: reported spend sums, unreported attempts
// count. A group whose every attempt is unreported reports "unknown".
function spendByKey(attempts, keyOf) {
  const groups = new Map();
  for (const attempt of attempts) {
    const key = keyOf(attempt);
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, { reportedCents: 0, reported: 0, unreported: 0 });
    const group = groups.get(key);
    if (attempt.spendCents === null) group.unreported++;
    else { group.reported++; group.reportedCents += attempt.spendCents; }
  }
  return groups;
}
const groupSpend = group => group.reported > 0 ? group.reportedCents : "unknown";

// Per-room Money inputs: the Panel C reader output verbatim, the window
// attribution fold, accepted-outcome counting, and the Panel R ledger sums.
function collectRoomMoney(store, roomId, base, state, nowMs, windowStart, moneyRooms) {
  const report = spendAllowanceReport(state, nowMs);
  const rows = store.db.prepare(
    `SELECT json_extract(body,'$.type') AS type, json_extract(body,'$.data.workItemId') AS workItemId,
            json_extract(body,'$.actorId') AS actorId, json_extract(body,'$.data.spendCents') AS spendCents
     FROM events WHERE room_id=? AND json_extract(body,'$.type') IN (?,?,?) AND json_extract(body,'$.at')>=?
     ORDER BY sequence`
  ).all(roomId, SESSION_EVENT_TYPES.STARTED, SESSION_EVENT_TYPES.STATUS_CHANGED, SESSION_EVENT_TYPES.STOPPED, iso(windowStart));
  const attempts = foldAttribution(rows.filter(row => typeof row.workItemId === "string"));
  const byAgent = spendByKey(attempts, attempt => attempt.actorId);
  const byTask = spendByKey(attempts, attempt => attempt.workItemId);

  const workItems = state.workItems ?? {};
  const tasks = [...byTask.entries()].map(([workItemId, group]) => {
    const item = workItems[workItemId];
    const session = item ? sessionRecord(item) : null;
    return Object.freeze({
      roomId, roomName: base.roomName, workItemId,
      title: item?.title ?? workItemId,
      spendCents: groupSpend(group),
      attempts: group.reported + group.unreported,
      unreportedAttempts: group.unreported,
      budgetMaxSpendCents: session?.budget?.maxSpendCents ?? null,
      drill: Object.freeze({ action: "review", method: "GET", path: `/api/rooms/${roomId}/usage` }),
    });
  }).sort((a, b) => a.workItemId.localeCompare(b.workItemId));
  const agents = [...byAgent.entries()].map(([memberId, group]) => Object.freeze({
    roomId, roomName: base.roomName, memberId,
    displayName: state.members?.[memberId]?.displayName ?? memberId,
    periodCostCents: groupSpend(group),
    reportedAttempts: group.reported,
    unreportedAttempts: group.unreported,
  })).sort((a, b) => a.memberId.localeCompare(b.memberId));

  // Accepted outcomes in the window (§5.3): a work item reaching its
  // completed (accepted-terminal) state, plus bounties reaching paid.
  // The escrow records carry no bounty↔work-item link, so the two
  // recorded outcome sources are counted as recorded — no linkage is
  // invented here.
  let bountyOutcomes = 0;
  if (hasTable(store, "bounty_records")) {
    bountyOutcomes = store.db.prepare(
      "SELECT COUNT(*) AS n FROM bounty_records WHERE room_id=? AND state='paid' AND state_changed_ms>=? AND state_changed_ms<=?"
    ).get(roomId, windowStart, nowMs).n;
  }
  let workOutcomes = 0;
  for (const item of Object.values(workItems)) {
    if (!item || item.state !== "completed") continue;
    const atMs = ms(item.updatedAt) ?? ms(item.createdAt);
    if (atMs !== null && atMs >= windowStart && atMs <= nowMs) workOutcomes++;
  }

  const entry = {
    base, report, attempts, byAgent, tasks, agents,
    acceptedOutcomes: workOutcomes + bountyOutcomes,
    credits: collectRoomCredits(store, roomId),
  };
  moneyRooms.push(entry);
  return entry;
}

// Panel R inputs for one room, read straight off the escrow ledger tables
// (the same rows BountyEscrow.balances/metrics fold): bounty_records for
// the by-group / locked / disputed sums, bounty_journal for balances.
function collectRoomCredits(store, roomId) {
  const empty = { byGroup: null, lockedMillis: 0, disputedMillis: 0, poolBalanceMillis: 0, agentBalances: [] };
  if (!hasTable(store, "bounty_records")) return empty;
  const byGroup = Object.fromEntries(BOUNTY_GROUPS.map(group => [group, { count: 0, amountMillis: 0 }]));
  let lockedMillis = 0, disputedMillis = 0;
  for (const row of store.db.prepare(
    "SELECT state, amount_millis AS amountMillis FROM bounty_records WHERE room_id=?").all(roomId)) {
    const group = stateGroup(row.state);
    if (group !== null) { byGroup[group].count++; byGroup[group].amountMillis += row.amountMillis; }
    if (LOCKED_BOUNTY_STATES.includes(row.state)) lockedMillis += row.amountMillis;
    if (row.state === "disputed") disputedMillis += row.amountMillis;
  }
  let poolBalanceMillis = 0;
  const agentBalances = [];
  if (hasTable(store, "bounty_journal")) {
    poolBalanceMillis = store.db.prepare(
      "SELECT COALESCE(SUM(amount),0) AS total FROM bounty_journal WHERE room_id=? AND account_id=?")
      .get(roomId, POOL_ACCOUNT).total;
    const rows = store.db.prepare(
      `SELECT account_id AS accountId, lot_state AS lotState, COALESCE(SUM(amount),0) AS total
       FROM bounty_journal WHERE room_id=? AND account_id<>? GROUP BY account_id, lot_state`).all(roomId, POOL_ACCOUNT);
    const byAccount = new Map();
    for (const row of rows) {
      if (!byAccount.has(row.accountId)) byAccount.set(row.accountId, { accountId: row.accountId, totalMillis: 0 });
      const entry = byAccount.get(row.accountId);
      if (LOT_STATES.includes(row.lotState)) entry[row.lotState + "Millis"] = row.total;
      entry.totalMillis += row.total;
    }
    agentBalances.push(...[...byAccount.values()].sort((a, b) => a.accountId.localeCompare(b.accountId))
      .map(entry => Object.freeze({ payableMillis: 0, lockedMillis: 0, attributedMillis: 0, approvedMillis: 0, ...entry })));
  }
  return { byGroup, lockedMillis, disputedMillis, poolBalanceMillis, agentBalances };
}

// §5.3: reported cents ÷ accepted outcomes, denominator always shown.
// Ratio suppressed at n=0; "unknown" when every attempt is unreported.
function costPerOutcome(totals) {
  const { reportedCents, unreportedAttempts, acceptedOutcomes } = totals;
  if (acceptedOutcomes === 0) {
    return Object.freeze({ status: "no_outcomes", ratioCents: null, acceptedOutcomes,
      unreportedAttempts, label: "no accepted outcomes in window" });
  }
  if (reportedCents === "unknown") {
    return Object.freeze({ status: "unknown", ratioCents: null, acceptedOutcomes,
      unreportedAttempts, label: "unknown" });
  }
  const ratioCents = reportedCents / acceptedOutcomes;
  return Object.freeze({ status: "ok", ratioCents, acceptedOutcomes, unreportedAttempts,
    label: `$${(ratioCents / 100).toFixed(2)} / accepted outcome (n=${acceptedOutcomes}, ${unreportedAttempts} unreported)` });
}

function totalsOf(entries) {
  let reported = 0, reportedAttempts = 0, unreportedAttempts = 0, acceptedOutcomes = 0;
  for (const entry of entries) {
    for (const attempt of entry.attempts) {
      if (attempt.spendCents === null) unreportedAttempts++;
      else { reportedAttempts++; reported += attempt.spendCents; }
    }
    acceptedOutcomes += entry.acceptedOutcomes;
  }
  return { reportedCents: reportedAttempts > 0 ? reported : "unknown", reportedAttempts, unreportedAttempts, acceptedOutcomes };
}

function buildMoneySection(moneyRooms) {
  const roomsC = [], roomsR = [], tasks = [], agentsC = [], agentsR = [];
  for (const entry of moneyRooms) {
    const { base, report } = entry;
    const periodStartMs = ms(report.period?.since), periodEndMs = ms(report.period?.until);
    const elapsed = periodStartMs !== null && periodEndMs !== null
      ? Math.max(1, Math.round((periodEndMs - periodStartMs) / DAY_MS)) : (report.period?.days ?? 30);
    roomsC.push(Object.freeze({
      ...base,
      allowanceCents: report.allowance?.allowanceCents ?? null,
      periodDays: report.period?.days ?? null,
      spentCents: report.spentCents, reservedCents: report.reservedCents,
      heldCents: report.heldCents, committedCents: report.committedCents,
      headroomCents: report.headroomCents, overCents: report.overCents,
      burnRateCentsPerDay: Math.round((report.spentCents / elapsed) * 100) / 100,
      burnFraction: report.allowance?.allowanceCents ? report.committedCents / report.allowance.allowanceCents : null,
      drill: Object.freeze({ action: "review", method: "GET", path: `/api/rooms/${base.roomId}/spend-allowance` }),
    }));
    tasks.push(...entry.tasks);
    agentsC.push(...entry.agents);
    const credits = entry.credits;
    roomsR.push(Object.freeze({
      ...base,
      byGroup: credits.byGroup === null ? null : Object.freeze(Object.fromEntries(
        Object.entries(credits.byGroup).map(([group, sums]) => [group, Object.freeze(sums)]))),
      lockedMillis: credits.lockedMillis,
      disputedMillis: credits.disputedMillis,
      poolBalanceMillis: credits.poolBalanceMillis,
      drill: Object.freeze({ action: "review", method: "GET", path: `/api/rooms/${base.roomId}/bounties` }),
    }));
    for (const balance of credits.agentBalances) {
      agentsR.push(Object.freeze({ ...base, ...balance }));
    }
  }
  const totals = totalsOf(moneyRooms);
  return Object.freeze({
    cents: Object.freeze({
      unit: "cents", source: "agent-reported",
      rooms: Object.freeze(roomsC), tasks: Object.freeze(tasks), agents: Object.freeze(agentsC),
      totals: Object.freeze({ reportedCents: totals.reportedCents,
        reportedAttempts: totals.reportedAttempts, unreportedAttempts: totals.unreportedAttempts }),
      costPerAcceptedOutcome: costPerOutcome(totals),
    }),
    credits: Object.freeze({
      unit: "milli-credits",
      rooms: Object.freeze(roomsR), agents: Object.freeze(agentsR),
      totals: Object.freeze({
        lockedMillis: moneyRooms.reduce((sum, entry) => sum + entry.credits.lockedMillis, 0),
        disputedMillis: moneyRooms.reduce((sum, entry) => sum + entry.credits.disputedMillis, 0),
        poolBalanceMillis: moneyRooms.reduce((sum, entry) => sum + entry.credits.poolBalanceMillis, 0),
      }),
    }),
  });
}

// ---------------------------------------------------------------------------
// Slice 2 (§3) — Roster. One row per (agent × room), derived from
// store.presence() (host status, last seen, live working map) plus the
// room's board claims (claimIdle stalled derivation), the member's session
// records (blocked), its autonomy tier, its per-room reputation band and
// its latest journal-stamped bounty receipt. Humans and guests excluded.
// ---------------------------------------------------------------------------

function collectRoomRoster({ store, token, binding }, roomId, base, state, nowMs, moneyEntry, rosterRows) {
  let presenceDoc = null;
  try { presenceDoc = store.presence(token, roomId, [], binding); } catch { presenceDoc = null; }
  const presenceByMember = new Map((presenceDoc?.members ?? []).map(member => [member.memberId, member]));
  const escrow = store.bountyEscrow ?? null;

  let claims = [];
  try { claims = store.workClaims?.list(roomId) ?? []; } catch { claims = []; }
  const claimsByOwner = new Map();
  for (const claim of claims) {
    if (!claim || claim.owner == null || TERMINAL_CLAIM_STATES.has(claim.state)) continue;
    if (!claimsByOwner.has(claim.owner)) claimsByOwner.set(claim.owner, []);
    claimsByOwner.get(claim.owner).push(claim);
  }

  const lastReceiptByLane = latestReceiptsByLane(store, roomId);
  const members = Object.values(state.members ?? {})
    .filter(member => member && member.kind === "agent" && member.system !== true && member.active !== false)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const member of members) {
    const presenceRow = presenceByMember.get(member.id) ?? null;
    const hostStatus = presenceRow?.presence?.status ?? null;
    const workingOn = presenceRow?.workingOn ?? [];
    const sessions = Object.values(state.workItems ?? {})
      .map(item => ({ item, session: sessionRecord(item) }))
      .filter(({ session }) => session.worker_member_id === member.id);
    const blocked = sessions.some(({ session }) =>
      session.suspended_by !== null || (session.stop_requested_at !== null
        && ["processing", "active", "suspended"].includes(session.status)));
    const stalled = (claimsByOwner.get(member.id) ?? []).some(claim => claimIdle(claim, nowMs));
    const workState = hostStatus === "offline" ? "offline"
      : workingOn.length > 0 ? "working"
      : stalled ? "stalled"
      : blocked ? "blocked" : "idle";

    let reputationBand = null;
    if (escrow && hasTable(store, "bounty_events")) {
      try { reputationBand = reputationSummary(escrow, roomId, canonicalLane(member.id), { nowMs }).band; }
      catch { reputationBand = null; }
    }
    let autonomyTier = DEFAULT_AUTONOMY_TIER;
    try { autonomyTier = getTier(store.db, roomId, member.id)?.autonomyTier ?? DEFAULT_AUTONOMY_TIER; }
    catch { autonomyTier = DEFAULT_AUTONOMY_TIER; }

    const cost = moneyEntry?.byAgent.get(member.id);
    const lane = canonicalLane(member.id);
    const receipt = lastReceiptByLane.get(lane) ?? null;
    rosterRows.push(Object.freeze({
      ...base,
      memberId: member.id,
      displayName: member.displayName ?? member.id,
      identityId: presenceRow?.ownerIdentityId ?? null,
      hostStatus,
      lastSeenAt: presenceRow?.lastSeenAt ?? null,
      currentWork: workingOn.length > 0 ? Object.freeze({ ...workingOn[0] }) : null,
      workState,
      autonomyTier,
      reputationBand,
      lastReceipt: receipt === null ? null : Object.freeze({
        receiptId: receipt.receiptId, bountyId: receipt.bountyId, at: receipt.at,
        drill: Object.freeze({ action: "review", method: "GET",
          path: `/api/rooms/${roomId}/bounties/${encodeURIComponent(receipt.bountyId)}` }),
      }),
      periodCostCents: cost ? groupSpend(cost) : "unknown",
      unreportedAttempts: cost?.unreported ?? 0,
      lifetimeAcceptedOutcomes: lifetimeAcceptedOutcomes(store, state, roomId, member.id),
    }));
  }
}

// Lifetime (all-time, per room) accepted outcomes for one member: work
// items they hold that reached completed, plus bounties they claimed
// that reached paid (the escrow records carry no bounty↔work-item link,
// so the two recorded sources are counted as recorded).
function lifetimeAcceptedOutcomes(store, state, roomId, memberId) {
  let count = 0;
  if (hasTable(store, "bounty_records")) {
    count += store.db.prepare(
      "SELECT COUNT(*) AS n FROM bounty_records WHERE room_id=? AND state='paid' AND claimant=?")
      .get(roomId, canonicalLane(memberId)).n;
  }
  for (const item of Object.values(state.workItems ?? {})) {
    if (!item || item.state !== "completed") continue;
    const session = sessionRecord(item);
    if (session.worker_member_id === memberId || item.claim?.owner === memberId
      || item.accountableMemberId === memberId) count++;
  }
  return count;
}

// Latest signed-receipt linkage per ledger lane, from the journal — the
// same receipt_id stamping escrow.history() surfaces as signedReceiptIds.
function latestReceiptsByLane(store, roomId) {
  const byLane = new Map();
  if (!hasTable(store, "bounty_journal")) return byLane;
  const hasReceiptId = store.db.prepare(
    "SELECT 1 FROM pragma_table_info('bounty_journal') WHERE name='receipt_id'").get();
  if (!hasReceiptId) return byLane;
  const rows = store.db.prepare(
    `SELECT account_id AS accountId, receipt_id AS receiptId, bounty_id AS bountyId, at
     FROM bounty_journal WHERE room_id=? AND receipt_id IS NOT NULL ORDER BY at DESC, entry_id DESC`).all(roomId);
  for (const row of rows) {
    if (!byLane.has(row.accountId)) {
      byLane.set(row.accountId, { receiptId: row.receiptId, bountyId: row.bountyId, at: row.at });
    }
  }
  return byLane;
}

function buildRosterSection(rosterRows) {
  const byIdentity = new Map();
  for (const row of rosterRows) {
    const key = row.identityId ?? row.memberId;
    if (!byIdentity.has(key)) {
      byIdentity.set(key, { identityId: row.identityId, memberId: row.memberId,
        displayName: row.displayName, rooms: [] });
    }
    byIdentity.get(key).rooms.push(row);
  }
  const counts = { total: rosterRows.length, working: 0, idle: 0, stalled: 0, blocked: 0, offline: 0 };
  for (const row of rosterRows) counts[row.workState]++;
  return Object.freeze({
    total: rosterRows.length,
    counts: Object.freeze(counts),
    agents: Object.freeze([...byIdentity.values()].map(group => Object.freeze({
      ...group, rooms: Object.freeze(group.rooms) }))),
    rows: Object.freeze(rosterRows),
  });
}
