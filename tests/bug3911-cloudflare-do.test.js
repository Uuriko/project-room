// #3911 (bug sweep 2026-10-16, lane 12 CLOUDFLARE-DO) — Low bundle specimens.
// Each test pins one finding's contract at the real boundary and fails at
// the pre-fix head:
//  F-8a land-queue: a tick whose items are all github_unconfigured must be
//       graded a FAILURE by the job heartbeat, not recorded as success.
//  F-8b claim-prs: an autolink follow-up failure must surface on the tick
//       result (scanError), not only in console.error, while the linked-PR
//       poll's own result still rides along.
//  F-9  entry Worker: the top-level wrangler config (the public entry door,
//       deployed with no --env) must carry the same cpu_ms as production.
//  F-10 room-backup: the job must hand its deadline to the backup writer,
//       and a writer that crosses the deadline stops cooperatively
//       ({ budgetExceeded: 1 }) with no manifest / no stored object, instead
//       of running a full export to completion inside the single DO.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { JOBS } from "../server/jobs.mjs";
import { summaryFailure } from "../cloudflare/job-heartbeat.mjs";
import { writeDailyBackup, writeKvBackup } from "../cloudflare/room-backup.mjs";

function landFixture(t) {
  const clock = { now: Date.parse("2026-09-24T12:00:00Z") };
  const store = new RoomStore(":memory:", { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); });
  return { store, clock };
}

test("F-8a: land-queue refreshDue with an unconfigured GitHub token grades as a tick failure", async t => {
  const { store, clock } = landFixture(t);
  const fetchImpl = async () => ({ status: 401, ok: false, json: async () => ({ message: "Requires authentication" }) });
  store.landQueue.configure({ fetchImpl });
  await assert.rejects(
    () => store.landQueue.add("commons", "owner", { repo: "acme/private", prNumber: 3 }),
    error => error.code === "github_unconfigured");
  const summary = await store.landQueue.refreshDue({ now: clock.now + 10 * 60 * 1000 });
  assert.equal(summary.unconfigured, 1, "the count itself is still reported");
  assert.match(summary.scanError ?? "", /unconfigured/, "the tick result names the failure on the failure channel");
  assert.match(summaryFailure(summary) ?? "", /unconfigured/, "the heartbeat grades the tick as failed, not success");
});

test("F-8b: claim-prs autolink failure surfaces on the tick result instead of only console.error", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  // One claim row makes liveClaims() call workClaims.list; make that call
  // throw so the autolink follow-up fails deterministically. The poll
  // itself (syncClaimPullRequests) reads via get/prepare, not list, so it
  // still completes and its result must ride along.
  store.db.prepare("INSERT INTO work_claims (room_id, claim_id, item_json, updated_at) VALUES (?, ?, ?, ?)")
    .run("commons", "c1", JSON.stringify({ id: "c1", state: "claimed", owner: "owner", repo: "acme/demo" }), Date.now());
  store.workClaims.list = () => { throw new Error("autolink boom"); };
  const job = JOBS.find(entry => entry.name === "claim-prs");
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  t.after(() => { console.error = originalError; });
  const out = await job.run(store, { env: {}, deadline: Date.now() + 60_000 });
  assert.equal(typeof out.checked, "number", "the linked-PR poll result still rides along");
  assert.equal(out.autolinkFailed, 1, "the result counts the autolink failure");
  assert.match(out.scanError ?? "", /autolink/, "the tick result names the failure on the failure channel");
  assert.match(summaryFailure(out) ?? "", /autolink/, "the heartbeat grades the tick as failed, not success");
});

test("F-9: entry Worker (top-level wrangler config) carries the production CPU limit", () => {
  const release = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(release.env.production.limits.cpu_ms, 30000, "production keeps 30 s");
  assert.equal(release.limits.cpu_ms, release.env.production.limits.cpu_ms,
    "the entry door deploys the same room.mjs with no --env, so its top-level limit must match production");
});

function dripBody(chunks, stepMs = 5) {
  // A web-stream export body (the shape exportRoomNdjson returns) that
  // yields one chunk per stepMs, so a deadline a few steps out is crossed
  // mid-stream deterministically.
  return ReadableStream.from((async function* () {
    for (const chunk of chunks) {
      await new Promise(resolve => setTimeout(resolve, stepMs));
      yield new TextEncoder().encode(chunk);
    }
  })());
}

test("F-10: writeDailyBackup stops cooperatively at its deadline and writes no manifest (KV)", async () => {
  const puts = [];
  const kv = {
    get: async () => null,
    put: async (key, value) => { puts.push(key); }
  };
  const lines = Array.from({ length: 40 }, (_, i) => `{"table":"t","row":{"i":${i}}}` + "x".repeat(200) + "\n");
  const room = { exportRoomNdjson: () => dripBody(lines) };
  const out = await writeDailyBackup({ ROOM_BACKUPS_KV: kv }, room, new Date(Date.UTC(2026, 9, 2)), { deadline: Date.now() + 30 });
  assert.equal(out.budgetExceeded, 1, "the writer stops at the deadline instead of running to completion");
  assert.ok(Number(out.bytes) > 0 && Number(out.bytes) < lines.join("").length, "partial progress is reported, not the whole export");
  assert.equal(puts.some(key => !key.includes(".part-")), false, "no manifest is written for an aborted backup");
});

test("F-10: writeKvBackup honours a deadline passed directly", async () => {
  const puts = [];
  const kv = { put: async (key, value) => { puts.push(key); } };
  const lines = Array.from({ length: 40 }, (_, i) => `line-${i}-` + "y".repeat(200) + "\n");
  const out = await writeKvBackup(kv, "room-backups/2026-10-02.ndjson", dripBody(lines), { partBytes: 1024, deadline: Date.now() + 30 });
  assert.equal(out.budgetExceeded, 1);
  assert.equal(puts.some(key => !key.includes(".part-")), false, "no manifest key is written");
});

test("F-10: writeDailyBackup with an already-spent deadline does no export work", async () => {
  let exported = false;
  const kv = { get: async () => null, put: async () => {} };
  const room = { exportRoomNdjson: () => { exported = true; return dripBody(["{}\n"]); } };
  const out = await writeDailyBackup({ ROOM_BACKUPS_KV: kv }, room, new Date(Date.UTC(2026, 9, 2)), { deadline: Date.now() - 1 });
  assert.equal(out.budgetExceeded, 1);
  assert.equal(exported, false, "a spent deadline stops before the export even starts");
});

test("F-10: a backup inside its deadline still completes (no regression)", async () => {
  const puts = [];
  const kv = {
    get: async () => null,
    put: async (key, value) => { puts.push(key); }
  };
  const room = { exportRoomNdjson: () => dripBody(["{\"kind\":\"watermark\",\"events\":0}\n", "{\"kind\":\"trailer\",\"events\":0}\n"], 0) };
  const out = await writeDailyBackup({ ROOM_BACKUPS_KV: kv }, room, new Date(Date.UTC(2026, 9, 2)), { deadline: Date.now() + 60_000 });
  assert.equal(out.wrote, "room-backups/2026-10-02.ndjson");
  assert.ok(puts.some(key => !key.includes(".part-")), "the manifest is written when the backup completes");
});
