import test from "node:test";
import assert from "node:assert/strict";
import { transitionRequestRun, requestRunMayExecute, requestRunView } from "../src/request-run-policy.js";

const now = "2026-09-12T22:00:00.000Z", later = "2026-09-12T22:00:01.000Z", expired = "2026-09-12T22:00:30.000Z";
const context = () => ({ request: { id: "question", requesterId: "human", recipientId: "agent", status: "open", contextEventId: "context", workItemId: null },
  actor: { id: "agent", kind: "agent", active: true }, ownerId: "owner", instructionsRevision: 0 });
const claim = (patch = {}) => ({ expectedRevision: 0, runId: "one", contextEventId: "context", instructionsRevision: 0, maxRuntimeMs: 10000, maxOutputBytes: 4096, ...patch });
const start = c => transitionRequestRun(c, "claim", claim(), now);

test("chat run view separates expiry, stop, completion and participant authority", () => {
  const c = context(), run = start(c), state = { room: { ownerId: "owner" }, requestRuns: { question: run }, replyRequests: { question: c.request },
    members: { human: { active: true, kind: "human" }, agent: { active: true, kind: "agent" }, stranger: { active: true, kind: "human" }, owner: { active: true, kind: "human" } } };
  assert.equal(requestRunView(state, "missing", "human", later), null);
  for (const viewer of ["human", "agent", "owner"]) assert.equal(requestRunView(state, "question", viewer, later).canStop, true);
  assert.equal(requestRunView(state, "question", "stranger", later).canStop, false);
  assert.equal(requestRunView(state, "question", "human", later).label, "Run in progress");
  assert.deepEqual(requestRunView(state, "question", "human", expired), { label: "Run unconfirmed", canStop: true });
  run.status = "stop_requested";
  assert.deepEqual(requestRunView(state, "question", "human", later), { label: "Stop requested", canStop: false });
  run.status = "succeeded";
  assert.deepEqual(requestRunView(state, "question", "human", later), { label: "Run finished", canStop: false });
  state.members.human.active = false; run.status = "running";
  assert.equal(requestRunView(state, "question", "human", later).canStop, false);
});

test("work-free human and agent requests share an immutable execution policy", () => {
  for (const kind of ["human", "agent"]) {
    const c = context(); c.actor.kind = kind;
    const original = structuredClone(c), run = start(c);
    assert.deepEqual(c, original);
    assert.equal(run.revision, 1); assert.equal(run.status, "running");
    assert.equal(requestRunMayExecute(run, c.request, 0, later), true);
    const finished = transitionRequestRun({ ...c, run }, "finish", { expectedRevision: 1, runId: "one", status: "succeeded" }, later);
    assert.equal(finished.status, "succeeded"); assert.equal(run.status, "running");
    assert.equal(c.request.status, "open", "process success does not answer a request");
    assert.equal(c.request.workItemId, null, "no task created");
  }
});

test("expired and stop-requested runs never become reclaimable by time alone", () => {
  const c = context(), run = start(c);
  assert.equal(requestRunMayExecute(run, c.request, 0, expired), false);
  assert.throws(() => transitionRequestRun({ ...c, run }, "claim", claim({ expectedRevision: 1, runId: "two" }), expired), /not confirmed stopped/);
  const stop = transitionRequestRun({ ...c, run, actor: { id: "human", kind: "human", active: true } }, "request_stop", { expectedRevision: 1, runId: "one" }, later);
  assert.equal(stop.status, "stop_requested"); assert.equal(stop.stoppedAt, null);
  assert.equal(requestRunMayExecute(stop, c.request, 0, later), false);
  assert.throws(() => transitionRequestRun({ ...c, run: stop }, "finish", { expectedRevision: 2, runId: "one", status: "succeeded" }, later), /cannot report success/);
  const finished = transitionRequestRun({ ...c, run: stop }, "finish", { expectedRevision: 2, runId: "one", status: "cancelled" }, later);
  assert.equal(finished.status, "cancelled");
});

test("stale revisions, identities, context and limits cannot claim", () => {
  const c = context();
  for (const patch of [{ expectedRevision: 1 }, { runId: "__proto__" }, { contextEventId: "stale" }, { instructionsRevision: 1 },
    { maxRuntimeMs: 0 }, { maxRuntimeMs: 300001 }, { maxOutputBytes: 1048577 }, { command: "shell" }])
    assert.throws(() => transitionRequestRun(c, "claim", claim(patch), now));
  for (const actor of [{ id: "human", active: true }, { id: "agent", active: false }, { id: "owner", kind: "human", active: true }])
    assert.throws(() => start({ ...c, actor }));
  assert.throws(() => start({ ...c, request: { ...c.request, status: "cancelled" } }));
});

test("changed conversation blocks execution and success but allows a failed finish", () => {
  const c = context(), run = start(c);
  for (const change of [{ request: { ...c.request, status: "answered" } }, { request: { ...c.request, contextEventId: "new" } }, { instructionsRevision: 1 }]) {
    const changed = { ...c, ...change, run };
    assert.equal(requestRunMayExecute(run, changed.request, changed.instructionsRevision, later), false);
    assert.throws(() => transitionRequestRun(changed, "finish", { expectedRevision: 1, runId: "one", status: "succeeded" }, later));
    assert.equal(transitionRequestRun(changed, "finish", { expectedRevision: 1, runId: "one", status: "failed" }, later).status, "failed");
  }
});

test("stop and finish authority differ; stale writes cannot target another run", () => {
  const c = context(), run = start(c);
  for (const actor of [{ id: "stranger", kind: "human", active: true }, { id: "owner", kind: "agent", active: true }])
    assert.throws(() => transitionRequestRun({ ...c, run, actor }, "request_stop", { expectedRevision: 1, runId: "one" }, later));
  for (const actor of [{ id: "human", kind: "human", active: true }, { id: "owner", kind: "human", active: true }]) {
    assert.equal(transitionRequestRun({ ...c, run, actor }, "request_stop", { expectedRevision: 1, runId: "one" }, later).status, "stop_requested");
    assert.throws(() => transitionRequestRun({ ...c, run, actor }, "finish", { expectedRevision: 1, runId: "one", status: "failed" }, later));
  }
  assert.throws(() => transitionRequestRun({ ...c, run }, "finish", { expectedRevision: 0, runId: "one", status: "failed" }, later));
  assert.throws(() => transitionRequestRun({ ...c, run }, "finish", { expectedRevision: 1, runId: "two", status: "failed" }, later));
});

test("deliberate retries retain run identities and have a bounded attempt count", () => {
  const c = context(); let run = null;
  for (const runId of ["one", "two", "three"]) {
    run = transitionRequestRun({ ...c, run }, "claim", claim({ runId, expectedRevision: run?.revision ?? 0 }), now);
    run = transitionRequestRun({ ...c, run }, "finish", { expectedRevision: run.revision, runId, status: "failed" }, now);
    assert.throws(() => transitionRequestRun({ ...c, run }, "claim", claim({ runId, expectedRevision: run.revision }), now), /unavailable/);
  }
  assert.throws(() => transitionRequestRun({ ...c, run }, "claim", claim({ runId: "four", expectedRevision: run.revision }), now), /unavailable/);
  assert.deepEqual(run.usedRunIds, ["one", "two", "three"]);
});
