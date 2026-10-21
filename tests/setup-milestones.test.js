import test from "node:test";
import assert from "node:assert/strict";
import { setupMilestones, MILESTONES } from "../server/setup-milestones.mjs";

const a = "agent-1";

test("nothing observed means nothing done and the first step is sign-in", () => {
  const m = setupMilestones([], { agentId: a });
  for (const name of MILESTONES) assert.equal(m[name].done, false);
  assert.equal(m.next.from, null);
  assert.match(m.next.text, /connect link/);
});

test("milestones are separate and only set by observed events", () => {
  const events = [
    { type: "agent.connected", at: 10, agentId: a },
    { type: "message.posted", at: 20, agentId: a, data: {} },
  ];
  const m = setupMilestones(events, { agentId: a, setupReport: { scheduleSaved: true, intervalMinutes: 10 } });
  assert.equal(m.connected.done, true);
  assert.equal(m.firstExchange.done, false, "a message that answers nothing is not an exchange");
  assert.equal(m.backgroundRun.done, false, "a saved schedule is not a run");
  assert.equal(m.scheduleSaved, true);
  assert.equal(m.next.from, "connected");
});

test("troubleshooting starts from the last real step", () => {
  const base = [{ type: "agent.connected", at: 10, agentId: a }, { type: "reply.posted", at: 30, agentId: a }];
  assert.match(setupMilestones(base, { agentId: a, setupReport: { scheduleSaved: true, intervalMinutes: 60 } }).next.text, /Wait one interval \(60 minutes\)/);
  assert.match(setupMilestones(base, { agentId: a, setupReport: { scheduleSaved: false, limitation: "no tasks on this plan" } }).next.text, /no tasks on this plan/);
  assert.match(setupMilestones(base, { agentId: a }).next.text, /setup intro/);
  const done = setupMilestones([...base, { type: "schedule.run", at: 90, agentId: a }], { agentId: a });
  assert.equal(done.backgroundRun.done, true);
  assert.equal(done.backgroundRun.at, 90);
  assert.equal(done.next.text, null);
});

test("other agents' events and undated events do not count", () => {
  const m = setupMilestones([{ type: "agent.connected", at: 5, agentId: "other" }, { type: "agent.connected", agentId: a }], { agentId: a });
  assert.equal(m.connected.done, false);
});

test("the earliest evidence is the milestone time", () => {
  const m = setupMilestones([{ type: "work.result", at: 50, agentId: a }, { type: "reply.posted", at: 40, agentId: a }, { type: "agent.joined", at: 1, agentId: a }], { agentId: a });
  assert.equal(m.firstExchange.at, 40);
});

test("the support export carries setup milestones only when asked", async () => {
  const { supportExportBundle } = await import("../server/diagnostics.mjs");
  assert.equal("setup" in supportExportBundle({ roomId: "r" }), false);
  const bundle = supportExportBundle({ roomId: "r", setup: { agentId: a, events: [{ type: "agent.connected", at: 3, agentId: a, data: { secret: "x" } }] } });
  assert.deepEqual(bundle.setup.connected, { done: true, at: 3 });
  assert.equal(bundle.setup.firstExchange.done, false);
  assert.doesNotMatch(JSON.stringify(bundle), /secret/);
});
