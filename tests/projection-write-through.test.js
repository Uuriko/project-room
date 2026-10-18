// Equivalence battery for the write path: the landed write-through
// projection cache (#3853, watch-invalidation design) plus WRITE-PATH-WINS
// wins 2-5. The cases are the divergence shapes named in
// cmd-persist-profile.md §7 (the object serialized mid-command is not
// always the final committed state: same-transaction follow-up writes,
// state replaced after the persist point, at-rest form divergence) plus
// one case per ported win where its sharing/release shortcut could bite.
//
// The cache tripwire: fixtures open the store with verifyProjectionCache
// (env ROOM_VERIFY_PROJECTION_CACHE=1), so every room() hit is checked
// against a fresh read of the stored row inside the store itself; the
// tests additionally compare room() against the raw stored bytes.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, applyEvent, event, replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import { storedProjection, hydrateProjection } from "../server/projection-at-rest.mjs";
import { archiveMarker } from "../server/messages-store.mjs";
import { readConversation } from "../server/conversation-sync.mjs";

const command = (type, data, id = randomUUID()) => ({ id, type, data });
const big = (tag, n = 6000) => `${tag}:` + "x".repeat(n);

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-write-through-"));
  const file = join(directory, "room.sqlite");
  const store = new RoomStore(file, { verifyProjectionCache: true, ...options });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const raw = () => store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  const bodies = () => store.db.prepare("SELECT sha, body FROM projection_bodies WHERE room_id='commons'").all();
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { store, owner, file, raw, bodies };
}

// --- §7: the landed cache against mid-transaction divergence -------------

test("§7 two writes in one transaction: only the final committed state is ever served", t => {
  const { store, owner, raw } = fixture(t);
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "m1", body: "kept" }));
  // The §7 shape (resumeRoundLimitPauses is the product instance): a state
  // is serialized and written, then replaced before the transaction ends.
  store.transaction(() => {
    const base = store.room("commons").state;
    const first = structuredClone(base); first.room.title = "FIRST (never committed alone)";
    store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(store.storedProjection("commons", first), "commons");
    const second = structuredClone(base); second.room.title = "SECOND (committed)";
    store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(store.storedProjection("commons", second), "commons");
  });
  const served = store.room("commons");
  assert.equal(served.state.room.title, "SECOND (committed)");
  assert.equal(store.room("commons"), served, "the second read is the cache hit and agrees");
  assert.deepEqual(JSON.parse(JSON.stringify(served.state)), JSON.parse(raw()), "served state equals the stored bytes");
});

test("§7 a rolled-back write never reaches the cache", t => {
  const { store, owner } = fixture(t);
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "m1", body: "kept" }));
  const before = store.room("commons").state;
  assert.throws(() => store.transaction(() => {
    const changed = structuredClone(before); changed.room.title = "ROLLED BACK";
    store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(store.storedProjection("commons", changed), "commons");
    throw new Error("boom");
  }), /boom/);
  const after = store.room("commons");
  assert.equal(after.state.room.title, before.room.title);
  assert.deepEqual(after.state.messages.map(m => m.id), ["m1"]);
});

test("§7 post then delete: the in-transaction redaction follow-up (PRIV-1) is what the cache serves", t => {
  const { store, owner, raw } = fixture(t);
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "secret", body: "msg-0 body" }));
  // MESSAGE_DELETED is the MSG-0 shape: command() first persists the
  // delete and queues that state as a cache candidate, then
  // commitMessageRedaction rewrites the log and replaces the state in
  // the SAME transaction. The cache must serve the final committed
  // state, never the mid-transaction candidate.
  store.command(owner, "commons", command(T.MESSAGE_DELETED, { messageId: "secret", expectedMessageRevision: 0, reason: "redact" }));
  const served = store.room("commons").state;
  const message = served.messages.find(m => m.id === "secret");
  assert.equal(message.body, null);
  assert.equal(message.redacted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(served)), JSON.parse(raw()), "served state equals the stored bytes after the redaction follow-up");
});

test("§7 at-rest form divergence: a slimmed stored row and the served state agree, verify on", t => {
  const { store, owner, raw, bodies } = fixture(t, { bodiesAtRest: true });
  const text = big("at-rest");
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "long", body: text }));
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "short", body: "hi" }));
  assert.equal(bodies().length, 1);
  assert.doesNotMatch(raw(), /at-rest:xxx/, "the stored row is slimmed");
  const served = store.room("commons").state;
  const hydrated = hydrateProjection(store.db, "commons", JSON.parse(raw())).state;
  assert.deepEqual(JSON.parse(JSON.stringify(served)), JSON.parse(JSON.stringify(hydrated)));
  assert.equal(served.messages.find(m => m.id === "long").body, text);
});

// --- Win 2: cloneStateForApply light message clones -----------------------

const ROOM_ID = "room-project-room-v0";
const ev = (id, type, actorId, data) => event({ id, idempotencyKey: id, roomId: ROOM_ID, type, actorId, at: "2026-10-17T00:00:00.000Z", data });
const baseState = () => replay(seedEvents);
const withMessage = () => applyEvent(baseState(), ev("post-m", T.MESSAGE_POSTED, "maya", { messageId: "m", body: "original body" }));
const withPoll = () => applyEvent(baseState(), ev("post-p", T.MESSAGE_POSTED, "maya", { messageId: "p", body: "Pick", kind: "poll", poll: { question: "Pick", options: ["a", "b"] } }));

test("win 2: applyEvent never mutates its input state, for every light-clone event type", () => {
  const cases = [
    ["message.posted", withMessage(), () => ev("post-m2", T.MESSAGE_POSTED, "maya", { messageId: "m2", body: "second" })],
    ["message.edited", withMessage(), () => ev("edit-m", T.MESSAGE_EDITED, "maya", { messageId: "m", body: "edited", expectedMessageRevision: 0 })],
    ["message.deleted", withMessage(), () => ev("del-m", T.MESSAGE_DELETED, "maya", { messageId: "m", expectedMessageRevision: 0, reason: "cleanup" })],
    ["message.redacted", withMessage(), () => ev("redact-m", T.MESSAGE_REDACTED, "potter", { messageId: "m" })],
    ["poll.voted", withPoll(), () => ev("vote-p", T.POLL_VOTED, "potter", { messageId: "p", option: 0, active: true })]
  ];
  for (const [name, state, make] of cases) {
    const snapshot = JSON.stringify(state);
    const next = applyEvent(state, make());
    assert.equal(JSON.stringify(state), snapshot, `${name} mutated its input state`);
    assert.notEqual(next, state);
  }
});

test("win 2: the addressed message and its :channel copy are cloned; earlier states keep the original text", () => {
  const posted = withMessage();
  const withCopy = structuredClone(posted);
  withCopy.messages.push({ ...withCopy.messages.find(m => m.id === "m"), id: "m:channel" });
  const snapshot = JSON.stringify(withCopy);
  const redacted = applyEvent(withCopy, ev("redact-m2", T.MESSAGE_REDACTED, "potter", { messageId: "m" }));
  assert.equal(JSON.stringify(withCopy), snapshot, "redact mutated its input (shared element leaked)");
  assert.equal(redacted.messages.find(m => m.id === "m").body, null);
  assert.equal(redacted.messages.find(m => m.id === "m:channel").body, null, "the channel copy is rewritten too");
  const edited = applyEvent(posted, ev("edit-m2", T.MESSAGE_EDITED, "maya", { messageId: "m", body: "edited body", expectedMessageRevision: 0 }));
  assert.equal(edited.messages.find(m => m.id === "m").body, "edited body");
  assert.equal(posted.messages.find(m => m.id === "m").body, "original body", "the pre-edit state still shows the original");
});

test("win 2: sharing-invariance — a mixed sequence gives identical states with and without shared elements", () => {
  const sequence = [
    () => ev("s1", T.MESSAGE_POSTED, "maya", { messageId: "a", body: "first" }),
    () => ev("s2", T.MESSAGE_POSTED, "maya", { messageId: "b", body: "Pick", kind: "poll", poll: { question: "Pick", options: ["a", "b"] } }),
    () => ev("s3", T.POLL_VOTED, "potter", { messageId: "b", option: 1, active: true }),
    () => ev("s4", T.MESSAGE_EDITED, "maya", { messageId: "a", body: "first (edited)", expectedMessageRevision: 0 }),
    () => ev("s5", T.MESSAGE_POSTED, "potter", { messageId: "c", body: "third" }),
    () => ev("s6", T.MESSAGE_REDACTED, "potter", { messageId: "c" }),
    () => ev("s7", T.MEMBER_ADDED, "potter", { memberId: "newbie", displayName: "New Bie", kind: "agent", permissions: ["accept_work"] }),
    () => ev("s8", T.MESSAGE_DELETED, "maya", { messageId: "a", expectedMessageRevision: 1, reason: "done" })
  ];
  let chained = baseState();
  for (const make of sequence) chained = applyEvent(chained, make());
  let isolated = baseState();
  for (const make of sequence) isolated = applyEvent(structuredClone(isolated), make());
  assert.deepEqual(isolated, chained, "light-clone sharing changed the result of the sequence");
});

// --- Wins 3+4: serializer-side body release and hydration trust -----------

test("win 4: the json_each release trigger is gone; the room_gone trigger remains", t => {
  const { store } = fixture(t, { bodiesAtRest: true });
  const triggers = store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='rooms'").all().map(row => row.name);
  assert.ok(triggers.includes("projection_bodies_room_gone"), "room deletion still clears body rows");
  assert.ok(!triggers.includes("projection_bodies_release"), "the per-write json_each trigger is retired");
});

test("win 4: two messages sharing one body share one row; the row is released only when the last reference goes", t => {
  const { store, owner, bodies } = fixture(t, { bodiesAtRest: true });
  const shared = big("shared");
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "one", body: shared }));
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "two", body: shared }));
  assert.equal(bodies().length, 1, "content-addressed: one row for two references");
  store.command(owner, "commons", command(T.MESSAGE_DELETED, { messageId: "one", expectedMessageRevision: 0, reason: "x" }));
  assert.equal(bodies().length, 1, "still referenced by the surviving message");
  assert.equal(store.room("commons").state.messages.find(m => m.id === "two").body, shared);
  store.command(owner, "commons", command(T.MESSAGE_DELETED, { messageId: "two", expectedMessageRevision: 0, reason: "x" }));
  assert.equal(bodies().length, 0, "released when the last reference is deleted");
});

test("win 4: a rolled-back write rolls the body release back with it", t => {
  const { store, owner, bodies } = fixture(t, { bodiesAtRest: true });
  const text = big("rollback");
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "m", body: text }));
  assert.equal(bodies().length, 1);
  assert.throws(() => store.transaction(() => {
    const emptied = structuredClone(store.room("commons").state);
    emptied.messages = [];
    store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(store.storedProjection("commons", emptied), "commons");
    throw new Error("boom");
  }), /boom/);
  assert.equal(bodies().length, 1, "the release was inside the rolled-back transaction");
  assert.equal(store.room("commons").state.messages.find(m => m.id === "m").body, text);
});

test("win 3: hydration trusts the content-addressed key by default; verifyBodyHashes catches a tampered row", t => {
  const { store, owner, raw } = fixture(t, { bodiesAtRest: true });
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "m", body: big("trust") }));
  const parsed = JSON.parse(raw());
  store.db.prepare("UPDATE projection_bodies SET body='tampered text' WHERE room_id='commons'").run();
  const trusted = hydrateProjection(store.db, "commons", structuredClone(parsed));
  assert.deepEqual(trusted.missing, [], "the hot path does not re-hash (content-addressed rows are immutable through every write path)");
  assert.equal(trusted.state.messages.find(m => m.id === "m").body, "tampered text");
  const verified = hydrateProjection(store.db, "commons", structuredClone(parsed), { verifyBodyHashes: true });
  assert.deepEqual(verified.missing, ["m"], "the verification path (messages parity) still catches the tamper");
  store.db.prepare("DELETE FROM projection_bodies WHERE room_id='commons'").run();
  assert.deepEqual(hydrateProjection(store.db, "commons", structuredClone(parsed)).missing, ["m"], "a missing row is reported in both modes");
});

test("win 3: the conversation read still recovers a tampered body row from the event log", t => {
  // The pinned contract (8956bc3b2) win 3 must not break: hydrateRecordText
  // detects the tamper per record, and its recovery source — a verified
  // room() read — repairs from the log instead of serving the tamper.
  const { store, owner, raw } = fixture(t, { bodiesAtRest: true });
  const text = big("recover-me");
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "m", body: text }));
  const sha = JSON.parse(raw()).messages.find(m => m.id === "m").bodyRef;
  store.db.prepare("UPDATE projection_bodies SET body=? WHERE room_id='commons' AND sha=?").run("x".repeat(6000), sha);
  const page = readConversation(store, owner, "commons", { limit: 10 });
  assert.equal(page.messages.find(m => m.id === "m")?.body, text, "the true body is served from the event log");
  assert.equal(store.room("commons").state.messages.find(m => m.id === "m").body, text, "the verified read also repaired the cache entry");
});

// --- Win 5: extraction probes ----------------------------------------------

test("win 5: archiveMarker answers absent fast, survives a body quoting the key, and reads a real marker", t => {
  const { store, owner } = fixture(t);
  const absent = { throughSeq: 0, count: 0, retainedIds: [], retainedJson: "[]" };
  assert.deepEqual(archiveMarker(store.db, "commons"), absent);
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "q", body: "look: \"messagesArchive\" is just text here" }));
  assert.deepEqual(archiveMarker(store.db, "commons"), absent, "a quoted key in a body is a probe false-positive, never a false marker");
  const state = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  state.messagesArchive = { throughSeq: 7, count: 4, retainedIds: ["keep-1"] };
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(state));
  assert.deepEqual(archiveMarker(store.db, "commons"), { throughSeq: 7, count: 4, retainedIds: ["keep-1"], retainedJson: "[\"keep-1\"]" });
});

test("win 5: roomAuthority reads the true authority even when member names quote the messages boundary", t => {
  const { store, owner } = fixture(t);
  const truth = store.room("commons").state;
  store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: "tricky", displayName: "x,\"messages\":[", kind: "agent", permissions: ["accept_work"] }));
  store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: "trickier", displayName: "a\"},\"messages\":[", kind: "agent", permissions: ["accept_work"] }));
  const authority = store.roomAuthority("commons");
  assert.equal(authority.ownerId, truth.room.ownerId);
  assert.deepEqual(Object.keys(authority.members).sort(), Object.keys(store.room("commons").state.members).sort());
  assert.equal(authority.members.tricky.displayName, "x,\"messages\":[");
});

// storedProjection is imported for the direct-serializer cases above; keep
// the module surface exercised at the unit level too.
test("serializer unit: storedProjection releases a body the new state drops, in the same call", t => {
  const { store, raw } = fixture(t, { bodiesAtRest: true });
  const state = store.room("commons").state;
  const withBody = structuredClone(state);
  withBody.messages = [{ id: "solo", authorId: "owner", body: big("solo"), channelId: "general", workItemId: null, replyToId: null, toMemberId: null, createdAt: 1 }];
  store.transaction(() => {
    store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(storedProjection(store.db, "commons", withBody, { enabled: true }), "commons");
  });
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM projection_bodies WHERE room_id='commons'").get().n, 1);
  const emptied = structuredClone(withBody); emptied.messages = [];
  store.transaction(() => {
    store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(storedProjection(store.db, "commons", emptied, { enabled: true }), "commons");
  });
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM projection_bodies WHERE room_id='commons'").get().n, 0);
  assert.doesNotMatch(raw(), /bodyRef/);
});
