// Referral-invite mint: opt-in requestId makes a lost-response retry replay the
// same signed token instead of minting a second live one.
// Since #3218 the HTTP mint door is parked (410 referral_invites_parked, no
// rows written — pinned by tests/referral-mint-freeze.test.js), so the
// idempotency contract is exercised here at the store level it lives in:
// store.referralInvites.mint is the same call the door used to make.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

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
  linkWithProof(store, ownerKey, "commons", created.json, { displayName, permissions: ["steer", "accept_work", "complete_work", "verify", "invite_member"] });
  return { identityId: created.json.identityId, secret: created.json.secret };
}

const count = store => store.db.prepare("SELECT COUNT(*) AS n FROM referral_invites").get().n;
const mintKeyed = (store, secret, requestId, maxDepth) =>
  store.referralInvites.mint(secret, "commons", { requestId, ...(maxDepth !== undefined ? { maxDepth } : {}) });

test("mint with a requestId: a lost-response retry replays the same token and journals one row", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);
  const first = mintKeyed(store, inviter.secret, "retry-key-0001");
  assert.notEqual(first.duplicate, true);
  const replay = mintKeyed(store, inviter.secret, "retry-key-0001");
  assert.equal(replay.duplicate, true);
  assert.equal(replay.token, first.token, "the replay re-signs the identical token");
  assert.equal(replay.jti, first.jti);
  assert.equal(count(store), 1, "no second ledger row");
  const redeemed = await post(origin, "/api/referral-invites/redeem", { token: replay.token, displayName: "Stranger" });
  assert.equal(redeemed.status, 201, "the replayed token is the live one");
});

test("mint requestId: same key with a different maxDepth is a 409 and changes nothing", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);
  mintKeyed(store, inviter.secret, "retry-key-0002", 3);
  assert.throws(() => mintKeyed(store, inviter.secret, "retry-key-0002", 5),
    error => error.status === 409 && error.code === "referral_mint_idempotency_conflict");
  assert.equal(count(store), 1);
});

test("mint requestId: keys are scoped to the inviter, a fresh key is a fresh token, keyless mints still stack", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const a = await enrollInviter(store, origin, ownerKey, "InviterA");
  const b = await enrollInviter(store, origin, ownerKey, "InviterB");
  const ra = mintKeyed(store, a.secret, "shared-key-0003");
  const rb = mintKeyed(store, b.secret, "shared-key-0003");
  assert.notEqual(ra.jti, rb.jti, "another inviter reusing the key never gets this inviter's token");
  const fresh = mintKeyed(store, a.secret, "fresh-key-0004");
  assert.notEqual(fresh.jti, ra.jti);
  const k1 = store.referralInvites.mint(a.secret, "commons");
  const k2 = store.referralInvites.mint(a.secret, "commons");
  assert.notEqual(k1.jti, k2.jti, "keyless behavior is unchanged");
  assert.equal(count(store), 5);
});

test("mint requestId: malformed keys are 422", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);
  for (const requestId of ["short", "has spaces in it", 12345678, "x".repeat(129)]) {
    assert.throws(() => mintKeyed(store, inviter.secret, requestId),
      error => error.status === 422, JSON.stringify(requestId));
  }
  assert.equal(count(store), 0);
});
