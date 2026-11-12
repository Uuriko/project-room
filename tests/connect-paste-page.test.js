import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentPages, PASTE_PAGE } from "../scripts/build-agent-docs.mjs";
import { AGENT_PASTE_COPY_HASH, AGENT_PASTE_COPY_SCRIPT, renderAgentPasteOrigin } from "../server/agent-paste-copy.mjs";
import { publicAssetPaths } from "../server/public-assets.mjs";
import { publicSearchAssets, reviewedPublicSearchPaths } from "../server/public-search.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const CREDENTIAL = /pri_[A-Za-z0-9_-]{8,}|Bearer\s+(?!\$PROJECT_ROOM_SECRET|<)[A-Za-z0-9._-]{16,}|#join\/[A-Za-z0-9_-]{20,}/;
const unescape = text => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
const blocks = html => [...html.matchAll(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/g)].map(match => ({ text: unescape(match[1]) }));

test("direct HTTP connection instructions preserve identity and invitation boundaries", () => {
  const html = writeAgentPages().get(PASTE_PAGE.htmlFile);
  assert.equal(html, readFileSync(PASTE_PAGE.htmlFile, "utf8"));
  const found = blocks(html);
  const matching = found.filter(block => block.text.includes("Read /llms.txt on the supplied invitation's exact HTTP(S) origin"));
  assert.equal(matching.length, 1);
  const { text } = matching[0];
  assert.match(text, /Keep invitation paths and fragments/);
  assert.match(text, /Do not send credentials or invitation tokens to another origin, including on redirects/);
  assert.match(text, /Reuse your saved identity/);
  assert.match(text, /Save credentials privately/);
  assert.match(text, /documented identity enrollment and proof challenge/);
  assert.match(text, /stable request ID/);
  assert.match(text, /Joining does not start a background listener/);
  assert.match(text, /report that exact limitation/);
  assert.match(text, /Do not create a replacement identity/);
  assert.doesNotMatch(html, CREDENTIAL);
});

test("the paste page is a registered public page linked from /docs/agents, with a narrowly scoped copy script", async t => {
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
  assert.equal(html, renderAgentPasteOrigin(readFileSync(PASTE_PAGE.htmlFile, "utf8"), origin));
  assert.ok(blocks(html)[0].text.includes(`${origin}/mcp`));
  assert.ok(!blocks(html)[0].text.includes('https://room.trydemigod.com'));
  assert.ok(csp.includes(`'sha256-${AGENT_PASTE_COPY_HASH}'`));
  assert.ok(html.includes(`<script>${AGENT_PASTE_COPY_SCRIPT}</script>`));
  assert.equal((html.match(/<script(?! type="application\/ld\+json")/g) || []).length, 1);
  const index = await (await fetch(origin + "/docs/agents")).text();
  assert.match(index, /href="\/docs\/agents\/paste"/, "/docs/agents links to the paste page");
  const alias = await fetch(origin + PASTE_PAGE.docsPath + ".html", { redirect: "manual" });
  assert.equal(alias.status, 301);
});

