// Supervision inbox backend (herdr redesign, lane B6): pure card state
// machine + deterministic ≤2-suggestion decider for the triage queue.
//
// Same repo pattern as server/next-actions.mjs and server/inbox-triage.mjs:
// dependency-free, caller-supplied inputs, frozen outputs, no I/O, no LLM
// calls. Every suggestion carries a one-line reason (the anti-silent-routing
// rule from phase1/inbox-mapping.md §2.4).
//
// Card taxonomy (all derived from existing tables/events — no new event
// types in v1):
//   review_request — claim names the operator as reviewer under a manual
//                    review policy with a PR ref / head SHA, or a REVIEW-
//                    prefixed message addresses the operator (Trigger A)
//   blocked_lane   — claim.state === "blocked" (SELF-REPORTED ONLY; the
//                    inbox never infers blockedness from heuristics) and the
//                    operator owns, reviews, or depends on the claim
//   done_receipt   — claim transitioned to done on something the operator
//                    owned or verified (ambient, no push)
//   needs_input    — ASK-prefix / @mention / incoming reply-request addressed
//                    to the operator with no reply from another author
//
// Two-axis rule: Axis A (triage: new → seen → … → resolved/dismissed/snoozed/
// stale) is operator state owned by this module. Axis B (claim run-state:
// claimed / in_progress / blocked / done) is the work-claims table —
// read-only here, never mutated. herdr `done` ≠ claim `done`, and neither is
// settled by the inbox.
//
// Suggestion gates (badged before the pick; see phase1/inbox-mapping.md §2.3):
//   retractable — the pick journals intent and holds the room write for a
//                 short undo window (default 6s, 0–10s). Esc/U retracts
//                 before delivery. After delivery the mechanism is spent.
//   confirm     — money / merges / deploys / membership changes. Never enters
//                 the undo window; needs an explicit POST …/confirm
//                 {confirm:true}. v1 decider never suggests these.
//   none        — navigation only (open the diff / open the thread); the pick
//                 records nothing.
import { createHash } from "node:crypto";

export class SupervisionError extends Error {
  constructor(code, message) { super(message); this.name = "SupervisionError"; this.code = code; }
}
const fail = (code, message) => { throw new SupervisionError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

export const CARD_KINDS = Object.freeze(["review_request", "blocked_lane", "done_receipt", "needs_input"]);
export const CARD_STATES = Object.freeze([
  "new", "seen", "acting", "pending_undo", "dispatched", "resolved", "dismissed", "snoozed", "stale",
]);
// Grounded in server/work-claims.mjs REVIEW_POLICIES: independent_principal
// is the manual-review family (phase1/inbox-mapping.md calls it manual_review).
export const MANUAL_REVIEW_POLICIES = Object.freeze(["independent_principal"]);
export const DEFAULT_UNDO_HOLD_MS = 6000;
export const MAX_UNDO_HOLD_MS = 10000;
export const DONE_CARD_WINDOW_MS = 7 * 24 * 3600 * 1000; // re-card only recent completions
export const MAX_SNOOZE_MS = 30 * 24 * 3600 * 1000;
export const ROUTER_CONFIDENCE_FLOOR = 0.35; // below this the router broadcasts — no lane-naming

const RETRACTABLE_BADGE = "↩ retractable — ~6s to take back";
const CONFIRM_BADGE = "⚠ confirm — cannot be undone";

export const cardIdOf = dedupeKey =>
  `sv_${createHash("sha256").update(String(dedupeKey)).digest("hex").slice(0, 16)}`;

const nowMsOf = now => {
  if (now === null || now === undefined) return Date.now();
  if (typeof now === "number") {
    check(Number.isFinite(now), "invalid_input", "now must be a finite timestamp");
    return now;
  }
  fail("invalid_input", "now must be a millisecond timestamp");
};

const shortSha = sha => String(sha ?? "").slice(0, 7);
const asArray = value => (Array.isArray(value) ? value : []);

// ---------------------------------------------------------------------------
// deriveCards — pure derivation of card drafts from existing data
// ---------------------------------------------------------------------------
//
// Inputs (all caller-supplied snapshots; nothing here reads a store):
//   claims: [{ id, title, state, owner, reviewers[], reviewPolicy,
//               pullRequest {number, headSha} | null, headSha | null,
//               ciState ("success"|"failure"|"pending"|null), failingChecks[],
//               deliveryMode, note, completedAtMs, revision,
//               reviews [{memberId, verdict, headSha}], dependsOn[], files[] }]
//   messages: [{ id, seq, authorId, body, prefix ("ASK"|"REVIEW"|null),
//                mentions[], claimRef, hasReplyFromOtherAuthors }]
//   replyRequests: [{ id, from, status, question, seq }]
//   routerHints: Map(claimId -> { lane, reasons[], confidence }) — consumed,
//                never re-scored here (the sibling router lane owns scoring)
//   nextClaimFor: (finishedClaim) -> { id, title, reason } | null — the single
//                 best next claim, ranked by the caller (file-claim overlap)
//   now: fixed millisecond clock for tests
export function deriveCards({
  roomId, operatorId, claims = [], messages = [], replyRequests = [],
  routerHints = new Map(), nextClaimFor = null, now = null,
} = {}) {
  check(typeof roomId === "string" && roomId.length > 0, "invalid_input", "roomId must be a non-empty string");
  check(typeof operatorId === "string" && operatorId.length > 0, "invalid_input", "operatorId must be a non-empty string");
  check(Array.isArray(claims), "invalid_input", "claims must be a list");
  check(Array.isArray(messages), "invalid_input", "messages must be a list");
  check(Array.isArray(replyRequests), "invalid_input", "replyRequests must be a list");
  const at = nowMsOf(now);
  const myClaims = claims.filter(c => c?.owner === operatorId);
  const myClaimIds = new Set(myClaims.map(c => c.id));
  const claimsById = new Map(claims.filter(c => c && typeof c.id === "string").map(c => [c.id, c]));
  // Dependency interest runs both ways: the blocked claim may be waiting on
  // one of my claims (its dependsOn names it), or my work may be waiting on
  // the blocked claim (my dependsOn names it).
  const dependencyInterest = blockedClaim => {
    if (asArray(blockedClaim.dependsOn).some(dep => myClaimIds.has(dep))) return "it waits on you";
    if (myClaims.some(c => asArray(c.dependsOn).includes(blockedClaim.id))) return "you wait on it";
    return null;
  };

  const drafts = [];
  const push = draft => {
    check(draft.dedupeKey && typeof draft.dedupeKey === "string", "invalid_input", "card drafts need a dedupeKey");
    drafts.push(Object.freeze({
      id: cardIdOf(draft.dedupeKey),
      dedupeKey: draft.dedupeKey,
      roomId, memberId: operatorId,
      kind: draft.kind, state: "new",
      priority: draft.priority, urgent: draft.urgent === true,
      title: draft.title, summary: draft.summary, reason: draft.reason,
      sourceRef: Object.freeze({ ...draft.sourceRef }),
      context: Object.freeze({ ...draft.context }),
      createdAtMs: at, updatedAtMs: at,
    }));
  };

  for (const claim of claims) {
    if (!claim || typeof claim.id !== "string") continue;
    const reviewers = asArray(claim.reviewers);
    const isReviewer = reviewers.includes(operatorId);
    const headSha = claim.pullRequest?.headSha ?? claim.headSha ?? null;

    // review_request: manual-family policy, operator named reviewer, a
    // reviewable artifact (PR ref or head SHA), not done, not blocked (a
    // blocked claim is not reviewable — blocked_lane owns that signal), and
    // no attestation by the operator on this exact head yet (a moved head
    // re-arms the card).
    if (MANUAL_REVIEW_POLICIES.includes(claim.reviewPolicy) && isReviewer
        && claim.state !== "done" && claim.state !== "blocked" && headSha) {
      const attestedThisHead = asArray(claim.reviews)
        .some(r => r?.memberId === operatorId && r?.headSha === headSha);
      if (!attestedThisHead) {
        const prNumber = claim.pullRequest?.number ?? null;
        push({
          dedupeKey: `review_request|claim|${claim.id}|${headSha}`,
          kind: "review_request", priority: "high", urgent: false,
          title: `Review requested: "${claim.title ?? claim.id}"`,
          summary: `named reviewer under ${claim.reviewPolicy}${prNumber ? ` — PR #${prNumber}` : ""}`,
          reason: `you are the named reviewer and have not attested head ${shortSha(headSha)}`,
          sourceRef: { type: "claim", id: claim.id },
          context: {
            claimId: claim.id, claimTitle: claim.title ?? claim.id,
            headSha, prNumber, ciState: claim.ciState ?? null,
            failingChecks: asArray(claim.failingChecks),
          },
        });
      }
    }

    // blocked_lane: self-reported `blocked` state ONLY. The inbox never
    // infers blockedness from heuristics (the phantom-card failure mode this
    // fixes). Fires for the owner, a named reviewer, or a dependency link in
    // either direction (the blocked claim waits on one of my claims, or my
    // claim waits on the blocked one).
    const depLink = claim.state === "blocked" ? dependencyInterest(claim) : null;
    if (claim.state === "blocked"
        && (claim.owner === operatorId || isReviewer || depLink !== null)) {
      push({
        dedupeKey: `blocked_lane|claim|${claim.id}|${claim.revision ?? 0}`,
        kind: "blocked_lane", priority: "urgent", urgent: true,
        title: `Lane blocked: "${claim.title ?? claim.id}"`,
        summary: claim.owner === operatorId ? "your claim is blocked"
          : isReviewer ? "a claim you review is blocked"
          : `a claim in your dependency chain is blocked (${depLink})`,
        reason: `self-reported blocked${claim.note ? `: ${claim.note}` : ""}`,
        sourceRef: { type: "claim", id: claim.id },
        context: {
          claimId: claim.id, claimTitle: claim.title ?? claim.id,
          note: claim.note ?? null, owner: claim.owner ?? null,
        },
      });
    }

    // done_receipt: completed recently on something the operator owned or
    // verified. Ambient by default (no push) — the receipt pipeline, not the
    // inbox, owns delivery proof.
    if (claim.state === "done" && (claim.owner === operatorId || isReviewer)
        && typeof claim.completedAtMs === "number"
        && at - claim.completedAtMs >= 0 && at - claim.completedAtMs <= DONE_CARD_WINDOW_MS) {
      const shipped = claim.deliveryMode === "merged" || claim.deliveryMode === "production";
      push({
        dedupeKey: `done_receipt|claim|${claim.id}|${claim.completedAtMs}`,
        kind: "done_receipt", priority: shipped ? "high" : "normal", urgent: false,
        title: `Done: "${claim.title ?? claim.id}"${shipped ? ` — shipped (${claim.deliveryMode})` : ""}`,
        summary: "a claim you owned or verified finished",
        reason: shipped ? `delivery mode ${claim.deliveryMode} — worth one acknowledgment` : "finished — acknowledge when seen",
        sourceRef: { type: "claim", id: claim.id },
        context: {
          claimId: claim.id, claimTitle: claim.title ?? claim.id,
          deliveryMode: claim.deliveryMode ?? null,
          files: asArray(claim.files),
          nextClaim: typeof nextClaimFor === "function" ? nextClaimFor(claim) ?? null : null,
        },
      });
    }
  }

  for (const message of messages) {
    if (!message || typeof message.id !== "string") continue;
    const mentions = asArray(message.mentions);
    const addressed = message.prefix === "ASK" || mentions.includes(operatorId);
    // REVIEW-prefixed messages naming the operator are Trigger A: review
    // explicitly requested of them → interrupt-class (urgent) card.
    if (message.prefix === "REVIEW" && mentions.includes(operatorId) && message.authorId !== operatorId) {
      const claim = message.claimRef ? claimsById.get(message.claimRef) : null;
      // One card per (kind, claim): if the referenced claim already produced
      // a review_request, upgrade it to interrupt-class instead of carding
      // twice for the same underlying ask.
      const dupIdx = message.claimRef
        ? drafts.findIndex(d => d.kind === "review_request" && d.context.claimId === message.claimRef)
        : -1;
      if (dupIdx >= 0) {
        const existing = drafts[dupIdx];
        drafts[dupIdx] = Object.freeze({
          ...existing, priority: "urgent", urgent: true,
          reason: `${existing.reason}; Trigger A — review explicitly requested at seq ${message.seq ?? "?"}`,
          sourceRef: Object.freeze({ ...existing.sourceRef, messageId: message.id }),
        });
        continue;
      }
      push({
        dedupeKey: `review_request|message|${message.id}`,
        kind: "review_request", priority: "urgent", urgent: true,
        title: `Review asked of you: "${(message.body ?? "").slice(0, 80)}"`,
        summary: "a REVIEW-prefixed message names you directly",
        reason: `Trigger A — review explicitly requested at seq ${message.seq ?? "?"}`,
        sourceRef: { type: "message", id: message.id, seq: message.seq ?? null },
        context: {
          messageId: message.id, seq: message.seq ?? null,
          claimId: claim?.id ?? message.claimRef ?? null,
          claimTitle: claim?.title ?? null,
          headSha: claim?.pullRequest?.headSha ?? claim?.headSha ?? null,
          prNumber: claim?.pullRequest?.number ?? null,
          ciState: claim?.ciState ?? null, failingChecks: asArray(claim?.failingChecks),
        },
      });
      continue;
    }
    // needs_input: ASK / @mention addressed to the operator, authored by
    // someone else, with no reply from another author yet. Self-reported by
    // construction — the agent had to say ASK or mention.
    if (addressed && message.authorId !== operatorId && !message.hasReplyFromOtherAuthors) {
      push({
        dedupeKey: `needs_input|message|${message.id}`,
        kind: "needs_input", priority: "high", urgent: false,
        title: `Input needed: "${(message.body ?? "").slice(0, 80)}"`,
        summary: message.prefix === "ASK" ? "an ASK names no one but waits on you" : "you were mentioned",
        reason: `unanswered at seq ${message.seq ?? "?"} — no reply from another author`,
        sourceRef: { type: "message", id: message.id, seq: message.seq ?? null },
        context: {
          messageId: message.id, seq: message.seq ?? null,
          body: message.body ?? "", claimId: message.claimRef ?? null,
        },
      });
    }
  }

  // needs_input from structured reply-requests: the closest existing analog
  // to One's QUESTION card (server/reply-requests.mjs, `incoming` rows).
  for (const rr of replyRequests) {
    if (!rr || typeof rr.id !== "string" || rr.status !== "incoming") continue;
    push({
      dedupeKey: `needs_input|reply_request|${rr.id}`,
      kind: "needs_input", priority: "high", urgent: false,
      title: `Reply requested: "${(rr.question ?? rr.id).slice(0, 80)}"`,
      summary: `incoming reply-request from ${rr.from ?? "a lane"}`,
      reason: "structured ask with no recorded answer",
      sourceRef: { type: "reply_request", id: rr.id, seq: rr.seq ?? null },
      context: { replyRequestId: rr.id, from: rr.from ?? null, question: rr.question ?? null },
    });
  }

  return Object.freeze(drafts);
}

// ---------------------------------------------------------------------------
// decideSuggestions — ≤2 deterministic next actions per card
// ---------------------------------------------------------------------------
//
// live: { roomId, claim (fresh row, overrides derive-time context),
//         message, routerHint { lane, reasons[], confidence },
//         nextClaim { id, title, reason }, missingInput { summary, draft } }.
// Suggestions are draft payloads; they do nothing until picked. The pick
// loads through the pre-dispatch hold (retractable) or the confirm sheet
// (confirm). Router hints are consumed, never re-scored; low-confidence
// output (broadcast) suppresses lane-naming suggestions.
export function decideSuggestions(card, live = {}) {
  check(card !== null && typeof card === "object" && !Array.isArray(card), "invalid_input", "card must be an object");
  check(CARD_KINDS.includes(card.kind), "invalid_input", `unknown card kind: ${card?.kind}`);
  check(card.context !== null && typeof card.context === "object", "invalid_input", "card.context must be an object");
  check(live !== null && typeof live === "object" && !Array.isArray(live), "invalid_input", "live must be an object");
  const roomId = live.roomId ?? card.roomId;
  check(typeof roomId === "string" && roomId.length > 0, "invalid_input", "roomId must be a non-empty string");

  const ctx = card.context;
  const claim = live.claim ?? null;
  const headSha = claim?.pullRequest?.headSha ?? claim?.headSha ?? ctx.headSha ?? null;
  const claimId = claim?.id ?? ctx.claimId ?? null;
  const ciState = claim?.ciState ?? ctx.ciState ?? null;
  const failingChecks = asArray(claim?.failingChecks ?? ctx.failingChecks);
  const hint = live.routerHint ?? null;
  const confidentHint = hint && typeof hint.confidence === "number"
    && hint.confidence >= ROUTER_CONFIDENCE_FLOOR && typeof hint.lane === "string" ? hint : null;

  const roomLink = `?room=${encodeURIComponent(roomId)}#pr-view/triage`;
  const suggestions = [];
  const push = s => {
    check(suggestions.length < 2, "invalid_input", "decider emitted more than 2 suggestions");
    suggestions.push(Object.freeze({
      id: `s${suggestions.length + 1}`, index: suggestions.length + 1,
      kind: s.kind, title: s.title, reason: s.reason, gate: s.gate,
      api: s.api ? Object.freeze({ ...s.api }) : null,
      apiNote: s.apiNote ?? null,
      deepLink: s.deepLink ?? roomLink,
      ref: Object.freeze({ ...(s.ref ?? {}) }),
      draft: s.draft ?? null,
      badge: s.gate === "retractable" ? RETRACTABLE_BADGE : s.gate === "confirm" ? CONFIRM_BADGE : null,
    }));
  };

  if (card.kind === "review_request") {
    if (ciState === "success" && headSha && claimId) {
      push({
        kind: "post_approve", gate: "retractable",
        title: `Post APPROVE on ${shortSha(headSha)}`,
        reason: `CI green at ${shortSha(headSha)}; lander rule: the verdict binds the exact head`,
        api: {
          method: "POST",
          path: `/api/rooms/${roomId}/work-claims/${claimId}/review`,
          // Grounded in server/work-claim-routes.mjs: the review route takes
          // {note?}; the attestation is caller-bound. The verdict wording rides
          // the note — the lander rule itself is a room convention.
          body: { note: `APPROVE ${headSha} — CI green; lander rule binds the exact head` },
        },
        ref: { claimId, headSha },
      });
    } else if (ciState === "failure" && claimId) {
      const checks = failingChecks.length > 0 ? failingChecks.join(", ") : "checks failing";
      push({
        kind: "request_changes", gate: "retractable",
        title: "Request changes — CI red",
        reason: `CI red at ${shortSha(headSha)}: ${checks}`,
        api: {
          method: "POST",
          path: `/api/rooms/${roomId}/work-claims/${claimId}/review`,
          body: { note: `CHANGES REQUESTED ${headSha} — CI red: ${checks}` },
        },
        ref: { claimId, headSha },
      });
    } else {
      push({
        kind: "open_diff", gate: "none",
        title: "Open the diff",
        reason: ciState === "pending"
          ? "CI has not finished — read the diff before any verdict"
          : "no green CI signal at this head — read the diff before any verdict",
        api: null, ref: { claimId },
      });
    }
    if (confidentHint && claimId) {
      push({
        kind: "hand_review", gate: "retractable",
        title: `Hand review to ${confidentHint.lane}`,
        reason: `affinity pick: ${(confidentHint.reasons ?? []).join("; ") || "router top candidate"}`,
        api: {
          method: "POST",
          path: `/api/rooms/${roomId}/work-claims/${claimId}/reassign`,
          // Grounded in server/work-claim-routes.mjs: reassign takes
          // {newOwner, note?}.
          body: { newOwner: confidentHint.lane, note: "handing review — affinity pick" },
        },
        apiNote: "verify the lane is a live room member before firing",
        ref: { claimId, lane: confidentHint.lane },
      });
    }
  }

  if (card.kind === "blocked_lane") {
    const missing = live.missingInput ?? null;
    if (missing && typeof missing.summary === "string") {
      push({
        kind: "unblock_reply", gate: "retractable",
        title: "Send the unblocking reply",
        reason: `the blocked note names a missing input you can provide: ${missing.summary}`,
        api: { method: "POST", path: `/api/rooms/${roomId}/commands`, body: null },
        apiNote: "author a message.posted command addressed to the blocked lane with the draft body (editable before pick)",
        draft: missing.draft ?? null,
        ref: { claimId },
      });
    } else {
      push({
        kind: "escalate_owner", gate: "retractable",
        title: "Escalate to room owner",
        reason: "no named missing input — the owner can reassign or unstick the lane",
        api: { method: "POST", path: `/api/rooms/${roomId}/commands`, body: null },
        apiNote: "author a message.posted command addressing the room owner",
        ref: { claimId },
      });
    }
    if (confidentHint && claimId) {
      push({
        kind: "reassign", gate: "retractable",
        title: `Reassign to ${confidentHint.lane}`,
        reason: `affinity pick: ${(confidentHint.reasons ?? []).join("; ") || "router top candidate"}`,
        api: {
          method: "POST",
          path: `/api/rooms/${roomId}/work-claims/${claimId}/reassign`,
          body: { newOwner: confidentHint.lane, note: "reassigning blocked claim — affinity pick" },
        },
        apiNote: "verify the lane is a live room member before firing",
        ref: { claimId, lane: confidentHint.lane },
      });
    } else {
      push({
        kind: "open_claim", gate: "none",
        title: "Open the claim",
        reason: "read the blocked claim's note and history before acting",
        api: null, ref: { claimId },
      });
    }
  }

  if (card.kind === "done_receipt") {
    push({
      kind: "acknowledge", gate: "none",
      title: "Acknowledge",
      reason: "single-tap close-out; the receipt pipeline already holds delivery proof",
      api: null, ref: { claimId },
    });
    const next = live.nextClaim ?? ctx.nextClaim ?? null;
    if (next && typeof next.id === "string") {
      push({
        kind: "take_next_claim", gate: "retractable",
        title: `Take next claim: "${next.title ?? next.id}"`,
        reason: next.reason ?? "ranked as the best next claim",
        api: {
          method: "POST",
          path: `/api/rooms/${roomId}/work-claims/${next.id}/claim`,
          // Grounded in server/work-claim-routes.mjs: claim takes {note?, leaseHours?}.
          body: {},
        },
        ref: { claimId: next.id },
      });
    }
  }

  if (card.kind === "needs_input") {
    const messageId = ctx.messageId ?? null;
    push({
      kind: "open_thread", gate: "none",
      title: "Open the thread",
      reason: "answer where the question was asked — the triage view deep-links, it does not embed compose",
      api: null, ref: { messageId },
    });
    push({
      kind: "decline", gate: "retractable",
      title: "Decline",
      reason: "decline with a reason — a declined ask leaves an audit trail, a ignored one does not",
      api: { method: "POST", path: `/api/rooms/${roomId}/commands`, body: null },
      apiNote: "author a message.posted command declining with your reason",
      ref: { messageId },
    });
  }

  return Object.freeze(suggestions);
}

// ---------------------------------------------------------------------------
// applyCardTransition — pure state machine (Axis A)
// ---------------------------------------------------------------------------
//
// Events:
//   focus                        new -> seen
//   pick {suggestion, holdMs?}    {new,seen} -> pending_undo  (retractable only)
//   start_confirm {suggestion}    {new,seen} -> acting         (confirm only)
//   confirm {confirmed:true}      acting -> pending_undo       (zero-second window)
//   retract                       pending_undo -> seen         (before deadline)
//   fired                         {pending_undo,acting} -> dispatched
//   dismiss {note?}               {new,seen,pending_undo,acting,snoozed} -> dismissed
//   snooze {untilMs}              {new,seen} -> snoozed
//   wake                          snoozed -> new
//   resolve                       {new,seen} -> resolved
//   mark_stale                    {new,seen,snoozed} -> stale
//   rearm                         {stale,dismissed} -> new
// The machine never touches the claim table (Axis B) — it only moves the
// operator's triage state. Terminal states never transition out except via
// rearm (stale/dismissed -> new).
export function applyCardTransition(card, event, { now = null } = {}) {
  check(card !== null && typeof card === "object" && !Array.isArray(card), "invalid_input", "card must be an object");
  check(CARD_STATES.includes(card.state), "invalid_input", `unknown card state: ${card?.state}`);
  check(event !== null && typeof event === "object" && !Array.isArray(event), "invalid_input", "event must be an object");
  const at = nowMsOf(now);
  const type = event.type;

  const illegal = () => fail("illegal_transition", `event ${type} is not legal from state ${card.state}`);
  const moved = over => Object.freeze({
    ...card,
    ...over,
    updatedAtMs: at,
    // "pickedSuggestion" in over (even as undefined) clears the field —
    // retract/dismiss/fired drop the held intent.
    pickedSuggestion: "pickedSuggestion" in over ? over.pickedSuggestion : card.pickedSuggestion,
  });

  switch (type) {
    case "focus": {
      if (card.state !== "new") illegal();
      return moved({ state: "seen", seenAtMs: at });
    }
    case "pick": {
      if (card.state !== "new" && card.state !== "seen") illegal();
      const suggestion = event.suggestion;
      check(suggestion !== null && typeof suggestion === "object", "invalid_input", "pick needs the decided suggestion");
      if (suggestion.gate === "confirm") fail("confirm_required", "this action needs the confirm sheet — use start_confirm");
      if (suggestion.gate !== "retractable") fail("nothing_to_hold", "navigation-only actions record no intent");
      const holdMs = event.holdMs ?? DEFAULT_UNDO_HOLD_MS;
      check(Number.isFinite(holdMs) && holdMs >= 0 && holdMs <= MAX_UNDO_HOLD_MS,
        "invalid_input", `holdMs must be 0..${MAX_UNDO_HOLD_MS}`);
      return moved({
        state: "pending_undo",
        pickedSuggestion: Object.freeze({ ...suggestion }),
        undoDeadlineMs: at + holdMs,
      });
    }
    case "start_confirm": {
      if (card.state !== "new" && card.state !== "seen") illegal();
      const suggestion = event.suggestion;
      check(suggestion !== null && typeof suggestion === "object", "invalid_input", "start_confirm needs the decided suggestion");
      if (suggestion.gate !== "confirm") fail("not_confirm_gated", "only confirm-class actions open the confirm sheet");
      return moved({ state: "acting", pickedSuggestion: Object.freeze({ ...suggestion }) });
    }
    case "confirm": {
      if (card.state !== "acting") illegal();
      if (event.confirmed !== true) fail("confirmation_required", "confirm-class actions need {confirmed:true}");
      // The write is approved and fires immediately — the undo window is zero.
      // retract() after this is always undo_expired; that is the honest
      // "cannot be undone" semantic.
      return moved({ state: "pending_undo", undoDeadlineMs: at });
    }
    case "retract": {
      if (card.state !== "pending_undo") illegal();
      if (!(at < card.undoDeadlineMs)) fail("undo_expired", "the undo window lapsed — the write already fired");
      return moved({ state: "seen", pickedSuggestion: undefined, undoDeadlineMs: undefined });
    }
    case "fired": {
      if (card.state !== "pending_undo" && card.state !== "acting") illegal();
      if (card.state === "pending_undo" && !(at >= card.undoDeadlineMs)) {
        fail("undo_window_open", "the undo window is still open — the write must not have fired yet");
      }
      return moved({ state: "dispatched", firedAtMs: at, pickedSuggestion: undefined, undoDeadlineMs: undefined });
    }
    case "dismiss": {
      if (!["new", "seen", "pending_undo", "acting", "snoozed"].includes(card.state)) illegal();
      const note = event.note ?? null;
      check(note === null || (typeof note === "string" && note.length <= 280), "invalid_input", "dismiss note must be at most 280 characters");
      // Dismiss is an audit trail, never a delete: the record (and its note)
      // stays queryable. Nothing was ever fired for pending_undo intents.
      return moved({ state: "dismissed", dismissNote: note, pickedSuggestion: undefined, undoDeadlineMs: undefined });
    }
    case "snooze": {
      if (card.state !== "new" && card.state !== "seen") illegal();
      const untilMs = event.untilMs;
      check(Number.isFinite(untilMs) && untilMs > at && untilMs <= at + MAX_SNOOZE_MS,
        "invalid_input", "untilMs must be in the future and within 30 days");
      return moved({ state: "snoozed", snoozedUntilMs: untilMs });
    }
    case "wake": {
      if (card.state !== "snoozed") illegal();
      return moved({ state: "new", snoozedUntilMs: undefined });
    }
    case "resolve": {
      if (card.state !== "new" && card.state !== "seen") illegal();
      return moved({ state: "resolved" });
    }
    case "mark_stale": {
      // notification ≠ truth: acting re-fetches live state; if the source
      // already resolved elsewhere the card retires as stale, never silently.
      if (!["new", "seen", "snoozed"].includes(card.state)) illegal();
      return moved({ state: "stale" });
    }
    case "rearm": {
      if (card.state !== "stale" && card.state !== "dismissed") illegal();
      return moved({ state: "new", dismissNote: undefined, snoozedUntilMs: undefined });
    }
    default:
      illegal();
  }
}

// ---------------------------------------------------------------------------
// sortCards — priority order for GET /cards
// ---------------------------------------------------------------------------
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
export function sortCards(cards) {
  check(Array.isArray(cards), "invalid_input", "cards must be a list");
  const rank = c => (c?.urgent === true ? 0 : PRIORITY_RANK[c?.priority] ?? 3);
  return Object.freeze([...cards].sort((a, b) =>
    rank(a) - rank(b)
    || (b?.createdAtMs ?? 0) - (a?.createdAtMs ?? 0)
    || (a?.id < b?.id ? -1 : a?.id > b?.id ? 1 : 0)));
}
