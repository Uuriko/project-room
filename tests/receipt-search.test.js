// Receipts search (RC-2026-09-24-205): GET /api/rooms/{roomId}/receipts.
//
// Covers: done items listed / non-done excluded; q full-text (title + notes,
// case-insensitive); tag exact-match repeatable AND; limit default/max;
// cursor pagination round-trip; bad cursor -> 400 bad_cursor;
// unauthenticated -> 401; non-member -> 403 not_member (handler-level, with
// fakes); tags/blobs validation on the done transition (bad tag chars, bad
// blob shape, tags/blobs without done -> 422 invalid_claim_input); summary
// truncation at 240 chars; receiptId = "rc_" + workItemId.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

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
const getJson = async (origin, path, secret) => {
  const res = await get(origin, path, secret);
  return { res, json: await res.json() };
};

// Busy-wait for the wall-clock ms to advance so completion timestamps order
// deterministically (history stamps carry ms precision).
const tickMs = () => { const start = Date.now(); while (Date.now() === start) { /* spin */ } };

async function completeWork(origin, ownerKey, { id, title, note, tags, blobs }) {
  // assert messages must not read the body eagerly (it would be consumed
  // before the final .json()); read it only on failure.
  const expectStatus = async (res, status, what) => {
    if (res.status !== status) assert.fail(`${what}: got ${res.status}: ${await res.text()}`);
    return res;
  };
  await expectStatus(await post(origin, "/api/rooms/commons/work-claims", { id, title }, ownerKey), 201, `create ${id}`);
  await expectStatus(await post(origin, `/api/rooms/commons/work-claims/${id}/claim`, {}, ownerKey), 200, `claim ${id}`);
  await expectStatus(await post(origin, `/api/rooms/commons/work-claims/${id}/update`, { state: "in_progress" }, ownerKey), 200, `start ${id}`);
  tickMs();
  const body = { state: "done", ...(note !== undefined ? { note } : {}),
    ...(tags !== undefined ? { tags } : {}), ...(blobs !== undefined ? { blobs } : {}) };
  const done = await expectStatus(
    await post(origin, `/api/rooms/commons/work-claims/${id}/update`, body, ownerKey), 200, `done ${id}`);
  return done.json();
}

// Seed three receipts (oldest -> newest) plus one in-progress and one
// unclaimed item that must never appear as receipts. Ids are unique per
// call: the work-claim registry is a per-process singleton shared by every
// server in this test file.
async function seed(t) {
  const { origin, ownerKey } = await serve(t);
  const p = `s${Math.random().toString(36).slice(2, 9)}`;
  const ids = { first: `${p}-first`, second: `${p}-second`, third: `${p}-third`, open: `${p}-open`, fresh: `${p}-fresh` };
  const blob = `sha256:${"ab".repeat(32)}`;
  // Every title, note and tag carries the seed token p: the registry is a
  // per-process singleton shared by all tests in this file, so queries
  // must scope to this seed's items only.
  await completeWork(origin, ownerKey, { id: ids.first, title: `Bond the DM gate ${p}`,
    note: `Closed the bond receipt loop for peer DMs ${p}.`, tags: [`${p}-bond`, `${p}-dmgate`], blobs: [blob] });
  await completeWork(origin, ownerKey, { id: ids.second, title: `Deploy the worker ${p}`,
    note: `Shipped the receipt search worker to staging. Mentions widgets ${p}.`, tags: [`${p}-deploy`, `${p}-bond`] });
  await completeWork(origin, ownerKey, { id: ids.third, title: `Quiet title ${p}`,
    note: `${"x".repeat(300)} ${p}`, tags: [] });
  // in-progress: must be excluded
  const open = await post(origin, "/api/rooms/commons/work-claims", { id: ids.open, title: "Still open" }, ownerKey);
  assert.equal(open.status, 201);
  const claimed = await post(origin, `/api/rooms/commons/work-claims/${ids.open}/claim`, {}, ownerKey);
  assert.equal(claimed.status, 200);
  // unclaimed: must be excluded
  const fresh = await post(origin, "/api/rooms/commons/work-claims", { id: ids.fresh, title: "Fresh claim" }, ownerKey);
  assert.equal(fresh.status, 201);
  return { origin, ownerKey, ids, blob, p };
}

test("receipts: done items listed newest-first, non-done excluded", async t => {
  const { origin, ownerKey, ids, p } = await seed(t);
  // Scoped to this seed's token: the registry is shared across tests.
  const { res, json } = await getJson(origin, `/api/rooms/commons/receipts?q=${p}`, ownerKey);
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.deepEqual(json.receipts.map(r => r.workItemId), [ids.third, ids.second, ids.first]);
  assert.equal(json.nextCursor, null);
  for (const receipt of json.receipts) {
    assert.equal(receipt.receiptId, `rc_${receipt.workItemId}`);
    assert.ok(Array.isArray(receipt.tags) && Array.isArray(receipt.blobs));
    assert.equal(typeof receipt.createdAt, "number");
    assert.equal(receipt.createdBy, "owner");
  }
  const [a, b, c] = json.receipts;
  assert.ok(a.createdAt >= b.createdAt && b.createdAt >= c.createdAt, "newest completion first");
  // The unfiltered list never shows non-done items either.
  const all = await getJson(origin, "/api/rooms/commons/receipts?limit=50", ownerKey);
  assert.equal(all.res.status, 200);
  const seen = all.json.receipts.map(r => r.workItemId);
  assert.ok(!seen.includes(ids.open) && !seen.includes(ids.fresh), "non-done items excluded");
  assert.ok(seen.includes(ids.first) && seen.includes(ids.second) && seen.includes(ids.third));
});

test("receipts: q matches title and history notes case-insensitively", async t => {
  const { origin, ownerKey, ids, p } = await seed(t);
  const byTitle = await getJson(origin, `/api/rooms/commons/receipts?q=WORKER+${p}`, ownerKey);
  assert.equal(byTitle.res.status, 200);
  assert.deepEqual(byTitle.json.receipts.map(r => r.workItemId), [ids.second]);
  const byNote = await getJson(origin, `/api/rooms/commons/receipts?q=widgets+${p}`, ownerKey);
  assert.equal(byNote.res.status, 200);
  assert.deepEqual(byNote.json.receipts.map(r => r.workItemId), [ids.second]);
  const byHistoryNote = await getJson(origin, `/api/rooms/commons/receipts?q=PEER+dms+${p}`, ownerKey);
  assert.equal(byHistoryNote.res.status, 200);
  assert.deepEqual(byHistoryNote.json.receipts.map(r => r.workItemId), [ids.first]);
  const none = await getJson(origin, "/api/rooms/commons/receipts?q=zzz-no-such-word", ownerKey);
  assert.equal(none.res.status, 200);
  assert.deepEqual(none.json.receipts, []);
});

test("receipts: tag is exact and repeatable with AND semantics", async t => {
  const { origin, ownerKey, ids, p } = await seed(t);
  const one = await getJson(origin, `/api/rooms/commons/receipts?tag=${p}-bond`, ownerKey);
  assert.equal(one.res.status, 200);
  assert.deepEqual(one.json.receipts.map(r => r.workItemId), [ids.second, ids.first]);
  const both = await getJson(origin, `/api/rooms/commons/receipts?tag=${p}-bond&tag=${p}-dmgate`, ownerKey);
  assert.equal(both.res.status, 200);
  assert.deepEqual(both.json.receipts.map(r => r.workItemId), [ids.first]);
  const pair = await getJson(origin, `/api/rooms/commons/receipts?tag=${p}-bond&tag=${p}-deploy`, ownerKey);
  assert.equal(pair.res.status, 200);
  assert.deepEqual(pair.json.receipts.map(r => r.workItemId), [ids.second]);
  const triple = await getJson(origin, `/api/rooms/commons/receipts?tag=${p}-bond&tag=${p}-deploy&tag=${p}-dmgate`, ownerKey);
  assert.equal(triple.res.status, 200);
  assert.deepEqual(triple.json.receipts, []);
  // exact, not substring
  const partial = await getJson(origin, `/api/rooms/commons/receipts?tag=${p}-bon`, ownerKey);
  assert.equal(partial.res.status, 200);
  assert.deepEqual(partial.json.receipts, []);
});

test("receipts: limit default and max", async t => {
  const { origin, ownerKey, ids: _ids, p } = await seed(t);
  const def = await getJson(origin, `/api/rooms/commons/receipts?q=${p}`, ownerKey);
  assert.equal(def.res.status, 200);
  assert.equal(def.json.receipts.length, 3); // default 20 covers all three
  const fifty = await getJson(origin, `/api/rooms/commons/receipts?q=${p}&limit=50`, ownerKey);
  assert.equal(fifty.res.status, 200);
  assert.equal(fifty.json.receipts.length, 3);
  const over = await getJson(origin, "/api/rooms/commons/receipts?limit=51", ownerKey);
  assert.equal(over.res.status, 422);
  assert.equal(over.json.error.code, "invalid_receipt_query");
  const zero = await getJson(origin, "/api/rooms/commons/receipts?limit=0", ownerKey);
  assert.equal(zero.res.status, 422);
  assert.equal(zero.json.error.code, "invalid_receipt_query");
  const junk = await getJson(origin, "/api/rooms/commons/receipts?limit=many", ownerKey);
  assert.equal(junk.res.status, 422);
});

test("receipts: cursor pagination round-trip", async t => {
  const { origin, ownerKey, ids, p } = await seed(t);
  // Scoped to this seed: the shared registry holds other tests' receipts.
  // This seed's three completions are the newest overall (seeds run
  // sequentially and tick the ms clock), so the scoped pages are stable.
  const p1 = await getJson(origin, `/api/rooms/commons/receipts?q=${p}&limit=1`, ownerKey);
  assert.equal(p1.res.status, 200);
  assert.deepEqual(p1.json.receipts.map(r => r.workItemId), [ids.third]);
  assert.ok(typeof p1.json.nextCursor === "string" && p1.json.nextCursor.length > 0);
  const p2 = await getJson(origin, `/api/rooms/commons/receipts?q=${p}&limit=1&cursor=${encodeURIComponent(p1.json.nextCursor)}`, ownerKey);
  assert.equal(p2.res.status, 200);
  assert.deepEqual(p2.json.receipts.map(r => r.workItemId), [ids.second]);
  assert.ok(typeof p2.json.nextCursor === "string");
  const p3 = await getJson(origin, `/api/rooms/commons/receipts?q=${p}&limit=1&cursor=${encodeURIComponent(p2.json.nextCursor)}`, ownerKey);
  assert.equal(p3.res.status, 200);
  assert.deepEqual(p3.json.receipts.map(r => r.workItemId), [ids.first]);
  assert.equal(p3.json.nextCursor, null);
});

test("receipts: malformed cursor -> 400 bad_cursor", async t => {
  const { origin, ownerKey } = await seed(t);
  for (const cursor of ["???", "bm90LWFuLW9mZnNldA", "e30", "bnVsbA"]) {
    const { res, json } = await getJson(origin, `/api/rooms/commons/receipts?cursor=${encodeURIComponent(cursor)}`, ownerKey);
    assert.equal(res.status, 400, `cursor ${cursor}: ${JSON.stringify(json)}`);
    assert.equal(json.error.code, "bad_cursor");
    assert.ok(Array.isArray(json.next) && json.next.length > 0, "errors carry next[] hints");
  }
});

test("receipts: unauthenticated -> 401", async t => {
  const { origin } = await seed(t);
  const { res, json } = await getJson(origin, "/api/rooms/commons/receipts", null);
  assert.equal(res.status, 401);
  assert.equal(json.error.code, "unauthenticated");
});

test("receipts: summary is the first 240 chars of the completion note, else the title", async t => {
  const { origin, ownerKey, ids, p } = await seed(t);
  const { res, json } = await getJson(origin, `/api/rooms/commons/receipts?q=${p}`, ownerKey);
  assert.equal(res.status, 200);
  const long = json.receipts.find(r => r.workItemId === ids.third);
  assert.equal(long.summary.length, 240);
  assert.equal(long.summary, "x".repeat(240));
  const noted = json.receipts.find(r => r.workItemId === ids.first);
  assert.equal(noted.summary, `Closed the bond receipt loop for peer DMs ${p}.`);
  // no completion note -> falls back to the title
  const nonoteId = `s${Math.random().toString(36).slice(2, 9)}-nonote`;
  await completeWork(origin, ownerKey, { id: nonoteId, title: "Title-only receipt", tags: ["plain"] });
  const again = await getJson(origin, "/api/rooms/commons/receipts?q=Title-only", ownerKey);
  assert.equal(again.res.status, 200);
  assert.equal(again.json.receipts[0].summary, "Title-only receipt");
  assert.deepEqual(again.json.receipts[0].blobs, []);
  assert.deepEqual(again.json.receipts[0].tags, ["plain"]);
});

test("receipts: blobs round-trip on the receipt", async t => {
  const { origin, ownerKey, ids, blob, p } = await seed(t);
  const { res, json } = await getJson(origin, `/api/rooms/commons/receipts?tag=${p}-bond&tag=${p}-dmgate`, ownerKey);
  assert.equal(res.status, 200);
  assert.deepEqual(json.receipts.map(r => r.workItemId), [ids.first]);
  assert.deepEqual(json.receipts[0].blobs, [blob]);
});

test("done transition: tags/blobs validation -> 422 invalid_claim_input", async t => {
  const { origin, ownerKey } = await serve(t);
  const drive = async (id, body, claimFirst = true) => {
    const created = await post(origin, "/api/rooms/commons/work-claims", { id, title: id }, ownerKey);
    assert.equal(created.status, 201);
    if (claimFirst) {
      const claimed = await post(origin, `/api/rooms/commons/work-claims/${id}/claim`, {}, ownerKey);
      assert.equal(claimed.status, 200);
      const started = await post(origin, `/api/rooms/commons/work-claims/${id}/update`, { state: "in_progress" }, ownerKey);
      assert.equal(started.status, 200);
    }
    return post(origin, `/api/rooms/commons/work-claims/${id}/update`, body, ownerKey);
  };
  const badTag = await drive("rv-badtag", { state: "done", tags: ["no good!"] });
  assert.equal(badTag.status, 422);
  assert.equal((await badTag.json()).error.code, "invalid_claim_input");
  const badBlob = await drive("rv-badblob", { state: "done", blobs: ["sha256:zzz"] });
  assert.equal(badBlob.status, 422);
  assert.equal((await badBlob.json()).error.code, "invalid_claim_input");
  const tooMany = await drive("rv-many", { state: "done", tags: Array.from({ length: 11 }, (_, i) => `t${i}`) });
  assert.equal(tooMany.status, 422);
  assert.equal((await tooMany.json()).error.code, "invalid_claim_input");
  // tags/blobs without the done transition are refused
  const early = await drive("rv-early", { state: "in_progress", tags: ["deploy"] });
  assert.equal(early.status, 422);
  assert.equal((await early.json()).error.code, "invalid_claim_input");
  const noteOnly = await drive("rv-noteonly", { note: "just a note", blobs: [`sha256:${"cd".repeat(32)}`] });
  assert.equal(noteOnly.status, 422);
  assert.equal((await noteOnly.json()).error.code, "invalid_claim_input");
  // tags at creation time are accepted
  const created = await post(origin, "/api/rooms/commons/work-claims",
    { id: "rv-seedtags", title: "seeded", tags: ["seed"] }, ownerKey);
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).tags, ["seed"]);
});

// Handler-level: the 403 not_member contract is unreachable through the room
// block over HTTP (it authenticates members only), so it is exercised here
// with fakes, mirroring tests/work-claim-leases.test.js.
test("receipts: non-member -> 403 not_member", async () => {
  const registry = createWorkClaimRegistry();
  const calls = [];
  const helpers = {
    json: (res, status, value) => { calls.push({ status, value }); return { status, value }; },
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const store = {
    roomAuthority: () => ({ members: { quill: { id: "quill", kind: "agent", active: true } } }),
  };
  const run = memberId => handleWorkClaims({
    req: { method: "GET" }, res: {},
    url: new URL("http://x/api/rooms/room1/receipts"),
    store, roomId: "room1", auth: { member: { id: memberId, kind: "agent" } },
    workClaimRoute: "receipts", workClaimId: null, helpers, registry,
  });
  const ghost = await run("ghost").catch(error => error);
  assert.equal(ghost.status, 403);
  assert.equal(ghost.code, "not_member");
  // a real member gets through to the (empty) listing
  const out = await run("quill");
  assert.equal(out.status, 200);
  assert.deepEqual(out.value, { receipts: [], nextCursor: null });
});
