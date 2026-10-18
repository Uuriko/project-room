// Cron heartbeat: every scheduled job records lastSuccessAt / lastError and
// GET /api/health/jobs exposes them read-only. Regression for the silent cron
// outage where every tick failed with a DO RPC error but pages stayed green.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { JOBS, jobEnabled } from "../server/jobs.mjs";
import { channelJournalSchema } from "../server/channel-journal.mjs";
import {
  CRON_JOBS, HEARTBEAT_STORAGE_KEY, applyOutcomes, compactSummary, jobHealthView, redactError, runCronJobs, summaryFailure
} from "../cloudflare/job-heartbeat.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const RPC_ERROR = "The receiving Durable Object does not support RPC, because its class was not declared with `extends DurableObject`.";

function installWorkersShim() {
  const dir = mkdtempSync(join(tmpdir(), "room-job-heartbeat-"));
  const shimUrl = pathToFileURL(join(dir, "shim.mjs")).href;
  writeFileSync(join(dir, "shim.mjs"), [
    "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    "export function httpServerHandler() { return { fetch() { return new Response(null, { status: 500 }); } }; }",
    ""
  ].join("\n"));
  writeFileSync(join(dir, "hook.mjs"), [
    `const shim = ${JSON.stringify(shimUrl)};`,
    "export async function resolve(specifier, context, nextResolve) {",
    "  if (specifier === 'cloudflare:workers' || specifier === 'cloudflare:node') return { url: shim, shortCircuit: true };",
    "  return nextResolve(specifier, context);",
    "}",
    ""
  ].join("\n"));
  register(pathToFileURL(join(dir, "hook.mjs")).href, import.meta.url);
}
installWorkersShim();
const { default: worker, ProjectRoom } = await import(pathToFileURL(join(root, "cloudflare/room.mjs")).href);
const { channelDrainTickShape, CHANNEL_DRAIN_STUCK_MS, CHANNEL_DRAIN_INFLIGHT_KEY } = await import(pathToFileURL(join(root, "cloudflare/channel-drain-tick.mjs")).href);

function memoryStorage() {
  const map = new Map();
  return { map, async get(key) { return structuredClone(map.get(key)); }, async put(key, value) { map.set(key, structuredClone(value)); } };
}

// A DO stub that behaves like workerd RPC: real ProjectRoom methods only, each
// dispatched to a plain object that owns ctx.storage.
function roomStub(overrides = {}) {
  const self = { ctx: { storage: memoryStorage() } };
  const calls = [];
  const stub = new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (typeof ProjectRoom.prototype[prop] !== "function") return () => Promise.reject(new TypeError(`no RPC method ${String(prop)}`));
      return async (...args) => {
        calls.push(String(prop));
        if (overrides[prop]) return overrides[prop](...args);
        if (prop === "recordCronTick" || prop === "readJobHealth") return ProjectRoom.prototype[prop].apply(self, args);
        return { checked: 0 };
      };
    }
  });
  return { stub, self, calls };
}

test("every worker job has a heartbeat entry and its cadence", () => {
  assert.deepEqual(CRON_JOBS.map(job => job.name), [
    "gmail-sync", "channel-drain", "webhook-dispatch", "land-queue", "claim-prs",
    "retention", "integrity", "public-read-model", "public-work-reseed", "escrow-epochs", "room-backup", "patrol",
    "store-growth", "messages-archive"
  ]);
  assert.deepEqual(CRON_JOBS.map(job => job.periodSeconds), [60, 60, 60, 60, 60, 3600, 3600, 60, 60, 60, 86400, 60, 3600, 3600]);
});

test("runCronJobs runs one job at a time and yields between them", async () => {
  let active = 0;
  let max = 0;
  let yields = 0;
  const run = async () => {
    active += 1;
    max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active -= 1;
    return { checked: 1 };
  };
  const outcomes = await runCronJobs({
    "gmail-sync": run,
    "channel-drain": run,
    "webhook-dispatch": run,
    "land-queue": run,
    "retention": run
  }, { log() {}, yieldTurn: async () => { yields += 1; } });
  assert.equal(max, 1);
  assert.equal(yields, 4);
  assert.equal(outcomes.length, 5);
  assert.ok(outcomes.every(outcome => outcome.ok && outcome.durationMs >= 0));
});

test("runCronJobs records failures, summary failures and redacts gmail errors", async () => {
  const logs = [];
  let t = 1_000;
  const outcomes = await runCronJobs({
    "land-queue": () => Promise.reject(new Error(RPC_ERROR)),
    "channel-drain": async () => ({ connections: 1, errors: 0, scanError: "SQLITE_BUSY" }),
    "gmail-sync": () => Promise.reject(Object.assign(new Error("mailbox alice@example.com body leak"), { code: "gmail_reconnect_required" })),
    "retention": () => ({ dryRun: true, deleted: 0 }),
    "webhook-dispatch": async () => ({ processed: 2, delivered: 2, id: "secret-ish" })
  }, { now: () => (t += 5), log: line => logs.push(line) });
  const by = Object.fromEntries(outcomes.map(o => [o.job, o]));
  assert.equal(by["land-queue"].ok, false);
  assert.match(by["land-queue"].error, /does not support RPC/);
  assert.equal(by["channel-drain"].ok, false);
  assert.match(by["channel-drain"].error, /scanError/);
  assert.equal(by["gmail-sync"].error, "gmail_reconnect_required");
  assert.ok(!JSON.stringify(outcomes).includes("alice@example.com"));
  assert.equal(by.retention.ok, true);
  assert.deepEqual(by["webhook-dispatch"].summary, { processed: 2, delivered: 2 });
  assert.ok(logs.some(line => line.startsWith("[land-queue] cron tick failed:")));
});

test("redactError drops tokens, secrets and query strings", () => {
  const out = redactError("fetch https://hook.example/x?sig=abc failed: Bearer pri_abcdefghijklmnop token=zzz ghp_1234567890abcdef " + "A".repeat(40));
  assert.ok(!/pri_abc|ghp_123|sig=abc|zzz|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/.test(out), out);
  assert.ok(redactError("x".repeat(1000)).length <= 240);
  assert.equal(summaryFailure({ errors: 2 }), "2 error(s) in tick");
  assert.equal(summaryFailure({ budgetExceeded: 1, checked: 2 }), null);
  assert.equal(compactSummary({ budgetExceeded: 1, checked: 2 }).budgetExceeded, 1);
  assert.equal(summaryFailure({ checked: 1 }), null);
  assert.deepEqual(compactSummary({ a: 1, b: "no", c: true, d: { x: 1 } }), { a: 1, c: true });
});

test("jobHealthView marks stale beyond 3x period and failing on errors", () => {
  const now = Date.parse("2026-09-24T22:00:00Z");
  const fresh = applyOutcomes({}, CRON_JOBS.map(job => ({ job: job.name, ok: true, at: now - 30_000, summary: { checked: 1 } })));
  assert.equal(jobHealthView(fresh, now).status, "ok");
  const view = jobHealthView(fresh, now + 181_000);
  assert.equal(view.status, "stale");
  for (const job of view.jobs) {
    if (job.periodSeconds === 60) {
      assert.equal(job.stale, true, job.name);
      assert.equal(job.staleAfterSeconds, 180);
    } else {
      assert.equal(job.stale, false, job.name);
      assert.ok(job.staleAfterSeconds > 180, job.name);
    }
  }
  const failing = applyOutcomes(fresh, [{ job: "land-queue", ok: false, at: now, error: RPC_ERROR }]);
  const failingView = jobHealthView(failing, now);
  const land = failingView.jobs.find(job => job.name === "land-queue");
  assert.equal(land.status, "failing");
  assert.equal(land.consecutiveFailures, 1);
  assert.equal(land.lastSuccessAt, new Date(now - 30_000).toISOString());
  assert.match(land.lastError, /does not support RPC/);
  assert.equal(failingView.status, "failing");
  assert.equal(jobHealthView(undefined, now).status, "stale", "never-run jobs are stale");
});

test("applyOutcomes persists a failing tick's summary; a tick with no summary keeps the prior one", () => {
  const now = Date.parse("2026-10-17T21:00:00Z");
  let stored = applyOutcomes({}, [{ job: "integrity", ok: true, at: now - 60_000, summary: { checked: 1 } }]);
  stored = applyOutcomes(stored, [{ job: "integrity", ok: false, at: now, error: "scanError: integrity agent_connections failed (connection_integrity_error)",
    summary: { checked: 2, blockedRooms: 3 },
    failure: { code: "connection_integrity_error", subcheck: "agent_connections", errorClass: "integrity_mismatch", recordClass: "journal" } }]);
  let view = jobHealthView(stored, now).jobs.find(job => job.name === "integrity");
  assert.deepEqual(view.lastSummary, { checked: 2, blockedRooms: 3 }, "the failing tick's summary replaces the last success summary");
  assert.equal(view.lastSummaryAt, new Date(now).toISOString());
  // A thrown tick records no summary (runCronJobs stores null): the prior
  // summary stands, still labelled by its own lastSummaryAt.
  stored = applyOutcomes(stored, [{ job: "integrity", ok: false, at: now + 60_000, error: "tick exploded" }]);
  view = jobHealthView(stored, now + 60_000).jobs.find(job => job.name === "integrity");
  assert.deepEqual(view.lastSummary, { checked: 2, blockedRooms: 3 });
  assert.equal(view.lastSummaryAt, new Date(now).toISOString());
  assert.equal(view.consecutiveFailures, 2);
});

test("channel drain ticks report the last completed drain, and a wedged drain fails", async () => {
  // Bug sweep F-1: the RPC starts the drain in the background, so its
  // return shape is built from the last completed drain's outcome.
  const now = 1_000_000;
  // Nothing completed yet: a fresh start has no outcome to report.
  // (#3927: it is marked unobserved — the tick ran, but it saw no
  // completion, so the heartbeat must not grade it as a success.)
  let shape = channelDrainTickShape({ connections: 3, inflight: false, inflightSince: null, now, completed: null });
  assert.equal(shape.start, true);
  assert.deepEqual(shape.result, { started: 1, background: 1, connections: 3, unobserved: 1 });
  assert.equal(summaryFailure(shape.result), null);

  // A completed drain with per-connection errors becomes the next tick's
  // recorded outcome; its per-connection detail (ids) never crosses.
  shape = channelDrainTickShape({ connections: 3, inflight: false, inflightSince: null, now,
    completed: { at: now - 1000, connections: 1, screened: 4, parked: 1, drained: 0, deferred: 0, errors: 2,
      results: [{ accountId: "a1", connectionId: "c1", status: "error" }] } });
  assert.equal(shape.start, true);
  assert.equal(shape.result.errors, 2);
  assert.equal(shape.result.screened, 4);
  assert.equal(shape.result.parked, 1);
  assert.equal(shape.result.results, undefined);
  assert.ok(!JSON.stringify(shape.result).includes("a1"));
  assert.equal(summaryFailure(shape.result), "2 error(s) in tick");

  // A scanError from the completed drain rides the same channel.
  shape = channelDrainTickShape({ connections: 1, inflight: false, inflightSince: null, now,
    completed: { errors: 0, scanError: "channel_scan_failed" } });
  assert.match(summaryFailure(shape.result), /scanError/);

  // A clean completed drain records success.
  shape = channelDrainTickShape({ connections: 1, inflight: false, inflightSince: null, now,
    completed: { screened: 2, parked: 0, drained: 1, deferred: 0, errors: 0 } });
  assert.equal(summaryFailure(shape.result), null);
  assert.equal(shape.result.drained, 1);

  // The reported outcome lands in the heartbeat as a failing tick.
  const outcomes = await runCronJobs({ "channel-drain": async () => channelDrainTickShape({
    connections: 1, inflight: false, inflightSince: null, now, completed: { errors: 2 } }).result },
    { now: () => now, log: () => {} });
  assert.equal(outcomes[0].ok, false);
  let stored = applyOutcomes({}, [{ job: "channel-drain", ok: true, at: now - 1000 }]);
  stored = applyOutcomes(stored, outcomes);
  const drain = jobHealthView(stored, now).jobs.find(job => job.name === "channel-drain");
  assert.equal(drain.status, "failing");
  assert.equal(drain.consecutiveFailures, 1);
  assert.match(drain.lastError, /2 error\(s\) in tick/);

  // Inflight within the bound: a drain is legitimately running, no verdict.
  shape = channelDrainTickShape({ connections: 2, inflight: true, inflightSince: now - 1000, now, completed: null });
  assert.equal(shape.start, false);
  assert.equal(shape.result.inflight, 1);
  assert.equal(summaryFailure(shape.result), null);

  // Inflight past the bound: the wedge is a failed tick, not a success.
  shape = channelDrainTickShape({ connections: 2, inflight: true, inflightSince: now - CHANNEL_DRAIN_STUCK_MS - 1000, now, completed: null });
  assert.equal(shape.start, false);
  assert.equal(shape.result.stuck, 1);
  assert.equal(shape.result.scanError, "channel_drain_stuck");
  assert.match(summaryFailure(shape.result), /channel_drain_stuck/);
});

test("channel drain shape: only a consumed completion makes a tick conclusive", () => {
  const now = 3_000_000;
  // Started and inflight ticks that consumed no completion are unobserved.
  const started = channelDrainTickShape({ connections: 1, inflight: false, inflightSince: null, now, completed: null });
  assert.equal(started.result.unobserved, 1);
  const inflight = channelDrainTickShape({ connections: 1, inflight: true, inflightSince: now - 1_000, now, completed: null });
  assert.equal(inflight.result.unobserved, 1);
  // A consumed completion — even one riding an inflight tick — is conclusive.
  const consumed = channelDrainTickShape({ connections: 1, inflight: true, inflightSince: now - 1_000, now, completed: { errors: 0, screened: 1 } });
  assert.equal(consumed.result.unobserved, undefined);
  assert.equal(consumed.result.screened, 1);
  // A wedged LIVE drain still refuses to start a second one...
  const stuckLive = channelDrainTickShape({ connections: 1, inflight: true, inflightSince: now - CHANNEL_DRAIN_STUCK_MS - 1_000, now, completed: null });
  assert.equal(stuckLive.start, false);
  assert.equal(stuckLive.result.stuck, 1);
  // ...but an ORPHANED wedge (its instance is gone) starts a replacement,
  // or the backlog would never drain again.
  const stuckOrphan = channelDrainTickShape({ connections: 1, inflight: true, inflightSince: now - CHANNEL_DRAIN_STUCK_MS - 1_000, now, completed: null, orphaned: true });
  assert.equal(stuckOrphan.start, true);
  assert.equal(stuckOrphan.result.stuck, 1);
  assert.match(summaryFailure(stuckOrphan.result), /channel_drain_stuck/);
});

test("channel drain: a tick that observed no completion does not clear a recorded failure", async () => {
  // #3927 R2: tick T consumed a completed drain's errors and recorded a
  // failure; the replacement drain was still inflight at T+1. That tick
  // observed nothing, so it must not zero the failure or advance the
  // success clock — only an observed completion may do either.
  const t0 = 2_000_000;
  const tick = (args, at) => runCronJobs(
    { "channel-drain": async () => channelDrainTickShape(args).result },
    { now: () => at, log: () => {} });
  let stored = applyOutcomes({}, [{ job: "channel-drain", ok: true, at: t0, summary: { checked: 1 } }]);

  let outcomes = await tick({ connections: 1, inflight: false, inflightSince: null, now: t0 + 1_000, completed: { errors: 2 } }, t0 + 1_000);
  assert.equal(outcomes[0].ok, false);
  stored = applyOutcomes(stored, outcomes);
  let drain = jobHealthView(stored, t0 + 1_000).jobs.find(job => job.name === "channel-drain");
  assert.equal(drain.consecutiveFailures, 1);
  assert.equal(drain.lastSuccessAt, new Date(t0).toISOString());

  outcomes = await tick({ connections: 1, inflight: true, inflightSince: t0 + 1_000, now: t0 + 61_000, completed: null }, t0 + 61_000);
  assert.equal(outcomes[0].ok, true);
  assert.equal(outcomes[0].unobserved, true);
  stored = applyOutcomes(stored, outcomes);
  drain = jobHealthView(stored, t0 + 61_000).jobs.find(job => job.name === "channel-drain");
  assert.equal(drain.consecutiveFailures, 1, "an inflight tick must not clear a recorded failure");
  assert.equal(drain.lastSuccessAt, new Date(t0).toISOString(), "an inflight tick must not advance the success clock");
  assert.equal(drain.status, "failing");
  assert.equal(stored["channel-drain"].lastRunAt, t0 + 61_000, "the run itself is still recorded");

  // A fresh start observes nothing either: it records the run, not a success.
  outcomes = await tick({ connections: 1, inflight: false, inflightSince: null, now: t0 + 62_000, completed: null }, t0 + 62_000);
  assert.equal(outcomes[0].unobserved, true);
  const fresh = applyOutcomes({}, outcomes);
  assert.equal(fresh["channel-drain"].lastRunAt, t0 + 62_000);
  assert.equal(fresh["channel-drain"].lastSuccessAt, undefined);

  // When the replacement drain completes clean and its outcome is
  // consumed, THAT tick clears the failure and advances the clock.
  outcomes = await tick({ connections: 1, inflight: false, inflightSince: null, now: t0 + 121_000,
    completed: { screened: 3, parked: 0, drained: 1, deferred: 0, errors: 0 } }, t0 + 121_000);
  assert.equal(outcomes[0].ok, true);
  assert.equal(outcomes[0].unobserved, undefined);
  stored = applyOutcomes(stored, outcomes);
  drain = jobHealthView(stored, t0 + 121_000).jobs.find(job => job.name === "channel-drain");
  assert.equal(drain.consecutiveFailures, 0);
  assert.equal(drain.lastSuccessAt, new Date(t0 + 121_000).toISOString());
  assert.equal(drain.status, "ok");

  // Other jobs never declare a tick unobserved: a plain result — and a
  // gmail-shaped one, whose `pending` is a remaining-work gauge — still
  // records an ordinary success.
  const plain = await runCronJobs({
    "land-queue": async () => ({ checked: 1 }),
    "gmail-sync": async () => ({ completed: 0, pending: 1 })
  }, { now: () => t0, log: () => {} });
  assert.ok(plain.every(outcome => outcome.unobserved === undefined));
});

// A DO-shaped stub for the drain RPC glue: the real prototype methods run
// against a plain object, on the inflight branch (a start would call the
// private background method, which needs a real instance — the workerd
// check in cloudflare/jobs-alarm.check.mjs covers the start paths).
function drainSelf({ storage, outcome = null }) {
  return {
    paused: false,
    ctx: { storage, waitUntil() {} },
    channelDrainer: { configured: () => ({ configured: true, connections: 1 }), tick: async () => ({}) },
    channelWebhooks: null,
    channelDrainOutcome: outcome,
    channelDrainInflight: true,
    channelDrainInflightSince: Date.now()
  };
}

test("channel drain: the completed outcome is consumed only after its heartbeat record is durable", async () => {
  // #3927 R4: drainChannelBacklog used to null the stash as it read it,
  // while the durable heartbeat write landed only after the whole job
  // batch settled — a crash or a failed write in between lost the
  // outcome permanently, and the alarm retry could not recover it
  // because consumption had already happened. Now the RPC peeks and
  // recordCronTick consumes, once the record it rode in on is durable.
  const storage = memoryStorage();
  const stashed = { at: Date.now(), errors: 2 };
  const self = drainSelf({ storage, outcome: stashed });
  const tickOutcome = () => [{ job: "channel-drain", ok: false, at: Date.now(), error: "2 error(s) in tick" }];

  const first = await ProjectRoom.prototype.drainChannelBacklog.call(self);
  assert.equal(first.errors, 2);
  assert.equal(self.channelDrainOutcome, stashed, "reporting must not consume the outcome");

  const realPut = storage.put;
  storage.put = async () => { throw new Error("injected storage failure"); };
  await assert.rejects(ProjectRoom.prototype.recordCronTick.call(self, tickOutcome()), /injected storage failure/);
  storage.put = realPut;
  assert.equal(self.channelDrainOutcome, stashed, "a failed record must leave the outcome in place");

  const second = await ProjectRoom.prototype.drainChannelBacklog.call(self);
  assert.equal(second.errors, 2, "the retained outcome is reported again on the next tick");

  await ProjectRoom.prototype.recordCronTick.call(self, tickOutcome());
  assert.equal(self.channelDrainOutcome, null, "the outcome is consumed once its record is durable");
  const third = await ProjectRoom.prototype.drainChannelBacklog.call(self);
  assert.equal(third.errors, undefined, "and it is not reported a second time");
  const stored = await storage.get(HEARTBEAT_STORAGE_KEY);
  assert.equal(stored["channel-drain"].consecutiveFailures, 1, "the failure was recorded exactly once");

  // A record for other jobs never consumes an outcome nobody reported.
  const other = drainSelf({ storage: memoryStorage(), outcome: { errors: 1 } });
  await ProjectRoom.prototype.recordCronTick.call(other, [{ job: "retention", ok: true, at: Date.now() }]);
  assert.deepEqual(other.channelDrainOutcome, { errors: 1 });
});

test("channel drain: an orphaned inflight stamp keeps a successor instance from restarting the drain", async () => {
  // #3927 R3: the inflight fields are instance memory; the durable
  // stamp is all an evicted instance leaves behind. A successor that
  // finds a fresh stamp must treat the drain as still inflight — the
  // stuck clock runs from the original start, not from the eviction.
  const storage = memoryStorage();
  await storage.put(CHANNEL_DRAIN_INFLIGHT_KEY, Date.now() - 30_000);
  const self = drainSelf({ storage });
  self.channelDrainInflight = false;
  self.channelDrainInflightSince = null;
  const result = await ProjectRoom.prototype.drainChannelBacklog.call(self);
  assert.equal(result.started, 0);
  assert.equal(result.inflight, 1);
  assert.equal(result.stuck, undefined);
});

test("channel drain: terminal journal rows alone keep the job enabled (the reporting-tick invariant)", () => {
  // #3927 R1 invariant: channelPending is status-blind on purpose. A
  // completed drain's outcome is consumed by the NEXT drain tick, and
  // journal rows are never deleted — so a fully drained queue (only
  // terminal rows left) must still enable the job, or that outcome
  // would never be reported. The gate reads only store.db, so a
  // journal-only store pins the predicate exactly.
  const db = new DatabaseSync(":memory:");
  // The journal table alone: its foreign key names a parent table this
  // minimal store deliberately omits — the gate never reads it.
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec(channelJournalSchema);
  const insert = db.prepare("INSERT INTO pending_channel_updates (account_id, connection_id, update_id, received_at, payload, status, attempts, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("a1", "c1", 1, 0, "{}", "imported", 1, null, 0);
  insert.run("a1", "c1", 2, 0, "{}", "failed", 5, "parked", 0);
  const job = JOBS.find(item => item.name === "channel-drain");
  assert.equal(jobEnabled(job, {}, { db }), true, "terminal rows keep the reporting tick eligible");
  db.prepare("DELETE FROM pending_channel_updates").run();
  assert.equal(jobEnabled(job, {}, { db }), false, "only a truly empty journal disables the job");
  db.close();
});

test("scheduled() makes one safety-net call and fails the invocation when that call fails", async () => {
  const { stub, calls } = roomStub({
    ensureJobAlarm: () => Promise.reject(new Error("cron jobs failed: land-queue"))
  });
  await assert.rejects(worker.scheduled({ cron: "*/30 * * * *" }, { ROOM_MAINTENANCE: "0", ROOM: { getByName: () => stub } }, { waitUntil() {} }),
    /cron jobs failed: land-queue/);
  assert.deepEqual(calls, ["ensureJobAlarm"]);
});

test("scheduled() resolves after the safety-net call when the room is quiet", async () => {
  const { stub, calls } = roomStub();
  const env = { ROOM_MAINTENANCE: "0", ROOM_GMAIL_ENABLED: "0", ROOM: { getByName: () => stub } };
  await worker.scheduled({ cron: "*/30 * * * *" }, env, { waitUntil() {} });
  assert.deepEqual(calls, ["ensureJobAlarm"]);
});

test("gmail and channel drain stay disabled, not stale, when nothing is configured", () => {
  const directory = mkdtempSync(join(tmpdir(), "room-job-gates-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  try {
    store.initialize(initialRoom("commons"));
    // The genesis log starts tailed: the patrol is work-gated on untailed
    // events, and this test grades the gmail/channel gates, not the patrol.
    store.patrolTick();
    const now = Date.parse("2026-09-24T22:00:00Z");
    const alwaysOn = ["retention", "integrity", "public-read-model", "room-backup", "store-growth"];
    const fresh = applyOutcomes({}, alwaysOn.map(job => ({ job, ok: true, at: now, summary: { checked: 1 } })));
    // The backups binding is present in this deployment: room-backup is a
    // required job (#3894), so an unbound fixture would fail the rollup
    // by design and drown the gmail/channel gates under test here.
    const env = { ROOM_GMAIL_ENABLED: "0", ROOM_BACKUPS_KV: { async put() {}, async get() { return null; } } };
    const view = jobHealthView(fresh, now, env, store);
    const gmail = view.jobs.find(job => job.name === "gmail-sync");
    const channel = view.jobs.find(job => job.name === "channel-drain");
    assert.equal(gmail.status, "disabled");
    assert.equal(gmail.stale, false);
    assert.equal(gmail.reason, "Gmail is off");
    assert.equal(channel.status, "disabled");
    assert.equal(channel.stale, false);
    assert.equal(channel.reason, "No channel update is waiting");
    assert.equal(view.jobs.find(job => job.name === "retention").status, "ok");
    assert.equal(view.status, "ok");
    assert.equal(JSON.stringify(view).includes('"configured":false'), false);
    assert.equal(view.jobs.some(job => job.status === "unconfigured"), false);
    store.db.prepare(`INSERT INTO agent_webhook_deliveries
      (delivery_id, idempotency_key, subscription_id, agent_id, event_type, payload_json, signature, state, attempts, next_attempt_at, created_at, updated_at)
      VALUES ('del_due', 'manual:del_due', 'sub_due', 'ai_due', 'message.posted', '{}', 'sig', 'pending', 0, ?, ?, ?)`)
      .run(now, now, now);
    const waiting = jobHealthView(fresh, now, env, store).jobs.find(job => job.name === "webhook-dispatch");
    assert.equal(waiting.status, "stale");
    assert.equal(waiting.reason, null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("GET /api/health/jobs is read-only, no-store, and 503 when stale", async () => {
  // The modeled deployment has its backups binding: room-backup is a
  // required job (#3894), so without one the board could never read ok.
  const env = (stub) => ({ ROOM_ORIGIN: "https://room.example.test", ROOM: { getByName: () => stub },
    ROOM_BACKUPS_KV: { async put() {}, async get() { return null; } } });
  const { stub, self } = roomStub();
  let res = await worker.fetch(new Request("https://room.example.test/api/health/jobs"), env(stub));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal((await res.json()).status, "stale");
  await ProjectRoom.prototype.recordCronTick.call(self, CRON_JOBS.map(job => ({ job: job.name, ok: true, at: Date.now() })));
  res = await worker.fetch(new Request("https://room.example.test/api/health/jobs"), env(stub));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.schema, "room.job-health/1");
  assert.equal(body.jobs.length, CRON_JOBS.length);
  const broken = { readJobHealth: () => Promise.reject(new Error(RPC_ERROR)) };
  const error = console.error; console.error = () => {};
  try {
    res = await worker.fetch(new Request("https://room.example.test/api/health/jobs"), env(broken));
  } finally { console.error = error; }
  assert.equal(res.status, 503);
  assert.equal((await res.json()).status, "unavailable");
});

// Storage tests cover a running Node server; these cover failure before a DO
// handler exists and a rejected cross-object request at the public Worker.
test("Room request boundary contains DO failures without leaking or replaying", async () => {
  const failures = [
    () => { throw new Error("private constructor detail token=secret"); },
    () => ({ fetch() { throw new Error("private synchronous detail"); } }),
    () => ({ fetch() { return Promise.reject(new Error("private storage detail")); } }),
    () => ({ fetch(request) {
      // Execute the actual DO constructor: its storage failure happens before
      // ProjectRoom.fetch can run, so catching only there is insufficient.
      const room = new ProjectRoom({ get storage() { throw new Error("private storage detail"); } }, { ROOM_ORIGIN: "https://room.example.test" });
      return room.fetch(request);
    } })
  ];
  const origin = "https://room.example.test";
  // The HTML shell is static. A dead Durable Object must not be consulted,
  // and its private error must not reach the page.
  let shellAttempts = 0;
  const shell = await worker.fetch(new Request(origin + "/", { headers: { "CF-Connecting-IP": "192.0.2.1" } }), {
    ROOM_ORIGIN: origin,
    ROOM: { getByName() { shellAttempts += 1; throw new Error("private constructor detail token=secret"); } }
  });
  assert.equal(shellAttempts, 0);
  assert.equal(shell.status, 404);
  assert.doesNotMatch(await shell.text(), /private|secret/);
  for (const getStub of failures) for (const [method, url, json] of [
    ["HEAD", origin + "/api/version", true],
    ["GET", origin + "/api/version", true], ["POST", origin + "/api/rooms", true],
    ["GET", origin + "/room/api/version", true],
    ["GET", "https://www.getdasha.com/room/api/version", true],
    ["POST", "https://www.getdasha.com/room/mcp", true]
  ]) {
    let attempts = 0, fetches = 0;
    const env = { ROOM_ORIGIN: origin, ROOM: { getByName() {
      attempts++;
      const stub = getStub();
      return { fetch(request) { fetches++; return stub.fetch(request); } };
    } } };
    const res = await worker.fetch(new Request(url, { method, headers: { "CF-Connecting-IP": "192.0.2.1" } }), env);
    assert.equal(res.status, 503);
    assert.equal(attempts, 1);
    assert.ok(fetches <= 1, "must not replay a possibly committed mutation");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("retry-after"), "30");
    const text = await res.text();
    assert.doesNotMatch(text, /private|secret|constructor|storage detail/);
    if (method === "HEAD") { assert.equal(text, ""); continue; }
    if (json) {
      assert.match(res.headers.get("content-type"), /application\/json/);
      const body = JSON.parse(text);
      assert.equal(body.error.code, "room_unavailable");
      assert.match(body.error.message, method === "POST" ? /Check.*before repeating/ : /try again/);
    } else assert.match(text, /Project Room.*temporarily unavailable/);
  }
});

test("Room outage containment preserves guards and maintenance before DO access", async () => {
  const origin = "https://room.example.test";
  const env = { ROOM_ORIGIN: origin, ROOM: { getByName() { assert.fail("must not access DO"); } } };
  for (const [url, ip, status] of [
    ["https://wrong.example/api/version", "192.0.2.1", 403],
    [origin + "/api/version", "invalid", 403], [origin + "/api/version", "", 403],
    ["https://www.getdasha.com/roommates", "192.0.2.1", 404]
  ]) assert.equal((await worker.fetch(new Request(url, { headers: { "CF-Connecting-IP": ip } }), env)).status, status);
  const paused = await worker.fetch(new Request(origin + "/api/version"), { ...env, ROOM_MAINTENANCE: "1" });
  assert.equal(paused.status, 503);
  assert.equal((await paused.json()).error.code, "maintenance");
});

test("Room boundary passes responses through and retains trusted forwarding headers", async () => {
  const origin = "https://room.example.test";
  for (const status of [200, 401, 503]) {
    const expected = new Response("existing response", { status, headers: { "X-Test": "preserved" } });
    let calls = 0;
    const env = { ROOM_ORIGIN: origin, ROOM: { getByName() { return { async fetch(request) {
      calls++;
      assert.equal(request.headers.get("host"), "room.example.test");
      assert.equal(request.headers.get("x-room-visitor-ip"), "192.0.2.1");
      assert.equal(request.headers.get("x-real-ip"), null);
      assert.equal(request.headers.get("x-forwarded-for"), null);
      return expected;
    } }; } } };
    const response = await worker.fetch(new Request(origin + "/api/version", { headers: {
      "CF-Connecting-IP": "192.0.2.1", "X-Room-Visitor-IP": "203.0.113.1", "X-Real-IP": "203.0.113.1", "X-Forwarded-For": "203.0.113.1"
    } }), env);
    // Headers on a Response are immutable, so timing is a new response that
    // keeps the status, body, and the object's own headers.
    assert.equal(response.status, status);
    assert.equal(response.headers.get("x-test"), "preserved");
    assert.match(response.headers.get("server-timing"), /^total;dur=\d+$/);
    assert.equal(await response.text(), "existing response");
    assert.equal(calls, 1);
  }
});
