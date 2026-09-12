// People-rail: presence dots, one-line status, loud @agent handles, Done chips.
// Real browser + local HTTP service; identities and keys are disposable fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

test("People rail shows presence, what they're on, loud @handles, and Done chips", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-people-rail-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", command(T.MEMBER_ADDED, {
    memberId: "codex", displayName: "Codex", kind: "agent",
    permissions: ["accept_work", "complete_work"]
  }));
  store.command(owner, "commons", command(T.MEMBER_ADDED, {
    memberId: "instinct", displayName: "Instinct", kind: "agent",
    permissions: ["accept_work", "complete_work", "verify"]
  }));
  const agent = store.issueAccessKey("commons", "codex");
  store.command(owner, "commons", command(T.WORK_PROPOSED, {
    workItemId: "work-review", title: "Review the Project Room v0 contract",
    definitionOfDone: "Exact spec revision is checked.",
    accountableMemberId: "codex", mode: "read"
  }));
  store.command(agent, "commons", command(T.WORK_ACCEPTED, { workItemId: "work-review", expectedRevision: 0 }));
  store.command(agent, "commons", command(T.WORK_STARTED, { workItemId: "work-review", expectedRevision: 1 }));
  store.command(agent, "commons", command(T.WORK_COMPLETED, {
    workItemId: "work-review", expectedRevision: 2, producerId: "codex",
    summary: "Four consistency corrections before implementation.",
    evidenceUrl: "https://example.invalid/review", evidenceVersion: "v1",
    nextAction: "Keep the receipt on the rail"
  }));
  store.command(owner, "commons", command(T.WORK_PROPOSED, {
    workItemId: "work-build", title: "Build the first executable Room slice",
    definitionOfDone: "A browser prototype replays the loop.",
    accountableMemberId: "codex", mode: "read"
  }));
  store.command(agent, "commons", command(T.WORK_ACCEPTED, { workItemId: "work-build", expectedRevision: 0 }));
  store.command(agent, "commons", command(T.WORK_STARTED, { workItemId: "work-build", expectedRevision: 1 }));

  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, page;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })).newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await page.locator("#access-key").fill(owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#people-panel > summary").click();
  const hint = page.locator("#people-hint");
  await hint.waitFor();
  assert.match(await hint.textContent(), /Agent handles stay loud/);
  const codex = page.locator('#presence-list .presence-member[data-member-record-id="codex"]');
  const instinct = page.locator('#presence-list .presence-member[data-member-record-id="instinct"]');
  const ownerRow = page.locator('#presence-list .presence-member[data-member-record-id="owner"]');
  await codex.waitFor();
  assert.equal(await codex.getAttribute("data-presence"), "online");
  assert.equal(await instinct.getAttribute("data-presence"), "away");
  assert.equal(await codex.locator(".member-handle-agent").textContent(), "@Codex");
  assert.equal(await instinct.locator(".member-handle-agent").textContent(), "@Instinct");
  assert.doesNotMatch(await ownerRow.locator(".member-handle").textContent(), /^@/);
  assert.equal(await codex.locator(".member-status").textContent(), "Build the first executable Room slice");
  assert.equal(await instinct.locator(".member-status").textContent(), "Agent");
  const chip = codex.locator(".done-chip");
  assert.equal(await chip.textContent(), "Done");
  assert.equal(await chip.getAttribute("data-done-work"), "work-review");
  assert.match(await chip.getAttribute("title"), /consistency corrections/);
  assert.equal(await instinct.locator(".done-chip").count(), 0);
  await ownerRow.click();
  assert.match(await page.locator("#message-input").inputValue(), /@Room owner/);
  mkdirSync("test-results", { recursive: true });
  await page.locator("#people-panel").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/people-rail-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-room-section="people"]').click();
  await page.locator("#people-panel").evaluate(node => { node.open = true; node.scrollIntoView({ block: "start" }); });
  await codex.waitFor();
  await page.screenshot({ path: "test-results/people-rail-mobile.png" });
  assert.equal(errors.join("\n"), "");
});
