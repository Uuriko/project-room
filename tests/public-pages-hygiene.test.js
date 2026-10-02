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

test("GET /receipts publishes canonical metadata and labels the snapshot historical", async t => {
  const origin = await serve(t);
  const response = await fetch(`${origin}/receipts`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /rel="canonical" href="https:\/\/room\.trydemigod\.com\/receipts"/);
  assert.match(html, /name="description" content="[^"]+"/);
  assert.match(html, /property="og:title" content="Project Room — run receipts"/);
  assert.match(html, /property="og:description" content="[^"]+"/);
  assert.match(html, /Historical snapshot/);
  assert.match(html, /overflow-x:\s*auto/);
});

test("sitemap lists indexable doors and omits compare pages that have no file", async t => {
  const origin = await serve(t);
  const xml = await (await fetch(`${origin}/sitemap.xml`)).text();
  assert.match(xml, /<loc>https:\/\/room\.trydemigod\.com\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/room\.trydemigod\.com\/offers<\/loc>/);
  assert.match(xml, /<loc>https:\/\/room\.trydemigod\.com\/about<\/loc>/);
  assert.doesNotMatch(xml, /\/compare\//);
  const missing = await fetch(`${origin}/compare/project-room-vs-slack`);
  assert.equal(missing.status, 404);
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
  assert.equal((home.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.doesNotMatch(home, /id="message-input"[^>]*aria-expanded/);
  assert.doesNotMatch(home, /id="room-overview-open"[^>]*aria-label="Room overview"/);
});
