// CONTEXT-FIX R4 (lane 09): a since_join / historyGuest reader must not be
// charged full proof cost for pre-join rows they cannot see (lane 03's
// mechanism). The cure charges a bounded scalar for a pre-floor candidate
// (the substrate's own "this scalar can only deny" pattern) and extends the
// 2026-11-02 scoped reservation cure to room_list_work. The global budget
// (MAX_INPUT 256 KiB, reservation set) is NOT raised.
//
// FAIL-on-main: the accounting test below measures >150 KB of proof charged
// for 64 invisible candidates at the pin (full record + witness per row);
// the cured head charges 64 x 256 B of scalar. Copy into tests/ to run.
//
// LANE-11 REWORK (lane 10 PROBE.md C3 + D1 + D2; pin-verified):
// initialRoom is imported from server/bootstrap.mjs (its only export site,
// :3), readCurrentHistoryFloor is called with store.db per its pin
// signature (db, roomId, memberId) at current-room-repository.mjs:1282,
// and the work listing is asserted on its `work` field
// (current-work-list.mjs:159-168). All results remain NOT-RUN.
import assert from "node:assert/strict";
import test from "node:test";
import { RoomStore } from "../server/store.mjs";
import {
  withCurrentReadContext, readCurrentHead, readCurrentHistoryFloor,
  currentConversationRows,
} from "../server/current-room-repository.mjs";
import { readCurrentNativeInbox } from "../server/current-native-inbox.mjs";
import { event } from "../src/events.js";
import { initialRoom } from "../server/bootstrap.mjs";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const at = (offsetMs) => new Date(BASE + offsetMs).toISOString();

function seededStore() {
  const store = new RoomStore(":memory:");
  const events = initialRoom();
  for (let i = 0; i < 64; i += 1) {
    events.push(event({
      roomId: "commons", actorId: "owner", type: "message.posted",
      data: { messageId: `pre-${i}`, body: "x".repeat(3000) },
      at: at(i * 1000),
    }));
  }
  events.push(event({
    roomId: "commons", actorId: "owner", type: "member.added",
    data: {
      memberId: "newbie", displayName: "Newbie", kind: "agent",
      permissions: [], historyGuest: true,
    },
    at: at(100_000),
  }));
  store.initialize(events, { representation: "normalized-current-v1" });
  return store;
}

test("since_join reader is charged scalar-only for pre-join candidates", () => {
  const store = seededStore();
  const head = store.headSequence("commons");
  const out = store.readTransaction(() => withCurrentReadContext(store.db, "commons", (b) => {
    readCurrentHead(store.db, "commons", b);
    const floor = readCurrentHistoryFloor(store.db, "commons", "newbie");
    assert.ok(floor, "newbie carries a history floor");
    const before = b.bytes;
    const result = currentConversationRows(store, "commons", {
      viewerId: "newbie", limit: 4, before: head + 1, beforeId: "",
      messageId: null, channelId: null, peerMemberId: null,
      floor, liveOnly: true,
    });
    return { result, charged: b.bytes - before };
  }, { maxRecords: 512 }));
  assert.deepEqual(out.result.rows, []);
  assert.equal(out.result.examined, 64);
  assert.ok(out.charged < 32_768,
    `pre-join candidates charged ${out.charged} bytes of proof; expected scalar-only accounting`);
});

test("regression guard: the native inbox answers the since_join reader", () => {
  const store = seededStore();
  const key = store.issueAccessKey("commons", "newbie");
  const page = readCurrentNativeInbox(store, key, "commons", { limit: 4 });
  // D1b execution correction (D2-class, pin-verified): readCurrentNativeInbox
  // returns the stamped inbox object (directMessages/cursor/older/coverage),
  // never an `events` field — the filed assertion could not pass on any head.
  // The guard's substance is unchanged: on main this call throws 409
  // current_room_context_unavailable; at head it answers with an empty
  // recent page plus a continuation over the 64 examined pre-join rows.
  assert.ok(page && Array.isArray(page.directMessages));
  assert.equal(page.older.examined, 64);
  assert.equal(page.older.hasMore, true);
});

test("room_list_work scope: currentWorkListing answers in a many-member current room", () => {
  const store = new RoomStore(":memory:");
  const events = initialRoom();
  for (let i = 0; i < 40; i += 1) {
    events.push(event({
      roomId: "commons", actorId: "owner", type: "member.added",
      data: { memberId: `member-${i}`, displayName: `Member ${i}`, kind: "agent", permissions: [] },
      at: at(i * 1000),
    }));
  }
  store.initialize(events, { representation: "normalized-current-v1" });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const listing = store.currentWorkListing(ownerKey, "commons", {});
  assert.ok(listing && Array.isArray(listing.work));
});
