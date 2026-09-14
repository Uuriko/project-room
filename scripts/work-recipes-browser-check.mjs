// Simulated human journeys against disposable first-party data, not human research.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function setup(t, viewport = { width: 1440, height: 1000 }) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" }), errors = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await page.locator("#access-key").fill(f.keys.owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  const snapshot = () => f.store.snapshot(f.keys.owner, "commons");
  const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type, data });
  return { ...f, page, errors, snapshot, send };
}

function seedRecipes(f) {
  const propose = (workItemId, title, definitionOfDone) => f.send(T.WORK_PROPOSED, {
    workItemId, title, definitionOfDone, accountableMemberId: "owner", mode: "read",
    independentVerificationRequired: false, ownerDecisionRequired: false,
  });
  propose("recipe-older", "Weekly source review", "Sources checked and owner named.");
  propose("recipe-newer", "Provider digest", "Digest posted with three cited items.");
  propose("recipe-duplicate", "Weekly source review", "Sources checked and owner named.");
}

test("recipes desktop: distinct recent definitions prefill a fresh outcome, never mutate state", { timeout: 60000 }, async t => {
  const f = await setup(t), { page } = f;
  seedRecipes(f);
  await page.locator('[data-work-record-id="recipe-duplicate"]').waitFor();
  const before = f.snapshot();
  await page.locator("#new-work-button").click();
  await page.locator("#new-work-form").waitFor({ state: "visible" });
  const field = page.locator("#work-recipe-field"), select = page.locator("#work-recipe-select");
  assert.equal(await field.isVisible(), true);
  const options = await select.locator("option").evaluateAll(nodes => nodes.map(n => ({ value: n.value, label: n.textContent })));
  assert.equal(options[0].value, ""); assert.equal(options[0].label, "Blank outcome");
  assert.equal(options.length, 4, "blank plus three distinct recorded definitions");
  assert.equal(options[1].value, "recipe-duplicate", "the most recently recorded occurrence stands for a repeated definition");
  assert.equal(options[2].value, "recipe-newer");
  assert.deepEqual(options.map(o => o.label).sort(), ["Blank outcome", "Provider digest", "Test: prepare an agenda", "Weekly source review"].sort());
  assert.equal(await page.locator("#work-title-input").inputValue(), "");
  // Picking a recipe copies only its definition into the editable fields.
  await select.selectOption("recipe-duplicate");
  assert.equal(await page.locator("#work-title-input").inputValue(), "Weekly source review");
  assert.equal(await page.locator("#work-done-input").inputValue(), "Sources checked and owner named.");
  await page.locator("#work-title-input").fill("Weekly source review, extended");
  await select.selectOption("recipe-newer");
  assert.equal(await page.locator("#work-title-input").inputValue(), "Provider digest");
  await select.selectOption("");
  assert.equal(await page.locator("#work-title-input").inputValue(), ""); assert.equal(await page.locator("#work-done-input").inputValue(), "");
  assert.deepEqual(f.snapshot(), before, "browsing recipes is not a mutation or read acknowledgement");
  // Submit from a recipe: one new work item with the copied definition; sources untouched.
  await select.selectOption("recipe-newer");
  await page.locator("#assignee-select").selectOption("producer"); await page.locator("#verifier-select").selectOption("reviewer");
  await page.locator('#new-work-form button[type="submit"]').click();
  await page.locator("#new-work-form").waitFor({ state: "hidden" });
  const after = f.snapshot(), fresh = Object.values(after.state.workItems).find(work => !Object.hasOwn(before.state.workItems, work.id));
  assert.equal(fresh.title, "Provider digest"); assert.equal(fresh.definitionOfDone, "Digest posted with three cited items.");
  assert.equal(fresh.state, "proposed"); assert.equal(fresh.revision, 0);
  for (const key of ["sourceMessageId", "claim", "receipt", "verification", "decision", "blocker"]) assert.equal(fresh[key], null);
  assert.deepEqual(after.state.workItems["recipe-newer"], before.state.workItems["recipe-newer"]);
  // The new item joins the recipe list on the next blank open.
  await page.locator("#new-work-button").click();
  await page.locator("#new-work-form").waitFor({ state: "visible" });
  const reopened = await select.locator("option").evaluateAll(nodes => nodes.map(n => n.value));
  assert.equal(reopened.includes(fresh.id), true);
  assert.equal(reopened.includes("recipe-newer"), false, "identical definitions stay collapsed behind the newest occurrence");
  await page.keyboard.press("Escape"); await page.locator("#new-work-form").waitFor({ state: "hidden" });
  // A reuse open keeps its own prefilled definition and hides the picker.
  const card = page.locator('[data-work-record-id="recipe-older"]');
  if (!await card.locator(".work-details").evaluate(node => node.open)) await card.locator(".work-details > summary").click();
  await card.locator("[data-reuse-work]").click();
  await page.locator("#new-work-form").waitFor({ state: "visible" });
  assert.equal(await field.isVisible(), false);
  assert.equal(await page.locator("#work-title-input").inputValue(), "Weekly source review");
  await page.keyboard.press("Escape"); await page.locator("#new-work-form").waitFor({ state: "hidden" });
  mkdirSync("test-results", { recursive: true });
  await page.locator("#new-work-button").click(); await page.locator("#new-work-form").waitFor({ state: "visible" });
  await select.selectOption("recipe-duplicate");
  await page.screenshot({ path: "test-results/recipes-desktop.png", fullPage: true });
  assert.deepEqual(f.errors, []);
});

test("recipes mobile: picker stays inside the dialog without horizontal overflow", { timeout: 60000 }, async t => {
  const f = await setup(t, { width: 390, height: 844 }), { page } = f;
  seedRecipes(f);
  await page.locator('[data-work-record-id="recipe-duplicate"]').waitFor();
  await page.locator("#new-work-button").click();
  await page.locator("#new-work-form").waitFor({ state: "visible" });
  assert.equal(await page.locator("#work-recipe-field").isVisible(), true);
  await page.locator("#work-recipe-select").selectOption("recipe-newer");
  assert.equal(await page.locator("#work-title-input").inputValue(), "Provider digest");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.equal(await page.locator("#work-dialog").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  await page.keyboard.press("Escape");
  assert.deepEqual(f.errors, []);
});
