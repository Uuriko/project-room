import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-message-edit-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Agent", kind: "agent", permissions: ["accept_work"] } });
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "other", displayName: "Other", kind: "agent", permissions: ["accept_work"] } });
  const agentKey = store.issueAccessKey("commons", "agent");
  const otherKey = store.issueAccessKey("commons", "other");
  const post = (token, body) => store.command(token, "commons",
    { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body } }).event.data.messageId;
  return { store, ownerKey, agentKey, otherKey, post };
}

test("message edit/delete tombstones (round-2 #111)", async t => {
  const { store, ownerKey, agentKey, otherKey, post } = fixture(t);
  const messageId = post(agentKey, "original");

  // Edit by the author.
  const edited = store.command(agentKey, "commons", { id: randomUUID(), type: T.MESSAGE_EDITED,
    data: { messageId, body: "revised", expectedMessageRevision: 0 } });
  assert.equal(edited.event.type, T.MESSAGE_EDITED);
  let room = store.room("commons");
  let message = room.state.messages.find(m => m.id === messageId);
  assert.equal(message.body, "revised");
  assert.equal(message.revision, 1);
  assert.equal(message.editHistory.length, 1);
  assert.equal(message.editHistory[0].body, "original");

  // Stale revision rejected.
  assert.throws(() => store.command(agentKey, "commons", { id: randomUUID(), type: T.MESSAGE_EDITED,
    data: { messageId, body: "stale", expectedMessageRevision: 0 } }), /changed/);

  // Non-author cannot edit.
  assert.throws(() => store.command(otherKey, "commons", { id: randomUUID(), type: T.MESSAGE_EDITED,
    data: { messageId, body: "hijack", expectedMessageRevision: 1 } }), /Only the author/);

  // Owner can edit.
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_EDITED,
    data: { messageId, body: "owner edit", expectedMessageRevision: 1 } });
  room = store.room("commons");
  assert.equal(room.state.messages.find(m => m.id === messageId).revision, 2);

  // Delete leaves a tombstone.
  store.command(agentKey, "commons", { id: randomUUID(), type: T.MESSAGE_DELETED,
    data: { messageId, expectedMessageRevision: 2, reason: "typo" } });
  room = store.room("commons");
  message = room.state.messages.find(m => m.id === messageId);
  assert.equal(message.body, null);
  assert.ok(message.deletedAt);
  assert.equal(message.deletedBy, "agent");
  assert.equal(message.editHistory.length, 2);

  // Editing a deleted message is rejected.
  assert.throws(() => store.command(agentKey, "commons", { id: randomUUID(), type: T.MESSAGE_EDITED,
    data: { messageId, body: "resurrect", expectedMessageRevision: 3 } }), /deleted/);

  // Deleting an unknown message is rejected.
  assert.throws(() => store.command(agentKey, "commons", { id: randomUUID(), type: T.MESSAGE_DELETED,
    data: { messageId: randomUUID(), expectedMessageRevision: 0 } }), /not found/);
});
