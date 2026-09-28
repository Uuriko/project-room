// Owner-delegation grants: persisted, owner-granted, owner-revocable,
// room-scoped authority for agent identities (server/owner-delegates.mjs).
//
// The design under test: the owner grants an agent identity (already linked
// as an active room member) the right to act with the owner's authority on
// the routes that name the delegate flag explicitly. The grant binds to the
// identity, resolves only while the link is active, is strictly top-down
// (the holder can never grant), and revocation takes effect on the next
// request. Ownership transfer, credential custody, and spend stay strictly
// owner-only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { GUEST_AGENT_TOKEN_PREFIX } from "../server/guest-agent-links.mjs";

const guestToken = () => GUEST_AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-owner-delegates-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  const origin = await new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(async () => {
    server.closeStreams?.(); server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const request = async (path, { method = "GET", token = null, data } = {}) => fetch(`${origin}${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { store, origin, request, ownerKey };
}

// The would-be delegate: a real agent identity linked into the room as an
// active member — the grant binds to the identity, never to a bare secret.
function makeLinkedAgent(store, ownerKey, name = "Delegate Agent") {
  const agent = store.identities.create(name);
  const linked = store.identities.link(ownerKey, "commons", {
    identityId: agent.identityId, displayName: name,
    permissions: ["accept_work", "complete_work", "steer", "verify"]
  });
  setTier(store.db, "commons", linked.memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  return { ...agent, memberId: linked.memberId };
}

function ownerRevision(store) {
  const authority = store.roomAuthority("commons");
  return authority.members[authority.ownerId].revision;
}

function mintBody(store, extras = {}) {
  return { requestId: randomUUID(), guestLabel: "Synapse visit", expectedOwnerRevision: ownerRevision(store), ...extras };
}

function grant(ctx, identityId) {
  return ctx.request("/api/rooms/commons/owner-delegates/grant", {
    method: "POST", token: ctx.ownerKey, data: { identityId }
  });
}

// Behavior: the owner-only grant API creates a persisted per-room grant for
// a linked agent identity.
// Regression: grant endpoint not wired (or the old hard-coded trust root
// removed without the persisted path) — the delegated mint below would 403.
test("owner grants a linked agent identity via HTTP", async t => {
  const ctx = await serve(t);
  const { store } = ctx;
  const agent = makeLinkedAgent(store, ctx.ownerKey);
  const res = await grant(ctx, agent.identityId);
  if (res.status !== 200) assert.fail(`grant rejected: ${await res.text()}`);
  const body = await res.json();
  assert.equal(body.identityId, agent.identityId);
  assert.equal(body.roomId, "commons");
  assert.ok(body.grantedBy, "grant names the granting owner");
  const row = store.db.prepare("SELECT * FROM owner_delegate_grants WHERE room_id=? AND identity_id=?")
    .get("commons", agent.identityId);
  assert.ok(row, "grant persisted");
  assert.equal(row.revoked_at, null);
});

// Behavior: grant is strictly owner-only.
// Regression: a weakened grant check would let any member mint themselves
// owner authority — privilege escalation.
test("a non-owner member cannot grant", async t => {
  const ctx = await serve(t);
  const { store } = ctx;
  const agent = makeLinkedAgent(store, ctx.ownerKey);
  const other = makeLinkedAgent(store, ctx.ownerKey, "Other Agent");
  const res = await ctx.request("/api/rooms/commons/owner-delegates/grant", {
    method: "POST", token: other.secret, data: { identityId: agent.identityId }
  });
  assert.equal(res.status, 403, "non-owner grant must be refused");
  const row = store.db.prepare("SELECT * FROM owner_delegate_grants WHERE room_id=? AND identity_id=?")
    .get("commons", agent.identityId);
  assert.equal(row, undefined, "no grant row written");
});

// Behavior: grants resolve only for identities linked into the room as
// active agent members.
// Regression: the pre-rewrite global design resolved delegates who were
// never room members; this pins the active-link requirement at the API.
test("grant requires an actively linked agent identity in this room", async t => {
  const ctx = await serve(t);
  const { store } = ctx;
  // Unknown identity: 404.
  const unknown = await grant(ctx, "ai_unknown");
  assert.equal(unknown.status, 404);
  // Identity exists but is NOT linked into the room: 404.
  const unlinked = store.identities.create("Unlinked");
  const res = await grant(ctx, unlinked.identityId);
  assert.equal(res.status, 404, "unlinked identity must not receive a grant");
  // A human member id is not an agent identity: link an identity row to the
  // human owner member directly and confirm the grant is refused (422).
  const humanLinked = store.identities.create("Human Linked");
  store.db.prepare("INSERT INTO identity_links(room_id, identity_id, member_id, linked_at) VALUES(?,?,?,?)")
    .run("commons", humanLinked.identityId, "owner", Date.now());
  const human = await grant(ctx, humanLinked.identityId);
  assert.equal(human.status, 422, "grant to a non-agent member refused");
  // The already_owner 409 sits behind the agent-kind check: the owner member
  // is always kind human, so a self-grant can never reach it. Kept as
  // defense-in-depth in the module; not reachable through this fixture.
});

// Behavior: a double grant is rejected; a re-grant after revocation works.
// Regression: duplicate rows would break the single-active-grant invariant
// the revoke path relies on.
test("double grant is 409; re-grant after revoke works", async t => {
  const ctx = await serve(t);
  const { store } = ctx;
  const agent = makeLinkedAgent(store, ctx.ownerKey);
  assert.equal((await grant(ctx, agent.identityId)).status, 200);
  const again = await grant(ctx, agent.identityId);
  assert.equal(again.status, 409, "active grant cannot be granted twice");
  const revoked = await ctx.request("/api/rooms/commons/owner-delegates/revoke", {
    method: "POST", token: ctx.ownerKey, data: { identityId: agent.identityId }
  });
  assert.equal(revoked.status, 200);
  const regrant = await grant(ctx, agent.identityId);
  assert.equal(regrant.status, 200, "re-grant after revoke works");
});

// Behavior: grants are strictly top-down — the holder can never grant.
// Regression: the delegate flag leaking into the grant gate would allow
// self-escalation chains.
test("a delegate cannot grant anyone else", async t => {
  const ctx = await serve(t);
  const { store } = ctx;
  const agent = makeLinkedAgent(store, ctx.ownerKey);
  const other = makeLinkedAgent(store, ctx.ownerKey, "Other Agent");
  assert.equal((await grant(ctx, agent.identityId)).status, 200);
  const res = await ctx.request("/api/rooms/commons/owner-delegates/grant", {
    method: "POST", token: agent.secret, data: { identityId: other.identityId }
  });
  assert.equal(res.status, 403, "delegate grant attempt refused");
});

// Behavior: the owner-only list shows active grants and hides revoked ones.
// Regression: a list that leaked to members would disclose the delegation
// structure to the room.
test("list shows active grants, excludes revoked; non-owner list is 403", async t => {
  const ctx = await serve(t);
  const { store } = ctx;
  const agent = makeLinkedAgent(store, ctx.ownerKey);
  const other = makeLinkedAgent(store, ctx.ownerKey, "Other Agent");
  assert.equal((await grant(ctx, agent.identityId)).status, 200);
  assert.equal((await grant(ctx, other.identityId)).status, 200);
  await ctx.request("/api/rooms/commons/owner-delegates/revoke", {
    method: "POST", token: ctx.ownerKey, data: { identityId: other.identityId }
  });
  const res = await ctx.request("/api/rooms/commons/owner-delegates", { token: ctx.ownerKey });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.grants.map(g => g.identityId), [agent.identityId], "only the active grant listed");
  const denied = await ctx.request("/api/rooms/commons/owner-delegates", { token: agent.secret });
  assert.equal(denied.status, 403, "member list refused");
});

// Behavior: the journal records grant and revoke with the owner as actor.
// Regression: a journal that isn't appended would break the audit trail
// for delegated authority.
test("journal records grant and revoke with the owner as actor", async t => {
  const ctx = await serve(t);
  const { store } = ctx;
  const agent = makeLinkedAgent(store, ctx.ownerKey);
  await grant(ctx, agent.identityId);
  await ctx.request("/api/rooms/commons/owner-delegates/revoke", {
    method: "POST", token: ctx.ownerKey, data: { identityId: agent.identityId }
  });
  const rows = store.ownerDelegates.journal(ctx.ownerKey, "commons", null);
  const actions = rows.map(r => r.action);
  assert.deepEqual(actions, ["revoke", "grant"], "revoke then grant journaled, newest first");
  assert.ok(rows.every(r => r.actorId === "owner"), "owner is the journaled actor");
  assert.ok(rows.every(r => r.identityId === agent.identityId));
});

// Behavior: a granted delegate mints a guest invite at the real HTTP
// boundary, and the journal credits the delegate — not the owner.
// Regression: the pre-rewrite design journaled delegated mints under the
// owner id, hiding the real actor.
test("delegate mints a guest invite; journal credits the delegate", async t => {
  const ctx = await serve(t);
  const { store } = ctx;
  const agent = makeLinkedAgent(store, ctx.ownerKey);
  await grant(ctx, agent.identityId);
  const res = await ctx.request("/api/rooms/commons/guest-invites", {
    method: "POST", token: agent.secret, data: mintBody(store)
  });
  if (res.status !== 201) assert.fail(`delegate mint rejected: ${await res.text()}`);
  const row = store.db.prepare("SELECT minted_by_member_id, minted_by_account_id FROM guest_invites WHERE room_id=?")
    .get("commons");
  assert.equal(row.minted_by_member_id, agent.memberId, "journal credits the delegate's member");
  assert.equal(row.minted_by_account_id, null, "delegate mint is accountless");
});

// Behavior: an agent without a grant is still denied the delegated action.
// Regression: the grant check being skipped would open delegated routes to
// every linked member.
test("an ungranted linked agent cannot mint", async t => {
  const ctx = await serve(t);
  const { store } = ctx;
  const other = makeLinkedAgent(store, ctx.ownerKey, "Other Agent");
  const res = await ctx.request("/api/rooms/commons/guest-invites", {
    method: "POST", token: other.secret, data: mintBody(store)
  });
  assert.equal(res.status, 403, "ungranted agent must not mint");
});

// Behavior: revocation takes effect on the next request.
// Regression: a grant check that cached the grant (or ignored revoked_at)
// would let a revoked delegate keep acting.
test("revocation ends delegated authority on the next request", async t => {
  const ctx = await serve(t);
  const { store } = ctx;
  const agent = makeLinkedAgent(store, ctx.ownerKey);
  await grant(ctx, agent.identityId);
  const before = await ctx.request("/api/rooms/commons/guest-invites", {
    method: "POST", token: agent.secret, data: mintBody(store)
  });
  assert.equal(before.status, 201, "delegate mints while granted");
  assert.equal((await ctx.request("/api/rooms/commons/access-review", { token: agent.secret })).status, 200,
    "delegate reads the access review while granted");
  const revoked = await ctx.request("/api/rooms/commons/owner-delegates/revoke", {
    method: "POST", token: ctx.ownerKey, data: { identityId: agent.identityId }
  });
  assert.equal(revoked.status, 200);
  const after = await ctx.request("/api/rooms/commons/guest-invites", {
    method: "POST", token: agent.secret, data: mintBody(store)
  });
  assert.equal(after.status, 403, "revoked delegate must be denied immediately");
  assert.equal((await ctx.request("/api/rooms/commons/access-review", { token: agent.secret })).status, 403,
    "revoked delegate loses the delegated read too — but keeps their own member access");
});

// Behavior: the delegated mint pins the OWNER's member revision.
// Regression: comparing the minter's own revision (the pre-rewrite
// exemption) would let a stale delegate mint after the owner's permissions
// changed.
test("delegated mint honors the owner's revision freshness check", async t => {
  const ctx = await serve(t);
  const { store } = ctx;
  const agent = makeLinkedAgent(store, ctx.ownerKey);
  await grant(ctx, agent.identityId);
  const stale = await ctx.request("/api/rooms/commons/guest-invites", {
    method: "POST", token: agent.secret, data: mintBody(store, { expectedOwnerRevision: ownerRevision(store) + 99 })
  });
  assert.equal(stale.status, 409, "stale owner revision rejected for the delegate too");
  const fresh = await ctx.request("/api/rooms/commons/guest-invites", {
    method: "POST", token: agent.secret, data: mintBody(store)
  });
  assert.equal(fresh.status, 201);
});

// Behavior: the grant resolves only while the identity links to an active
// member — deactivating the member ends delegated authority.
// Regression: the grant check ignoring link activity would let a removed
// member keep owner authority through their identity secret.
test("deactivating the delegate's member link ends delegated authority", async t => {
  const ctx = await serve(t);
  const { store } = ctx;
  const agent = makeLinkedAgent(store, ctx.ownerKey);
  await grant(ctx, agent.identityId);
  const leave = await ctx.request(`/api/rooms/commons/members/${agent.memberId}`, {
    method: "DELETE", token: agent.secret
  });
  assert.equal(leave.status, 200, "self-deactivation works");
  const res = await ctx.request("/api/rooms/commons/guest-invites", {
    method: "POST", token: agent.secret, data: mintBody(store)
  });
  assert.equal(res.status, 401, "inactive link no longer resolves the grant");
});

// Behavior: grants are room-scoped.
// Regression: the pre-rewrite global design resolved a delegate in every
// room; this pins the per-room predicate.
test("grant is room-scoped", async t => {
  const ctx = await serve(t);
  const { store } = ctx;
  const agent = makeLinkedAgent(store, ctx.ownerKey);
  await grant(ctx, agent.identityId);
  assert.ok(store.ownerDelegates.hasGrant("commons", agent.identityId), "grant resolves in its room");
  assert.equal(store.ownerDelegates.hasGrant("other-room", agent.identityId), false, "grant never leaks across rooms");
});

// Behavior: ownership transfer stays strictly owner-only.
// Regression: the delegate flag leaking into the transfer path would hand
// the room itself to a delegate.
test("delegate cannot transfer room ownership", async t => {
  const ctx = await serve(t);
  const { store } = ctx;
  const agent = makeLinkedAgent(store, ctx.ownerKey);
  await grant(ctx, agent.identityId);
  const before = store.room("commons").state.room.ownerId;
  const res = await ctx.request("/api/rooms/commons/ownership/transfer", {
    method: "POST", token: agent.secret, data: { toMemberId: agent.memberId }
  });
  assert.equal(res.status, 403, "delegate transfer refused");
  assert.equal(store.room("commons").state.room.ownerId, before, "owner unchanged");
});

// Behavior: the delegate's mechanical expiry sweep attributes to the owner
// (the event model requires a manage_members actor) and records the real
// actor plus the delegation source in the event data.
// Regression: attributing the sweep to the delegate member would fail the
// reducer (no manage_members); dropping the provenance would hide who swept.
test("delegate expiry sweep attributes to the owner with delegation provenance", async t => {
  const ctx = await serve(t);
  const { store } = ctx;
  const agent = makeLinkedAgent(store, ctx.ownerKey);
  await grant(ctx, agent.identityId);
  // A real guest member: the owner mints a guest-agent link.
  const linkToken = guestToken();
  const minted = await ctx.request("/api/rooms/commons/guest-agent-links", {
    method: "POST", token: ctx.ownerKey,
    data: { requestId: randomUUID(), linkToken, expectedOwnerRevision: ownerRevision(store) }
  });
  if (minted.status !== 201) assert.fail(`guest link mint rejected: ${await minted.text()}`);
  const guestMemberId = (await minted.json()).member.id;
  // Expire the guest credential directly.
  store.db.prepare("UPDATE credentials SET expires_at=0 WHERE room_id=? AND member_id=?")
    .run("commons", guestMemberId);
  // The delegate runs the mechanical sweep on their own secret.
  store.guestAgentLinks.sweepExpired(agent.secret, "commons", null);
  assert.equal(store.room("commons").state.members[guestMemberId].active, false, "guest member swept");
  const events = store.db.prepare("SELECT body FROM events WHERE room_id=?").all("commons")
    .map(r => JSON.parse(r.body))
    .filter(e => e.type === "member.access_changed" && e.data.memberId === guestMemberId);
  assert.ok(events.length >= 1, "sweep event journaled");
  const sweep = events[events.length - 1];
  assert.equal(sweep.actorId, "owner", "sweep attributed to the owner");
  assert.equal(sweep.data.delegatedSweepByMemberId, agent.memberId, "sweep names the delegate's member");
  assert.equal(sweep.data.delegatedSweepByIdentityId, agent.identityId, "sweep names the delegate's identity");
  assert.equal(sweep.data.delegatedSweepGrantedBy, "owner", "sweep names the delegating owner");
});
