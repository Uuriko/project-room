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

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-referral-"));
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

// An agent member with work permissions, so the referral flow can prove it
// lands strangers at the lower tier regardless of the inviter's own power.
async function enrollInviter(store, origin, ownerKey) {
  const created = await post(origin, "/api/agent-identities", { displayName: "Inviter" });
  assert.equal(created.status, 201);
  store.identities.link(ownerKey, "commons", {
    identityId: created.json.identityId, displayName: "Inviter",
    permissions: ["steer", "accept_work", "complete_work", "verify"],
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

  // The chain continues: the redeemed stranger mints at depth 1, same chain.
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

  // ...the depth-0 member mints depth 1 (the cap is inclusive)...
  const last = await post(origin, "/api/referral-invites/mint", { roomId: "commons", maxDepth: 1 }, redeemed.json.secret);
  assert.equal(last.status, 201);
  assert.equal(last.json.depth, 1);
  const deep = await post(origin, "/api/referral-invites/redeem", { token: last.json.token, displayName: "DepthOne" });
  assert.equal(deep.status, 201);

  // ...but the depth-1 member is AT the cap: minting fails and is journaled.
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
  const zero = await post(origin, "/api/referral-invites/redeem", { token: first.json.token });
  const second = await post(origin, "/api/referral-invites/mint", { roomId: "commons" }, zero.json.secret);
  assert.equal(second.status, 201);
  assert.equal(second.json.maxDepth, 1, "unspecified descendant cap inherits the original");
  const one = await post(origin, "/api/referral-invites/redeem", { token: second.json.token });
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
