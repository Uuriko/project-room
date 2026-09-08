// Scripted people and MCP reviewer, isolated local data. No model or provider use.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "./mcp-test-client.mjs";

async function setup(t, touch = false) {
  const f = createAcceptanceFixture(), workItemId = "native-guide", errors = [], traffic = [];
  const state = () => f.store.room("commons").state, item = () => state().workItems[workItemId];
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  send("owner", "work.proposed", { workItemId, title: "A welcoming contributor guide", definitionOfDone: "Name the first step and who reviews it.",
    accountableMemberId: "owner", verifierMemberId: "reviewer", independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner", mode: "read" });
  send("owner", "work.accepted", { workItemId, expectedRevision: 0 });
  const invitation = send("owner", "work.help_updated", { workItemId, expectedRevision: 1, expectedHelpRevision: 0,
    status: "open", scope: "Draft a short welcome", expiresAt: new Date(Date.now() + 3600000).toISOString() });
  send("guest", "work.help_offer_opened", { workItemId, expectedRevision: 1, expectedHelpRevision: 1, helpEventId: invitation.event.id, offerId: "human-offer", plan: "I can draft the welcome." });
  send("owner", "work.help_offer_updated", { workItemId, expectedRevision: 1, expectedHelpRevision: 1, helpEventId: invitation.event.id, offerId: "human-offer", expectedOfferRevision: 0, status: "selected", reason: "Use this contribution" });
  const server = createRoomServer({ store: f.store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port, browser = await chromium.launch({ headless: true });
  let reviewer;
  t.after(async () => { if (reviewer) await reviewer.close(); await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const open = async actor => {
    const page = await browser.newPage({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: touch, hasTouch: touch, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000); page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    page.on("request", req => { if (req.method() === "POST" && req.url().endsWith("/commands")) traffic.push(req.postDataJSON()); });
    await page.goto(origin); await page.locator("#access-key").fill(f.keys[actor]); await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
    const card = page.locator('[data-work-record-id="' + workItemId + '"]');
    const draft = async (native = true, selected = false) => {
      const panel = card.locator(selected ? ".work-help" : ".work-details");
      if (!await panel.evaluate(node => node.open)) await panel.locator(":scope > summary").click();
      await panel.locator('[data-portable-mode="' + (native ? "draft" : "result") + '"]').click();
      await page.locator("#portable-dialog").waitFor({ state: "visible" });
    };
    return { page, card, draft };
  };
  const directory = join(f.directory, "reviewer");
  saveAgentConnection(directory, { version: 1, origin, roomId: "commons", memberId: "reviewer", token: f.keys.reviewer });
  reviewer = await openMcpTestClient(directory);
  return { ...f, workItemId, state, item, send, open, reviewer, errors, traffic };
}

for (const touch of [false, true]) test("selected helper to reviewed native result " + (touch ? "mobile" : "desktop"), { timeout: 30000 }, async t => {
  const f = await setup(t, touch), guest = await f.open("guest"), owner = await f.open("owner");
  const original = f.item(), body = "Welcome! Start by sharing a small draft.\nThe room owner reviews it with you.";
  await guest.page.locator("#message-input").fill("Keep my chat draft");
  await guest.draft(true, true);
  assert.equal(await guest.page.locator("#portable-title").textContent(), "Share draft");
  await guest.page.locator("#portable-result").fill(body);
  mkdirSync("test-results", { recursive: true }); const prefix = "test-results/native-" + (touch ? "mobile" : "desktop");
  await guest.page.screenshot({ path: prefix + "-compose.png" });
  if (touch) {
    await guest.page.locator("#portable-result").press("Enter"); assert.equal(f.state().messages.some(m => m.workItemId === f.workItemId), false);
    await guest.page.locator("#portable-result").fill(body); await guest.page.locator("#portable-submit").click();
  } else await guest.page.locator("#portable-result").press("Enter");
  await guest.page.locator("#portable-dialog").waitFor({ state: "hidden" });
  const message = f.state().messages.find(m => m.workItemId === f.workItemId);
  assert.equal(message.body, body); assert.equal(message.authorId, "guest"); assert.equal(message.proposal.basisRevision, 1);
  assert.deepEqual(f.item(), original); assert.equal(f.state().helpOffers["human-offer"].status, "selected");
  await owner.page.locator('[data-message-action="result"][data-message-id="' + message.id + '"]').click();
  await owner.page.waitForFunction(body => document.querySelector("#action-text-body").textContent === body, body);
  assert.equal(await owner.page.locator('[name="producerId"]').inputValue(), "", "Producer is not inferred from author or selection");
  await owner.page.locator('[name="producerId"]').selectOption("guest");
  await owner.page.locator('#action-fields [name="summary"]').fill("A short welcome with a first step and reviewer");
  await owner.page.locator('#action-fields [name="nextAction"]').fill("Check the exact text");
  await owner.page.screenshot({ path: prefix + "-adopt.png" });
  await owner.page.locator("#action-form button[type=submit]").click(); await owner.page.locator("#action-dialog").waitFor({ state: "hidden" });
  const completion = f.item().receipt;
  assert.equal(completion.reportedById, "owner"); assert.equal(completion.producerId, "guest"); assert.equal(completion.nativeText.messageId, message.id);
  assert.equal(f.item().verification, null); assert.equal(f.item().decision, null);
  const read = (await f.reviewer.call("room_read_result", { workItemId: f.workItemId, completionEventId: completion.eventId })).result.structuredContent;
  assert.equal(read.result.text.body, body); assert.equal(read.result.text.evidenceVersion, completion.evidenceVersion);
  const current = (await f.reviewer.call("room_read_work", { workItemId: f.workItemId })).result.structuredContent;
  const reviewed = (await f.reviewer.call("room_record_verification", { requestId: "review-exact", workItemId: f.workItemId,
    expectedRevision: current.work.revision, result: "pass", completionEventId: completion.eventId, evidenceVersion: completion.evidenceVersion,
    summary: "Exact stored text names the first step and the room owner as reviewer." })).result;
  assert.equal(reviewed.isError, undefined, JSON.stringify(reviewed)); assert.equal(f.item().verification.independenceConfirmed, true); assert.equal(f.item().decision, null);
  await owner.card.locator('[data-action="decide"]').click();
  await owner.page.waitForFunction(body => document.querySelector("#action-text-body").textContent === body, body);
  await owner.page.locator('[name="decision"]').selectOption("approved"); await owner.page.locator('[name="reason"]').fill("This is ready to use");
  await owner.page.screenshot({ path: prefix + "-decision.png" });
  await owner.page.locator("#action-form button[type=submit]").click(); await owner.page.locator("#action-dialog").waitFor({ state: "hidden" });
  assert.equal(f.item().decision.decision, "approved"); assert.equal(f.item().decision.completionEventId, completion.eventId);
  assert.equal(f.state().helpOffers["human-offer"].status, "selected", "Review never silently releases external coordination");
  assert.equal(await guest.page.locator("#message-input").inputValue(), "Keep my chat draft");
  assert.equal(await guest.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true); assert.deepEqual(f.errors, []);
  writeFileSync(prefix + ".json", JSON.stringify({ simulatedHuman: true, scriptedMcp: true, nativeModels: false,
    rawDraft: true, exactStoredText: true, explicitProducer: true, separateReview: true, humanDecision: true, workRevision: f.item().revision }, null, 2));
});

test("native drafts and copied AI returns keep separate private drafts and original basis across reopening", async t => {
  const f = await setup(t), guest = await f.open("guest");
  await guest.draft(); await guest.page.locator("#portable-result").fill("My own draft"); await guest.page.locator("#portable-close").click();
  await guest.draft(false); assert.equal(await guest.page.locator("#portable-result").inputValue(), "");
  await guest.page.locator("#portable-result").fill("ROOM-RETURN incomplete manual draft"); await guest.page.locator("#portable-close").click();
  f.send("owner", "work.started", { workItemId: f.workItemId, expectedRevision: 1 });
  await guest.draft(); assert.equal(await guest.page.locator("#portable-result").inputValue(), "My own draft");
  await guest.page.locator("#portable-older-label").waitFor({ state: "visible" });
  assert.equal(await guest.page.locator("#portable-submit").isDisabled(), true);
  await guest.page.locator("#portable-older").check(); await guest.page.locator("#portable-submit").click();
  await guest.page.locator("#portable-dialog").waitFor({ state: "hidden" });
  const posted = f.state().messages.find(m => m.body === "My own draft");
  assert.equal(posted.proposal.basisRevision, 1); assert.equal(posted.proposal.submittedAtRevision, 2);
  await guest.draft(false); assert.equal(await guest.page.locator("#portable-result").inputValue(), "ROOM-RETURN incomplete manual draft");
  assert.deepEqual(f.errors, []);
});

test("native unknown save retains exact input through scope changes and retry", async t => {
  const f = await setup(t), guest = await f.open("guest"); let lose = true;
  await guest.page.route("**/api/rooms/commons/commands", async route => {
    if (!lose) return route.continue(); lose = false; await route.fetch(); return route.abort();
  });
  await guest.draft(); await guest.page.locator("#portable-result").fill("Keep this exact contribution");
  await guest.page.locator("#portable-submit").click(); await guest.page.getByRole("button", { name: "Retry draft" }).waitFor();
  const first = f.traffic.find(c => c.type === "message.posted");
  await guest.page.locator("#portable-close").click(); f.send("owner", "work.started", { workItemId: f.workItemId, expectedRevision: 1 });
  await guest.draft(); assert.equal(await guest.page.locator("#portable-result").getAttribute("readonly"), "");
  await guest.page.locator("#portable-submit").click(); await guest.page.locator("#portable-dialog").waitFor({ state: "hidden" });
  const posts = f.traffic.filter(c => c.type === "message.posted"); assert.equal(posts.length, 2); assert.deepEqual(posts[1], first);
  assert.equal(f.state().messages.filter(m => m.body === "Keep this exact contribution").length, 1); assert.deepEqual(f.errors, []);
});
