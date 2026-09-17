import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// auditReplyRequests replays the event log and compares its rebuild against the
// live projection. It used to replay message.posted and nothing else, while
// compare() holds every message body against the rebuild once any reply request
// exists. Messages are not immutable - message.edited and message.deleted are
// ordinary commands - so a single corrected typo anywhere in the room made the
// two disagree, permanently and with nothing actually wrong.
//
// That was not cosmetic. auditRecovery is the gate inside backupRoom, so from
// that edit onward scripts/backup-room.mjs exits with "Backup failed
// verification. Live data was not replaced." The room could no longer be backed
// up at all.
//
// Half these tests are the fix. The other half exist because an audit is
// trivially made to pass by no longer looking, so each one tampers with the
// stored projection or the log and requires that it is still caught.

function room(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-reply-audit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => store.close());
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data) => store.command(keys[actor], "commons", { id: randomUUID(), type, data });
  for (const id of ["alice", "bob"]) {
    send("owner", T.MEMBER_ADDED, { memberId: id, displayName: id, kind: "human", permissions: ["steer", "decide", "accept_work"] });
    keys[id] = store.issueAccessKey("commons", id);
  }
  send("bob", T.MESSAGE_POSTED, { messageId: "chat-1", body: "typo here" });
  // One open reply request is what arms the whole-message-list comparison.
  send("alice", T.MESSAGE_POSTED, { messageId: "req-1", body: "Please confirm", toMemberId: "bob", requestKind: "reply" });
  return { store, send, keys };
}

test("a room with a reply request audits clean before anything is edited", t => {
  const { store } = room(t);
  assert.doesNotThrow(() => auditRecovery(store));
});

test("editing a message unrelated to any request does not fail the audit", t => {
  const { store, send } = room(t);
  send("bob", T.MESSAGE_EDITED, { messageId: "chat-1", body: "typo fixed", expectedMessageRevision: 0 });
  // The projection and a full replay agree; only the auditor's own narrower
  // rebuild ever disagreed.
  assert.deepEqual(store.room("commons"), store.rebuildProjection("commons"));
  assert.doesNotThrow(() => auditRecovery(store), "a corrected typo must not take backups down");
});

test("editing the request message itself does not fail the audit", t => {
  const { store, send } = room(t);
  send("alice", T.MESSAGE_EDITED, { messageId: "req-1", body: "Please confirm today", expectedMessageRevision: 0 });
  assert.doesNotThrow(() => auditRecovery(store));
});

test("deleting a message does not fail the audit, and the tombstone is replayed", t => {
  const { store, send } = room(t);
  send("bob", T.MESSAGE_DELETED, { messageId: "chat-1", expectedMessageRevision: 0 });
  assert.equal(store.room("commons").state.messages.find(message => message.id === "chat-1").body, null);
  assert.doesNotThrow(() => auditRecovery(store));
});

test("repeated edits and then a delete on the same message audit clean", t => {
  const { store, send } = room(t);
  send("bob", T.MESSAGE_EDITED, { messageId: "chat-1", body: "v2", expectedMessageRevision: 0 });
  send("bob", T.MESSAGE_EDITED, { messageId: "chat-1", body: "v3", expectedMessageRevision: 1 });
  send("bob", T.MESSAGE_DELETED, { messageId: "chat-1", expectedMessageRevision: 2 });
  assert.doesNotThrow(() => auditRecovery(store));
});

// --- the audit must still be an audit ---

const edited = t => {
  const fixture = room(t);
  fixture.send("bob", T.MESSAGE_EDITED, { messageId: "chat-1", body: "typo fixed", expectedMessageRevision: 0 });
  return fixture;
};

test("a projection body rewritten behind the log is still caught", t => {
  const { store } = edited(t);
  const state = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id=?").get("commons").projection);
  state.messages.find(message => message.id === "chat-1").body = "planted text nobody sent";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(state), "commons");
  assert.throws(() => auditRecovery(store));
});

test("a rewritten edit event is still caught", t => {
  const { store } = edited(t);
  const row = store.db.prepare("SELECT rowid, body FROM events WHERE room_id=? AND body LIKE '%message.edited%'").get("commons");
  const event = JSON.parse(row.body);
  event.data.body = "forged edit";
  store.db.prepare("UPDATE events SET body=? WHERE rowid=?").run(JSON.stringify(event), row.rowid);
  assert.throws(() => auditRecovery(store));
});

test("an edit naming a message that was never posted is still caught", t => {
  const { store } = edited(t);
  const row = store.db.prepare("SELECT rowid, body FROM events WHERE room_id=? AND body LIKE '%message.edited%'").get("commons");
  const event = JSON.parse(row.body);
  event.data.messageId = "never-posted";
  store.db.prepare("UPDATE events SET body=? WHERE rowid=?").run(JSON.stringify(event), row.rowid);
  assert.throws(() => auditRecovery(store), "the rebuild must refuse to edit a message it has no record of");
});

test("removing the edit event while the projection keeps the edit is still caught", t => {
  const { store } = edited(t);
  const { sequence } = store.db.prepare("SELECT sequence FROM events WHERE room_id=? AND body LIKE '%message.edited%'").get("commons");
  // commands references events(room_id, sequence); the receipt goes first.
  store.db.prepare("DELETE FROM commands WHERE room_id=? AND sequence=?").run("commons", sequence);
  store.db.prepare("DELETE FROM events WHERE room_id=? AND sequence=?").run("commons", sequence);
  assert.throws(() => auditRecovery(store));
});

test("a message injected straight into the projection is still caught", t => {
  const { store } = edited(t);
  const state = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id=?").get("commons").projection);
  state.messages.push({ id: "ghost", authorId: "bob", body: "never posted", workItemId: null, replyToId: null, toMemberId: null, createdAt: "2026-01-01T00:00:00.000Z" });
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(state), "commons");
  assert.throws(() => auditRecovery(store));
});
