// Task 9 — scheduled auto-drain of `pending_channel_updates`.
//
// Webhook deliveries are secret-verified and journaled by ChannelWebhookInbox
// (server/channel-import.mjs); without a drain they sit in the journal until
// the owner manually triggers `syncTelegramConnection`. This module scans the
// journal on a schedule and, per telegram connection with pending updates:
//
//   1. poison-screens the pending slice with the same pure check the drain
//      path uses (`ChannelWebhookInbox.rejected`) and records one failed
//      attempt per poison update through the journal's bounded attempt
//      accounting, so a repeatedly-failing update parks as `failed` after
//      `channelJournalLimits.maxAttempts` instead of being retried forever;
//   2. drains the slice into the inbox through an injected `importSlice`
//      authority hook.
//
// The inbox import itself (`syncTelegramConnection` → `store.email.apply` →
// `store.inbox.importSource`) is owner-session bound: there is no system
// import authority yet (B20 — see the `importRoutedEmail` note in
// cloudflare/room.mjs). Until that authority exists the drainer is wired with
// no `importSlice`, and per-connection drains report an honest
// `channel_drain_unavailable` deferral instead of importing. The scan and the
// poison-screen are session-free and run on schedule regardless, so poison
// updates park within about a minute and the backlog stays drainable. Wiring
// the authority later is a one-line change at the call site.
//
// Nothing here touches secret verification (`ChannelWebhookInbox.receive`
// still matches the secret before anything is journaled) or `update_id`
// dedup (the journal's primary key plus `record`'s ON CONFLICT no-op); both
// stay exactly as they are. No credentials, no fetch, no sends.
import { randomUUID } from "node:crypto";
import { ChannelWebhookInbox, channelSyncLimits } from "./channel-import.mjs";
import { channelProviders, connectionState, profileChannel } from "./channel-connection.mjs";
import { channelJournalLimits } from "./channel-journal.mjs";

// A verified update should land in the inbox within about a minute; the scan
// is a cheap indexed count, so the default cadence is 60 s. Overridable per
// deployment via CHANNEL_DRAIN_INTERVAL_MS (<= 0 disables the scheduler).
export const channelDrainLimits = Object.freeze({ intervalMs: 60000, connectionsPerCycle: 25,
  sliceLimit: channelSyncLimits.webhookUpdates, maxAttempts: channelJournalLimits.maxAttempts });

const oneLine = value => String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);

export class ChannelDrainer {
  #store; #webhooks; #importSlice; #now; #inflight = new Set(); #lastTick = null;
  constructor({ store, webhooks, importSlice = null, now = () => Date.now() } = {}) {
    if (!store || typeof store.readTransaction !== "function") throw new TypeError("ChannelDrainer needs a store");
    if (!(webhooks instanceof ChannelWebhookInbox)) throw new TypeError("ChannelDrainer needs a ChannelWebhookInbox");
    if (importSlice !== null && typeof importSlice !== "function") throw new TypeError("ChannelDrainer importSlice must be a function or null");
    this.#store = store; this.#webhooks = webhooks; this.#importSlice = importSlice; this.#now = now;
  }
  get lastTick() { return this.#lastTick; }
  // Session-free scan: telegram connections in active state that hold pending
  // journal rows, oldest-backlog first. Read-only; safe to run every tick.
  scan() {
    return this.#store.readTransaction(() => {
      // The provider column carries the adapter provider id (e.g.
      // "telegram-bot"); the JS profileChannel check below is the real gate.
      const providers = channelProviders.telegram.map(() => "?").join(",");
      const rows = this.#store.db.prepare(`
        SELECT p.account_id, p.connection_id, COUNT(*) AS pending, a.auth_epoch
        FROM pending_channel_updates p
        JOIN private_email_connections c ON c.account_id = p.account_id AND c.id = p.connection_id
        JOIN accounts a ON a.id = p.account_id
        WHERE p.status = 'pending' AND c.provider IN (${providers})
        GROUP BY p.account_id, p.connection_id, a.auth_epoch
        ORDER BY MIN(p.received_at)`).all(...channelProviders.telegram);
      const found = [];
      for (const row of rows) {
        let connection = null;
        try { connection = JSON.parse(this.#store.db.prepare("SELECT data_json FROM private_email_connections WHERE account_id=? AND id=?")
          .get(row.account_id, row.connection_id)?.data_json); }
        catch { continue; }
        if (!connection || profileChannel(connection.profile) !== "telegram") continue;
        // The account's current auth epoch decides the state: a connection
        // whose owner must reconnect is skipped like the webhook route skips it.
        if (connectionState(connection, row.auth_epoch) !== "active") continue;
        found.push({ accountId: row.account_id, connectionId: row.connection_id, pending: row.pending });
        if (found.length >= channelDrainLimits.connectionsPerCycle) break;
      }
      return found;
    });
  }
  // Session-free poison screen: the same pure adapter check the drain path
  // runs, applied to the pending slice on schedule. Poison updates record one
  // journaled attempt each (bounded by channelJournalLimits.maxAttempts, then
  // parked as failed); neighbours are untouched and stay pending.
  poisonScreen({ accountId, connectionId }) {
    const connection = this.#store.email.connection(accountId, connectionId);
    if (!connection) return { screened: 0, parked: [], code: "channel_connection_not_found" };
    const updates = this.#webhooks.pending(accountId, connectionId, { limit: channelDrainLimits.sliceLimit });
    const rejected = ChannelWebhookInbox.rejected(connection.profile, updates);
    const parked = [];
    for (const [updateId, code] of rejected) {
      this.#webhooks.fail(accountId, connectionId, [updateId], code);
      parked.push(updateId);
    }
    return { screened: updates.length, parked };
  }
  // Drain one connection's pending slice into the inbox. Without an injected
  // import authority the slice is honestly deferred (B20), never imported.
  // Overlap-safe: a second drain for the same connection while one is in
  // flight is skipped. Never throws: failures are reported per connection.
  async drainConnection({ accountId, connectionId }) {
    const key = accountId + "/" + connectionId;
    if (this.#inflight.has(key)) return { accountId, connectionId, status: "skipped", code: "drain_inflight" };
    this.#inflight.add(key);
    try {
      if (!this.#importSlice) return { accountId, connectionId, status: "deferred", code: "channel_drain_unavailable",
        detail: "No import authority configured; the owner's next sync imports the slice." };
      const requestId = "drain-" + randomUUID();
      const result = await this.#importSlice({ store: this.#store, webhooks: this.#webhooks, accountId, connectionId, requestId });
      return { accountId, connectionId, status: "drained", imported: result?.receipt?.imports?.length ?? null,
        source: result?.source ?? null, duplicate: result?.duplicate ?? false };
    } catch (error) {
      // Authority and state conflicts (401/403/404/409) are the connection's
      // problem, not the updates': report them without poisoning the slice.
      // Content/importer faults surface here; syncTelegramConnection already
      // recorded the journal attempt accounting for those before throwing.
      return { accountId, connectionId, status: "error", code: oneLine(error?.code ?? "drain_failed"),
        message: oneLine(error?.message ?? error) };
    } finally {
      this.#inflight.delete(key);
    }
  }
  // One scheduled cycle: scan, poison-screen each connection, then drain.
  // Never throws: a failing connection is one entry in the summary.
  async tick() {
    const at = this.#now(), summary = { at, connections: 0, screened: 0, parked: 0, drained: 0, deferred: 0, errors: 0, results: [] };
    let targets = [];
    try { targets = this.scan(); }
    catch (error) { summary.scanError = oneLine(error?.code ?? error?.message ?? error); this.#lastTick = summary; return summary; }
    summary.connections = targets.length;
    for (const { accountId, connectionId } of targets) {
      let screened = { screened: 0, parked: [] };
      try { screened = this.poisonScreen({ accountId, connectionId }); }
      catch (error) { summary.errors++; summary.results.push({ accountId, connectionId, status: "error", code: oneLine(error?.code ?? "poison_screen_failed") }); continue; }
      summary.screened += screened.screened; summary.parked += screened.parked.length;
      const drained = await this.drainConnection({ accountId, connectionId });
      if (drained.status === "drained") summary.drained++;
      else if (drained.status === "deferred") summary.deferred++;
      else if (drained.status === "error") summary.errors++;
      summary.results.push({ ...drained, screened: screened.screened, parked: screened.parked });
    }
    this.#lastTick = summary;
    return summary;
  }
}

// The repo's scheduler pattern (src/growth-scheduler.js): an unref'd interval
// whose tick can never kill the process. A tick that throws is logged and
// counted; a tick still running when the next fires is skipped, never stacked.
export function createChannelDrainScheduler({ drainer, intervalMs = channelDrainLimits.intervalMs, onTick = null } = {}) {
  if (!(drainer instanceof ChannelDrainer)) throw new TypeError("channel-drain scheduler: drainer must be a ChannelDrainer");
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs)) throw new TypeError("channel-drain scheduler: intervalMs must be a finite number");
  if (onTick !== null && typeof onTick !== "function") throw new TypeError("channel-drain scheduler: onTick must be a function or null");
  const report = onTick ?? ((summary, count) => {
    if (summary.connections || summary.errors || summary.scanError) {
      console.log(`[channel-drain] tick=${count} connections=${summary.connections} screened=${summary.screened} parked=${summary.parked} ` +
        `drained=${summary.drained} deferred=${summary.deferred} errors=${summary.errors}${summary.scanError ? " scanError=" + oneLine(summary.scanError) : ""}`);
    }
  });
  let timer = null, tickCount = 0, errorCount = 0, running = false;
  async function runTick() {
    if (running) return; // Never stack ticks: a slow drain skips a beat instead of piling up.
    running = true;
    try {
      const summary = await drainer.tick();
      tickCount++; report(summary, tickCount);
    } catch (error) {
      errorCount++;
      console.warn(`[channel-drain] scheduler tick failed (${errorCount} errors): ${oneLine(error?.message ?? error)}`);
    } finally {
      running = false;
    }
  }
  return {
    start() {
      if (timer || intervalMs <= 0) return;
      timer = setInterval(() => { void runTick(); }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    isRunning() { return timer !== null; },
    getTickCount() { return tickCount; },
    getErrorCount() { return errorCount; },
  };
}
