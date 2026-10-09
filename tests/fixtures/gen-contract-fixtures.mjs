// gen-contract-fixtures.mjs — regenerate the shared contract fixtures under
// tests/fixtures/. These fixtures freeze the EXACT current shapes of the
// widely-consumed pure functions at the heart of the claim system
// (src/agent-error.mjs error-body builders, server/work-claims.mjs state
// machine). The snapshot test (tests/contract-fixtures.test.js) deepEquals
// live output against them, so a field rename or shape change fails LOUDLY.
//
// Only re-run this after a DELIBERATE, reviewed contract change — silently
// regenerating defeats the gate. Usage: node tests/fixtures/gen-contract-fixtures.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentErrorAx, agentErrorBody } from "../../src/agent-error.mjs";
import * as claims from "../../server/work-claims.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const wire = value => JSON.parse(JSON.stringify(value));
const thrownShape = err => ({ name: err.name, code: err.code, message: err.message });

const AX = (name, args, redact = null) => {
  const actual = agentErrorBody(args);
  if (redact) for (const key of redact) actual[key] = "<redacted>";
  return { name, fn: "agentErrorBody", args: [args], expected: wire(actual), ...(redact ? { redact } : {}) };
};
const AXV = (name, args) => ({ name, fn: "agentErrorAx", args: [args], expected: wire(agentErrorAx(args)) });

const claimErrorContracts = {
  meta: {
    contract: "src/agent-error.mjs — agentErrorAx (refusal classifier) + agentErrorBody (error-body builder)",
    generatedBy: "tests/fixtures/gen-contract-fixtures.mjs",
    note: "deepEqual snapshots: a rename or reshape in these branches must fail the test loudly.",
  },
  cases: [
    AXV("work_claim_conflict/self", { httpStatus: 409, code: "work_claim_conflict",
      message: 'work "fix-41" is already claimed by you — no new claim was saved; read the item to confirm',
      roomId: "room-1", workItemId: "fix-41" }),
    AXV("work_claim_conflict/held", { httpStatus: 409, code: "work_claim_conflict",
      message: 'work "fix-41" is held by alice — ask them to reassign or release it',
      roomId: "room-1", workItemId: "fix-41" }),
    AXV("work_claim_conflict/unknown", { httpStatus: 409, code: "work_claim_conflict",
      message: 'work "fix-41" is already done', roomId: "room-1", workItemId: "fix-41" }),
    AXV("work_not_owner/named", { httpStatus: 403, code: "work_not_owner",
      message: 'work "fix-41" is owned by alice — only the owner can update it',
      roomId: "room-1", workItemId: "fix-41" }),
    AXV("work_not_owner/unclaimed", { httpStatus: 403, code: "work_not_owner",
      message: 'work "fix-41" is owned by nobody — only the owner can update it',
      roomId: "room-1", workItemId: "fix-41" }),
    AXV("claim_lease_lapsed", { httpStatus: 409, code: "claim_lease_lapsed",
      message: "The current claim lease has lapsed", roomId: "room-1", workItemId: "fix-41" }),
    AXV("already_claimed", { httpStatus: 409, code: "already_claimed",
      message: "This bounty is already claimed" }),
    AXV("identity_already_linked", { httpStatus: 409, code: "identity_already_linked",
      message: "This identity is already linked to room-1" }),
    AXV("work_claim_not_found", { httpStatus: 404, code: "work_claim_not_found",
      message: "No work claim with id nope in this room", roomId: "room-1" }),
    AXV("session_claimed", { httpStatus: 409, code: "session_claimed",
      message: "Claim held by alice", roomId: "room-1", workItemId: "fix-41" }),
    AXV("stale_revision", { httpStatus: 409, code: "stale_read",
      message: "revision changed since your read", roomId: "room-1", workItemId: "fix-41" }),
    AXV("unauthenticated", { httpStatus: 401, code: "unauthenticated",
      message: "No credential" }),
    AXV("unmapped_code", { httpStatus: 400, code: "weird_new_code",
      message: "something happened" }),
    AX("body/409_claim_conflict", { httpStatus: 409, code: "work_claim_conflict",
      message: 'work "fix-41" is held by alice — ask them to reassign or release it',
      roomId: "room-1", workItemId: "fix-41" }),
    AX("body/422_invalid_input", { httpStatus: 422, code: "invalid_claim_input",
      message: "title must be 1..512 characters", roomId: "room-1", workItemId: "fix-41" }),
    AX("body/500_internal", { httpStatus: 500, code: "internal_error",
      message: "boom", roomId: "room-1", workItemId: "fix-41" }, ["errorId", "fingerprint"]),
  ],
};

// Fixed "now" anchors keep every stamp deterministic.
const T0 = 1780000000000, T1 = 1780000100000, T2 = 1780000200000, T3 = 1780000300000;
const cases = [];
const capture = (name, fn, args, run) => {
  try {
    const out = run();
    cases.push({ name, fn, args, expected: wire(out) });
  } catch (err) {
    cases.push({ name, fn, args, throws: thrownShape(err) });
  }
};

const w0 = claims.createWork(
  { id: "fix-41", title: "contract fixtures", tags: ["qa"] }, { now: T0, agentId: "jill" });
capture("createWork/success", "createWork",
  [{ id: "fix-41", title: "contract fixtures", tags: ["qa"] }, { now: T0, agentId: "jill" }],
  () => claims.createWork({ id: "fix-41", title: "contract fixtures", tags: ["qa"] }, { now: T0, agentId: "jill" }));

const w1 = claims.claimWork(w0, "alice", { leaseHours: 24, now: T1 });
capture("claimWork/success", "claimWork",
  [{ $ref: "createWork/success" }, "alice", { leaseHours: 24, now: T1 }],
  () => claims.claimWork(w0, "alice", { leaseHours: 24, now: T1 }));

capture("claimWork/refusal/double-claim", "claimWork",
  [{ $ref: "claimWork/success" }, "bob", { now: T2 }],
  () => claims.claimWork(w1, "bob", { now: T2 }));

capture("updateWork/refusal/not-owner", "updateWork",
  [{ $ref: "claimWork/success" }, "bob", { state: "in_progress", now: T2 }],
  () => claims.updateWork(w1, "bob", { state: "in_progress", now: T2 }));

capture("updateWork/success/start", "updateWork",
  [{ $ref: "claimWork/success" }, "alice", { state: "in_progress", note: "starting", now: T2 }],
  () => claims.updateWork(w1, "alice", { state: "in_progress", note: "starting", now: T2 }));

capture("releaseWork/refusal/stale", "releaseWork",
  [{ $ref: "claimWork/success" }, "alice",
    { expectedClaimedAt: "1970-01-01T00:00:00.000Z", expectedHistoryLength: 2, now: T3 }],
  () => claims.releaseWork(w1, "alice",
    { expectedClaimedAt: "1970-01-01T00:00:00.000Z", expectedHistoryLength: 2, now: T3 }));

const w2 = claims.releaseWork(w1, "alice",
  { expectedClaimedAt: w1.claimedAt, expectedHistoryLength: 2, now: T3 });
capture("releaseWork/success", "releaseWork",
  [{ $ref: "claimWork/success" }, "alice",
    { expectedClaimedAt: w1.claimedAt, expectedHistoryLength: 2, note: "handing off", now: T3 }],
  () => claims.releaseWork(w1, "alice",
    { expectedClaimedAt: w1.claimedAt, expectedHistoryLength: 2, note: "handing off", now: T3 }));

const w3 = claims.closeWork(w0, "jill", { verb: "cancel", reason: "superseded by FIX-42", now: T2 });
capture("closeWork/success/cancel", "closeWork",
  [{ $ref: "createWork/success" }, "jill",
    { verb: "cancel", reason: "superseded by FIX-42", now: T2 }],
  () => claims.closeWork(w0, "jill", { verb: "cancel", reason: "superseded by FIX-42", now: T2 }));

capture("closeWork/refusal/terminal", "closeWork",
  [{ $ref: "closeWork/success/cancel" }, "jill", { verb: "close", now: T3 }],
  () => claims.closeWork(w3, "jill", { verb: "close", now: T3 }));

const workClaimContracts = {
  meta: {
    contract: "server/work-claims.mjs — pure claim state machine (create/claim/update/release/close)",
    generatedBy: "tests/fixtures/gen-contract-fixtures.mjs",
    note: "deepEqual snapshots: args.$ref points at another case's expected output; refuses are captured as {name, code, message}.",
  },
  cases,
};

writeFileSync(join(HERE, "claim-error-contracts.json"), JSON.stringify(claimErrorContracts, null, 2) + "\n");
writeFileSync(join(HERE, "work-claim-contracts.json"), JSON.stringify(workClaimContracts, null, 2) + "\n");
console.log("wrote", claimErrorContracts.cases.length, "+", cases.length, "cases");
