// FIX-53 (ranked-fixes burn-down): pin the claim-write caps at the HTTP
// layer so docs cannot drift from behavior. Two caps, both wire-visible:
//
//   1. Note cap: every note stored on a claim history stamp (create, claim,
//      update, renew) and the release `reason` is at most 4000 characters
//      (UTF-16 code units). Over-long input is 422 `invalid_claim_input`
//      with a message naming the 4000 bound.
//   2. Request-body cap: every JSON route (including all work-claim writes)
//      rejects a request body over 16384 bytes with 413 `too_large`; the
//      message names the actual size and the limit. A body of exactly
//      16384 bytes passes (the cap fires on bytes > 16384).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const BODY_LIMIT = 16384;

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, { raw = false } = {}) => {
    const response = await fetch(`${origin}/api/rooms/commons${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
      body: raw ? body : JSON.stringify(body)
    });
    return { status: response.status, value: await response.json() };
  };
  return { post };
}

async function claimedItem(f, id) {
  assert.equal((await f.post("/work-claims", { id, title: "T" })).status, 201);
  assert.equal((await f.post(`/work-claims/${id}/claim`, { note: "picking this up" })).status, 200);
}

test("create accepts a 4000-char note", async t => {
  const f = await fixture(t);
  const res = await f.post("/work-claims", { id: "cap-note-ok", title: "T", note: "x".repeat(4000) });
  assert.equal(res.status, 201);
});

test("create refuses a 4001-char note with 422 invalid_claim_input", async t => {
  const f = await fixture(t);
  const res = await f.post("/work-claims", { id: "cap-note-over", title: "T", note: "x".repeat(4001) });
  assert.equal(res.status, 422);
  assert.equal(res.value.error.code, "invalid_claim_input");
  assert.match(res.value.error.message, /at most 4000/);
});

test("update refuses a 4001-char note with 422 invalid_claim_input", async t => {
  const f = await fixture(t);
  await claimedItem(f, "cap-note-update");
  const res = await f.post("/work-claims/cap-note-update/update", { note: "x".repeat(4001) });
  assert.equal(res.status, 422);
  assert.equal(res.value.error.code, "invalid_claim_input");
  assert.match(res.value.error.message, /at most 4000/);
});

test("a JSON body over 16384 bytes is refused with 413 too_large naming size and limit", async t => {
  const f = await fixture(t);
  const core = JSON.stringify({ id: "cap-body-over", title: "T" });
  const wire = core + " ".repeat(BODY_LIMIT + 1 - core.length); // exactly 16385 bytes
  assert.equal(Buffer.byteLength(wire), BODY_LIMIT + 1);
  const res = await f.post("/work-claims", wire, { raw: true });
  assert.equal(res.status, 413);
  assert.equal(res.value.error.code, "too_large");
  assert.match(res.value.error.message, /16385 bytes/);
  assert.match(res.value.error.message, /16384 bytes/);
});

test("a JSON body of exactly 16384 bytes passes the body cap", async t => {
  const f = await fixture(t);
  const core = JSON.stringify({ id: "cap-body-exact", title: "T" });
  const wire = core + " ".repeat(BODY_LIMIT - core.length); // exactly 16384 bytes
  assert.equal(Buffer.byteLength(wire), BODY_LIMIT);
  const res = await f.post("/work-claims", wire, { raw: true });
  assert.equal(res.status, 201); // not 413: the cap fires on bytes > 16384
});
