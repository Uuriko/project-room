// Jev-harness receipt-acceptance gate (shadow mode first).
//
// The second Jev decision edge: accepting a work receipt. When a work claim
// moves to done, this pure classifier scores the receipt's quality from
// signals the room can actually compute — is completion demonstrated, how
// strong is the review, does the timing look sane — and produces a
// would-be verdict: accept | request-changes | escalate.
//
// Pure: no I/O, no network, injected clock. The wiring in
// server/work-claim-routes.mjs calls evaluateReceipt() on the done
// transition, journals the verdict via server/jev-shadow-journal.mjs, and
// accepts anyway — shadow mode never enforces. Verdict thresholds are
// defined below and documented in docs/JEV-GATES.md as proposed, NOT
// enforced. Low-confidence accepts are flagged escalate:true so a human
// can look; the flag is surfaced read-only in the needs-attention rollup.

class JevError extends Error { constructor(code, message) { super(message); this.name = "JevError"; this.code = code; } }
const fail = (code, message) => { throw new JevError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_receipt_input", message); };

// Policy version this instrumentation implements (docs/JEV-GATES.md).
export const jevReceiptPolicyVersion = "v1";
// Proposed verdict thresholds — DOCUMENTED, NOT ENFORCED in shadow mode.
export const jevReceiptAcceptThreshold = 0.7;
export const jevReceiptRequestChangesThreshold = 0.4;
// Below this quality an "accept" is low-confidence and gets the human
// escalate flag even though the verdict stays accept (shadow).
export const jevReceiptHighConfidence = 0.85;

// Review policies, weakest first (server/work-claims.mjs REVIEW_POLICIES).
const POLICY_BASE = Object.freeze({
  self_attested: 0.35,
  distinct_member: 0.7,
  independent_principal: 1.0,
});

// Artifact references: PR/commit URLs, raw SHAs, "merged" markers, PR numbers.
// A heuristic, not proof — the legend says so.
const ARTIFACT_PATTERN = /github\.com\/[^/\s]+\/[^/\s]+\/(pull|commit)\/|(?:^|[^0-9a-f])[0-9a-f]{7,40}(?:[^0-9a-f]|$)|\bpr\s*#\d+\b|\bmerged\b/i;

const clamp01 = value => Math.min(1, Math.max(0, value));

function evidenceScore({ note, deliveryMode }) {
  const text = [note, deliveryMode].filter(v => typeof v === "string").join("\n");
  if (ARTIFACT_PATTERN.test(text)) {
    return { value: 1, detail: "receipt references an artifact (PR/commit/SHA/merged marker)" };
  }
  if (typeof note === "string" && note.trim().length >= 40) {
    return { value: 0.6, detail: "substantive completion note, no artifact reference" };
  }
  if (typeof deliveryMode === "string" && deliveryMode.length > 0) {
    return { value: 0.5, detail: "delivery mode recorded, no artifact reference" };
  }
  return { value: 0.1, detail: "bare claim: no artifact reference, no substantive note" };
}

function reviewStrengthScore({ reviewPolicy, attestations, reviewerIsVerifier }) {
  const base = POLICY_BASE[reviewPolicy] ?? POLICY_BASE.self_attested;
  const attested = attestations.length > 0;
  let value = base * (attested ? 1 : 0.5);
  if (reviewerIsVerifier) value = Math.min(1, value + 0.1);
  const detail = `${reviewPolicy ?? "default"} policy${attested ? `, attested by ${attestations.length} member(s)` : ", no attestation recorded"}${reviewerIsVerifier ? ", reviewer holds verify permission" : ""}`;
  return { value: clamp01(value), detail };
}

function durationSanityScore({ claimedAtMs, doneAtMs }) {
  if (claimedAtMs === null || claimedAtMs === undefined || doneAtMs === null || doneAtMs === undefined) {
    return { value: 0.6, detail: "claim/done timestamps unavailable: neutral 0.6" };
  }
  check(Number.isFinite(claimedAtMs) && Number.isFinite(doneAtMs), "claimedAtMs/doneAtMs must be finite ms epochs or null");
  const durationMs = doneAtMs - claimedAtMs;
  if (durationMs < 0) return { value: 0.3, detail: "done timestamp precedes claim timestamp" };
  if (durationMs < 60 * 1000) return { value: 0.15, detail: "done within a minute of claiming: too fast to be real work" };
  if (durationMs < 5 * 60 * 1000) return { value: 0.5, detail: "done within five minutes of claiming" };
  return { value: 1, detail: "claim-to-done duration looks like real work" };
}

function attestationScore(attestations) {
  check(Array.isArray(attestations), "attestations must be an array");
  if (attestations.length >= 2) return { value: 1, detail: "2+ attestations" };
  if (attestations.length === 1) return { value: 0.8, detail: "1 attestation" };
  return { value: 0.3, detail: "no attestations" };
}

export const jevReceiptWeights = Object.freeze({
  evidence: 0.40,
  reviewStrength: 0.30,
  durationSanity: 0.15,
  attestation: 0.15,
});

// The cheap classifier: receipt signals in, quality 0..1 and a would-be
// verdict out. Frozen; JSON-stable; deterministic.
export function evaluateReceipt({ workId, ownerId = null, reviewPolicy = null,
  attestations = [], reviewerIsVerifier = false, deliveryMode = null, note = null,
  claimedAtMs = null, doneAtMs = null, at = Date.now() } = {}) {
  check(typeof workId === "string" && workId.length > 0 && workId.length <= 256, "workId must be a 1..256 character string");
  if (ownerId !== null) check(typeof ownerId === "string" && ownerId.length > 0 && ownerId.length <= 256, "ownerId must be a 1..256 character string or null");
  if (reviewPolicy !== null) check(typeof reviewPolicy === "string", "reviewPolicy must be a string or null");
  check(typeof reviewerIsVerifier === "boolean", "reviewerIsVerifier must be a boolean");
  if (deliveryMode !== null) check(typeof deliveryMode === "string" && deliveryMode.length <= 128, "deliveryMode must be a short string or null");
  if (note !== null) check(typeof note === "string" && note.length <= 8192, "note must be a string or null");
  check(typeof at === "number" && Number.isFinite(at) && at >= 0, "at must be a finite ms-epoch time");
  const components = [
    { key: "evidence", weight: jevReceiptWeights.evidence, ...evidenceScore({ note, deliveryMode }) },
    { key: "reviewStrength", weight: jevReceiptWeights.reviewStrength,
      ...reviewStrengthScore({ reviewPolicy, attestations, reviewerIsVerifier }) },
    { key: "durationSanity", weight: jevReceiptWeights.durationSanity, ...durationSanityScore({ claimedAtMs, doneAtMs }) },
    { key: "attestation", weight: jevReceiptWeights.attestation, ...attestationScore(attestations) },
  ];
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const quality = clamp01(components.reduce((sum, c) => sum + c.weight * c.value, 0) / totalWeight);
  const verdict = quality >= jevReceiptAcceptThreshold ? "accept"
    : quality >= jevReceiptRequestChangesThreshold ? "request-changes" : "escalate";
  // Low-confidence accepts go to a human lane: the journal entry is flagged
  // escalate:true and surfaced read-only in the needs-attention rollup.
  const escalate = verdict === "escalate" || (verdict === "accept" && quality < jevReceiptHighConfidence);
  return Object.freeze({
    policyVersion: jevReceiptPolicyVersion,
    gate: "receipt",
    workId, ownerId,
    quality, verdict, escalate,
    // Would-be verdict: shadow mode never enforces. enforced stays false
    // until a graduation decision flips the gate (docs/JEV-GATES.md).
    enforced: false,
    signals: Object.freeze(components.map(c => Object.freeze({
      key: c.key, weight: c.weight, value: c.value, detail: c.detail,
    }))),
    at,
  });
}
export { JevError };
