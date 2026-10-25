// FIX12-8: GET /api/openapi.yaml and GET /api/openapi.json serve docs/openapi.yaml.
// The route check reads that served document. Dropping a path from the
// document fails the same check.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { ROUTES } from "../server/routes/table.mjs";

function missingRoutes(document, routes) {
  const missing = [];
  for (const row of routes) {
    const item = document.paths?.[row.path];
    const method = String(row.method || "").toLowerCase();
    const covered = item?.[method] || (method === "head" && item?.get);
    if (!covered) missing.push(`${row.method} ${row.path}`);
  }
  return missing;
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "openapi-spec-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("OpenAPI yaml and json are public, cacheable, and OpenAPI 3.1", async t => {
  const origin = await serve(t);
  const yaml = await fetch(`${origin}/api/openapi.yaml`);
  const json = await fetch(`${origin}/api/openapi.json`);
  assert.equal(yaml.status, 200);
  assert.equal(json.status, 200);
  assert.match(yaml.headers.get("content-type") || "", /^application\/yaml\b/);
  assert.match(json.headers.get("content-type") || "", /^application\/json\b/);
  assert.match(yaml.headers.get("cache-control") || "", /public,\s*max-age=300/);
  assert.match(json.headers.get("cache-control") || "", /public,\s*max-age=300/);
  const etag = yaml.headers.get("etag");
  assert.ok(etag && etag === json.headers.get("etag"), "both representations share one strong etag");
  assert.equal(etag, etag.trim());
  assert.doesNotMatch(etag, /^W\//);
  const document = await json.json();
  assert.equal(document.openapi, "3.1.0");
  assert.equal(parse(await yaml.text()).openapi, "3.1.0");
  const head = await fetch(`${origin}/api/openapi.json`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const cached = await fetch(`${origin}/api/openapi.yaml`, { headers: { "if-none-match": etag } });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  assert.deepEqual(missingRoutes(document, ROUTES), []);
});

test("the route check fails when a served path is removed", () => {
  const document = { paths: {} };
  for (const row of ROUTES) {
    document.paths[row.path] ??= {};
    document.paths[row.path][String(row.method).toLowerCase()] = {};
  }
  const dropped = ROUTES.find(row => row.method === "GET");
  delete document.paths[dropped.path].get;
  assert.deepEqual(missingRoutes(document, ROUTES), [`GET ${dropped.path}`]);
});
