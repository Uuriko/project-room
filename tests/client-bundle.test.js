// Production client assets are minified content-hashed bundles with an
// immutable cache. The dev server still serves the raw /src modules, and
// index.html stays revalidated so a new deploy's bundle names are picked up.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildAssets } from "../cloudflare/build-assets.mjs";
import { classifyEdgePath, edgePublicResponse } from "../cloudflare/edge-public.mjs";
import { buildClient, byteSize, sourceModuleGraph } from "../scripts/build-client.mjs";
import { HTML_ENTRY_CACHE, IMMUTABLE_CLIENT_CACHE, isPackagedClientAsset } from "../server/client-assets.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";

async function packaged(t) {
  const directory = await mkdtemp(join(tmpdir(), "room-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = pathToFileURL(directory + "/");
  await buildAssets(output);
  const built = await buildClient(output);
  return { directory, output, built };
}

function listen(t, options = {}) {
  const store = new RoomStore(":memory:");
  const server = createRoomServer({ store, ...options });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams();
      server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close();
    });
    resolve(`http://127.0.0.1:${server.address().port}`);
  }));
}

function assetsBinding(directory) {
  return {
    ROOM_ORIGIN: "https://room.example.test",
    ASSETS: { fetch: async request => {
      const rel = new URL(request.url).pathname.replace(/^\//, "");
      try { return new Response(await readFile(join(directory, rel))); }
      catch { return new Response(null, { status: 404 }); }
    } },
  };
}

test("hashed client bundles are immutable and index.html stays revalidated", async t => {
  const { directory, output, built } = await packaged(t);
  const graph = sourceModuleGraph();
  const raw = byteSize(graph);
  assert.ok(built.files.length < graph.length, `bundle files ${built.files.length} should be fewer than raw modules ${graph.length}`);
  assert.ok(built.rawBytes < raw.rawBytes, `bundle raw ${built.rawBytes} should be under raw modules ${raw.rawBytes}`);
  assert.ok(built.gzipBytes < raw.gzipBytes);
  const entry = built.entries["src/entry.js"];
  assert.match(entry, /^assets\/entry-[A-Z0-9]{8}\.js$/);
  for (const file of built.files) assert.equal(isPackagedClientAsset(file.path), true, file.path);
  const html = await readFile(join(directory, "index.html"), "utf8");
  assert.match(html, new RegExp(entry.replace(".", "\\.")));
  assert.doesNotMatch(html, /src\/entry\.js/);
  const bundle = await readFile(join(directory, entry), "utf8");
  assert.equal(bundle.includes("Static imports must finish"), false);

  assert.equal(classifyEdgePath("/" + entry), "asset");
  assert.equal(classifyEdgePath("/room/" + entry), "asset");
  assert.equal(classifyEdgePath("/assets/../server/http.mjs"), null);
  assert.equal(classifyEdgePath("/assets/entry.js"), null);

  const env = assetsBinding(directory);
  const pageUrl = new URL("https://room.example.test/");
  const page = await edgePublicResponse(new Request(pageUrl), env, pageUrl);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), HTML_ENTRY_CACHE);
  assert.match(page.headers.get("etag"), /^"[0-9a-f]{32}"$/);
  const edgeHtml = await page.text();
  assert.match(edgeHtml, new RegExp(entry.replace(".", "\\.")));
  const scriptUrl = new URL("https://room.example.test/" + entry);
  const script = await edgePublicResponse(new Request(scriptUrl), env, scriptUrl);
  assert.equal(script.status, 200);
  assert.equal(script.headers.get("cache-control"), IMMUTABLE_CLIENT_CACHE);
  assert.match(script.headers.get("content-type"), /javascript/);
  assert.match(await script.text(), /import/);
  const prefixed = new URL("https://room.example.test/room/" + entry);
  const prefixedScript = await edgePublicResponse(new Request(prefixed), env, prefixed);
  assert.equal(prefixedScript.status, 200);
  assert.equal(prefixedScript.headers.get("cache-control"), IMMUTABLE_CLIENT_CACHE);
  const rawModule = new URL("https://room.example.test/src/entry.js");
  const rawResponse = await edgePublicResponse(new Request(rawModule), env, rawModule);
  assert.equal(rawResponse.status, 200);
  assert.equal(rawResponse.headers.get("cache-control"), "no-cache");
  assert.match(await rawResponse.text(), /openWorkspace/);
  const missing = new URL("https://room.example.test/assets/entry-AAAAAAAA.js");
  const missingResponse = await edgePublicResponse(new Request(missing), env, missing);
  assert.equal(missingResponse.status, 404);

  const origin = await listen(t, { assetRoot: output });
  const home = await fetch(origin + "/");
  assert.equal(home.status, 200);
  assert.equal(home.headers.get("cache-control"), HTML_ENTRY_CACHE);
  const etag = home.headers.get("etag");
  assert.match(etag, /^"[0-9a-f]{32}"$/);
  assert.match(await home.text(), new RegExp(entry.replace(".", "\\.")));
  const cached = await fetch(origin + "/", { headers: { "if-none-match": etag } });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  const servedBundle = await fetch(origin + "/" + entry);
  assert.equal(servedBundle.status, 200);
  assert.equal(servedBundle.headers.get("cache-control"), IMMUTABLE_CLIENT_CACHE);
  const dev = await listen(t);
  const devHome = await fetch(dev + "/");
  assert.match(await devHome.text(), /src="\.\/src\/entry\.js"/);
  const devModule = await fetch(dev + "/src/entry.js");
  assert.equal(devModule.status, 200);
  assert.equal(devModule.headers.get("cache-control"), "no-store");
  assert.equal(await devModule.text(), await readFile(new URL("../src/entry.js", import.meta.url), "utf8"));

  const other = await mkdtemp(join(tmpdir(), "room-client-again-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  const again = await buildClient(pathToFileURL(other + "/"));
  assert.equal(again.entries["src/entry.js"], entry);

  await buildAssets(output);
  const reset = await readFile(new URL("index.html", output), "utf8");
  assert.match(reset, /src\/entry\.js/);
  const kept = await readdir(new URL("assets/", output));
  assert.ok(kept.some(name => isPackagedClientAsset(`assets/${name}`)));
});

test("a browser still loads the signed-out room from the hashed bundle", async t => {
  const { output } = await packaged(t);
  const origin = await listen(t, { assetRoot: output });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}),
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  const response = await page.goto(origin + "/", { waitUntil: "load", timeout: 30000 });
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => globalThis.document.querySelector("#identity-label")?.textContent === "Not signed in", null, { timeout: 15000 });
  assert.equal(await page.locator("#static-hero").count(), 0);
  assert.equal(await page.locator("#auth-panel").getAttribute("hidden"), null);
  const src = await page.locator('script[type="module"]').getAttribute("src");
  assert.match(src, /^\.\/assets\/entry-[A-Z0-9]{8}\.js$/);
  assert.deepEqual(errors, []);
});
