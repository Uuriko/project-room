// room join: the one-line, agent-first join (reason-take-4).
// One sentence pasted into any agent ("Join my Project Room: run room join <url> and follow what it prints")
// connects that agent, wires its tool config, and ends by printing an invite line it can pass on.
// Nothing printed here carries the identity secret, an invite code, or a share token: the invite
// line points at the room's public page, never at the invitation that was used to get in.
import { loginCommand } from "./login.mjs";
import { setupCommand, SETUP_TOOLS } from "./setup.mjs";

const TOOL_HINTS = Object.freeze([
  ["CLAUDECODE", "claude-code"],
  ["CODEX_HOME", "codex"],
  ["CODEX_SANDBOX", "codex"],
  ["CURSOR_AGENT", "cursor"],
  ["CURSOR_TRACE_ID", "cursor"],
  ["GEMINI_CLI", "gemini"],
  ["GROK_HOME", "grok"],
  ["OPENCODE", "opencode"],
  ["COPILOT_CLI", "copilot"],
]);

export function detectTool(env = process.env) {
  for (const [key, tool] of TOOL_HINTS) if (env[key] && SETUP_TOOLS.includes(tool)) return tool;
  return "generic";
}

export function roomPageUrl(origin, roomId) {
  const base = new URL(origin);
  return `${base.origin}/r/${encodeURIComponent(roomId)}`;
}

export function oneLinePrompt(url) {
  return `Join my Project Room: run \`npx -y github:Uuriko/project-room join ${url}\` and follow what it prints.`;
}

const SECRETISH = /pri_[A-Za-z0-9_-]{8,}|RM-[A-Z0-9]{6,}|[?#&](?:code|token|invite|share|t)=[^\s&#]+/g;
export function scrub(text) {
  return String(text).replace(SECRETISH, "[redacted]");
}

function parse(argv) {
  const flags = { setup: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-setup") { flags.setup = false; continue; }
    if (arg === "--name" || arg === "--tool" || arg === "--project") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      flags[arg.slice(2)] = value;
      continue;
    }
    rest.push(arg);
  }
  if (rest.length !== 1) throw new Error("Use room join <invite-or-room-url> [--name <agent name>] [--tool <tool>] [--no-setup].");
  if (flags.tool && !SETUP_TOOLS.includes(flags.tool)) throw new Error("Unknown tool. Use one of: " + SETUP_TOOLS.join(", "));
  return { target: rest[0], flags };
}

export async function joinCommand(argv, io = {}) {
  const { env = process.env, out = console.log, login = loginCommand, setup = setupCommand } = io;
  const { target, flags } = parse(argv);
  const name = flags.name ?? "Room agent";
  let joined = null;
  const loginArgs = ["--room", target, "--name", name, "--accept"];
  const code = await login(loginArgs, { ...io, out: line => { try { joined = JSON.parse(line); } catch { joined = null; } } });
  if (code !== 0 || joined?.status !== "connected") {
    const status = joined?.status ?? "failed";
    out(scrub(`Not joined yet (${status}). ${joined?.next ?? "Check the room URL or ask for a fresh invite."}`));
    return 1;
  }
  out(`Joined room ${joined.roomId} as ${name}.`);
  if (flags.setup) {
    const tool = flags.tool ?? detectTool(env);
    const setupArgs = [tool, "--name", name, ...(flags.project ? ["--project", flags.project] : [])];
    const lines = [];
    let setupCode;
    try { setupCode = await setup(setupArgs, { ...io, out: line => lines.push(String(line)), err: line => lines.push(String(line)) }); }
    catch (error) { lines.push(String(error?.message ?? error)); setupCode = 1; }
    for (const line of lines) out(scrub(line));
    if (setupCode !== 0) out(`Tool setup for ${tool} did not finish; the room connection is saved. Retry with room setup ${tool}.`);
  }
  const url = roomPageUrl(joined.origin, joined.roomId);
  out("Invite line (share this; it holds no secret or invite code):");
  out(oneLinePrompt(url));
  return 0;
}
