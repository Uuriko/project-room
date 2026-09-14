// Simulated human journey against disposable first-party data, not human research.
// Issue #6 A4: when the room owner makes review or approval mandatory, the new-work
// form shows the requirement locked on with the reason, and the recorded item carries it.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
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
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await page.locator("#access-key").fill(f.keys.owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type, data });
  const items = () => f.store.room("commons").state.workItems;
  const openForm = async () => { await page.locator("#new-work-button").click(); await page.locator("#new-work-form").waitFor({ state: "visible" }); await page.locator("#work-options").evaluate(el => { el.open = true; }); };
  return { ...f, page, send, items, openForm, review: page.locator("#require-verification"), decision: page.locator("#require-decision"), note: page.locator("#work-policy-note") };
}

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`room policy ${label}: mandatory review locks the form honestly, records the requirement, and off restores the proposer's choice`, { timeout: 60000 }, async t => {
    const f = await setup(t, viewport), { page } = f;
    await f.openForm();
    // Policy off (the default): the proposer chooses, nothing is locked and no reason is shown.
    assert.equal(await f.review.isDisabled(), false); assert.equal(await f.decision.isDisabled(), false); assert.equal(await f.note.isHidden(), true);
    await f.review.uncheck(); assert.equal(await f.review.isChecked(), false);
    // The owner flips the policy while the form is open: the live view locks both requirements on and says why.
    f.send(T.ROOM_POLICY_SET, { requireIndependentReview: true, requireOwnerDecision: true });
    await page.waitForFunction(() => document.querySelector("#require-verification").disabled);
    for (const box of [f.review, f.decision]) { assert.equal(await box.isChecked(), true); assert.equal(await box.isDisabled(), true); }
    await f.note.waitFor({ state: "visible" });
    assert.match(await f.note.textContent(), /^Room policy: independent review and owner approval are required for every new outcome in this room\. Only the room owner can change this\.$/);
    assert.equal(await page.locator("#work-options-summary").textContent(), "Review + approval · read only");
    assert.equal(await page.locator("#verifier-field").isVisible(), true, "a reviewer must be named when review is mandatory");
    assert.match(await page.locator("#reviewer-unavailable-text").textContent(), /Room policy requires review/);
    assert.equal(await page.locator("#review-settings-button").isHidden(), true, "no shortcut to a setting the proposer cannot change");
    // Reset (e.g. reopening the form) cannot clear a mandatory requirement.
    await page.locator("#cancel-work-button").click(); await page.locator("#new-work-form").waitFor({ state: "hidden" });
    await f.openForm();
    for (const box of [f.review, f.decision]) { assert.equal(await box.isChecked(), true); assert.equal(await box.isDisabled(), true); }
    await page.locator("#work-title-input").fill("Agenda reviewed under policy");
    await page.locator("#work-done-input").fill("Reviewer confirms the agenda; owner approves.");
    await page.locator("#assignee-select").selectOption("producer"); await page.locator("#verifier-select").selectOption("reviewer");
    await page.locator('#new-work-form button[type="submit"]').click();
    await page.locator("#new-work-form").waitFor({ state: "hidden" });
    const recorded = Object.values(f.items()).find(item => item.title === "Agenda reviewed under policy");
    assert.equal(recorded.independentVerificationRequired, true); assert.equal(recorded.ownerDecisionRequired, true);
    assert.equal(recorded.verifierMemberId, "reviewer"); assert.equal(recorded.humanDecisionMakerId, "owner");
    // Only review mandatory: approval is the proposer's choice again and the reason names review alone.
    f.send(T.ROOM_POLICY_SET, { requireIndependentReview: true, requireOwnerDecision: false });
    await page.waitForFunction(() => !document.querySelector("#require-decision").disabled);
    await f.openForm();
    assert.equal(await f.review.isDisabled(), true); assert.equal(await f.decision.isDisabled(), false);
    assert.match(await f.note.textContent(), /^Room policy: independent review is required/);
    await page.locator("#cancel-work-button").click(); await page.locator("#new-work-form").waitFor({ state: "hidden" });
    // Policy off again: the existing behaviour returns, and the item recorded under policy keeps its requirements.
    f.send(T.ROOM_POLICY_SET, { requireIndependentReview: false, requireOwnerDecision: false });
    await page.waitForFunction(() => !document.querySelector("#require-verification").disabled);
    await f.openForm();
    assert.equal(await f.review.isDisabled(), false); assert.equal(await f.decision.isDisabled(), false); assert.equal(await f.note.isHidden(), true);
    await f.review.uncheck(); assert.equal(await f.review.isChecked(), false);
    assert.equal(f.items()[recorded.id].independentVerificationRequired, true);
  });
}
