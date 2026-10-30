// A message.posted addressed to the sender is a DM to yourself. It is
// refused. A room note omits toMemberId. A DM to someone else still posts.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

test("a DM to yourself is refused and a note still posts", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-self-dm-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "ada", displayName: "Ada", kind: "human", permissions: [] }
  });
  const self = {
    id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "note to me", toMemberId: "owner" }
  };
  assert.throws(() => store.command(ownerKey, "commons", self), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "invalid_command");
    assert.equal(error.message, "Can't DM yourself; post without toMemberId for a note");
    return true;
  });
  assert.equal(store.room("commons").state.messages.some(message => message.body === "note to me"), false);
  const note = store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "a room note" }
  });
  assert.equal(note.event.data.body, "a room note");
  assert.equal(note.event.data.toMemberId, undefined);
  const dm = store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "hello ada", toMemberId: "ada" }
  });
  assert.equal(dm.event.data.toMemberId, "ada");
});
