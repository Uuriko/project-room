// Issue #3963: GET /api/agent-rooms returns the rooms the calling identity
// is a MEMBER of, but the served OpenAPI summary (generated from the route
// table in server/discoverability.mjs) described the GET operation as
// listing rooms OWNED by the identity. An agent planning around "owned"
// semantics misreads its authority over the returned rooms.
//
// Two legs:
//  1. Behaviour (ground truth): AgentRooms.list returns a room the caller
//     merely belongs to and does not own.
//  2. Contract: the generated OpenAPI GET operation for /api/agent-rooms
//     must describe that membership semantics in its GET clause, not
//     ownership. This leg fails at the pre-fix base and passes built.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { buildOpenApiJson } from "../server/discoverability.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-rooms-list-contract-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms };
}

test("list returns a room the identity is a member of but does not own", t => {
  const { store, rooms } = setup(t);
  const owner = store.identities.create("Olga Owner");
  const guest = store.identities.create("Gary Guest");
  // A room owned by `owner` where `guest` holds an active member seat and an
  // identity link — the same seat shape the invite-redeem path leaves.
  const memberId = "member-mere";
  const projection = JSON.stringify({
    room: { ownerId: owner.identityId, title: "Peer Den" },
    members: { [memberId]: { id: memberId, active: true, kind: "agent" } },
  });
  store.db.prepare("INSERT INTO rooms (id, sequence, projection, archived_at) VALUES (?, 0, ?, NULL)")
    .run("peer-den", projection);
  store.db.prepare("INSERT INTO identity_links (room_id, identity_id, member_id, linked_at) VALUES (?, ?, ?, ?)")
    .run("peer-den", guest.identityId, memberId, 1);

  assert.equal(store.roomAuthority("peer-den").ownerId, owner.identityId);
  assert.notEqual(store.roomAuthority("peer-den").ownerId, guest.identityId);
  const page = rooms.list(guest.secret);
  assert.deepEqual(page.rooms.map(room => room.roomId), ["peer-den"]);
});

test("generated OpenAPI GET /api/agent-rooms summary states membership, not ownership", () => {
  const doc = buildOpenApiJson({ origin: "https://example.invalid" });
  const get = doc.paths["/api/agent-rooms"]?.get;
  assert.ok(get, "generated OpenAPI carries a GET /api/agent-rooms operation");
  // The route table's summary serves both methods of the combined route;
  // the clause up to the "(GET)" marker is the listing claim.
  const getClause = get.summary.split("(GET)")[0];
  assert.match(getClause, /member/i,
    `GET summary must say the listed rooms are memberships, got: ${get.summary}`);
  assert.doesNotMatch(getClause, /owned/i,
    `GET summary must not claim the listed rooms are owned, got: ${get.summary}`);
  // The POST leg stays honest: creating a room does make the caller its owner.
  assert.match(get.summary, /create a room owned by it \(POST\)/i,
    `POST clause must keep the create-and-own semantics, got: ${get.summary}`);
});
