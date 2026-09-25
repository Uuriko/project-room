// Land queue: state transitions, wake emission, REST, and the hosted MCP tools.
// GitHub is mocked. Tokens are asserted as present or absent and must not
// appear in items, events, or logs.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import {
  landTransition, tipTransition, landWakePayload, rollupChecks, normalizePull, githubAccessToken,
  nextPollBackoff, POLL_BACKOFF_STEPS_MS
} from "../server/land-queue.mjs";
import { landCardHtml, shortSha } from "../src/land-queue-board.js";

const SHA = "a".repeat(40);
const NEXT = "b".repeat(40);
const MERGED = "c".repeat(40);
const TOKEN = "github_pat_test_land_queue";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-land-"));
  const clock = { now: Date.parse("2026-09-24T12:00:00Z") };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey, clock, roomId: "commons" };
}

function snapshot({ checks = "pending", behind = false, merged = false, sha = SHA, title = "Land the queue" } = {}) {
  const statusState = checks === "red" ? "failure" : checks === "pending" ? "pending" : "success";
  const conclusion = checks === "red" ? "failure" : "success";
  return {
    pr: {
      title,
      merged,
      merge_commit_sha: merged ? MERGED : null,
      mergeable: merged || behind ? false : true,
      mergeable_state: merged ? "unknown" : behind ? "behind" : "clean",
      head: { sha }
    },
    status: { state: statusState },
    checks: {
      check_runs: [{ status: checks === "pending" ? "in_progress" : "completed", conclusion: checks === "pending" ? null : conclusion }]
    }
  };
}

function mockGitHub(current) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: init?.headers?.Authorization ?? null });
    const scene = current();
    if (scene.http) {
      return { status: scene.http, ok: false, json: async () => ({ message: scene.message ?? "" }) };
    }
    let body = scene.pr;
    if (url.includes("/check-runs")) body = scene.checks;
    else if (url.endsWith("/status")) body = scene.status;
    return { status: 200, ok: true, json: async () => body };
  };
  return { fetchImpl, calls };
}

function landEvents(store, roomId = "commons") {
  return store.db.prepare(
    "SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.type')=? ORDER BY sequence"
  ).all(roomId, T.LAND_UPDATED).map(row => JSON.parse(row.body));
}

function spyWake(t, store) {
  const pushes = [];
  const pings = [];
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  const pushNotify = store.agentHeartbeats.pushNotify.bind(store.agentHeartbeats);
  store.agentHeartbeats.pushNotify = args => { pushes.push(args); return pushNotify(args); };
  const deliver = store.agentPlugin.deliverWakePing.bind(store.agentPlugin);
  store.agentPlugin.deliverWakePing = args => { pings.push(args); return deliver(args); };
  t.after(() => { console.warn = warn; });
  return { pushes, pings, warnings };
}

function linkOffline(store, ownerKey) {
  const identity = store.identities.create("Lander");
  const linked = store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, displayName: "Lander", permissions: []
  });
  const seen = store.now() - 10 * 60 * 1000;
  store.db.prepare(`INSERT INTO agent_hosts
    (agent_id, host_id, mode, wake_url, last_seen_at, created_at, updated_at)
    VALUES (?, 'host-1', 'wakeable', 'https://example.com/wake', ?, ?, ?)`)
    .run(identity.identityId, seen, seen, seen);
  return { identity, memberId: linked.memberId };
}

const observed = (checks, behind = false, mergedSha = null) => ({ checks, behind, mergedSha });

test("check-run rollup ignores an empty combined status, neutral, and skipped", () => {
  const success = { status: "completed", conclusion: "success", name: "unit" };
  const failed = { status: "completed", conclusion: "failure", name: "unit" };
  const neutral = { status: "completed", conclusion: "neutral", name: "Cursor Approval Agent" };
  const skipped = { status: "completed", conclusion: "skipped", name: "optional" };
  const emptyStatus = { state: "pending", total_count: 0, statuses: [] };
  assert.equal(rollupChecks({ status: emptyStatus, checkRuns: [success, success, neutral] }), "green");
  assert.equal(rollupChecks({ status: emptyStatus, checkRuns: [success, failed, neutral] }), "red");
  assert.equal(rollupChecks({ status: emptyStatus, checkRuns: [neutral, skipped] }), "pending");
  assert.equal(rollupChecks({ status: emptyStatus, checkRuns: [] }), "pending");
  assert.equal(rollupChecks({ checkRuns: [{ status: "completed", conclusion: "cancelled" }] }), "red");
  assert.equal(rollupChecks({ checkRuns: [{ status: "completed", conclusion: "timed_out" }] }), "red");
  assert.equal(rollupChecks({ checkRuns: [{ status: "in_progress", conclusion: null }] }), "pending");
  assert.equal(rollupChecks({ status: { state: "failure", total_count: 1 }, checkRuns: [success] }), "red");
  assert.equal(rollupChecks({ status: { state: "pending", total_count: 2 }, checkRuns: [success] }), "pending");
  assert.equal(rollupChecks({ status: { state: "success", total_count: 1 }, checkRuns: [] }), "green");
  assert.equal(rollupChecks({}), "pending");
  const green = normalizePull(snapshot().pr, { status: emptyStatus, checkRuns: [success] });
  assert.equal(green.checks, "green");
  assert.equal(green.mergeable, "mergeable");
  assert.equal(green.behind, false);
  assert.equal(green.closed, false);
  const behind = normalizePull(snapshot({ behind: true }).pr, { status: emptyStatus, checkRuns: [] });
  assert.equal(behind.behind, true);
  assert.equal(behind.mergeable, "behind");
  const merged = normalizePull({ ...snapshot({ merged: true }).pr, state: "closed" }, { status: emptyStatus, checkRuns: [] });
  assert.equal(merged.mergeable, "merged");
  assert.equal(merged.mergedSha, MERGED);
  assert.equal(merged.closed, true);
});

test("transitions wake on green, red, behind, merged, and tip, not on the first look", () => {
  assert.deepEqual(landTransition(null, observed("green")), []);
  assert.deepEqual(landTransition(observed("pending"), observed("green")), ["green"]);
  assert.deepEqual(landTransition(observed("green"), observed("green")), []);
  assert.deepEqual(landTransition(observed("green"), observed("red")), ["red"]);
  assert.deepEqual(landTransition(observed("pending"), observed("red", true)), ["red", "behind"]);
  assert.deepEqual(landTransition(observed("green", true), observed("green", true)), []);
  assert.deepEqual(landTransition(observed("red"), { ...observed("green"), mergedSha: MERGED }), ["green", "merged"]);
  assert.deepEqual(tipTransition({ tipSourceRevision: null, tipBuildId: null }, { sourceRevision: "rev-1" }), ["tip"]);
  assert.deepEqual(tipTransition({ tipSourceRevision: "rev-1", tipBuildId: null }, { sourceRevision: "rev-1", buildId: null }), []);
  assert.deepEqual(tipTransition({ tipSourceRevision: "rev-1", tipBuildId: null }, { buildId: "build-9" }), ["tip"]);
  const payload = landWakePayload({
    prNumber: 969, headSha: SHA, checks: "green", behind: false, mergeable: "mergeable", mergedSha: null
  }, ["green"]);
  assert.deepEqual(payload, {
    pr: 969, head: SHA,
    state: { checks: "green", behind: false, mergeable: "mergeable", merged: false },
    changed: ["green"]
  });
});

test("githubAccessToken reads an existing env token and nothing else", () => {
  assert.equal(githubAccessToken({}), null);
  assert.equal(githubAccessToken({ GITHUB_TOKEN: "  " }), null);
  assert.equal(githubAccessToken({ GH_TOKEN: "abc" }), "abc");
  assert.equal(githubAccessToken({ GITHUB_TOKEN: "first", GH_TOKEN: "second" }), "first");
});

test("first observation records state and does not emit or wake", async t => {
  const { store, ownerKey } = fixture(t);
  const wake = spyWake(t, store);
  const { memberId } = linkOffline(store, ownerKey);
  const github = mockGitHub(() => snapshot({ checks: "green" }));
  store.landQueue.configure({ token: TOKEN, fetchImpl: github.fetchImpl });
  const added = await store.landQueue.add("commons", memberId, { repo: "acme/demo", prNumber: 969 });
  assert.equal(added.duplicate, false);
  assert.deepEqual(added.changed, []);
  assert.equal(added.item.checks, "green");
  assert.equal(added.item.headSha, SHA);
  assert.equal(added.item.claimantMemberId, memberId);
  assert.equal(landEvents(store).length, 0);
  assert.equal(wake.pushes.length, 0);
  assert.equal(wake.pings.length, 0);
  assert.equal(github.calls.every(call => call.authorization === `Bearer ${TOKEN}`), true);
  assert.equal(JSON.stringify(added).includes(TOKEN), false);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_wake_signals").get().n, 0);
});

test("green, behind, red, merged, and tip wake only an offline claimant", async t => {
  const { store, ownerKey, clock } = fixture(t);
  const wake = spyWake(t, store);
  const { identity, memberId } = linkOffline(store, ownerKey);
  let scene = snapshot({ checks: "pending" });
  const github = mockGitHub(() => scene);
  store.landQueue.configure({ token: TOKEN, fetchImpl: github.fetchImpl });
  const added = await store.landQueue.add("commons", memberId, { repo: "acme/demo", prNumber: 969 });
  assert.equal(landEvents(store).length, 0);
  const itemId = added.item.itemId;
  const due = () => store.landQueue.refreshDue({ now: clock.now + 120_000 });

  scene = snapshot({ checks: "green" });
  const green = await due();
  assert.equal(green.updated, 1);
  let events = landEvents(store);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.pr, 969);
  assert.equal(events[0].data.head, SHA);
  assert.deepEqual(events[0].data.changed, ["green"]);
  assert.deepEqual(events[0].data.state, { checks: "green", behind: false, mergeable: "mergeable", merged: false });
  assert.equal(events[0].actorId, memberId);
  assert.equal(wake.pushes.length, 1);
  assert.equal(wake.pushes[0].eventType, "land.updated");
  assert.equal(wake.pushes[0].identityId, identity.identityId);
  assert.equal(wake.pushes[0].roomId, "commons");
  assert.equal(Object.hasOwn(wake.pushes[0], "token"), false);
  assert.equal(wake.pings.length, 1);
  assert.equal(wake.pings[0].identityId, identity.identityId);
  assert.equal(wake.pings[0].signal.kind, "land");
  assert.equal(wake.pings[0].signal.pr, 969);
  assert.equal(wake.pings[0].signal.head, SHA);
  assert.deepEqual(wake.pings[0].signal.changed, ["green"]);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_wake_signals").get().n, 0);
  const room = store.room("commons");
  const rebuilt = store.rebuildProjection("commons");
  assert.equal(rebuilt.sequence, room.sequence);
  assert.deepEqual(rebuilt.state, room.state);
  assert.equal(JSON.stringify(room.state).includes(TOKEN), false);
  assert.equal(JSON.stringify(events).includes(TOKEN), false);

  scene = snapshot({ checks: "green", behind: true, sha: NEXT });
  await due();
  events = landEvents(store);
  assert.deepEqual(events.at(-1).data.changed, ["behind"]);
  assert.equal(events.at(-1).data.head, NEXT);
  assert.equal(events.at(-1).data.state.behind, true);

  store.db.prepare("UPDATE agent_hosts SET last_seen_at=? WHERE agent_id=?").run(store.now(), identity.identityId);
  const awake = wake.pushes.length;
  scene = snapshot({ checks: "red", sha: NEXT });
  await due();
  assert.deepEqual(landEvents(store).at(-1).data.changed, ["red"]);
  assert.equal(wake.pushes.length, awake, "an online claimant is not pushed");
  assert.equal(wake.pings.length, awake);

  store.db.prepare("UPDATE agent_hosts SET last_seen_at=? WHERE agent_id=?").run(store.now() - 10 * 60 * 1000, identity.identityId);
  scene = snapshot({ checks: "green", merged: true, sha: NEXT });
  await due();
  assert.deepEqual(landEvents(store).at(-1).data.changed, ["green", "merged"]);
  assert.equal(landEvents(store).at(-1).data.state.merged, true);
  assert.equal(wake.pushes.length, awake + 1);

  const tip = store.landQueue.reportTip("commons", "owner", { itemId, sourceRevision: "src-1", buildId: "build-1" });
  assert.deepEqual(tip.changed, ["tip"]);
  assert.equal(tip.item.tip.sourceRevision, "src-1");
  assert.equal(tip.item.tip.buildId, "build-1");
  assert.deepEqual(landEvents(store).at(-1).data.changed, ["tip"]);
  const same = store.landQueue.reportTip("commons", memberId, { itemId, sourceRevision: "src-1" });
  assert.deepEqual(same.changed, []);
  assert.equal(landEvents(store).length, 5);
  assert.throws(
    () => store.landQueue.reportTip("commons", memberId, { itemId }),
    error => error.status === 422 && error.code === "invalid_land_tip"
  );
  assert.equal(wake.warnings.some(line => line.includes(TOKEN)), false);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_wake_signals").get().n, 0);
});

test("a missing token is 503 github_unconfigured and is not logged", async t => {
  const { store, clock } = fixture(t);
  const wake = spyWake(t, store);
  const github = mockGitHub(() => ({ http: 401, message: "Requires authentication" }));
  store.landQueue.configure({ fetchImpl: github.fetchImpl });
  await assert.rejects(
    () => store.landQueue.add("commons", "owner", { repo: "acme/private", prNumber: 3 }),
    error => error.status === 503 && error.code === "github_unconfigured" && error.item?.repo === "acme/private"
  );
  assert.equal(github.calls.every(call => call.authorization === null), true);
  const kept = store.landQueue.list("commons", "owner").items;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].lastError, "github_unconfigured");
  const summary = await store.landQueue.refreshDue({ now: clock.now + 10 * 60 * 1000 });
  assert.equal(summary.unconfigured, 1);
  assert.match(wake.warnings.join("\n"), /github_unconfigured/);
  assert.equal(wake.warnings.some(line => /token|bearer|authorization/i.test(line)), false);
  assert.equal(landEvents(store).length, 0);
});

test("a rejected token is github_unconfigured and a missing pull request is pr_not_found", async t => {
  const { store } = fixture(t);
  const wake = spyWake(t, store);
  store.landQueue.configure({
    token: TOKEN,
    fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({ message: "Bad credentials" }) })
  });
  await assert.rejects(
    () => store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 4 }),
    error => error.status === 503 && error.code === "github_unconfigured" && !String(error.message).includes(TOKEN)
  );
  assert.equal(JSON.stringify(store.landQueue.list("commons", "owner")).includes(TOKEN), false);

  store.landQueue.configure({
    token: TOKEN,
    fetchImpl: async () => ({ status: 404, ok: false, json: async () => ({ message: "Not Found" }) })
  });
  await assert.rejects(
    () => store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 5 }),
    error => error.status === 404 && error.code === "pr_not_found"
  );
  assert.equal(store.landQueue.list("commons", "owner").items.some(item => item.prNumber === 5), false);
  assert.equal(wake.warnings.some(line => line.includes(TOKEN)), false);
});

test("an unauthenticated rate limit is github_unavailable, not a silent skip", async t => {
  const { store } = fixture(t);
  store.landQueue.configure({
    fetchImpl: async () => ({ status: 403, ok: false, json: async () => ({ message: "API rate limit exceeded" }) })
  });
  await assert.rejects(
    () => store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 8 }),
    error => error.status === 503 && error.code === "github_unavailable"
  );
  assert.equal(store.landQueue.list("commons", "owner").items[0].lastError, "github_unavailable");
});

test("backoff waits 1, 2, 4, then up to 10 minutes and stops on merged or closed", () => {
  assert.deepEqual(
    [0, 60_000, 120_000, 240_000, 480_000, 600_000].map(nextPollBackoff),
    [60_000, 120_000, 240_000, 480_000, 600_000, 600_000]
  );
  assert.deepEqual(POLL_BACKOFF_STEPS_MS.at(-1), 10 * 60 * 1000);
});

function conditionalGitHub(scene) {
  const calls = [];
  let generation = 1;
  const fetchImpl = async (url, init) => {
    const key = url.includes("/check-runs") ? "checks" : url.includes("/status") ? "status" : "pr";
    const etag = `"${key}-${generation}"`;
    const match = init?.headers?.["If-None-Match"] ?? null;
    calls.push({ key, match, url });
    if (match === etag) return { status: 304, ok: false, headers: { etag } };
    const current = scene();
    let body = current.pr;
    if (key === "checks") body = current.checks;
    else if (key === "status") body = current.status;
    return { status: 200, ok: true, headers: { etag }, json: async () => body };
  };
  return {
    fetchImpl,
    calls,
    bump() { generation += 1; }
  };
}

test("an unchanged poll sends If-None-Match, backs off, and skips merged and closed items", async t => {
  const { store, clock } = fixture(t);
  const open = {
    pr: {
      title: "Land the queue",
      state: "open",
      merged: false,
      merge_commit_sha: null,
      mergeable: true,
      mergeable_state: "clean",
      head: { sha: SHA }
    },
    status: { state: "pending", total_count: 0, statuses: [] },
    checks: { total_count: 2, check_runs: [
      { name: "unit", status: "completed", conclusion: "success" },
      { name: "Cursor Approval Agent", status: "completed", conclusion: "neutral" }
    ] }
  };
  let current = {
    ...open,
    checks: { total_count: 1, check_runs: [{ name: "unit", status: "in_progress", conclusion: null }] }
  };
  const github = conditionalGitHub(() => current);
  store.landQueue.configure({ fetchImpl: github.fetchImpl });
  const added = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 41 });
  assert.equal(added.item.checks, "pending");
  assert.equal(added.changed.length, 0);
  assert.equal(landEvents(store).length, 0);
  assert.equal(github.calls.some(call => call.url.includes("/check-runs") && call.url.includes("filter=latest")), true);

  current = open;
  github.bump();
  clock.now += 60_000;
  let summary = await store.landQueue.refreshDue();
  assert.equal(summary.updated, 1);
  assert.deepEqual(landEvents(store).at(-1).data.changed, ["green"]);
  assert.equal(store.landQueue.list("commons", "owner").items[0].checks, "green");

  const afterGreen = github.calls.length;
  clock.now += 30_000;
  summary = await store.landQueue.refreshDue();
  assert.equal(summary.checked, 0);
  assert.equal(github.calls.length, afterGreen);

  clock.now += 30_000;
  summary = await store.landQueue.refreshDue();
  assert.equal(summary.checked, 1);
  assert.equal(summary.updated, 0);
  const conditional = github.calls.slice(afterGreen);
  assert.equal(conditional.length, 3);
  assert.equal(conditional.every(call => call.match === `"${call.key}-2"`), true);
  const row = store.db.prepare("SELECT backoff_ms, next_poll_at, checks_state FROM land_queue WHERE item_id=?").get(added.item.itemId);
  assert.equal(row.backoff_ms, 120_000);
  assert.equal(row.checks_state, "green");
  assert.equal(row.next_poll_at, clock.now + 120_000);
  assert.equal(landEvents(store).length, 1);

  clock.now += 60_000;
  summary = await store.landQueue.refreshDue();
  assert.equal(summary.checked, 0);

  current = {
    ...open,
    pr: { ...open.pr, state: "closed", merged: true, merge_commit_sha: MERGED, mergeable: false, mergeable_state: "unknown" }
  };
  github.bump();
  clock.now += 60_000;
  summary = await store.landQueue.refreshDue();
  assert.equal(summary.updated, 1);
  assert.deepEqual(landEvents(store).at(-1).data.changed, ["merged"]);
  const mergedCalls = github.calls.length;
  clock.now += 30 * 60 * 1000;
  summary = await store.landQueue.refreshDue();
  assert.equal(summary.checked, 0);
  assert.equal(github.calls.length, mergedCalls);

  const closed = {
    pr: { ...open.pr, state: "closed", merged: false, mergeable: false, mergeable_state: "unknown" },
    status: open.status,
    checks: open.checks
  };
  current = closed;
  github.bump();
  const second = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 42 });
  assert.equal(second.item.checks, "green");
  const closedCalls = github.calls.length;
  clock.now += 30 * 60 * 1000;
  summary = await store.landQueue.refreshDue();
  assert.equal(summary.checked, 0);
  assert.equal(github.calls.length, closedCalls);
  assert.equal(store.db.prepare("SELECT closed FROM land_queue WHERE item_id=?").get(second.item.itemId).closed, 1);
});

test("a cron rate limit records the reset and skips until then without an error", async t => {
  const { store, clock } = fixture(t);
  const wake = spyWake(t, store);
  const resetSeconds = Math.floor((clock.now + 30 * 60 * 1000) / 1000);
  let limited = false;
  let hits = 0;
  store.landQueue.configure({
    fetchImpl: async (url) => {
      hits += 1;
      if (limited) {
        return {
          status: 429,
          ok: false,
          headers: { "x-ratelimit-reset": String(resetSeconds), "x-ratelimit-remaining": "0" },
          json: async () => ({ message: "API rate limit exceeded" })
        };
      }
      const scene = snapshot({ checks: "pending" });
      let body = scene.pr;
      if (String(url).includes("/check-runs")) body = scene.checks;
      else if (String(url).includes("/status")) body = scene.status;
      return { status: 200, ok: true, json: async () => body };
    }
  });
  const added = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 8 });
  assert.equal(added.item.lastError, null);
  limited = true;
  const afterAdd = hits;
  clock.now += 60_000;
  const blocked = await store.landQueue.refreshDue();
  assert.equal(blocked.checked, 1);
  assert.equal(blocked.rateLimited, 1);
  assert.equal(blocked.updated, 0);
  assert.equal(hits, afterAdd + 1);
  assert.equal(wake.warnings.length, 0);
  assert.equal(store.landQueue.list("commons", "owner").items[0].lastError, null);
  assert.equal(store.db.prepare("SELECT rate_limited_until AS until FROM land_queue").get().until, resetSeconds * 1000);
  const paused = await store.landQueue.refreshDue({ now: clock.now + 10 * 60 * 1000 });
  assert.equal(paused.checked, 0);
  assert.equal(paused.rateLimited, 1);
  assert.equal(hits, afterAdd + 1);
  clock.now = resetSeconds * 1000 + 1000;
  const again = await store.landQueue.refreshDue();
  assert.equal(again.checked, 1);
  assert.equal(again.rateLimited, 1);
  assert.equal(wake.warnings.length, 0);
  assert.equal(store.landQueue.list("commons", "owner").items[0].lastError, null);
});

test("members can remove an item and the queue caps at 50", async t => {
  const { store } = fixture(t);
  store.landQueue.configure({ fetchImpl: mockGitHub(() => snapshot()).fetchImpl });
  const added = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 1 });
  const removed = store.landQueue.remove("commons", "owner", { itemId: added.item.itemId });
  assert.equal(removed.removed, true);
  assert.equal(store.landQueue.list("commons", "owner").items.length, 0);
  assert.throws(
    () => store.landQueue.remove("commons", "owner", { itemId: added.item.itemId }),
    error => error.status === 404 && error.code === "land_item_not_found"
  );
  await assert.rejects(
    () => store.landQueue.add("commons", "owner", { repo: "not a repo", prNumber: 1 }),
    error => error.code === "invalid_land_item"
  );
  const insert = store.db.prepare(`INSERT INTO land_queue
    (room_id, item_id, repo, pr_number, claimant_member_id, added_by_member_id, mergeable, behind, checks_state, observed, created_at, updated_at)
    VALUES ('commons', ?, 'acme/demo', ?, 'owner', 'owner', 'unknown', 0, 'pending', 0, 1, 1)`);
  for (let number = 1; number <= 50; number += 1) insert.run(`lq_cap_${number}`, number);
  await assert.rejects(
    () => store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 51 }),
    error => error.status === 409 && error.code === "land_queue_full"
  );
});

test("re-adding a pull request keeps one row and can move the claimant", async t => {
  const { store, ownerKey } = fixture(t);
  const { memberId } = linkOffline(store, ownerKey);
  store.landQueue.configure({ fetchImpl: mockGitHub(() => snapshot({ checks: "pending" })).fetchImpl });
  const first = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 969 });
  const second = await store.landQueue.add("commons", "owner", {
    repo: "acme/demo", prNumber: 969, claimantMemberId: memberId
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.item.itemId, first.item.itemId);
  assert.equal(second.item.claimantMemberId, memberId);
  assert.equal(store.landQueue.list("commons", "owner").items.length, 1);
});

async function listen(t, store) {
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("REST add, list, tip, and remove match the tool names", async t => {
  const f = fixture(t);
  f.store.landQueue.configure({ fetchImpl: mockGitHub(() => snapshot({ checks: "pending" })).fetchImpl });
  const origin = await listen(t, f.store);
  const headers = { "content-type": "application/json", authorization: `Bearer ${f.ownerKey}` };
  const denied = await fetch(`${origin}/api/rooms/commons/list_land_queue`);
  assert.equal(denied.status, 401);
  const added = await fetch(`${origin}/api/rooms/commons/add_land_item`, {
    method: "POST", headers, body: JSON.stringify({ repo: "acme/demo", prNumber: 969 })
  });
  assert.equal(added.status, 201);
  const created = await added.json();
  assert.equal(created.item.prNumber, 969);
  assert.equal(created.item.claimantMemberId, "owner");
  assert.equal(created.duplicate, false);
  const listed = await fetch(`${origin}/api/rooms/commons/list_land_queue`, { headers });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).items[0].itemId, created.item.itemId);
  const tipped = await fetch(`${origin}/api/rooms/commons/report_tip`, {
    method: "POST", headers, body: JSON.stringify({ itemId: created.item.itemId, buildId: "build-9" })
  });
  assert.equal(tipped.status, 200);
  assert.deepEqual((await tipped.json()).changed, ["tip"]);
  const removed = await fetch(`${origin}/api/rooms/commons/remove_land_item`, {
    method: "POST", headers, body: JSON.stringify({ itemId: created.item.itemId })
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).removed, true);

  f.store.landQueue.configure({
    fetchImpl: async () => ({ status: 404, ok: false, json: async () => ({ message: "Not Found" }) })
  });
  const missing = await fetch(`${origin}/api/rooms/commons/add_land_item`, {
    method: "POST", headers, body: JSON.stringify({ repo: "acme/demo", prNumber: 99999 })
  });
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.equal(missingBody.error.code, "pr_not_found");
  assert.equal(missingBody.item, undefined);
  assert.equal(f.store.landQueue.list("commons", "owner").items.some(item => item.prNumber === 99999), false);

  f.store.landQueue.configure({
    fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({ message: "Requires authentication" }) })
  });
  const hidden = await fetch(`${origin}/api/rooms/commons/add_land_item`, {
    method: "POST", headers, body: JSON.stringify({ repo: "acme/private", prNumber: 3 })
  });
  assert.equal(hidden.status, 503);
  const body = await hidden.json();
  assert.equal(body.error.code, "github_unconfigured");
  assert.equal(body.item.prNumber, 3);
  assert.equal(JSON.stringify(body).includes("Bearer"), false);
});

test("hosted MCP lists and calls the land queue tools", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-land-mcp-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const owner = store.identities.create("Land owner");
  const created = rooms.create(owner.secret, {
    roomId: "land-den", title: "Land den", purpose: "Queue a pull request", kind: "personal", displayName: "Land owner"
  });
  store.landQueue.configure({ fetchImpl: mockGitHub(() => snapshot({ checks: "pending" })).fetchImpl });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = await listen(t, store);
  const rpc = (method, params) => fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${owner.secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, ...(params === undefined ? {} : { params }) })
  });
  const names = (await (await rpc("tools/list", { profile: "full" })).json()).result.tools.map(tool => tool.name);
  for (const name of ["add_land_item", "list_land_queue", "remove_land_item", "report_tip"]) {
    assert.equal(names.includes(name), true, name);
  }
  const call = async (name, args) => {
    const body = await (await rpc("tools/call", { name, arguments: args })).json();
    return body.result;
  };
  const added = await call("add_land_item", { roomId: created.roomId, repo: "acme/demo", prNumber: 969 });
  assert.equal(added.structuredContent.item.claimantMemberId, created.ownerMemberId);
  assert.equal(added.structuredContent.item.prNumber, 969);
  const listed = await call("list_land_queue", { roomId: created.roomId });
  assert.equal(listed.structuredContent.items.length, 1);
  const tipped = await call("report_tip", {
    roomId: created.roomId, itemId: added.structuredContent.item.itemId, sourceRevision: "rev-mcp"
  });
  assert.deepEqual(tipped.structuredContent.changed, ["tip"]);
  const removed = await call("remove_land_item", {
    roomId: created.roomId, itemId: added.structuredContent.item.itemId
  });
  assert.equal(removed.structuredContent.removed, true);
  assert.equal(JSON.stringify(added).includes(owner.secret), false);
});

test("the board card shows the pull request, short head, checks, behind, and tip", () => {
  assert.equal(shortSha(SHA), "aaaaaaa");
  assert.equal(shortSha("abc"), "");
  const html = landCardHtml({
    prNumber: 969,
    title: `<script>alert("x")</script>`,
    url: "https://github.com/acme/demo/pull/969",
    headSha: SHA,
    checks: "green",
    behind: true,
    mergedSha: null,
    tip: { sourceRevision: "rev", buildId: null }
  });
  assert.match(html, /#969/);
  assert.match(html, /land-checks-green/);
  assert.match(html, /aaaaaaa/);
  assert.match(html, /behind/);
  assert.match(html, />tip</);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(page, /id="land-queue-panel"/);
  assert.match(page, /id="land-queue-list"/);
  const worker = readFileSync(new URL("../cloudflare/room.mjs", import.meta.url), "utf8");
  assert.match(worker, /room\.refreshLandQueue\(\)/);
});
