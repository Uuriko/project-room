// Credential boundary for the surviving guest door (guest-invites v1).
// Converted from the v0 guest-agent-links boundary suite when the v0 mint
// was cut (#3216): the properties pinned there — the guest credential is
// server-issued from a CSPRNG, only its hash is stored, it authenticates
// its member, and it is never recoverable after issuance — are properties
// of the credential, so they now pin the door that still issues them.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "guest-credential-boundary-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { store, request, ownerKey };
}

async function redeemGuest(request, store, ownerKey, name) {
  const minted = await request("/api/rooms/commons/guest-invites", { method: "POST", token: ownerKey,
    data: { requestId: randomUUID(), guestLabel: `${name} visit`, expectedOwnerRevision: 0 } });
  assert.equal(minted.status, 201);
  const { code } = await minted.json();
  const identity = store.identities.create(name);
  const keys = generateKeyPair();
  const cardBody = { name, description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey, signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const redeemed = await request("/api/guest-invites/redeem", { method: "POST", token: identity.secret, data: { inviteCode: code, card } });
  assert.equal(redeemed.status, 201);
  return { code, identity, card, value: await redeemed.json() };
}

test("server-issued guest credential is random, hashed, usable and not recoverable after redemption", async t => {
  const { store, request, ownerKey } = await serve(t);
  const first = await redeemGuest(request, store, ownerKey, "Visitor");
  assert.match(first.value.token, /^ga1\.[A-Za-z0-9_-]{43}$/);
  assert.equal(first.value.duplicate, false);
  // Usable: the credential authenticates as the guest member it was issued to.
  assert.equal(store.authenticate(first.value.token, "commons").member.id, first.value.member.id);
  // Hashed at rest: the credentials row holds a 64-char hash, never the token.
  const row = store.db.prepare("SELECT hash FROM credentials WHERE member_id=?").get(first.value.member.id);
  assert.equal(row.hash.length, 64);
  assert.notEqual(row.hash, first.value.token);
  assert.equal(row.hash, createHash("sha256").update(first.value.token).digest("hex"));
  // Not recoverable: the store's credential lookup returns the stored row
  // (hash only) — the plaintext exists solely in the redeem response.
  const looked = store.guestAgentLinks.credential(first.value.token);
  assert.ok(looked && !JSON.stringify(looked).includes(first.value.token));
  // A second redemption of the burned code discloses nothing (410).
  const replay = await request("/api/guest-invites/redeem", { method: "POST", token: first.identity.secret,
    data: { inviteCode: first.code, card: first.card } });
  assert.equal(replay.status, 410);
  // Random: an unrelated redemption issues a different credential.
  const second = await redeemGuest(request, store, ownerKey, "Caller");
  assert.notEqual(second.value.token, first.value.token);
});

test("GA-1 (issue #941): caller-provided credential material is rejected — the server always issues", async t => {
  const { store, request, ownerKey } = await serve(t);
  const minted = await request("/api/rooms/commons/guest-invites", { method: "POST", token: ownerKey,
    data: { requestId: randomUUID(), guestLabel: "Chosen-token visit", expectedOwnerRevision: 0 } });
  assert.equal(minted.status, 201);
  const { code } = await minted.json();
  const identity = store.identities.create("Chooser");
  const keys = generateKeyPair();
  const cardBody = { name: "Chooser", description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey, signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  // A caller-chosen token in the redeem body fails closed at the route's
  // exact-field validation instead of becoming a live credential.
  const chosen = "ga1." + randomBytes(32).toString("base64url");
  const attempt = await request("/api/guest-invites/redeem", { method: "POST", token: identity.secret,
    data: { inviteCode: code, card, token: chosen } });
  assert.equal(attempt.status, 422);
  assert.equal((await attempt.json()).error.code, "invalid_guest_invite");
  assert.throws(() => store.authenticate(chosen, "commons"), { code: "unauthenticated" });
  // The same code redeemed properly still issues a server-chosen credential.
  const redeemed = await request("/api/guest-invites/redeem", { method: "POST", token: identity.secret, data: { inviteCode: code, card } });
  assert.equal(redeemed.status, 201);
  assert.notEqual((await redeemed.json()).token, chosen);
});
