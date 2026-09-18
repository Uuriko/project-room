// SLA sweep hook wiring (task 26): the real readThreads/deliver authorities
// the sweep (server/sla-sweep.mjs) degrades honestly without.
//
// readThreads — createInboxThreadReader({ inbox, session }): enumerates the
// genuinely live threads from the inbox's own thread store via
// Inbox.slaThreadScan — the same pipeline as the thread view (same rows,
// same visibility, same message->direction mapping) — projected to the
// { threadId, channel, messages } shape the SLA clocks assess. The scan is
// owner-session bound: the owner wires their session (token + binding) at the
// call site; nothing here stores, refreshes, or logs credentials, and a
// rotated session is a one-line re-wire of this factory. An empty store scans
// to zero threads (honest, never invented); an invalid session throws and
// the sweep surfaces it as scanError, never as fake threads.
//
// deliver — createSlaBreachDeliver({ journal, accountId, notifyPrefs }):
// routes each breach record the urgent path decides to deliver into the
// durable in-app alert journal (server/sla-breach-journal.mjs), recording the
// decision, its reason, and the prefs snapshot the decider ran on — the same
// journaled-notification pattern the import path uses for its notify
// decisions. This is the existing notification path the urgent path uses:
// the breach record already ran through decideNotification with urgent=true
// inside the sweep (quiet hours bypassed, explicit muted-all respected), and
// deliver is its terminal in-app sink. No external sends, no push, no wake:
// delivery-channel and push decisions are John's call (task 22), so the
// journal is the delivery. Filing is idempotent per produced record;
// malformed records or decisions throw and the sweep counts them as errors,
// never silently drops them.
//
// Neither hook touches login/auth code, holds timers, or writes anywhere but
// the alert journal. Every dependency is injected; the sweep stays the only
// scheduler-facing surface.
import { SLA_BREACH_KIND } from "./sla-urgent-notify.mjs";

class SlaSweepHookError extends Error { constructor(code, message) { super(message); this.name = "SlaSweepHookError"; this.code = code; } }
const fail = (code, message) => { throw new SlaSweepHookError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_sla_sweep_hook", message); };

// Real readThreads for the SlaSweeper: the owner's live threads from the
// inbox's own thread store. inbox exposes Inbox.slaThreadScan; session is the
// owner's { token, binding } wired at the call site. includeChannels stays
// injectable for tests; the sweep is omnichannel so it defaults true.
export function createInboxThreadReader({ inbox, session, includeChannels = true, limit = null } = {}) {
  check(inbox !== null && typeof inbox === "object" && typeof inbox.slaThreadScan === "function",
    "inbox must expose slaThreadScan(token, binding, opts)");
  check(session !== null && typeof session === "object" && !Array.isArray(session),
    "session must be the owner's { token, binding }");
  check(typeof session.token === "string" && session.token.length > 0, "session.token must be a non-empty string");
  check(typeof session.binding === "string" && session.binding.length > 0, "session.binding must be a non-empty string");
  const { token, binding } = session;
  return async function readThreads() {
    const view = inbox.slaThreadScan(token, binding, { includeChannels, limit });
    const threads = Array.isArray(view?.threads) ? view.threads : [];
    // Exactly what the store scan returned: no filtering, no synthesis. An
    // empty thread store is an empty batch — the sweep reports zero threads,
    // never sla_sweep_unavailable and never invented ones.
    return threads;
  };
}

// Real deliver for the SlaSweeper: breach records the urgent path decided to
// deliver land in the durable in-app alert journal. journal is a
// SlaBreachAlertJournal (e.g. store.slaBreachAlerts); accountId doubles as
// the notify-prefs user id (single-owner account), matching the sweep's
// ownerId and the import path's convention; notifyPrefs is the same prefs
// manager the sweep's decideNotification ran on, so the journaled snapshot
// replays the recorded decision deterministically.
export function createSlaBreachDeliver({ journal, accountId, notifyPrefs } = {}) {
  check(journal !== null && typeof journal === "object" && typeof journal.notify === "function",
    "journal must be a SlaBreachAlertJournal");
  check(typeof accountId === "string" && accountId.length > 0 && accountId.length <= 512,
    "accountId must be a non-empty string");
  check(notifyPrefs !== null && typeof notifyPrefs === "object" && typeof notifyPrefs.decideNotification === "function"
    && typeof notifyPrefs.snapshot === "function",
    "notifyPrefs must expose decideNotification(userId, opts) and snapshot(userId)");
  return async function deliver(record, decision) {
    // The producer's record contract: an urgent breach, never anything else.
    check(record !== null && typeof record === "object" && !Array.isArray(record), "record must be a breach record");
    check(record.kind === SLA_BREACH_KIND, `record.kind must be ${SLA_BREACH_KIND}`);
    check(record.urgent === true, "record must carry urgent: true");
    check(decision !== null && typeof decision === "object" && !Array.isArray(decision),
      "decision must be a notify decision");
    check(typeof decision.decision === "string" && decision.decision.length > 0,
      "decision.decision must be a non-empty string");
    const receipt = journal.notify({ accountId, record, decision,
      prefsSnapshot: notifyPrefs.snapshot(accountId) });
    return receipt;
  };
}
export { SlaSweepHookError };
