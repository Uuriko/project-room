import test from "node:test";
import assert from "node:assert/strict";
import { probeProd } from "../scripts/probe-prod-lib.mjs";

const AT = "2026-10-24T14:53:42.728Z";
const BEFORE = "2026-10-24T13:53:42.728Z";
const view = jobs => ({ schema: "room.job-health/1", status: "failing", generatedAt: AT, jobs });

async function receipt(t, value) {
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(new URL(url).origin, "https://diagnostic.example.test");
    const path = new URL(url).pathname;
    if (path === "/api/health/jobs") return Response.json(value, { status: ["ok", "degraded"].includes(value.status) ? 200 : 503 });
    if (path === "/api/version") return Response.json({ status: "ok", sourceRevision: "a".repeat(40) });
    if (path === "/api/health") return Response.json({ status: "ok" });
    if (["/", "/join"].includes(path)) return new Response("<html>synthetic fixture</html>");
    throw new Error(`Unexpected fixture URL: ${url}`);
  });
  const report = await probeProd("https://diagnostic.example.test");
  assert.equal(report.verdict, "healthy");
  return report.jobsHealth;
}

test("receipt retains failing job evidence without changing the aggregate verdict", async t => {
  const report = await receipt(t, view([{
    name: "integrity", status: "failing", lastRunAt: AT, lastSuccessAt: BEFORE,
    lastErrorAt: AT, lastErrorCurrent: true, consecutiveFailures: 4,
    periodSeconds: 3600, staleAfterSeconds: 10800, secondsSinceSuccess: 3600,
    lastDurationMs: 17, lastErrorCode: "integrity_check_failed", lastErrorSubcheck: "unknown",
    lastErrorClass: "validation", lastErrorRecordClass: "room", required: false,
    lastSummary: { checked: 3, errors: 1 }, lastSummaryAt: AT
  }]));
  assert.equal(report.status, "failing");
  assert.deepEqual(report.failing, ["integrity"]);
  assert.equal(report.generatedAt, AT);
  assert.deepEqual(report.jobs[0], {
    name: "integrity", status: "failing", lastRunAt: AT, lastSuccessAt: BEFORE,
    lastErrorAt: AT, lastSummaryAt: AT, periodSeconds: 3600, staleAfterSeconds: 10800,
    secondsSinceSuccess: 3600, consecutiveFailures: 4, lastDurationMs: 17,
    lastErrorCurrent: true, required: false, lastErrorCode: "integrity_check_failed",
    lastErrorSubcheck: "unknown", lastErrorClass: "validation", lastErrorRecordClass: "room",
    degraded: null, lastSummary: { checked: 3, errors: 1 }
  });
});

test("a later successful outcome keeps historical error metadata noncurrent", async t => {
  const report = await receipt(t, { ...view([{
    name: "claim-prs", status: "ok", lastRunAt: AT, lastSuccessAt: AT,
    lastErrorAt: BEFORE, lastError: "old private error", lastErrorCurrent: false,
    consecutiveFailures: 0, lastSummary: { checked: 1 }, lastSummaryAt: AT
  }]), status: "ok" });
  assert.deepEqual(report.failing, []);
  assert.equal(report.jobs[0].status, "ok");
  assert.equal(report.jobs[0].lastErrorCurrent, false);
  assert.equal(report.jobs[0].consecutiveFailures, 0);
  assert.equal(report.jobs[0].lastErrorAt, BEFORE);
  assert.equal(report.jobs[0].lastSuccessAt, AT);
  assert.equal(JSON.stringify(report).includes("old private error"), false);
});

test("an old summary retains its own timestamp rather than borrowing the failed run time", async t => {
  const report = await receipt(t, view([{
    name: "integrity", status: "failing", lastRunAt: AT, lastErrorAt: AT,
    lastSummary: { checked: 5 }, lastSummaryAt: BEFORE
  }]));
  const job = report.jobs[0];
  assert.equal(job.lastRunAt, AT);
  assert.equal(job.lastSummaryAt, BEFORE);
  assert.equal(job.lastErrorCurrent, null, "missing old-version fields remain unknown");
});

test("healthy and disabled required jobs remain visible without inventing completion", async t => {
  const report = await receipt(t, view([
    { name: "room-backup", status: "disabled", required: true },
    { name: "retention", status: "ok", lastSuccessAt: AT, lastRunAt: AT }
  ]));
  assert.equal(report.status, "failing");
  assert.deepEqual(report.failing, [], "legacy failing-name rollup remains compatible");
  assert.equal(report.jobs[0].required, true);
  assert.equal(report.jobs[0].status, "disabled");
  assert.equal(report.jobs[0].lastSuccessAt, null);
  assert.equal(report.jobs[1].lastSuccessAt, AT);
});

test("diagnostics drop arbitrary text, ids, nested objects and invalid scalar values", async t => {
  const report = await receipt(t, view([{
    name: "integrity", status: "failing", lastError: "authorization=private-secret",
    recordId: "private-room", reason: "private contents", lastErrorCode: "bad code private-secret",
    lastErrorSubcheck: "x".repeat(65), lastErrorClass: "https://private.example/token",
    lastErrorRecordClass: { id: "private-room" }, lastErrorCurrent: "true", required: 1,
    consecutiveFailures: Infinity, lastDurationMs: -1, secondsSinceSuccess: "5",
    lastRunAt: "2026-02-30T00:00:00.000Z", lastSuccessAt: "private-secret",
    lastSummary: { checked: 3, recovered: false, token: "private-secret", nested: { recordId: "private-room" },
      notFinite: NaN, infinite: Infinity, "bad-key": 2, ["k".repeat(42)]: 4 }
  }]));
  const job = report.jobs[0];
  for (const key of ["lastErrorCode", "lastErrorSubcheck", "lastErrorClass", "lastErrorRecordClass", "lastErrorCurrent", "required",
    "consecutiveFailures", "lastDurationMs", "secondsSinceSuccess", "lastRunAt", "lastSuccessAt"]) assert.equal(job[key], null, key);
  assert.deepEqual(job.lastSummary, { checked: 3, recovered: false });
  assert.doesNotMatch(JSON.stringify(report), /private-secret|private-room|private contents|private\.example|recordId/);
});

test("diagnostic job and summary counts are bounded, and malformed entries are skipped", async t => {
  const summaries = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`count${i}`, i]));
  const report = await receipt(t, view([null, 2, {}, { name: "bad name" },
    ...Array.from({ length: 80 }, (_, i) => ({ name: `job-${i}`, status: "ok", lastSummary: summaries }))]));
  assert.equal(report.jobs.length, 64);
  assert.equal(report.jobs[0].name, "job-0");
  assert.equal(Object.keys(report.jobs[0].lastSummary).length, 12);
});

test("missing or malformed optional metadata remains unknown", async t => {
  const report = await receipt(t, { ...view([{ name: "integrity", status: "unexpected", lastSummary: [] }]), generatedAt: "invalid" });
  assert.equal(report.generatedAt, null);
  assert.equal(report.jobs[0].status, null);
  assert.equal(report.jobs[0].lastSummary, null);
});

for (const status of ["failing", "stale", "degraded"]) {
  test(`mocked probe includes diagnostic evidence and keeps ${status} separate from site health`, async t => {
    const calls = [];
    t.mock.method(globalThis, "fetch", async url => {
      calls.push(url);
      const path = new URL(url).pathname;
      if (path === "/api/health/jobs") return Response.json({ ...view([{
        name: "integrity", status, lastRunAt: AT, lastErrorCurrent: true,
        consecutiveFailures: 2, lastSummaryAt: BEFORE, lastSummary: { checked: 4 }
      }]), status }, { status: status === "degraded" ? 200 : 503 });
      if (path === "/api/version") return Response.json({ status: "ok", sourceRevision: "a".repeat(40) });
      if (path === "/api/health") return Response.json({ status: "ok" });
      if (["/", "/join"].includes(path)) return new Response("<html>synthetic fixture</html>");
      throw new Error(`Unexpected fixture URL: ${url}`);
    });
    const report = await probeProd("https://diagnostic.example.test");
    assert.equal(report.verdict, "healthy");
    assert.equal(report.jobsHealth.status, status);
    assert.deepEqual(report.jobsHealth.failing, ["integrity"]);
    assert.equal(report.jobsHealth.jobs[0].lastRunAt, AT);
    assert.equal(report.jobsHealth.jobs[0].lastSummaryAt, BEFORE);
    assert.equal(calls.length, 5, "diagnostics reuse the existing response, with no extra requests");
    assert.ok(calls.every(url => url.startsWith("https://diagnostic.example.test/")));
  });
}

test("mocked outage remains an outage, without invented per-job evidence", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    const path = new URL(url).pathname;
    if (path === "/api/health/jobs") return Response.json({ schema: "room.job-health/1", status: "unavailable", jobs: [] }, { status: 503 });
    if (["/", "/join", "/api/version", "/api/health"].includes(path)) return new Response("Unavailable", { status: 503 });
    throw new Error(`Unexpected fixture URL: ${url}`);
  });
  const report = await probeProd("https://diagnostic.example.test");
  assert.equal(report.verdict, "do-rpc-fail");
  assert.equal(report.jobsHealth.status, "unavailable");
  assert.deepEqual(report.jobsHealth.jobs, []);
});
