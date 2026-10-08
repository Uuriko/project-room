// QA-200 H4 (worker 39): the 409 work_claim_conflict body on a failed claim must
// be machine-readable AND actionable. Re-claiming your own held item must not
// be told "release it first" (that destroys your claim); a foreign claimant
// must be told who holds the item instead of an instruction they cannot follow.
import test from "node:test";
import assert from "node:assert/strict";
import { claimWork, ClaimError } from "../server/work-claims.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { agentErrorBody } from "../src/agent-error.mjs";

const T0 = Date.parse("2026-10-08T00:00:00.000Z");

const fakeHelpers = () => {
  const calls = [];
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  return { calls, json: (res, status, value) => ({ status, value }), reject, body: async req => req.body };
};
const fakeAuth = memberId => ({ member: { id: memberId, kind: "agent", permissions: [] } });
const runRoute = ({ route, id, body = {}, memberId = "quill", registry }) => handleWorkClaims({
  req: { method: "POST", body }, res: {}, url: {}, roomId: "room1",
  store: { roomAuthority: () => ({ members: {
    quill: { id: "quill", kind: "agent", active: true, permissions: ["verify"] },
    grok: { id: "grok", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  } }) },
  auth: fakeAuth(memberId), workClaimRoute: route, workClaimId: id,
  helpers: fakeHelpers(), registry,
});

test("H4: self re-claim 409 is machine-readable and never says 'release it first'", async () => {
  const registry = createWorkClaimRegistry();
  await runRoute({ route: "create", body: { id: "h4" }, registry });
  await runRoute({ route: "claim", id: "h4", registry, memberId: "quill" });
  const error = await runRoute({ route: "claim", id: "h4", registry, memberId: "quill" }).catch(e => e);
  assert.equal(error.status, 409);
  assert.equal(error.code, "work_claim_conflict"); // stable machine-readable code
  assert.match(error.message, /you already hold/i); // addressed to the holder
  assert.doesNotMatch(error.message, /release it first/i); // never destroy your own claim
});

test("H4: foreign re-claim 409 names the holder instead of unactionable advice", async () => {
  const registry = createWorkClaimRegistry();
  await runRoute({ route: "create", body: { id: "h4f" }, registry });
  await runRoute({ route: "claim", id: "h4f", registry, memberId: "quill" });
  const error = await runRoute({ route: "claim", id: "h4f", registry, memberId: "grok" }).catch(e => e);
  assert.equal(error.status, 409);
  assert.equal(error.code, "work_claim_conflict");
  assert.match(error.message, /held by quill/i); // names the real recovery target
  assert.doesNotMatch(error.message, /release it first/i); // non-owner cannot release it
});

test("H4: pure claimWork distinguishes self from other on an already-claimed item", () => {
  const held = claimWork({ id: "h4p" }, "quill", { now: T0 });
  const conflictOf = fn => { try { fn(); } catch (e) { return e; } return null; };
  const selfErr = conflictOf(() => claimWork(held, "quill", { now: T0 }));
  assert.ok(selfErr instanceof ClaimError && selfErr.code === "invalid_claim_input"); // pure contract unchanged
  assert.match(selfErr.message, /already claimed by you/i);
  const otherErr = conflictOf(() => claimWork(held, "grok", { now: T0 }));
  assert.ok(otherErr instanceof ClaimError && otherErr.code === "invalid_claim_input"); // pure contract unchanged
  assert.match(otherErr.message, /held by quill/i);
});

test("H4: agentErrorBody for work_claim_conflict carries an actionable hint + next", () => {
  const self = agentErrorBody({ httpStatus: 409, code: "work_claim_conflict",
    message: 'You already hold work "h4" — no new claim was saved; read the item to confirm',
    roomId: "room1", workItemId: "h4" });
  assert.equal(self.error.code, "work_claim_conflict");
  assert.equal(self.status, "action_required");
  assert.match(self.hint, /read the current item|do not release/i);
  assert.ok(self.next.some(step => step.path === "/api/rooms/room1/work-claims/h4"));

  const other = agentErrorBody({ httpStatus: 409, code: "work_claim_conflict",
    message: 'Work "h4" is held by quill — ask them to reassign or release it',
    roomId: "room1", workItemId: "h4" });
  assert.match(other.hint, /held by quill/i);
  assert.ok(other.next.some(step => step.path === "/api/rooms/room1/work-claims/h4"));
});
