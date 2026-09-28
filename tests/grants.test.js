// UFO-steal slice 1 (RC-2026-09-27-2728): per-agent capability grant edges.
// Owner boundary: server/grants.mjs (table, issue/revoke/resolve, trust-
// boundary check) plus the HTTP management routes. Each test below guards
// one clause of the composition contract: tiers stay the coarse gate,
// #1166 guest-scope denials stay authoritative over grants, grants only
// add allow-edges, and resolution is per request (a mid-serve grant is
// live for the next request — nothing cached at boot).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { createRoomServer } from "../server/http.mjs";
import { demoteToReadonly } from "../server/autonomy-tiers.mjs";
import {
  GRANTABLE_CAPABILITIES,
  ensureGrantsSchema,
  issueGrant,
  revokeGrant,
  resolveGrants,
  hasGrant,
  requireCapability,
  requireGrantManagement,
  scopeCovers,
} from "../server/grants.mjs";

async function serve(t, { start = Date.parse("2026-09-27T12:00:00Z") } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-grants-"));
  const clock = { now: start };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: [], accountableHumanId: "owner" });
  send("owner", T.MEMBER_ADDED, { memberId: "agent2", displayName: "Second agent", kind: "agent", permissions: [], accountableHumanId: "owner" });
  send("owner", T.MEMBER_ADDED, { memberId: "agent3", displayName: "Plain agent", kind: "agent", permissions: [], accountableHumanId: "owner" });
  send("owner", T.MEMBER_ADDED, { memberId: "human2", displayName: "Second human", kind: "human", permissions: [] });
  send("owner", T.MEMBER_ADDED, { memberId: "guest-agent-x1", displayName: "Guest agent", kind: "agent", permissions: [] });
  keys.agent = store.issueAccessKey("commons", "agent");
  keys.agent2 = store.issueAccessKey("commons", "agent2");
  keys.agent3 = store.issueAccessKey("commons", "agent3");
  keys.human2 = store.issueAccessKey("commons", "human2");
  keys.guest = store.issueAccessKey("commons", "guest-agent-x1");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method,
    headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));
  return { store, keys, clock, send, request, db: () => store.db };
}

// assert.throws returns undefined on this Node; capture the error instead.
const capture = fn => { try { fn(); } catch (error) { return error; } throw new Error("expected the function to throw"); };
const actor = id => ({ id, kind: id.startsWith("guest-agent-") || id.startsWith("agent") ? "agent" : "human" });

test("grant issued → capability allowed; resolveGrants lists the live edge", async t => {
  const f = await serve(t);
  const db = f.db();
  const edge = issueGrant(db, "commons", "agent", "grants:issue", { grantedBy: "owner", nowMs: f.clock.now });
  assert.equal(edge.agentId, "agent");
  assert.equal(edge.capability, "grants:issue");
  assert.equal(edge.grantedBy, "owner");
  assert.equal(edge.revokedAt, null);
  // The trust-boundary check passes with the live edge.
  requireCapability({ db, roomId: "commons", actor: actor("agent"), capability: "grants:issue", state: f.store.room("commons").state, nowMs: f.clock.now });
  assert.equal(resolveGrants(db, "commons", "agent", f.clock.now).length, 1);
  // No edge → 403 capability_grant_required.
  const denied = capture(() => requireCapability({ db, roomId: "commons", actor: actor("agent2"), capability: "grants:issue", state: f.store.room("commons").state, nowMs: f.clock.now }));
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "capability_grant_required");
});

test("revoked edge denies on the next check; the row stays as audit", async t => {
  const f = await serve(t);
  const db = f.db();
  issueGrant(db, "commons", "agent", "grants:issue", { grantedBy: "owner", nowMs: f.clock.now });
  assert.equal(revokeGrant(db, "commons", "agent", "grants:issue", { nowMs: f.clock.now }), true);
  // Revoking again is idempotent, not an error.
  assert.equal(revokeGrant(db, "commons", "agent", "grants:issue", { nowMs: f.clock.now }), false);
  const denied = capture(() => requireCapability({ db, roomId: "commons", actor: actor("agent"), capability: "grants:issue", state: f.store.room("commons").state, nowMs: f.clock.now }));
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "capability_grant_required");
  assert.equal(resolveGrants(db, "commons", "agent", f.clock.now).length, 0);
  // The row is stamped, not deleted.
  const row = db.prepare("SELECT revoked_at FROM agent_capability_grants WHERE room_id=? AND agent_id=? AND capability=?")
    .get("commons", "agent", "grants:issue");
  assert.ok(row && row.revoked_at !== null);
});

test("expired edge denies (lazy expiry, fail-closed)", async t => {
  const f = await serve(t);
  const db = f.db();
  const now = f.clock.now;
  issueGrant(db, "commons", "agent", "grants:issue", { grantedBy: "owner", expiresAt: now + 1000, nowMs: now });
  requireCapability({ db, roomId: "commons", actor: actor("agent"), capability: "grants:issue", state: f.store.room("commons").state, nowMs: now + 500 });
  const denied = capture(() => requireCapability({ db, roomId: "commons", actor: actor("agent"), capability: "grants:issue", state: f.store.room("commons").state, nowMs: now + 2000 }));
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "capability_grant_required");
  // Expiry in the past is refused at issuance.
  const bad = capture(() => issueGrant(db, "commons", "agent", "grants:issue", { grantedBy: "owner", expiresAt: now - 1, nowMs: now }));
  assert.equal(bad.status, 422);
});

test("re-issue un-revokes and refreshes the edge", async t => {
  const f = await serve(t);
  const db = f.db();
  issueGrant(db, "commons", "agent", "grants:issue", { grantedBy: "owner", nowMs: f.clock.now });
  revokeGrant(db, "commons", "agent", "grants:issue", { nowMs: f.clock.now });
  const edge = issueGrant(db, "commons", "agent", "grants:issue",
    { grantedBy: "owner", expiresAt: f.clock.now + 60000, nowMs: f.clock.now });
  assert.equal(edge.revokedAt, null);
  assert.equal(edge.expiresAt, f.clock.now + 60000);
  requireCapability({ db, roomId: "commons", actor: actor("agent"), capability: "grants:issue", state: f.store.room("commons").state, nowMs: f.clock.now });
});

test("unknown capability refused at issuance", async t => {
  const f = await serve(t);
  const bad = capture(() => issueGrant(f.db(), "commons", "agent", "wake:page-owner", { grantedBy: "owner", nowMs: f.clock.now }));
  assert.equal(bad.status, 422);
  assert.equal(bad.code, "unknown_capability");
  assert.ok(GRANTABLE_CAPABILITIES.includes("grants:issue"));
});

test("guest member cannot be issued a grant — a grant can never widen a guest", async t => {
  const f = await serve(t);
  const bad = capture(() => issueGrant(f.db(), "commons", "guest-agent-x1", "grants:issue", { grantedBy: "owner", nowMs: f.clock.now }));
  assert.equal(bad.status, 422);
  assert.equal(bad.code, "grant_guest_forbidden");
});

test("guest denied even with a directly-inserted row (denials win over grants)", async t => {
  const f = await serve(t);
  const db = f.db();
  // Bypass issueGrant's refusal: a row that somehow exists must stay inert.
  db.prepare(`INSERT INTO agent_capability_grants
      (room_id, agent_id, capability, granted_by, scope, expires_at, revoked_at, created_at)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`)
    .run("commons", "guest-agent-x1", "grants:issue", "owner", f.clock.now);
  const denied = capture(() => requireCapability({ db, roomId: "commons", actor: actor("guest-agent-x1"), capability: "grants:issue", state: f.store.room("commons").state, nowMs: f.clock.now }));
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "grant_denied");
  assert.equal(hasGrant(db, "commons", "guest-agent-x1", "grants:issue", { nowMs: f.clock.now }), true,
    "the row exists; only the trust-boundary check denies it");
});

test("scope narrows the edge: wildcard covers, exact mismatch does not", async t => {
  const f = await serve(t);
  const db = f.db();
  issueGrant(db, "commons", "agent", "grants:issue", { grantedBy: "owner", scope: "agents:*", nowMs: f.clock.now });
  assert.equal(hasGrant(db, "commons", "agent", "grants:issue", { scope: "agents:agent2", nowMs: f.clock.now }), true);
  assert.equal(hasGrant(db, "commons", "agent", "grants:issue", { scope: "rooms:x", nowMs: f.clock.now }), false);
  assert.equal(scopeCovers(null, "anything"), true);
  assert.equal(scopeCovers("agents:*", "agents:agent2"), true);
  assert.equal(scopeCovers("agents:agent2", "agents:agent2"), true);
  assert.equal(scopeCovers("agents:agent2", "agents:agent3"), false);
});

test("tier denial wins over a live grant (tiers stay the coarse gate)", async t => {
  const f = await serve(t);
  const db = f.db();
  issueGrant(db, "commons", "agent", "grants:issue", { grantedBy: "owner", nowMs: f.clock.now });
  demoteToReadonly(db, "commons", "agent", { updatedBy: "owner", nowMs: f.clock.now });
  const denied = capture(() => requireGrantManagement({
    db, roomId: "commons", state: f.store.room("commons").state,
    actor: actor("agent"), nowMs: f.clock.now,
  }));
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "agent_readonly");
});

test("non-owner human cannot manage grants", async t => {
  const f = await serve(t);
  const denied = capture(() => requireGrantManagement({
    db: f.db(), roomId: "commons", state: f.store.room("commons").state,
    actor: actor("human2"), nowMs: f.clock.now,
  }));
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "owner_required");
});

test("HTTP: mid-serve grant is live for the next request — no restart", async t => {
  const f = await serve(t);
  const agentCaps = token => f.request("/api/rooms/commons/agent-capabilities", { token });
  // No edges yet.
  assert.deepEqual((await agentCaps(f.keys.agent)).json.grants, []);
  // Owner issues mid-serve.
  const issued = await f.request("/api/rooms/commons/agent-grants", {
    method: "POST", token: f.keys.owner, data: { agentId: "agent", capability: "grants:issue" },
  });
  assert.equal(issued.status, 201);
  assert.equal(issued.json.grant.capability, "grants:issue");
  // Same server, no restart: the agent's next request sees it.
  const after = await agentCaps(f.keys.agent);
  assert.equal(after.json.grants.length, 1);
  assert.equal(after.json.grants[0].grantedBy, "owner");
  // Revocation bites on the very next request.
  const revoked = await f.request("/api/rooms/commons/agent-grants/agent/grants:issue", { method: "DELETE", token: f.keys.owner });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.revoked, true);
  assert.deepEqual((await agentCaps(f.keys.agent)).json.grants, []);
});

test("HTTP: grants:issue delegation — holder can issue, others cannot", async t => {
  const f = await serve(t);
  const issue = (token, data) => f.request("/api/rooms/commons/agent-grants", { method: "POST", token, data });
  // agent has no edge: 403.
  const refused = await issue(f.keys.agent, { agentId: "agent2", capability: "grants:issue" });
  assert.equal(refused.status, 403);
  // Owner delegates to agent.
  assert.equal((await issue(f.keys.owner, { agentId: "agent", capability: "grants:issue" })).status, 201);
  // The delegate can now issue for agent2.
  const delegated = await issue(f.keys.agent, { agentId: "agent2", capability: "grants:issue" });
  assert.equal(delegated.status, 201);
  assert.equal(delegated.json.grant.grantedBy, "agent");
  // Owner lists every edge.
  const listed = await f.request("/api/rooms/commons/agent-grants", { token: f.keys.owner });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.grants.length, 2);
  // A plain agent with no edge cannot list.
  assert.equal((await f.request("/api/rooms/commons/agent-grants", { token: f.keys.agent3 })).status, 403);
});

test("HTTP: guest issue refused; guest self-read shows no edges", async t => {
  const f = await serve(t);
  const refused = await f.request("/api/rooms/commons/agent-grants", {
    method: "POST", token: f.keys.owner, data: { agentId: "guest-agent-x1", capability: "grants:issue" },
  });
  assert.equal(refused.status, 422);
  assert.equal(refused.json.error.code, "grant_guest_forbidden");
  const caps = await f.request("/api/rooms/commons/agent-capabilities", { token: f.keys.guest });
  assert.equal(caps.status, 200);
  assert.equal(caps.json.guest, true);
  assert.deepEqual(caps.json.grants, []);
});

test("schema boot: ensureGrantsSchema is idempotent and store boot creates the table", async t => {
  const f = await serve(t);
  ensureGrantsSchema(f.db());
  ensureGrantsSchema(f.db());
  const row = f.db().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_capability_grants'").get();
  assert.ok(row, "store boot created agent_capability_grants");
});

test("catalog seam: resolveCatalogAgent carries live grant edges; revoked edges drop out", async t => {
  // Guards the slice-1 wiring into the #1170 catalog predicate: the
  // descriptor's grants array must reflect the live grant table, fresh
  // per call, so a grant issued mid-serve appears in the next listing
  // and a revocation disappears. #1170's tests build descriptors by
  // hand and never exercise this builder half.
  const f = await serve(t);
  const db = f.db();
  db.prepare("INSERT INTO agent_identities (identity_id, secret_hash, display_name, created_at) VALUES (?,?,?,?)")
    .run("id-agent", "hash-x", "Test agent identity", f.clock.now);
  db.prepare("INSERT INTO identity_links (room_id, identity_id, member_id, linked_at) VALUES (?,?,?,?)")
    .run("commons", "id-agent", "agent", f.clock.now);
  const { resolveCatalogAgent } = await import("../server/capability-visibility.mjs");
  const describe = () => resolveCatalogAgent(f.store, { identityId: "id-agent" });
  assert.deepEqual(describe().grants, [], "no edges yet");
  issueGrant(db, "commons", "agent", "grants:issue", { grantedBy: "owner", nowMs: f.clock.now });
  assert.deepEqual(describe().grants, ["grants:issue"], "live edge appears without restart");
  revokeGrant(db, "commons", "agent", "grants:issue", { nowMs: f.clock.now });
  assert.deepEqual(describe().grants, [], "revoked edge drops out");
});
