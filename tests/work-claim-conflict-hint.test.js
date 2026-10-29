// QA-200 H4 (worker 39): the 409 work_claim_conflict body on a failed claim must
// be machine-readable AND actionable. Re-claiming your own held item must not
// be told "release it first" (that destroys your claim); a foreign claimant
// must be told who holds the item instead of an instruction they cannot follow.
import test from "node:test";
import assert from "node:assert/strict";
import { claimWork, ClaimError } from "../server/work-claims.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { agentErrorBody, ownerHeldClaimCopy } from "../src/agent-error.mjs";

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

test("H4: a done item is reported as already done, not as held", () => {
  const conflictOf = fn => { try { fn(); } catch (e) { return e; } return null; };
  const done = { ...claimWork({ id: "h4d" }, "quill", { now: T0 }), state: "done" };
  for (const who of ["quill", "grok"]) {
    const err = conflictOf(() => claimWork(done, who, { now: T0 }));
    assert.ok(err instanceof ClaimError && err.code === "invalid_claim_input");
    assert.match(err.message, /already done/i);
    assert.doesNotMatch(err.message, /held by|reassign or release/i);
  }
});


// ---------------------------------------------------------------------------
// DC1-A1 (REGISTER-FIX-A F2): in the silent-holder configuration (caller is
// the room owner, holder is a current member) both refusal sites serve the
// owner-release copy: no "reassign" prescription, the owner's own release
// first, the single-item read named, holder-ask and lease-wait after it.
// ---------------------------------------------------------------------------
const runOwnerRoute = ({ route, id, body = {}, memberId, registry }) => handleWorkClaims({
  req: { method: "POST", body }, res: {}, url: {}, roomId: "room1",
  store: { roomAuthority: () => ({ ownerId: "owner1", members: {
    owner1: { id: "owner1", kind: "agent", active: true, permissions: [] },
    quill: { id: "quill", kind: "agent", active: true, permissions: ["verify"] },
    grok: { id: "grok", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  } }) },
  auth: fakeAuth(memberId), workClaimRoute: route, workClaimId: id,
  helpers: fakeHelpers(), registry,
});

test("DC1-A1: room owner claiming a member-held item gets the owner-release copy (409)", async () => {
  const registry = createWorkClaimRegistry();
  await runOwnerRoute({ route: "create", body: { id: "a1" }, registry, memberId: "quill" });
  await runOwnerRoute({ route: "claim", id: "a1", registry, memberId: "quill" });
  const held = registry.get("room1", "a1");
  const error = await runOwnerRoute({ route: "claim", id: "a1", registry, memberId: "owner1" }).catch(e => e);
  assert.equal(error.status, 409);
  assert.equal(error.code, "work_claim_conflict");
  assert.match(error.message, /held by quill until /);
  assert.ok(error.message.includes(held.leaseExpiresAt));
  assert.doesNotMatch(error.message, /reassign/i);
  assert.doesNotMatch(error.message, /ask them to reassign/i);
  assert.match(error.message, /GET \/api\/rooms\/room1\/work-claims\/a1 \(use this read, not the board list/);
  assert.match(error.message, /POST \/api\/rooms\/room1\/work-claims\/a1\/release with expectedClaimedAt and expectedHistoryLength/);
  assert.ok(error.message.indexOf("You can release it yourself now") < error.message.indexOf("Or message the holder"));
});

test("DC1-A1: room owner updating a member-held item gets the owner-release copy (403 work_not_owner)", async () => {
  const registry = createWorkClaimRegistry();
  await runOwnerRoute({ route: "create", body: { id: "a1u" }, registry, memberId: "quill" });
  await runOwnerRoute({ route: "claim", id: "a1u", registry, memberId: "quill" });
  const error = await runOwnerRoute({ route: "update", id: "a1u", body: { state: "blocked" }, registry, memberId: "owner1" }).catch(e => e);
  assert.equal(error.status, 403);
  assert.equal(error.code, "work_not_owner");
  assert.match(error.message, /held by quill until /);
  assert.doesNotMatch(error.message, /reassign/i);
  assert.match(error.message, /POST \/api\/rooms\/room1\/work-claims\/a1u\/release/);
});

test("DC1-A1: a non-owner claimant keeps the previous copy (configuration scope)", async () => {
  const registry = createWorkClaimRegistry();
  await runOwnerRoute({ route: "create", body: { id: "a1n" }, registry, memberId: "quill" });
  await runOwnerRoute({ route: "claim", id: "a1n", registry, memberId: "quill" });
  const error = await runOwnerRoute({ route: "claim", id: "a1n", registry, memberId: "grok" }).catch(e => e);
  assert.equal(error.status, 409);
  assert.match(error.message, /held by quill \u2014 ask them to reassign or release it/);
});

test("DC1-A1: agentErrorBody mirrors the owner-release copy into hint + next for both codes", () => {
  const message = ownerHeldClaimCopy({ holder: "quill", leaseExpiresAt: "2026-10-09T00:00:00.000Z", roomId: "room1", claimId: "a1" });
  for (const [code, httpStatus] of [["work_claim_conflict", 409], ["work_not_owner", 403]]) {
    const body = agentErrorBody({ httpStatus, code, message, roomId: "room1", workItemId: "a1" });
    assert.equal(body.error.code, code);
    assert.doesNotMatch(body.hint, /ask (them|quill) to reassign/i);
    assert.match(body.hint, /held by quill until 2026-10-09T00:00:00\.000Z/);
    assert.match(body.hint, /POST \/api\/rooms\/room1\/work-claims\/a1\/release/);
    assert.ok(body.next.some(step => step.path === "/api/rooms/room1/work-claims/a1"));
    const commands = body.next.filter(step => step.command).map(step => step.command).join("\n");
    assert.match(commands, /Release it yourself: GET \/api\/rooms\/room1\/work-claims\/a1/);
    assert.ok(commands.indexOf("Release it yourself") < commands.indexOf("Or message quill"));
  }
});


test("DC1-A1: room owner claiming an in_progress item gets the owner-release copy (409, A2 sub-case)", async () => {
  const registry = createWorkClaimRegistry();
  await runOwnerRoute({ route: "create", body: { id: "a2" }, registry, memberId: "quill" });
  await runOwnerRoute({ route: "claim", id: "a2", registry, memberId: "quill" });
  await runOwnerRoute({ route: "update", id: "a2", body: { state: "in_progress" }, registry, memberId: "quill" });
  const error = await runOwnerRoute({ route: "claim", id: "a2", registry, memberId: "owner1" }).catch(e => e);
  assert.equal(error.status, 409);
  assert.equal(error.code, "work_claim_conflict");
  assert.doesNotMatch(error.message, /reassign/i);
  assert.match(error.message, /held by quill until /);
  assert.match(error.message, /POST \/api\/rooms\/room1\/work-claims\/a2\/release/);
});

test("DC1-A1: agentErrorBody fallback next for an already-<state> conflict never prescribes reassign (R4)", () => {
  const body = agentErrorBody({ httpStatus: 409, code: "work_claim_conflict",
    message: 'Work "a2" is already in_progress', roomId: "room1", workItemId: "a2" });
  assert.doesNotMatch(JSON.stringify([body.hint, body.next]), /reassign/i);
});

test("DC1-A1: pure claimWork held-by message names the holder and never prescribes reassign (R7)", () => {
  const held = claimWork({ id: "a1p" }, "quill", { now: T0 });
  const conflictOf = fn => { try { fn(); } catch (e) { return e; } return null; };
  const otherErr = conflictOf(() => claimWork(held, "grok", { now: T0 }));
  assert.ok(otherErr instanceof ClaimError && otherErr.code === "invalid_claim_input");
  assert.match(otherErr.message, /held by quill/i);
  assert.doesNotMatch(otherErr.message, /reassign/i);
});
