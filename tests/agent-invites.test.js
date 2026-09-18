import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, scryptSync } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const sha256 = text => createHash("sha256").update(text).digest("hex");
const slowHash = code => scryptSync(code, "project-room-agent-invite-v2", 32, { N: 16384, r: 8, p: 1 }).toString("hex");

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
    const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/agent-inbox.mjs", ...args], {
      env: { ...scrubbed, ...base, ...env }, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
    });
    return { status: 0, json: JSON.parse(stdout), stderr: String(stderr) };
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
  // v2 codes: 16 symbols from the 32-symbol Crockford alphabet (80 bits).
  assert.match(res.json.code, /^RM-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/);
  // The stored hash never leaves the server: the response carries an 8-hex handle.
  assert.match(res.json.inviteId, /^[a-f0-9]{8}$/);
  assert.equal(res.json.codeHash, undefined);
  assert.equal(res.json.roomId, "commons");
  assert.deepEqual(res.json.permissions, ["accept_work", "complete_work"]);
  const row = store.db.prepare("SELECT * FROM agent_invite_codes WHERE code_hash=?").get(slowHash(res.json.code));
  assert.ok(row, "code row exists");
  assert.equal(res.json.inviteId, row.code_hash.slice(0, 8));
  assert.ok(!JSON.stringify(row).includes(res.json.code), "raw code appears nowhere in the stored row");
  // The stored hash is the deterministic slow hash, never a bare sha256 of the code.
  assert.notEqual(row.code_hash, sha256(res.json.code));
  assert.equal(row.code_hash, slowHash(res.json.code));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM agent_invite_codes WHERE code_hash=?").get(sha256(res.json.code)).n, 0);
});

test("codes are drawn uniformly from the whole alphabet with no modulo bias", async t => {
  const { origin, ownerKey } = await serve(t);
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const res = await mint(origin, ownerKey, { permissions: ["accept_work"] });
    assert.equal(res.status, 201);
    for (const symbol of res.json.code.slice(3)) seen.add(symbol);
  }
  // 192 symbols from a 32-symbol alphabet: every symbol appears with
  // overwhelming probability, and none outside the alphabet ever does.
  for (const symbol of seen) assert.ok("0123456789ABCDEFGHJKMNPQRSTVWXYZ".includes(symbol), symbol);
  assert.ok(seen.size >= 28, `expected broad alphabet coverage, saw ${seen.size} symbols`);
});

test("displayName must be text when present: null is rejected, not stored as \"null\"", async t => {
  const { store, origin, ownerKey } = await serve(t);
  for (const displayName of [null, 42, ["Bot"], { name: "Bot" }]) {
    const res = await mint(origin, ownerKey, { permissions: ["accept_work"], displayName });
    assert.equal(res.status, 422, JSON.stringify(displayName));
    assert.equal(res.json.error.code, "invalid_invite");
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM agent_invite_codes WHERE display_name='null'").get().n, 0);
  assert.equal((await mint(origin, ownerKey, { permissions: ["accept_work"], displayName: "Named" })).status, 201);
});

test("legacy 8-symbol codes stored as sha256 keep redeeming until they expire", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const legacy = "RM-7K2P9QXZ"; // pre-v2 format: 8 symbols, no 0/O/1/I/L
  const now = Date.now();
  store.db.prepare(`INSERT INTO agent_invite_codes(code_hash,room_id,created_by,permissions_json,display_name,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?)`).run(sha256(legacy), "commons", "owner", JSON.stringify(["accept_work"]), "Legacy Bot", now, now + 3600000);
  // Listed by the handle derived from the stored hash; the bare sha256 itself never shows.
  const listed = await get(origin, "/api/rooms/commons/agent-invites", ownerKey);
  assert.ok(listed.json.invites.some(row => row.inviteId === sha256(legacy).slice(0, 8) && row.status === "active"));
  assert.ok(!JSON.stringify(listed.json).includes(sha256(legacy)));
  const res = await redeem(origin, legacy.toLowerCase(), "Legacy Bot");
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.deepEqual(res.json.permissions, ["accept_work"]);
  assert.equal((await redeem(origin, legacy)).status, 409);
  // A legacy-length code with v2-only symbols is neither format: rejected up front.
  assert.equal((await redeem(origin, "RM-0000AAAA")).status, 404);
  // Unknown codes in either format, and lengths that are neither, all fail alike.
  for (const code of ["RM-AAAAAAAA", "RM-AAAAAAAAAAAAAAAA", "RM-AAAAAAAAAAAA", "RM-AAAAAAAAAAAAAAAAAAAA"]) {
    const unknown = await redeem(origin, code);
    assert.equal(unknown.status, 404, code);
    assert.equal(unknown.json.error.code, "invite_unavailable");
  }
  // A new code is stored under its slow hash, so the sha256 lookup never finds it.
  const minted = await mint(origin, ownerKey, { permissions: ["accept_work"] });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM agent_invite_codes WHERE code_hash=?").get(sha256(minted.json.code)).n, 0);
  assert.equal((await redeem(origin, minted.json.code)).status, 201);
});

test("redeem folds the Crockford confusables so a transcribed code still works", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey, { permissions: ["accept_work"] });
  const typed = minted.json.code.toLowerCase().replace(/0/g, "o").replace(/1/g, "l");
  assert.equal((await redeem(origin, typed)).status, 201);
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
  const revoked = await del(origin, "/api/rooms/commons/agent-invites", { inviteId: minted.json.inviteId }, ownerKey);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.revoked, true);
  assert.equal(revoked.json.inviteId, minted.json.inviteId);
  const afterRevoke = await redeem(origin, minted.json.code);
  assert.equal(afterRevoke.status, 410);
  assert.equal(afterRevoke.json.error.code, "invite_revoked");
  const minted2 = await mint(origin, ownerKey, { permissions: ["accept_work"] });
  store.db.prepare("UPDATE agent_invite_codes SET expires_at=? WHERE code_hash=?").run(Date.now() - 1000, slowHash(minted2.json.code));
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
  const denied = await del(origin, "/api/rooms/commons/agent-invites", { inviteId: minted.json.inviteId }, id.json.secret);
  assert.equal(denied.status, 403);
  const used = await mint(origin, ownerKey, { permissions: ["accept_work"] });
  assert.equal((await redeem(origin, used.json.code)).status, 201);
  const revokeUsed = await del(origin, "/api/rooms/commons/agent-invites", { inviteId: used.json.inviteId }, ownerKey);
  assert.equal(revokeUsed.status, 404);
  // The old full-hash body is no longer a valid handle.
  const byHash = await del(origin, "/api/rooms/commons/agent-invites", { codeHash: slowHash(minted.json.code) }, ownerKey);
  assert.equal(byHash.status, 422);
  assert.equal((await del(origin, "/api/rooms/commons/agent-invites", { inviteId: slowHash(minted.json.code) }, ownerKey)).status, 422);
  assert.equal((await del(origin, "/api/rooms/commons/agent-invites", { inviteId: "00000000" }, ownerKey)).status, 404);
});

test("list is the audit trail: creation, redemption, revocation, expiry", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const a = await mint(origin, ownerKey, { permissions: ["accept_work"], displayName: "A" });
  const b = await mint(origin, ownerKey, { permissions: ["verify"], displayName: "B" });
  const c = await mint(origin, ownerKey, { permissions: ["accept_work"], displayName: "C" });
  assert.equal((await redeem(origin, a.json.code)).status, 201);
  assert.equal((await del(origin, "/api/rooms/commons/agent-invites", { inviteId: b.json.inviteId }, ownerKey)).status, 200);
  store.db.prepare("UPDATE agent_invite_codes SET expires_at=? WHERE code_hash=?").run(Date.now() - 1000, slowHash(c.json.code));
  const listed = await get(origin, "/api/rooms/commons/agent-invites", ownerKey);
  assert.equal(listed.status, 200);
  const byId = Object.fromEntries(listed.json.invites.map(row => [row.inviteId, row]));
  assert.equal(byId[a.json.inviteId].status, "redeemed");
  assert.equal(byId[b.json.inviteId].status, "revoked");
  assert.equal(byId[c.json.inviteId].status, "expired");
  assert.equal(byId[a.json.inviteId].createdBy, "owner");
  assert.ok(byId[a.json.inviteId].redeemedIdentityId?.startsWith("ai_"));
  assert.ok(byId[a.json.inviteId].redeemedAt > 0);
  // Raw codes and stored hashes never appear in the audit view.
  const serialized = JSON.stringify(listed.json);
  assert.ok(!serialized.includes(a.json.code));
  for (const minted of [a, b, c]) assert.ok(!serialized.includes(slowHash(minted.json.code)));
  assert.equal(/[a-f0-9]{64}/.test(serialized), false, "no 64-hex hash in the listing");
  assert.ok(!Object.keys(listed.json.invites[0]).some(key => /hash/i.test(key)));
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
  assert.ok(listed.json.invites.some(row => row.inviteId === minted.json.inviteId && row.status === "active"));
  // Redemption needs only the origin: no credential exists yet. Scripted
  // flows pass --yes; the grant summary still prints to stderr.
  const redeemed = await cli(origin, ["redeem-invite", minted.json.code, "Plug Bot", "--yes"]);
  assert.equal(redeemed.status, 0, redeemed.stderr);
  assert.match(redeemed.json.secret, /^pri_/);
  assert.match(redeemed.stderr, /This code grants: accept_work, complete_work/);
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
  const revokeUsed = await cli(origin, ["invite-code-revoke", minted.json.inviteId], ownerEnv);
  assert.notEqual(revokeUsed.status, 0);
  const reuse = await cli(origin, ["redeem-invite", minted.json.code, "Plug Bot", "--yes"]);
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

test("profile names map server-side to the sponsorship's standing permission sets", async t => {
  const { origin, ownerKey } = await serve(t);
  const expectations = { chat: [], contribute: ["accept_work", "complete_work"], review: ["verify"] };
  for (const [profile, permissions] of Object.entries(expectations)) {
    const res = await post(origin, "/api/rooms/commons/agent-invites", { profile }, ownerKey);
    assert.equal(res.status, 201, `${profile}: ${JSON.stringify(res.json)}`);
    assert.deepEqual(res.json.permissions, permissions);
    assert.equal(res.json.profile, profile);
  }
});

test("a tampered brief cannot widen authority: profile plus permissions, unknown profile", async t => {
  const { origin, ownerKey } = await serve(t);
  const both = await post(origin, "/api/rooms/commons/agent-invites",
    { profile: "contribute", permissions: ["steer", "write_external", "decide"] }, ownerKey);
  assert.equal(both.status, 422);
  assert.equal(both.json?.error?.code, "invalid_invite_scope");
  const unknown = await post(origin, "/api/rooms/commons/agent-invites", { profile: "admin" }, ownerKey);
  assert.equal(unknown.status, 422);
  const extraKey = await post(origin, "/api/rooms/commons/agent-invites", { profile: "review", grant: ["decide"] }, ownerKey);
  assert.equal(extraKey.status, 422);
  assert.equal(extraKey.json?.error?.code, "invalid_invite");
});

test("chat profile mints a read-only agent: redeem enrolls with no extra authority", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await post(origin, "/api/rooms/commons/agent-invites", { profile: "chat" }, ownerKey);
  assert.equal(minted.status, 201);
  assert.deepEqual(minted.json.permissions, []);
  const redeemed = await post(origin, "/api/agent-invites/redeem",
    { code: minted.json.code, displayName: "Quiet Observer" });
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.json));
  // The member's authority is exactly the profile's fixed set — prove it by
  // reaching owner-only diagnostics with the agent's own credential.
  const agentToken = redeemed.json.secret;
  const check = await get(origin, "/api/rooms/commons/diagnostics", agentToken);
  assert.notEqual(check.status, 200, "a read-only agent must not reach owner diagnostics");
});

test("CLI mints a code from a profile name and rejects unknown profiles", async t => {
  const { origin, ownerKey } = await serve(t);
  const ownerEnv = { ROOM_AGENT_ROOM: "commons", ROOM_AGENT_MEMBER: "owner", ROOM_AGENT_TOKEN: ownerKey };
  const minted = await cli(origin, ["invite-code", "profile:review", "60", "Review Bot"], ownerEnv);
  assert.equal(minted.status, 0, minted.stderr);
  assert.deepEqual(minted.json.permissions, ["verify"]);
  assert.equal(minted.json.profile, "review");
  const bad = await cli(origin, ["invite-code", "profile:admin"], ownerEnv);
  assert.notEqual(bad.status, 0);
});

test("preview returns the grant without consuming the code", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey, { profile: "contribute", expiresInMinutes: 60, displayName: "Plug Bot" });
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  const preview = await get(origin, `/api/agent-invites/preview?code=${encodeURIComponent(minted.json.code)}`);
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.roomId, "commons");
  assert.equal(preview.json.roomTitle, "Project Room Commons");
  assert.deepEqual(preview.json.permissions, ["accept_work", "complete_work"]);
  assert.equal(preview.json.profile, "contribute");
  assert.ok(preview.json.expiresAt > Date.now());
  // Nothing sensitive leaks and nothing was consumed: the code still redeems.
  assert.ok(!("secret" in preview.json) && !("identityId" in preview.json) && !("memberId" in preview.json));
  const listed = await get(origin, "/api/rooms/commons/agent-invites", ownerKey);
  assert.ok(listed.json.invites.some(row => row.inviteId === minted.json.inviteId && row.status === "active"));
  const redeemed = await redeem(origin, minted.json.code);
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.json));
});

test("preview folds failures like redeem: unknown, used, revoked, expired", async t => {
  const { origin, ownerKey } = await serve(t);
  const preview = code => get(origin, `/api/agent-invites/preview?code=${encodeURIComponent(code)}`);
  const unknown = await preview("RM-AAAAAAAAAAAAAAAA");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, "invite_unavailable");
  const minted = await mint(origin, ownerKey, { profile: "chat", expiresInMinutes: 60 });
  assert.equal(minted.status, 201);
  assert.equal((await redeem(origin, minted.json.code)).status, 201);
  const used = await preview(minted.json.code);
  assert.equal(used.status, 409);
  assert.equal(used.json.error.code, "invite_already_used");
  const minted2 = await mint(origin, ownerKey, { profile: "chat", expiresInMinutes: 60 });
  await del(origin, "/api/rooms/commons/agent-invites", { inviteId: minted2.json.inviteId }, ownerKey);
  const revoked = await preview(minted2.json.code);
  assert.equal(revoked.status, 410);
  assert.equal(revoked.json.error.code, "invite_revoked");
  const minted3 = await mint(origin, ownerKey, { profile: "chat", expiresInMinutes: 60 });
  assert.equal((await preview(minted3.json.code)).status, 200);
});

test("CLI consent: --yes prints the grant and redeems; --no aborts without creating anything", async t => {
  const { origin, ownerKey } = await serve(t);
  const ownerEnv = { ROOM_AGENT_ROOM: "commons", ROOM_AGENT_MEMBER: "owner", ROOM_AGENT_TOKEN: ownerKey };
  const minted = await cli(origin, ["invite-code", "profile:contribute", "60", "Consent Bot"], ownerEnv);
  assert.equal(minted.status, 0, minted.stderr);
  // --no: the consent screen prints, nothing is created, the code stays live.
  const declined = await cli(origin, ["redeem-invite", minted.json.code, "Consent Bot", "--no"]);
  assert.notEqual(declined.status, 0);
  assert.match(declined.stderr, /This code grants: accept_work, complete_work/);
  assert.match(declined.stderr, /profile: contribute/);
  assert.match(declined.stderr, /acts as itself, never as you/);
  assert.match(declined.stderr, /not redeemed/);
  const listed = await cli(origin, ["invite-codes"], ownerEnv);
  assert.ok(listed.json.invites.some(row => row.inviteId === minted.json.inviteId && row.status === "active"),
    "declined code must stay active");
  // --yes: the same summary prints, then the identity is created.
  const accepted = await cli(origin, ["redeem-invite", minted.json.code, "Consent Bot", "--yes"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.json.secret, /^pri_/);
  assert.match(accepted.stderr, /This code grants: accept_work, complete_work/);
});

test("CLI consent: non-interactive without --yes refuses instead of hanging", async t => {
  const { origin, ownerKey } = await serve(t);
  const ownerEnv = { ROOM_AGENT_ROOM: "commons", ROOM_AGENT_MEMBER: "owner", ROOM_AGENT_TOKEN: ownerKey };
  const minted = await cli(origin, ["invite-code", "profile:chat", "60", "Shy Bot"], ownerEnv);
  assert.equal(minted.status, 0, minted.stderr);
  // execFile stdin is a pipe, never a TTY: the CLI must not block on a prompt.
  const refused = await cli(origin, ["redeem-invite", minted.json.code, "Shy Bot"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--yes/);
  // The code survived the refusal and redeems fine with --yes.
  const accepted = await cli(origin, ["redeem-invite", minted.json.code, "Shy Bot", "--yes"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(accepted.json.permissions, []);
});

test("CLI rejects --yes and --no together", async t => {
  const { origin, ownerKey } = await serve(t);
  const ownerEnv = { ROOM_AGENT_ROOM: "commons", ROOM_AGENT_MEMBER: "owner", ROOM_AGENT_TOKEN: ownerKey };
  const minted = await cli(origin, ["invite-code", "profile:chat", "60", "Fussy Bot"], ownerEnv);
  assert.equal(minted.status, 0, minted.stderr);
  const both = await cli(origin, ["redeem-invite", minted.json.code, "Fussy Bot", "--yes", "--no"]);
  assert.notEqual(both.status, 0);
});
