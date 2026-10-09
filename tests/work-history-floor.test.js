// PRIV-2 for work reads: a since_join member reading the discussion or source
// of a work item proposed before their join must not get pre-join bodies.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

test("work discussion and work source follow the since_join floor", t => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "work-history-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  let now = Date.parse("2026-10-08T00:00:00.000Z");
  store.now = () => (now += 1000);
  const owner = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });

  cmd(T.MESSAGE_POSTED, { messageId: "src-msg", body: "pre-join source secret" });
  cmd(T.WORK_PROPOSED, { workItemId: "w-1", title: "Old work", definitionOfDone: "Done.", accountableMemberId: "owner", mode: "read", sourceMessageId: "src-msg" });
  cmd(T.MESSAGE_POSTED, { messageId: "old-linked", body: "pre-join discussion secret", workItemId: "w-1" });
  cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
  cmd(T.MEMBER_ADDED, { memberId: "late-human", displayName: "Late human", kind: "human", permissions: [] });
  const late = store.issueAccessKey("commons", "late-human");
  cmd(T.MESSAGE_POSTED, { messageId: "new-linked", body: "post-join note", workItemId: "w-1" });

  const discussion = store.workDiscussion(late, "commons", "w-1", {});
  assert.deepEqual(discussion.discussion.items.map(item => item.message.id), ["new-linked"]);
  assert.equal(JSON.stringify(discussion).includes("secret"), false);
  const context = store.workContext(late, "commons", "w-1", { includeSource: true });
  assert.equal(context.context.source.status, "unavailable");
  assert.equal(context.context.source.message, null);
  assert.equal(JSON.stringify(context).includes("pre-join source secret"), false);
  // A full-history reader still sees everything.
  assert.deepEqual(store.workDiscussion(owner, "commons", "w-1", {}).discussion.items.map(item => item.message.id), ["src-msg", "old-linked", "new-linked"]);
  assert.equal(store.workContext(owner, "commons", "w-1", { includeSource: true }).context.source.status, "included");
});
