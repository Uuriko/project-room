// #3896 (sweep F-6): integrity could starve behind its own budget and
// record success forever. verifyRoomIntegrity runs the incremental/full
// checks before the deferred batch (the 11 replay steps: messages
// backfill, messages parity, and the other verifiers), and every
// budget-exceeded return path skipped the batch entirely — so if the
// pre-deferred work routinely ate the 5s job budget, the deferred steps
// never ran while every tick recorded ok. The fix keeps a durable count
// of consecutive calls in which the deferred batch completed zero steps
// and, once the count reaches the limit, runs the batch FIRST on the
// next call — starvation is bounded and the streak is on the result
// (and therefore the job summary) while it lasts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

test("deferred batch starvation is counted, bounded, and visible on the result", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-integrity-starvation-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons"));

  // Warm-up on the real clock: the full path certifies the fresh room,
  // writes the snapshot, and runs the deferred batch once, so later
  // calls take the cheap incremental path.
  const warm = await store.verifyRoomIntegrity({ deadline: Date.now() + 60_000 });
  assert.ok(warm.deferred, "warm-up ran the deferred batch");
  const cursor = () => store.db.prepare("SELECT step FROM integrity_job_cursor WHERE singleton=1").get()?.step ?? 0;
  const cursorAfterWarmup = cursor();

  // Fake clock: yieldBetween jumps 10s past the 5s budget, so every call
  // exhausts its budget right after the incremental check — the exact
  // starvation shape, deterministically.
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  t.after(() => { Date.now = realNow; });
  const starvedCall = () => store.verifyRoomIntegrity({
    deadline: fakeNow + 5_000,
    yieldBetween: async () => { fakeNow += 10_000; }
  });

  const first = await starvedCall();
  assert.equal(first.budgetExceeded, 1);
  assert.equal(first.deferred, undefined, "the batch never ran");
  assert.equal(first.deferredSkips, 1, "the starved call is counted on the result");
  assert.equal(cursor(), cursorAfterWarmup, "the deferred cursor did not move");

  const second = await starvedCall();
  assert.equal(second.deferredSkips, 2);
  assert.equal(cursor(), cursorAfterWarmup, "the deferred cursor still did not move");

  // Third consecutive starved call: the batch runs FIRST, so at least
  // one deferred step completes before the budget is gone, and the
  // streak resets — starvation is bounded at two ticks.
  const third = await starvedCall();
  assert.equal(third.budgetExceeded, 1, "the tick still exhausts its budget");
  assert.equal(third.deferredSkips, 0, "deferred progress resets the streak");
  assert.equal(cursor(), cursorAfterWarmup + 1, "the batch advanced one step before the budget died");

  // A call whose deadline has already passed is a starved tick too.
  const dead = await store.verifyRoomIntegrity({ deadline: fakeNow - 1 });
  assert.equal(dead.budgetExceeded, 1);
  assert.equal(dead.deferredSkips, 1);
});
