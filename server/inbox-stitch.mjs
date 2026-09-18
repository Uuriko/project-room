// Cross-channel thread stitching (task #19) — pure functions. Identity
// resolution across Gmail/Telegram/X channels with hash-based keys only:
// raw emails, handles, and display names are never persisted by the stitch
// layer. The salt is an injected dependency (see stitchConfigFromEnv); the
// store module (server/inbox-stitch-store.mjs) owns persistence.
//
// Design: docs/CROSS-CHANNEL-THREAD-STITCHING.md (PR #543). Stitching is a
// read-path enrichment: envelopes stay channel-native, the stitch layer only
// produces a stitch graph (stitched_thread_id -> [{channel, sourceId}, ...])
// computed from participants, never from message bodies.
//
// Everything here is pure and deterministic: no store reads or writes, no
// network, no randomness. Frozen outputs; malformed inputs throw StitchError.
import { createHmac } from "node:crypto";

class StitchError extends Error { constructor(code, message) { super(message); this.name = "StitchError"; this.code = code; } }
const fail = (code, message) => { throw new StitchError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_stitch_input", message); };

// Hash epoch. Bumping the epoch (v1 -> v2) with a new salt rebuilds the
// index in one pass from envelopes; there is no in-place re-keying.
export const STITCH_EPOCH = "v1";
export const STITCH_ID_TYPES = Object.freeze(["email", "handle"]);
// Env bindings. The salt is a per-installation 256-bit secret (64 hex
// chars), generated once, kept in the same secure credential store as other
// channel secrets — never in the SQLite DB, never in logs, never exported
// with DB backups. Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
export const STITCH_SALT_BINDING = "STITCH_IDENTITY_SALT";
export const STITCH_ENABLE_BINDING = "STITCHING_ENABLED";
// Metric namespace, colon-delimited like the existing signin:fail:* style
// (<domain>:<object>:<event>). Labels never carry hashed keys or identifier
// material; the {reason} slot carries only the fixed defer-reason codes.
export const STITCH_METRICS = Object.freeze([
  "thread:stitch:identity:indexed",
  "thread:stitch:exact:formed",
  "thread:stitch:probabilistic:suggested",
  "thread:stitch:probabilistic:discarded",
  "thread:stitch:probabilistic:suppressed",
  "thread:stitch:verified:confirmed",
  "thread:stitch:merged",
  "thread:stitch:split",
  "thread:stitch:conflict",
  "thread:stitch:backfilled",
  "thread:stitch:unstitched",
]);
// Defer reasons for envelopes with no usable stitching identifier. Fixed
// vocabulary only — never identifier material.
export const STITCH_DEFER_REASONS = Object.freeze(["no_identifier", "bot_excluded", "insufficient_signal", "stitch_disabled"]);
// Split reasons. Fixed vocabulary only, for the same privacy reason: a
// free-text reason could smuggle a raw email, handle, or display name into
// the stitch tables and the immutable receipt. The audit trail records only
// the category.
export const STITCH_SPLIT_REASONS = Object.freeze(["owner_request", "wrong_person", "duplicate_identity", "opt_out"]);

// Reads the stitch configuration from an env-like object. Returns a frozen
// { salt, epoch, enabled, bindings } triple when the installation explicitly
// opts in (STITCHING_ENABLED=true AND a valid 64-hex-char salt), or null
// otherwise. Null is the RoomStore contract for "inert": the stitcher
// no-ops, the read path returns empty stitched views, and the importer
// writes no stitch rows. The feature stays inert until task #20's privacy
// approval flips the flag.
export function stitchConfigFromEnv(env = process.env) {
  const raw = typeof env?.[STITCH_SALT_BINDING] === "string" ? env[STITCH_SALT_BINDING].trim() : "";
  const valid = /^[0-9a-fA-F]{64}$/.test(raw);
  const enabled = String(env?.[STITCH_ENABLE_BINDING] ?? "").toLowerCase() === "true" && valid;
  if (!enabled) return null;
  return Object.freeze({ salt: Buffer.from(raw, "hex"), epoch: STITCH_EPOCH, enabled: true,
    bindings: Object.freeze([STITCH_SALT_BINDING, STITCH_ENABLE_BINDING]) });
}

// Deterministic string normalization (norm:v1) per identifier type. Returns
// the normalized value, or null when there is nothing usable to hash.
// displayName is normalized for probabilistic scoring only — it is never a
// hash index key (names collide far too often for an equality index).
export function normalizeIdentifier({ type, value } = {}) {
  if (type !== "email" && type !== "handle" && type !== "displayName") return null;
  if (typeof value !== "string") return null;
  if (type === "handle") {
    // Trim, Unicode-casefold, strip one leading @. @Alice and alice -> alice.
    const norm = value.trim().toLowerCase().replace(/^@/, "");
    return norm.length > 0 && norm.length <= 320 ? norm : null;
  }
  if (type === "email") {
    // Trim, casefold local-part and domain alike. Plus-tags and Gmail
    // dot-insensitivity are deliberately NOT normalized away at v1:
    // provider-specific rewriting is a false-positive factory.
    const norm = value.trim().toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm) && norm.length <= 320 ? norm : null;
  }
  const norm = value.trim().replace(/\s+/g, " ").toLowerCase();
  return norm.length > 0 && norm.length <= 1024 ? norm : null;
}

// The stitch key: "<epoch>:" + hex(HMAC-SHA256(salt, "norm:v1|<type>|<normalized>")).
// Separate namespaces for email and handle. Returns null on any invalid
// input (bad salt, bad identifier) — key derivation never throws, so the
// importer can treat "no key" as "deferred" without a try/catch per call.
export function stitchKey({ salt, epoch = STITCH_EPOCH, type, value } = {}) {
  if (!Buffer.isBuffer(salt) || salt.length !== 32) return null;
  if (typeof epoch !== "string" || !/^v[0-9]+$/.test(epoch)) return null;
  const norm = normalizeIdentifier({ type, value });
  if (norm === null) return null;
  return `${epoch}:` + createHmac("sha256", salt).update(`norm:v1|${type}|${norm}`, "utf8").digest("hex");
}

// Candidate stitch keys for an envelope participant. The exact-match rules
// from the design doc:
// - email channel, mailbox kind: the address is the identity -> email key.
// - telegram / x (and any channel with a user/chat participant carrying a
//   handle): the handle is the identity -> handle key. Channel-agnostic by
//   design: the importer only feeds validated channels, and a handle is a
//   handle wherever it appears.
// - bots, channels, groups: excluded (shared infrastructure, not people).
// Cross-field matching (handle vs address) is never deterministic: an
// email<->Telegram pair is a suggestion, never an exact link.
const STITCHABLE_KINDS = new Set(["user", "chat", "mailbox"]);
export function candidateKeys({ salt, epoch = STITCH_EPOCH, channel, participant } = {}) {
  if (!Buffer.isBuffer(salt) || salt.length !== 32) return [];
  const kind = participant?.kind ?? null;
  if (!STITCHABLE_KINDS.has(kind)) return [];
  const keys = [];
  if (channel === "email" || kind === "mailbox") {
    const key = stitchKey({ salt, epoch, type: "email", value: participant.handle ?? participant.id ?? "" });
    if (key) keys.push({ key, type: "email", channel: channel ?? "email" });
  } else {
    const key = stitchKey({ salt, epoch, type: "handle", value: participant.handle ?? "" });
    if (key) keys.push({ key, type: "handle", channel: channel ?? "telegram" });
  }
  return keys;
}

// Why an envelope produced no stitch keys. Fixed vocabulary only.
export function deferReason({ channel, participant } = {}) {
  const kind = participant?.kind ?? null;
  if (!channel || !participant) return "no_identifier";
  if (kind === "bot" || kind === "channel" || kind === "group") return "bot_excluded";
  if (channel !== "email" && channel !== "telegram" && channel !== "x") return "insufficient_signal";
  if (!STITCHABLE_KINDS.has(kind)) return "bot_excluded";
  const handle = kind === "mailbox" || channel === "email"
    ? (participant.handle ?? participant.id ?? "")
    : (participant.handle ?? "");
  if (!normalizeIdentifier({ type: channel === "email" || kind === "mailbox" ? "email" : "handle", value: handle })) {
    return "no_identifier";
  }
  return "insufficient_signal";
}

// Jaro-Winkler similarity, 0..1. Reference values: ("dixon","dicksonx")
// -> 0.8133, ("martha","marhta") -> 0.9611.
function jaroWinkler(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(la, lb) / 2 - 1;
  const ma = new Array(la).fill(false), mb = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - range), hi = Math.min(lb - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (!mb[j] && a[i] === b[j]) { ma[i] = true; mb[j] = true; matches++; break; }
    }
  }
  if (!matches) return 0;
  let transpositions = 0, k = 0;
  for (let i = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / la + matches / lb + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, la, lb) && a[i] === b[i]; i++) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}
function levenshtein(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    const cur = [i];
    for (let j = 1; j <= lb; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[lb];
}
const emailLocal = address => { const at = String(address).lastIndexOf("@"); return at > 0 ? String(address).slice(0, at).toLowerCase() : ""; };
// Jaro-Winkler similarity of two display names after norm:v1 normalization,
// 0..1. Used by the store's handle-reuse conflict guard.
export function nameSimilarity(a, b) {
  const na = normalizeIdentifier({ type: "displayName", value: a }) ?? "";
  const nb = normalizeIdentifier({ type: "displayName", value: b }) ?? "";
  if (!na || !nb) return 0;
  return jaroWinkler(na, nb);
}
const contextStopList = new Set(["meeting", "update", "request", "please", "thanks", "hello", "regards", "re", "fwd", "fw"]);
const contextTokens = subjects => {
  const tokens = new Set();
  for (const subject of subjects ?? []) {
    for (const token of String(subject).toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= 8 && !contextStopList.has(token)) tokens.add(token);
    }
  }
  return tokens;
};
// Probabilistic pair scoring. Each side: { handle, displayName, email,
// sentAt, sentAts, subjects }. Returns { score, bucket, components }.
// Buckets: high (>= 0.90), suggest (0.60-0.90), discard (< 0.60).
// Probabilistic links NEVER auto-form: even "high" is a review-queue
// suggestion requiring the owner's tap.
const SCORE_WEIGHTS = Object.freeze({ name_sim: 0.35, localpart_handle: 0.30, handle_fuzzy: 0.15, temporal: 0.10, context: 0.10 });
export function scorePair(a = {}, b = {}) {
  const na = normalizeIdentifier({ type: "displayName", value: a.displayName }) ?? "";
  const nb = normalizeIdentifier({ type: "displayName", value: b.displayName }) ?? "";
  const jw = na && nb ? jaroWinkler(na, nb) : 0;
  // Jaro-Winkler of normalized display names, gated at 0.85.
  const name_sim = na && nb ? (jw >= 0.85 ? jw : 0) : 0;
  const ea = emailLocal(a.email ?? ""), eb = emailLocal(b.email ?? "");
  const ha = (a.handle ?? "").replace(/^@/, "").toLowerCase(), hb = (b.handle ?? "").replace(/^@/, "").toLowerCase();
  // Email local-part equals the other side's normalized handle, or vice versa.
  const localpart_handle = (ea && ea === hb) || (eb && eb === ha) ? 1 : 0;
  // Near-identical handles: Levenshtein distance <= 1 on handles >= 5 chars.
  const handle_fuzzy = ha && hb && ha !== hb && ha.length >= 5 && hb.length >= 5 && levenshtein(ha, hb) <= 1 ? 1 : 0;
  // Both participants active within a 72h window with >= 2 messages nearby.
  const near = (times, ref) => times.filter(t => Math.abs(new Date(t).getTime() - ref) <= 72 * 3600 * 1000).length;
  const refA = a.sentAt ? new Date(a.sentAt).getTime() : NaN, refB = b.sentAt ? new Date(b.sentAt).getTime() : NaN;
  const countNear = (times, ref) => Number.isFinite(ref) ? near(times.filter(Boolean), ref) : 0;
  const temporal = countNear([...(a.sentAts ?? []), a.sentAt], refB) >= 2 && countNear([...(b.sentAts ?? []), b.sentAt], refA) >= 2 ? 1
    : (countNear([...(a.sentAts ?? []), a.sentAt], refB) >= 1 && countNear([...(b.sentAts ?? []), b.sentAt], refA) >= 1 ? 0.5 : 0);
  // Shared distinctive token in subjects/thread titles.
  const ta = contextTokens(a.subjects), tb = contextTokens(b.subjects);
  const context = ta.size > 0 && [...ta].some(t => tb.has(t)) ? 1 : 0;
  const components = { name_sim, localpart_handle, handle_fuzzy, temporal, context };
  const score = Math.min(1, Object.entries(components).reduce((sum, [k, v]) => sum + v * SCORE_WEIGHTS[k], 0));
  const bucket = score >= 0.9 ? "high" : score >= 0.6 ? "suggest" : "discard";
  return { score, bucket, components: Object.freeze({ ...components }) };
}

// Pure stitched-timeline merge. threads: [{ threadId, entries }] where each
// entry is either the buildThreads shape { message: { id, occurredAt },
// depth } or the flattened store shape { sourceId, occurredAt }.
// resolvers: linkOf(sourceId) -> stitch key or null; channelOf(sourceId) ->
// channel or null. Returns stitched timelines for stitch keys spanning >= 2
// channels: { stitchKey, channels, sources, provisional, entries:
// [{ sourceId, occurredAt, channel, depth, stitched, sourceThreadId }] },
// entries interleaved chronologically, depth 0 (cross-channel inReplyTo does
// not exist). Single-channel groups are skipped, not errors: stitching is
// cross-channel by definition. Quarantined links never reach this function
// (the store filters them).
export function stitchThreads(threads, { linkOf, channelOf } = {}) {
  check(Array.isArray(threads), "threads must be an array");
  check(typeof linkOf === "function" && typeof channelOf === "function", "linkOf and channelOf resolvers required");
  const groups = new Map();
  for (const thread of threads) {
    if (!thread || !Array.isArray(thread.entries)) continue;
    for (const entry of thread.entries) {
      const sourceId = entry?.message?.id ?? entry?.sourceId;
      if (!sourceId) continue;
      let key = null;
      try { key = linkOf(sourceId); } catch { continue; }
      if (!key) continue;
      let group = groups.get(key);
      if (!group) { group = { stitchKey: key, entries: [] }; groups.set(key, group); }
      let channel = null;
      try { channel = channelOf(sourceId); } catch { /* unknown channel */ }
      group.entries.push({ sourceId, occurredAt: entry.message?.occurredAt ?? entry.occurredAt ?? null, channel,
        depth: 0, stitched: true, sourceThreadId: thread.threadId ?? null });
    }
  }
  const result = [];
  for (const group of groups.values()) {
    const channels = [...new Set(group.entries.map(e => e.channel).filter(Boolean))].sort();
    if (channels.length < 2) continue; // single channel: stays native
    group.entries.sort((x, y) => String(x.occurredAt ?? "").localeCompare(String(y.occurredAt ?? "")));
    result.push({ stitchKey: group.stitchKey, channels,
      sources: group.entries.map(e => e.sourceId), provisional: false, entries: group.entries });
  }
  result.sort((a, b) => String(a.entries[0]?.occurredAt ?? "").localeCompare(String(b.entries[0]?.occurredAt ?? "")));
  return result;
}

export { StitchError };
