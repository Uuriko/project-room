// Synthetic human journeys against a disposable real service, not participant research.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function setup(t, viewport = { width: 1280, height: 900 }) {
  const fixture = createAcceptanceFixture(), errors = [];
  const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  async function login(who) {
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator("#access-key").fill(fixture.keys[who]);
    await page.locator("#access-key").press("Enter");
    await page.locator("#main").waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("#access-key").disabled);
    return page;
  }
  const send = (who, type, data) => fixture.store.command(fixture.keys[who], "commons", { id: crypto.randomUUID(), type, data });
  const request = (id, toMemberId = "guest") => send("owner", "message.posted", { messageId: id, body: `Question ${id}?`, toMemberId, requestKind: "reply" });
  return { ...fixture, login, errors, send, request, state: () => fixture.store.room("commons").state };
}
const record = (page, id) => page.locator(`[data-message-record-id="${id}"]`);
const input = page => page.locator("#message-input");
const idle = page => page.waitForFunction(() => !document.querySelector("#message-input").disabled);
const failed = page => page.waitForFunction(() => !document.querySelector("#message-input").disabled && document.querySelector("#composer-status").classList.contains("error"));
const saved = page => page.waitForFunction(() => !document.querySelector("#message-input").disabled && document.querySelector("#request-mode-bar").hidden);
async function options(page) {
  if (!await page.locator("#composer-options").evaluate(el => el.open)) await page.locator("#composer-options > summary").click();
}
async function mode(page, id, kind) {
  await record(page, id).locator(`[data-message-action="request-${kind}"]`).click();
  await page.waitForFunction(() => !document.querySelector("#request-mode-bar").hidden && !document.querySelector("#message-input").disabled);
  assert.equal(await page.locator("#composer-status").textContent(), "");
}

test("request journey: request, clarify and answer stay in chat without closing work", { timeout: 60000 }, async t => {
  const f = await setup(t), owner = await f.login("owner"), guest = await f.login("guest");
  const before = structuredClone(f.state().workItems);
  await input(owner).fill("Keep my ordinary draft");
  await options(owner); await owner.locator("#request-reply").click();
  await input(owner).fill("Which agenda should we use?");
  await owner.locator("#message-to-select").selectOption("guest");
  await input(owner).press("Enter"); await saved(owner);
  assert.equal(await input(owner).inputValue(), "Keep my ordinary draft");
  const id = Object.keys(f.state().replyRequests)[0];
  assert.equal(f.state().replyRequests[id].recipientId, "guest");
  await record(guest, id).locator('[data-message-action="reply"]').click();
  await input(guest).fill("Should it include the review?"); await input(guest).press("Enter");
  await guest.waitForFunction(() => !document.querySelector("#message-input").disabled && !document.querySelector("#message-input").value);
  assert.equal(f.state().replyRequests[id].status, "open");
  await mode(guest, id, "answered");
  await input(guest).fill("Use the short agenda, including the review.");
  await guest.screenshot({ path: "test-results/request-answer-desktop.png", fullPage: true });
  await input(guest).press("Shift+Enter");
  assert.match(await input(guest).inputValue(), /\n$/);
  await input(guest).press("Enter"); await saved(guest);
  assert.equal(f.state().replyRequests[id].status, "answered");
  assert.deepEqual(f.state().workItems, before);
  await record(owner, id).locator(".request-state").filter({ hasText: "Answered" }).waitFor();
  assert.deepEqual(f.errors, []);
});

test("stale answer keeps text, explicit refresh updates context, decline and cancellation are distinct", { timeout: 60000 }, async t => {
  const f = await setup(t, { width: 390, height: 844 });
  f.request("first"); f.request("second"); f.request("third");
  const guest = await f.login("guest"), owner = await f.login("owner");
  await mode(guest, "first", "answered"); await input(guest).fill("A considered answer");
  f.send("owner", "message.posted", { messageId: "new-context", body: "Also consider the new deadline.", replyToId: "first" });
  await guest.waitForFunction(() => document.querySelector("#request-mode-label").textContent.includes("Context changed"));
  await input(guest).press("Enter"); await failed(guest);
  assert.equal(await input(guest).inputValue(), "A considered answer");
  assert.equal(await input(guest).evaluate(el => el.readOnly), false);
  await guest.locator("#request-refresh").click(); await idle(guest);
  assert.equal(await input(guest).inputValue(), "A considered answer");
  await input(guest).press("Enter"); await saved(guest);
  assert.equal(f.state().replyRequests.first.status, "answered");
  await guest.locator("#thread-back").click();
  await mode(guest, "second", "declined"); await input(guest).fill("I do not have the relevant context.");
  await guest.screenshot({ path: "test-results/request-decline-mobile.png", fullPage: true });
  assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await guest.locator('#message-form button[type="submit"]').click(); await saved(guest);
  assert.equal(f.state().replyRequests.second.status, "declined");
  await mode(owner, "third", "cancelled"); await input(owner).fill("No longer needed.");
  await owner.locator('#message-form button[type="submit"]').click(); await saved(owner);
  assert.equal(f.state().replyRequests.third.status, "cancelled");
  assert.equal(f.state().replyRequests.third.reason, "No longer needed.");
  assert.equal(f.state().messages.some(message => message.body === "No longer needed."), false);
  assert.deepEqual(f.errors, []);
});

test("lost committed answer remains exact and read-only across reload, then retries once", { timeout: 60000 }, async t => {
  const f = await setup(t); f.request("retry");
  const page = await f.login("guest");
  await options(page); await page.locator("#remember-drafts").check();
  await mode(page, "retry", "answered"); await input(page).fill("One answer only.");
  const commands = []; let lose = true;
  await page.route("**/api/rooms/commons/commands", async route => {
    commands.push(route.request().postDataJSON());
    if (lose) { lose = false; await route.fetch(); await route.abort("failed"); }
    else await route.continue();
  });
  await input(page).press("Enter"); await failed(page);
  assert.equal(await input(page).evaluate(el => el.readOnly), true);
  assert.equal(await page.locator("#request-refresh").isVisible(), false);
  page.once("dialog", dialog => dialog.accept()); await page.reload();
  await page.locator("#main").waitFor({ state: "visible" }); await idle(page);
  assert.equal(await input(page).inputValue(), "One answer only.");
  assert.equal(await input(page).evaluate(el => el.readOnly), true);
  await page.getByRole("button", { name: "Retry original", exact: true }).click(); await saved(page);
  assert.equal(commands.length, 2); assert.deepEqual(commands[0], commands[1]);
  assert.equal(f.state().messages.filter(message => message.body === "One answer only.").length, 1);
  assert.deepEqual(f.errors, []);
});

test("unconfirmed receipt locks the exact request; ordinary drafts remain separate", { timeout: 60000 }, async t => {
  const f = await setup(t), page = await f.login("owner");
  await input(page).fill("Ordinary draft"); await options(page); await page.locator("#request-reply").click();
  await input(page).fill("An explicit question"); await page.locator("#message-to-select").selectOption("guest");
  let alter = true; const commands = [];
  await page.route("**/api/rooms/commons/commands", async route => {
    commands.push(route.request().postDataJSON());
    if (alter) {
      alter = false; const response = await route.fetch(), receipt = await response.json();
      receipt.event.data.body = "A different answer";
      await route.fulfill({ response, json: receipt });
    } else await route.continue();
  });
  await input(page).press("Enter"); await failed(page);
  assert.match(await page.locator("#composer-status").textContent(), /Save not confirmed/);
  assert.equal(await input(page).evaluate(el => el.readOnly), true);
  await page.locator("#request-exit").click(); assert.equal(await input(page).inputValue(), "Ordinary draft");
  await options(page); await page.locator("#request-reply").click();
  assert.equal(await input(page).inputValue(), "An explicit question");
  await page.getByRole("button", { name: "Retry original", exact: true }).click(); await saved(page);
  assert.deepEqual(commands[0], commands[1]);
  assert.equal(Object.keys(f.state().replyRequests).length, 1);
  assert.equal(await input(page).inputValue(), "Ordinary draft"); assert.deepEqual(f.errors, []);
});
