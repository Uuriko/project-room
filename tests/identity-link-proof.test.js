// #942 finding 2 — identities.link() requires holder proof-of-possession.
// Owner-driven linking must present a holder-minted single-use link code
// (POST /api/identities/{identityId}/link-code); the access-request approval
// path carries consent established at request time (the holder authenticated
// with the identity secret when the request was submitted), so decide() is
// exempt. Fail-first: link() without a code must 422, not 201.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-linkproof-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const ownerToken = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerToken };
}

const mint = (store, identity) =>
  store.identities.mintLinkCode(identity.identityId, identity.secret).linkCode;

const proofRequired = error =>
  error.status === 422 && error.code === "identity_link_proof_required";

test("link() without a holder link code fails closed (422 identity_link_proof_required)", async t => {
  const { store, ownerToken } = setup(t);
  const identity = store.identities.create("Proof Bot");
  assert.throws(
    () => store.identities.link(ownerToken, "commons", { identityId: identity.identityId, permissions: ["accept_work"] }),
    proofRequired,
    "owner-driven link with no holder proof must fail closed"
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE identity_id=?").get(identity.identityId).n,
    0, "no link row written on the failed bind"
  );
});

test("link() with a malformed or foreign link code fails closed", async t => {
  const { store, ownerToken } = setup(t);
  const identity = store.identities.create("Proof Bot");
  const other = store.identities.create("Other Bot");
  const foreign = mint(store, other);
  assert.throws(
    () => store.identities.link(ownerToken, "commons", { identityId: identity.identityId, permissions: [], identityLinkCode: "not-a-code" }),
    proofRequired, "malformed code"
  );
  assert.throws(
    () => store.identities.link(ownerToken, "commons", { identityId: identity.identityId, permissions: [], identityLinkCode: foreign }),
    proofRequired, "code minted for a different identity"
  );
});

test("link() with a valid holder-minted code succeeds, then the code is single-use", async t => {
  const { store, ownerToken } = setup(t);
  const identity = store.identities.create("Proof Bot");
  const code = mint(store, identity);
  const linked = store.identities.link(ownerToken, "commons",
    { identityId: identity.identityId, permissions: ["accept_work"], identityLinkCode: code });
  assert.equal(linked.identityId, identity.identityId);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE identity_id=?").get(identity.identityId).n,
    1
  );
  // Reuse of the burned code fails closed, on a fresh identity and room.
  const second = store.identities.create("Second Bot");
  store.initialize(initialRoom("lab"));
  const ownerLab = store.issueAccessKey("lab", "owner");
  assert.throws(
    () => store.identities.link(ownerLab, "lab", { identityId: second.identityId, permissions: [], identityLinkCode: code }),
    proofRequired, "a consumed code is single-use"
  );
});

test("link() with an expired code fails closed", async t => {
  const { store, ownerToken } = setup(t);
  const identity = store.identities.create("Proof Bot");
  const code = mint(store, identity);
  store.db.prepare("UPDATE identity_link_codes SET expires_at=? WHERE identity_id=?")
    .run(store.now() - 1, identity.identityId);
  assert.throws(
    () => store.identities.link(ownerToken, "commons", { identityId: identity.identityId, permissions: [], identityLinkCode: code }),
    proofRequired, "expired code"
  );
});

test("a failed link does not burn the code (consume rolls back with the transaction)", async t => {
  const { store, ownerToken } = setup(t);
  const identity = store.identities.create("Proof Bot");
  const code = mint(store, identity);
  // Invalid permissions fail AFTER the proof gate; the retry must still work.
  assert.throws(
    () => store.identities.link(ownerToken, "commons", { identityId: identity.identityId, permissions: "not-an-array", identityLinkCode: code }),
    error => error.status === 422 && error.code === "invalid_identity"
  );
  const linked = store.identities.link(ownerToken, "commons",
    { identityId: identity.identityId, permissions: [], identityLinkCode: code });
  assert.equal(linked.identityId, identity.identityId, "code survived the rolled-back attempt");
});

test("HTTP: POST /identity-links requires the holder code; 201 with it", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-linkproof-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerToken = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = (body, secret) => fetch(`${origin}/api/rooms/commons/identity-links`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  const identity = store.identities.create("HTTP Proof Bot");
  const bare = await post({ identityId: identity.identityId, permissions: [] }, ownerToken);
  assert.equal(bare.status, 422, "HTTP link without a code fails closed");
  assert.equal((await bare.json()).error.code, "identity_link_proof_required");
  const code = mint(store, identity);
  const ok = await post({ identityId: identity.identityId, permissions: [], identityLinkCode: code }, ownerToken);
  assert.equal(ok.status, 201, "HTTP link with a holder-minted code binds");
  assert.equal((await ok.json()).identityId, identity.identityId);
});

test("access-request approval (decide) links without a code — consent was established at request time", async t => {
  const { store, ownerToken } = setup(t);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const identity = store.identities.create("Requesting Agent");
  // The holder proves possession of the identity secret when the request is
  // submitted; the approval carries that consent forward.
  requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_linkproof"
  }, identity.secret);
  const decided = requests.decide(ownerToken, "commons", "ar_linkproof", { decision: "approve" });
  assert.equal(decided.status, "approved");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE identity_id=?").get(identity.identityId).n,
    1, "decide() approval still binds without a fresh link code"
  );
});
