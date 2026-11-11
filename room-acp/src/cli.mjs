#!/usr/bin/env node
// room-acp: connect a local ACP agent to a Project Room with one invite link.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, USAGE } from "./args.mjs";
import { adapterHints, candidates, probe } from "./agents.mjs";
import { join } from "./join.mjs";
import { importIdentity, importCredential } from "./import-identity.mjs";
import { loadConnection, forgetConnection, publicView } from "./credentials.mjs";
import { redact } from "./redact.mjs";
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
    if (options.command === "join") {
      if (!io.joinOnly) {
        let needsLogin = false;
        candidate = await selectAgent(options, { env, onFailure: result => {
          if (/authentication required/i.test(result.error ?? "")) needsLogin = true;
        } });
        if (!candidate) {
          if (needsLogin) print("Your agent needs a login. Sign in using your agent’s own login command, then retry the same invitation; no model prompt was sent.");
          print("No working ACP adapter session found. Your invitation has not been used. Choose your agent with --agent claude or --agent codex, or pass --agent-cmd for an installed ACP adapter. Ordinary Claude/Codex commands need an ACP adapter. Run room-acp doctor first; then retry the same link.");
          return 1;
        }
      }
      const connection = await join({ link: options.link, displayName: options.name ?? "Coding agent", agent: options.agent, permissionApproverId: options.permissionApprover === "none" ? null : options.permissionApprover ?? null, roomId: options.room, origin: options.origin, env, fetchImpl: io.fetchImpl });
      print(`Joined room ${connection.roomId} as ${connection.displayName}. Credential saved privately; it is never printed.`);
      if (io.joinOnly) return 0;
      options.command = "run";
      options.room = connection.roomId;
    }
    if (options.command === "status") {
      const connection = loadConnection({ roomId: options.room }, env);
      print(connection ? JSON.stringify(publicView(connection), null, 2) : "Not joined. Run: room-acp <invite link>");
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
