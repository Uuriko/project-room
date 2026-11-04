// F-C6-T4 falsifier probes for PR #5063 at head 6d96cc5a.
// Pattern copied from tests/work-claim-permission-granularity.test.js.
// Each DEFECT-class probe asserts the SECURE outcome: a failing test is a
// firing probe (reproducible defect). Reportable-only probes log outcomes.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkClaimRegistry, handleWorkClaims, closeWorkClaim, linkWorkClaimPullRequest,
  mayClaimWorkClaims, mayCompleteWorkClaims,
} from "../server/work-claim-routes.mjs";

const baseMembers = () => ({
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work", "verify", "steer"] },
  reviewer: { id: "reviewer", kind: "agent", active: true, permissions: ["verify"] },
  accepter: { id: "accepter", kind: "agent", active: true, permissions: ["accept_work"] },
  completer: { id: "completer", kind: "agent", active: true, permissions: ["complete_work"] },
  contributor: { id: "contributor", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  manager: { id: "manager", kind: "agent", active: true, permissions: ["manage_claims"] },
  nobody: { id: "nobody", kind: "agent", active: true, permissions: [] },
  humanverify: { id: "humanverify", kind: "human", active: true, permissions: ["verify"] },
});

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => {
    const error = new Error(message);
    error.status = status; error.code = code;
    error.body = { error: { code, message } };
    throw error;
  },
  body: async req => req.body,
};

// membersRef: { current: <map> } so probes can mutate authority mid-flow.
// authFor: explicit auth.member override (A1/A2 self-assertion probes).
function makeCall(membersRef) {
  return async (registry, memberId, route, id, body, authFor) => {
    const listed = membersRef.current[memberId];
    const authMember = authFor ?? { id: memberId, kind: listed?.kind ?? "agent", permissions: listed?.permissions };
    try {
      return await handleWorkClaims({
        req: { method: "POST", body }, res: {},
        url: new URL("https://room.example/api/rooms/room1/work-claims"),
        store: { roomAuthority: () => ({ ownerId: "owner", members: membersRef.current }), room: () => ({ state: { messages: [] } }) },
        roomId: "room1", auth: { member: authMember },
        workClaimRoute: route, workClaimId: id, helpers, registry,
      });
    } catch (error) {
      return { status: error.status ?? 0, value: error.body ?? { error: { code: error.code, message: error.message } }, thrown: true };
    }
  };
}

const DELIVERY = { artifact: { kind: "text", ref: "room://artifacts/x", sha256: "c".repeat(64) }, checks: [{ name: "unit", result: "pass" }], criteria: [] };

async function setupHolder(call, registry, holder, id, extra = {}) {
  assert.equal((await call(registry, "owner", "create", null, { id, ...extra })).status, 201);
  const created = registry.get("room1", id);
  // Lane-08 adaptation (setup only, no assertion changed): the §4.1 cure
  // refuses the owner reassign this helper used to perform when the holder
  // lacks accept_work (403 work_claims_not_permitted), so seed the identical
  // pre-test state directly instead. The seeded fields replicate
  // reassignWork (server/work-claims.mjs) for a fresh assignment from
  // unclaimed, verified field-by-field against the pre-cure golden state:
  // state claimed, a fresh claimedAt/lease (room default 24h), claimRound+1,
  // the fresh-round clears (delivery/verification/ci null, deliveryGeneration
  // 0), empty attestations/reviews, the readingAcks normalisation the
  // route commit would have applied, updatedAt, and the history stamp
  // { at, agentId: "owner", action: `reassigned:${holder}`, note: null }
  // that withHistory appends for the reassign.
  const atMs = Date.now();
  const at = new Date(atMs).toISOString();
  registry.set("room1", {
    ...created,
    readingAcks: created.readingAcks ?? {},
    state: "claimed",
    owner: holder,
    claimedAt: at,
    claimRound: (created.claimRound ?? 0) + 1,
    leaseStartAt: at,
    leaseExpiresAt: new Date(atMs + 24 * 3600 * 1000).toISOString(),
    delivery: null,
    verification: null,
    ci: null,
    deliveryGeneration: 0,
    attestations: Object.freeze([]),
    reviews: Object.freeze([]),
    updatedAt: at,
    history: Object.freeze([...created.history, Object.freeze({ at, agentId: "owner", action: `reassigned:${holder}`, note: null })]),
  });
}

async function deliverByContributor(call, registry, id, extra = {}) {
  assert.equal((await call(registry, "owner", "create", null, { id, ...extra })).status, 201);
  assert.equal((await call(registry, "contributor", "claim", id, {})).status, 200);
  assert.equal((await call(registry, "contributor", "update", id, { state: "in_progress" })).status, 200);
  const d = await call(registry, "contributor", "update", id, { state: "delivered", delivery: DELIVERY });
  assert.equal(d.status, 200, `deliver: ${JSON.stringify(d.value)}`);
}

// ---------- F1: reassign is an unguarded acquire path ----------
test("F1a: holder reassign hands a claim to a verify-only member (no accept_work check on newOwner)", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "f1a" })).status, 201);
  assert.equal((await call(registry, "contributor", "claim", "f1a", {})).status, 200);
  const cur = registry.get("room1", "f1a");
  const r = await call(registry, "contributor", "reassign", "f1a", {
    newOwner: "reviewer", expectedClaimedAt: cur.claimedAt ?? null, expectedHistoryLength: cur.history.length,
  });
  console.log(`F1a outcome: status=${r.status} owner=${registry.get("room1", "f1a")?.owner}`);
  assert.notEqual(registry.get("room1", "f1a").owner, "reviewer",
    "F1 FIRES: verify-only reviewer acquired a claim via reassign without accept_work");
});

test("F1b: manager reassigns an UNCLAIMED item to a verify-only member", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "f1b" })).status, 201);
  const cur = registry.get("room1", "f1b");
  const r = await call(registry, "manager", "reassign", "f1b", {
    newOwner: "reviewer", expectedClaimedAt: cur.claimedAt ?? null, expectedHistoryLength: cur.history.length,
  });
  console.log(`F1b outcome: status=${r.status} owner=${registry.get("room1", "f1b")?.owner} state=${registry.get("room1", "f1b")?.state}`);
  assert.notEqual(registry.get("room1", "f1b").owner, "reviewer",
    "F1 FIRES: verify-only reviewer acquired an unclaimed claim via manager reassign");
});

test("F1c downstream: after a reassign-in, the verify-only holder's completion exits refuse", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  await setupHolder(call, registry, "reviewer", "f1c");
  const done = await call(registry, "reviewer", "update", "f1c", { state: "done" });
  const close = await call(registry, "reviewer", "close", "f1c", {});
  console.log(`F1c outcome: update->done=${done.status} close=${close.status} state=${registry.get("room1", "f1c").state}`);
  assert.equal(done.status, 403); assert.equal(close.status, 403);
  assert.notEqual(registry.get("room1", "f1c").state, "done");
});

// ---------- F2: reviewer verify-to-done outside a reviewed policy ----------
test("F2a: verify-to-done with NO reviewPolicy (room default) and NO recorded review/attestation", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  await deliverByContributor(call, registry, "f2a");
  const r = await call(registry, "reviewer", "update", "f2a", { state: "done" });
  console.log(`F2a outcome: status=${r.status} state=${registry.get("room1", "f2a").state} code=${r.value?.error?.code}`);
  assert.notEqual(registry.get("room1", "f2a").state, "done",
    "F2 FIRES: verify-only reviewer completed work to done with no policy/attestation");
});

test("F2b: verify-to-done under explicit self_attested policy with NO recorded review/attestation", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  await deliverByContributor(call, registry, "f2b", { reviewPolicy: "self_attested" });
  const r = await call(registry, "reviewer", "update", "f2b", { state: "done" });
  console.log(`F2b outcome: status=${r.status} state=${registry.get("room1", "f2b").state} code=${r.value?.error?.code}`);
  assert.notEqual(registry.get("room1", "f2b").state, "done",
    "F2 FIRES: verify-only reviewer completed work to done under self_attested with no attestation");
});

// ---------- F4: terminal-state synonyms through update ----------
test("F4: state synonyms / delivery-only payload cannot reach a terminal state without complete_work", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const variants = ["Done", "DONE", " done", "closed", "cancelled", "complete", "completed", "verified", "approved"];
  const fired = [];
  for (const holder of ["reviewer", "accepter"]) {
    for (const [i, state] of variants.entries()) {
      const registry = createWorkClaimRegistry();
      const id = `f4-${holder}-${i}`;
      await setupHolder(call, registry, holder, id);
      const r = await call(registry, holder, "update", id, { state });
      const after = registry.get("room1", id);
      if (r.status === 200 && ["done", "closed", "cancelled", "delivered"].includes(after.state)) {
        fired.push(`${holder}:${JSON.stringify(state)}->${after.state}`);
      }
    }
    // delivery payload with no state
    const registry = createWorkClaimRegistry();
    const id = `f4-${holder}-deliveryonly`;
    await setupHolder(call, registry, holder, id);
    await call(registry, holder, "update", id, { state: "in_progress" });
    const r = await call(registry, holder, "update", id, { delivery: DELIVERY });
    const after = registry.get("room1", id);
    if (r.status === 200 && after.delivery) fired.push(`${holder}:delivery-only recorded delivery`);
    // in_progress + reviewedBy self
    const registry2 = createWorkClaimRegistry();
    const id2 = `f4-${holder}-rb`;
    await setupHolder(call, registry2, holder, id2);
    const r2 = await call(registry2, holder, "update", id2, { state: "in_progress", reviewedBy: holder });
    const after2 = registry2.get("room1", id2);
    if (r2.status === 200 && ["done", "closed", "cancelled", "delivered"].includes(after2.state)) {
      fired.push(`${holder}:in_progress+reviewedBy->${after2.state}`);
    }
  }
  console.log(`F4 outcome: fired=${JSON.stringify(fired)}`);
  assert.deepEqual(fired, [], "F4 FIRES: a synonym/delivery variant reached a terminal state without complete_work");
});

// ---------- F5: create-with-assignee edges ----------
test("F5ii: reviewer self-assign at create refuses naming accept_work, no row created", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  const r = await call(registry, "reviewer", "create", null, { id: "f5-self", assignee: "reviewer" });
  console.log(`F5ii outcome: status=${r.status} code=${r.value?.error?.code} has=${registry.has("room1", "f5-self")}`);
  assert.equal(r.status, 403); assert.equal(r.value.error.code, "work_claims_not_permitted");
  assert.match(r.value.error.message, /accept_work/);
  assert.equal(registry.has("room1", "f5-self"), false);
});

test("F5iii: non-string assignee (object / array / explicit null) refuses, never creates a row", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const outcomes = [];
  for (const [i, assignee] of [{ x: 1 }, ["reviewer"], null].entries()) {
    const registry = createWorkClaimRegistry();
    const r = await call(registry, "owner", "create", null, { id: `f5-ns-${i}`, assignee });
    outcomes.push(`${typeof assignee}:${r.status}:${registry.has("room1", `f5-ns-${i}`)}`);
    assert.notEqual(r.status, 201, `assignee ${JSON.stringify(assignee)} created a row`);
    assert.equal(registry.has("room1", `f5-ns-${i}`), false);
  }
  console.log(`F5iii outcomes: ${outcomes.join(" | ")}`);
});

// ---------- F6: MCP twin closeWorkClaim parity ----------
function mcpStore(membersRef, registry) {
  return {
    roomAuthority: () => ({ ownerId: "owner", members: membersRef.current }),
    room: () => ({ state: { messages: [] } }),
    workClaims: registry,
  };
}
function mcpClose(membersRef, registry, memberId, id, verb, reauthorize) {
  const listed = membersRef.current[memberId];
  const auth = { member: { id: memberId, kind: listed?.kind ?? "agent", permissions: listed?.permissions } };
  try {
    const out = closeWorkClaim({ store: mcpStore(membersRef, registry), roomId: "room1", auth, claimId: id, verb, registry, reauthorize });
    return { status: 200, value: out };
  } catch (error) {
    return { status: error.status ?? 0, value: error.body ?? { error: { code: error.code, message: error.message } }, thrown: true };
  }
}

test("F6i/ii: MCP closeWorkClaim refuses verify-only and accept-only holders, both verbs", async () => {
  const fired = [];
  for (const holder of ["reviewer", "accepter"]) {
    for (const verb of ["close", "cancel"]) {
      const membersRef = { current: baseMembers() };
      const call = makeCall(membersRef);
      const registry = createWorkClaimRegistry();
      await setupHolder(call, registry, holder, "f6x");
      const r = mcpClose(membersRef, registry, holder, "f6x", verb);
      const after = registry.get("room1", "f6x");
      console.log(`F6 ${holder}/${verb}: status=${r.status} code=${r.value?.error?.code} state=${after.state}`);
      if (r.status === 200 || ["closed", "cancelled"].includes(after.state)) fired.push(`${holder}/${verb}`);
      else {
        assert.equal(r.status, 403, `${holder}/${verb}`);
        assert.equal(r.value.error.code, "work_claims_not_permitted");
        assert.match(r.value.error.message ?? "", /complete_work/);
      }
    }
  }
  assert.deepEqual(fired, [], "F6 FIRES: MCP twin closed a claim without complete_work/manage_claims");
});

test("F6iii: MCP manager admin-close of another's claim still succeeds (carve-out positive)", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  await setupHolder(call, registry, "contributor", "f6m");
  const r = mcpClose(membersRef, registry, "manager", "f6m", "close");
  console.log(`F6iii outcome: status=${r.status} state=${registry.get("room1", "f6m").state}`);
  assert.equal(r.status, 200, "manager admin close broken (over-blocking regression)");
});

test("F6iv: MCP reauthorize with permissions revoked between auth and reauthorization refuses", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  await setupHolder(call, registry, "contributor", "f6r");
  const reauthorize = () => {
    membersRef.current.contributor = { id: "contributor", kind: "agent", active: true, permissions: ["verify"] };
    return { member: { id: "contributor", kind: "agent", permissions: ["accept_work", "complete_work"] } };
  };
  const r = mcpClose(membersRef, registry, "contributor", "f6r", "close", reauthorize);
  console.log(`F6iv outcome: status=${r.status} code=${r.value?.error?.code} state=${registry.get("room1", "f6r").state}`);
  assert.equal(r.status, 403, "F6 FIRES: close succeeded on stale auth permissions after revocation");
  assert.notEqual(registry.get("room1", "f6r").state, "closed");
});

// ---------- F7: creator-cancel of an unclaimed item (reportable either way) ----------
test("F7: creator-cancel of own unclaimed item by a verify-only creator — outcome recorded", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "reviewer", "create", null, { id: "f7" })).status, 201);
  const r = await call(registry, "reviewer", "cancel", "f7", {});
  console.log(`F7 outcome: status=${r.status} code=${r.value?.error?.code} state=${registry.get("room1", "f7").state}`);
  // Reportable either way per falsifier §F7; no assertion either direction.
  assert.ok([200, 403].includes(r.status));
});

// ---------- F8: non-completion surface of a verify-only holder ----------
test("F8: verify-only holder surface — note, blocked, renew, release+reclaim (renew is risk-class)", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  await setupHolder(call, registry, "reviewer", "f8");
  const note = await call(registry, "reviewer", "update", "f8", { note: "progress note" });
  const blocked = await call(registry, "reviewer", "update", "f8", { state: "blocked" });
  const renew = await call(registry, "reviewer", "renew", "f8", {});
  console.log(`F8 outcome: note=${note.status} blocked=${blocked.status} renew=${renew.status} state=${registry.get("room1", "f8").state}`);
  const cur = registry.get("room1", "f8");
  const rel = await call(registry, "reviewer", "release", "f8", {
    expectedClaimedAt: cur.claimedAt ?? null, expectedHistoryLength: cur.history.length,
  });
  const reclaim = await call(registry, "reviewer", "claim", "f8", {});
  console.log(`F8 outcome2: release=${rel.status} reclaim=${reclaim.status} reclaimCode=${reclaim.value?.error?.code}`);
  assert.equal(reclaim.status, 403, "release+reclaim: claim gate must refuse the verify-only member");
});

// ---------- F9: PR-link side door ----------
test("F9: verify-only holder can link a PR (mayWrite) but linking alone reaches no terminal state", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  await setupHolder(call, registry, "reviewer", "f9");
  const cur = registry.get("room1", "f9");
  let r;
  try {
    const out = linkWorkClaimPullRequest({
      store: mcpStore(membersRef, registry), roomId: "room1",
      auth: { member: { id: "reviewer", kind: "agent", permissions: ["verify"] } },
      claimId: "f9", registry,
      data: { appendPullRequest: "https://github.com/Uuriko/project-room/pull/7", expectedClaimedAt: cur.claimedAt ?? null, expectedHistoryLength: cur.history.length },
    });
    r = { status: 200, value: out };
  } catch (error) {
    r = { status: error.status ?? 0, value: error.body ?? { error: { code: error.code, message: error.message } } };
  }
  const after = registry.get("room1", "f9");
  console.log(`F9 outcome: link status=${r.status} state=${after.state} pr=${JSON.stringify(after.pullRequest?.url ?? null)}`);
  assert.ok(!["done", "closed", "cancelled"].includes(after.state), "F9 FIRES: PR link alone terminalised the claim");
});

// ---------- A1: read-error / malformed authority ----------
test("A1: authority read failures and malformed member records fail closed", async () => {
  const variants = {
    throws: () => { throw new Error("boom"); },
    null: () => null,
    noMembers: () => ({ ownerId: "owner" }),
    stringMember: () => ({ ownerId: "owner", members: { ...baseMembers(), reviewer: "yes" } }),
  };
  const fired = [];
  for (const [name, roomAuthority] of Object.entries(variants)) {
    const registry = createWorkClaimRegistry();
    // seed a row with a working authority first
    const seedRef = { current: baseMembers() };
    const seedCall = makeCall(seedRef);
    assert.equal((await seedCall(registry, "owner", "create", null, { id: `a1-${name}` })).status, 201);
    const call = async (memberId, route, id, body) => {
      try {
        return await handleWorkClaims({
          req: { method: "POST", body }, res: {},
          url: new URL("https://room.example/api/rooms/room1/work-claims"),
          store: { roomAuthority, room: () => ({ state: { messages: [] } }) },
          roomId: "room1",
          auth: { member: { id: memberId, kind: "agent", permissions: ["accept_work", "complete_work"] } },
          workClaimRoute: route, workClaimId: id, helpers, registry,
        });
      } catch (error) {
        return { status: error.status ?? 0, value: error.body ?? { error: { code: error.code, message: error.message } } };
      }
    };
    const before = JSON.stringify(registry.get("room1", `a1-${name}`));
    const claim = await call("reviewer", "claim", `a1-${name}`, {});
    const close = await call("reviewer", "close", `a1-${name}`, {});
    const createAssign = await call("reviewer", "create", null, { id: `a1-${name}-x`, assignee: "reviewer" });
    const after = JSON.stringify(registry.get("room1", `a1-${name}`));
    console.log(`A1 ${name}: claim=${claim.status} close=${close.status} createAssign=${createAssign.status} mutated=${before !== after} rowCreated=${registry.has("room1", `a1-${name}-x`)}`);
    if (claim.status === 200 || close.status === 200 || createAssign.status === 201 || before !== after) fired.push(name);
  }
  assert.deepEqual(fired, [], "A1 FIRES: malformed authority granted or mutated");
});

test("A1b: non-array authority permissions must not fall back to self-asserted auth permissions", async () => {
  const membersRef = { current: baseMembers() };
  membersRef.current.reviewer = { id: "reviewer", kind: "agent", active: true, permissions: 12345 };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "a1b" })).status, 201);
  // auth object self-asserts accept_work; the authority row exists but is malformed.
  const r = await call(registry, "reviewer", "claim", "a1b", {}, { id: "reviewer", kind: "agent", permissions: ["accept_work"] });
  console.log(`A1b outcome: status=${r.status} owner=${registry.get("room1", "a1b").owner}`);
  assert.equal(r.status, 403, "A1 FIRES: self-asserted auth permissions stood in for a malformed authority record");
  assert.equal(registry.get("room1", "a1b").owner, null);
});

// ---------- A2: unknown capability values ----------
test("A2a: near-miss capability strings in the authority record never grant claim/complete", async () => {
  const variants = [["Accept_Work"], ["accept-work"], ["accept_work "], ["accept_work,complete_work"], ["accept_wor"], ["*"], ["work"]];
  const fired = [];
  for (const perms of variants) {
    const membersRef = { current: baseMembers() };
    membersRef.current.reviewer = { id: "reviewer", kind: "agent", active: true, permissions: perms };
    const call = makeCall(membersRef);
    const registry = createWorkClaimRegistry();
    assert.equal((await call(registry, "owner", "create", null, { id: "a2x" })).status, 201);
    const r = await call(registry, "reviewer", "claim", "a2x", {});
    if (r.status === 200) fired.push(JSON.stringify(perms));
  }
  console.log(`A2a outcome: fired=${JSON.stringify(fired)}`);
  assert.deepEqual(fired, [], "A2 FIRES: a near-miss capability string granted claim");
});

test("A2b: bare-string permissions (substring trap) never grant — route and helper unit probes", async () => {
  // unit probes of the exported helpers
  const unit1 = mayClaimWorkClaims({ ownerId: null, member: { id: "x", active: true, permissions: "accept_work" } });
  const unit2 = mayClaimWorkClaims({ ownerId: null, member: { id: "x", active: true, permissions: "xxaccept_workxx" } });
  const unit3 = mayCompleteWorkClaims({ ownerId: null, member: { id: "x", active: true, permissions: "complete_work" } });
  console.log(`A2b unit: mayClaim("accept_work")=${unit1} mayClaim("xxaccept_workxx")=${unit2} mayComplete("complete_work")=${unit3}`);
  assert.equal(unit1, false, "A2 FIRES: helper grants on bare-string permissions (String.includes substring)");
  assert.equal(unit2, false, "A2 FIRES: helper grants on substring-containing string permissions");
  assert.equal(unit3, false, "A2 FIRES: helper grants complete on bare-string permissions");
  // route probe: authority record AND auth both carry the bare string
  const membersRef = { current: baseMembers() };
  membersRef.current.reviewer = { id: "reviewer", kind: "agent", active: true, permissions: "accept_work" };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "a2b" })).status, 201);
  const r = await call(registry, "reviewer", "claim", "a2b", {}, { id: "reviewer", kind: "agent", permissions: "accept_work" });
  console.log(`A2b route outcome: status=${r.status} owner=${registry.get("room1", "a2b").owner}`);
  assert.equal(r.status, 403, "A2 FIRES: bare-string permissions granted claim at the route");
});

// ---------- A3: one bad row ----------
test("A3: one corrupt member row neither grants nor disables the gate for good rows", async () => {
  const membersRef = { current: baseMembers() };
  membersRef.current.bad = { id: "bad", permissions: null };
  membersRef.current.noid = { permissions: ["accept_work", "complete_work"] };
  membersRef.current.noactive = { id: "noactive", kind: "agent", permissions: ["accept_work", "complete_work"] };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  // good lifecycle unaffected
  assert.equal((await call(registry, "owner", "create", null, { id: "a3" })).status, 201);
  assert.equal((await call(registry, "contributor", "claim", "a3", {})).status, 200);
  assert.equal((await call(registry, "contributor", "update", "a3", { state: "in_progress" })).status, 200);
  const done = await call(registry, "contributor", "update", "a3", { state: "done" });
  console.log(`A3 good lifecycle done=${done.status} state=${registry.get("room1", "a3").state}`);
  assert.equal(done.status, 200);
  // reviewer still refused on a good row
  assert.equal((await call(registry, "owner", "create", null, { id: "a3b" })).status, 201);
  const claim = await call(registry, "reviewer", "claim", "a3b", {});
  assert.equal(claim.status, 403);
  // the corrupt-permissions member itself gets nothing via the route
  const badClaim = await call(registry, "bad", "claim", "a3b", {}, { id: "bad", kind: "agent", permissions: null });
  console.log(`A3 bad-row claim=${badClaim.status}`);
  assert.notEqual(badClaim.status, 200, "A3 FIRES: corrupt row granted a claim");
});

// ---------- A4: revocation mid-flow ----------
test("A4: permissions revoked mid-flow — completion exits refuse; re-grant restores claim; deactivation refuses", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "a4" })).status, 201);
  assert.equal((await call(registry, "contributor", "claim", "a4", {})).status, 200);
  // revoke both work permissions, keep member active
  membersRef.current.contributor = { id: "contributor", kind: "agent", active: true, permissions: ["verify"] };
  const delivered = await call(registry, "contributor", "update", "a4", { state: "delivered", delivery: DELIVERY });
  const done = await call(registry, "contributor", "update", "a4", { state: "done" });
  const close = await call(registry, "contributor", "close", "a4", {});
  const cancel = await call(registry, "contributor", "cancel", "a4", {});
  const inprog = await call(registry, "contributor", "update", "a4", { state: "in_progress" });
  console.log(`A4 revoked: delivered=${delivered.status} done=${done.status} close=${close.status} cancel=${cancel.status} in_progress=${inprog.status} state=${registry.get("room1", "a4").state}`);
  for (const [name, r] of [["delivered", delivered], ["done", done], ["close", close], ["cancel", cancel]]) {
    assert.equal(r.status, 403, `A4: ${name} after revocation returned ${r.status}`);
    assert.match(r.value?.error?.message ?? "", /complete_work/, `A4: ${name} refusal must name complete_work`);
  }
  // inverse timing: reviewer refused, granted, retry succeeds (no negative caching)
  const registry2 = createWorkClaimRegistry();
  assert.equal((await call(registry2, "owner", "create", null, { id: "a4b" })).status, 201);
  assert.equal((await call(registry2, "reviewer", "claim", "a4b", {})).status, 403);
  membersRef.current.reviewer = { id: "reviewer", kind: "agent", active: true, permissions: ["verify", "accept_work"] };
  const retry = await call(registry2, "reviewer", "claim", "a4b", {});
  console.log(`A4 re-grant retry: status=${retry.status}`);
  assert.equal(retry.status, 200, "A4: re-granted member still refused (negative caching)");
  // deactivation mid-flow: active:false refuses exits; active deleted is the named edge (logged)
  membersRef.current.contributor = { id: "contributor", kind: "agent", active: false, permissions: ["accept_work", "complete_work"] };
  const deact = await call(registry, "contributor", "close", "a4", {});
  console.log(`A4 active=false close=${deact.status}`);
  assert.equal(deact.status, 403);
  const noActiveField = { ...membersRef.current.contributor };
  delete noActiveField.active;
  membersRef.current.contributor = noActiveField;
  const edge = await call(registry, "contributor", "close", "a4", {});
  console.log(`A4 active-deleted close=${edge.status} state=${registry.get("room1", "a4").state} (named edge, reportable)`);
});

// ---------- A5: creator vs third party ----------
test("A5: third-party and creator-not-holder matrix", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "contributor", "create", null, { id: "a5" })).status, 201);
  const c1 = await call(registry, "completer", "claim", "a5", {});
  console.log(`A5 completer claim=${c1.status} code=${c1.value?.error?.code}`);
  assert.equal(c1.status, 403); assert.match(c1.value.error.message, /accept_work/);
  assert.equal((await call(registry, "accepter", "claim", "a5", {})).status, 200);
  const c2 = await call(registry, "contributor", "update", "a5", { state: "done" });
  console.log(`A5 creator-not-holder update->done=${c2.status} code=${c2.value?.error?.code}`);
  assert.equal(c2.status, 403); assert.equal(c2.value.error.code, "work_not_owner");
});

// ---------- A6: legacy rows ----------
test("A6i: a verify-only holder of a pre-change row keeps NO completion exit; note outcome recorded", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  await setupHolder(call, registry, "reviewer", "a6"); // simulates the pre-change/reassigned-in row
  const done = await call(registry, "reviewer", "update", "a6", { state: "done" });
  const close = await call(registry, "reviewer", "close", "a6", {});
  const cancel = await call(registry, "reviewer", "cancel", "a6", {});
  const note = await call(registry, "reviewer", "update", "a6", { note: "legacy note" });
  console.log(`A6i outcome: done=${done.status} close=${close.status} cancel=${cancel.status} note=${note.status} state=${registry.get("room1", "a6").state}`);
  assert.equal(done.status, 403); assert.equal(close.status, 403); assert.equal(cancel.status, 403);
  assert.notEqual(registry.get("room1", "a6").state, "done");
});

test("A6iii: an already-done row refuses re-update and re-close as terminal (409)", async () => {
  const membersRef = { current: baseMembers() };
  const call = makeCall(membersRef);
  const registry = createWorkClaimRegistry();
  assert.equal((await call(registry, "owner", "create", null, { id: "a6d" })).status, 201);
  assert.equal((await call(registry, "contributor", "claim", "a6d", {})).status, 200);
  assert.equal((await call(registry, "contributor", "update", "a6d", { state: "in_progress" })).status, 200);
  assert.equal((await call(registry, "contributor", "update", "a6d", { state: "done" })).status, 200);
  const re = await call(registry, "contributor", "update", "a6d", { state: "in_progress" });
  const rc = await call(registry, "contributor", "close", "a6d", {});
  console.log(`A6iii outcome: re-update=${re.status}/${re.value?.error?.code} re-close=${rc.status}/${rc.value?.error?.code} state=${registry.get("room1", "a6d").state}`);
  assert.equal(registry.get("room1", "a6d").state, "done");
  assert.notEqual(re.status, 200); assert.notEqual(rc.status, 200);
});
