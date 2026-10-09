// PRODUCT-200 M-10 (mobile): error and empty states on a phone.
// Every error/empty surface must be readable, plain-language, and
// thumb-friendly (44px touch floor per #2034) with a clear next action.
// These tests pin the served bytes — the strongest boundary available in
// node:test — the same idiom as the public-pages hygiene suites.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mobile-error-empty-"));
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

test("HTML 404 is a thumb-friendly page on a phone", async t => {
  const origin = await serve(t);
  const res = await fetch(`${origin}/no-such-page`, { headers: { Accept: "text/html" } });
  assert.equal(res.status, 404);
  const html = await res.text();
  // Contracts pinned by public-search-http stay intact.
  assert.match(html, /<title>Page not found<\/title>/);
  assert.match(html, /<h1>Page not found<\/h1>/);
  for (const href of ["/", "/about", "/receipts"]) {
    assert.match(html, new RegExp(`href="${href.replace("/", "\\/")}"`), `next action ${href} present`);
  }
  // Mobile contract: viewport-scaled and the next actions are thumb-sized.
  assert.match(html, /<meta name="viewport"[^>]*width=device-width/);
  assert.match(html, /min-height:\s*44px/, "44px touch floor on the 404 actions");
});

test("error toast dismiss button meets the 44px touch floor", async t => {
  const origin = await serve(t);
  const css = await (await fetch(`${origin}/src/styles.css`)).text();
  const rule = /\.status-dismiss\s*\{[^}]*\}/.exec(css);
  assert.ok(rule, ".status-dismiss rule present in served styles.css");
  assert.match(rule[0], /min-height:\s*44px/, "dismiss button is thumb-sized on mobile");
});

test("room-actions empty state names its next action", async t => {
  const origin = await serve(t);
  const html = await (await fetch(`${origin}/`)).text();
  assert.match(html, /No matching channels, tasks or actions — clear the search to see everything\./, "empty state names the next action");
});
