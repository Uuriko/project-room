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

test("browser refresh negotiates offers without claiming support on an older response", async () => {
  const seen = [], requests = [], client = new RoomClient({ onSnapshot: value => seen.push(value),
    fetcher: async (url, options) => { requests.push({ url, options }); return response(snapshot(1)); } });
  client.session = identity();
  await client.refresh();
  assert.equal(requests.length, 1); assert.equal(requests[0].options.headers["X-Project-Room-Offer-Context"], "1");
  assert.equal(seen[0].offerContextVersion, undefined);
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
test("a room-cookie session without an account owns its own snapshot (join-flow restore)", async () => {
  // Regression: #720's ownsResponse required session.account, so refresh()
  // endAccess()ed every join-flow / access-key browser session and
  // restore() returned null — stranding fresh joiners at the account gate
  // despite a valid __Host-room_session cookie.
  const binding = "session-agent-1";
  const roomSession = { authMode: "room", account: null, member: { id: "agent-1" }, roomId: "commons", csrf: null, sessionBinding: binding };
  const roomSnapshot = { sequence: 8, roomId: "commons", state: {}, cursor: 0, viewerId: "agent-1", viewerAccountId: null, viewerAuthEpoch: null, viewerSessionBinding: binding };
  const client = new RoomClient({ fetcher: async () => response(roomSnapshot) });
  assert.equal(client.ownsResponse(roomSnapshot, roomSession), true);
  let ended = false, shown = false;
  const live = new RoomClient({ fetcher: async () => response(roomSnapshot), onAccessEnded: () => ended = true, onSnapshot: () => shown = true });
  live.session = roomSession;
  await live.refresh();
  assert.equal(ended, false, "a valid room session must survive refresh");
  assert.equal(shown, true);
  assert.equal(live.session, roomSession);
  for (const wrong of [
    { ...roomSnapshot, roomId: "elsewhere" },
    { ...roomSnapshot, viewerId: "intruder" },
    { ...roomSnapshot, viewerSessionBinding: "replacement-session" },
  ]) {
    assert.equal(client.ownsResponse(wrong, roomSession), false, "mismatched room/viewer/binding still rejected");
  }
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

test("HTML export carries the account headers, hands back a Blob and treats anything but text/html as an error", async () => {
  const requests = [], html = "<!doctype html><title>Room</title><p>End of export: 3 events rendered, through sequence 3.</p>";
  const fileResponse = (body, type, status = 200) => ({ ok: status < 400, status, headers: { get: name => name === "content-type" ? type : null },
    json: async () => JSON.parse(body), blob: async () => new Blob([body], { type }) });
  const client = new RoomClient({ fetcher: async (url, options) => { requests.push({ url, options }); return fileResponse(html, "text/html; charset=utf-8"); } });
  client.session = { ...identity(), authMode: "account" };
  client.accountOwnership = null;
  client.accountClient = null;
  // ownsAccountSession() is false without an owning account client: the export must refuse rather than send.
  await assert.rejects(client.exportHtml(), /Account session changed/);
  assert.equal(requests.length, 0);

  const roomClient = new RoomClient({ fetcher: async (url, options) => { requests.push({ url, options }); return fileResponse(html, "text/html; charset=utf-8"); } });
  roomClient.session = identity();
  const { blob, filename } = await roomClient.exportHtml();
  assert.equal(filename, "room-commons-export.html");
  assert.equal(await blob.text(), html);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/rooms/commons/export?format=html");
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[0].options.credentials, "same-origin");
  assert.deepEqual(requests[0].options.headers, {}, "room mode sends no account headers");

  const accountClient = { session: identity(), generation: 0 };
  const bound = new RoomClient({ accountClient, fetcher: async (url, options) => { requests.push({ url, options }); return fileResponse(html, "text/html; charset=utf-8"); } });
  bound.session = { ...accountClient.session, authMode: "account" };
  bound.accountOwnership = { client: accountClient, generation: 0, session: accountClient.session };
  await bound.exportHtml();
  assert.deepEqual(requests[1].options.headers, { "X-Project-Room-Auth": "account", "X-Session-Binding": "session-human" });

  const ended = [];
  const denied = new RoomClient({ onAccessEnded: () => ended.push(true), fetcher: async () => fileResponse(JSON.stringify({ error: { code: "access_denied", message: "Access ended" } }), "application/json", 403) });
  denied.session = identity();
  await assert.rejects(denied.exportHtml(), error => error.status === 403 && error.code === "access_denied");
  assert.equal(ended.length, 1, "a 403 ends the client's access like every other room read");

  const wrong = new RoomClient({ fetcher: async () => fileResponse("{\"sequence\":1}\n", "application/x-ndjson; charset=utf-8") });
  wrong.session = identity();
  await assert.rejects(wrong.exportHtml(), error => error.code === "invalid_response");
});
test("a DM consent gate refusal on send keeps the session and surfaces the code", async () => {
  for (const code of ["dm_consent_required", "dm_blocked"]) {
    const ended = [];
    const client = new RoomClient({ onAccessEnded: () => ended.push(true),
      fetcher: async () => response({ error: { code, message: "refused" } }, 403) });
    client.session = identity();
    const generation = client.generation;
    await assert.rejects(
      client.send({ id: "dm1", type: "message.posted", data: { body: "hi", toMemberId: "bob" } }),
      error => error.status === 403 && error.code === code);
    assert.equal(ended.length, 0, `${code} is an application refusal, not an auth failure`);
    assert.equal(client.generation, generation, "the generation is untouched");
    assert.ok(client.session, "the session survives a consent refusal");
  }
});
test("a bond gate refusal on send keeps the session and surfaces the code", async () => {
  for (const code of ["no_bond", "bond_pending", "bond_revoked", "scope_denied", "bond_not_recipient"]) {
    const ended = [];
    const client = new RoomClient({ onAccessEnded: () => ended.push(true),
      fetcher: async () => response({ error: { code, message: "refused" } }, 403) });
    client.session = identity();
    const generation = client.generation;
    await assert.rejects(
      client.send({ id: "bond1", type: "dm.posted", data: { to: "ai_peer", body: "hi", messageId: "m1" } }),
      error => error.status === 403 && error.code === code);
    assert.equal(ended.length, 0, `${code} is an application refusal, not an auth failure`);
    assert.equal(client.generation, generation, "the generation is untouched");
    assert.ok(client.session, "the session survives a bond refusal");
  }
});
test("trust_off on send keeps the session", async () => {
  const ended = [];
  const client = new RoomClient({ onAccessEnded: () => ended.push(true),
    fetcher: async () => response({ error: { code: "trust_off", message: "Room Trust is off" } }, 403) });
  client.session = identity();
  await assert.rejects(client.send({ id: "wake1", type: "agent.wake", data: {} }), error => error.code === "trust_off");
  assert.equal(ended.length, 0);
  assert.ok(client.session);
});
test("other 403s on send still end access", async () => {
  const ended = [];
  const client = new RoomClient({ onAccessEnded: () => ended.push(true),
    fetcher: async () => response({ error: { code: "access_denied", message: "no" } }, 403) });
  client.session = identity();
  await assert.rejects(client.send({ id: "x", type: "message.posted", data: {} }), /no/);
  assert.equal(ended.length, 1, "a real access failure still ends the session");
});

// Request-count regressions guard the transport boundary: one snapshot should
// satisfy both a command receipt and its stream notification. Existing refresh
// tests cover unsequenced callers but cannot detect duplicate network traffic.
function liveRefreshFixture(t, snapshotRead = async sequence => response(snapshot(sequence))) {
  let stream, reads = 0, current = 9;
  class Events extends EventTarget {
    constructor() { super(); stream = this; }
    close() {}
  }
  const event = sequence => ({ sequence, event: { id: `event-${sequence}`, roomId: 'commons', type: 'message.posted' } });
  const seen = [];
  const client = new RoomClient({ events: Events, onSnapshot: value => seen.push(value.sequence), fetcher: async (url, options) => {
    if (url === '/api/rooms/commons/commands' && options.method === 'POST') return response(event(current));
    assert.equal(url, '/api/rooms/commons', 'unexpected transport request');
    assert.equal(options.method, 'GET');
    reads++;
    return snapshotRead(current, reads);
  } });
  client.session = identity(); client.connect();
  t.after(() => client.disconnect());
  return { client, seen, reads: () => reads, setSequence: value => { current = value; }, event,
    notify: (value = event(current)) => stream.dispatchEvent(new MessageEvent('room-event', { data: JSON.stringify(value) })),
    emit: type => stream.dispatchEvent(new Event(type)) };
}

test('a command and its stream notifications need only one snapshot in either arrival order', async t => {
  for (const order of ['stream-first', 'command-first', 'overlapping']) await t.test(order, async t => {
    const pending = deferred();
    const f = liveRefreshFixture(t, async sequence => { if (order === 'overlapping') await pending.promise; return response(snapshot(sequence)); });
    if (order !== 'command-first') f.notify();
    if (order === 'stream-first') await f.client.flight.promise;
    const sent = f.client.send({ id: order, type: 'message.posted', data: { body: 'hello' } });
    if (order === 'overlapping') {
      // Let the committed command join the pending stream read.
      await new Promise(resolve => setImmediate(resolve));
      pending.resolve();
    }
    await sent;
    f.notify(); await f.client.flight?.promise;
    assert.equal(f.reads(), 1, order);
    assert.deepEqual(f.seen, [9], order);
  });
});

test('a newer notification during a stale snapshot still triggers a follow-up read', async t => {
  const pending = deferred();
  const f = liveRefreshFixture(t, async (sequence, read) => read === 1 ? pending.promise : response(snapshot(sequence)));
  f.setSequence(8); f.notify();
  f.setSequence(9); f.notify();
  pending.resolve(response(snapshot(8)));
  await f.client.flight.promise;
  assert.equal(f.reads(), 2);
  assert.deepEqual(f.seen, [8, 9]);
});

test('unknown event hints and reconnects still fetch snapshots even when room sequence is unchanged', async t => {
  const f = liveRefreshFixture(t);
  f.notify(); await f.client.flight.promise;
  const unknown = [null, {}, { sequence: 9, event: null }, f.event('9'), f.event(-1), f.event(0), f.event(1.5), f.event(Number.MAX_SAFE_INTEGER + 1),
    { sequence: 9, event: { roomId: 'other-room' } }];
  for (const value of unknown) {
    const before = f.reads();
    f.notify(value); await f.client.flight.promise;
    assert.equal(f.reads(), before + 1);
  }
  for (const type of ['open', 'error']) {
    const before = f.reads(); f.emit(type); await f.client.flight.promise;
    assert.equal(f.reads(), before + 1, type);
  }
  const before = f.reads();
  await f.client.refresh();
  assert.equal(f.reads(), before + 1, 'manual refresh');
});
