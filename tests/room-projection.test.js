// RR-D2 scoped projection contract tests.
//
// Failing-first premise: before this read, a caller that needed only one
// class of a room (the member roster, the work board, a count summary)
// had to fetch the whole snapshot document and pay its full byte cost.
// These tests pin the replacement contract:
//  (1) fields parsing is exact — a malformed list is refused whole, never
//      partially honoured;
//  (2) a projection carries ONLY the requested classes, names the classes
//      it omitted, and is byte-smaller than the snapshot it was cut from
//      by at least the size of the unrequested classes;
//  (3) the summary slice carries counts and the room record, and no
//      message body planted in the snapshot can appear in it;
//  (4) the read goes through the shared windowed snapshot reader (the
//      viewer-filtered, redacted read), with the full view requested;
//  (5) the route row is registered with the exact method/path and refuses
//      a request with no valid fields before any store read happens.
import test from "node:test";
import assert from "node:assert/strict";
import { parseProjectionFields, projectionSummary, projectRoomSnapshot, readRoomProjection, PROJECTION_CLASSES } from "../server/room-projection.mjs";
import { ROOM_PROJECTION_ROUTES, getRoomProjection } from "../server/routes/room-projection.mjs";

const bytes = value => Buffer.byteLength(JSON.stringify(value), "utf8");

function bigSnapshot() {
  const body = "planted-body-" + "x".repeat(400);
  return {
    roomId: "room-1",
    sequence: 4242,
    state: {
      room: { id: "room-1", name: "Big Room", ownerId: "member-owner" },
      members: { "member-a": { id: "member-a" }, "member-b": { id: "member-b" } },
      channels: { general: { id: "general" } },
      messages: Array.from({ length: 50 }, (_, i) => ({ id: `msg-${i}`, body })),
      workItems: { "work-1": { id: "work-1", title: "t" } },
      eventLog: Array.from({ length: 100 }, (_, i) => ({ id: `ev-${i}`, type: "message.posted", data: { body } })),
      pins: [{ messageId: "msg-1" }],
      bonds: { "bond-1": { id: "bond-1" } },
      seenEvents: { "ev-1": true },
      seenIdempotencyKeys: { "key-1": true }
    },
    charter: { revision: 3 },
    messagesWindow: { mode: "recent", limit: 50, omitted: 0, older: "conversation" },
    messagesPage: { before: 4000, hasMore: false },
    cursor: 4200,
    catchUpCursor: 4242,
    viewerId: "member-a",
    viewerAccountId: "account-a",
    viewerAuthEpoch: 1,
    viewerSessionBinding: "binding-a",
    viewerSessionRevision: 7
  };
}

test("parse: canonical order, exact membership, whole-refusal on any defect", () => {
  assert.deepEqual(parseProjectionFields("work,members"), ["members", "work"]);
  assert.deepEqual(parseProjectionFields(" summary "), ["summary"]);
  assert.deepEqual(parseProjectionFields(PROJECTION_CLASSES.join(",")), [...PROJECTION_CLASSES]);
  for (const bad of [null, undefined, "", " ", "members,", ",members", "members,,work", "nope", "members,members", "members, messagesx", 42]) {
    assert.equal(parseProjectionFields(bad), null, `expected refusal for ${JSON.stringify(bad)}`);
  }
});

test("projection: only the requested classes cross the wire, omissions are named", () => {
  const snapshot = bigSnapshot();
  const out = projectRoomSnapshot(snapshot, parseProjectionFields("members"));
  assert.deepEqual(Object.keys(out.state), ["members"]);
  assert.deepEqual(out.state.members, snapshot.state.members);
  assert.deepEqual(out.returnedClasses, ["members"]);
  assert.deepEqual(out.omittedClasses, ["room", "channels", "messages", "work", "audit", "pins", "bonds"]);
  assert.equal(out.sequence, 4242);
  assert.equal(out.viewerId, "member-a");
  assert.ok(!("charter" in out), "charter rides only with the room class");
  assert.ok(!("messagesWindow" in out) && !("messagesPage" in out), "message paging rides only with the messages class");
  const unrequested = bytes(snapshot.state.messages) + bytes(snapshot.state.eventLog);
  assert.ok(bytes(out) <= bytes(snapshot) - unrequested + 1024,
    `projection ${bytes(out)}B must beat the snapshot ${bytes(snapshot)}B by the unrequested classes (${unrequested}B)`);
});

test("projection: messages class carries its window + page; room class carries the charter", () => {
  const snapshot = bigSnapshot();
  const out = projectRoomSnapshot(snapshot, parseProjectionFields("messages,room"));
  assert.deepEqual(Object.keys(out.state).sort(), ["messages", "room"]);
  assert.deepEqual(out.messagesWindow, snapshot.messagesWindow);
  assert.deepEqual(out.messagesPage, snapshot.messagesPage);
  assert.deepEqual(out.charter, snapshot.charter);
});

test("summary: counts + room record, and no planted body anywhere in the slice", () => {
  const snapshot = bigSnapshot();
  const summary = projectionSummary(snapshot);
  assert.deepEqual(summary.counts, { members: 2, channels: 1, messages: 50, workItems: 1, pins: 1, eventLog: 100, bonds: 1 });
  assert.equal(summary.room.name, "Big Room");
  const out = projectRoomSnapshot(snapshot, parseProjectionFields("summary"));
  assert.deepEqual(out.state, {});
  assert.deepEqual(out.returnedClasses, []);
  assert.ok(!JSON.stringify(out).includes("planted-body"), "summary must not carry message or event bodies");
  assert.ok(bytes(out) < 1000, `summary slice is ${bytes(out)}B against a ${bytes(snapshot)}B snapshot`);
});

test("read: the slice is cut from the shared windowed snapshot, not a private load", () => {
  const snapshot = bigSnapshot();
  const calls = [];
  const reader = (store, token, roomId, fence, options) => { calls.push({ store, token, roomId, fence, options }); return snapshot; };
  const out = readRoomProjection("store-x", "token-x", "room-1", "fence-x", parseProjectionFields("work"), reader);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { view: "full", windowed: true });
  assert.deepEqual(Object.keys(out.state), ["workItems"]);
});

test("route row: registered once, exact method + path, exempt parity names the follow-up", () => {
  assert.equal(ROOM_PROJECTION_ROUTES.length, 1);
  const [row] = ROOM_PROJECTION_ROUTES;
  assert.equal(row.method, "GET");
  assert.equal(row.path, "/api/rooms/{roomId}/projection");
  assert.equal(row.handler, getRoomProjection);
  assert.match(row.parity, /^exempt:/);
  assert.equal(row.schema.query.properties.fields.type, "string");
});

test("handler: a request without valid fields is refused before any store read", () => {
  let storeReads = 0;
  const rejection = (status, code) => { const error = new Error(code); error.status = status; error.code = code; throw error; };
  const ctx = {
    params: { roomId: "room-1" },
    req: {}, res: {}, url: new URL("https://example.test/api/rooms/room-1/projection"),
    store: { snapshot: () => { storeReads += 1; } },
    roomCredentials: () => ({ mode: "token", token: "token-x", bearer: false }),
    expectedBinding: () => "fence-x",
    accountBinding: () => "fence-x",
    roomAuth: () => ({ kind: "session", credentialScope: "room", credentialHash: "h" }),
    rate: () => {},
    reject: rejection,
    json: (res, status, body) => ({ status, body })
  };
  assert.throws(() => getRoomProjection(ctx), error => error.status === 422 && error.code === "invalid_snapshot_view");
  ctx.url = new URL("https://example.test/api/rooms/room-1/projection?fields=members,nope");
  assert.throws(() => getRoomProjection(ctx), error => error.status === 422 && error.code === "invalid_snapshot_view");
  assert.equal(storeReads, 0);
});
