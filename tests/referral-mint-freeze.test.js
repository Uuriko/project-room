// Issue #3218 (simplification decision #8): referral-invites are PARKED.
// Minting is frozen at the HTTP door; preview/redeem/list for outstanding
// tokens keep working unchanged. This suite pins both halves of that
// contract: the door refuses (410 referral_invites_parked, after the
// usual 401/422 gates, writing nothing), and a token minted through the
// store (the path outstanding tokens took) still previews and redeems
// over HTTP. Unfreezing = reverting the refusal in server/http.mjs;
// store.referralInvites.mint is deliberately untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t, ownerId = "owner") {
  const directory = mkdtempSync(join(tmpdir(), "project-room-referral-freeze-"));
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

async function enrollInviter(store, origin, ownerKey, displayName = "Inviter") {
  const created = await post(origin, "/api/agent-identities", { displayName });
  assert.equal(created.status, 201);
  store.identities.link(ownerKey, "commons", {
    identityId: created.json.identityId, displayName,
    permissions: ["steer", "accept_work", "complete_work", "verify", "invite_member"],
  });
  return { identityId: created.json.identityId, secret: created.json.secret };
}

const mintCount = store => store.db.prepare("SELECT COUNT(*) AS n FROM referral_invites").get().n;
const MINT = "/api/referral-invites/mint";

test("the mint door refuses with the parked error and writes nothing", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);
  for (const body of [{ roomId: "commons" }, { roomId: "commons", maxDepth: 3 }, { roomId: "commons", requestId: "retry-key-0001" }]) {
    const refused = await post(origin, MINT, body, inviter.secret);
    assert.equal(refused.status, 410);
    assert.equal(refused.json.error.code, "referral_invites_parked");
    assert.match(refused.json.error.message, /still preview and redeem/);
    assert.equal(refused.json.reason, "referral_invites_parked");
    assert.ok(Array.isArray(refused.json.next), "the parked refusal teaches the alternative");
  }
  assert.equal(mintCount(store), 0, "a refused mint writes no ledger row");
});

test("the parked refusal still sits behind the 401 and 422 gates", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const inviter = await enrollInviter(store, origin, ownerKey);
  const anonymous = await post(origin, MINT, { roomId: "commons" });
  assert.equal(anonymous.status, 401);
  const malformed = await post(origin, MINT, { roomId: "commons", surprise: true }, inviter.secret);
  assert.equal(malformed.status, 422);
  assert.equal(malformed.json.error.code, "invalid_invite");
  const getMint = await fetch(`${origin}${MINT}`, { headers: { Origin: origin } });
  assert.equal(getMint.status, 405);
  assert.equal(mintCount(store), 0);
});

test("an outstanding token still previews, redeems, and audits over HTTP", async t => {
  const { store, origin, ownerKey } = await serve(t);
  // Outstanding tokens were minted before the freeze; the store call is
  // the same mint() the door used to invoke.
  const minted = store.referralInvites.mint(ownerKey, "commons");
  assert.match(minted.token, /^ref1\./);
  const previewed = await post(origin, "/api/referral-invites/preview", { token: minted.token });
  assert.equal(previewed.status, 200);
  assert.equal(previewed.json.roomId, "commons");
  const redeemed = await post(origin, "/api/referral-invites/redeem", { token: minted.token, displayName: "Stranger" });
  assert.equal(redeemed.status, 201);
  const audit = await fetch(`${origin}/api/rooms/commons/referral-invites`, {
    headers: { Origin: origin, Authorization: `Bearer ${ownerKey}` },
  });
  assert.equal(audit.status, 200);
  const auditJson = await audit.json();
  assert.ok(auditJson.invites.some(r => r.status === "redeemed"), "the redemption is in the owner audit");
});
