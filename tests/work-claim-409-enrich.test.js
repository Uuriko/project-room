// W4 409 enrichment: the work_claim_conflict 409 on the claim route must
// name the holder, the lease expiry, and machine-readable next
// alternatives — so losers don't blind re-poll the full board.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const fakeHelpers = () => {
  const calls = [];
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  const json = (res, status, value) => { calls.push({ status, value }); return { status, value }; };
  return { calls, json, reject, body: async req => req.body };
};

const runRoute = async ({ route, id, body = {}, memberId = "agent-a", registry }) => {
  const helpers = fakeHelpers();
  const store = {
    roomAuthority: () => ({ members: {
      "agent-a": { id: "agent-a", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
      "agent-b": { id: "agent-b", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
    } }),
    room: () => ({ sequence: 1, state: { messages: [] } }),
  };
  try {
    const out = await handleWorkClaims({ req: { method: route === "list" ? "GET" : "POST", body }, res: {},
      url: {}, store, roomId: "room1", auth: { member: { id: memberId, kind: "agent", permissions: [] } },
      workClaimRoute: route, workClaimId: id, helpers, registry });
    return { out, error: null, calls: helpers.calls };
  } catch (error) {
    return { out: null, error, calls: helpers.calls };
  }
};

test("claim 409 names holder, lease expiry, and next alternatives", async () => {
  const registry = createWorkClaimRegistry();
  const created = await runRoute({ route: "create", body: { id: "hot", title: "hot scope" }, registry });
  assert.equal(created.error, null);
  const alt = await runRoute({ route: "create", body: { id: "free", title: "free scope" }, registry });
  assert.equal(alt.error, null);
  const won = await runRoute({ route: "claim", id: "hot", body: {}, registry });
  assert.equal(won.error, null);

  const lost = await runRoute({ route: "claim", id: "hot", body: {}, memberId: "agent-b", registry });
  // The enriched 409 is returned via helpers.json (error.body), not thrown.
  const response = lost.calls.find(call => call.status === 409);
  assert.ok(response, "expected the loser to take a 409");
  const body = response.value;
  assert.equal(body.error?.code, "work_claim_conflict");
  // Holder identity + lease expiry (matches the file_lease_conflict shape).
  assert.equal(body.holder?.owner, "agent-a");
  assert.match(body.holder?.leaseExpiresAt ?? "", /^\d{4}-\d{2}-\d{2}T/, "holder.leaseExpiresAt must be an ISO timestamp");
  // Actionable hint + machine-readable next alternatives.
  assert.equal(typeof body.hint, "string");
  assert.ok(body.hint.length > 0);
  assert.ok(Array.isArray(body.next) && body.next.length > 0, "next must list alternatives");
  assert.ok(body.next.every(step => typeof step?.path === "string" && step.path.startsWith("/")),
    "every next step must be a machine-readable path");
  assert.ok(body.next.some(step => step.path.includes("hot")),
    "next should include the contested claim's read path");
  assert.ok(body.next.some(step => step.path.includes("free")),
    "next should suggest the unclaimed alternative");
});
