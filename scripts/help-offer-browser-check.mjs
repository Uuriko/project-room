// Simulated humans and scripted MCP over a disposable local room. No model use.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "./mcp-test-client.mjs";

async function setup(t, touch = false, duration = 3600000) {
  const f = createAcceptanceFixture(), workItemId = "offer-guide", errors = [], traffic = [];
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  send("owner", "work.proposed", { workItemId, title: "Contributor guide", definitionOfDone: "A short guide with examples", accountableMemberId: "owner", mode: "read" });
  send("owner", "work.accepted", { workItemId, expectedRevision: 0 });
  const item = () => f.store.room("commons").state.workItems[workItemId];
  const help = (status = "open", scope = "Suggest two guide examples", duration = 3600000) => send("owner", "work.help_updated", {
    workItemId, expectedRevision: item().revision, expectedHelpRevision: item().helpWanted?.revision ?? 0, status,
    ...(status === "open" ? { scope, expiresAt: new Date(Date.now() + duration).toISOString() } : {}) });
  help("open", "Suggest two guide examples", duration);
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true });
  let agent;
  t.after(async () => { if (agent) await agent.close(); await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const open = async actor => {
    const page = await browser.newPage({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: touch, hasTouch: touch, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000); page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    page.on("request", req => { if (req.url().endsWith("/commands") && req.method() === "POST") traffic.push({ actor, command: req.postDataJSON() }); });
    await page.goto(origin); await page.locator("#access-key").fill(f.keys[actor]);
    await page.getByRole("button", { name: "Enter room", exact: true }).click(); await page.locator("#main").waitFor({ state: "visible" });
    const card = page.locator('[data-work-record-id="' + workItemId + '"]'), dialog = page.locator("#action-dialog");
    const action = async (name, offerId) => {
      const button = card.locator('[data-action="' + name + '"]' + (offerId ? '[data-offer-id="' + offerId + '"]' : ""));
      await button.waitFor({ state: "attached" });
      if (!await card.locator(".work-help").evaluate(node => node.open)) await card.locator(".work-help > summary").click();
      await button.click();
      await dialog.waitFor({ state: "visible" });
    };
    const save = async () => { await page.locator("#action-form button[type=submit]").click(); await dialog.waitFor({ state: "hidden" }); };
    return { page, card, dialog, action, save };
  };
  const directory = join(f.directory, "agent");
  saveAgentConnection(directory, { version: 1, origin, roomId: "commons", memberId: "producer", token: f.keys.producer });
  agent = await openMcpTestClient(directory);
  const agentOffer = async (offerId = "agent-offer") => {
    const view = (await agent.call("room_read_work", { workItemId, includeOffers: true })).result.structuredContent;
    const result = (await agent.call("room_offer_help", { requestId: offerId + "-operation", offerId, workItemId,
      expectedRevision: view.work.revision, expectedHelpRevision: view.help.revision, helpEventId: view.help.eventId, plan: "I can draft two alternatives." })).result;
    assert.equal(result.isError, undefined, JSON.stringify(result)); return result.structuredContent;
  };
  const update = (offerId, status, actor = "owner") => {
    const offer = f.store.room("commons").state.helpOffers[offerId];
    return send(actor, "work.help_offer_updated", { workItemId, offerId, expectedRevision: item().revision, expectedOfferRevision: offer.revision,
      status, reason: "Explicit test coordination", ...(status === "selected" ? { expectedHelpRevision: item().helpWanted.revision, helpEventId: item().helpWanted.eventId } : {}),
      ...(status === "released" ? { externalActivityUnverified: true } : {}) });
  };
  return { ...f, workItemId, origin, item, help, send, open, agent, agentOffer, update, errors, traffic };
}

for (const touch of [false, true]) test("human + agent offers " + (touch ? "mobile" : "desktop"), { timeout: 30000 }, async t => {
  const f = await setup(t, touch), guest = await f.open("guest"), owner = await f.open("owner");
  const before = f.store.room("commons").state;
  await guest.page.locator("#message-input").fill("Keep my chat draft");
  assert.equal(await guest.card.locator('[data-action="offer-help"]').isVisible(), false);
  await guest.action("offer-help"); await guest.page.locator('[name="plan"]').fill("I can write an example for first-time contributors.");
  mkdirSync("test-results", { recursive: true }); const prefix = "test-results/offer-" + (touch ? "mobile" : "desktop");
  await guest.page.screenshot({ path: prefix + "-compose.png" });
  await guest.save(); const humanOffer = Object.values(f.store.room("commons").state.helpOffers).find(o => o.offererId === "guest");
  await f.agentOffer();
  await owner.card.locator('[data-offer-record-id="agent-offer"]').waitFor({ state: "attached" });
  await owner.card.locator(".work-help").evaluate(node => { node.open = true; });
  await owner.card.scrollIntoViewIfNeeded(); await owner.page.screenshot({ path: prefix + "-choices.png" });
  assert.equal(await owner.card.locator(".help-offer img").count(), 0);
  await owner.action("select-offer", humanOffer.id); await owner.page.locator('[name="reason"]').fill("Use this example");
  await owner.save(); await guest.card.getByText("Helper selected", { exact: true }).waitFor();
  f.help("withdrawn");
  await guest.card.getByText("Helper · review needed", { exact: true }).waitFor();
  await guest.card.locator(".work-help").evaluate(node => { node.open = true; }); await guest.card.scrollIntoViewIfNeeded();
  await guest.page.screenshot({ path: prefix + "-review.png" });
  await guest.action("release-offer", humanOffer.id); await guest.page.locator('[name="reason"]').fill("Request ended");
  await guest.page.locator("#action-form button[type=submit]").click();
  assert.equal(await guest.dialog.isVisible(), true);
  await guest.page.locator('[name="externalActivityUnverified"]').check(); await guest.save();
  await owner.action("decline-offer", "agent-offer"); await owner.page.locator('[name="reason"]').fill("Request ended"); await owner.save();
  await owner.card.locator(".offer-history").waitFor({ state: "attached" });
  assert.equal(await owner.card.locator(".offer-history").evaluate(node => node.open), false);
  const state = f.store.room("commons").state;
  assert.equal(state.helpOffers[humanOffer.id].externalActivityUnverified, true);
  assert.equal(state.helpOffers["agent-offer"].status, "declined");
  assert.deepEqual(state.members, before.members); assert.deepEqual(state.messages, before.messages);
  assert.equal(f.item().revision, 1); assert.equal(f.item().accountableMemberId, "owner");
  assert.equal(await guest.page.locator("#message-input").inputValue(), "Keep my chat draft");
  assert.equal(await guest.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.deepEqual(f.errors, []);
  writeFileSync(prefix + ".json", JSON.stringify({ simulatedHuman: true, scriptedMcp: true, nativeModels: false,
    offered: true, selected: true, explicitRelease: true, alternativesRetained: true, historyCollapsed: true, draftPreserved: true }, null, 2));
});

test("human offer draft stays pinned across request changes and explicit review keeps the text", async t => {
  const f = await setup(t), guest = await f.open("guest");
  await guest.action("offer-help"); await guest.page.locator('[name="plan"]').fill("Keep my original plan");
  f.help("open", "New scope from another session");
  await guest.page.locator("#refresh-action").waitFor({ state: "visible" });
  assert.equal(await guest.page.locator("#action-form button[type=submit]").isDisabled(), true);
  assert.equal(await guest.page.locator("#offer-current").textContent(), "Suggest two guide examples");
  await guest.page.locator("#refresh-action").click();
  await guest.page.waitForFunction(() => document.querySelector("#offer-current").textContent === "New scope from another session");
  assert.equal(await guest.page.locator('[name="plan"]').inputValue(), "Keep my original plan");
  assert.equal(await guest.page.locator("#offer-current").textContent(), "New scope from another session");
  await guest.save();
  assert.equal(Object.values(f.store.room("commons").state.helpOffers)[0].invitation.revision, 2);
  assert.deepEqual(f.errors, []);
});

for (const failure of ["lost-response", "wrong-receipt"]) test("human offer " + failure + " retries the original after request withdrawal", async t => {
  const f = await setup(t), guest = await f.open("guest"); let first = true;
  await guest.page.route("**/api/rooms/commons/commands", async route => {
    if (!first || route.request().postDataJSON().type !== "work.help_offer_opened") return route.continue();
    first = false; const response = await route.fetch();
    if (failure === "lost-response") return route.abort();
    const body = await response.json(); body.event.data.plan = "Wrong plan"; return route.fulfill({ response, json: body });
  });
  await guest.action("offer-help"); await guest.page.locator('[name="plan"]').fill("An exact retained plan");
  await guest.page.locator("#action-form button[type=submit]").click(); await guest.page.getByRole("button", { name: "Retry original save" }).waitFor();
  assert.equal(await guest.page.locator('[name="plan"]').isDisabled(), true);
  await guest.page.locator("#cancel-action").click(); f.help("withdrawn");
  await guest.page.locator("#resume-action").click(); await guest.save();
  const requests = f.traffic.filter(row => row.command.type === "work.help_offer_opened").map(row => row.command);
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  assert.equal(Object.values(f.store.room("commons").state.helpOffers).length, 1);
  assert.equal(f.item().helpWanted.status, "withdrawn"); assert.deepEqual(f.errors, []);
});

test("human selection refuses a concurrent winner without silently taking over", async t => {
  const f = await setup(t), guest = await f.open("guest"), owner = await f.open("owner");
  await guest.action("offer-help"); await guest.page.locator('[name="plan"]').fill("Human alternative"); await guest.save();
  const humanOffer = Object.values(f.store.room("commons").state.helpOffers)[0]; await f.agentOffer();
  await owner.action("select-offer", humanOffer.id); await owner.page.locator('[name="reason"]').fill("Human contribution");
  await owner.page.route("**/api/rooms/commons/commands", route => { f.update("agent-offer", "selected"); return route.continue(); });
  await owner.page.locator("#action-form button[type=submit]").click();
  await owner.page.locator("#refresh-action").waitFor({ state: "visible" });
  assert.equal(await owner.page.locator("#action-form button[type=submit]").isDisabled(), true);
  assert.equal(await owner.page.locator('[name="reason"]').inputValue(), "Human contribution");
  assert.equal(f.store.room("commons").state.helpOffers["agent-offer"].status, "selected");
  assert.equal(f.store.room("commons").state.helpOffers[humanOffer.id].status, "offered");
  assert.deepEqual(f.errors, []);
});

for (const broken of ["legacy", "malformed"]) test("human offers do not infer support from " + broken + " snapshots", async t => {
  const f = await setup(t), guest = await f.open("guest");
  await f.agentOffer(); f.update("agent-offer", "selected");
  if (broken === "legacy") f.help("withdrawn");
  await guest.page.route("**/api/rooms/commons", async route => {
    const response = await route.fetch(), body = await response.json();
    if (broken === "legacy") delete body.offerContextVersion; else body.state.helpOffers = [];
    return route.fulfill({ response, json: body });
  });
  await guest.page.reload(); await guest.page.locator("#main").waitFor({ state: "visible" });
  await guest.card.locator(".work-help").evaluate(node => { node.open = true; });
  assert.equal(await guest.card.locator('[data-action="offer-help"]').count(), 0);
  assert.equal(await guest.card.getByText("Offers unavailable.", { exact: true }).isVisible(), true);
  assert.equal(await guest.card.locator('[data-action="release-offer"]').count(), 0);
  assert.equal(f.traffic.length, 0); assert.deepEqual(f.errors, []);
});

test("human offer text stays literal and a pending contribution can be withdrawn", async t => {
  const f = await setup(t, true), guest = await f.open("guest");
  await guest.action("offer-help");
  await guest.page.locator('[name="plan"]').fill("<img src=x onerror=alert(1)> " + "LongContribution".repeat(20)); await guest.save();
  const offer = Object.values(f.store.room("commons").state.helpOffers)[0];
  await guest.card.locator(".work-help").evaluate(node => { node.open = true; });
  assert.equal(await guest.card.locator(".help-offer img").count(), 0);
  assert.equal(await guest.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await guest.action("withdraw-offer", offer.id); await guest.page.locator('[name="reason"]').fill("No longer available"); await guest.save();
  assert.equal(f.store.room("commons").state.helpOffers[offer.id].status, "withdrawn"); assert.deepEqual(f.errors, []);
});

test("a selected helper remains visible when time expires without a new event", { timeout: 15000 }, async t => {
  const f = await setup(t, false, 5000), owner = await f.open("owner");
  await f.agentOffer(); f.update("agent-offer", "selected");
  await owner.card.getByText("Helper selected", { exact: true }).waitFor();
  const sequence = f.store.room("commons").sequence;
  await owner.card.getByText("Helper · review needed", { exact: true }).waitFor();
  assert.equal(f.store.room("commons").sequence, sequence);
  await owner.card.locator(".work-help").evaluate(node => { node.open = true; });
  assert.equal(await owner.card.locator('[data-action="release-offer"]').isVisible(), true);
  assert.deepEqual(f.errors, []);
});

test("incoming agent offers preserve a human plan and focus", async t => {
  const f = await setup(t), guest = await f.open("guest");
  await guest.action("offer-help"); const plan = guest.page.locator('[name="plan"]');
  await plan.fill("Keep this plan"); await plan.focus(); await f.agentOffer();
  await guest.card.locator('[data-offer-record-id="agent-offer"]').waitFor({ state: "attached" });
  assert.equal(await guest.card.locator(".work-help").evaluate(node => node.open), true);
  assert.equal(await plan.inputValue(), "Keep this plan");
  assert.equal(await plan.evaluate(node => node === document.activeElement), true);
  assert.equal(await guest.page.locator("#action-form button[type=submit]").isDisabled(), false);
  assert.deepEqual(f.errors, []);
});
