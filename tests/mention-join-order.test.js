// Regression contract: mention reads must be driven by the member's own
// mention_states rows, never by a scan of the room's event log. A plain JOIN
// let the planner walk the whole log per poll (needs-me's hottest query).
// CROSS JOIN pins the order; the plan assertion below pins the contract.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore, OPEN_DIRECT_MENTIONS_SQL } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

const FILLERS = 500;

function seeded(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create("Mention Owner");
  const agent = store.identities.create("Mention Agent");
  const roomId = "mention-join";
  rooms.create(owner.secret, { roomId, title: roomId, purpose: "join order", kind: "personal" });
  store.identities.link(owner.secret, roomId, { identityId: agent.identityId, displayName: "Scout", permissions: [] });
  const memberId = store.db.prepare("SELECT member_id FROM identity_links WHERE identity_id=?").get(agent.identityId).member_id;
  // One real mention through the command path, so trackMentions writes the row.
  store.command(owner.secret, roomId, { id: randomUUID(), type: "message.posted",
    data: { messageId: "ask-scout", body: "@Scout can you check the join order?" } });
  // Event-log volume behind it: direct inserts keep the test fast.
  const maxSeq = store.db.prepare("SELECT MAX(sequence) AS s FROM events WHERE room_id=?").get(roomId).s;
  const at = new Date().toISOString();
  const insert = store.db.prepare("INSERT INTO events(room_id,sequence,id,body) VALUES(?,?,?,?)");
  store.transaction(() => {
    for (let i = 0; i < FILLERS; i++) {
      const id = `fill-${i}`;
      insert.run(roomId, maxSeq + 1 + i, id, JSON.stringify({ id, type: "message.posted", actorId: "owner",
        roomId, at, data: { messageId: id, body: "filler" } }));
    }
  });
  return { store, roomId, memberId, through: maxSeq + FILLERS };
}

test("openDirectMentions returns the member's mentions newest-first under log volume", t => {
  const { store, roomId, memberId, through } = seeded(t);
  const rows = store.openDirectMentions(roomId, memberId, 50, Date.now(), { after: 0, through });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageId, "ask-scout");
  assert.equal(rows[0].body, "@Scout can you check the join order?");
  assert.equal(rows[0].state, "delivered");
  assert.equal(rows[0].replyToId, "ask-scout");
});

test("the direct-mention query is driven by mention_states, not an event-log scan", t => {
  const { store } = seeded(t);
  const plan = store.db.prepare("EXPLAIN QUERY PLAN " + OPEN_DIRECT_MENTIONS_SQL)
    .all("mention-join", "member", 0, 1).map(row => row.detail).join("\n");
  assert.match(plan, /SEARCH m USING (?:COVERING )?INDEX mention_states_member/, plan);
  assert.doesNotMatch(plan, /SCAN events/, plan);
});
