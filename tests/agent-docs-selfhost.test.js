// Self-hosted /docs/agents: a fresh checkout has no build step, so the
// generated agent-docs pages (docs/agents/*.html, rendered from the
// committed .md sources and never committed) are absent and the asset
// handler's designed fall-through answers 404 — while /llms.txt names
// /docs/agents as the connection guide. The Node entry generates any
// missing pages at boot (server/agent-docs-boot.mjs); this pins that
// generation and that the pages then serve at the advertised URLs.
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentPages } from "../scripts/build-agent-docs.mjs";
import { ensureAgentDocs } from "../server/agent-docs-boot.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("boot generation writes the missing agent-docs pages and they serve at /docs/agents", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-docs-selfhost-"));
  try {
    cpSync(join(repoRoot, "docs", "agents"), join(root, "docs", "agents"), { recursive: true });
    // A fresh checkout carries the sources only; the dev tree may already
    // hold generated pages (the test pretest builds them), so strip any
    // .html from the copy to reproduce the checkout state.
    for (const name of readdirSync(join(root, "docs", "agents"))) {
      if (name.endsWith(".html")) rmSync(join(root, "docs", "agents", name));
    }
    // Precondition: a fresh checkout carries the sources only.
    assert.equal(existsSync(join(root, "docs", "agents", "index.html")), false);
    assert.equal(existsSync(join(root, "docs", "agents", "paste.html")), false);

    const expected = agentPages(join(repoRoot, "docs", "agents"));
    const written = await ensureAgentDocs(root);
    assert.equal(written, expected.size);
    const index = readFileSync(join(root, "docs", "agents", "index.html"), "utf8");
    assert.equal(index, expected.get("docs/agents/index.html"));
    assert.match(index, /<title>Connect to Project Room/);
    const paste = readFileSync(join(root, "docs", "agents", "paste.html"), "utf8");
    assert.equal(paste, expected.get("docs/agents/paste.html"));
    assert.match(paste, /<title>Connect ChatGPT Dot or another agent to Project Room<\/title>/);

    // A second boot leaves the generated pages untouched.
    assert.equal(await ensureAgentDocs(root), 0);

    // The generated pages serve at the URLs llms.txt advertises.
    const store = new RoomStore(join(root, "room.sqlite"));
    const server = createRoomServer({ store, assetRoot: pathToFileURL(root + "/") });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const indexRes = await fetch(`${origin}/docs/agents`, { headers: { Accept: "text/html" } });
      assert.equal(indexRes.status, 200);
      assert.match(await indexRes.text(), /<title>Connect to Project Room/);
      const pasteRes = await fetch(`${origin}/docs/agents/paste`, { headers: { Accept: "text/html" } });
      assert.equal(pasteRes.status, 200);
      assert.match(await pasteRes.text(), /<title>Connect ChatGPT Dot or another agent to Project Room<\/title>/);
    } finally {
      server.close();
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
