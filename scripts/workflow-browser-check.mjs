// Disposable local participants only; no external runtime or evidence is fetched.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`workflow ${label}: lighter checks, exact retries, truthful status and later findings`, { timeout: 90000 }, async t => {
    const fixture = createAcceptanceFixture();
    fixture.store.command(fixture.keys.owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId: "human-reviewer", displayName: "Test human reviewer", kind: "human", permissions: ["verify"] } });
    const reviewerKey = fixture.store.issueAccessKey("commons", "human-reviewer");
    const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    t.after(async () => {
      await browser?.close();
      server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
    });
    browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const login = async (page, key) => {
      await page.goto(origin);
      await page.locator("#access-key").fill(key);
      await page.getByRole("button", { name: "Enter room", exact: true }).click();
      await page.locator("#main").waitFor({ state: "visible" });
    };
    await login(page, fixture.keys.owner);
    const form = page.locator("#new-work-form"), review = page.locator("#require-verification"), decision = page.locator("#require-decision");
    const capture = async name => {
      mkdirSync("test-results", { recursive: true });
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.screenshot({ path: `test-results/workflow-${label}-${name}.png`, fullPage: true });
      if (await form.isVisible()) await form.screenshot({ path: `test-results/workflow-${label}-${name}-detail.png` });
    };
    const agent = role => new RoomAgentClient({ origin, roomId: "commons", token: role === "reviewer" ? reviewerKey : fixture.keys[role] });
    const items = () => fixture.store.snapshot(fixture.keys.owner, "commons").state.workItems;
    let reviewedId;
    for (const [needsReview, needsDecision] of [[false, false], [true, false], [false, true], [true, true]]) {
      const title = `Finding — review ${needsReview}, decision ${needsDecision}`;
      await page.locator("#new-work-button").click();
      await page.locator("#work-options > summary").click();
      assert.equal(await review.isChecked(), true, "every new proposal starts with full checks");
      assert.equal(await decision.isChecked(), true);
      await page.locator("#work-title-input").fill(title);
      await page.locator("#work-done-input").fill("A source-linked finding with an exact version.");
      await page.locator("#assignee-select").selectOption("producer");
      await review.setChecked(needsReview); await decision.setChecked(needsDecision);
      assert.equal(await page.locator("#verifier-field").isVisible(), needsReview);
      assert.equal(await page.locator("#verifier-select").isDisabled(), !needsReview);
      if (needsReview) await page.locator("#verifier-select").selectOption("human-reviewer");
      if (!needsReview && !needsDecision) {
        // Keyboard choice, not just programmatic checkbox state.
        await review.focus(); await page.keyboard.press("Space");
        assert.equal(await review.isChecked(), true);
        await page.keyboard.press("Space");
        assert.equal(await review.isChecked(), false);
        await capture("small-proposal");
        const attempts = []; let loseResponse = true;
        await page.route("**/api/rooms/commons/commands", async route => {
          attempts.push(route.request().postDataJSON());
          if (loseResponse) { loseResponse = false; await route.fetch(); await route.abort("failed"); }
          else await route.continue();
        });
        await form.locator('button[type="submit"]').click();
        await page.locator("#new-work-status").waitFor({ state: "visible" });
        assert.equal(await review.isChecked(), false);
        assert.equal(await decision.isChecked(), false);
        assert.equal(await page.locator("#verifier-select").isDisabled(), true);
        assert.equal(await page.locator("#work-title-input").inputValue(), title);
        await form.locator('button[type="submit"]').click();
        await form.waitFor({ state: "hidden" });
        await page.unroute("**/api/rooms/commons/commands");
        assert.equal(attempts.length, 2);
        assert.deepEqual(attempts[0], attempts[1], "lost-response retry preserves the exact command and checks");
      } else {
        await form.locator('button[type="submit"]').click();
        await form.waitFor({ state: "hidden" });
      }
      const matches = Object.values(items()).filter(item => item.title === title);
      assert.equal(matches.length, 1);
      const id = matches[0].id, item = () => items()[id];
      assert.equal(item().independentVerificationRequired, needsReview);
      assert.equal(item().ownerDecisionRequired, needsDecision);
      assert.equal(item().verifierMemberId, needsReview ? "human-reviewer" : null);
      assert.equal(item().humanDecisionMakerId, needsDecision ? "owner" : null);
      const mutate = (role, type, data = {}) => agent(role).command({ id: crypto.randomUUID(), type, data: { workItemId: id, expectedRevision: item().revision, ...data } });
      await mutate("producer", T.WORK_ACCEPTED);
      await mutate("producer", T.WORK_COMPLETED, { summary: "The source supports this small finding.", evidenceUrl: "https://example.invalid/finding", evidenceVersion: "v1", producerId: "producer", nextAction: "Use the finding or review it as requested." });
      const card = page.locator(`[data-work-record-id="${id}"]`);
      const status = async (step, text, tone) => {
        await card.locator(`[data-next-step="${step}"]`).waitFor();
        assert.equal(await card.locator(".state").textContent(), text);
        assert.equal(await card.locator(".state").getAttribute("class"), `state state-${tone}`);
        assert.equal((await agent("owner").orient()).work.find(work => work.id === id).next.action, step);
      };
      await status(needsReview ? "verify" : needsDecision ? "decide" : "complete", needsReview ? "Awaiting verification" : needsDecision ? "Awaiting decision" : "Completed", needsReview || needsDecision ? "pending" : "completed");
      const evidence = () => ({ completionEventId: item().receipt.eventId, evidenceVersion: item().receipt.evidenceVersion });
      if (needsReview) {
        await mutate("reviewer", T.VERIFICATION_RECORDED, { ...evidence(), result: "pass", summary: "Checked this exact finding." });
        await status(needsDecision ? "decide" : "complete", needsDecision ? "Awaiting decision" : "Completed", needsDecision ? "pending" : "completed");
      }
      if (needsDecision) {
        await card.locator('[data-action="decide"]').click();
        await page.locator('#action-fields select[name="decision"]').selectOption("approved");
        await page.locator('#action-fields textarea[name="reason"]').fill("Accept this version.");
        await page.locator('#action-form button[type="submit"]').click();
        await page.locator("#action-dialog").waitFor({ state: "hidden" });
      }
      await status("complete", "Completed", "completed");
      if (needsReview && needsDecision) reviewedId = id;
    }

    // Ineligible assignments stay visible as unavailable and fail local validity.
    await page.locator("#new-work-button").click();
    await page.locator("#assignee-select").selectOption("producer");
    await page.locator("#work-options > summary").click();
    await page.locator("#work-mode-select").selectOption("write");
    assert.equal(await page.locator("#assignee-select").evaluate(select => select.checkValidity()), false);
    await page.locator("#assignee-select").selectOption("owner");
    assert.equal(await page.locator("#assignee-select").evaluate(select => select.checkValidity()), true);
    assert.equal(await page.locator('#verifier-select option[value="owner"]:not([disabled])').count(), 0);
    await page.locator("#verifier-select").selectOption("reviewer");
    await capture("review-options");
    if (label === "mobile") {
      const originalFontSize = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), `${parseFloat(originalFontSize) * 2}px`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(await page.locator(".check-option span").evaluateAll(labels => labels.map(label => label.scrollWidth <= label.clientWidth + 1)), [true, true]);
      const rect = await form.locator('button[type="submit"]').boundingBox();
      assert.ok(rect.x >= 0 && rect.x + rect.width <= viewport.width + 1);
      await capture("enlarged-options");
      await page.waitForFunction(() => !document.querySelector("#status").classList.contains("visible"));
      await page.locator(".work-checks").scrollIntoViewIfNeeded();
      await page.screenshot({ path: "test-results/workflow-mobile-enlarged-checks-viewport.png" });
    }
    await page.locator("#cancel-work-button").click();

    // A later finding remains possible after PASS and owner approval.
    const reviewerContext = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const reviewer = await reviewerContext.newPage();
    reviewer.on("pageerror", error => errors.push(error.message));
    await login(reviewer, reviewerKey);
    await reviewer.locator(`[data-work-record-id="${reviewedId}"]`).getByRole("button", { name: "Review evidence again" }).click();
    await reviewer.locator('#action-fields select[name="result"]').selectOption("fail");
    await reviewer.locator('#action-fields textarea[name="summary"]').fill("The source has a correction. Revise the finding.");
    await reviewer.locator('#action-form button[type="submit"]').click();
    await reviewer.locator("#action-dialog").waitFor({ state: "hidden" });
    const revised = page.locator(`[data-work-record-id="${reviewedId}"]`);
    await revised.locator('[data-next-step="revise"]').waitFor();
    assert.equal(await revised.locator(".state").getAttribute("class"), "state state-blocked");
    assert.equal(items()[reviewedId].decision, null);
    assert.equal(items()[reviewedId].decisionHistory.at(-1).invalidatedReason, "verification_failed");
    await capture("later-finding");
    assert.deepEqual(errors, []);
  });
}
