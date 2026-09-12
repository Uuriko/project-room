import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const execFileAsync = promisify(execFile);
// The room server runs on this process's event loop, so the CLI must be
// spawned async (never sync): a blocked loop starves the server and every
// child request times out.
async function cli(origin, args, env = {}) {
  const scrubbed = { ...process.env };
  for (const name of Object.keys(scrubbed)) if (name.startsWith("ROOM_AGENT_")) delete scrubbed[name];
  // A saved connection and credential variables are mutually exclusive.
  const base = env.ROOM_AGENT_CONFIG === undefined ? { ROOM_AGENT_ORIGIN: origin } : {};
  try {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/agent-inbox.mjs", ...args], {
      env: { ...scrubbed, ...base, ...env }, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
    });
    return { status: 0, json: JSON.parse(stdout) };
  } catch (error) { return { status: error.code ?? 1, stderr: String(error.stderr ?? error.message) }; }
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invites-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

async function post(origin, path, body, token) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function get(origin, path, token) {
  const res = await fetch(`${origin}${path}`, {
    headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function del(origin, path, body, token) {
  const res = await fetch(`${origin}${path}`, {
    method: "DELETE", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const mint = (origin, ownerKey, body) => post(origin, "/api/rooms/commons/agent-invites", body, ownerKey);
const redeem = (origin, code, displayName = "Redeemed Bot") => post(origin, "/api/agent-invites/redeem", { code, displayName });

test("owner mints a one-time code; the raw code is never stored", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const res = await mint(origin, ownerKey, { permissions: ["accept_work", "complete_work"], expiresInMinutes: 60, displayName: "Plug Bot" });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.match(res.json.code, /^RM-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  assert.match(res.json.codeHash, /^[a-f0-9]{64}$/);
  assert.equal(res.json.roomId, "commons");
  assert.deepEqual(res.json.permissions, ["accept_work", "complete_work"]);
  const row = store.db.prepare("SELECT * FROM agent_invite_codes WHERE code_hash=?").get(res.json.codeHash);
  assert.ok(row, "code row exists");
  assert.ok(!JSON.stringify(row).includes(res.json.code), "raw code appears nowhere in the stored row");
});

test("minting is owner-only and can never grant administration", async t => {
  const { origin, ownerKey } = await serve(t);
  // An agent member cannot mint.
  const id = await post(origin, "/api/agent-identities", { displayName: "Grunt" });
  const linked = await post(origin, "/api/rooms/commons/identity-links",
    { identityId: id.json.identityId, permissions: ["accept_work"] }, ownerKey);
  assert.equal(linked.status, 201);
  const denied = await mint(origin, id.json.secret, { permissions: ["accept_work"] });
  assert.equal(denied.status, 403);
  // manage_members, decide, and unknown permissions are rejected at issuance.
  for (const permissions of [["manage_members"], ["decide"], ["accept_work", "manage_members"], ["fly"], []]) {
    const bad = await mint(origin, ownerKey, { permissions });
    assert.equal(bad.status, 422, JSON.stringify(permissions));
  }
  // Bad TTLs are rejected.
  for (const expiresInMinutes of [0, 4, 43201, "soon"]) {
    const bad = await mint(origin, ownerKey, { permissions: ["accept_work"], expiresInMinutes });
    assert.equal(bad.status, 422, JSON.stringify(expiresInMinutes));
  }
});

test("redeem enrolls an agent member with the code's scope and nothing more", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const accountsBefore = store.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
  const minted = await mint(origin, ownerKey, { permissions: ["accept_work", "complete_work"] });
  const res = await redeem(origin, minted.json.code, "Plug Bot");
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.match(res.json.identityId, /^ai_/);
  assert.match(res.json.secret, /^pri_/);
  assert.equal(res.json.memberId, res.json.identityId);
  assert.deepEqual(res.json.permissions, ["accept_work", "complete_work"]);
  // The secret authenticates as the new member with exactly the granted scope.
  const client = (await import("../client/room-agent.mjs")).RoomAgentClient;
  const agent = new client({ origin, roomId: "commons", token: res.json.secret, memberId: res.json.memberId });
  const connected = await agent.checkConnection();
  assert.equal(connected.status, "credential_accepted");
  assert.deepEqual(connected.permissions, ["accept_work", "complete_work"]);
  // No account session and no member_accounts row: the identity secret is the
  // only credential, and manage_members was not granted.
  const accountsAfter = store.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
  assert.equal(accountsAfter, accountsBefore);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM member_accounts WHERE member_id=?").get(res.json.memberId).n, 0);
  const member = store.room("commons").state.members[res.json.memberId];
  assert.equal(member.kind, "agent");
  assert.ok(!member.permissions.includes("manage_members") && !member.permissions.includes("decide"));
});

test("a code is single-use: the second redemption fails", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey, { permissions: ["accept_work"] });
  const first = await redeem(origin, minted.json.code);
  assert.equal(first.status, 201);
  const second = await redeem(origin, minted.json.code);
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, "invite_already_used");
});

test("unknown, revoked, and expired codes fail distinctly", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const unknown = await redeem(origin, "RM-AAAAAAAA");
  assert.equal(unknown.status, 404);
  const minted = await mint(origin, ownerKey, { permissions: ["accept_work"] });
  const revoked = await del(origin, "/api/rooms/commons/agent-invites", { codeHash: minted.json.codeHash }, ownerKey);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.revoked, true);
  const afterRevoke = await redeem(origin, minted.json.code);
  assert.equal(afterRevoke.status, 410);
  assert.equal(afterRevoke.json.error.code, "invite_revoked");
  const minted2 = await mint(origin, ownerKey, { permissions: ["accept_work"] });
  store.db.prepare("UPDATE agent_invite_codes SET expires_at=? WHERE code_hash=?").run(Date.now() - 1000, minted2.json.codeHash);
  const afterExpiry = await redeem(origin, minted2.json.code);
  assert.equal(afterExpiry.status, 410);
  assert.equal(afterExpiry.json.error.code, "invite_expired");
});

test("revocation is owner-only and cannot burn a used code", async t => {
  const { origin, ownerKey } = await serve(t);
  const id = await post(origin, "/api/agent-identities", { displayName: "Grunt" });
  const linked = await post(origin, "/api/rooms/commons/identity-links",
    { identityId: id.json.identityId, permissions: ["accept_work"] }, ownerKey);
  assert.equal(linked.status, 201);
  const minted = await mint(origin, ownerKey, { permissions: ["accept_work"] });
  const denied = await del(origin, "/api/rooms/commons/agent-invites", { codeHash: minted.json.codeHash }, id.json.secret);
  assert.equal(denied.status, 403);
  const used = await mint(origin, ownerKey, { permissions: ["accept_work"] });
  assert.equal((await redeem(origin, used.json.code)).status, 201);
  const revokeUsed = await del(origin, "/api/rooms/commons/agent-invites", { codeHash: used.json.codeHash }, ownerKey);
  assert.equal(revokeUsed.status, 404);
});

test("list is the audit trail: creation, redemption, revocation, expiry", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const a = await mint(origin, ownerKey, { permissions: ["accept_work"], displayName: "A" });
  const b = await mint(origin, ownerKey, { permissions: ["verify"], displayName: "B" });
  const c = await mint(origin, ownerKey, { permissions: ["accept_work"], displayName: "C" });
  assert.equal((await redeem(origin, a.json.code)).status, 201);
  assert.equal((await del(origin, "/api/rooms/commons/agent-invites", { codeHash: b.json.codeHash }, ownerKey)).status, 200);
  store.db.prepare("UPDATE agent_invite_codes SET expires_at=? WHERE code_hash=?").run(Date.now() - 1000, c.json.codeHash);
  const listed = await get(origin, "/api/rooms/commons/agent-invites", ownerKey);
  assert.equal(listed.status, 200);
  const byHash = Object.fromEntries(listed.json.invites.map(row => [row.codeHash, row]));
  assert.equal(byHash[a.json.codeHash].status, "redeemed");
  assert.equal(byHash[b.json.codeHash].status, "revoked");
  assert.equal(byHash[c.json.codeHash].status, "expired");
  assert.equal(byHash[a.json.codeHash].createdBy, "owner");
  assert.ok(byHash[a.json.codeHash].redeemedIdentityId?.startsWith("ai_"));
  assert.ok(byHash[a.json.codeHash].redeemedAt > 0);
  // Raw codes never appear in the audit view.
  assert.ok(!JSON.stringify(listed.json).includes(a.json.code));
  // Non-owners cannot read the audit.
  const id = await post(origin, "/api/agent-identities", { displayName: "Grunt" });
  const linked = await post(origin, "/api/rooms/commons/identity-links",
    { identityId: id.json.identityId, permissions: ["accept_work"] }, ownerKey);
  assert.equal(linked.status, 201);
  assert.equal((await get(origin, "/api/rooms/commons/agent-invites", id.json.secret)).status, 403);
});

test("a demoted issuer's outstanding codes stop working", async t => {
  const { store, origin, ownerKey } = await serve(t);
  store.command(ownerKey, "commons", { id: randomUUID(), type: "member.added",
    data: { memberId: "mod", displayName: "Mod", kind: "human",
      permissions: ["steer", "manage_members", "manage_claims", "accept_work", "complete_work", "verify"] } });
  const modKey = store.issueAccessKey("commons", "mod");
  const minted = await mint(origin, modKey, { permissions: ["accept_work"] });
  assert.equal(minted.status, 201);
  const revision = store.room("commons").state.members.mod.revision;
  store.command(ownerKey, "commons", { id: randomUUID(), type: "member.access_changed",
    data: { memberId: "mod", expectedMemberRevision: revision, permissions: ["steer"], active: true } });
  const res = await redeem(origin, minted.json.code);
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "invite_authority_changed");
});

test("CLI: owner mints a code, a new AI redeems it and connects", async t => {
  const { origin, ownerKey } = await serve(t);
  const ownerEnv = { ROOM_AGENT_ROOM: "commons", ROOM_AGENT_MEMBER: "owner", ROOM_AGENT_TOKEN: ownerKey };
  const minted = await cli(origin, ["invite-code", "accept_work,complete_work", "60", "Plug Bot"], ownerEnv);
  assert.equal(minted.status, 0, minted.stderr);
  assert.match(minted.json.code, /^RM-/);
  const listed = await cli(origin, ["invite-codes"], ownerEnv);
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(listed.json.invites.some(row => row.codeHash === minted.json.codeHash && row.status === "active"));
  // Redemption needs only the origin: no credential exists yet.
  const redeemed = await cli(origin, ["redeem-invite", minted.json.code, "Plug Bot"]);
  assert.equal(redeemed.status, 0, redeemed.stderr);
  assert.match(redeemed.json.secret, /^pri_/);
  const agentDir = mkdtempSync(join(tmpdir(), "invite-loop-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const connected = await cli(origin, ["connect", join(agentDir, "agent")], {
    ROOM_AGENT_ROOM: "commons", ROOM_AGENT_MEMBER: redeemed.json.memberId, ROOM_AGENT_TOKEN: redeemed.json.secret,
  });
  assert.equal(connected.status, 0, connected.stderr);
  const checked = await cli(origin, ["check"], { ROOM_AGENT_CONFIG: join(agentDir, "agent") });
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.json.status, "credential_accepted");
  assert.deepEqual(checked.json.permissions, ["accept_work", "complete_work"]);
  // The burned code cannot be revoked (already used) and cannot be reused.
  const revokeUsed = await cli(origin, ["invite-code-revoke", minted.json.codeHash], ownerEnv);
  assert.notEqual(revokeUsed.status, 0);
  const reuse = await cli(origin, ["redeem-invite", minted.json.code, "Plug Bot"]);
  assert.notEqual(reuse.status, 0);
});

test("CLI rejects bad invite arglists at the boundary", async t => {
  const { origin, ownerKey } = await serve(t);
  const ownerEnv = { ROOM_AGENT_ROOM: "commons", ROOM_AGENT_MEMBER: "owner", ROOM_AGENT_TOKEN: ownerKey };
  assert.notEqual((await cli(origin, ["invite-code"], ownerEnv)).status, 0);
  assert.notEqual((await cli(origin, ["invite-code", "accept_work", "soon"], ownerEnv)).status, 0);
  assert.notEqual((await cli(origin, ["invite-code-revoke", "nope"], ownerEnv)).status, 0);
  assert.notEqual((await cli(origin, ["redeem-invite", "RM-AAAAAAAA"], ownerEnv)).status, 0);
  assert.notEqual((await cli(origin, ["invite-codes", "extra"], ownerEnv)).status, 0);
});
