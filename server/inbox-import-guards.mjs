// Import-time spam + notify wiring for inbound channel messages (tasks 32/34).
// The pure scorer (server/inbox-spam.mjs) and the quiet-hours notification
// decider (server/notify-prefs.mjs) are called from the inbox import funnel —
// Inbox.apply's `source.import` branch — so scoring and delivery decisions
// actually run on every inbound message, for every import path (email/Telegram
// fixtures, the webhook drain, the live poller). Both run as pure functions of
// the envelope: the spam flag needs nothing else, and the notify decision
// journals the prefs snapshot it ran on, so the journaled receipt stays
// replay-deterministic for Inbox.verify() even after the owner edits prefs.
// Flag-only by default (task 33): a quarantine flag is recorded on the
// receipt; nothing is held, hidden, moved, or muted here.
import { flagMessage } from "./inbox-spam.mjs";
import { createNotifyPrefs } from "./notify-prefs.mjs";

const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
const nonEmpty = value => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const addressText = value => {
  if (!value || typeof value !== "object") return null;
  if (typeof value.address === "string" && value.address) {
    const name = typeof value.name === "string" ? value.name.trim() : "";
    return name ? `${name} <${value.address}>` : value.address;
  }
  return null;
};
// Normalize a sender participant onto the scannable `from` text the scorer
// expects: "Name <address>" for email mailboxes, "displayName @handle" for
// channel participants.
function senderText(from) {
  const address = addressText(from);
  if (address) return address;
  if (!from || typeof from !== "object") return null;
  const displayName = nonEmpty(from.displayName), handle = nonEmpty(from.handle);
  if (displayName && handle && handle !== displayName) return `${displayName} ${handle}`;
  return displayName ?? handle;
}
const recipientCount = message => [message?.to, message?.cc, message?.bcc]
  .filter(Array.isArray).reduce((total, list) => total + list.length, 0);
// Map one validated channel envelope onto the scannableMessage input shape
// plus the scan context (sender reputation inputs the import path cannot know
// — reputationScore, burstCount — stay null and skip their signals).
export function scannableOfEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
    throw new Error("envelope must be an object");
  const message = envelope.message ?? {}, body = envelope.body ?? {};
  if (typeof body.content !== "string" || body.content.length === 0)
    throw new Error("envelope body content must be non-empty text");
  const value = { body: body.content,
    urls: [...new Set(body.content.match(urlPattern) ?? [])],
    attachments: (Array.isArray(envelope.attachments) ? envelope.attachments : envelope.attachments?.items ?? [])
      .map(a => (typeof a?.name === "string" && a.name) || null).filter(Boolean) };
  const from = senderText(message.from);
  if (from) value.from = from;
  if (typeof message.subject === "string" && message.subject.length > 0) value.subject = message.subject;
  if (Array.isArray(message.replyTo) && message.replyTo.length > 0)
    value.replyTo = message.replyTo.map(addressText).filter(Boolean).join(", ") || null;
  const context = {};
  if (envelope.channel === "telegram" || envelope.channel === "whatsapp") {
    context.senderHandle = nonEmpty(message.from?.handle);
    context.botName = nonEmpty(envelope.connection?.identity?.displayName);
    context.botHandle = nonEmpty(envelope.connection?.identity?.handle);
  } else if (envelope.channel === "email") {
    context.recipients = recipientCount(message);
  }
  return { value, context };
}
// Score one imported envelope. Never throws: an envelope the scorer cannot
// scan is recorded as unscannable (score 0) instead of failing the import —
// scoring must never block ingestion. Deterministic: the same envelope always
// produces the same flag, which is what the journal replay relies on.
export function scoreImportedEnvelope(envelope) {
  try {
    const { value, context } = scannableOfEnvelope(envelope);
    const flag = flagMessage(value, { context });
    return Object.freeze({ score: flag.score,
      signals: Object.freeze(flag.signals.map(s => Object.freeze({ key: s.key, weight: s.weight, detail: s.detail }))),
      quarantine: flag.quarantine });
  } catch {
    return Object.freeze({ score: 0, signals: Object.freeze([]), quarantine: false, unscannable: true });
  }
}
// Run the quiet-hours/per-connection notify decision for one imported message.
// prefs is the store-owned notify-prefs manager; the account id doubles as the
// prefs user id (single-owner account). urgent is always false here — the
// SLA-breach path is the only caller that may set it, in a later slice. The
// prefs snapshot is journaled with the decision so the journal replay can
// recompute it from the recorded inputs (replayImportedNotification).
export function decideImportedNotification({ prefs, accountId, envelope, urgent = false, at = Date.now() }) {
  const connectionId = typeof envelope?.connection?.id === "string" && envelope.connection.id.length > 0
    ? envelope.connection.id : null;
  const decision = prefs.decideNotification(accountId, { connectionId, urgent, at });
  return Object.freeze({ decision: decision.decision, reason: decision.reason, at, connectionId, urgent,
    prefs: prefs.snapshot(accountId) });
}
// Both guards for one import, as journaled on the source.import receipt.
export function runImportGuards({ prefs, accountId, envelope, at = Date.now() }) {
  return Object.freeze({ spam: scoreImportedEnvelope(envelope),
    notify: decideImportedNotification({ prefs, accountId, envelope, at }) });
}
// Recompute a journaled notify decision from its recorded inputs (the prefs
// snapshot plus the connection/at/urgent that ran it). Used by the inbox
// journal replay; goes through the same decider as the import path, so the
// decision logic has exactly one implementation.
export function replayImportedNotification({ snapshot, accountId, connectionId, urgent, at }) {
  const prefs = createNotifyPrefs();
  prefs.restore(accountId, snapshot);
  return decideImportedNotification({ prefs, accountId, envelope: { connection: { id: connectionId } }, urgent, at });
}
