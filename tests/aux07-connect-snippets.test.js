// AUX-07: per-host connect snippets carry the identity secret by env var name,
// never by value, and every host (Claude Code, Cursor, Codex, Grok Build) has one.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { roomMcpSnippets, roomMcpJoinText, roomMcpJoinJson, ROOM_MCP_SECRET_ENV, ROOM_MCP_PUBLIC_URL } from "../src/room-mcp-join.js";

const URL_ = "https://room.trydemigod.com/mcp";

test("each hosted snippet sends the bearer from PROJECT_ROOM_SECRET", () => {
  const s = roomMcpSnippets(URL_);
  assert.equal(ROOM_MCP_SECRET_ENV, "PROJECT_ROOM_SECRET");
  assert.equal(s.claude, `claude mcp add --transport http --scope user project-room ${URL_} --header "Authorization: Bearer $PROJECT_ROOM_SECRET"`);
  assert.deepEqual(JSON.parse(JSON.stringify(s.cursor)), { mcpServers: { "project-room": { url: URL_, headers: { Authorization: "Bearer ${env:PROJECT_ROOM_SECRET}" } } } });
  assert.equal(s.codex, `codex mcp add project-room --url ${URL_} --bearer-token-env-var PROJECT_ROOM_SECRET`);
  assert.equal(s.grokBuild, "node scripts/room-roster.mjs grok-build --snippet");
});

test("the plugin .mcp.json and the snippets use the same secret variable", () => {
  const plugin = JSON.parse(readFileSync(new URL("../plugins/project-room/.mcp.json", import.meta.url), "utf8"));
  assert.match(plugin.mcpServers["project-room"].headers.Authorization, new RegExp(`\\$\\{${ROOM_MCP_SECRET_ENV}`));
});

test("join text and JSON name all four hosts and contain no secret value", () => {
  const text = roomMcpJoinText(ROOM_MCP_PUBLIC_URL);
  for (const needle of ["claude mcp add", "~/.cursor/mcp.json", "codex mcp add", "--bearer-token-env-var PROJECT_ROOM_SECRET", "grok-build --snippet", "Never paste the secret"]) {
    assert.ok(text.includes(needle), needle);
  }
  assert.doesNotMatch(text, /pri_[A-Za-z0-9_-]{8,}/);
  const json = roomMcpJoinJson(ROOM_MCP_PUBLIC_URL);
  assert.equal(json.snippets.secretEnv, "PROJECT_ROOM_SECRET");
  assert.equal(json.snippets.grokBuild, "node scripts/room-roster.mjs grok-build --snippet");
});

test("the Grok Build snippet command it points to really prints the TOML", () => {
  const r = spawnSync(process.execPath, ["scripts/room-roster.mjs", "grok-build", "--snippet"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[mcp_servers\.project-room\]/);
  assert.match(r.stdout, /ROOM_AGENT_CONFIG/);
});

test("the connect quickstart shows the Cursor JSON and Grok step the product serves", () => {
  const doc = readFileSync(new URL("../docs/CONNECT-AGENT-QUICKSTART.md", import.meta.url), "utf8");
  assert.ok(doc.includes(JSON.stringify(roomMcpSnippets(URL_).cursor)), "Cursor JSON drifted");
  assert.ok(doc.includes("grok-build --snippet"));
  assert.ok(doc.includes("PROJECT_ROOM_SECRET"));
});

test("the public door keeps URL-only snippets (no auth header on that page)", () => {
  const s = roomMcpSnippets(URL_, { withAuth: false });
  assert.equal(s.claude, `claude mcp add --transport http --scope user project-room ${URL_}`);
  assert.equal(s.codex, `codex mcp add project-room --url ${URL_}`);
  assert.doesNotMatch(JSON.stringify(s), /Bearer /);
  assert.equal(s.grokBuild, "node scripts/room-roster.mjs grok-build --snippet");
});
