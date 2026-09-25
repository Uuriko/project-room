// Action-layer tests: validate() contracts, the submitReceipt state-machine
// walk, and failure shaping — all with a recording fake client (no network,
// no server). The live test owns the real-boundary proof; this file owns the
// action layer's own contracts.
//
// Authoring gate: protects (1) input validation the agent relies on for clear
// errors, (2) the claimed -> in_progress -> done walk the room's state machine
// requires — a dropped walk 422s every submitReceipt on freshly-claimed
// items, and (3) the { ok:false, code } failure contract (actions never
// throw room errors at the ElizaOS runtime).

import test from "node:test";
import assert from "node:assert/strict";
import { roomActions, ACTION_NAMES } from "../src/actions.js";
import { RoomApiError } from "../src/roomClient.js";

/** Fake client: methods resolve from scripted values and record calls. */
function fakeClient(script = {}) {
  const calls = [];
  const client = new Proxy({}, {
    get: (_t, method) => async (...args) => {
      calls.push({ method, args });
      const impl = script[method];
      if (typeof impl === "function") return impl(...args);
      if (impl instanceof Error) throw impl;
      return impl;
    },
  });
  return { client, calls };
}

const config = { roomId: "commons" };
const apiError = (code, status = 422) => new RoomApiError({ status, code, message: code });

test("every action has a unique ROOM_ name and a validate function", () => {
  const names = Object.values(roomActions).map(a => a.name);
  assert.deepEqual(names, ACTION_NAMES);
  assert.equal(new Set(names).size, names.length, "action names are unique");
  for (const action of Object.values(roomActions)) {
    assert.match(action.name, /^ROOM_[A-Z_]+$/, `${action.name} follows the ROOM_ convention`);
    assert.equal(typeof action.description, "string");
    assert.ok(action.description.length > 20, `${action.name} describes itself`);
    assert.equal(typeof action.validate, "function");
    assert.equal(typeof action.run, "function");
  }
});

test("validate() rejects bad input with an explainable string", () => {
  assert.equal(typeof roomActions.join.validate({}), "string");
  assert.equal(typeof roomActions.join.validate({ code: "RM-1" }), "string");
  assert.equal(roomActions.join.validate({ code: "RM-1", displayName: "X" }), true);
  assert.equal(typeof roomActions.claimTask.validate({}), "string");
  assert.equal(roomActions.claimTask.validate({ claimId: "t" }), true);
  assert.equal(typeof roomActions.submitReceipt.validate({}), "string");
  assert.equal(typeof roomActions.submitReceipt.validate({ claimId: "x", deliveryMode: "teleport" }), "string");
  assert.equal(roomActions.submitReceipt.validate({ claimId: "x", deliveryMode: "merged" }), true);
  assert.equal(typeof roomActions.postUpdate.validate({ body: "  " }), "string");
  assert.equal(typeof roomActions.postUpdate.validate({ body: "x".repeat(65537) }), "string");
  assert.equal(roomActions.postUpdate.validate({ body: "hello" }), true);
  assert.equal(typeof roomActions.releaseClaim.validate({}), "string");
  assert.equal(roomActions.listWork.validate({}), true);
  assert.equal(roomActions.readInbox.validate({}), true);
});

test("submitReceipt walks claimed -> in_progress -> done (room state machine)", async () => {
  const { client, calls } = fakeClient({
    getClaim: async () => ({ id: "t", state: "claimed" }),
    updateClaim: async (_r, _id, body) => ({ id: "t", state: body.state }),
  });
  const res = await roomActions.submitReceipt.run({ client, params: { claimId: "t", note: "done", deliveryMode: "result" }, config });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.claim.state, "done");
  assert.equal(res.receiptId, "rc_t");
  const updates = calls.filter(c => c.method === "updateClaim");
  assert.deepEqual(updates.map(c => c.args[2].state), ["in_progress", "done"]);
});

test("submitReceipt skips the walk when the item is already in_progress", async () => {
  const { client, calls } = fakeClient({
    getClaim: async () => ({ id: "t", state: "in_progress" }),
    updateClaim: async (_r, _id, body) => ({ id: "t", state: body.state }),
  });
  const res = await roomActions.submitReceipt.run({ client, params: { claimId: "t", deliveryMode: "merged" }, config });
  assert.equal(res.ok, true);
  const updates = calls.filter(c => c.method === "updateClaim");
  assert.deepEqual(updates.map(c => c.args[2].state), ["done"]);
});

test("submitReceipt proceeds when the item cannot be read (the done call surfaces the real error)", async () => {
  const { client, calls } = fakeClient({
    getClaim: async () => { throw apiError("work_claim_not_found", 404); },
    updateClaim: async () => { throw apiError("work_claim_not_found", 404); },
  });
  const res = await roomActions.submitReceipt.run({ client, params: { claimId: "ghost" }, config });
  assert.equal(res.ok, false);
  assert.equal(res.code, "work_claim_not_found");
  assert.equal(calls.filter(c => c.method === "updateClaim").length, 1);
});

test("room API failures surface as { ok:false, code } — actions never throw", async () => {
  const { client } = fakeClient({
    redeemInvite: async () => { throw apiError("invite_unavailable", 404); },
    listWorkClaims: async () => { throw apiError("unauthenticated", 401); },
    claimTask: async () => { throw apiError("work_claim_conflict", 409); },
    postMessage: async () => { throw new Error("socket hang up"); },
  });
  const join = await roomActions.join.run({ client, params: { code: "RM-X", displayName: "X" }, config });
  assert.deepEqual([join.ok, join.code], [false, "invite_unavailable"]);
  const list = await roomActions.listWork.run({ client, params: {}, config });
  assert.deepEqual([list.ok, list.code], [false, "unauthenticated"]);
  const claim = await roomActions.claimTask.run({ client, params: { claimId: "t" }, config });
  assert.deepEqual([claim.ok, claim.code], [false, "work_claim_conflict"]);
  const post = await roomActions.postUpdate.run({ client, params: { body: "hi" }, config });
  assert.deepEqual([post.ok, post.code], [false, "transport_error"]);
});

test("join returns the secret once with a persistence warning; listWork splits open/mine", async () => {
  const { client } = fakeClient({
    redeemInvite: async () => ({
      identityId: "ai_1", secret: "pri_s", roomId: "commons", memberId: "ai_1",
      displayName: "E", permissions: ["accept_work"], next: [{ description: "Read the board" }],
    }),
    listWorkClaims: async () => ({
      claims: [
        { id: "a", state: "unclaimed" },
        { id: "b", state: "in_progress", owner: "ai_1" },
        { id: "c", state: "done", owner: "ai_1" },
        { id: "d", state: "claimed", owner: "ai_9" },
      ],
      swept: [],
    }),
  });
  const joined = await roomActions.join.run({ client, params: { code: "RM-1", displayName: "E" }, config });
  assert.equal(joined.ok, true);
  assert.equal(joined.secret, "pri_s");
  assert.ok(joined.secretWarning.includes("ROOM_AGENT_SECRET"));
  assert.deepEqual(joined.nextSteps, ["Read the board"]);

  const board = await roomActions.listWork.run({ client, params: { memberId: "ai_1" }, config });
  assert.equal(board.ok, true);
  assert.deepEqual(board.open.map(c => c.id), ["a"]);
  assert.deepEqual(board.mine.map(c => c.id), ["b"], "done items are not mine-open");
});
