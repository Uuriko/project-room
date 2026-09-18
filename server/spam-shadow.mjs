// Shadow-mode auto-quarantine instrumentation (AUTO-QUARANTINE-POLICY.md v1, §5).
//
// Before any enforcement exists, the room must measure flag-only precision: run
// the EXACT enforcement logic, log every would-be hold with its score and
// signals, and keep flag-only behavior visible. This module is that logic, as
// pure functions:
//
//   shadowGatesOfEnvelope(envelope) -> per-gate inputs derived from the envelope
//   evaluateShadowHold({ flag, channel, connectionId, messageId, gates, at }) -> decision
//   shadowDecisionForImport({ flag, envelope, at }) -> decision for one import
//
// The decision is journaled on the source.import receipt as
// receipt.shadowQuarantine (see server/inbox.mjs), which lands in
// private_inbox_commands.receipt_json next to the spam flag — one decision per
// scored message, including wouldHold:false. The journal replay recomputes it
// from the same journaled inputs (flag + envelope + at), so Inbox.verify()
// stays deterministic.
//
// Join contract for the post-shadow report:
//   - receipt.requestId / receipt.sourceId join the decision to its import.
//   - decision.messageId joins to spam_quarantine.message_id, whose later
//     review() transitions are the outcome labels: released = the owner judged
//     it ham, dismissed = confirmed spam.
//   - would-be holds = receipts with shadowQuarantine.wouldHold true;
//     precision = dismissed / (released + dismissed) over reviewed would-be
//     holds; features[] gives the per-signal true/false-positive breakdown.
//
// Enforcement semantics (policy §2.2–§2.3), coded as pre-conditions:
//   wouldHold = score >= 60 AND no hard gate blocks AND the channel is not a
//   flag-only channel. The threshold is the single shared hold threshold from
//   server/inbox-spam.mjs (quarantineThreshold) — one source of truth, so a
//   weight/threshold retune flows into shadow decisions automatically.
//   Personal Telegram chats (future Business API, task 12) stay flag-only:
//   shadowFlagOnlyChannels names the channel id that must never hold.
//
// Gate inputs are tri-state: true/false when the envelope carries the evidence,
// null when the input is not available — and a null gate is OPEN (it never
// blocks). The decision records evaluated/blocked per gate, so the report can
// tell a checked-and-passed gate apart from one that is not wired yet:
//   - allowlisted: no owner allowlist store exists yet -> always null (open).
//   - existingThread: reply markers on the envelope (telegram message.replyTo,
//     email replyHeaders inReplyTo/references). The import path cannot prove
//     owner participation from the envelope alone, so any threaded reply is
//     treated as an existing-thread reply (conservative: first-contact only).
//     Email replyHeaders.state === "not_loaded" -> null (unknown).
//     Note: a telegram threadId is the chat id and is always present, so it is
//     NOT a reply marker — only replyTo is.
//   - verifiedConnector: the sender IS the room's own bot/connector identity
//     (telegram: message.from.id === connection.identity.id; email:
//     message.from.address in connection.identity/aliases).
//   - serviceNotification: the import path marks no machine-generated
//     notifications on envelopes today -> always null (open).
//
// Pure, dependency-free, deterministic; frozen outputs; coded errors. No
// network, no store writes, no behavior change anywhere — enforcement stays
// flag-only (task 33) until John's tap.
import { quarantineThreshold } from "./inbox-spam.mjs";

class ShadowError extends Error { constructor(code, message) { super(message); this.name = "ShadowError"; this.code = code; } }
const fail = (code, message) => { throw new ShadowError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_shadow_input", message); };

// Policy version this instrumentation implements (AUTO-QUARANTINE-POLICY.md).
export const shadowPolicyVersion = "v1";
// Single shared hold threshold, policy §2.2 — the quarantineThreshold from the
// scorer is the one source of truth.
export const shadowHoldThreshold = quarantineThreshold;
// Channels that stay flag-only even at/above the threshold, policy §2.2. No
// connection produces this channel today (task 12); the check is coded now so
// the exception cannot be forgotten when personal chats arrive.
export const shadowFlagOnlyChannels = Object.freeze(["telegram-personal"]);
// Hard gates, policy §2.3, in evaluation order. gateBlock names the first one
// that fires.
export const shadowGateKeys = Object.freeze(["allowlisted", "existingThread", "verifiedConnector", "serviceNotification", "flagOnlyChannel"]);

const flagOf = flag => {
  check(flag !== null && typeof flag === "object" && !Array.isArray(flag), "flag must be a flagMessage() result");
  check(typeof flag.score === "number" && Number.isFinite(flag.score) && flag.score >= 0 && flag.score <= 100,
    "flag.score must be 0..100");
  check(Array.isArray(flag.signals) && flag.signals.every(s => s !== null && typeof s === "object"
    && typeof s.key === "string" && typeof s.weight === "number" && typeof s.detail === "string"),
    "flag.signals must be {key, weight, detail}[]");
  return flag;
};
const gatesOf = gates => {
  check(gates !== null && typeof gates === "object" && !Array.isArray(gates), "gates must be an object");
  const known = new Set(["allowlisted", "existingThread", "verifiedConnector", "serviceNotification"]);
  for (const key of Object.keys(gates)) check(known.has(key), `unknown gate "${key}"`);
  for (const key of known) check(gates[key] === undefined || gates[key] === null || typeof gates[key] === "boolean",
    `gate "${key}" must be true, false, or null`);
  return gates;
};
// Derive the §2.3 gate inputs from a normalized channel envelope. Pure: every
// input comes from the envelope itself, so the journal replay recomputes the
// identical gates from the journaled envelope. Unknown channels yield null
// (not evaluated, gate open) rather than guessing.
export function shadowGatesOfEnvelope(envelope) {
  check(envelope !== null && typeof envelope === "object" && !Array.isArray(envelope), "envelope must be an object");
  const channel = envelope.channel, message = envelope.message ?? {}, connection = envelope.connection ?? {};
  let existingThread = null, verifiedConnector = null;
  if (channel === "telegram") {
    existingThread = message.replyTo !== null && message.replyTo !== undefined;
    const ownId = connection.identity?.id;
    verifiedConnector = typeof ownId === "string" && ownId.length > 0 && message.from?.id === ownId;
  } else if (channel === "email") {
    const headers = envelope.replyHeaders;
    if (headers != null && headers.state !== "not_loaded") {
      existingThread = (Array.isArray(headers.inReplyTo) && headers.inReplyTo.length > 0)
        || (Array.isArray(headers.references) && headers.references.length > 0);
    }
    const own = new Set([connection.identity, ...(Array.isArray(connection.aliases) ? connection.aliases : [])]
      .map(a => typeof a?.address === "string" ? a.address.toLowerCase() : null).filter(Boolean));
    const from = typeof message.from?.address === "string" ? message.from.address.toLowerCase() : null;
    verifiedConnector = from !== null && own.size > 0 && own.has(from);
  }
  // allowlisted: no owner allowlist store exists yet. serviceNotification: the
  // import path marks no machine-generated notifications on envelopes. Both
  // stay null (evaluated:false, gate open) until their slices land.
  return { allowlisted: null, existingThread, verifiedConnector, serviceNotification: null };
}
// The exact enforcement logic, run in shadow: what WOULD have been held.
// flag is a flagMessage() result (or the unscannable score-0 variant from
// scoreImportedEnvelope); gates is a shadowGatesOfEnvelope() result (or an
// explicit caller-supplied equivalent). Frozen; JSON-stable; deterministic.
export function evaluateShadowHold({ flag, channel = null, connectionId = null, messageId = null, gates = {}, at = Date.now() }) {
  const scored = flagOf(flag), gateInputs = gatesOf(gates);
  check(channel === null || (typeof channel === "string" && channel.length > 0 && channel.length <= 128),
    "channel must be a short string when given");
  check(connectionId === null || (typeof connectionId === "string" && connectionId.length > 0 && connectionId.length <= 256),
    "connectionId must be a short string when given");
  check(messageId === null || (typeof messageId === "string" && messageId.length > 0 && messageId.length <= 512),
    "messageId must be a short string when given");
  check(typeof at === "number" && Number.isFinite(at) && at >= 0, "at must be a finite ms-epoch time");
  const evaluated = {};
  let gateBlock = null;
  for (const key of shadowGateKeys) {
    const blocked = key === "flagOnlyChannel"
      ? shadowFlagOnlyChannels.includes(channel)
      : gateInputs[key] === true;
    const isEvaluated = key === "flagOnlyChannel" ? true : gateInputs[key] !== null && gateInputs[key] !== undefined;
    evaluated[key] = Object.freeze({ evaluated: isEvaluated, blocked });
    if (blocked && gateBlock === null) gateBlock = key;
  }
  const wouldHold = scored.score >= shadowHoldThreshold && gateBlock === null;
  return Object.freeze({ policyVersion: shadowPolicyVersion, threshold: shadowHoldThreshold,
    score: scored.score, wouldHold, gateBlock,
    gates: Object.freeze(evaluated),
    channel, connectionId, messageId,
    features: Object.freeze(scored.signals.map(s => Object.freeze({ key: s.key, weight: s.weight, detail: s.detail }))),
    at });
}
// The per-import shadow decision: score-derived flag + envelope-derived gates.
// The import path journals this on the source.import receipt; the journal
// replay calls this same function with the journaled flag/envelope/at.
export function shadowDecisionForImport({ flag, envelope, at = Date.now() }) {
  check(envelope !== null && typeof envelope === "object" && !Array.isArray(envelope), "envelope must be an object");
  return evaluateShadowHold({ flag, channel: typeof envelope.channel === "string" ? envelope.channel : null,
    connectionId: typeof envelope.connection?.id === "string" && envelope.connection.id.length > 0 ? envelope.connection.id : null,
    messageId: typeof envelope.message?.id === "string" && envelope.message.id.length > 0 ? envelope.message.id : null,
    gates: shadowGatesOfEnvelope(envelope), at });
}
export { ShadowError };
