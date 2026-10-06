// Q011: axe-core sweep of the message composer.
//
// Signs in and opens the composer options disclosure, then runs axe scoped
// to the composer region (#message-form and the open #composer-options).
// Scoping keeps this check's contract on the composer alone: the rest of the
// page is owned by the room-view sweep. Fails on any serious or critical
// axe violation (wcag2a/2aa/21a/21aa/22aa).
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { openComposerOptions } from "./room-chrome.mjs";
import { axeSerious, assertAxeClean, chromiumLaunchOptions } from "./a11y-axe-helper.mjs";

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

test("message composer is axe-clean (serious/critical)", { timeout: 180000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "a11y-composer-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(chromiumLaunchOptions());
  t.after(async () => {
    await browser.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    t.after(() => context.close());
    await page.goto(origin);
    await signInFixture(page, ownerKey);
    await page.locator("#message-form").waitFor({ state: "visible" });
    // Options open: the composer at its most complex (extra controls shown).
    await openComposerOptions(page);
    await page.locator("#composer-options").evaluate(node => node.open);
    assertAxeClean(
      await axeSerious(page, { include: ["#message-form", "#composer-options"] }),
      `message composer @${viewport.width}px`,
    );
  }
});
