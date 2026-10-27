// Authority-read catalog resolution (SPEED-PLAN rank 2): resolveCatalogAgent
// must read each membership's member record + room owner through
// store.roomAuthority() (a prefix json_extract over the stored projection)
// instead of materialising the full room state via store.room() once per
// membership on every authenticated tools/list and call-denial check.
//
// Proving bars pinned here:
//  1. The agent descriptor — and therefore the listed catalog, byte for
//     byte — is identical to the descriptor the full-state load built.
//  2. store.room() is never called on the authority path, and a store
//     without roomAuthority() falls back to the full load unchanged.
//  3. On the production-shaped store (DurableDatabase over DO storage),
//     the per-request rowsRead counter grows strictly less for the
//     authority path than for the same resolution done with cold-cache
//     full-state loads — counted on the adapter's own counter
//     (cloudflare/storage.mjs DurableDatabase.rowsRead), not a surface.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { resolveCatalogAgent } from "../server/capability-visibility.mjs";
import { listedMcpTools } from "../server/mcp-discovery.mjs";
import { identityRoomSeats } from "../server/membership-resolution.mjs";
import { getTier, DEFAULT_AUTONOMY_TIER, demoteToReadonly } from "../server/autonomy-tiers.mjs";
import { resolveGrants } from "../server/grants.mjs";
import { isGuestAgentMemberId } from "../server/guest-agent-links.mjs";
import { DurableDatabase, durableStorage } from "../cloudflare/storage.mjs";
import { createDoContext } from "./helpers/do-storage-emulator.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { issueGrant, revokeGrant } from "../server/grants.mjs";

const ROOMS = ["room-a", "room-b", "room-c", "room-d", "room-e"];

// One identity linked into five rooms, each holding posted messages so the
// stored projection is a real multi-message blob, not an empty shell. The
// peer is demoted to t1_readonly in one room so tier diversity is part of
// the compared descriptor.
function seatPeer(store) {
  const peer = store.identities.create("Catalog Peer");
  for (const roomId of ROOMS) {
    store.initialize(initialRoom(roomId, "owner"));
    const ownerKey = store.issueAccessKey(roomId, "owner");
    store.identities.link(ownerKey, roomId, {
      identityId: peer.identityId, memberId: "peer", displayName: "Catalog Peer", permissions: [],
    });
    for (let i = 0; i < 20; i++) {
      store.command(ownerKey, roomId, {
        id: randomUUID(), type: "message.posted",
        data: { messageId: `${roomId}-m-${i}`, body: `projection weight for ${roomId} message ${i} `.repeat(4) },
      });
    }
  }
  demoteToReadonly(store.db, "room-a", "peer", { updatedBy: "owner", nowMs: Date.now() });
  return peer;
}

// The pre-change resolution, rebuilt here from full state loads so the
// byte-identical bar compares against the old algorithm, not against a
// hand-written expectation.
function resolveViaFullState(store, identity) {
  const memberships = [];
  const links = identityRoomSeats(store.db, identity.identityId);
  for (const { roomId, memberId } of links) {
    const state = store.room(roomId)?.state ?? null;
    const member = state?.members?.[memberId] ?? null;
    if (!member || member.active === false) continue;
    let tier = DEFAULT_AUTONOMY_TIER;
    try { tier = getTier(store.db, roomId, memberId)?.autonomyTier ?? DEFAULT_AUTONOMY_TIER; } catch { /* default */ }
    memberships.push({
      roomId, memberId,
      isGuest: isGuestAgentMemberId(memberId),
      autonomyTier: tier,
      isOwner: state?.room?.ownerId === memberId,
      active: true,
    });
  }
  const grants = new Set();
  const nowMs = Date.now();
  for (const m of memberships) {
    if (m.isGuest) continue;
    try { for (const edge of resolveGrants(store.db, m.roomId, m.memberId, nowMs)) grants.add(edge.capability); } catch { /* none */ }
  }
  return { kind: "agent", identityId: identity.identityId, memberships, grants: [...grants] };
}

function doFixture(t) {
  const ctx = createDoContext();
  const store = new RoomStore(null, { database: new DurableDatabase(ctx.storage), storagePlatform: durableStorage });
  store.initialize(initialRoom("commons"));
  const peer = seatPeer(store);
  t.after(() => { store.close(); ctx.storage.close(); });
  return { store, peer };
}

test("descriptor and catalog bytes are identical to the full-state resolution", t => {
  const { store, peer } = doFixture(t);
  const viaAuthority = resolveCatalogAgent(store, { identityId: peer.identityId });
  const viaFullState = resolveViaFullState(store, peer);
  assert.equal(viaAuthority.memberships.length, ROOMS.length, "every linked room resolves");
  assert.deepEqual(viaAuthority, viaFullState, "descriptor must not change shape or values");
  for (const profile of ["core", "full"]) {
    const a = JSON.stringify(listedMcpTools(profile, false, viaAuthority));
    const b = JSON.stringify(listedMcpTools(profile, false, viaFullState));
    assert.equal(a, b, `${profile}: catalog output must be byte-identical`);
  }
});

test("rowsRead grows strictly less on the authority path (DO adapter counter)", t => {
  const { store, peer } = doFixture(t);
  const db = store.db;
  store._projectionCache?.clear?.();
  const beforeFull = db.rowsRead;
  resolveViaFullState(store, peer);
  const fullDelta = db.rowsRead - beforeFull;
  store._projectionCache?.clear?.();
  const beforeAuthority = db.rowsRead;
  resolveCatalogAgent(store, { identityId: peer.identityId });
  const authorityDelta = db.rowsRead - beforeAuthority;
  assert.ok(authorityDelta < fullDelta,
    `authority path rowsRead (${authorityDelta}) must be below full-state path (${fullDelta})`);
  assert.ok(authorityDelta <= fullDelta - ROOMS.length,
    `expected at least one saved row read per membership: authority ${authorityDelta}, full ${fullDelta}`);
});

// --- Acceptance checks (Codex consultation, room seq 19775): the prefix
// read must preserve the existing checks IN FULL. Each check below is
// shown still biting under the authority read, and the descriptor the
// authority path builds stays identical to the full-state descriptor
// while the check is in force.

test("check 1 — inactive membership: a deactivated member is excluded exactly as at base", t => {
  const { store, peer } = doFixture(t);
  const ownerKey = store.issueAccessKey("room-b", "owner");
  const member = store.roomAuthority("room-b").members.peer;
  store.command(ownerKey, "room-b", {
    id: randomUUID(), type: "member.access_changed",
    data: { memberId: "peer", expectedMemberRevision: member.revision, permissions: [...(member.permissions ?? [])], active: false },
  });
  const viaAuthority = resolveCatalogAgent(store, { identityId: peer.identityId });
  const viaFullState = resolveViaFullState(store, peer);
  assert.ok(!viaAuthority.memberships.some(m => m.roomId === "room-b"),
    "the deactivated membership must be excluded from the catalog descriptor");
  assert.equal(viaAuthority.memberships.length, ROOMS.length - 1);
  assert.deepEqual(viaAuthority, viaFullState, "exclusion must match the full-state resolution exactly");
  assert.equal(
    JSON.stringify(listedMcpTools("full", false, viaAuthority)),
    JSON.stringify(listedMcpTools("full", false, viaFullState)),
    "catalog bytes stay identical while the inactive check bites");
});

test("check 2 — history/access policy: the prefix carries the policy in full and the floor still bites", t => {
  const { store, peer } = doFixture(t);
  // A room the peer joins only after history is restricted to since_join,
  // with a message already posted before the join.
  store.initialize(initialRoom("room-hist", "owner"));
  const ownerKey = store.issueAccessKey("room-hist", "owner");
  store.command(ownerKey, "room-hist", {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "room-hist-pre", body: "posted before the peer joined" },
  });
  store.command(ownerKey, "room-hist", {
    id: randomUUID(), type: "room.history_visibility_set",
    data: { historyVisibility: "since_join" },
  });
  store.identities.link(ownerKey, "room-hist", {
    identityId: peer.identityId, memberId: "peer", displayName: "Catalog Peer", permissions: [],
  });
  // The policy fields the prefix extracts are the stored policy, in full:
  // identical to what the full-state load reports for the same room.
  const authority = store.roomAuthority("room-hist", { includeHistory: true });
  const fullState = store.room("room-hist").state;
  // The stored prefix carries the policy object ({ value, revision, … });
  // the hydrated state normalizes it to the bare string. Both shapes are
  // the stored policy — readHistoryFloor accepts either — so compare the
  // effective value, and pin that the prefix object is present in full.
  const policyValue = v => (typeof v === "string" ? v : v?.value);
  assert.equal(policyValue(authority.historyVisibility), "since_join");
  assert.equal(policyValue(authority.historyVisibility), policyValue(fullState.room.historyVisibility));
  assert.equal(typeof authority.historyVisibility, "object",
    "prefix carries the full policy object, not a truncated form");
  // historyDefaultsVersion: the prefix read nulls an absent version
  // (roomAuthority's `?? null`); the hydrated state leaves it undefined.
  // Both are the same fact — no defaults version is set.
  assert.equal(authority.historyDefaultsVersion ?? null, fullState.room.historyDefaultsVersion ?? null);
  assert.deepEqual(authority.members, fullState.members,
    "the prefix member records (the access-policy inputs) are the full stored records");
  // And the check the policy drives still bites: the peer's history floor
  // is their join point, not the room start — pre-join history stays shut.
  const floor = store.historyFloor("room-hist", "peer");
  assert.ok(floor && Number.isSafeInteger(floor.sequence),
    `since_join member must have a history floor, got ${JSON.stringify(floor)}`);
  const preJoin = store.room("room-hist");
  assert.ok(floor.sequence >= 2, "floor must sit at/after the pre-join message and the policy event");
  assert.ok(preJoin.sequence >= floor.sequence);
  // The catalog resolution under this policy state is unchanged vs base.
  const viaAuthority = resolveCatalogAgent(store, { identityId: peer.identityId });
  const viaFullState = resolveViaFullState(store, peer);
  assert.ok(viaAuthority.memberships.some(m => m.roomId === "room-hist"));
  assert.deepEqual(viaAuthority, viaFullState);
});

test("check 3 — revocation: a revoked identity is refused at the MCP door; a revoked grant drops out", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-catalog-revocation-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const peer = seatPeer(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  // Grant leg: a live edge appears in the descriptor; revoking it drops
  // it on the very next resolution, same as at base.
  issueGrant(store.db, "room-a", "peer", "grants:issue", { grantedBy: "owner", nowMs: Date.now() });
  assert.deepEqual(resolveCatalogAgent(store, { identityId: peer.identityId }).grants, ["grants:issue"]);
  revokeGrant(store.db, "room-a", "peer", "grants:issue", { nowMs: Date.now() });
  assert.deepEqual(resolveCatalogAgent(store, { identityId: peer.identityId }).grants, [],
    "a revoked grant edge must drop out of the authority-read descriptor");

  // Identity leg: the hosted MCP door serves the identity, then refuses
  // it with the base refusal shape once the credential is revoked.
  const mcp = createHostedRoomMcp(store);
  const rpc = (method, params) => ({ jsonrpc: "2.0", id: "rev", method, ...(params ? { params } : {}) });
  const served = await mcp(rpc("tools/list", {}), { authorization: `Bearer ${peer.secret}` });
  assert.ok(Array.isArray(served.result?.tools) && served.result.tools.length > 0,
    "identity is served before revocation");
  store.identities.revoke(peer.identityId, peer.secret);
  const refused = await mcp(rpc("tools/list", {}), { authorization: `Bearer ${peer.secret}` });
  assert.equal(refused.error?.code, -32001, "revoked identity gets the base MCP_AUTH_REQUIRED refusal");
  assert.match(refused.error?.message ?? "", /revoked identity credential/);
});

test("the authority path never calls store.room(); a store without roomAuthority falls back", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-catalog-authority-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const peer = seatPeer(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  let roomCalls = 0;
  const originalRoom = store.room.bind(store);
  store.room = (...args) => { roomCalls++; return originalRoom(...args); };
  const agent = resolveCatalogAgent(store, { identityId: peer.identityId });
  assert.equal(roomCalls, 0, "resolveCatalogAgent must not load full room state per membership");
  assert.equal(agent.memberships.length, ROOMS.length);
  store.room = originalRoom;

  // Fallback: shadow the prefix read away; the descriptor must be the same.
  const authority = store.roomAuthority;
  store.roomAuthority = undefined;
  const fallback = resolveCatalogAgent(store, { identityId: peer.identityId });
  store.roomAuthority = authority;
  assert.deepEqual(fallback, agent, "fallback descriptor must match the authority descriptor");
});
