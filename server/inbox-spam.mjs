// Spam/phishing flagging for inbound messages (A029). Pure heuristic triage:
// a scannable message becomes { score, signals, quarantine }. No network,
// no reputation lookups, no store writes — a later slice persists the flags
// and moves quarantined mail. Heuristics are a first pass, not a verdict.
class SpamFlagError extends Error { constructor(code, message) { super(message); this.name = "SpamFlagError"; this.code = code; } }
const fail = (code, message) => { throw new SpamFlagError(code, message); };
const requireScannable = (condition, message = "invalid scannable message") => { if (!condition) fail("invalid_scannable_message", message); };

export const quarantineThreshold = 60;
const maxText = 131072;
const text = (value, max = maxText) => {
  requireScannable(typeof value === "string" && value.isWellFormed() && value.length <= max);
  return value;
};
// The scannable shape. Callers map channel envelopes onto it; every field is
// optional except body, because messaging channels have no subject or links.
export function scannableMessage(value) {
  requireScannable(value !== null && typeof value === "object" && !Array.isArray(value));
  const { from = null, replyTo = null, subject = null, body, urls = [], attachments = [] } = value;
  requireScannable(from === null || typeof from === "string", "from must be text");
  requireScannable(replyTo === null || typeof replyTo === "string", "replyTo must be text");
  const clean = { body: text(body) };
  if (from !== null) clean.from = text(from, 2048);
  if (replyTo !== null) clean.replyTo = text(replyTo, 2048);
  if (subject !== null) clean.subject = text(subject, 4096);
  requireScannable(Array.isArray(urls) && urls.every(u => typeof u === "string" && u.length <= 4096
    || u !== null && typeof u === "object" && typeof u.text === "string" && typeof u.target === "string"), "urls must be text or {text,target}");
  requireScannable(Array.isArray(attachments) && attachments.every(a => typeof a === "string" && a.length <= 512), "attachments must be text");
  clean.urls = urls.map(u => typeof u === "string" ? text(u, 4096) : Object.freeze({ text: text(u.text, 4096), target: text(u.target, 4096) }));
  clean.attachments = attachments.map(a => text(a, 512));
  return Object.freeze(clean);
}
const hostOf = url => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };
const domainOf = address => { const at = address.lastIndexOf("@"); return at === -1 ? null : address.slice(at + 1).toLowerCase(); };
// Signal detectors: each returns a signal { key, weight, detail } or null.
const signals = [
  { key: "display_name_mismatch", weight: 25, detail: "display name is itself an address on a different domain than the sender",
    test: m => { const parts = m.from != null && /^(.*)<(.+)>$/.exec(m.from); if (!parts) return false;
      const shown = domainOf(parts[1].trim()), actual = domainOf(parts[2].trim()); return Boolean(shown && actual && shown !== actual); } },
  { key: "reply_to_mismatch", weight: 20, detail: "reply-to domain differs from sender domain",
    test: m => { const a = m.from && domainOf(m.from), b = m.replyTo && domainOf(m.replyTo); return a && b && a !== b; } },
  { key: "link_text_mismatch", weight: 30, detail: "a URL's visible text points at a different host than its target",
    test: m => m.urls.some(u => { const entry = typeof u === "string" ? { text: u, target: u } : u;
      const shown = /^https?:\/\/([^/\s]+)/i.exec(entry.text); const host = hostOf(entry.target);
      return Boolean(shown && host && shown[1].toLowerCase() !== host); }) },
  { key: "suspicious_tld", weight: 15, detail: "URL uses a high-abuse TLD or punycode host",
    test: m => m.urls.some(u => { const host = hostOf(typeof u === "string" ? u : u.target); return Boolean(host && (/\.(xyz|top|click|link|zip|mov|sbs|country|rest)$/.test(host) || host.startsWith("xn--"))); }) },
  { key: "urgency_pressure", weight: 12, detail: "urgency or threat language pressuring quick action",
    test: m => /\b(urgent|immediately|act now|final notice|account (will be |)suspended|verify (your|this) account|security alert)\b/i.test(m.subject + "\n" + m.body) },
  { key: "credential_harvest", weight: 30, detail: "asks for passwords or login via a link",
    test: m => /\b(password|passcode|one-?time( |-)code|log ?in (here|below|to verify)|confirm your (identity|credentials))\b/i.test(m.body) && m.urls.length > 0 },
  { key: "dangerous_attachment", weight: 35, detail: "attachment with an executable or script extension",
    test: m => m.attachments.some(a => /\.(exe|scr|bat|cmd|js|jse|vbs|ps1|msi|jar|lnk|hta)(\.|$)/i.test(a)) },
  { key: "shouty_subject", weight: 8, detail: "all-caps subject with exclamation",
    test: m => m.subject != null && m.subject.length >= 8 && m.subject === m.subject.toUpperCase() && /[A-Z]/.test(m.subject) && m.subject.includes("!") },
];
// Sender-reputation, bulk-pattern, and Telegram-specific signals. These run
// on the scan context (not the message body), so a plain flagMessage(value)
// call is unaffected: context defaults to empty and every test below is
// skipped when its context field is absent.
const contextSignals = [
  { key: "bad_reputation", weight: 25, detail: "sender's reputation score is bad (prior quarantines/flags)",
    test: (m, c) => typeof c.reputationScore === "number" && c.reputationScore >= 60 },
  { key: "bulk_recipients", weight: 15, detail: "message addressed to an unusually large recipient set",
    test: (m, c) => Number.isInteger(c.recipients) && c.recipients >= 25 },
  { key: "burst_sender", weight: 20, detail: "sender burst: many messages from this sender in a short window",
    test: (m, c) => Number.isInteger(c.burstCount) && c.burstCount >= 20 },
  { key: "telegram_impersonation", weight: 35, detail: "sender uses the room bot's display name from a different handle",
    test: (m, c) => { if (typeof c.botName !== "string" || c.botName.length === 0
        || typeof c.botHandle !== "string" || c.botHandle.length === 0
        || typeof c.senderHandle !== "string" || c.senderHandle.length === 0) return false;
      return c.senderHandle !== c.botHandle && typeof m.from === "string" && m.from.includes(c.botName); } },
  { key: "telegram_giveaway_lure", weight: 25, detail: "giveaway/airdrop/double-your-money lure with a link",
    test: m => /(airdrop|free.{0,24}(crypto|token|ton|usdt|btc|eth)|double (your|the).{0,12}(crypto|ton|usdt|btc|eth|money)|send (us|me).{0,32}(crypto|ton|usdt|btc|eth)|claim.{0,24}(reward|bonus|airdrop)|guaranteed.{0,12}(profit|returns)|1000x|moonshot)/i.test(m.body) && m.urls.length > 0 },
  { key: "telegram_join_lure", weight: 20, detail: "t.me invite link paired with lure words",
    test: m => { const blob = m.body + "\n" + m.urls.map(u => typeof u === "string" ? u : u.target).join("\n");
      return /t\.me\/(\+|joinchat\/|[A-Za-z0-9_]{5,})/i.test(blob) && /(free|vip|signals|premium|exclusive|limited|hurry|secret|insider)/i.test(m.body); } },
  { key: "bot_spam_pattern", weight: 12, detail: "generic bot-spam phrasing common in messaging spam",
    test: m => /\b(click (the )?link|tap (the )?link|register now|limited time offer|you (have|'ve) won|congratulations.{0,24}(won|prize)|earn \$?\d+[,.]?\d*\s*(per day|daily|a day)|passive income|(dm|message) me (for|to))\b/i.test(m.body) },
];
// Validate the optional scan context for flagMessage: every field optional,
// unknown fields rejected so callers wire the documented context explicitly.
//   reputationScore: number 0..100 from createSenderReputation (sender history)
//   recipients: integer >= 0, size of the recipient set (bulk detection)
//   burstCount: integer >= 0, messages from this sender in the recent window
//   botName/botHandle: the room bot's display name and handle (impersonation)
//   senderHandle: the sender's handle/id on the messaging channel
function scanContext(value) {
  requireScannable(value !== null && typeof value === "object" && !Array.isArray(value), "context must be an object");
  const known = new Set(["reputationScore", "recipients", "burstCount", "botName", "botHandle", "senderHandle"]);
  for (const key of Object.keys(value)) requireScannable(known.has(key), `unknown context field "${key}"`);
  const { reputationScore = null, recipients = null, burstCount = null,
    botName = null, botHandle = null, senderHandle = null } = value;
  requireScannable(reputationScore === null || (typeof reputationScore === "number" && Number.isFinite(reputationScore) && reputationScore >= 0 && reputationScore <= 100), "reputationScore must be 0..100");
  requireScannable(recipients === null || (Number.isInteger(recipients) && recipients >= 0), "recipients must be an integer >= 0");
  requireScannable(burstCount === null || (Number.isInteger(burstCount) && burstCount >= 0), "burstCount must be an integer >= 0");
  for (const [field, v] of [["botName", botName], ["botHandle", botHandle], ["senderHandle", senderHandle]]) {
    requireScannable(v === null || (typeof v === "string" && v.length > 0 && v.length <= 512), `${field} must be a short non-empty string`);
  }
  return Object.freeze({ reputationScore, recipients, burstCount, botName, botHandle, senderHandle });
}
// Score one scannable message. Signals are frozen; score is capped at 100.
// The optional context feeds sender-reputation, bulk-pattern, and
// Telegram-specific signals; omitting it keeps the original body-only scan.
export function flagMessage(value, { context } = {}) {
  const message = scannableMessage(value);
  const ctx = scanContext(context ?? {});
  const hits = [];
  for (const signal of signals) {
    let matched = false;
    try { matched = Boolean(signal.test({ ...message, subject: message.subject ?? "" })); } catch { matched = false; }
    if (matched) hits.push(Object.freeze({ key: signal.key, weight: signal.weight, detail: signal.detail }));
  }
  for (const signal of contextSignals) {
    let matched = false;
    try { matched = Boolean(signal.test({ ...message, subject: message.subject ?? "" }, ctx)); } catch { matched = false; }
    if (matched) hits.push(Object.freeze({ key: signal.key, weight: signal.weight, detail: signal.detail }));
  }
  const score = Math.min(100, hits.reduce((sum, hit) => sum + hit.weight, 0));
  return Object.freeze({ score, signals: Object.freeze(hits), quarantine: score >= quarantineThreshold });
}
// Batch helper for the import path: returns only the messages that trip quarantine.
export function quarantineCandidates(messages) {
  requireScannable(Array.isArray(messages), "messages must be a list");
  return messages.map((message, index) => ({ index, flag: flagMessage(message) })).filter(({ flag }) => flag.quarantine);
}

// --- Sender reputation ----------------------------------------------------
// Per-sender history the spam guard uses as a reputationScore for flagMessage.
// Pure, caller-owned store (senderKey -> record); frozen outputs; coded
// errors via SpamFlagError. The score is a penalty: prior quarantines and
// confirmed-spam outcomes push a sender toward "bad" (>= 60, which feeds the
// bad_reputation signal); long clean histories pin it at 0 ("trusted").
const REPUTATION_OUTCOMES = ["clean", "flagged", "quarantined", "spam_confirmed"];
const REPUTATION_LABELS = ["unknown", "trusted", "neutral", "watch", "bad"];
export function createSenderReputation({ store } = {}) {
  requireScannable(store === undefined || store instanceof Map, "store must be a Map if given");
  const records = store ?? new Map();
  const keyOf = senderKey => {
    requireScannable(typeof senderKey === "string" && senderKey.length > 0 && senderKey.length <= 512, "senderKey must be a 1..512 character string");
    return senderKey;
  };
  const snapshot = key => {
    const rec = records.get(key) ?? { clean: 0, flagged: 0, quarantined: 0, spamConfirmed: 0 };
    const total = rec.clean + rec.flagged + rec.quarantined + rec.spamConfirmed;
    const score = Math.min(100, rec.quarantined * 20 + rec.flagged * 8 + rec.spamConfirmed * 60);
    const label = total === 0 ? "unknown"
      : rec.clean >= 10 && rec.flagged === 0 && rec.quarantined === 0 ? "trusted"
      : score >= 60 ? "bad"
      : score >= 30 ? "watch" : "neutral";
    return Object.freeze({ senderKey: key, total, clean: rec.clean, flagged: rec.flagged,
      quarantined: rec.quarantined, spamConfirmed: rec.spamConfirmed, score, label });
  };
  // Record one observed outcome for a sender. Returns the new reputation snapshot.
  const record = (senderKey, outcome) => {
    const key = keyOf(senderKey);
    requireScannable(REPUTATION_OUTCOMES.includes(outcome), `outcome must be one of ${REPUTATION_OUTCOMES.join(", ")}`);
    const rec = records.get(key) ?? { clean: 0, flagged: 0, quarantined: 0, spamConfirmed: 0 };
    if (outcome === "clean") rec.clean += 1;
    else if (outcome === "flagged") rec.flagged += 1;
    else if (outcome === "quarantined") rec.quarantined += 1;
    else rec.spamConfirmed += 1;
    records.set(key, rec);
    return snapshot(key);
  };
  // Read the reputation snapshot for a sender (unknown senders score 0).
  const get = senderKey => snapshot(keyOf(senderKey));
  // Senders at or above a score, for review dashboards; descending by score.
  const worst = (limit = 25) => {
    requireScannable(Number.isInteger(limit) && limit > 0 && limit <= 1000, "limit must be 1..1000");
    return Object.freeze([...records.keys()].map(snapshot).sort((a, b) => b.score - a.score).slice(0, limit));
  };
  return Object.freeze({ record, get, worst, OUTCOMES: Object.freeze([...REPUTATION_OUTCOMES]), LABELS: Object.freeze([...REPUTATION_LABELS]) });
}

// --- Quarantine review queue ----------------------------------------------
// Quarantined mail is never silently dropped: it lands in an owner-review
// queue as a pending record and stays there until an owner releases it back
// to the inbox or confirms it as spam. Every transition is recorded with the
// reviewer and a timestamp. Pure, caller-owned store; frozen outputs.
//
// NOTE: the live import path no longer files quarantined mail here — it
// journals to the restart-surviving SpamQuarantineJournal
// (server/spam-quarantine-journal.mjs, store.spamQuarantine), whose review()
// speaks the same release|confirm_spam vocabulary. This queue remains for
// tests and callers that want a caller-owned in-memory store; it loses its
// queue on restart.
class QuarantineError extends Error { constructor(code, message) { super(message); this.name = "QuarantineError"; this.code = code; } }
const qfail = (code, message) => { throw new QuarantineError(code, message); };
const qcheck = (condition, message) => { if (!condition) qfail("invalid_quarantine", message); };
export function createQuarantineQueue({ store } = {}) {
  qcheck(store === undefined || store instanceof Map, "store must be a Map if given");
  const records = store ?? new Map();
  let counter = 0;
  const snap = rec => Object.freeze({ id: rec.id, messageId: rec.messageId, channel: rec.channel,
    connectionId: rec.connectionId, score: rec.score, signals: Object.freeze(rec.signals.map(s => Object.freeze({ ...s }))),
    at: rec.at, status: rec.status, reviewedBy: rec.reviewedBy, reviewedAt: rec.reviewedAt,
    decision: rec.decision, note: rec.note });
  // File one quarantined message. flag is a flagMessage() result.
  const quarantine = ({ messageId, flag, channel, connectionId, at = Date.now() }) => {
    qcheck(typeof messageId === "string" && messageId.length > 0 && messageId.length <= 512, "messageId must be a 1..512 character string");
    qcheck(flag !== null && typeof flag === "object" && typeof flag.score === "number" && Array.isArray(flag.signals) && flag.quarantine === true,
      "flag must be a flagMessage() result with quarantine true");
    qcheck(typeof channel === "string" && channel.length > 0 && channel.length <= 128, "channel must be a 1..128 character string");
    qcheck(connectionId === undefined || connectionId === null || (typeof connectionId === "string" && connectionId.length > 0 && connectionId.length <= 256),
      "connectionId must be a short string when given");
    qcheck(typeof at === "number" && Number.isFinite(at) && at >= 0, "at must be a finite ms-epoch time");
    const rec = { id: `qz-${++counter}`, messageId, channel, connectionId: connectionId ?? null,
      score: flag.score, signals: flag.signals.map(s => ({ key: s.key, weight: s.weight, detail: s.detail })),
      at, status: "pending", reviewedBy: null, reviewedAt: null, decision: null, note: null };
    records.set(rec.id, rec);
    return snap(rec);
  };
  // Owner review: release it to the inbox, or confirm it as spam. Records stay.
  const review = (id, { decision, reviewer, note = null }) => {
    qcheck(records.has(id), `unknown quarantine id "${id}"`);
    qcheck(decision === "release" || decision === "confirm_spam", "decision must be release or confirm_spam");
    qcheck(typeof reviewer === "string" && reviewer.length > 0 && reviewer.length <= 256, "reviewer must be a 1..256 character string");
    qcheck(note === null || (typeof note === "string" && note.length <= 2048), "note must be text up to 2048 chars");
    const rec = records.get(id);
    qcheck(rec.status === "pending", `quarantine "${id}" already ${rec.status}; reviews are final`);
    rec.status = decision === "release" ? "released" : "confirmed_spam";
    rec.decision = decision; rec.reviewedBy = reviewer; rec.reviewedAt = Date.now(); rec.note = note;
    records.set(id, rec);
    return snap(rec);
  };
  const get = id => { qcheck(typeof id === "string", "id must be a string"); return records.has(id) ? snap(records.get(id)) : null; };
  const pending = () => Object.freeze([...records.values()].filter(r => r.status === "pending").map(snap));
  const counts = () => { const c = { pending: 0, released: 0, confirmedSpam: 0 };
    for (const r of records.values()) { if (r.status === "pending") c.pending += 1; else if (r.status === "released") c.released += 1; else c.confirmedSpam += 1; }
    return Object.freeze(c); };
  return Object.freeze({ quarantine, review, get, pending, counts, size: () => records.size });
}
export { SpamFlagError, QuarantineError };
