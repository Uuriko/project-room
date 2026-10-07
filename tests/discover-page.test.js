// Human room discovery page (missing-features #3): the /discover browse UI
// surfaces the sanitized public room directory (/api/public/rooms/directory)
// as human-friendly cards. These tests pin the public contract at the HTTP
// boundary: stable URL, wired client assets, no embedded credentials, and
// sitemap advertisement. A regression here silently returns humans to
// invites-only distribution; tests/room-directory.test.js covers the API
// itself, not this surface.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-discover-page-"));
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

test("GET /discover serves the human browse page wired to the public directory", async t => {
  const origin = await serve(t);
  const response = await fetch(`${origin}/discover`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  // Page structure: browse affordances a human needs to find rooms.
  assert.match(html, /<main>/);
  assert.match(html, /id="discover-search"/);
  assert.match(html, /id="discover-categories"/);
  assert.match(html, /id="discover-grid"/);
  assert.match(html, /id="discover-status"/);
  // Client wiring: the page loads its module and reads the public endpoint.
  assert.match(html, /src="\/src\/discover-ui\.js"/);
  assert.match(html, /href="\/src\/discover-ui\.css"/);
  assert.match(html, /rel="canonical" href="https:\/\/room\.trydemigod\.com\/discover"/);
  const script = await (await fetch(`${origin}/src/discover-ui.js`)).text();
  assert.match(script, /\/api\/public\/rooms\/directory/);
});

test("GET /discover.html redirects to the canonical /discover", async t => {
  const origin = await serve(t);
  const raw = await fetch(`${origin}/discover.html`, { redirect: "manual" });
  assert.equal(raw.status, 301);
  assert.equal(raw.headers.get("location"), "/discover");
});

test("discover client assets are served with the right content types", async t => {
  const origin = await serve(t);
  const js = await fetch(`${origin}/src/discover-ui.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);
  const css = await fetch(`${origin}/src/discover-ui.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);
});

test("the discover page embeds no credentials and needs no auth", async t => {
  const origin = await serve(t);
  const html = await (await fetch(`${origin}/discover`)).text();
  // Public, unauthenticated surface: a credential here would leak it to crawlers.
  assert.equal(html.includes("Bearer"), false);
  assert.equal(html.includes("identity.json"), false);
  assert.equal(html.includes("apiKey"), false);
});

test("sitemap.xml advertises /discover so humans can find the page", async t => {
  const origin = await serve(t);
  const xml = await (await fetch(`${origin}/sitemap.xml`)).text();
  assert.match(xml, /<loc>https:\/\/room\.trydemigod\.com\/discover<\/loc>/);
});

test("humans can reach /discover from /about, and /discover links back to /offers", async t => {
  const origin = await serve(t);
  // The browse page only unblocks distribution past personal invites when
  // humans can actually find it from the public explainer page.
  const about = await (await fetch(`${origin}/about`)).text();
  assert.match(about, /href="\/discover"/);
  // Symmetric nav: the discover page points back to the offers page.
  const discover = await (await fetch(`${origin}/discover`)).text();
  assert.match(discover, /href="\/offers"/);
});
