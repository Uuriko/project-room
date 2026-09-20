// Simulated human journey against disposable first-party data, not human research.
// Issue #6 C3: the room owner sets a spend allowance from the "Agent spend" card; every
// member sees allowance, spent, reserved and headroom move as a session reserves, reports
// and stops; only the owner has the controls; removing the allowance restores the default.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { spendAllowance } from "../src/events.js";
import { fillAccessKey } from "./auth-signin.mjs";
import { openSettings } from "./room-chrome.mjs";

async function setup(t, actor, viewport = { width: 1440, height: 1000 }) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" }), errors = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await fillAccessKey(page, f.keys[actor]);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  await openSettings(page, "spend-panel");
  const state = () => f.store.room("commons").state;
  const session = body => f.store.mutateWorkSession(f.keys.producer, "commons", { requestId: randomUUID(), workItemId: "test-handoff",
    expectedRevision: state().workItems["test-handoff"].revision, action: "set_status", ...body });
  const summaryIs = text => page.waitForFunction(expected => document.querySelector("#spend-summary").textContent === expected, text);
  return { ...f, page, state, session, summaryIs, summary: page.locator("#spend-summary"), figures: page.locator("#spend-figures"), form: page.locator("#spend-allowance-form") };
}

test("spend allowance: the owner sets it, the card follows the ledger as a session reserves, reports and stops, and removing it restores the default", { timeout: 60000 }, async t => {
  const f = await setup(t, "owner"), { page } = f;
  assert.equal(await f.summary.textContent(), "No allowance");
  assert.match(await f.figures.textContent(), /^\$0\.00 spent · \$0\.00 reserved by 0 live sessions over 30 days\. Set an allowance to cap what agent sessions may commit here\.$/);
  assert.equal(await f.form.isVisible(), true, "the owner has the controls");
  assert.equal(await page.locator("#spend-allowance-remove").isHidden(), true, "nothing to remove yet");
  // A bad entry never leaves the form: the field is invalid and nothing is recorded.
  await page.locator("#spend-allowance-input").fill("-1");
  await page.locator('#spend-allowance-form button[type="submit"]').click();
  assert.equal(await page.locator("#spend-allowance-input").evaluate(el => el.validity.valid), false);
  assert.equal(spendAllowance(f.state()), null);
  // $50.00 over 30 days.
  await page.locator("#spend-allowance-input").fill("50");
  await page.locator("#spend-period-input").fill("30");
  // A service refusal stays in the form and leaves the allowance unchanged.
  await page.route("**/commands", route => route.fulfill({ status: 503, contentType: "application/json",
    body: JSON.stringify({ error: { code: "unavailable", message: "Synthetic service refusal" } }) }));
  await page.locator('#spend-allowance-form button[type="submit"]').click();
  await page.locator("#spend-error").waitFor({ state: "visible" });
  assert.match(await page.locator("#spend-error").textContent(), /Allowance not saved/);
  assert.equal(spendAllowance(f.state()), null);
  await page.unroute("**/commands");
  await page.locator('#spend-allowance-form button[type="submit"]').click();
  await f.summaryIs("$0.00 of $50.00");
  assert.deepEqual([spendAllowance(f.state()).allowanceCents, spendAllowance(f.state()).periodDays, spendAllowance(f.state()).setById], [5000, 30, "owner"]);
  assert.match(await f.figures.textContent(), /\$50\.00 left over 30 days\.$/);
  assert.match(await page.locator("#spend-note").textContent(), /^Sessions must declare their maximum spend to start/);
  assert.equal(await page.locator("#spend-allowance-remove").isVisible(), true);
  assert.equal(await page.locator("#spend-panel").getAttribute("data-spend-allowance"), "set");
  // A producer session that declares no spend cap cannot start; one that declares $20.00 reserves it.
  assert.throws(() => f.session({ status: "processing" }), { code: "spend_allowance_budget_required" });
  f.session({ status: "processing", budget: { maxSpendCents: 2000 } });
  await f.summaryIs("$20.00 of $50.00");
  assert.match(await f.figures.textContent(), /^\$0\.00 spent · \$20\.00 reserved by 1 live session · \$30\.00 left over 30 days\.$/);
  // A report within the reservation moves spend from reserved to spent; the stop below the cap frees the rest.
  f.session({ status: "active", spendCents: 500 });
  await page.waitForFunction(() => /\$5\.00 spent · \$15\.00 reserved/.test(document.querySelector("#spend-figures").textContent));
  // The Usage card carries the same ledger, so a member reads allowance, spent, reserved and headroom beside usage.
  await page.locator("#usage-panel").evaluate(el => { el.open = true; });
  await page.locator('#usage-grid [data-usage-allowance="set"]').waitFor();
  assert.match(await page.locator("#usage-grid dl").nth(2).textContent(), /^Allowance\$50\.00over 30 daysSpent\$5\.00Reserved\$15\.001 liveHeadroom\$30\.00$/);
  f.session({ status: "done", spendCents: 800 });
  await f.summaryIs("$8.00 of $50.00");
  assert.match(await f.figures.textContent(), /^\$8\.00 spent · \$0\.00 reserved by 0 live sessions · \$42\.00 left over 30 days\.$/);
  // Lowering the allowance below what is committed reads as over, honestly.
  await page.locator("#spend-allowance-input").fill("5");
  await page.locator('#spend-allowance-form button[type="submit"]').click();
  await f.summaryIs("$8.00 of $5.00");
  assert.equal(await page.locator("#spend-panel").getAttribute("data-spend-allowance"), "over");
  assert.match(await f.figures.textContent(), /over by \$3\.00 over 30 days\.$/);
  assert.throws(() => f.session({ status: "processing", budget: { maxSpendCents: 1 } }), { code: "spend_allowance_exceeded" });
  // Remove: the default returns and the figures stay visible.
  await page.locator("#spend-allowance-remove").click();
  await f.summaryIs("No allowance");
  assert.equal(spendAllowance(f.state()), null); assert.equal(f.state().room.spendAllowance.revision, 3);
  assert.match(await f.figures.textContent(), /^\$8\.00 spent · \$0\.00 reserved by 0 live sessions over 30 days\. Set an allowance/);
  assert.equal(await page.locator("#spend-allowance-remove").isHidden(), true);
  f.session({ status: "processing" }); // no allowance: an undeclared start works as before
});

test("spend allowance mobile: a non-owner sees the figures and never the controls", { timeout: 60000 }, async t => {
  const f = await setup(t, "guest", { width: 390, height: 844 }), { page } = f;
  assert.equal(await f.form.isHidden(), true, "no controls for a member who is not the owner");
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "room.spend_allowance_set", data: { allowanceCents: 5000, periodDays: 7 } });
  await f.summaryIs("$0.00 of $50.00");
  f.session({ status: "processing", budget: { maxSpendCents: 2000 } });
  await f.summaryIs("$20.00 of $50.00");
  assert.match(await f.figures.textContent(), /\$20\.00 reserved by 1 live session · \$30\.00 left over 7 days\.$/);
  assert.equal(await f.form.isHidden(), true);
  assert.match(await page.locator("#spend-note").textContent(), /Only the room owner can change this\.$/);
  const box = await page.locator("#room-health").boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390, "the card fits the phone width");
});
