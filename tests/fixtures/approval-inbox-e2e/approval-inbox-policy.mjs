// VENDORED FIXTURE — do not edit. Delete when the sibling slice's PR merges.
// Source: origin/jill/wave500-g10-inbox-policy @ 384791ed9e349b255b6e0f9b2cdc26a8c956ed2a
// (WAVE-500 guild 10 slice 3/50, open as PR #2557, 2026-10-10). Pinned copy for
// the wave500-g10 e2e integration proof only. After merge, delete this
// directory and re-point tests/approval-inbox-e2e.test.js at ../server/.

// server/approval-inbox-policy.mjs
//
// Approval-inbox POLICY — the gate that decides what QUALIFIES for the unified
// human approval inbox (WAVE-500 guild 10, unified approval inbox).
//
// The inbox is one live surface for pending HUMAN decisions, replacing the
// scattered tap list. This module is the admission gate: it answers whether a
// candidate item genuinely needs a human, how urgent it is, and when it
// expires. ONLY humans decide (decisions: approve | approve-session |
// deny-stop) — this module never approves anything, it only routes.
//
// Rules:
//  - money / identity / deploy / permission / publish always qualify, with a
//    rationale. Money has NO carve-out: no spending without John's explicit
//    tap, ever. Deploy has one narrow carve-out: a green-CI run through the
//    pre-authorized deploy lane is decidable-by-system.
//  - Routine ops (green-CI merges, read-only queries, agent-internal
//    coordination) and unknown kinds never qualify: reason
//    "decidable-by-system".
//  - "other" qualifies only when the payload explicitly flags
//    explicitlyNeedsHuman.
//  - Blanket requests ("approve everything", approveAll, auto-approve) are
//    REFUSED outright — the inbox is item-by-item human judgment, never
//    approve-everything. Refusals are not queued.
//
// Pure and deterministic: no I/O, no clock reads. Callers inject `now`
// (ms epoch) wherever time matters, so every function is a pure function of
// its arguments.

export const INBOX_KINDS = ["money", "identity", "deploy", "permission", "publish", "other"];

/** The only decisions a human can record on an inbox card. */
export const DECISIONS = ["approve", "approve-session", "deny-stop"];

export const REASONS = {
  DECIDABLE_BY_SYSTEM: "decidable-by-system",
  REFUSED: "refused",
  INVALID_INPUT: "invalid-input",
};

// Urgency ladder: 0 routine · 1 soon · 2 urgent · 3 blocking.
export const URGENCY = { ROUTINE: 0, SOON: 1, URGENT: 2, BLOCKING: 3 };

// Default time-to-live per kind (ms). Deploys expire fastest — a stale deploy
// approval is dangerous; permission grants linger longest — low time pressure.
const EXPIRY_MS = {
  money: 24 * 3600_000,
  identity: 12 * 3600_000,
  deploy: 6 * 3600_000,
  permission: 48 * 3600_000,
  publish: 24 * 3600_000,
  other: 24 * 3600_000,
};

const GATE_RATIONALE = {
  money:
    "Money movement — spend, payment, wallet, or Connects — needs John's explicit tap. " +
    "Rule 1: no spending without his approval, no exceptions, no matter the amount.",
  identity:
    "Posting, sending, or publishing as John — needs his approval. " +
    "Rule 2: never act as him without his tap.",
  deploy:
    "Deploys each need a separate explicit tap (Dasha / Dasha Desk always; " +
    "Project Room outside the pre-authorized green-CI deploy lane). A wrong or " +
    "stale deploy is hard to undo.",
  permission:
    "Granting or elevating permissions is an irreversible trust decision. " +
    "Only a human grants trust.",
  publish:
    "Public publishes cannot be un-published. Wording, timing, and audience " +
    "need human judgment.",
};

const ROUTINE_KINDS = new Set([
  "merge",
  "ci-green-merge",
  "read-query",
  "read",
  "internal-coordination",
  "coordination",
]);

const BLANKET_ACTIONS = new Set(["approve-everything", "approve-all", "auto-approve", "approve_all"]);
const BLANKET_TEXT = /approve[\s_-]*(all|everything|every\s+pending|everyone)|auto[\s_-]*approve/i;

function payloadOf(payload) {
  return payload && typeof payload === "object" ? payload : {};
}

function requireNow(now, fn) {
  if (!Number.isFinite(now)) {
    throw new TypeError(
      `approval-inbox-policy: ${fn} requires \`now\` (ms epoch) — the module takes no clock I/O`,
    );
  }
  return now;
}

/** True when the payload asks for blanket / auto approval of many items. */
function isBlanketRequest(p) {
  if (p.approveAll === true || p.blanket === true || p.autoApprove === true) return true;
  if (typeof p.action === "string" && BLANKET_ACTIONS.has(p.action.toLowerCase().trim())) return true;
  for (const v of Object.values(p)) {
    if (typeof v === "string" && BLANKET_TEXT.test(v)) return true;
  }
  return false;
}

/**
 * Decide whether a candidate item qualifies for the human approval inbox.
 * @returns {{ qualifies: boolean, reason?: string, rationale: string }}
 *   - qualifies=true: genuinely needs a human; rationale says why.
 *   - qualifies=false, reason="decidable-by-system": the system can decide it.
 *   - qualifies=false, reason="refused": blanket/auto-approve — never admitted.
 *   - qualifies=false, reason="invalid-input": malformed — refused, not queued.
 */
export function qualifiesForInbox({ kind, payload } = {}) {
  const p = payloadOf(payload);

  if (typeof kind !== "string" || kind.trim() === "") {
    return {
      qualifies: false,
      reason: REASONS.INVALID_INPUT,
      rationale: "A card needs a kind; malformed requests are refused, never queued.",
    };
  }
  if (isBlanketRequest(p)) {
    return {
      qualifies: false,
      reason: REASONS.REFUSED,
      rationale:
        "Blanket/auto-approve requests are refused outright. The inbox exists for " +
        "item-by-item human judgment — never approve-everything.",
    };
  }

  const k = kind.toLowerCase().trim();

  if (k in GATE_RATIONALE) {
    // Narrow deploy carve-out: the pre-authorized deploy lane on green CI is
    // standing delegation, not a human decision. Both flags required, exact.
    if (k === "deploy" && p.preAuthorized === "deploy-lane" && p.ciStatus === "green") {
      return {
        qualifies: false,
        reason: REASONS.DECIDABLE_BY_SYSTEM,
        rationale:
          "Deploy through the pre-authorized deploy lane with fully green CI is " +
          "standing delegation — decidable by the system, not a human card.",
      };
    }
    return { qualifies: true, rationale: GATE_RATIONALE[k] };
  }

  if (k === "other") {
    if (p.explicitlyNeedsHuman === true) {
      return {
        qualifies: true,
        rationale:
          "Explicitly flagged as needing human judgment with no system-decidable path.",
      };
    }
    return {
      qualifies: false,
      reason: REASONS.DECIDABLE_BY_SYSTEM,
      rationale: "'other' without an explicit human-judgment flag is treated as routine.",
    };
  }

  return {
    qualifies: false,
    reason: REASONS.DECIDABLE_BY_SYSTEM,
    rationale: ROUTINE_KINDS.has(k)
      ? `Routine op (${k}) — green CI, read-only, or internal coordination is decidable by the system.`
      : `Unrecognized kind (${k}) — the inbox is not a catch-all; not queued.`,
  };
}

/**
 * Urgency ladder 0..3 for an admitted card. Pure: `now` is injected.
 * Explicit numeric payload.urgency is honored (clamped); blocking flags or an
 * expiry within the hour escalate to 3.
 */
export function urgencyOf({ kind, payload } = {}, now) {
  requireNow(now, "urgencyOf");
  const p = payloadOf(payload);
  const k = typeof kind === "string" ? kind.toLowerCase().trim() : "";

  let u;
  if (typeof p.urgency === "number" && Number.isFinite(p.urgency)) {
    u = Math.round(p.urgency);
  } else if (k === "money" || k === "identity" || k === "deploy") {
    u = URGENCY.URGENT;
  } else if (k === "permission" || k === "publish" || k === "other") {
    u = URGENCY.SOON;
  } else {
    u = URGENCY.ROUTINE;
  }

  if (p.blocking === true || p.blocksLaunch === true) u = URGENCY.BLOCKING;
  if (typeof p.expiresAt === "string") {
    const t = Date.parse(p.expiresAt);
    if (Number.isFinite(t) && t - now < 3600_000) u = URGENCY.BLOCKING;
  }

  return Math.min(3, Math.max(0, u));
}

/**
 * Default expiry for a card of this kind, as an ISO timestamp.
 * Pure: `now` (ms epoch) is injected — no clock reads.
 */
export function expiryFor(kind, now) {
  requireNow(now, "expiryFor");
  const k = typeof kind === "string" ? kind.toLowerCase().trim() : "";
  const ttl = EXPIRY_MS[k] ?? 24 * 3600_000;
  return new Date(now + ttl).toISOString();
}
