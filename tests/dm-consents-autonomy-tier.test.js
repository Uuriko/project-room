// Issue #995: DM consent requests skipped the t1_readonly gate because
// DmConsents.request writes directly without store.command(). Requests are
// new outbound contact, so a readonly agent is refused; the protective
// actions (decide/block/revoke/unblock) stay open because they only
// protect the caller.
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
  const directory = mkdtempSync(join(tmpdir(), "dm-consent-tier-"));
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

test("t2_standard agent can send a DM consent request", t => {
  const f = setup(t);
  const pair = f.store.dmConsents.request("commons", "agent2", "guest", "hello");
  assert.equal(pair.status, "pending");
  assert.equal(pair.requesterId, "agent2");
  assert.equal(pair.targetId, "guest");
});

test("t1_readonly agent is refused DM consent requests with 403 agent_readonly", t => {
  const f = setup(t);
  f.demote("agent");
  const refused = capture(() => f.store.dmConsents.request("commons", "agent", "guest", "hello"));
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "agent_readonly");
  // The refusal must not leave a row behind.
  assert.deepEqual(f.store.dmConsents.list("commons", "agent"), []);
});

test("t1_readonly agent keeps protective actions: decide, revoke, block, unblock", t => {
  const f = setup(t);
  f.demote("agent");
  // The human guest requests consent toward the demoted agent; the agent
  // (target) may still decide on requests addressed to it.
  const pair = f.store.dmConsents.request("commons", "guest", "agent", "may I write you?");
  assert.equal(pair.status, "pending");
  const approved = f.store.dmConsents.decide("commons", "agent", "guest", "approve");
  assert.equal(approved.status, "approved");

  // Either participant may revoke an approved consent.
  const revoked = f.store.dmConsents.revoke("commons", "agent", "guest");
  assert.equal(revoked.status, "revoked");

  // Proactive block needs no existing request, and unblock reverses it.
  const blocked = f.store.dmConsents.block("commons", "agent", "guest");
  assert.equal(blocked.status, "blocked");
  const unblocked = f.store.dmConsents.unblock("commons", "agent", "guest");
  assert.equal(unblocked.status, "rejected");
});

test("human members are never tier-restricted on the request path", t => {
  const f = setup(t);
  const pair = f.store.dmConsents.request("commons", "guest", "agent", "hi");
  assert.equal(pair.status, "pending");
});
