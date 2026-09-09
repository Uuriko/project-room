// Explicitly simulated owner interaction, not an independent human review.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { RoomAgentClient } from "../client/room-agent.mjs";

const [ownerPath, stage, targetId, output] = process.argv.slice(2);
if (process.argv.length !== 6 || !["select", "adopt"].includes(stage)) throw new Error("Supply fixture owner path, select/adopt, exact offer/message ID, and a new evidence directory.");
const config = JSON.parse(readFileSync(ownerPath)), origin = new URL(config.origin);
assert.equal(config.fixture, "room-helper-exercise-v1"); assert.equal(origin.origin, config.origin);
assert.equal(origin.protocol, "http:"); assert.equal(origin.hostname, "127.0.0.1");
const directory = resolve(output); mkdirSync(directory, { mode: 0o700 });
const client = new RoomAgentClient({ origin: config.origin, roomId: "commons", token: config.token });
const before = await client.snapshot(), work = before.state.workItems[config.workItemId];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === config.origin ? route.continue() : route.abort());
  await page.goto(config.origin); await page.locator("#access-key").fill(config.token);
  await page.getByRole("button", { name: "Enter room", exact: true }).click(); await page.locator("#main").waitFor();
  await page.locator("#message-input").fill("Keep this unrelated owner draft.");
  if (stage === "select") {
    assert.equal(before.state.helpOffers[targetId]?.offererId, "helper");
    const card = page.locator('[data-work-record-id="' + config.workItemId + '"]'), panel = card.locator(".work-help");
    await panel.locator(":scope > summary").click();
    await page.screenshot({ path: join(directory, "offer.png") });
    await card.locator('[data-action="select-offer"][data-offer-id="' + targetId + '"]').click();
    await page.locator('[name="reason"]').fill("Simulated owner: use this welcome draft for review.");
  } else {
    const message = before.state.messages.find(m => m.id === targetId);
    assert.equal(message?.authorId, "helper"); assert.equal(message.workItemId, config.workItemId);
    await page.locator('[data-message-action="result"][data-message-id="' + targetId + '"]').click();
    await page.waitForFunction(body => document.querySelector("#action-text-body").textContent === body, message.body);
    assert.equal(await page.locator('[name="producerId"]').inputValue(), "");
    await page.locator('[name="producerId"]').selectOption("helper");
    await page.locator('#action-fields [name="summary"]').fill("Original welcome from the helper; pending independent review.");
    await page.locator('#action-fields [name="nextAction"]').fill("Reviewer checks this exact text; owner decision remains pending.");
  }
  await page.screenshot({ path: join(directory, "confirm.png") });
  await page.locator("#action-form button[type=submit]").click(); await page.locator("#action-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#message-input").inputValue(), "Keep this unrelated owner draft.");
  await page.screenshot({ path: join(directory, "after.png") });
  const after = await client.snapshot(), current = after.state.workItems[config.workItemId];
  assert.equal(current.accountableMemberId, "owner"); assert.equal(current.verification, null); assert.equal(current.decision, null);
  if (stage === "select") { assert.deepEqual(current, work); assert.equal(after.state.helpOffers[targetId].status, "selected"); }
  else { assert.equal(current.receipt.nativeText.messageId, targetId); assert.equal(current.receipt.producerId, "helper"); assert.equal(current.receipt.reportedById, "owner"); }
  assert.deepEqual(errors, []);
  const evidence = { stage, targetId, simulatedOwner: true, independentReviewPerformed: false,
    beforeSequence: before.sequence, afterSequence: after.sequence, work: current, offers: after.state.helpOffers, errors };
  writeFileSync(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(evidence));
} finally { await browser.close(); }
