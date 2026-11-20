import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatedAgentPages, publicAssetPaths } from "../server/public-assets.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { edgePublicResponse } from "../cloudflare/edge-public.mjs";

// The server sends X-Content-Type-Options: nosniff, so a browser only runs a module
// or applies a stylesheet when the Content-Type is right. R27-1 shipped a .mjs served
// as text/markdown (Board j/k never loaded). Pin the type of every public asset by
// extension, and make a new extension an explicit decision instead of a silent
// "text/markdown" fallback.
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
// Decision #36 (#3254, Option A): the generated agent pages are deploy-time
// build output and are never committed, so a pristine checkout legitimately
// lacks them and the Node server 404s them by design (the contract note in
// server/public-assets.mjs). What this tree can serve is every declared asset
// except generated pages absent from the tree — the same rule
// scripts/candidate-runtime-fixture.mjs applies to the package copy set.
// Generated pages that ARE present stay pinned by the server test below, and
// committed assets stay fail-closed: a missing one still 404s and fails.
const servableAssetPaths = publicAssetPaths.filter(path =>
  !generatedAgentPages.includes(path) || existsSync(join(repositoryRoot, path)));

const EXPECTED = {
  ".js": /^text\/javascript\b/, ".mjs": /^text\/javascript\b/, ".css": /^text\/css\b/, ".html": /^text\/html\b/,
  ".svg": /^image\/svg\+xml\b/, ".png": /^image\/png\b/, ".ttf": /^font\/ttf\b/, ".woff2": /^font\/woff2\b/, ".txt": /^text\/plain\b/,
  ".webmanifest": /^application\/manifest\+json\b/, ".json": /^application\/json\b/, ".sh": /^text\/plain\b/,
  ".md": /^text\/markdown\b/, ".tgz": /^application\/gzip\b/,
};

test("every public asset extension has an explicit expected content type", () => {
  const missing = [...new Set(publicAssetPaths.map(path => extname(path)))].filter(ext => !EXPECTED[ext]);
  assert.deepEqual(missing, [], "add the new extension to EXPECTED and to both assetType maps (server/http.mjs, cloudflare/edge-public.mjs)");
});

test("the server serves every public asset with the content type for its extension", async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, wrong = [];
  for (const path of servableAssetPaths) {
    const res = await fetch(`${origin}/${path}`); await res.arrayBuffer();
    const type = res.headers.get("content-type") || "";
    if (res.status !== 200 || !EXPECTED[extname(path)].test(type)) wrong.push(`${path} -> ${res.status} ${type}`);
  }
  assert.deepEqual(wrong, []);
});

test("the production edge serves every public asset with the content type for its extension", async () => {
  const env = { ROOM_ORIGIN: "https://room.example.test", ASSETS: { fetch: async () => new Response("x") } }, wrong = [];
  for (const path of publicAssetPaths) {
    const url = new URL(`https://room.example.test/${path}`);
    const res = await edgePublicResponse(new Request(url), env, url);
    const type = res?.headers.get("content-type") || "";
    // Pages answer their .html URL with a redirect to the canonical extensionless URL.
    if (extname(path) === ".html" && res?.status === 301) continue;
    if (!res || res.status !== 200 || !EXPECTED[extname(path)].test(type)) wrong.push(`${path} -> ${res?.status} ${type}`);
  }
  assert.deepEqual(wrong, []);
});

test("Node negotiates compression on public startup assets and preloads the workspace for direct room URLs", async t => {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, gzipAsset: promisify(gzip) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, encoding = "gzip") => fetch(origin + path, { headers: { "Accept-Encoding": encoding } });
  const [encoded, identity, landing, direct, health] = await Promise.all([
    get("/src/app.js"), get("/src/app.js", "gzip;q=0, *;q=1"), get("/"), get("/?room=commons"), get("/api/health")
  ]);
  assert.equal(encoded.headers.get("content-encoding"), "gzip");
  assert.match(encoded.headers.get("vary"), /Accept-Encoding/i);
  assert.equal(identity.headers.get("content-encoding"), null);
  assert.equal(await encoded.text(), await identity.text());
  const hint = '<link rel="modulepreload" href="/src/app.js">';
  assert.ok(!(await landing.text()).includes(hint));
  assert.ok((await direct.text()).includes(hint));
  assert.equal(health.headers.get("content-encoding"), null);
  await health.text();
});
