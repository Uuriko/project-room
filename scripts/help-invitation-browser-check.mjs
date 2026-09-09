// Simulated human UI, actual scripted MCP. Disposable rooms; no model or external work.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "./mcp-test-client.mjs";
import { auditRecovery } from "../server/recovery.mjs";

async function setup(t, touch = false) {
  const f = createAcceptanceFixture(), id = "help-guide", errors = [], traffic = [];
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  send("owner", "work.proposed", { workItemId: id, title: "Contributor guide", definitionOfDone: "A short guide with examples",
    accountableMemberId: "owner", verifierMemberId: "reviewer", independentVerificationRequired: true, mode: "read" });
  send("owner", "work.accepted", { workItemId: id, expectedRevision: 0 });
  const item = () => f.store.room("commons").state.workItems[id];
  const help = (status = "open", scope = "Updated by another session") => send("owner", "work.help_updated", {
    workItemId: id, expectedRevision: item().revision, expectedHelpRevision: item().helpWanted?.revision ?? 0, status,
    ...(status === "open" ? { scope, expiresAt: new Date(Date.now() + 3600000).toISOString() } : {}) });
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: touch, hasTouch: touch, reducedMotion: "reduce" });
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page.on("request", req => { if (req.url().endsWith("/commands") && req.method() === "POST") traffic.push(req.postDataJSON()); });
  const directory = join(f.directory, "agent");
  saveAgentConnection(directory, { version: 1, origin, roomId: "commons", memberId: "producer", token: f.keys.producer });
  const agent = await openMcpTestClient(directory);
  t.after(async () => { await agent.close(); await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  await page.goto(origin);
  await page.locator("#access-key").fill(f.keys.owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  const card = page.locator(`[data-work-record-id="${id}"]`), dialog = page.locator("#action-dialog");
  const save = page.locator("#action-form button[type=submit]"), scope = page.locator("#action-fields [name=scope]");
  const open = async () => {
    if (await card.locator(".work-help").count()) await card.locator(".work-help").evaluate(node => { node.open = true; });
    else await card.locator(".work-details summary").click();
    await card.locator('[data-action=help]').click(); await dialog.waitFor({ state: "visible" });
  };
  const list = async () => {
    const before = auditRecovery(f.store).dataSha256, result = await agent.call("room_list_work", { focus: "help_wanted" });
    assert.equal(result.result.isError, undefined, JSON.stringify(result));
    assert.equal(auditRecovery(f.store).dataSha256, before);
    return result.result.structuredContent.work;
  };
  return { ...f, id, item, help, send, page, card, dialog, save, scope, open, list, errors, traffic };
}

for (const touch of [false, true]) test(`human help ${touch ? "touch" : "desktop"}: publish, discover, edit and withdraw without assignment`, { timeout: 30000 }, async t => {
  const f = await setup(t, touch), { page, card, dialog, save, scope } = f;
  assert.equal(await card.locator("[data-action=help]").isVisible(), false, "Ask is inside Details");
  await page.locator("#message-input").fill("Keep this unsent note");
  assert.equal((await f.list()).length, 0);
  await f.open();
  const text = "Suggest two guide examples. Keep edits in this room. 🪷";
  await scope.fill(text);
  await page.locator("#action-fields [name=duration]").selectOption("3600000");
  mkdirSync("test-results", { recursive: true });
  const prefix = `test-results/human-help-${touch ? "touch" : "desktop"}`;
  await page.screenshot({ path: prefix + "-publish.png" });
  await save.click(); await dialog.waitFor({ state: "hidden" });
  assert.equal(f.item().revision, 1); assert.equal(f.item().helpWanted.scope, text);
  assert.equal(f.item().accountableMemberId, "owner"); assert.equal(f.item().receipt, null);
  assert.equal((await f.list()).find(item => item.id === f.id).help.canOffer, true);
  await card.locator(".work-help summary").click();
  assert.equal(await card.locator(".work-help img").count(), 0);
  assert.match(await card.locator(".work-help").textContent(), /Suggest two guide examples/);
  await page.screenshot({ path: prefix + "-open.png" });
  const expiry = f.item().helpWanted.expiresAt;
  await f.open(); assert.equal(await page.locator("#action-fields [name=duration]").inputValue(), "keep");
  await scope.fill("Suggest one short example. <img src=x onerror=alert(1)>");
  await save.click(); await dialog.waitFor({ state: "hidden" });
  assert.equal(await card.locator(".work-help img").count(), 0, "Untrusted scope is text, not markup");
  assert.equal(f.item().helpWanted.expiresAt, expiry);
  assert.equal(f.item().helpWanted.revision, 2); assert.equal(f.item().revision, 1);
  await card.locator(".work-help").evaluate(node => { node.open = true; });
  await card.locator('[data-action="end-help"]').click(); await save.click(); await dialog.waitFor({ state: "hidden" });
  assert.equal(f.item().helpWanted.status, "withdrawn"); assert.equal((await f.list()).length, 0);
  assert.equal(await page.locator("#message-input").inputValue(), "Keep this unsent note");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.deepEqual(f.errors, []);
  writeFileSync(prefix + ".json", JSON.stringify({ simulatedHuman: true, scriptedMcp: true, nativeModels: false,
    helpInvitationUITested: true, published: true, updated: true, withdrew: true, exactExpiryPreserved: true, workRevision: f.item().revision,
    helpRevision: f.item().helpWanted.revision, composerPreserved: true, invitationBoundOffers: false }, null, 2));
});

test("human help stale scope is pinned and explicit refresh preserves a draft for comparison", async t => {
  const f = await setup(t); f.help(); await f.card.locator(".work-help").waitFor();
  await f.open(); await f.scope.fill("My unsent scope");
  f.help("open", "New scope from another owner session");
  await f.page.waitForFunction(() => document.querySelector("#refresh-action").hidden === false);
  assert.equal(await f.save.isDisabled(), true); assert.equal(await f.scope.inputValue(), "My unsent scope");
  await f.page.locator("#refresh-action").click();
  await f.page.locator("#help-current").waitFor({ state: "visible" });
  assert.match(await f.page.locator("#help-current").textContent(), /New scope from another owner session/);
  assert.equal(await f.scope.inputValue(), "My unsent scope");
  assert.equal(await f.page.locator("#action-fields [name=duration]").inputValue(), "");
  await f.page.locator("#action-fields [name=duration]").selectOption("3600000");
  await f.save.click(); await f.dialog.waitFor({ state: "hidden" });
  assert.equal(f.item().helpWanted.scope, "My unsent scope"); assert.equal(f.item().helpWanted.revision, 3);
  assert.equal(f.traffic.filter(c => c.type === "work.help_updated").at(-1).data.expectedHelpRevision, 2);
  assert.deepEqual(f.errors, []);
});

test("human help a server-side stale refusal requires review rather than overwriting newer scope", async t => {
  const f = await setup(t); let race = true;
  await f.page.route("**/api/rooms/commons/commands", async route => {
    if (race && route.request().postDataJSON().type === "work.help_updated") {
      race = false; f.help("open", "Concurrent scope");
    }
    return route.continue();
  });
  await f.open(); await f.scope.fill("My proposed scope"); await f.save.click();
  await f.page.locator("#refresh-action").waitFor({ state: "visible" });
  assert.equal(await f.scope.inputValue(), "My proposed scope");
  assert.equal(await f.scope.isDisabled(), false, "Known refusal is not an uncertain saved operation");
  assert.equal(await f.save.isDisabled(), true);
  assert.equal(f.item().helpWanted.scope, "Concurrent scope");
  await f.page.locator("#refresh-action").click();
  await f.page.locator("#help-current").waitFor({ state: "visible" });
  await f.save.click(); await f.dialog.waitFor({ state: "hidden" });
  assert.equal(f.item().helpWanted.scope, "My proposed scope");
  const commands = f.traffic.filter(c => c.type === "work.help_updated");
  assert.equal(commands.length, 2); assert.notEqual(commands[0].id, commands[1].id);
  assert.equal(commands[0].data.expectedHelpRevision, 0); assert.equal(commands[1].data.expectedHelpRevision, 1);
});

for (const failure of ["lost-response", "wrong-receipt"]) test(`human help ${failure}: close and exact retry do not reopen withdrawn consent`, async t => {
  const f = await setup(t); let first = true;
  await f.page.route("**/api/rooms/commons/commands", async route => {
    if (route.request().postDataJSON().type !== "work.help_updated" || !first) return route.continue();
    first = false; const response = await route.fetch();
    if (failure === "lost-response") return route.abort();
    const body = await response.json(); body.event.data.scope = "Mismatched receipt";
    return route.fulfill({ response, json: body });
  });
  await f.open(); await f.scope.fill("A bounded invitation");
  await f.save.click(); await f.page.getByRole("button", { name: "Retry original save", exact: true }).waitFor();
  assert.equal(await f.scope.isDisabled(), true);
  const sent = f.traffic.filter(c => c.type === "work.help_updated")[0];
  await f.page.locator("#cancel-action").click(); await f.dialog.waitFor({ state: "hidden" });
  f.help("withdrawn");
  await f.page.locator("#resume-action").click();
  assert.equal(await f.scope.inputValue(), "A bounded invitation");
  await f.save.click(); await f.dialog.waitFor({ state: "hidden" });
  const requests = f.traffic.filter(c => c.type === "work.help_updated");
  assert.equal(requests.length, 2); assert.deepEqual(requests[1], sent);
  assert.equal(f.item().helpWanted.status, "withdrawn"); assert.equal(f.item().helpWanted.revision, 2);
  assert.equal((await f.list()).length, 0); assert.deepEqual(f.errors, []);
});

test("human help expiry retires its label without new events and guest cannot publish", async t => {
  const f = await setup(t);
  f.send("owner", "work.help_updated", { workItemId: f.id, expectedRevision: 1, expectedHelpRevision: 0,
    status: "open", scope: "Short-lived request", expiresAt: new Date(Date.now() + 1500).toISOString() });
  await f.card.getByText("Help wanted", { exact: true }).waitFor();
  const sequence = f.store.room("commons").sequence;
  await f.card.getByText("Help ended", { exact: true }).waitFor();
  assert.equal(f.store.room("commons").sequence, sequence); assert.equal((await f.list()).length, 0);
  f.page.on("dialog", dialog => dialog.accept());
  await f.page.getByRole("button", { name: "Sign out", exact: true }).click();
  await f.page.locator("#access-key").fill(f.keys.guest);
  await f.page.getByRole("button", { name: "Enter room", exact: true }).click();
  await f.page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await f.card.locator("[data-action=help]").count(), 0);
  assert.equal(await f.card.locator('[data-action="end-help"]').count(), 0);
});

test("human owner can end another member's invitation but cannot publish on their behalf", async t => {
  const f = await setup(t);
  f.send("producer", "work.accepted", { workItemId: "test-handoff", expectedRevision: 0 });
  f.send("producer", "work.help_updated", { workItemId: "test-handoff", expectedRevision: 1, expectedHelpRevision: 0,
    status: "open", scope: "Help with my agenda", expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const other = f.page.locator('[data-work-record-id="test-handoff"]');
  await other.locator(".work-help").waitFor();
  assert.equal(await other.locator("[data-action=help]").count(), 0);
  await other.locator(".work-help summary").click();
  await other.locator('[data-action="end-help"]').click();
  assert.equal(await f.page.locator("#help-current").textContent(), "Help with my agenda");
  await f.save.click(); await f.dialog.waitFor({ state: "hidden" });
  assert.equal(f.store.room("commons").state.workItems["test-handoff"].helpWanted.updatedById, "owner");
  assert.equal(await other.locator("[data-action=help]").count(), 0);
});

test("human help large text and keyboard stay usable without permission-driven draft loss", async t => {
  const f = await setup(t, true);
  await f.page.evaluate(() => { document.documentElement.style.fontSize = "24px"; });
  await f.open(); await f.scope.fill("Keep this draft");
  await f.scope.focus();
  for (let i = 0; i < 7; i++) {
    await f.page.keyboard.press("Tab");
    assert.equal(await f.dialog.evaluate(node => node.contains(document.activeElement)), true);
  }
  assert.equal(await f.dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  const owner = f.store.room("commons").state.members.owner;
  f.send("owner", "member.access_changed", { memberId: "owner", expectedMemberRevision: owner.revision,
    active: true, permissions: owner.permissions.filter(permission => permission !== "accept_work") });
  await f.page.waitForFunction(() => document.querySelector("#action-error").textContent.includes("no longer available"));
  assert.equal(await f.scope.inputValue(), "Keep this draft"); assert.equal(await f.save.isDisabled(), true);
  assert.equal(f.traffic.some(c => c.type === "work.help_updated"), false);
  await f.page.locator("#cancel-action").click(); await f.dialog.waitFor({ state: "hidden" });
  assert.deepEqual(f.errors, []);
});
