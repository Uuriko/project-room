import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RoomClient, draftCommand } from "../src/client.js";

const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const accountId = memberId => `account-${memberId}`;
const sessionBinding = memberId => `session-${memberId}`;
const snapshot = (sequence, viewerId = "human", viewerAccountId = accountId(viewerId), viewerAuthEpoch = 0, roomId = "commons", viewerSessionBinding = sessionBinding(viewerId)) => ({ sequence, roomId, state: {}, cursor: 0, viewerId, viewerAccountId, viewerAuthEpoch, viewerSessionBinding });
const identity = (id = "human", account = accountId(id), authEpoch = 0, binding = sessionBinding(id)) => ({ account: { id: account, authEpoch }, member: { id }, roomId: "commons", csrf: "session-confirmation", sessionBinding: binding });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
test("unchanged draft retries retain ID and content changes require a new ID", () => {
  const first = draftCommand(null, "message.posted", { body: "hello" });
  assert.equal(draftCommand(first, "message.posted", { body: "hello" }), first);
  assert.notEqual(draftCommand(first, "message.posted", { body: "changed" }).command.id, first.command.id);
});
test("failed command leaves retry object unchanged and never reports a receipt", async () => {
  const client = new RoomClient({ fetcher: async () => response({ error: { message: "Stale revision" } }, 409) });
  client.session = identity();
  const pending = draftCommand(null, "work.started", { workItemId: "work", expectedRevision: 0 });
  const before = JSON.stringify(pending);
  await assert.rejects(client.send(pending.command), /Stale revision/);
  assert.equal(JSON.stringify(pending), before);
});
test("committed command is not reported as failed when the refresh disconnects", async () => {
  let calls = 0, status = "";
  const client = new RoomClient({ fetcher: async () => { if (calls++ === 0) return response({ sequence: 9 }); throw new Error("offline"); }, onStatus: text => status = text });
  client.session = identity();
  assert.equal((await client.send({ id: "one", type: "message.posted", data: { body: "hello" } })).sequence, 9);
  assert.match(status, /interrupted/);
});
test("simultaneous refreshes coalesce and do not drop a pending newer event", async () => {
  let release, calls = 0; const seen = [];
  const client = new RoomClient({ fetcher: async () => { calls++; if (calls === 1) return new Promise(resolve => release = () => resolve(response(snapshot(4)))); return response(snapshot(5)); }, onSnapshot: s => seen.push(s.sequence) });
  client.session = identity();
  const first = client.refresh(), second = client.refresh();
  release(); await Promise.all([first, second]);
  assert.deepEqual(seen, [4, 5]); assert.equal(calls, 2);
});
test("late old-session snapshots cannot repopulate a signed-out or switched account", async () => {
  let release; const seen = [];
  const client = new RoomClient({ fetcher: () => new Promise(resolve => release = () => resolve(response(snapshot(99)))), onSnapshot: s => seen.push(s.sequence) });
  client.session = identity();
  const old = client.refresh(); client.endAccess(); release(); await old;
  assert.deepEqual(seen, []); assert.equal(client.session, null);
  client.fetcher = async () => response(snapshot(2, "other")); client.session = identity("other");
  await client.refresh(); assert.deepEqual(seen, [2]);
});
test("cookie account changes are detected before displaying an incorrectly attributed room", async () => {
  let ended = false, shown = false;
  const client = new RoomClient({ fetcher: async () => response(snapshot(8, "other")), onAccessEnded: () => ended = true, onSnapshot: () => shown = true });
  client.session = identity(); await client.refresh();
  assert.equal(ended, true); assert.equal(shown, false);
});
test("a matching Room member cannot own a response from another account, auth epoch, Room, or browser session", async () => {
  for (const wrong of [
    snapshot(8, "human", "account-other", 0),
    snapshot(8, "human", "account-human", 1),
    snapshot(8, "human", "account-human", 0, "elsewhere"),
    snapshot(8, "human", "account-human", 0, "commons", "replacement-session")
  ]) {
    let ended = false, shown = false;
    const client = new RoomClient({ fetcher: async () => response(wrong), onAccessEnded: () => ended = true, onSnapshot: () => shown = true });
    client.session = identity(); await client.refresh();
    assert.equal(ended, true); assert.equal(shown, false);
  }
});
test("a browser session without canonical account ownership fails closed", async () => {
  let ended = 0;
  const client = new RoomClient({ fetcher: async () => response({ ...snapshot(4), viewerAccountId: undefined, viewerAuthEpoch: undefined }), onAccessEnded: () => { ended++; } });
  client.session = { member: { id: "human" }, roomId: "commons", csrf: "session-confirmation" };
  await client.refresh();
  assert.equal(ended, 1);
  assert.equal(client.session, null);
});
test("an obsolete snapshot failure is suppressed before a new session's error handler", async () => {
  let reject;
  const client = new RoomClient({ fetcher: () => new Promise((resolve, fail) => reject = fail) });
  client.session = identity();
  const old = client.refresh(); client.disconnect(); client.session = identity("other");
  reject(Object.assign(new Error("Old session ended"), { status: 401 }));
  await old;
  assert.equal(client.session.member.id, "other");
});
test("a late command receipt never refreshes or ends a different session", async () => {
  for (const status of [201, 401]) {
    let release, calls = 0, ended = false;
    const client = new RoomClient({ fetcher: () => { calls++; return new Promise(resolve => release = () => resolve(response(status === 201 ? { sequence: 9 } : { error: { message: "Old session ended" } }, status))); }, onAccessEnded: () => ended = true });
    client.session = identity();
    const sent = client.send({ id: "late", type: "message.posted", data: { body: "Old room" } });
    client.disconnect(); client.session = identity("other");
    release();
    if (status === 201) await sent; else await assert.rejects(sent, /Old session/);
    assert.equal(calls, 1); assert.equal(ended, false); assert.equal(client.session.member.id, "other");
  }
});
test("a delayed restore cannot replace a newer explicit login", async () => {
  const oldRestore = deferred();
  const seen = [];
  const client = new RoomClient({
    events: null,
    fetcher: async (path, options) => {
      if (path === "/api/session" && options.method === "GET") return oldRestore.promise;
      if (path === "/api/session" && options.method === "POST") return response(identity("other"), 201);
      if (path === "/api/rooms/commons") return response(snapshot(7, "other"));
      throw new Error(`Unexpected request: ${options.method} ${path}`);
    },
    onSnapshot: (value, current) => seen.push([value.sequence, current.member.id])
  });

  const restoring = client.restore();
  const loggedIn = await client.login("new-account-key");
  oldRestore.resolve(response(identity("human")));
  assert.equal(await restoring, null);
  assert.equal(loggedIn.member.id, "other");
  assert.equal(client.session.member.id, "other");
  assert.deepEqual(seen, [[7, "other"]]);
});
test("a stale refresh failure cannot end or mutate a replacement session", async () => {
  const oldRefresh = deferred();
  let ended = 0;
  const client = new RoomClient({ fetcher: async () => oldRefresh.promise, onAccessEnded: () => { ended++; } });
  client.session = identity();
  const pending = client.refresh();
  client.disconnect();
  client.session = identity("other");
  client.sequence = 3;
  oldRefresh.resolve(response({ error: { message: "Old session revoked" } }, 401));
  await pending;
  assert.equal(ended, 0);
  assert.equal(client.session.member.id, "other");
  assert.equal(client.sequence, 3);
});
test("restore and login clear partial identity when their current refresh fails", async () => {
  for (const method of ["restore", "login"]) {
    let calls = 0;
    const client = new RoomClient({
      events: null,
      fetcher: async () => calls++ === 0
        ? response(identity())
        : response({ error: { message: "Snapshot unavailable" } }, 503)
    });
    await assert.rejects(method === "restore" ? client.restore() : client.login("key"), /Snapshot unavailable/);
    assert.equal(client.session, null);
    assert.equal(client.sequence, 0);
  }
});
test("a coalesced refresh failure clears a snapshot already exposed during login or restore", async () => {
  for (const method of ["restore", "login"]) {
    let calls = 0, shown = 0, cleared = 0;
    let client;
    client = new RoomClient({
      events: null,
      fetcher: async () => {
        calls++;
        if (calls === 1) return response(identity());
        if (calls === 2) return response(snapshot(1));
        return response({ error: { message: "Follow-up snapshot failed" } }, 503);
      },
      onSnapshot: () => {
        shown++;
        client.refresh(); // coalesce one more read into the active refresh flight
      },
      onAccessEnded: () => { cleared++; }
    });
    await assert.rejects(method === "restore" ? client.restore() : client.login("key"), /Follow-up snapshot failed/);
    assert.equal(shown, 1);
    assert.equal(cleared, 1);
    assert.equal(client.session, null);
    assert.equal(client.sequence, 0);
  }
});
test("return briefs are bound to the current viewer, account epoch, Room, and browser session", async () => {
  for (const mismatch of [
    { viewerId: "other", viewerAccountId: "account-human", viewerAuthEpoch: 0, viewerSessionBinding: "session-human", roomId: "commons" },
    { viewerId: "human", viewerAccountId: "account-other", viewerAuthEpoch: 0, viewerSessionBinding: "session-human", roomId: "commons" },
    { viewerId: "human", viewerAccountId: "account-human", viewerAuthEpoch: 1, viewerSessionBinding: "session-human", roomId: "commons" },
    { viewerId: "human", viewerAccountId: "account-human", viewerAuthEpoch: 0, viewerSessionBinding: "session-human", roomId: "elsewhere" },
    { viewerId: "human", viewerAccountId: "account-human", viewerAuthEpoch: 0, viewerSessionBinding: "replacement-session", roomId: "commons" }
  ]) {
    let ended = 0;
    const client = new RoomClient({
      fetcher: async () => response({ ...mismatch, history: {}, current: {} }),
      onAccessEnded: () => { ended++; }
    });
    client.session = identity();
    assert.equal(await client.returnBrief(), null);
    assert.equal(ended, 1);
    assert.equal(client.session, null);
  }
});
test("a delayed logout response cannot end a replacement session", async () => {
  const deletion = deferred();
  let ended = 0;
  const client = new RoomClient({ fetcher: async () => deletion.promise, onAccessEnded: () => { ended++; } });
  client.session = identity();
  const loggingOut = client.logout();
  client.disconnect();
  client.session = identity("other");
  deletion.resolve(response({ ok: true }));
  await loggingOut;
  assert.equal(ended, 0);
  assert.equal(client.session.member.id, "other");
});
test("connected UI hooks exist and demo controls are not exposed", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of app.matchAll(/\$\("#([a-z-]+)"\)/g)) assert.ok(ids.includes(match[1]), `Missing UI hook ${match[1]}`);
  assert.doesNotMatch(app, /from "\.\/(seed|storage)\.js"/);
  assert.doesNotMatch(html, /actor-select|reset-button|4 here now|Simulate actor/);
  assert.match(html, /id="main"[^>]*hidden/);
});
