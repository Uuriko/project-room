// QA fix wave 2026-09-28, Worker D: work-claims behavior regressions
// (W1–W4) at the HTTP route boundary plus the denial-copy mappings
// (W4/W5/W6/B8) in src/agent-error.mjs.
//
// Authoring-gate answers: each test guards an observable HTTP contract
// (status code + body/next copy) that the 2026-09-28 agent-user QA sweep
// proved broken on production — W1's `??` null-strip, W2's 422 dead end,
// W3's ghost owner, W4's access-flavored misdiagnosis, and the W5/W6/B8
// next-step misdiagnoses. Every test below fails on the pre-fix code for
// the intended reason (verified by reverting each fix) and passes after.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { claimWork } from "../server/work-claims.mjs";
import { agentErrorAx, validAgentNext } from "../src/agent-error.mjs";

const H = 3600 * 1000;

const fakeHelpers = () => {
  const calls = [];
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  const json = (res, status, value) => { calls.push({ status, value }); return { status, value }; };
  return { calls, json, reject, body: async req => req.body };
};

// Route-level harness (same shape as tests/lease-renewal.test.js): the stub
// store carries a live member list so W3's membership validation has real
// data to check against.
const runRoute = async ({ route, id, body = {}, memberId = "quill", registry, storeMessages = [] }) => {
  const helpers = fakeHelpers();
  const store = {
    roomAuthority: () => ({ ownerId: "quill", members: {
      quill: { id: "quill", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
      grok: { id: "grok", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
      sleepy: { id: "sleepy", active: false },
    } }),
    room: () => ({ sequence: 1, state: { messages: storeMessages } }),
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

const liveProgress = (authorId = "quill") => ({ id: "progress-1", authorId, body: "Half done.",
  createdAt: new Date(Date.now() + 60_000).toISOString(), revision: 0 });

const claimedRegistry = async (claimBody = { leaseHours: 6 }) => {
  const registry = createWorkClaimRegistry();
  const created = await runRoute({ route: "create", id: "w1", body: { id: "w1", title: "t" }, registry });
  assert.equal(created.error, null);
  const { error } = await runRoute({ route: "claim", id: "w1", body: claimBody, registry });
  assert.equal(error, null);
  return registry;
};

// ---------------------------------------------------------------------------
// W1: leaseHours: null opts out of leases; absent means the 24h default
// ---------------------------------------------------------------------------
test("W1: an explicit null leaseHours opts out — no lease is applied", async () => {
  const registry = await claimedRegistry({ leaseHours: null });
  const item = registry.get("room1", "w1");
  assert.equal(item.leaseExpiresAt, null);
  assert.equal(item.leaseStartAt, null);
  assert.equal(item.state, "claimed");
});

test("W1: an omitted leaseHours still applies the room default (24h)", async () => {
  const before = Date.now();
  const registry = await claimedRegistry({});
  const item = registry.get("room1", "w1");
  const expires = Date.parse(item.leaseExpiresAt);
  assert.ok(expires >= before + 24 * H && expires <= Date.now() + 24 * H + 5000);
});

test("W1: junk leaseHours is refused loudly, never silently defaulted", async () => {
  for (const junk of [{ leaseHours: 0 }, { leaseHours: -3 }, { leaseHours: "forever" }, { leaseHours: 721 }]) {
    const registry = createWorkClaimRegistry();
    await runRoute({ route: "create", id: "w1", body: { id: "w1" }, registry });
    const { error } = await runRoute({ route: "claim", id: "w1", body: junk, registry });
    assert.ok(error, `expected a refusal for ${JSON.stringify(junk)}`);
    assert.equal(error.code, "invalid_claim_input");
    assert.match(error.message, /leaseHours/);
  }
});

test("W1: renew with null leaseHours removes the lease (explicit opt-out, like claimWork)", async () => {
  const registry = await claimedRegistry({ leaseHours: 1 });
  const { out, error } = await runRoute({ route: "renew", id: "w1",
    body: { progressMessageId: "progress-1", leaseHours: null },
    registry, storeMessages: [liveProgress()] });
  assert.equal(error, null);
  assert.equal(out.value.leaseExpiresAt, null);
  assert.equal(out.value.leaseStartAt, null);
});

// ---------------------------------------------------------------------------
// W2: /release accepts in_progress (and blocked) claims — pause, then release
// ---------------------------------------------------------------------------
test("W2: release from in_progress pauses internally and returns the item to the pool", async () => {
  const registry = await claimedRegistry();
  const started = await runRoute({ route: "update", id: "w1", body: { state: "in_progress" }, registry });
  assert.equal(started.error, null);
  const { out, error } = await runRoute({ route: "release", id: "w1", body: { note: "done for now" }, registry });
  assert.equal(error, null);
  assert.equal(out.status, 200);
  assert.equal(out.value.state, "unclaimed");
  assert.equal(out.value.owner, null);
  assert.equal(out.value.leaseExpiresAt, null);
  // Both the internal pause and the release are stamped in history.
  assert.deepEqual(out.value.history.slice(-2).map(entry => entry.action), ["state:claimed", "state:unclaimed"]);
});

test("W2: release from blocked also routes through the pause transition", async () => {
  const registry = await claimedRegistry();
  const blocked = await runRoute({ route: "update", id: "w1", body: { state: "blocked" }, registry });
  assert.equal(blocked.error, null);
  const { out, error } = await runRoute({ route: "release", id: "w1", body: {}, registry });
  assert.equal(error, null);
  assert.equal(out.value.state, "unclaimed");
});

test("W2: release from claimed still works as before", async () => {
  const registry = await claimedRegistry();
  const { out, error } = await runRoute({ route: "release", id: "w1", body: {}, registry });
  assert.equal(error, null);
  assert.equal(out.value.state, "unclaimed");
  assert.equal(out.value.history.filter(entry => entry.action === "state:claimed").length, 0);
});

// ---------------------------------------------------------------------------
// W3: /reassign validates the new owner against live room membership
// ---------------------------------------------------------------------------
test("W3: reassign to a nonexistent member is refused with 422", async () => {
  const registry = await claimedRegistry();
  const { out, error } = await runRoute({ route: "reassign", id: "w1", body: { newOwner: "ghost-member-123" }, registry });
  assert.equal(out, null);
  assert.equal(error.status, 422);
  assert.equal(error.code, "work_reassign_unknown_member");
  assert.match(error.message, /ghost-member-123/);
  assert.equal(registry.get("room1", "w1").owner, "quill");
});

test("W3: reassign to an inactive member is refused", async () => {
  const registry = await claimedRegistry();
  const { error } = await runRoute({ route: "reassign", id: "w1", body: { newOwner: "sleepy" }, registry });
  assert.equal(error.code, "work_reassign_unknown_member");
});

test("W3: reassign to a real active member still works", async () => {
  const registry = await claimedRegistry();
  const { out, error } = await runRoute({ route: "reassign", id: "w1", body: { newOwner: "grok", note: "your turn" }, registry });
  assert.equal(error, null);
  assert.equal(out.value.owner, "grok");
});

// ---------------------------------------------------------------------------
// W4: renew after a lease lapse names the recovery — claim it again
// ---------------------------------------------------------------------------
test("W4: renew after the lease lapsed is a 409 that says claim it again", async () => {
  const registry = createWorkClaimRegistry();
  // A claim whose lease expired an hour ago; the route's own sweep will
  // auto-release it before the renew handler runs.
  registry.set("room1", claimWork({ id: "w-lapsed" }, "quill", { leaseHours: 1, now: Date.now() - 2 * H }));
  const { out, error } = await runRoute({ route: "renew", id: "w-lapsed",
    body: { progressMessageId: "progress-1" }, registry, storeMessages: [liveProgress()] });
  assert.equal(out, null);
  assert.equal(error.status, 409);
  assert.equal(error.code, "claim_lease_lapsed");
  assert.match(error.message, /lease lapsed/i);
  assert.match(error.message, /claim it again/i);
});

test("W4: renew on a never-claimed item says claim it first, not an access error", async () => {
  const registry = createWorkClaimRegistry();
  await runRoute({ route: "create", id: "w-fresh", body: { id: "w-fresh" }, registry });
  const { error } = await runRoute({ route: "renew", id: "w-fresh",
    body: { progressMessageId: "progress-1" }, registry, storeMessages: [liveProgress()] });
  assert.equal(error.status, 409);
  assert.equal(error.code, "claim_lease_lapsed");
  assert.match(error.message, /claim it first/i);
  assert.doesNotMatch(error.message, /only the owner/i);
});

// ---------------------------------------------------------------------------
// Denial copy: W4/W5/W6/B8 agentErrorAx mappings
// ---------------------------------------------------------------------------
const ax = ({ code, httpStatus, message, roomId = "room1", workItemId = "w1" }) =>
  agentErrorAx({ code, httpStatus, message, roomId, workItemId });

test("W5: work_not_owner names the holding owner and a real recovery, never a guest invite", () => {
  const value = ax({ code: "work_not_owner", httpStatus: 403,
    message: 'Work "w1" is owned by grok — only the owner can change it' });
  assert.equal(value.reason, "work_not_owner");
  assert.match(value.hint, /grok/);
  assert.match(value.hint, /reassign or release/);
  assert.doesNotMatch(value.hint, /guest invite/i);
  assert.ok(validAgentNext(value.next));
  assert.ok(value.next.some(step => step.path === "/api/rooms/room1/work-claims/w1"));
});

test("W5: work_not_owner on unclaimed work says claim it first", () => {
  const value = ax({ code: "work_not_owner", httpStatus: 403,
    message: 'Work "w1" is owned by nobody — only the owner can change it' });
  assert.match(value.hint, /unclaimed/i);
  assert.match(value.hint, /claim it first/i);
});

test("W6: work_review_rejected points at the attestation route and the solo escape hatch", () => {
  const value = ax({ code: "work_review_rejected", httpStatus: 403,
    message: 'Review policy "distinct_member" not satisfied for "w1": no review attestation recorded by grok' });
  assert.equal(value.reason, "work_review_rejected");
  assert.match(value.hint, /own session/);
  assert.match(value.hint, /self_attested/);
  assert.ok(validAgentNext(value.next));
  assert.ok(value.next.some(step => step.path === "/api/rooms/room1/work-claims/w1/review"));
});

test("W4: claim_lease_lapsed recovery is claim-again, not an access debug", () => {
  const value = ax({ code: "claim_lease_lapsed", httpStatus: 409,
    message: 'Work "w1" is unclaimed: its lease lapsed and the claim auto-released — claim it again to continue the work' });
  assert.equal(value.reason, "claim_lease_lapsed");
  assert.match(value.hint, /Claim the work item again/);
  assert.ok(validAgentNext(value.next));
});

test("B8: owner-decision proposal rejection points at the missing decision-maker, not phantom work", () => {
  const value = ax({ code: "command_rejected", httpStatus: 422,
    message: "Owner decision requires a decision-maker" });
  assert.match(value.hint, /nothing was saved/);
  assert.match(value.hint, /decision-maker/);
  assert.doesNotMatch(value.hint, /Read current work/);
  assert.ok(value.next.some(step => step.command && /humanDecisionMakerId/.test(step.command)));
});
