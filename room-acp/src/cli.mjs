#!/usr/bin/env node
// room-acp: connect a local ACP agent to a Project Room with one invite link.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, USAGE } from "./args.mjs";
import { adapterHints, candidates, probe } from "./agents.mjs";
import { join } from "./join.mjs";
import { importIdentity, importCredential } from "./import-identity.mjs";
import { loadConnection, listConnections, forgetConnection, publicView, saveMcpHeaders } from "./credentials.mjs";
import { RoomClient } from "./room.mjs";
import { redact, registerSecret } from "./redact.mjs";
import { normalizeBase } from "./link.mjs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { run, selectAgent } from "./run.mjs";
import { nodeSatisfies, unsupportedNodeMessage } from "./node-version.mjs";

// Commands that connect: they probe or redeem an invitation, import a
// credential, or open the bridge. The Node gate runs before any of that —
// a mid-join failure on an old Node can burn a single-use invite. Local-only
// commands (status, logout, help) stay usable on any Node.
const CONNECT_COMMANDS = new Set(["join", "run", "import-credential", "import-identity"]);

export async function doctor(options, { print = console.log, env = process.env } = {}) {
  const list = candidates({ agent: options.agent, agentCmd: options.agentCmd, env });
  if (!list.length) {
    print(["No ACP agent found. Room needs an agent that speaks ACP:", ...adapterHints(env).map(line => `  - ${line}`), "Or pass --agent-cmd with any installed ACP adapter."].join("\n"));
    return 1;
  }
  let ok = 0;
  for (const candidate of list) {
    const result = await probe(candidate, { cwd: options.cwd ?? process.cwd(), env, timeoutMs: candidate.command === "npx" ? 120000 : 10000 });
    if (result.ok) {
      ok++;
      const caps = result.capabilities;
      print(`ok   ${result.label} (${result.id}): protocol ${caps.protocolVersion}, loadSession ${caps.loadSession ? "yes" : "no"}${caps.authMethods.length ? `, login via ${caps.authMethods.join("/")}` : ""}; initialization only, session readiness not checked`);
    } else print(`fail ${result.label} (${result.id}): ${result.error}`);
  }
  return ok ? 0 : 1;
}

// What to type into an MCP host. The command contains the path of a private
// file, never the credential itself.
export function mcpHostLines(connection, host, headersPath, platform = process.platform) {
  const url = `${connection.apiBase.replace(/\/$/, "")}/mcp?profile=full`;
  const reader = platform === "win32" ? `type "${headersPath}"` : `cat '${headersPath.replaceAll("'", "'\\''")}'`;
  if (host === "claude") {
    const json = JSON.stringify({ type: "http", url, headersHelper: reader });
    return [`Claude Code (run once):`, `  claude mcp add-json project-room '${json.replaceAll("'", "'\\''")}' --scope user`];
  }
  return [`Codex (add to ~/.codex/config.toml):`, "  [mcp_servers.project-room]", `  url = ${JSON.stringify(url)}`, `  http_headers_helper = ${JSON.stringify(reader)}`];
}

export async function mcpConfig(connection, host, { env = process.env, print = console.log } = {}) {
  const headersPath = saveMcpHeaders(connection, env);
  print(["Connect your MCP host to this Room. The commands below hold no secret; the host reads its Authorization header from a private file.",
    ...mcpHostLines(connection, host, headersPath), "Then ask your agent to call room_activation_pack."].join("\n"));
}

// Connection health only: one authenticated read per saved room. No model prompt, no secret printed.
export async function doctorConnections(options, { print = console.log, env = process.env, fetchImpl = fetch } = {}) {
  const all = options.room ? [loadConnection({ roomId: options.room }, env)].filter(Boolean) : listConnections(env);
  if (!all.length) { print("No saved connection. Join with: room-acp join <room-url> --no-listen (you will be asked for the invite)"); return 1; }
  let ok = 0;
  for (const connection of all) {
    try {
      await new RoomClient({ ...connection, credential: connection.credential, fetchImpl }).checkConnection();
      ok++; print(`ok   room ${connection.roomId}: connected as ${connection.displayName ?? connection.memberId}`);
    } catch (error) {
      const hint = error.status === 401 || error.status === 403 ? "the credential was rejected; ask the owner for a new invite" : "could not confirm the connection";
      print(`fail room ${connection.roomId}: ${hint} (${redact(error.message)})`);
    }
  }
  return ok === all.length ? 0 : 1;
}

// The invite is a single-use bearer secret, so `room-acp join <room-url>` asks
// for it instead of taking it from argv (visible to other local users in the
// process list, and kept in shell history). Order: ROOM_ACP_INVITE (read once
// and removed, so the agent room-acp starts never inherits it), then stdin
// (a hidden prompt on a terminal, the first line of a pipe or file otherwise).
// A full invite link given as the argument still works for existing scripts,
// with a warning on stderr.
const INVITE_IN_TEXT = /(^|\/)[A-Za-z]{2}-[0-9A-Za-z]{16,40}\/?$|\/(?:join|a)\/[A-Za-z]{2}-[0-9A-Za-z]{16,}|#join\//;
const MAX_INVITE_CHARS = 2048;

function readHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    output.write(question);
    const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const rl = createInterface({ input, output: muted, terminal: true });
    let answered = false;
    rl.on("close", () => { if (!answered) { output.write("\n"); reject(new Error("no invite was entered")); } });
    rl.question("", answer => { answered = true; rl.close(); output.write("\n"); resolve(answer); });
  });
}

async function readPiped(input) {
  let text = "";
  for await (const chunk of input) {
    text += chunk.toString("utf8");
    if (text.length > MAX_INVITE_CHARS || /\r?\n/.test(text)) break;
  }
  return text;
}

export async function resolveInvite(options, { env, io = {} }) {
  const warn = io.warn ?? (line => console.error(line));
  const given = options.link;
  if (given && INVITE_IN_TEXT.test(given.trim())) {
    registerSecret(given.trim());
    warn("room-acp: the invite was given on the command line, where other local users can read it and your shell keeps it. Next time run `room-acp join <room-url>` and paste the invite when asked.");
    return { link: given, origin: options.origin };
  }
  // No invite in the argument: it is the Room's address (or nothing: the default Room).
  const origin = given ? normalizeBase(given) : options.origin;
  if (given && options.origin && normalizeBase(options.origin) !== origin) throw new Error("the Room address and --origin differ; give one");
  let text = null;
  if (typeof env.ROOM_ACP_INVITE === "string" && env.ROOM_ACP_INVITE.trim()) {
    text = env.ROOM_ACP_INVITE;
    delete env.ROOM_ACP_INVITE;
  } else if (io.readInvite) {
    text = await io.readInvite();
  } else {
    const input = io.stdin ?? process.stdin;
    text = input.isTTY ? await readHidden("Paste the invite (it will not be shown): ", { input, output: io.promptOutput ?? process.stderr }) : await readPiped(input);
  }
  text = String(text ?? "").split(/\r?\n/)[0].trim();
  if (!text) throw new Error("no invite was given. Paste it at the prompt, pipe it in (room-acp join <room-url> < invite.txt), or set ROOM_ACP_INVITE for this one command");
  if (text.length > MAX_INVITE_CHARS) throw new Error("that is not a Room invite");
  registerSecret(text);
  return { link: text, origin };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const print = io.print ?? console.log;
  let options;
  try { options = parseArgs(argv); } catch (error) { print(`room-acp: ${error.message}\n\n${USAGE}`); return 2; }
  if (options.help || options.command === "help") { print(USAGE); return 0; }
  // Preflight Node gate: before selectAgent probes, before join touches the
  // invitation, before any network call. io.nodeVersion is the test seam;
  // production always reads process.version.
  const nodeVersion = io.nodeVersion ?? process.version;
  if (CONNECT_COMMANDS.has(options.command) && !nodeSatisfies(nodeVersion)) {
    print(unsupportedNodeMessage(nodeVersion));
    return 1;
  }
  if (options.command === "doctor" && options.connection) return doctorConnections(options, { print, env: io.env ?? process.env, fetchImpl: io.fetchImpl });
  if (options.command === "doctor") return doctor(options, io);
  const env = io.env ?? process.env;
  let candidate = null;
  try {
    if (options.command === "import-credential") {
      if (options.permissionApprover !== undefined) throw Error("Configure host tool approval separately with run");
      const connection = await importCredential({ credentialFile: options.credentialFile, roomId: options.room, expectedIdentity: options.expectedIdentity, origin: options.origin, agent: options.agent, env, fetchImpl: io.fetchImpl });
      print(`Imported existing scoped credential for room ${connection.roomId} as member ${connection.memberId}. No key was issued or rotated. Run room-acp run --room ${connection.roomId} to start your adapter.`);
      return 0;
    }
    if (options.command === "import-identity") {
      if (options.origin || options.permissionApprover !== undefined) throw Error("Import uses the existing connection origin; configure host approval separately with run");
      const connection = await importIdentity({ identityFrom: options.identityFrom, roomId: options.room, agent: options.agent, env, fetchImpl: io.fetchImpl });
      print(`Connected existing identity to room ${connection.roomId}. Scoped credential saved privately; run room-acp run --room ${connection.roomId} to start your adapter.`);
      return 0;
    }
    if (options.command === "mcp-config") {
      const connection = loadConnection({ roomId: options.room }, env);
      if (!connection) { print("Not joined. Run: room-acp join <room-url> --mcp " + options.mcp + " (you will be asked for the invite)"); return 1; }
      await mcpConfig(connection, options.mcp, { env, print });
      return 0;
    }
    if (options.command === "join") {
      const joinOnly = io.joinOnly || options.noListen || options.mcp !== undefined;
      if (!joinOnly) {
        let needsLogin = false;
        candidate = await selectAgent(options, { env, onFailure: result => {
          if (/authentication required/i.test(result.error ?? "")) needsLogin = true;
        } });
        if (!candidate) {
          if (needsLogin) print("Your agent needs a login. Sign in using your agent’s own login command, then retry the same invitation; no model prompt was sent.");
          print("No working ACP adapter session found. Your invitation has not been used. Choose your agent with --agent claude or --agent codex, or pass --agent-cmd for an installed ACP adapter. Ordinary Claude/Codex commands need an ACP adapter. Run room-acp doctor first; then retry the same join.");
          return 1;
        }
      }
      const invite = await resolveInvite(options, { env, io });
      const connection = await join({ link: invite.link, displayName: options.name ?? (options.mcp ? null : "Coding agent"), agent: options.agent, permissionApproverId: options.permissionApprover === "none" ? null : options.permissionApprover ?? null, roomId: options.room, origin: invite.origin, env, fetchImpl: io.fetchImpl });
      print(`Joined room ${connection.roomId} as ${connection.displayName}. Credential saved privately; it is never printed.`);
      if (options.mcp !== undefined) { await mcpConfig(connection, options.mcp, { env, print }); return 0; }
      if (joinOnly) return 0;
      options.command = "run";
      options.room = connection.roomId;
    }
    if (options.command === "status") {
      const connection = loadConnection({ roomId: options.room }, env);
      print(connection ? JSON.stringify(publicView(connection), null, 2) : "Not joined. Run: room-acp join <room-url> (you will be asked for the invite)");
      return connection ? 0 : 1;
    }
    if (options.command === "logout") {
      const connection = loadConnection({ roomId: options.room }, env);
      if (!connection) { print("Nothing saved."); return 0; }
      forgetConnection(connection.roomId, env);
      print(`Forgot the credential for room ${connection.roomId}. An owner can also remove the member in the Room.`);
      return 0;
    }
    if (options.command === "run") return await (io.run ?? run)(options, { print, env, fetchImpl: io.fetchImpl, onBridge: io.onBridge, candidate });
  } catch (error) {
    print(`room-acp: ${redact(error.message)}`);
    return 1;
  }
  return 2;
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    // Node resolves entry symlinks and encodes spaces/special characters in URLs.
    // Compare canonical native paths, including npm's bin link and Windows paths.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

if (isDirectEntry()) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`room-acp: ${error.message}`); process.exitCode = 1; });
}
