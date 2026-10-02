import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("public doors are indexable while credentials and unknown pages keep private defaults", async t => {
  const origin = await serve(t);
  const about = await fetch(origin + "/about");
  assert.equal(about.status, 200); assert.match(about.headers.get("content-type"), /text\/html/);
  assert.equal(about.headers.get("x-robots-tag"), "all");
  assert.match(about.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(about.headers.get("content-security-policy"), /script-src https:\/\/static\.cloudflareinsights\.com/);
  assert.match(about.headers.get("content-security-policy"), /connect-src https:\/\/cloudflareinsights\.com/);
  assert.match(about.headers.get("content-security-policy"), /style-src 'unsafe-inline'/);
  assert.doesNotMatch(about.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(await about.text(), /rel="canonical" href="https:\/\/room.trydemigod.com\/about"/);
  const head = await fetch(origin + "/about", { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.headers.get("x-robots-tag"), "all"); assert.equal(await head.text(), "");
  const alias = await fetch(origin + "/about.html", { redirect: "manual" });
  assert.equal(alias.status, 301); assert.equal(alias.headers.get("location"), "/about");
  const home = await fetch(origin + "/");
  assert.equal(home.status, 200); assert.equal(home.headers.get("x-robots-tag"), "all");
  assert.match(home.headers.get("content-security-policy"), /script-src 'self'/);
  const offers = await fetch(origin + "/offers");
  assert.equal(offers.status, 200); assert.equal(offers.headers.get("x-robots-tag"), "all");
  assert.match(offers.headers.get("content-security-policy"), /script-src 'self'/);
  const indexAlias = await fetch(origin + "/index.html", { redirect: "manual" });
  assert.equal(indexAlias.status, 301); assert.equal(indexAlias.headers.get("location"), "/");
  for (const path of ["/join.html", "/api/version", "/api/account-session", "/about?token=synthetic", "/compare/not-reviewed"]) {
    const response = await fetch(origin + path, { redirect: "manual" });
    assert.match(response.headers.get("x-robots-tag"), /noindex/, path);
  }
  for (const file of publicAssetPaths.filter(path => path.startsWith("compare/") && path.endsWith(".html"))) {
    const canonical = "/" + file.slice(0, -5);
    const page = await fetch(origin + canonical);
    assert.equal(page.status, 200, canonical);
    assert.equal(page.headers.get("x-robots-tag"), "all", canonical);
    const html = await page.text();
    assert.match(html, new RegExp('rel="canonical" href="https://room.trydemigod.com' + canonical + '"'));
    assert.match(page.headers.get("link") ?? "", new RegExp(`<https://room\\.trydemigod\\.com${canonical}>; rel="canonical"`));
    for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(block[1]);
    assert.match(html, /"@type":"FAQPage"/);
  }
  assert.equal((await fetch(origin + "/room/about")).status, 404);
  assert.equal((await fetch(origin + "/room/offers")).status, 404);
  const map = await fetch(origin + "/sitemap.xml");
  assert.equal(map.status, 200); assert.equal(map.headers.get("x-robots-tag"), "all");
  const xml = await map.text();
  assert.match(xml, /<loc>https:\/\/room\.trydemigod\.com\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/room\.trydemigod\.com\/offers<\/loc>/);
  assert.match(xml, /https:\/\/room.trydemigod.com\/about/); assert.match(xml, /\/receipts/);
  assert.match(xml, /<lastmod>2026-10-02<\/lastmod>/);
  for (const slug of ["project-room-vs-slack", "project-room-vs-discord", "agent-collaboration-tool", "multi-agent-workspace", "ai-agent-coordination", "project-room-vs-agent-room"]) {
    assert.match(xml, new RegExp(`/compare/${slug}</loc>`));
  }
  assert.doesNotMatch(xml, /\/join|\/api|token/);
  assert.match(await (await fetch(origin + "/robots.txt")).text(), /Sitemap: https:\/\/room.trydemigod.com\/sitemap.xml/);
});

test("a browser asking for an unknown page gets the HTML 404 and API clients keep JSON", async t => {
  const origin = await serve(t);
  const page = await fetch(origin + "/no-such-page", { headers: { Accept: "text/html" } });
  assert.equal(page.status, 404);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.equal(page.headers.get("x-robots-tag"), "noindex");
  const html = await page.text();
  assert.equal(html, readFileSync(new URL("../404.html", import.meta.url), "utf8"));
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Page not found<\/title>/);
  assert.match(html, /<h1>Page not found<\/h1>/);
  assert.match(html, /href="\/"/);
  assert.match(html, /href="\/about"/);
  assert.match(html, /href="\/receipts"/);
  const head = await fetch(origin + "/no-such-page", { method: "HEAD", headers: { Accept: "text/html" } });
  assert.equal(head.status, 404);
  assert.match(head.headers.get("content-type"), /text\/html/);
  assert.equal(await head.text(), "");
  const client = await fetch(origin + "/no-such-page");
  assert.equal(client.status, 404);
  assert.match(client.headers.get("content-type"), /application\/json/);
  assert.equal((await client.json()).error.code, "not_found");
  for (const path of ["/api/nope", "/mcp/nope", "/.well-known/nope"]) {
    const api = await fetch(origin + path, { headers: { Accept: "text/html" } });
    assert.equal(api.status, 404, path);
    assert.match(api.headers.get("content-type"), /application\/json/, path);
    assert.equal((await api.json()).error.code, "not_found", path);
  }
});

test("failed public asset cannot become indexable or enter sitemap", async t => {
  const origin = await serve(t, { loadAsset: async () => { throw new Error("synthetic missing asset"); } });
  const response = await fetch(origin + "/about");
  assert.equal(response.status, 500); assert.match(response.headers.get("x-robots-tag"), /noindex/);
  assert.doesNotMatch(await (await fetch(origin + "/sitemap.xml")).text(), /\/about/);
});

test("compare routes exist only for registered reviewed pages", () => {
  const routes = publicSearchAssets(["about.html", "index.html", "offers.html", "compare/project-room-vs-slack.html"]);
  assert.equal(routes.has("/compare/project-room-vs-slack"), true);
  assert.equal(routes.has("/compare/project-room-vs-discord"), false);
  assert.equal(routes.get("/"), "index.html");
  assert.equal(routes.get("/offers"), "offers.html");
  assert.equal(reviewedPublicSearchPaths.includes("/compare/project-room-vs-slack"), true);
  assert.equal(reviewedPublicSearchPaths.includes("/compare/not-a-page"), false);
});
