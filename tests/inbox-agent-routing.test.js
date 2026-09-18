// LANE C (quill/inbox-agent-collab): @agent mention routing — direct vs
// escalate policy with journaled routing/escalation records.
import test from "node:test";
import assert from "node:assert/strict";
import { RoutingError, createAgentRouter, defaultPolicy, extractAgentMentions,
  routingModes, routingStatuses } from "../server/inbox-agent-routing.mjs";

const agent = { kind: "agent", id: "claude" };
const human = { kind: "human", id: "john" };
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.ok(error instanceof RoutingError); assert.equal(error.code, code); return; }
  assert.fail(`expected ${code} but nothing threw`);
};
const fixedClock = (times = [1000]) => { let i = 0; return () => times[Math.min(i++, times.length - 1)]; };
const ids = (() => { let n = 0; return () => `route-${++n}`; })();

test("extractAgentMentions finds ordered, unique mentions and skips emails", () => {
  assert.deepEqual(extractAgentMentions("@claude look at this"), ["claude"]);
  assert.deepEqual(extractAgentMentions("@claude and @instinct, then @claude again"), ["claude", "instinct"]);
  assert.deepEqual(extractAgentMentions("ping @codex-bot:1 for review"), ["codex-bot:1"]);
  assert.deepEqual(extractAgentMentions("write to jane@example.com about it"), []);
  assert.deepEqual(extractAgentMentions("no mentions here"), []);
  assert.ok(Object.isFrozen(extractAgentMentions("@claude hi")));
  expectCode(() => extractAgentMentions(null), "routing_invalid");
});
test("direct policy routes straight to the named agent", () => {
  const router = createAgentRouter({ clock: fixedClock([1000]), id: ids });
  const { records, mentions } = router.route("thread:1", { text: "@claude review this", from: human });
  assert.deepEqual(mentions, ["claude"]);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.agent, "claude");
  assert.equal(record.mode, "direct");
  assert.equal(record.status, "routed");
  assert.equal(record.escalatedTo, null);
  assert.equal(record.history.length, 1);
  assert.ok(Object.isFrozen(record) && Object.isFrozen(record.policy) && Object.isFrozen(record.history));
});
test("escalate policy sends the mention to the escalation target first", () => {
  const router = createAgentRouter({ clock: fixedClock([1000]), id: ids,
    policy: { deployer: { mode: "escalate", escalateTo: human, note: "Deploys need a human eye." } } });
  const { records } = router.route("thread:1", { text: "@deployer ship it", from: agent });
  assert.equal(records.length, 1);
  assert.equal(records[0].mode, "escalate");
  assert.equal(records[0].status, "escalated");
  assert.equal(records[0].escalatedTo.id, "john");
});
test("escalate lifts a routed mention; resolve closes it with an outcome", () => {
  const router = createAgentRouter({ clock: fixedClock([1000, 2000, 3000]), id: ids });
  const { records } = router.route("thread:1", { text: "@claude urgent", from: human, context: "customer thread" });
  const escalated = router.escalate(records[0].routingId, { by: human, reason: "Needs owner sign-off", to: human });
  assert.equal(escalated.status, "escalated");
  assert.equal(escalated.escalatedTo.id, "john");
  assert.equal(escalated.history.at(-1).reason, "Needs owner sign-off");
  const resolved = router.resolve(records[0].routingId, { by: human, outcome: "Handled in the thread." });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.history.at(-1).outcome, "Handled in the thread.");
  assert.equal(router.openCount(), 0);
});
test("illegal transitions are refused", () => {
  const router = createAgentRouter({ clock: fixedClock([1000, 2000]), id: ids });
  const { records } = router.route("thread:1", { text: "@claude hi", from: human });
  router.resolve(records[0].routingId, { by: human, outcome: "done" });
  expectCode(() => router.escalate(records[0].routingId, { by: human, reason: "x" }), "routing_transition");
  expectCode(() => router.resolve(records[0].routingId, { by: human, outcome: "x" }), "routing_transition");
  expectCode(() => router.resolve("route-missing", { by: human, outcome: "x" }), "routing_not_found");
});
test("setPolicy updates per-agent behavior; an escalate policy needs a target", () => {
  const router = createAgentRouter({ clock: fixedClock([1000, 2000]), id: ids });
  expectCode(() => router.setPolicy("deployer", { mode: "escalate" }), "routing_invalid");
  router.setPolicy("deployer", { mode: "escalate", escalateTo: human, scopes: ["ship"] });
  const { records } = router.route("thread:1", { text: "@deployer go", from: agent });
  assert.equal(records[0].status, "escalated");
  assert.deepEqual(records[0].policy.scopes, ["ship"]);
});
test("route with no mentions returns an empty frozen record list", () => {
  const router = createAgentRouter({ id: ids });
  const { records, mentions } = router.route("thread:1", { text: "plain text", from: human });
  assert.deepEqual(mentions, []);
  assert.deepEqual(records, []);
  assert.ok(Object.isFrozen(records));
});
test("list filters by status, agent and thread", () => {
  const router = createAgentRouter({ clock: fixedClock([1000, 2000]), id: ids });
  const first = router.route("thread:1", { text: "@claude hi", from: human });
  router.route("thread:2", { text: "@instinct hi", from: human });
  router.resolve(first.records[0].routingId, { by: human, outcome: "done" });
  assert.equal(router.list({ status: "routed" }).length, 1);
  assert.equal(router.list({ agent: "claude" }).length, 1);
  assert.equal(router.list({ threadId: "thread:2" }).length, 1);
  expectCode(() => router.list({ status: "vapor" }), "routing_invalid");
});
test("exported enums stay frozen", () => {
  assert.deepEqual([...routingModes], ["direct", "escalate"]);
  assert.deepEqual([...routingStatuses], ["routed", "escalated", "resolved"]);
  assert.equal(defaultPolicy.mode, "direct");
  assert.ok(Object.isFrozen(routingModes) && Object.isFrozen(routingStatuses) && Object.isFrozen(defaultPolicy));
});
