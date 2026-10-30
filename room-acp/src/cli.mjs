#!/usr/bin/env node
// room-acp: connect a local ACP agent to a Project Room with one invite link.
import { parseArgs, USAGE } from "./args.mjs";
import { candidates, probe } from "./agents.mjs";

export async function doctor(options, { print = console.log, env = process.env } = {}) {
  const list = candidates({ agent: options.agent, agentCmd: options.agentCmd, env });
  if (!list.length) { print("No ACP agent found. Install one of: claude-agent-acp, codex-acp, goose, gemini, or pass --agent-cmd."); return 1; }
  let ok = 0;
  for (const candidate of list) {
    const result = await probe(candidate, { cwd: options.cwd ?? process.cwd(), env });
    if (result.ok) {
      ok++;
      const caps = result.capabilities;
      print(`ok   ${result.label} (${result.id}): protocol ${caps.protocolVersion}, loadSession ${caps.loadSession ? "yes" : "no"}${caps.authMethods.length ? `, login via ${caps.authMethods.join("/")}` : ""}`);
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
  print(`room-acp: "${options.command}" is not available in this build yet.`);
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/room-acp")) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`room-acp: ${error.message}`); process.exitCode = 1; });
}
