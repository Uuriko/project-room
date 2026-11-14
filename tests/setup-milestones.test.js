import test from "node:test";
import assert from "node:assert/strict";
import { setupMilestones, MILESTONES } from "../server/setup-milestones.mjs";
import { supportExportBundle } from "../server/diagnostics.mjs";

const a = "mem_agent1";
// Fixtures use the journal's real shape: { type, actorId, at: ISO, data }.
const added = { type: "member.added", actorId: "mem_owner", at: "2026-10-21T20:00:00.000Z", data: { memberId: a, kind: "agent", permissions: ["chat"] } };
const plainMessage = { type: "message.posted", actorId: a, at: "2026-10-21T20:01:00.000Z", data: { messageId: "m1", body: "hi" } };
const reply = { type: "message.posted", actorId: a, at: "2026-10-21T20:02:00.000Z", data: { messageId: "m2", body: "done", replyToId: "m0" } };
const T = iso => Date.parse(iso);

test("nothing observed means nothing done and the first step is sign-in", () => {
  const m = setupMilestones([], { agentId: a });
  for (const name of MILESTONES) assert.equal(m[name].done, false);
  assert.equal(m.next.from, null);
  assert.match(m.next.text, /connect link/);
});

test("member.added for the agent marks connected at its ISO time", () => {
  const m = setupMilestones([added], { agentId: a });
  assert.equal(m.connected.done, true);
  assert.equal(m.connected.at, T(added.at));
  assert.equal(m.next.from, "connected");
});

test("a message that answers nothing is not an exchange; a reply is", () => {
  assert.equal(setupMilestones([added, plainMessage], { agentId: a }).firstExchange.done, false);
  const m = setupMilestones([added, plainMessage, reply], { agentId: a });
  assert.equal(m.firstExchange.at, T(reply.at));
  const done = { type: "work.completed", actorId: a, at: "2026-10-21T19:59:00.000Z", data: {} };
  assert.equal(setupMilestones([done], { agentId: a }).firstExchange.at, T(done.at));
});

test("acting in the room also proves the agent connected", () => {
  assert.equal(setupMilestones([plainMessage], { agentId: a }).connected.done, true);
});

test("a saved schedule is not a run; a cadenced heartbeat is", () => {
  const report = { scheduleSaved: true, intervalMinutes: 10 };
  const m = setupMilestones([added, reply], { agentId: a, setupReport: report });
  assert.equal(m.backgroundRun.done, false);
  assert.match(m.next.text, /Wait one interval \(10 minutes\)/);
  assert.equal(setupMilestones([added, reply], { agentId: a, heartbeats: [{ at: "2026-10-21T20:10:00Z" }] }).backgroundRun.done, false, "no cadence means a live session, not a schedule");
  const ran = setupMilestones([added, reply], { agentId: a, setupReport: report, heartbeats: [{ at: "2026-10-21T20:10:00Z", cadenceSeconds: 600 }] });
  assert.equal(ran.backgroundRun.at, T("2026-10-21T20:10:00Z"));
  assert.equal(ran.next.text, null);
});

test("troubleshooting starts from the last real step", () => {
  assert.match(setupMilestones([added, reply], { agentId: a, setupReport: { scheduleSaved: false, limitation: "no tasks on this plan" } }).next.text, /no tasks on this plan/);
  assert.match(setupMilestones([added, reply], { agentId: a }).next.text, /setup intro/);
  assert.match(setupMilestones([added, reply], { agentId: a, setupReport: { scheduleSaved: true } }).next.text, /Wait one interval, then/);
});

test("other members' events and undated events do not count", () => {
  const other = { ...added, data: { ...added.data, memberId: "mem_other" } };
  assert.equal(setupMilestones([other, { ...plainMessage, at: "not a date" }], { agentId: a }).connected.done, false);
});

test("the support export carries setup milestones only when asked, bounded and flattened", () => {
  assert.equal("setup" in supportExportBundle({ roomId: "r" }), false);
  const bundle = supportExportBundle({ roomId: "r", setup: { agentId: a, events: [added], setupReport: null } });
  assert.deepEqual(bundle.setup.connected, { done: true, at: T(added.at) });
  assert.equal(bundle.setup.firstExchange.done, false);
  assert.doesNotMatch(JSON.stringify(bundle), /permissions/);
  const long = supportExportBundle({ roomId: "r", setup: { agentId: a, events: [added, reply], setupReport: { scheduleSaved: false, limitation: "line\none" + "x".repeat(1000) } } });
  assert.ok(long.setup.nextStep.length <= 400);
  assert.doesNotMatch(long.setup.nextStep, /\n/);
});
