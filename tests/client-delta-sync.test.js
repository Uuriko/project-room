// Delta sync: covered message events advance the held snapshot locally.
//
// The stream frame already carries the full event, so for message.posted /
// edited / deleted / redacted in the viewed room the client applies the
// shared reducer to the snapshot it holds and emits the result — no snapshot
// re-read at all. Anything else (a sequence gap, a partial history, an
// unknown type, a state the reducer cannot advance) falls back to the
// refresh() read path, and the fallback must self-heal: the read brings the
// client to the event's sequence with the event's effect included.
//
// The load path is covered too: after a windowed first read, history is
// paged in over /conversation and merged only when the segment provably
// continues the window; otherwise the legacy full fill runs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomClient } from "../src/client.js";
import { event, EVENT_TYPES as T, PERMISSIONS } from "../src/events.js";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const FULL = "/api/rooms/commons", RECENT = "/api/rooms/commons?messages=recent";
const response = body => ({ ok: true, status: 200, json: async () => body });
const owner = { roomId: "commons", cursor: 0, viewerId: "human", viewerAccountId: "account-human", viewerAuthEpoch: 0, viewerSessionBinding: "session-human" };
const identity = () => ({ account: { id: "account-human", authEpoch: 0 }, member: { id: "human" }, roomId: "commons", csrf: "c", sessionBinding: "session-human" });
const at = n => new Date(Date.parse("2026-10-01T00:00:00Z") + n * 1000).toISOString();
const member = { id: "human", displayName: "Human", kind: "human", role: "owner", active: true, joinedAt: at(0), color: null, avatarUrl: null, bio: "", links: [] };
const channel = { id: "general", name: "General", topic: "", createdBy: "human", createdAt: at(0), archivedAt: null, position: 0 };
const record = (id, n, extra = {}) => ({ id, authorId: "human", body: `body ${id}`, channelId: "general", at: at(n), replyToId: null, editedAt: null, deletedAt: null, redactedAt: null, pinnedAt: null, revision: 0, ...extra });
const history = () => ["m1", "m2", "m3", "m4", "m5"].map((id, i) => record(id, i + 1));
// A state in the shape the server actually serves: the shared reducer can
// advance it (members/channels as id-keyed maps, replay bookkeeping compact).
const state = messages => ({
  room: { id: "commons", name: "Commons", createdBy: "human", createdAt: at(0) },
  members: { human: member }, channels: { general: channel }, messages, pins: [], workItems: {},
  eventLog: [], seenEvents: {}, seenIdempotencyKeys: {}
});
const full = (sequence, messages) => ({ ...owner, sequence, state: state(messages) });
const recent = (sequence, messages, omitted) => ({ ...owner, sequence, state: state(messages),
  messagesWindow: { mode: "recent", limit: 3, omitted, older: "conversation" } });
const page = (sequence, messages, nextCursor) => ({ ...owner, generatedAt: at(99), conversationVersion: 1, mode: "replace",
  limit: 100, messageId: null, channelId: null, checkpoint: null, sequence, messages, nextCursor, hasMore: nextCursor !== null });
const envelope = (type, n, data) => event({ type, actorId: "human", roomId: "commons", at: at(n), data });
const receipt = (sequence, env) => ({ sequence, event: env });

function fixture(t, route) {
  let stream;
  class Events extends EventTarget { constructor() { super(); stream = this; } close() {} }
  const reads = [], pages = [], seen = [];
  const client = new RoomClient({ events: Events, onSnapshot: value => seen.push(value), fetcher: async (url, options) => {
    if (url === "/api/rooms/commons/commands" && options?.method === "POST") return response(route.receipt);
    if (url.startsWith("/api/rooms/commons/conversation")) { pages.push(url); return response(route.page(url)); }
    reads.push(url);
    return response(route.read(url));
  } });
  client.session = identity();
  t.after(() => client.disconnect());
  const notify = value => stream.dispatchEvent(new MessageEvent("room-event", { data: JSON.stringify(value) }));
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await client.flight?.promise; };
  const warm = async () => { await client.refresh(); client.connect(); await settle(); reads.length = 0; };
  return { client, reads, pages, seen, notify, settle, warm };
}

test("a stream message.posted applies locally with no snapshot re-read", async t => {
  const f = fixture(t, { read: () => full(9, history()), page: () => assert.fail("no paging for a complete client") });
  await f.warm();
  const posted = envelope(T.MESSAGE_POSTED, 10, { body: "fresh", channelId: "general" });
  f.notify(receipt(10, posted)); await f.settle();
  assert.deepEqual(f.reads, [], "the delta replaced the refetch");
  const last = f.seen.at(-1);
  assert.equal(last.sequence, 10);
  assert.equal(last.state.messages.length, 6);
  assert.equal(last.state.messages.at(-1).body, "fresh");
  assert.equal(last.state.eventLog.at(-1).id, posted.id);
  assert.equal(f.client.deltaStats.applied, 1);
  assert.equal(f.client.deltaStats.fallback, 0);
});

test("a message.edited delta rewrites the record and serves read-model history", async t => {
  const f = fixture(t, { read: () => full(9, history()), page: () => assert.fail("no paging") });
  await f.warm();
  // Seed the held tail as a fresh snapshot would carry it: m2's post entry
  // shows its then-current body.
  const posted = envelope(T.MESSAGE_POSTED, 2, { messageId: "m2", body: "body m2", channelId: "general" });
  f.client.live.snapshot.state.eventLog = [posted];
  f.client.rawTail = [posted];
  const edited = envelope(T.MESSAGE_EDITED, 10, { messageId: "m2", body: "edited body", expectedMessageRevision: 0 });
  f.notify(receipt(10, edited)); await f.settle();
  assert.deepEqual(f.reads, []);
  const last = f.seen.at(-1), m2 = last.state.messages.find(message => message.id === "m2");
  assert.equal(m2.body, "edited body");
  assert.ok(Array.isArray(m2.editHistory) && m2.editHistory.length >= 1, "the reducer recorded the edit");
  assert.ok(m2.editHistory.every(entry => !Object.hasOwn(entry, "body")), "edit-history bodies never ride a served record");
  const logged = last.state.eventLog.find(entry => entry.id === posted.id);
  assert.equal(logged.data.body, "edited body", "the log shows only the current body, like a fresh read");
  assert.equal(f.client.deltaStats.applied, 1);
});

test("a message.deleted delta nulls the logged body and a redacted delta applies too", async t => {
  const f = fixture(t, { read: () => full(9, history()), page: () => assert.fail("no paging") });
  await f.warm();
  const posted = envelope(T.MESSAGE_POSTED, 3, { messageId: "m3", body: "body m3", channelId: "general" });
  f.client.live.snapshot.state.eventLog = [posted];
  f.client.rawTail = [posted];
  f.notify(receipt(10, envelope(T.MESSAGE_DELETED, 10, { messageId: "m3", expectedMessageRevision: 0 }))); await f.settle();
  let last = f.seen.at(-1);
  assert.ok(last.state.messages.find(message => message.id === "m3").deletedAt, "the record is marked deleted");
  assert.equal(last.state.eventLog.find(entry => entry.id === posted.id).data.body, null, "the logged body is withdrawn");
  f.notify(receipt(11, envelope(T.MESSAGE_REDACTED, 11, { messageId: "m4" }))); await f.settle();
  last = f.seen.at(-1);
  assert.equal(last.state.messages.find(message => message.id === "m4").body, null);
  assert.deepEqual(f.reads, []);
  assert.equal(f.client.deltaStats.applied, 2);
});

test("a sequence gap falls back to a read and self-heals (the missed delta is not lost)", async t => {
  const grown = [...history(), record("m6", 6), record("m7", 7)];
  let phase = 9;
  const f = fixture(t, { read: () => full(phase, phase === 9 ? history() : grown), page: () => assert.fail("no paging") });
  await f.warm();
  phase = 12;
  // Sequence 11 never arrives; the stream delivers 12.
  f.notify(receipt(12, envelope(T.MESSAGE_POSTED, 12, { messageId: "m7", body: "body m7", channelId: "general" }))); await f.settle();
  assert.equal(f.client.deltaStats.reasons.gap, 1, "the delta declined on the gap");
  assert.ok(f.reads.length >= 1, "the fallback read happened");
  const last = f.seen.at(-1);
  assert.equal(last.sequence, 12);
  assert.deepEqual(last.state.messages.map(message => message.id), ["m1", "m2", "m3", "m4", "m5", "m6", "m7"], "both the missed and the delivered message are held");
});

test("an unknown event type keeps the refetch fallback", async t => {
  let seq = 9;
  const f = fixture(t, { read: () => full(seq, history()), page: () => assert.fail("no paging") });
  await f.warm();
  seq = 10;
  f.notify(receipt(10, envelope("message.reaction_set", 10, { messageId: "m1", emoji: "x", action: "add" }))); await f.settle();
  assert.deepEqual(f.reads, [FULL]);
  assert.equal(f.client.deltaStats.applied, 0);
  assert.equal(f.client.deltaStats.fallback, 0, "non-covered types are the design's fallback, not a delta failure");
});

test("a covered event against a state the reducer cannot advance falls back and counts", async t => {
  const thin = (sequence, messages) => ({ ...owner, sequence, state: { messages, workItems: {}, pins: [] } });
  const f = fixture(t, { read: () => thin(9, history()), page: () => assert.fail("no paging") });
  // Warm manually: the thin state has no channels/members for the reducer.
  await f.client.refresh(); f.client.connect(); await f.settle(); f.reads.length = 0;
  f.notify(receipt(10, envelope(T.MESSAGE_POSTED, 10, { body: "fresh", channelId: "general" }))); await f.settle();
  assert.equal(f.client.deltaStats.applied, 0);
  assert.equal(f.client.deltaStats.fallback, 1);
  assert.ok(f.reads.length >= 1, "the fallback read happened");
});

test("my own send() receipt applies as a delta — no read after posting", async t => {
  const posted = envelope(T.MESSAGE_POSTED, 10, { body: "mine", channelId: "general" });
  const f = fixture(t, { read: () => full(9, history()), page: () => assert.fail("no paging") });
  await f.warm();
  // Route the command POST to the receipt the store would return.
  const route = { receipt: receipt(10, posted) };
  const client2 = f.client;
  const originalFetcher = client2.fetcher;
  client2.fetcher = async (url, options) => url.endsWith("/commands") && options?.method === "POST" ? response(route.receipt) : originalFetcher(url, options);
  await client2.send({ id: "post-1", type: T.MESSAGE_POSTED, data: { body: "mine", channelId: "general" } });
  assert.deepEqual(f.reads, [], "no snapshot read followed the send");
  assert.equal(f.seen.at(-1).state.messages.at(-1).body, "mine");
  assert.equal(client2.deltaStats.applied, 1);
});

test("the background fill pages history over /conversation instead of one full read", async t => {
  const all = history();
  const f = fixture(t, {
    read: url => url === RECENT ? recent(9, all.slice(-3), 2) : assert.fail("the paged fill must not read a full snapshot"),
    page: url => url.includes("cursor=c1") ? page(9, all.slice(0, 2), null) : page(9, all, "c1")
  });
  await f.client.refresh(); // windowed first read: m3..m5 held, m1..m2 owed
  assert.equal(f.client.heldMessages().partial, true);
  await new Promise(resolve => setTimeout(resolve, 400)); // the 250ms fill
  const held = f.client.heldMessages();
  assert.equal(held.partial, false);
  assert.deepEqual(held.messages.map(message => message.id), ["m1", "m2", "m3", "m4", "m5"]);
  assert.equal(f.pages.length, 2, "anchor page plus one older page");
  assert.deepEqual(f.reads, [RECENT], "no full snapshot read at any point");
  assert.deepEqual(f.seen.at(-1).state.messages.map(message => message.id), ["m1", "m2", "m3", "m4", "m5"], "the app was handed the completed history");
});

test("a paged fill that cannot prove the segment falls back to the legacy full read", async t => {
  const all = history();
  const f = fixture(t, {
    read: url => url === RECENT ? recent(9, all.slice(-3), 2) : full(9, all),
    page: url => url.includes("cursor=c1") ? page(9, all.slice(0, 1), null) : page(9, all, "c1") // one older message short
  });
  await f.client.refresh();
  await new Promise(resolve => setTimeout(resolve, 400));
  const held = f.client.heldMessages();
  assert.equal(held.partial, false);
  assert.deepEqual(held.messages.map(message => message.id), ["m1", "m2", "m3", "m4", "m5"]);
  assert.deepEqual(f.reads, [RECENT, FULL], "the short segment was rejected and the full read completed history");
});

// End to end: the real store, HTTP server, login sessions and stream. A
// second member's post and edit must reach the viewing client as deltas —
// its snapshot-read count stays at zero — and the locally advanced state
// must equal what a fresh snapshot serves.
test("end to end: a peer's post and edit arrive as deltas, state identical to a fresh read", async t => {
  const directory = mkdtempSync(join(tmpdir(), "delta-sync-e2e-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const seed = [...initialRoom(),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: "commons", at: at(1), data: { memberId: "member-1", displayName: "Member One", kind: "human", permissions: [...PERMISSIONS] } })];
  for (let i = 0; i < 30; i++) seed.push(event({ type: T.MESSAGE_POSTED, actorId: "owner", roomId: "commons", at: at(10 + i), data: { body: `seed ${i}` } }));
  store.initialize(seed);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams?.(); server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const login = async accessKey => {
    const res = await fetch(`${origin}/api/session`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ accessKey }) });
    assert.ok(res.ok, "login succeeds");
    const cookie = (res.headers.getSetCookie?.() ?? []).map(value => value.split(";")[0]).join("; ");
    return { session: await res.json(), cookie };
  };
  // A minimal EventSource: fetch the stream with the session cookie and
  // dispatch parsed frames, exactly the surface RoomClient consumes.
  const eventsClass = cookie => class extends EventTarget {
    constructor(url) {
      super(); this.readyState = 1; this.controller = new AbortController();
      (async () => {
        try {
          const res = await fetch(new URL(url, origin), { headers: { cookie, accept: "text/event-stream" }, signal: this.controller.signal });
          this.dispatchEvent(new Event("open"));
          const reader = res.body.getReader(), decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
              let type = "message", data = "";
              for (const line of frame.split("\n")) {
                if (line.startsWith("event:")) type = line.slice(6).trim();
                else if (line.startsWith("data:")) data += line.slice(5).trim();
              }
              if (data) this.dispatchEvent(new MessageEvent(type, { data }));
            }
          }
        } catch { /* closed */ }
      })();
    }
    close() { this.readyState = 2; this.controller.abort(); }
  };
  const makeClient = async accessKey => {
    const { session, cookie } = await login(accessKey);
    const reads = { snapshots: 0 };
    const client = new RoomClient({ events: eventsClass(cookie), onSnapshot: () => {}, fetcher: async (url, options = {}) => {
      if ((options.method ?? "GET") === "GET" && /^\/api\/rooms\/commons(\?|$)/.test(url)) reads.snapshots++;
      return fetch(new URL(url, origin), { ...options, headers: { ...(options.headers ?? {}), cookie, origin } });
    } });
    client.session = session;
    t.after(() => client.disconnect());
    return { client, reads };
  };
  const viewer = await makeClient(store.issueAccessKey("commons", "owner"));
  const poster = await makeClient(store.issueAccessKey("commons", "member-1"));
  await viewer.client.refresh(); await poster.client.refresh();
  viewer.client.connect(); poster.client.connect();
  await new Promise(resolve => setTimeout(resolve, 400)); await viewer.client.flight?.promise; await poster.client.flight?.promise;
  viewer.reads.snapshots = 0;
  const before = viewer.client.sequence;
  await poster.client.send({ id: "e2e-post", type: T.MESSAGE_POSTED, data: { body: "hello from member-1" } });
  const postedId = poster.client.live.snapshot.state.messages.at(-1).id;
  for (let i = 0; i < 50 && viewer.client.sequence !== before + 1; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(viewer.client.sequence, before + 1, "the viewer advanced on the stream frame alone");
  assert.equal(viewer.reads.snapshots, 0, "no snapshot re-read for the post");
  assert.equal(viewer.client.live.snapshot.state.messages.at(-1).body, "hello from member-1");
  await poster.client.send({ id: "e2e-edit", type: T.MESSAGE_EDITED, data: { messageId: postedId, body: "edited by member-1", expectedMessageRevision: 0 } });
  for (let i = 0; i < 50 && viewer.client.sequence !== before + 2; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(viewer.client.sequence, before + 2, "the edit also arrived as a delta");
  assert.equal(viewer.reads.snapshots, 0, "no snapshot re-read for the edit");
  assert.equal(viewer.client.deltaStats.applied, 2);
  const fresh = await (await fetch(`${origin}/api/rooms/commons`, { headers: { authorization: `Bearer ${store.issueAccessKey("commons", "owner")}` } })).json();
  assert.deepEqual(viewer.client.live.snapshot.state.messages, fresh.state.messages, "locally advanced history equals the served history");
});
