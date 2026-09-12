import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-identities-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.initialize(initialRoom("lab"));
  const ownerCommons = store.issueAccessKey("commons", "owner");
  const ownerLab = store.issueAccessKey("lab", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerCommons, ownerLab };
}

test("multi-room agent identity: one secret works across linked rooms (round-2 #101)", async t => {
  const { store, origin, ownerCommons, ownerLab } = await serve(t);

  // Create one identity via the HTTP route (no auth needed).
  const created = await fetch(`${origin}/api/agent-identities`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ displayName: "Relay Bot" })
  });
  assert.equal(created.status, 201);
  const { identityId, secret } = await created.json();
  assert.match(identityId, /^ai_/);
  assert.match(secret, /^pri_/);
  // Secret is stored hashed, never in cleartext.
  const row = store.db.prepare("SELECT secret_hash FROM agent_identities WHERE identity_id=?").get(identityId);
  assert.ok(row && !row.secret_hash.includes(secret.slice(4, 12)));

  // Link the same identity into two rooms with one call each.
  const link = async (roomId, ownerKey) => {
    const res = await fetch(`${origin}/api/rooms/${roomId}/identity-links`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${ownerKey}` },
      body: JSON.stringify({ identityId, permissions: ["accept_work", "complete_work"] })
    });
    assert.equal(res.status, 201);
    return res.json();
  };
  const inCommons = await link("commons", ownerCommons);
  const inLab = await link("lab", ownerLab);
  // Same member id in both rooms: one identity, no re-provisioning.
  assert.equal(inCommons.memberId, inLab.memberId);
  assert.equal(inCommons.memberId, identityId);

  // The agent uses its single secret in both rooms: snapshot + post a message.
  for (const roomId of ["commons", "lab"]) {
    const client = new RoomAgentClient({ origin, roomId, token: secret, memberId: identityId });
    const check = await client.checkConnection();
    assert.equal(check.status, "credential_accepted");
    assert.equal(check.memberId, identityId);
    await client.command({ id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: `hello from ${roomId}` } });
    const snapshot = await client.snapshot();
    assert.ok(snapshot.state.messages.some(m => m.authorId === identityId && m.body === `hello from ${roomId}`));
    assert.equal(snapshot.state.members[identityId].identityId, identityId);
  }

  // Unlinking from one room revokes access there only.
  const unlink = await fetch(`${origin}/api/rooms/lab/identity-links`, {
    method: "DELETE", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${ownerLab}` },
    body: JSON.stringify({ identityId })
  });
  assert.equal(unlink.status, 200);
  const labClient = new RoomAgentClient({ origin, roomId: "lab", token: secret, memberId: identityId });
  await assert.rejects(labClient.snapshot(), error => error.status === 401);
  // Still works in commons.
  const commonsClient = new RoomAgentClient({ origin, roomId: "commons", token: secret, memberId: identityId });
  assert.ok((await commonsClient.snapshot()).state.members[identityId]);

  // Re-linking the same identity reactivates the member instead of failing.
  const relink = await link("lab", ownerLab);
  assert.equal(relink.relinked, true);
  const labAgain = new RoomAgentClient({ origin, roomId: "lab", token: secret, memberId: identityId });
  assert.equal((await labAgain.checkConnection()).status, "credential_accepted");
  assert.equal((await labAgain.snapshot()).state.members[identityId].active, true);

  // An identity never linked to a room gets 401 there.
  const other = await (await fetch(`${origin}/api/agent-identities`, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ displayName: "Stranger" }) })).json();
  const stranger = new RoomAgentClient({ origin, roomId: "commons", token: other.secret, memberId: other.identityId });
  await assert.rejects(stranger.snapshot(), error => error.status === 401);
});
