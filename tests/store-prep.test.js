// Store listing prep: support/docs pages, env-only domain verification,
// annotations on every listed MCP tool, Cursor plugin manifest, publishable
// room-acp package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { storeRoute } from "../server/store-pages.mjs";
import { withToolAnnotations, toolTitle } from "../server/mcp-tool-annotations.mjs";
import { listedMcpTools, livePublicMcpTools } from "../server/mcp-discovery.mjs";

test("/support and /docs render public HTML with the MCP endpoint", () => {
  for (const path of ["/support", "/docs"]) {
    const r = storeRoute(path, {}, "https://room.example");
    assert.equal(r.status, 200); assert.match(r.type, /text\/html/); assert.match(r.body, /room\.example\/mcp/);
  }
  assert.match(storeRoute("/support", { ROOM_SUPPORT_EMAIL: "help@example.com" }).body, /mailto:help@example\.com/);
  assert.equal(storeRoute("/elsewhere", {}), null);
});

test("domain verification is env-only and 404 when unset or mismatched", () => {
  assert.equal(storeRoute("/.well-known/openai-apps-challenge", {}).status, 404);
  assert.equal(storeRoute("/.well-known/openai-apps-challenge", { ROOM_OPENAI_DOMAIN_VERIFICATION: "<bad>" }).status, 404);
  const ok = storeRoute("/.well-known/openai-apps-challenge", { ROOM_OPENAI_DOMAIN_VERIFICATION: "tok_abcdefgh123" });
  assert.equal(ok.status, 200); assert.equal(ok.body, "tok_abcdefgh123");
  assert.equal(storeRoute("/google1234abcd5678.html", {}).status, 404);
  assert.equal(storeRoute("/google1234abcd5678.html", { ROOM_GOOGLE_SITE_VERIFICATION: "googleffffffffffff" }).status, 404);
  const g = storeRoute("/google1234abcd5678.html", { ROOM_GOOGLE_SITE_VERIFICATION: "google1234abcd5678.html" });
  assert.equal(g.status, 200); assert.equal(g.body, "google-site-verification: google1234abcd5678.html");
});

test("annotations fill gaps, keep given hints, and never mark reads destructive", () => {
  assert.equal(toolTitle("room_read_work"), "Read Work");
  const revoke = withToolAnnotations({ name: "bond_revoke", annotations: { readOnlyHint: false, destructiveHint: false } });
  assert.equal(revoke.annotations.destructiveHint, true);
  const read = withToolAnnotations({ name: "room_list_work", annotations: { destructiveHint: true } });
  assert.equal(read.annotations.readOnlyHint, true); assert.equal(read.annotations.destructiveHint, false);
  assert.equal(withToolAnnotations({ name: "x", annotations: { title: "Kept" } }).annotations.title, "Kept");
});

test("every listed MCP tool has title, readOnlyHint and destructiveHint", () => {
  const all = [...listedMcpTools("core"), ...listedMcpTools("lean"), ...listedMcpTools("full"), ...livePublicMcpTools()];
  assert.ok(all.length > 50);
  for (const t of all) {
    assert.equal(typeof t.annotations?.title, "string", t.name);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean", t.name);
    assert.equal(typeof t.annotations.destructiveHint, "boolean", t.name);
    if (t.annotations.readOnlyHint) assert.equal(t.annotations.destructiveHint, false, t.name);
  }
});

test("Cursor plugin manifest points at the hosted MCP with no secret", () => {
  const m = JSON.parse(readFileSync(new URL("../plugins/project-room/.cursor-plugin/plugin.json", import.meta.url)));
  assert.match(m.name, /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/);
  assert.equal(m.mcpServers["project-room"].url, "https://room.trydemigod.com/mcp");
  assert.ok(!JSON.stringify(m).match(/Bearer|secret|token/i));
});

test("room-acp is publishable but not published from CI", () => {
  const p = JSON.parse(readFileSync(new URL("../room-acp/package.json", import.meta.url)));
  assert.notEqual(p.private, true);
  assert.equal(p.publishConfig.access, "public");
  assert.equal(p.mcpName, "io.github.Uuriko/project-room");
  assert.ok(p.keywords.includes("mcp")); assert.deepEqual(p.files, ["src", "README.md"]);
});
