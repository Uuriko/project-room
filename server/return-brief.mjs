// Return-brief wiring (disposition 5557850637): one additive read endpoint with an explicit
// history/current boundary.
//
//   history: { cursor: C, evaluatedThrough: H, items, hasMore, continuation }
//   current: { evaluatedThrough: N, needsAttention, workInvolvingMe }
//
// - "What changed" is FIXED through H: the horizon freezes on the first page (H = N at that
//   request) and every continuation carries H plus the last sequence, so events arriving
//   mid-pagination never leak into an earlier-frozen history.
// - Fetching NEVER acknowledges. Only the separate explicit cursor action (POST cursor)
//   acknowledges exactly H; H+1 stays new.
// - The two action sections are LIVE current projections through N, computed by the r3
//   selectors (wired unchanged) over the current work-item projection - unresolved work
//   survives any amount of reading, and terminal work never masquerades as open.
// - Items are full event envelopes (sequence + event), so every accessible event stays
//   drillable; the proposer of work.proposed is the envelope actorId.

import { needsAttention, workInvolvingMe } from "./return-selectors.mjs";

export class ReturnBriefError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ReturnBriefError(status, code, message); };

export const RETURN_BRIEF_DEFAULT_LIMIT = 50; // disposition: bounded pages, 50 is reasonable
export const RETURN_BRIEF_MAX_LIMIT = 100;    // same ceiling as the events endpoint

// Validates the request and resolves the paging window. First page: H freezes at N and the
// window opens at the member's stored cursor C (never client-supplied). Continuations carry
// H plus the last sequence; an H beyond current history can only come from a stale or forged
// continuation and is rejected.
export function resolveHistoryWindow({ sequence, cursor, horizon = null, after = null, limit = RETURN_BRIEF_DEFAULT_LIMIT }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RETURN_BRIEF_MAX_LIMIT) fail(422, "invalid_cursor", "Invalid return-brief limit");
  if (!Number.isSafeInteger(cursor) || cursor < 0) fail(422, "invalid_cursor", "Invalid stored cursor");
  if (horizon === null) return { H: sequence, startAfter: cursor, limit };
  if (!Number.isSafeInteger(horizon) || horizon < 0) fail(422, "invalid_cursor", "Invalid history horizon");
  if (horizon > sequence) fail(409, "cursor_ahead", "Horizon exceeds room history; fetch a fresh return brief");
  if (!Number.isSafeInteger(after) || after < 0 || after > horizon) fail(422, "invalid_cursor", "Invalid continuation cursor");
  return { H: horizon, startAfter: after, limit };
}

// Assembles the response. rows are the room's events with startAfter < sequence <= H in
// ascending sequence order, already capped at limit by the store query.
export function buildReturnBrief({ sequence, workItems, rows, cursor, memberId, horizon = null, after = null, limit = RETURN_BRIEF_DEFAULT_LIMIT }) {
  const { H, startAfter } = resolveHistoryWindow({ sequence, cursor, horizon, after, limit });
  const items = rows.map(r => ({ sequence: r.sequence, event: r.event }));
  const last = items.at(-1)?.sequence ?? startAfter;
  const hasMore = last < H;
  return {
    history: {
      cursor,
      evaluatedThrough: H,
      items,
      hasMore,
      continuation: hasMore ? { horizon: H, after: last } : null
    },
    current: {
      evaluatedThrough: sequence,
      needsAttention: needsAttention({ workItems, memberId }),
      workInvolvingMe: workInvolvingMe({ workItems, memberId })
    }
  };
}
