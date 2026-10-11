// FAIL-FIRST for w500-g5/f1: @squad/<name> mention of a wakeable agent
// member must not fail the whole message.posted command.
// Bug: agentWakeTargets() (server/store.mjs) emits kind "squad-mention",
// but WAKE_KINDS (server/agent-heartbeats.mjs) only admits
// ["mention", "dm"], so enqueueWake() check()-throws 422 invalid_wake
// inside the message.posted transaction -> the post rolls back.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createSquad } from "../server/squads.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-squad-wake-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const cmd = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data });
  return { directory, store, ownerKey, cmd };
}

test("@squad/<name> mentioning a wakeable agent posts the message and queues a wake", t => {
  const { store, ownerKey, cmd } = fixture(t);

  // Linked agent identity with a registered (offline-capable) host.
  // Display name chosen so the direct-mention resolver does NOT match the
  // @squad/<name> handle as a plain mention: only the squad-mention path
  // may resolve this body.
  const identity = store.identities.create("helios-wake-agent");
  store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, memberId: "squadagent",
    displayName: "Helios Unit", permissions: ["accept_work"],
  });
  store.agentHeartbeats.heartbeat({ agentId: identity.identityId, hostId: "host-1", mode: "wakeable" });

  // Squad with the agent as a member.
  const root = cmd(ownerKey, T.MESSAGE_POSTED, { messageId: "thread-root", body: "launch plan" });
  const rootId = root.event.data.messageId;
  createSquad(store, ownerKey, "commons", {
    name: "crew", goal: "ship", channelMessageId: rootId, memberIds: ["squadagent"],
  });

  // The fan-out: posting "@squad/crew" must not throw; the agent wakes.
  const posted = cmd(ownerKey, T.MESSAGE_POSTED, {
    messageId: "squad-mention-1", body: "crew assemble: @squad/crew let's ship it",
  });
  assert.equal(posted.event.data.messageId, "squad-mention-1", "the message posted");

  const pending = store.agentHeartbeats.pendingWakes(identity.identityId);
  assert.equal(pending.length, 1, "one wake signal for the squad mention");
  // Squad fan-out normalizes to a plain "mention" signal: the
  // agent_wake_signals CHECK admits only ('mention','dm').
  assert.equal(pending[0].kind, "mention");
  assert.equal(pending[0].messageId, "squad-mention-1");
});

test("@squad/<name> mention of an agent with no host posts but queues nothing", t => {
  const { store, ownerKey, cmd } = fixture(t);

  const identity = store.identities.create("squad-nohost-agent");
  store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, memberId: "nohost",
    displayName: "No Host", permissions: ["accept_work"],
  });
  // No heartbeat: no host, no wake.

  const root = cmd(ownerKey, T.MESSAGE_POSTED, { messageId: "thread-root-2", body: "launch plan" });
  createSquad(store, ownerKey, "commons", {
    name: "crew2", goal: "ship", channelMessageId: root.event.data.messageId, memberIds: ["nohost"],
  });

  const posted = cmd(ownerKey, T.MESSAGE_POSTED, {
    messageId: "squad-mention-2", body: "go @squad/crew2",
  });
  assert.equal(posted.event.data.messageId, "squad-mention-2", "the message posted");
  assert.deepEqual(store.agentHeartbeats.pendingWakes(identity.identityId), [],
    "no wake signal for an agent with no host");
});
