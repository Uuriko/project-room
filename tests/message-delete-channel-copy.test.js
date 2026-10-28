import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";

// QA-200 worker 34 (slice G4): post->delete->read consistency.
// A thread reply posted with alsoSendToChannel:true lands a second top-level
// message `${messageId}:channel` in the channel. Deleting the reply must
// tombstone that copy too, or the deleted text stays readable in the
// conversation window — breaking the invariant that a delete removes the
// text from every listed read.

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-delete-copy-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Agent", kind: "agent", permissions: ["accept_work"] } });
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const agentKey = store.issueAccessKey("commons", "agent");
  const post = (token, data) => {
    const messageId = data.messageId ?? randomUUID();
    store.command(token, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { ...data, messageId } });
    return messageId;
  };
  return { store, agentKey, post };
}

test("deleting a reply also tombstones its alsoSendToChannel channel copy", async t => {
  const { store, agentKey, post } = fixture(t);
  const root = post(agentKey, { body: "root" });
  const replyId = post(agentKey, {
    body: "secret reply text",
    replyToId: root,
    alsoSendToChannel: true,
  });

  let room = store.room("commons");
  const copy = room.state.messages.find(m => m.id === `${replyId}:channel`);
  assert.ok(copy, "channel copy exists before delete");
  assert.equal(copy.body, "secret reply text");

  // Author deletes the reply.
  store.command(agentKey, "commons", { id: randomUUID(), type: T.MESSAGE_DELETED,
    data: { messageId: replyId, expectedMessageRevision: 0 } });

  room = store.room("commons");
  const primary = room.state.messages.find(m => m.id === replyId);
  assert.equal(primary.body, null, "primary body withdrawn");
  assert.ok(primary.deletedAt, "primary tombstoned");

  const copyAfter = room.state.messages.find(m => m.id === `${replyId}:channel`);
  assert.ok(copyAfter, "channel copy still listed");
  assert.equal(copyAfter.body, null, "channel copy body is withdrawn");
  assert.ok(copyAfter.deletedAt, "channel copy is tombstoned");
});
