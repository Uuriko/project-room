// Member snapshots omit the event log and name eventTail "events". The client
// reads /events, strips mention chips, and applies the activity filter locally.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomClient } from "../src/client.js";

const owner = { roomId: "commons", cursor: 0, viewerId: "human", viewerAccountId: "account-human", viewerAuthEpoch: 0, viewerSessionBinding: "session-human" };
const identity = () => ({ account: { id: "account-human", authEpoch: 0 }, member: { id: "human" }, roomId: "commons", csrf: "c", sessionBinding: "session-human" });
const response = body => ({ ok: true, status: 200, json: async () => body });

function clientFor(t, { auditView, events }) {
  const seen = [], urls = [], headers = [];
  const client = new RoomClient({
    events: null, auditView, onSnapshot: value => seen.push(value),
    fetcher: async (url, options) => {
      urls.push(url);
      headers.push(options.headers?.["X-Project-Room-Audit-View"] ?? null);
      if (url.includes("view=work")) return response({ ...owner, snapshotView: "work", snapshotVersion: 1, sequence: 2, state: { room: { id: "commons" }, members: {}, workItems: {} } });
      if (url.includes("/events?tail=100")) return response({ events, next: 2, hasMore: false });
      return response({ ...owner, sequence: 2, eventTail: "events", state: { messages: [{ id: "m1", body: "hello" }], workItems: {}, pins: [] } });
    }
  });
  client.session = identity();
  t.after(() => client.disconnect());
  return { client, seen, urls, headers };
}

const events = [
  { sequence: 1, event: { id: "e1", type: "message.posted", roomId: "commons", data: { messageId: "m1", body: "hello" }, mentions: [{ memberId: "human" }] } },
  { sequence: 2, event: { id: "e2", type: "decision.recorded", roomId: "commons", data: { statement: "go" } } }
];

test("a snapshot marked eventTail loads the log from /events", async t => {
  const { client, seen, urls, headers } = clientFor(t, { auditView: "full", events });
  await client.refresh();
  assert.ok(urls.includes("/api/rooms/commons/events?tail=100"));
  assert.equal(headers[urls.indexOf("/api/rooms/commons/events?tail=100")], null);
  const log = seen.at(-1).state.eventLog;
  assert.deepEqual(log.map(event => event.id), ["e1", "e2"]);
  assert.equal(Object.hasOwn(log[0], "mentions"), false);
  assert.deepEqual(seen.at(-1).state.seenEvents, {});
  assert.deepEqual(seen.at(-1).state.seenIdempotencyKeys, {});
});

test("activity view filters the /events tail locally", async t => {
  const { client, seen } = clientFor(t, { auditView: "activity", events });
  await client.refresh();
  assert.deepEqual(seen.at(-1).state.eventLog.map(event => event.id), ["e2"]);
});

test("the message window paints before the event tail returns", async t => {
  let release = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  const seen = [];
  const client = new RoomClient({
    events: null, auditView: "full", onSnapshot: value => seen.push({ pending: value.eventTailPending === true, messages: value.state.messages.map(message => message.id), log: (value.state.eventLog ?? []).map(event => event.id) }),
    fetcher: async url => {
      if (url.includes("/events?tail=100")) { await gate; return response({ events, next: 2, hasMore: false }); }
      if (url.includes("view=work")) return response({ ...owner, snapshotView: "work", snapshotVersion: 1, sequence: 2, state: { room: { id: "commons" }, members: {}, workItems: {} } });
      return response({ ...owner, sequence: 2, eventTail: "events", state: { messages: [{ id: "m1", body: "hello" }], workItems: {}, pins: [] } });
    }
  });
  client.session = identity();
  t.after(() => client.disconnect());
  const pending = client.refresh();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(seen[0], { pending: true, messages: ["m1"], log: [] });
  release();
  await pending;
  assert.deepEqual(seen.at(-1), { pending: false, messages: ["m1"], log: ["e1", "e2"] });
});

test("a receipt that continues the tail does not read /events again", async t => {
  const urls = [];
  const seen = [];
  let sequence = 2;
  const client = new RoomClient({
    events: null, auditView: "full", onSnapshot: value => seen.push(value.state.eventLog.map(event => event.id)),
    fetcher: async (url, options) => {
      urls.push(url);
      if (url.includes("/events?tail=100")) return response({ events, next: sequence, hasMore: false });
      if (url.includes("view=work")) return response({ ...owner, snapshotView: "work", snapshotVersion: 1, sequence, state: { room: { id: "commons" }, members: {}, workItems: {} } });
      if (options?.method === "POST") {
        sequence = 3;
        return response({ sequence, event: { id: "e3", type: "message.posted", roomId: "commons", actorId: "human", data: { messageId: "m2", body: "next" } } });
      }
      return response({
        ...owner, sequence, eventTail: "events",
        messagesWindow: { mode: "recent", omitted: 5, limit: 100 },
        state: { messages: [{ id: "m1", body: "hello" }, ...(sequence === 3 ? [{ id: "m2", body: "next" }] : [])], workItems: {}, pins: [] }
      });
    }
  });
  client.session = identity();
  t.after(() => client.disconnect());
  await client.refresh();
  const reads = urls.filter(url => url.includes("/events?tail=100")).length;
  await client.send({ id: "m2", type: "message.posted", data: { messageId: "m2", body: "next" } });
  assert.equal(urls.filter(url => url.includes("/events?tail=100")).length, reads);
  assert.deepEqual(seen.at(-1), ["e1", "e2", "e3"]);
});

test("a later read at the same sequence reuses the tail and earlier receipts", async t => {
  const urls = [];
  const seen = [];
  const client = new RoomClient({
    events: null, auditView: "full",
    onSnapshot: value => seen.push(value.state.workItems.w1?.receiptHistory?.map(receipt => receipt.eventId) ?? null),
    fetcher: async url => {
      urls.push(url);
      if (url.includes("/events?tail=100")) return response({ events, next: 2, hasMore: false });
      if (url.includes("view=work")) return response({
        ...owner, snapshotView: "work", snapshotVersion: 1, sequence: 2,
        state: { room: { id: "commons" }, members: {}, workItems: { w1: { id: "w1", receipt: { eventId: "r2" } } } }
      });
      return response({
        ...owner, sequence: 2, eventTail: "events",
        state: {
          messages: [{ id: "m1", body: "hello" }],
          workItems: { w1: { id: "w1", receipt: { eventId: "r2" }, receiptHistory: [{ eventId: "r1" }] } },
          pins: []
        }
      });
    }
  });
  client.session = identity();
  t.after(() => client.disconnect());
  await client.refresh();
  assert.deepEqual(seen[0], ["r1"], "the work view keeps earlier receipts from the message snapshot");
  const tailReads = urls.filter(url => url.includes("/events?tail=100")).length;
  await client.refresh();
  assert.equal(urls.filter(url => url.includes("/events?tail=100")).length, tailReads);
  assert.deepEqual(seen.at(-1), ["r1"]);
});
