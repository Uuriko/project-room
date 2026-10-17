// research r41: the agent "my rooms" list reads 101 seats (a 100-row page plus
// one look-ahead for nextCursor) and binds every seat into one IN list. The
// Worker's Durable Object SQL allows 100 values per statement, so an identity
// seated in 101+ rooms gets a 500 from the very page that paging exists for.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

process.env.ROOM_SQL_BIND_LIMIT = "100";

function seated(t, count) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  const identity = store.identities.create("Busy Agent");
  const link = store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)");
  for (let i = 0; i < count; i++) {
    const roomId = `seat-${String(i).padStart(3, "0")}`;
    store.initialize(initialRoom(roomId, identity.identityId));
    link.run(roomId, identity.identityId, identity.identityId, new Date(0).toISOString());
  }
  return { rooms, identity };
}

test("the Worker bind limit is enforced in this file", (t) => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  const values = Array.from({ length: 101 }, (_, i) => i);
  assert.throws(() => store.db.prepare(`SELECT 1 WHERE 1 IN (${values.map(() => "?").join(",")})`).get(...values),
    /too many SQL variables/);
});

for (const count of [100, 101, 150]) {
  test(`an identity seated in ${count} rooms can page its room list`, (t) => {
    const { rooms, identity } = seated(t, count);
    const first = rooms.list(identity.secret);
    assert.equal(first.rooms.length, Math.min(count, 100));
    if (count > 100) {
      assert.ok(first.nextCursor, "a second page is announced");
      const second = rooms.list(identity.secret, first.nextCursor);
      assert.equal(second.rooms.length, count - 100);
      assert.equal(second.nextCursor ?? null, null);
    } else {
      assert.equal(first.nextCursor ?? null, null);
    }
  });
}
