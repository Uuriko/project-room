// Lane-01 (wave-2700 FUNNEL-FIXES) harness for the write_external invite trap,
// as corrected by PACK-REVISION §6 (lane 15) and extended with the revision's
// §7.8–§7.13 acceptance cases and the FUNNEL-FIXES synthesis D-16-2 merge-back
// case (§7.14). Built and run by wave-2900 Lane D builder D14 at pin
// e3b0e8c4d34461105d11c50a9733950b5a40d862 (production; the pack pin 8c9deff7
// and briefed pin 78e9b758 deltas touch none of this item's files).
// Run: node --test tests/write-external-invite-trap.test.js
//
// PART 1 pins the defect: these tests PASS on main (current, broken behaviour).
// PART 2 is the acceptance battery for the cure (item-scoped implied write
// grant, stamp = externalWriteGrantBy + externalWriteGrantFor, granted iff
// the proposer is the room owner or holds write_external at proposal time):
// these tests FAIL on main with /lacks write_external/ and must PASS after.

import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES as T, PERMISSIONS, applyEvent, event, replay } from "../src/events.js";
import { initialRoom } from "../server/bootstrap.mjs";
import { agentAccessProfiles } from "../server/agent-connections.mjs";
import { WRITE_GRANT_POLICY_VERSION } from "../src/work-reducers.js";

const COLLABORATE = ["steer", "accept_work", "complete_work", "verify"];

function fixture() {
  let state = replay(initialRoom());
  // Proposals here model live admission, which stamps the write grant policy.
  const send = (actorId, type, data = {}) => {
    if (type === T.WORK_PROPOSED) data = { ...data, writeGrantPolicyVersion: WRITE_GRANT_POLICY_VERSION };
    state = applyEvent(state, event({ actorId, roomId: "commons", type, data }));
    return state;
  };
  // PACK-REVISION §6 change 2: strip the bootstrap owner's write_external so
  // the fixture owner matches the real seed owner "potter" (src/seed.js:23-28:
  // owner by id only, no write_external). Part 2's journey test then exercises
  // the owner-id branch of the stamp rule in isolation: an implementation
  // checking only hasPermission(proposer, "write_external") fails it.
  send("owner", T.MEMBER_ACCESS_CHANGED, {
    memberId: "owner", expectedMemberRevision: state.members.owner.revision,
    permissions: PERMISSIONS.filter(p => p !== "write_external"), active: true,
  });
  // The invited teammate, admitted exactly as an agent-invite with
  // profile "collaborate" admits them (server/agent-connections.mjs).
  send("owner", T.MEMBER_ADDED, {
    memberId: "invitee", displayName: "Invitee", kind: "agent",
    accountableHumanId: "owner", permissions: [...COLLABORATE],
  });
  // A peer with the same collaborate profile (steer, but NOT the owner
  // and NOT a write_external holder) — the collusion control.
  send("owner", T.MEMBER_ADDED, {
    memberId: "peer", displayName: "Peer", kind: "agent",
    accountableHumanId: "owner", permissions: [...COLLABORATE],
  });
  // PACK-REVISION §6 change 3: a write_external holder (non-owner) — the
  // holder branch of the stamp rule, exercised in isolation below.
  send("owner", T.MEMBER_ADDED, {
    memberId: "holder", displayName: "Holder", kind: "agent",
    accountableHumanId: "owner", permissions: [...COLLABORATE, "write_external"],
  });
  const item = id => state.workItems[id];
  const mutate = (actorId, type, id, data = {}) =>
    send(actorId, type, { workItemId: id, expectedRevision: item(id).revision, ...data });
  const claimFor = (actorId, id) => mutate(actorId, T.CLAIM_ACQUIRED, id, {
    repository: "acme/widgets", ref: `${actorId}/work`,
    paths: ["src/**"], expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const claim = id => claimFor("invitee", id);
  const propose = (actorId, id, accountableMemberId = "invitee") =>
    send(actorId, T.WORK_PROPOSED, {
      workItemId: id, title: `Work ${id}`, definitionOfDone: "Evidence returned",
      accountableMemberId, mode: "write",
    });
  const complete = (actorId, id) => mutate(actorId, T.WORK_COMPLETED, id, {
    summary: "Done", evidenceUrl: "https://example.invalid/result",
    evidenceVersion: "v1", nextAction: "Review",
  });
  const merge = (actorId, keptMemberId, retiredMemberId) =>
    send(actorId, T.MEMBER_MERGED, {
      keptMemberId, retiredMemberId,
      expectedKeptRevision: state.members[keptMemberId].revision,
      expectedRetiredRevision: state.members[retiredMemberId].revision,
    });
  const setActive = (memberId, active) => {
    const member = state.members[memberId];
    send("owner", T.MEMBER_ACCESS_CHANGED, {
      memberId, expectedMemberRevision: member.revision,
      permissions: [...member.permissions], active,
    });
  };
  return { state: () => state, send, item, mutate, claim, claimFor, propose, complete, merge, setActive };
}

// ---------------------------------------------------------------- PART 1

test("trap: no documented invite profile carries write_external", () => {
  for (const profile of ["chat", "contribute", "review", "collaborate", "guest"]) {
    assert.equal(agentAccessProfiles[profile].includes("write_external"), false,
      `${profile} must not silently gain write_external in this pinning test`);
  }
  // The one profile that DOES carry it is "member" — the no-scope default,
  // absent from the packet / tools.md profile guidance. Pinned here so the
  // cure discussion cannot claim it does not exist.
  assert.equal(agentAccessProfiles.member.includes("write_external"), true);
});

test("trap: collaborate invitee accepts write work, claims scope, and still cannot start or complete", () => {
  const f = fixture();
  f.propose("peer", "assigned-write");
  f.mutate("invitee", T.WORK_ACCEPTED, "assigned-write");
  // The claim gate is NOT the trap: a board writer may acquire the claim
  // without write_external (tests/events.test.js pins the same at reducer level).
  f.claim("assigned-write");
  assert.equal(f.item("assigned-write").claim.status, "active");
  assert.throws(() => f.mutate("invitee", T.WORK_STARTED, "assigned-write"),
    /invitee lacks write_external/);
  assert.throws(() => f.mutate("invitee", T.WORK_COMPLETED, "assigned-write", {
    summary: "Done", evidenceUrl: "https://example.invalid/result",
    evidenceVersion: "v1", nextAction: "Review",
  }), /invitee lacks write_external/);
  // Member record is untouched by the refusals: no path in the journey
  // added the permission.
  assert.equal(f.state().members.invitee.permissions.includes("write_external"), false);
});

test("trap control: the same invitee completes the read-mode twin (the round-2 workaround)", () => {
  const f = fixture();
  f.send("owner", T.WORK_PROPOSED, {
    workItemId: "assigned-read", title: "Read twin", definitionOfDone: "Note posted",
    accountableMemberId: "invitee", mode: "read",
  });
  f.mutate("invitee", T.WORK_ACCEPTED, "assigned-read");
  f.mutate("invitee", T.WORK_STARTED, "assigned-read");
  f.mutate("invitee", T.WORK_COMPLETED, "assigned-read", {
    summary: "Note", evidenceUrl: "https://example.invalid/note",
    evidenceVersion: "v1", nextAction: "Review",
  });
  assert.equal(f.item("assigned-read").state, "completed");
});

// ---------------------------------------------------------------- PART 2
// Acceptance for the recommended cure. FAIL on main, PASS after.

test("cure: owner-proposed write item starts and completes on assignment + acceptance + claim, with no room-wide grant", () => {
  const f = fixture();
  f.propose("owner", "cure-write");
  // The stamp binds proposer and accountable member at proposal time.
  assert.equal(f.item("cure-write").externalWriteGrantBy, "owner");
  assert.equal(f.item("cure-write").externalWriteGrantFor, "invitee");
  f.mutate("invitee", T.WORK_ACCEPTED, "cure-write");
  // The exact-scope claim gate survives the cure.
  assert.throws(() => f.mutate("invitee", T.WORK_STARTED, "cure-write"),
    /current exact-scope claim/);
  f.claim("cure-write");
  f.mutate("invitee", T.WORK_STARTED, "cure-write");
  assert.equal(f.item("cure-write").state, "working");
  f.mutate("invitee", T.WORK_COMPLETED, "cure-write", {
    summary: "Done", evidenceUrl: "https://example.invalid/result",
    evidenceVersion: "v1", nextAction: "Review",
  });
  assert.equal(f.item("cure-write").state, "completed");
  // Item-scoped means item-scoped: the member record gains nothing.
  assert.deepEqual([...f.state().members.invitee.permissions].sort(),
    [...COLLABORATE].sort());
});

test("cure: holder-proposed write item stamps via the holder branch (PACK-REVISION §6 change 3)", () => {
  const f = fixture();
  f.propose("holder", "holder-write");
  assert.equal(f.item("holder-write").externalWriteGrantBy, "holder");
  assert.equal(f.item("holder-write").externalWriteGrantFor, "invitee");
  f.mutate("invitee", T.WORK_ACCEPTED, "holder-write");
  assert.throws(() => f.mutate("invitee", T.WORK_STARTED, "holder-write"),
    /current exact-scope claim/);
  f.claim("holder-write");
  f.mutate("invitee", T.WORK_STARTED, "holder-write");
  f.complete("invitee", "holder-write");
  assert.equal(f.item("holder-write").state, "completed");
  assert.deepEqual([...f.state().members.invitee.permissions].sort(),
    [...COLLABORATE].sort());
});

test("cure negative: a write item proposed by a non-owner steer holder without write_external gets NO implied grant", () => {
  const f = fixture();
  f.propose("peer", "peer-write");
  assert.equal(f.item("peer-write").externalWriteGrantBy, undefined);
  assert.equal(f.item("peer-write").externalWriteGrantFor, undefined);
  f.mutate("invitee", T.WORK_ACCEPTED, "peer-write");
  f.claim("peer-write");
  assert.throws(() => f.mutate("invitee", T.WORK_STARTED, "peer-write"),
    /invitee lacks write_external/);
});

test("cure negative: implied grant does not leak to a second item the owner assigned to someone else", () => {
  const f = fixture();
  f.propose("owner", "others-write", "peer");
  f.mutate("peer", T.WORK_ACCEPTED, "others-write");
  // Invitee is not the accountable member: the ordinary guard fires first.
  assert.throws(() => f.mutate("invitee", T.WORK_STARTED, "others-write"),
    /Only the accountable member may start work/);
});

test("cure negative: a revoked invitee cannot start even an owner-proposed item", () => {
  const f = fixture();
  f.propose("owner", "revoked-write");
  f.mutate("invitee", T.WORK_ACCEPTED, "revoked-write");
  f.claim("revoked-write");
  f.setActive("invitee", false);
  assert.throws(() => f.mutate("invitee", T.WORK_STARTED, "revoked-write"),
    /Member access revoked/);
});

test("cure negative: a non-member cannot start an owner-proposed write item", () => {
  const f = fixture();
  f.propose("owner", "outsider-write");
  assert.throws(() => f.mutate("outsider", T.WORK_STARTED, "outsider-write"),
    /Unknown member: outsider/);
});

// ------------------------------------------- PACK-REVISION §7.8–§7.13 cases

test("cure §7.8: a merge that moves accountability voids the stamp for the inheritor", () => {
  const f = fixture();
  f.propose("owner", "merge-write");
  f.mutate("invitee", T.WORK_ACCEPTED, "merge-write");
  f.claim("merge-write");
  f.merge("owner", "peer", "invitee");
  assert.equal(f.item("merge-write").accountableMemberId, "peer");
  assert.equal(f.item("merge-write").claim.holderId, "peer");
  // The stamp fields are untouched in the projection; the void is the
  // stateless comparison externalWriteGrantFor !== accountable actor.
  assert.equal(f.item("merge-write").externalWriteGrantFor, "invitee");
  assert.throws(() => f.mutate("peer", T.WORK_STARTED, "merge-write"),
    /peer lacks write_external/);
  assert.throws(() => f.complete("peer", "merge-write"),
    /peer lacks write_external/);
});

test("cure §7.9: the merge actor's status is irrelevant to the void", () => {
  // (i) non-owner owner-level actor (manage_members + decide, no write_external)
  const f1 = fixture();
  f1.send("owner", T.MEMBER_ADDED, {
    memberId: "admin", displayName: "Admin", kind: "agent",
    accountableHumanId: "owner",
    permissions: ["steer", "manage_members", "decide", "accept_work", "complete_work", "verify"],
  });
  f1.propose("owner", "merge-admin");
  f1.mutate("invitee", T.WORK_ACCEPTED, "merge-admin");
  f1.claim("merge-admin");
  f1.merge("admin", "peer", "invitee");
  assert.throws(() => f1.mutate("peer", T.WORK_STARTED, "merge-admin"),
    /peer lacks write_external/);
  // (ii) merge actor who DOES hold write_external
  const f2 = fixture();
  f2.send("owner", T.MEMBER_ADDED, {
    memberId: "admin2", displayName: "Admin2", kind: "agent",
    accountableHumanId: "owner",
    permissions: ["steer", "manage_members", "decide", "accept_work", "complete_work", "verify", "write_external"],
  });
  f2.propose("owner", "merge-admin2");
  f2.mutate("invitee", T.WORK_ACCEPTED, "merge-admin2");
  f2.claim("merge-admin2");
  f2.merge("admin2", "peer", "invitee");
  assert.throws(() => f2.mutate("peer", T.WORK_STARTED, "merge-admin2"),
    /peer lacks write_external/);
});

test("cure §7.10: a merge not touching accountability leaves the stamp intact (positive control)", () => {
  const f = fixture();
  f.send("owner", T.WORK_PROPOSED, {
    workItemId: "merge-untouched", title: "Work merge-untouched",
    definitionOfDone: "Evidence returned", accountableMemberId: "invitee",
    verifierMemberId: "peer", mode: "write",
  });
  f.mutate("invitee", T.WORK_ACCEPTED, "merge-untouched");
  f.claim("merge-untouched");
  f.merge("owner", "invitee", "peer");
  assert.equal(f.item("merge-untouched").accountableMemberId, "invitee");
  assert.equal(f.item("merge-untouched").verifierMemberId, "invitee");
  f.mutate("invitee", T.WORK_STARTED, "merge-untouched");
  f.complete("invitee", "merge-untouched");
  assert.equal(f.item("merge-untouched").state, "completed");
});

test("cure §7.11: re-stamp path after a voiding merge (fresh proposal to the kept member)", () => {
  const f = fixture();
  f.propose("owner", "merge-voided");
  f.mutate("invitee", T.WORK_ACCEPTED, "merge-voided");
  f.claim("merge-voided");
  f.merge("owner", "peer", "invitee");
  assert.throws(() => f.mutate("peer", T.WORK_STARTED, "merge-voided"),
    /peer lacks write_external/);
  f.propose("owner", "merge-replacement", "peer");
  assert.equal(f.item("merge-replacement").externalWriteGrantFor, "peer");
  f.mutate("peer", T.WORK_ACCEPTED, "merge-replacement");
  f.claimFor("peer", "merge-replacement");
  f.send("owner", T.WORK_SUPERSEDED, {
    workItemId: "merge-voided", expectedRevision: f.item("merge-voided").revision,
    supersededByWorkItemId: "merge-replacement", reason: "Re-authorised after merge",
  });
  f.mutate("peer", T.WORK_STARTED, "merge-replacement");
  f.complete("peer", "merge-replacement");
  assert.equal(f.item("merge-replacement").state, "completed");
  assert.equal(f.item("merge-voided").state, "superseded");
});

test("cure §7.12: a live stamp survives deactivation of its proposer", () => {
  const f = fixture();
  f.propose("holder", "proposer-gone");
  f.mutate("invitee", T.WORK_ACCEPTED, "proposer-gone");
  f.claim("proposer-gone");
  f.setActive("holder", false);
  f.mutate("invitee", T.WORK_STARTED, "proposer-gone");
  f.complete("invitee", "proposer-gone");
  assert.equal(f.item("proposer-gone").state, "completed");
  assert.deepEqual([...f.state().members.invitee.permissions].sort(),
    [...COLLABORATE].sort());
});

test("cure §7.13: a live stamp survives room-ownership transfer; the new owner stamps by the owner-id branch", () => {
  const f = fixture();
  f.send("owner", T.MEMBER_ADDED, {
    memberId: "heir", displayName: "Heir", kind: "human",
    permissions: [...COLLABORATE],
  });
  f.propose("owner", "transfer-write");
  f.mutate("invitee", T.WORK_ACCEPTED, "transfer-write");
  f.claim("transfer-write");
  f.send("owner", T.OWNERSHIP_TRANSFERRED, { toMemberId: "heir" });
  assert.equal(f.state().room.ownerId, "heir");
  f.mutate("invitee", T.WORK_STARTED, "transfer-write");
  f.complete("invitee", "transfer-write");
  assert.equal(f.item("transfer-write").state, "completed");
  // Companion: a write item proposed by the new owner after the transfer stamps.
  f.propose("heir", "heir-write");
  assert.equal(f.item("heir-write").externalWriteGrantBy, "heir");
  assert.equal(f.item("heir-write").externalWriteGrantFor, "invitee");
});

test("cure §7.14 (D-16-2): merge-back + reactivation revives the stamp for the original acceptor only", () => {
  const f = fixture();
  f.propose("owner", "merge-back");
  f.mutate("invitee", T.WORK_ACCEPTED, "merge-back");
  f.claim("merge-back");
  f.merge("owner", "peer", "invitee");
  assert.throws(() => f.mutate("peer", T.WORK_STARTED, "merge-back"),
    /peer lacks write_external/);
  // Reactivate the retired original acceptor, then merge the inheritor back.
  f.setActive("invitee", true);
  f.merge("owner", "invitee", "peer");
  assert.equal(f.item("merge-back").accountableMemberId, "invitee");
  assert.equal(f.item("merge-back").claim.holderId, "invitee");
  f.mutate("invitee", T.WORK_STARTED, "merge-back");
  f.complete("invitee", "merge-back");
  assert.equal(f.item("merge-back").state, "completed");
});

test("cure replay parity: replay is deterministic and non-qualifying proposals stay unstamped", () => {
  // A peer-proposed (non-qualifying) write item carries no stamp keys, so a
  // pre-cure log of such items replays byte-identically post-cure. (An
  // owner/holder-proposed pre-cure item gains the stamp on replay under the
  // cured reducer — the cure reaching an already-trapped item on rebuild;
  // disclosed in the PR body against pack §7.7's parenthetical.)
  const f = fixture();
  f.propose("peer", "parity-write");
  f.propose("owner", "parity-stamped");
  // Determinism: an independently built fixture applying the same events
  // from genesis (replay(initialRoom()) inside fixture()) lands identical
  // apart from wall-clock timestamps, which the event factory stamps fresh.
  const stripTimes = items => JSON.stringify(items, (key, value) =>
    key === "createdAt" || key === "updatedAt" ? "<t>" : value);
  const first = stripTimes(f.state().workItems);
  const g = fixture();
  g.propose("peer", "parity-write");
  g.propose("owner", "parity-stamped");
  assert.equal(stripTimes(g.state().workItems), first);
  assert.equal(Object.hasOwn(f.item("parity-write"), "externalWriteGrantBy"), false);
  assert.equal(Object.hasOwn(f.item("parity-write"), "externalWriteGrantFor"), false);
});
