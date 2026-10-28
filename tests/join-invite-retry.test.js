// #3260: POST /api/join's invite branch must offer the same retry paths as
// its sibling doors. Before the fix it rejected requestId outright
// (422 invalid_join — "accepted fields" named only displayName, inviteCode,
// proof, recoverable) and never forwarded an identity secret, so a lost
// 201 orphaned the minted identity: the code was burned, the credential
// existed only in the lost response, and the retry 409'd
// invite_already_used. The REST redeem door (POST /api/agent-invites/redeem)
// and MCP room_join already replay through store.invites.redeem's journal:
// requestId replays the receipt; presenting the redeeming identity's secret
// replays as duplicate. These tests pin /api/join to the same contract.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-join-retry-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

async function post(origin, path, body, token) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const mint = (origin, ownerKey) =>
  post(origin, "/api/rooms/commons/agent-invites", { profile: "collaborate", expiresInMinutes: 60 }, ownerKey);
const joinPost = (origin, body, token) => post(origin, "/api/join", body, token);
const memberCount = (store, roomId) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE room_id = ?").get(roomId).n;

test("a lost 201 is recoverable: the same requestId replays the same membership", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey);
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  const body = { displayName: "Retry Bot", inviteCode: minted.json.code, requestId: "join-retry-0001" };
  const first = await joinPost(origin, body);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  // The response is "lost" (timeout / crash / dropped connection). The
  // caller retries with the identical request.
  const retry = await joinPost(origin, body);
  assert.equal(retry.status, 201, JSON.stringify(retry.json));
  assert.equal(retry.json.identityId, first.json.identityId, "the retry returns the identity the first attempt minted");
  assert.equal(retry.json.memberId, first.json.memberId, "the retry returns the same membership");
  assert.equal(retry.json.duplicate, true, "the replay is honestly marked duplicate");
  assert.equal(memberCount(store, "commons"), 1, "exactly one membership was created across both attempts");
});

test("the same requestId with a different name is a 409 conflict, not a second join", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey);
  const first = await joinPost(origin, { displayName: "First Bot", inviteCode: minted.json.code, requestId: "join-retry-0002" });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const conflict = await joinPost(origin, { displayName: "Other Bot", inviteCode: minted.json.code, requestId: "join-retry-0002" });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.json));
  assert.equal(conflict.json.error.code, "invite_redeem_idempotency_conflict");
});

test("an existing identity recovers its join by presenting its secret (the MCP room_join path)", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey);
  const identity = store.identities.create("Returning Bot");
  const body = { displayName: "Returning Bot", inviteCode: minted.json.code };
  const first = await joinPost(origin, body, identity.secret);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.identityId, identity.identityId, "the join binds the presented identity");
  // Response lost; the retry presents the same secret and replays.
  const retry = await joinPost(origin, body, identity.secret);
  assert.equal(retry.status, 201, JSON.stringify(retry.json));
  assert.equal(retry.json.memberId, first.json.memberId);
  assert.equal(retry.json.duplicate, true);
  assert.equal(memberCount(store, "commons"), 1);
  // Without the credential the burned code stays burned: the secret is
  // what proves the retry is the same joiner.
  const anonymous = await joinPost(origin, body);
  assert.equal(anonymous.status, 409, JSON.stringify(anonymous.json));
  assert.equal(anonymous.json.error.code, "invite_already_used");
});

test("field discipline is unchanged apart from requestId: extras 422, requestId needs an invite", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey);
  const extra = await joinPost(origin, { displayName: "X", inviteCode: minted.json.code, bogus: 1 });
  assert.equal(extra.status, 422);
  assert.equal(extra.json.error.code, "invalid_join");
  const noInvite = await joinPost(origin, { displayName: "X", requestId: "join-retry-0003" });
  assert.equal(noInvite.status, 422, JSON.stringify(noInvite.json));
  assert.equal(noInvite.json.error.code, "invalid_join");
  const badId = await joinPost(origin, { displayName: "X", inviteCode: minted.json.code, requestId: "not a valid id!" });
  assert.equal(badId.status, 422, JSON.stringify(badId.json));
  assert.equal(badId.json.error.code, "invalid_join");
});

test("a plain invite join without any retry key still works exactly as before", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey);
  const joined = await joinPost(origin, { displayName: "Plain Bot", inviteCode: minted.json.code });
  assert.equal(joined.status, 201, JSON.stringify(joined.json));
  assert.equal(joined.json.via, "invite");
  assert.ok(joined.json.roomToken?.startsWith("rak_"), "the room-scoped token is issued as before");
});
