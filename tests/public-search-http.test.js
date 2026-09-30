import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicSearchAssets, reviewedPublicSearchPaths } from "../deploy/public-search.mjs";
import { publicAssetPaths } from "../deploy/public-assets.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-public-search-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("public landing is indexable while app, credentials and unknown pages keep private defaults", async t => {
  const origin = await serve(t);
  const about = await fetch(origin + "/about");
  assert.equal(about.status, 200); assert.match(about.headers.get("content-type"), /text\/html/);
  assert.equal(about.headers.get("x-robots-tag"), "all");
  assert.match(about.headers.get("content-security-policy"), /style-src 'unsafe-inline'/);
  assert.doesNotMatch(about.headers.get("content-security-policy"), /script-src/);
  assert.match(await about.text(), /rel="canonical" href="https:\/\/room.trydemigod.com\/about"/);
  const head = await fetch(origin + "/about", { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.headers.get("x-robots-tag"), "all"); assert.equal(await head.text(), "");
  const alias = await fetch(origin + "/about.html", { redirect: "manual" });
  assert.equal(alias.status, 301); assert.equal(alias.headers.get("location"), "/about");
  for (const path of ["/", "/index.html", "/join.html", "/api/version", "/api/account-session", "/about?token=synthetic", "/compare/not-reviewed"]) {
    const response = await fetch(origin + path);
    assert.match(response.headers.get("x-robots-tag"), /noindex/, path);
  }
  for (const file of publicAssetPaths.filter(path => path.startsWith("compare/") && path.endsWith(".html"))) {
    const canonical = "/" + file.slice(0, -5);
    const page = await fetch(origin + canonical);
    assert.equal(page.status, 200, canonical); assert.match(page.headers.get("x-robots-tag"), /noindex/, canonical);
    assert.match(await page.text(), new RegExp('rel="canonical" href="https://room.trydemigod.com' + canonical + '"'));
  }
  const map = await fetch(origin + "/sitemap.xml");
  assert.equal(map.status, 200); assert.equal(map.headers.get("x-robots-tag"), "all");
  const xml = await map.text(); assert.match(xml, /https:\/\/room.trydemigod.com\/about/); assert.match(xml, /\/receipts/);
  assert.doesNotMatch(xml, /compare|join|api|token/);
  assert.match(await (await fetch(origin + "/robots.txt")).text(), /Sitemap: https:\/\/room.trydemigod.com\/sitemap.xml/);
});

test("failed public asset cannot become indexable or enter sitemap", async t => {
  const origin = await serve(t, { loadAsset: async () => { throw new Error("synthetic missing asset"); } });
  const response = await fetch(origin + "/about");
  assert.equal(response.status, 500); assert.match(response.headers.get("x-robots-tag"), /noindex/);
  assert.doesNotMatch(await (await fetch(origin + "/sitemap.xml")).text(), /\/about/);
});

test("registering comparison assets does not implicitly approve their claims for indexing", () => {
  const routes = publicSearchAssets(["about.html", "compare/project-room-vs-slack.html"]);
  assert.equal(routes.get("/compare/project-room-vs-slack"), "compare/project-room-vs-slack.html");
  assert.deepEqual(reviewedPublicSearchPaths, ["/about"]);
  assert.equal(reviewedPublicSearchPaths.includes("/compare/project-room-vs-slack"), false);
});
