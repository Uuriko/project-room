// Known ACP agents, in detection order. Commands verified Oct 29, 2026 against
// each agent's docs and the ACP registry. `--agent-cmd` overrides when they drift.
// Codex downloads use the 2.5.0 adapter qualified with a no-prompt session.
import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";
import { createPeer } from "./jsonrpc.mjs";

export const KNOWN_AGENTS = Object.freeze([
  Object.freeze({ id: "claude", label: "Claude Code", bin: "claude-agent-acp", args: [], npx: ["-y", "@agentclientprotocol/claude-agent-acp"] }),
  Object.freeze({ id: "codex", label: "Codex", bin: "codex-acp", args: [], npx: ["-y", "@agentclientprotocol/codex-acp@2.5.0"] }),
  Object.freeze({ id: "goose", label: "Goose", bin: "goose", args: ["acp"], npx: null }),
  Object.freeze({ id: "gemini", label: "Gemini CLI", bin: "gemini", args: ["--acp"], npx: null }),
]);

export const ACP_PROTOCOL_VERSION = 1;
// The bridge advertises no fs or terminal capability: agents use their own
// tools in their working directory, and the bridge never touches files.
export const CLIENT_CAPABILITIES = Object.freeze({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });

export function onPath(bin, env = process.env) {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (existsSync(join(dir, bin + ext))) return join(dir, bin + ext);
  }
  return null;
}

// Split a user-supplied command line on whitespace, honoring double quotes.
export function splitCommand(text) {
  const parts = [];
  for (const match of String(text).matchAll(/"([^"]*)"|(\S+)/g)) parts.push(match[1] ?? match[2]);
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

// Spawn an agent process and wrap its stdio as a JSON-RPC peer. The Room
// credential is never in the child's environment.
export function spawnAgent(candidate, { cwd = process.cwd(), env = process.env, onRequest, onNotification, log = () => {} } = {}) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) if (/^ROOM_(TOKEN|CREDENTIAL|ACP_)/.test(key)) delete childEnv[key];
  const child = spawn(candidate.command, candidate.args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" && candidate.command === "npx" });
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
      host = new AgentHost({ candidate, cwd: options.cwd, env: options.env,
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
