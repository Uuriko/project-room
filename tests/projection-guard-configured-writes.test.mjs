// Secondary write paths (guest invites here; access requests, agent invites,
// guest agent links, pairing, referrals and share links share the same call)
// must use the store's configured projection guard from #6452, not a fixed
// 5 MiB. A room the operator allowed to grow past 5 MiB (ROOM_LEGACY_PROJECTION_BYTES,
// at most 6 MiB) must still admit a guest, and the guard must still refuse
// above the configured limit. The default stays 5 MiB.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

const MiB = 1024 * 1024;

async function open(t, file, options) {
  let clock = Date.parse("2026-11-21T12:00:00Z");
  const store = new RoomStore(file, { ...options, now: () => clock });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const close = async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); };
  t.after(close);
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { store, request, close, tick: () => { clock += 60_000; } };
}

const projectionBytes = store => store.db.prepare("SELECT length(CAST(projection AS BLOB)) AS b FROM rooms WHERE id='commons'").get().b;

async function redeem(env, code, name) {
  const identity = env.store.identities.create(name);
  const keys = generateKeyPair();
  const cardBody = { name, description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey, signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  return env.request("/api/guest-invites/redeem", { method: "POST", token: identity.secret, data: { inviteCode: code, card } });
}

test("guest invite redemption uses the configured projection ceiling between 5 and 6 MiB", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-projection-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "room.sqlite");

  // Grow the room past the default 5 MiB under a configured 6 MiB ceiling.
  const grown = await open(t, file, { projectionByteLimit: 6 * MiB });
  grown.store.initialize(initialRoom());
  const ownerKey = grown.store.issueAccessKey("commons", "owner");
  const codes = [];
  for (let i = 0; i < 3; i++) {
    const res = await grown.request("/api/rooms/commons/guest-invites", { method: "POST", token: ownerKey,
      data: { requestId: randomUUID(), guestLabel: `cap visit ${i}`, expectedOwnerRevision: 0 } });
    assert.equal(res.status, 201);
    const minted = await res.json();
    codes.push({ code: minted.code, inviteId: minted.inviteId });
  }
  for (let i = 0; projectionBytes(grown.store) < PILOT_LIMITS.projectionBytes + 200 * 1024; i++) {
    grown.store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: `fill-${i}`, body: "x".repeat(65000) } });
    grown.tick();
  }
  const between = projectionBytes(grown.store);
  assert.ok(between > PILOT_LIMITS.projectionBytes && between < 6 * MiB, `room is between 5 and 6 MiB (${between})`);

  // Configured ceiling: the guest is admitted.
  const before = grown.store.room("commons").sequence;
  const admitted = await redeem(grown, codes[0].code, "Ceiling Visitor");
  assert.ok(admitted.status < 300, `redeem under the configured ceiling succeeds (${admitted.status})`);
  assert.ok(grown.store.room("commons").sequence > before);
  await grown.close();

  // Default 5 MiB: the same room refuses the same kind of write, unchanged.
  const fallback = await open(t, file, {});
  assert.equal(fallback.store.projectionByteLimit, PILOT_LIMITS.projectionBytes);
  const seqDefault = fallback.store.room("commons").sequence;
  const refused = await redeem(fallback, codes[1].code, "Default Visitor");
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, "pilot_limit");
  assert.equal(fallback.store.room("commons").sequence, seqDefault);
  const inviteStatus = (store, { inviteId }) => store.db.prepare("SELECT status FROM guest_invites WHERE id=?").get(inviteId).status;
  assert.equal(inviteStatus(fallback.store, codes[1]), "active", "a refused redemption keeps its one-use code");
  const atCeiling = projectionBytes(fallback.store);
  await fallback.close();

  // Above the configured ceiling: refused, and the one-use code survives.
  const tight = await open(t, file, { projectionByteLimit: atCeiling });
  const seqTight = tight.store.room("commons").sequence;
  const over = await redeem(tight, codes[2].code, "Over Visitor");
  assert.equal(over.status, 409);
  assert.equal((await over.json()).error.code, "pilot_limit");
  assert.equal(tight.store.room("commons").sequence, seqTight);
  assert.equal(inviteStatus(tight.store, codes[2]), "active");
  assert.equal(inviteStatus(tight.store, codes[0]), "redeemed");
});
