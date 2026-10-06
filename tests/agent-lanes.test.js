import test from "node:test";
import assert from "node:assert/strict";
import {
  registerLane, openDecision, routeDecision, recordAnswer, decisionAsOpening,
  LANES, AUTHORITIES,
} from "../server/agent-lanes.mjs";
import { declareSeeker, matchWork } from "../server/work-matchmaking.mjs";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const clock = () => NOW;
const inMinutes = n => new Date(NOW + n * 60000).toISOString();

const courier = (over = {}) => registerLane({
  agentId: "ai_fo", displayName: "Fo", lane: "courier", latencyMinutes: 3,
  relaysFor: ["owner", "member"], reachesHuman: true, ...over,
});
const executor = (over = {}) => registerLane({
  agentId: "ai_codex", displayName: "Codex", lane: "executor", latencyMinutes: 30,
  hasWorkspace: true, ...over,
});
const decision = (over = {}) => openDecision({
  decisionId: "d-1", roomId: "muse-room", question: "Merge PR 811?",
  needsAuthority: "owner", notAfter: inMinutes(60), ...over,
});

test("the four lanes are the shapes agents actually come in", () => {
  assert.deepEqual([...LANES].sort(), ["adversary", "courier", "executor", "prober"]);
  assert.deepEqual([...AUTHORITIES], ["owner", "verifier", "member"]);
});

test("a lane is a claim about capability, so it has to be consistent", () => {
  assert.throws(() => registerLane({ agentId: "a", displayName: "A", lane: "courier", latencyMinutes: 3, relaysFor: ["owner"] }),
    /must reach a human/);
  assert.throws(() => registerLane({ agentId: "a", displayName: "A", lane: "executor", latencyMinutes: 3 }),
    /must hold a workspace/);
  assert.throws(() => registerLane({ agentId: "a", displayName: "A", lane: "adversary", latencyMinutes: 3, relaysFor: ["owner"] }),
    /only a courier relays/);
  assert.throws(() => registerLane({ agentId: "a", displayName: "A", lane: "courier", latencyMinutes: 3, reachesHuman: true }),
    /must say whose decisions it can carry/);
});

test("an adversary needs neither a human nor a workspace, which is the point", () => {
  const grok = registerLane({ agentId: "ai_grok", displayName: "Grok Build", lane: "adversary", latencyMinutes: 10 });
  assert.equal(grok.hasWorkspace, false);
  assert.equal(grok.reachesHuman, false);
});

test("a decision routes to couriers, fastest first, and never to an executor", () => {
  const route = routeDecision({
    decision: decision(),
    lanes: [executor(), courier({ agentId: "ai_instinct", displayName: "Instinct", latencyMinutes: 8 }), courier()],
    now: clock,
  });
  assert.deepEqual(route.chain.map(c => c.agentId), ["ai_fo", "ai_instinct"]);
  assert.equal(route.setAside.find(s => s.agentId === "ai_codex").why, "not a courier");
});

test("a chain, not a single courier, because one unreachable person is the bug", () => {
  const route = routeDecision({ decision: decision(), lanes: [courier(), courier({ agentId: "ai_b", latencyMinutes: 20 })], now: clock });
  assert.equal(route.chain.length, 2);
});

test("a courier that cannot carry this authority is set aside with the reason", () => {
  const route = routeDecision({
    decision: decision({ needsAuthority: "verifier" }),
    lanes: [courier()],
    now: clock,
  });
  assert.equal(route.unreachable, true);
  assert.match(route.setAside[0].why, /cannot carry a verifier decision/);
});

test("a courier slower than the window left is not offered", () => {
  const route = routeDecision({
    decision: decision({ notAfter: inMinutes(5) }),
    lanes: [courier({ latencyMinutes: 30 })],
    now: clock,
  });
  assert.equal(route.unreachable, true);
  assert.match(route.setAside[0].why, /30 minutes and there are 5 left/);
});

test("a sleeping courier is skipped at night and used by day", () => {
  const night = courier({ agentId: "ai_night", availability: "waking-hours" });
  assert.equal(routeDecision({ decision: decision(), lanes: [night], now: clock, wakingHours: false }).unreachable, true);
  assert.equal(routeDecision({ decision: decision(), lanes: [night], now: clock, wakingHours: true }).chain.length, 1);
});

test("a window that has already shut is reported expired, not routed", () => {
  const route = routeDecision({ decision: decision({ notAfter: inMinutes(-1) }), lanes: [courier()], now: clock });
  assert.equal(route.expired, true);
  assert.equal(route.unreachable, true);
});

test("nobody to carry it is said plainly", () => {
  const route = routeDecision({ decision: decision(), lanes: [], now: clock });
  assert.equal(route.unreachable, true);
  assert.deepEqual(route.chain, []);
});

test("the answer belongs to the person; the courier is only the carrier", () => {
  const receipt = recordAnswer({
    decision: decision(), courier: courier(), answer: "accept",
    answeredBy: "jonathan", answeredAt: NOW + 120000, note: "ship it",
  });
  assert.equal(receipt.answeredBy, "jonathan");
  assert.equal(receipt.relayedBy, "ai_fo");
  assert.equal(receipt.question, "Merge PR 811?");
  assert.equal(receipt.authority, "owner");
  assert.equal(Object.isFrozen(receipt), true);
});

test("a courier cannot answer as itself, and an unsigned answer is refused", () => {
  assert.throws(() => recordAnswer({ decision: decision(), courier: courier(), answer: "accept", answeredBy: "ai_fo", answeredAt: NOW }),
    /never decides/);
  assert.throws(() => recordAnswer({ decision: decision(), courier: courier(), answer: "accept", answeredAt: NOW }),
    /the person who answered/);
  assert.throws(() => recordAnswer({ decision: decision(), courier: executor(), answer: "accept", answeredBy: "j", answeredAt: NOW }),
    /only a courier/);
});

test("answers use the accept, decline, cancel vocabulary elicitation already defines", () => {
  for (const answer of ["accept", "decline", "cancel"]) {
    assert.equal(recordAnswer({ decision: decision(), courier: courier(), answer, answeredBy: "j", answeredAt: NOW }).answer, answer);
  }
  assert.throws(() => recordAnswer({ decision: decision(), courier: courier(), answer: "maybe", answeredBy: "j", answeredAt: NOW }),
    /accept, decline or cancel/);
});

test("a receipt carries what the answer unblocks", () => {
  const receipt = recordAnswer({
    decision: decision({ blocking: ["pr-811", "deploy-hold"] }),
    courier: courier(), answer: "accept", answeredBy: "j", answeredAt: NOW,
  });
  assert.deepEqual([...receipt.unblocks], ["pr-811", "deploy-hold"]);
});

test("a decision is matchable work, so it needs no second matcher", () => {
  const opening = decisionAsOpening(decision());
  assert.equal(opening.rewardKind, "fun");
  assert.equal(opening.sizeMinutes, 2);
  assert.deepEqual([...opening.requires], ["reach-a-human"]);
  const phoneAgent = declareSeeker({
    seekerId: "ai_fo", motives: ["fun"], capabilities: ["reach-a-human"], appetiteMinutes: 10, trustTier: 0,
  });
  assert.equal(matchWork({ seeker: phoneAgent, openings: [opening], now: clock }).match.openingId, "decision:d-1");
  // an agent with no human to ask simply does not match it
  const ide = declareSeeker({ seekerId: "ai_codex", motives: ["fun"], capabilities: ["javascript"], appetiteMinutes: 600 });
  assert.equal(matchWork({ seeker: ide, openings: [opening], now: clock }).rejected[0].code, "capability");
});

test("lanes stay pure: frozen out, clock injected, no status codes", () => {
  const route = routeDecision({ decision: decision(), lanes: [courier()], now: clock });
  assert.equal(Object.isFrozen(route), true);
  assert.equal(Object.isFrozen(route.chain[0]), true);
  assert.throws(() => routeDecision({ decision: decision(), lanes: [courier()] }), /now must be a clock function/);
  try { recordAnswer({ decision: decision(), courier: courier(), answer: "accept", answeredBy: "ai_fo", answeredAt: NOW }); }
  catch (err) { assert.equal(err.code, "courier_cannot_decide"); assert.equal("status" in err, false); }
});
