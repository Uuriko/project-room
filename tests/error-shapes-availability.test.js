// Lane 5 (docspolish-error-quality): teachable error shapes for the server
// error paths #1616/#1638 did not cover — availability 503s
// (storage_unavailable, mail_not_configured), the already_* 409 family, and
// work-claim board errors (work_claim_not_found, work_claims_not_permitted).
// Every error should quote its errorId (code), name what's wrong, and say how
// to fix it. Error codes and HTTP statuses are the contract and stay
// unchanged — only hint/next are enriched.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { agentErrorAx, agentErrorBody, validAgentNext } from "../src/agent-error.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  },
  body: JSON.stringify(body),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
});

async function roomWithDecidedRequest(origin, fixture) {
  const owner = fixture.store.identities.create("lane5 owner");
  const friend = fixture.store.identities.create("lane5 friend");
  const roomId = "lane5-room";
  const roomRes = await post(origin, "/api/agent-rooms", {
    roomId, title: "Lane5", purpose: "probe", kind: "personal", displayName: "Lane5",
  }, owner.secret);
  assert.equal(roomRes.status, 201);
  const reqRes = await post(origin, "/api/access-requests", {
    roomId, identityId: friend.identityId, displayName: "Friend",
    requestedPermissions: ["accept_work"], note: null, requestId: "lane5-req-1",
  });
  assert.equal(reqRes.status, 201);
  const decideRes = await post(origin, `/api/rooms/${roomId}/access-requests/lane5-req-1/decide`, {
    decision: "approve", permissions: ["accept_work"], note: null,
  }, owner.secret);
  assert.equal(decideRes.status, 200);
  return { ownerSecret: owner.secret, friendSecret: friend.secret, friendIdentityId: friend.identityId, roomId };
}

// 404 work_claim_not_found must name the board, not "check access".
test("unknown claim id: 404 quotes the id and names the board", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await roomWithDecidedRequest(origin, fixture);
  const res = await get(origin, `/api/rooms/${roomId}/work-claims/no-such-claim`, ownerSecret);
  assert.equal(res.status, 404);
  const json = await res.json();
  assert.equal(json.error.code, "work_claim_not_found", "code is the contract: unchanged");
  assert.match(json.error.message, /no-such-claim/, "message quotes the unknown id");
  assert.equal(json.reason, "work_claim_not_found");
  assert.match(json.hint, /work-claims board/i, "hint names the board to re-read");
  assert.ok(validAgentNext(json.next), "next steps stay valid");
  assert.match(JSON.stringify(json.next), /work-claims/, "next points at the board");
});

// 409 already_decided must say the decision stands; deciding again is futile.
test("deciding twice: 409 says the decision stands", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await roomWithDecidedRequest(origin, fixture);
  const res = await post(origin, `/api/rooms/${roomId}/access-requests/lane5-req-1/decide`, {
    decision: "approve", permissions: ["accept_work"], note: null,
  }, ownerSecret);
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.equal(json.error.code, "already_decided", "code is the contract: unchanged");
  assert.match(json.error.message, /already approved/i, "message names the outcome");
  assert.match(json.hint, /already approved|decision stands/i, "hint says the decision stands");
  assert.ok(validAgentNext(json.next), "next steps stay valid");
});

// 409 already_member must not send the agent to "check access" for being a member.
test("re-requesting as a member: 409 says already a member", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { friendSecret, friendIdentityId, roomId } = await roomWithDecidedRequest(origin, fixture);
  const res = await post(origin, "/api/access-requests", {
    roomId, identityId: friendIdentityId, displayName: "Friend",
    requestedPermissions: ["accept_work"], note: null, requestId: "lane5-req-2",
  }, friendSecret);
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.equal(json.error.code, "already_member", "code is the contract: unchanged");
  assert.match(json.hint, /already (a member|linked)/i, "hint says the identity is already a member");
  assert.ok(validAgentNext(json.next), "next steps stay valid");
});

// AX: storage_unavailable must teach Retry-After + retry + reconcile, per ERROR-TAXONOMY.md.
test("AX: storage_unavailable names Retry-After and the retry", () => {
  const ax = agentErrorAx({ httpStatus: 503, code: "storage_unavailable", message: "Storage is unavailable; no success is claimed" });
  assert.equal(ax.status, "action_required");
  assert.equal(ax.reason, "storage_unavailable");
  assert.match(ax.hint, /Retry-After/i, "hint names Retry-After");
  assert.match(ax.hint, /retry the exact request/i, "hint says retry the exact request");
  assert.match(ax.hint, /reconcile/i, "hint says reconcile afterward");
  assert.ok(validAgentNext(ax.next));
});

// AX: mail_not_configured is a server config problem — retrying is futile.
test("AX: mail_not_configured points at the operator, not access", () => {
  const ax = agentErrorAx({ httpStatus: 503, code: "mail_not_configured", message: "Email delivery is not configured; contact the operator to verify this address" });
  assert.equal(ax.reason, "mail_not_configured");
  assert.match(ax.hint, /not configured/i, "hint names the missing configuration");
  assert.match(ax.hint, /operator/i, "hint names who fixes it");
  assert.match(JSON.stringify(ax.next), /do not retry/i, "next says retrying will not help");
  assert.ok(validAgentNext(ax.next));
});

// AX: work_claims_not_permitted must keep its code and name the profile gate.
test("AX: work_claims_not_permitted keeps its reason and names the profile", () => {
  const ax = agentErrorAx({ httpStatus: 403, code: "work_claims_not_permitted",
    message: "Creating, claiming, renewing, or updating work claims needs a contribute, review, or collaborate profile." });
  assert.equal(ax.reason, "work_claims_not_permitted", "reason is not collapsed to access_denied");
  assert.match(ax.hint, /contribute, review, or collaborate/i, "hint names the required profile");
  assert.ok(validAgentNext(ax.next));
});

test("AX: work_claims_not_permitted claim-cap variant names the owner", () => {
  const ax = agentErrorAx({ httpStatus: 403, code: "work_claims_not_permitted",
    message: "Only the room owner can set the per-member claim cap." });
  assert.equal(ax.reason, "work_claims_not_permitted");
  assert.match(ax.hint, /room owner/i, "hint names the owner");
  assert.ok(validAgentNext(ax.next));
});

// AX: the already_* family teaches "it already happened; reconcile".
test("AX: already_inactive treats the desired state as done", () => {
  const ax = agentErrorAx({ httpStatus: 409, code: "already_inactive", message: "Membership is already inactive" });
  assert.equal(ax.reason, "already_inactive");
  assert.match(ax.hint, /already inactive/i);
  assert.ok(validAgentNext(ax.next));
});

test("AX: already_owner says nothing needs granting", () => {
  const ax = agentErrorAx({ httpStatus: 409, code: "already_owner", message: "That identity is the room owner and already holds full authority" });
  assert.equal(ax.reason, "already_owner");
  assert.match(ax.hint, /already/i);
  assert.doesNotMatch(ax.hint, /Check access and current work/);
  assert.ok(validAgentNext(ax.next));
});

test("AX: already_administers says administration is already held", () => {
  const ax = agentErrorAx({ httpStatus: 409, code: "already_administers", message: "The room owner retains membership administration" });
  assert.equal(ax.reason, "already_administers");
  assert.match(ax.hint, /administr/i);
  assert.ok(validAgentNext(ax.next));
});

// Envelope backward compatibility: the shape gains hint/next teaching, nothing else.
test("envelope: 503 mail_not_configured keeps the envelope and quotes an errorId", () => {
  const body = agentErrorBody({ httpStatus: 503, code: "mail_not_configured", message: "Email delivery is not configured" });
  assert.equal(body.error.code, "mail_not_configured");
  assert.equal(body.reason, "mail_not_configured");
  assert.ok(body.errorId, "5xx bodies carry a quotable errorId");
  assert.match(body.hint, /operator/i);
  assert.ok(validAgentNext(body.next));
});

test("envelope: unknown codes still get the generic envelope", () => {
  const body = agentErrorBody({ httpStatus: 418, code: "teapot_brew", message: "Short and stout" });
  assert.equal(body.error.code, "teapot_brew");
  assert.equal(body.reason, "teapot_brew");
  assert.equal(body.status, "action_required");
  assert.ok(validAgentNext(body.next));
});
