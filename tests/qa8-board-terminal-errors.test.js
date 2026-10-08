// QA8 (2026-10-08, live prod user test): a closed Board item answered claim
// with "already closed — release it first" (release then 422'd "immutable"),
// update with 403 "owned by nobody" plus a "claim it first" hint, and
// release with 422 invalid_claim_input. Every verb on a done/closed item now
// answers 409 work_claim_terminal, and the agent hint for that code (and a
// few other codes that fell through to "Unknown error ... report the code to
// the room owner") names the real recovery.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { agentErrorAx } from "../src/agent-error.mjs";

const MEMBERS = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work", "verify", "steer"] },
  holder: { id: "holder", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};
const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};
const call = (registry, memberId, route, id, body) => handleWorkClaims({
  req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
  res: {},
  url: new URL("https://room.example/api/rooms/room1/work-claims"),
  store: { roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }), room: () => ({ state: { messages: [] } }) },
  roomId: "room1",
  auth: { member: { id: memberId, kind: MEMBERS[memberId].kind, permissions: MEMBERS[memberId].permissions } },
  workClaimRoute: route,
  workClaimId: id,
  helpers,
  registry,
});
const outcome = async promise => {
  try { const result = await promise; return { status: result.status, code: result.value?.error?.code, message: result.value?.error?.message }; }
  catch (error) { if (!Number.isInteger(error?.status)) throw error; return { status: error.status, code: error.code, message: error.message }; }
};

test("every verb on a closed item answers 409 work_claim_terminal, not a release/claim/owner hint", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "gone" })).status, 201);
  assert.equal((await call(registry, "holder", "claim", "gone", {})).status, 200);
  assert.equal((await call(registry, "holder", "close", "gone", { reason: "qa8" })).status, 200);
  for (const [who, route, body] of [
    ["holder", "claim", {}],
    ["owner", "claim", {}],
    ["holder", "update", { state: "in_progress" }],
    ["owner", "update", { note: "late note" }],
    ["owner", "release", {}],
    ["holder", "renew", {}],
    ["owner", "reassign", { newOwner: "holder" }],
  ]) {
    const result = await outcome(call(registry, who, route, "gone", body));
    assert.equal(result.status, 409, `${who} ${route}`);
    assert.equal(result.code, "work_claim_terminal", `${who} ${route}`);
    assert.match(result.message, /already closed, which is final/, `${who} ${route}`);
    assert.doesNotMatch(result.message, /release it first|owned by nobody/, `${who} ${route}`);
  }
  assert.equal(registry.get("room1", "gone").state, "closed");
});

test("a live item still gets the ordinary conflict and owner refusals", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "owner", "create", null, { id: "live" });
  await call(registry, "holder", "claim", "live", {});
  assert.deepEqual((({ status, code }) => ({ status, code }))(await outcome(call(registry, "owner", "claim", "live", {}))), { status: 409, code: "work_claim_conflict" });
});

test("agent hints name a recovery for board-terminal, board-conflict, used invites and unknown routes", () => {
  for (const [httpStatus, code, pattern] of [
    [409, "work_claim_terminal", /final.*new item/i],
    [409, "work_claim_conflict", /re-read it/i],
    [409, "invite_already_used", /fresh invite.*Never paste/i],
    [404, "invite_unavailable", /fresh invite/i],
    [404, "not_found", /openapi\.json/i],
  ]) {
    const ax = agentErrorAx({ httpStatus, code, roomId: "room1" });
    assert.equal(ax.reason, code);
    assert.doesNotMatch(ax.hint, /Unknown error/, code);
    assert.match(ax.hint, pattern, code);
    assert.ok(ax.hint.length < 160, `${code} hint fits the 160-char budget`);
    assert.ok(Array.isArray(ax.next) && ax.next.length > 0, code);
  }
});
