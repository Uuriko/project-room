// Issue #996: admin-class routes held by non-owner agents skip the
// t1_readonly gate — a demoted agent with invite_member/manage_members
// grants could still mint invites (and decide access / create share links).
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
  const directory = mkdtempSync(join(tmpdir(), "admin-tier-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.parse("2026-09-26T12:00:00Z") });
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "agent", displayName: "Delegated agent", kind: "agent", permissions: ["invite_member", "manage_members", "accept_work"], accountableHumanId: "owner" });
  keys.agent = store.issueAccessKey("commons", "agent");
  const demote = memberId => demoteToReadonly(store.db, "commons", memberId, { updatedBy: "owner", nowMs: Date.now() });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, keys, demote };
}

const capture = fn => { try { fn(); } catch (error) { return error; } throw new Error("expected the function to throw"); };

test("t2_standard agent with invite grant can mint invites", t => {
  const f = setup(t);
  const invite = f.store.invites.create(f.keys.agent, "commons", { permissions: ["accept_work"], displayName: "Peer" }, null);
  assert.ok(invite, "granted t2 agent should create invites");
});

test("t1_readonly agent with invite grant cannot mint invites", t => {
  const f = setup(t);
  f.demote("agent");
  const refused = capture(() => f.store.invites.create(f.keys.agent, "commons", { permissions: ["accept_work"], displayName: "Peer" }, null));
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "agent_readonly");
});

test("owner is exempt from the tier gate on invites", t => {
  const f = setup(t);
  const invite = f.store.invites.create(f.keys.owner, "commons", { permissions: ["accept_work"], displayName: "Peer" }, null);
  assert.ok(invite, "owner should always create invites");
});

// The access-request decide gate shipped without its import in #1092, so every
// decide (owner included) threw ReferenceError. Guard both halves here.
test("t1_readonly delegate cannot decide access requests; owner still can", async t => {
  const { AccessRequests, accessRequestSchema } = await import("../server/access-requests.mjs");
  const { createRateLimiter } = await import("../server/identity-ratelimit.mjs");
  const f = setup(t);
  f.store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(f.store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  const ask = name => {
    const identity = f.store.identities.create(name);
    return requests.request("commons", { identityId: identity.identityId, displayName: name, requestedPermissions: ["accept_work"], requestId: `ar_${name}` });
  };
  const first = ask("first"), second = ask("second");
  f.demote("agent");
  const refused = capture(() => requests.decide(f.keys.agent, "commons", first.requestId, { decision: "deny" }));
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "agent_readonly");
  const decided = requests.decide(f.keys.owner, "commons", second.requestId, { decision: "deny" });
  assert.equal(decided.status, "denied");
});

test("t1_readonly agent with manage_members grant cannot revoke invites; owner still can", t => {
  const f = setup(t);
  const first = f.store.invites.create(f.keys.owner, "commons", { permissions: ["accept_work"], displayName: "Peer1" }, null);
  const second = f.store.invites.create(f.keys.owner, "commons", { permissions: ["accept_work"], displayName: "Peer2" }, null);
  f.demote("agent");
  const refused = capture(() => f.store.invites.revoke(f.keys.agent, "commons", first.inviteId));
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "agent_readonly");
  const revoked = f.store.invites.revoke(f.keys.owner, "commons", second.inviteId);
  assert.equal(revoked.revoked, true);
});
