// T-1 (OPP-003 / #3224 burn-down): prototype-named ids must never qualify as
// members on the migrated gates. A plain-object members map inherits
// Object.prototype, so raw members["toString"] / members["constructor"] /
// members["valueOf"] resolve to inherited functions instead of missing.
// Every gate below resolved its member through that raw indexing before the
// sweep; each test pins the fail-closed behaviour through ownMember, and
// pins that a REAL own member whose id is a prototype name still resolves.
import test from "node:test";
import assert from "node:assert/strict";
import { ownMember } from "../src/events.js";
import { railActor } from "../server/trial-task-store.mjs";
import { PublicWorkClaims } from "../server/public-work-claims.mjs";
import { fleetScope } from "../server/agent-fleet.mjs";
import { squadMentionTargets } from "../server/squads.mjs";
import { resolveCatalogAgent } from "../server/capability-visibility.mjs";
import { Referrals } from "../server/referrals.mjs";
import { createMemberDisplayNames } from "../src/member-display-names.js";
import { planOutsideAgentRecord } from "../src/outside-agents.mjs";

const PROTOTYPE_IDS = ["toString", "valueOf", "constructor", "hasOwnProperty"];

test("ownMember: prototype names miss, own prototype-named members resolve", () => {
  for (const id of PROTOTYPE_IDS) assert.equal(ownMember({}, id), undefined);
  assert.equal(ownMember(null, "toString"), undefined);
  assert.equal(ownMember(undefined, "constructor"), undefined);
  const tess = { id: "toString", active: true };
  assert.equal(ownMember({ toString: tess }, "toString"), tess);
});

test("railActor (trial-task-store): prototype ids are not active members", () => {
  const store = { room: () => ({ state: { members: {}, room: { ownerId: "owner" } } }) };
  for (const id of PROTOTYPE_IDS) {
    assert.throws(() => railActor(store, "commons", id), err => err.code === "access_denied", id);
  }
  const withMember = { room: () => ({ state: { members: { worker: { id: "worker", active: true, kind: "human" } }, room: { ownerId: "owner" } } }) };
  assert.ok(railActor(withMember, "commons", "worker"));
  const inactive = { room: () => ({ state: { members: { worker: { id: "worker", active: false, kind: "human" } }, room: { ownerId: "owner" } } }) };
  assert.throws(() => railActor(inactive, "commons", "worker"), err => err.code === "access_denied");
});

test("_requireReceiptVisible (public-work-claims): prototype ids do not open a private room's receipts", () => {
  const claims = new PublicWorkClaims({
    db: {},
    roomDirectory: { publicReceiptsVisible: () => false },
    roomAuthority: () => ({ members: {} }),
  });
  for (const id of PROTOTYPE_IDS) {
    assert.throws(() => claims._requireReceiptVisible("r1", id), err => err.code === "receipts_private", id);
  }
  const withMember = new PublicWorkClaims({
    db: {},
    roomDirectory: { publicReceiptsVisible: () => false },
    roomAuthority: () => ({ members: { maya: { id: "maya", active: true } } }),
  });
  assert.equal(withMember._requireReceiptVisible("r1", "maya"), undefined);
});

test("fleetScope (agent-fleet): a prototype-named viewer gets no fleet scope", () => {
  // Even when the viewer id string equals the owner id, there is no member
  // record to stand on — the phantom record came from Object.prototype.
  const state = { members: {}, room: { ownerId: "toString" } };
  for (const id of PROTOTYPE_IDS) assert.equal(fleetScope(state, id), null, id);
  const owned = { members: { toString: { id: "toString", active: true, kind: "human" } }, room: { ownerId: "toString" } };
  assert.deepEqual(fleetScope(owned, "toString"), { all: true });
});

test("squadMentionTargets (squads): prototype ids in a squad roster do not fan out", () => {
  const db = { prepare: () => ({ all: () => [{ name: "alpha", members_json: JSON.stringify(["toString", "constructor", "real1"]) }] }) };
  const members = { real1: { id: "real1", active: true } };
  assert.deepEqual(squadMentionTargets(db, "r1", "hi @squad/alpha", "sender1", members), ["real1"]);
});

test("resolveCatalogAgent (capability-visibility): a prototype-named link member is skipped", () => {
  const store = {
    db: { prepare: () => ({ all: () => [{ roomId: "r1", memberId: "toString" }], get: () => undefined }) },
    room: () => ({ state: { members: {}, room: { ownerId: "owner" } } }),
  };
  const agent = resolveCatalogAgent(store, { identityId: "ai_test" });
  assert.deepEqual(agent.memberships, []);
});

test("Referrals.record: a prototype-named referrer is not an active member", () => {
  const referrals = new Referrals({
    db: { prepare: () => { throw new Error("db must not be reached for a phantom referrer"); } },
    room: () => ({ state: { members: {}, room: {} } }),
    now: () => 0,
  });
  for (const id of ["toString", "constructor"]) {
    assert.throws(
      () => referrals.record({ roomId: "r1", referrerMemberId: id, refereeMemberId: "real1", via: "invite", at: 1 }),
      err => err.code === "invalid_referral" && /referrer is not an active member/.test(err.message),
      id,
    );
  }
});

test("createMemberDisplayNames: prototype ids are unknown members, own ones resolve", () => {
  const resolve = createMemberDisplayNames({});
  for (const id of PROTOTYPE_IDS) assert.equal(resolve(id), `Unknown member (${id})`, id);
  const withTess = createMemberDisplayNames({ toString: { id: "toString", displayName: "Tess" } });
  assert.equal(withTess("toString"), "Tess");
});

test("planOutsideAgentRecord: a prototype-named handle is not 'already a member'", () => {
  // "constructor" is the prototype name that fits the lowercase handle pattern.
  const plan = planOutsideAgentRecord([], {}, "r1", "actor1", { externalRef: "constructor", displayName: "Stringy", origin: "mcp", reach: null, note: null });
  assert.equal(plan.recorded, "introduce");
  assert.throws(
    () => planOutsideAgentRecord([], { constructor: { id: "constructor", active: true } }, "r1", "actor1", { externalRef: "constructor", displayName: "Stringy", origin: "mcp", reach: null, note: null }),
    err => err.code === "invalid_outside_agent",
  );
});
