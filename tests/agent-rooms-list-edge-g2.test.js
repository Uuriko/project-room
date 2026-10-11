// Edge guards for AgentRooms.list pagination (WAVE-500 G2, supporting
// grok-agent-room-list-page-1010 / PR #2540). These pin contract invariants
// that hold on both the pre-fix and fixed implementations, so they stay
// green across the #2540 merge: full cursor-chain walks with interleaved
// dead links (no duplicates, no gaps, termination), all-dead tails,
// the exact-full-page boundary, and the 101-link boundary union.
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
  const directory = mkdtempSync(join(tmpdir(), "agent-room-list-edge-g2-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
  });
  const identity = store.identities.create("Edge Pager");
  const insertRoom = store.db.prepare(
    "INSERT INTO rooms (id, sequence, projection, archived_at) VALUES (?, 0, ?, NULL)");
  const insertLink = store.db.prepare(
    "INSERT INTO identity_links (room_id, identity_id, member_id, linked_at) VALUES (?, ?, ?, ?)");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms, identity, insertRoom, insertLink };
}

// A live link resolves through resolveIdentityLink: the link's member_id
// must name an active member in the room projection. A dead link names a
// member absent from the projection.
function addRoom(ctx, id, { live }) {
  const memberId = live ? `m-${id}` : "ghost";
  const projection = JSON.stringify({
    room: { ownerId: live ? memberId : "owner", title: live ? `Live ${id}` : `Dead ${id}` },
    members: live ? { [memberId]: { id: memberId, active: true, kind: "agent" } } : {},
  });
  ctx.insertRoom.run(id, projection);
  ctx.insertLink.run(id, ctx.identity.identityId, memberId, 1);
}

// Walk the whole cursor chain; every page must advance and the walk must end.
function walkAll(rooms, secret, identityId) {
  const seen = [];
  let after = "";
  let pages = 0;
  for (;;) {
    const page = rooms.list(secret, after);
    assert.equal(page.identityId, identityId);
    for (const room of page.rooms) {
      assert.equal(typeof room.roomId, "string");
      assert.equal(typeof room.memberId, "string");
    }
    seen.push(...page.rooms.map(room => room.roomId));
    pages += 1;
    assert.ok(pages < 30, `cursor chain did not terminate (page ${pages})`);
    if (!page.nextCursor) break;
    after = page.nextCursor;
  }
  return { seen, pages };
}

test("AgentRooms.list walks interleaved live/dead links with no duplicates or gaps", t => {
  const ctx = setup(t);
  const liveIds = [];
  for (let i = 0; i < 250; i += 1) {
    const live = `p${String(i).padStart(3, "0")}`;
    liveIds.push(live);
    addRoom(ctx, live, { live: true });
    // "p000x" sorts between "p000" and "p001": dead links interleave live ones.
    addRoom(ctx, `${live}x`, { live: false });
  }
  const { seen, pages } = walkAll(ctx.rooms, ctx.identity.secret, ctx.identity.identityId);
  assert.equal(seen.length, 250);
  assert.equal(new Set(seen).size, 250, "no room listed twice");
  assert.deepEqual(seen, liveIds, "every live room listed exactly once, in id order");
  assert.ok(pages >= 1);
});

test("AgentRooms.list returns empty pages (and terminates) when every link is dead", t => {
  const ctx = setup(t);
  for (let i = 0; i < 150; i += 1) addRoom(ctx, `d${String(i).padStart(3, "0")}`, { live: false });
  const { seen, pages } = walkAll(ctx.rooms, ctx.identity.secret, ctx.identity.identityId);
  assert.deepEqual(seen, [], "no dead link surfaces a room");
  assert.ok(pages >= 1 && pages < 30, "chain terminates");
});

test("AgentRooms.list returns no cursor for exactly one full page of live rooms", t => {
  const ctx = setup(t);
  for (let i = 0; i < 100; i += 1) addRoom(ctx, `e${String(i).padStart(3, "0")}`, { live: true });
  const page = ctx.rooms.list(ctx.identity.secret);
  assert.equal(page.rooms.length, 100);
  assert.equal(page.nextCursor, null);
});

test("AgentRooms.list carries the 101st live room onto the second page", t => {
  const ctx = setup(t);
  const ids = [];
  for (let i = 0; i < 101; i += 1) {
    const id = `q${String(i).padStart(3, "0")}`;
    ids.push(id);
    addRoom(ctx, id, { live: true });
  }
  const first = ctx.rooms.list(ctx.identity.secret);
  assert.equal(first.rooms.length, 100);
  assert.ok(first.nextCursor, "a further link remains, so a cursor is returned");
  const second = ctx.rooms.list(ctx.identity.secret, first.nextCursor);
  assert.deepEqual(second.rooms.map(room => room.roomId), [ids[100]]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    [...first.rooms.map(room => room.roomId), ...second.rooms.map(room => room.roomId)],
    ids,
    "union of both pages is the full set, no loss, no duplication",
  );
});
