// One registry for background work. The Worker alarm and the Node process
// both read this list: cadence, where it may run, the configuration gate,
// the budget, and how to find the next due time. A job with nothing waiting
// stays disabled so an idle room does not wake for it.
import { telegramConfig } from "./channel-adapters/telegram-config.mjs";
import { syncClaimPullRequests } from "./claim-pr-sync.mjs";
import { discoverUnlinkedPulls, linkDeployToSettledClaims } from "./claim-autolink.mjs";
import { SOURCE_REVISION } from "./version.mjs";
import { RETENTION_TABLES, runLiveStoreRetention } from "./retention-run.mjs";
import { pruneAbuseRateBuckets } from "./abuse-rate-buckets.mjs";
import { pruneOAuthProvider } from "./oauth-provider-store.mjs";
import { backfillPublicReadModel } from "./public-read-model.mjs";
import { GmailSync } from "./gmail-sync.mjs";
import { GmailMailbox } from "./gmail-mailbox.mjs";
import { ChannelDrainer, channelDrainLimits } from "./channel-drain.mjs";
import { createWatcher } from "../src/growth-watch.js";
import { defaultOnAlert, defaultGrowthRules, DEFAULT_INTERVAL_MS } from "../src/growth-scheduler.js";
import { growthCollector } from "../src/growth-emit.js";
import { backupConfigured, writeDailyBackup } from "../cloudflare/room-backup.mjs";

export const JOB_BUDGET_MS = 5000;
export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
// Worker cron is only a safety net. It re-arms a missing alarm; it does not
// poll every minute. Idle rooms wake twice an hour from this cron.
export const SAFETY_NET_CRON = "*/30 * * * *";
export const SAFETY_NET_MS = 30 * MINUTE_MS;
export const ALARM_RETRY_MS = MINUTE_MS;

const oneLine = value => String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);

function read(store, sql, params = []) {
  if (!store?.db?.prepare) return null;
  try { return store.db.prepare(sql).get(...params) ?? null; }
  catch { return null; }
}

function channelPending(store) {
  return Boolean(read(store, "SELECT 1 AS hit FROM pending_channel_updates LIMIT 1")?.hit);
}

function webhookDueAt(store) {
  const row = read(store, "SELECT MIN(next_attempt_at) AS due FROM agent_webhook_deliveries WHERE state IN ('pending','failed')");
  return row?.due == null ? null : Number(row.due);
}

function landDueAt(store, now) {
  const open = read(store, `SELECT MIN(COALESCE(next_poll_at, 0)) AS due, COUNT(*) AS n
    FROM land_queue WHERE merged_sha IS NULL AND closed = 0`);
  if (!open?.n) return null;
  const limited = read(store, "SELECT MAX(rate_limited_until) AS until FROM land_queue");
  if (limited?.until != null && Number(limited.until) > now) return Number(limited.until);
  return Number(open.due);
}

function claimDueAt(store, now) {
  const row = read(store, `SELECT MIN(COALESCE(
      json_extract(item_json, '$.data.pullRequest.nextPollAt'),
      json_extract(item_json, '$.pullRequest.nextPollAt'),
      0
    )) AS due, COUNT(*) AS n
    FROM work_claims
    WHERE (
      json_extract(item_json, '$.data.state') IN ('claimed', 'in_progress', 'blocked')
      AND typeof(json_extract(item_json, '$.data.pullRequest.url')) = 'text'
      AND json_extract(item_json, '$.data.pullRequest.outcome') IS NULL
    ) OR (
      json_extract(item_json, '$.state') IN ('claimed', 'in_progress', 'blocked')
      AND typeof(json_extract(item_json, '$.pullRequest.url')) = 'text'
      AND json_extract(item_json, '$.pullRequest.outcome') IS NULL
    )`);
  if (!row?.n) return null;
  const due = Number(row.due);
  return Number.isFinite(due) ? due : now;
}

// plan-pr-autolink: the discovery poll runs when a live claim declares a
// repo but carries no PR link yet. It stays quiet while the webhook is
// fresh for that repo (webhookDeliveryStale in claim-autolink.mjs); this
// only decides whether the job wakes at all.
function autolinkDueAt(store, now) {
  const row = read(store, `SELECT COUNT(*) AS n
    FROM work_claims
    WHERE (
      json_extract(item_json, '$.data.state') IN ('claimed', 'in_progress', 'blocked')
      AND typeof(json_extract(item_json, '$.data.repo')) = 'text'
      AND (
        json_extract(item_json, '$.data.pullRequests') IS NULL
        OR json_array_length(json_extract(item_json, '$.data.pullRequests')) = 0
      )
      AND json_extract(item_json, '$.data.pullRequest.url') IS NULL
    ) OR (
      json_extract(item_json, '$.state') IN ('claimed', 'in_progress', 'blocked')
      AND typeof(json_extract(item_json, '$.repo')) = 'text'
      AND (
        json_extract(item_json, '$.pullRequests') IS NULL
        OR json_array_length(json_extract(item_json, '$.pullRequests')) = 0
      )
      AND json_extract(item_json, '$.pullRequest.url') IS NULL
    )`);
  if (!row?.n) return null;
  return now;
}

function backfillPending(store) {
  const row = read(store, "SELECT done FROM public_read_model_backfill WHERE id=1");
  if (!row) return true;
  return Number(row.done) !== 1;
}

function gmailOn(env) {
  return env?.ROOM_GMAIL_ENABLED === "1";
}

function logIntegrity(integrity) {
  const line = { event: "room.integrity" };
  for (const key of ["matched", "skipped", "verified", "budgetExceeded", "invitations", "paused", "checked", "swept"]) {
    if (typeof integrity?.[key] === "number") line[key] = integrity[key];
  }
  console.info(JSON.stringify(line));
  return integrity;
}

async function runNodeRetention(store, ctx) {
  const tableIndex = ctx.retentionIndex ?? 0;
  const receipt = runLiveStoreRetention({
    store, env: ctx.env, now: new Date(ctx.now?.() ?? Date.now()).toISOString(),
    tableIndex, deadline: ctx.deadline
  });
  ctx.retentionIndex = (tableIndex + 1) % RETENTION_TABLES.length;
  let webhookDeliveries = { deleted: 0 };
  let oauthProvider = { pruned: 0 };
  let abuseRateBuckets = { pruned: 0 };
  try {
    webhookDeliveries = store.agentPlugin.pruneWebhookDeliveries();
    oauthProvider = pruneOAuthProvider(store.db, { now: ctx.now?.() ?? Date.now(), limit: 100 });
    abuseRateBuckets = pruneAbuseRateBuckets(store.db, { now: ctx.now?.() ?? Date.now(), limit: 100 });
  } catch { /* a room that has never stored these caches has no table */ }
  return { ...receipt, webhookDeliveries, oauthProvider, abuseRateBuckets };
}

function defineJob(job) {
  return Object.freeze({
    budgetMs: JOB_BUDGET_MS,
    redactErrors: false,
    slow: false,
    singleRuntimeReason: null,
    disabledReason() { return "Not configured"; },
    ...job
  });
}

export const JOBS = Object.freeze([
  defineJob({
    name: "gmail-sync",
    cadenceMs: MINUTE_MS,
    runtimes: Object.freeze(["worker", "node"]),
    redactErrors: true,
    enabled: env => gmailOn(env),
    disabledReason: () => "Gmail is off",
    async run(store, ctx) {
      if (ctx.room?.syncGmailMailboxes) return ctx.room.syncGmailMailboxes();
      if (!ctx.gmailSync) return { completed: 0, skipped: 1 };
      return ctx.gmailSync.tick({ deadline: ctx.deadline });
    }
  }),
  defineJob({
    name: "channel-drain",
    cadenceMs: MINUTE_MS,
    runtimes: Object.freeze(["worker", "node"]),
    enabled(env, store) {
      if (store) return channelPending(store);
      return telegramConfig(env ?? {}).configured === true;
    },
    disabledReason: () => "No channel update is waiting",
    async run(store, ctx) {
      if (ctx.room?.drainChannelBacklog) return ctx.room.drainChannelBacklog();
      if (!ctx.drainer) return { skipped: 1, connections: 0 };
      return ctx.drainer.tick({ deadline: ctx.deadline });
    }
  }),
  defineJob({
    name: "webhook-dispatch",
    cadenceMs: MINUTE_MS,
    runtimes: Object.freeze(["worker", "node"]),
    enabled(_env, store) { return store ? webhookDueAt(store) != null : true; },
    disabledReason: () => "No webhook delivery is waiting",
    nextDueAt: store => webhookDueAt(store),
    async run(store, ctx) {
      if (ctx.room?.drainWebhookDeliveries) return ctx.room.drainWebhookDeliveries();
      return store.agentPlugin.drainWebhookDeliveries({ fetchImpl: ctx.fetchImpl, dnsResolvers: ctx.dnsResolvers });
    }
  }),
  defineJob({
    name: "land-queue",
    cadenceMs: MINUTE_MS,
    runtimes: Object.freeze(["worker", "node"]),
    enabled(_env, store) {
      // Without the store the caller cannot see an open item, so the tick
      // still runs. With the store, an empty queue has nothing to poll.
      if (!store) return true;
      return landDueAt(store, Date.now()) != null;
    },
    disabledReason: () => "No open pull request is waiting",
    nextDueAt: (store, now) => landDueAt(store, now),
    async run(store, ctx) {
      if (ctx.room?.refreshLandQueue) return ctx.room.refreshLandQueue();
      store.landQueue.configure({ env: ctx.env });
      return store.landQueue.refreshDue({ deadline: ctx.deadline, now: ctx.now?.() });
    }
  }),
  defineJob({
    name: "claim-prs",
    cadenceMs: MINUTE_MS,
    runtimes: Object.freeze(["worker", "node"]),
    enabled(_env, store) {
      if (!store) return true;
      const now = Date.now();
      return claimDueAt(store, now) != null || autolinkDueAt(store, now) != null;
    },
    disabledReason: () => "No open pull request is waiting",
    nextDueAt: (store, now) => claimDueAt(store, now) ?? autolinkDueAt(store, now),
    async run(store, ctx) {
      if (ctx.room?.refreshClaimPullRequests) return ctx.room.refreshClaimPullRequests();
      const out = await syncClaimPullRequests(store, { env: ctx.env, deadline: ctx.deadline });
      // plan-pr-autolink: poll fallback for repos without the webhook, and
      // link the recorded deploy revision back to the items it shipped.
      // Neither may fail the linked-PR poll above.
      try {
        const found = await discoverUnlinkedPulls(store, { env: ctx.env, deadline: ctx.deadline, nowMs: Date.now() });
        const deployed = linkDeployToSettledClaims(store, { revision: SOURCE_REVISION, nowMs: Date.now() });
        return { ...out, autolink: { discovered: found, deployed } };
      } catch (error) {
        console.error("claim autolink follow-up failed:", error?.message ?? error);
        return out;
      }
    }
  }),
  defineJob({
    name: "retention",
    cadenceMs: HOUR_MS,
    slow: true,
    runtimes: Object.freeze(["worker", "node"]),
    enabled: () => true,
    disabledReason: () => null,
    async run(store, ctx) {
      if (ctx.room?.planRetention) return ctx.room.planRetention();
      return runNodeRetention(store, ctx);
    }
  }),
  defineJob({
    name: "integrity",
    cadenceMs: HOUR_MS,
    slow: true,
    runtimes: Object.freeze(["worker", "node"]),
    enabled: () => true,
    disabledReason: () => null,
    async run(store, ctx) {
      try {
        const integrity = ctx.room?.verifyRoomIntegrity
          ? await ctx.room.verifyRoomIntegrity()
          : await store.verifyRoomIntegrity({ deadline: ctx.deadline });
        return logIntegrity(integrity);
      } catch (error) {
        console.error(`[integrity] ${oneLine(error?.message ?? error)}`);
        return { errors: 1 };
      }
    }
  }),
  defineJob({
    name: "public-read-model",
    cadenceMs: MINUTE_MS,
    runtimes: Object.freeze(["worker", "node"]),
    enabled(_env, store) { return store ? backfillPending(store) : true; },
    disabledReason: () => "Public read model backfill is finished",
    async run(store, ctx) {
      if (ctx.room?.backfillPublicReadModel) return ctx.room.backfillPublicReadModel();
      return backfillPublicReadModel(store, { limit: 20, deadline: ctx.deadline });
    }
  }),
  defineJob({
    name: "room-backup",
    cadenceMs: DAY_MS,
    slow: true,
    runtimes: Object.freeze(["worker"]),
    singleRuntimeReason: "Daily backup writes the ROOM_BACKUPS R2 bucket or the ROOM_BACKUPS_KV namespace. A Node process has neither binding.",
    enabled: env => backupConfigured(env),
    disabledReason: () => "ROOM_BACKUPS and ROOM_BACKUPS_KV are not configured",
    async run(_store, ctx) {
      if (!ctx.room) return { skipped: 1 };
      try { return await writeDailyBackup(ctx.env, ctx.room); }
      catch (error) {
        console.error(`[room-backup] ${oneLine(error?.message ?? error)}`);
        return { errors: 1 };
      }
    }
  }),
  defineJob({
    name: "growth-watch",
    cadenceMs: DEFAULT_INTERVAL_MS,
    runtimes: Object.freeze(["node"]),
    singleRuntimeReason: "Growth watch reads the process-local collector. The Worker does not host that collector.",
    enabled: () => true,
    disabledReason: () => null,
    async run(_store, ctx) {
      if (typeof ctx.growthTick !== "function") return { skipped: 1 };
      return ctx.growthTick();
    }
  })
]);

const BY_NAME = new Map(JOBS.map(job => [job.name, job]));

export function jobByName(name) {
  return BY_NAME.get(name) ?? null;
}

export function jobsFor(runtime) {
  return JOBS.filter(job => job.runtimes.includes(runtime));
}

export function jobEnabled(job, env, store) {
  try { return job.enabled(env ?? {}, store ?? null) === true; }
  catch { return false; }
}

export function jobDisabledReason(job, env, store) {
  if (jobEnabled(job, env, store)) return null;
  try {
    const reason = job.disabledReason(env ?? {}, store ?? null);
    return typeof reason === "string" && reason.trim() ? reason : "Not configured";
  } catch { return "Not configured"; }
}

// Null means this job has nothing queued. A number is the next UTC millisecond.
export function jobNextDue(job, store, now, lastRanAt) {
  if (!store && typeof job.nextDueAt === "function") return null;
  if (typeof job.nextDueAt === "function") {
    try {
      const value = job.nextDueAt(store, now);
      return Number.isFinite(value) ? value : null;
    } catch { return null; }
  }
  const last = Number.isFinite(lastRanAt) ? lastRanAt : 0;
  return last + job.cadenceMs;
}

export function jobIsDue(job, store, now, lastRanAt, cadenceMs = job.cadenceMs) {
  if (typeof job.nextDueAt === "function") {
    const next = jobNextDue(job, store, now, lastRanAt);
    return next != null && next <= now;
  }
  const last = Number.isFinite(lastRanAt) ? lastRanAt : 0;
  return last + cadenceMs <= now;
}

export function lastRanFrom(stored) {
  const lastRan = {};
  if (!stored || typeof stored !== "object") return lastRan;
  for (const [name, record] of Object.entries(stored)) {
    if (Number.isFinite(record?.lastRunAt)) lastRan[name] = record.lastRunAt;
  }
  return lastRan;
}

// Fast jobs only. Slow jobs ride the safety-net cron so an idle hour stays
// at two Durable Object wakes. A due time already in the past is pushed out
// by one cadence so a finished tick cannot schedule an immediate loop.
export function earliestFutureAlarm(jobs, { env, store, now, lastRan, runtime = "worker" }) {
  let earliest = null;
  for (const job of jobs) {
    if (job.slow || !job.runtimes.includes(runtime) || !jobEnabled(job, env, store)) continue;
    let next = jobNextDue(job, store, now, lastRan?.[job.name]);
    if (next == null) continue;
    if (next <= now) next = now + job.cadenceMs;
    if (earliest == null || next < earliest) earliest = next;
  }
  return earliest;
}

function finiteInterval(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError("interval must be a finite number");
  return number;
}

// Node has no Durable Object alarm. One unref'd timer asks each node job
// whether it is due. The immediate webhook kick still flushes a delivery
// that was just committed; this timer is the retry backstop.
export function startNodeScheduler({
  store, env = process.env, channelWebhooks = null, gmailAuth = null,
  tickMs = 1000, fetchImpl, dnsResolvers, now = () => Date.now()
} = {}) {
  if (!store) throw new TypeError("node scheduler needs a store");
  const overrides = new Map();
  let growthIntervalMs = DEFAULT_INTERVAL_MS;
  let growthEnabled = false;
  let growthTick = null;
  let growthTicks = 0;
  try {
    growthIntervalMs = finiteInterval(env.GROWTH_WATCH_INTERVAL_MS, DEFAULT_INTERVAL_MS);
    if (growthIntervalMs > 0) {
      const watcher = createWatcher({ collector: growthCollector, rules: defaultGrowthRules() });
      growthTick = () => {
        growthTicks += 1;
        const result = watcher.tick();
        const triggered = Array.isArray(result?.triggered) ? result.triggered : [];
        const context = { at: new Date(now()).toISOString(), window: result?.window ?? null };
        for (const hit of triggered) {
          try { defaultOnAlert(hit, context); }
          catch (error) { console.warn(`[growth] alert delivery failed: ${oneLine(error?.message ?? error)}`); }
        }
        return { triggered: triggered.length };
      };
      growthEnabled = true;
      overrides.set("growth-watch", growthIntervalMs);
    }
  } catch (error) {
    growthEnabled = false;
    console.warn(`[growth] scheduler disabled: ${oneLine(error?.message ?? error)}`);
  }
  let channelIntervalMs = channelDrainLimits.intervalMs;
  let channelEnabled = false;
  let drainer = null;
  if (channelWebhooks) {
    try {
      channelIntervalMs = finiteInterval(env.CHANNEL_DRAIN_INTERVAL_MS, channelDrainLimits.intervalMs);
      if (channelIntervalMs > 0) {
        drainer = new ChannelDrainer({ store, webhooks: channelWebhooks });
        channelEnabled = true;
        overrides.set("channel-drain", channelIntervalMs);
      }
    } catch (error) {
      channelEnabled = false;
      console.warn(`[channel-drain] scheduler disabled: ${oneLine(error?.message ?? error)}`);
    }
  }
  const gmailSync = gmailAuth ? new GmailSync(new GmailMailbox(store, gmailAuth)) : null;
  const lastRan = new Map();
  const ctxBase = { env, fetchImpl, dnsResolvers, now, gmailSync, drainer, retentionIndex: 0 };
  let timer = null;
  let running = false;
  async function runOnce() {
    if (running) return [];
    running = true;
    const outcomes = [];
    try {
      const at = now();
      for (const job of jobsFor("node")) {
        if (job.name === "growth-watch" && !growthEnabled) continue;
        if (job.name === "channel-drain" && !channelEnabled) continue;
        if (!jobEnabled(job, env, store)) continue;
        const cadenceMs = overrides.get(job.name) ?? job.cadenceMs;
        if (!jobIsDue(job, store, at, lastRan.has(job.name) ? lastRan.get(job.name) : undefined, cadenceMs)) continue;
        const deadline = at + (job.budgetMs ?? JOB_BUDGET_MS);
        try {
          const result = await job.run(store, { ...ctxBase, deadline, growthTick });
          lastRan.set(job.name, at);
          outcomes.push({ job: job.name, ok: true, result });
        } catch (error) {
          lastRan.set(job.name, at);
          console.warn(`[${job.name}] tick failed: ${oneLine(error?.message ?? error)}`);
          outcomes.push({ job: job.name, ok: false });
        }
      }
      return outcomes;
    } finally { running = false; }
  }
  return {
    growthEnabled, growthIntervalMs, channelEnabled, channelIntervalMs,
    getGrowthTickCount: () => growthTicks,
    start() {
      if (timer || !(tickMs > 0)) return;
      timer = setInterval(() => { void runOnce(); }, tickMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    isRunning() { return timer !== null; },
    runOnce
  };
}

export function wireNodeJobs(store, options = {}) {
  store.agentPlugin?.setDispatchKick(() => {
    queueMicrotask(() => {
      store.agentPlugin.drainWebhookDeliveries({
        fetchImpl: options.fetchImpl, dnsResolvers: options.dnsResolvers
      }).catch(() => {});
    });
  });
  const scheduler = startNodeScheduler({ store, ...options });
  scheduler.start();
  return scheduler;
}
