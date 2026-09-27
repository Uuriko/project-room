import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

const oldHead = "c8433fc7a9382b40c9746a641402444881e2cb9a";
const repository = fileURLToPath(new URL("../", import.meta.url));
async function serve(t, store, oldHttp = createRoomServer) {
  const server = oldHttp({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return async (path, { method = "GET", data, token } = {}) => {
    const res = await fetch(origin + path, { method, headers: { Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: res.status, body: await res.json() };
  };
}

test("same persisted DB rollback rejects restricted passes, old invite redemption and legacy reissue", async t => {
  const root = mkdtempSync(join(tmpdir(), "room-guest-rollback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDir = join(root, "old");
  createRuntimePackage({ repository, commit: oldHead, destination: packageDir });
  const { RoomStore: OldStore } = await import(pathToFileURL(join(packageDir, "server/store.mjs")));
  const { createRoomServer: oldHttp } = await import(pathToFileURL(join(packageDir, "server/http.mjs")));
  const file = join(root, "room.sqlite");
  const current = new RoomStore(file);
  current.initialize(initialRoom());
  const owner = current.issueAccessKey("commons", "owner");
  const request = await serve(t, current);
  const scoped = async (name, scope) => {
    const minted = await request("/api/rooms/commons/guest-invites", { method: "POST", token: owner,
      data: { requestId: randomUUID(), guestLabel: name, scope, expectedOwnerRevision: 0 } });
    assert.equal(minted.status, 201); assert.match(minted.body.code, /^G2-/);
    const identity = current.identities.create(name);
    const keys = generateKeyPair();
    const body = { name, description: "external agent", capabilities: ["chat"] };
    const card = { ...body, publicKey: keys.publicKey,
      signature: signCard({ agentId: identity.identityId, card: body, privateKey: keys.privateKey }) };
    const redeemed = await request("/api/guest-invites/redeem", { method: "POST", token: identity.secret,
      data: { inviteCode: minted.body.code, card } });
    assert.equal(redeemed.status, 201); assert.match(redeemed.body.token, /^g2\./);
    return { ...redeemed.body, identity, card, code: minted.body.code };
  };
  const reader = await scoped("Reader", "read_only"), chatter = await scoped("Chatter", "chat_only");
  const rotated = await request("/api/guest-invites/rotate", { method: "POST", token: reader.token, data: { roomId: "commons" } });
  assert.equal(rotated.status, 200); assert.match(rotated.body.token, /^g2\./);
  assert.equal((await request("/api/rooms/commons", { token: reader.token })).status, 401);
  reader.token = rotated.body.token;
  const pendingScoped = await request("/api/rooms/commons/guest-invites", { method: "POST", token: owner,
    data: { requestId: randomUUID(), guestLabel: "Pending scoped", scope: "chat_only", expectedOwnerRevision: 0 } });
  assert.equal(pendingScoped.status, 201);
  const preMint = await request("/api/rooms/commons/guest-invites", { method: "POST", token: owner,
    data: { requestId: randomUUID(), guestLabel: "Old code", expectedOwnerRevision: 0 } });
  assert.equal(preMint.status, 201); assert.match(preMint.body.code, /^GX-/);
  current.close();
  const old = new OldStore(file);
  t.after(() => old.close());
  const rollback = await serve(t, old, oldHttp);
  const message = id => ({ id, type: "message.posted", data: { messageId: id, body: "not allowed" } });
  assert.equal((await rollback("/api/rooms/commons/commands", { method: "POST", token: reader.token, data: message("rollback-write") })).status, 401);
  assert.equal((await rollback("/api/rooms/commons", { token: chatter.token })).status, 401);
  assert.equal((await rollback("/api/guest-invites/redeem", { method: "POST", token: reader.identity.secret,
    data: { inviteCode: reader.code, card: reader.card } })).status, 410);
  assert.equal((await rollback("/api/guest-invites/redeem", { method: "POST", token: reader.identity.secret,
    data: { inviteCode: pendingScoped.body.code, card: reader.card } })).status, 410);
  // The old writer can mint observer GX codes, but its redemption into a
  // restricted existing seat must fail inside SQLite, not issue a ga1. bearer.
  const reissue = await rollback("/api/guest-invites/redeem", { method: "POST", token: reader.identity.secret,
    data: { inviteCode: preMint.body.code, card: reader.card } });
  assert.notEqual(reissue.status, 201);
  assert.equal(old.db.prepare("SELECT count(*) n FROM credentials WHERE member_id=? AND revoked=0").get(reader.member.id).n, 0);
  // Rollback cannot strip the side-table scope and then use the old pass.
  assert.throws(() => old.db.prepare("DELETE FROM guest_capability_scopes WHERE kind='member' AND id=?").run(reader.member.id));
  assert.equal(old.db.prepare("SELECT count(*) n FROM credentials WHERE member_id=? AND revoked=1").get(reader.member.id).n, 2);
  assert.equal(old.db.prepare("SELECT scope FROM guest_capability_scopes WHERE kind='member' AND id=?").get(reader.member.id).scope, "read_only");
});
