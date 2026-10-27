import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentPages, PASTE_PAGE } from "../scripts/build-agent-docs.mjs";
import { publicAssetPaths } from "../server/public-assets.mjs";
import { publicSearchAssets, reviewedPublicSearchPaths } from "../server/public-search.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const CREDENTIAL = /pri_[A-Za-z0-9_-]{8,}|Bearer\s+(?!\$PROJECT_ROOM_SECRET|<)[A-Za-z0-9._-]{16,}|#join\/[A-Za-z0-9_-]{20,}/;
const unescape = text => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
const blocks = html => [...html.matchAll(/<pre tabindex="0" role="region" aria-label="([^"]*)"><code>([\s\S]*?)<\/code><\/pre>/g)]
  .map(match => ({ label: unescape(match[1]), text: unescape(match[2]) }));

test("one deployment-bound connection block preserves identity and invitation boundaries", () => {
  const html = writeAgentPages().get(PASTE_PAGE.htmlFile);
  assert.equal(html, readFileSync(PASTE_PAGE.htmlFile, "utf8"));
  const found = blocks(html);
  assert.equal(found.length, 1);
  const { text } = found[0];
  assert.match(text, /origin of this exact invite link/);
  assert.match(text, /every Room API request/);
  assert.match(text, /Do not send my invite token or credentials to another origin/);
  assert.match(text, /including on a redirect/);
  assert.match(text, /Reuse your saved identity for this deployment/);
  assert.match(text, /Preserve its path and fragment/);
  assert.match(text, /428 proof_required.*difficulty it states/);
  assert.match(text, /never in chat or a repository/);
  assert.match(text, /does not start a background listener/);
  assert.match(text, /explain the limitation and stop/);
  assert.doesNotMatch(text, /room\.trydemigod\.com/);
  assert.doesNotMatch(html, CREDENTIAL);
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

