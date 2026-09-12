import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { ROOM_ORIGIN, COMPUTE_DOOR } from "../deploy/agent-discovery.mjs";

for (const touch of [false, true]) {
  test(`public /room door ${touch ? "mobile" : "desktop"}: Join + Connect, not the llms packet`, { timeout: 60000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "room-door-"));
    const store = new RoomStore(join(directory, "room.sqlite"));
    const server = createRoomServer({ store });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    t.after(async () => {
      await browser?.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: touch ? { width: 390, height: 844 } : { width: 1360, height: 900 },
      hasTouch: touch, isMobile: touch, reducedMotion: "reduce"
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`${origin}/room`);
    assert.equal(await page.title(), "Project Room");
    assert.match(await page.locator("h1").innerText(), /Project Room/);
    assert.match(await page.locator(".lead").innerText(), /Work Items, next actions, receipts/);
    const open = page.getByRole("link", { name: "Open", exact: true });
    const join = page.getByRole("link", { name: "Join", exact: true });
    const connect = page.getByRole("link", { name: "Connect an agent", exact: true });
    assert.equal(await open.getAttribute("href"), ROOM_ORIGIN);
    assert.equal(await join.getAttribute("href"), `${ROOM_ORIGIN}/#join/`);
    assert.equal(await connect.getAttribute("href"), "#connect");
    await connect.click();
    await page.locator("#connect").waitFor();
    assert.match(await page.locator("#connect").innerText(), /Agent handles stay loud/);
    assert.match(await page.locator("#connect").innerText(), /Done lands as a receipt/);
    assert.equal(await page.locator("#connect a", { hasText: "Packet" }).getAttribute("href"), "/room/llms.txt");
    assert.equal(await page.locator("#connect a", { hasText: "Claude Code" }).getAttribute("href"), "/room/llms.txt");
    assert.equal(await page.locator("#connect a", { hasText: "Codex" }).getAttribute("href"), "/room/llms.txt");
    assert.equal(await page.locator("#connect a", { hasText: "OpenCode" }).getAttribute("href"), "/room/llms.txt");
    assert.equal(await page.locator("#connect a", { hasText: "Cursor" }).getAttribute("href"), "/room/llms.txt");
    assert.equal(await page.locator(".compute a").getAttribute("href"), COMPUTE_DOOR);
    assert.equal(await page.locator("script").count(), 0);
    assert.doesNotMatch(await page.content(), /# Project Room|Bearer |ROOM_AGENT_TOKEN/i);
    const workspace = await page.request.get(`${origin}/`);
    assert.match(workspace.headers()["content-type"], /text\/html/);
    assert.match(await workspace.text(), /message-input/);
    const packet = await page.request.get(`${origin}/room/llms.txt`);
    assert.match(packet.headers()["content-type"], /text\/plain/);
    assert.match(await packet.text(), /# Project Room/);
  });
}
