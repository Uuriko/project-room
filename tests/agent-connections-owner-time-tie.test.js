import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture(t) {
  const now = Date.now();
  const store = new RoomStore(":memory:", { now: () => now });
  store.initialize(initialRoom().map(event => ({ ...event, at: new Date(now).toISOString() })));
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const sessions = new Map([["owner", store.createSession(ownerKey)]]);
  const rooms = new AgentRooms(store);
  const keyHash = () => createHash("sha256").update(randomBytes(32)).digest("hex");
  const created = store.agentConnections.apply(sessions.get("owner").token, "commons", {
    action: "create", requestId: randomUUID(), memberId: "agent-one", displayName: "Agent One",
    access: "collaborate", keyHash: keyHash(), expiresAt: now + 3600000, expectedOwnerRevision: 0
  }, sessions.get("owner").session.sessionBinding);
  for (const id of ["human-two", "human-three", "never-owner"]) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId: id, displayName: id, kind: "human", permissions: ["manage_members"] } });
    store.createAccount(`${id}-account`);
    store.bindHumanAccount("commons", id, `${id}-account`);
    sessions.set(id, store.createSession(store.issueAccessKey("commons", id)));
  }
  const transfer = (from, to) => {
    const session = sessions.get(from);
    return rooms.transfer(session.token, "commons", { toMemberId: to }, session.session.sessionBinding);
  };
  const rotate = sponsor => {
    const session = sessions.get(sponsor), state = store.room("commons").state;
    return store.agentConnections.apply(session.token, "commons", {
      action: "rotate", requestId: randomUUID(), memberId: "agent-one",
      expectedOwnerRevision: state.members[sponsor].revision,
      expectedGeneration: store.agentConnections.row("commons", "agent-one").generation,
      expectedMemberRevision: state.members["agent-one"].revision,
      keyHash: keyHash(), expiresAt: now + 7200000
    }, session.session.sessionBinding);
  };
  return { store, now, created, transfer, rotate };
}

test("same-ms transfers around an intermediate owner's rotation verify and clear the deferred failure", async t => {
  const f = fixture(t);
  f.transfer("owner", "human-two");
  const rotated = f.rotate("human-two");
  assert.equal(rotated.receipt.membershipSequence, null, "existing rotation receipts have no membership event anchor");
  assert.doesNotThrow(() => f.store.agentConnections.verify());
  f.transfer("human-two", "human-three");
  assert.doesNotThrow(() => f.store.agentConnections.verify());
  f.store.recordIntegrityFailure("agent_connections", "", {
    code: "connection_integrity_error", message: "synthetic prior same-ms sponsor mismatch"
  });
  f.store.db.prepare("INSERT INTO integrity_job_cursor(singleton,step) VALUES(1,0) ON CONFLICT(singleton) DO UPDATE SET step=0").run();
  const batch = await f.store.runDeferredIntegrityBatch();
  assert.equal(batch.ran, 2);
  assert.deepEqual(batch.failures.filter(row => row.step === "agent_connections"), []);
});

test("a same-ms transfer cycle retains both intermediate owners even when the final owner equals the initial owner", t => {
  const f = fixture(t);
  f.transfer("owner", "human-two");
  f.rotate("human-two");
  f.transfer("human-two", "human-three");
  f.rotate("human-three");
  f.transfer("human-three", "owner");
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("time-only sponsorship includes only the same-ms owner window, never arbitrary members", t => {
  const f = fixture(t);
  f.transfer("owner", "human-two");
  f.transfer("human-two", "human-three");
  const owners = at => f.store.agentConnections.ownerIdsAt("commons", "human-three", { at });
  assert.deepEqual(owners(f.now - 1), ["owner"]);
  assert.deepEqual(owners(f.now), ["owner", "human-two", "human-three"]);
  assert.deepEqual(owners(f.now + 1), ["human-three"]);
  assert.equal(owners(f.now).includes("never-owner"), false);
});

test("membership-linked receipts still resolve one exact owner by event sequence within a timestamp tie", t => {
  const f = fixture(t);
  const first = f.transfer("owner", "human-two");
  const second = f.transfer("human-two", "human-three");
  const owners = sequence => f.store.agentConnections.ownerIdsAt("commons", "human-three", { sequence, at: f.now });
  assert.deepEqual(owners(f.created.receipt.membershipSequence), ["owner"]);
  assert.deepEqual(owners(first.sequence), ["owner"]);
  assert.deepEqual(owners(second.sequence), ["human-two"]);
  assert.deepEqual(owners(second.sequence + 1), ["human-three"]);
});
