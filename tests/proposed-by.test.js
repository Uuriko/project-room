import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_TYPES as T, PERMISSIONS, applyEvent, emptyRoomState, event, replay } from "../src/events.js";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// Return-brief wiring, disposition 5557850637 decision 2: proposedById derives from the
// AUTHORITATIVE EVENT ENVELOPE (incoming.actorId on work.proposed). It is never duplicated
// into event data and never inferred from the source message's author. Historical replay
// recovers it wherever the envelope exists; only genuinely absent provenance renders unknown.

const roomEvents = () => [
  event({ type: T.ROOM_CREATED, actorId: "owner", roomId: "commons", data: { roomId: "commons", ownerId: "owner", title: "t", purpose: "p" } }),
  event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: "commons", data: { memberId: "owner", displayName: "owner", kind: "human", permissions: [...PERMISSIONS] } }),
  event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: "commons", data: { memberId: "human", displayName: "human", kind: "human", permissions: ["accept_work", "complete_work"] } })
];
const propose = (actorId, extra = {}) => event({ type: T.WORK_PROPOSED, actorId, roomId: "commons", data: { workItemId: "w1", title: "Review", definitionOfDone: "done", accountableMemberId: "human", ...extra } });

test("replay recovers proposedById from the envelope actorId, distinct from the accountable member", () => {
  const state = replay([...roomEvents(), propose("owner")]);
  assert.equal(state.workItems.w1.accountableMemberId, "human");
  assert.equal(state.workItems.w1.proposedById, "owner"); // the proposer is the envelope actor, not the accountable member
});

test("a forged proposer inside the payload is rejected at the command boundary and ignored by the reducer", () => {
  // The reducer must never read a proposer out of data: the source pin below proves no such
  // read exists, and the command schema rejects the unexpected field end-to-end.
  const directory = mkdtempSync(join(tmpdir(), "project-room-proposedby-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  try {
    store.initialize(initialRoom());
    const owner = store.issueAccessKey("commons", "owner");
    store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "human", displayName: "human", kind: "human", permissions: ["accept_work"] } });
    assert.throws(
      () => store.command(owner, "commons", { id: crypto.randomUUID(), type: T.WORK_PROPOSED, data: { workItemId: "w1", title: "Review", definitionOfDone: "done", accountableMemberId: "human", proposedById: "mallory" } }),
      /Unexpected field: proposedById/
    );
    assert.equal(store.snapshot(owner, "commons").state.workItems.w1, undefined); // nothing slipped through
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("genuinely absent provenance stays unknown - no later event fabricates a proposer", () => {
  const state = replay([...roomEvents(), propose("owner")]);
  delete state.workItems.w1.proposedById; // a pre-field legacy projection row has no provenance
  const later = applyEvent(state, event({ type: T.MESSAGE_POSTED, actorId: "human", roomId: "commons", data: { body: "any update" } }));
  assert.equal(Object.hasOwn(later.workItems.w1, "proposedById"), false); // still unknown, never back-filled from other actors
});

test("source pin: proposedById is assigned from the envelope only", () => {
  const src = readFileSync(new URL("../src/events.js", import.meta.url), "utf8")
    .split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  assert.match(src, /proposedById:\s*incoming\.actorId/);
  assert.equal(src.includes("data.proposedById"), false);
});

test("reopening a pre-upgrade database repairs provenance from each item's own proposal envelope", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-repair-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "human", displayName: "human", kind: "human", permissions: ["accept_work"] } });
  store.command(owner, "commons", { id: crypto.randomUUID(), type: T.WORK_PROPOSED, data: { workItemId: "w-legacy", title: "Legacy item", definitionOfDone: "done", accountableMemberId: "human" } });
  // Simulate the pre-upgrade persisted shape: projection row without the field, envelope intact.
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify((() => { const s = store.room("commons").state; delete s.workItems["w-legacy"].proposedById; return s; })()), "commons");
  store.close();
  store = new RoomStore(filename); // reopen: repair must run deterministically, without replaying the log
  try {
    const item = store.snapshot(owner, "commons").state.workItems["w-legacy"];
    assert.equal(item.proposedById, "owner"); // recovered from its own work.proposed envelope
    assert.notEqual(item.proposedById, item.accountableMemberId);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("an item with no authoritative proposal envelope stays honestly unknown after reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-repair-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  // Inject an imported legacy item with NO proposal envelope anywhere in the log.
  const state = store.room("commons").state;
  state.workItems["w-imported"] = { id: "w-imported", title: "Imported", state: "proposed", accountableMemberId: "owner" };
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(state), "commons");
  store.close();
  store = new RoomStore(filename);
  try {
    const item = store.snapshot(owner, "commons").state.workItems["w-imported"];
    assert.equal(Object.hasOwn(item, "proposedById"), false); // repair fabricates nothing
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
