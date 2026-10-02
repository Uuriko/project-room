import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDER_CONVENTIONS, HOSTED_MCP_URL, SECRET_ENV, SERVER_NAME, claudeHeaderValue, envHeader, installLinkFor, renderedSnippet,
} from "../../server/connect-snippets.mjs";
import { mcpUrl } from "../auth.mjs";
import { loginCommand } from "./login.mjs";
import { planJson, planMarked, unifiedDiff } from "../files.mjs";
import { homeOf, loadConnection, readProject, safeName, writeProject } from "../paths.mjs";
import { commandOnPath } from "../which.mjs";

export const SETUP_TOOLS = Object.freeze(["claude-code", "codex", "cursor", "cline", "vscode", "aider", "generic"]);

function parse(argv) {
  const flags = { "dry-run": false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "--accept") { flags[arg.slice(2)] = true; continue; }
    if (arg === "--room" || arg === "--name" || arg === "--project") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      flags[arg.slice(2)] = value;
      continue;
    }
    rest.push(arg);
  }
  return { tool: rest[0], extra: rest.slice(1), flags };
}

function readOrNull(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function clinePath(home, platform) {
  if (platform === "darwin") return join(home, "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json");
  if (platform === "win32") return join(home, "AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json");
  return join(home, ".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json");
}

function serverEntry(url, { type, header }) {
  return { ...(type ? { type } : {}), url, headers: { Authorization: header } };
}

export function planTool(tool, { project, home, url, platform, claude }) {
  const files = [];
  let command = null;
  let next = "";
  if (tool === "claude-code") {
    if (claude) {
      command = ["mcp", "add", "--transport", "http", SERVER_NAME, url, "--header", "Authorization: " + claudeHeaderValue()];
      next = "Claude Code is registered. Open this repo in Claude Code.";
    } else {
      const path = join(project, ".mcp.json");
      files.push({ path, contents: planJson(path, readOrNull(path), data => {
        data.mcpServers ??= {};
        data.mcpServers[SERVER_NAME] = serverEntry(url, { type: "http", header: claudeHeaderValue() });
      }) });
      next = "Wrote .mcp.json. Install the claude command, or open this repo in Claude Code. Set " + SECRET_ENV + " from room token.";
    }
  } else if (tool === "codex") {
    const path = join(home, ".codex", "config.toml");
    const block = `[mcp_servers.${SERVER_NAME}]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = ${JSON.stringify(SECRET_ENV)}\n`;
    files.push({ path, contents: planMarked(readOrNull(path), block) });
    next = "Codex reads ~/.codex/config.toml. Export " + SECRET_ENV + " from room token, then start Codex.";
  } else if (tool === "cursor") {
    const path = join(project, ".cursor", "mcp.json");
    files.push({ path, contents: planJson(path, readOrNull(path), data => {
      data.mcpServers ??= {};
      data.mcpServers[SERVER_NAME] = serverEntry(url, { header: envHeader() });
    }) });
    next = "Open this install link, or restart Cursor in this repo:\n" + installLinkFor("cursor", url);
  } else if (tool === "cline") {
    const path = clinePath(home, platform);
    files.push({ path, contents: planJson(path, readOrNull(path), data => {
      data.mcpServers ??= {};
      data.mcpServers[SERVER_NAME] = serverEntry(url, { type: "streamableHttp", header: envHeader() });
    }) });
    next = "Wrote the Cline settings file at " + path + ".";
  } else if (tool === "vscode") {
    const path = join(project, ".vscode", "mcp.json");
    files.push({ path, contents: planJson(path, readOrNull(path), data => {
      data.servers ??= {};
      data.servers[SERVER_NAME] = serverEntry(url, { type: "http", header: envHeader() });
    }) });
    next = "Open this install link, or reload VS Code in this repo:\n" + installLinkFor("vscode", url);
  } else if (tool === "aider") {
    const conf = join(project, ".aider.conf.yml");
    const conventions = join(project, ".project-room", "CONVENTIONS.md");
    files.push({ path: conf, contents: planMarked(readOrNull(conf), "read:\n  - .project-room/CONVENTIONS.md\n") });
    files.push({ path: conventions, contents: planMarked(readOrNull(conventions), AIDER_CONVENTIONS) });
    next = "Aider reads .project-room/CONVENTIONS.md. Aider has no MCP client, so this setup does not register a server. A process wrapper (room wrap -- aider) is not part of this command.";
  } else if (tool === "generic") {
    next = renderedSnippet({ snippet: mcpUrl => ({ mcpServers: { [SERVER_NAME]: serverEntry(mcpUrl, { header: envHeader() }) } }) }, url)
      + "Set " + SECRET_ENV + " to the output of room token.\n";
  } else throw new Error("Use room setup <" + SETUP_TOOLS.join("|") + ">.");
  return { files, command, next };
}

function writeFiles(files) {
  for (const file of files) {
    const before = readOrNull(file.path);
    if (before === file.contents) continue;
    mkdirSync(join(file.path, ".."), { recursive: true });
    writeFileSync(file.path, file.contents, { mode: 0o644 });
    if (file.path.endsWith("CONVENTIONS.md") || file.path.endsWith(".json") || file.path.endsWith(".yml") || file.path.endsWith(".toml")) chmodSync(file.path, 0o644);
  }
}

function alreadyApplied(project, tool, via) {
  const saved = readProject(project);
  return saved?.tool === tool && saved.via === via;
}

export async function setupCommand(argv, { env = process.env, cwd = process.cwd(), fetchImpl, platform = process.platform, out = console.log, err = console.error } = {}) {
  const { tool, extra, flags } = parse(argv);
  if (!tool || extra.length) throw new Error("Use room setup <" + SETUP_TOOLS.join("|") + "> [--room <url>] [--name <agent name>] [--project <dir>] [--dry-run].");
  if (!SETUP_TOOLS.includes(tool)) throw new Error("Use room setup <" + SETUP_TOOLS.join("|") + ">.");
  const project = flags.project ?? cwd;
  const home = homeOf(env);
  let url = HOSTED_MCP_URL;
  if (flags.room) {
    try { url = mcpUrl(new URL(flags.room).origin); }
    catch { /* A bare invite code keeps the hosted server until login saves the origin. */ }
  }
  if (flags.room && !flags["dry-run"]) {
    const code = await loginCommand(["--room", flags.room, "--name", flags.name ?? "Room agent", ...(flags.accept ? ["--accept"] : [])], { env, fetchImpl, out });
    if (code !== 0) return code;
  }
  let connectionName = flags.name ? safeName(flags.name) : null;
  if (!flags["dry-run"] || !flags.room) {
    try {
      const loaded = loadConnection({ project, name: connectionName, env });
      url = mcpUrl(loaded.config.origin);
      connectionName = loaded.name;
    } catch (error) {
      if (!flags["dry-run"]) throw error;
    }
  }
  const claude = commandOnPath("claude", env);
  const plan = planTool(tool, { project, home, url, platform, claude });
  if (flags["dry-run"]) {
    let text = "";
    for (const file of plan.files) text += unifiedDiff(file.path, readOrNull(file.path), file.contents);
    if (plan.command) text += "Would run: claude " + plan.command.map(part => part.includes(" ") ? JSON.stringify(part) : part).join(" ") + "\n";
    if (tool === "generic") text += plan.next;
    out(text.length ? text.replace(/\n$/, "") : "No changes.");
    return 0;
  }
  const via = plan.command ? "command" : "file";
  if (alreadyApplied(project, tool, via) && plan.files.every(file => readOrNull(file.path) === file.contents)) {
    out(plan.next);
    return 0;
  }
  if (plan.command) {
    const result = spawnSync(claude, plan.command, { cwd: project, env, encoding: "utf8" });
    if (result.error || result.status !== 0) {
      err(result.stderr || result.stdout || "claude mcp add failed");
      return 1;
    }
  }
  writeFiles(plan.files);
  if (connectionName) writeProject(project, { connection: connectionName, tool, via });
  out(plan.next);
  return 0;
}
