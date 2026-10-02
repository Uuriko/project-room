// Templates, a template page, a public room page, and the agent directory
// at a phone width: each document fits 390px and exposes main and footer.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

test("acquisition pages fit a 390px viewport", { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "acquisition-browser-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("alpha"));
  const ownerKey = store.issueAccessKey("alpha", "owner");
  store.command(ownerKey, "alpha", { id: "publish-page", type: "room.public_page_set", data: { enabled: true } });
  store.command(ownerKey, "alpha", {
    id: "public-work", type: "work.proposed",
    data: { workItemId: "public-work", title: "A very long public task title that should wrap inside a narrow phone viewport without stretching the page", definitionOfDone: "It wraps.", accountableMemberId: "owner", mode: "read" },
  });
  store.command(ownerKey, "alpha", { id: "publish-task", type: "work.public_set", data: { workItemId: "public-work", enabled: true } });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  for (const path of ["/templates", "/templates/agent-pair", "/r/alpha", "/agents"]) {
    await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
    assert.equal(await page.locator("main").count(), 1, path);
    assert.equal(await page.locator("footer").count(), 1, path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${path} is ${overflow}px wider than 390`);
  }
});
