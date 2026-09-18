// RC-2026-09-18-041: claim leases, delivery modes, review policies.
// Pure state-machine tests (no store) plus a handler smoke test with fakes.
import test from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork, updateWork, reassignWork, isLeaseExpired, releaseExpired,
  canCloseWork, roomWorkClaimConfig, workOwnedBy, unclaimedWork, ClaimError,
  STATES, DELIVERY_MODES, REVIEW_POLICIES, DEFAULT_LEASE_HOURS } from "../server/work-claims.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ClaimError && error.code === code);
const T0 = Date.parse("2026-09-18T20:00:00.000Z");
const H = 3600 * 1000;

test("leases: claimWork stamps claimedAt + leaseExpiresAt, default 24h", () => {
  const claimed = claimWork({ id: "w1" }, "quill", { now: T0 });
  assert.equal(claimed.claimedAt, new Date(T0).toISOString());
  assert.equal(claimed.leaseExpiresAt, new Date(T0 + 24 * H).toISOString());
  assert.equal(claimed.state, "claimed");
  assert.equal(claimed.owner, "quill");
  assert.ok(Object.isFrozen(claimed));
});

test("leases: explicit leaseHours and room config override the default", () => {
  const six = claimWork({ id: "w1" }, "quill", { leaseHours: 6, now: T0 });
  assert.equal(six.leaseExpiresAt, new Date(T0 + 6 * H).toISOString());
  const roomy = claimWork({ id: "w2" }, "quill", { room: { workClaims: { defaultLeaseHours: 48 } }, now: T0 });
  assert.equal(roomy.leaseExpiresAt, new Date(T0 + 48 * H).toISOString());
  // explicit leaseHours beats the room default
  const both = claimWork({ id: "w3" }, "quill", { leaseHours: 2, room: { workClaims: { defaultLeaseHours: 48 } }, now: T0 });
  assert.equal(both.leaseExpiresAt, new Date(T0 + 2 * H).toISOString());
  throwsCode(() => claimWork({ id: "w4" }, "quill", { leaseHours: 0 }), "invalid_claim_input");
  throwsCode(() => claimWork({ id: "w4" }, "quill", { leaseHours: -3 }), "invalid_claim_input");
  throwsCode(() => claimWork({ id: "w4" }, "quill", { leaseHours: 721 }), "invalid_claim_input");
});

test("leases: leaseHours null opts out — claims without lease behave as before", () => {
  const claimed = claimWork({ id: "w1" }, "quill", { leaseHours: null, now: T0 });
  assert.equal(claimed.leaseExpiresAt, null);
  assert.equal(claimed.state, "claimed");
  assert.equal(claimed.owner, "quill");
  // never expires, never swept
  assert.equal(isLeaseExpired(claimed, T0 + 365 * 24 * H), false);
  const [same] = releaseExpired([claimed], T0 + 365 * 24 * H);
  assert.equal(same.state, "claimed");
  assert.equal(same.owner, "quill");
  // old call style still works: state machine transitions unchanged
  const done = updateWork(updateWork(claimed, "quill", { state: "in_progress", now: T0 }), "quill", { state: "done", now: T0 });
  assert.equal(done.state, "done");
  assert.equal(done.deliveryMode, null);
  assert.equal(done.history.length, 3);
});

test("isLeaseExpired: only active claims with a lapsed lease expire", () => {
  const claimed = claimWork({ id: "w1" }, "quill", { leaseHours: 6, now: T0 });
  assert.equal(isLeaseExpired(claimed, T0 + 5 * H), false);
  assert.equal(isLeaseExpired(claimed, T0 + 6 * H), true); // boundary counts as expired
  assert.equal(isLeaseExpired(claimed, T0 + 7 * H), true);
  const started = updateWork(claimed, "quill", { state: "in_progress", now: T0 });
  assert.equal(isLeaseExpired(started, T0 + 7 * H), true);
  const done = updateWork(started, "quill", { state: "done", now: T0 });
  assert.equal(isLeaseExpired(done, T0 + 700 * H), false); // done never expires
  assert.equal(isLeaseExpired({ id: "plain" }, T0 + 700 * H), false); // unclaimed never expires
  assert.equal(isLeaseExpired(claimed, new Date(T0 + 7 * H)), true); // Date now accepted
  assert.equal(isLeaseExpired(claimed, new Date(T0 + 7 * H).toISOString()), true); // ISO now accepted
  throwsCode(() => isLeaseExpired(claimed, "soon"), "invalid_claim_input");
});

test("releaseExpired: expired claims auto-release, everything else untouched", () => {
  const expired = claimWork({ id: "e1" }, "quill", { leaseHours: 1, now: T0 });
  const fresh = claimWork({ id: "f1" }, "grok", { leaseHours: 24, now: T0 });
  const nolease = claimWork({ id: "n1" }, "grok", { leaseHours: null, now: T0 });
  const done = updateWork(updateWork(claimWork({ id: "d1" }, "quill", { leaseHours: 1, now: T0 }), "quill", { state: "in_progress", now: T0 }), "quill", { state: "done", now: T0 });
  const input = [expired, fresh, nolease, done, { id: "u1" }];
  const out = releaseExpired(input, T0 + 2 * H);
  assert.equal(out.length, 5);
  const [e, f, n, d, u] = out;
  assert.equal(e.state, "unclaimed");
  assert.equal(e.owner, null);
  assert.equal(e.leaseExpiresAt, null);
  assert.equal(e.history.at(-1).action, "lease_expired");
  assert.match(e.history.at(-1).note, /quill/);
  assert.ok(Object.isFrozen(e) && Object.isFrozen(e.history));
  assert.equal(f.state, "claimed"); // not yet expired
  assert.equal(n.state, "claimed"); // no lease
  assert.equal(d.state, "done"); // done never swept
  assert.equal(u.state, "unclaimed");
  // inputs are not mutated
  assert.equal(expired.state, "claimed");
  assert.equal(expired.owner, "quill");
  throwsCode(() => releaseExpired("nope", T0), "invalid_claim_input");
});

test("delivery modes: done transition persists the mode, others reject it", () => {
  for (const mode of DELIVERY_MODES) {
    const claimed = claimWork({ id: `m-${mode}` }, "quill", { now: T0 });
    const done = updateWork(updateWork(claimed, "quill", { state: "in_progress", now: T0 }), "quill",
      { state: "done", deliveryMode: mode, note: "shipped", now: T0 });
    assert.equal(done.deliveryMode, mode);
    assert.equal(done.history.at(-1).action, "state:done");
  }
  const claimed = claimWork({ id: "mx" }, "quill", { now: T0 });
  throwsCode(() => updateWork(claimed, "quill", { state: "in_progress", deliveryMode: "merged", now: T0 }), "invalid_claim_input");
  throwsCode(() => updateWork(updateWork(claimed, "quill", { state: "in_progress", now: T0 }), "quill",
    { state: "done", deliveryMode: "teleport", now: T0 }), "invalid_claim_input");
  // done without a mode stays valid (backward compat)
  const plain = updateWork(updateWork(claimed, "quill", { state: "in_progress", now: T0 }), "quill", { state: "done", now: T0 });
  assert.equal(plain.deliveryMode, null);
});

test("review policies: all three enforced by canCloseWork", () => {
  assert.deepEqual([...REVIEW_POLICIES].sort(), ["distinct_member", "independent_principal", "self_attested"]);
  const item = { ...claimWork({ id: "r1" }, "quill", { now: T0 }), reviewPolicy: "self_attested" };
  assert.equal(canCloseWork(item, "quill"), true);
  assert.equal(canCloseWork(item, "grok"), false);
  // explicit policy option beats the item's
  assert.equal(canCloseWork(item, "grok", { policy: "distinct_member" }), true);
  const distinct = { ...item, reviewPolicy: "distinct_member" };
  assert.equal(canCloseWork(distinct, "quill"), false); // claimant cannot attest
  assert.equal(canCloseWork(distinct, "grok"), true);
  assert.equal(canCloseWork(distinct, ""), false);
  const indep = { ...item, reviewPolicy: "independent_principal" };
  assert.equal(canCloseWork(indep, "quill", { verifyMembers: ["grok"] }), false); // claimant excluded
  assert.equal(canCloseWork(indep, "grok", { verifyMembers: ["grok"] }), true);
  assert.equal(canCloseWork(indep, "grok", { verifyMembers: [] }), false); // no verify grant
  assert.equal(canCloseWork(indep, "grok", { verifyMembers: new Set(["grok", "instinct"]) }), true); // Set accepted
  assert.equal(canCloseWork(indep, "jillian", { verifyMembers: ["grok"] }), false); // not a verifier
  // nothing to close
  assert.equal(canCloseWork({ id: "u" }, "quill"), false); // unclaimed
  const done = { ...item, state: "done" };
  assert.equal(canCloseWork(done, "quill"), false); // already done
  throwsCode(() => canCloseWork(item, "quill", { policy: "majority_vote" }), "invalid_claim_input");
});

test("roomWorkClaimConfig: the documented config hook", () => {
  assert.deepEqual(roomWorkClaimConfig(undefined), { defaultLeaseHours: DEFAULT_LEASE_HOURS, reviewPolicy: "self_attested" });
  assert.equal(DEFAULT_LEASE_HOURS, 24);
  assert.deepEqual(roomWorkClaimConfig({ workClaims: { defaultLeaseHours: 6, reviewPolicy: "distinct_member" } }),
    { defaultLeaseHours: 6, reviewPolicy: "distinct_member" });
  // invalid values fall back to defaults, never throw
  assert.deepEqual(roomWorkClaimConfig({ workClaims: { defaultLeaseHours: -2, reviewPolicy: "nope" } }),
    { defaultLeaseHours: DEFAULT_LEASE_HOURS, reviewPolicy: "self_attested" });
  assert.ok(Object.isFrozen(roomWorkClaimConfig({})));
});

test("createWork: items enter the registry unclaimed", () => {
  const item = createWork({ id: "c1", title: "Build it", reviewPolicy: "distinct_member", note: "seed" }, { now: T0 });
  assert.equal(item.state, "unclaimed");
  assert.equal(item.owner, null);
  assert.equal(item.title, "Build it");
  assert.equal(item.reviewPolicy, "distinct_member");
  assert.equal(item.history.length, 1);
  assert.equal(item.history[0].action, "created");
  assert.ok(Object.isFrozen(item));
  throwsCode(() => createWork({ id: "" }), "invalid_claim_input");
  throwsCode(() => createWork({ id: "c2", reviewPolicy: "nope" }), "invalid_claim_input");
  // a created item flows through the lease machinery
  const claimed = claimWork(item, "quill", { leaseHours: 3, now: T0 });
  assert.equal(isLeaseExpired(claimed, T0 + 4 * H), true);
});

test("query helpers still filter a list (backward compat)", () => {
  const items = [
    claimWork({ id: "w1" }, "quill", { now: T0 }),
    claimWork({ id: "w2" }, "grok", { now: T0 }),
    createWork({ id: "w3" }, { now: T0 }),
  ];
  assert.deepEqual(workOwnedBy(items, "quill").map(w => w.id), ["w1"]);
  assert.deepEqual(unclaimedWork(items).map(w => w.id), ["w3"]);
});

// --- HTTP handler smoke test with fakes (wiring, not the network) ---

const fakeHelpers = () => {
  const calls = [];
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  return {
    calls,
    json: (res, status, value) => { calls.push({ status, value }); return { status, value }; },
    reject,
    body: async req => req.body,
  };
};
const fakeAuth = (memberId, permissions = []) => ({ member: { id: memberId, kind: "agent", permissions } });
const runRoute = async ({ route, id = null, body: reqBody = {}, memberId = "quill", permissions = [], registry, storeMembers = {} }) => {
  const helpers = fakeHelpers();
  const store = {
    roomAuthority: roomId => ({ members: {
      quill: { id: "quill", kind: "agent", active: true, permissions: ["verify"] },
      grok: { id: "grok", kind: "agent", active: true, permissions: [] },
      ...storeMembers,
    } }),
  };
  const out = await handleWorkClaims({ req: { method: route === "list" || route === "read" ? "GET" : "POST", body: reqBody },
    res: {}, url: {}, store, roomId: "room1", auth: fakeAuth(memberId, permissions),
    workClaimRoute: route, workClaimId: id, helpers, registry });
  return { out, calls: helpers.calls };
};

test("handler: create → claim → complete with delivery mode → release cycle", async () => {
  const registry = createWorkClaimRegistry();
  await runRoute({ route: "create", body: { id: "h1", title: "HTTP it" }, registry });
  const { out: claimed } = await runRoute({ route: "claim", id: "h1", body: { leaseHours: 6 }, registry });
  assert.equal(claimed.value.owner, "quill");
  assert.equal(claimed.value.state, "claimed");
  assert.ok(claimed.value.leaseExpiresAt);
  // foreign claim conflicts
  const dup = await runRoute({ route: "claim", id: "h1", memberId: "grok", registry }).catch(error => error);
  assert.equal(dup.code, "work_claim_conflict");
  // foreign update refused
  const foreign = await runRoute({ route: "update", id: "h1", memberId: "grok", body: { state: "in_progress" }, registry }).catch(error => error);
  assert.equal(foreign.code, "work_not_owner");
  const { out: started } = await runRoute({ route: "update", id: "h1", body: { state: "in_progress" }, registry });
  assert.equal(started.value.state, "in_progress");
  const { out: done } = await runRoute({ route: "update", id: "h1", body: { state: "done", deliveryMode: "merged" }, registry });
  assert.equal(done.value.state, "done");
  assert.equal(done.value.deliveryMode, "merged");
  // release the done item is impossible; release flow on a fresh claim works
  await runRoute({ route: "create", body: { id: "h2" }, registry });
  await runRoute({ route: "claim", id: "h2", registry });
  const { out: released } = await runRoute({ route: "release", id: "h2", registry });
  assert.equal(released.value.state, "unclaimed");
  assert.equal(released.value.owner, null);
});

test("handler: review policies enforced on the done transition", async () => {
  const registry = createWorkClaimRegistry();
  // distinct_member: owner alone cannot close
  await runRoute({ route: "create", body: { id: "p1", reviewPolicy: "distinct_member" }, registry });
  await runRoute({ route: "claim", id: "p1", registry });
  await runRoute({ route: "update", id: "p1", body: { state: "in_progress" }, registry });
  const selfClose = await runRoute({ route: "update", id: "p1", body: { state: "done" }, registry }).catch(error => error);
  assert.equal(selfClose.code, "work_review_rejected");
  const attested = await runRoute({ route: "update", id: "p1", body: { state: "done", reviewedBy: "grok" }, registry });
  assert.equal(attested.out.value.state, "done");
  assert.equal(attested.out.value.reviewedBy, "grok");
  // independent_principal: attester needs the verify permission
  await runRoute({ route: "create", body: { id: "p2", reviewPolicy: "independent_principal" }, registry });
  await runRoute({ route: "claim", id: "p2", registry });
  await runRoute({ route: "update", id: "p2", body: { state: "in_progress" }, registry });
  const noVerify = await runRoute({ route: "update", id: "p2", body: { state: "done", reviewedBy: "grok" }, registry }).catch(error => error);
  assert.equal(noVerify.code, "work_review_rejected"); // grok lacks verify
  const { out: verified } = await runRoute({ route: "update", id: "p2", body: { state: "done", reviewedBy: "quill2" }, registry,
    storeMembers: { quill2: { id: "quill2", kind: "human", active: true, permissions: ["verify"] } } });
  assert.equal(verified.value.state, "done"); // quill2 != claimant and holds verify
  assert.equal(verified.value.reviewedBy, "quill2");
});

test("handler: sweep releases expired claims", async () => {
  const registry = createWorkClaimRegistry();
  // seed an already-expired lease deterministically (claimed 2h ago, 1h lease)
  const { createWork: mk, claimWork: doClaim } = await import("../server/work-claims.mjs");
  registry.set("room1", doClaim(mk({ id: "s1" }), "quill", { leaseHours: 1, now: Date.now() - 2 * 3600 * 1000 }));
  const { out: swept } = await runRoute({ route: "sweep", body: {}, registry });
  assert.deepEqual(swept.value.released, ["s1"]);
  const { out: read } = await runRoute({ route: "read", id: "s1", registry });
  assert.equal(read.value.state, "unclaimed");
  assert.equal(read.value.owner, null);
  assert.equal(read.value.history.at(-1).action, "lease_expired");
});
