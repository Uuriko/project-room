import test from "node:test";
import assert from "node:assert/strict";
import { classifyRun, latestRun, waitForRun } from "../scripts/deploy-gate-wait.mjs";

const run = (status, conclusion, created = "2026-11-11T00:00:00Z", name = "schema-gate", id = 1) => ({ id, name, status, conclusion, created_at: created });

// A fake clock: sleep advances time, so no test waits for real.
function clock() {
  let t = 0;
  return { now: () => t, sleep: async ms => { t += ms; } };
}

test("classifies queued and in_progress runs as pending, not as a refusal", () => {
  assert.equal(classifyRun(run("queued", null)), "pending");
  assert.equal(classifyRun(run("in_progress", null)), "pending");
  assert.equal(classifyRun(run("completed", "success")), "success");
  for (const conclusion of ["failure", "cancelled", "timed_out", "skipped"]) assert.equal(classifyRun(run("completed", conclusion)), "failure");
  assert.equal(classifyRun(null), "missing");
});

test("takes the newest run of the named workflow only", () => {
  const picked = latestRun([run("completed", "failure", "2026-11-11T00:00:00Z", "schema-gate", 1), run("completed", "success", "2026-11-11T00:05:00Z", "schema-gate", 2), run("completed", "failure", "2026-11-11T00:09:00Z", "test", 3)], "schema-gate");
  assert.equal(picked.id, 2);
});

test("an in-progress schema-gate that finishes inside the window becomes success (the e92ded22 refusal)", async () => {
  const { now, sleep } = clock();
  let polls = 0;
  const list = async () => (++polls < 4 ? [run("in_progress", null)] : [run("completed", "success")]);
  const out = await waitForRun({ list, now, sleep, pollMs: 10000 });
  assert.equal(out.state, "success");
  assert.equal(polls, 4);
  assert.equal(out.waitedMs, 30000);
});

test("a run that finishes red is reported at once, without waiting out the window", async () => {
  const { now, sleep } = clock();
  let polls = 0;
  const list = async () => (++polls < 2 ? [run("queued", null)] : [run("completed", "failure")]);
  const out = await waitForRun({ list, now, sleep, pollMs: 10000 });
  assert.equal(out.state, "failure");
  assert.equal(out.waitedMs, 10000);
});

test("still pending at the timeout stays pending, so the gate can refuse with the real reason", async () => {
  const { now, sleep } = clock();
  const out = await waitForRun({ list: async () => [run("in_progress", null)], now, sleep, timeoutMs: 60000, pollMs: 25000 });
  assert.equal(out.state, "pending");
  assert.equal(out.waitedMs, 60000);
});

test("a commit with no schema-gate run gives up after the short missing grace, not the full window", async () => {
  const { now, sleep } = clock();
  const out = await waitForRun({ list: async () => [], now, sleep, timeoutMs: 300000, pollMs: 10000, missingGraceMs: 30000 });
  assert.equal(out.state, "missing");
  assert.equal(out.waitedMs, 30000);
});

test("a run that registers late is still picked up inside the missing grace", async () => {
  const { now, sleep } = clock();
  let polls = 0;
  const list = async () => (++polls < 3 ? [] : [run("completed", "success")]);
  const out = await waitForRun({ list, now, sleep, pollMs: 5000, missingGraceMs: 30000 });
  assert.equal(out.state, "success");
});
