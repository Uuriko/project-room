import test from "node:test";
import assert from "node:assert/strict";
import { JOBS } from "../server/jobs.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// #4930 CURE (follow-up to the narrowed parked-summary partition):
// independent review at head 87188ace (room seqs 23355/23365/23366,
// evidence outputs/integrity-4930-classification-matrix.json) confirmed
// three false-success cases in the messages_backfill classification.
// A failure was downgraded to parked whenever it was not recognisable
// as a log gap — without any positive evidence that the room is in
// fact parked on a stored event. These tests pin the cured contract:
//
//   Downgrade a failure to parked ONLY on a positively corroborated
//   same-room durable block with a non-null event_id. Missing,
//   unreadable, or mismatched block maps stay FATAL. The #3855 guard's
//   coverage is checked as an identity set, never counts.
//
// The scenarios follow the reviewer's probe shape: the real integrity
// job, an injected scan summary (ctx.room.verifyRoomIntegrity), and a
// fake store whose messages_backfill_blocks reads are scripted per
// case. The three regression cases FAIL at 87188ace (each returns a
// clean summary with no errors there) and pass at the cured head; the
// controls pass at both heads and pin the preserved contract.
//
// Vc RULING (b) FOLLOW-UP (John's Tab, room seq 23428, ruling id
// integrity-4930-vc-ruling-02): at the first cured head a same-room
// durable block whose event_id is "ev-UNRELATED-999" — an event that
// does not exist — still corroborated and parked a failure, because
// runMessagesBackfill returns an event identity but
// runIntegrityBackfillStep dropped it, so integrity_failures records
// carried no event identity and the partition never checked the
// block's event against the stored log. The Vc cases below pin the
// strengthened contract: corroboration requires the block's
// (room_id, event_id, sequence) to match a REAL stored event for that
// room, and a failure carrying a threaded event identity parks only
// when that identity matches the validated block. The specimen cases
// FAIL at 793024b2 (each parks there) and pass at the Vc head; the
// genuine-park controls pass at both heads.

const integrity = JOBS.find(job => job.name === "integrity");

const FAILED = result => Boolean(result.scanError) || Number(result.errors) > 0;

// Scripted store. `blockRows` is what the partition's block-map read
// returns (or `blockReadError` makes that read throw, the injected
// block-map SQL read failure from seq 23366). `eventRows` is the
// stored event log the Vc cure validates blocks against: the fake
// computes the partition's block/event join from the two scripted
// sets, exactly as the SQL join does in a real store (room, event id
// and sequence must all match); `eventReadError` makes that
// validation read throw. `standing` describes the durable set the
// post-scan observation sees: `n`/`gapBlocks` ride the aggregate
// count query, `standingRows` rides the room-id query the cured
// guard uses for identity coverage. Any other SQL throws, which
// the job's own heal/observation guards already tolerate.
function fakeStore({ blockRows = [], blockReadError = false, eventRows = [], eventReadError = false, standingRows = null, n = 0, gapBlocks = 0 } = {}) {
  const standing = standingRows ?? blockRows;
  return {
    db: {
      prepare(sql) {
        if (sql.startsWith("SELECT 1 AS found FROM events")) {
          // The recovery leg's per-failure identity validation: does
          // the failure record's threaded (room, event id, sequence)
          // name a real stored event?
          if (eventReadError) throw new Error("injected event-validation read failure");
          return {
            get: (roomId, eventId, sequence) => eventRows.some(event => event.room_id === roomId
              && event.id === eventId && event.sequence === sequence) ? { found: 1 } : undefined,
            all: () => []
          };
        }
        if (sql.includes("JOIN events")) {
          if (eventReadError) throw new Error("injected event-validation read failure");
          const joined = blockRows.filter(block => block.event_id != null
            && eventRows.some(event => event.room_id === block.room_id
              && event.id === block.event_id && event.sequence === block.sequence));
          return { all: () => joined, get: () => joined[0] };
        }
        if (sql.startsWith("SELECT room_id, event_id")) {
          if (blockReadError) throw new Error("injected block-map read failure");
          return { all: () => blockRows, get: () => blockRows[0] };
        }
        if (sql.includes("SELECT room_id FROM messages_backfill_blocks")) {
          return { all: () => standing, get: () => standing[0] };
        }
        if (sql.includes("AS n")) {
          return {
            get: () => ({
              n, gapBlocks, quarantined: 0,
              blockReason: "", blockComponent: "", anyReason: "", anyComponent: ""
            }),
            all: () => []
          };
        }
        throw new Error("unexpected SQL in fake store");
      }
    }
  };
}

const backfillFailure = (recordId, message = "Unclassified backfill failure") =>
  ({ step: "messages_backfill", recordId, message, firstSeenAt: 1750 });

const tick = (store, failures) => integrity.run(store, {
  deadline: Date.now() + 5000,
  room: { verifyRoomIntegrity: async () => ({ failures, verifiedRooms: 0 }) }
});

// --- The three false-success cases (room seq 23366) -------------------

test("missing durable block: an empty block table does not park a backfill failure", async () => {
  // Seq 23355's specimen: empty blocks table plus a messages_backfill
  // failure for commons. Baseline jobs returns errors 1; the defective
  // candidate returned blockedFailures 1 / blockedRooms 0, no errors.
  const result = await tick(fakeStore({ blockRows: [], n: 0 }), [backfillFailure("commons")]);
  assert.ok(FAILED(result), "a backfill failure with no durable block must fail the tick");
  assert.equal(result.errors, 1);
  assert.equal(result.failureDetail?.subcheck, "messages_backfill");
  assert.equal(result.failureDetail?.recordId, "commons");
  assert.equal(result.blockedFailures, undefined, "an uncorroborated failure never rides the parked summary");
});

test("block-map read failure: an unreadable block map fails closed, never parks", async () => {
  const result = await tick(
    fakeStore({ blockReadError: true, standingRows: [{ room_id: "commons", event_id: "ev-1" }], n: 1, gapBlocks: 0 }),
    [backfillFailure("commons")]
  );
  assert.ok(FAILED(result), "a failure whose block map cannot be read must fail the tick");
  assert.equal(result.errors, 1);
  assert.equal(result.failureDetail?.subcheck, "messages_backfill");
  assert.equal(result.blockedFailures, undefined);
});

test("mismatched block map: another room's event block does not park this room's failure", async () => {
  // Seq 23366's mismatched case: the scan record is commons, the only
  // standing block belongs to another room, counts are equal (1 === 1)
  // and the defective candidate still reported no errors.
  const result = await tick(
    fakeStore({ blockRows: [{ room_id: "other-room", event_id: "ev-other" }], n: 1, gapBlocks: 0 }),
    [backfillFailure("commons")]
  );
  assert.ok(FAILED(result), "a block for a different room must not park this room's failure");
  assert.equal(result.errors, 1);
  assert.equal(result.failureDetail?.recordId, "commons");
  assert.equal(result.blockedRooms, 1, "the other room's standing block is still reported as a count");
  assert.equal(result.blockedFailures, undefined);
});

test("#3855 guard identity coverage: a standing block for a different room is not covered by an equal parked count", async () => {
  // Blocks change during the scan: room aaa is positively parked when
  // the partition reads the map, but by the post-scan observation the
  // standing block belongs to other-room. Count equality (1 === 1)
  // satisfied the old guard; identity coverage must not suppress it.
  const result = await tick(
    fakeStore({
      blockRows: [{ room_id: "aaa", event_id: "ev-aaa", sequence: 3 }],
      eventRows: [{ room_id: "aaa", id: "ev-aaa", sequence: 3 }],
      standingRows: [{ room_id: "other-room", event_id: "ev-other" }],
      n: 1, gapBlocks: 0
    }),
    [backfillFailure("aaa")]
  );
  assert.ok(FAILED(result), "the guard must force-fail a standing block the scan did not itself park");
  assert.equal(result.errors, 1);
  assert.equal(result.failureDetail?.subcheck, "messages_backfill");
  assert.equal(result.blockedFailures, 1, "aaa's park still rides the summary; the guard adds the failure for the uncovered block");
});

// --- Controls: the preserved contract ---------------------------------

test("control: a matching event-backed block remains parked", async () => {
  const result = await tick(
    fakeStore({
      blockRows: [{ room_id: "aaa", event_id: "ev-aaa", sequence: 3 }],
      eventRows: [{ room_id: "aaa", id: "ev-aaa", sequence: 3 }],
      n: 1, gapBlocks: 0
    }),
    [backfillFailure("aaa")]
  );
  assert.ok(!FAILED(result), "a positively corroborated event park does not fail the tick");
  assert.equal(result.errors, undefined);
  assert.equal(result.blockedFailures, 1);
  assert.equal(result.blockedRooms, 1);
  assert.equal(result.blockedSince, 1750);
});

test("control: a matching null-event (log-gap) block stays fatal", async () => {
  const result = await tick(
    fakeStore({ blockRows: [{ room_id: "commons", event_id: null }], n: 1, gapBlocks: 1 }),
    [backfillFailure("commons")]
  );
  assert.ok(FAILED(result), "a log-gap park (event_id NULL) stays fatal");
  assert.equal(result.errors, 1);
  assert.equal(result.blockedFailures, undefined);
});

test("control: explicit log-gap message text stays fatal even beside an event block", async () => {
  const result = await tick(
    fakeStore({ blockRows: [{ room_id: "commons", event_id: "ev-1" }], n: 1, gapBlocks: 0 }),
    [backfillFailure("commons", "messages backfill stopped at 42: the log ends before the room head")]
  );
  assert.ok(FAILED(result), "the allowlisted backfill-stop line stays fatal");
  assert.equal(result.errors, 1);
  assert.equal(result.blockedFailures, undefined);
});

test("control: a parity failure stays fatal and is never parked", async () => {
  const result = await tick(
    fakeStore({ blockRows: [], n: 0 }),
    [{ step: "messages_parity", recordId: "mid", message: "messages parity failed for mid" }]
  );
  assert.ok(FAILED(result), "a parity failure fails the tick");
  assert.equal(result.errors, 1);
  assert.equal(result.failureDetail?.subcheck, "messages_parity");
  assert.equal(result.blockedFailures, undefined);
});

test("control: a corroborated park never masks a fatal failure beside it", async () => {
  const result = await tick(
    fakeStore({
      blockRows: [{ room_id: "aaa", event_id: "ev-aaa", sequence: 3 }],
      eventRows: [{ room_id: "aaa", id: "ev-aaa", sequence: 3 }],
      n: 1, gapBlocks: 0
    }),
    [
      backfillFailure("aaa"),
      { step: "messages_parity", recordId: "mid", message: "messages parity failed for mid" }
    ]
  );
  assert.ok(FAILED(result), "the parity failure still fails the tick");
  assert.equal(result.errors, 1, "only the fatal failure counts as an error");
  assert.equal(result.failureDetail?.subcheck, "messages_parity");
  assert.equal(result.failureDetail?.recordId, "mid");
  assert.equal(result.blockedFailures, 1, "the park still rides the failing summary as its own number");
});

// --- Vc ruling (b): event-validated corroboration (room seq 23428) ----

test("Vc specimen: a same-room block naming a nonexistent event does not park an unrelated failure", async () => {
  // The reviewer's manually seeded probe at 793024b2: the block row is
  // same-room and carries a non-null event_id, so the first cure parked
  // the failure — but no event with that id exists in the stored log.
  const result = await tick(
    fakeStore({
      blockRows: [{ room_id: "commons", event_id: "ev-UNRELATED-999", sequence: 7 }],
      eventRows: [{ room_id: "commons", id: "ev-real", sequence: 3 }],
      n: 1, gapBlocks: 0
    }),
    [backfillFailure("commons")]
  );
  assert.ok(FAILED(result), "a block naming a nonexistent event is not corroboration: the failure stays fatal");
  assert.equal(result.errors, 1);
  assert.equal(result.failureDetail?.subcheck, "messages_backfill");
  assert.equal(result.failureDetail?.recordId, "commons");
  assert.equal(result.blockedFailures, undefined, "an unvalidated block never rides the parked summary");
});

test("Vc: a block naming another room's real event does not park this room's failure", async () => {
  // The named event exists — in a different room. Room, event and
  // sequence must all match the block's own room.
  const result = await tick(
    fakeStore({
      blockRows: [{ room_id: "commons", event_id: "ev-elsewhere", sequence: 3 }],
      eventRows: [{ room_id: "other-room", id: "ev-elsewhere", sequence: 3 }],
      n: 1, gapBlocks: 0
    }),
    [backfillFailure("commons")]
  );
  assert.ok(FAILED(result), "an event stored under another room does not validate this room's block");
  assert.equal(result.errors, 1);
  assert.equal(result.blockedFailures, undefined);
});

test("Vc: a block whose sequence does not match the stored event does not park", async () => {
  const result = await tick(
    fakeStore({
      blockRows: [{ room_id: "commons", event_id: "ev-real", sequence: 9 }],
      eventRows: [{ room_id: "commons", id: "ev-real", sequence: 3 }],
      n: 1, gapBlocks: 0
    }),
    [backfillFailure("commons")]
  );
  assert.ok(FAILED(result), "the stored event sits at a different sequence than the block claims");
  assert.equal(result.errors, 1);
  assert.equal(result.blockedFailures, undefined);
});

test("Vc: a failure whose threaded event identity differs from the block's does not park", async () => {
  // The block names a real stored event, but the failure record's own
  // structured identity (threaded from runMessagesBackfill through
  // runIntegrityBackfillStep) names a different event: this failure is
  // not the failure that block corroborates.
  const failure = { ...backfillFailure("commons"), eventId: "ev-different", eventSequence: 5 };
  const result = await tick(
    fakeStore({
      blockRows: [{ room_id: "commons", event_id: "ev-real", sequence: 3 }],
      eventRows: [{ room_id: "commons", id: "ev-real", sequence: 3 }],
      n: 1, gapBlocks: 0
    }),
    [failure]
  );
  assert.ok(FAILED(result), "a mismatched threaded identity is not corroboration");
  assert.equal(result.errors, 1);
  assert.equal(result.blockedFailures, undefined);
});

test("Vc: an unreadable stored-event log fails closed, never parks", async () => {
  const result = await tick(
    fakeStore({
      blockRows: [{ room_id: "commons", event_id: "ev-real", sequence: 3 }],
      eventRows: [{ room_id: "commons", id: "ev-real", sequence: 3 }],
      eventReadError: true,
      n: 1, gapBlocks: 0
    }),
    [backfillFailure("commons")]
  );
  assert.ok(FAILED(result), "validation evidence that cannot be read cannot corroborate");
  assert.equal(result.errors, 1);
  assert.equal(result.blockedFailures, undefined);
});

test("Vc control: a block naming a real stored event for that room parks", async () => {
  const result = await tick(
    fakeStore({
      blockRows: [{ room_id: "commons", event_id: "ev-real", sequence: 3 }],
      eventRows: [{ room_id: "commons", id: "ev-real", sequence: 3 }],
      n: 1, gapBlocks: 0
    }),
    [backfillFailure("commons")]
  );
  assert.ok(!FAILED(result), "a block validated against the stored log still parks");
  assert.equal(result.errors, undefined);
  assert.equal(result.blockedFailures, 1);
  assert.equal(result.blockedRooms, 1);
  assert.equal(result.blockedSince, 1750);
});

test("Vc control: a failure whose threaded identity matches the validated block parks", async () => {
  const failure = { ...backfillFailure("commons"), eventId: "ev-real", eventSequence: 3 };
  const result = await tick(
    fakeStore({
      blockRows: [{ room_id: "commons", event_id: "ev-real", sequence: 3 }],
      eventRows: [{ room_id: "commons", id: "ev-real", sequence: 3 }],
      n: 1, gapBlocks: 0
    }),
    [failure]
  );
  assert.ok(!FAILED(result), "matching threaded identity plus a validated block parks");
  assert.equal(result.errors, undefined);
  assert.equal(result.blockedFailures, 1);
  assert.equal(result.blockedRooms, 1);
});

// --- Recovery regression (John's Tab re-qualification, room seq 23565) -
//
// At both cured heads the parked-summary recovery case failed: after an
// operator repair (the event fixed in place, the log re-imported), the
// import lifts the park — block row and cursor are deleted — but the
// durable failure record, now carrying the threaded identity of the
// event it parked on, stays outstanding until the rotating backfill
// step next visits the room and clears it. The narrowed partition only
// corroborated via a standing block, so every tick in that window went
// fatal ("no tick fails during recovery" failed). At the pre-cure head
// 87188ace the window rode as parked and the case passed 5/5. The
// recovery leg below restores that window on positive evidence only:
// no standing block for the room, a threaded identity on the record,
// and that identity validated against a real stored event.

test("recovery: a lifted park whose record carries a validated threaded identity does not fail the tick", async () => {
  // Repair lifted the block (empty block table), but the failure record
  // — written while the park stood, with the block's identity threaded
  // onto it — has not been cleared by the backfill step yet. The named
  // event is real: it is the event the room parked on, since repaired.
  const failure = { ...backfillFailure("aaa"), eventId: "ev-standin", eventSequence: 3 };
  const result = await tick(
    fakeStore({
      blockRows: [],
      eventRows: [{ room_id: "aaa", id: "ev-standin", sequence: 3 }],
      n: 0, gapBlocks: 0
    }),
    [failure]
  );
  assert.ok(!FAILED(result), "a recovering room's stale record must not fail the tick while the backfill step catches up");
  assert.equal(result.errors, undefined);
  assert.equal(result.blockedFailures, 1, "the recovering record still rides the summary as its own number");
  assert.equal(result.blockedRooms, 0, "no standing block remains — the park was lifted");
});

test("recovery: a lifted park whose threaded identity names a nonexistent event stays fatal", async () => {
  const failure = { ...backfillFailure("aaa"), eventId: "ev-UNRELATED-999", eventSequence: 7 };
  const result = await tick(
    fakeStore({
      blockRows: [],
      eventRows: [{ room_id: "aaa", id: "ev-real", sequence: 3 }],
      n: 0, gapBlocks: 0
    }),
    [failure]
  );
  assert.ok(FAILED(result), "an identity that does not validate against the stored log is not recovery evidence");
  assert.equal(result.errors, 1);
  assert.equal(result.blockedFailures, undefined);
});

test("recovery: a lifted park whose threaded identity sits at the wrong sequence stays fatal", async () => {
  const failure = { ...backfillFailure("aaa"), eventId: "ev-standin", eventSequence: 9 };
  const result = await tick(
    fakeStore({
      blockRows: [],
      eventRows: [{ room_id: "aaa", id: "ev-standin", sequence: 3 }],
      n: 0, gapBlocks: 0
    }),
    [failure]
  );
  assert.ok(FAILED(result), "the stored event sits at a different sequence than the record claims");
  assert.equal(result.errors, 1);
  assert.equal(result.blockedFailures, undefined);
});

test("recovery: an identity-less record with no standing block stays fatal", async () => {
  // The empty-block specimen shape with an event log present: a record
  // carrying no threaded identity has no positive evidence behind it,
  // validated event log or not.
  const result = await tick(
    fakeStore({
      blockRows: [],
      eventRows: [{ room_id: "commons", id: "ev-real", sequence: 3 }],
      n: 0, gapBlocks: 0
    }),
    [backfillFailure("commons")]
  );
  assert.ok(FAILED(result), "no threaded identity, no corroboration — the failure stays fatal");
  assert.equal(result.errors, 1);
  assert.equal(result.blockedFailures, undefined);
});

test("recovery: a standing unvalidated block for the room excludes the recovery leg", async () => {
  // The room still has a standing block, and it names an unrelated
  // event. The recovery leg requires the park to be lifted; a standing
  // block is judged by the block leg alone, and this one does not
  // validate — even though the record's own identity would.
  const failure = { ...backfillFailure("commons"), eventId: "ev-real", eventSequence: 3 };
  const result = await tick(
    fakeStore({
      blockRows: [{ room_id: "commons", event_id: "ev-UNRELATED-999", sequence: 7 }],
      eventRows: [{ room_id: "commons", id: "ev-real", sequence: 3 }],
      n: 1, gapBlocks: 0
    }),
    [failure]
  );
  assert.ok(FAILED(result), "a standing block that does not validate cannot be bypassed via the recovery leg");
  assert.equal(result.errors, 1);
  assert.equal(result.blockedFailures, undefined);
});

test("Vc threading: runIntegrityBackfillStep records the event identity runMessagesBackfill returns", async t => {
  // In-memory store (the EPERM-episode substitute for an on-disk
  // suite): the backfill result is stubbed to the exact shape
  // runMessagesBackfill returns — `failed` carries no identity, the
  // standing `blocked` item carries { sequence, eventId } — and the
  // step must preserve that structured identity on the durable
  // integrity_failures record instead of dropping it.
  const store = new RoomStore(":memory:", { integrity: "deferred" });
  t.after(() => { try { store.close(); } catch {} });
  store.initialize(initialRoom("aaa"));
  store.db.prepare("UPDATE rooms SET sequence = sequence + 10 WHERE id='aaa'").run();
  store.db.prepare(`INSERT INTO messages_backfill_blocks (room_id, sequence, event_id, error, head_seq, blocked_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run("aaa", 3, "ev-real", "legacy block", 13, Date.now());
  store.backfillMessages = () => ({
    done: false, events: 0, rooms: 1, budgetExceeded: false,
    failed: [{ roomId: "aaa", error: new Error("Invalid messageId") }],
    blocked: [{ roomId: "aaa", sequence: 3, eventId: "ev-real", error: new Error("Invalid messageId"), fresh: true }],
    quarantined: []
  });
  store.runIntegrityBackfillStep(Date.now() + 5000);
  const row = store.integrityFailures().find(failure => failure.step === "messages_backfill" && failure.recordId === "aaa");
  assert.ok(row, "the fresh failure is recorded durably");
  assert.equal(row.eventId, "ev-real", "the record carries the block's event identity, not a parsed diagnostic string");
  assert.equal(row.eventSequence, 3, "the record carries the event's sequence");
});
