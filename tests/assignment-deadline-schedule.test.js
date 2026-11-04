// Persistent next-rung schedule for assignment deadlines (#5858 successor).
// Counterexample from review: a real proposed-only room (no open PR, claim or
// stale sweep) had earliestFutureAlarm=null, so a due assignment never fired.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { JOBS, earliestFutureAlarm, jobEnabled } from "../server/jobs.mjs";
import { deadlineScheduleDueAt, installDeadlineScheduler, nextRungAt, roomNextRungAt, runDeadlineSchedule } from "../server/assignment-deadline-schedule.mjs";

const MIN = 60_000;
const job = JOBS.find(j => j.name === "assignment-deadlines");

function room(t, env) {
  const f = createAcceptanceFixture();
  let at = Date.parse("2026-11-04T12:00:00.000Z");
  f.store.now = () => at;
  f.store.featureEnv = env;
  t.after(installDeadlineScheduler(f.store, { now: () => at }));
  const identity = f.store.identities.create("deadline-agent");
  linkWithProof(f.store, f.keys.owner, "commons", identity, { memberId: "dl", displayName: "Deadline", permissions: ["accept_work"] });
  const send = (type, data, token = f.keys.owner) => f.store.command(token, "commons", { id: randomUUID(), type, data });
  return { f, send, identity, clock: { get: () => at, set: v => { at = v; } } };
}

// The acceptance fixture ships its own proposed item ("test-handoff").
const others = (f, now) => roomNextRungAt(Object.values(f.store.room("commons").state.workItems).filter(w => w.id !== "dl-1"), now);

const proposal = { workItemId: "dl-1", title: "Synthetic assignment", definitionOfDone: "Synthetic", mode: "read", accountableMemberId: "dl" };

test("job exists, is worker-runnable, and stays off without the flag (no table touched)", t => {
  assert.ok(job && job.runtimes.includes("worker") && !job.slow);
  const { f, send } = room(t, {});
  send("work.proposed", proposal);
  assert.equal(deadlineScheduleDueAt(f.store), null);
  assert.equal(jobEnabled(job, {}, f.store), false);
  assert.equal(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name='assignment_deadline_schedule'").get(), undefined);
  for (const off of ["0", "off", ""]) {
    f.store.featureEnv = { ROOM_ASSIGNMENT_DEADLINES: off };
    send("message.posted", { messageId: randomUUID(), body: "x" });
    assert.equal(deadlineScheduleDueAt(f.store), null);
  }
});

test("proposed-only room arms the alarm at the first rung, fires, and re-arms", t => {
  const env = { ROOM_ASSIGNMENT_DEADLINES: "on" };
  const { f, send, clock } = room(t, env);
  const t0 = clock.get();
  send("work.proposed", proposal);
  const created = Date.parse(f.store.room("commons").state.workItems["dl-1"].createdAt);
  assert.equal(deadlineScheduleDueAt(f.store), created + 10 * MIN);
  assert.equal(JOBS.find(j => j.name === "claim-prs").enabled(env, f.store), false, "no other job is waiting");
  assert.equal(jobEnabled(job, env, f.store), true);
  const alarm = earliestFutureAlarm(JOBS.filter(j => j.name === "assignment-deadlines"), { env, store: f.store, now: t0, lastRan: {} });
  assert.equal(alarm, created + 10 * MIN, "alarm armed for the earliest pending rung");
  const all = earliestFutureAlarm(JOBS, { env, store: f.store, now: t0, lastRan: {} });
  assert.ok(all !== null && all <= created + 10 * MIN, "full scheduler is no longer null");

  clock.set(created + 10 * MIN);
  const first = runDeadlineSchedule(f.store, clock.get());
  assert.deepEqual(first, { rooms: 1, posted: 1 });
  assert.equal(deadlineScheduleDueAt(f.store), created + 30 * MIN, "re-armed for the escalate rung");
  assert.deepEqual(runDeadlineSchedule(f.store, clock.get()), { rooms: 0, posted: 0 }, "not due again yet");

  clock.set(created + 30 * MIN);
  runDeadlineSchedule(f.store, clock.get());
  assert.equal(deadlineScheduleDueAt(f.store), created + 240 * MIN);
  clock.set(created + 240 * MIN);
  runDeadlineSchedule(f.store, clock.get());
  assert.equal(deadlineScheduleDueAt(f.store), others(f, clock.get()), "dl-1 ladder finished: only the fixture's own item remains");
  const bodies = f.store.room("commons").state.messages.map(m => m.body).filter(b => /Assignment still waiting|Escalation|Task is free/.test(b));
  assert.equal(bodies.length, 3);
});

test("schedule is persisted in SQLite and an overdue row is not pushed back", t => {
  const env = { ROOM_ASSIGNMENT_DEADLINES: "commons" };
  const { f, send, clock } = room(t, env);
  send("work.proposed", proposal);
  const due = deadlineScheduleDueAt(f.store);
  clock.set(due + 5 * MIN);
  send("message.posted", { messageId: randomUUID(), body: "unrelated" });
  assert.equal(deadlineScheduleDueAt(f.store), due, "an event after the rung keeps the overdue alarm");
  const row = f.store.db.prepare("SELECT due_at FROM assignment_deadline_schedule WHERE room_id='commons'").get();
  assert.equal(row.due_at, due, "persisted in SQLite, not memory");
});

test("lifecycle: an accepted assignment clears its row", t => {
  const env = { ROOM_ASSIGNMENT_DEADLINES: "on" };
  const { f, send, identity } = room(t, env);
  send("work.proposed", proposal);
  assert.notEqual(deadlineScheduleDueAt(f.store), null);
  send("work.accepted", { workItemId: "dl-1", expectedRevision: 0 }, identity.secret);
  assert.equal(f.store.room("commons").state.workItems["dl-1"].state !== "proposed", true);
  assert.equal(deadlineScheduleDueAt(f.store), others(f, Date.now() > 0 ? f.store.now() : 0));
});

test("nextRungAt picks the earliest future threshold", () => {
  const c = Date.parse("2026-11-04T00:00:00Z");
  const it = { state: "proposed", accountableMemberId: "a", createdAt: new Date(c).toISOString() };
  assert.equal(nextRungAt(it, c), c + 10 * MIN);
  assert.equal(nextRungAt(it, c + 10 * MIN), c + 30 * MIN);
  assert.equal(nextRungAt(it, c + 240 * MIN), null);
  assert.equal(nextRungAt({ ...it, supersededBy: "x" }, c), null);
  const lease = { state: "claimed", claim: { holderId: "h", leaseExpiresAt: new Date(c + 60 * MIN).toISOString() } };
  assert.equal(nextRungAt(lease, c), c + 45 * MIN);
  assert.equal(roomNextRungAt([it, lease], c + 20 * MIN), c + 30 * MIN);
});
