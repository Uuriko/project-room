import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETUP_TOOLS, planTool } from "../cli/commands/setup.mjs";
import { SECRET_ENV, SERVER_NAME } from "../server/connect-snippets.mjs";

const URL = "https://example.test/mcp";

test("setup covers at least 11 coding hosts plus generic", () => {
  assert.ok(SETUP_TOOLS.length >= 12);
  for (const t of ["gemini", "copilot", "opencode", "grok", "command-code"]) assert.ok(SETUP_TOOLS.includes(t), t);
});

test("new host recipes write the hosted server entry and never embed a secret value", t => {
  const home = mkdtempSync(join(tmpdir(), "room-setup-recipes-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const saved = { g: process.env.GEMINI_CLI_HOME, k: process.env.GROK_HOME };
  delete process.env.GEMINI_CLI_HOME; delete process.env.GROK_HOME;
  t.after(() => { if (saved.g !== undefined) process.env.GEMINI_CLI_HOME = saved.g; if (saved.k !== undefined) process.env.GROK_HOME = saved.k; });
  const expect = {
    gemini: [join(home, ".gemini", "settings.json"), d => d.mcpServers[SERVER_NAME].httpUrl],
    copilot: [join(home, ".copilot", "mcp-config.json"), d => d.mcpServers[SERVER_NAME].url],
    opencode: [join(home, ".config", "opencode", "opencode.json"), d => d.mcp[SERVER_NAME].url],
    "command-code": [join(home, ".commandcode", "mcp.json"), d => d.mcpServers[SERVER_NAME].url],
  };
  for (const [tool, [path, pick]] of Object.entries(expect)) {
    const plan = planTool(tool, { project: home, home, url: URL, platform: "linux", claude: null });
    assert.equal(plan.files.length, 1, tool);
    assert.equal(plan.files[0].path, path, tool);
    assert.equal(pick(JSON.parse(plan.files[0].contents)), URL, tool);
    assert.match(plan.next, new RegExp(SECRET_ENV), tool);
    assert.doesNotMatch(plan.files[0].contents, /pri_/, tool);
  }
  const oc = JSON.parse(planTool("opencode", { project: home, home, url: URL, platform: "linux", claude: null }).files[0].contents).mcp[SERVER_NAME];
  assert.equal(oc.headers.Authorization, `Bearer {env:${SECRET_ENV}}`);
  assert.equal(oc.oauth, false);
  const grok = planTool("grok", { project: home, home, url: URL, platform: "linux", claude: null });
  assert.equal(grok.files[0].path, join(home, ".grok", "config.toml"));
  assert.match(grok.files[0].contents, new RegExp(`\\[mcp_servers\\.${SERVER_NAME}\\]`));
  assert.match(grok.files[0].contents, new RegExp(`bearer_token_env_var = "${SECRET_ENV}"`));
});
