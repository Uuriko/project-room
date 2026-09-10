import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPUTE_ORIGIN,
  INTENDED_RECORDS,
  availableComponents,
  componentKinds,
  computeDeepLink
} from "../src/index.js";

const actor = Object.freeze({ memberId: "maya", capabilities: ["act"] });
const owner = Object.freeze({ memberId: "owner", role: "owner" });
const guest = Object.freeze({ memberId: "guest", capabilities: [] });

function event(over = {}) {
  return {
    id: over.id ?? `evt-${Math.random().toString(16).slice(2)}`,
    type: over.type ?? "message.posted",
    roomId: over.roomId ?? "commons",
    actorId: over.actorId ?? "agent",
    at: over.at ?? "2026-09-10T12:00:00.000Z",
    data: over.data ?? {}
  };
}

test("approve/reject: work.proposed-class Event offers both when the viewer has act", () => {
  const source = event({
    id: "propose-1",
    type: "work.proposed",
    data: { workItemId: "wi-decision", title: "Ship the brief" }
  });
  const { components } = availableComponents({ event: source, viewer: actor });
  assert.deepEqual(componentKinds({ components }), ["approve", "reject"]);
  assert.equal(components[0].label, "Approve");
  assert.equal(components[1].label, "Reject");
  assert.deepEqual(components[0].records, INTENDED_RECORDS.approve);
  assert.deepEqual(components[1].records, INTENDED_RECORDS.reject);
  assert.deepEqual(components[0].target, { eventId: "propose-1", workItemId: "wi-decision" });
  assert.equal(Object.hasOwn(components[0], "href"), false);
  assert.equal(Object.hasOwn(components[0], "run"), false);
});

test("open_compute: Receipt/Compute bridge pointer deep-links and never starts a run", () => {
  const source = event({
    id: "evt-receipt",
    type: "receipt.recorded",
    data: { receiptId: "rcpt-9", workItemId: "wi-job", computeJobId: "job-abc" }
  });
  const { components } = availableComponents({ event: source, viewer: guest });
  assert.equal(components.length, 1);
  assert.equal(components[0].kind, "open_compute");
  assert.equal(components[0].href, `${COMPUTE_ORIGIN}?work_item=wi-job&receipt=rcpt-9`);
  assert.equal(components[0].href.startsWith("https://getdasha.com/compute"), true);
  assert.match(components[0].href, /work_item=wi-job/);
  assert.match(components[0].href, /receipt=rcpt-9/);
  assert.equal(components[0].href.includes("/api"), false);
  assert.equal(Object.hasOwn(components[0], "records"), false);
  assert.equal(Object.hasOwn(components[0], "run"), false);
  assert.equal(Object.hasOwn(components[0], "start"), false);
  assert.deepEqual(components[0].target, {
    eventId: "evt-receipt",
    workItemId: "wi-job",
    receiptId: "rcpt-9",
    computeJobId: "job-abc"
  });
  assert.equal(computeDeepLink({ workItemId: "wi-job" }), `${COMPUTE_ORIGIN}?work_item=wi-job`);
});

test("plain chatter: message.posted and reactions mint no components", () => {
  const chatter = event({
    id: "chat-1",
    data: { body: "Agent update: still thinking." }
  });
  const reaction = event({
    id: "react-1",
    type: "message.reaction_set",
    data: { messageId: "chat-1", reaction: "like", active: true }
  });
  const receiptOnly = event({
    id: "rcpt-plain",
    type: "receipt.recorded",
    data: { receiptId: "rcpt-1", workItemId: "wi-1", status: "completed" }
  });
  assert.deepEqual(availableComponents({ event: chatter, viewer: actor }).components, []);
  assert.deepEqual(availableComponents({ event: reaction, viewer: actor }).components, []);
  assert.deepEqual(availableComponents({ event: receiptOnly, viewer: actor }).components, []);
});

test("capability gate: without act or owner, Approve/Reject are omitted; Open-in-Compute remains", () => {
  const proposed = event({
    id: "propose-gate",
    type: "work.proposed",
    data: { workItemId: "wi-gate" }
  });
  const bridged = event({
    id: "bridge-gate",
    type: "work.proposed",
    data: { workItemId: "wi-gate", computeJobId: "job-gate" }
  });
  const decideOnly = { memberId: "reviewer", capabilities: ["decide"] };

  assert.deepEqual(availableComponents({ event: proposed, viewer: guest }).components, []);
  assert.deepEqual(componentKinds(availableComponents({ event: proposed, viewer: decideOnly })), []);

  const { components } = availableComponents({ event: bridged, viewer: guest });
  assert.deepEqual(componentKinds({ components }), ["open_compute"]);
  assert.equal(components[0].href, `${COMPUTE_ORIGIN}?work_item=wi-gate`);
});

test("owner: Room owner can Approve/Reject without an act grant", () => {
  const source = event({
    id: "propose-owner",
    type: "work.proposed",
    data: { workItemId: "wi-owner" }
  });
  const { components } = availableComponents({ event: source, viewer: owner });
  assert.deepEqual(componentKinds({ components }), ["approve", "reject"]);
});

test("ack: optional Acknowledge appears when ackNeeded and the viewer can act", () => {
  const source = event({
    id: "need-ack",
    data: { ackNeeded: true, toMemberId: "maya", workItemId: "wi-ack", body: "Need a call." }
  });
  const { components } = availableComponents({ event: source, viewer: actor });
  assert.deepEqual(componentKinds({ components }), ["ack"]);
  assert.deepEqual(components[0].records, INTENDED_RECORDS.ack);
  assert.deepEqual(availableComponents({ event: source, viewer: guest }).components, []);
});
