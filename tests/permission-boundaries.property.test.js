// Property tests for the pure permission predicates in src/events.js.
//
// Properties (fast-check, generated rooms of humans and agents):
//   P1 canInviteMembers: an inactive or unknown member never invites; the
//      owner always does while active; any other member invites iff it holds
//      manage_members or invite_member. Prototype keys never resolve.
//   P2 isCrossOwnerAgentAction is symmetric and irreflexive, never true for
//      two humans, never true for an inactive or unknown side, and true only
//      when both sides resolve to different accountable owners.
//   P3 memberOwnerId: a human is its own owner, an agent resolves to its
//      accountableHumanId or the room owner.
//   P4 NEVER_GRANT includes every AGENT_ADMIN_PERMISSIONS entry.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  canInviteMembers, isCrossOwnerAgentAction, memberOwnerId, NEVER_GRANT, AGENT_ADMIN_PERMISSIONS
} from "../src/events.js";

const PERMS = ["post", "claim_work", "manage_members", "invite_member", "decide", "read"];
const ids = ["h1", "h2", "h3", "a1", "a2", "a3"];

const memberArb = id => fc.record({
  active: fc.boolean(),
  permissions: fc.subarray(PERMS),
  accountableHumanId: id.startsWith("a") ? fc.option(fc.constantFrom("h1", "h2", "h3"), { nil: undefined }) : fc.constant(undefined),
}).map(m => ({ id, kind: id.startsWith("h") ? "human" : "agent", ...m }));

const stateArb = fc.tuple(fc.subarray(ids, { minLength: 1 }), fc.constantFrom("h1", "h2", "h3"))
  .chain(([present, ownerId]) => fc.tuple(...present.map(memberArb)).map(list => ({
    room: { id: "r", ownerId },
    members: Object.fromEntries(list.map(m => [m.id, m])),
  })));

const anyId = fc.constantFrom(...ids, "nobody", "__proto__", "constructor", "toString");
const own = (state, id) => (Object.hasOwn(state.members, id) ? state.members[id] : null);

test("P1 canInviteMembers follows owner, active and permission rules", () => {
  fc.assert(fc.property(stateArb, anyId, (state, id) => {
    const member = own(state, id);
    const got = canInviteMembers(state, id);
    if (!member || member.active === false) return got === false;
    if (id === state.room.ownerId) return got === true;
    return got === (member.permissions.includes("manage_members") || member.permissions.includes("invite_member"));
  }), { numRuns: 500 });
});

test("P2 cross-owner agent gate is symmetric, irreflexive and owner-based", () => {
  fc.assert(fc.property(stateArb, anyId, anyId, (state, a, b) => {
    const ab = isCrossOwnerAgentAction(state, a, b);
    assert.equal(ab, isCrossOwnerAgentAction(state, b, a));
    assert.equal(isCrossOwnerAgentAction(state, a, a), false);
    const A = own(state, a), B = own(state, b);
    if (a === b || !A || !B || A.active === false || B.active === false) assert.equal(ab, false);
    else if (A.kind === "human" && B.kind === "human") assert.equal(ab, false);
    else assert.equal(ab, memberOwnerId(state, a) !== memberOwnerId(state, b));
  }), { numRuns: 500 });
});

test("P3 owner resolution: humans own themselves, agents resolve to a sponsor", () => {
  fc.assert(fc.property(stateArb, state => {
    for (const m of Object.values(state.members)) {
      const owner = memberOwnerId(state, m.id);
      if (m.kind === "human") assert.equal(owner, m.id);
      else assert.equal(owner, m.accountableHumanId || state.room.ownerId);
    }
  }), { numRuns: 300 });
});

test("P4 agent admin permissions are never grantable through a door", () => {
  for (const p of AGENT_ADMIN_PERMISSIONS) assert.ok(NEVER_GRANT.includes(p), p);
});
