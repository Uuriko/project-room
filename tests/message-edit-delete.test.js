import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
  // Deletion removes every earlier version as well as the current one.
  assert.equal(message.editHistory.length, 0);

  // Editing a deleted message is rejected.
  assert.throws(() => store.command(agentKey, "commons", { id: randomUUID(), type: T.MESSAGE_EDITED,
    data: { messageId, body: "resurrect", expectedMessageRevision: 3 } }), /deleted/);

  // Deleting an unknown message is rejected.
  assert.throws(() => store.command(agentKey, "commons", { id: randomUUID(), type: T.MESSAGE_DELETED,
    data: { messageId: randomUUID(), expectedMessageRevision: 0 } }), /not found/);
});

// Issue #6 D6: deletion keeps the text in the log; redaction takes it out. The
// full surface (export, import, restore, migration) is in tests/message-redaction.test.js.
test("message redaction purges the text deletion kept, by author or owner, once", async t => {
  const { store, ownerKey, agentKey, otherKey, post } = fixture(t);
  const messageId = post(agentKey, "original wording to purge");
  store.command(agentKey, "commons", { id: randomUUID(), type: T.MESSAGE_EDITED, data: { messageId, body: "revised wording to purge", expectedMessageRevision: 0 } });
  store.command(agentKey, "commons", { id: randomUUID(), type: T.MESSAGE_DELETED, data: { messageId, expectedMessageRevision: 1 } });
  const log = () => store.db.prepare("SELECT group_concat(body, char(10)) AS t FROM events WHERE room_id='commons'").get().t;
  assert.ok(log().includes("original wording to purge") && log().includes("revised wording to purge"), "deletion is a tombstone: the log keeps every version");
  assert.throws(() => store.command(otherKey, "commons", { id: randomUUID(), type: T.MESSAGE_REDACTED, data: { messageId } }), /Only the author or the Room owner/);
  const redaction = store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_REDACTED, data: { messageId } });
  assert.equal(redaction.event.data.bodySha256, createHash("sha256").update("revised wording to purge").digest("hex"), "the hash of the last body verifies the record");
  assert.equal(/wording to purge/.test(log()), false, "no version of the text remains in the log");
  const message = store.room("commons").state.messages.find(m => m.id === messageId);
  assert.deepEqual([message.body, message.editHistory, message.redactedBy, message.deletedBy, message.bodySha256], [null, [], "owner", "agent", redaction.event.data.bodySha256]);
  assert.deepEqual(store.command(agentKey, "commons", { id: randomUUID(), type: T.MESSAGE_REDACTED, data: { messageId } }), { ...redaction, duplicate: true }, "a second redaction is idempotent");
  assert.deepEqual(store.rebuildProjection("commons"), store.room("commons"), "replay of the rewritten log reproduces the redaction");
});
