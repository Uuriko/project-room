import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// PRODUCT-200 B7: a dropped ownership-transfer response retried by the old
// owner used to 403 (owner_required), because the transfer had already
// landed and the caller was no longer the owner. The retry must answer
// duplicate:true instead of failing — the transfer already happened.

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-transfer-duplicate-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Owning Agent");
  store.identities.link(ownerToken, "commons", {
    identityId: identity.identityId, displayName: "Owning Agent", permissions: ["accept_work"]
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms, ownerToken, identity };
}

const transferEvents = store =>
  store.db.prepare("SELECT count(*) AS n FROM events WHERE room_id=? AND json_extract(body,'$.type')=?")
    .get("commons", T.OWNERSHIP_TRANSFERRED).n;

const attempt = (rooms, token, args) => {
  try { return { ok: true, result: rooms.transfer(token, "commons", args) }; }
  catch (error) { return { ok: false, status: error.status, code: error.code }; }
};

test("retrying a landed transfer answers duplicate:true, not 403", t => {
  const { store, rooms, ownerToken, identity } = setup(t);
  const first = rooms.transfer(ownerToken, "commons", { toMemberId: identity.identityId });
  assert.equal(first.duplicate, false);
  assert.equal(first.ownerId, identity.identityId);
  assert.equal(transferEvents(store), 1);

  const retry = rooms.transfer(ownerToken, "commons", { toMemberId: identity.identityId });
  assert.equal(retry.duplicate, true, "the replay is recognised as the same transfer");
  assert.equal(retry.ownerId, identity.identityId);
  assert.equal(retry.previousOwnerId, "owner");
  assert.equal(transferEvents(store), 1, "the retry emitted no second transfer event");
  assert.equal(store.roomAuthority("commons").ownerId, identity.identityId);
});

test("a non-owner asking for the current owner still gets 403", t => {
  const { store, rooms, ownerToken, identity } = setup(t);
  const intruder = store.identities.create("Intruder");
  store.identities.link(ownerToken, "commons", {
    identityId: intruder.identityId, displayName: "Intruder", permissions: ["accept_work"]
  });
  rooms.transfer(ownerToken, "commons", { toMemberId: identity.identityId });

  // The intruder is not the previous owner: naming the current owner is not
  // a duplicate of anything they did.
  const replay = attempt(rooms, intruder.secret, { toMemberId: identity.identityId });
  assert.equal(replay.ok, false);
  assert.equal(replay.status, 403);
  assert.equal(replay.code, "owner_required");
});

test("a genuine re-transfer after a transfer-back is not a duplicate", t => {
  const { store, rooms, ownerToken, identity } = setup(t);
  rooms.transfer(ownerToken, "commons", { toMemberId: identity.identityId });
  rooms.transfer(identity.secret, "commons", { toMemberId: "owner" });

  // The room ping-ponged back; the owner transferring out again is new work.
  const again = rooms.transfer(ownerToken, "commons", { toMemberId: identity.identityId });
  assert.equal(again.duplicate, false);
  assert.equal(again.ownerId, identity.identityId);
  assert.equal(transferEvents(store), 3);
});

test("the old owner naming a different member still gets 403", t => {
  const { rooms, ownerToken, identity } = setup(t);
  rooms.transfer(ownerToken, "commons", { toMemberId: identity.identityId });
  const other = attempt(rooms, ownerToken, { toMemberId: "owner" });
  assert.equal(other.ok, false);
  assert.equal(other.status, 403);
  assert.equal(other.code, "owner_required");
});
