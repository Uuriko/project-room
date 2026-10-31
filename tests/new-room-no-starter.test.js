// A new room starts with an empty Board: no task pre-claimed by its owner.
// The starter stays available with starter: true.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  AgentRooms,
  agentRoomSchema,
  ensureAgentRoomRequestIdColumn
} from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

// Issue #2915: room-create duplicate detection compared ownerId, title,
// purpose, kind and displayName but never the starter flag (part of
// CREATE_FIELDS, parsed as wantStarter). A replay that differed only in
// starter was silently answered duplicate:true — e.g. a first create with
// starter:false replayed with starter:true returned starter:null instead
// of the 409 every other differing field produces. Both idempotency keys
// (client roomId and client requestId) had the same omission.
//
// The original create's starter choice is recoverable from the room
// itself: a starter was wanted iff the starter work claim exists, which
// is exactly what a fresh create produces and what the duplicate response
// returns as `starter`.

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-agent-rooms-starter-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureAgentRoomRequestIdColumn(store.db);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const identity = store.identities.create("Owning Agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms, identity };
}

const createArgs = (overrides = {}) => ({
  title: "Agent Den", purpose: "A room owned by an agent, for agent things.",
  kind: "personal", displayName: "Den Keeper", ...overrides
});

const attempt = (rooms, secret, args) => {
  try { return { ok: true, result: rooms.create(secret, args) }; }
  catch (error) { return { ok: false, status: error.status, code: error.code, message: error.message }; }
};

const roomCount = store =>
  store.db.prepare("SELECT count(*) AS n FROM agent_room_ownership").get().n;

test("a default create seeds no starter and teaches no starter steps", t => {
  const { store, rooms, identity } = setup(t);
  const created = rooms.create(identity.secret, createArgs({ roomId: "plain-den" }));
  assert.equal(created.starter, null);
  assert.deepEqual(store.workClaims.list("plain-den"), [], "the Board starts empty; nothing is claimed for the owner");
  const actions = created.next.map(step => step.action);
  assert.ok(!actions.includes("start-work") && !actions.includes("finish-work"), actions.join(","));
  assert.doesNotMatch(JSON.stringify(created.next), /starter/i);
});

test("starter: true still seeds the claimed starter and its steps", t => {
  const { store, rooms, identity } = setup(t);
  const created = rooms.create(identity.secret, createArgs({ roomId: "starter-den", starter: true }));
  assert.equal(created.starter?.claimId, "starter");
  assert.equal(store.workClaims.get("starter-den", "starter").state, "claimed");
  assert.equal(created.next[0].action, "start-work");
});
