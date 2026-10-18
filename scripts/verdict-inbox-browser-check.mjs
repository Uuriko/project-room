// COMP-DEEP #1 (CD-01) — verdict inbox browser check.
//
// The account home is the post-login landing a reviewer already visits;
// this check signs in through the standard fixture, serves Lane C's
// verdict-inbox read (Contract V) by intercepting the one declared path
// with a contract-shaped fixture (the server read is Lane C's PR; the
// human surface must render the contract exactly), and asserts:
//   - the inbox section appears on the account home, badge = API total
//   - the four sections render in server order, rows show why + when
//   - a per-type filter narrows visibility without refetching counts
//   - the follow block renders in the same neighbourhood
//   - rows are keyboard-operable native links; the section is axe-clean
// Follows scripts/account-workspace-check.mjs (fixture + sign-in) and
// scripts/a11y-axe-helper.mjs (one axe configuration for every check).
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { clickChrome } from "./room-chrome.mjs";
import { axeSerious, assertAxeClean, chromiumLaunchOptions } from "./a11y-axe-helper.mjs";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const row = (claimId, roomId, reason, waitingSeconds, extra = {}) => ({
  claimId, roomId, title: `Deliverable ${claimId}`, reason,
  since: new Date(NOW - waitingSeconds * 1000).toISOString(), waitingSeconds, ...extra,
});

const FIXTURE = {
  sections: {
    needsYourVerdict: [row("claim-1", "commons", "Delivery awaiting your verdict", 3 * 3600)],
    returnedToYou: [row("claim-2", "commons", "Revision requested — sent back to you", 600)],
    waitingOnWorker: [row("claim-3", "commons", "You requested a revision", 26 * 3600)],
    recentlyDecided: [row("claim-4", "commons", "You accepted this delivery", 1200)],
  },
  totals: { needsYourVerdict: 2, returnedToYou: 1, waitingOnWorker: 1, recentlyDecided: 1, followedChanges: 1, mentions: 1 },
  // Lane C's shipped shape (PR #4022): a followed-claim row whose
  // mentionCount is positive is the mention; there is no mention row type.
  following: [{ claimId: "claim-5", roomId: "commons", policy: "follow", unreadCount: 1, mentionCount: 1, type: "followed-claim" }],
};

test("verdict inbox on the account home: sections, badge, filters, a11y", { timeout: 120000 }, async t => {
  const f = createAcceptanceFixture();
  const accountId = "verdict-owner";
  f.store.createAccount(accountId);
  f.store.completeOnboarding(accountId);
  const key = f.store.issueAccountAccessKey(accountId);
  const server = createRoomServer({ store: f.store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(chromiumLaunchOptions());
  t.after(async () => {
    await browser.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  let verdictFetches = 0;
  await context.route("**/api/verdict-inbox*", route => {
    verdictFetches++;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(FIXTURE) });
  });
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  await page.goto(`${origin}/?account=1`);
  await signInFixture(page, key);
  await page.locator("#inbox-panel").waitFor();
  await clickChrome(page, "#nav-rooms");
  await page.locator("#account-rooms-panel").waitFor({ state: "visible" });

  // The section, its badge (the API total verbatim — 2, although one row
  // is served), and the four sections in the server's order.
  const inbox = page.locator("#verdict-inbox");
  await inbox.waitFor({ state: "visible" });
  assert.equal(await page.locator("#verdict-inbox-badge").textContent(), "2");
  const order = await inbox.locator(".verdict-section").evaluateAll(elements =>
    elements.map(element => element.getAttribute("data-verdict-section")));
  assert.deepEqual(order, ["needsYourVerdict", "returnedToYou", "waitingOnWorker", "recentlyDecided", "following"]);
  const firstRow = inbox.locator('[data-verdict-section="needsYourVerdict"] .verdict-row').first();
  await firstRow.getByText("Delivery awaiting your verdict").waitFor();
  await firstRow.getByText(/waiting 3h/).waitFor();
  await inbox.getByText("You were mentioned").waitFor();

  // Per-type filter: visibility only — one fetch so far, counts unchanged.
  await inbox.locator('[data-verdict-filter="waiting"]').click();
  await inbox.locator('[data-verdict-section="waitingOnWorker"]').waitFor({ state: "visible" });
  assert.equal(await inbox.locator('[data-verdict-section="needsYourVerdict"]').count(), 0);
  assert.equal(await page.locator("#verdict-inbox-badge").textContent(), "2");
  assert.equal(verdictFetches, 1);
  await inbox.locator('[data-verdict-filter="all"]').click();
  await inbox.locator('[data-verdict-section="needsYourVerdict"]').waitFor({ state: "visible" });

  // Keyboard: the row link is a native anchor — focusable and operable.
  const link = inbox.locator('[data-verdict-section="needsYourVerdict"] .verdict-row a').first();
  await link.focus();
  assert.equal(await link.evaluate(element => document.activeElement === element && element.tabIndex === 0), true);
  assert.match((await link.getAttribute("href")) ?? "", /\.\/\?room=commons#pr-record\/work\/claim-1/);

  assertAxeClean(await axeSerious(page, { include: ["#verdict-inbox"] }), "verdict inbox");
  assert.deepEqual(errors, []);
});
