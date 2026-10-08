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
import { listSaved, setSaved } from "../server/activity.mjs";

test("a since_join member cannot save, or read back, a message from before their join", t => {
  const directory = mkdtempSync(join(tmpdir(), "saved-history-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  let now = Date.parse("2026-10-08T00:00:00.000Z");
  store.now = () => (now += 1000);
  const owner = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });

  cmd(T.MESSAGE_POSTED, { messageId: "before-msg", body: "pre-join secret" });
  cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
  cmd(T.MEMBER_ADDED, { memberId: "late-human", displayName: "Late human", kind: "human", permissions: [] });
  const late = store.issueAccessKey("commons", "late-human");
  cmd(T.MESSAGE_POSTED, { messageId: "after-msg", body: "post-join note" });

  assert.throws(() => setSaved(store, late, "commons", { messageId: "before-msg", saved: true }), error => error.status === 404);
  setSaved(store, late, "commons", { messageId: "after-msg", saved: true });
  // A row written earlier (or before a floor moved) is filtered on read too.
  store.db.prepare("INSERT OR IGNORE INTO saved_messages (room_id,member_id,message_id,saved_at) VALUES(?,?,?,?)").run("commons", "late-human", "before-msg", now);
  const listed = listSaved(store, late, "commons");
  assert.deepEqual(listed.items.map(item => item.messageId), ["after-msg"]);
  assert.equal(JSON.stringify(listed).includes("pre-join secret"), false);
  setSaved(store, late, "commons", { messageId: "before-msg", saved: false }); // unsaving stays possible
  setSaved(store, owner, "commons", { messageId: "before-msg", saved: true }); // full-history member unaffected
  assert.deepEqual(listSaved(store, owner, "commons").items.map(item => item.messageId), ["before-msg"]);
});
