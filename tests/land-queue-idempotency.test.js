// B6 idempotency audit: requestId support on the land-queue mutating routes.
// Fail-first: every behavioral test below FAILS on the pre-fix code
// (requestId rejected by exact() body checks / ignored by LandQueue;
// remove retry 404s; tip retry returns changed:[] instead of a replay).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
const SHA = "a".repeat(40);
const TOKEN = "<redacted>";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-land-idem-"));
  const clock = { now: Date.parse("2026-10-08T12:00:00Z") };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey, roomId: "commons" };
}

function snapshot() {
  return {
    pr: {
      title: "Land the queue",
      merged: false,
      merge_commit_sha: null,
      mergeable: true,
      mergeable_state: "clean",
      head: { sha: SHA }
    },
    status: { state: "pending" },
    checks: { check_runs: [{ status: "in_progress", conclusion: null }] }
  };
}

function mockGitHub() {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    let body = snapshot().pr;
    if (url.includes("/check-runs")) body = snapshot().checks;
    else if (url.endsWith("/status")) body = snapshot().status;
    return { status: 200, ok: true, json: async () => body };
  };
  return { fetchImpl, calls };
}

function landEvents(store, roomId = "commons") {
  return store.db.prepare(
    "SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.type')=? ORDER BY sequence"
  ).all(roomId, T.LAND_UPDATED).map(row => JSON.parse(row.body));
}

function secondMember(store, ownerKey, name) {
  const identity = store.identities.create(name);
  const linked = store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, displayName: name, permissions: []
  });
  return linked.memberId;
}

function idemRows(store) {
  return store.db.prepare("SELECT * FROM land_queue_idempotency").all();
}

const conflict = error => error?.status === 409 && error?.code === "idempotency_conflict";
const badRequest = (code) => (error) => error?.status === 422 && error?.code === code;

test("remove retry with the same requestId replays the receipt instead of 404", async t => {
  const { store } = fixture(t);
  store.landQueue.configure({ fetchImpl: mockGitHub().fetchImpl });
  const added = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 1 });
  const itemId = added.item.itemId;
  const first = store.landQueue.remove("commons", "owner", { itemId, requestId: "rm-1" });
  assert.deepEqual(first, { roomId: "commons", itemId, removed: true });
  // The item is gone; a keyed retry must replay the original receipt, not 404.
  const replay = store.landQueue.remove("commons", "owner", { itemId, requestId: "rm-1" });
  assert.deepEqual(replay, { roomId: "commons", itemId, removed: true });
  assert.equal(idemRows(store).length, 1);
});

test("requestId reuse across a different op, actor, or input is 409 idempotency_conflict", async t => {
  const { store, ownerKey } = fixture(t);
  store.landQueue.configure({ fetchImpl: mockGitHub().fetchImpl });
  const added = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 2, requestId: "key-1" });
  // Same key, different op.
  assert.throws(
    () => store.landQueue.remove("commons", "owner", { itemId: added.item.itemId, requestId: "key-1" }),
    conflict
  );
  // Same key, same op, different input.
  assert.throws(
    () => store.landQueue.reportTip("commons", "owner", { itemId: "lq_other", sourceRevision: "s", requestId: "key-1" }),
    conflict
  );
  // Same key, same op+input, different actor.
  const peer = secondMember(store, ownerKey, "Peer");
  const added2 = await store.landQueue.add("commons", peer, { repo: "acme/demo", prNumber: 3, requestId: "key-2" });
  assert.throws(
    () => store.landQueue.remove("commons", "owner", { itemId: added2.item.itemId, requestId: "key-2" }),
    conflict
  );
  // Control: a fresh key on the remove replays for the original actor.
  const firstRm = store.landQueue.remove("commons", peer, { itemId: added2.item.itemId, requestId: "key-3" });
  assert.equal(firstRm.removed, true);
  const replay = store.landQueue.remove("commons", peer, { itemId: added2.item.itemId, requestId: "key-3" });
  assert.deepEqual(replay, firstRm);
});

test("add retry with the same requestId replays the stored body with no new GitHub fetch", async t => {
  const { store } = fixture(t);
  const github = mockGitHub();
  store.landQueue.configure({ fetchImpl: github.fetchImpl });
  const first = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 7, requestId: "add-1" });
  const callsAfterFirst = github.calls.length;
  assert.ok(callsAfterFirst > 0, "first add fetched GitHub");
  // Simulate the ambiguous case: the row is gone (or the response was lost).
  store.landQueue.remove("commons", "owner", { itemId: first.item.itemId });
  const replay = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 7, requestId: "add-1" });
  assert.equal(replay.item.itemId, first.item.itemId, "replayed original item id");
  assert.deepEqual(replay, first, "replayed body is byte-identical to the original");
  assert.equal(github.calls.length, callsAfterFirst, "no new GitHub fetch on replay");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM land_queue").get().n, 0,
    "replay created no new row"
  );
});

test("reportTip retry with the same requestId replays changed:['tip'] and emits no second event", async t => {
  const { store } = fixture(t);
  store.landQueue.configure({ fetchImpl: mockGitHub().fetchImpl });
  const added = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 8 });
  const itemId = added.item.itemId;
  const first = store.landQueue.reportTip("commons", "owner", { itemId, sourceRevision: "src-1", requestId: "tip-1" });
  assert.deepEqual(first.changed, ["tip"]);
  const eventsAfterFirst = landEvents(store).length;
  assert.equal(eventsAfterFirst, 1);
  const replay = store.landQueue.reportTip("commons", "owner", { itemId, sourceRevision: "src-1", requestId: "tip-1" });
  assert.deepEqual(replay.changed, ["tip"], "replay returns the original changed payload");
  assert.deepEqual(replay.item, first.item, "replay returns the original item view");
  assert.equal(landEvents(store).length, eventsAfterFirst, "no second land.updated event on replay");
});

test("a second add with the same requestId still in flight is 409, not a duplicate row", async t => {
  const { store } = fixture(t);
  const github = mockGitHub();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const gatedFetch = async url => { await gate; return github.fetchImpl(url); };
  store.landQueue.configure({ fetchImpl: gatedFetch });
  const first = store.landQueue.add("commons", "owner", { repo: "acme/race", prNumber: 1, requestId: "race-1" });
  await new Promise(resolve => setImmediate(resolve)); // let the first call register its key
  await assert.rejects(
    store.landQueue.add("commons", "owner", { repo: "acme/race", prNumber: 1, requestId: "race-1" }),
    conflict
  );
  release();
  const done = await first;
  assert.equal(done.duplicate, false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM land_queue").get().n, 1);
});

test("malformed requestId is 422, not silently ignored", t => {
  const { store } = fixture(t);
  assert.throws(
    () => store.landQueue.remove("commons", "owner", { itemId: "lq_x", requestId: "bad id!" }),
    badRequest("invalid_land_item")
  );
  assert.throws(
    () => store.landQueue.reportTip("commons", "owner", { itemId: "lq_x", requestId: "x".repeat(65) }),
    badRequest("invalid_land_tip")
  );
});

test("without requestId the legacy behavior is unchanged", async t => {
  const { store } = fixture(t);
  store.landQueue.configure({ fetchImpl: mockGitHub().fetchImpl });
  const a = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 9 });
  const b = await store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 9 });
  assert.equal(b.duplicate, true);
  assert.equal(b.item.itemId, a.item.itemId);
  const removed = store.landQueue.remove("commons", "owner", { itemId: a.item.itemId });
  assert.equal(removed.removed, true);
  assert.throws(
    () => store.landQueue.remove("commons", "owner", { itemId: a.item.itemId }),
    error => error?.status === 404 && error?.code === "land_item_not_found"
  );
  assert.equal(idemRows(store).length, 0, "no idempotency rows without requestId");
});

test("REST accepts requestId on the land-queue mutating routes and replays", async t => {
  const { store, ownerKey } = fixture(t);
  store.landQueue.configure({ fetchImpl: mockGitHub().fetchImpl });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${ownerKey}` };
  const post = (path, body) => fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  const r1 = await post("/api/rooms/commons/add_land_item", { repo: "acme/demo", prNumber: 969, requestId: "rest-1" });
  assert.equal(r1.status, 201, "requestId must be an accepted body key");
  const created = await r1.json();
  const r2 = await post("/api/rooms/commons/add_land_item", { repo: "acme/demo", prNumber: 969, requestId: "rest-1" });
  assert.equal(r2.status, 201);
  assert.equal((await r2.json()).item.itemId, created.item.itemId, "REST replay returns the original item");

  const rm1 = await post("/api/rooms/commons/remove_land_item", { itemId: created.item.itemId, requestId: "rest-rm" });
  assert.equal(rm1.status, 200);
  const rm2 = await post("/api/rooms/commons/remove_land_item", { itemId: created.item.itemId, requestId: "rest-rm" });
  assert.equal(rm2.status, 200, "keyed remove retry replays instead of 404");
  assert.equal((await rm2.json()).removed, true);

  const bad = await post("/api/rooms/commons/report_tip", { itemId: "lq_x", requestId: "bad id!" });
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error.code, "invalid_land_tip");

  const clash = await post("/api/rooms/commons/remove_land_item", { itemId: "lq_y", requestId: "rest-1" });
  assert.equal(clash.status, 409);
  assert.equal((await clash.json()).error.code, "idempotency_conflict");
});
