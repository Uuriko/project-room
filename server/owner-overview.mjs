// #3342 — Owner Cockpit slice 1: the cross-room read model behind
// GET /api/owner/overview (spec: project-room-owner-cockpit.md §§2, 4, 6).
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
import { DISPUTE_TIMEOUT_MS } from "./bounty-escrow.mjs";
import { spendAllowanceReport } from "./spend-allowance.mjs";
import { claimIdle } from "./agent-fleet.mjs";

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
  // INDEXED BY pins the v39 type/at index (see usage-summary.mjs).
  const sessionRows = store.db.prepare(
    `SELECT ev_type AS type, ev_work_item_id AS workItemId,
            json_extract(body,'$.data.budgetEnforced') AS budgetEnforced, ev_at AS at
     FROM events INDEXED BY events_room_type_at WHERE room_id=? AND ev_type IN ('session.started','session.status_changed','session.stopped')
       AND ev_at>=? ORDER BY sequence`
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
