// Cross-session return-brief isolation and bounded accessibility regressions.
// Real browser + disposable loopback service; no external identity or agent runtime.
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

test("stale return brief cannot cross a session; skip, local alerts, focus return, and AA primary controls hold", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-accessibility-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const send = (key, type, data) => store.command(key, "commons", { id: crypto.randomUUID(), type, data });
  send(owner, T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: ["accept_work", "complete_work", "verify"] });
  const maya = store.issueAccessKey("commons", "maya");
  send(owner, T.WORK_PROPOSED, { workItemId: "owner-only", title: "Owner-only return item", definitionOfDone: "Owner accepts", accountableMemberId: "owner" });
  send(owner, T.WORK_PROPOSED, { workItemId: "maya-only", title: "Maya-only return item", definitionOfDone: "Maya accepts", accountableMemberId: "maya" });
  send(owner, T.WORK_PROPOSED, { workItemId: "producer-choice", title: "Explicit producer choice", definitionOfDone: "Reporter records producer separately", accountableMemberId: "owner", verifierMemberId: "maya", independentVerificationRequired: true, mode: "read" });
  send(owner, T.WORK_ACCEPTED, { workItemId: "producer-choice", expectedRevision: 0 });
  send(owner, T.WORK_PROPOSED, { workItemId: "producer-unknown-choice", title: "Explicit unknown producer choice", definitionOfDone: "Unknown is chosen, never inferred", accountableMemberId: "owner", verifierMemberId: "maya", independentVerificationRequired: true, mode: "read" });
  send(owner, T.WORK_ACCEPTED, { workItemId: "producer-unknown-choice", expectedRevision: 0 });
  send(owner, T.WORK_PROPOSED, { workItemId: "unknown-producer", title: "Unknown producer evidence", definitionOfDone: "Attribution stays explicit", accountableMemberId: "owner", verifierMemberId: "maya", independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner" });
  send(owner, T.WORK_ACCEPTED, { workItemId: "unknown-producer", expectedRevision: 0 });
  const completed = send(owner, T.WORK_COMPLETED, { workItemId: "unknown-producer", expectedRevision: 1, summary: "Completion was reported without producer attribution", evidenceUrl: "https://example.com/unknown-producer", evidenceVersion: "v1", nextAction: "Establish producer identity" });
  send(maya, T.VERIFICATION_RECORDED, { workItemId: "unknown-producer", expectedRevision: 2, result: "pass", completionEventId: completed.event.id, evidenceVersion: "v1", summary: "Evidence content checked" });
  send(owner, T.WORK_PROPOSED, { workItemId: "producer-conflict", title: "Verifier produced this result", definitionOfDone: "Independent producer is required", accountableMemberId: "owner", verifierMemberId: "maya", independentVerificationRequired: true, mode: "read" });
  send(owner, T.WORK_ACCEPTED, { workItemId: "producer-conflict", expectedRevision: 0 });
  send(owner, T.WORK_COMPLETED, { workItemId: "producer-conflict", expectedRevision: 1, producerId: "maya", summary: "Maya produced the result", evidenceUrl: "https://example.com/conflict", evidenceVersion: "conflict-v1", nextAction: "Find an independent verifier" });

  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, page, releaseHeld;
  t.after(async () => {
    releaseHeld?.();
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" })).newPage();

  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  const completionCommands = [];
  page.on("request", request => {
    if (request.method() !== "POST" || !request.url().endsWith("/api/rooms/commons/commands")) return;
    const command = request.postDataJSON();
    if (command.type === T.WORK_COMPLETED) completionCommands.push(command);
  });

  // Login skips to its heading, not the redundant signed-out connection strip.
  await page.locator("#skip-link").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement.id), "auth-title");

  // Authentication errors have one local announcement owner, not a duplicate toast.
  await page.locator("#access-key").fill("invalid-access-key");
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#auth-error").waitFor({ state: "visible" });
  assert.match(await page.locator("#auth-error").textContent(), /Check the access key and try again/);
  assert.equal(await page.locator("#status").textContent(), "", "no duplicate global authentication alert");

  await page.locator("#access-key").fill(owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });

  const receipt = page.locator('[data-work-record-id="unknown-producer"] .receipt');
  assert.match(await receipt.textContent(), /Completion reporter\s*Room owner/);
  assert.match(await receipt.textContent(), /Producer\s*Unknown — no producer was reported/);
  assert.match(await receipt.textContent(), /PASS reported by Maya \(maya\) · independence not confirmed/);
  assert.doesNotMatch(await receipt.textContent(), /INDEPENDENT PASS/);
  assert.equal(await page.locator('[data-work-record-id="unknown-producer"] [data-action="decide"]').count(), 0, "unconfirmed independence cannot expose approval");

  // Primary controls meet 4.5:1 in both ordinary and hover states.
  const sendButton = page.locator('#message-form button[type="submit"]');
  const contrast = async () => sendButton.evaluate(element => {
    const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const luminance = value => { const [r, g, b] = rgb(value); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const style = getComputedStyle(element), foreground = luminance(style.color), background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  assert.ok(await contrast() >= 4.5, "primary control contrast at rest");
  await sendButton.hover();
  assert.ok(await contrast() >= 4.5, "primary control contrast on hover");

  // Canceling the inline work form returns focus to the control that opened it.
  await page.locator("#new-work-button").click();
  await page.locator("#cancel-work-button").click();
  await page.waitForFunction(() => document.activeElement.id === "new-work-button");

  // Completion requires a deliberate producer choice, including an explicit unknown option.
  await page.locator('[data-work-record-id="producer-choice"] [data-action="complete"]').click();
  const producerSelect = page.locator('#action-form select[name="producerId"]');
  assert.equal(await producerSelect.inputValue(), "", "producer is never inferred from the completion reporter");
  assert.deepEqual(await producerSelect.locator("option").allTextContents(), [
    "Choose producer",
    "I produced this — Room owner (owner)",
    "Unknown / not reported",
    "Maya (maya) · human"
  ]);
  await producerSelect.selectOption("owner");
  await page.locator('#action-form textarea[name="summary"]').fill("Reporter submitted the result");
  await page.locator('#action-form input[name="evidenceUrl"]').fill("https://example.com/reporter-result");
  await page.locator('#action-form input[name="evidenceVersion"]').fill("producer-v1");
  await page.locator('#action-form textarea[name="nextAction"]').fill("Maya verifies independently");
  await page.locator('#action-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[data-work-record-id="producer-choice"] .receipt')?.textContent.includes("Room owner"));
  const knownReceipt = await page.locator('[data-work-record-id="producer-choice"] .receipt').textContent();
  assert.equal(completionCommands.at(-1).data.producerId, "owner", "self-produced choice sends the authenticated member id");
  assert.match(knownReceipt, /Completion reporter\s*Room owner/);
  assert.match(knownReceipt, /Producer\s*Room owner/);

  await page.locator('[data-work-record-id="producer-unknown-choice"] [data-action="complete"]').click();
  await page.locator('#action-form select[name="producerId"]').selectOption("__unknown__");
  await page.locator('#action-form textarea[name="summary"]').fill("Reporter cannot establish who produced the result");
  await page.locator('#action-form input[name="evidenceUrl"]').fill("https://example.com/unknown-result");
  await page.locator('#action-form input[name="evidenceVersion"]').fill("unknown-v1");
  await page.locator('#action-form textarea[name="nextAction"]').fill("Establish provenance before verification");
  await page.locator('#action-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[data-work-record-id="producer-unknown-choice"] .receipt')?.textContent.includes("Unknown"));
  assert.equal(completionCommands.at(-1).data.producerId, null, "unknown is an explicit submitted choice");
  assert.match(await page.locator('[data-work-record-id="producer-unknown-choice"] .receipt').textContent(), /Producer\s*Unknown — no producer was reported/);

  // Start the held response immediately before the session switch so it cannot
  // expire under the client's request deadline on a slower CI runner.
  let capturedResolve;
  const captured = new Promise(resolve => { capturedResolve = resolve; });
  const held = new Promise(resolve => { releaseHeld = resolve; });
  let heldFirstBrief = false;
  await page.route("**/api/rooms/commons/return-brief**", async route => {
    if (heldFirstBrief) { await route.continue(); return; }
    heldFirstBrief = true;
    const response = await route.fetch();
    capturedResolve();
    await held;
    await route.fulfill({ response });
  });
  await page.locator("#return-brief-panel > summary").click();
  await captured;
  assert.equal(await page.locator("#return-brief-panel").getAttribute("aria-busy"), "true");
  assert.equal(await page.locator("#rb-ack-button").isDisabled(), true, "stale-horizon actions stay disabled during a fresh brief request");

  // End the owner session while its newly fetched brief is still in flight.
  await page.locator("#signout-button").click();
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => document.activeElement.id), "access-key", "access end moves focus to sign-in");
  assert.match(await page.locator("#auth-error").textContent(), /Session ended; private drafts were cleared/);
  assert.equal(await page.locator("#status").textContent(), "", "sign-out has one local announcement owner");
  await page.locator("#access-key").fill(maya);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-work-record-id="producer-choice"] [data-action="verify"]').textContent(), "Record independent check", "known distinct producer exposes independent verification");
  assert.equal(await page.locator('[data-work-record-id="producer-unknown-choice"] [data-action="verify"]').textContent(), "Record evidence check", "unknown producer exposes only a non-independent evidence check");
  assert.equal(await page.locator('[data-work-record-id="producer-conflict"] [data-action="verify"]').count(), 0, "verifier-as-producer does not expose a misleading independent-check action");
  await page.locator('[data-work-record-id="producer-unknown-choice"] [data-action="verify"]').click();
  assert.equal(await page.locator("#action-title").textContent(), "Record an evidence check");
  assert.match(await page.locator("#action-fields").textContent(), /Producer identity is unknown.*cannot satisfy independent verification or unlock approval/s);
  await page.locator("#cancel-action").click();
  await page.waitForFunction(() => document.querySelector("#rb-attention-list")?.textContent.includes("Maya-only return item"));
  releaseHeld();
  await page.waitForTimeout(100);
  const attention = await page.locator("#rb-attention-list").textContent();
  assert.match(attention, /Maya-only return item/);
  assert.doesNotMatch(attention, /Owner-only return item/, "late owner response cannot overwrite Maya's brief");
  assert.match(await page.locator("#rb-history-list").textContent(), /work completed reporter Room owner.*producer unknown — not reported/i, "return history separates reporter from unknown producer");
});
