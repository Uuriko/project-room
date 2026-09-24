import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import { steppedClock, fixedIds, runScenario } from "../scripts/fake-runner.mjs";

// W4-38 G2: the fake runner simulates start, output, failure, timeout and
// restart with no paid/provider execution. Determinism = same ledger and
// same semantic event stream on every run; transport ids are random by design.

function buildStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-fake-runner-"));
  const clock = steppedClock("2026-09-13T20:00:00.000Z");
  const store = new RoomStore(join(directory, "room.sqlite"), { now: clock });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const baseSequence = store.room("commons").sequence; // seed events stamp real time; exclude them
  const ownerKey = store.issueAccessKey("commons", "owner");
  const ids = fixedIds("setup");
  store.command(ownerKey, "commons", { id: ids(), type: T.MEMBER_ADDED,
    data: { memberId: "fake-runner", displayName: "Fake runner", kind: "agent",
      permissions: ["accept_work", "complete_work"] } });
  // Graduated autonomy tiers: the fixture agent is operator-promoted so the
  // fake-runner test exercises it as a working agent.
  setTier(store.db, "commons", "fake-runner", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  store.command(ownerKey, "commons", { id: ids(), type: T.WORK_PROPOSED, data: {
    workItemId: "runner-task", title: "Simulated task", definitionOfDone: "Scenario completes",
    accountableMemberId: "fake-runner", mode: "read" } });
  const key = store.issueAccessKey("commons", "fake-runner");
  return { store, clock, key, baseSequence };
}

function eventStream(store, baseSequence) {
  return store.db.prepare("SELECT sequence,body FROM events WHERE room_id=? AND sequence>? ORDER BY sequence").all("commons", baseSequence)
    .map(row => { const e = JSON.parse(row.body);
      return { sequence: row.sequence, type: e.type, actorId: e.actorId, at: e.at, data: e.data }; });
}

test("G2 fake runner: start, output, failure, timeout and restart all simulate deterministically", t => {
  const a = buildStore(t), b = buildStore(t);
  const ledgerA = runScenario({ store: a.store, key: a.key, workItemId: "runner-task", clock: a.clock });
  const ledgerB = runScenario({ store: b.store, key: b.key, workItemId: "runner-task", clock: b.clock });

  // The scenario covered all five behaviors: attempt 1 start+output+done,
  // attempt 2 restart+failure, attempt 3 timeout (budget wire), attempt 4
  // restart after the timeout.
  assert.deepEqual(ledgerA.map(x => ({ attempt: x.attempt, outcome: x.outcome })), [
    { attempt: 1, outcome: "done" },
    { attempt: 2, outcome: "failed" },
    { attempt: 3, outcome: "failed" },
    { attempt: 4, outcome: "done" }
  ]);
  assert.equal(ledgerA[0].outputs?.[0], "msg:fake-output-1");
  assert.equal(ledgerA[1].outputs?.[0], "log:fake-run-2");
  assert.equal(ledgerA[2].limits?.maxRuntimeMs, 300_000);
  assert.ok(ledgerA.every(x => x.performer === "fake-runner" && x.endedAt));

  // Determinism: identical ledgers and identical semantic event streams.
  assert.deepEqual(ledgerB, ledgerA);
  assert.deepEqual(eventStream(b.store, b.baseSequence), eventStream(a.store, a.baseSequence));
  const types = eventStream(a.store, a.baseSequence).map(e => e.type);
  assert.ok(types.includes("session.started") && types.includes("session.stopped"),
    `expected session events, got ${types.join(",")}`);
  const stops = eventStream(a.store, a.baseSequence).filter(e => e.type === "session.stopped");
  assert.equal(stops.filter(e => e.data?.budgetEnforced === true).length, 1,
    "exactly one stop is the budget-enforced timeout");
});
