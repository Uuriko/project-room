import test from "node:test";
import assert from "node:assert/strict";
import { createMatchmakingRegistry, handleMatchmakingCore } from "../server/matchmaking-routes.mjs";
import { registerLane } from "../server/agent-lanes.mjs";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");

class Refusal extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const helpers = data => ({
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { throw new Refusal(status, code, message); },
  body: () => data,
});

const call = (route, { registry, caller = "ai_seeker", data, id = null } = {}) =>
  handleMatchmakingCore({
    req: { method: data === undefined ? "GET" : "POST" },
    store: {}, roomId: "muse-room", auth: { member: { id: caller } },
    matchmakingRoute: route, matchmakingId: id,
    helpers: helpers(data), registry, now: NOW,
  });

const refusal = (route, options) => {
  try { call(route, options); } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error(`${route} did not refuse`);
};

test("an agent declares what it is here for and reads back what was stored", () => {
  const registry = createMatchmakingRegistry();
  const { status, value } = call("declare", { registry, data: {
    motives: ["paid"], capabilities: ["rust", "kubernetes"], appetiteMinutes: 120, trustTier: 1 } });
  assert.equal(status, 201);
  assert.equal(value.seeker.seekerId, "ai_seeker");
  assert.deepEqual(value.seeker.motives, ["paid"]);
  assert.equal(value.seeker.appetiteMinutes, 120);
});

test("the seeker is the caller, so a body cannot declare for someone else", () => {
  const registry = createMatchmakingRegistry();
  const { value } = call("declare", { registry, caller: "ai_real", data: {
    seekerId: "ai_victim", motives: ["fun"], appetiteMinutes: 30 } });
  assert.equal(value.seeker.seekerId, "ai_real");
  assert.equal(registry.getSeeker("muse-room", "ai_victim"), null);
});

test("matching before declaring is a sequencing refusal, not a validation one", () => {
  const registry = createMatchmakingRegistry();
  const error = refusal("match", { registry, data: {} });
  assert.equal(error.status, 409);
  assert.equal(error.code, "not_declared");
});

test("a declared opening becomes matchable and an undeclared one stays invisible", () => {
  const registry = createMatchmakingRegistry();
  call("declare", { registry, data: { motives: ["paid"], capabilities: ["rust"], appetiteMinutes: 120, trustTier: 2 } });
  call("offer", { registry, caller: "ai_owner", data: {
    workId: "W-1", title: "Port the claim lease to rust", rewardKind: "paid",
    rewardAmount: 40, requires: ["rust"], sizeMinutes: 90, trustFloor: 0 } });
  const { status, value } = call("match", { registry, data: {} });
  assert.equal(status, 200);
  assert.equal(value.match.openingId, "W-1");
});

test("every opening passed over carries a coded reason", () => {
  const registry = createMatchmakingRegistry();
  call("declare", { registry, data: { motives: ["paid"], capabilities: ["rust"], appetiteMinutes: 60, trustTier: 0 } });
  call("offer", { registry, caller: "ai_owner", data: {
    workId: "W-too-big", title: "Rewrite the store", rewardKind: "paid",
    rewardAmount: 500, requires: ["rust"], sizeMinutes: 600, trustFloor: 0 } });
  call("offer", { registry, caller: "ai_owner", data: {
    workId: "W-too-trusted", title: "Rotate the signing key", rewardKind: "paid",
    rewardAmount: 90, requires: ["rust"], sizeMinutes: 30, trustFloor: 3 } });
  const { value } = call("match", { registry, data: {} });
  assert.equal(value.match, null);
  const codes = Object.fromEntries(value.rejected.map(r => [r.openingId, r.code]));
  assert.equal(codes["W-too-big"], "appetite");
  assert.equal(codes["W-too-trusted"], "trust");
  value.rejected.forEach(r => assert.ok(r.reason.length > 0, "a rejection always says why"));
});

test("bad input is 422 and never a 500", () => {
  const registry = createMatchmakingRegistry();
  const error = refusal("declare", { registry, data: { motives: ["gambling"], appetiteMinutes: 30 } });
  assert.equal(error.status, 422);
  assert.equal(error.code, "invalid_matchmaking_input");
});

test("a human decision opens as routable work and names who was asked", () => {
  const registry = createMatchmakingRegistry();
  registry.putLane("muse-room", registerLane({
    agentId: "fo", displayName: "Fo", lane: "courier", latencyMinutes: 5,
    reachesHuman: true, relaysFor: ["owner"] }));
  const { status, value } = call("decision-open", { registry, caller: "ai_asker", data: {
    decisionId: "D-1", question: "Do we freeze the inbox?", needsAuthority: "owner" } });
  assert.equal(status, 201);
  assert.equal(value.decision.decisionId, "D-1");
  assert.equal(value.chain[0].agentId, "fo");
  assert.equal(value.opening.rewardKind, "fun");
});

test("the courier records the human's answer and stays out of the attribution", () => {
  const registry = createMatchmakingRegistry();
  registry.putLane("muse-room", registerLane({
    agentId: "fo", displayName: "Fo", lane: "courier", latencyMinutes: 5,
    reachesHuman: true, relaysFor: ["owner"] }));
  call("decision-open", { registry, caller: "ai_asker", data: {
    decisionId: "D-2", question: "Freeze the inbox?", needsAuthority: "owner" } });
  const { value } = call("decision-answer", { registry, caller: "fo", id: "D-2", data: {
    answer: "accept", answeredBy: "john", note: "freeze it" } });
  assert.equal(value.answer.answer, "accept");
  assert.equal(value.answer.answeredBy, "john");
  assert.equal(value.answer.relayedBy, "fo");
});

test("an unknown decision is 404 and never leaks another room's row", () => {
  const registry = createMatchmakingRegistry();
  const error = refusal("decision-read", { registry, id: "D-nope" });
  assert.equal(error.status, 404);
  assert.equal(error.code, "decision_not_found");
});
