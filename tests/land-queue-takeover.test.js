// #3255: the stale in-flight takeover must not race a still-running first
// attempt. Before the fix, #requestKey's takeover fenced racing
// *reclaimers* but not the original attempt: githubFetch had no timeout,
// so attempt 1 could be alive in its GitHub read long past
// STALE_INFLIGHT_MS, and its unpredicated commit()/abort() then overwrote
// the takeover's stored replay response / deleted its committed record.
// The fix: every claim carries a claim_nonce and commit/abort are
// predicated on (status=0 AND claim_nonce = mine); every GitHub fetch is
// time-bounded (AbortSignal.timeout, sized so a keyed call's whole fetch
// chain stays comfortably below the staleness window). These tests force
// the D1 harness interleavings deterministically (gated fetch + injected
// store clock) and fail on the pre-fix code.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const SHA = "a".repeat(40);
const STALE_MS = 11 * 60 * 1000; // just past STALE_INFLIGHT_MS (10 min)

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-land-takeover-"));
  const clock = { now: Date.parse("2026-10-08T12:00:00Z") };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, clock };
}

const snap = title => ({
  pr: { title, merged: false, merge_commit_sha: null, mergeable: true, mergeable_state: "clean", head: { sha: SHA } },
  status: { state: "pending" },
  checks: { check_runs: [{ status: "in_progress", conclusion: null }] },
});

// fetchImpl whose FIRST call (attempt 1's PR read) parks on a gate; the PR
// title it serves is mutable so the two attempts' snapshots are tellable
// apart. The stub ignores the AbortSignal (like a non-cooperative
// transport): the claim nonce, not the timeout, is what fences attempt 1.
function gatedGitHub(state) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (calls.length === 1) await state.gate;
    let body = snap(state.title).pr;
    if (url.includes("/check-runs")) body = snap(state.title).checks;
    else if (url.endsWith("/status")) body = snap(state.title).status;
    return { status: 200, ok: true, json: async () => body };
  };
  return { fetchImpl, calls };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition never became true");
    await sleep(5);
  }
}
const idemRow = (store, requestId) => store.db.prepare(
  "SELECT status, response FROM land_queue_idempotency WHERE room_id='commons' AND request_id=?").get(requestId);

test("takeover: the first attempt's late commit cannot overwrite the takeover's stored response", async t => {
  const { store, clock } = fixture(t);
  let release;
  const gate = new Promise(r => { release = r; });
  const state = { gate, title: "V1-title" };
  const gh = gatedGitHub(state);
  store.landQueue.configure({ fetchImpl: gh.fetchImpl });

  // Attempt 1 claims the key and parks inside its GitHub read.
  const attempt1 = store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 1, requestId: "add-A" });
  attempt1.catch(() => {});
  await until(() => gh.calls.length === 1);

  // The placeholder ages past the staleness window while attempt 1 is
  // still alive: the retry reclaims the key and re-executes.
  clock.now += STALE_MS;
  const attempt2 = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 1, requestId: "add-A" });
  assert.equal(attempt2.item.title, "V1-title");
  const storedAfter2 = idemRow(store, "add-A");
  assert.equal(storedAfter2.status, 1);
  assert.equal(JSON.parse(storedAfter2.response).item.title, "V1-title");

  // Attempt 1's read finally returns, with a changed title. Its caller
  // gets its own result — but its commit must land nowhere.
  state.title = "V2-title-changed";
  release();
  const attempt1Result = await attempt1;
  assert.equal(attempt1Result.item.title, "V2-title-changed", "attempt 1 executed; only its record write is fenced");
  const storedFinal = idemRow(store, "add-A");
  assert.equal(storedFinal.response, storedAfter2.response,
    "the stored replay response stays the takeover's, byte-identical");

  // A third call replays the takeover's response without executing again.
  const callsBefore = gh.calls.length;
  const replay = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 1, requestId: "add-A" });
  assert.equal(replay.item.title, "V1-title");
  assert.equal(gh.calls.length, callsBefore, "a replay makes no GitHub calls");
});

test("takeover: the first attempt's late abort cannot delete the takeover's committed record", async t => {
  const { store, clock } = fixture(t);
  let release;
  const gate = new Promise(r => { release = r; });
  const state = { gate, title: "V1-title" };
  const gh = gatedGitHub(state);
  store.landQueue.configure({ fetchImpl: gh.fetchImpl });

  const attempt1 = store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 1, requestId: "add-B" });
  attempt1.catch(() => {});
  await until(() => gh.calls.length === 1);

  // The owner removes the item attempt 1 inserted, mid-flight.
  const firstItemId = store.landQueue.list("commons", "owner").items[0]?.itemId;
  assert.ok(firstItemId);
  store.landQueue.remove("commons", "owner", { itemId: firstItemId });
  assert.equal(store.landQueue.list("commons", "owner").items.length, 0);

  // The retry reclaims the stale key, re-executes, and commits.
  clock.now += STALE_MS;
  const attempt2 = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 1, requestId: "add-B" });
  assert.ok(attempt2.item.itemId);
  const storedAfter2 = idemRow(store, "add-B");
  assert.equal(storedAfter2?.status, 1, "the takeover's record is committed");

  // Attempt 1's read returns; its completion fails (its row is gone), so
  // add() aborts the key. The abort must not touch the takeover's record.
  release();
  await assert.rejects(attempt1);
  const storedFinal = idemRow(store, "add-B");
  assert.ok(storedFinal, "the committed record survives the superseded attempt's abort");
  assert.equal(storedFinal.status, 1);
  assert.equal(storedFinal.response, storedAfter2.response);

  // A third call replays instead of executing a third time.
  const callsBefore = gh.calls.length;
  const replay = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 1, requestId: "add-B" });
  assert.equal(replay.item.itemId, attempt2.item.itemId);
  assert.equal(gh.calls.length, callsBefore, "a replay makes no GitHub calls");
});

test("githubFetch is time-bounded: a hung forge read fails instead of outliving the staleness window", async t => {
  const { store } = fixture(t);
  const seen = [];
  // A transport that never answers on its own and only settles when its
  // AbortSignal fires — the hung-GitHub shape from the issue.
  const hangingFetch = (url, opts) => {
    seen.push(opts);
    return new Promise((resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
    });
  };
  store.landQueue.configure({ fetchImpl: hangingFetch, fetchTimeoutMs: 50 });

  const started = Date.now();
  await assert.rejects(
    store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 1, requestId: "add-hang" }),
    error => error?.status === 502 && error?.code === "github_unavailable",
    "the hung read surfaces as github_unavailable, not a hang");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `the read is bounded by the configured timeout (took ${elapsed}ms)`);
  assert.ok(seen.length >= 1 && seen[0].signal instanceof AbortSignal,
    "every forge fetch receives an AbortSignal");

  // The failed attempt cleaned its placeholder up (the failure path), so
  // the key is immediately reusable — a dead attempt never bricks it.
  assert.equal(idemRow(store, "add-hang"), undefined);
});
