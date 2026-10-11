// Per-run receipts (Bolter teardown steal #2): the receipts surface projects
// the four Bolter fields — what ran / what it read / what changed / who
// signed off — and every receipt resolves at GET /receipts/{receiptId}.
//
// Covers: enriched receiptOf shape (ran/read/changed/signedOff); released
// claims project with outcome "released"; created-but-never-claimed claims
// do not project; GET /api/rooms/{roomId}/receipts/{receiptId} returns the
// full receipt (200), unknown id -> 404 receipt_not_found, malformed id ->
// 404 not_found (the pathId convention shared by every work-claim route),
// non-member -> 403, unauthenticated -> 401; backward compatibility of
// the existing search fields; receiptId present on the room receipt card.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerKey: fixture.keys.owner, store: fixture.store };
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});
const expectStatus = async (res, status, what) => {
  if (res.status !== status) assert.fail(`${what}: got ${res.status}: ${await res.text()}`);
  return res.json();
};

const PR_URL = "https://github.com/Uuriko/project-room/pull/2536";
const EVIDENCE = ["https://github.com/Uuriko/project-room/pull/2536/files", "sha256:" + "ab".repeat(32)];

async function settleDone(origin, ownerKey, { id, title, deliveryMode = "merged" }) {
  await expectStatus(await post(origin, "/api/rooms/commons/work-claims",
    { id, title, files: ["server/work-claim-routes.mjs"], evidenceRefs: EVIDENCE, pullRequest: PR_URL }, ownerKey), 201, `create ${id}`);
  await expectStatus(await post(origin, `/api/rooms/commons/work-claims/${id}/claim`, {}, ownerKey), 200, `claim ${id}`);
  await expectStatus(await post(origin, `/api/rooms/commons/work-claims/${id}/update`,
    { state: "in_progress" }, ownerKey), 200, `start ${id}`);
  return expectStatus(await post(origin, `/api/rooms/commons/work-claims/${id}/update`,
    { state: "done", note: "shipped", deliveryMode, tags: ["bolter-steal"], blobs: [] }, ownerKey), 200, `done ${id}`);
}

async function settleReleased(origin, ownerKey, { id, title }) {
  await expectStatus(await post(origin, "/api/rooms/commons/work-claims", { id, title }, ownerKey), 201, `create ${id}`);
  const claimed = await expectStatus(await post(origin, `/api/rooms/commons/work-claims/${id}/claim`, {}, ownerKey), 200, `claim ${id}`);
  return expectStatus(await post(origin, `/api/rooms/commons/work-claims/${id}/release`,
    { expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: claimed.history.length, note: "superseded" }, ownerKey), 200, `release ${id}`);
}

async function receiptsSearch(origin, ownerKey, qs = "") {
  const res = await get(origin, `/api/rooms/commons/receipts${qs}`, ownerKey);
  return expectStatus(res, 200, `receipts search ${qs}`);
}

test("done claim projects the four Bolter fields", async t => {
  const { origin, ownerKey } = await serve(t);
  await settleDone(origin, ownerKey, { id: "rr-enriched-1", title: "enriched receipt" });
  const { receipts } = await receiptsSearch(origin, ownerKey);
  const receipt = receipts.find(r => r.workItemId === "rr-enriched-1");
  assert.ok(receipt, "done claim projects a receipt");
  assert.equal(receipt.receiptId, "rc_rr-enriched-1");
  assert.equal(receipt.outcome, "done");
  assert.equal(receipt.title, "enriched receipt");
  // what ran
  assert.equal(receipt.ran.deliveryMode, "merged");
  assert.equal(receipt.ran.pullRequestUrl, PR_URL);
  // what it read
  assert.deepEqual([...receipt.read.evidenceRefs], EVIDENCE);
  // what changed
  assert.deepEqual([...receipt.changed.files], ["server/work-claim-routes.mjs"]);
  assert.deepEqual([...receipt.changed.tags], ["bolter-steal"]);
  assert.ok(Array.isArray(receipt.changed.blobs));
  // who signed off
  assert.equal(receipt.signedOff.reviewedBy, null);
  assert.deepEqual([...receipt.signedOff.attestations], []);
  // run bounds
  assert.ok(Number.isFinite(receipt.startedAt), "startedAt is set");
  assert.ok(receipt.startedAt <= receipt.createdAt, "started before finished");
});

test("released claim projects with outcome released", async t => {
  const { origin, ownerKey } = await serve(t);
  await settleReleased(origin, ownerKey, { id: "rr-released-1", title: "abandoned run" });
  const { receipts } = await receiptsSearch(origin, ownerKey);
  const receipt = receipts.find(r => r.workItemId === "rr-released-1");
  assert.ok(receipt, "released claim projects a receipt");
  assert.equal(receipt.receiptId, "rc_rr-released-1");
  assert.equal(receipt.outcome, "released");
  assert.equal(receipt.title, "abandoned run");
});

test("created-but-never-claimed work does not project a receipt", async t => {
  const { origin, ownerKey } = await serve(t);
  await expectStatus(await post(origin, "/api/rooms/commons/work-claims",
    { id: "rr-untouched-1", title: "never started" }, ownerKey), 201, "create untouched");
  const { receipts } = await receiptsSearch(origin, ownerKey);
  assert.ok(!receipts.some(r => r.workItemId === "rr-untouched-1"), "unsettled claim has no receipt");
});

test("GET receipts/{receiptId} resolves the full receipt", async t => {
  const { origin, ownerKey } = await serve(t);
  await settleDone(origin, ownerKey, { id: "rr-detail-1", title: "detail view" });
  const res = await get(origin, "/api/rooms/commons/receipts/rc_rr-detail-1", ownerKey);
  const body = await expectStatus(res, 200, "receipt detail");
  const receipt = body.receipt ?? body;
  assert.equal(receipt.receiptId, "rc_rr-detail-1");
  assert.equal(receipt.workItemId, "rr-detail-1");
  assert.equal(receipt.outcome, "done");
  assert.ok(receipt.ran && receipt.read && receipt.changed && receipt.signedOff, "four fields present");
});

test("GET receipts/{receiptId} 404s on unknown receipts", async t => {
  const { origin, ownerKey } = await serve(t);
  const res = await get(origin, "/api/rooms/commons/receipts/rc_no-such-claim", ownerKey);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body?.error?.code ?? body?.code, "receipt_not_found");
});

test("GET receipts/{receiptId} rejects malformed ids and strangers", async t => {
  const { origin, ownerKey } = await serve(t);
  await settleDone(origin, ownerKey, { id: "rr-detail-2", title: "detail auth" });
  const bad = await get(origin, "/api/rooms/commons/receipts/rc_bad!!id", ownerKey);
  assert.equal(bad.status, 404, "malformed receipt id is 404 (pathId convention, like every work-claim route)");
  assert.equal((await bad.json())?.error?.code, "not_found");
  const anon = await get(origin, "/api/rooms/commons/receipts/rc_rr-detail-2");
  assert.equal(anon.status, 401, "unauthenticated is 401");
});

test("search keeps the existing receipt contract", async t => {
  const { origin, ownerKey } = await serve(t);
  await settleDone(origin, ownerKey, { id: "rr-compat-1", title: "compat check" });
  const { receipts } = await receiptsSearch(origin, ownerKey, "?q=compat");
  const receipt = receipts.find(r => r.workItemId === "rr-compat-1");
  assert.ok(receipt, "found by search");
  for (const field of ["receiptId", "workItemId", "tags", "summary", "createdBy", "createdAt", "blobs"]) {
    assert.ok(field in receipt, `existing field ${field} preserved`);
  }
  assert.match(receipt.receiptId, /^rc_/);
});

test("room receipt card carries the receiptId", async t => {
  const { origin, ownerKey, store } = await serve(t);
  await settleDone(origin, ownerKey, { id: "rr-card-1", title: "card link" });
  const card = store.room("commons").state.messages.find(
    message => message.kind === "receipt_card" && message.claimId === "rr-card-1");
  assert.ok(card, "receipt card posted for the done claim");
  assert.equal(card.receiptId, "rc_rr-card-1", "card links to the receipt");
});

test("GET receipts/{receiptId} resolves max-length (128-char) claim ids", async t => {
  // Receipt ids are `rc_` + claim id = up to 131 chars; the route must
  // accept the full id or the receipt link 404s on long claim ids.
  const { origin, ownerKey, store } = await serve(t);
  const id = "L".repeat(128);
  await settleDone(origin, ownerKey, { id, title: "long id run" });
  // The room card must exist too: the event envelope's generic *Id check
  // used to reject 131-char receipt ids, silently dropping the card.
  const card = store.room("commons").state.messages.find(
    message => message.kind === "receipt_card" && message.claimId === id);
  assert.ok(card, "receipt card posted for the max-length claim");
  assert.equal(card.receiptId, `rc_${id}`, "card carries the resolvable receiptId");
  const res = await get(origin, `/api/rooms/commons/receipts/${card.receiptId}`, ownerKey);
  const body = await expectStatus(res, 200, "receipt detail for 128-char claim id");
  const receipt = body.receipt ?? body;
  assert.equal(receipt.receiptId, `rc_${id}`);
  assert.equal(receipt.workItemId, id);
});

test("GET receipts/{receiptId} resolves 126-char claim ids (past the old 128 route cap)", async t => {
  const { origin, ownerKey } = await serve(t);
  const id = "M".repeat(126);
  await settleDone(origin, ownerKey, { id, title: "edge id run" });
  const res = await get(origin, `/api/rooms/commons/receipts/rc_${id}`, ownerKey);
  const body = await expectStatus(res, 200, "receipt detail for 126-char claim id");
  assert.equal((body.receipt ?? body).workItemId, id);
});

test("GET receipts/{receiptId} 404s (never 500) on hostile id shapes", async t => {
  const { origin, ownerKey } = await serve(t);
  for (const seg of ["rc_%2F..", "rc_%zz", "rc_%252F", "rc_%E2%9C%93", "rc_%20", "rc_"]) {
    const res = await get(origin, `/api/rooms/commons/receipts/${seg}`, ownerKey);
    assert.equal(res.status, 404, `${seg} is 404`);
  }
});
