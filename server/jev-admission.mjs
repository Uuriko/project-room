// Jev-harness admission gate (shadow mode first).
//
// The Jev idea (LangChain research thread): a cheap, non-generative
// classifier sitting on a decision edge — a fast yes/no check before an
// expensive or irreversible action. Here the decision edge is admitting an
// agent into a room, and the classifier is this pure scoring function.
//
// Pure: no I/O, no network, injected clock. The wiring in server/http.mjs
// computes the signals from each join path, calls evaluateAdmission(),
// journals the decision via server/jev-shadow-journal.mjs, and admits
// anyway — shadow mode never enforces. Rejection thresholds are defined
// below and documented in docs/JEV-GATES.md as proposed, NOT enforced.
//
// Decision vocabulary (would-be, shadow): admit | review | reject.

class JevError extends Error { constructor(code, message) { super(message); this.name = "JevError"; this.code = code; } }
const fail = (code, message) => { throw new JevError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_admission_input", message); };

// Policy version this instrumentation implements (docs/JEV-GATES.md).
export const jevAdmissionPolicyVersion = "v1";
// Proposed enforcement thresholds — DOCUMENTED, NOT ENFORCED in shadow mode.
// score >= reject -> "reject"; score >= review -> "review"; else "admit".
export const jevAdmissionReviewThreshold = 0.45;
export const jevAdmissionRejectThreshold = 0.75;
// Join-velocity counting window: recent joins inside this window feed the
// joinVelocity signal. A measurement window, not a review deadline.
export const jevVelocityWindowMs = 10 * 60 * 1000;
// Join paths the wiring instruments. Unknown paths are refused: the gate
// must know which edge it is scoring.
export const jevAdmissionPaths = Object.freeze([
  "join:invite",          // POST /join (+ /room/join, /api/join) with inviteCode
  "join:first-room",      // POST /join (+ /room/join, /api/join), personal first room
  "agent-invite:redeem",  // POST /api/agent-invites/redeem
  "guest-invite:redeem",  // POST /api/guest-invites/redeem (signed card verified)
  "guest-agent-link:join",// POST /api/guest-agent-links/join
  "share-link:join-agent",// POST /api/share-links/join-agent
  "access-request:approve", // access-request approval (POST .../access-requests/{id}/decide)
]);

const clamp01 = value => Math.min(1, Math.max(0, value));

// Small pure Levenshtein distance for name-similarity scoring.
function levenshtein(a, b) {
  if (a === b) return 0;
  const rows = b.length + 1, cols = a.length + 1;
  let prev = new Array(cols), next = new Array(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;
  for (let i = 1; i < rows; i++) {
    next[0] = i;
    for (let j = 1; j < cols; j++) {
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + (a[j - 1] === b[i - 1] ? 0 : 1));
    }
    [prev, next] = [next, prev];
  }
  return prev[cols - 1];
}

// Shannon entropy in bits per character — machine-minted names cluster low.
function shannonPerChar(name) {
  const counts = new Map();
  for (const char of name) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / name.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const idOf = (value, field) => {
  check(typeof value === "string" && value.length > 0 && value.length <= 256, `${field} must be a 1..256 character string`);
  return value;
};

// --- signal components (each 0..1; higher = riskier) -----------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const FRESH_FULL_MS = 60 * 1000; // an identity minted inside the last minute is brand new

function freshIdentityScore(identityAgeMs) {
  if (identityAgeMs === null || identityAgeMs === undefined) {
    return { value: 0.5, detail: "identity age unknown: neutral 0.5" };
  }
  check(typeof identityAgeMs === "number" && Number.isFinite(identityAgeMs) && identityAgeMs >= 0,
    "identityAgeMs must be a finite ms duration or null");
  if (identityAgeMs <= FRESH_FULL_MS) return { value: 1, detail: "identity minted within the last minute" };
  if (identityAgeMs >= DAY_MS) return { value: 0, detail: "identity older than a day" };
  const value = 1 - (identityAgeMs - FRESH_FULL_MS) / (DAY_MS - FRESH_FULL_MS);
  return { value, detail: `identity age ${Math.round(identityAgeMs / 1000)}s: freshness decays over a day` };
}

function sybilNameScore(displayName, existingDisplayNames) {
  check(typeof displayName === "string" && displayName.length > 0 && displayName.length <= 80,
    "displayName must be a 1..80 character string");
  check(Array.isArray(existingDisplayNames) && existingDisplayNames.every(n => typeof n === "string"),
    "existingDisplayNames must be string[]");
  const lowered = displayName.toLowerCase().trim();
  let similarity = 0, closest = null;
  for (const other of existingDisplayNames) {
    const candidate = other.toLowerCase().trim();
    if (!candidate || candidate === lowered) continue;
    const distance = levenshtein(lowered, candidate);
    const sim = 1 - distance / Math.max(lowered.length, candidate.length);
    if (sim > similarity) { similarity = sim; closest = other; }
  }
  // Machine-minted naming patterns: heavy repetition, all digits, a short
  // stem glued to a long digit tail, or very low per-character entropy.
  const patternTests = [
    [/(.)\1{3,}/.test(lowered), "4+ repeated character run"],
    [/^\d+$/.test(lowered), "all digits"],
    [/^[a-z]{1,4}\d{4,}$/.test(lowered), "short stem + 4+ digit tail"],
    [lowered.length >= 8 && shannonPerChar(lowered) < 2.2, "low per-character entropy"],
  ];
  const fired = patternTests.filter(([hit]) => hit).map(([, why]) => why);
  const pattern = fired.length > 0 ? 0.75 : 0;
  const value = Math.max(similarity, pattern);
  const detail = value === 0 ? "name is distinct from members and shows no machine pattern"
    : similarity >= pattern
      ? `name is ${(similarity * 100).toFixed(0)}% similar to member "${closest}"`
      : `machine-like naming pattern: ${fired.join("; ")}`;
  return { value, detail };
}

function joinVelocityScore(recentJoins) {
  check(recentJoins !== null && typeof recentJoins === "object" && !Array.isArray(recentJoins),
    "recentJoins must be an object");
  const { byIdentity = 0, byIp = 0 } = recentJoins;
  check(Number.isInteger(byIdentity) && byIdentity >= 0, "recentJoins.byIdentity must be a non-negative integer");
  check(Number.isInteger(byIp) && byIp >= 0, "recentJoins.byIp must be a non-negative integer");
  // 3+ joins by one identity, or 5+ from one IP, inside the velocity window.
  const value = clamp01(Math.max(byIdentity / 3, byIp / 5));
  return { value, detail: `${byIdentity} recent join(s) by identity, ${byIp} from IP inside the velocity window` };
}

function cardScore(card) {
  // null: the join path has no signed-card concept — the component is
  // inactive and excluded from the weighted mean, not scored neutral.
  if (card === null || card === undefined) return null;
  check(typeof card === "object" && !Array.isArray(card), "card must be an object or null");
  check(typeof card.present === "boolean" && typeof card.valid === "boolean", "card must be { present, valid } booleans");
  if (card.present && card.valid) return { value: 0, detail: "signed agent card present and verified" };
  if (card.present && !card.valid) return { value: 1, detail: "signed agent card present but INVALID" };
  return { value: 0.6, detail: "join path expects a signed card but none was presented" };
}

// Component weights. The card component is conditional (see cardScore);
// the remaining weights are fixed so the legend stays stable.
export const jevAdmissionWeights = Object.freeze({
  freshIdentity: 0.30,
  sybilName: 0.30,
  joinVelocity: 0.25,
  card: 0.15,
});

// The cheap classifier: signals in, spam-risk score 0..1 out, with the
// would-be decision. Frozen; JSON-stable; deterministic.
export function evaluateAdmission({ identityId = null, displayName, path,
  identityAgeMs = null, existingDisplayNames = [], recentJoins = {}, card = null, at = Date.now() } = {}) {
  if (identityId !== null) idOf(identityId, "identityId");
  check(jevAdmissionPaths.includes(path), `path must be one of ${jevAdmissionPaths.join(", ")}`);
  check(typeof at === "number" && Number.isFinite(at) && at >= 0, "at must be a finite ms-epoch time");
  const components = [
    { key: "freshIdentity", weight: jevAdmissionWeights.freshIdentity, ...freshIdentityScore(identityAgeMs) },
    { key: "sybilName", weight: jevAdmissionWeights.sybilName, ...sybilNameScore(displayName, existingDisplayNames) },
    { key: "joinVelocity", weight: jevAdmissionWeights.joinVelocity, ...joinVelocityScore(recentJoins) },
  ];
  const cardComponent = cardScore(card);
  if (cardComponent) components.push({ key: "card", weight: jevAdmissionWeights.card, ...cardComponent });
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const score = clamp01(components.reduce((sum, c) => sum + c.weight * c.value, 0) / totalWeight);
  const decision = score >= jevAdmissionRejectThreshold ? "reject"
    : score >= jevAdmissionReviewThreshold ? "review" : "admit";
  return Object.freeze({
    policyVersion: jevAdmissionPolicyVersion,
    gate: "admission",
    identityId, path,
    score,
    decision,
    // Would-be decision: shadow mode never enforces. enforced stays false
    // until a graduation decision flips the gate (docs/JEV-GATES.md).
    enforced: false,
    signals: Object.freeze(components.map(c => Object.freeze({
      key: c.key, weight: c.weight, value: c.value, detail: c.detail,
    }))),
    at,
  });
}
export { JevError };
