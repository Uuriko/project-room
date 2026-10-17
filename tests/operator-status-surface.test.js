// Operator status surface: the composed deployment/jobs read. Every tile
// must render its honest state for healthy, failing, and never-ran records
// — a fact the records do not hold comes back as an explicit not-recorded
// state, never as a plausible-looking zero.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { JOBS } from "../server/jobs.mjs";
import { SOURCE_REVISION } from "../server/version.mjs";
import { createOperatorRoutes } from "../server/operator-routes.mjs";
import {
  buildStatusSurface, collectStatusSurface, readWorkerDoorRevision, burnState, INTEGRITY_STEP_NAMES
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

describe("backup tile", () => {
  test("recorded measurement passes through with its margin", () => {
    const backup = { bytes: 89_650_000, at: ISO(NOW - 86_400_000), key: "room-backups/2026-10-14.ndjson",
      target: "kv", growthBytesPerDay: 4_000_000, singleBodyCapBytes: 100_000_000, marginDays: 2.6 };
    const surface = buildStatusSurface({ jobs: healthyJobs, backup, now: NOW });
    assert.equal(surface.backup.state, "recorded");
    assert.equal(surface.backup.bytes, 89_650_000);
    assert.equal(surface.backup.marginDays, 2.6);
  });

  test("never measured renders not-recorded, not zero", () => {
    const surface = buildStatusSurface({ jobs: healthyJobs, backup: null, now: NOW });
    assert.equal(surface.backup.state, "not-recorded");
    assert.equal(surface.backup.bytes, null);
    assert.equal(surface.backup.marginDays, null);
  });
});

describe("store-backed tiles", () => {
  let directory, store;
  before(() => {
    directory = mkdtempSync(join(tmpdir(), "status-surface-"));
    store = new RoomStore(join(directory, "room.sqlite"));
  });
  after(() => { store?.close?.(); rmSync(directory, { recursive: true, force: true }); });

  test("never-ran: a null store renders integrity and board as not-recorded", () => {
    const surface = buildStatusSurface({ store: null, jobs: healthyJobs, now: NOW });
    assert.equal(surface.integrity.state, "not-recorded");
    assert.equal(surface.integrity.cursor, null);
    assert.equal(surface.integrity.snapshot.verifiedAt, null);
    assert.equal(surface.integrity.outstandingFailures, null);
    assert.equal(surface.integrity.lastFailingRoom, null);
    assert.equal(surface.integrity.lastFailingRoomState, "not-recorded");
    assert.equal(surface.board.state, "not-recorded");
    assert.equal(surface.board.claimableCount, null);
  });

  test("healthy: the deferred-batch cursor names the next step, board is empty", async () => {
    const preBatch = buildStatusSurface({ store, jobs: healthyJobs, now: NOW });
    await store.runDeferredIntegrityBatch();
    const surface = buildStatusSurface({ store, jobs: healthyJobs, now: NOW });
    assert.ok(surface.integrity.cursor, "cursor exists after a batch ran");
    assert.equal(surface.integrity.cursor.stepsTotal, 11);
    assert.equal(surface.integrity.cursor.nextStepName, INTEGRITY_STEP_NAMES[surface.integrity.cursor.nextStepIndex]);
    if (preBatch.integrity.cursor) {
      assert.equal(surface.integrity.cursor.nextStepIndex, (preBatch.integrity.cursor.nextStepIndex + 2) % 11);
    }
    assert.equal(surface.board.state, "recorded");
    assert.equal(surface.board.claimableCount, 0);
  });

  test("failing room: named from the failure record, message never republished", () => {
    // The batch-isolation store (#3544) is not on this branch yet; create
    // its table exactly as that change defines it to pin the composition.
    store.db.exec(`CREATE TABLE IF NOT EXISTS integrity_failures (
      step TEXT NOT NULL, record_id TEXT NOT NULL DEFAULT '', code TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '', failures INTEGER NOT NULL DEFAULT 1,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (step, record_id))`);
    store.db.prepare(`INSERT INTO integrity_failures(step, record_id, code, message, failures, first_seen_at, last_seen_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run("messages_parity", "room-alpha", "parity_count_mismatch", "unredacted-body-detail", 3, NOW - 86_400_000, NOW - 3_600_000);
    const surface = buildStatusSurface({ store, jobs: healthyJobs, now: NOW });
    assert.equal(surface.integrity.state, "failing");
    assert.equal(surface.integrity.outstandingFailures, 1);
    assert.equal(surface.integrity.mostRecentFailure.step, "messages_parity");
    assert.equal(surface.integrity.mostRecentFailure.code, "parity_count_mismatch");
    assert.equal(surface.integrity.mostRecentFailure.lastSeenAt, ISO(NOW - 3_600_000));
    assert.equal(surface.integrity.lastFailingRoom, "room-alpha");
    assert.equal(surface.integrity.lastFailingRoomState, "recorded");
    assert.ok(!JSON.stringify(surface).includes("unredacted-body-detail"), "stored failure messages stay in the store");
  });

  test("a newer non-room-scoped failure leaves the failing room unnamed", () => {
    store.db.prepare(`INSERT INTO integrity_failures(step, record_id, code, message, failures, first_seen_at, last_seen_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run("inbox", "inv-9", "inbox_receipt_mismatch", "", 1, NOW - 60_000, NOW - 60_000);
    const surface = buildStatusSurface({ store, jobs: healthyJobs, now: NOW });
    assert.equal(surface.integrity.outstandingFailures, 2);
    assert.equal(surface.integrity.mostRecentFailure.step, "inbox");
    assert.equal(surface.integrity.lastFailingRoom, null);
    assert.equal(surface.integrity.lastFailingRoomState, "not-room-scoped");
  });
});

describe("behaviour tile (SLIs)", () => {
  test("burn grammar: 2x alerts, 10x pages, no budget means no burn", () => {
    assert.equal(burnState(null), null);
    assert.equal(burnState(Number.NaN), null);
    assert.equal(burnState(0.5), "within-budget");
    assert.equal(burnState(1.99), "within-budget");
    assert.equal(burnState(2), "alert");
    assert.equal(burnState(9.9), "alert");
    assert.equal(burnState(10), "page");
  });

  test("unmeasurable SLIs render not-recorded with their named gaps", () => {
    const surface = buildStatusSurface({ store: null, jobs: healthyJobs, now: NOW });
    const byId = new Map(surface.behaviour.slis.map(sli => [sli.id, sli]));
    for (const id of ["task-success", "tool-accuracy", "cost-per-task", "policy-compliance"]) {
      const sli = byId.get(id);
      assert.ok(sli, id);
      assert.equal(sli.budget, null, id);
      assert.equal(sli.burnRate, null, id);
      assert.equal(sli.burnState, null, id);
      assert.ok(typeof sli.gap === "string" && sli.gap.length > 20, id);
    }
    assert.equal(surface.behaviour.windowDays, 30);
  });

  test("cost-per-task observes approved lots inside the window only", () => {
    const directory = mkdtempSync(join(tmpdir(), "status-surface-behaviour-"));
    const store = new RoomStore(join(directory, "room.sqlite"));
    try {
      const insert = store.db.prepare(`INSERT INTO bounty_journal(room_id, entry_id, account_id, at, kind, bounty_id, lot_id, amount, lot_state, prev_hash, hash)
        VALUES('room-1', ?, 'acct-1', ?, 'settle', 'b-1', ?, 100, ?, 'p', ?)`);
      insert.run("e-in-window", ISO(NOW - 86_400_000), "lot-a", "approved", "h1");
      insert.run("e-in-window-2", ISO(NOW - 2 * 86_400_000), "lot-a", "approved", "h2");
      insert.run("e-old", ISO(NOW - 40 * 86_400_000), "lot-b", "approved", "h3");
      insert.run("e-locked", ISO(NOW - 86_400_000), "lot-c", "locked", "h4");
      const surface = buildStatusSurface({ store, jobs: healthyJobs, now: NOW });
      const sli = surface.behaviour.slis.find(candidate => candidate.id === "cost-per-task");
      assert.equal(sli.state, "recorded");
      assert.equal(sli.observed.approvedLots, 1);
      assert.equal(sli.burnRate, null);
    } finally {
      store?.close?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
