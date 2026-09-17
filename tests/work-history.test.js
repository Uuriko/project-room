// F3: per-item change history is derived from the item's own revision events,
// assigning each event the revision it produced so a stale-basis viewer can see
// exactly what changed. Non-revision events never enter the list.
import test from "node:test";
import assert from "node:assert/strict";
import { workItemChanges, changeDescription } from "../src/workflow.js";
import { EVENT_TYPES as T } from "../src/events.js";

const ev = (type, data = {}, actorId = "owner", at = "2026-09-13T00:00:00.000Z") =>
  ({ id: `${type}-${Math.random()}`, type, actorId, at, data });

test("proposal is revision 0 and each revision event takes the next revision", () => {
  const changes = workItemChanges([
    ev(T.WORK_PROPOSED, { workItemId: "w" }),
    ev(T.WORK_ACCEPTED),
    ev(T.WORK_STARTED),
    ev(T.WORK_COMPLETED, { summary: "shipped" })
  ]);
  assert.deepEqual(changes.map(c => c.revision), [0, 1, 2, 3]);
  assert.deepEqual(changes.map(c => c.type), [T.WORK_PROPOSED, T.WORK_ACCEPTED, T.WORK_STARTED, T.WORK_COMPLETED]);
});

test("messages and other non-revision events never appear in the change list", () => {
  const changes = workItemChanges([
    ev(T.WORK_PROPOSED, { workItemId: "w" }),
    ev(T.MESSAGE_POSTED, { workItemId: "w", body: "chatter" }),
    ev(T.WORK_BLOCKED, { reason: "keys" }),
    ev(T.MESSAGE_POSTED, { workItemId: "w", body: "more" })
  ]);
  assert.deepEqual(changes.map(c => c.revision), [0, 1]);
});

test("a viewer on basis revision N sees exactly the changes after N", () => {
  const changes = workItemChanges([
    ev(T.WORK_PROPOSED, { workItemId: "w" }),
    ev(T.WORK_ACCEPTED),
    ev(T.WORK_BLOCKED, { reason: "waiting" }),
    ev(T.WORK_BLOCKER_RESOLVED),
    ev(T.WORK_SUPERSEDED, { supersededBy: "w2" })
  ]);
  const since = changes.filter(c => c.revision > 2);
  assert.deepEqual(since.map(c => c.type), [T.WORK_BLOCKER_RESOLVED, T.WORK_SUPERSEDED]);
});

test("descriptions carry the recorded reason, decision, claim and supersession", () => {
  const [blocked] = workItemChanges([ev(T.WORK_BLOCKED, { reason: "waiting on keys" }, "producer")]);
  assert.equal(changeDescription(blocked), "Blocked: waiting on keys");
  const [claimed] = workItemChanges([ev(T.CLAIM_ACQUIRED, { repository: "Uuriko/project-room", ref: "main" }, "producer")]);
  assert.equal(changeDescription(claimed), "Scope claimed: Uuriko/project-room:main");
  const [superseded] = workItemChanges([ev(T.WORK_SUPERSEDED, { supersededBy: "w2" })]);
  assert.equal(changeDescription(superseded), "Superseded by replacement work");
  const [decided] = workItemChanges([ev(T.OWNER_DECISION_RECORDED, { decision: "approved" })]);
  assert.equal(changeDescription(decided), "Decision: approved");
});

test("session events are labelled without leaking internals", () => {
  const changes = workItemChanges([
    ev(T.SESSION_STARTED), ev(T.SESSION_STATUS_CHANGED, { status: "running" }), ev(T.SESSION_STOPPED)
  ]);
  assert.deepEqual(changes.map(changeDescription), ["Native session started", "Native session: running", "Native session stopped"]);
});

test("missing optional fields stay absent rather than rendering as undefined", () => {
  const [accepted] = workItemChanges([ev(T.WORK_ACCEPTED)]);
  assert.equal(changeDescription(accepted), "Accepted");
  assert.equal("reason" in accepted, false);
  const [blocked] = workItemChanges([ev(T.WORK_BLOCKED, {})]);
  assert.equal(changeDescription(blocked), "Blocked");
});

test("malformed input fails closed", () => {
  assert.throws(() => workItemChanges(null));
  assert.deepEqual(workItemChanges([null, undefined, 42]), []);
});
