#!/usr/bin/env node
// room-acp: connect a local ACP agent to a Project Room with one invite link.
import { parseArgs, USAGE } from "./args.mjs";
import { adapterHints, candidates, probe } from "./agents.mjs";
import { join } from "./join.mjs";
import { loadConnection, forgetConnection, publicView } from "./credentials.mjs";
import { redact } from "./redact.mjs";
import { run, selectAgent } from "./run.mjs";

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
  if (options.command === "doctor") return doctor(options, io);
  const env = io.env ?? process.env;
  let candidate = null;
  try {
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
      const connection = await join({ link: options.link, displayName: options.name ?? "Coding agent", agent: options.agent, permissionApproverId: options.permissionApprover === "none" ? null : options.permissionApprover ?? null, origin: options.origin, env, fetchImpl: io.fetchImpl });
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

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/room-acp")) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`room-acp: ${error.message}`); process.exitCode = 1; });
}
