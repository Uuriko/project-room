// FIX-60 (WAVE-300 ranked-fixes burn-down): batch decide endpoint for
// access requests.
//
// POST /api/rooms/{roomId}/access-requests/decide-batch accepts a list of
// { requestId, decision, permissions?, note? } items, decides each with the
// SAME per-item semantics as the single decide endpoint, and returns
// per-item results. Partial failure is by design: one bad item must not
// fail the whole batch. Batches over 100 items are refused with 422.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function startServer(t, fixture) {
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
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
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

async function ownerRoom(origin, fixture, tag) {
  const owner = fixture.store.identities.create(`${tag} batch owner`);
  const roomId = `${tag}-batch-room`;
  const roomRes = await post(origin, "/api/agent-rooms", {
    roomId, title: "Batch decide", purpose: "probe", kind: "personal", displayName: "Batch decide",
  }, owner.secret);
  assert.equal(roomRes.status, 201);
  return { ownerSecret: owner.secret, roomId };
}

async function pendingRequest(origin, fixture, roomId, tag, i) {
  const friend = fixture.store.identities.create(`${tag} batch friend ${i}`);
  const requestId = `${tag}-batch-req-${i}`;
  const res = await post(origin, "/api/access-requests", {
    roomId, identityId: friend.identityId, displayName: `${tag} Friend ${i}`,
    requestedPermissions: ["accept_work"], note: null, requestId,
  });
  assert.equal(res.status, 201);
  return requestId;
}

test("batch decide mixed approve/deny: per-item results all correct", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture, "mix");
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await pendingRequest(origin, fixture, roomId, "mix", i));

  const wanted = ["approve", "deny", "approve", "deny", "approve", "deny"];
  const res = await post(origin, `/api/rooms/${roomId}/access-requests/decide-batch`, {
    decisions: ids.map((requestId, i) => ({ requestId, decision: wanted[i] })),
  }, ownerSecret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.roomId, roomId);
  assert.equal(json.results.length, 6);
  assert.deepEqual(json.summary, { total: 6, succeeded: 6, failed: 0 });
  for (let i = 0; i < 6; i++) {
    const item = json.results[i];
    assert.equal(item.requestId, ids[i]);
    assert.equal(item.ok, true, `item ${i} should succeed`);
    assert.equal(item.status, wanted[i] === "approve" ? "approved" : "denied");
  }

  // The decisions landed: the pending queue is drained.
  const pending = await get(origin, `/api/rooms/${roomId}/access-requests?status=pending`, ownerSecret);
  assert.equal((await pending.json()).requests.length, 0);
  const approved = await get(origin, `/api/rooms/${roomId}/access-requests?status=approved`, ownerSecret);
  assert.equal((await approved.json()).requests.length, 3);
});

test("batch decide: one invalid item fails, the rest succeed", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture, "partial");
  const good = await pendingRequest(origin, fixture, roomId, "partial", 0);
  const good2 = await pendingRequest(origin, fixture, roomId, "partial", 1);

  const res = await post(origin, `/api/rooms/${roomId}/access-requests/decide-batch`, {
    decisions: [
      { requestId: good, decision: "approve" },
      { requestId: "no-such-request", decision: "approve" },
      { requestId: good2, decision: "maybe" },
    ],
  }, ownerSecret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.results.length, 3);
  assert.deepEqual(json.summary, { total: 3, succeeded: 1, failed: 2 });

  assert.equal(json.results[0].ok, true);
  assert.equal(json.results[0].status, "approved");

  assert.equal(json.results[1].ok, false);
  assert.equal(json.results[1].requestId, "no-such-request");
  assert.equal(json.results[1].error.code, "not_found");

  assert.equal(json.results[2].ok, false);
  assert.equal(json.results[2].error.code, "invalid_request");

  // The valid item still landed despite its neighbors failing.
  const approved = await get(origin, `/api/rooms/${roomId}/access-requests?status=approved`, ownerSecret);
  assert.equal((await approved.json()).requests.length, 1);
});

test("batch decide: already-decided item fails per-item, others succeed", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture, "dup");
  const first = await pendingRequest(origin, fixture, roomId, "dup", 0);
  const second = await pendingRequest(origin, fixture, roomId, "dup", 1);

  // Decide the first request once via the single endpoint.
  const single = await post(origin, `/api/rooms/${roomId}/access-requests/${first}/decide`,
    { decision: "deny" }, ownerSecret);
  assert.equal(single.status, 200);

  const res = await post(origin, `/api/rooms/${roomId}/access-requests/decide-batch`, {
    decisions: [
      { requestId: first, decision: "approve" },
      { requestId: second, decision: "approve" },
    ],
  }, ownerSecret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.results[0].ok, false);
  assert.equal(json.results[0].error.code, "already_decided");
  assert.equal(json.results[1].ok, true);
  assert.equal(json.results[1].status, "approved");
});

test("batch decide: over-cap batches are refused cleanly", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture, "cap");
  const one = await pendingRequest(origin, fixture, roomId, "cap", 0);

  const decisions = Array.from({ length: 101 }, (_, i) =>
    ({ requestId: i === 0 ? one : `cap-nope-${i}`, decision: "approve" }));
  const res = await post(origin, `/api/rooms/${roomId}/access-requests/decide-batch`,
    { decisions }, ownerSecret);
  assert.equal(res.status, 422);
  const json = await res.json();
  assert.equal(json.error.code, "batch_too_large");

  // Nothing was decided: the batch is refused before any per-item work.
  const pending = await get(origin, `/api/rooms/${roomId}/access-requests?status=pending`, ownerSecret);
  assert.equal((await pending.json()).requests.length, 1);
});

test("batch decide: missing or non-array decisions is a 422", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture, "shape");

  for (const body of [{}, { decisions: "nope" }, { decisions: [], extra: 1 }]) {
    const res = await post(origin, `/api/rooms/${roomId}/access-requests/decide-batch`, body, ownerSecret);
    assert.equal(res.status, 422, `expected 422 for ${JSON.stringify(body)}`);
    assert.equal((await res.json()).error.code, "invalid_request");
  }
});

test("batch decide: per-item result matches the single decide result shape", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture, "shape2");
  const singleId = await pendingRequest(origin, fixture, roomId, "shape2", 0);
  const batchId = await pendingRequest(origin, fixture, roomId, "shape2", 1);

  const singleRes = await post(origin, `/api/rooms/${roomId}/access-requests/${singleId}/decide`,
    { decision: "approve", permissions: ["accept_work"], note: "welcome" }, ownerSecret);
  assert.equal(singleRes.status, 200);
  const single = await singleRes.json();

  const batchRes = await post(origin, `/api/rooms/${roomId}/access-requests/decide-batch`, {
    decisions: [{ requestId: batchId, decision: "approve", permissions: ["accept_work"], note: "welcome" }],
  }, ownerSecret);
  assert.equal(batchRes.status, 200);
  const item = (await batchRes.json()).results[0];
  assert.equal(item.ok, true);
  // Same per-item fields the single endpoint returns for an identical input.
  assert.equal(item.status, single.status);
  assert.deepEqual(item.grantedPermissions, single.grantedPermissions);
  assert.equal(item.decidedBy, single.decidedBy);
  assert.ok(item.memberId, "batch approval links the identity like the single endpoint");
});

test("batch decide: single decide endpoint still routes and behaves identically", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture, "single");
  const requestId = await pendingRequest(origin, fixture, roomId, "single", 0);

  // The single route must not be swallowed by the batch route.
  const res = await post(origin, `/api/rooms/${roomId}/access-requests/${requestId}/decide`,
    { decision: "deny" }, ownerSecret);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "denied");
});
