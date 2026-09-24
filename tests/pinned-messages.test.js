// Issue #6 B2: pinned messages. Reducer, store and route coverage for
// the pin reducers in src/events.js + server/pins.mjs: any active member pins or unpins a live
// message, pin/unpin are idempotent, the room keeps at most PIN_LIMIT pins in
// pin order, a deleted message drops out of the list, and every route call
// re-checks membership.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, COMMAND_TYPES } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { classifyCommand } from "../server/action-classes.mjs";
import { EVENT_TYPES as T, applyEvent, replay, emptyRoomState, event, PIN_LIMIT, pinnedMessages, isPinned } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";

// --- reducer -----------------------------------------------------------------

function seededState() {
  let at = Date.parse("2026-09-14T09:00:00Z");
  const next = (type, actorId, data) => event({ type, roomId: "commons", actorId, at: new Date(at += 1000).toISOString(), idempotencyKey: randomUUID(), data });
  const events = [
    ...initialRoom("commons", "owner"),
    next(T.MEMBER_ADDED, "owner", { memberId: "guest", displayName: "Guest", kind: "human", permissions: [] }),
    next(T.MEMBER_ADDED, "owner", { memberId: "helper", displayName: "Helper", kind: "agent", permissions: ["accept_work"], accountableHumanId: "owner" }),
    next(T.MESSAGE_POSTED, "owner", { messageId: "m1", body: "first" }),
    next(T.MESSAGE_POSTED, "guest", { messageId: "m2", body: "second" }),
    next(T.MESSAGE_POSTED, "helper", { messageId: "m3", body: "third" })
  ];
  return { events, next, state: replay(events) };
}

test("reducer: pins are ordered by pin time, idempotent, and unpin removes exactly one", () => {
  const { state, next } = seededState();
  let s = applyEvent(state, next(T.MESSAGE_PINNED, "guest", { messageId: "m2" }));
  s = applyEvent(s, next(T.MESSAGE_PINNED, "owner", { messageId: "m1" }));
  assert.deepEqual(s.pins.map(p => p.messageId), ["m2", "m1"], "pin order is the order pins were placed, not message order");
  assert.equal(s.pins[0].pinnedById, "guest");
  assert.match(s.pins[0].pinnedAt, /^2026-09-14T/);
  assert.equal(isPinned(s, "m1"), true); assert.equal(isPinned(s, "m3"), false);

  const again = applyEvent(s, next(T.MESSAGE_PINNED, "helper", { messageId: "m2" }));
  assert.deepEqual(again.pins, s.pins, "pinning an already pinned message changes nothing (idempotent)");

  const unpinned = applyEvent(s, next(T.MESSAGE_UNPINNED, "helper", { messageId: "m2" }));
  assert.deepEqual(unpinned.pins.map(p => p.messageId), ["m1"], "any active member can unpin, and only that pin goes");
  const twice = applyEvent(unpinned, next(T.MESSAGE_UNPINNED, "owner", { messageId: "m2" }));
  assert.deepEqual(twice.pins, unpinned.pins, "unpinning a message that is not pinned changes nothing");
  const fresh = applyEvent(state, next(T.MESSAGE_UNPINNED, "owner", { messageId: "m3" }));
  assert.equal(fresh.pins, undefined, "an unpin on a room with no pins leaves the projection shape untouched");

  // Re-pinning moves the message to the end of the list.
  const repinned = applyEvent(unpinned, next(T.MESSAGE_PINNED, "owner", { messageId: "m2" }));
  assert.deepEqual(repinned.pins.map(p => p.messageId), ["m1", "m2"]);
  assert.deepEqual(pinnedMessages(repinned).map(p => p.message.body), ["first", "second"]);
});

test("reducer: pins need an active member and a live message in this room", () => {
  const { state, next } = seededState();
  assert.throws(() => applyEvent(state, next(T.MESSAGE_PINNED, "stranger", { messageId: "m1" })), /Unknown member/);
  assert.throws(() => applyEvent(state, next(T.MESSAGE_PINNED, "owner", { messageId: "nope" })), /message in this Room/);
  assert.throws(() => applyEvent(state, next(T.MESSAGE_PINNED, "owner", {})), /messageId/);
  const revoked = applyEvent(state, next(T.MEMBER_ACCESS_CHANGED, "owner", { memberId: "guest", expectedMemberRevision: 0, permissions: [], active: false }));
  assert.throws(() => applyEvent(revoked, next(T.MESSAGE_PINNED, "guest", { messageId: "m1" })), /access revoked/);
  assert.throws(() => applyEvent(revoked, next(T.MESSAGE_UNPINNED, "guest", { messageId: "m1" })), /access revoked/);
  const deleted = applyEvent(state, next(T.MESSAGE_DELETED, "owner", { messageId: "m1", expectedMessageRevision: 0 }));
  assert.throws(() => applyEvent(deleted, next(T.MESSAGE_PINNED, "owner", { messageId: "m1" })), /deleted message cannot be pinned/);
});

test("reducer: a tombstone drops the pin, and replay equals the incremental projection", () => {
  const { events, state, next } = seededState();
  const pin1 = next(T.MESSAGE_PINNED, "owner", { messageId: "m1" }), pin2 = next(T.MESSAGE_PINNED, "owner", { messageId: "m2" });
  const del = next(T.MESSAGE_DELETED, "guest", { messageId: "m2", expectedMessageRevision: 0, reason: "cleanup" });
  let s = applyEvent(applyEvent(state, pin1), pin2);
  assert.deepEqual(pinnedMessages(s).map(p => p.messageId), ["m1", "m2"]);
  s = applyEvent(s, del);
  assert.deepEqual(s.pins.map(p => p.messageId), ["m1"], "message.deleted removes the pin from the projection");
  assert.deepEqual(pinnedMessages(s).map(p => p.messageId), ["m1"]);
  assert.equal(s.messages.find(m => m.id === "m2").body, null, "the tombstone itself is unchanged");
  const replayed = replay([...events, pin1, pin2, del]);
  assert.deepEqual({ ...replayed, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} }, { ...s, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });
  // The selector also hides a tombstone defensively when a projection carries a stale pin.
  const stale = structuredClone(s); stale.pins.push({ messageId: "m2", pinnedById: "owner", pinnedAt: del.at });
  assert.deepEqual(pinnedMessages(stale).map(p => p.messageId), ["m1"]);
  assert.deepEqual(pinnedMessages(emptyRoomState()), []);
  assert.deepEqual(pinnedMessages(null), []);
});

test("reducer: the room keeps at most PIN_LIMIT pins and says so as a capacity refusal", () => {
  const { state, next } = seededState();
  let s = state;
  for (let i = 0; i < PIN_LIMIT; i += 1) {
    s = applyEvent(s, next(T.MESSAGE_POSTED, "owner", { messageId: `bulk-${i}`, body: `bulk ${i}` }));
    s = applyEvent(s, next(T.MESSAGE_PINNED, "owner", { messageId: `bulk-${i}` }));
  }
  assert.equal(s.pins.length, PIN_LIMIT);
  assert.throws(() => applyEvent(s, next(T.MESSAGE_PINNED, "owner", { messageId: "m1" })), /Pin capacity reached/);
  const same = applyEvent(s, next(T.MESSAGE_PINNED, "owner", { messageId: "bulk-0" }));
  assert.equal(same.pins.length, PIN_LIMIT, "re-pinning at capacity is still a no-op, not a refusal");
  const freed = applyEvent(s, next(T.MESSAGE_UNPINNED, "owner", { messageId: "bulk-3" }));
  assert.equal(applyEvent(freed, next(T.MESSAGE_PINNED, "owner", { messageId: "m1" })).pins.at(-1).messageId, "m1");
});

// --- store -------------------------------------------------------------------

function storeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-pins-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const cmd = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data });
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "guest", displayName: "Guest", kind: "human", permissions: [] });
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "helper", displayName: "Helper", kind: "agent", permissions: ["accept_work"], accountableHumanId: "owner" });
  // Graduated autonomy tiers: the fixture agent is operator-promoted so the
  // pin tests exercise it as a working agent.
  setTier(store.db, "commons", "helper", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const guestKey = store.issueAccessKey("commons", "guest"), helperKey = store.issueAccessKey("commons", "helper");
  const post = (token, body) => cmd(token, T.MESSAGE_POSTED, { messageId: randomUUID(), body }).event.data.messageId;
  const pins = () => store.room("commons").state.pins ?? [];
  return { directory, store, ownerKey, guestKey, helperKey, cmd, post, pins };
}

test("store: pin commands are classified, field-checked, idempotent by command id, and bounded", t => {
  const f = storeFixture(t);
  assert.ok(COMMAND_TYPES.includes(T.MESSAGE_PINNED) && COMMAND_TYPES.includes(T.MESSAGE_UNPINNED));
  assert.equal(classifyCommand(T.MESSAGE_PINNED), "act"); assert.equal(classifyCommand(T.MESSAGE_UNPINNED), "act");
  const m1 = f.post(f.ownerKey, "keep this"), m2 = f.post(f.guestKey, "and this");
  assert.throws(() => f.cmd(f.guestKey, T.MESSAGE_PINNED, { messageId: m1, note: "x" }), { status: 422, code: "invalid_command" });
  assert.throws(() => f.cmd(f.guestKey, T.MESSAGE_PINNED, { messageId: 5 }), { status: 422, code: "invalid_command" });
  assert.throws(() => f.cmd(f.guestKey, T.MESSAGE_PINNED, { messageId: "missing" }), { status: 422, code: "command_rejected", message: /message in this Room/ });

  const receipt = f.cmd(f.guestKey, T.MESSAGE_PINNED, { messageId: m1 });
  assert.equal(receipt.event.type, "message.pinned"); assert.equal(receipt.event.actorId, "guest");
  assert.deepEqual(f.pins().map(p => [p.messageId, p.pinnedById]), [[m1, "guest"]]);
  // Exact retry of the same command id returns the original receipt without a second event.
  const id = randomUUID();
  const first = f.store.command(f.helperKey, "commons", { id, type: T.MESSAGE_PINNED, data: { messageId: m2 } });
  const dup = f.store.command(f.helperKey, "commons", { id, type: T.MESSAGE_PINNED, data: { messageId: m2 } });
  assert.equal(dup.duplicate, true); assert.equal(dup.sequence, first.sequence);
  assert.deepEqual(f.pins().map(p => p.messageId), [m1, m2]);
  // Sequence advances on a fresh no-op pin (reducer idempotence) but the projection does not change.
  const before = f.store.room("commons").sequence;
  f.cmd(f.ownerKey, T.MESSAGE_PINNED, { messageId: m1 });
  assert.equal(f.store.room("commons").sequence, before + 1); assert.deepEqual(f.pins().map(p => p.messageId), [m1, m2]);

  // Deleting a pinned message drops the pin; pinning a tombstone is refused.
  f.cmd(f.guestKey, T.MESSAGE_DELETED, { messageId: m2, expectedMessageRevision: 0, reason: "cleanup" });
  assert.deepEqual(f.pins().map(p => p.messageId), [m1]);
  // The same status as POST /pins (409 message_deleted): a tombstone is a state conflict, not a malformed command.
  assert.throws(() => f.cmd(f.ownerKey, T.MESSAGE_PINNED, { messageId: m2 }), { status: 409, code: "command_rejected", message: /deleted message/ });

  // Revoked members cannot pin or unpin.
  f.cmd(f.ownerKey, T.MEMBER_ACCESS_CHANGED, { memberId: "helper", expectedMemberRevision: 0, permissions: ["accept_work"], active: false });
  assert.throws(() => f.cmd(f.helperKey, T.MESSAGE_UNPINNED, { messageId: m1 }), error => [401, 403].includes(error.status));

  // Capacity: PIN_LIMIT pins per room, refused as 409 without changing anything.
  for (let i = f.pins().length; i < PIN_LIMIT; i += 1) f.cmd(f.ownerKey, T.MESSAGE_PINNED, { messageId: f.post(f.ownerKey, `bulk ${i}`) });
  assert.equal(f.pins().length, PIN_LIMIT);
  const extra = f.post(f.ownerKey, "one too many");
  assert.throws(() => f.cmd(f.ownerKey, T.MESSAGE_PINNED, { messageId: extra }), { status: 409, code: "command_rejected", message: /Pin capacity reached/ });
  assert.equal(f.pins().length, PIN_LIMIT);
  f.cmd(f.ownerKey, T.MESSAGE_UNPINNED, { messageId: m1 });
  f.cmd(f.ownerKey, T.MESSAGE_PINNED, { messageId: extra });
  assert.equal(f.pins().at(-1).messageId, extra);
  // The JSONL export carries the pin events like every other room event.
  const exported = [...f.store.exportEvents(f.ownerKey, "commons")].map(line => line.event.type);
  assert.ok(exported.includes("message.pinned") && exported.includes("message.unpinned"));
});

// --- routes ------------------------------------------------------------------

async function serve(t) {
  const f = storeFixture(t);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, token, body, path = "/api/rooms/commons/pins") => {
    const res = await fetch(`${origin}${path}`, {
      method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { ...f, origin, list: token => call("GET", token), send: (token, body) => call("POST", token, body),
    command: (token, type, data) => call("POST", token, { id: randomUUID(), type, data }, "/api/rooms/commons/commands") };
}

test("routes: GET /pins lists ordered pins for members only; POST pins and unpins idempotently", async t => {
  const f = await serve(t);
  const m1 = f.post(f.ownerKey, "agenda for Thursday"), m2 = f.post(f.guestKey, "parking code 4411");

  assert.equal((await f.list()).status, 401, "no credential, no list");
  assert.equal((await f.send(null, { messageId: m1, pinned: true })).status, 401);
  const empty = await f.list(f.guestKey);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { roomId: "commons", sequence: f.store.room("commons").sequence, limit: PIN_LIMIT, count: 0, pins: [] });

  // Body validation happens before any room detail is disclosed.
  for (const body of [{}, { messageId: m1 }, { pinned: true }, { messageId: m1, pinned: "yes" }, { messageId: 3, pinned: true }, { messageId: m1, pinned: true, extra: 1 }, { messageId: m1, pinned: true, requestId: "bad id!" }]) {
    const res = await f.send(f.guestKey, body);
    assert.equal(res.status, 422, JSON.stringify(body)); assert.equal(res.json.error.code, "invalid_pin");
  }
  assert.equal((await f.send(f.guestKey, { messageId: "missing", pinned: true })).status, 404);

  const pinned = await f.send(f.guestKey, { messageId: m2, pinned: true });
  assert.equal(pinned.status, 201, "an appended event answers 201 like every other mutation");
  assert.equal(pinned.json.changed, true); assert.equal(pinned.json.pinned, true); assert.equal(typeof pinned.json.event.sequence, "number"); assert.equal(pinned.json.event.duplicate, false);
  assert.deepEqual(pinned.json.pins.map(p => [p.messageId, p.pinnedById, p.authorId, p.body]), [[m2, "guest", "guest", "parking code 4411"]]);
  const sequence = f.store.room("commons").sequence;
  const again = await f.send(f.helperKey, { messageId: m2, pinned: true });
  assert.equal(again.status, 200, "already in the requested state: 200, nothing appended"); assert.equal(again.json.changed, false); assert.equal(again.json.event, undefined);
  assert.equal(f.store.room("commons").sequence, sequence, "asking for the state the room is already in appends no event");

  // A client-chosen requestId makes the write idempotent across retries.
  const requestId = randomUUID();
  const first = await f.send(f.ownerKey, { messageId: m1, pinned: true, requestId });
  assert.equal(first.status, 201); assert.equal(first.json.changed, true);
  // The reducer is a no-op for a second pin, so the route's early return answers and the retry of the id is never even needed;
  // but a retried id after an unpin must not resurrect the pin with a different body either.
  await f.send(f.ownerKey, { messageId: m1, pinned: false });
  const conflict = await f.send(f.ownerKey, { messageId: m1, pinned: true, requestId });
  assert.equal(conflict.status, 200, "a replayed requestId is a duplicate: 200"); assert.equal(conflict.json.changed, false, "the original receipt is returned; no new event"); assert.equal(conflict.json.event.duplicate, true); assert.equal(conflict.json.event.sequence, first.json.event.sequence);
  assert.equal(conflict.json.pinned, true);
  assert.deepEqual((await f.list(f.ownerKey)).json.pins.map(p => p.messageId), [m2], "the replayed receipt did not re-pin");

  // Ordering: pins list in pin order; unpin then re-pin moves to the end.
  await f.send(f.ownerKey, { messageId: m1, pinned: true, requestId: randomUUID() });
  assert.deepEqual((await f.list(f.helperKey)).json.pins.map(p => p.messageId), [m2, m1]);
  await f.send(f.helperKey, { messageId: m2, pinned: false });
  await f.send(f.helperKey, { messageId: m2, pinned: true });
  const ordered = await f.list(f.ownerKey);
  assert.deepEqual(ordered.json.pins.map(p => p.messageId), [m1, m2]); assert.equal(ordered.json.count, 2);
  assert.deepEqual(Object.keys(ordered.json.pins[0]).sort(), ["authorId", "body", "createdAt", "messageId", "pinnedAt", "pinnedById", "replyToId", "workItemId"]);

  // Unpinning something that is not pinned is a quiet no-op.
  const m3 = f.post(f.ownerKey, "never pinned");
  const noop = await f.send(f.ownerKey, { messageId: m3, pinned: false });
  assert.equal(noop.status, 200); assert.equal(noop.json.changed, false);
});

test("routes: tombstoned messages drop out of pins, and membership is re-checked on every call", async t => {
  const f = await serve(t);
  const m1 = f.post(f.ownerKey, "keep"), m2 = f.post(f.guestKey, "doomed");
  await f.send(f.guestKey, { messageId: m1, pinned: true });
  await f.send(f.guestKey, { messageId: m2, pinned: true });
  assert.deepEqual((await f.list(f.guestKey)).json.pins.map(p => p.messageId), [m1, m2]);

  f.cmd(f.guestKey, T.MESSAGE_DELETED, { messageId: m2, expectedMessageRevision: 0, reason: "cleanup" });
  const after = await f.list(f.ownerKey);
  assert.deepEqual(after.json.pins.map(p => p.messageId), [m1]);
  assert.ok(!JSON.stringify(after.json).includes("doomed"), "a deleted body never reaches the pinned list");
  const tombstone = await f.send(f.ownerKey, { messageId: m2, pinned: true });
  assert.equal(tombstone.status, 409); assert.equal(tombstone.json.error.code, "message_deleted");
  // Both write paths agree: the same pin through POST /commands is a 409 too (command_rejected, the reducer's message).
  const viaCommand = await f.command(f.ownerKey, T.MESSAGE_PINNED, { messageId: m2 });
  assert.equal(viaCommand.status, 409, "POST /commands: a tombstone pin is a conflict, not a 422 field error");
  assert.equal(viaCommand.json.error.code, "command_rejected"); assert.match(viaCommand.json.error.message, /deleted message cannot be pinned/);
  assert.deepEqual((await f.list(f.ownerKey)).json.pins.map(p => p.messageId), [m1], "neither refusal changed anything");
  const unpinTombstone = await f.send(f.ownerKey, { messageId: m2, pinned: false });
  assert.equal(unpinTombstone.status, 200); assert.equal(unpinTombstone.json.changed, false, "unpinning a tombstone is a no-op");

  // The guest could read and pin a moment ago; once access ends, both calls refuse.
  f.cmd(f.ownerKey, T.MEMBER_ACCESS_CHANGED, { memberId: "guest", expectedMemberRevision: 0, permissions: [], active: false });
  const revokedList = await f.list(f.guestKey), revokedPin = await f.send(f.guestKey, { messageId: m1, pinned: false });
  assert.ok([401, 403].includes(revokedList.status), `revoked list -> ${revokedList.status}`);
  assert.ok([401, 403].includes(revokedPin.status), `revoked pin -> ${revokedPin.status}`);
  assert.deepEqual((await f.list(f.ownerKey)).json.pins.map(p => p.messageId), [m1], "the refused unpin changed nothing");
  assert.equal((await f.list(f.ownerKey)).json.pins[0].pinnedById, "guest", "history keeps who pinned it");
  // Wrong method is refused after authentication like every other room route.
  const res = await fetch(`${f.origin}/api/rooms/commons/pins`, { method: "DELETE", headers: { Origin: f.origin, Authorization: `Bearer ${f.ownerKey}` } });
  assert.equal(res.status, 405); await res.text();
});
