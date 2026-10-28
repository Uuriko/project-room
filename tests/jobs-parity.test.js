// Node and the Worker read one registry. A job that runs on only one of
// them has to say why. Shared jobs keep one cadence.
import test from "node:test";
import assert from "node:assert/strict";
import { JOB_BUDGET_MS, JOBS, jobsFor } from "../server/jobs.mjs";
import { CRON_JOB_BUDGET_MS, runCronJobs } from "../cloudflare/job-heartbeat.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

test("node and worker job names match aside from single-runtime jobs", () => {
  const node = new Map(jobsFor("node").map(job => [job.name, job.cadenceMs]));
  const worker = new Map(jobsFor("worker").map(job => [job.name, job.cadenceMs]));
  const onlyNode = [...node.keys()].filter(name => !worker.has(name));
  const onlyWorker = [...worker.keys()].filter(name => !node.has(name));
  assert.deepEqual(onlyNode, ["growth-watch"]);
  assert.deepEqual(onlyWorker, ["room-backup"]);
  for (const name of [...onlyNode, ...onlyWorker]) {
    const job = JOBS.find(item => item.name === name);
    assert.equal(job.runtimes.length, 1);
    assert.equal(typeof job.singleRuntimeReason, "string");
    assert.ok(job.singleRuntimeReason.length > 20, name);
  }
  for (const [name, cadence] of node) {
    if (!worker.has(name)) continue;
    assert.equal(worker.get(name), cadence, name);
    assert.ok(cadence > 0, name);
  }
  const names = JOBS.map(job => job.name);
  assert.equal(new Set(names).size, names.length);
  for (const required of ["webhook-dispatch", "land-queue", "claim-prs", "retention", "integrity", "gmail-sync", "channel-drain", "growth-watch"]) {
    assert.ok(names.includes(required), required);
  }
});

// #4061: the Worker runner shape, executed — not just the registry read.
// cloudflare/room.mjs #runDueJobs builds runners as
// job.run(store, { deadline, env, room, now }) and hands them to
// runCronJobs. Doing exactly that here pins that the ctx.room shortcut
// cannot skip the claim-prs autolink follow-ups: before the fix this
// returned the poll receipt with no autolink block at all, because the
// follow-ups lived only in the job body's non-room branch.
test("worker runner shape: claim-prs runs the autolink follow-ups after the room poll", async (t) => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const job = jobsFor("worker").find(item => item.name === "claim-prs");
  assert.ok(job);
  const room = { refreshClaimPullRequests: async () => ({ checked: 2, updated: 1 }) };
  let result = null;
  const runners = {
    [job.name]: () => job.run(store, {
      deadline: Date.now() + (job.budgetMs ?? CRON_JOB_BUDGET_MS),
      env: {}, room, now: () => Date.now()
    }).then(value => { result = value; return value; })
  };
  const outcomes = await runCronJobs(runners, { log: () => {}, yieldTurn: () => Promise.resolve() });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].ok, true);
  // The poll receipt survives and both follow-ups ran against the store:
  // discovery saw no candidate claims, and deploy linking reported its
  // unstamped skip — the in-repo SOURCE_REVISION is the placeholder, the
  // same result the Node branch produces — under the shared try/catch.
  assert.equal(result.checked, 2);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.autolink, {
    discovered: { repos: 0, pulls: 0, linked: [] },
    deployed: { linked: 0, skipped: "unstamped" }
  });
});

test("worker runner shape: a failing autolink follow-up never fails the room poll", async () => {
  const job = jobsFor("worker").find(item => item.name === "claim-prs");
  assert.ok(job);
  // Discovery reads the claim rows first; a store whose reads throw a
  // generic error makes the follow-up throw inside the job's guard (the
  // Node branch's isolation, now shared).
  const store = {
    db: { prepare() { throw new Error("follow-up boom"); } },
    workClaims: {}
  };
  const room = { refreshClaimPullRequests: async () => ({ checked: 3, updated: 1 }) };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  let result;
  try {
    result = await job.run(store, {
      deadline: Date.now() + job.budgetMs, env: {}, room, now: () => Date.now()
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(result, { checked: 3, updated: 1 });
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /claim autolink follow-up failed/);
});

test("node shape: claim-prs without ctx.room keeps the poll + follow-up result shape", async (t) => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const job = jobsFor("node").find(item => item.name === "claim-prs");
  assert.ok(job);
  const result = await job.run(store, {
    env: {}, deadline: Date.now() + job.budgetMs, now: () => Date.now()
  });
  assert.equal(result.checked, 0);
  assert.equal(result.updated, 0);
  assert.deepEqual(result.autolink, {
    discovered: { repos: 0, pulls: 0, linked: [] },
    deployed: { linked: 0, skipped: "unstamped" }
  });
});

test("node and worker derive the per-job budget from one constant", () => {
  // #3767: the 5s budget lived in two independent constants with nothing
  // pinning them equal. The Worker name now derives from the registry
  // value; this pin catches a future edit that re-splits them.
  assert.ok(JOB_BUDGET_MS > 0);
  assert.equal(CRON_JOB_BUDGET_MS, JOB_BUDGET_MS);
});
