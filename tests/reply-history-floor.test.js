// A since_join reader who is removed and reactivated must not read a reply
// request body from the gap. ReplyRequests.page is the shared read for
// selected() and history().
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "reply-history-floor-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  let now = Date.parse("2026-10-08T00:00:00.000Z");
  store.now = () => (now += 1000);
  return {
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function consent(store) {
  store.dmConsents.request("commons", "owner", "late", "fixture");
  store.dmConsents.decide("commons", "late", "owner", "approve");
  store.dmConsents.request("commons", "late", "owner", "fixture");
  store.dmConsents.decide("commons", "owner", "late", "approve");
}

test("a since_join reactivation hides the earlier reply request body", () => {
  const { store, close } = openStore();
  try {
    const owner = store.issueAccessKey("commons", "owner");
    const cmd = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
    cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
    cmd(T.MEMBER_ADDED, { memberId: "late", displayName: "Late", kind: "human", permissions: [] });
    consent(store);
    cmd(T.MESSAGE_POSTED, { messageId: "gap-req", body: "gap secret before rejoin", toMemberId: "late", requestKind: "reply" });
    const gapRevision = store.snapshot(owner, "commons").state.members.late.revision;
    cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "late", expectedMemberRevision: gapRevision, permissions: [], active: false });
    const removedRevision = store.snapshot(owner, "commons").state.members.late.revision;
    cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "late", expectedMemberRevision: removedRevision, permissions: [], active: true });
    const late = store.issueAccessKey("commons", "late");
    cmd(T.MESSAGE_POSTED, { messageId: "after-req", body: "welcome back question", toMemberId: "late", requestKind: "reply" });

    const gap = store.replyRequests.selected(late, "commons", "gap-req");
    const history = store.replyRequests.history(late, "commons", { direction: "incoming" });
    assert.equal(JSON.stringify(gap).includes("gap secret"), false);
    assert.equal(gap.page.items.some(item => item.message?.id === "gap-req"), false);
    assert.equal(JSON.stringify(history).includes("gap secret"), false);
    assert.deepEqual(history.page.items.map(item => item.message?.id), ["after-req"]);
    assert.equal(history.page.items[0].message.body, "welcome back question");
  } finally {
    close();
  }
});

test("a room that does not use since_join still returns the reply request body", () => {
  const { store, close } = openStore();
  try {
    const owner = store.issueAccessKey("commons", "owner");
    const cmd = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
    cmd(T.MEMBER_ADDED, { memberId: "late", displayName: "Late", kind: "human", permissions: [] });
    consent(store);
    cmd(T.MESSAGE_POSTED, { messageId: "gap-req", body: "gap secret before rejoin", toMemberId: "late", requestKind: "reply" });
    const late = store.issueAccessKey("commons", "late");
    const gap = store.replyRequests.selected(late, "commons", "gap-req");
    assert.equal(gap.page.items[0].message.body, "gap secret before rejoin");
  } finally {
    close();
  }
});
