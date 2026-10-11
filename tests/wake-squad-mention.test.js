// WAVE-500 guild 5 (wakes & notifications): enqueueWake input validation.
//
// BUG: agentWakeTargets tagged @squad/<name> hits as kind "squad-mention",
// but the wake queue only accepts mention|dm (WAKE_KINDS + the DB CHECK).
// For an agent with a registered host, enqueueWake threw 422 invalid_wake
// inside the message-post transaction — the whole message post failed.
// A squad mention must wake as a plain "mention" and never fail the post.
//
// The rest of this file locks the enqueueWake input contract: kinds outside
// {mention, dm} rejected, roomId "" vs null, messageId empty, agentId shape,
// and wakeIfOffline with zero hosts returning woken:false without enqueueing.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { createSquad } from "../server/squads.mjs";
import { HeartbeatError } from "../server/agent-heartbeats.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  const owner = store.identities.create("Squad owner");
  new AgentRooms(store).create(owner.secret, {
    roomId: "squad-room", title: "Squad", purpose: "squad-mention wake test",
  });
  const agent = store.identities.create("Helper agent");
  const cmd = (token, type, data) =>
    store.command(token, "squad-room", { id: randomUUID(), type, data });
  // link() creates the member record with kind "agent" and the identity link.
  store.identities.link(owner.secret, "squad-room", {
    identityId: agent.identityId, memberId: "helper",
    displayName: "Helper", permissions: [],
  });
  return { store, owner, agent, cmd };
}

const invalidWake = err =>
  err instanceof HeartbeatError && err.status === 422 && err.code === "invalid_wake";

test("squad mention wakes the agent as kind=mention and the message post lands", t => {
  const { store, owner, agent, cmd } = fixture(t);
  store.agentHeartbeats.heartbeat({
    agentId: agent.identityId, hostId: "laptop", mode: "pull-only",
  });
  createSquad(store, owner.secret, "squad-room", {
    name: "crew", goal: "ship it", memberIds: ["helper"],
  });
  const messageId = randomUUID();
  // Fail-first: threw 422 invalid_wake (kind "squad-mention") and the post died.
  const result = cmd(owner.secret, T.MESSAGE_POSTED, {
    messageId, body: "@squad/crew please help",
  });
  assert.ok(result?.event, "message post must succeed");
  const pending = store.agentHeartbeats.pendingWakes(agent.identityId);
  assert.equal(pending.length, 1, "one wake signal enqueued");
  assert.equal(pending[0].kind, "mention");
  assert.equal(pending[0].messageId, messageId);
});

test("enqueueWake rejects kinds outside {mention, dm}", t => {
  const { store, agent } = fixture(t);
  const hb = store.agentHeartbeats;
  const base = { agentId: agent.identityId, roomId: "r" };
  let n = 0;
  for (const kind of ["Mention", "DM", "", " ", "squad-mention", "ping", null, undefined, 42, ["dm"]]) {
    assert.throws(
      () => hb.enqueueWake({ ...base, kind, messageId: `m-kind-${n++}` }),
      invalidWake,
      `kind ${JSON.stringify(kind)} must be rejected`,
    );
  }
  assert.equal(
    store.db.prepare("SELECT COUNT(*) n FROM agent_wake_signals").get().n, 0,
    "rejected enqueues store nothing",
  );
});

test("enqueueWake rejects empty roomId but accepts null", t => {
  const { store, agent } = fixture(t);
  const hb = store.agentHeartbeats;
  const base = { agentId: agent.identityId, kind: "mention" };
  for (const roomId of ["", 0, 123, {}, []]) {
    assert.throws(
      () => hb.enqueueWake({ ...base, roomId, messageId: `m-room-${JSON.stringify(roomId)}` }),
      invalidWake,
      `roomId ${JSON.stringify(roomId)} must be rejected`,
    );
  }
  // null (and omitted) roomId is the valid "no room" shape.
  assert.equal(hb.enqueueWake({ ...base, roomId: null, messageId: "m-null" }).enqueued, true);
  assert.equal(hb.enqueueWake({ ...base, messageId: "m-omitted" }).enqueued, true);
});

test("enqueueWake rejects empty messageId and malformed agentId", t => {
  const { store, agent } = fixture(t);
  const hb = store.agentHeartbeats;
  for (const messageId of ["", null, undefined, 42, {}]) {
    assert.throws(
      () => hb.enqueueWake({ agentId: agent.identityId, kind: "dm", roomId: "r", messageId }),
      invalidWake,
      `messageId ${JSON.stringify(messageId)} must be rejected`,
    );
  }
  for (const agentId of ["", "bad id!", "ai/nope", "x".repeat(65), null, 42]) {
    assert.throws(
      () => hb.enqueueWake({ agentId, kind: "dm", roomId: "r", messageId: "m-a" }),
      err => err instanceof HeartbeatError && err.status === 422,
      `agentId ${JSON.stringify(agentId)} must be rejected`,
    );
  }
});

test("wakeIfOffline with zero hosts returns woken:false and enqueues nothing", t => {
  const { store, agent } = fixture(t);
  const result = store.agentHeartbeats.wakeIfOffline({
    agentId: agent.identityId, kind: "mention", roomId: "r", messageId: "m0",
  });
  assert.deepEqual(result, { woken: false, signal: null });
  assert.equal(
    store.db.prepare("SELECT COUNT(*) n FROM agent_wake_signals").get().n, 0,
    "no signal enqueued nowhere",
  );
});
