// Lazy history: a client created with lazyHistory holds the first
// `?messages=recent` window and pages older history in only when asked
// (loadHistory) or once re-reading windows has cost more than a fill.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomClient } from "../src/client.js";
import { event, EVENT_TYPES as T } from "../src/events.js";

const RECENT = "/api/rooms/commons?messages=recent";
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
const recent = (sequence, messages, omitted) => ({ ...owner, sequence, state: state(messages),
  messagesWindow: { mode: "recent", limit: 3, omitted, older: "conversation" } });
const page = (sequence, messages, nextCursor) => ({ ...owner, generatedAt: at(99), conversationVersion: 1, mode: "replace",
  limit: 100, messageId: null, channelId: null, checkpoint: null, sequence, messages, nextCursor, hasMore: nextCursor !== null });
const envelope = (type, n, data) => event({ type, actorId: "human", roomId: "commons", at: at(n), data });
const receipt = (sequence, env) => ({ sequence, event: env });

function fixture(t, route) {
  route = { page: () => assert.fail("no paging before the reader asks"), ...route };
  let stream;
  class Events extends EventTarget { constructor() { super(); stream = this; } close() {} }
  const reads = [], pages = [], seen = [];
  const client = new RoomClient({ events: Events, lazyHistory: route.lazy ?? true, onSnapshot: value => seen.push(value), fetcher: async (url, options) => {
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


const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("a lazy client holds the first window and does not fill on its own", async t => {
  const all = history();
  const f = fixture(t, { read: url => url === RECENT ? recent(9, all.slice(-3), 2) : assert.fail("no full read") });
  await f.client.refresh();
  await wait(400); // past the eager client's 250ms fill
  assert.equal(f.client.heldMessages().partial, true);
  assert.equal(f.client.owesHistory, true);
  assert.deepEqual(f.pages, [], "no /conversation page was read");
  assert.deepEqual(f.reads, [RECENT]);
});

test("loadHistory pages the older segment in and completes history", async t => {
  const all = history();
  const f = fixture(t, {
    read: url => url === RECENT ? recent(9, all.slice(-3), 2) : assert.fail("the paged fill must not read a full snapshot"),
    page: url => url.includes("cursor=c1") ? page(9, all.slice(0, 2), null) : page(9, all, "c1")
  });
  await f.client.refresh();
  assert.equal(f.client.loadHistory(), true);
  for (let i = 0; i < 50 && f.client.heldMessages().partial; i++) await wait(10);
  const held = f.client.heldMessages();
  assert.equal(held.partial, false);
  assert.equal(f.client.owesHistory, false);
  assert.deepEqual(held.messages.map(message => message.id), ["m1", "m2", "m3", "m4", "m5"]);
  assert.equal(f.pages.length, 2);
  assert.equal(f.client.loadHistory(), false, "nothing is owed once history is held");
});

test("while only a window is held, an edit re-reads the window instead of the full snapshot", async t => {
  const all = history();
  let edited = false;
  const f = fixture(t, { read: url => {
    if (url !== RECENT) return assert.fail("an edit must not force a full read on a lazy window");
    const window = all.slice(-3).map(message => edited && message.id === "m5" ? { ...message, body: "changed", editedAt: at(10) } : message);
    return recent(edited ? 10 : 9, window, 2);
  } });
  await f.warm();
  edited = true;
  f.notify(receipt(10, envelope(T.MESSAGE_EDITED, 10, { messageId: "m5", body: "changed" }))); await f.settle();
  assert.deepEqual(f.reads, [RECENT]);
  assert.equal(f.seen.at(-1).state.messages.at(-1).body, "changed");
  assert.equal(f.client.heldMessages().partial, true, "still lazy");
});

test("repeated window re-reads eventually fill, so a long-open tab returns to deltas", async t => {
  const all = history();
  let sequence = 9;
  const f = fixture(t, {
    read: url => url === RECENT ? recent(sequence, all.slice(-3), 2) : assert.fail("no full read"),
    page: url => url.includes("cursor=c1") ? page(sequence, all.slice(0, 2), null) : page(sequence, all, "c1")
  });
  await f.warm();
  for (let i = 0; i < 24; i++) {
    sequence++;
    f.notify(receipt(sequence, envelope(T.WORK_CLAIM_UPDATED, sequence, {}))); await f.settle();
  }
  for (let i = 0; i < 80 && f.client.heldMessages().partial; i++) await wait(10);
  assert.equal(f.client.heldMessages().partial, false, "the fill ran after the read budget");
  assert.ok(f.pages.length >= 2);
});

test("an eager client (the default) still fills 250ms after the first window", async t => {
  const all = history();
  const f = fixture(t, { lazy: false,
    read: url => url === RECENT ? recent(9, all.slice(-3), 2) : assert.fail("no full read"),
    page: url => url.includes("cursor=c1") ? page(9, all.slice(0, 2), null) : page(9, all, "c1")
  });
  await f.client.refresh();
  await wait(400);
  assert.equal(f.client.heldMessages().partial, false);
});

test("a new session forgets an earlier request for history", async t => {
  const all = history();
  const f = fixture(t, { read: url => url === RECENT ? recent(9, all.slice(-3), 2) : assert.fail("no full read"),
    page: () => page(9, [], null) });
  await f.client.refresh();
  f.client.historyWanted = true; f.client.partialReads = 30;
  f.client.disconnect();
  assert.equal(f.client.historyWanted, false);
  assert.equal(f.client.partialReads, 0);
});
