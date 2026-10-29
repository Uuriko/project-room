// Workerd proof for Durable Object alarms. A stub that accepts every method
// cannot show that an idle room stays asleep, or that a thrown alarm is armed again.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { createHash } from "node:crypto";

function mintProof(displayName) {
  const bucket = Math.floor(Date.now() / 600000);
  for (let i = 0; i < 1e6; i++) {
    const nonce = i.toString(36);
    if (createHash("sha256").update(`${bucket}:${displayName}:${nonce}`).digest("hex").startsWith("000")) return nonce;
  }
  throw new Error("proof search exhausted");
}

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


test("ordinary read burst coalesces alarm eligibility without changing responses", async () => {
  const mf = await start();
  const read = () => mf.dispatchFetch(origin + "/api/account-session", { headers: { "CF-Connecting-IP": "192.0.2.1" } });
  try {
    await (await read()).text(); await new Promise(resolve => setTimeout(resolve, 50));
    await call(mf, "/probe/eligibility-count");
    const replies = await Promise.all(Array.from({ length: 10 }, async () => {
      const response = await read(); assert.equal(response.status, 200);
      assert.equal((await response.json()).authenticated, false);
    }));
    assert.equal(replies.length, 10);
    await new Promise(resolve => setTimeout(resolve, 50));
    const { body } = await call(mf, "/probe/eligibility-count");
    console.log(JSON.stringify({ readBurst: 10, eligibilityEvaluations: body.count }));
    // Write-gated arming (claude/arm-after-writes): reads that write nothing
    // skip eligibility entirely, so 0 is the expected floor, not a failure.
    assert.ok(body.count >= 0 && body.count <= 2, `ten reads must share bounded eligibility work, got ${body.count}`);
  } finally { await mf.dispose(); }
});

// A read that writes no rows must not re-run earliestFutureAlarm (about 20
// statements including a full work_claims scan); a request that writes must.
test("only a request that wrote rows re-arms the job alarm", async () => {
  const mf = await start();
  const settle = () => new Promise(resolve => setTimeout(resolve, 300));
  try {
    const backfill = await call(mf, "/probe/backfill?name=arm");
    assert.equal(backfill.body.done, true, JSON.stringify(backfill.body));
    // Something must be queued, or a re-arm correctly sets no alarm at all.
    await call(mf, "/probe/seed-due?name=arm&delayMs=600000");
    await call(mf, "/probe/ensure?name=arm");
    assert.equal(typeof (await call(mf, "/probe/alarm-at?name=arm")).body.alarmAt, "number");
    // The first request after boot always arms (constructor writes are not
    // counted); spend it before measuring reads.
    await call(mf, "/probe/do-fetch?name=arm&method=GET&path=" + encodeURIComponent("/api/rooms/warm-up"));
    await settle();
    const cleared = await call(mf, "/probe/clear-alarm?name=arm");
    assert.equal(cleared.body.alarmAt, null);
    const read = await call(mf, "/probe/do-fetch?name=arm&method=GET&path=" + encodeURIComponent("/api/rooms/no-such-room"));
    assert.ok(read.body.status >= 400 && read.body.status < 500, JSON.stringify(read.body));
    await settle();
    assert.equal((await call(mf, "/probe/alarm-at?name=arm")).body.alarmAt, null, "a read-only request armed the alarm");
    const displayName = "Arm Probe";
    const bucket = Math.floor(Date.now() / 600000);
    let proof = null;
    for (let i = 0; i < 1e6 && proof === null; i++) {
      const nonce = i.toString(36);
      if (createHash("sha256").update(`${bucket}:${displayName}:${nonce}`).digest("hex").startsWith("000")) proof = nonce;
    }
    const response = await mf.dispatchFetch(origin + "/probe/do-fetch?name=arm&method=POST&path=" + encodeURIComponent("/api/agent-identities"),
      { method: "POST", body: JSON.stringify({ displayName, proof }) });
    const minted = await response.json();
    assert.equal(minted.status, 201, JSON.stringify(minted));
    await settle();
    assert.equal(typeof (await call(mf, "/probe/alarm-at?name=arm")).body.alarmAt, "number", "a writing request did not re-arm the alarm");
  } finally {
    await mf.dispose();
  }
});

// The gate only pays off if real agent traffic reads as read-only. An
// authenticated needs-me poll (the hottest agent read) must not count as a
// write: activated_at is guarded by IS NULL, so after the first request it
// changes no rows.
test("authenticated agent polls do not re-arm the job alarm", async () => {
  const mf = await start();
  const settle = () => new Promise(resolve => setTimeout(resolve, 300));
  const alarmAt = async () => (await call(mf, "/probe/alarm-at?name=poll")).body.alarmAt;
  try {
    assert.equal((await call(mf, "/probe/backfill?name=poll")).body.done, true);
    await call(mf, "/probe/seed-due?name=poll&delayMs=600000");
    await call(mf, "/probe/ensure?name=poll");
    const minted = await mf.dispatchFetch(origin + "/probe/do-fetch?name=poll&method=POST&path=" + encodeURIComponent("/api/agent-identities"),
      { method: "POST", body: JSON.stringify({ displayName: "Poll Probe", proof: mintProof("Poll Probe") }) }).then(response => response.json());
    assert.equal(minted.status, 201, JSON.stringify(minted));
    const { secret } = JSON.parse(minted.body);
    assert.equal(typeof secret, "string");
    const poll = () => mf.dispatchFetch(origin + "/probe/do-fetch?name=poll&method=GET&path=" + encodeURIComponent("/api/needs-me"),
      { headers: { authorization: `Bearer ${secret}` } }).then(response => response.json());
    // The first authenticated request may stamp activated_at once; spend it.
    assert.equal((await poll()).status, 200);
    await settle();
    await call(mf, "/probe/clear-alarm?name=poll");
    for (let i = 0; i < 3; i++) assert.equal((await poll()).status, 200);
    await settle();
    assert.equal(await alarmAt(), null, "an authenticated read-only agent poll re-armed the alarm");
  } finally {
    await mf.dispose();
  }
});

// Edge cases for write-gated arming: boot, a refused command, a read racing a write.
test("write-gated arming: first request after boot, refused command, read racing a write", async () => {
  const mf = await start();
  const settle = () => new Promise(resolve => setTimeout(resolve, 300));
  const alarmAt = async name => (await call(mf, `/probe/alarm-at?name=${name}`)).body.alarmAt;
  const readPath = "/probe/do-fetch?method=GET&path=" + encodeURIComponent("/api/rooms/no-such-room");
  const mint = (name, body) => mf.dispatchFetch(origin + `/probe/do-fetch?name=${name}&method=POST&path=` + encodeURIComponent("/api/agent-identities"),
    { method: "POST", body: JSON.stringify(body) }).then(response => response.json());
  const prime = async name => {
    assert.equal((await call(mf, `/probe/backfill?name=${name}`)).body.done, true);
    await call(mf, `/probe/seed-due?name=${name}&delayMs=600000`);
    await call(mf, `/probe/ensure?name=${name}`);
    assert.equal((await call(mf, `/probe/clear-alarm?name=${name}`)).body.alarmAt, null);
  };
  try {
    // Boot: the object's very first request re-arms even though it writes nothing.
    await prime("boot");
    await call(mf, readPath + "&name=boot"); await settle();
    assert.equal(typeof await alarmAt("boot"), "number", "first request after boot did not arm");

    // Refused command: validation fails before any write, so nothing re-arms.
    await prime("refused");
    await call(mf, readPath + "&name=refused"); await settle();
    await call(mf, "/probe/clear-alarm?name=refused");
    const refused = await mint("refused", { displayName: "", proof: "x" });
    assert.ok(refused.status >= 400 && refused.status < 500, JSON.stringify(refused));
    await settle();
    assert.equal(await alarmAt("refused"), null, "a refused command armed the alarm");

    // Race: a read and a write in flight together; the write still arms.
    await prime("race");
    await call(mf, readPath + "&name=race"); await settle();
    await call(mf, "/probe/clear-alarm?name=race");
    const [read, written] = await Promise.all([call(mf, readPath + "&name=race"), mint("race", { displayName: "Race Probe", proof: mintProof("Race Probe") })]);
    assert.ok(read.body.status >= 400, JSON.stringify(read.body));
    assert.equal(written.status, 201, JSON.stringify(written));
    await settle();
    assert.equal(typeof await alarmAt("race"), "number", "a write racing a read did not arm");
  } finally {
    await mf.dispose();
  }
});


for (const phase of ['boot', 'write']) {
  test(`read retries failed ${phase} alarm reconciliation without another write`, async () => {
    const mf = await start();
    const name = `retry-${phase}`;
    const route = path => `${path}?name=${name}`;
    const read = () => call(mf, route('/probe/do-fetch') + '&method=GET&path=' + encodeURIComponent('/api/rooms/no-such-room'));
    const settle = () => new Promise(resolve => setTimeout(resolve, 300));
    try {
      assert.equal((await call(mf, route('/probe/backfill'))).body.done, true);
      await call(mf, route('/probe/seed-due') + '&delayMs=600000');
      if (phase === 'write') { await read(); await settle(); }
      await call(mf, route('/probe/clear-alarm'));
      await call(mf, route('/probe/fail-alarm-read'));
      if (phase === 'boot') await read();
      else {
        const displayName = 'Retry alarm probe';
        const response = await mf.dispatchFetch(origin + route('/probe/do-fetch') + '&method=POST&path=' + encodeURIComponent('/api/agent-identities'), {
          method: 'POST', body: JSON.stringify({ displayName, proof: mintProof(displayName) })
        });
        assert.equal((await response.json()).status, 201);
      }
      await settle();
      assert.equal((await call(mf, route('/probe/alarm-read-failures'))).body.count, 1, 'injected failure actually ran');
      assert.equal((await call(mf, route('/probe/alarm-at'))).body.alarmAt, null);
      await read(); await settle();
      assert.equal(typeof (await call(mf, route('/probe/alarm-at'))).body.alarmAt, 'number', 'read must retry outstanding alarm work');
      // Once reconciliation succeeds, a later pure read can skip it again.
      await call(mf, route('/probe/clear-alarm'));
      await read(); await settle();
      assert.equal((await call(mf, route('/probe/alarm-at'))).body.alarmAt, null);
    } finally { await mf.dispose(); }
  });
}
