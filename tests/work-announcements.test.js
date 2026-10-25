import test from "node:test";
import assert from "node:assert/strict";
import { workArrivalAnnouncement, workArrivalAnnouncements } from "../src/work-announcements.js";

// #3687: work arrivals (claim, completion, review, decision by another
// member) must be announced with the actor, the item and the new state.
const TITLES = { w1: "Draft the launch note", w2: "Fix the parser" };
const NAMES = { maya: "Maya", jo: "Jo", me: "Me" };
const context = {
  selfId: "me",
  actorName: id => NAMES[id] ?? `Unknown member (${id})`,
  titleFor: id => TITLES[id] ?? null,
};
const event = (type, actorId, data) => ({ id: `e-${type}-${actorId}`, type, actorId, data });

test("a claim by another member names the actor and the item", () => {
  assert.equal(
    workArrivalAnnouncement(event("work.accepted", "maya", { workItemId: "w1" }), context),
    "Maya claimed 'Draft the launch note'.");
});

test("a completion names the actor and the item and says it awaits review", () => {
  assert.equal(
    workArrivalAnnouncement(event("work.completed", "maya", { workItemId: "w1" }), context),
    "Maya completed 'Draft the launch note' — ready for your review.");
});

test("a recorded review names the reviewer, the item and the result", () => {
  assert.equal(
    workArrivalAnnouncement(event("verification.recorded", "jo", { workItemId: "w1", result: "pass" }), context),
    "Jo recorded a passing review for 'Draft the launch note'.");
  assert.equal(
    workArrivalAnnouncement(event("verification.recorded", "jo", { workItemId: "w1", result: "fail" }), context),
    "Jo recorded a failing review for 'Draft the launch note'.");
});

test("a decision by another member names the decider, the item and the outcome", () => {
  assert.equal(
    workArrivalAnnouncement(event("owner.decision_recorded", "jo", { workItemId: "w2", decision: "approved" }), context),
    "Jo approved 'Fix the parser'.");
  assert.equal(
    workArrivalAnnouncement(event("owner.decision_recorded", "jo", { workItemId: "w2", decision: "changes_requested" }), context),
    "Jo requested changes on 'Fix the parser'.");
  assert.equal(
    workArrivalAnnouncement(event("owner.decision_recorded", "jo", { workItemId: "w2", decision: "rejected" }), context),
    "Jo rejected 'Fix the parser'.");
});

test("the watcher's own work events are not announced back to them", () => {
  for (const type of ["work.accepted", "work.completed", "verification.recorded", "owner.decision_recorded"]) {
    assert.equal(workArrivalAnnouncement(event(type, "me", { workItemId: "w1", result: "pass", decision: "approved" }), context), null);
  }
});

test("events that do not change what the watcher can do next stay silent", () => {
  assert.equal(workArrivalAnnouncement(event("work.started", "maya", { workItemId: "w1" }), context), null);
  assert.equal(workArrivalAnnouncement(event("work.proposed", "maya", { workItemId: "w1" }), context), null);
  assert.equal(workArrivalAnnouncement(event("message.posted", "maya", { messageId: "m1" }), context), null);
  assert.equal(workArrivalAnnouncement(event("work.completed", "maya", { workItemId: "missing" }), context), null);
  assert.equal(workArrivalAnnouncement(null, context), null);
});

test("several arrivals in one snapshot keep one sentence each, in log order", () => {
  const text = workArrivalAnnouncements([
    event("work.accepted", "maya", { workItemId: "w1" }),
    event("message.posted", "jo", { messageId: "m2" }),
    event("work.completed", "maya", { workItemId: "w1" }),
  ], context);
  assert.equal(text, "Maya claimed 'Draft the launch note'. Maya completed 'Draft the launch note' — ready for your review.");
});

test("a snapshot with no announceable arrivals yields empty text", () => {
  assert.equal(workArrivalAnnouncements([], context), "");
  assert.equal(workArrivalAnnouncements([event("work.started", "maya", { workItemId: "w1" })], context), "");
});
