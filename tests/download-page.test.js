import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { downloadPageHtml, MAC_APP_STATUS, RUNTIME_RELEASE_URL } from "../server/download-page.mjs";
import { llmsTxt } from "../server/agent-discovery.mjs";
import { PACKAGE_VERSION } from "../server/version.mjs";

const MAC = "No public Mac app yet. Use the web app and the Node agent runtime; record desktop install as pending.";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-download-"));
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
  return `http://127.0.0.1:${server.address().port}`;
}

test("GET /download returns honest platform status and the runtime latest link", async t => {
  const origin = await serve(t);
  const response = await fetch(`${origin}/download`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  assert.equal(html, downloadPageHtml());
  assert.match(html, /<h2>Web<\/h2>\s*<p>Ready\./);
  assert.match(html, new RegExp(`Version ${PACKAGE_VERSION}`));
  assert.match(html, /This build is unstamped\. No deployed SHA is available\./);
  assert.match(html, /No build date is available\./);
  assert.match(html, /<h2>Mac<\/h2>\s*<p>Dev build only\./);
  assert.ok(html.includes(MAC_APP_STATUS));
  assert.ok(html.includes(RUNTIME_RELEASE_URL));
  assert.equal(html.includes("official current download"), false);
  assert.equal(/[0-9a-f]{40}/.test(html), false, "an unstamped page must not invent a SHA");
  assert.equal(html.includes("<script"), false);
  const head = await fetch(`${origin}/download`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("setup skill and the short agent index state that there is no public Mac app", () => {
  const skill = readFileSync(new URL("../skills/project-room-setup/SKILL.md", import.meta.url), "utf8");
  const plugin = readFileSync(new URL("../plugins/project-room/skills/project-room-setup/SKILL.md", import.meta.url), "utf8");
  for (const text of [skill, plugin, llmsTxt()]) {
    assert.equal(text.includes("official current download"), false);
    assert.ok(text.includes(MAC));
  }
  const packet = llmsTxt();
  // llms.txt is zero-sum: the <5120-byte cap is fixed. Adding bytes to
  // llmsTxt() requires removing at least as many bytes elsewhere in the
  // same packet, facts preserved. Do not raise this cap and do not split
  // the index to get around it.
  assert.ok(Buffer.byteLength(packet) < 5120, `llms.txt is ${Buffer.byteLength(packet)} bytes; the cap is <5120 and it does not move. llms.txt is zero-sum: adding bytes requires removing at least as many bytes elsewhere in llms.txt (llmsTxt() in server/agent-discovery.mjs), facts preserved.`);
  assert.ok(packet.includes(RUNTIME_RELEASE_URL));
  assert.equal(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, PACKAGE_VERSION);
});
