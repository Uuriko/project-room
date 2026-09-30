#!/usr/bin/env node
// Project Room MCP one-shot installer.
//
// Portions adapted from Agent Room's init.ts
// (https://github.com/agent-room-alkl/agent-room)
// MIT License, Copyright (c) 2026 Agent Room contributors.
//
// Detects installed AI clients and registers Project Room's hosted MCP
// server in each client's MCP config. Idempotent: re-running changes nothing
// when the entry already exists.
//
// Unlike upstream (which spawns a local stdio server via npx), Project Room's
// hosted MCP is a plain HTTPS URL, so every client gets a remote entry —
// no local package install, no Node version dance on the client side.
//
// Usage:
//   node scripts/room-mcp-init.mjs [client ...] [--url <mcp-url>] [--dry-run] [--yes]
//
// Examples:
//   node scripts/room-mcp-init.mjs            # detect clients, ask, install
//   node scripts/room-mcp-init.mjs cursor     # just Cursor
//   node scripts/room-mcp-init.mjs --dry-run # print what would change

import { execSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { promises as fs, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Source of truth for these two lives in src/room-mcp-join.js
// (ROOM_MCP_SERVER_NAME / ROOM_MCP_PUBLIC_URL). They are duplicated here so
// this file stays servable standalone (see GET /room/mcp-init.mjs, deferred).
const SERVER_NAME = "project-room";
const DEFAULT_MCP_URL = "https://www.getdasha.com/room/mcp";

const INSTALL_TARGETS = ["claude", "cursor", "codex", "antigravity", "vscode", "copilot"];

function remoteEntry(url) {
  return { url };
}

// ---------------------------------------------------------------------------
// Detection (ported from upstream's detectInstallTargets, same probes).
// ---------------------------------------------------------------------------

function hasCommand(cmd, which) {
  try {
    which(`command -v ${cmd} >/dev/null 2>&1 || which ${cmd} >/dev/null 2>&1`);
    return true;
  } catch {
    return false;
  }
}

// opts: { env, which, exists, paths } — all injectable so tests can
// drive detection without touching the real machine.
export function detectInstallTargets(opts = {}) {
  const {
    env = process.env,
    which = (cmd) => execSync(cmd, { stdio: "ignore" }),
    exists = (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
    paths = {},
  } = opts;

  const targets = new Set();

  if (env.CLAUDE_CODE === "1" || hasCommand("claude", which)) targets.add("claude");
  if (hasCommand("cursor", which) || hasCommand("cursor-agent", which)) targets.add("cursor");
  // Antigravity is Chromium-based and ships its own CLI; detect the marker
  // files before falling through to generic vscode detection.
  if (
    env.ANTIGRAVITY === "1" ||
    exists(paths.antigravityMarker ?? join(homedir(), ".antigravity")) ||
    exists(paths.antigravityConfig ?? join(homedir(), ".gemini", "config", "mcp_config.json"))
  ) {
    targets.add("antigravity");
  }
  if (env.CODEX === "1" || hasCommand("codex", which)) targets.add("codex");
  if (hasCommand("code", which) || hasCommand("code-insiders", which)) targets.add("vscode");
  if (hasCommand("copilot", which) || env.GITHUB_COPILOT === "1") targets.add("copilot");

  return [...targets];
}

// ---------------------------------------------------------------------------
// Config paths (pure helpers, exported for tests; same shapes as upstream).
// ---------------------------------------------------------------------------

export function claudeDesktopConfigPathFor(home, platform = process.platform, appdata) {
  const filename = "claude_desktop_config.json";
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", filename);
  if (platform === "win32") return join(appdata ?? join(home, "AppData", "Roaming"), "Claude", filename);
  return join(home, ".config", "Claude", filename);
}

export function claudeJsonPathFor(home) {
  return join(home, ".claude.json");
}

export function cursorMcpPathFor(home) {
  return join(home, ".cursor", "mcp.json");
}

export function codexConfigPathFor(home) {
  return join(home, ".codex", "config.toml");
}

export function antigravityMcpPathFor(home) {
  // Antigravity reads MCP servers from the Gemini CLI config location.
  return join(home, ".gemini", "config", "mcp_config.json");
}

export function vscodeMcpPathFor(home, platform = process.platform, appdata) {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  if (platform === "win32") return join(appdata ?? join(home, "AppData", "Roaming"), "Code", "User", "mcp.json");
  return join(home, ".config", "Code", "User", "mcp.json");
}

export function copilotMcpConfigPathFor(home, copilotHome) {
  // GitHub Copilot desktop app + Copilot CLI share COPILOT_HOME (default
  // ~/.copilot) and read MCP servers from mcp-config.json there, under a
  // top-level `mcpServers` key. Docs:
  // https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
  return join(copilotHome ?? join(home, ".copilot"), "mcp-config.json");
}

// ---------------------------------------------------------------------------
// Config read/write (ported from upstream; atomic writes, tolerant reads).
// ---------------------------------------------------------------------------

async function readJson(path, fsApi = fs) {
  try {
    const raw = await fsApi.readFile(path, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeJsonAtomic(path, data, fsApi = fs) {
  await fsApi.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  // H-18: the temp file's default mode used to survive the rename, loosening
  // a pre-existing 0600 config (which may hold unrelated auth tokens) to the
  // umask default. Preserve the original file's mode; newly created
  // credential-bearing configs default to owner-only.
  let mode = 0o600;
  try {
    mode = (await fsApi.stat(path)).mode & 0o7777;
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  await fsApi.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode, encoding: "utf8" });
  // writeFile's mode applies only at creation; force it in case the tmp file
  // already existed (e.g. left behind by a crashed run).
  await fsApi.chmod(tmp, mode);
  await fsApi.rename(tmp, path);
}

// Set servers[name] = entry idempotently. Returns true when the file changed.
async function upsertRemoteServer(path, topKey, name, url, { dryRun = false, fsApi = fs } = {}) {
  const data = (await readJson(path, fsApi)) ?? {};
  const servers = { ...((data[topKey] && typeof data[topKey] === "object" ? data[topKey] : {})) };
  const before = JSON.stringify(servers[name]);
  servers[name] = remoteEntry(url);
  if (JSON.stringify(servers[name]) === before) {
    return { changed: false, path };
  }
  if (!dryRun) {
    data[topKey] = servers;
    await writeJsonAtomic(path, data, fsApi);
  }
  return { changed: true, path };
}

// Minimal TOML handling for Codex: find [mcp_servers.<name>] and set url.
// Only the mcp_servers table is touched; everything else is preserved.
function upsertCodexToml(text, name, url) {
  const header = `[mcp_servers.${name}]`;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) {
    let out = text;
    if (out && !out.endsWith("\n")) out += "\n";
    if (out && !out.endsWith("\n\n")) out += "\n";
    return { text: `${out}${header}\nurl = ${JSON.stringify(url)}\n`, changed: true };
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const block = lines.slice(start, end);
  const urlIdx = block.findIndex((l) => /^\s*url\s*=/.test(l));
  const want = `url = ${JSON.stringify(url)}`;
  if (urlIdx !== -1 && block[urlIdx].trim() === want) return { text, changed: false };
  if (urlIdx !== -1) block[urlIdx] = want;
  else block.push(want);
  return { text: [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n"), changed: true };
}

async function installCodexToml(path, name, url, { dryRun = false, fsApi = fs } = {}) {
  let text = "";
  try {
    text = await fsApi.readFile(path, "utf8");
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  const { text: next, changed } = upsertCodexToml(text, name, url);
  if (changed && !dryRun) {
    await fsApi.mkdir(dirname(path), { recursive: true });
    await fsApi.writeFile(path, next, "utf8");
  }
  return { changed, path };
}

// ---------------------------------------------------------------------------
// Installers. Each returns { changes: [], unchanged: [] }.
// ---------------------------------------------------------------------------

function tryCliAdd(argv, { run = (a) => spawnSync(a[0], a.slice(1), { stdio: "ignore" }) } = {}) {
  const res = run(argv);
  return res && res.status === 0;
}

async function installClaude(url, ctx) {
  const { home, platform, env, dryRun } = ctx;
  // Prefer the CLI — matches the repo's own documented snippet
  // (src/room-mcp-join.js roomMcpSnippets().claude).
  if (!dryRun && tryCliAdd(["claude", "mcp", "add", "--transport", "http", "--scope", "user", SERVER_NAME, url], ctx)) {
    return { changes: ["claude mcp add (project-room, hosted URL)"], unchanged: [] };
  }
  // Fallback: JSON configs. Claude Desktop and Claude Code both read
  // mcpServers.<name> = { url } for remote servers.
  const results = [];
  for (const p of [claudeDesktopConfigPathFor(home, platform, env.APPDATA), claudeJsonPathFor(home)]) {
    const { changed } = await upsertRemoteServer(p, "mcpServers", SERVER_NAME, url, { dryRun });
    results.push(changed ? `wrote ${p} (project-room MCP server)` : `${p} (already configured)`);
  }
  const changes = results.filter((r) => r.startsWith("wrote"));
  const unchanged = results.filter((r) => !r.startsWith("wrote"));
  return { changes, unchanged };
}

async function installCursor(url, ctx) {
  const { home, dryRun } = ctx;
  const { changed, path } = await upsertRemoteServer(cursorMcpPathFor(home), "mcpServers", SERVER_NAME, url, { dryRun });
  return changed
    ? { changes: [`wrote ${path} (project-room MCP server)`], unchanged: [] }
    : { changes: [], unchanged: [`${path} (already configured)`] };
}

async function installCodex(url, ctx) {
  const { home, dryRun } = ctx;
  // Prefer the CLI — matches the repo's own documented snippet
  // (src/room-mcp-join.js roomMcpSnippets().codex).
  if (!dryRun && tryCliAdd(["codex", "mcp", "add", SERVER_NAME, "--url", url], ctx)) {
    return { changes: ["codex mcp add (project-room, hosted URL)"], unchanged: [] };
  }
  const { changed, path } = await installCodexToml(codexConfigPathFor(home), SERVER_NAME, url, { dryRun });
  return changed
    ? { changes: [`wrote ${path} (project-room MCP server)`], unchanged: [] }
    : { changes: [], unchanged: [`${path} (already configured)`] };
}

async function installAntigravity(url, ctx) {
  const { home, dryRun } = ctx;
  const { changed, path } = await upsertRemoteServer(antigravityMcpPathFor(home), "mcpServers", SERVER_NAME, url, { dryRun });
  return changed
    ? { changes: [`wrote ${path} (project-room MCP server)`], unchanged: [] }
    : { changes: [], unchanged: [`${path} (already configured)`] };
}

async function installVscode(url, ctx) {
  const { home, platform, env, dryRun } = ctx;
  // VS Code's mcp.json uses a top-level `servers` key.
  const { changed, path } = await upsertRemoteServer(
    vscodeMcpPathFor(home, platform, env.APPDATA),
    "servers",
    SERVER_NAME,
    url,
    { dryRun }
  );
  return changed
    ? { changes: [`wrote ${path} (project-room MCP server)`], unchanged: [] }
    : { changes: [], unchanged: [`${path} (already configured)`] };
}

async function installCopilot(url, ctx) {
  const { home, env, dryRun } = ctx;
  const { changed, path } = await upsertRemoteServer(
    copilotMcpConfigPathFor(home, env.COPILOT_HOME),
    "mcpServers",
    SERVER_NAME,
    url,
    { dryRun }
  );
  return changed
    ? { changes: [`wrote ${path} (project-room MCP server)`], unchanged: [] }
    : { changes: [], unchanged: [`${path} (already configured)`] };
}

const INSTALLERS = {
  claude: installClaude,
  cursor: installCursor,
  codex: installCodex,
  antigravity: installAntigravity,
  vscode: installVscode,
  copilot: installCopilot,
};

// Install one target; unknown targets are a usage error, not a silent skip.
export async function installTarget(target, opts = {}) {
  if (!INSTALLERS[target]) throw new Error(`unknown install target: ${target}`);
  const ctx = {
    home: opts.home ?? homedir(),
    platform: opts.platform ?? process.platform,
    env: opts.env ?? process.env,
    url: opts.url ?? DEFAULT_MCP_URL,
    dryRun: opts.dryRun ?? false,
    run: opts.run,
    fsApi: opts.fsApi,
  };
  return INSTALLERS[target](ctx.url, ctx);
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { targets: [], url: DEFAULT_MCP_URL, dryRun: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--yes" || a === "-y") args.yes = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--url") args.url = argv[++i] ?? args.url;
    else if (a.startsWith("--url=")) args.url = a.slice("--url=".length);
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else args.targets.push(a);
  }
  for (const t of args.targets) {
    if (!INSTALL_TARGETS.includes(t)) throw new Error(`unknown client: ${t} (choose from ${INSTALL_TARGETS.join(", ")})`);
  }
  return args;
}

const HELP = `room-mcp-init — register Project Room's hosted MCP server in your AI clients.

Usage: node scripts/room-mcp-init.mjs [client ...] [options]

Clients: ${INSTALL_TARGETS.join(", ")}
Options:
  --url <url>   MCP server URL (default ${DEFAULT_MCP_URL})
  --dry-run     print what would change, write nothing
  --yes, -y     do not prompt; fail if no client is detected
  --help, -h    this text

With no client arguments, installed clients are auto-detected.`;

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  let targets = args.targets;
  if (targets.length === 0) {
    const detected = detectInstallTargets();
    if (detected.length === 0) {
      const answer = args.yes ? "" : await prompt("No AI client detected. Install for which client? (claude/cursor/codex/antigravity/vscode/copilot, or Enter to abort): ");
      const picked = answer.trim().toLowerCase();
      if (!picked || !INSTALL_TARGETS.includes(picked)) {
        console.error("Aborted: no client selected.");
        return 1;
      }
      targets = [picked];
    } else if (args.yes) {
      targets = detected;
    } else {
      const answer = await prompt(`Detected: ${detected.join(", ")}. Install for all? [Y/n] `);
      targets = /^[nN]/.test(answer.trim()) ? [] : detected;
      if (targets.length === 0) {
        console.error("Aborted: nothing selected.");
        return 1;
      }
    }
  }
  let failed = false;
  for (const target of targets) {
    const { changes, unchanged } = await installTarget(target, { url: args.url, dryRun: args.dryRun });
    for (const c of changes) console.log(`${args.dryRun ? "would change" : "changed"} [${target}]: ${c}`);
    for (const u of unchanged) console.log(`unchanged [${target}]: ${u}`);
    if (changes.length === 0 && unchanged.length === 0) failed = true;
  }
  if (failed) {
    console.error("Some targets produced no result.");
    return 1;
  }
  console.log(`\nProject Room MCP ready at ${args.url}${args.dryRun ? " (dry run — nothing written)" : ""}.`);
  console.log("Enrolled agents: add Authorization: Bearer <saved-identity-secret> to reach the room profile.");
  return 0;
}

const invokedAsScript = (() => {
  try {
    return process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();
if (invokedAsScript) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err && err.message ? err.message : err);
      process.exit(1);
    }
  );
}
