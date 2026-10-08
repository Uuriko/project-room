// 409 shadowing: requireEventBudget runs BEFORE the cap check, so a full
// board is misdiagnosed as an event-budget problem. The cap check (more
// actionable) must run first.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { PILOT_LIMITS } from "../server/store.mjs";

const fakeHelpers = () => {
  const calls = [];
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  const json = (res, status, value) => { calls.push({ status, value }); return { status, value }; };
  return { calls, json, reject, body: async req => req.body };
};

const runRoute = async ({ route, body = {}, registry, sequence }) => {
  const helpers = fakeHelpers();
  // sequence near the pilot limit exhausts the event budget for
  // non-privileged writers.
  const store = {
    roomAuthority: () => ({
      sequence,
      ownerId: "owner",
      members: {
        "agent-a": { id: "agent-a", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
      },
    }),
    room: () => ({ sequence: 1, state: { messages: [] } }),
  };
  try {
    const out = await handleWorkClaims({ req: { method: "POST", body }, res: {},
      url: {}, store, roomId: "room1", auth: { member: { id: "agent-a", kind: "agent", permissions: [] } },
      workClaimRoute: route, helpers, registry });
    return { out, error: null, calls: helpers.calls };
  } catch (error) {
    return { out: null, error, calls: helpers.calls };
  }
};

test("full board reports work_board_full, not room_event_budget_low", async () => {
  const registry = createWorkClaimRegistry();
  registry.configure("room1", { maxOpenClaims: 1 });
  // Fill the board.
  const first = await runRoute({ route: "create", body: { id: "w1", title: "one" }, registry, sequence: 1 });
  assert.equal(first.error, null);

  // Budget exhausted AND board full: the actionable diagnosis is the cap.
  const seq = PILOT_LIMITS.eventsPerRoom - 1; // <10% remaining
  const second = await runRoute({ route: "create", body: { id: "w2", title: "two" }, registry, sequence: seq });
  const response = second.calls.find(call => call.status === 409) ?? second.error;
  assert.ok(response, "expected a 409");
  const code = response.value?.error?.code ?? response.code;
  assert.equal(code, "work_board_full",
    `a full board must report work_board_full, not the budget: got ${code}`);
});

test("budget 409 still fires when the board is NOT full", async () => {
  const registry = createWorkClaimRegistry();
  registry.configure("room1", { maxOpenClaims: 10 });
  const seq = PILOT_LIMITS.eventsPerRoom - 1;
  const res = await runRoute({ route: "create", body: { id: "w1", title: "one" }, registry, sequence: seq });
  const response = res.calls.find(call => call.status === 409) ?? res.error;
  assert.ok(response, "expected a 409");
  const code = response.value?.error?.code ?? response.code;
  assert.equal(code, "room_event_budget_low",
    `budget exhaustion with room to spare must still report the budget: got ${code}`);
});
