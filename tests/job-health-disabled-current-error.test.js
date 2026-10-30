// A job with a current error must not present "disabled".
//
// Patrol is work-gated: its resting state after a fresh-park failure is
// "parked at the current head, nothing pending" — which is exactly the
// gate's disabled condition. Grading that state `disabled` let the
// failure switch off its own grade: the health view carried
// lastErrorCurrent: true beside status "disabled", and the rollup
// filtered the job out of its active set, so no probe could ever page
// on it (production, 2026-10-18: 1,610 consecutive patrol failures read
// as a disabled job). The failing presentation takes precedence over
// disabled; the honest gate reason stays alongside.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { jobByName } from "../server/jobs.mjs";
import { applyOutcomes, jobHealthView, runCronJobs } from "../cloudflare/job-heartbeat.mjs";

const NOW = Date.parse("2026-10-18T20:00:00Z");
const ENV = {
  ROOM_GMAIL_ENABLED: "0",
  // The backups binding is present in this deployment: room-backup is a
  // required job (#3894), so an unbound fixture would fail the rollup by
  // design and drown the patrol gate under test here.
  ROOM_BACKUPS_KV: { async put() {}, async get() { return null; } }
};
const ALWAYS_ON = ["retention", "integrity", "public-read-model", "room-backup", "store-growth"];

function fixtureStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-health-precedence-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("aaa-poison"));
  const key = store.issueAccessKey("aaa-poison", "owner");
  store.command(key, "aaa-poison", { id: "cmd-p1", type: "message.posted", data: { body: "poison room message", messageId: "p1" } });
  // The corrupt room: its stored projection no longer parses, so the
  // patrol's attempt throws deterministically and the room is parked.
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='aaa-poison'").run("{corrupt-projection");
  return store;
}

// Fresh successes for the always-on cadence jobs, so the only signal in
// the view is the patrol record under test.
function freshRecords(patrolOutcome) {
  const outcomes = ALWAYS_ON.map(job => ({ job, ok: true, at: NOW, summary: { checked: 1 } }));
  if (patrolOutcome) outcomes.push(patrolOutcome);
  return applyOutcomes({}, outcomes);
}

function patrolEntry(view) {
  return view.jobs.find(job => job.name === "patrol");
}

test("a work-gated job carrying a current error presents failing, not disabled", async t => {
  const store = fixtureStore(t);
  const job = jobByName("patrol");
  const outcomes = await runCronJobs(
    { patrol: () => job.run(store, { deadline: Date.now() + 5000 }) },
    { now: () => NOW, log: () => {} }
  );
  assert.equal(outcomes[0].ok, false, "the fresh park fails the tick that records it");
  const records = freshRecords(outcomes[0]);
  // The gate reads false at rest: the room is parked at its current
  // head, so nothing is pending — the self-sealing state from production.
  const view = jobHealthView(records, NOW, ENV, store);
  const patrol = patrolEntry(view);
  assert.equal(patrol.consecutiveFailures, 1);
  assert.equal(patrol.lastErrorCurrent, true, "the error is current, not history");
  assert.equal(patrol.status, "failing", "a current error outranks the disabled presentation");
  assert.equal(patrol.reason, "No unpatrolled events are waiting", "the honest gate reason stays alongside");
  // Rollup consequence, accepted with the fix: the job re-enters the
  // rollup's active set while it carries a current error, so its
  // standing error drives the top-level status — as an enabled failing
  // job (integrity) already does.
  assert.deepEqual(view.jobs.filter(job => job.status === "failing").map(job => job.name), ["patrol"]);
  assert.equal(view.status, "failing");
});

test("a work-gated job with no current error still presents disabled", async t => {
  const store = fixtureStore(t);
  const job = jobByName("patrol");
  // A clean tick against the same store: the corrupt room is attempted,
  // parked, and — the park now standing — the job's record is a success
  // carrying the parked count and no error.
  await runCronJobs(
    { patrol: () => job.run(store, { deadline: Date.now() + 5000 }) },
    { now: () => NOW, log: () => {} }
  );
  const records = freshRecords({ job: "patrol", ok: true, at: NOW, summary: { checked: 0, rooms: 1, parked: 1 } });
  const view = jobHealthView(records, NOW, ENV, store);
  const patrol = patrolEntry(view);
  assert.equal(patrol.consecutiveFailures, 0);
  assert.equal(patrol.lastErrorCurrent, false);
  assert.equal(patrol.status, "disabled", "idle stays idle: no current error, no failing presentation");
  assert.equal(patrol.reason, "No unpatrolled events are waiting");
  assert.equal(view.status, "ok", "a clean work-gated job stays out of the rollup");
});
