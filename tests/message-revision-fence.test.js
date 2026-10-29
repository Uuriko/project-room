// QA9: message.edited and message.deleted require data.expectedMessageRevision.
// A missing or non-integer fence is a malformed command (422 invalid_command)
// that names the current revision. A different integer is a real conflict
// (422 command_rejected) and also names the current revision. An event that
// already carries the matching integer still replays.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function open(t, directory = mkdtempSync(join(tmpdir(), "project-room-message-revision-"))) {
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, directory };
}

function fixture(t) {
  const { store } = open(t);
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: "message.posted", data: { messageId: "m1", body: "hello" },
  });
  return { store, ownerKey };
}

const message = (store, id = "m1") => store.room("commons").state.messages.find(m => m.id === id);

function attempt(store, key, type, data) {
  try {
    store.command(key, "commons", { id: randomUUID(), type, data });
    return null;
  } catch (error) {
    return error;
  }
}

test("edit and delete name the current revision when the fence is missing or not an integer", t => {
  const { store, ownerKey } = fixture(t);
  const cases = [
    {},
    { expectedMessageRevision: null },
    { expectedMessageRevision: 1.5 },
    { expectedMessageRevision: "0" },
  ];
  for (const type of ["message.edited", "message.deleted"]) {
    const base = type === "message.edited"
      ? { messageId: "m1", body: "changed" }
      : { messageId: "m1", reason: "tidy" };
    for (const extra of cases) {
      const error = attempt(store, ownerKey, type, { ...base, ...extra });
      assert.equal(error?.status, 422, `${type} ${JSON.stringify(extra)}`);
      assert.equal(error?.code, "invalid_command", `${type} ${JSON.stringify(extra)}`);
      assert.equal(error?.message, "expectedMessageRevision is required (current revision is 0)");
    }
  }
  assert.equal(message(store).body, "hello");
  assert.equal(message(store).deletedAt, undefined);
});

test("a mismatched integer is a conflict naming the current revision, and the matching integer edits then deletes", t => {
  const { store, ownerKey } = fixture(t);
  const stale = attempt(store, ownerKey, "message.edited", {
    messageId: "m1", body: "changed", expectedMessageRevision: 1,
  });
  assert.equal(stale?.status, 422);
  assert.equal(stale?.code, "command_rejected");
  assert.equal(stale?.message, "Message changed; refresh before editing (current revision is 0)");
  assert.equal(message(store).body, "hello");

  store.command(ownerKey, "commons", {
    id: randomUUID(), type: "message.edited",
    data: { messageId: "m1", body: "edited", expectedMessageRevision: 0 },
  });
  assert.equal(message(store).body, "edited");
  assert.equal(message(store).revision, 1);

  const staleDelete = attempt(store, ownerKey, "message.deleted", {
    messageId: "m1", reason: "tidy", expectedMessageRevision: 0,
  });
  assert.equal(staleDelete?.status, 422);
  assert.equal(staleDelete?.code, "command_rejected");
  assert.equal(staleDelete?.message, "Message changed; refresh before editing (current revision is 1)");
  assert.equal(message(store).body, "edited");

  const missingAfterEdit = attempt(store, ownerKey, "message.deleted", { messageId: "m1", reason: "tidy" });
  assert.equal(missingAfterEdit?.code, "invalid_command");
  assert.equal(missingAfterEdit?.message, "expectedMessageRevision is required (current revision is 1)");

  store.command(ownerKey, "commons", {
    id: randomUUID(), type: "message.deleted",
    data: { messageId: "m1", reason: "tidy", expectedMessageRevision: 1 },
  });
  assert.equal(message(store).body, null);
  assert.equal(message(store).revision, 2);
  assert.ok(message(store).deletedAt);
});

test("a stored edit that carries the matching revision still replays", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-message-revision-replay-"));
  const first = open(t, directory);
  first.store.initialize(initialRoom("commons"));
  const ownerKey = first.store.issueAccessKey("commons", "owner");
  first.store.command(ownerKey, "commons", {
    id: randomUUID(), type: "message.posted", data: { messageId: "m1", body: "hello" },
  });
  first.store.command(ownerKey, "commons", {
    id: randomUUID(), type: "message.edited",
    data: { messageId: "m1", body: "edited", expectedMessageRevision: 0 },
  });
  const sequence = first.store.room("commons").sequence;
  first.store.close();

  const reopened = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => reopened.close());
  const rebuilt = reopened.rebuildProjection("commons");
  const replayed = rebuilt.state.messages.find(m => m.id === "m1");
  assert.equal(rebuilt.sequence, sequence);
  assert.equal(replayed.body, "edited");
  assert.equal(replayed.revision, 1);
});
