// Issue #997: moderation reports skipped the t1_readonly gate because
// ModerationService.report writes directly without store.command().
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { demoteToReadonly } from "../server/autonomy-tiers.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "moderation-tier-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.parse("2026-09-26T12:00:00Z") });
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "guest", displayName: "Guest human", kind: "human", permissions: [] });
  send("owner", T.MEMBER_ADDED, { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: [], accountableHumanId: "owner" });
  send("owner", T.MEMBER_ADDED, { memberId: "agent2", displayName: "Second agent", kind: "agent", permissions: [], accountableHumanId: "owner" });
  keys.guest = store.issueAccessKey("commons", "guest");
  keys.agent = store.issueAccessKey("commons", "agent");
  keys.agent2 = store.issueAccessKey("commons", "agent2");
  const demote = memberId => demoteToReadonly(store.db, "commons", memberId, { updatedBy: "owner", nowMs: Date.now() });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, keys, send, demote };
}

const capture = fn => { try { fn(); } catch (error) { return error; } throw new Error("expected the function to throw"); };

test("t1_readonly agent cannot file moderation reports; humans and t2 agents can", t => {
  const f = setup(t);
  const messageId = randomUUID();
  f.send("owner", T.MESSAGE_POSTED, { messageId, body: "message to report" });

  // t2 agent files a report normally
  const ok = f.store.moderation.report(f.keys.agent2, "commons", { messageId, reason: "spam" });
  assert.ok(ok, "t2 report should succeed");

  // demoted agent is refused at the tier gate
  f.demote("agent");
  const refused = capture(() => f.store.moderation.report(f.keys.agent, "commons", { messageId, reason: "spam" }));
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "agent_readonly");

  // human member is never tier-restricted
  const human = f.store.moderation.report(f.keys.guest, "commons", { messageId, reason: "dup" });
  assert.ok(human, "human report should succeed");
});
