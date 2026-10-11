// WAVE-500 guild-4: heartbeat (renew) on claims that are no longer held.
// A heartbeat on a lease you don't hold must fail with a clear error code
// and never mutate state — no silent lease resurrection, no accidental
// re-claim of a released claim. Probes: (a) expired lease, (a2) swept
// expired lease, (b) released claim, (c) settled (done) claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { claimWork, releaseWork, updateWork, releaseExpired } from "../server/work-claims.mjs";

const H = 3600 * 1000;

const fakeHelpers = () => {
  const calls = [];
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  const json = (res, status, value) => { calls.push({ status, value }); return { status, value }; };
  return { calls, json, reject, body: async req => req.body };
};
const runRoute = async ({ route, id, body = {}, memberId = "quill", registry, storeMessages = [] }) => {
  const helpers = fakeHelpers();
  const store = {
    roomAuthority: () => ({ members: {
      quill: { id: "quill", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
      grok: { id: "grok", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
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
const liveMessage = (overrides = {}) => ({ id: "progress-1", authorId: "quill", body: "Half done.",
  createdAt: new Date(Date.now() + 60_000).toISOString(), revision: 0, ...overrides });
// Snapshot the fields a silent resurrection would touch: renew must fail
// AND leave every one of them byte-identical.
const snapshotClaim = item => JSON.stringify({ state: item.state, owner: item.owner,
  leaseStartAt: item.leaseStartAt, leaseExpiresAt: item.leaseExpiresAt,
  history: item.history.map(entry => entry.action) });

// (a) Heartbeat on an EXPIRED lease (owner intact, no sweep has run yet):
// every route runs the lease sweeper first, so the claim auto-releases and
// the heartbeat is rejected naming the lapse — the dead lease is never
// resurrected, and it stays unclaimed afterwards.
test("handler: renew on an expired lease is rejected and the lease is not resurrected", async () => {
  const registry = createWorkClaimRegistry();
  const claimed = claimWork({ id: "w1", title: "t" }, "quill", { leaseHours: 1, now: Date.now() - 2 * H });
  registry.set("room1", claimed);
  const { out, error } = await runRoute({ route: "renew", id: "w1",
    body: { progressMessageId: "progress-1" },
    storeMessages: [liveMessage()], registry });
  assert.equal(out, null);
  assert.equal(error.status, 409);
  assert.equal(error.code, "claim_lease_lapsed");
  assert.match(error.message, /lapsed and the claim auto-released/);
  const item = registry.get("room1", "w1");
  assert.equal(item.state, "unclaimed", "the sweeper's release stands — no resurrection");
  assert.equal(item.owner, null);
  assert.equal(item.leaseExpiresAt, null);
  assert.equal(item.history.at(-1).action, "lease_expired");
  // A heartbeat by anyone else after the sweep is the same honest 409.
  const foreign = await runRoute({ route: "renew", id: "w1", body: {}, memberId: "grok", registry });
  assert.equal(foreign.error.status, 409);
  assert.equal(foreign.error.code, "claim_lease_lapsed");
});

// (a2) Heartbeat on an expired claim the sweeper already auto-released:
// names the lapsed-lease recovery, doesn't re-claim.
test("handler: renew on a swept (auto-released) expired claim names the lapse and does not re-claim", async () => {
  const registry = createWorkClaimRegistry();
  const claimed = claimWork({ id: "w1", title: "t" }, "quill", { leaseHours: 1, now: Date.now() - 2 * H });
  const [swept] = releaseExpired([claimed], Date.now());
  assert.equal(swept.state, "unclaimed");
  registry.set("room1", swept);
  const before = snapshotClaim(registry.get("room1", "w1"));
  const { out, error } = await runRoute({ route: "renew", id: "w1", body: {}, registry });
  assert.equal(out, null);
  assert.equal(error.status, 409);
  assert.equal(error.code, "claim_lease_lapsed");
  assert.match(error.message, /auto-released — claim it again/);
  assert.equal(snapshotClaim(registry.get("room1", "w1")), before, "must stay unclaimed");
});

// (b) Heartbeat on a RELEASED claim (owner released it): rejected, and a
// different heartbeater must not accidentally re-claim it either.
test("handler: renew on a released claim is rejected — no accidental re-claim", async () => {
  const registry = createWorkClaimRegistry();
  const claimed = claimWork({ id: "w1", title: "t" }, "quill", { leaseHours: 6, now: Date.now() - H });
  registry.set("room1", releaseWork(claimed, "quill", {
    expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: claimed.history.length, now: Date.now() }));
  const before = snapshotClaim(registry.get("room1", "w1"));
  // The former owner heartbeats their own released claim.
  const own = await runRoute({ route: "renew", id: "w1", body: {}, registry });
  assert.equal(own.out, null);
  assert.equal(own.error.status, 409);
  assert.equal(own.error.code, "claim_lease_lapsed");
  assert.match(own.error.message, /not claimed — claim it first/);
  assert.equal(snapshotClaim(registry.get("room1", "w1")), before);
  // A different agent heartbeats the released claim: same 409, not a 403 —
  // and still nobody's claim.
  const foreign = await runRoute({ route: "renew", id: "w1", body: {}, memberId: "grok", registry });
  assert.equal(foreign.out, null);
  assert.equal(foreign.error.status, 409);
  assert.equal(foreign.error.code, "claim_lease_lapsed");
  const item = registry.get("room1", "w1");
  assert.equal(item.state, "unclaimed");
  assert.equal(item.owner, null);
});

// (c) Heartbeat on a SETTLED (done) claim: rejected; a stranger is refused
// before the state check is even reached.
test("handler: renew on a done claim is rejected and settles nothing new", async () => {
  const registry = createWorkClaimRegistry();
  const claimed = claimWork({ id: "w1", title: "t" }, "quill", { leaseHours: 6, now: Date.now() - H });
  const working = updateWork(claimed, "quill", { state: "in_progress", now: Date.now() - H });
  registry.set("room1", updateWork(working, "quill", { state: "done", now: Date.now() - H }));
  const before = snapshotClaim(registry.get("room1", "w1"));
  const { out, error } = await runRoute({ route: "renew", id: "w1", body: {}, registry });
  assert.equal(out, null);
  assert.equal(error.status, 422);
  assert.equal(error.code, "invalid_claim_input");
  assert.match(error.message, /only active claims can be renewed/);
  assert.equal(snapshotClaim(registry.get("room1", "w1")), before, "done claim must not gain a lease");
  const foreign = await runRoute({ route: "renew", id: "w1", body: {}, memberId: "grok", registry });
  assert.equal(foreign.error.status, 403);
  assert.equal(foreign.error.code, "work_not_owner");
});
