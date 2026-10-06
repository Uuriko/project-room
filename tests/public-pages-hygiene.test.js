// Public HTML hygiene: raw join templates, receipts metadata, the sitemap,
// and the icon routes. These are the responses a crawler and a phone see.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-public-hygiene-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("GET /join.html redirects to the substituted join page", async t => {
  const origin = await serve(t);
  const raw = await fetch(`${origin}/join.html`, { redirect: "manual" });
  assert.equal(raw.status, 301);
  assert.equal(raw.headers.get("location"), "/join");
  const page = await fetch(`${origin}/join`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.equal(html.includes("{{"), false);
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  const room = await fetch(`${origin}/room/join`);
  assert.equal(room.status, 200);
  assert.match(await room.text(), /src="\/room\/src\/join\.js"/);
  const icon = await fetch(`${origin}/room/favicon.svg`);
  assert.equal(icon.status, 200);
});

test("GET /receipts publishes canonical metadata", async t => {
  const origin = await serve(t);
  const response = await fetch(`${origin}/receipts`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /rel="canonical" href="https:\/\/room\.trydemigod\.com\/receipts"/);
  assert.match(html, /name="description" content="[^"]+"/);
  assert.match(html, /property="og:title"/);
  assert.match(html, /property="og:description" content="[^"]+"/);
  assert.match(html, /property="og:image"/);
  assert.match(html, /<main>/);
});

test("sitemap lists compare pages and those pages return 200", async t => {
  const origin = await serve(t);
  const xml = await (await fetch(`${origin}/sitemap.xml`)).text();
  assert.match(xml, /<loc>https:\/\/room\.trydemigod\.com\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/room\.trydemigod\.com\/offers<\/loc>/);
  assert.match(xml, /<loc>https:\/\/room\.trydemigod\.com\/about<\/loc>/);
  assert.match(xml, /\/compare\/project-room-vs-slack/);
  assert.equal(xml.includes("/compare</loc>"), false);
  const missing = await fetch(`${origin}/compare`);
  assert.equal(missing.status, 404);
  const page = await fetch(`${origin}/compare/project-room-vs-slack`);
  assert.equal(page.status, 200);
  const html = await page.text();
  const hrefs = html.match(/href="([^"]+)"/g) ?? [];
  assert.equal(hrefs.some(href => /href="\/compare\/?"$/.test(href)), false);
  assert.equal(html.includes("master comparison"), false);
  assert.match(html, /href="\/compare\/project-room-vs-discord"/);
});

test("favicon, icon, and manifest routes serve the public marks", async t => {
  const origin = await serve(t);
  const icon = await fetch(`${origin}/favicon.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type") ?? "", /image\/svg\+xml/);
  assert.match(await icon.text(), /#5555bd/);
  const logo = await fetch(`${origin}/icon.svg`);
  assert.equal(logo.status, 200);
  const manifest = await fetch(`${origin}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get("content-type") ?? "", /manifest/);
  const home = await (await fetch(`${origin}/`)).text();
  assert.match(home, /rel="icon" href="\/favicon\.svg"/);
  assert.match(home, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(home, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon-180\.png"/);
  const touch = await fetch(`${origin}/icons/apple-touch-icon-180.png`);
  assert.equal(touch.status, 200);
  assert.match(touch.headers.get("content-type") ?? "", /image\/png/);
  const offline = await fetch(`${origin}/offline.html`);
  assert.equal(offline.status, 200);
  const offlineHtml = await offline.text();
  assert.match(offlineHtml, /Room is offline/);
  // 2026-10-06: the service-worker's offline fallback was a dead end — no
  // action. It now names the check and links back to the door, with no
  // inline script (CSP-immune).
  assert.match(offlineHtml, /Check your network/);
  assert.match(offlineHtml, /<a href="\/">try the room again<\/a>/);
  assert.doesNotMatch(offlineHtml, /<script/);
  assert.equal((home.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.doesNotMatch(home, /id="message-input"[^>]*aria-expanded/);
  assert.doesNotMatch(home, /id="room-overview-open"[^>]*aria-label="Room overview"/);
});

test("browser 404 names the invite-link dead end", async t => {
  // 2026-10-06: a stranger pasting a bad invite link landed on a bare 404
  // with no hint. The page now says invite links open exactly as sent and
  // work once, and points at a fresh link.
  const origin = await serve(t);
  const res = await fetch(`${origin}/no-such-page`, { headers: { Accept: "text/html" } });
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, /<h1>Page not found<\/h1>/);
  assert.match(html, /invite links open exactly as sent and work once/i);
  assert.match(html, /<a href="\/">Home<\/a>/);
});

test("404.html and the served 404 document stay identical", async () => {
  // deploy/public-search.mjs says "404.html is the same document": the
  // edge serves the file, the node server serves the constant. A copy
  // edit to one without the other is a drift bug.
  const { PUBLIC_NOT_FOUND_HTML } = await import("../deploy/public-search.mjs");
  const { readFile } = await import("node:fs/promises");
  const file = await readFile(new URL("../404.html", import.meta.url), "utf8");
  assert.equal(file, PUBLIC_NOT_FOUND_HTML);
});
