// Privacy: a reply request's title must not echo a private context message the
// viewer cannot see. recordReplyPost moves contextMessageId to the newest message
// in the request's thread, and that message can be a DM to a third member.
// /updates (listRoomUpdates) and the owed-replies list both read projectRoom(),
// so both must apply the same rule as reply-context (server/reply-requests.mjs):
// a private message is visible only to its author and its recipient.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { listOwedReplies } from "../server/updates.mjs";

function serve(t, roomId = "commons") {
  const directory = mkdtempSync(join(tmpdir(), "room-req-privacy-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom(roomId));
  const ownerKey = store.issueAccessKey(roomId, "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey };
}

function addAgent(store, roomId, token, memberId, displayName) {
  const secret = `pri_${memberId}${"s".repeat(43 - memberId.length)}`;
  const identity = store.identities.create(displayName, { secret });
  store.identities.link(token, roomId, { identityId: identity.identityId, memberId, displayName, permissions: ["accept_work", "complete_work"] });
  return { secret, memberKey: store.issueAccessKey(roomId, memberId) };
}

test("a request title never shows another member's private context message", async t => {
  const { store, ownerKey } = serve(t);
  const agent = addAgent(store, "commons", ownerKey, "agent", "Asked Agent");
  addAgent(store, "commons", ownerKey, "carol", "Carol");
  const requestId = randomUUID();
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: requestId, body: "can you confirm the plan?", toMemberId: "agent", requestKind: "reply"
  } });
  // The requester then DMs a third member inside the request's thread.
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "carol-only secret: the budget is 42", toMemberId: "carol", replyToId: requestId
  } });
  const items = listOwedReplies(store, agent.secret).items.filter(item => item.kind === "request");
  assert.equal(items.length, 1, "the request is still owed to the agent");
  assert.doesNotMatch(items[0].title, /carol-only secret|budget/, "private context to carol must not reach the agent");
  assert.equal(items[0].sourceRef.requestId, requestId);
});

test("a request title still shows context the viewer can see", async t => {
  const { store, ownerKey } = serve(t);
  const agent = addAgent(store, "commons", ownerKey, "agent", "Asked Agent");
  const requestId = randomUUID();
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: requestId, body: "can you confirm the deploy window?", toMemberId: "agent", requestKind: "reply"
  } });
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "clarifying: the 4pm window", replyToId: requestId
  } });
  const items = listOwedReplies(store, agent.secret).items.filter(item => item.kind === "request");
  assert.equal(items.length, 1);
  assert.match(items[0].title, /4pm window/, "public context in the thread is the visible title");
});
