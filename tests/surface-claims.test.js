// Surface claims (CLAIM-PRIM): the room-native Claim primitive from
// mig-primitives.md Primitive 1 — a room-scoped claim a member takes on a
// subject (PRs, issues, branch, repo surfaces, lane, the room itself, or
// free-named work), with server-enforced expiry driven by the holder's
// heartbeat presence. Distinct from work claims (board work-item leases):
// a surface claim coordinates who is working on what, fleet-wide.
//
// Specimens guard the charter's three behaviours:
//   1. a second claim on a held subject returns the current holder (409
//      surface_claim_held carrying the held claim), never a silent success;
//   2. expiry fires when the holder's presence stops (no heartbeat/activity
//      past the grace window) even inside the nominal window, and a live
//      holder's activity renews the presence leg;
//   3. release frees the subject for another member.
// Tests drive the public HTTP, MCP, and store boundaries only.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { ROUTES } from "../server/routes/table.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { DatabaseSync } from "node:sqlite";
import {
  CLAIM_PRESENCE_GRACE_MS, DEFAULT_CLAIM_WINDOW_MINUTES, MAX_CLAIM_WINDOW_MINUTES,
  scopesIntersect
} from "../server/surface-claims.mjs";
import { createDurableSurfaceClaimRegistry, surfaceClaimSchema } from "../server/surface-claim-sqlite.mjs";
import { takeSurfaceClaimRoute } from "../server/routes/surface-claims.mjs";

const MIN = 60_000;

// --- module units ---------------------------------------------------------------

test("registry round-trips an envelope row on a bare database", () => {
  // Direct module coverage for server/surface-claim-sqlite.mjs,
  // server/surface-claims.mjs and server/routes/surface-claims.mjs (the
  // HTTP specimens below exercise them end to end).
  assert.equal(typeof takeSurfaceClaimRoute, "function");
  assert.equal(CLAIM_PRESENCE_GRACE_MS, 15 * 60_000);
  assert.equal(DEFAULT_CLAIM_WINDOW_MINUTES, 90);
  assert.equal(MAX_CLAIM_WINDOW_MINUTES, 1440);
  assert.equal(scopesIntersect({ surfaces: ["server/**"] }, { surfaces: ["server/store.mjs"] }), true);
  assert.equal(scopesIntersect({ surfaces: ["server/**"] }, { surfaces: ["web/**"] }), false);
  const db = new DatabaseSync(":memory:");
  db.exec(surfaceClaimSchema);
  const registry = createDurableSurfaceClaimRegistry(db);
  assert.equal(registry.get("room-a", "sc_x"), null);
  registry.set("room-a", { id: "sc_x", holderMemberId: "m1", scope: { prs: [1] }, state: "active" });
  assert.equal(registry.get("room-a", "sc_x").scope.prs[0], 1);
  assert.equal(registry.list("room-a").length, 1);
  assert.equal(registry.list("room-b").length, 0);
  db.close();
});

// --- route table ---------------------------------------------------------------

test("route table registers the five surface-claim rows with MCP parity notes", () => {
  const rows = new Map(ROUTES.map(row => [`${row.method} ${row.path}`, row]));
  for (const [key, tool] of [
    ["POST /api/rooms/{roomId}/surface-claims", "room_claim_surface"],
    ["GET /api/rooms/{roomId}/surface-claims", "room_list_surface_claims"],
    ["GET /api/rooms/{roomId}/surface-claims/{claimId}", "room_list_surface_claims"],
    ["POST /api/rooms/{roomId}/surface-claims/{claimId}/release", "room_release_surface_claim"],
    ["POST /api/rooms/{roomId}/surface-claims/{claimId}/amend", "room_amend_surface_claim"],
  ]) {
    const row = rows.get(key);
    assert.ok(row, `${key} is a route-table row`);
    assert.equal(row.auth, "room");
    assert.equal(row.scope, "room");
    assert.equal(typeof row.handler, "function");
    assert.ok(String(row.parity).includes(tool), `${key} parity names ${tool}`);
  }
});

// --- fixtures ------------------------------------------------------------------

function storeFixture(t, startAt = Date.parse("2026-10-21T12:00:00Z")) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-surface-claims-"));
  let at = startAt;
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => at });
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const cmd = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data });
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "guest", displayName: "Guest", kind: "human", permissions: [] });
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "helper", displayName: "Helper", kind: "agent", permissions: ["accept_work"], accountableHumanId: "owner" });
  const guestKey = store.issueAccessKey("commons", "guest");
  const helperKey = store.issueAccessKey("commons", "helper");
  return {
    directory, store, ownerKey, guestKey, helperKey, cmd,
    now: () => at,
    advance: ms => { at += ms; },
    post: (token, body) => cmd(token, T.MESSAGE_POSTED, { messageId: randomUUID(), body }).event.data.messageId,
  };
}

async function serve(t) {
  const f = storeFixture(t);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, token, body, path) => {
    const res = await fetch(`${origin}${path}`, {
      method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const claims = (method, token, body, suffix = "") => call(method, token, body, `/api/rooms/commons/surface-claims${suffix}`);
  return { ...f, origin, claims };
}

// --- HTTP: take / conflict / release --------------------------------------------

test("http: take a claim; a second claim on the held subject returns the holder; release frees it", async t => {
  const f = await serve(t);
  assert.equal((await f.claims("POST", null, { scope: { prs: [101] } })).status, 401, "no credential, no claim");

  const taken = await f.claims("POST", f.ownerKey, { scope: { prs: [101] }, note: "landing train", windowMinutes: 90 });
  assert.equal(taken.status, 201, JSON.stringify(taken.json));
  const claim = taken.json.claim;
  assert.match(claim.id, /^sc_/);
  assert.equal(claim.state, "active");
  assert.equal(claim.holder.memberId, "owner");
  assert.deepEqual(claim.scope.prs, [101]);
  assert.equal(claim.note, "landing train");

  const conflict = await f.claims("POST", f.guestKey, { scope: { prs: [101] } });
  assert.equal(conflict.status, 409, "a held subject conflicts");
  assert.equal(conflict.json.error.code, "surface_claim_held");
  assert.equal(conflict.json.held.holder.memberId, "owner", "the conflict returns the current holder");
  assert.equal(conflict.json.held.id, claim.id);

  const other = await f.claims("POST", f.guestKey, { scope: { prs: [102] } });
  assert.equal(other.status, 201, "a different subject is free");

  const list = await f.claims("GET", f.guestKey);
  assert.equal(list.status, 200);
  assert.equal(list.json.claims.filter(c => c.state === "active").length, 2);

  assert.equal((await f.claims("POST", f.guestKey, { reason: "not mine" }, `/${claim.id}/release`)).status, 403,
    "a non-holder who is neither owner nor claim manager cannot release");
  const released = await f.claims("POST", f.ownerKey, { reason: "done" }, `/${claim.id}/release`);
  assert.equal(released.status, 200, JSON.stringify(released.json));
  assert.equal(released.json.claim.state, "released");
  assert.equal(released.json.claim.releaseReason, "done");

  const retaken = await f.claims("POST", f.guestKey, { scope: { prs: [101] } });
  assert.equal(retaken.status, 201, "release frees the subject");
});

// --- HTTP: scope grammar ----------------------------------------------------------

test("http: scope grammar — surfaces overlap conflicts, disjoint surfaces do not; empty scope refused", async t => {
  const f = await serve(t);
  const bad = await f.claims("POST", f.ownerKey, { scope: {} });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, "invalid_surface_claim");

  const taken = await f.claims("POST", f.ownerKey, { scope: { surfaces: ["server/**"] } });
  assert.equal(taken.status, 201, JSON.stringify(taken.json));
  const overlap = await f.claims("POST", f.guestKey, { scope: { surfaces: ["server/http.mjs"] } });
  assert.equal(overlap.status, 409, "a path inside a claimed subtree conflicts");
  assert.equal(overlap.json.held.holder.memberId, "owner");
  const disjoint = await f.claims("POST", f.guestKey, { scope: { surfaces: ["docs/**"] } });
  assert.equal(disjoint.status, 201, "a disjoint subtree is free");
});

// --- HTTP: amend + supersede --------------------------------------------------------

test("http: amend replaces scope in place with history; re-claiming own subject supersedes", async t => {
  const f = await serve(t);
  const taken = await f.claims("POST", f.ownerKey, { scope: { prs: [201] }, note: "first" });
  const claim = taken.json.claim;

  const amended = await f.claims("POST", f.ownerKey, { scope: { prs: [201, 202] }, note: "widened" }, `/${claim.id}/amend`);
  assert.equal(amended.status, 200, JSON.stringify(amended.json));
  assert.equal(amended.json.claim.id, claim.id, "amend is in place");
  assert.deepEqual(amended.json.claim.scope.prs, [201, 202]);
  assert.equal(amended.json.claim.note, "widened");
  assert.ok(amended.json.claim.history.some(h => h.action === "amended"), "the amendment is kept in history");
  assert.equal((await f.claims("POST", f.guestKey, { scope: { prs: [202] } })).status, 409,
    "the widened scope now conflicts for others");

  const again = await f.claims("POST", f.ownerKey, { scope: { prs: [201] }, note: "fresh window" });
  assert.equal(again.status, 201, JSON.stringify(again.json));
  assert.notEqual(again.json.claim.id, claim.id);
  assert.deepEqual(again.json.claim.supersedes, [claim.id]);
  const read = await f.claims("GET", f.ownerKey, undefined, `/${claim.id}`);
  assert.equal(read.json.claim.state, "superseded");
  assert.equal(read.json.claim.supersededBy, again.json.claim.id);
});

// --- expiry: presence-driven --------------------------------------------------------

test("expiry: a claim whose holder goes silent expires inside its window; activity renews the presence leg", async t => {
  const f = await serve(t);
  const taken = await f.claims("POST", f.guestKey, { scope: { lane: "quiet-lane" }, windowMinutes: 90 });
  assert.equal(taken.status, 201, JSON.stringify(taken.json));
  const claim = taken.json.claim;

  f.advance(10 * MIN);
  f.post(f.guestKey, "still here"); // room activity is a presence signal
  f.advance(10 * MIN); // 20 min after the claim, 10 after the last signal: inside grace
  let list = await f.claims("GET", f.ownerKey);
  assert.equal(list.json.claims.find(c => c.id === claim.id).state, "active",
    "a holder seen 10 minutes ago keeps the claim");

  f.advance(10 * MIN); // 20 min since the last presence signal: past the grace window
  list = await f.claims("GET", f.ownerKey);
  assert.equal(list.json.claims.find(c => c.id === claim.id).state, "expired",
    "a silent holder's claim expires even though the 90-minute window has not run out");

  const retaken = await f.claims("POST", f.ownerKey, { scope: { lane: "quiet-lane" } });
  assert.equal(retaken.status, 201, "an expired claim frees its subject");
});

test("expiry: the nominal window bounds even a live holder", async t => {
  const f = await serve(t);
  const taken = await f.claims("POST", f.guestKey, { scope: { names: ["short-window"] }, windowMinutes: 5 });
  assert.equal(taken.status, 201, JSON.stringify(taken.json));
  f.advance(4 * MIN);
  f.post(f.guestKey, "active");
  f.advance(2 * MIN); // 6 min in: past the 5-minute window, presence still fresh
  const list = await f.claims("GET", f.ownerKey);
  assert.equal(list.json.claims.find(c => c.id === taken.json.claim.id).state, "expired");
});

// --- MCP parity ---------------------------------------------------------------------

test("mcp: room_claim_surface, room_list_surface_claims, room_amend_surface_claim, room_release_surface_claim", async t => {
  const f = storeFixture(t);
  const owner = f.store.identities.create("Owen");
  const rooms = new AgentRooms(f.store);
  const { roomId } = rooms.create(owner.secret, { title: "Claim room", purpose: "claim mcp", displayName: "Owen" });
  const mcp = createHostedRoomMcp(f.store);
  const rpcCall = (name, args, secret) => mcp(
    { jsonrpc: "2.0", id: "c", method: "tools/call", params: { name, arguments: args } },
    { authorization: `Bearer ${secret}` });
  const valueOf = response => {
    if (response.error) throw new Error(`mcp error: ${JSON.stringify(response.error)}`);
    return response.result?.structuredContent ?? JSON.parse(response.result.content[0].text);
  };

  const listed = await mcp({ jsonrpc: "2.0", id: "l", method: "tools/list", params: { profile: "full" } }, { authorization: `Bearer ${owner.secret}` });
  const names = listed.result.tools.map(tool => tool.name);
  for (const name of ["room_claim_surface", "room_list_surface_claims", "room_amend_surface_claim", "room_release_surface_claim"]) {
    assert.ok(names.includes(name), `${name} is in the hosted catalog`);
  }

  const taken = valueOf(await rpcCall("room_claim_surface", { roomId, scope: { prs: [301] }, note: "via mcp" }, owner.secret));
  assert.equal(taken.claim.state, "active");
  assert.deepEqual(taken.claim.scope.prs, [301]);

  const again = valueOf(await rpcCall("room_claim_surface", { roomId, scope: { prs: [301] } }, owner.secret));
  assert.notEqual(again.claim.id, taken.claim.id, "the holder re-claiming its own subject mints a fresh claim");
  assert.deepEqual(again.claim.supersedes, [taken.claim.id], "and supersedes the old one");

  const all = valueOf(await rpcCall("room_list_surface_claims", { roomId }, owner.secret));
  assert.equal(all.claims.filter(c => c.state === "active").length, 1, "the superseding claim is the one active claim");
  assert.equal(all.claims.find(c => c.id === taken.claim.id).state, "superseded");

  const amended = valueOf(await rpcCall("room_amend_surface_claim",
    { roomId, claimId: all.claims.find(c => c.state === "active").id, note: "amended via mcp" }, owner.secret));
  assert.equal(amended.claim.note, "amended via mcp");

  const released = valueOf(await rpcCall("room_release_surface_claim",
    { roomId, claimId: amended.claim.id, reason: "mcp done" }, owner.secret));
  assert.equal(released.claim.state, "released");
});
