// BUILD-01 D4: periodic access review. Owner-only route and read-only CLI
// print the same report; the report names members, grants, guests with
// expiry, links with remaining joins, pending one-time agent invite codes,
// agent identities and connections with state, and last activity — and never
// a token, secret or hash.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { GUEST_AGENT_TOKEN_PREFIX } from "../server/guest-agent-links.mjs";
import { accessReviewReport, assembleAccessReview, renderAccessReview, ACCESS_REVIEW_FORMAT } from "../server/access-review.mjs";

const execFileAsync = promisify(execFile);
const checkout = fileURLToPath(new URL("..", import.meta.url));
const script = join(checkout, "scripts/access-review.mjs");
const BANNED_KEYS = ["token", "hash", "secret", "password", "credential", "authorization"];

function deepKeys(value, out = []) {
  if (Array.isArray(value)) value.forEach(item => deepKeys(item, out));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { out.push(key); deepKeys(item, out); }
  return out;
}

// A room with every kind of access the review must name, plus one removed
// member that must be absent. The clock is controllable so expiry is testable.
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-access-review-")), filename = join(directory, "room.sqlite");
  let now = Date.now();
  const store = new RoomStore(filename, { now: () => now });
  store.initialize(initialRoom("commons"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  const ownerKey = store.issueAccessKey("commons", "owner");
  const accountKey = store.issueAccountAccessKey("account-owner");
  const ownerSession = store.createSession(ownerKey);
  const command = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  command(T.MESSAGE_POSTED, { messageId: randomUUID(), body: "Owner speaks" });
  // A human moderator with manage_members but who is not the owner.
  command(T.MEMBER_ADDED, { memberId: "moderator", displayName: "Moderator", kind: "human", permissions: ["manage_members", "steer"] });
  store.bindHumanAccount("commons", "moderator", "account-moderator");
  const moderatorKey = store.issueAccessKey("commons", "moderator");
  // A member that is added, then removed: it must not appear.
  command(T.MEMBER_ADDED, { memberId: "departed", displayName: "Departed", kind: "human", permissions: ["steer"] });
  command(T.MEMBER_ACCESS_CHANGED, { memberId: "departed", expectedMemberRevision: 0, permissions: ["steer"], active: false });
  // Share link with one of two joins used by a guest.
  const linkToken = randomBytes(32).toString("base64url");
  const link = store.shareLinks.create(ownerKey, "commons", { requestId: randomUUID(), linkToken, expiresAt: now + 3600000, maxJoins: 2, expectedMemberRevision: 0 }, null);
  const guestSlot = store.createAccountSessionSlot();
  const guestJoin = store.shareLinks.join(guestSlot.token, linkToken, { displayName: "Alice", redemptionId: randomUUID(),
    expectedSessionRevision: 0, expectedSessionBinding: guestSlot.session.sessionBinding });
  // Agent connection (owner-sponsored key).
  const agentToken = randomBytes(32).toString("base64url"), keyHash = createHash("sha256").update(agentToken).digest("hex");
  const connection = store.agentConnections.apply(ownerSession.token, "commons", { action: "create", requestId: randomUUID(), memberId: "agent-helper",
    displayName: "Helper", access: "contribute", keyHash, expiresAt: now + 86400000, expectedOwnerRevision: 0 }, ownerSession.session.sessionBinding);
  // Multi-room agent identity linked into the room.
  const identity = store.identities.create("Roaming agent");
  store.identities.link(ownerKey, "commons", { identityId: identity.identityId, permissions: ["accept_work"] });
  // Guest agent (2 h credential).
  const guestAgentToken = GUEST_AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const guestAgent = store.guestAgentLinks.mint(ownerKey, "commons", { requestId: randomUUID(), linkToken: guestAgentToken, expectedOwnerRevision: 0, displayName: "Scout" }, null);
  // One-time agent invite codes: one pending (1 h), one revoked that must be absent.
  const invite = store.invites.create(ownerKey, "commons", { profile: "chat", expiresInMinutes: 60, displayName: "Scribe" }, null);
  const revokedInvite = store.invites.create(ownerKey, "commons", { permissions: ["steer"] }, null);
  store.invites.revoke(ownerKey, "commons", revokedInvite.inviteId, null);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, headers = {}) => fetch(`${origin}${path}`, { headers: { Origin: origin, ...headers } })
    .then(async res => ({ status: res.status, headers: res.headers, json: await res.json().catch(() => null) }));
  const bearer = token => ({ Authorization: `Bearer ${token}` });
  return { store, filename, origin, ownerKey, accountKey, moderatorKey, linkToken, link, guestSlot, guestJoin, agentToken, keyHash, connection,
    identity, guestAgentToken, guestAgent, invite, revokedInvite, get, bearer, advance: ms => { now += ms; } };
}

// Signed-in owner session (account cookie + binding), mirroring a browser login.
async function ownerSession(origin, accountKey) {
  const bootstrap = await fetch(`${origin}/api/account-session`, { headers: { Origin: origin } });
  const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
  const { csrf, sessionRevision, sessionBinding } = await bootstrap.json();
  const login = await fetch(`${origin}/api/account-session`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
    body: JSON.stringify({ accountAccessKey: accountKey, expectedSessionRevision: sessionRevision }) });
  assert.equal(login.status, 201, "account login");
  const session = await login.json();
  // QA-Auth 2026-09-19: the account-key login rotates the slot (QAS-702) —
  // the pre-login cookie is dead; the response cookie carries the session.
  const freshCookie = login.headers.get("set-cookie").split(";", 1)[0];
  return { Cookie: freshCookie, "X-Project-Room-Auth": "account", "X-Session-Binding": session.sessionBinding ?? sessionBinding };
}

test("owner account session reads the full review; removed members are absent", async t => {
  const f = await fixture(t);
  const res = await f.get("/api/rooms/commons/access-review", await ownerSession(f.origin, f.accountKey));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const report = res.json;
  assert.equal(report.format, ACCESS_REVIEW_FORMAT);
  assert.equal(report.roomId, "commons");
  assert.equal(report.ownerId, "owner");
  assert.deepEqual(report.members.map(m => m.memberId).sort(), ["agent-helper", f.identity.identityId, "moderator", "owner"].sort());
  assert.ok(!JSON.stringify(report).includes("departed"), "a removed member is not in the review");
  const owner = report.members.find(m => m.memberId === "owner");
  assert.ok(owner.permissions.includes("manage_members"));
  assert.equal(owner.membershipOrigin, "bootstrap");
  assert.equal(owner.accountBound, true);
  assert.equal(owner.liveAccessKeys, 1);
  assert.ok(owner.lastActivityAt && !Number.isNaN(Date.parse(owner.lastActivityAt)), "owner activity is timestamped");
  assert.equal(report.members.find(m => m.memberId === "moderator").role, null);
  assert.equal(report.members.find(m => m.memberId === f.identity.identityId).identityId, f.identity.identityId);
  assert.deepEqual(report.guests.map(g => [g.displayName, g.kind, g.status]).sort(), [["Alice", "human", "active"], ["Scout", "agent", "active"]]);
  const alice = report.guests.find(g => g.displayName === "Alice");
  assert.equal(alice.memberId, f.guestJoin.session.member.id);
  assert.ok(alice.joinedAt && alice.expiresAt && Date.parse(alice.expiresAt) > Date.parse(alice.joinedAt));
  const scout = report.guests.find(g => g.displayName === "Scout");
  assert.ok(scout.joinedAt && Date.parse(scout.expiresAt) - Date.parse(scout.joinedAt) <= 2 * 3600000 + 1000, "guest agent bound to its 2 h credential");
  assert.ok(report.members.every(m => m.joinedAt), "every member has a join time");
  assert.deepEqual(alice.permissions, []);
  assert.equal(report.shareLinks.length, 1);
  assert.equal(report.shareLinks[0].id, f.link.link.id);
  assert.equal(report.shareLinks[0].joins, 1);
  assert.equal(report.shareLinks[0].remainingJoins, 1);
  assert.equal(report.shareLinks[0].status, "active");
  assert.equal(report.shareLinks[0].issuerMemberId, "owner");
  // Pending agent invite codes carry the hash-free handle, scope, inviter and
  // expiry; a revoked code is absent and the raw code never appears.
  assert.equal(report.pendingInvites.length, 1);
  const [pending] = report.pendingInvites;
  assert.equal(pending.inviteId, f.invite.inviteId);
  assert.match(pending.inviteId, /^[a-f0-9]{8}$/, "the handle is the short inviteId, not a full hash");
  assert.deepEqual(pending, { inviteId: f.invite.inviteId, displayName: "Scribe", permissions: f.invite.permissions, inviterMemberId: "owner",
    createdAt: new Date(f.invite.createdAt).toISOString(), expiresAt: new Date(f.invite.expiresAt).toISOString(), status: "active" });
  assert.equal(Date.parse(pending.expiresAt) - Date.parse(pending.createdAt), 3600000);
  assert.ok(!JSON.stringify(report).includes(f.revokedInvite.inviteId), "a revoked invite code is not pending");
  assert.ok(!JSON.stringify(report).includes(f.invite.code), "the raw invite code never appears");
  assert.deepEqual(report.agentIdentities.map(i => [i.identityId, i.memberId, i.memberActive]), [[f.identity.identityId, f.identity.identityId, true]]);
  assert.equal(report.agentConnections.length, 1);
  assert.equal(report.agentConnections[0].memberId, "agent-helper");
  assert.equal(report.agentConnections[0].status, "key_issued");
  assert.equal(report.agentConnections[0].sponsorMemberId, "owner");
  assert.deepEqual(report.agentConnections[0].permissions, ["accept_work", "complete_work"]);
  assert.deepEqual(report.counts, { members: 4, guests: 2, shareLinks: 1, pendingInvites: 1, agentIdentities: 1, agentConnections: 1, membershipDelegations: 0 });
  assert.equal(report.lastActivityAt, [...report.members, ...report.guests].map(m => m.lastActivityAt).filter(Boolean).sort().at(-1));
  // The owner's room key (CLI path) reads the same report.
  const viaKey = await f.get("/api/rooms/commons/access-review", f.bearer(f.ownerKey));
  assert.equal(viaKey.status, 200);
  assert.deepEqual({ ...viaKey.json, generatedAt: null }, { ...report, generatedAt: null });
});

test("the review contains no token, secret or hash fields or values", async t => {
  const f = await fixture(t);
  const res = await f.get("/api/rooms/commons/access-review", f.bearer(f.ownerKey));
  assert.equal(res.status, 200);
  assert.equal(res.json.pendingInvites.length, 1, "the pending-invites section is present and covered by the sweep");
  const keys = deepKeys(res.json).map(key => key.toLowerCase());
  for (const banned of BANNED_KEYS) assert.ok(!keys.some(key => key.includes(banned)), `no ${banned}-like key; saw ${keys.filter(key => key.includes(banned))}`);
  const serialized = JSON.stringify(res.json) + renderAccessReview(res.json);
  const hash = value => createHash("sha256").update(value).digest("hex");
  for (const secret of [f.ownerKey, f.accountKey, f.moderatorKey, f.linkToken, hash(f.linkToken), f.agentToken, f.keyHash, f.identity.secret, hash(f.identity.secret),
    f.guestAgentToken, hash(f.guestAgentToken), f.guestSlot.token, f.guestJoin.session.sessionBinding, f.guestJoin.session.csrf,
    f.invite.code, hash(f.invite.code), f.revokedInvite.code, hash(f.revokedInvite.code)]) {
    assert.ok(!serialized.includes(secret), "review never carries a credential, hash or binding");
  }
  assert.ok(!/[a-f0-9]{64}/.test(serialized), "no 64-hex digest anywhere in the review");
});

test("non-owners are refused: agent key, manage_members human, guest session, anonymous", async t => {
  const f = await fixture(t);
  const agent = await f.get("/api/rooms/commons/access-review", f.bearer(f.agentToken));
  assert.equal(agent.status, 403); assert.equal(agent.json.error.code, "owner_required");
  const moderator = await f.get("/api/rooms/commons/access-review", f.bearer(f.moderatorKey));
  assert.equal(moderator.status, 403); assert.equal(moderator.json.error.code, "owner_required");
  const identity = await f.get("/api/rooms/commons/access-review", f.bearer(f.identity.secret));
  assert.equal(identity.status, 403);
  const guestAgent = await f.get("/api/rooms/commons/access-review", f.bearer(f.guestAgentToken));
  assert.equal(guestAgent.status, 403);
  assert.throws(() => accessReviewReport(f.store, f.guestSlot.token, "commons", f.guestJoin.session.sessionBinding), { status: 403, code: "owner_required" });
  const anonymous = await f.get("/api/rooms/commons/access-review");
  assert.equal(anonymous.status, 401);
  const stale = await f.get("/api/rooms/commons/access-review", { ...f.bearer(f.ownerKey), "X-Session-Binding": "0".repeat(64) });
  assert.equal(stale.status, 409, "a mismatched fence is refused like every room read");
  // Refusals include the operation id and category, but no report fragment.
  assert.equal(moderator.json.category, "access");
  assert.ok(!("members" in moderator.json));
});

test("expired guests, guest agents and links are shown as expired", async t => {
  const f = await fixture(t);
  f.advance(9 * 3600000); // past the 8 h guest key, the 2 h guest invite and the 1 h link
  const report = assembleAccessReview(f.store, "commons");
  assert.deepEqual(report.guests.map(g => [g.displayName, g.status]).sort(), [["Alice", "expired"], ["Scout", "expired"]]);
  for (const guest of report.guests) assert.ok(Date.parse(guest.expiresAt) <= Date.parse(report.generatedAt));
  assert.equal(report.shareLinks[0].status, "expired");
  assert.equal(report.shareLinks[0].remainingJoins, 1, "remaining joins are still reported for the record");
  assert.deepEqual(report.pendingInvites.map(i => [i.inviteId, i.status]), [[f.invite.inviteId, "expired"]], "an unredeemed code that lapsed stays on record as expired");
  assert.equal(report.agentConnections[0].status, "key_issued", "a 24 h connection is still live");
  assert.equal(report.members.find(m => m.memberId === "owner").liveAccessKeys, 1, "a seven-day owner key is still live");
  const text = renderAccessReview(report);
  assert.match(text, /Alice {2}human {2}expired/);
  assert.match(text, /Scout {2}agent {2}expired/);
  assert.match(text, /Share links \(1\):\n {2}\S+ {2}expired {2}joins 1\/2 \(1 remaining\)/);
  assert.match(text, new RegExp(`Pending agent invites \\(1\\):\\n {2}${f.invite.inviteId} {2}Scribe {2}expired {2}grants: `));
});

test("the script prints the route's report from the store file and from a running service", async t => {
  const f = await fixture(t);
  const route = await f.get("/api/rooms/commons/access-review", f.bearer(f.ownerKey));
  assert.equal(route.status, 200);
  const strip = report => ({ ...report, generatedAt: null });
  const run = (args, env = {}) => execFileAsync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 30000, cwd: checkout,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ROOM_"))), ...env } })
    .then(({ stdout, stderr }) => ({ status: 0, stdout, stderr }), error => ({ status: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) }));
  const fromStore = await run(["--db", f.filename, "--room", "commons", "--json"]);
  assert.equal(fromStore.status, 0, fromStore.stderr);
  assert.deepEqual(strip(JSON.parse(fromStore.stdout)), strip(route.json));
  const allRooms = await run(["--json"], { ROOM_DB: f.filename });
  assert.equal(allRooms.status, 0, allRooms.stderr);
  assert.deepEqual(JSON.parse(allRooms.stdout).map(report => report.roomId), ["commons"]);
  const fromService = await run(["--origin", f.origin, "--room", "commons", "--json", "--key-env", "REVIEW_OWNER_KEY"], { REVIEW_OWNER_KEY: f.ownerKey });
  assert.equal(fromService.status, 0, fromService.stderr);
  assert.deepEqual(strip(JSON.parse(fromService.stdout)), strip(route.json));
  const text = await run(["--db", f.filename, "--room", "commons"]);
  assert.equal(text.status, 0, text.stderr);
  const sameClock = output => output.replace(/generated \S+;/, "generated <now>;");
  assert.equal(sameClock(text.stdout), sameClock(renderAccessReview(JSON.parse(fromStore.stdout))));
  assert.match(text.stdout, /^Room commons — /);
  assert.match(text.stdout, /Guests \(2\):/);
  assert.match(text.stdout, new RegExp(`Pending agent invites \\(1\\):\\n {2}${f.invite.inviteId} {2}Scribe {2}active {2}grants: .*issued by owner`));
  for (const output of [fromStore, allRooms, fromService, text]) {
    for (const secret of [f.ownerKey, f.linkToken, f.agentToken, f.keyHash, f.identity.secret, f.guestAgentToken, f.invite.code, f.revokedInvite.code]) assert.ok(!output.stdout.includes(secret));
  }
  // Credentials come from the named variable only, and are never echoed.
  const missing = await run(["--origin", f.origin, "--room", "commons"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Set ROOM_OWNER_KEY/);
  assert.equal(missing.stdout, "");
  const wrong = await run(["--origin", f.origin, "--room", "commons"], { ROOM_OWNER_KEY: f.moderatorKey });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /403 owner_required/);
  assert.ok(!wrong.stderr.includes(f.moderatorKey));
  const both = await run(["--db", f.filename, "--origin", f.origin, "--room", "commons"]);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /not both/);
  const help = await run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--key-env NAME/);
});

test("the review shares the per-credential read allowance with sibling room reads", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 600; i += 100) {
    const statuses = await Promise.all(Array.from({ length: 100 }, () => f.get("/api/rooms/commons/presence", f.bearer(f.ownerKey)).then(r => r.status)));
    assert.ok(statuses.every(status => status === 200), `batch ${i}: ${statuses.join(",")}`);
  }
  const limited = await f.get("/api/rooms/commons/access-review", f.bearer(f.ownerKey));
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, "rate_limited");
  assert.equal(limited.headers.get("x-ratelimit-limit"), "600");
  assert.equal(limited.headers.get("retry-after"), "60");
});

test("the review command records one revoke that removes both administration stores", async t => {
  const f = await fixture(t);
  const identityId = f.identity.identityId;
  const member = f.store.room("commons").state.members[identityId];
  f.store.command(f.ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: {
    memberId: identityId, expectedMemberRevision: member.revision,
    permissions: [...member.permissions, "manage_members"], active: true
  } });
  f.store.delegation.grant(f.ownerKey, "commons", { identityId });
  const run = (args, env = {}) => execFileAsync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 30000, cwd: checkout,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ROOM_"))), ...env } })
    .then(({ stdout, stderr }) => ({ status: 0, stdout, stderr }), error => ({ status: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) }));
  const cleared = await run(["--db", f.filename, "--room", "commons", "--revoke-identity", identityId, "--json", "--key-env", "REVIEW_OWNER_KEY"], { REVIEW_OWNER_KEY: f.ownerKey });
  assert.equal(cleared.status, 0, cleared.stderr);
  const report = JSON.parse(cleared.stdout);
  const row = report.members.find(item => item.memberId === identityId);
  assert.equal(row.delegatedAdmin, false);
  assert.equal(row.dualGrantHazard, false);
  assert.deepEqual(row.authorityPaths, []);
  assert.equal(report.membershipDelegations.length, 0);
  assert.ok(!cleared.stdout.includes(f.ownerKey));
  assert.ok(!cleared.stderr.includes(f.ownerKey));
  const viaOrigin = await run(["--origin", f.origin, "--room", "commons", "--revoke-identity", identityId], { ROOM_OWNER_KEY: f.ownerKey });
  assert.equal(viaOrigin.status, 1);
  assert.match(viaOrigin.stderr, /--db/);
  assert.ok(!viaOrigin.stderr.includes(f.ownerKey));
});

test("a review of one identity shows both administration stores, and one revoke removes the effective permission", async t => {
  const f = await fixture(t);
  const identityId = f.identity.identityId;
  const member = f.store.room("commons").state.members[identityId];
  f.store.command(f.ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: {
    memberId: identityId, expectedMemberRevision: member.revision,
    permissions: [...member.permissions, "manage_members"], active: true
  } });
  f.store.delegation.grant(f.ownerKey, "commons", { identityId });
  const before = assembleAccessReview(f.store, "commons");
  const row = before.members.find(item => item.memberId === identityId);
  const identity = before.agentIdentities.find(item => item.identityId === identityId);
  const grant = before.membershipDelegations.find(item => item.identityId === identityId);
  assert.equal(row.delegatedAdmin, true);
  assert.deepEqual(row.authorityPaths, ["delegated_admin", "membership_delegation"]);
  assert.equal(row.dualGrantHazard, true);
  assert.deepEqual(identity.authorityPaths, row.authorityPaths);
  assert.equal(grant.memberId, identityId);
  assert.equal(grant.grantedBy, "owner");
  assert.equal(grant.dualGrantHazard, true);
  assert.match(renderAccessReview(before), /\[DUAL-GRANT HAZARD\]/);
  const cleared = f.store.delegation.revokeEffective(f.ownerKey, "commons", { identityId });
  assert.deepEqual(cleared, { roomId: "commons", identityId, revokedGrant: true, strippedAdmin: true });
  const after = assembleAccessReview(f.store, "commons");
  const next = after.members.find(item => item.memberId === identityId);
  assert.equal(next.delegatedAdmin, false);
  assert.equal(next.dualGrantHazard, false);
  assert.deepEqual(next.authorityPaths, []);
  assert.equal(after.membershipDelegations.length, 0);
  assert.equal(f.store.delegation.canAdministerMembership(
    f.store.roomAuthority("commons"),
    { member: { id: identityId, identityId, permissions: next.permissions } },
    "commons"
  ), false);
  assert.throws(() => f.store.delegation.revokeEffective(f.ownerKey, "commons", { identityId }), /No membership-administration authority/);
});
