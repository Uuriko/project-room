import test from "node:test";
import assert from "node:assert/strict";
import { JOBS } from "../server/jobs.mjs";

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

const integrity = JOBS.find(job => job.name === "integrity");

const FAILED = result => Boolean(result.scanError) || Number(result.errors) > 0;

// Scripted store. `blockRows` is what the partition's block-map read
// returns (or `blockReadError` makes that read throw, the injected
// block-map SQL read failure from seq 23366). `standing` describes the
// durable set the post-scan observation sees: `n`/`gapBlocks` ride the
// aggregate count query, `standingRows` rides the room-id query the
// cured guard uses for identity coverage. Any other SQL throws, which
// the job's own heal/observation guards already tolerate.
function fakeStore({ blockRows = [], blockReadError = false, standingRows = null, n = 0, gapBlocks = 0 } = {}) {
  const standing = standingRows ?? blockRows;
  return {
    db: {
      prepare(sql) {
        if (sql.includes("SELECT room_id, event_id FROM messages_backfill_blocks")) {
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
      blockRows: [{ room_id: "aaa", event_id: "ev-aaa" }],
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
    fakeStore({ blockRows: [{ room_id: "aaa", event_id: "ev-aaa" }], n: 1, gapBlocks: 0 }),
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
    fakeStore({ blockRows: [{ room_id: "aaa", event_id: "ev-aaa" }], n: 1, gapBlocks: 0 }),
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
