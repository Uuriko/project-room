// Portable Agent Plugins package for plugins/project-room (Room Everywhere P1).
// One folder serves Claude Code (.claude-plugin/plugin.json + .mcp.json) and
// Codex (.codex-plugin/plugin.json + mcp.json + .agents/plugins/marketplace.json).
// No root plugin.json: Codex treats it as an Agent Plugins package and then
// loads no hooks (codex-rs core-plugins loader), and its MCP schema refuses
// extensions. Codex gets its bearer from `room setup codex` (bearer_token_env_var).
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

const codexManifest = () => json(join(plugin, ".codex-plugin", "plugin.json"));

test("Codex manifest matches the Claude manifest identity and no root manifest shadows it", () => {
  const codex = codexManifest();
  const claude = json(join(plugin, ".claude-plugin", "plugin.json"));
  assert.match(codex.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  for (const key of ["name", "description", "homepage", "repository", "license"]) assert.equal(codex[key], claude[key], key);
  assert.equal(existsSync(join(plugin, "plugin.json")), false, "root plugin.json makes Codex skip hooks");
  assert.equal(codex.extensions, undefined);
});

test("Codex manifest paths stay inside the plugin and point at real files", () => {
  const codex = codexManifest();
  for (const rel of [codex.skills, codex.mcpServers, codex.hooks]) {
    assert.match(rel, /^\.\//);
    assert.ok(!rel.includes(".."), rel);
    assert.ok(existsSync(join(plugin, rel)), `${rel} exists`);
  }
  assert.match(readFileSync(join(plugin, "skills", "project-room-connect", "SKILL.md"), "utf8"), /^---\nname: project-room-connect\n/);
  assert.ok(codex.interface.displayName && codex.interface.shortDescription);
});

test("Codex MCP config is the hosted Room MCP with only fields Codex accepts and no header", () => {
  const servers = json(join(plugin, "mcp.json")).mcpServers;
  const legacy = json(join(plugin, ".mcp.json")).mcpServers;
  assert.deepEqual(Object.keys(servers["project-room"]), ["url"]);
  assert.equal(servers["project-room"].url, legacy["project-room"].url);
});

test("connect skill sends Codex to room setup codex for its bearer", () => {
  const skill = readFileSync(join(root, "skills", "project-room-connect", "SKILL.md"), "utf8");
  assert.match(skill, /room setup codex/);
  assert.match(skill, /bearer_token_env_var/);
});

test("repo marketplace lists the plugin by its manifest name", () => {
  const market = json(join(root, ".agents", "plugins", "marketplace.json"));
  const entry = market.plugins.find(p => p.source?.path === "./plugins/project-room");
  assert.ok(entry, "plugin entry");
  assert.equal(entry.name, codexManifest().name);
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
