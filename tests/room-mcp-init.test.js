import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectInstallTargets,
  installTarget,
  parseArgs,
  claudeDesktopConfigPathFor,
  cursorMcpPathFor,
  codexConfigPathFor,
  antigravityMcpPathFor,
  vscodeMcpPathFor,
  copilotMcpConfigPathFor,
} from "../scripts/room-mcp-init.mjs";

const URL = "https://www.getdasha.com/room/mcp";
const failRun = () => ({ status: 1 });
const noCmd = () => { throw new Error("no such command"); };
const noExist = () => false;

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), "room-mcp-init-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

const ctx = (home, extra = {}) => ({ home, env: {}, platform: "linux", run: failRun, ...extra });

test("detection honors environment markers without shelling out", () => {
  const opts = { which: noCmd, exists: noExist };
  assert.deepEqual(detectInstallTargets({ ...opts, env: { CLAUDE_CODE: "1" } }), ["claude"]);
  assert.deepEqual(detectInstallTargets({ ...opts, env: { CODEX: "1" } }), ["codex"]);
  assert.deepEqual(detectInstallTargets({ ...opts, env: { ANTIGRAVITY: "1" } }), ["antigravity"]);
  assert.deepEqual(detectInstallTargets({ ...opts, env: { GITHUB_COPILOT: "1" } }), ["copilot"]);
  assert.deepEqual(detectInstallTargets({ ...opts, env: {} }), []);
});

test("detection probes well-known commands and config paths", () => {
  const which = (cmd) => {
    const c = String(cmd);
    if (c.includes("cursor-agent") || c.includes("command -v code ")) return;
    throw new Error("no");
  };
  const found = detectInstallTargets({ env: {}, which, exists: noExist });
  assert.ok(found.includes("cursor"));
  assert.ok(found.includes("vscode"));
  const viaConfig = detectInstallTargets({
    env: {},
    which: noCmd,
    exists: (p) => p === join("/fake", ".gemini", "config", "mcp_config.json"),
    paths: { antigravityConfig: join("/fake", ".gemini", "config", "mcp_config.json") },
  });
  assert.ok(viaConfig.includes("antigravity"));
});

test("cursor install writes the hosted entry idempotently and preserves neighbors", t => {
  const home = tempHome(t);
  const path = cursorMcpPathFor(home);
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers: { other: { url: "https://other.example/mcp" } } }));
  return installTarget("cursor", ctx(home)).then(async first => {
    assert.equal(first.changes.length, 1);
    assert.match(first.changes[0], /wrote .*mcp\.json/);
    const data = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(data.mcpServers["project-room"].url, URL);
    assert.equal(data.mcpServers.other.url, "https://other.example/mcp");
    const second = await installTarget("cursor", ctx(home));
    assert.equal(second.changes.length, 0);
    assert.equal(second.unchanged.length, 1);
  });
});

test("cursor install is a no-op when the entry already matches", t => {
  const home = tempHome(t);
  const path = cursorMcpPathFor(home);
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers: { "project-room": { url: URL } } }));
  return installTarget("cursor", ctx(home)).then(result => {
    assert.equal(result.changes.length, 0);
    assert.match(result.unchanged[0], /already configured/);
  });
});

test("dry-run reports without writing", t => {
  const home = tempHome(t);
  return installTarget("cursor", ctx(home, { dryRun: true })).then(result => {
    assert.equal(result.changes.length, 1);
    assert.equal(existsSync(cursorMcpPathFor(home)), false);
  });
});

test("codex toml install inserts the server table and keeps the rest", t => {
  const home = tempHome(t);
  const path = codexConfigPathFor(home);
  return installTarget("codex", ctx(home)).then(async first => {
    assert.equal(first.changes.length, 1);
    const text = readFileSync(path, "utf8");
    assert.match(text, /\[mcp_servers\.project-room\]/);
    assert.match(text, new RegExp(`url = "${URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    // A second run changes nothing; a hand-edited file keeps its content.
    writeFileSync(path, `# keep me\n${text}`);
    const second = await installTarget("codex", ctx(home));
    assert.equal(second.changes.length, 0);
    assert.match(readFileSync(path, "utf8"), /# keep me/);
  });
});

test("custom --url flows into every entry", t => {
  const home = mkdtempSync(join(tmpdir(), "room-mcp-url-"));
  const custom = "https://example.org/room/mcp";
  return installTarget("antigravity", ctx(home, { url: custom })).then(() => {
    const data = JSON.parse(readFileSync(antigravityMcpPathFor(home), "utf8"));
    assert.equal(data.mcpServers["project-room"].url, custom);
    rmSync(home, { recursive: true, force: true });
  });
});

test("claude falls back to json configs when the cli is absent", t => {
  const home = tempHome(t);
  return installTarget("claude", ctx(home)).then(result => {
    assert.ok(result.changes.length >= 1);
    const desktop = JSON.parse(readFileSync(claudeDesktopConfigPathFor(home, "linux"), "utf8"));
    assert.equal(desktop.mcpServers["project-room"].url, URL);
    const cli = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    assert.equal(cli.mcpServers["project-room"].url, URL);
  });
});

test("claude prefers the cli when it succeeds", t => {
  const home = tempHome(t);
  const seen = [];
  const run = (argv) => { seen.push(argv); return { status: 0 }; };
  return installTarget("claude", ctx(home, { run })).then(result => {
    assert.deepEqual(seen[0], ["claude", "mcp", "add", "--transport", "http", "--scope", "user", "project-room", URL]);
    assert.match(result.changes[0], /claude mcp add/);
    assert.equal(existsSync(claudeDesktopConfigPathFor(home, "linux")), false);
  });
});

test("vscode and copilot write their documented config shapes", t => {
  const home = tempHome(t);
  return installTarget("vscode", ctx(home)).then(() => {
    const data = JSON.parse(readFileSync(vscodeMcpPathFor(home, "linux"), "utf8"));
    assert.equal(data.servers["project-room"].url, URL);
    return installTarget("copilot", ctx(home));
  }).then(() => {
    const data = JSON.parse(readFileSync(copilotMcpConfigPathFor(home), "utf8"));
    assert.equal(data.mcpServers["project-room"].url, URL);
    rmSync(home, { recursive: true, force: true });
  });
});

test("parseArgs validates clients and flags", () => {
  assert.deepEqual(parseArgs(["cursor", "--dry-run"]).targets, ["cursor"]);
  assert.equal(parseArgs(["--url=https://x.example/mcp"]).url, "https://x.example/mcp");
  assert.equal(parseArgs(["--url", "https://y.example/mcp"]).url, "https://y.example/mcp");
  assert.throws(() => parseArgs(["notaclient"]), /unknown client/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown flag/);
  return assert.rejects(() => installTarget("notaclient", {}), /unknown install target/);
});
