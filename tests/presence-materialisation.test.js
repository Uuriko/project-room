// PRES: presence materialisation at commit.
//
// Characterisation half (passes before and after the move): presence rows
// keep their exact observed semantics — lastSeenAt is the member's latest
// event `at`, an enrollment-only member keeps its first member.added `at`,
// freshness/state windows are read-time computations over those timestamps
// (they decay with the clock and no new writes), host liveness flips on its
// own window with lastSeenAt unchanged, the cross-room read and the
// operator staleness read derive the same values, and an importEvents
// history replacement replaces the derived values too.
//
// Materialisation half (pins the new mechanism): per-member activity is
// written to member_activity in the same transaction as the event append,
// a rolled-back append never advances it, reads serve the materialised
// value, and a room whose rows are missing (pre-materialisation history)
// is served correctly and rebuilt on the next commit.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { EVENT_TYPES as T, PERMISSIONS, event, HISTORY_DEFAULTS_VERSION } from "../src/events.js";

const T0 = 1_750_000_000_000;
const iso = ms => new Date(ms).toISOString();

function fixture(t) {
  let at = T0;
  const store = new RoomStore(":memory:", { now: () => at });
  t.after(() => store.close());
  return { store, advance: ms => { at += ms; }, now: () => at, set: ms => { at = ms; } };
}

// One room, built in a single initialize() call with explicit event times:
// owner + poster enrolled at T0, quiet enrolled at T0+10s (all by owner).
function buildRoom(store, roomId = "commons") {
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId, at: iso(T0),
      data: { roomId, ownerId: "owner", title: roomId, purpose: "pres", kind: "personal", historyDefaultsVersion: HISTORY_DEFAULTS_VERSION } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId, at: iso(T0),
      data: { memberId: "owner", displayName: "Owner", kind: "human", permissions: [...PERMISSIONS] } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId, at: iso(T0),
      data: { memberId: "poster", displayName: "Poster", kind: "human", permissions: ["accept_work"] } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId, at: iso(T0 + 10_000),
      data: { memberId: "quiet", displayName: "Quiet", kind: "human", permissions: ["accept_work"] } }),
  ]);
  return {
    ownerKey: store.issueAccessKey(roomId, "owner"),
    posterKey: store.issueAccessKey(roomId, "poster"),
  };
}

const rowOf = (presence, memberId) => presence.members.find(m => m.memberId === memberId);

test("characterisation: lastSeenAt is the latest event at; enrollment-only member keeps its member.added at", t => {
  const { store, set } = fixture(t);
  const { ownerKey, posterKey } = buildRoom(store);
  const before = store.presence(ownerKey, "commons", []);
  assert.equal(rowOf(before, "quiet").lastSeenAt, iso(T0 + 10_000));
  assert.equal(rowOf(before, "poster").lastSeenAt, iso(T0));
  set(T0 + 300_000);
  store.command(posterKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: "hello" } });
  const after = store.presence(ownerKey, "commons", []);
  assert.equal(rowOf(after, "poster").lastSeenAt, iso(T0 + 300_000));
  assert.equal(rowOf(after, "quiet").lastSeenAt, iso(T0 + 10_000));
});

test("characterisation: freshness windows are read-time — state decays with the clock, no new writes", t => {
  const { store, set, advance } = fixture(t);
  const { ownerKey, posterKey } = buildRoom(store);
  set(T0 + 300_000);
  store.command(posterKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: "hello" } });
  const fresh = store.presence(ownerKey, "commons", []);
  assert.equal(rowOf(fresh, "poster").state, "listening");
  advance(6 * 60_000); // past the 5-minute live window
  const decayed = store.presence(ownerKey, "commons", []);
  assert.equal(rowOf(decayed, "poster").state, "idle");
  assert.equal(rowOf(decayed, "poster").lastSeenAt, iso(T0 + 300_000));
});

test("characterisation: staleMembers derives the same lastSeenAt as presence", t => {
  const { store, set, advance } = fixture(t);
  const { ownerKey, posterKey } = buildRoom(store);
  set(T0 + 300_000);
  store.command(posterKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: "hello" } });
  advance(2 * 24 * 3600_000);
  const presence = store.presence(ownerKey, "commons", []);
  const stale = store.staleMembers("commons", { days: 1 });
  for (const memberId of ["poster", "quiet"]) {
    const entry = stale.stale.find(s => s.memberId === memberId);
    assert.ok(entry, `${memberId} is stale after 2 days`);
    assert.equal(entry.lastSeenAt, Date.parse(rowOf(presence, memberId).lastSeenAt));
  }
});

test("characterisation: importEvents replaces the derived activity with the imported history", t => {
  const { store, set } = fixture(t);
  const { ownerKey, posterKey } = buildRoom(store);
  set(T0 + 300_000);
  store.command(posterKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: "hello" } });
  assert.equal(rowOf(store.presence(ownerKey, "commons", []), "poster").lastSeenAt, iso(T0 + 300_000));
  const lines = [
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId: "commons", at: iso(T0),
      data: { roomId: "commons", ownerId: "owner", title: "commons", purpose: "pres", kind: "personal", historyDefaultsVersion: HISTORY_DEFAULTS_VERSION } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: "commons", at: iso(T0),
      data: { memberId: "owner", displayName: "Owner", kind: "human", permissions: [...PERMISSIONS] } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: "commons", at: iso(T0 + 5_000),
      data: { memberId: "poster", displayName: "Poster", kind: "human", permissions: ["accept_work"] } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: "commons", at: iso(T0 + 10_000),
      data: { memberId: "quiet", displayName: "Quiet", kind: "human", permissions: ["accept_work"] } }),
  ].map((e, i) => ({ sequence: i + 1, event: e }));
  store.importEvents(ownerKey, "commons", lines);
  const after = store.presence(ownerKey, "commons", []);
  // The imported history's latest poster signal is its enrollment at
  // T0+5s; the pre-import post at T0+300s must not survive the replacement.
  assert.equal(rowOf(after, "poster").lastSeenAt, iso(T0 + 5_000));
  assert.equal(rowOf(after, "quiet").lastSeenAt, iso(T0 + 10_000));
});

test("materialisation: commits write member_activity in the same transaction; rollback never advances it", t => {
  const { store, set } = fixture(t);
  const { ownerKey, posterKey } = buildRoom(store);
  const rows = () => store.db.prepare(
    "SELECT member_id AS memberId, last_command_at AS lastCommandAt, added_at AS addedAt FROM member_activity WHERE room_id='commons' ORDER BY member_id").all();
  const poster = rows().find(r => r.memberId === "poster");
  assert.ok(poster, "member_activity has a poster row after initialize");
  // Poster never acted as an actor (its enrollment event's actor is the
  // owner): last_command_at stays null and enrollment lives in added_at.
  assert.equal(poster.lastCommandAt, null);
  assert.equal(poster.addedAt, iso(T0));
  const quiet = rows().find(r => r.memberId === "quiet");
  assert.equal(quiet.addedAt, iso(T0 + 10_000));
  assert.equal(quiet.lastCommandAt, null);
  // The owner acted last at T0+10s (the quiet enrollment it performed).
  const owner = rows().find(r => r.memberId === "owner");
  assert.equal(owner.lastCommandAt, iso(T0 + 10_000));
  assert.equal(owner.addedAt, iso(T0));
  set(T0 + 300_000);
  store.command(posterKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: "hello" } });
  assert.equal(rows().find(r => r.memberId === "poster").lastCommandAt, iso(T0 + 300_000));
  // A rolled-back append leaves the materialised value untouched.
  assert.throws(() => store.transaction(() => {
    store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run("commons", 999,
      "rolled-back", JSON.stringify({ id: "rolled-back", roomId: "commons", type: "message.posted", actorId: "poster", at: iso(T0 + 900_000), data: {} }));
    throw new Error("boom");
  }), /boom/);
  assert.equal(rows().find(r => r.memberId === "poster").lastCommandAt, iso(T0 + 300_000));
  assert.equal(rowOf(store.presence(ownerKey, "commons", []), "poster").lastSeenAt, iso(T0 + 300_000));
});

test("materialisation: reads serve the materialised value, not a fresh scan", t => {
  const { store, set } = fixture(t);
  const { ownerKey, posterKey } = buildRoom(store);
  set(T0 + 300_000);
  store.command(posterKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: "hello" } });
  // Move ONLY the materialised value: the read must follow it even though
  // no event carries this timestamp.
  store.db.prepare("UPDATE member_activity SET last_command_at=? WHERE room_id='commons' AND member_id='poster'")
    .run(iso(T0 + 400_000));
  assert.equal(rowOf(store.presence(ownerKey, "commons", []), "poster").lastSeenAt, iso(T0 + 400_000));
});

test("materialisation: a room with no rows (pre-materialisation history) reads correctly and rebuilds on next commit", t => {
  const { store, set } = fixture(t);
  const { ownerKey, posterKey } = buildRoom(store);
  set(T0 + 300_000);
  store.command(posterKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: "hello" } });
  const expected = store.presence(ownerKey, "commons", []).members.map(m => [m.memberId, m.lastSeenAt]);
  store.db.prepare("DELETE FROM member_activity WHERE room_id='commons'").run();
  // Fallback: the read still derives the same values from the event log.
  const fallback = store.presence(ownerKey, "commons", []).members.map(m => [m.memberId, m.lastSeenAt]);
  assert.deepEqual(fallback, expected);
  // Next commit rebuilds the room's rows from the full log, not just itself.
  set(T0 + 400_000);
  store.command(posterKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: "again" } });
  const rebuilt = store.db.prepare(
    "SELECT member_id AS memberId, last_command_at AS lastCommandAt FROM member_activity WHERE room_id='commons'").all();
  assert.equal(rebuilt.find(r => r.memberId === "poster").lastCommandAt, iso(T0 + 400_000));
  assert.equal(rebuilt.find(r => r.memberId === "quiet").lastCommandAt, null);
  const quietRow = store.db.prepare(
    "SELECT added_at AS addedAt FROM member_activity WHERE room_id='commons' AND member_id='quiet'").get();
  assert.equal(quietRow.addedAt, iso(T0 + 10_000));
});

test("characterisation: cross-room agentPresence rows carry the materialised per-room activity", t => {
  const { store, set } = fixture(t);
  const caller = store.identities.create("pres caller");
  const target = store.identities.create("pres target");
  const build = (roomId, targetAt) => {
    store.initialize([
      event({ type: T.ROOM_CREATED, actorId: caller.identityId, roomId, at: iso(T0),
        data: { roomId, ownerId: caller.identityId, title: roomId, purpose: "pres", kind: "personal", historyDefaultsVersion: HISTORY_DEFAULTS_VERSION } }),
      event({ type: T.MEMBER_ADDED, actorId: caller.identityId, roomId, at: iso(T0),
        data: { memberId: caller.identityId, displayName: "Caller", kind: "agent", permissions: [...PERMISSIONS], identityId: caller.identityId } }),
      event({ type: T.MEMBER_ADDED, actorId: caller.identityId, roomId, at: iso(targetAt),
        data: { memberId: "target-member", displayName: "Target", kind: "agent", permissions: ["accept_work"], identityId: target.identityId } }),
    ]);
    store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
      .run(roomId, caller.identityId, caller.identityId, T0);
    store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
      .run(roomId, target.identityId, "target-member", T0);
  };
  build("pres-room-a", T0);
  build("pres-room-b", T0 + 20_000);
  const out = store.agentPresence({ identityId: caller.identityId, boundRoomId: null }, target.identityId);
  assert.equal(out.rooms.length, 2);
  assert.equal(out.rooms.find(r => r.roomId === "pres-room-a").lastSeenAt, iso(T0));
  assert.equal(out.rooms.find(r => r.roomId === "pres-room-b").lastSeenAt, iso(T0 + 20_000));
  void set;
});

test("characterisation: host liveness still flips on its window with lastSeenAt unchanged", t => {
  const { store, advance } = fixture(t);
  const caller = store.identities.create("pres caller 2");
  const target = store.identities.create("pres target 2");
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: caller.identityId, roomId: "pres-host-room", at: iso(T0),
      data: { roomId: "pres-host-room", ownerId: caller.identityId, title: "pres-host-room", purpose: "pres", kind: "personal", historyDefaultsVersion: HISTORY_DEFAULTS_VERSION } }),
    event({ type: T.MEMBER_ADDED, actorId: caller.identityId, roomId: "pres-host-room", at: iso(T0),
      data: { memberId: caller.identityId, displayName: "Caller", kind: "agent", permissions: [...PERMISSIONS], identityId: caller.identityId } }),
    event({ type: T.MEMBER_ADDED, actorId: caller.identityId, roomId: "pres-host-room", at: iso(T0),
      data: { memberId: "target-member", displayName: "Target", kind: "agent", permissions: ["accept_work"], identityId: target.identityId } }),
  ]);
  store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
    .run("pres-host-room", caller.identityId, caller.identityId, T0);
  store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
    .run("pres-host-room", target.identityId, "target-member", T0);
  store.agentHeartbeats.heartbeat({ agentId: target.identityId, hostId: "h", cadenceSeconds: 60 });
  const callerArg = { identityId: caller.identityId, boundRoomId: null };
  const fresh = store.agentPresence(callerArg, target.identityId);
  assert.equal(fresh.rooms[0].presence.status, "online");
  const seenAt = fresh.rooms[0].presence.lastSeenAt;
  advance(181_000); // past max(180s, 60s x 1.5)
  const stale = store.agentPresence(callerArg, target.identityId);
  assert.equal(stale.rooms[0].presence.status, "offline");
  assert.equal(stale.rooms[0].presence.lastSeenAt, seenAt);
});
