// One registry for background work. The Worker alarm and the Node process
// both read this list: cadence, where it may run, the configuration gate,
// the budget, and how to find the next due time. A job with nothing waiting
// stays disabled so an idle room does not wake for it.
import { telegramConfig } from "./channel-adapters/telegram-config.mjs";
import { staleSweepDueAt, syncClaimPullRequests } from "./claim-pr-sync.mjs";
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
import { writeDailyBackup } from "../cloudflare/room-backup.mjs";

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

function backupConfigured(env) {
  const bucket = env?.ROOM_BACKUPS;
  if (bucket && typeof bucket.put === "function" && typeof bucket.head === "function") return true;
  const kv = env?.ROOM_BACKUPS_KV;
  return Boolean(kv && typeof kv.put === "function" && typeof kv.get === "function");
}

function logIntegrity(integrity) {
  const line = { event: "room.integrity" };
  for (const key of ["matched", "skipped", "verified", "budgetExceeded", "invitations", "paused", "checked", "swept"]) {
    if (typeof integrity?.[key] === "number") line[key] = integrity[key];
  }
  console.info(JSON.stringify(line));
  return integrity;
}

// #3334: a failed integrity tick must name the sub-check that threw, in a
// form safe for the public health surface: stable codes and record CLASSES
// only — never record ids, message bodies, or secrets. The store tags
// deferred-batch and full-path errors with `integritySubcheck`; the message
// patterns cover any untagged throw. Before this, the job converted every
// throw into { errors: 1 } and the heartbeat could only ever render
// "1 error(s) in tick", so three different root causes shared one
// byte-identical external signature.
export const INTEGRITY_SUBCHECKS = Object.freeze([
  "share_links", "agent_connections", "inbox", "email", "channel_updates",
  "quarantine_splits", "room_lifecycle", "identity_expiry", "referral_depth",
  "messages_backfill", "messages_parity", "invitation_audit", "help_history",
  "incremental", "snapshot", "unknown"
]);
const INTEGRITY_RECORD_CLASS = Object.freeze({
  share_links: "journal", agent_connections: "journal", inbox: "journal",
  email: "journal", channel_updates: "journal", quarantine_splits: "journal",
  room_lifecycle: "room", identity_expiry: "unknown", referral_depth: "invitation",
  messages_backfill: "message", messages_parity: "message",
  invitation_audit: "invitation", help_history: "invitation",
  incremental: "room", snapshot: "room", unknown: "unknown"
});
const SAFE_CARRIED_CODE = /^[a-z][a-z0-9_]{0,63}$/i;

export function classifyIntegrityError(error) {
  const message = String(error?.message ?? error ?? "");
  let subcheck = INTEGRITY_SUBCHECKS.includes(error?.integritySubcheck) ? error.integritySubcheck : null;
  if (!subcheck) {
    if (error?.code === "link_integrity_error") subcheck = "share_links";
    else if (/^messages parity failed/.test(message)) subcheck = "messages_parity";
    else if (/^messages backfill stopped/.test(message)) subcheck = "messages_backfill";
    else if (/room lifecycle/i.test(message)) subcheck = "room_lifecycle";
    else if (/help/i.test(message) && /reconciliation|history/.test(message)) subcheck = "help_history";
    else if (/invitation/i.test(message)) subcheck = "invitation_audit";
    else subcheck = "unknown";
  }
  // Only typed service errors (status + code) may carry their code onto the
  // public surface; everything else gets a stable derived code.
  const carried = typeof error?.code === "string" && Number.isFinite(error?.status) && SAFE_CARRIED_CODE.test(error.code)
    ? error.code
    : null;
  const code = carried ?? (subcheck === "unknown" ? "integrity_check_failed" : `${subcheck}_failed`);
  let errorClass = "unknown";
  if (/no such (table|column)|missing schema|\bschema\b/i.test(message)) errorClass = "schema";
  else if (/sqlite|database|storage|disk/i.test(message)) errorClass = "storage";
  else if (subcheck !== "unknown") errorClass = "integrity_mismatch";
  return { code, subcheck, errorClass, recordClass: INTEGRITY_RECORD_CLASS[subcheck] ?? "unknown" };
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
      return claimDueAt(store, now) != null || autolinkDueAt(store, now) != null || staleSweepDueAt(store, now) != null;
    },
    disabledReason: () => "No open pull request or stale board sweep is waiting",
    nextDueAt: (store, now) => claimDueAt(store, now) ?? autolinkDueAt(store, now) ?? staleSweepDueAt(store, now),
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
        // Isolated failures: the store contained one record's blast radius
        // and returned the outstanding failures instead of throwing. The
        // tick still fails — the verdict is unchanged — with the same
        // sanitized detail shape as the throw path (stable codes and
        // classes only; record ids stay in the operator log line).
        const failures = integrity?.failures ?? integrity?.deferred?.failures ?? [];
        if (failures.length) {
          const first = failures[0];
          const failure = classifyIntegrityError({ message: first.message, integritySubcheck: first.step });
          if (typeof first.code === "string" && SAFE_CARRIED_CODE.test(first.code)) failure.code = first.code;
          // The operator line carries the allowlisted fields only —
          // sub-check, record id, stable code, class, count. The stored
          // failure message is a diagnostic for the record's owner, not
          // log text: re-emitting it here every tick would republish
          // whatever a record's error once contained.
          console.error(`[integrity] ${failure.subcheck} failed for ${first.recordId || "store"} (${failure.code}, ${failure.errorClass}; ${failures.length} outstanding)`);
          const summary = {};
          for (const key of ["matched", "skipped", "verified", "invitations", "checked", "swept"]) {
            if (typeof integrity?.[key] === "number") summary[key] = integrity[key];
          }
          return {
            ...summary,
            errors: failures.length,
            scanError: `integrity ${failure.subcheck} failed (${failure.code})`,
            failureDetail: failure
          };
        }
        return logIntegrity(integrity);
      } catch (error) {
        console.error(`[integrity] ${oneLine(error?.message ?? error)}`);
        // #3334: the failure detail survives reporting — the heartbeat turns
        // scanError into lastError and persists failureDetail, so the health
        // surface names the failing sub-check instead of "1 error(s) in tick".
        const failure = classifyIntegrityError(error);
        return {
          errors: 1,
          scanError: `integrity ${failure.subcheck} failed (${failure.code})`,
          failureDetail: failure
        };
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
    name: "public-work-reseed",
    cadenceMs: MINUTE_MS,
    runtimes: Object.freeze(["worker", "node"]),
    // #3530: the keeper is due only when the public board's claimable
    // supply is exactly zero and at least one anchored starter seed has
    // a fully submitted latest round to advance.
    enabled(_env, store) {
      if (!store?.publicWorkClaims) return false;
      const status = store.publicWorkClaims.starterPoolStatus();
      return status.available && status.anchored > 0 && status.claimable === 0 && status.due.length > 0;
    },
    disabledReason: () => "Public-work starter pool has claimable tasks or no seed round is due",
    async run(store, ctx) {
      if (ctx.room?.reseedPublicWorkStarters) return ctx.room.reseedPublicWorkStarters();
      return store.publicWorkClaims.reseedStarterPool();
    }
  }),
  defineJob({
    name: "room-backup",
    cadenceMs: DAY_MS,
    slow: true,
    runtimes: Object.freeze(["worker"]),
    singleRuntimeReason: "Daily backup writes the ROOM_BACKUPS R2 bucket or the ROOM_BACKUPS_KV namespace. A Node process has neither binding.",
    enabled: env => backupConfigured(env),
    disabledReason: () => "Neither ROOM_BACKUPS (R2) nor ROOM_BACKUPS_KV is configured; no backups are being taken, see docs/BACKUP-DR.md",
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
  // REL-24: per-job run record for GET /api/health/jobs on Node.
  const records = new Map();
  // #3334 parity with the Worker heartbeat: a failing tick keeps a sanitized
  // failure detail (token-shaped fields only) so the Node health surface can
  // name the failing sub-check too.
  const detailToken = /^[a-z][a-z0-9_]{0,63}$/i;
  const failureDetailOf = source => {
    const detail = source?.failureDetail;
    if (!detail || typeof detail !== "object") return null;
    const out = {};
    for (const key of ["code", "subcheck", "errorClass", "recordClass"]) {
      if (typeof detail[key] === "string" && detailToken.test(detail[key])) out[key] = detail[key];
    }
    return Object.keys(out).length ? out : null;
  };
  const record = (name, at, ok, { error = null, failure = null, durationMs = null } = {}) => {
    const prior = records.get(name) ?? { consecutiveFailures: 0 };
    records.set(name, ok
      ? { ...prior, lastRunAt: at, lastSuccessAt: at, consecutiveFailures: 0, lastDurationMs: durationMs, lastSummaryAt: at, lastFailure: null }
      : { ...prior, lastRunAt: at, lastErrorAt: at, lastError: error ?? prior.lastError ?? null, consecutiveFailures: prior.consecutiveFailures + 1, lastDurationMs: durationMs, lastFailure: failure });
  };
  // ctxBase is scheduler-lifetime state, not a per-tick template: jobs may
  // store progress on it across ticks (runNodeRetention advances
  // retentionIndex so each tick prunes the next table). It must therefore be
  // passed to jobs as-is — a fresh spread copy per tick silently discarded
  // the rotated retentionIndex and every tick pruned table index 0 again.
  const ctxBase = { env, fetchImpl, dnsResolvers, now, gmailSync, drainer, growthTick, retentionIndex: 0 };
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
        const startedAt = now();
        try {
          // Jobs run sequentially under the `running` guard, so sharing
          // ctxBase is safe; only the per-job deadline changes between runs.
          ctxBase.deadline = deadline;
          const result = await job.run(store, ctxBase);
          lastRan.set(job.name, at);
          const failed = summaryFailed(result);
          record(job.name, at, !failed, {
            error: failed ? (result.scanError ? `scanError: ${oneLine(result.scanError)}` : `${Number(result.errors) || 0} error(s) in tick`) : null,
            failure: failed ? failureDetailOf(result) : null,
            durationMs: now() - startedAt
          });
          outcomes.push({ job: job.name, ok: true, result });
        } catch (error) {
          lastRan.set(job.name, at);
          record(job.name, at, false, { error: oneLine(error?.message ?? error), failure: failureDetailOf(error), durationMs: now() - startedAt });
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
    // Every registry job, in registry order. Node reports run facts only;
    // it does not grade health (no top-level status), so a fresh boot with
    // no runs yet is not reported as stale.
    jobHealth() {
      const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
      return JOBS.map(job => {
        const inRuntime = job.runtimes.includes("node");
        const gated = (job.name === "growth-watch" && !growthEnabled) || (job.name === "channel-drain" && !channelEnabled);
        const enabled = inRuntime && !gated && jobEnabled(job, env, store);
        const reason = !inRuntime ? (job.singleRuntimeReason ?? "Runs on the Worker only")
          : gated ? "Disabled for this process" : enabled ? null : jobDisabledReason(job, env, store);
        const rec = records.get(job.name) ?? {};
        return {
          name: job.name, runtime: inRuntime ? "node" : "worker-only", enabled, reason,
          periodSeconds: Math.round((overrides.get(job.name) ?? job.cadenceMs) / 1000),
          lastRunAt: iso(rec.lastRunAt), lastSuccessAt: iso(rec.lastSuccessAt), lastErrorAt: iso(rec.lastErrorAt),
          lastError: rec.lastError ?? null,
          lastErrorCode: rec.lastFailure?.code ?? null,
          lastErrorSubcheck: rec.lastFailure?.subcheck ?? null,
          lastErrorClass: rec.lastFailure?.errorClass ?? null,
          lastErrorRecordClass: rec.lastFailure?.recordClass ?? null,
          lastDurationMs: rec.lastDurationMs ?? null,
          lastSummaryAt: iso(rec.lastSummaryAt),
          consecutiveFailures: rec.consecutiveFailures ?? 0
        };
      });
    },
    runOnce
  };
}

// The scheduler wired for this process, read by GET /api/health/jobs.
let wiredScheduler = null;
export function nodeJobHealth() {
  return wiredScheduler ? wiredScheduler.jobHealth() : null;
}

function summaryFailed(result) {
  if (!result || typeof result !== "object") return false;
  return Boolean(result.scanError) || Number(result.errors) > 0;
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
  wiredScheduler = scheduler;
  return scheduler;
}
