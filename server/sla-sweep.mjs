// SLA sweep/scheduler (omnichannel task 26, feeding the tasks 24/34/35 breach
// producer). This is the live-thread sweep PR #555 left unwired: on every tick
// it reads the live threads through an injected `readThreads` hook, feeds them
// into createSlaBreachProducer#produce() (server/sla-urgent-notify.mjs), and
// routes each newly-breached urgent record through the quiet-hours decision
// path (server/notify-prefs.mjs #decideNotification) with urgent=true: urgent
// bypasses quiet hours and per-connection batching, but an explicit muted-all
// level still mutes it — that behavior is decideNotification's, this module
// only preserves it.
//
// Wiring follows server/channel-drain.mjs: the module itself never writes
// anything, never sends anything, and holds no timers (the scheduler adds the
// interval); every dependency is injected. The live-thread read is
// owner-session bound in server/inbox.mjs (the thread view needs auth — see
// slaAssessment there for the exact message->direction mapping this hook must
// reproduce), so like ChannelDrainer's importSlice there is no default
// authority: without a readThreads hook the tick reports an honest
// `sla_sweep_unavailable` deferral instead of inventing threads. Delivery is
// likewise injected (`deliver`): without it the alert ledger still updates
// (dedupe stays correct) but routing reports `sla_deliver_unavailable`. The
// sweeper never pushes a byte itself; the owner wires `deliver` to their chosen
// channel (e.g. the in-app notification feed). Frozen outputs; malformed
// inputs throw SlaSweepError. No login/auth code, no credentials.
import { createSlaBreachProducer, SLA_BREACH_KIND } from "./sla-urgent-notify.mjs";
import { createNotifyPrefs } from "./notify-prefs.mjs";
import { validateSlaTargets } from "./sla-clocks.mjs";

class SlaSweepError extends Error { constructor(code, message) { super(message); this.name = "SlaSweepError"; this.code = code; } }
const fail = (code, message) => { throw new SlaSweepError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_sla_sweep", message); };

// A breach should page within minutes, not hours: the sweep cadence is far
// below the smallest default target (Telegram/whatsapp <= 2h), and the read is
// a bounded thread-view scan, so 5 minutes is cheap. Overridable per
// deployment via the scheduler's intervalMs. threadsPerTick mirrors
// produce()'s 10000-thread bound.
export const slaSweepLimits = Object.freeze({ intervalMs: 5 * 60 * 1000, threadsPerTick: 10000 });

const oneLine = value => String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);

// One scheduled sweep: read the live threads, produce breach alerts, and route
// each urgent record through decideNotification. readThreads({ now }) returns
// the threads the SLA clocks assess: [{ threadId, channel, messages: [{ id,
// occurredAt, direction }] }] — the same shape assessSlaBatch takes; the
// caller's contract (e.g. the inbox thread view) decides what "live" means.
// deliver(record, decision) receives each record that decideNotification says
// to deliver (decision = the frozen decideNotification output); it may be
// async. The tick never throws: a failing reader surfaces as scanError, a
// failing deliver as one entry in errors.
export class SlaSweeper {
  #readThreads; #deliver; #notifyPrefs; #producer; #ownerId; #now; #lastTick = null;
  constructor({ readThreads = null, deliver = null, notifyPrefs = null, notifyStore = undefined,
    producer = null, alertStore = undefined, targets = undefined, ownerId, now = () => Date.now() } = {}) {
    if (readThreads !== null && typeof readThreads !== "function") throw new TypeError("SlaSweeper: readThreads must be a function or null");
    if (deliver !== null && typeof deliver !== "function") throw new TypeError("SlaSweeper: deliver must be a function or null");
    if (notifyPrefs !== null && (typeof notifyPrefs !== "object" || typeof notifyPrefs.decideNotification !== "function"))
      throw new TypeError("SlaSweeper: notifyPrefs must expose decideNotification(userId, opts) or be null");
    if (producer !== null && (typeof producer !== "object" || typeof producer.produce !== "function"))
      throw new TypeError("SlaSweeper: producer must expose produce(threads, opts) or be null");
    if (targets !== undefined && producer !== null)
      throw new TypeError("SlaSweeper: targets are ignored when a producer is injected; configure targets on the producer instead");
    check(typeof ownerId === "string" && ownerId.length > 0 && ownerId.length <= 512, "ownerId must be a non-empty string");
    if (targets !== undefined) {
      try { validateSlaTargets(targets); }
      catch (error) { fail("invalid_sla_sweep", `targets are invalid: ${error instanceof Error ? error.message : error}`); }
    }
    if (typeof now !== "function") throw new TypeError("SlaSweeper: now must be a function");
    this.#readThreads = readThreads;
    this.#deliver = deliver;
    this.#notifyPrefs = notifyPrefs ?? createNotifyPrefs({ store: notifyStore });
    this.#producer = producer ?? createSlaBreachProducer({ store: alertStore, targets });
    this.#ownerId = ownerId;
    this.#now = now;
  }
  get lastTick() { return this.#lastTick; }
  // Alert records currently active (breached and unanswered) in the ledger.
  activeAlerts() { return this.#producer.activeAlerts(); }
  // Drop one thread's alert without a sweep; a still-breached thread re-alerts
  // on the next tick.
  clearAlert(threadId) { return this.#producer.clearAlert(threadId); }
  async tick() {
    const at = this.#now();
    const summary = { at, kind: SLA_BREACH_KIND, threads: 0, produced: 0, delivered: 0,
      muted: 0, deferred: 0, errors: 0, active: 0, scanError: null, results: [] };
    if (!this.#readThreads) {
      // No thread-read authority configured (like channel_drain_unavailable):
      // honest deferral, never invented threads.
      summary.scanError = "sla_sweep_unavailable: no readThreads authority configured; wire the owner's thread view to run breach sweeps";
      this.#lastTick = summary;
      return Object.freeze(summary);
    }
    let threads;
    try { threads = await this.#readThreads({ now: at }); }
    catch (error) { summary.scanError = oneLine(error?.code ?? error?.message ?? error); this.#lastTick = summary; return Object.freeze(summary); }
    let produced;
    try { produced = this.#producer.produce(threads, { now: at }); }
    catch (error) { summary.scanError = oneLine(error?.code ?? error?.message ?? error); this.#lastTick = summary; return Object.freeze(summary); }
    summary.threads = Array.isArray(threads) ? threads.length : 0;
    summary.produced = produced.length;
    for (const record of produced) {
      let decision;
      try {
        // urgent=true: bypasses quiet hours and batching inside
        // decideNotification; muted-all still returns "muted".
        decision = this.#notifyPrefs.decideNotification(this.#ownerId, { urgent: true, at });
      } catch (error) {
        summary.errors++;
        summary.results.push({ threadId: record.threadId, channel: record.channel, status: "error",
          code: oneLine(error?.code ?? "sla_decide_failed") });
        continue;
      }
      if (decision.decision === "muted") {
        summary.muted++;
        summary.results.push({ threadId: record.threadId, channel: record.channel, status: "muted",
          decision: decision.decision, reason: decision.reason });
        continue;
      }
      if (!this.#deliver) {
        summary.deferred++;
        summary.results.push({ threadId: record.threadId, channel: record.channel, status: "deferred",
          code: "sla_deliver_unavailable", detail: "no deliver hook configured; the alert stays active in the ledger" });
        continue;
      }
      try {
        await this.#deliver(record, decision);
        summary.delivered++;
        summary.results.push({ threadId: record.threadId, channel: record.channel, status: "delivered",
          decision: decision.decision, reason: decision.reason });
      } catch (error) {
        summary.errors++;
        summary.results.push({ threadId: record.threadId, channel: record.channel, status: "error",
          code: oneLine(error?.code ?? "sla_deliver_failed") });
      }
    }
    summary.active = this.#producer.activeAlerts().length;
    this.#lastTick = summary;
    return Object.freeze(summary);
  }
}

// The repo's scheduler pattern (server/channel-drain.mjs): an unref'd interval
// whose tick can never kill the process. A tick that throws is logged and
// counted; a tick still running when the next fires is skipped, never stacked.
export function createSlaSweepScheduler({ sweeper, intervalMs = slaSweepLimits.intervalMs, onTick = null } = {}) {
  if (!(sweeper instanceof SlaSweeper)) throw new TypeError("sla-sweep scheduler: sweeper must be a SlaSweeper");
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs)) throw new TypeError("sla-sweep scheduler: intervalMs must be a finite number");
  if (onTick !== null && typeof onTick !== "function") throw new TypeError("sla-sweep scheduler: onTick must be a function or null");
  const report = onTick ?? ((summary, count) => {
    if (summary.produced || summary.errors || summary.scanError) {
      console.log(`[sla-sweep] tick=${count} threads=${summary.threads} produced=${summary.produced} ` +
        `delivered=${summary.delivered} muted=${summary.muted} deferred=${summary.deferred} errors=${summary.errors}` +
        `${summary.scanError ? " scanError=" + oneLine(summary.scanError) : ""}`);
    }
  });
  let timer = null, tickCount = 0, errorCount = 0, running = false;
  async function runTick() {
    if (running) return; // Never stack ticks: a slow sweep skips a beat instead of piling up.
    running = true;
    try {
      const summary = await sweeper.tick();
      tickCount++; report(summary, tickCount);
    } catch (error) {
      errorCount++;
      console.warn(`[sla-sweep] scheduler tick failed (${errorCount} errors): ${oneLine(error?.message ?? error)}`);
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
export { SlaSweepError, SLA_BREACH_KIND };
