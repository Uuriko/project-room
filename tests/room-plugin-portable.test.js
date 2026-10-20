// Portable Agent Plugins package for plugins/project-room (Room Everywhere P1).
// One folder serves Claude Code (.claude-plugin/plugin.json + .mcp.json) and
// Codex/ChatGPT (root plugin.json + mcp.json + .agents/plugins/marketplace.json).
// Guards: identities agree, the MCP endpoint is the hosted Room MCP, the
// onboarding skill and hooks exist inside the plugin, and no credential ships.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const plugin = join(root, "plugins", "project-room");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const files = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});

test("portable manifest matches the Claude manifest identity", () => {
  const portable = json(join(plugin, "plugin.json"));
  const claude = json(join(plugin, ".claude-plugin", "plugin.json"));
  assert.equal(portable.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.match(portable.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  for (const key of ["name", "description", "homepage", "repository", "license"]) assert.equal(portable[key], claude[key], key);
});

test("OpenAI extension paths stay inside the plugin and point at real files", () => {
  const openai = json(join(plugin, "plugin.json")).extensions["com.openai"];
  for (const rel of [openai.onboardingSkill, openai.hooks]) {
    assert.match(rel, /^\.\//);
    assert.ok(!rel.includes(".."), rel);
    assert.ok(existsSync(join(plugin, rel)), `${rel} exists`);
  }
  assert.match(readFileSync(join(plugin, openai.onboardingSkill), "utf8"), /^---\nname: project-room-connect\n/);
});

test("portable MCP config is the hosted Room MCP with a bearer declared, not carried", () => {
  const servers = json(join(plugin, "mcp.json")).mcpServers;
  const legacy = json(join(plugin, ".mcp.json")).mcpServers;
  assert.equal(servers["project-room"].type, "streamable-http");
  assert.equal(servers["project-room"].url, legacy["project-room"].url);
  assert.deepEqual(servers["project-room"].extensions["com.openai"].auth, { type: "api_key", headerScheme: "bearer" });
});

test("repo marketplace lists the plugin by its manifest name", () => {
  const market = json(join(root, ".agents", "plugins", "marketplace.json"));
  const entry = market.plugins.find(p => p.source?.path === "./plugins/project-room");
  assert.ok(entry, "plugin entry");
  assert.equal(entry.name, json(join(plugin, "plugin.json")).name);
  for (const key of ["installation", "authentication"]) assert.ok(entry.policy[key], key);
  assert.ok(entry.category);
});

test("connect setup skill points at the canonical connect skill", () => {
  const skill = readFileSync(join(root, "skills", "project-room-connect", "SKILL.md"), "utf8");
  assert.match(skill, /https:\/\/room\.trydemigod\.com\/\.well-known\/agent-skills\/connect\/SKILL\.md/);
  assert.match(skill, /Never print or post it/);
});

test("no credential-shaped strings ship in the plugin or marketplace", () => {
  for (const file of [...files(plugin), join(root, ".agents", "plugins", "marketplace.json")]) {
    if (!/\.(json|md|mjs|js|sh)$/.test(file)) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /\b(pri|rak|oat|rat)_[A-Za-z0-9_-]{16,}/, file);
  }
});
