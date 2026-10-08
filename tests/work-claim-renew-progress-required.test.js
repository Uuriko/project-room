// W2 (fix-lanes guild, 2026-10-07): the RENEW FOOTGUN. An empty renew silently
// upgrades a short lease to the 24h room default, with no progress evidence.
// Fix: renew requires progressMessageId (the holder's own public progress
// message), and an absent leaseHours preserves the claim's existing lease
// duration instead of falling back to the default.
// Authoring-gate answers: each test fails on the pre-fix code for the intended
// reason (verified by reverting each fix) and passes after.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { claimWork, renewWork } from "../server/work-claims.mjs";

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
    roomAuthority: () => ({ ownerId: "quill", members: {
      quill: { id: "quill", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
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

const liveProgress = (authorId = "quill") => ({ id: "progress-1", authorId, body: "Half done.",
  createdAt: new Date(Date.now() + 60_000).toISOString(), revision: 0 });

// A short-lease (2h) claim held by quill.
const claimedRegistry = async (leaseHours = 2) => {
  const registry = createWorkClaimRegistry();
  await runRoute({ route: "create", id: "w1", body: { id: "w1", title: "t" }, registry });
  const { error } = await runRoute({ route: "claim", id: "w1", body: { leaseHours }, registry });
  assert.equal(error, null);
  return registry;
};

const leaseDurationMs = item => Date.parse(item.leaseExpiresAt) - Date.parse(item.leaseStartAt);

test("W2: renew with progressMessageId and no leaseHours preserves the claim's lease duration", async () => {
  const registry = await claimedRegistry(2);
  const { out, error } = await runRoute({ route: "renew", id: "w1",
    body: { progressMessageId: "progress-1" }, storeMessages: [liveProgress()], registry });
  assert.equal(error, null);
  // The 2h claim must NOT silently become 24h.
  assert.equal(leaseDurationMs(out.value), 2 * H, `expected the 2h lease preserved, got ${leaseDurationMs(out.value) / H}h`);
  assert.equal(out.value.history.at(-1).action, "renewed");
});

test("W2: empty renew (no progressMessageId) is refused — a heartbeat body is not enough", async () => {
  const registry = await claimedRegistry(2);
  const before = registry.get("room1", "w1").leaseExpiresAt;
  const { out, error } = await runRoute({ route: "renew", id: "w1", body: {}, registry });
  assert.equal(out, null);
  assert.equal(error.status, 422);
  assert.equal(error.code, "claim_renewal_source_required");
  // The lease is untouched: no silent upgrade, no silent extension.
  assert.equal(registry.get("room1", "w1").leaseExpiresAt, before);
});

test("W2: renew with explicit leaseHours but no progressMessageId is also refused", async () => {
  const registry = await claimedRegistry(2);
  const { out, error } = await runRoute({ route: "renew", id: "w1",
    body: { leaseHours: 3 }, storeMessages: [], registry });
  assert.equal(out, null);
  assert.equal(error.status, 422);
  assert.equal(error.code, "claim_renewal_source_required");
});

test("W2: renew with progressMessageId and explicit leaseHours still uses the explicit duration", async () => {
  const registry = await claimedRegistry(2);
  const { out, error } = await runRoute({ route: "renew", id: "w1",
    body: { progressMessageId: "progress-1", leaseHours: 3 }, storeMessages: [liveProgress()], registry });
  assert.equal(error, null);
  assert.equal(leaseDurationMs(out.value), 3 * H);
});

test("W2 (pure): renewWork with undefined leaseHours preserves duration, explicit null still opts out", () => {
  const claimed = claimWork({ id: "w1", title: "t" }, "quill", { leaseHours: 2, now: Date.now() });
  const preserved = renewWork(claimed, "quill", { now: Date.now() });
  assert.equal(leaseDurationMs(preserved), 2 * H);
  const optedOut = renewWork(claimed, "quill", { leaseHours: null, now: Date.now() });
  assert.equal(optedOut.leaseExpiresAt, null);
  assert.equal(optedOut.leaseStartAt, null);
});
