// Known ACP agents, in detection order. Commands verified Oct 29, 2026 against
// each agent's docs and the ACP registry. `--agent-cmd` overrides when they drift.
// Codex downloads use the 2.5.0 adapter qualified with a no-prompt session.
import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";
import { createPeer } from "./jsonrpc.mjs";

export const KNOWN_AGENTS = Object.freeze([
  Object.freeze({ id: "claude", label: "Claude Code", bin: "claude-agent-acp", args: [], npx: ["-y", "@agentclientprotocol/claude-agent-acp"], plainBin: "claude", adapter: "@agentclientprotocol/claude-agent-acp" }),
  Object.freeze({ id: "codex", label: "Codex", bin: "codex-acp", args: [], npx: ["-y", "@agentclientprotocol/codex-acp@2.5.0"], plainBin: "codex", adapter: "@agentclientprotocol/codex-acp@2.5.0" }),
  Object.freeze({ id: "goose", label: "Goose", bin: "goose", args: ["acp"], npx: null }),
  Object.freeze({ id: "gemini", label: "Gemini CLI", bin: "gemini", args: ["--acp"], npx: null }),
]);

// KI-032: plain `claude` and `codex` do not speak ACP; each needs its
// adapter. One line per agent that names exactly what to install or pass.
export function adapterHints(env = process.env) {
  return KNOWN_AGENTS.map(entry => {
    if (entry.adapter) {
      const plain = onPath(entry.plainBin, env) ? `${entry.plainBin} is installed but does not speak ACP by itself. ` : "";
      return `${entry.label}: ${plain}Install its adapter with \`npm i -g ${entry.adapter}\`, or pass --agent ${entry.id} to run it through npx.`;
    }
    return `${entry.label}: install ${entry.bin} and make sure \`${[entry.bin, ...entry.args].join(" ")}\` runs.`;
  });
}

export const ACP_PROTOCOL_VERSION = 1;
// The bridge advertises no fs or terminal capability: agents use their own
// tools in their working directory, and the bridge never touches files.
// Keep adapter configuration diagnostics separate from assistant reply text.
export const CLIENT_CAPABILITIES = Object.freeze({ fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { notices: {} } });

export function onPath(bin, env = process.env) {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (existsSync(join(dir, bin + ext))) return join(dir, bin + ext);
  }
  return null;
}

// Split a user-supplied command line on whitespace, honoring double and
// single quotes (a single-quoted --agent-cmd path may contain spaces).
export function splitCommand(text) {
  const parts = [];
  for (const match of String(text).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) parts.push(match[1] ?? match[2] ?? match[3]);
  if (!parts.length) throw new Error("empty agent command");
  return { command: parts[0], args: parts.slice(1) };
}

// Candidates in order: explicit command, explicit known id, installed bins.
// npx fallbacks are offered only when asked for by id (they download code).
export function candidates({ agent = null, agentCmd = null, env = process.env } = {}) {
  if (agentCmd) return [{ id: "custom", label: "Custom agent", ...splitCommand(agentCmd) }];
  const list = agent ? KNOWN_AGENTS.filter(entry => entry.id === agent) : KNOWN_AGENTS;
  if (agent && !list.length) throw new Error(`unknown agent "${agent}" (known: ${KNOWN_AGENTS.map(entry => entry.id).join(", ")})`);
  const out = [];
  for (const entry of list) {
    const found = onPath(entry.bin, env);
    if (found) out.push({ id: entry.id, label: entry.label, command: found, args: [...entry.args] });
    else if (agent && entry.npx) out.push({ id: entry.id, label: entry.label, command: "npx", args: [...entry.npx] });
  }
  return out;
}

// The environment an ACP child receives: an ALLOWLIST, never the parent's
// environment minus a denylist (RES-0151 and RES-0145 are this one site:
// the old strip regex removed only three ROOM_* shapes, so every other
// credential in the parent env crossed verbatim). Pass only named process,
// location and locale settings. This limits ambient environment forwarding;
// the child still has its working directory and the selected login/config
// locations. It is not a filesystem or credential isolation boundary.
export const CHILD_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM", "TMPDIR", "LANG",
  "CODEX_PATH", // README: the operator's explicit override for the Codex binary
  "CODEX_HOME", // Preserve the operator's selected config/login directory.
  "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
  // Exact base-directory locations, not every name beginning with XDG_.
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_DIRS", "XDG_DATA_DIRS",
  // Exact scripted fixture inputs; arbitrary FAKE_ACP_ names stay in the parent.
  "FAKE_ACP_MODE", "FAKE_ACP_DELAY_MS", "FAKE_ACP_TRACE",
  // Windows process basics (spawn below has a win32 path).
  "SystemRoot", "windir", "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA",
  "USERPROFILE", "TEMP", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
]);
export function childEnvFor(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (CHILD_ENV_KEYS.includes(key)) out[key] = value;
  }
  return out;
}

// Spawn an agent process and wrap its stdio as a JSON-RPC peer. The Room
// credential variables are excluded from the child's environment.
export function spawnAgent(candidate, { cwd = process.cwd(), env = process.env, onRequest, onNotification, log = () => {} } = {}) {
  const child = spawn(candidate.command, candidate.args, { cwd, env: childEnvFor(env), stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" && candidate.command === "npx" });
  child.stderr.on("data", () => {});
  const peer = createPeer({ input: child.stdout, output: child.stdin, onRequest, onNotification, log });
  return { child, peer };
}

export async function initialize(peer, { timeoutMs = 5000 } = {}) {
  const result = await peer.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: CLIENT_CAPABILITIES, clientInfo: { name: "room-acp", version: "0.0.0" } }, { timeoutMs });
  if (result?.protocolVersion !== ACP_PROTOCOL_VERSION) throw new Error(`Unsupported ACP protocol version: expected ${ACP_PROTOCOL_VERSION}`);
  return {
    protocolVersion: result.protocolVersion,
    loadSession: result?.agentCapabilities?.loadSession === true,
    promptCapabilities: result?.agentCapabilities?.promptCapabilities ?? {},
    authMethods: Array.isArray(result?.authMethods) ? result.authMethods.map(method => method?.id ?? method?.name).filter(Boolean) : [],
    agentInfo: result?.agentInfo ?? null,
  };
}

// Probe one candidate without a model prompt. Doctor checks initialization;
// invitation selection also opens a session through the actual host helper.
// The temporary session is never saved to the Room session map.
export async function probe(candidate, options = {}) {
  let spawned, host;
  try {
    if (options.executionReady) {
      const { AgentHost } = await import("./agent-host.mjs");
      let permissionRequested = false;
      host = new AgentHost({ candidate, cwd: options.cwd, env: options.env, mode: options.mode,
        onPermission: async () => { permissionRequested = true; return { outcome: { outcome: "cancelled" } }; },
      });
      const capabilities = await host.start({ timeoutMs: options.timeoutMs ?? 30000 });
      await host.session("room-preflight", { timeoutMs: options.sessionTimeoutMs ?? 60000 });
      if (permissionRequested) throw new Error("Session readiness required a permission request; preflight denied it");
      return { ...candidate, ok: true, executionReady: true, capabilities };
    }
    spawned = spawnAgent(candidate, options);
    const exited = new Promise(resolve => spawned.child.once("error", error => resolve({ error })).once("exit", code => resolve({ error: new Error(`exited with code ${code}`) })));
    const capabilities = await Promise.race([initialize(spawned.peer, options), exited.then(({ error }) => { throw error; })]);
    return { ...candidate, ok: true, capabilities };
  } catch (error) {
    return { ...candidate, ok: false, error: String(error.message ?? error) };
  } finally {
    host?.stop();
    if (spawned) { spawned.peer.close(); spawned.child.kill(); }
  }
}
