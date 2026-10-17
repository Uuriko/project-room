// Operator status surface: the composed deployment/jobs read. Every tile
// must render its honest state for healthy, failing, and never-ran records
// — a fact the records do not hold comes back as an explicit not-recorded
// state, never as a plausible-looking zero.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { JOBS } from "../server/jobs.mjs";
import { SOURCE_REVISION } from "../server/version.mjs";
import { createOperatorRoutes } from "../server/operator-routes.mjs";
import {
  buildStatusSurface, collectStatusSurface, readWorkerDoorRevision
} from "../server/operator-status-surface.mjs";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const ISO = ms => new Date(ms).toISOString();

function workerRecord(name, overrides = {}) {
  return {
    name, periodSeconds: 300, staleAfterSeconds: 900,
    lastRunAt: ISO(NOW - 60_000), lastStartedAt: ISO(NOW - 60_000),
    lastFinishedAt: ISO(NOW - 59_000), lastSuccessAt: ISO(NOW - 60_000),
    lastErrorAt: null, lastError: null, lastErrorCode: null, lastFailure: null,
    consecutiveFailures: 0, lastDurationMs: 900, lastSummary: null,
    lastSummaryAt: ISO(NOW - 60_000), stale: false, degraded: false, status: "ok",
    ...overrides
  };
}
const healthyJobs = { source: "worker-heartbeat", jobs: JOBS.map(job => workerRecord(job.name)) };

describe("jobs tile", () => {
  test("healthy: every registered job renders ok with its timestamps", () => {
    const surface = buildStatusSurface({ jobs: healthyJobs, now: NOW });
    assert.equal(surface.jobs.source, "worker-heartbeat");
    assert.equal(surface.jobs.rows.length, JOBS.length);
    for (const row of surface.jobs.rows) {
      assert.equal(row.state, "ok", row.name);
      assert.equal(row.lastSuccessAt, ISO(NOW - 60_000), row.name);
      assert.equal(row.consecutiveFailures, 0, row.name);
    }
  });

  test("failing: consecutive failures and the stable failure code survive", () => {
    const jobs = { source: "worker-heartbeat", jobs: [
      workerRecord("integrity", {
        status: "failing", consecutiveFailures: 77,
        lastSuccessAt: "2026-10-11T19:30:55.000Z", lastErrorAt: ISO(NOW - 3_600_000),
        lastError: "integrity check failed in messages_parity (record: room)",
        lastFailure: { code: "integrity_failed", subcheck: "messages_parity", errorClass: "data", recordClass: "room" }
      })
    ] };
    const surface = buildStatusSurface({ jobs, now: NOW });
    const row = surface.jobs.rows.find(candidate => candidate.name === "integrity");
    assert.equal(row.state, "failing");
    assert.equal(row.consecutiveFailures, 77);
    assert.equal(row.lastErrorCode, "integrity_failed");
    assert.equal(row.lastErrorSubcheck, "messages_parity");
    assert.equal(surface.jobs.rows.filter(candidate => candidate.state === "not-recorded").length, JOBS.length - 1);
  });

  test("never-ran: no runtime records renders every row not-recorded with a reason", () => {
    const surface = buildStatusSurface({ jobs: null, now: NOW });
    assert.equal(surface.jobs.source, "none");
    for (const row of surface.jobs.rows) {
      assert.equal(row.state, "not-recorded", row.name);
      assert.equal(row.lastRunAt, null, row.name);
      assert.ok(typeof row.reason === "string" && row.reason.length > 0, row.name);
    }
  });

  test("node records: disabled, ok, and failing derive without a graded status", () => {
    const jobs = [
      { name: "room-backup", runtime: "worker", enabled: false, reason: "Runs on the Worker only", periodSeconds: 86_400,
        lastRunAt: null, lastSuccessAt: null, lastErrorAt: null, lastError: null, consecutiveFailures: 0, lastDurationMs: null, lastSummaryAt: null },
      { name: "gmail-sync", runtime: "node", enabled: true, reason: null, periodSeconds: 300,
        lastRunAt: NOW - 60_000, lastSuccessAt: NOW - 60_000, lastErrorAt: null, lastError: null, consecutiveFailures: 0, lastDurationMs: 42, lastSummaryAt: NOW - 60_000 },
      { name: "claim-prs", runtime: "node", enabled: true, reason: null, periodSeconds: 300,
        lastRunAt: NOW - 60_000, lastSuccessAt: NOW - 3_600_000, lastErrorAt: NOW - 60_000, lastError: "sync failed", consecutiveFailures: 2, lastDurationMs: 42, lastSummaryAt: NOW - 60_000 }
    ];
    const surface = buildStatusSurface({ jobs, now: NOW });
    const byName = new Map(surface.jobs.rows.map(row => [row.name, row]));
    assert.equal(byName.get("room-backup").state, "disabled");
    assert.equal(byName.get("gmail-sync").state, "ok");
    assert.equal(byName.get("gmail-sync").lastRunAt, ISO(NOW - 60_000));
    assert.equal(byName.get("claim-prs").state, "failing");
    assert.equal(byName.get("claim-prs").consecutiveFailures, 2);
  });
});

describe("deployment tile", () => {
  test("converged when the worker door reports this process's revision", () => {
    const surface = buildStatusSurface({ jobs: healthyJobs, workerDoorRevision: SOURCE_REVISION, now: NOW });
    assert.equal(surface.deployment.doors.do, SOURCE_REVISION);
    assert.equal(surface.deployment.doors.worker, SOURCE_REVISION);
    assert.equal(surface.deployment.doors.state, "converged");
    assert.equal(surface.deployment.doors.checkedAt, ISO(NOW));
  });

  test("diverged when the worker door reports a different revision", () => {
    const surface = buildStatusSurface({ jobs: healthyJobs, workerDoorRevision: "0123abc", now: NOW });
    assert.equal(surface.deployment.doors.state, "diverged");
  });

  test("unknown when the worker door cannot be read — never a guessed revision", () => {
    const surface = buildStatusSurface({ jobs: healthyJobs, workerDoorRevision: null, now: NOW });
    assert.equal(surface.deployment.doors.worker, null);
    assert.equal(surface.deployment.doors.state, "unknown");
  });

  test("readWorkerDoorRevision reads the revision and fails closed to null", async () => {
    const ok = async () => ({ ok: true, json: async () => ({ sourceRevision: "deadbeef" }) });
    assert.equal(await readWorkerDoorRevision("https://example.test/", { fetchImpl: ok }), "deadbeef");
    const notOk = async () => ({ ok: false, json: async () => ({}) });
    assert.equal(await readWorkerDoorRevision("https://example.test", { fetchImpl: notOk }), null);
    const boom = async () => { throw new Error("network down"); };
    assert.equal(await readWorkerDoorRevision("https://example.test", { fetchImpl: boom }), null);
    assert.equal(await readWorkerDoorRevision(null, { fetchImpl: ok }), null);
    assert.equal(await readWorkerDoorRevision("", { fetchImpl: ok }), null);
  });
});

describe("claim-prs tile", () => {
  test("recorded skipped count from the last summary", () => {
    const jobs = { source: "worker-heartbeat", jobs: [workerRecord("claim-prs", { lastSummary: { synced: 9, skippedInvalid: 4 } })] };
    const surface = buildStatusSurface({ jobs, now: NOW });
    assert.equal(surface.claimPrs.state, "recorded");
    assert.equal(surface.claimPrs.skippedInvalid, 4);
    assert.equal(surface.claimPrs.at, ISO(NOW - 60_000));
  });

  test("not recorded when the runtime keeps no summary body", () => {
    const jobs = [{ name: "claim-prs", runtime: "node", enabled: true, reason: null, periodSeconds: 300,
      lastRunAt: NOW, lastSuccessAt: NOW, lastErrorAt: null, lastError: null, consecutiveFailures: 0, lastDurationMs: 1, lastSummaryAt: NOW }];
    const surface = buildStatusSurface({ jobs, now: NOW });
    assert.equal(surface.claimPrs.state, "not-recorded");
    assert.equal(surface.claimPrs.skippedInvalid, null);
    assert.ok(surface.claimPrs.reason.length > 0);
  });
});

describe("collectStatusSurface", () => {
  test("resolves async providers into one model", async () => {
    const surface = await collectStatusSurface({
      now: NOW,
      providers: {
        origin: "https://example.test",
        deployment: "production",
        jobHealthSource: "worker-heartbeat",
        jobHealth: async () => ({ jobs: [workerRecord("gmail-sync")] }),
        workerDoorRevision: async () => SOURCE_REVISION
      }
    });
    assert.equal(surface.schema, "room.operator-status/1");
    assert.equal(surface.generatedAt, ISO(NOW));
    assert.equal(surface.jobs.source, "worker-heartbeat");
    assert.equal(surface.jobs.rows.find(row => row.name === "gmail-sync").state, "ok");
    assert.equal(surface.deployment.doors.state, "converged");
    assert.equal(surface.deployment.origin, "https://example.test");
  });
});

describe("operator route gate", () => {
  const TOKEN = "operator-surface-token-0123456789";
  const HASH = createHash("sha256").update(TOKEN).digest("hex");
  let saved;
  before(() => { saved = process.env.ROOM_OPERATOR_TOKEN_SHA256; });
  after(() => {
    if (saved === undefined) delete process.env.ROOM_OPERATOR_TOKEN_SHA256;
    else process.env.ROOM_OPERATOR_TOKEN_SHA256 = saved;
  });

  function harness(statusProviders = {}) {
    const calls = { json: [], reject: [] };
    const routes = createOperatorRoutes({
      store: null,
      json: (res, status, payload) => calls.json.push({ status, payload }),
      reject: (status, code) => { const error = new Error(code); error.status = status; error.code = code; calls.reject.push({ status, code }); throw error; },
      body: async () => ({}),
      rate: () => {},
      statusProviders
    });
    return { routes, calls };
  }
  const request = token => ({
    method: "GET", headers: token ? { authorization: `Operator ${token}` } : {}
  });
  const context = { url: new URL("https://example.test/api/operator/status-surface"), remoteAddress: "127.0.0.1", requestId: "test" };

  test("unconfigured operator secret falls through like an unknown URL", async () => {
    delete process.env.ROOM_OPERATOR_TOKEN_SHA256;
    const { routes } = harness();
    assert.equal(await routes(request(TOKEN), {}, context), false);
  });

  test("wrong token is refused with the same 404 as an unknown route", async () => {
    process.env.ROOM_OPERATOR_TOKEN_SHA256 = HASH;
    const { routes, calls } = harness();
    await assert.rejects(() => routes(request("wrong-token-value-0123456789abcd"), {}, context), error => error.status === 404);
    assert.equal(calls.reject.at(-1).status, 404);
  });

  test("valid token serves the composed surface", async () => {
    process.env.ROOM_OPERATOR_TOKEN_SHA256 = HASH;
    const { routes, calls } = harness({ jobHealth: async () => [], workerDoorRevision: async () => null, origin: null });
    assert.equal(await routes(request(TOKEN), { setHeader: () => {} }, context), true);
    assert.equal(calls.json.length, 1);
    assert.equal(calls.json[0].status, 200);
    assert.equal(calls.json[0].payload.schema, "room.operator-status/1");
    assert.equal(calls.json[0].payload.jobs.rows.length, JOBS.length);
  });
});
