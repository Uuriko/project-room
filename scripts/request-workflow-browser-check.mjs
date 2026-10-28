// Synthetic human journeys using the real local service and disposable data.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { ensureSidebarClosed, openDirectConversation } from "./room-chrome.mjs";

const REQUEST = "private-workflow-request";
const BODY = "Which private agenda should we use?";
const DRAFT = "Keep this private draft for the owner";

for (const width of [390, 1280]) test(`older request at ${width}px: history loads only for the current navigation`, { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture({ dmConsent: true });
  const now = f.store.now; let offset = 0;
  f.store.now = () => now() + offset;
  const send = data => f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted", data });
  send({ messageId: REQUEST, body: BODY, toMemberId: "guest", requestKind: "reply", workItemId: "test-handoff" });
  for (let i = 0; i < 130; i++) { offset += 2500; send({ messageId: `recent-${i}`, body: `Recent shared discussion ${i}` }); }
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const errors = [];
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage(); page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  let firstWindow;
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.pathname === "/api/rooms/commons" && url.searchParams.get("messages") === "recent" && !firstWindow) firstWindow = response.json();
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await signInFixture(page, f.keys.guest);
  await page.locator("#main").waitFor({ state: "visible" });
  assert.ok(firstWindow, "captured the actual recent snapshot response");
  assert.equal((await firstWindow).state.messages.some(message => message.id === REQUEST), false, "request is outside the initial recent window");
  await page.locator("#topbar-updates").click();
  await page.locator('[data-update-filter="requests"]').click();
  const requestRow = page.locator(`[data-update-id="${REQUEST}"]`);
  await requestRow.waitFor({ state: "visible" });
  let releaseHistory, capturedHistory;
  const gate = new Promise(resolve => { releaseHistory = resolve; });
  const captured = new Promise(resolve => { capturedHistory = resolve; });
  const delayHistory = async route => {
    const response = await route.fetch(); capturedHistory(); await gate; await route.fulfill({ response });
  };
  await page.route("**/conversation?**", delayHistory);
  await requestRow.locator('[data-update-action="open"]').first().click(); await captured;
  await page.locator('[data-update-filter="waiting"]').click();
  await page.waitForFunction(() => document.querySelector('[data-update-filter="waiting"]')?.getAttribute("aria-selected") === "true" && document.querySelector("#updates-status")?.textContent === "");
  releaseHistory();
  // A request with its body as the title proves the older source has reached
  // the client, while the selected filter and modal still retain ownership.
  await page.unrouteAll({ behavior: "wait" });
  await page.locator('[data-update-filter="requests"]').click();
  await requestRow.waitFor({ state: "visible" });
  await page.waitForFunction(id => document.querySelector(`[data-update-id="${id}"]`)?.textContent.includes("Which private agenda"), REQUEST);
  assert.equal(await page.locator("#updates-dialog").isVisible(), true);
  assert.equal(page.url().includes(`#pr-record/message/${REQUEST}`), false, "late history does not navigate after another tab was selected");
  await requestRow.locator('[data-update-action="open"]').first().click();
  await page.locator("#updates-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(id => document.activeElement?.dataset.messageRecordId === id, REQUEST);
  assert.match(page.url(), /#pr-record\/message\/private-workflow-request$/);
});

for (const [label, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]]) {
  test(`request workflow ${label}: dismissed notice leaves an actionable private request`, { timeout: 60000 }, async t => {
    const f = createAcceptanceFixture({ dmConsent: true });
    f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "member.added", data: {
      memberId: "outsider", displayName: "Uninvolved member", kind: "human", permissions: []
    } });
    f.keys.outsider = f.store.issueAccessKey("commons", "outsider");
    f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted", data: {
      messageId: REQUEST, body: BODY, toMemberId: "guest", requestKind: "reply", workItemId: "test-handoff"
    } });
    const server = createRoomServer({ store: f.store, streamInterval: 40 });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    const errors = [];
    t.after(async () => {
      await browser.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true });
      assert.deepEqual(errors, []);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const login = async who => {
      const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
      const page = await context.newPage();
      page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin); await signInFixture(page, f.keys[who]);
      await page.locator("#main").waitFor({ state: "visible" }); return page;
    };
    const open = async page => {
      await ensureSidebarClosed(page); await page.locator("#topbar-updates").click();
      await page.locator("#updates-dialog").waitFor({ state: "visible" });
    };
    const select = async (page, id) => {
      await page.locator(`[data-update-filter="${id}"]`).click();
      await page.waitForFunction(id => document.querySelector(`[data-update-filter="${id}"]`)?.getAttribute("aria-selected") === "true"
        && document.querySelector("#updates-status")?.textContent === "", id);
    };
    const row = page => page.locator(`[data-update-id="${REQUEST}"]`);
    const state = () => f.store.room("commons").state.replyRequests[REQUEST];
    const guest = await login("guest"), owner = await login("owner"), outsider = await login("outsider");
    await openDirectConversation(guest, "owner");
    await guest.locator("#message-input").fill(DRAFT);
    await open(guest); await select(guest, "needs");
    const notification = guest.locator(".updates-row").filter({ hasText: BODY });
    await notification.waitFor({ state: "visible" });
    const notificationId = await notification.getAttribute("data-update-id");
    assert.notEqual(notificationId, REQUEST, "notification identity is separate from request identity");
    await notification.locator(".updates-open-title").click();
    await guest.locator("#updates-dialog").waitFor({ state: "hidden" });
    await guest.waitForFunction(id => document.activeElement?.dataset.messageRecordId === id, REQUEST);
    assert.match(guest.url(), /#pr-record\/message\/private-workflow-request$/);
    await guest.locator("#work-navigation-return").click();
    await guest.locator("#updates-dialog").waitFor({ state: "visible" });
    await guest.locator(`[data-update-id="${notificationId}"] [data-update-action="clear"]`).click();
    await guest.locator(`[data-update-id="${notificationId}"]`).waitFor({ state: "detached" });
    assert.equal(state().status, "open", "dismissal is not an answer");
    await select(guest, "requests"); await row(guest).waitFor({ state: "visible" });
    assert.equal(await guest.locator('[data-update-filter="requests"]').textContent(), "Requests to me");
    assert.equal(await row(guest).locator('[data-update-action="clear"]').count(), 0, "request view does not offer notification dismissal");
    for (const theme of ["light", "dark"]) {
      await guest.evaluate(theme => document.documentElement.setAttribute("data-theme", theme), theme);
      await guest.locator('[data-update-filter="requests"]').hover();
      const scan = await new AxeBuilder({ page: guest }).include("#updates-dialog").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      assert.deepEqual(scan.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), [], `${theme} selected hovered request tab is accessible`);
      if (process.env.ROOM_DESIGN_REQUEST_DIR) {
        mkdirSync(process.env.ROOM_DESIGN_REQUEST_DIR, { recursive: true });
        await guest.screenshot({ path: join(process.env.ROOM_DESIGN_REQUEST_DIR, `requests-to-me-${label}-${theme}.png`), fullPage: true });
      }
    }
    // An unavailable authoritative read must be visible and recoverable without
    // resolving or dismissing the request.
    let failedReads = 0;
    const refuseIncoming = route => { failedReads++; return route.abort("failed"); };
    await guest.route("**/reply-requests?direction=incoming&status=open", refuseIncoming);
    await guest.locator('[data-update-filter="requests"]').click();
    await guest.waitForFunction(() => {
      const text = document.querySelector("#updates-status")?.textContent;
      return text && !text.startsWith("Loading");
    });
    assert.ok(failedReads > 0, "request fetch reached the failure fixture");
    assert.equal(state().status, "open");
    await guest.unroute("**/reply-requests?direction=incoming&status=open", refuseIncoming);
    await select(guest, "requests"); await row(guest).waitFor({ state: "visible" });
    await open(owner); await select(owner, "waiting"); await row(owner).waitFor({ state: "visible" });
    assert.equal(await owner.locator('[data-update-filter="waiting"]').textContent(), "Waiting on others");
    // A slower response for a previous filter cannot erase the current list.
    let releaseRead, capturedRead;
    const gate = new Promise(resolve => { releaseRead = resolve; });
    const captured = new Promise(resolve => { capturedRead = resolve; });
    const delayedIncoming = async route => {
      const response = await route.fetch(); capturedRead(); await gate;
      await route.fulfill({ response });
    };
    await owner.route("**/reply-requests?direction=incoming&status=open", delayedIncoming);
    await owner.locator('[data-update-filter="requests"]').click(); await captured;
    await select(owner, "waiting"); await row(owner).waitFor({ state: "visible" });
    const delivered = owner.waitForResponse(response => response.url().includes("/reply-requests?direction=incoming&status=open"));
    releaseRead(); await delivered;
    await owner.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await owner.locator('[data-update-filter="waiting"]').getAttribute("aria-selected"), "true");
    assert.equal(await row(owner).isVisible(), true, "late incoming result cannot erase the outgoing request");
    await owner.unroute("**/reply-requests?direction=incoming&status=open", delayedIncoming);
    await open(outsider);
    for (const filter of ["requests", "waiting"]) {
      await select(outsider, filter); assert.equal(await row(outsider).count(), 0);
      assert.equal((await outsider.locator("#updates-dialog").innerText()).includes(BODY), false);
    }
    await row(guest).locator('[data-update-action="open"]').first().click();
    await guest.locator("#updates-dialog").waitFor({ state: "hidden" });
    await guest.waitForFunction(id => document.activeElement?.dataset.messageRecordId === id, REQUEST);
    await guest.locator("#work-navigation-return").click();
    await guest.locator("#updates-dialog").waitFor({ state: "visible" });
    await guest.locator("#updates-close").click();
    await openDirectConversation(guest, "owner");
    assert.equal(await guest.locator("#message-input").inputValue(), DRAFT, "request navigation preserves the original private draft");
    await guest.locator(`[data-message-record-id="${REQUEST}"] [data-message-action="request-answered"]`).click();
    await guest.getByRole("button", { name: "Send answer", exact: true }).waitFor();
    await guest.locator("#message-input").fill("Use the short agenda.");
    await guest.getByRole("button", { name: "Send answer", exact: true }).click();
    await guest.waitForFunction(() => !document.querySelector("#message-input").disabled && document.querySelector("#request-mode-bar").hidden);
    assert.equal(state().status, "answered");
    assert.equal(await guest.locator("#message-input").inputValue(), DRAFT);
    await open(guest); await select(guest, "requests"); assert.equal(await row(guest).count(), 0);
    await select(owner, "waiting"); assert.equal(await row(owner).count(), 0);
  });
}
