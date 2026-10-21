import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { openSettings, closeSettings } from "./room-chrome.mjs";
import { EVENT_TYPES } from "../src/events.js";

// Authoring gate: real-browser transport/lifecycle contract. Eager loading
// wastes entry requests; a late import after sign-out must not read room data.
// Existing board unit tests cover rendering, not either browser boundary.
// No production test hooks or API doubles.
async function setup(t) {
  const fixture = createAcceptanceFixture();
  // Landing waits for write-mode work (src/room-layout.js), so give the room one.
  fixture.store.command(fixture.keys.owner, "commons", { id: crypto.randomUUID(), type: EVENT_TYPES.WORK_PROPOSED, data: { workItemId: "lazy-boards-write", title: "Synthetic write task", definitionOfDone: "Evidence returned", accountableMemberId: "owner", mode: "write", independentVerificationRequired: false, ownerDecisionRequired: false } });
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const requests = [], errors = [];
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const enter = async () => {
    await page.goto(origin);
    await signInFixture(page, fixture.keys.owner);
    await page.locator("#main").waitFor({ state: "visible" });
  };
  return { page, requests, enter };
}

test("retired panels load no modules or endpoints and settings still closes", { timeout: 30000 }, async t => {
  const { page, requests, enter } = await setup(t);
  await enter();
  await page.locator("#message-input").fill("Keep my draft while checking settings");
  await openSettings(page, "advanced-room-tools");
  for (const id of ["land-queue-panel", "referral-panel", "bounty-panel", "retention-panel", "open-questions-panel", "room-tools", "squads-dialog"]) {
    assert.equal(await page.locator(`#${id}`).count(), 0);
  }
  await closeSettings(page);
  assert.equal(await page.locator("#message-input").inputValue(), "Keep my draft while checking settings");
  assert.equal(requests.some(path => /(?:referral-board|land-queue-board|bounty-board|squads-ui|work-recipes)\.js$|\/list_land_queue$/.test(path)), false);
});
