// The Claude Code plugin (plugins/project-room, listed in
// .claude-plugin/marketplace.json) ships copies of the Project Room skills,
// because symlinks break on Windows checkouts. Contract guarded: the copies
// match skills/ exactly, the manifest names line up, and the plugin MCP points
// at the hosted Room MCP with an optional bearer.
// If this fails after a skill edit, run: node scripts/skills-sync.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const plugin = join(root, "plugins", "project-room");
const files = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});

test("plugin skill copies match skills/", () => {
  for (const skill of ["project-room", "project-room-onboarding"]) {
    const source = join(root, "skills", skill), copy = join(plugin, "skills", skill);
    const list = dir => files(dir).map(f => relative(dir, f)).sort();
    assert.deepEqual(list(copy), list(source), `${skill} file list`);
    for (const file of list(source)) assert.equal(readFileSync(join(copy, file), "utf8"), readFileSync(join(source, file), "utf8"), `${skill}/${file} is stale`);
  }
});

test("marketplace, plugin and MCP manifests line up", () => {
  const market = JSON.parse(readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
  const mcp = JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8")).mcpServers["project-room"];
  const entry = market.plugins.find(p => p.source === "./plugins/project-room");
  assert.equal(entry.name, manifest.name);
  assert.equal(mcp.url, "https://www.getdasha.com/room/mcp");
  assert.equal(mcp.headers.Authorization, "Bearer ${PROJECT_ROOM_SECRET:-}");
});
