import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { wokenThreadIds } from "../server/thread-mutes.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-snooze-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data) => store.command(keys[actor], "commons", { id: randomUUID(), type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: [] });
  keys.maya = store.issueAccessKey("commons", "maya");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = (actor, data) => send(actor, T.MESSAGE_POSTED, data);
  return { store, keys, post };
}

test("wokenThreadIds: only someone else's later message ends a snooze", () => {
  const messages = [
    { id: "root", authorId: "maya", createdAt: "2026-10-20T10:00:00.000Z" },
    { id: "mine", authorId: "owner", replyToId: "root", createdAt: "2026-10-20T10:05:00.000Z" },
    { id: "late", authorId: "maya", replyToId: "mine", createdAt: "2026-10-20T10:06:00.000Z" },
  ];
  const at = Date.parse("2026-10-20T10:01:00.000Z");
  assert.deepEqual([...wokenThreadIds(messages, "owner", [{ thread_id: "root", snoozed_at: at }])], ["root"]);
  assert.deepEqual([...wokenThreadIds(messages.slice(0, 2), "owner", [{ thread_id: "root", snoozed_at: at }])], [], "your own reply does not wake it");
  assert.deepEqual([...wokenThreadIds(messages, "owner", [])], []);
});

test("snooze hides a thread until its next message from someone else", async t => {
  const { store, keys, post } = setup(t);
  post("maya", { messageId: "root", body: "thread start" });
  await delay(5);
  const set = store.threadMutes.set(keys.owner, "commons", { threadId: "root", muted: true, until: "next_message" });
  assert.equal(set.until, "next_message");
  assert.ok(store.threadMutes.mutedThreadIds("commons", "owner").has("root"));
  assert.deepEqual(store.threadMutes.list(keys.owner, "commons").snoozedThreadIds, ["root"]);
  assert.deepEqual(store.threadMutes.list(keys.owner, "commons").threadIds, [], "a snooze is not a mute");
  await delay(5);
  post("owner", { messageId: "mine", body: "noted", replyToId: "root" });
  assert.ok(store.threadMutes.mutedThreadIds("commons", "owner").has("root"), "your own reply keeps it snoozed");
  await delay(5);
  post("maya", { messageId: "next", body: "update", replyToId: "mine" });
  assert.equal(store.threadMutes.mutedThreadIds("commons", "owner").has("root"), false, "the next message brings it back");
  assert.deepEqual(store.threadMutes.list(keys.owner, "commons").snoozedThreadIds, []);
});

test("unmute clears a snooze; until is validated", t => {
  const { store, keys, post } = setup(t);
  post("maya", { messageId: "root", body: "thread start" });
  store.threadMutes.set(keys.owner, "commons", { threadId: "root", muted: true, until: "next_message" });
  store.threadMutes.set(keys.owner, "commons", { threadId: "root", muted: false });
  assert.equal(store.threadMutes.mutedThreadIds("commons", "owner").has("root"), false);
  assert.throws(() => store.threadMutes.set(keys.owner, "commons", { threadId: "root", muted: true, until: "tomorrow" }), /until must be next_message/);
  assert.throws(() => store.threadMutes.set(keys.owner, "commons", { threadId: "root", muted: false, until: "next_message" }), /only applies when muted/);
});
