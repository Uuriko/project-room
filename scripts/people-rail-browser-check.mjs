// People-rail: presence dots, one-line status, loud @agent handles, Done chips.
// Also checks tip #11 Done-chip spring is instant under prefers-reduced-motion.
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
import { fillAccessKey } from "./auth-signin.mjs";

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
  await fillAccessKey(page, owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  if (!(await page.locator("#people-panel").evaluate(node => node.open))) {
    await page.locator("#people-panel > summary").click();
  }
  const hint = page.locator("#people-hint");
  await hint.waitFor();
  // QA-UX 2026-09-19: keep #717's calm merged hint; wake line now carries
  // the distinction between membership and a running execution host.
  assert.match(await hint.textContent(), /Invite people or add an agent to work together/);
  assert.doesNotMatch(await hint.textContent(), /Quill|RC-051|bootstrap-agent-room/);
  assert.match(await page.locator("#people-wake-hint").textContent(), /Agent replies require a connected, running host/);
  assert.equal(await page.locator("#people-wake-hint").evaluate(node => node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth), true, "host requirement is fully readable");
  await page.locator("#create-room-details > summary").click();
  const createCopy = await page.locator("#create-room-details").innerText();
  // UI calming: the Create Room block was de-jargoned — no API route, secret,
  // schema, or fragment explanation; it points at ⌘K → Create Room.
  assert.match(createCopy, /Start your own room/);
  assert.match(createCopy, /⌘K/);
  assert.doesNotMatch(createCopy, /POST \/room\/api\/agent-rooms/);
  assert.doesNotMatch(createCopy, /pri_/);
  assert.doesNotMatch(createCopy, /share https:\/\/www\.getdasha\.com\/room#room/);
  mkdirSync("test-results", { recursive: true });
  await page.locator("#people-panel").screenshot({ path: "test-results/people-rail-create-room.png" });
  const inviteButton = page.locator("#invite-agents-button");
  await inviteButton.waitFor({ state: "visible" });
  await inviteButton.click();
  await page.locator("#agent-invite-dialog").waitFor({ state: "visible" });
  assert.match(await page.locator("#agent-invite-dialog").innerText(), /collaborate or contribute/);
  await page.locator("#agent-invite-mint").click();
  const code = page.locator("#agent-invite-code");
  await code.waitFor({ state: "visible" });
  assert.match(await code.inputValue(), /^RM-/);
  await page.locator("#agent-invite-close").click();
  await page.evaluate(() => { location.hash = "#room/commons"; });
  assert.equal(await page.locator("#people-panel").evaluate(node => node.open), true);
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
  // Context is reducedMotion: "reduce" — chip must be instant, not mid-spring.
  const reduced = await chip.evaluate(el => {
    const style = getComputedStyle(el);
    return { animationName: style.animationName, opacity: style.opacity, transform: style.transform };
  });
  assert.equal(reduced.animationName, "none");
  assert.equal(reduced.opacity, "1");
  assert.equal(reduced.transform, "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  assert.equal(await chip.evaluate(el => getComputedStyle(el).animationName), "done-chip-pop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ownerRow.click();
  assert.match(await page.locator("#message-input").inputValue(), /@Room owner/);
  mkdirSync("test-results", { recursive: true });
  await page.locator("#people-panel").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/people-rail-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#sidebar-toggle").click();
  await page.locator("#people-panel").evaluate(node => { node.open = true; node.scrollIntoView({ block: "start" }); });
  await codex.waitFor();
  await page.screenshot({ path: "test-results/people-rail-mobile.png" });
  assert.equal(errors.join("\n"), "");
});
