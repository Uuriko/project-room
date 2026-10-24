// #3894 (sweep F-4): a disabled job is healthy idle when the disable is
// work-gated (nothing waiting), but room-backup's disable is config-gated:
// the deployment cannot take backups at all. Before the fix, dropping the
// ROOM_BACKUPS_KV binding flipped the job to "disabled", the health rollup
// filtered disabled jobs out, /api/health/jobs stayed ok, and the external
// probe's jobs check ignored it — backups stopped and nothing paged.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { applyOutcomes, jobHealthResponse, jobHealthView } from "../cloudflare/job-heartbeat.mjs";
import { runExternalProbe } from "../cloudflare/external-probe.mjs";

function fixtureStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-required-jobs-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons"));
  store.patrolTick();
  // STATUS-LEG (C-07): claim-prs has standing deploy-status work, so a
  // store where it has never ticked reads stale and would drown the
  // room-backup gate under test. Seed the main-HEAD cache it maintains
  // as checked at the fixtures' "now", i.e. claim-prs ticked a moment ago.
  store.db.prepare("INSERT INTO work_claim_config(room_id, config_json, updated_at) VALUES(?,?,?)")
    .run("_claim-main-head", JSON.stringify({ sha: "a".repeat(40), behind: null, checkedAt: "2026-09-24T22:00:00.000Z" }), Date.parse("2026-09-24T22:00:00Z"));
  return store;
}

// The always-on cadence jobs get fresh success records, mirroring the
// existing heartbeat fixtures, so the only signal under test is the
// room-backup gate.
function freshRecords(now) {
  return applyOutcomes({}, ["retention", "integrity", "public-read-model", "store-growth"]
    .map(job => ({ job, ok: true, at: now, summary: { checked: 1 } })));
}

test("a required job disabled by a dropped binding fails the health rollup", t => {
  const store = fixtureStore(t);
  const now = Date.parse("2026-09-24T22:00:00Z");
  // No ROOM_BACKUPS / ROOM_BACKUPS_KV in env: the binding was dropped.
  const view = jobHealthView(freshRecords(now), now, { ROOM_GMAIL_ENABLED: "0" }, store);
  const backup = view.jobs.find(job => job.name === "room-backup");
  assert.equal(backup.status, "disabled");
  assert.equal(backup.required, true);
  assert.match(backup.reason, /no backups are being taken/i);
  // The rollup must not call this ok: backups silently stopped.
  assert.equal(view.status, "failing");
  assert.equal(jobHealthResponse(view).status, 503);
  // A work-gated / feature-gated disable stays a healthy idle signal:
  // gmail is off in the same view and must not be what failed it.
  const gmail = view.jobs.find(job => job.name === "gmail-sync");
  assert.equal(gmail.status, "disabled");
  assert.notEqual(gmail.required, true);
});

test("the same view is ok when the backups binding is present", t => {
  const store = fixtureStore(t);
  const now = Date.parse("2026-09-24T22:00:00Z");
  const env = { ROOM_GMAIL_ENABLED: "0", ROOM_BACKUPS_KV: { async put() {}, async get() { return null; } } };
  const stored = applyOutcomes(freshRecords(now), [{ job: "room-backup", ok: true, at: now, summary: { rooms: 1 } }]);
  const view = jobHealthView(stored, now, env, store);
  const backup = view.jobs.find(job => job.name === "room-backup");
  assert.equal(backup.status, "ok");
  assert.equal(view.status, "ok");
  assert.equal(jobHealthResponse(view).status, 200);
});

function memoryKv() {
  const map = new Map();
  return { async get(key) { return map.get(key) ?? null; }, async put(key, value) { map.set(key, value); } };
}

function jobsFetch(jobsPayload, status = 200) {
  return async input => {
    const url = String(input instanceof URL ? input.href : input);
    if (url.endsWith("/api/ready")) return new Response(JSON.stringify({ status: "ready" }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/mcp")) return new Response(JSON.stringify({ jsonrpc: "2.0", result: { tools: [{ name: "room_status" }] } }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/llms.txt")) return new Response("# Uuriko Project Room\n", { status: 200, headers: { "content-type": "text/plain" } });
    if (url.endsWith("/api/health/jobs")) return new Response(JSON.stringify(jobsPayload), { status, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  };
}

test("the probe's jobs check fails on a required job disabled, naming it", async () => {
  const payload = { schema: "room.job-health/1", status: "failing", jobs: [
    { name: "integrity", status: "ok", stale: false, consecutiveFailures: 0 },
    { name: "room-backup", status: "disabled", stale: false, consecutiveFailures: 0, required: true },
    { name: "gmail-sync", status: "disabled", stale: false, consecutiveFailures: 0 }
  ] };
  const result = await runExternalProbe({ PROBE_ORIGIN: "https://probe.example", PROBE_STATE: memoryKv() }, jobsFetch(payload, 503));
  assert.equal(result.ok, false);
  const jobs = result.checks.find(check => check.id === "jobs");
  assert.equal(jobs.ok, false);
  assert.equal(jobs.reason, "job_required_disabled");
  assert.match(jobs.detail, /room-backup/);
});

test("the probe still ignores an ordinary disabled job", async () => {
  const payload = { schema: "room.job-health/1", status: "ok", jobs: [
    { name: "integrity", status: "ok", stale: false, consecutiveFailures: 0 },
    { name: "gmail-sync", status: "disabled", stale: false, consecutiveFailures: 0, enabled: false }
  ] };
  const result = await runExternalProbe({ PROBE_ORIGIN: "https://probe.example", PROBE_STATE: memoryKv() }, jobsFetch(payload));
  assert.equal(result.ok, true, JSON.stringify(result.checks));
});
