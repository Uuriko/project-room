// PRIV-2: OutsideAgents.list must not return an introduction note posted
// before a since_join reactivation. This read does not call listPins,
// collectNeedsMe, ReplyRequests, or RoomAttachments.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { OutsideAgents, outsideAgentBody } from "../server/outside-agents.mjs";

function room() {
  const directory = mkdtempSync(join(tmpdir(), "outside-agent-history-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  let now = Date.parse("2026-10-08T00:00:00.000Z");
  store.now = () => (now += 1000);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
  cmd(T.MEMBER_ADDED, { memberId: "late", displayName: "Late", kind: "human", permissions: [] });
  return {
    store, owner, cmd, directory,
    net: new OutsideAgents(store),
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

function introduce(ctx, messageId, externalRef, note) {
  ctx.cmd(T.MESSAGE_POSTED, {
    messageId,
    body: outsideAgentBody({
      v: 1, kind: "introduce", externalRef, displayName: externalRef,
      origin: "bus", reach: "bus:room", note,
    }),
  });
}

function gapThenReactivate(ctx) {
  const gapRevision = ctx.store.snapshot(ctx.owner, "commons").state.members.late.revision;
  ctx.cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "late", expectedMemberRevision: gapRevision, permissions: [], active: false });
  introduce(ctx, "gap-msg", "bus:gap", "gap agent secret");
  const removedRevision = ctx.store.snapshot(ctx.owner, "commons").state.members.late.revision;
  ctx.cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "late", expectedMemberRevision: removedRevision, permissions: [], active: true });
  introduce(ctx, "after-msg", "bus:after", "welcome back agent");
}

test("a since_join reactivation hides an outside-agent note from the removal gap", () => {
  const ctx = room();
  try {
    ctx.cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
    gapThenReactivate(ctx);
    const late = ctx.store.issueAccessKey("commons", "late");
    const listed = ctx.net.list(late, "commons");
    assert.equal(JSON.stringify(listed).includes("gap agent secret"), false);
    assert.deepEqual(listed.agents.map(agent => agent.externalRef), ["bus:after"]);
    assert.equal(listed.agents[0].note, "welcome back agent");
    const ownerListed = ctx.net.list(ctx.owner, "commons");
    assert.deepEqual(ownerListed.agents.map(agent => agent.externalRef), ["bus:gap", "bus:after"]);
    assert.equal(ownerListed.agents[0].note, "gap agent secret");
  } finally {
    ctx.close();
  }
});

test("a room that does not use since_join still returns the gap outside-agent note", () => {
  const ctx = room();
  try {
    gapThenReactivate(ctx);
    const late = ctx.store.issueAccessKey("commons", "late");
    const listed = ctx.net.list(late, "commons");
    assert.deepEqual(listed.agents.map(agent => agent.externalRef), ["bus:gap", "bus:after"]);
    assert.equal(listed.agents[0].note, "gap agent secret");
  } finally {
    ctx.close();
  }
});
