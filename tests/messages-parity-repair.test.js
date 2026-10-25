import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { JOBS } from "../server/jobs.mjs";
import { runCronJobs, applyOutcomes, jobHealthView } from "../cloudflare/job-heartbeat.mjs";
import { repairMessagesParityDrift, MESSAGES_PARITY_REPAIR_EVENT_CEILING } from "../server/messages-store.mjs";

// PARITY-REPAIR-1 acceptance fixtures (charter §5). A caught-up room whose
// messages table drifts from its projection is the NO-PATH parity row:
// before this repair, no tick step could ever clear it. The repair
// re-derives the table from the event log and re-earns certification
// against the untouched live projection — fixture 4 is the
// anti-laundering pin: projection-side drift must still fail.

const integrityJob = JOBS.find(job => job.name === "integrity");

function open(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "messages-parity-repair-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { integrity: "deferred", ...options });
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function setup(t, options = {}) {
  const store = open(t, options);
  const roomId = "commons";
  store.initialize(initialRoom(roomId));
  const key = store.issueAccessKey(roomId, "owner");
  const post = (messageId, body) => store.command(key, roomId,
    { id: randomUUID(), type: "message.posted", data: { messageId, body } });
  const certify = () => {
    for (let i = 0; i < 50 && !store.backfillMessages({ limit: 1000 }).done; i++) {}
    assert.equal(store.checkMessagesParity({ roomId }).ok, true, "room certifies before the tamper");
  };
  const visit = () => store.runIntegrityParityStep();
  const failure = () => store.db.prepare(
    "SELECT failures FROM integrity_failures WHERE step='messages_parity' AND record_id=?").get(roomId);
  const row = messageId => store.db.prepare(
    "SELECT * FROM messages WHERE room_id=? AND message_id=?").get(roomId, messageId);
  const rows = () => store.db.prepare(
    "SELECT * FROM messages WHERE room_id=? ORDER BY message_id").all(roomId);
  return { store, roomId, post, certify, visit, failure, row, rows };
}

test("fixture 1 (P1): a deleted table row heals on the gated repair visit, never the first", t => {
  const f = setup(t);
  f.post("m1", "first");
  f.post("m2", "second");
  f.post("m3", "third");
  f.certify();
  f.store.db.prepare("DELETE FROM messages WHERE room_id=? AND message_id='m2'").run(f.roomId);

  // A deadline-aborted direct repair writes nothing at all.
  const aborted = repairMessagesParityDrift(f.store, f.roomId, { deadline: 0 });
  assert.equal(aborted.aborted, true);
  assert.equal(f.row("m2"), undefined);

  const first = f.visit();
  assert.equal(first.parityRepairs, undefined, "no repair attempt on the visit that first records the failure");
  assert.equal(f.failure()?.failures, 1);
  assert.equal(f.row("m2"), undefined, "the first failure visit does not repair");

  const second = f.visit();
  assert.deepEqual(second.parityRepairs, [{ roomId: f.roomId, outcome: "healed" }]);
  assert.equal(f.row("m2")?.body, "second", "the missing row is re-inserted from the log at its posting sequence");
  assert.equal(f.failure(), undefined, "the standing parity row clears");
  assert.equal(f.store.checkMessagesParity({ roomId: f.roomId }).ok, true);
});

test("fixture 1 (P1 orphan variant): a row absent from state and log is deleted; a logged row never is", t => {
  const f = setup(t);
  f.post("m1", "first");
  f.post("m2", "second");
  f.certify();
  const before = f.rows();
  f.store.db.prepare(`INSERT INTO messages (room_id, message_id, seq, author_id, body, created_at, pinned, record_json)
    VALUES (?, 'ghost', 999, 'owner', 'debris', '2026-10-02T00:00:00.000Z', 0, '{}')`).run(f.roomId);
  f.visit();
  assert.equal(f.failure()?.failures, 1);
  const second = f.visit();
  assert.deepEqual(second.parityRepairs, [{ roomId: f.roomId, outcome: "healed" }]);
  assert.equal(f.row("ghost"), undefined, "the provably-absent orphan is deleted");
  assert.deepEqual(f.rows(), before, "every logged row survives byte-for-byte");
});

test("fixture 1/4 (P4 seq leg): posting-seq drift is corrected from the replay's provenance", t => {
  const f = setup(t);
  f.post("m1", "first");
  f.post("m2", "second");
  f.post("m3", "third");
  f.certify();
  const originalSeq = f.row("m2").seq;
  f.store.db.prepare("UPDATE messages SET seq=seq+100 WHERE room_id=? AND message_id='m2'").run(f.roomId);
  f.visit();
  const second = f.visit();
  assert.deepEqual(second.parityRepairs, [{ roomId: f.roomId, outcome: "healed" }]);
  assert.equal(f.row("m2")?.seq, originalSeq);
  assert.equal(f.failure(), undefined);
});

test("fixture 2 (P4): a corrupted record_json heals through the same gated path", t => {
  const f = setup(t);
  f.post("m1", "first");
  f.post("m2", "second");
  f.certify();
  f.store.db.prepare("UPDATE messages SET record_json='{\"broken\"' WHERE room_id=? AND message_id='m2'").run(f.roomId);
  f.visit();
  assert.equal(f.failure()?.failures, 1);
  const second = f.visit();
  assert.deepEqual(second.parityRepairs, [{ roomId: f.roomId, outcome: "healed" }]);
  const record = JSON.parse(f.row("m2").record_json);
  assert.equal(record.body, "second");
  assert.equal(f.failure(), undefined);
});

test("fixture 3 (P2): a missing spilled body is re-spilled hash-gated and the room heals", t => {
  const long = "L".repeat(300);
  const f = setup(t, { bodiesAtRest: true });
  f.post("m-long", long);
  f.post("m-short", "short");
  f.certify();
  const stored = JSON.parse(f.store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(f.roomId).projection);
  const ref = stored.messages.find(message => message.id === "m-long")?.bodyRef;
  assert.match(ref ?? "", /^[0-9a-f]{64}$/, "precondition: the long body is stored by reference");
  f.store.db.prepare("DELETE FROM projection_bodies WHERE room_id=? AND sha=?").run(f.roomId, ref);
  f.visit();
  assert.equal(f.failure()?.failures, 1);
  const second = f.visit();
  assert.deepEqual(second.parityRepairs, [{ roomId: f.roomId, outcome: "healed" }]);
  assert.equal(
    f.store.db.prepare("SELECT body FROM projection_bodies WHERE room_id=? AND sha=?").get(f.roomId, ref)?.body,
    long, "the body row is restored from the log, byte for byte");
  assert.equal(f.failure(), undefined);
});

test("fixture 3 variant (P2 gate): log bytes that no longer hash to bodyRef write nothing and stand", t => {
  const long = "L".repeat(300);
  const f = setup(t, { bodiesAtRest: true });
  f.post("m-long", long);
  f.certify();
  const stored = JSON.parse(f.store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(f.roomId).projection);
  const ref = stored.messages.find(message => message.id === "m-long")?.bodyRef;
  f.store.db.prepare("DELETE FROM projection_bodies WHERE room_id=? AND sha=?").run(f.roomId, ref);
  // Alter the logged body: the replay now derives bytes the projection's
  // bodyRef does not name, so the hash gate must refuse the re-spill.
  f.store.db.prepare(`UPDATE events SET body=json_set(body, '$.data.body', ?)
    WHERE room_id=? AND json_extract(body, '$.type')='message.posted' AND json_extract(body, '$.data.messageId')='m-long'`)
    .run("A".repeat(300), f.roomId);
  f.visit();
  const second = f.visit();
  assert.deepEqual(second.parityRepairs, [{ roomId: f.roomId, outcome: "projection_divergent" }]);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM projection_bodies WHERE room_id=?").get(f.roomId).n, 0,
    "the gate wrote no body row");
  assert.equal(f.row("m-long")?.body, long, "the table was not rewritten from the altered log either");
  assert.ok(f.failure(), "the parity row stands");
});

test("fixture 4 (ANTI-LAUNDERING): projection-side drift still fails after the repair", t => {
  const f = setup(t);
  f.post("m1", "first");
  f.post("m2", "second");
  f.post("m3", "third");
  f.certify();
  const tableBefore = f.rows();
  const raw = f.store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(f.roomId).projection;
  const projection = JSON.parse(raw);
  projection.messages = projection.messages.filter(message => message.id !== "m2");
  f.store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(projection), f.roomId);

  f.visit();
  assert.equal(f.failure()?.failures, 1);
  const second = f.visit();
  assert.deepEqual(second.parityRepairs, [{ roomId: f.roomId, outcome: "projection_divergent" }],
    "table reconciled to the log, room still fails against the untouched projection");
  assert.deepEqual(f.rows(), tableBefore, "the table already agreed with the log; nothing was rewritten to match the projection");
  const after = JSON.parse(f.store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(f.roomId).projection);
  assert.equal(after.messages.some(message => message.id === "m2"), false, "the projection was never written by the repair");
  assert.ok(f.failure(), "the parity row stands — the repair cannot launder a projection-side loss into a pass");
});

test("fixture 5 (P3): an archived-count mismatch stands, classified archive_marker, marker untouched", t => {
  const f = setup(t);
  for (let i = 1; i <= 5; i++) f.post(`m${i}`, `body ${i}`);
  f.certify();
  const archived = f.store.archiveMessages(f.roomId, { keepNewest: 2, dryRun: false });
  assert.equal(archived.ok, true);
  assert.equal(archived.archived, 3);
  assert.equal(f.store.checkMessagesParity({ roomId: f.roomId }).ok, true, "the archived room still certifies");
  f.store.db.prepare("UPDATE rooms SET projection=json_set(projection, '$.messagesArchive.count', 99) WHERE id=?").run(f.roomId);

  f.visit();
  assert.equal(f.failure()?.failures, 1);
  const second = f.visit();
  assert.deepEqual(second.parityRepairs, [{ roomId: f.roomId, outcome: "archive_marker" }]);
  const marker = JSON.parse(f.store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(f.roomId).projection).messagesArchive;
  assert.equal(marker.count, 99, "the repair never recomputes or touches the archive marker");
  assert.equal(f.rows().length, 5, "no archived row was rewritten either");
  assert.ok(f.failure(), "the parity row stands for the operator archive route");
});

test("fixture 6: never on first failure; an out-of-band fix certifies through the ordinary sweep", t => {
  const f = setup(t);
  f.post("m1", "first");
  f.post("m2", "second");
  f.certify();
  f.store.db.prepare("UPDATE messages SET body='drifted' WHERE room_id=? AND message_id='m2'").run(f.roomId);
  const first = f.visit();
  assert.equal(first.parityRepairs, undefined, "the first-recording visit attempts no repair");
  assert.equal(f.failure()?.failures, 1);
  assert.equal(f.row("m2")?.body, "drifted", "the drift survives the first failure visit");
  // Out-of-band fix before the first gated attempt (failures would cross
  // 2 on the next recording): the ordinary sweep certifies the room and
  // clears the row, and no repair ever runs.
  f.store.db.prepare("UPDATE messages SET body='second' WHERE room_id=? AND message_id='m2'").run(f.roomId);
  const second = f.visit();
  assert.equal(second.parityRepairs, undefined, "no repair ran — the sweep pass cleared the row");
  assert.equal(f.failure(), undefined);
  assert.equal(f.store.checkMessagesParity({ roomId: f.roomId }).ok, true);
});

test("fixture 7 (ceiling): a room past the event ceiling is deferred and never replayed by the tick leg", t => {
  assert.equal(MESSAGES_PARITY_REPAIR_EVENT_CEILING, 25000);
  const f = setup(t);
  f.post("m1", "first");
  f.post("m2", "second");
  f.certify();
  f.store.db.prepare("DELETE FROM messages WHERE room_id=? AND message_id='m2'").run(f.roomId);
  // Pad the room's event log past the ceiling with non-message events.
  // The ceiling gate reads the log's row count, so the surplus rows past
  // the head stand in for a large log exactly where the gate reads it.
  const head = f.store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(f.roomId).sequence;
  f.store.transaction(() => {
    const insert = f.store.db.prepare("INSERT INTO events VALUES (?, ?, ?, ?)");
    for (let i = 1; i <= MESSAGES_PARITY_REPAIR_EVENT_CEILING + 1; i++) {
      insert.run(f.roomId, head + i, `pad-${i}`, JSON.stringify({ type: "note.added", data: {} }));
    }
  });
  const direct = repairMessagesParityDrift(f.store, f.roomId);
  assert.equal(direct.outcome, "repair_deferred_ceiling");
  assert.equal(direct.attempted, false);
  f.visit();
  const second = f.visit();
  assert.deepEqual(second.parityRepairs, [{ roomId: f.roomId, outcome: "repair_deferred_ceiling" }]);
  assert.equal(f.row("m2"), undefined, "the tick leg never replayed the room: the drift is untouched");
  assert.ok(f.failure(), "the parity row stands");
});

test("fixture 8 (success-condition closure): the repaired row was the only one outstanding; the tick succeeds", async t => {
  const f = setup(t);
  f.post("m1", "first");
  f.post("m2", "second");
  f.certify();
  f.store.db.prepare("DELETE FROM messages WHERE room_id=? AND message_id='m2'").run(f.roomId);
  f.visit();
  assert.deepEqual(f.store.integrityFailures().map(row => row.step), ["messages_parity"],
    "the parity row is the store's only outstanding failure");

  let stored = {};
  let at = Date.now();
  const tickJob = async () => {
    const outcomes = await runCronJobs({ integrity: () => integrityJob.run(f.store, {
      room: { verifyRoomIntegrity: () => f.store.verifyRoomIntegrity({ deadline: Date.now() + 10000 }) }
    }) }, { now: () => at, log() {} });
    stored = applyOutcomes(stored, outcomes);
    return jobHealthView(stored, at).jobs.find(job => job.name === "integrity");
  };
  const failing = await tickJob();
  assert.ok(failing.consecutiveFailures >= 1, "while the NO-PATH row stands, every tick fails");
  assert.ok(!failing.lastSuccessAt, "lastSuccessAt does not advance");

  const second = f.visit();
  assert.deepEqual(second.parityRepairs, [{ roomId: f.roomId, outcome: "healed" }]);
  assert.deepEqual(f.store.integrityFailures(), [], "no outstanding rows remain");

  at += 60_000;
  const recovered = await tickJob();
  assert.equal(recovered.consecutiveFailures, 0, "the tick succeeds once the repaired row clears");
  assert.equal(recovered.lastSuccessAt, new Date(at).toISOString(), "lastSuccessAt advances to the succeeding tick");
});
