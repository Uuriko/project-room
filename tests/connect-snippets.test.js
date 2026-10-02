import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { connectSnippets, installLinkFor, renderedSnippet } from "../server/connect-snippets.mjs";
import { agentPages } from "../scripts/build-agent-docs.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const SECRET = /pri_[A-Za-z0-9_-]{8,}/;

test("every connect snippet names the env var, has a docs page, and contains no identity secret", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-docs-"));
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
  assert.equal(connectSnippets.length, 9);
  const pages = agentPages();
  for (const [file, html] of pages) assert.equal(readFileSync(file, "utf8"), html, file);
  const index = await fetch(origin + "/docs/agents");
  assert.equal(index.status, 200);
  assert.equal(index.headers.get("x-robots-tag"), "all");
  const indexHtml = await index.text();
  const indexData = JSON.parse(indexHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(indexData["@type"], "HowTo");
  for (const tool of connectSnippets) {
    const snippet = renderedSnippet(tool);
    assert.doesNotMatch(snippet, SECRET, tool.id);
    if (tool.id === "aider") assert.match(snippet, /CONVENTIONS\.md/);
    else assert.match(snippet, /PROJECT_ROOM_SECRET/);
    const link = installLinkFor(tool.id);
    if (link) assert.doesNotMatch(link, SECRET, tool.id);
    const page = await fetch(origin + tool.docsPath);
    assert.equal(page.status, 200, tool.docsPath);
    assert.equal(page.headers.get("x-robots-tag"), "all", tool.docsPath);
    assert.match(page.headers.get("content-security-policy"), /style-src 'unsafe-inline'/, tool.docsPath);
    const html = await page.text();
    const visible = tool.command.replaceAll("<", "(?:<|&lt;)").replaceAll(">", "(?:>|&gt;)");
    assert.match(html, new RegExp(visible), tool.id);
    assert.doesNotMatch(html, SECRET, tool.id);
    assert.match(html, new RegExp(`href="/examples/integrations/${tool.id}/README.md"`));
    const data = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(data["@type"], "HowTo");
    assert.ok(data.step.length >= 4, tool.id);
    assert.match(indexHtml, new RegExp(`href="${tool.docsPath}"`));
    const example = await fetch(origin + `/examples/integrations/${tool.id}/README.md`);
    assert.equal(example.status, 200, tool.id);
    assert.doesNotMatch(await example.text(), SECRET);
    const alias = await fetch(origin + tool.docsPath + ".html", { redirect: "manual" });
    assert.equal(alias.status, 301, tool.id);
    assert.equal(alias.headers.get("location"), tool.docsPath);
  }
});
