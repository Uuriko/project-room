import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-room-list-page-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms };
}

test("AgentRooms.list fills the page with live rooms after inactive links", t => {
  const { store, rooms } = setup(t);
  const identity = store.identities.create("Pager");
  const projection = JSON.stringify({ room: { ownerId: "owner", title: "Dead" }, members: {} });
  const insertRoom = store.db.prepare("INSERT INTO rooms (id, sequence, projection, archived_at) VALUES (?, 0, ?, NULL)");
  const insertLink = store.db.prepare("INSERT INTO identity_links (room_id, identity_id, member_id, linked_at) VALUES (?, ?, ?, ?)");
  for (let i = 0; i < 100; i += 1) {
    const id = `a${String(i).padStart(2, "0")}`;
    insertRoom.run(id, projection);
    insertLink.run(id, identity.identityId, "ghost", 1);
  }
  rooms.create(identity.secret, {
    roomId: "z-live", title: "Live", purpose: "still a member", kind: "personal",
    displayName: "Pager", starter: false,
  });

  const page = rooms.list(identity.secret);
  assert.deepEqual(page.rooms.map(room => room.roomId), ["z-live"]);
  assert.equal(page.nextCursor, null);

  const followed = rooms.list(identity.secret, "a99");
  assert.deepEqual(followed.rooms.map(room => room.roomId), ["z-live"]);
  assert.equal(followed.nextCursor, null);
});

test("AgentRooms.list still pages a full set of live rooms", t => {
  const { store, rooms } = setup(t);
  const identity = store.identities.create("Pager");
  const memberId = "member-live";
  const projection = JSON.stringify({
    room: { ownerId: memberId, title: "Live" },
    members: { [memberId]: { id: memberId, active: true, kind: "agent" } },
  });
  const insertRoom = store.db.prepare("INSERT INTO rooms (id, sequence, projection, archived_at) VALUES (?, 0, ?, NULL)");
  const insertLink = store.db.prepare("INSERT INTO identity_links (room_id, identity_id, member_id, linked_at) VALUES (?, ?, ?, ?)");
  const ids = [];
  for (let i = 0; i < 101; i += 1) {
    const id = `b${String(i).padStart(3, "0")}`;
    ids.push(id);
    insertRoom.run(id, projection);
    insertLink.run(id, identity.identityId, memberId, 1);
  }
  const page = rooms.list(identity.secret);
  assert.deepEqual(page.rooms.map(room => room.roomId), ids.slice(0, 100));
  assert.equal(page.nextCursor, ids[99]);
  const next = rooms.list(identity.secret, page.nextCursor);
  assert.deepEqual(next.rooms.map(room => room.roomId), [ids[100]]);
  assert.equal(next.nextCursor, null);
});
