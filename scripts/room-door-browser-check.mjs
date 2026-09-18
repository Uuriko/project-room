import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
    assert.match(await page.locator(".join-note").innerText(), /Joining as a person or an agent is free/);
    assert.match(await page.locator(".spine").innerText(), /your Second \/ their agents \/ one Room/);
    const open = page.getByRole("link", { name: "Open", exact: true });
    const joinLink = page.getByRole("link", { name: "Join", exact: true });
    const connect = page.getByRole("link", { name: "Connect an agent", exact: true });
    const people = page.getByRole("link", { name: "People", exact: true });
    assert.equal(await open.getAttribute("href"), ROOM_ORIGIN);
    assert.equal(await joinLink.getAttribute("href"), `${ROOM_ORIGIN}/#join/`);
    assert.equal(await connect.getAttribute("href"), "#connect");
    assert.equal(await people.getAttribute("href"), "#people");
    await page.goto(`${origin}/room#room/grok-muse-potter-20260918`);
    assert.equal(await page.getByRole("link", { name: "Open", exact: true }).getAttribute("href"), `${ROOM_ORIGIN}/?room=grok-muse-potter-20260918#room/grok-muse-potter-20260918`);
    assert.equal(await page.getByRole("link", { name: "People", exact: true }).getAttribute("href"), `${ROOM_ORIGIN}/?room=grok-muse-potter-20260918#room/grok-muse-potter-20260918`);
    await connect.click();
    await page.locator("#connect").waitFor();
    // Plain-language copy replaced the shorthand ("Agent handles stay loud", "Member+kit", ...).
    assert.match(await page.locator("body").innerText(), /Joining as a person or an agent is free/);
    const connectText = await page.locator("#connect").innerText();
    assert.match(connectText, /your Second \/ their agents \/ one Room/);
    assert.match(connectText, /Create Room/);
    assert.match(connectText, /bootstrap-agent-room/);
    assert.match(connectText, /POST \/room\/api\/agent-rooms/);
    assert.match(connectText, /Invite agents/);
    assert.match(connectText, /collaborate\/contribute/);
    assert.match(connectText, /#room\/\{roomId\}/);
    assert.match(connectText, /Open this invite link/);
    assert.doesNotMatch(connectText, /Share https:\/\/www\.getdasha\.com\/room#room/);
    assert.match(connectText, /Wake, Pull, Desktop, and Takeover/);
    assert.match(connectText, /Invite teammates and AI agents to work on the same items together/);
    assert.match(connectText, /Rooms are private by default\. Adding an agent never lists the room publicly/);
    assert.match(connectText, /choose “Use my AI” and paste the agent packet/);
    assert.match(connectText, /Never paste a room key into a chat/);
    assert.match(connectText, /Agents keep a visible @handle, and finished work lands as a receipt/);
    assert.match(connectText, /short-lived guest agent link \(it starts with ga1\.\)/);
    assert.match(connectText, /enrolls a lasting agent with its own key/);
    assert.match(connectText, /one to research, one to edit, one to plan/);
    assert.match(connectText, /a mid-task steer becomes a handoff note, not a cancellation/);
    assert.doesNotMatch(connectText, /marketplace|Agent handles stay loud|Member\+kit|frontier member|Genie/i);
    // One packet link; the other links point at genuinely different documents.
    assert.equal(await page.getByRole("link", { name: "Read the agent packet (llms.txt)" }).getAttribute("href"), "/room/llms.txt");
    assert.equal(await page.locator('#connect a[href="/room/llms.txt"]').count(), 1);
    assert.equal(await page.getByRole("link", { name: "Full packet" }).getAttribute("href"), "/room/llms-full.txt");
    assert.equal(await page.getByRole("link", { name: "Machine card (agent.json)" }).getAttribute("href"), "/room/.well-known/agent.json");
    assert.equal(await page.getByRole("link", { name: "Kits catalog" }).getAttribute("href"), "/room/kits");
    assert.match(await page.locator(".works-with").innerText(), /Works with Claude Code, Codex, OpenCode, Cursor/);
    assert.equal(await page.locator(".works-with a").count(), 0);
    assert.equal(await page.locator(".compute a").first().getAttribute("href"), COMPUTE_DOOR);
    assert.equal(await page.getByRole("link", { name: "github.com/Uuriko/project-room" }).getAttribute("href"), "https://github.com/Uuriko/project-room");
    assert.equal(await page.locator("script").count(), 1);
    assert.doesNotMatch(await page.content(), /# Project Room|Bearer |ROOM_AGENT_TOKEN|Genie/i);
    mkdirSync("test-results", { recursive: true });
    await page.screenshot({ path: touch ? "test-results/room-door-connect-people-mobile.png" : "test-results/room-door-connect-people-desktop.png", fullPage: true });
    const workspace = await page.request.get(`${origin}/`);
    assert.match(workspace.headers()["content-type"], /text\/html/);
    assert.match(await workspace.text(), /message-input/);
    const packet = await page.request.get(`${origin}/room/llms.txt`);
    assert.match(packet.headers()["content-type"], /text\/plain/);
    assert.match(await packet.text(), /# Project Room/);
  });
}
