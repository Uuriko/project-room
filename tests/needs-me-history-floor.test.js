// PRIV-2: collectNeedsMe must not return a mention or room DM body from before
// a since_join reactivation. This read does not call listActivity, listRoomUpdates,
// Notifications.list, or ReplyRequests.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { collectNeedsMe } from "../server/needs-me.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function room() {
  const store = new RoomStore(":memory:");
  const rooms = new AgentRooms(store);
  const ada = store.identities.create("Ada");
  const late = store.identities.create("Casey");
  const bob = store.identities.create("Bob");
  rooms.create(ada.secret, { roomId: "commons", title: "Commons", purpose: "test", kind: "personal" });
  store.identities.link(ada.secret, "commons", { identityId: late.identityId, displayName: "Casey", permissions: [] });
  store.identities.link(ada.secret, "commons", { identityId: bob.identityId, displayName: "Bob", permissions: [] });
  setTier(store.db, "commons", bob.identityId, "t2_standard", { updatedBy: ada.identityId, nowMs: Date.now() });
  setTier(store.db, "commons", late.identityId, "t2_standard", { updatedBy: ada.identityId, nowMs: Date.now() });
  const cmd = (secret, type, data, id) => store.command(secret, "commons", { id, type, data });
  return { store, ada, late, bob, cmd };
}

function reactivate(ctx) {
  const rev = ctx.store.snapshot(ctx.ada.secret, "commons").state.members[ctx.late.identityId].revision;
  ctx.cmd(ctx.ada.secret, T.MEMBER_ACCESS_CHANGED, {
    memberId: ctx.late.identityId, expectedMemberRevision: rev, permissions: [], active: false,
  }, "remove-casey");
  const removed = ctx.store.snapshot(ctx.ada.secret, "commons").state.members[ctx.late.identityId].revision;
  ctx.cmd(ctx.ada.secret, T.MEMBER_ACCESS_CHANGED, {
    memberId: ctx.late.identityId, expectedMemberRevision: removed, permissions: [], active: true,
  }, "reactivate-casey");
}

test("a since_join reactivation hides the earlier needs-me mention and DM body", () => {
  const ctx = room();
  try {
    ctx.cmd(ctx.ada.secret, T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" }, "vis");
    ctx.cmd(ctx.bob.secret, T.MESSAGE_POSTED, { messageId: "gap-msg", body: "gap secret for @Casey" }, "gap-msg");
    ctx.cmd(ctx.bob.secret, T.MESSAGE_POSTED, { messageId: "gap-dm", body: "dm secret before rejoin", toMemberId: ctx.late.identityId }, "gap-dm");
    reactivate(ctx);
    ctx.cmd(ctx.bob.secret, T.MESSAGE_POSTED, { messageId: "after-msg", body: "welcome back @Casey" }, "after-msg");
    ctx.cmd(ctx.bob.secret, T.MESSAGE_POSTED, { messageId: "after-dm", body: "welcome back privately", toMemberId: ctx.late.identityId }, "after-dm");

    const page = collectNeedsMe(ctx.store, ctx.late.secret);
    const mentions = page.items.filter(item => item.kind === "mention");
    const dms = page.items.filter(item => item.kind === "dm" && item.channel === "room");
    assert.equal(JSON.stringify(page).includes("gap secret"), false);
    assert.equal(JSON.stringify(page).includes("dm secret"), false);
    assert.deepEqual(mentions.map(item => item.id), ["after-msg"]);
    assert.equal(mentions[0].summary, "welcome back @Casey");
    assert.deepEqual(dms.map(item => item.id), ["after-dm"]);
    assert.equal(dms[0].summary, "welcome back privately");
  } finally {
    ctx.store.close();
  }
});

test("a room that does not use since_join still returns the needs-me mention body", () => {
  const ctx = room();
  try {
    ctx.cmd(ctx.bob.secret, T.MESSAGE_POSTED, { messageId: "gap-msg", body: "gap secret for @Casey" }, "gap-msg");
    const page = collectNeedsMe(ctx.store, ctx.late.secret);
    const mentions = page.items.filter(item => item.kind === "mention");
    assert.deepEqual(mentions.map(item => item.id), ["gap-msg"]);
    assert.equal(mentions[0].summary, "gap secret for @Casey");
  } finally {
    ctx.store.close();
  }
});
