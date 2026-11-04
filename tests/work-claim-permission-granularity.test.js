// UT2 05-03 F1: a member holding ONLY the review profile ([verify]) claimed
// work and self-closed it to done — the Board gate checked for ANY work
// profile, never the individual accept_work / complete_work permissions, so
// a verify-only member produced a self-attested receipt for work they were
// invited only to verify. These tests pin the granular contract:
//   claim requires accept_work; completing (update to done/delivered) or
//   closing/cancelling as the holder requires complete_work.
// Refusals keep the Board's existing permission-error shape: 403 with code
// work_claims_not_permitted and a message naming the missing permission.
// The reviewer's verify-to-done on a delivered item is a review action, not
// the holder completing their own work, and keeps its verify gate.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const MEMBERS = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work", "verify", "steer"] },
  reviewer: { id: "reviewer", kind: "agent", active: true, permissions: ["verify"] },
  accepter: { id: "accepter", kind: "agent", active: true, permissions: ["accept_work"] },
  completer: { id: "completer", kind: "agent", active: true, permissions: ["complete_work"] },
  contributor: { id: "contributor", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    error.body = { error: { code, message } };
    throw error;
  },
  body: async req => req.body,
};

const call = (registry, memberId, route, id, body) => handleWorkClaims({
  req: { method: "POST", body },
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

const refusedFor = (result, permission) => {
  assert.equal(result.status, 403, JSON.stringify(result.value));
  assert.equal(result.value.error.code, "work_claims_not_permitted");
  assert.match(result.value.error.message, new RegExp(permission), "refusal names the missing permission");
};

test("F1 repro: a verify-only member cannot claim work", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "probe-s2" })).status, 201);
  refusedFor(await call(registry, "reviewer", "claim", "probe-s2", {}), "accept_work");
  assert.equal(registry.get("room1", "probe-s2").state, "unclaimed");
  assert.equal(registry.get("room1", "probe-s2").owner, null);
});

test("F1 repro: a verify-only holder cannot self-close to done or close/cancel", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "probe-s2-close" })).status, 201);
  // Hand the item to the reviewer the way the 05-03 battery did (owner
  // reassign); the holder path is what self-attestation abuses.
  // Lane-08 adaptation (setup only, assertions untouched): the §4.1 cure
  // refuses that reassign to a verify-only member, so seed the identical
  // holder state directly — the fresh-assignment shape reassignWork
  // produces from unclaimed (claimed, fresh 24h lease, claimRound+1,
  // fresh-round clears, and the `reassigned:reviewer` history stamp by
  // "owner"), as in the falsifier's adapted setupHolder.
  const created = registry.get("room1", "probe-s2-close");
  const seedAtMs = Date.now();
  const seedAt = new Date(seedAtMs).toISOString();
  registry.set("room1", {
    ...created,
    readingAcks: created.readingAcks ?? {},
    state: "claimed",
    owner: "reviewer",
    claimedAt: seedAt,
    claimRound: (created.claimRound ?? 0) + 1,
    leaseStartAt: seedAt,
    leaseExpiresAt: new Date(seedAtMs + 24 * 3600 * 1000).toISOString(),
    delivery: null,
    verification: null,
    ci: null,
    deliveryGeneration: 0,
    attestations: Object.freeze([]),
    reviews: Object.freeze([]),
    updatedAt: seedAt,
    history: Object.freeze([...created.history, Object.freeze({ at: seedAt, agentId: "owner", action: "reassigned:reviewer", note: null })]),
  });
  // The 05-03 battery's middle step: starting the held work is a plain
  // holder update under the profile gate and still lands — the harm is
  // the self-attested completion, which is what must now refuse.
  const started = await call(registry, "reviewer", "update", "probe-s2-close", { state: "in_progress" });
  assert.equal(started.status, 200, JSON.stringify(started.value));
  refusedFor(await call(registry, "reviewer", "update", "probe-s2-close", { state: "done" }), "complete_work");
  refusedFor(await call(registry, "reviewer", "close", "probe-s2-close", {}), "complete_work");
  refusedFor(await call(registry, "reviewer", "cancel", "probe-s2-close", {}), "complete_work");
  assert.notEqual(registry.get("room1", "probe-s2-close").state, "done");
});

test("accept_work alone claims and starts, but cannot complete or close", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "accept-only" })).status, 201);
  const claimed = await call(registry, "accepter", "claim", "accept-only", {});
  assert.equal(claimed.status, 200, JSON.stringify(claimed.value));
  assert.equal((await call(registry, "accepter", "update", "accept-only", { state: "in_progress" })).status, 200);
  refusedFor(await call(registry, "accepter", "update", "accept-only", { state: "done" }), "complete_work");
  refusedFor(await call(registry, "accepter", "update", "accept-only", { state: "delivered" }), "complete_work");
  refusedFor(await call(registry, "accepter", "close", "accept-only", {}), "complete_work");
  assert.equal(registry.get("room1", "accept-only").state, "in_progress");
});

test("complete_work alone cannot claim, but a completer holder can finish", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "complete-only" })).status, 201);
  refusedFor(await call(registry, "completer", "claim", "complete-only", {}), "accept_work");
  const created = registry.get("room1", "complete-only");
  // Lane-08 adaptation (setup only, assertions untouched): the §4.1 cure
  // refuses the owner reassign to a member lacking accept_work, so seed
  // the identical holder state directly, in the same fresh-assignment
  // shape as the reviewer seed above (`reassigned:completer` stamp).
  const seedAtMs = Date.now();
  const seedAt = new Date(seedAtMs).toISOString();
  registry.set("room1", {
    ...created,
    readingAcks: created.readingAcks ?? {},
    state: "claimed",
    owner: "completer",
    claimedAt: seedAt,
    claimRound: (created.claimRound ?? 0) + 1,
    leaseStartAt: seedAt,
    leaseExpiresAt: new Date(seedAtMs + 24 * 3600 * 1000).toISOString(),
    delivery: null,
    verification: null,
    ci: null,
    deliveryGeneration: 0,
    attestations: Object.freeze([]),
    reviews: Object.freeze([]),
    updatedAt: seedAt,
    history: Object.freeze([...created.history, Object.freeze({ at: seedAt, agentId: "owner", action: "reassigned:completer", note: null })]),
  });
  assert.equal((await call(registry, "completer", "update", "complete-only", { state: "in_progress" })).status, 200);
  const done = await call(registry, "completer", "update", "complete-only", { state: "done" });
  assert.equal(done.status, 200, JSON.stringify(done.value));
  assert.equal(done.value.state, "done");
});

test("create with an assignee is a claim: the assignee needs accept_work", async () => {
  const registry = createWorkClaimRegistry();
  refusedFor(await call(registry, "owner", "create", null, { id: "assign-review", assignee: "reviewer" }), "accept_work");
  assert.equal(registry.has("room1", "assign-review"), false);
  const assigned = await call(registry, "owner", "create", null, { id: "assign-contrib", assignee: "contributor" });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.value));
  assert.equal(assigned.value.owner, "contributor");
});

test("contributor lifecycle is unchanged: claim, start, done", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "full" })).status, 201);
  assert.equal((await call(registry, "contributor", "claim", "full", {})).status, 200);
  assert.equal((await call(registry, "contributor", "update", "full", { state: "in_progress" })).status, 200);
  const done = await call(registry, "contributor", "update", "full", { state: "done" });
  assert.equal(done.status, 200, JSON.stringify(done.value));
  assert.equal(done.value.state, "done");
});

test("a holder with both permissions can close their own claim", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "closable" })).status, 201);
  assert.equal((await call(registry, "contributor", "claim", "closable", {})).status, 200);
  const closed = await call(registry, "contributor", "close", "closable", {});
  assert.equal(closed.status, 200, JSON.stringify(closed.value));
});

test("the reviewer's verify-to-done on delivered work keeps the verify gate, not complete_work", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "reviewed", reviewPolicy: "distinct_member" })).status, 201);
  assert.equal((await call(registry, "contributor", "claim", "reviewed", {})).status, 200);
  assert.equal((await call(registry, "contributor", "update", "reviewed", { state: "in_progress" })).status, 200);
  const delivered = await call(registry, "contributor", "update", "reviewed", {
    state: "delivered",
    delivery: { artifact: { kind: "text", ref: "room://artifacts/x", sha256: "c".repeat(64) }, checks: [{ name: "unit", result: "pass" }], criteria: [] },
  });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.value));
  const review = await call(registry, "reviewer", "review", "reviewed", { verdict: "approve", summary: "Verified." });
  assert.equal(review.status, 200, JSON.stringify(review.value));
  const done = await call(registry, "reviewer", "update", "reviewed", { state: "done" });
  assert.equal(done.status, 200, JSON.stringify(done.value));
  assert.equal(done.value.state, "done");
});

// ---------- Cure additions (spec §5.2, drafted in lane-04) ----------
// Harness extensions and 9 new tests appended without altering the 8 tests above.

// Falsifier-pattern extension (see header): same call shape as the
// granularity suite, but the authority map is a parameter and the
// session auth can be overridden per call (authFor). Errors are caught
// and returned in the same { status, value } shape, as in the
// falsifier's makeCall.
function makeCall(members) {
  return async (registry, memberId, route, id, body, authFor) => {
    const listed = members[memberId];
    const authMember = authFor ?? { id: memberId, kind: listed?.kind ?? "agent", permissions: listed?.permissions };
    try {
      return await handleWorkClaims({
        req: { method: "POST", body }, res: {},
        url: new URL("https://room.example/api/rooms/room1/work-claims"),
        store: { roomAuthority: () => ({ ownerId: "owner", members }), room: () => ({ state: { messages: [] } }) },
        roomId: "room1", auth: { member: authMember },
        workClaimRoute: route, workClaimId: id, helpers, registry,
      });
    } catch (error) {
      return { status: error.status ?? 0, value: error.body ?? { error: { code: error.code, message: error.message } }, thrown: true };
    }
  };
}

// Extra members the new tests need. `manager` is copied from the
// falsifier suite's baseMembers(); the two string-* members carry a
// bare-string permissions value in BOTH the authority record and the
// session auth (the granularity `call` pattern derives both from the
// same entry), matching the falsifier's A2b route probe.
const EXTENDED_MEMBERS = {
  ...MEMBERS,
  manager: { id: "manager", kind: "agent", active: true, permissions: ["manage_claims"] },
  stringverifier: { id: "stringverifier", kind: "agent", active: true, permissions: "xxverifyxx" },
  stringmanager: { id: "stringmanager", kind: "agent", active: true, permissions: "xxmanage_claimsxx" },
};
const callX = makeCall(EXTENDED_MEMBERS);

// The delivery bundle literal from granularity test 8 ("the reviewer's
// verify-to-done…"), factored out as the falsifier suite factors it.
const DELIVERY = { artifact: { kind: "text", ref: "room://artifacts/x", sha256: "c".repeat(64) }, checks: [{ name: "unit", result: "pass" }], criteria: [] };

// Reassign preconditions, read back exactly as the granularity suite
// reads them inline before every reassign call.
const reassignBody = (registry, id, newOwner) => {
  const cur = registry.get("room1", id);
  return { newOwner, expectedClaimedAt: cur.claimedAt ?? null, expectedHistoryLength: cur.history.length };
};

// Drive a claim to `delivered` under the holder, via any call variant
// with the granularity signature (registry, memberId, route, id, body).
async function deliverByContributor(callFn, registry, id, extra = {}) {
  assert.equal((await callFn(registry, "owner", "create", null, { id, ...extra })).status, 201);
  assert.equal((await callFn(registry, "contributor", "claim", id, {})).status, 200);
  assert.equal((await callFn(registry, "contributor", "update", id, { state: "in_progress" })).status, 200);
  const delivered = await callFn(registry, "contributor", "update", id, { state: "delivered", delivery: DELIVERY });
  assert.equal(delivered.status, 200, `deliver: ${JSON.stringify(delivered.value)}`);
}

// ---------- §5.2 F1 new: reassign positive legs ----------

test("reassign to a member holding accept_work still succeeds (holder caller)", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "reassign-holder-ok" })).status, 201);
  assert.equal((await call(registry, "contributor", "claim", "reassign-holder-ok", {})).status, 200);
  // The holder hands the claim to the accept_work-only member. At head
  // this passes via the ungated path; after the §4.1 cure it must pass
  // via the gated path (target holds accept_work in an array).
  const r = await call(registry, "contributor", "reassign", "reassign-holder-ok", reassignBody(registry, "reassign-holder-ok", "accepter"));
  assert.equal(r.status, 200, JSON.stringify(r.value));
  assert.equal(registry.get("room1", "reassign-holder-ok").owner, "accepter");
  assert.equal(registry.get("room1", "reassign-holder-ok").state, "claimed");
});

test("reassign to a member holding accept_work still succeeds (manager caller)", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await callX(registry, "owner", "create", null, { id: "reassign-manager-ok" })).status, 201);
  // A manage_claims caller reassigns an UNCLAIMED item (the falsifier
  // F1b caller shape) to the accept_work-only member.
  const r = await callX(registry, "manager", "reassign", "reassign-manager-ok", reassignBody(registry, "reassign-manager-ok", "accepter"));
  assert.equal(r.status, 200, JSON.stringify(r.value));
  assert.equal(registry.get("room1", "reassign-manager-ok").owner, "accepter");
  assert.equal(registry.get("room1", "reassign-manager-ok").state, "claimed");
});

test("reassign to the room owner still succeeds", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "reassign-owner-ok" })).status, 201);
  assert.equal((await call(registry, "contributor", "claim", "reassign-owner-ok", {})).status, 200);
  // The room owner holds no array entry to check: the cure's target
  // check must pass them via the ownerId bypass inside
  // mayClaimWorkClaims, exactly as create-with-assignee does at head.
  const r = await call(registry, "contributor", "reassign", "reassign-owner-ok", reassignBody(registry, "reassign-owner-ok", "owner"));
  assert.equal(r.status, 200, JSON.stringify(r.value));
  assert.equal(registry.get("room1", "reassign-owner-ok").owner, "owner");
  assert.equal(registry.get("room1", "reassign-owner-ok").state, "claimed");
});

// ---------- §5.2 F2 controls: the holder's own self-attested finish ----------
// The delivered path is used (claim → in_progress → delivered → done),
// NOT the single-step in_progress → done collapse, even though the
// harness supports the collapse under self_attested (granularity tests
// "contributor lifecycle is unchanged" and "complete_work alone cannot
// claim, but a completer holder can finish" both finish single-step).
// The delivered path is the F2 surface: it is the branch the §4.2 cure
// touches, so it is the leg that must be pinned as still working.

test("the holder can finish their own work to done under self_attested (policy unset — room default)", async () => {
  const registry = createWorkClaimRegistry();
  await deliverByContributor(call, registry, "self-attested-default");
  const done = await call(registry, "contributor", "update", "self-attested-default", { state: "done" });
  assert.equal(done.status, 200, JSON.stringify(done.value));
  assert.equal(done.value.state, "done");
  assert.equal(registry.get("room1", "self-attested-default").state, "done");
});

test("the holder can finish their own work to done under self_attested (explicit reviewPolicy)", async () => {
  const registry = createWorkClaimRegistry();
  await deliverByContributor(call, registry, "self-attested-explicit", { reviewPolicy: "self_attested" });
  const done = await call(registry, "contributor", "update", "self-attested-explicit", { state: "done" });
  assert.equal(done.status, 200, JSON.stringify(done.value));
  assert.equal(done.value.state, "done");
  assert.equal(registry.get("room1", "self-attested-explicit").state, "done");
});

// ---------- §5.2 A1b variants: the preserved Layer 1 legacy leg ----------

test("a listed record with no permissions key keeps the session fallback", async () => {
  // The authority/listed record for `legacy` has NO permissions key at
  // all (pinned by the hasOwn assertion — this is the §4.3 Layer 1
  // distinction: key absent → session fallback preserved; key present
  // but non-array → no permissions). The session auth carries the
  // permissions. Head behaviour: the claim succeeds on the session's
  // asserted accept_work, and the cure must keep it succeeding.
  const members = {
    ...MEMBERS,
    legacy: { id: "legacy", kind: "agent", active: true },
  };
  assert.equal(Object.hasOwn(members.legacy, "permissions"), false, "fixture pin: legacy record must carry no permissions key");
  const callLegacy = makeCall(members);
  const registry = createWorkClaimRegistry();
  assert.equal((await callLegacy(registry, "owner", "create", null, { id: "legacy-fallback" })).status, 201);
  const claimed = await callLegacy(registry, "legacy", "claim", "legacy-fallback", {},
    { id: "legacy", kind: "agent", permissions: ["accept_work"] });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.value));
  assert.equal(registry.get("room1", "legacy-fallback").owner, "legacy");
  assert.equal(registry.get("room1", "legacy-fallback").state, "claimed");
});

// ---------- §5.2 A2b sweep: bare-string permissions grant nothing ----------

test("bare-string permissions never grant review, manage, or verifier standing (a: review under distinct_member)", async () => {
  // String leg: a member whose permissions is the bare string
  // "xxverifyxx" attempts the reviewer's full verify-to-done flow
  // under a reviewed policy. The review call's status is deliberately
  // NOT asserted: at head it succeeds (200, substring grant) and after
  // the cure it is refused at the review gate — either way the decisive
  // assertion is the verify-to-done outcome below.
  const stringRegistry = createWorkClaimRegistry();
  await deliverByContributor(callX, stringRegistry, "string-verify", { reviewPolicy: "distinct_member" });
  await callX(stringRegistry, "stringverifier", "review", "string-verify", { verdict: "approve", summary: "Verified." });
  const stringDone = await callX(stringRegistry, "stringverifier", "update", "string-verify", { state: "done" });
  assert.equal(stringDone.status, 403, JSON.stringify(stringDone.value));
  assert.equal(stringDone.value.error.code, "work_claims_not_permitted");
  assert.equal(stringRegistry.get("room1", "string-verify").state, "delivered");

  // Array control: the genuine ["verify"] reviewer runs the identical
  // flow (granularity test 8's flow) and succeeds.
  const arrayRegistry = createWorkClaimRegistry();
  await deliverByContributor(call, arrayRegistry, "array-verify", { reviewPolicy: "distinct_member" });
  const review = await call(arrayRegistry, "reviewer", "review", "array-verify", { verdict: "approve", summary: "Verified." });
  assert.equal(review.status, 200, JSON.stringify(review.value));
  const arrayDone = await call(arrayRegistry, "reviewer", "update", "array-verify", { state: "done" });
  assert.equal(arrayDone.status, 200, JSON.stringify(arrayDone.value));
  assert.equal(arrayDone.value.state, "done");
});

test("bare-string permissions never grant review, manage, or verifier standing (b: manage_claims admin-close)", async () => {
  // String leg: "xxmanage_claimsxx" must not admin-close another
  // member's claim. After the cure the closer gate refuses with the
  // complete_work refusal shape (refusedFor), as in falsifier F6's
  // HTTP-side equivalents.
  const stringRegistry = createWorkClaimRegistry();
  assert.equal((await callX(stringRegistry, "owner", "create", null, { id: "string-manage-close" })).status, 201);
  assert.equal((await callX(stringRegistry, "contributor", "claim", "string-manage-close", {})).status, 200);
  refusedFor(await callX(stringRegistry, "stringmanager", "close", "string-manage-close", {}), "complete_work");
  assert.equal(stringRegistry.get("room1", "string-manage-close").state, "claimed");
  assert.equal(stringRegistry.get("room1", "string-manage-close").owner, "contributor");

  // Array control: the genuine ["manage_claims"] manager admin-closes
  // another member's claim over the same HTTP route (the route-level
  // pairing for falsifier F6iii's MCP positive control).
  const arrayRegistry = createWorkClaimRegistry();
  assert.equal((await callX(arrayRegistry, "owner", "create", null, { id: "array-manage-close" })).status, 201);
  assert.equal((await callX(arrayRegistry, "contributor", "claim", "array-manage-close", {})).status, 200);
  const closed = await callX(arrayRegistry, "manager", "close", "array-manage-close", {});
  assert.equal(closed.status, 200, JSON.stringify(closed.value));
  assert.equal(arrayRegistry.get("room1", "array-manage-close").state, "closed");
});

test("bare-string permissions never grant review, manage, or verifier standing (c: verifier standing under independent_principal)", async () => {
  // Effect form only (see lane-04.md): verifiersOf is not exported and
  // no route lists verifiers, so verifier standing is asserted through
  // its one decisive route-level effect — under independent_principal,
  // canCloseWork requires the caller to be in the verifier set. At
  // head the bare string "xxverifyxx" puts stringverifier in that set
  // (substring match in verifiersOf) and the done below succeeds;
  // after the §4.4 sweep it must refuse and leave the work delivered.
  // As in (a), the review call's status is not asserted (it is itself
  // gated by the same normalisation after the cure).
  const stringRegistry = createWorkClaimRegistry();
  await deliverByContributor(callX, stringRegistry, "string-verifier-standing", { reviewPolicy: "independent_principal" });
  await callX(stringRegistry, "stringverifier", "review", "string-verifier-standing", { verdict: "approve", summary: "Verified." });
  const stringDone = await callX(stringRegistry, "stringverifier", "update", "string-verifier-standing", { state: "done" });
  assert.equal(stringDone.status, 403, JSON.stringify(stringDone.value));
  assert.equal(stringRegistry.get("room1", "string-verifier-standing").state, "delivered");

  // Array control: the genuine ["verify"] reviewer is a verifier and
  // completes the identical independent_principal flow.
  const arrayRegistry = createWorkClaimRegistry();
  await deliverByContributor(call, arrayRegistry, "array-verifier-standing", { reviewPolicy: "independent_principal" });
  const review = await call(arrayRegistry, "reviewer", "review", "array-verifier-standing", { verdict: "approve", summary: "Verified." });
  assert.equal(review.status, 200, JSON.stringify(review.value));
  const arrayDone = await call(arrayRegistry, "reviewer", "update", "array-verifier-standing", { state: "done" });
  assert.equal(arrayDone.status, 200, JSON.stringify(arrayDone.value));
  assert.equal(arrayDone.value.state, "done");
});
