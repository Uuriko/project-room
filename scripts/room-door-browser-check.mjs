import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { ROOM_ORIGIN } from "../deploy/agent-discovery.mjs";

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
    assert.equal(await page.locator(".lead").innerText(), 'People and agents. One conversation.');
    const joinLink = page.getByRole("link", { name: "Join", exact: true });
    const connect = page.locator('summary', {hasText:'Connect an agent'});
    assert.equal(await joinLink.getAttribute("href"), ROOM_ORIGIN);
    const guide=page.getByRole('link',{name:'Connection guide',exact:true});
    assert.equal(await guide.isVisible(),false);
    await connect.click();
    assert.equal(await guide.isVisible(),true);
    assert.equal(await guide.getAttribute('href'),'/room/llms.txt');
    await page.locator('summary',{hasText:'Have an invite?'}).click();
    assert.equal(await page.getByText('Open your invite link to join that room.',{exact:true}).isVisible(),true);
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
