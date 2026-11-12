// P1 §3.1 (lane B1): deadline gates before every named stretch of
// verifyRoomIntegrity. A stretch that cannot start inside the budget
// is deferred WHOLE — never started — and the tick returns
// budgetExceeded: 1 naming it as deferredStretch. A tick that defers
// a pre-batch stretch counts as a deferred-skip under the existing
// #3896 machinery, so the batch-first rule (streak limit 2) gives the
// deferred batch its visit on the third tick.
//
// Deterministic, fake-clock style after tests/integrity-deferred-
// starvation.test.js: wrapped stretches advance the fake clock past
// the deadline, and the NEXT stretch's gate must fire before that
// stretch starts (asserted by its call count staying at zero).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function fakeClock(t) {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  return { now: () => now, advance: ms => { now += ms; } };
}

function freshStore(t, room = "gated") {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom(room));
  return store;
}

// Count calls to a store method while preserving its behaviour.
function counted(store, name) {
  const original = store[name].bind(store);
  const state = { calls: 0 };
  store[name] = (...args) => { state.calls++; return original(...args); };
  return state;
}

test("gate before integrityChecksum defers it whole, and the deferral feeds the #3896 starvation rule", async t => {
  const clock = fakeClock(t);
  const store = freshStore(t);
  const checksum = counted(store, "integrityChecksum");
  const batch = counted(store, "runDeferredIntegrityBatch");
  const originalIncremental = store.incrementalIntegrityCheck.bind(store);
  store.incrementalIntegrityCheck = () => {
    const result = originalIncremental();
    clock.advance(10_000); // the proof legs consume the whole budget
    return result;
  };
  const tick = () => store.verifyRoomIntegrity({ deadline: clock.now() + 5_000 });

  const first = await tick();
  assert.equal(first.budgetExceeded, 1);
  assert.equal(first.deferredStretch, "integrityChecksum");
  assert.equal(first.verified, 0);
  assert.equal(checksum.calls, 0, "the checksum was deferred whole: never started");
  assert.equal(first.deferredSkips, 1, "a pre-batch deferral counts as a deferred-skip");
  assert.equal(store.readIntegritySnapshot(), null, "no snapshot was written");

  const second = await tick();
  assert.equal(second.deferredStretch, "integrityChecksum");
  assert.equal(second.deferredSkips, 2);
  assert.equal(checksum.calls, 0);
  assert.equal(batch.calls, 0, "the batch has not run yet");

  // Third consecutive deferring tick: the streak hit the limit, so
  // the batch runs FIRST, before the gate defers the checksum again,
  // and the streak resets because the batch progressed.
  const third = await tick();
  assert.equal(batch.calls, 1, "batch-first rule gave the batch its visit");
  assert.equal(third.deferredStretch, "integrityChecksum");
  assert.equal(third.deferredSkips, 0, "batch progress resets the streak");
  assert.equal(checksum.calls, 0);
});

test("gate before the invitation audit defers it whole", async t => {
  const clock = fakeClock(t);
  const store = freshStore(t);
  const invitations = counted(store, "verifyInvitationRecord");
  const result = await store.verifyRoomIntegrity({
    deadline: clock.now() + 5_000,
    // The first yield on the full path sits right before the audit.
    yieldBetween: async () => { clock.advance(10_000); }
  });
  assert.equal(result.budgetExceeded, 1);
  assert.equal(result.deferredStretch, "invitationAudit");
  assert.equal(invitations.calls, 0, "no invitation record was audited");
  assert.equal(result.deferredSkips, 1);
  assert.equal(store.readIntegritySnapshot(), null);
});

test("gate before verifyHelpHistory defers it whole (call site only)", async t => {
  const clock = fakeClock(t);
  const store = freshStore(t);
  const help = counted(store, "verifyHelpHistory");
  const present = store.helpProjectionPresent.bind(store);
  store.helpProjectionPresent = () => { clock.advance(10_000); return true; };
  assert.equal(typeof present, "function");
  const result = await store.verifyRoomIntegrity({ deadline: clock.now() + 5_000 });
  assert.equal(result.budgetExceeded, 1);
  assert.equal(result.deferredStretch, "verifyHelpHistory");
  assert.equal(help.calls, 0, "the help audit was deferred whole: never started");
  assert.equal(result.deferredSkips, 1);
});

test("gate before reconcile defers the reconcile/repair/drifted cluster whole", async t => {
  const clock = fakeClock(t);
  const store = freshStore(t);
  const reconcile = counted(store, "reconcileProjectionContentFailures");
  const drifted = counted(store, "driftedProjectionRooms");
  // No help state: the present-check consumes the budget and reports
  // none, so the next gate — before reconcile — must fire.
  store.helpProjectionPresent = () => { clock.advance(10_000); return false; };
  const result = await store.verifyRoomIntegrity({ deadline: clock.now() + 5_000 });
  assert.equal(result.budgetExceeded, 1);
  assert.equal(result.deferredStretch, "reconcileProjectionContentFailures");
  assert.equal(reconcile.calls, 0, "reconcile never started on the full path");
  assert.equal(drifted.calls, 0);
  assert.equal(store.readIntegritySnapshot(), null);
});

test("gate before driftedProjectionRooms defers it whole after repair", async t => {
  const clock = fakeClock(t);
  const store = freshStore(t);
  const drifted = counted(store, "driftedProjectionRooms");
  const repair = store.repairProjectionProvenance.bind(store);
  store.repairProjectionProvenance = (...args) => {
    const out = repair(...args);
    clock.advance(10_000); // repair consumed the rest of the budget
    return out;
  };
  const result = await store.verifyRoomIntegrity({ deadline: clock.now() + 5_000 });
  assert.equal(result.budgetExceeded, 1);
  assert.equal(result.deferredStretch, "driftedProjectionRooms");
  assert.equal(drifted.calls, 0, "the drift scan was deferred whole: never started");
  assert.equal(store.readIntegritySnapshot(), null);
});

test("gate before the certifying transaction defers the second checksum and the snapshot write whole", async t => {
  const clock = fakeClock(t);
  const store = freshStore(t, "certgate");
  // Settle under the frozen fake clock first: a v2 snapshot exists.
  const settle1 = await store.verifyRoomIntegrity({ deadline: clock.now() + 60_000 });
  assert.equal(settle1.verified, 1);
  const settled = store.readIntegritySnapshot();
  assert.ok(settled?.startsWith("v2:"), "settled snapshot is v2");
  // Tamper with the snapshot's content digest (format stays valid
  // v2) so the next tick takes the full path instead of matching:
  // the incremental path recomputes the digest from the per-room
  // hashes and cannot reproduce the tampered snapshot text.
  const parts = settled.split(":");
  parts[7] = "0".repeat(64);
  const tampered = parts.join(":");
  store.db.prepare("UPDATE integrity_snapshot SET checksum=? WHERE id=1").run(tampered);

  const remember = counted(store, "rememberIntegrityRoomState");
  const checksumBefore = counted(store, "integrityChecksum");
  const originalDrifted = store.driftedProjectionRooms.bind(store);
  store.driftedProjectionRooms = (...args) => {
    const out = originalDrifted(...args);
    clock.advance(10_000); // the drift scan consumed the rest of the budget
    return out;
  };
  const result = await store.verifyRoomIntegrity({ deadline: clock.now() + 5_000 });
  assert.equal(result.budgetExceeded, 1);
  assert.equal(result.deferredStretch, "certifyingTransaction");
  assert.equal(checksumBefore.calls, 1, "only the pre-audit checksum ran; the certifying one never started");
  assert.equal(remember.calls, 0, "room state was not rewritten");
  assert.equal(store.readIntegritySnapshot(), tampered, "the snapshot was not advanced by a partial certification");
});

test("an already-expired deadline names the first stretch and starts no work", async t => {
  const clock = fakeClock(t);
  const store = freshStore(t);
  const incremental = counted(store, "incrementalIntegrityCheck");
  const result = await store.verifyRoomIntegrity({ deadline: clock.now() - 1 });
  assert.equal(result.budgetExceeded, 1);
  assert.equal(result.deferredStretch, "incrementalIntegrityCheck");
  assert.equal(incremental.calls, 0);
  assert.equal(result.deferredSkips, 1);
});
