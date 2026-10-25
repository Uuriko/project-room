// Workerd proof for Durable Object alarms. A stub that accepts every method
// cannot show that an idle room stays asleep, or that a thrown alarm is armed again.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const origin = "https://room.example.test";

async function start() {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("./jobs-alarm.test-fixture.mjs", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "neutral",
    external: ["node:*", "cloudflare:*"]
  });
  return new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ROOM: { className: "JobsProbe", useSQLite: true } },
    // The modeled deployment has its backups binding: room-backup is a
    // required job (#3894), so without one the health board would fail
    // by design and drown the alarm behavior under test here.
    kvNamespaces: ["ROOM_BACKUPS_KV"],
    bindings: { ROOM_ORIGIN: origin, ROOM_MAINTENANCE: "0", ROOM_GMAIL_ENABLED: "0" }
  });
}

async function call(mf, path) {
  const response = await mf.dispatchFetch(origin + path);
  const body = await response.json();
  return { status: response.status, body };
}

test("scheduled() leaves gmail and channel drain disabled when nothing is waiting", async () => {
  const mf = await start();
  try {
    const scheduled = await call(mf, "/scheduled");
    assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
    assert.equal(scheduled.body.counts.gmailRuns, 0);
    assert.equal(scheduled.body.counts.channelRuns, 0);
    const health = await mf.dispatchFetch(origin + "/api/health/jobs");
    assert.equal(health.status, 200, await health.clone().text());
    const view = await health.json();
    assert.equal(view.status, "ok");
    for (const name of ["gmail-sync", "channel-drain"]) {
      const job = view.jobs.find(item => item.name === name);
      assert.equal(job.status, "disabled", name);
      assert.equal(job.stale, false, name);
      assert.equal(typeof job.reason, "string", name);
    }
    assert.equal(JSON.stringify(view).includes('"configured":false'), false);
  } finally {
    await mf.dispose();
  }
});

test("an idle room arms no alarm inside a 10 minute window", async () => {
  const mf = await start();
  try {
    const backfill = await call(mf, "/probe/backfill?name=idle");
    assert.equal(backfill.status, 200, JSON.stringify(backfill.body));
    assert.equal(backfill.body.done, true);
    const ensured = await call(mf, "/probe/ensure?name=idle");
    assert.equal(ensured.status, 200, JSON.stringify(ensured.body));
    const armed = await call(mf, "/probe/alarm-at?name=idle");
    const alarmAt = armed.body.alarmAt;
    const horizon = Date.now() + 10 * 60 * 1000;
    const fires = alarmAt != null && alarmAt <= horizon ? 1 : 0;
    assert.equal(fires, 0, `alarm at ${alarmAt} would wake inside 10 minutes`);
  } finally {
    await mf.dispose();
  }
});

test("a webhook due in 30 seconds waits for the alarm", { timeout: 60_000 }, async () => {
  const mf = await start();
  try {
    const seeded = await call(mf, "/probe/seed-due?name=due&delayMs=30000");
    assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
    const ensured = await call(mf, "/probe/ensure?name=due");
    assert.equal(ensured.status, 200, JSON.stringify(ensured.body));
    const armed = await call(mf, "/probe/alarm-at?name=due");
    assert.equal(typeof armed.body.alarmAt, "number");
    assert.ok(Math.abs(armed.body.alarmAt - seeded.body.due) < 1000, `alarm ${armed.body.alarmAt} due ${seeded.body.due}`);
    const early = await call(mf, "/probe/alarm?name=due");
    assert.equal(early.status, 200, JSON.stringify(early.body));
    const pending = await call(mf, "/probe/delivery?name=due&id=del_due");
    assert.equal(pending.body.state, "pending");
    const wait = Math.max(0, seeded.body.due - Date.now() + 50);
    await new Promise(resolve => setTimeout(resolve, wait));
    const fired = await call(mf, "/probe/alarm?name=due");
    assert.equal(fired.status, 200, JSON.stringify(fired.body));
    const after = await call(mf, "/probe/delivery?name=due&id=del_due");
    assert.equal(after.body.state, "dead_letter");
    assert.notEqual(after.body.state, "pending");
  } finally {
    await mf.dispose();
  }
});

test("a thrown alarm is rescheduled", async () => {
  const mf = await start();
  try {
    const seeded = await call(mf, "/probe/seed-throw?name=boom");
    assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
    const before = Date.now();
    const fired = await call(mf, "/probe/alarm?name=boom");
    assert.equal(fired.status, 500, JSON.stringify(fired.body));
    assert.match(fired.body.error, /cron jobs failed: webhook-dispatch/);
    assert.equal(typeof fired.body.alarmAt, "number");
    assert.ok(fired.body.alarmAt >= before + 50_000, `alarm ${fired.body.alarmAt} before ${before}`);
    assert.ok(fired.body.alarmAt <= Date.now() + 70_000);
    const webhook = fired.body.health.jobs.find(job => job.name === "webhook-dispatch");
    assert.ok(webhook.consecutiveFailures >= 1);
    assert.notEqual(webhook.status, "ok");
    // The throw is armed by the fixture, not planted as a malformed
    // delivery row: #3893 made the drain isolate such rows (dead-letter,
    // job stays healthy), so a JSON.parse error can no longer be this
    // check's throw vehicle. The subject is the alarm machinery.
    assert.match(webhook.lastError, /seeded webhook drain failure/);
  } finally {
    await mf.dispose();
  }
});

async function pollDrainState(mf, name, predicate) {
  let state;
  for (let attempt = 0; attempt < 50; attempt++) {
    state = await call(mf, `/probe/drain-state?name=${name}`);
    assert.equal(state.status, 200, JSON.stringify(state.body));
    if (predicate(state.body)) return state.body;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return state.body;
}

test("channel drain: an outcome is consumed only after its tick is recorded (#3927 R4)", async () => {
  const mf = await start();
  try {
    await call(mf, "/probe/seed-drain?name=drain-consume");
    const started = await call(mf, "/probe/drain-tick?name=drain-consume");
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.started, 1);
    // The background drain finishes: outcome stashed, inflight stamp gone.
    const stashed = await pollDrainState(mf, "drain-consume", state => state.outcomeAt !== null);
    assert.ok(stashed.outcomeAt !== null, "background drain stashed its outcome");
    assert.equal(stashed.stamp, null, "the inflight stamp is deleted when the drain ends");
    // A bare reporting tick carries the outcome but must not consume it:
    // consumption waits for the durable heartbeat record (recordCronTick).
    const reported = await call(mf, "/probe/drain-tick?name=drain-consume");
    assert.equal(reported.status, 200, JSON.stringify(reported.body));
    assert.ok("screened" in reported.body, "the tick reported the completed drain's outcome");
    const afterReport = await call(mf, "/probe/drain-state?name=drain-consume");
    assert.equal(afterReport.body.outcomeAt, stashed.outcomeAt, "reporting alone does not consume the outcome");
    // The recording tick consumes exactly that outcome: afterwards the
    // stash holds a different (queued or later) outcome, or none.
    const recorded = await call(mf, "/probe/drain-tick-record?name=drain-consume");
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
    assert.equal(recorded.body[0].ok, true);
    const afterRecord = await call(mf, "/probe/drain-state?name=drain-consume");
    assert.notEqual(afterRecord.body.outcomeAt, stashed.outcomeAt, "the recorded outcome was consumed exactly once");
  } finally {
    await mf.dispose();
  }
});

test("channel drain: an orphaned inflight stamp keeps the stuck clock (#3927 R3)", async () => {
  const mf = await start();
  try {
    await call(mf, "/probe/seed-drain?name=drain-orphan");
    // A successor instance finding a 30s-old stamp treats the drain as
    // still inflight — no restart, no stuck report yet.
    await call(mf, "/probe/seed-orphan?name=drain-orphan&ageMs=30000");
    const recent = await call(mf, "/probe/drain-tick?name=drain-orphan");
    assert.equal(recent.status, 200, JSON.stringify(recent.body));
    assert.equal(recent.body.started, 0);
    assert.equal(recent.body.inflight, 1);
    assert.equal(recent.body.stuck, undefined);
    // Past the 120s bound the wedge is reported as a failure AND a
    // replacement drain starts (the orphaned one will never complete);
    // the replacement finishing clears the stamp.
    await call(mf, "/probe/seed-orphan?name=drain-orphan&ageMs=121000");
    const wedged = await call(mf, "/probe/drain-tick?name=drain-orphan");
    assert.equal(wedged.status, 200, JSON.stringify(wedged.body));
    assert.equal(wedged.body.stuck, 1);
    assert.equal(wedged.body.scanError, "channel_drain_stuck");
    const settled = await pollDrainState(mf, "drain-orphan", state => state.outcomeAt !== null && state.stamp === null);
    assert.ok(settled.outcomeAt !== null, "the replacement drain completed");
    assert.equal(settled.stamp, null, "the replacement drain cleared the stamp");
  } finally {
    await mf.dispose();
  }
});
