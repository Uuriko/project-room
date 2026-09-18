// LANE C (quill/inbox-agent-collab): thread assignment journal —
// assign/release/claim with agent-or-human assignees and a full event
// journal per thread.
import test from "node:test";
import assert from "node:assert/strict";
import { AssignError, assignmentStatuses, assigneeKinds, createAssignmentJournal,
  identityOf, threadIdOf } from "../server/inbox-assign.mjs";

const agent = { kind: "agent", id: "claude", label: "Claude" };
const human = { kind: "human", id: "john", label: "John" };
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.ok(error instanceof AssignError); assert.equal(error.code, code); return; }
  assert.fail(`expected ${code} but nothing threw`);
};
const fixedClock = (times = [1000]) => { let i = 0; return () => times[Math.min(i++, times.length - 1)]; };

test("assign records the assignee, the actor, and a journal event; output is frozen", () => {
  const journal = createAssignmentJournal({ clock: fixedClock([1000]) });
  const { record, duplicate } = journal.assign("thread:1", agent, { by: human });
  assert.equal(duplicate, false);
  assert.equal(record.threadId, "thread:1");
  assert.deepEqual(record.assignee, agent);
  assert.deepEqual(record.assignedBy, human);
  assert.equal(record.status, "assigned");
  assert.equal(record.assignedAt, "1970-01-01T00:00:01.000Z");
  assert.equal(record.history.length, 1);
  assert.equal(record.history[0].event, "assigned");
  assert.ok(Object.isFrozen(record) && Object.isFrozen(record.assignee) && Object.isFrozen(record.history));
});
test("assigning to the same identity is idempotent", () => {
  const journal = createAssignmentJournal({ clock: fixedClock([1000, 2000]) });
  journal.assign("thread:1", agent, { by: human });
  const { record, duplicate } = journal.assign("thread:1", agent, { by: human });
  assert.equal(duplicate, true);
  assert.equal(record.history.length, 1);
});
test("assigning to a different identity while assigned throws assign_conflict", () => {
  const journal = createAssignmentJournal({ clock: fixedClock([1000, 2000]) });
  journal.assign("thread:1", agent, { by: human });
  expectCode(() => journal.assign("thread:1", { kind: "agent", id: "instinct" }, { by: human }), "assign_conflict");
  // A human can force the takeover; the journal keeps both events.
  const { record, takeover } = journal.assign("thread:1", { kind: "agent", id: "instinct" }, { by: human, force: true });
  assert.equal(takeover, true);
  assert.equal(record.assignee.id, "instinct");
  assert.equal(record.history.at(-1).event, "reassigned");
  assert.match(record.history.at(-1).reason, /takeover from claude/);
});
test("an agent cannot force a takeover", () => {
  const journal = createAssignmentJournal({ clock: fixedClock([1000, 2000]) });
  journal.assign("thread:1", agent, { by: human });
  expectCode(() => journal.assign("thread:1", { kind: "human", id: "jillian" }, { by: agent, force: true }), "assign_forbidden");
});
test("release frees the thread; releasing an unassigned thread throws assign_not_assigned", () => {
  const journal = createAssignmentJournal({ clock: fixedClock([1000, 2000, 3000]) });
  journal.assign("thread:1", agent, { by: human });
  const released = journal.release("thread:1", { by: human, reason: "done" });
  assert.equal(released.status, "released");
  assert.equal(released.history.at(-1).event, "released");
  assert.equal(released.history.at(-1).reason, "done");
  expectCode(() => journal.release("thread:1", { by: human }), "assign_not_assigned");
  expectCode(() => journal.release("thread:nope", { by: human }), "assign_not_assigned");
});
test("claim works on free threads only; it cannot steal a live assignment", () => {
  const journal = createAssignmentJournal({ clock: fixedClock([1000, 2000, 3000]) });
  const claimed = journal.claim("thread:1", human);
  assert.equal(claimed.status, "assigned");
  assert.equal(claimed.assignee.id, "john");
  assert.equal(claimed.history.at(-1).event, "claimed");
  expectCode(() => journal.claim("thread:1", agent), "assign_conflict");
  journal.release("thread:1", { by: human });
  const reclaimed = journal.claim("thread:1", agent);
  assert.equal(reclaimed.assignee.id, "claude");
});
test("list filters by status and assignee; journal returns the event history", () => {
  const journal = createAssignmentJournal({ clock: fixedClock([1000, 2000, 3000]) });
  journal.assign("thread:1", agent, { by: human });
  journal.assign("thread:2", human, { by: human });
  journal.release("thread:2", { by: human });
  assert.equal(journal.list({ status: "assigned" }).length, 1);
  assert.equal(journal.list({ assigneeId: "claude" }).length, 1);
  assert.equal(journal.list().length, 2);
  assert.equal(journal.journal("thread:1").length, 1);
  assert.equal(journal.journal("thread:unknown").length, 0);
  assert.equal(journal.get("thread:unknown"), null);
});
test("validation rejects bad identities and thread ids", () => {
  const journal = createAssignmentJournal();
  expectCode(() => journal.assign("", agent, { by: human }), "assign_invalid");
  expectCode(() => journal.assign("t", { kind: "robot", id: "x" }, { by: human }), "assign_invalid");
  expectCode(() => journal.assign("t", { kind: "agent", id: "not an id!" }, { by: human }), "assign_invalid");
  expectCode(() => journal.assign("t", agent, { by: "human" }), "assign_invalid");
  expectCode(() => identityOf({ kind: "agent", id: "x", extra: true }), "assign_invalid");
  expectCode(() => threadIdOf("x".repeat(1025)), "assign_invalid");
});
test("exported enums stay frozen", () => {
  assert.deepEqual([...assigneeKinds], ["agent", "human"]);
  assert.deepEqual([...assignmentStatuses], ["assigned", "released"]);
  assert.ok(Object.isFrozen(assigneeKinds) && Object.isFrozen(assignmentStatuses));
});
