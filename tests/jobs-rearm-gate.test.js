// PERF-BUILDS P0-1 — stop the per-request job scan.
// Pins the four mechanisms:
//  (a) the DO fetch gate itself lives in cloudflare/room.mjs and is proven
//      in cloudflare/jobs-alarm.check.mjs (a read-only request arms no
//      alarm); here we pin its store-side primitive, writeStamp().
//  (b) earliestFutureAlarm never calls enabled() for a job with an
//      explicit nextDueAt, and still calls it for cadence-only jobs.
//  (c) nextDueAt results are cached per write stamp: a second arming
//      computation with no intervening write runs zero probes, and any
//      write (stamp bump) re-probes.
//  (d) the work_claims due probes run on the generated probe columns and
//      the work_claims_due_probe index, with the same answers the legacy
//      json_extract form gave.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MINUTE_MS, earliestFutureAlarm, jobByName, jobEnabled, jobNextDue } from "../server/jobs.mjs";
import { createDurableWorkClaimRegistry, ensureWorkClaimProbeColumns, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { RoomStore } from "../server/store.mjs";

const NOW = 1_800_000_000_000;

function fakeJob({ name = "fake", cadenceMs = MINUTE_MS, nextDueAt = undefined, enabled = () => true }) {
  const job = { name, cadenceMs, slow: false, runtimes: ["worker"], enabled, disabledReason: () => "off", run: async () => ({}) };
  if (nextDueAt !== undefined) job.nextDueAt = nextDueAt;
  return job;
}

test("(b) enabled() is not consulted for explicit-nextDueAt jobs, and is for cadence-only jobs", () => {
  let enabledCalls = 0, dueCalls = 0;
  const explicit = fakeJob({
    name: "explicit",
    enabled: () => { enabledCalls += 1; return true; },
    nextDueAt: () => { dueCalls += 1; return NOW + 30_000; }
  });
  const cadence = fakeJob({
    name: "cadence",
    enabled: () => { enabledCalls += 1; return true; }
  });
  const armed = earliestFutureAlarm([explicit, cadence], {
    env: {}, store: {}, now: NOW, lastRan: { cadence: NOW }, runtime: "worker"
  });
  assert.equal(armed, NOW + 30_000);
  assert.equal(dueCalls, 1);
  assert.equal(enabledCalls, 1, "only the cadence-only job's enabled() may run");
});

test("(b) registry equivalence: skipping enabled() changes no arming answer", () => {
  // For every real job with nextDueAt, enabled() is the same probe as
  // nextDueAt: across due / not-due scenarios the new path (nextDueAt as
  // the gate) must agree with the old path (enabled() AND nextDueAt).
  const scenarios = [
    { webhookDue: NOW - 5_000 }, { webhookDue: NOW + 5_000 }, {},
    { landDue: NOW - 5_000 }, { landDue: NOW + 5_000 },
    { claimDue: NOW - 5_000 }, { claimDue: NOW + 5_000 }
  ];
  const storeWith = ({ webhookDue = null, landDue = null, claimDue = null } = {}) => ({
    db: {
      prepare(sql) {
        return {
          get() {
            if (sql.includes("agent_webhook_deliveries")) return { due: webhookDue };
            if (sql.includes("MAX(rate_limited_until)")) return { until: null };
            if (sql.includes("FROM land_queue")) return landDue == null ? { due: null, n: 0 } : { due: landDue, n: 1 };
            if (sql.includes("FROM work_claims")) return claimDue == null ? { due: null, n: 0 } : { due: claimDue, n: 1 };
            return null;
          },
          all() { return []; }
        };
      }
    }
  });
  for (const name of ["webhook-dispatch", "land-queue", "claim-prs"]) {
    const job = jobByName(name);
    assert.equal(typeof job.nextDueAt, "function", name);
    for (const scenario of scenarios) {
      const store = storeWith(scenario);
      const oldAnswer = jobEnabled(job, {}, store) ? jobNextDue(job, store, NOW, 0) : null;
      const newAnswer = earliestFutureAlarm([job], { env: {}, store, now: NOW, lastRan: {}, runtime: "worker" });
      const expected = oldAnswer == null ? null
        : oldAnswer <= NOW ? NOW + 1000 : oldAnswer;
      assert.equal(newAnswer, expected, `${name} in ${JSON.stringify(scenario)}`);
    }
  }
});

test("(c) next-due cache: no re-probe until the write stamp moves", () => {
  let stamp = 0, dueCalls = 0;
  const store = { writeStamp: () => stamp };
  const job = fakeJob({
    name: "cached",
    nextDueAt: () => { dueCalls += 1; return NOW + 60_000; }
  });
  const opts = () => ({ env: {}, store, now: NOW, lastRan: {}, runtime: "worker" });
  assert.equal(earliestFutureAlarm([job], opts()), NOW + 60_000);
  assert.equal(earliestFutureAlarm([job], opts()), NOW + 60_000);
  assert.equal(dueCalls, 1, "second computation with no write between must not re-probe");
  stamp += 1; // a write landed: the cached due is invalidated
  assert.equal(earliestFutureAlarm([job], opts()), NOW + 60_000);
  assert.equal(dueCalls, 2, "a write stamp bump must re-probe");
});

test("(a) RoomStore.writeStamp counts committed writes, not reads", () => {
  // :memory: keeps this test on the store logic, not the filesystem.
  const store = new RoomStore(":memory:");
  try {
    const before = store.writeStamp();
    // Pure reads: no stamp movement.
    store.headSequence("no-such-room");
    store.db.prepare("SELECT 1").get();
    assert.equal(store.writeStamp(), before, "reads must not move the write stamp");
    // A committed write transaction moves it.
    store.transaction(() => {
      store.db.prepare("INSERT INTO work_claim_config (room_id, config_json, updated_at) VALUES (?, ?, ?)").run("r1", "{}", 1);
    });
    assert.ok(store.writeStamp() > before, "a committed write must move the write stamp");
    const afterWrite = store.writeStamp();
    // A rolled-back transaction may still move the stamp (it is a dirty
    // counter: over-reporting is safe, under-reporting is not) — but a
    // read-only transaction must not move it further.
    store.readTransaction(() => { store.db.prepare("SELECT 1").get(); });
    assert.equal(store.writeStamp(), afterWrite);
  } finally { store.close(); }
});

test("(d) generated probe columns: same due answers, index-backed plan", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  assert.equal(ensureWorkClaimProbeColumns(db), true);
  // Idempotent: a second converge is a no-op that still reports the table.
  assert.equal(ensureWorkClaimProbeColumns(db), true);
  const insert = db.prepare("INSERT INTO work_claims (room_id, claim_id, item_json, updated_at) VALUES (?, ?, ?, ?)");
  const envelope = data => JSON.stringify({ v: 1, kind: "work-claim", data });
  // Live enveloped claim due in 4 minutes.
  insert.run("room-1", "c-live", envelope({
    id: "c-live", state: "claimed", repo: "Uuriko/project-room",
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/1", nextPollAt: NOW + 240_000, outcome: null }
  }), NOW);
  // Live legacy (unenveloped) claim due sooner.
  insert.run("room-1", "c-legacy", JSON.stringify({
    id: "c-legacy", state: "in_progress", repo: "Uuriko/project-room",
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/2", nextPollAt: NOW + 60_000, outcome: null }
  }), NOW);
  // Settled claim with an outcome: never due.
  insert.run("room-1", "c-done", envelope({
    id: "c-done", state: "claimed", repo: "Uuriko/project-room",
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/3", nextPollAt: NOW - 60_000, outcome: "merged" }
  }), NOW);
  // Unclaimed claim naming a repo with no PR: the autolink probe's row.
  insert.run("room-1", "c-nopr", envelope({
    id: "c-nopr", state: "blocked", repo: "Uuriko/project-room", pullRequest: null, pullRequests: []
  }), NOW);

  const store = { db };
  const claimJob = jobByName("claim-prs");
  // claimDueAt wins over autolink: the earliest live poll is the legacy row's.
  assert.equal(claimJob.nextDueAt(store, NOW), NOW + 60_000);

  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT MIN(claim_next_poll_at) AS due, COUNT(*) AS n
    FROM work_claims
    WHERE claim_state IN ('claimed', 'in_progress', 'blocked')
      AND claim_pr_url IS NOT NULL
      AND claim_pr_outcome IS NULL`).all().map(row => row.detail).join(" | ");
  assert.match(plan, /SEARCH work_claims USING INDEX work_claims_due_probe/, `due probe must SEARCH the partial index, got: ${plan}`);

  // The claim-pr-sync due poll (same partial-index predicate shape, plus
  // the rate-limit column) must SEARCH too — it was the unconverted
  // production call site the reshape exists for.
  const pollPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT room_id, claim_id
    FROM work_claims
    WHERE claim_state IN ('claimed', 'in_progress', 'blocked')
      AND claim_pr_url IS NOT NULL
      AND claim_pr_outcome IS NULL
      AND (claim_next_poll_at IS NULL OR claim_next_poll_at <= ?)
      AND (claim_pr_rate_limited_until IS NULL OR claim_pr_rate_limited_until <= ?)
    ORDER BY claim_next_poll_at ASC LIMIT 32`).all(NOW, NOW).map(row => row.detail).join(" | ");
  assert.match(pollPlan, /SEARCH work_claims USING INDEX work_claims_due_probe/, `due poll must SEARCH the partial index, got: ${pollPlan}`);

  // The agent-identities claims-by-owner probe rides the owner index.
  const ownerPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT claim_owner
    FROM work_claims
    WHERE claim_state IN ('claimed', 'in_progress', 'blocked')
      AND claim_owner IS NOT NULL`).all().map(row => row.detail).join(" | ");
  assert.match(ownerPlan, /USING INDEX work_claims_owner_probe/, `owner probe must use its index, got: ${ownerPlan}`);
  const owners = db.prepare(`SELECT claim_owner AS owner_id FROM work_claims
    WHERE claim_state IN ('claimed', 'in_progress', 'blocked') AND claim_owner IS NOT NULL`).all();
  assert.equal(owners.length, 0, "fixture claims carry no owner field");

  // Legacy fallback: a store whose table predates the columns still
  // answers (the probe-columns check fails and the json_extract form runs).
  const legacyDb = new DatabaseSync(":memory:");
  legacyDb.exec(workClaimSchema);
  const legacyInsert = legacyDb.prepare("INSERT INTO work_claims (room_id, claim_id, item_json, updated_at) VALUES (?, ?, ?, ?)");
  legacyInsert.run("room-1", "c-live", envelope({
    id: "c-live", state: "claimed", repo: "Uuriko/project-room",
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/1", nextPollAt: NOW + 240_000, outcome: null }
  }), NOW);
  assert.equal(claimJob.nextDueAt({ db: legacyDb }, NOW), NOW + 240_000);
});

test("(e) verifySchema accepts a converged database (probe columns in stored DDL)", () => {
  // Regression pin for the reshape's CI root cause: ALTER TABLE ADD
  // COLUMN rewrites the stored CREATE TABLE text, so a database the
  // probe columns converged onto failed the strict DDL-text verify with
  // "Work-claim schema requires operator reconciliation" on every
  // reopen — unit, browser and cloudflare suites all hit it.
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db);
  assert.equal(registry.verifySchema(), true);
  assert.equal(ensureWorkClaimProbeColumns(db), true);
  assert.equal(registry.verifySchema(), true, "converged DDL must verify");
  assert.equal(registry.verifySchema({ allowAbsent: true }), true);
  // A pre-reshape non-partial due index is replaced by the partial one.
  db.exec("DROP INDEX work_claims_due_probe");
  db.exec("CREATE INDEX work_claims_due_probe ON work_claims(claim_state, claim_pr_url)");
  assert.equal(ensureWorkClaimProbeColumns(db), true);
  const indexSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='work_claims_due_probe'").get().sql;
  assert.match(indexSql, /WHERE claim_pr_url IS NOT NULL AND claim_pr_outcome IS NULL/);
  // Drift is still refused: a foreign column, or a tampered probe
  // expression, is operator reconciliation territory.
  const drifted = new DatabaseSync(":memory:");
  drifted.exec(workClaimSchema);
  drifted.exec("ALTER TABLE work_claims ADD COLUMN bogus TEXT");
  assert.throws(() => createDurableWorkClaimRegistry(drifted).verifySchema(), /operator reconciliation/);
  const tampered = new DatabaseSync(":memory:");
  tampered.exec(workClaimSchema);
  tampered.exec("ALTER TABLE work_claims ADD COLUMN claim_state TEXT GENERATED ALWAYS AS ('x') VIRTUAL");
  assert.throws(() => createDurableWorkClaimRegistry(tampered).verifySchema(), /operator reconciliation/);
});
