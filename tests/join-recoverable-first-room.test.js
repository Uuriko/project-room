// POST /join (no invite) mints an identity and a personal room. With
// recoverable: true and the caller's own pri_ secret as the bearer, a retry
// after a lost response returns the same identity and room instead of a
// second pair.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-join-recoverable-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons", "owner"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin: `http://127.0.0.1:${server.address().port}` };
}
async function post(origin, path, body, token) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const newSecret = () => `pri_${randomBytes(32).toString("base64url")}`;
const identities = store => store.db.prepare("SELECT COUNT(*) AS n FROM agent_identities").get().n;

test("recoverable /join: a retry returns the same identity and personal room, nothing is minted twice", async t => {
  const { store, origin } = await serve(t);
  const secret = newSecret();
  const first = await post(origin, "/join", { displayName: "Retry Rae", recoverable: true }, secret);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.via, "first-room");
  assert.equal(first.json.identitySecret, undefined, "the caller already holds the secret; it is not echoed");
  const after = identities(store);
  const retry = await post(origin, "/join", { displayName: "Retry Rae", recoverable: true }, secret);
  assert.equal(retry.status, 201, JSON.stringify(retry.json));
  assert.equal(retry.json.duplicate, true);
  assert.equal(retry.json.identityId, first.json.identityId);
  assert.equal(retry.json.roomId, first.json.roomId);
  assert.equal(identities(store), after, "no second identity");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM agent_identities WHERE display_name = 'Retry Rae'").get().n, 1);
});

test("keyless /join is unchanged: two calls still make two identities and rooms", async t => {
  const { origin } = await serve(t);
  const a = await post(origin, "/join", { displayName: "Plain Pat" });
  const b = await post(origin, "/join", { displayName: "Plain Pat" });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.json.identityId, b.json.identityId);
  assert.notEqual(a.json.roomId, b.json.roomId);
  assert.ok(a.json.identitySecret && b.json.identitySecret);
});

test("recoverable /join: needs a bearer, a pri_ secret, and no inviteCode", async t => {
  const { origin } = await serve(t);
  assert.equal((await post(origin, "/join", { displayName: "No Token", recoverable: true })).status, 401);
  assert.equal((await post(origin, "/join", { displayName: "Not Pri", recoverable: true }, "not-a-pri-secret")).status, 401);
  assert.equal((await post(origin, "/join", { displayName: "Short Pri", recoverable: true }, "pri_short")).status, 401);
  assert.equal((await post(origin, "/join", { displayName: "Flag False", recoverable: false }, newSecret())).status, 422);
  assert.equal((await post(origin, "/join", { displayName: "With Code", recoverable: true, inviteCode: "x" }, newSecret())).status, 422);
});

test("recoverable /join and registration refuse a well-formed but repetitive (guessable) credential", async t => {
  const { store, origin } = await serve(t);
  const before = identities(store);
  for (const weak of [`pri_${"A".repeat(43)}`, `pri_${"abcd".repeat(11).slice(0, 43)}`]) {
    const joined = await post(origin, "/join", { displayName: "Weak Wes", recoverable: true }, weak);
    assert.equal(joined.status, 422, JSON.stringify(joined.json));
    assert.equal(joined.json.error.code, "invalid_identity");
  }
  assert.equal(identities(store), before, "nothing minted for a weak credential");
  const good = await post(origin, "/join", { displayName: "Strong Sam", recoverable: true }, newSecret());
  assert.equal(good.status, 201, JSON.stringify(good.json));
});
