// DC4-A1 (register F-S4b-1): a release refused for a stale round must carry
// its own cure. Before this fix the 409 was a bare work_claim_conflict whose
// message ("The release basis does not match the current claim…") was false
// in the common case — a board list read truncates claim history to the
// last 3 entries, so a list-shaped round is stale even though the claim
// itself never changed — and self-looping, because re-reading the list
// returns the same truncated round forever. The 409 now carries the full
// current round, a verdict on whether the claim itself also moved, and —
// only when nothing but the round is stale — a prefilled verbatim retry.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const MEMBERS = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work", "verify", "steer"] },
  chat: { id: "chat", kind: "agent", active: true, permissions: [] },
  contribute: { id: "contribute", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  holder: { id: "holder", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

const call = (registry, memberId, route, id, body, query = "") => handleWorkClaims({
  req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
  res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${query}`),
  store: { roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }), room: () => ({ state: { messages: [] } }) },
  roomId: "room1",
  auth: { member: { id: memberId, kind: MEMBERS[memberId].kind, permissions: MEMBERS[memberId].permissions } },
  workClaimRoute: route,
  workClaimId: id,
  helpers,
  registry,
});

const claimedByHolder = async registry => {
  await call(registry, "owner", "create", null, { id: "lane" });
  const claimed = await call(registry, "holder", "claim", "lane", {});
  assert.equal(claimed.status, 200);
  return claimed.value;
};

test("stale-only 409 (truncated list round) carries currentRound and a verbatim retry that succeeds", async () => {
  const registry = createWorkClaimRegistry();
  const claimed = await claimedByHolder(registry);
  // Four note appends: the stored history is now 6 entries, while a board
  // list read would show only the last 3 — the false-409 shape from F-S4b-1.
  for (let i = 0; i < 4; i += 1) await call(registry, "holder", "update", "lane", { note: `progress ${i}` });
  const full = registry.get("room1", "lane");
  assert.equal(full.history.length, 6);

  const listShaped = { expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: 3 };
  const refused = await call(registry, "owner", "release", "lane", { ...listShaped, reason: "stuck" });
  assert.equal(refused.status, 409);
  const body = refused.value;
  assert.equal(body.error.code, "work_claim_conflict"); // status and code unchanged
  assert.equal(body.error.subcode, "round_stale");
  assert.equal(body.subcode, "round_stale");
  assert.deepEqual(body.claim, { id: "lane", state: "claimed", owner: "holder", claimRound: 1 });
  assert.deepEqual(body.callerRound, listShaped);
  assert.deepEqual(body.currentRound, { expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: 6 });
  assert.equal(body.stateChanged, false);
  assert.equal(body.stateChange, undefined);
  assert.equal(body.retryable, true);
  assert.match(body.error.message, /round is stale/);
  assert.doesNotMatch(body.error.message, /claim has moved|changed since it was read/);
  assert.equal(body.next.length, 1);
  assert.equal(body.next[0].action, "release");
  assert.equal(body.next[0].method, "POST");
  assert.equal(body.next[0].path, "/api/rooms/room1/work-claims/lane/release");
  assert.deepEqual(body.next[0].body, body.currentRound);
  // The claim is untouched by the refusal.
  assert.equal(registry.get("room1", "lane").state, "claimed");
  assert.equal(registry.get("room1", "lane").owner, "holder");

  // The prefilled retry, sent verbatim, releases on the second attempt —
  // recovery in ≤2 attempts with no further read (M2 acceptance shape).
  const released = await call(registry, "owner", "release", "lane", { ...body.next[0].body, reason: "stuck" });
  assert.equal(released.status, 200);
  assert.equal(released.value.state, "unclaimed");
  assert.equal(released.value.owner, null);
});

test("moved 409 (state changed since the read) names the transition and prefills no retry", async () => {
  const registry = createWorkClaimRegistry();
  const claimed = await claimedByHolder(registry);
  const readRound = { expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: claimed.history.length };
  await call(registry, "holder", "update", "lane", { state: "in_progress" });

  const refused = await call(registry, "owner", "release", "lane", { ...readRound, reason: "stuck" });
  assert.equal(refused.status, 409);
  const body = refused.value;
  assert.equal(body.error.code, "work_claim_conflict");
  assert.equal(body.error.subcode, "round_and_state_changed");
  assert.equal(body.stateChanged, true);
  assert.deepEqual(body.stateChange, { from: "claimed", to: "in_progress", ownerChanged: false });
  assert.equal(body.retryable, false);
  assert.match(body.error.message, /state changed from "claimed" to "in_progress"/);
  // No blind-retry action: next points at the single-item read only.
  assert.ok(body.next.every(step => step.action !== "release" && step.body === undefined));
  assert.ok(body.next.some(step => step.path === "/api/rooms/room1/work-claims/lane"));
  assert.equal(registry.get("room1", "lane").state, "in_progress");
});

test("moved 409 (released and re-claimed by another member) reports the owner change", async () => {
  const registry = createWorkClaimRegistry();
  const claimed = await claimedByHolder(registry);
  const readRound = { expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: claimed.history.length };
  await call(registry, "holder", "release", "lane", { ...readRound, reason: "done for now" });
  await call(registry, "contribute", "claim", "lane", {});

  const refused = await call(registry, "owner", "release", "lane", { ...readRound, reason: "late duplicate" });
  assert.equal(refused.status, 409);
  const body = refused.value;
  assert.equal(body.error.subcode, "round_and_state_changed");
  assert.equal(body.stateChanged, true);
  assert.deepEqual(body.stateChange, { from: "claimed", to: "claimed", ownerChanged: true });
  assert.equal(body.retryable, false);
  assert.match(body.error.message, /owner changed/);
  // The fresh claim is untouched.
  assert.equal(registry.get("room1", "lane").owner, "contribute");
});

test("the permission gate still runs before the round check: a non-owner gets 403, never the 409 payload", async () => {
  const registry = createWorkClaimRegistry();
  const claimed = await claimedByHolder(registry);
  const stale = { expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: 1 };
  await assert.rejects(call(registry, "chat", "release", "lane", { ...stale, reason: "mine now" }), error => {
    assert.equal(error.status, 403);
    assert.equal(error.code, "work_not_owner");
    return true;
  });
  assert.equal(registry.get("room1", "lane").state, "claimed");
});
