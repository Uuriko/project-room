// Tasks › Board: columns, a keyboard claim, collapsed chat lines, 390px, and axe.
// The room page and the work-claim HTTP API are the boundary. No test doubles.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";

const shots = "/opt/cursor/artifacts/screenshots";

function github() {
  const body = JSON.stringify({ sha: "c".repeat(40) });
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body)
  });
}

async function post(page, origin, path, data, status = 200) {
  const session = await page.request.get(`${origin}/api/session`);
  assert.equal(session.ok(), true);
  const { csrf } = await session.json();
  const response = await page.request.post(`${origin}/api/rooms/commons${path}`, {
    headers: { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    data
  });
  assert.equal(response.status(), status, await response.text());
}

async function axe(page) {
  const result = await new AxeBuilder({ page })
    .include("#board-dialog")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = result.violations.filter(item => item.impact === "serious" || item.impact === "critical");
  assert.deepEqual(serious.map(item => `${item.impact} ${item.id}`), []);
}

test("board columns, keyboard claim, chat line, 390px, and axe", { timeout: 60000 }, async t => {
  mkdirSync(shots, { recursive: true });
  mkdirSync("test-results", { recursive: true });
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 40, fetchPullRequest: github() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#tasks-board-open").click();
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  await page.locator(".board-empty").waitFor();
  assert.equal(await page.locator(".board-empty").innerText(), "Claim work so others don't collide. Agents can do this over MCP.");
  assert.match(await page.locator(".live-chip").innerText(), /Live vs main/);
  await page.screenshot({ path: `${shots}/board-before.png` });
  await page.screenshot({ path: "test-results/board-before.png" });
  await page.locator("#board-close").click();

  await post(page, origin, "/work-claims", { id: "notes", title: "Write the notes" }, 201);
  await post(page, origin, "/work-claims", {
    id: "copy", title: "Write the copy", files: ["src/board-ui.js", "src/board.css", "docs/WORK-CLAIMS.md"]
  }, 201);
  await post(page, origin, "/work-claims/copy/claim", {});
  await post(page, origin, "/work-claims", {
    id: "reviewpr", title: "Review the pull", pullRequest: "https://github.com/Uuriko/project-room/pull/1303"
  }, 201);
  await post(page, origin, "/work-claims/reviewpr/claim", {});
  await post(page, origin, "/work-claims", { id: "stuck", title: "Stuck on a check" }, 201);
  await post(page, origin, "/work-claims/stuck/claim", {});
  await post(page, origin, "/work-claims/stuck/update", { state: "blocked" });
  await post(page, origin, "/work-claims", { id: "shipped", title: "Shipped the notes" }, 201);
  await post(page, origin, "/work-claims/shipped/claim", {});
  await post(page, origin, "/work-claims/shipped/update", { state: "in_progress" });
  await post(page, origin, "/work-claims/shipped/update", { state: "done" });
  await post(page, origin, "/work-claims", { id: "waiting", title: "After the copy", dependsOn: ["copy"] }, 201);

  const copyLine = page.locator("[data-claim-update='copy']");
  await copyLine.waitFor();
  assert.equal(await copyLine.count(), 1);
  assert.match(await copyLine.innerText(), /claimed Write the copy · 3 files · lease \d+h/);

  await page.keyboard.press("Control+k");
  await page.locator("#room-actions-query").waitFor();
  await page.keyboard.type("board");
  await page.keyboard.press("Enter");
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  await page.locator("article[data-claim-id='notes']").waitFor();
  const card = (name, id) => page.locator(`[aria-labelledby='board-col-${name}'] > article[data-claim-id='${id}']`);
  assert.equal(await card("ready", "notes").count(), 1);
  assert.equal(await card("ready", "waiting").count(), 0);
  assert.equal(await card("claimed", "copy").count(), 1);
  assert.equal(await card("blocked", "stuck").count(), 1);
  assert.equal(await card("review", "reviewpr").count(), 1);
  assert.match(await card("review", "reviewpr").innerText(), /PR #1303/);
  assert.equal(await card("landed", "shipped").count(), 1);
  assert.equal(await page.locator("#board-close-stale").count(), 1);

  for (let step = 0; step < 40; step += 1) {
    if (await page.evaluate(() => document.activeElement?.dataset?.claimAction === "claim" && document.activeElement?.dataset?.claimId === "notes")) break;
    await page.keyboard.press("Tab");
  }
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.claimId), "notes");
  await page.keyboard.press("Enter");
  await page.locator("[aria-labelledby='board-col-claimed'] article[data-claim-id='notes']").waitFor();
  assert.equal(await page.locator("[aria-labelledby='board-col-ready'] article[data-claim-id='notes']").count(), 0);
  await page.screenshot({ path: `${shots}/board-after.png` });
  await page.screenshot({ path: "test-results/board-after.png" });
  await axe(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#board-dialog").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await page.screenshot({ path: `${shots}/board-after-390.png` });
  await page.screenshot({ path: "test-results/board-after-390.png" });
  await axe(page);
});
