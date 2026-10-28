// Icons and icon buttons grow with the reader's text size and keep their
// default pixel sizes at 100%.
// Real browser + local HTTP service; identities and keys are disposable fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { signInFixture } from "./auth-signin.mjs";

const ICONS = ["#sidebar-toggle", "#topbar-search-toggle", "#composer-attach", ".composer-row > button[type=submit]"];

test("Icons scale with text size and keep default sizes at 100%", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-icon-scale-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const sizes = async (width, rootPx) => {
    const page = await (await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" })).newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await signInFixture(page, owner);
    await page.locator("#main").waitFor({ state: "visible" });
    if (rootPx) { await page.evaluate(px => document.documentElement.style.setProperty("font-size", `${px}px`, "important"), rootPx); await page.waitForTimeout(100); }
    const result = await page.evaluate(selectors => Object.fromEntries(selectors.map(selector => {
      const button = document.querySelector(selector);
      const svg = button?.querySelector("svg");
      if (!button || !svg || button.getClientRects().length === 0) return [selector, null];
      const b = button.getBoundingClientRect(), s = svg.getBoundingClientRect();
      return [selector, { button: Math.round(b.width), svg: Math.round(s.width), inside: s.left >= b.left - 0.5 && s.right <= b.right + 0.5 && s.top >= b.top - 0.5 && s.bottom <= b.bottom + 0.5, tall: Math.round(b.height) }];
    })), ICONS);
    result.overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.deepEqual(errors, []);
    await page.context().close();
    return result;
  };

  for (const width of [1280, 390]) {
    const normal = await sizes(width, 0);
    const large = await sizes(width, 32);
    for (const selector of ICONS) {
      if (!normal[selector]) continue;
      assert.equal(normal[selector].svg, 20, `${selector} icon is 20px at default text size (${width}px)`);
      assert.ok(large[selector], `${selector} still shown at 200% text (${width}px)`);
      assert.equal(large[selector].svg, 40, `${selector} icon doubles at 200% text (${width}px)`);
      assert.ok(large[selector].button >= 2 * normal[selector].button - 4 || large[selector].button >= 72, `${selector} button grows with text (${width}px)`);
      assert.equal(large[selector].inside, true, `${selector} icon stays inside its button on both axes (${width}px)`);
      assert.ok(large[selector].tall >= 40, `${selector} button is tall enough for its icon (${width}px)`);
    }
    assert.equal(large.overflow, false, `no horizontal page overflow at 200% text (${width}px)`);
    assert.ok(Object.values(normal).filter(v => v && typeof v === "object").length >= 3, `most icons measured at ${width}px`);
  }
});
