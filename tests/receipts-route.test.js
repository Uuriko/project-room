// HTTP tests for the public run-receipts page (/receipts) and its JSON
// twin (/api/public/receipts): anonymous 200, cache headers, robots posture,
// no-auth boundary, and snapshot sanity against the generated module.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { RECEIPTS_SNAPSHOT } from "../server/receipts-data.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-receipts-route-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function raw(origin, path, { method = "GET", headers = {} } = {}) {
  const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...headers } });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

test("GET /receipts is a public, cacheable HTML page", async t => {
  const origin = await serve(t);
  const res = await raw(origin, "/receipts");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(res.headers.get("x-robots-tag"), "all");
  assert.ok(res.headers.get("content-security-policy")?.includes("default-src 'none'"), "script-free CSP");
  assert.ok(res.text.includes("<title>Project Room — run receipts</title>"));
  assert.ok(res.text.includes("Run receipts"));
  assert.ok(!res.text.includes("<script"), "no scripts on the page");
});

test("GET /api/public/receipts is a public, cacheable JSON aggregate", async t => {
  const origin = await serve(t);
  const res = await raw(origin, "/api/public/receipts");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
  const body = JSON.parse(res.text);
  assert.equal(typeof body.generatedAt, "string");
  assert.equal(body.board, "Uuriko/project-room#266");
  assert.deepEqual(Object.keys(body.totals).sort(), ["failed", "open", "receipts", "reported", "verified"]);
  assert.equal(body.totals.receipts, body.receipts.length);
  assert.equal(body.totals.verified + body.totals.failed + body.totals.open + body.totals.reported, body.totals.receipts);
  for (const receipt of body.receipts) {
    assert.ok(["verified", "failed", "open", "reported"].includes(receipt.result), `bad result ${receipt.result}`);
    assert.equal(typeof receipt.commentUrl, "string");
  }
});

test("receipts routes need no credential and reject other methods", async t => {
  const origin = await serve(t);
  for (const path of ["/receipts", "/api/public/receipts"]) {
    const head = await raw(origin, path, { method: "HEAD" });
    assert.equal(head.status, 200, `${path} HEAD`);
    const post = await raw(origin, path, { method: "POST" });
    assert.equal(post.status, 405, `${path} POST`);
  }
});

test("generated snapshot is internally consistent", () => {
  assert.ok(Array.isArray(RECEIPTS_SNAPSHOT.receipts) && RECEIPTS_SNAPSHOT.receipts.length > 0, "snapshot has receipts");
  assert.match(RECEIPTS_SNAPSHOT.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof RECEIPTS_SNAPSHOT.commentsScanned, "number");
  assert.match(RECEIPTS_SNAPSHOT.upstreamMain, /^[0-9a-f]{40}$/);
  const seen = new Set();
  for (const receipt of RECEIPTS_SNAPSHOT.receipts) {
    assert.match(receipt.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(receipt.commentUrl.includes("#issuecomment-"));
    if (receipt.task && receipt.sha) {
      const key = `${receipt.task}${receipt.sha}`;
      assert.ok(!seen.has(key), `duplicate task+sha ${key}`);
      seen.add(key);
    }
    if (receipt.shaFull) assert.match(receipt.shaFull, /^[0-9a-f]{40}$/);
    if (receipt.result === "verified") assert.ok(receipt.shaFull, "verified receipts carry the full SHA");
  }
});
