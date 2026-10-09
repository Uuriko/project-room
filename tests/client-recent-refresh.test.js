// Live refreshes re-read only the newest messages.
//
// Every room-event on the stream makes the browser re-read the room snapshot,
// and the full snapshot carries every visible message (muse-room: 5,300+
// messages, 5.2 MB of JSON). A new message or a claim receipt cannot change
// older messages, so those refreshes ask for `?messages=recent` (the newest
// 100) and keep the older history the client already holds. Anything that can
// change an older message (edit, delete, redaction, reaction), any unknown or
// unsequenced hint, a reconnect, or a window that does not line up with what
// the client holds still reads the full snapshot. A server that ignores the
// parameter answers with a full snapshot, which is used as is.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomClient } from "../src/client.js";

const response = body => ({ ok: true, status: 200, json: async () => body });
const owner = { roomId: "commons", cursor: 0, viewerId: "human", viewerAccountId: "account-human", viewerAuthEpoch: 0, viewerSessionBinding: "session-human" };
const identity = () => ({ account: { id: "account-human", authEpoch: 0 }, member: { id: "human" }, roomId: "commons", csrf: "c", sessionBinding: "session-human" });
const message = id => ({ id, authorId: "human", body: `body ${id}`, channelId: "general" });
const ids = list => list.map(item => item.id);
const full = (sequence, messages) => ({ ...owner, sequence, state: { messages, workItems: {}, pins: [] } });
const recent = (sequence, messages, omitted, limit = 3) => ({ ...owner, sequence,
  state: { messages, workItems: {}, pins: [] }, messagesWindow: { mode: "recent", limit, omitted, older: "conversation" } });
const hint = (sequence, type, data = {}) => ({ sequence, event: { id: `event-${sequence}`, roomId: "commons", type, data } });

function fixture(t, route) {
  let stream;
  class Events extends EventTarget { constructor() { super(); stream = this; } close() {} }
  const reads = [], seen = [];
  const client = new RoomClient({ events: Events, onSnapshot: value => seen.push(value), fetcher: async (url, options) => {
    if (url === "/api/rooms/commons/commands" && options.method === "POST") return response(route.receipt);
    assert.equal(options.method, "GET");
    reads.push(url);
    return response(route(url, reads.length));
  } });
  client.session = identity();
  t.after(() => client.disconnect());
  const notify = value => stream.dispatchEvent(new MessageEvent("room-event", { data: JSON.stringify(value) }));
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await client.flight?.promise; };
  return { client, reads, seen, notify, settle, route, connect: () => client.connect() };
}

const FULL = "/api/rooms/commons", RECENT = "/api/rooms/commons?messages=recent";
const history = ["m1", "m2", "m3", "m4", "m5"].map(message);

test("a new message on the stream re-reads only the newest messages and keeps older history", async t => {
  const f = fixture(t, url => url === FULL ? full(9, history) : recent(10, [message("m4"), message("m5"), message("m6")], 3));
  await f.client.refresh();
  f.connect(); await f.settle();
  const opened = f.reads.length;
  f.notify(hint(10, "message.posted", { messageId: "m6" })); await f.settle();
  assert.deepEqual(f.reads.slice(opened), [RECENT]);
  const last = f.seen.at(-1);
  assert.equal(last.sequence, 10);
  assert.deepEqual(ids(last.state.messages), ["m1", "m2", "m3", "m4", "m5", "m6"]);
  assert.equal(Object.hasOwn(last, "messagesWindow"), false, "the app sees one whole snapshot");
  // A claim receipt cannot touch messages either.
  f.notify(hint(11, "work_claim.updated", { action: "renewed" })); await f.settle();
  assert.equal(f.reads.at(-1), RECENT);
});

test("anything that can change an older message reads the full snapshot", async t => {
  for (const type of ["message.edited", "message.deleted", "message.redacted", "message.reaction_set", "member.removed", "some.future_event"]) {
    await t.test(type, async t => {
      const f = fixture(t, url => url === FULL ? full(9, history) : assert.fail(`windowed read for ${type}`));
      await f.client.refresh();
      f.connect(); await f.settle();
      const opened = f.reads.length;
      f.notify(hint(10, type, { messageId: "m1" })); await f.settle();
      assert.deepEqual(f.reads.slice(opened), [FULL]);
    });
  }
});

test("a window that does not line up with held history falls back to one full read", async t => {
  for (const [label, window] of [
    ["unknown first message", recent(10, [message("x"), message("m6")], 4)],
    ["omitted count disagrees", recent(10, [message("m4"), message("m5"), message("m6")], 2)],
    ["malformed window", { ...recent(10, [message("m4")], 3), messagesWindow: { mode: "recent", omitted: -1 } }]]) {
    await t.test(label, async t => {
      const f = fixture(t, (url, n) => url === RECENT ? window : full(n === 1 ? 9 : 10, n === 1 ? history : [...history, message("m6")]));
      await f.client.refresh();
      f.connect(); await f.settle();
      const opened = f.reads.length, applied = f.seen.length;
      f.notify(hint(10, "message.posted", { messageId: "m6" })); await f.settle();
      assert.deepEqual(f.reads.slice(opened), [RECENT, FULL]);
      assert.equal(f.seen.length, applied + 1, "the unaligned window is never shown");
      assert.deepEqual(ids(f.seen.at(-1).state.messages), ["m1", "m2", "m3", "m4", "m5", "m6"]);
    });
  }
});

test("a server that ignores ?messages=recent answers with a full snapshot, used as is", async t => {
  const f = fixture(t, (url, n) => full(n === 1 ? 9 : 10, n === 1 ? history : [...history, message("m6")]));
  await f.client.refresh();
  f.connect(); await f.settle();
  f.notify(hint(10, "message.posted", { messageId: "m6" })); await f.settle();
  assert.equal(f.reads.at(-1), RECENT);
  assert.deepEqual(ids(f.seen.at(-1).state.messages), ["m1", "m2", "m3", "m4", "m5", "m6"]);
});

test("an edit receipt that arrives after a newer windowed read still reads the full snapshot", async t => {
  // The stream's message.posted (10) lands before the edit command's own
  // receipt (9 is older); the windowed read at 10 kept m1 as it was held.
  const f = fixture(t, (url, n) => n === 1 ? full(8, history)
    : url === RECENT ? recent(10, [message("m4"), message("m5"), message("m6")], 3)
    : full(10, [{ ...message("m1"), body: "edited" }, ...history.slice(1), message("m6")]));
  await f.client.refresh();
  f.connect(); await f.settle();
  f.notify(hint(10, "message.posted", { messageId: "m6" })); await f.settle();
  assert.equal(f.reads.at(-1), RECENT);
  assert.equal(f.client.sequence, 10);
  f.route.receipt = hint(9, "message.edited", { messageId: "m1" });
  await f.client.send({ id: "edit", type: "message.edited", data: { messageId: "m1", body: "edited" } });
  assert.equal(f.reads.at(-1), FULL);
  assert.equal(f.seen.at(-1).state.messages[0].body, "edited");
});

test("a new session never merges with the previous session's history", async t => {
  const f = fixture(t, url => url === FULL ? full(9, history) : recent(10, [message("m4"), message("m5"), message("m6")], 3));
  await f.client.refresh();
  f.client.endAccess();
  f.client.session = identity();
  const before = f.reads.length;
  await f.client.refresh(hint(10, "message.posted", { messageId: "m6" }));
  assert.deepEqual(f.reads.slice(before), [FULL]);
});

test("a mutation that joins a windowed read in flight gets its own full read", async t => {
  let release;
  const f = fixture(t, (url, n) => url === FULL ? full(n === 1 ? 9 : 11, history)
    : new Promise(resolve => { release = () => resolve(recent(11, [message("m4"), message("m5"), message("m6")], 3)); }));
  await f.client.refresh();
  f.connect(); await f.settle();
  const opened = f.reads.length;
  f.notify(hint(11, "message.posted", { messageId: "m6" }));
  await new Promise(resolve => setImmediate(resolve));
  // The reaction (10) is older than the windowed read it joins.
  f.notify(hint(10, "message.reaction_set", { messageId: "m1" }));
  release(); await f.settle();
  assert.deepEqual(f.reads.slice(opened), [RECENT, FULL]);
});

test("a stream open or error re-reads with the recent window once history is held", async t => {
  const f = fixture(t, url => url === FULL ? full(9, history) : recent(9, [message("m3"), message("m4"), message("m5")], 2));
  await f.client.refresh();
  assert.deepEqual(f.reads, [FULL], "opening reads in full");
  f.connect();
  for (const type of ["open", "error"]) {
    const before = f.reads.length;
    f.client.stream.dispatchEvent(new Event(type)); await f.settle();
    assert.deepEqual(f.reads.slice(before), [RECENT], type);
    assert.deepEqual(ids(f.seen.at(-1).state.messages), ["m1", "m2", "m3", "m4", "m5"], type);
  }
  // A manual refresh still reads in full.
  const before = f.reads.length;
  await f.client.refresh();
  assert.deepEqual(f.reads.slice(before), [FULL]);
});

test("after a failed read, the next read of any kind is full", async t => {
  let fail = false;
  const f = fixture(t, url => { if (fail) throw new Error("offline"); return url === FULL ? full(9, history) : recent(10, [message("m4"), message("m5"), message("m6")], 3); });
  await f.client.refresh();
  f.connect(); await f.settle();
  // The edit's read fails; the stream will not replay that event.
  fail = true;
  await assert.rejects(f.client.refresh(hint(10, "message.edited", { messageId: "m1" })));
  fail = false;
  const before = f.reads.length;
  f.client.stream.dispatchEvent(new Event("open")); await f.settle();
  assert.deepEqual(f.reads.slice(before), [FULL]);
});

test("a replaced stream resumes from the last full read, so an edit a window read passed is replayed", async t => {
  const urls = [];
  let stream;
  class Events extends EventTarget { constructor(url) { super(); urls.push(url); stream = this; this.readyState = 1; } close() {} }
  const client = new RoomClient({ events: Events, onSnapshot: () => {}, fetcher: async url => response(url === FULL ? full(9, history)
    : recent(12, [message("m4"), message("m5"), message("m6")], 3)) });
  client.session = identity();
  t.after(() => client.disconnect());
  await client.refresh(); client.connect();
  stream.dispatchEvent(new Event("open")); await client.flight?.promise;
  stream.readyState = 2; stream.dispatchEvent(new Event("error")); await new Promise(resolve => setImmediate(resolve)); await client.flight?.promise;
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.match(urls.at(-1), /\/stream\?after=9(&|$)/, "resumes after the full read at 9, not the window read at 12");
});
