import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier, getTier, T1_CHAT_ALLOWED_COMMANDS } from "../server/autonomy-tiers.mjs";

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "tier-chat-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.parse("2026-11-02T12:00:00Z") });
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "agent", displayName: "Chat agent", kind: "agent", permissions: ["accept_work"], accountableHumanId: "owner" });
  keys.agent = store.issueAccessKey("commons", "agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, send };
}

test("t1_chat: allowed set is the read-only set plus chat", () => {
  for (const type of [T.MESSAGE_POSTED, T.MESSAGE_EDITED, T.MESSAGE_DELETED, T.DM_POSTED, T.SESSION_STOPPED])
    assert.ok(T1_CHAT_ALLOWED_COMMANDS.has(type), type);
  assert.ok(!T1_CHAT_ALLOWED_COMMANDS.has(T.WORK_PROPOSED));
  assert.ok(!T1_CHAT_ALLOWED_COMMANDS.has(T.MEMBER_ADDED));
});

test("t1_chat: agent can post but work writes are 403 agent_chat_only with a promote hint; promotion lifts the tier gate", t => {
  const f = serve(t);
  setTier(f.store.db, "commons", "agent", "t1_chat", { updatedBy: "owner", nowMs: Date.now() });
  assert.equal(getTier(f.store.db, "commons", "agent").autonomyTier, "t1_chat");
  f.send("agent", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "chat lands" });
  const propose = () => f.send("agent", T.WORK_PROPOSED, { workItemId: `w-${randomUUID()}`, title: "x", definitionOfDone: "d", accountableMemberId: "agent", mode: "read" });
  let error; try { propose(); } catch (e) { error = e; }
  assert.equal(error?.status, 403);
  assert.equal(error?.code, "agent_chat_only");
  assert.match(error.message, /promote/);
  setTier(f.store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  // Past the tier gate, ordinary permission checks apply again.
  let after; try { propose(); } catch (e) { after = e; }
  assert.notEqual(after?.code, "agent_chat_only");
});

import { canonicalNeedsMeRoom } from "./helpers/canonical-needs-me-room.mjs";
import { isCurrentRoom } from "../server/current-room-repository.mjs";
import { getAgentAutonomyTier, setAgentAutonomyTier, enforceAutonomyTiers, T1_READONLY_ALLOWED_COMMANDS } from "../server/autonomy-tiers.mjs";

test("t1_chat: owner GET/PUT work on a normalized (current) room", t => {
  const f = canonicalNeedsMeRoom(t);
  assert.equal(isCurrentRoom(f.store.db, f.roomId), true);
  const member = f.worker.identityId;
  const before = getAgentAutonomyTier(f.store, f.owner.secret, f.roomId, member);
  assert.equal(before.status.autonomyTier, "t2_standard");
  const put = setAgentAutonomyTier(f.store, f.owner.secret, f.roomId, member, { autonomyTier: "t1_chat" });
  assert.equal(put.status.autonomyTier, "t1_chat");
  assert.equal(typeof put.evaluatedThrough, "number");
  assert.equal(getAgentAutonomyTier(f.store, f.owner.secret, f.roomId, member).status.autonomyTier, "t1_chat");
  f.send(f.worker, T.MESSAGE_POSTED, { messageId: "chat-ok", body: "chat lands in a current room" });
  let error; try { f.propose("blocked-by-tier", { accountable: member }); f.send(f.worker, T.WORK_ACCEPTED, { workItemId: "blocked-by-tier", expectedRevision: f.item("blocked-by-tier").revision }); } catch (e) { error = e; }
  assert.equal(error?.code, "agent_chat_only");
  let notOwner; try { setAgentAutonomyTier(f.store, f.worker.secret, f.roomId, member, { autonomyTier: "t2_standard" }); } catch (e) { notOwner = e; }
  assert.equal(notOwner?.status, 403);
  assert.equal(setAgentAutonomyTier(f.store, f.owner.secret, f.roomId, member, { autonomyTier: "t2_standard" }).status.autonomyTier, "t2_standard");
});

test("t1_chat rollback fence: an older reader sees t1_readonly (narrower), never t2", t => {
  const f = serve(t);
  setTier(f.store.db, "commons", "agent", "t1_chat", { updatedBy: "owner", nowMs: 1 });
  const raw = f.store.db.prepare("SELECT autonomy_tier FROM agent_autonomy_tiers WHERE room_id=? AND member_id=?").get("commons", "agent");
  assert.equal(raw.autonomy_tier, "t1_readonly", "persisted value is one an older reader already understands");
  // Older reader logic: only t1_readonly restricts; it would refuse chat and work alike.
  const oldReaderRefuses = type => raw.autonomy_tier === "t1_readonly" && !T1_READONLY_ALLOWED_COMMANDS.has(type);
  assert.equal(oldReaderRefuses(T.WORK_PROPOSED), true);
  assert.equal(oldReaderRefuses(T.MESSAGE_POSTED), true);
  // Existing grants unchanged: t1_readonly and t2_standard rows keep their meaning.
  setTier(f.store.db, "commons", "agent", "t1_readonly", { updatedBy: "owner", nowMs: 2 });
  assert.equal(getTier(f.store.db, "commons", "agent").autonomyTier, "t1_readonly");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM agent_chat_tiers").get().n, 0, "demotion clears the chat widening");
  setTier(f.store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: 3 });
  assert.equal(getTier(f.store.db, "commons", "agent").autonomyTier, "t2_standard");
  void enforceAutonomyTiers;
});
