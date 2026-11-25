// PRIV-2 for saved messages: a since_join member could save a pre-join
// message by id and read its body back from the saved list.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { operatorNormalization } from "../server/operator-normalization.mjs";
import { listSaved, setSaved } from "../server/activity.mjs";

for (const representation of ["legacy", "normalized-current-v1"]) test(`Saved respects history and survives restart (${representation})`, t => {
  const directory = mkdtempSync(join(tmpdir(), "saved-history-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  let now = Date.parse("2026-10-08T00:00:00.000Z");
  store.now = () => (now += 1000);
  const owner = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });

  cmd(T.MESSAGE_POSTED, { messageId: "before-msg", body: "pre-join secret" });
  cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
  cmd(T.MEMBER_ADDED, { memberId: "late-human", displayName: "Late human", kind: "human", permissions: [] });
  cmd(T.MEMBER_ADDED, { memberId: "bystander", displayName: "Bystander", kind: "human", permissions: [] });
  const bystander = store.issueAccessKey("commons", "bystander");
  const late = store.issueAccessKey("commons", "late-human");
  cmd(T.MESSAGE_POSTED, { messageId: "after-msg", body: "post-join note" });

  cmd(T.MESSAGE_POSTED, { messageId: "private-note", toMemberId: "late-human", body: "only the parties see me" });
  if (representation === "normalized-current-v1") {
    const selection = { roomId: "commons", discardLegacyAssignments: true };
    const plan = operatorNormalization(store, selection);
    operatorNormalization(store, { ...selection, planHash: plan.planHash,
      reason: "Isolated Saved fixture", requestId: randomUUID() }, true);
  }

  assert.throws(() => setSaved(store, bystander, "commons", { messageId: "private-note", saved: true }), error => error.status === 404);
  store.db.prepare("INSERT INTO saved_messages (room_id,member_id,message_id,saved_at) VALUES(?,?,?,?)")
    .run("commons", "bystander", "private-note", now);
  assert.deepEqual(listSaved(store, bystander, "commons").items, []);
  assert.throws(() => setSaved(store, late, "commons", { messageId: "before-msg", saved: true }), error => error.status === 404);
  setSaved(store, late, "commons", { messageId: "after-msg", saved: true });
  // A row written earlier (or before a floor moved) is filtered on read too.
  store.db.prepare("INSERT OR IGNORE INTO saved_messages (room_id,member_id,message_id,saved_at) VALUES(?,?,?,?)").run("commons", "late-human", "before-msg", now);
  store.close();
  store = new RoomStore(filename, { now: () => (now += 1000) });
  const listed = listSaved(store, late, "commons");
  assert.equal(listed.items[0].authorId, "owner");
  assert.deepEqual(listed.items.map(item => item.messageId), ["after-msg"]);
  assert.equal(JSON.stringify(listed).includes("pre-join secret"), false);
  setSaved(store, late, "commons", { messageId: "before-msg", saved: false }); // unsaving stays possible
  setSaved(store, owner, "commons", { messageId: "before-msg", saved: true }); // full-history member unaffected
  assert.deepEqual(listSaved(store, owner, "commons").items.map(item => item.messageId), ["before-msg"]);
  setSaved(store, late, "commons", { messageId: "private-note", saved: true });
  assert.equal(listSaved(store, late, "commons").items[0].body, "only the parties see me");
  cmd(T.MESSAGE_DELETED, { messageId: "private-note", expectedMessageRevision: 0 });
  const tombstone = listSaved(store, late, "commons").items[0];
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.body, null);
  setSaved(store, late, "commons", { messageId: "private-note", saved: false });
  assert.deepEqual(listSaved(store, late, "commons").items.map(item => item.messageId), ["after-msg"]);
});
