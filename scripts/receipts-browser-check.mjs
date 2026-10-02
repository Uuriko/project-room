// /receipts/<id> at a phone width: the document fits the viewport and exposes
// main and footer landmarks.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { collectPublicReceipts } from "../server/receipts-live.mjs";

test("a public receipt fits a 390px viewport", { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "receipts-browser-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "publish", type: "room.public_receipts_set", data: { enabled: true } });
  store.workClaims.set("commons", {
    id: "claim-1", title: "A very long receipt title that should wrap inside a narrow phone viewport without stretching the page",
    state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", at: "2026-10-01T12:00:00.000Z" }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/9", outcome: "merged", syncedAt: "2026-10-01T12:00:00.000Z" },
    blobs: [`sha256:${"ab".repeat(32)}`], updatedAt: "2026-10-01T12:00:00.000Z",
  });
  const receipt = collectPublicReceipts(store).find(item => item.title.startsWith("A very long"));
  assert.ok(receipt);
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
  await page.goto(`${origin}/receipts/${receipt.id}`, { waitUntil: "domcontentloaded" });
  assert.equal(await page.locator("main").count(), 1);
  assert.equal(await page.locator("footer").count(), 1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `page is ${overflow}px wider than 390`);
});
