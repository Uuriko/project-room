// Stage 0 directory outbox: the feed that will publish the monolith's
// room writes to the D1 directory (registry + seat index) and the public
// read model once D1 exists. The three proofs this slice owes:
// (a) atomicity — an outbox entry exists iff its write committed, exactly
//     one per committed event, in room-sequence order;
// (b) drain idempotency — replaying the same entries at the (fake) target
//     converges to the same directory state, with no duplicates;
// (c) the unwired production adapter fails safe — entries accumulate, no
//     attempts are burned, no error, and the job still schedules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  FakeD1Directory, appendOutboxEntry, backfillOutboxFromJournal,
  createUnwiredDirectoryAdapter, directoryAdapterForEnv, drainOutbox,
  outboxEntries, outboxPending, outboxStats, trimOutbox
} from "../server/directory-outbox.mjs";
import { jobByName } from "../server/jobs.mjs";

function openStore(roomId = "alpha", options = {}) {
  const store = new RoomStore(":memory:", { directoryOutbox: true, ...options });
  store.initialize(initialRoom(roomId));
  return store;
}

function post(store, id, body, roomId = "alpha") {
  const key = store.issueAccessKey(roomId, "owner");
  return store.command(key, roomId, { id: `cmd-${id}`, type: "message.posted", data: { body, messageId: id } });
}

test("atomicity: initialize writes one snapshot; each committed command writes exactly one entry, in order", () => {
  const store = openStore();
  try {
    let entries = outboxEntries(store);
    assert.equal(entries.length, 1, "room creation appends exactly one snapshot entry");
    assert.equal(entries[0].kind, "room_snapshot");
    assert.equal(entries[0].roomId, "alpha");
    assert.equal(entries[0].sequence, 2, "the snapshot sits at the room's sequence at commit");
    assert.equal(entries[0].payload.registry.title, "Project Room Commons");
    assert.equal(entries[0].payload.seats.length, 1, "the snapshot carries the founding seat");
    assert.equal(entries[0].payload.seats[0].memberId, "owner");

    post(store, "m1", "hello");
    post(store, "m2", "world");
    entries = outboxEntries(store);
    assert.equal(entries.length, 3, "one entry per committed command — no more, no fewer");
    const events = entries.filter(entry => entry.kind === "room_event");
    assert.deepEqual(events.map(entry => entry.sequence), [3, 4], "entries follow the room sequence");
    assert.deepEqual(events.map(entry => entry.payload.eventType), ["message.posted", "message.posted"]);
    assert.equal(events[0].payload.registry.sequence, 3);
    assert.ok(events[0].id < events[1].id, "the ordering key (id) is monotonic with the room sequence");
  } finally { store.db.close(); }
});

test("atomicity: a rolled-back transaction leaves no outbox entry", () => {
  const store = openStore();
  try {
    const before = outboxStats(store);
    // A direct append inside a transaction that then throws: the entry
    // must roll back with everything else — this is the atomicity point.
    assert.throws(() => store.transaction(() => {
      appendOutboxEntry(store.db, {
        roomId: "alpha", sequence: 99, kind: "room_event",
        payload: { v: 1, eventType: "message.posted" }, now: store.now()
      });
      throw new Error("boom");
    }), /boom/);
    assert.deepEqual(outboxStats(store), before, "the rolled-back append left nothing behind");

    // A command the reducer refuses also leaves nothing behind.
    const key = store.issueAccessKey("alpha", "owner");
    assert.throws(() => store.command(key, "alpha", { id: "cmd-bad", type: "message.posted", data: { body: "", messageId: "bad" } }));
    assert.deepEqual(outboxStats(store), before, "a refused command appended no entry");
  } finally { store.db.close(); }
});

test("atomicity: the feed is off by default — no table, no entries, no tax", () => {
  const store = new RoomStore(":memory:");
  try {
    store.initialize(initialRoom("alpha"));
    post(store, "m1", "hello");
    assert.deepEqual(outboxStats(store), { total: 0, pending: 0, acked: 0 });
    assert.equal(outboxPending(store), false);
  } finally { store.db.close(); }
});

test("drain idempotency: replaying the same entries converges to the same directory state", async () => {
  const store = openStore();
  try {
    post(store, "m1", "hello");
    post(store, "m2", "world");
    const fake = new FakeD1Directory();
    const first = await drainOutbox(store, { adapter: fake });
    assert.equal(first.drained, 3);
    assert.equal(first.pending, 0);
    const snapshotAfterFirst = fake.snapshot();
    assert.equal(snapshotAfterFirst.registry.length, 1);
    assert.equal(snapshotAfterFirst.registry[0].sequence, 4, "the registry sits at the room head");
    assert.equal(snapshotAfterFirst.seats.length, 1);

    // Replay: hand the fake the very same entries again (at-least-once
    // delivery after a crash between apply and ack). State must not move.
    const replay = outboxEntries(store);
    const result = await fake.apply(replay);
    assert.equal(result.acked.length, replay.length, "replays are acked again (safe to mark)");
    assert.deepEqual(fake.snapshot().registry, snapshotAfterFirst.registry);
    assert.deepEqual(fake.snapshot().seats, snapshotAfterFirst.seats);
    assert.ok(fake.duplicatesSkipped >= 3, "every replayed entry was deduped by (room, sequence, kind)");

    // A second drain finds nothing pending and changes nothing.
    const second = await drainOutbox(store, { adapter: fake });
    assert.equal(second.drained, 0);
    assert.deepEqual(fake.snapshot().registry, snapshotAfterFirst.registry);
  } finally { store.db.close(); }
});

test("drain: deadline discipline — a starved tick drains nothing, the next tick resumes and finishes", async () => {
  const store = openStore();
  try {
    post(store, "m1", "hello");
    post(store, "m2", "world");
    const fake = new FakeD1Directory();
    const starved = await drainOutbox(store, { adapter: fake, deadline: Date.now() - 1 });
    assert.equal(starved.drained, 0);
    assert.equal(starved.budgetExceeded, 1, "the starved tick names its budget exhaustion");
    assert.equal(outboxStats(store).pending, 3, "nothing was acked by the starved tick");
    const resumed = await drainOutbox(store, { adapter: fake });
    assert.equal(resumed.drained, 3, "the due-scan cursor resumes where the starved tick stopped");
    assert.equal(resumed.pending, 0);
  } finally { store.db.close(); }
});

test("stub adapter fails safe: entries accumulate, attempts stay zero, the job stays healthy and armed", async () => {
  const store = openStore();
  try {
    post(store, "m1", "hello");
    const stub = createUnwiredDirectoryAdapter();
    assert.equal(stub.wired, false);
    assert.equal(directoryAdapterForEnv({}).wired, false, "production selection is the unwired stub until D1 exists");
    const result = await drainOutbox(store, { adapter: stub });
    assert.equal(result.wired, false);
    assert.equal(result.drained, 0);
    assert.equal(result.pending, 2, "entries accumulate against the unwired target");
    const entries = outboxEntries(store);
    assert.ok(entries.every(entry => entry.attempts === 0), "no attempts are burned on a missing binding");
    assert.ok(entries.every(entry => entry.ackedAt == null), "nothing is acked or trimmed");

    const job = jobByName("directory-outbox");
    assert.ok(job, "the drain is a registered job");
    assert.equal(job.enabled({}, store), true, "pending entries arm the job");
    const tick = await job.run(store, { env: {}, deadline: Date.now() + 5000 });
    assert.equal(tick.wired, false);
    assert.equal(tick.errors, undefined, "the unwired tick is not a failure");
  } finally { store.db.close(); }
});

test("retention: only acked entries trim, and only beyond the retained window", async () => {
  const store = openStore();
  try {
    for (let i = 0; i < 5; i++) post(store, `m${i}`, `body ${i}`);
    const fake = new FakeD1Directory();
    await drainOutbox(store, { adapter: fake });
    assert.equal(outboxStats(store).acked, 6);
    assert.equal(trimOutbox(store, { keepAcked: 2 }), 4, "acked entries beyond the window trim");
    assert.equal(outboxStats(store).total, 2);

    post(store, "late", "not yet drained");
    assert.equal(trimOutbox(store, { keepAcked: 0 }), 2, "the retained acked window trims to zero when asked");
    assert.equal(outboxStats(store).pending, 1, "the unacked entry is never trimmed");
    assert.equal(outboxStats(store).total, 1);
  } finally { store.db.close(); }
});

test("backfill: journal sequences the hooked writers did not cover gain watermark entries", () => {
  const store = new RoomStore(":memory:"); // feed off: nothing hooked
  try {
    store.initialize(initialRoom("alpha"));
    post(store, "m1", "hello");
    // Turn the feed on after the fact (the operator-wires-D1 day): the
    // reconciler seed backfills from the journal in the store's own txn.
    store.directoryOutboxEnabled = true;
    const result = store.transaction(() => backfillOutboxFromJournal(store));
    assert.equal(result.appended, 3, "room_created + member_added + the post are all watermarked");
    const entries = outboxEntries(store);
    assert.deepEqual(entries.map(entry => entry.sequence), [1, 2, 3]);
    assert.ok(entries.every(entry => entry.payload.backfilled === true));
    const again = store.transaction(() => backfillOutboxFromJournal(store));
    assert.equal(again.appended, 0, "backfill is itself idempotent");
  } finally { store.db.close(); }
});
