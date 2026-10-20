// HS-1 (CRAWL-1): the /about featured-receipt card must never present a
// fabricated receipt as a real one. Three rendered states are pinned:
//   - empty store, JS on: the honest empty state — no receipt claim at all;
//   - empty store, JS off: the static card, labelled SAMPLE in the UI;
//   - populated store, JS on: the newest VERIFIED receipt is featured
//     (PROOF-WALL-FLIP's exemplar gate: a merely recorded receipt, however
//     new, never displaces a verified one on the front door).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t, { seed = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "about-receipt-honesty-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  if (seed) {
    const insert = (id, title, at, merged) => store.db.prepare(`INSERT INTO public_receipts
      (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
      VALUES (?, ?, 'work-claim', 'commons', 'commons', 'Commons', '["agent-a"]', '["human-b"]', ?, ?, '{}', ?, 'https://room.trydemigod.com/?start=room')`)
      .run(id, title, merged ? "https://github.com/Uuriko/project-room/pull/1" : null, merged ? at : null, at);
    insert(`pwr_${"a".repeat(64)}`, "Older verified work", "2026-10-01T00:00:00.000Z", true);
    insert(`pwr_${"b".repeat(64)}`, "Newer recorded work", "2026-10-05T00:00:00.000Z", false);
  }
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  return origin;
}

async function renderAbout(t, origin, { javaScriptEnabled = true } = {}) {
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => { await browser.close(); });
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage();
  await page.goto(`${origin}/about`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  return page;
}

test("about card: empty store renders the honest empty state, no fabricated receipt", { timeout: 120000 }, async t => {
  const origin = await serve(t);
  const page = await renderAbout(t, origin);
  const card = await page.locator(".receipt-card").innerText();
  assert.match(card, /No receipts yet/);
  assert.match(card, /Nothing has been published here yet/);
  assert.ok(!card.includes("zai_glm"), "the sample's author is not presented as this deployment's record");
  assert.ok(!card.includes("Docs link sweep"), "the sample's title is not presented as this deployment's record");
  assert.ok(!/real published receipt/.test(card), "no real-receipt claim in an empty store");
  assert.equal(await page.locator("#fd-receipt-cta").isVisible(), false, "no 'real receipt' call to action without a receipt");
  assert.equal(await page.locator("#fd-receipts").innerText(), "0");
});

test("about card: static (no-JS) card is labelled a sample, never a real receipt", { timeout: 120000 }, async t => {
  const origin = await serve(t);
  const page = await renderAbout(t, origin, { javaScriptEnabled: false });
  const card = await page.locator(".receipt-card").innerText();
  assert.match(card, /SAMPLE/);
  assert.match(card, /This card shows a sample receipt/);
  assert.ok(!card.includes("This card shows a real published receipt"), "the static note must not claim a real receipt");
  assert.equal(await page.locator("#fd-receipt-cta").innerText(), "See a sample receipt");
});

test("about card: populated store features the newest verified receipt, not the newest recorded one", { timeout: 120000 }, async t => {
  const origin = await serve(t, { seed: true });
  const page = await renderAbout(t, origin);
  const card = await page.locator(".receipt-card").innerText();
  assert.match(card, /Real work, real receipt/);
  // The seed's newer receipt is merely recorded (no merge, no verified
  // record); the exemplar gate features the older server-verified merge.
  assert.match(card, /Older verified work/);
  assert.ok(!card.includes("Newer recorded work"), "an unverified receipt is never the front-door exemplar");
  assert.match(card, /agent-a, human-b/);
  assert.match(card, /This card shows the newest verified published receipt, counted live\./);
  assert.ok(!card.includes("Sample"), "no sample labelling once a real receipt is shown");
  const cta = page.locator("#fd-receipt-cta");
  assert.equal(await cta.innerText(), "See a real receipt");
  assert.equal(await cta.getAttribute("href"), `/receipts/pwr_${"a".repeat(64)}`);
});
