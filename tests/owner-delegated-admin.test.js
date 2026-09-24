import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests } from "../server/access-requests.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";

const command = (type, data, id = randomUUID()) => ({ id, type, data });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-owner-delegated-admin-"));
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  // A non-owner agent and a non-owner human, both without admin bits.
  store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: "agent", displayName: "Agent", kind: "agent", permissions: ["accept_work"] }));
  store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: "human", displayName: "Human", kind: "human", permissions: ["accept_work"] }));
  // Graduated autonomy tiers: the fixture agent is operator-promoted so the
  // delegation tests exercise the delegation rules, not the tier gate.
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const agent = store.issueAccessKey("commons", "agent");
  const human = store.issueAccessKey("commons", "human");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, owner, agent, human };
}

const revisionOf = (store, memberId) => store.room("commons").state.members[memberId].revision;

test("owner grants admin bits to a non-owner agent; the grant is stamped delegatedAdmin", t => {
  const { store, owner } = fixture(t);
  const result = store.command(owner, "commons", command(T.MEMBER_ACCESS_CHANGED, {
    memberId: "agent", expectedMemberRevision: revisionOf(store, "agent"),
    permissions: ["accept_work", "manage_members"], active: true
  }));
  assert.equal(result.event.data.delegatedAdmin, true);
  const member = store.room("commons").state.members.agent;
  assert.equal(member.delegatedAdmin, true);
  assert.ok(member.permissions.includes("manage_members"));
});

test("delegated agent approves an access request", t => {
  const { store, owner, agent } = fixture(t);
  store.command(owner, "commons", command(T.MEMBER_ACCESS_CHANGED, {
    memberId: "agent", expectedMemberRevision: revisionOf(store, "agent"),
    permissions: ["accept_work", "manage_members"], active: true
  }));
  const requestId = `ar_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const requests = new AccessRequests(store);
  const newcomer = store.identities.create("Newcomer Agent");
  requests.request("commons", {
    identityId: newcomer.identityId, displayName: "New Agent",
    requestedPermissions: ["accept_work"], note: "let me in", requestId
  });
  const decided = requests.decide(agent, "commons", requestId, { decision: "approve", permissions: ["accept_work"] });
  assert.equal(decided.status, "approved");
  assert.equal(decided.decidedBy, "agent");
});

test("delegated agent changes a non-admin permission it holds", t => {
  const { store, owner, agent } = fixture(t);
  store.command(owner, "commons", command(T.MEMBER_ACCESS_CHANGED, {
    memberId: "agent", expectedMemberRevision: revisionOf(store, "agent"),
    permissions: ["accept_work", "manage_members"], active: true
  }));
  // The delegated admin holds accept_work, so it may adjust that grant —
  // but nothing it does stamps delegatedAdmin on someone else.
  const result = store.command(agent, "commons", command(T.MEMBER_ACCESS_CHANGED, {
    memberId: "human", expectedMemberRevision: revisionOf(store, "human"),
    permissions: [], active: true
  }));
  assert.equal(result.event.data.delegatedAdmin, undefined);
  const member = store.room("commons").state.members.human;
  assert.deepEqual(member.permissions, []);
  assert.equal(member.delegatedAdmin, undefined);
});

test("delegated agent cannot grant admin bits to another agent", t => {
  const { store, owner, agent } = fixture(t);
  store.command(owner, "commons", command(T.MEMBER_ACCESS_CHANGED, {
    memberId: "agent", expectedMemberRevision: revisionOf(store, "agent"),
    permissions: ["accept_work", "manage_members"], active: true
  }));
  store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: "agent2", displayName: "Agent 2", kind: "agent", permissions: ["accept_work"] }));
  assert.throws(() => store.command(agent, "commons", command(T.MEMBER_ACCESS_CHANGED, {
    memberId: "agent2", expectedMemberRevision: revisionOf(store, "agent2"),
    permissions: ["accept_work", "manage_members"], active: true
  })), /delegat/i);
});

test("delegated agent cannot grant admin bits to a human either", t => {
  const { store, owner, agent } = fixture(t);
  store.command(owner, "commons", command(T.MEMBER_ACCESS_CHANGED, {
    memberId: "agent", expectedMemberRevision: revisionOf(store, "agent"),
    permissions: ["accept_work", "manage_members"], active: true
  }));
  assert.throws(() => store.command(agent, "commons", command(T.MEMBER_ACCESS_CHANGED, {
    memberId: "human", expectedMemberRevision: revisionOf(store, "human"),
    permissions: ["accept_work", "manage_members"], active: true
  })), /delegat/i);
});

test("owner revoking admin bits clears delegatedAdmin instantly", t => {
  const { store, owner } = fixture(t);
  store.command(owner, "commons", command(T.MEMBER_ACCESS_CHANGED, {
    memberId: "agent", expectedMemberRevision: revisionOf(store, "agent"),
    permissions: ["accept_work", "manage_members"], active: true
  }));
  assert.equal(store.room("commons").state.members.agent.delegatedAdmin, true);
  store.command(owner, "commons", command(T.MEMBER_ACCESS_CHANGED, {
    memberId: "agent", expectedMemberRevision: revisionOf(store, "agent"),
    permissions: ["accept_work"], active: true
  }));
  const member = store.room("commons").state.members.agent;
  assert.equal(member.delegatedAdmin, undefined);
  assert.ok(!member.permissions.includes("manage_members"));
});

test("a non-owner cannot grant admin bits to an agent", t => {
  const { store, human } = fixture(t);
  assert.throws(() => store.command(human, "commons", command(T.MEMBER_ACCESS_CHANGED, {
    memberId: "agent", expectedMemberRevision: revisionOf(store, "agent"),
    permissions: ["accept_work", "manage_members"], active: true
  })), /manage_members|lacks|denied/i);
});

test("ownership transfer clears delegatedAdmin on the new owner", t => {
  const { store, owner } = fixture(t);
  // First make the agent a delegated admin, then transfer ownership to it:
  // ownership supersedes delegation, so the marker is cleared.
  store.command(owner, "commons", command(T.MEMBER_ACCESS_CHANGED, {
    memberId: "agent", expectedMemberRevision: revisionOf(store, "agent"),
    permissions: ["accept_work", "manage_members"], active: true
  }));
  assert.equal(store.room("commons").state.members.agent.delegatedAdmin, true);
  store.command(owner, "commons", command(T.OWNERSHIP_TRANSFERRED, {
    toMemberId: "agent", reason: "test transfer"
  }));
  const state = store.room("commons").state;
  assert.equal(state.room.ownerId, "agent");
  assert.equal(state.members.agent.delegatedAdmin, undefined);
});
