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
// Score one scannable message. Signals are frozen; score is capped at 100.
export function flagMessage(value) {
  const message = scannableMessage(value);
  const hits = [];
  for (const signal of signals) {
    let matched = false;
    try { matched = Boolean(signal.test({ ...message, subject: message.subject ?? "" })); } catch { matched = false; }
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
export { SpamFlagError };
