// Regression (PRIV): moderation reports must not expose a DM between two other
// members to the room owner, and a member cannot report a DM they cannot read.
// Reported by John's Tab (dpaste 5EZ74HYLW).
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
  const directory = mkdtempSync(join(tmpdir(), "moderation-dm-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data) => store.command(keys[actor], "commons", { id: randomUUID(), type, data });
  for (const memberId of ["alice", "bob", "carol"]) {
    send("owner", T.MEMBER_ADDED, { memberId, displayName: memberId, kind: "human", permissions: [] });
    keys[memberId] = store.issueAccessKey("commons", memberId);
  }
  return { store, keys, send };
}

test("owner cannot read a reported DM between two other members, and outsiders cannot report it", t => {
  const f = fixture(t);
  f.send("alice", T.MESSAGE_POSTED, { messageId: "dm-1", body: "PRIVATE alice to bob", toMemberId: "bob" });
  f.send("alice", T.MESSAGE_POSTED, { messageId: "pub-1", body: "public hello" });
  // A third member (carol, a non-party) cannot confirm or report the DM by id.
  assert.throws(() => f.store.moderation.report(f.keys.carol, "commons", { messageId: "dm-1", reason: "spam" }),
    error => error.status === 404 && error.code === "message_not_found");
  // The recipient may report it; the owner (not a party) sees the record but not the body.
  f.store.moderation.report(f.keys.bob, "commons", { messageId: "dm-1", reason: "harassment" });
  f.store.moderation.report(f.keys.bob, "commons", { messageId: "pub-1", reason: "noise" });
  const { reports } = f.store.moderation.list(f.keys.owner, "commons");
  const dm = reports.find(r => r.messageId === "dm-1");
  assert.equal(dm.reason, "harassment");
  assert.equal(dm.message.body, null, "owner must not read a DM they are not a party to");
  assert.equal(dm.message.private, true);
  assert.equal(JSON.stringify(reports).includes("PRIVATE"), false);
  assert.equal(reports.find(r => r.messageId === "pub-1").message.body, "public hello", "public reports are unchanged");
});

test("owner still reads a reported DM that was sent to the owner", t => {
  const f = fixture(t);
  f.send("alice", T.MESSAGE_POSTED, { messageId: "dm-owner", body: "to the owner", toMemberId: "owner" });
  f.store.moderation.report(f.keys.owner, "commons", { messageId: "dm-owner", reason: "rude" });
  const { reports } = f.store.moderation.list(f.keys.owner, "commons");
  assert.equal(reports[0].message.body, "to the owner");
  assert.equal(reports[0].message.private, undefined);
});

test("a deleted DM stays private: non-parties get 404 on report and the owner's list keeps private:true", t => {
  const f = fixture(t);
  f.send("alice", T.MESSAGE_POSTED, { messageId: "dm-del", body: "PRIVATE deleted", toMemberId: "bob" });
  f.store.moderation.report(f.keys.bob, "commons", { messageId: "dm-del", reason: "harassment" });
  f.send("alice", T.MESSAGE_DELETED, { messageId: "dm-del", expectedMessageRevision: 0 });
  assert.throws(() => f.store.moderation.report(f.keys.carol, "commons", { messageId: "dm-del", reason: "spam" }),
    error => error.status === 404 && error.code === "message_not_found");
  const dm = f.store.moderation.list(f.keys.owner, "commons").reports.find(r => r.messageId === "dm-del");
  assert.equal(dm.message.body, null);
  assert.equal(dm.message.private, true, "the deleted DM row keeps the private marker");
  assert.equal(dm.message.deletedAt !== null, true);
});

test("a deleted public message can still be reported as before", t => {
  const f = fixture(t);
  f.send("alice", T.MESSAGE_POSTED, { messageId: "pub-del", body: "public" });
  f.send("alice", T.MESSAGE_DELETED, { messageId: "pub-del", expectedMessageRevision: 0 });
  f.store.moderation.report(f.keys.carol, "commons", { messageId: "pub-del", reason: "spam" });
  assert.equal(f.store.moderation.list(f.keys.owner, "commons").reports[0].message.private, undefined);
});
