// Referral-invite mint: opt-in requestId makes a lost-response retry replay the
// same signed token instead of minting a second live one.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

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

const count = store => store.db.prepare("SELECT COUNT(*) AS n FROM referral_invites").get().n;
const MINT = "/api/referral-invites/mint";

test("mint with a requestId: a lost-response retry replays the same token and journals one row", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);
  const first = await post(origin, MINT, { roomId: "commons", requestId: "retry-key-0001" }, inviter.secret);
  assert.equal(first.status, 201);
  assert.notEqual(first.json.duplicate, true);
  const replay = await post(origin, MINT, { roomId: "commons", requestId: "retry-key-0001" }, inviter.secret);
  assert.equal(replay.status, 201);
  assert.equal(replay.json.duplicate, true);
  assert.equal(replay.json.token, first.json.token, "the replay re-signs the identical token");
  assert.equal(replay.json.jti, first.json.jti);
  assert.equal(count(store), 1, "no second ledger row");
  const redeemed = await post(origin, "/api/referral-invites/redeem", { token: replay.json.token, displayName: "Stranger" });
  assert.equal(redeemed.status, 201, "the replayed token is the live one");
});

test("mint requestId: same key with a different maxDepth is a 409 and changes nothing", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);
  const first = await post(origin, MINT, { roomId: "commons", requestId: "retry-key-0002", maxDepth: 3 }, inviter.secret);
  assert.equal(first.status, 201);
  const clash = await post(origin, MINT, { roomId: "commons", requestId: "retry-key-0002", maxDepth: 5 }, inviter.secret);
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error.code, "referral_mint_idempotency_conflict");
  assert.equal(count(store), 1);
});

test("mint requestId: keys are scoped to the inviter, a fresh key is a fresh token, keyless mints still stack", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const a = await enrollInviter(store, origin, ownerKey, "InviterA");
  const b = await enrollInviter(store, origin, ownerKey, "InviterB");
  const ra = await post(origin, MINT, { roomId: "commons", requestId: "shared-key-0003" }, a.secret);
  const rb = await post(origin, MINT, { roomId: "commons", requestId: "shared-key-0003" }, b.secret);
  assert.notEqual(ra.json.jti, rb.json.jti, "another inviter reusing the key never gets this inviter's token");
  const fresh = await post(origin, MINT, { roomId: "commons", requestId: "fresh-key-0004" }, a.secret);
  assert.notEqual(fresh.json.jti, ra.json.jti);
  const k1 = await post(origin, MINT, { roomId: "commons" }, a.secret);
  const k2 = await post(origin, MINT, { roomId: "commons" }, a.secret);
  assert.notEqual(k1.json.jti, k2.json.jti, "keyless behavior is unchanged");
  assert.equal(count(store), 5);
});

test("mint requestId: malformed keys are 422", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);
  for (const requestId of ["short", "has spaces in it", 12345678, "x".repeat(129)]) {
    const out = await post(origin, MINT, { roomId: "commons", requestId }, inviter.secret);
    assert.equal(out.status, 422, JSON.stringify(requestId));
  }
  assert.equal(count(store), 0);
});
