import test from "node:test";
import assert from "node:assert/strict";
import { applyEvent, emptyRoomState, event, EVENT_TYPES as T } from "../src/events.js";
import { WORK_TEMPLATES, workTemplate, workTemplateIds } from "../src/work-templates.js";

// Fields work.proposed reads from event data (src/events.js proposeWork). A
// template's `work` fragment must stay inside this set so it is usable verbatim.
const PROPOSAL_FIELDS = ["title", "definitionOfDone", "mode", "ownerDecisionRequired", "independentVerificationRequired"];

function seeded() {
  let state = emptyRoomState(), serial = 0;
  const send = (type, actorId, data) => { state = applyEvent(state, event({ type, actorId, data, roomId: "room",
    at: "2026-09-08T12:00:00.000Z", id: `event-${++serial}`, idempotencyKey: `key-${serial}` })); };
  send(T.ROOM_CREATED, "owner", { roomId: "room", ownerId: "owner", title: "Room", purpose: "Template checks" });
  for (const [memberId, kind, permissions] of [
    ["owner", "human", ["manage_members", "steer", "decide", "accept_work"]],
    ["agent", "agent", ["accept_work", "complete_work"]],
    ["reviewer", "agent", ["verify"]]
  ]) send(T.MEMBER_ADDED, "owner", { memberId, displayName: memberId, kind, permissions });
  return { get state() { return state; }, send };
}

test("work templates catalog (round-2 #103): clean proposal fragments plus separate hints", () => {
  assert.ok(WORK_TEMPLATES.length >= 5);
  for (const t of WORK_TEMPLATES) {
    assert.ok(t.id && t.title && t.description);
    assert.ok(t.work.title && t.work.definitionOfDone);
    // Every key in `work` is one the reducer accepts; advisory keys live in `hints`.
    assert.deepEqual(Object.keys(t.work).filter(key => !PROPOSAL_FIELDS.includes(key)), [], `${t.id} carries non-proposal keys in work`);
    assert.equal(t.work.mode, "read", `${t.id}: write mode needs a claim and write_external`);
    assert.ok(Array.isArray(t.hints.suggestedCapabilities) && t.hints.suggestedCapabilities.length > 0);
    assert.ok(Array.isArray(t.hints.suggestedFields) && t.hints.suggestedFields.length > 0);
  }
  assert.equal(workTemplate("outreach").work.ownerDecisionRequired, true, "human approval is the owner-decision gate");
  assert.deepEqual(workTemplateIds().sort(), WORK_TEMPLATES.map(t => t.id).sort());
  assert.equal(workTemplate("compute-job").id, "compute-job");
  assert.equal(workTemplate("nope"), null);
});

test("every template is directly usable as work.proposed data", () => {
  const f = seeded();
  for (const t of WORK_TEMPLATES) {
    const workItemId = `job-${t.id}`;
    assert.doesNotThrow(() => f.send(T.WORK_PROPOSED, "owner", { ...t.work, workItemId, title: `Use ${t.id}`,
      accountableMemberId: "agent", verifierMemberId: "reviewer", humanDecisionMakerId: "owner" }), t.id);
    const item = f.state.workItems[workItemId];
    assert.equal(item.mode, "read");
    assert.equal(item.definitionOfDone, t.work.definitionOfDone);
    assert.equal(item.ownerDecisionRequired, t.work.ownerDecisionRequired === true);
  }
  // A template needing human approval still refuses a proposal without a decision-maker.
  assert.throws(() => f.send(T.WORK_PROPOSED, "owner", { ...workTemplate("outreach").work, workItemId: "no-decider",
    title: "Outreach without a decider", accountableMemberId: "agent" }), /decision-maker/);
});
