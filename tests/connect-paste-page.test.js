// S1b: the human "Connect your agent by pasting" page.
// Each runtime gets one paste block that sends the agent to llms.txt, reuses or
// mints its own identity, joins with the invite the human pastes, says hello
// and reports back. No block, and no byte of the page, may carry a credential.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPages, PASTE_PAGE } from "../scripts/build-agent-docs.mjs";
import { publicAssetPaths } from "../deploy/public-assets.mjs";
import { publicSearchAssets, reviewedPublicSearchPaths } from "../deploy/public-search.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const CREDENTIAL = /pri_[A-Za-z0-9_-]{8,}|Bearer\s+(?!\$PROJECT_ROOM_SECRET|<)[A-Za-z0-9._-]{16,}|#join\/[A-Za-z0-9_-]{20,}/;
const RUNTIMES = ["ChatGPT", "Claude", "Cursor", "Grok Bot", "Muse", "Any other agent"];
const unescape = text => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
const blocks = html => [...html.matchAll(/<pre tabindex="0" role="region" aria-label="([^"]*)"><code>([\s\S]*?)<\/code><\/pre>/g)]
  .map(match => ({ label: unescape(match[1]), text: unescape(match[2]) }));

test("one paste block per runtime, each carrying the whole connect loop and no credential", () => {
  const html = agentPages().get(PASTE_PAGE.htmlFile);
  assert.ok(html, "paste page is generated");
  assert.equal(readFileSync(PASTE_PAGE.htmlFile, "utf8"), html, "checked-in page matches the generator");
  const found = blocks(html);
  assert.equal(found.length, RUNTIMES.length, found.map(block => block.label).join(" | "));
  for (const [index, runtime] of RUNTIMES.entries()) {
    const { label, text } = found[index];
    assert.ok(label.startsWith("Paste block: " + runtime), `block ${index} is ${runtime}: ${label}`);
    assert.match(text, /https:\/\/room\.trydemigod\.com\/llms\.txt/, `${runtime} reads llms.txt`);
    assert.match(text, /PASTE-YOUR-INVITE-LINK-HERE/, `${runtime} asks for the human's invite`);
    assert.match(text, /reuse/i, `${runtime} reuses a saved identity`);
    assert.match(text, /\/api\/agent-identities/, `${runtime} mints only when none exists`);
    assert.match(text, /\/api\/share-links\/join-agent/, `${runtime} joins through the invite`);
    assert.match(text, /hello/i, `${runtime} posts a hello`);
    assert.match(text, /Tell me/, `${runtime} reports back`);
    assert.match(text, /never (show|post)|out of this chat|keep its secret and private key private/i, `${runtime} keeps its secret out of chat`);
    assert.match(text, /can't make web requests[\s\S]*stop/i, `${runtime} stops honestly without tools`);
    assert.match(text, /428 proof_required[^\n]*difficulty it states/, `${runtime} reads the proof difficulty instead of assuming one`);
    assert.doesNotMatch(text, CREDENTIAL, `${runtime} block carries no credential`);
  }
  assert.doesNotMatch(html, CREDENTIAL, "no credential anywhere on the page");
  for (const words of ["What an agent is here", "Do it yourself instead", "Pause or remove an agent", "How you know it worked", "Disconnect"]) {
    assert.ok(html.includes(words), `page explains: ${words}`);
  }
});

test("the paste page is a registered public page linked from /docs/agents, and served without scripts", async t => {
  assert.ok(publicAssetPaths.includes(PASTE_PAGE.htmlFile), "registered as a public asset");
  assert.equal(publicSearchAssets(publicAssetPaths).get(PASTE_PAGE.docsPath), PASTE_PAGE.htmlFile);
  assert.ok(reviewedPublicSearchPaths.includes(PASTE_PAGE.docsPath));
  const directory = mkdtempSync(join(tmpdir(), "room-paste-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin + PASTE_PAGE.docsPath);
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy");
  assert.doesNotMatch(csp, /script-src[^;]*'self'/, "no first-party scripts on the marketing CSP");
  const html = await page.text();
  assert.equal(html, readFileSync(PASTE_PAGE.htmlFile, "utf8"));
  assert.doesNotMatch(html, /<script(?! type="application\/ld\+json")/, "only the HowTo data block");
  const index = await (await fetch(origin + "/docs/agents")).text();
  assert.match(index, /href="\/docs\/agents\/paste"/, "/docs/agents links to the paste page");
  const alias = await fetch(origin + PASTE_PAGE.docsPath + ".html", { redirect: "manual" });
  assert.equal(alias.status, 301);
});

test("agents reading the page get their own line, and the new blocks name the app and keep one listener", () => {
  const html = agentPages().get(PASTE_PAGE.htmlFile);
  assert.match(unescape(html), /Are you an AI agent reading this page\?/);
  const found = blocks(html);
  for (const runtime of ["Grok Bot", "Muse"]) {
    const { text } = found.find(block => block.label.startsWith("Paste block: " + runtime));
    assert.match(text, new RegExp(`Name yourself after the app you run in[^\\n]*"${runtime}"`), runtime + " naming rule");
    assert.match(text, /one listener only/, runtime + " uses one listener");
    assert.match(text, /webhook_subscribe/, runtime + " can be woken by webhook");
    // Jill - Dot QA on #2334: agent-wakes/poll needs a registered hostId, so a fresh paste must not send agents there.
    assert.doesNotMatch(text, /agent-wakes\/poll/, runtime + " never points a fresh agent at host-only wake polling");
    assert.match(text, /room_read_messages/, runtime + " has a plain-read fallback");
    assert.doesNotMatch(text, CREDENTIAL);
  }
});
