// Read-path: projectRoom() built a full id map over every message on every
// poll (~22ms on a 10k-message room) just to resolve reply-request context
// titles, even when the room had zero reply requests. The lookup is now lazy
// and indexes only the ids a request can reference (same shape as #1872's
// syncMessageRows fix).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { projectRoomUpdates, requestContextLookup } from "../server/updates.mjs";

const MESSAGES = 10000;

function largeRoom(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create("Lazy Owner");
  const reader = store.identities.create("Lazy Reader");
  const roomId = "lazy-index";
  rooms.create(owner.secret, { roomId, title: roomId, purpose: "lazy index", kind: "personal" });
  store.identities.link(owner.secret, roomId, { identityId: reader.identityId, displayName: "Reader", permissions: [] });
  const readerMemberId = store.db.prepare("SELECT member_id FROM identity_links WHERE identity_id=?").get(reader.identityId).member_id;
  const cur = store.room(roomId).state;
  const messages = [];
  for (let i = 0; i < MESSAGES; i++) {
    messages.push({ id: `bulk-${i}`, authorId: "owner", body: `bulk ${i}`, channelId: "general",
      workItemId: null, replyToId: null, toMemberId: null, createdAt: "2026-10-07T00:00:00.000Z" });
  }
  const stored = store.storedProjection(roomId, { ...cur, messages });
  const maxSeq = store.db.prepare("SELECT MAX(sequence) AS s FROM events WHERE room_id=?").get(roomId).s ?? 0;
  store.db.prepare("UPDATE rooms SET projection=?, sequence=? WHERE id=?").run(stored, maxSeq, roomId);
  return { store, owner, roomId, readerMemberId, messages };
}

function counting(messages) {
  let iterations = 0;
  const proxy = new Proxy(messages, {
    get(target, prop, receiver) {
      if (prop === Symbol.iterator) iterations++;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { proxy, iterations: () => iterations };
}

test("no reply requests: the message list is never scanned for an id map", t => {
  const { messages } = largeRoom(t);
  const { proxy, iterations } = counting(messages);
  const lookup = requestContextLookup(proxy, {});
  assert.equal(lookup("bulk-1"), undefined);
  assert.equal(lookup("bulk-9999"), undefined);
  assert.equal(iterations(), 0, "with zero reply requests no id map may be built");
});

test("a reply request resolves its context message through the lazy lookup", t => {
  const { messages } = largeRoom(t);
  const { proxy, iterations } = counting(messages);
  const requests = { "req-1": { id: "req-1", contextMessageId: "bulk-4242", recipientId: "r" } };
  const lookup = requestContextLookup(proxy, requests);
  assert.equal(lookup("bulk-4242")?.body, "bulk 4242");
  assert.equal(lookup("bulk-1"), undefined, "unreferenced ids stay invisible");
  assert.equal(iterations(), 1, "one pass over messages, only when requests exist");
});

test("projectRoomUpdates still resolves reply-request context titles", t => {
  const { store, owner, roomId, readerMemberId } = largeRoom(t);
  const requestId = randomUUID();
  store.command(owner.secret, roomId, { id: randomUUID(), type: "message.posted",
    data: { messageId: requestId, body: "please review the deploy plan",
      toMemberId: readerMemberId, requestKind: "reply" } });
  const items = projectRoomUpdates(store, roomId, readerMemberId, null).items
    .filter(item => item.kind === "request");
  assert.ok(items.length >= 1, "the reply request surfaces as an update item");
  assert.match(items[0].title, /deploy plan/, "context title resolves through the lazy lookup");
});
