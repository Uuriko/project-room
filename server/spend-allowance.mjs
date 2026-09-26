// Issue #6 C3: room-level spend allowance.
//
// The owner records an allowance (integer cents over a rolling period) as a
// room event; the projection carries it (src/events.js spendAllowance). This
// module derives the ledger from the projection (src/work-item-session.js
// spendLedger) and enforces the allowance at the one write path every
// session start goes through, store.command(): a session.started that would
// commit more than the allowance is refused before anything is written, and
// a live session must have declared maxSpendCents so the room can reserve
// it - unknown spend never authorises an overage. Stops are always accepted
// so actual spend lands in the log. No new tables, no schema bump.
//
// This module does not import server/store.mjs (store imports it); errors
// carry status and code like ServiceError and the router reads them as such.
import { randomUUID } from "node:crypto";
import { EVENT_TYPES as T, spendAllowance, SPEND_ALLOWANCE_LIMITS, validId } from "../src/events.js";
import { sessionRecord, isTerminalSession, isRunningSession, spendLedger } from "../src/work-item-session.js";

export const SPEND_ALLOWANCE_DEFAULT_PERIOD_DAYS = 30;

export class SpendAllowanceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const refuse = (status, code, message) => { throw new SpendAllowanceError(status, code, message); };
const dollars = cents => `$${(cents / 100).toFixed(2)}`;

// The read: allowance, spent, reserved and headroom over the allowance period
// (30 days when no allowance is set, so the figures are still meaningful).
export function spendAllowanceReport(state, nowMs = Date.now()) {
  const allowance = spendAllowance(state);
  const ledger = spendLedger(state, { nowMs, periodDays: allowance?.periodDays ?? SPEND_ALLOWANCE_DEFAULT_PERIOD_DAYS });
  const { periodDays, since, until, ...figures } = ledger;
  return {
    allowance,
    period: { days: periodDays, since, until },
    ...figures,
    headroomCents: allowance ? Math.max(0, allowance.allowanceCents - ledger.committedCents) : null,
    overCents: allowance ? Math.max(0, ledger.committedCents - allowance.allowanceCents) : 0
  };
}

// The effective spend cap of a session start: the declared budget, or on a
// retry that declares none, the budget the item already carries (the applier
// inherits it the same way - silence never widens a limit).
function startingSpendCap(item, data) {
  const session = sessionRecord(item);
  const budget = data.budget == null && isTerminalSession(session.status) ? session.budget : data.budget;
  const cap = budget?.maxSpendCents;
  return Number.isSafeInteger(cap) && cap > 0 ? cap : null;
}

// Called by store.command() inside the write transaction, before the event
// is applied. `fail(status, code, message)` is the store's own thrower.
export function enforceSpendAllowance(state, command, nowMs, fail = refuse) {
  if (command.type !== T.SESSION_STARTED && command.type !== T.SESSION_STATUS_CHANGED) return;
  const allowance = spendAllowance(state);
  if (!allowance) return;
  const item = state.workItems?.[command.data.workItemId];
  if (!item) return; // the applier reports the missing item
  const ledger = spendLedger(state, { nowMs, periodDays: allowance.periodDays });
  const summary = `${dollars(ledger.spentCents)} spent, ${dollars(ledger.reservedCents)} reserved and ${dollars(ledger.heldCents)} held for unreported attempts of a ${dollars(allowance.allowanceCents)} allowance over ${allowance.periodDays} days`;
  if (command.type === T.SESSION_STARTED) {
    const cap = startingSpendCap(item, command.data);
    if (cap === null) {
      fail(422, "spend_allowance_budget_required", `This room has a spend allowance (${summary}): declare budget.maxSpendCents when the session starts so the room can reserve it; no session was started`);
    }
    if (ledger.committedCents + cap > allowance.allowanceCents) {
      fail(409, "spend_allowance_exceeded", `Starting this session would reserve ${dollars(cap)} with ${summary} (${dollars(Math.max(0, allowance.allowanceCents - ledger.committedCents))} left); no session was started`);
    }
    return;
  }
  // A running session's spend report may not carry the room past the
  // allowance: within its reservation the report changes nothing; beyond it,
  // the overage is refused and the session must stop (a stop always lands).
  const session = sessionRecord(item);
  if (!isRunningSession(session.status) || !Number.isSafeInteger(command.data.spendCents)) return;
  const cap = session.budget?.maxSpendCents ?? null;
  const before = cap === null ? (session.spend_cents ?? 0) : Math.max(cap, session.spend_cents ?? 0);
  const after = cap === null ? command.data.spendCents : Math.max(cap, command.data.spendCents);
  if (after > before && ledger.committedCents + (after - before) > allowance.allowanceCents) {
    fail(409, "spend_allowance_exceeded", `Reporting ${dollars(command.data.spendCents)} would carry the room past its allowance (${summary}); stop the session to record the spend`);
  }
}

// GET /api/rooms/:id/spend-allowance - every member may read it: the figures
// derive from the work-session state members already see.
export function readSpendAllowance(store, token, roomId, expectedSessionBinding = null) {
  return store.readTransaction(() => {
    store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    return { roomId, evaluatedThrough: room.sequence, ...spendAllowanceReport(room.state, store.now()) };
  });
}

// POST /api/rooms/:id/spend-allowance - owner only (403 for everyone else,
// checked here before the command so a non-owner learns nothing but the
// refusal). Body: { allowanceCents, periodDays?, requestId? } or
// { allowanceCents: null } to remove the allowance.
export function setSpendAllowance(store, token, roomId, request, expectedSessionBinding = null) {
  // Authenticate and authorize before parsing the request shape: a non-owner
  // learns nothing about accepted fields from a malformed write. Agent room
  // owners carry the same owner capability as human room owners.
  store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    if (auth.member.id !== room.state.room.ownerId) refuse(403, "owner_required", "Only the room owner can set the spend allowance");
  });
  if (!request || Array.isArray(request) || typeof request !== "object") refuse(422, "invalid_spend_allowance", "Supply allowanceCents and an optional periodDays");
  const keys = Object.keys(request);
  if (!keys.includes("allowanceCents") || keys.some(key => !["allowanceCents", "periodDays", "requestId"].includes(key))) {
    refuse(422, "invalid_spend_allowance", "Supply allowanceCents (integer cents, or null to remove the allowance), an optional periodDays and an optional requestId");
  }
  const { allowanceCents } = request;
  const clearing = allowanceCents === null;
  if (!clearing && (!Number.isSafeInteger(allowanceCents) || allowanceCents < 0 || allowanceCents > SPEND_ALLOWANCE_LIMITS.allowanceCents)) {
    refuse(422, "invalid_spend_allowance", `allowanceCents must be an integer of cents from 0 to ${SPEND_ALLOWANCE_LIMITS.allowanceCents}, or null to remove the allowance`);
  }
  const periodDays = clearing ? null : request.periodDays ?? SPEND_ALLOWANCE_DEFAULT_PERIOD_DAYS;
  if (!clearing && (!Number.isSafeInteger(periodDays) || periodDays < 1 || periodDays > SPEND_ALLOWANCE_LIMITS.periodDays)) {
    refuse(422, "invalid_spend_allowance", `periodDays must be an integer from 1 to ${SPEND_ALLOWANCE_LIMITS.periodDays}`);
  }
  if (clearing && request.periodDays != null) refuse(422, "invalid_spend_allowance", "Removing the allowance takes no periodDays");
  if (request.requestId !== undefined && !validId(request.requestId)) refuse(422, "invalid_spend_allowance", "requestId must be a valid identifier");
  return store.command(token, roomId, { id: request.requestId ?? randomUUID(), type: T.ROOM_SPEND_ALLOWANCE_SET,
    data: { allowanceCents: clearing ? null : allowanceCents, periodDays } }, expectedSessionBinding);
}
