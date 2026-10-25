// A server started without githubAuth strips #github-signin from the front
// door. Signing in must still open the room. Before the navigation guard,
// the missing anchor threw, entry.js caught it, and #main stayed hidden
// behind "The room could not load".
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";

test("signing in without GitHub OAuth opens the room", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => {
    await browser.close();
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });

  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#github-signin").count(), 0, "an unconfigured server does not ship the GitHub anchor");
  await page.waitForFunction(() => {
    const divider = document.querySelector(".signin-divider");
    return divider && getComputedStyle(divider).display === "none";
  });
  assert.equal(await page.locator(".signin-divider").isVisible(), false, "the divider is not rendered when the provider anchor is stripped");
  const signedOut = await page.locator("#auth-error").innerText();
  assert.equal(signedOut.includes("could not load"), false, signedOut);
  try {
    await signInFixture(page, f.keys.owner);
  } catch (error) {
    const banner = await page.locator("#auth-error").innerText().catch(() => "");
    throw new Error(`${error.message}\n${banner}\n${errors.join("\n")}`);
  }
  assert.equal(await page.locator("#main").isVisible(), true);
  assert.equal((await page.locator("#auth-error").innerText()).includes("could not load"), false);
  assert.deepEqual(errors, []);
});
