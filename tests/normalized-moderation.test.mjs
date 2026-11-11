import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { operatorNormalization } from "../server/operator-normalization.mjs";
import { demoteToReadonly } from "../server/autonomy-tiers.mjs";

test("normalized moderation preserves private messages, owner authority, readonly denial and duplicate receipts after restart", t => {
  const dir = mkdtempSync(join(tmpdir(), "normalized-moderation-")), path = join(dir, "room.sqlite");
  let store = new RoomStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data) => store.command(keys[actor], "commons", { id: randomUUID(), type, data });
  for (const memberId of ["alice", "bob", "carol", "agent"]) {
    send("owner", "member.added", { memberId, displayName: memberId, kind: memberId === "agent" ? "agent" : "human", permissions: [], ...(memberId === "agent" ? { accountableHumanId: "owner" } : {}) });
    keys[memberId] = store.issueAccessKey("commons", memberId);
  }
  send("alice", "message.posted", { messageId: "private", body: "PRIVATE alice to bob", toMemberId: "bob" });
  send("alice", "message.posted", { messageId: "public", body: "public hello" });
  const plan = operatorNormalization(store, { roomId: "commons", discardLegacyAssignments: true });
  operatorNormalization(store, { roomId: "commons", discardLegacyAssignments: true, planHash: plan.planHash, requestId: "moderation-adopt", reason: "Moderation qualification" }, true);
  store.close(); store = new RoomStore(path);
  store.room = () => { throw Error("whole-room hydration forbidden"); };
  const report = (who, messageId) => store.moderation.report(keys[who], "commons", { messageId, reason: "spam" });
  assert.throws(() => report("carol", "private"), error => error.code === "message_not_found");
  const receipt = report("bob", "private");
  assert.equal(report("bob", "private").duplicate, true);
  assert.deepEqual(report("bob", "private").report, receipt.report);
  report("bob", "public");
  assert.throws(() => store.moderation.list(keys.bob, "commons"), error => error.code === "owner_required");
  const reports = store.moderation.list(keys.owner, "commons").reports;
  assert.equal(reports.find(row => row.messageId === "private").message.private, true);
  assert.equal(JSON.stringify(reports).includes("PRIVATE"), false);
  assert.equal(reports.find(row => row.messageId === "public").message.body, "public hello");
  demoteToReadonly(store.db, "commons", "agent", { updatedBy: "owner", nowMs: Date.now() });
  assert.throws(() => report("agent", "public"), error => error.code === "agent_readonly");
  send("alice", "message.deleted", { messageId: "private", expectedMessageRevision: 0 });
  const deleted = store.moderation.list(keys.owner, "commons").reports.find(row => row.messageId === "private");
  assert.equal(deleted.message.body, null);
  assert.equal(deleted.message.private, true);
  assert.ok(deleted.message.deletedAt);
});
