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
    assert.match(await page.locator(".join-note").innerText(), /Open this invite link to join as a person/);
    assert.match(await page.locator(".join-note").innerText(), /Joining as a person or an agent is free/);
    assert.match(await page.locator(".spine").innerText(), /your Second \/ their agents \/ one Room/);
    const open = page.getByRole("link", { name: "Open", exact: true });
    const joinLink = page.getByRole("link", { name: "Join", exact: true });
    const paste = page.getByRole("link", { name: "Paste a prompt", exact: true });
    const people = page.getByRole("link", { name: "People", exact: true });
    assert.equal(await open.getAttribute("href"), ROOM_ORIGIN);
    assert.equal(await joinLink.getAttribute("href"), `${ROOM_ORIGIN}/#join/`);
    assert.equal(await paste.getAttribute("href"), "#join-agent");
    assert.equal(await people.getAttribute("href"), "#people");
    assert.equal(await page.locator(".actions a").count(), 2, "first paint is Open + Join");
    assert.equal(await page.locator(".actions .open").count(), 1);
    assert.equal(await page.locator(".whispers .whisper").count(), 2, "People + Join with code are whispers");
    assert.equal(await page.getByRole("heading", { name: "Connect", exact: true }).count(), 1);
    assert.equal(await page.getByRole("link", { name: "Connect an agent", exact: true }).count(), 0);
    const mcp = page.getByRole("link", { name: "Add Room as MCP", exact: true });
    assert.equal(await mcp.getAttribute("href"), "https://www.getdasha.com/room/mcp");
    assert.equal(await page.locator("#mcp-join-url").inputValue(), "https://www.getdasha.com/room/mcp");
    assert.match(await page.locator("#connect").innerText(), /GET snippets\. No OAuth\. No keys\./);
    assert.match(await page.locator("#connect").innerText(), /Invite code/);
    assert.equal(await page.locator('a[href="/room/mcp"]').count(), 1, "#667 same-bytes link lives under the spine");
    assert.equal(await page.getByRole("link", { name: "Join with code", exact: true }).getAttribute("href"), "#join-code");
    await page.goto(`${origin}/room#room/grok-muse-potter-20260918`);
    assert.equal(await page.getByRole("link", { name: "Open", exact: true }).getAttribute("href"), `${ROOM_ORIGIN}/?room=grok-muse-potter-20260918#room/grok-muse-potter-20260918`);
    assert.equal(await page.getByRole("link", { name: "People", exact: true }).getAttribute("href"), `${ROOM_ORIGIN}/?room=grok-muse-potter-20260918#room/grok-muse-potter-20260918`);
    await paste.click();
    await page.locator("#join-agent").waitFor();
    const joinText = await page.locator("#join-agent").innerText();
    assert.match(joinText, /Join from your favorite agent app/i); // CSS text-transform:uppercase on h2
    assert.match(joinText, /Just paste a prompt/);
    assert.match(joinText, /Cursor · Grok Bot · ChatGPT · Codex · Claude · MCP/);
    assert.match(await page.locator("#join-prompt").inputValue(), /Join Project Room as an agent/);
    assert.match(await page.locator("#join-prompt").inputValue(), /No Room key in this chat/);
    assert.ok((await page.getByRole("link", { name: "join.txt", exact: true }).count()) >= 1);
    assert.equal(await page.getByRole("link", { name: "join.txt", exact: true }).first().getAttribute("href"), "/room/join.txt");
    const mcpJoin = page.locator("#mcp-join");
    await mcpJoin.waitFor();
    // Door h2s use text-transform:uppercase; match source text like join-agent.
    assert.match(await page.locator("#mcp-join-title").textContent(), /Add Room as MCP/);
    assert.equal(await page.locator("#mcp-join-url").inputValue(), "https://www.getdasha.com/room/mcp");
    assert.match(await mcpJoin.innerText(), /claude mcp add --transport http/i);
    const joinCode = page.locator("#join-code-form");
    await joinCode.waitFor();
    assert.match(await page.locator("#join-code-title").textContent(), /Join with code/);
    assert.equal(await page.locator("#join-code").getAttribute("placeholder"), "ABC-DEF-GHJ");
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
    assert.match(connectText, /Open this invite link to join as a person/);
    assert.match(connectText, /#room\/\{roomId\}/);
    assert.match(connectText, /Open this invite link/);
    assert.match(connectText, /that is not a shareable invite/);
    assert.doesNotMatch(connectText, /Share https:\/\/www\.getdasha\.com\/room#room/);
    assert.match(connectText, /Wake, Pull, Desktop, and Takeover/);
    assert.match(connectText, /@mention uses Connect Wake\/Pull once Quill's RC-051 lands/);
    assert.match(connectText, /Add Room as MCP/);
    assert.match(connectText, /GET snippets\. No OAuth\. No keys\./);
    assert.match(connectText, /Invite code/);
    assert.match(connectText, /Invite teammates and AI agents to work on the same items together/);
    assert.match(connectText, /Rooms are private by default\. Adding an agent never lists the room publicly/);
    assert.match(connectText, /choose “Use my AI” and paste the agent packet/);
    assert.match(connectText, /Never paste a room key into a chat/);
    assert.match(connectText, /Agents keep a visible @handle, and finished work lands as a receipt/);
    assert.match(connectText, /The room owner issues a short-lived guest invite for a one-off helper\./);
    assert.match(connectText, /enrolls a lasting agent with its own key/);
    assert.match(connectText, /one to research, one to edit, one to plan/);
    assert.match(connectText, /a mid-task steer becomes a handoff note, not a cancellation/);
    assert.match(connectText, /Types for this Room only/);
    assert.match(connectText, /Not a public agent store/);
    assert.match(connectText, /Claude Code/);
    assert.match(connectText, /Hermes/);
    const claude = page.locator('#agent-type-catalog [data-agent-type="claude-code"]');
    assert.equal(await claude.getAttribute("href"), "#mcp-join");
    assert.equal(await page.locator('#agent-type-catalog [data-agent-type="cursor"]').getAttribute("href"), "#join-agent");
    assert.equal(await page.locator('#agent-type-catalog [data-agent-type="pi"]').getAttribute("href"), "#join-code");
    await claude.click();
    await page.locator("#mcp-join").waitFor();
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
    const joinPacket = await page.request.get(`${origin}/room/join.txt`);
    assert.match(joinPacket.headers()["content-type"], /text\/plain/);
    assert.match(await joinPacket.text(), /Join Project Room as an agent/);
    assert.match(await joinPacket.text(), /After paste/);
    const joinToken = "J".repeat(43);
    await page.route(url => {
      try { return new URL(url).origin === new URL(ROOM_ORIGIN).origin; } catch { return false; }
    }, async route => {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Room app</title><p>app</p>" });
    });
    await page.goto(`${origin}/room#join/${joinToken}`);
    await page.waitForURL(url => url.hash === `#join/${joinToken}` && url.origin === new URL(ROOM_ORIGIN).origin);
    assert.equal(page.url(), `${ROOM_ORIGIN}/#join/${joinToken}`);
    await page.goto(`${origin}/room#code/abc-def-ghj`);
    await page.waitForURL(url => url.hash === "#code/ABC-DEF-GHJ" && url.origin === new URL(ROOM_ORIGIN).origin);
    assert.equal(page.url(), `${ROOM_ORIGIN}/#code/ABC-DEF-GHJ`);
    const mcpDoc = await page.request.get(`${origin}/room/mcp`);
    assert.match(mcpDoc.headers()["content-type"], /text\/plain/);
    const mcpText = await mcpDoc.text();
    assert.match(mcpText, /claude mcp add --transport http/);
    // Local Room Worker is host-exact; edge/Demigod advertise the public URL.
    assert.ok(mcpText.includes(`${origin}/mcp`));
  });
}
