// Q011: axe-core sweep of the signed-in room view.
//
// The main room UI after authentication: message list (seeded with one
// message so list markup is exercised), member chrome, and dialogs closed.
// Both viewports. Fails on any serious or critical axe violation
// (wcag2a/2aa/21a/21aa/22aa).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { axeSerious, assertAxeClean, chromiumLaunchOptions } from "./a11y-axe-helper.mjs";

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

test("signed-in room view is axe-clean (serious/critical)", { timeout: 180000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "a11y-room-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  // One member and one chat message so the message-list markup (not just the
  // empty-state chrome) is part of the sweep.
  store.command(ownerKey, "commons", {
    id: crypto.randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "maya", displayName: "Maya", kind: "human", permissions: ["accept_work", "complete_work"] },
  });
  store.command(ownerKey, "commons", {
    id: crypto.randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: "a11y-seed-message", body: "Seed message so the room view sweep covers message list markup." },
  });
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
    await page.locator("#main").waitFor({ state: "visible" });
    await page.locator("[data-message-id]").first().waitFor({ state: "visible" });
    assertAxeClean(await axeSerious(page), `signed-in room view @${viewport.width}px`);
    // Reveal the narrow sidebar and participant disclosure before auditing
    // button names. Invitation actions are directly available in the sidebar.
    if (viewport.width < 700 && !await page.locator("#main").evaluate(node => node.classList.contains("sidebar-open"))) {
      await page.locator("#sidebar-toggle").click();
      await page.locator("#room-sidebar").waitFor({ state: "visible" });
    }
    for (const selector of ["#people-panel"]) {
      const panel = page.locator(selector);
      if (!await panel.evaluate(node => node.open)) await page.locator(`${selector} > summary`).click();
    }
    assertAxeClean(await axeSerious(page, { rules: ["button-name"] }), `signed-in room sidebar controls @${viewport.width}px`);
    // The row name is rendered, not just composed in a helper.
    assert.equal(
      await page.getByRole("group", { name: /^Maya, human, / }).count(), 1,
      "the member row is addressable by name, kind and status",
    );
  }
});
