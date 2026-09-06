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
// H, the last sequence, AND the frozen C: if another tab has since acknowledged (the stored
// cursor moved), the frozen window is internally inconsistent ("since marker 120 through
// event 100") and is rejected 409 cursor_changed so the client restarts on a fresh horizon.
export function resolveHistoryWindow({ sequence, storedCursor, horizon = null, after = null, continuationCursor = null, limit = RETURN_BRIEF_DEFAULT_LIMIT }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RETURN_BRIEF_MAX_LIMIT) fail(422, "invalid_cursor", "Invalid return-brief limit");
  if (!Number.isSafeInteger(storedCursor) || storedCursor < 0) fail(422, "invalid_cursor", "Invalid stored cursor");
  if (horizon === null) return { H: sequence, startAfter: storedCursor, C: storedCursor, limit };
  if (!Number.isSafeInteger(horizon) || horizon < 0) fail(422, "invalid_cursor", "Invalid history horizon");
  if (horizon > sequence) fail(409, "cursor_ahead", "Horizon exceeds room history; fetch a fresh return brief");
  if (!Number.isSafeInteger(after) || after < 0 || after > horizon) fail(422, "invalid_cursor", "Invalid continuation cursor");
  if (!Number.isSafeInteger(continuationCursor) || continuationCursor < 0) fail(422, "invalid_cursor", "Continuations must carry the frozen cursor");
  // Malformed tuples are rejected before any cursor comparison: the frozen cursor opens the
  // window, so a cursor past the continuation point (C > after) describes a backwards window.
  if (continuationCursor > after) fail(422, "invalid_cursor", "Malformed continuation tuple: the frozen cursor must not exceed the continuation point");
  if (continuationCursor !== storedCursor) fail(409, "cursor_changed", "Your caught-up marker moved since this horizon froze; restart the return brief");
  return { H: horizon, startAfter: after, C: continuationCursor, limit };
}

// Assembles the response. rows are the room's events with startAfter < sequence <= H in
// ascending sequence order, already capped at limit by the store query.
export function buildReturnBrief({ sequence, workItems, rows, H, startAfter, C, memberId }) {
  const items = rows.map(r => ({ sequence: r.sequence, event: r.event }));
  const last = items.at(-1)?.sequence ?? startAfter;
  const hasMore = last < H;
  return {
    history: {
      cursor: C, // frozen on the first page, reported unchanged on every continuation
      evaluatedThrough: H,
      items,
      hasMore,
      continuation: hasMore ? { horizon: H, after: last, cursor: C } : null
    },
    current: {
      evaluatedThrough: sequence,
      needsAttention: needsAttention({ workItems, memberId }),
      workInvolvingMe: workInvolvingMe({ workItems, memberId })
    }
  };
}
