// Contract tests: signed agent-carried referral invites.
//
// What this covers and why: the referral invite flow is a new admission path
// (mint/redeem/preview/list) with three invariants no existing test can
// catch: (1) the Ed25519 token actually gates redemption — a forged,
// tampered, or expired token must not admit anyone; (2) the depth cap binds
// both mint and redeem; (3) the inviter is invisible on every invitee-facing
// surface but visible in the owner audit. Existing invite/guest/access-request
// tests cover the older code paths, not these routes, this token format, or
// this ledger — so a regression here (signature check dropped, expiry check
// dropped, permissions widened, inviter leaked) would pass the whole suite
// except this file.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { demoteToReadonly } from "../server/autonomy-tiers.mjs";
import { solveIdentityMintProof } from "../server/agent-identities.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

async function serve(t, ownerId = "owner") {
  const directory = mkdtempSync(join(tmpdir(), "project-room-referral-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons", ownerId));
  const ownerKey = store.issueAccessKey("commons", ownerId);
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

// An agent member with work permissions, so the referral flow can prove it
// lands strangers at the lower tier regardless of the inviter's own power.
async function enrollInviter(store, origin, ownerKey, displayName = "Inviter") {
  const created = await post(origin, "/api/agent-identities", { displayName });
  assert.equal(created.status, 201);
  store.identities.link(ownerKey, "commons", {
    identityId: created.json.identityId, displayName,
    permissions: ["steer", "accept_work", "complete_work", "verify", "invite_member"],
  });
  return { identityId: created.json.identityId, secret: created.json.secret };
}

// Craft a genuinely-signed token with arbitrary claims (expiry/depth), using
// the room's real signing key — the same crypto path a past mint would have
// taken. The ledger row is inserted to match, status minted.
function craftToken(store, { jti = randomUUID(), chainId = randomUUID(), roomId = "commons",
    inviter, depth = 0, maxDepth = 6, issuedAt = store.now() - 1000, expiresAt = store.now() + 7 * 86400000 }) {
  const keyRow = store.db.prepare("SELECT private_seed FROM referral_invite_keys WHERE room_id = ?").get(roomId);
  assert.ok(keyRow, "room key must exist (mint once first)");
  const token = store.referralInvites.signToken(
    { v: 1, jti, chainId, roomId, depth, maxDepth, issuedAt, expiresAt, tier: "chat" },
    Buffer.from(keyRow.private_seed, "base64"));
  store.db.prepare(
    `INSERT INTO referral_invites (jti, room_id, chain_id, inviter_member_id, depth, max_depth, created_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'minted')`
  ).run(jti, roomId, chainId, inviter, depth, maxDepth, issuedAt, expiresAt);
  return { token, jti, chainId };
}

function grantInvite(store, ownerKey, memberId) {
  const member = store.room("commons").state.members[memberId];
  const permissions = [...new Set([...(member.permissions ?? []), "invite_member"])];
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: {
    memberId, expectedMemberRevision: member.revision, permissions, active: true,
  } });
}

test("happy path: mint, preview, redeem lands a read+chat stranger; chain continues one deeper", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);

  const minted = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, inviter.secret);
  assert.equal(minted.status, 201);
  assert.match(minted.json.token, /^ref1\./);
  assert.equal(minted.json.depth, 0);
  assert.equal(minted.json.maxDepth, 6);
  assert.deepEqual(minted.json.grantedPermissions, []);
  assert.ok(minted.json.chainId);

  const previewed = await post(origin, "/api/referral-invites/preview", { token: minted.json.token });
  assert.equal(previewed.status, 200);
  assert.equal(previewed.json.roomId, "commons");
  assert.equal(previewed.json.depth, 0);
  assert.deepEqual(previewed.json.grantedPermissions, []);
  assert.ok(!/inviter/i.test(JSON.stringify(previewed.json)), "preview must not name the inviter");

  const redeemed = await post(origin, "/api/referral-invites/redeem", { token: minted.json.token, displayName: "Stranger" });
  assert.equal(redeemed.status, 201);
  assert.deepEqual(redeemed.json.permissions, []);
  assert.equal(redeemed.json.depth, 0);
  assert.equal(redeemed.json.chainId, minted.json.chainId);
  assert.ok(redeemed.json.secret);

  // The member record is the fixed chat profile with no referral metadata.
  const member = store.room("commons").state.members[redeemed.json.memberId];
  assert.ok(member, "stranger is a room member");
  assert.deepEqual(member.permissions, []);
  assert.ok(!("referredBy" in member), "member record must not carry the inviter");

  // The chain continues once the stranger can invite: they mint at depth 1.
  grantInvite(store, ownerKey, redeemed.json.memberId);
  const second = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, redeemed.json.secret);
  assert.equal(second.status, 201);
  assert.equal(second.json.depth, 1);
  assert.equal(second.json.chainId, minted.json.chainId);

  // A used token is single-use.
  const replay = await post(origin, "/api/referral-invites/redeem", { token: minted.json.token, displayName: "Replay" });
  assert.equal(replay.status, 404);
});

test("expired token is rejected and journaled", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);
  const seed = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, inviter.secret);
  assert.equal(seed.status, 201);
  const past = store.now();
  const { token } = craftToken(store, { inviter: inviter.identityId,
    issuedAt: past - 8 * 86400000, expiresAt: past - 86400000 });

  const previewed = await post(origin, "/api/referral-invites/preview", { token });
  assert.equal(previewed.status, 410);
  const redeemed = await post(origin, "/api/referral-invites/redeem", { token, displayName: "Late" });
  assert.equal(redeemed.status, 410);
  assert.equal(redeemed.json.error.code, "invite_expired");

  const audit = await get(origin, "/api/rooms/commons/referral-invites", ownerKey);
  const row = audit.json.invites.find(r => r.rejectReason === "expired");
  assert.ok(row, "expiry rejection is journaled for the owner");
  assert.equal(row.status, "rejected");
  assert.equal(row.inviterMemberId, inviter.identityId);
});

test("depth cap binds mint and redeem; cap rejections are journaled", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);

  // maxDepth 1: inviter (depth -1) mints depth 0 fine...
  const first = await post(origin, "/api/referral-invites/mint", { roomId: "commons", maxDepth: 1 }, inviter.secret);
  assert.equal(first.status, 201);
  assert.equal(first.json.depth, 0);
  const redeemed = await post(origin, "/api/referral-invites/redeem", { token: first.json.token, displayName: "DepthZero" });
  assert.equal(redeemed.status, 201);

  // ...the depth-0 member, once they can invite, mints depth 1 (the cap is inclusive)...
  grantInvite(store, ownerKey, redeemed.json.memberId);
  const last = await post(origin, "/api/referral-invites/mint", { roomId: "commons", maxDepth: 1 }, redeemed.json.secret);
  assert.equal(last.status, 201);
  assert.equal(last.json.depth, 1);
  const deep = await post(origin, "/api/referral-invites/redeem", { token: last.json.token, displayName: "DepthOne" });
  assert.equal(deep.status, 201);

  // ...but the depth-1 member is AT the cap: minting fails and is journaled.
  grantInvite(store, ownerKey, deep.json.memberId);
  const capped = await post(origin, "/api/referral-invites/mint", { roomId: "commons", maxDepth: 1 }, deep.json.secret);
  assert.equal(capped.status, 409);
  assert.equal(capped.json.error.code, "referral_depth_exceeded");

  // A signed token claiming depth past the cap does not redeem.
  const { token } = craftToken(store, { inviter: inviter.identityId, depth: 3, maxDepth: 1 });
  const over = await post(origin, "/api/referral-invites/redeem", { token, displayName: "TooDeep" });
  assert.equal(over.status, 409);
  assert.equal(over.json.error.code, "referral_depth_exceeded");

  const audit = await get(origin, "/api/rooms/commons/referral-invites", ownerKey);
  const reasons = audit.json.invites.filter(r => r.rejectReason === "depth_exceeded");
  assert.ok(reasons.length >= 2, "mint-cap and redeem-cap rejections are both journaled");
});

test("descendants cannot raise an inherited chain cap", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);
  const first = await post(origin, "/api/referral-invites/mint", { roomId: "commons", maxDepth: 1 }, inviter.secret);
  const zero = await post(origin, "/api/referral-invites/redeem", { token: first.json.token, displayName: "Depth zero" });
  grantInvite(store, ownerKey, zero.json.memberId);
  const second = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, zero.json.secret);
  assert.equal(second.status, 201);
  assert.equal(second.json.maxDepth, 1, "unspecified descendant cap inherits the original");
  const one = await post(origin, "/api/referral-invites/redeem", { token: second.json.token, displayName: "Depth one" });
  grantInvite(store, ownerKey, one.json.memberId);
  const raised = await post(origin, "/api/referral-invites/mint", { roomId: "commons", maxDepth: 12 }, one.json.secret);
  assert.equal(raised.status, 409);
  assert.equal(raised.json.error.code, "referral_depth_exceeded");
  const defaultAtCap = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, one.json.secret);
  assert.equal(defaultAtCap.status, 409);
  const rows = store.db.prepare("SELECT max_depth FROM referral_chain_members WHERE room_id = ? ORDER BY depth").all("commons");
  assert.deepEqual(rows.map(r => r.max_depth), [1, 1]);
});

test("preview refuses a consumed token and a removed inviter", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);
  const first = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, inviter.secret);
  assert.equal((await post(origin, "/api/referral-invites/preview", { token: first.json.token })).status, 200);
  assert.equal((await post(origin, "/api/referral-invites/redeem", { token: first.json.token })).status, 201);
  const consumed = await post(origin, "/api/referral-invites/preview", { token: first.json.token });
  assert.equal(consumed.status, 404);
  const second = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, inviter.secret);
  store.db.prepare("UPDATE rooms SET projection = ?, sequence = sequence + 1 WHERE id = 'commons'").run(
    JSON.stringify({ ...store.room("commons").state,
      members: { ...store.room("commons").state.members,
        [inviter.identityId]: { ...store.room("commons").state.members[inviter.identityId], active: false } } }));
  const removed = await post(origin, "/api/referral-invites/preview", { token: second.json.token });
  assert.equal(removed.status, 404);
});

test("tampered and forged tokens are indistinguishable from unknown ones", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);
  const minted = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, inviter.secret);
  const [prefix, body, sig] = minted.json.token.split(".");

  // Flip a character to a guaranteed-different one. For the body the signature
  // covers the raw string, so flipping the last char is enough; for the
  // signature the last char's low bits are unused by base64url decoding
  // (64-byte Ed25519 sig = 86 chars), so flip the FIRST char instead —
  // flipping unused bits decodes to the identical signature and the
  // "tampered" token stays valid (flaky 200).
  const flipLast = s => s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
  const flipFirst = s => (s.startsWith("A") ? "B" : "A") + s.slice(1);
  const tamperedBody = `${prefix}.${flipLast(body)}.${sig}`;
  const tamperedSig = `${prefix}.${body}.${flipFirst(sig)}`;
  for (const bad of [tamperedBody, tamperedSig, "bogus.token.here", "ref1.onlyonepart", minted.json.token.slice(0, 20)]) {
    const previewed = await post(origin, "/api/referral-invites/preview", { token: bad });
    assert.equal(previewed.status, 404, `preview of ${bad.slice(0, 12)}...`);
    const redeemed = await post(origin, "/api/referral-invites/redeem", { token: bad, displayName: "Forge" });
    assert.equal(redeemed.status, 404, `redeem of ${bad.slice(0, 12)}...`);
    assert.equal(redeemed.json.error.code, "invite_unavailable");
  }
  // A well-formed token naming a room the server never minted for: the
  // signature cannot verify (no key), so it is 404 — and verification must
  // not have created key material for the forged room.
  const forgedRoom = `${prefix}.${Buffer.from(JSON.stringify({ v: 1, jti: randomUUID(), chainId: randomUUID(), roomId: "nope", depth: 0, maxDepth: 6, issuedAt: Date.now(), expiresAt: Date.now() + 1000, tier: "chat" })).toString("base64url")}.${sig}`;
  const forged = await post(origin, "/api/referral-invites/redeem", { token: forgedRoom, displayName: "Forge" });
  assert.equal(forged.status, 404);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM referral_invite_keys WHERE room_id = 'nope'").get().n, 0);
});

test("inviter is hidden from every invitee surface; owner audit sees the chain", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);
  const minted = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, inviter.secret);
  const previewed = await post(origin, "/api/referral-invites/preview", { token: minted.json.token });
  const redeemed = await post(origin, "/api/referral-invites/redeem", { token: minted.json.token, displayName: "Shy" });

  // The inviter's actual identifiers (id, display name) appear on no
  // invitee-facing surface — preview, mint/redeem responses, member record,
  // or stored event.
  for (const surface of [minted.json, previewed.json, redeemed.json]) {
    const text = JSON.stringify(surface);
    assert.ok(!text.includes(inviter.identityId), "invitee surface must not carry the inviter id");
    assert.ok(!text.includes("Inviter"), "invitee surface must not carry the inviter name");
  }
  // The stored room event carries no referral metadata either.
  const events = store.db.prepare("SELECT body FROM events WHERE room_id = ? ORDER BY sequence DESC LIMIT 5").all("commons")
    .map(r => JSON.parse(r.body));
  const added = events.find(e => e.type === "member.added" && e.data.memberId === redeemed.json.memberId);
  assert.ok(added, "member.added event stored");
  assert.ok(!("referredBy" in added.data), "event must not carry the inviter");
  assert.equal(added.data.admission, "referral-invite");
  assert.ok(!JSON.stringify(added).includes(inviter.identityId), "event must not name the inviter anywhere");

  // The member-visible referral board learned nothing about this join.
  const board = await get(origin, "/api/rooms/commons/referrals", redeemed.json.secret);
  assert.equal(board.status, 200);
  assert.ok(!JSON.stringify(board.json).includes(redeemed.json.memberId), "referral board must not attribute the join");

  // The owner audit sees the whole chain.
  const audit = await get(origin, "/api/rooms/commons/referral-invites", ownerKey);
  assert.equal(audit.status, 200);
  const row = audit.json.invites.find(r => r.status === "redeemed");
  assert.ok(row, "redemption is journaled");
  assert.equal(row.inviterMemberId, inviter.identityId);
  assert.equal(row.inviterDisplayName, "Inviter");
  assert.equal(row.redeemedMemberId, redeemed.json.memberId);
  assert.equal(row.chainId, minted.json.chainId);

  // A non-owner member gets nothing.
  const denied = await get(origin, "/api/rooms/commons/referral-invites", redeemed.json.secret);
  assert.equal(denied.status, 403);
});

test("mint requires room membership; removed inviter's tokens die", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const outsiderCreated = await post(origin, "/api/agent-identities", { displayName: "Outsider" });
  const denied = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, outsiderCreated.json.secret);
  // An identity with no room membership cannot authenticate into the room at
  // all — the mint is refused before membership is even evaluated.
  assert.equal(denied.status, 401);

  const inviter = await enrollInviter(store, origin, ownerKey);
  const minted = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, inviter.secret);
  assert.equal(minted.status, 201);

  // The owner removes the inviter; the outstanding token stops working.
  store.db.prepare("UPDATE rooms SET projection = ?, sequence = sequence + 1 WHERE id = 'commons'").run(
    JSON.stringify({ ...store.room("commons").state,
      members: { ...store.room("commons").state.members, [inviter.identityId]: { ...store.room("commons").state.members[inviter.identityId], active: false } } }));
  const dead = await post(origin, "/api/referral-invites/redeem", { token: minted.json.token, displayName: "Ghost" });
  assert.equal(dead.status, 410);
});

test("the flow makes no outbound network calls", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);
  const realFetch = globalThis.fetch;
  const attempted = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (!target.startsWith(origin)) { attempted.push(target); throw new Error(`outbound blocked: ${target}`); }
    return realFetch(url, init);
  };
  try {
    const minted = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, inviter.secret);
    assert.equal(minted.status, 201);
    const previewed = await post(origin, "/api/referral-invites/preview", { token: minted.json.token });
    assert.equal(previewed.status, 200);
    const redeemed = await post(origin, "/api/referral-invites/redeem", { token: minted.json.token, displayName: "Offline" });
    assert.equal(redeemed.status, 201);
    const audit = await get(origin, "/api/rooms/commons/referral-invites", ownerKey);
    assert.equal(audit.status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(attempted, [], "no outbound fetch may happen during the referral flow");
});

test("existing invite-code redemption still works alongside referral invites", async t => {
  const { origin, ownerKey } = await serve(t);
  // Owner mints a classic one-time agent invite code through the room route.
  const created = await post(origin, "/api/rooms/commons/agent-invites", { profile: "chat" }, ownerKey);
  assert.equal(created.status, 201);
  const redeemed = await post(origin, "/api/agent-invites/redeem", { code: created.json.code, displayName: "Classic" });
  assert.equal(redeemed.status, 201);
  assert.deepEqual(redeemed.json.permissions, []);
});

// Instinct's #996-family finding: POST /api/referral-invites/mint signs and
// inserts ledger rows directly (no store.command), so a demoted t1_readonly
// agent could mint signed invite tokens. Minting is a membership write and
// must refuse t1 callers. A member without invite rights is refused too.
// t2 agents who can invite, a human granted invite_member, and the owner pass.
test("tier gate: t1_readonly agents cannot mint referral invites; t2, humans, and the owner can", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const t2 = await enrollInviter(store, origin, ownerKey, "Inviter");
  const t1 = await enrollInviter(store, origin, ownerKey, "Inviter Two");
  demoteToReadonly(store.db, "commons", t1.identityId, { updatedBy: "owner" });
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "human1", displayName: "Human One", kind: "human", permissions: [] } });
  const humanKey = store.issueAccessKey("commons", "human1");

  const refused = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, t1.secret);
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, "agent_readonly");

  const okT2 = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, t2.secret);
  assert.equal(okT2.status, 201);
  const refusedHuman = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, humanKey);
  assert.equal(refusedHuman.status, 403);
  assert.equal(refusedHuman.json.error.code, "invite_not_permitted");
  assert.equal(refusedHuman.json.reason, "invite_not_permitted");
  assert.ok(Array.isArray(refusedHuman.json.next));
  grantInvite(store, ownerKey, "human1");
  const okHuman = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, humanKey);
  assert.equal(okHuman.status, 201);
  const okOwner = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, ownerKey);
  assert.equal(okOwner.status, 201);
});

test("redeem rejects missing and inherited ledger inviters without admitting anyone", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const seed = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, ownerKey);
  assert.equal(seed.status, 201);
  const before = store.room("commons");
  const count = table => store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  const tables = ["agent_identities", "identity_links", "referral_chain_members"];
  const counts = tables.map(count);
  for (const inviter of ["toString", "missing-inviter"]) {
    // A malformed trusted ledger fixture, not a remotely forgeable token.
    const crafted = craftToken(store, { inviter });
    const redeemed = await post(origin, "/api/referral-invites/redeem", { token: crafted.token, displayName: "Nobody" });
    assert.equal(redeemed.status, 410);
    assert.equal(redeemed.json?.error?.code, "invite_expired");
    assert.equal(JSON.stringify(redeemed.json).includes(inviter), false);
    assert.equal(JSON.stringify(redeemed.json).includes(crafted.token), false);
    assert.deepEqual(tables.map(count), counts);
    assert.deepEqual(store.room("commons"), before);
    assert.deepEqual({ ...store.db.prepare("SELECT status,reject_reason,redeemed_member_id,redeemed_identity_id FROM referral_invites WHERE jti=?").get(crafted.jti) },
      { status: "rejected", reject_reason: "inviter_inactive", redeemed_member_id: null, redeemed_identity_id: null });
  }
});

test("an actual enrolled toString inviter retains private referral admission authority", async t => {
  const { store, origin, ownerKey } = await serve(t, "toString");
  const minted = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, ownerKey);
  assert.equal(minted.status, 201);
  const preview = await post(origin, "/api/referral-invites/preview", { token: minted.json.token });
  assert.equal(preview.status, 200);
  const joined = await post(origin, "/api/referral-invites/redeem", { token: minted.json.token, displayName: "Real invitee" });
  assert.equal(joined.status, 201);
  assert.deepEqual(joined.json.permissions, []);
  assert.equal(store.room("commons").state.members[joined.json.memberId].active, true);
  assert.equal(JSON.stringify(preview.json).includes("toString"), false);
  assert.equal(JSON.stringify(joined.json).includes("toString"), false);
});

test("guest members cannot mint referral invites", async t => {
  const { store, origin, ownerKey } = await serve(t);
  // Faithful guest fixture through the real GX guest-invite redeem path:
  // the member id carries the guest-agent- prefix exactly as production
  // guest admission produces.
  const minted = await post(origin, "/api/rooms/commons/guest-invites", {
    requestId: randomUUID(), guestLabel: "Guest visit", expectedOwnerRevision: 0,
  }, ownerKey);
  assert.equal(minted.status, 201);
  const identity = store.identities.create("Guest Visitor");
  const keys = generateKeyPair();
  const cardBody = { name: "Guest Visitor", description: "visiting agent", capabilities: ["chat"] };
  const redeemed = await post(origin, "/api/guest-invites/redeem", {
    inviteCode: minted.json.code,
    card: { ...cardBody, publicKey: keys.publicKey,
      signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) },
  }, identity.secret);
  assert.equal(redeemed.status, 201);
  const guest = redeemed.json;
  assert.ok(guest.token.startsWith("ga1."), "guest credential is a guest-agent bearer");
  assert.ok(guest.member.id.startsWith("guest-agent-"), "member id carries the guest prefix");
  assert.equal(store.room("commons").state.members[guest.member.id].active, true);

  const attempt = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, guest.token);
  assert.equal(attempt.status, 403);
  assert.equal(attempt.json?.error?.code, "invite_not_permitted");
  assert.equal(attempt.json?.reason, "invite_not_permitted");
  assert.ok(Array.isArray(attempt.json?.next));
  // The owner audit ledger must not record a minted token for the guest.
  assert.equal(store.db.prepare(
    "SELECT count(*) n FROM referral_invites WHERE inviter_member_id = ? AND status = 'minted'"
  ).get(guest.member.id).n, 0);
});

test("a chat member keeps their referral board and cannot mint until they can invite", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const minted = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, ownerKey);
  const redeemed = await post(origin, "/api/referral-invites/redeem", { token: minted.json.token, displayName: "Chat Member" });
  assert.equal(redeemed.status, 201);
  const board = await get(origin, "/api/rooms/commons/referrals", redeemed.json.secret);
  assert.equal(board.status, 200);
  const refused = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, redeemed.json.secret);
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, "invite_not_permitted");
  assert.equal(store.db.prepare("SELECT count(*) n FROM referral_invites WHERE inviter_member_id=?").get(redeemed.json.memberId).n, 0);
});

test("a new referral redeem shares the anonymous identity mint limiter", async t => {
  const { origin, ownerKey } = await serve(t);
  for (let i = 0; i < 8; i++) {
    const minted = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, ownerKey);
    assert.equal(minted.status, 201, `mint ${i}`);
    const redeemed = await post(origin, "/api/referral-invites/redeem", { token: minted.json.token, displayName: `Free ${i}` });
    assert.equal(redeemed.status, 201, `redeem ${i}`);
    assert.equal(typeof redeemed.json.secret, "string");
  }
  const ninth = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, ownerKey);
  const withoutProof = await post(origin, "/api/referral-invites/redeem", { token: ninth.json.token, displayName: "Needs proof" });
  assert.equal(withoutProof.status, 428);
  assert.equal(withoutProof.json.error.code, "proof_required");
  const proof = solveIdentityMintProof("Needs proof");
  const limited = await fetch(`${origin}/api/referral-invites/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ token: ninth.json.token, displayName: "Needs proof", proof }),
  });
  const limitedBody = await limited.json();
  assert.equal(limited.status, 429);
  assert.equal(limitedBody.error.code, "identity_mint_limited");
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(ninth.json.token.length > 0, true);
});

test("a referral redeem attaches an existing identity instead of minting another", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const existing = store.identities.create("Already Here");
  const before = store.db.prepare("SELECT count(*) n FROM agent_identities").get().n;
  const minted = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, ownerKey);
  const attached = await post(origin, "/api/referral-invites/redeem", { token: minted.json.token }, existing.secret);
  assert.equal(attached.status, 201);
  assert.equal(attached.json.attached, true);
  assert.equal(attached.json.secret, undefined);
  assert.equal(attached.json.memberId, existing.identityId);
  assert.equal(store.db.prepare("SELECT count(*) n FROM agent_identities").get().n, before);
  assert.equal(store.room("commons").state.members[existing.identityId].displayName, "Already Here");

  const again = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, ownerKey);
  const bad = await post(origin, "/api/referral-invites/redeem", { token: again.json.token, displayName: "Nope" }, "pri_" + "x".repeat(43));
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, "auth_required");
  assert.equal(store.db.prepare("SELECT status FROM referral_invites WHERE jti=?").get(again.json.jti).status, "minted");

  const taken = await post(origin, "/api/referral-invites/redeem", { token: again.json.token }, existing.secret);
  assert.equal(taken.status, 409);
  assert.equal(taken.json.error.code, "identity_already_linked");
  assert.equal(store.room("commons").state.members[existing.identityId].active, true);
});
