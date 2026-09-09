import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { AssignmentWatcher } from "../client/assignment-watcher.mjs";
import { currentAttention } from "../client/attention-inbox.mjs";
import { WatchJournal } from "../client/watch-journal.mjs";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-read-budget-"));
  let now = Date.now(), serial = 0;
  const store = new RoomStore(":memory:", { now: () => now }); store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const send = (type, data) => store.command(owner, "commons", { id: `budget-${++serial}`, type, data });
  send("member.added", { memberId: "agent", displayName: "Test agent", kind: "agent", accountableHumanId: "owner", permissions: ["accept_work"] });
  const token = store.issueAccessKey("commons", "agent", 60000);
  send("work.proposed", { workItemId: "task", title: "A synthetic check", definitionOfDone: "Report a finding", accountableMemberId: "agent", mode: "read" });
  const server = createRoomServer({ store }), requests = [];
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  server.prependListener("request", req => requests.push({ method: req.method, path: req.url }));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const makeClient = (fetchImpl = fetch) => new RoomAgentClient({ origin, roomId: "commons", memberId: "agent", token, fetchImpl });
  const config = { client: makeClient(), origin, roomId: "commons", directory: join(directory, "attention") };
  return { store, token, send, config, requests, makeClient, advance: ms => now += ms,
    async pull(options = {}) { requests.length = 0; return currentAttention({ ...config, ...options }); },
    local() {
      const journal = new WatchJournal(config.directory, { version: 2, create: false });
      try {
        // A successful first pass may update checked-at before the second refuses.
        // Compare retained identity, history and pending content, not that timestamp.
        const { lastCheckedAt, ...state } = journal.state();
        return { state, pending: journal.pending(20) };
      } finally { journal.close(); }
    }
  };
}

function checkedRequests(requests, expected) {
  assert.equal(requests.length, expected);
  for (let i = 0; i < requests.length; i += 2) {
    assert.deepEqual(requests[i], { method: "GET", path: "/api/session" });
    assert.equal(requests[i + 1].method, "GET");
    assert.match(requests[i + 1].path, /^\/api\/rooms\/commons(?:$|\/events\?)/);
  }
}

test("pinned attention uses 12 GETs for cold, steady, reopened and exact-ack observations", async t => {
  const f = await fixture(t), before = f.store.snapshot(f.token, "commons");
  const first = await f.pull(); checkedRequests(f.requests, 12);
  const expected = ["/api/rooms/commons", "/api/rooms/commons/events?after=0&limit=1", `/api/rooms/commons/events?after=${before.sequence - 1}&limit=1`];
  assert.deepEqual(f.requests.filter(r => r.path !== "/api/session").map(r => r.path), [...expected, ...expected]);
  assert.deepEqual((await f.pull()).items, first.items); checkedRequests(f.requests, 12);
  assert.deepEqual((await f.pull({ client: f.makeClient() })).items, first.items); checkedRequests(f.requests, 12);
  assert.equal((await f.pull({ noticeId: first.items[0].id })).status, "acknowledged"); checkedRequests(f.requests, 12);
  assert.equal((await f.pull({ noticeId: first.items[0].id })).status, "already_acknowledged"); checkedRequests(f.requests, 12);
  assert.deepEqual(f.store.snapshot(f.token, "commons"), before);
});

test("advanced checkpoints remain separate reads, not a universal request cap", async t => {
  const f = await fixture(t); await f.pull();
  f.send("message.posted", { body: "An unrelated later event" });
  await f.pull(); checkedRequests(f.requests, 14);
  let snapshots = 0;
  const client = f.makeClient(async (url, options) => {
    if (new URL(url).pathname === "/api/rooms/commons") {
      f.send("message.posted", { body: `Another event before observation ${++snapshots}` });
    }
    return fetch(url, options);
  });
  await f.pull({ client }); checkedRequests(f.requests, 16); assert.equal(snapshots, 2);
});

test("second-pass changed creation or checkpoint anchors refuse before acknowledgement", async t => {
  for (const subject of ["creation", "checkpoint", "snapshot-tail"]) await t.test(subject, async sub => {
    const f = await fixture(sub), first = await f.pull(), before = f.local(); let snapshots = 0;
    const client = f.makeClient(async (url, options) => {
      const path = new URL(url).pathname;
      if (path === "/api/rooms/commons") snapshots++;
      const response = await fetch(url, options);
      if (snapshots !== 2 || !response.ok) return response;
      const value = await response.json(), after = new URL(url).searchParams.get("after");
      if (subject === "snapshot-tail" && path === "/api/rooms/commons") value.state.eventLog.at(-1).id = "changed-snapshot-tail";
      if (subject !== "snapshot-tail" && path.endsWith("/events") && after === String(subject === "creation" ? 0 : before.state.sequence - 1)) value.events[0].event.id = "changed-history";
      return Response.json(value);
    });
    await assert.rejects(f.pull({ client, noticeId: first.items[0].id }), { code: subject === "creation" ? "identity_changed" : "history_changed" });
    assert.deepEqual(f.local(), before); assert.equal(snapshots, 2);
  });
});

test("final-pass revocation, expiry and wrong-member metadata do not reuse earlier authorization", async t => {
  for (const cause of ["revoked", "expired", "wrong-member"]) await t.test(cause, async sub => {
    const f = await fixture(sub), first = await f.pull(), before = f.local(); let checks = 0;
    const client = f.makeClient(async (url, options) => {
      if (new URL(url).pathname === "/api/session" && ++checks === 4) {
        if (cause === "revoked") f.store.revoke(f.token);
        if (cause === "expired") f.advance(60000);
        if (cause === "wrong-member") {
          const value = await (await fetch(url, options)).json(); value.member.id = "different-agent";
          return Response.json(value);
        }
      }
      return fetch(url, options);
    });
    await assert.rejects(f.pull({ client, noticeId: first.items[0].id }), { code: cause === "wrong-member" ? "identity_mismatch" : "unauthenticated" });
    assert.equal(checks, 4); assert.deepEqual(f.local(), before);
  });
});

test("cancelled shared-anchor response cannot acknowledge; retry reads fresh anchors", async t => {
  const f = await fixture(t), first = await f.pull(), before = f.local();
  const controller = new AbortController(); let tails = 0;
  const client = f.makeClient(async (url, options) => {
    const response = await fetch(url, options);
    if (new URL(url).searchParams.get("after") === String(before.state.sequence - 1) && ++tails === 2) {
      const value = await response.json();
      controller.abort();
      // Simulate a transport returning fulfilled data after cancellation.
      return Response.json(value);
    }
    return response;
  });
  await assert.rejects(f.pull({ client, signal: controller.signal, noticeId: first.items[0].id }), { code: "stopped" });
  assert.equal(tails, 2); assert.deepEqual(f.local(), before);
  assert.deepEqual((await f.pull()).items, first.items); checkedRequests(f.requests, 12);
});

test("synthetic v1 single-event observations deduplicate within a pass, never across passes", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-anchor-one-")), store = new RoomStore(":memory:");
  store.initialize(initialRoom()); const token = store.issueAccessKey("commons", "owner"), calls = [];
  const journal = new WatchJournal(join(directory, "watch"));
  t.after(() => { journal.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  // Exercise the minimum accepted observer shape; production initialization also
  // appends member enrollment, so this single-event observation is synthetic.
  const client = { snapshot: async () => { const s = store.snapshot(token, "commons"); s.sequence = 1; s.state.eventLog = [s.state.eventLog[0]]; return s; },
    changes: async (after, limit) => { calls.push(after); return store.eventsAfter(token, "commons", after, limit); } };
  const watcher = new AssignmentWatcher({ client, journal, origin: "http://127.0.0.1:1234", roomId: "commons" });
  await watcher.reconcile(); await watcher.reconcile();
  assert.deepEqual(calls, [0, 0]); assert.equal(journal.state().sequence, 1);
  const prior = journal.state(), rawSnapshot = client.snapshot;
  client.snapshot = async () => { const s = await rawSnapshot(); s.state.eventLog[0].id = "wrong-tail"; return s; };
  await assert.rejects(watcher.reconcile(), { code: "history_changed" });
  assert.deepEqual(journal.state(), prior); assert.deepEqual(calls, [0, 0, 0]);
});
