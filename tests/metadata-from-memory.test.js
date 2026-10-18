// PERF-BUILDS P0-2 — answer room metadata from memory.
// roomAuthority / historyFloor used to run json_extract probes over the
// stored projection text on every call; the post path probed the
// projection text twice more for the archive marker; authenticate ran
// twice per snapshot request; stampActivated issued an UPDATE per
// authenticated call. These tests pin the memory paths and their
// equivalence with the storage paths they replace.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { archiveMarker, archiveMarkerFromState } from "../server/messages-store.mjs";

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

function fixture() {
  let clock = 1_760_000_000_000;
  const store = new RoomStore(":memory:", { now: () => (clock += 5_000) });
  // Count probes over the projection TEXT (the expensive kind): the
  // authority prefix/full extracts and any json_extract(projection...).
  let textProbes = 0;
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (typeof sql === "string" && /projection/i.test(sql) && !/^SELECT sequence FROM rooms/.test(sql)
      && typeof statement.get === "function") {
      const get = statement.get.bind(statement);
      statement.get = (...args) => { textProbes += 1; return get(...args); };
    }
    return statement;
  };
  store.initialize(initialRoom());
  const ownerToken = store.issueAccessKey("commons", "owner");
  for (let i = 0; i < 10; i++) {
    store.command(ownerToken, "commons", command(T.MESSAGE_POSTED, { messageId: `m${i}`, body: `message ${i}` }));
  }
  return { store, ownerToken, textProbes: () => textProbes };
}

test("roomAuthority answers from the cached projection when warm, identically to storage", () => {
  const { store, textProbes } = fixture();
  try {
    const warmState = store.room("commons"); // warm the cache
    const ownerId = warmState.state.room.ownerId;
    const before = textProbes();
    const authority = store.roomAuthority("commons");
    assert.equal(textProbes(), before, "a warm roomAuthority must not probe the projection text");
    assert.equal(authority.sequence, warmState.sequence);
    assert.equal(authority.ownerId, ownerId);
    // Values are the cached projection's members, but never the same
    // objects: roomAuthority's storage contract hands callers fresh
    // objects they may hold or mutate, so the warm path returns a deep
    // copy of the cached frozen members (an earlier version returned
    // the frozen objects themselves, which broke that contract —
    // room-authority: "narrow authority preserves exact members ...").
    assert.deepEqual(JSON.parse(JSON.stringify(authority.members)), JSON.parse(JSON.stringify(warmState.state.members)));
    assert.notEqual(authority.members, warmState.state.members, "members are a copy, not the cached objects");
    // Cold path (cache dropped) returns the same values from storage.
    store._dropProjectionCache();
    const cold = store.roomAuthority("commons");
    assert.equal(cold.sequence, authority.sequence);
    assert.equal(cold.ownerId, authority.ownerId);
    assert.deepEqual(JSON.parse(JSON.stringify(cold.members)), JSON.parse(JSON.stringify(authority.members)));
    // A missing room still 404s through the fallback.
    assert.throws(() => store.roomAuthority("no-such-room"), /Room not found/);
  } finally { store.close(); }
});

test("roomAuthority sees a membership change immediately (the cache is sequence-keyed)", () => {
  const { store, ownerToken } = fixture();
  try {
    store.room("commons");
    const before = store.roomAuthority("commons");
    assert.equal(before.members["member-new"], undefined);
    store.command(ownerToken, "commons", command(T.MEMBER_ADDED, { memberId: "member-new", displayName: "New", kind: "human", permissions: ["steer"] }));
    const after = store.roomAuthority("commons");
    assert.ok(after.sequence > before.sequence);
    assert.equal(after.members["member-new"].displayName, "New");
  } finally { store.close(); }
});

test("historyFloor answers from the cached projection when warm, identically to storage", () => {
  const { store, ownerToken, textProbes } = fixture();
  try {
    // Put a member under since_join history and give them a join point.
    store.command(ownerToken, "commons", command(T.MEMBER_ADDED, { memberId: "joiner", displayName: "Joiner", kind: "human", permissions: ["steer"] }));
    store.command(ownerToken, "commons", command(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" }));
    store.room("commons"); // warm at the current sequence
    const before = textProbes();
    const warm = store.historyFloor("commons", "joiner");
    assert.equal(textProbes(), before, "a warm historyFloor must not probe the projection text");
    store._dropProjectionCache();
    const cold = store.historyFloor("commons", "joiner");
    assert.deepEqual(
      { sequence: warm?.sequence ?? null, at: warm?.at ?? null },
      { sequence: cold?.sequence ?? null, at: cold?.at ?? null });
    // The owner reads everything: null floor on both paths.
    store.room("commons");
    assert.equal(store.historyFloor("commons", store.room("commons").state.room.ownerId), null);
  } finally { store.close(); }
});

test("archiveMarkerFromState equals archiveMarker over stored projections", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, sequence INTEGER, projection TEXT)");
  const insert = db.prepare("INSERT INTO rooms (id, sequence, projection) VALUES (?, ?, ?)");
  const shapes = [
    ["no marker", { room: {}, messages: [] }],
    ["marker", { room: {}, messages: [], messagesArchive: { throughSeq: 42, count: 40, retainedIds: ["p1", "p2"] } }],
    ["marker with junk retained", { room: {}, messagesArchive: { throughSeq: 7, count: 3, retainedIds: ["ok", 5, null] } }],
    ["zero marker", { room: {}, messagesArchive: { throughSeq: 0, count: 0, retainedIds: [] } }]
  ];
  for (const [label, state] of shapes) {
    insert.run(label, 1, JSON.stringify(state));
    assert.deepEqual(archiveMarkerFromState(state), archiveMarker(db, label), label);
  }
});

test("stampActivated stamps once per identity per process, not once per call", () => {
  let clock = 1_760_000_000_000;
  const store = new RoomStore(":memory:", { now: () => (clock += 5_000) });
  try {
    const identity = store.identities.create("Stamped Agent");
    store.identities.stampActivated(identity.identityId);
    const row = store.db.prepare("SELECT activated_at AS at FROM agent_identities WHERE identity_id=?").get(identity.identityId);
    assert.ok(row.at != null, "the first stamp persists activated_at");
    const stampAfterFirst = store.writeStamp();
    for (let i = 0; i < 25; i++) store.identities.stampActivated(identity.identityId);
    assert.equal(store.writeStamp(), stampAfterFirst, "repeat stamps must issue no write at all");
    // A different identity still gets its own first stamp.
    const other = store.identities.create("Other Agent");
    store.identities.stampActivated(other.identityId);
    assert.ok(store.writeStamp() > stampAfterFirst);
    assert.ok(store.db.prepare("SELECT activated_at AS at FROM agent_identities WHERE identity_id=?").get(other.identityId).at != null);
  } finally { store.close(); }
});

test("snapshot authenticates inside its read transaction (no funnel preAuth hand-down)", () => {
  const { store, ownerToken } = fixture();
  try {
    // The in-transaction authenticate is the committed-read recheck: a
    // membership or credential change landing after the HTTP funnel's
    // routing auth must still refuse the read (room-authority tests:
    // "managed discovery rechecks ... before-committed-read"). An early
    // version of this PR handed the funnel auth down to skip the second
    // authenticate; that withdrew the recheck and was removed. Pin the
    // corrected contract: snapshot always authenticates, and nothing a
    // caller passes can stand in for it.
    const original = store.authenticate.bind(store);
    store.authenticate = () => { throw new Error("in-transaction authenticate must run"); };
    try {
      assert.throws(
        () => store.snapshot(ownerToken, "commons", null, "full", false, false, "full"),
        /in-transaction authenticate must run/);
    } finally { store.authenticate = original; }
    const snap = store.snapshot(ownerToken, "commons", null, "full", false, false, "full");
    assert.equal(snap.viewerId, store.authenticate(ownerToken, "commons").member.id);
  } finally { store.close(); }
});

